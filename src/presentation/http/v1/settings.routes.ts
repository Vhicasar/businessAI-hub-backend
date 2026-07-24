import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import {
  invoiceSettingsSchema,
  organizationSchema,
  settingsService,
} from '../../../application/settings/settings.service';

/** Attach an already-uploaded file as the logo, or null to remove it. */
const logoSchema = z.object({ fileId: z.string().min(1).nullable() });

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

export const settingsRoutes = Router();
settingsRoutes.use(authenticate, requireTenant);

// Anyone who can see money needs to know the currency it's in; changing it is
// an org-management decision.
settingsRoutes.get(
  '/organization',
  wrap(async (_req, res) => {
    res.json({ success: true, data: await settingsService.getOrganization() });
  })
);

settingsRoutes.put(
  '/organization',
  requirePermission('settings.manage_org'),
  validate({ body: organizationSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await settingsService.updateOrganization(req.body) });
  })
);

// The logo file is uploaded via /files first; this attaches its id (or null to
// remove). Owner-only, since the logo is the business's public face.
settingsRoutes.put(
  '/organization/logo',
  requirePermission('settings.manage_org'),
  validate({ body: logoSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await settingsService.setOrganizationLogo(req.body.fileId) });
  })
);

// Read is broad (invoicing/printing needs it); writes require org management.
settingsRoutes.get(
  '/invoicing',
  requirePermission('invoices.read', 'settings.manage_org'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await settingsService.getInvoiceSettings() });
  })
);

settingsRoutes.put(
  '/invoicing',
  requirePermission('settings.manage_org'),
  validate({ body: invoiceSettingsSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await settingsService.saveInvoiceSettings(req.body) });
  })
);
