import { describe, expect, it } from 'vitest';
import { allocateBalances } from '../../src/application/manufacturing/material-allocation.service';

describe('deterministic production material allocation', () => {
  const sugar = { materialId: 'm-sugar', variantId: 'sugar', requiredQuantity: 100 };

  it('allocates one material from one warehouse without moving stock', () => {
    expect(allocateBalances([sugar], [{ warehouseId: 'main', variantId: 'sugar', available: 120 }], 'main')[0])
      .toMatchObject({ availableQuantity: 100, shortageQuantity: 0, allocations: [{ warehouseId: 'main', quantity: 100 }] });
  });

  it('uses the preferred warehouse first and falls back across warehouses', () => {
    const result = allocateBalances([sugar], [
      { warehouseId: 'other', variantId: 'sugar', available: 100 },
      { warehouseId: 'main', variantId: 'sugar', available: 60 },
    ], 'main')[0]!;
    expect(result.allocations).toEqual([
      { warehouseId: 'main', quantity: 60, batchId: null },
      { warehouseId: 'other', quantity: 40, batchId: null },
    ]);
  });

  it('minimizes splits by using the largest non-preferred balance first', () => {
    const result = allocateBalances([sugar], [
      { warehouseId: 'small', variantId: 'sugar', available: 20 },
      { warehouseId: 'large', variantId: 'sugar', available: 100 },
    ])[0]!;
    expect(result.allocations).toHaveLength(1);
    expect(result.allocations[0]).toMatchObject({ warehouseId: 'large', quantity: 100 });
  });

  it('allocates multiple materials independently and reports shortages', () => {
    const result = allocateBalances([
      sugar,
      { materialId: 'm-bottle', variantId: 'bottle', requiredQuantity: 10_000 },
    ], [
      { warehouseId: 'main', variantId: 'sugar', available: 60 },
      { warehouseId: 'pack', variantId: 'bottle', available: 8_000 },
    ], 'main');
    expect(result[0]).toMatchObject({ availableQuantity: 60, shortageQuantity: 40 });
    expect(result[1]).toMatchObject({ availableQuantity: 8000, shortageQuantity: 2000 });
  });

  it('never allocates zero or negative availability', () => {
    const result = allocateBalances([sugar], [
      { warehouseId: 'empty', variantId: 'sugar', available: 0 },
      { warehouseId: 'bad', variantId: 'sugar', available: -5 },
    ])[0]!;
    expect(result.allocations).toEqual([]);
    expect(result.shortageQuantity).toBe(100);
  });
});
