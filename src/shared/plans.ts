/**
 * BusinessHub AI — Subscription plan catalog (single source of truth).
 *
 * Mirrors the public pricing page (businessAI-hub-home). Seeded into the `Plan`
 * table and used by the billing entitlements resolver for feature gating and
 * limit enforcement. Amounts are in NGN (₦).
 */

/** Feature keys a plan can grant. Used by `requireFeature()` guards. */
export const FEATURE_KEYS = [
  'inbox', // omnichannel inbox
  'ai_support', // AI customer support (24/7 answering)
  'ai_sales', // AI sales agent (recommend, upsell, qualify, follow-up)
  'ai_insights', // AI summaries, sentiment, scoring and next-best-action insights
  'crm', // smart CRM + pipeline
  'catalog', // product catalog / e-commerce
  'orders', // order management
  'invoices', // quotes & invoices
  'inventory', // inventory & warehouses
  'marketing', // campaigns & broadcasts
  'automations', // marketing/sales automation workflows
  'analytics', // analytics dashboard
  'knowledge_base', // AI knowledge base
  'team', // team collaboration (roles, departments, assignment)
  'loyalty',
  'pos',
  'api', // API access
  'webhooks',
  'realestate',
  'employees',
  'audit',
  'sso',
  'white_label',
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

export interface PlanSeed {
  name: string;
  slug: string;
  description: string;
  priceMonthly: number;
  priceYearly: number;
  currency: string;
  maxUsers: number | null;
  /** How many businesses (organizations) a user on this plan may create. */
  maxBusinesses: number | null;
  maxBranches: number | null;
  maxProducts: number | null;
  maxChannels: number | null;
  maxContacts: number | null;
  aiCreditsMonthly: number | null;
  features: FeatureKey[];
  isPublic: boolean;
  position: number;
}

const YEARLY_DISCOUNT = 0.2;
const yearly = (monthly: number): number => Math.round(monthly * 12 * (1 - YEARLY_DISCOUNT));

/** The four public plans, matching the pricing page. `null` limit = unlimited. */
export const PLAN_CATALOG: PlanSeed[] = [
  {
    name: 'Starter',
    slug: 'starter',
    description: 'Perfect for trying BusinessHub AI.',
    priceMonthly: 0,
    priceYearly: 0,
    currency: 'NGN',
    maxUsers: 1,
    maxBusinesses: 1,
    maxBranches: 1,
    maxProducts: 50,
    maxChannels: 1,
    maxContacts: 100,
    aiCreditsMonthly: 100,
    features: ['inbox', 'ai_support', 'crm', 'catalog', 'orders', 'invoices', 'knowledge_base'],
    isPublic: true,
    position: 1,
  },
  {
    name: 'Growth',
    slug: 'growth',
    description: 'For startups and small businesses.',
    priceMonthly: 8500,
    priceYearly: yearly(8500),
    currency: 'NGN',
    maxUsers: 3,
    maxBusinesses: 2,
    maxBranches: 1,
    maxProducts: 10_000,
    maxChannels: 4,
    maxContacts: 5_000,
    aiCreditsMonthly: 3_000,
    features: [
      'inbox', 'ai_support', 'ai_sales', 'ai_insights', 'crm', 'catalog', 'orders', 'invoices',
      'marketing', 'analytics', 'knowledge_base', 'team', 'loyalty', 'pos',
    ],
    isPublic: true,
    position: 2,
  },
  {
    name: 'Business',
    slug: 'business',
    description: 'For growing businesses.',
    priceMonthly: 22_500,
    priceYearly: yearly(22_500),
    currency: 'NGN',
    maxUsers: 10,
    maxBusinesses: 5,
    maxBranches: null,
    maxProducts: null,
    maxChannels: null,
    maxContacts: null,
    aiCreditsMonthly: 15_000,
    features: [
      'inbox', 'ai_support', 'ai_sales', 'ai_insights', 'crm', 'catalog', 'orders', 'invoices',
      'inventory', 'marketing', 'automations', 'analytics', 'knowledge_base',
      'team', 'loyalty', 'pos', 'api', 'webhooks',
    ],
    isPublic: true,
    position: 3,
  },
  {
    name: 'Enterprise',
    slug: 'enterprise',
    description: 'For organizations with large teams.',
    priceMonthly: 0, // custom / contact sales
    priceYearly: 0,
    currency: 'NGN',
    maxUsers: null,
    maxBusinesses: null,
    maxBranches: null,
    maxProducts: null,
    maxChannels: null,
    maxContacts: null,
    aiCreditsMonthly: null, // unlimited
    features: [...FEATURE_KEYS],
    isPublic: false, // "Custom pricing" — not self-serve checkout
    position: 4,
  },
];
