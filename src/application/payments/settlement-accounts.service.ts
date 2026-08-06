import type { SettlementAccountType, SettlementAccountStatus, Prisma } from '@prisma/client';

import { prisma, prismaUnscoped } from '../../infrastructure/database/prisma';
import { getActivePaymentProvider } from '../../infrastructure/payments';
import { supportsPayouts } from '../../infrastructure/payments/types';
import { requestContext } from '../../shared/context';
import { encrypt, sha256 } from '../../shared/crypto';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../../shared/errors';
import { logger } from '../../shared/logger';
import { currencyForCountry } from '../../shared/currency';
import { auditService } from '../audit/audit.service';
import { notifyBusiness } from '../notifications/notify';
import { mailer } from '../../infrastructure/mail/mailer';

function orgId(): string {
  const id = requestContext.get()?.organizationId;
  if (!id) throw new AppError('NO_TENANT', 403, 'Organization context required');
  return id;
}

/**
 * A stable identifier for "this bank account", derived without keeping the
 * number in the clear (§9).
 *
 * Lets duplicates and blacklist hits be detected by comparison alone — nothing
 * has to be decrypted to answer "have we seen this account before?".
 */
export function accountFingerprint(country: string, bankCode: string | null, accountNumber: string): string {
  return sha256(`${country.toUpperCase()}|${(bankCode ?? '').toUpperCase()}|${accountNumber.replace(/\D/g, '')}`);
}

/** How closely the bank's name has to match what the business typed. */
function namesAgree(claimed: string, verified: string): boolean {
  const normalise = (v: string) =>
    v.toLowerCase().replace(/[^a-z ]/g, '').split(/\s+/).filter(Boolean).sort().join(' ');
  const a = normalise(claimed);
  const b = normalise(verified);
  if (a === b) return true;
  // Banks routinely return names in a different order or with a middle name
  // the business omitted, so require substantial word overlap rather than
  // an exact string match.
  const aWords = new Set(a.split(' '));
  const bWords = b.split(' ');
  const shared = bWords.filter((w) => aWords.has(w)).length;
  return shared >= Math.min(2, bWords.length);
}

export interface SettlementAccountInput {
  type?: SettlementAccountType;
  branchId?: string | null;
  businessUnit?: string | null;
  bankName?: string;
  bankCode?: string;
  accountNumber: string;
  accountName: string;
  country: string;
  currency: string;
  priority?: number;
  isDefault?: boolean;
}

function publicView(row: {
  id: string;
  type: SettlementAccountType;
  status: SettlementAccountStatus;
  bankName: string | null;
  bankCode: string | null;
  accountLast4: string;
  accountName: string;
  verifiedName: string | null;
  country: string;
  currency: string;
  priority: number;
  isDefault: boolean;
  branchId: string | null;
  businessUnit: string | null;
  verifiedAt: Date | null;
  rejectionReason: string | null;
  createdAt: Date;
}) {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    bankName: row.bankName,
    bankCode: row.bankCode,
    /** Never the full number — only ever the last four digits. */
    accountNumberMasked: `••••${row.accountLast4}`,
    accountName: row.accountName,
    verifiedName: row.verifiedName,
    country: row.country,
    currency: row.currency,
    priority: row.priority,
    isDefault: row.isDefault,
    branchId: row.branchId,
    businessUnit: row.businessUnit,
    verifiedAt: row.verifiedAt,
    rejectionReason: row.rejectionReason,
    isUsable: row.status === 'VERIFIED',
    createdAt: row.createdAt,
  };
}

/**
 * Write the change trail §11 requires, and tell the people who need to know.
 *
 * Recorded before anything else can fail, so a change can never happen without
 * a corresponding record.
 */
