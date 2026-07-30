import { Worker, type Job } from 'bullmq';
import { env } from './shared/config/env';
import { logger } from './shared/logger';
import { requestContext } from './shared/context';
import { connectDatabase, disconnectDatabase } from './infrastructure/database/prisma';
import { getRedis, QUEUE_NAMES } from './infrastructure/queue/queue';
import { workflowService, type Payload, type Target, type Trigger } from './application/crm/workflow.service';
import { campaignService } from './application/messaging/campaign.service';

/**
 * Async job worker. Runs as a separate process from the API. Each job carries
 * the tenant context (organizationId/userId), which we re-establish via
 * requestContext.run so the tenant-scoped Prisma extension works exactly as it
 * does inside an HTTP request.
 */

interface JobCtx {
  organizationId?: string;
  userId?: string;
}

function runInTenant<T>(prefix: string, jobId: string | undefined, ctx: JobCtx, fn: () => Promise<T>): Promise<T> {
  return requestContext.run(
    { requestId: `${prefix}-${jobId ?? 'job'}`, organizationId: ctx.organizationId, userId: ctx.userId },
    fn,
  );
}

async function bootstrap(): Promise<void> {
  const connection = getRedis();
  if (!connection) {
    logger.error('REDIS_URL is not set — the worker has nothing to connect to. Exiting.');
    process.exit(1);
  }
  await connectDatabase();

  const workflowWorker = new Worker(
    QUEUE_NAMES.workflow,
    async (job: Job) => {
      const { trigger, payload, target, ctx } = job.data as {
        trigger: Trigger; payload: Payload; target: Target; ctx: JobCtx;
      };
      await runInTenant('wf', job.id, ctx ?? {}, () => workflowService.dispatchNow(trigger, payload, target));
    },
    { connection, concurrency: 10 },
  );

  const campaignWorker = new Worker(
    QUEUE_NAMES.campaign,
    async (job: Job) => {
      const { campaignId, ctx } = job.data as { campaignId: string; ctx: JobCtx };
      await runInTenant('cmp', job.id, ctx ?? {}, () => campaignService.sendNow(campaignId));
    },
    { connection, concurrency: 3 }, // lower — each job fans out to many sends
  );

  for (const [name, w] of [['workflow', workflowWorker], ['campaign', campaignWorker]] as const) {
    w.on('completed', (job) => logger.debug({ queue: name, jobId: job.id }, 'job completed'));
    w.on('failed', (job, err) => logger.error({ queue: name, jobId: job?.id, err }, 'job failed'));
  }

  logger.info('🛠️  Vhicasar Hub AI worker started (queues: workflow, campaign)');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`${signal} received — draining worker`);
    await Promise.all([workflowWorker.close(), campaignWorker.close()]);
    await disconnectDatabase();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => logger.error({ reason }, 'worker unhandled rejection'));
}

bootstrap().catch((err) => {
  logger.error({ err }, 'Worker failed to start');
  process.exit(1);
});
