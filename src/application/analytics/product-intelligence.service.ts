import { prisma } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { NotFoundError } from '../../shared/errors';
import { getAiProvider } from '../../infrastructure/ai';
import { logger } from '../../shared/logger';
import type { DateRange } from '../../shared/date-range';

/**
 * Product Intelligence (spec #6): a per-product analytics dashboard computed
 * from real order, cart and inventory data. Sections the data model can back —
 * sales, customer analysis, cart behaviour and inventory — are computed
 * directly; behaviour metrics with no backing store (page views, searches,
 * wishlist) are reported as untracked rather than fabricated. A heuristic health
 * score summarizes the product's commercial + stock position; `productInsights`
 * layers AI recommendations on top.
 *
 * Tenant isolation: everything is keyed off the product's own variants, which
 * belong to the caller's organization, so child rows (order items, cart items)
 * are inherently scoped even where the row itself carries no organizationId.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (d: unknown) => Number(d ?? 0);

function orgId(): string {
  const id = requestContext.get()?.organizationId;
  if (!id) throw new Error('No tenant in request context');
  return id;
}

/** Orders that count as real demand (exclude cancelled/abandoned states). */
const COUNTED_ORDER_STATUSES = [
  'CONFIRMED', 'PROCESSING', 'PICKING', 'PACKING', 'READY_FOR_DISPATCH',
  'DISPATCHED', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED',
] as const;

