import { z } from 'zod';
import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { paystack } from '../../infrastructure/payments/paystack';
import { AppError, NotFoundError } from '../../shared/errors';
import { env } from '../../shared/config/env';
import { exchangeRates } from '../../shared/exchange-rates';
import { currentOrgId } from './entitlements';
import { getSiteCatalog, type CatalogAddOn } from '../catalog/site-catalog.service';

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
    return Promise.all(catalog.addOns.filter((item) => item.enabled).map(async (item) => ({
      ...item,
      price: await priced(item, org.currency),
      activePurchases: purchases.filter((purchase) => purchase.addOnId === item.id).map((purchase) => ({
        id: purchase.id, purchasedAt: purchase.purchasedAt, expiresAt: purchase.expiresAt,
      })),
    })));
  },

  async checkout(addOnId: string) {
    const organizationId = currentOrgId();
    const addOn = (await getSiteCatalog(true)).addOns.find((item) => item.id === addOnId && item.enabled);
    if (!addOn) throw new NotFoundError('Add-on');
    const org = await prismaUnscoped.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { currency: true } });
    if (!env.billing.chargeCurrencies.includes(org.currency)) {
      throw new AppError('PREFERRED_CURRENCY_NOT_SETTLEABLE', 400, `Checkout in ${org.currency} is not enabled.`);
    }
    if (!paystack.enabled) throw new AppError('PAYSTACK_NOT_CONFIGURED', 503, 'Online payments are not configured.');
    const price = await priced(addOn, org.currency);
    const reference = `addon_${organizationId.slice(0, 8)}_${Date.now().toString(36)}`;
    const init = await paystack.initializeTransaction({
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
    const txn = await paystack.verifyTransaction(reference);
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
        entitlements: (meta.entitlements ?? {}) as object, provider: 'paystack', providerRef: reference,
        expiresAt: billingType === 'MONTHLY' ? expiresAt : null,
      },
    });
    return { addOnActivated: true, alreadyProcessed: false };
  },
};
