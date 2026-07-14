import type {
  ChannelAccountRef,
  ChannelAdapter,
  NormalizedInbound,
  OutboundPayload,
  SendResult,
  WebhookRequestLike,
} from '../../application/inbox/channel-adapter';
import { AppError } from '../../shared/errors';
import { logger } from '../../shared/logger';

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    text?: string;
    caption?: string;
    photo?: { file_id: string }[];
    document?: { file_id: string; file_name?: string };
    voice?: { file_id: string };
    location?: { latitude: number; longitude: number };
    chat: { id: number; type: string };
    from?: { id: number; first_name?: string; last_name?: string; username?: string };
  };
}

/**
 * Telegram Bot API adapter.
 * Credentials: { botToken }. Webhook auth: Telegram echoes our secret in the
 * X-Telegram-Bot-Api-Secret-Token header (set during setWebhook).
 */
export class TelegramAdapter implements ChannelAdapter {
  readonly channelType = 'TELEGRAM' as const;

  private api(token: string, method: string): string {
    return `https://api.telegram.org/bot${token}/${method}`;
  }

  verifyWebhook(req: WebhookRequestLike, account: ChannelAccountRef): boolean {
    if (!account.webhookSecret) return false;
    const header = req.headers['x-telegram-bot-api-secret-token'];
    return header === account.webhookSecret;
  }

  parseInbound(body: unknown): NormalizedInbound[] {
    const update = body as TelegramUpdate;
    const msg = update?.message;
    if (!msg?.from || msg.from.id === undefined) return [];

    const name = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') ||
      msg.from.username || `Telegram ${msg.from.id}`;

    const base = {
      providerMessageId: String(msg.message_id),
      senderExternalId: String(msg.chat.id),
      senderDisplayName: name,
      sentAt: new Date(msg.date * 1000),
      raw: update,
    };

    if (msg.text) {
      return [{ ...base, contentType: 'TEXT', text: msg.text }];
    }
    if (msg.photo?.length) {
      return [{ ...base, contentType: 'IMAGE', text: msg.caption }];
    }
    if (msg.document) {
      return [{ ...base, contentType: 'DOCUMENT', text: msg.caption ?? msg.document.file_name }];
    }
    if (msg.voice) {
      return [{ ...base, contentType: 'AUDIO' }];
    }
    if (msg.location) {
      return [{
        ...base,
        contentType: 'LOCATION',
        text: `${msg.location.latitude},${msg.location.longitude}`,
      }];
    }
    // Unsupported message kinds are ignored rather than failing the webhook.
    return [];
  }

  async sendMessage(payload: OutboundPayload, account: ChannelAccountRef): Promise<SendResult> {
    const token = account.credentials.botToken;
    if (!token) throw new AppError('CHANNEL_MISCONFIGURED', 500, 'Telegram bot token missing');

    const res = await fetch(this.api(token, 'sendMessage'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: payload.recipientExternalId, text: payload.text }),
    });
    const json = (await res.json()) as {
      ok: boolean;
      description?: string;
      result?: { message_id: number };
    };
    if (!json.ok || !json.result) {
      throw new AppError(
        'CHANNEL_SEND_FAILED',
        502,
        `Telegram send failed: ${json.description ?? res.status}`
      );
    }
    return { providerMessageId: String(json.result.message_id) };
  }

  async onAccountConnected(account: ChannelAccountRef, webhookUrl: string): Promise<string | null> {
    const token = account.credentials.botToken;
    if (!token) throw new AppError('CHANNEL_MISCONFIGURED', 400, 'Telegram bot token missing');

    // Validate the token first — clearer error than a failed setWebhook.
    const meRes = await fetch(this.api(token, 'getMe'));
    const me = (await meRes.json()) as { ok: boolean; result?: { username?: string } };
    if (!me.ok) throw new AppError('CHANNEL_MISCONFIGURED', 400, 'Invalid Telegram bot token');

    const res = await fetch(this.api(token, 'setWebhook'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: webhookUrl,
        secret_token: account.webhookSecret,
        allowed_updates: ['message'],
      }),
    });
    const json = (await res.json()) as { ok: boolean; description?: string };
    if (!json.ok) {
      logger.warn({ description: json.description }, 'Telegram setWebhook failed');
      return `Connected as @${me.result?.username}, but webhook registration failed: ${json.description}. ` +
        `If your API isn't publicly reachable, expose it (e.g. ngrok) and reconnect.`;
    }
    return `Connected as @${me.result?.username}. Webhook registered.`;
  }
}
