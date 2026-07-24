import { z } from 'zod';
import { ConflictError, NotFoundError } from '../../shared/errors';
import { prisma } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { activityService } from '../crm/activity.service';
import { crmService } from '../crm/crm.service';
import { filesService } from '../files/files.service';
import { exchangeRates } from '../../shared/exchange-rates';

function orgId(): string {
  const id = requestContext.get()?.organizationId;
  if (!id) throw new Error('No tenant in request context');
  return id;
}
function actorMembershipId(): string | null {
  return requestContext.get()?.membershipId ?? null;
}

const PROPERTY_TYPES = ['APARTMENT', 'HOUSE', 'LAND', 'COMMERCIAL', 'OFFICE', 'WAREHOUSE', 'RETAIL_SPACE', 'OTHER'] as const;
const PURPOSES = ['SALE', 'RENT', 'LEASE'] as const;
const STATUSES = ['AVAILABLE', 'RESERVED', 'SOLD', 'RENTED', 'OFF_MARKET', 'UNDER_MAINTENANCE'] as const;
const BOOKING_STATUSES = ['REQUESTED', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'] as const;

export const listPropertiesSchema = z.object({
  status: z.enum(STATUSES).optional(),
  type: z.enum(PROPERTY_TYPES).optional(),
  purpose: z.enum(PURPOSES).optional(),
  search: z.string().trim().max(120).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export const createPropertySchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).nullable().optional(),
  type: z.enum(PROPERTY_TYPES),
  purpose: z.enum(PURPOSES),
  status: z.enum(STATUSES).default('AVAILABLE'),
  ownerId: z.string().nullable().optional(),
  price: z.coerce.number().nonnegative().nullable().optional(),
  rentAmount: z.coerce.number().nonnegative().nullable().optional(),
  rentPeriod: z.enum(['MONTHLY', 'QUARTERLY', 'YEARLY']).nullable().optional(),
  bedrooms: z.coerce.number().int().min(0).max(100).nullable().optional(),
  bathrooms: z.coerce.number().int().min(0).max(100).nullable().optional(),
  areaSqm: z.coerce.number().nonnegative().nullable().optional(),
  addressLine1: z.string().trim().max(200).nullable().optional(),
  city: z.string().trim().max(100).nullable().optional(),
  state: z.string().trim().max(100).nullable().optional(),
  amenities: z.array(z.string().trim().max(60)).max(40).nullable().optional(),
});
export const updatePropertySchema = createPropertySchema.partial();

export const bookingSchema = z.object({
  propertyId: z.string().min(1),
  customerId: z.string().min(1),
  kind: z.enum(['VIEWING', 'INSPECTION']).default('VIEWING'),
  scheduledAt: z.coerce.date(),
  durationMin: z.coerce.number().int().min(5).max(600).default(30),
  notes: z.string().trim().max(1000).nullable().optional(),
});
export const updateBookingSchema = z.object({
  status: z.enum(BOOKING_STATUSES).optional(),
  scheduledAt: z.coerce.date().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});
