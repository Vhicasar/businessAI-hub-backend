import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import { validate } from '../middleware/validate';
import { requestContext } from '../../../shared/context';
import {
  appointmentsService,
  appointmentConfigSchema,
  bookAppointmentSchema,
} from '../../../application/appointments/appointments.service';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => { fn(req, res).catch(next); };

/** Authenticated appointment management for staff. */
export const appointmentsRoutes = Router();
appointmentsRoutes.use(authenticate, requireTenant);

appointmentsRoutes.get(
  '/config',
  requirePermission('appointments.read'),
  wrap(async (_req, res) => { res.json({ success: true, data: await appointmentsService.getConfig() }); }),
);

appointmentsRoutes.put(
  '/config',
  requirePermission('appointments.configure'),
  validate({ body: appointmentConfigSchema }),
  wrap(async (req, res) => { res.json({ success: true, data: await appointmentsService.saveConfig(req.body) }); }),
);

appointmentsRoutes.get(
  '/',
  requirePermission('appointments.read'),
  validate({ query: z.object({ from: z.string().optional(), to: z.string().optional(), status: z.string().optional() }) }),
  wrap(async (req, res) => { res.json({ success: true, data: await appointmentsService.list(req.query as never) }); }),
);

/** Slots for staff-side booking (own org from context). */
appointmentsRoutes.get(
  '/slots',
  requirePermission('appointments.read'),
  validate({ query: z.object({ typeId: z.string().optional(), days: z.coerce.number().int().min(1).max(60).optional() }) }),
  wrap(async (req, res) => {
    const orgId = requestContext.get()!.organizationId!;
    res.json({ success: true, data: await appointmentsService.availableSlots(orgId, req.query.typeId as string | undefined, Number(req.query.days) || 14) });
  }),
);

appointmentsRoutes.post(
  '/',
  requirePermission('appointments.create'),
  validate({ body: bookAppointmentSchema }),
  wrap(async (req, res) => {
    const orgId = requestContext.get()!.organizationId!;
    res.status(201).json({ success: true, data: await appointmentsService.book(orgId, req.body, 'MANUAL') });
  }),
);

appointmentsRoutes.post(
  '/:id/cancel',
  requirePermission('appointments.cancel'),
  wrap(async (req, res) => { res.json({ success: true, data: await appointmentsService.cancel(req.params.id as string) }); }),
);
