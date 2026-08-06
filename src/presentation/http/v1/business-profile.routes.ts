import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import { prisma } from '../../../infrastructure/database/prisma';
import { businessDiscovery } from '../../../application/discovery/business-discovery.service';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

/**
 * Merchant control over how their business appears to customers in the Super
 * App, and the QR codes customers scan to join (§2, §3).
 * Mounted at /api/v1/business-profile.
 */
export const businessProfileRoutes = Router();
businessProfileRoutes.use(authenticate, requireTenant);

const profileSchema = z.object({
  handle: z.string().trim().min(3).max(40).regex(/^[a-z0-9-]+$/, 'Use lowercase letters, numbers and dashes').optional(),
  tagline: z.string().trim().max(160).optional(),
  description: z.string().trim().max(4000).optional(),
  coverImageUrl: z.string().trim().max(500).optional(),
  category: z.string().trim().max(60).optional(),
  tags: z.array(z.string().trim().max(40)).max(20).optional(),
  openingHours: z.record(z.string(), z.unknown()).optional(),
  latitude: z.coerce.number().min(-90).max(90).optional(),
  longitude: z.coerce.number().min(-180).max(180).optional(),
  isDiscoverable: z.boolean().optional(),
  allowSelfLeave: z.boolean().optional(),
  acceptsLockedFunds: z.boolean().optional(),
  services: z.array(z.string().trim().max(80)).max(50).optional(),
});

businessProfileRoutes.get(
  '/',
  requirePermission('settings.manage_org'),
  wrap(async (req, res) => {
    const organizationId = req.auth!.organizationId as string;
    const profile = await prisma.businessProfile.findUnique({ where: { organizationId } });
    res.json({ success: true, data: profile });
  })
);

businessProfileRoutes.put(
  '/',
  requirePermission('settings.manage_org'),
  validate({ body: profileSchema }),
  wrap(async (req, res) => {
    const organizationId = req.auth!.organizationId as string;
    const body = req.body as z.infer<typeof profileSchema>;
    const data = await prisma.businessProfile.upsert({
      where: { organizationId },
      create: { organizationId, ...body } as never,
      update: body as never,
    });
    res.json({ success: true, data });
  })
);

// ---- Joining QR codes ----

businessProfileRoutes.get(
  '/qr',
  requirePermission('settings.manage_org'),
  wrap(async (req, res) => {
    const data = await businessDiscovery.listQrs(req.auth!.organizationId as string);
    res.json({ success: true, data });
  })
);

businessProfileRoutes.post(
  '/qr',
  requirePermission('settings.manage_org'),
  validate({
    body: z.object({
      kind: z.enum(['PERMANENT', 'BRANCH', 'EVENT', 'REFERRAL', 'CAMPAIGN']).default('PERMANENT'),
      label: z.string().trim().max(80).optional(),
      branchId: z.string().trim().optional(),
      campaignId: z.string().trim().optional(),
      referrerCustomerId: z.string().trim().optional(),
      expiresAt: z.coerce.date().optional(),
      maxScans: z.coerce.number().int().positive().optional(),
    }),
  }),
  wrap(async (req, res) => {
    const data = await businessDiscovery.createQr(req.auth!.organizationId as string, req.body);
    res.status(201).json({ success: true, data });
  })
);

businessProfileRoutes.delete(
  '/qr/:id',
  requirePermission('settings.manage_org'),
  wrap(async (req, res) => {
    await businessDiscovery.revokeQr(req.params.id as string);
    res.json({ success: true, data: { message: 'QR code revoked' } });
  })
);
