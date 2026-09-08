import { createHmac, timingSafeEqual } from 'crypto';
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

// Was pinned to v21.0 and ignored META_GRAPH_VERSION.
const graph = () => env.meta.graphUrl;

/** WhatsApp's own status words, mapped onto Vhicasar's. */
const WA_STATUS: Record<string, NormalizedStatus['status']> = {
  sent: 'SENT',
  delivered: 'DELIVERED',
  read: 'READ',
  failed: 'FAILED',
};

interface WaWebhookBody {
  object?: string;
  entry?: {
    changes?: {
      value?: {
        contacts?: { profile?: { name?: string }; wa_id?: string }[];
        messages?: {
          from: string;
          id: string;
          timestamp?: string;
          type: string;
          text?: { body?: string };
          /// Media arrives as an id, not a link: it is exchanged for a
          /// short-lived URL using the account's own token.
          image?: { caption?: string; id?: string; mime_type?: string };
          document?: { caption?: string; filename?: string; id?: string; mime_type?: string };
          video?: { caption?: string; id?: string; mime_type?: string };
          audio?: { id?: string; mime_type?: string };
          location?: { latitude: number; longitude: number };
        }[];
        /// Receipts for messages we sent earlier — not messages themselves.
        statuses?: {
          id: string;
          status?: string;
          timestamp?: string;
          errors?: { title?: string; message?: string }[];
        }[];
      };
    }[];
  }[];
}

