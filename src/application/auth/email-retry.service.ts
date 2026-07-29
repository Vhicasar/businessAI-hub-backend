import { sha256, generateOpaqueToken } from '../../shared/crypto';
import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { logger } from '../../shared/logger';
import { mailer } from '../../infrastructure/mail/mailer';

/**
 * Durable retry for verification emails that never got through. The mailer
 * already retries 3× with backoff per send, but a longer outage (SMTP down for
 * minutes) needs a retry that survives it — and a process restart. This sweep
 * runs periodically, finds unverified users whose *latest* EMAIL_VERIFY
 * delivery FAILED, and re-sends. Idempotent and self-limiting: it reissues the
 * token, and a subsequent SENT log stops it from firing again.
 */

const WINDOW_MS = 24 * 60 * 60 * 1000; // only chase failures from the last 24h
const MAX_ATTEMPTS = 5; // give up after this many failed deliveries per user
const BATCH = 50;

export async function retryFailedVerifications(): Promise<number> {
  const since = new Date(Date.now() - WINDOW_MS);
  // Most recent failed verification email per recipient in the window.
  const failed = await prismaUnscoped.emailDeliveryLog.findMany({
    where: { type: 'EMAIL_VERIFY', status: 'FAILED', createdAt: { gt: since }, userId: { not: null } },
    orderBy: { createdAt: 'desc' },
    take: BATCH * 4,
    select: { userId: true, recipient: true },
  });

  const seen = new Set<string>();
  let resent = 0;
  for (const row of failed) {
    if (!row.userId || seen.has(row.userId) || resent >= BATCH) continue;
    seen.add(row.userId);

    const user = await prismaUnscoped.user.findUnique({
      where: { id: row.userId },
      select: { id: true, email: true, emailVerifiedAt: true, deletedAt: true },
    });
    if (!user || user.deletedAt || user.emailVerifiedAt) continue;

    // Already recovered? A newer SENT log means a resend/retry got through.
    const latest = await prismaUnscoped.emailDeliveryLog.findFirst({
      where: { userId: user.id, type: 'EMAIL_VERIFY' },
      orderBy: { createdAt: 'desc' },
      select: { status: true },
    });
    if (latest?.status === 'SENT') continue;

    const failures = await prismaUnscoped.emailDeliveryLog.count({
      where: { userId: user.id, type: 'EMAIL_VERIFY', status: 'FAILED', createdAt: { gt: since } },
    });
    if (failures >= MAX_ATTEMPTS) continue; // stop hammering a hard failure

    // Reissue a fresh token (invalidate outstanding) so the link is always valid.
    await prismaUnscoped.securityToken.updateMany({
      where: { userId: user.id, type: 'EMAIL_VERIFY', usedAt: null },
      data: { usedAt: new Date() },
    });
    const rawToken = generateOpaqueToken();
    await prismaUnscoped.securityToken.create({
      data: {
        userId: user.id,
        type: 'EMAIL_VERIFY',
        tokenHash: sha256(rawToken),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });
    const result = await mailer.sendEmailVerification(user.email, rawToken, user.id);
    if (result.delivered) resent++;
  }

  if (resent > 0) logger.info({ resent }, 'Verification email retry sweep re-sent messages');
  return resent;
}

/** Start the periodic sweep (best-effort). Interval in minutes; 0 disables. */
export function startEmailRetrySweep(intervalMin = 5): void {
  if (intervalMin <= 0) return;
  setInterval(() => {
    retryFailedVerifications().catch((err) =>
      logger.warn({ err: (err as Error).message }, 'Verification retry sweep failed'),
    );
  }, intervalMin * 60_000).unref();
}
