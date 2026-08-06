import { z } from 'zod';

/**
 * A phone number as a person actually types it.
 *
 * Deliberately permissive: `08055512345`, `+234 805 551 2345`, `234-805-551-2345`
 * and `8055512345` are all the same number, and rejecting any of them at the
 * edge only teaches customers that the app is broken. `normalizePhone` folds
 * them into E.164 before anything is stored or compared, and *that* is where
 * the shape is enforced.
 */
const phone = z
  .string()
  .trim()
  .min(6, 'Enter your phone number')
  .max(24)
  .regex(/^[+0-9][0-9\s().-]{5,}$/, 'Enter a valid phone number');

/**
 * What someone may sign in with: a phone in any spelling, an email, or their
 * Vhicasar ID. Validation is loose on purpose — the resolver decides what it
 * is, and a wrong guess must produce "invalid credentials", not a form error
 * that tells an attacker which identifiers are real.
 */
const loginIdentifier = z.string().trim().min(3).max(120);

// ---- Customer Super App (consumer) identity ----

export const registerIdentitySchema = z.object({
  phone,
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().max(80).optional(),
  email: z.string().trim().toLowerCase().email().optional(),
  password: z.string().min(8).max(128),
  country: z.string().trim().length(2).toUpperCase().optional(),
  locale: z.string().trim().max(10).optional(),
});
export type RegisterIdentityDto = z.infer<typeof registerIdentitySchema>;

export const loginIdentitySchema = z.object({
  /** Phone (any format), email, or Vhicasar ID. Named `phone` for compatibility. */
  phone: loginIdentifier,
  password: z.string().min(1).max(128),
  /** Helps interpret a number typed without a country code. */
  country: z.string().trim().length(2).toUpperCase().optional(),
});
export type LoginIdentityDto = z.infer<typeof loginIdentitySchema>;

export const setPinSchema = z.object({
  pin: z.string().regex(/^\d{4,6}$/, 'PIN must be 4–6 digits'),
});
export type SetPinDto = z.infer<typeof setPinSchema>;

export const registerDeviceSchema = z.object({
  deviceId: z.string().trim().min(8).max(200),
  platform: z.enum(['android', 'ios', 'web']),
  model: z.string().trim().max(120).optional(),
  osVersion: z.string().trim().max(60).optional(),
  appVersion: z.string().trim().max(40).optional(),
  /** Base64 public key for signing payment confirmations (private key stays on device). */
  publicKey: z.string().trim().max(2000).optional(),
  pushToken: z.string().trim().max(500).optional(),
  isBiometricEnabled: z.boolean().optional(),
});
export type RegisterDeviceDto = z.infer<typeof registerDeviceSchema>;

// ---- Business Admin side: associating a Customer with a Vhicasar ID ----

export const linkCustomerSchema = z.object({
  /** Link to an existing Vhicasar ID by its public id or phone. */
  vhicasarPublicId: z.string().trim().max(40).optional(),
  phone: phone.optional(),
}).refine((v) => v.vhicasarPublicId || v.phone, {
  message: 'Provide the customer’s Vhicasar ID or phone number',
});
export type LinkCustomerDto = z.infer<typeof linkCustomerSchema>;

// ---- Sessions ----

export const refreshTokenSchema = z.object({
  refreshToken: z.string().trim().min(20).max(500),
});
export type RefreshTokenDto = z.infer<typeof refreshTokenSchema>;

// ---- KYC ----

export const submitKycSchema = z.object({
  documentType: z.enum(['NIN', 'BVN', 'PASSPORT', 'DRIVERS_LICENSE', 'VOTER_ID']),
  documentNumber: z.string().trim().min(4).max(64),
  fullName: z.string().trim().min(2).max(160),
  dateOfBirth: z.coerce.date().optional(),
  address: z.string().trim().max(300).optional(),
  documentFileId: z.string().trim().max(60).optional(),
  selfieFileId: z.string().trim().max(60).optional(),
});
export type SubmitKycDto = z.infer<typeof submitKycSchema>;

export const reviewKycSchema = z.object({
  action: z.enum(['APPROVED', 'REJECTED']),
  level: z.enum(['BASIC', 'VERIFIED']).optional(),
  notes: z.string().trim().max(500).optional(),
});
export type ReviewKycDto = z.infer<typeof reviewKycSchema>;

// ---- Payout destinations ----

export const payoutAccountSchema = z.object({
  type: z.enum(['BANK_ACCOUNT', 'MOBILE_MONEY']).default('BANK_ACCOUNT'),
  accountName: z.string().trim().min(2).max(160),
  accountNumber: z.string().trim().min(6).max(34),
  bankCode: z.string().trim().max(20).optional(),
  bankName: z.string().trim().max(120).optional(),
  currency: z.string().trim().length(3).toUpperCase(),
  country: z.string().trim().length(2).toUpperCase().optional(),
  isDefault: z.boolean().optional(),
});
export type PayoutAccountDto = z.infer<typeof payoutAccountSchema>;

export const withdrawSchema = z.object({
  amount: z.coerce.number().positive().max(100_000_000),
  currency: z.string().trim().length(3).toUpperCase(),
  payoutAccountId: z.string().trim().min(1),
  // Optional here so adaptive auth can decide; a withdrawal always requires it
  // in practice (PIN_ACTIONS.WALLET_WITHDRAWAL is alwaysRequired).
  pin: z.string().regex(/^\d{4,8}$/).optional(),
  deviceId: z.string().trim().max(200).optional(),
  biometricAsserted: z.boolean().optional(),
  idempotencyKey: z.string().trim().max(100).optional(),
});
export type WithdrawDto = z.infer<typeof withdrawSchema>;
