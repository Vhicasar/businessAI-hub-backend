import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const SITE_SCHEMA_VERSION = 3;

const colorTokensSchema = z.object({
  primary: z.string(), secondary: z.string(), accent: z.string(), background: z.string(),
  surface: z.string(), text: z.string(), muted: z.string(),
  surfaceSecondary: z.string().default('#F3F4F6'), border: z.string().default('#E5E7EB'),
});

export const dataBindingSchema = z.object({
  source: z.enum(['PRODUCTS', 'CATEGORIES', 'PROPERTIES', 'BUSINESS', 'TEAM', 'SERVICES']),
  filter: z.record(z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).default({}),
  sort: z.enum(['NEWEST', 'OLDEST', 'PRICE_ASC', 'PRICE_DESC', 'NAME_ASC']).default('NEWEST'),
  limit: z.number().int().min(1).max(48).default(8),
}).strict();

export const responsiveSchema = z.object({
  hidden: z.boolean().optional(),
  columns: z.number().int().min(1).max(6).optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
  paddingY: z.number().min(0).max(240).optional(),
  fontScale: z.number().min(.6).max(1.8).optional(),
}).strict();

export const siteSectionSchema = z.object({
  id: z.string().min(1).max(100),
  type: z.enum([
    'hero', 'products', 'properties', 'collections', 'services', 'features', 'about',
    'stats', 'testimonials', 'gallery', 'video', 'logoCloud', 'team', 'faq',
    'pricing', 'contact', 'newsletter', 'map', 'blog', 'cta', 'footer', 'spacer',
  ]),
  variant: z.string().max(60).default('default'),
  name: z.string().max(120).optional(),
  hidden: z.boolean().default(false),
  props: z.record(z.unknown()).default({}),
  binding: dataBindingSchema.optional(),
  responsive: z.object({
    desktop: responsiveSchema.optional(),
    tablet: responsiveSchema.optional(),
    mobile: responsiveSchema.optional(),
  }).default({}),
  animation: z.enum(['none', 'fade', 'reveal', 'slide-up', 'scale']).default('none'),
}).strict();

export const siteThemeSchema = z.object({
  mode: z.enum(['light', 'dark', 'system']).default('light'),
  allowVisitorSwitch: z.boolean().default(false),
  colors: colorTokensSchema,
  darkColors: colorTokensSchema.default({
    primary: '#FF8A5B', secondary: '#D7DDEA', accent: '#E1BA72', background: '#0D1117',
    surface: '#161B22', surfaceSecondary: '#202733', text: '#F3F4F6', muted: '#9CA3AF', border: '#303846',
  }),
  typography: z.object({
    headingFont: z.string(), bodyFont: z.string(), scale: z.number().min(.8).max(1.4), pairing: z.string(),
    headingWeight: z.number().int().min(300).max(800).default(700), bodyWeight: z.number().int().min(300).max(800).default(400),
    lineHeight: z.number().min(1).max(2).default(1.65), letterSpacing: z.number().min(-.08).max(.2).default(0),
  }),
  layout: z.object({
    containerWidth: z.number().int().min(880).max(1600), sectionSpacing: z.number().int().min(32).max(180),
    radius: z.number().int().min(0).max(48), shadow: z.enum(['none', 'soft', 'medium', 'dramatic']),
  }),
  buttons: z.object({ style: z.enum(['solid', 'outline', 'soft']), shape: z.enum(['square', 'rounded', 'pill']) }),
}).strict();

export const siteNavigationSchema = z.object({
  header: z.object({
    variant: z.enum(['minimal', 'centered', 'split', 'transparent']), logoUrl: z.string().max(2000).optional(),
    ctaLabel: z.string().max(60).optional(), ctaHref: z.string().max(500).optional(), sticky: z.boolean().default(true),
  }),
  footer: z.object({
    variant: z.enum(['simple', 'columns', 'editorial']), text: z.string().max(300).optional(),
    useOrganizationData: z.boolean().default(true), showLogo: z.boolean().default(true),
    showAddress: z.boolean().default(true), showPhone: z.boolean().default(true),
    showEmail: z.boolean().default(true), showBusinessHours: z.boolean().default(true),
    showSocialLinks: z.boolean().default(true),
  }),
}).strict();

