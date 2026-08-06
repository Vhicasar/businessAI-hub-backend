import type { RequestHandler } from 'express';
import { randomUUID } from 'crypto';
import { requestContext } from '../../../shared/context';

/**
 * Opens a fresh AsyncLocalStorage scope per request and tags it with a request
 * id plus a correlation id. The correlation id is echoed back and propagated to
 * domain events and outbound calls, so one user action is traceable across every
 * hop (API Bible §5/§16).
 */
export const requestContextMiddleware: RequestHandler = (req, res, next) => {
  const requestId = (req.headers['x-request-id'] as string) || randomUUID();
  const correlationId = (req.headers['x-correlation-id'] as string) || requestId;
  res.setHeader('x-request-id', requestId);
  res.setHeader('x-correlation-id', correlationId);
  requestContext.run({ requestId, correlationId }, () => next());
};
