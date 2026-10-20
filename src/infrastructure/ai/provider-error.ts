import { AppError } from '../../shared/errors';
import { logger } from '../../shared/logger';

/**
 * Turn a model vendor's failure into something a business can act on.
 *
 * The vendor is writing to whoever holds the account, which on this platform
 * is usually us — so its words arrive aimed at the wrong reader. Anthropic's
 * out-of-credit message, for example, says "go to Plans & Billing to upgrade
 * or purchase credits", which a business reading it in Vhicasar will take as
 * their own subscription being at fault. It is not; their plan is fine and
 * nothing they can buy will fix it.
 *
 * The vendor's exact words still go to the log, where the people who can act
 * on them will see them. What the business gets back names the situation
 * truthfully and points at the only person who can resolve it.
 */
export function providerError(vendor: string, rawMessage: string, status?: number): AppError {
  const raw = rawMessage || String(status ?? 'unknown error');

  /*
   * The vendor's words go here and nowhere else. `details` on an AppError is
   * serialised to the client by the error handler, so putting the raw text
   * there would defeat the whole point of this function.
   */
  logger.warn({ vendor, status, raw }, 'AI provider rejected a request');

  // Our account with the vendor has run dry or been suspended. Nothing about
  // the business's own plan is wrong, and nothing they do in Vhicasar helps.
  if (/credit balance|quota|billing|insufficient_quota|payment required|exceeded your current quota/i.test(raw)) {
    return new AppError(
      'AI_PROVIDER_UNAVAILABLE',
      503,
      'AI features are temporarily unavailable on this workspace. This is a problem with the AI service '
        + 'account, not your subscription — please contact your Vhicasar administrator.',
      { vendor },
    );
  }

  // A rejected key is the same shape of problem: an operator's to fix.
  if (/api key|unauthorized|authentication|invalid[_ ]token|forbidden/i.test(raw) || status === 401 || status === 403) {
    return new AppError(
      'AI_PROVIDER_UNAVAILABLE',
      503,
      'AI features are not working because the AI service rejected this workspace\'s credentials. '
        + 'Contact your Vhicasar administrator, or connect your own AI provider in Settings.',
      { vendor },
    );
  }

  if (/rate limit|too many requests|overloaded/i.test(raw) || status === 429 || status === 529) {
    return new AppError(
      'AI_PROVIDER_BUSY',
      503,
      'The AI service is busy right now. Try that again in a moment.',
      { vendor },
    );
  }

  // Anything else: say that it failed without quoting words written for us.
  return new AppError(
    'AI_PROVIDER_ERROR',
    502,
    'The AI service could not complete that request. Try again, and contact your Vhicasar administrator if it continues.',
    { vendor },
  );
}
