import { z } from 'zod';
import type { Plan, Subscription } from '@prisma/client';
import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { env } from '../../shared/config/env';
import { logger } from '../../shared/logger';
import { AppError, NotFoundError } from '../../shared/errors';
import { paystack } from '../../infrastructure/payments/paystack';
import { toPriceBook } from '../../shared/billing-currency';
import { exchangeRates, type MoneyConversion } from '../../shared/exchange-rates';
import { resolveEntitlements, currentOrgId } from './entitlements';
import { usageService, USAGE_METRICS } from './usage.service';
import { ensureFreshPlans } from './plan-sync';
import { smsWalletService } from './sms-wallet.service';
import { addOnsService } from './add-ons.service';

export const checkoutSchema = z.object({
  planSlug: z.string().min(1),
  interval: z.enum(['MONTHLY', 'YEARLY']).default('MONTHLY'),
});
export type CheckoutDto = z.infer<typeof checkoutSchema>;

type Interval = 'MONTHLY' | 'YEARLY';

function addInterval(from: Date, interval: Interval): Date {
  const d = new Date(from);
  if (interval === 'YEARLY') d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}

function planDto(p: Plan) {
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    description: p.description,
    priceMonthly: Number(p.priceMonthly),
    priceYearly: Number(p.priceYearly),
    currency: p.currency,
    limits: {
      maxUsers: p.maxUsers,
      maxBranches: p.maxBranches,
      maxProducts: p.maxProducts,
      maxChannels: p.maxChannels,
      maxContacts: p.maxContacts,
      maxMarketingReach: p.maxMarketingReach,
      aiCreditsMonthly: p.aiCreditsMonthly,
    },
    features: Array.isArray(p.features) ? (p.features as string[]) : [],
    isPublic: p.isPublic,
    isActive: p.isActive,
    position: p.position,
  };
}

async function preferredPlanDto(p: Plan, currency: string) {
  const book = toPriceBook(p.prices);
  const exact = book[currency];
  const monthly = exact
    ? exact.monthly
    : (await exchangeRates.convert(Number(p.priceMonthly), p.currency, currency)).amount;
  const yearly = exact
    ? exact.yearly
    : (await exchangeRates.convert(Number(p.priceYearly), p.currency, currency)).amount;
  return {
    ...planDto(p),
    priceMonthly: monthly,
    priceYearly: yearly,
    currency,
    sourceCurrency: p.currency,
    converted: p.currency !== currency && !exact,
  };
}

function subscriptionDto(s: Subscription & { plan?: Plan }) {
  return {
    id: s.id,
    status: s.status,
    interval: s.interval,
    currentPeriodStart: s.currentPeriodStart,
    currentPeriodEnd: s.currentPeriodEnd,
    cancelAtPeriodEnd: s.cancelAtPeriodEnd,
    trialEndsAt: s.trialEndsAt,
    plan: s.plan ? planDto(s.plan) : undefined,
  };
}

