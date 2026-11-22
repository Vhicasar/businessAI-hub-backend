/*
 * Disconnecting a channel detaches it at Meta too.
 *
 * The reported fault: a WhatsApp account disconnected in the product stayed
 * connected in Meta's Business Settings. `disconnect` cleared our own routing
 * ids and nothing else, so the app remained subscribed to the WABA — Meta kept
 * delivering webhooks we dropped as unknown, and the business had no way to
 * detach it except by hand.
 *
 * The second half of this matters as much as the first: a business must be
 * able to disconnect even when Meta refuses, so the local disconnect is
 * checked against a stub that fails.
 *
 * Run with the stub's address in the environment, because env is read at
 * import time:
 *   META_GRAPH_BASE_URL=http://127.0.0.1:4974 npx tsx tests/warehouse/channel-disconnect-verify.ts
 */
import { createServer, type Server } from 'node:http';
import { prismaUnscoped as db } from '../../src/infrastructure/database/prisma';
import { requestContext } from '../../src/shared/context';
import { encrypt } from '../../src/shared/crypto';
import { channelsService } from '../../src/application/inbox/channels.service';

let passed = 0, failed = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); }
};

const stamp = Date.now();
const PORT = 4974;
let orgId = '', userId = '';
let meta: Server | null = null;

/** What Meta does on the next DELETE. */
let metaMode: 'ok' | 'refuse' = 'ok';
/** Every unsubscribe the stub was asked for. */
const deletes: Array<{ url: string; method: string }> = [];

const asOrg = <T>(fn: () => Promise<T>) =>
  requestContext.run({ requestId: `cd-${stamp}`, organizationId: orgId, userId }, fn);

async function startStubMeta() {
  meta = createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'DELETE' && (req.url ?? '').includes('subscribed_apps')) {
        deletes.push({ url: (req.url ?? '').split('?')[0], method: 'DELETE' });
        if (metaMode === 'refuse') {
          res.statusCode = 400;
          return res.end(JSON.stringify({ error: { code: 190, message: 'Invalid OAuth access token' } }));
        }
        return res.end(JSON.stringify({ success: true }));
      }
      return res.end(JSON.stringify({ success: true }));
    });
  });
  await new Promise<void>((resolve) => meta!.listen(PORT, '127.0.0.1', resolve));
}

async function makeChannel(name: string, channelType: 'WHATSAPP' | 'FACEBOOK_MESSENGER', creds: Record<string, string>) {
  return (await db.channelAccount.create({
    data: {
      organizationId: orgId, channelType, name, externalId: `${name}-${stamp}`,
      purpose: 'SUPPORT', isActive: true, status: 'CONNECTED',
      credentialsEnc: encrypt(JSON.stringify(creds)),
      metaWabaId: channelType === 'WHATSAPP' ? (creds.wabaId ?? null) : null,
      metaFacebookPageId: channelType === 'FACEBOOK_MESSENGER' ? (creds.pageId ?? null) : null,
      metadata: { wabaId: creds.wabaId ?? null },
    },
  })).id;
}

