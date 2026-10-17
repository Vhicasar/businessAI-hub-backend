import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { logger } from '../../shared/logger';
import { notifyService } from '../notifications/notify.service';
import { permissionsForRole } from '../roles/role-permissions';
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
  status: ChannelConnectionStatus,
  /**
   * The provider's raw words, used only to pick a more specific sentence.
   *
   * Never returned verbatim. "3 NO [AUTHENTICATIONFAILED] Invalid credentials
   * (Failure)" is precise and useless to the person who has to fix it.
   */
  rawMessage?: string,
): string {
  const name = channelLabel(channelType);

  /*
   * Mail is worth a sentence of its own.
   *
   * A rejected IMAP login is almost always one of three things, and "Email is
   * not working right now" sends the business looking for an outage instead of
   * at the mailbox settings they changed last week. Gmail and Outlook in
   * particular refuse an ordinary account password outright once two-step
   * verification is on, which is the single most common cause.
   */
  if (channelType === 'EMAIL' && rawMessage && /auth|credential|login|password/i.test(rawMessage)) {
    return (
      'Email sign-in was refused by the mail server. Check the mailbox username and password in ' +
      'Settings → Integrations → Channels. If this mailbox uses Gmail, Outlook or two-step ' +
      'verification, it needs an app password rather than the account password.'
    );
  }

  switch (status) {
    case 'EXPIRED':
      return `${name} connection expired. Reconnect ${name} to continue receiving messages.`;
    case 'ERROR':
      return `${name} is not working right now. Try reconnecting, or contact support if it continues.`;
    case 'SETUP_REQUIRED':
      return `${name} credentials are valid, but the provider webhook still needs to be configured and verified.`;
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
        isActive: true,
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
 * Tell the people who can fix it.
 *
 * A broken channel is invisible by design: no messages arrive, and an empty
 * inbox looks like a quiet day. The settings page shows the reason, but only
 * to someone who thinks to go and look — so whoever is allowed to manage
 * channels gets a notification the moment the status turns, and only then.
 */
async function announceChannelBroken(
  organizationId: string,
  accountName: string,
  channelType: string,
  message: string,
): Promise<void> {
  try {
    const memberships = await prismaUnscoped.membership.findMany({
      where: { organizationId, isActive: true, deletedAt: null },
      select: { userId: true, roleId: true },
    });
    const cache = new Map<string, Set<string>>();
    const recipients: string[] = [];
    for (const membership of memberships) {
      if (!membership.roleId) continue;
      let granted = cache.get(membership.roleId);
      if (!granted) {
        granted = await permissionsForRole(membership.roleId);
        cache.set(membership.roleId, granted);
      }
      if (granted.has('inbox.manage_channels')) recipients.push(membership.userId);
    }
    if (recipients.length === 0) return;
    await notifyService.notifyUsers(organizationId, recipients, {
      type: 'channel.disconnected',
      title: `${channelLabel(channelType)} needs attention`,
      body: message,
      data: { channelType, accountName },
    });
  } catch (err) {
    // Never let the announcement cost us the status we just recorded.
    logger.warn({ err, organizationId, channelType }, 'Could not announce channel failure');
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
  const message = friendlyMessage(channelType, status, rawMessage);
  try {
    // Read first, so a channel that is newly broken can be announced once
    // rather than on every retry.
    const before = await prismaUnscoped.channelAccount.findUnique({
      where: { id: accountId },
      select: { status: true, organizationId: true, name: true },
    });
    await prismaUnscoped.channelAccount.update({
      where: { id: accountId },
      data: {
        status,
        lastError: message,
        lastErrorAt: new Date(),
      },
    });
    if (before && before.status !== status && status !== 'CONNECTED') {
      await announceChannelBroken(before.organizationId, before.name, channelType, message);
    }
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

/** Record a real inbound customer message separately from status-only webhooks. */
export async function markInboundMessageReceived(accountId: string): Promise<void> {
  const account = await prismaUnscoped.channelAccount.findUnique({
    where: { id: accountId }, select: { metadata: true },
  });
  const metadata = account?.metadata && typeof account.metadata === 'object' && !Array.isArray(account.metadata)
    ? account.metadata as Record<string, unknown> : {};
  await prismaUnscoped.channelAccount.update({
    where: { id: accountId },
    data: { metadata: { ...metadata, lastInboundMessageAt: new Date().toISOString() } },
  }).catch((err) => logger.warn({ err, accountId }, 'Could not stamp inbound channel message health'));
}

export async function markOutboundMessageSent(accountId: string): Promise<void> {
  const account = await prismaUnscoped.channelAccount.findUnique({
    where: { id: accountId }, select: { metadata: true },
  });
  const metadata = account?.metadata && typeof account.metadata === 'object' && !Array.isArray(account.metadata)
    ? account.metadata as Record<string, unknown> : {};
  await prismaUnscoped.channelAccount.update({
    where: { id: accountId },
    data: { metadata: { ...metadata, lastOutboundMessageAt: new Date().toISOString() } },
  }).catch((err) => logger.warn({ err, accountId }, 'Could not stamp outbound channel message health'));
}

/** Mandatory connection setup failed: never leave the row active or billable. */
export async function markChannelSetupFailed(
  accountId: string,
  channelType: string,
  rawMessage: string,
): Promise<void> {
  await prismaUnscoped.channelAccount.update({
    where: { id: accountId },
    data: {
      isActive: false,
      status: 'ERROR',
      lastError: friendlyMessage(channelType, 'ERROR', rawMessage),
      lastErrorAt: new Date(),
    },
  }).catch((err) => logger.warn({ err, accountId }, 'Could not record channel setup failure'));
  logger.warn({ accountId, channelType, phase: 'setup_failed', rawMessage }, 'Channel setup failed');
}

/** Store subscription readiness without storing provider responses or secrets. */
export async function markWebhookSubscription(
  accountId: string,
  state: 'READY' | 'FAILED',
): Promise<void> {
  const account = await prismaUnscoped.channelAccount.findUnique({
    where: { id: accountId }, select: { metadata: true },
  });
  const metadata = (account?.metadata && typeof account.metadata === 'object' && !Array.isArray(account.metadata))
    ? account.metadata as Record<string, unknown> : {};
  await prismaUnscoped.channelAccount.update({
    where: { id: accountId },
    data: { metadata: {
      ...metadata,
      webhookSubscriptionStatus: state,
      webhookSubscriptionCheckedAt: new Date().toISOString(),
    } },
  }).catch((err) => logger.warn({ err, accountId }, 'Could not record webhook subscription readiness'));
}
