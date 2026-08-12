import { env } from '../../shared/config/env';
import { logger } from '../../shared/logger';

export interface CatalogAddOn {
  id: string;
  title: string;
  description: string;
  enabled: boolean;
  billingType: 'ONE_TIME' | 'MONTHLY';
  prices: Record<string, { amount: number }>;
  entitlements: { aiCredits?: number; maxUsers?: number; maxChannels?: number; features: string[] };
}

export interface CatalogIntegration {
  id: string;
  name: string;
  category: 'CHANNEL' | 'PAYMENT' | 'COMMERCE' | 'PRODUCTIVITY' | 'AI' | 'OTHER';
  enabled: boolean;
  description: string;
  docsUrl?: string;
  setupGuide: string[];
  fields: { key: string; label: string; required: boolean; secret: boolean }[];
  /**
   * The plans this integration belongs to, read as a *minimum tier* rather than
   * an exact allowlist — see application/integrations/integration-access.ts.
   */
  plans: string[];
  /**
   * OAuth integrations are connected by signing in to the provider, not by
   * pasting a key, so they have no `fields` to fill.
   */
  auth?: 'oauth' | 'credentials';
}

export interface SiteCatalog {
  supportEmail: string;
  socialLinks: Record<string, string>;
  addOns: CatalogAddOn[];
  integrations: CatalogIntegration[];
}

const FALLBACK: SiteCatalog = {
  supportEmail: 'support@vhicasar.com',
  socialLinks: {},
  addOns: [
    { id: 'website_subdomain', title: 'Website Subdomain', description: 'Deploy one website to an available subdomain on the platform-managed domain.', enabled: true, billingType: 'MONTHLY', prices: { USD: { amount: 1 } }, entitlements: { features: ['website_subdomain'] } },
    { id: 'ai_responses_5000', title: '5,000 Additional AI Responses', description: 'Adds 5,000 AI responses to each billing period.', enabled: true, billingType: 'MONTHLY', prices: { NGN: { amount: 2000 } }, entitlements: { aiCredits: 5000, features: [] } },
    { id: 'ai_responses_20000', title: '20,000 Additional AI Responses', description: 'Adds 20,000 AI responses to each billing period.', enabled: true, billingType: 'MONTHLY', prices: { NGN: { amount: 6500 } }, entitlements: { aiCredits: 20000, features: [] } },
    { id: 'ai_responses_100000', title: '100,000 Additional AI Responses', description: 'Adds 100,000 AI responses to each billing period.', enabled: true, billingType: 'MONTHLY', prices: { NGN: { amount: 22000 } }, entitlements: { aiCredits: 100000, features: [] } },
    { id: 'whatsapp_number', title: 'Additional WhatsApp Number', description: 'Adds one more connected channel allowance.', enabled: true, billingType: 'MONTHLY', prices: { NGN: { amount: 2000 } }, entitlements: { maxChannels: 1, features: [] } },
    { id: 'team_member', title: 'Extra Team Member', description: 'Adds one team seat.', enabled: true, billingType: 'MONTHLY', prices: { NGN: { amount: 1000 } }, entitlements: { maxUsers: 1, features: [] } },
    { id: 'ai_voice', title: 'AI Voice Assistant', description: 'Enables AI voice assistant access.', enabled: true, billingType: 'MONTHLY', prices: { NGN: { amount: 8000 } }, entitlements: { features: ['ai_voice'] } },
    { id: 'white_label', title: 'White Label', description: 'Enables customer-facing white-label controls.', enabled: true, billingType: 'ONE_TIME', prices: { NGN: { amount: 150000 } }, entitlements: { features: ['white_label'] } },
  ],
  integrations: [
    ...['whatsapp', 'instagram', 'facebook', 'telegram'].map((id) => ({ id, name: id.charAt(0).toUpperCase() + id.slice(1), category: 'CHANNEL' as const, enabled: true, description: `Connect ${id} to Vhicasar Hub AI.`, setupGuide: [], fields: [], plans: [] })),
    { id: 'paystack', name: 'Paystack', category: 'PAYMENT', enabled: true, description: 'Accept and reconcile Paystack payments.', setupGuide: ['Create or open your Paystack account.', 'Copy the public and secret API keys from Settings → API Keys.', 'Paste them here and save the connection.'], fields: [{ key: 'publicKey', label: 'Public key', required: true, secret: false }, { key: 'secretKey', label: 'Secret key', required: true, secret: true }], plans: ['business', 'enterprise'] },
    { id: 'flutterwave', name: 'Flutterwave', category: 'PAYMENT', enabled: true, description: 'Connect Flutterwave payments.', setupGuide: ['Open Flutterwave Settings → API.', 'Copy the public and secret keys.', 'Paste them here and save.'], fields: [{ key: 'publicKey', label: 'Public key', required: true, secret: false }, { key: 'secretKey', label: 'Secret key', required: true, secret: true }], plans: ['business', 'enterprise'] },
    { id: 'stripe', name: 'Stripe', category: 'PAYMENT', enabled: true, description: 'Connect Stripe payments.', setupGuide: ['Open Stripe Developers → API keys.', 'Copy the publishable and secret keys.', 'Paste them here and save.'], fields: [{ key: 'publishableKey', label: 'Publishable key', required: true, secret: false }, { key: 'secretKey', label: 'Secret key', required: true, secret: true }], plans: ['business', 'enterprise'] },
    {
      id: 'google_calendar', name: 'Google Calendar', category: 'PRODUCTIVITY' as const, enabled: true,
      description: 'Sync bookings to your Google Calendar, both ways.',
      setupGuide: [
        'Click Connect and sign in with the Google account that owns the calendar.',
        'Grant access to your calendar events when Google asks.',
        'Bookings made in Vhicasar Hub then appear on that calendar automatically.',
      ],
      fields: [], plans: ['growth'], auth: 'oauth' as const,
    },
    {
      id: 'calendly', name: 'Calendly', category: 'PRODUCTIVITY' as const, enabled: true,
      description: 'Bring Calendly bookings into Vhicasar Hub.',
      setupGuide: [
        'Click Connect and sign in to your Calendly account.',
        'Approve access when Calendly asks.',
        'Events scheduled through Calendly then appear in your Bookings calendar.',
      ],
      fields: [], plans: ['growth'], auth: 'oauth' as const,
    },
    ...['shopify', 'woocommerce', 'slack', 'zapier', 'openai', 'anthropic', 'gemini', 'deepseek'].map((id) => ({
      id, name: id.split('_').map((v) => v.charAt(0).toUpperCase() + v.slice(1)).join(' '),
      category: (['shopify', 'woocommerce'].includes(id) ? 'COMMERCE' : ['openai', 'anthropic', 'gemini', 'deepseek'].includes(id) ? 'AI' : 'PRODUCTIVITY') as CatalogIntegration['category'],
      enabled: true, description: `Connect ${id.replace('_', ' ')} to your workspace.`, setupGuide: ['Create credentials in the provider dashboard.', 'Copy the API key or access token.', 'Paste it here and save the connection.'], fields: [{ key: 'apiKey', label: 'API key or access token', required: true, secret: true }], plans: ['business', 'enterprise'],
    })),
  ],
};

