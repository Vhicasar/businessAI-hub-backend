import { describe, expect, it } from 'vitest';
import { validateCommerceInterpretation } from '../../src/application/ai/commerce-turn-interpreter';

describe('commerce turn interpretation contract', () => {
  it('keeps profile data separate from requested catalogue items', () => {
    const result = validateCommerceInterpretation({
      profile: { name: 'Victor' },
      items: [{ phrase: 'milk', quantity: 4 }],
      actions: ['UPDATE_PROFILE', 'RESOLVE_CATALOG_ITEMS', 'PROPOSE_ORDER'],
      confidence: 0.96,
    });
    expect(result?.profile?.name).toBe('Victor');
    expect(result?.items).toEqual([{ phrase: 'milk', quantity: 4 }]);
  });

  it('rejects malformed or unsafe plans before catalogue resolution', () => {
    expect(validateCommerceInterpretation({
      items: [{ phrase: '', quantity: -4 }],
      actions: ['EXECUTE_PAYMENT'],
      confidence: 12,
    })).toBeNull();
  });
});
