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
});

export const createProductSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).nullable().optional(),
  categoryId: z.string().nullable().optional(),
  brandId: z.string().nullable().optional(),
  status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']).default('ACTIVE'),
  taxRate: z.coerce.number().min(0).max(100).default(0),
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
