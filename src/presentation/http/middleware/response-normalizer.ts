import type { RequestHandler } from 'express';

/**
 * Guarantees the response envelope never carries a null collection (§11).
 *
 * A client that does `data.items.map(...)` crashes on `null` but renders an
 * empty state on `[]`. Rather than auditing every handler forever, this
 * normalises on the way out: null/undefined `data` becomes `[]` when the route
 * looks like a collection, and a paginated shape always carries `items` and
 * `pagination`.
 *
 * It only ever *fills in* missing structure — it never rewrites real data.
 */

/** Route suffixes whose `data` should be a list when nothing was returned. */
const COLLECTION_HINT = /\/(list|search|history|records|transactions|items|alerts|deliveries|accounts|payouts|bookings|promotions|businesses|rules|campaigns|submissions|grants|devices|banks)(\/)?$/i;

interface Envelope {
  success?: boolean;
  data?: unknown;
  pagination?: unknown;
  [key: string]: unknown;
}

export const normalizeResponse: RequestHandler = (req, res, next) => {
  const original = res.json.bind(res);

  res.json = (body: unknown) => {
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const envelope = body as Envelope;

      if ('success' in envelope && envelope.success !== false) {
        // A collection route that produced nothing still returns an array.
        if (envelope.data == null && COLLECTION_HINT.test(req.path)) {
          envelope.data = [];
        }

        const data = envelope.data;
        if (data && typeof data === 'object' && !Array.isArray(data)) {
          const inner = data as Record<string, unknown>;
          // Paginated shapes always expose both keys, so clients can rely on them.
          if ('items' in inner) {
            if (inner.items == null) inner.items = [];
            if (!('pagination' in inner) && !('nextCursor' in inner)) {
              inner.pagination = {};
            }
          }
          // Any other null array-ish field becomes an empty array rather than
          // null, which is what actually breaks list rendering.
          for (const [key, value] of Object.entries(inner)) {
            if (value === null && /(s|List|Items)$/.test(key)) inner[key] = [];
          }
        }
      }
    }
    return original(body);
  };

  next();
};
