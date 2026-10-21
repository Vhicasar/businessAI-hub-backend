/**
 * Platform switches, product media, website branding and the website cart.
 *
 * Runs against the live dev database with a throwaway organization. Two things
 * it deliberately does not do: touch an existing deployment configuration, and
 * sweep campaigns platform-wide — the scheduler is always called with this
 * organization's id so a verification run can never fire somebody's real
 * campaign as a side effect.
 */
import { prismaUnscoped as db } from '../../src/infrastructure/database/prisma';
import { requestContext } from '../../src/shared/context';
import { setWorkspaceConfigOverride } from '../../src/application/settings/workspace-config';
import { PLATFORM_FEATURES, isPlatformFeatureEnabled, enabledPlatformFeatures } from '../../src/application/settings/platform-features';
import { whatsappCampaignService, whatsappCampaignsEnabled } from '../../src/application/messaging/whatsapp-campaign.service';
import { runScheduledCampaigns } from '../../src/application/messaging/campaign-scheduler';
import { resolveSiteIcon, clearSiteIconCache, letterMark } from '../../src/application/sites/site-icon.service';
import { cartState, orderPaymentState } from '../../src/application/sites/site-cart.service';
import { cartScript, cartMarkup, cartStyles } from '../../src/application/sites/site-cart-ui';
import { ingestImageFromUrl } from '../../src/application/data-transfer/image-ingest';
import { ordersService } from '../../src/application/orders/orders.service';
import { catalogService } from '../../src/application/catalog/catalog.service';
import { exportEntity } from '../../src/application/data-transfer/data-transfer.service';
import { FIELD_DEFS } from '../../src/application/data-transfer/fields';
import { addOnsService } from '../../src/application/billing/add-ons.service';
import { isPaidPlan, resolveEntitlements } from '../../src/application/billing/entitlements';
import { siteBuilderService } from '../../src/application/sites/site-builder.service';
import { domainConfigService } from '../../src/application/sites/domain-config.service';

let passed = 0, failed = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); }
};

const stamp = Date.now();
let orgId = '', userId = '', warehouseId = '', variantId = '', productId = '', customerId = '';
let siteId = '', createdConfigId = '', otherOrgId = '', otherSiteId = '';

const asOrg = <T>(fn: () => Promise<T>) =>
  requestContext.run({ requestId: `hub-${stamp}`, organizationId: orgId, userId }, fn);

/** Install only the flags a case needs; everything else keeps its default. */
const flags = (value: Record<string, boolean> | null) =>
  setWorkspaceConfigOverride(value ? { featureFlags: value } : null);

