import type { RequestHandler } from 'express';
import { Prisma } from '@prisma/client';
import { prismaUnscoped } from '../../../infrastructure/database/prisma';
import { AppError } from '../../../shared/errors';

/**
 * Idempotency for state-changing requests (API Bible §10). When the client
 * sends an `Idempotency-Key` header, the first request runs and its response is
 * stored; any retry with the same key + scope replays the stored response
 * instead of repeating the operation (e.g. a double-tapped wallet transfer).
 *
 * Scope is per authenticated subject so keys can't collide or leak across users.
 * Apply to POSTs that move money or create resources.
 */
export const idempotency: RequestHandler = async (req, res, next) => {
  const key = req.header('Idempotency-Key');
  if (!key) {
    next();
    return;
  }
  const scope = req.auth?.organizationId
    ? `org:${req.auth.organizationId}`
    : req.appAuth?.vhicasarId
      ? `app:${req.appAuth.vhicasarId}`
      : 'anon';

  try {
    await prismaUnscoped.idempotencyKey.create({
      data: { scope, key, method: req.method, path: req.path, status: 'IN_PROGRESS' },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const existing = await prismaUnscoped.idempotencyKey.findUnique({
        where: { scope_key: { scope, key } },
      });
      if (existing?.status === 'COMPLETED' && existing.responseCode) {
        res.status(existing.responseCode).json(existing.responseBody);
        return;
      }
      next(new AppError('DUPLICATE_REQUEST', 409, 'A request with this Idempotency-Key is already in progress'));
      return;
    }
    next(e as Error);
    return;
  }

  // Capture the response body so a later retry can replay it.
  const originalJson = res.json.bind(res);
  res.json = (body: unknown) => {
    void prismaUnscoped.idempotencyKey
      .updateMany({
        where: { scope, key },
        data: { status: 'COMPLETED', responseCode: res.statusCode, responseBody: body as Prisma.InputJsonValue },
      })
      .catch(() => undefined);
    return originalJson(body);
  };
  next();
};
