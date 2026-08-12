import { z } from 'zod';
import { prisma, prismaUnscoped } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { encrypt, decrypt } from '../../shared/crypto';
import { logger } from '../../shared/logger';
import { getAiProvider, buildAiProvider, meterProvider } from '../../infrastructure/ai';
import { AppError } from '../../shared/errors';
import type { AiProvider } from './ai-provider';

/**
 * Per-workspace AI provider (spec #13, "bring your own key"). Lets a tenant
 * connect *their own* OpenAI / Anthropic / Gemini / Azure / Ollama / OpenRouter
 * / custom key. When enabled, the workspace's AI runs on that key and its usage
 * counts against the tenant's own provider account — so those calls DON'T draw
 * down the Vhicasar Hub plan's AI quota. When not configured, the workspace uses
 * the platform provider and the plan quota, exactly as before. Stored on
 * `Organization.settings.aiProvider`; the key is encrypted at rest (AES-256-GCM).
 */

const PROVIDERS = ['openai', 'anthropic', 'gemini', 'azure', 'ollama', 'openrouter', 'custom'] as const;

export const aiAccountSchema = z.object({
  provider: z.enum(PROVIDERS),
  model: z.string().trim().max(120).optional().default(''),
  baseUrl: z.string().trim().url().max(300).optional().or(z.literal('')),
  // Write-only. Omit/blank on update to keep the stored key unchanged.
  apiKey: z.string().trim().max(400).optional(),
  enabled: z.boolean().optional().default(false),
});
export type AiAccountDto = z.infer<typeof aiAccountSchema>;

interface StoredAiAccount {
  provider: (typeof PROVIDERS)[number];
  model: string;
  baseUrl: string;
  apiKeyEnc: string | null;
  enabled: boolean;
}

function orgId(): string {
  const id = requestContext.get()?.organizationId;
  if (!id) throw new Error('No tenant in request context');
  return id;
}

function readAccount(settings: unknown): StoredAiAccount | null {
  const acct = ((settings as Record<string, unknown>) ?? {}).aiProvider as Partial<StoredAiAccount> | undefined;
  if (!acct || !acct.provider) return null;
  return {
    provider: acct.provider,
    model: acct.model ?? '',
    baseUrl: acct.baseUrl ?? '',
    apiKeyEnc: acct.apiKeyEnc ?? null,
    enabled: Boolean(acct.enabled),
  };
}

function safeDecrypt(payload: string | null): string {
  if (!payload) return '';
  try { return decrypt(payload); } catch (err) {
    logger.warn({ err: (err as Error).message }, 'org AI key decrypt failed');
    return '';
  }
}

/** Secret-free view for the settings screen. */
function toSafeView(acct: StoredAiAccount | null) {
  if (!acct) {
    return { provider: 'openai' as const, model: '', baseUrl: '', enabled: false, configured: false, hasApiKey: false };
  }
  return {
    provider: acct.provider, model: acct.model, baseUrl: acct.baseUrl,
    enabled: acct.enabled, configured: Boolean(acct.apiKeyEnc), hasApiKey: Boolean(acct.apiKeyEnc),
  };
}

export const orgAiAccountService = {
  async get() {
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId() }, select: { settings: true } });
    return toSafeView(readAccount(org.settings));
  },

  async save(dto: AiAccountDto) {
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId() }, select: { settings: true } });
    const settings = (org.settings as Record<string, unknown>) ?? {};
    const existing = readAccount(settings);
    const providerChanged = existing != null && existing.provider !== dto.provider;

    const apiKeyEnc = dto.apiKey
      ? encrypt(dto.apiKey)
      : providerChanged
        ? null
        : existing?.apiKeyEnc ?? null;

    const account: StoredAiAccount = {
      provider: dto.provider,
      model: dto.model ?? '',
      baseUrl: dto.baseUrl ?? '',
      apiKeyEnc,
      // Can't enable without a key (Ollama/self-hosted may not need one — allow
      // enable when a baseUrl is set even without a key).
      enabled: Boolean(dto.enabled && (apiKeyEnc || dto.baseUrl)),
    };
    await prisma.organization.update({ where: { id: orgId() }, data: { settings: { ...settings, aiProvider: account } } });
    return toSafeView(account);
  },

  async remove() {
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId() }, select: { settings: true } });
    const settings = (org.settings as Record<string, unknown>) ?? {};
    delete settings.aiProvider;
    await prisma.organization.update({ where: { id: orgId() }, data: { settings } });
    return toSafeView(null);
  },
};

/**
 * Resolve the AI provider a workspace runs on, and whether it's the tenant's own
 * key (so callers can skip the plan-quota deduction). Reads unscoped so it works
 * in public flows too. Falls back to the platform provider when the org hasn't
 * connected/enabled its own.
 */
export async function resolveOrgAi(
  organizationId?: string,
  feature = 'assistant'
): Promise<{ provider: AiProvider | null; ownKey: boolean }> {
  const id = organizationId ?? requestContext.get()?.organizationId ?? null;
  if (id) {
    const org = await prismaUnscoped.organization.findUnique({ where: { id }, select: { settings: true } });
    const acct = readAccount(org?.settings);
    if (acct?.enabled) {
      const apiKey = safeDecrypt(acct.apiKeyEnc);
      if (apiKey || acct.baseUrl) {
        const provider = buildAiProvider({ provider: acct.provider === 'azure' ? 'custom' : acct.provider, model: acct.model, apiKey: apiKey || null, baseUrl: acct.baseUrl || null });
        if (provider) {
          return {
            provider: meterProvider(provider, feature, { organizationId: id, ownKey: true }),
            ownKey: true,
          };
        }
      }
    }
  }
  // Already metered by getAiProvider; the feature label is what it needs.
  return { provider: getAiProvider(feature), ownKey: false };
}

/** Resolver for AI a caller cannot proceed without. */
export async function resolveAi(feature = 'assistant'): Promise<{ provider: AiProvider; ownKey: boolean }> {
  const { provider, ownKey } = await resolveOrgAi(undefined, feature);
  if (!provider) {
    throw new AppError(
      'AI_DISABLED',
      503,
      'AI is not configured. Connect your own AI provider in Settings, or contact the administrator.'
    );
  }
  return { provider, ownKey };
}

/** Non-throwing resolver for best-effort AI (summaries, insights). */
export async function resolveAiOptional(feature = 'assistant'): Promise<{ provider: AiProvider | null; ownKey: boolean }> {
  return resolveOrgAi(undefined, feature);
}

