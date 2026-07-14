import type { RequestHandler } from 'express';
import { randomUUID } from 'crypto';
import { requestContext } from '../../../shared/context';

/** Opens a fresh AsyncLocalStorage scope per request and tags it with an id. */
export const requestContextMiddleware: RequestHandler = (req, res, next) => {
  const requestId = (req.headers['x-request-id'] as string) || randomUUID();
  res.setHeader('x-request-id', requestId);
  requestContext.run({ requestId }, () => next());
};
