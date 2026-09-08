import { Prisma, type ChannelType } from '@prisma/client';
import { z } from 'zod';
import { segmentsFor, totalSegments } from '../sms/sms-segments';
import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { AppError, NotFoundError } from '../../shared/errors';
import { env } from '../../shared/config/env';
import { logger } from '../../shared/logger';
import { getActivePaymentProvider, getChargeCurrencies } from '../../infrastructure/payments';
import { ensureFreshPaymentConfig } from './payment-config-sync';
import { notifyService } from '../notifications/notify.service';
import { randomUUID } from 'crypto';
import { exchangeRates } from '../../shared/exchange-rates';

export interface SmsPackage {
  id: string;
  name: string;
  credits: number;
  price: number;
}

export interface SmsPricing {
  currency: string;
  unitCost: number;
  channels: Record<'SMS' | 'EMAIL' | 'WHATSAPP', { enabled: boolean; unitCost: number }>;
  /** Per-route SMS prices; fall back to the SMS channel cost when unset. */
  smsTransactionalCost?: number;
  smsPromotionalCost?: number;
  /** Most recipients one send may reach. Set by the platform administrator. */
  maxCampaignSize?: number;
  lowBalanceThreshold: number;
  packages: SmsPackage[];
}

/** What one SMS segment costs on a given route. */
export function smsUnitCostFor(config: SmsPricing, route: 'TRANSACTIONAL' | 'PROMOTIONAL'): number {
  const perRoute = route === 'TRANSACTIONAL' ? config.smsTransactionalCost : config.smsPromotionalCost;
  return perRoute ?? config.channels.SMS.unitCost;
}

const DEFAULT_PRICING: SmsPricing = {
  currency: 'NGN',
  unitCost: 4,
  channels: {
    SMS: { enabled: true, unitCost: 4 },
    EMAIL: { enabled: true, unitCost: 1 },
    WHATSAPP: { enabled: true, unitCost: 6 },
  },
  lowBalanceThreshold: 500,
  packages: [
    { id: 'starter', name: 'Starter', credits: 250, price: 1000 },
    { id: 'growth', name: 'Growth', credits: 1250, price: 5000 },
    { id: 'scale', name: 'Scale', credits: 5000, price: 20000 },
  ],
};

const pricingSchema = z.object({
  currency: z.string().length(3).transform((v) => v.toUpperCase()),
  // Zero explicitly means platform-sponsored/free delivery.
  unitCost: z.coerce.number().nonnegative(),
  channels: z.object({
    SMS: z.object({ enabled: z.boolean().default(true), unitCost: z.coerce.number().nonnegative() }),
    EMAIL: z.object({ enabled: z.boolean().default(true), unitCost: z.coerce.number().nonnegative() }),
    WHATSAPP: z.object({ enabled: z.boolean().default(true), unitCost: z.coerce.number().nonnegative() }),
  }).optional(),
  /*
   * SMS is priced per route.
   *
   * Transactional traffic costs more at the provider — it takes the priority
   * route that reaches numbers on Do-Not-Disturb — so charging one blended
   * price either over-charges a business for its marketing or under-charges
   * for its order confirmations. Both fall back to the SMS unit cost, so an
   * admin who has not set them keeps today's behaviour exactly.
   */
  smsTransactionalCost: z.coerce.number().nonnegative().optional(),
  smsPromotionalCost: z.coerce.number().nonnegative().optional(),
  lowBalanceThreshold: z.coerce.number().nonnegative().default(500),
  packages: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    credits: z.coerce.number().int().positive(),
    // Accept zero so an admin can publish a fully free messaging configuration.
    price: z.coerce.number().nonnegative(),
  })).min(1),
});

let cached: { value: SmsPricing; at: number } | null = null;

/**
 * Pin the pricing, for tests.
 *
 * Pricing is synced from the admin, so a suite that reads it is really testing
 * whatever that deployment happens to be serving today — including a
 * zero-cost configuration, under which every assertion about reservations and
 * refunds silently passes for the wrong reason. Tests set what they mean.
 */
