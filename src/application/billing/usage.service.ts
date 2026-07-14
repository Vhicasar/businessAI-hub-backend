import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { AppError } from '../../shared/errors';

/** Metered usage counters (per org, per metric, per billing period). */
export const USAGE_METRICS = {
  AI_RESPONSE: 'ai_response',
} as const;

export type UsageMetric = (typeof USAGE_METRICS)[keyof typeof USAGE_METRICS];

export interface UsagePeriod {
  organizationId: string;
  periodStart: Date;
  periodEnd: Date;
}

export const usageService = {
  /** Current usage value for a metric in the given period (0 when unmetered). */
  async get(metric: UsageMetric, period: UsagePeriod): Promise<number> {
    const row = await prismaUnscoped.usageCounter.findUnique({
      where: {
        organizationId_metric_periodStart: {
          organizationId: period.organizationId,
          metric,
          periodStart: period.periodStart,
        },
      },
      select: { value: true },
    });
    return row?.value ?? 0;
  },

  /** Atomically add to a metric's counter, creating the period row if needed. */
  async increment(metric: UsageMetric, period: UsagePeriod, by = 1): Promise<number> {
    const row = await prismaUnscoped.usageCounter.upsert({
      where: {
        organizationId_metric_periodStart: {
          organizationId: period.organizationId,
          metric,
          periodStart: period.periodStart,
        },
      },
      create: {
        organizationId: period.organizationId,
        metric,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
        value: by,
      },
      update: { value: { increment: by } },
      select: { value: true },
    });
    return row.value;
  },

  /**
   * Enforces a hard quota: throws 402 when consuming `by` would exceed `limit`
   * (null = unlimited), otherwise records the usage and returns the new total.
   */
  async consume(
    metric: UsageMetric,
    limit: number | null,
    period: UsagePeriod,
    by = 1
  ): Promise<number> {
    if (limit === null) return this.increment(metric, period, by);

    const current = await this.get(metric, period);
    if (current + by > limit) {
      throw new AppError(
        'QUOTA_EXCEEDED',
        402,
        `Monthly AI response limit reached (${limit}). Upgrade your plan or add more responses to continue.`,
        { metric, limit, used: current }
      );
    }
    return this.increment(metric, period, by);
  },
};
