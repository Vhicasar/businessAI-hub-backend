import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';

import { validate } from '../middleware/validate';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import { settlementAccounts } from '../../../application/payments/settlement-accounts.service';
import { settlementEngine } from '../../../application/payments/settlement-engine.service';
import { payoutService } from '../../../application/payments/payout.service';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

/**
 * Settlement accounts, rules and payouts (§8–§12). Mounted at /api/v1/settlement.
 *
 * Guarded by the existing `vhicasar_pay.*` permissions rather than a new key:
 * settlement *is* the money surface, and whoever may configure payouts is
 * exactly who may change where the money lands.
 */
export const settlementRoutes = Router();
settlementRoutes.use(authenticate, requireTenant);

// ---- Destinations (§8, §9) ----

/** Banks the gateway can pay into, for the account form. */
settlementRoutes.get(
  '/banks',
  validate({ query: z.object({ country: z.string().trim().max(40).optional() }) }),
  wrap(async (req, res) => {
    const items = await payoutService.listBanks(req.query.country as string | undefined);
    res.json({ success: true, data: { items } });
  })
);

settlementRoutes.get(
  '/accounts',
  validate({ query: z.object({ branchId: z.string().trim().optional() }) }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await settlementAccounts.list(req.query as { branchId?: string }) });
  })
);

settlementRoutes.post(
  '/accounts',
  requirePermission('vhicasar_pay.payout_account'),
  validate({
    body: z.object({
      type: z.enum(['BANK_ACCOUNT', 'VIRTUAL_ACCOUNT', 'DIGITAL_WALLET']).default('BANK_ACCOUNT'),
      branchId: z.string().trim().nullable().optional(),
      businessUnit: z.string().trim().max(80).nullable().optional(),
      bankName: z.string().trim().max(120).optional(),
      bankCode: z.string().trim().max(20).optional(),
      accountNumber: z.string().trim().min(6).max(34),
      accountName: z.string().trim().min(2).max(120),
      country: z.string().trim().length(2),
      currency: z.string().trim().length(3),
      priority: z.coerce.number().int().min(1).max(999).optional(),
    }),
  }),
  wrap(async (req, res) => {
    const data = await settlementAccounts.create(req.body);
    res.status(201).json({
      success: true,
      message: 'Settlement account added. Verify it before it can receive money.',
      data,
    });
  })
);

/** Confirm the account with the bank before it may receive anything (§9). */
settlementRoutes.post(
  '/accounts/:id/verify',
  requirePermission('vhicasar_pay.payout_account'),
  wrap(async (req, res) => {
    const data = await settlementAccounts.verify(req.params.id as string);
    res.json({ success: true, message: 'Settlement account verified.', data });
  })
);

settlementRoutes.post(
  '/accounts/:id/default',
  requirePermission('vhicasar_pay.payout_account'),
  wrap(async (req, res) => {
    const data = await settlementAccounts.setDefault(req.params.id as string);
    res.json({ success: true, message: 'Default settlement account updated.', data });
  })
);

settlementRoutes.patch(
  '/accounts/:id',
  requirePermission('vhicasar_pay.payout_account'),
  validate({
    body: z.object({
      priority: z.coerce.number().int().min(1).max(999).optional(),
      branchId: z.string().trim().nullable().optional(),
      businessUnit: z.string().trim().max(80).nullable().optional(),
    }),
  }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await settlementAccounts.update(req.params.id as string, req.body) });
  })
);

settlementRoutes.delete(
  '/accounts/:id',
  requirePermission('vhicasar_pay.payout_account'),
  wrap(async (req, res) => {
    await settlementAccounts.remove(req.params.id as string);
    res.json({ success: true, message: 'Settlement account removed.', data: { id: req.params.id } });
  })
);

/** The change trail §11 requires operators to be able to read. */
settlementRoutes.get(
  '/accounts/changes',
  requirePermission('vhicasar_pay.payout_account'),
  validate({
    query: z.object({
      accountId: z.string().trim().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }),
  }),
  wrap(async (req, res) => {
    const q = req.query as unknown as { accountId?: string; limit: number };
    res.json({ success: true, data: await settlementAccounts.changes(q) });
  })
);

// ---- Rules (§10) ----

settlementRoutes.get(
  '/rules',
  validate({
    query: z.object({
      branchId: z.string().trim().optional(),
      currency: z.string().trim().length(3).optional(),
    }),
  }),
  wrap(async (req, res) => {
    const q = req.query as unknown as { branchId?: string; currency?: string };
    const organizationId = req.auth!.organizationId as string;
    res.json({ success: true, data: await settlementEngine.ruleFor(organizationId, q) });
  })
);

