export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiCompletionOptions {
  maxTokens?: number;
  temperature?: number;
  /** Hint that the answer must be a single JSON object. */
  jsonMode?: boolean;
}

/**
 * Provider-agnostic LLM port. Feature services depend on this interface only;
 * concrete providers live in infrastructure/ai.
 */
/** What a call actually consumed, when the provider reports it. */
export interface AiUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface AiProvider {
  readonly name: string;
  /** Model in use, for attributing cost. */
  readonly model?: string;
  complete(messages: AiMessage[], opts?: AiCompletionOptions): Promise<string>;
  /**
   * Usage from the most recent `complete`, where the provider reported it.
   *
   * Deliberately a property rather than a changed return type: `complete`
   * is called from a dozen places, and metering is not worth breaking all of
   * them. Read immediately after the call that produced it.
   */
  readonly lastUsage?: AiUsage | null;
}

/** Tolerant JSON extraction — models occasionally wrap JSON in prose/fences. */
export function extractJson<T>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
