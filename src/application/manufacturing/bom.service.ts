import { z } from 'zod';
import { prisma } from '../../infrastructure/database/prisma';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors';
import { auditDiff, auditService } from '../audit/audit.service';
import { currentOrgId } from '../billing/entitlements';
import { manufacturingSettings } from './settings.service';

/**
 * Bills of material — what it takes to make one product.
 *
 * A BOM is written for a batch size, not a unit: "650kg of sugar" means
 * nothing without "per 1,000 cases". Everything downstream scales from
 * `outputQuantity`, which is why it is required and why it cannot be zero.
 *
 * Versions exist because recipes change and old production runs must still be
 * explicable. A new version supersedes rather than edits, and exactly one
 * version is active per product unless the business has deliberately said
 * otherwise — two active recipes means production picks one arbitrarily, and
 * nobody can tell afterwards which was used.
 */

export const bomItemSchema = z.object({
  variantId: z.string().min(1),
  quantity: z.coerce.number().positive(),
  unit: z.string().trim().max(24).nullable().optional(),
  /** Expected handling loss. Requirements are grossed up by this. */
  scrapPercent: z.coerce.number().min(0).max(100).default(0),
  notes: z.string().trim().max(500).nullable().optional(),
});

export const createBomSchema = z.object({
  productId: z.string().min(1),
  outputQuantity: z.coerce.number().positive(),
  effectiveFrom: z.coerce.date().nullable().optional(),
  warehouseId: z.string().min(1).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  items: z.array(bomItemSchema).min(1, 'A bill of materials needs at least one component'),
  /** Activate immediately rather than leaving it as a draft. */
  activate: z.boolean().optional(),
});

export const updateBomSchema = createBomSchema
  .omit({ productId: true, activate: true })
  .partial();

