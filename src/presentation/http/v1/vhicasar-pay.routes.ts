import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import { payoutService } from '../../../application/payments/payout.service';
import { payoutAccountSchema } from '../../../application/identity/identity.dto';
import { vhicasarPayService } from '../../../application/payments/vhicasar-pay.service';
import {
  createSessionSchema,
  createSettlementSchema,
  openChargebackSchema,
} from '../../../application/payments/vhicasar-pay.dto';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

const listQuery = z.object({
  currency: z.string().trim().length(3).toUpperCase().default('NGN'),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

/**
 * Merchant (Business Admin) side of Vhicasar Pay. Mounted at /api/v1/pay.
 * Gated by dedicated `vhicasar_pay.*` permissions (granted to system roles at
 * boot by reconcileSystemRolePermissions).
 */
export const vhicasarPayRoutes = Router();

vhicasarPayRoutes.use(authenticate, requireTenant);

/** Create a one-time, expiring, signed payment session (dynamic QR). */
vhicasarPayRoutes.post(
  '/sessions',
  requirePermission('vhicasar_pay.session_create'),
  validate({ body: createSessionSchema }),
  wrap(async (req, res) => {
    const data = await vhicasarPayService.createSession(req.body, req.auth!.membershipId);
    res.status(201).json({ success: true, data });
  })
);

vhicasarPayRoutes.get(
  '/sessions/:id',
  requirePermission('vhicasar_pay.read'),
  wrap(async (req, res) => {
    const data = await vhicasarPayService.getSession(req.params.id as string);
    res.json({ success: true, data });
  })
);

vhicasarPayRoutes.post(
  '/sessions/:id/cancel',
  requirePermission('vhicasar_pay.session_cancel'),
  wrap(async (req, res) => {
    const data = await vhicasarPayService.cancelSession(req.params.id as string);
    res.json({ success: true, data });
  })
);

vhicasarPayRoutes.get(
  '/wallet',
  requirePermission('vhicasar_pay.read'),
  validate({ query: listQuery }),
  wrap(async (req, res) => {
    const data = await vhicasarPayService.merchantWallet((req.query.currency as string) ?? 'NGN');
    res.json({ success: true, data });
  })
);

vhicasarPayRoutes.get(
  '/settlements',
  requirePermission('vhicasar_pay.read'),
  validate({ query: listQuery }),
  wrap(async (req, res) => {
    const q = req.query as unknown as { cursor?: string; limit: number };
    const data = await vhicasarPayService.listSettlements({ cursor: q.cursor, limit: q.limit });
    res.json({ success: true, data });
  })
);

vhicasarPayRoutes.post(
  '/settlements',
  requirePermission('vhicasar_pay.settle'),
  validate({ body: createSettlementSchema }),
  wrap(async (req, res) => {
    const data = await vhicasarPayService.createSettlement(req.body);
    res.status(201).json({ success: true, data });
  })
);

vhicasarPayRoutes.post(
  '/chargebacks',
  requirePermission('vhicasar_pay.chargeback'),
  validate({ body: openChargebackSchema }),
  wrap(async (req, res) => {
    const data = await vhicasarPayService.openChargeback(req.body);
    res.status(201).json({ success: true, data });
  })
);

// ---- Merchant payout destinations + settlement disbursement ----

vhicasarPayRoutes.get(
  '/payouts/banks',
  requirePermission('vhicasar_pay.payout_account'),
  wrap(async (req, res) => {
    const country = typeof req.query.country === 'string' ? req.query.country : undefined;
    res.json({ success: true, data: await payoutService.listBanks(country) });
  })
);

vhicasarPayRoutes.get(
  '/payouts/accounts',
  requirePermission('vhicasar_pay.read'),
  wrap(async (req, res) => {
    const data = await payoutService.listAccounts({ organizationId: req.auth!.organizationId as string });
    res.json({ success: true, data });
  })
);

vhicasarPayRoutes.post(
  '/payouts/accounts',
  requirePermission('vhicasar_pay.payout_account'),
  validate({ body: payoutAccountSchema }),
  wrap(async (req, res) => {
    const data = await payoutService.addAccount({ organizationId: req.auth!.organizationId as string }, req.body);
    res.status(201).json({ success: true, message: 'Payout account added.', data });
  })
);

vhicasarPayRoutes.post(
  '/payouts/accounts/:id/default',
  requirePermission('vhicasar_pay.payout_account'),
  wrap(async (req, res) => {
    await payoutService.setDefault({ organizationId: req.auth!.organizationId as string }, req.params.id as string);
    res.json({ success: true, data: { message: 'Default payout account updated' } });
  })
);

vhicasarPayRoutes.delete(
  '/payouts/accounts/:id',
  requirePermission('vhicasar_pay.payout_account'),
  wrap(async (req, res) => {
    await payoutService.removeAccount({ organizationId: req.auth!.organizationId as string }, req.params.id as string);
    res.json({ success: true, data: { message: 'Payout account removed' } });
  })
);

/** Disburse a pending settlement to the merchant's bank account. */
vhicasarPayRoutes.post(
  '/settlements/:id/payout',
  requirePermission('vhicasar_pay.payout'),
  validate({ body: z.object({ payoutAccountId: z.string().trim().optional() }) }),
  wrap(async (req, res) => {
    const data = await payoutService.payoutSettlement(
      req.auth!.organizationId as string,
      req.params.id as string,
      req.body.payoutAccountId
    );
    res.status(201).json({ success: true, message: 'Payout started.', data });
  })
);

vhicasarPayRoutes.get(
  '/payouts',
  requirePermission('vhicasar_pay.read'),
  wrap(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    const data = await payoutService.listPayouts(
      { organizationId: req.auth!.organizationId as string },
      { cursor, limit }
    );
    res.json({ success: true, data });
  })
);
