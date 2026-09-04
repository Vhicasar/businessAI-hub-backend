import { prisma } from '../../infrastructure/database/prisma';
import { currentOrgId } from '../billing/entitlements';
import { manufacturingAnalytics } from './analytics.service';
import { manufacturingDashboard } from './dashboard.service';
import { bomService } from './bom.service';
import { productionOrdersService } from './production-orders.service';

/**
 * What the assistant can answer about manufacturing (§25), and what it may
 * propose (§26).
 *
 * The shape of this matters more than the list. Every question is resolved by
 * running a real query and doing the arithmetic here; the language model is
 * given the finished figures and asked only to put them into a sentence. A
 * model handed a list of movements and asked how much sugar is left will
 * sometimes answer confidently and wrongly, and a wrong stock figure is
 * indistinguishable from a right one to the person reading it.
 *
 * Nothing here writes. Actions are *proposals* — a label, and the endpoint the
 * client should call once a person has agreed. §26 is unambiguous that
 * purchase orders, stock movements, production completion, QC approval and
 * quarantine release never happen without that confirmation, and the simplest
 * way to guarantee it is for this service to have no ability to do them.
 */

export interface ProposedAction {
  /** What to show on the button. */
  label: string;
  /** What it will do, in plain words, before anybody presses it. */
  description: string;
  method: 'POST';
  /** The existing endpoint. The client calls it; this service never does. */
  endpoint: string;
  body?: Record<string, unknown>;
  /** Always true. Present so a client cannot treat any action as automatic. */
  requiresConfirmation: true;
}

export interface ManufacturingAnswer {
  intent: string;
  /** The figures, straight from the database. Rendered, never recomputed. */
  data: unknown;
  /** A sentence built from `data` without the model touching the numbers. */
  summary: string;
  actions: ProposedAction[];
  /** Where to look at this properly. */
  link?: { label: string; path: string };
}

type Resolver = (prompt: string) => Promise<ManufacturingAnswer>;

interface Intent {
  id: string;
  /** Words that mean this question. Matched case-insensitively. */
  match: RegExp;
  resolve: Resolver;
}

const money = (n: number, currency: string) => `${currency} ${n.toLocaleString()}`;
/**
 * A quantity with its unit, pluralised so the sentence reads.
 *
 * "5,000 case of Cola" is the sort of thing that makes an otherwise correct
 * answer look machine-generated.
 */
const MEASUREMENT_SYMBOLS = new Set([
  'kg', 'g', 'mg', 't', 'l', 'ml', 'cl', 'm', 'cm', 'mm', 'lb', 'oz', 'gal', 'pt',
]);

const qty = (n: number, unit?: string | null) => {
  if (!unit) return n.toLocaleString();
  // "5,000 cases" reads; "3,282.5 kgs" does not. Measurement symbols are
  // already plural-neutral, and a business's own words ("case", "carton") are
  // the ones that need the s.
  const plural =
    n === 1 || /s$/i.test(unit) || MEASUREMENT_SYMBOLS.has(unit.toLowerCase())
      ? unit
      : `${unit}s`;
  return `${n.toLocaleString()} ${plural}`;
};

