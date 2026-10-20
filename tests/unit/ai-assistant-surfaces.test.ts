import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { providerError } from '../../src/infrastructure/ai/provider-error';

/*
 * What a business is told when the model vendor says no.
 *
 * The vendor writes to whoever holds the account — us — so its words arrive
 * aimed at the wrong reader. Anthropic's out-of-credit reply says "go to Plans
 * & Billing to upgrade or purchase credits", and a business reading that
 * inside Vhicasar will go and look at their own subscription, which is fine
 * and which no amount of upgrading will fix.
 */
describe('AI provider failures are translated, not forwarded', () => {
  const ANTHROPIC_OUT_OF_CREDIT =
    'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.';

  it('never repeats the vendor words to the business', () => {
    const error = providerError('anthropic', ANTHROPIC_OUT_OF_CREDIT, 400);
    expect(error.message).not.toMatch(/Plans & Billing|purchase credits|Anthropic API/i);
    expect(error.message).toMatch(/not your subscription/i);
    expect(error.message).toMatch(/administrator/i);
  });

  it('keeps the vendor words out of the response body too', () => {
    // `details` is serialised to the client by the error handler, so the raw
    // text must not be smuggled through there either.
    const error = providerError('anthropic', ANTHROPIC_OUT_OF_CREDIT, 400);
    expect(JSON.stringify(error.details ?? {})).not.toMatch(/Plans & Billing|credit balance/i);
  });

  it('calls an exhausted account unavailable rather than broken', () => {
    expect(providerError('anthropic', ANTHROPIC_OUT_OF_CREDIT, 400).statusCode).toBe(503);
    expect(providerError('openai', 'You exceeded your current quota', 429).code).toBe('AI_PROVIDER_UNAVAILABLE');
  });

  it('tells a rejected key apart from an empty one, and offers the way out', () => {
    const error = providerError('openai', 'Incorrect API key provided', 401);
    expect(error.code).toBe('AI_PROVIDER_UNAVAILABLE');
    expect(error.message).toMatch(/connect your own AI provider/i);
  });

  it('asks the user to wait when the vendor is merely busy', () => {
    const error = providerError('anthropic', 'Overloaded', 529);
    expect(error.code).toBe('AI_PROVIDER_BUSY');
    expect(error.message).toMatch(/try that again/i);
  });

  it('stays vague rather than quoting an unrecognised failure', () => {
    const error = providerError('openai', 'upstream connect error: reset reason connection failure', 502);
    expect(error.message).not.toMatch(/upstream|reset reason/i);
    expect(error.statusCode).toBe(502);
  });
});

/*
 * The website builder is an AI surface like any other.
 *
 * It read the platform configuration directly, which meant a business that had
 * connected its own AI provider had that setting ignored — its website work
 * ran on, and was billed to, the platform's key — and when the platform key
 * was empty the feature refused outright even though the business had a
 * working one of their own. It also never spent plan credits, while every
 * other AI feature did.
 */
describe('website AI runs on the same provider and meter as the rest', () => {
  const service = readFileSync(
    join(__dirname, '../../src/application/sites/site-builder.service.ts'),
    'utf8',
  );

  it("resolves the business's own provider, not the platform configuration", () => {
    expect(service).not.toMatch(/getAiProvider\(/);
    expect(service.match(/resolveAi\('website'\)/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('charges plan credits unless the business is on its own key', () => {
    for (const call of service.match(/await resolveAi\('website'\)[\s\S]{0,220}/g) ?? []) {
      expect(call).toMatch(/if \(!ownKey\) await aiCredits\.consume\(/);
    }
  });

  it('still snapshots the page before letting a model rewrite it', () => {
    expect(service).toMatch(/snapshot\(siteId, 'Before AI edit'\)/);
  });

  it('classifies what it sends, so the data policy can judge it', () => {
    // Counted rather than matched per call: the options object sits past the
    // end of the messages array, so a window around the call either stops
    // short or swallows the next one. An unclassified call is blocked by the
    // gateway at runtime; this keeps it from being written in the first place.
    const calls = service.match(/provider\.complete\(/g)?.length ?? 0;
    const classified = service.match(/dataSources: \['user_provided', 'vhicasar_business'\]/g)?.length ?? 0;
    expect(calls).toBeGreaterThan(0);
    expect(classified).toBe(calls);
  });
});
