/*
 * SMS campaigns, on top of the existing campaign engine.
 *
 * Two bugs made SMS campaigns quietly wrong before this. Reachability required
 * a CustomerIdentity of type SMS, which only exists once a customer has texted
 * *in* — so an outbound campaign to a customer list found almost nobody. And
 * the cost was quoted per recipient, so a two-segment campaign was priced at
 * half what the network would charge.
 *
 * The third thing under test is that a campaign goes through the SMS module
 * rather than around it: reservation, suppression and Sender ID all apply, or
 * a campaign becomes the one way to bypass them.
 */
import { prismaUnscoped as db } from '../../src/infrastructure/database/prisma';
import { requestContext } from '../../src/shared/context';
import { campaignService } from '../../src/application/messaging/campaign.service';
import { senderIdService } from '../../src/application/sms/sender-id.service';
import { setPricingForTesting } from '../../src/application/billing/sms-wallet.service';
import { smsSendService } from '../../src/application/sms/sms-send.service';
import { setSmsProviderForTesting } from '../../src/infrastructure/sms/registry';
import { MockSmsProvider } from '../../src/infrastructure/sms/mock.provider';

let passed = 0, failed = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); }
};

const stamp = Date.now();
let orgId = '', senderId = '';
let provider: MockSmsProvider;

const as = <T>(fn: () => Promise<T>): Promise<T> =>
  requestContext.run({ requestId: `c-${stamp}`, organizationId: orgId } as never, fn);

const balance = async () => Number(
  (await db.smsWallet.findFirstOrThrow({ where: { organizationId: orgId } })).balance,
);

async function main() {
  orgId = (await db.organization.create({
    data: { name: 'Camp Co', slug: `camp-${stamp}`, currency: 'NGN', status: 'ACTIVE', country: 'NG' },
  })).id;
  provider = new MockSmsProvider();
  setSmsProviderForTesting(provider);
  // Pinned for the same reason as the sending suite: a zero-cost admin
  // configuration would make the segment assertions pass without meaning it.
  setPricingForTesting({
    currency: 'NGN',
    unitCost: 4,
    channels: {
      SMS: { enabled: true, unitCost: 4 },
      EMAIL: { enabled: true, unitCost: 1 },
      WHATSAPP: { enabled: true, unitCost: 6 },
    },
    lowBalanceThreshold: 500,
    packages: [{ id: 'starter', name: 'Starter', credits: 250, price: 1000 }],
  });

  // Customers with phones who have never texted in — the ordinary case.
  for (let i = 0; i < 6; i++) {
    await db.customer.create({
      data: {
        organizationId: orgId,
        firstName: `Cust${i}`, lastName: 'Test',
        phone: `080300${String(70000 + i).padStart(5, '0')}`,
        marketingOptIn: true,
      },
    });
  }
  // One who has opted out at the customer level.
  await db.customer.create({
    data: {
      organizationId: orgId, firstName: 'OptedOut', lastName: 'Test',
      phone: '08030079999', marketingOptIn: false,
    },
  });

  await as(async () => {
    const s = await senderIdService.request(orgId, { value: 'CAMPCO' });
    await senderIdService.submit(s.id);
    await senderIdService.decide(s.id, 'APPROVED', {});
    senderId = s.id;
  });
  await db.smsWallet.upsert({
    where: { organizationId: orgId },
    create: { organizationId: orgId, balance: 10_000, currency: 'NGN' },
    update: { balance: 10_000 },
  });

  // ── 1. Reachability ──────────────────────────────────────────────────────
  console.log('\nAnyone with a phone number can be reached');
  await as(async () => {
    const reachable = await campaignService.reachableCustomers('SMS');
    check('customers who never texted in are reachable', reachable.length === 6,
      `found ${reachable.length} — requiring an SMS identity found almost nobody`);
    check('and their phone number comes with them',
      reachable.every((c) => Boolean(c.phone)));
    check('the opted-out customer is excluded',
      !reachable.some((c) => c.firstName === 'OptedOut'));
  });

  // ── 2. Quoting ───────────────────────────────────────────────────────────
  console.log('\nA campaign is quoted by segments');
  let campaignId = '';
  await as(async () => {
    const created = await campaignService.create({
      name: 'Long campaign',
      type: 'SMS',
      body: 'x'.repeat(200),
      audience: 'ALL_OPTED_IN',
      recipientIds: [],
      templateLanguage: 'en_US',
    } as never);
    campaignId = created.id;
    check('it starts as a draft', created.status === 'DRAFT');
  });

  // ── 3. Sending goes through the SMS module ───────────────────────────────
  console.log('\nSending uses the SMS path, not a loop around it');
  await as(async () => {
    const before = await balance();
    provider.outbox.length = 0;

    await campaignService.send(campaignId);
    const after = await db.campaign.findFirstOrThrow({
      where: { id: campaignId }, select: { status: true, stats: true },
    });
    check('the campaign completes', after.status === 'SENT');

    const stats = after.stats as { sent: number; segments: number; cost: number };
    check('six customers were reached', stats.sent === 6, String(stats.sent));
    check('and charged twelve segments, not six', stats.segments === 12,
      'a 200-character message is two segments each');
    check('the balance moved by the segment cost',
      before - (await balance()) === stats.cost);
    check('the provider actually received them', provider.outbox.length === 6);
    check('under the approved Sender ID', provider.outbox[0]?.senderId === 'CAMPCO');
    check('on the promotional route', provider.outbox[0]?.route === 'PROMOTIONAL');
  });

  // ── 4. Suppression applies to campaigns too ──────────────────────────────
  console.log('\nAn opt-out is honoured by a campaign, not just a direct send');
  await as(async () => {
    await smsSendService.suppress(orgId, '+2348030070000', 'Replied STOP');
    provider.outbox.length = 0;

    const second = await campaignService.create({
      name: 'Second campaign', type: 'SMS', body: 'Short one',
      audience: 'ALL_OPTED_IN', recipientIds: [], templateLanguage: 'en_US',
    } as never);
    await campaignService.send(second.id);

    const stats = (await db.campaign.findFirstOrThrow({
      where: { id: second.id }, select: { stats: true },
    })).stats as { sent: number; suppressed: number };
    check('the suppressed number is dropped', stats.suppressed === 1);
    check('and the rest still go', stats.sent === 5);
    check('the provider never saw it',
      !provider.outbox.some((o) => o.to === '+2348030070000'),
      'a campaign must not be the way round an opt-out');
  });

  // ── 5. Messages are on the record ────────────────────────────────────────
  console.log('\nCampaign messages appear in SMS history');
  {
    const messages = await db.smsMessage.findMany({
      where: { organizationId: orgId, campaignId: { not: null } },
      select: { campaignId: true, route: true, segments: true },
    });
    check('they are recorded against their campaign', messages.length > 0);
    check('as marketing', messages.every((m) => m.route === 'PROMOTIONAL'));
  }

  setSmsProviderForTesting(null);
  setPricingForTesting(null);
  await cleanup();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

async function cleanup() {
  await db.campaignRecipient.deleteMany({ where: { campaign: { organizationId: orgId } } }).catch(() => {});
  await db.campaign.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.smsMessage.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.smsSuppression.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.senderId.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.smsWalletTransaction.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.smsWallet.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.activity.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.customerIdentity.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.customer.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.auditLog.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.organization.delete({ where: { id: orgId } }).catch(() => {});
}

main().catch(async (e) => { console.error(e); await cleanup(); process.exit(1); });
