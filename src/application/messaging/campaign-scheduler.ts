import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { campaignService } from './campaign.service';
import { whatsappCampaignService, whatsappCampaignsEnabled } from './whatsapp-campaign.service';
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

/**
 * Send what is due.
 *
 * `organizationId` narrows the sweep to one business. Production never passes
 * it — the sweep is platform-wide by design — but a test that wants to prove
 * its own campaign goes out must not be able to fire everyone else's as a side
 * effect.
 */
export async function runScheduledCampaigns(
  now = new Date(),
  organizationId?: string,
): Promise<{ sent: number; stale: number; restored: number }> {
  // Hand back anything the platform switch parked, before working out what is
  // due — a campaign restored to SCHEDULED in this pass can go out in it.
  const restored = await restorePlatformPausedCampaigns(organizationId);

  const due = await prismaUnscoped.campaign.findMany({
    where: {
      status: 'SCHEDULED',
      deletedAt: null,
      scheduledAt: { not: null, lte: now },
      ...(organizationId ? { organizationId } : {}),
    },
    select: { id: true, organizationId: true, name: true, scheduledAt: true, type: true },
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
      const outcome = await requestContext.run(
        { requestId: `campaign-${campaign.id}`, organizationId: campaign.organizationId },
        /*
         * WhatsApp dispatches in resumable batches and can halt on a Meta
         * billing refusal, so it has its own path. Sending it through the
         * generic one would ignore its template, its segment and the billing
         * check — a scheduled WhatsApp campaign would simply never go out.
         */
        () => (campaign.type === 'WHATSAPP'
          ? whatsappCampaignService.dispatch(campaign.id, campaign.organizationId)
          : campaignService.send(campaign.id)),
      );
      /*
       * Dispatch can decline without failing.
       *
       * A campaign that reaches dispatch while the platform switch is off is
       * parked and handed straight back as PAUSED, which is not an error — so
       * it does not throw, and counting it as sent would have the sweep report
       * a send that never happened.
       */
      const status = (outcome as { status?: string } | undefined)?.status;
      if (status === 'PAUSED') {
        logger.info({ campaignId: campaign.id, name: campaign.name }, 'Scheduled campaign parked, not sent');
        continue;
      }
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

  return { sent, stale, restored };
}

/**
 * Give back the campaigns the platform switch took away.
 *
 * A campaign parked because WhatsApp campaigns were switched off platform-wide
 * is not a campaign anybody abandoned, so when the feature returns it should
 * not need chasing. One that was *scheduled* goes back to SCHEDULED with its
 * original due time, and the sweep below then applies the ordinary staleness
 * rule — a campaign whose moment passed last week is still left for a human
 * rather than fired late.
 *
 * One parked mid-dispatch is only un-marked, not restarted. Resuming it is a
 * decision with a cost attached, and the business should be the one making it;
 * clearing the mark is what lets them.
 */
async function restorePlatformPausedCampaigns(organizationId?: string): Promise<number> {
  if (!whatsappCampaignsEnabled()) return 0;

  const parked = await prismaUnscoped.campaign.findMany({
    where: {
      status: 'PAUSED',
      type: 'WHATSAPP',
      deletedAt: null,
      ...(organizationId ? { organizationId } : {}),
    },
    select: { id: true, content: true, scheduledAt: true },
    take: 200,
  });

  let count = 0;
  for (const campaign of parked) {
    const content = (campaign.content ?? {}) as Record<string, unknown>;
    if (content.pausedByPlatform !== true) continue;

    const dueAt = typeof content.platformPausedScheduledAt === 'string'
      ? new Date(content.platformPausedScheduledAt)
      : campaign.scheduledAt;
    const restorable = dueAt instanceof Date && Number.isFinite(dueAt.getTime());

    const {
      pausedByPlatform: _pausedByPlatform,
      platformPausedScheduledAt: _platformPausedScheduledAt,
      haltReason: _haltReason,
      haltedAt: _haltedAt,
      ...rest
    } = content;

    try {
      await prismaUnscoped.campaign.update({
        where: { id: campaign.id },
        data: {
          ...(restorable ? { status: 'SCHEDULED' as const, scheduledAt: dueAt } : {}),
          content: rest as object,
        },
      });
      count += 1;
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, campaignId: campaign.id },
        'Could not restore a campaign parked by the platform switch',
      );
    }
  }

  if (count > 0) logger.info({ restored: count }, 'Campaigns restored after WhatsApp campaigns were re-enabled');
  return count;
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
      const { sent, stale, restored } = await runScheduledCampaigns();
      if (sent > 0 || stale > 0 || restored > 0) {
        logger.info({ sent, stale, restored }, 'Scheduled campaign sweep');
      }
    } catch (err) {
      logger.error({ err }, 'Campaign scheduler tick failed');
    }
  };
  timer = setInterval(() => void tick(), intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  logger.info(`📣 Campaign scheduler started (${intervalMs}ms interval)`);
}
