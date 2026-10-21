import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { exchangeRates } from '../../shared/exchange-rates';
import { logger } from '../../shared/logger';

/**
 * What a website's shopping cart is actually allowed to contain.
 *
 * The cart lives in the visitor's browser, which makes everything in it a
 * claim rather than a fact: the price, the quantity and whether the product
 * still exists are all things the page was told once and may since have been
 * edited, sold out, or tampered with. This service is where those claims are
 * checked against the database, and it is the only authority the cart has.
 *
 * Two jobs, both read-only:
 *
 *  - Price and stock for the things in the cart, so the cart can show a real
 *    subtotal and stop at the real stock ceiling rather than letting someone
 *    order six of something there is one of.
 *  - Whether an order has been paid, so the tab the customer shopped in can
 *    find out and empty itself — the payment happens on another origin, where
 *    no cross-tab message can reach back.
 *
 * Nothing here reserves, holds or changes anything. The authoritative check
 * still happens when the order is created, inside a transaction, because stock
 * can change between validating a cart and paying for it. This stops the
 * common case politely; `ordersService.create` stops the rest.
 */

export interface CartLineState {
  variantId: string;
  /** Null when the product no longer exists or can no longer be sold. */
  name: string | null;
  sku: string | null;
  unitPrice: number;
  currency: string;
  /** Units a customer may have in the cart. 0 means it cannot be ordered. */
  available: number;
  imageUrl: string | null;
  /** Why this line cannot be ordered, in words a customer can act on. */
  unavailableReason: string | null;
}

/**
 * Price and availability for a set of variants.
 *
 * Unknown ids are returned as unavailable lines rather than dropped: a cart
 * that silently loses a row leaves the customer wondering what happened to it.
 */
export async function cartState(
  organizationId: string,
  variantIds: string[],
): Promise<CartLineState[]> {
  const ids = [...new Set(variantIds.filter((id) => typeof id === 'string' && id.length > 0))].slice(0, 100);
  if (ids.length === 0) return [];

  const [variants, organization, warehouse] = await Promise.all([
    prismaUnscoped.productVariant.findMany({
      where: { id: { in: ids }, deletedAt: null, product: { organizationId } },
      select: {
        id: true, sku: true, name: true, price: true, currency: true, isActive: true,
        product: {
          select: {
            name: true, status: true, sellable: true, manufacturingType: true, deletedAt: true,
            images: { orderBy: { position: 'asc' }, take: 1, select: { file: { select: { id: true } } } },
          },
        },
      },
    }),
    prismaUnscoped.organization.findUnique({ where: { id: organizationId }, select: { currency: true } }),
    // The warehouse a website order is reserved against — the same one
    // `ordersService.create` defaults to, or the cart would quote a ceiling
    // from one place and the order would be taken from another.
    prismaUnscoped.warehouse.findFirst({
      where: { organizationId, deletedAt: null, isActive: true },
      orderBy: { isDefault: 'desc' },
      select: { id: true },
    }),
  ]);

  const levels = warehouse
    ? await prismaUnscoped.stockLevel.findMany({
        where: { warehouseId: warehouse.id, variantId: { in: ids } },
        select: { variantId: true, quantity: true, reserved: true },
      })
    : [];
  const stock = new Map(levels.map((level) => [
    level.variantId,
    Math.max(0, Number(level.quantity) - Number(level.reserved)),
  ]));

  const currency = organization?.currency ?? 'USD';
  const { filesService } = await import('../files/files.service');

  return Promise.all(ids.map(async (variantId): Promise<CartLineState> => {
    const variant = variants.find((entry) => entry.id === variantId);
    if (!variant || variant.product.deletedAt) {
      return {
        variantId, name: null, sku: null, unitPrice: 0, currency, available: 0, imageUrl: null,
        unavailableReason: 'This product is no longer available.',
      };
    }
    const sellable = variant.isActive
      && variant.product.status === 'ACTIVE'
      && variant.product.sellable
      && variant.product.manufacturingType !== 'RAW_MATERIAL';
    const name = variant.name ? `${variant.product.name} — ${variant.name}` : variant.product.name;

    // Priced on this side, in the business's own currency, exactly as the
    // order will be. A price that travelled through the browser is a
    // suggestion.
    let unitPrice = Number(variant.price);
    if (variant.currency !== currency) {
      try {
        unitPrice = (await exchangeRates.convert(Number(variant.price), variant.currency, currency)).amount;
      } catch (err) {
        logger.warn({ err: (err as Error).message, variantId }, 'Could not convert cart price — quoting catalog currency');
      }
    }

    const available = sellable ? (stock.get(variantId) ?? 0) : 0;
    return {
      variantId,
      name,
      sku: variant.sku,
      unitPrice: Math.round(unitPrice * 100) / 100,
      currency,
      available,
      imageUrl: await filesService.urlFor(variant.product.images[0]?.file.id).catch(() => null),
      unavailableReason: !sellable
        ? 'This product is no longer on sale.'
        : available <= 0 ? 'This product is out of stock.' : null,
    };
  }));
}

/**
 * Whether a website order has been paid for.
 *
 * Deliberately the narrowest possible answer. The cart tab needs one bit —
 * may I empty myself? — and anything more would make an order id, which is all
 * a caller has to present, into a way of reading someone's order. The id is an
 * unguessable cuid, the order must belong to a published site's business, and
 * nothing but the payment state comes back.
 */
export async function orderPaymentState(
  organizationId: string,
  orderId: string,
): Promise<{ paid: boolean; cancelled: boolean } | null> {
  if (!orderId || orderId.length > 64) return null;
  const order = await prismaUnscoped.order.findFirst({
    where: { id: orderId, organizationId },
    select: { paymentStatus: true, status: true },
  });
  if (!order) return null;
  return {
    paid: order.paymentStatus === 'PAID' || order.paymentStatus === 'PARTIALLY_PAID',
    cancelled: order.status === 'CANCELLED',
  };
}
