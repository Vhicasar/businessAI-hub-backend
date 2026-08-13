import { prisma, prismaUnscoped } from '../../infrastructure/database/prisma';
import { channelPolicy, type ChannelPolicy } from '../settings/workspace-config';
import { resolveEntitlements } from '../billing/entitlements';

/**
 * How many of each channel a business may run.
 *
 * A business does not have "an email address" — it has a support inbox, an
 * invoices inbox, maybe a sales one. So the allowance is per channel type and
 * counted in instances: the admin sets what is included, and buying an add-on
 * raises it. Nothing here is hardcoded; the numbers come from the admin's
 * workspace config and from what the business has actually purchased.
 */

/**
 * What an instance of a channel is for.
 *
 * Drives which channel the system reaches for, so an invoice does not go out
 * of the support inbox and an auto-reply does not answer a billing email.
 */
export const CHANNEL_PURPOSES = [
  { id: 'SUPPORT', label: 'Customer support' },
  { id: 'INVOICES', label: 'Invoices & billing' },
  { id: 'SALES', label: 'Sales' },
  { id: 'ORDERS', label: 'Order notifications' },
  { id: 'MARKETING', label: 'Marketing' },
  { id: 'GENERAL', label: 'General communication' },
] as const;

export type ChannelPurpose = (typeof CHANNEL_PURPOSES)[number]['id'];

export const CHANNEL_PURPOSE_IDS = CHANNEL_PURPOSES.map((p) => p.id) as unknown as [
  ChannelPurpose,
  ...ChannelPurpose[],
];

/**
 * Which purposes may carry which kind of message, best first.
 *
 * A business that has not set anything up should still get its invoice sent, so
 * every list ends at GENERAL rather than at nothing. What must not happen is
 * the reverse: an invoice going out of a channel the business set aside for
 * marketing.
 */
const PURPOSE_PREFERENCE: Record<string, ChannelPurpose[]> = {
  INVOICES: ['INVOICES', 'SALES', 'GENERAL'],
  SUPPORT: ['SUPPORT', 'GENERAL'],
  ORDERS: ['ORDERS', 'SUPPORT', 'GENERAL'],
  SALES: ['SALES', 'GENERAL'],
  MARKETING: ['MARKETING', 'GENERAL'],
  GENERAL: ['GENERAL'],
};

export function purposePreference(purpose: string): ChannelPurpose[] {
  return PURPOSE_PREFERENCE[purpose] ?? ['GENERAL'];
}

export interface ChannelAllowance {
  channelType: string;
  policy: ChannelPolicy;
  /** Included by the plan/admin config. */
  included: number;
  /** Extra instances the business has bought. */
  purchased: number;
  /** included + purchased, capped by the policy ceiling. */
  allowed: number;
  /** Instances currently connected. */
  used: number;
  /** Whether another one can be connected right now. */
  canAddMore: boolean;
  /** Why not, when it cannot — shown to the user rather than a bare refusal. */
  blockedReason: string | null;
  /**
   * Whether buying an add-on would actually help.
   *
   * False when the type is unavailable, gated behind a plan feature, or already
   * at the admin's ceiling — in those cases pointing the user at the shop is a
   * dead end. The UI reads this rather than matching words in the message.
   */
  canPurchaseMore: boolean;
}

/**
 * Extra instances bought for a type.
 *
 * Add-on entitlements carry `channelsByType: { EMAIL: 2 }`. The older
 * `maxChannels` entitlement is a total rather than per type, so it is
 * deliberately not counted here — it still applies as an overall ceiling in
 * `resolveEntitlements`.
 */
async function purchasedFor(organizationId: string, channelType: string): Promise<number> {
  const purchases = await prismaUnscoped.addOnPurchase.findMany({
    where: { organizationId, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    select: { entitlements: true },
  });
  let total = 0;
  for (const purchase of purchases) {
    const value = (purchase.entitlements ?? {}) as Record<string, unknown>;
    const byType = (value.channelsByType ?? {}) as Record<string, unknown>;
    total += Number(byType[channelType] ?? 0);
  }
  return total;
}

export async function allowanceFor(
  organizationId: string,
  channelType: string
): Promise<ChannelAllowance> {
  const policy = channelPolicy(channelType);
  const [purchased, used, entitlements] = await Promise.all([
    purchasedFor(organizationId, channelType),
    prisma.channelAccount.count({ where: { channelType: channelType as never, deletedAt: null } }),
    resolveEntitlements(organizationId).catch(() => null),
  ]);

  const included = Math.max(0, policy.defaultQuantity);
  const uncapped = included + purchased;
  const allowed = policy.maxQuantity > 0 ? Math.min(uncapped, policy.maxQuantity) : uncapped;

  let blockedReason: string | null = null;
  if (!policy.available) {
    blockedReason = 'This channel is not available on this platform.';
  } else if (policy.requiresFeature && entitlements && !entitlements.features.has(policy.requiresFeature as never)) {
    blockedReason = 'Your plan does not include this channel. Upgrade to connect it.';
  } else if (used >= allowed) {
    blockedReason =
      policy.maxQuantity > 0 && uncapped >= policy.maxQuantity
        ? `You have reached the maximum of ${policy.maxQuantity} for this channel.`
        : policy.addOnId
          ? `You are using all ${allowed} of your ${channelType.toLowerCase()} channels. Purchase an add-on to connect another.`
          : `You are using all ${allowed} of your ${channelType.toLowerCase()} channels.`;
  }

  const atCeiling = policy.maxQuantity > 0 && uncapped >= policy.maxQuantity;
  const planBlocked = Boolean(
    policy.requiresFeature && entitlements && !entitlements.features.has(policy.requiresFeature as never),
  );

  return {
    channelType,
    policy,
    included,
    purchased,
    allowed,
    used,
    canAddMore: blockedReason === null,
    blockedReason,
    canPurchaseMore: Boolean(policy.available && policy.addOnId && !atCeiling && !planBlocked),
  };
}

/** Every type's allowance — what the channels screen renders from. */
export async function allowanceSummary(
  organizationId: string,
  channelTypes: string[]
): Promise<ChannelAllowance[]> {
  return Promise.all(channelTypes.map((type) => allowanceFor(organizationId, type)));
}

/**
 * Pick the channel to send something through.
 *
 * Prefers an instance whose purpose matches, falls back down the preference
 * list, and never returns a channel whose purpose is unrelated to what is being
 * sent. Returns the alternatives too, so the user can be offered a choice
 * rather than having one silently made for them.
 */
export async function pickChannelFor(input: {
  purpose: string;
  /** Restrict to types the recipient can actually be reached on. */
  channelTypes?: string[];
}): Promise<{
  recommended: { id: string; channelType: string; name: string; purpose: string } | null;
  eligible: { id: string; channelType: string; name: string; purpose: string }[];
}> {
  const preference = purposePreference(input.purpose);
  const accounts = await prisma.channelAccount.findMany({
    where: {
      deletedAt: null,
      isActive: true,
      ...(input.channelTypes?.length ? { channelType: { in: input.channelTypes as never[] } } : {}),
    },
    select: { id: true, channelType: true, name: true, purpose: true },
    orderBy: { createdAt: 'asc' },
  });

  const eligible = accounts.filter((a) => preference.includes(a.purpose as ChannelPurpose));
  // Best purpose first; within a purpose, the oldest instance is the established one.
  eligible.sort((a, b) => preference.indexOf(a.purpose as ChannelPurpose) - preference.indexOf(b.purpose as ChannelPurpose));

  return { recommended: eligible[0] ?? null, eligible };
}
