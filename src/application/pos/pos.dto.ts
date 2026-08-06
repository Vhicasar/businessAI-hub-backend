import { z } from 'zod';

const amount = z
  .union([z.number(), z.string()])
  .transform((v) => String(v))
  .refine((v) => /^\d+(\.\d{1,2})?$/.test(v) && Number(v) >= 0, 'Enter a valid amount');
const currency = z.string().trim().length(3).toUpperCase();

export const createRegisterSchema = z.object({
  name: z.string().trim().min(1).max(80),
  code: z.string().trim().min(1).max(30),
  branchId: z.string().trim().optional(),
});
export type CreateRegisterDto = z.infer<typeof createRegisterSchema>;

export const updateRegisterSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
});
export type UpdateRegisterDto = z.infer<typeof updateRegisterSchema>;

export const openShiftSchema = z.object({
  registerId: z.string().trim().min(1),
  openingFloat: amount.default('0'),
  currency: currency.default('NGN'),
});
export type OpenShiftDto = z.infer<typeof openShiftSchema>;

export const closeShiftSchema = z.object({
  countedCash: amount,
  notes: z.string().trim().max(500).optional(),
});
export type CloseShiftDto = z.infer<typeof closeShiftSchema>;

export const cashMovementSchema = z.object({
  type: z.enum(['PAYIN', 'PAYOUT', 'REFUND', 'DROP']),
  amount,
  reason: z.string().trim().max(200).optional(),
});
export type CashMovementDto = z.infer<typeof cashMovementSchema>;

export const cashSaleSchema = z.object({
  amount,
  currency: currency.default('NGN'),
  customerVhicasarId: z.string().trim().optional(),
});
export type CashSaleDto = z.infer<typeof cashSaleSchema>;

export const payCheckoutSchema = z.object({
  amount,
  currency: currency.default('NGN'),
  description: z.string().trim().max(200).optional(),
  expiresInSec: z.coerce.number().int().min(30).max(3600).default(300),
});
export type PayCheckoutDto = z.infer<typeof payCheckoutSchema>;
