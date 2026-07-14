import type { ChannelType, MessageContentType } from '@prisma/client';

/** Provider-agnostic representation of an incoming message. */
export interface NormalizedInbound {
  /** Stable provider-side message id (dedupe key). */
  providerMessageId: string;
  /** Provider-side sender identity (phone, chat id, page-scoped id…). */
  senderExternalId: string;
  senderDisplayName?: string;
  contentType: MessageContentType;
  text?: string;
  /** Direct media URL when the provider exposes one. */
  mediaUrl?: string;
  sentAt?: Date;
  raw?: unknown;
}

export interface OutboundPayload {
  /** Conversation partner's provider-side id. */
  recipientExternalId: string;
  text: string;
}

export interface SendResult {
  providerMessageId: string;
}

export interface WebhookRequestLike {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  query: Record<string, unknown>;
}

export interface ChannelAccountRef {
  id: string;
  organizationId: string;
  externalId: string;
  credentials: Record<string, string>;
  webhookSecret: string | null;
}

/**
 * One adapter per provider. The inbox core never sees provider payloads;
 * adapters translate both directions and own webhook verification.
 */
export interface ChannelAdapter {
  readonly channelType: ChannelType;

  /** Reject spoofed webhooks (signature/secret check). */
  verifyWebhook(req: WebhookRequestLike, account: ChannelAccountRef): boolean;

  /** Extract zero..n messages from one webhook delivery. */
  parseInbound(body: unknown): NormalizedInbound[];

  /** Deliver an agent/bot reply to the customer. */
  sendMessage(payload: OutboundPayload, account: ChannelAccountRef): Promise<SendResult>;

  /**
   * Provider-side setup when a tenant connects an account
   * (e.g. Telegram setWebhook). Returns setup notes for the UI.
   */
  onAccountConnected?(account: ChannelAccountRef, webhookUrl: string): Promise<string | null>;
}
