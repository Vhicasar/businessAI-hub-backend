import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticateApp } from '../middleware/authenticate-app';
import { businessDiscovery } from '../../../application/discovery/business-discovery.service';
import { businessDashboard } from '../../../application/discovery/business-dashboard.service';
import { promotionEngine } from '../../../application/marketing/promotion-engine.service';
import { loyaltyEngine } from '../../../application/loyalty/loyalty-engine.service';
import { prismaUnscoped } from '../../../infrastructure/database/prisma';
import { orderCenter } from '../../../application/superapp/order-center.service';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

/**
 * Customer Super App — multi-business experience (§1–§4, §8).
 * Mounted at /api/app/v1. Every route is anchored to the caller's Vhicasar ID.
 */
export const appBusinessRoutes = Router();
appBusinessRoutes.use(authenticateApp);

// ---- Discovery ----

/** Search participating businesses (name / id / phone / website / category / city). */
appBusinessRoutes.get(
  '/businesses/search',
  validate({
    query: z.object({
      q: z.string().trim().max(120).optional(),
      category: z.string().trim().max(60).optional(),
      country: z.string().trim().length(2).optional(),
      city: z.string().trim().max(80).optional(),
      cursor: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(50).default(20),
    }),
  }),
  wrap(async (req, res) => {
    const q = req.query as unknown as Parameters<typeof businessDiscovery.search>[0];
    res.json({ success: true, data: await businessDiscovery.search(q) });
  })
);

/** Public profile of one business, plus whether the caller has joined. */
appBusinessRoutes.get(
  '/businesses/:organizationId/profile',
  wrap(async (req, res) => {
    const data = await businessDiscovery.profile(req.params.organizationId as string, req.appAuth!.vhicasarId);
    res.json({ success: true, data });
  })
);

// ---- Membership ----

/** Businesses the caller belongs to, as cards for the switcher list. */
appBusinessRoutes.get(
  '/businesses',
  wrap(async (req, res) => {
    res.json({ success: true, data: await businessDashboard.cards(req.appAuth!.vhicasarId) });
  })
);

appBusinessRoutes.post(
  '/businesses/:organizationId/join',
  validate({ body: z.object({ source: z.string().trim().max(30).optional() }).optional() }),
  wrap(async (req, res) => {
    const data = await businessDiscovery.join(req.appAuth!.vhicasarId, req.params.organizationId as string, {
      source: req.body?.source ?? 'SEARCH',
    });
    res.status(201).json({ success: true, message: `You are now connected to ${data.business}.`, data });
  })
);

/** Join by scanning a business QR (§3). */
appBusinessRoutes.post(
  '/businesses/join-by-qr',
  validate({ body: z.object({ code: z.string().trim().min(4).max(300) }) }),
  wrap(async (req, res) => {
    const data = await businessDiscovery.joinByQr(req.appAuth!.vhicasarId, req.body.code);
    res.status(201).json({ success: true, message: `You are now connected to ${data.business}.`, data });
  })
);

appBusinessRoutes.delete(
  '/businesses/:organizationId',
  wrap(async (req, res) => {
    const data = await businessDiscovery.leave(req.appAuth!.vhicasarId, req.params.organizationId as string);
    res.json({ success: true, message: 'Business removed.', data });
  })
);

/** Pin / hide / favourite a business in the customer's own list. */
appBusinessRoutes.patch(
  '/businesses/:organizationId/preferences',
  validate({
    body: z.object({
      isPinned: z.boolean().optional(),
      isHidden: z.boolean().optional(),
      isFavourite: z.boolean().optional(),
    }),
  }),
  wrap(async (req, res) => {
    const data = await businessDiscovery.setPreferences(
      req.appAuth!.vhicasarId,
      req.params.organizationId as string,
      req.body
    );
    res.json({ success: true, data });
  })
);

// ---- Per-business dashboard (§4) ----

appBusinessRoutes.get(
  '/businesses/:organizationId/dashboard',
  wrap(async (req, res) => {
    const data = await businessDashboard.dashboard(req.appAuth!.vhicasarId, req.params.organizationId as string);
    res.json({ success: true, data });
  })
);

appBusinessRoutes.get(
  '/businesses/:organizationId/counters',
  wrap(async (req, res) => {
    const data = await businessDashboard.counters(req.appAuth!.vhicasarId, req.params.organizationId as string);
    res.json({ success: true, data });
  })
);

// ---- Promotions & loyalty (§7, §8) ----

/**
 * Every offer across every business the customer belongs to. The entry point
 * for "what deals do I have?", which no per-business screen can answer.
 */
appBusinessRoutes.get(
  '/promotions',
  wrap(async (req, res) => {
    res.json({ success: true, data: await businessDashboard.allPromotions(req.appAuth!.vhicasarId) });
  })
);

