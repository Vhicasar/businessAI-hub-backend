import { isFeatureEnabled } from './workspace-config';

/**
 * Platform-level feature switches the administrator controls centrally.
 *
 * Distinct from a plan feature, and the distinction matters. A plan feature is
 * something a business could buy — the menu draws a padlock and an upgrade
 * turns it on. A platform switch is the operator's decision about what the
 * product offers at all, so no upgrade will reach it; the UI hides rather than
 * locks, exactly as it already does for a communication channel the admin has
 * switched off.
 *
 * These ride on the admin-synced `featureFlags` map (see workspace-config), so
 * flipping one in Vhicasar Admin reaches every workspace on the next sync tick
 * without a deployment. The `FeatureFlag` database table is a separate, older
 * mechanism that nothing in the product reads — deliberately not built on.
 */

export const PLATFORM_FEATURES = {
  /**
   * Whether businesses may run WhatsApp marketing campaigns.
   *
   * Default on, so switching it off is the deliberate admin action rather than
   * something a missing flag causes. Only campaigns: inbound WhatsApp, the
   * inbox, conversations and the channel connection are all untouched by this.
   */
  whatsappCampaigns: 'whatsapp_campaigns',

  /**
   * Whether a business on the free plan may publish to a platform subdomain.
   *
   * Default on: publishing a website to `name.<base domain>` is a free-plan
   * capability, not something to be sold on its own. Switching it off restores
   * the previous behaviour, where the Website Subdomain add-on had to be bought
   * before publishing. Paid plans are unaffected either way — they follow their
   * own website entitlements.
   */
  freePlanWebsiteSubdomain: 'free_plan_website_subdomain',
} as const;

export type PlatformFeature = (typeof PLATFORM_FEATURES)[keyof typeof PLATFORM_FEATURES];

/**
 * What a switch means when the administrator has never set it.
 *
 * Most default to on: a flag nobody has touched must leave the product
 * behaving as it does today, and an admin or sync outage must not quietly
 * withdraw a feature businesses are mid-way through using.
 *
 * The free-plan subdomain switch is the exception and defaults to **off**,
 * because publishing belongs to a paid plan. Defaulting it on would hand a
 * paid capability to every workspace that signs up, which is a commercial
 * decision rather than a conservative fallback.
 */
const DEFAULTS: Record<PlatformFeature, boolean> = {
  whatsapp_campaigns: true,
  free_plan_website_subdomain: false,
};

export function isPlatformFeatureEnabled(feature: PlatformFeature): boolean {
  return isFeatureEnabled(feature, DEFAULTS[feature] ?? true);
}

/** The switches that are on, for the session payload the web app gates UI with. */
export function enabledPlatformFeatures(): PlatformFeature[] {
  return Object.values(PLATFORM_FEATURES).filter((feature) => isPlatformFeatureEnabled(feature));
}
