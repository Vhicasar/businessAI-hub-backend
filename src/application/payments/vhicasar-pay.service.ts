import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { Prisma } from '@prisma/client';
import type { PaymentSession } from '@prisma/client';
import { prisma, prismaUnscoped } from '../../infrastructure/database/prisma';
import { env } from '../../shared/config/env';
import { requestContext } from '../../shared/context';
import { AppError, ForbiddenError, NotFoundError, ValidationError } from '../../shared/errors';
import { money, ZERO } from '../../shared/money';
import { emitEvent } from '../../shared/domain-events';
import { metrics } from '../../shared/metrics';
import { getActivePaymentProvider } from '../../infrastructure/payments';
import { auditService } from '../audit/audit.service';
import { vhicasarIdService } from '../identity/vhicasar-id.service';
import { deviceSignatureService } from '../identity/device-signature.service';
import { fraudService } from '../fraud/fraud.service';
import { walletLedger } from './wallet-ledger.service';
import { transactionSecurity } from '../identity/transaction-security.service';
import type {
  ConfirmPaymentDto,
  CreateSessionDto,
  CreateSettlementDto,
  OpenChargebackDto,
  TopUpDto,
  TransferDto,
} from './vhicasar-pay.dto';

/**
 * Vhicasar Pay — wallet flows + server-issued payment sessions (System Bible
 * Payment domain; Database Bible §9). Client never sets or is trusted with
 * amounts: the PaymentSession the merchant created is authoritative, one-time,
 * expiring and signed; it becomes immutable once COMPLETED.
 */

const HMAC_KEY = Buffer.from(env.ENCRYPTION_KEY, 'hex');

function sessionSignature(token: string, amount: string, currency: string, expiresAtMs: number): string {
  return createHmac('sha256', HMAC_KEY)
    .update(`${token}.${amount}.${currency}.${expiresAtMs}`)
    .digest('base64url');
}

