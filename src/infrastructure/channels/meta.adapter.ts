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
import { extensionFor, validateMetaTokenOwnership, verifyMetaSignature } from './whatsapp.adapter';

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
 * Messenger credentials: { pageAccessToken, appSecret, pageId }.
 * Direct Instagram credentials: { accessToken, appSecret, instagramAccountId }.
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

  async enrichInbound(inbound: NormalizedInbound, account: ChannelAccountRef): Promise<NormalizedInbound> {
    const instagram = this.channelType === 'INSTAGRAM';
    const directInstagram = instagram && Boolean(account.credentials.accessToken);
    const token = directInstagram ? account.credentials.accessToken : account.credentials.pageAccessToken;
    if (!token) return inbound;
    const fields = instagram
      ? (directInstagram ? 'name,username,profile_picture_url' : 'name,username,profile_pic')
      : 'first_name,last_name,name,profile_pic';
    const base = directInstagram ? env.instagram.graphUrl : graph();
    const query = new URLSearchParams({ fields, access_token: token });
    try {
      const response = await fetch(`${base}/${encodeURIComponent(inbound.senderExternalId)}?${query.toString()}`);
      const profile = await response.json().catch(() => ({})) as {
        first_name?: string; last_name?: string; name?: string; username?: string;
        profile_pic?: string; profile_picture_url?: string;
      };
      if (!response.ok) return inbound;
      const structuredName = [profile.first_name, profile.last_name].filter(Boolean).join(' ');
      const displayName = profile.name || structuredName || profile.username;
      return {
        ...inbound,
        senderDisplayName: displayName || inbound.senderDisplayName,
        senderProfile: {
          firstName: profile.first_name ?? profile.name?.split(/\s+/)[0],
          lastName: profile.last_name ?? (profile.name?.split(/\s+/).slice(1).join(' ') || undefined),
          username: profile.username,
          profileUrl: profile.profile_pic ?? profile.profile_picture_url,
        },
      };
    } catch {
      // Profile enrichment is best-effort: never discard the actual message.
      return inbound;
    }
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
    const instagram = this.channelType === 'INSTAGRAM';
    const directInstagram = instagram && Boolean(account.credentials.accessToken);
    const token = directInstagram ? account.credentials.accessToken : account.credentials.pageAccessToken;
    if (!token) {
      throw new AppError('CHANNEL_MISCONFIGURED', 500, `${this.channelType} access token missing`);
    }
    const messagesUrl = directInstagram
      ? `${env.instagram.graphUrl}/${account.credentials.instagramAccountId}/messages?access_token=${encodeURIComponent(token)}`
      : `${graph()}/me/messages?access_token=${encodeURIComponent(token)}`;
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
        messagesUrl,
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

    const res = await fetch(messagesUrl, {
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
    const instagram = this.channelType === 'INSTAGRAM';
    const instagramModel = account.credentials.instagramApiModel;
    const directInstagram = instagram && instagramModel === 'INSTAGRAM_LOGIN';
    const token = directInstagram ? account.credentials.accessToken : account.credentials.pageAccessToken;
    if (directInstagram && !account.credentials.appSecret) {
      throw new AppError('CHANNEL_MISCONFIGURED', 400, 'Instagram App ID and App Secret are required for a manual connection.');
    }
    if (directInstagram) {
      // Instagram Login tokens are validated through graph.instagram.com.
      // Meta does not reliably expose their issuing app through the Facebook
      // debug_token contract, so app identity remains UNKNOWN rather than
      // fabricating a mismatch.
    } else {
      await validateMetaTokenOwnership({
        appId: account.credentials.appId, appSecret: account.credentials.appSecret,
        accessToken: token, label: 'Facebook Page',
        requiredScopes: ['pages_messaging', 'pages_manage_metadata'],
      });
    }
    const res = await fetch(directInstagram
      ? `${env.instagram.graphUrl}/me?fields=id,user_id,name,username,account_type&access_token=${encodeURIComponent(token ?? '')}`
      : `${graph()}/${account.credentials.pageId}?fields=id,name,instagram_business_account{id,username}&access_token=${encodeURIComponent(token ?? '')}`);
    if (!res.ok) {
      throw new AppError('TOKEN_INVALID', 400, `${instagram ? 'Instagram' : 'Page'} access token is invalid or cannot access the required account.`);
    }
    const me = (await res.json()) as {
      id?: string; user_id?: string; name?: string; username?: string; account_type?: string;
      instagram_business_account?: { id?: string; username?: string };
    };
    const returnedInstagramId = directInstagram ? (me.user_id ?? me.id) : me.instagram_business_account?.id;
    if (directInstagram && me.account_type && !['BUSINESS', 'MEDIA_CREATOR'].includes(me.account_type)) {
      throw new AppError('INSTAGRAM_ACCOUNT_NOT_ELIGIBLE', 400, 'The supplied account is not an Instagram Business or Creator account.');
    }
    if (account.credentials.instagramAccountId && returnedInstagramId !== account.credentials.instagramAccountId) {
      throw new AppError('INSTAGRAM_ACCOUNT_MISMATCH', 400, 'The Instagram Account ID does not belong to this access token.');
    }
    if (!directInstagram && me.id !== account.credentials.pageId) {
      throw new AppError('INSTAGRAM_ACCOUNT_MISMATCH', 400, 'The Facebook Page ID does not belong to this access token.');
    }
    if (directInstagram) {
      const permissionResponse = await fetch(
        `${env.instagram.graphUrl}/me/permissions?access_token=${encodeURIComponent(token ?? '')}`
      );
      const permissionJson = await permissionResponse.json().catch(() => ({})) as {
        data?: Array<{ permission?: string; status?: string }>;
      };
      const granted = new Set(
        (permissionJson.data ?? [])
          .filter((item) => item.status === 'granted')
          .map((item) => item.permission),
      );
      if (!permissionResponse.ok || !granted.has('instagram_business_basic') || !granted.has('instagram_business_manage_messages')) {
        if (permissionResponse.status === 401 || permissionResponse.status === 403) {
          throw new AppError('TOKEN_INVALID', 400, 'The Instagram access token is invalid or expired.');
        }
        throw new AppError(
          'MESSAGING_PERMISSION_MISSING',
          400,
          'The Instagram credentials are valid, but this access token does not grant messaging access.',
        );
      }
    }
    const username = directInstagram ? me.username : me.instagram_business_account?.username;
    return `Credentials validated for "${username ? `@${username}` : me.name ?? (instagram ? 'Instagram account' : 'page')}". Configure your Meta app webhook to complete inbound messaging setup.`;
  }
}
