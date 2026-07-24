import { Queue, type JobsOptions } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import { env } from '../../shared/config/env';
import { logger } from '../../shared/logger';

/**
 * BullMQ queue infrastructure. When REDIS_URL is unset the app runs
 * single-process: `enqueue()` returns false and callers execute inline.
 * With Redis configured, jobs are handed to the worker process (worker.ts).
 */

export const QUEUE_NAMES = {
  workflow: 'workflow',
  campaign: 'campaign',
} as const;
export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

let connection: Redis | null = null;
const queues = new Map<QueueName, Queue>();

export function queueEnabled(): boolean {
  return Boolean(env.REDIS_URL);
}

/** Shared ioredis connection (BullMQ requires maxRetriesPerRequest: null). */
export function getRedis(): Redis | null {
  if (!env.REDIS_URL) return null;
  if (!connection) {
    connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    connection.on('error', (err) => logger.error({ err }, 'Redis connection error'));
  }
  return connection;
}

export function getQueue(name: QueueName): Queue | null {
  const conn = getRedis();
  if (!conn) return null;
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, {
      connection: conn,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 24 * 3600 },
      },
    });
    queues.set(name, q);
  }
  return q;
}

/**
 * Enqueue a job. Returns true if it was queued, false when Redis is disabled
 * (the caller should then run the work inline).
 */
export async function enqueue(
  name: QueueName,
  jobName: string,
  data: unknown,
  opts?: JobsOptions,
): Promise<boolean> {
  const q = getQueue(name);
  if (!q) return false;
  try {
    await q.add(jobName, data, opts);
    return true;
  } catch (err) {
    logger.error({ err, queue: name, jobName }, 'enqueue failed — falling back to inline');
    return false;
  }
}

export async function closeQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((q) => q.close()));
  await connection?.quit();
}
