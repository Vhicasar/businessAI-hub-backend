import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { DEFAULT_THEME_V2, normalizeSections, siteThemeSchema, type SiteSection, type SiteThemeV2 } from './site-schema';
import { domainConfigService } from './domain-config.service';
import { decrypt } from '../../shared/crypto';
import { filesService } from '../files/files.service';

type PublishedSnapshot = {
  schemaVersion: number;
  site: { id: string; name: string; theme: unknown; navigation: unknown; settings: unknown; seo: unknown };
  pages: Array<{ id: string; title: string; slug: string; sections: unknown; seo: unknown; isHome: boolean; showInNav: boolean; status: string }>;
};

const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);

function money(value: unknown, currency: unknown) {
  const amount = Number(value);
  try { return new Intl.NumberFormat('en', { style: 'currency', currency: String(currency || 'USD'), maximumFractionDigits: 2 }).format(amount); }
  catch { return `${esc(currency)} ${amount.toLocaleString()}`; }
}

function safeHref(value: unknown) {
  const href = String(value ?? '#').trim();
  return /^(https?:\/\/|mailto:|tel:|\/|#)/i.test(href) ? esc(href) : '#';
}

const CURATED_FONTS = new Set(['Inter', 'DM Sans', 'Manrope', 'Poppins', 'Montserrat', 'Lato', 'Playfair Display', 'Cormorant Garamond', 'Merriweather', 'Space Grotesk', 'Plus Jakarta Sans', 'Outfit', 'Libre Baskerville', 'Roboto Mono']);
function fontStylesheet(theme: SiteThemeV2) {
  const requested = new Map<string, Set<number>>();
  const add = (font: string, weight: number) => { if (!CURATED_FONTS.has(font)) return; const weights = requested.get(font) ?? new Set<number>(); weights.add(weight); requested.set(font, weights); };
  add(theme.typography.headingFont, theme.typography.headingWeight);
  add(theme.typography.bodyFont, theme.typography.bodyWeight);
  if (!requested.size) return '';
  const query = [...requested.entries()].map(([font, weights]) => `family=${encodeURIComponent(font).replace(/%20/g, '+')}:wght@${[...weights].sort().join(';')}`).join('&');
  return `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?${query}&display=swap" rel="stylesheet">`;
}
function normalizeTheme(value: unknown): SiteThemeV2 {
  const raw = (value ?? {}) as Record<string, any>;
  const candidate = {
    ...DEFAULT_THEME_V2,
    ...raw,
    colors: { ...DEFAULT_THEME_V2.colors, ...(raw.colors ?? {}) },
    darkColors: { ...DEFAULT_THEME_V2.darkColors, ...(raw.darkColors ?? {}) },
    typography: { ...DEFAULT_THEME_V2.typography, ...(raw.typography ?? {}) },
    layout: { ...DEFAULT_THEME_V2.layout, ...(raw.layout ?? {}) },
    buttons: { ...DEFAULT_THEME_V2.buttons, ...(raw.buttons ?? {}) },
  };
  return siteThemeSchema.parse(candidate);
}

async function dataContext(organizationId: string) {
  const [organization, businessProfile, products, properties, webChat] = await Promise.all([
    prismaUnscoped.organization.findUnique({ where: { id: organizationId }, select: { name: true, website: true, email: true, phone: true, addressLine1: true, addressLine2: true, city: true, state: true, postalCode: true, country: true, businessType: true, logoFileId: true } }),
    prismaUnscoped.businessProfile.findUnique({ where: { organizationId }, select: { tagline: true, description: true, openingHours: true, supportEmail: true, salesEmail: true, alternativePhone: true, whatsappNumber: true, socialLinks: true } }),
    prismaUnscoped.product.findMany({
      where: { organizationId, status: 'ACTIVE', sellable: true, manufacturingType: { not: 'RAW_MATERIAL' }, deletedAt: null }, orderBy: [{ isFeatured: 'desc' }, { createdAt: 'desc' }], take: 48,
      select: { id: true, name: true, slug: true, description: true, isFeatured: true, variants: { where: { isActive: true, deletedAt: null }, orderBy: { isDefault: 'desc' }, take: 1, select: { id: true, price: true, compareAtPrice: true, currency: true } }, images: { orderBy: { position: 'asc' }, take: 12, select: { file: { select: { id: true, key: true, isPublic: true } }, altText: true } } },
    }),
    prismaUnscoped.property.findMany({
      where: { organizationId, status: 'AVAILABLE', deletedAt: null }, orderBy: { createdAt: 'desc' }, take: 48,
      select: { id: true, reference: true, title: true, description: true, purpose: true, price: true, rentAmount: true, rentPeriod: true, currency: true, bedrooms: true, bathrooms: true, city: true, state: true, amenities: true, media: { where: { kind: 'IMAGE' }, orderBy: { position: 'asc' }, take: 20, select: { file: { select: { id: true, key: true, isPublic: true } }, caption: true } } },
    }),
    prismaUnscoped.channelAccount.findFirst({ where: { organizationId, channelType: 'WEB_CHAT', isActive: true, status: 'CONNECTED', deletedAt: null }, select: { id: true } }),
  ]);
  const [logoUrl, resolvedProducts, resolvedProperties] = await Promise.all([
    filesService.urlFor(organization?.logoFileId),
    Promise.all(products.map(async (product) => ({ ...product, imageUrl: await filesService.urlFor(product.images[0]?.file.id), imageUrls: await Promise.all(product.images.map((image) => filesService.urlFor(image.file.id))) }))),
    Promise.all(properties.map(async (property) => ({ ...property, imageUrl: await filesService.urlFor(property.media[0]?.file.id), imageUrls: await Promise.all(property.media.map((media) => filesService.urlFor(media.file.id))) }))),
  ]);
  return { organization: organization ? { ...organization, logoUrl, businessProfile } : null, products: resolvedProducts, properties: resolvedProperties, webChatAccountId: webChat?.id };
}

type RenderData = Awaited<ReturnType<typeof dataContext>> & { basePath: string; commerceEnabled: boolean; previewPath: string | null };

function renderCards(section: SiteSection, ctx: RenderData) {
  const limit = section.binding?.limit ?? 8;
  if (section.type === 'products') return ctx.products.slice(0, limit).map((product) => {
    const variant = product.variants[0];
    const image = product.imageUrl;
    return `<article class="product-card"><a href="${ctx.basePath}/products/${esc(product.slug)}" aria-label="View ${esc(product.name)}">${image ? `<img src="${esc(image)}" alt="${esc(product.images[0]?.altText || product.name)}" loading="lazy" />` : '<span class="image-placeholder"></span>'}<div class="card-copy"><h3>${esc(product.name)}</h3>${variant ? `<p class="price">${money(variant.price, variant.currency)}</p>` : ''}</div></a>${variant && ctx.commerceEnabled ? `<button class="cart-add" data-variant="${esc(variant.id)}" data-name="${esc(product.name)}">Add to cart</button>` : ''}</article>`;
  }).join('');
  if (section.type === 'properties') return ctx.properties.slice(0, limit).map((property) => {
    const image = property.imageUrl;
    const price = property.price ?? property.rentAmount;
    return `<article class="property-card"><a href="${ctx.basePath}/properties/${esc(property.reference)}">${image ? `<img src="${esc(image)}" alt="${esc(property.media[0]?.caption || property.title)}" loading="lazy" />` : '<span class="image-placeholder"></span>'}<div class="card-copy"><p class="eyebrow">${esc(property.city || property.state || property.purpose)}</p><h3>${esc(property.title)}</h3>${price ? `<p class="price">${money(price, property.currency)}${property.rentPeriod ? ` / ${esc(String(property.rentPeriod).toLowerCase())}` : ''}</p>` : ''}<p class="meta">${property.bedrooms ? `${property.bedrooms} beds` : ''}${property.bathrooms ? ` · ${property.bathrooms} baths` : ''}</p></div></a></article>`;
  }).join('');
  return '';
}

function renderSection(item: SiteSection, ctx: RenderData) {
  if (item.hidden) return '';
  const props = item.props as Record<string, any>;
  const animation = item.animation === 'none' ? '' : ` data-animate="${esc(item.animation)}"`;
  switch (item.type) {
    case 'hero': return `<section class="section hero hero-${esc(item.variant)}"${animation}><div class="container hero-inner"><p class="eyebrow">${esc(props.eyebrow)}</p><h1>${esc(props.heading)}</h1><p class="lead">${esc(props.subheading)}</p><div class="actions">${props.primaryLabel ? `<a class="button" href="${safeHref(props.primaryHref)}">${esc(props.primaryLabel)}</a>` : ''}${props.secondaryLabel ? `<a class="text-link" href="${safeHref(props.secondaryHref)}">${esc(props.secondaryLabel)} →</a>` : ''}</div>${props.imageUrl ? `<img class="hero-image" src="${esc(props.imageUrl)}" alt="${esc(props.imageAlt || '')}" />` : ''}</div></section>`;
    case 'products':
    case 'properties': return `<section class="section collection" id="explore"${animation}><div class="container"><div class="section-head"><p class="eyebrow">${esc(props.eyebrow || (item.type === 'products' ? 'SHOP' : 'PROPERTIES'))}</p><h2>${esc(props.heading || props.title || (item.type === 'products' ? 'Selected products' : 'Featured properties'))}</h2><p>${esc(props.body)}</p></div><div class="collection-grid">${renderCards(item, ctx)}</div></div></section>`;
    case 'features':
    case 'services':
    case 'pricing': return `<section class="section"${animation}><div class="container"><div class="section-head"><p class="eyebrow">${esc(props.eyebrow)}</p><h2>${esc(props.heading || props.title)}</h2><p>${esc(props.body)}</p></div><div class="feature-grid">${(Array.isArray(props.items) ? props.items : []).map((entry: any) => `<article><span>${esc(entry.icon || '✦')}</span><h3>${esc(entry.title)}</h3><p>${esc(entry.text || entry.description)}</p></article>`).join('')}</div></div></section>`;
    case 'about': return `<section class="section about about-${esc(item.variant)}"${animation}><div class="container about-grid"><p class="eyebrow">${esc(props.eyebrow || 'OUR STORY')}</p><div><h2>${esc(props.heading)}</h2>${String(props.body || '').split(/\n\n+/).map((paragraph) => `<p>${esc(paragraph)}</p>`).join('')}</div></div></section>`;
    case 'stats': return `<section class="section stats"${animation}><div class="container stats-grid">${(Array.isArray(props.items) ? props.items : []).map((entry: any) => `<div><strong>${esc(entry.value)}</strong><span>${esc(entry.label)}</span></div>`).join('')}</div></section>`;
    case 'testimonials': return `<section class="section"${animation}><div class="container"><div class="section-head"><h2>${esc(props.heading || props.title)}</h2></div><div class="quote-grid">${(Array.isArray(props.items) ? props.items : []).map((entry: any) => `<figure><blockquote>“${esc(entry.quote)}”</blockquote><figcaption>${esc(entry.name)}${entry.role ? `<span>${esc(entry.role)}</span>` : ''}</figcaption></figure>`).join('')}</div></div></section>`;
    case 'gallery': return `<section class="section"${animation}><div class="container"><div class="section-head"><h2>${esc(props.heading || props.title)}</h2></div><div class="gallery">${(Array.isArray(props.items) ? props.items : []).map((entry: any) => entry.url ? `<img src="${esc(entry.url)}" alt="${esc(entry.alt || '')}" loading="lazy" />` : '').join('')}</div></div></section>`;
    case 'faq': return `<section class="section"${animation}><div class="container narrow"><div class="section-head"><h2>${esc(props.heading || props.title)}</h2></div><div class="faq">${(Array.isArray(props.items) ? props.items : []).map((entry: any) => `<details><summary>${esc(entry.question)}</summary><p>${esc(entry.answer)}</p></details>`).join('')}</div></div></section>`;
    case 'cta': return `<section class="section cta"${animation}><div class="container"><h2>${esc(props.heading)}</h2><p>${esc(props.body)}</p><a class="button" href="${safeHref(props.buttonHref || props.buttonUrl)}">${esc(props.buttonLabel || props.buttonText || 'Get started')}</a></div></section>`;
    case 'contact': return `<section class="section contact" id="contact"${animation}><div class="container contact-grid"><div><p class="eyebrow">${esc(props.eyebrow || 'CONTACT')}</p><h2>${esc(props.heading)}</h2><p>${esc(props.body)}</p></div><form method="post" action="${ctx.basePath}/forms/contact">${ctx.previewPath !== null ? `<input type="hidden" name="previewPath" value="${esc(ctx.previewPath)}"/>` : ''}<label>Name<input name="name" required autocomplete="name" /></label><label>Email<input name="email" type="email" required autocomplete="email" /></label><label>Message<textarea name="message" rows="5"></textarea></label><button class="button" type="submit">${esc(props.buttonLabel || 'Send enquiry')}</button></form></div></section>`;
    case 'newsletter': return `<section class="section newsletter"${animation}><div class="container"><h2>${esc(props.heading)}</h2><p>${esc(props.body)}</p><form method="post" action="${ctx.basePath}/forms/newsletter">${ctx.previewPath !== null ? `<input type="hidden" name="previewPath" value="${esc(ctx.previewPath)}"/>` : ''}<label class="sr-only" for="newsletter-email">Email</label><input id="newsletter-email" name="email" type="email" required placeholder="Email address"/><button class="button">Subscribe</button></form></div></section>`;
    case 'collections':
    case 'team':
    case 'blog':
    case 'logoCloud': return `<section class="section"${animation}><div class="container"><div class="section-head"><p class="eyebrow">${esc(props.eyebrow)}</p><h2>${esc(props.heading || props.title)}</h2><p>${esc(props.body)}</p></div><div class="feature-grid">${(Array.isArray(props.items) ? props.items : []).map((entry: any) => `<article>${entry.imageUrl || entry.url ? `<img src="${esc(entry.imageUrl || entry.url)}" alt="${esc(entry.alt || entry.name || entry.title || '')}" loading="lazy"/>` : ''}<h3>${esc(entry.title || entry.name)}</h3><p>${esc(entry.text || entry.bio || entry.excerpt || entry.role)}</p></article>`).join('')}</div></div></section>`;
    case 'video': return `<section class="section"${animation}><div class="container"><div class="section-head"><h2>${esc(props.heading)}</h2><p>${esc(props.body)}</p></div>${props.url ? `<video controls preload="metadata" ${props.posterUrl ? `poster="${esc(props.posterUrl)}"` : ''} src="${esc(props.url)}"></video>` : ''}${props.caption ? `<p class="meta">${esc(props.caption)}</p>` : ''}</div></section>`;
    case 'map': return `<section class="section"${animation}><div class="container contact-grid"><div><h2>${esc(props.heading)}</h2><p>${esc(props.body || props.address)}</p></div>${props.mapUrl ? `<iframe title="Map for ${esc(props.address || ctx.organization?.name)}" src="${esc(props.mapUrl)}" loading="lazy"></iframe>` : ''}</div></section>`;
    case 'footer': return '';
    case 'spacer': return `<div style="height:${Math.max(8, Math.min(240, Number(props.height || 64)))}px" aria-hidden="true"></div>`;
    default: return '';
  }
}

function renderFooter(siteName: string, footer: Record<string, any>, ctx: RenderData) {
  const organization = ctx.organization;
  const profile = organization?.businessProfile;
  const useData = footer.useOrganizationData !== false;
  const address = [organization?.addressLine1, organization?.addressLine2, [organization?.city, organization?.state, organization?.postalCode].filter(Boolean).join(', '), organization?.country].filter(Boolean).join('<br/>');
  const contacts = [footer.showEmail !== false && organization?.email ? `<a href="mailto:${esc(organization.email)}">${esc(organization.email)}</a>` : '', footer.showPhone !== false && organization?.phone ? `<a href="tel:${esc(organization.phone)}">${esc(organization.phone)}</a>` : '', footer.showPhone !== false && profile?.whatsappNumber ? `<span>WhatsApp ${esc(profile.whatsappNumber)}</span>` : ''].filter(Boolean).join('');
  const social = footer.showSocialLinks !== false && profile?.socialLinks && typeof profile.socialLinks === 'object' ? Object.entries(profile.socialLinks as Record<string, unknown>).filter(([, url]) => url).map(([name, url]) => `<a href="${safeHref(url)}" rel="noopener noreferrer">${esc(name)}</a>`).join('') : '';
  const hours = footer.showBusinessHours !== false && profile?.openingHours ? `<div><strong>Business hours</strong><span>${esc(JSON.stringify(profile.openingHours).replace(/[{}\"]/g, '').replace(/,/g, ' · '))}</span></div>` : '';
  const logo = footer.showLogo !== false && organization?.logoUrl ? `<img style="display:block;height:42px;max-width:190px;object-fit:contain;margin-bottom:14px" src="${esc(organization.logoUrl)}" alt="${esc(organization.name)} logo"/>` : '';
  return `<footer class="site-footer footer-${esc(footer.variant || 'columns')}"><div class="container footer-grid"><div style="display:grid;gap:8px">${logo}<strong>${esc(organization?.name || siteName)}</strong>${useData && profile?.tagline ? `<span>${esc(profile.tagline)}</span>` : ''}</div>${useData && footer.showAddress !== false && address ? `<address>${address}</address>` : ''}${useData && contacts ? `<div style="display:grid;gap:8px">${contacts}</div>` : ''}${useData ? hours : ''}${useData && social ? `<div style="display:grid;gap:8px">${social}</div>` : ''}<span>${esc(footer.text || `© ${new Date().getFullYear()} ${siteName}`)}</span></div></footer>`;
}

function styles(theme: SiteThemeV2) {
  const radius = theme.layout.radius;
  const buttonRadius = theme.buttons.shape === 'pill' ? '999px' : theme.buttons.shape === 'square' ? '0' : `${Math.min(radius, 14)}px`;
  const light = theme.colors; const dark = theme.darkColors;
  const tokens = (value: typeof light) => `--primary:${esc(value.primary)};--secondary:${esc(value.secondary)};--accent:${esc(value.accent)};--background:${esc(value.background)};--surface:${esc(value.surface)};--surface-2:${esc(value.surfaceSecondary)};--text:${esc(value.text)};--muted:${esc(value.muted)};--border:${esc(value.border)}`;
  return `:root{${tokens(light)};--container:${theme.layout.containerWidth}px;--space:${theme.layout.sectionSpacing}px;--radius:${radius}px;--button-radius:${buttonRadius};color-scheme:light}[data-theme="dark"]{${tokens(dark)};color-scheme:dark}${theme.mode === 'dark' ? `:root{${tokens(dark)};color-scheme:dark}` : ''}${theme.mode === 'system' ? `@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){${tokens(dark)};color-scheme:dark}}` : ''}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--background);color:var(--text);font-family:${esc(theme.typography.bodyFont)},system-ui,sans-serif;font-weight:${theme.typography.bodyWeight};line-height:${theme.typography.lineHeight};letter-spacing:${theme.typography.letterSpacing}em}h1,h2,h3{font-family:${esc(theme.typography.headingFont)},system-ui,sans-serif;font-weight:${theme.typography.headingWeight};line-height:1.06;letter-spacing:-.035em;margin:0}a{color:inherit}.container{width:min(calc(100% - 40px),var(--container));margin:auto}.narrow{max-width:760px}.site-header{position:relative;z-index:20;background:color-mix(in srgb,var(--background) 92%,transparent);backdrop-filter:blur(16px);border-bottom:1px solid var(--border)}.site-header.sticky{position:sticky;top:0}.nav{min-height:78px;display:flex;align-items:center;gap:34px}.logo{font-family:${esc(theme.typography.headingFont)};font-size:20px;font-weight:${theme.typography.headingWeight};text-decoration:none}.nav-links{display:flex;gap:24px;margin-left:auto}.nav-links a{text-decoration:none;font-size:14px;color:var(--muted)}.theme-toggle{border:1px solid var(--border);background:var(--surface);color:var(--text);border-radius:999px;padding:8px 11px;cursor:pointer}.section{padding:var(--space) 0}.eyebrow{font-size:12px;letter-spacing:.18em;font-weight:800;color:var(--primary);margin:0 0 18px}.hero{min-height:720px;display:grid;align-items:center;overflow:hidden}.hero-inner{position:relative}.hero h1{font-size:clamp(48px,8vw,104px);max-width:1000px}.lead{font-size:clamp(18px,2vw,24px);color:var(--muted);max-width:680px;margin:28px 0}.actions{display:flex;align-items:center;gap:24px}.button{display:inline-flex;justify-content:center;align-items:center;background:var(--primary);color:#fff;border:0;border-radius:var(--button-radius);padding:14px 23px;font:inherit;font-weight:750;text-decoration:none;cursor:pointer}.text-link{font-weight:700;text-decoration:none}.hero-image{width:100%;max-height:620px;object-fit:cover;margin-top:56px}.section-head{max-width:720px;margin-bottom:46px}.section-head h2,.about h2,.contact h2,.cta h2{font-size:clamp(36px,5vw,68px)}.section-head>p:last-child,.about-grid>div>p,.contact-grid>div>p{color:var(--muted);font-size:18px}.collection-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:28px}.product-card a,.property-card a{text-decoration:none}.product-card img,.property-card img,.image-placeholder{display:block;width:100%;aspect-ratio:4/5;object-fit:cover;background:var(--surface-2);border-radius:var(--radius)}.property-card img,.property-card .image-placeholder{aspect-ratio:4/3}.card-copy{padding:18px 2px}.card-copy h3{font-size:20px}.price{font-weight:750}.meta{color:var(--muted)}.feature-grid,.quote-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:28px}.feature-grid article,.quote-grid figure{padding:34px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);margin:0}.feature-grid span{color:var(--primary)}.feature-grid p,figcaption span{color:var(--muted)}.about{background:var(--secondary);color:var(--background)}.about-grid{display:grid;grid-template-columns:1fr 2fr;gap:80px}.stats-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:30px}.stats strong{font-family:${esc(theme.typography.headingFont)};font-size:52px;display:block}.stats span{color:var(--muted)}blockquote{font-family:${esc(theme.typography.headingFont)};font-size:25px;margin:0 0 24px}.faq{display:grid;gap:1px}.faq details{padding:22px 0;border-bottom:1px solid var(--border)}.faq summary{font-weight:750;cursor:pointer}.gallery{display:grid;grid-template-columns:2fr 1fr 1fr;gap:12px}.gallery img{width:100%;height:100%;min-height:280px;object-fit:cover}.cta{text-align:center;background:var(--secondary);color:var(--background)}.contact-grid{display:grid;grid-template-columns:1fr 1fr;gap:90px}.contact form{display:grid;gap:16px}.contact label{font-size:13px;font-weight:700}.contact input,.contact textarea,.newsletter input{width:100%;margin-top:6px;padding:14px 15px;border:1px solid var(--border);color:var(--text);background:var(--surface);border-radius:8px;font:inherit}.newsletter{text-align:center;background:var(--surface)}.newsletter form{display:flex;max-width:520px;margin:24px auto}.newsletter input{margin:0}.site-footer{padding:64px 0;border-top:1px solid var(--border)}.footer-grid{display:flex;justify-content:space-between;gap:30px;color:var(--muted)}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}[data-animate]{animation:appear .7s ease both}@keyframes appear{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}@media(max-width:900px){.collection-grid{grid-template-columns:repeat(2,1fr)}.feature-grid,.quote-grid{grid-template-columns:1fr 1fr}.about-grid,.contact-grid{grid-template-columns:1fr;gap:34px}.hero{min-height:580px}.nav-links{display:none}}@media(max-width:560px){.container{width:min(calc(100% - 28px),var(--container))}.section{padding:calc(var(--space)*.66) 0}.collection-grid,.feature-grid,.quote-grid,.stats-grid{grid-template-columns:1fr}.hero h1{font-size:48px}.actions{align-items:flex-start;flex-direction:column}.newsletter form{display:grid;gap:10px}.footer-grid{display:grid}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;animation:none!important;transition:none!important}}`;
}