function verifySignature(session: PaymentSession): boolean {
  const expected = sessionSignature(
    session.sessionToken,
    session.amount.toFixed(2),
    session.currency,
    session.expiresAt.getTime()
  );
  const a = Buffer.from(expected);
  const b = Buffer.from(session.signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

const walletView = (w: { balance: Prisma.Decimal; currency: string; status: string }) => ({
  balance: w.balance.toFixed(2),
  currency: w.currency,
  status: w.status,
});

export const vhicasarPayService = {
  // ---------------------------------------------------------------- Consumer

  async getWallet(vhicasarId: string, currency: string) {
    const wallet = await walletLedger.getOrCreateUserWallet(vhicasarId, currency.toUpperCase());
    return walletView(wallet);
  },

  async statement(vhicasarId: string, currency: string, opts: { cursor?: string; limit: number }) {
    const wallet = await walletLedger.getOrCreateUserWallet(vhicasarId, currency.toUpperCase());
    return walletLedger.statement(wallet.id, opts);
  },

  /**
   * Top up a consumer wallet. The ledger credits the user and debits the
   * platform GATEWAY_CLEARING account (which mirrors funds captured by the
   * external gateway; wiring the real charge to the existing provider adapters
   * is a follow-up — the ledger side is complete and idempotent).
   */
  /**
   * Step 1 of a real top-up: initialise a charge on the active gateway
   * (Paystack/Flutterwave/Stripe) and hand the app the checkout URL. NOTHING is
   * credited here — money only reaches the wallet once the gateway confirms the
   * charge (webhook or the verify call below), so a client can never mint funds.
   */
  async initiateTopUp(vhicasarId: string, dto: TopUpDto) {
    const currency = dto.currency.toUpperCase();
    const amount = money(dto.amount);
    if (amount.lte(ZERO)) throw new ValidationError('Amount must be greater than zero');

    const provider = getActivePaymentProvider();
    if (!provider.enabled) {
      throw new AppError('PAYMENTS_UNAVAILABLE', 503, 'Online payments are not configured');
    }

    const identity = await vhicasarIdService.getById(vhicasarId);
    const email = identity.email ?? `${identity.publicId.toLowerCase()}@wallet.vhicasar.com`;
    const reference = `vptop_${vhicasarId.slice(0, 8)}_${randomBytes(6).toString('hex')}`;

    const init = await provider.initializeTransaction({
      email,
      amount: Math.round(Number(amount.toFixed(2)) * 100), // smallest currency unit
      reference,
      currency,
      callbackUrl: `${env.API_BASE_URL}/api/app/v1/wallet/topup/callback?reference=${reference}`,
      metadata: { kind: 'wallet_topup', vhicasarId, currency },
    });

    return { authorizationUrl: init.authorizationUrl, reference, provider: provider.name };
  },

  /**
   * Step 2: verify a gateway reference and credit the wallet. Driven by the
   * gateway webhook and, as a fallback, the app calling verify on return.
   * Idempotent: the ledger posting keys on `topup:<reference>`, so a webhook +
   * a client verify (or provider retries) credit exactly once.
   */
  async confirmTopUp(reference: string) {
    const idempotencyKey = `topup:${reference}`;

    const provider = getActivePaymentProvider();
    const txn = await provider.verifyTransaction(reference);
    if (txn.status !== 'success') {
      return { credited: false, status: txn.status };
    }

    const meta = (txn.metadata ?? {}) as Record<string, unknown>;
    const vhicasarId = String(meta.vhicasarId ?? '');
    if (!vhicasarId) throw new AppError('TOPUP_UNKNOWN', 400, 'Top-up reference not recognised');

    const currency = (txn.currency || 'NGN').toUpperCase();
    const amount = money(txn.amount / 100);

    const userWallet = await walletLedger.getOrCreateUserWallet(vhicasarId, currency);
    const clearing = await walletLedger.getOrCreatePlatformWallet('GATEWAY_CLEARING', currency);

    const posted = await walletLedger.post({
      type: 'TOPUP',
      currency,
      amount,
      initiatorVhicasarId: vhicasarId,
      description: 'Wallet top-up',
      reference,
      idempotencyKey,
      legs: [
        { walletId: clearing.id, direction: 'DEBIT', amount },
        { walletId: userWallet.id, direction: 'CREDIT', amount },
      ],
    });

    await emitEvent({
      name: 'WalletCredited',
      aggregateType: 'Wallet',
      aggregateId: userWallet.id,
      payload: { vhicasarId, amount: amount.toFixed(2), currency, transactionId: posted.id, provider: provider.name },
      organizationId: null,
    });

    const fresh = await walletLedger.balance(userWallet.id);
    return { credited: true, transactionId: posted.id, wallet: walletView(fresh) };
  },

  async transfer(fromVhicasarId: string, dto: TransferDto) {
    // Every sensitive action goes through the one gate, so lockout, adaptive
    // rules and high-value step-up behave identically everywhere (§1).
    await transactionSecurity.authorize({
      vhicasarId: fromVhicasarId,
      action: 'WALLET_TRANSFER',
      amount: dto.amount,
      pin: dto.pin,
      deviceId: dto.deviceId,
      biometricAsserted: dto.biometricAsserted,
    });

    const recipient = dto.toPublicId
      ? await prismaUnscoped.vhicasarId.findUnique({ where: { publicId: dto.toPublicId.toUpperCase() } })
      : await prismaUnscoped.vhicasarId.findFirst({
          where: { phone: dto.toPhone?.startsWith('+') ? dto.toPhone : `+${dto.toPhone}` },
        });
    if (!recipient || recipient.deletedAt) throw new NotFoundError('Recipient');
    if (recipient.id === fromVhicasarId) throw new AppError('INVALID_TRANSFER', 400, 'Cannot transfer to yourself');

    const currency = dto.currency.toUpperCase();
    const amount = money(dto.amount);
    const from = await walletLedger.getOrCreateUserWallet(fromVhicasarId, currency);
    const to = await walletLedger.getOrCreateUserWallet(recipient.id, currency);

    const txn = await walletLedger.post({
      type: 'TRANSFER',
      currency,
      amount,
      initiatorVhicasarId: fromVhicasarId,
      description: dto.note ?? 'Wallet transfer',
      legs: [
        { walletId: from.id, direction: 'DEBIT', amount },
        { walletId: to.id, direction: 'CREDIT', amount },
      ],
    });

    await emitEvent({
      name: 'WalletTransferCompleted',
      aggregateType: 'WalletTransaction',
      aggregateId: txn.id,
      payload: { from: fromVhicasarId, to: recipient.id, amount: amount.toFixed(2), currency },
      organizationId: null,
    });
    const fresh = await walletLedger.balance(from.id);
    return { transactionId: txn.id, wallet: walletView(fresh), recipient: recipient.displayName ?? recipient.publicId };
  },

  async history(vhicasarId: string, opts: { cursor?: string; limit: number }) {
    const rows = await prismaUnscoped.walletTransaction.findMany({
      where: { initiatorVhicasarId: vhicasarId, type: { in: ['PAYMENT', 'TRANSFER', 'TOPUP', 'REFUND'] } },
      orderBy: { createdAt: 'desc' },
      take: opts.limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      select: { id: true, type: true, amount: true, currency: true, description: true, createdAt: true },
    });
    const hasMore = rows.length > opts.limit;
    const items = hasMore ? rows.slice(0, opts.limit) : rows;
    return {
      items: items.map((t) => ({
        id: t.id,
        type: t.type,
        amount: t.amount.toFixed(2),
        currency: t.currency,
        description: t.description,
        createdAt: t.createdAt,
      })),
      nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
    };
  },

  // -------------------------------------------------------- Payment sessions

  /** Merchant creates a one-time, expiring, signed session (dynamic QR). */
  async createSession(dto: CreateSessionDto, createdByMembershipId?: string | null) {
    const ctx = requestContext.get();
    const organizationId = ctx?.organizationId;
    if (!organizationId) throw new ForbiddenError('Organization context required');

    const currency = dto.currency.toUpperCase();
    const amount = money(dto.amount);
    const token = randomBytes(24).toString('base64url');
    const nonce = randomBytes(9).toString('base64url');
    const expiresAt = new Date(Date.now() + (dto.expiresInSec ?? 300) * 1000);
    const signature = sessionSignature(token, amount.toFixed(2), currency, expiresAt.getTime());

    const session = await prisma.paymentSession.create({
      data: {
        organizationId,
        branchId: dto.branchId ?? null,
        registerId: dto.registerId ?? null,
        amount,
        currency,
        method: dto.method,
        description: dto.description ?? null,
        reference: dto.reference ?? null,
        sessionToken: token,
        nonce,
        signature,
        expiresAt,
        createdByMembershipId: createdByMembershipId ?? null,
      },
    });

    await emitEvent({
      name: 'PaymentInitiated',
      aggregateType: 'PaymentSession',
      aggregateId: session.id,
      payload: { amount: amount.toFixed(2), currency },
    });

    return {
      id: session.id,
      status: session.status,
      amount: amount.toFixed(2),
      currency,
      description: session.description,
      sessionToken: token,
      /** Encode this into the dynamic QR the customer scans. */
      qr: `vhicasarpay://pay?t=${token}`,
      expiresAt: session.expiresAt,
    };
  },

  /** Consumer scans the QR: read-only view of what they're about to pay. */
  async describeSession(sessionToken: string) {
    const session = await prismaUnscoped.paymentSession.findUnique({ where: { sessionToken } });
    if (!session) throw new NotFoundError('Payment session');
    if (!verifySignature(session)) throw new AppError('SESSION_INVALID', 400, 'Payment session failed integrity check');

    let status = session.status;
    if (status === 'CREATED' && session.expiresAt.getTime() < Date.now()) {
      await prismaUnscoped.paymentSession.updateMany({
        where: { id: session.id, status: 'CREATED' },
        data: { status: 'EXPIRED' },
      });
      status = 'EXPIRED';
    }

    const org = await prismaUnscoped.organization.findUnique({
      where: { id: session.organizationId },
      select: { name: true },
    });
    return {
      sessionToken: session.sessionToken,
      merchant: org?.name ?? 'Merchant',
      amount: session.amount.toFixed(2),
      currency: session.currency,
      description: session.description,
      status,
      expiresAt: session.expiresAt,
    };
  },

  /** Consumer confirms with PIN — the actual money movement. */
  async confirmPayment(vhicasarId: string, dto: ConfirmPaymentDto, ip?: string) {
    const session = await prismaUnscoped.paymentSession.findUnique({
      where: { sessionToken: dto.sessionToken },
    });
    if (!session) throw new NotFoundError('Payment session');
    if (!verifySignature(session)) throw new AppError('SESSION_INVALID', 400, 'Payment session failed integrity check');
    if (session.status !== 'CREATED') {
      throw new AppError('SESSION_NOT_PAYABLE', 409, `Session is ${session.status.toLowerCase()}`);
    }
    if (session.expiresAt.getTime() < Date.now()) {
      await prismaUnscoped.paymentSession.updateMany({
        where: { id: session.id, status: 'CREATED' },
        data: { status: 'EXPIRED' },
      });
      throw new AppError('PAYMENT_SESSION_EXPIRED', 409, 'Payment session has expired');
    }

    const attempt = await prismaUnscoped.paymentAttempt.create({
      data: { sessionId: session.id, vhicasarId, deviceId: dto.deviceId ?? null, ipAddress: ip ?? null },
    });

    try {
      await transactionSecurity.authorize({
        vhicasarId,
        action: 'WALLET_PAYMENT',
        amount: session.amount,
        pin: dto.pin,
        deviceId: dto.deviceId,
        biometricAsserted: dto.biometricAsserted,
        ip,
      });
    } catch (e) {
      await prismaUnscoped.paymentAttempt.update({
        where: { id: attempt.id },
        data: { status: 'FAILED', failureReason: 'INVALID_PIN' },
      });
      throw e;
    }

    const currency = session.currency;
    const amount = session.amount;

    // Device-bound authorisation (Flutter Bible §14/§16). A device that
    // registered a secure key MUST sign this confirmation — PIN alone is not
    // enough, and the single-use nonce makes a captured signature unusable.
    let deviceVerified = false;
    try {
      const check = await deviceSignatureService.requireForPayment({
        vhicasarId,
        deviceId: dto.deviceId ?? session.deviceId,
        sessionToken: dto.sessionToken,
        amount: amount.toFixed(2),
        currency,
        nonce: dto.nonce,
        signature: dto.signature,
      });
      deviceVerified = check.verified;
    } catch (e) {
      await prismaUnscoped.paymentAttempt.update({
        where: { id: attempt.id },
        data: { status: 'FAILED', failureReason: e instanceof AppError ? e.code : 'DEVICE_CHECK_FAILED' },
      });
      throw e;
    }

    // Fraud/Trust gate (Phase 3): score before any money moves. BLOCK stops the
    // payment; REVIEW is allowed through but raises a manual-review alert.
    const risk = await fraudService.assess({
      subjectType: 'PAYMENT_SESSION',
      subjectId: session.id,
      vhicasarId,
      organizationId: session.organizationId,
      deviceId: dto.deviceId ?? session.deviceId,
      amount,
      currency,
      deviceVerified,
    });
    await prismaUnscoped.paymentAttempt.update({ where: { id: attempt.id }, data: { riskScore: risk.score } });
    if (risk.decision === 'BLOCK') {
      await prismaUnscoped.paymentAttempt.update({
        where: { id: attempt.id },
        data: { status: 'BLOCKED', failureReason: 'FRAUD_DETECTED' },
      });
      await prismaUnscoped.paymentSession.updateMany({
        where: { id: session.id, status: 'CREATED' },
        data: { status: 'FAILED', riskScore: risk.score },
      });
      await fraudService.recordPaymentOutcome('BLOCKED', {
        vhicasarId,
        deviceId: dto.deviceId ?? session.deviceId,
        organizationId: session.organizationId,
      });
      metrics.paymentsTotal.inc({ outcome: 'blocked', currency });
      throw new AppError('FRAUD_DETECTED', 403, 'Payment blocked by fraud checks');
    }

    const customerWallet = await walletLedger.getOrCreateUserWallet(vhicasarId, currency);
    const merchantWallet = await walletLedger.getOrCreateOrgWallet(session.organizationId, 'MERCHANT', currency);

    let txnId: string;
    try {
      const txn = await walletLedger.post({
        type: 'PAYMENT',
        currency,
        amount,
        organizationId: session.organizationId,
        initiatorVhicasarId: vhicasarId,
        description: session.description ?? 'Vhicasar Pay payment',
        reference: session.reference ?? undefined,
        idempotencyKey: `pay:${session.id}`, // one payment per session, ever
        paymentSessionId: session.id,
        legs: [
          { walletId: customerWallet.id, direction: 'DEBIT', amount },
          { walletId: merchantWallet.id, direction: 'CREDIT', amount },
        ],
      });
      txnId = txn.id;
    } catch (e) {
      await prismaUnscoped.paymentAttempt.update({
        where: { id: attempt.id },
        data: { status: 'FAILED', failureReason: e instanceof AppError ? e.code : 'POSTING_FAILED' },
      });
      throw e;
    }

    // Record a Payment row for the merchant's books.
    const payment = await prismaUnscoped.payment.create({
      data: {
        organizationId: session.organizationId,
        method: 'WALLET',
        status: 'PAID',
        amount,
        currency,
        provider: 'vhicasar_pay',
        providerRef: txnId,
        paidAt: new Date(),
        metadata: { paymentSessionId: session.id, vhicasarId },
      },
    });

    // Immutable transition: only a still-CREATED session can complete.
    const done = await prismaUnscoped.paymentSession.updateMany({
      where: { id: session.id, status: 'CREATED' },
      data: {
        status: 'COMPLETED',
        customerVhicasarId: vhicasarId,
        deviceId: dto.deviceId ?? null,
        paymentId: payment.id,
        walletTransactionId: txnId,
        riskScore: risk.score,
        authorizedAt: new Date(),
        completedAt: new Date(),
      },
    });
    if (done.count !== 1) {
      // Lost the race to another confirm — the idempotency key already stopped
      // a double debit, so just surface the conflict.
      throw new AppError('SESSION_NOT_PAYABLE', 409, 'Session already completed');
    }

    await prismaUnscoped.paymentAttempt.update({ where: { id: attempt.id }, data: { status: 'SUCCEEDED' } });
    metrics.paymentsTotal.inc({ outcome: 'completed', currency });
    await fraudService.recordPaymentOutcome('SUCCESS', {
      vhicasarId,
      deviceId: dto.deviceId ?? session.deviceId,
      organizationId: session.organizationId,
    });

    // POS checkout? Issue a receipt against the register's open shift. Dynamic
    // import breaks the pos ↔ pay module cycle.
    if (session.registerId) {
      const { posService } = await import('../pos/pos.service');
      await posService.onSessionPaid({ ...session, customerVhicasarId: vhicasarId }, payment);
    }
    await auditService.record({
      action: 'vhicasar_pay.payment_completed',
      entityType: 'PaymentSession',
      entityId: session.id,
      after: { amount: amount.toFixed(2), currency, paymentId: payment.id },
    });
    await emitEvent({
      name: 'PaymentCompleted',
      aggregateType: 'PaymentSession',
      aggregateId: session.id,
      payload: {
        paymentId: payment.id,
        amount: amount.toFixed(2),
        currency,
        vhicasarId,
        organizationId: session.organizationId,
      },
      organizationId: session.organizationId,
    });

    const fresh = await walletLedger.balance(customerWallet.id);
    return {
      paymentId: payment.id,
      transactionId: txnId,
      amount: amount.toFixed(2),
      currency,
      status: 'COMPLETED' as const,
      wallet: walletView(fresh),
      completedAt: new Date(),
    };
  },

  // -------------------------------------------------------------- Merchant

  async getSession(id: string) {
    const session = await prisma.paymentSession.findUnique({
      where: { id },
      include: { attempts: { orderBy: { createdAt: 'desc' }, take: 10 } },
    });
    if (!session) throw new NotFoundError('Payment session');
    return session;
  },

  async cancelSession(id: string) {
    const res = await prisma.paymentSession.updateMany({
      where: { id, status: 'CREATED' },
      data: { status: 'CANCELLED' },
    });
    if (res.count !== 1) throw new AppError('SESSION_NOT_CANCELLABLE', 409, 'Session cannot be cancelled');
    return { id, status: 'CANCELLED' as const };
  },

  async merchantWallet(currency: string) {
    const ctx = requestContext.get();
    if (!ctx?.organizationId) throw new ForbiddenError('Organization context required');
    const wallet = await walletLedger.getOrCreateOrgWallet(ctx.organizationId, 'MERCHANT', currency.toUpperCase());
    return walletView(wallet);
  },

  /**
   * Move the merchant's available balance into a Settlement (PENDING payout).
   * Funds go MERCHANT → this organization's SETTLEMENT_PAYABLE so the balance
   * reflects only unsettled funds. Settlement items are never deleted.
   */
  async createSettlement(dto: CreateSettlementDto) {
    const ctx = requestContext.get();
    if (!ctx?.organizationId) throw new ForbiddenError('Organization context required');
    const currency = dto.currency.toUpperCase();
    const merchantWallet = await walletLedger.getOrCreateOrgWallet(ctx.organizationId, 'MERCHANT', currency);
    const gross = merchantWallet.balance;
    if (gross.lessThanOrEqualTo(ZERO)) throw new AppError('NOTHING_TO_SETTLE', 400, 'No funds available to settle');

    // Per-organization, matching payoutService.payoutSettlement, which debits
    // the same account when the money actually leaves. These previously
    // disagreed — credits landed on the platform account while payouts drew on
    // the org one, so both drifted.
    const payable = await walletLedger.getOrCreateOrgWallet(ctx.organizationId, 'SETTLEMENT_PAYABLE', currency);
    const txn = await walletLedger.post({
      type: 'SETTLEMENT',
      currency,
      amount: gross,
      organizationId: ctx.organizationId,
      description: 'Settlement payout',
      legs: [
        { walletId: merchantWallet.id, direction: 'DEBIT', amount: gross },
        { walletId: payable.id, direction: 'CREDIT', amount: gross },
      ],
    });

    const settlement = await prisma.settlement.create({
      data: {
        organizationId: ctx.organizationId,
        currency,
        grossAmount: gross,
        feeAmount: new Prisma.Decimal(0),
        netAmount: gross,
        items: { create: [{ walletTransactionId: txn.id, amount: gross }] },
      },
    });

    await emitEvent({
      name: 'SettlementCreated',
      aggregateType: 'Settlement',
      aggregateId: settlement.id,
      payload: { amount: gross.toFixed(2), currency },
    });
    return {
      id: settlement.id,
      status: settlement.status,
      grossAmount: gross.toFixed(2),
      netAmount: gross.toFixed(2),
      currency,
    };
  },

  async listSettlements(opts: { cursor?: string; limit: number }) {
    const rows = await prisma.settlement.findMany({
      orderBy: { createdAt: 'desc' },
      take: opts.limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > opts.limit;
    const items = hasMore ? rows.slice(0, opts.limit) : rows;
    return {
      items: items.map((s) => ({
        id: s.id,
        status: s.status,
        grossAmount: s.grossAmount.toFixed(2),
        netAmount: s.netAmount.toFixed(2),
        currency: s.currency,
        createdAt: s.createdAt,
        paidAt: s.paidAt,
      })),
      nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
    };
  },

  async openChargeback(dto: OpenChargebackDto) {
    const ctx = requestContext.get();
    if (!ctx?.organizationId) throw new ForbiddenError('Organization context required');
    const payment = await prisma.payment.findUnique({ where: { id: dto.paymentId }, select: { id: true } });
    if (!payment) throw new NotFoundError('Payment');
    const chargeback = await prisma.chargeback.create({
      data: {
        organizationId: ctx.organizationId,
        paymentId: dto.paymentId,
        amount: money(dto.amount),
        currency: dto.currency.toUpperCase(),
        reason: dto.reason ?? null,
      },
    });
    await auditService.record({
      action: 'vhicasar_pay.chargeback_opened',
      entityType: 'Payment',
      entityId: dto.paymentId,
      after: { chargebackId: chargeback.id },
    });
    return { id: chargeback.id, status: chargeback.status };
  },

  /**
   * Pay a payment link from the customer's wallet (§10).
   *
   * The link is authoritative for the amount — the client only confirms it.
   * Funds are drawn across wallet buckets by the customer's priority, so
   * locked and reward money is used before free cash.
   */
  async payLinkWithWallet(
    vhicasarId: string,
    token: string,
    dto: {
      pin?: string;
      deviceId?: string;
      biometricAsserted?: boolean;
      priority?: ('AVAILABLE' | 'LOCKED' | 'REWARD' | 'CASHBACK')[];
    }
  ) {
    const { paymentLinksService } = await import('./payment-links.service');
    const { walletBuckets } = await import('./wallet-buckets.service');

    const link = await prismaUnscoped.paymentLink.findUnique({ where: { token } });
    if (!link) throw new NotFoundError('Payment link');
    if (link.status === 'PAID') throw new AppError('LINK_ALREADY_PAID', 409, 'This payment has already been made.');
    if (link.status === 'CANCELLED') throw new AppError('LINK_CANCELLED', 409, 'This payment link was cancelled.');
    if (link.expiresAt && link.expiresAt.getTime() < Date.now()) {
      throw new AppError('LINK_EXPIRED', 409, 'This payment link has expired.');
    }

    const outstanding = money(link.amount).minus(link.amountPaid);
    await transactionSecurity.authorize({
      vhicasarId,
      action: 'WALLET_PAYMENT',
      amount: outstanding,
      pin: dto.pin,
      deviceId: dto.deviceId,
      biometricAsserted: dto.biometricAsserted,
    });

    if (!outstanding.greaterThan(ZERO)) {
      throw new AppError('LINK_ALREADY_PAID', 409, 'Nothing left to pay on this link.');
    }

    const plan = await walletBuckets.planPayment({
      vhicasarId,
      currency: link.currency,
      amount: outstanding,
      organizationId: link.organizationId,
      priority: dto.priority,
    });

    const customerWallet = await walletLedger.getOrCreateUserWallet(vhicasarId, link.currency);
    const merchantWallet = await walletLedger.getOrCreateOrgWallet(link.organizationId, 'MERCHANT', link.currency);

    const txn = await walletLedger.post({
      type: 'PAYMENT',
      currency: link.currency,
      amount: outstanding,
      organizationId: link.organizationId,
      initiatorVhicasarId: vhicasarId,
      description: link.description ?? 'Payment link',
      reference: link.token,
      idempotencyKey: `paylink:${link.id}`,
      legs: [
        ...plan.map((p) => ({
          walletId: customerWallet.id,
          direction: 'DEBIT' as const,
          amount: p.amount,
          bucket: p.bucket,
        })),
        { walletId: merchantWallet.id, direction: 'CREDIT' as const, amount: outstanding },
      ],
    });

    // Settle the link through its own service so orders/invoices react exactly
    // as they would for a gateway payment.
    await paymentLinksService.settleFromWallet(link.id, outstanding, txn.id, vhicasarId);

    const fresh = await walletBuckets.breakdown(vhicasarId, link.currency);
    return {
      paid: outstanding.toFixed(2),
      currency: link.currency,
      transactionId: txn.id,
      fundedBy: plan.map((p) => ({ bucket: p.bucket, amount: p.amount.toFixed(2) })),
      wallet: fresh,
    };
  },
};
