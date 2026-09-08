import { randomUUID } from 'crypto';
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
import type { ChannelType } from '@prisma/client';
import { logger } from '../../shared/logger';

/**
 * A messaging provider that isn't one.
 *
 * The real channels cannot be exercised until Meta has approved a business,
 * a phone number and a set of templates — which is weeks of someone else's
 * process. This adapter stands in for them so the inbox, the CRM matching,
 * the automations and the socket layer can be built and tested before any of
 * that lands.
 *
 * It is wired to whichever ChannelType it is constructed with, so a simulated
 * WhatsApp message travels exactly the same path as a real one: same webhook
 * receiver, same normalisation, same conversation and customer resolution.
 * Nothing downstream can tell the difference, which is the point — a mock that
 * took a shortcut would prove nothing about the real thing.
 *
 * Deliberately not registered in the production registry. It is reachable only
 * through the simulation endpoints, which are themselves only mounted outside
 * production (see mock-messaging.routes.ts).
 */
export class MockMessagingAdapter implements ChannelAdapter {
  constructor(readonly channelType: ChannelType) {}

  /**
   * Always true.
   *
   * The simulation endpoint is already authenticated and permission-checked as
   * the signed-in business, so there is no third party here to spoof. Real
   * adapters verify a provider signature precisely because the caller is a
   * stranger; this caller is the tenant themselves.
   */
  verifyWebhook(_req: WebhookRequestLike, _account: ChannelAccountRef): boolean {
    return true;
  }

  parseInbound(body: unknown): NormalizedInbound[] {
    const payload = body as { messages?: NormalizedInbound[] };
    return payload.messages ?? [];
  }

  parseStatuses(body: unknown): NormalizedStatus[] {
    const payload = body as { statuses?: NormalizedStatus[] };
    return payload.statuses ?? [];
  }

  /** A tiny PNG, so a simulated photo is a real file rather than a promise. */
  async downloadMedia(media: InboundMedia): Promise<DownloadedMedia | null> {
    if (!media.externalId && !media.url) return null;
    return {
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      ),
      mimeType: media.mimeType ?? 'image/png',
      filename: media.filename ?? 'simulated-attachment.png',
    };
  }

  /**
   * Accepts anything and records it.
   *
   * Returns a provider id shaped like a real one so the delivery-receipt path
   * can be simulated against it afterwards.
   */
  async sendMessage(payload: OutboundPayload, account: ChannelAccountRef): Promise<SendResult> {
    const providerMessageId = `mock.${randomUUID()}`;
    logger.info(
      {
        channelType: this.channelType,
        accountId: account.id,
        to: payload.recipientExternalId,
        providerMessageId,
        text: payload.text.slice(0, 200),
        mediaUrls: payload.mediaUrls?.length ?? 0,
      },
      'Mock provider accepted an outbound message',
    );
    return { providerMessageId };
  }

  async onAccountConnected(): Promise<string | null> {
    return 'Simulated channel connected. Use the simulation endpoints to send test messages.';
  }
}
