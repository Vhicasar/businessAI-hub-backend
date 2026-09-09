/*
 * Run me with the stub's address already in the environment:
 *
 *   META_APP_ID=test-app-id META_APP_SECRET=test-app-secret \
 *   META_GRAPH_BASE_URL=http://127.0.0.1:4597 \
 *   API_BASE_URL=https://hub.test.vhicasar.com \
 *   npx tsx tests/warehouse/meta-integration-verify.ts
 *
 * The Meta integration, end to end, against a stub that speaks Graph's own
 * protocol over real HTTP.
 *
 * What cannot be tested here is Meta itself: an app, business verification and
 * App Review are somebody else's process and take weeks. What CAN be tested is
 * everything on our side of that boundary — that we build the right
 * authorization URL, exchange the code the way Graph expects, read the account
 * out of the response shape Graph actually returns, subscribe the webhook,
 * store credentials encrypted, and then send and receive through the same
 * adapters production will use.
 *
 * The stub is deliberately strict: it asserts on the parameters we send and
 * refuses anything malformed, so a wrong scope or a missing redirect_uri fails
 * here rather than at a customer's first connection attempt.
 */
import { createServer, type Server } from 'node:http';
import { prismaUnscoped as db } from '../../src/infrastructure/database/prisma';
import { requestContext } from '../../src/shared/context';
import { decrypt } from '../../src/shared/crypto';

let passed = 0, failed = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); }
};

const stamp = Date.now();
let orgId = '', server: Server | null = null, port = 0;

/** Every request the stub saw, so we can assert on what we actually sent. */
const seen: { path: string; method: string; query: URLSearchParams; body: string }[] = [];

/**
 * Fixed, not ephemeral: env is validated when the module graph loads, so
 * META_GRAPH_BASE_URL has to be set before this process starts and cannot
 * carry a port discovered at runtime. Chosen high to stay clear of the
 * services on 4000/4002.
 */
const STUB_PORT = 4597;

const APP_ID = 'test-app-id';
const APP_SECRET = 'test-app-secret';

/** A stand-in for graph.facebook.com that answers the way Graph does. */
function startGraphStub(): Promise<number> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        seen.push({ path: url.pathname, method: req.method ?? '', query: url.searchParams, body });
        const json = (code: number, payload: unknown) => {
          res.writeHead(code, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(payload));
        };

        // Code → access token.
        if (url.pathname.endsWith('/oauth/access_token')) {
          if (url.searchParams.get('client_secret') !== APP_SECRET) {
            return json(400, { error: { message: 'Invalid client secret' } });
          }
          if (!url.searchParams.get('redirect_uri')) {
            return json(400, { error: { message: 'redirect_uri is required' } });
          }
          return json(200, { access_token: 'USER-TOKEN', token_type: 'bearer' });
        }
        if (url.pathname.endsWith('/debug_token')) {
          return json(200, { data: { granular_scopes: [
            { scope: 'whatsapp_business_management', target_ids: ['waba-1'] },
          ] } });
        }
        // The businesses the user administers, and their WABAs.
        if (url.pathname.endsWith('/me/businesses')) {
          return json(200, { data: [{ id: 'biz-1', name: 'Eleganz Collections' }] });
        }
        if (url.pathname.includes('/owned_whatsapp_business_accounts')) {
          return json(200, { data: [{ id: 'waba-1', name: 'Eleganz WABA' }] });
        }
        if (url.pathname.includes('/phone_numbers')) {
          return json(200, {
            data: [{ id: 'phone-1', display_phone_number: '+234 800 000 0001', verified_name: 'Eleganz' }],
          });
        }
        // Pages, for Messenger and Instagram.
        if (url.pathname.endsWith('/me/accounts')) {
          return json(200, {
            data: [{
              id: 'page-1',
              name: 'Eleganz Collections',
              access_token: 'PAGE-TOKEN',
              instagram_business_account: { id: 'ig-1', username: 'eleganzcollections' },
            }],
          });
        }
        // Webhook subscription.
        if (url.pathname.includes('/subscribed_apps')) return json(200, { success: true });
        // Token validation on connect.
        if (url.pathname.endsWith('/me')) return json(200, { id: 'page-1', name: 'Eleganz Collections' });
        // Outbound media upload, then send. Checked before the generic phone
        // route below, which would otherwise swallow /phone-1/messages.
        if (url.pathname.endsWith('/media')) return json(200, { id: 'media-99' });
        if (url.pathname.endsWith('/messages')) {
          return json(200, { messages: [{ id: `wamid.out.${seen.length}` }], message_id: 'mid.out' });
        }
        if (url.pathname.includes('/phone-1')) {
          return json(200, { id: 'phone-1', display_phone_number: '+234 800 000 0001' });
        }
        json(404, { error: { message: `stub has no route for ${url.pathname}` } });
      });
    });
    server.listen(STUB_PORT, () => resolve(STUB_PORT));
  });
}

