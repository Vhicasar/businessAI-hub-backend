import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticateApp } from '../middleware/authenticate-app';
import { idempotency } from '../middleware/idempotency';
import { vhicasarPayService } from '../../../application/payments/vhicasar-pay.service';
import { deviceSignatureService } from '../../../application/identity/device-signature.service';
import { payoutService } from '../../../application/payments/payout.service';
import { kycService } from '../../../application/identity/kyc.service';
import { walletBuckets } from '../../../application/payments/wallet-buckets.service';
import {
  payoutAccountSchema,
  submitKycSchema,
  withdrawSchema,
} from '../../../application/identity/identity.dto';
import {
  confirmPaymentSchema,
  topUpSchema,
  transferSchema,
} from '../../../application/payments/vhicasar-pay.dto';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

const clientIp = (req: Request): string | undefined =>
  (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress || undefined;

const walletQuery = z.object({
  currency: z.string().trim().length(3).toUpperCase().default('NGN'),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

/**
 * Customer Super App — Vhicasar Pay (wallet + QR payments). Mounted at
 * /api/app/v1, `app`-scoped tokens. All amounts are server-authoritative.
 */
export const appPayRoutes = Router();

appPayRoutes.use(authenticateApp);

appPayRoutes.get(
  '/wallet',
  validate({ query: walletQuery }),
  wrap(async (req, res) => {
    const data = await vhicasarPayService.getWallet(req.appAuth!.vhicasarId, (req.query.currency as string) ?? 'NGN');
    res.json({ success: true, data });
  })
);

appPayRoutes.get(
  '/wallet/transactions',
  validate({ query: walletQuery }),
  wrap(async (req, res) => {
    const q = req.query as unknown as { currency: string; cursor?: string; limit: number };
    const data = await vhicasarPayService.statement(req.appAuth!.vhicasarId, q.currency, {
      cursor: q.cursor,
      limit: q.limit,
    });
    res.json({ success: true, data });
  })
);

/** Start a real gateway top-up — returns a checkout URL the app opens. */
appPayRoutes.post(
  '/wallet/topup',
  validate({ body: topUpSchema }),
  wrap(async (req, res) => {
    const data = await vhicasarPayService.initiateTopUp(req.appAuth!.vhicasarId, req.body);
    res.status(201).json({ success: true, data });
  })
);

/** Fallback verify (the webhook is primary): credit the wallet if the charge succeeded. */
appPayRoutes.post(
  '/wallet/topup/verify',
  validate({ body: z.object({ reference: z.string().trim().min(6).max(120) }) }),
  wrap(async (req, res) => {
    const data = await vhicasarPayService.confirmTopUp(req.body.reference);
    res.json({ success: true, data });
  })
);

appPayRoutes.post(
  '/wallet/transfer',
  idempotency,
  validate({ body: transferSchema }),
  wrap(async (req, res) => {
    const data = await vhicasarPayService.transfer(req.appAuth!.vhicasarId, req.body);
    res.status(201).json({ success: true, data });
  })
);

/**
 * Scan a dynamic QR: read-only view of the pending charge, plus the offers the
 * scanning customer could apply to it.
 */
appPayRoutes.get(
  '/payments/session/:token',
  wrap(async (req, res) => {
    const data = await vhicasarPayService.describeSession(
      req.params.token as string,
      req.appAuth!.vhicasarId
    );
    res.json({ success: true, data });
  })
);

/**
 * Issue a single-use challenge for a device-signed confirmation. The app signs
 * `sessionToken.nonce.amount.currency` with its secure-enclave key and sends
 * the signature to /payments/confirm.
 */
appPayRoutes.post(
  '/payments/nonce',
  validate({ body: z.object({ deviceId: z.string().trim().min(1).max(200), sessionId: z.string().trim().max(60).optional() }) }),
  wrap(async (req, res) => {
    const data = await deviceSignatureService.issueNonce(
      req.appAuth!.vhicasarId,
      req.body.deviceId,
      req.body.sessionId
    );
    res.status(201).json({ success: true, data });
  })
);

/** Confirm a payment session with PIN (+ device signature) — moves the money. */
appPayRoutes.post(
  '/payments/confirm',
  idempotency,
  validate({ body: confirmPaymentSchema }),
  wrap(async (req, res) => {
    const data = await vhicasarPayService.confirmPayment(req.appAuth!.vhicasarId, req.body, clientIp(req));
    res.json({ success: true, message: 'Payment completed.', data });
  })
);

appPayRoutes.get(
  '/payments/history',
  validate({ query: walletQuery }),
  wrap(async (req, res) => {
    const q = req.query as unknown as { cursor?: string; limit: number };
    const data = await vhicasarPayService.history(req.appAuth!.vhicasarId, { cursor: q.cursor, limit: q.limit });
    res.json({ success: true, data });
  })
);

/**
 * PUBLIC gateway redirect target for a wallet top-up. The gateway sends the
 * customer's browser here after checkout; we verify + credit, then hand back a
 * tiny page that deep-links into the app. No app token — verification is driven
 * by the trusted gateway reference, and crediting is idempotent.
 */
export const appPayPublicRoutes = Router();

appPayPublicRoutes.get(
  '/wallet/topup/callback',
  wrap(async (req, res) => {
    const reference = String(req.query.reference ?? '');
    let ok = false;
    try {
      const result = await vhicasarPayService.confirmTopUp(reference);
      ok = 'credited' in result ? Boolean(result.credited) : false;
    } catch {
      ok = false;
    }
    const title = ok ? 'Top-up successful' : 'Top-up pending';
    const body = ok
      ? 'Your wallet has been credited. You can return to the Vhicasar app.'
      : 'We are confirming your payment. If it was successful, your wallet will be credited shortly.';
    res
      .status(200)
      .type('html')
      .send(
        `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"/>` +
          `<title>${title}</title><meta http-equiv="refresh" content="2;url=vhicasarapp://wallet?topup=${ok ? 'success' : 'pending'}"/>` +
          `<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0b0b0c;color:#fff;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px;text-align:center}` +
          `.card{max-width:420px}.dot{color:#F97316}</style></head>` +
          `<body><div class="card"><h2>${title} <span class="dot">•</span></h2><p>${body}</p>` +
          `<p><a style="color:#F97316" href="vhicasarapp://wallet?topup=${ok ? 'success' : 'pending'}">Open the app</a></p></div></body></html>`
      );
  })
);

// ---- Cash-out: payout destinations + withdrawals ----

/** Banks the active gateway can pay out to (for the add-account form). */
appPayRoutes.get(
  '/payouts/banks',
  wrap(async (req, res) => {
    const country = typeof req.query.country === 'string' ? req.query.country : undefined;
    res.json({ success: true, data: await payoutService.listBanks(country) });
  })
);

appPayRoutes.get(
  '/payouts/accounts',
  wrap(async (req, res) => {
    const data = await payoutService.listAccounts({ vhicasarId: req.appAuth!.vhicasarId });
    res.json({ success: true, data });
  })
);

appPayRoutes.post(
  '/payouts/accounts',
  validate({ body: payoutAccountSchema }),
  wrap(async (req, res) => {
    const data = await payoutService.addAccount({ vhicasarId: req.appAuth!.vhicasarId }, req.body);
    res.status(201).json({ success: true, message: 'Account added.', data });
  })
);

appPayRoutes.delete(
  '/payouts/accounts/:id',
  wrap(async (req, res) => {
    await payoutService.removeAccount({ vhicasarId: req.appAuth!.vhicasarId }, req.params.id as string);
    res.json({ success: true, data: { message: 'Account removed' } });
  })
);

/** Withdraw wallet funds to a bank account. PIN-gated and KYC-limited. */
appPayRoutes.post(
  '/payouts/withdraw',
  idempotency,
  validate({ body: withdrawSchema }),
  wrap(async (req, res) => {
    const data = await payoutService.withdraw(req.appAuth!.vhicasarId, req.body, clientIp(req));
    res.status(201).json({ success: true, message: 'Withdrawal started.', data });
  })
);

appPayRoutes.get(
  '/payouts',
  validate({ query: walletQuery }),
  wrap(async (req, res) => {
    const q = req.query as unknown as { cursor?: string; limit: number };
    const data = await payoutService.listPayouts({ vhicasarId: req.appAuth!.vhicasarId }, q);
    res.json({ success: true, data });
  })
);

// ---- KYC ----

appPayRoutes.get(
  '/kyc',
  wrap(async (req, res) => {
    res.json({ success: true, data: await kycService.statusFor(req.appAuth!.vhicasarId) });
  })
);

appPayRoutes.post(
  '/kyc',
  validate({ body: submitKycSchema }),
  wrap(async (req, res) => {
    const data = await kycService.submit(req.appAuth!.vhicasarId, req.body);
    res.status(201).json({ success: true, message: 'Verification submitted for review.', data });
  })
);

// ---- Wallet buckets: available / locked / reward / cashback (§12, §22) ----

/** Full balance breakdown for the wallet screen. */
appPayRoutes.get(
  '/wallet/breakdown',
  validate({ query: z.object({ currency: z.string().trim().length(3).toUpperCase().default('NGN') }) }),
  wrap(async (req, res) => {
    const { currency } = req.query as unknown as { currency: string };
    res.json({ success: true, data: await walletBuckets.breakdown(req.appAuth!.vhicasarId, currency) });
  })
);

/** Whether locking is available, and within what limits. */
appPayRoutes.get(
  '/wallet/lock-config',
  wrap(async (_req, res) => {
    res.json({ success: true, data: await walletBuckets.lockConfig() });
  })
);

/**
 * Lock funds for in-platform spending only. One-way by design — the commitment
 * is the point of the feature, so there is no customer-facing unlock.
 */
appPayRoutes.post(
  '/wallet/lock',
  idempotency,
  validate({
    body: z.object({
      amount: z.coerce.number().positive(),
      currency: z.string().trim().length(3).toUpperCase().default('NGN'),
    }),
  }),
  wrap(async (req, res) => {
    const data = await walletBuckets.lockFunds(req.appAuth!.vhicasarId, req.body.amount, req.body.currency);
    res.status(201).json({ success: true, message: 'Funds locked for Vhicasar payments.', data });
  })
);

/** Statement, optionally filtered to one bucket. */
appPayRoutes.get(
  '/wallet/statement',
  validate({
    query: z.object({
      currency: z.string().trim().length(3).toUpperCase().default('NGN'),
      bucket: z.enum(['AVAILABLE', 'LOCKED', 'REWARD', 'CASHBACK']).optional(),
      cursor: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(30),
    }),
  }),
  wrap(async (req, res) => {
    const q = req.query as unknown as { currency: string; bucket?: never; cursor?: string; limit: number };
    const data = await walletBuckets.statement(req.appAuth!.vhicasarId, q.currency, q);
    res.json({ success: true, data });
  })
);

// ---- Pay a payment link from the wallet (§10) ----

/**
 * Preview: what the customer is about to pay and who they're paying.
 * Business identity is shown before any confirmation, so a link can't
 * impersonate another merchant.
 */
appPayRoutes.get(
  '/payment-links/:token',
  wrap(async (req, res) => {
    const { paymentLinksService } = await import('../../../application/payments/payment-links.service');
    const link = await paymentLinksService.publicView(req.params.token as string);
    res.json({ success: true, data: link });
  })
);

/** Confirm and pay from the wallet, PIN-gated, across the chosen buckets. */
appPayRoutes.post(
  '/payment-links/:token/pay',
  idempotency,
  validate({
    body: z.object({
      pin: z.string().regex(/^\d{4,8}$/).optional(),
      deviceId: z.string().trim().max(200).optional(),
      biometricAsserted: z.boolean().optional(),
      priority: z.array(z.enum(['AVAILABLE', 'LOCKED', 'REWARD', 'CASHBACK'])).optional(),
    }),
  }),
  wrap(async (req, res) => {
    const data = await vhicasarPayService.payLinkWithWallet(
      req.appAuth!.vhicasarId,
      req.params.token as string,
      req.body
    );
    res.status(201).json({ success: true, message: 'Payment completed.', data });
  })
);
