import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors';
import { prisma } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { activityService } from '../crm/activity.service';
import { workflowService } from '../crm/workflow.service';
import { orderNotifyService } from '../notifications/order-notify.service';
import { paymentLinksService } from '../payments/payment-links.service';
import { logger } from '../../shared/logger';
import { env } from '../../shared/config/env';
import { exchangeRates } from '../../shared/exchange-rates';

const payUrl = (token: string) => `${env.WEB_APP_URL.replace(/\/+$/, '')}/pay/${token}`;

/** Mirror an invoice event onto the CRM timeline (invoice + its customer). */
async function recordInvoiceActivity(
  inv: { id: string; number: string; customer?: { id: string } | null },
  title: string,
  body?: string,
): Promise<void> {
  await activityService.record({
    type: 'SYSTEM',
    entityType: 'INVOICE',
    entityId: inv.id,
    title,
    body,
    also: inv.customer ? [{ entityType: 'CUSTOMER', entityId: inv.customer.id }] : undefined,
  });
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

function orgId(): string {
  const id = requestContext.get()?.organizationId;
  if (!id) throw new Error('No tenant in request context');
  return id;
}

export const listInvoicesSchema = z.object({
  status: z.enum(['DRAFT', 'SENT', 'PAID', 'PARTIALLY_PAID', 'OVERDUE', 'VOID']).optional(),
  customerId: z.string().optional(),
  dealId: z.string().optional(),
  search: z.string().trim().max(120).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const invoiceItemSchema = z.object({
  description: z.string().trim().min(1).max(300),
  quantity: z.coerce.number().positive(),
  unitPrice: z.coerce.number().nonnegative(),
  taxRate: z.coerce.number().min(0).max(100).default(0),
});

export const createInvoiceSchema = z.object({
  customerId: z.string().min(1),
  dueInDays: z.coerce.number().int().min(0).max(365).default(14),
  notes: z.string().trim().max(2000).nullable().optional(),
  // DRAFT invoices can still be edited; SENT ones are issued to the customer.
  status: z.enum(['DRAFT', 'SENT']).default('SENT'),
  items: z.array(invoiceItemSchema).min(1),
  /**
   * Auto-generate a shareable payment link for the new invoice (spec #9). When
   * omitted, the org's Settings → Invoices default applies.
   */
  autoPaymentLink: z.boolean().optional(),
});

export const updateInvoiceSchema = z.object({
  customerId: z.string().min(1).optional(),
  dueInDays: z.coerce.number().int().min(0).max(365).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  items: z.array(invoiceItemSchema).min(1).optional(),
});

export const invoicePaymentSchema = z.object({
  amount: z.coerce.number().positive(),
  method: z.enum(['CASH', 'CARD', 'BANK_TRANSFER', 'MOBILE_MONEY', 'WALLET', 'CHEQUE', 'ONLINE_GATEWAY', 'COD']),
  reference: z.string().trim().max(120).optional(),
});

export type ListInvoicesDto = z.infer<typeof listInvoicesSchema>;
export type CreateInvoiceDto = z.infer<typeof createInvoiceSchema>;
export type UpdateInvoiceDto = z.infer<typeof updateInvoiceSchema>;
export type InvoicePaymentDto = z.infer<typeof invoicePaymentSchema>;

/** Sum line items into subtotal / tax / per-line totals. */
function computeItemTotals(items: CreateInvoiceDto['items']) {
  let subtotal = 0;
  let taxTotal = 0;
  const priced = items.map((i) => {
    const net = round2(i.unitPrice * i.quantity);
    const tax = round2((net * i.taxRate) / 100);
    subtotal = round2(subtotal + net);
    taxTotal = round2(taxTotal + tax);
    return { ...i, total: round2(net + tax) };
  });
  return { priced, subtotal, taxTotal, total: round2(subtotal + taxTotal) };
}

const invoiceSelect = {
  id: true,
  number: true,
  status: true,
  currency: true,
  subtotal: true,
  taxTotal: true,
  total: true,
  amountPaid: true,
  issuedAt: true,
  dueAt: true,
  paidAt: true,
  notes: true,
  createdAt: true,
  dealId: true,
  customer: { select: { id: true, firstName: true, lastName: true, email: true } },
  order: { select: { id: true, number: true } },
  deal: { select: { id: true, title: true, status: true } },
  items: {
    select: { id: true, description: true, quantity: true, unitPrice: true, taxRate: true, total: true },
  },
  payments: {
    select: { id: true, amount: true, method: true, status: true, paidAt: true },
    orderBy: { createdAt: 'desc' as const },
  },
} as const;

type InvoiceRow = { status: string; dueAt: Date | null };

/** OVERDUE is derived, not stored — SENT/PARTIALLY_PAID past due date. */
function withDerivedStatus<T extends InvoiceRow>(inv: T): T & { isOverdue: boolean } {
  const isOverdue =
    ['SENT', 'PARTIALLY_PAID'].includes(inv.status) &&
    inv.dueAt !== null &&
    inv.dueAt < new Date();
  return { ...inv, isOverdue };
}

async function nextInvoiceNumber(tx: Pick<typeof prisma, 'invoice'>, organizationId: string): Promise<string> {
  const year = new Date().getFullYear();
  const count = await tx.invoice.count({
    where: { organizationId, number: { startsWith: `INV-${year}-` } },
  });
  return `INV-${year}-${String(count + 1).padStart(5, '0')}`;
}

async function invoiceForDisplay<T extends {
  currency: string;
  subtotal: unknown;
  taxTotal: unknown;
  total: unknown;
  amountPaid: unknown;
  items: Array<{ unitPrice: unknown; total: unknown }>;
  payments: Array<{ amount: unknown }>;
}>(invoice: T): Promise<T> {
  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: orgId() },
    select: { currency: true },
  });
  if (invoice.currency === org.currency) return invoice;
  const conversion = await exchangeRates.convert(1, invoice.currency, org.currency);
  const money = (value: unknown) => round2(Number(value) * conversion.rate);
  return {
    ...invoice,
    currency: org.currency,
    subtotal: money(invoice.subtotal),
    taxTotal: money(invoice.taxTotal),
    total: money(invoice.total),
    amountPaid: money(invoice.amountPaid),
    items: invoice.items.map((i) => ({ ...i, unitPrice: money(i.unitPrice), total: money(i.total) })),
    payments: invoice.payments.map((p) => ({ ...p, amount: money(p.amount) })),
    sourceCurrency: invoice.currency,
    exchangeRate: conversion.rate,
    exchangeRateAsOf: conversion.asOf,
  } as T;
}

