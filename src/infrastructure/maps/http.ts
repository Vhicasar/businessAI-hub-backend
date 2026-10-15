import { logger } from '../../shared/logger';
import { ProviderError, type ProviderRuntime } from './types';

/**
 * One way to talk to a provider, so every adapter fails the same way.
 *
 * The URL is never logged. Provider URLs carry the API key as a query
 * parameter and the customer's address as another, so a log line containing
 * one leaks a credential and someone's home in the same breath.
 */
export async function providerFetch(
  runtime: ProviderRuntime,
  url: string,
  init: RequestInit = {},
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), runtime.timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        // Several open providers require a contactable agent and will block
        // requests without one.
        'User-Agent': 'Vhicasar-Hub-AI/1.0 (+https://vhicasar.com)',
        Accept: 'application/json',
        ...(init.headers ?? {}),
      },
    });

    if (res.status === 401 || res.status === 403) {
      throw new ProviderError(
        `${runtime.provider} rejected the credentials`,
        'auth',
        false,
      );
    }
    if (res.status === 429) {
      throw new ProviderError(`${runtime.provider} is rate limiting us`, 'quota', true);
    }
    if (res.status >= 500) {
      throw new ProviderError(`${runtime.provider} returned HTTP ${res.status}`, 'network', true);
    }
    if (!res.ok) {
      throw new ProviderError(`${runtime.provider} returned HTTP ${res.status}`, 'bad_response', false);
    }
    return (await res.json()) as unknown;
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    const aborted = (err as Error).name === 'AbortError';
    logger.warn(
      { provider: runtime.provider, err: aborted ? 'timeout' : (err as Error).message },
      'maps provider request failed',
    );
    throw new ProviderError(
      aborted ? `${runtime.provider} did not answer in time` : `${runtime.provider} could not be reached`,
      'network',
      true,
    );
  } finally {
    clearTimeout(timer);
  }
}

export const trimBase = (url: string): string => url.replace(/\/+$/, '');

/** A country bias as providers want it: lower-case, comma-separated. */
export function countryBias(options: Record<string, unknown>): string[] {
  const raw = String(options.countryCodes ?? '').trim();
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((c) => c.trim().toLowerCase())
    .filter((c) => c.length === 2);
}
