import { describe, expect, it, vi } from 'vitest';
import type { AiProvider } from '../../src/application/ai/ai-provider';
import { meterProvider } from '../../src/infrastructure/ai';

function fakeProvider(): AiProvider & { complete: ReturnType<typeof vi.fn> } {
  return {
    name: 'deepseek',
    model: 'deepseek-chat',
    complete: vi.fn().mockResolvedValue('ok'),
  };
}

describe('central AI data policy gateway', () => {
  it('allows explicitly classified non-Google business data', async () => {
    const raw = fakeProvider();
    const gateway = meterProvider(raw, 'test');
    await expect(gateway.complete(
      [{ role: 'user', content: 'business-owned input' }],
      { dataSources: ['user_provided', 'vhicasar_business'] },
    )).resolves.toBe('ok');
    expect(raw.complete).toHaveBeenCalledOnce();
  });

  it('rejects Google-originated and mixed requests before provider I/O', async () => {
    const raw = fakeProvider();
    const gateway = meterProvider(raw, 'background-automation');
    await expect(gateway.complete(
      [{ role: 'user', content: 'restricted value is deliberately not logged' }],
      { dataSources: ['google_api', 'vhicasar_business'] },
    )).rejects.toMatchObject({ code: 'AI_GOOGLE_DATA_RESTRICTED' });
    expect(raw.complete).not.toHaveBeenCalled();
  });

  it('fails closed when a caller omits runtime classification', async () => {
    const raw = fakeProvider();
    const gateway = meterProvider(raw, 'test');
    await expect(gateway.complete(
      [{ role: 'user', content: 'unclassified' }],
      {} as never,
    )).rejects.toMatchObject({ code: 'AI_DATA_POLICY_BLOCKED' });
    expect(raw.complete).not.toHaveBeenCalled();
  });
});
