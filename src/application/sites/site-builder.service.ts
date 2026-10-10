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
import { addOnsService } from '../billing/add-ons.service';
import { getAiProvider } from '../../infrastructure/ai';
import { extractJson } from '../ai/ai-provider';
import {
  DEFAULT_NAVIGATION, DEFAULT_SETTINGS, DEFAULT_THEME_V2, SITE_SCHEMA_VERSION,
  blankHomepage, normalizeSections, siteNavigationSchema, siteSectionSchema,
  siteSettingsSchema, siteThemeSchema,
} from './site-schema';

const orgId = () => {
  const value = requestContext.get()?.organizationId;
  if (!value) throw new ValidationError('No tenant in context');
  return value;
};

const userId = () => requestContext.get()?.userId ?? null;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
const SUBDOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const RESERVED = new Set(['www', 'app', 'api', 'admin', 'mail', 'sites', 'docs', 'blog', 'help', 'status']);
const DOMAIN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const CUSTOM_DOMAIN_TARGET = process.env.SITE_CUSTOM_DOMAIN_TARGET || 'sites.businesshub.ai';

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
  mode: z.enum(['BLANK', 'TEMPLATE', 'AI']),
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

async function aiDraft(name: string, prompt: string) {
  const provider = getAiProvider('website');
  if (!provider) throw new AppError('AI_PROVIDER_NOT_CONFIGURED', 503, 'AI website generation is not configured.');
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
        'Each section must contain id, type, variant, hidden, props, responsive and animation. Never emit HTML, scripts, CSS or invented business claims. Use data binding for products/properties rather than copying records.',
    },
    { role: 'user', content: JSON.stringify({ request: prompt, websiteName: name, business: organization }) },
  ], { maxTokens: 3000, temperature: .55, jsonMode: true, dataSources: ['user_provided', 'vhicasar_business'] });
  const parsed = extractJson<{ theme?: unknown; pages?: { title?: string; slug?: string; sections?: unknown }[] }>(raw);
  const theme = siteThemeSchema.safeParse(parsed?.theme);
  const pages = (parsed?.pages ?? []).slice(0, 10).map((page, index) => ({
    title: String(page.title || (index === 0 ? 'Home' : `Page ${index + 1}`)).slice(0, 120),
    slug: index === 0 ? '' : String(page.slug ?? `page-${index + 1}`).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 80),
    sections: normalizeSections(page.sections),
  })).filter((page) => page.sections.length);
  if (!pages.length) throw new AppError('AI_WEBSITE_INVALID', 502, 'The AI did not return a valid editable website. Please try again.');
  return { theme: theme.success ? theme.data : DEFAULT_THEME_V2, pages };
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
    return { sites, limit, used: sites.length };
  },

  get: loadSite,

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
    if (input.mode === 'AI') {
      if (!input.prompt) throw new ValidationError('Describe the website you want to create');
      const generated = await aiDraft(input.name, input.prompt);
      theme = generated.theme;
      pages = generated.pages;
    }
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
    const [config, addOns] = await Promise.all([domainConfigService.active(), addOnsService.list()]);
    const addOn = addOns.find((item) => item.id === 'website_subdomain');
    return { baseDomain: config?.baseDomain ?? null, provider: config?.provider ?? null, managedDomainsEnabled: Boolean(config), addOn: addOn ? { id: addOn.id, title: addOn.title, billingType: addOn.billingType, price: addOn.price, active: addOn.activePurchases.length > 0 } : null };
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
    const site = await prisma.site.update({ where: { id }, data: { customDomain: domain, domainVerificationToken: token, domainVerifiedAt: null } });
    return { site, dns: { cname: { host: domain, value: CUSTOM_DOMAIN_TARGET }, txt: { host: `_vhicasar.${domain}`, value: token } } };
  },

  async verifyDomain(id: string) {
    const site = await loadSite(id);
    if (!site.customDomain || !site.domainVerificationToken) throw new ValidationError('Connect a domain first');
    let cnameVerified = false; let txtVerified = false;
    try { cnameVerified = (await resolveCname(site.customDomain)).some((entry) => entry.replace(/\.$/, '').toLowerCase() === CUSTOM_DOMAIN_TARGET); } catch { /* DNS propagation. */ }
    try { txtVerified = (await resolveTxt(`_vhicasar.${site.customDomain}`)).flat().some((entry) => entry === site.domainVerificationToken); } catch { /* DNS propagation. */ }
    if (!cnameVerified || !txtVerified) return { verified: false, cnameVerified, txtVerified, reason: 'DNS records are not visible yet. Propagation can take up to 48 hours.' };
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
    const provider = getAiProvider('website');
    if (!provider) throw new AppError('AI_PROVIDER_NOT_CONFIGURED', 503, 'AI website editing is not configured.');
    await this.snapshot(siteId, 'Before AI edit');
    const raw = await provider.complete([
      {
        role: 'system',
        content: 'You edit a structured website page. Return JSON only as {"sections": [...]}. Preserve section ids for edited sections and create ids beginning with sec_ for new sections. Allowed types: hero, products, properties, collections, services, features, about, stats, testimonials, gallery, video, logoCloud, team, faq, pricing, contact, newsletter, map, blog, cta, footer, spacer. Never emit code, HTML, CSS or scripts. Preserve data bindings and never copy private business records into props.',
      },
      { role: 'user', content: JSON.stringify({ instruction: input.instruction, sections: page.blocks, theme: site.theme }) },
    ], { maxTokens: 3000, temperature: .35, jsonMode: true, dataSources: ['user_provided', 'vhicasar_business'] });
    const parsed = extractJson<{ sections?: unknown }>(raw);
    const sections = normalizeSections(parsed?.sections);
    if (!sections.length) throw new AppError('AI_WEBSITE_INVALID', 502, 'The AI edit did not return a valid website structure.');
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
    return loadSite(siteId);
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
    return loadSite(id);
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
      const purchase = await prismaUnscoped.addOnPurchase.findFirst({
        where: { organizationId: site.organizationId, addOnId: 'website_subdomain', OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        select: { id: true },
      });
      if (!purchase) throw new AppError('SUBDOMAIN_ADD_ON_REQUIRED', 402, 'Activate the Website Subdomain add-on before publishing.');
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
    return loadSite(id);
  },

  async unpublish(id: string) {
    await loadSite(id);
    return prisma.site.update({ where: { id }, data: { status: 'UNPUBLISHED', unpublishedAt: new Date() }, include: { pages: { orderBy: { position: 'asc' } } } });
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
