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

    /**
     * Redis connection for BullMQ queues. When unset, workflow dispatch and
     * campaign sends run inline (single-process) instead of async workers.
     */
    REDIS_URL: z.string().optional().or(z.literal('')),

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
    MAIL_FROM: z.string().default('Vhicasar Hub AI <no-reply@vhicasar.com>'),

    // --- Push notifications (Firebase Cloud Messaging) ---
    // Provide the Firebase Admin service account as an inline JSON string OR a
    // path to the JSON key file. When neither is set, push is disabled and the
    // app falls back to in-app + realtime notifications only.
    FIREBASE_SERVICE_ACCOUNT: z.string().optional().or(z.literal('')),
    FIREBASE_SERVICE_ACCOUNT_PATH: z.string().optional().or(z.literal('')),
    /** Raw resource / file name (no extension) of the custom notification sound. */
    PUSH_SOUND: z.string().default('notification'),

    // --- File storage ---
    // Cloudflare R2 in production (S3-compatible); local disk for dev so the
    // upload features work with no cloud credentials. 'auto' picks R2 when its
    // vars are set, else local.
    STORAGE_DRIVER: z.enum(['local', 'r2', 'auto']).default('auto'),
    R2_ACCOUNT_ID: z.string().optional().or(z.literal('')),
    R2_ACCESS_KEY_ID: z.string().optional().or(z.literal('')),
    R2_SECRET_ACCESS_KEY: z.string().optional().or(z.literal('')),
    R2_BUCKET: z.string().optional().or(z.literal('')),
    /** Public base URL for the bucket (a custom domain or the r2.dev URL). */
    R2_PUBLIC_URL: z.string().url().optional().or(z.literal('')),
    /**
     * Base URL for locally-stored files. Defaults to the relative path
     * "/uploads" so image URLs resolve against whatever origin serves the app
     * (works in dev behind the Vite proxy and in prod behind one reverse proxy)
     * — instead of a fixed API_BASE_URL that may be an ngrok/tunnel host.
     */
    STORAGE_LOCAL_BASE_URL: z.string().optional().or(z.literal('')),
    UPLOAD_DIR: z.string().default('./uploads'),
    MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(50).default(10),

    // --- AI (provider-agnostic; 'none' disables all AI features gracefully) ---
    AI_PROVIDER: z.enum(['none', 'anthropic', 'openai']).default('none'),
    AI_API_KEY: z.string().optional().or(z.literal('')),
    AI_MODEL: z.string().optional().or(z.literal('')),
    /** For OpenAI-compatible servers (Ollama, vLLM, OpenRouter…). */
    AI_BASE_URL: z.string().optional().or(z.literal('')),

    // --- Billing (optional; billing degrades to manual mode if unset) ---
    // The admin (Vhicasar) is the source of truth for the active provider and
    // its keys when payment-config sync is on; these env vars are the local
    // fallback used when the admin has nothing configured or is unreachable.
    BILLING_CURRENCY: z.string().length(3).default('NGN'),
    /** Local fallback provider when the admin hasn't chosen one. */
    BILLING_PROVIDER: z.enum(['paystack', 'flutterwave', 'stripe']).default('paystack'),
    /** Pull the active payment provider + keys from the admin service API. */
    ADMIN_PAYMENT_SYNC: z.string().default('true').transform((v) => v !== 'false'),
    PAYSTACK_SECRET_KEY: z.string().optional().or(z.literal('')),
    PAYSTACK_PUBLIC_KEY: z.string().optional().or(z.literal('')),
    FLUTTERWAVE_SECRET_KEY: z.string().optional().or(z.literal('')),
    FLUTTERWAVE_PUBLIC_KEY: z.string().optional().or(z.literal('')),
    /** Flutterwave webhook "Secret hash" (dashboard → Settings → Webhooks). */
    FLUTTERWAVE_SECRET_HASH: z.string().optional().or(z.literal('')),
    STRIPE_SECRET_KEY: z.string().optional().or(z.literal('')),
    // OAuth apps for calendar integrations. Registered once by the platform;
    // each business authorises its own account against them.
    GOOGLE_OAUTH_CLIENT_ID: z.string().optional().or(z.literal('')),
    GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional().or(z.literal('')),
    CALENDLY_OAUTH_CLIENT_ID: z.string().optional().or(z.literal('')),
    CALENDLY_OAUTH_CLIENT_SECRET: z.string().optional().or(z.literal('')),
    /** Where providers send the user back. Must match the app registration. */
    OAUTH_REDIRECT_BASE_URL: z.string().optional().or(z.literal('')),
    STRIPE_PUBLIC_KEY: z.string().optional().or(z.literal('')),
    /** Stripe webhook signing secret (whsec_…), for signature verification. */
    STRIPE_WEBHOOK_SECRET: z.string().optional().or(z.literal('')),
    /** Where Paystack redirects the customer after checkout. */
    BILLING_CALLBACK_URL: z.string().url().optional(),
    /**
     * Currencies this Paystack merchant account can actually settle. Defaults to
     * the settlement currency only, so a charge is never initialized in a
     * currency the merchant can't accept ("Currency not supported by merchant").
     * Widen it (comma-separated) if your account supports more, e.g. "NGN,USD".
     */
    PAYSTACK_CHARGE_CURRENCIES: z.string().optional().or(z.literal('')),

    // --- Foreign exchange ---
    FX_PROVIDER_URL: z.string().url().default('https://open.er-api.com/v6/latest'),
    FX_CACHE_TTL_MIN: z.coerce.number().int().min(1).default(60),
    FX_MAX_STALE_HOURS: z.coerce.number().int().min(1).default(24),

    // --- Vhicasar Admin (plan catalog = single source of truth) ---
    // When enabled, plans (prices + quota limits) are synced from the admin's
    // public pricing API into the local Plan table. Falls back to the local
    // catalog when the admin is unreachable.
    ADMIN_API_URL: z.string().url().default('http://localhost:4002'),
    ADMIN_TENANT_SLUG: z.string().default('businesshub-ai'),
    ADMIN_PLAN_SYNC: z.string().default('true').transform((v) => v !== 'false'),
    ADMIN_SYNC_INTERVAL_MIN: z.coerce.number().int().min(0).default(10),
    /**
     * Pull the AI provider config (provider, model, decrypted key, baseUrl) from
     * the admin's authenticated service API, overriding the local AI_* env. Needs
     * SERVICE_API_KEY (the shared secret). Falls back to AI_* when the admin has
     * nothing configured or is unreachable.
     */
    ADMIN_AI_SYNC: z.string().default('true').transform((v) => v !== 'false'),
    /**
     * Shared secret letting the Vhicasar Admin read this deployment's tenant
     * roster (/v1/service/organizations). Unset = the endpoint is disabled
     * entirely rather than open — an endpoint that lists every customer must
     * fail closed, never default to permissive.
     */
    SERVICE_API_KEY: z.string().min(24).optional().or(z.literal('')),

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
    /** Local fallback provider when the admin hasn't chosen an active one. */
    provider: raw.BILLING_PROVIDER,
    paystackSecretKey: raw.PAYSTACK_SECRET_KEY || '',
    paystackPublicKey: raw.PAYSTACK_PUBLIC_KEY || '',
    /** Paystack is usable locally only when a secret key is configured. */
    paystackEnabled: Boolean(raw.PAYSTACK_SECRET_KEY),
    flutterwaveSecretKey: raw.FLUTTERWAVE_SECRET_KEY || '',
    flutterwavePublicKey: raw.FLUTTERWAVE_PUBLIC_KEY || '',
    flutterwaveSecretHash: raw.FLUTTERWAVE_SECRET_HASH || '',
    flutterwaveEnabled: Boolean(raw.FLUTTERWAVE_SECRET_KEY),
    stripeSecretKey: raw.STRIPE_SECRET_KEY || '',
    stripePublicKey: raw.STRIPE_PUBLIC_KEY || '',
    stripeWebhookSecret: raw.STRIPE_WEBHOOK_SECRET || '',
    stripeEnabled: Boolean(raw.STRIPE_SECRET_KEY),
    /*
     * Where the gateway returns the customer after paying.
     *
     * `/billing` is the page itself. `/settings/billing` is an alias that
     * redirects to it, and a redirect is the wrong thing to hand a payment
     * gateway: the reference arrives as a query parameter, and forwarding a
     * customer to a bare path drops it. Deployments that already point at the
     * alias still work — the alias forwards its query now — but new ones
     * should land on the page directly.
     */
    callbackUrl: raw.BILLING_CALLBACK_URL || `${raw.WEB_APP_URL}/billing`,
    /** Currencies the merchant can settle; defaults to the settlement currency. */
    chargeCurrencies: (raw.PAYSTACK_CHARGE_CURRENCIES || raw.BILLING_CURRENCY)
      .split(',')
      .map((c) => c.trim().toUpperCase())
      .filter(Boolean),
    /** Pull active provider + keys from the admin (needs the service key). */
    adminSync: raw.ADMIN_PAYMENT_SYNC && Boolean(raw.SERVICE_API_KEY),
  },
  oauth: {
    /** Providers send the user here; the path is added per provider. */
    redirectBase: (raw.OAUTH_REDIRECT_BASE_URL || raw.API_BASE_URL).replace(/\/+$/, ''),
    google: {
      clientId: raw.GOOGLE_OAUTH_CLIENT_ID || '',
      clientSecret: raw.GOOGLE_OAUTH_CLIENT_SECRET || '',
      /** Without an app registered, the connect button must say so honestly. */
      configured: Boolean(raw.GOOGLE_OAUTH_CLIENT_ID && raw.GOOGLE_OAUTH_CLIENT_SECRET),
    },
    calendly: {
      clientId: raw.CALENDLY_OAUTH_CLIENT_ID || '',
      clientSecret: raw.CALENDLY_OAUTH_CLIENT_SECRET || '',
      configured: Boolean(raw.CALENDLY_OAUTH_CLIENT_ID && raw.CALENDLY_OAUTH_CLIENT_SECRET),
    },
  },
  fx: {
    providerUrl: raw.FX_PROVIDER_URL.replace(/\/+$/, ''),
    cacheTtlMs: raw.FX_CACHE_TTL_MIN * 60_000,
    maxStaleMs: raw.FX_MAX_STALE_HOURS * 3_600_000,
  },
  adminCatalog: {
    enabled: raw.ADMIN_PLAN_SYNC,
    apiUrl: raw.ADMIN_API_URL,
    tenantSlug: raw.ADMIN_TENANT_SLUG,
    intervalMin: raw.ADMIN_SYNC_INTERVAL_MIN,
  },
  adminAi: {
    // Needs the shared service key to authenticate to the admin's service API.
    enabled: raw.ADMIN_AI_SYNC && Boolean(raw.SERVICE_API_KEY),
    intervalMin: raw.ADMIN_SYNC_INTERVAL_MIN,
  },
  service: {
    apiKey: raw.SERVICE_API_KEY || '',
    /** The service API only exists when a key is configured. */
    enabled: Boolean(raw.SERVICE_API_KEY),
  },
  storage: (() => {
    const r2Ready = Boolean(
      raw.R2_ACCOUNT_ID && raw.R2_ACCESS_KEY_ID && raw.R2_SECRET_ACCESS_KEY && raw.R2_BUCKET,
    );
    const driver = raw.STORAGE_DRIVER === 'auto' ? (r2Ready ? 'r2' : 'local') : raw.STORAGE_DRIVER;
    return {
      driver: driver as 'local' | 'r2',
      maxBytes: raw.MAX_UPLOAD_MB * 1024 * 1024,
      local: {
        dir: raw.UPLOAD_DIR,
        // Relative by default so URLs resolve against the serving origin (dev
        // proxy or prod reverse proxy); override with STORAGE_LOCAL_BASE_URL.
        baseUrl: (raw.STORAGE_LOCAL_BASE_URL || '/uploads').replace(/\/+$/, ''),
      },
      r2: {
        accountId: raw.R2_ACCOUNT_ID || '',
        accessKeyId: raw.R2_ACCESS_KEY_ID || '',
        secretAccessKey: raw.R2_SECRET_ACCESS_KEY || '',
        bucket: raw.R2_BUCKET || '',
        publicUrl: raw.R2_PUBLIC_URL || '',
        endpoint: raw.R2_ACCOUNT_ID ? `https://${raw.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : '',
      },
    };
  })(),
  jwt: {
    alg: raw.JWT_ALG,
    signKey: keys.signKey,
    verifyKey: keys.verifyKey,
    accessTtl: raw.ACCESS_TOKEN_TTL,
    refreshTtlDays: raw.REFRESH_TOKEN_TTL_DAYS,
  },
  push: {
    enabled: Boolean(raw.FIREBASE_SERVICE_ACCOUNT || raw.FIREBASE_SERVICE_ACCOUNT_PATH),
    serviceAccountJson: raw.FIREBASE_SERVICE_ACCOUNT || '',
    serviceAccountPath: raw.FIREBASE_SERVICE_ACCOUNT_PATH || '',
    sound: raw.PUSH_SOUND,
  },
} as const;

export type Env = typeof env;
