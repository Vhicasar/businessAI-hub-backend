import { z } from 'zod';
import type { Prisma } from '@prisma/client';

import { prisma, prismaUnscoped } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors';
import { auditService } from '../audit/audit.service';
import { ZERO, money } from '../../shared/money';

const currentOrgId = (): string => {
  const id = requestContext.get()?.organizationId;
  if (!id) throw new ValidationError('No tenant in context');
  return id;
};

// ---------------------------------------------------------------- schemas

export const supplierSchema = z.object({
  name: z.string().trim().min(1).max(160),
  code: z.string().trim().max(40).nullable().optional(),
  contactName: z.string().trim().max(120).nullable().optional(),
  email: z.string().trim().email().max(200).nullable().optional().or(z.literal('')),
  phone: z.string().trim().max(40).nullable().optional(),
  website: z.string().trim().max(300).nullable().optional(),
  addressLine1: z.string().trim().max(200).nullable().optional(),
  addressLine2: z.string().trim().max(200).nullable().optional(),
  city: z.string().trim().max(100).nullable().optional(),
  state: z.string().trim().max(100).nullable().optional(),
  postalCode: z.string().trim().max(30).nullable().optional(),
  country: z.string().trim().length(2).toUpperCase().nullable().optional(),
  paymentTerms: z.string().trim().max(120).nullable().optional(),
  currency: z.string().trim().length(3).toUpperCase().nullable().optional(),
  taxId: z.string().trim().max(60).nullable().optional(),
  leadTimeDays: z.coerce.number().int().min(0).max(365).nullable().optional(),
  rating: z.coerce.number().int().min(1).max(5).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
  isActive: z.boolean().optional(),
});
export const updateSupplierSchema = supplierSchema.partial();

