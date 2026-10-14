import { describe, expect, it } from 'vitest';
import {
  advanceSalesFlow,
  beginSalesFlow,
  catalogueQueryPhrases,
  extractRequestedItems,
  normalizeProductText,
  normalizeInterpretedRequestedItem,
  normalizeSalesLines,
  reviseConfirmedSalesFlow,
  resolveRequestedItem,
  resolveContextualSalesReference,
  type CatalogItem,
} from '../../src/application/ai/sales-conversation';

const catalog: CatalogItem[] = [
  { productId: 'chinese', variantId: 'chinese-v', name: 'Chinese Rice', price: 1000, currency: 'NGN', available: 20 },
  { productId: 'jollof', variantId: 'jollof-v', name: 'Jollof Rice', price: 900, currency: 'NGN', available: 20 },
  { productId: 'milk', variantId: 'milk-v', name: 'Milk', price: 200, currency: 'NGN', available: 10 },
  { productId: 'water', variantId: 'water-v', name: 'Table Water', price: 100, currency: 'NGN', available: 0 },
];

describe('sales conversation extraction and per-item resolution', () => {
  it('splits quantities and units into distinct line items', () => {
    expect(extractRequestedItems('I want 5 plates of rice and 1 milk')).toEqual([
      { key: 'line-1', phrase: 'rice', quantity: 5, unit: 'plate' },
      { key: 'line-2', phrase: 'milk', quantity: 1 },
    ]);
  });

  it('builds independent catalogue queries without quantity or unit noise', () => {
    expect(catalogueQueryPhrases('I want a 5 plates of rice and 1 milk')).toEqual(['rice', 'milk']);
  });

  it('canonicalizes a production AI item that repeats quantity and unit in its phrase', () => {
    const request = normalizeInterpretedRequestedItem(
      { phrase: '5 plates of rice', quantity: 5 },
      'line-1',
    );
    expect(request).toEqual({ key: 'line-1', phrase: 'rice', quantity: 5, unit: 'plate' });
    const flow = beginSalesFlow(request ? [request] : [], [catalog[0]!]);
    expect(flow.lines[0]).toMatchObject({ status: 'RESOLVED', quantity: 5, resolved: { productId: 'chinese' } });
  });

  it('does not strip a legitimate numeric product name when it disagrees with quantity', () => {
    expect(normalizeInterpretedRequestedItem(
      { phrase: '7 Up', quantity: 2 },
      'line-1',
    )).toEqual({ key: 'line-1', phrase: '7 Up', quantity: 2 });
  });

  it('supports several products and natural-language quantities', () => {
    expect(extractRequestedItems('Give me 2 Coke, three bottles of water and a pack of biscuits')).toEqual([
      { key: 'line-1', phrase: 'Coke', quantity: 2 },
      { key: 'line-2', phrase: 'water', quantity: 3, unit: 'bottle' },
      { key: 'line-3', phrase: 'biscuits', quantity: 1, unit: 'pack' },
    ]);
  });

  it('normalizes harmless case, spacing and punctuation differences', () => {
    expect(normalizeProductText('  CHINESE   Rice!! ')).toBe('chinese rice');
    expect(resolveRequestedItem({ key: '1', phrase: '  chinese RICE ', quantity: 1 }, catalog).resolved?.productId).toBe('chinese');
  });

  it('tolerates a harmless spelling mistake without inventing a product', () => {
    expect(resolveRequestedItem({ key: '1', phrase: 'milkk', quantity: 1 }, catalog).resolved?.productId).toBe('milk');
    expect(resolveRequestedItem({ key: '2', phrase: 'television', quantity: 1 }, catalog).status).toBe('NOT_FOUND');
  });

  it('treats generic rice as ambiguous but retains uniquely resolved milk', () => {
    const state = beginSalesFlow(extractRequestedItems('I want 5 plates of rice and 1 milk'), catalog);
    expect(state.status).toBe('AWAITING_CLARIFICATION');
    expect(state.lines[0]?.status).toBe('AMBIGUOUS');
    expect(state.lines[0]?.candidates?.map((item) => item.productId)).toEqual(['chinese', 'jollof']);
    expect(state.lines[1]?.status).toBe('RESOLVED');
    expect(state.lines[1]?.resolved?.productId).toBe('milk');
  });

  describe('data-driven ambiguity', () => {
    const request = { key: 'rice', phrase: 'rice', quantity: 5, unit: 'plate' };

    it('resolves generic rice when Chinese Rice is the only valid match', () => {
      const result = resolveRequestedItem(request, [catalog[0]!]);
      expect(result.status).toBe('RESOLVED');
      expect(result.resolved?.productId).toBe('chinese');
      expect(result.quantity).toBe(5);
    });

    it('asks when Chinese Rice and Jollof Rice are both valid', () => {
      const result = resolveRequestedItem(request, [catalog[0]!, catalog[1]!]);
      expect(result.status).toBe('AMBIGUOUS');
      expect(result.candidates?.map((item) => item.productId)).toEqual(['chinese', 'jollof']);
    });

    it('ignores unrelated catalogue products when rice has one valid match', () => {
      const result = resolveRequestedItem(request, [catalog[0]!, catalog[2]!]);
      expect(result.status).toBe('RESOLVED');
      expect(result.resolved?.productId).toBe('chinese');
    });

    it('deduplicates repeated representations of the same catalogue record', () => {
      const duplicate = { ...catalog[0]!, variantId: 'duplicate-search-row' };
      const result = resolveRequestedItem(request, [catalog[0]!, duplicate]);
      expect(result.status).toBe('RESOLVED');
      expect(result.resolved?.productId).toBe('chinese');
    });

    it('does not resolve inactive or non-purchasable rice records', () => {
      const invalid = { ...catalog[0]!, purchasable: false };
      expect(resolveRequestedItem(request, [invalid]).status).toBe('NOT_FOUND');
    });

    it('does not let an unavailable match create false ambiguity', () => {
      const unavailableJollof = { ...catalog[1]!, available: 0 };
      const result = resolveRequestedItem(request, [catalog[0]!, unavailableJollof]);
      expect(result.status).toBe('RESOLVED');
      expect(result.resolved?.productId).toBe('chinese');
    });

    it('gives a unique exact name priority over other rice products', () => {
      const result = resolveRequestedItem({ ...request, phrase: 'Chinese Rice' }, [catalog[0]!, catalog[1]!]);
      expect(result.status).toBe('RESOLVED');
      expect(result.resolved?.productId).toBe('chinese');
    });

    it('retains resolved items when only rice is genuinely ambiguous', () => {
      const state = beginSalesFlow(extractRequestedItems('5 rice and 1 milk'), catalog);
      expect(state.lines.find((line) => line.phrase.toLowerCase() === 'milk')?.status).toBe('RESOLVED');
      expect(state.lines.find((line) => line.phrase.toLowerCase() === 'rice')?.status).toBe('AMBIGUOUS');
    });
  });

  it('resolves two explicit products independently instead of treating them as alternatives', () => {
    const state = beginSalesFlow(extractRequestedItems('5 plates of Chinese Rice and 1 Milk'), catalog);
    expect(state.status).toBe('AWAITING_CONFIRMATION');
    expect(state.lines.map((line) => line.resolved?.productId)).toEqual(['chinese', 'milk']);
    expect(state.lines.map((line) => line.quantity)).toEqual([5, 1]);
  });

  it('updates only the ambiguous line from a clarification answer', () => {
    const initial = beginSalesFlow(extractRequestedItems('5 plates of rice and 1 milk'), catalog);
    const next = advanceSalesFlow(initial, 'Chinese Rice', catalog);
    expect(next.status).toBe('AWAITING_CONFIRMATION');
    expect(next.lines.map((line) => [line.resolved?.productId, line.quantity])).toEqual([['chinese', 5], ['milk', 1]]);
  });

  it('accepts a complete, more-specific restatement without duplicating retained products', () => {
    const initial = beginSalesFlow(extractRequestedItems('5 plates of rice and 1 milk'), catalog);
    const next = advanceSalesFlow(initial, 'I want 5 plates of Chinese Rice and 1 Milk', catalog);
    expect(next.status).toBe('AWAITING_CONFIRMATION');
    expect(next.lines).toHaveLength(2);
    expect(next.lines.map((line) => line.resolved?.productId)).toEqual(['chinese', 'milk']);
  });

  it('accepts a numbered answer to the recorded clarification', () => {
    const initial = beginSalesFlow(extractRequestedItems('5 plates of rice and 1 milk'), catalog);
    const next = advanceSalesFlow(initial, '1', catalog);
    expect(next.status).toBe('AWAITING_CONFIRMATION');
    expect(next.lines.map((line) => line.resolved?.productId)).toEqual(['chinese', 'milk']);
    expect(next.lines[0]?.quantity).toBe(5);
  });

  it('does not silently substitute unavailable products', () => {
    const result = resolveRequestedItem({ key: '1', phrase: 'table water', quantity: 1 }, catalog);
    expect(result.status).toBe('UNAVAILABLE');
    expect(result.resolved?.productId).toBe('water');
  });

  it('uses authoritative prices for the proposed subtotal', () => {
    const state = beginSalesFlow(extractRequestedItems('5 Chinese Rice and 1 Milk'), catalog);
    const subtotal = state.lines.reduce((sum, line) => sum + (line.resolved?.price ?? 0) * line.quantity, 0);
    expect(subtotal).toBe(5200);
  });

  it('reproduces the reported conversation and advances instead of looping', () => {
    const turn2 = beginSalesFlow(extractRequestedItems('I want 5 plates of rice and 1 milk'), catalog, 'message-2');
    expect(turn2.status).toBe('AWAITING_CLARIFICATION');
    const turn3 = advanceSalesFlow(turn2, 'I want 5 plates of chinese rice and 1 milk', catalog, 'message-3');
    expect(turn3.status).toBe('AWAITING_CONFIRMATION');
    expect(turn3.lines.map((line) => ({ name: line.resolved?.name, quantity: line.quantity }))).toEqual([
      { name: 'Chinese Rice', quantity: 5 },
      { name: 'Milk', quantity: 1 },
    ]);
  });

  it('edits quantities by ordinal reference without losing other lines', () => {
    const initial = beginSalesFlow(extractRequestedItems('2 Chinese Rice and 1 Milk'), catalog);
    const revised = reviseConfirmedSalesFlow(initial, 'Give me five of the first item and two of the second item', catalog)!;
    expect(revised.lines.map((line) => line.quantity)).toEqual([5, 2]);
    expect(revised.lines.map((line) => line.resolved?.productId)).toEqual(['chinese', 'milk']);
  });

  it('adds another quantity to an existing proposed line', () => {
    const initial = beginSalesFlow(extractRequestedItems('2 Chinese Rice and 1 Milk'), catalog);
    const revised = reviseConfirmedSalesFlow(initial, 'Add another 2 milk to my order', catalog)!;
    expect(revised.lines.find((line) => line.resolved?.productId === 'milk')?.quantity).toBe(3);
  });

  describe('contextual action resolution before catalogue search', () => {
    it('interprets "place another one" from the active single-line proposal', () => {
      const initial = beginSalesFlow(extractRequestedItems('1 Chinese Rice'), catalog);
      const result = resolveContextualSalesReference(initial, 'I want to place another one', catalog, 'next');
      expect(result.handled).toBe(true);
      expect(result.flow?.lines[0]?.resolved?.productId).toBe('chinese');
      expect(result.flow?.lines[0]?.quantity).toBe(2);
    });

    it('does not send "place another one" to product matching without context', () => {
      const result = resolveContextualSalesReference(null, 'I want to place another one', catalog);
      expect(result.handled).toBe(true);
      expect(result.flow).toBeUndefined();
      expect(result.response).toMatch(/reorder something.*choose a new product/i);
    });

    it('asks which item when "another one" could refer to several lines', () => {
      const initial = beginSalesFlow(extractRequestedItems('1 Chinese Rice and 1 Milk'), catalog);
      const result = resolveContextualSalesReference(initial, 'Add another one', catalog);
      expect(result.response).toMatch(/which item/i);
    });

    it('updates "make it five" without interpreting five as a product', () => {
      const initial = beginSalesFlow(extractRequestedItems('1 Chinese Rice'), catalog);
      const result = resolveContextualSalesReference(initial, 'Make it five instead', catalog);
      expect(result.flow?.lines[0]?.quantity).toBe(5);
    });

    it('selects the second option from the recorded clarification', () => {
      const initial = beginSalesFlow(extractRequestedItems('1 rice'), catalog);
      const result = resolveContextualSalesReference(initial, "I'll take the second one", catalog);
      expect(result.flow?.lines[0]?.resolved?.productId).toBe('jollof');
    });

    it('marks explicit previous-order language for authorized history retrieval', () => {
      const result = resolveContextualSalesReference(null, 'Give me the same order as last time', catalog);
      expect(result.needsPreviousOrder).toBe(true);
    });
  });

  describe('profile information is not treated as a product', () => {
    it('separates an introduction from a purchase in the regression conversation', () => {
      const requests = extractRequestedItems('I am Victor, i want 4 milk');
      expect(requests).toEqual([{ key: 'line-1', phrase: 'milk', quantity: 4 }]);
      const flow = beginSalesFlow(requests, catalog);
      expect(flow.status).toBe('AWAITING_CONFIRMATION');
      expect(flow.lines).toHaveLength(1);
      expect(flow.lines[0]).toMatchObject({ quantity: 4, status: 'RESOLVED', resolved: { productId: 'milk' } });
    });

    it.each([
      ['My name is Ada and I need 2 milk', 2],
      ["I'm Chidi; give me three milk", 3],
      ['You can call me Ayo, I would like 1 milk', 1],
    ])('handles naturally varied introduction: %s', (message, quantity) => {
      expect(extractRequestedItems(message)).toEqual([{ key: 'line-1', phrase: 'milk', quantity }]);
    });
  });

  it('collapses duplicate persisted variants without doubling the confirmed quantity', () => {
    const line = resolveRequestedItem({ key: 'line-1', phrase: 'milk', quantity: 4 }, catalog);
    const duplicate = { ...line, key: 'line-2' };
    const normalized = normalizeSalesLines([line, duplicate]);
    expect(normalized).toHaveLength(1);
    expect(normalized[0]).toMatchObject({ quantity: 4, resolved: { productId: 'milk' } });
  });

  it('keeps the greatest explicitly stated quantity when repairing duplicate variants', () => {
    const lower = resolveRequestedItem({ key: 'line-1', phrase: 'milk', quantity: 2 }, catalog);
    const corrected = resolveRequestedItem({ key: 'line-2', phrase: 'milk', quantity: 4 }, catalog);
    expect(normalizeSalesLines([lower, corrected])[0]?.quantity).toBe(4);
  });
});