async function main() {
  const org = await db.organization.create({
    data: { name: `Hub Verify ${stamp}`, slug: `hub-verify-${stamp}`, currency: 'NGN', status: 'ACTIVE', country: 'NG' },
  });
  orgId = org.id;
  const user = await db.user.create({
    data: { email: `hub-verify-${stamp}@example.invalid`, firstName: 'Hub', lastName: 'Verify', passwordHash: 'x' },
  });
  userId = user.id;

  // ── 1. Platform switches ────────────────────────────────────────────────
  console.log('\nPlatform switches');
  flags(null);
  check('a switch nobody has set is on', isPlatformFeatureEnabled(PLATFORM_FEATURES.whatsappCampaigns));
  check('the session payload lists it as enabled',
    enabledPlatformFeatures().includes(PLATFORM_FEATURES.whatsappCampaigns));

  flags({ whatsapp_campaigns: false });
  check('switching it off is observed', !whatsappCampaignsEnabled());
  check('the session payload stops listing it',
    !enabledPlatformFeatures().includes(PLATFORM_FEATURES.whatsappCampaigns));
  // The two switches carry different defaults on purpose: campaigns are on
  // unless withdrawn, free-plan publishing is off unless granted.
  check('the other switch keeps its own default',
    !isPlatformFeatureEnabled(PLATFORM_FEATURES.freePlanWebsiteSubdomain));

  // ── 2. Campaigns refused in the API, not merely hidden ──────────────────
  console.log('\nWhatsApp campaigns while switched off');
  let launchRefused = '';
  await asOrg(async () => {
    try {
      await whatsappCampaignService.launch({
        name: 'Should not launch', channelAccountId: 'cjld2cjxh0000qzrmn831i7rn',
        templateName: 'x', templateLanguage: 'en_US', variables: {},
        segment: { kind: 'ALL_OPTED_IN' } as never, scheduledAt: null,
      } as never);
    } catch (err) { launchRefused = (err as { code?: string }).code ?? (err as Error).message; }
  });
  check('launch is refused by the backend', launchRefused === 'WHATSAPP_CAMPAIGNS_DISABLED', launchRefused);

  // A campaign that was already scheduled must be parked, not sent.
  const scheduled = await db.campaign.create({
    data: {
      organizationId: orgId, name: `Parked ${stamp}`, type: 'WHATSAPP', status: 'SCHEDULED',
      scheduledAt: new Date(Date.now() - 60_000),
      content: { channelAccountId: 'x', templateName: 't', templateLanguage: 'en_US', variables: {} },
      stats: { total: 0, sent: 0, failed: 0, skipped: 0 },
    },
  });
  const offSweep = await runScheduledCampaigns(new Date(), orgId);
  check('the sweep does not report a parked campaign as sent', offSweep.sent === 0, JSON.stringify(offSweep));
  check('and restores nothing while the switch is off', offSweep.restored === 0, JSON.stringify(offSweep));
  let row = await db.campaign.findUniqueOrThrow({ where: { id: scheduled.id } });
  check('a due campaign is not sent while the switch is off', row.status !== 'SENT' && row.status !== 'SENDING', row.status);
  check('it is parked as PAUSED', row.status === 'PAUSED', row.status);
  check('the campaign and its configuration survive',
    (row.content as Record<string, unknown>).templateName === 't');
  check('the reason is recorded against it',
    typeof (row.content as Record<string, unknown>).haltReason === 'string');
  check('it is marked as the platform having parked it',
    (row.content as Record<string, unknown>).pausedByPlatform === true);
  check('its due time is kept so restoring it can honour the schedule',
    typeof (row.content as Record<string, unknown>).platformPausedScheduledAt === 'string');

  // Negative control: a campaign a *person* paused must not be handed back.
  const humanPaused = await db.campaign.create({
    data: {
      organizationId: orgId, name: `Human paused ${stamp}`, type: 'WHATSAPP', status: 'PAUSED',
      scheduledAt: new Date(Date.now() - 60_000),
      content: { templateName: 'h' }, stats: {},
    },
  });

  // ── 3. Handed back when the switch returns ──────────────────────────────
  console.log('\nWhen campaigns are switched back on');
  flags({ whatsapp_campaigns: true });
  const sweep = await runScheduledCampaigns(new Date(), orgId);
  check('the sweep reports a restoration', sweep.restored >= 1, JSON.stringify(sweep));
  row = await db.campaign.findUniqueOrThrow({ where: { id: scheduled.id } });
  check('the parked campaign is scheduled again', row.status === 'SCHEDULED' || row.status === 'SENDING' || row.status === 'PARTIALLY_SENT' || row.status === 'FAILED', row.status);
  check('the platform mark is cleared',
    (row.content as Record<string, unknown>).pausedByPlatform === undefined);
  const stillPaused = await db.campaign.findUniqueOrThrow({ where: { id: humanPaused.id } });
  check('a campaign a person paused is left alone', stillPaused.status === 'PAUSED', stillPaused.status);

  // ── 4. Inbound WhatsApp is untouched by the campaign switch ─────────────
  console.log('\nScope of the campaign switch');
  const account = await db.channelAccount.create({
    data: {
      organizationId: orgId, channelType: 'WHATSAPP', name: 'Verify WA', externalId: `wa-${stamp}`,
      isActive: true, status: 'CONNECTED', credentialsEnc: 'x',
    },
  });
  flags({ whatsapp_campaigns: false });
  const after = await db.channelAccount.findUniqueOrThrow({ where: { id: account.id } });
  check('the WhatsApp channel stays connected', after.status === 'CONNECTED' && after.isActive);
  const { markWebhookReceived } = await import('../../src/application/inbox/channel-health.service');
  await markWebhookReceived(account.id);
  const healthy = await db.channelAccount.findUniqueOrThrow({ where: { id: account.id } });
  check('inbound WhatsApp webhooks are still accepted', healthy.status === 'CONNECTED');

  // ── 5. Product description and image ───────────────────────────────────
  console.log('\nProducts: description and image');
  flags(null);
  const product = await asOrg(() => catalogService.createProduct({
    name: `Verify Mug ${stamp}`,
    description: 'A sturdy enamel mug, 400ml.',
    status: 'ACTIVE', taxRate: 0,
    variants: [{ sku: `VM-${stamp}`, price: 4500, isDefault: true, initialStock: 5 }],
  } as never, 'NGN')) as Record<string, unknown>;
  productId = String(product.id);
  check('a product keeps the description it was created with',
    product.description === 'A sturdy enamel mug, 400ml.');
  const variants = product.variants as { id: string }[];
  variantId = variants[0]!.id;

  const file = await db.file.create({
    data: {
      organizationId: orgId, driver: 'LOCAL', key: `verify/${stamp}.png`, fileName: 'mug.png',
      mimeType: 'image/png', sizeBytes: 12, isPublic: true, uploadedById: userId,
    },
  });
  await asOrg(() => catalogService.addProductImage(productId, { fileId: file.id, altText: 'Mug' }));
  const withImage = await asOrg(() => catalogService.getProduct(productId)) as { images: unknown[] };
  check('an image can be attached to it', withImage.images.length === 1);

  // Export must carry both, or an export cannot be edited and imported back.
  const exported = await asOrg(() => exportEntity('products'));
  const header = exported.csv.split('\n')[0] ?? '';
  check('the product export has a description column', header.includes('description'));
  check('the product export has an imageUrl column', header.includes('imageUrl'));
  check('the exported row carries this product', exported.csv.includes(`VM-${stamp}`));

  const productFields = FIELD_DEFS.products.map((f) => f.key);
  check('the importer offers a description field', productFields.includes('description'));
  check('the importer offers an image field', productFields.includes('imageUrl'));
  check('neither is required, so old files still import',
    !FIELD_DEFS.products.some((f) => (f.key === 'description' || f.key === 'imageUrl') && f.required));

  // ── 6. Image ingest refuses what it must ───────────────────────────────
  console.log('\nImage URLs an import may not fetch');
  for (const url of ['http://127.0.0.1:4000/', 'http://169.254.169.254/', 'file:///etc/passwd', 'http://10.1.1.1/x.png']) {
    const result = await ingestImageFromUrl(url, { organizationId: orgId, uploadedById: userId });
    check(`refused: ${url}`, result.fileId === null && result.error !== null, result.error ?? 'ALLOWED');
  }

  // ── 7. Website icon follows the entitlement, not the site ───────────────
  console.log('\nPublished website icon');
  clearSiteIconCache();
  const standard = await resolveSiteIcon({ organizationId: orgId, logoUrl: 'https://cdn.example/own-logo.png', name: 'Verify Co', themeColor: '#F97316' });
  check('a business without white label gets the platform mark', !standard.whiteLabel);
  check('and not its own logo, even though it has one', standard.href !== 'https://cdn.example/own-logo.png');
  /*
   * The platform mark follows the admin, which is the whole point: the
   * dashboard's own tab icon already tracks product branding, so a customer
   * website showing a file baked into the build would drift the moment
   * somebody uploaded a new logo.
   */
  const { getProductBranding } = await import('../../src/application/catalog/site-catalog.service');
  const branding = await getProductBranding();
  if (branding.logoUrl) {
    check('the platform mark is the admin-configured logo', standard.href === branding.logoUrl, standard.href.slice(0, 70));
  } else {
    check('with no admin logo, the bundled mark is inlined', standard.href.startsWith('data:image/png;base64,'), standard.href.slice(0, 40));
    console.log('    (the admin has no logo configured; the bundled mark was used)');
  }
  check('the mark is a usable image reference',
    /^https?:\/\//.test(standard.href) || standard.href.startsWith('data:image/'), standard.href.slice(0, 40));

  await db.addOnPurchase.create({
    data: { organizationId: orgId, addOnId: 'white_label', title: 'White Label', billingType: 'ONE_TIME', entitlements: { features: ['white_label'] }, amount: 0, currency: 'NGN' },
  });
  clearSiteIconCache();
  const branded = await resolveSiteIcon({ organizationId: orgId, logoUrl: 'https://cdn.example/own-logo.png', name: 'Verify Co', themeColor: '#F97316' });
  check('a white-label business gets its own logo', branded.whiteLabel && branded.href === 'https://cdn.example/own-logo.png');

  clearSiteIconCache();
  const noLogo = await resolveSiteIcon({ organizationId: orgId, logoUrl: null, name: 'Verify Co', themeColor: '#123456' });
  check('white label with no logo falls back to a letter mark',
    noLogo.whiteLabel && noLogo.href === letterMark('V', '#123456'));
  check('the fallback is an image, not a broken link', noLogo.href.startsWith('data:image/svg+xml'));

  // ── 8. The cart's limits come from the server ──────────────────────────
  console.log('\nWebsite cart');
  const wh = await db.warehouse.findFirstOrThrow({ where: { organizationId: orgId } });
  warehouseId = wh.id;
  let lines = await cartState(orgId, [variantId]);
  check('the cart is told the real price', lines[0]?.unitPrice === 4500, String(lines[0]?.unitPrice));
  check('the cart is told the real stock', lines[0]?.available === 5, String(lines[0]?.available));
  check('and the product name', lines[0]?.name?.includes('Verify Mug'));

  const unknown = await cartState(orgId, ['cjld2cjxh0000qzrmn831i7rn']);
  check('an unknown variant comes back unavailable rather than missing',
    unknown.length === 1 && unknown[0]!.available === 0 && Boolean(unknown[0]!.unavailableReason));

  // A variant belonging to somebody else must never be priced for this site.
  const otherOrgVariant = await db.productVariant.findFirst({
    where: { product: { organizationId: { not: orgId } }, deletedAt: null },
    select: { id: true },
  });
  if (otherOrgVariant) {
    const leaked = await cartState(orgId, [otherOrgVariant.id]);
    check('another business’s product is not priced for this cart',
      leaked[0]?.name === null && leaked[0]?.available === 0);
  } else {
    console.log('    (no other tenant’s variant to test isolation against)');
  }

  // ── 9. Stock cannot be oversold, even by two buyers at once ────────────
  console.log('\nInventory under contention');
  const customer = await db.customer.create({
    data: { organizationId: orgId, firstName: 'Cart', lastName: 'Buyer', email: `buyer-${stamp}@example.invalid` },
  });
  customerId = customer.id;

  let overOrderError = '';
  await asOrg(async () => {
    try {
      await ordersService.create({ customerId, source: 'WEB', shippingTotal: 0, items: [{ variantId, quantity: 6 }] } as never, null);
    } catch (err) { overOrderError = (err as Error).message; }
  });
  check('an order for more than exists is refused', /Insufficient stock/i.test(overOrderError), overOrderError);

  // Two orders for the last unit, started together. Exactly one may win.
  await db.stockLevel.updateMany({ where: { warehouseId, variantId }, data: { quantity: 1, reserved: 0 } });
  const attempt = () => asOrg(() => ordersService.create(
    { customerId, source: 'WEB', shippingTotal: 0, items: [{ variantId, quantity: 1 }] } as never, null,
  )).then(() => 'ok' as const).catch((err: Error) => err.message);
  const [a, b] = await Promise.all([attempt(), attempt()]);
  const wins = [a, b].filter((r) => r === 'ok').length;
  check('exactly one of two simultaneous buyers gets the last unit', wins === 1, `a=${a} b=${b}`);
  const level = await db.stockLevel.findFirstOrThrow({ where: { warehouseId, variantId } });
  check('reserved never exceeds what is on hand',
    Number(level.reserved) <= Number(level.quantity), `reserved=${level.reserved} qty=${level.quantity}`);

  // ── 10. The cart only empties on a confirmed payment ───────────────────
  console.log('\nPayment state the cart reads');
  const order = await db.order.findFirstOrThrow({ where: { organizationId: orgId }, orderBy: { createdAt: 'desc' } });
  let state = await orderPaymentState(orgId, order.id);
  check('an unpaid order reports unpaid, so the cart is kept', state?.paid === false, JSON.stringify(state));
  await db.order.update({ where: { id: order.id }, data: { paymentStatus: 'PAID' } });
  state = await orderPaymentState(orgId, order.id);
  check('a paid order reports paid, so the cart may clear', state?.paid === true);
  check('an order id from another business is not readable',
    (await orderPaymentState('cjld2cjxh0000qzrmn831i7rn', order.id)) === null);
  check('an unknown order id is not readable', (await orderPaymentState(orgId, 'nope')) === null);

  // ── 11. What the cart page actually ships ──────────────────────────────
  console.log('\nCart markup and script');
  const js = cartScript('site123', '/site/demo', false);
  const html = cartMarkup();
  check('the cart offers an increase control', js.includes('data-inc'));
  check('the cart offers a decrease control', js.includes('data-dec'));
  check('the cart shows a subtotal', html.includes('cart-summary') && js.includes('Subtotal'));
  check('the cart refuses to exceed available stock', js.includes('units are available'));
  check('the cart asks the server for price and stock', js.includes("'/cart'"));
  check('checkout opens in a new tab', js.includes("window.open(payload.url,'_blank'"));
  check('the cart is NOT cleared when checkout starts', !js.includes('localStorage.removeItem(KEY)'));
  check('the cart is cleared only on a confirmed payment', js.includes('payload.paid)settled()'));
  check('other tabs are told over a BroadcastChannel', js.includes('BroadcastChannel'));
  check('a storage event is handled for browsers without it', js.includes("'storage'"));
  check('the label says Continue to Checkout', html.includes('Continue to Checkout'));
  /*
   * An emptied cart must not keep showing a subtotal. The summary is declared
   * `display:grid`, which outranks the browser's own `[hidden]` rule, so
   * hiding it needs a rule that outranks the layout.
   */
  const css = cartStyles();
  check('hiding a cart element beats its own display rule', css.includes('#cart [hidden]{display:none!important}'));
  check('the summary is emptied as well as hidden', js.includes("summary.innerHTML='';summary.hidden=true"));
  check('a preview makes no server calls', cartScript('s', '/p', true).includes('PREVIEW=true'));

  // ── 10b. Website AI and publishing are paid-plan capabilities ──────────
  console.log('\nWebsite builder: paid-plan gates');
  flags(null);

  // This organisation has no subscription, so it is on the free plan.
  let ent = await resolveEntitlements(orgId);
  check('the verification workspace is on the free plan', !isPaidPlan(ent), `${ent.planSlug}/${ent.status}`);

  let aiBuild = '';
  await asOrg(async () => {
    try { await siteBuilderService.create({ name: `AI Site ${stamp}`, mode: 'AI', prompt: 'A shop selling cold drinks in Lagos' } as never); }
    catch (err) { aiBuild = (err as { code?: string }).code ?? (err as Error).message; }
  });
  check('Build with AI is refused on the free plan', aiBuild === 'PLAN_UPGRADE_REQUIRED', aiBuild);

  // The mode must be *accepted and refused*, not rejected as an unknown value —
  // a validation error cannot be turned into an upgrade prompt.
  check('and refused as an upgrade, not as a schema error',
    !/invalid|enum|expected/i.test(aiBuild), aiBuild);

  const aiSite = await asOrg(() => siteBuilderService.create({ name: `Gate Site ${stamp}`, mode: 'BLANK' } as never)) as { id: string };
  let aiEditCode = '';
  await asOrg(async () => {
    const page = await db.sitePage.findFirstOrThrow({ where: { siteId: aiSite.id }, select: { id: true } });
    try { await siteBuilderService.aiEdit(aiSite.id, { pageId: page.id, instruction: 'Make it feel more premium' } as never); }
    catch (err) { aiEditCode = (err as { code?: string }).code ?? (err as Error).message; }
  });
  check('Ask Vhicasar AI is refused on the free plan', aiEditCode === 'PLAN_UPGRADE_REQUIRED', aiEditCode);

  let publishCode = '';
  await asOrg(async () => {
    try { await siteBuilderService.publish(aiSite.id, `gate${stamp}`.slice(0, 20)); }
    catch (err) { publishCode = (err as { code?: string }).code ?? (err as Error).message; }
  });
  check('publishing is refused on the free plan', publishCode === 'PLAN_UPGRADE_REQUIRED', publishCode);

  const freeInfo = await asOrg(() => siteBuilderService.deploymentInfo());
  check('the editor is told an upgrade is needed', freeInfo.publishNeedsUpgrade === true);

  /*
   * Now put the workspace on a paid plan and prove every one of those opens.
   * A gate that never opens is indistinguishable from a broken feature.
   */
  const growth = await db.plan.findUnique({ where: { slug: 'growth' } });
  if (growth) {
    const now = new Date();
    const sub = await db.subscription.create({
      data: {
        organizationId: orgId, planId: growth.id, status: 'ACTIVE', interval: 'MONTHLY',
        currentPeriodStart: now, currentPeriodEnd: new Date(now.getTime() + 30 * 86_400_000),
      },
    });
    ent = await resolveEntitlements(orgId);
    check('the workspace is now on a paid plan', isPaidPlan(ent), `${ent.planSlug}/${ent.status}`);

    const paidInfo = await asOrg(() => siteBuilderService.deploymentInfo());
    check('publishing no longer needs an upgrade', paidInfo.publishNeedsUpgrade === false);
    check('and the editor reports it as included', paidInfo.canPublishToSubdomain === true);

    const paidOffers = await asOrg(() => addOnsService.list());
    check('the subdomain add-on is not sold to a paid plan',
      !paidOffers.some((item) => item.id === 'website_subdomain'));

    // The AI gate must open too — checked by the error no longer being the
    // upgrade one, since a real generation needs a provider.
    let paidAiCode = '';
    await asOrg(async () => {
      const page = await db.sitePage.findFirstOrThrow({ where: { siteId: aiSite.id }, select: { id: true } });
      try { await siteBuilderService.aiEdit(aiSite.id, { pageId: page.id, instruction: 'Make it feel more premium' } as never); }
      catch (err) { paidAiCode = (err as { code?: string }).code ?? (err as Error).message; }
    });
    check('Ask Vhicasar AI is no longer blocked by the plan', paidAiCode !== 'PLAN_UPGRADE_REQUIRED', paidAiCode || 'succeeded');

    await db.subscription.delete({ where: { id: sub.id } });
  } else {
    console.log('    (no growth plan seeded; paid-plan half skipped)');
  }

  // A free plan with the add-on still publishes — it has already paid for this.
  await db.addOnPurchase.create({
    data: {
      organizationId: orgId, addOnId: 'website_subdomain', title: 'Website Subdomain',
      billingType: 'MONTHLY', amount: 0, currency: 'NGN', entitlements: { features: ['website_subdomain'] },
    },
  });
  const addOnInfo = await asOrg(() => siteBuilderService.deploymentInfo());
  check('a free plan holding the add-on may still publish', addOnInfo.canPublishToSubdomain === true);
  await db.addOnPurchase.deleteMany({ where: { organizationId: orgId, addOnId: 'website_subdomain' } });

  // And the administrator can still include publishing for the free plan.
  flags({ free_plan_website_subdomain: true });
  const switchedOn = await asOrg(() => siteBuilderService.deploymentInfo());
  check('the admin switch still opens publishing for the free plan', switchedOn.canPublishToSubdomain === true);
  flags(null);
  const switchedOff = await asOrg(() => siteBuilderService.deploymentInfo());
  check('and it is closed again by default', switchedOff.publishNeedsUpgrade === true);

  await asOrg(() => siteBuilderService.remove(aiSite.id)).catch(() => undefined);

  // ── 11a. The subdomain add-on is not sold when it is included ──────────
  console.log('\nWebsite subdomain add-on');
  flags({ free_plan_website_subdomain: true });
  let offered = await asOrg(() => addOnsService.list());
  check('it is not offered while subdomains are included',
    !offered.some((item) => item.id === 'website_subdomain'),
    offered.map((i) => i.id).join(', '));
  check('other add-ons are still offered', offered.length > 0);

  let soldAnyway = '';
  await asOrg(async () => {
    try { await addOnsService.checkout('website_subdomain'); }
    catch (err) { soldAnyway = (err as { code?: string }).code ?? (err as Error).message; }
  });
  check('and buying it directly is refused', soldAnyway === 'ADD_ON_NOT_REQUIRED', soldAnyway);

  flags({ free_plan_website_subdomain: false });
  offered = await asOrg(() => addOnsService.list());
  check('it returns when subdomains are not included',
    offered.some((item) => item.id === 'website_subdomain'));

  // A workspace already paying for it keeps seeing it whatever the switch says.
  flags({ free_plan_website_subdomain: true });
  await db.addOnPurchase.create({
    data: {
      organizationId: orgId, addOnId: 'website_subdomain', title: 'Website Subdomain',
      billingType: 'MONTHLY', amount: 0, currency: 'NGN', entitlements: { features: ['website_subdomain'] },
    },
  });
  offered = await asOrg(() => addOnsService.list());
  check('a workspace already paying for it still sees it',
    offered.some((item) => item.id === 'website_subdomain' && item.activePurchases.length > 0));
  await db.addOnPurchase.deleteMany({ where: { organizationId: orgId, addOnId: 'website_subdomain' } });
  flags(null);

  // ── 11b. Receipts are issued once, and only for a confirmed payment ────
  console.log('\nReceipt emails');
  const { sendReceiptEmail } = await import('../../src/application/payments/receipt-email.service');
  const unpaidIntent = await db.paymentIntent.create({
    data: {
      organizationId: orgId, orderId: order.id, customerId, resourceType: 'ORDER',
      amount: 4500, currency: 'NGN', status: 'AWAITING_PAYMENT',
      token: `verify-unpaid-${stamp}`, reference: `VRF-UNPAID-${stamp}`,
      metadata: { checkoutEmail: `buyer-${stamp}@example.invalid` },
    },
  });
  const unpaidOutcome = await sendReceiptEmail(unpaidIntent.id);
  check('no receipt is sent for a payment the provider has not confirmed',
    unpaidOutcome.status !== 'SENT' && /confirmed/i.test(unpaidOutcome.message), JSON.stringify(unpaidOutcome));

  /*
   * The replay guard, tested directly.
   *
   * A real second webhook is indistinguishable from the first by the time it
   * reaches here, so what matters is that a payment already marked as having
   * had its receipt emailed is not emailed again. Writing that state and
   * calling again is exactly the situation a duplicate webhook creates.
   */
  const sentIntent = await db.paymentIntent.create({
    data: {
      organizationId: orgId, orderId: order.id, customerId, resourceType: 'ORDER',
      amount: 4500, currency: 'NGN', status: 'PAID', paidAt: new Date(), amountPaid: 4500,
      token: `verify-paid-${stamp}`, reference: `VRF-PAID-${stamp}`,
      metadata: {
        checkoutEmail: `buyer-${stamp}@example.invalid`,
        receiptEmail: { status: 'SENT', attempts: 1, at: new Date().toISOString() },
      },
    },
  });
  const replay = await sendReceiptEmail(sentIntent.id);
  check('a duplicate webhook does not send a second receipt', replay.status === 'ALREADY_SENT', JSON.stringify(replay));
  const forced = await sendReceiptEmail(sentIntent.id, { force: true });
  check('a business can still deliberately resend one', forced.status !== 'ALREADY_SENT', JSON.stringify(forced));

  // ── 12. Website subdomains ─────────────────────────────────────────────
  console.log('\nWebsite subdomains');
  let config = await domainConfigService.active();
  if (!config) {
    config = await domainConfigService.create({
      name: `Hub Verify ${stamp}`, provider: 'HOSTINGER',
      baseDomain: `hubverify-${stamp}.example`, cnameTarget: `sites.hubverify-${stamp}.example`,
      verificationTarget: null,
    });
    createdConfigId = config.id;
    await domainConfigService.activate(config.id);
    console.log('    (no deployment configuration existed; created a throwaway one)');
  } else {
    console.log(`    (using the configuration already active: ${config.baseDomain})`);
  }

  const site = await asOrg(() => siteBuilderService.create({ name: `Verify Site ${stamp}`, mode: 'BLANK' } as never)) as { id: string };
  siteId = site.id;

  // This organization is on the free plan and owns no subdomain add-on —
  // exactly the case the switch is about.
  const sub = `hubv${stamp}`.slice(0, 20);

  flags({ free_plan_website_subdomain: false });
  let refusal = '';
  await asOrg(async () => {
    try { await siteBuilderService.publish(siteId, sub); }
    catch (err) { refusal = (err as { code?: string }).code ?? (err as Error).message; }
  });
  check('with the switch off, a free plan cannot publish to a subdomain',
    refusal === 'PLAN_UPGRADE_REQUIRED', refusal);
  let info = await asOrg(() => siteBuilderService.deploymentInfo());
  check('and the editor is told publishing is not included', info.subdomainIncluded === false && info.canPublishToSubdomain === false);

  flags({ free_plan_website_subdomain: true });
  info = await asOrg(() => siteBuilderService.deploymentInfo());
  check('with the switch on, the editor is told it is included',
    info.subdomainIncluded === true && info.canPublishToSubdomain === true);

  let published: { subdomain?: string | null; status?: string } = {};
  let publishError = '';
  await asOrg(async () => {
    try { published = await siteBuilderService.publish(siteId, sub) as typeof published; }
    catch (err) { publishError = (err as Error).message; }
  });
  check('a free plan can publish to a subdomain', published.subdomain === sub, publishError);
  check('and the website is live', published.status === 'PUBLISHED', String(published.status));

  // Reserved, invalid and duplicate names are refused whatever the switch says.
  for (const name of ['www', 'app', 'api', 'admin', 'mail', 'support', 'help', 'dashboard', 'businesshub']) {
    let reason = '';
    const availability = await asOrg(() => siteBuilderService.subdomainAvailable(siteId, name));
    if (availability.available) {
      await asOrg(async () => {
        try { await siteBuilderService.publish(siteId, name); reason = 'PUBLISHED!'; }
        catch (err) { reason = (err as Error).message; }
      });
    }
    check(`reserved name refused: ${name}`, !availability.available && reason !== 'PUBLISHED!', reason);
  }
  for (const bad of ['ab', 'has space', 'UPPER_CASE!', '-leading', 'trailing-']) {
    const availability = await asOrg(() => siteBuilderService.subdomainAvailable(siteId, bad));
    check(`invalid name refused: "${bad}"`, !availability.available);
  }

  // A subdomain taken by one business must be refused to every other — the
  // free plan allows a single website, so this needs a second workspace.
  const otherOrg = await db.organization.create({
    data: { name: `Hub Verify Two ${stamp}`, slug: `hub-verify-${stamp}-two`, currency: 'NGN', status: 'ACTIVE', country: 'NG' },
  });
  otherOrgId = otherOrg.id;
  const taken = await requestContext.run(
    { requestId: `hub-${stamp}-two`, organizationId: otherOrgId, userId },
    async () => {
      const theirSite = await siteBuilderService.create({ name: `Verify Site Two ${stamp}`, mode: 'BLANK' } as never) as { id: string };
      otherSiteId = theirSite.id;
      return siteBuilderService.subdomainAvailable(theirSite.id, sub);
    },
  );
  check('a subdomain in use by another business is refused',
    !taken.available && taken.reason === 'Already in use', JSON.stringify(taken));

  // An unpublished website must stop answering.
  await asOrg(() => siteBuilderService.unpublish(siteId));
  const { sitePublicService } = await import('../../src/application/sites/site-public.service');
  const gone = await sitePublicService.resolve(sub, '', 'subdomain');
  check('an unpublished website is no longer served publicly', gone === null);

  console.log(`\n${passed} passed, ${failed} failed`);
}

async function cleanup() {
  flags(null);
  if (!orgId) return;

  /*
   * Take any website down before anything else.
   *
   * This suite publishes against whatever deployment configuration the
   * platform already has, which in a real environment is the live one — so an
   * aborted run would otherwise leave a throwaway site answering on a real
   * hostname. Unpublishing first means that is true for the shortest possible
   * time, and does not depend on the deletes below succeeding.
   */
  await db.site.updateMany({
    where: { organizationId: { in: [orgId, otherOrgId].filter(Boolean) }, status: 'PUBLISHED' },
    data: { status: 'UNPUBLISHED', unpublishedAt: new Date() },
  }).catch(() => undefined);

  /*
   * Deleted one statement at a time rather than in a transaction.
   *
   * Several of these foreign keys are RESTRICT, so one unexpected child row
   * used to abort the whole transaction and leave *everything* behind,
   * including the published site. Independent statements mean a surprise costs
   * one table, and the ones that matter most are ordered first.
   */
  const steps: [string, () => Promise<unknown>][] = [
    ['siteEvent', () => db.siteEvent.deleteMany({ where: { organizationId: orgId } })],
    ['siteVersion', () => db.siteVersion.deleteMany({ where: { organizationId: orgId } })],
    ['sitePage', () => db.sitePage.deleteMany({ where: { organizationId: { in: [orgId, otherOrgId].filter(Boolean) } } })],
    ['site', () => db.site.deleteMany({ where: { organizationId: { in: [orgId, otherOrgId].filter(Boolean) } } })],
    ['campaignRecipient', () => db.campaignRecipient.deleteMany({ where: { campaign: { organizationId: orgId } } })],
    ['campaign', () => db.campaign.deleteMany({ where: { organizationId: orgId } })],
    ['stockMovement', () => db.stockMovement.deleteMany({ where: { organizationId: orgId } })],
    ['orderStatusHistory', () => db.orderStatusHistory.deleteMany({ where: { order: { organizationId: orgId } } })],
    ['orderItem', () => db.orderItem.deleteMany({ where: { order: { organizationId: orgId } } })],
    ['paymentIntent', () => db.paymentIntent.deleteMany({ where: { organizationId: orgId } })],
    ['order', () => db.order.deleteMany({ where: { organizationId: orgId } })],
    ['customer', () => db.customer.deleteMany({ where: { organizationId: orgId } })],
    ['productImage', () => db.productImage.deleteMany({ where: { product: { organizationId: orgId } } })],
    ['file', () => db.file.deleteMany({ where: { organizationId: orgId } })],
    ['stockLevel', () => db.stockLevel.deleteMany({ where: { organizationId: orgId } })],
    ['productVariant', () => db.productVariant.deleteMany({ where: { product: { organizationId: orgId } } })],
    ['product', () => db.product.deleteMany({ where: { organizationId: orgId } })],
    ['warehouse', () => db.warehouse.deleteMany({ where: { organizationId: { in: [orgId, otherOrgId].filter(Boolean) } } })],
    ['channelAccount', () => db.channelAccount.deleteMany({ where: { organizationId: orgId } })],
    ['addOnPurchase', () => db.addOnPurchase.deleteMany({ where: { organizationId: orgId } })],
    ['organization', () => db.organization.deleteMany({ where: { id: { in: [orgId, otherOrgId].filter(Boolean) } } })],
    ['user', () => db.user.deleteMany({ where: { id: userId } })],
  ];
  for (const [name, run] of steps) {
    try { await run(); } catch (err) { console.log(`  (cleanup: ${name} left rows — ${(err as Error).message.split('\n')[0]})`); }
  }

  // Only ever remove a configuration this run created. An existing one is the
  // platform's, and deleting it would take every published website down.
  if (createdConfigId) {
    await db.domainConfig.delete({ where: { id: createdConfigId } }).catch(() => undefined);
  }
}

main()
  .catch((err) => { failed++; console.error('\nFATAL', err); })
  .finally(async () => { await cleanup(); await db.$disconnect(); process.exit(failed === 0 ? 0 : 1); });
