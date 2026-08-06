import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { eventBus } from '../../shared/event-bus';
import { logger } from '../../shared/logger';
import { metrics } from '../../shared/metrics';

/**
 * Outbox dispatcher (System Bible II §9 / III). Drains PENDING DomainEvent rows
 * — written transactionally by the modules — and delivers them to the in-process
 * Event Bus. Marks PUBLISHED on success; retries with backoff via `attempts`,
 * and parks as FAILED after MAX_ATTEMPTS for manual inspection.
 *
 * Single-instance safe. For multi-instance deployments, claim rows with
 * `SELECT … FOR UPDATE SKIP LOCKED` before delivery (noted for extraction).
 */
const MAX_ATTEMPTS = 5;

export async function drainOutboxOnce(batchSize = 50): Promise<number> {
  const pending = await prismaUnscoped.domainEvent.findMany({
    where: { status: 'PENDING', attempts: { lt: MAX_ATTEMPTS } },
    orderBy: { occurredAt: 'asc' },
    take: batchSize,
  });

  let delivered = 0;
  for (const event of pending) {
    try {
      await eventBus.deliver(event);
      await prismaUnscoped.domainEvent.update({
        where: { id: event.id },
        data: { status: 'PUBLISHED', publishedAt: new Date(), attempts: { increment: 1 } },
      });
      delivered += 1;
      metrics.domainEvents.inc({ event: event.name });
    } catch (err) {
      const attempts = event.attempts + 1;
      await prismaUnscoped.domainEvent.update({
        where: { id: event.id },
        data: {
          attempts,
          lastError: String((err as Error)?.message ?? err).slice(0, 500),
          ...(attempts >= MAX_ATTEMPTS ? { status: 'FAILED' } : {}),
        },
      });
    }
  }
  // Surface backlog depth so a stuck dispatcher is visible before it hurts.
  const pendingCount = await prismaUnscoped.domainEvent.count({ where: { status: 'PENDING' } });
  metrics.outboxPending.set(pendingCount);
  return delivered;
}

let timer: NodeJS.Timeout | null = null;

/** Poll the outbox on an interval. Started once at boot. */
export function startEventDispatcher(intervalMs = 3000): void {
  if (timer) return;
  const tick = async () => {
    try {
      const n = await drainOutboxOnce();
      if (n > 0) logger.debug({ delivered: n }, 'event outbox drained');
    } catch (err) {
      logger.error({ err }, 'event dispatcher tick failed');
    }
  };
  timer = setInterval(() => void tick(), intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  logger.info(`📤 Event dispatcher started (${intervalMs}ms interval)`);
}

export function stopEventDispatcher(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
