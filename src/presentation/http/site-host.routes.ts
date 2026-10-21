import { Router, type NextFunction, type Request, type Response } from 'express';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { sitePublicService } from '../../application/sites/site-public.service';
import { siteBuilderService } from '../../application/sites/site-builder.service';
import { customersService } from '../../application/customers/customers.service';
import { ordersService } from '../../application/orders/orders.service';
import { paymentLinksService } from '../../application/payments/payment-links.service';
import { resolveEntitlements } from '../../application/billing/entitlements';
import { NotFoundError, ValidationError } from '../../shared/errors';
import { logger } from '../../shared/logger';
import { env } from '../../shared/config/env';
import { domainConfigService } from '../../application/sites/domain-config.service';
import { cartState, orderPaymentState } from '../../application/sites/site-cart.service';

export const siteHostRoutes = Router();
siteHostRoutes.use(express.urlencoded({ extended: true }));
export const sitePreviewRoutes = Router();
sitePreviewRoutes.use(express.urlencoded({ extended: true }));

const notFound = (res: Response) => res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><title>Not found</title><body style="font-family:system-ui;text-align:center;padding:80px"><h1>Website not found</h1></body>');
const thankYou = (res: Response, back: string) => res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Thank you</title><body style="font-family:system-ui;text-align:center;padding:80px"><h1>Thank you.</h1><p>Your message has been received.</p><a href="${encodeURI(back)}">Back to website</a></body>`);
const previewState = (res: Response, title: string, message: string, status = 410) => {
  websiteHeaders(res, true);
  return res.status(status).type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>${title}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f7f5f1;color:#171717;font:16px/1.6 system-ui}.card{max-width:560px;margin:24px;padding:48px;border:1px solid #dedad3;border-radius:20px;background:#fff;box-shadow:0 24px 70px #00000010}h1{font-size:38px;line-height:1.1;margin:0 0 16px}</style></head><body><main class="card"><h1>${title}</h1><p>${message}</p><p>Return to Vhicasar Hub AI and generate a new preview.</p></main></body></html>`);
};
const websiteHeaders = (res: Response, preview = false) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
  if (preview) {
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  }
};

sitePreviewRoutes.post('/:token/forms/:kind', async (req, res, next) => {
  try {
    const previewPath = String(req.body.previewPath ?? '').replace(/^\/+|\/+$/g, '');
    if (previewPath && !/^[a-z0-9][a-z0-9/-]*$/i.test(previewPath)) return previewState(res, 'Preview unavailable', 'The preview return path is invalid.', 400);
    const result = await sitePublicService.resolvePreview(req.params.token as string, previewPath);
    if (result.state === 'expired') return previewState(res, 'Preview expired', 'This secure preview link has expired.');
    if (result.state !== 'ok' || !result.html) return previewState(res, 'Preview unavailable', 'This preview link or page is no longer available.', 404);
    const back = `/preview/${encodeURIComponent(req.params.token as string)}/${previewPath ? previewPath.split('/').map(encodeURIComponent).join('/') : ''}`;
    websiteHeaders(res, true);
    return res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>Preview form submitted</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f7f5f1;color:#171717;font:16px/1.6 system-ui}.card{max-width:580px;margin:24px;padding:48px;border:1px solid #dedad3;border-radius:18px;background:#fff;box-shadow:0 24px 70px #0001;text-align:center}h1{font-size:38px;line-height:1.1;margin:0 0 16px}.button{display:inline-block;margin-top:18px;padding:12px 20px;border-radius:10px;background:#171717;color:#fff;text-decoration:none;font-weight:750}</style></head><body><main class="card"><h1>Preview form submitted</h1><p>No CRM lead, notification, email or production record was created.</p><a class="button" href="${back}">Back to preview</a></main></body></html>`);
  } catch (error) { next(error); }
});

sitePreviewRoutes.post('/:token/checkout', (_req, res) => {
  res.status(409).json({ success: false, error: { code: 'PREVIEW_CHECKOUT', message: 'Checkout is simulated in preview. No order or payment was created.' } });
});

sitePreviewRoutes.post('/:token/site-event', (_req, res) => res.status(204).end());

sitePreviewRoutes.get('/:token/*?', async (req, res, next) => {
  try {
    const path = String((req.params as Record<string, string>)[0] ?? '');
    const result = await sitePublicService.resolvePreview(req.params.token as string, path);
    if (result.state === 'expired') return previewState(res, 'Preview expired', 'This secure preview link has expired.');
    if (result.state === 'invalid') return previewState(res, 'Preview unavailable', 'This preview link is invalid or is no longer available.', 404);
    if (!result.html) return previewState(res, 'Page not found', 'This page does not exist in the current website draft.', 404);
    websiteHeaders(res, true);
    return res.type('html').send(result.html);
  } catch (error) { next(error); }
});

