import type { ChannelType } from '@prisma/client';

/**
 * Website chat renders the small, controlled Markdown subset used by the AI.
 * Provider adapters otherwise send plain text, so turn Markdown links into
 * labelled absolute URLs. Raw URLs are reliably linkified by WhatsApp,
 * Instagram, Messenger, Telegram, SMS clients, and mail clients without
 * enabling provider-specific Markdown modes for arbitrary customer content.
 */
export function formatOutboundTextForChannel(text: string, channelType: ChannelType): string {
  if (channelType === 'WEB_CHAT') return text;

  return text.replace(
    /\[([^\]\n]+)]\((https?:\/\/[^\s)]+)\)/gi,
    (_match, rawLabel: string, url: string) => {
      const label = rawLabel
        .replace(/\*\*/g, '')
        .replace(/__/g, '')
        .replace(/[`*_]/g, '')
        .trim();
      return label ? `${label}: ${url}` : url;
    },
  );
}
