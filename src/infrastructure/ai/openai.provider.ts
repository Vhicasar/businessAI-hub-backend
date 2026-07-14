import type { AiCompletionOptions, AiMessage, AiProvider } from '../../application/ai/ai-provider';
import { AppError } from '../../shared/errors';

/**
 * OpenAI-compatible chat completions — works with OpenAI, Ollama, vLLM,
 * OpenRouter and similar via AI_BASE_URL.
 */
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
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: opts.maxTokens ?? 1024,
        temperature: opts.temperature ?? 0.3,
        ...(opts.jsonMode ? { response_format: { type: 'json_object' } } : {}),
        messages,
      }),
    });

    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      error?: { message?: string };
    };
    if (!res.ok) {
      throw new AppError('AI_PROVIDER_ERROR', 502, `AI provider: ${json.error?.message ?? res.status}`);
    }
    return json.choices?.[0]?.message?.content ?? '';
  }
}