async function siteBySubdomain(subdomain: string) {
  return prismaUnscoped.site.findFirst({ where: { subdomain: subdomain.toLowerCase(), status: 'PUBLISHED' }, select: { id: true, organizationId: true, publishedSnapshot: true } });
}

async function capture(site: { id: string; organizationId: string }, kind: string, body: Record<string, unknown>, page: string) {
  const name = String(body.name ?? 'Website visitor').trim();
  const [firstName, ...last] = name.split(/\s+/);
  await prismaUnscoped.lead.create({ data: {
    organizationId: site.organizationId, firstName: firstName || 'Website', lastName: last.join(' ') || null,
    email: body.email ? String(body.email).slice(0, 320) : null, source: 'WEBSITE', status: 'NEW',
    customFields: { websiteSiteId: site.id, websitePage: page, websiteForm: kind, message: String(body.message ?? '').slice(0, 5000) },
  } });
  await siteBuilderService.recordEvent(site.id, 'FORM_SUBMITTED', page, undefined, undefined, { form: kind });
}

function requireCommerce(site: { publishedSnapshot?: unknown }): void {
  const snapshot = site.publishedSnapshot as { site?: { settings?: { commerce?: { enabled?: boolean } } } } | null;
  if (snapshot?.site?.settings?.commerce?.enabled !== true) {
    throw new ValidationError('Commerce is not enabled for this website');
  }
}

async function checkout(site: { id: string; organizationId: string; publishedSnapshot?: unknown }, body: Record<string, unknown>) {
  requireCommerce(site);
  const email = String(body.email ?? '').trim().toLowerCase();
  const name = String(body.name ?? '').trim();
  const phone = String(body.phone ?? '').trim() || undefined;
  const items = Array.isArray(body.items) ? body.items.map((item) => item as Record<string, unknown>).map((item) => ({ variantId: String(item.variantId ?? ''), quantity: Math.max(1, Math.min(100, Math.floor(Number(item.quantity) || 1))) })).filter((item) => item.variantId) : [];
  if (!email || !name || !items.length) throw new ValidationError('Name, email and at least one cart item are required');
  const [firstName, ...last] = name.split(/\s+/);
  return requestContext.run({ requestId: `site-checkout:${randomUUID()}`, correlationId: randomUUID(), organizationId: site.organizationId }, async () => {
    let customer = await prismaUnscoped.customer.findFirst({ where: { organizationId: site.organizationId, email, deletedAt: null }, select: { id: true } });
    if (!customer) {
      const entitlements = await resolveEntitlements(site.organizationId);
      const used = await prismaUnscoped.customer.count({ where: { organizationId: site.organizationId, deletedAt: null, subscriptionDraftAt: null } });
      if (entitlements.limits.maxContacts !== null && used >= entitlements.limits.maxContacts) throw new ValidationError('This store cannot accept a new customer at the moment. Please contact the business.');
      customer = await customersService.create({ firstName: firstName || 'Website', lastName: last.join(' ') || undefined, email, phone, marketingOptIn: false });
    }
    const order = await ordersService.create({ customerId: customer.id, source: 'WEB', shippingTotal: 0, items }, null);
    const payment = await paymentLinksService.create({ resourceType: 'ORDER', resourceId: order.id, customerId: customer.id, allowPartial: false }, null);
    await siteBuilderService.recordEvent(site.id, 'CHECKOUT_STARTED', '/checkout', undefined, undefined, { orderId: order.id });
    return { orderId: order.id, url: payment.url };
  });
}

/**
 * Price and stock for what is in a visitor's cart.
 *
 * The cart is browser state, so it asks this before it shows a subtotal or
 * lets anyone press `+`. Commerce being switched off is answered the same way
 * checkout answers it, so a site that stopped selling stops here too.
 */
async function cart(site: { organizationId: string; publishedSnapshot?: unknown }, body: Record<string, unknown>) {
  requireCommerce(site);
  const variantIds = Array.isArray(body.variantIds)
    ? body.variantIds.map((value) => String(value)).filter(Boolean)
    : [];
  return { items: await cartState(site.organizationId, variantIds) };
}

/**
 * Whether the order a visitor went off to pay for has been paid.
 *
 * The payment page is on the platform's own origin, not the website's, so
 * nothing it does can be heard by the tab the customer was shopping in. That
 * tab polls this instead, and empties its cart only on a yes from here —
 * never because the customer merely opened the payment page.
 */
