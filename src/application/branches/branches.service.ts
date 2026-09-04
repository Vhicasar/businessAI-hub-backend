import { z } from 'zod';
import { prisma } from '../../infrastructure/database/prisma';
import { currentOrgId } from '../billing/entitlements';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors';
import { auditService } from '../audit/audit.service';

/**
 * The physical places a business trades from.
 *
 * Branches were modelled and read all over the product — staff belong to one,
 * warehouses sit in one, settlement rules and promotions can be scoped to one —
 * but there was never a way to create one. Everything that referenced a branch
 * therefore referenced something that could not exist, and the plan limit that
 * caps them capped nothing.
 *
 * One branch is the head office. It is the fallback for anything that needs a
 * location and was not given one, which is why exactly one always holds the
 * flag and why it cannot be archived while others depend on it.
 */

export const branchSchema = z.object({
  name: z.string().trim().min(1).max(120),
  /** Short reference that appears alongside the name wherever space is tight. */
  code: z.string().trim().min(1).max(20).toUpperCase(),
  phone: z.string().trim().max(40).nullable().optional(),
  email: z.string().trim().email().max(200).nullable().optional().or(z.literal('')),
  addressLine1: z.string().trim().max(200).nullable().optional(),
  city: z.string().trim().max(100).nullable().optional(),
  state: z.string().trim().max(100).nullable().optional(),
  country: z.string().trim().length(2).toUpperCase().nullable().optional(),
  /**
   * Promotes this branch to head office. The one it replaces is demoted in the
   * same transaction — two head offices is not a state the rest of the product
   * knows how to read.
   */
  isHeadOffice: z.boolean().optional(),
});

export const updateBranchSchema = branchSchema.partial();

export const listBranchesSchema = z.object({
  search: z.string().trim().max(120).optional(),
  includeInactive: z.coerce.boolean().default(false),
});

export type BranchDto = z.infer<typeof branchSchema>;

const select = {
  id: true, name: true, code: true, phone: true, email: true,
  addressLine1: true, city: true, state: true, country: true,
  isHeadOffice: true, isActive: true, createdAt: true,
} as const;

/** What is attached to a branch, so the UI can warn before closing one. */
const counts = {
  _count: { select: { warehouses: true, memberships: true, departments: true } },
} as const;

