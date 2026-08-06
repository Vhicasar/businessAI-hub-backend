import type {
  ChannelAccountRef, ChannelAdapter, NormalizedInbound, OutboundPayload,
  SendResult, WebhookRequestLike,
} from '../../application/inbox/channel-adapter';
import { AppError } from '../../shared/errors';

type TwilioInbound = {
  MessageSid?: string;
  SmsMessageSid?: string;
  From?: string;
  Body?: string;
  NumMedia?: string;
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
    return [{
      providerMessageId: id,
      senderExternalId: message.From,
      contentType: Number(message.NumMedia ?? 0) > 0 ? 'IMAGE' : 'TEXT',
      text: message.Body,
      raw: body,
    }];
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