async function orderStatus(site: { organizationId: string }, orderId: string) {
  const state = await orderPaymentState(site.organizationId, orderId);
  if (!state) throw new NotFoundError('Order');
  return state;
}

/**
 * Whether this platform will serve a given hostname — Caddy's `ask` endpoint.
 *
 * On-demand TLS issues a certificate the first time a hostname is requested,
 * which is the only practical way to cover both tenant subdomains and the
 * custom domains businesses bring. Without an `ask` endpoint it will do that
 * for *any* hostname pointed at the server, so a stranger could burn the
 * platform's Let's Encrypt rate limit with names we have never heard of.
 *
 * This answers the one question Caddy asks: do we serve this? 200 for a
 * published site or a verified custom domain, 404 for anything else.
 */
siteHostRoutes.get('/tls-check', async (req, res, next) => {
  try {
    const domain = String(req.query.domain ?? '').toLowerCase().trim();
    if (!domain || domain.length > 253) return res.status(404).send('no');

    const config = await domainConfigService.active();
    const baseDomain = config?.baseDomain.toLowerCase();

    /*
     * The platform's own hostnames are always allowed.
     *
     * A wildcard site block can swallow a hostname whose own block is
     * misplaced during an edit, and then this endpoint is what decides
     * whether it gets a certificate. Answering "no" for the app's own address
     * turns a config slip into a total outage with an SSL error and no
     * obvious cause — so the hosts the platform is reachable at are approved
     * here regardless of whether a site is published on them.
     */
    const ownHosts = new Set(
      [env.WEB_APP_URL, env.API_BASE_URL]
        .map((value) => { try { return new URL(value).hostname.toLowerCase(); } catch { return ''; } })
        .filter(Boolean),
    );
    if (baseDomain) ownHosts.add(baseDomain);
    if (ownHosts.has(domain)) return res.status(200).send('ok');

    // A published subdomain of the platform's own website domain.
    if (baseDomain && domain.endsWith(`.${baseDomain}`)) {
      const subdomain = domain.slice(0, -(`.${baseDomain}`.length));
      if (subdomain && !subdomain.includes('.')) {
        const site = await prismaUnscoped.site.findFirst({
          where: { subdomain, status: 'PUBLISHED' }, select: { id: true },
        });
        if (site) return res.status(200).send('ok');
      }
    }

    // A customer's own domain, but only once they have proved they own it.
    const custom = await prismaUnscoped.site.findFirst({
      where: { customDomain: domain, domainVerifiedAt: { not: null }, status: 'PUBLISHED' },
      select: { id: true },
    });
    if (custom) return res.status(200).send('ok');

    logger.info({ domain }, 'Refused a certificate request for an unknown hostname');
    return res.status(404).send('no');
  } catch (error) { next(error); }
});

siteHostRoutes.post('/:subdomain/forms/:kind', async (req, res, next) => {
  try {
    const site = await siteBySubdomain(req.params.subdomain as string);
    if (!site) return notFound(res);
    await capture(site, req.params.kind as string, req.body as Record<string, unknown>, String(req.get('referer') ?? ''));
    return thankYou(res, `/site/${encodeURIComponent(req.params.subdomain as string)}`);
  } catch (error) { next(error); }
});

siteHostRoutes.post('/:subdomain/site-event', async (req, res, next) => {
  try {
    const site = await siteBySubdomain(req.params.subdomain as string);
    if (site) await siteBuilderService.recordEvent(site.id, String(req.body.type), String(req.body.path ?? '/'), String(req.body.session ?? ''), String(req.body.referrer ?? ''));
    res.status(204).end();
  } catch (error) { next(error); }
});

siteHostRoutes.post('/:subdomain/checkout', async (req, res, next) => {
  try {
    const site = await siteBySubdomain(req.params.subdomain as string);
    if (!site) return notFound(res);
    res.json(await checkout(site, req.body as Record<string, unknown>));
  } catch (error) { next(error); }
});

siteHostRoutes.post('/:subdomain/cart', async (req, res, next) => {
  try {
    const site = await siteBySubdomain(req.params.subdomain as string);
    if (!site) return notFound(res);
    res.json(await cart(site, req.body as Record<string, unknown>));
  } catch (error) { next(error); }
});

siteHostRoutes.get('/:subdomain/order-status', async (req, res, next) => {
  try {
    const site = await siteBySubdomain(req.params.subdomain as string);
    if (!site) return notFound(res);
    res.json(await orderStatus(site, String(req.query.order ?? '')));
  } catch (error) { next(error); }
});

