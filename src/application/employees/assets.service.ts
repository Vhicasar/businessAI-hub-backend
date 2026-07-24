import { z } from 'zod';
import { ConflictError, NotFoundError } from '../../shared/errors';
import { prisma } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { activityService } from '../crm/activity.service';

function orgId(): string {
  const id = requestContext.get()?.organizationId;
  if (!id) throw new Error('No tenant in request context');
  return id;
}
function actorMembershipId(): string | null {
  return requestContext.get()?.membershipId ?? null;
}

const ASSET_STATUSES = ['AVAILABLE', 'ASSIGNED', 'MAINTENANCE', 'RETIRED', 'LOST'] as const;
const EXPENSE_STATUSES = ['SUBMITTED', 'APPROVED', 'REJECTED', 'REIMBURSED'] as const;

// ------------------------------------------------------------------ schemas

export const listAssetsSchema = z.object({
  status: z.enum(ASSET_STATUSES).optional(),
  category: z.string().trim().max(40).optional(),
  search: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export const assetSchema = z.object({
  name: z.string().trim().min(1).max(120),
  category: z.string().trim().min(1).max(40).default('OTHER'),
  serialNumber: z.string().trim().max(80).nullable().optional(),
  purchaseDate: z.coerce.date().nullable().optional(),
  purchaseCost: z.coerce.number().min(0).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
  status: z.enum(ASSET_STATUSES).optional(),
});
export const assignAssetSchema = z.object({
  employeeId: z.string().min(1),
  notes: z.string().trim().max(500).nullable().optional(),
});
export const returnAssetSchema = z.object({
  notes: z.string().trim().max(500).nullable().optional(),
  status: z.enum(['AVAILABLE', 'MAINTENANCE', 'RETIRED', 'LOST']).default('AVAILABLE'),
});

export const listExpensesSchema = z.object({
  status: z.enum(EXPENSE_STATUSES).optional(),
  employeeId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export const expenseSchema = z.object({
  employeeId: z.string().min(1),
  title: z.string().trim().min(1).max(160),
  category: z.string().trim().min(1).max(40).default('OTHER'),
  amount: z.coerce.number().positive().max(1_000_000_000),
  incurredAt: z.coerce.date(),
  description: z.string().trim().max(2000).nullable().optional(),
});
export const decideExpenseSchema = z.object({
  status: z.enum(['APPROVED', 'REJECTED']),
  decisionNote: z.string().trim().max(500).optional(),
});

const assetSelect = {
  id: true, assetTag: true, name: true, category: true, serialNumber: true, status: true,
  purchaseDate: true, purchaseCost: true, currency: true, notes: true, createdAt: true,
} as const;
const expenseSelect = {
  id: true, reference: true, title: true, category: true, amount: true, currency: true,
  incurredAt: true, description: true, status: true, decidedAt: true, decisionNote: true,
  reimbursedAt: true, createdAt: true,
  employee: { select: { id: true, firstName: true, lastName: true, employeeNumber: true } },
} as const;

async function nextAssetTag(): Promise<string> {
  const count = await prisma.asset.count({ where: { assetTag: { startsWith: 'AST-' } } });
  return `AST-${String(count + 1).padStart(5, '0')}`;
}
async function nextExpenseRef(): Promise<string> {
  const year = new Date().getFullYear();
  const count = await prisma.expenseClaim.count({ where: { reference: { startsWith: `EXP-${year}-` } } });
  return `EXP-${year}-${String(count + 1).padStart(5, '0')}`;
}

export const assetsService = {
  // ------------------------------------------------------------------ assets
  async listAssets(dto: z.infer<typeof listAssetsSchema>) {
    const assets = await prisma.asset.findMany({
      where: {
        deletedAt: null,
        ...(dto.status ? { status: dto.status } : {}),
        ...(dto.category ? { category: dto.category } : {}),
        ...(dto.search
          ? {
              OR: [
                { name: { contains: dto.search, mode: 'insensitive' as const } },
                { assetTag: { contains: dto.search, mode: 'insensitive' as const } },
                { serialNumber: { contains: dto.search, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      select: assetSelect,
      orderBy: { createdAt: 'desc' },
      take: dto.limit,
    });

    // Attach the current holder (open assignment) for each asset.
    const open = await prisma.assetAssignment.findMany({
      where: { assetId: { in: assets.map((a) => a.id) }, returnedAt: null },
      select: {
        id: true, assetId: true, assignedAt: true,
        employee: { select: { id: true, firstName: true, lastName: true } },
      },
    });
    return assets.map((a) => {
      const holder = open.find((o) => o.assetId === a.id);
      return {
        ...a,
        assignment: holder
          ? { id: holder.id, assignedAt: holder.assignedAt, employee: holder.employee }
          : null,
      };
    });
  },

  async assetHistory(assetId: string) {
    const asset = await prisma.asset.findFirst({ where: { id: assetId, deletedAt: null }, select: assetSelect });
    if (!asset) throw new NotFoundError('Asset');
    const history = await prisma.assetAssignment.findMany({
      where: { assetId },
      orderBy: { assignedAt: 'desc' },
      select: {
        id: true, assignedAt: true, returnedAt: true, notes: true,
        employee: { select: { id: true, firstName: true, lastName: true, employeeNumber: true } },
      },
    });
    return { ...asset, history };
  },

  async createAsset(dto: z.infer<typeof assetSchema>) {
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId() }, select: { currency: true } });
    return prisma.asset.create({
      data: {
        organizationId: orgId(),
        assetTag: await nextAssetTag(),
        name: dto.name,
        category: dto.category,
        serialNumber: dto.serialNumber ?? null,
        purchaseDate: dto.purchaseDate ?? null,
        purchaseCost: dto.purchaseCost ?? null,
        currency: org.currency,
        notes: dto.notes ?? null,
        status: dto.status ?? 'AVAILABLE',
      },
      select: assetSelect,
    });
  },

  async updateAsset(id: string, dto: z.infer<typeof assetSchema>) {
    const existing = await prisma.asset.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new NotFoundError('Asset');
    // Status is driven by assign/return — don't let a manual edit desync it.
    if (dto.status === 'ASSIGNED' && existing.status !== 'ASSIGNED') {
      throw new ConflictError('Assign the asset to an employee instead of setting this status directly');
    }
    if (existing.status === 'ASSIGNED' && dto.status && dto.status !== 'ASSIGNED') {
      throw new ConflictError('Return the asset before changing its status');
    }
    return prisma.asset.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.category !== undefined ? { category: dto.category } : {}),
        ...(dto.serialNumber !== undefined ? { serialNumber: dto.serialNumber } : {}),
        ...(dto.purchaseDate !== undefined ? { purchaseDate: dto.purchaseDate } : {}),
        ...(dto.purchaseCost !== undefined ? { purchaseCost: dto.purchaseCost } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
      },
      select: assetSelect,
    });
  },

  async deleteAsset(id: string) {
    const existing = await prisma.asset.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new NotFoundError('Asset');
    if (existing.status === 'ASSIGNED') throw new ConflictError('Return the asset before removing it');
    await prisma.asset.update({ where: { id }, data: { deletedAt: new Date(), status: 'RETIRED' } });
    return { deleted: true };
  },

  /** Hand an asset to an employee (one open assignment at a time). */
  async assignAsset(assetId: string, dto: z.infer<typeof assignAssetSchema>) {
    const [asset, employee] = await Promise.all([
      prisma.asset.findFirst({ where: { id: assetId, deletedAt: null } }),
      prisma.employee.findFirst({ where: { id: dto.employeeId, deletedAt: null } }),
    ]);
    if (!asset) throw new NotFoundError('Asset');
    if (!employee) throw new NotFoundError('Employee');
    if (asset.status === 'ASSIGNED') throw new ConflictError('Asset is already assigned — return it first');
    if (['RETIRED', 'LOST'].includes(asset.status)) throw new ConflictError(`Asset is ${asset.status.toLowerCase()}`);

    const assignment = await prisma.assetAssignment.create({
      data: { organizationId: orgId(), assetId, employeeId: dto.employeeId, notes: dto.notes ?? null },
    });
    await prisma.asset.update({ where: { id: assetId }, data: { status: 'ASSIGNED' } });
    await activityService.record({
      type: 'SYSTEM', entityType: 'EMPLOYEE', entityId: dto.employeeId,
      title: `Asset assigned — ${asset.name} (${asset.assetTag})`,
      body: dto.notes ?? undefined,
    });
    return assignment;
  },

  /** Take an asset back; its next status is chosen at return time. */
  async returnAsset(assetId: string, dto: z.infer<typeof returnAssetSchema>) {
    const asset = await prisma.asset.findFirst({ where: { id: assetId, deletedAt: null } });
    if (!asset) throw new NotFoundError('Asset');
    const open = await prisma.assetAssignment.findFirst({ where: { assetId, returnedAt: null } });
    if (!open) throw new ConflictError('Asset is not currently assigned');

    await prisma.assetAssignment.update({
      where: { id: open.id },
      data: { returnedAt: new Date(), notes: dto.notes ?? open.notes },
    });
    const updated = await prisma.asset.update({ where: { id: assetId }, data: { status: dto.status }, select: assetSelect });
    await activityService.record({
      type: 'SYSTEM', entityType: 'EMPLOYEE', entityId: open.employeeId,
      title: `Asset returned — ${asset.name} (${asset.assetTag})`,
      body: `Now ${dto.status.toLowerCase()}${dto.notes ? ` · ${dto.notes}` : ''}`,
    });
    return updated;
  },

  // ---------------------------------------------------------------- expenses
  async listExpenses(dto: z.infer<typeof listExpensesSchema>) {
    return prisma.expenseClaim.findMany({
      where: {
        ...(dto.status ? { status: dto.status } : {}),
        ...(dto.employeeId ? { employeeId: dto.employeeId } : {}),
      },
      select: expenseSelect,
      orderBy: { createdAt: 'desc' },
      take: dto.limit,
    });
  },

  async createExpense(dto: z.infer<typeof expenseSchema>) {
    const employee = await prisma.employee.findFirst({ where: { id: dto.employeeId, deletedAt: null } });
    if (!employee) throw new NotFoundError('Employee');
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId() }, select: { currency: true } });

    const claim = await prisma.expenseClaim.create({
      data: {
        organizationId: orgId(),
        reference: await nextExpenseRef(),
        employeeId: dto.employeeId,
        title: dto.title,
        category: dto.category,
        amount: dto.amount,
        currency: org.currency,
        incurredAt: dto.incurredAt,
        description: dto.description ?? null,
        status: 'SUBMITTED',
      },
      select: expenseSelect,
    });
    await activityService.record({
      type: 'SYSTEM', entityType: 'EMPLOYEE', entityId: dto.employeeId,
      title: `Expense claimed — ${claim.reference} (${org.currency} ${dto.amount.toFixed(2)})`,
      body: dto.title,
    });
    return claim;
  },

  async decideExpense(id: string, dto: z.infer<typeof decideExpenseSchema>) {
    const claim = await prisma.expenseClaim.findFirst({ where: { id } });
    if (!claim) throw new NotFoundError('Expense claim');
    if (claim.status !== 'SUBMITTED') throw new ConflictError('This claim has already been decided');

    const updated = await prisma.expenseClaim.update({
      where: { id },
      data: {
        status: dto.status,
        approverId: actorMembershipId(),
        decidedAt: new Date(),
        decisionNote: dto.decisionNote ?? null,
      },
      select: expenseSelect,
    });
    await activityService.record({
      type: 'STATUS_CHANGE', entityType: 'EMPLOYEE', entityId: claim.employeeId,
      title: `Expense ${dto.status.toLowerCase()} — ${claim.reference}`,
      body: dto.decisionNote,
    });
    return updated;
  },

  /** Mark an approved claim reimbursed (payout itself happens outside this module). */
  async reimburseExpense(id: string) {
    const claim = await prisma.expenseClaim.findFirst({ where: { id } });
    if (!claim) throw new NotFoundError('Expense claim');
    if (claim.status !== 'APPROVED') throw new ConflictError('Only approved claims can be reimbursed');

    const updated = await prisma.expenseClaim.update({
      where: { id },
      data: { status: 'REIMBURSED', reimbursedAt: new Date() },
      select: expenseSelect,
    });
    await activityService.record({
      type: 'SYSTEM', entityType: 'EMPLOYEE', entityId: claim.employeeId,
      title: `Expense reimbursed — ${claim.reference} (${claim.currency} ${Number(claim.amount).toFixed(2)})`,
    });
    return updated;
  },
};
