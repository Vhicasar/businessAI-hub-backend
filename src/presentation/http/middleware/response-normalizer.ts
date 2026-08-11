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

/**
 * Fields that genuinely hold a collection.
 *
 * Taken from the schema's actual list fields (`String[]` scalars and relation
 * lists) plus the handful of composed collections the API builds in its
 * responses. Adding to it is safe; adding something that is *not* a list is
 * exactly the mistake this replaced.
 */
const COLLECTION_FIELDS = new Set<string>([
  // Scalar lists.
  'countries', 'currencies', 'dashboardWidgets', 'daysOfWeek', 'eligibleCategories',
  'eligibleCountries', 'eligibleOrganizationIds', 'favouriteCategories', 'paymentPriority',
  'pinnedWidgets', 'services', 'tags', 'trustedDeviceIds', 'aiTags', 'chargeCurrencies',
  // Relation lists.
  'accounts', 'addOnPurchases', 'addresses', 'apiKeys', 'applicants', 'articles',
  'assetAssignments', 'assignments', 'attachments', 'attempts', 'attendance', 'balances',
  'billingRecords', 'bookings', 'branches', 'bundleItems', 'bundles', 'businessQrs', 'calls',
  'campaigns', 'cartItems', 'carts', 'changes', 'chargebacks', 'children', 'chunks',
  'commissions', 'contacts', 'contracts', 'conversations', 'couponRedemptions', 'customerLinks',
  'customers', 'deals', 'departments', 'deviceTokens', 'devices', 'enrollments', 'entries',
  'events', 'expenseClaims', 'goals', 'grants', 'identities', 'images', 'interviews',
  'invitations', 'invoices', 'items', 'kycSubmissions', 'leads', 'leases', 'leaveBalances',
  'leaveRequests', 'links', 'maintenance', 'maintenanceRequests', 'media', 'members',
  'memberships', 'messageAttachments', 'messages', 'movements', 'notifications', 'orderItems',
  'orders', 'overrides', 'ownedProperties', 'pages', 'payComponents', 'paymentIntents',
  'paymentSessions', 'payments', 'payoutAccounts', 'payouts', 'payslips', 'permissions',
  'priceListItems', 'productImages', 'products', 'propertyBookings', 'propertyMedia',
  'purchaseOrderItems', 'purchaseOrders', 'quotationItems', 'quotations', 'receipts',
  'recipients', 'redemptions', 'referralsGiven', 'referralsReceived', 'refreshTokens',
  'refunds', 'replies', 'requests', 'returnItems', 'returnRequests', 'reviews', 'roles',
  'scans', 'securityTokens', 'settlementAccounts', 'settlementRules', 'settlements',
  'shiftAssignments', 'shifts', 'shipments', 'stages', 'statusHistory', 'stockLevels',
  'stockMovements', 'subscriptions', 'suppliers', 'teamMemberships', 'teams', 'tickets',
  'transactions', 'transferItems', 'transfersFrom', 'transfersTo', 'usageCounters',
  'variants', 'virtualAccounts', 'wallets', 'warehouses',
  // Built in responses rather than stored.
  'methods', 'available', 'all', 'slots', 'results', 'rows', 'lines', 'columns',
]);

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
          // Null collections become empty arrays, so a client that maps over
          // them renders an empty state instead of crashing.
          //
          // Matched against a list of fields that really are collections, NOT
          // against the shape of the name. Guessing from a trailing "s" turned
          // every nullable scalar ending in one into an array — `notes` became
          // `[]`, and so did `bedrooms`, `weightGrams`, `paymentTerms` and
          // `address`. A document that printed `notes` then threw, and a
          // property with no bedrooms reported a list of them.
          for (const [key, value] of Object.entries(inner)) {
            if (value === null && COLLECTION_FIELDS.has(key)) inner[key] = [];
          }
        }
      }
    }
    return original(body);
  };

  next();
};
