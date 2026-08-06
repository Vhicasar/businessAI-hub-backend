import type { Prisma, RiskDecision, TrustSubjectType } from '@prisma/client';
import { prisma, prismaUnscoped } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { emitEvent } from '../../shared/domain-events';
import { metrics } from '../../shared/metrics';
import { NotFoundError } from '../../shared/errors';
import { money } from '../../shared/money';

/**
 * Fraud / Trust engine (System Bible III). Scores a payment or transfer from a
 * set of signals, decides ALLOW / REVIEW / BLOCK, records an immutable
 * RiskAssessment, and raises a FraudAlert (manual-review queue) when warranted.
 * Also keeps rolling trust scores for devices, cashiers, merchants and
 * customers, which feed back into scoring.
 *
 * Decision thresholds: score >= 70 → BLOCK, >= 40 → REVIEW, else ALLOW.
 */

const BLOCK_AT = 70;
const REVIEW_AT = 40;
const VELOCITY_WINDOW_MS = 10 * 60 * 1000;

interface Signal {
  code: string;
  points: number;
  detail?: string;
}

export interface AssessInput {
  subjectType: 'PAYMENT_SESSION' | 'TRANSFER' | 'TOPUP';
  subjectId: string;
  vhicasarId: string;
  organizationId?: string | null;
  deviceId?: string | null;
  amount: Prisma.Decimal;
  currency: string;
  /** True when the device proved possession of its registered secure key. */
  deviceVerified?: boolean;
}

export interface AssessResult {
  assessmentId: string;
  score: number;
  decision: RiskDecision;
  reasons: Signal[];
}

async function getTrustScore(subjectType: TrustSubjectType, subjectId: string): Promise<number> {
  const row = await prismaUnscoped.trustScore.findUnique({
    where: { subjectType_subjectId: { subjectType, subjectId } },
    select: { score: true },
  });
  return row?.score ?? 50;
}

