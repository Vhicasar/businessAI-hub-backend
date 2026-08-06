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
import { httpMetrics } from './presentation/http/middleware/observability';
import { normalizeResponse } from './presentation/http/middleware/response-normalizer';
import { metrics } from './shared/metrics';
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
import { settingsRoutes } from './presentation/http/v1/settings.routes';
import { searchRoutes } from './presentation/http/v1/search.routes';
import { realestateRoutes } from './presentation/http/v1/realestate.routes';
import { marketingRoutes } from './presentation/http/v1/marketing.routes';
import { auditRoutes } from './presentation/http/v1/audit.routes';
import { dataTransferRoutes } from './presentation/http/v1/data-transfer.routes';
import { supportRoutes } from './presentation/http/v1/support.routes';
import { employeesRoutes } from './presentation/http/v1/employees.routes';
import { crmRoutes } from './presentation/http/v1/crm.routes';
import { inboxRoutes } from './presentation/http/v1/inbox.routes';
import { webhookRoutes } from './presentation/http/webhooks.routes';
import { webchatRoutes } from './presentation/http/webchat.routes';
import { payRoutes } from './presentation/http/pay.routes';
import { appointmentsPublicRoutes } from './presentation/http/appointments.routes';
import { appointmentsRoutes } from './presentation/http/v1/appointments.routes';
import { paymentLinksRoutes } from './presentation/http/v1/payment-links.routes';
import { aiRoutes } from './presentation/http/v1/ai.routes';
import { knowledgeRoutes } from './presentation/http/v1/knowledge.routes';
import { notificationsRoutes } from './presentation/http/v1/notifications.routes';
import { developerRoutes } from './presentation/http/v1/developer.routes';
import { publicApiRoutes } from './presentation/http/public/public-api.routes';
import { sitesRoutes } from './presentation/http/v1/sites.routes';
import { designsRoutes } from './presentation/http/v1/designs.routes';
import { customDomainHost, siteHostRoutes } from './presentation/http/site-host.routes';
import { analyticsRoutes } from './presentation/http/v1/analytics.routes';
import { billingRoutes } from './presentation/http/v1/billing.routes';
import { serviceRoutes } from './presentation/http/v1/service.routes';
import { filesRoutes } from './presentation/http/v1/files.routes';
import { integrationsRoutes } from './presentation/http/v1/integrations.routes';
import { brandingRoutes } from './presentation/http/v1/branding.routes';
import { identityRoutes } from './presentation/http/v1/identity.routes';
import { vhicasarPayRoutes } from './presentation/http/v1/vhicasar-pay.routes';
import { fraudRoutes } from './presentation/http/v1/fraud.routes';
import { posRoutes } from './presentation/http/v1/pos.routes';
import { appIdentityRoutes, clientErrorRoutes } from './presentation/http/app/identity.routes';
import { appPayRoutes, appPayPublicRoutes } from './presentation/http/app/pay.routes';
import { appSuperAppRoutes } from './presentation/http/app/superapp.routes';
import { appBusinessRoutes } from './presentation/http/app/businesses.routes';
import { appActivityRoutes } from './presentation/http/app/activity.routes';
import { appSecurityRoutes } from './presentation/http/app/security.routes';
import { appLocalizationRoutes } from './presentation/http/app/localization.routes';
import { businessProfileRoutes } from './presentation/http/v1/business-profile.routes';
import { qrCenterRoutes } from './presentation/http/v1/qr-center.routes';
import { settlementRoutes } from './presentation/http/v1/settlement.routes';
import { loyaltyRoutes } from './presentation/http/v1/loyalty.routes';
import { promotionsRoutes } from './presentation/http/v1/promotions.routes';
import { storage } from './infrastructure/storage/storage';
import { paystackWebhookRoutes, flutterwaveWebhookRoutes, stripeWebhookRoutes } from './presentation/http/paystack-webhook.routes';
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
  app.use(httpMetrics);
  // Never let a null collection reach a client (§11) — an empty list renders,
  // a null crashes.
  app.use(normalizeResponse);

  /**
   * Prometheus scrape endpoint (Part I §14). Outside /api/v1 because scrapers
   * are infrastructure, not API clients. When METRICS_TOKEN is set the endpoint
   * requires it — operational metrics shouldn't be world-readable in production.
   */
  app.get('/metrics', (req, res) => {
    const token = process.env.METRICS_TOKEN;
    if (token) {
      const provided = req.header('authorization')?.replace(/^Bearer /i, '') ?? req.query.token;
      if (provided !== token) {
        res.status(401).type('text/plain').send('metrics token required');
        return;
      }
    }
    res.type('text/plain; version=0.0.4').send(metrics.render());
  });
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
  v1.use('/branding', brandingRoutes);
  v1.use('/auth', authRoutes);
  v1.use('/users', usersRoutes);
  v1.use('/invitations', invitationsRoutes);
  v1.use('/roles', rolesRoutes);
  v1.use('/customers', customersRoutes);
  v1.use('/catalog', catalogRoutes);
  v1.use('/inventory', inventoryRoutes);
  v1.use('/orders', ordersRoutes);
  v1.use('/invoices', invoicesRoutes);
  v1.use('/settings', settingsRoutes);
  v1.use('/realestate', realestateRoutes);
  v1.use('/appointments', appointmentsRoutes);
  v1.use('/marketing', marketingRoutes);
  v1.use('/audit', auditRoutes);
  v1.use('/data', dataTransferRoutes);
  v1.use('/support', supportRoutes);
  v1.use('/employees', employeesRoutes);
  v1.use('/crm', crmRoutes);
  v1.use('/inbox', inboxRoutes);
  v1.use('/ai', aiRoutes);
  v1.use('/knowledge', knowledgeRoutes);
  v1.use('/notifications', notificationsRoutes);
  v1.use('/sites', sitesRoutes);
  v1.use('/designs', designsRoutes);
  v1.use('/analytics', analyticsRoutes);
  v1.use('/search', searchRoutes);
  v1.use('/billing', billingRoutes);
  v1.use('/payment-links', paymentLinksRoutes);
  v1.use('/files', filesRoutes);
  v1.use('/developer', developerRoutes);
  v1.use('/integrations', integrationsRoutes);
  v1.use('/identity', identityRoutes);
  v1.use('/pay', vhicasarPayRoutes);
  v1.use('/fraud', fraudRoutes);
  v1.use('/pos', posRoutes);
  v1.use('/business-profile', businessProfileRoutes);
  v1.use('/qr-center', qrCenterRoutes);
  v1.use('/settlement', settlementRoutes);
  v1.use('/loyalty', loyaltyRoutes);
  v1.use('/promotions', promotionsRoutes);

  // Service API for the Vhicasar Admin. Mounted only when a key is configured:
  // an endpoint that lists every customer organisation should not exist at all
  // on a deployment that hasn't deliberately turned it on.
  if (env.service.enabled) {
    v1.use('/service', serviceRoutes);
    logger.info('🔑 Service API enabled at /api/v1/service (admin roster access)');
  }

  app.use('/api/v1', appCors, apiLimiter, v1);

  // Public REST API for a business's own integrations — API-key authenticated,
  // permissive CORS, scope-gated and per-key rate-limited (see the router).
  app.use('/api/public/v1', cors({ origin: true, credentials: false }), publicApiRoutes);

  // Customer Super App API (Vhicasar ID identity, wallet, QR pay…). Consumer
  // `app`-scoped tokens, separate from the business /api/v1 surface. Phase 1
  // ships the Identity Service; further modules mount here as they land.
  // Public (no app token) gateway redirect target — mounted before the
  // token-guarded app routers so it stays reachable from the browser.
  app.use('/api/app/v1', cors({ origin: true, credentials: false }), appPayPublicRoutes);
  // Crash reports arrive before/without auth, so they mount ahead of the
  // authenticated app routers.
  app.use('/api/app/v1', cors({ origin: true, credentials: false }), apiLimiter, clientErrorRoutes);
  app.use('/api/app/v1', appCors, apiLimiter, appIdentityRoutes);
  app.use('/api/app/v1', appCors, apiLimiter, appPayRoutes);
  app.use('/api/app/v1', appCors, apiLimiter, appSuperAppRoutes);
  app.use('/api/app/v1', appCors, apiLimiter, appBusinessRoutes);
  app.use('/api/app/v1', appCors, apiLimiter, appActivityRoutes);
  app.use('/api/app/v1', appCors, apiLimiter, appSecurityRoutes);
  app.use('/api/app/v1', appCors, apiLimiter, appLocalizationRoutes);

  // Public payment-link pages (/pay/<token>) — token-authenticated, any origin.
  app.use('/api/pay', cors({ origin: true, credentials: false }), payRoutes);

  // Serve locally-stored uploads. Only meaningful with the local driver (R2
  // serves its own objects); harmless otherwise since keys won't resolve.
  if (storage.driver === 'local') {
    const MIME: Record<string, string> = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
      webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf',
    };
    app.get('/uploads/*', (req, res) => {
      const key = decodeURIComponent(req.path.replace(/^\/uploads\//, ''));
      const stream = storage.localStream(key);
      if (!stream) {
        res.status(404).end();
        return;
      }
      const ext = key.split('.').pop()?.toLowerCase() ?? '';
      if (MIME[ext]) res.setHeader('Content-Type', MIME[ext]);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      stream.on('error', () => res.status(404).end());
      stream.pipe(res);
    });
  }

  // Public payment webhooks (signature-verified) — mounted before the channel
  // webhook receiver so their specific paths win.
  app.use('/api/webhooks/paystack', paystackWebhookRoutes);
  app.use('/api/webhooks/flutterwave', flutterwaveWebhookRoutes);
  app.use('/api/webhooks/stripe', stripeWebhookRoutes);

  // Public provider webhooks (adapter-verified, not JWT-authenticated).
  app.use('/api/webhooks', webhookRoutes);

  // Public website live-chat visitor API + embeddable widget.
  // These are embedded on arbitrary customer websites, so unlike the rest of
  // the API they must allow any origin (auth = unguessable visitor ids).
  app.use('/api/webchat', cors({ origin: true, credentials: false }), webchatRoutes);
  app.use('/api/appointments', cors({ origin: true, credentials: false }), appointmentsPublicRoutes);

  // Public website hosting: renders a published site's pages by subdomain.
  app.use('/site', cors({ origin: true, credentials: false }), siteHostRoutes);
  app.get('/widget.js', (_req, res) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.type('application/javascript');
    // cwd = backend/ in both dev (tsx) and prod (npm start) — survives the dist build.
    res.sendFile(path.join(process.cwd(), 'public', 'widget.js'));
  });
  app.use(customDomainHost);
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
