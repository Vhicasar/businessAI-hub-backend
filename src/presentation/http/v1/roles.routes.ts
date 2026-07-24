import { Router, type Request, type RequestHandler, type Response } from 'express';
import { validate } from '../middleware/validate';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import { rolesService, roleSchema } from '../../../application/roles/roles.service';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

export const rolesRoutes = Router();

rolesRoutes.use(authenticate, requireTenant);

// Also readable with employees.invite: choosing a role is part of inviting
// someone, and an invite flow with an empty role list is useless.
rolesRoutes.get(
  '/',
  requirePermission('settings.manage_roles', 'settings.manage_users', 'employees.invite'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await rolesService.list() });
  })
);

rolesRoutes.get(
  '/permissions',
  requirePermission('settings.manage_roles', 'settings.manage_users'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await rolesService.catalog() });
  })
);

rolesRoutes.post(
  '/',
  requirePermission('settings.manage_roles'),
  validate({ body: roleSchema }),
  wrap(async (req, res) => {
    const data = await rolesService.create(req.auth!.organizationId!, req.body);
    res.status(201).json({ success: true, data });
  })
);

rolesRoutes.put(
  '/:id',
  requirePermission('settings.manage_roles'),
  validate({ body: roleSchema }),
  wrap(async (req, res) => {
    const data = await rolesService.update(req.params.id as string, req.body);
    res.json({ success: true, data });
  })
);

rolesRoutes.delete(
  '/:id',
  requirePermission('settings.manage_roles'),
  wrap(async (req, res) => {
    await rolesService.remove(req.params.id as string);
    res.json({ success: true, data: { message: 'Role deleted' } });
  })
);
