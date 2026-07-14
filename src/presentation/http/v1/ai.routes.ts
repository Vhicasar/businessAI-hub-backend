import { Router, type Request, type RequestHandler, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import { aiService } from '../../../application/ai/ai.service';
import { aiEnabled } from '../../../infrastructure/ai';

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
    res.json({ success: true, data: { enabled: aiEnabled() } });
  })
);

aiRoutes.post(
  '/conversations/:id/summarize',
  requirePermission('ai.use_assistant', 'inbox.read'),
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
  wrap(async (req, res) => {
    res.json({ success: true, data: await aiService.summarizeCustomer(req.params.id as string) });
  })
);

aiRoutes.post(
  '/leads/:id/score',
  requirePermission('ai.use_assistant', 'crm.update'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await aiService.scoreLead(req.params.id as string) });
  })
);
