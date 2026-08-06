import { z } from 'zod';

const amount = z
  .union([z.number(), z.string()])
  .transform((v) => String(v))
  .refine((v) => /^\d+(\.\d{1,2})?$/.test(v) && Number(v) > 0, 'Enter a valid amount');

const currency = z.string().trim().length(3).toUpperCase();
// 4–8 digits, matching PIN_POLICY. Optional at the schema level because
// adaptive authentication may not ask for it — transactionSecurity.authorize()
// is what decides, and it rejects the request when a PIN was actually needed.
const pin = z.string().regex(/^\d{4,8}$/, 'PIN must be 4–8 digits');

/** Fields every PIN-gated request may carry, so the gate can apply policy. */
const authFields = {
  pin: pin.optional(),
  deviceId: z.string().trim().max(200).optional(),
  /** The client asserts a successful local biometric check. */
  biometricAsserted: z.boolean().optional(),
};

// ---- Consumer (Super App) ----

export const topUpSchema = z.object({
  amount,
  currency,
  reference: z.string().trim().max(120).optional(),
});
export type TopUpDto = z.infer<typeof topUpSchema>;

export const transferSchema = z.object({
  toPublicId: z.string().trim().max(40).optional(),
  toPhone: z.string().trim().max(20).optional(),
  amount,
  currency,
  ...authFields,
  note: z.string().trim().max(140).optional(),
}).refine((v) => v.toPublicId || v.toPhone, {
  message: 'Provide the recipient’s Vhicasar ID or phone number',
});
export type TransferDto = z.infer<typeof transferSchema>;

export const confirmPaymentSchema = z.object({
  sessionToken: z.string().trim().min(10).max(200),
  ...authFields,
  /** Server-issued single-use challenge (see POST /payments/nonce). */
  nonce: z.string().trim().max(200).optional(),
  /** Base64 signature over sessionToken.nonce.amount.currency by the device key. */
  signature: z.string().trim().max(1000).optional(),
});
export type ConfirmPaymentDto = z.infer<typeof confirmPaymentSchema>;

// ---- Merchant (Business Admin) ----

export const createSessionSchema = z.object({
  amount,
  currency,
  description: z.string().trim().max(200).optional(),
  reference: z.string().trim().max(120).optional(),
  method: z.enum(['WALLET', 'CARD', 'BANK_TRANSFER']).default('WALLET'),
  branchId: z.string().trim().optional(),
  registerId: z.string().trim().optional(),
  /** Session lifetime in seconds (default 300, max 3600). */
  expiresInSec: z.coerce.number().int().min(30).max(3600).default(300),
});
export type CreateSessionDto = z.infer<typeof createSessionSchema>;

export const createSettlementSchema = z.object({
  currency,
});
export type CreateSettlementDto = z.infer<typeof createSettlementSchema>;

export const openChargebackSchema = z.object({
  paymentId: z.string().trim().min(1),
  amount,
  currency,
  reason: z.string().trim().max(300).optional(),
});
export type OpenChargebackDto = z.infer<typeof openChargebackSchema>;
