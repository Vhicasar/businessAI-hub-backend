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
  /** Original thread subject for subject-based channels such as email. */
  subject?: string;
  /** Direct media URL when the provider exposes one. */
  mediaUrl?: string;
  /**
   * The attachment, described well enough to go and fetch it.
   *
   * Richer than `mediaUrl` because providers do not agree on what a media
   * reference is: Meta hands over a CDN link that expires, WhatsApp hands over
   * an id that has to be exchanged for one using the account's own token. The
   * adapter says which it has; `downloadMedia` knows how to turn either into
   * bytes.
   */
  media?: InboundMedia;
  sentAt?: Date;
  raw?: unknown;
}

/** A provider's reference to a file attached to an inbound message. */
export interface InboundMedia {
  /** Provider-side id, when the file must be fetched by id (WhatsApp). */
  externalId?: string;
  /** Direct link, when the provider gives one (Messenger, Instagram). */
  url?: string;
  mimeType?: string;
  filename?: string;
}

/** Bytes plus what they are, ready for Vhicasar's own file storage. */
export interface DownloadedMedia {
  buffer: Buffer;
  mimeType: string;
  filename: string;
}

export interface OutboundPayload {
  /** Conversation partner's provider-side id. */
  recipientExternalId: string;
  text: string;
  subject?: string;
  isMarketing?: boolean;
  templateName?: string;
  templateLanguage?: string;
  /** Public image URLs to deliver natively when the channel supports media. */
  mediaUrls?: string[];
  /**
   * Files an agent attached, already fetched from Vhicasar's own storage.
   *
   * Carried as bytes rather than a URL because Vhicasar's storage is not
   * necessarily public — a signed URL that expires, or a private bucket, is
   * something Meta cannot fetch. Uploading the bytes to the provider's media
   * endpoint works either way, and is the only route that supports documents,
   * video and audio rather than images alone.
   */
  attachments?: OutboundAttachment[];
}

export interface OutboundAttachment {
  buffer: Buffer;
  mimeType: string;
  filename: string;
}

/**
 * Which of a provider's media kinds a file belongs to.
 *
 * Meta refuses a PDF sent as `type: image`, so guessing wrong is a failed
 * send rather than a degraded one.
 */
export function mediaKindFor(mimeType: string): 'image' | 'video' | 'audio' | 'document' {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'document';
}

export interface SendResult {
  providerMessageId: string;
}

/**
 * A delivery receipt for a message we sent earlier.
 *
 * Separate from NormalizedInbound because it is not a message: it carries no
 * body and creates no conversation, it only moves an existing message along.
 * Providers deliver both down the same webhook, so adapters return them
 * separately rather than the inbox core having to tell them apart.
 */
export interface NormalizedStatus {
  /** The provider id of the message being reported on. */
  providerMessageId: string;
  status: 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';
  occurredAt?: Date;
  /** Why it failed, when the provider says. */
  error?: string;
}

export interface WebhookRequestLike {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  query: Record<string, unknown>;
  rawBody?: Buffer;
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

  /**
   * Extract delivery receipts from the same webhook delivery.
   *
   * Optional: a channel with no receipts (email, SMS without callbacks) simply
   * does not implement it, and its messages stay at SENT — which is the honest
   * answer rather than a DELIVERED nobody confirmed.
   */
  parseStatuses?(body: unknown): NormalizedStatus[];

  /**
   * Fetch an inbound attachment's bytes.
   *
   * Optional: a channel with no media does not implement it. Returning null
   * means "could not fetch" — the message is still saved, because a photo we
   * failed to download is no reason to lose the customer's message.
   */
  downloadMedia?(media: InboundMedia, account: ChannelAccountRef): Promise<DownloadedMedia | null>;

  /** Deliver an agent/bot reply to the customer. */
  sendMessage(payload: OutboundPayload, account: ChannelAccountRef): Promise<SendResult>;

  /**
   * Provider-side setup when a tenant connects an account
   * (e.g. Telegram setWebhook). Returns setup notes for the UI.
   */
  onAccountConnected?(account: ChannelAccountRef, webhookUrl: string): Promise<string | null>;
}
