/*
 * Checkout, delivery pricing, invoice, receipt and customer profile — end to
 * end, against a real database.
 *
 * The unit tests cover the arithmetic. What this covers is the thing that was
 * actually broken: whether choosing delivery moves the order, the invoice and
 * the amount the gateway will be asked for *together*, and whether a settled
 * payment produces a receipt anyone can actually read.
 *
 *   npx tsx tests/warehouse/checkout-delivery-verify.ts
 */
import { Prisma } from '@prisma/client';
import { prismaUnscoped as db } from '../../src/infrastructure/database/prisma';
import { requestContext } from '../../src/shared/context';
import { checkoutView, chooseFulfilment, blockingCheckoutIssue } from '../../src/application/payments/checkout.service';
import { paymentIntentService } from '../../src/application/payments/payment-intent.service';
import { settlePaymentIntent } from '../../src/application/payments/payment-settlement.service';
import { publicReceipt } from '../../src/application/payments/payment-public.service';
import { sendReceiptEmail, receiptEmailState } from '../../src/application/payments/receipt-email.service';
import { syncCustomerFromCheckout } from '../../src/application/payments/checkout-customer.service';
import { fulfilmentSettingsSchema } from '../../src/application/delivery/fulfilment-settings.service';
import { buildReceiptForIntent, renderReceiptHtml } from '../../src/application/payments/receipt-document.service';

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

const stamp = Date.now();
const ids = { org: '', customer: '', otherOrg: '', otherCustomer: '' };
const made: Record<string, string> = {};

const money = (v: unknown) => Number(v ?? 0);
const near = (a: number, b: number, tolerance = 0.01) => Math.abs(a - b) <= tolerance;

const as = <T>(org: string, fn: () => Promise<T>): Promise<T> =>
  requestContext.run({ requestId: `t-${stamp}`, organizationId: org } as never, fn);

/** Lagos → Ikeja is far enough apart to produce a real distance charge. */
const ORIGIN = { latitude: 6.5244, longitude: 3.3792 };
const DESTINATION = {
  line1: '12 Allen Avenue', line2: '', city: 'Ikeja', state: 'Lagos', country: 'NG', postalCode: '',
};
const FAR_DESTINATION = { ...DESTINATION, line1: '1 Zuma Rock Road', city: 'Abuja' };

async function configure(organizationId: string, overrides: Record<string, unknown> = {}): Promise<void> {
  const fulfilment = fulfilmentSettingsSchema.parse({
    pickup: {
      enabled: true,
      locationName: 'Lagos depot',
      address: { line1: '1 Market Road', city: 'Lagos', country: 'NG' },
      coordinates: ORIGIN,
      instructions: 'Open 9 to 6, Monday to Saturday.',
      fee: 0,
    },
    delivery: {
      enabled: true,
      originSameAsPickup: true,
      pricing: { baseFee: 500, perKm: 100, perKg: 50, minFee: 0, maxFee: null, maxDistanceKm: null, freeOverSubtotal: null },
      missingWeight: 'MANUAL_QUOTE',
      ...((overrides.delivery as Record<string, unknown>) ?? {}),
    },
    ...(overrides.pickup ? { pickup: overrides.pickup } : {}),
  });
  const org = await db.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { settings: true } });
  await db.organization.update({
    where: { id: organizationId },
    data: { settings: { ...((org.settings as Record<string, unknown>) ?? {}), fulfilment } },
  });
}