async function recordChange(params: {
  settlementAccountId: string;
  organizationId: string;
  action: string;
  before?: unknown;
  after?: unknown;
  ip?: string;
  deviceId?: string;
  notify?: { title: string; body: string };
}) {
  const ctx = requestContext.get();
  await prismaUnscoped.settlementAccountChange.create({
    data: {
      settlementAccountId: params.settlementAccountId,
      organizationId: params.organizationId,
      action: params.action,
      before: (params.before ?? undefined) as Prisma.InputJsonValue | undefined,
      after: (params.after ?? undefined) as Prisma.InputJsonValue | undefined,
      actorUserId: ctx?.userId ?? null,
      // The request context does not carry these; the HTTP layer passes them
      // through when it has them (see the routes' `context` argument).
      ip: params.ip ?? null,
      deviceId: params.deviceId ?? null,
    },
  });

  await auditService.record({
    action: `settlement_account.${params.action.toLowerCase()}`,
    entityType: 'SettlementAccount',
    entityId: params.settlementAccountId,
    before: (params.before ?? null) as Record<string, unknown> | null,
    after: (params.after ?? null) as Record<string, unknown> | null,
  });

  if (params.notify) {
    // A settlement destination changing is exactly the event a business needs
    // to hear about immediately, on every channel (§11, §14).
    await notifyBusiness({
      organizationId: params.organizationId,
      type: 'settlement_account.changed',
      title: params.notify.title,
      body: params.notify.body,
      link: '/settings/settlement',
    });

    const owners = await prismaUnscoped.membership.findMany({
      where: { organizationId: params.organizationId, isOwner: true, isActive: true },
      select: { user: { select: { email: true, firstName: true } } },
    });
    for (const owner of owners) {
      if (!owner.user?.email) continue;
      try {
        await mailer.sendSettlementAccountNotice(
          owner.user.email,
          params.notify.title,
          params.notify.body,
          owner.user.firstName
        );
      } catch (err) {
        logger.warn({ err }, 'Could not email a settlement account change notice');
      }
    }
  }
}

