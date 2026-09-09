import type { ChannelType } from '@prisma/client';
import { createHash } from 'crypto';
import { env } from '../../shared/config/env';
import type {
  ChannelAccountRef,
  ChannelAdapter,
  DownloadedMedia,
  InboundMedia,
  NormalizedInbound,
  NormalizedStatus,
  OutboundPayload,
  SendResult,
  WebhookRequestLike,
} from '../../application/inbox/channel-adapter';
import { mediaKindFor } from '../../application/inbox/channel-adapter';
import { AppError } from '../../shared/errors';
import { extensionFor, verifyMetaSignature } from './whatsapp.adapter';

// Was pinned to v21.0 and ignored META_GRAPH_VERSION; read at call time so
// a stub or a version bump reaches every adapter alike.
const graph = () => env.meta.graphUrl;

interface MetaMessagingEvent {
  sender?: { id?: string };
  timestamp?: number;
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
    attachments?: { type?: string; payload?: { url?: string } }[];
  };
  postback?: { title?: string; payload?: string };
}

interface MetaWebhookBody {
  object?: string;
  entry?: {
    messaging?: (MetaMessagingEvent & {
      /// Receipts. Messenger reports these per-conversation with a watermark
      /// timestamp rather than per-message ids, except for `message_edit`.
      delivery?: { mids?: string[]; watermark?: number };
      read?: { watermark?: number };
    })[];
  }[];
}

/**
 * Facebook Messenger & Instagram DM share the Meta Graph messaging shape;
 * this adapter is parametrized by channel + webhook object type.
 * Credentials: { pageAccessToken, appSecret, pageId }.
 */
export class MetaMessagingAdapter implements ChannelAdapter {
  constructor(
    readonly channelType: ChannelType,
    private readonly webhookObject: 'page' | 'instagram'
  ) {}

  verifyWebhook(req: WebhookRequestLike, account: ChannelAccountRef): boolean {
    return verifyMetaSignature(req, account.credentials.appSecret ?? '');
  }

  parseInbound(body: unknown): NormalizedInbound[] {
    const meta = body as MetaWebhookBody;
    if (meta.object !== this.webhookObject) return [];

    const out: NormalizedInbound[] = [];
    for (const entry of meta.entry ?? []) {
      for (const event of entry.messaging ?? []) {
        const senderId = event.sender?.id;
        const msg = event.message;
        if (senderId && event.postback) {
          const content = event.postback.payload || event.postback.title || 'postback';
          const digest = createHash('sha256').update(`${senderId}:${event.timestamp ?? 0}:${content}`).digest('hex').slice(0, 32);
          out.push({
            providerMessageId: `postback.${digest}`,
            senderExternalId: senderId,
            sentAt: event.timestamp ? new Date(event.timestamp) : undefined,
            contentType: 'TEXT',
            text: event.postback.title || event.postback.payload || 'Postback',
            raw: event,
          });
          continue;
        }
        if (!senderId || !msg?.mid || msg.is_echo) continue; // echoes = our own sends

        const base = {
          providerMessageId: msg.mid,
          senderExternalId: senderId,
          sentAt: event.timestamp ? new Date(event.timestamp) : undefined,
          raw: event,
        };
        if (msg.text) {
          out.push({ ...base, contentType: 'TEXT', text: msg.text });
        } else if (msg.attachments?.length) {
          const kind = msg.attachments[0]?.type;
          out.push({
            ...base,
            contentType:
              kind === 'image' ? 'IMAGE' : kind === 'video' ? 'VIDEO' : kind === 'audio' ? 'AUDIO' : 'DOCUMENT',
            mediaUrl: msg.attachments[0]?.payload?.url,
            media: msg.attachments[0]?.payload?.url
              ? { url: msg.attachments[0]!.payload!.url }
              : undefined,
          });
        }
      }
    }
    return out;
  }

  /**
   * Delivery and read receipts.
   *
   * Messenger and Instagram report delivery with an explicit list of message
   * ids where they can, and otherwise only a watermark — "everything up to
   * this time is delivered". Only the explicit ids are used: a watermark would
   * mean scanning the conversation for older messages, and claiming a message
   * was read on the strength of a timestamp is a claim worth being careful
   * about.
   */
  parseStatuses(body: unknown): NormalizedStatus[] {
    const meta = body as MetaWebhookBody;
    if (meta.object !== this.webhookObject) return [];

    const out: NormalizedStatus[] = [];
    for (const entry of meta.entry ?? []) {
      for (const event of entry.messaging ?? []) {
        for (const mid of event.delivery?.mids ?? []) {
          out.push({
            providerMessageId: mid,
            status: 'DELIVERED',
            occurredAt: event.delivery?.watermark
              ? new Date(event.delivery.watermark)
              : undefined,
          });
        }
      }
    }
    return out;
  }