export const siteSettingsSchema = z.object({
  commerce: z.object({ enabled: z.boolean().default(false), showInventory: z.boolean().default(true) }).default({}),
  forms: z.object({ destination: z.enum(['LEAD', 'CONTACT', 'DEAL', 'SUPPORT']).default('LEAD') }).default({}),
  analytics: z.object({ enabled: z.boolean().default(true) }).default({}),
  privacy: z.object({ cookieNotice: z.boolean().default(false) }).default({}),
  integrations: z.object({ webChat: z.boolean().default(true) }).default({}),
}).strict();

export type SiteSection = z.infer<typeof siteSectionSchema>;
export type SiteThemeV2 = z.infer<typeof siteThemeSchema>;

export const DEFAULT_THEME_V2: SiteThemeV2 = {
  mode: 'light',
  allowVisitorSwitch: true,
  colors: {
    primary: '#E85D2A', secondary: '#111827', accent: '#D6A75D', background: '#FBFAF7',
    surface: '#FFFFFF', surfaceSecondary: '#F3F4F6', text: '#171717', muted: '#6B7280', border: '#E5E7EB',
  },
  darkColors: { primary: '#FF8A5B', secondary: '#D7DDEA', accent: '#E1BA72', background: '#0D1117', surface: '#161B22', surfaceSecondary: '#202733', text: '#F3F4F6', muted: '#9CA3AF', border: '#303846' },
  typography: { headingFont: 'Manrope', bodyFont: 'Inter', scale: 1, pairing: 'modern', headingWeight: 700, bodyWeight: 400, lineHeight: 1.65, letterSpacing: 0 },
  layout: { containerWidth: 1200, sectionSpacing: 96, radius: 12, shadow: 'soft' },
  buttons: { style: 'solid', shape: 'rounded' },
};

export const DEFAULT_NAVIGATION = {
  header: { variant: 'minimal' as const, sticky: true, ctaLabel: 'Contact', ctaHref: '#contact' },
  footer: { variant: 'columns' as const, text: '', useOrganizationData: true, showLogo: true, showAddress: true, showPhone: true, showEmail: true, showBusinessHours: true, showSocialLinks: true },
};

export const DEFAULT_SETTINGS = {
  commerce: { enabled: false, showInventory: true },
  forms: { destination: 'LEAD' as const },
  analytics: { enabled: true },
  privacy: { cookieNotice: false },
  integrations: { webChat: true },
};

export function section(type: SiteSection['type'], props: Record<string, unknown>, options: Partial<SiteSection> = {}): SiteSection {
  return siteSectionSchema.parse({
    id: `sec_${randomUUID()}`, type, variant: 'default', hidden: false, props,
    responsive: {}, animation: 'none', ...options,
  });
}

export function blankHomepage(businessName: string): SiteSection[] {
  return [
    section('hero', { eyebrow: 'WELCOME', heading: businessName, subheading: 'A considered experience, built around what matters to you.', primaryLabel: 'Explore', primaryHref: '#explore' }, { variant: 'split', animation: 'reveal' }),
    section('about', { heading: 'Built with purpose', body: `Discover ${businessName} and what makes the business different.` }, { variant: 'editorial' }),
    section('contact', { heading: 'Start a conversation', body: 'Tell us what you need and our team will get back to you.', buttonLabel: 'Send enquiry' }, { variant: 'minimal' }),
  ];
}

export function normalizeSections(value: unknown): SiteSection[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => siteSectionSchema.safeParse(entry)).filter((entry) => entry.success).map((entry) => entry.data);
}

/**
 * Read an animation name the way a person would.
 *
 * The names are decorative hints, and a model will offer `fadeUp` or
 * `slideUp` as readily as the five this schema accepts. Losing an entire
 * section over the word for its entrance animation is absurd, so a near miss
 * is matched and anything unrecognisable falls back to the default.
 */
function animationName(value: string): string | undefined {
  const key = value.toLowerCase().replace(/[^a-z]/g, '');
  const known: Record<string, string> = {
    none: 'none', fade: 'fade', fadein: 'fade', fadeup: 'fade', fadeinup: 'fade',
    reveal: 'reveal', revealup: 'reveal',
    slideup: 'slide-up', slide: 'slide-up', slidein: 'slide-up', slideinup: 'slide-up',
    scale: 'scale', zoom: 'scale', zoomin: 'scale', grow: 'scale',
  };
  return known[key];
}

