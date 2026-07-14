import { z } from 'zod';

export const listCustomersSchema = z.object({
  search: z.string().trim().max(120).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const base = {
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().max(80).nullable().optional(),
  email: z.string().trim().toLowerCase().email().max(320).nullable().optional(),
  phone: z.string().trim().max(32).nullable().optional(),
  language: z.string().trim().max(10).nullable().optional(),
  marketingOptIn: z.boolean().optional(),
  customFields: z.record(z.unknown()).optional(),
};

export const createCustomerSchema = z
  .object(base)
  .refine((d) => d.email || d.phone, { message: 'Provide at least an email or a phone number' });

export const updateCustomerSchema = z.object({
  ...Object.fromEntries(
    Object.entries(base).map(([k, v]) => [k, (v as z.ZodTypeAny).optional()])
  ),
  isBlocked: z.boolean().optional(),
}) as z.ZodType<Partial<z.infer<typeof createCustomerSchema>> & { isBlocked?: boolean }>;

export const addressSchema = z.object({
  label: z.string().trim().max(40).nullable().optional(),
  addressLine1: z.string().trim().min(1).max(200),
  addressLine2: z.string().trim().max(200).nullable().optional(),
  city: z.string().trim().min(1).max(100),
  state: z.string().trim().max(100).nullable().optional(),
  country: z.string().trim().length(2).toUpperCase(),
  postalCode: z.string().trim().max(20).nullable().optional(),
  isDefault: z.boolean().optional(),
});

export type ListCustomersDto = z.infer<typeof listCustomersSchema>;
export type CreateCustomerDto = z.infer<typeof createCustomerSchema>;
export type UpdateCustomerDto = z.infer<typeof updateCustomerSchema>;
export type AddressDto = z.infer<typeof addressSchema>;
