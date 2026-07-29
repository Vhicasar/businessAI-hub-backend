import { Router, type Request, type RequestHandler, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { validate } from './middleware/validate';
import { appointmentsService, bookAppointmentSchema } from '../../application/appointments/appointments.service';

/**
 * Public appointment API for the website chat widget and confirmation links.
 * No auth: bookings are scoped by the channel account id (same trust model as
 * the webchat visitor API). Availability + booking run inside the resolved
 * tenant context. Rate limited.
 */
export const appointmentsPublicRoutes = Router();

const limiter = rateLimit({ windowMs: 60_000, limit: 40, standardHeaders: true, legacyHeaders: false, message: { success: false, error: { code: 'RATE_LIMITED', message: 'Slow down a little' } } });
appointmentsPublicRoutes.use(limiter);

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => { fn(req, res).catch(next); };

async function accountOrg(accountId: string): Promise<string | null> {
  const account = await prismaUnscoped.channelAccount.findFirst({
    where: { id: accountId, channelType: 'WEB_CHAT', isActive: true, deletedAt: null },
    select: { organizationId: true },
  });
  return account?.organizationId ?? null;
}

/** Available slots for a chat account's business. */
appointmentsPublicRoutes.get(
  '/:accountId/slots',
  validate({ query: z.object({ typeId: z.string().optional(), days: z.coerce.number().int().min(1).max(60).optional() }) }),
  wrap(async (req, res) => {
    const organizationId = await accountOrg(req.params.accountId as string);
    if (!organizationId) { res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Unavailable' } }); return; }
    const data = await appointmentsService.availableSlots(organizationId, req.query.typeId as string | undefined, Number(req.query.days) || 14);
    res.json({ success: true, data });
  }),
);

/** Book an appointment from chat. */
appointmentsPublicRoutes.post(
  '/:accountId/book',
  validate({ body: bookAppointmentSchema }),
  wrap(async (req, res) => {
    const organizationId = await accountOrg(req.params.accountId as string);
    if (!organizationId) { res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Unavailable' } }); return; }
    const data = await requestContext.run({ requestId: randomUUID(), organizationId }, () =>
      appointmentsService.book(organizationId, req.body, 'CHAT'),
    );
    res.status(201).json({ success: true, data });
  }),
);

/** iCalendar download for an appointment. */
appointmentsPublicRoutes.get(
  '/public/:id/ics',
  wrap(async (req, res) => {
    const ics = await appointmentsService.ics(req.params.id as string);
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="appointment.ics"');
    res.send(ics);
  }),
);

/** Public cancel via the confirmation link token. */
appointmentsPublicRoutes.post(
  '/manage/:token/cancel',
  wrap(async (req, res) => {
    res.json({ success: true, data: await appointmentsService.cancelByToken(req.params.token as string) });
  }),
);
