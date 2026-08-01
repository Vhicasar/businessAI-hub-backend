import { randomUUID } from 'crypto';
import type { Prisma } from '@prisma/client';
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

interface EmailSyncMetadata extends Record<string, unknown> {
  syncSince?: string;
  lastUid?: number;
  uidValidity?: string;
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
  if (
    get('x-auto-response-suppress')
    || get('feedback-id')
    || get('x-autoreply')
    || get('x-autorespond')
    || get('x-campaign')
    || get('x-campaign-id')
  ) return true;
  // Unambiguous non-personal senders only (keep this narrow so real customer
  // mail is never dropped — that's what broke the inbox before).
  if (/(^|[._+-])(no.?reply|do.?not.?reply|donotreply|mailer-daemon|postmaster|bounces?)@/.test(from)) {
    return true;
  }
  return false;
}

/**
 * Require the integrated mailbox to be an actual recipient. This prevents a
 * shared/archive mailbox from turning unrelated copied mail into customer
 * conversations. Delivery headers cover BCC and common forwarding setups.
 */
function isAddressedToMailbox(
  parsed: Awaited<ReturnType<typeof simpleParser>>,
  mailbox: string,
): boolean {
  const target = mailbox.trim().toLowerCase();
  const recipients = [parsed.to, parsed.cc, parsed.bcc]
    .flatMap((field) => Array.isArray(field)
      ? field.flatMap((entry) => entry.value)
      : field?.value ?? [])
    .map((entry) => entry.address?.trim().toLowerCase())
    .filter(Boolean);
  if (recipients.includes(target)) return true;

  for (const name of ['delivered-to', 'x-original-to', 'envelope-to']) {
    const value = parsed.headers.get(name);
    if (value && String(value).toLowerCase().includes(target)) return true;
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

  const meta = ((account.metadata as EmailSyncMetadata | null) ?? {});
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
    meta.syncSince = watermark.toISOString();
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
      // Do not filter on the IMAP \Seen flag. Mail clients and server rules can
      // mark a message read before this poller runs, which previously made that
      // message invisible to Vhicasar forever. The persisted UID cursor and the
      // Message unique constraint provide safe deduplication instead.
      // Gmail exposes its inbox categories through X-GM-RAW. Restrict Gmail
      // integrations to Primary at the server; generic IMAP providers are
      // filtered below using standard recipient and automation headers.
      const searchQuery = client.capabilities.has('X-GM-EXT-1')
        ? { since: watermark }
        : { since: watermark };
      // ImapFlow returns sequence numbers by default. Every fetch/download
      // below is UID-based, so the search must explicitly return UIDs too.
      // Mixing these two number spaces silently skipped valid incoming mail.
      const found = await client.search(searchQuery, { uid: true });
      const uidValidity = String(client.mailbox && client.mailbox.uidValidity ? client.mailbox.uidValidity : '');
      const cursorStillValid = !meta.uidValidity || !uidValidity || meta.uidValidity === uidValidity;
      const lastUid = typeof meta.lastUid === 'number' && Number.isSafeInteger(meta.lastUid)
        && cursorStillValid ? meta.lastUid
        : 0;
      const uids = (Array.isArray(found) ? found : [])
        .filter((uid): uid is number => typeof uid === 'number' && uid > lastUid)
        .sort((a, b) => a - b);
      if (uids.length === 0) {
        if (meta.uidValidity !== uidValidity) {
          await saveSyncMetadata(account.id, meta, { uidValidity, lastUid, lastPolledAt: new Date().toISOString() });
        }
        logger.debug({ accountId: account.id, watermark, lastUid }, 'Email poll completed — no new messages');
        return;
      }

      // Oldest first so the cursor can advance without skipping an older mail
      // when a backlog is larger than one batch.
      let processedThroughUid = lastUid;
      let imported = 0;
      let skipped = 0;
      for (const uid of uids.slice(0, 30)) {
        const envelope = await client.fetchOne(
          String(uid),
          { internalDate: true },
          { uid: true },
        );
        const receivedAt = envelope && envelope.internalDate
          ? new Date(envelope.internalDate)
          : null;
        if (receivedAt && !Number.isNaN(receivedAt.getTime()) && receivedAt < watermark) {
          processedThroughUid = uid;
          skipped += 1;
          continue;
        }

        const raw = await client.download(String(uid), undefined, { uid: true });
        if (!raw?.content) {
          processedThroughUid = uid;
          skipped += 1;
          continue;
        }
        const parsed = await simpleParser(raw.content);

        const fromAddress = parsed.from?.value?.[0]?.address?.toLowerCase();
        // Our own mail, or automated/bulk → skip (never auto-reply). Do not
        // mutate mailbox read/unread state; this integration should be passive.
        if (
          !fromAddress
          || fromAddress === creds.imapUser.toLowerCase()
          || !isAddressedToMailbox(parsed, creds.imapUser)
          || isAutomatedEmail(parsed, fromAddress)
        ) {
          processedThroughUid = uid;
          skipped += 1;
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
                subject: subject || undefined,
                sentAt: parsed.date ?? receivedAt ?? undefined,
              }
            )
        );
        imported += 1;
        processedThroughUid = uid;
      }
      if (processedThroughUid > lastUid) {
        await saveSyncMetadata(account.id, meta, {
          lastUid: processedThroughUid,
          uidValidity,
          lastPolledAt: new Date().toISOString(),
        });
      }
      logger.info({ accountId: account.id, found: uids.length, imported, skipped, processedThroughUid }, 'Email inbound poll completed');
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
}

/** Persist the date watermark on the channel account (best-effort). */
async function saveSyncSince(accountId: string, meta: Record<string, unknown>, date: Date): Promise<void> {
  await saveSyncMetadata(accountId, meta, { syncSince: date.toISOString() })
    .catch((e) => logger.warn({ err: e, accountId }, 'Failed to persist email sync watermark'));
}

/** Persist mailbox cursor fields without discarding channel settings. */
async function saveSyncMetadata(
  accountId: string,
  meta: Record<string, unknown>,
  update: Record<string, unknown>,
): Promise<void> {
  await prismaUnscoped.channelAccount
    .update({
      where: { id: accountId },
      data: { metadata: { ...meta, ...update } as Prisma.InputJsonObject },
    })
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

/** Run one complete sync immediately (manual recovery / diagnostics). */
export async function pollEmailInboundNow(): Promise<void> {
  await pollAll();
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
