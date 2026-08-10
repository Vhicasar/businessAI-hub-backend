import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { prisma, prismaUnscoped } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { encrypt, decrypt } from '../../shared/crypto';
import { logger } from '../../shared/logger';
import { env } from '../../shared/config/env';
import {
  buildPaymentProvider,
  type PaymentProvider,
  type ResolvedPaymentConfig,
} from '../../infrastructure/payments';
import { MERCHANT_ID_LABEL } from '../../infrastructure/payments/capabilities';

/**
 * Per-organization payment account (#13). Lets each tenant connect *their own*
 * Paystack/Flutterwave keys so customer-facing collections (payment links)
 * settle into the tenant's account instead of the platform's. Stored on
 * `Organization.settings.paymentAccount`; the secret + webhook keys are
 * encrypted at rest (AES-256-GCM). The platform billing provider is untouched.
 */

const PROVIDERS = ['paystack', 'flutterwave', 'stripe', 'opay', 'moniepoint'] as const;

export const paymentAccountSchema = z.object({
  provider: z.enum(PROVIDERS),
  publicKey: z.string().trim().max(200).optional().default(''),
  // Write-only. Omit/blank on update to keep the stored secret unchanged.
  secretKey: z.string().trim().max(300).optional(),
  webhookSecret: z.string().trim().max(300).optional(),
  /**
   * OPay Merchant ID / Moniepoint contract code. Not a secret — it identifies
   * the account rather than authenticating to it — so unlike the keys it is
   * stored in the clear and read back to the settings screen.
   */
  merchantId: z.string().trim().max(120).optional(),
  chargeCurrencies: z.array(z.string().trim().length(3)).max(20).optional(),
  enabled: z.boolean().optional().default(false),
});
export type PaymentAccountDto = z.infer<typeof paymentAccountSchema>;

interface StoredAccount {
  provider: (typeof PROVIDERS)[number];
  publicKey: string;
  secretKeyEnc: string | null;
  webhookSecretEnc: string | null;
  chargeCurrencies: string[];
  enabled: boolean;
  /** OPay Merchant ID / Moniepoint contract code. Not secret. */
  merchantId: string;
  /**
   * Opaque id in this business's own webhook URL.
   *
   * Each business collects through its own gateway account with its own
   * signing secret, so a single shared endpoint could not know which secret to
   * verify against — and picking the wrong one would either reject real events
   * or, worse, accept forged ones. The URL carries this instead, which is what
   * lets us fetch the right secret *before* trusting a byte of the payload.
   */
  webhookId?: string;
}

function orgId(): string {
  const id = requestContext.get()?.organizationId;
  if (!id) throw new Error('No tenant in request context');
  return id;
}

function readAccount(settings: unknown): StoredAccount | null {
  const acct = ((settings as Record<string, unknown>) ?? {}).paymentAccount as
    | Partial<StoredAccount>
    | undefined;
  if (!acct || !acct.provider) return null;
  return {
    provider: acct.provider,
    publicKey: acct.publicKey ?? '',
    secretKeyEnc: acct.secretKeyEnc ?? null,
    webhookSecretEnc: acct.webhookSecretEnc ?? null,
    chargeCurrencies: Array.isArray(acct.chargeCurrencies) ? acct.chargeCurrencies : [],
    enabled: Boolean(acct.enabled),
    merchantId: acct.merchantId ?? '',
    webhookId: acct.webhookId,
  };
}

function safeDecrypt(payload: string | null): string {
  if (!payload) return '';
  try {
    return decrypt(payload);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'payment account secret decrypt failed');
    return '';
  }
}