/** An order, its invoice and a payment link for it — the real shapes. */
async function buildOrder(opts: { weights: (number | null)[]; organizationId?: string; customerId?: string }) {
  const organizationId = opts.organizationId ?? ids.org;
  const customerId = opts.customerId ?? ids.customer;
  const variantIds: string[] = [];
  // Unique per call: several orders are built in one run, and a slug or SKU
  // reused across them collides on the tenant-scoped unique index.
  const batch = Math.random().toString(36).slice(2, 8);

  for (let i = 0; i < opts.weights.length; i++) {
    const product = await db.product.create({
      data: {
        organizationId,
        name: `Test product ${i} ${batch}`,
        slug: `test-${i}-${batch}-${stamp}`,
        status: 'ACTIVE',
        variants: {
          create: {
            organizationId,
            sku: `TST-${i}-${batch}-${stamp}`,
            price: 1000,
            currency: 'NGN',
            isDefault: true,
            weightGrams: opts.weights[i],
          },
        },
      },
      include: { variants: true },
    });
    variantIds.push(product.variants[0]!.id);
  }

  const subtotal = 1000 * 2 * variantIds.length;
  const order = await db.order.create({
    data: {
      organizationId,
      number: `ORD-T-${stamp}-${Math.random().toString(36).slice(2, 6)}`,
      customerId,
      status: 'PENDING',
      source: 'WEB',
      currency: 'NGN',
      subtotal,
      taxTotal: 0,
      shippingTotal: 0,
      discountTotal: 0,
      total: subtotal,
      items: {
        create: variantIds.map((variantId, i) => ({
          variantId,
          name: `Test product ${i}`,
          sku: `TST-${i}-${batch}-${stamp}`,
          quantity: 2,
          unitPrice: 1000,
          taxRate: 0,
          total: 2000,
        })),
      },
    },
  });

  const invoice = await db.invoice.create({
    data: {
      organizationId,
      number: `INV-T-${stamp}-${Math.random().toString(36).slice(2, 6)}`,
      customerId,
      orderId: order.id,
      status: 'SENT',
      currency: 'NGN',
      subtotal,
      taxTotal: 0,
      discountTotal: 0,
      total: subtotal,
      issuedAt: new Date(),
      items: {
        create: variantIds.map((_, i) => ({
          description: `Test product ${i}`,
          quantity: 2,
          unitPrice: 1000,
          taxRate: 0,
          total: 2000,
        })),
      },
    },
  });

  const intent = await as(organizationId, () =>
    paymentIntentService.create({
      organizationId,
      resourceType: 'INVOICE',
      resourceId: invoice.id,
      invoiceId: invoice.id,
      orderId: order.id,
      customerId,
      amount: subtotal,
      currency: 'NGN',
      description: `Order ${order.number}`,
    } as never),
  );

  return { order, invoice, intent, variantIds, subtotal };
}

const CONTACT = { name: 'Adaeze Okonkwo', phone: '08031000101', email: 'adaeze.checkout@example.example' };

