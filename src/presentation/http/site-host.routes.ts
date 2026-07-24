import { Router, type Request, type Response } from 'express';
import express from 'express';
import { siteService, recordSiteLead } from '../../application/sites/site.service';

/**
 * Public hosting for published websites, path-based: /site/<subdomain>[/<slug>].
 * Serves server-rendered HTML and accepts contact-form posts as CRM leads.
 */
export const siteHostRoutes = Router();
siteHostRoutes.use(express.urlencoded({ extended: true }));

const notFound = (res: Response) =>
  res.status(404).type('html').send(
    '<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;text-align:center;padding:80px"><h1>Site not found</h1></body>'
  );

// Contact form → CRM lead, then a thank-you page.
siteHostRoutes.post('/:subdomain/submit', (req, res, next) => {
  const sub = req.params.subdomain as string;
  recordSiteLead(sub, { name: req.body.name, email: req.body.email, message: req.body.message })
    .catch(() => undefined)
    .finally(() => {
      res.type('html').send(
        `<!doctype html><meta charset="utf-8"><title>Thanks</title>` +
          `<body style="font-family:system-ui;text-align:center;padding:80px"><h1>Thanks!</h1>` +
          `<p>We got your message and will be in touch.</p>` +
          `<a href="/site/${encodeURIComponent(sub)}">&larr; Back to the site</a></body>`
      );
    })
    .catch(next);
});

async function serve(req: Request, res: Response) {
  const html = await siteService.renderHtml(req.params.subdomain as string, (req.params.slug as string) ?? '');
  if (!html) return notFound(res);
  res.type('html').send(html);
}

siteHostRoutes.get('/:subdomain', (req, res, next) => serve(req, res).catch(next));
siteHostRoutes.get('/:subdomain/:slug', (req, res, next) => serve(req, res).catch(next));
