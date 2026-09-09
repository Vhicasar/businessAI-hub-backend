/*
 * Sending SMS safely: money, opt-outs, and receipts.
 *
 * The failure this design exists to prevent is a business starting a
 * 5,000-recipient campaign with credit for 400 and finding out four hundred
 * messages in — half-sent, and impossible to explain to a customer. So the
 * whole cost is held before anything leaves, and what the provider refuses is
 * given back.
 *
 * The other half is that money and consent have to survive a provider doing
 * its worst: rejecting some numbers, failing entirely, and redelivering the
 * same receipt three times.
 */
import { prismaUnscoped as db } from '../../src/infrastructure/database/prisma';
import { requestContext } from '../../src/shared/context';
import { smsSendService, renderTemplate } from '../../src/application/sms/sms-send.service';
import { setPricingForTesting, smsWalletService } from '../../src/application/billing/sms-wallet.service';
import { senderIdService } from '../../src/application/sms/sender-id.service';
import { setSmsProviderForTesting } from '../../src/infrastructure/sms/registry';
import { MockSmsProvider } from '../../src/infrastructure/sms/mock.provider';
import type { SmsProvider } from '../../src/application/sms/sms-provider';

let passed = 0, failed = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); }
};
const rejects = async (fn: () => Promise<unknown>, match: RegExp): Promise<boolean> => {
  try { await fn(); return false; } catch (e) { return match.test((e as Error).message); }
};

const stamp = Date.now();
let orgId = '', senderId = '';
let provider: MockSmsProvider;

const as = <T>(fn: () => Promise<T>): Promise<T> =>
  requestContext.run({ requestId: `snd-${stamp}`, organizationId: orgId } as never, fn);

const balance = async (): Promise<number> => {
  const w = await db.smsWallet.findFirstOrThrow({ where: { organizationId: orgId } });
  return Number(w.balance);
};
const setBalance = async (value: number) => {
  await db.smsWallet.updateMany({ where: { organizationId: orgId }, data: { balance: value } });
};

/** N recipients with distinct, valid Nigerian numbers. */
const recipients = (count: number, offset = 1) =>
  Array.from({ length: count }, (_, i) => ({
    phone: `080300${String(offset + i).padStart(5, '0')}`,
    variables: { firstName: `Person${i}` },
  }));

