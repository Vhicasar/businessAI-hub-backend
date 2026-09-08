/*
 * Messaging as an automation trigger.
 *
 * The engine was good but blind to messages: its trigger list ran from
 * lead.created to appointment.booked and stopped, so "when someone messages us
 * on Instagram, make a lead" could not be expressed at all.
 *
 * Three events close that gap, and the distinctions between them are what is
 * under test — a new thread is not the same as a reply on an old one, and a
 * customer left waiting is an event that no webhook will ever announce.
 */
import { prismaUnscoped as db } from '../../src/infrastructure/database/prisma';
import { requestContext } from '../../src/shared/context';
import { inboxService } from '../../src/application/inbox/inbox.service';
import { workflowService, TRIGGERS } from '../../src/application/crm/workflow.service';
import { runUnansweredSweep } from '../../src/application/inbox/unanswered-sweep';

let passed = 0, failed = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); }
};

const stamp = Date.now();
let orgId = '', accountId = '';

/** What dispatch was asked to fire, captured instead of run. */
const fired: { trigger: string; payload: Record<string, unknown> }[] = [];

const as = <T>(fn: () => Promise<T>): Promise<T> =>
  requestContext.run({ requestId: `wf-${stamp}`, organizationId: orgId } as never, fn);

const settle = () => new Promise((r) => setTimeout(r, 150));

