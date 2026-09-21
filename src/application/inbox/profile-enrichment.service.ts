import type { ChannelAdapter, ChannelAccountRef, NormalizedInbound } from './channel-adapter';
import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { logger } from '../../shared/logger';

const SUCCESS_TTL_MS = 24 * 60 * 60 * 1000;
const PARTIAL_TTL_MS = 6 * 60 * 60 * 1000;
const FAILURE_TTL_MS = 15 * 60 * 1000;

type StoredProfile = {
  firstName?: string; lastName?: string; username?: string; displayName?: string; profileUrl?: string;
  enrichment?: { status?: string; attemptedAt?: string };
};

function storedProfile(customFields: unknown, channelType: string): StoredProfile | null {
  if (!customFields || typeof customFields !== 'object' || Array.isArray(customFields)) return null;
  const profiles = (customFields as Record<string, unknown>).channelProfiles;
  if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) return null;
  const profile = (profiles as Record<string, unknown>)[channelType];
  return profile && typeof profile === 'object' && !Array.isArray(profile) ? profile as StoredProfile : null;
}

function isFresh(profile: StoredProfile | null): boolean {
  const attempted = profile?.enrichment?.attemptedAt;
  if (!attempted) return false;
  const age = Date.now() - new Date(attempted).getTime();
  if (!Number.isFinite(age) || age < 0) return false;
  const status = profile?.enrichment?.status;
  return age < (status === 'SUCCESS' ? SUCCESS_TTL_MS : status === 'PARTIAL' ? PARTIAL_TTL_MS : FAILURE_TTL_MS);
}

/**
 * Runs optional provider lookups with a tenant-scoped cache and a hard
 * best-effort boundary. A provider/profile failure can never discard a message.
 */
export async function enrichInboundProfiles(
  adapter: ChannelAdapter,
  account: ChannelAccountRef,
  messages: NormalizedInbound[],
): Promise<NormalizedInbound[]> {
  if (!adapter.enrichInbound || messages.length === 0) return messages;
  const bySender = new Map<string, Promise<NormalizedInbound>>();

  return Promise.all(messages.map(async (message) => {
    let pending = bySender.get(message.senderExternalId);
    if (!pending) {
      pending = (async () => {
        const identity = await prismaUnscoped.customerIdentity.findFirst({
          where: {
            organizationId: account.organizationId,
            channelType: adapter.channelType,
            externalId: message.senderExternalId,
          },
          select: { displayName: true, profileUrl: true, customer: { select: { customFields: true } } },
        });
        const cached = storedProfile(identity?.customer.customFields, adapter.channelType);
        if (identity && isFresh(cached)) {
          return {
            ...message,
            senderDisplayName: cached?.displayName ?? identity.displayName ?? undefined,
            senderProfile: {
              firstName: cached?.firstName,
              lastName: cached?.lastName,
              username: cached?.username,
              profileUrl: cached?.profileUrl ?? identity.profileUrl ?? undefined,
            },
            profileEnrichment: {
              status: 'SKIPPED', reason: 'PROFILE_CACHED', permissionSufficient: 'UNKNOWN',
              advancedAccessRequired: 'UNKNOWN', attemptedAt: cached?.enrichment?.attemptedAt ?? new Date().toISOString(),
            },
          };
        }
        try {
          return await adapter.enrichInbound!(message, account);
        } catch (error) {
          logger.warn({
            err: error, accountId: account.id, channelType: adapter.channelType,
            profileEnrichment: 'FAILED', reason: 'PROFILE_LOOKUP_FAILED',
          }, 'Provider profile enrichment failed; preserving inbound message');
          return {
            ...message,
            profileEnrichment: {
              status: 'FAILED', reason: 'PROFILE_LOOKUP_FAILED', permissionSufficient: 'UNKNOWN',
              advancedAccessRequired: 'UNKNOWN', attemptedAt: new Date().toISOString(),
            },
          };
        }
      })();
      bySender.set(message.senderExternalId, pending);
    }
    const enriched = await pending;
    return {
      ...message,
      senderDisplayName: enriched.senderDisplayName,
      senderProfile: enriched.senderProfile,
      profileEnrichment: enriched.profileEnrichment,
    };
  }));
}