async function main(): Promise<void> {
  // ── fixtures ────────────────────────────────────────────────────────────
  const org = await db.organization.create({
    data: { name: `Checkout test ${stamp}`, slug: `checkout-test-${stamp}`, currency: 'NGN', country: 'NG', status: 'ACTIVE' },
  });
  ids.org = org.id;
  const other = await db.organization.create({
    data: { name: `Rival ${stamp}`, slug: `rival-${stamp}`, currency: 'NGN', country: 'NG', status: 'ACTIVE' },
  });
  ids.otherOrg = other.id;
  ids.customer = (await db.customer.create({
    data: { organizationId: org.id, firstName: 'Adaeze', lastName: 'Okonkwo' },
  })).id;
  ids.otherCustomer = (await db.customer.create({
    data: { organizationId: other.id, firstName: 'Rival', lastName: 'Buyer' },
  })).id;
  await configure(org.id);

  // ── 1. What the customer is shown before choosing ───────────────────────
  console.log('\nThe payment page knows what is being bought');
  {
    const built = await buildOrder({ weights: [500, 250] });
    made.base = built.intent.id;
    const view = await checkoutView(built.intent.token!);
    check('the order and its lines are on the page', view.order?.items.length === 2);
    check('with the real subtotal from the order', view.order?.subtotal === 4000);
    check('collection and delivery are both offered', view.fulfilment.pickup.available && view.fulfilment.delivery.available);
    check('the collection address is shown', view.fulfilment.pickup.address.includes('Market Road'));
    check('a choice is required before paying', view.fulfilment.required);
    check('and paying is blocked until one is made',
      (await blockingCheckoutIssue(built.intent.token!))?.includes('Choose') === true);
  }

  // ── 2. Delivery ─────────────────────────────────────────────────────────
  console.log('\nChoosing delivery prices it, and moves everything together');
  let deliveryCase: Awaited<ReturnType<typeof buildOrder>>;
  {
    deliveryCase = await buildOrder({ weights: [500, 250] });
    made.delivery = deliveryCase.intent.id;
    const token = deliveryCase.intent.token!;
    const view = await chooseFulfilment(token, {
      method: 'DELIVERY',
      contact: CONTACT,
      destination: { ...DESTINATION, instructions: 'Blue gate', latitude: 6.6018, longitude: 3.3515 },
    });

    const quote = view.fulfilment.quote!;
    check('a quote comes back priced', quote.priced && quote.outcome === 'OK');
    // 1.5 kg of goods: two items at 500g and 250g, two of each.
    check('the chargeable weight is the sum of line weights', quote.weight.grams === 1500,
      `got ${quote.weight.grams}g`);
    check('the weight charge follows the configured rate', near(quote.fee.weight, 50 * 1.5, 0.02),
      `got ${quote.fee.weight}`);
    check('a distance was measured', (quote.distance.kilometres ?? 0) > 8);
    check('and is labelled an estimate, not a road distance', quote.distance.basis === 'STRAIGHT_LINE');
    check('the total is base plus distance plus weight',
      near(quote.fee.total, quote.fee.base + quote.fee.distance + quote.fee.weight, 0.02));

    const order = await db.order.findUniqueOrThrow({ where: { id: deliveryCase.order.id } });
    check('the order records the method', order.fulfillmentMethod === 'DELIVERY');
    check('the order carries the fee', near(money(order.shippingTotal), quote.fee.total));
    check('the order total includes it', near(money(order.total), deliveryCase.subtotal + quote.fee.total));
    check('the destination is frozen on the order',
      (order.deliverySnapshot as Record<string, string>)?.line1 === DESTINATION.line1);
    check('with the delivery note the customer left',
      (order.deliverySnapshot as Record<string, string>)?.instructions === 'Blue gate');
    check('and the contact details given for this order',
      order.contactName === CONTACT.name && order.contactPhone === CONTACT.phone && order.contactEmail === CONTACT.email);
    check('an address book entry was created for dispatch', Boolean(order.shippingAddressId));

    const invoice = await db.invoice.findFirstOrThrow({
      where: { orderId: deliveryCase.order.id }, include: { items: true },
    });
    check('the invoice total matches the order', near(money(invoice.total), money(order.total)));
    const feeLine = invoice.items.find((i) => i.description === 'Delivery');
    check('the invoice has a delivery line', Boolean(feeLine));
    check('and its lines now add up to its total',
      near(invoice.items.reduce((s, i) => s + money(i.total), 0), money(invoice.total)));

    const intent = await db.paymentIntent.findUniqueOrThrow({ where: { id: deliveryCase.intent.id } });
    check('the amount about to be charged matches the order', near(money(intent.amount), money(order.total)));
    check('and nothing blocks payment now', (await blockingCheckoutIssue(token)) === null);
  }

  // ── 3. Switching to collection ──────────────────────────────────────────
  console.log('\nSwitching to collection removes the delivery it replaced');
  {
    const token = deliveryCase.intent.token!;
    const view = await chooseFulfilment(token, { method: 'PICKUP', contact: CONTACT });
    const order = await db.order.findUniqueOrThrow({ where: { id: deliveryCase.order.id } });
    check('the method changes', order.fulfillmentMethod === 'PICKUP');
    check('the delivery fee is gone', money(order.shippingTotal) === 0);
    check('the total drops back', near(money(order.total), deliveryCase.subtotal));
    check('the old address is cleared', order.deliverySnapshot === null);
    check('the old quote is cleared', order.deliveryQuote === null);
    check('the order is no longer marked for delivery', order.requiresDelivery === false);
    check('no stale shipping address is left pointing at it', order.shippingAddressId === null);
    const invoice = await db.invoice.findFirstOrThrow({
      where: { orderId: deliveryCase.order.id }, include: { items: true },
    });
    check('the invoice drops its delivery line',
      !invoice.items.some((i) => i.description === 'Delivery'));
    check('and its total comes back down', near(money(invoice.total), deliveryCase.subtotal));
    const intent = await db.paymentIntent.findUniqueOrThrow({ where: { id: deliveryCase.intent.id } });
    check('so does the amount to be charged', near(money(intent.amount), deliveryCase.subtotal));
    check('the page agrees', view.order?.shippingTotal === 0);
  }

  // ── 4. Editing the address re-prices ────────────────────────────────────
  console.log('\nEditing the address re-prices the order');
  {
    const built = await buildOrder({ weights: [500] });
    made.reprice = built.intent.id;
    const token = built.intent.token!;
    const first = await chooseFulfilment(token, {
      method: 'DELIVERY', contact: CONTACT,
      destination: { ...DESTINATION, latitude: 6.6018, longitude: 3.3515 },
    });
    const second = await chooseFulfilment(token, {
      method: 'DELIVERY', contact: CONTACT,
      // Much further away, so the distance component must grow.
      destination: { ...FAR_DESTINATION, latitude: 9.0765, longitude: 7.3986 },
    });
    check('a further address costs more',
      (second.fulfilment.quote?.fee.total ?? 0) > (first.fulfilment.quote?.fee.total ?? 0));
    const order = await db.order.findUniqueOrThrow({ where: { id: built.order.id } });
    check('the order follows the new quote',
      near(money(order.shippingTotal), second.fulfilment.quote!.fee.total));
    check('and the destination is the new one',
      (order.deliverySnapshot as Record<string, string>)?.city === 'Abuja');
  }

  // ── 5. Weight that nobody has recorded ──────────────────────────────────
  console.log('\nAn unknown weight is a question, never a zero');
  {
    const built = await buildOrder({ weights: [500, null] });
    made.missing = built.intent.id;
    const view = await chooseFulfilment(built.intent.token!, {
      method: 'DELIVERY', contact: CONTACT,
      destination: { ...DESTINATION, latitude: 6.6018, longitude: 3.3515 },
    });
    check('the quote is withheld', view.fulfilment.quote?.priced === false);
    check('and says it will be priced by hand', view.fulfilment.quote?.outcome === 'MANUAL_QUOTE');
    const order = await db.order.findUniqueOrThrow({ where: { id: built.order.id } });
    check('nothing was charged for it', money(order.shippingTotal) === 0);
    check('and the order was not half-changed', order.fulfillmentMethod === null);
    check('so payment is still blocked', Boolean(await blockingCheckoutIssue(built.intent.token!)));
  }

  // ── 6. Out of range ─────────────────────────────────────────────────────
  console.log('\nA destination outside the radius is refused, not guessed at');
  {
    await configure(ids.org, { delivery: { pricing: { baseFee: 500, perKm: 100, perKg: 0, maxDistanceKm: 5 } } });
    const built = await buildOrder({ weights: [500] });
    made.range = built.intent.id;
    const view = await chooseFulfilment(built.intent.token!, {
      method: 'DELIVERY', contact: CONTACT,
      destination: { ...FAR_DESTINATION, latitude: 9.0765, longitude: 7.3986 },
    });
    check('the quote is refused', view.fulfilment.quote?.outcome === 'OUT_OF_RANGE');
    check('with a reason the customer can act on',
      (view.fulfilment.quote?.message ?? '').includes('beyond'));
    const order = await db.order.findUniqueOrThrow({ where: { id: built.order.id } });
    check('and no fee was applied', money(order.shippingTotal) === 0);
    await configure(ids.org);
  }

  // ── 7. The browser is not trusted ───────────────────────────────────────
  console.log('\nNothing the browser sends decides the price');
  {
    const built = await buildOrder({ weights: [500] });
    made.untrusted = built.intent.id;
    const view = await chooseFulfilment(built.intent.token!, {
      method: 'DELIVERY',
      contact: CONTACT,
      destination: {
        ...DESTINATION,
        latitude: 6.6018,
        longitude: 3.3515,
        // Fields a tampered client might add. They are not in the schema and
        // are not read; the assertion is that the fee is the computed one.
        ...({ fee: 1, deliveryFee: 1, total: 1, distanceKm: 0 } as Record<string, never>),
      } as never,
    });
    const quote = view.fulfilment.quote!;
    check('the fee is the one the server worked out', quote.fee.total > 500);
    const order = await db.order.findUniqueOrThrow({ where: { id: built.order.id } });
    check('and that is what the order was charged', near(money(order.shippingTotal), quote.fee.total));
    check('not the number that arrived in the request', money(order.shippingTotal) !== 1);
  }

  // ── 8. Paying, and the receipt that follows ─────────────────────────────
  console.log('\nA confirmed payment produces a receipt anyone can read');
  let settled: Awaited<ReturnType<typeof buildOrder>>;
  {
    settled = await buildOrder({ weights: [500, 250] });
    made.settled = settled.intent.id;
    const token = settled.intent.token!;
    await chooseFulfilment(token, {
      method: 'DELIVERY', contact: CONTACT,
      destination: { ...DESTINATION, instructions: 'Blue gate', latitude: 6.6018, longitude: 3.3515 },
    });
    const order = await db.order.findUniqueOrThrow({ where: { id: settled.order.id } });
    const due = money(order.total);

    const applied = await paymentIntentService.applyTransaction({
      organizationId: ids.org,
      paymentIntentId: settled.intent.id,
      provider: 'paystack',
      providerRef: `ps-${stamp}`,
      method: 'CARD',
      amount: due,
      currency: 'NGN',
      status: 'SUCCESS',
      paidAt: new Date(),
    } as never);
    check('the payment books against the intent', applied.applied && applied.becamePaid);
    await settlePaymentIntent(settled.intent.id, { becamePaid: true });

    const receipt = await publicReceipt(token);
    check('the public receipt resolves', Boolean(receipt.receiptNumber));
    check('and is not blank — it carries the rendered document', receipt.html.length > 800);
    check('for the amount actually paid', near(receipt.amountPaid, due));
    check('showing the delivery as its own line', receipt.delivery > 0 && receipt.html.includes('Delivery'));
    check('and the business, not the platform, on the header',
      receipt.html.includes(`Checkout test ${stamp}`));
    check('the recipient is the one given at checkout', receipt.customer?.name === CONTACT.name);
    check('the receipt references the order', receipt.orderNumber === order.number);

    // The same data the business sees.
    const direct = await buildReceiptForIntent(settled.intent.id);
    check('the business and the customer see one receipt number',
      direct.receiptNumber === receipt.receiptNumber);
    check('and one total', near(direct.total, receipt.total));
    check('rendered from the same template',
      (await renderReceiptHtml(direct)).length === receipt.html.length);
  }

  // ── 9. The receipt email, and the truth about it ────────────────────────
  console.log('\nThe receipt email reports what actually happened');
  {
    const first = await sendReceiptEmail(made.settled!);
    // No EMAIL channel is connected for this test business, which is exactly
    // the situation that used to fail silently while the UI promised a receipt.
    check('it does not claim to have sent anything', first.status !== 'SENT');
    check('it says why', first.status === 'NO_CHANNEL' && first.message.includes('no mailbox'));
    check('and still offers the receipt link', Boolean(first.receiptUrl));
    check('the outcome is recorded against the payment',
      (await receiptEmailState(made.settled!))?.status === 'NO_CHANNEL');

    const again = await sendReceiptEmail(made.settled!);
    check('retrying is allowed after a failure', again.status === 'NO_CHANNEL');

    // Pretend a send succeeded, then check a replayed webhook does not repeat it.
    const intent = await db.paymentIntent.findUniqueOrThrow({ where: { id: made.settled! } });
    await db.paymentIntent.update({
      where: { id: made.settled! },
      data: {
        metadata: {
          ...((intent.metadata as Record<string, unknown>) ?? {}),
          receiptEmail: { status: 'SENT', recipient: CONTACT.email, attempts: 1, at: new Date().toISOString(), message: 'sent' },
        } as Prisma.InputJsonValue,
      },
    });
    const replay = await sendReceiptEmail(made.settled!);
    check('a replayed payment does not send a second receipt', replay.status === 'ALREADY_SENT');
    const forced = await sendReceiptEmail(made.settled!, { force: true });
    check('but a business can deliberately resend', forced.status !== 'ALREADY_SENT');
  }

  // ── 10. An unpaid payment has no receipt ────────────────────────────────
  console.log('\nAn unconfirmed payment produces nothing');
  {
    const built = await buildOrder({ weights: [500] });
    made.unpaid = built.intent.id;
    let threw = false;
    try { await publicReceipt(built.intent.token!); } catch { threw = true; }
    check('no receipt for a payment that has not happened', threw);
    const outcome = await sendReceiptEmail(built.intent.id);
    check('and no receipt email either',
      outcome.status === 'FAILED' && outcome.message.includes('confirmed'));
  }

  // ── 11. The customer profile ────────────────────────────────────────────
  console.log('\nCheckout details reach the profile without overwriting it');
  {
    // Settlement has already run this once, as part of confirming the payment.
    const customer = await db.customer.findUniqueOrThrow({ where: { id: ids.customer } });
    check('an empty email is filled from checkout', customer.email === CONTACT.email);
    check('an empty phone is filled too', Boolean(customer.phone));
    check('the phone is normalised on the way in', customer.phone?.startsWith('+234') === true);

    // Running it again changes nothing, which is what makes a replayed
    // webhook harmless.
    const again = await syncCustomerFromCheckout(made.settled!);
    check('running it a second time fills nothing more',
      again.filled.length === 0 && again.error === null);
    check('and reports the customer it decided on', again.customerId === ids.customer);

    // Now a different person pays for the same customer's order.
    const second = await buildOrder({ weights: [500] });
    made.second = second.intent.id;
    await chooseFulfilment(second.intent.token!, {
      method: 'PICKUP',
      contact: { name: 'Someone Else', phone: '08039999999', email: 'someone.else@example.example' },
    });
    await syncCustomerFromCheckout(second.intent.id);
    const after = await db.customer.findUniqueOrThrow({ where: { id: ids.customer } });
    check('a known email is never overwritten by a later payer', after.email === CONTACT.email);
    check('nor the phone', after.phone === customer.phone);
    check('and the profile name is never rewritten from a recipient',
      after.firstName === 'Adaeze');

    const secondOrder = await db.order.findUniqueOrThrow({ where: { id: second.order.id } });
    check('while this order keeps the details given for it',
      secondOrder.contactName === 'Someone Else' && secondOrder.contactEmail === 'someone.else@example.example');
    const firstOrder = await db.order.findUniqueOrThrow({ where: { id: settled.order.id } });
    check('and the earlier order is untouched by it',
      firstOrder.contactName === CONTACT.name);
    check('two orders keep two different destinations',
      (firstOrder.deliverySnapshot as Record<string, string>)?.city === 'Ikeja' && secondOrder.deliverySnapshot === null);
  }

  // ── 12. A paid invoice is history ───────────────────────────────────────
  console.log('\nA settled invoice is not rewritten by a later change');
  {
    const invoice = await db.invoice.findFirstOrThrow({ where: { orderId: settled.order.id } });
    const before = money(invoice.total);
    await db.invoice.update({ where: { id: invoice.id }, data: { status: 'PAID', amountPaid: before } });
    let refused = false;
    try {
      await chooseFulfilment(settled.intent.token!, { method: 'PICKUP', contact: CONTACT });
    } catch {
      refused = true;
    }
    check('checkout refuses to touch a settled payment', refused);
    const after = await db.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    check('and the paid invoice total is unchanged', near(money(after.total), before));
  }

  // ── 13. Tenant boundaries ───────────────────────────────────────────────
  console.log('\nOne business cannot reach another through a payment token');
  {
    await configure(ids.otherOrg);
    const theirs = await buildOrder({
      weights: [500], organizationId: ids.otherOrg, customerId: ids.otherCustomer,
    });
    made.other = theirs.intent.id;
    const view = await checkoutView(theirs.intent.token!);
    check('their token shows their business', view.businessName.includes('Rival'));
    check('and their order only', view.order?.id === theirs.order.id);

    // A customer id from the other tenant must never be written into ours.
    const crossed = await syncCustomerFromCheckout(theirs.intent.id);
    check('profile sync stays inside the owning business',
      crossed.customerId === ids.otherCustomer || crossed.customerId === null);
    const ourCustomer = await db.customer.findUniqueOrThrow({ where: { id: ids.customer } });
    check('our customer is untouched by their checkout', ourCustomer.email === CONTACT.email);
  }

  await cleanup();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

async function cleanup(): Promise<void> {
  for (const organizationId of [ids.org, ids.otherOrg].filter(Boolean)) {
    const orders = await db.order.findMany({ where: { organizationId }, select: { id: true } });
    const orderIds = orders.map((o) => o.id);
    await db.paymentTransaction.deleteMany({ where: { organizationId } }).catch(() => {});
    await db.paymentIntent.deleteMany({ where: { organizationId } }).catch(() => {});
    await db.payment.deleteMany({ where: { organizationId } }).catch(() => {});
    await db.invoiceItem.deleteMany({ where: { invoice: { organizationId } } }).catch(() => {});
    await db.invoice.deleteMany({ where: { organizationId } }).catch(() => {});
    await db.orderStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } }).catch(() => {});
    await db.orderItem.deleteMany({ where: { orderId: { in: orderIds } } }).catch(() => {});
    await db.order.deleteMany({ where: { organizationId } }).catch(() => {});
    await db.stockLevel.deleteMany({ where: { organizationId } }).catch(() => {});
    await db.productVariant.deleteMany({ where: { organizationId } }).catch(() => {});
    await db.product.deleteMany({ where: { organizationId } }).catch(() => {});
    await db.customerAddress.deleteMany({ where: { customer: { organizationId } } }).catch(() => {});
    await db.customer.deleteMany({ where: { organizationId } }).catch(() => {});
    await db.emailDeliveryLog.deleteMany({ where: { organizationId } }).catch(() => {});
    await db.auditLog.deleteMany({ where: { organizationId } }).catch(() => {});
    await db.activity.deleteMany({ where: { organizationId } }).catch(() => {});
    await db.notification.deleteMany({ where: { organizationId } }).catch(() => {});
    await db.organization.delete({ where: { id: organizationId } }).catch(() => {});
  }
}

main().catch(async (err) => {
  console.error(err);
  await cleanup();
  process.exit(1);
});
