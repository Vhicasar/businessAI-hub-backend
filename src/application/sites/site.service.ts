import { randomUUID } from 'node:crypto';
import { resolveCname, resolveTxt } from 'node:dns/promises';
import { z } from 'zod';
import { prisma, prismaUnscoped } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../../shared/errors';
import { getAiProvider } from '../../infrastructure/ai';
import { extractJson } from '../ai/ai-provider';
import { domainConfigService } from './domain-config.service';
import { addOnsService } from '../billing/add-ons.service';
import { resolveEntitlements } from '../billing/entitlements';

/**
 * No-code website builder. One Site per organization; each Site has block-based
 * pages, a theme, and optional subdomain hosting. Blocks are an ordered array
 * of { id, type, props } rendered to server-side HTML by renderHtml().
 */

const currentOrgId = (): string => {
  const id = requestContext.get()?.organizationId;
  if (!id) throw new ValidationError('No tenant in context');
  return id;
};

const SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const RESERVED = new Set(['www', 'app', 'api', 'admin', 'mail', 'sites', 'docs', 'blog', 'help', 'status']);
const DOMAIN_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const CUSTOM_DOMAIN_TARGET = process.env.SITE_CUSTOM_DOMAIN_TARGET || 'sites.businesshub.ai';

const DEFAULT_THEME = {
  primaryColor: '#F97316', accentColor: '#0f172a', font: 'Inter, system-ui, sans-serif',
  backgroundColor: '#ffffff', surfaceColor: '#ffffff', radius: 18, buttonStyle: 'rounded',
};

async function websiteRuntime(organizationId: string) {
  const [webChat, entitlements] = await Promise.all([
    prismaUnscoped.channelAccount.findFirst({
      where: { organizationId, channelType: 'WEB_CHAT', isActive: true, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    }),
    resolveEntitlements(organizationId),
  ]);
  return {
    webChatAccountId: webChat?.id,
    whiteLabel: entitlements.features.has('white_label'),
  };
}

export const updateSiteSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  theme: z.object({
    primaryColor: z.string(), accentColor: z.string(), font: z.string(),
    backgroundColor: z.string(), surfaceColor: z.string(),
    radius: z.number().min(0).max(40), buttonStyle: z.enum(['rounded', 'pill', 'square']),
    logoUrl: z.string().max(2000), footerText: z.string().max(160),
    customCss: z.string().max(20000),
  }).partial().optional(),
  seo: z.object({ title: z.string().max(160), description: z.string().max(320) }).partial().optional(),
});
export const pageSchema = z.object({
  title: z.string().trim().min(1).max(120),
  slug: z.string().trim().max(60).regex(/^[a-z0-9-]*$/, 'lowercase letters, numbers and hyphens only'),
  blocks: z.array(z.record(z.unknown())).optional(),
  seo: z.object({ title: z.string().max(160), description: z.string().max(320) }).partial().optional(),
});
export const publishSchema = z.object({ subdomain: z.string().trim().toLowerCase().min(3).max(32) });

type Block = { id: string; type: string; props: Record<string, unknown> };

function starterBlocks(name: string): Block[] {
  return [
    { id: randomUUID(), type: 'hero', props: { heading: name, subheading: 'Welcome — we’re glad you’re here.', buttonText: 'Get in touch', buttonUrl: '#contact' } },
    { id: randomUUID(), type: 'features', props: { title: 'What we offer', items: [
      { title: 'Quality', text: 'Products and service you can rely on.' },
      { title: 'Fast', text: 'Quick delivery and quick replies.' },
      { title: 'Trusted', text: 'Loved by customers like you.' },
    ] } },
    { id: randomUUID(), type: 'contactForm', props: { title: 'Get in touch', buttonText: 'Send' } },
  ];
}

