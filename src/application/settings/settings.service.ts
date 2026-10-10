import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { CURRENCIES, isSupportedCurrency } from '../../shared/currency';
import { filesService } from '../files/files.service';
import { orderNotifyService } from '../notifications/order-notify.service';

/** Recipients + per-event toggles for order/payment email notifications. */
export const orderNotificationsSchema = z.object({
  emails: z.array(z.string().trim().toLowerCase().email()).max(20).default([]),
  events: z.record(z.boolean()).optional(),
});
export type OrderNotificationsDto = z.infer<typeof orderNotificationsSchema>;

function orgId(): string {
  const id = requestContext.get()?.organizationId;
  if (!id) throw new Error('No tenant in request context');
  return id;
}

const businessSchema = z.object({
  name: z.string().trim().max(160).optional(),
  email: z.string().trim().max(160).optional(),
  phone: z.string().trim().max(60).optional(),
  website: z.string().trim().max(160).optional(),
  addressLines: z.string().trim().max(400).optional(),
  taxId: z.string().trim().max(60).optional(),
  footer: z.string().trim().max(600).optional(),
});

const customTemplateSchema = z.object({
  id: z.string().trim().min(1).max(60),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(200).optional().default(''),
  accent: z.string().trim().regex(/^#?[0-9a-fA-F]{6}$/, 'Use a hex colour like #2563eb'),
  headerStyle: z.enum(['plain', 'band']).default('plain'),
  font: z.enum(['sans', 'serif']).default('sans'),
  defaultNotes: z.string().trim().max(2000).optional(),
  defaultFooter: z.string().trim().max(600).optional(),
  defaultDueInDays: z.coerce.number().int().min(0).max(365).optional(),
});

const receiptTemplateSchema = z.object({
  id: z.string().trim().min(1).max(60),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(200).optional().default(''),
  accent: z.string().trim().regex(/^#?[0-9a-fA-F]{6}$/, 'Use a hex colour like #f97316'),
  layout: z.enum(['classic', 'compact', 'modern', 'elegant', 'bold']).default('classic'),
  font: z.enum(['sans', 'serif', 'mono']).default('sans'),
  footer: z.string().trim().max(600).optional(),
  showCustomer: z.boolean().default(true),
  showSku: z.boolean().default(true),
  paperWidth: z.enum(['80mm', '58mm', 'a4']).default('80mm'),
});

export const invoiceSettingsSchema = z.object({
  defaultTemplateId: z.string().trim().min(1).max(60).default('classic'),
  business: businessSchema.default({}),
  customTemplates: z.array(customTemplateSchema).max(50).default([]),
  defaultReceiptTemplateId: z.string().trim().min(1).max(60).default('receipt-classic'),
  customReceiptTemplates: z.array(receiptTemplateSchema).max(50).default([]),
});

export type InvoiceSettingsDto = z.infer<typeof invoiceSettingsSchema>;
export type InvoiceSettingsResponse = InvoiceSettingsDto & { currency: string };

export const organizationSchema = z.object({
  currency: z
    .string()
    .trim()
    .length(3)
    .toUpperCase()
    .refine(isSupportedCurrency, { message: 'That currency is not supported yet' }),
  country: z.string().trim().length(2).toUpperCase().nullable().optional(),
  timezone: z.string().trim().max(64).optional(),
  locale: z.string().trim().max(35).optional(),
  name: z.string().trim().min(2).max(160).optional(),
  website: z.string().trim().max(320).nullable().optional(),
  email: z.string().trim().email().max(320).nullable().optional(),
  phone: z.string().trim().max(60).nullable().optional(),
  addressLine1: z.string().trim().max(180).nullable().optional(),
  addressLine2: z.string().trim().max(180).nullable().optional(),
  city: z.string().trim().max(100).nullable().optional(),
  state: z.string().trim().max(100).nullable().optional(),
  postalCode: z.string().trim().max(30).nullable().optional(),
  tagline: z.string().trim().max(240).nullable().optional(),
  description: z.string().trim().max(5000).nullable().optional(),
  supportEmail: z.string().trim().email().max(320).nullable().optional(),
  salesEmail: z.string().trim().email().max(320).nullable().optional(),
  alternativePhone: z.string().trim().max(60).nullable().optional(),
  whatsappNumber: z.string().trim().max(60).nullable().optional(),
  openingHours: z.record(z.unknown()).nullable().optional(),
  socialLinks: z.record(z.string().trim().max(500)).nullable().optional(),
});

export const settingsService = {
  /** Invoice branding: default template, business profile, custom templates. */
  async getInvoiceSettings(): Promise<InvoiceSettingsResponse> {
    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: orgId() },
      select: {
        settings: true,
        name: true,
        email: true,
        phone: true,
        website: true,
        addressLine1: true,
        addressLine2: true,
        city: true,
        state: true,
        postalCode: true,
        country: true,
        currency: true,
      },
    });

    const stored = ((org.settings as Record<string, unknown>) ?? {}).invoicing as
      | Partial<InvoiceSettingsDto>
      | undefined;

    // Default the business profile from the org record so invoices are
    // populated out of the box, before the user customises anything.
    const addressLines = [
      org.addressLine1,
      org.addressLine2,
      [org.city, org.state, org.postalCode].filter(Boolean).join(', '),
      org.country,
    ]
      .filter(Boolean)
      .join('\n');

    return {
      currency: org.currency,
      defaultTemplateId: stored?.defaultTemplateId ?? 'classic',
      business: {
        name: stored?.business?.name ?? org.name,
        email: stored?.business?.email ?? org.email ?? undefined,
        phone: stored?.business?.phone ?? org.phone ?? undefined,
        website: stored?.business?.website ?? org.website ?? undefined,
        addressLines: stored?.business?.addressLines ?? (addressLines || undefined),
        taxId: stored?.business?.taxId,
        footer: stored?.business?.footer,
      },
      customTemplates: stored?.customTemplates ?? [],
      defaultReceiptTemplateId: stored?.defaultReceiptTemplateId ?? 'receipt-classic',
      customReceiptTemplates: stored?.customReceiptTemplates ?? [],
    };
  },

  async saveInvoiceSettings(dto: InvoiceSettingsDto): Promise<InvoiceSettingsDto> {
    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: orgId() },
      select: { settings: true },
    });
    const settings = { ...((org.settings as Record<string, unknown>) ?? {}), invoicing: dto };
    await prisma.organization.update({
      where: { id: orgId() },
      data: { settings },
    });
    return dto;
  },

  /** Order/payment notification recipients + per-event toggles. */
  async getOrderNotifications() {
    return orderNotifyService.getConfig(orgId());
  },

  async saveOrderNotifications(dto: OrderNotificationsDto) {
    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: orgId() },
      select: { settings: true },
    });
    const settings = { ...((org.settings as Record<string, unknown>) ?? {}), orderNotifications: dto };
    await prisma.organization.update({ where: { id: orgId() }, data: { settings } });
    return orderNotifyService.getConfig(orgId());
  },

  async getOrganization() {
    const [org, profile] = await Promise.all([prisma.organization.findUniqueOrThrow({
      where: { id: orgId() },
      select: { name: true, currency: true, country: true, timezone: true, locale: true, logoFileId: true, website: true, email: true, phone: true, addressLine1: true, addressLine2: true, city: true, state: true, postalCode: true },
    }), prisma.businessProfile.findUnique({ where: { organizationId: orgId() }, select: { tagline: true, description: true, supportEmail: true, salesEmail: true, alternativePhone: true, whatsappNumber: true, openingHours: true, socialLinks: true } })]);
    return {
      ...org,
      ...profile,
      logoUrl: await filesService.urlFor(org.logoFileId),
      currencies: CURRENCIES.map((c) => ({ code: c.code, name: c.name, symbol: c.symbol })),
    };
  },

  /**
   * Set (or clear) the organisation's logo. Passing null removes it and deletes
   * the old file; a new fileId replaces and cleans up the previous one so
   * orphans don't pile up.
   */
  async setOrganizationLogo(fileId: string | null) {
    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: orgId() },
      select: { logoFileId: true },
    });
    await prisma.organization.update({ where: { id: orgId() }, data: { logoFileId: fileId } });
    if (org.logoFileId && org.logoFileId !== fileId) {
      await filesService.remove(org.logoFileId).catch(() => undefined);
    }
    return { logoUrl: await filesService.urlFor(fileId) };
  },

  /**
   * Change the organisation's currency (and locale details).
   *
   * This relabels, it does not convert: amounts already recorded keep their
   * numbers. That's the honest behaviour — we have no exchange rate and no
   * mandate to restate historical prices — but it means switching currency on
   * a workspace with existing data needs an explicit acknowledgement, which
   * the UI collects.
   */
  async updateOrganization(dto: z.infer<typeof organizationSchema>) {
    const organizationId = orgId();
    const [org] = await prisma.$transaction([
      prisma.organization.update({
      where: { id: organizationId }, data: {
        currency: dto.currency,
        ...(dto.country !== undefined ? { country: dto.country } : {}),
        ...(dto.timezone !== undefined ? { timezone: dto.timezone } : {}),
        ...(dto.locale !== undefined ? { locale: dto.locale } : {}),
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.website !== undefined ? { website: dto.website } : {}),
        ...(dto.email !== undefined ? { email: dto.email } : {}),
        ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
        ...(dto.addressLine1 !== undefined ? { addressLine1: dto.addressLine1 } : {}),
        ...(dto.addressLine2 !== undefined ? { addressLine2: dto.addressLine2 } : {}),
        ...(dto.city !== undefined ? { city: dto.city } : {}),
        ...(dto.state !== undefined ? { state: dto.state } : {}),
        ...(dto.postalCode !== undefined ? { postalCode: dto.postalCode } : {}),
      },
      select: { name: true, currency: true, country: true, timezone: true, locale: true }, }),
      prisma.businessProfile.upsert({ where: { organizationId }, create: { organizationId, ...(dto.tagline !== undefined ? { tagline: dto.tagline } : {}), ...(dto.description !== undefined ? { description: dto.description } : {}), ...(dto.supportEmail !== undefined ? { supportEmail: dto.supportEmail } : {}), ...(dto.salesEmail !== undefined ? { salesEmail: dto.salesEmail } : {}), ...(dto.alternativePhone !== undefined ? { alternativePhone: dto.alternativePhone } : {}), ...(dto.whatsappNumber !== undefined ? { whatsappNumber: dto.whatsappNumber } : {}), ...(dto.openingHours !== undefined ? { openingHours: dto.openingHours === null ? Prisma.JsonNull : dto.openingHours as Prisma.InputJsonValue } : {}), ...(dto.socialLinks !== undefined ? { socialLinks: dto.socialLinks === null ? Prisma.JsonNull : dto.socialLinks as Prisma.InputJsonValue } : {}) }, update: { ...(dto.tagline !== undefined ? { tagline: dto.tagline } : {}), ...(dto.description !== undefined ? { description: dto.description } : {}), ...(dto.supportEmail !== undefined ? { supportEmail: dto.supportEmail } : {}), ...(dto.salesEmail !== undefined ? { salesEmail: dto.salesEmail } : {}), ...(dto.alternativePhone !== undefined ? { alternativePhone: dto.alternativePhone } : {}), ...(dto.whatsappNumber !== undefined ? { whatsappNumber: dto.whatsappNumber } : {}), ...(dto.openingHours !== undefined ? { openingHours: dto.openingHours === null ? Prisma.JsonNull : dto.openingHours as Prisma.InputJsonValue } : {}), ...(dto.socialLinks !== undefined ? { socialLinks: dto.socialLinks === null ? Prisma.JsonNull : dto.socialLinks as Prisma.InputJsonValue } : {}) } }),
    ]);
    return org;
  },
};