export const branchesService = {
  async list(dto: z.infer<typeof listBranchesSchema>) {
    return prisma.branch.findMany({
      where: {
        deletedAt: null,
        ...(dto.includeInactive ? {} : { isActive: true }),
        ...(dto.search
          ? {
              OR: [
                { name: { contains: dto.search, mode: 'insensitive' as const } },
                { code: { contains: dto.search, mode: 'insensitive' as const } },
                { city: { contains: dto.search, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      select: { ...select, ...counts },
      orderBy: [{ isHeadOffice: 'desc' }, { name: 'asc' }],
    });
  },

  async get(id: string) {
    const branch = await prisma.branch.findFirst({
      where: { id, deletedAt: null },
      select: { ...select, ...counts },
    });
    if (!branch) throw new NotFoundError('Branch');
    return branch;
  },

  async create(dto: BranchDto) {
    const code = dto.code.trim().toUpperCase();
    await assertCodeFree(code);

    // The first branch a business creates is its head office — there is
    // nothing else for anything to fall back to.
    const existing = await prisma.branch.count({ where: { deletedAt: null } });
    const headOffice = dto.isHeadOffice || existing === 0;

    const branch = await prisma.$transaction(async (tx) => {
      if (headOffice) {
        await tx.branch.updateMany({ where: { isHeadOffice: true }, data: { isHeadOffice: false } });
      }
      return tx.branch.create({
        data: {
          // Written explicitly: the tenant client injects it at runtime, but
          // a create still has to satisfy the relation at compile time.
          organizationId: currentOrgId(),
          name: dto.name.trim(),
          code,
          phone: blankToNull(dto.phone),
          email: blankToNull(dto.email),
          addressLine1: blankToNull(dto.addressLine1),
          city: blankToNull(dto.city),
          state: blankToNull(dto.state),
          country: blankToNull(dto.country),
          isHeadOffice: headOffice,
        },
        select,
      });
    });

    await auditService
      .record({
        action: 'branch.created',
        entityType: 'BRANCH',
        entityId: branch.id,
        after: { name: branch.name, code: branch.code, isHeadOffice: branch.isHeadOffice },
      })
      .catch(() => {});
    return branch;
  },

  async update(id: string, dto: z.infer<typeof updateBranchSchema>) {
    const before = await prisma.branch.findFirst({ where: { id, deletedAt: null }, select });
    if (!before) throw new NotFoundError('Branch');
    const code = dto.code?.trim().toUpperCase();
    if (code && code !== before.code) await assertCodeFree(code, id);

    // Demoting the only head office would leave nothing to fall back to, so
    // the flag is turned off by promoting another branch, never by clearing it.
    if (dto.isHeadOffice === false && before.isHeadOffice) {
      throw new ValidationError(
        'Every business needs a head office. Make another branch the head office instead.',
      );
    }

    const branch = await prisma.$transaction(async (tx) => {
      if (dto.isHeadOffice) {
        // Exactly one head office: clear the flag before setting it here.
        await tx.branch.updateMany({
          where: { isHeadOffice: true, id: { not: id } },
          data: { isHeadOffice: false },
        });
      }
      return tx.branch.update({
        where: { id },
        data: {
          ...changedFields(dto),
          // Set explicitly: `changedFields` deliberately drops the flag so it
          // cannot be written without the demotion above running first.
          ...(dto.isHeadOffice ? { isHeadOffice: true } : {}),
        },
        select,
      });
    });

    await auditService
      .record({
        action: 'branch.updated',
        entityType: 'BRANCH',
        entityId: id,
        before: { name: before.name, code: before.code, isHeadOffice: before.isHeadOffice },
        after: { name: branch.name, code: branch.code, isHeadOffice: branch.isHeadOffice },
      })
      .catch(() => {});
    return branch;
  },

  /**
   * Close a branch.
   *
   * Archived rather than deleted whenever anything points at it: a member of
   * staff, a warehouse and a department all carry a branch id, and removing
   * the row would leave those pointing at nothing. Closing preserves the
   * history and stops it being chosen again.
   */
  async archive(id: string) {
    const branch = await prisma.branch.findFirst({
      where: { id, deletedAt: null },
      select: { ...select, ...counts },
    });
    if (!branch) throw new NotFoundError('Branch');
    if (branch.isHeadOffice) {
      throw new ValidationError(
        'The head office cannot be closed. Make another branch the head office first.',
      );
    }

    const attached =
      branch._count.warehouses + branch._count.memberships + branch._count.departments;
    const updated = await prisma.branch.update({
      where: { id },
      data: attached > 0 ? { isActive: false } : { isActive: false, deletedAt: new Date() },
      select,
    });

    await auditService
      .record({
        action: 'branch.closed',
        entityType: 'BRANCH',
        entityId: id,
        before: { isActive: true },
        after: { isActive: false, removed: attached === 0, attached },
      })
      .catch(() => {});
    return { ...updated, removed: attached === 0, attached };
  },

  async reopen(id: string) {
    const branch = await prisma.branch.findFirst({ where: { id, deletedAt: null }, select });
    if (!branch) throw new NotFoundError('Branch');
    const updated = await prisma.branch.update({
      where: { id },
      data: { isActive: true },
      select,
    });
    await auditService
      .record({ action: 'branch.reopened', entityType: 'BRANCH', entityId: id, after: { isActive: true } })
      .catch(() => {});
    return updated;
  },
};

/** An empty string from a cleared form field means "no value", not "". */
const blankToNull = (v: string | null | undefined) => (v === '' || v === undefined ? null : v);

/**
 * Only the fields the caller actually sent.
 *
 * An update must not blank a column nobody touched, which is what spreading a
 * partial with `undefined` values through would do.
 */
function changedFields(dto: z.infer<typeof updateBranchSchema>) {
  const { isHeadOffice: _headOffice, ...rest } = dto;
  const data: {
    name?: string; code?: string; phone?: string | null; email?: string | null;
    addressLine1?: string | null; city?: string | null; state?: string | null;
    country?: string | null;
  } = {};
  if (rest.name !== undefined) data.name = rest.name;
  if (rest.code !== undefined) data.code = rest.code.trim().toUpperCase();
  if (rest.phone !== undefined) data.phone = blankToNull(rest.phone);
  if (rest.email !== undefined) data.email = blankToNull(rest.email);
  if (rest.addressLine1 !== undefined) data.addressLine1 = blankToNull(rest.addressLine1);
  if (rest.city !== undefined) data.city = blankToNull(rest.city);
  if (rest.state !== undefined) data.state = blankToNull(rest.state);
  if (rest.country !== undefined) data.country = blankToNull(rest.country);
  return data;
}

async function assertCodeFree(code: string, exceptId?: string) {
  const clash = await prisma.branch.findFirst({
    where: { code, deletedAt: null, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true, name: true },
  });
  if (clash) {
    throw new ConflictError(`The code "${code}" is already used by ${clash.name}.`);
  }
}
