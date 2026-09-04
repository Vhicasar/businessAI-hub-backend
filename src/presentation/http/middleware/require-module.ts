import type { RequestHandler } from 'express';
import { AppError, ForbiddenError } from '../../../shared/errors';
import { hasModule, moduleDefinition } from '../../../application/modules/business-modules';

/**
 * Blocks the request unless this business may use the module.
 *
 * Sits alongside `requirePermission` rather than replacing it: they answer
 * different questions and both have to pass. A permission says whether this
 * person may do the thing; a module says whether this business has the thing
 * at all. A production manager at an estate agency has neither.
 *
 * Enforced here and not only in the menu, because the menu is a suggestion and
 * the URL is not.
 */
export function requireModule(moduleId: string): RequestHandler {
  return (req, _res, next) => {
    const orgId = req.auth?.organizationId;
    if (!orgId) {
      next(new ForbiddenError());
      return;
    }
    hasModule(orgId, moduleId)
      .then((allowed) => {
        if (allowed) {
          next();
          return;
        }
        const definition = moduleDefinition(moduleId);
        next(
          new AppError(
            'MODULE_NOT_AVAILABLE',
            403,
            definition
              ? `${definition.label} is not available for this business.`
              : 'That part of the product is not available for this business.',
            { module: moduleId },
          ),
        );
      })
      .catch(next);
  };
}
