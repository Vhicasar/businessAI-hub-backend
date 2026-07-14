import type { AiProvider } from '../../application/ai/ai-provider';
import { env } from '../../shared/config/env';
import { logger } from '../../shared/logger';
import { AnthropicProvider } from './anthropic.provider';
import { OpenAiCompatibleProvider } from './openai.provider';

let provider: AiProvider | null | undefined;

/** Returns the configured provider, or null when AI is disabled. */
export function getAiProvider(): AiProvider | null {
  if (provider !== undefined) return provider;

  switch (env.AI_PROVIDER) {
    case 'anthropic': {
      if (!env.AI_API_KEY) {
        logger.warn('AI_PROVIDER=anthropic but AI_API_KEY is empty — AI disabled');
        provider = null;
        break;
      }
      provider = new AnthropicProvider(env.AI_API_KEY, env.AI_MODEL || 'claude-haiku-4-5-20251001');
      break;
    }
    case 'openai': {
      provider = new OpenAiCompatibleProvider(
        env.AI_API_KEY ?? '',
        env.AI_MODEL || 'gpt-4o-mini',
        env.AI_BASE_URL || undefined
      );
      break;
    }
    default:
      provider = null;
  }
  if (provider) logger.info(`AI provider: ${provider.name}`);
  return provider;
}

export function aiEnabled(): boolean {
  return getAiProvider() !== null;
}