export const settlementAccounts = {
  async list(opts: { branchId?: string; includeDeleted?: boolean } = {}) {
    const organizationId = orgId();
    const rows = await prisma.settlementAccount.findMany({
      where: {
        organizationId,
        ...(opts.branchId ? { branchId: opts.branchId } : {}),
        ...(opts.includeDeleted ? {} : { deletedAt: null }),
      },
      orderBy: [{ isDefault: 'desc' }, { priority: 'asc' }, { createdAt: 'desc' }],
    });
    return { items: rows.map(publicView) };
  },

  /**
   * Add a settlement destination (§8).
   *
   * Created as PENDING_VERIFICATION and never usable until the bank confirms
   * it — an unverified account is how money ends up in the wrong hands.
   */
  async create(input: SettlementAccountInput) {
    const organizationId = orgId();
    const country = input.country.toUpperCase();
    const currency = input.currency.toUpperCase();
    const digits = input.accountNumber.replace(/\D/g, '');

    if (digits.length < 6) throw new ValidationError('That account number looks too short');

    // A NGN account in a GB bank is almost always a typo, and settling into it
    // would fail at the bank rather than here (§9).
    const expected = currencyForCountry(country);
    if (expected && expected !== currency) {
      throw new ValidationError(
        `Accounts in ${country} settle in ${expected}, not ${currency}. Check the country and currency.`
      );
    }

    const fingerprint = accountFingerprint(country, input.bankCode ?? null, digits);

    // Duplicate within this organization.
    const existing = await prisma.settlementAccount.findFirst({
      where: { organizationId, accountFingerprint: fingerprint, deletedAt: null },
    });
    if (existing) {
      throw new ConflictError('That account is already set up for settlement');
    }

    // Blacklisted or suspended anywhere on the platform — checked unscoped on
    // purpose: an account barred for one business must not simply reappear
    // under another (§9).
    const barred = await prismaUnscoped.settlementAccount.findFirst({
      where: { accountFingerprint: fingerprint, status: { in: ['BLACKLISTED', 'SUSPENDED'] } },
      select: { status: true },
    });
    if (barred) {
      logger.warn({ organizationId, fingerprint }, 'Blocked a barred settlement account');
      throw new AppError(
        'ACCOUNT_NOT_PERMITTED',
        403,
        'This account cannot be used for settlement. Contact support if you believe this is wrong.'
      );
    }

    const created = await prisma.settlementAccount.create({
      data: {
        organizationId,
        branchId: input.branchId ?? null,
        businessUnit: input.businessUnit ?? null,
        type: input.type ?? 'BANK_ACCOUNT',
        status: 'PENDING_VERIFICATION',
        bankName: input.bankName ?? null,
        bankCode: input.bankCode ?? null,
        accountNumberEnc: encrypt(digits),
        accountFingerprint: fingerprint,
        accountLast4: digits.slice(-4),
        accountName: input.accountName.trim(),
        country,
        currency,
        priority: input.priority ?? 100,
        // Defaulting happens only after verification — see setDefault.
        isDefault: false,
        createdByUserId: requestContext.get()?.userId ?? null,
      },
    });

    await recordChange({
      settlementAccountId: created.id,
      organizationId,
      action: 'CREATED',
      after: { bankName: created.bankName, last4: created.accountLast4, currency },
      notify: {
        title: 'A settlement account was added',
        body: `${created.bankName ?? 'Bank account'} ••••${created.accountLast4} was added and is awaiting verification. If this was not you, contact support immediately.`,
      },
    });

    return publicView(created);
  },

  /**
   * Verify with the bank before the account may receive money (§9).
   *
   * The bank's own name for the account is compared against what the business
   * typed; a mismatch is rejected rather than quietly accepted.
   */
  async verify(id: string) {
    const organizationId = orgId();
    const row = await prisma.settlementAccount.findFirst({ where: { id, organizationId, deletedAt: null } });
    if (!row) throw new NotFoundError('Settlement account');
    if (row.status === 'VERIFIED') return publicView(row);
    if (row.status === 'BLACKLISTED' || row.status === 'SUSPENDED') {
      throw new AppError('ACCOUNT_NOT_PERMITTED', 403, 'This account cannot be verified.');
    }

    if (row.type !== 'BANK_ACCOUNT') {
      throw new ValidationError('Only bank accounts can be verified automatically right now');
    }
    if (!row.bankCode) throw new ValidationError('A bank code is required to verify this account');

    const { decrypt } = await import('../../shared/crypto');
    const accountNumber = decrypt(row.accountNumberEnc);

    const provider = getActivePaymentProvider();
    if (!supportsPayouts(provider) || !provider.enabled) {
      throw new AppError(
        'VERIFICATION_UNAVAILABLE',
        503,
        'Bank verification is not available with the configured payment provider.'
      );
    }

    let resolved: { accountName: string } | null = null;
    try {
      resolved = await provider.resolveAccount(accountNumber, row.bankCode);
    } catch (err) {
      logger.error({ err, id }, 'Bank verification call failed');
      throw new AppError(
        'VERIFICATION_UNAVAILABLE',
        503,
        'We could not reach the bank to verify this account. Try again shortly.'
      );
    }

    if (!resolved) {
      const rejected = await prisma.settlementAccount.update({
        where: { id },
        data: { status: 'REJECTED', rejectionReason: 'The bank did not recognise this account number.' },
      });
      await recordChange({
        settlementAccountId: id,
        organizationId,
        action: 'REJECTED',
        after: { reason: rejected.rejectionReason },
      });
      throw new ValidationError('The bank did not recognise this account number');
    }

    if (!namesAgree(row.accountName, resolved.accountName)) {
      const rejected = await prisma.settlementAccount.update({
        where: { id },
        data: {
          status: 'REJECTED',
          verifiedName: resolved.accountName,
          rejectionReason: `The bank has this account as "${resolved.accountName}".`,
        },
      });
      await recordChange({
        settlementAccountId: id,
        organizationId,
        action: 'REJECTED',
        after: { reason: rejected.rejectionReason },
      });
      throw new ValidationError(
        `The bank has this account under a different name ("${resolved.accountName}"). ` +
          'Correct the account name and try again.'
      );
    }

    const verified = await prisma.settlementAccount.update({
      where: { id },
      data: {
        status: 'VERIFIED',
        verifiedName: resolved.accountName,
        verifiedAt: new Date(),
        rejectionReason: null,
      },
    });

    // The first verified account becomes the default, because a business with
    // a verified account and no default would silently fail to settle.
    const hasDefault = await prisma.settlementAccount.findFirst({
      where: { organizationId, isDefault: true, deletedAt: null, status: 'VERIFIED' },
    });
    if (!hasDefault) {
      await prisma.settlementAccount.update({ where: { id }, data: { isDefault: true } });
    }

    await recordChange({
      settlementAccountId: id,
      organizationId,
      action: 'VERIFIED',
      after: { verifiedName: resolved.accountName },
      notify: {
        title: 'Settlement account verified',
        body: `${verified.bankName ?? 'Your bank account'} ••••${verified.accountLast4} is verified and ready to receive settlements.`,
      },
    });

    return publicView({ ...verified, isDefault: !hasDefault });
  },

  /** Choose which verified account receives settlements by default (§8). */
  async setDefault(id: string) {
    const organizationId = orgId();
    const row = await prisma.settlementAccount.findFirst({ where: { id, organizationId, deletedAt: null } });
    if (!row) throw new NotFoundError('Settlement account');
    if (row.status !== 'VERIFIED') {
      throw new ValidationError('Verify this account before making it the default');
    }

    await prisma.$transaction([
      prisma.settlementAccount.updateMany({
        where: { organizationId, isDefault: true },
        data: { isDefault: false },
      }),
      prisma.settlementAccount.update({ where: { id }, data: { isDefault: true } }),
    ]);

    await recordChange({
      settlementAccountId: id,
      organizationId,
      action: 'SET_DEFAULT',
      after: { last4: row.accountLast4 },
      notify: {
        title: 'Default settlement account changed',
        body: `Settlements will now go to ${row.bankName ?? 'your bank account'} ••••${row.accountLast4}.`,
      },
    });

    return this.list();
  },

  /** Change ordering, label or branch. The account number is never editable. */
  async update(id: string, dto: { priority?: number; branchId?: string | null; businessUnit?: string | null }) {
    const organizationId = orgId();
    const row = await prisma.settlementAccount.findFirst({ where: { id, organizationId, deletedAt: null } });
    if (!row) throw new NotFoundError('Settlement account');

    const updated = await prisma.settlementAccount.update({
      where: { id },
      data: {
        ...(dto.priority !== undefined ? { priority: dto.priority } : {}),
        ...(dto.branchId !== undefined ? { branchId: dto.branchId } : {}),
        ...(dto.businessUnit !== undefined ? { businessUnit: dto.businessUnit } : {}),
      },
    });

    await recordChange({
      settlementAccountId: id,
      organizationId,
      action: 'UPDATED',
      before: { priority: row.priority, branchId: row.branchId },
      after: { priority: updated.priority, branchId: updated.branchId },
    });

    return publicView(updated);
  },

  /**
   * Retire an account. Soft-deleted so historical settlements keep pointing at
   * a real destination.
   */
  async remove(id: string) {
    const organizationId = orgId();
    const row = await prisma.settlementAccount.findFirst({ where: { id, organizationId, deletedAt: null } });
    if (!row) throw new NotFoundError('Settlement account');

    const others = await prisma.settlementAccount.count({
      where: { organizationId, deletedAt: null, status: 'VERIFIED', id: { not: id } },
    });
    if (row.isDefault && others === 0) {
      throw new ValidationError(
        'This is your only verified settlement account. Add another before removing it.'
      );
    }

    await prisma.settlementAccount.update({
      where: { id },
      data: { deletedAt: new Date(), isDefault: false },
    });

    // Promote another verified account so the business is never left without a
    // default while still taking payments.
    if (row.isDefault) {
      const next = await prisma.settlementAccount.findFirst({
        where: { organizationId, deletedAt: null, status: 'VERIFIED' },
        orderBy: { priority: 'asc' },
      });
      if (next) await prisma.settlementAccount.update({ where: { id: next.id }, data: { isDefault: true } });
    }

    await recordChange({
      settlementAccountId: id,
      organizationId,
      action: 'DELETED',
      before: { last4: row.accountLast4, isDefault: row.isDefault },
      notify: {
        title: 'A settlement account was removed',
        body: `${row.bankName ?? 'Bank account'} ••••${row.accountLast4} will no longer receive settlements.`,
      },
    });
  },

  /**
   * Which account a settlement should pay into (§10).
   *
   * Branch-specific first, then organization-wide, then the default — so a
   * branch that has its own account keeps its money separate without every
   * other branch needing one.
   */
  async resolveDestination(organizationId: string, opts: { branchId?: string | null; currency: string }) {
    const currency = opts.currency.toUpperCase();
    const candidates = await prismaUnscoped.settlementAccount.findMany({
      where: {
        organizationId,
        deletedAt: null,
        status: 'VERIFIED',
        currency,
        OR: [{ branchId: opts.branchId ?? null }, { branchId: null }],
      },
      orderBy: [{ priority: 'asc' }, { isDefault: 'desc' }],
    });
    if (candidates.length === 0) return null;

    const branchSpecific = candidates.find((c) => c.branchId === opts.branchId && opts.branchId != null);
    return branchSpecific ?? candidates.find((c) => c.isDefault) ?? candidates[0]!;
  },

  /** The change history §11 requires operators to be able to read. */
  async changes(opts: { accountId?: string; limit?: number } = {}) {
    const organizationId = orgId();
    const rows = await prismaUnscoped.settlementAccountChange.findMany({
      where: { organizationId, ...(opts.accountId ? { settlementAccountId: opts.accountId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: opts.limit ?? 50,
    });
    return { items: rows };
  },
};
