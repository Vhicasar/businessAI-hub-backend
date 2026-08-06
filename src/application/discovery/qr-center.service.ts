import { randomBytes } from 'crypto';
import type { BusinessQrKind } from '@prisma/client';

import { prisma, prismaUnscoped } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { AppError, NotFoundError, ValidationError } from '../../shared/errors';
import { auditService } from '../audit/audit.service';
import { notifyBusiness } from '../notifications/notify';
import { businessDiscovery } from './business-discovery.service';

/**
 * Print formats a business can hand a customer (§6). Sizes are in millimetres
 * so the same template renders correctly on A4 and on a 58mm receipt roll.
 */
export const QR_TEMPLATES = {
  A4: { label: 'A4 poster', width: 210, height: 297, qrSize: 110, showInstructions: true },
  RECEIPT: { label: 'Receipt printer', width: 58, height: 90, qrSize: 40, showInstructions: true },
  FLYER: { label: 'Flyer (A5)', width: 148, height: 210, qrSize: 80, showInstructions: true },
  POSTER: { label: 'Poster (A3)', width: 297, height: 420, qrSize: 160, showInstructions: true },
  TABLE_TENT: { label: 'Table tent', width: 100, height: 150, qrSize: 60, showInstructions: true },
  WINDOW_STICKER: { label: 'Window sticker', width: 120, height: 120, qrSize: 80, showInstructions: false },
  BUSINESS_CARD: { label: 'Business card', width: 85, height: 55, qrSize: 30, showInstructions: false },
} as const;

export type QrTemplate = keyof typeof QR_TEMPLATES;

/** Kinds that name something specific — the UI must collect a subject for these. */
const SUBJECT_KINDS: BusinessQrKind[] = ['EMPLOYEE', 'TABLE', 'PROPERTY', 'PRODUCT', 'BRANCH'];

function orgId(): string {
  const id = requestContext.get()?.organizationId;
  if (!id) throw new AppError('NO_TENANT', 403, 'Organization context required');
  return id;
}

function conversionRate(scans: number, joins: number): number {
  if (scans === 0) return 0;
  return Math.round((joins / scans) * 1000) / 10;
}

