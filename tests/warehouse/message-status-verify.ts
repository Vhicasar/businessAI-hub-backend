/*
 * Delivery and read receipts.
 *
 * A message used to stay at SENT for ever: the WhatsApp adapter parsed the
 * `statuses` array out of the webhook and dropped it on the floor, so an agent
 * could never tell a delivered message from one the provider had rejected.
 *
 * What matters beyond "it updates" is that it updates *safely*. Providers
 * retry webhooks and deliver receipts out of order, so the same read receipt
 * arriving twice must change nothing, and a `sent` arriving after a `read`
 * must not wind the message backwards.
 */
import { prismaUnscoped as db } from '../../src/infrastructure/database/prisma';
import { requestContext } from '../../src/shared/context';
import { inboxService } from '../../src/application/inbox/inbox.service';
import { getAdapter } from '../../src/infrastructure/channels/registry';
import {
  capabilitiesFor,
  supportsContentType,
  withinReplyWindow,
} from '../../src/application/inbox/channel-capabilities';

let passed = 0, failed = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); }
};

const stamp = Date.now();
let orgId = '', otherOrgId = '', accountId = '', otherAccountId = '';
let customerId = '', conversationId = '', messageId = '', otherMessageId = '';

const as = (org: string) => <T>(fn: () => Promise<T>): Promise<T> =>
  requestContext.run({ requestId: `t-${stamp}`, organizationId: org } as never, fn);

/** A WhatsApp webhook body carrying one receipt. */
const receipt = (id: string, status: string, tsSeconds: number, error?: string) => ({
  object: 'whatsapp_business_account',
  entry: [{
    changes: [{
      value: {
        statuses: [{
          id,
          status,
          timestamp: String(tsSeconds),
          ...(error ? { errors: [{ title: 'Failed', message: error }] } : {}),
        }],
      },
    }],
  }],
});

async function statusOf(id: string): Promise<string> {
  const row = await db.message.findFirstOrThrow({ where: { id }, select: { status: true } });
  return row.status;
}

