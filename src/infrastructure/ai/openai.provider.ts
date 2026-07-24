import type { AiCompletionOptions, AiMessage, AiProvider } from '../../application/ai/ai-provider';
import { AppError } from '../../shared/errors';

/**
 * OpenAI-compatible chat completions — works with OpenAI, Ollama, vLLM,
 * OpenRouter and similar via a base URL.
 *
 * Token-limit param quirk: most OpenAI-compatible servers take `max_tokens`, but
 * newer OpenAI models (gpt-4o/o-series/gpt-5) rejected it in favour of
 * `max_completion_tokens`. We send `max_tokens` first and transparently retry
 * with `max_completion_tokens` when a model demands it, so every backend works
 * without per-model configuration.
 */
interface SendResult {
  ok: boolean;
  status: number;
  content: string;
  errorMessage?: string;
}

export class OpenAiCompatibleProvider implements AiProvider {
  readonly name = 'openai';

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    baseUrl?: string
  ) {
    this.baseUrl = (baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  }

  private readonly baseUrl: string;

  async complete(messages: AiMessage[], opts: AiCompletionOptions = {}): Promise<string> {
    const maxTokens = opts.maxTokens ?? 1024;
    const base: Record<string, unknown> = {
      model: this.model,
      temperature: opts.temperature ?? 0.3,
      ...(opts.jsonMode ? { response_format: { type: 'json_object' } } : {}),
      messages,
    };

    let result = await this.send({ ...base, max_tokens: maxTokens });
    // Newer OpenAI models: "'max_tokens' is not supported … use 'max_completion_tokens'".
    if (!result.ok && /max_completion_tokens/i.test(result.errorMessage ?? '')) {
      result = await this.send({ ...base, max_completion_tokens: maxTokens });
    }

    if (!result.ok) {
      throw new AppError('AI_PROVIDER_ERROR', 502, `AI provider: ${result.errorMessage ?? result.status}`);
    }
    return result.content;
  }

  private async send(body: Record<string, unknown>): Promise<SendResult> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      error?: { message?: string };
    };
    return {
      ok: res.ok,
      status: res.status,
      content: json.choices?.[0]?.message?.content ?? '',
      errorMessage: json.error?.message,
    };
  }
}
