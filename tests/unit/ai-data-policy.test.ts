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

describe('the refusal is a behaviour, not an outage', () => {
  it('names the error so callers can degrade on it rather than on a message', async () => {
    const raw = fakeProvider();
    const gateway = meterProvider(raw, 'test');
    const err = await gateway
      .complete([{ role: 'user', content: 'x' }], { dataSources: ['google_api'] })
      .catch((e: unknown) => e as { code?: string; statusCode?: number });
    expect(err?.code).toBe('AI_GOOGLE_DATA_RESTRICTED');
    // 4xx, not 5xx: the request was understood and declined on policy.
    expect(err?.statusCode).toBe(422);
  });

  it('declines before the provider is told anything at all', async () => {
    const raw = fakeProvider();
    const gateway = meterProvider(raw, 'test');
    await gateway
      .complete(
        [{ role: 'user', content: 'a customer address that must not travel' }],
        { dataSources: ['google_api'] },
      )
      .catch(() => undefined);
    // The point of enforcing in the gateway rather than at each call site:
    // nothing reaches the vendor, not even to be rejected.
    expect(raw.complete).not.toHaveBeenCalled();
  });

  it('lets a mixed request through only when no part of it came from Google', async () => {
    const raw = fakeProvider();
    const gateway = meterProvider(raw, 'test');
    await expect(
      gateway.complete([{ role: 'user', content: 'x' }], {
        dataSources: ['user_provided', 'vhicasar_business', 'public'],
      }),
    ).resolves.toBe('ok');
  });
});
