import { describe, expect, it } from 'vitest';
import { extractJson } from '../../src/application/ai/ai-provider';

describe('extractJson', () => {
  it('parses a clean JSON object', () => {
    expect(extractJson('{"score": 80, "reason": "good"}')).toEqual({ score: 80, reason: 'good' });
  });

  it('parses JSON wrapped in a fenced code block', () => {
    expect(extractJson('Here you go:\n```json\n{"handoff": true}\n```')).toEqual({ handoff: true });
  });

  it('parses JSON embedded in prose', () => {
    expect(extractJson('Sure! {"sentiment":"NEGATIVE"} — hope that helps.')).toEqual({
      sentiment: 'NEGATIVE',
    });
  });

  it('handles nested braces', () => {
    expect(extractJson('{"a":{"b":1},"c":[{"d":2}]}')).toEqual({ a: { b: 1 }, c: [{ d: 2 }] });
  });

  it('returns null for garbage', () => {
    expect(extractJson('no json here')).toBeNull();
    expect(extractJson('{broken')).toBeNull();
    expect(extractJson('')).toBeNull();
  });
});
