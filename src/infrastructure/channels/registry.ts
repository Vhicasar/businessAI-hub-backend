import type { ChannelType } from '@prisma/client';
import type { ChannelAdapter } from '../../application/inbox/channel-adapter';
import { NotFoundError } from '../../shared/errors';
import { TelegramAdapter } from './telegram.adapter';
import { WhatsAppAdapter } from './whatsapp.adapter';
import { MetaMessagingAdapter } from './meta.adapter';
import { WebChatAdapter } from './webchat.adapter';
import { EmailAdapter } from './email.adapter';
import { SmsAdapter } from './sms.adapter';
import { TikTokAdapter } from './tiktok.adapter';

const adapters = new Map<ChannelType, ChannelAdapter>();

function register(adapter: ChannelAdapter): void {
  adapters.set(adapter.channelType, adapter);
}

register(new TelegramAdapter());
register(new WhatsAppAdapter());
register(new MetaMessagingAdapter('FACEBOOK_MESSENGER', 'page'));
register(new MetaMessagingAdapter('INSTAGRAM', 'instagram'));
register(new WebChatAdapter());
register(new EmailAdapter());
register(new SmsAdapter());
register(new TikTokAdapter());

export function getAdapter(channelType: ChannelType): ChannelAdapter {
  const adapter = adapters.get(channelType);
  if (!adapter) throw new NotFoundError(`Adapter for channel ${channelType}`);
  return adapter;
}

export function supportedChannels(): ChannelType[] {
  return [...adapters.keys()];
}
