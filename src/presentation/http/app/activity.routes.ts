import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticateApp } from '../middleware/authenticate-app';
import { activityCenter } from '../../../application/superapp/activity-center.service';
import { customerSearch } from '../../../application/superapp/customer-search.service';
import { concierge } from '../../../application/superapp/concierge.service';
import { prismaUnscoped } from '../../../infrastructure/database/prisma';
import { subscribeIdentity } from '../../../infrastructure/realtime/live-events';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

const CATEGORIES = ['ORDER', 'PAYMENT', 'PROMOTION', 'BOOKING', 'REWARD', 'SUPPORT', 'DOCUMENT', 'SYSTEM'] as const;
const DOC_KINDS = [
  'INVOICE', 'RECEIPT', 'QUOTATION', 'CONTRACT', 'PROPERTY_AGREEMENT',
  'BOOKING_CONFIRMATION', 'WARRANTY', 'MEMBERSHIP_CERTIFICATE', 'INSPECTION_REPORT', 'OTHER',
] as const;

/**
 * Customer Activity Center (§15) — the Super App's operating dashboard.
 * Mounted at /api/app/v1. Everything is scoped to the caller's own links.
 */
export const appActivityRoutes = Router();
appActivityRoutes.use(authenticateApp);

const currencyQuery = z.object({ currency: z.string().trim().length(3).toUpperCase().default('NGN') });

/** The landing dashboard: money, loyalty and what needs attention. */
appActivityRoutes.get(
  '/activity/dashboard',
  validate({ query: currencyQuery }),
  wrap(async (req, res) => {
    const { currency } = req.query as unknown as { currency: string };
    res.json({ success: true, data: await activityCenter.dashboard(req.appAuth!.vhicasarId, currency) });
  })
);

/** One chronological stream across every business, optionally filtered to one. */
appActivityRoutes.get(
  '/activity/timeline',
  validate({
    query: z.object({
      organizationId: z.string().trim().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(40),
      before: z.coerce.date().optional(),
    }),
  }),
  wrap(async (req, res) => {
    const q = req.query as unknown as { organizationId?: string; limit: number; before?: Date };
    res.json({ success: true, data: await activityCenter.timeline(req.appAuth!.vhicasarId, q) });
  })
);

/** Things needing action soon, ordered by urgency. */
appActivityRoutes.get(
  '/activity/upcoming',
  validate({ query: currencyQuery }),
  wrap(async (req, res) => {
    const { currency } = req.query as unknown as { currency: string };
    res.json({ success: true, data: await activityCenter.upcomingActions(req.appAuth!.vhicasarId, currency) });
  })
);

/** Proactive, privacy-aware insights. */
appActivityRoutes.get(
  '/activity/insights',
  validate({ query: currencyQuery }),
  wrap(async (req, res) => {
    const { currency } = req.query as unknown as { currency: string };
    res.json({ success: true, data: await activityCenter.insights(req.appAuth!.vhicasarId, currency) });
  })
);

/** Universal search across the customer's whole ecosystem. */
appActivityRoutes.get(
  '/activity/search',
  validate({
    query: z.object({
      q: z.string().trim().min(2).max(120),
      perCategory: z.coerce.number().int().min(1).max(20).default(5),
    }),
  }),
  wrap(async (req, res) => {
    const q = req.query as unknown as { q: string; perCategory: number };
    res.json({ success: true, data: await customerSearch.search(req.appAuth!.vhicasarId, q.q, q.perCategory) });
  })
);

// ---- Notifications, grouped by business and category ----

appActivityRoutes.get(
  '/notifications',
  validate({
    query: z.object({
      category: z.enum(CATEGORIES).optional(),
      organizationId: z.string().trim().optional(),
      unreadOnly: z.coerce.boolean().default(false),
      limit: z.coerce.number().int().min(1).max(100).default(30),
      cursor: z.string().optional(),
    }),
  }),
  wrap(async (req, res) => {
    const q = req.query as unknown as Parameters<typeof customerSearch.notifications>[1];
    res.json({ success: true, data: await customerSearch.notifications(req.appAuth!.vhicasarId, q) });
  })
);

appActivityRoutes.get(
  '/notifications/summary',
  wrap(async (req, res) => {
    res.json({ success: true, data: await customerSearch.notificationSummary(req.appAuth!.vhicasarId) });
  })
);

appActivityRoutes.post(
  '/notifications/read',
  validate({ body: z.object({ ids: z.array(z.string()).optional() }).optional() }),
  wrap(async (req, res) => {
    const data = await customerSearch.markRead(req.appAuth!.vhicasarId, req.body?.ids);
    res.json({ success: true, data });
  })
);

// ---- Document vault ----

appActivityRoutes.get(
  '/documents',
  validate({
    query: z.object({
      kind: z.enum(DOC_KINDS).optional(),
      organizationId: z.string().trim().optional(),
      q: z.string().trim().max(120).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(30),
      cursor: z.string().optional(),
    }),
  }),
  wrap(async (req, res) => {
    const q = req.query as unknown as Parameters<typeof customerSearch.documents>[1];
    res.json({ success: true, data: await customerSearch.documents(req.appAuth!.vhicasarId, q) });
  })
);

