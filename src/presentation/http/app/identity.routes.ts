import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { prismaUnscoped } from '../../../infrastructure/database/prisma';
import { requestContext } from '../../../shared/context';
import { logger } from '../../../shared/logger';
import { validate } from '../middleware/validate';
import { authenticateApp } from '../middleware/authenticate-app';
import { vhicasarIdService } from '../../../application/identity/vhicasar-id.service';
import { identityTokenService } from '../../../application/identity/identity-token.service';
import {
  loginIdentitySchema,
  refreshTokenSchema,
  registerDeviceSchema,
  registerIdentitySchema,
  setPinSchema,
} from '../../../application/identity/identity.dto';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

/**
 * Crash + error reports from the apps (§13). Deliberately *unauthenticated*:
 * the most valuable reports come from failures that happen before or during
 * sign-in, which an auth guard would silently drop. Rate limiting on the router
 * keeps it from being abused, and nothing here is trusted as business data.
 */
export const clientErrorRoutes = Router();

clientErrorRoutes.post(
  '/client-errors',
  validate({
    body: z.object({
      kind: z.string().trim().max(30),
      message: z.string().trim().max(4000),
      stack: z.string().trim().max(20000).optional(),
      screen: z.string().trim().max(200).optional(),
      vhicasarId: z.string().trim().max(60).optional().nullable(),
      organizationId: z.string().trim().max(60).optional().nullable(),
      endpoint: z.string().trim().max(300).optional().nullable(),
      correlationId: z.string().trim().max(100).optional().nullable(),
      device: z.record(z.string(), z.unknown()).optional().nullable(),
      appFlavor: z.string().trim().max(20).optional(),
      extra: z.record(z.string(), z.unknown()).optional().nullable(),
      occurredAt: z.coerce.date().optional(),
    }),
  }),
  wrap(async (req, res) => {
    const body = req.body as Record<string, unknown>;
    await prismaUnscoped.clientError.create({
      data: {
        kind: body.kind as string,
        message: body.message as string,
        stack: (body.stack as string) ?? null,
        screen: (body.screen as string) ?? null,
        vhicasarId: (body.vhicasarId as string) ?? null,
        organizationId: (body.organizationId as string) ?? null,
        endpoint: (body.endpoint as string) ?? null,
        correlationId: (body.correlationId as string) ?? requestContext.get()?.correlationId ?? null,
        device: (body.device ?? undefined) as never,
        appFlavor: (body.appFlavor as string) ?? null,
        extra: (body.extra ?? undefined) as never,
        occurredAt: (body.occurredAt as Date) ?? new Date(),
      },
    });
    logger.warn({ kind: body.kind, screen: body.screen, message: body.message }, 'client error reported');
    // Fire-and-forget from the client's perspective.
    res.status(202).json({ success: true, data: { received: true } });
  })
);

const clientIp = (req: Request): string | undefined =>
  (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.socket.remoteAddress || undefined;

/**
 * Customer Super App identity API — the consumer-facing Identity Service
 * (System Bible III). Mounted at /api/app/v1. Uses `app`-scoped tokens whose
 * subject is a Vhicasar ID, entirely separate from the business auth surface.
 */
export const appIdentityRoutes = Router();

// ---- Public (no token) ----

const sessionMeta = (req: Request) => ({
  userAgent: req.headers['user-agent'],
  ipAddress: clientIp(req),
});

appIdentityRoutes.post(
  '/auth/register',
  validate({ body: registerIdentitySchema }),
  wrap(async (req, res) => {
    const identity = await vhicasarIdService.register(req.body);
    const session = await identityTokenService.issueSession(identity.id, sessionMeta(req));
    res.status(201).json({
      success: true,
      message: 'Account created successfully.',
      data: { ...session, identity: vhicasarIdService.publicView(identity) },
    });
  })
);

appIdentityRoutes.post(
  '/auth/login',
  validate({ body: loginIdentitySchema }),
  wrap(async (req, res) => {
    const identity = await vhicasarIdService.login(req.body);
    const session = await identityTokenService.issueSession(identity.id, sessionMeta(req));
    res.json({
      success: true,
      message: 'Signed in successfully.',
      data: { ...session, identity: vhicasarIdService.publicView(identity) },
    });
  })
);

/** Silent re-auth. Rotates the refresh token; reuse burns the family. */
appIdentityRoutes.post(
  '/auth/refresh',
  validate({ body: refreshTokenSchema }),
  wrap(async (req, res) => {
    const rotated = await identityTokenService.rotateRefreshToken(req.body.refreshToken, sessionMeta(req));
    const identity = await vhicasarIdService.getById(rotated.vhicasarId);
    res.json({
      success: true,
      data: {
        accessToken: rotated.accessToken,
        refreshToken: rotated.refreshToken,
        identity: vhicasarIdService.publicView(identity),
      },
    });
  })
);

/** Logout is idempotent — an unknown or already-revoked token still succeeds. */
appIdentityRoutes.post(
  '/auth/logout',
  validate({ body: refreshTokenSchema }),
  wrap(async (req, res) => {
    await identityTokenService.revokeFamilyByToken(req.body.refreshToken);
    res.json({ success: true, data: { message: 'Signed out' } });
  })
);

// ---- Authenticated (Vhicasar ID) ----

appIdentityRoutes.use(authenticateApp);

appIdentityRoutes.get(
  '/identity/me',
  wrap(async (req, res) => {
    const identity = await vhicasarIdService.getById(req.appAuth!.vhicasarId);
    res.json({ success: true, data: vhicasarIdService.publicView(identity) });
  })
);

appIdentityRoutes.put(
  '/identity/pin',
  validate({ body: setPinSchema }),
  wrap(async (req, res) => {
    await vhicasarIdService.setPin(req.appAuth!.vhicasarId, req.body.pin);
    res.json({ success: true, data: { message: 'PIN updated' } });
  })
);

/** Businesses this Vhicasar ID is linked to (its universal profile). */
appIdentityRoutes.get(
  '/identity/businesses',
  wrap(async (req, res) => {
    const data = await vhicasarIdService.listBusinesses(req.appAuth!.vhicasarId);
    res.json({ success: true, data });
  })
);

appIdentityRoutes.post(
  '/devices',
  validate({ body: registerDeviceSchema }),
  wrap(async (req, res) => {
    const device = await vhicasarIdService.registerDevice(req.appAuth!.vhicasarId, req.body, clientIp(req));
    // Re-issue the session bound to this device so payment confirmations can
    // reference it (device trust / replay protection).
    const session = await identityTokenService.issueSession(req.appAuth!.vhicasarId, {
      ...sessionMeta(req),
      deviceId: device.deviceId,
    });
    res.status(201).json({ success: true, data: { device, ...session } });
  })
);

appIdentityRoutes.get(
  '/devices',
  wrap(async (req, res) => {
    res.json({ success: true, data: await vhicasarIdService.listDevices(req.appAuth!.vhicasarId) });
  })
);

appIdentityRoutes.delete(
  '/devices/:deviceId',
  wrap(async (req, res) => {
    await vhicasarIdService.revokeDevice(req.appAuth!.vhicasarId, req.params.deviceId as string);
    res.json({ success: true, data: { message: 'Device revoked' } });
  })
);