export const qrCenter = {
  QR_TEMPLATES,

  /** Every code this organization has, with its performance (§6). */
  async list(opts: { kind?: BusinessQrKind; branchId?: string; includeInactive?: boolean } = {}) {
    const organizationId = orgId();
    const rows = await prisma.businessQr.findMany({
      where: {
        organizationId,
        ...(opts.kind ? { kind: opts.kind } : {}),
        ...(opts.branchId ? { branchId: opts.branchId } : {}),
        ...(opts.includeInactive ? {} : { isActive: true }),
      },
      orderBy: { createdAt: 'desc' },
    });

    const now = Date.now();
    return {
      items: rows.map((q) => ({
        id: q.id,
        kind: q.kind,
        label: q.label,
        code: q.code,
        payload: `vhicasar://join?c=${q.code}`,
        branchId: q.branchId,
        subjectId: q.subjectId,
        subjectLabel: q.subjectLabel,
        campaignId: q.campaignId,
        scanCount: q.scanCount,
        joinCount: q.joinCount,
        conversionRate: conversionRate(q.scanCount, q.joinCount),
        maxScans: q.maxScans,
        expiresAt: q.expiresAt,
        isActive: q.isActive,
        // Expiry is a fact about the code, not a separate flag to keep in step.
        isExpired: Boolean(q.expiresAt && q.expiresAt.getTime() < now),
        isExhausted: q.maxScans !== null && q.scanCount >= q.maxScans,
        createdAt: q.createdAt,
      })),
      templates: Object.entries(QR_TEMPLATES).map(([key, t]) => ({ key, ...t })),
    };
  },

  /**
   * Mint a code. Kinds that name something (an employee, a table, a property)
   * must say what — otherwise the analytics that follow are meaningless.
   */
  async create(dto: {
    kind: BusinessQrKind;
    label?: string;
    branchId?: string;
    subjectId?: string;
    subjectLabel?: string;
    campaignId?: string;
    referrerCustomerId?: string;
    expiresAt?: Date;
    maxScans?: number;
  }) {
    const organizationId = orgId();

    if (SUBJECT_KINDS.includes(dto.kind) && !dto.subjectId && !dto.branchId) {
      throw new ValidationError(
        `A ${dto.kind.toLowerCase()} QR needs to say which ${dto.kind.toLowerCase()} it is for`
      );
    }

    // Only one live permanent code per organization: two would split the
    // analytics and leave staff unsure which poster is the real one.
    if (dto.kind === 'PERMANENT') {
      const existing = await prisma.businessQr.findFirst({
        where: { organizationId, kind: 'PERMANENT', isActive: true },
      });
      if (existing) {
        throw new AppError(
          'QR_ALREADY_EXISTS',
          409,
          'This business already has a permanent QR. Regenerate it instead of creating a second one.',
          { id: existing.id }
        );
      }
    }

    const created = await businessDiscovery.createQr(organizationId, dto);
    await prisma.businessQr.update({
      where: { id: created.id },
      data: { subjectId: dto.subjectId ?? null, subjectLabel: dto.subjectLabel ?? null },
    });

    await notifyBusiness({
      organizationId,
      type: 'business_qr.created',
      title: 'New QR code generated',
      body: `${dto.label ?? dto.kind} is ready to print and share.`,
      link: '/settings/qr-center',
    });

    return { ...created, subjectId: dto.subjectId ?? null, subjectLabel: dto.subjectLabel ?? null };
  },

  /**
   * Replace a code with a fresh one, carrying its settings over.
   *
   * The old code is deactivated rather than deleted so its scan history — and
   * anyone who already joined through it — stays intact.
   */
  async regenerate(id: string) {
    const organizationId = orgId();
    const old = await prisma.businessQr.findFirst({ where: { id, organizationId } });
    if (!old) throw new NotFoundError('QR code');

    await prisma.businessQr.update({ where: { id }, data: { isActive: false } });

    const replacement = await businessDiscovery.createQr(organizationId, {
      kind: old.kind,
      label: old.label ?? undefined,
      branchId: old.branchId ?? undefined,
      campaignId: old.campaignId ?? undefined,
      referrerCustomerId: old.referrerCustomerId ?? undefined,
      expiresAt: old.expiresAt ?? undefined,
      maxScans: old.maxScans ?? undefined,
    });
    await prisma.businessQr.update({
      where: { id: replacement.id },
      data: { subjectId: old.subjectId, subjectLabel: old.subjectLabel },
    });

    await auditService.record({
      action: 'business_qr.regenerated',
      entityType: 'BusinessQr',
      entityId: replacement.id,
      before: { id: old.id, code: old.code },
      after: { id: replacement.id, code: replacement.code },
    });

    return { ...replacement, replaces: old.id };
  },

  /** Turn a code off, or expire it at a chosen moment. */
  async update(id: string, dto: { isActive?: boolean; label?: string; expiresAt?: Date | null; maxScans?: number | null }) {
    const organizationId = orgId();
    const existing = await prisma.businessQr.findFirst({ where: { id, organizationId } });
    if (!existing) throw new NotFoundError('QR code');

    const updated = await prisma.businessQr.update({
      where: { id },
      data: {
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        ...(dto.label !== undefined ? { label: dto.label } : {}),
        ...(dto.expiresAt !== undefined ? { expiresAt: dto.expiresAt } : {}),
        ...(dto.maxScans !== undefined ? { maxScans: dto.maxScans } : {}),
      },
    });

    await auditService.record({
      action: dto.isActive === false ? 'business_qr.disabled' : 'business_qr.updated',
      entityType: 'BusinessQr',
      entityId: id,
      before: { isActive: existing.isActive, expiresAt: existing.expiresAt },
      after: { isActive: updated.isActive, expiresAt: updated.expiresAt },
    });

    return { ...updated, payload: `vhicasar://join?c=${updated.code}` };
  },

  /**
   * Everything a print template needs, resolved server-side (§6).
   *
   * The payload, business identity and brand colours come from one place so a
   * poster printed today and a table tent printed next month agree.
   */
  async printable(id: string, template: QrTemplate) {
    const organizationId = orgId();
    const qr = await prisma.businessQr.findFirst({ where: { id, organizationId } });
    if (!qr) throw new NotFoundError('QR code');

    const org = await prismaUnscoped.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { id: true, name: true, logoFileId: true, settings: true },
    });
    const branding = ((org.settings as Record<string, unknown> | null)?.branding ?? {}) as {
      primaryColor?: string;
      secondaryColor?: string;
    };

    const spec = QR_TEMPLATES[template];
    return {
      template: { key: template, ...spec },
      qr: {
        id: qr.id,
        kind: qr.kind,
        label: qr.label,
        payload: `vhicasar://join?c=${qr.code}`,
        subjectLabel: qr.subjectLabel,
      },
      business: {
        id: org.id,
        name: org.name,
        logoFileId: org.logoFileId,
        // Fall back to the Vhicasar brand rather than printing something blank.
        primaryColor: branding.primaryColor ?? '#F97316',
        secondaryColor: branding.secondaryColor ?? '#0F172A',
      },
      instructions: spec.showInstructions
        ? [
            'Scan with your phone camera',
            `Join ${org.name} on Vhicasar`,
            'Collect rewards on every visit',
          ]
        : [],
    };
  },

  /**
   * Scan-level analytics for one code or the whole organization (§6).
   *
   * Joins are counted from QrScanEvent rather than the running counter so the
   * conversion rate and the timeline can never disagree.
   */
  async analytics(opts: { qrId?: string; days?: number } = {}) {
    const organizationId = orgId();
    const days = opts.days ?? 30;
    const since = new Date(Date.now() - days * 86_400_000);

    const where = {
      organizationId,
      createdAt: { gte: since },
      ...(opts.qrId ? { businessQrId: opts.qrId } : {}),
    };

    const [scans, joins, byQr, recent] = await Promise.all([
      prismaUnscoped.qrScanEvent.count({ where }),
      prismaUnscoped.qrScanEvent.count({ where: { ...where, didJoin: true } }),
      prismaUnscoped.qrScanEvent.groupBy({
        by: ['businessQrId'],
        where,
        _count: { _all: true },
      }),
      prismaUnscoped.qrScanEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 25,
        select: { id: true, businessQrId: true, didJoin: true, country: true, city: true, createdAt: true },
      }),
    ]);

    const qrIds = byQr.map((g) => g.businessQrId);
    const codes = qrIds.length
      ? await prisma.businessQr.findMany({
          where: { id: { in: qrIds } },
          select: { id: true, kind: true, label: true, joinCount: true, scanCount: true },
        })
      : [];

    return {
      periodDays: days,
      scans,
      joins,
      conversionRate: conversionRate(scans, joins),
      byCode: byQr
        .map((g) => {
          const code = codes.find((c) => c.id === g.businessQrId);
          return {
            qrId: g.businessQrId,
            kind: code?.kind ?? null,
            label: code?.label ?? null,
            scans: g._count._all,
            lifetimeScans: code?.scanCount ?? 0,
            lifetimeJoins: code?.joinCount ?? 0,
            conversionRate: conversionRate(code?.scanCount ?? 0, code?.joinCount ?? 0),
          };
        })
        .sort((a, b) => b.scans - a.scans),
      recent,
    };
  },
};

