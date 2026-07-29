import { prisma } from '../../infrastructure/database/prisma';
import { callerHasPermission } from '../roles/role-permissions';

/**
 * Global search (spec #15): a permission-gated fan-out across the CRM,
 * commerce, real-estate, support and people modules. Each entity type is only
 * queried when the caller holds the matching read permission, so results never
 * leak data a user couldn't otherwise open. Matching is case-insensitive
 * substring over each type's most identifying fields (name/number/title/email);
 * every permitted type is queried in parallel and capped, keeping it fast enough
 * for as-you-type use.
 */

export type SearchEntityType =
  | 'customer' | 'lead' | 'deal' | 'company' | 'order' | 'product' | 'invoice'
  | 'payment' | 'property' | 'ticket' | 'task' | 'note' | 'employee' | 'file' | 'meeting';

export interface SearchHit {
  type: SearchEntityType;
  id: string;
  title: string;
  subtitle?: string | null;
}

export interface SearchGroup {
  type: SearchEntityType;
  label: string;
  hits: SearchHit[];
}

const LABELS: Record<SearchEntityType, string> = {
  customer: 'Customers', lead: 'Leads', deal: 'Deals', company: 'Companies',
  order: 'Orders', product: 'Products', invoice: 'Invoices', payment: 'Payments',
  property: 'Properties', ticket: 'Tickets', task: 'Tasks', note: 'Notes',
  employee: 'Employees', file: 'Files', meeting: 'Appointments',
};

/** One searcher per entity type: the permission gate + the query. */
interface Searcher {
  type: SearchEntityType;
  perms: string[]; // ANY-of
  run(q: string, take: number): Promise<SearchHit[]>;
}

const ci = (q: string) => ({ contains: q, mode: 'insensitive' as const });
const name = (first: string, last?: string | null) => `${first} ${last ?? ''}`.trim();