const INTENTS: Intent[] = [
  // ── "What raw materials are below reorder level?" ────────────────────────
  {
    id: 'materials_below_reorder',
    match: /\b(below|under|low)\b.*\b(reorder|minimum|safety|stock level)\b|\blow stock\b|\brunning low\b/i,
    async resolve() {
      const view = await manufacturingDashboard.overview();
      const low = view.materials.lowStock;
      return {
        intent: 'materials_below_reorder',
        data: low,
        summary: low.length === 0
          ? 'Nothing is at or below its stock floor.'
          : `${low.length} material${low.length === 1 ? ' is' : 's are'} at or below the level you set: ` +
            low.slice(0, 5).map((m) => `${m.name} (${qty(m.available, m.unit)} against a floor of ${qty(m.floor, m.unit)})`).join(', ') + '.',
        actions: [],
        link: { label: 'Open manufacturing dashboard', path: '/manufacturing' },
      };
    },
  },

  // ── "How much sugar do we need to make 50,000 cases of X?" ───────────────
  {
    id: 'requirement_for_quantity',
    match: /\bhow much\b.*\b(to (make|produce)|for)\b|\bwhat (do we|will we) need\b.*\b(make|produce)\b/i,
    async resolve(prompt) {
      const quantity = firstNumber(prompt);
      const product = await matchProduct(prompt);
      if (!product || !quantity) {
        return {
          intent: 'requirement_for_quantity',
          data: null,
          summary:
            'Name the product and the quantity — for example "how much do we need to produce 10,000 cases of Cola 50cl".',
          actions: [],
        };
      }
      const bom = await bomService.activeFor(product.id);
      if (!bom) {
        return {
          intent: 'requirement_for_quantity',
          data: { product },
          summary: `${product.name} has no active bill of materials, so what it needs is not recorded anywhere yet.`,
          actions: [],
          link: { label: 'Open bills of material', path: '/manufacturing/boms' },
        };
      }
      const requirements = await bomService.requirementsFor(bom.id, quantity);
      return {
        intent: 'requirement_for_quantity',
        data: requirements,
        summary:
          `Making ${qty(quantity, product.unit)} of ${product.name} needs ` +
          requirements.items
            .map((i) => `${qty(i.requiredQuantity, i.unit)} of ${i.name}`)
            .join(', ') +
          ` (recipe ${requirements.bomNumber} v${requirements.version}, wastage included).`,
        actions: [],
        link: { label: 'Open bills of material', path: '/manufacturing/boms' },
      };
    },
  },

  // ── "Do we have enough to complete planned production?" ──────────────────
  {
    id: 'can_we_produce',
    match: /\b(enough|sufficient)\b.*\b(material|stock)\b|\bcan we (complete|produce|make)\b|\bwill we run out\b/i,
    async resolve() {
      const orders = await prisma.productionOrder.findMany({
        where: {
          organizationId: currentOrgId(),
          deletedAt: null,
          status: { in: ['DRAFT', 'APPROVED', 'READY', 'IN_PROGRESS'] },
        },
        select: { id: true, orderNumber: true },
        take: 25,
      });

      const checks = await Promise.all(
        orders.map(async (order) => {
          const result = await productionOrdersService.materialCheck(order.id);
          return {
            productionOrderId: order.id,
            orderNumber: order.orderNumber,
            product: result.product.name,
            canProceed: result.canProceed,
            shortages: result.items.filter((i) => i.shortfallQuantity > 0),
          };
        }),
      );
      const blocked = checks.filter((c) => !c.canProceed);

      return {
        intent: 'can_we_produce',
        data: checks,
        summary: orders.length === 0
          ? 'There are no open production orders to check.'
          : blocked.length === 0
            ? `All ${orders.length} open production order${orders.length === 1 ? ' has' : 's have'} the materials they need.`
            : `${blocked.length} of ${orders.length} open order${orders.length === 1 ? '' : 's'} cannot proceed: ` +
              blocked
                .slice(0, 3)
                .map((b) => `${b.orderNumber} is short of ${b.shortages.map((s) => s.name).join(', ')}`)
                .join('; ') + '.',
        // Proposed, never taken. The person decides whether to buy or move.
        actions: blocked.slice(0, 3).map((b) => ({
          label: `Review shortages on ${b.orderNumber}`,
          description:
            `Show what ${b.orderNumber} is short of and what would fix it. Nothing is ordered or moved until you choose.`,
          method: 'POST' as const,
          endpoint: `/api/v1/manufacturing/orders/${b.productionOrderId}/procurement-recommendations`,
          requiresConfirmation: true as const,
        })),
        link: { label: 'Open production orders', path: '/manufacturing/orders' },
      };
    },
  },

  // ── "Which purchase orders have outstanding quantities / are late?" ──────
  {
    id: 'outstanding_purchase_orders',
    match: /\b(outstanding|open|pending|overdue|late|delayed)\b.*\b(purchase order|po|delivery|deliveries|supplier)\b/i,
    async resolve() {
      const procurement = await manufacturingAnalytics.procurement();
      const late = procurement.bySupplier.filter((s) => s.overdue > 0);
      return {
        intent: 'outstanding_purchase_orders',
        data: procurement,
        summary:
          `${procurement.outstandingOrders} purchase order${procurement.outstandingOrders === 1 ? ' is' : 's are'} still open` +
          (procurement.overdueOrders > 0
            ? `, of which ${procurement.overdueOrders} ${procurement.overdueOrders === 1 ? 'is' : 'are'} past the promised date` +
              (late.length > 0 ? ` — ${late.map((s) => s.name).join(', ')}` : '')
            : ', and none is overdue') + '.',
        actions: [],
        link: { label: 'Open purchase orders', path: '/purchase-orders' },
      };
    },
  },

  // ── "Which production orders are delayed?" ───────────────────────────────
  {
    id: 'delayed_production',
    match: /\b(production (order|run)s?)\b.*\b(delay|late|behind|overdue)\b|\bbehind schedule\b/i,
    async resolve() {
      const now = new Date();
      const late = await prisma.productionOrder.findMany({
        where: {
          organizationId: currentOrgId(),
          deletedAt: null,
          status: { in: ['APPROVED', 'READY', 'IN_PROGRESS', 'PAUSED'] },
          expectedCompletionDate: { lt: now },
        },
        select: {
          id: true, orderNumber: true, status: true, expectedCompletionDate: true,
          plannedQuantity: true, actualQuantity: true,
          product: { select: { name: true, unit: true } },
        },
        orderBy: { expectedCompletionDate: 'asc' },
        take: 20,
      });
      return {
        intent: 'delayed_production',
        data: late.map((o) => ({
          orderNumber: o.orderNumber,
          product: o.product.name,
          status: o.status,
          dueAt: o.expectedCompletionDate,
          daysLate: o.expectedCompletionDate
            ? Math.ceil((now.getTime() - o.expectedCompletionDate.getTime()) / 86_400_000)
            : null,
          plannedQuantity: Number(o.plannedQuantity),
          producedSoFar: Number(o.actualQuantity),
        })),
        summary: late.length === 0
          ? 'No production order is past its expected completion date.'
          : `${late.length} production order${late.length === 1 ? ' is' : 's are'} past due: ` +
            late.slice(0, 5).map((o) => `${o.orderNumber} (${o.product.name})`).join(', ') + '.',
        actions: [],
        link: { label: 'Open production orders', path: '/manufacturing/orders' },
      };
    },
  },

  // ── "What was our production efficiency this month?" ─────────────────────
  {
    id: 'production_efficiency',
    match: /\b(efficiency|yield|output|productivity|how much did we (make|produce))\b/i,
    async resolve() {
      const production = await manufacturingAnalytics.production();
      return {
        intent: 'production_efficiency',
        data: production,
        summary: production.runs === 0
          ? 'No production runs were completed in this period.'
          : `Across ${production.runs} completed run${production.runs === 1 ? '' : 's'}, ` +
            `${production.goodQuantity.toLocaleString()} good units were made against ` +
            `${production.plannedQuantity.toLocaleString()} planned — ` +
            `${production.yieldPercent ?? 0}% yield, with a ${production.rejectionRatePercent ?? 0}% rejection rate.`,
        actions: [],
        link: { label: 'Open manufacturing analytics', path: '/manufacturing/analytics' },
      };
    },
  },

  // ── "Which product costs most / why did cost increase?" ──────────────────
  {
    id: 'production_cost',
    match: /\b(cost|expensive|cheaper|dearer|spend)\b.*\b(product|production|run|make)\b|\bwhy did (the )?cost\b/i,
    async resolve() {
      const organizationId = currentOrgId();
      const org = await prisma.organization.findUniqueOrThrow({
        where: { id: organizationId },
        select: { currency: true },
      });
      const costs = await prisma.productionCost.findMany({
        where: { organizationId },
        orderBy: { calculatedAt: 'desc' },
        take: 50,
        select: {
          totalCost: true, estimatedCost: true, unitCost: true, calculatedAt: true,
          productionOrder: {
            select: { orderNumber: true, product: { select: { id: true, name: true } } },
          },
        },
      });
      if (costs.length === 0) {
        return {
          intent: 'production_cost',
          data: [],
          summary: 'No production run has been costed yet, so there is nothing to compare.',
          actions: [],
        };
      }

      // Grouped and averaged here, not by the model.
      const byProduct = new Map<string, { name: string; runs: number; total: number; units: number }>();
      for (const cost of costs) {
        const key = cost.productionOrder.product.id;
        const entry = byProduct.get(key) ?? {
          name: cost.productionOrder.product.name, runs: 0, total: 0, units: 0,
        };
        entry.runs += 1;
        entry.total += Number(cost.totalCost);
        entry.units += Number(cost.unitCost ?? 0);
        byProduct.set(key, entry);
      }
      const ranked = [...byProduct.entries()]
        .map(([id, e]) => ({
          productId: id,
          name: e.name,
          runs: e.runs,
          totalCost: Math.round(e.total * 100) / 100,
          averageUnitCost: e.runs > 0 ? Math.round((e.units / e.runs) * 10000) / 10000 : null,
        }))
        .sort((a, b) => (b.averageUnitCost ?? 0) - (a.averageUnitCost ?? 0));

      const overspend = costs
        .filter((c) => c.estimatedCost && Number(c.totalCost) > Number(c.estimatedCost))
        .slice(0, 5)
        .map((c) => ({
          orderNumber: c.productionOrder.orderNumber,
          over: Math.round((Number(c.totalCost) - Number(c.estimatedCost ?? 0)) * 100) / 100,
        }));

      return {
        intent: 'production_cost',
        data: { byProduct: ranked, overspend, currency: org.currency },
        summary:
          `${ranked[0]!.name} has the highest unit cost at ` +
          `${money(ranked[0]!.averageUnitCost ?? 0, org.currency)} per unit across ${ranked[0]!.runs} run${ranked[0]!.runs === 1 ? '' : 's'}.` +
          (overspend.length > 0
            ? ` ${overspend.length} run${overspend.length === 1 ? '' : 's'} came in above estimate, the largest by ${money(overspend[0]!.over, org.currency)}.`
            : ' No run came in above its estimate.'),
        actions: [],
        link: { label: 'Open manufacturing analytics', path: '/manufacturing/analytics' },
      };
    },
  },

  // ── "Which materials have the highest consumption variance?" ─────────────
  {
    id: 'consumption_variance',
    match: /\b(variance|wastage|waste|overconsum|using more)\b/i,
    async resolve() {
      const rows = await prisma.productionVariance.findMany({
        where: { organizationId: currentOrgId() },
        orderBy: { variancePercent: 'desc' },
        take: 20,
      });
      const variants = await prisma.productVariant.findMany({
        where: { id: { in: rows.map((r) => r.variantId) } },
        select: { id: true, sku: true, product: { select: { name: true, unit: true } } },
      });
      const ranked = rows.map((r) => {
        const v = variants.find((x) => x.id === r.variantId);
        return {
          sku: v?.sku ?? null,
          name: v?.product.name ?? 'Unknown',
          unit: v?.product.unit ?? null,
          planned: Number(r.plannedQuantity),
          actual: Number(r.actualQuantity),
          varianceQuantity: Number(r.varianceQuantity),
          variancePercent: r.variancePercent === null ? null : Number(r.variancePercent),
          exceedsThreshold: r.exceedsThreshold,
        };
      });
      const over = ranked.filter((r) => r.exceedsThreshold);
      return {
        intent: 'consumption_variance',
        data: ranked,
        summary: ranked.length === 0
          ? 'No run has been costed yet, so there is no variance to report.'
          : over.length === 0
            ? 'No material is being consumed beyond your tolerance.'
            : `${over.length} material${over.length === 1 ? ' is' : 's are'} over tolerance, worst first: ` +
              over.slice(0, 5).map((r) => `${r.name} (${r.variancePercent}% above the recipe)`).join(', ') + '.',
        actions: [],
        link: { label: 'Open manufacturing analytics', path: '/manufacturing/analytics' },
      };
    },
  },

  // ── "Show me failed / quarantined batches" ───────────────────────────────
  {
    id: 'quality_batches',
    match: /\b(qc|quality|failed|quarantin|reject)\b.*\b(batch|batches|inspection|lot)\b|\bfailed qc\b|\bquarantined\b/i,
    async resolve() {
      const quality = await manufacturingAnalytics.quality();
      const held = await prisma.batch.findMany({
        where: { organizationId: currentOrgId(), isQuarantined: true },
        select: {
          id: true, batchNumber: true, quantityAvailable: true, qcStatus: true,
          variant: { select: { sku: true, product: { select: { name: true } } } },
        },
        take: 20,
      });
      return {
        intent: 'quality_batches',
        data: { summary: quality, quarantined: held },
        summary:
          `${quality.inspections.failed} inspection${quality.inspections.failed === 1 ? '' : 's'} failed and ` +
          `${quality.inspections.passed} passed in this period` +
          (quality.inspections.failureRatePercent !== null
            ? ` (a ${quality.inspections.failureRatePercent}% failure rate)` : '') +
          `. ${held.length} batch${held.length === 1 ? ' is' : 'es are'} currently held` +
          (held.length > 0 ? `: ${held.slice(0, 5).map((b) => b.batchNumber).join(', ')}` : '') + '.',
        actions: [],
        link: { label: 'Open quarantine', path: '/manufacturing/quarantine' },
      };
    },
  },

  // ── "Which machine has had the most downtime?" ───────────────────────────
  {
    id: 'machine_downtime',
    match: /\b(downtime|breakdown|machine|equipment|maintenance)\b/i,
    async resolve() {
      const maintenance = await manufacturingAnalytics.maintenance();
      const worst = maintenance.byEquipment[0];
      const parts = await prisma.maintenancePart.findMany({
        where: { organizationId: currentOrgId() },
        orderBy: { issuedAt: 'desc' },
        take: 10,
        select: {
          quantity: true, issuedAt: true,
          variant: { select: { sku: true, product: { select: { name: true } } } },
          workOrder: { select: { workOrderNumber: true } },
        },
      });
      return {
        intent: 'machine_downtime',
        data: { maintenance, recentParts: parts },
        summary: !worst
          ? 'No maintenance has been recorded in this period.'
          : `${worst.name} has the most downtime — ${worst.downtimeHours} hours across ${worst.jobs} job${worst.jobs === 1 ? '' : 's'}, ` +
            `${worst.availabilityPercent}% available. ` +
            `${maintenance.breakdowns} unplanned stoppage${maintenance.breakdowns === 1 ? '' : 's'} and ` +
            `${maintenance.preventive} planned service${maintenance.preventive === 1 ? '' : 's'} in total.`,
        actions: [],
        link: { label: 'Open equipment', path: '/manufacturing/equipment' },
      };
    },
  },

  // ── "Which warehouse holds the most raw-material value?" ─────────────────
  {
    id: 'inventory_value',
    match: /\b(inventory|stock)\b.*\b(value|worth|tied up)\b|\bhow much (stock|inventory) (is|do we have)\b/i,
    async resolve() {
      const org = await prisma.organization.findUniqueOrThrow({
        where: { id: currentOrgId() },
        select: { currency: true },
      });
      const value = await manufacturingDashboard.inventoryValue();
      const top = value.byWarehouse[0];
      return {
        intent: 'inventory_value',
        data: value,
        summary: !top
          ? 'There is no stock on hand to value.'
          : `Stock is worth ${money(value.totalValue, org.currency)} in total. ` +
            `${top.name} holds the most at ${money(top.value, org.currency)}` +
            (top.heldValue > 0 ? `, of which ${money(top.heldValue, org.currency)} is held and not sellable` : '') + '.',
        actions: [],
        link: { label: 'Open manufacturing dashboard', path: '/manufacturing' },
      };
    },
  },
];