settlementRoutes.put(
  '/rules',
  requirePermission('vhicasar_pay.payout_account'),
  validate({
    body: z.object({
      branchId: z.string().trim().nullable().optional(),
      currency: z.string().trim().length(3).nullable().optional(),
      schedule: z.enum(['INSTANT', 'HOURLY', 'DAILY', 'WEEKLY', 'MANUAL']).optional(),
      runAtHour: z.coerce.number().int().min(0).max(23).optional(),
      runOnWeekday: z.coerce.number().int().min(0).max(6).nullable().optional(),
      feePercent: z.coerce.number().min(0).max(100).optional(),
      feeFlat: z.coerce.number().min(0).optional(),
      taxPercent: z.coerce.number().min(0).max(100).optional(),
      reservePercent: z.coerce.number().min(0).max(100).optional(),
      reserveDays: z.coerce.number().int().min(0).max(365).optional(),
      minimumAmount: z.coerce.number().min(0).optional(),
      approvalThreshold: z.coerce.number().min(0).nullable().optional(),
      requiresDualApproval: z.boolean().optional(),
      delayHours: z.coerce.number().int().min(0).max(720).optional(),
      isActive: z.boolean().optional(),
    }),
  }),
  wrap(async (req, res) => {
    res.json({ success: true, message: 'Settlement rule saved.', data: await settlementEngine.upsertRule(req.body) });
  })
);

// ---- Settlements (§10, §11, §12) ----

/** The dashboard §12 describes. */
settlementRoutes.get(
  '/dashboard',
  validate({ query: z.object({ currency: z.string().trim().length(3).toUpperCase().default('NGN') }) }),
  wrap(async (req, res) => {
    const { currency } = req.query as unknown as { currency: string };
    res.json({ success: true, data: await settlementEngine.dashboard(currency) });
  })
);

/** Settle what is available now, subject to the rule in force. */
settlementRoutes.post(
  '/settle',
  requirePermission('vhicasar_pay.settle'),
  validate({
    body: z.object({
      currency: z.string().trim().length(3).toUpperCase().default('NGN'),
      branchId: z.string().trim().nullable().optional(),
      amount: z.coerce.number().positive().optional(),
    }),
  }),
  wrap(async (req, res) => {
    const { Prisma } = await import('@prisma/client');
    const body = req.body as { currency: string; branchId?: string | null; amount?: number };
    const result = await settlementEngine.calculate({
      organizationId: req.auth!.organizationId as string,
      currency: body.currency,
      branchId: body.branchId ?? null,
      amount: body.amount === undefined ? undefined : new Prisma.Decimal(body.amount),
    });
    res.status(201).json({
      success: true,
      message: 'Settlement created.',
      data: {
        id: result.settlement.id,
        status: result.settlement.status,
        gross: result.settlement.grossAmount.toFixed(2),
        fee: result.settlement.feeAmount.toFixed(2),
        tax: result.settlement.taxAmount.toFixed(2),
        reserve: result.settlement.reserveAmount.toFixed(2),
        net: result.settlement.netAmount.toFixed(2),
        currency: result.settlement.currency,
        scheduledFor: result.settlement.scheduledFor,
        riskScore: result.settlement.riskScore,
        riskReasons: result.riskReasons,
      },
    });
  })
);

settlementRoutes.post(
  '/settlements/:id/approve',
  requirePermission('vhicasar_pay.settle'),
  wrap(async (req, res) => {
    const result = await settlementEngine.approve(req.params.id as string);
    res.json({
      success: true,
      message: result.awaitingSecondApproval
        ? 'Approved. A second approver is still required.'
        : 'Settlement approved.',
      data: { id: result.settlement.id, status: result.settlement.status, awaitingSecondApproval: result.awaitingSecondApproval },
    });
  })
);

settlementRoutes.post(
  '/settlements/:id/cancel',
  requirePermission('vhicasar_pay.settle'),
  validate({ body: z.object({ reason: z.string().trim().min(3).max(300) }) }),
  wrap(async (req, res) => {
    const data = await settlementEngine.cancel(req.params.id as string, req.body.reason);
    res.json({ success: true, message: 'Settlement cancelled.', data: { id: data.id, status: data.status } });
  })
);

/** Release an approved settlement immediately rather than waiting for its slot. */
settlementRoutes.post(
  '/settlements/:id/execute',
  requirePermission('vhicasar_pay.settle'),
  wrap(async (req, res) => {
    const data = await settlementEngine.execute(req.params.id as string);
    res.json({
      success: true,
      message: data.status === 'PAID' ? 'Settlement paid out.' : 'Settlement could not be paid out.',
      data: { id: data.id, status: data.status, failureReason: data.failureReason },
    });
  })
);
