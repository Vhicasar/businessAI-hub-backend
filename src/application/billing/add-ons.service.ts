import { z } from 'zod';
import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { getActivePaymentProvider, getChargeCurrencies } from '../../infrastructure/payments';
import { AppError, NotFoundError } from '../../shared/errors';
import { exchangeRates } from '../../shared/exchange-rates';
import { currentOrgId } from './entitlements';
import { getSiteCatalog, type CatalogAddOn } from '../catalog/site-catalog.service';
import { ensureFreshPaymentConfig } from './payment-config-sync';
import { PLATFORM_FEATURES, isPlatformFeatureEnabled } from '../settings/platform-features';

/** The add-on that is also a platform switch — see `offerable` below. */
const SUBDOMAIN_ADD_ON = 'website_subdomain';

/**
 * Whether an add-on should be offered for sale at all.
 *
 * Only the website subdomain is conditional, and only because it is the one
 * add-on the platform can also include for free. Offering it while publishing
 * is already free would be selling something the business already has.
 *
 * A workspace that bought it before the switch was turned on still sees it,
 * with its purchase shown as active — hiding it would make a thing they are
 * being billed for disappear from the only page that mentions it.
 */
function offerable(addOnId: string, hasActivePurchase: boolean): boolean {
  if (addOnId !== SUBDOMAIN_ADD_ON) return true;
  if (hasActivePurchase) return true;
  return !isPlatformFeatureEnabled(PLATFORM_FEATURES.freePlanWebsiteSubdomain);
}

export const addOnCheckoutSchema = z.object({ addOnId: z.string().min(1) });

async function billingEmail(orgId: string): Promise<string> {
  const owner = await prismaUnscoped.membership.findFirst({
    where: { organizationId: orgId, isOwner: true, isActive: true },
    include: { user: { select: { email: true } } },
  });
  if (owner?.user.email) return owner.user.email;
  const org = await prismaUnscoped.organization.findUnique({ where: { id: orgId }, select: { email: true } });
  if (org?.email) return org.email;
  throw new AppError('NO_BILLING_EMAIL', 400, 'No billing email found for this organization.');
}

async function priced(addOn: CatalogAddOn, currency: string) {
  const exact = addOn.prices[currency]?.amount;
  if (exact !== undefined) return { amount: exact, currency };
  const first = Object.entries(addOn.prices)[0];
  if (!first) throw new AppError('ADD_ON_PRICE_MISSING', 400, 'This add-on has no configured price.');
  const converted = await exchangeRates.convert(first[1].amount, first[0], currency, { forCharge: true });
  return { amount: converted.amount, currency: converted.currency };
}

export const addOnsService = {
  async list() {
    const organizationId = currentOrgId();
    const [catalog, org, purchases] = await Promise.all([
      getSiteCatalog(),
      prismaUnscoped.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { currency: true } }),
      prismaUnscoped.addOnPurchase.findMany({
        where: { organizationId, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        orderBy: { purchasedAt: 'desc' },
      }),
    ]);
    const offered = catalog.addOns.filter((item) => item.enabled
      && offerable(item.id, purchases.some((purchase) => purchase.addOnId === item.id)));
    return Promise.all(offered.map(async (item) => ({
      ...item,
      price: await priced(item, org.currency),
      activePurchases: purchases.filter((purchase) => purchase.addOnId === item.id).map((purchase) => ({
        id: purchase.id, purchasedAt: purchase.purchasedAt, expiresAt: purchase.expiresAt,
      })),
    })));
  },

  async checkout(addOnId: string) {
    await ensureFreshPaymentConfig();
    const organizationId = currentOrgId();
    const addOn = (await getSiteCatalog(true)).addOns.find((item) => item.id === addOnId && item.enabled);
    if (!addOn) throw new NotFoundError('Add-on');
    const org = await prismaUnscoped.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { currency: true } });
    const active = await prismaUnscoped.addOnPurchase.findFirst({
      where: { organizationId, addOnId, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    });
    if (active) return { activated: true, alreadyActive: true, purchaseId: active.id };
    // Hidden in the list, and refused here too: a stale page or a direct call
    // must not be able to sell something that is already included.
    if (!offerable(addOnId, false)) {
      throw new AppError(
        'ADD_ON_NOT_REQUIRED', 409,
        'Publishing a website to a platform subdomain is already included on this workspace.',
      );
    }
    const price = await priced(addOn, org.currency);
    // Free promotions must never be sent to a payment gateway as a zero-value
    // transaction. Activate the entitlement immediately and keep the same
    // expiry semantics as a paid monthly purchase.
    if (price.amount === 0) {
      const expiresAt = addOn.billingType === 'MONTHLY' ? new Date() : null;
      if (expiresAt) expiresAt.setUTCMonth(expiresAt.getUTCMonth() + 1);
      const purchase = await prismaUnscoped.addOnPurchase.create({
        data: {
          organizationId, addOnId: addOn.id, title: addOn.title,
          billingType: addOn.billingType, amount: 0, currency: price.currency,
          entitlements: addOn.entitlements as object, expiresAt,
        },
      });
      return { activated: true, alreadyActive: false, purchaseId: purchase.id };
    }
    if (!getChargeCurrencies().includes(org.currency)) {
      throw new AppError('PREFERRED_CURRENCY_NOT_SETTLEABLE', 400, `Checkout in ${org.currency} is not enabled.`);
    }
    const provider = getActivePaymentProvider();
    if (!provider.enabled) throw new AppError('PAYMENTS_NOT_CONFIGURED', 503, 'Online payments are not configured.');
    const reference = `addon_${organizationId.slice(0, 8)}_${Date.now().toString(36)}`;
    const init = await provider.initializeTransaction({
      email: await billingEmail(organizationId),
      amount: Math.round(price.amount * 100),
      reference,
      currency: price.currency,
      metadata: { kind: 'add_on', organizationId, addOnId: addOn.id, title: addOn.title, billingType: addOn.billingType, entitlements: addOn.entitlements },
    });
    return { authorizationUrl: init.authorizationUrl, reference, amount: price.amount, currency: price.currency };
  },

  async verify(reference: string) {
    const existing = await prismaUnscoped.addOnPurchase.findUnique({ where: { providerRef: reference } });
    if (existing) return { addOnActivated: true, alreadyProcessed: true };
    const txn = await getActivePaymentProvider().verifyTransaction(reference);
    if (txn.status !== 'success') throw new AppError('PAYMENT_NOT_SUCCESSFUL', 400, `Payment not successful (${txn.status}).`);
    const meta = (txn.metadata ?? {}) as Record<string, unknown>;
    if (meta.kind !== 'add_on') throw new AppError('INVALID_REFERENCE', 400, 'This is not an add-on payment.');
    const billingType = String(meta.billingType ?? 'MONTHLY');
    const expiresAt = new Date();
    if (billingType === 'MONTHLY') expiresAt.setUTCMonth(expiresAt.getUTCMonth() + 1);
    await prismaUnscoped.addOnPurchase.create({
      data: {
        organizationId: String(meta.organizationId), addOnId: String(meta.addOnId), title: String(meta.title),
        billingType, amount: txn.amount / 100, currency: txn.currency,
        entitlements: (meta.entitlements ?? {}) as object, provider: getActivePaymentProvider().name, providerRef: reference,
        expiresAt: billingType === 'MONTHLY' ? expiresAt : null,
      },
    });
    return { addOnActivated: true, alreadyProcessed: false };
  },
};
