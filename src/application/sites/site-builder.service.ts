import { createHash, randomUUID } from 'node:crypto';
import { resolveCname, resolveTxt } from 'node:dns/promises';
import { z } from 'zod';
import { prisma, prismaUnscoped } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../../shared/errors';
import { getWorkspaceConfig } from '../settings/workspace-config';
import { resolveEntitlements } from '../billing/entitlements';
import { domainConfigService } from './domain-config.service';
import { encrypt } from '../../shared/crypto';
import { logger } from '../../shared/logger';
import { addOnsService } from '../billing/add-ons.service';
import { PLATFORM_FEATURES, isPlatformFeatureEnabled } from '../settings/platform-features';
/*
 * `resolveAi`, not `getAiProvider`: the website builder is an AI surface like
 * any other, so it must run on the business's own provider when they have
 * connected one. Reading the platform configuration directly meant a business
 * that had set up its own key still had its website work billed to the
 * platform's — and, when the platform key was empty, refused outright.
 */
import { resolveAi } from '../ai/org-ai.service';
import { aiCredits } from '../billing/ai-credits';
import { extractJson } from '../ai/ai-provider';
import {
  DEFAULT_NAVIGATION, DEFAULT_SETTINGS, DEFAULT_THEME_V2, SITE_SCHEMA_VERSION,
  blankHomepage, normalizeSections, siteNavigationSchema, siteSectionSchema,
  siteSettingsSchema, siteThemeSchema, coerceAiSections,
} from './site-schema';

const orgId = () => {
  const value = requestContext.get()?.organizationId;
  if (!value) throw new ValidationError('No tenant in context');
  return value;
};

/** The entitlement an explicit subdomain grant carries, however it was obtained. */
const SUBDOMAIN_FEATURE = 'website_subdomain';

/**
 * Whether this business may publish a website to a platform subdomain.
 *
 * Publishing used to require the Website Subdomain add-on outright, which made
 * a website something a business had to buy before it could have one at all —
 * and a business with no website has nothing to put a payment link on, so the
 * add-on was gating the thing that would have justified it.
 *
 * Two ways through, in this order:
 *
 *  - An explicit grant. Read from the entitlement resolver rather than from
 *    the purchase table directly, so a plan that includes the feature, an
 *    add-on purchase and a platform-admin override all count — which is the
 *    point of having one entitlement system.
 *  - The platform switch, which the administrator uses to decide whether a
 *    subdomain is included at no cost. On by default.
 *
 * With the switch off, behaviour returns to what it was: the grant is
 * required. A business that already published keeps its site either way —
 * `publish` only consults this when the subdomain is actually changing.
 */
async function subdomainPublishingAllowed(organizationId: string): Promise<
  { allowed: true; via: 'entitlement' | 'platform' } | { allowed: false }
> {
  const entitlements = await resolveEntitlements(organizationId);
  if (entitlements.features.has(SUBDOMAIN_FEATURE)) return { allowed: true, via: 'entitlement' };
  if (isPlatformFeatureEnabled(PLATFORM_FEATURES.freePlanWebsiteSubdomain)) {
    return { allowed: true, via: 'platform' };
  }
  return { allowed: false };
}

const userId = () => requestContext.get()?.userId ?? null;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
const SUBDOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
/**
 * Subdomains a tenant may not claim.
 *
 * Not cosmetic. The website renderer is mounted last in this same app, after
 * every application route, so a site published on a hostname the platform
 * itself relies on would answer for every path those routes do not match —
 * a tenant taking `api` or the deployment's own hostname would be serving
 * their homepage at an address the business reads as ours.
 *
 * `SITE_RESERVED_SUBDOMAINS` extends this for a deployment whose
 * infrastructure sits on other names under the same base domain.
 */
const RESERVED = new Set([
  'www', 'app', 'api', 'admin', 'mail', 'sites', 'docs', 'blog', 'help', 'status',
  // The platform's own and conventional service names.
  'businesshub', 'hub', 'cdn', 'static', 'assets', 'media', 'files',
  'smtp', 'imap', 'pop', 'webmail', 'mx', 'autodiscover', 'ns1', 'ns2', 'ftp',
  'staging', 'auth', 'billing', 'portal',
  // Names a customer would read as the platform speaking, not a business.
  'support', 'dashboard', 'account', 'accounts', 'login', 'signup', 'pay', 'checkout',
  ...String(process.env.SITE_RESERVED_SUBDOMAINS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean),
]);
const DOMAIN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
/**
 * Where a customer's own domain has to point.
 *
 * This is the hostname of the server that will answer for their domain, so it
 * belongs to the deployment, not to the source code. The platform
 * administrator sets it in Vhicasar Admin → Deployments; a hardcoded default
 * would hand every customer's DNS to somebody else's platform, and — worse —
 * verification would then check against that same wrong name and could never
 * pass, no matter what the customer did.
 */
