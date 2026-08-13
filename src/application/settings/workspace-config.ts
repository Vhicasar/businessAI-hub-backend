/**
 * Admin-synced workspace configuration (spec #2). The Vhicasar Admin is the
 * source of truth for these; `workspace-config-sync` pulls them and installs
 * them here as an override. Everything reads through the accessors so a change
 * in the admin propagates to the whole product on the next sync tick without a
 * redeploy. Falls back to the built-in defaults below when the admin has nothing
 * set or is unreachable.
 */

export interface WorkspaceConfig {
  /** { [flag]: boolean } — gate features on/off centrally. */
  featureFlags: Record<string, boolean>;
  /** Channel availability + defaults. */
  communication: {
    emailEnabled: boolean;
    smsEnabled: boolean;
    whatsappEnabled: boolean;
    webChatEnabled: boolean;
    defaultChannel: string | null;
  };
  /** Storage policy. */
  storage: {
    maxUploadMb: number;
    totalStorageGb: number | null;
    allowedTypes: string[]; // empty = allow all
  };
  /** Admin limit overrides applied on top of the plan entitlements. */
  limits: Record<string, number>;
  /** { [integrationId]: { enabled } } — admin can disable an integration. */
  integrations: Record<string, { enabled: boolean }>;
  /**
   * How many instances of each channel type a business may run, and what it
   * costs to run more. Per type rather than a single total, because "you may
   * have three inboxes" is a different product decision for email than for
   * WhatsApp, and the price differs too.
   */
  channels: Record<string, ChannelPolicy>;
}

export interface ChannelPolicy {
  /** Off hides the type entirely — not offered, not connectable. */
  available: boolean;
  /** Instances included at no extra cost. */
  defaultQuantity: number;
  /** Ceiling however many add-ons are bought. 0 means no ceiling. */
  maxQuantity: number;
  /** Catalog add-on that grants another instance. Null = cannot buy more. */
  addOnId: string | null;
  /** Plan feature required before the type can be used at all. */
  requiresFeature: string | null;
}

/**
 * What a channel type does by default: one instance, more purchasable.
 *
 * Deliberately not hardcoded per type here — the admin's config is the source
 * of truth and this is only the fallback when it has said nothing.
 */
export const DEFAULT_CHANNEL_POLICY: ChannelPolicy = {
  available: true,
  defaultQuantity: 1,
  maxQuantity: 0,
  addOnId: null,
  requiresFeature: null,
};

const DEFAULTS: WorkspaceConfig = {
  featureFlags: {},
  communication: {
    emailEnabled: true,
    smsEnabled: true,
    whatsappEnabled: true,
    webChatEnabled: true,
    defaultChannel: null,
  },
  storage: { maxUploadMb: 25, totalStorageGb: null, allowedTypes: [] },
  limits: {},
  integrations: {},
  channels: {},
};

/** Raw override shape from the admin (all keys optional/partial). */
export interface WorkspaceConfigOverride {
  featureFlags?: Record<string, boolean>;
  communication?: Partial<WorkspaceConfig['communication']>;
  storage?: Partial<WorkspaceConfig['storage']>;
  limits?: Record<string, number>;
  integrations?: Record<string, { enabled: boolean }>;
  channels?: Record<string, Partial<ChannelPolicy>>;
}

let override: WorkspaceConfigOverride | null = null;

/** Install (or clear with null) the admin-synced config. */
export function setWorkspaceConfigOverride(cfg: WorkspaceConfigOverride | null): void {
  override = cfg;
}

/** The resolved config = defaults with the admin override merged over the top. */
export function getWorkspaceConfig(): WorkspaceConfig {
  if (!override) return DEFAULTS;
  return {
    featureFlags: { ...DEFAULTS.featureFlags, ...(override.featureFlags ?? {}) },
    communication: { ...DEFAULTS.communication, ...(override.communication ?? {}) },
    storage: { ...DEFAULTS.storage, ...(override.storage ?? {}) },
    limits: { ...DEFAULTS.limits, ...(override.limits ?? {}) },
    integrations: { ...DEFAULTS.integrations, ...(override.integrations ?? {}) },
    // Each type is merged over the default individually, so the admin can set
    // just a price or just a ceiling without restating the whole policy.
    channels: Object.fromEntries(
      Object.entries(override.channels ?? {}).map(([type, policy]) => [
        type,
        { ...DEFAULT_CHANNEL_POLICY, ...policy },
      ]),
    ),
  };
}

/** The policy for one channel type, falling back to the default. */
export function channelPolicy(channelType: string): ChannelPolicy {
  return getWorkspaceConfig().channels[channelType] ?? DEFAULT_CHANNEL_POLICY;
}

/** Is a centrally-controlled feature flag on? Unknown flags default to `fallback`. */
export function isFeatureEnabled(flag: string, fallback = false): boolean {
  const flags = getWorkspaceConfig().featureFlags;
  return flag in flags ? Boolean(flags[flag]) : fallback;
}

/** Whether a communication channel is enabled by the admin. */
export function isChannelEnabled(channel: 'EMAIL' | 'SMS' | 'WHATSAPP' | 'WEB_CHAT'): boolean {
  const c = getWorkspaceConfig().communication;
  switch (channel) {
    case 'EMAIL': return c.emailEnabled;
    case 'SMS': return c.smsEnabled;
    case 'WHATSAPP': return c.whatsappEnabled;
    case 'WEB_CHAT': return c.webChatEnabled;
    default: return true;
  }
}

/** Whether an integration is enabled by the admin (unknown = enabled). */
export function isIntegrationEnabled(integrationId: string): boolean {
  const entry = getWorkspaceConfig().integrations[integrationId];
  return entry ? entry.enabled !== false : true;
}