/** A signed URL for one document the customer owns. */
appActivityRoutes.get(
  '/documents/:id/download',
  wrap(async (req, res) => {
    const { document, file } = await customerSearch.documentFile(
      req.appAuth!.vhicasarId,
      req.params.id as string
    );
    if (!file) {
      res.json({ success: true, data: { document: { id: document.id, title: document.title }, url: null } });
      return;
    }
    const { storage } = await import('../../../infrastructure/storage/storage');
    // Documents are private to the customer, so never a public URL.
    const url = await storage.url(file.key, storage.driver === 'r2' ? 'S3' : 'LOCAL', false);
    res.json({
      success: true,
      data: {
        document: { id: document.id, title: document.title, kind: document.kind },
        file: { name: file.fileName, mimeType: file.mimeType, sizeBytes: file.sizeBytes },
        url,
      },
    });
  })
);

// ---- Personalisation ----

appActivityRoutes.get(
  '/preferences',
  wrap(async (req, res) => {
    const vhicasarId = req.appAuth!.vhicasarId;
    const prefs = await prismaUnscoped.customerPreference.findUnique({ where: { vhicasarId } });
    res.json({
      success: true,
      // Sensible defaults so the app renders before anything is customised.
      data: prefs ?? {
        vhicasarId,
        dashboardWidgets: ['wallet', 'upcoming', 'insights', 'businesses', 'timeline'],
        pinnedWidgets: [],
        favouriteCategories: [],
        defaultOrganizationId: null,
        paymentPriority: ['REWARD', 'CASHBACK', 'LOCKED', 'AVAILABLE'],
        theme: 'system',
        locale: 'en',
        currency: 'NGN',
        notificationPreferences: null,
      },
    });
  })
);

appActivityRoutes.put(
  '/preferences',
  validate({
    body: z.object({
      dashboardWidgets: z.array(z.string().trim().max(40)).max(30).optional(),
      pinnedWidgets: z.array(z.string().trim().max(40)).max(10).optional(),
      favouriteCategories: z.array(z.string().trim().max(40)).max(20).optional(),
      defaultOrganizationId: z.string().trim().nullable().optional(),
      paymentPriority: z.array(z.enum(['AVAILABLE', 'LOCKED', 'REWARD', 'CASHBACK'])).optional(),
      theme: z.enum(['system', 'light', 'dark']).optional(),
      locale: z.string().trim().max(10).optional(),
      currency: z.string().trim().length(3).toUpperCase().optional(),
      notificationPreferences: z.record(z.string(), z.boolean()).optional(),
    }),
  }),
  wrap(async (req, res) => {
    const vhicasarId = req.appAuth!.vhicasarId;
    const body = req.body as Record<string, unknown>;
    const data = await prismaUnscoped.customerPreference.upsert({
      where: { vhicasarId },
      create: { vhicasarId, ...body } as never,
      update: body as never,
    });
    res.json({ success: true, data });
  })
);

/**
 * Live updates for the Super App (F3).
 *
 * A long-lived Server-Sent Events stream, so a payment, a wallet change or a
 * settlement reaches an open screen the moment it happens instead of waiting
 * for the customer to pull to refresh. The app reconnects on its own, and the
 * stream carries no data itself — only "something changed, re-read it" — so a
 * dropped connection can never leave a stale balance on screen.
 */
appActivityRoutes.get('/events/stream', (req, res) => {
  const vhicasarId = req.appAuth!.vhicasarId;
  const detach = subscribeIdentity(vhicasarId, res);
  req.on('close', detach);
});

// ---- AI Business Concierge (§15) ----

/**
 * One assistant across every business the customer belongs to. Read-only, and
 * grounded entirely in the customer's own aggregates — it has no tools.
 */
appActivityRoutes.post(
  '/concierge',
  validate({
    body: z.object({
      question: z.string().trim().min(1).max(500),
      history: z
        .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(2_000) }))
        .max(20)
        .optional(),
      currency: z.string().trim().length(3).toUpperCase().default('NGN'),
    }),
  }),
  wrap(async (req, res) => {
    const body = req.body as {
      question: string;
      history?: { role: 'user' | 'assistant'; content: string }[];
      currency: string;
    };
    const data = await concierge.ask(
      req.appAuth!.vhicasarId,
      body.question,
      body.history ?? [],
      body.currency
    );
    res.json({ success: true, data });
  })
);

/** Starter questions, chosen from what this customer actually has. */
appActivityRoutes.get(
  '/concierge/suggestions',
  validate({ query: currencyQuery }),
  wrap(async (req, res) => {
    const { currency } = req.query as unknown as { currency: string };
    const items = await concierge.suggestions(req.appAuth!.vhicasarId, currency);
    res.json({ success: true, data: { items } });
  })
);