async function customDomainTarget(): Promise<string> {
  const config = await domainConfigService.active();
  const target = config?.cnameTarget || process.env.SITE_CUSTOM_DOMAIN_TARGET;
  if (!target) {
    throw new AppError(
      'SITE_HOSTING_NOT_CONFIGURED',
      503,
      'Managed website hosting is not configured by the platform administrator, so there is no address for a custom domain to point at.',
    );
  }
  return target.toLowerCase();
}

export const pageSeoSchema = z.object({
  title: z.string().trim().max(120).optional().default(''),
  description: z.string().trim().max(320).optional().default(''),
  socialImageUrl: z.string().trim().url().max(2000).or(z.literal('')).optional().default(''),
  canonicalUrl: z.string().trim().url().max(2000).or(z.literal('')).optional().default(''),
  index: z.boolean().optional().default(true),
}).strict();

const optionalPageSeoSchema = pageSeoSchema.nullish().transform((value) => pageSeoSchema.parse(value ?? {}));

export const createWebsiteSchema = z.object({
  name: z.string().trim().min(2).max(120),
  /*
   * "Build with AI" is paused. 'AI' is removed from what the API will accept,
   * not merely hidden in the UI, so a saved request or a direct API call
   * cannot start a generation the product is not currently offering.
   *
   * To re-enable: put 'AI' back here, restore the branch in `create` below,
   * and uncomment the tab in web/src/features/website/WebsitePage.tsx. The
   * generator (`aiDraft`) and its tests are left intact.
   */
  mode: z.enum(['BLANK', 'TEMPLATE']),
  templateId: z.string().max(80).optional(),
  prompt: z.string().trim().min(10).max(1500).optional(),
  theme: siteThemeSchema.optional(),
  settings: siteSettingsSchema.optional(),
  pages: z.array(z.object({
    title: z.string().trim().min(1).max(120),
    slug: z.string().max(80),
    sections: z.array(siteSectionSchema),
    seo: optionalPageSeoSchema.optional(),
  })).max(20).optional(),
});

export const updateWebsiteSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  theme: siteThemeSchema.optional(),
  navigation: siteNavigationSchema.optional(),
  settings: siteSettingsSchema.optional(),
  seo: optionalPageSeoSchema.optional(),
  thumbnailUrl: z.string().url().max(2000).nullable().optional(),
});

export const updateWebsitePageSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  slug: z.string().max(80).optional(),
  sections: z.array(siteSectionSchema).max(100).optional(),
  seo: optionalPageSeoSchema.optional(),
  showInNav: z.boolean().optional(),
  status: z.enum(['DRAFT', 'PUBLISHED', 'HIDDEN']).optional(),
});

export const aiWebsiteEditSchema = z.object({
  pageId: z.string().min(1),
  instruction: z.string().trim().min(3).max(1000),
});

function publicUrl(site: { subdomain: string | null; customDomain: string | null; domainVerifiedAt: Date | null }, baseDomain?: string | null) {
  if (site.customDomain && site.domainVerifiedAt) return `https://${site.customDomain}`;
  return site.subdomain && baseDomain ? `https://${site.subdomain}.${baseDomain}` : null;
}

