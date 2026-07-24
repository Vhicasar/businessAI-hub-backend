import { Router, type Request, type RequestHandler, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { apiKeyAuth, requireScope } from '../middleware/api-key-auth';
import { validate } from '../middleware/validate';
import { prisma } from '../../../infrastructure/database/prisma';
import { customersService } from '../../../application/customers/customers.service';
import { createCustomerSchema } from '../../../application/customers/customers.dto';
import { ordersService } from '../../../application/orders/orders.service';
import { createOrderSchema } from '../../../application/orders/orders.dto';

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

publicApiRoutes.post(
  '/customers',
  requireScope('customers.write'),
  validate({ body: createCustomerSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await customersService.create(req.body) });
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

publicApiRoutes.post(
  '/orders',
  requireScope('orders.write'),
  validate({ body: createOrderSchema }),
  wrap(async (req, res) => {
    // No acting member for a key-authenticated call.
    res.status(201).json({ success: true, data: await ordersService.create({ ...req.body, source: 'API' }, null) });
  })
);
