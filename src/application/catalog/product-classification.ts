/**
 * Prisma translates `not: RAW_MATERIAL` to SQL inequality. SQL does not treat
 * NULL as unequal, so ordinary products (whose manufacturingType is NULL)
 * disappear unless NULL is included explicitly.
 */
export const nonRawMaterialProductWhere: Prisma.ProductWhereInput = {
  OR: [
    { manufacturingType: null },
    { manufacturingType: { not: 'RAW_MATERIAL' } },
  ],
};

export function productKindWhere(itemKind: 'PRODUCT' | 'RAW_MATERIAL' | 'ALL'): Prisma.ProductWhereInput {
  if (itemKind === 'RAW_MATERIAL') return { manufacturingType: 'RAW_MATERIAL' };
  if (itemKind === 'PRODUCT') return nonRawMaterialProductWhere;
  return {};
}
import type { Prisma } from '@prisma/client';
