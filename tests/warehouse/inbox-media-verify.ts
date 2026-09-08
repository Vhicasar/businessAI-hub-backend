/*
 * Inbound attachments.
 *
 * Provider media links are temporary — Meta's CDN URLs expire within minutes,
 * and WhatsApp gives no link at all, only an id to exchange using the
 * account's own token. Keeping either would leave an inbox where every photo
 * older than an afternoon is a broken image.
 *
 * So the bytes are copied into Vhicasar's own storage while the reference is
 * still good. What is checked here is that they are, that the message survives
 * when they cannot be, and that an attachment is never readable across tenants.
 */
import { prismaUnscoped as db } from '../../src/infrastructure/database/prisma';
import { requestContext } from '../../src/shared/context';
import { inboxService } from '../../src/application/inbox/inbox.service';
import { getAdapter } from '../../src/infrastructure/channels/registry';
import type { NormalizedInbound } from '../../src/application/inbox/channel-adapter';

let passed = 0, failed = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); }
};

const stamp = Date.now();
let orgId = '', accountId = '';

const as = <T>(fn: () => Promise<T>): Promise<T> =>
  requestContext.run({ requestId: `m-${stamp}`, organizationId: orgId } as never, fn);

/** A one-pixel PNG — small, but genuinely a file. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const inbound = (over: Partial<NormalizedInbound> = {}): NormalizedInbound => ({
  providerMessageId: `wamid.${stamp}.${Math.random().toString(36).slice(2)}`,
  senderExternalId: `2348000${stamp % 100000}`,
  senderDisplayName: 'Ada',
  contentType: 'IMAGE',
  text: 'Here is the receipt',
  ...over,
});

async function main() {
  orgId = (await db.organization.create({
    data: { name: 'Media Co', slug: `media-${stamp}`, currency: 'NGN', status: 'ACTIVE', country: 'NG' },
  })).id;
  accountId = (await db.channelAccount.create({
    data: {
      organizationId: orgId, channelType: 'WHATSAPP', name: 'Support',
      externalId: `pn-${stamp}`, isActive: true, autoReply: false,
    },
  })).id;

  const adapter = getAdapter('WHATSAPP');
  const realDownload = adapter.downloadMedia;

  // ── 1. The reference survives parsing ────────────────────────────────────
  console.log('\nThe adapter carries the reference, not just the caption');
  {
    const body = {
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ value: {
        contacts: [{ profile: { name: 'Ada' }, wa_id: '234800' }],
        messages: [{
          from: '234800', id: `wamid.parse.${stamp}`, type: 'image',
          image: { caption: 'receipt', id: 'MEDIA-123', mime_type: 'image/jpeg' },
        }],
      } }] }],
    };
    const parsed = adapter.parseInbound(body);
    check('the image is parsed', parsed[0]?.contentType === 'IMAGE');
    check('the caption is kept', parsed[0]?.text === 'receipt');
    check('and so is the media id', parsed[0]?.media?.externalId === 'MEDIA-123',
      'without it the picture cannot be fetched at all');
    check('along with its type', parsed[0]?.media?.mimeType === 'image/jpeg');

    const documents = adapter.parseInbound({
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ value: { messages: [{
        from: '234800', id: `wamid.doc.${stamp}`, type: 'document',
        document: { id: 'DOC-9', filename: 'invoice.pdf', mime_type: 'application/pdf' },
      }] } }] }],
    });
    check('a document keeps its filename', documents[0]?.media?.filename === 'invoice.pdf');
  }

  // ── 2. The bytes land in Vhicasar's own storage ──────────────────────────
  console.log("\nThe bytes are copied into Vhicasar's storage");
  // Stubbed so the test never calls Meta; what is under test is the ingestion,
  // not fetch().
  (adapter as { downloadMedia?: unknown }).downloadMedia = async () => ({
    buffer: PNG, mimeType: 'image/png', filename: 'receipt.png',
  });

  let messageId = '';
  await as(async () => {
    const msg = inbound({ media: { externalId: 'MEDIA-1' } });
    await inboxService.processInbound(
      { id: accountId, organizationId: orgId, channelType: 'WHATSAPP' }, msg,
    );
    const saved = await db.message.findFirstOrThrow({
      where: { organizationId: orgId, providerMessageId: msg.providerMessageId },
      include: { attachments: { include: { file: true } } },
    });
    messageId = saved.id;
    check('the message is saved', saved.contentType === 'IMAGE');
    check('with an attachment on it', saved.attachments.length === 1);
    check('pointing at a stored file', Boolean(saved.attachments[0]?.file?.id));
    check('the caption travels with it', saved.attachments[0]?.caption === 'Here is the receipt');
    check('the file keeps its type', saved.attachments[0]?.file?.mimeType === 'image/png');
    check('and is private, not world-readable',
      saved.attachments[0]?.file?.isPublic === false,
      'a customer attachment is not public');
    check('the file belongs to this business',
      saved.attachments[0]?.file?.organizationId === orgId);
  });

  // ── 3. A failed download must not cost the message ───────────────────────
  console.log('\nA photo we cannot fetch is no reason to lose the message');
  (adapter as { downloadMedia?: unknown }).downloadMedia = async () => null;
  await as(async () => {
    const msg = inbound({ text: 'Look at this', media: { externalId: 'GONE' } });
    await inboxService.processInbound(
      { id: accountId, organizationId: orgId, channelType: 'WHATSAPP' }, msg,
    );
    const saved = await db.message.findFirst({
      where: { organizationId: orgId, providerMessageId: msg.providerMessageId },
      include: { attachments: true },
    });
    check('the message is still there', saved?.body === 'Look at this');
    check('just without an attachment', saved?.attachments.length === 0);
  });

  console.log('\nAnd neither does one that throws');
  (adapter as { downloadMedia?: unknown }).downloadMedia = async () => {
    throw new Error('CDN unreachable');
  };
  await as(async () => {
    const msg = inbound({ text: 'Second try', media: { externalId: 'BOOM' } });
    let threw = false;
    try {
      await inboxService.processInbound(
        { id: accountId, organizationId: orgId, channelType: 'WHATSAPP' }, msg,
      );
    } catch { threw = true; }
    check('processing does not throw', !threw);
    const saved = await db.message.findFirst({
      where: { organizationId: orgId, providerMessageId: msg.providerMessageId },
    });
    check('and the message is saved', saved?.body === 'Second try');
  });

  // ── 4. A text message is not given an attachment ─────────────────────────
  console.log('\nA plain message is left alone');
  (adapter as { downloadMedia?: unknown }).downloadMedia = async () => ({
    buffer: PNG, mimeType: 'image/png', filename: 'x.png',
  });
  await as(async () => {
    const msg = inbound({ contentType: 'TEXT', text: 'Just asking', media: undefined });
    await inboxService.processInbound(
      { id: accountId, organizationId: orgId, channelType: 'WHATSAPP' }, msg,
    );
    const saved = await db.message.findFirstOrThrow({
      where: { organizationId: orgId, providerMessageId: msg.providerMessageId },
      include: { attachments: true },
    });
    check('no attachment is invented', saved.attachments.length === 0);
  });

  // ── 5. Redelivery does not duplicate the file ────────────────────────────
  console.log('\nA redelivered webhook does not store the photo twice');
  await as(async () => {
    const before = await db.file.count({ where: { organizationId: orgId } });
    const msg = inbound({ media: { externalId: 'MEDIA-1' } });
    await inboxService.processInbound(
      { id: accountId, organizationId: orgId, channelType: 'WHATSAPP' }, msg,
    );
    await inboxService.processInbound(
      { id: accountId, organizationId: orgId, channelType: 'WHATSAPP' }, msg,
    );
    const after = await db.file.count({ where: { organizationId: orgId } });
    check('exactly one new file', after === before + 1, `${before} → ${after}`);
    const messages = await db.message.count({
      where: { organizationId: orgId, providerMessageId: msg.providerMessageId },
    });
    check('and one message', messages === 1);
  });

  (adapter as { downloadMedia?: unknown }).downloadMedia = realDownload;

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
  await db.file.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.channelAccount.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.auditLog.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.organization.delete({ where: { id: orgId } }).catch(() => {});
}

main().catch(async (e) => { console.error(e); await cleanup(); process.exit(1); });
