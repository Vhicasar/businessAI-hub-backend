import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { prisma, prismaUnscoped } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors';
import { getAiProvider } from '../../infrastructure/ai';
import { extractJson } from '../ai/ai-provider';

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

const DEFAULT_THEME = { primaryColor: '#F97316', accentColor: '#0f172a', font: 'Inter, system-ui, sans-serif' };

export const updateSiteSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  theme: z.object({ primaryColor: z.string(), accentColor: z.string(), font: z.string(), customCss: z.string().max(20000) }).partial().optional(),
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
    if (!SUBDOMAIN_RE.test(s) || s.length < 3 || RESERVED.has(s)) return { available: false, reason: 'Invalid or reserved' };
    const taken = await prismaUnscoped.site.findFirst({ where: { subdomain: s, organizationId: { not: currentOrgId() } } });
    return { available: !taken, reason: taken ? 'Already taken' : null };
  },

  async publish(subdomain: string) {
    const check = await this.subdomainAvailable(subdomain);
    if (!check.available) throw new ConflictError(check.reason ?? 'Subdomain unavailable');
    const site = await this.ensureSite();
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
    const provider = getAiProvider();
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
    return renderPage(site, page, site.pages, { products });
  },
};

// ────────────────────────────────────────────────────────────────────────────
const esc = (v: unknown) =>
  String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

interface RenderCtx {
  products: { id: string; name: string; description: string | null; variants: { price: unknown; currency: string }[] }[];
}

function renderBlock(block: Block, subdomain: string, ctx: RenderCtx): string {
  const p = block.props ?? {};
  switch (block.type) {
    case 'hero':
      return `<section class="hero"><div class="container">
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
): string {
  const theme = { ...DEFAULT_THEME, ...(site.theme as object) } as { primaryColor: string; accentColor: string; font: string; customCss?: string };
  const seo = { ...((site.seo as object) ?? {}), ...((page.seo as object) ?? {}) } as { title?: string; description?: string };
  const blocks = Array.isArray(page.blocks) ? (page.blocks as Block[]) : [];
  const sub = site.subdomain ?? '';
  const nav = allPages
    .map((pg) => `<a href="/site/${esc(sub)}${pg.slug ? `/${esc(pg.slug)}` : ''}">${esc(pg.title)}</a>`)
    .join('');

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(seo.title || page.title || site.name)}</title>
${seo.description ? `<meta name="description" content="${esc(seo.description)}" />` : ''}
<style>
  :root{--primary:${esc(theme.primaryColor)};--accent:${esc(theme.accentColor)}}
  *{box-sizing:border-box}body{margin:0;font-family:${theme.font.replace(/["<>]/g, '')};color:#1f2430;line-height:1.6}
  .container{max-width:1080px;margin:0 auto;padding:0 24px}.narrow{max-width:640px}
  header.site{position:sticky;top:0;background:#fff;border-bottom:1px solid #eee;z-index:10}
  header.site .bar{display:flex;align-items:center;justify-content:space-between;padding:16px 24px;max-width:1080px;margin:0 auto}
  header.site .brand{font-weight:800;font-size:18px}header.site nav a{margin-left:18px;color:#374151;text-decoration:none;font-size:14px}
  .hero{background:linear-gradient(135deg,var(--primary),var(--accent));color:#fff;padding:96px 0;text-align:center}
  .hero h1{font-size:46px;margin:0 0 12px;font-weight:800}.hero .lead{font-size:20px;opacity:.95;max-width:640px;margin:0 auto 24px}
  .btn{display:inline-block;background:#fff;color:var(--primary);padding:12px 22px;border-radius:999px;font-weight:700;text-decoration:none;border:none;cursor:pointer;font-size:15px}
  .section{padding:64px 0}.section h2,.cta h2{font-size:30px;font-weight:800;margin:0 0 24px;text-align:center}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:20px}
  .card{border:1px solid #eee;border-radius:14px;padding:22px}.card h3{margin:0 0 8px}
  .cta{background:var(--accent);color:#fff;padding:72px 0;text-align:center}.cta .btn{background:var(--primary);color:#fff}
  .prose p{font-size:17px;color:#374151}.muted{color:#6b7280;text-align:center}
  .form{display:flex;flex-direction:column;gap:12px}.form input,.form textarea{padding:12px;border:1px solid #ddd;border-radius:10px;font:inherit}
  .form .btn{background:var(--primary);color:#fff;align-self:flex-start}
  footer.site{border-top:1px solid #eee;padding:32px 0;text-align:center;color:#6b7280;font-size:14px}
</style>${theme.customCss ? `<style>${String(theme.customCss).replace(/<\/style>/gi, '')}</style>` : ''}</head><body>
<header class="site"><div class="bar"><span class="brand">${esc(site.name)}</span><nav>${nav}</nav></div></header>
<main>${blocks.map((b) => renderBlock(b, sub, ctx)).join('')}</main>
<footer class="site"><div class="container">© ${new Date().getFullYear()} ${esc(site.name)} · Built with BusinessHub AI</div></footer>
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
