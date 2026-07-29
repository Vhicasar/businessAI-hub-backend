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
  if (h.has('list-unsubscribe') || h.has('list-id') || h.has('list-post')) return true;
  const autoSubmitted = get('auto-submitted');
  if (autoSubmitted && autoSubmitted !== 'no') return true; // auto-generated / auto-replied
  if (get('x-auto-response-suppress')) return true;
  if (get('feedback-id') || get('x-campaign') || get('x-mailer-lid') || get('x-marketing')) return true;
  // Common non-personal senders.
  if (/(^|[._-])(no.?reply|do.?not.?reply|noreply|donotreply|mailer-daemon|postmaster|bounce|bounces|notifications?|newsletter|mailer|updates?|alerts?)@/.test(from)) {
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
  // Only ever handle mail that arrived AFTER the channel was configured — the
  // account's createdAt is the floor (or an explicit metadata.syncSince).
  const watermark = new Date(
    typeof meta.syncSince === 'string' ? meta.syncSince : account.createdAt,
  );
  // High-watermark on the IMAP UID so each message is handled once and history
  // is never replayed. Unset on the first poll → we baseline to the newest UID
  // and process nothing older.
  let lastUid = typeof meta.imapLastUid === 'number' ? meta.imapLastUid : null;

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
      const uidNext = Number((client.mailbox && typeof client.mailbox === 'object' && 'uidNext' in client.mailbox ? client.mailbox.uidNext : 0) || 0);

      // First time we see this account: baseline the watermark to the newest UID
      // so pre-existing mail (promotional or otherwise) is never processed.
      if (lastUid == null) {
        const baseline = Math.max(0, uidNext - 1);
        await saveLastUid(account.id, meta, baseline);
        logger.info({ accountId: account.id, baseline }, 'Email poller baselined — existing mail will not be auto-processed');
        return;
      }

      // Only unseen messages newer than the watermark UID.
      const unseen = await client.search({ seen: false, uid: `${lastUid + 1}:*` });
      // `uid: n:*` always returns at least the highest message; drop anything <= watermark.
      const fresh = (Array.isArray(unseen) ? unseen : []).filter((uid: number) => uid > lastUid!);
      if (fresh.length === 0) return;

      let maxUid = lastUid;
      for (const uid of fresh.slice(0, 20)) {
        maxUid = Math.max(maxUid, uid);
        const raw = await client.download(String(uid), undefined, { uid: true });
        if (!raw?.content) continue;
        const parsed = await simpleParser(raw.content);

        const fromAddress = parsed.from?.value?.[0]?.address?.toLowerCase();
        // Skip our own mail, anything predating configuration, and automated/bulk.
        if (
          !fromAddress ||
          fromAddress === creds.imapUser.toLowerCase() ||
          (parsed.date && parsed.date < watermark) ||
          isAutomatedEmail(parsed, fromAddress)
        ) {
          await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }).catch(() => undefined);
          continue;
        }

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
      if (maxUid > lastUid) await saveLastUid(account.id, meta, maxUid);
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
}

/** Persist the IMAP UID high-watermark on the channel account (best-effort). */
async function saveLastUid(accountId: string, meta: Record<string, unknown>, uid: number): Promise<void> {
  await prismaUnscoped.channelAccount
    .update({ where: { id: accountId }, data: { metadata: { ...meta, imapLastUid: uid } } })
    .catch((e) => logger.warn({ err: e, accountId }, 'Failed to persist email UID watermark'));
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
