import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import { validate } from '../middleware/validate';
import { siteService, updateSiteSchema, pageSchema, publishSchema } from '../../../application/sites/site.service';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

/** Website builder management API (session-authenticated). */
export const sitesRoutes = Router();
sitesRoutes.use(authenticate, requireTenant);

sitesRoutes.get('/', requirePermission('marketing.read'), wrap(async (_req, res) => {
  res.json({ success: true, data: await siteService.ensureSite() });
}));

// Full, interactive draft preview. Authenticated so unpublished work remains private.
sitesRoutes.get('/preview', requirePermission('marketing.read'), validate({ query: z.object({ slug: z.string().optional() }) }), wrap(async (req, res) => {
  res.type('html').send(await siteService.renderPreviewHtml(String(req.query.slug ?? '')));
}));

sitesRoutes.patch('/', requirePermission('marketing.update'), validate({ body: updateSiteSchema }), wrap(async (req, res) => {
  res.json({ success: true, data: await siteService.updateSite(req.body) });
}));

sitesRoutes.get('/subdomain-available', requirePermission('marketing.read'), validate({ query: z.object({ subdomain: z.string() }) }), wrap(async (req, res) => {
  res.json({ success: true, data: await siteService.subdomainAvailable(String(req.query.subdomain)) });
}));

sitesRoutes.get('/deployment-config', requirePermission('marketing.read'), wrap(async (_req, res) => {
  res.json({ success: true, data: await siteService.subdomainDeploymentInfo() });
}));

sitesRoutes.post('/publish', requirePermission('marketing.update'), validate({ body: publishSchema }), wrap(async (req, res) => {
  res.json({ success: true, data: await siteService.publish(req.body.subdomain) });
}));

sitesRoutes.post('/unpublish', requirePermission('marketing.update'), wrap(async (_req, res) => {
  res.json({ success: true, data: await siteService.unpublish() });
}));

sitesRoutes.post('/domain', requirePermission('marketing.update'), validate({ body: z.object({ domain: z.string().trim().min(4).max(253) }) }), wrap(async (req, res) => {
  res.json({ success: true, data: await siteService.connectDomain(req.body.domain) });
}));

sitesRoutes.post('/domain/verify', requirePermission('marketing.update'), wrap(async (_req, res) => {
  res.json({ success: true, data: await siteService.verifyDomain() });
}));

sitesRoutes.delete('/domain', requirePermission('marketing.update'), wrap(async (_req, res) => {
  res.json({ success: true, data: await siteService.disconnectDomain() });
}));

sitesRoutes.post('/ai-generate', requirePermission('marketing.update'), validate({ body: z.object({ prompt: z.string().trim().min(3).max(1000) }) }), wrap(async (req, res) => {
  res.json({ success: true, data: await siteService.aiGenerate(req.body.prompt) });
}));

// Pages
sitesRoutes.post('/pages', requirePermission('marketing.create'), validate({ body: pageSchema }), wrap(async (req, res) => {
  res.status(201).json({ success: true, data: await siteService.createPage(req.body) });
}));

sitesRoutes.patch('/pages/:id', requirePermission('marketing.update'), validate({ body: pageSchema.partial() }), wrap(async (req, res) => {
  res.json({ success: true, data: await siteService.updatePage(req.params.id as string, req.body) });
}));

sitesRoutes.delete('/pages/:id', requirePermission('marketing.delete'), wrap(async (req, res) => {
  res.json({ success: true, data: await siteService.deletePage(req.params.id as string) });
}));

// Version history
sitesRoutes.get('/versions', requirePermission('marketing.read'), wrap(async (_req, res) => {
  res.json({ success: true, data: await siteService.listVersions() });
}));

sitesRoutes.post('/versions', requirePermission('marketing.update'), validate({ body: z.object({ label: z.string().trim().min(1).max(80) }) }), wrap(async (req, res) => {
  res.status(201).json({ success: true, data: await siteService.snapshotVersion(req.body.label) });
}));

sitesRoutes.post('/versions/:id/restore', requirePermission('marketing.update'), wrap(async (req, res) => {
  res.json({ success: true, data: await siteService.restoreVersion(req.params.id as string) });
}));
