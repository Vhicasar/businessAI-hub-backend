import type { AiProvider } from '../../application/ai/ai-provider';
import { env } from '../../shared/config/env';
import { requestContext } from '../../shared/context';
import { logger } from '../../shared/logger';
import { AnthropicProvider } from './anthropic.provider';
import { OpenAiCompatibleProvider } from './openai.provider';

/** Effective AI settings — the admin's synced config, or the local AI_* env. */
export interface AiConfigSource {
  provider: string;
  model: string;
  apiKey: string | null;
  baseUrl: string | null;
}

/**
 * How a provider call gets recorded.
 *
 * Registered by the application layer at startup rather than imported, so
 * infrastructure does not depend on application code. Metering lives here
 * because this is the single point every AI call passes through — wrapping at
 * the feature level meant the seven services calling `getAiProvider()` directly
 * were never measured, and the next one added would not be either.
 */
export type AiUsageRecorder = (usage: {
  organizationId: string;
  provider: string;
  model: string;
  feature: string;
  promptTokens?: number;
  completionTokens?: number;
  ownKey?: boolean;
  failed?: boolean;
}) => void;

let recordUsage: AiUsageRecorder | null = null;

export function setAiUsageRecorder(recorder: AiUsageRecorder | null): void {
  recordUsage = recorder;
}

/**
 * Wrap a provider so its calls are measured and attributed to the business
 * that made them.
 *
 * Transparent: returns what the provider returned, rethrows what it threw, and
 * silently does nothing when no recorder is registered or there is no tenant in
 * context (a platform-level call belongs to nobody).
 */
export function meterProvider(
  provider: AiProvider,
  feature: string,
  opts: { organizationId?: string; ownKey?: boolean } = {}
): AiProvider {
  /**
   * Measuring must never be able to break what it measures — including in the
   * failure branch, where a throwing recorder would replace the provider's real
   * error with its own and hide why the call actually failed.
   */
  const safely = (fn: () => void) => {
    try { fn(); } catch { /* a lost usage row is a reporting gap, not an outage */ }
  };
  return {
    name: provider.name,
    model: provider.model,
    get lastUsage() {
      return provider.lastUsage ?? null;
    },
    async complete(messages, completionOpts) {
      const organizationId = opts.organizationId ?? requestContext.get()?.organizationId;
      try {
        const text = await provider.complete(messages, completionOpts);
        if (recordUsage && organizationId) {
          const usage = provider.lastUsage;
          safely(() => recordUsage!({
            organizationId,
            provider: provider.name,
            model: provider.model ?? 'unknown',
            feature,
            promptTokens: usage?.promptTokens ?? 0,
            completionTokens: usage?.completionTokens ?? 0,
            ownKey: opts.ownKey,
          }));
        }
        return text;
      } catch (err) {
        // A failed call still consumed a provider request, and a spike in
        // failures is something an operator needs to see.
        if (recordUsage && organizationId) {
          safely(() => recordUsage!({
            organizationId,
            provider: provider.name,
            model: provider.model ?? 'unknown',
            feature,
            ownKey: opts.ownKey,
            failed: true,
          }));
        }
        throw err;
      }
    },
  };
}

let provider: AiProvider | null | undefined;
// Set by the admin sync; when present it overrides the AI_* env below.
let override: AiConfigSource | null = null;

/**
 * Replace the active AI config (from the admin sync) and drop the cached
 * provider so the next call rebuilds it. Passing null reverts to the AI_* env.
 */
export function setAiConfigOverride(next: AiConfigSource | null): void {
  const changed = JSON.stringify(next) !== JSON.stringify(override);
  override = next;
  if (changed) provider = undefined; // force rebuild on next getAiProvider()
}

/** Build an AI provider from an explicit config — used for per-workspace BYO keys. */
export function buildAiProvider(src: AiConfigSource): AiProvider | null {
  return build(src);
}

function build(src: AiConfigSource): AiProvider | null {
  switch (src.provider) {
    case 'anthropic': {
      if (!src.apiKey) {
        logger.warn('AI provider anthropic but no API key — AI disabled');
        return null;
      }
      return new AnthropicProvider(src.apiKey, src.model || 'claude-haiku-4-5-20251001');
    }
    // openai and every OpenAI-compatible gateway (openrouter, ollama, vllm,
    // gemini's compat endpoint, custom) share one provider; baseUrl routes them.
    case 'openai':
    case 'openrouter':
    case 'ollama':
    case 'vllm':
    case 'gemini':
    case 'custom':
      return new OpenAiCompatibleProvider(src.apiKey ?? '', src.model || 'gpt-4o-mini', src.baseUrl || undefined);
    default:
      return null;
  }
}

/**
 * The configured provider, metered, or null when AI is disabled.
 *
 * `feature` names what is asking, which is what makes the admin's per-feature
 * breakdown meaningful — without it every call reads as "other".
 */
export function getAiProvider(feature = 'other'): AiProvider | null {
  const raw = rawProvider();
  return raw ? meterProvider(raw, feature) : null;
}

/** The unwrapped provider — used by the status check and by the meter itself. */
function rawProvider(): AiProvider | null {
  if (provider !== undefined) return provider;
  const src: AiConfigSource = override ?? {
    provider: env.AI_PROVIDER,
    model: env.AI_MODEL || '',
    apiKey: env.AI_API_KEY || null,
    baseUrl: env.AI_BASE_URL || null,
  };
  provider = build(src);
  if (provider) logger.info(`AI provider: ${provider.name}${override ? ' (from admin)' : ''}`);
  return provider;
}

export function aiEnabled(): boolean {
  return rawProvider() !== null;
}

/** What the app is actually running on — and whether it came from the admin. */
export function getAiStatus(): { enabled: boolean; provider: string | null; model: string | null; source: 'admin' | 'env' } {
  const enabled = aiEnabled();
  const src = override ?? { provider: env.AI_PROVIDER, model: env.AI_MODEL || '', apiKey: null, baseUrl: null };
  return {
    enabled,
    provider: enabled ? src.provider : null,
    model: enabled ? src.model || null : null,
    source: override ? 'admin' : 'env',
  };
}
