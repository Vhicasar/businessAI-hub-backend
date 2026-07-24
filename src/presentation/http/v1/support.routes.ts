import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import {
  commentSchema,
  createTicketSchema,
  listTicketsSchema,
  routingConfigSchema,
  slaPolicySchema,
  supportService,
  updateTicketSchema,
} from '../../../application/support/support.service';
import {
  categorySchema,
  createArticleSchema,
  kbService,
  listArticlesSchema,
  updateArticleSchema,
} from '../../../application/support/kb.service';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

export const supportRoutes = Router();
supportRoutes.use(authenticate, requireTenant);

supportRoutes.get(
  '/tickets',
  requirePermission('support.read'),
  validate({ query: listTicketsSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await supportService.list(req.query as never) });
  })
);

supportRoutes.post(
  '/tickets',
  requirePermission('support.create'),
  validate({ body: createTicketSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await supportService.create(req.body) });
  })
);

supportRoutes.get(
  '/tickets/:id',
  requirePermission('support.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await supportService.get(req.params.id as string) });
  })
);

supportRoutes.patch(
  '/tickets/:id',
  requirePermission('support.update'),
  validate({ body: updateTicketSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await supportService.update(req.params.id as string, req.body) });
  })
);

supportRoutes.post(
  '/tickets/:id/escalate',
  requirePermission('support.escalate', 'support.update'),
  validate({ body: z.object({ note: z.string().trim().max(500).optional() }) }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await supportService.escalate(req.params.id as string, req.body.note) });
  })
);

// auto-create a ticket from an inbox conversation (AI summary/sentiment applied)
supportRoutes.post(
  '/tickets/from-conversation/:conversationId',
  requirePermission('support.create'),
  wrap(async (req, res) => {
    res.status(201).json({
      success: true,
      data: await supportService.createFromConversation(req.params.conversationId as string),
    });
  })
);

supportRoutes.post(
  '/tickets/escalate-overdue',
  requirePermission('support.escalate', 'support.update'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await supportService.escalateOverdue() });
  })
);

// -------------------------------------------------------- SLA policies
supportRoutes.get(
  '/sla-policies',
  requirePermission('support.read'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await supportService.listSlaPolicies() });
  })
);
supportRoutes.post(
  '/sla-policies',
  requirePermission('support.manage_sla'),
  validate({ body: slaPolicySchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await supportService.createSlaPolicy(req.body) });
  })
);
supportRoutes.patch(
  '/sla-policies/:id',
  requirePermission('support.manage_sla'),
  validate({ body: slaPolicySchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await supportService.updateSlaPolicy(req.params.id as string, req.body) });
  })
);
supportRoutes.delete(
  '/sla-policies/:id',
  requirePermission('support.manage_sla'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await supportService.deleteSlaPolicy(req.params.id as string) });
  })
);

// -------------------------------------------------------- routing rules
supportRoutes.get(
  '/members',
  requirePermission('support.read'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await supportService.listMembers() });
  })
);

supportRoutes.get(
  '/routing',
  requirePermission('support.read'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await supportService.getRouting() });
  })
);
supportRoutes.put(
  '/routing',
  requirePermission('support.manage_sla', 'support.assign'),
  validate({ body: routingConfigSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await supportService.saveRouting(req.body) });
  })
);

// ticket conversation thread
supportRoutes.post(
  '/tickets/:id/comments',
  requirePermission('support.update'),
  validate({ body: commentSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await supportService.addComment(req.params.id as string, req.body) });
  })
);

// -------------------------------------------------------- knowledge base
supportRoutes.get(
  '/kb/categories',
  requirePermission('support.read'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await kbService.listCategories() });
  })
);
supportRoutes.post(
  '/kb/categories',
  requirePermission('support.update'),
  validate({ body: categorySchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await kbService.createCategory(req.body) });
  })
);
supportRoutes.delete(
  '/kb/categories/:id',
  requirePermission('support.update'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await kbService.deleteCategory(req.params.id as string) });
  })
);

supportRoutes.get(
  '/kb/suggest',
  requirePermission('support.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await kbService.suggest(String(req.query.q ?? '')) });
  })
);
supportRoutes.get(
  '/kb/articles',
  requirePermission('support.read'),
  validate({ query: listArticlesSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await kbService.listArticles(req.query as never) });
  })
);
supportRoutes.post(
  '/kb/articles',
  requirePermission('support.update'),
  validate({ body: createArticleSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await kbService.createArticle(req.body) });
  })
);
supportRoutes.get(
  '/kb/articles/:id',
  requirePermission('support.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await kbService.getArticle(req.params.id as string, true) });
  })
);
supportRoutes.patch(
  '/kb/articles/:id',
  requirePermission('support.update'),
  validate({ body: updateArticleSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await kbService.updateArticle(req.params.id as string, req.body) });
  })
);
supportRoutes.delete(
  '/kb/articles/:id',
  requirePermission('support.update'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await kbService.deleteArticle(req.params.id as string) });
  })
);
