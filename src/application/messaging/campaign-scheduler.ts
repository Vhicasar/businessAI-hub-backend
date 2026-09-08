import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { campaignService } from './campaign.service';
import { logger } from '../../shared/logger';

/**
 * Campaigns scheduled for later.
 *
 * `scheduledAt` has been stored since campaigns existed, and nothing ever read
 * it — a business could pick a date, save, watch the status say SCHEDULED, and
 * the campaign would sit there for ever. Worse than not offering scheduling,
 * because it looked like it worked.
 *
 * Swept rather than timed: "the time has arrived" is not an event anything
 * emits, and a timer per campaign would be thousands of timers that vanish on
 * the next deploy.
 */

/**
 * How late a campaign may be and still go out.
 *
 * A campaign whose moment passed while the service was down is usually still
 * wanted — a Saturday promotion sent an hour late is fine. One from last week
 * is not: the sale is over, and sending it would cost money to confuse people.
 * Those are left SCHEDULED for a human to look at rather than silently fired
 * or silently cancelled.
 */
const GRACE_HOURS = 6;

export async function runScheduledCampaigns(now = new Date()): Promise<{ sent: number; stale: number }> {
  const due = await prismaUnscoped.campaign.findMany({
    where: {
      status: 'SCHEDULED',
      deletedAt: null,
      scheduledAt: { not: null, lte: now },
    },
    select: { id: true, organizationId: true, name: true, scheduledAt: true },
    orderBy: { scheduledAt: 'asc' },
    take: 100,
  });

  let sent = 0;
  let stale = 0;

  for (const campaign of due) {
    const lateBy = campaign.scheduledAt
      ? now.getTime() - campaign.scheduledAt.getTime()
      : 0;
    if (lateBy > GRACE_HOURS * 3_600_000) {
      stale += 1;
      logger.warn(
        { campaignId: campaign.id, scheduledAt: campaign.scheduledAt },
        'Scheduled campaign is too old to send automatically — left for review',
      );
      continue;
    }

    try {
      // Bound to the campaign's own tenant: the sweep runs outside any request,
      // and everything downstream — audience, wallet, Sender ID — reads from
      // that business.
      await requestContext.run(
        { requestId: `campaign-${campaign.id}`, organizationId: campaign.organizationId },
        () => campaignService.send(campaign.id),
      );
      sent += 1;
      logger.info({ campaignId: campaign.id, name: campaign.name }, 'Scheduled campaign sent');
    } catch (err) {
      /*
       * Left SCHEDULED deliberately.
       *
       * The usual reason a scheduled send fails is a balance that ran out or a
       * Sender ID that was suspended — both fixable, after which the next
       * sweep sends it. Marking it failed would need a human to notice and
       * re-create it.
       */
      logger.error(
        { err: (err as Error).message, campaignId: campaign.id },
        'Scheduled campaign could not be sent — will retry',
      );
    }
  }

  return { sent, stale };
}

let timer: NodeJS.Timeout | null = null;

/**
 * Every minute. Fine-grained enough that "9:00" means nine o'clock, cheap
 * enough that the query costs nothing when nothing is due.
 */
export function startCampaignScheduler(intervalMs = 60_000): void {
  if (timer) return;
  const tick = async () => {
    try {
      const { sent, stale } = await runScheduledCampaigns();
      if (sent > 0 || stale > 0) {
        logger.info({ sent, stale }, 'Scheduled campaign sweep');
      }
    } catch (err) {
      logger.error({ err }, 'Campaign scheduler tick failed');
    }
  };
  timer = setInterval(() => void tick(), intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  logger.info(`📣 Campaign scheduler started (${intervalMs}ms interval)`);
}