async function main() {
  orgId = (await db.organization.create({
    data: { name: 'Flow Co', slug: `flow-${stamp}`, currency: 'NGN', status: 'ACTIVE', country: 'NG' },
  })).id;
  accountId = (await db.channelAccount.create({
    data: {
      organizationId: orgId, channelType: 'INSTAGRAM', name: 'Shop IG',
      externalId: `ig-${stamp}`, isActive: true, autoReply: false,
    },
  })).id;

  // Dispatch is captured rather than executed: what matters here is which
  // events fire and what they carry, not what a notify action does.
  const realDispatch = workflowService.dispatch.bind(workflowService);
  const realDispatchNow = workflowService.dispatchNow.bind(workflowService);
  const capture = async (trigger: string, payload: Record<string, unknown>) => {
    fired.push({ trigger, payload });
  };
  (workflowService as unknown as Record<string, unknown>).dispatch = capture;
  (workflowService as unknown as Record<string, unknown>).dispatchNow = capture;

  // ── 1. The triggers exist ────────────────────────────────────────────────
  console.log('\nThe engine now knows about messages');
  for (const t of ['conversation.started', 'message.received', 'conversation.unanswered']) {
    check(`${t} is a trigger`, (TRIGGERS as readonly string[]).includes(t));
  }

  // ── 2. A new thread fires both events ────────────────────────────────────
  console.log('\nA first message starts a conversation and is a message');
  await as(async () => {
    fired.length = 0;
    await inboxService.processInbound(
      { id: accountId, organizationId: orgId, channelType: 'INSTAGRAM' },
      {
        providerMessageId: `ig.${stamp}.1`,
        senderExternalId: `johndoe-${stamp}`,
        senderDisplayName: 'John Doe',
        contentType: 'TEXT',
        text: 'Hello, I would like to know the price',
      },
    );
    await settle();
    check('conversation.started fires', fired.some((f) => f.trigger === 'conversation.started'));
    check('message.received fires too', fired.some((f) => f.trigger === 'message.received'));

    const started = fired.find((f) => f.trigger === 'conversation.started');
    check('it says which channel', started?.payload.channel === 'INSTAGRAM',
      'so a rule can fire on Instagram alone');
    check('and carries the text a rule matches on',
      String(started?.payload.text).includes('price'));
    check('and the customer it is about', Boolean(started?.payload.customerId));
  });

  // ── 3. A reply on the same thread is not a new conversation ──────────────
  console.log('\nA reply on the same thread does not start it again');
  await as(async () => {
    fired.length = 0;
    await inboxService.processInbound(
      { id: accountId, organizationId: orgId, channelType: 'INSTAGRAM' },
      {
        providerMessageId: `ig.${stamp}.2`,
        senderExternalId: `johndoe-${stamp}`,
        contentType: 'TEXT',
        text: 'Still there?',
      },
    );
    await settle();
    check('message.received fires', fired.some((f) => f.trigger === 'message.received'));
    check('conversation.started does not',
      !fired.some((f) => f.trigger === 'conversation.started'),
      'a lead would be created twice for one customer');
  });

  // ── 4. A redelivered webhook fires nothing ───────────────────────────────
  console.log('\nA redelivered webhook does not fire the rules again');
  await as(async () => {
    fired.length = 0;
    await inboxService.processInbound(
      { id: accountId, organizationId: orgId, channelType: 'INSTAGRAM' },
      {
        providerMessageId: `ig.${stamp}.2`,
        senderExternalId: `johndoe-${stamp}`,
        contentType: 'TEXT',
        text: 'Still there?',
      },
    );
    await settle();
    check('nothing fires on a duplicate', fired.length === 0,
      'providers retry; automations must not run twice');
  });

  // ── 5. Nobody answered ───────────────────────────────────────────────────
  console.log('\nA customer left waiting is an event of its own');
  {
    const convo = await db.conversation.findFirstOrThrow({
      where: { organizationId: orgId }, select: { id: true },
    });
    // Age the thread past the threshold.
    const longAgo = new Date(Date.now() - 90 * 60_000);
    await db.conversation.update({
      where: { id: convo.id }, data: { lastMessageAt: longAgo },
    });
    await db.message.updateMany({
      where: { conversationId: convo.id }, data: { createdAt: longAgo },
    });

    fired.length = 0;
    // The sweep is global, like the other watchers — it runs outside any
    // request and covers every tenant. So this asserts on *our* conversation
    // rather than on the total, which a shared dev database makes meaningless.
    await runUnansweredSweep(30);
    const event = fired.find(
      (f) => f.trigger === 'conversation.unanswered' && f.payload.conversationId === convo.id,
    );
    check('the waiting conversation is reported', Boolean(event));
    check('and it names the right channel', event?.payload.channel === 'INSTAGRAM');
    check('it says how long they have waited',
      Number(event?.payload.waitedMinutes) >= 30, String(event?.payload.waitedMinutes));
    check('and whether anyone owns it', event?.payload.assigned === false);

    // ── 6. It does not nag ─────────────────────────────────────────────────
    fired.length = 0;
    await runUnansweredSweep(30);
    check(
      'a second sweep says nothing more about it',
      !fired.some((f) => f.payload.conversationId === convo.id),
      'an alert every five minutes would be ignored within a day',
    );

    // ── 7. Answering it closes the matter ──────────────────────────────────
    await db.message.create({
      data: {
        organizationId: orgId, conversationId: convo.id, direction: 'OUTBOUND',
        authorType: 'AGENT', contentType: 'TEXT', body: 'Sorry for the wait!',
        status: 'SENT',
      },
    });
    fired.length = 0;
    await runUnansweredSweep(30);
    check(
      'an answered thread is not swept',
      !fired.some((f) => f.payload.conversationId === convo.id),
      'the customer is no longer the one waiting',
    );
  }

  (workflowService as unknown as Record<string, unknown>).dispatch = realDispatch;
  (workflowService as unknown as Record<string, unknown>).dispatchNow = realDispatchNow;

  await cleanup();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

async function cleanup() {
  await db.messageAttachment.deleteMany({ where: { message: { organizationId: orgId } } }).catch(() => {});
  await db.message.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.conversation.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.customerIdentity.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.customer.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.channelAccount.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.activity.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.auditLog.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.organization.delete({ where: { id: orgId } }).catch(() => {});
}

main().catch(async (e) => { console.error(e); await cleanup(); process.exit(1); });
