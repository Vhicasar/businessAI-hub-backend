import type {
  ChannelAccountRef, ChannelAdapter, DownloadedMedia, InboundMedia, NormalizedInbound, OutboundPayload,
  SendResult, WebhookRequestLike,
} from '../../application/inbox/channel-adapter';
import { mediaDownloadFailure, normalizedMimeType } from '../../application/inbox/channel-adapter';
import { AppError } from '../../shared/errors';

type TwilioInbound = {
  MessageSid?: string;
  SmsMessageSid?: string;
  From?: string;
  Body?: string;
  NumMedia?: string;
  [key: `MediaUrl${number}`]: string | undefined;
  [key: `MediaContentType${number}`]: string | undefined;
};

/** Twilio Programmable SMS adapter. */
export class SmsAdapter implements ChannelAdapter {
  readonly channelType = 'SMS' as const;

  verifyWebhook(req: WebhookRequestLike, account: ChannelAccountRef): boolean {
    return Boolean(account.webhookSecret && req.query.token === account.webhookSecret);
  }

  parseInbound(body: unknown): NormalizedInbound[] {
    const message = body as TwilioInbound;
    const id = message.MessageSid ?? message.SmsMessageSid;
    if (!id || !message.From) return [];
    const mediaCount = Math.min(Number(message.NumMedia ?? 0), 10);
    const attachments = Array.from({ length: mediaCount }, (_, index) => ({
      type: (message[`MediaContentType${index}`]?.startsWith('video/') ? 'video' : message[`MediaContentType${index}`]?.startsWith('audio/') ? 'audio' : message[`MediaContentType${index}`]?.startsWith('image/') ? 'image' : 'document') as 'image' | 'video' | 'audio' | 'document',
      url: message[`MediaUrl${index}`], mimeType: message[`MediaContentType${index}`],
    }));
    return [{
      providerMessageId: id,
      senderExternalId: message.From,
      senderProfile: { phone: message.From },
      contentType: Number(message.NumMedia ?? 0) > 0 ? 'IMAGE' : 'TEXT',
      messageType: mediaCount ? (message.Body?.trim() ? 'mixed' : 'image') : (/https?:\/\//i.test(message.Body ?? '') ? 'link' : 'text'),
      attachments,
      media: attachments[0]?.url ? { url: attachments[0].url, mimeType: attachments[0].mimeType } : undefined,
      referencedContent: (message.Body?.match(/https?:\/\/[^\s]+/g) ?? []).map((url) => ({ provider: 'sms', type: 'link', productUrl: url, permalink: url })),
      text: message.Body,
      raw: body,
    }];
  }

  async downloadMedia(media: InboundMedia, account: ChannelAccountRef): Promise<DownloadedMedia | null> {
    if (!media.url || !account.credentials.accountSid || !account.credentials.authToken) return null;
    const response = await fetch(media.url, {
      headers: { Authorization: `Basic ${Buffer.from(`${account.credentials.accountSid}:${account.credentials.authToken}`).toString('base64')}` },
    });
    const mimeType = normalizedMimeType(response.headers.get('content-type'), media.mimeType);
    if (!response.ok) return { buffer: Buffer.alloc(0), mimeType, filename: 'failed-download', failureReason: mediaDownloadFailure(response.status) };
    if (mimeType === 'text/html' || mimeType === 'application/xhtml+xml') {
      return { buffer: Buffer.alloc(0), mimeType, filename: 'unexpected-html', failureReason: 'unexpected_html_response' };
    }
    const extension = mimeType.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'bin';
    return { buffer: Buffer.from(await response.arrayBuffer()), mimeType, filename: `mms-${Date.now()}.${extension}` };
  }

  async sendMessage(payload: OutboundPayload, account: ChannelAccountRef): Promise<SendResult> {
    const { accountSid, authToken, fromNumber, messagingServiceSid } = account.credentials;
    if (!accountSid || !authToken || (!fromNumber && !messagingServiceSid)) {
      throw new AppError('CHANNEL_MISCONFIGURED', 500, 'Twilio SMS credentials are incomplete');
    }
    const params = new URLSearchParams({ To: payload.recipientExternalId, Body: payload.text });
    if (payload.mediaUrls?.[0]) params.set('MediaUrl', payload.mediaUrls[0]);
    if (messagingServiceSid) params.set('MessagingServiceSid', messagingServiceSid);
    else params.set('From', fromNumber!);
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params,
      },
    );
    const json = await response.json() as { sid?: string; message?: string };
    if (!response.ok || !json.sid) {
      throw new AppError('CHANNEL_SEND_FAILED', 502, `SMS send failed: ${json.message ?? response.status}`);
    }
    return { providerMessageId: json.sid };
  }

  async onAccountConnected(account: ChannelAccountRef, webhookUrl: string): Promise<string> {
    const { accountSid, authToken } = account.credentials;
    if (!accountSid || !authToken) {
      throw new AppError('CHANNEL_MISCONFIGURED', 400, 'Twilio Account SID and Auth Token are required');
    }
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}.json`,
      { headers: { Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}` } },
    );
    if (!response.ok) throw new AppError('CHANNEL_MISCONFIGURED', 400, 'Twilio credentials are invalid');
    return `Credentials verified. In Twilio Console, set “A message comes in” to ${webhookUrl}?token=${account.webhookSecret} using HTTP POST.`;
  }
}