export const productIntelligenceService = {
  async productDashboard(productId: string, range: DateRange) {
    const product = await prisma.product.findFirst({
      where: { id: productId, deletedAt: null },
      include: { variants: { select: { id: true, sku: true, name: true, price: true, costPrice: true } } },
    });
    if (!product) throw new NotFoundError('Product');
    const variantIds = product.variants.map((v) => v.id);
    const costByVariant = new Map(product.variants.map((v) => [v.id, v.costPrice != null ? num(v.costPrice) : null]));
    const { from, to, days } = range;

    // ---- Sales -----------------------------------------------------------
    const items = variantIds.length
      ? await prisma.orderItem.findMany({
          where: {
            variantId: { in: variantIds },
            order: { createdAt: { gte: from, lte: to }, status: { in: [...COUNTED_ORDER_STATUSES] } },
          },
          select: {
            variantId: true, quantity: true, total: true, unitPrice: true, returnedQty: true,
            order: {
              select: {
                id: true, customerId: true, createdAt: true,
                shippingAddress: { select: { city: true, country: true } },
              },
            },
          },
        })
      : [];

    let unitsSold = 0;
    let revenue = 0;
    let cost = 0;
    let returnedUnits = 0;
    let knownCost = true;
    const orderIds = new Set<string>();
    const customerRevenue = new Map<string, number>();
    const customerOrders = new Map<string, Set<string>>();
    const locations = new Map<string, number>();

    for (const it of items) {
      const qty = num(it.quantity);
      const lineTotal = num(it.total);
      const ret = num(it.returnedQty);
      unitsSold += qty;
      revenue += lineTotal;
      returnedUnits += ret;
      const c = costByVariant.get(it.variantId);
      if (c == null) knownCost = false;
      else cost += c * qty;
      orderIds.add(it.order.id);
      if (it.order.customerId) {
        customerRevenue.set(it.order.customerId, (customerRevenue.get(it.order.customerId) ?? 0) + lineTotal);
        const set = customerOrders.get(it.order.customerId) ?? new Set<string>();
        set.add(it.order.id);
        customerOrders.set(it.order.customerId, set);
      }
      const loc = [it.order.shippingAddress?.city, it.order.shippingAddress?.country].filter(Boolean).join(', ');
      if (loc) locations.set(loc, (locations.get(loc) ?? 0) + qty);
    }

    const profit = knownCost ? round2(revenue - cost) : null;
    const grossMargin = knownCost && revenue > 0 ? round2(((revenue - cost) / revenue) * 100) : null;
    const avgSellingPrice = unitsSold > 0 ? round2(revenue / unitsSold) : 0;

    // ---- Customer analysis ----------------------------------------------
    const buyerIds = [...customerRevenue.keys()];
    const repeatBuyers = [...customerOrders.values()].filter((s) => s.size > 1).length;
    const topCustomerIds = [...customerRevenue.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const customerNames = topCustomerIds.length
      ? await prisma.customer.findMany({
          where: { id: { in: topCustomerIds.map(([id]) => id) } },
          select: { id: true, firstName: true, lastName: true },
        })
      : [];
    const nameById = new Map(customerNames.map((c) => [c.id, `${c.firstName} ${c.lastName ?? ''}`.trim()]));
    const topCustomers = topCustomerIds.map(([id, rev]) => ({ id, name: nameById.get(id) ?? 'Unknown', revenue: round2(rev), orders: customerOrders.get(id)?.size ?? 0 }));

    // ---- Behaviour (cart-backed; views/searches/wishlist not tracked) ----
    const cartItems = variantIds.length
      ? await prisma.cartItem.findMany({
          where: { variantId: { in: variantIds }, cart: { createdAt: { gte: from, lte: to } } },
          select: { quantity: true, cart: { select: { status: true } } },
        })
      : [];
    let cartAdditions = 0;
    let convertedCarts = 0;
    let abandonedCarts = 0;
    for (const ci of cartItems) {
      cartAdditions += num(ci.quantity);
      if (ci.cart.status === 'CONVERTED') convertedCarts += 1;
      else if (ci.cart.status === 'ABANDONED') abandonedCarts += 1;
    }
    const cartsSeen = convertedCarts + abandonedCarts;
    const checkoutConversionRate = cartsSeen > 0 ? round2((convertedCarts / cartsSeen) * 100) : null;

    // ---- Inventory -------------------------------------------------------
    const [stockLevels, movements] = await Promise.all([
      variantIds.length
        ? prisma.stockLevel.findMany({
            where: { variantId: { in: variantIds } },
            select: { quantity: true, reserved: true, reorderPoint: true, warehouse: { select: { id: true, name: true } } },
          })
        : [],
      variantIds.length
        ? prisma.stockMovement.findMany({
            where: { variantId: { in: variantIds }, createdAt: { gte: from, lte: to } },
            select: { type: true, quantity: true },
          })
        : [],
    ]);

    const byWarehouseMap = new Map<string, { name: string; quantity: number }>();
    let onHand = 0;
    let reorderNeeded = false;
    for (const sl of stockLevels) {
      const q = num(sl.quantity);
      onHand += q;
      if (sl.reorderPoint != null && q <= num(sl.reorderPoint)) reorderNeeded = true;
      const row = byWarehouseMap.get(sl.warehouse.id) ?? { name: sl.warehouse.name, quantity: 0 };
      row.quantity += q;
      byWarehouseMap.set(sl.warehouse.id, row);
    }
    let movementIn = 0;
    let movementOut = 0;
    let restockEvents = 0;
    for (const m of movements) {
      const q = num(m.quantity);
      if (q >= 0) movementIn += q; else movementOut += Math.abs(q);
      if (m.type === 'PURCHASE_RECEIPT' || m.type === 'PRODUCTION') restockEvents += 1;
    }
    const dailyVelocity = days > 0 ? round2(unitsSold / days) : 0;
    const daysOfCover = dailyVelocity > 0 ? Math.round(onHand / dailyVelocity) : null;
    const movementClass: 'fast' | 'normal' | 'slow' | 'dead' =
      unitsSold === 0 ? (onHand > 0 ? 'dead' : 'slow')
        : daysOfCover != null && daysOfCover < 14 ? 'fast'
        : daysOfCover != null && daysOfCover > 120 ? 'slow'
        : 'normal';

    // ---- Health score (heuristic 0-100) ---------------------------------
    const returnRate = unitsSold > 0 ? (returnedUnits / unitsSold) * 100 : 0;
    const healthScore = computeHealthScore({ grossMargin, unitsSold, returnRate, movementClass, reorderNeeded });

    return {
      product: {
        id: product.id, name: product.name, status: product.status,
        variantCount: product.variants.length,
      },
      period: { days: range.days, from: from.toISOString(), to: to.toISOString(), preset: range.preset },
      sales: {
        totalOrders: orderIds.size,
        unitsSold: round2(unitsSold),
        revenue: round2(revenue),
        cost: knownCost ? round2(cost) : null,
        profit,
        grossMargin,
        avgSellingPrice,
        returnedUnits: round2(returnedUnits),
        returnRate: round2(returnRate),
      },
      customers: {
        uniqueBuyers: buyerIds.length,
        repeatBuyers,
        newBuyers: Math.max(0, buyerIds.length - repeatBuyers),
        topCustomers,
        locations: [...locations.entries()].map(([location, units]) => ({ location, units: round2(units) }))
          .sort((a, b) => b.units - a.units).slice(0, 8),
      },
      behavior: {
        cartAdditions: round2(cartAdditions),
        abandonedCarts,
        convertedCarts,
        checkoutConversionRate,
        // No backing store yet — surfaced as untracked so the UI can label them.
        tracked: { cart: true, views: false, searches: false, wishlist: false },
      },
      inventory: {
        onHand: round2(onHand),
        byWarehouse: [...byWarehouseMap.values()].map((w) => ({ ...w, quantity: round2(w.quantity) })),
        movementIn: round2(movementIn),
        movementOut: round2(movementOut),
        restockEvents,
        dailyVelocity,
        daysOfCover,
        movementClass,
        reorderNeeded,
      },
      healthScore,
    };
  },

  /**
   * AI insights layered on the computed dashboard (spec #6): demand forecast,
   * restocking + pricing recommendations, profitability note and a health
   * summary. Best-effort — when AI is unavailable it returns heuristic
   * fallbacks so the panel always has something actionable.
   */
  async productInsights(productId: string, range: DateRange) {
    const dash = await this.productDashboard(productId, range);
    const heuristics = heuristicInsights(dash);

    const provider = getAiProvider();
    if (!provider) return { source: 'heuristic' as const, ...heuristics };

    try {
      const raw = await provider.complete(
        [
          {
            role: 'system',
            content:
              'You are a retail merchandising analyst. Given a product\'s metrics, return STRICT JSON with keys: ' +
              'demandForecast (string), restocking (string), pricing (string), profitability (string), summary (string). ' +
              'Each value is one concise sentence, concrete and actionable. No markdown, no extra keys.',
          },
          { role: 'user', content: JSON.stringify({ product: dash.product.name, ...dash.sales, ...dash.inventory, healthScore: dash.healthScore, days: dash.period.days }) },
        ],
        { maxTokens: 400, temperature: 0.4 },
      );
      const parsed = JSON.parse(extractJson(raw)) as Record<string, string>;
      return {
        source: 'ai' as const,
        healthScore: dash.healthScore,
        demandForecast: parsed.demandForecast || heuristics.demandForecast,
        restocking: parsed.restocking || heuristics.restocking,
        pricing: parsed.pricing || heuristics.pricing,
        profitability: parsed.profitability || heuristics.profitability,
        summary: parsed.summary || heuristics.summary,
      };
    } catch (err) {
      logger.info({ err: (err as Error).message, productId }, 'AI product insights fell back to heuristics');
      return { source: 'heuristic' as const, ...heuristics };
    }
  },
};

function computeHealthScore(input: {
  grossMargin: number | null; unitsSold: number; returnRate: number;
  movementClass: 'fast' | 'normal' | 'slow' | 'dead'; reorderNeeded: boolean;
}): number {
  let score = 50;
  if (input.grossMargin != null) score += Math.max(-20, Math.min(25, (input.grossMargin - 30) * 0.8));
  if (input.unitsSold > 0) score += 10;
  score -= Math.min(20, input.returnRate); // each % of returns costs a point, capped
  score += { fast: 15, normal: 5, slow: -10, dead: -20 }[input.movementClass];
  if (input.reorderNeeded) score -= 8;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function heuristicInsights(dash: Awaited<ReturnType<typeof productIntelligenceService.productDashboard>>) {
  const { sales, inventory } = dash;
  const demandForecast =
    inventory.dailyVelocity > 0
      ? `Selling ~${inventory.dailyVelocity}/day; expect ~${Math.round(inventory.dailyVelocity * 30)} units next 30 days.`
      : 'No recent sales — demand is currently flat.';
  const restocking =
    inventory.daysOfCover != null && inventory.daysOfCover < 21
      ? `Only ~${inventory.daysOfCover} days of cover left — reorder soon.`
      : inventory.movementClass === 'dead'
        ? 'Overstocked with no sales — pause restocking and consider clearing stock.'
        : 'Stock cover looks adequate for current demand.';
  const pricing =
    sales.grossMargin == null
      ? 'Set a cost price on the variants to unlock margin-based pricing guidance.'
      : sales.grossMargin < 20
        ? `Thin ${sales.grossMargin}% margin — consider a price increase or cost reduction.`
        : `Healthy ${sales.grossMargin}% margin; room to run promotions if velocity dips.`;
  const profitability =
    sales.profit == null ? 'Profit unavailable without variant cost prices.'
      : `${sales.profit >= 0 ? 'Profitable' : 'Loss-making'} at ${sales.profit} over the period on ${sales.unitsSold} units.`;
  const summary = `Health score ${dash.healthScore}/100 · ${inventory.movementClass}-moving · ${sales.totalOrders} orders.`;
  return { healthScore: dash.healthScore, demandForecast, restocking, pricing, profitability, summary };
}

/** Pull the first JSON object out of a model response that may wrap it in prose/fences. */
function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) return fenced[1].trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  return start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
}
