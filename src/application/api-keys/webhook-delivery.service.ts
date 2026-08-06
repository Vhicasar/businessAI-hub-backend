import { createHmac, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { logger } from '../../shared/logger';
import { metrics } from '../../shared/metrics';

/**
 * Outbound webhook delivery (API Bible §13): signed, timestamped, retried,
 * idempotent, and logged per attempt.
 *
 * Every attempt is persisted before the HTTP call, so a crash mid-flight leaves
 * a record the retry sweep can pick up rather than a silently dropped event.
 *
 * Signature: `HMAC-SHA256(secret, "<timestamp>.<body>")`. Including the
 * timestamp in the signed material is what makes a captured delivery
 * un-replayable — receivers reject anything with a stale timestamp.
 */

const MAX_ATTEMPTS = 6;
const TIMEOUT_MS = 8000;

/** Exponential backoff: 30s, 2m, 8m, 32m, 2h8m. */
function backoffMs(attempt: number): number {
  return Math.min(30_000 * 4 ** (attempt - 1), 2 * 60 * 60 * 1000);
}

export function signPayload(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

async function attemptDelivery(deliveryId: string): Promise<void> {
  const delivery = await prismaUnscoped.webhookDelivery.findUnique({ where: { id: deliveryId } });
  if (!delivery || delivery.status === 'DELIVERED') return;

  const endpoint = await prismaUnscoped.webhookEndpoint.findUnique({ where: { id: delivery.endpointId } });
  if (!endpoint || !endpoint.isActive) {
    await prismaUnscoped.webhookDelivery.update({
      where: { id: delivery.id },
      data: { status: 'FAILED', error: 'Endpoint inactive or removed', nextAttemptAt: null },
    });
    return;
  }

  const attempt = delivery.attempts + 1;
  const timestamp = String(Date.now());
  const body = JSON.stringify({
    id: delivery.deliveryId,
    event: delivery.event,
    data: delivery.payload,
    sentAt: new Date().toISOString(),
  });
  const signature = signPayload(endpoint.secret, timestamp, body);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Vhicasar-Event': delivery.event,
        'X-Vhicasar-Delivery': delivery.deliveryId,
        'X-Vhicasar-Timestamp': timestamp,
        'X-Vhicasar-Signature': `t=${timestamp},v1=${signature}`,
        // Kept for existing integrations built against the original header.
        'X-BizHub-Event': delivery.event,
        'X-BizHub-Signature': createHmac('sha256', endpoint.secret).update(body).digest('hex'),
      },
      body,
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));

    if (res.ok) {
      await prismaUnscoped.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: 'DELIVERED',
          attempts: attempt,
          responseStatus: res.status,
          deliveredAt: new Date(),
          nextAttemptAt: null,
          error: null,
        },
      });
      await prismaUnscoped.webhookEndpoint.update({
        where: { id: endpoint.id },
        data: { lastSuccessAt: new Date(), failureCount: 0 },
      });
      metrics.webhookDeliveries.inc({ event: delivery.event, outcome: 'delivered' });
      return;
    }
    metrics.webhookDeliveries.inc({ event: delivery.event, outcome: 'failed' });
    await recordFailure(delivery.id, attempt, `HTTP ${res.status}`, res.status);
    await prismaUnscoped.webhookEndpoint.update({
      where: { id: endpoint.id },
      data: { lastFailureAt: new Date(), failureCount: { increment: 1 } },
    });
  } catch (err) {
    await recordFailure(delivery.id, attempt, (err as Error)?.message ?? 'Request failed', null);
    await prismaUnscoped.webhookEndpoint
      .update({ where: { id: endpoint.id }, data: { lastFailureAt: new Date(), failureCount: { increment: 1 } } })
      .catch(() => undefined);
  }
}