/** Public, secret-free view for the settings screen. */
function toSafeView(acct: StoredAccount | null) {
  if (!acct) {
    return {
      provider: 'paystack' as const,
      publicKey: '',
      enabled: false,
      configured: false,
      hasSecretKey: false,
      hasWebhookSecret: false,
      chargeCurrencies: [] as string[],
      merchantId: '',
      merchantIdLabel: null as string | null,
      webhookId: null as string | null,
      webhookUrl: null as string | null,
    };
  }
  return {
    provider: acct.provider,
    publicKey: acct.publicKey,
    enabled: acct.enabled,
    configured: Boolean(acct.secretKeyEnc),
    hasSecretKey: Boolean(acct.secretKeyEnc),
    hasWebhookSecret: Boolean(acct.webhookSecretEnc),
    chargeCurrencies: acct.chargeCurrencies,
    merchantId: acct.merchantId,
    // What to call the third field on screen, so a business is not asked for a
    // "merchant id" when its dashboard calls it a contract code.
    merchantIdLabel: MERCHANT_ID_LABEL[acct.provider] ?? null,
    webhookId: acct.webhookId ?? null,
    webhookUrl: acct.webhookId ? webhookUrlFor(acct.webhookId, acct.provider) : null,
  };
}

export const orgPaymentAccountService = {
  async get() {
    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: orgId() },
      select: { settings: true },
    });
    return toSafeView(readAccount(org.settings));
  },

  async save(dto: PaymentAccountDto) {
    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: orgId() },
      select: { settings: true },
    });
    const settings = (org.settings as Record<string, unknown>) ?? {};
    const existing = readAccount(settings);

    // Switching providers invalidates a previously stored secret — force a
    // fresh key rather than silently reusing another gateway's credentials.
    const providerChanged = existing != null && existing.provider !== dto.provider;

    const secretKeyEnc = dto.secretKey
      ? encrypt(dto.secretKey)
      : providerChanged
        ? null
        : existing?.secretKeyEnc ?? null;

    const webhookSecretEnc =
      dto.webhookSecret !== undefined
        ? dto.webhookSecret
          ? encrypt(dto.webhookSecret)
          : null
        : providerChanged
          ? null
          : existing?.webhookSecretEnc ?? null;

    const account: StoredAccount = {
      provider: dto.provider,
      publicKey: dto.publicKey ?? '',
      secretKeyEnc,
      webhookSecretEnc,
      chargeCurrencies: (dto.chargeCurrencies ?? existing?.chargeCurrencies ?? []).map((c) =>
        c.toUpperCase(),
      ),
      merchantId: dto.merchantId ?? (providerChanged ? '' : existing?.merchantId ?? ''),
      // Can't enable without a secret key on file — nor, for the gateways that
      // need one, without the account identifier that says who to credit.
      enabled: Boolean(
        dto.enabled &&
          secretKeyEnc &&
          (!MERCHANT_ID_LABEL[dto.provider] ||
            (dto.merchantId ?? existing?.merchantId ?? '').length > 0)
      ),
      // Allocated once and kept for the life of the connection: the business
      // pastes this URL into its gateway dashboard, so changing it silently
      // would stop their webhooks arriving.
      webhookId: existing?.webhookId ?? randomBytes(16).toString('hex'),
    };

    await prisma.organization.update({
      where: { id: orgId() },
      data: { settings: { ...settings, paymentAccount: account } },
    });
    return toSafeView(account);
  },

  async remove() {
    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: orgId() },
      select: { settings: true },
    });
    const settings = (org.settings as Record<string, unknown>) ?? {};
    delete settings.paymentAccount;
    await prisma.organization.update({
      where: { id: orgId() },
      data: { settings },
    });
    return toSafeView(null);
  },
};

/**
 * Secret-free view of a business's connected gateway, by id.
 *
 * The method resolver and the public pay page both need to know *which*
 * provider a business collects through and whether it is really usable, but
 * neither has a tenant in request context and neither should ever touch the
 * keys. Returns null when nothing has been connected.
 */