export const fraudService = {
  async assess(input: AssessInput): Promise<AssessResult> {
    const signals: Signal[] = [];
    const now = Date.now();

    // 1) Account age
    const identity = await prismaUnscoped.vhicasarId.findUnique({
      where: { id: input.vhicasarId },
      select: { createdAt: true },
    });
    if (identity && now - identity.createdAt.getTime() < 24 * 60 * 60 * 1000) {
      signals.push({ code: 'NEW_ACCOUNT', points: 15, detail: 'Account under 24h old' });
    }

    // 2) Device trust
    if (!input.deviceId) {
      signals.push({ code: 'NO_DEVICE', points: 10, detail: 'No device presented' });
    } else {
      const device = await prismaUnscoped.device.findUnique({
        where: { vhicasarId_deviceId: { vhicasarId: input.vhicasarId, deviceId: input.deviceId } },
        select: { trustLevel: true, revokedAt: true },
      });
      if (!device || device.revokedAt) {
        signals.push({ code: 'UNRECOGNIZED_DEVICE', points: 25, detail: 'Device not registered' });
      } else if (device.trustLevel === 'UNTRUSTED') {
        signals.push({ code: 'UNTRUSTED_DEVICE', points: 15 });
      }
      // A cryptographic proof of possession is much stronger evidence than a
      // device id alone, so it earns back risk points.
      if (input.deviceVerified) {
        signals.push({ code: 'DEVICE_SIGNATURE_VERIFIED', points: -15, detail: 'Signed by registered device key' });
      }
    }

    // 3) Velocity + recent failures
    const since = new Date(now - VELOCITY_WINDOW_MS);
    const [recentAttempts, recentFailures] = await Promise.all([
      prismaUnscoped.paymentAttempt.count({ where: { vhicasarId: input.vhicasarId, createdAt: { gte: since } } }),
      prismaUnscoped.paymentAttempt.count({
        where: { vhicasarId: input.vhicasarId, status: 'FAILED', createdAt: { gte: since } },
      }),
    ]);
    if (recentAttempts > 5) signals.push({ code: 'HIGH_VELOCITY', points: 25, detail: `${recentAttempts} attempts/10m` });
    if (recentFailures >= 3) signals.push({ code: 'REPEATED_FAILURES', points: 20, detail: `${recentFailures} failures/10m` });

    // 4) Amount
    const amt = money(input.amount);
    if (amt.greaterThanOrEqualTo(500000)) signals.push({ code: 'VERY_HIGH_AMOUNT', points: 30 });
    else if (amt.greaterThanOrEqualTo(100000)) signals.push({ code: 'HIGH_AMOUNT', points: 15 });

    // 5) Customer trust
    const customerTrust = await getTrustScore('CUSTOMER', input.vhicasarId);
    if (customerTrust < 30) signals.push({ code: 'LOW_CUSTOMER_TRUST', points: 20, detail: `trust=${customerTrust}` });

    const score = Math.min(100, signals.reduce((s, x) => s + x.points, 0));
    const decision: RiskDecision = score >= BLOCK_AT ? 'BLOCK' : score >= REVIEW_AT ? 'REVIEW' : 'ALLOW';

    const assessment = await prismaUnscoped.riskAssessment.create({
      data: {
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        vhicasarId: input.vhicasarId,
        organizationId: input.organizationId ?? null,
        deviceId: input.deviceId ?? null,
        score,
        decision,
        reasons: signals as unknown as Prisma.InputJsonValue,
      },
    });
    metrics.fraudDecisions.inc({ decision });

    if (decision !== 'ALLOW') {
      const severity = score >= 85 ? 'CRITICAL' : score >= BLOCK_AT ? 'HIGH' : 'MEDIUM';
      const alert = await prismaUnscoped.fraudAlert.create({
        data: {
          organizationId: input.organizationId ?? null,
          vhicasarId: input.vhicasarId,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          severity,
          score,
          reasons: signals as unknown as Prisma.InputJsonValue,
        },
      });
      await emitEvent({
        name: 'FraudAlertCreated',
        aggregateType: 'FraudAlert',
        aggregateId: alert.id,
        payload: { score, decision, severity },
        organizationId: input.organizationId ?? null,
      });
      if (decision === 'BLOCK') {
        await emitEvent({
          name: 'TransactionBlocked',
          aggregateType: input.subjectType,
          aggregateId: input.subjectId,
          payload: { score, reasons: signals.map((s) => s.code) },
          organizationId: input.organizationId ?? null,
        });
      }
    }

    return { assessmentId: assessment.id, score, decision, reasons: signals };
  },

  /** Nudge a rolling trust score and clamp to 0..100. */
  async bumpTrust(subjectType: TrustSubjectType, subjectId: string, delta: number): Promise<number> {
    const current = await prismaUnscoped.trustScore.findUnique({
      where: { subjectType_subjectId: { subjectType, subjectId } },
      select: { score: true },
    });
    const next = Math.max(0, Math.min(100, (current?.score ?? 50) + delta));
    await prismaUnscoped.trustScore.upsert({
      where: { subjectType_subjectId: { subjectType, subjectId } },
      create: { subjectType, subjectId, score: next, lastEventAt: new Date() },
      update: { score: next, lastEventAt: new Date() },
    });
    await emitEvent({
      name: 'RiskScoreUpdated',
      aggregateType: 'TrustScore',
      aggregateId: `${subjectType}:${subjectId}`,
      payload: { subjectType, subjectId, score: next },
      organizationId: null,
    });
    return next;
  },

  /** Feed the outcome of a payment back into trust scores. */
  async recordPaymentOutcome(
    outcome: 'SUCCESS' | 'BLOCKED',
    ctx: { vhicasarId: string; deviceId?: string | null; organizationId?: string | null }
  ): Promise<void> {
    if (outcome === 'SUCCESS') {
      await this.bumpTrust('CUSTOMER', ctx.vhicasarId, 2);
      if (ctx.deviceId) await this.bumpTrust('DEVICE', `${ctx.vhicasarId}:${ctx.deviceId}`, 3);
      if (ctx.organizationId) await this.bumpTrust('MERCHANT', ctx.organizationId, 1);
    } else {
      await this.bumpTrust('CUSTOMER', ctx.vhicasarId, -15);
      if (ctx.deviceId) await this.bumpTrust('DEVICE', `${ctx.vhicasarId}:${ctx.deviceId}`, -10);
    }
  },

  // ---- Manual review queue (Fraud Center) ----

  async listAlerts(opts: { status?: string; cursor?: string; limit: number }) {
    const rows = await prisma.fraudAlert.findMany({
      where: { ...(opts.status ? { status: opts.status as never } : {}) },
      orderBy: { createdAt: 'desc' },
      take: opts.limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > opts.limit;
    const items = hasMore ? rows.slice(0, opts.limit) : rows;
    return {
      items,
      nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
    };
  },

  async getAlert(id: string) {
    const alert = await prisma.fraudAlert.findUnique({ where: { id } });
    if (!alert) throw new NotFoundError('Fraud alert');
    const assessments = await prismaUnscoped.riskAssessment.findMany({
      where: { subjectType: alert.subjectType, subjectId: alert.subjectId },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
    return { ...alert, assessments };
  },

  async resolveAlert(id: string, action: 'CONFIRMED' | 'DISMISSED', resolution?: string) {
    const alert = await prisma.fraudAlert.findUnique({ where: { id } });
    if (!alert) throw new NotFoundError('Fraud alert');
    const ctx = requestContext.get();
    const updated = await prisma.fraudAlert.update({
      where: { id },
      data: {
        status: action,
        resolution: resolution ?? null,
        assignedToMembershipId: ctx?.membershipId ?? null,
        resolvedAt: new Date(),
      },
    });
    // A confirmed fraud further erodes the customer's trust.
    if (action === 'CONFIRMED' && alert.vhicasarId) {
      await this.bumpTrust('CUSTOMER', alert.vhicasarId, -25);
    }
    return updated;
  },
};