/**
 * Record a scan, whether or not it became a join (§6).
 *
 * Called from the customer-side join flow. Failures here must never break a
 * join: a customer joining a business matters more than an analytics row.
 */
export async function recordQrScan(params: {
  businessQrId: string;
  organizationId: string;
  vhicasarId?: string;
  didJoin: boolean;
  country?: string | null;
  city?: string | null;
  userAgent?: string | null;
}) {
  try {
    await prismaUnscoped.$transaction([
      prismaUnscoped.qrScanEvent.create({
        data: {
          businessQrId: params.businessQrId,
          organizationId: params.organizationId,
          vhicasarId: params.vhicasarId ?? null,
          didJoin: params.didJoin,
          country: params.country ?? null,
          city: params.city ?? null,
          userAgent: params.userAgent?.slice(0, 400) ?? null,
        },
      }),
      prismaUnscoped.businessQr.update({
        where: { id: params.businessQrId },
        data: {
          // Every scan counts, whether or not it converted — otherwise the
          // conversion rate has no denominator.
          scanCount: { increment: 1 },
          ...(params.didJoin ? { joinCount: { increment: 1 } } : {}),
        },
      }),
    ]);
  } catch {
    // Analytics are best-effort by design.
  }
}

/** A brand-new code has no history, so `randomBytes` here is only for tests. */
export const __qrTestHelpers = { randomCode: () => `VB${randomBytes(9).toString('base64url')}` };
