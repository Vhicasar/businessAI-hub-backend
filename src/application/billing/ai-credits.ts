import { resolveEntitlements, currentOrgId } from './entitlements';
import { usageService, USAGE_METRICS } from './usage.service';

/**
 * AI response metering against the org's monthly `aiCreditsMonthly` limit.
 * One credit = one AI-generated response. Used by the AI service.
 */
export const aiCredits = {
  /**
   * Consumes one AI credit for an org, throwing 402 (QUOTA_EXCEEDED) when the
   * monthly allowance is exhausted. Use on user-initiated AI actions.
   */
  async consume(orgId?: string, by = 1): Promise<void> {
    const organizationId = orgId ?? currentOrgId();
    const ent = await resolveEntitlements(organizationId);
    await usageService.consume(
      USAGE_METRICS.AI_RESPONSE,
      ent.limits.aiCreditsMonthly,
      { organizationId, periodStart: ent.periodStart, periodEnd: ent.periodEnd },
      by
    );
  },

  /**
   * Best-effort consume for background/bot flows: returns false instead of
   * throwing when the quota is used up, so the bot simply stays silent.
   */
  async tryConsume(orgId: string, by = 1): Promise<boolean> {
    const ent = await resolveEntitlements(orgId);
    const period = { organizationId: orgId, periodStart: ent.periodStart, periodEnd: ent.periodEnd };
    const limit = ent.limits.aiCreditsMonthly;
    if (limit !== null) {
      const used = await usageService.get(USAGE_METRICS.AI_RESPONSE, period);
      if (used + by > limit) return false;
    }
    await usageService.increment(USAGE_METRICS.AI_RESPONSE, period, by);
    return true;
  },
};
