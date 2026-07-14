import { z } from 'zod';
import type { Plan, Subscription } from '@prisma/client';
import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { env } from '../../shared/config/env';
import { logger } from '../../shared/logger';
import { AppError, NotFoundError } from '../../shared/errors';
import { paystack } from '../../infrastructure/payments/paystack';
import { resolveEntitlements, currentOrgId } from './entitlements';
import { usageService, USAGE_METRICS } from './usage.service';
import { ensureFreshPlans } from './plan-sync';

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
      aiCreditsMonthly: p.aiCreditsMonthly,
    },
    features: Array.isArray(p.features) ? (p.features as string[]) : [],
    isPublic: p.isPublic,
    isActive: p.isActive,
    position: p.position,
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
    return plans.map(planDto);
  },

  /** Current subscription + plan + live usage/limits for the billing page. */
  async getSummary() {
    await ensureFreshPlans(); // reflect admin pricing edits on load
    const orgId = currentOrgId();
    const ent = await resolveEntitlements(orgId);

    const period = { organizationId: orgId, periodStart: ent.periodStart, periodEnd: ent.periodEnd };
    const [aiUsed, users, channels, contacts, products, branches, plan] = await Promise.all([
      usageService.get(USAGE_METRICS.AI_RESPONSE, period),
      prismaUnscoped.membership.count({ where: { organizationId: orgId, isActive: true, deletedAt: null } }),
      prismaUnscoped.channelAccount.count({ where: { organizationId: orgId } }),
      prismaUnscoped.customer.count({ where: { organizationId: orgId, deletedAt: null } }),
      prismaUnscoped.product.count({ where: { organizationId: orgId } }),
      prismaUnscoped.branch.count({ where: { organizationId: orgId } }),
      prismaUnscoped.plan.findUnique({ where: { id: ent.planId } }).catch(() => null),
    ]);

    return {
      plan: plan ? planDto(plan) : { name: ent.planName, slug: ent.planSlug },
      status: ent.status,
      period: { start: ent.periodStart, end: ent.periodEnd },
      subscription: ent.subscription ? subscriptionDto(ent.subscription) : null,
      features: [...ent.features],
      usage: {
        aiResponses: { used: aiUsed, limit: ent.limits.aiCreditsMonthly },
        users: { used: users, limit: ent.limits.maxUsers },
        channels: { used: channels, limit: ent.limits.maxChannels },
        contacts: { used: contacts, limit: ent.limits.maxContacts },
        products: { used: products, limit: ent.limits.maxProducts },
        branches: { used: branches, limit: ent.limits.maxBranches },
      },
      paystackEnabled: env.billing.paystackEnabled,
    };
  },

  /** Billing history (paid invoices) for the current org. */
  async history() {
    const orgId = currentOrgId();
    const records = await prismaUnscoped.billingRecord.findMany({
      where: { subscription: { organizationId: orgId } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return records.map((r) => ({
      id: r.id,
      amount: Number(r.amount),
      currency: r.currency,
      status: r.status,
      periodStart: r.periodStart,
      periodEnd: r.periodEnd,
      provider: r.provider,
      paidAt: r.paidAt,
      createdAt: r.createdAt,
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

    const price = Number(dto.interval === 'YEARLY' ? plan.priceYearly : plan.priceMonthly);

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
      amount: Math.round(price * 100), // kobo
      reference,
      currency: plan.currency,
      metadata: { organizationId: orgId, planId: plan.id, interval: dto.interval, kind: 'subscription' },
    });

    return {
      type: 'checkout' as const,
      authorizationUrl: init.authorizationUrl,
      reference: init.reference,
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
            currency: sub.plan.currency,
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
