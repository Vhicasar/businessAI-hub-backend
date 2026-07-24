import type { RequestHandler } from 'express';
import { UnauthorizedError, ForbiddenError } from '../../../shared/errors';
import { requestContext } from '../../../shared/context';
import { apiKeysService } from '../../../application/api-keys/api-keys.service';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      apiKey?: { keyId: string; organizationId: string; scopes: string[] };
    }
  }
}

/**
 * Authenticates a public-API request with an API key (`Authorization: Bearer
 * bh_live_…` or `X-API-Key`). Resolves the key to its org, binds the tenant
 * context so tenant-scoped services auto-scope, and attaches scopes for
 * requireScope() to enforce.
 */
export const apiKeyAuth: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization;
  const raw = header?.startsWith('Bearer ')
    ? header.slice(7)
    : (req.headers['x-api-key'] as string | undefined);
  if (!raw) {
    next(new UnauthorizedError('Provide an API key (Authorization: Bearer, or X-API-Key)'));
    return;
  }
  apiKeysService
    .authenticate(raw)
    .then((ctx) => {
      if (!ctx) {
        next(new UnauthorizedError('Invalid, expired, or revoked API key'));
        return;
      }
      req.apiKey = ctx;
      req.auth = {
        userId: `apikey:${ctx.keyId}`,
        organizationId: ctx.organizationId,
        membershipId: null,
        roleId: null,
        isSuperAdmin: false,
      };
      requestContext.assign({ organizationId: ctx.organizationId, userId: `apikey:${ctx.keyId}` });
      next();
    })
    .catch(next);
};

/** Requires a specific scope on the authenticating key. */
export const requireScope =
  (scope: string): RequestHandler =>
  (req, _res, next) => {
    if (!req.apiKey?.scopes.includes(scope)) {
      next(new ForbiddenError(`This API key is missing the required scope: ${scope}`));
      return;
    }
    next();
  };
