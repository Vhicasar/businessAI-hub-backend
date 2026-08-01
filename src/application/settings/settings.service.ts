import { z } from 'zod';
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
    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: orgId() },
      select: { name: true, currency: true, country: true, timezone: true, locale: true, logoFileId: true },
    });
    return {
      ...org,
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
    const org = await prisma.organization.update({
      where: { id: orgId() },
      data: {
        currency: dto.currency,
        ...(dto.country !== undefined ? { country: dto.country } : {}),
        ...(dto.timezone !== undefined ? { timezone: dto.timezone } : {}),
        ...(dto.locale !== undefined ? { locale: dto.locale } : {}),
      },
      select: { name: true, currency: true, country: true, timezone: true, locale: true },
    });
    return org;
  },
};
