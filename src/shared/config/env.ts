import 'dotenv/config';
import { readFileSync } from 'fs';
import { z } from 'zod';

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    API_BASE_URL: z.string().url().default('http://localhost:4000'),
    WEB_APP_URL: z.string().url().default('http://localhost:5173'),

    DATABASE_URL: z.string().min(1),

    JWT_ALG: z.enum(['HS256', 'RS256']).default('HS256'),
    JWT_SECRET: z.string().min(32).optional(),
    JWT_PRIVATE_KEY_PATH: z.string().optional(),
    JWT_PUBLIC_KEY_PATH: z.string().optional(),
    ACCESS_TOKEN_TTL: z.string().default('15m'),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

    ENCRYPTION_KEY: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY must be 32 bytes hex (64 hex chars)'),

    CORS_ORIGINS: z.string().default('http://localhost:5173'),

    SMTP_HOST: z.string().optional().or(z.literal('')),
    SMTP_PORT: z.coerce.number().int().default(587),
    SMTP_SECURE: z
      .string()
      .default('false')
      .transform((v) => v === 'true'),
    SMTP_USER: z.string().optional().or(z.literal('')),
    SMTP_PASS: z.string().optional().or(z.literal('')),
    MAIL_FROM: z.string().default('BusinessHub AI <no-reply@businesshub.local>'),

    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    STORAGE_LOCAL_ROOT: z.string().default('./storage'),

    // --- AI (provider-agnostic; 'none' disables all AI features gracefully) ---
    AI_PROVIDER: z.enum(['none', 'anthropic', 'openai']).default('none'),
    AI_API_KEY: z.string().optional().or(z.literal('')),
    AI_MODEL: z.string().optional().or(z.literal('')),
    /** For OpenAI-compatible servers (Ollama, vLLM, OpenRouter…). */
    AI_BASE_URL: z.string().optional().or(z.literal('')),

    // --- Billing / Paystack (optional; billing degrades to manual mode if unset) ---
    BILLING_CURRENCY: z.string().length(3).default('NGN'),
    PAYSTACK_SECRET_KEY: z.string().optional().or(z.literal('')),
    PAYSTACK_PUBLIC_KEY: z.string().optional().or(z.literal('')),
    /** Where Paystack redirects the customer after checkout. */
    BILLING_CALLBACK_URL: z.string().url().optional(),

    // --- Vhicasar Admin (plan catalog = single source of truth) ---
    // When enabled, plans (prices + quota limits) are synced from the admin's
    // public pricing API into the local Plan table. Falls back to the local
    // catalog when the admin is unreachable.
    ADMIN_API_URL: z.string().url().default('http://localhost:4002'),
    ADMIN_TENANT_SLUG: z.string().default('businesshub-ai'),
    ADMIN_PLAN_SYNC: z.string().default('true').transform((v) => v !== 'false'),
    ADMIN_SYNC_INTERVAL_MIN: z.coerce.number().int().min(0).default(10),

    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.JWT_ALG === 'HS256' && !cfg.JWT_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_SECRET'],
        message: 'JWT_SECRET is required when JWT_ALG=HS256',
      });
    }
    if (cfg.JWT_ALG === 'RS256' && (!cfg.JWT_PRIVATE_KEY_PATH || !cfg.JWT_PUBLIC_KEY_PATH)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_PRIVATE_KEY_PATH'],
        message: 'JWT_PRIVATE_KEY_PATH and JWT_PUBLIC_KEY_PATH are required when JWT_ALG=RS256',
      });
    }
  });

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('❌ Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    // eslint-disable-next-line no-console
    console.error(`   ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

const raw = parsed.data;

function loadKeys(): { signKey: string; verifyKey: string } {
  if (raw.JWT_ALG === 'RS256') {
    return {
      signKey: readFileSync(raw.JWT_PRIVATE_KEY_PATH as string, 'utf8'),
      verifyKey: readFileSync(raw.JWT_PUBLIC_KEY_PATH as string, 'utf8'),
    };
  }
  return { signKey: raw.JWT_SECRET as string, verifyKey: raw.JWT_SECRET as string };
}

const keys = loadKeys();

export const env = {
  ...raw,
  isProd: raw.NODE_ENV === 'production',
  isDev: raw.NODE_ENV === 'development',
  corsOrigins: raw.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean),
  billing: {
    currency: raw.BILLING_CURRENCY.toUpperCase(),
    paystackSecretKey: raw.PAYSTACK_SECRET_KEY || '',
    paystackPublicKey: raw.PAYSTACK_PUBLIC_KEY || '',
    /** Paystack is usable only when a secret key is configured. */
    paystackEnabled: Boolean(raw.PAYSTACK_SECRET_KEY),
    callbackUrl: raw.BILLING_CALLBACK_URL || `${raw.WEB_APP_URL}/settings/billing`,
  },
  adminCatalog: {
    enabled: raw.ADMIN_PLAN_SYNC,
    apiUrl: raw.ADMIN_API_URL,
    tenantSlug: raw.ADMIN_TENANT_SLUG,
    intervalMin: raw.ADMIN_SYNC_INTERVAL_MIN,
  },
  jwt: {
    alg: raw.JWT_ALG,
    signKey: keys.signKey,
    verifyKey: keys.verifyKey,
    accessTtl: raw.ACCESS_TOKEN_TTL,
    refreshTtlDays: raw.REFRESH_TOKEN_TTL_DAYS,
  },
} as const;

export type Env = typeof env;
