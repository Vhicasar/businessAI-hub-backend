import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import { validate } from '../middleware/validate';
import { requestContext } from '../../../shared/context';
import { prisma } from '../../../infrastructure/database/prisma';
import { NotFoundError } from '../../../shared/errors';
import {
  paymentIntentService,
  publicPayUrl,
} from '../../../application/payments/payment-intent.service';
import { createIntentForResource } from '../../../application/payments/payment-request.service';

/**
 * Business-side payment intents (§1).
 *
 * One set of endpoints for every payable thing. Orders, invoices, deals,
 * property and chat all raise a request here instead of each having their own
 * "collect money" endpoint.
 */
export const paymentIntentRoutes = Router();
paymentIntentRoutes.use(authenticate, requireTenant);

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

function orgId(): string {
  const id = requestContext.get()?.organizationId;
  if (!id) throw new Error('No tenant in request context');
  return id;
}

const RESOURCES = [
  'ORDER',
  'INVOICE',
  'DEAL',
  'PROPERTY',
  'PROPERTY_RESERVATION',
  'BOOKING',
  'SUBSCRIPTION',
  'DEPOSIT',
  'QUOTATION',
  'RENT',
  'INSPECTION_FEE',
  'COMMISSION',
  'INSTALMENT',
  'POS',
  'CUSTOM',
] as const;

const createSchema = z.object({
  resourceType: z.enum(RESOURCES),
  resourceId: z.string().trim().max(60).optional(),
  customerId: z.string().trim().max(60).optional(),
  /**
   * Only honoured for CUSTOM and DEPOSIT. Everything else takes its amount
   * from the record being paid, so a client cannot ask a customer for less
   * than an order is worth.
   */
  amount: z.number().positive().max(1_000_000_000).optional(),
  currency: z.string().trim().length(3).optional(),
  description: z.string().trim().max(500).optional(),
  allowPartial: z.boolean().optional(),
  expiryMinutes: z.number().int().min(0).max(129_600).optional(),
  channel: z.string().trim().max(20).optional(),
});

paymentIntentRoutes.post(
  '/',
  requirePermission('payments.request'),
  validate({ body: createSchema }),
  wrap(async (req, res) => {
    const body = req.body as z.infer<typeof createSchema>;
    const intent = await createIntentForResource({
      organizationId: orgId(),
      ...body,
      createdById: requestContext.get()?.membershipId ?? null,
      channel: body.channel ?? 'WEB',
    });
    res.status(201).json({
      success: true,
      data: { ...intent, payUrl: intent.token ? publicPayUrl(intent.token) : null },
    });
  })
);

paymentIntentRoutes.get(
  '/',
  requirePermission('payments.read', 'payments.history'),
  validate({
    query: z.object({
      status: z.string().optional(),
      customerId: z.string().optional(),
      resourceType: z.string().optional(),
      resourceId: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }),
  }),
  wrap(async (req, res) => {
    const q = req.query as unknown as Record<string, string> & { limit: number };
    const rows = await prisma.paymentIntent.findMany({
      where: {
        ...(q.status ? { status: q.status as never } : {}),
        ...(q.customerId ? { customerId: q.customerId } : {}),
        ...(q.resourceType ? { resourceType: q.resourceType as never } : {}),
        ...(q.resourceId ? { resourceId: q.resourceId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: q.limit,
    });
    res.json({
      success: true,
      data: rows.map((r) => ({ ...r, payUrl: r.token ? publicPayUrl(r.token) : null })),
    });
  })
);

paymentIntentRoutes.get(
  '/:id',
  requirePermission('payments.read'),
  wrap(async (req, res) => {
    const intent = await prisma.paymentIntent.findUnique({
      where: { id: req.params.id as string },
      include: { transactions: { orderBy: { createdAt: 'desc' } } },
    });
    if (!intent) throw new NotFoundError('Payment');
    res.json({
      success: true,
      data: {
        ...intent,
        payUrl: intent.token ? publicPayUrl(intent.token) : null,
        outstanding: paymentIntentService.outstanding(intent),
      },
    });
  })
);

paymentIntentRoutes.post(
  '/:id/cancel',
  requirePermission('payments.cancel'),
  wrap(async (req, res) => {
    const data = await paymentIntentService.cancel(req.params.id as string, orgId());
    res.json({ success: true, message: 'Payment request cancelled.', data });
  })
);
