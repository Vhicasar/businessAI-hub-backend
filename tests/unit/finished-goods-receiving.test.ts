import { describe, expect, it } from 'vitest';
import { deriveFinishedGoodsReceiptState, validateFinishedGoodsAllocation, validateFinishedGoodsReceipt } from '../../src/application/manufacturing/finished-goods-receipts.service';

describe('finished goods receiving rules', () => {
  it('supports one destination and pending unallocated stock', () => {
    expect(validateFinishedGoodsAllocation(9800, [{ warehouseId: 'main', quantity: 5000 }])).toEqual({ total: 5000, unallocated: 4800 });
  });

  it('supports deterministic multi-warehouse totals', () => {
    expect(validateFinishedGoodsAllocation(9800, [{ warehouseId: 'main', quantity: 5000 }, { warehouseId: 'lagos', quantity: 3000 }, { warehouseId: 'abuja', quantity: 1800 }])).toEqual({ total: 9800, unallocated: 0 });
  });

  it('rejects duplicate warehouses and over-allocation', () => {
    expect(() => validateFinishedGoodsAllocation(100, [{ warehouseId: 'a', quantity: 60 }, { warehouseId: 'a', quantity: 40 }])).toThrow(/duplicate/i);
    expect(() => validateFinishedGoodsAllocation(100, [{ warehouseId: 'a', quantity: 101 }])).toThrow(/exceeds/i);
  });

  it('allows partial receipts only with a discrepancy reason', () => {
    expect(() => validateFinishedGoodsReceipt(3000, 2950)).toThrow(/reason/i);
    expect(validateFinishedGoodsReceipt(3000, 2950, '50 cases not delivered')).toEqual({ nextOutstanding: 50, partial: true });
  });

  it('rejects over-receipt and closes an exact receipt', () => {
    expect(() => validateFinishedGoodsReceipt(50, 51)).toThrow(/50 remains/i);
    expect(validateFinishedGoodsReceipt(50, 50)).toEqual({ nextOutstanding: 0, partial: false });
  });

  it('does not mark a partially allocated parent received when its current task is complete', () => {
    expect(deriveFinishedGoodsReceiptState(100, [{ allocatedQuantity: 60, receivedQuantity: 60 }])).toEqual({ allocated: 60, received: 60, status: 'PARTIALLY_RECEIVED' });
  });

  it('marks the parent received only after every approved unit is allocated and received', () => {
    expect(deriveFinishedGoodsReceiptState(100, [{ allocatedQuantity: 60, receivedQuantity: 60 }, { allocatedQuantity: 40, receivedQuantity: 40 }])).toEqual({ allocated: 100, received: 100, status: 'RECEIVED' });
  });
});
