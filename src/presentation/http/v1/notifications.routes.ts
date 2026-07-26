import { Router, type Request, type RequestHandler, type Response } from 'express';
import { authenticate } from '../middleware/authenticate';
import { notifyService } from '../../../application/notifications/notify.service';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

/** The signed-in user's notification tray. User-scoped (no tenant required). */
export const notificationsRoutes = Router();
notificationsRoutes.use(authenticate);

const uid = (req: Request) => req.auth!.userId;

notificationsRoutes.get(
  '/',
  wrap(async (req, res) => {
    res.json({ success: true, data: await notifyService.list(uid(req)) });
  }),
);

notificationsRoutes.post(
  '/read-all',
  wrap(async (req, res) => {
    res.json({ success: true, data: await notifyService.markAllRead(uid(req)) });
  }),
);

notificationsRoutes.post(
  '/:id/read',
  wrap(async (req, res) => {
    res.json({ success: true, data: await notifyService.markRead(uid(req), req.params.id as string) });
  }),
);

// ── Device tokens (FCM) ────────────────────────────────────────────────────

const PLATFORMS = new Set(['web', 'android', 'ios', 'windows', 'macos', 'linux']);

/** Register/refresh this device's push token. */
notificationsRoutes.post(
  '/devices',
  wrap(async (req, res) => {
    const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    const platform = typeof req.body?.platform === 'string' ? req.body.platform : '';
    if (!token || !PLATFORMS.has(platform)) {
      res.status(400).json({ success: false, error: { message: 'token and a valid platform are required' } });
      return;
    }
    res.json({ success: true, data: await notifyService.registerDevice(uid(req), token, platform) });
  }),
);

/** Unregister a push token (sign-out / revoke). */
notificationsRoutes.delete(
  '/devices/:token',
  wrap(async (req, res) => {
    res.json({ success: true, data: await notifyService.removeDevice(uid(req), req.params.token as string) });
  }),
);

// ── Preferences ────────────────────────────────────────────────────────────

const CHANNELS = new Set(['PUSH', 'IN_APP', 'EMAIL']);

notificationsRoutes.get(
  '/preferences',
  wrap(async (req, res) => {
    res.json({ success: true, data: await notifyService.getPreferences(uid(req)) });
  }),
);

/** Toggle one preference: { type, channel, enabled }. */
notificationsRoutes.put(
  '/preferences',
  wrap(async (req, res) => {
    const type = typeof req.body?.type === 'string' ? req.body.type : '';
    const channel = typeof req.body?.channel === 'string' ? req.body.channel : '';
    const enabled = req.body?.enabled;
    if (!type || !CHANNELS.has(channel) || typeof enabled !== 'boolean') {
      res.status(400).json({ success: false, error: { message: 'type, channel and enabled are required' } });
      return;
    }
    res.json({
      success: true,
      data: await notifyService.setPreference(uid(req), type, channel as 'PUSH' | 'IN_APP' | 'EMAIL', enabled),
    });
  }),
);
