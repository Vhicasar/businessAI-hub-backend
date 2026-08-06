import { Prisma } from '@prisma/client';
import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { ForbiddenError, NotFoundError } from '../../shared/errors';
import { businessDashboard } from '../discovery/business-dashboard.service';

/**
 * Customer Order Center (§4, §6, §7, §9).
 *
 * Everything a customer has with one business — orders, quotations, invoices,
 * bookings, reservations, rent, maintenance and receipts — read through their
 * own CustomerLink so one Vhicasar account can see many businesses without any
 * of them seeing each other.
 *
 * Every list returns `{ items: [], ... }` — never null — so a client can render
 * an empty state instead of crashing on a missing collection (§11).
 */

const money = (v: Prisma.Decimal | null | undefined) => (v ?? new Prisma.Decimal(0)).toFixed(2);

export type RecordKind =
  | 'ORDER'
  | 'QUOTATION'
  | 'INVOICE'
  | 'BOOKING'
  | 'APPOINTMENT'
  | 'RENT'
  | 'MAINTENANCE';

/** One row in the unified activity list. */
export interface CustomerRecord {
  id: string;
  kind: RecordKind;
  reference: string;
  title: string;
  status: string;
  amount: string | null;
  outstanding: string | null;
  currency: string | null;
  /** True when the customer can pay something on this record right now (§8). */
  payable: boolean;
  occurredAt: Date;
}

