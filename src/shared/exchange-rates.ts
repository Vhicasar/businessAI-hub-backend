import { prismaUnscoped } from '../infrastructure/database/prisma';
import { env } from './config/env';
import { AppError } from './errors';
import { currencyDef } from './currency';

type CachedRate = {
  rate: number;
  snapshotId: string;
  fetchedAt: Date;
  expiresAt: Date;
};

export type MoneyConversion = {
  amount: number;
  currency: string;
  sourceAmount: number;
  sourceCurrency: string;
  rate: number;
  snapshotId: string | null;
  asOf: Date;
};

const memory = new Map<string, CachedRate>();
const roundFor = (amount: number, currency: string) => {
  const decimals = currencyDef(currency)?.decimals ?? 2;
  const factor = 10 ** decimals;
  return Math.round((amount + Number.EPSILON) * factor) / factor;
};

async function fetchRate(base: string, quote: string): Promise<CachedRate> {
  const response = await fetch(`${env.fx.providerUrl}/${encodeURIComponent(base)}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`FX provider returned HTTP ${response.status}`);
  const body = await response.json() as {
    result?: string;
    rates?: Record<string, number>;
    time_last_update_unix?: number;
    time_next_update_unix?: number;
  };
  const rate = Number(body.rates?.[quote]);
  if (body.result !== 'success' || !Number.isFinite(rate) || rate <= 0) {
    throw new Error(`FX provider has no valid ${base}/${quote} rate`);
  }
  const fetchedAt = new Date();
  const providerUpdatedAt = body.time_last_update_unix
    ? new Date(body.time_last_update_unix * 1000)
    : fetchedAt;
  const providerExpiry = body.time_next_update_unix
    ? new Date(body.time_next_update_unix * 1000)
    : new Date(fetchedAt.getTime() + env.fx.cacheTtlMs);
  const expiresAt = new Date(Math.min(providerExpiry.getTime(), fetchedAt.getTime() + env.fx.cacheTtlMs));
  const snapshot = await prismaUnscoped.exchangeRateSnapshot.create({
    data: {
      baseCurrency: base,
      quoteCurrency: quote,
      rate,
      provider: 'ExchangeRate-API',
      providerUpdatedAt,
      fetchedAt,
      expiresAt,
    },
  });
  return { rate, snapshotId: snapshot.id, fetchedAt, expiresAt };
}

async function rateFor(base: string, quote: string, forCharge: boolean): Promise<CachedRate> {
  const key = `${base}:${quote}`;
  const now = Date.now();
  const hot = memory.get(key);
  if (hot && hot.expiresAt.getTime() > now) return hot;

  const persisted = await prismaUnscoped.exchangeRateSnapshot.findFirst({
    where: { baseCurrency: base, quoteCurrency: quote },
    orderBy: { fetchedAt: 'desc' },
  });
  if (persisted && persisted.expiresAt.getTime() > now) {
    const cached = {
      rate: Number(persisted.rate),
      snapshotId: persisted.id,
      fetchedAt: persisted.fetchedAt,
      expiresAt: persisted.expiresAt,
    };
    memory.set(key, cached);
    return cached;
  }

  try {
    const fresh = await fetchRate(base, quote);
    memory.set(key, fresh);
    return fresh;
  } catch (cause) {
    if (persisted && !forCharge && now - persisted.fetchedAt.getTime() <= env.fx.maxStaleMs) {
      return {
        rate: Number(persisted.rate),
        snapshotId: persisted.id,
        fetchedAt: persisted.fetchedAt,
        expiresAt: persisted.expiresAt,
      };
    }
    throw new AppError(
      'EXCHANGE_RATE_UNAVAILABLE',
      503,
      forCharge
        ? `A current ${base}/${quote} exchange rate is unavailable, so no charge was created.`
        : `Currency conversion from ${base} to ${quote} is temporarily unavailable.`,
      { cause: cause instanceof Error ? cause.message : String(cause) },
    );
  }
}

export const exchangeRates = {
  async convert(
    amount: number,
    sourceCurrency: string,
    targetCurrency: string,
    options: { forCharge?: boolean } = {},
  ): Promise<MoneyConversion> {
    const source = sourceCurrency.toUpperCase();
    const target = targetCurrency.toUpperCase();
    if (source === target) {
      return {
        amount: roundFor(amount, target),
        currency: target,
        sourceAmount: amount,
        sourceCurrency: source,
        rate: 1,
        snapshotId: null,
        asOf: new Date(),
      };
    }
    const quote = await rateFor(source, target, Boolean(options.forCharge));
    return {
      amount: roundFor(amount * quote.rate, target),
      currency: target,
      sourceAmount: amount,
      sourceCurrency: source,
      rate: quote.rate,
      snapshotId: quote.snapshotId,
      asOf: quote.fetchedAt,
    };
  },
};
