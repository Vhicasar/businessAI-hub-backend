import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import {
  invoiceSettingsSchema,
  orderNotificationsSchema,
  organizationSchema,
  settingsService,
} from '../../../application/settings/settings.service';
import {
  paymentAccountSchema,
  orgPaymentAccountService,
} from '../../../application/payments/org-account.service';
import { getWorkspaceConfig } from '../../../application/settings/workspace-config';
import { addressBook } from '../../../application/settings/address-book.service';

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

/**
 * Admin-synced workspace config (feature flags, communication, storage,
 * integration toggles) so the web can gate UI the same way the backend gates
 * behaviour. Any authenticated member may read it — it is non-secret.
 */
settingsRoutes.get(
  '/workspace-config',
  wrap(async (_req, res) => {
    res.json({ success: true, data: getWorkspaceConfig() });
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

// Order/payment notification recipients. Read needs order visibility; writing
// is an org-management action.
settingsRoutes.get(
  '/order-notifications',
  requirePermission('orders.read', 'settings.manage_org'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await settingsService.getOrderNotifications() });
  })
);
settingsRoutes.put(
  '/order-notifications',
  requirePermission('settings.manage_org'),
  validate({ body: orderNotificationsSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await settingsService.saveOrderNotifications(req.body) });
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

// Per-organization payment gateway (#13): the tenant's own Paystack/Flutterwave
// account for customer collections. Secret-free reads; org-management writes.
settingsRoutes.get(
  '/payment-account',
  requirePermission('settings.manage_org'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await orgPaymentAccountService.get() });
  })
);
settingsRoutes.put(
  '/payment-account',
  requirePermission('settings.manage_org'),
  validate({ body: paymentAccountSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await orgPaymentAccountService.save(req.body) });
  })
);
settingsRoutes.delete(
  '/payment-account',
  requirePermission('settings.manage_org'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await orgPaymentAccountService.remove() });
  })
);

/**
 * Places this business already uses — cities, states and countries drawn from
 * its own customers, suppliers, warehouses and branches.
 *
 * Address autofill without an external geocoder. A business enters the same
 * handful of cities over and over, so its own records are both the most
 * accurate source and the one that needs no third-party key, no per-lookup
 * cost, and no customer address leaving the platform to be completed.
 */
settingsRoutes.get(
  '/address-book',
  requirePermission('customers.read', 'suppliers.read', 'inventory.read'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await addressBook() });
  })
);