export const listBookingsSchema = z.object({
  propertyId: z.string().optional(),
  status: z.enum(BOOKING_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const inquirySchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().max(80).nullable().optional(),
  email: z.string().trim().toLowerCase().email().nullable().optional(),
  phone: z.string().trim().max(32).nullable().optional(),
  message: z.string().trim().max(2000).nullable().optional(),
});

const MEDIA_KINDS = ['IMAGE', 'VIDEO', 'DOCUMENT', 'FLOOR_PLAN'] as const;
export const propertyMediaSchema = z.object({
  fileId: z.string().min(1),
  kind: z.enum(MEDIA_KINDS).default('IMAGE'),
  /** Title/caption shown under the media in the gallery. */
  caption: z.string().trim().max(200).nullable().optional(),
});
export const updateMediaSchema = z.object({
  caption: z.string().trim().max(200).nullable().optional(),
});
export const reorderMediaSchema = z.object({
  order: z.array(z.string().min(1)).min(1),
});

const mediaSelect = {
  orderBy: { position: 'asc' as const },
  select: { id: true, fileId: true, kind: true, caption: true, position: true },
} as const;

const propertySelect = {
  id: true, reference: true, title: true, type: true, purpose: true, status: true,
  price: true, rentAmount: true, rentPeriod: true, currency: true,
  bedrooms: true, bathrooms: true, areaSqm: true,
  addressLine1: true, city: true, state: true, ownerId: true, agentId: true,
  amenities: true, description: true, createdAt: true,
  media: mediaSelect,
} as const;

type MediaRow = { id: string; fileId: string; kind: string; caption: string | null; position: number };

/**
 * Resolve every media File id to a browser URL across a page of properties in a
 * single batch — minting signed R2 URLs one-by-one per photo would be costly on
 * a gallery-heavy listing.
 */
async function withMedia<T extends { media: MediaRow[] }>(properties: T[]): Promise<(T & { media: (MediaRow & { url: string | null })[] })[]> {
  const ids = new Set<string>();
  for (const p of properties) for (const m of p.media) ids.add(m.fileId);
  const urls = await filesService.urlMap([...ids]);
  return properties.map((p) => ({
    ...p,
    media: p.media.map((m) => ({ ...m, url: urls.get(m.fileId) ?? null })),
  }));
}

async function propertiesForDisplay<T extends {
  currency: string;
  price: unknown | null;
  rentAmount: unknown | null;
}>(properties: T[]): Promise<T[]> {
  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: orgId() },
    select: { currency: true },
  });
  return Promise.all(properties.map(async (property) => {
    const conversion = await exchangeRates.convert(1, property.currency, org.currency);
    const money = (value: unknown | null) => value === null
      ? null
      : Math.round(Number(value) * conversion.rate * 100) / 100;
    return {
      ...property,
      price: money(property.price),
      rentAmount: money(property.rentAmount),
      sourceCurrency: property.currency,
      currency: org.currency,
    };
  })) as Promise<T[]>;
}

async function nextReference(): Promise<string> {
  const year = new Date().getFullYear();
  const count = await prisma.property.count({ where: { reference: { startsWith: `PROP-${year}-` } } });
  return `PROP-${year}-${String(count + 1).padStart(4, '0')}`;
}

