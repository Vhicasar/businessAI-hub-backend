import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import { billingService, checkoutSchema } from '../../../application/billing/billing.service';
import { syncPlansFromAdmin } from '../../../application/billing/plan-sync';
import { smsWalletService } from '../../../application/billing/sms-wallet.service';
import { addOnsService, addOnCheckoutSchema } from '../../../application/billing/add-ons.service';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

export const billingRoutes = Router();
billingRoutes.use(authenticate, requireTenant);

/** Public plan catalog — any authenticated member can view upgrade options. */
billingRoutes.get(
  '/plans',
  wrap(async (_req, res) => {
    res.json({ success: true, data: await billingService.listPlans() });
  })
);

billingRoutes.get(
  '/sms-wallet',
  requirePermission('billing.view'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await smsWalletService.summary() });
  })
);

billingRoutes.get('/add-ons', requirePermission('billing.view'), wrap(async (_req, res) => {
  res.json({ success: true, data: await addOnsService.list() });
}));

billingRoutes.post('/add-ons/checkout', requirePermission('billing.manage'), validate({ body: addOnCheckoutSchema }), wrap(async (req, res) => {
  res.json({ success: true, data: await addOnsService.checkout(req.body.addOnId) });
}));

billingRoutes.post(
  '/sms-wallet/checkout',
  requirePermission('billing.manage'),
  validate({ body: z.object({ packageId: z.string().min(1) }) }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await smsWalletService.checkout(req.body.packageId) });
  })
);

billingRoutes.get(
  '/sms-wallet/verify',
  requirePermission('billing.manage'),
  validate({ query: z.object({ reference: z.string().min(1) }) }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await smsWalletService.verifyPurchase(req.query.reference as string) });
  })
);

/** Pull the latest pricing/limits from the Vhicasar Admin on demand. */
billingRoutes.post(
  '/sync-plans',
  requirePermission('billing.manage'),
  wrap(async (_req, res) => {
    const result = await syncPlansFromAdmin();
    res.json({ success: true, data: result ?? { synced: 0, note: 'admin sync disabled or unreachable' } });
  })
);

/** Current subscription, plan, and live usage vs limits. */
billingRoutes.get(
  '/summary',
  requirePermission('billing.view'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await billingService.getSummary() });
  })
);

/** Payment history (paid billing records). */
billingRoutes.get(
  '/history',
  requirePermission('billing.view'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await billingService.history() });
  })
);

/** Start a plan change — returns a Paystack checkout URL (or activates free). */
billingRoutes.post(
  '/checkout',
  requirePermission('billing.manage'),
  validate({ body: checkoutSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await billingService.checkout(req.body) });
  })
);

/** Verify a Paystack transaction (browser callback) and activate the plan. */
billingRoutes.get(
  '/verify',
  requirePermission('billing.manage'),
  validate({ query: z.object({ reference: z.string().min(1) }) }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await billingService.verifyReference(req.query.reference as string) });
  })
);

/** Schedule cancellation at period end. */
billingRoutes.post(
  '/cancel',
  requirePermission('billing.manage'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await billingService.cancel() });
  })
);

/** Undo a scheduled cancellation. */
billingRoutes.post(
  '/resume',
  requirePermission('billing.manage'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await billingService.resume() });
  })
);
