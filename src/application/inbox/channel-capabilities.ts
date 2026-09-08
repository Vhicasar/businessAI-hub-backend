import type { ChannelType } from '@prisma/client';

/**
 * What each channel can actually do.
 *
 * WhatsApp, Instagram and Messenger are not the same product with different
 * logos. WhatsApp refuses free-form text outside a 24-hour window and needs an
 * approved template instead; Instagram has no templates at all; email has no
 * read receipts and no concept of typing. A UI that offered every control on
 * every channel would be offering buttons that fail at send time, which is
 * worse than not offering them.
 *
 * Declared per channel rather than probed from the provider: these are
 * platform rules, not account settings, and an inbox has to know before it
 * renders whether to show a template picker.
 */
export interface ChannelCapabilities {
  text: boolean;
  image: boolean;
  video: boolean;
  audio: boolean;
  document: boolean;
  location: boolean;
  reactions: boolean;
  /** Pre-approved message bodies, required to reopen a closed window. */
  templates: boolean;
  readReceipts: boolean;
  typingIndicator: boolean;
  buttons: boolean;
  quickReplies: boolean;
  /**
   * Hours after the customer's last message during which a free-form reply is
   * allowed. Null means no such limit. Meta calls this the customer service
   * window, and sending outside it fails rather than queues — so the composer
   * has to say so before an agent types a reply that cannot be delivered.
   */
  replyWindowHours: number | null;
  /** Whether outbound sending is possible at all on this channel. */
  outbound: boolean;
}

const NONE: ChannelCapabilities = {
  text: false, image: false, video: false, audio: false, document: false,
  location: false, reactions: false, templates: false, readReceipts: false,
  typingIndicator: false, buttons: false, quickReplies: false,
  replyWindowHours: null, outbound: false,
};

const CAPABILITIES: Record<ChannelType, ChannelCapabilities> = {
  WHATSAPP: {
    ...NONE,
    text: true, image: true, video: true, audio: true, document: true,
    location: true, reactions: true, templates: true, readReceipts: true,
    buttons: true, quickReplies: true, outbound: true,
    // Meta's customer service window. Outside it only a template will send.
    replyWindowHours: 24,
  },
  FACEBOOK_MESSENGER: {
    ...NONE,
    text: true, image: true, video: true, audio: true, document: true,
    reactions: true, readReceipts: true, typingIndicator: true,
    buttons: true, quickReplies: true, outbound: true,
    replyWindowHours: 24,
  },
  INSTAGRAM: {
    ...NONE,
    text: true, image: true, video: true, audio: true,
    reactions: true, readReceipts: true, typingIndicator: true,
    quickReplies: true, outbound: true,
    // No documents and no templates on Instagram messaging.
    replyWindowHours: 24,
  },
  TELEGRAM: {
    ...NONE,
    text: true, image: true, video: true, audio: true, document: true,
    location: true, reactions: true, typingIndicator: true,
    buttons: true, quickReplies: true, outbound: true,
  },
  EMAIL: { ...NONE, text: true, image: true, document: true, outbound: true },
  SMS: { ...NONE, text: true, outbound: true },
  WEB_CHAT: {
    ...NONE,
    text: true, image: true, document: true, readReceipts: true,
    typingIndicator: true, quickReplies: true, outbound: true,
  },
  // Read-only or not yet carrying messages: listed explicitly so a new channel
  // type cannot be added without deciding what it can do.
  TIKTOK: { ...NONE, text: true },
  VOICE: NONE,
  VIDEO: NONE,
  LINKEDIN: NONE,
  DISCORD: NONE,
  SLACK: NONE,
  X: NONE,
};

export function capabilitiesFor(channelType: ChannelType): ChannelCapabilities {
  return CAPABILITIES[channelType] ?? NONE;
}

/** The content types a channel accepts, for validating an outbound message. */
export function supportsContentType(
  channelType: ChannelType,
  contentType: string
): boolean {
  const caps = capabilitiesFor(channelType);
  switch (contentType) {
    case 'TEXT': return caps.text;
    case 'IMAGE': return caps.image;
    case 'VIDEO': return caps.video;
    case 'AUDIO': return caps.audio;
    case 'DOCUMENT': return caps.document;
    case 'LOCATION': return caps.location;
    case 'TEMPLATE': return caps.templates;
    // A system note is written by Vhicasar, never delivered to the customer.
    case 'SYSTEM': return true;
    default: return false;
  }
}

/**
 * Whether a free-form reply can still be delivered, given when the customer
 * last wrote in. Channels with no window always allow it.
 */
export function withinReplyWindow(
  channelType: ChannelType,
  lastInboundAt: Date | null,
  now: Date = new Date()
): boolean {
  const { replyWindowHours } = capabilitiesFor(channelType);
  if (replyWindowHours === null) return true;
  if (!lastInboundAt) return false;
  return now.getTime() - lastInboundAt.getTime() < replyWindowHours * 3_600_000;
}
