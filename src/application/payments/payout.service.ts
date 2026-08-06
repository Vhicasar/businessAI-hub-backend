import { randomBytes } from 'crypto';
import { Prisma } from '@prisma/client';
import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../shared/errors';
import { decrypt, encrypt } from '../../shared/crypto';
import { money, ZERO } from '../../shared/money';
import { emitEvent } from '../../shared/domain-events';
import { logger } from '../../shared/logger';
import { metrics } from '../../shared/metrics';
import { getActivePaymentProvider } from '../../infrastructure/payments';
import { supportsPayouts } from '../../infrastructure/payments/types';
import { auditService } from '../audit/audit.service';
import { vhicasarIdService } from '../identity/vhicasar-id.service';
import { walletLedger } from './wallet-ledger.service';
import type { PayoutAccountDto, WithdrawDto } from '../identity/identity.dto';
import { transactionSecurity } from '../identity/transaction-security.service';

/**
 * Payouts — real money leaving the platform (Database Bible §9, API Bible §10).
 *
 * Two flows share one mechanism:
 *   • consumer cash-out  — USER wallet → GATEWAY_CLEARING → bank
 *   • merchant settlement — SETTLEMENT_PAYABLE → GATEWAY_CLEARING → bank
 *
 * Funds are debited from the ledger *first* (so the balance can't be spent
 * twice while a transfer is in flight) and reversed if the gateway rejects it.
 * PayoutAccount/Payout carry organizationId, so the tenant extension would
 * scope them — consumer flows must use the unscoped client, like the ledger.
 */

/** Cash-out ceilings by KYC level, in major currency units. */
const KYC_WITHDRAWAL_LIMITS: Record<string, Prisma.Decimal> = {
  NONE: money(0),
  BASIC: money(50_000),
  VERIFIED: money(5_000_000),
};

function payoutProvider() {
  const provider = getActivePaymentProvider();
  if (!supportsPayouts(provider) || !provider.enabled) {
    throw new AppError(
      'PAYOUTS_UNAVAILABLE',
      503,
      'Bank payouts are not enabled for the configured payment provider.'
    );
  }
  return provider;
}

const accountView = (a: {
  id: string;
  type: string;
  status: string;
  accountName: string;
  accountLast4: string;
  bankName: string | null;
  bankCode: string | null;
  currency: string;
  isDefault: boolean;
  verifiedAt: Date | null;
}) => ({
  id: a.id,
  type: a.type,
  status: a.status,
  accountName: a.accountName,
  // Never return the full number — only the tail the user needs to recognise it.
  accountNumberMasked: `••••${a.accountLast4}`,
  bankName: a.bankName,
  bankCode: a.bankCode,
  currency: a.currency,
  isDefault: a.isDefault,
  verifiedAt: a.verifiedAt,
});