async function recordFailure(id: string, attempt: number, error: string, status: number | null): Promise<void> {
  const exhausted = attempt >= MAX_ATTEMPTS;
  await prismaUnscoped.webhookDelivery.update({
    where: { id },
    data: {
      attempts: attempt,
      responseStatus: status,
      error: error.slice(0, 300),
      status: exhausted ? 'FAILED' : 'PENDING',
      nextAttemptAt: exhausted ? null : new Date(Date.now() + backoffMs(attempt)),
    },
  });
}

export const webhookDelivery = {
  MAX_ATTEMPTS,
  signPayload,

  /**
   * Queue an event for every active endpoint of an org that subscribes to it,
   * then try delivering immediately. Never throws — a webhook problem must not
   * fail the business action that produced the event.
   */
  async dispatch(organizationId: string, event: string, payload: Record<string, unknown>): Promise<void> {
    try {
      const endpoints = await prismaUnscoped.webhookEndpoint.findMany({
        where: { organizationId, isActive: true },
      });
      const subscribed = endpoints.filter(
        (e) => Array.isArray(e.events) && (e.events as string[]).includes(event)
      );
      if (subscribed.length === 0) return;

      for (const endpoint of subscribed) {
        const delivery = await prismaUnscoped.webhookDelivery.create({
          data: {
            organizationId,
            endpointId: endpoint.id,
            event,
            deliveryId: randomUUID(),
            payload: payload as Prisma.InputJsonValue,
          },
        });
        void attemptDelivery(delivery.id).catch((err) =>
          logger.warn({ err, event }, 'webhook delivery attempt failed')
        );
      }
    } catch (err) {
      logger.warn({ err, event }, 'webhook dispatch failed');
    }
  },

  /** Retry sweep for deliveries whose backoff has elapsed. */
  async retryDue(batch = 25): Promise<number> {
    const due = await prismaUnscoped.webhookDelivery.findMany({
      where: { status: 'PENDING', nextAttemptAt: { lte: new Date() } },
      orderBy: { nextAttemptAt: 'asc' },
      take: batch,
      select: { id: true },
    });
    for (const d of due) await attemptDelivery(d.id);
    return due.length;
  },

  async list(organizationId: string, opts: { event?: string; status?: string; cursor?: string; limit: number }) {
    const rows = await prismaUnscoped.webhookDelivery.findMany({
      where: {
        organizationId,
        ...(opts.event ? { event: opts.event } : {}),
        ...(opts.status ? { status: opts.status as never } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: opts.limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > opts.limit;
    const items = hasMore ? rows.slice(0, opts.limit) : rows;
    return {
      items: items.map((d) => ({
        id: d.id,
        deliveryId: d.deliveryId,
        event: d.event,
        status: d.status,
        attempts: d.attempts,
        responseStatus: d.responseStatus,
        error: d.error,
        createdAt: d.createdAt,
        deliveredAt: d.deliveredAt,
        nextAttemptAt: d.nextAttemptAt,
      })),
      nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
    };
  },

  /** Manual replay from the developer console. */
  async replay(organizationId: string, deliveryId: string): Promise<void> {
    const existing = await prismaUnscoped.webhookDelivery.findFirst({
      where: { id: deliveryId, organizationId },
    });
    if (!existing) return;
    const fresh = await prismaUnscoped.webhookDelivery.create({
      data: {
        organizationId,
        endpointId: existing.endpointId,
        event: existing.event,
        deliveryId: randomUUID(),
        payload: existing.payload as Prisma.InputJsonValue,
      },
    });
    await attemptDelivery(fresh.id);
  },
};

let retryTimer: NodeJS.Timeout | null = null;

export function startWebhookRetrySweep(intervalMs = 60_000): void {
  if (retryTimer) return;
  const tick = async () => {
    try {
      await webhookDelivery.retryDue();
    } catch (err) {
      logger.error({ err }, 'webhook retry sweep failed');
    }
  };
  retryTimer = setInterval(() => void tick(), intervalMs);
  if (typeof retryTimer.unref === 'function') retryTimer.unref();
  logger.info(`🔁 Webhook retry sweep started (${intervalMs}ms interval)`);
}
