import type { Prisma } from '@prisma/client';
import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { env } from '../../shared/config/env';
import { logger } from '../../shared/logger';
import { PLAN_CATALOG, type FeatureKey } from '../../shared/plans';
import { toPriceBook } from '../../shared/billing-currency';

/**
 * Unifies pricing with the Vhicasar Admin: the admin is the single source of
 * truth for commercial terms (prices) and quota limits (AI credits, seats,
 * channels, contacts). Those are synced into the local Plan table so all
 * existing entitlement/enforcement logic keeps running unchanged.
 *
 * Feature-gate KEYS (`inbox`, `marketing`, `api`, …) stay code-owned — they are
 * functional, not commercial — and are matched to each plan by slug from
 * PLAN_CATALOG. If the admin is unreachable the local catalog is used as-is.
 */

interface AdminPlan {
  name: string;
  slug: string;
  description: string | null;
  priceMonthly: number;
  priceYearly: number;
  currency: string;
  /** Per-currency price book: { "USD": { "monthly": 9, "yearly": 86 } }. */
  prices?: unknown;
  features: string[];
  limits: Record<string, number | null> | null;
  isPublic: boolean;
  position: number;
}

const FEATURE_KEYS_BY_SLUG = new Map<string, FeatureKey[]>(PLAN_CATALOG.map((p) => [p.slug, p.features]));

/**
 * Functional feature keys are code-owned, so reconcile them even when the
 * remote commercial catalog is disabled. This also upgrades existing plan
 * rows after a deployment instead of requiring a manual reseed.
 */
async function syncLocalFeatureKeys(): Promise<void> {
  await Promise.all(
    [...FEATURE_KEYS_BY_SLUG.entries()].map(([slug, features]) =>
      prismaUnscoped.plan.updateMany({ where: { slug }, data: { features } }),
    ),
  );
}

function num(v: number | null | undefined): number | null {
  return v === undefined ? null : v;
}

// Read-through freshness: any sync attempt opens a short window during which
// reads won't re-sync, so the product billing page reflects admin edits almost
// immediately without hammering the admin.
const READ_TTL_MS = 10_000;
let lastSyncAt = 0;
let inflight: Promise<unknown> | null = null;

/**
 * Ensures plans are fresh before a read (billing page). Cheap: only re-syncs
 * when the TTL window has elapsed, and coalesces concurrent callers.
 */
export async function ensureFreshPlans(): Promise<void> {
  if (!env.adminCatalog.enabled) return;
  if (Date.now() - lastSyncAt < READ_TTL_MS) return;
  if (inflight) {
    await inflight.catch(() => undefined);
    return;
  }
  inflight = syncPlansFromAdmin().finally(() => {
    inflight = null;
  });
  await inflight.catch(() => undefined);
}

export async function syncPlansFromAdmin(): Promise<{ synced: number } | null> {
  if (!env.adminCatalog.enabled) return null;
  lastSyncAt = Date.now(); // open the freshness window even if the fetch fails

  const url = `${env.adminCatalog.apiUrl}/api/v1/public/${env.adminCatalog.tenantSlug}/pricing`;
  let plans: AdminPlan[];
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { data?: AdminPlan[] };
    if (!Array.isArray(json.data) || json.data.length === 0) throw new Error('empty catalog');
    plans = json.data;
  } catch (err) {
    logger.warn({ err: (err as Error).message, url }, 'Admin plan sync skipped — using local catalog');
    return null;
  }

  for (const p of plans) {
    const limits = p.limits ?? {};
    const featureKeys = FEATURE_KEYS_BY_SLUG.get(p.slug);
    const commercial = {
      name: p.name,
      description: p.description ?? null,
      priceMonthly: p.priceMonthly,
      priceYearly: p.priceYearly,
      currency: p.currency,
      // The admin owns commercial terms, and that now includes what we charge
      // in each currency. Normalised here so junk in the admin can't reach
      // checkout; an absent book means "charge the base price", as before.
      prices: (toPriceBook(p.prices) as Prisma.InputJsonValue) ?? undefined,
      maxUsers: num(limits.users),
      maxChannels: num(limits.channels),
      maxContacts: num(limits.contacts),
      maxMarketingReach: num(limits.marketingReach),
      aiCreditsMonthly: num(limits.aiCredits),
      isPublic: p.isPublic,
      isActive: true,
      position: p.position,
    };
    await prismaUnscoped.plan.upsert({
      where: { slug: p.slug },
      // Keep functional feature keys; only refresh them for slugs we know.
      update: featureKeys ? { ...commercial, features: featureKeys } : commercial,
      create: { slug: p.slug, ...commercial, maxBranches: null, maxProducts: null, features: featureKeys ?? [] },
    });
  }

  logger.info({ count: plans.length, tenant: env.adminCatalog.tenantSlug }, 'Synced plan catalog from Vhicasar Admin');
  return { synced: plans.length };
}

/** Runs an initial sync (best-effort) and schedules periodic refreshes. */
export function startPlanSync(): void {
  void syncLocalFeatureKeys().catch((err) => {
    logger.warn({ err: (err as Error).message }, 'Local plan feature reconciliation failed');
  });
  if (!env.adminCatalog.enabled) return;
  void syncPlansFromAdmin();
  const ms = env.adminCatalog.intervalMin * 60_000;
  if (ms > 0) setInterval(() => void syncPlansFromAdmin(), ms).unref();
}