const BREAKPOINTS = new Set(['desktop', 'tablet', 'mobile']);
const RESPONSIVE_KEYS = new Set(['hidden', 'columns', 'align', 'paddingY', 'fontScale']);

/** The keys a section is allowed to carry; everything else is content. */
const SECTION_KEYS = new Set([
  'id', 'type', 'variant', 'name', 'hidden', 'props', 'binding', 'responsive', 'animation',
]);

/**
 * Make a language model's best effort fit the section schema.
 *
 * `siteSectionSchema` is strict on purpose: an API client that posts unknown
 * keys should be told so, not silently corrected. A model is not an API
 * client — it is approximating a shape from a paragraph of description, and it
 * will volunteer a `title` here or forget an `id` there. Rejecting the whole
 * section for that discarded entire websites over a single stray key, and the
 * business was told only that the AI "did not return a valid editable
 * website".
 *
 * So: keep the keys the schema knows, mint an id when one is missing, and fold
 * anything else into `props` rather than throwing the content away — the
 * renderer ignores props it has no use for, and the editor shows them. What is
 * still not salvageable (no recognisable section type) is reported, not
 * silently dropped.
 */
export function coerceAiSections(value: unknown): { sections: SiteSection[]; rejected: { index: number; reason: string }[] } {
  const rejected: { index: number; reason: string }[] = [];
  if (!Array.isArray(value)) return { sections: [], rejected: [{ index: -1, reason: 'not an array' }] };

  const sections: SiteSection[] = [];
  value.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      rejected.push({ index, reason: 'not an object' });
      return;
    }
    const source = entry as Record<string, unknown>;
    const known: Record<string, unknown> = {};
    const extra: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(source)) {
      if (SECTION_KEYS.has(key)) known[key] = item;
      else extra[key] = item;
    }
    if (!known.id || typeof known.id !== 'string') known.id = `sec_${randomUUID()}`;

    /*
     * Presentation hints the model is most likely to improvise.
     *
     * `responsive` is per-breakpoint settings and `animation` is one word, but
     * a model reading a field list without a shape guesses — gpt-5.4-mini
     * returns `responsive: { mobile: "stack" }` and `animation: { type: "none",
     * delay: 0 }`, both reasonable and both wrong. These are hints with
     * perfectly good defaults, so a value we cannot read is dropped rather
     * than taking the whole section down with it.
     */
    if (known.animation !== undefined) {
      const nested = typeof known.animation === 'string'
        ? known.animation
        : (known.animation as { type?: unknown } | null)?.type;
      known.animation = typeof nested === 'string' ? animationName(nested) : undefined;
    }
    if (known.hidden !== undefined && typeof known.hidden !== 'boolean') {
      known.hidden = known.hidden === 'true' ? true : known.hidden === 'false' ? false : undefined;
    }
    if (known.responsive !== undefined) {
      const source = known.responsive;
      if (!source || typeof source !== 'object' || Array.isArray(source)) known.responsive = undefined;
      else {
        const usable: Record<string, unknown> = {};
        for (const [breakpoint, settings] of Object.entries(source as Record<string, unknown>)) {
          if (!BREAKPOINTS.has(breakpoint)) continue;
          if (!settings || typeof settings !== 'object' || Array.isArray(settings)) continue;
          // The per-breakpoint object is strict too, so an invented key such as
          // `{ stack: true }` would sink the section from one level further down.
          const kept: Record<string, unknown> = {};
          for (const [key, item] of Object.entries(settings as Record<string, unknown>)) {
            if (RESPONSIVE_KEYS.has(key)) kept[key] = item;
          }
          if (Object.keys(kept).length) usable[breakpoint] = kept;
        }
        known.responsive = usable;
      }
    }
    for (const key of ['animation', 'responsive', 'variant', 'hidden'] as const) {
      if (known[key] === undefined) delete known[key];   // let the schema default it
    }
    const props = (known.props && typeof known.props === 'object' && !Array.isArray(known.props))
      ? known.props as Record<string, unknown>
      : {};
    known.props = Object.keys(extra).length ? { ...extra, ...props } : props;

    const parsed = siteSectionSchema.safeParse(known);
    if (parsed.success) sections.push(parsed.data);
    else rejected.push({ index, reason: parsed.error.issues.map((i) => `${i.path.join('.') || 'section'}: ${i.message}`).join('; ').slice(0, 160) });
  });
  return { sections, rejected };
}