export const invoicesService = {
  async list(dto: ListInvoicesDto) {
    const overdueFilter =
      dto.status === 'OVERDUE'
        ? { status: { in: ['SENT', 'PARTIALLY_PAID'] as never[] }, dueAt: { lt: new Date() } }
        : dto.status
          ? { status: dto.status }
          : {};
    const rows = await prisma.invoice.findMany({
      where: {
        deletedAt: null,
        ...(overdueFilter as object),
        ...(dto.customerId ? { customerId: dto.customerId } : {}),
        ...(dto.dealId ? { dealId: dto.dealId } : {}),
        ...(dto.search ? { number: { contains: dto.search, mode: 'insensitive' as const } } : {}),
      },
      select: invoiceSelect,
      orderBy: { createdAt: 'desc' },
      take: dto.limit + 1,
      ...(dto.cursor ? { cursor: { id: dto.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > dto.limit;
    const items = await Promise.all(
      (hasMore ? rows.slice(0, dto.limit) : rows)
        .map(withDerivedStatus)
        .map(invoiceForDisplay),
    );
    return { items, nextCursor: hasMore ? items[items.length - 1]?.id ?? null : null };
  },

  async get(id: string) {
    const invoice = await prisma.invoice.findFirst({
      where: { id, deletedAt: null },
      select: invoiceSelect,
    });
    if (!invoice) throw new NotFoundError('Invoice');
    return invoiceForDisplay(withDerivedStatus(invoice));
  },

  async createStandalone(dto: CreateInvoiceDto) {
    const organizationId = orgId();
    const customer = await prisma.customer.findFirst({
      where: { id: dto.customerId, deletedAt: null },
    });
    if (!customer) throw new NotFoundError('Customer');

    const { priced, subtotal, taxTotal, total } = computeItemTotals(dto.items);
    const isSent = dto.status === 'SENT';

    const inv = await prisma.$transaction(async (tx) => {
      const org = await tx.organization.findUniqueOrThrow({
        where: { id: organizationId },
        select: { currency: true },
      });
      const invoice = await tx.invoice.create({
        data: {
          organizationId,
          number: await nextInvoiceNumber(tx, organizationId),
          customerId: dto.customerId,
          status: dto.status,
          currency: org.currency,
          subtotal,
          taxTotal,
          total,
          issuedAt: isSent ? new Date() : null,
          dueAt: new Date(Date.now() + dto.dueInDays * 24 * 60 * 60 * 1000),
          notes: dto.notes ?? null,
          items: { create: priced },
        },
        select: invoiceSelect,
      });
      return withDerivedStatus(invoice);
    });
    await recordInvoiceActivity(
      inv,
      isSent ? `Invoice ${inv.number} issued` : `Draft invoice ${inv.number} created`,
      `${inv.currency} ${Number(inv.total).toFixed(2)}`,
    );
    const paymentLink = await this.maybeAttachPaymentLink(inv, dto.autoPaymentLink);
    return { ...inv, paymentLink };
  },

  /** Edit a DRAFT invoice — items/notes/customer/due date. Issued invoices are immutable. */
  async update(id: string, dto: UpdateInvoiceDto) {
    const invoice = await prisma.invoice.findFirst({ where: { id, deletedAt: null } });
    if (!invoice) throw new NotFoundError('Invoice');
    if (invoice.status !== 'DRAFT') {
      throw new ConflictError('Only draft invoices can be edited');
    }
    if (dto.customerId) {
      const customer = await prisma.customer.findFirst({
        where: { id: dto.customerId, deletedAt: null },
      });
      if (!customer) throw new NotFoundError('Customer');
    }

    const totals = dto.items ? computeItemTotals(dto.items) : null;

    return prisma.$transaction(async (tx) => {
      if (dto.items) {
        await tx.invoiceItem.deleteMany({ where: { invoiceId: id } });
      }
      const updated = await tx.invoice.update({
        where: { id },
        data: {
          ...(dto.customerId ? { customerId: dto.customerId } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
          ...(dto.dueInDays !== undefined
            ? { dueAt: new Date(Date.now() + dto.dueInDays * 24 * 60 * 60 * 1000) }
            : {}),
          ...(totals
            ? {
                subtotal: totals.subtotal,
                taxTotal: totals.taxTotal,
                total: totals.total,
                items: { create: totals.priced },
              }
            : {}),
        },
        select: invoiceSelect,
      });
      return withDerivedStatus(updated);
    });
  },

  /** Issue a DRAFT invoice to the customer. */
  async send(id: string) {
    const invoice = await prisma.invoice.findFirst({ where: { id, deletedAt: null } });
    if (!invoice) throw new NotFoundError('Invoice');
    if (invoice.status !== 'DRAFT') throw new ConflictError('Invoice is not a draft');
    const updated = await prisma.invoice.update({
      where: { id },
      data: { status: 'SENT', issuedAt: invoice.issuedAt ?? new Date() },
      select: invoiceSelect,
    });
    const result = withDerivedStatus(updated);
    await recordInvoiceActivity(result, `Invoice ${result.number} sent to customer`);
    return result;
  },

  async createFromOrder(orderId: string, dueInDays = 14) {
    const order = await prisma.order.findFirst({
      where: { id: orderId },
      include: { items: true, invoices: { where: { deletedAt: null, status: { not: 'VOID' } } } },
    });
    if (!order) throw new NotFoundError('Order');
    if (order.status === 'CANCELLED') throw new ConflictError('Order is cancelled');
    if (order.invoices.length > 0) {
      throw new ConflictError('This order already has an invoice', {
        invoiceId: order.invoices[0]?.id,
      });
    }

    const alreadyPaid = order.paymentStatus === 'PAID';

    const inv = await prisma.$transaction(async (tx) => {
      const invoice = await tx.invoice.create({
        data: {
          organizationId: order.organizationId,
          number: await nextInvoiceNumber(tx, order.organizationId),
          customerId: order.customerId,
          orderId: order.id,
          status: alreadyPaid ? 'PAID' : 'SENT',
          currency: order.currency,
          subtotal: order.subtotal,
          taxTotal: order.taxTotal,
          discountTotal: order.discountTotal,
          total: order.total,
          amountPaid: alreadyPaid ? order.total : 0,
          issuedAt: new Date(),
          dueAt: new Date(Date.now() + dueInDays * 24 * 60 * 60 * 1000),
          paidAt: alreadyPaid ? new Date() : null,
          items: {
            create: order.items.map((i) => ({
              description: `${i.name} (${i.sku})`,
              quantity: i.quantity,
              unitPrice: i.unitPrice,
              taxRate: i.taxRate,
              total: i.total,
            })),
          },
        },
        select: invoiceSelect,
      });
      return withDerivedStatus(invoice);
    });
    await recordInvoiceActivity(inv, `Invoice ${inv.number} generated from order ${order.number}`);
    return { ...inv, paymentLink: await this.maybeAttachPaymentLink(inv) };
  },

  /**
   * Generate an invoice from a CRM deal. If the deal has an accepted quotation
   * we mirror its line items and totals; otherwise we fall back to a single
   * line for the deal's value. Idempotent-ish: refuses if the deal already has
   * a live (non-void) invoice.
   */
  async createFromDeal(dealId: string, dueInDays = 14) {
    const deal = await prisma.deal.findFirst({
      where: { id: dealId, deletedAt: null },
      select: {
        id: true,
        organizationId: true,
        title: true,
        value: true,
        currency: true,
        customerId: true,
        invoices: { where: { deletedAt: null, status: { not: 'VOID' } }, select: { id: true, number: true } },
        quotations: {
          where: { deletedAt: null, status: 'ACCEPTED' },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            currency: true,
            subtotal: true,
            taxTotal: true,
            discountTotal: true,
            total: true,
            items: {
              select: { description: true, quantity: true, unitPrice: true, taxRate: true, total: true },
            },
          },
        },
      },
    });
    if (!deal) throw new NotFoundError('Deal');
    if (!deal.customerId) {
      throw new ValidationError('This deal has no customer, so it cannot be invoiced');
    }
    if (deal.invoices.length > 0) {
      throw new ConflictError('This deal already has an invoice', {
        invoiceId: deal.invoices[0]?.id,
      });
    }

    const quote = deal.quotations[0];
    const dueAt = new Date(Date.now() + dueInDays * 24 * 60 * 60 * 1000);

    const inv = await prisma.$transaction(async (tx) => {
      const number = await nextInvoiceNumber(tx, deal.organizationId);
      const base = {
        organizationId: deal.organizationId,
        number,
        customerId: deal.customerId as string,
        dealId: deal.id,
        // Created, not sent. Whether the customer is contacted — and through
        // which channel — is the user's decision, taken right after this.
        status: 'DRAFT' as const,
        issuedAt: null,
        dueAt,
      };

      const invoice = quote
        ? await tx.invoice.create({
            data: {
              ...base,
              currency: quote.currency,
              subtotal: quote.subtotal,
              taxTotal: quote.taxTotal,
              discountTotal: quote.discountTotal,
              total: quote.total,
              items: {
                create: quote.items.map((i) => ({
                  description: i.description,
                  quantity: i.quantity,
                  unitPrice: i.unitPrice,
                  taxRate: i.taxRate,
                  total: i.total,
                })),
              },
            },
            select: invoiceSelect,
          })
        : await tx.invoice.create({
            data: {
              ...base,
              currency: deal.currency,
              subtotal: deal.value,
              taxTotal: 0,
              total: deal.value,
              items: {
                create: [
                  {
                    description: deal.title,
                    quantity: 1,
                    unitPrice: deal.value,
                    taxRate: 0,
                    total: deal.value,
                  },
                ],
              },
            },
            select: invoiceSelect,
          });
      return withDerivedStatus(invoice);
    });
    await recordInvoiceActivity(inv, `Invoice ${inv.number} generated from deal “${deal.title}”`);
    return { ...inv, paymentLink: await this.maybeAttachPaymentLink(inv) };
  },

  async recordPayment(id: string, dto: InvoicePaymentDto, actorMembershipId: string | null) {
    const invoice = await prisma.invoice.findFirst({ where: { id, deletedAt: null } });
    if (!invoice) throw new NotFoundError('Invoice');
    if (invoice.status === 'VOID') throw new ConflictError('Invoice is void');
    if (invoice.status === 'PAID') throw new ConflictError('Invoice is already paid');

    const remaining = round2(Number(invoice.total) - Number(invoice.amountPaid));
    if (dto.amount > remaining + 0.005) {
      throw new ValidationError(`Amount exceeds outstanding balance (${remaining.toFixed(2)})`);
    }
    const newPaid = round2(Number(invoice.amountPaid) + dto.amount);
    const fullyPaid = newPaid >= Number(invoice.total) - 0.005;

    const paid = await prisma.$transaction(async (tx) => {
      await tx.payment.create({
        data: {
          organizationId: invoice.organizationId,
          customerId: invoice.customerId,
          invoiceId: invoice.id,
          orderId: invoice.orderId,
          method: dto.method,
          status: 'PAID',
          amount: dto.amount,
          currency: invoice.currency,
          provider: 'manual',
          providerRef: dto.reference ?? null,
          receivedById: actorMembershipId,
          paidAt: new Date(),
        },
      });
      const updated = await tx.invoice.update({
        where: { id },
        data: {
          amountPaid: newPaid,
          status: fullyPaid ? 'PAID' : 'PARTIALLY_PAID',
          paidAt: fullyPaid ? new Date() : null,
        },
        select: invoiceSelect,
      });
      return withDerivedStatus(updated);
    });
    await recordInvoiceActivity(
      paid,
      `Payment recorded — ${paid.currency} ${dto.amount.toFixed(2)}`,
      `${dto.method.replace(/_/g, ' ').toLowerCase()}${fullyPaid ? ' · fully paid' : ''}`,
    );
    if (fullyPaid) {
      await workflowService.dispatch(
        'invoice.paid',
        { number: paid.number, total: Number(paid.total), method: dto.method, currency: paid.currency },
        { entityType: 'INVOICE', entityId: id, customerId: paid.customer?.id ?? null },
      );
      void orderNotifyService.notify(orgId(), 'invoice.paid', {
        title: `Invoice ${paid.number} paid`,
        lines: [`Total: ${paid.currency} ${Number(paid.total).toFixed(2)}`],
      });
      // Roll the payment up to the linked deal (#10).
      await this.settleDealForInvoice(id).catch((err) =>
        logger.warn({ err: (err as Error).message, invoiceId: id }, 'deal settle from invoice failed'),
      );
    }
    return paid;
  },

  /**
   * Auto-generate a shareable payment link for an invoice (spec #9). Opt-in per
   * request or via the org's Settings → Invoices default. Skips drafts, invoices
   * with nothing outstanding, and re-uses an existing pending link. Best-effort:
   * a link failure must never fail invoice creation. Returns the link or null.
   */
  async maybeAttachPaymentLink(
    invoice: { id: string; status: string; total: unknown; amountPaid: unknown },
    override?: boolean,
  ): Promise<{ id: string; url: string; token: string } | null> {
    try {
      let enabled = override;
      if (enabled === undefined) {
        const org = await prisma.organization.findUnique({ where: { id: orgId() }, select: { settings: true } });
        const inv = ((org?.settings as Record<string, unknown>) ?? {}).invoices as { autoPaymentLink?: boolean } | undefined;
        enabled = inv?.autoPaymentLink ?? false;
      }
      if (!enabled) return null;
      if (invoice.status === 'DRAFT') return null;
      if (round2(Number(invoice.total) - Number(invoice.amountPaid)) <= 0) return null;

      // Reuse an active link for this invoice rather than piling up duplicates.
      const existing = await prisma.paymentLink.findFirst({
        where: { resourceType: 'INVOICE', resourceId: invoice.id, status: { in: ['PENDING', 'PARTIALLY_PAID'] } },
        select: { id: true, token: true },
      });
      if (existing) {
        return { id: existing.id, token: existing.token, url: payUrl(existing.token) };
      }
      const link = await paymentLinksService.create(
        { resourceType: 'INVOICE', resourceId: invoice.id, allowPartial: true },
        null,
      );
      return { id: link.id, token: link.token, url: link.url };
    } catch (err) {
      logger.warn({ err: (err as Error).message, invoiceId: invoice.id }, 'auto payment link on invoice failed');
      return null;
    }
  },

  /**
   * Roll a fully-paid invoice up to its deal (spec #10): records payment
   * progress across all the deal's invoices on the timeline and, when every
   * invoice is settled and the org opted in (crm.dealAutomation.autoCompleteOnPaid),
   * marks the deal won. Multiple invoices per deal are aggregated.
   */
  async settleDealForInvoice(invoiceId: string): Promise<void> {
    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: { dealId: true, organizationId: true, currency: true },
    });
    if (!invoice?.dealId) return;

    const invoices = await prisma.invoice.findMany({
      where: { dealId: invoice.dealId, deletedAt: null, status: { not: 'VOID' } },
      select: { total: true, amountPaid: true },
    });
    const invoiced = round2(invoices.reduce((s, i) => s + Number(i.total), 0));
    const paidTotal = round2(invoices.reduce((s, i) => s + Number(i.amountPaid), 0));
    const outstanding = round2(invoiced - paidTotal);
    const allPaid = invoices.length > 0 && outstanding <= 0.005;

    await activityService.record({
      type: 'SYSTEM',
      entityType: 'DEAL',
      entityId: invoice.dealId,
      title: 'Invoice payment applied to deal',
      body: `Paid ${invoice.currency} ${paidTotal.toFixed(2)} of ${invoiced.toFixed(2)} · outstanding ${outstanding.toFixed(2)}`,
      metadata: { invoiced, paid: paidTotal, outstanding, invoiceCount: invoices.length, allPaid },
    });

    if (!allPaid) return;

    // Auto-complete the deal when configured and it's still open.
    const org = await prisma.organization.findUnique({ where: { id: invoice.organizationId }, select: { settings: true } });
    const autoComplete = Boolean(
      (((org?.settings as Record<string, unknown>) ?? {}).crm as { dealAutomation?: { autoCompleteOnPaid?: boolean } } | undefined)
        ?.dealAutomation?.autoCompleteOnPaid,
    );
    if (!autoComplete) return;

    const deal = await prisma.deal.findFirst({
      where: { id: invoice.dealId, deletedAt: null, status: 'OPEN' },
      include: { pipeline: { include: { stages: true } } },
    });
    if (!deal) return;
    const wonStage = deal.pipeline.stages.find((s) => s.isWonStage);
    await prisma.deal.update({
      where: { id: deal.id },
      data: { status: 'WON', closedAt: new Date(), ...(wonStage ? { stageId: wonStage.id } : {}) },
    });
    await activityService.record({
      type: 'STATUS_CHANGE',
      entityType: 'DEAL',
      entityId: deal.id,
      title: `Deal won 🎉 — ${deal.title}`,
      body: 'Automatically closed: all linked invoices fully paid.',
      metadata: { auto: true, reason: 'invoices_fully_paid', invoiced, paid: paidTotal },
    });
    await workflowService.dispatch(
      'deal.won',
      { title: deal.title, value: Number(deal.value), currency: deal.currency },
      { entityType: 'DEAL', entityId: deal.id, customerId: deal.customerId ?? null },
    );
  },

  /**
   * Void an invoice.
   *
   * An invoice that has taken money is not a clerical mistake to be undone: the
   * payment still exists and still has to reconcile. Voiding one is therefore
   * refused unless the caller both holds the permission and says explicitly
   * that they accept it — and even then the payment records are left untouched.
   */
  async voidInvoice(id: string, opts: { reason?: string; allowPaid?: boolean } = {}) {
    const invoice = await prisma.invoice.findFirst({ where: { id, deletedAt: null } });
    if (!invoice) throw new NotFoundError('Invoice');
    if (invoice.status === 'VOID') throw new ConflictError('This invoice is already void');

    const amountPaid = Number(invoice.amountPaid);
    if (amountPaid > 0 && !opts.allowPaid) {
      throw new ConflictError(
        `This invoice has already received ${invoice.currency} ${amountPaid.toLocaleString()}. ` +
          'Review the payment, refund or reconciliation before voiding it.',
        { amountPaid, invoiceId: id, requiresOverride: true },
      );
    }

    const updated = await prisma.invoice.update({
      where: { id },
      data: { status: 'VOID', voidedAt: new Date(), voidReason: opts.reason?.trim() || null },
      select: invoiceSelect,
    });
    const result = withDerivedStatus(updated);
    await recordInvoiceActivity(
      result,
      `Invoice ${result.number} voided`,
      [
        opts.reason?.trim() ? `Reason: ${opts.reason.trim()}` : null,
        amountPaid > 0
          ? `Note: ${invoice.currency} ${amountPaid.toLocaleString()} had already been paid against this invoice. Payment records are unchanged.`
          : null,
      ].filter(Boolean).join('\n') || undefined,
    );
    return result;
  },

  /**
   * What a deal's existing invoice situation is, so the user can be asked
   * rather than have one silently overwritten.
   */
  async dealInvoiceStatus(dealId: string) {
    const deal = await prisma.deal.findFirst({
      where: { id: dealId, deletedAt: null },
      select: { id: true, value: true, currency: true },
    });
    if (!deal) throw new NotFoundError('Deal');

    const invoices = await prisma.invoice.findMany({
      where: { dealId, deletedAt: null },
      select: {
        id: true, number: true, status: true, total: true, amountPaid: true,
        currency: true, replacedByInvoiceId: true, voidedAt: true, createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    const existing = invoices.find((i) => i.status !== 'VOID') ?? null;

    return {
      dealId: deal.id,
      dealValue: Number(deal.value),
      currency: deal.currency,
      hasExisting: existing !== null,
      existing,
      // The difference is what makes the question worth asking at all.
      valueDiffers: existing ? Math.abs(Number(existing.total) - Number(deal.value)) >= 0.005 : false,
      existingIsPaid: existing ? Number(existing.amountPaid) > 0 : false,
      invoices,
    };
  },

  /**
   * Replace a deal's invoice with one reflecting the current deal value.
   *
   * The old invoice is voided and kept, not deleted, and the two are linked in
   * both directions — the business can always show what was billed first and
   * what superseded it.
   */
  async replaceDealInvoice(
    dealId: string,
    opts: { reason?: string; allowPaid?: boolean; dueInDays?: number } = {},
  ) {
    const status = await this.dealInvoiceStatus(dealId);
    if (!status.existing) throw new ValidationError('This deal has no invoice to replace');

    const oldId = status.existing.id;
    const voided = await this.voidInvoice(oldId, {
      reason: opts.reason?.trim() || `Replaced after the deal value changed`,
      allowPaid: opts.allowPaid,
    });

    const created = await this.createFromDeal(dealId, opts.dueInDays);

    // Link both ways, so either invoice leads to the other.
    await prisma.$transaction([
      prisma.invoice.update({ where: { id: oldId }, data: { replacedByInvoiceId: created.id } }),
      prisma.invoice.update({ where: { id: created.id }, data: { replacesInvoiceId: oldId } }),
    ]);

    await recordInvoiceActivity(
      created,
      `Invoice ${created.number} replaces ${voided.number}`,
      [
        `${voided.number} (${voided.currency} ${Number(voided.total).toLocaleString()}) was voided and kept in history.`,
        `${created.number} was created for ${created.currency} ${Number(created.total).toLocaleString()}.`,
        opts.reason?.trim() ? `Reason: ${opts.reason.trim()}` : null,
      ].filter(Boolean).join('\n'),
    );

    return { voided, created };
  },
};
