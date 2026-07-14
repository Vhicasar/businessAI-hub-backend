import { randomUUID } from 'crypto';
import type {
  ChannelAdapter,
  OutboundPayload,
  SendResult,
  WebhookRequestLike,
} from '../../application/inbox/channel-adapter';

/**
 * First-party website live chat. There is no external provider:
 * - inbound arrives via the public visitor API (webchat.routes.ts), not webhooks
 * - outbound is just persisted; visitors receive it by polling the same API
 */
export class WebChatAdapter implements ChannelAdapter {
  readonly channelType = 'WEB_CHAT' as const;

  verifyWebhook(_req: WebhookRequestLike): boolean {
    return false; // no webhook path for web chat
  }

  parseInbound(): never[] {
    return [];
  }

  async sendMessage(_payload: OutboundPayload): Promise<SendResult> {
    return { providerMessageId: `wc_${randomUUID()}` };
  }
}