let cached: { value: SiteCatalog; expiresAt: number } | null = null;
let brandingCache: { value: { name: string; logoUrl: string | null; themeColor: string }; expiresAt: number } | null = null;

export async function getProductBranding() {
  if (brandingCache && brandingCache.expiresAt > Date.now()) return brandingCache.value;
  const fallback = { name: 'Vhicasar Hub AI', logoUrl: null, themeColor: '#F97316' };
  // Branding only needs the admin's public API — it is independent of the plan
  // sync toggle, so the product logo/name/favicon still track the admin even
  // when ADMIN_PLAN_SYNC is off.
  if (!env.adminCatalog.apiUrl || !env.adminCatalog.tenantSlug) return fallback;
  try {
    const res = await fetch(
      `${env.adminCatalog.apiUrl}/api/v1/public/${env.adminCatalog.tenantSlug}/config`,
      { signal: AbortSignal.timeout(5_000) },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { data?: { profile?: { name?: string; logoUrl?: string | null; themeColor?: string | null } } };
    const profile = body.data?.profile;
    const value = {
      name: profile?.name || fallback.name,
      logoUrl: profile?.logoUrl || null,
      themeColor: profile?.themeColor || fallback.themeColor,
    };
    brandingCache = { value, expiresAt: Date.now() + 60_000 };
    return value;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Admin branding unavailable — using last known branding');
    // Keep a previously fetched logo through a temporary admin/database outage.
    // Expiry controls refresh frequency, not whether known-good branding is valid.
    return brandingCache?.value ?? fallback;
  }
}

export async function getSiteCatalog(force = false): Promise<SiteCatalog> {
  if (!force && cached && cached.expiresAt > Date.now()) return cached.value;
  if (!env.adminCatalog.enabled) return FALLBACK;
  const url = `${env.adminCatalog.apiUrl}/api/v1/public/${env.adminCatalog.tenantSlug}/marketing`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { data?: Partial<SiteCatalog> };
    const remote = body.data ?? {};
    const value: SiteCatalog = {
      supportEmail: remote.supportEmail || FALLBACK.supportEmail,
      socialLinks: remote.socialLinks ?? FALLBACK.socialLinks,
      // Keep the deployment add-on available at its $1 fallback until the
      // admin catalog defines it; once present, admin pricing wins completely.
      addOns: Array.isArray(remote.addOns) && remote.addOns.length
        ? [
            ...remote.addOns,
            ...FALLBACK.addOns.filter((fallback) => fallback.id === 'website_subdomain' && !remote.addOns?.some((item) => item.id === fallback.id)),
          ]
        : FALLBACK.addOns,
      // The admin owns the integration list, but OAuth integrations are a
      // platform capability rather than admin content: the product ships the
      // client app and the callback route. An admin list that omits them must
      // not make them unreachable, so they are unioned back in. An admin entry
      // for the same id still wins — that is how plans/description stay
      // admin-managed.
      integrations: Array.isArray(remote.integrations) && remote.integrations.length
        ? [
            ...remote.integrations.map((item) => {
              const builtIn = FALLBACK.integrations.find((f) => f.id === item.id);
              // `auth` is not something an admin sets; carry it across so an
              // admin-listed OAuth integration is not rendered as a key form.
              return builtIn?.auth ? { ...item, auth: builtIn.auth, fields: builtIn.fields } : item;
            }),
            ...FALLBACK.integrations.filter(
              (f) => f.auth === 'oauth' && !remote.integrations?.some((item) => item.id === f.id),
            ),
          ]
        : FALLBACK.integrations,
    };
    cached = { value, expiresAt: Date.now() + 30_000 };
    return value;
  } catch (err) {
    logger.warn({ err: (err as Error).message, url }, 'Admin site catalog unavailable — using fallback');
    return FALLBACK;
  }
}