export const listBomsSchema = z.object({
  productId: z.string().optional(),
  status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']).optional(),
  search: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const bomSelect = {
  id: true, bomNumber: true, version: true, status: true, effectiveFrom: true,
  // Exposed so a caller can confirm a BOM belongs to the product it is about
  // to be used for, without a second query.
  productId: true,
  outputQuantity: true, notes: true, createdAt: true, updatedAt: true,
  product: { select: { id: true, name: true, unit: true } },
  warehouse: { select: { id: true, name: true, code: true } },
} as const;

const itemSelect = {
  id: true, quantity: true, unit: true, scrapPercent: true, notes: true,
  variant: {
    select: {
      id: true, sku: true, name: true,
      product: { select: { id: true, name: true, unit: true, manufacturingType: true } },
    },
  },
} as const;

export const bomService = {
  async list(dto: z.infer<typeof listBomsSchema>) {
    return prisma.billOfMaterial.findMany({
      where: {
        deletedAt: null,
        ...(dto.productId ? { productId: dto.productId } : {}),
        ...(dto.status ? { status: dto.status } : {}),
        ...(dto.search
          ? {
              OR: [
                { bomNumber: { contains: dto.search, mode: 'insensitive' as const } },
                { product: { name: { contains: dto.search, mode: 'insensitive' as const } } },
              ],
            }
          : {}),
      },
      select: { ...bomSelect, _count: { select: { items: true } } },
      orderBy: [{ createdAt: 'desc' }],
      take: dto.limit,
    });
  },

  async get(id: string) {
    const bom = await prisma.billOfMaterial.findFirst({
      where: { id, deletedAt: null },
      select: { ...bomSelect, items: { select: itemSelect } },
    });
    if (!bom) throw new NotFoundError('Bill of materials');
    return bom;
  },

  /**
   * The recipe production should use for a product right now.
   *
   * Null rather than an error when there is none: a product with no BOM is an
   * ordinary state (nobody has written the recipe yet), and the caller says so
   * far better than a 404 from here would.
   */
  async activeFor(productId: string) {
    return prisma.billOfMaterial.findFirst({
      where: { productId, status: 'ACTIVE', deletedAt: null },
      select: { ...bomSelect, items: { select: itemSelect } },
      orderBy: { version: 'desc' },
    });
  },

  async create(dto: z.infer<typeof createBomSchema>) {
    const product = await prisma.product.findFirst({
      where: { id: dto.productId, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!product) throw new NotFoundError('Product');

    await assertComponentsExist(dto.items, dto.productId);

    // Versions are per product and run upwards, so the newest is obvious
    // without comparing dates.
    const latest = await prisma.billOfMaterial.findFirst({
      where: { productId: dto.productId },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const version = (latest?.version ?? 0) + 1;
    const bomNumber = await nextBomNumber();

    const bom = await prisma.$transaction(async (tx) => {
      if (dto.activate) await deactivateOthers(tx, dto.productId, null);
      return tx.billOfMaterial.create({
        data: {
          organizationId: currentOrgId(),
          bomNumber,
          productId: dto.productId,
          version,
          status: dto.activate ? 'ACTIVE' : 'DRAFT',
          effectiveFrom: dto.effectiveFrom ?? (dto.activate ? new Date() : null),
          outputQuantity: dto.outputQuantity,
          warehouseId: dto.warehouseId ?? null,
          notes: dto.notes ?? null,
          items: {
            create: dto.items.map((item) => ({
              organizationId: currentOrgId(),
              variantId: item.variantId,
              quantity: item.quantity,
              unit: item.unit ?? null,
              scrapPercent: item.scrapPercent,
              notes: item.notes ?? null,
            })),
          },
        },
        select: { ...bomSelect, items: { select: itemSelect } },
      });
    });

    await auditService
      .record({
        action: 'bom.created',
        entityType: 'BILL_OF_MATERIAL',
        entityId: bom.id,
        after: {
          bomNumber, version, product: product.name,
          components: dto.items.length, status: bom.status,
        },
      })
      .catch(() => {});
    return bom;
  },

  /**
   * Change a draft.
   *
   * An active BOM is not editable: production orders reference it and were
   * costed against it, so changing it underneath them would rewrite what
   * already happened. Supersede it with a new version instead.
   */
  async update(id: string, dto: z.infer<typeof updateBomSchema>) {
    const before = await prisma.billOfMaterial.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true, status: true, bomNumber: true, productId: true,
        outputQuantity: true, effectiveFrom: true, warehouseId: true, notes: true,
        // Counted, not compared field by field: a recipe's components are
        // replaced wholesale, and "12 components became 9" is the fact an
        // auditor needs.
        _count: { select: { items: true } },
      },
    });
    if (!before) throw new NotFoundError('Bill of materials');
    if (before.status !== 'DRAFT') {
      throw new ValidationError(
        'Only a draft can be edited. Create a new version to change an active recipe — ' +
          'production orders already reference this one.',
      );
    }
    if (dto.items) await assertComponentsExist(dto.items, before.productId);

    const bom = await prisma.$transaction(async (tx) => {
      if (dto.items) {
        await tx.billOfMaterialItem.deleteMany({ where: { bomId: id } });
        await tx.billOfMaterialItem.createMany({
          data: dto.items.map((item) => ({
            organizationId: currentOrgId(),
            bomId: id,
            variantId: item.variantId,
            quantity: item.quantity,
            unit: item.unit ?? null,
            scrapPercent: item.scrapPercent,
            notes: item.notes ?? null,
          })),
        });
      }
      return tx.billOfMaterial.update({
        where: { id },
        data: {
          ...(dto.outputQuantity !== undefined ? { outputQuantity: dto.outputQuantity } : {}),
          ...(dto.effectiveFrom !== undefined ? { effectiveFrom: dto.effectiveFrom } : {}),
          ...(dto.warehouseId !== undefined ? { warehouseId: dto.warehouseId } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
        },
        select: { ...bomSelect, items: { select: itemSelect } },
      });
    });

    const diff = auditDiff(before as never, bom as never, [
      'outputQuantity', 'effectiveFrom', 'warehouseId', 'notes',
    ]);
    const componentsChanged = dto.items !== undefined && bom.items.length !== before._count.items;
    if (diff || componentsChanged) {
      await auditService
        .record({
          action: 'bom.updated',
          entityType: 'BILL_OF_MATERIAL',
          entityId: id,
          before: {
            ...(diff?.before ?? {}),
            ...(componentsChanged ? { componentCount: before._count.items } : {}),
          },
          after: {
            bomNumber: before.bomNumber,
            ...(diff?.after ?? {}),
            ...(componentsChanged ? { componentCount: bom.items.length } : {}),
          },
        })
        .catch(() => {});
    }
    return bom;
  },

  /**
   * Make this the recipe production uses.
   *
   * Deactivates the other versions unless the business has allowed several at
   * once — which is a deliberate setting, because the cost of getting it wrong
   * is a run made to a recipe nobody can identify afterwards.
   */
  async activate(id: string) {
    const bom = await prisma.billOfMaterial.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, productId: true, bomNumber: true, version: true, status: true, items: { select: { id: true } } },
    });
    if (!bom) throw new NotFoundError('Bill of materials');
    if (bom.items.length === 0) {
      throw new ValidationError('A bill of materials with no components cannot be activated.');
    }
    if (bom.status === 'ACTIVE') return this.get(id);

    const settings = await manufacturingSettings.get();
    const updated = await prisma.$transaction(async (tx) => {
      if (!settings.allowMultipleActiveBoms) {
        await deactivateOthers(tx, bom.productId, id);
      }
      return tx.billOfMaterial.update({
        where: { id },
        data: { status: 'ACTIVE', effectiveFrom: new Date() },
        select: { ...bomSelect, items: { select: itemSelect } },
      });
    });

    await auditService
      .record({
        action: 'bom.activated',
        entityType: 'BILL_OF_MATERIAL',
        entityId: id,
        before: { status: bom.status },
        after: { status: 'ACTIVE', version: bom.version },
      })
      .catch(() => {});
    return updated;
  },

  async archive(id: string) {
    const bom = await prisma.billOfMaterial.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, status: true, _count: { select: { productionOrders: true } } },
    });
    if (!bom) throw new NotFoundError('Bill of materials');

    // Kept rather than deleted when production has used it: the orders that
    // reference it have to stay explicable.
    const used = bom._count.productionOrders > 0;
    const updated = await prisma.billOfMaterial.update({
      where: { id },
      data: used ? { status: 'ARCHIVED' } : { status: 'ARCHIVED', deletedAt: new Date() },
      select: bomSelect,
    });
    await auditService
      .record({
        action: 'bom.archived',
        entityType: 'BILL_OF_MATERIAL',
        entityId: id,
        after: { removed: !used, usedByOrders: bom._count.productionOrders },
      })
      .catch(() => {});
    return { ...updated, removed: !used };
  },

  /**
   * What making `quantity` of the product needs.
   *
   * The scaling everything downstream depends on: production planning, the
   * shortage check and the procurement recommendation all ask this and then
   * compare the answer with stock. Scrap is included, because a recipe that
   * needs 100 bottles and loses 2% needs 102 to be bought.
   */
  async requirementsFor(bomId: string, quantity: number) {
    const bom = await prisma.billOfMaterial.findFirst({
      where: { id: bomId, deletedAt: null },
      select: {
        id: true, outputQuantity: true, bomNumber: true, version: true,
        product: { select: { id: true, name: true } },
        items: { select: itemSelect },
      },
    });
    if (!bom) throw new NotFoundError('Bill of materials');

    const batchSize = Number(bom.outputQuantity);
    if (batchSize <= 0) {
      throw new ValidationError('This recipe has no output quantity, so nothing can be scaled from it.');
    }
    const multiplier = quantity / batchSize;

    return {
      bomId: bom.id,
      bomNumber: bom.bomNumber,
      version: bom.version,
      product: bom.product,
      /** What was asked for, and what the recipe is written for. */
      requestedQuantity: quantity,
      batchSize,
      items: bom.items.map((item) => {
        const base = Number(item.quantity) * multiplier;
        const scrap = base * (Number(item.scrapPercent) / 100);
        return {
          variantId: item.variant.id,
          sku: item.variant.sku,
          name: item.variant.product.name,
          manufacturingType: item.variant.product.manufacturingType,
          unit: item.unit ?? item.variant.product.unit,
          perBatch: Number(item.quantity),
          scrapPercent: Number(item.scrapPercent),
          /** Before wastage — what the recipe literally says. */
          baseQuantity: round3(base),
          scrapQuantity: round3(scrap),
          /** What actually has to be available. */
          requiredQuantity: round3(base + scrap),
        };
      }),
    };
  },
};

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Only one active version per product, unless the business allows more. */
async function deactivateOthers(
  tx: { billOfMaterial: { updateMany: (args: never) => Promise<unknown> } },
  productId: string,
  exceptId: string | null,
) {
  await tx.billOfMaterial.updateMany({
    where: {
      productId,
      status: 'ACTIVE',
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    data: { status: 'ARCHIVED' },
  } as never);
}

/**
 * Components have to exist, and a product cannot be made out of itself.
 *
 * The self-reference check matters more than it looks: a BOM listing its own
 * output as an input produces a requirement calculation that never terminates
 * in any system that later tries to explode nested recipes.
 */
async function assertComponentsExist(
  items: { variantId: string }[],
  productId: string,
): Promise<void> {
  const ids = [...new Set(items.map((i) => i.variantId))];
  if (ids.length !== items.length) {
    throw new ValidationError('The same component is listed more than once.');
  }
  const found = await prisma.productVariant.findMany({
    where: { id: { in: ids }, deletedAt: null },
    select: { id: true, productId: true, sku: true },
  });
  if (found.length !== ids.length) {
    throw new ValidationError('One or more components no longer exist.');
  }
  const selfReference = found.find((v) => v.productId === productId);
  if (selfReference) {
    throw new ValidationError(
      `A product cannot be a component of itself (${selfReference.sku}).`,
    );
  }
}

async function nextBomNumber(): Promise<string> {
  const count = await prisma.billOfMaterial.count();
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = `BOM-${String(count + 1 + attempt).padStart(5, '0')}`;
    const clash = await prisma.billOfMaterial.findFirst({
      where: { bomNumber: candidate },
      select: { id: true },
    });
    if (!clash) return candidate;
  }
  throw new ConflictError('Could not allocate a bill-of-materials number.');
}
