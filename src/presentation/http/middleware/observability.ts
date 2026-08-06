import type { RequestHandler } from 'express';
import { metrics } from '../../../shared/metrics';

/**
 * Per-request telemetry (Part I §14, API Bible §16). Records method, a *route
 * template* (never the raw path — ids would explode cardinality), status and
 * duration.
 */
export const httpMetrics: RequestHandler = (req, res, next) => {
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    // req.route is only populated after routing; fall back to a coarse prefix
    // so unmatched paths still aggregate sensibly.
    const route = (req.route?.path as string | undefined)
      ? `${req.baseUrl ?? ''}${req.route.path}`
      : coarsePath(req.path);
    const labels = { method: req.method, route, status: String(res.statusCode) };
    metrics.httpRequests.inc(labels);
    metrics.httpDuration.observe(durationMs, { method: req.method, route });
    if (res.statusCode >= 500) metrics.httpErrors.inc({ route });
  });
  next();
};

/** Collapse ids so /api/v1/customers/abc123 becomes /api/v1/customers/:id. */
function coarsePath(path: string): string {
  return path
    .split('/')
    .map((seg) => (/^[a-z0-9]{16,}$/i.test(seg) || /^\d+$/.test(seg) ? ':id' : seg))
    .join('/');
}
