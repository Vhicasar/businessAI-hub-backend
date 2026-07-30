import { Router, type Request, type RequestHandler, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import { aiService } from '../../../application/ai/ai.service';
import { orgAiAccountService, aiAccountSchema } from '../../../application/ai/org-ai.service';
import { getAiStatus } from '../../../infrastructure/ai';
import { syncAiConfigFromAdmin } from '../../../application/ai/ai-sync';
import { requireFeature } from '../middleware/plan-guard';
import { z } from 'zod';
import { validate } from '../middleware/validate';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

/** LLM calls are comparatively expensive — tighter limit than the global API. */
const aiLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many AI requests, slow down a little' },
  },
});

export const aiRoutes = Router();
aiRoutes.use(authenticate, requireTenant, aiLimiter);

aiRoutes.get(
  '/status',
  requirePermission('ai.use_assistant'),
  wrap(async (_req, res) => {
    // Reports the active provider/model and whether it came from the admin.
    res.json({ success: true, data: getAiStatus() });
  })
);

/** Pull the latest AI config from the Vhicasar Admin now (else it refreshes periodically). */
aiRoutes.post(
  '/sync',
  requirePermission('ai.use_assistant'),
  wrap(async (_req, res) => {
    const applied = await syncAiConfigFromAdmin();
    res.json({ success: true, data: { applied, ...getAiStatus() } });
  })
);

/**
 * Per-workspace "bring your own key" AI provider (#13). When enabled, the
 * workspace's AI runs on the tenant's own key and its usage counts against the
 * tenant's own provider account instead of the Vhicasar Hub plan quota.
 */
aiRoutes.get(
  '/provider',
  requirePermission('ai.configure'),
  wrap(async (_req, res) => { res.json({ success: true, data: await orgAiAccountService.get() }); }),
);
aiRoutes.put(
  '/provider',
  requirePermission('ai.configure'),
  validate({ body: aiAccountSchema }),
  wrap(async (req, res) => { res.json({ success: true, data: await orgAiAccountService.save(req.body) }); }),
);
aiRoutes.delete(
  '/provider',
  requirePermission('ai.configure'),
  wrap(async (_req, res) => { res.json({ success: true, data: await orgAiAccountService.remove() }); }),
);

aiRoutes.post(
  '/assistant',
  requirePermission('ai.use_assistant'),
  validate({
    body: z.object({
      prompt: z.string().trim().min(1).max(2_000),
      currentPath: z.string().max(300).optional(),
      history: z.array(z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().max(4_000),
      })).max(20).default([]),
    }),
  }),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await aiService.workspaceAssistant(req.body.prompt, req.body.history, req.body.currentPath),
    });
  }),
);

aiRoutes.post(
  '/conversations/:id/summarize',
  requirePermission('ai.use_assistant', 'inbox.read'),
  requireFeature('ai_insights'),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await aiService.summarizeConversation(req.params.id as string),
    });
  })
);

aiRoutes.post(
  '/conversations/:id/suggest-reply',
  requirePermission('ai.use_assistant', 'inbox.reply'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await aiService.suggestReply(req.params.id as string) });
  })
);

aiRoutes.post(
  '/customers/:id/summarize',
  requirePermission('ai.use_assistant', 'customers.read'),
  requireFeature('ai_insights'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await aiService.summarizeCustomer(req.params.id as string) });
  })
);

aiRoutes.post(
  '/leads/:id/score',
  requirePermission('ai.use_assistant', 'crm.update'),
  requireFeature('ai_insights'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await aiService.scoreLead(req.params.id as string) });
  })
);

aiRoutes.post(
  '/deals/:id/score',
  requirePermission('ai.use_assistant', 'crm.update'),
  requireFeature('ai_insights'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await aiService.scoreDeal(req.params.id as string) });
  })
);

aiRoutes.post(
  '/leads/:id/next-action',
  requirePermission('ai.use_assistant', 'crm.read'),
  requireFeature('ai_insights'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await aiService.nextBestAction('LEAD', req.params.id as string) });
  })
);

aiRoutes.post(
  '/deals/:id/next-action',
  requirePermission('ai.use_assistant', 'crm.read'),
  requireFeature('ai_insights'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await aiService.nextBestAction('DEAL', req.params.id as string) });
  })
);

aiRoutes.post(
  '/tickets/:id/summarize',
  requirePermission('ai.use_assistant', 'support.read'),
  requireFeature('ai_insights'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await aiService.summarizeTicket(req.params.id as string) });
  })
);

aiRoutes.post(
  '/tickets/:id/suggest-reply',
  requirePermission('ai.use_assistant', 'support.update'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await aiService.suggestTicketReply(req.params.id as string) });
  })
);

aiRoutes.post(
  '/applicants/:id/score',
  requirePermission('ai.use_assistant', 'employees.update'),
  requireFeature('ai_insights'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await aiService.scoreApplicant(req.params.id as string) });
  })
);
