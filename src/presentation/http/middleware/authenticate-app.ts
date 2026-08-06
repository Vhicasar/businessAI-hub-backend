import type { RequestHandler } from 'express';
import { UnauthorizedError } from '../../../shared/errors';
import { identityTokenService } from '../../../application/identity/identity-token.service';
import { prismaUnscoped } from '../../../infrastructure/database/prisma';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      appAuth?: {
        vhicasarId: string;
        deviceId?: string;
      };
    }
  }
}

/**
 * Authenticates a Customer Super App request from its `app`-scoped access token.
 * Attaches req.appAuth. Deliberately sets NO org tenant context — the Vhicasar
 * ID is cross-tenant; per-business data is reached only through CustomerLink.
 */
export const authenticateApp: RequestHandler = async (req, _res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      next(new UnauthorizedError());
      return;
    }
    const payload = identityTokenService.verifyAppToken(header.slice(7));
    const identity = await prismaUnscoped.vhicasarId.findUnique({
      where: { id: payload.sub },
      select: { status: true, deletedAt: true },
    });
    if (!identity || identity.deletedAt) {
      next(new UnauthorizedError('Account not found', 'ACCOUNT_INACTIVE'));
      return;
    }
    if (identity.status !== 'ACTIVE') {
      next(new UnauthorizedError('Account is not active', 'ACCOUNT_INACTIVE'));
      return;
    }
    req.appAuth = { vhicasarId: payload.sub, deviceId: payload.did };
    next();
  } catch (e) {
    next(e);
  }
};
