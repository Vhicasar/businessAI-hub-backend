import { Prisma, type ChannelType } from '@prisma/client';
import { z } from 'zod';
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
  lowBalanceThreshold: number;
  packages: SmsPackage[];
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
  unitCost: z.coerce.number().positive(),
  channels: z.object({
    SMS: z.object({ enabled: z.boolean().default(true), unitCost: z.coerce.number().positive() }),
    EMAIL: z.object({ enabled: z.boolean().default(true), unitCost: z.coerce.number().positive() }),
    WHATSAPP: z.object({ enabled: z.boolean().default(true), unitCost: z.coerce.number().positive() }),
  }).optional(),
  lowBalanceThreshold: z.coerce.number().nonnegative().default(500),
  packages: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    credits: z.coerce.number().int().positive(),
    price: z.coerce.number().positive(),
  })).min(1),
});

let cached: { value: SmsPricing; at: number } | null = null;

async function pricing(): Promise<SmsPricing> {
  if (cached && Date.now() - cached.at < 60_000) return cached.value;
  try {
    const url = `${env.adminCatalog.apiUrl}/api/v1/public/${env.adminCatalog.tenantSlug}/config`;
    const res = await fetch(url);
    const json = (await res.json()) as { data?: { channelPricing?: unknown; sms?: unknown } };
    const parsed = pricingSchema.safeParse(json.data?.channelPricing ?? json.data?.sms);
    if (res.ok && parsed.success) {
      const value: SmsPricing = {
        ...parsed.data,
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

  async quote(
    organizationId: string,
    channelType: 'SMS' | 'EMAIL' | 'WHATSAPP',
    quantity: number,
  ) {
    const config = await pricing();
    const wallet = await walletFor(organizationId, config);
    const channel = config.channels[channelType];
    return {
      channelType,
      quantity,
      enabled: channel.enabled,
      unitCost: channel.unitCost,
      totalCost: channel.unitCost * quantity,
      balance: Number(wallet.balance),
      currency: wallet.currency,
      affordable: channel.enabled && Number(wallet.balance) >= channel.unitCost * quantity,
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
    const remaining = Math.floor(Number(wallet.balance) / cheapest);
    return { used, limit: used + remaining };
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
      estimatedMessages: Math.floor(Number(wallet.balance) / config.unitCost),
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
