import { randomUUID } from 'crypto';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { prismaUnscoped } from '../database/prisma';
import { requestContext } from '../../shared/context';
import { decrypt } from '../../shared/crypto';
import { logger } from '../../shared/logger';
import { inboxService } from '../../application/inbox/inbox.service';

const POLL_INTERVAL_MS = 60_000;
let timer: NodeJS.Timeout | null = null;
let running = false;

interface EmailCreds {
  imapHost?: string;
  imapPort?: string;
  imapUser?: string;
  imapPass?: string;
}

/**
 * Is this an automated / bulk / promotional email we must NOT treat as a
 * customer conversation (and never auto-reply to)? Detected from the standard
 * headers senders set on newsletters, notifications and system mail, plus common
 * no-reply sender patterns. Skipping these is what stops the assistant from
 * replying to marketing blasts and system notices.
 */
function isAutomatedEmail(parsed: Awaited<ReturnType<typeof simpleParser>>, from: string): boolean {
  const h = parsed.headers;
  const get = (k: string) => {
    const v = h.get(k);
    return typeof v === 'string' ? v.toLowerCase() : Array.isArray(v) ? String(v[0]).toLowerCase() : '';
  };
  const precedence = get('precedence');
  if (['bulk', 'list', 'junk', 'auto_reply'].includes(precedence)) return true;
  if (h.has('list-unsubscribe') || h.has('list-id')) return true; // mailing lists / marketing
  const autoSubmitted = get('auto-submitted');
  if (autoSubmitted && autoSubmitted !== 'no') return true; // auto-generated / auto-replied
  if (get('x-auto-response-suppress') || get('feedback-id')) return true;
  // Unambiguous non-personal senders only (keep this narrow so real customer
  // mail is never dropped — that's what broke the inbox before).
  if (/(^|[._+-])(no.?reply|do.?not.?reply|donotreply|mailer-daemon|postmaster|bounces?)@/.test(from)) {
    return true;
  }
  return false;
}

async function pollAccount(account: {
  id: string;
  organizationId: string;
  credentialsEnc: string | null;
  createdAt: Date;
  metadata: unknown;
}): Promise<void> {
  if (!account.credentialsEnc) return;
  const creds = JSON.parse(decrypt(account.credentialsEnc)) as EmailCreds;
  if (!creds.imapHost || !creds.imapUser) return;

  const meta = (account.metadata as Record<string, unknown> | null) ?? {};
  // Only ever handle mail that arrived AFTER the channel was configured. The
  // watermark is a simple date: an account we've never polled baselines it now
  // (recently-configured accounts use their createdAt so mail sent right after
  // setup still comes in; long-existing accounts baseline to "now" so their
  // inbox history is never replayed / auto-replied).
  let watermark = typeof meta.syncSince === 'string' ? new Date(meta.syncSince) : null;
  if (!watermark || Number.isNaN(watermark.getTime())) {
    // Freshly-configured accounts start from setup time; long-existing accounts
    // start from ~10 min ago (so mail sent while testing still arrives) without
    // replaying deep inbox history.
    const freshlyConfigured = Date.now() - account.createdAt.getTime() < 60 * 60 * 1000;
    watermark = freshlyConfigured ? account.createdAt : new Date(Date.now() - 10 * 60 * 1000);
    await saveSyncSince(account.id, meta, watermark);
    logger.info({ accountId: account.id, watermark }, 'Email poller baselined — only mail from here on is processed');
    // Fall through and process this same cycle using the just-set watermark.
  }

  const client = new ImapFlow({
    host: creds.imapHost,
    port: Number(creds.imapPort ?? 993),
    secure: true,
    auth: { user: creds.imapUser, pass: creds.imapPass ?? '' },
    logger: false,
  });

  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      // Same proven pattern as before (search unseen + download by UID), just
      // bounded to mail received on/after the watermark day (server-side SINCE).
      const found = await client.search({ seen: false, since: watermark });
      const uids = Array.isArray(found) ? found : [];
      if (uids.length === 0) return;

      // Newest first, capped, so a backlog is drained over a few cycles.
      for (const uid of uids.slice(-30).reverse()) {
        const raw = await client.download(String(uid), undefined, { uid: true });
        if (!raw?.content) continue;
        const parsed = await simpleParser(raw.content);

        const fromAddress = parsed.from?.value?.[0]?.address?.toLowerCase();
        // Our own mail, or automated/bulk → mark read and skip (never auto-reply).
        if (!fromAddress || fromAddress === creds.imapUser.toLowerCase() || isAutomatedEmail(parsed, fromAddress)) {
          await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }).catch(() => undefined);
          continue;
        }
        // Precise pre-watermark guard (SINCE is day-granular). Leave it unread —
        // don't touch mail that predates configuration.
        if (parsed.date && parsed.date < watermark) continue;

        const subject = parsed.subject?.trim();
        const bodyText = (parsed.text ?? '').trim().slice(0, 4000);
        const text = subject ? `${subject}\n\n${bodyText}` : bodyText || '[empty email]';

        await requestContext.run(
          { requestId: randomUUID(), organizationId: account.organizationId },
          () =>
            inboxService.processInbound(
              { id: account.id, organizationId: account.organizationId, channelType: 'EMAIL' },
              {
                providerMessageId: parsed.messageId ?? `mail_${uid}_${account.id}`,
                senderExternalId: fromAddress,
                senderDisplayName: parsed.from?.value?.[0]?.name || fromAddress,
                contentType: 'TEXT',
                text,
                sentAt: parsed.date ?? undefined,
              }
            )
        );
        await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }).catch(() => undefined);
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
}

/** Persist the date watermark on the channel account (best-effort). */
async function saveSyncSince(accountId: string, meta: Record<string, unknown>, date: Date): Promise<void> {
  await prismaUnscoped.channelAccount
    .update({ where: { id: accountId }, data: { metadata: { ...meta, syncSince: date.toISOString() } } })
    .catch((e) => logger.warn({ err: e, accountId }, 'Failed to persist email sync watermark'));
}

async function pollAll(): Promise<void> {
  if (running) return; // skip overlapping cycles
  running = true;
  try {
    const accounts = await prismaUnscoped.channelAccount.findMany({
      where: { channelType: 'EMAIL', isActive: true, deletedAt: null },
      select: { id: true, organizationId: true, credentialsEnc: true, createdAt: true, metadata: true },
    });
    for (const account of accounts) {
      try {
        await pollAccount(account);
      } catch (e) {
        logger.warn({ err: e, accountId: account.id }, 'Email poll failed for account');
      }
    }
  } finally {
    running = false;
  }
}

export function startEmailInboundPoller(): void {
  if (timer) return;
  timer = setInterval(() => void pollAll(), POLL_INTERVAL_MS);
  timer.unref();
  void pollAll();
  logger.info('Email inbound poller started (60s interval)');
}

export function stopEmailInboundPoller(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
