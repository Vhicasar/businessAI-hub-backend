import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors';
import { prisma } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { activityService } from '../crm/activity.service';
import { workflowService } from '../crm/workflow.service';
import { exchangeRates } from '../../shared/exchange-rates';

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
  customer: { select: { id: true, firstName: true, lastName: true, email: true } },
  order: { select: { id: true, number: true } },
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

async function nextInvoiceNumber(tx: Prisma.TransactionClient, organizationId: string): Promise<string> {
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
    return inv;
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
    return inv;
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
    }
    return paid;
  },

  async voidInvoice(id: string) {
    const invoice = await prisma.invoice.findFirst({ where: { id, deletedAt: null } });
    if (!invoice) throw new NotFoundError('Invoice');
    if (Number(invoice.amountPaid) > 0) {
      throw new ConflictError('Cannot void an invoice with recorded payments');
    }
    const updated = await prisma.invoice.update({
      where: { id },
      data: { status: 'VOID' },
      select: invoiceSelect,
    });
    const result = withDerivedStatus(updated);
    await recordInvoiceActivity(result, `Invoice ${result.number} voided`);
    return result;
  },
};
