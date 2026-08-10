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
import { startAiConfigSync } from './application/ai/ai-sync';
import { startPaymentConfigSync } from './application/billing/payment-config-sync';
import { startEmailRetrySweep } from './application/auth/email-retry.service';
import { startWorkspaceConfigSync } from './application/settings/workspace-config-sync';
import { startAppointmentReminderSweep } from './application/appointments/appointments.service';
import { startEventDispatcher } from './application/events/event-dispatcher';
import { registerCoreSubscribers } from './application/events/subscribers';
import {
  startNoncePurge,
  startPaymentReconciliation,
  startPayoutReconciliation,
  startRewardExpiry,
  startSettlementRuns,
} from './application/payments/payout-sweeps';
import { startWebhookRetrySweep } from './application/api-keys/webhook-delivery.service';
import { startPromotionNotifier } from './application/marketing/promotion-engine.service';
import { startReorderWatcher } from './application/purchasing/reorder.service';
import { reconcileSystemRolePermissions } from './application/roles/reconcile-permissions';
import { closeQueues, queueEnabled } from './infrastructure/queue/queue';
import { createApp } from './app';

async function bootstrap(): Promise<void> {
  await connectDatabase();
  await reconcileSystemRolePermissions(); // grant newly-added permissions to existing system roles
  await startAiConfigSync(); // establish the admin-managed provider before serving AI traffic
  await startPaymentConfigSync(); // resolve the active payment gateway before serving checkouts
  await startWorkspaceConfigSync(); // pull admin-managed feature flags / comms / storage config

  const app = createApp();
  const httpServer = createServer(app);
  initSocketServer(httpServer);

  httpServer.listen(env.PORT, () => {
    logger.info(`🚀 Vhicasar Hub AI API listening on port ${env.PORT} (${env.NODE_ENV})`);
    logger.info(`📚 API docs: ${env.API_BASE_URL}/api/docs`);
    logger.info(
      {
        smtpConfigured: Boolean(env.SMTP_HOST),
        serviceApiEnabled: env.service.enabled,
      },
      'Production integration configuration',
    );
  });

  startEmailInboundPoller();
  startPlanSync(); // keep the plan catalog in sync with Vhicasar Admin
  startEmailRetrySweep(); // durably re-send verification emails that failed delivery
  startAppointmentReminderSweep(); // email appointment reminders as they come due
  registerCoreSubscribers(); // wire domain-event handlers
  startEventDispatcher(); // drain the DomainEvent outbox to the event bus
  startPayoutReconciliation(); // resolve in-flight bank payouts if a webhook is missed
  startPaymentReconciliation(); // recover collections whose webhook never arrived
  startNoncePurge(); // drop spent device-signature challenges
  startWebhookRetrySweep(); // retry outbound webhook deliveries with backoff
  startRewardExpiry(); // expire reward points past their window
  startSettlementRuns(); // release settlements as their schedule comes due (§10)
  startPromotionNotifier(); // push scheduled promotion notifications
  startReorderWatcher(); // raise purchase orders when stock hits its reorder point
  logger.info(
    queueEnabled()
      ? '📮 Queue mode: async — workflow & campaign jobs handed to the worker (run `npm run worker`)'
      : '📮 Queue mode: inline — set REDIS_URL and run a worker to process jobs asynchronously',
  );

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`${signal} received — shutting down gracefully`);
    stopEmailInboundPoller();
    httpServer.close(async () => {
      await closeQueues();
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
