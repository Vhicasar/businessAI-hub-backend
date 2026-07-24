import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import { validate } from '../middleware/validate';
import { designService, createDesignSchema, updateDesignSchema } from '../../../application/marketing/design.service';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

/** Marketing visual-editor designs. */
export const designsRoutes = Router();
designsRoutes.use(authenticate, requireTenant);

designsRoutes.get('/', requirePermission('marketing.read'), wrap(async (_req, res) => {
  res.json({ success: true, data: await designService.list() });
}));

designsRoutes.post('/', requirePermission('marketing.create'), validate({ body: createDesignSchema }), wrap(async (req, res) => {
  res.status(201).json({ success: true, data: await designService.create(req.body) });
}));

designsRoutes.get('/:id', requirePermission('marketing.read'), wrap(async (req, res) => {
  res.json({ success: true, data: await designService.get(req.params.id as string) });
}));

designsRoutes.patch('/:id', requirePermission('marketing.update'), validate({ body: updateDesignSchema }), wrap(async (req, res) => {
  res.json({ success: true, data: await designService.update(req.params.id as string, req.body) });
}));

designsRoutes.delete('/:id', requirePermission('marketing.delete'), wrap(async (req, res) => {
  res.json({ success: true, data: await designService.remove(req.params.id as string) });
}));

designsRoutes.post('/:id/ai', requirePermission('marketing.update'), validate({ body: z.object({ prompt: z.string().trim().min(3).max(1000) }) }), wrap(async (req, res) => {
  res.json({ success: true, data: await designService.aiGenerate(req.params.id as string, req.body.prompt) });
}));
