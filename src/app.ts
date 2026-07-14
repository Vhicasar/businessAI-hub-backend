import path from 'path';
import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import { env } from './shared/config/env';
import { logger } from './shared/logger';
import { requestContextMiddleware } from './presentation/http/middleware/request-context';
import { apiLimiter } from './presentation/http/middleware/rate-limit';
import { errorHandler, notFoundHandler } from './presentation/http/middleware/error-handler';
import { authRoutes } from './presentation/http/v1/auth.routes';
import { healthRoutes } from './presentation/http/v1/health.routes';
import { invitationsRoutes, usersRoutes } from './presentation/http/v1/users.routes';
import { rolesRoutes } from './presentation/http/v1/roles.routes';
import { customersRoutes } from './presentation/http/v1/customers.routes';
import { catalogRoutes } from './presentation/http/v1/catalog.routes';
import { inventoryRoutes } from './presentation/http/v1/inventory.routes';
import { ordersRoutes } from './presentation/http/v1/orders.routes';
import { invoicesRoutes } from './presentation/http/v1/invoices.routes';
import { crmRoutes } from './presentation/http/v1/crm.routes';
import { inboxRoutes } from './presentation/http/v1/inbox.routes';
import { webhookRoutes } from './presentation/http/webhooks.routes';
import { webchatRoutes } from './presentation/http/webchat.routes';
import { aiRoutes } from './presentation/http/v1/ai.routes';
import { analyticsRoutes } from './presentation/http/v1/analytics.routes';
import { billingRoutes } from './presentation/http/v1/billing.routes';
import { paystackWebhookRoutes } from './presentation/http/paystack-webhook.routes';
import { openApiDocument } from './presentation/http/swagger';

export function createApp(): Express {
  const app = express();

  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet());
  // Allowlist CORS for the authenticated app API only — public embed surfaces
  // (/api/webchat, /widget.js) get their own permissive policy below.
  const appCors = cors({
    origin: env.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  });
  app.use(
    express.json({
      limit: '2mb',
      // Raw body needed for Meta webhook signature verification (HMAC over bytes).
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody?: Buffer }).rawBody = buf;
      },
    })
  );
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());
  app.use(requestContextMiddleware);
  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req) => req.url?.startsWith('/api/v1/health') ?? false },
    })
  );

  // API docs
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openApiDocument as object));

  // v1 routes
  const v1 = express.Router();
  v1.use('/health', healthRoutes);
  v1.use('/auth', authRoutes);
  v1.use('/users', usersRoutes);
  v1.use('/invitations', invitationsRoutes);
  v1.use('/roles', rolesRoutes);
  v1.use('/customers', customersRoutes);
  v1.use('/catalog', catalogRoutes);
  v1.use('/inventory', inventoryRoutes);
  v1.use('/orders', ordersRoutes);
  v1.use('/invoices', invoicesRoutes);
  v1.use('/crm', crmRoutes);
  v1.use('/inbox', inboxRoutes);
  v1.use('/ai', aiRoutes);
  v1.use('/analytics', analyticsRoutes);
  v1.use('/billing', billingRoutes);
  app.use('/api/v1', appCors, apiLimiter, v1);

  // Public payment webhook (Paystack, HMAC-verified) — mounted before the
  // channel webhook receiver so its specific path wins.
  app.use('/api/webhooks/paystack', paystackWebhookRoutes);

  // Public provider webhooks (adapter-verified, not JWT-authenticated).
  app.use('/api/webhooks', webhookRoutes);

  // Public website live-chat visitor API + embeddable widget.
  // These are embedded on arbitrary customer websites, so unlike the rest of
  // the API they must allow any origin (auth = unguessable visitor ids).
  app.use('/api/webchat', cors({ origin: true, credentials: false }), webchatRoutes);
  app.get('/widget.js', (_req, res) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.type('application/javascript');
    // cwd = backend/ in both dev (tsx) and prod (npm start) — survives the dist build.
    res.sendFile(path.join(process.cwd(), 'public', 'widget.js'));
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
