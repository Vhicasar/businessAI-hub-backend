import { Prisma } from '@prisma/client';
import type { SettlementSchedule, Settlement } from '@prisma/client';

import { prisma, prismaUnscoped } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { emitEvent } from '../../shared/domain-events';
import { AppError, NotFoundError, ValidationError } from '../../shared/errors';
import { logger } from '../../shared/logger';
import { money, ZERO } from '../../shared/money';
import { auditService } from '../audit/audit.service';
import { notifyBusiness } from '../notifications/notify';
import { walletLedger } from './wallet-ledger.service';
import { settlementAccounts } from './settlement-accounts.service';

/** Defaults for an organization that has never configured a rule. */
export const DEFAULT_RULE = {
  schedule: 'DAILY' as SettlementSchedule,
  runAtHour: 2,
  runOnWeekday: null as number | null,
  feePercent: new Prisma.Decimal(0),
  feeFlat: new Prisma.Decimal(0),
  taxPercent: new Prisma.Decimal(0),
  reservePercent: new Prisma.Decimal(0),
  reserveDays: 0,
  minimumAmount: new Prisma.Decimal(0),
  approvalThreshold: null as Prisma.Decimal | null,
  requiresDualApproval: false,
  delayHours: 0,
};

/**
 * Above this score the engine holds a settlement for a human (§11).
 *
 * Set so that the classic payout-fraud pattern — a settlement account added in
 * the last 24 hours (40) *and* a destination change in the last 48 (25) — trips
 * it. Those two together are exactly the case that must never pay out silently.
 */
const RISK_HOLD_THRESHOLD = 60;

function orgId(): string {
  const id = requestContext.get()?.organizationId;
  if (!id) throw new AppError('NO_TENANT', 403, 'Organization context required');
  return id;
}

function nextRunAt(rule: { schedule: SettlementSchedule; runAtHour: number; runOnWeekday: number | null }): Date {
  const now = new Date();
  switch (rule.schedule) {
    case 'INSTANT':
      return now;
    case 'HOURLY': {
      const next = new Date(now);
      next.setMinutes(0, 0, 0);
      next.setHours(next.getHours() + 1);
      return next;
    }
    case 'WEEKLY': {
      const next = new Date(now);
      next.setHours(rule.runAtHour, 0, 0, 0);
      const target = rule.runOnWeekday ?? 1;
      // Always land on the *next* occurrence, never today if it has passed.
      let delta = (target - next.getDay() + 7) % 7;
      if (delta === 0 && next <= now) delta = 7;
      next.setDate(next.getDate() + delta);
      return next;
    }
    case 'MANUAL':
      // Never scheduled; a human releases it.
      return new Date(8640000000000000);
    case 'DAILY':
    default: {
      const next = new Date(now);
      next.setHours(rule.runAtHour, 0, 0, 0);
      if (next <= now) next.setDate(next.getDate() + 1);
      return next;
    }
  }
}

/**
 * How risky this settlement looks (§11).
 *
 * Deliberately simple and explainable: an operator reading the reasons must be
 * able to tell why a payout was held. Each signal adds points; the reasons are
 * stored alongside so the decision is never a black box.
 */
async function riskScore(params: {
  organizationId: string;
  amount: Prisma.Decimal;
  currency: string;
  settlementAccountId: string | null;
}): Promise<{ score: number; reasons: string[] }> {
  const reasons: string[] = [];
  let score = 0;

  const account = params.settlementAccountId
    ? await prismaUnscoped.settlementAccount.findUnique({ where: { id: params.settlementAccountId } })
    : null;

  if (!account) {
    score += 60;
    reasons.push('No verified settlement destination');
  } else {
    // A destination that was only just added, or only just changed, is the
    // classic payout-fraud signature.
    const ageDays = (Date.now() - account.createdAt.getTime()) / 86_400_000;
    if (ageDays < 1) {
      score += 40;
      reasons.push('Settlement account added within the last 24 hours');
    } else if (ageDays < 7) {
      score += 20;
      reasons.push('Settlement account is less than a week old');
    }

    const recentChange = await prismaUnscoped.settlementAccountChange.findFirst({
      where: {
        organizationId: params.organizationId,
        action: { in: ['SET_DEFAULT', 'CREATED'] },
        createdAt: { gte: new Date(Date.now() - 48 * 3_600_000) },
      },
    });
    if (recentChange) {
      score += 25;
      reasons.push('Settlement destination changed in the last 48 hours');
    }
  }

  // Velocity: an unusual number of settlements in a short window.
  const recentCount = await prismaUnscoped.settlement.count({
    where: {
      organizationId: params.organizationId,
      createdAt: { gte: new Date(Date.now() - 3_600_000) },
    },
  });
  if (recentCount >= 5) {
    score += 20;
    reasons.push(`${recentCount} settlements in the last hour`);
  }

  // Amount well outside this organization's own norm.
  const history = await prismaUnscoped.settlement.aggregate({
    where: { organizationId: params.organizationId, status: 'PAID', currency: params.currency },
    _avg: { netAmount: true },
    _count: { _all: true },
  });
  const average = history._avg.netAmount;
  if (history._count._all >= 3 && average && average.greaterThan(ZERO)) {
    if (params.amount.greaterThan(average.times(5))) {
      score += 25;
      reasons.push('Amount is more than five times this business’s average settlement');
    }
  }

  const open = await prismaUnscoped.chargeback.count({
    where: { organizationId: params.organizationId, status: 'OPENED' },
  });
  if (open > 0) {
    score += 15;
    reasons.push(`${open} open chargeback(s)`);
  }

  return { score: Math.min(100, score), reasons };
}

