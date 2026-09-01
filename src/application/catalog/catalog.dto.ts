import { z } from 'zod';

export const listProductsSchema = z.object({
  search: z.string().trim().max(120).optional(),
  categoryId: z.string().optional(),
  brandId: z.string().optional(),
  status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const variantSchema = z.object({
  sku: z.string().trim().min(1).max(64),
  barcode: z.string().trim().max(64).nullable().optional(),
  name: z.string().trim().max(120).nullable().optional(),
  options: z.record(z.string()).nullable().optional(),
  price: z.coerce.number().nonnegative(),
  compareAtPrice: z.coerce.number().nonnegative().nullable().optional(),
  costPrice: z.coerce.number().nonnegative().nullable().optional(),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
  /** Per-variant photo — an already-uploaded File id (see /files). */
  imageFileId: z.string().min(1).nullable().optional(),
  // Opening stock booked into the default warehouse on create (products/variants only).
  initialStock: z.coerce.number().min(0).max(1_000_000).optional(),
});

export const productImageSchema = z.object({
  fileId: z.string().min(1),
  altText: z.string().trim().max(200).nullable().optional(),
});

export const reorderImagesSchema = z.object({
  /** Image ids in the order they should appear. */
  order: z.array(z.string().min(1)).min(1),
});

export const createProductSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).nullable().optional(),
  categoryId: z.string().nullable().optional(),
  brandId: z.string().nullable().optional(),
  status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']).default('ACTIVE'),
  taxRate: z.coerce.number().min(0).max(100).default(0),
  /**
   * How this product is counted — "kg", "bag", "case". Free text, because a
   * business's own vocabulary is what its warehouse staff read on the shelf.
   * Readable since the batch/expiry work; this is what makes it settable.
   */
  unit: z.string().trim().max(24).nullable().optional(),
  /** Arbitrary extras — e.g. the source system's id when importing. */
  customFields: z.record(z.unknown()).optional(),
  variants: z.array(variantSchema).min(1),
});

export const updateProductSchema = createProductSchema
  .omit({ variants: true })
  .partial();

export const namedEntitySchema = z.object({
  name: z.string().trim().min(1).max(120),
});

export type ListProductsDto = z.infer<typeof listProductsSchema>;
export type VariantDto = z.infer<typeof variantSchema>;
export type CreateProductDto = z.infer<typeof createProductSchema>;
export type UpdateProductDto = z.infer<typeof updateProductSchema>;
export type ProductImageDto = z.infer<typeof productImageSchema>;
export type ReorderImagesDto = z.infer<typeof reorderImagesSchema>;