/** Shared by all Meta-family adapters (WhatsApp, Messenger, Instagram). */
export function verifyMetaSignature(req: WebhookRequestLike, appSecret: string): boolean {
  const header = req.headers['x-hub-signature-256'];
  const rawBody = (req as { rawBody?: Buffer }).rawBody;
  if (typeof header !== 'string' || !rawBody || !appSecret) return false;
  const expected = `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
  try {
    return timingSafeEqual(Buffer.from(header), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * WhatsApp Business Cloud API.
 * Credentials: { accessToken, phoneNumberId, appSecret }.
 * Webhook URL + verify token are configured in the Meta app dashboard
 * (Meta has no API for it) — the connect flow surfaces both.
 */
export class WhatsAppAdapter implements ChannelAdapter {
  readonly channelType = 'WHATSAPP' as const;

  verifyWebhook(req: WebhookRequestLike, account: ChannelAccountRef): boolean {
    return verifyMetaSignature(req, account.credentials.appSecret ?? '');
  }

  parseInbound(body: unknown): NormalizedInbound[] {
    const wa = body as WaWebhookBody;
    if (wa.object !== 'whatsapp_business_account') return [];

    const out: NormalizedInbound[] = [];
    for (const entry of wa.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        const name = value?.contacts?.[0]?.profile?.name;
        for (const msg of value?.messages ?? []) {
          const base = {
            providerMessageId: msg.id,
            senderExternalId: msg.from,
            senderDisplayName: name,
            sentAt: msg.timestamp ? new Date(Number(msg.timestamp) * 1000) : undefined,
            raw: msg,
          };
          switch (msg.type) {
            case 'text':
              out.push({ ...base, contentType: 'TEXT', text: msg.text?.body });
              break;
            case 'image':
              out.push({
                ...base,
                contentType: 'IMAGE',
                text: msg.image?.caption,
                media: msg.image?.id
                  ? { externalId: msg.image.id, mimeType: msg.image.mime_type }
                  : undefined,
              });
              break;
            case 'video':
              out.push({
                ...base,
                contentType: 'VIDEO',
                text: msg.video?.caption,
                media: msg.video?.id
                  ? { externalId: msg.video.id, mimeType: msg.video.mime_type }
                  : undefined,
              });
              break;
            case 'document':
              out.push({
                ...base,
                media: msg.document?.id
                  ? {
                      externalId: msg.document.id,
                      mimeType: msg.document.mime_type,
                      filename: msg.document.filename,
                    }
                  : undefined,
                contentType: 'DOCUMENT',
                text: msg.document?.caption ?? msg.document?.filename,
              });
              break;
            case 'audio':
            case 'voice':
              out.push({
                ...base,
                contentType: 'AUDIO',
                media: msg.audio?.id
                  ? { externalId: msg.audio.id, mimeType: msg.audio.mime_type }
                  : undefined,
              });
              break;
            case 'location':
              out.push({
                ...base,
                contentType: 'LOCATION',
                text: msg.location ? `${msg.location.latitude},${msg.location.longitude}` : undefined,
              });
              break;
            default:
              break; // reactions, system events etc. are not messages
          }
        }
      }
    }
    return out;
  }

  /**
   * Delivery receipts.
   *
   * WhatsApp reports sent → delivered → read down the same webhook as
   * messages, and they arrive out of order often enough that the inbox
   * refuses to move a message backwards (see applyStatus).
   */
  parseStatuses(body: unknown): NormalizedStatus[] {
    const payload = body as WaWebhookBody;
    const out: NormalizedStatus[] = [];
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        for (const status of change.value?.statuses ?? []) {
          const mapped = WA_STATUS[String(status.status).toLowerCase()];
          if (!mapped) continue;
          out.push({
            providerMessageId: status.id,
            status: mapped,
            occurredAt: status.timestamp
              ? new Date(Number(status.timestamp) * 1000)
              : undefined,
            error: status.errors?.[0]?.message ?? status.errors?.[0]?.title,
          });
        }
      }
    }
    return out;
  }

  /**
   * Fetch an attachment by id.
   *
   * Two hops, both authenticated: the id is exchanged for a short-lived CDN
   * URL, then that URL is read with the same bearer token. The link is useless
   * on its own and expires within minutes, which is exactly why the bytes are
   * copied into Vhicasar's own storage rather than the link being kept.
   */
  async downloadMedia(
    media: InboundMedia,
    account: ChannelAccountRef
  ): Promise<DownloadedMedia | null> {
    const token = account.credentials.accessToken;
    if (!token || !media.externalId) return null;

    const lookup = await fetch(`${graph()}/${encodeURIComponent(media.externalId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!lookup.ok) return null;
    const meta = (await lookup.json()) as { url?: string; mime_type?: string };
    if (!meta.url) return null;

    const file = await fetch(meta.url, { headers: { Authorization: `Bearer ${token}` } });
    if (!file.ok) return null;

    const mimeType = meta.mime_type ?? media.mimeType ?? 'application/octet-stream';
    return {
      buffer: Buffer.from(await file.arrayBuffer()),
      mimeType,
      filename: media.filename ?? `whatsapp-${media.externalId}${extensionFor(mimeType)}`,
    };
  }

  /**
   * Put a file on Meta's servers and get an id back.
   *
   * The alternative — handing Meta a link — needs the file to be publicly
   * fetchable, which Vhicasar's storage is deliberately not. Uploading also
   * works for documents, video and audio, where the link form is images only.
   */
  private async uploadMedia(
    attachment: { buffer: Buffer; mimeType: string; filename: string },
    account: ChannelAccountRef,
  ): Promise<string> {
    const { accessToken, phoneNumberId } = account.credentials;
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', attachment.mimeType);
    form.append(
      'file',
      new Blob([new Uint8Array(attachment.buffer)], { type: attachment.mimeType }),
      attachment.filename,
    );
    const res = await fetch(`${graph()}/${phoneNumberId}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      body: form,
    });
    const json = (await res.json()) as { id?: string; error?: { message?: string } };
    if (!res.ok || !json.id) {
      throw new AppError(
        'CHANNEL_SEND_FAILED',
        502,
        `WhatsApp media upload failed: ${json.error?.message ?? res.status}`,
      );
    }
    return json.id;
  }

  async sendMessage(payload: OutboundPayload, account: ChannelAccountRef): Promise<SendResult> {
    const { accessToken, phoneNumberId } = account.credentials;
    if (!accessToken || !phoneNumberId) {
      throw new AppError('CHANNEL_MISCONFIGURED', 500, 'WhatsApp credentials incomplete');
    }

    // Attached files first: uploaded, then sent by id and by their real kind,
    // so a PDF goes as a document rather than being refused as an image.
    const attachments = (payload.attachments ?? []).slice(0, 5);
    const attachmentBodies: Record<string, unknown>[] = [];
    for (const [index, attachment] of attachments.entries()) {
      const id = await this.uploadMedia(attachment, account);
      const kind = mediaKindFor(attachment.mimeType);
      attachmentBodies.push({
        messaging_product: 'whatsapp',
        to: payload.recipientExternalId,
        type: kind,
        [kind]: {
          id,
          // Only a document carries its own name; a caption belongs on the
          // first item so it is not repeated once per file.
          ...(kind === 'document' ? { filename: attachment.filename } : {}),
          ...(index === 0 && payload.text && kind !== 'audio' ? { caption: payload.text } : {}),
        },
      });
    }

    const mediaUrls = (payload.mediaUrls ?? []).slice(0, 3);
    const bodies = attachmentBodies.length
      ? attachmentBodies
      : mediaUrls.length
      ? mediaUrls.map((link, index) => ({
          messaging_product: 'whatsapp',
          to: payload.recipientExternalId,
          type: 'image',
          image: { link, ...(index === 0 ? { caption: payload.text } : {}) },
        }))
      : [payload.isMarketing && payload.templateName
          ? {
              messaging_product: 'whatsapp', to: payload.recipientExternalId, type: 'template',
              template: {
                name: payload.templateName,
                language: { code: payload.templateLanguage || 'en_US' },
                components: [{ type: 'body', parameters: [{ type: 'text', text: payload.text }] }],
              },
            }
          : { messaging_product: 'whatsapp', to: payload.recipientExternalId, type: 'text', text: { body: payload.text } }];
    let providerMessageId = '';
    for (const body of bodies) {
      const res = await fetch(`${graph()}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as { messages?: { id: string }[]; error?: { message?: string } };
      if (!res.ok || !json.messages?.[0]) {
        throw new AppError('CHANNEL_SEND_FAILED', 502, `WhatsApp send failed: ${json.error?.message ?? res.status}`);
      }
      providerMessageId ||= json.messages[0].id;
    }
    return { providerMessageId };
  }

  async onAccountConnected(account: ChannelAccountRef, webhookUrl: string): Promise<string | null> {
    // Validate the token/number by fetching the phone number resource.
    const res = await fetch(`${graph()}/${account.credentials.phoneNumberId}`, {
      headers: { Authorization: `Bearer ${account.credentials.accessToken}` },
    });
    if (!res.ok) {
      throw new AppError('CHANNEL_MISCONFIGURED', 400, 'WhatsApp token or phone number id invalid');
    }
    return (
      `Credentials verified. Now in the Meta app dashboard (WhatsApp → Configuration) set ` +
      `Callback URL to ${webhookUrl} and Verify token to ${account.webhookSecret}, then ` +
      `subscribe to the "messages" webhook field.`
    );
  }
}


/** A sensible file extension from a MIME type, for a name a person can read. */
export function extensionFor(mimeType: string): string {
  const known: Record<string, string> = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
    'video/mp4': '.mp4', 'video/3gpp': '.3gp',
    'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/amr': '.amr',
    'application/pdf': '.pdf',
  };
  return known[mimeType.split(';')[0]!.trim()] ?? '';
}
