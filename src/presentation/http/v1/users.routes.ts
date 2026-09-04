import { Router, type Request, type RequestHandler, type Response } from 'express';
import { validate } from '../middleware/validate';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import { enforceLimit } from '../middleware/plan-guard';
import { authLimiter } from '../middleware/rate-limit';
import { usersService } from '../../../application/users/users.service';
import { authService } from '../../../application/auth/auth.service';
import {
  listAssignments,
  setAssignments,
} from '../../../application/inventory/warehouse-access';
import { z } from 'zod';
import {
  acceptInviteSchema,
  inviteUserSchema,
  updateMemberSchema,
  updateProfileSchema,
} from '../../../application/users/users.dto';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

export const usersRoutes = Router();
export const invitationsRoutes = Router();

// ---- membership management (tenant) ----

usersRoutes.get(
  '/',
  authenticate,
  requireTenant,
  requirePermission('settings.manage_users'),
  wrap(async (req, res) => {
    const data = await usersService.listMembers(req.auth!.organizationId!);
    res.json({ success: true, data });
  })
);

/**
 * Which warehouses a member is confined to. An empty list means unrestricted,
 * so this is also how an admin lifts a restriction.
 */
usersRoutes.get(
  '/:membershipId/warehouses',
  authenticate,
  requireTenant,
  requirePermission('settings.manage_users'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await listAssignments(req.params.membershipId as string) });
  })
);

usersRoutes.put(
  '/:membershipId/warehouses',
  authenticate,
  requireTenant,
  // Only user administration, deliberately: `inventory.manage_warehouses` is
  // what a warehouse manager holds, and they must not be able to widen their
  // own access. requirePermission is ANY-of, so listing both would do exactly
  // that.
  requirePermission('settings.manage_users'),
  validate({
    body: z.object({
      assignments: z
        .array(z.object({ warehouseId: z.string().min(1), canManage: z.boolean().optional() }))
        .max(200),
    }),
  }),
  wrap(async (req, res) => {
    const data = await setAssignments(
      req.params.membershipId as string,
      req.body.assignments,
      req.auth!.organizationId!
    );
    res.json({ success: true, data });
  })
);

usersRoutes.patch(
  '/me',
  authenticate,
  validate({ body: updateProfileSchema }),
  wrap(async (req, res) => {
    const data = await usersService.updateProfile(req.auth!.userId, req.body);
    res.json({ success: true, data });
  })
);

usersRoutes.patch(
  '/:membershipId',
  authenticate,
  requireTenant,
  requirePermission('settings.manage_users'),
  validate({ body: updateMemberSchema }),
  wrap(async (req, res) => {
    const data = await usersService.updateMember(
      req.params.membershipId as string,
      req.auth!.membershipId!,
      req.body
    );
    res.json({ success: true, data });
  })
);

usersRoutes.delete(
  '/:membershipId',
  authenticate,
  requireTenant,
  requirePermission('settings.manage_users'),
  wrap(async (req, res) => {
    await usersService.removeMember(req.params.membershipId as string, req.auth!.membershipId!);
    res.json({ success: true, data: { message: 'Member removed' } });
  })
);

// ---- invitations ----

invitationsRoutes.post(
  '/',
  authenticate,
  requireTenant,
  requirePermission('settings.manage_users'),
  enforceLimit('users'),
  validate({ body: inviteUserSchema }),
  wrap(async (req, res) => {
    const data = await usersService.invite(
      req.auth!.organizationId!,
      req.auth!.userId,
      req.body
    );
    res.status(201).json({ success: true, data });
  })
);

invitationsRoutes.delete(
  '/:id',
  authenticate,
  requireTenant,
  requirePermission('settings.manage_users'),
  wrap(async (req, res) => {
    await usersService.revokeInvitation(req.params.id as string);
    res.json({ success: true, data: { message: 'Invitation revoked' } });
  })
);

// Public: accept an invitation (creates account if needed, returns a session).
invitationsRoutes.post(
  '/accept',
  authLimiter,
  validate({ body: acceptInviteSchema }),
  wrap(async (req, res) => {
    const { userId, organizationId } = await usersService.acceptInvite(req.body);
    const session = await authService.switchOrganization(userId, organizationId, {
      userAgent: req.headers['user-agent'],
      ipAddress: req.ip,
    });
    res.status(201).json({ success: true, data: session });
  })
);