export async function readOrgPaymentAccount(organizationId: string): Promise<{
  provider: (typeof PROVIDERS)[number];
  enabled: boolean;
  hasSecretKey: boolean;
  chargeCurrencies: string[];
  merchantId: string;
  webhookId?: string;
} | null> {
  const org = await prismaUnscoped.organization.findUnique({
    where: { id: organizationId },
    select: { settings: true },
  });
  const acct = readAccount(org?.settings);
  if (!acct) return null;
  return {
    provider: acct.provider,
    enabled: acct.enabled,
    hasSecretKey: Boolean(acct.secretKeyEnc),
    chargeCurrencies: acct.chargeCurrencies,
    merchantId: acct.merchantId,
    webhookId: acct.webhookId,
  };
}

/**
 * Find the business a webhook was addressed to.
 *
 * Runs before any signature check, so it must not trust the payload — only the
 * opaque id in the URL path. Returns the provider built from that business's
 * own credentials, which is what the signature is then verified against.
 */
export async function resolveWebhookTarget(webhookId: string): Promise<{
  organizationId: string;
  provider: PaymentProvider;
  providerName: (typeof PROVIDERS)[number];
} | null> {
  if (!webhookId || webhookId.length < 8) return null;
  // A JSON path lookup rather than a scan: settings is a JSONB column.
  const rows = await prismaUnscoped.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Organization"
    WHERE settings -> 'paymentAccount' ->> 'webhookId' = ${webhookId}
    LIMIT 1
  `;
  const organizationId = rows[0]?.id;
  if (!organizationId) return null;

  const org = await prismaUnscoped.organization.findUnique({
    where: { id: organizationId },
    select: { settings: true },
  });
  const acct = readAccount(org?.settings);
  if (!acct || !acct.secretKeyEnc) return null;
  const secretKey = safeDecrypt(acct.secretKeyEnc);
  if (!secretKey) return null;

  const cfg: ResolvedPaymentConfig = {
    provider: acct.provider,
    secretKey,
    publicKey: acct.publicKey,
    webhookSecret: safeDecrypt(acct.webhookSecretEnc),
    merchantId: acct.merchantId,
    chargeCurrencies: acct.chargeCurrencies.length
      ? acct.chargeCurrencies
      : env.billing.chargeCurrencies,
    callbackUrl: env.billing.callbackUrl,
  };
  return {
    organizationId,
    provider: buildPaymentProvider(cfg),
    providerName: acct.provider,
  };
}

/** The URL a business pastes into its gateway dashboard. */
export function webhookUrlFor(webhookId: string, provider: string): string {
  return `${env.API_BASE_URL.replace(/\/+$/, '')}/api/webhooks/payments/${provider}/${webhookId}`;
}

/**
 * Resolve the tenant's own payment provider for customer collections. Runs in
 * the *public* pay flow (no request context), so it takes an explicit org id
 * and reads unscoped. Returns null when the org hasn't connected/enabled an
 * account — callers then fall back to the platform provider.
 */
export async function resolveOrgProvider(organizationId: string): Promise<PaymentProvider | null> {
  const org = await prismaUnscoped.organization.findUnique({
    where: { id: organizationId },
    select: { settings: true },
  });
  const acct = readAccount(org?.settings);
  if (!acct || !acct.enabled || !acct.secretKeyEnc) return null;
  const secretKey = safeDecrypt(acct.secretKeyEnc);
  if (!secretKey) return null;

  const cfg: ResolvedPaymentConfig = {
    provider: acct.provider,
    secretKey,
    publicKey: acct.publicKey,
    webhookSecret: safeDecrypt(acct.webhookSecretEnc),
    merchantId: acct.merchantId,
    chargeCurrencies: acct.chargeCurrencies.length
      ? acct.chargeCurrencies
      : env.billing.chargeCurrencies,
    // Payment links always pass an explicit callbackUrl, so this is only a fallback.
    callbackUrl: env.billing.callbackUrl,
  };
  const provider = buildPaymentProvider(cfg);
  return provider.enabled ? provider : null;
}
