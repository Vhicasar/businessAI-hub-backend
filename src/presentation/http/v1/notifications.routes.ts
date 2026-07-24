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