export const orderCenter = {
  /**
   * Everything the customer has with one business, newest first.
   * `kinds` narrows the list; omitting it returns all of them.
   */
  async records(
    vhicasarId: string,
    organizationId: string,
    opts: { kinds?: RecordKind[]; limit?: number } = {}
  ): Promise<{ items: CustomerRecord[]; counts: Record<string, number> }> {
    const link = await businessDashboard.requireLink(vhicasarId, organizationId);
    const customerId = link.customerId;
    const limit = opts.limit ?? 25;
    const want = (kind: RecordKind) => !opts.kinds?.length || opts.kinds.includes(kind);

    const [orders, quotations, invoices, meetings, propertyBookings, maintenance] = await Promise.all([
      want('ORDER')
        ? prismaUnscoped.order.findMany({
            where: { customerId },
            orderBy: { createdAt: 'desc' },
            take: limit,
            select: {
              id: true, number: true, status: true, paymentStatus: true,
              total: true, currency: true, createdAt: true,
              // Order has no amountPaid column; what's settled is the sum of
              // its PAID payments.
              payments: { where: { status: 'PAID' }, select: { amount: true } },
            },
          })
        : [],
      want('QUOTATION')
        ? prismaUnscoped.quotation.findMany({
            where: { customerId },
            orderBy: { createdAt: 'desc' },
            take: limit,
            select: { id: true, number: true, status: true, total: true, currency: true, createdAt: true },
          })
        : [],
      want('INVOICE')
        ? prismaUnscoped.invoice.findMany({
            where: { customerId },
            orderBy: { createdAt: 'desc' },
            take: limit,
            select: {
              id: true, number: true, status: true, total: true,
              amountPaid: true, currency: true, createdAt: true, dueAt: true,
            },
          })
        : [],
      want('APPOINTMENT')
        ? prismaUnscoped.meeting.findMany({
            where: { customerId },
            orderBy: { startAt: 'desc' },
            take: limit,
            select: { id: true, title: true, status: true, startAt: true, createdAt: true },
          })
        : [],
      want('BOOKING')
        ? prismaUnscoped.propertyBooking.findMany({
            where: { customerId },
            orderBy: { createdAt: 'desc' },
            take: limit,
            select: { id: true, status: true, createdAt: true, property: { select: { title: true } } },
          })
        : [],
      want('MAINTENANCE')
        ? prismaUnscoped.maintenanceRequest.findMany({
            where: { requestedById: customerId },
            orderBy: { createdAt: 'desc' },
            take: limit,
            select: { id: true, title: true, status: true, createdAt: true },
          })
        : [],
    ]);

    const items: CustomerRecord[] = [
      ...orders.map((o) => {
        const paid = o.payments.reduce((sum, p) => sum.plus(p.amount), new Prisma.Decimal(0));
        const outstanding = o.total.minus(paid);
        return {
          id: o.id,
          kind: 'ORDER' as const,
          reference: o.number,
          title: `Order ${o.number}`,
          status: o.status,
          amount: money(o.total),
          outstanding: money(outstanding),
          currency: o.currency,
          payable: outstanding.greaterThan(0) && o.status !== 'CANCELLED',
          occurredAt: o.createdAt,
        };
      }),
      ...quotations.map((q) => ({
        id: q.id,
        kind: 'QUOTATION' as const,
        reference: q.number,
        title: `Quotation ${q.number}`,
        status: q.status,
        amount: money(q.total),
        outstanding: null,
        currency: q.currency,
        payable: false,
        occurredAt: q.createdAt,
      })),
      ...invoices.map((i) => {
        const outstanding = i.total.minus(i.amountPaid);
        return {
          id: i.id,
          kind: 'INVOICE' as const,
          reference: i.number,
          title: `Invoice ${i.number}`,
          status: i.status,
          amount: money(i.total),
          outstanding: money(outstanding),
          currency: i.currency,
          payable: outstanding.greaterThan(0) && i.status !== 'VOID',
          occurredAt: i.createdAt,
        };
      }),
      ...meetings.map((m) => ({
        id: m.id,
        kind: 'APPOINTMENT' as const,
        reference: m.id.slice(-6).toUpperCase(),
        title: m.title,
        status: m.status,
        amount: null,
        outstanding: null,
        currency: null,
        payable: false,
        occurredAt: m.startAt,
      })),
      ...propertyBookings.map((b) => ({
        id: b.id,
        kind: 'BOOKING' as const,
        reference: b.id.slice(-6).toUpperCase(),
        title: b.property?.title ?? 'Property booking',
        status: b.status,
        amount: null,
        outstanding: null,
        currency: null,
        payable: false,
        occurredAt: b.createdAt,
      })),
      ...maintenance.map((m) => ({
        id: m.id,
        kind: 'MAINTENANCE' as const,
        reference: m.id.slice(-6).toUpperCase(),
        title: m.title,
        status: m.status,
        amount: null,
        outstanding: null,
        currency: null,
        payable: false,
        occurredAt: m.createdAt,
      })),
    ].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());

    const counts = items.reduce<Record<string, number>>((acc, r) => {
      acc[r.kind] = (acc[r.kind] ?? 0) + 1;
      return acc;
    }, {});

    return { items: items.slice(0, limit), counts };
  },

  /**
   * Full order detail with everything §6 asks for, including the promotions
   * applied and the loyalty it earned — the two things a customer most often
   * wants to confirm after a purchase.
   */
  async orderDetail(vhicasarId: string, organizationId: string, orderId: string) {
    const link = await businessDashboard.requireLink(vhicasarId, organizationId);

    const order = await prismaUnscoped.order.findFirst({
      where: { id: orderId, customerId: link.customerId },
      include: {
        items: {
          select: {
            id: true, name: true, quantity: true, unitPrice: true,
            taxRate: true, discount: true, total: true,
          },
        },
        statusHistory: { orderBy: { createdAt: 'asc' } },
        payments: { where: { status: 'PAID' }, select: { amount: true } },
      },
    });
    if (!order) throw new NotFoundError('Order');

    const [org, payments, promotions, loyalty] = await Promise.all([
      prismaUnscoped.organization.findUnique({
        where: { id: organizationId },
        select: { name: true, logoFileId: true, currency: true },
      }),
      prismaUnscoped.payment.findMany({
        where: { orderId: order.id },
        orderBy: { createdAt: 'desc' },
        select: { id: true, amount: true, currency: true, method: true, status: true, paidAt: true },
      }),
      prismaUnscoped.promotionRedemption.findMany({
        where: { orderId: order.id },
        select: { benefitAmount: true, currency: true, promotion: { select: { name: true, kind: true } } },
      }),
      prismaUnscoped.loyaltyTransaction.findFirst({
        where: { referenceType: 'Order', referenceId: order.id, type: 'EARN' },
        select: { points: true, createdAt: true },
      }),
    ]);

    // Actor names for the timeline, resolved in one query.
    const actorIds = [...new Set(order.statusHistory.map((h) => h.actorUserId).filter((x): x is string => Boolean(x)))];
    const actors = actorIds.length
      ? await prismaUnscoped.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, firstName: true, lastName: true },
        })
      : [];
    const actorName = (id: string | null) => {
      if (!id) return 'System';
      const u = actors.find((a) => a.id === id);
      return u ? `${u.firstName} ${u.lastName ?? ''}`.trim() : 'Staff';
    };

    const paidTotal = order.payments.reduce((sum, p) => sum.plus(p.amount), new Prisma.Decimal(0));
    const outstanding = order.total.minus(paidTotal);

    return {
      business: { id: organizationId, name: org?.name ?? 'Business', logoFileId: org?.logoFileId ?? null },
      id: order.id,
      number: order.number,
      status: order.status,
      paymentStatus: order.paymentStatus,
      currency: order.currency,
      items: order.items.map((i) => ({
        id: i.id,
        name: i.name,
        quantity: i.quantity.toString(),
        unitPrice: money(i.unitPrice),
        taxRate: i.taxRate.toString(),
        discount: money(i.discount),
        total: money(i.total),
      })),
      subtotal: money(order.subtotal),
      taxTotal: money(order.taxTotal),
      discountTotal: money(order.discountTotal),
      shippingTotal: money(order.shippingTotal),
      total: money(order.total),
      amountPaid: money(paidTotal),
      outstanding: money(outstanding),
      /** Drives the Pay button (§8). */
      payable: outstanding.greaterThan(0) && order.status !== 'CANCELLED',
      promotionsApplied: promotions.map((p) => ({
        name: p.promotion.name,
        kind: p.promotion.kind,
        benefit: money(p.benefitAmount),
        currency: p.currency,
      })),
      loyaltyEarned: loyalty ? { points: loyalty.points, at: loyalty.createdAt } : null,
      payments: payments.map((p) => ({
        id: p.id,
        amount: money(p.amount),
        currency: p.currency,
        method: p.method,
        status: p.status,
        paidAt: p.paidAt,
      })),
      deliveredAt: order.deliveredAt,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      /** Complete activity trail (§9). */
      timeline: order.statusHistory.map((h) => ({
        id: h.id,
        from: h.fromStatus,
        to: h.toStatus,
        by: actorName(h.actorUserId),
        note: h.note,
        at: h.createdAt,
      })),
    };
  },

  /** Invoice detail, with what is still owed. */
  async invoiceDetail(vhicasarId: string, organizationId: string, invoiceId: string) {
    const link = await businessDashboard.requireLink(vhicasarId, organizationId);
    const invoice = await prismaUnscoped.invoice.findFirst({
      where: { id: invoiceId, customerId: link.customerId },
      include: { items: true },
    });
    if (!invoice) throw new NotFoundError('Invoice');

    const outstanding = invoice.total.minus(invoice.amountPaid);
    const paymentLink = await prismaUnscoped.paymentLink.findFirst({
      where: { resourceType: 'INVOICE', resourceId: invoice.id, status: { in: ['PENDING', 'PARTIALLY_PAID'] } },
      select: { token: true },
    });

    return {
      id: invoice.id,
      number: invoice.number,
      status: invoice.status,
      currency: invoice.currency,
      items: invoice.items.map((i) => ({
        name: i.description,
        quantity: i.quantity.toString(),
        unitPrice: money(i.unitPrice),
        total: money(i.total),
      })),
      subtotal: money(invoice.subtotal),
      total: money(invoice.total),
      amountPaid: money(invoice.amountPaid),
      outstanding: money(outstanding),
      payable: outstanding.greaterThan(0) && invoice.status !== 'VOID',
      /** Present when the business already generated a link we can pay (§10). */
      paymentToken: paymentLink?.token ?? null,
      dueAt: invoice.dueAt,
      createdAt: invoice.createdAt,
    };
  },

  /**
   * Ensure there is something payable for a record, returning the token the
   * app pays against. Creating it on demand means a customer can always pay,
   * even when the business never generated a link.
   */
  async payableFor(
    vhicasarId: string,
    organizationId: string,
    kind: 'ORDER' | 'INVOICE',
    recordId: string
  ): Promise<{ token: string; amount: string; currency: string; description: string }> {
    const link = await businessDashboard.requireLink(vhicasarId, organizationId);

    const record =
      kind === 'ORDER'
        ? await prismaUnscoped.order.findFirst({
            where: { id: recordId, customerId: link.customerId },
            select: {
              id: true, number: true, total: true, currency: true, status: true,
              payments: { where: { status: 'PAID' }, select: { amount: true } },
            },
          })
        : await prismaUnscoped.invoice.findFirst({
            where: { id: recordId, customerId: link.customerId },
            select: { id: true, number: true, total: true, amountPaid: true, currency: true, status: true },
          });
    if (!record) throw new NotFoundError(kind === 'ORDER' ? 'Order' : 'Invoice');
    if (record.status === 'CANCELLED' || record.status === 'VOID') {
      throw new ForbiddenError('This record is no longer payable.');
    }

    const paid =
      'payments' in record
        ? record.payments.reduce((sum, p) => sum.plus(p.amount), new Prisma.Decimal(0))
        : record.amountPaid;
    const outstanding = record.total.minus(paid);
    if (!outstanding.greaterThan(0)) throw new ForbiddenError('There is nothing left to pay.');

    const existing = await prismaUnscoped.paymentLink.findFirst({
      where: {
        organizationId,
        resourceType: kind,
        resourceId: record.id,
        status: { in: ['PENDING', 'PARTIALLY_PAID'] },
      },
      select: { token: true },
    });

    if (existing) {
      return {
        token: existing.token,
        amount: money(outstanding),
        currency: record.currency,
        description: `${kind === 'ORDER' ? 'Order' : 'Invoice'} ${record.number}`,
      };
    }

    // Reuse the payment-links service so the link behaves exactly like one the
    // business created, including settlement back onto the order/invoice.
    //
    // That service resolves the tenant from the request context, and the Super
    // App deliberately runs without one (a customer spans organisations). So we
    // open a scoped context for just this call — the same pattern the service
    // itself uses for background work — rather than weakening its tenant rules.
    const { paymentLinksService } = await import('../payments/payment-links.service');
    const { requestContext } = await import('../../shared/context');
    const outer = requestContext.get();

    const created = await requestContext.run(
      { requestId: outer?.requestId ?? 'order-center', correlationId: outer?.correlationId, organizationId },
      () =>
        paymentLinksService.create(
          {
            resourceType: kind,
            resourceId: record.id,
            customerId: link.customerId,
            amount: Number(outstanding.toFixed(2)),
            currency: record.currency,
            description: `${kind === 'ORDER' ? 'Order' : 'Invoice'} ${record.number}`,
            allowPartial: false,
          } as never,
          null,
        ),
    );

    return {
      token: created.token,
      amount: money(outstanding),
      currency: record.currency,
      description: `${kind === 'ORDER' ? 'Order' : 'Invoice'} ${record.number}`,
    };
  },

  // ---- Booking management (§7) ----

  /** Bookings and appointments the customer can act on. */
  async bookings(vhicasarId: string, organizationId: string, opts: { upcomingOnly?: boolean } = {}) {
    const link = await businessDashboard.requireLink(vhicasarId, organizationId);
    const now = new Date();

    const meetings = await prismaUnscoped.meeting.findMany({
      where: {
        customerId: link.customerId,
        ...(opts.upcomingOnly ? { startAt: { gte: now } } : {}),
      },
      orderBy: { startAt: opts.upcomingOnly ? 'asc' : 'desc' },
      take: 50,
      select: {
        id: true, title: true, description: true, status: true,
        startAt: true, endAt: true, location: true, bookingToken: true, createdAt: true,
      },
    });

    // What the customer may do depends on the business's policy and how close
    // the appointment is — decided here so the app never offers a dead button.
    const org = await prismaUnscoped.organization.findUnique({
      where: { id: organizationId },
      select: { settings: true },
    });
    const appointments = ((org?.settings as Record<string, unknown> | null)?.appointments ?? {}) as {
      allowCustomerCancel?: boolean;
      allowCustomerReschedule?: boolean;
      minNoticeHours?: number;
    };
    const allowCancel = appointments.allowCustomerCancel ?? true;
    const allowReschedule = appointments.allowCustomerReschedule ?? false;
    const noticeMs = (appointments.minNoticeHours ?? 2) * 3600_000;

    return {
      items: meetings.map((m) => {
        const inFuture = m.startAt.getTime() - now.getTime() > noticeMs;
        const open = m.status !== 'CANCELLED' && m.status !== 'COMPLETED';
        return {
          id: m.id,
          title: m.title,
          description: m.description,
          status: m.status,
          startAt: m.startAt,
          endAt: m.endAt,
          location: m.location,
          canCancel: open && inFuture && allowCancel,
          canReschedule: open && inFuture && allowReschedule,
          /** Token the public manage endpoints accept. */
          manageToken: m.bookingToken,
          createdAt: m.createdAt,
        };
      }),
    };
  },

  /** Cancel a booking, honouring the business's notice policy. */
  async cancelBooking(vhicasarId: string, organizationId: string, bookingId: string, reason?: string) {
    const link = await businessDashboard.requireLink(vhicasarId, organizationId);
    const meeting = await prismaUnscoped.meeting.findFirst({
      where: { id: bookingId, customerId: link.customerId },
    });
    if (!meeting) throw new NotFoundError('Booking');
    if (meeting.status === 'CANCELLED') return { id: meeting.id, status: 'CANCELLED' };

    const { bookings } = await import('./booking-policy');
    const policy = await bookings.policyFor(organizationId);
    if (!policy.allowCustomerCancel) {
      throw new ForbiddenError('This business asks you to contact them to cancel.');
    }
    if (meeting.startAt.getTime() - Date.now() < policy.noticeMs) {
      throw new ForbiddenError('It is too close to the appointment to cancel here — please contact the business.');
    }

    const updated = await prismaUnscoped.meeting.update({
      where: { id: meeting.id },
      data: {
        status: 'CANCELLED',
        // Meeting has no notes column — keep the reason on the description so
        // the business can see why the customer cancelled.
        description: reason
          ? `${meeting.description ?? ''}\n\nCancelled by customer: ${reason}`.trim()
          : meeting.description,
      },
    });

    const { emitEvent } = await import('../../shared/domain-events');
    await emitEvent({
      name: 'BookingCancelled',
      aggregateType: 'Meeting',
      aggregateId: meeting.id,
      payload: { customerId: link.customerId, vhicasarId, reason: reason ?? null },
      organizationId,
    });
    return { id: updated.id, status: updated.status };
  },
};