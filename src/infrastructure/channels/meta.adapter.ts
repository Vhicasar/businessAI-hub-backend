import type { ChannelType } from '@prisma/client';
import type {
  ChannelAccountRef,
  ChannelAdapter,
  NormalizedInbound,
  OutboundPayload,
  SendResult,
  WebhookRequestLike,
} from '../../application/inbox/channel-adapter';
import { AppError } from '../../shared/errors';
import { verifyMetaSignature } from './whatsapp.adapter';

const GRAPH = 'https://graph.facebook.com/v21.0';

interface MetaMessagingEvent {
  sender?: { id?: string };
  timestamp?: number;
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
    attachments?: { type?: string; payload?: { url?: string } }[];
  };
}

interface MetaWebhookBody {
  object?: string;
  entry?: { messaging?: MetaMessagingEvent[] }[];
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
          });
        }
      }
    }
    return out;
  }

  async sendMessage(payload: OutboundPayload, account: ChannelAccountRef): Promise<SendResult> {
    const token = account.credentials.pageAccessToken;
    if (!token) {
      throw new AppError('CHANNEL_MISCONFIGURED', 500, `${this.channelType} page token missing`);
    }
    const res = await fetch(`${GRAPH}/me/messages?access_token=${encodeURIComponent(token)}`, {
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

  async onAccountConnected(account: ChannelAccountRef, webhookUrl: string): Promise<string | null> {
    const res = await fetch(
      `${GRAPH}/me?access_token=${encodeURIComponent(account.credentials.pageAccessToken ?? '')}`
    );
    if (!res.ok) {
      throw new AppError('CHANNEL_MISCONFIGURED', 400, 'Page access token invalid');
    }
    const me = (await res.json()) as { name?: string };
    return (
      `Connected to "${me.name ?? 'page'}". In the Meta app dashboard (Webhooks → ${this.webhookObject}) ` +
      `set Callback URL to ${webhookUrl} and Verify token to ${account.webhookSecret}, then ` +
      `subscribe to the "messages" field.`
    );
  }
}