/** Promotions this customer can actually claim right now. */
appBusinessRoutes.get(
  '/businesses/:organizationId/promotions',
  wrap(async (req, res) => {
    const link = await businessDashboard.requireLink(req.appAuth!.vhicasarId, req.params.organizationId as string);
    const data = await promotionEngine.availableFor(req.params.organizationId as string, link.customerId);
    // Opening the list clears the unread badge on the business card.
    await prismaUnscoped.customerLink.update({ where: { id: link.id }, data: { unreadPromotions: 0 } });
    res.json({ success: true, data });
  })
);

/** Deep-link target: one promotion, with everything needed to redeem it. */
appBusinessRoutes.get(
  '/businesses/:organizationId/promotions/:promotionId',
  wrap(async (req, res) => {
    const link = await businessDashboard.requireLink(req.appAuth!.vhicasarId, req.params.organizationId as string);
    const available = await promotionEngine.availableFor(req.params.organizationId as string, link.customerId);
    const promotion = available.find((p) => p.id === req.params.promotionId);
    res.json({
      success: true,
      data: {
        promotion: promotion ?? null,
        // Tell the app *why* it can't be claimed rather than just hiding it.
        claimable: Boolean(promotion),
      },
    });
  })
);

/** Points statement for this business. */
appBusinessRoutes.get(
  '/businesses/:organizationId/loyalty',
  validate({ query: z.object({ cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(30) }) }),
  wrap(async (req, res) => {
    const link = await businessDashboard.requireLink(req.appAuth!.vhicasarId, req.params.organizationId as string);
    const q = req.query as unknown as { cursor?: string; limit: number };
    res.json({ success: true, data: await loyaltyEngine.statement(link.customerId, q) });
  })
);

// ---- Customer Order Center (§4, §6, §9) ----

const RECORD_KINDS = ['ORDER', 'QUOTATION', 'INVOICE', 'BOOKING', 'APPOINTMENT', 'RENT', 'MAINTENANCE'] as const;

/**
 * Everything the customer has with this business. Always returns
 * `{ items: [], counts: {} }` — never null — so the app can render an empty
 * state rather than crash on a missing collection (§11).
 */
appBusinessRoutes.get(
  '/businesses/:organizationId/records',
  validate({
    query: z.object({
      kinds: z.string().trim().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(25),
    }),
  }),
  wrap(async (req, res) => {
    const q = req.query as unknown as { kinds?: string; limit: number };
    const kinds = q.kinds
      ?.split(',')
      .map((k) => k.trim().toUpperCase())
      .filter((k): k is (typeof RECORD_KINDS)[number] => (RECORD_KINDS as readonly string[]).includes(k));

    const data = await orderCenter.records(req.appAuth!.vhicasarId, req.params.organizationId as string, {
      kinds,
      limit: q.limit,
    });
    res.json({ success: true, data });
  })
);

/** Full order detail: items, tax, discounts, promotions, loyalty, timeline. */
appBusinessRoutes.get(
  '/businesses/:organizationId/orders/:orderId',
  wrap(async (req, res) => {
    const data = await orderCenter.orderDetail(
      req.appAuth!.vhicasarId,
      req.params.organizationId as string,
      req.params.orderId as string
    );
    res.json({ success: true, data });
  })
);

appBusinessRoutes.get(
  '/businesses/:organizationId/invoices/:invoiceId',
  wrap(async (req, res) => {
    const data = await orderCenter.invoiceDetail(
      req.appAuth!.vhicasarId,
      req.params.organizationId as string,
      req.params.invoiceId as string
    );
    res.json({ success: true, data });
  })
);

/**
 * Get something payable for an order or invoice (§8). Creates the payment link
 * on demand when the business never made one, so a customer can always pay.
 */
appBusinessRoutes.post(
  '/businesses/:organizationId/records/:kind/:recordId/payable',
  validate({ params: z.object({ organizationId: z.string(), kind: z.enum(['ORDER', 'INVOICE']), recordId: z.string() }) }),
  wrap(async (req, res) => {
    const data = await orderCenter.payableFor(
      req.appAuth!.vhicasarId,
      req.params.organizationId as string,
      req.params.kind as 'ORDER' | 'INVOICE',
      req.params.recordId as string
    );
    res.status(201).json({ success: true, data });
  })
);

// ---- Booking management (§7) ----

appBusinessRoutes.get(
  '/businesses/:organizationId/bookings',
  validate({ query: z.object({ upcoming: z.coerce.boolean().default(false) }) }),
  wrap(async (req, res) => {
    const { upcoming } = req.query as unknown as { upcoming: boolean };
    const data = await orderCenter.bookings(req.appAuth!.vhicasarId, req.params.organizationId as string, {
      upcomingOnly: upcoming,
    });
    res.json({ success: true, data });
  })
);

appBusinessRoutes.post(
  '/businesses/:organizationId/bookings/:bookingId/cancel',
  validate({ body: z.object({ reason: z.string().trim().max(300).optional() }).optional() }),
  wrap(async (req, res) => {
    const data = await orderCenter.cancelBooking(
      req.appAuth!.vhicasarId,
      req.params.organizationId as string,
      req.params.bookingId as string,
      req.body?.reason
    );
    res.json({ success: true, message: 'Booking cancelled.', data });
  })
);
