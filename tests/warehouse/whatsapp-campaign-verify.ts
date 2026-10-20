/*
 * WhatsApp marketing campaigns, end to end, against a stubbed Meta.
 *
 * The acceptance criterion this exists to prove: a business can connect
 * WhatsApp and receive messages without adding a payment method, and is only
 * asked for one when it tries to send its first campaign — at which point the
 * campaign stops rather than hammering Meta, and resumes without re-sending
 * anyone once billing is fixed.
 *
 * Meta is stubbed. No real WhatsApp account is touched, and the organization
 * is removed at the end.
 */
import { createServer, type Server } from 'node:http';
import { prismaUnscoped as db } from '../../src/infrastructure/database/prisma';
import { requestContext } from '../../src/shared/context';
import { encrypt } from '../../src/shared/crypto';
import { whatsappCampaignService } from '../../src/application/messaging/whatsapp-campaign.service';
import { audienceService } from '../../src/application/messaging/audience.service';
import { whatsappBillingService } from '../../src/application/inbox/whatsapp-billing.service';
import { runScheduledCampaigns } from '../../src/application/messaging/campaign-scheduler';

let passed = 0, failed = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); }
};

const stamp = Date.now();
const PORT = 4977;
let orgId = '', otherOrgId = '', userId = '', accountId = '', otherAccountId = '';
let server: Server | null = null;

/** What the stubbed Meta does next: succeed, or refuse for a given reason. */
let metaMode: 'ok' | 'billing' | 'billing_after_first' | 'template' | 'rate_limit' = 'ok';
let sendCount = 0;

const asOrg = <T>(fn: () => Promise<T>, organizationId = orgId) =>
  requestContext.run({ requestId: `wac-${stamp}`, organizationId, userId }, fn);

const TEMPLATES = [{
  name: 'seasonal_offer', language: 'en_US', category: 'MARKETING', status: 'APPROVED',
  components: [{ type: 'BODY', text: 'Hi {{1}}, enjoy {{2}} off this week.', example: { body_text: [['Ada', '20%']] } }],
}, {
  name: 'paused_offer', language: 'en_US', category: 'MARKETING', status: 'PAUSED',
  components: [{ type: 'BODY', text: 'Hello {{1}}' }],
}];

async function startStubMeta() {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url?.includes('/messages')) {
        sendCount += 1;
        if (metaMode === 'billing' || (metaMode === 'billing_after_first' && sendCount > 1)) {
          res.statusCode = 400;
          return res.end(JSON.stringify({ error: { code: 131042, error_subcode: 2494055, message: 'Business eligibility payment issue', type: 'OAuthException' } }));
        }
        if (metaMode === 'template') {
          res.statusCode = 400;
          return res.end(JSON.stringify({ error: { code: 132001, message: 'Template name does not exist', type: 'OAuthException' } }));
        }
        if (metaMode === 'rate_limit') {
          res.statusCode = 429;
          return res.end(JSON.stringify({ error: { code: 131048, message: 'Spam rate limit hit', type: 'OAuthException' } }));
        }
        return res.end(JSON.stringify({ messages: [{ id: `wamid.stub${sendCount}` }] }));
      }
      res.end(JSON.stringify({ data: TEMPLATES, account_review_status: 'APPROVED' }));
    });
  });
  await new Promise<void>((resolve) => server!.listen(PORT, '127.0.0.1', resolve));
  // META_GRAPH_BASE_URL must already point here: env is read at import time,
  // so the runner sets it rather than this function.
}

async function makeCustomer(organizationId: string, firstName: string, phone: string | null, opts: { optIn?: boolean; orders?: number; spend?: number } = {}) {
  const customer = await db.customer.create({
    data: {
      organizationId, firstName, lastName: 'Test', phone,
      marketingOptIn: opts.optIn ?? true,
    },
  });
  for (let i = 0; i < (opts.orders ?? 0); i += 1) {
    await db.order.create({
      data: {
        organizationId, customerId: customer.id,
        number: `TST-${stamp}-${customer.id.slice(-4)}-${i}`,
        status: 'COMPLETED', paymentStatus: 'PAID',
        total: (opts.spend ?? 100) / (opts.orders ?? 1),
      },
    });
  }
  return customer;
}

