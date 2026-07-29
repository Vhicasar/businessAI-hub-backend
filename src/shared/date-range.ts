const DAY = 24 * 60 * 60 * 1000;

export type RangePreset =
  | 'today'
  | 'yesterday'
  | '7d'
  | '30d'
  | 'this_month'
  | 'last_month'
  | 'quarter'
  | 'year'
  | 'custom';

export interface DateRange {
  from: Date;
  to: Date;
  /** Whole days spanned (>=1), for labels and "per-day" buckets. */
  days: number;
  preset: RangePreset;
}

function startOfDayUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function parseDate(v: unknown): Date | null {
  if (typeof v !== 'string' || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fromPreset(preset: RangePreset, now: Date): { from: Date; to: Date } {
  const startToday = startOfDayUTC(now);
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  switch (preset) {
    case 'today':
      return { from: startToday, to: now };
    case 'yesterday':
      return { from: new Date(startToday.getTime() - DAY), to: startToday };
    case '7d':
      return { from: new Date(now.getTime() - 7 * DAY), to: now };
    case 'this_month':
      return { from: new Date(Date.UTC(y, m, 1)), to: now };
    case 'last_month':
      return { from: new Date(Date.UTC(y, m - 1, 1)), to: new Date(Date.UTC(y, m, 1)) };
    case 'quarter': {
      const qStartMonth = Math.floor(m / 3) * 3;
      return { from: new Date(Date.UTC(y, qStartMonth, 1)), to: now };
    }
    case 'year':
      return { from: new Date(Date.UTC(y, 0, 1)), to: now };
    case '30d':
    default:
      return { from: new Date(now.getTime() - 30 * DAY), to: now };
  }
}

/**
 * Resolves a universal date range from request query params. Priority:
 *   1. explicit from/to (custom)
 *   2. a named preset (`range`)
 *   3. legacy `days` window (backwards compatible)
 *   4. default: last 30 days
 */
export function resolveDateRange(q: {
  from?: unknown;
  to?: unknown;
  range?: unknown;
  days?: unknown;
}): DateRange {
  const now = new Date();
  const explicitFrom = parseDate(q.from);
  const explicitTo = parseDate(q.to);

  let from: Date;
  let to: Date;
  let preset: RangePreset;

  if (explicitFrom && explicitTo && explicitFrom <= explicitTo) {
    from = explicitFrom;
    to = explicitTo;
    preset = 'custom';
  } else if (typeof q.range === 'string' && q.range !== 'custom') {
    preset = q.range as RangePreset;
    ({ from, to } = fromPreset(preset, now));
  } else if (q.days !== undefined) {
    const days = Math.min(365, Math.max(1, Number(q.days) || 30));
    from = new Date(now.getTime() - days * DAY);
    to = now;
    preset = '30d';
  } else {
    preset = '30d';
    ({ from, to } = fromPreset('30d', now));
  }

  const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / DAY));
  return { from, to, days, preset };
}

/** The equal-length window immediately before `range`, for period-over-period deltas. */
export function previousRange(range: DateRange): { from: Date; to: Date } {
  const span = range.to.getTime() - range.from.getTime();
  return { from: new Date(range.from.getTime() - span), to: range.from };
}