export const billingService = {
  /** Public plan catalog (ordered), for the pricing/upgrade UI. */
  async listPlans() {
    await ensureFreshPlans(); // reflect admin pricing edits on load
    const plans = await prismaUnscoped.plan.findMany({
      where: { isActive: true },
      orderBy: { position: 'asc' },
    });
    const org = await prismaUnscoped.organization.findUniqueOrThrow({
      where: { id: currentOrgId() },
      select: { currency: true },
    });
    return Promise.all(plans.map((plan) => preferredPlanDto(plan, org.currency)));
  },

  /** Current subscription + plan + live usage/limits for the billing page. */
  async getSummary() {
    await ensureFreshPlans(); // reflect admin pricing edits on load
    const orgId = currentOrgId();
    const ent = await resolveEntitlements(orgId);

    const period = { organizationId: orgId, periodStart: ent.periodStart, periodEnd: ent.periodEnd };
    const [aiUsed, users, channels, contacts, products, smsCredits, marketingReach, plan, latestSubscription] = await Promise.all([
      usageService.get(USAGE_METRICS.AI_RESPONSE, period),
      prismaUnscoped.membership.count({ where: { organizationId: orgId, isActive: true, deletedAt: null } }),
      prismaUnscoped.channelAccount.count({ where: { organizationId: orgId } }),
      prismaUnscoped.customer.count({ where: { organizationId: orgId, deletedAt: null } }),
      prismaUnscoped.product.count({ where: { organizationId: orgId } }),
      smsWalletService.usage(orgId, ent.periodStart, ent.periodEnd),
      usageService.get(USAGE_METRICS.MARKETING_RECIPIENT, period),
      prismaUnscoped.plan.findUnique({ where: { id: ent.planId } }).catch(() => null),
      prismaUnscoped.subscription.findFirst({
        where: { organizationId: orgId },
        orderBy: { createdAt: 'desc' },
        include: { plan: true },
      }),
    ]);

    const org = await prismaUnscoped.organization.findUniqueOrThrow({
      where: { id: orgId },
      select: { currency: true },
    });
    return {
      plan: plan ? await preferredPlanDto(plan, org.currency) : { name: ent.planName, slug: ent.planSlug },
      status: ent.status,
      period: { start: ent.periodStart, end: ent.periodEnd },
      subscription: ent.subscription ? subscriptionDto(ent.subscription) : null,
      lastSubscription: !ent.subscription && latestSubscription ? subscriptionDto(latestSubscription) : null,
      features: [...ent.features],
      usage: {
        aiResponses: { used: aiUsed, limit: ent.limits.aiCreditsMonthly },
        users: { used: users, limit: ent.limits.maxUsers },
        channels: { used: channels, limit: ent.limits.maxChannels },
        contacts: { used: contacts, limit: ent.limits.maxContacts },
        products: { used: products, limit: ent.limits.maxProducts },
        smsCredits,
        marketingReach: { used: marketingReach, limit: plan?.maxMarketingReach ?? null },
      },
      paystackEnabled: env.billing.paystackEnabled,
    };
  },

  /** Billing history (paid invoices) for the current org. */
  async history() {
    const orgId = currentOrgId();
    const [records, org] = await Promise.all([
      prismaUnscoped.billingRecord.findMany({
        where: { subscription: { organizationId: orgId } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      prismaUnscoped.organization.findUniqueOrThrow({
        where: { id: orgId },
        select: { currency: true },
      }),
    ]);
    return Promise.all(records.map(async (r) => {
      const converted = await exchangeRates.convert(Number(r.amount), r.currency, org.currency);
      return {
        id: r.id,
        amount: converted.amount,
        currency: converted.currency,
        chargedAmount: Number(r.amount),
        chargedCurrency: r.currency,
        status: r.status,
        periodStart: r.periodStart,
        periodEnd: r.periodEnd,
        provider: r.provider,
        paidAt: r.paidAt,
        createdAt: r.createdAt,
      };
    }));
  },

  /**
   * Begins a plan change. Free plans activate immediately; paid plans return a
   * Paystack checkout URL. Enterprise (non-public) must contact sales.
   */
  async checkout(dto: CheckoutDto) {
    const orgId = currentOrgId();
    const plan = await prismaUnscoped.plan.findUnique({ where: { slug: dto.planSlug } });
    if (!plan || !plan.isActive) throw new NotFoundError('Plan');
    if (!plan.isPublic) {
      throw new AppError('CONTACT_SALES', 400, 'This plan is custom — please contact sales.');
    }

    const org = await prismaUnscoped.organization.findUnique({
      where: { id: orgId },
      select: { currency: true },
    });
    const preferredCurrency = org?.currency.toUpperCase() ?? plan.currency.toUpperCase();
    if (!env.billing.chargeCurrencies.includes(preferredCurrency)) {
      throw new AppError(
        'PREFERRED_CURRENCY_NOT_SETTLEABLE',
        400,
        `Checkout in ${preferredCurrency} is not enabled for this payment account. Ask an administrator to enable ${preferredCurrency} settlement or choose another preferred currency.`,
      );
    }
    const book = toPriceBook(plan.prices);
    const exact = book[preferredCurrency];
    const exactAmount = exact
      ? (dto.interval === 'YEARLY' ? exact.yearly : exact.monthly)
      : null;
    const baseAmount = dto.interval === 'YEARLY' ? Number(plan.priceYearly) : Number(plan.priceMonthly);
    const charge: MoneyConversion = exactAmount !== null
      ? {
          amount: exactAmount,
          currency: preferredCurrency,
          sourceAmount: exactAmount,
          sourceCurrency: preferredCurrency,
          rate: 1,
          snapshotId: null,
          asOf: new Date(),
        }
      : await exchangeRates.convert(baseAmount, plan.currency, preferredCurrency, { forCharge: true });
    const price = charge.amount;

    // Free plan → activate right away, no payment.
    if (price <= 0) {
      const sub = await this.activate({ orgId, planId: plan.id, interval: dto.interval, amount: 0 });
      return { type: 'activated' as const, subscription: subscriptionDto(sub) };
    }

    if (!paystack.enabled) {
      throw new AppError(
        'PAYSTACK_NOT_CONFIGURED',
        503,
        'Online payments are not configured. Contact the administrator to enable checkout.'
      );
    }

    const email = await this.billingEmail(orgId);
    const reference = `bh_${orgId.slice(0, 8)}_${Date.now().toString(36)}`;
    const init = await paystack.initializeTransaction({
      email,
      // Paystack takes the smallest unit (kobo, cents, pesewas).
      amount: Math.round(price * 100),
      reference,
      currency: charge.currency,
      metadata: {
        organizationId: orgId,
        planId: plan.id,
        interval: dto.interval,
        kind: 'subscription',
        chargeCurrency: charge.currency,
        sourceAmount: charge.sourceAmount,
        sourceCurrency: charge.sourceCurrency,
        exchangeRate: charge.rate,
        exchangeRateSnapshotId: charge.snapshotId,
        exchangeRateAsOf: charge.asOf.toISOString(),
      },
    });

    return {
      type: 'checkout' as const,
      authorizationUrl: init.authorizationUrl,
      reference: init.reference,
      // So the UI can say "charged in USD" before the customer is surprised.
      amount: price,
      currency: charge.currency,
    };
  },

  /**
   * Verifies a Paystack reference and activates the subscription. Idempotent —
   * safe to call from both the browser callback and the webhook.
   */
  async verifyReference(reference: string) {
    // Already processed?
    const existing = await prismaUnscoped.billingRecord.findFirst({ where: { providerRef: reference } });
    if (existing) return { activated: true, alreadyProcessed: true };

    const txn = await paystack.verifyTransaction(reference);
    if (txn.status !== 'success') {
      throw new AppError('PAYMENT_NOT_SUCCESSFUL', 400, `Payment not successful (${txn.status}).`);
    }

    const meta = (txn.metadata ?? {}) as Record<string, unknown>;
    if (meta.kind === 'sms_wallet') {
      return smsWalletService.verifyPurchase(reference);
    }
    if (meta.kind === 'add_on') {
      return addOnsService.verify(reference);
    }
    const organizationId = String(meta.organizationId ?? '');
    const planId = String(meta.planId ?? '');
    const interval = (meta.interval === 'YEARLY' ? 'YEARLY' : 'MONTHLY') as Interval;
    if (!organizationId || !planId) {
      throw new AppError('INVALID_REFERENCE', 400, 'Payment metadata is incomplete.');
    }

    await this.activate({
      orgId: organizationId,
      planId,
      interval,
      amount: txn.amount / 100,
      providerRef: reference,
      providerCustomerCode: txn.customerCode,
      currency: txn.currency,
      sourceAmount: Number(meta.sourceAmount ?? txn.amount / 100),
      sourceCurrency: String(meta.sourceCurrency ?? txn.currency),
      exchangeRate: Number(meta.exchangeRate ?? 1),
      exchangeRateSnapshotId: meta.exchangeRateSnapshotId ? String(meta.exchangeRateSnapshotId) : null,
    });
    return { activated: true, alreadyProcessed: false };
  },

  /** Handles a verified Paystack webhook event. */
  async handleWebhookEvent(event: { event: string; data?: { reference?: string } }) {
    if (event.event === 'charge.success' && event.data?.reference) {
      try {
        await this.verifyReference(event.data.reference);
      } catch (err) {
        logger.error({ err, reference: event.data.reference }, 'Failed to process Paystack webhook');
      }
    }
  },

  /** Schedules cancellation at period end (org falls back to free plan after). */
  async cancel() {
    const orgId = currentOrgId();
    const sub = await prismaUnscoped.subscription.findFirst({
      where: { organizationId: orgId, status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (!sub) throw new NotFoundError('Active subscription');
    const updated = await prismaUnscoped.subscription.update({
      where: { id: sub.id },
      data: { cancelAtPeriodEnd: true, cancelledAt: new Date() },
      include: { plan: true },
    });
    return subscriptionDto(updated);
  },

  /** Reverts a scheduled cancellation. */
  async resume() {
    const orgId = currentOrgId();
    const sub = await prismaUnscoped.subscription.findFirst({
      where: { organizationId: orgId, cancelAtPeriodEnd: true },
      orderBy: { createdAt: 'desc' },
    });
    if (!sub) throw new NotFoundError('Cancelling subscription');
    const updated = await prismaUnscoped.subscription.update({
      where: { id: sub.id },
      data: { cancelAtPeriodEnd: false, cancelledAt: null },
      include: { plan: true },
    });
    return subscriptionDto(updated);
  },

  // ---- internals ---------------------------------------------------------

  /** Creates or updates the org's single subscription and records payment. */
  async activate(params: {
    orgId: string;
    planId: string;
    interval: Interval;
    amount: number;
    providerRef?: string;
    providerCustomerCode?: string | null;
    currency?: string;
    sourceAmount?: number;
    sourceCurrency?: string;
    exchangeRate?: number;
    exchangeRateSnapshotId?: string | null;
  }): Promise<Subscription & { plan: Plan }> {
    const now = new Date();
    const end = addInterval(now, params.interval);

    const existing = await prismaUnscoped.subscription.findFirst({
      where: { organizationId: params.orgId },
      orderBy: { createdAt: 'desc' },
    });

    const data = {
      planId: params.planId,
      interval: params.interval,
      status: 'ACTIVE' as const,
      currentPeriodStart: now,
      currentPeriodEnd: end,
      cancelAtPeriodEnd: false,
      cancelledAt: null,
      ...(params.amount > 0 ? { provider: 'paystack' } : {}),
      ...(params.providerCustomerCode ? { providerCustomerCode: params.providerCustomerCode } : {}),
    };

    const sub = existing
      ? await prismaUnscoped.subscription.update({
          where: { id: existing.id },
          data,
          include: { plan: true },
        })
      : await prismaUnscoped.subscription.create({
          data: { organizationId: params.orgId, ...data },
          include: { plan: true },
        });

    if (params.amount > 0 && params.providerRef) {
      const dup = await prismaUnscoped.billingRecord.findFirst({
        where: { providerRef: params.providerRef },
      });
      if (!dup) {
        await prismaUnscoped.billingRecord.create({
          data: {
            subscriptionId: sub.id,
            amount: params.amount,
            currency: params.currency ?? sub.plan.currency,
            sourceAmount: params.sourceAmount,
            sourceCurrency: params.sourceCurrency,
            exchangeRate: params.exchangeRate,
            exchangeRateSnapshotId: params.exchangeRateSnapshotId,
            status: 'PAID',
            periodStart: now,
            periodEnd: end,
            provider: 'paystack',
            providerRef: params.providerRef,
            paidAt: now,
          },
        });
      }
    }

    logger.info({ orgId: params.orgId, planId: params.planId }, 'Subscription activated');
    return sub;
  },

  /** Billing contact email: the organization owner's, else the organization's. */
  async billingEmail(orgId: string): Promise<string> {
    const membership = await prismaUnscoped.membership.findFirst({
      where: { organizationId: orgId, isOwner: true, isActive: true },
      include: { user: { select: { email: true } } },
    });
    if (membership?.user?.email) return membership.user.email;
    const org = await prismaUnscoped.organization.findUnique({
      where: { id: orgId },
      select: { email: true },
    });
    if (org?.email) return org.email;
    throw new AppError('NO_BILLING_EMAIL', 400, 'No billing email found for this organization.');
  },
};
