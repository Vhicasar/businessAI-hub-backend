import { Router, type Request, type RequestHandler, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import { requestContext } from '../../../shared/context';
import {
  suggest,
  resolveSuggestion,
  describePoint,
} from '../../../application/maps/address-suggest.service';
import { mapDisplayConfig, mapsHealth } from '../../../application/maps/maps.service';
import { prismaUnscoped } from '../../../infrastructure/database/prisma';

/**
 * Address search for signed-in users.
 *
 * Rate limited per user even though they are authenticated: a form that fires
 * on every keystroke is one bad debounce away from a four-figure bill, and the
 * ceiling is cheaper than the discovery.
 */
export const addressesRoutes = Router();
addressesRoutes.use(authenticate, requireTenant);

addressesRoutes.use(
  rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: { code: 'RATE_LIMITED', message: 'Slow down a little' } },
  }),
);

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

/** Bias suggestions towards where the business actually is. */
async function businessPoint(organizationId: string) {
  const profile = await prismaUnscoped.businessProfile.findUnique({
    where: { organizationId },
    select: { latitude: true, longitude: true },
  });
  if (profile?.latitude == null || profile?.longitude == null) return null;
  return { latitude: Number(profile.latitude), longitude: Number(profile.longitude) };
}

addressesRoutes.get(
  '/suggest',
  validate({ query: z.object({ q: z.string().trim().min(1).max(200) }) }),
  wrap(async (req, res) => {
    const organizationId = requestContext.get()!.organizationId!;
    res.json({
      success: true,
      data: await suggest({
        organizationId,
        query: String(req.query.q),
        near: await businessPoint(organizationId),
      }),
    });
  }),
);

addressesRoutes.get(
  '/resolve',
  validate({ query: z.object({ placeId: z.string().trim().min(1).max(300) }) }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await resolveSuggestion(String(req.query.placeId)) });
  }),
);

addressesRoutes.get(
  '/reverse',
  validate({
    query: z.object({
      latitude: z.coerce.number().min(-90).max(90),
      longitude: z.coerce.number().min(-180).max(180),
    }),
  }),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await describePoint({
        latitude: Number(req.query.latitude),
        longitude: Number(req.query.longitude),
      }),
    });
  }),
);

/**
 * What the browser needs to draw a map, and nothing else.
 *
 * The public token only. It is a different credential from the server key,
 * restricted by origin at the provider, and meant to be visible — unlike the
 * key this backend geocodes with, which never leaves it.
 */
addressesRoutes.get(
  '/map-config',
  wrap(async (_req, res) => {
    res.json({ success: true, data: mapDisplayConfig() });
  }),
);

/** Which providers are serving which capability, for the operations screens. */
addressesRoutes.get(
  '/providers',
  // Operational detail — which vendors this workspace talks to and whether
  // they are keyed. Not secret, but not every member's business either.
  requirePermission('settings.manage_org'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: mapsHealth() });
  }),
);
