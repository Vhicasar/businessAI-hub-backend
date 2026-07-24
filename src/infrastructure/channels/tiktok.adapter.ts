import { createHmac, timingSafeEqual } from 'crypto';
import type {
  ChannelAccountRef, ChannelAdapter, NormalizedInbound, OutboundPayload,
  SendResult, WebhookRequestLike,
} from '../../application/inbox/channel-adapter';
import { AppError } from '../../shared/errors';

/**
 * TikTok Business connection and signed webhook adapter.
 *
 * TikTok's public developer platform currently exposes account/content APIs
 * and lifecycle webhooks, not a general-purpose Direct Message send API.
 * Consequently this adapter connects and verifies the account but refuses to
 * pretend it can send DMs.
 */
export class TikTokAdapter implements ChannelAdapter {
  readonly channelType = 'TIKTOK' as const;

  verifyWebhook(req: WebhookRequestLike, account: ChannelAccountRef): boolean {
    const signature = req.headers['tiktok-signature'];
    const rawBody = (req as { rawBody?: Buffer }).rawBody;
    if (typeof signature !== 'string' || !rawBody || !account.credentials.clientSecret) return false;
    const parts = Object.fromEntries(signature.split(',').map((part) => part.split('=', 2)));
    const timestamp = parts.t;
    const provided = parts.s;
    if (!timestamp || !provided) return false;
    const expected = createHmac('sha256', account.credentials.clientSecret)
      .update(`${timestamp}.${rawBody.toString('utf8')}`)
      .digest('hex');
    try {
      return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
    } catch {
      return false;
    }
  }

  parseInbound(): NormalizedInbound[] {
    // TikTok lifecycle/content events are retained at the provider boundary;
    // they are not customer conversations and must not pollute the inbox.
    return [];
  }

  async sendMessage(_payload: OutboundPayload, _account: ChannelAccountRef): Promise<SendResult> {
    throw new AppError(
      'CHANNEL_OPERATION_UNSUPPORTED',
      400,
      'TikTok does not provide a public Direct Message send API for this integration.',
    );
  }

  async onAccountConnected(account: ChannelAccountRef, webhookUrl: string): Promise<string> {
    const token = account.credentials.accessToken;
    if (!token || !account.credentials.clientSecret || !account.credentials.openId) {
      throw new AppError('CHANNEL_MISCONFIGURED', 400, 'TikTok access token, open ID and client secret are required');
    }
    const response = await fetch(
      'https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url',
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!response.ok) throw new AppError('CHANNEL_MISCONFIGURED', 400, 'TikTok access token is invalid or expired');
    return `TikTok account verified. Register ${webhookUrl} in TikTok for Developers → Webhooks. Direct-message sending is unavailable in TikTok’s public API; this connection is for account and webhook integration.`;
  }
}
