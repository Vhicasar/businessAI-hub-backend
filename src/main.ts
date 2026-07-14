import { createServer } from 'http';
import { env } from './shared/config/env';
import { logger } from './shared/logger';
import { connectDatabase, disconnectDatabase } from './infrastructure/database/prisma';
import { initSocketServer } from './infrastructure/realtime/socket';
import {
  startEmailInboundPoller,
  stopEmailInboundPoller,
} from './infrastructure/channels/email.poller';
import { startPlanSync } from './application/billing/plan-sync';
import { createApp } from './app';

async function bootstrap(): Promise<void> {
  await connectDatabase();

  const app = createApp();
  const httpServer = createServer(app);
  initSocketServer(httpServer);

  httpServer.listen(env.PORT, () => {
    logger.info(`🚀 BusinessHub AI API listening on port ${env.PORT} (${env.NODE_ENV})`);
    logger.info(`📚 API docs: ${env.API_BASE_URL}/api/docs`);
  });

  startEmailInboundPoller();
  startPlanSync(); // keep the plan catalog in sync with Vhicasar Admin

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`${signal} received — shutting down gracefully`);
    stopEmailInboundPoller();
    httpServer.close(async () => {
      await disconnectDatabase();
      process.exit(0);
    });
    // Force exit if connections refuse to drain.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Unhandled promise rejection');
  });
}

bootstrap().catch((err) => {
  logger.fatal({ err }, 'Failed to start server');
  process.exit(1);
});
