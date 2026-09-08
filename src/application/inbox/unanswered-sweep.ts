import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { workflowService } from '../crm/workflow.service';
import { logger } from '../../shared/logger';

/**
 * Conversations nobody has answered.
 *
 * The other messaging triggers fire on something happening. This one fires on
 * something *not* happening, which no webhook will ever tell us about — so it
 * is swept for rather than reacted to.
 *
 * A conversation qualifies when the last message is inbound, the thread is
 * still open, and it has been sitting there longer than the threshold. The
 * customer waiting is the whole point: a thread where the business replied and
 * the customer went quiet is not unanswered, it is finished.
 *
 * Fires once per conversation per breach, not once per sweep. Marking is done
 * in the conversation's own metadata rather than a new column — an alert that
 * repeated every ten minutes would be ignored within a day, which is worse
 * than not alerting at all.
 */

const DEFAULT_THRESHOLD_MINUTES = 30;
const MARKER = 'unansweredNotifiedAt';

interface Sweepable {
  id: string;
  organizationId: string;
  customerId: string;
  assignedToId: string | null;
  lastMessageAt: Date | null;
  lastMessageText: string | null;
  metadata: unknown;
  channelAccount: { channelType: string };
  customer: { firstName: string; lastName: string | null };
}

/** Conversations past the threshold whose latest message came from outside. */
async function findUnanswered(thresholdMinutes: number): Promise<Sweepable[]> {
  const cutoff = new Date(Date.now() - thresholdMinutes * 60_000);
  const candidates = await prismaUnscoped.conversation.findMany({
    where: {
      status: 'OPEN',
      lastMessageAt: { not: null, lt: cutoff },
      // A bot handling it is still an answer as far as the customer is
      // concerned; escalation is the assistant's own job.
      isBotHandled: false,
    },
    select: {
      id: true, organizationId: true, customerId: true, assignedToId: true,
      lastMessageAt: true, lastMessageText: true, metadata: true,
      channelAccount: { select: { channelType: true } },
      customer: { select: { firstName: true, lastName: true } },
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { direction: true, createdAt: true },
      },
    },
    orderBy: { lastMessageAt: 'asc' },
    take: 500,
  });

  return candidates
    .filter((c) => {
      // Waiting on us, not on them.
      if (c.messages[0]?.direction !== 'INBOUND') return false;
      // Already told someone about this particular wait.
      const meta = (c.metadata ?? {}) as Record<string, unknown>;
      const notifiedAt = meta[MARKER];
      if (typeof notifiedAt === 'string' && c.lastMessageAt) {
        return new Date(notifiedAt) < c.lastMessageAt;
      }
      return true;
    })
    .map(({ messages: _messages, ...rest }) => rest);
}

/** One pass. Returns how many conversations were reported. */
export async function runUnansweredSweep(
  thresholdMinutes = DEFAULT_THRESHOLD_MINUTES
): Promise<number> {
  const waiting = await findUnanswered(thresholdMinutes);
  let fired = 0;

  for (const conversation of waiting) {
    const waitedMinutes = conversation.lastMessageAt
      ? Math.floor((Date.now() - conversation.lastMessageAt.getTime()) / 60_000)
      : thresholdMinutes;

    try {
      // Bound to the conversation's own tenant: the sweep runs outside any
      // request, and every rule it fires must read that business's workflows.
      await requestContext.run(
        { requestId: `unanswered-${conversation.id}`, organizationId: conversation.organizationId },
        async () => {
          await workflowService.dispatchNow(
            'conversation.unanswered',
            {
              channel: conversation.channelAccount.channelType,
              text: conversation.lastMessageText ?? '',
              customerId: conversation.customerId,
              conversationId: conversation.id,
              customerName:
                `${conversation.customer.firstName} ${conversation.customer.lastName ?? ''}`.trim(),
              waitedMinutes,
              assigned: Boolean(conversation.assignedToId),
            },
            {
              entityType: 'CONVERSATION',
              entityId: conversation.id,
              customerId: conversation.customerId,
              ownerId: conversation.assignedToId,
            },
          );
        },
      );

      const meta = (conversation.metadata ?? {}) as Record<string, unknown>;
      await prismaUnscoped.conversation.update({
        where: { id: conversation.id },
        data: { metadata: { ...meta, [MARKER]: new Date().toISOString() } },
      });
      fired += 1;
    } catch (err) {
      logger.warn({ err, conversationId: conversation.id }, 'Unanswered sweep failed for conversation');
    }
  }
  return fired;
}

let timer: NodeJS.Timeout | null = null;

/**
 * Polling every few minutes rather than scheduling a timer per conversation:
 * "nothing happened" has no event to hang a timer on, and a business with
 * thousands of open threads would otherwise hold thousands of timers.
 */
export function startUnansweredWatcher(intervalMs = 5 * 60_000): void {
  if (timer) return;
  const tick = async () => {
    try {
      const fired = await runUnansweredSweep();
      if (fired > 0) logger.info({ fired }, 'Unanswered conversations reported');
    } catch (err) {
      logger.error({ err }, 'Unanswered sweep tick failed');
    }
  };
  timer = setInterval(() => void tick(), intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  logger.info(`💬 Unanswered conversation watcher started (${intervalMs}ms interval)`);
}
