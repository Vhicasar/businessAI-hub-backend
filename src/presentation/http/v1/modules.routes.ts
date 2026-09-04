import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';

import { validate } from '../middleware/validate';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import {
  moduleStatusFor,
  setModuleOverride,
} from '../../../application/modules/business-modules';
import { auditService } from '../../../application/audit/audit.service';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

/**
 * Optional modules — which this business has, and switching them.
 *
 * Reading is open to any member: the answer already reaches them through
 * `/auth/me` to draw the menu, so gating the same fact behind a permission
 * would only mean the menu and this endpoint disagreed.
 *
 * Changing is `settings.manage_org`, because turning a module on changes what
 * the business is, not merely what one person sees.
 */
export const modulesRoutes = Router();
modulesRoutes.use(authenticate, requireTenant);

modulesRoutes.get(
  '/',
  wrap(async (req, res) => {
    res.json({ success: true, data: await moduleStatusFor(req.auth!.organizationId!) });
  }),
);

modulesRoutes.put(
  '/:moduleId',
  requirePermission('settings.manage_org'),
  validate({
    body: z.object({
      /**
       * `null` clears the override so the business follows its type again.
       * Distinct from `false`, which keeps the module off even if the type
       * later says it should be on.
       */
      enabled: z.boolean().nullable(),
      reason: z.string().trim().max(300).optional(),
    }),
  }),
  wrap(async (req, res) => {
    const moduleId = req.params.moduleId as string;
    const organizationId = req.auth!.organizationId!;
    const before = (await moduleStatusFor(organizationId)).find((m) => m.id === moduleId);

    const result = await setModuleOverride(organizationId, moduleId, req.body.enabled, {
      userId: req.auth!.userId,
      reason: req.body.reason ?? null,
    });

    // Switching a module changes what the business can do, so it is recorded
    // with who did it and why.
    await auditService
      .record({
        action: 'organization.module_changed',
        entityType: 'ORGANIZATION',
        entityId: organizationId,
        before: { module: moduleId, enabled: before?.enabled, source: before?.source },
        after: { module: moduleId, enabled: result.enabled, source: result.source },
        reason: req.body.reason ?? null,
      })
      .catch(() => {});

    res.json({ success: true, data: result });
  }),
);