async function main() {
  const mkOrg = async (slug: string) => (await db.organization.create({
    data: { name: slug, slug: `${slug}-${stamp}`, currency: 'NGN', status: 'ACTIVE', country: 'NG' },
  })).id;
  orgId = await mkOrg('statusco');
  otherOrgId = await mkOrg('rivalco');

  const mkAccount = async (org: string) => (await db.channelAccount.create({
    data: {
      organizationId: org, channelType: 'WHATSAPP', name: 'Support',
      externalId: `pn-${org}-${stamp}`, isActive: true,
    },
  })).id;
  accountId = await mkAccount(orgId);
  otherAccountId = await mkAccount(otherOrgId);

  customerId = (await db.customer.create({
    data: { organizationId: orgId, firstName: 'Ada', lastName: 'N', phone: `+234800${stamp % 1000000}` },
  })).id;
  conversationId = (await db.conversation.create({
    data: { organizationId: orgId, channelAccountId: accountId, customerId, status: 'OPEN' },
  })).id;

  const mkMessage = async (org: string, convo: string, providerMessageId: string) =>
    (await db.message.create({
      data: {
        organizationId: org, conversationId: convo, direction: 'OUTBOUND',
        authorType: 'AGENT', contentType: 'TEXT', body: 'Hello',
        status: 'SENT', providerMessageId,
      },
    })).id;
  messageId = await mkMessage(orgId, conversationId, `wamid.${stamp}`);

  // ── 1. The adapter reads receipts out of a real payload shape ────────────
  console.log('\nThe adapter reads receipts the provider actually sends');
  {
    const adapter = getAdapter('WHATSAPP');
    const parsed = adapter.parseStatuses?.(receipt(`wamid.${stamp}`, 'delivered', 1756900000)) ?? [];
    check('one receipt is found', parsed.length === 1);
    check('mapped onto our own words', parsed[0]?.status === 'DELIVERED');
    check('carrying when it happened', parsed[0]?.occurredAt?.getTime() === 1756900000000);

    const failure = adapter.parseStatuses?.(receipt('x', 'failed', 1756900000, 'Number not on WhatsApp')) ?? [];
    check('a failure keeps its reason', failure[0]?.error === 'Number not on WhatsApp');

    // The same delivery carries messages too; neither should eat the other.
    const messages = adapter.parseInbound(receipt(`wamid.${stamp}`, 'read', 1756900000));
    check('a receipt is not mistaken for a message', messages.length === 0);
    check('and an unknown status word is ignored',
      (adapter.parseStatuses?.(receipt('x', 'accepted', 1)) ?? []).length === 0);
  }

  // ── 2. A receipt moves the message along ─────────────────────────────────
  console.log('\nA receipt moves the message along');
  await as(orgId)(async () => {
    await inboxService.applyStatus({ id: accountId, organizationId: orgId },
      { providerMessageId: `wamid.${stamp}`, status: 'DELIVERED', occurredAt: new Date() });
    check('SENT becomes DELIVERED', await statusOf(messageId) === 'DELIVERED');
    const row = await db.message.findFirstOrThrow({ where: { id: messageId }, select: { deliveredAt: true } });
    check('and the time is recorded', row.deliveredAt !== null);

    await inboxService.applyStatus({ id: accountId, organizationId: orgId },
      { providerMessageId: `wamid.${stamp}`, status: 'READ', occurredAt: new Date() });
    check('DELIVERED becomes READ', await statusOf(messageId) === 'READ');
    const read = await db.message.findFirstOrThrow({
      where: { id: messageId }, select: { readAt: true, deliveredAt: true },
    });
    check('a read message counts as delivered even if that receipt never came',
      read.readAt !== null && read.deliveredAt !== null);
  });

  // ── 3. Replays and out-of-order receipts ─────────────────────────────────
  console.log('\nProviders retry and reorder; neither must corrupt the record');
  await as(orgId)(async () => {
    const before = await db.message.findFirstOrThrow({
      where: { id: messageId }, select: { readAt: true },
    });
    await inboxService.applyStatus({ id: accountId, organizationId: orgId },
      { providerMessageId: `wamid.${stamp}`, status: 'READ', occurredAt: new Date() });
    const after = await db.message.findFirstOrThrow({
      where: { id: messageId }, select: { readAt: true },
    });
    check('replaying the same receipt changes nothing',
      before.readAt?.getTime() === after.readAt?.getTime());

    await inboxService.applyStatus({ id: accountId, organizationId: orgId },
      { providerMessageId: `wamid.${stamp}`, status: 'SENT', occurredAt: new Date() });
    check('a late SENT does not wind a READ message back',
      await statusOf(messageId) === 'READ');

    await inboxService.applyStatus({ id: accountId, organizationId: orgId },
      { providerMessageId: `wamid.${stamp}`, status: 'FAILED', error: 'Rejected' });
    check('but a failure still gets through, because it is terminal',
      await statusOf(messageId) === 'FAILED');
  });

  // ── 4. Receipts for things that are not ours ─────────────────────────────
  console.log('\nA receipt only ever touches its own message');
  otherMessageId = await mkMessage(otherOrgId,
    (await db.conversation.create({
      data: {
        organizationId: otherOrgId, channelAccountId: otherAccountId, status: 'OPEN',
        customerId: (await db.customer.create({
          data: { organizationId: otherOrgId, firstName: 'Rival', lastName: 'C' },
        })).id,
      },
    })).id,
    // Deliberately the same provider id as ours — providers do not coordinate
    // ids across businesses, and a collision must not cross the tenant line.
    `wamid.${stamp}`);

  await as(orgId)(async () => {
    await inboxService.applyStatus({ id: accountId, organizationId: orgId },
      { providerMessageId: `wamid.${stamp}`, status: 'READ' });
    check("another business's message is untouched",
      await statusOf(otherMessageId) === 'SENT');
  });

  await as(orgId)(async () => {
    // Nothing to update, and nothing thrown: providers send receipts for
    // messages from before an account was connected.
    let threw = false;
    try {
      await inboxService.applyStatus({ id: accountId, organizationId: orgId },
        { providerMessageId: 'wamid.never-seen', status: 'DELIVERED' });
    } catch { threw = true; }
    check('a receipt for an unknown message is ignored quietly', !threw);
  });

  // ── 5. An inbound message is not a receipt ───────────────────────────────
  console.log('\nInbound messages are never moved by receipts');
  await as(orgId)(async () => {
    const inboundId = (await db.message.create({
      data: {
        organizationId: orgId, conversationId, direction: 'INBOUND',
        authorType: 'CUSTOMER', contentType: 'TEXT', body: 'Hi',
        status: 'SENT', providerMessageId: `wamid.in.${stamp}`,
      },
    })).id;
    await inboxService.applyStatus({ id: accountId, organizationId: orgId },
      { providerMessageId: `wamid.in.${stamp}`, status: 'READ' });
    check('an inbound message keeps its own status', await statusOf(inboundId) === 'SENT');
  });

  // ── 6. Capabilities ──────────────────────────────────────────────────────
  console.log('\nChannels are not all the same product');
  {
    check('WhatsApp has templates', capabilitiesFor('WHATSAPP').templates);
    check('Instagram does not', !capabilitiesFor('INSTAGRAM').templates);
    check('Instagram takes no documents', !capabilitiesFor('INSTAGRAM').document);
    check('but Messenger does', capabilitiesFor('FACEBOOK_MESSENGER').document);
    check('SMS is text only', !capabilitiesFor('SMS').image && capabilitiesFor('SMS').text);
    check('a channel that cannot send says so', !capabilitiesFor('VOICE').outbound);

    check('a document is refused on Instagram', !supportsContentType('INSTAGRAM', 'DOCUMENT'));
    check('and allowed on WhatsApp', supportsContentType('WHATSAPP', 'DOCUMENT'));
    check('a system note is always allowed', supportsContentType('VOICE', 'SYSTEM'));

    const now = new Date('2026-01-02T00:00:00Z');
    const recent = new Date('2026-01-01T23:00:00Z');
    const stale = new Date('2025-12-31T12:00:00Z');
    check('a reply an hour later is inside the window',
      withinReplyWindow('WHATSAPP', recent, now));
    check('a reply a day and a half later is not',
      !withinReplyWindow('WHATSAPP', stale, now));
    check('a customer who never wrote in has no open window',
      !withinReplyWindow('WHATSAPP', null, now));
    check('Telegram has no window to miss',
      withinReplyWindow('TELEGRAM', stale, now));
  }

  await cleanup();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

async function cleanup() {
  for (const org of [orgId, otherOrgId].filter(Boolean)) {
    await db.message.deleteMany({ where: { organizationId: org } }).catch(() => {});
    await db.conversation.deleteMany({ where: { organizationId: org } }).catch(() => {});
    await db.customerIdentity.deleteMany({ where: { organizationId: org } }).catch(() => {});
    await db.customer.deleteMany({ where: { organizationId: org } }).catch(() => {});
    await db.channelAccount.deleteMany({ where: { organizationId: org } }).catch(() => {});
    await db.auditLog.deleteMany({ where: { organizationId: org } }).catch(() => {});
    await db.organization.delete({ where: { id: org } }).catch(() => {});
  }
}

main().catch(async (e) => { console.error(e); await cleanup(); process.exit(1); });
