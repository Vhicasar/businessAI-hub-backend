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
}

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
};

/** Raw override shape from the admin (all keys optional/partial). */
export interface WorkspaceConfigOverride {
  featureFlags?: Record<string, boolean>;
  communication?: Partial<WorkspaceConfig['communication']>;
  storage?: Partial<WorkspaceConfig['storage']>;
  limits?: Record<string, number>;
  integrations?: Record<string, { enabled: boolean }>;
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
  };
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
