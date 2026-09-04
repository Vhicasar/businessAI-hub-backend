import { randomBytes } from 'crypto';
import { prisma } from '../../infrastructure/database/prisma';
import { NotFoundError, ValidationError } from '../../shared/errors';
import { callerHasPermission } from '../roles/role-permissions';

/**
 * Scannable documents: one place that turns any Vhicasar QR code into the
 * document it names, plus the actions the person holding the phone may take.
 *
 * Purchase orders and internal requisitions already carried scan tokens with
 * their own dedicated receiving screens; this generalises the same convention
 * to production orders and maintenance work orders, and gives all four a
 * single resolver so a new scannable document is a case statement rather than
 * another screen.
 *
 * Two properties matter more than the convenience:
 *
 *   The code identifies, it does not authorise. Scanning tells the server
 *   which document is in front of you; whether you may approve it comes from
 *   your own role, exactly as in the web app. A code photographed off someone
 *   else's clipboard grants nothing, and `actions[].allowed` is a hint for
 *   the UI — every endpoint behind it re-checks the same permission.
 *
 *   The token is tenant-scoped by the query itself. Lookups go through the
 *   tenant-scoped client, so a token from another business simply does not
 *   resolve.
 */

export type DocumentKind = 'mo' | 'wo' | 'po' | 'ir';

const KIND_LABEL: Record<DocumentKind, string> = {
  mo: 'Production order',
  wo: 'Maintenance work order',
  po: 'Purchase order',
  ir: 'Internal requisition',
};

/** An action the scanner may be offered once the document is resolved. */
export interface DocumentAction {
  key: string;
  label: string;
  /** Permission required — the client hides what the holder cannot do. */
  permission: string;
  /** Whether this caller actually holds it. */
  allowed: boolean;
  endpoint: string;
  method: 'POST' | 'PATCH';
  body?: Record<string, unknown>;
  /** Set when the action suits the document but not its current status. */
  blockedReason?: string;
}

export interface ResolvedDocument {
  kind: DocumentKind;
  kindLabel: string;
  id: string;
  /** What the operator reads to confirm they scanned the right thing. */
  title: string;
  subtitle: string | null;
  status: string;
  actions: DocumentAction[];
}

/** The string encoded into the QR image on a printed document. */
export function scanPayload(kind: DocumentKind, token: string): string {
  return `vhicasar://${kind}/${token}`;
}

export function newScanToken(): string {
  return randomBytes(24).toString('base64url');
}

/** Accepts a full `vhicasar://kind/token` payload or a bare token with a kind. */
function parse(raw: string): { kind: DocumentKind; token: string } {
  const match = /^vhicasar:\/\/(mo|wo|po|ir)\/(.+)$/i.exec(raw.trim());
  if (!match) {
    throw new ValidationError('That does not look like a Vhicasar document code.');
  }
  return { kind: match[1]!.toLowerCase() as DocumentKind, token: match[2]! };
}

/**
 * Marks each action with whether this caller may take it.
 *
 * Presentation only — the endpoint behind every action checks the same
 * permission again, so a client that ignores this list gets nowhere.
 */
async function decorate(actions: Omit<DocumentAction, 'allowed'>[]): Promise<DocumentAction[]> {
  return Promise.all(
    actions.map(async (a) => ({ ...a, allowed: await callerHasPermission(a.permission) }))
  );
}

const onlyAt = (status: string, allowed: string[], reason: string) =>
  allowed.includes(status) ? undefined : reason;

