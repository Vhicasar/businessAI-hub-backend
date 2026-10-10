import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import { validate } from '../middleware/validate';
import {
  aiWebsiteEditSchema, createWebsiteSchema, pageSeoSchema, siteBuilderService, updateWebsitePageSchema, updateWebsiteSchema,
} from '../../../application/sites/site-builder.service';

const wrap = (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => { fn(req, res).catch(next); };

/** Website Builder v2 management API. Every lookup remains tenant-scoped. */
export const sitesRoutes = Router();
sitesRoutes.use(authenticate, requireTenant);

sitesRoutes.get('/', requirePermission('marketing.read'), wrap(async (_req, res) => {
  res.json({ success: true, data: await siteBuilderService.list() });
}));

sitesRoutes.get('/deployment', requirePermission('marketing.read'), wrap(async (_req, res) => {
  res.json({ success: true, data: await siteBuilderService.deploymentInfo() });
}));

sitesRoutes.post('/', requirePermission('marketing.create'), validate({ body: createWebsiteSchema }), wrap(async (req, res) => {
  res.status(201).json({ success: true, data: await siteBuilderService.create(req.body) });
}));

sitesRoutes.get('/:siteId', requirePermission('marketing.read'), wrap(async (req, res) => {
  res.json({ success: true, data: await siteBuilderService.get(req.params.siteId as string) });
}));

sitesRoutes.patch('/:siteId', requirePermission('marketing.update'), validate({ body: updateWebsiteSchema }), wrap(async (req, res) => {
  res.json({ success: true, data: await siteBuilderService.update(req.params.siteId as string, req.body) });
}));

sitesRoutes.post('/:siteId/preview', requirePermission('marketing.read'), wrap(async (req, res) => {
  res.json({ success: true, data: await siteBuilderService.createPreview(req.params.siteId as string) });
}));

sitesRoutes.post('/:siteId/duplicate', requirePermission('marketing.create'), wrap(async (req, res) => {
  res.status(201).json({ success: true, data: await siteBuilderService.duplicate(req.params.siteId as string) });
}));

sitesRoutes.delete('/:siteId', requirePermission('marketing.delete'), wrap(async (req, res) => {
  res.json({ success: true, data: await siteBuilderService.remove(req.params.siteId as string) });
}));

sitesRoutes.post('/:siteId/ai-edit', requirePermission('marketing.update'), validate({ body: aiWebsiteEditSchema }), wrap(async (req, res) => {
  res.json({ success: true, data: await siteBuilderService.aiEdit(req.params.siteId as string, req.body) });
}));

sitesRoutes.get('/:siteId/subdomain-available', requirePermission('marketing.read'), validate({ query: z.object({ value: z.string().trim().min(1).max(32) }) }), wrap(async (req, res) => {
  res.json({ success: true, data: await siteBuilderService.subdomainAvailable(req.params.siteId as string, String(req.query.value)) });
}));

sitesRoutes.post('/:siteId/domain', requirePermission('marketing.update'), validate({ body: z.object({ domain: z.string().trim().min(4).max(253) }) }), wrap(async (req, res) => {
  res.json({ success: true, data: await siteBuilderService.connectDomain(req.params.siteId as string, req.body.domain) });
}));

sitesRoutes.post('/:siteId/domain/verify', requirePermission('marketing.update'), wrap(async (req, res) => {
  res.json({ success: true, data: await siteBuilderService.verifyDomain(req.params.siteId as string) });
}));

sitesRoutes.delete('/:siteId/domain', requirePermission('marketing.update'), wrap(async (req, res) => {
  res.json({ success: true, data: await siteBuilderService.disconnectDomain(req.params.siteId as string) });
}));

sitesRoutes.post('/:siteId/pages', requirePermission('marketing.create'), validate({ body: z.object({ title: z.string().trim().min(1).max(120), slug: z.string().trim().min(1).max(80), seo: pageSeoSchema.nullish().optional() }) }), wrap(async (req, res) => {
  res.status(201).json({ success: true, data: await siteBuilderService.createPage(req.params.siteId as string, req.body) });
}));

sitesRoutes.patch('/:siteId/pages/:pageId', requirePermission('marketing.update'), validate({ body: updateWebsitePageSchema }), wrap(async (req, res) => {
  res.json({ success: true, data: await siteBuilderService.updatePage(req.params.siteId as string, req.params.pageId as string, req.body) });
}));

sitesRoutes.post('/:siteId/pages/:pageId/home', requirePermission('marketing.update'), wrap(async (req, res) => {
  res.json({ success: true, data: await siteBuilderService.setHomepage(req.params.siteId as string, req.params.pageId as string) });
}));

sitesRoutes.delete('/:siteId/pages/:pageId', requirePermission('marketing.delete'), wrap(async (req, res) => {
  res.json({ success: true, data: await siteBuilderService.deletePage(req.params.siteId as string, req.params.pageId as string) });
}));

sitesRoutes.get('/:siteId/versions', requirePermission('marketing.read'), wrap(async (req, res) => {
  res.json({ success: true, data: await siteBuilderService.versions(req.params.siteId as string) });
}));

sitesRoutes.post('/:siteId/versions', requirePermission('marketing.update'), validate({ body: z.object({ label: z.string().trim().min(1).max(80) }) }), wrap(async (req, res) => {
  res.status(201).json({ success: true, data: await siteBuilderService.snapshot(req.params.siteId as string, req.body.label) });
}));

sitesRoutes.post('/:siteId/versions/:versionId/restore', requirePermission('marketing.update'), wrap(async (req, res) => {
  res.json({ success: true, data: await siteBuilderService.restore(req.params.siteId as string, req.params.versionId as string) });
}));

sitesRoutes.post('/:siteId/publish', requirePermission('marketing.update'), validate({ body: z.object({ subdomain: z.string().trim().min(3).max(32) }) }), wrap(async (req, res) => {
  res.json({ success: true, data: await siteBuilderService.publish(req.params.siteId as string, req.body.subdomain) });
}));

sitesRoutes.post('/:siteId/unpublish', requirePermission('marketing.update'), wrap(async (req, res) => {
  res.json({ success: true, data: await siteBuilderService.unpublish(req.params.siteId as string) });
}));

sitesRoutes.get('/:siteId/analytics', requirePermission('analytics.view', 'marketing.read'), validate({ query: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }) }), wrap(async (req, res) => {
  res.json({ success: true, data: await siteBuilderService.analytics(req.params.siteId as string, Number(req.query.days)) });
}));