async function limitForOrganization(organizationId: string) {
  const configLimit = Number(getWorkspaceConfig().limits.maxWebsites ?? 1);
  const purchases = await prismaUnscoped.addOnPurchase.findMany({
    where: { organizationId, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    select: { entitlements: true },
  });
  const extra = purchases.reduce((sum, purchase) => {
    const entitlements = (purchase.entitlements ?? {}) as Record<string, unknown>;
    return sum + Math.max(0, Number(entitlements.maxWebsites ?? 0));
  }, 0);
  return Math.max(1, Number.isFinite(configLimit) ? configLimit : 1) + extra;
}

async function loadSite(id: string) {
  const site = await prisma.site.findFirst({
    where: { id }, include: { pages: { orderBy: { position: 'asc' } } },
  });
  if (!site) throw new NotFoundError('Website');
  return site;
}

function snapshot(site: Awaited<ReturnType<typeof loadSite>>) {
  return {
    schemaVersion: SITE_SCHEMA_VERSION,
    site: {
      id: site.id, name: site.name, templateId: site.templateId, theme: site.theme,
      navigation: site.navigation, settings: site.settings, seo: site.seo,
    },
    pages: site.pages.map((page) => ({
      id: page.id, title: page.title, slug: page.slug, sections: page.blocks,
      seo: page.seo, isHome: page.isHome, showInNav: page.showInNav, status: page.status,
    })),
  };
}

/**
 * The v1 builder created a site as a side effect of opening the feature. Those
 * untouched shells must not consume a v2 website allowance. Migration added a
 * schemaVersion default to every row, so the old theme shape is the reliable
 * discriminator; deployed or versioned sites are always treated as real.
 */
export function isLegacyAutoCreatedShell(site: {
  theme: unknown;
  publishedAt: Date | null;
  publishedSnapshot: unknown;
  subdomain: string | null;
  customDomain: string | null;
  pages: Array<{ blocks: unknown }>;
}) {
  const theme = (site.theme ?? {}) as Record<string, unknown>;
  const hasV2DesignTokens = typeof theme.colors === 'object' && theme.colors !== null && typeof theme.typography === 'object' && theme.typography !== null;
  return !hasV2DesignTokens && !site.publishedAt && !site.publishedSnapshot && !site.subdomain && !site.customDomain && site.pages.length <= 1;
}

/**
 * Turn whatever the model called a page into a usable slug.
 *
 * Models write `/contact`, `Contact Us`, or `contact-page/`. Replacing the bad
 * characters one for one leaves `-contact`, which then fails validation and
 * takes the whole build down at the last step — after the model has already
 * been paid for and the pages are otherwise fine.
 */
export function pageSlug(value: unknown, index: number): string {
  const slug = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
    .replace(/-$/, '');
  return slug || `page-${index + 1}`;
}

async function aiDraft(name: string, prompt: string) {
  const { provider, ownKey } = await resolveAi('website');
  // Metered like every other AI feature; a business on its own key pays its
  // own provider and is not charged plan credits twice.
  if (!ownKey) await aiCredits.consume(orgId());
  const organization = await prisma.organization.findUnique({
    where: { id: orgId() },
    select: { name: true, businessType: true, website: true, city: true, country: true },
  });
  const raw = await provider.complete([
    {
      role: 'system',
      content: 'Design a polished website using the supplied structured schema. Return JSON only with keys theme and pages. ' +
        'theme must contain colors, typography, layout, buttons. Each page contains title, slug and sections. ' +
        'Allowed section types: hero, products, properties, collections, services, features, about, stats, testimonials, gallery, video, logoCloud, team, faq, pricing, contact, newsletter, map, blog, cta, footer, spacer. ' +
        'Each section is {id, type, variant, hidden, props, responsive, animation}. `id` is a string starting sec_. `variant` is a short string. `hidden` is a boolean. `props` holds that section\'s content. `responsive` is optional and, when present, maps desktop/tablet/mobile to {hidden?: boolean, columns?: 1-6, align?: left|center|right, paddingY?: number, fontScale?: number} — never to a string. `animation` is optional and is exactly one of none, fade, reveal, slide-up, scale — a plain string, never an object. Omit responsive and animation entirely unless they add something. ' +
        'Never emit HTML, scripts, CSS or invented business claims. Use data binding for products/properties rather than copying records.',
    },
    { role: 'user', content: JSON.stringify({ request: prompt, websiteName: name, business: organization }) },
  ], { maxTokens: 8000, temperature: .55, jsonMode: true, dataSources: ['user_provided', 'vhicasar_business'] });
  const parsed = extractJson<{ theme?: unknown; pages?: { title?: string; slug?: string; sections?: unknown }[] }>(raw);
  /*
   * A whole site — theme plus every page — does not fit in 3000 tokens, and a
   * truncated reply is unparseable JSON that arrived here as the same blank
   * "invalid website" the business was shown. Distinguish the two, and say
   * which happened in the log, because the model's reply used to be discarded
   * and the failure was impossible to diagnose after the fact.
   */
  if (!parsed) {
    logger.warn({ organizationId: orgId(), rawLength: raw.length, sample: raw.slice(0, 400) }, 'AI website generation returned no parseable JSON');
    throw new AppError('AI_WEBSITE_INVALID', 502, 'The AI response was cut short or unreadable. Try again, or shorten the description.');
  }
  const theme = siteThemeSchema.safeParse(parsed?.theme);
  const rejections: { page: number; index: number; reason: string }[] = [];
  const pages = (parsed?.pages ?? []).slice(0, 10).map((page, index) => {
    const { sections, rejected } = coerceAiSections(page.sections);
    rejected.forEach((item) => rejections.push({ page: index, ...item }));
    return {
      title: String(page.title || (index === 0 ? 'Home' : `Page ${index + 1}`)).slice(0, 120),
      slug: index === 0 ? '' : pageSlug(page.slug, index),
      sections,
    };
  }).filter((page) => page.sections.length);
  if (rejections.length) {
    logger.warn({ organizationId: orgId(), rejected: rejections.slice(0, 10), kept: pages.length }, 'Some AI website sections could not be used');
  }
  if (!pages.length) {
    logger.warn({ organizationId: orgId(), pagesReturned: parsed?.pages?.length ?? 0, rejected: rejections.slice(0, 10) }, 'AI website generation produced no usable page');
    throw new AppError('AI_WEBSITE_INVALID', 502, 'The AI did not return a usable website layout. Try again, or describe the pages you want in more detail.');
  }
  return { theme: theme.success ? theme.data : DEFAULT_THEME_V2, pages };
}

/**
 * A site, with the address it is actually reachable at.
 *
 * Every path that hands a site back to the editor goes through this, because
 * the one moment the address matters most is immediately after publishing —
 * and `publish` used to return the bare row, so the screen had nothing to
 * show and the person had to guess their own URL.
 */
async function withPublicUrl(id: string) {
  const [site, config] = await Promise.all([loadSite(id), domainConfigService.active()]);
  return { ...site, publicUrl: publicUrl(site, config?.baseDomain ?? null) };
}

export const siteBuilderService = {
  async list() {
    const organizationId = orgId();
    const [allSites, limit] = await Promise.all([
      prisma.site.findMany({
        orderBy: { updatedAt: 'desc' },
        include: { pages: { select: { id: true, title: true, slug: true, isHome: true, blocks: true }, orderBy: { position: 'asc' } } },
      }),
      limitForOrganization(organizationId),
    ]);
    const sites = allSites.filter((site) => !isLegacyAutoCreatedShell(site));
    /*
     * The live address is answered here, not assembled in the browser.
     *
     * It depends on the active deployment configuration, which the client has
     * no business guessing — two places in the editor used to build it from a
     * hardcoded domain and showed every customer a hostname that does not
     * exist.
     */
    const baseDomain = (await domainConfigService.active())?.baseDomain ?? null;
    return {
      sites: sites.map((site) => ({ ...site, publicUrl: publicUrl(site, baseDomain) })),
      limit,
      used: sites.length,
    };
  },

  async get(id: string) {
    return withPublicUrl(id);
  },

  async create(input: z.infer<typeof createWebsiteSchema>) {
    const organizationId = orgId();
    const [existingSites, limit] = await Promise.all([
      prisma.site.findMany({ include: { pages: { select: { blocks: true } } }, orderBy: { createdAt: 'asc' } }),
      limitForOrganization(organizationId),
    ]);
    const legacyShell = existingSites.find(isLegacyAutoCreatedShell);
    const count = existingSites.filter((site) => !isLegacyAutoCreatedShell(site)).length;
    if (count >= limit) throw new AppError('PLAN_LIMIT_REACHED', 403, `Your plan allows ${limit} website${limit === 1 ? '' : 's'}.`, { kind: 'websites', limit, used: count });

    let theme = input.theme ?? DEFAULT_THEME_V2;
    let pages = input.pages;
    // Paused — see the note on `mode` above.
    // if (input.mode === 'AI') {
    //   if (!input.prompt) throw new ValidationError('Describe the website you want to create');
    //   const generated = await aiDraft(input.name, input.prompt);
    //   theme = generated.theme;
    //   pages = generated.pages;
    // }
    if (!pages?.length) pages = [{ title: 'Home', slug: '', sections: blankHomepage(input.name) }];
    const seen = new Set<string>();
    for (const page of pages) {
      if (page.slug && !SLUG.test(page.slug)) throw new ValidationError(`Invalid page slug: ${page.slug}`);
      if (seen.has(page.slug)) throw new ConflictError(`Duplicate page slug: ${page.slug || '/'}`);
      seen.add(page.slug);
    }
    const homeIndex = Math.max(0, pages.findIndex((page) => page.slug === ''));
    const siteData = {
      organizationId, name: input.name, templateId: input.templateId, schemaVersion: SITE_SCHEMA_VERSION,
      theme: theme as object, navigation: DEFAULT_NAVIGATION, settings: input.settings ?? DEFAULT_SETTINGS,
      seo: { title: input.name, description: `${input.name} official website.` }, lastEditedByUserId: userId(),
    };
    const pageData = pages.map((page, index) => ({
      organizationId, title: page.title, slug: index === homeIndex ? '' : page.slug,
      blocks: page.sections as object, seo: { ...pageSeoSchema.parse(page.seo ?? {}), title: page.seo?.title || page.title }, position: index,
      isHome: index === homeIndex, showInNav: true,
    }));
    if (legacyShell) {
      return prisma.site.update({
        where: { id: legacyShell.id },
        data: { ...siteData, status: 'DRAFT', publishError: null, pages: { deleteMany: {}, create: pageData } },
        include: { pages: { orderBy: { position: 'asc' } } },
      });
    }
    return prisma.site.create({
      data: {
        ...siteData,
        pages: { create: pageData },
      },
      include: { pages: { orderBy: { position: 'asc' } } },
    });
  },

  async update(id: string, input: z.infer<typeof updateWebsiteSchema>) {
    await loadSite(id);
    return prisma.site.update({
      where: { id }, data: { ...input, ...(input.theme ? { schemaVersion: SITE_SCHEMA_VERSION } : {}), lastEditedByUserId: userId() },
      include: { pages: { orderBy: { position: 'asc' } } },
    });
  },

  async createPreview(id: string) {
    const site = await loadSite(id);
    const expiresAt = Date.now() + 60 * 60 * 1000;
    const token = encrypt(JSON.stringify({ purpose: 'website-preview', siteId: site.id, organizationId: site.organizationId, expiresAt }));
    return { token, expiresAt: new Date(expiresAt).toISOString(), url: `/preview/${encodeURIComponent(token)}/` };
  },

  async duplicate(id: string) {
    const organizationId = orgId();
    const [source, count, limit] = await Promise.all([loadSite(id), prisma.site.count(), limitForOrganization(organizationId)]);
    if (count >= limit) throw new AppError('PLAN_LIMIT_REACHED', 403, `Your plan allows ${limit} website${limit === 1 ? '' : 's'}.`, { kind: 'websites', limit, used: count });
    return prisma.site.create({
      data: {
        organizationId,
        name: `${source.name} copy`.slice(0, 120),
        templateId: source.templateId,
        schemaVersion: source.schemaVersion,
        theme: source.theme as object,
        navigation: source.navigation as object,
        settings: source.settings as object,
        seo: source.seo as object,
        status: 'DRAFT',
        lastEditedByUserId: userId(),
        pages: { create: source.pages.map((page) => ({
          organizationId,
          title: page.title,
          slug: page.slug,
          blocks: page.blocks as object,
          seo: page.seo as object,
          position: page.position,
          isHome: page.isHome,
          showInNav: page.showInNav,
          status: page.status,
        })) },
      },
      include: { pages: { orderBy: { position: 'asc' } } },
    });
  },

  async remove(id: string) {
    await loadSite(id);
    await prisma.$transaction([
      prisma.siteEvent.deleteMany({ where: { siteId: id } }),
      prisma.siteVersion.deleteMany({ where: { siteId: id } }),
      prisma.sitePage.deleteMany({ where: { siteId: id } }),
      prisma.site.delete({ where: { id } }),
    ]);
    return { deleted: true };
  },

  async deploymentInfo() {
    const [config, addOns, permission] = await Promise.all([
      domainConfigService.active(),
      addOnsService.list(),
      subdomainPublishingAllowed(orgId()),
    ]);
    const addOn = addOns.find((item) => item.id === SUBDOMAIN_FEATURE);
    return {
      baseDomain: config?.baseDomain ?? null,
      provider: config?.provider ?? null,
      managedDomainsEnabled: Boolean(config),
      /*
       * Whether publishing is available without buying anything, so the editor
       * can stop advertising an add-on that is not needed. `via` tells the two
       * apart: a workspace that bought the add-on should still see it as
       * active rather than be told hosting is simply free.
       */
      subdomainIncluded: permission.allowed && permission.via === 'platform',
      canPublishToSubdomain: permission.allowed,
      addOn: addOn ? { id: addOn.id, title: addOn.title, billingType: addOn.billingType, price: addOn.price, active: addOn.activePurchases.length > 0 } : null,
    };
  },

  async subdomainAvailable(siteId: string, value: string) {
    await loadSite(siteId);
    const subdomain = value.trim().toLowerCase();
    const config = await domainConfigService.active();
    if (!config) return { available: false, reason: 'Managed website domains are not configured', baseDomain: null };
    if (!SUBDOMAIN.test(subdomain) || subdomain.length < 3 || RESERVED.has(subdomain)) return { available: false, reason: 'Invalid or reserved', baseDomain: config.baseDomain };
    const collision = await prismaUnscoped.site.findFirst({ where: { subdomain, id: { not: siteId } }, select: { id: true } });
    return { available: !collision, reason: collision ? 'Already in use' : null, baseDomain: config.baseDomain, url: `https://${subdomain}.${config.baseDomain}` };
  },

  async connectDomain(id: string, raw: string) {
    await loadSite(id);
    const domain = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!DOMAIN.test(domain)) throw new ValidationError('Enter a valid domain such as www.example.com');
    const collision = await prismaUnscoped.site.findFirst({ where: { customDomain: domain, id: { not: id } }, select: { id: true } });
    if (collision) throw new ConflictError('This domain is already connected to another website');
    const token = `vh_${randomUUID().replace(/-/g, '')}`;
    const target = await customDomainTarget();
    const site = await prisma.site.update({ where: { id }, data: { customDomain: domain, domainVerificationToken: token, domainVerifiedAt: null } });
    return { site, dns: { cname: { host: domain, value: target }, txt: { host: `_vhicasar.${domain}`, value: token } } };
  },

  async verifyDomain(id: string) {
    const site = await loadSite(id);
    if (!site.customDomain || !site.domainVerificationToken) throw new ValidationError('Connect a domain first');
    const target = await customDomainTarget();
    let cnameVerified = false; let txtVerified = false;
    try { cnameVerified = (await resolveCname(site.customDomain)).some((entry) => entry.replace(/\.$/, '').toLowerCase() === target); } catch { /* DNS propagation. */ }
    try { txtVerified = (await resolveTxt(`_vhicasar.${site.customDomain}`)).flat().some((entry) => entry === site.domainVerificationToken); } catch { /* DNS propagation. */ }
    if (!cnameVerified || !txtVerified) {
      // Repeat what the records must say. A bare "not visible yet" leaves
      // somebody staring at their DNS panel with nothing to compare against.
      return {
        verified: false,
        cnameVerified,
        txtVerified,
        expected: {
          cname: { host: site.customDomain, value: target },
          txt: { host: `_vhicasar.${site.customDomain}`, value: site.domainVerificationToken },
        },
        reason: 'DNS records are not visible yet. Propagation can take up to 48 hours.',
      };
    }
    await prisma.site.update({ where: { id }, data: { domainVerifiedAt: new Date() } });
    return { verified: true, cnameVerified: true, txtVerified: true };
  },

  async disconnectDomain(id: string) {
    await loadSite(id);
    return prisma.site.update({ where: { id }, data: { customDomain: null, domainVerificationToken: null, domainVerifiedAt: null } });
  },

  async createPage(siteId: string, input: { title: string; slug: string; seo?: z.infer<typeof pageSeoSchema> | null }) {
    const site = await loadSite(siteId);
    const slug = input.slug.trim().toLowerCase();
    if (!SLUG.test(slug)) throw new ValidationError('Use lowercase letters, numbers and hyphens for the page URL');
    if (site.pages.some((page) => page.slug === slug)) throw new ConflictError('That page URL is already in use');
    return prisma.sitePage.create({
      data: { organizationId: site.organizationId, siteId, title: input.title, slug, blocks: [], seo: { ...pageSeoSchema.parse(input.seo ?? {}), title: input.seo?.title || input.title }, position: site.pages.length },
    });
  },

  async updatePage(siteId: string, pageId: string, input: z.infer<typeof updateWebsitePageSchema>) {
    const site = await loadSite(siteId);
    const page = site.pages.find((entry) => entry.id === pageId);
    if (!page) throw new NotFoundError('Website page');
    if (input.slug !== undefined && input.slug !== '' && !SLUG.test(input.slug)) throw new ValidationError('Invalid page URL');
    if (input.slug === '' && !page.isHome) throw new ValidationError('Use Set as homepage instead of clearing the URL');
    return prisma.sitePage.update({
      where: { id: pageId },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.slug !== undefined ? { slug: input.slug } : {}),
        ...(input.sections !== undefined ? { blocks: input.sections as object } : {}),
        ...(input.seo !== undefined ? { seo: input.seo as object } : {}),
        ...(input.showInNav !== undefined ? { showInNav: input.showInNav } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
      },
    });
  },

  async aiEdit(siteId: string, input: z.infer<typeof aiWebsiteEditSchema>) {
    const site = await loadSite(siteId);
    const page = site.pages.find((entry) => entry.id === input.pageId);
    if (!page) throw new NotFoundError('Website page');
    const { provider, ownKey } = await resolveAi('website');
    if (!ownKey) await aiCredits.consume(site.organizationId);
    await this.snapshot(siteId, 'Before AI edit');
    const raw = await provider.complete([
      {
        role: 'system',
        content: 'You edit a structured website page. Return JSON only as {"sections": [...]}. Preserve section ids for edited sections and create ids beginning with sec_ for new sections. `responsive`, when present, maps desktop/tablet/mobile to {hidden?, columns?, align?, paddingY?, fontScale?} — never to a string; `animation` is one of none, fade, reveal, slide-up, scale as a plain string. Omit both unless they add something. Allowed types: hero, products, properties, collections, services, features, about, stats, testimonials, gallery, video, logoCloud, team, faq, pricing, contact, newsletter, map, blog, cta, footer, spacer. Never emit code, HTML, CSS or scripts. Preserve data bindings and never copy private business records into props.',
      },
      { role: 'user', content: JSON.stringify({ instruction: input.instruction, sections: page.blocks, theme: site.theme }) },
    ], { maxTokens: 3000, temperature: .35, jsonMode: true, dataSources: ['user_provided', 'vhicasar_business'] });
    const parsed = extractJson<{ sections?: unknown }>(raw);
    if (!parsed) {
      logger.warn({ siteId, rawLength: raw.length, sample: raw.slice(0, 400) }, 'AI website edit returned no parseable JSON');
      throw new AppError('AI_WEBSITE_INVALID', 502, 'The AI response was cut short or unreadable. Try again, or ask for a smaller change.');
    }
    const { sections, rejected } = coerceAiSections(parsed?.sections);
    if (rejected.length) {
      logger.warn({ siteId, rejected: rejected.slice(0, 10), kept: sections.length }, 'Some AI-edited sections could not be used');
    }
    if (!sections.length) {
      logger.warn({ siteId, rejected: rejected.slice(0, 10) }, 'AI website edit produced no usable section');
      throw new AppError('AI_WEBSITE_INVALID', 502, 'The AI edit did not produce a usable layout. Try rephrasing the instruction.');
    }
    await prisma.sitePage.update({ where: { id: page.id }, data: { blocks: sections as object } });
    await prisma.site.update({ where: { id: siteId }, data: { lastEditedByUserId: userId() } });
    return { pageId: page.id, sections };
  },

  async setHomepage(siteId: string, pageId: string) {
    const site = await loadSite(siteId);
    const page = site.pages.find((entry) => entry.id === pageId);
    if (!page) throw new NotFoundError('Website page');
    const oldHome = site.pages.find((entry) => entry.isHome);
    await prisma.$transaction([
      ...(oldHome && oldHome.id !== pageId ? [prisma.sitePage.update({ where: { id: oldHome.id }, data: { isHome: false, slug: oldHome.slug || 'home' } })] : []),
      prisma.sitePage.update({ where: { id: pageId }, data: { isHome: true, slug: '' } }),
    ]);
    return withPublicUrl(siteId);
  },

  async deletePage(siteId: string, pageId: string) {
    const site = await loadSite(siteId);
    const page = site.pages.find((entry) => entry.id === pageId);
    if (!page) throw new NotFoundError('Website page');
    if (page.isHome) throw new ValidationError('Choose another homepage before deleting this page');
    await prisma.sitePage.delete({ where: { id: pageId } });
    return { deleted: true };
  },

  async snapshot(id: string, label: string, isPublished = false) {
    const site = await loadSite(id);
    return prisma.siteVersion.create({
      data: { organizationId: site.organizationId, siteId: id, label: label.slice(0, 80), snapshot: snapshot(site) as object, editorUserId: userId(), isPublished },
      select: { id: true, label: true, editorUserId: true, isPublished: true, createdAt: true },
    });
  },

  async versions(id: string) {
    await loadSite(id);
    return prisma.siteVersion.findMany({ where: { siteId: id }, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, label: true, editorUserId: true, isPublished: true, createdAt: true } });
  },

  async restore(id: string, versionId: string) {
    const site = await loadSite(id);
    const version = await prisma.siteVersion.findFirst({ where: { id: versionId, siteId: id } });
    if (!version) throw new NotFoundError('Website version');
    await this.snapshot(id, 'Before restore');
    const value = version.snapshot as ReturnType<typeof snapshot>;
    await prisma.$transaction([
      prisma.site.update({ where: { id }, data: { name: value.site.name, theme: value.site.theme as object, navigation: value.site.navigation as object, settings: value.site.settings as object, seo: value.site.seo as object, lastEditedByUserId: userId() } }),
      prisma.sitePage.deleteMany({ where: { siteId: id } }),
      ...value.pages.map((page, position) => prisma.sitePage.create({ data: { organizationId: site.organizationId, siteId: id, title: page.title, slug: page.slug, blocks: page.sections as object, seo: (page.seo ?? {}) as object, isHome: page.isHome, showInNav: page.showInNav, status: page.status, position } })),
    ]);
    return withPublicUrl(id);
  },

  async publish(id: string, subdomain: string) {
    const value = subdomain.trim().toLowerCase();
    if (!SUBDOMAIN.test(value) || value.length < 3 || RESERVED.has(value)) throw new ValidationError('Choose a valid, non-reserved subdomain');
    const collision = await prismaUnscoped.site.findFirst({ where: { subdomain: value, id: { not: id } }, select: { id: true } });
    if (collision) throw new ConflictError('That subdomain is already in use');
    const site = await loadSite(id);
    const deployment = await domainConfigService.active();
    if (!deployment) throw new AppError('SITE_HOSTING_NOT_CONFIGURED', 503, 'Managed website hosting is not configured by the platform administrator.');
    const alreadyUsesSubdomain = site.subdomain === value && site.publishedAt !== null;
    if (!alreadyUsesSubdomain) {
      const permission = await subdomainPublishingAllowed(site.organizationId);
      if (!permission.allowed) {
        throw new AppError(
          'SUBDOMAIN_ADD_ON_REQUIRED', 402,
          'Publishing to a platform subdomain is not included on this workspace. '
          + 'Activate the Website Subdomain add-on to publish.',
        );
      }
    }
    if (!site.pages.length || !site.pages.some((page) => page.isHome)) throw new ValidationError('The website needs a homepage before publishing');
    const release = snapshot(site);
    await prisma.site.update({ where: { id }, data: { status: 'PUBLISHING', publishError: null } });
    try {
      await prisma.$transaction([
        prisma.site.update({ where: { id }, data: { status: 'PUBLISHED', subdomain: value, publishedSnapshot: release as object, publishedAt: new Date(), unpublishedAt: null, publishError: null } }),
        prisma.siteVersion.create({ data: { organizationId: site.organizationId, siteId: id, label: `Published ${value}`, snapshot: release as object, editorUserId: userId(), isPublished: true } }),
      ]);
    } catch (error) {
      await prisma.site.update({ where: { id }, data: { status: 'FAILED', publishError: 'Publishing failed. The previous live version is still available.' } }).catch(() => undefined);
      throw error;
    }
    return withPublicUrl(id);
  },

  async unpublish(id: string) {
    await loadSite(id);
    await prisma.site.update({ where: { id }, data: { status: 'UNPUBLISHED', unpublishedAt: new Date() } });
    // Same shape as every other site response, so the editor does not have to
    // special-case which call it just made.
    return withPublicUrl(id);
  },

  async analytics(id: string, days = 30) {
    await loadSite(id);
    const since = new Date(Date.now() - Math.min(365, Math.max(1, days)) * 86_400_000);
    const grouped = await prisma.siteEvent.groupBy({ where: { siteId: id, createdAt: { gte: since } }, by: ['type'], _count: { _all: true } });
    const topPages = await prisma.siteEvent.groupBy({ where: { siteId: id, type: 'PAGE_VIEW', createdAt: { gte: since } }, by: ['path'], _count: { _all: true }, orderBy: { _count: { path: 'desc' } }, take: 10 });
    return { since, totals: Object.fromEntries(grouped.map((row) => [row.type, row._count._all])), topPages: topPages.map((row) => ({ path: row.path, views: row._count._all })) };
  },

  async recordEvent(siteId: string, type: string, path: string, session: string | undefined, referrer: string | undefined, metadata?: Record<string, unknown>) {
    const safeTypes = new Set(['PAGE_VIEW', 'PRODUCT_VIEW', 'PROPERTY_VIEW', 'ADD_TO_CART', 'CHECKOUT_STARTED', 'PURCHASE', 'FORM_SUBMITTED', 'BOOKING']);
    if (!safeTypes.has(type)) return;
    const site = await prismaUnscoped.site.findUnique({ where: { id: siteId }, select: { organizationId: true, status: true } });
    if (!site || site.status !== 'PUBLISHED') return;
    await prismaUnscoped.siteEvent.create({ data: { organizationId: site.organizationId, siteId, type, path: path.slice(0, 500), sessionHash: session ? createHash('sha256').update(session).digest('hex') : null, referrerHost: referrer?.slice(0, 255), metadata: metadata as object | undefined } });
  },
};
