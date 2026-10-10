import { describe, expect, it } from 'vitest';
import { createProductionOrderSchema } from '../../src/application/manufacturing/production-orders.service';
import { recordOutputSchema } from '../../src/application/manufacturing/production-output.service';
import { canCompleteProduction, canRecordProduction, canStartProduction } from '../../src/application/manufacturing/production-guards';
import { createProductSchema, listProductsSchema } from '../../src/application/catalog/catalog.dto';
import { listStockSchema } from '../../src/application/inventory/inventory.service';

const validOrder = {
  warehouseId: 'raw-store',
  finishedWarehouseId: 'finished-store',
  plannedQuantity: 100,
  actualQuantity: 0,
  materials: [
    { requiredQuantity: 10, issuedQuantity: 10, receivedQuantity: 10 },
    { requiredQuantity: 2, issuedQuantity: 2, receivedQuantity: 2 },
  ],
};

describe('manufacturing domain guards', () => {
  it('requires destination while keeping source as an optional allocation preference', () => {
    const base = { productId: 'p1', plannedQuantity: 100 };
    expect(createProductionOrderSchema.safeParse(base).success).toBe(false);
    expect(createProductionOrderSchema.safeParse({ ...base, warehouseId: 'raw' }).success).toBe(false);
    expect(createProductionOrderSchema.safeParse({ ...base, finishedWarehouseId: 'finished' }).success).toBe(true);
    expect(createProductionOrderSchema.safeParse({ ...base, warehouseId: 'raw', finishedWarehouseId: 'finished' }).success).toBe(true);
  });

  it('treats blank and whitespace batch input as automatic generation', () => {
    expect(recordOutputSchema.parse({ producedQuantity: 1 }).batchNumber).toBeUndefined();
    expect(recordOutputSchema.parse({ producedQuantity: 1, batchNumber: '   ' }).batchNumber).toBe('');
    expect(recordOutputSchema.parse({ producedQuantity: 1, batchNumber: ' MANUAL-1 ' }).batchNumber).toBe('MANUAL-1');
  });

  it('blocks starting and recording before each required material has an issue', () => {
    const missing = { ...validOrder, materials: [{ requiredQuantity: 10, issuedQuantity: 0, receivedQuantity: 0 }] };
    expect(canStartProduction(missing)).toMatchObject({ allowed: false, code: 'MATERIALS_NOT_ISSUED' });
    expect(canRecordProduction(missing, 1)).toMatchObject({ allowed: false, code: 'MATERIALS_NOT_ISSUED' });
  });

  it('allows proportional partial production but blocks output beyond issued materials', () => {
    const partial = {
      ...validOrder,
      materials: [
        { requiredQuantity: 10, issuedQuantity: 5, receivedQuantity: 5 },
        { requiredQuantity: 2, issuedQuantity: 1.5, receivedQuantity: 1.5 },
      ],
    };
    expect(canRecordProduction(partial, 50)).toMatchObject({ allowed: true, maximumOutput: 50 });
    expect(canRecordProduction(partial, 50.001)).toMatchObject({ allowed: false, code: 'MATERIALS_PARTIALLY_ISSUED', maximumOutput: 50 });
  });

  it('requires output and full material issue before completion', () => {
    expect(canCompleteProduction(validOrder)).toMatchObject({ allowed: false, code: 'NO_OUTPUT_RECORDED' });
    expect(canCompleteProduction({ ...validOrder, actualQuantity: 100 })).toEqual({ allowed: true });
    expect(canCompleteProduction({ ...validOrder, actualQuantity: 50, materials: [{ requiredQuantity: 10, issuedQuantity: 5, receivedQuantity: 5 }] }))
      .toMatchObject({ allowed: false, code: 'MATERIALS_PARTIALLY_ISSUED' });
  });
});

describe('raw-material classification contracts', () => {
  it('accepts explicit raw-material creation without making purchasing dependent on sales', () => {
    const parsed = createProductSchema.parse({
      name: 'Sugar', manufacturingType: 'RAW_MATERIAL', purchaseEnabled: true,
      sellable: false, variants: [{ sku: 'SUGAR', price: 0 }],
    });
    expect(parsed.manufacturingType).toBe('RAW_MATERIAL');
    expect(parsed.purchaseEnabled).toBe(true);
    expect(parsed.sellable).toBe(false);
  });

  it('defaults catalog and inventory reads to products and supports an explicit raw-material view', () => {
    expect(listProductsSchema.parse({}).itemKind).toBe('PRODUCT');
    expect(listProductsSchema.parse({ itemKind: 'RAW_MATERIAL' }).itemKind).toBe('RAW_MATERIAL');
    expect(listStockSchema.parse({}).itemKind).toBe('PRODUCT');
    expect(listStockSchema.parse({ itemKind: 'RAW_MATERIAL' }).itemKind).toBe('RAW_MATERIAL');
  });
});
