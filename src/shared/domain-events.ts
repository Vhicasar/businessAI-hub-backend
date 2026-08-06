import type { Prisma } from '@prisma/client';
import { prisma } from '../infrastructure/database/prisma';
import { requestContext } from './context';
import { logger } from './logger';

/**
 * Platform Event Bus — transactional outbox (System Architecture Bible II §9 / III).
 *
 * Business modules append a domain event in the SAME work as their state change;
 * a dispatcher (Phase 6) publishes PENDING rows to subscribers and marks them
 * PUBLISHED. This gives event-driven decoupling without a broker inside the
 * monolith, and is the clean extraction point when services split out.
 *
 * Emitting is best-effort: a failure to record an event must never break the
 * business action that produced it.
 */
export interface DomainEventInput {
  /** PascalCase event name, e.g. "CustomerLinked", "PaymentCompleted". */
  name: string;
  aggregateType: string;
  aggregateId: string;
  payload?: Record<string, unknown>;
  /** Defaults to the current request's org. Pass null for platform-global events. */
  organizationId?: string | null;
}

export async function emitEvent(
  input: DomainEventInput,
  tx?: Prisma.TransactionClient
): Promise<void> {
  const ctx = requestContext.get();
  const data = {
    name: input.name,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    payload: (input.payload ?? {}) as Prisma.InputJsonValue,
    organizationId:
      input.organizationId !== undefined ? input.organizationId : ctx?.organizationId ?? null,
    correlationId: ctx?.correlationId ?? ctx?.requestId ?? null,
  };
  try {
    // Two branches (not a unioned client) to avoid the extended-client vs
    // transaction-client type blowing up the compiler.
    if (tx) await tx.domainEvent.create({ data });
    else await prisma.domainEvent.create({ data });
  } catch (err) {
    logger.error({ err, event: input.name }, 'emitEvent failed');
  }
}
