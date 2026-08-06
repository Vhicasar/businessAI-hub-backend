import type { Response } from 'express';

import { logger } from '../../shared/logger';
import { emitToOrg } from './socket';

/**
 * Live updates for clients that cannot hold a socket.
 *
 * The business web app already has socket.io. The Customer Super App does not
 * carry a socket client, so it subscribes over Server-Sent Events on the HTTP
 * connection it already has — one long-lived GET, no new dependency, and it
 * reconnects on its own after a network drop.
 *
 * Both paths carry the same event names, so a feature is wired once.
 */

interface Subscriber {
  vhicasarId: string;
  res: Response;
}

const subscribers = new Set<Subscriber>();

/** How often to nudge the connection so proxies don't reap it as idle. */
const HEARTBEAT_MS = 25_000;

let heartbeat: NodeJS.Timeout | null = null;

function startHeartbeat() {
  if (heartbeat) return;
  heartbeat = setInterval(() => {
    for (const sub of subscribers) {
      try {
        // A comment line is a valid SSE no-op.
        sub.res.write(': ping\n\n');
      } catch {
        subscribers.delete(sub);
      }
    }
  }, HEARTBEAT_MS);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();
}

/** Attach one customer's SSE stream. Returns a detach function. */
export function subscribeIdentity(vhicasarId: string, res: Response): () => void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // Nginx buffers by default, which would hold every event until the buffer
  // fills — exactly the delay this exists to remove.
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const sub: Subscriber = { vhicasarId, res };
  subscribers.add(sub);
  startHeartbeat();

  // Tell the client how long to wait before reconnecting, and confirm we are live.
  res.write('retry: 5000\n');
  res.write(`event: connected\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);

  return () => {
    subscribers.delete(sub);
  };
}

/** Push an event to one customer, on every stream they have open. */
export function emitToIdentity(vhicasarId: string, event: string, payload: unknown): void {
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload ?? {})}\n\n`;
  for (const sub of subscribers) {
    if (sub.vhicasarId !== vhicasarId) continue;
    try {
      sub.res.write(frame);
    } catch (err) {
      logger.debug({ err, vhicasarId }, 'Dropping a dead SSE subscriber');
      subscribers.delete(sub);
    }
  }
}

/**
 * Announce something that happened, to whoever it concerns.
 *
 * One call reaches the business (socket) and the customer (SSE), so a feature
 * never has to remember to notify both — the commonest way a "real-time"
 * feature ends up real-time on only one surface.
 */
export function broadcast(params: {
  event: string;
  payload: Record<string, unknown>;
  organizationId?: string | null;
  vhicasarId?: string | null;
}): void {
  const body = { ...params.payload, at: new Date().toISOString() };
  if (params.organizationId) emitToOrg(params.organizationId, params.event, body);
  if (params.vhicasarId) emitToIdentity(params.vhicasarId, params.event, body);
}

/** Live subscriber count, for the health endpoint. */
export function liveSubscriberCount(): number {
  return subscribers.size;
}
