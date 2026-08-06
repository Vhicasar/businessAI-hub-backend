import { createHmac, timingSafeEqual } from 'crypto';
import type {
  ChannelAccountRef,
  ChannelAdapter,
  NormalizedInbound,
  OutboundPayload,
  SendResult,
  WebhookRequestLike,
} from '../../application/inbox/channel-adapter';
import { AppError } from '../../shared/errors';

const GRAPH = 'https://graph.facebook.com/v21.0';

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
          image?: { caption?: string };
          document?: { caption?: string; filename?: string };
          audio?: unknown;
          location?: { latitude: number; longitude: number };
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
              out.push({ ...base, contentType: 'IMAGE', text: msg.image?.caption });
              break;
            case 'document':
              out.push({
                ...base,
                contentType: 'DOCUMENT',
                text: msg.document?.caption ?? msg.document?.filename,
              });
              break;
            case 'audio':
            case 'voice':
              out.push({ ...base, contentType: 'AUDIO' });
              break;
            case 'location':
              out.push({
                ...base,
                contentType: 'LOCATION',
                text: msg.location ? `${msg.location.latitude},${msg.location.longitude}` : undefined,
              });
              break;
            default:
              break; // statuses/reactions etc. ignored
          }
        }
      }
    }
    return out;
  }

  async sendMessage(payload: OutboundPayload, account: ChannelAccountRef): Promise<SendResult> {
    const { accessToken, phoneNumberId } = account.credentials;
    if (!accessToken || !phoneNumberId) {
      throw new AppError('CHANNEL_MISCONFIGURED', 500, 'WhatsApp credentials incomplete');
    }
    const mediaUrls = (payload.mediaUrls ?? []).slice(0, 3);
    const bodies = mediaUrls.length
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
      const res = await fetch(`${GRAPH}/${phoneNumberId}/messages`, {
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
    const res = await fetch(`${GRAPH}/${account.credentials.phoneNumberId}`, {
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
