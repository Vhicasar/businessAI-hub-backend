import { describe, expect, it } from 'vitest';
import type { ChannelType } from '@prisma/client';
import { formatOutboundTextForChannel } from '../../src/application/inbox/outbound-text-format';

const paymentMessage = [
  'Your invoice INV-2026-00013 is ready.',
  '[**View invoice**](https://app.example.com/pay/secure-token/invoice)',
  '[**Pay now**](https://app.example.com/pay/secure-token)',
].join('\n');

describe('outbound provider text formatting', () => {
  it('preserves rich links for website chat', () => {
    expect(formatOutboundTextForChannel(paymentMessage, 'WEB_CHAT')).toBe(paymentMessage);
  });

  it.each<ChannelType>([
    'WHATSAPP',
    'FACEBOOK_MESSENGER',
    'INSTAGRAM',
    'TELEGRAM',
    'TIKTOK',
    'EMAIL',
    'SMS',
    'VOICE',
    'VIDEO',
    'LINKEDIN',
    'DISCORD',
    'SLACK',
    'X',
  ])('sends labelled raw URLs to %s', (channelType) => {
    const result = formatOutboundTextForChannel(paymentMessage, channelType);
    expect(result).toContain('View invoice: https://app.example.com/pay/secure-token/invoice');
    expect(result).toContain('Pay now: https://app.example.com/pay/secure-token');
    expect(result).not.toContain('[**');
  });

  it('does not transform non-http links', () => {
    const unsafe = '[Run this](javascript:alert(1))';
    expect(formatOutboundTextForChannel(unsafe, 'WHATSAPP')).toBe(unsafe);
  });
});