export const siteService = {
  /** The org's site, creating it (with a home page) on first use. */
  async ensureSite() {
    const orgId = currentOrgId();
    const existing = await prisma.site.findFirst({ include: { pages: { orderBy: { position: 'asc' } } } });
    if (existing) return existing;
    const org = await prismaUnscoped.organization.findUnique({ where: { id: orgId }, select: { name: true } });
    const name = org?.name ?? 'My Website';
    return prisma.site.create({
      data: {
        organizationId: orgId,
        name,
        theme: DEFAULT_THEME,
        seo: { title: name, description: `${name} — official website.` },
        pages: { create: [{ organizationId: orgId, title: 'Home', slug: '', position: 0, blocks: starterBlocks(name) as object }] },
      },
      include: { pages: { orderBy: { position: 'asc' } } },
    });
  },

  async updateSite(dto: z.infer<typeof updateSiteSchema>) {
    const site = await this.ensureSite();
    return prisma.site.update({
      where: { id: site.id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.theme !== undefined ? { theme: { ...(site.theme as object), ...dto.theme } } : {}),
        ...(dto.seo !== undefined ? { seo: { ...((site.seo as object) ?? {}), ...dto.seo } } : {}),
      },
      include: { pages: { orderBy: { position: 'asc' } } },
    });
  },

  async subdomainAvailable(subdomain: string) {
    const s = subdomain.toLowerCase();
    const config = await domainConfigService.active();
    if (!config) return { available: false, reason: 'Subdomain deployment is not configured by the platform administrator', domain: null };
    if (!SUBDOMAIN_RE.test(s) || s.length < 3 || RESERVED.has(s)) return { available: false, reason: 'Invalid or reserved', domain: config.baseDomain };
    const taken = await prismaUnscoped.site.findFirst({ where: { subdomain: s, organizationId: { not: currentOrgId() } } });
    return { available: !taken, reason: taken ? 'Already taken' : null, domain: config.baseDomain, url: `https://${s}.${config.baseDomain}` };
  },

  async subdomainDeploymentInfo() {
    const [config, addOns] = await Promise.all([domainConfigService.active(), addOnsService.list()]);
    const addOn = addOns.find((item) => item.id === 'website_subdomain');
    return {
      enabled: Boolean(config && addOn),
      baseDomain: config?.baseDomain ?? null,
      provider: config?.provider ?? null,
      addOn: addOn ? { id: addOn.id, title: addOn.title, billingType: addOn.billingType, price: addOn.price, active: addOn.activePurchases.length > 0 } : null,
    };
  },

  async publish(subdomain: string) {
    const check = await this.subdomainAvailable(subdomain);
    if (!check.available) throw new ConflictError(check.reason ?? 'Subdomain unavailable');
    const site = await this.ensureSite();
    const alreadyDeployed = site.status === 'PUBLISHED' && site.subdomain === subdomain.toLowerCase();
    if (!alreadyDeployed) {
      const purchase = await prismaUnscoped.addOnPurchase.findFirst({
        where: {
          organizationId: site.organizationId,
          addOnId: 'website_subdomain',
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
      });
      if (!purchase) throw new AppError('SUBDOMAIN_ADD_ON_REQUIRED', 402, 'Purchase the Website Subdomain add-on before deployment.');
    }
    const pages = await prisma.sitePage.count({ where: { siteId: site.id } });
    if (pages === 0) throw new ValidationError('Add a page before publishing');
    const updated = await prisma.site.update({
      where: { id: site.id },
      data: { status: 'PUBLISHED', subdomain: subdomain.toLowerCase(), publishedAt: new Date() },
      include: { pages: { orderBy: { position: 'asc' } } },
    });
    // Every publish is a restorable point in the version history.
    await this.snapshotVersion(`Published: ${subdomain}`).catch(() => undefined);
    return updated;
  },

  async unpublish() {
    const site = await this.ensureSite();
    return prisma.site.update({ where: { id: site.id }, data: { status: 'DRAFT' }, include: { pages: { orderBy: { position: 'asc' } } } });
  },

  async connectDomain(rawDomain: string) {
    const domain = rawDomain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!DOMAIN_RE.test(domain)) throw new ValidationError('Enter a valid domain such as www.example.com');
    const site = await this.ensureSite();
    const taken = await prismaUnscoped.site.findFirst({ where: { customDomain: domain, id: { not: site.id } }, select: { id: true } });
    if (taken) throw new ConflictError('This domain is already connected to another site');
    const token = `bh_${randomUUID().replace(/-/g, '')}`;
    const updated = await prisma.site.update({
      where: { id: site.id },
      data: { customDomain: domain, domainVerificationToken: token, domainVerifiedAt: null },
      include: { pages: { orderBy: { position: 'asc' } } },
    });
    return {
      site: updated,
      dns: {
        cname: { host: domain, value: CUSTOM_DOMAIN_TARGET },
        txt: { host: `_businesshub.${domain}`, value: token },
      },
    };
  },

  async verifyDomain() {
    const site = await this.ensureSite();
    if (!site.customDomain || !site.domainVerificationToken) throw new ValidationError('Connect a domain first');
    let cnameVerified = false;
    let txtVerified = false;
    try {
      const records = await resolveCname(site.customDomain);
      cnameVerified = records.some((record) => record.replace(/\.$/, '').toLowerCase() === CUSTOM_DOMAIN_TARGET);
    } catch { /* DNS may not have propagated yet. */ }
    try {
      const records = await resolveTxt(`_businesshub.${site.customDomain}`);
      txtVerified = records.flat().some((record) => record === site.domainVerificationToken);
    } catch { /* DNS may not have propagated yet. */ }
    if (!cnameVerified || !txtVerified) {
      return { verified: false, cnameVerified, txtVerified, reason: 'DNS records are not visible yet. Propagation can take up to 48 hours.' };
    }
    await prisma.site.update({ where: { id: site.id }, data: { domainVerifiedAt: new Date() } });
    return { verified: true, cnameVerified: true, txtVerified: true };
  },

  async disconnectDomain() {
    const site = await this.ensureSite();
    return prisma.site.update({
      where: { id: site.id },
      data: { customDomain: null, domainVerificationToken: null, domainVerifiedAt: null },
      include: { pages: { orderBy: { position: 'asc' } } },
    });
  },

  // ── Version history ────────────────────────────────────────────────────────
  async snapshotVersion(label: string) {
    const site = await prisma.site.findFirst({ include: { pages: { orderBy: { position: 'asc' } } } });
    if (!site) throw new NotFoundError('Site');
    const snapshot = {
      site: { name: site.name, theme: site.theme, seo: site.seo },
      pages: site.pages.map((p) => ({ title: p.title, slug: p.slug, blocks: p.blocks, seo: p.seo, position: p.position })),
    };
    return prisma.siteVersion.create({
      data: { organizationId: site.organizationId, siteId: site.id, label: label.slice(0, 80), snapshot: snapshot as object },
      select: { id: true, label: true, createdAt: true },
    });
  },

  async listVersions() {
    const site = await this.ensureSite();
    return prisma.siteVersion.findMany({
      where: { siteId: site.id }, orderBy: { createdAt: 'desc' }, take: 30,
      select: { id: true, label: true, createdAt: true },
    });
  },

  async restoreVersion(id: string) {
    const site = await this.ensureSite();
    const version = await prisma.siteVersion.findFirst({ where: { id, siteId: site.id } });
    if (!version) throw new NotFoundError('Version');
    const snap = version.snapshot as {
      site: { name: string; theme: unknown; seo: unknown };
      pages: { title: string; slug: string; blocks: unknown; seo: unknown; position: number }[];
    };
    // Snapshot current state first so restoring is itself undoable.
    await this.snapshotVersion('Before restore').catch(() => undefined);
    await prisma.$transaction([
      prisma.site.update({ where: { id: site.id }, data: { name: snap.site.name, theme: snap.site.theme as object, seo: snap.site.seo as object } }),
      prisma.sitePage.deleteMany({ where: { siteId: site.id } }),
      ...snap.pages.map((p) =>
        prisma.sitePage.create({
          data: { organizationId: site.organizationId, siteId: site.id, title: p.title, slug: p.slug, blocks: (p.blocks ?? []) as object, seo: (p.seo ?? undefined) as object, position: p.position },
        }),
      ),
    ]);
    return prisma.site.findFirst({ include: { pages: { orderBy: { position: 'asc' } } } });
  },

  // ── Pages ────────────────────────────────────────────────────────────────
  async createPage(dto: z.infer<typeof pageSchema>) {
    const site = await this.ensureSite();
    const dup = await prisma.sitePage.findFirst({ where: { siteId: site.id, slug: dto.slug } });
    if (dup) throw new ConflictError(`A page with slug "${dto.slug || '/'}" already exists`);
    const max = await prisma.sitePage.aggregate({ where: { siteId: site.id }, _max: { position: true } });
    return prisma.sitePage.create({
      data: {
        organizationId: site.organizationId, siteId: site.id, title: dto.title, slug: dto.slug,
        blocks: (dto.blocks ?? []) as object, seo: (dto.seo ?? undefined) as object, position: (max._max.position ?? 0) + 1,
      },
    });
  },

  async updatePage(id: string, dto: Partial<z.infer<typeof pageSchema>>) {
    const page = await prisma.sitePage.findFirst({ where: { id } });
    if (!page) throw new NotFoundError('Page');
    return prisma.sitePage.update({
      where: { id },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.slug !== undefined ? { slug: dto.slug } : {}),
        ...(dto.blocks !== undefined ? { blocks: dto.blocks as object } : {}),
        ...(dto.seo !== undefined ? { seo: dto.seo as object } : {}),
      },
    });
  },

  async deletePage(id: string) {
    const page = await prisma.sitePage.findFirst({ where: { id } });
    if (!page) throw new NotFoundError('Page');
    if (page.slug === '') throw new ValidationError('The home page cannot be deleted');
    await prisma.sitePage.delete({ where: { id } });
    return { deleted: true };
  },

  /** Generate homepage blocks from a business description using the AI engine. */
  async aiGenerate(prompt: string) {
    const site = await this.ensureSite();
    const provider = getAiProvider('website');
    const home = site.pages.find((p) => p.slug === '') ?? site.pages[0];
    if (!provider || !home) return { generated: false };

    const raw = await provider.complete(
      [
        {
          role: 'system',
          content:
            'You generate website homepage content as JSON. Return ONLY: {"blocks":[...]} where each block is ' +
            'one of: {"type":"hero","props":{"heading","subheading","buttonText","buttonUrl":"#contact"}}, ' +
            '{"type":"features","props":{"title","items":[{"title","text"}]}}, ' +
            '{"type":"richtext","props":{"title","body"}}, ' +
            '{"type":"cta","props":{"heading","buttonText","buttonUrl":"#contact"}}, ' +
            '{"type":"contactForm","props":{"title","buttonText":"Send"}}. ' +
            'Write warm, specific marketing copy for THIS business. 4-6 blocks, ending with a contactForm.',
        },
        { role: 'user', content: prompt },
      ],
      { maxTokens: 900, temperature: 0.6, jsonMode: true },
    );
    const parsed = extractJson<{ blocks?: { type?: string; props?: Record<string, unknown> }[] }>(raw);
    const allowed = new Set(['hero', 'features', 'richtext', 'cta', 'contactForm', 'image']);
    const blocks: Block[] = (parsed?.blocks ?? [])
      .filter((b) => b.type && allowed.has(b.type))
      .map((b) => ({ id: randomUUID(), type: b.type as string, props: b.props ?? {} }));
    if (blocks.length === 0) return { generated: false };
    await prisma.sitePage.update({ where: { id: home.id }, data: { blocks: blocks as object } });
    return { generated: true, count: blocks.length };
  },

  // ── Public rendering (hosted site) ────────────────────────────────────────
  async renderHtml(subdomain: string, slug: string): Promise<string | null> {
    const site = await prismaUnscoped.site.findFirst({
      where: { subdomain: subdomain.toLowerCase(), status: 'PUBLISHED' },
      include: { pages: { orderBy: { position: 'asc' } } },
    });
    if (!site) return null;
    const page = site.pages.find((p) => p.slug === slug) ?? (slug === '' ? site.pages.find((p) => p.slug === '') : null);
    if (!page) return null;
    // Ecommerce block support: active products with a default variant + price.
    const products = await prismaUnscoped.product.findMany({
      where: { organizationId: site.organizationId, deletedAt: null, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
      take: 24,
      select: {
        id: true, name: true, description: true,
        variants: { where: { deletedAt: null, isActive: true }, orderBy: { isDefault: 'desc' }, take: 1, select: { price: true, currency: true } },
      },
    });
    return renderPage(site, page, site.pages, { products, ...(await websiteRuntime(site.organizationId)) });
  },

  async renderHtmlByDomain(domain: string, slug: string): Promise<string | null> {
    const site = await prismaUnscoped.site.findFirst({
      where: { customDomain: domain.toLowerCase(), domainVerifiedAt: { not: null }, status: 'PUBLISHED' },
      include: { pages: { orderBy: { position: 'asc' } } },
    });
    if (!site) return null;
    const page = site.pages.find((p) => p.slug === slug) ?? (slug === '' ? site.pages.find((p) => p.slug === '') : null);
    if (!page) return null;
    const products = await prismaUnscoped.product.findMany({
      where: { organizationId: site.organizationId, deletedAt: null, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' }, take: 24,
      select: {
        id: true, name: true, description: true,
        variants: { where: { deletedAt: null, isActive: true }, orderBy: { isDefault: 'desc' }, take: 1, select: { price: true, currency: true } },
      },
    });
    return renderPage(site, page, site.pages, { products, ...(await websiteRuntime(site.organizationId)) }, false, true);
  },

  async renderHtmlByManagedHost(hostname: string, slug: string): Promise<string | null> {
    const config = await domainConfigService.active();
    if (!config) return null;
    const suffix = `.${config.baseDomain}`;
    if (!hostname.toLowerCase().endsWith(suffix)) return null;
    const subdomain = hostname.toLowerCase().slice(0, -suffix.length);
    if (!SUBDOMAIN_RE.test(subdomain)) return null;
    const site = await prismaUnscoped.site.findFirst({
      where: { subdomain, status: 'PUBLISHED' },
      include: { pages: { orderBy: { position: 'asc' } } },
    });
    if (!site) return null;
    const page = site.pages.find((p) => p.slug === slug) ?? (slug === '' ? site.pages.find((p) => p.slug === '') : null);
    if (!page) return null;
    const products = await prismaUnscoped.product.findMany({
      where: { organizationId: site.organizationId, deletedAt: null, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' }, take: 24,
      select: {
        id: true, name: true, description: true,
        variants: { where: { deletedAt: null, isActive: true }, orderBy: { isDefault: 'desc' }, take: 1, select: { price: true, currency: true } },
      },
    });
    return renderPage(site, page, site.pages, { products, ...(await websiteRuntime(site.organizationId)) }, false, true);
  },

  /** Authenticated full HTML preview of the current draft, including links and interactive sections. */
  async renderPreviewHtml(slug: string): Promise<string> {
    const site = await this.ensureSite();
    const page = site.pages.find((p) => p.slug === slug) ?? site.pages.find((p) => p.slug === '') ?? site.pages[0];
    if (!page) throw new NotFoundError('Page');
    const products = await prismaUnscoped.product.findMany({
      where: { organizationId: site.organizationId, deletedAt: null, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' }, take: 24,
      select: {
        id: true, name: true, description: true,
        variants: { where: { deletedAt: null, isActive: true }, orderBy: { isDefault: 'desc' }, take: 1, select: { price: true, currency: true } },
      },
    });
    return renderPage(site, page, site.pages, { products, ...(await websiteRuntime(site.organizationId)) }, true);
  },
};

// ────────────────────────────────────────────────────────────────────────────
const esc = (v: unknown) =>
  String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

interface RenderCtx {
  products: { id: string; name: string; description: string | null; variants: { price: unknown; currency: string }[] }[];
  logoUrl?: string;
  webChatAccountId?: string;
  whiteLabel?: boolean;
}

function renderBlock(block: Block, subdomain: string, ctx: RenderCtx): string {
  const p = block.props ?? {};
  switch (block.type) {
    case 'hero':
      return `<section class="hero"><div class="container">
        ${ctx.logoUrl ? `<img class="hero-logo" src="${esc(ctx.logoUrl)}" alt="" />` : ''}
        <h1>${esc(p.heading)}</h1>${p.subheading ? `<p class="lead">${esc(p.subheading)}</p>` : ''}
        ${p.buttonText ? `<a class="btn" href="${esc(p.buttonUrl) || '#'}">${esc(p.buttonText)}</a>` : ''}
      </div></section>`;
    case 'features': {
      const items = Array.isArray(p.items) ? (p.items as { title?: string; text?: string }[]) : [];
      return `<section class="section"><div class="container">
        ${p.title ? `<h2>${esc(p.title)}</h2>` : ''}
        <div class="grid">${items.map((it) => `<div class="card"><h3>${esc(it.title)}</h3><p>${esc(it.text)}</p></div>`).join('')}</div>
      </div></section>`;
    }
    case 'promotionSlider': {
      const items = Array.isArray(p.items) ? (p.items as { eyebrow?: string; heading?: string; text?: string; buttonText?: string; buttonUrl?: string; imageUrl?: string }[]) : [];
      return `<section class="section promotions"><div class="container">
        ${p.title ? `<h2>${esc(p.title)}</h2>` : ''}
        <div class="promo-track">${items.map((it, index) => `<article class="promo${index === 0 ? ' active' : ''}"${it.imageUrl ? ` style="background-image:linear-gradient(90deg,rgba(15,23,42,.94),rgba(15,23,42,.5)),url('${esc(it.imageUrl)}')"` : ''}>
          <small>${esc(it.eyebrow)}</small><h3>${esc(it.heading)}</h3><p>${esc(it.text)}</p>${it.buttonText ? `<a class="btn" href="${esc(it.buttonUrl) || '#'}">${esc(it.buttonText)}</a>` : ''}
        </article>`).join('')}</div>
        ${items.length > 1 ? `<div class="promo-dots">${items.map((_, i) => `<button type="button" aria-label="Show promotion ${i + 1}" data-slide="${i}" class="${i === 0 ? 'active' : ''}"></button>`).join('')}</div>` : ''}
      </div></section>`;
    }
    case 'customGrid': {
      const items = Array.isArray(p.items) ? (p.items as { title?: string; text?: string; imageUrl?: string; buttonText?: string; buttonUrl?: string }[]) : [];
      const columns = Math.min(Math.max(Number(p.columns) || 3, 1), 4);
      return `<section class="section"><div class="container">
        ${p.title ? `<h2>${esc(p.title)}</h2>` : ''}
        <div class="custom-grid" style="--columns:${columns}">${items.map((it) => `<article class="grid-card">${it.imageUrl ? `<img src="${esc(it.imageUrl)}" alt="" loading="lazy" />` : ''}<div><h3>${esc(it.title)}</h3><p>${esc(it.text)}</p>${it.buttonText ? `<a href="${esc(it.buttonUrl) || '#'}">${esc(it.buttonText)} →</a>` : ''}</div></article>`).join('')}</div>
      </div></section>`;
    }
    case 'stats': {
      const items = Array.isArray(p.items) ? (p.items as { value?: string; label?: string }[]) : [];
      return `<section class="section stats"><div class="container">
        ${p.title ? `<h2>${esc(p.title)}</h2>` : ''}
        <div class="stats-grid">${items.map((it) => `<div><strong>${esc(it.value)}</strong><span>${esc(it.label)}</span></div>`).join('')}</div>
      </div></section>`;
    }
    case 'testimonials': {
      const items = Array.isArray(p.items) ? (p.items as { quote?: string; name?: string; role?: string }[]) : [];
      return `<section class="section"><div class="container">
        ${p.title ? `<h2>${esc(p.title)}</h2>` : ''}
        <div class="grid">${items.map((it) => `<figure class="card quote"><blockquote>“${esc(it.quote)}”</blockquote><figcaption><strong>${esc(it.name)}</strong><span>${esc(it.role)}</span></figcaption></figure>`).join('')}</div>
      </div></section>`;
    }
    case 'faq': {
      const items = Array.isArray(p.items) ? (p.items as { question?: string; answer?: string }[]) : [];
      return `<section class="section"><div class="container narrow">
        ${p.title ? `<h2>${esc(p.title)}</h2>` : ''}
        <div class="faq">${items.map((it) => `<details><summary>${esc(it.question)}</summary><p>${esc(it.answer)}</p></details>`).join('')}</div>
      </div></section>`;
    }
    case 'gallery': {
      const items = Array.isArray(p.items) ? (p.items as { url?: string; alt?: string }[]) : [];
      return `<section class="section"><div class="container">
        ${p.title ? `<h2>${esc(p.title)}</h2>` : ''}
        <div class="gallery">${items.filter((it) => it.url).map((it) => `<img src="${esc(it.url)}" alt="${esc(it.alt)}" loading="lazy" />`).join('')}</div>
      </div></section>`;
    }
    case 'richtext':
      return `<section class="section"><div class="container prose">
        ${p.title ? `<h2>${esc(p.title)}</h2>` : ''}
        ${String(p.body ?? '').split(/\n\n+/).map((para) => `<p>${esc(para)}</p>`).join('')}
      </div></section>`;
    case 'cta':
      return `<section class="cta"><div class="container">
        <h2>${esc(p.heading)}</h2>${p.buttonText ? `<a class="btn" href="${esc(p.buttonUrl) || '#'}">${esc(p.buttonText)}</a>` : ''}
      </div></section>`;
    case 'image':
      return `<section class="section"><div class="container">
        ${p.url ? `<img src="${esc(p.url)}" alt="${esc(p.alt)}" style="max-width:100%;border-radius:12px" />` : ''}
        ${p.caption ? `<p class="muted">${esc(p.caption)}</p>` : ''}
      </div></section>`;
    case 'contactForm':
      return `<section class="section" id="contact"><div class="container narrow">
        ${p.title ? `<h2>${esc(p.title)}</h2>` : ''}
        <form class="form" method="POST" action="/site/${esc(subdomain)}/submit">
          <input name="name" placeholder="Your name" required />
          <input name="email" type="email" placeholder="Email" required />
          <textarea name="message" placeholder="Message" rows="4"></textarea>
          <button class="btn" type="submit">${esc(p.buttonText) || 'Send'}</button>
        </form>
      </div></section>`;
    case 'products': {
      const items = ctx.products ?? [];
      const cards = items
        .map((pr) => {
          const v = pr.variants[0];
          const price = v ? `${esc(v.currency)} ${Number(v.price).toLocaleString()}` : '';
          return `<div class="card"><h3>${esc(pr.name)}</h3>${pr.description ? `<p>${esc(String(pr.description).slice(0, 110))}</p>` : ''}${price ? `<p><strong>${price}</strong></p>` : ''}</div>`;
        })
        .join('');
      return `<section class="section"><div class="container">
        ${p.title ? `<h2>${esc(p.title)}</h2>` : ''}
        <div class="grid">${cards || '<p class="muted">No products published yet.</p>'}</div>
      </div></section>`;
    }
    case 'customHtml':
      // Raw HTML authored by the site owner for their own site. Strip only a
      // closing </style>/<script> hijack of the surrounding document is not a
      // concern here (single-tenant, owner-authored), so render as-is.
      return `<section class="section"><div class="container">${String(p.html ?? '')}</div></section>`;
    default:
      return '';
  }
}

function renderPage(
  site: { name: string; subdomain: string | null; theme: unknown; seo: unknown },
  page: { title: string; slug: string; blocks: unknown; seo: unknown },
  allPages: { title: string; slug: string }[],
  ctx: RenderCtx,
  preview = false,
  customDomainMode = false,
): string {
  const theme = { ...DEFAULT_THEME, ...(site.theme as object) } as {
    primaryColor: string; accentColor: string; font: string; backgroundColor: string;
    surfaceColor: string; radius: number; buttonStyle: 'rounded' | 'pill' | 'square';
    logoUrl?: string; footerText?: string; customCss?: string;
  };
  const seo = { ...((site.seo as object) ?? {}), ...((page.seo as object) ?? {}) } as { title?: string; description?: string };
  const blocks = Array.isArray(page.blocks) ? (page.blocks as Block[]) : [];
  const sub = site.subdomain ?? '';
  const pageHref = (slug: string) => preview
    ? `/api/v1/sites/preview${slug ? `?slug=${encodeURIComponent(slug)}` : ''}`
    : customDomainMode ? `/${esc(slug)}` : `/site/${esc(sub)}${slug ? `/${esc(slug)}` : ''}`;
  const nav = allPages
    .map((pg) => `<a href="${pageHref(pg.slug)}">${esc(pg.title)}</a>`)
    .join('');

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(seo.title || page.title || site.name)}</title>
${seo.description ? `<meta name="description" content="${esc(seo.description)}" />` : ''}
<style>
  :root{--primary:${esc(theme.primaryColor)};--accent:${esc(theme.accentColor)};--background:${esc(theme.backgroundColor)};--surface:${esc(theme.surfaceColor)};--radius:${theme.radius}px;--button-radius:${theme.buttonStyle === 'pill' ? '999px' : theme.buttonStyle === 'square' ? '0px' : '12px'}}
  *{box-sizing:border-box}body{margin:0;font-family:${theme.font.replace(/["<>]/g, '')};color:#1f2430;line-height:1.6;background:var(--background)}
  .container{max-width:1080px;margin:0 auto;padding:0 24px}.narrow{max-width:640px}
  header.site{position:sticky;top:0;background:#fff;border-bottom:1px solid #eee;z-index:10}
  header.site .bar{display:flex;align-items:center;justify-content:space-between;padding:16px 24px;max-width:1080px;margin:0 auto}
  header.site .brand{font-weight:800;font-size:18px}header.site nav a{margin-left:18px;color:#374151;text-decoration:none;font-size:14px}
  .hero{background:radial-gradient(circle at 80% 10%,color-mix(in srgb,var(--primary) 45%,transparent),transparent 38%),linear-gradient(145deg,var(--accent),color-mix(in srgb,var(--accent) 88%,#fff));color:#fff;padding:112px 0;text-align:center}
  .hero h1{font-size:clamp(42px,6vw,68px);line-height:1.04;letter-spacing:-.045em;max-width:820px;margin:0 auto 18px;font-weight:900}.hero .lead{font-size:20px;opacity:.8;max-width:640px;margin:0 auto 28px}
  .btn{display:inline-block;background:#fff;color:var(--primary);padding:13px 24px;border-radius:var(--button-radius);font-weight:800;text-decoration:none;border:none;cursor:pointer;font-size:15px}
  .section{padding:64px 0}.section h2,.cta h2{font-size:30px;font-weight:800;margin:0 0 24px;text-align:center}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:20px}
  .card{border:1px solid #e8e8ec;border-radius:var(--radius);padding:24px;background:var(--surface);box-shadow:0 10px 35px rgba(15,23,42,.055)}.card h3{margin:0 0 8px}
  .brand{display:flex;align-items:center;gap:10px}.brand img{width:38px;height:38px;border-radius:10px;object-fit:contain}.hero-logo{width:72px;height:72px;object-fit:contain;border-radius:16px;margin:0 auto 22px}
  .promo-track{position:relative;min-height:330px}.promo{display:none;min-height:330px;padding:54px;border-radius:var(--radius);background:linear-gradient(135deg,var(--accent),var(--primary));background-size:cover;background-position:center;color:#fff}.promo.active{display:flex;flex-direction:column;justify-content:center}.promo small{font-weight:800;letter-spacing:.12em;opacity:.7}.promo h3{font-size:38px;line-height:1.08;margin:10px 0}.promo p{max-width:540px;opacity:.8}.promo .btn{align-self:flex-start;margin-top:12px}.promo-dots{display:flex;justify-content:center;gap:7px;margin-top:16px}.promo-dots button{width:8px;height:8px;padding:0;border:0;border-radius:9px;background:#cbd5e1;cursor:pointer}.promo-dots button.active{width:26px;background:var(--primary)}.custom-grid{display:grid;grid-template-columns:repeat(var(--columns),1fr);gap:18px}.grid-card{overflow:hidden;border:1px solid #e8e8ec;border-radius:var(--radius);background:var(--surface)}.grid-card img{display:block;width:100%;aspect-ratio:1.4;object-fit:cover}.grid-card>div{padding:22px}.grid-card h3{margin:0 0 7px}.grid-card p{color:#6b7280}.grid-card a{color:var(--primary);font-weight:800;text-decoration:none}
  .stats{background:color-mix(in srgb,var(--primary) 6%,var(--background))}.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:24px;text-align:center}.stats-grid strong{display:block;color:var(--primary);font-size:38px;line-height:1.1}.stats-grid span,.quote figcaption span{display:block;color:#6b7280;font-size:14px}.quote{margin:0}.quote blockquote{margin:0 0 18px;font-size:17px;font-style:italic}.faq{display:grid;gap:12px}.faq details{background:var(--surface);border:1px solid #e8e8ec;border-radius:min(var(--radius),14px);padding:18px}.faq summary{cursor:pointer;font-weight:800}.faq p{color:#6b7280;margin:12px 0 0}.gallery{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.gallery img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:var(--radius)}
  .cta{background:var(--accent);color:#fff;padding:72px 0;text-align:center}.cta .btn{background:var(--primary);color:#fff}
  .prose p{font-size:17px;color:#374151}.muted{color:#6b7280;text-align:center}
  .form{display:flex;flex-direction:column;gap:12px}.form input,.form textarea{padding:12px;border:1px solid #ddd;border-radius:10px;font:inherit}
  .form .btn{background:var(--primary);color:#fff;align-self:flex-start}
  footer.site{border-top:1px solid #eee;padding:38px 0;color:#6b7280;font-size:14px}footer.site .footer-bar{display:flex;justify-content:space-between;align-items:center;gap:20px}
  @media(max-width:760px){header.site nav{display:none}.hero{padding:76px 0}.section{padding:48px 0}.gallery{grid-template-columns:1fr 1fr}.stats-grid{grid-template-columns:1fr 1fr}.custom-grid{grid-template-columns:1fr 1fr}.promo{padding:30px}.promo h3{font-size:30px}}
</style>${theme.customCss ? `<style>${String(theme.customCss).replace(/<\/style>/gi, '')}</style>` : ''}</head><body>
<header class="site"><div class="bar"><span class="brand">${theme.logoUrl ? `<img src="${esc(theme.logoUrl)}" alt="" />` : ''}<span>${esc(site.name)}</span></span><nav>${nav}</nav></div></header>
<main>${blocks.map((b) => renderBlock(b, sub, { ...ctx, logoUrl: theme.logoUrl })).join('')}</main>
<footer class="site"><div class="container footer-bar"><span class="brand">${theme.logoUrl ? `<img src="${esc(theme.logoUrl)}" alt="" />` : ''}<span>${esc(theme.footerText || site.name)}</span></span><span>© ${new Date().getFullYear()}${ctx.whiteLabel ? '' : ' · Powered by Vhicasar Hub AI'}</span></div></footer>
<script>
document.querySelectorAll('.promo-dots button').forEach(function(button){button.addEventListener('click',function(){var root=button.closest('.container');var index=Number(button.dataset.slide);root.querySelectorAll('.promo').forEach(function(slide,i){slide.classList.toggle('active',i===index)});root.querySelectorAll('.promo-dots button').forEach(function(dot,i){dot.classList.toggle('active',i===index)})})});
${preview ? `document.querySelectorAll('form').forEach(function(form){form.addEventListener('submit',function(event){event.preventDefault();form.innerHTML='<div style="padding:28px;border-radius:12px;background:#ecfdf5;color:#065f46"><strong>Form works!</strong><p>This preview does not create a real CRM lead.</p></div>'})});` : ''}
</script>
${ctx.webChatAccountId ? `<script src="/widget.js" data-account="${esc(ctx.webChatAccountId)}"></script>` : ''}
</body></html>`;
}

/** Record a contact-form submission from a published site as a CRM lead. */
export async function recordSiteLead(subdomain: string, data: { name?: string; email?: string; message?: string }) {
  const site = await prismaUnscoped.site.findFirst({ where: { subdomain: subdomain.toLowerCase() }, select: { organizationId: true } });
  if (!site) return null;
  const [firstName, ...rest] = String(data.name ?? 'Website').trim().split(' ');
  return prismaUnscoped.lead.create({
    data: {
      organizationId: site.organizationId,
      firstName: firstName || 'Website',
      lastName: rest.join(' ') || null,
      email: data.email ?? null,
      source: 'WEBSITE',
      status: 'NEW',
      customFields: data.message ? { message: data.message } : undefined,
    },
  });
}
