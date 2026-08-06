import { Router, type Request, type RequestHandler, type Response } from 'express';
import { validate } from '../middleware/validate';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import { enforceLimit } from '../middleware/plan-guard';
import { z } from 'zod';
import type { ChannelType } from '@prisma/client';
import { customersService } from '../../../application/customers/customers.service';
import { quickCreate } from '../../../application/customers/quick-create.service';
import { inboxService } from '../../../application/inbox/inbox.service';
import {
  addressSchema,
  createCustomerSchema,
  listCustomersSchema,
  updateCustomerSchema,
} from '../../../application/customers/customers.dto';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

export const customersRoutes = Router();

customersRoutes.use(authenticate, requireTenant);

customersRoutes.get(
  '/',
  requirePermission('customers.read'),
  validate({ query: listCustomersSchema }),
  wrap(async (req, res) => {
    const data = await customersService.list(req.query as never);
    res.json({ success: true, data });
  })
);

customersRoutes.post(
  '/',
  requirePermission('customers.create'),
  enforceLimit('contacts'),
  validate({ body: createCustomerSchema }),
  wrap(async (req, res) => {
    const data = await customersService.create(req.body);
    res.status(201).json({ success: true, data });
  })
);

customersRoutes.get(
  '/:id',
  requirePermission('customers.read'),
  wrap(async (req, res) => {
    const data = await customersService.get(req.params.id as string);
    res.json({ success: true, data });
  })
);

customersRoutes.get(
  '/:id/overview',
  requirePermission('customers.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await customersService.overview(req.params.id as string) });
  })
);

// Communication channels linked to this customer + their conversations.
customersRoutes.get(
  '/:id/channels',
  requirePermission('customers.read', 'inbox.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await inboxService.customerChannels(req.params.id as string) });
  })
);

// Start or continue a conversation with this customer on a channel.
customersRoutes.post(
  '/:id/chat',
  requirePermission('inbox.reply'),
  validate({ body: z.object({ channelType: z.string().min(1), text: z.string().trim().min(1).max(4000) }) }),
  wrap(async (req, res) => {
    const data = await inboxService.startOrContinue(
      req.params.id as string,
      req.body.channelType as ChannelType,
      req.body.text,
      req.auth!.userId
    );
    res.json({ success: true, data });
  })
);

customersRoutes.patch(
  '/:id',
  requirePermission('customers.update'),
  validate({ body: updateCustomerSchema }),
  wrap(async (req, res) => {
    const data = await customersService.update(req.params.id as string, req.body);
    res.json({ success: true, data });
  })
);

customersRoutes.delete(
  '/:id',
  requirePermission('customers.delete'),
  wrap(async (req, res) => {
    await customersService.remove(req.params.id as string);
    res.json({ success: true, data: { message: 'Customer deleted' } });
  })
);

customersRoutes.post(
  '/:id/addresses',
  requirePermission('customers.update'),
  validate({ body: addressSchema }),
  wrap(async (req, res) => {
    const data = await customersService.addAddress(req.params.id as string, req.body);
    res.status(201).json({ success: true, data });
  })
);

customersRoutes.put(
  '/:id/addresses/:addressId',
  requirePermission('customers.update'),
  validate({ body: addressSchema }),
  wrap(async (req, res) => {
    const data = await customersService.updateAddress(
      req.params.id as string,
      req.params.addressId as string,
      req.body
    );
    res.json({ success: true, data });
  })
);

customersRoutes.delete(
  '/:id/addresses/:addressId',
  requirePermission('customers.update'),
  wrap(async (req, res) => {
    await customersService.removeAddress(req.params.id as string, req.params.addressId as string);
    res.json({ success: true, data: { message: 'Address removed' } });
  })
);

// ---- Inline customer creation for POS / orders / bookings (§23) ----

/**
 * Type-ahead lookup used by the "select existing customer" step, so staff can
 * find a person mid-sale without leaving the workflow.
 */
customersRoutes.get(
  '/lookup',
  requirePermission('customers.read'),
  validate({ query: z.object({ q: z.string().trim().min(2).max(80), limit: z.coerce.number().int().min(1).max(20).default(8) }) }),
  wrap(async (req, res) => {
    const { q, limit } = req.query as unknown as { q: string; limit: number };
    res.json({ success: true, data: await quickCreate.lookup(q, limit) });
  })
);

/**
 * Find-or-create in one call. Matches on email → phone → government id before
 * creating anything, so serving a walk-in can never fork an existing customer.
 */
customersRoutes.post(
  '/quick-create',
  requirePermission('customers.create'),
  enforceLimit('contacts'),
  validate({
    body: z.object({
      firstName: z.string().trim().min(1).max(80),
      lastName: z.string().trim().max(80).optional(),
      phone: z.string().trim().max(30).optional(),
      email: z.string().trim().toLowerCase().email().optional(),
      gender: z.string().trim().max(20).optional(),
      dateOfBirth: z.coerce.date().optional(),
      address: z.string().trim().max(300).optional(),
      notes: z.string().trim().max(1000).optional(),
      membershipNumber: z.string().trim().max(60).optional(),
      governmentId: z.string().trim().max(60).optional(),
      source: z.enum(['POS', 'ORDER', 'QUOTATION', 'BOOKING', 'INVOICE', 'RESERVATION', 'MANUAL']).default('MANUAL'),
      invite: z.boolean().default(false),
    }).refine((v) => v.phone || v.email, { message: 'Provide a phone number or an email address' }),
  }),
  wrap(async (req, res) => {
    const data = await quickCreate.resolve(req.auth!.organizationId as string, req.body);
    res.status(data.created ? 201 : 200).json({
      success: true,
      message: data.created
        ? data.invitationSent
          ? 'Customer created and invited to Vhicasar.'
          : 'Customer created.'
        : 'Matched an existing customer.',
      data,
    });
  })
);

/** Re-send the Super App invitation for an existing customer. */
customersRoutes.post(
  '/:id/invite',
  requirePermission('customers.update'),
  wrap(async (req, res) => {
    const org = await customersService.get(req.params.id as string);
    const sent = await quickCreate.sendInvitation(
      req.auth!.organizationId as string,
      req.params.id as string,
      (org as { organizationName?: string }).organizationName ?? 'your business'
    );
    res.json({ success: true, data: { sent } });
  })
);