export const sitePublicService = {
  async resolve(hostOrSubdomain: string, path: string, mode: 'subdomain' | 'managed' | 'custom') {
    const normalized = hostOrSubdomain.toLowerCase();
    let managedSubdomain = '';
    if (mode === 'managed') {
      const config = await domainConfigService.active();
      if (!config || !normalized.endsWith(`.${config.baseDomain.toLowerCase()}`)) return null;
      managedSubdomain = normalized.slice(0, -(`.${config.baseDomain}`.length));
      if (!managedSubdomain || managedSubdomain.includes('.')) return null;
    }
    const where = mode === 'subdomain' ? { subdomain: normalized } : mode === 'custom' ? { customDomain: normalized, domainVerifiedAt: { not: null } } : { subdomain: managedSubdomain };
    const site = await prismaUnscoped.site.findFirst({ where: { ...where, status: 'PUBLISHED' }, select: { id: true, organizationId: true, name: true, publishedSnapshot: true } });
    if (!site?.publishedSnapshot) return null;
    return this.render(site, path, mode === 'subdomain' ? `/site/${normalized}` : '');
  },

  async resolvePreview(token: string, rawPath: string) {
    let payload: { purpose: string; siteId: string; organizationId: string; expiresAt: number };
    try { payload = JSON.parse(decrypt(token)); } catch { return { state: 'invalid' as const, html: null }; }
    if (payload.purpose !== 'website-preview' || !payload.siteId || !payload.organizationId) return { state: 'invalid' as const, html: null };
    if (!Number.isFinite(payload.expiresAt) || payload.expiresAt <= Date.now()) return { state: 'expired' as const, html: null };
    const site = await prismaUnscoped.site.findFirst({
      where: { id: payload.siteId, organizationId: payload.organizationId },
      include: { pages: { orderBy: { position: 'asc' } } },
    });
    if (!site) return { state: 'invalid' as const, html: null };
    const draft: PublishedSnapshot = {
      schemaVersion: site.schemaVersion,
      site: { id: site.id, name: site.name, theme: site.theme, navigation: site.navigation, settings: site.settings, seo: site.seo },
      pages: site.pages.map((page) => ({ id: page.id, title: page.title, slug: page.slug, sections: page.blocks, seo: page.seo, isHome: page.isHome, showInNav: page.showInNav, status: page.status })),
    };
    const basePath = `/preview/${encodeURIComponent(token)}`;
    const html = await this.render({ id: site.id, organizationId: site.organizationId, name: site.name, publishedSnapshot: draft }, rawPath, basePath, { preview: true });
    return { state: html ? 'ok' as const : 'not-found' as const, html };
  },

  async render(site: { id: string; organizationId: string; name: string; publishedSnapshot: unknown }, rawPath: string, basePath = '', options: { preview?: boolean } = {}) {
    const value = site.publishedSnapshot as PublishedSnapshot;
    const settings = (value.site.settings ?? {}) as any;
    const commerceEnabled = settings.commerce?.enabled === true;
    const path = rawPath.replace(/^\/+|\/+$/g, '');
    const ctx: RenderData = { ...(await dataContext(site.organizationId)), basePath, commerceEnabled, previewPath: options.preview ? path : null };
    const [kind, slug] = path.split('/');
    const theme = normalizeTheme(value.site.theme);
    const nav = (value.site.navigation ?? {}) as any;
    const siteSeo = (value.site.seo ?? {}) as any;
    let pageSeo: Record<string, any> = {};
    let title = site.name;
    let description = siteSeo.description || '';
    let body = '';
    if (kind === 'products' && slug) {
      const product = ctx.products.find((entry) => entry.slug === slug);
      if (!product) return null;
      title = product.name; description = product.description || '';
      const variant = product.variants[0]; const image = product.imageUrl;
      body = `<section class="section"><div class="container contact-grid">${image ? `<img class="hero-image" src="${esc(image)}" alt="${esc(product.images[0]?.altText || product.name)}"/>` : '<span class="image-placeholder"></span>'}<div><p class="eyebrow">PRODUCT</p><h1>${esc(product.name)}</h1>${variant ? `<p class="price">${money(variant.price, variant.currency)}</p>` : ''}<p>${esc(product.description)}</p>${variant && commerceEnabled ? `<button class="button cart-add" data-variant="${esc(variant.id)}" data-name="${esc(product.name)}">Add to cart</button>` : ''}</div></div></section>`;
    } else if (kind === 'properties' && slug) {
      const property = ctx.properties.find((entry) => entry.reference === slug);
      if (!property) return null;
      title = property.title; description = property.description || '';
      const image = property.imageUrl; const price = property.price ?? property.rentAmount;
      body = `<section class="section"><div class="container contact-grid">${image ? `<img class="hero-image" src="${esc(image)}" alt="${esc(property.title)}"/>` : '<span class="image-placeholder"></span>'}<div><p class="eyebrow">${esc(property.city || property.purpose)}</p><h1>${esc(property.title)}</h1>${price ? `<p class="price">${money(price, property.currency)}</p>` : ''}<p>${esc(property.description)}</p><p>${esc((property.amenities as string[] | null)?.join(' · '))}</p><a class="button" href="#contact">Request a viewing</a></div></div></section>`;
    } else {
      const page = value.pages.find((entry) => entry.slug === path || (!path && entry.isHome));
      if (!page || page.status === 'HIDDEN') return null;
      const seo = (page.seo ?? {}) as any; pageSeo = seo; title = seo.title || page.title; description = seo.description || description;
      body = normalizeSections(page.sections).map((item) => renderSection(item, ctx)).join('');
    }
    const pages = value.pages.filter((page) => page.showInNav && page.status !== 'HIDDEN');
    const links = pages.map((page) => `<a href="${basePath}/${esc(page.slug)}">${esc(page.title)}</a>`).join('');
    const cartStyles = commerceEnabled ? `.cart-add{border:0;background:none;color:var(--primary);font:inherit;font-weight:750;padding:0 2px;cursor:pointer}.cart-drawer{position:fixed;right:18px;bottom:18px;z-index:50;width:min(390px,calc(100% - 36px));padding:22px;background:var(--surface);color:var(--text);border-radius:var(--radius);box-shadow:0 24px 70px #0003;display:none}.cart-drawer.open{display:block}.cart-items{display:grid;gap:8px;margin:16px 0}.cart-item{display:flex;justify-content:space-between;gap:12px}.cart-drawer input{width:100%;padding:11px;margin:5px 0;border:1px solid #ddd;border-radius:8px}` : '';
    const cartMarkup = commerceEnabled ? `<aside id="cart" class="cart-drawer" aria-label="Shopping cart"><button id="cart-close" class="cart-add">Close</button><h2>Your cart</h2><div id="cart-items" class="cart-items"></div><form id="checkout-form"><input name="name" placeholder="Full name" required/><input name="email" type="email" required placeholder="Email"/><input name="phone" placeholder="Phone"/><button class="button" type="submit">Continue to payment</button></form><p id="cart-message"></p></aside>` : '';
    const cartScript = commerceEnabled ? `(function(){var key='vh_cart_${esc(site.id)}';var cart=JSON.parse(localStorage.getItem(key)||'[]');var drawer=document.getElementById('cart'),items=document.getElementById('cart-items'),count=document.getElementById('cart-count');function draw(){count.textContent=String(cart.reduce(function(s,i){return s+i.quantity},0));items.innerHTML=cart.length?cart.map(function(i){return '<div class="cart-item"><span>'+i.name+' × '+i.quantity+'</span><button class="cart-add" data-remove="'+i.variantId+'">Remove</button></div>'}).join(''):'<p>Your cart is empty.</p>';localStorage.setItem(key,JSON.stringify(cart))}document.querySelectorAll('.cart-add[data-variant]').forEach(function(button){button.addEventListener('click',function(){var id=button.dataset.variant,found=cart.find(function(i){return i.variantId===id});if(found)found.quantity++;else cart.push({variantId:id,name:button.dataset.name,quantity:1});drawer.classList.add('open');draw()})});items.addEventListener('click',function(event){var button=event.target.closest('[data-remove]');if(button){cart=cart.filter(function(i){return i.variantId!==button.dataset.remove});draw()}});document.getElementById('cart-toggle').onclick=function(){drawer.classList.add('open')};document.getElementById('cart-close').onclick=function(){drawer.classList.remove('open')};document.getElementById('checkout-form').onsubmit=async function(event){event.preventDefault();if(!cart.length)return;var form=new FormData(event.target),message=document.getElementById('cart-message');message.textContent='Preparing secure payment…';var response=await fetch('${basePath}/checkout',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:form.get('name'),email:form.get('email'),phone:form.get('phone'),items:cart.map(function(i){return{variantId:i.variantId,quantity:i.quantity}})})});var payload=await response.json();if(!response.ok){message.textContent=payload.error?.message||payload.error||'Checkout could not be started.';return}localStorage.removeItem(key);location.href=payload.url};draw()})();` : '';
    const analyticsScript = !options.preview && settings.analytics?.enabled ? `navigator.sendBeacon('${basePath}/site-event',new Blob([JSON.stringify({siteId:'${esc(site.id)}',type:'PAGE_VIEW',path:location.pathname,session:sessionStorage.vhSiteSession||(sessionStorage.vhSiteSession=crypto.randomUUID()),referrer:document.referrer?new URL(document.referrer).hostname:''})],{type:'application/json'}));` : '';
    const organizationSchema = JSON.stringify({ '@context': 'https://schema.org', '@type': 'Organization', name: ctx.organization?.name || site.name, url: ctx.organization?.website || undefined, email: ctx.organization?.email || undefined, telephone: ctx.organization?.phone || undefined }).replace(/</g, '\\u003c');
    const themeBoot = `<script>(function(){var configured='${theme.mode}',saved=localStorage.getItem('vh_theme_${esc(site.id)}');if(saved)document.documentElement.dataset.theme=saved;else if(configured!=='system')document.documentElement.dataset.theme=configured})()</script>`;
    const themeToggle = theme.allowVisitorSwitch ? '<button id="theme-toggle" class="theme-toggle" type="button" aria-label="Switch website theme">◐</button>' : '';
    const themeToggleScript = theme.allowVisitorSwitch ? `(function(){var button=document.getElementById('theme-toggle');button.onclick=function(){var current=document.documentElement.dataset.theme||(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light');var next=current==='dark'?'light':'dark';document.documentElement.dataset.theme=next;localStorage.setItem('vh_theme_${esc(site.id)}',next)}})();` : '';
    const robots = options.preview || pageSeo.index === false ? 'noindex,nofollow,noarchive' : 'index,follow';
    const logoUrl = nav.header?.logoUrl || ctx.organization?.logoUrl;
    const brand = logoUrl ? `<img style="display:block;height:38px;max-width:180px;object-fit:contain" src="${esc(logoUrl)}" alt="${esc(site.name)} logo"/>` : esc(site.name);
    const canonical = pageSeo.canonicalUrl ? `<link rel="canonical" href="${esc(pageSeo.canonicalUrl)}"/>` : '';
    const socialImage = pageSeo.socialImageUrl ? `<meta property="og:image" content="${esc(pageSeo.socialImageUrl)}"/>` : '';
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>${themeBoot}<title>${esc(title)} · ${esc(site.name)}</title><meta name="description" content="${esc(description)}"/><meta name="robots" content="${robots}"/>${options.preview ? '<meta name="googlebot" content="noindex,nofollow,noarchive"/>' : ''}${canonical}<meta property="og:title" content="${esc(title)}"/><meta property="og:description" content="${esc(description)}"/>${socialImage}${fontStylesheet(theme)}<script type="application/ld+json">${organizationSchema}</script><style>${styles(theme)}${cartStyles}${options.preview ? '.preview-notice{position:fixed;z-index:100;left:50%;bottom:16px;transform:translateX(-50%);padding:8px 14px;border-radius:999px;background:#111827e8;color:#fff;font:600 12px/1.2 system-ui;box-shadow:0 8px 30px #0004;pointer-events:none}' : ''}</style></head><body><header class="site-header ${nav.header?.sticky ? 'sticky' : ''}"><nav class="container nav" aria-label="Main navigation"><a class="logo" href="${basePath}/">${brand}</a><div class="nav-links">${links}</div>${themeToggle}${commerceEnabled ? '<button id="cart-toggle" class="cart-add" aria-label="Open cart">Cart <span id="cart-count">0</span></button>' : ''}${nav.header?.ctaLabel ? `<a class="button" href="${safeHref(nav.header.ctaHref)}">${esc(nav.header.ctaLabel)}</a>` : ''}</nav></header><main>${body}</main>${renderFooter(site.name, nav.footer ?? {}, ctx)}${cartMarkup}${options.preview ? '<div class="preview-notice">Preview · forms and payments are simulated</div>' : ''}${!options.preview && settings.integrations?.webChat && ctx.webChatAccountId ? `<script src="/widget.js" data-account="${esc(ctx.webChatAccountId)}" defer></script>` : ''}${cartScript || analyticsScript || themeToggleScript ? `<script>${themeToggleScript}${cartScript}${analyticsScript}</script>` : ''}</body></html>`;
  },

  async discovery(hostOrSubdomain: string, mode: 'subdomain' | 'managed' | 'custom') {
    const normalized = hostOrSubdomain.toLowerCase();
    let where: Record<string, unknown>;
    if (mode === 'subdomain') where = { subdomain: normalized };
    else if (mode === 'custom') where = { customDomain: normalized, domainVerifiedAt: { not: null } };
    else {
      const config = await domainConfigService.active();
      if (!config || !normalized.endsWith(`.${config.baseDomain.toLowerCase()}`)) return null;
      const subdomain = normalized.slice(0, -(`.${config.baseDomain}`.length));
      if (!subdomain || subdomain.includes('.')) return null;
      where = { subdomain };
    }
    const site = await prismaUnscoped.site.findFirst({ where: { ...where, status: 'PUBLISHED' }, select: { publishedSnapshot: true } });
    if (!site?.publishedSnapshot) return null;
    const snapshot = site.publishedSnapshot as PublishedSnapshot;
    return snapshot.pages.filter((page) => page.status !== 'HIDDEN').map((page) => page.isHome ? '' : page.slug);
  },
};
