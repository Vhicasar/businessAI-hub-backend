import type { RequestHandler } from 'express';
import type { ZodTypeAny } from 'zod';

/** Validates and replaces req.body / req.query / req.params with parsed data. */
export function validate(schemas: {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}): RequestHandler {
  return (req, _res, next) => {
    try {
      if (schemas.body) req.body = schemas.body.parse(req.body);
      if (schemas.query) req.query = schemas.query.parse(req.query) as typeof req.query;
      if (schemas.params) req.params = schemas.params.parse(req.params) as typeof req.params;
      next();
    } catch (e) {
      next(e); // ZodError → error handler
    }
  };
}
