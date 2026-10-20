import { describe, expect, it } from 'vitest';
import {
  classifyMetaFailure, isRetryable, parseMetaError,
} from '../../src/infrastructure/channels/meta-error';
import { countryOf } from '../../src/application/messaging/whatsapp-pricing.service';
import { variablesIn } from '../../src/application/messaging/whatsapp-template.service';

/*
 * Telling a missing payment method apart from everything else.
 *
 * Meta publishes no API that reports whether a business has a payment method,
 * so error 131042 in response to a real send is the only reliable signal there
 * is. Everything downstream — halting a campaign, showing the billing prompt —
 * hangs off getting this classification right, and getting it wrong in either
 * direction is costly: a missed billing error burns the account's quality
 * rating against a wall, and a false one nags a business about billing when
 * their template was simply rejected.
 */
const meta = (code: number | null, message = 'something went wrong', status = 400) =>
  parseMetaError({ error: { code, message, type: 'OAuthException' } }, status);

describe('Meta failures are classified by code, not by prose', () => {
  it('recognises the payment-method refusal', () => {
    const detail = meta(131042, 'Business eligibility payment issue');
    expect(classifyMetaFailure(detail)).toBe('BILLING_REQUIRED');
    expect(detail.code).toBe(131042);
  });

  it('does not call a template problem a billing problem', () => {
    for (const code of [132000, 132001, 132005, 132015, 132068]) {
      expect(classifyMetaFailure(meta(code, 'Template does not exist'))).toBe('TEMPLATE');
    }
  });

  it('does not call an expired token a billing problem', () => {
    expect(classifyMetaFailure(meta(190, 'Error validating access token'))).toBe('AUTH');
  });

  it('does not call a rate limit a billing problem', () => {
    expect(classifyMetaFailure(meta(131048, 'Spam rate limit hit'))).toBe('RATE_LIMIT');
    expect(classifyMetaFailure(meta(null, 'slow down', 429))).toBe('RATE_LIMIT');
  });

  it('does not call an unreachable recipient a billing problem', () => {
    expect(classifyMetaFailure(meta(131026, 'Message undeliverable'))).toBe('RECIPIENT');
  });

  it('reads the payment wording only when there is no code to go on', () => {
    expect(classifyMetaFailure(meta(null, 'There was a problem with your payment method'))).toBe('BILLING_REQUIRED');
    // A recognised code is never overridden by a sentence containing "payment".
    expect(classifyMetaFailure(meta(132001, 'payment template missing'))).toBe('TEMPLATE');
  });

  it('keeps the subcode and Meta\'s own detail for support', () => {
    const detail = parseMetaError(
      { error: { code: 131042, error_subcode: 2494055, message: 'Business eligibility payment issue', error_data: { details: 'Add a payment method' } } },
      400,
    );
    expect(detail.subcode).toBe(2494055);
    expect(detail.details).toBe('Add a payment method');
  });

  it('only retries what another attempt could fix', () => {
    expect(isRetryable('RATE_LIMIT')).toBe(true);
    expect(isRetryable('TRANSIENT')).toBe(true);
    // Retrying these just burns quota and quality rating.
    expect(isRetryable('BILLING_REQUIRED')).toBe(false);
    expect(isRetryable('TEMPLATE')).toBe(false);
    expect(isRetryable('AUTH')).toBe(false);
  });
});

describe('template variables', () => {
  it('finds the placeholders Meta will expect values for', () => {
    expect(variablesIn('Hi {{1}}, your order {{2}} is ready')).toEqual([1, 2]);
  });

  it('counts a repeated placeholder once and tolerates spacing', () => {
    expect(variablesIn('{{1}} and {{ 1 }} and {{3}}')).toEqual([1, 3]);
  });

  it('ignores text that merely looks like a placeholder', () => {
    expect(variablesIn('100% {{}} {{abc}} {{0}}')).toEqual([]);
  });
});

describe('recipient country, for pricing', () => {
  it('reads the dial code longest-first so 234 is not mistaken for 23', () => {
    expect(countryOf('2348030001111')).toBe('NG');
    expect(countryOf('233501234567')).toBe('GH');
    expect(countryOf('447700900123')).toBe('GB');
    expect(countryOf('14155550123')).toBe('US');
  });

  it('returns nothing rather than guessing', () => {
    expect(countryOf('99912345')).toBeNull();
  });
});