async function main() {
  await startStubMeta();
  const org = await db.organization.create({
    data: { name: `Disc Verify ${stamp}`, slug: `disc-verify-${stamp}`, currency: 'NGN', status: 'ACTIVE', country: 'NG' },
  });
  orgId = org.id;
  const user = await db.user.create({
    data: { email: `disc-${stamp}@example.invalid`, firstName: 'Disc', lastName: 'Verify', passwordHash: 'x' },
  });
  userId = user.id;

  // ── WhatsApp, the reported case ─────────────────────────────────────────
  console.log('\nDisconnecting a WhatsApp channel');
  const waId = await makeChannel('wa', 'WHATSAPP', {
    wabaId: `waba-${stamp}`, phoneNumberId: '555', accessToken: 'tok', appId: 'app', appSecret: 'sec',
  });
  const result = await asOrg(() => channelsService.disconnect(waId));

  check('Meta was asked to detach the app', deletes.length === 1, `${deletes.length} calls`);
  check('against the WhatsApp Business Account',
    deletes[0]?.url.includes(`waba-${stamp}`) && deletes[0].url.endsWith('/subscribed_apps'), deletes[0]?.url);
  check('by DELETE, not another subscribe', deletes[0]?.method === 'DELETE');
  check('and the caller is told it worked', result.metaDetached === true, JSON.stringify(result));

  const row = await db.channelAccount.findUniqueOrThrow({ where: { id: waId } });
  check('the channel is disconnected locally', row.status === 'DISCONNECTED' && row.isActive === false);
  check('its routing ids are freed for a later connection', row.metaWabaId === null);
  check('and the row is soft-deleted, keeping its history', row.deletedAt !== null);

  const event = await db.activity.findFirst({
    where: { organizationId: orgId }, orderBy: { createdAt: 'desc' },
  });
  check('the timeline says Meta was detached',
    /detached from your WhatsApp Business Account/i.test(JSON.stringify(event?.description ?? event ?? '')),
    JSON.stringify(event?.description ?? '').slice(0, 120));

  // ── Facebook, so the fix is not WhatsApp-only ──────────────────────────
  console.log('\nDisconnecting a Facebook channel');
  deletes.length = 0;
  const fbId = await makeChannel('fb', 'FACEBOOK_MESSENGER', {
    pageId: `page-${stamp}`, pageAccessToken: 'ptok', accessToken: 'tok', appId: 'app', appSecret: 'sec',
  });
  await asOrg(() => channelsService.disconnect(fbId));
  check('the Page is detached too', deletes[0]?.url.includes(`page-${stamp}`), deletes[0]?.url ?? 'no call');

  // ── Meta refusing must not trap anyone ─────────────────────────────────
  console.log('\nWhen Meta refuses, or the token is already dead');
  deletes.length = 0;
  metaMode = 'refuse';
  const deadId = await makeChannel('dead', 'WHATSAPP', {
    wabaId: `waba-dead-${stamp}`, phoneNumberId: '556', accessToken: 'expired', appId: 'app', appSecret: 'sec',
  });
  const refused = await asOrg(() => channelsService.disconnect(deadId));
  check('the disconnect still succeeds', refused.status === 'DISCONNECTED');
  check('but does not claim Meta was told', refused.metaDetached === false, JSON.stringify(refused));
  check('and says so in words a business can act on',
    /still attached|would not detach/i.test(refused.metaDetail), refused.metaDetail);

  const deadRow = await db.channelAccount.findUniqueOrThrow({ where: { id: deadId } });
  check('the channel is gone locally regardless', deadRow.status === 'DISCONNECTED' && deadRow.deletedAt !== null);
  const deadEvent = await db.activity.findFirst({
    where: { organizationId: orgId }, orderBy: { createdAt: 'desc' },
  });
  check('and the timeline tells them to tidy it up in Meta',
    /Meta Business Settings/i.test(JSON.stringify(deadEvent?.description ?? deadEvent ?? '')),
    JSON.stringify(deadEvent?.description ?? '').slice(0, 140));
  metaMode = 'ok';

  // ── A channel with nothing at Meta ─────────────────────────────────────
  console.log('\nA channel that was never subscribed');
  deletes.length = 0;
  const bareId = await makeChannel('bare', 'WHATSAPP', { accessToken: 'tok', appId: 'app' });
  const bare = await asOrg(() => channelsService.disconnect(bareId));
  check('nothing is sent to Meta', deletes.length === 0, `${deletes.length} calls`);
  check('and it is not reported as a failure', bare.metaDetached === true, JSON.stringify(bare));

  // ── Clearing an app Meta still lists, after the fact ───────────────────
  console.log('\nDetaching an app Meta still lists');
  deletes.length = 0;
  const orphan = await asOrg(() => channelsService.detachMetaSubscription({ providerId: `waba-dead-${stamp}` }));
  check('the orphaned subscription is found by its provider id', orphan.matched === true);
  check('and Meta is asked to detach it',
    deletes.some((c) => c.url.includes(`waba-dead-${stamp}`)), JSON.stringify(deletes));
  check('using the credentials already stored, with nothing pasted in', orphan.ok === true, orphan.detail);

  let unknown = false;
  await asOrg(() => channelsService.detachMetaSubscription({ providerId: 'waba-someone-else' }))
    .catch(() => { unknown = true; });
  check('an id this business does not hold is refused', unknown);

  /*
   * The isolation that matters: a provider id is guessable, so another
   * business must not be able to detach it by naming it.
   */
  const otherOrg = await db.organization.create({
    data: { name: `Disc Other ${stamp}`, slug: `disc-other-${stamp}`, currency: 'NGN', status: 'ACTIVE', country: 'NG' },
  });
  let crossTenant = false;
  await requestContext.run({ requestId: `cd-x-${stamp}`, organizationId: otherOrg.id, userId }, () =>
    channelsService.detachMetaSubscription({ providerId: `waba-dead-${stamp}` }),
  ).catch(() => { crossTenant = true; });
  check('and another business cannot detach this one\u2019s account', crossTenant);
  await db.organization.delete({ where: { id: otherOrg.id } }).catch(() => {});

  await cleanup();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

async function cleanup() {
  meta?.close();
  for (const t of ['channelAccount', 'activity', 'auditLog'] as const) {
    await (db as any)[t]?.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  }
  await db.organization.delete({ where: { id: orgId } }).catch(() => {});
  await db.user.delete({ where: { id: userId } }).catch(() => {});
}

main().catch(async (e) => { console.error(e); await cleanup(); process.exit(1); });