export const manufacturingAi = {
  /** The questions this module can answer, for a help panel or a test. */
  intents: INTENTS.map((i) => i.id),

  /**
   * Answer a manufacturing question from real data.
   *
   * Returns null when the question is not one of these, so the caller can fall
   * through to the general assistant rather than this guessing.
   */
  async answer(prompt: string): Promise<ManufacturingAnswer | null> {
    const intent = INTENTS.find((i) => i.match.test(prompt));
    if (!intent) return null;
    return intent.resolve(prompt);
  },

  /**
   * What the assistant may propose for a production order.
   *
   * Every one names an existing endpoint and is marked as needing
   * confirmation. Nothing is executed here — §26's guarantee is structural
   * rather than a rule somebody has to follow.
   */
  async actionsForProductionOrder(productionOrderId: string): Promise<ProposedAction[]> {
    const order = await prisma.productionOrder.findFirst({
      where: { id: productionOrderId, deletedAt: null },
      select: { id: true, orderNumber: true, status: true, warehouseId: true },
    });
    if (!order) return [];

    const actions: ProposedAction[] = [];
    const check = await productionOrdersService.materialCheck(productionOrderId);

    if (!check.canProceed) {
      actions.push({
        label: 'Create purchase requisition',
        description:
          `Raise draft purchase orders for what ${order.orderNumber} is short of. ` +
          'They are drafts — nothing reaches a supplier until you send them.',
        method: 'POST',
        endpoint: `/api/v1/manufacturing/orders/${order.id}/create-purchase-drafts`,
        body: {},
        requiresConfirmation: true,
      });
      if (order.warehouseId) {
        actions.push({
          label: 'Request materials from another warehouse',
          description:
            `Raise an internal requisition for ${order.orderNumber}'s shortfall. ` +
            'The supplying store still has to approve and dispatch it.',
          method: 'POST',
          endpoint: `/api/v1/manufacturing/orders/${order.id}/request-materials`,
          requiresConfirmation: true,
        });
      }
    }
    return actions;
  },
};

/** The first quantity in a question — "produce 50,000 cases" → 50000. */
function firstNumber(prompt: string): number | null {
  const match = prompt.replace(/,/g, '').match(/\b(\d+(?:\.\d+)?)\b/);
  return match ? Number(match[1]) : null;
}

/**
 * The product a question is about.
 *
 * Matched against the business's own names rather than parsed out of the
 * sentence, so "Cola 50cl" resolves and an invented product does not.
 */
async function matchProduct(prompt: string) {
  const products = await prisma.product.findMany({
    where: { organizationId: currentOrgId(), deletedAt: null, manufacturingEnabled: true },
    select: { id: true, name: true, unit: true },
    take: 300,
  });
  const lower = prompt.toLowerCase();
  return (
    products.find((p) => lower.includes(p.name.toLowerCase())) ??
    // Fall back to the longest name whose words all appear.
    products
      .filter((p) => p.name.toLowerCase().split(/\s+/).every((w) => w.length > 2 && lower.includes(w)))
      .sort((a, b) => b.name.length - a.name.length)[0] ??
    null
  );
}
