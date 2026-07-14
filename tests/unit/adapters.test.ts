import { createHmac } from 'crypto';
import { describe, expect, it } from 'vitest';
import { TelegramAdapter } from '../../src/infrastructure/channels/telegram.adapter';
import { WhatsAppAdapter, verifyMetaSignature } from '../../src/infrastructure/channels/whatsapp.adapter';
import { MetaMessagingAdapter } from '../../src/infrastructure/channels/meta.adapter';
import type { ChannelAccountRef } from '../../src/application/inbox/channel-adapter';

const account = (over: Partial<ChannelAccountRef> = {}): ChannelAccountRef => ({
  id: 'acc1',
  organizationId: 'org1',
  externalId: 'ext1',
  credentials: {},
  webhookSecret: 'secret-token',
  ...over,
});

describe('TelegramAdapter', () => {
  const adapter = new TelegramAdapter();

  it('verifies the webhook secret header', () => {
    const ok = adapter.verifyWebhook(
      { headers: { 'x-telegram-bot-api-secret-token': 'secret-token' }, body: {}, query: {} },
      account()
    );
    const bad = adapter.verifyWebhook(
      { headers: { 'x-telegram-bot-api-secret-token': 'wrong' }, body: {}, query: {} },
      account()
    );
    expect(ok).toBe(true);
    expect(bad).toBe(false);
  });

  it('parses a text message', () => {
    const [msg] = adapter.parseInbound({
      update_id: 1,
      message: {
        message_id: 42,
        date: 1_700_000_000,
        text: 'Hello!',
        chat: { id: 987, type: 'private' },
        from: { id: 987, first_name: 'Amara', last_name: 'Obi' },
      },
    });
    expect(msg).toMatchObject({
      providerMessageId: '42',
      senderExternalId: '987',
      senderDisplayName: 'Amara Obi',
      contentType: 'TEXT',
      text: 'Hello!',
    });
  });

  it('parses photos with captions and ignores unsupported kinds', () => {
    const photo = adapter.parseInbound({
      update_id: 2,
      message: {
        message_id: 43,
        date: 1_700_000_000,
        caption: 'my receipt',
        photo: [{ file_id: 'f1' }],
        chat: { id: 987, type: 'private' },
        from: { id: 987, first_name: 'Amara' },
      },
    });
    expect(photo[0]).toMatchObject({ contentType: 'IMAGE', text: 'my receipt' });

    expect(adapter.parseInbound({ update_id: 3 })).toEqual([]);
    expect(adapter.parseInbound(null)).toEqual([]);
  });
});

describe('Meta signature verification', () => {
  const APP_SECRET = 'meta-app-secret';
  const rawBody = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account' }));
  const sign = (secret: string) =>
    `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;

  it('accepts a valid signature and rejects invalid/missing ones', () => {
    const base = { body: {}, query: {} };
    expect(
      verifyMetaSignature({ ...base, headers: { 'x-hub-signature-256': sign(APP_SECRET) }, rawBody } as never, APP_SECRET)
    ).toBe(true);
    expect(
      verifyMetaSignature({ ...base, headers: { 'x-hub-signature-256': sign('other') }, rawBody } as never, APP_SECRET)
    ).toBe(false);
    expect(verifyMetaSignature({ ...base, headers: {}, rawBody } as never, APP_SECRET)).toBe(false);
    expect(
      verifyMetaSignature({ ...base, headers: { 'x-hub-signature-256': sign(APP_SECRET) } } as never, APP_SECRET)
    ).toBe(false); // no raw body captured
  });
});

describe('WhatsAppAdapter.parseInbound', () => {
  const adapter = new WhatsAppAdapter();

  it('parses text messages with contact names', () => {
    const [msg] = adapter.parseInbound({
      object: 'whatsapp_business_account',
      entry: [{
        changes: [{
          value: {
            contacts: [{ profile: { name: 'Fatima' }, wa_id: '2348010000000' }],
            messages: [{
              from: '2348010000000',
              id: 'wamid.X1',
              timestamp: '1700000000',
              type: 'text',
              text: { body: 'Do you deliver?' },
            }],
          },
        }],
      }],
    });
    expect(msg).toMatchObject({
      providerMessageId: 'wamid.X1',
      senderExternalId: '2348010000000',
      senderDisplayName: 'Fatima',
      contentType: 'TEXT',
      text: 'Do you deliver?',
    });
  });

  it('ignores non-WhatsApp payloads and status-only deliveries', () => {
    expect(adapter.parseInbound({ object: 'page' })).toEqual([]);
    expect(
      adapter.parseInbound({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: {} }] }] })
    ).toEqual([]);
  });
});

describe('MetaMessagingAdapter', () => {
  const messenger = new MetaMessagingAdapter('FACEBOOK_MESSENGER', 'page');

  it('parses messenger text and filters echoes', () => {
    const body = {
      object: 'page',
      entry: [{
        messaging: [
          { sender: { id: 'u1' }, timestamp: 1700000000000, message: { mid: 'm1', text: 'hey' } },
          { sender: { id: 'pageid' }, timestamp: 1700000000001, message: { mid: 'm2', text: 'echo', is_echo: true } },
        ],
      }],
    };
    const parsed = messenger.parseInbound(body);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ providerMessageId: 'm1', senderExternalId: 'u1', text: 'hey' });
  });

  it('only accepts its own webhook object type', () => {
    const instagram = new MetaMessagingAdapter('INSTAGRAM', 'instagram');
    const pageBody = { object: 'page', entry: [{ messaging: [{ sender: { id: 'x' }, message: { mid: 'm' , text: 't' } }] }] };
    expect(instagram.parseInbound(pageBody)).toEqual([]);
    expect(messenger.parseInbound(pageBody)).toHaveLength(1);
  });
});
