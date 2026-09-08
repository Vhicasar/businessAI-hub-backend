/*
 * Scheduling a campaign for later.
 *
 * `scheduledAt` had been stored since campaigns existed and nothing ever read
 * it: a business could pick a date, save, watch the status say SCHEDULED, and
 * the campaign would sit there for ever. That is worse than not offering
 * scheduling at all, because it looked like it worked.
 *
 * Also covers the platform's ceiling on one send, which was configurable in
 * admin but enforced nowhere — a safeguard that does nothing is worse than an
 * absent one.
 */
import { prismaUnscoped as db } from '../../src/infrastructure/database/prisma';
import { requestContext } from '../../src/shared/context';
import { runScheduledCampaigns } from '../../src/application/messaging/campaign-scheduler';
import { campaignService } from '../../src/application/messaging/campaign.service';
import { senderIdService } from '../../src/application/sms/sender-id.service';
import { smsSendService } from '../../src/application/sms/sms-send.service';
import { setPricingForTesting } from '../../src/application/billing/sms-wallet.service';
import { setSmsProviderForTesting } from '../../src/infrastructure/sms/registry';
import { MockSmsProvider } from '../../src/infrastructure/sms/mock.provider';

let passed = 0, failed = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); }
};
const rejects = async (fn: () => Promise<unknown>, match: RegExp): Promise<boolean> => {
  try { await fn(); return false; } catch (e) { return match.test((e as Error).message); }
};

const stamp = Date.now();
let orgId = '';
let provider: MockSmsProvider;

const as = <T>(fn: () => Promise<T>): Promise<T> =>
  requestContext.run({ requestId: `sch-${stamp}`, organizationId: orgId } as never, fn);

const basePricing = (maxCampaignSize?: number) => ({
  currency: 'NGN',
  unitCost: 4,
  channels: {
    SMS: { enabled: true, unitCost: 4 },
    EMAIL: { enabled: true, unitCost: 1 },
    WHATSAPP: { enabled: true, unitCost: 6 },
  },
  lowBalanceThreshold: 500,
  packages: [{ id: 'starter', name: 'Starter', credits: 250, price: 1000 }],
  ...(maxCampaignSize ? { maxCampaignSize } : {}),
});

const makeCampaign = (name: string, scheduledAt: Date | null) =>
  db.campaign.create({
    data: {
      organizationId: orgId,
      name,
      type: 'SMS',
      status: scheduledAt ? 'SCHEDULED' : 'DRAFT',
      scheduledAt,
      content: { body: 'Short message', audience: 'ALL_OPTED_IN', recipientIds: [] },
    },
    select: { id: true },
  });

const statusOf = async (id: string) =>
  (await db.campaign.findFirstOrThrow({ where: { id }, select: { status: true } })).status;

async function main() {
  orgId = (await db.organization.create({
    data: { name: 'Sched Co', slug: `sched-${stamp}`, currency: 'NGN', status: 'ACTIVE', country: 'NG' },
  })).id;
  provider = new MockSmsProvider();
  setSmsProviderForTesting(provider);
  setPricingForTesting(basePricing() as never);

  for (let i = 0; i < 3; i++) {
    await db.customer.create({
      data: {
        organizationId: orgId, firstName: `S${i}`, lastName: 'T',
        phone: `080300${String(90000 + i).padStart(5, '0')}`, marketingOptIn: true,
      },
    });
  }
  await as(async () => {
    const s = await senderIdService.request(orgId, { value: 'SCHEDCO' });
    await senderIdService.submit(s.id);
    await senderIdService.decide(s.id, 'APPROVED', {});
  });
  await db.smsWallet.upsert({
    where: { organizationId: orgId },
    create: { organizationId: orgId, balance: 10_000, currency: 'NGN' },
    update: { balance: 10_000 },
  });

  // ── 1. A campaign whose time has not come ────────────────────────────────
  console.log('\nA campaign scheduled for later waits');
  {
    const future = await makeCampaign('Tomorrow', new Date(Date.now() + 3_600_000));
    provider.outbox.length = 0;
    await runScheduledCampaigns();
    check('it is left alone', await statusOf(future.id) === 'SCHEDULED');
    check('and nothing was sent', provider.outbox.length === 0);
  }

  // ── 2. A campaign whose time has come ────────────────────────────────────
  console.log('\nA campaign whose moment has arrived goes out');
  {
    const due = await makeCampaign('Now', new Date(Date.now() - 60_000));
    provider.outbox.length = 0;
    await runScheduledCampaigns();
    check('it is sent', await statusOf(due.id) === 'SENT',
      'this is what never happened before — SCHEDULED for ever');
    check('and the messages actually went', provider.outbox.length === 3);
  }

  // ── 3. A campaign that is only slightly late ─────────────────────────────
  console.log('\nA campaign missed by an hour still goes');
  {
    const late = await makeCampaign('Slightly late', new Date(Date.now() - 2 * 3_600_000));
    await runScheduledCampaigns();
    check('a two-hour delay is still sent', await statusOf(late.id) === 'SENT',
      'a service restart should not silently drop a campaign');
  }

  // ── 4. A campaign that is far too late ───────────────────────────────────
  console.log('\nA campaign from last week is not sent behind their back');
  {
    const stale = await makeCampaign('Last week', new Date(Date.now() - 8 * 24 * 3_600_000));
    provider.outbox.length = 0;
    const result = await runScheduledCampaigns();
    check('it is reported as stale', result.stale >= 1);
    check('it is not sent', await statusOf(stale.id) === 'SCHEDULED',
      'the sale is over — sending would cost money to confuse people');
    check('and nothing went out for it', provider.outbox.length === 0);
  }

  // ── 5. A failure leaves it to retry ──────────────────────────────────────
  console.log('\nA campaign that fails is left for the next sweep');
  {
    await db.smsWallet.updateMany({ where: { organizationId: orgId }, data: { balance: 0 } });
    const broke = await makeCampaign('No credit', new Date(Date.now() - 60_000));
    await runScheduledCampaigns();
    check('it stays scheduled rather than failing', await statusOf(broke.id) === 'SCHEDULED',
      'topping up should be enough to make it send, without re-creating it');

    // Fix the cause; the next sweep should send it.
    await db.smsWallet.updateMany({ where: { organizationId: orgId }, data: { balance: 10_000 } });
    await runScheduledCampaigns();
    check('and goes once the problem is fixed', await statusOf(broke.id) === 'SENT');
  }

  // ── 6. The platform's ceiling ────────────────────────────────────────────
  console.log("\nThe platform's limit on one send is enforced");
  await as(async () => {
    setPricingForTesting(basePricing(2) as never);
    check(
      'a send above the ceiling is refused',
      await rejects(
        () => smsSendService.send({
          organizationId: orgId,
          template: 'Hello',
          recipients: [
            { phone: '08030099001' }, { phone: '08030099002' }, { phone: '08030099003' },
          ],
          route: 'PROMOTIONAL',
        }),
        /above the 2 allowed/i,
      ),
      'a limit nothing enforces is worse than no limit',
    );

    const ok = await smsSendService.send({
      organizationId: orgId,
      template: 'Hello',
      recipients: [{ phone: '08030099001' }, { phone: '08030099002' }],
      route: 'PROMOTIONAL',
    });
    check('and one at the ceiling is allowed', ok.queued === 2);
    setPricingForTesting(basePricing() as never);
  });

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
  await db.customer.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.auditLog.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.organization.delete({ where: { id: orgId } }).catch(() => {});
}

main().catch(async (e) => { console.error(e); await cleanup(); process.exit(1); });
