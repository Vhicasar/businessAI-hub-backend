/*
 * One-click channel connection, delivery receipts, and channel capabilities.
 *
 * The promises under test:
 *
 *   A business connects WhatsApp, Messenger or Instagram by authorising
 *   Vhicasar's Meta app, not by pasting a token it had to generate itself.
 *
 *   The signed state is what makes an unauthenticated callback safe — it
 *   cannot be forged, replayed after it expires, or pointed at another
 *   business's organisation.
 *
 *   A receipt moves a message forwards only. Out-of-order webhooks are the
 *   normal case, and a message that went from READ back to DELIVERED would
 *   read to an agent as the customer un-reading it.
 */
import { prismaUnscoped as db } from '../../src/infrastructure/database/prisma';
import { requestContext } from '../../src/shared/context';
import { inboxService } from '../../src/application/inbox/inbox.service';
import {
  authorizationUrl,
  completeCallback,
  supportsOAuth,
  oauthUnavailableReason,
  callbackUrl,
} from '../../src/application/inbox/channel-oauth.service';
import {
  capabilitiesFor,
  supportsContentType,
  withinReplyWindow,
} from '../../src/application/inbox/channel-capabilities';
import { signState } from '../../src/application/integrations/oauth-connection.service';
import { WhatsAppAdapter } from '../../src/infrastructure/channels/whatsapp.adapter';
import { MetaMessagingAdapter } from '../../src/infrastructure/channels/meta.adapter';
import { env } from '../../src/shared/config/env';

let passed = 0, failed = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); }
};
const rejects = async (fn: () => Promise<unknown>, match: RegExp): Promise<boolean> => {
  try { await fn(); return false; } catch (e) { return match.test((e as Error).message); }
};

const stamp = Date.now();
let orgA = '', orgB = '', userA = '', accountA = '', customerA = '', convA = '', msgA = '';

const asOrg = <T>(organizationId: string, fn: () => Promise<T>): Promise<T> =>
  requestContext.run({ organizationId } as never, fn);

