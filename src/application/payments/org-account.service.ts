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

/**
 * Per-organization payment account (#13). Lets each tenant connect *their own*
 * Paystack/Flutterwave keys so customer-facing collections (payment links)
 * settle into the tenant's account instead of the platform's. Stored on
 * `Organization.settings.paymentAccount`; the secret + webhook keys are
 * encrypted at rest (AES-256-GCM). The platform billing provider is untouched.
 */

const PROVIDERS = ['paystack', 'flutterwave'] as const;

export const paymentAccountSchema = z.object({
  provider: z.enum(PROVIDERS),
  publicKey: z.string().trim().max(200).optional().default(''),
  // Write-only. Omit/blank on update to keep the stored secret unchanged.
  secretKey: z.string().trim().max(300).optional(),
  webhookSecret: z.string().trim().max(300).optional(),
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
      // Can't enable without a secret key on file.
      enabled: Boolean(dto.enabled && secretKeyEnc),
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
    chargeCurrencies: acct.chargeCurrencies.length
      ? acct.chargeCurrencies
      : env.billing.chargeCurrencies,
    // Payment links always pass an explicit callbackUrl, so this is only a fallback.
    callbackUrl: env.billing.callbackUrl,
  };
  const provider = buildPaymentProvider(cfg);
  return provider.enabled ? provider : null;
}
