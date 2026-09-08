/*
 * Whether a connected channel is actually working.
 *
 * A channel used to be a boolean, which could not tell a business that
 * switched WhatsApp off from one whose Meta token expired weeks ago. In the
 * second case nothing said anything — messages just stopped and the inbox
 * looked like a quiet week.
 *
 * The distinctions under test are the ones that decide what the business is
 * told: a dead token needs them to reconnect, a rate limit needs them to do
 * nothing at all, and neither should ever surface the provider's own wording.
 */
import { prismaUnscoped as db } from '../../src/infrastructure/database/prisma';
import {
  classifyProviderError,
  friendlyMessage,
  markChannelConnected,
  markChannelError,
  markWebhookReceived,
} from '../../src/application/inbox/channel-health.service';

let passed = 0, failed = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); }
};

const stamp = Date.now();
let orgId = '', accountId = '';

const read = () => db.channelAccount.findFirstOrThrow({
  where: { id: accountId },
  select: { status: true, lastError: true, lastErrorAt: true, lastWebhookAt: true, isActive: true },
});

async function main() {
  orgId = (await db.organization.create({
    data: { name: 'Health Co', slug: `health-${stamp}`, currency: 'NGN', status: 'ACTIVE', country: 'NG' },
  })).id;
  accountId = (await db.channelAccount.create({
    data: {
      organizationId: orgId, channelType: 'INSTAGRAM', name: 'Shop IG',
      externalId: `ig-${stamp}`, isActive: true,
    },
  })).id;

  // ── 1. Existing channels are unaffected ──────────────────────────────────
  console.log('\nA channel that existed before this column did is still connected');
  check('it defaults to CONNECTED', (await read()).status === 'CONNECTED',
    'existing rows must not suddenly read as broken');

  // ── 2. Telling a dead token from a passing one ───────────────────────────
  console.log('\nA dead token and a rate limit are not the same problem');
  {
    check('an expired Meta token is EXPIRED',
      classifyProviderError('Error validating access token: Session has expired') === 'EXPIRED');
    check('a revoked token is EXPIRED',
      classifyProviderError('The access token was revoked by the user') === 'EXPIRED');
    check('Meta code 190 is EXPIRED',
      classifyProviderError('OAuthException code: 190 subcode: 463') === 'EXPIRED');

    check('a rate limit leaves it CONNECTED',
      classifyProviderError('Application request limit reached — rate limit') === 'CONNECTED',
      'a limit passes on its own; telling them to reconnect would be wrong');
    check('a timeout leaves it CONNECTED',
      classifyProviderError('connect ETIMEDOUT 31.13.80.1:443') === 'CONNECTED');
    check('a 503 leaves it CONNECTED',
      classifyProviderError('Request failed with status 503') === 'CONNECTED');

    check('anything else is an ERROR',
      classifyProviderError('Recipient is not a valid Instagram user') === 'ERROR');
  }

  // ── 3. What the business is actually told ────────────────────────────────
  console.log('\nThe business is told something it can act on');
  {
    const expired = friendlyMessage('INSTAGRAM', 'EXPIRED');
    check('the expired message names the channel', expired.includes('Instagram'));
    check('and says what to do', /reconnect/i.test(expired));
    check('WhatsApp is spelled the way people write it',
      friendlyMessage('WHATSAPP', 'EXPIRED').includes('WhatsApp'));
    check('Messenger too',
      friendlyMessage('FACEBOOK_MESSENGER', 'ERROR').includes('Facebook Messenger'));
  }

  // ── 4. A failure is recorded, in our words not theirs ────────────────────
  console.log("\nA failure is recorded in our words, never the provider's");
  {
    const status = await markChannelError(
      accountId, 'INSTAGRAM',
      'OAuthException code: 190 — Error validating access token: Session has expired',
    );
    check('it settles on EXPIRED', status === 'EXPIRED');
    const row = await read();
    check('the channel reads EXPIRED', row.status === 'EXPIRED');
    check('with a sentence a shop owner can act on', /reconnect instagram/i.test(row.lastError ?? ''));
    check('and no provider jargon leaks through',
      !/OAuthException|190|access token/i.test(row.lastError ?? ''),
      row.lastError ?? '');
    check('the time is recorded', row.lastErrorAt !== null);
    check('but the channel is not torn down',
      row.isActive === true,
      'the history and the connection stay; only reconnecting is needed');
  }

  // ── 5. A transient failure does not cry wolf ─────────────────────────────
  console.log('\nA passing failure does not tell anyone to reconnect');
  {
    await markChannelConnected(accountId);
    const status = await markChannelError(accountId, 'INSTAGRAM', 'Rate limit exceeded, try again later');
    check('it stays CONNECTED', status === 'CONNECTED');
    const row = await read();
    check('the channel still reads CONNECTED', row.status === 'CONNECTED');
    check('though the failure is still recorded for support', row.lastErrorAt !== null);
  }

  // ── 6. Recovery ──────────────────────────────────────────────────────────
  console.log('\nA channel that recovers stops showing last week\'s failure');
  {
    await markChannelError(accountId, 'INSTAGRAM', 'Session has expired');
    check('it is EXPIRED first', (await read()).status === 'EXPIRED');

    await markWebhookReceived(accountId);
    const row = await read();
    check('a delivered webhook proves it works again', row.status === 'CONNECTED');
    check('the old error is cleared', row.lastError === null);
    check('and we know when it last heard from the provider', row.lastWebhookAt !== null);
  }

  // ── 7. Health bookkeeping never costs a message ──────────────────────────
  console.log('\nHealth bookkeeping never throws');
  {
    let threw = false;
    try {
      await markWebhookReceived('no-such-account');
      await markChannelError('no-such-account', 'WHATSAPP', 'anything');
    } catch { threw = true; }
    check('an unknown account is swallowed, not thrown',
      !threw,
      'a webhook must never be lost over its own bookkeeping');
  }

  await cleanup();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

async function cleanup() {
  await db.channelAccount.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.activity.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.auditLog.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.organization.delete({ where: { id: orgId } }).catch(() => {});
}

main().catch(async (e) => { console.error(e); await cleanup(); process.exit(1); });
