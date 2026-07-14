import { ConflictError, NotFoundError } from '../../shared/errors';
import { prisma } from '../../infrastructure/database/prisma';
import type {
  AddressDto,
  CreateCustomerDto,
  ListCustomersDto,
  UpdateCustomerDto,
} from './customers.dto';

const listSelect = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  lifetimeValue: true,
  totalOrders: true,
  lastOrderAt: true,
  isBlocked: true,
  createdAt: true,
} as const;

const detailSelect = {
  ...listSelect,
  displayName: true,
  language: true,
  timezone: true,
  marketingOptIn: true,
  aiSummary: true,
  aiSummaryAt: true,
  lastContactAt: true,
  customFields: true,
  updatedAt: true,
  addresses: {
    orderBy: { isDefault: 'desc' as const },
    select: {
      id: true,
      label: true,
      addressLine1: true,
      addressLine2: true,
      city: true,
      state: true,
      country: true,
      postalCode: true,
      isDefault: true,
    },
  },
  company: { select: { id: true, name: true } },
} as const;

async function ensureUniqueContact(
  email: string | null | undefined,
  phone: string | null | undefined,
  excludeId?: string
): Promise<void> {
  if (!email && !phone) return;
  const clash = await prisma.customer.findFirst({
    where: {
      deletedAt: null,
      ...(excludeId ? { id: { not: excludeId } } : {}),
      OR: [
        ...(email ? [{ email }] : []),
        ...(phone ? [{ phone }] : []),
      ],
    },
    select: { id: true, email: true, phone: true },
  });
  if (clash) {
    throw new ConflictError('A customer with this email or phone already exists', {
      existingCustomerId: clash.id,
    });
  }
}

export const customersService = {
  async list(dto: ListCustomersDto) {
    const where = {
      deletedAt: null,
      ...(dto.search
        ? {
            OR: [
              { firstName: { contains: dto.search, mode: 'insensitive' as const } },
              { lastName: { contains: dto.search, mode: 'insensitive' as const } },
              { email: { contains: dto.search, mode: 'insensitive' as const } },
              { phone: { contains: dto.search } },
            ],
          }
        : {}),
    };

    const rows = await prisma.customer.findMany({
      where,
      select: listSelect,
      orderBy: { createdAt: 'desc' },
      take: dto.limit + 1,
      ...(dto.cursor ? { cursor: { id: dto.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > dto.limit;
    const items = hasMore ? rows.slice(0, dto.limit) : rows;
    return {
      items,
      nextCursor: hasMore ? items[items.length - 1]?.id ?? null : null,
    };
  },

  async get(id: string) {
    const customer = await prisma.customer.findFirst({
      where: { id, deletedAt: null },
      select: detailSelect,
    });
    if (!customer) throw new NotFoundError('Customer');
    return customer;
  },

  async create(dto: CreateCustomerDto) {
    await ensureUniqueContact(dto.email, dto.phone);
    return prisma.customer.create({
      data: {
        firstName: dto.firstName,
        lastName: dto.lastName ?? null,
        email: dto.email ?? null,
        phone: dto.phone ?? null,
        language: dto.language ?? null,
        marketingOptIn: dto.marketingOptIn ?? true,
        customFields: dto.customFields ?? undefined,
      },
      select: detailSelect,
    });
  },

  async update(id: string, dto: UpdateCustomerDto) {
    await this.get(id); // 404 + tenant check
    await ensureUniqueContact(dto.email, dto.phone, id);
    return prisma.customer.update({
      where: { id },
      data: {
        ...(dto.firstName !== undefined ? { firstName: dto.firstName } : {}),
        ...(dto.lastName !== undefined ? { lastName: dto.lastName } : {}),
        ...(dto.email !== undefined ? { email: dto.email } : {}),
        ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
        ...(dto.language !== undefined ? { language: dto.language } : {}),
        ...(dto.marketingOptIn !== undefined ? { marketingOptIn: dto.marketingOptIn } : {}),
        ...(dto.isBlocked !== undefined ? { isBlocked: dto.isBlocked } : {}),
        ...(dto.customFields !== undefined ? { customFields: dto.customFields } : {}),
      },
      select: detailSelect,
    });
  },

  async remove(id: string) {
    await this.get(id);
    await prisma.customer.update({ where: { id }, data: { deletedAt: new Date() } });
  },

  async addAddress(customerId: string, dto: AddressDto) {
    await this.get(customerId);
    if (dto.isDefault) {
      await prisma.customerAddress.updateMany({
        where: { customerId },
        data: { isDefault: false },
      });
    }
    return prisma.customerAddress.create({
      data: { customerId, ...dto, label: dto.label ?? null },
    });
  },

  async updateAddress(customerId: string, addressId: string, dto: AddressDto) {
    await this.get(customerId);
    const existing = await prisma.customerAddress.findFirst({
      where: { id: addressId, customerId },
    });
    if (!existing) throw new NotFoundError('Address');
    if (dto.isDefault) {
      await prisma.customerAddress.updateMany({
        where: { customerId, id: { not: addressId } },
        data: { isDefault: false },
      });
    }
    return prisma.customerAddress.update({
      where: { id: addressId },
      data: { ...dto, label: dto.label ?? null },
    });
  },

  async removeAddress(customerId: string, addressId: string) {
    await this.get(customerId);
    const existing = await prisma.customerAddress.findFirst({
      where: { id: addressId, customerId },
    });
    if (!existing) throw new NotFoundError('Address');
    await prisma.customerAddress.delete({ where: { id: addressId } });
  },
};
