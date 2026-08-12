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
import { calendarSync } from '../../../application/integrations/calendar-sync.service';
import { currentOrgId } from '../../../application/billing/entitlements';

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

/**
 * Bookings for the calendar view, with customer, assignee, service and property
 * resolved. Literal path, declared before any `/:id`, so it is not shadowed.
 */
appointmentsRoutes.get(
  '/calendar',
  requirePermission('appointments.read'),
  validate({
    query: z.object({
      from: z.string().optional(),
      to: z.string().optional(),
      status: z.string().optional(),
      assigneeId: z.string().optional(),
    }),
  }),
  wrap(async (req, res) => { res.json({ success: true, data: await appointmentsService.calendar(req.query as never) }); }),
);

/**
 * Pull anything new from a connected Calendly account into the calendar.
 *
 * This creates bookings, so it needs the permission to create them — reading
 * the calendar is not licence to write to it.
 */
appointmentsRoutes.post(
  '/calendar/sync',
  requirePermission('appointments.create'),
  wrap(async (_req, res) => {
    const organizationId = currentOrgId();
    const providers = await calendarSync.connectedProviders(organizationId);
    const result = providers.includes('calendly')
      ? await calendarSync.pullFromCalendly(organizationId)
      : { imported: 0, updated: 0 };
    res.json({ success: true, data: { ...result, providers } });
  }),
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

/**
 * One booking in full. Declared last so the literal paths above — /config,
 * /calendar, /slots — are matched first rather than being read as an id.
 */
appointmentsRoutes.get(
  '/:id',
  requirePermission('appointments.read'),
  wrap(async (req, res) => { res.json({ success: true, data: await appointmentsService.detail(req.params.id as string) }); }),
);
