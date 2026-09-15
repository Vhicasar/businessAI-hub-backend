import { prismaUnscoped } from '../../infrastructure/database/prisma';
import type { Entitlements } from './entitlements';
import { resolveEntitlements } from './entitlements';
import { logger } from '../../shared/logger';

export const SUBSCRIPTION_DRAFT_REASON = 'Subscription payment failed and the workspace is above its current plan limit.';

/** Reversible overflow classification. Oldest records retain active capacity. */
export async function reconcileSubscriptionDrafts(ent: Entitlements): Promise<void> {
  const customerDrafts = await prismaUnscoped.customer.findMany({ where: { organizationId: ent.organizationId, subscriptionDraftAt: { not: null } }, select: { id: true, subscriptionDraftPreviousBlocked: true } });
  const productDrafts = await prismaUnscoped.product.findMany({ where: { organizationId: ent.organizationId, subscriptionDraftAt: { not: null } }, select: { id: true, subscriptionDraftPreviousStatus: true } });
  if (!ent.accessRestriction) {
    for (const row of customerDrafts) await prismaUnscoped.customer.update({ where: { id: row.id }, data: { isBlocked: row.subscriptionDraftPreviousBlocked ?? false, subscriptionDraftAt: null, subscriptionDraftReason: null, subscriptionDraftPreviousBlocked: null } });
    for (const row of productDrafts) await prismaUnscoped.product.update({ where: { id: row.id }, data: { status: row.subscriptionDraftPreviousStatus ?? 'ACTIVE', subscriptionDraftAt: null, subscriptionDraftReason: null, subscriptionDraftPreviousStatus: null } });
    return;
  }
  const customers = await prismaUnscoped.customer.findMany({ where: { organizationId: ent.organizationId, deletedAt: null }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, isBlocked: true, subscriptionDraftAt: true } });
  const products = await prismaUnscoped.product.findMany({ where: { organizationId: ent.organizationId, deletedAt: null }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, status: true, subscriptionDraftAt: true } });
  const customerOverflow = customers.slice(ent.limits.maxContacts ?? customers.length);
  const productOverflow = products.slice(ent.limits.maxProducts ?? products.length);
  for (const row of customers.slice(0, ent.limits.maxContacts ?? customers.length)) if (row.subscriptionDraftAt) {
    const prior = customerDrafts.find((draft) => draft.id === row.id);
    await prismaUnscoped.customer.update({ where: { id: row.id }, data: { isBlocked: prior?.subscriptionDraftPreviousBlocked ?? false, subscriptionDraftAt: null, subscriptionDraftReason: null, subscriptionDraftPreviousBlocked: null } });
  }
  for (const row of products.slice(0, ent.limits.maxProducts ?? products.length)) if (row.subscriptionDraftAt) {
    const prior = productDrafts.find((draft) => draft.id === row.id);
    await prismaUnscoped.product.update({ where: { id: row.id }, data: { status: prior?.subscriptionDraftPreviousStatus ?? 'ACTIVE', subscriptionDraftAt: null, subscriptionDraftReason: null, subscriptionDraftPreviousStatus: null } });
  }
  for (const row of customerOverflow) if (!row.subscriptionDraftAt) await prismaUnscoped.customer.update({ where: { id: row.id }, data: { subscriptionDraftAt: new Date(), subscriptionDraftReason: SUBSCRIPTION_DRAFT_REASON, subscriptionDraftPreviousBlocked: row.isBlocked, isBlocked: true } });
  for (const row of productOverflow) if (!row.subscriptionDraftAt) await prismaUnscoped.product.update({ where: { id: row.id }, data: { subscriptionDraftAt: new Date(), subscriptionDraftReason: SUBSCRIPTION_DRAFT_REASON, subscriptionDraftPreviousStatus: row.status, status: 'DRAFT' } });
}

async function sweep(): Promise<void> {
  const rows = await prismaUnscoped.subscription.findMany({ where: { status: 'PAST_DUE' }, select: { organizationId: true }, distinct: ['organizationId'] });
  for (const row of rows) await reconcileSubscriptionDrafts(await resolveEntitlements(row.organizationId));
}

/** Ensures draft classification happens even when nobody opens a list page. */
export function startSubscriptionRestrictionSweep(): void {
  const run = () => void sweep().catch((error) => logger.error({ error }, 'Subscription restriction sweep failed'));
  run();
  setInterval(run, 15 * 60_000).unref();
}
