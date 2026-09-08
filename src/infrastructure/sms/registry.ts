import type { SmsProvider } from '../../application/sms/sms-provider';
import { env } from '../../shared/config/env';
import { logger } from '../../shared/logger';
import { TermiiProvider } from './termii.provider';
import { MockSmsProvider } from './mock.provider';

/**
 * Which provider is in use.
 *
 * One place decides, from configuration, so switching provider is an
 * environment change rather than a code change. Everything else in the SMS
 * module asks for `smsProvider()` and neither knows nor cares what it gets.
 */

let cached: SmsProvider | null = null;

function build(): SmsProvider {
  if (env.sms.provider === 'termii') {
    const termii = new TermiiProvider();
    if (termii.isConfigured()) return termii;
    // Falling back silently in production would mean a business believing
    // messages went out when nothing did.
    if (env.isProd) {
      throw new Error('SMS_PROVIDER is termii but SMS_API_KEY is not set');
    }
    logger.warn('Termii selected but no SMS_API_KEY — using the simulated provider');
    return new MockSmsProvider();
  }

  if (env.isProd) {
    throw new Error('The simulated SMS provider cannot be used in production. Set SMS_PROVIDER.');
  }
  return new MockSmsProvider();
}

export function smsProvider(): SmsProvider {
  cached ??= build();
  return cached;
}

/** Tests swap the provider; nothing else should. */
export function setSmsProviderForTesting(provider: SmsProvider | null): void {
  cached = provider;
}
