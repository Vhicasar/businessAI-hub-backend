import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { logger } from '../../shared/logger';
import type { ChannelConnectionStatus } from '@prisma/client';

/**
 * Whether a connected channel is actually working, and why not when it isn't.
 *
 * A channel used to be a boolean. That could not distinguish a business that
 * switched WhatsApp off from one whose Meta token quietly expired three weeks
 * ago — and in the second case nothing told anybody, so messages simply stopped
 * arriving and the inbox looked like a quiet week.
 *
 * The rules here are deliberately narrow. Only two things change a channel's
 * status by themselves: the provider accepting a webhook (proof it works) and
 * the provider rejecting our credentials (proof it does not). Everything else
 * is recorded as an error without tearing the connection down, because a
 * timeout or a rate limit is not the same as being logged out.
 */

/** Errors that mean the credentials are dead and only reconnecting will help. */
const EXPIRED_PATTERNS = [
  /access token/i,
  /session (has )?expired/i,
  /invalid[_ ]oauth/i,
  /token.*(expired|invalid|revoked)/i,
  /oauth.*(expired|invalid)/i,
  /code\s*[:=]\s*190/, // Meta: OAuthException, token problems
];

/** Provider errors that will pass on their own; not the business's problem. */
const TRANSIENT_PATTERNS = [
  /rate limit/i,
  /too many (requests|calls)/i,
  /timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND/i,
  /temporarily unavailable/i,
  /\b(500|502|503|504)\b/,
];

export function classifyProviderError(message: string): ChannelConnectionStatus {
  if (EXPIRED_PATTERNS.some((p) => p.test(message))) return 'EXPIRED';
  if (TRANSIENT_PATTERNS.some((p) => p.test(message))) return 'CONNECTED';
  return 'ERROR';
}

/**
 * What to tell the business.
 *
 * Never the provider's own words: "OAuthException code 190 subcode 463" is not
 * something a shop owner can act on, and §16 asks for a sentence that names the
 * fix.
 */
export function friendlyMessage(
  channelType: string,
  status: ChannelConnectionStatus
): string {
  const name = channelLabel(channelType);
  switch (status) {
    case 'EXPIRED':
      return `${name} connection expired. Reconnect ${name} to continue receiving messages.`;
    case 'ERROR':
      return `${name} is not working right now. Try reconnecting, or contact support if it continues.`;
    case 'DISCONNECTED':
      return `${name} is disconnected.`;
    case 'CONNECTING':
      return `Finishing the ${name} connection…`;
    default:
      return `${name} is connected.`;
  }
}

function channelLabel(channelType: string): string {
  const labels: Record<string, string> = {
    WHATSAPP: 'WhatsApp',
    FACEBOOK_MESSENGER: 'Facebook Messenger',
    INSTAGRAM: 'Instagram',
    TELEGRAM: 'Telegram',
    EMAIL: 'Email',
    SMS: 'SMS',
    WEB_CHAT: 'Web chat',
    TIKTOK: 'TikTok',
  };
  return labels[channelType] ?? channelType;
}

/**
 * Record that the provider delivered something.
 *
 * Proof the connection works, so it also clears a previous error — a channel
 * that is receiving again should not keep showing last week's failure. Written
 * unscoped because webhooks arrive outside any tenant's request.
 */
export async function markWebhookReceived(accountId: string): Promise<void> {
  try {
    await prismaUnscoped.channelAccount.update({
      where: { id: accountId },
      data: {
        lastWebhookAt: new Date(),
        status: 'CONNECTED',
        lastError: null,
        lastErrorAt: null,
      },
    });
  } catch (err) {
    // Health bookkeeping must never cost us the message that prompted it.
    logger.warn({ err, accountId }, 'Could not stamp channel health');
  }
}

/**
 * Record that something went wrong with this channel.
 *
 * Returns the status it settled on, so a caller can decide whether to keep
 * trying. A transient failure is logged against the channel but leaves it
 * CONNECTED, because rate limits pass and expired tokens do not.
 */
export async function markChannelError(
  accountId: string,
  channelType: string,
  rawMessage: string
): Promise<ChannelConnectionStatus> {
  const status = classifyProviderError(rawMessage);
  try {
    await prismaUnscoped.channelAccount.update({
      where: { id: accountId },
      data: {
        status,
        lastError: friendlyMessage(channelType, status),
        lastErrorAt: new Date(),
      },
    });
  } catch (err) {
    logger.warn({ err, accountId }, 'Could not record channel error');
  }
  // The provider's own words go to the log, never to the customer-facing field.
  logger.warn({ accountId, channelType, status, rawMessage }, 'Channel error recorded');
  return status;
}

/** Mark a channel healthy again — used after a successful reconnect. */
export async function markChannelConnected(accountId: string): Promise<void> {
  await prismaUnscoped.channelAccount
    .update({
      where: { id: accountId },
      data: { status: 'CONNECTED', lastError: null, lastErrorAt: null, isActive: true },
    })
    .catch((err) => logger.warn({ err, accountId }, 'Could not mark channel connected'));
}