export const documentQrService = {
  /** Turn a scanned code into a document plus this caller's permitted actions. */
  async resolve(raw: string): Promise<ResolvedDocument> {
    const { kind, token } = parse(raw);

    switch (kind) {
      case 'mo': {
        const order = await prisma.productionOrder.findFirst({
          where: { scanToken: token, deletedAt: null },
          select: {
            id: true, orderNumber: true, status: true, plannedQuantity: true,
            product: { select: { name: true, unit: true } },
            productionLine: { select: { name: true } },
          },
        });
        if (!order) throw new NotFoundError('Production order');
        const endpoint = `/manufacturing/orders/${order.id}/status`;
        return {
          kind, kindLabel: KIND_LABEL[kind], id: order.id,
          title: order.orderNumber,
          subtitle: [
            order.product?.name,
            `${order.plannedQuantity}${order.product?.unit ? ` ${order.product.unit}` : ''}`,
            order.productionLine?.name,
          ].filter(Boolean).join(' · ') || null,
          status: order.status,
          actions: await decorate([
            {
              key: 'approve', label: 'Approve', permission: 'production.approve',
              endpoint, method: 'POST', body: { status: 'APPROVED' },
              blockedReason: onlyAt(order.status, ['DRAFT'], `Already ${order.status.toLowerCase()}`),
            },
            {
              key: 'start', label: 'Start run', permission: 'production.start',
              endpoint, method: 'POST', body: { status: 'IN_PROGRESS' },
              blockedReason: onlyAt(order.status, ['APPROVED', 'READY', 'PAUSED'],
                `A ${order.status.toLowerCase()} order cannot be started`),
            },
            {
              key: 'pause', label: 'Pause', permission: 'production.start',
              endpoint, method: 'POST', body: { status: 'PAUSED' },
              blockedReason: onlyAt(order.status, ['IN_PROGRESS'], 'Only a running order can be paused'),
            },
            {
              key: 'complete', label: 'Complete', permission: 'production.complete',
              endpoint, method: 'POST', body: { status: 'COMPLETED' },
              blockedReason: onlyAt(order.status, ['IN_PROGRESS'], 'Only a running order can be completed'),
            },
          ]),
        };
      }

      case 'wo': {
        const wo = await prisma.maintenanceWorkOrder.findFirst({
          where: { scanToken: token, deletedAt: null },
          select: {
            id: true, workOrderNumber: true, status: true, priority: true,
            equipment: { select: { name: true, code: true } },
          },
        });
        if (!wo) throw new NotFoundError('Work order');
        return {
          kind, kindLabel: KIND_LABEL[kind], id: wo.id,
          title: wo.workOrderNumber,
          subtitle: wo.equipment ? `${wo.equipment.name} (${wo.equipment.code})` : null,
          status: wo.status,
          actions: await decorate([
            {
              key: 'start', label: 'Start work', permission: 'maintenance.update',
              endpoint: `/manufacturing/work-orders/${wo.id}/start`, method: 'POST',
              blockedReason: onlyAt(wo.status, ['OPEN', 'ASSIGNED'], `Already ${wo.status.toLowerCase()}`),
            },
          ]),
        };
      }

      case 'po': {
        const po = await prisma.purchaseOrder.findFirst({
          where: { scanToken: token },
          select: { id: true, number: true, status: true, supplier: { select: { name: true } } },
        });
        if (!po) throw new NotFoundError('Purchase order');
        return {
          kind, kindLabel: KIND_LABEL[kind], id: po.id,
          title: po.number,
          subtitle: po.supplier?.name ?? null,
          status: po.status,
          actions: await decorate([
            {
              key: 'receive', label: 'Receive stock', permission: 'purchasing.receive',
              endpoint: `/purchase-orders/${po.id}/receiving-view`, method: 'POST',
              blockedReason: onlyAt(po.status, ['ORDERED', 'PARTIALLY_RECEIVED'],
                `A ${po.status.toLowerCase()} order cannot be received`),
            },
          ]),
        };
      }

      case 'ir': {
        const req = await prisma.internalRequisition.findFirst({
          where: { scanToken: token },
          select: {
            id: true, number: true, status: true,
            fromWarehouse: { select: { name: true } },
            toWarehouse: { select: { name: true } },
          },
        });
        if (!req) throw new NotFoundError('Requisition');
        return {
          kind, kindLabel: KIND_LABEL[kind], id: req.id,
          title: req.number,
          subtitle: `${req.fromWarehouse?.name ?? '—'} → ${req.toWarehouse?.name ?? '—'}`,
          status: req.status,
          actions: await decorate([
            {
              key: 'approve', label: 'Approve', permission: 'inventory.requisition_approve',
              endpoint: `/requisitions/${req.id}/approve`, method: 'POST',
              blockedReason: onlyAt(req.status, ['SUBMITTED'], `Already ${req.status.toLowerCase()}`),
            },
          ]),
        };
      }
    }
  },

  /**
   * The scan payload for a production order, minting the token on first use.
   *
   * Lazy rather than at creation so orders raised before this shipped get a
   * code the first time someone prints one.
   */
  async productionOrderPayload(id: string): Promise<{ payload: string; orderNumber: string }> {
    const order = await prisma.productionOrder.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, orderNumber: true, scanToken: true },
    });
    if (!order) throw new NotFoundError('Production order');
    let token = order.scanToken;
    if (!token) {
      token = newScanToken();
      await prisma.productionOrder.update({ where: { id }, data: { scanToken: token } });
    }
    return { payload: scanPayload('mo', token), orderNumber: order.orderNumber };
  },

  /** The scan payload for a maintenance work order, minting on first use. */
  async workOrderPayload(id: string): Promise<{ payload: string; workOrderNumber: string }> {
    const wo = await prisma.maintenanceWorkOrder.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, workOrderNumber: true, scanToken: true },
    });
    if (!wo) throw new NotFoundError('Work order');
    let token = wo.scanToken;
    if (!token) {
      token = newScanToken();
      await prisma.maintenanceWorkOrder.update({ where: { id }, data: { scanToken: token } });
    }
    return { payload: scanPayload('wo', token), workOrderNumber: wo.workOrderNumber };
  },
};
