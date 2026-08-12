import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { resolveEntitlements } from '../billing/entitlements';
import type { CatalogIntegration } from '../catalog/site-catalog.service';

/**
 * Whether a business's plan reaches an integration.
 *
 * The catalog lists the plans an integration belongs to. Comparing the active
 * plan's slug against that list by equality is what made upgrading useless:
 * an integration listed for `business` is invisible on `growth`, but it is also
 * invisible on any plan an operator adds or renames later. Treating the list as
 * a *minimum tier* and comparing by plan position makes an upgrade monotonic —
 * moving up a tier can only ever add access, never remove it.
 */

/** Plan slug → position, from the plans table. Positions define the ladder. */
async function planPositions(): Promise<Map<string, number>> {
  const plans = await prismaUnscoped.plan.findMany({ select: { slug: true, position: true } });
  return new Map(plans.map((p) => [p.slug, p.position]));
}

let cached: { value: Map<string, number>; expiresAt: number } | null = null;

/**
 * Positions change only when an operator edits the plan catalog, so a short
 * cache is safe. It is deliberately shorter than a person can upgrade and
 * navigate back to the integrations screen — a plan change must never leave
 * someone locked out of what they just paid for.
 */
async function positions(): Promise<Map<string, number>> {
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = await planPositions();
  cached = { value, expiresAt: Date.now() + 10_000 };
  return value;
}

/** Test seam: drop the memoised ladder. */
export function resetPlanPositionCache(): void {
  cached = null;
}

export interface IntegrationAccess {
  available: boolean;
  /** Null when available; otherwise what the user has to do about it. */
  reason: 'PLAN_UPGRADE_REQUIRED' | null;
  /** The cheapest plan that reaches this integration, for the upgrade prompt. */
  requiredPlan: string | null;
}

export async function integrationAccess(
  integration: Pick<CatalogIntegration, 'plans'>,
  planSlug: string,
  ladder?: Map<string, number>
): Promise<IntegrationAccess> {
  // No list means every plan, including the free one.
  if (!integration.plans || integration.plans.length === 0) {
    return { available: true, reason: null, requiredPlan: null };
  }
  // Listing the plan outright always grants it, whatever the positions say.
  if (integration.plans.includes(planSlug)) {
    return { available: true, reason: null, requiredPlan: null };
  }

  const ranks = ladder ?? (await positions());
  const current = ranks.get(planSlug);
  const required = integration.plans
    .map((slug) => ({ slug, rank: ranks.get(slug) }))
    .filter((p): p is { slug: string; rank: number } => typeof p.rank === 'number')
    .sort((a, b) => a.rank - b.rank)[0];

  // An unknown plan on either side means the ladder cannot be compared. Deny,
  // but name the plan needed — failing open here would hand paid integrations
  // to the free tier.
  if (current === undefined || !required) {
    return { available: false, reason: 'PLAN_UPGRADE_REQUIRED', requiredPlan: required?.slug ?? integration.plans[0] ?? null };
  }

  const available = current >= required.rank;
  return {
    available,
    reason: available ? null : 'PLAN_UPGRADE_REQUIRED',
    requiredPlan: available ? null : required.slug,
  };
}

/** Access for a whole catalog in one pass, sharing the plan ladder. */
export async function integrationAccessFor(
  integrations: CatalogIntegration[],
  organizationId?: string
): Promise<Map<string, IntegrationAccess>> {
  const [ent, ladder] = await Promise.all([resolveEntitlements(organizationId), positions()]);
  const out = new Map<string, IntegrationAccess>();
  for (const item of integrations) {
    out.set(item.id, await integrationAccess(item, ent.planSlug, ladder));
  }
  return out;
}