export const realestateService = {
  // ----------------------------------------------------------- properties
  async listProperties(dto: z.infer<typeof listPropertiesSchema>) {
    const rows = await prisma.property.findMany({
      where: {
        deletedAt: null,
        ...(dto.status ? { status: dto.status } : {}),
        ...(dto.type ? { type: dto.type } : {}),
        ...(dto.purpose ? { purpose: dto.purpose } : {}),
        ...(dto.search
          ? {
              OR: [
                { title: { contains: dto.search, mode: 'insensitive' as const } },
                { reference: { contains: dto.search, mode: 'insensitive' as const } },
                { city: { contains: dto.search, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      select: propertySelect,
      orderBy: { createdAt: 'desc' },
      take: dto.limit + 1,
      ...(dto.cursor ? { cursor: { id: dto.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > dto.limit;
    const items = await withMedia(await propertiesForDisplay(hasMore ? rows.slice(0, dto.limit) : rows));
    return { items, nextCursor: hasMore ? items[items.length - 1]?.id ?? null : null };
  },

  async getProperty(id: string) {
    const property = await prisma.property.findFirst({
      where: { id, deletedAt: null },
      select: {
        ...propertySelect,
        videoTourUrl: true,
        owner: { select: { id: true, firstName: true, lastName: true } },
        bookings: {
          orderBy: { scheduledAt: 'desc' },
          take: 20,
          select: {
            id: true, kind: true, status: true, scheduledAt: true, durationMin: true, notes: true,
            customer: { select: { id: true, firstName: true, lastName: true } },
          },
        },
      },
    });
    if (!property) throw new NotFoundError('Property');
    const [resolved] = await withMedia(await propertiesForDisplay([property]));
    return resolved!;
  },

  async createProperty(dto: z.infer<typeof createPropertySchema>) {
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId() }, select: { currency: true } });
    const property = await prisma.property.create({
      data: {
        organizationId: orgId(),
        reference: await nextReference(),
        title: dto.title,
        description: dto.description ?? null,
        type: dto.type,
        purpose: dto.purpose,
        status: dto.status,
        ownerId: dto.ownerId ?? null,
        agentId: actorMembershipId(),
        currency: org.currency,
        price: dto.price ?? null,
        rentAmount: dto.rentAmount ?? null,
        rentPeriod: dto.rentPeriod ?? null,
        bedrooms: dto.bedrooms ?? null,
        bathrooms: dto.bathrooms ?? null,
        areaSqm: dto.areaSqm ?? null,
        addressLine1: dto.addressLine1 ?? null,
        city: dto.city ?? null,
        state: dto.state ?? null,
        amenities: dto.amenities ?? undefined,
      },
      select: propertySelect,
    });
    await activityService.record({
      type: 'SYSTEM', entityType: 'PROPERTY', entityId: property.id,
      title: `Property listed — ${property.title}`,
      body: `${property.reference} · ${property.purpose.toLowerCase()}`,
    });
    const [resolved] = await withMedia([property]);
    return resolved!;
  },

  async updateProperty(id: string, dto: z.infer<typeof updatePropertySchema>) {
    const existing = await prisma.property.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new NotFoundError('Property');
    const property = await prisma.property.update({
      where: { id },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.type !== undefined ? { type: dto.type } : {}),
        ...(dto.purpose !== undefined ? { purpose: dto.purpose } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(dto.ownerId !== undefined ? { ownerId: dto.ownerId } : {}),
        ...(dto.price !== undefined ? { price: dto.price } : {}),
        ...(dto.rentAmount !== undefined ? { rentAmount: dto.rentAmount } : {}),
        ...(dto.rentPeriod !== undefined ? { rentPeriod: dto.rentPeriod } : {}),
        ...(dto.bedrooms !== undefined ? { bedrooms: dto.bedrooms } : {}),
        ...(dto.bathrooms !== undefined ? { bathrooms: dto.bathrooms } : {}),
        ...(dto.areaSqm !== undefined ? { areaSqm: dto.areaSqm } : {}),
        ...(dto.addressLine1 !== undefined ? { addressLine1: dto.addressLine1 } : {}),
        ...(dto.city !== undefined ? { city: dto.city } : {}),
        ...(dto.state !== undefined ? { state: dto.state } : {}),
        ...(dto.amenities !== undefined ? { amenities: dto.amenities ?? undefined } : {}),
      },
      select: propertySelect,
    });
    if (dto.status && dto.status !== existing.status) {
      await activityService.record({
        type: 'STATUS_CHANGE', entityType: 'PROPERTY', entityId: id,
        title: `Property → ${dto.status.toLowerCase().replace(/_/g, ' ')}`,
      });
    }
    const [resolved] = await withMedia([property]);
    return resolved!;
  },

  async deleteProperty(id: string) {
    const existing = await prisma.property.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new NotFoundError('Property');
    await prisma.property.update({ where: { id }, data: { deletedAt: new Date(), status: 'OFF_MARKET' } });
    return { deleted: true };
  },

  // --------------------------------------------------------------- media
  async assertProperty(propertyId: string): Promise<void> {
    const exists = await prisma.property.findFirst({ where: { id: propertyId, deletedAt: null }, select: { id: true } });
    if (!exists) throw new NotFoundError('Property');
  },

  /** Attach an already-uploaded file (photo, video, floor plan, document) to a listing. */
  async addMedia(propertyId: string, dto: z.infer<typeof propertyMediaSchema>) {
    await this.assertProperty(propertyId);
    const count = await prisma.propertyMedia.count({ where: { propertyId } });
    const media = await prisma.propertyMedia.create({
      data: { propertyId, fileId: dto.fileId, kind: dto.kind, caption: dto.caption ?? null, position: count },
      select: { id: true, fileId: true, kind: true, caption: true, position: true },
    });
    return { ...media, url: await filesService.urlFor(media.fileId) };
  },

  async updateMedia(propertyId: string, mediaId: string, dto: z.infer<typeof updateMediaSchema>) {
    const media = await prisma.propertyMedia.findFirst({ where: { id: mediaId, propertyId } });
    if (!media) throw new NotFoundError('Media');
    const updated = await prisma.propertyMedia.update({
      where: { id: mediaId },
      data: { ...(dto.caption !== undefined ? { caption: dto.caption } : {}) },
      select: { id: true, fileId: true, kind: true, caption: true, position: true },
    });
    return { ...updated, url: await filesService.urlFor(updated.fileId) };
  },

  async removeMedia(propertyId: string, mediaId: string) {
    const media = await prisma.propertyMedia.findFirst({ where: { id: mediaId, propertyId } });
    if (!media) throw new NotFoundError('Media');
    await prisma.propertyMedia.delete({ where: { id: mediaId } });
    await filesService.remove(media.fileId).catch(() => undefined);
    return { deleted: true };
  },

  async reorderMedia(propertyId: string, order: string[]) {
    const rows = await prisma.propertyMedia.findMany({ where: { propertyId }, select: { id: true } });
    const own = new Set(rows.map((r) => r.id));
    await prisma.$transaction(
      order.filter((id) => own.has(id)).map((id, position) => prisma.propertyMedia.update({ where: { id }, data: { position } }))
    );
    return this.getProperty(propertyId);
  },

  // ------------------------------------------------------------- bookings
  async listBookings(dto: z.infer<typeof listBookingsSchema>) {
    return prisma.propertyBooking.findMany({
      where: {
        ...(dto.propertyId ? { propertyId: dto.propertyId } : {}),
        ...(dto.status ? { status: dto.status } : {}),
      },
      orderBy: { scheduledAt: 'desc' },
      take: dto.limit,
      select: {
        id: true, kind: true, status: true, scheduledAt: true, durationMin: true, notes: true,
        property: { select: { id: true, reference: true, title: true } },
        customer: { select: { id: true, firstName: true, lastName: true } },
      },
    });
  },

  async createBooking(dto: z.infer<typeof bookingSchema>) {
    const [property, customer] = await Promise.all([
      prisma.property.findFirst({ where: { id: dto.propertyId, deletedAt: null } }),
      prisma.customer.findFirst({ where: { id: dto.customerId, deletedAt: null } }),
    ]);
    if (!property) throw new NotFoundError('Property');
    if (!customer) throw new NotFoundError('Customer');

    const booking = await prisma.propertyBooking.create({
      data: {
        organizationId: orgId(),
        propertyId: dto.propertyId,
        customerId: dto.customerId,
        agentId: actorMembershipId(),
        kind: dto.kind,
        scheduledAt: dto.scheduledAt,
        durationMin: dto.durationMin,
        notes: dto.notes ?? null,
      },
    });
    await activityService.record({
      type: 'MEETING', entityType: 'PROPERTY', entityId: dto.propertyId,
      title: `${dto.kind === 'INSPECTION' ? 'Inspection' : 'Viewing'} scheduled — ${customer.firstName} ${customer.lastName ?? ''}`.trim(),
      body: dto.scheduledAt.toLocaleString(),
      also: [{ entityType: 'CUSTOMER', entityId: dto.customerId }],
    });
    return booking;
  },

  async updateBooking(id: string, dto: z.infer<typeof updateBookingSchema>) {
    const booking = await prisma.propertyBooking.findFirst({ where: { id } });
    if (!booking) throw new NotFoundError('Booking');
    const updated = await prisma.propertyBooking.update({
      where: { id },
      data: {
        ...(dto.status ? { status: dto.status } : {}),
        ...(dto.scheduledAt ? { scheduledAt: dto.scheduledAt } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
      },
    });
    if (dto.status) {
      await activityService.record({
        type: 'STATUS_CHANGE', entityType: 'PROPERTY', entityId: booking.propertyId,
        title: `Booking → ${dto.status.toLowerCase().replace(/_/g, ' ')}`,
        also: [{ entityType: 'CUSTOMER', entityId: booking.customerId }],
      });
    }
    return updated;
  },

  // ------------------------------------------------------ property inquiry
  /** A property inquiry becomes a CRM lead (deduped) tagged with the property. */
  async inquire(propertyId: string, dto: z.infer<typeof inquirySchema>) {
    const property = await prisma.property.findFirst({ where: { id: propertyId, deletedAt: null } });
    if (!property) throw new NotFoundError('Property');
    if (!dto.email && !dto.phone) throw new ConflictError('Provide an email or phone for the inquiry');

    const lead = await crmService.createLead(
      {
        firstName: dto.firstName,
        lastName: dto.lastName ?? null,
        email: dto.email ?? null,
        phone: dto.phone ?? null,
        source: 'PROPERTY_INQUIRY',
        estimatedValue: property.price ? Number(property.price) : null,
      },
      { forceAutoAssign: true },
    );
    await crmService.createNote({
      entityType: 'LEAD',
      entityId: lead.id,
      body: `Interested in ${property.reference} — ${property.title}.${dto.message ? `\n“${dto.message}”` : ''}`,
    });
    await activityService.record({
      type: 'SYSTEM', entityType: 'PROPERTY', entityId: propertyId,
      title: `Inquiry — ${dto.firstName} ${dto.lastName ?? ''}`.trim(),
      body: dto.message ?? undefined,
    });
    return { lead, property: { id: property.id, reference: property.reference, title: property.title } };
  },
};
