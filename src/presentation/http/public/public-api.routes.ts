import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { apiKeyAuth, requireScope } from '../middleware/api-key-auth';
import { validate } from '../middleware/validate';
import { prisma } from '../../../infrastructure/database/prisma';
import { customersService } from '../../../application/customers/customers.service';
import { createCustomerSchema, updateCustomerSchema } from '../../../application/customers/customers.dto';
import { ordersService } from '../../../application/orders/orders.service';
import { createOrderSchema, refundOrderSchema } from '../../../application/orders/orders.dto';
import { aiService } from '../../../application/ai/ai.service';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

const clampLimit = (v: unknown, def = 50) => Math.min(100, Math.max(1, Number(v) || def));

/**
 * Public REST API for a business's own integrations, authenticated by API key
 * (not a user session). Every route is scope-gated and per-key rate-limited.
 * Base path: /api/public/v1
 */
export const publicApiRoutes = Router();

// Per-key rate limit (falls back to IP if somehow unauthenticated).
publicApiRoutes.use(
  rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.apiKey?.keyId ?? req.ip ?? 'anon',
    message: { success: false, error: { code: 'RATE_LIMITED', message: 'API rate limit exceeded (120/min)' } },
  })
);
publicApiRoutes.use(apiKeyAuth);

/** Identify the calling key — handy for testing an integration. */
publicApiRoutes.get(
  '/me',
  wrap(async (req, res) => {
    res.json({ success: true, data: { organizationId: req.apiKey!.organizationId, scopes: req.apiKey!.scopes } });
  })
);

// ── Customers ──────────────────────────────────────────────────────────────
publicApiRoutes.get(
  '/customers',
  requireScope('customers.read'),
  wrap(async (req, res) => {
    const rows = await prisma.customer.findMany({
      where: {
        deletedAt: null,
        ...(req.query.search
          ? { OR: [
              { firstName: { contains: String(req.query.search), mode: 'insensitive' as const } },
              { email: { contains: String(req.query.search), mode: 'insensitive' as const } },
            ] }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: clampLimit(req.query.limit),
      select: { id: true, firstName: true, lastName: true, email: true, phone: true, createdAt: true },
    });
    res.json({ success: true, data: rows });
  })
);

publicApiRoutes.get(
  '/customers/:id',
  requireScope('customers.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await customersService.get(req.params.id as string) });
  })
);

publicApiRoutes.post(
  '/customers',
  requireScope('customers.write'),
  validate({ body: createCustomerSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await customersService.create(req.body) });
  })
);

publicApiRoutes.put(
  '/customers/:id',
  requireScope('customers.write'),
  validate({ body: updateCustomerSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await customersService.update(req.params.id as string, req.body) });
  })
);

publicApiRoutes.delete(
  '/customers/:id',
  requireScope('customers.write'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await customersService.remove(req.params.id as string) });
  })
);

// ── Products ───────────────────────────────────────────────────────────────
publicApiRoutes.get(
  '/products',
  requireScope('catalog.read'),
  wrap(async (req, res) => {
    const rows = await prisma.product.findMany({
      where: {
        deletedAt: null,
        ...(req.query.search ? { name: { contains: String(req.query.search), mode: 'insensitive' as const } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: clampLimit(req.query.limit),
      select: {
        id: true, name: true, status: true,
        variants: { where: { deletedAt: null }, select: { id: true, sku: true, name: true, price: true, currency: true } },
      },
    });
    res.json({ success: true, data: rows });
  })
);

// ── Orders ─────────────────────────────────────────────────────────────────
publicApiRoutes.get(
  '/orders',
  requireScope('orders.read'),
  wrap(async (req, res) => {
    const rows = await prisma.order.findMany({
      orderBy: { createdAt: 'desc' },
      take: clampLimit(req.query.limit),
      select: { id: true, number: true, status: true, total: true, currency: true, source: true, createdAt: true },
    });
    res.json({ success: true, data: rows });
  })
);

publicApiRoutes.get(
  '/products/:id',
  requireScope('catalog.read'),
  wrap(async (req, res) => {
    const product = await prisma.product.findFirst({
      where: { id: req.params.id as string, deletedAt: null },
      select: {
        id: true, name: true, description: true, status: true,
        variants: { where: { deletedAt: null }, select: { id: true, sku: true, name: true, price: true, currency: true, costPrice: true } },
      },
    });
    if (!product) { res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Product not found' } }); return; }
    res.json({ success: true, data: product });
  })
);

publicApiRoutes.get(
  '/orders/:id',
  requireScope('orders.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await ordersService.get(req.params.id as string) });
  })
);

publicApiRoutes.post(
  '/orders',
  requireScope('orders.write'),
  validate({ body: createOrderSchema }),
  wrap(async (req, res) => {
    // No acting member for a key-authenticated call.
    res.status(201).json({ success: true, data: await ordersService.create({ ...req.body, source: 'API' }, null) });
  })
);

/** Refund an order (marks it refunded + fires notifications). */
publicApiRoutes.post(
  '/orders/:id/refund',
  requireScope('orders.write'),
  validate({ body: refundOrderSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await ordersService.refund(req.params.id as string, req.body, req.apiKey!.keyId) });
  })
);

// ── AI ─────────────────────────────────────────────────────────────────────
/** Ask the workspace AI assistant a question grounded in your business data. */
publicApiRoutes.post(
  '/ai/assist',
  requireScope('ai.use'),
  validate({ body: z.object({ prompt: z.string().trim().min(1).max(2000) }) }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await aiService.workspaceAssistant(req.body.prompt) });
  })
);

/** AI summary of a customer (recent activity, orders, sentiment). */
publicApiRoutes.post(
  '/ai/customers/:id/summary',
  requireScope('ai.use'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await aiService.summarizeCustomer(req.params.id as string) });
  })
);

/** AI lead score (0–100) with a rationale. */
publicApiRoutes.post(
  '/ai/leads/:id/score',
  requireScope('ai.use'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await aiService.scoreLead(req.params.id as string) });
  })
);
