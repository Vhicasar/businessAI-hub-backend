import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { encrypt } from '../../shared/crypto';
import { emitEvent } from '../../shared/domain-events';
import { ConflictError, NotFoundError } from '../../shared/errors';
import { auditService } from '../audit/audit.service';
import type { ReviewKycDto, SubmitKycDto } from './identity.dto';

/**
 * KYC verification for a Vhicasar ID. The approved level is what gates
 * withdrawal ceilings (see payoutService.KYC_WITHDRAWAL_LIMITS), so approval
 * is a platform-admin action, never self-service.
 *
 * Document numbers are personal identifiers and are encrypted at rest
 * (Database Bible §24); only the last 4 characters are ever returned.
 */

const view = (s: {
  id: string;
  level: string;
  status: string;
  documentType: string;
  fullName: string | null;
  submittedAt: Date;
  reviewedAt: Date | null;
  reviewNotes: string | null;
}) => ({
  id: s.id,
  level: s.level,
  status: s.status,
  documentType: s.documentType,
  fullName: s.fullName,
  submittedAt: s.submittedAt,
  reviewedAt: s.reviewedAt,
  reviewNotes: s.reviewNotes,
});

export const kycService = {
  async submit(vhicasarId: string, dto: SubmitKycDto) {
    const pending = await prismaUnscoped.kycSubmission.findFirst({
      where: { vhicasarId, status: 'PENDING' },
      select: { id: true },
    });
    if (pending) throw new ConflictError('You already have a verification in review');

    const submission = await prismaUnscoped.kycSubmission.create({
      data: {
        vhicasarId,
        level: dto.documentType === 'BVN' || dto.documentType === 'NIN' ? 'VERIFIED' : 'BASIC',
        documentType: dto.documentType,
        documentNumberEnc: encrypt(dto.documentNumber),
        documentFileId: dto.documentFileId ?? null,
        selfieFileId: dto.selfieFileId ?? null,
        fullName: dto.fullName,
        dateOfBirth: dto.dateOfBirth ?? null,
        address: dto.address ?? null,
      },
    });

    await emitEvent({
      name: 'KycSubmitted',
      aggregateType: 'KycSubmission',
      aggregateId: submission.id,
      payload: { vhicasarId, documentType: dto.documentType },
      organizationId: null,
    });
    return view(submission);
  },

  async statusFor(vhicasarId: string) {
    const identity = await prismaUnscoped.vhicasarId.findUnique({
      where: { id: vhicasarId },
      select: { kycLevel: true },
    });
    const latest = await prismaUnscoped.kycSubmission.findFirst({
      where: { vhicasarId },
      orderBy: { submittedAt: 'desc' },
    });
    return {
      kycLevel: identity?.kycLevel ?? 'NONE',
      latestSubmission: latest ? view(latest) : null,
    };
  },

  /** Platform-admin review queue. */
  async listPending(opts: { status?: string; cursor?: string; limit: number }) {
    const rows = await prismaUnscoped.kycSubmission.findMany({
      where: { status: (opts.status as never) ?? 'PENDING' },
      orderBy: { submittedAt: 'asc' },
      take: opts.limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      include: {
        identity: { select: { publicId: true, phone: true, displayName: true, kycLevel: true } },
      },
    });
    const hasMore = rows.length > opts.limit;
    const items = hasMore ? rows.slice(0, opts.limit) : rows;
    return {
      items: items.map((s) => ({
        ...view(s),
        identity: {
          publicId: s.identity.publicId,
          phone: s.identity.phone,
          displayName: s.identity.displayName,
          kycLevel: s.identity.kycLevel,
        },
        documentFileId: s.documentFileId,
        selfieFileId: s.selfieFileId,
      })),
      nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
    };
  },

  async review(submissionId: string, dto: ReviewKycDto, reviewerId?: string) {
    const submission = await prismaUnscoped.kycSubmission.findUnique({ where: { id: submissionId } });
    if (!submission) throw new NotFoundError('KYC submission');
    if (submission.status !== 'PENDING') throw new ConflictError('This submission has already been reviewed');

    const updated = await prismaUnscoped.kycSubmission.update({
      where: { id: submissionId },
      data: {
        status: dto.action,
        reviewedBy: reviewerId ?? null,
        reviewNotes: dto.notes ?? null,
        reviewedAt: new Date(),
        ...(dto.level ? { level: dto.level } : {}),
      },
    });

    // Approval is what actually raises the account's limits.
    if (dto.action === 'APPROVED') {
      await prismaUnscoped.vhicasarId.update({
        where: { id: submission.vhicasarId },
        data: { kycLevel: dto.level ?? submission.level },
      });
    }

    await auditService.record({
      action: `kyc.${dto.action.toLowerCase()}`,
      entityType: 'KycSubmission',
      entityId: submissionId,
      after: { level: dto.level ?? submission.level, notes: dto.notes },
    });
    await emitEvent({
      name: 'KycReviewed',
      aggregateType: 'KycSubmission',
      aggregateId: submissionId,
      payload: { vhicasarId: submission.vhicasarId, status: dto.action, level: dto.level ?? submission.level },
      organizationId: null,
    });
    return view(updated);
  },
};