export function setPricingForTesting(value: SmsPricing | null): void {
  cached = value ? { value, at: Number.MAX_SAFE_INTEGER } : null;
}

async function pricing(): Promise<SmsPricing> {
  if (cached && Date.now() - cached.at < 60_000) return cached.value;
  try {
    const url = `${env.adminCatalog.apiUrl}/api/v1/public/${env.adminCatalog.tenantSlug}/config`;
    const res = await fetch(url);
    const json = (await res.json()) as {
      data?: { channelPricing?: unknown; sms?: unknown; smsLimits?: { maxCampaignSize?: number } };
    };
    const parsed = pricingSchema.safeParse(json.data?.channelPricing ?? json.data?.sms);
    if (res.ok && parsed.success) {
      const value: SmsPricing = {
        ...parsed.data,
        // Published separately from pricing because it is an operating limit,
        // not a price — and because it lives in a setting that also holds
        // secrets, so only this one figure crosses.
        maxCampaignSize: json.data?.smsLimits?.maxCampaignSize,
        channels: parsed.data.channels ?? {
          SMS: { enabled: true, unitCost: parsed.data.unitCost },
          EMAIL: DEFAULT_PRICING.channels.EMAIL,
          WHATSAPP: DEFAULT_PRICING.channels.WHATSAPP,
        },
      };
      cached = { value, at: Date.now() };
      return value;
    }
  } catch (err) {
    logger.warn({ err }, 'SMS pricing sync failed; using fallback pricing');
  }
  return DEFAULT_PRICING;
}

function orgId(): string {
  const id = requestContext.get()?.organizationId;
  if (!id) throw new Error('No tenant in request context');
  return id;
}

async function walletFor(organizationId: string, config: SmsPricing) {
  return prismaUnscoped.smsWallet.upsert({
    where: { organizationId },
    create: {
      organizationId,
      currency: config.currency,
      lowBalanceThreshold: config.lowBalanceThreshold,
    },
    update: {
      lowBalanceThreshold: config.lowBalanceThreshold,
    },
  });
}

