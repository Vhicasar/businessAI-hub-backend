import { z } from 'zod';
import { prisma } from '../../infrastructure/database/prisma';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors';
import { auditDiff, auditService } from '../audit/audit.service';
import { currentOrgId } from '../billing/entitlements';
import { bomService } from './bom.service';
import { productionOrdersService } from './production-orders.service';
import type { ProductionPlanStatus } from '@prisma/client';

/**
 * Production planning — what the business intends to make, before it commits.
 *
 * A plan is deliberately not a production order. It is where quantities and
 * dates are still argued about, and where the material requirement can be
 * looked at without anything being reserved or issued. Approving one turns it
 * into an order; until then nothing has happened.
 */

export const createPlanSchema = z.object({
  productId: z.string().min(1),
  quantity: z.coerce.number().positive(),
  productionDate: z.coerce.date(),
  expectedCompletionDate: z.coerce.date().nullable().optional(),
  /** Omitted, the product's active BOM is used when requirements are worked out. */
  bomId: z.string().min(1).nullable().optional(),
  productionLineId: z.string().min(1).nullable().optional(),
  warehouseId: z.string().min(1).nullable().optional(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).default('NORMAL'),
  responsibleEmployeeId: z.string().min(1).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

export const updatePlanSchema = createPlanSchema.omit({ productId: true }).partial();

export const listPlansSchema = z.object({
  status: z.enum(['DRAFT', 'PLANNED', 'APPROVED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']).optional(),
  productId: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const planSelect = {
  id: true, planNumber: true, status: true, priority: true, quantity: true,
  productionDate: true, expectedCompletionDate: true, responsibleEmployeeId: true,
  notes: true, createdAt: true,
  product: { select: { id: true, name: true, unit: true } },
  bom: { select: { id: true, bomNumber: true, version: true } },
  productionLine: { select: { id: true, name: true, code: true, status: true } },
  warehouse: { select: { id: true, name: true, code: true } },
} as const;

/**
 * A plan moves forward, or it is abandoned.
 *
 * `APPROVED` is the point of no return in the sense that matters: it is what
 * production orders are raised from, so a plan cannot quietly go back to being
 * a draft once runs exist against it.
 */
const TRANSITIONS: Record<ProductionPlanStatus, ProductionPlanStatus[]> = {
  DRAFT: ['PLANNED', 'CANCELLED'],
  PLANNED: ['APPROVED', 'DRAFT', 'CANCELLED'],
  APPROVED: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

export const productionPlanningService = {
  async list(dto: z.infer<typeof listPlansSchema>) {
    return prisma.productionPlan.findMany({
      where: {
        deletedAt: null,
        ...(dto.status ? { status: dto.status } : {}),
        ...(dto.productId ? { productId: dto.productId } : {}),
        ...(dto.from || dto.to
          ? {
              productionDate: {
                ...(dto.from ? { gte: dto.from } : {}),
                ...(dto.to ? { lte: dto.to } : {}),
              },
            }
          : {}),
      },
      select: { ...planSelect, _count: { select: { orders: true } } },
      orderBy: [{ productionDate: 'asc' }, { priority: 'desc' }],
      take: dto.limit,
    });
  },

  async get(id: string) {
    const plan = await prisma.productionPlan.findFirst({
      where: { id, deletedAt: null },
      select: {
        ...planSelect,
        orders: { select: { id: true, orderNumber: true, status: true, plannedQuantity: true } },
      },
    });
    if (!plan) throw new NotFoundError('Production plan');
    return plan;
  },

  async create(dto: z.infer<typeof createPlanSchema>) {
    const product = await prisma.product.findFirst({
      where: { id: dto.productId, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!product) throw new NotFoundError('Product');

    // Resolved now so the plan records which recipe it was costed against,
    // even if a new version is activated before it runs.
    const bom = dto.bomId
      ? await prisma.billOfMaterial.findFirst({
          where: { id: dto.bomId, deletedAt: null },
          select: { id: true, productId: true },
        })
      : await bomService.activeFor(dto.productId);
    if (bom && bom.productId !== dto.productId) {
      throw new ValidationError('That bill of materials is for a different product.');
    }

    const planNumber = await nextPlanNumber();
    const plan = await prisma.productionPlan.create({
      data: {
        organizationId: currentOrgId(),
        planNumber,
        productId: dto.productId,
        bomId: bom?.id ?? null,
        quantity: dto.quantity,
        productionDate: dto.productionDate,
        expectedCompletionDate: dto.expectedCompletionDate ?? null,
        productionLineId: dto.productionLineId ?? null,
        warehouseId: dto.warehouseId ?? null,
        priority: dto.priority,
        responsibleEmployeeId: dto.responsibleEmployeeId ?? null,
        notes: dto.notes ?? null,
      },
      select: planSelect,
    });

    await auditService
      .record({
        action: 'production_plan.created',
        entityType: 'PRODUCTION_PLAN',
        entityId: plan.id,
        after: { planNumber, product: product.name, quantity: dto.quantity, date: dto.productionDate },
      })
      .catch(() => {});
    return plan;
  },

  async update(id: string, dto: z.infer<typeof updatePlanSchema>) {
    const before = await prisma.productionPlan.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, status: true, _count: { select: { orders: true } } },
    });
    if (!before) throw new NotFoundError('Production plan');
    if (before._count.orders > 0) {
      throw new ValidationError(
        'Production orders have already been raised from this plan, so it can no longer be changed. ' +
          'Change the orders instead.',
      );
    }
    if (['COMPLETED', 'CANCELLED'].includes(before.status)) {
      throw new ValidationError(`A ${before.status.toLowerCase()} plan cannot be changed.`);
    }

    const plan = await prisma.productionPlan.update({
      where: { id },
      data: {
        ...(dto.quantity !== undefined ? { quantity: dto.quantity } : {}),
        ...(dto.productionDate !== undefined ? { productionDate: dto.productionDate } : {}),
        ...(dto.expectedCompletionDate !== undefined ? { expectedCompletionDate: dto.expectedCompletionDate } : {}),
        ...(dto.bomId !== undefined ? { bomId: dto.bomId } : {}),
        ...(dto.productionLineId !== undefined ? { productionLineId: dto.productionLineId } : {}),
        ...(dto.warehouseId !== undefined ? { warehouseId: dto.warehouseId } : {}),
        ...(dto.priority !== undefined ? { priority: dto.priority } : {}),
        ...(dto.responsibleEmployeeId !== undefined ? { responsibleEmployeeId: dto.responsibleEmployeeId } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
      },
      select: planSelect,
    });
    const diff = auditDiff(before as never, plan as never, [
      'quantity', 'productionDate', 'expectedCompletionDate', 'bomId',
      'productionLineId', 'warehouseId', 'priority', 'responsibleEmployeeId', 'notes',
    ]);
    if (diff) {
      await auditService
        .record({
          action: 'production_plan.updated',
          entityType: 'PRODUCTION_PLAN',
          entityId: id,
          before: diff.before,
          after: diff.after,
        })
        .catch(() => {});
    }
    return plan;
  },

  /**
   * What this plan will need.
   *
   * The §6 calculation: recipe scaled to the planned quantity. Nothing is
   * reserved and nothing moves — a plan is a question, and this is the answer
   * to "what would this cost us in materials".
   */
  async requirements(id: string) {
    const plan = await prisma.productionPlan.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true, planNumber: true, quantity: true, bomId: true, productId: true,
        product: { select: { id: true, name: true, unit: true } },
      },
    });
    if (!plan) throw new NotFoundError('Production plan');

    const bomId = plan.bomId ?? (await bomService.activeFor(plan.productId))?.id;
    if (!bomId) {
      throw new ValidationError(
        `${plan.product.name} has no active bill of materials, so what this plan needs cannot be worked out.`,
      );
    }
    const requirements = await bomService.requirementsFor(bomId, Number(plan.quantity));
    return { planNumber: plan.planNumber, ...requirements };
  },

  async transition(id: string, to: ProductionPlanStatus, reason?: string) {
    const plan = await prisma.productionPlan.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, status: true, planNumber: true },
    });
    if (!plan) throw new NotFoundError('Production plan');

    const allowed = TRANSITIONS[plan.status];
    if (!allowed.includes(to)) {
      throw new ConflictError(
        allowed.length === 0
          ? `${plan.planNumber} is ${plan.status.toLowerCase()} and cannot change.`
          : `A ${plan.status.toLowerCase()} plan can only become ${allowed.map((s) => s.toLowerCase()).join(' or ')}.`,
      );
    }

    const updated = await prisma.productionPlan.update({
      where: { id },
      data: { status: to },
      select: planSelect,
    });
    await auditService
      .record({
        action: `production_plan.${to.toLowerCase()}`,
        entityType: 'PRODUCTION_PLAN',
        entityId: id,
        before: { status: plan.status },
        after: { status: to },
        reason: reason ?? null,
      })
      .catch(() => {});
    return updated;
  },

  /**
   * Turn an approved plan into a production order.
   *
   * The moment intention becomes commitment: the order freezes the recipe and
   * the requirement, and from here material can actually be issued against it.
   */
  async raiseOrder(id: string, actorOverrides: { startDate?: Date } = {}) {
    const plan = await prisma.productionPlan.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true, planNumber: true, status: true, productId: true, bomId: true,
        quantity: true, productionDate: true, expectedCompletionDate: true,
        productionLineId: true, warehouseId: true, priority: true,
        responsibleEmployeeId: true,
      },
    });
    if (!plan) throw new NotFoundError('Production plan');
    if (plan.status !== 'APPROVED' && plan.status !== 'IN_PROGRESS') {
      throw new ValidationError(
        'Only an approved plan can be turned into a production order — approving it is the decision to commit.',
      );
    }

    const order = await productionOrdersService.create({
      productId: plan.productId,
      bomId: plan.bomId ?? undefined,
      plannedQuantity: Number(plan.quantity),
      planId: plan.id,
      productionLineId: plan.productionLineId,
      warehouseId: plan.warehouseId,
      startDate: actorOverrides.startDate ?? plan.productionDate,
      expectedCompletionDate: plan.expectedCompletionDate,
      responsibleEmployeeId: plan.responsibleEmployeeId,
      priority: plan.priority,
    } as never);

    if (plan.status === 'APPROVED') {
      await prisma.productionPlan.update({ where: { id }, data: { status: 'IN_PROGRESS' } });
    }

    await auditService
      .record({
        action: 'production_plan.order_raised',
        entityType: 'PRODUCTION_PLAN',
        entityId: id,
        after: { planNumber: plan.planNumber, orderId: order.id, orderNumber: order.orderNumber },
      })
      .catch(() => {});
    return order;
  },
};

async function nextPlanNumber(): Promise<string> {
  const count = await prisma.productionPlan.count();
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = `PLAN-${String(count + 1 + attempt).padStart(5, '0')}`;
    const clash = await prisma.productionPlan.findFirst({
      where: { planNumber: candidate },
      select: { id: true },
    });
    if (!clash) return candidate;
  }
  throw new ConflictError('Could not allocate a production plan number.');
}