export const payoutService = {
  KYC_WITHDRAWAL_LIMITS,

  /** Banks the active gateway can pay out to. */
  async listBanks(country?: string) {
    return payoutProvider().listBanks(country);
  },

  // ---- Payout destinations ----

  async addAccount(
    owner: { vhicasarId?: string; organizationId?: string },
    dto: PayoutAccountDto
  ) {
    if (!owner.vhicasarId && !owner.organizationId) {
      throw new ValidationError('A payout account needs an owner');
    }
    const provider = payoutProvider();

    // Confirm the account exists and capture the bank's own name for it — this
    // is what stops a typo sending someone else's money away.
    let resolvedName: string | null = null;
    if (dto.bankCode) {
      const resolved = await provider.resolveAccount(dto.accountNumber, dto.bankCode);
      if (!resolved) {
        throw new ValidationError('We could not verify that account number with the bank');
      }
      resolvedName = resolved.accountName;
    }

    const recipient = dto.bankCode
      ? await provider.createRecipient({
          accountName: resolvedName ?? dto.accountName,
          accountNumber: dto.accountNumber,
          bankCode: dto.bankCode,
          currency: dto.currency,
          type: dto.type,
        })
      : null;

    const created = await prismaUnscoped.payoutAccount.create({
      data: {
        vhicasarId: owner.vhicasarId ?? null,
        organizationId: owner.organizationId ?? null,
        type: dto.type,
        status: resolvedName ? 'VERIFIED' : 'UNVERIFIED',
        accountName: resolvedName ?? dto.accountName,
        accountNumberEnc: encrypt(dto.accountNumber),
        accountLast4: dto.accountNumber.slice(-4),
        bankCode: dto.bankCode ?? null,
        bankName: dto.bankName ?? null,
        currency: dto.currency,
        country: dto.country ?? null,
        provider: provider.name,
        providerRef: recipient?.recipientRef ?? null,
        isDefault: dto.isDefault ?? false,
        verifiedAt: resolvedName ? new Date() : null,
      },
    });

    if (dto.isDefault) await this.setDefault(owner, created.id);
    await auditService.record({
      action: 'payout.account_added',
      entityType: 'PayoutAccount',
      entityId: created.id,
      after: { last4: created.accountLast4, bank: created.bankName },
    });
    return accountView(created);
  },

  async listAccounts(owner: { vhicasarId?: string; organizationId?: string }) {
    const rows = await prismaUnscoped.payoutAccount.findMany({
      where: {
        deletedAt: null,
        ...(owner.vhicasarId ? { vhicasarId: owner.vhicasarId } : {}),
        ...(owner.organizationId ? { organizationId: owner.organizationId } : {}),
      },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
    return rows.map(accountView);
  },

  async setDefault(owner: { vhicasarId?: string; organizationId?: string }, accountId: string) {
    const scope = {
      ...(owner.vhicasarId ? { vhicasarId: owner.vhicasarId } : {}),
      ...(owner.organizationId ? { organizationId: owner.organizationId } : {}),
    };
    await prismaUnscoped.payoutAccount.updateMany({ where: scope, data: { isDefault: false } });
    const updated = await prismaUnscoped.payoutAccount.updateMany({
      where: { ...scope, id: accountId, deletedAt: null },
      data: { isDefault: true },
    });
    if (updated.count === 0) throw new NotFoundError('Payout account');
  },

  async removeAccount(owner: { vhicasarId?: string; organizationId?: string }, accountId: string) {
    const scope = {
      ...(owner.vhicasarId ? { vhicasarId: owner.vhicasarId } : {}),
      ...(owner.organizationId ? { organizationId: owner.organizationId } : {}),
    };
    const removed = await prismaUnscoped.payoutAccount.updateMany({
      where: { ...scope, id: accountId, deletedAt: null },
      data: { deletedAt: new Date(), isDefault: false },
    });
    if (removed.count === 0) throw new NotFoundError('Payout account');
  },

  // ---- Consumer cash-out ----

  async withdraw(vhicasarId: string, dto: WithdrawDto, ip?: string) {
    const currency = dto.currency.toUpperCase();
    const amount = money(dto.amount);
    if (!amount.greaterThan(ZERO)) throw new ValidationError('Enter an amount greater than zero');

    // Money leaving the platform is irreversible, so the PIN is unconditional
    // here — PIN_ACTIONS marks WALLET_WITHDRAWAL alwaysRequired (§1).
    await transactionSecurity.authorize({
      vhicasarId,
      action: 'WALLET_WITHDRAWAL',
      amount: amount,
      pin: dto.pin,
      deviceId: dto.deviceId,
      biometricAsserted: dto.biometricAsserted,
      ip,
    });

    const identity = await vhicasarIdService.getById(vhicasarId);
    const limit = KYC_WITHDRAWAL_LIMITS[identity.kycLevel] ?? ZERO;
    if (!limit.greaterThan(ZERO)) {
      throw new AppError(
        'KYC_REQUIRED',
        403,
        'Verify your identity before withdrawing money.'
      );
    }
    if (amount.greaterThan(limit)) {
      throw new AppError(
        'KYC_LIMIT_EXCEEDED',
        403,
        `Your verification level allows up to ${limit.toFixed(2)} ${currency} per withdrawal.`
      );
    }

    const account = await prismaUnscoped.payoutAccount.findFirst({
      where: { id: dto.payoutAccountId, vhicasarId, deletedAt: null },
    });
    if (!account) throw new NotFoundError('Payout account');
    if (account.currency !== currency) {
      throw new ValidationError('That account cannot receive this currency');
    }

    const userWallet = await walletLedger.getOrCreateUserWallet(vhicasarId, currency);
    const clearing = await walletLedger.getOrCreatePlatformWallet('GATEWAY_CLEARING', currency);
    const reference = `wd_${randomBytes(10).toString('hex')}`;

    // Debit first: the money is committed before we ask the bank to move it, so
    // it cannot be spent twice while the transfer is in flight.
    const txn = await walletLedger.post({
      type: 'WITHDRAWAL',
      currency,
      amount,
      initiatorVhicasarId: vhicasarId,
      description: 'Wallet withdrawal',
      reference,
      idempotencyKey: dto.idempotencyKey ? `wd:${dto.idempotencyKey}` : `wd:${reference}`,
      legs: [
        { walletId: userWallet.id, direction: 'DEBIT', amount },
        { walletId: clearing.id, direction: 'CREDIT', amount },
      ],
    });

    const payout = await prismaUnscoped.payout.create({
      data: {
        vhicasarId,
        payoutAccountId: account.id,
        currency,
        amount,
        netAmount: amount,
        status: 'PROCESSING',
        provider: account.provider,
        walletTransactionId: txn.id,
        idempotencyKey: dto.idempotencyKey ?? reference,
        metadata: { ip: ip ?? null },
      },
    });

    await this.dispatch(payout.id, reference);
    const fresh = await walletLedger.balance(userWallet.id);
    const current = await prismaUnscoped.payout.findUnique({ where: { id: payout.id } });
    return {
      payoutId: payout.id,
      status: current?.status ?? 'PROCESSING',
      amount: amount.toFixed(2),
      currency,
      wallet: { balance: fresh.balance.toFixed(2), currency: fresh.currency },
    };
  },

  /**
   * Ask the gateway to move the money. A synchronous failure reverses the
   * ledger immediately; anything else stays PROCESSING until the webhook or
   * reconciliation sweep resolves it.
   */
  async dispatch(payoutId: string, reference: string): Promise<void> {
    const payout = await prismaUnscoped.payout.findUnique({
      where: { id: payoutId },
      include: { payoutAccount: true },
    });
    if (!payout) throw new NotFoundError('Payout');
    const account = payout.payoutAccount;

    try {
      const provider = payoutProvider();
      const result = await provider.initiateTransfer({
        recipientRef: account.providerRef ?? `${account.bankCode}:${decrypt(account.accountNumberEnc)}`,
        // Gateways take the smallest unit; our ledger is in major units.
        amount: Number(payout.netAmount.mul(100).toFixed(0)),
        currency: payout.currency,
        reference,
        reason: 'Vhicasar Pay payout',
        accountNumber: decrypt(account.accountNumberEnc),
        bankCode: account.bankCode ?? undefined,
        accountName: account.accountName,
      });

      await prismaUnscoped.payout.update({
        where: { id: payout.id },
        data: {
          providerRef: result.providerRef,
          status: result.status === 'PAID' ? 'PAID' : result.status === 'FAILED' ? 'FAILED' : 'PROCESSING',
          ...(result.status === 'PAID' ? { processedAt: new Date() } : {}),
        },
      });

      if (result.status === 'PAID') await this.markPaid(payout.id);
      if (result.status === 'FAILED') await this.markFailed(payout.id, result.message ?? 'Gateway rejected the transfer');
    } catch (err) {
      logger.error({ err, payoutId }, 'payout dispatch failed');
      await this.markFailed(payout.id, (err as Error)?.message ?? 'Transfer could not be initiated');
      throw err instanceof AppError
        ? err
        : new AppError('PAYOUT_FAILED', 502, 'The bank transfer could not be started. Your money has been returned.');
    }
  },

  async markPaid(payoutId: string): Promise<void> {
    const updated = await prismaUnscoped.payout.updateMany({
      where: { id: payoutId, status: { in: ['PENDING', 'PROCESSING'] } },
      data: { status: 'PAID', processedAt: new Date() },
    });
    if (updated.count === 0) return; // already settled — keep this idempotent
    metrics.payoutsTotal.inc({ outcome: 'paid' });
    const payout = await prismaUnscoped.payout.findUnique({ where: { id: payoutId } });
    if (!payout) return;

    if (payout.settlementId) {
      await prismaUnscoped.settlement.update({
        where: { id: payout.settlementId },
        data: { status: 'PAID', paidAt: new Date(), payoutRef: payout.providerRef },
      });
    }
    await emitEvent({
      name: 'PayoutPaid',
      aggregateType: 'Payout',
      aggregateId: payout.id,
      payload: {
        vhicasarId: payout.vhicasarId,
        organizationId: payout.organizationId,
        amount: payout.netAmount.toFixed(2),
        currency: payout.currency,
      },
      organizationId: payout.organizationId,
    });
  },

  /**
   * Reverse the reservation and put the money back. Idempotent — a webhook and
   * the reconciliation sweep can both report the same failure.
   */
  async markFailed(payoutId: string, reason: string): Promise<void> {
    const updated = await prismaUnscoped.payout.updateMany({
      where: { id: payoutId, status: { in: ['PENDING', 'PROCESSING'] } },
      data: { status: 'FAILED', failureReason: reason.slice(0, 300), processedAt: new Date() },
    });
    if (updated.count === 0) return;
    metrics.payoutsTotal.inc({ outcome: 'failed' });

    const payout = await prismaUnscoped.payout.findUnique({ where: { id: payoutId } });
    if (!payout) return;

    const clearing = await walletLedger.getOrCreatePlatformWallet('GATEWAY_CLEARING', payout.currency);
    const destination = payout.vhicasarId
      ? await walletLedger.getOrCreateUserWallet(payout.vhicasarId, payout.currency)
      : await walletLedger.getOrCreateOrgWallet(payout.organizationId as string, 'SETTLEMENT_PAYABLE', payout.currency);

    await walletLedger.post({
      type: 'REVERSAL',
      currency: payout.currency,
      amount: payout.netAmount,
      organizationId: payout.organizationId,
      initiatorVhicasarId: payout.vhicasarId,
      description: 'Payout reversed',
      reference: `rev_${payout.id}`,
      idempotencyKey: `payout-reversal:${payout.id}`,
      legs: [
        { walletId: clearing.id, direction: 'DEBIT', amount: payout.netAmount },
        { walletId: destination.id, direction: 'CREDIT', amount: payout.netAmount },
      ],
    });

    if (payout.settlementId) {
      await prismaUnscoped.settlement.update({
        where: { id: payout.settlementId },
        data: { status: 'FAILED' },
      });
    }
    await emitEvent({
      name: 'PayoutFailed',
      aggregateType: 'Payout',
      aggregateId: payout.id,
      payload: {
        vhicasarId: payout.vhicasarId,
        organizationId: payout.organizationId,
        amount: payout.netAmount.toFixed(2),
        currency: payout.currency,
        reason,
      },
      organizationId: payout.organizationId,
    });
  },

  // ---- Merchant settlement payout ----

  /**
   * Pay a settlement out to a verified SettlementAccount (§10).
   *
   * The gateway needs a *recipient*, which lives on PayoutAccount, so this
   * mirrors the settlement destination into one on first use. That keeps a
   * single source of truth for "where does this business get paid" while still
   * satisfying the provider's own model.
   */
  async disburseSettlement(params: {
    settlementId: string;
    organizationId: string;
    settlementAccountId: string;
    amount: Prisma.Decimal;
    currency: string;
  }): Promise<{ reference: string; payoutId: string; status: string }> {
    const provider = payoutProvider();

    const account = await prismaUnscoped.settlementAccount.findFirst({
      where: {
        id: params.settlementAccountId,
        organizationId: params.organizationId,
        deletedAt: null,
        status: 'VERIFIED',
      },
    });
    if (!account) throw new NotFoundError('Verified settlement account');
    if (!account.bankCode) throw new ValidationError('This settlement account has no bank code');

    const accountNumber = decrypt(account.accountNumberEnc);

    // Reuse the gateway recipient when one already exists for this account —
    // creating a new recipient per payout would be rejected as a duplicate.
    let payoutAccount = await prismaUnscoped.payoutAccount.findFirst({
      where: {
        organizationId: params.organizationId,
        deletedAt: null,
        bankCode: account.bankCode,
        accountLast4: account.accountLast4,
        currency: account.currency,
      },
    });

    if (!payoutAccount) {
      const recipient = await provider.createRecipient({
        accountName: account.verifiedName ?? account.accountName,
        accountNumber,
        bankCode: account.bankCode,
        currency: account.currency,
        type: 'BANK_ACCOUNT',
      });
      payoutAccount = await prismaUnscoped.payoutAccount.create({
        data: {
          organizationId: params.organizationId,
          type: 'BANK_ACCOUNT',
          status: 'VERIFIED',
          accountName: account.verifiedName ?? account.accountName,
          accountNumberEnc: account.accountNumberEnc,
          accountLast4: account.accountLast4,
          bankCode: account.bankCode,
          bankName: account.bankName,
          currency: account.currency,
          country: account.country,
          provider: provider.name,
          providerRef: recipient?.recipientRef ?? null,
          verifiedAt: new Date(),
        },
      });
    }

    const reference = `st_${randomBytes(10).toString('hex')}`;
    const payable = await walletLedger.getOrCreateOrgWallet(
      params.organizationId,
      'SETTLEMENT_PAYABLE',
      params.currency
    );
    const clearing = await walletLedger.getOrCreatePlatformWallet('GATEWAY_CLEARING', params.currency);

    const txn = await walletLedger.post({
      type: 'WITHDRAWAL',
      currency: params.currency,
      amount: params.amount,
      organizationId: params.organizationId,
      description: 'Settlement payout to bank',
      reference,
      // Keyed on the settlement so a retry can never pay the same one twice.
      idempotencyKey: `settlement-payout:${params.settlementId}`,
      legs: [
        { walletId: payable.id, direction: 'DEBIT', amount: params.amount },
        { walletId: clearing.id, direction: 'CREDIT', amount: params.amount },
      ],
    });

    const payout = await prismaUnscoped.payout.create({
      data: {
        organizationId: params.organizationId,
        payoutAccountId: payoutAccount.id,
        settlementId: params.settlementId,
        currency: params.currency,
        amount: params.amount,
        netAmount: params.amount,
        status: 'PROCESSING',
        provider: payoutAccount.provider,
        walletTransactionId: txn.id,
        idempotencyKey: `settlement:${params.settlementId}`,
      },
    });

    await this.dispatch(payout.id, reference);
    const current = await prismaUnscoped.payout.findUnique({ where: { id: payout.id } });
    return { reference, payoutId: payout.id, status: current?.status ?? 'PROCESSING' };
  },

  async payoutSettlement(organizationId: string, settlementId: string, payoutAccountId?: string) {
    const settlement = await prismaUnscoped.settlement.findFirst({
      where: { id: settlementId, organizationId },
      include: { payout: true },
    });
    if (!settlement) throw new NotFoundError('Settlement');
    if (settlement.payout) throw new ConflictError('This settlement already has a payout');
    if (settlement.status !== 'PENDING') {
      throw new ConflictError(`Settlement is ${settlement.status.toLowerCase()}`);
    }

    const account = payoutAccountId
      ? await prismaUnscoped.payoutAccount.findFirst({
          where: { id: payoutAccountId, organizationId, deletedAt: null },
        })
      : await prismaUnscoped.payoutAccount.findFirst({
          where: { organizationId, deletedAt: null, isDefault: true },
        });
    if (!account) throw new NotFoundError('Payout account');

    const reference = `st_${randomBytes(10).toString('hex')}`;
    const payable = await walletLedger.getOrCreateOrgWallet(organizationId, 'SETTLEMENT_PAYABLE', settlement.currency);
    const clearing = await walletLedger.getOrCreatePlatformWallet('GATEWAY_CLEARING', settlement.currency);
    const net = money(settlement.netAmount);

    const txn = await walletLedger.post({
      type: 'WITHDRAWAL',
      currency: settlement.currency,
      amount: net,
      organizationId,
      description: 'Settlement payout to bank',
      reference,
      idempotencyKey: `settlement-payout:${settlement.id}`,
      legs: [
        { walletId: payable.id, direction: 'DEBIT', amount: net },
        { walletId: clearing.id, direction: 'CREDIT', amount: net },
      ],
    });

    const payout = await prismaUnscoped.payout.create({
      data: {
        organizationId,
        payoutAccountId: account.id,
        settlementId: settlement.id,
        currency: settlement.currency,
        amount: net,
        netAmount: net,
        status: 'PROCESSING',
        provider: account.provider,
        walletTransactionId: txn.id,
        idempotencyKey: `settlement:${settlement.id}`,
      },
    });
    await prismaUnscoped.settlement.update({
      where: { id: settlement.id },
      data: { status: 'PROCESSING' },
    });

    await this.dispatch(payout.id, reference);
    const current = await prismaUnscoped.payout.findUnique({ where: { id: payout.id } });
    return { payoutId: payout.id, status: current?.status ?? 'PROCESSING', amount: net.toFixed(2) };
  },

  async listPayouts(owner: { vhicasarId?: string; organizationId?: string }, opts: { cursor?: string; limit: number }) {
    const rows = await prismaUnscoped.payout.findMany({
      where: {
        ...(owner.vhicasarId ? { vhicasarId: owner.vhicasarId } : {}),
        ...(owner.organizationId ? { organizationId: owner.organizationId } : {}),
      },
      orderBy: { requestedAt: 'desc' },
      take: opts.limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      include: { payoutAccount: { select: { accountLast4: true, bankName: true } } },
    });
    const hasMore = rows.length > opts.limit;
    const items = hasMore ? rows.slice(0, opts.limit) : rows;
    return {
      items: items.map((p) => ({
        id: p.id,
        amount: p.netAmount.toFixed(2),
        currency: p.currency,
        status: p.status,
        bank: p.payoutAccount.bankName,
        accountNumberMasked: `••••${p.payoutAccount.accountLast4}`,
        requestedAt: p.requestedAt,
        processedAt: p.processedAt,
        failureReason: p.failureReason,
      })),
      nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
    };
  },

  /**
   * Reconciliation sweep: ask the gateway about anything still in flight.
   * Runs on an interval so a missed webhook can't strand a payout.
   */
  async reconcilePending(): Promise<number> {
    const stale = new Date(Date.now() - 60_000);
    const pending = await prismaUnscoped.payout.findMany({
      where: { status: 'PROCESSING', requestedAt: { lt: stale } },
      take: 50,
    });
    let resolved = 0;
    for (const p of pending) {
      if (!p.idempotencyKey && !p.providerRef) continue;
      try {
        const provider = payoutProvider();
        const result = await provider.verifyTransfer(p.idempotencyKey ?? (p.providerRef as string));
        if (result.status === 'PAID') {
          await this.markPaid(p.id);
          resolved += 1;
        } else if (result.status === 'FAILED' || result.status === 'REVERSED') {
          await this.markFailed(p.id, result.message ?? 'Transfer failed at the bank');
          resolved += 1;
        }
      } catch (err) {
        logger.warn({ err, payoutId: p.id }, 'payout reconciliation check failed');
      }
    }
    return resolved;
  },
};