siteHostRoutes.get('/:subdomain/*?', async (req, res, next) => {
  try {
    const path = String((req.params as Record<string, string>)[0] ?? '');
    if (path === 'robots.txt') {
      const pages = await sitePublicService.discovery(req.params.subdomain as string, 'subdomain');
      if (!pages) return notFound(res);
      return res.type('text/plain').send(`User-agent: *\nAllow: /\nSitemap: ${req.protocol}://${req.get('host')}/site/${encodeURIComponent(req.params.subdomain as string)}/sitemap.xml\n`);
    }
    if (path === 'sitemap.xml') {
      const pages = await sitePublicService.discovery(req.params.subdomain as string, 'subdomain');
      if (!pages) return notFound(res);
      const base = `${req.protocol}://${req.get('host')}/site/${encodeURIComponent(req.params.subdomain as string)}`;
      const urls = pages.map((slug) => `<url><loc>${base}${slug ? `/${encodeURIComponent(slug)}` : '/'}</loc></url>`).join('');
      return res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`);
    }
    const html = await sitePublicService.resolve(req.params.subdomain as string, path, 'subdomain');
    if (!html) return notFound(res);
    websiteHeaders(res);
    res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    res.type('html').send(html);
  } catch (error) { next(error); }
});

/** Verified custom/managed domains are served last, after application routes. */
export function customDomainHost(req: Request, res: Response, next: NextFunction) {
  const hostname = req.hostname.toLowerCase();
  const path = req.path.replace(/^\/+|\/+$/g, '');
  const lookup = async () => {
    const custom = await prismaUnscoped.site.findFirst({ where: { customDomain: hostname, domainVerifiedAt: { not: null }, status: 'PUBLISHED' }, select: { id: true, organizationId: true, publishedSnapshot: true } });
    if (custom) return custom;
    const config = await domainConfigService.active();
    if (!config || !hostname.endsWith(`.${config.baseDomain.toLowerCase()}`)) return null;
    const subdomain = hostname.slice(0, -(`.${config.baseDomain}`.length));
    if (!subdomain || subdomain.includes('.')) return null;
    return siteBySubdomain(subdomain);
  };
  if (req.method === 'POST' && path.startsWith('forms/')) {
    lookup().then(async (site) => {
      if (!site) return next();
      await capture(site, path.slice('forms/'.length), req.body as Record<string, unknown>, String(req.get('referer') ?? ''));
      thankYou(res, '/');
    }).catch(next);
    return;
  }
  if (req.method === 'POST' && path === 'site-event') {
    lookup().then(async (site) => {
      if (site) await siteBuilderService.recordEvent(site.id, String(req.body.type), String(req.body.path ?? '/'), String(req.body.session ?? ''), String(req.body.referrer ?? ''));
      res.status(204).end();
    }).catch(next);
    return;
  }
  if (req.method === 'POST' && path === 'checkout') {
    lookup().then(async (site) => {
      if (!site) return next();
      res.json(await checkout(site, req.body as Record<string, unknown>));
    }).catch(next);
    return;
  }
  if (req.method === 'POST' && path === 'cart') {
    lookup().then(async (site) => {
      if (!site) return next();
      res.json(await cart(site, req.body as Record<string, unknown>));
    }).catch(next);
    return;
  }
  if (req.method !== 'GET') return next();
  if (path === 'order-status') {
    lookup().then(async (site) => {
      if (!site) return next();
      res.json(await orderStatus(site, String(req.query.order ?? '')));
    }).catch(next);
    return;
  }
  if (path === 'robots.txt' || path === 'sitemap.xml') {
    Promise.all([
      sitePublicService.discovery(hostname, 'custom'),
      sitePublicService.discovery(hostname, 'managed'),
    ]).then(([custom, managed]) => custom ?? managed).then((pages) => {
      if (!pages) return next();
      const origin = `${req.protocol}://${req.get('host')}`;
      if (path === 'robots.txt') return res.type('text/plain').send(`User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`);
      const urls = pages.map((slug) => `<url><loc>${origin}${slug ? `/${encodeURIComponent(slug)}` : '/'}</loc></url>`).join('');
      return res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`);
    }).catch(next);
    return;
  }
  Promise.all([
    sitePublicService.resolve(hostname, path, 'custom'),
    sitePublicService.resolve(hostname, path, 'managed'),
  ]).then(([custom, managed]) => custom ?? managed).then((html) => {
    if (!html) return next();
    websiteHeaders(res);
    res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    res.type('html').send(html);
  }).catch(next);
}