async function main() {
  orgId = (await db.organization.create({
    data: { name: 'SMS Co', slug: `sms-${stamp}`, currency: 'NGN', status: 'ACTIVE', country: 'NG' },
  })).id;

  provider = new MockSmsProvider();
  setSmsProviderForTesting(provider);

  /*
   * Pinned rather than read from the admin.
   *
   * Pricing is synced from whatever the admin deployment is serving, and a
   * zero-cost configuration makes every send free — under which the
   * reservation and refund assertions below pass for entirely the wrong
   * reason. This suite is about the arithmetic, so it states the prices.
   */
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

  await as(async () => {
    const s = await senderIdService.request(orgId, { value: 'SMSCO' });
    await senderIdService.submit(s.id);
    await senderIdService.decide(s.id, 'APPROVED', {});
    senderId = s.id;
  });
  // Seed the wallet by quoting once (which creates it), then setting a balance.
  await as(() => smsWalletService.quoteSms(orgId, ['x']));
  await setBalance(10_000);

  const unitCost = (await smsWalletService.pricing()).channels.SMS.unitCost;

  // ── 1. Variables ─────────────────────────────────────────────────────────
  console.log('\nVariables resolve before anything is counted');
  {
    check('a variable is filled in',
      renderTemplate('Hi {{firstName}}', { firstName: 'Ada' }) === 'Hi Ada');
    check('spacing inside the braces is tolerated',
      renderTemplate('Hi {{ firstName }}', { firstName: 'Ada' }) === 'Hi Ada');
    check('an unknown variable becomes nothing, not literal braces',
      renderTemplate('Hi {{nickname}}!', {}) === 'Hi !',
      'a customer receiving {{nickname}} is worse than an awkward sentence');
  }

  // ── 2. The preview a business confirms against ───────────────────────────
  console.log('\nThe confirmation screen tells the truth before sending');
  await as(async () => {
    const preview = await smsSendService.preview({
      organizationId: orgId,
      template: 'Hi {{firstName}}, your order is ready',
      recipients: [...recipients(3), { phone: '08030000001' }, { phone: 'nonsense' }],
      route: 'PROMOTIONAL',
    });
    check('duplicates are removed', preview.duplicates === 1,
      '08030000001 appears twice in that list');
    check('invalid numbers are reported', preview.invalid.length === 1);
    check('and the real recipient count is shown', preview.recipients === 3);
    check('with the cost that follows from it',
      preview.estimatedCost === preview.totalSegments * unitCost);
    check('and whether they can afford it', preview.affordable === true);
  });

  // ── 3. Reserve before sending ────────────────────────────────────────────
  console.log('\nThe whole cost is held before anything leaves');
  await as(async () => {
    await setBalance(10_000);
    const before = await balance();
    provider.outbox.length = 0;

    const result = await smsSendService.send({
      organizationId: orgId,
      template: 'Short message',
      recipients: recipients(10, 100),
      route: 'PROMOTIONAL',
      senderIdId: senderId,
    });
    check('all ten were sent', result.queued === 10);
    check('ten segments were charged', result.segments === 10);
    check('and the balance moved by exactly that',
      before - (await balance()) === 10 * unitCost);
    check('the provider actually received them', provider.outbox.length === 10);
    check('under the approved sender name', provider.outbox[0]?.senderId === 'SMSCO');
  });

  // ── 4. Long messages cost more ───────────────────────────────────────────
  console.log('\nA two-segment message costs two');
  await as(async () => {
    await setBalance(10_000);
    const before = await balance();
    const result = await smsSendService.send({
      organizationId: orgId,
      template: 'x'.repeat(200),
      recipients: recipients(5, 200),
      route: 'PROMOTIONAL',
      senderIdId: senderId,
    });
    check('five recipients, ten segments', result.segments === 10,
      'five messages of 200 characters are ten segments, not five');
    check('and the balance reflects ten', before - (await balance()) === 10 * unitCost);
  });

  // ── 5. Not enough credit ─────────────────────────────────────────────────
  console.log('\nA campaign that cannot be afforded does not start');
  await as(async () => {
    await setBalance(unitCost * 5);
    const before = await balance();
    provider.outbox.length = 0;

    check('it is refused up front',
      await rejects(
        () => smsSendService.send({
          organizationId: orgId,
          template: 'Hello',
          recipients: recipients(50, 300),
          route: 'PROMOTIONAL',
          senderIdId: senderId,
        }),
        /balance is lower|credits/i,
      ),
      'not half-sent and then stopped');
    check('nothing was sent', provider.outbox.length === 0);
    check('and nothing was charged', (await balance()) === before);
  });

  // ── 6. Partial rejection is refunded ─────────────────────────────────────
  console.log('\nWhat the provider refuses is given back');
  await as(async () => {
    await setBalance(10_000);
    const before = await balance();
    // The mock rejects this specific number on purpose.
    const result = await smsSendService.send({
      organizationId: orgId,
      template: 'Hello',
      recipients: [...recipients(4, 400), { phone: '+2340000000000' }],
      route: 'PROMOTIONAL',
      senderIdId: senderId,
    });
    check('the good ones went', result.queued === 4);
    check('the refused one is reported', result.rejected.length === 1);
    check('and only the delivered segments were charged',
      before - (await balance()) === 4 * unitCost,
      'the reservation covered 5; one was refunded');

    const refund = await db.smsWalletTransaction.findFirst({
      where: { organizationId: orgId, type: 'ROLLBACK' },
      orderBy: { createdAt: 'desc' },
    });
    check('the refund is a ledger entry of its own', refund !== null,
      'reserved 5, refunded 1 — not a silently edited debit');
  });

  // ── 7. Opt-outs ──────────────────────────────────────────────────────────
  console.log('\nSomeone who opted out is not marketed to');
  await as(async () => {
    await setBalance(10_000);
    await smsSendService.suppress(orgId, '+2348030050001', 'Replied STOP');
    provider.outbox.length = 0;

    const result = await smsSendService.send({
      organizationId: orgId,
      template: 'Big sale today',
      recipients: recipients(3, 50001),
      route: 'PROMOTIONAL',
      senderIdId: senderId,
    });
    check('they are dropped from the send', result.suppressed === 1);
    check('and the rest still go', result.queued === 2);
    check('they were never charged for', result.segments === 2);
    check('and the provider never saw the number',
      !provider.outbox.some((o) => o.to === '+2348030050001'));
  });

  console.log('\nAn opt-out matches however the number was written');
  await as(async () => {
    // Recorded in local form, as an agent would type it off a phone call.
    await smsSendService.suppress(orgId, '08030050002', 'Asked to stop');
    const stored = await db.smsSuppression.findFirst({
      where: { organizationId: orgId, reason: 'Asked to stop' },
      select: { phone: true },
    });
    check('it is stored in the form the send path checks',
      stored?.phone === '+2348030050002',
      `stored as ${stored?.phone}`);

    // Sent to in international form — the same person.
    const preview = await smsSendService.preview({
      organizationId: orgId,
      template: 'Sale today',
      recipients: [{ phone: '+234 803 005 0002' }],
      route: 'PROMOTIONAL',
    });
    check('and the same person is still excluded', preview.suppressed === 1,
      'stored as typed, an opt-out never matched what a send resolves to');
  });

  console.log('\nBut a transactional message still reaches them');
  await as(async () => {
    provider.outbox.length = 0;
    const result = await smsSendService.send({
      organizationId: orgId,
      template: 'Your order has shipped',
      recipients: [{ phone: '08030050001' }],
      route: 'TRANSACTIONAL',
      senderIdId: senderId,
      eventType: 'order.shipped',
    });
    check('an opt-out does not block a receipt', result.queued === 1,
      'opting out of marketing is not opting out of being told an order shipped');
    check('and it went to the right number', provider.outbox[0]?.to === '+2348030050001');
  });

  // ── 8. An unapproved sender cannot send ──────────────────────────────────
  console.log('\nNothing sends under an unapproved name');
  await as(async () => {
    const draft = await senderIdService.request(orgId, { value: 'NOTYET' });
    check('a draft Sender ID is refused',
      await rejects(
        () => smsSendService.send({
          organizationId: orgId,
          template: 'Hello',
          recipients: recipients(1, 600),
          route: 'PROMOTIONAL',
          senderIdId: draft.id,
        }),
        /not been submitted/i,
      ),
      'the network would reject it and the business would have paid');
  });

  // ── 9. A total provider failure refunds everything ───────────────────────
  console.log('\nIf the provider fails outright, nothing is charged');
  await as(async () => {
    await setBalance(10_000);
    const before = await balance();
    const broken: SmsProvider = {
      ...provider,
      sendBulkSms: async () => { throw new Error('Provider unreachable'); },
    } as SmsProvider;
    setSmsProviderForTesting(broken);

    check('the failure surfaces',
      await rejects(
        () => smsSendService.send({
          organizationId: orgId,
          template: 'Hello',
          recipients: recipients(20, 700),
          route: 'PROMOTIONAL',
          senderIdId: senderId,
        }),
        /unreachable/i,
      ));
    check('and every reserved credit came back', (await balance()) === before,
      'a send that never left Vhicasar must not be paid for');
    setSmsProviderForTesting(provider);
  });

  // ── 10. Per-route pricing ────────────────────────────────────────────────
  console.log('\nThe two routes can be priced differently');
  {
    const { smsUnitCostFor } = await import('../../src/application/billing/sms-wallet.service');
    const base = {
      currency: 'NGN', unitCost: 4, lowBalanceThreshold: 500, packages: [],
      channels: {
        SMS: { enabled: true, unitCost: 4 },
        EMAIL: { enabled: true, unitCost: 1 },
        WHATSAPP: { enabled: true, unitCost: 6 },
      },
    } as never;

    check('with nothing configured, both use the SMS price',
      smsUnitCostFor(base, 'TRANSACTIONAL') === 4 && smsUnitCostFor(base, 'PROMOTIONAL') === 4,
      'existing tenants must not see their prices change');

    const split = { ...(base as object), smsTransactionalCost: 6, smsPromotionalCost: 3 } as never;
    check('a transactional send takes the transactional price',
      smsUnitCostFor(split, 'TRANSACTIONAL') === 6);
    check('and marketing takes its own', smsUnitCostFor(split, 'PROMOTIONAL') === 3,
      'the provider charges more for the priority route');

    const onlyOne = { ...(base as object), smsTransactionalCost: 6 } as never;
    check('setting one leaves the other on the default',
      smsUnitCostFor(onlyOne, 'PROMOTIONAL') === 4);
  }

  // ── 11. History ──────────────────────────────────────────────────────────
  console.log('\nEvery message is on the record');
  {
    const messages = await db.smsMessage.findMany({
      where: { organizationId: orgId },
      select: { status: true, segments: true, route: true, senderValue: true, reference: true },
    });
    check('messages were recorded', messages.length > 0);
    check('each carries what it cost', messages.every((m) => m.segments >= 1));
    check('and the name it was sent under', messages.every((m) => m.senderValue.length > 0));
    check('with a unique reference for receipts',
      new Set(messages.map((m) => m.reference)).size === messages.length);
    check('marketing and transactional are distinguishable',
      messages.some((m) => m.route === 'PROMOTIONAL') &&
        messages.some((m) => m.route === 'TRANSACTIONAL'));
  }

  setSmsProviderForTesting(null);
  setPricingForTesting(null);
  await cleanup();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

async function cleanup() {
  await db.smsMessage.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.smsSuppression.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.senderId.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.smsWalletTransaction.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.smsWallet.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.notification.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.auditLog.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.organization.delete({ where: { id: orgId } }).catch(() => {});
}

main().catch(async (e) => { console.error(e); await cleanup(); process.exit(1); });
