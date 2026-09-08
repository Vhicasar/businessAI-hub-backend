import { z } from 'zod';
import { prisma, prismaUnscoped } from '../../infrastructure/database/prisma';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors';
import { auditService } from '../audit/audit.service';
import type { SenderIdStatus } from '@prisma/client';

/**
 * The name a business's SMS appears to come from.
 *
 * Networks will not carry marketing SMS from an arbitrary string, so each one
 * is registered and waits on somebody else's approval queue. Two rules matter
 * more than the paperwork:
 *
 *   Nothing sends under an unapproved name. A pending registration is not a
 *   soft warning — the network will reject the traffic, and the business will
 *   have paid for it.
 *
 *   A name belongs to one business. Sending under another organisation's
 *   approved Sender ID is impersonation, and is precisely what registration
 *   exists to prevent, so the lookup is always tenant-scoped.
 */

/**
 * Alphanumeric Sender IDs are capped at 11 characters by GSM and rejected
 * outright above it — this is a network limit, not a provider preference.
 */
const MAX_LENGTH = 11;
const PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _-]*$/;

export const senderIdSchema = z.object({
  value: z
    .string()
    .trim()
    .min(3, 'A Sender ID needs at least 3 characters')
    .max(MAX_LENGTH, `A Sender ID cannot be longer than ${MAX_LENGTH} characters`)
    .regex(PATTERN, 'Use letters, numbers, spaces, hyphens or underscores, starting with a letter or number'),
  useCase: z.string().trim().max(500).optional(),
});
export type SenderIdDto = z.infer<typeof senderIdSchema>;

/** Why a Sender ID cannot be used, phrased for the business. */
export function unusableReason(status: SenderIdStatus): string | null {
  switch (status) {
    case 'APPROVED': return null;
    case 'DRAFT': return 'This Sender ID has not been submitted for approval yet.';
    case 'PENDING': return 'This Sender ID is still waiting for network approval.';
    case 'REJECTED': return 'This Sender ID was rejected. Request a different one.';
    case 'SUSPENDED': return 'This Sender ID has been suspended and can no longer be used.';
    default: return 'This Sender ID cannot be used.';
  }
}

const select = {
  id: true, value: true, status: true, useCase: true, reviewNote: true,
  submittedAt: true, decidedAt: true, createdAt: true,
} as const;

export const senderIdService = {
  async list() {
    return prisma.senderId.findMany({
      where: { deletedAt: null },
      select,
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    });
  },

  async request(organizationId: string, dto: SenderIdDto) {
    // Compared case-insensitively: networks treat ABCPHARM and abcpharm as one
    // name, so letting both exist would mean two requests for the same thing.
    const existing = await prisma.senderId.findFirst({
      where: { value: { equals: dto.value, mode: 'insensitive' }, deletedAt: null },
      select: { id: true, status: true },
    });
    if (existing) {
      throw new ConflictError(
        existing.status === 'REJECTED'
          ? 'That Sender ID was already rejected. Try a different one.'
          : 'You have already requested that Sender ID.',
      );
    }

    const created = await prisma.senderId.create({
      data: { organizationId, value: dto.value, useCase: dto.useCase ?? null, status: 'DRAFT' },
      select,
    });
    await auditService
      .record({
        action: 'sms.sender_id_requested',
        entityType: 'SENDER_ID',
        entityId: created.id,
        after: { value: created.value, status: created.status },
      })
      .catch(() => {});
    return created;
  },

  /** Hand it to the provider's approval queue. */
  async submit(id: string) {
    const senderId = await prisma.senderId.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, status: true, value: true },
    });
    if (!senderId) throw new NotFoundError('Sender ID');
    if (senderId.status !== 'DRAFT' && senderId.status !== 'REJECTED') {
      throw new ConflictError(`A ${senderId.status.toLowerCase()} Sender ID cannot be submitted again.`);
    }
    const updated = await prisma.senderId.update({
      where: { id },
      data: { status: 'PENDING', submittedAt: new Date(), reviewNote: null },
      select,
    });
    await auditService
      .record({
        action: 'sms.sender_id_submitted',
        entityType: 'SENDER_ID',
        entityId: id,
        before: { status: senderId.status },
        after: { status: 'PENDING', value: senderId.value },
      })
      .catch(() => {});
    return updated;
  },

  /**
   * The approved Sender ID a send may use.
   *
   * Throws rather than falling back to any other name: silently sending under
   * a different sender than the business chose is worse than not sending.
   */
  async requireApproved(organizationId: string, id?: string): Promise<{ id: string; value: string }> {
    const senderId = id
      ? await prisma.senderId.findFirst({
          where: { id, deletedAt: null },
          select: { id: true, value: true, status: true },
        })
      : await prisma.senderId.findFirst({
          where: { status: 'APPROVED', deletedAt: null },
          select: { id: true, value: true, status: true },
          orderBy: { decidedAt: 'asc' },
        });

    if (!senderId) {
      throw new ValidationError(
        id
          ? 'That Sender ID does not exist.'
          : 'No approved Sender ID yet. Request one before sending SMS.',
      );
    }
    const reason = unusableReason(senderId.status);
    if (reason) throw new ValidationError(reason);
    return { id: senderId.id, value: senderId.value };
  },

  // ── Platform administration ──────────────────────────────────────────────

  /**
   * Every request awaiting a decision, across all businesses.
   *
   * Unscoped by design: this is the Vhicasar administrator's queue, reached
   * only through a super-admin route.
   */
  async pendingQueue() {
    return prismaUnscoped.senderId.findMany({
      where: { status: 'PENDING', deletedAt: null },
      select: {
        ...select,
        organizationId: true,
        organization: { select: { name: true, slug: true } },
      },
      orderBy: { submittedAt: 'asc' },
      take: 200,
    });
  },

  /** Record the network's decision. */
  async decide(
    id: string,
    decision: 'APPROVED' | 'REJECTED' | 'SUSPENDED',
    input: { note?: string; providerRef?: string; decidedById?: string },
  ) {
    const senderId = await prismaUnscoped.senderId.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, status: true, value: true, organizationId: true },
    });
    if (!senderId) throw new NotFoundError('Sender ID');

    const updated = await prismaUnscoped.senderId.update({
      where: { id },
      data: {
        status: decision,
        reviewNote: input.note ?? null,
        providerRef: input.providerRef ?? undefined,
        decidedAt: new Date(),
        decidedById: input.decidedById ?? null,
      },
      select: { ...select, organizationId: true },
    });
    await auditService
      .record({
        action: `sms.sender_id_${decision.toLowerCase()}`,
        entityType: 'SENDER_ID',
        entityId: id,
        before: { status: senderId.status },
        after: { status: decision, value: senderId.value, note: input.note ?? null },
      })
      .catch(() => {});
    return updated;
  },
};
