import { z } from 'zod';
import { prisma, prismaUnscoped } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';

/**
 * How a business wants payments to behave — as distinct from *which* gateway
 * it uses (org-account.service) and *which* methods it offers
 * (payment-methods.service).
 *
 * Stored on `Organization.settings.payments`. Read through `read()`, which
 * fills in defaults, so a business that has never opened the settings page
 * still behaves sensibly and no caller has to cope with undefined.
 */

export const paymentSettingsSchema = z.object({
  /** How long an unpaid intent stays payable. Zero means it never expires. */
  expiryMinutes: z.number().int().min(0).max(60 * 24 * 90).optional(),
  /** Free text shown on every payment page, above the method list. */
  paymentInstructions: z.string().trim().max(2000).optional(),
  /** Account details for customers paying by manual bank transfer. */
  bankTransferInstructions: z.string().trim().max(2000).optional(),
  autoReceipts: z.boolean().optional(),
  /** Channels a payment confirmation goes out on. */
  notifyEmail: z.boolean().optional(),
  notifySms: z.boolean().optional(),
  notifyWhatsapp: z.boolean().optional(),
  notifyInbox: z.boolean().optional(),
  notifyPush: z.boolean().optional(),
  paymentLinksEnabled: z.boolean().optional(),
  virtualAccountsEnabled: z.boolean().optional(),
  /**
   * What happens the moment a provider confirms payment.
   *
   * AUTOMATIC marks the linked record paid and moves it on. MANUAL_REVIEW
   * records the money but leaves the record for a human — for businesses that
   * want eyes on every order before it is released.
   */
  confirmationBehavior: z.enum(['AUTOMATIC', 'MANUAL_REVIEW']).optional(),
  /**
   * Whether the AI assistant may raise a payment request on the business's
   * behalf (§12). Off unless a business turns it on: an assistant that can ask
   * customers for money is a decision a business makes deliberately, not a
   * default it inherits.
   */
  aiCanCreatePaymentRequests: z.boolean().optional(),
});
export type PaymentSettingsDto = z.infer<typeof paymentSettingsSchema>;

export interface PaymentSettings {
  expiryMinutes: number;
  paymentInstructions: string;
  bankTransferInstructions: string;
  autoReceipts: boolean;
  notifyEmail: boolean;
  notifySms: boolean;
  notifyWhatsapp: boolean;
  notifyInbox: boolean;
  notifyPush: boolean;
  paymentLinksEnabled: boolean;
  virtualAccountsEnabled: boolean;
  confirmationBehavior: 'AUTOMATIC' | 'MANUAL_REVIEW';
  aiCanCreatePaymentRequests: boolean;
}

const DEFAULTS: PaymentSettings = {
  // A day is long enough for a bank transfer to land and short enough that a
  // stale quote is not honoured indefinitely.
  expiryMinutes: 1440,
  paymentInstructions: '',
  bankTransferInstructions: '',
  autoReceipts: true,
  notifyEmail: true,
  notifySms: false,
  notifyWhatsapp: false,
  notifyInbox: true,
  notifyPush: true,
  paymentLinksEnabled: true,
  virtualAccountsEnabled: false,
  confirmationBehavior: 'AUTOMATIC',
  aiCanCreatePaymentRequests: false,
};

function merge(stored: unknown): PaymentSettings {
  const s = ((stored as Record<string, unknown>) ?? {}) as Partial<PaymentSettings>;
  return {
    expiryMinutes: typeof s.expiryMinutes === 'number' ? s.expiryMinutes : DEFAULTS.expiryMinutes,
    paymentInstructions: s.paymentInstructions ?? DEFAULTS.paymentInstructions,
    bankTransferInstructions: s.bankTransferInstructions ?? DEFAULTS.bankTransferInstructions,
    autoReceipts: s.autoReceipts ?? DEFAULTS.autoReceipts,
    notifyEmail: s.notifyEmail ?? DEFAULTS.notifyEmail,
    notifySms: s.notifySms ?? DEFAULTS.notifySms,
    notifyWhatsapp: s.notifyWhatsapp ?? DEFAULTS.notifyWhatsapp,
    notifyInbox: s.notifyInbox ?? DEFAULTS.notifyInbox,
    notifyPush: s.notifyPush ?? DEFAULTS.notifyPush,
    paymentLinksEnabled: s.paymentLinksEnabled ?? DEFAULTS.paymentLinksEnabled,
    virtualAccountsEnabled: s.virtualAccountsEnabled ?? DEFAULTS.virtualAccountsEnabled,
    confirmationBehavior: s.confirmationBehavior ?? DEFAULTS.confirmationBehavior,
    aiCanCreatePaymentRequests:
      s.aiCanCreatePaymentRequests ?? DEFAULTS.aiCanCreatePaymentRequests,
  };
}

/**
 * By id, for the public pay page, webhooks and the AI — none of which run with
 * a tenant in request context.
 */
export async function readPaymentSettings(organizationId: string): Promise<PaymentSettings> {
  const org = await prismaUnscoped.organization.findUnique({
    where: { id: organizationId },
    select: { settings: true },
  });
  const settings = (org?.settings as Record<string, unknown>) ?? {};
  return merge(settings.payments);
}

export const paymentSettingsService = {
  async get(): Promise<PaymentSettings> {
    const id = requestContext.get()?.organizationId;
    if (!id) throw new Error('No tenant in request context');
    return readPaymentSettings(id);
  },

  async save(dto: PaymentSettingsDto): Promise<PaymentSettings> {
    const id = requestContext.get()?.organizationId;
    if (!id) throw new Error('No tenant in request context');
    const org = await prisma.organization.findUniqueOrThrow({
      where: { id },
      select: { settings: true },
    });
    const settings = (org.settings as Record<string, unknown>) ?? {};
    // Merge rather than replace: the settings page saves one section at a time.
    const next = merge({ ...((settings.payments as object) ?? {}), ...dto });
    await prisma.organization.update({
      where: { id },
      data: { settings: { ...settings, payments: next } },
    });
    return next;
  },
};

export const PAYMENT_SETTING_DEFAULTS = DEFAULTS;