async function main() {
  await startStubMeta();

  orgId = (await db.organization.create({ data: { name: `WA Camp ${stamp}`, slug: `wa-camp-${stamp}`, currency: 'NGN', status: 'ACTIVE', country: 'NG' } })).id;
  otherOrgId = (await db.organization.create({ data: { name: `WA Other ${stamp}`, slug: `wa-other-${stamp}`, currency: 'NGN', status: 'ACTIVE', country: 'NG' } })).id;
  userId = (await db.user.create({ data: { email: `wa-camp-${stamp}@example.invalid`, firstName: 'W', lastName: 'C', passwordHash: 'x' } })).id;

  const credentials = encrypt(JSON.stringify({ accessToken: 'stub-token', phoneNumberId: '1234567890', wabaId: 'waba-stub', appId: 'app', appSecret: 'secret' }));
  accountId = (await db.channelAccount.create({
    data: {
      organizationId: orgId, channelType: 'WHATSAPP', name: 'Shop WhatsApp', externalId: `wa-${stamp}`,
      purpose: 'MARKETING', isActive: true, status: 'CONNECTED', credentialsEnc: credentials,
      metadata: { wabaId: 'waba-stub', wabaName: 'Shop WABA', displayPhoneNumber: '+234 800 000 0000', messageTemplates: TEMPLATES },
    },
  })).id;
  otherAccountId = (await db.channelAccount.create({
    data: {
      organizationId: otherOrgId, channelType: 'WHATSAPP', name: 'Other WhatsApp', externalId: `wa-other-${stamp}`,
      purpose: 'MARKETING', isActive: true, status: 'CONNECTED', credentialsEnc: credentials,
      metadata: { wabaId: 'waba-other', messageTemplates: TEMPLATES },
    },
  })).id;

  // A spread of customers the segments should tell apart.
  await makeCustomer(orgId, 'Ada', '08030000001', { orders: 3, spend: 900 });     // repeat, valuable
  await makeCustomer(orgId, 'Bola', '08030000002', { orders: 1, spend: 100 });    // first time
  await makeCustomer(orgId, 'Chidi', '08030000003', { orders: 0 });               // never purchased
  await makeCustomer(orgId, 'Dami', '08030000004', { orders: 1, optIn: false });  // opted out
  await makeCustomer(orgId, 'Efe', null, { orders: 1 });                          // no phone
  /*
   * The same number written differently. A unique constraint on
   * (organizationId, phone) stops two identical strings, but these two are
   * distinct strings that normalise to one WhatsApp id — which is the
   * duplicate that actually reaches a campaign.
   */
  await makeCustomer(orgId, 'Femi', '+2348030000001', { orders: 1 });

  // Another business, with its own customers. Without these the isolation
  // checks below would pass against an empty table and prove nothing.
  await makeCustomer(otherOrgId, 'Other-A', '08099000001', { orders: 2, spend: 5000 });
  await makeCustomer(otherOrgId, 'Other-B', '08099000002', { orders: 0 });
  await makeCustomer(otherOrgId, 'Other-C', '08099000003', { orders: 1, spend: 250 });

  // ── 1. Connecting and receiving needs no billing ─────────────────────────
  console.log('\nConnecting WhatsApp without billing');
  const billingAtConnect = await whatsappBillingService.status(accountId, orgId);
  check('a newly connected account is not marked as needing billing', billingAtConnect.state === 'UNKNOWN', billingAtConnect.state);
  check('and nothing is shown to the business about it', billingAtConnect.message === null);
  const account = await db.channelAccount.findUniqueOrThrow({ where: { id: accountId } });
  check('the channel is active and able to receive', account.isActive && account.status === 'CONNECTED');

  // ── 2. Segmentation ──────────────────────────────────────────────────────
  console.log('\nSegments and eligibility');
  const all = await audienceService.resolve(orgId, { kind: 'ALL_ELIGIBLE' });
  check('the audience holds only this business\'s customers',
    !all.members.some((m) => m.firstName?.startsWith('Other-')),
    `leaked: ${all.members.filter((m) => m.firstName?.startsWith('Other-')).map((m) => m.firstName).join(', ')}`);
  check('opt-outs, missing numbers and duplicates are all excluded',
    all.excluded.optedOut === 1 && all.excluded.noPhone === 1 && all.excluded.duplicate === 1,
    JSON.stringify(all.excluded));
  check('the reachable audience is what is left', all.members.length === 3, `${all.members.length}`);
  check('numbers are normalised the way Meta wants them',
    all.members.every((m) => /^234\d+$/.test(m.waId)), all.members.map((m) => m.waId).join(','));

  const never = await audienceService.resolve(orgId, { kind: 'NEVER_PURCHASED' });
  check('"never purchased" finds only the customer with no orders',
    never.members.length === 1 && never.members[0]!.firstName === 'Chidi');
  const repeat = await audienceService.resolve(orgId, { kind: 'REPEAT', minOrders: 2 });
  check('"repeat" finds only the multi-order customer',
    repeat.members.length === 1 && repeat.members[0]!.firstName === 'Ada');
  const valuable = await audienceService.resolve(orgId, { kind: 'MOST_VALUABLE', topCount: 1 });
  check('"most valuable" ranks by completed spend',
    valuable.members.length === 1 && valuable.members[0]!.firstName === 'Ada');
  const firstTime = await audienceService.resolve(orgId, { kind: 'FIRST_TIME', withinDays: 30 });
  check('"first time" covers everyone who bought in the window', firstTime.members.length >= 1);
  const inactive = await audienceService.resolve(orgId, { kind: 'INACTIVE', inactiveDays: 1 });
  check('"inactive" never includes someone who never bought',
    !inactive.members.some((m) => m.firstName === 'Chidi'));

  // ── 3. Templates ─────────────────────────────────────────────────────────
  console.log('\nTemplates');
  const paused = await asOrg(() => whatsappCampaignService.preview({
    channelAccountId: accountId, templateName: 'paused_offer', templateLanguage: 'en_US',
    variables: { '1': 'Ada' }, segment: { kind: 'ALL_ELIGIBLE' },
  })).catch((e) => e);
  check('a paused template cannot be used', paused instanceof Error, 'a paused template was accepted');

  const missingVariable = await asOrg(() => whatsappCampaignService.preview({
    channelAccountId: accountId, templateName: 'seasonal_offer', templateLanguage: 'en_US',
    variables: { '1': 'Ada' }, segment: { kind: 'ALL_ELIGIBLE' },
  })).catch((e) => e);
  check('a missing variable is refused rather than left blank', missingVariable instanceof Error);

  const preview = await asOrg(() => whatsappCampaignService.preview({
    channelAccountId: accountId, templateName: 'seasonal_offer', templateLanguage: 'en_US',
    variables: { '1': 'Ada', '2': '20%' }, segment: { kind: 'ALL_ELIGIBLE' },
  }));
  check('the preview renders the final message', preview.template.preview === 'Hi Ada, enjoy 20% off this week.', preview.template.preview);
  check('and reports the audience it will reach', preview.audience.count === 3);
  check('cost is reported unavailable rather than invented',
    preview.estimate.available === false && Boolean(preview.estimate.unavailableReason));

  // ── 4. Tenant isolation ──────────────────────────────────────────────────
  console.log('\nTenant isolation');
  const crossTenant = await asOrg(() => whatsappCampaignService.preview({
    channelAccountId: otherAccountId, templateName: 'seasonal_offer', templateLanguage: 'en_US',
    variables: { '1': 'x', '2': 'y' }, segment: { kind: 'ALL_ELIGIBLE' },
  })).catch((e) => e);
  check('another business\'s WhatsApp account cannot be used', crossTenant instanceof Error, 'cross-tenant send was allowed');

  // ── 5. The first campaign hits the billing wall ──────────────────────────
  console.log('\nFirst campaign, with no payment method at Meta');
  metaMode = 'billing_after_first';
  sendCount = 0;
  const campaign = await asOrg(() => whatsappCampaignService.launch({
    name: 'Seasonal push', channelAccountId: accountId,
    templateName: 'seasonal_offer', templateLanguage: 'en_US',
    variables: { '1': 'there', '2': '20%' }, segment: { kind: 'ALL_ELIGIBLE' },
  }));
  const afterBilling = await asOrg(() => whatsappCampaignService.report(campaign.id));
  check('the campaign stops instead of finishing', afterBilling.status === 'PARTIALLY_SENT', afterBilling.status);
  check('it stopped at the refusal rather than trying everyone', sendCount === 2, `${sendCount} sends attempted`);
  check('the reason given names billing', /payment method/i.test(afterBilling.haltReason ?? ''), afterBilling.haltReason ?? '');
  const billingNow = await whatsappBillingService.status(accountId, orgId);
  check('the account is now recorded as needing billing', billingNow.state === 'BILLING_REQUIRED');
  check('with Meta\'s code kept for support', billingNow.metaCode === 131042);
  check('and the prompt points at Meta\'s own documented page',
    billingNow.setupUrl === 'https://business.facebook.com/wa/manage/home/');
  check('the one that got through is recorded as sent', (afterBilling.stats as { sent: number }).sent === 1, JSON.stringify(afterBilling.stats));

  // ── 6. Receiving still works ─────────────────────────────────────────────
  console.log('\nInbound is unaffected by the billing block');
  const stillActive = await db.channelAccount.findUniqueOrThrow({ where: { id: accountId } });
  check('the channel was not deactivated', stillActive.isActive);
  check('and was not marked disconnected', stillActive.status === 'CONNECTED');

  // ── 7. Resume after the business fixes billing ───────────────────────────
  console.log('\nResuming once billing is sorted');
  metaMode = 'ok';
  sendCount = 0;
  const resumed = await asOrg(() => whatsappCampaignService.resume(campaign.id));
  const afterResume = await asOrg(() => whatsappCampaignService.report(campaign.id));
  check('the campaign completes', resumed.status === 'SENT', resumed.status);
  check('everyone eligible ends up reached', (afterResume.stats as { sent: number }).sent === 3, JSON.stringify(afterResume.stats));
  check('the already-delivered recipient was not messaged again',
    sendCount === 2, `${sendCount} sends on resume, expected the 2 who never received one`);
  check('Meta message ids were recorded', afterResume.recipients.filter((r) => r.providerMessageId).length === 3);
  const billingAfter = await whatsappBillingService.status(accountId, orgId);
  check('a successful paid send clears the billing block', billingAfter.state === 'READY', billingAfter.state);

  // ── 8. A template failure must not look like billing ─────────────────────
  console.log('\nA template failure is not a billing failure');
  metaMode = 'template';
  const second = await asOrg(() => whatsappCampaignService.launch({
    name: 'Template trouble', channelAccountId: accountId,
    templateName: 'seasonal_offer', templateLanguage: 'en_US',
    variables: { '1': 'there', '2': '20%' }, segment: { kind: 'ALL_ELIGIBLE' },
  }));
  const templateReport = await asOrg(() => whatsappCampaignService.report(second.id));
  check('the campaign halts', templateReport.status === 'PARTIALLY_SENT', templateReport.status);
  check('and says it was the template', /template/i.test(templateReport.haltReason ?? ''), templateReport.haltReason ?? '');
  const billingUnchanged = await whatsappBillingService.status(accountId, orgId);
  check('the billing state is left alone', billingUnchanged.state === 'READY', billingUnchanged.state);

  // ── 9. Cancellation ──────────────────────────────────────────────────────
  console.log('\nCancellation');
  const cancelled = await asOrg(() => whatsappCampaignService.cancel(second.id));
  check('a halted campaign can be cancelled', cancelled.status === 'CANCELLED');
  const resumeCancelled = await asOrg(() => whatsappCampaignService.resume(second.id)).catch((e) => e);
  check('and cannot then be resumed', resumeCancelled instanceof Error);

  // ── 10. The same segments, on the other channels ─────────────────────────
  /*
   * Email and SMS campaigns could only target "everyone opted in" or a list
   * picked by hand, so reaching lapsed customers meant exporting a
   * spreadsheet. The segment engine is channel-agnostic; only eligibility
   * differs, and it must differ in the right direction.
   */
  console.log('\nSegments work for email and SMS too');
  await db.customer.update({ where: { id: (await db.customer.findFirstOrThrow({ where: { organizationId: orgId, firstName: 'Ada' } })).id }, data: { email: 'ada@example.invalid' } });
  const emailAudience = await audienceService.resolve(orgId, { kind: 'ALL_ELIGIBLE' }, 'EMAIL');
  check('an email campaign reaches only customers with an address',
    emailAudience.members.length === 1 && emailAudience.members[0]!.address === 'ada@example.invalid',
    `${emailAudience.members.length} reachable: ${emailAudience.members.map((m) => m.address).join(', ')}`);
  check('the ones without an address are reported, not silently dropped',
    emailAudience.excluded.noPhone > 0, JSON.stringify(emailAudience.excluded));

  const smsAudience = await audienceService.resolve(orgId, { kind: 'REPEAT', minOrders: 2 }, 'SMS');
  check('an SMS campaign uses the same segment with phone eligibility',
    smsAudience.members.length === 1 && /^234/.test(smsAudience.members[0]!.address),
    smsAudience.members.map((m) => m.address).join(','));

  const custom = await audienceService.resolve(orgId, {
    kind: 'CUSTOM', custom: { minOrders: 2, minSpend: 500 },
  }, 'WHATSAPP');
  check('a custom segment combines the filters it was given',
    custom.members.length === 1 && custom.members[0]!.firstName === 'Ada',
    custom.members.map((m) => m.firstName).join(','));
  const impossible = await audienceService.resolve(orgId, {
    kind: 'CUSTOM', custom: { minSpend: 1_000_000 },
  }, 'WHATSAPP');
  check('and excludes everyone when nothing matches', impossible.members.length === 0);

  // ── 11. A scheduled WhatsApp campaign actually goes out ──────────────────
  /*
   * `scheduledAt` was stored and the sweep only ever called the generic
   * sender, which knows nothing about templates or billing — so a scheduled
   * WhatsApp campaign would sit at SCHEDULED for ever.
   */
  console.log('\nScheduled WhatsApp campaigns are picked up');
  metaMode = 'ok';
  sendCount = 0;
  const scheduled = await asOrg(() => whatsappCampaignService.launch({
    name: 'Scheduled push', channelAccountId: accountId,
    templateName: 'seasonal_offer', templateLanguage: 'en_US',
    variables: { '1': 'there', '2': '20%' }, segment: { kind: 'ALL_ELIGIBLE' },
    scheduledAt: new Date(Date.now() - 60_000).toISOString(),
  }));
  check('it starts out scheduled, not sending', scheduled.status === 'SCHEDULED', scheduled.status);
  check('and nothing was sent yet', sendCount === 0, `${sendCount}`);
  // Scoped to this test's own business: a platform-wide sweep against a
  // shared database could fire somebody else's scheduled campaign.
  const swept = await runScheduledCampaigns(new Date(), orgId);
  const afterSweep = await asOrg(() => whatsappCampaignService.report(scheduled.id));
  check('the sweep sends it', afterSweep.status === 'SENT', `${afterSweep.status} (swept ${swept.sent})`);
  check('to the whole segment', sendCount === 3, `${sendCount} sends`);

  await cleanup();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

async function cleanup() {
  server?.close();
  for (const id of [orgId, otherOrgId].filter(Boolean)) {
    const campaigns = await db.campaign.findMany({ where: { organizationId: id }, select: { id: true } });
    await db.campaignRecipient.deleteMany({ where: { campaignId: { in: campaigns.map((c) => c.id) } } }).catch(() => {});
    for (const t of ['campaign', 'order', 'customer', 'channelAccount', 'activity', 'auditLog', 'usageCounter'] as const) {
      await (db as any)[t]?.deleteMany({ where: { organizationId: id } }).catch(() => {});
    }
    await db.organization.delete({ where: { id } }).catch(() => {});
  }
  await db.user.delete({ where: { id: userId } }).catch(() => {});
}

main().catch(async (e) => { console.error(e); await cleanup(); process.exit(1); });
