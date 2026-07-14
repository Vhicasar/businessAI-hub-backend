import type { RequestHandler } from 'express';
import { UnauthorizedError } from '../../../shared/errors';
import { requestContext } from '../../../shared/context';
import { tokenService } from '../../../application/auth/token.service';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: {
        userId: string;
        organizationId: string | null;
        membershipId: string | null;
        roleId: string | null;
        isSuperAdmin: boolean;
      };
    }
  }
}

/**
 * Verifies the Bearer access token, attaches req.auth, and binds the tenant
 * to the request context so the Prisma extension auto-scopes all queries.
 */
export const authenticate: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    next(new UnauthorizedError());
    return;
  }
  const payload = tokenService.verifyAccessToken(header.slice(7));

  req.auth = {
    userId: payload.sub,
    organizationId: payload.org,
    membershipId: payload.mem,
    roleId: payload.role,
    isSuperAdmin: payload.sa,
  };

  requestContext.assign({
    userId: payload.sub,
    organizationId: payload.org ?? undefined,
    membershipId: payload.mem ?? undefined,
    roleId: payload.role ?? undefined,
    isSuperAdmin: payload.sa,
  });

  next();
};

/** Requires an active organization on the token (most business routes). */
export const requireTenant: RequestHandler = (req, _res, next) => {
  if (!req.auth?.organizationId) {
    next(new UnauthorizedError('No active organization on this session', 'NO_ORGANIZATION'));
    return;
  }
  next();
};