export const listSuppliersSchema = z.object({
  search: z.string().trim().max(120).optional(),
  tag: z.string().trim().max(40).optional(),
  /** Default is active-only; the archive is opt-in so the list stays useful. */
  includeInactive: z.coerce.boolean().default(false),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const supplierContactSchema = z.object({
  name: z.string().trim().min(1).max(120),
  role: z.string().trim().max(80).nullable().optional(),
  email: z.string().trim().email().max(200).nullable().optional().or(z.literal('')),
  phone: z.string().trim().max(40).nullable().optional(),
  isPrimary: z.boolean().optional(),
});

export const supplierProductSchema = z.object({
  productId: z.string().min(1),
  supplierSku: z.string().trim().max(80).nullable().optional(),
  costPrice: z.coerce.number().nonnegative().nullable().optional(),
  currency: z.string().trim().length(3).toUpperCase().nullable().optional(),
  leadTimeDays: z.coerce.number().int().min(0).max(365).nullable().optional(),
  minOrderQty: z.coerce.number().positive().nullable().optional(),
  isPreferred: z.boolean().optional(),
});
export const updateSupplierProductSchema = supplierProductSchema.omit({ productId: true }).partial();

export type SupplierDto = z.infer<typeof supplierSchema>;
export type UpdateSupplierDto = z.infer<typeof updateSupplierSchema>;
export type SupplierContactDto = z.infer<typeof supplierContactSchema>;
export type SupplierProductDto = z.infer<typeof supplierProductSchema>;

/** Empty strings from a cleared form field mean "unset", not "set to ''". */
const blankToNull = <T extends Record<string, unknown>>(dto: T): T => {
  const out = { ...dto };
  for (const [k, v] of Object.entries(out)) {
    if (v === '') (out as Record<string, unknown>)[k] = null;
  }
  return out;
};

const view = (s: {
  id: string;
  name: string;
  code: string | null;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  paymentTerms: string | null;
  currency: string | null;
  taxId: string | null;
  leadTimeDays: number | null;
  rating: number | null;
  tags: string[];
  notes: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}) => ({ ...s });

export const suppliersService = {
  async list(q: z.infer<typeof listSuppliersSchema>) {
    const where: Prisma.SupplierWhereInput = {
      deletedAt: null,
      ...(q.includeInactive ? {} : { isActive: true }),
      ...(q.tag ? { tags: { has: q.tag } } : {}),
      ...(q.search
        ? {
            OR: [
              { name: { contains: q.search, mode: 'insensitive' as const } },
              { code: { contains: q.search, mode: 'insensitive' as const } },
              { email: { contains: q.search, mode: 'insensitive' as const } },
              { phone: { contains: q.search, mode: 'insensitive' as const } },
              { contactName: { contains: q.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const rows = await prisma.supplier.findMany({
      where,
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      include: { _count: { select: { products: true, purchaseOrders: true, contacts: true } } },
    });

    const hasMore = rows.length > q.limit;
    const items = hasMore ? rows.slice(0, q.limit) : rows;
    return {
      items: items.map((s) => ({
        ...view(s),
        productCount: s._count.products,
        purchaseOrderCount: s._count.purchaseOrders,
        contactCount: s._count.contacts,
      })),
      nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
    };
  },

  /** One supplier with everything the detail page shows in a single trip. */
  async get(id: string) {
    const supplier = await prisma.supplier.findFirst({
      where: { id, deletedAt: null },
      include: {
        contacts: { orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }] },
        products: {
          orderBy: [{ isPreferred: 'desc' }, { createdAt: 'desc' }],
          include: { product: { select: { id: true, name: true, slug: true, status: true } } },
        },
      },
    });
    if (!supplier) throw new NotFoundError('Supplier');

    return {
      ...view(supplier),
      contacts: supplier.contacts,
      products: supplier.products.map((p) => ({
        id: p.id,
        productId: p.productId,
        productName: p.product.name,
        productStatus: p.product.status,
        supplierSku: p.supplierSku,
        costPrice: p.costPrice?.toFixed(2) ?? null,
        currency: p.currency ?? supplier.currency,
        leadTimeDays: p.leadTimeDays ?? supplier.leadTimeDays,
        minOrderQty: p.minOrderQty?.toString() ?? null,
        isPreferred: p.isPreferred,
      })),
      performance: await this.performance(id),
    };
  },

  /**
   * Create a supplier — or bring back one of the same name that was deleted.
   *
   * A soft-deleted supplier keeps its row, and `(organizationId, name)` is
   * unique in the database, so a plain insert of a name that was used before
   * fails on a constraint the user cannot see: they deleted it, it is gone from
   * every list, and yet "already exists". Recreating a name that is only held
   * by a deleted record is unambiguously a request for that supplier back, so
   * that is what happens — its purchase-order history comes with it.
   */
  async create(dto: SupplierDto) {
    const organizationId = currentOrgId();
    const data = blankToNull(dto);

    // Scoped by organizationId explicitly: the tenant extension does not scope
    // a lookup that must see soft-deleted rows the normal filters hide.
    const sameName = await prismaUnscoped.supplier.findFirst({
      where: { organizationId, name: data.name },
    });
    if (sameName && sameName.deletedAt === null) {
      throw new ConflictError(
        sameName.isActive
          ? 'A supplier with this name already exists.'
          : `${sameName.name} already exists but is archived. Turn on "Show archived" to find and restore it.`
      );
    }

    const fields = {
      code: data.code ?? null,
      contactName: data.contactName ?? null,
      email: data.email ?? null,
      phone: data.phone ?? null,
      website: data.website ?? null,
      addressLine1: data.addressLine1 ?? null,
      addressLine2: data.addressLine2 ?? null,
      city: data.city ?? null,
      state: data.state ?? null,
      postalCode: data.postalCode ?? null,
      country: data.country ?? null,
      paymentTerms: data.paymentTerms ?? null,
      currency: data.currency ?? null,
      taxId: data.taxId ?? null,
      leadTimeDays: data.leadTimeDays ?? null,
      rating: data.rating ?? null,
      tags: data.tags ?? [],
      notes: data.notes ?? null,
      isActive: data.isActive ?? true,
    };

    if (sameName) {
      const restored = await prismaUnscoped.supplier.update({
        where: { id: sameName.id },
        data: { ...fields, deletedAt: null },
      });
      await auditService.record({
        action: 'supplier.restored',
        entityType: 'Supplier',
        entityId: restored.id,
        after: { name: restored.name },
      });
      return { ...view(restored), restored: true };
    }

    const supplier = await prisma.supplier.create({
      data: { organizationId, name: data.name, ...fields },
    });
    await auditService.record({
      action: 'supplier.created',
      entityType: 'Supplier',
      entityId: supplier.id,
      after: { name: supplier.name },
    });
    return { ...view(supplier), restored: false };
  },

  /** Bring an archived supplier back into the working list. */
  async restore(id: string) {
    const supplier = await prismaUnscoped.supplier.findFirst({
      where: { id, organizationId: currentOrgId() },
    });
    if (!supplier) throw new NotFoundError('Supplier');
    const restored = await prismaUnscoped.supplier.update({
      where: { id },
      data: { isActive: true, deletedAt: null },
    });
    await auditService.record({
      action: 'supplier.restored',
      entityType: 'Supplier',
      entityId: id,
      after: { name: restored.name },
    });
    return view(restored);
  },

  async update(id: string, dto: UpdateSupplierDto) {
    const existing = await prisma.supplier.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new NotFoundError('Supplier');
    const data = blankToNull(dto);

    if (data.name && data.name !== existing.name) {
      // Includes soft-deleted rows: they still hold the unique name, so
      // renaming onto one would fail on a constraint with no visible cause.
      const clash = await prismaUnscoped.supplier.findFirst({
        where: { organizationId: currentOrgId(), name: data.name, id: { not: id } },
        select: { id: true, deletedAt: true },
      });
      if (clash) {
        throw new ConflictError(
          clash.deletedAt
            ? 'That name belongs to a supplier you deleted. Create it again to bring it back, or choose another name.'
            : 'A supplier with this name already exists.'
        );
      }
    }

    const supplier = await prisma.supplier.update({ where: { id }, data });
    await auditService.record({
      action: 'supplier.updated',
      entityType: 'Supplier',
      entityId: id,
      before: { name: existing.name, isActive: existing.isActive },
      after: { name: supplier.name, isActive: supplier.isActive },
    });
    return view(supplier);
  },

  /**
   * Soft-delete. Purchase orders reference the supplier and are financial
   * records, so a supplier with history is archived rather than removed —
   * deleting it would orphan the paperwork it was ordered against.
   */
  async remove(id: string) {
    const supplier = await prisma.supplier.findFirst({
      where: { id, deletedAt: null },
      include: { _count: { select: { purchaseOrders: true } } },
    });
    if (!supplier) throw new NotFoundError('Supplier');

    if (supplier._count.purchaseOrders > 0) {
      const archived = await prisma.supplier.update({
        where: { id },
        data: { isActive: false },
      });
      await auditService.record({
        action: 'supplier.archived',
        entityType: 'Supplier',
        entityId: id,
        after: { name: archived.name, purchaseOrders: supplier._count.purchaseOrders },
      });
      return { id, archived: true, deleted: false };
    }

    await prisma.supplierProduct.deleteMany({ where: { supplierId: id } });
    await prisma.supplierContact.deleteMany({ where: { supplierId: id } });
    await prisma.supplier.update({ where: { id }, data: { deletedAt: new Date(), isActive: false } });
    await auditService.record({
      action: 'supplier.deleted',
      entityType: 'Supplier',
      entityId: id,
      before: { name: supplier.name },
    });
    return { id, archived: false, deleted: true };
  },

  // ---------------------------------------------------------------- contacts

  async addContact(supplierId: string, dto: SupplierContactDto) {
    const organizationId = currentOrgId();
    const supplier = await prisma.supplier.findFirst({ where: { id: supplierId, deletedAt: null } });
    if (!supplier) throw new NotFoundError('Supplier');
    const data = blankToNull(dto);

    // Exactly one primary contact, or the "who do I call" answer is ambiguous.
    if (data.isPrimary) {
      await prisma.supplierContact.updateMany({ where: { supplierId }, data: { isPrimary: false } });
    }
    return prisma.supplierContact.create({
      data: {
        organizationId,
        supplierId,
        name: data.name,
        role: data.role ?? null,
        email: data.email ?? null,
        phone: data.phone ?? null,
        isPrimary: data.isPrimary ?? false,
      },
    });
  },

  async updateContact(contactId: string, dto: Partial<SupplierContactDto>) {
    const contact = await prisma.supplierContact.findUnique({ where: { id: contactId } });
    if (!contact) throw new NotFoundError('Contact');
    const data = blankToNull(dto);
    if (data.isPrimary) {
      await prisma.supplierContact.updateMany({
        where: { supplierId: contact.supplierId, id: { not: contactId } },
        data: { isPrimary: false },
      });
    }
    return prisma.supplierContact.update({ where: { id: contactId }, data });
  },

  async removeContact(contactId: string) {
    const contact = await prisma.supplierContact.findUnique({ where: { id: contactId } });
    if (!contact) throw new NotFoundError('Contact');
    await prisma.supplierContact.delete({ where: { id: contactId } });
    return { id: contactId, deleted: true };
  },

  // ---------------------------------------------------------- product links

  /**
   * Tie a product to a supplier. Upserts on (supplier, product) so re-linking
   * an existing pair updates the terms instead of failing.
   */
  async linkProduct(supplierId: string, dto: SupplierProductDto) {
    const organizationId = currentOrgId();
    const [supplier, product] = await Promise.all([
      prisma.supplier.findFirst({ where: { id: supplierId, deletedAt: null }, select: { id: true } }),
      prisma.product.findFirst({ where: { id: dto.productId, deletedAt: null }, select: { id: true } }),
    ]);
    if (!supplier) throw new NotFoundError('Supplier');
    if (!product) throw new NotFoundError('Product');

    const data = blankToNull(dto);
    if (data.isPreferred) await this.clearPreferred(data.productId, supplierId);

    const link = await prisma.supplierProduct.upsert({
      where: { supplierId_productId: { supplierId, productId: data.productId } },
      create: {
        organizationId,
        supplierId,
        productId: data.productId,
        supplierSku: data.supplierSku ?? null,
        costPrice: data.costPrice ?? null,
        currency: data.currency ?? null,
        leadTimeDays: data.leadTimeDays ?? null,
        minOrderQty: data.minOrderQty ?? null,
        isPreferred: data.isPreferred ?? false,
      },
      update: {
        supplierSku: data.supplierSku ?? null,
        costPrice: data.costPrice ?? null,
        currency: data.currency ?? null,
        leadTimeDays: data.leadTimeDays ?? null,
        minOrderQty: data.minOrderQty ?? null,
        ...(data.isPreferred === undefined ? {} : { isPreferred: data.isPreferred }),
      },
    });
    return { ...link, costPrice: link.costPrice?.toFixed(2) ?? null, minOrderQty: link.minOrderQty?.toString() ?? null };
  },

  async updateProductLink(linkId: string, dto: z.infer<typeof updateSupplierProductSchema>) {
    const link = await prisma.supplierProduct.findUnique({ where: { id: linkId } });
    if (!link) throw new NotFoundError('Supplier product');
    const data = blankToNull(dto);
    if (data.isPreferred) await this.clearPreferred(link.productId, link.supplierId);
    const updated = await prisma.supplierProduct.update({ where: { id: linkId }, data });
    return {
      ...updated,
      costPrice: updated.costPrice?.toFixed(2) ?? null,
      minOrderQty: updated.minOrderQty?.toString() ?? null,
    };
  },

  async unlinkProduct(linkId: string) {
    const link = await prisma.supplierProduct.findUnique({ where: { id: linkId } });
    if (!link) throw new NotFoundError('Supplier product');
    await prisma.supplierProduct.delete({ where: { id: linkId } });
    return { id: linkId, deleted: true };
  },

  /** Only one supplier per product can be the preferred source. */
  async clearPreferred(productId: string, exceptSupplierId: string) {
    await prisma.supplierProduct.updateMany({
      where: { productId, supplierId: { not: exceptSupplierId }, isPreferred: true },
      data: { isPreferred: false },
    });
  },

  /** Suppliers for one product — what the product page and reorder flow show. */
  async forProduct(productId: string) {
    const links = await prisma.supplierProduct.findMany({
      where: { productId },
      orderBy: [{ isPreferred: 'desc' }, { createdAt: 'asc' }],
      include: {
        supplier: {
          select: { id: true, name: true, code: true, currency: true, leadTimeDays: true, isActive: true, deletedAt: true },
        },
      },
    });
    return links
      .filter((l) => l.supplier.deletedAt === null)
      .map((l) => ({
        id: l.id,
        supplierId: l.supplierId,
        supplierName: l.supplier.name,
        supplierCode: l.supplier.code,
        supplierActive: l.supplier.isActive,
        supplierSku: l.supplierSku,
        costPrice: l.costPrice?.toFixed(2) ?? null,
        currency: l.currency ?? l.supplier.currency,
        leadTimeDays: l.leadTimeDays ?? l.supplier.leadTimeDays,
        minOrderQty: l.minOrderQty?.toString() ?? null,
        isPreferred: l.isPreferred,
      }));
  },

  // ------------------------------------------------------------ performance

  /**
   * What this supplier has actually cost and how reliably they deliver.
   * On-time is measured against `expectedAt`: a purchase order with no expected
   * date can't be late, so it is excluded rather than counted as on time.
   */
  async performance(supplierId: string) {
    const orders = await prisma.purchaseOrder.findMany({
      where: { supplierId },
      select: { status: true, total: true, currency: true, expectedAt: true, receivedAt: true, orderedAt: true, createdAt: true },
    });

    const received = orders.filter((o) => o.receivedAt !== null);
    const measurable = received.filter((o) => o.expectedAt !== null);
    const onTime = measurable.filter((o) => o.receivedAt! <= o.expectedAt!);

    const spendByCurrency = new Map<string, Prisma.Decimal>();
    for (const o of orders) {
      if (o.status === 'CANCELLED') continue;
      spendByCurrency.set(o.currency, (spendByCurrency.get(o.currency) ?? ZERO).add(money(o.total)));
    }

    const leadTimes = received
      .filter((o) => o.orderedAt !== null)
      .map((o) => (o.receivedAt!.getTime() - o.orderedAt!.getTime()) / 86_400_000);

    return {
      purchaseOrders: orders.length,
      openOrders: orders.filter((o) => ['DRAFT', 'ORDERED', 'PARTIALLY_RECEIVED'].includes(o.status)).length,
      receivedOrders: received.length,
      spend: [...spendByCurrency.entries()].map(([currency, total]) => ({
        currency,
        total: total.toFixed(2),
      })),
      // Null rather than 100% when nothing is measurable — an unearned score
      // is worse than an honest "not enough data".
      onTimeRate: measurable.length > 0 ? Math.round((onTime.length / measurable.length) * 100) : null,
      lateOrders: measurable.length - onTime.length,
      averageLeadTimeDays:
        leadTimes.length > 0
          ? Math.round((leadTimes.reduce((a, b) => a + b, 0) / leadTimes.length) * 10) / 10
          : null,
      lastOrderedAt: orders.reduce<Date | null>(
        (latest, o) => (o.orderedAt && (!latest || o.orderedAt > latest) ? o.orderedAt : latest),
        null
      ),
    };
  },

  /** Roll-up for the suppliers index header. */
  async summary() {
    const organizationId = currentOrgId();
    const [active, inactive, linkedProducts, openOrders] = await Promise.all([
      prismaUnscoped.supplier.count({ where: { organizationId, deletedAt: null, isActive: true } }),
      prismaUnscoped.supplier.count({ where: { organizationId, deletedAt: null, isActive: false } }),
      prismaUnscoped.supplierProduct.groupBy({
        by: ['productId'],
        where: { organizationId },
        _count: { _all: true },
      }),
      prismaUnscoped.purchaseOrder.count({
        where: { organizationId, status: { in: ['DRAFT', 'ORDERED', 'PARTIALLY_RECEIVED'] } },
      }),
    ]);
    return {
      activeSuppliers: active,
      inactiveSuppliers: inactive,
      productsWithSupplier: linkedProducts.length,
      openPurchaseOrders: openOrders,
    };
  },
};