export const settlementEngine = {
  DEFAULT_RULE,
  RISK_HOLD_THRESHOLD,

  /** The rule in force for an organization/branch/currency (§10). */
  async ruleFor(organizationId: string, opts: { branchId?: string | null; currency?: string } = {}) {
    const rules = await prismaUnscoped.settlementRule.findMany({
      where: { organizationId, isActive: true },
    });
    // Most specific wins: branch+currency, then branch, then currency, then the
    // organization-wide rule, then platform defaults.
    const match =
      rules.find((r) => r.branchId === opts.branchId && r.currency === opts.currency) ??
      rules.find((r) => r.branchId === opts.branchId && r.currency === null) ??
      rules.find((r) => r.branchId === null && r.currency === opts.currency) ??
      rules.find((r) => r.branchId === null && r.currency === null);

    return match ?? { ...DEFAULT_RULE, id: null, organizationId, branchId: null, currency: null, isActive: true };
  },

  async upsertRule(dto: {
    branchId?: string | null;
    currency?: string | null;
    schedule?: SettlementSchedule;
    runAtHour?: number;
    runOnWeekday?: number | null;
    feePercent?: number;
    feeFlat?: number;
    taxPercent?: number;
    reservePercent?: number;
    reserveDays?: number;
    minimumAmount?: number;
    approvalThreshold?: number | null;
    requiresDualApproval?: boolean;
    delayHours?: number;
    isActive?: boolean;
  }) {
    const organizationId = orgId();
    const branchId = dto.branchId ?? null;
    const currency = dto.currency?.toUpperCase() ?? null;

    const data = {
      ...(dto.schedule ? { schedule: dto.schedule } : {}),
      ...(dto.runAtHour !== undefined ? { runAtHour: dto.runAtHour } : {}),
      ...(dto.runOnWeekday !== undefined ? { runOnWeekday: dto.runOnWeekday } : {}),
      ...(dto.feePercent !== undefined ? { feePercent: new Prisma.Decimal(dto.feePercent) } : {}),
      ...(dto.feeFlat !== undefined ? { feeFlat: new Prisma.Decimal(dto.feeFlat) } : {}),
      ...(dto.taxPercent !== undefined ? { taxPercent: new Prisma.Decimal(dto.taxPercent) } : {}),
      ...(dto.reservePercent !== undefined ? { reservePercent: new Prisma.Decimal(dto.reservePercent) } : {}),
      ...(dto.reserveDays !== undefined ? { reserveDays: dto.reserveDays } : {}),
      ...(dto.minimumAmount !== undefined ? { minimumAmount: new Prisma.Decimal(dto.minimumAmount) } : {}),
      ...(dto.approvalThreshold !== undefined
        ? { approvalThreshold: dto.approvalThreshold === null ? null : new Prisma.Decimal(dto.approvalThreshold) }
        : {}),
      ...(dto.requiresDualApproval !== undefined ? { requiresDualApproval: dto.requiresDualApproval } : {}),
      ...(dto.delayHours !== undefined ? { delayHours: dto.delayHours } : {}),
      ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
    };

    // Postgres treats NULLs as distinct in a unique index, so the composite
    // unique cannot enforce "one org-wide rule" and Prisma cannot upsert
    // through it either. Find-then-write does both jobs honestly.
    const existing = await prismaUnscoped.settlementRule.findFirst({
      where: { organizationId, branchId, currency },
    });

    const rule = existing
      ? await prismaUnscoped.settlementRule.update({ where: { id: existing.id }, data })
      : await prismaUnscoped.settlementRule.create({
          data: { organizationId, branchId, currency, ...data },
        });

    await auditService.record({
      action: 'settlement_rule.updated',
      entityType: 'SettlementRule',
      entityId: rule.id,
      after: data as Record<string, unknown>,
    });

    return rule;
  },

  /**
   * Work out what is owed and record a settlement (§10).
   *
   * Money moves from the merchant wallet into the platform's settlement-payable
   * account at this point — so the balance a business sees as "available" and
   * what is queued to pay out can never double-count.
   */
  async calculate(params: {
    organizationId: string;
    currency: string;
    branchId?: string | null;
    /** Settle everything available rather than a specific amount. */
    amount?: Prisma.Decimal;
  }) {
    const currency = params.currency.toUpperCase();
    const rule = await this.ruleFor(params.organizationId, { branchId: params.branchId, currency });

    const merchantWallet = await walletLedger.getOrCreateOrgWallet(params.organizationId, 'MERCHANT', currency);
    const gross = params.amount ?? merchantWallet.balance;

    if (!gross.greaterThan(ZERO)) {
      throw new AppError('NOTHING_TO_SETTLE', 400, 'There is nothing available to settle right now.');
    }
    if (gross.greaterThan(merchantWallet.balance)) {
      throw new ValidationError('That is more than the available balance');
    }
    if (gross.lessThan(rule.minimumAmount)) {
      throw new AppError(
        'BELOW_MINIMUM',
        400,
        `Settlements start at ${currency} ${rule.minimumAmount.toFixed(2)}.`
      );
    }

    // Fees and tax come off the gross; the reserve is held back from what is
    // left, so the business is never charged tax on money it did not receive.
    const feeAmount = money(gross.times(rule.feePercent).dividedBy(100).plus(rule.feeFlat).toFixed(2));
    const taxable = gross.minus(feeAmount);
    const taxAmount = money(taxable.times(rule.taxPercent).dividedBy(100).toFixed(2));
    const afterFees = taxable.minus(taxAmount);
    const reserveAmount = money(afterFees.times(rule.reservePercent).dividedBy(100).toFixed(2));
    const netAmount = afterFees.minus(reserveAmount);

    if (!netAmount.greaterThan(ZERO)) {
      throw new AppError('NOTHING_TO_SETTLE', 400, 'Fees and reserve leave nothing to settle.');
    }

    const destination = await settlementAccounts.resolveDestination(params.organizationId, {
      branchId: params.branchId,
      currency,
    });

    const { score, reasons } = await riskScore({
      organizationId: params.organizationId,
      amount: netAmount,
      currency,
      settlementAccountId: destination?.id ?? null,
    });

    // Delay rules push the earliest execution out; the schedule decides the
    // normal cadence. Whichever is later wins.
    const scheduled = nextRunAt(rule);
    const delayed = new Date(Date.now() + rule.delayHours * 3_600_000);
    const scheduledFor = scheduled > delayed ? scheduled : delayed;

    const needsApproval =
      rule.schedule === 'MANUAL' ||
      rule.requiresDualApproval ||
      (rule.approvalThreshold !== null && netAmount.greaterThanOrEqualTo(rule.approvalThreshold));

    const status = !destination
      ? 'ON_HOLD'
      : score >= RISK_HOLD_THRESHOLD
        ? 'ON_HOLD'
        : needsApproval
          ? 'AWAITING_APPROVAL'
          : 'PENDING';

    // Move the money out of the spendable merchant balance as the settlement is
    // recorded, in one transaction — otherwise the same funds could be settled
    // twice by two concurrent runs.
    // Per-organization payable, not the platform one: this is *this merchant's*
    // money awaiting payout, and payoutService debits the same account when it
    // actually pays out. Crediting the platform account here instead would
    // leave every merchant's payable drifting negative.
    const payable = await walletLedger.getOrCreateOrgWallet(params.organizationId, 'SETTLEMENT_PAYABLE', currency);
    const txn = await walletLedger.post({
      type: 'SETTLEMENT',
      currency,
      amount: gross,
      organizationId: params.organizationId,
      description: `Settlement (${rule.schedule})`,
      legs: [
        { walletId: merchantWallet.id, direction: 'DEBIT', amount: gross },
        { walletId: payable.id, direction: 'CREDIT', amount: gross },
      ],
    });

    const settlement = await prismaUnscoped.settlement.create({
      data: {
        organizationId: params.organizationId,
        branchId: params.branchId ?? null,
        settlementAccountId: destination?.id ?? null,
        currency,
        grossAmount: gross,
        feeAmount,
        taxAmount,
        reserveAmount,
        netAmount,
        status,
        scheduledFor: rule.schedule === 'MANUAL' ? null : scheduledFor,
        reserveReleaseAt:
          rule.reserveDays > 0 ? new Date(Date.now() + rule.reserveDays * 86_400_000) : null,
        requiresApproval: needsApproval,
        riskScore: score,
        failureReason: !destination
          ? 'No verified settlement account for this currency'
          : score >= RISK_HOLD_THRESHOLD
            ? `Held for review: ${reasons.join('; ')}`
            : null,
        items: { create: [{ walletTransactionId: txn.id, amount: gross }] },
      },
    });

    await emitEvent({
      name: 'SettlementCreated',
      aggregateType: 'Settlement',
      aggregateId: settlement.id,
      payload: {
        amount: netAmount.toFixed(2),
        currency,
        status,
        riskScore: score,
        organizationId: params.organizationId,
      },
      organizationId: params.organizationId,
    });

    await auditService.record({
      action: 'settlement.created',
      entityType: 'Settlement',
      entityId: settlement.id,
      after: {
        gross: gross.toFixed(2),
        fee: feeAmount.toFixed(2),
        tax: taxAmount.toFixed(2),
        reserve: reserveAmount.toFixed(2),
        net: netAmount.toFixed(2),
        status,
        riskScore: score,
        riskReasons: reasons,
      },
    });

    if (status === 'ON_HOLD' || status === 'AWAITING_APPROVAL') {
      await notifyBusiness({
        organizationId: params.organizationId,
        type: 'settlement.needs_attention',
        title: status === 'ON_HOLD' ? 'A settlement is on hold' : 'A settlement needs approval',
        body:
          status === 'ON_HOLD'
            ? `${currency} ${netAmount.toFixed(2)} is held: ${reasons.join('; ') || 'no verified settlement account'}.`
            : `${currency} ${netAmount.toFixed(2)} is waiting for approval before it is paid out.`,
        link: '/settings/settlement',
      });
    }

    return { settlement, riskReasons: reasons };
  },

  /** Approve a held settlement. Dual approval needs two different people. */
  async approve(id: string) {
    const organizationId = orgId();
    const userId = requestContext.get()?.userId ?? null;
    const settlement = await prismaUnscoped.settlement.findFirst({ where: { id, organizationId } });
    if (!settlement) throw new NotFoundError('Settlement');
    if (settlement.status !== 'AWAITING_APPROVAL' && settlement.status !== 'ON_HOLD') {
      throw new ValidationError('That settlement is not waiting for approval');
    }

    const rule = await this.ruleFor(organizationId, {
      branchId: settlement.branchId,
      currency: settlement.currency,
    });

    if (rule.requiresDualApproval) {
      if (!settlement.approvedByUserId) {
        const first = await prismaUnscoped.settlement.update({
          where: { id },
          data: { approvedByUserId: userId, approvedAt: new Date() },
        });
        await auditService.record({
          action: 'settlement.approved_first',
          entityType: 'Settlement',
          entityId: id,
        });
        return { settlement: first, awaitingSecondApproval: true };
      }
      // The whole point of dual approval is that one compromised account
      // cannot release money on its own.
      if (settlement.approvedByUserId === userId) {
        throw new AppError(
          'SECOND_APPROVER_REQUIRED',
          403,
          'This settlement needs a second person to approve it.'
        );
      }
      const approved = await prismaUnscoped.settlement.update({
        where: { id },
        data: { secondApproverUserId: userId, secondApprovedAt: new Date(), status: 'PENDING' },
      });
      await auditService.record({ action: 'settlement.approved', entityType: 'Settlement', entityId: id });
      return { settlement: approved, awaitingSecondApproval: false };
    }

    const approved = await prismaUnscoped.settlement.update({
      where: { id },
      data: { approvedByUserId: userId, approvedAt: new Date(), status: 'PENDING' },
    });
    await auditService.record({ action: 'settlement.approved', entityType: 'Settlement', entityId: id });
    return { settlement: approved, awaitingSecondApproval: false };
  },

  async cancel(id: string, reason: string) {
    const organizationId = orgId();
    const settlement = await prismaUnscoped.settlement.findFirst({ where: { id, organizationId } });
    if (!settlement) throw new NotFoundError('Settlement');
    if (settlement.status === 'PAID') throw new ValidationError('That settlement has already been paid');

    // Put the money back where it came from — a cancelled settlement must not
    // leave funds stranded in the payable account.
    const merchantWallet = await walletLedger.getOrCreateOrgWallet(
      organizationId,
      'MERCHANT',
      settlement.currency
    );
    const payable = await walletLedger.getOrCreateOrgWallet(
      organizationId,
      'SETTLEMENT_PAYABLE',
      settlement.currency
    );
    await walletLedger.post({
      type: 'SETTLEMENT',
      currency: settlement.currency,
      amount: settlement.grossAmount,
      organizationId,
      description: `Settlement cancelled: ${reason}`,
      legs: [
        { walletId: payable.id, direction: 'DEBIT', amount: settlement.grossAmount },
        { walletId: merchantWallet.id, direction: 'CREDIT', amount: settlement.grossAmount },
      ],
    });

    const cancelled = await prismaUnscoped.settlement.update({
      where: { id },
      data: { status: 'CANCELLED', failureReason: reason },
    });
    await auditService.record({
      action: 'settlement.cancelled',
      entityType: 'Settlement',
      entityId: id,
      after: { reason },
    });
    return cancelled;
  },

  /**
   * Execute one settlement — the point where money actually leaves (§10).
   *
   * Guarded so a settlement can only be executed from PENDING: two workers
   * racing on the same row cannot both pay it out.
   */
  async execute(id: string): Promise<Settlement> {
    const claimed = await prismaUnscoped.settlement.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'PROCESSING', attempts: { increment: 1 } },
    });
    if (claimed.count === 0) {
      const current = await prismaUnscoped.settlement.findUnique({ where: { id } });
      throw new AppError(
        'SETTLEMENT_NOT_PAYABLE',
        409,
        `This settlement is ${current?.status.toLowerCase() ?? 'missing'} and cannot be executed.`
      );
    }

    const settlement = await prismaUnscoped.settlement.findUniqueOrThrow({ where: { id } });

    try {
      if (!settlement.settlementAccountId) {
        throw new Error('No verified settlement account');
      }

      const { payoutService } = await import('./payout.service');
      const result = await payoutService.disburseSettlement({
        settlementId: settlement.id,
        organizationId: settlement.organizationId,
        settlementAccountId: settlement.settlementAccountId,
        amount: settlement.netAmount,
        currency: settlement.currency,
      });

      const paid = await prismaUnscoped.settlement.update({
        where: { id },
        data: { status: 'PAID', paidAt: new Date(), payoutRef: result.reference, failureReason: null },
      });

      await emitEvent({
        name: 'SettlementPaid',
        aggregateType: 'Settlement',
        aggregateId: id,
        payload: { amount: settlement.netAmount.toFixed(2), currency: settlement.currency },
        organizationId: settlement.organizationId,
      });
      await notifyBusiness({
        organizationId: settlement.organizationId,
        type: 'settlement.completed',
        title: 'Settlement paid out',
        body: `${settlement.currency} ${settlement.netAmount.toFixed(2)} is on its way to your bank account.`,
        link: '/settings/settlement',
      });
      await auditService.record({ action: 'settlement.paid', entityType: 'Settlement', entityId: id });

      return paid;
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'Settlement execution failed';
      logger.error({ err, settlementId: id }, 'Settlement execution failed');

      const failed = await prismaUnscoped.settlement.update({
        where: { id },
        data: { status: 'FAILED', failureReason: reason },
      });

      await emitEvent({
        name: 'SettlementFailed',
        aggregateType: 'Settlement',
        aggregateId: id,
        payload: { reason, currency: settlement.currency, amount: settlement.netAmount.toFixed(2) },
        organizationId: settlement.organizationId,
      });
      await notifyBusiness({
        organizationId: settlement.organizationId,
        type: 'settlement.failed',
        title: 'A settlement failed',
        body: `${settlement.currency} ${settlement.netAmount.toFixed(2)} could not be paid out: ${reason}`,
        link: '/settings/settlement',
      });
      await auditService.record({
        action: 'settlement.failed',
        entityType: 'Settlement',
        entityId: id,
        after: { reason },
      });

      return failed;
    }
  },

  /**
   * Run every settlement that has come due. Called by the scheduler.
   *
   * Each one is executed independently so a single failure cannot stop the
   * queue behind it.
   */
  async runDue(limit = 25) {
    const due = await prismaUnscoped.settlement.findMany({
      where: { status: 'PENDING', scheduledFor: { lte: new Date() } },
      orderBy: { scheduledFor: 'asc' },
      take: limit,
      select: { id: true },
    });

    const results: { id: string; status: string }[] = [];
    for (const row of due) {
      try {
        const done = await this.execute(row.id);
        results.push({ id: row.id, status: done.status });
      } catch (err) {
        logger.error({ err, settlementId: row.id }, 'Settlement run failed');
        results.push({ id: row.id, status: 'ERROR' });
      }
    }
    return { processed: results.length, results };
  },

  /** The business-facing dashboard figures (§12). */
  async dashboard(currency = 'NGN') {
    const organizationId = orgId();
    const cur = currency.toUpperCase();
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const startOfWeek = new Date(startOfDay);
    startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());

    const merchantWallet = await walletLedger.getOrCreateOrgWallet(organizationId, 'MERCHANT', cur);

    const [pending, today, week, fees, failed, recent] = await Promise.all([
      prismaUnscoped.settlement.aggregate({
        where: { organizationId, currency: cur, status: { in: ['PENDING', 'AWAITING_APPROVAL', 'ON_HOLD', 'PROCESSING'] } },
        _sum: { netAmount: true },
        _count: { _all: true },
      }),
      prismaUnscoped.settlement.aggregate({
        where: { organizationId, currency: cur, status: 'PAID', paidAt: { gte: startOfDay } },
        _sum: { netAmount: true },
        _count: { _all: true },
      }),
      prismaUnscoped.settlement.aggregate({
        where: { organizationId, currency: cur, status: 'PAID', paidAt: { gte: startOfWeek } },
        _sum: { netAmount: true },
        _count: { _all: true },
      }),
      prismaUnscoped.settlement.aggregate({
        where: { organizationId, currency: cur, status: 'PAID' },
        _sum: { feeAmount: true, taxAmount: true, reserveAmount: true },
      }),
      prismaUnscoped.settlement.findMany({
        where: { organizationId, currency: cur, status: 'FAILED' },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true, netAmount: true, currency: true, failureReason: true, attempts: true, createdAt: true },
      }),
      prismaUnscoped.settlement.findMany({
        where: { organizationId, currency: cur },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    ]);

    const rule = await this.ruleFor(organizationId, { currency: cur });
    const destination = await settlementAccounts.resolveDestination(organizationId, { currency: cur });

    return {
      currency: cur,
      availableBalance: merchantWallet.balance.toFixed(2),
      pendingSettlement: { total: (pending._sum.netAmount ?? ZERO).toFixed(2), count: pending._count._all },
      settledToday: { total: (today._sum.netAmount ?? ZERO).toFixed(2), count: today._count._all },
      settledThisWeek: { total: (week._sum.netAmount ?? ZERO).toFixed(2), count: week._count._all },
      processingFees: {
        fees: (fees._sum.feeAmount ?? ZERO).toFixed(2),
        tax: (fees._sum.taxAmount ?? ZERO).toFixed(2),
        reserveHeld: (fees._sum.reserveAmount ?? ZERO).toFixed(2),
      },
      failedSettlements: failed.map((f) => ({
        id: f.id,
        amount: f.netAmount.toFixed(2),
        currency: f.currency,
        reason: f.failureReason,
        attempts: f.attempts,
        createdAt: f.createdAt,
      })),
      schedule: {
        schedule: rule.schedule,
        runAtHour: rule.runAtHour,
        delayHours: rule.delayHours,
        requiresDualApproval: rule.requiresDualApproval,
        minimumAmount: rule.minimumAmount.toFixed(2),
      },
      destination: destination
        ? { id: destination.id, bankName: destination.bankName, last4: destination.accountLast4 }
        : null,
      history: recent.map((s) => ({
        id: s.id,
        status: s.status,
        gross: s.grossAmount.toFixed(2),
        fee: s.feeAmount.toFixed(2),
        tax: s.taxAmount.toFixed(2),
        reserve: s.reserveAmount.toFixed(2),
        net: s.netAmount.toFixed(2),
        currency: s.currency,
        riskScore: s.riskScore,
        scheduledFor: s.scheduledFor,
        paidAt: s.paidAt,
        failureReason: s.failureReason,
        createdAt: s.createdAt,
      })),
    };
  },
};
