import { z } from 'zod';

const email = z.string().trim().toLowerCase().email().max(320);
const password = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(128)
  .regex(/[a-zA-Z]/, 'Password must contain a letter')
  .regex(/[0-9]/, 'Password must contain a number');

export const registerSchema = z.object({
  organizationName: z.string().trim().min(2).max(120),
  businessType: z
    .enum([
      'ECOMMERCE', 'RETAIL', 'MANUFACTURING', 'DISTRIBUTION', 'WHOLESALE',
      'SUPERMARKET', 'FOOD', 'REAL_ESTATE', 'SERVICES', 'PHARMACY',
      'HOSPITAL', 'SCHOOL', 'OTHER',
    ])
    .default('ECOMMERCE'),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  email,
  password,
  // Location hints from the browser. All optional — signup must never fail
  // because we couldn't work out where someone is; it falls back to Naira.
  /** IANA timezone, e.g. "Africa/Lagos". */
  timezone: z.string().trim().max(64).optional(),
  /** BCP-47 locale, e.g. "en-NG". */
  locale: z.string().trim().max(35).optional(),
  /** An explicit choice from the signup form; overrides detection. */
  currency: z.string().trim().length(3).toUpperCase().optional(),
});

export const loginSchema = z.object({
  email,
  password: z.string().min(1).max(128),
});

export const mfaVerifySchema = z.object({
  mfaToken: z.string().min(10),
  code: z.string().trim().regex(/^\d{6}$|^[A-Za-z0-9-]{10,}$/, 'Provide a 6-digit code or a backup code'),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(10).optional(), // cookie fallback handled in controller
});

export const forgotPasswordSchema = z.object({ email });

export const resetPasswordSchema = z.object({
  token: z.string().min(10),
  password,
});

export const verifyEmailSchema = z.object({ token: z.string().min(10) });

export const twoFaEnableSchema = z.object({
  code: z.string().trim().regex(/^\d{6}$/, 'Provide the 6-digit code'),
});

export const twoFaDisableSchema = z.object({
  password: z.string().min(1),
  code: z.string().trim().regex(/^\d{6}$/, 'Provide the 6-digit code'),
});

/** Creating an additional business for an already-registered user. */
export const createOrganizationSchema = registerSchema
  .pick({ businessType: true, timezone: true, locale: true, currency: true })
  .extend({
    name: z.string().trim().min(2).max(120),
  });

export const switchOrganizationSchema = z.object({
  organizationId: z.string().min(1),
});

export type RegisterDto = z.infer<typeof registerSchema>;
export type CreateOrganizationDto = z.infer<typeof createOrganizationSchema>;
export type SwitchOrganizationDto = z.infer<typeof switchOrganizationSchema>;
export type LoginDto = z.infer<typeof loginSchema>;
export type MfaVerifyDto = z.infer<typeof mfaVerifySchema>;
export type ForgotPasswordDto = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordDto = z.infer<typeof resetPasswordSchema>;
export type VerifyEmailDto = z.infer<typeof verifyEmailSchema>;
export type TwoFaEnableDto = z.infer<typeof twoFaEnableSchema>;
export type TwoFaDisableDto = z.infer<typeof twoFaDisableSchema>;
