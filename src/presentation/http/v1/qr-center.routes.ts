import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';

import { validate } from '../middleware/validate';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import { qrCenter, QR_TEMPLATES } from '../../../application/discovery/qr-center.service';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

const QR_KINDS = [
  'PERMANENT',
  'BRANCH',
  'EVENT',
  'REFERRAL',
  'CAMPAIGN',
  'EMPLOYEE',
  'TABLE',
  'PROPERTY',
  'PRODUCT',
] as const;

const TEMPLATE_KEYS = Object.keys(QR_TEMPLATES) as [keyof typeof QR_TEMPLATES];

/**
 * Business QR Center (§6). Mounted at /api/v1/qr-center.
 *
 * The older /business-profile/qr endpoints still work unchanged — this is an
 * additive surface, not a replacement, so existing clients keep functioning.
 */
export const qrCenterRoutes = Router();
qrCenterRoutes.use(authenticate, requireTenant);

/** Every code with its scan/join performance, plus the print templates. */
qrCenterRoutes.get(
  '/',
  validate({
    query: z.object({
      kind: z.enum(QR_KINDS).optional(),
      branchId: z.string().trim().optional(),
      includeInactive: z.coerce.boolean().default(false),
    }),
  }),
  wrap(async (req, res) => {
    const q = req.query as unknown as Parameters<typeof qrCenter.list>[0];
    res.json({ success: true, data: await qrCenter.list(q) });
  })
);

qrCenterRoutes.post(
  '/',
  requirePermission('settings.manage_org'),
  validate({
    body: z.object({
      kind: z.enum(QR_KINDS).default('PERMANENT'),
      label: z.string().trim().max(80).optional(),
      branchId: z.string().trim().optional(),
      /** Employee / table / property / product this code belongs to. */
      subjectId: z.string().trim().max(60).optional(),
      subjectLabel: z.string().trim().max(120).optional(),
      campaignId: z.string().trim().optional(),
      referrerCustomerId: z.string().trim().optional(),
      expiresAt: z.coerce.date().optional(),
      maxScans: z.coerce.number().int().positive().optional(),
    }),
  }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, message: 'QR code created.', data: await qrCenter.create(req.body) });
  })
);

/** Retire a code and mint a replacement that keeps its settings. */
qrCenterRoutes.post(
  '/:id/regenerate',
  requirePermission('settings.manage_org'),
  wrap(async (req, res) => {
    const data = await qrCenter.regenerate(req.params.id as string);
    res.status(201).json({ success: true, message: 'QR code regenerated.', data });
  })
);

/** Disable, rename, expire or cap a code. */
qrCenterRoutes.patch(
  '/:id',
  requirePermission('settings.manage_org'),
  validate({
    body: z.object({
      isActive: z.boolean().optional(),
      label: z.string().trim().max(80).optional(),
      expiresAt: z.coerce.date().nullable().optional(),
      maxScans: z.coerce.number().int().positive().nullable().optional(),
    }),
  }),
  wrap(async (req, res) => {
    res.json({ success: true, message: 'QR code updated.', data: await qrCenter.update(req.params.id as string, req.body) });
  })
);

/**
 * Everything a printable needs — payload, business identity, brand colours and
 * the physical dimensions for the chosen format.
 */
qrCenterRoutes.get(
  '/:id/printable',
  validate({ query: z.object({ template: z.enum(TEMPLATE_KEYS).default('A4') }) }),
  wrap(async (req, res) => {
    const { template } = req.query as unknown as { template: keyof typeof QR_TEMPLATES };
    res.json({ success: true, data: await qrCenter.printable(req.params.id as string, template) });
  })
);

/** Scans, joins and conversion rate, for one code or the whole organization. */
qrCenterRoutes.get(
  '/analytics',
  validate({
    query: z.object({
      qrId: z.string().trim().optional(),
      days: z.coerce.number().int().min(1).max(365).default(30),
    }),
  }),
  wrap(async (req, res) => {
    const q = req.query as unknown as { qrId?: string; days: number };
    res.json({ success: true, data: await qrCenter.analytics(q) });
  })
);
