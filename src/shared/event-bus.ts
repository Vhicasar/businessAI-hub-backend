import type { DomainEvent } from '@prisma/client';
import { logger } from './logger';

/**
 * In-process Event Bus (System Bible II §9). Modules subscribe to domain-event
 * names; the dispatcher (application/events/event-dispatcher.ts) drains the
 * DomainEvent outbox and invokes the matching handlers. Keeping this in-process
 * for the monolith — the outbox is the seam to swap in a real broker later
 * without changing subscribers.
 */
export type DomainEventHandler = (event: DomainEvent) => Promise<void> | void;

const byName = new Map<string, DomainEventHandler[]>();
const anyHandlers: DomainEventHandler[] = [];

export const eventBus = {
  /** Subscribe to a specific event name (e.g. "PaymentCompleted"). */
  on(name: string, handler: DomainEventHandler): void {
    const list = byName.get(name) ?? [];
    list.push(handler);
    byName.set(name, list);
  },

  /** Subscribe to every event (analytics, audit mirrors, tracing). */
  onAny(handler: DomainEventHandler): void {
    anyHandlers.push(handler);
  },

  handlersFor(name: string): DomainEventHandler[] {
    return [...(byName.get(name) ?? []), ...anyHandlers];
  },

  /** Run all handlers for an event. Handler failures are isolated + rethrown as a group. */
  async deliver(event: DomainEvent): Promise<void> {
    const handlers = this.handlersFor(event.name);
    if (handlers.length === 0) return;
    const errors: unknown[] = [];
    for (const h of handlers) {
      try {
        await h(event);
      } catch (err) {
        errors.push(err);
        logger.error({ err, event: event.name, id: event.id }, 'event handler failed');
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, `${errors.length} handler(s) failed`);
  },
};