async function main() {
  // ── 1. Capabilities are per channel, not one size fits all ───────────────
  console.log('\nChannels are not all the same product');
  {
    const wa = capabilitiesFor('WHATSAPP');
    const ig = capabilitiesFor('INSTAGRAM');
    const email = capabilitiesFor('EMAIL');

    check('WhatsApp has templates', wa.templates);
    check('Instagram does not', !ig.templates,
      'Instagram messaging has no template concept');
    check('Instagram takes no documents', !ig.document);
    check('WhatsApp does', wa.document);
    check('email has no read receipts', !email.readReceipts);
    check('and no typing indicator', !email.typingIndicator);

    check('a template is refused on Instagram', !supportsContentType('INSTAGRAM', 'TEMPLATE'));
    check('and allowed on WhatsApp', supportsContentType('WHATSAPP', 'TEMPLATE'));
    check('a system note is allowed anywhere', supportsContentType('EMAIL', 'SYSTEM'),
      'it is written by us and never delivered');

    // The 24-hour customer service window.
    const now = new Date('2026-09-07T12:00:00Z');
    check('a reply 1 hour after the customer wrote is fine',
      withinReplyWindow('WHATSAPP', new Date('2026-09-07T11:00:00Z'), now));
    check('a reply 25 hours later is outside the window',
      !withinReplyWindow('WHATSAPP', new Date('2026-09-06T11:00:00Z'), now));
    check('a channel with no window is always open',
      withinReplyWindow('TELEGRAM', null, now));
    check('but WhatsApp with no inbound at all is not',
      !withinReplyWindow('WHATSAPP', null, now));
  }

  // ── 2. What can be connected by OAuth ────────────────────────────────────
  console.log('\nOnly the channels Meta actually authorises');
  {
    const configured = env.meta.enabled;
    check('email is never a one-click connection', !supportsOAuth('EMAIL'));
    check('and says why', /own credentials/i.test(oauthUnavailableReason('EMAIL') ?? ''));

    if (configured) {
      check('WhatsApp can be connected', supportsOAuth('WHATSAPP'));
    } else {
      check('WhatsApp is unavailable without a Meta app', !supportsOAuth('WHATSAPP'));
      check('and the reason names the missing setup',
        /not configured|administrator/i.test(oauthUnavailableReason('WHATSAPP') ?? ''));
    }
    check('the callback url is the one Meta must be given',
      callbackUrl('WHATSAPP').endsWith('/api/v1/channels/whatsapp/callback'),
      callbackUrl('WHATSAPP'));
  }

  // ── 3. The signed state is the whole security of the callback ────────────
  console.log('\nThe callback is unauthenticated, so the state has to carry its weight');
  {
    const org = await db.organization.create({
      data: { name: 'Chan A', slug: `chan-a-${stamp}`, currency: 'NGN', status: 'ACTIVE', country: 'NG' },
    });
    orgA = org.id;
    userA = (await db.user.create({
      data: { email: `chan-${stamp}@t.test`, passwordHash: 'x', firstName: 'Chan', lastName: 'A' },
    })).id;
    const orgTwo = await db.organization.create({
      data: { name: 'Chan B', slug: `chan-b-${stamp}`, currency: 'NGN', status: 'ACTIVE', country: 'NG' },
    });
    orgB = orgTwo.id;

    if (env.meta.enabled) {
      const { url, state } = authorizationUrl({
        channelType: 'WHATSAPP',
        organizationId: orgA,
        userId: userA,
        returnTo: 'https://app.example.com/settings',
      });
      check('the dialog is Meta’s own', url.startsWith('https://www.facebook.com/'));
      check('it carries our app id', url.includes(encodeURIComponent(env.meta.appId)));
      check('and never the secret', !url.includes(env.meta.appSecret),
        'the secret must not reach a browser');
      check('the redirect is our callback', url.includes(encodeURIComponent(callbackUrl('WHATSAPP'))));
      check('the state is signed', state.includes('.'));
    } else {
      check('starting a connection is refused with no Meta app configured',
        await rejects(
          async () => authorizationUrl({
            channelType: 'WHATSAPP', organizationId: orgA, userId: userA, returnTo: 'x',
          }),
          /not configured|administrator/i));
    }

    // A tampered state must not verify.
    const good = signState({
      organizationId: orgA, userId: userA, provider: 'channel:WHATSAPP',
      returnTo: 'https://app.example.com', issuedAt: Date.now(),
    });
    const tampered = `${Buffer.from(JSON.stringify({
      organizationId: orgB, userId: userA, provider: 'channel:WHATSAPP',
      returnTo: 'https://app.example.com', issuedAt: Date.now(),
    })).toString('base64url')}.${good.split('.')[1]}`;
    check('a state re-pointed at another business fails verification',
      await rejects(
        () => completeCallback({ channelType: 'WHATSAPP', code: 'x', state: tampered }),
        /verification|invalid/i));

    check('a state minted for one channel cannot complete another',
      await rejects(
        () => completeCallback({ channelType: 'INSTAGRAM', code: 'x', state: good }),
        /different channel/i));

    const stale = signState({
      organizationId: orgA, userId: userA, provider: 'channel:WHATSAPP',
      returnTo: 'https://app.example.com',
      issuedAt: Date.now() - 11 * 60 * 1000,
    });
    check('an expired state is refused',
      await rejects(
        () => completeCallback({ channelType: 'WHATSAPP', code: 'x', state: stale }),
        /expired/i));
  }

  // ── 4. Adapters read receipts out of the same webhook as messages ────────
  console.log('\nReceipts are parsed, not discarded');
  {
    const wa = new WhatsAppAdapter();
    const body = {
      object: 'whatsapp_business_account',
      entry: [{
        changes: [{
          value: {
            statuses: [
              { id: 'wamid.AAA', status: 'delivered', timestamp: '1757246400' },
              { id: 'wamid.BBB', status: 'read', timestamp: '1757246460' },
              { id: 'wamid.CCC', status: 'failed', timestamp: '1757246500',
                errors: [{ title: 'Re-engagement message', message: 'Outside the 24 hour window' }] },
            ],
          },
        }],
      }],
    };
    const statuses = wa.parseStatuses(body);
    check('all three receipts are read', statuses.length === 3, String(statuses.length));
    check('delivered maps through', statuses[0]!.status === 'DELIVERED');
    check('read maps through', statuses[1]!.status === 'READ');
    check('failed carries the provider’s reason',
      statuses[2]!.status === 'FAILED' && /24 hour/i.test(statuses[2]!.error ?? ''));
    check('a message payload yields no receipts',
      wa.parseStatuses({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages: [] } }] }] }).length === 0);

    const messenger = new MetaMessagingAdapter('FACEBOOK_MESSENGER', 'page');
    const delivered = messenger.parseStatuses({
      object: 'page',
      entry: [{ messaging: [{ delivery: { mids: ['m_1', 'm_2'], watermark: 1757246400000 } }] }],
    });
    check('Messenger delivery receipts are read', delivered.length === 2);
    check('and are marked delivered', delivered.every((d) => d.status === 'DELIVERED'));
    check('an Instagram payload is ignored by the Messenger adapter',
      messenger.parseStatuses({ object: 'instagram', entry: [] }).length === 0);
  }

  // ── 5. A receipt only ever moves a message forwards ──────────────────────
  console.log('\nA receipt moves a message forwards, never back');
  {
    accountA = (await db.channelAccount.create({
      data: {
        organizationId: orgA, channelType: 'WHATSAPP', name: 'Main',
        externalId: `pn-${stamp}`, purpose: 'GENERAL',
      },
    })).id;
    customerA = (await db.customer.create({
      data: { organizationId: orgA, firstName: 'Ada', lastName: 'C' },
    })).id;
    convA = (await db.conversation.create({
      data: { organizationId: orgA, channelAccountId: accountA, customerId: customerA },
    })).id;
    msgA = (await db.message.create({
      data: {
        organizationId: orgA, conversationId: convA, direction: 'OUTBOUND',
        authorType: 'AGENT', body: 'Hello', status: 'SENT',
        providerMessageId: `wamid.OUT-${stamp}`,
      },
    })).id;

    const apply = (status: 'SENT' | 'DELIVERED' | 'READ' | 'FAILED') =>
      asOrg(orgA, () =>
        inboxService.applyStatus(
          { id: accountA, organizationId: orgA },
          { providerMessageId: `wamid.OUT-${stamp}`, status }
        ));
    const statusOf = async () =>
      (await db.message.findUniqueOrThrow({ where: { id: msgA }, select: { status: true } })).status;

    await apply('DELIVERED');
    check('SENT becomes DELIVERED', (await statusOf()) === 'DELIVERED');

    await apply('READ');
    check('DELIVERED becomes READ', (await statusOf()) === 'READ');
    const read = await db.message.findUniqueOrThrow({
      where: { id: msgA }, select: { readAt: true, deliveredAt: true },
    });
    check('and both timestamps are set', Boolean(read.readAt && read.deliveredAt),
      'a read message was necessarily delivered');

    // The out-of-order case this exists for.
    await apply('DELIVERED');
    check('a late delivery receipt does not un-read it', (await statusOf()) === 'READ');
    await apply('SENT');
    check('nor does a late sent receipt', (await statusOf()) === 'READ');

    // Replaying the whole webhook changes nothing.
    await apply('READ');
    check('replaying a receipt is a no-op', (await statusOf()) === 'READ');
  }

  // ── 6. Tenant isolation ──────────────────────────────────────────────────
  console.log('\nOne business cannot move another business’s messages');
  {
    await asOrg(orgB, () =>
      inboxService.applyStatus(
        { id: accountA, organizationId: orgB },
        { providerMessageId: `wamid.OUT-${stamp}`, status: 'FAILED' }
      ));
    const after = await db.message.findUniqueOrThrow({
      where: { id: msgA }, select: { status: true },
    });
    check('a receipt from the wrong tenant is ignored', after.status === 'READ',
      `became ${after.status}`);
  }

  // ── 7. A receipt for something we never sent ─────────────────────────────
  console.log('\nA receipt for an unknown message is dropped quietly');
  {
    let threw = false;
    await asOrg(orgA, () =>
      inboxService.applyStatus(
        { id: accountA, organizationId: orgA },
        { providerMessageId: 'wamid.NEVER-SENT', status: 'DELIVERED' }
      )).catch(() => { threw = true; });
    check('it does not throw', !threw,
      'the provider already had its 200; throwing would only fill the log');

    // An inbound message must not be moved by a receipt either.
    const inbound = await db.message.create({
      data: {
        organizationId: orgA, conversationId: convA, direction: 'INBOUND',
        authorType: 'CUSTOMER', body: 'Hi', status: 'DELIVERED',
        providerMessageId: `wamid.IN-${stamp}`,
      },
    });
    await asOrg(orgA, () =>
      inboxService.applyStatus(
        { id: accountA, organizationId: orgA },
        { providerMessageId: `wamid.IN-${stamp}`, status: 'READ' }
      ));
    const stillInbound = await db.message.findUniqueOrThrow({
      where: { id: inbound.id }, select: { status: true },
    });
    check('an inbound message is not touched by a delivery receipt',
      stillInbound.status === 'DELIVERED');
  }

  await cleanup();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

async function cleanup() {
  for (const orgId of [orgA, orgB].filter(Boolean)) {
    const org = { organizationId: orgId };
    await db.message.deleteMany({ where: org }).catch(() => {});
    await db.conversation.deleteMany({ where: org }).catch(() => {});
    await db.customerIdentity.deleteMany({ where: org }).catch(() => {});
    await db.customer.deleteMany({ where: org }).catch(() => {});
    await db.channelAccount.deleteMany({ where: org }).catch(() => {});
    await db.auditLog.deleteMany({ where: org }).catch(() => {});
    await db.organization.delete({ where: { id: orgId } }).catch(() => {});
  }
  await db.user.deleteMany({ where: { id: userA } }).catch(() => {});
}

main().catch(async (e) => { console.error(e); await cleanup(); process.exit(1); });
