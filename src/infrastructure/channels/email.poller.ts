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

async function pollAccount(account: {
  id: string;
  organizationId: string;
  credentialsEnc: string | null;
}): Promise<void> {
  if (!account.credentialsEnc) return;
  const creds = JSON.parse(decrypt(account.credentialsEnc)) as EmailCreds;
  if (!creds.imapHost || !creds.imapUser) return;

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
      const unseen = await client.search({ seen: false });
      if (!unseen || unseen.length === 0) return;

      // Cap per cycle to keep polls quick; the rest picks up next round.
      for (const uid of unseen.slice(0, 20)) {
        const raw = await client.download(String(uid), undefined, { uid: true });
        if (!raw?.content) continue;
        const parsed = await simpleParser(raw.content);

        const fromAddress = parsed.from?.value?.[0]?.address?.toLowerCase();
        if (!fromAddress || fromAddress === creds.imapUser.toLowerCase()) {
          await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
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
        await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
}

async function pollAll(): Promise<void> {
  if (running) return; // skip overlapping cycles
  running = true;
  try {
    const accounts = await prismaUnscoped.channelAccount.findMany({
      where: { channelType: 'EMAIL', isActive: true, deletedAt: null },
      select: { id: true, organizationId: true, credentialsEnc: true },
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
