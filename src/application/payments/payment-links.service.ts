import { randomBytes } from 'crypto';
import { z } from 'zod';
import QRCode from 'qrcode';
import type { ChannelType } from '@prisma/client';
import { prisma, prismaUnscoped } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { env } from '../../shared/config/env';
import { logger } from '../../shared/logger';
import { NotFoundError, ValidationError } from '../../shared/errors';
import { getActivePaymentProvider, type PaymentProvider } from '../../infrastructure/payments';
import { notifyService } from '../notifications/notify.service';
import { orderNotifyService } from '../notifications/order-notify.service';
import { messagingService } from '../messaging/messaging.service';
import { resolveOrgProvider } from './org-account.service';

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Pick the gateway that should handle a customer collection: the tenant's own
 * connected account when present (#13), otherwise the platform provider.
 * `prefer` pins the choice at verify time to whatever initiated the charge.
 */
async function providerFor(
  organizationId: string,
  prefer: 'org' | 'platform' | 'auto' = 'auto',
): Promise<{ provider: PaymentProvider; account: 'org' | 'platform' }> {
  if (prefer !== 'platform') {
    const org = await resolveOrgProvider(organizationId);
    if (org) return { provider: org, account: 'org' };
    if (prefer === 'org') {
      // Charge was created on the org account but it's no longer resolvable;
      // fall through to platform as a best-effort verify.
      logger.warn({ organizationId }, 'org payment account unavailable at verify; using platform');
    }
  }
  return { provider: getActivePaymentProvider(), account: 'platform' };
}

function orgId(): string {
  const id = requestContext.get()?.organizationId;
  if (!id) throw new Error('No tenant in request context');
  return id;
}

function genToken(): string {
  return randomBytes(18).toString('base64url');
}

function publicUrl(token: string): string {
  return `${env.WEB_APP_URL.replace(/\/+$/, '')}/pay/${token}`;
}

export const PAYMENT_LINK_RESOURCES = [
  'ORDER',
  'INVOICE',
  'PROPERTY_PURCHASE',
  'PROPERTY_RESERVATION',
  'BOOKING',
  'QUOTATION',
  'SUBSCRIPTION',
  'DEPOSIT',
  'CUSTOM',
] as const;

/** Channels a payment link can be shared through. COPY just returns the URL. */
export const SHARE_CHANNELS = ['EMAIL', 'SMS', 'WHATSAPP', 'WEB_CHAT', 'COPY'] as const;
export type ShareChannel = (typeof SHARE_CHANNELS)[number];

export const sharePaymentLinkSchema = z.object({
  channel: z.enum(SHARE_CHANNELS),
  /** Optional custom note prepended to the link message. */
  message: z.string().trim().max(500).optional(),
});
export type SharePaymentLinkDto = z.infer<typeof sharePaymentLinkSchema>;

export const createPaymentLinkSchema = z.object({
  resourceType: z.enum(PAYMENT_LINK_RESOURCES),
  resourceId: z.string().min(1).optional(),
  customerId: z.string().min(1).optional(),
  /** Optional — derived from the resource (order/invoice) when omitted. */
  amount: z.coerce.number().positive().optional(),
  currency: z.string().trim().length(3).toUpperCase().optional(),
  description: z.string().trim().max(300).optional(),
  allowPartial: z.boolean().optional().default(false),
  expiresAt: z.string().datetime().optional(),
});
export type CreatePaymentLinkDto = z.infer<typeof createPaymentLinkSchema>;

/** Derive amount/currency/customer/description from the linked resource. */
async function deriveFromResource(
  dto: CreatePaymentLinkDto,
): Promise<{ amount?: number; currency?: string; customerId?: string; description?: string }> {
  if (dto.resourceType === 'ORDER' && dto.resourceId) {
    const o = await prisma.order.findFirst({
      where: { id: dto.resourceId },
      select: { total: true, currency: true, customerId: true, number: true },
    });
    if (o) {
      return {
        amount: Number(o.total),
        currency: o.currency,
        customerId: o.customerId,
        description: `Order ${o.number}`,
      };
    }
  }
  if (dto.resourceType === 'INVOICE' && dto.resourceId) {
    const inv = await prisma.invoice.findFirst({
      where: { id: dto.resourceId },
      select: { total: true, amountPaid: true, currency: true, customerId: true, number: true },
    });
    if (inv) {
      const outstanding = round2(Number(inv.total) - Number(inv.amountPaid));
      return {
        amount: outstanding > 0 ? outstanding : Number(inv.total),
        currency: inv.currency,
        customerId: inv.customerId ?? undefined,
        description: `Invoice ${inv.number}`,
      };
    }
  }
  return {};
}

function shape<T extends { token: string; amount: unknown; amountPaid: unknown }>(link: T) {
  return {
    ...link,
    amount: Number(link.amount),
    amountPaid: Number(link.amountPaid),
    url: publicUrl(link.token),
  };
}

export const paymentLinksService = {
  // ---------------------------------------------------------------- authed

  async create(dto: CreatePaymentLinkDto, createdById: string | null) {
    const derived = await deriveFromResource(dto);
    const amount = dto.amount ?? derived.amount ?? 0;
    if (!amount || amount <= 0) {
      throw new ValidationError('A positive amount is required (or link a resource that has one)');
    }
    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: orgId() },
      select: { currency: true },
    });
    const currency = (dto.currency ?? derived.currency ?? org.currency).toUpperCase();

    const link = await prisma.paymentLink.create({
      data: {
        // The tenant extension injects this at runtime; set it explicitly so the
        // create also satisfies the Prisma types (matches the rest of the codebase).
        organizationId: orgId(),
        resourceType: dto.resourceType,
        resourceId: dto.resourceId ?? null,
        customerId: dto.customerId ?? derived.customerId ?? null,
        token: genToken(),
        amount: round2(amount),
        currency,
        description: dto.description ?? derived.description ?? null,
        allowPartial: dto.allowPartial ?? false,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
        createdById: createdById ?? null,
      },
    });
    return shape(link);
  },

  async list(filter: { resourceType?: string; resourceId?: string; status?: string; customerId?: string }) {
    const links = await prisma.paymentLink.findMany({
      where: {
        ...(filter.resourceType ? { resourceType: filter.resourceType as never } : {}),
        ...(filter.resourceId ? { resourceId: filter.resourceId } : {}),
        ...(filter.status ? { status: filter.status as never } : {}),
        ...(filter.customerId ? { customerId: filter.customerId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return links.map(shape);
  },

  async get(id: string) {
    const link = await prisma.paymentLink.findFirst({ where: { id } });
    if (!link) throw new NotFoundError('Payment link');
    return shape(link);
  },

  async cancel(id: string) {
    const link = await prisma.paymentLink.findFirst({ where: { id } });
    if (!link) throw new NotFoundError('Payment link');
    if (link.status === 'PAID') throw new ValidationError('A paid link cannot be cancelled');
    const updated = await prisma.paymentLink.update({
      where: { id },
      data: { status: 'CANCELLED' },
    });
    return shape(updated);
  },

  // ---------------------------------------------------------------- public

  /** Browser-safe view for the /pay/<token> page (no tenant context). */
  async publicView(token: string) {
    const link = await prismaUnscoped.paymentLink.findUnique({ where: { token } });
    if (!link) throw new NotFoundError('Payment link');
    const org = await prismaUnscoped.organization.findUnique({
      where: { id: link.organizationId },
      select: { name: true },
    });
    const { provider } = await providerFor(link.organizationId);
    const expired = !!link.expiresAt && link.expiresAt.getTime() < Date.now();
    const outstanding = round2(Number(link.amount) - Number(link.amountPaid));
    const effectiveStatus = expired && link.status === 'PENDING' ? 'EXPIRED' : link.status;

    return {
      token: link.token,
      businessName: org?.name ?? 'Vhicasar Hub AI',
      description: link.description,
      amount: Number(link.amount),
      amountPaid: Number(link.amountPaid),
      outstanding,
      currency: link.currency,
      status: effectiveStatus,
      allowPartial: link.allowPartial,
      expiresAt: link.expiresAt,
      payable: !expired && effectiveStatus !== 'PAID' && effectiveStatus !== 'CANCELLED' && outstanding > 0,
      onlineEnabled: provider.enabled,
    };
  },

  /** Start a gateway checkout for the link; returns the authorization URL. */
  async initiate(token: string, input: { email: string; amount?: number }) {
    const link = await prismaUnscoped.paymentLink.findUnique({ where: { token } });
    if (!link) throw new NotFoundError('Payment link');
    if (link.status === 'CANCELLED') throw new ValidationError('This payment link was cancelled');
    if (link.status === 'PAID') throw new ValidationError('This payment link is already paid');
    if (link.expiresAt && link.expiresAt.getTime() < Date.now()) {
      throw new ValidationError('This payment link has expired');
    }

    const { provider, account } = await providerFor(link.organizationId);
    if (!provider.enabled) throw new ValidationError('Online payments are not configured');

    const outstanding = round2(Number(link.amount) - Number(link.amountPaid));
    let payAmount = outstanding;
    if (link.allowPartial && input.amount && input.amount > 0) {
      payAmount = Math.min(round2(input.amount), outstanding);
    }
    if (payAmount <= 0) throw new ValidationError('Nothing left to pay on this link');

    const reference = `plink_${link.id.slice(0, 8)}_${Date.now().toString(36)}`;
    const init = await provider.initializeTransaction({
      email: input.email,
      amount: Math.round(payAmount * 100), // smallest unit
      reference,
      currency: link.currency,
      callbackUrl: `${publicUrl(token)}?reference=${reference}`,
      metadata: { kind: 'payment_link', paymentLinkId: link.id, token, organizationId: link.organizationId },
    });
    await prismaUnscoped.paymentLink.update({
      where: { id: link.id },
      data: {
        provider: provider.name,
        providerRef: reference,
        // Remember which account initiated so verify hits the same gateway.
        metadata: { ...((link.metadata as Record<string, unknown>) ?? {}), account },
      },
    });
    return { authorizationUrl: init.authorizationUrl, reference };
  },

  /**
   * Verify a gateway reference and settle the link: records the payment,
   * updates the link + its linked order/invoice, notifies staff and audits.
   * Idempotent — a reference already recorded just returns the current view.
   */
  async verify(token: string, reference: string) {
    const link = await prismaUnscoped.paymentLink.findUnique({ where: { token } });
    if (!link) throw new NotFoundError('Payment link');

    const already = await prismaUnscoped.payment.findFirst({ where: { providerRef: reference } });
    if (already) return this.publicView(token);

    const usedAccount =
      ((link.metadata as Record<string, unknown>) ?? {}).account === 'org' ? 'org' : 'platform';
    const { provider } = await providerFor(link.organizationId, usedAccount);
    const txn = await provider.verifyTransaction(reference);
    if (txn.status !== 'success') return this.publicView(token);

    const paid = round2(txn.amount / 100);
    const currency = (txn.currency || link.currency).toUpperCase();
    // Receipt number, generated on confirmation and carried on the payment so
    // the /pay receipt view and any resends resolve to the same document.
    const receiptNumber = `RCPT-${new Date().getFullYear()}-${randomBytes(4).toString('hex').toUpperCase()}`;

    const payment = await prismaUnscoped.payment.create({
      data: {
        organizationId: link.organizationId,
        customerId: link.customerId,
        orderId: link.resourceType === 'ORDER' ? link.resourceId : null,
        invoiceId: link.resourceType === 'INVOICE' ? link.resourceId : null,
        method: 'ONLINE_GATEWAY',
        status: 'PAID',
        amount: paid,
        currency,
        provider: provider.name,
        providerRef: reference,
        paidAt: new Date(),
        metadata: { paymentLinkId: link.id, token, receiptNumber },
      },
    });

    const newPaid = round2(Number(link.amountPaid) + paid);
    const fullyPaid = newPaid >= Number(link.amount) - 0.005;
    await prismaUnscoped.paymentLink.update({
      where: { id: link.id },
      data: {
        amountPaid: newPaid,
        status: fullyPaid ? 'PAID' : 'PARTIALLY_PAID',
        paidAt: fullyPaid ? new Date() : link.paidAt,
      },
    });

    await this.settleResource(link.resourceType, link.resourceId).catch((err) =>
      logger.warn({ err: (err as Error).message, token }, 'payment link resource settle failed'),
    );

    // Best-effort side effects (never fail the payment confirmation).
    void orderNotifyService
      .notify(link.organizationId, 'payment.received', {
        title: link.description ?? 'Payment link',
        lines: [`Amount: ${currency} ${paid.toFixed(2)}`, fullyPaid ? 'Fully paid.' : 'Partial payment.'],
      })
      .catch(() => undefined);
    void notifyService
      .notifyStaff(link.organizationId, {
        type: 'payment.received',
        title: 'Payment received',
        body: `${currency} ${paid.toFixed(2)} via payment link`,
        data: { paymentLinkId: link.id, resourceType: link.resourceType, resourceId: link.resourceId ?? '' },
      })
      .catch(() => undefined);
    await prismaUnscoped.auditLog
      .create({
        data: {
          organizationId: link.organizationId,
          actorType: 'SYSTEM',
          action: 'payment_link.paid',
          entityType: 'PAYMENT_LINK',
          entityId: link.id,
          after: { amount: paid, currency, fullyPaid, receiptNumber },
        },
      })
      .catch(() => undefined);

    // CRM customer timeline entry so the payment shows on the contact record.
    if (link.customerId) {
      await prismaUnscoped.activity
        .create({
          data: {
            organizationId: link.organizationId,
            type: 'SYSTEM',
            entityType: 'CUSTOMER',
            entityId: link.customerId,
            title: `Payment received — ${currency} ${paid.toFixed(2)}`,
            body: `${link.description ?? 'Payment link'} • Receipt ${receiptNumber}${fullyPaid ? ' • Fully paid' : ' • Partial payment'}`,
            metadata: { paymentLinkId: link.id, paymentId: payment.id, receiptNumber, reference },
          },
        })
        .catch(() => undefined);
    }

    // Auto-send confirmation + receipt to the customer through configured
    // channels, when the business has opted in (#3).
    void this.autoSendReceipt(link.organizationId, link.customerId, {
      businessName: '',
      receiptNumber,
      amount: paid,
      currency,
      description: link.description ?? 'Payment',
      token,
    }).catch(() => undefined);

    return this.publicView(token);
  },

  /**
   * Best-effort: when the org enables auto-receipts, message the customer a
   * payment confirmation + receipt link on every configured channel that has an
   * address on file. Gated by `settings.paymentLinks.autoSendReceipt`.
   */
  async autoSendReceipt(
    organizationId: string,
    customerId: string | null,
    receipt: { businessName: string; receiptNumber: string; amount: number; currency: string; description: string; token: string },
  ): Promise<void> {
    if (!customerId) return;
    const org = await prismaUnscoped.organization.findUnique({
      where: { id: organizationId },
      select: { settings: true, name: true },
    });
    const settings = (org?.settings as Record<string, unknown>) ?? {};
    const cfg = (settings.paymentLinks as Record<string, unknown>) ?? {};
    if (cfg.autoSendReceipt !== true) return;

    const receiptUrl = `${publicUrl(receipt.token)}/receipt`;
    const text =
      `Payment confirmed — ${receipt.currency} ${receipt.amount.toFixed(2)} for ${receipt.description}.\n` +
      `Receipt ${receipt.receiptNumber}: ${receiptUrl}\n— ${org?.name ?? 'Vhicasar Hub AI'}`;
    // Only channels that make sense for a receipt; each is a no-op if the
    // customer has no address there or the channel isn't connected.
    const channels: ChannelType[] = ['EMAIL', 'WHATSAPP', 'SMS'];
    await requestContext.run({ requestId: genToken(), organizationId }, async () => {
      for (const channel of channels) {
        await messagingService
          .sendToCustomer(customerId, channel, text, { subject: `Receipt ${receipt.receiptNumber}` })
          .catch(() => undefined);
      }
    });
  },

  /** Reflect a link payment onto its linked invoice/order (unscoped). */
  async settleResource(resourceType: string, resourceId: string | null): Promise<void> {
    if (!resourceId) return;

    if (resourceType === 'INVOICE') {
      const inv = await prismaUnscoped.invoice.findUnique({
        where: { id: resourceId },
        select: { total: true, organizationId: true },
      });
      if (!inv) return;
      const agg = await prismaUnscoped.payment.aggregate({
        where: { invoiceId: resourceId, status: 'PAID' },
        _sum: { amount: true },
      });
      const paid = round2(Number(agg._sum.amount ?? 0));
      const full = paid >= Number(inv.total) - 0.005;
      const invoice = await prismaUnscoped.invoice.findUnique({ where: { id: resourceId }, select: { status: true, number: true, currency: true } });
      await prismaUnscoped.invoice.update({
        where: { id: resourceId },
        data: {
          amountPaid: paid,
          status: full ? 'PAID' : 'PARTIALLY_PAID',
          ...(full ? { paidAt: new Date() } : {}),
        },
      });
      // Notify configured recipients the first time it becomes fully paid, and
      // roll the payment up to any linked deal (#10).
      if (full && invoice && invoice.status !== 'PAID') {
        void orderNotifyService.notify(inv.organizationId, 'invoice.paid', {
          title: `Invoice ${invoice.number} paid`,
          lines: [`Amount: ${invoice.currency} ${paid.toFixed(2)}`],
        });
        const { invoicesService } = await import('../invoices/invoices.service');
        await invoicesService.settleDealForInvoice(resourceId).catch(() => undefined);
      }
    }

    if (resourceType === 'ORDER') {
      const order = await prismaUnscoped.order.findUnique({
        where: { id: resourceId },
        select: { total: true },
      });
      if (!order) return;
      const agg = await prismaUnscoped.payment.aggregate({
        where: { orderId: resourceId, status: 'PAID' },
        _sum: { amount: true },
      });
      const paid = round2(Number(agg._sum.amount ?? 0));
      const full = paid >= Number(order.total) - 0.005;
      await prismaUnscoped.order.update({
        where: { id: resourceId },
        data: { paymentStatus: full ? 'PAID' : 'PARTIALLY_PAID' },
      });
    }
  },

  // ---------------------------------------------------------------- QR / share

  /** A QR code PNG (data URL) that encodes the public pay URL. */
  async qrDataUrl(token: string): Promise<string> {
    const link = await prismaUnscoped.paymentLink.findUnique({ where: { token }, select: { id: true } });
    if (!link) throw new NotFoundError('Payment link');
    return QRCode.toDataURL(publicUrl(token), { margin: 1, width: 320 });
  },

  /**
   * Share a link with its customer over a channel. EMAIL/SMS/WHATSAPP/WEB_CHAT
   * deliver through the org's connected channel; COPY just returns the URL for
   * the client to copy. Authenticated (tenant-scoped).
   */
  async share(id: string, dto: SharePaymentLinkDto) {
    const link = await prisma.paymentLink.findFirst({ where: { id } });
    if (!link) throw new NotFoundError('Payment link');
    const url = publicUrl(link.token);
    if (dto.channel === 'COPY') return { channel: dto.channel, url, sent: false };
    if (!link.customerId) {
      throw new ValidationError('This link has no linked customer to send to; use Copy Link instead');
    }
    const amount = round2(Number(link.amount) - Number(link.amountPaid));
    const text =
      `${dto.message ? dto.message + '\n\n' : ''}` +
      `${link.description ?? 'Payment request'}: ${link.currency} ${amount.toFixed(2)}\n${url}`;
    const outcome = await messagingService.sendToCustomer(
      link.customerId,
      dto.channel as ChannelType,
      text,
      { subject: link.description ?? 'Payment request' },
    );
    return { channel: dto.channel, url, sent: outcome.ok, error: outcome.error };
  },

  /** Public receipt for a settled link — drives the printable /pay receipt view. */
  async receipt(token: string) {
    const link = await prismaUnscoped.paymentLink.findUnique({ where: { token } });
    if (!link) throw new NotFoundError('Payment link');
    const org = await prismaUnscoped.organization.findUnique({
      where: { id: link.organizationId },
      select: { name: true, email: true },
    });
    // Payments recorded for this link, newest first.
    const payments = await prismaUnscoped.payment.findMany({
      where: { organizationId: link.organizationId, status: 'PAID', metadata: { path: ['token'], equals: token } },
      orderBy: { paidAt: 'desc' },
    });
    const latest = payments[0];
    if (!latest) throw new NotFoundError('Receipt');
    const meta = (latest.metadata as Record<string, unknown>) ?? {};
    const totalPaid = round2(payments.reduce((s, p) => s + Number(p.amount), 0));
    return {
      receiptNumber: (meta.receiptNumber as string) ?? latest.id,
      businessName: org?.name ?? 'Vhicasar Hub AI',
      businessEmail: org?.email ?? null,
      description: link.description,
      currency: latest.currency,
      amount: Number(latest.amount),
      totalPaid,
      linkTotal: Number(link.amount),
      method: latest.method,
      provider: latest.provider,
      paidAt: latest.paidAt,
      payments: payments.map((p) => ({ amount: Number(p.amount), paidAt: p.paidAt, provider: p.provider })),
    };
  },
};
