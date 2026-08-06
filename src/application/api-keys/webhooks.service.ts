import { createHmac, randomBytes } from 'node:crypto';
import { prisma, prismaUnscoped } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { logger } from '../../shared/logger';
import { NotFoundError, ValidationError } from '../../shared/errors';

const currentOrgId = (): string => {
  const id = requestContext.get()?.organizationId;
  if (!id) throw new ValidationError('No tenant in context');
  return id;
};

/**
 * Events a webhook endpoint can subscribe to (API Bible §13). The `vhicasar_*`
 * and payment events are bridged from the domain-event outbox; the rest are
 * dispatched inline by their modules.
 */
export const WEBHOOK_EVENTS = [
  'order.created',
  'customer.created',
  'message.received',
  'payment.completed',
  'payment.refunded',
  'payment.blocked',
  'wallet.credited',
  'wallet.debited',
  'payout.paid',
  'payout.failed',
  'settlement.created',
  'customer.linked',
  'booking.confirmed',
  'loyalty.awarded',
  'subscription.changed',
  'property.listed',
  'fraud.alert_created',
  'shift.closed',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const webhooksService = {
  async list() {
    return prisma.webhookEndpoint.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, url: true, events: true, isActive: true,
        lastSuccessAt: true, lastFailureAt: true, failureCount: true, createdAt: true,
      },
    });
  },

  /** Create an endpoint; returns the signing secret once (also kept for delivery). */
  async create(dto: { url: string; events: string[] }) {
    const secret = `whsec_${randomBytes(24).toString('hex')}`;
    const wh = await prisma.webhookEndpoint.create({
      data: { organizationId: currentOrgId(), url: dto.url, events: dto.events, secret },
      select: { id: true, url: true, events: true, isActive: true, createdAt: true },
    });
    return { ...wh, secret };
  },

  async update(id: string, dto: { url?: string; events?: string[]; isActive?: boolean }) {
    const wh = await prisma.webhookEndpoint.findFirst({ where: { id } });
    if (!wh) throw new NotFoundError('Webhook');
    return prisma.webhookEndpoint.update({
      where: { id },
      data: {
        ...(dto.url !== undefined ? { url: dto.url } : {}),
        ...(dto.events !== undefined ? { events: dto.events } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
      select: { id: true, url: true, events: true, isActive: true },
    });
  },

  async remove(id: string) {
    await prisma.webhookEndpoint.deleteMany({ where: { id } });
    return { deleted: true };
  },

  /**
   * Deliver an event to every active endpoint of an org that subscribes to it.
   * Signs the body with HMAC-SHA256 (X-BizHub-Signature). Fire-and-forget; runs
   * from system paths (order creation, etc.), so it takes an explicit orgId and
   * never throws to the caller.
   */
  async dispatch(organizationId: string, event: WebhookEvent, payload: Record<string, unknown>) {
    try {
      const endpoints = await prismaUnscoped.webhookEndpoint.findMany({
        where: { organizationId, isActive: true },
      });
      const body = JSON.stringify({ event, data: payload, sentAt: new Date().toISOString() });
      await Promise.all(
        endpoints
          .filter((e) => Array.isArray(e.events) && (e.events as string[]).includes(event))
          .map(async (e) => {
            const signature = createHmac('sha256', e.secret).update(body).digest('hex');
            try {
              const controller = new AbortController();
              const timer = setTimeout(() => controller.abort(), 8000);
              const res = await fetch(e.url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-BizHub-Event': event, 'X-BizHub-Signature': signature },
                body,
                signal: controller.signal,
              }).finally(() => clearTimeout(timer));
              await prismaUnscoped.webhookEndpoint.update({
                where: { id: e.id },
                data: res.ok
                  ? { lastSuccessAt: new Date(), failureCount: 0 }
                  : { lastFailureAt: new Date(), failureCount: { increment: 1 } },
              });
            } catch (err) {
              logger.warn({ err, url: e.url }, 'Webhook delivery failed');
              await prismaUnscoped.webhookEndpoint
                .update({ where: { id: e.id }, data: { lastFailureAt: new Date(), failureCount: { increment: 1 } } })
                .catch(() => undefined);
            }
          })
      );
    } catch (err) {
      logger.warn({ err, event }, 'Webhook dispatch failed');
    }
  },
};