  /**
   * Fetch an attachment from the CDN link Meta gave us.
   *
   * The link needs no token but expires, so the bytes are copied out now
   * rather than the URL being stored and found dead a week later.
   */
  async downloadMedia(media: InboundMedia): Promise<DownloadedMedia | null> {
    if (!media.url) return null;
    const res = await fetch(media.url);
    if (!res.ok) return null;
    const mimeType =
      res.headers.get('content-type')?.split(';')[0]?.trim() ??
      media.mimeType ??
      'application/octet-stream';
    return {
      buffer: Buffer.from(await res.arrayBuffer()),
      mimeType,
      filename: media.filename ?? `${this.channelType.toLowerCase()}-attachment${extensionFor(mimeType)}`,
    };
  }

  async sendMessage(payload: OutboundPayload, account: ChannelAccountRef): Promise<SendResult> {
    const token = account.credentials.pageAccessToken;
    if (!token) {
      throw new AppError('CHANNEL_MISCONFIGURED', 500, `${this.channelType} page token missing`);
    }
    /*
     * Attachments go up first, each as its own message.
     *
     * Messenger's send API takes one attachment per message and no caption
     * alongside it, so the text is sent as a separate message rather than
     * silently dropped — which is what putting both in one payload would do.
     */
    const attachments = (payload.attachments ?? []).slice(0, 5);
    for (const attachment of attachments) {
      const kind = mediaKindFor(attachment.mimeType);
      if (this.channelType === 'INSTAGRAM' && kind === 'document') {
        // Instagram messaging has no document type; refusing here gives a
        // clear error instead of a confusing one from Meta.
        throw new AppError(
          'CHANNEL_UNSUPPORTED_MEDIA',
          400,
          'Instagram cannot receive documents. Send an image or video instead.',
        );
      }
      const form = new FormData();
      form.append('recipient', JSON.stringify({ id: payload.recipientExternalId }));
      form.append('messaging_type', 'RESPONSE');
      form.append(
        'message',
        JSON.stringify({ attachment: { type: kind, payload: { is_reusable: false } } }),
      );
      form.append(
        'filedata',
        new Blob([new Uint8Array(attachment.buffer)], { type: attachment.mimeType }),
        attachment.filename,
      );
      const upload = await fetch(
        `${graph()}/me/messages?access_token=${encodeURIComponent(token)}`,
        { method: 'POST', body: form },
      );
      const uploadJson = (await upload.json()) as { error?: { message?: string } };
      if (!upload.ok) {
        throw new AppError(
          'CHANNEL_SEND_FAILED',
          502,
          `${this.channelType} attachment failed: ${uploadJson.error?.message ?? upload.status}`,
        );
      }
    }

    // Nothing further to say once the files are away.
    if (attachments.length > 0 && !payload.text.trim()) {
      return { providerMessageId: `attachment.${Date.now()}` };
    }

    const res = await fetch(`${graph()}/me/messages?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: payload.recipientExternalId },
        messaging_type: 'RESPONSE',
        message: { text: payload.text },
      }),
    });
    const json = (await res.json()) as { message_id?: string; error?: { message?: string } };
    if (!res.ok || !json.message_id) {
      throw new AppError(
        'CHANNEL_SEND_FAILED',
        502,
        `${this.channelType} send failed: ${json.error?.message ?? res.status}`
      );
    }
    return { providerMessageId: json.message_id };
  }

  async onAccountConnected(account: ChannelAccountRef, _webhookUrl: string): Promise<string | null> {
    const res = await fetch(
      `${graph()}/me?access_token=${encodeURIComponent(account.credentials.pageAccessToken ?? '')}`
    );
    if (!res.ok) {
      throw new AppError('CHANNEL_MISCONFIGURED', 400, 'Page access token invalid');
    }
    const me = (await res.json()) as { name?: string };
    return `Connected to "${me.name ?? 'page'}". Vhicasar uses the platform-level ${this.webhookObject} webhook; no business-specific callback setup is required.`;
  }
}