async function main() {
  port = await startGraphStub();
  // The env these need is set by the runner, before this process starts —
  // see the header comment on STUB_PORT.
  const oauth = await import('../../src/application/inbox/channel-oauth.service');
  const { channelsService } = await import('../../src/application/inbox/channels.service');
  const { getAdapter } = await import('../../src/infrastructure/channels/registry');

  orgId = (await db.organization.create({
    data: { name: 'Meta Co', slug: `meta-${stamp}`, currency: 'NGN', status: 'ACTIVE', country: 'NG' },
  })).id;
  const as = <T>(fn: () => Promise<T>): Promise<T> =>
    requestContext.run({ requestId: `m-${stamp}`, organizationId: orgId } as never, fn);

  // ── 1. The app is configured, so OAuth is on offer ───────────────────────
  console.log('\nWith a Meta app configured, one-click connection is offered');
  check('WhatsApp supports OAuth', oauth.supportsOAuth('WHATSAPP'));
  check('Messenger too', oauth.supportsOAuth('FACEBOOK_MESSENGER'));
  check('Instagram too', oauth.supportsOAuth('INSTAGRAM'));
  check('and a channel Meta does not serve does not', !oauth.supportsOAuth('TELEGRAM'));

  // ── 2. The authorization URL Meta will actually accept ───────────────────
  console.log('\nThe authorization URL is the one Meta expects');
  let waState = '';
  {
    const { url, state } = oauth.authorizationUrl({
      channelType: 'WHATSAPP', organizationId: orgId, userId: 'user-1',
    });
    const parsed = new URL(url);
    check('it opens Meta\'s own dialog', parsed.hostname === 'www.facebook.com');
    check('carrying our app id', parsed.searchParams.get('client_id') === APP_ID);
    check('and a redirect back to us',
      parsed.searchParams.get('redirect_uri') === 'https://hub.test.vhicasar.com/api/v1/channels/whatsapp/callback');
    check('with the WhatsApp scopes',
      (parsed.searchParams.get('scope') ?? '').includes('whatsapp_business_messaging'));
    check('standard OAuth asks for business management so it can list WABAs',
      (parsed.searchParams.get('scope') ?? '').includes('business_management'));
    check('and an unguessable state', typeof state === 'string' && state.length >= 16);
    waState = state;

    const ig = oauth.authorizationUrl({
      channelType: 'INSTAGRAM', organizationId: orgId, userId: 'user-1',
    });
    check('Instagram asks to manage messages',
      new URL(ig.url).searchParams.get('scope')?.includes('instagram_manage_messages') === true);
    check('and each channel gets its own callback',
      new URL(ig.url).searchParams.get('redirect_uri')?.endsWith('/instagram/callback') === true);
  }

  // ── 3. The callback: code in, connected account out ──────────────────────
  console.log('\nThe callback turns a code into a connected WhatsApp account');
  let waAccountId = '';
  await as(async () => {
    const resolved = await oauth.completeCallback({
      channelType: 'WHATSAPP', code: 'AUTH-CODE', state: waState, organizationId: orgId,
    });
    check('it found the business\'s number', resolved.externalId === 'phone-1');
    check('and named it for the UI', resolved.displayName.length > 0, resolved.displayName);

    const account = await channelsService.connectFromOAuth(resolved);
    waAccountId = account.id;
    // The route subscribes right after connecting; without this the account is
    // authorised but deaf, so the test follows the same order.
    await oauth.subscribeWebhooks(resolved);
    check('an account row exists', Boolean(waAccountId));

    const row = await db.channelAccount.findFirstOrThrow({
      where: { id: waAccountId },
      select: { credentialsEnc: true, webhookSecret: true, status: true, organizationId: true },
    });
    check('it belongs to this business', row.organizationId === orgId);
    check('it reads as connected', row.status === 'CONNECTED');
    check('it has a webhook verify token', (row.webhookSecret ?? '').length > 0);
    check('credentials are encrypted at rest',
      Boolean(row.credentialsEnc) && !row.credentialsEnc!.includes('USER-TOKEN'),
      'the raw token must not be readable in the column');
    const creds = JSON.parse(decrypt(row.credentialsEnc!)) as Record<string, string>;
    check('and decrypt back to a usable token', creds.accessToken === 'USER-TOKEN');
    check('with the phone number id the sender needs', creds.phoneNumberId === 'phone-1');
  });

  // ── 4. What we actually asked Graph for ──────────────────────────────────
  console.log('\nWe called Graph the way Graph documents it');
  {
    const exchange = seen.find((r) => r.path.endsWith('/oauth/access_token'));
    check('the code was exchanged', Boolean(exchange));
    check('with the app secret, not the app id twice',
      exchange?.query.get('client_secret') === APP_SECRET);
    check('and the same redirect_uri as the dialog',
      exchange?.query.get('redirect_uri')?.endsWith('/whatsapp/callback') === true,
      'Meta rejects an exchange whose redirect_uri differs from the dialog\'s');
    check('the webhook was subscribed',
      seen.some((r) => r.path.includes('/subscribed_apps') && r.method === 'POST'));
  }

  // ── 5. Messenger and Instagram, through the same flow ────────────────────
  console.log('\nMessenger and Instagram connect through the same path');
  await as(async () => {
    const page = await oauth.completeCallback({
      channelType: 'FACEBOOK_MESSENGER',
      code: 'AUTH-CODE',
      state: oauth.authorizationUrl({
        channelType: 'FACEBOOK_MESSENGER', organizationId: orgId, userId: 'user-1',
      }).state,
      organizationId: orgId,
    });
    check('the Page is resolved', page.externalId === 'page-1');
    const pageAccount = await channelsService.connectFromOAuth(page);
    const creds = JSON.parse(
      decrypt((await db.channelAccount.findFirstOrThrow({
        where: { id: pageAccount.id }, select: { credentialsEnc: true },
      })).credentialsEnc!),
    ) as Record<string, string>;
    check('with the Page token that sends messages', creds.pageAccessToken === 'PAGE-TOKEN');

    const ig = await oauth.completeCallback({
      channelType: 'INSTAGRAM',
      code: 'AUTH-CODE',
      state: oauth.authorizationUrl({
        channelType: 'INSTAGRAM', organizationId: orgId, userId: 'user-1',
      }).state,
      organizationId: orgId,
    });
    check('Instagram resolves through its linked Page', ig.externalId === 'ig-1');
    check('and is named by its handle', /eleganzcollections/.test(ig.displayName), ig.displayName);
  });

  // ── 6. Sending, including a document ─────────────────────────────────────
  console.log('\nSending works, and a document goes as a document');
  {
    const account = await db.channelAccount.findFirstOrThrow({
      where: { id: waAccountId },
      select: { id: true, organizationId: true, externalId: true, credentialsEnc: true, webhookSecret: true },
    });
    const ref = {
      id: account.id,
      organizationId: account.organizationId,
      externalId: account.externalId,
      credentials: JSON.parse(decrypt(account.credentialsEnc!)) as Record<string, string>,
      webhookSecret: account.webhookSecret,
    };
    const adapter = getAdapter('WHATSAPP');

    seen.length = 0;
    const text = await adapter.sendMessage(
      { recipientExternalId: '2348030000001', text: 'Hello from Vhicasar' }, ref,
    );
    check('a text message is accepted', text.providerMessageId.startsWith('wamid.'));

    seen.length = 0;
    await adapter.sendMessage(
      {
        recipientExternalId: '2348030000001',
        text: 'Your invoice',
        attachments: [{
          buffer: Buffer.from('%PDF-1.4 fake'), mimeType: 'application/pdf', filename: 'invoice.pdf',
        }],
      },
      ref,
    );
    check('the file was uploaded first', seen.some((r) => r.path.endsWith('/media')));
    const send = seen.find((r) => r.path.endsWith('/messages'));
    const sent = JSON.parse(send?.body ?? '{}') as { type?: string; document?: { filename?: string } };
    check('and sent as a document, not an image', sent.type === 'document',
      'WhatsApp refuses a PDF sent as type: image — this was the bug');
    check('keeping its filename', sent.document?.filename === 'invoice.pdf');
  }

  // ── 7. Instagram refuses documents clearly ───────────────────────────────
  console.log('\nInstagram says plainly what it cannot do');
  {
    const adapter = getAdapter('INSTAGRAM');
    let message = '';
    try {
      await adapter.sendMessage(
        {
          recipientExternalId: 'ig-user',
          text: '',
          attachments: [{
            buffer: Buffer.from('x'), mimeType: 'application/pdf', filename: 'a.pdf',
          }],
        },
        {
          id: 'x', organizationId: orgId, externalId: 'ig-1',
          credentials: { pageAccessToken: 'PAGE-TOKEN' }, webhookSecret: null,
        },
      );
    } catch (e) { message = (e as Error).message; }
    check('a document is refused before it reaches Meta', /cannot receive documents/i.test(message), message);
  }

  await cleanup();
  console.log(`\n${passed} passed, ${failed} failed`);
  server?.close();
  process.exit(failed === 0 ? 0 : 1);
}

async function cleanup() {
  await db.message.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.conversation.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.customerIdentity.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.customer.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.channelAccount.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.activity.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.auditLog.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.organization.delete({ where: { id: orgId } }).catch(() => {});
}

main().catch(async (e) => { console.error(e); await cleanup(); server?.close(); process.exit(1); });
