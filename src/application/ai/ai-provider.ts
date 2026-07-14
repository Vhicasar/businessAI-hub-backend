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
export interface AiProvider {
  readonly name: string;
  complete(messages: AiMessage[], opts?: AiCompletionOptions): Promise<string>;
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
