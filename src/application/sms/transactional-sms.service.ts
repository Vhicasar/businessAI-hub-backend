import { prisma, prismaUnscoped } from '../../infrastructure/database/prisma';
import { smsSendService } from './sms-send.service';
import { logger } from '../../shared/logger';

/**
 * The SMS a business sends without thinking about it.
 *
 * Order confirmations, appointment reminders, delivery notices — messages a
 * customer expects, tied to something that just happened. Distinct from
 * marketing in three ways that matter: they take the provider's transactional
 * route, they reach numbers that have opted out of promotions, and the
 * business chooses which kinds to send rather than composing each one.
 *
 * Every send here is best-effort. An SMS that cannot go out must never stop an
 * order being placed or an appointment being booked — the business event is
 * the thing that matters, and the notification is a courtesy on top of it.
 */

/** What a business can switch on and off, and the default body for each. */
export const TRANSACTIONAL_EVENTS = [
  {
    id: 'order.confirmed',
    label: 'Order confirmation',
    template: 'Hi {{firstName}}, we have received your order {{orderNumber}}. Thank you for shopping with {{businessName}}.',
  },
  {
    id: 'payment.received',
    label: 'Payment confirmation',
    template: 'Hi {{firstName}}, we have received your payment of {{amount}} for {{orderNumber}}. Thank you.',
  },
  {
    id: 'invoice.sent',
    label: 'Invoice notification',
    template: 'Hi {{firstName}}, invoice {{orderNumber}} for {{amount}} is ready. Thank you — {{businessName}}.',
  },
  {
    id: 'appointment.confirmed',
    label: 'Appointment confirmation',
    template: 'Hi {{firstName}}, your appointment with {{businessName}} is confirmed for {{appointmentDate}}.',
  },
  {
    id: 'appointment.reminder',
    label: 'Appointment reminder',
    template: 'Reminder: your appointment with {{businessName}} is on {{appointmentDate}}. See you then.',
  },
  {
    id: 'delivery.dispatched',
    label: 'Delivery notification',
    template: 'Hi {{firstName}}, your order {{orderNumber}} is on its way.',
  },
  {
    id: 'account.notification',
    label: 'Account notifications',
    template: 'Hi {{firstName}}, there is an update on your account with {{businessName}}.',
  },
] as const;

export type TransactionalEventId = (typeof TRANSACTIONAL_EVENTS)[number]['id'];

interface SettingsShape {
  smsTransactional?: Record<string, { enabled?: boolean; template?: string }>;
}

/**
 * Whether this business wants this kind of message, and what it should say.
 *
 * Off unless switched on. Sending a customer's phone number a message they did
 * not ask for — and charging the business for it — is not a sensible default
 * for a feature that appeared in an update.
 */
async function settingFor(
  organizationId: string,
  eventId: TransactionalEventId,
): Promise<{ enabled: boolean; template: string } | null> {
  const org = await prismaUnscoped.organization.findUnique({
    where: { id: organizationId },
    select: { settings: true },
  });
  const settings = (org?.settings ?? {}) as SettingsShape;
  const configured = settings.smsTransactional?.[eventId];
  if (!configured?.enabled) return null;

  const fallback = TRANSACTIONAL_EVENTS.find((e) => e.id === eventId);
  return { enabled: true, template: configured.template?.trim() || fallback?.template || '' };
}

export const transactionalSmsService = {
  /** What the settings screen renders, merged with whatever is saved. */
  async list(organizationId: string) {
    const org = await prismaUnscoped.organization.findUnique({
      where: { id: organizationId },
      select: { settings: true },
    });
    const saved = ((org?.settings ?? {}) as SettingsShape).smsTransactional ?? {};
    return TRANSACTIONAL_EVENTS.map((event) => ({
      id: event.id,
      label: event.label,
      defaultTemplate: event.template,
      enabled: saved[event.id]?.enabled ?? false,
      template: saved[event.id]?.template ?? event.template,
    }));
  },

  async update(
    organizationId: string,
    eventId: TransactionalEventId,
    input: { enabled?: boolean; template?: string },
  ) {
    const org = await prismaUnscoped.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { settings: true },
    });
    const settings = (org.settings ?? {}) as SettingsShape;
    const current = settings.smsTransactional ?? {};
    await prismaUnscoped.organization.update({
      where: { id: organizationId },
      data: {
        settings: {
          ...settings,
          smsTransactional: {
            ...current,
            [eventId]: { ...current[eventId], ...input },
          },
        } as never,
      },
    });
    return this.list(organizationId);
  },

  /**
   * Send one, if the business has asked for it.
   *
   * Never throws: called from the middle of order and appointment flows, where
   * a failed text must not roll back the thing the customer actually did.
   */
  async notify(input: {
    organizationId: string;
    eventId: TransactionalEventId;
    customerId: string;
    variables?: Record<string, string>;
  }): Promise<{ sent: boolean; reason?: string }> {
    try {
      const setting = await settingFor(input.organizationId, input.eventId);
      if (!setting) return { sent: false, reason: 'Not enabled' };

      const customer = await prismaUnscoped.customer.findFirst({
        where: { id: input.customerId, organizationId: input.organizationId },
        select: { id: true, firstName: true, lastName: true, phone: true },
      });
      if (!customer?.phone) return { sent: false, reason: 'No phone number' };

      const org = await prismaUnscoped.organization.findUnique({
        where: { id: input.organizationId },
        select: { name: true },
      });

      await smsSendService.send({
        organizationId: input.organizationId,
        template: setting.template,
        route: 'TRANSACTIONAL',
        eventType: input.eventId,
        recipients: [{
          phone: customer.phone,
          customerId: customer.id,
          variables: {
            firstName: customer.firstName ?? '',
            lastName: customer.lastName ?? '',
            businessName: org?.name ?? '',
            ...input.variables,
          },
        }],
      });
      return { sent: true };
    } catch (err) {
      // Logged, not thrown. The order was still placed.
      logger.warn(
        { err: (err as Error).message, eventId: input.eventId, organizationId: input.organizationId },
        'Transactional SMS not sent',
      );
      return { sent: false, reason: (err as Error).message };
    }
  },
};
