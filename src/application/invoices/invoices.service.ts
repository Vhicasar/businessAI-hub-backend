import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors';
import { prisma } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';

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

export const createInvoiceSchema = z.object({
  customerId: z.string().min(1),
  dueInDays: z.coerce.number().int().min(0).max(365).default(14),
  notes: z.string().trim().max(2000).nullable().optional(),
  items: z
    .array(
      z.object({
        description: z.string().trim().min(1).max(300),
        quantity: z.coerce.number().positive(),
        unitPrice: z.coerce.number().nonnegative(),
        taxRate: z.coerce.number().min(0).max(100).default(0),
      })
    )
    .min(1),
});

export const invoicePaymentSchema = z.object({
  amount: z.coerce.number().positive(),
  method: z.enum(['CASH', 'CARD', 'BANK_TRANSFER', 'MOBILE_MONEY', 'WALLET', 'CHEQUE', 'ONLINE_GATEWAY', 'COD']),
  reference: z.string().trim().max(120).optional(),
});

export type ListInvoicesDto = z.infer<typeof listInvoicesSchema>;
export type CreateInvoiceDto = z.infer<typeof createInvoiceSchema>;
export type InvoicePaymentDto = z.infer<typeof invoicePaymentSchema>;

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
    const items = (hasMore ? rows.slice(0, dto.limit) : rows).map(withDerivedStatus);
    return { items, nextCursor: hasMore ? items[items.length - 1]?.id ?? null : null };
  },

  async get(id: string) {
    const invoice = await prisma.invoice.findFirst({
      where: { id, deletedAt: null },
      select: invoiceSelect,
    });
    if (!invoice) throw new NotFoundError('Invoice');
    return withDerivedStatus(invoice);
  },

  async createStandalone(dto: CreateInvoiceDto) {
    const organizationId = orgId();
    const customer = await prisma.customer.findFirst({
      where: { id: dto.customerId, deletedAt: null },
    });
    if (!customer) throw new NotFoundError('Customer');

    let subtotal = 0;
    let taxTotal = 0;
    const items = dto.items.map((i) => {
      const net = round2(i.unitPrice * i.quantity);
      const tax = round2((net * i.taxRate) / 100);
      subtotal = round2(subtotal + net);
      taxTotal = round2(taxTotal + tax);
      return { ...i, total: round2(net + tax) };
    });

    return prisma.$transaction(async (tx) => {
      const org = await tx.organization.findUniqueOrThrow({
        where: { id: organizationId },
        select: { currency: true },
      });
      const invoice = await tx.invoice.create({
        data: {
          organizationId,
          number: await nextInvoiceNumber(tx, organizationId),
          customerId: dto.customerId,
          status: 'SENT',
          currency: org.currency,
          subtotal,
          taxTotal,
          total: round2(subtotal + taxTotal),
          issuedAt: new Date(),
          dueAt: new Date(Date.now() + dto.dueInDays * 24 * 60 * 60 * 1000),
          notes: dto.notes ?? null,
          items: { create: items },
        },
        select: invoiceSelect,
      });
      return withDerivedStatus(invoice);
    });
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

    return prisma.$transaction(async (tx) => {
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

    return prisma.$transaction(async (tx) => {
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
    return withDerivedStatus(updated);
  },
};