export const smsWalletService = {
  pricing,

  /**
   * What a send will cost.
   *
   * `quantity` is billable units, not recipients. For SMS that means segments:
   * a 200-character message to 250 people is 500 units, and quoting it as 250
   * — which this did before `segments` existed — understated the bill by half.
   * Callers use `quoteSms` rather than working that out themselves.
   */
  async quote(
    organizationId: string,
    channelType: 'SMS' | 'EMAIL' | 'WHATSAPP',
    quantity: number,
  ) {
    const config = await pricing();
    const wallet = await walletFor(organizationId, config);
    const channel = config.channels[channelType];
    const totalCost = channel.unitCost * quantity;
    const free = channel.enabled && channel.unitCost === 0;
    return {
      channelType,
      quantity,
      enabled: channel.enabled,
      unitCost: channel.unitCost,
      totalCost,
      balance: Number(wallet.balance),
      currency: wallet.currency,
      free,
      affordable: channel.enabled && (free || Number(wallet.balance) >= totalCost),
    };
  },

  /**
   * Quote an SMS send from the actual message bodies.
   *
   * Takes the resolved bodies — after variables are substituted — because
   * "Hi Bo" and "Hi Chukwuemeka" can fall either side of a segment boundary,
   * and pricing the whole campaign off one sample recipient would be wrong for
   * everybody else.
   */
  async quoteSms(organizationId: string, bodies: string[]) {
    const segments = totalSegments(bodies);
    const base = await this.quote(organizationId, 'SMS', segments);
    const perRecipient = bodies.length
      ? segmentsFor(bodies[0]!)
      : segmentsFor('');
    return {
      ...base,
      recipients: bodies.length,
      segments,
      /** What one recipient costs, for the "1 segment" line in the composer. */
      segmentsPerMessage: perRecipient.segments,
      encoding: perRecipient.encoding,
      /**
       * Set when a single character has doubled the cost of the whole
       * campaign — worth saying out loud before somebody sends it.
       */
      forcedUnicodeBy: perRecipient.forcedUnicodeBy,
    };
  },

  /** Messages consumed and total wallet capacity for a billing-period meter. */
  async usage(organizationId: string, periodStart: Date, periodEnd: Date) {
    const config = await pricing();
    const [wallet, sends] = await Promise.all([
      walletFor(organizationId, config),
      prismaUnscoped.smsWalletTransaction.count({
        where: {
          organizationId,
          type: 'SEND',
          createdAt: { gte: periodStart, lt: periodEnd },
        },
      }),
    ]);
    const used = sends;
    const enabledCosts = Object.values(config.channels).filter((c) => c.enabled).map((c) => c.unitCost);
    const cheapest = Math.min(...enabledCosts, config.unitCost);
    // At least one free channel means credit balance does not cap total sends.
    const remaining = cheapest === 0 ? null : Math.floor(Number(wallet.balance) / cheapest);
    return { used, limit: remaining === null ? null : used + remaining };
  },

  async summary() {
    const config = await pricing();
    const organizationId = orgId();
    const [wallet, org] = await Promise.all([
      walletFor(organizationId, config),
      prismaUnscoped.organization.findUniqueOrThrow({
        where: { id: organizationId },
        select: { currency: true },
      }),
    ]);
    const transactions = await prismaUnscoped.smsWalletTransaction.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const conversion = await exchangeRates.convert(1, wallet.currency, org.currency);
    const money = (value: number) => Math.round(value * conversion.rate * 10_000) / 10_000;
    return {
      balance: money(Number(wallet.balance)),
      currency: org.currency,
      lowBalanceThreshold: money(Number(wallet.lowBalanceThreshold)),
      unitCost: money(config.channels.SMS.unitCost),
      channelCosts: Object.fromEntries(
        Object.entries(config.channels).map(([channel, value]) => [
          channel,
          { ...value, unitCost: money(value.unitCost) },
        ]),
      ),
      estimatedMessages: config.unitCost === 0
        ? null
        : Math.floor(Number(wallet.balance) / config.unitCost),
      packages: config.packages.map((p) => ({ ...p, price: money(p.price) })),
      transactions: transactions.map((t) => ({
        ...t,
        amount: money(Number(t.amount)),
        balanceAfter: money(Number(t.balanceAfter)),
        currency: org.currency,
        sourceCurrency: t.currency,
      })),
    };
  },

  /**
   * Hold the balance for a whole campaign before any of it is sent.
   *
   * A campaign is not a loop of single sends. Charging per message as it goes
   * lets a business start a 5,000-recipient campaign with credit for 400 and
   * discover the problem four hundred messages in — half-sent, and impossible
   * to explain. So the entire cost is taken up front, in one atomic decrement,
   * and what was not used is given back by `settleReservation`.
   *
   * `units` is segments, not recipients: a two-segment message to 250 people
   * reserves 500.
   */
  async reserve(params: {
    organizationId: string;
    units: number;
    campaignId?: string;
    description: string;
    /** Decides the price: the two routes cost different amounts. */
    route?: 'TRANSACTIONAL' | 'PROMOTIONAL';
  }): Promise<{ reference: string; unitCost: number; reserved: number }> {
    const config = await pricing();
    const wallet = await walletFor(params.organizationId, config);
    const channelPricing = {
      ...config.channels.SMS,
      unitCost: smsUnitCostFor(config, params.route ?? 'PROMOTIONAL'),
    };
    if (!channelPricing.enabled) {
      throw new AppError(
        'CHANNEL_DELIVERY_DISABLED',
        403,
        'SMS delivery is currently disabled by the platform administrator.',
      );
    }
    const reference = `rsv_sms_${Date.now().toString(36)}_${randomUUID()}`;
    if (channelPricing.unitCost === 0) {
      return { reference, unitCost: 0, reserved: 0 };
    }

    const amount = new Prisma.Decimal(channelPricing.unitCost).mul(params.units);
    await prismaUnscoped.$transaction(async (tx) => {
      // The balance condition lives in the WHERE clause so two campaigns
      // starting at once cannot both pass a check and then both spend.
      const updated = await tx.smsWallet.updateMany({
        where: { id: wallet.id, balance: { gte: amount } },
        data: { balance: { decrement: amount } },
      });
      if (updated.count !== 1) {
        throw new AppError(
          'INSUFFICIENT_MESSAGE_CREDITS',
          402,
          `This send needs ${params.units} SMS credits and your balance is lower. Top up to continue.`,
        );
      }
      const current = await tx.smsWallet.findUniqueOrThrow({ where: { id: wallet.id } });
      await tx.smsWalletTransaction.create({
        data: {
          organizationId: params.organizationId,
          walletId: wallet.id,
          type: 'SEND',
          channelType: 'SMS',
          amount: amount.negated(),
          balanceAfter: current.balance,
          currency: wallet.currency,
          description: params.description,
          reference,
          campaignId: params.campaignId,
          metadata: { reservedUnits: params.units },
        },
      });
    });
    return { reference, unitCost: channelPricing.unitCost, reserved: params.units };
  },

  /**
   * Give back what the send did not use.
   *
   * A campaign always reserves what it might cost; the provider then rejects
   * some numbers outright, and those segments were never charged by the
   * network. Refunding the difference is what makes the reservation honest
   * rather than a rounding-up in Vhicasar's favour.
   *
   * Written as a separate credit rather than by editing the original debit, so
   * the ledger reads as what happened: reserved 500, refunded 12.
   */
  async settleReservation(params: {
    organizationId: string;
    reference: string;
    reservedUnits: number;
    actualUnits: number;
    /** Must match the route the reservation was priced at. */
    route?: 'TRANSACTIONAL' | 'PROMOTIONAL';
  }): Promise<{ refundedUnits: number }> {
    const unused = params.reservedUnits - params.actualUnits;
    if (unused <= 0) return { refundedUnits: 0 };

    const config = await pricing();
    // Refunded at the price it was reserved at, or a transactional send would
    // be refunded at the promotional rate and quietly lose the business money.
    const unitCost = smsUnitCostFor(config, params.route ?? 'PROMOTIONAL');
    if (unitCost === 0) return { refundedUnits: 0 };
    const wallet = await walletFor(params.organizationId, config);
    const amount = new Prisma.Decimal(unitCost).mul(unused);

    await prismaUnscoped.$transaction(async (tx) => {
      // Keyed off the reservation's reference so replaying a settlement — a
      // retried job, a duplicated webhook — cannot refund twice.
      const already = await tx.smsWalletTransaction.findFirst({
        where: { organizationId: params.organizationId, reference: `${params.reference}_refund` },
        select: { id: true },
      });
      if (already) return;

      await tx.smsWallet.update({
        where: { id: wallet.id },
        data: { balance: { increment: amount } },
      });
      const current = await tx.smsWallet.findUniqueOrThrow({ where: { id: wallet.id } });
      await tx.smsWalletTransaction.create({
        data: {
          organizationId: params.organizationId,
          walletId: wallet.id,
          // ROLLBACK is the ledger's existing word for money coming back;
          // a partial refund is the same event as a failed send's refund.
          type: 'ROLLBACK',
          channelType: 'SMS',
          amount,
          balanceAfter: current.balance,
          currency: wallet.currency,
          description: `Refund for ${unused} unsent SMS credit${unused === 1 ? '' : 's'}`,
          reference: `${params.reference}_refund`,
          metadata: { reservedUnits: params.reservedUnits, actualUnits: params.actualUnits },
        },
      });
    });
    return { refundedUnits: unused };
  },

  /** Atomically reserve one configured outbound delivery before provider send. */
  async debit(params: {
    organizationId: string;
    channelType: Extract<ChannelType, 'SMS' | 'EMAIL' | 'WHATSAPP'>;
    campaignId?: string;
    customerId?: string;
  }): Promise<string> {
    const config = await pricing();
    const wallet = await walletFor(params.organizationId, config);
    if (wallet.currency !== config.currency) {
      throw new AppError('SMS_WALLET_CURRENCY_CHANGED', 409, 'SMS pricing currency changed. Contact support before sending.');
    }
    const channelPricing = config.channels[params.channelType];
    if (!channelPricing.enabled) {
      throw new AppError(
        'CHANNEL_DELIVERY_DISABLED',
        403,
        `${params.channelType} paid delivery is currently disabled by the platform administrator.`,
      );
    }
    // Free delivery bypasses the prepaid wallet entirely. The provider send
    // still runs normally; only the platform credit charge is skipped.
    if (channelPricing.unitCost === 0) {
      return `free_${params.channelType.toLowerCase()}_${Date.now().toString(36)}_${randomUUID()}`;
    }
    const reference = `msg_${params.channelType.toLowerCase()}_${Date.now().toString(36)}_${randomUUID()}`;
    const amount = new Prisma.Decimal(channelPricing.unitCost);
    const result = await prismaUnscoped.$transaction(async (tx) => {
      const updated = await tx.smsWallet.updateMany({
        where: { id: wallet.id, balance: { gte: amount } },
        data: { balance: { decrement: amount } },
      });
      if (updated.count !== 1) {
        throw new AppError('INSUFFICIENT_MESSAGE_CREDITS', 402, 'Your messaging credit balance is too low. Purchase credits to continue.');
      }
      const current = await tx.smsWallet.findUniqueOrThrow({ where: { id: wallet.id } });
      await tx.smsWalletTransaction.create({
        data: {
          organizationId: params.organizationId,
          walletId: wallet.id,
          type: 'SEND',
          channelType: params.channelType,
          amount: amount.negated(),
          balanceAfter: current.balance,
          currency: wallet.currency,
          description: `${params.channelType === 'WHATSAPP' ? 'WhatsApp' : params.channelType === 'EMAIL' ? 'Email' : 'SMS'} message`,
          reference,
          campaignId: params.campaignId,
          customerId: params.customerId,
        },
      });
      return current;
    });
    if (Number(result.balance) <= Number(result.lowBalanceThreshold)) {
      const recentlyAlerted = result.lastLowBalanceAt && Date.now() - result.lastLowBalanceAt.getTime() < 24 * 3600_000;
      if (!recentlyAlerted) {
        await prismaUnscoped.smsWallet.update({ where: { id: wallet.id }, data: { lastLowBalanceAt: new Date() } });
        await notifyService.notifyStaff(params.organizationId, {
          type: 'sms.low_balance',
          title: 'Messaging credit is running low',
          body: `${wallet.currency} ${Number(result.balance).toFixed(2)} remains. Top up to avoid interrupted sends.`,
          data: { path: '/settings/billing' },
        });
      }
    }
    return reference;
  },

  /** Restore a reservation exactly once when provider delivery fails. */
  async rollback(organizationId: string, reference: string): Promise<void> {
    await prismaUnscoped.$transaction(async (tx) => {
      const original = await tx.smsWalletTransaction.findFirst({
        where: { organizationId, reference, type: 'SEND' },
      });
      if (!original) return;
      const rollbackRef = `${reference}:rollback`;
      if (await tx.smsWalletTransaction.findFirst({ where: { organizationId, reference: rollbackRef } })) return;
      const amount = original.amount.abs();
      const wallet = await tx.smsWallet.update({
        where: { id: original.walletId },
        data: { balance: { increment: amount } },
      });
      await tx.smsWalletTransaction.create({
        data: {
          organizationId,
          walletId: original.walletId,
          type: 'ROLLBACK',
          channelType: original.channelType,
          amount,
          balanceAfter: wallet.balance,
          currency: original.currency,
          description: `Failed ${original.channelType.toLowerCase()} refund`,
          reference: rollbackRef,
          campaignId: original.campaignId,
          customerId: original.customerId,
        },
      });
    });
  },

  async checkout(packageId: string) {
    await ensureFreshPaymentConfig();
    const config = await pricing();
    const selected = config.packages.find((p) => p.id === packageId);
    if (!selected) throw new NotFoundError('SMS package');
    const provider = getActivePaymentProvider();
    if (!provider.enabled) throw new AppError('PAYMENTS_NOT_CONFIGURED', 503, 'Online payments are not configured.');
    const organizationId = orgId();
    const org = await prismaUnscoped.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { currency: true },
    });
    if (!getChargeCurrencies().includes(org.currency)) {
      throw new AppError(
        'PREFERRED_CURRENCY_NOT_SETTLEABLE',
        400,
        `Checkout in ${org.currency} is not enabled for this payment account.`,
      );
    }
    const charge = await exchangeRates.convert(selected.price, config.currency, org.currency, { forCharge: true });
    const owner = await prismaUnscoped.membership.findFirst({
      where: { organizationId, isOwner: true, isActive: true },
      include: { user: { select: { email: true } } },
    });
    if (!owner) throw new NotFoundError('Workspace owner');
    const reference = `sms_topup_${organizationId.slice(0, 8)}_${Date.now().toString(36)}`;
    const result = await provider.initializeTransaction({
      email: owner.user.email,
      amount: Math.round(charge.amount * 100),
      reference,
      currency: org.currency,
      metadata: {
        kind: 'sms_wallet',
        organizationId,
        packageId: selected.id,
        sourceAmount: selected.price,
        sourceCurrency: config.currency,
        exchangeRate: charge.rate,
        exchangeRateSnapshotId: charge.snapshotId,
      },
    });
    return {
      authorizationUrl: result.authorizationUrl,
      reference: result.reference,
      amount: charge.amount,
      currency: charge.currency,
    };
  },

  async verifyPurchase(reference: string) {
    const txn = await getActivePaymentProvider().verifyTransaction(reference);
    if (txn.status !== 'success') throw new AppError('PAYMENT_NOT_SUCCESSFUL', 400, `Payment not successful (${txn.status}).`);
    const meta = (txn.metadata ?? {}) as Record<string, unknown>;
    if (meta.kind !== 'sms_wallet') throw new AppError('INVALID_REFERENCE', 400, 'This is not an SMS wallet payment.');
    const organizationId = String(meta.organizationId ?? '');
    const config = await pricing();
    const selected = config.packages.find((p) => p.id === String(meta.packageId ?? ''));
    if (!organizationId || !selected) throw new AppError('INVALID_REFERENCE', 400, 'SMS purchase metadata is incomplete.');
    const wallet = await walletFor(organizationId, config);
    const existing = await prismaUnscoped.smsWalletTransaction.findFirst({ where: { organizationId, reference } });
    if (existing) return { credited: false, alreadyProcessed: true };
    // Packages may be discounted; wallet value represents send credit, not
    // merely the cash collected.
    const creditValue = selected.credits * config.unitCost;
    await prismaUnscoped.$transaction(async (tx) => {
      const updated = await tx.smsWallet.update({
        where: { id: wallet.id },
        data: { balance: { increment: creditValue }, lastLowBalanceAt: null },
      });
      await tx.smsWalletTransaction.create({
        data: {
          organizationId,
          walletId: wallet.id,
          type: 'PURCHASE',
          channelType: 'SMS',
          amount: creditValue,
          balanceAfter: updated.balance,
          currency: config.currency,
          description: `${selected.name} messaging credit package`,
          reference,
          metadata: { packageId: selected.id, credits: selected.credits, paid: txn.amount / 100 },
        },
      });
    });
    return { credited: true, alreadyProcessed: false };
  },
};
