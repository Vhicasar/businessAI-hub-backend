import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { mailer } from '../../infrastructure/mail/mailer';
import { logger } from '../../shared/logger';

/**
 * Order / payment email notifications to the business's own configured
 * addresses (Settings → Order notifications). Independent of the staff in-app
 * notifications — these go to plain email inboxes (owner, accounts, ops…).
 */
export type OrderEvent =
  | 'order.received'
  | 'payment.received'
  | 'payment.confirmed'
  | 'refund.issued'
  | 'invoice.paid';

export const ORDER_EVENTS: OrderEvent[] = [
  'order.received',
  'payment.received',
  'payment.confirmed',
  'refund.issued',
  'invoice.paid',
];

const SUBJECT: Record<OrderEvent, string> = {
  'order.received': 'New order received',
  'payment.received': 'Payment received',
  'payment.confirmed': 'Payment confirmed',
  'refund.issued': 'Refund issued',
  'invoice.paid': 'Invoice paid',
};

interface OrderNotifyConfig {
  emails?: string[];
  events?: Partial<Record<OrderEvent, boolean>>;
}

export interface OrderNotifyPayload {
  title: string;
  lines: string[];
}

export const orderNotifyService = {
  /** Read the org's configured recipients + per-event toggles. */
  async getConfig(orgId: string): Promise<Required<OrderNotifyConfig>> {
    const org = await prismaUnscoped.organization.findUnique({
      where: { id: orgId },
      select: { settings: true },
    });
    const cfg = (((org?.settings as Record<string, unknown> | null) ?? {}).orderNotifications ??
      {}) as OrderNotifyConfig;
    const events = Object.fromEntries(
      ORDER_EVENTS.map((e) => [e, cfg.events?.[e] !== false]),
    ) as Record<OrderEvent, boolean>;
    return { emails: (cfg.emails ?? []).filter(Boolean), events };
  },

  /** Fire-and-forget: email every configured recipient for this event. */
  async notify(orgId: string, event: OrderEvent, payload: OrderNotifyPayload): Promise<void> {
    try {
      const org = await prismaUnscoped.organization.findUnique({
        where: { id: orgId },
        select: { settings: true, name: true },
      });
      const cfg = (((org?.settings as Record<string, unknown> | null) ?? {}).orderNotifications ??
        {}) as OrderNotifyConfig;
      const emails = (cfg.emails ?? []).filter(Boolean);
      if (emails.length === 0) return;
      if (cfg.events?.[event] === false) return; // event disabled by the business

      const subject = `${SUBJECT[event]} — ${org?.name ?? 'BusinessHub AI'}`;
      const bodyHtml =
        `<p style="font-weight:600">${payload.title}</p>` +
        payload.lines.map((l) => `<p style="margin:3px 0">${l}</p>`).join('');
      const text = `${payload.title}\n${payload.lines.join('\n')}`;

      const results = await Promise.all(
        emails.map((to) => mailer.sendNotice(to, subject, SUBJECT[event], bodyHtml, text, { organizationId: orgId })),
      );
      const failed = results.filter((r) => !r.delivered).length;
      logger.info({ orgId, event, recipients: emails.length, failed }, 'Order notification sent');
    } catch (err) {
      logger.warn({ err: (err as Error).message, orgId, event }, 'Order notification failed');
    }
  },
};
