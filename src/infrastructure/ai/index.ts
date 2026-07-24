import type { AiProvider } from '../../application/ai/ai-provider';
import { env } from '../../shared/config/env';
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

/** Returns the configured provider, or null when AI is disabled. */
export function getAiProvider(): AiProvider | null {
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
  return getAiProvider() !== null;
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