const SEARCHERS: Searcher[] = [
  {
    type: 'customer', perms: ['customers.read'],
    async run(q, take) {
      const rows = await prisma.customer.findMany({
        where: { deletedAt: null, OR: [{ firstName: ci(q) }, { lastName: ci(q) }, { email: ci(q) }, { phone: ci(q) }] },
        select: { id: true, firstName: true, lastName: true, email: true }, take, orderBy: { updatedAt: 'desc' },
      });
      return rows.map((r) => ({ type: 'customer' as const, id: r.id, title: name(r.firstName, r.lastName), subtitle: r.email }));
    },
  },
  {
    type: 'lead', perms: ['crm.read'],
    async run(q, take) {
      const rows = await prisma.lead.findMany({
        where: { deletedAt: null, OR: [{ firstName: ci(q) }, { lastName: ci(q) }, { email: ci(q) }, { phone: ci(q) }] },
        select: { id: true, firstName: true, lastName: true, status: true }, take, orderBy: { updatedAt: 'desc' },
      });
      return rows.map((r) => ({ type: 'lead' as const, id: r.id, title: name(r.firstName, r.lastName), subtitle: r.status }));
    },
  },
  {
    type: 'deal', perms: ['crm.read'],
    async run(q, take) {
      const rows = await prisma.deal.findMany({
        where: { deletedAt: null, title: ci(q) },
        select: { id: true, title: true, status: true, value: true, currency: true }, take, orderBy: { updatedAt: 'desc' },
      });
      return rows.map((r) => ({ type: 'deal' as const, id: r.id, title: r.title, subtitle: `${r.currency} ${Number(r.value).toLocaleString()} · ${r.status}` }));
    },
  },
  {
    type: 'company', perms: ['companies.read'],
    async run(q, take) {
      const rows = await prisma.company.findMany({
        where: { deletedAt: null, OR: [{ name: ci(q) }, { email: ci(q) }] },
        select: { id: true, name: true, industry: true }, take, orderBy: { updatedAt: 'desc' },
      });
      return rows.map((r) => ({ type: 'company' as const, id: r.id, title: r.name, subtitle: r.industry }));
    },
  },
  {
    type: 'order', perms: ['orders.read'],
    async run(q, take) {
      const rows = await prisma.order.findMany({
        where: { OR: [{ number: ci(q) }, { customer: { OR: [{ firstName: ci(q) }, { lastName: ci(q) }] } }] },
        select: { id: true, number: true, status: true, total: true, currency: true }, take, orderBy: { createdAt: 'desc' },
      });
      return rows.map((r) => ({ type: 'order' as const, id: r.id, title: `Order ${r.number}`, subtitle: `${r.currency} ${Number(r.total).toLocaleString()} · ${r.status}` }));
    },
  },
  {
    type: 'product', perms: ['catalog.read'],
    async run(q, take) {
      const rows = await prisma.product.findMany({
        where: { deletedAt: null, OR: [{ name: ci(q) }, { variants: { some: { sku: ci(q) } } }] },
        select: { id: true, name: true, status: true }, take, orderBy: { updatedAt: 'desc' },
      });
      return rows.map((r) => ({ type: 'product' as const, id: r.id, title: r.name, subtitle: r.status }));
    },
  },
  {
    type: 'invoice', perms: ['invoices.read'],
    async run(q, take) {
      const rows = await prisma.invoice.findMany({
        where: { OR: [{ number: ci(q) }, { customer: { OR: [{ firstName: ci(q) }, { lastName: ci(q) }] } }] },
        select: { id: true, number: true, status: true, total: true, currency: true }, take, orderBy: { createdAt: 'desc' },
      });
      return rows.map((r) => ({ type: 'invoice' as const, id: r.id, title: `Invoice ${r.number}`, subtitle: `${r.currency} ${Number(r.total).toLocaleString()} · ${r.status}` }));
    },
  },
  {
    type: 'payment', perms: ['payments.read'],
    async run(q, take) {
      const rows = await prisma.payment.findMany({
        where: { OR: [{ providerRef: ci(q) }, { provider: ci(q) }] },
        select: { id: true, providerRef: true, amount: true, currency: true, orderId: true }, take, orderBy: { createdAt: 'desc' },
      });
      return rows.map((r) => ({ type: 'payment' as const, id: r.orderId ?? r.id, title: `Payment ${r.providerRef ?? ''}`.trim(), subtitle: `${r.currency} ${Number(r.amount).toLocaleString()}` }));
    },
  },
  {
    type: 'property', perms: ['properties.read'],
    async run(q, take) {
      const rows = await prisma.property.findMany({
        where: { deletedAt: null, OR: [{ reference: ci(q) }, { title: ci(q) }] },
        select: { id: true, reference: true, title: true }, take, orderBy: { updatedAt: 'desc' },
      });
      return rows.map((r) => ({ type: 'property' as const, id: r.id, title: r.title, subtitle: r.reference }));
    },
  },
  {
    type: 'ticket', perms: ['support.read'],
    async run(q, take) {
      const rows = await prisma.ticket.findMany({
        where: { OR: [{ number: ci(q) }, { subject: ci(q) }] },
        select: { id: true, number: true, subject: true, status: true }, take, orderBy: { updatedAt: 'desc' },
      });
      return rows.map((r) => ({ type: 'ticket' as const, id: r.id, title: r.subject, subtitle: `#${r.number} · ${r.status}` }));
    },
  },
  {
    type: 'task', perms: ['crm.read'],
    async run(q, take) {
      const rows = await prisma.task.findMany({
        where: { deletedAt: null, title: ci(q) },
        select: { id: true, title: true, status: true }, take, orderBy: { updatedAt: 'desc' },
      });
      return rows.map((r) => ({ type: 'task' as const, id: r.id, title: r.title, subtitle: r.status }));
    },
  },
  {
    type: 'note', perms: ['crm.read'],
    async run(q, take) {
      const rows = await prisma.note.findMany({
        where: { body: ci(q) },
        select: { id: true, body: true, entityId: true }, take, orderBy: { createdAt: 'desc' },
      });
      return rows.map((r) => ({ type: 'note' as const, id: r.id, title: r.body.slice(0, 80), subtitle: 'Note' }));
    },
  },
  {
    type: 'employee', perms: ['employees.read'],
    async run(q, take) {
      const rows = await prisma.employee.findMany({
        where: { deletedAt: null, OR: [{ firstName: ci(q) }, { lastName: ci(q) }, { email: ci(q) }, { employeeNumber: ci(q) }] },
        select: { id: true, firstName: true, lastName: true, email: true }, take, orderBy: { updatedAt: 'desc' },
      });
      return rows.map((r) => ({ type: 'employee' as const, id: r.id, title: name(r.firstName, r.lastName), subtitle: r.email }));
    },
  },
  {
    type: 'file', perms: ['files.read'],
    async run(q, take) {
      const rows = await prisma.file.findMany({
        where: { fileName: ci(q) },
        select: { id: true, fileName: true, mimeType: true }, take, orderBy: { createdAt: 'desc' },
      });
      return rows.map((r) => ({ type: 'file' as const, id: r.id, title: r.fileName, subtitle: r.mimeType }));
    },
  },
  {
    type: 'meeting', perms: ['appointments.read', 'crm.read'],
    async run(q, take) {
      const rows = await prisma.meeting.findMany({
        where: { deletedAt: null, title: ci(q) },
        select: { id: true, title: true, startAt: true }, take, orderBy: { startAt: 'desc' },
      });
      return rows.map((r) => ({ type: 'meeting' as const, id: r.id, title: r.title, subtitle: new Date(r.startAt).toLocaleString() }));
    },
  },
];

export const searchService = {
  /** The entity types the current caller is allowed to search. */
  async allowedTypes(): Promise<SearchEntityType[]> {
    const checks = await Promise.all(
      SEARCHERS.map(async (s) => ((await callerHasPermission(...s.perms)) ? s.type : null)),
    );
    return checks.filter((t): t is SearchEntityType => t !== null);
  },

  /** Run a global search across every permitted entity type. */
  async search(rawQuery: string, opts: { perType?: number; types?: SearchEntityType[] } = {}): Promise<SearchGroup[]> {
    const q = rawQuery.trim();
    if (q.length < 2) return [];
    const perType = Math.min(Math.max(opts.perType ?? 5, 1), 20);

    const runnable = await Promise.all(
      SEARCHERS.map(async (s) => {
        if (opts.types && !opts.types.includes(s.type)) return null;
        if (!(await callerHasPermission(...s.perms))) return null;
        try {
          const hits = await s.run(q, perType);
          return hits.length ? { type: s.type, label: LABELS[s.type], hits } : null;
        } catch {
          return null; // one flaky type never sinks the whole search
        }
      }),
    );
    return runnable.filter((g): g is SearchGroup => g !== null);
  },
};
