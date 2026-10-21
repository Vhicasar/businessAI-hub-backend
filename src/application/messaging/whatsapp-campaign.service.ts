import { z } from 'zod';
import { prisma, prismaUnscoped } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { logger } from '../../shared/logger';
import { decrypt } from '../../shared/crypto';
import { AppError, ConflictError, NotFoundError } from '../../shared/errors';
import { getAdapter } from '../../infrastructure/channels/registry';
import { MetaSendError, isRetryable } from '../../infrastructure/channels/meta-error';
import { enqueue } from '../../infrastructure/queue/queue';
import { resolveEntitlements } from '../billing/entitlements';
import { usageService, USAGE_METRICS } from '../billing/usage.service';
import { segmentSchema, whatsappAudienceService, type AudienceMember } from './audience.service';
import { whatsappTemplateService } from './whatsapp-template.service';
import { whatsappPricingService } from './whatsapp-pricing.service';
import { whatsappBillingService } from '../inbox/whatsapp-billing.service';
import { PLATFORM_FEATURES, isPlatformFeatureEnabled } from '../settings/platform-features';

/**
 * WhatsApp marketing campaigns.
 *
 * Three things make this different from the generic campaign path, and each is
 * why it does not simply reuse it:
 *
 *  - A marketing message must go out as an approved template, so the template
 *    is validated against Meta before anything is queued rather than failing
 *    one recipient at a time.
 *  - Recipients are addressed by phone number from the CRM. The shared path
 *    resolves a WhatsApp address from a prior conversation, which reaches only
 *    customers who already messaged in — almost nobody, for an outbound
 *    campaign.
 *  - Meta can refuse the whole campaign for one reason only a code reveals:
 *    the business has no payment method. That has to stop dispatch, not retry
 *    it, and it has to be told apart from a bad template.
 *
 * Dispatch is resumable by construction: every recipient is written down
 * before anything is sent, and only rows that are still pending are ever
 * picked up. A campaign that stops halfway and is resumed does not message
 * anyone twice.
 */

/** What a dispatch pass reports back. */
export interface CampaignOutcome {
  id: string;
  name?: string;
  status: string;
  stats?: unknown;
  completedAt?: Date | null;
}

export const launchSchema = z.object({
  name: z.string().trim().min(1).max(160),
  channelAccountId: z.string().cuid(),
  templateName: z.string().trim().min(1).max(512),
  templateLanguage: z.string().trim().min(2).max(20),
  /** Values for {{1}}, {{2}}… keyed by index as a string. */
  variables: z.record(z.string().max(1000)).default({}),
  segment: segmentSchema,
  scheduledAt: z.string().datetime().nullable().optional(),
});
export type LaunchDto = z.infer<typeof launchSchema>;

/** Recipients per dispatch pass, keeping one campaign from hogging a worker. */
const BATCH_SIZE = 200;
/** Pause between sends — Meta throttles, and a burst wastes the quota. */
const SEND_SPACING_MS = 120;
/** How many times one recipient may be retried for a transient failure. */
const MAX_ATTEMPTS = 3;

function orgId(): string {
  const id = requestContext.get()?.organizationId;
  if (!id) throw new AppError('NO_TENANT', 400, 'No tenant in request context');
  return id;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface CampaignContent {
  channelAccountId?: string;
  templateName?: string;
  templateLanguage?: string;
  variables?: Record<string, string>;
  segment?: unknown;
  /** Why dispatch stopped, when it did. */
  haltReason?: string;
  haltedAt?: string;
  /**
   * Halted because the platform administrator switched campaigns off, rather
   * than because of anything the business or Meta did.
   *
   * Recorded so the campaign can be handed back when the feature returns: a
   * scheduled campaign paused this way is restored to SCHEDULED by the sweep,
   * where one a person paused stays paused until that person resumes it.
   */
  pausedByPlatform?: boolean;
  /** The moment it was due, kept so restoring it does not lose the schedule. */
  platformPausedScheduledAt?: string;
}

/** The WhatsApp account this campaign sends from, proven to belong to the tenant. */
async function loadSendingAccount(accountId: string, organizationId: string) {
  const account = await prismaUnscoped.channelAccount.findFirst({
    where: {
      id: accountId, organizationId, channelType: 'WHATSAPP',
      isActive: true, deletedAt: null,
    },
    select: { id: true, organizationId: true, externalId: true, credentialsEnc: true, webhookSecret: true, status: true, metadata: true },
  });
  if (!account) {
    throw new NotFoundError('WhatsApp channel');
  }
  return account;
}

/**
 * Whether the platform is offering WhatsApp campaigns at all.
 *
 * An administrator decision, not a plan one, so it is enforced here rather
 * than left to the UI: hiding the button would still leave the API open, and
 * the API is what a campaign is actually launched through.
 *
 * Scope is deliberately narrow. This governs campaigns and nothing else —
 * inbound WhatsApp messages, the inbox, customer conversations and the channel
 * connection itself all keep working, and no campaign record is touched.
 */
export function whatsappCampaignsEnabled(): boolean {
  return isPlatformFeatureEnabled(PLATFORM_FEATURES.whatsappCampaigns);
}

export const CAMPAIGNS_DISABLED_MESSAGE =
  'WhatsApp campaigns are currently unavailable on this platform. Your existing campaigns '
  + 'and their records are unchanged, and WhatsApp conversations are unaffected.';

function requireCampaignsEnabled(): void {
  if (!whatsappCampaignsEnabled()) {
    throw new AppError('WHATSAPP_CAMPAIGNS_DISABLED', 403, CAMPAIGNS_DISABLED_MESSAGE);
  }
}

export const whatsappCampaignService = {
  /**
   * The WhatsApp numbers this business can send a campaign from.
   *
   * Billing state rides along so the builder can warn before someone spends
   * time composing, without a separate round trip per account.
   */
  async sendingAccounts() {
    const organizationId = orgId();
    const accounts = await prismaUnscoped.channelAccount.findMany({
      where: { organizationId, channelType: 'WHATSAPP', isActive: true, deletedAt: null },
      select: { id: true, name: true, externalId: true, status: true, metadata: true },
      orderBy: { createdAt: 'asc' },
    });
    return accounts.map((account) => {
      const metadata = (account.metadata ?? {}) as Record<string, unknown>;
      const billing = (metadata.billing ?? {}) as { state?: string };
      return {
        id: account.id,
        name: account.name,
        status: account.status,
        displayPhoneNumber: typeof metadata.displayPhoneNumber === 'string' ? metadata.displayPhoneNumber : null,
        wabaName: typeof metadata.wabaName === 'string' ? metadata.wabaName : null,
        billingState: billing.state ?? 'UNKNOWN',
        templateCount: Array.isArray(metadata.messageTemplates) ? metadata.messageTemplates.length : 0,
      };
    });
  },

  /**
   * Everything the review screen needs before anyone commits to sending:
   * who it reaches, what it will say, what Meta may charge, and whether
   * billing is known to be in the way.
   */
  async preview(input: { channelAccountId: string; templateName: string; templateLanguage: string; variables: Record<string, string>; segment: z.infer<typeof segmentSchema> }) {
    requireCampaignsEnabled();
    const organizationId = orgId();
    const [account, audience] = await Promise.all([
      loadSendingAccount(input.channelAccountId, organizationId),
      whatsappAudienceService.resolve(organizationId, input.segment),
    ]);
    const template = await whatsappTemplateService.requireEligible(
      account.id, organizationId, input.templateName, input.templateLanguage,
    );
    const rendered = whatsappTemplateService.render(template, input.variables);
    const [estimate, billing] = await Promise.all([
      whatsappPricingService.estimate(audience.members.map((m) => m.waId), 'MARKETING'),
      whatsappBillingService.status(account.id, organizationId),
    ]);
    return {
      audience: {
        count: audience.members.length,
        matched: audience.matched,
        excluded: audience.excluded,
        sample: audience.members.slice(0, 5).map((m) => ({ name: [m.firstName, m.lastName].filter(Boolean).join(' ') || 'Customer', waId: `${m.waId.slice(0, 5)}•••${m.waId.slice(-3)}` })),
      },
      template: { ...template, preview: rendered.text },
      estimate,
      billing,
    };
  },

  /**
   * Write the campaign down, then start it.
   *
   * The record and its recipients exist before a single message leaves, so a
   * crash between here and the first send loses nothing and repeats nothing.
   */
  async launch(dto: LaunchDto) {
    requireCampaignsEnabled();
    const organizationId = orgId();
    const account = await loadSendingAccount(dto.channelAccountId, organizationId);
    const template = await whatsappTemplateService.requireEligible(
      account.id, organizationId, dto.templateName, dto.templateLanguage,
    );
    // Rendering now is what stops a campaign launching with a hole in it.
    whatsappTemplateService.render(template, dto.variables);

    const audience = await whatsappAudienceService.resolve(organizationId, dto.segment);
    if (audience.members.length === 0) {
      throw new AppError('EMPTY_AUDIENCE', 400, 'No one in this segment can be messaged on WhatsApp right now.', { excluded: audience.excluded });
    }

    const ent = await resolveEntitlements(organizationId);
    const reachLimit = ent.limits.maxMarketingReach;
    if (reachLimit !== null && reachLimit !== undefined && audience.members.length > reachLimit) {
      throw new AppError(
        'MARKETING_REACH_LIMIT', 402,
        `This campaign reaches ${audience.members.length.toLocaleString()} contacts, above your plan limit of ${reachLimit.toLocaleString()}.`,
        { audience: audience.members.length, limit: reachLimit },
      );
    }

    const scheduled = dto.scheduledAt ? new Date(dto.scheduledAt) : null;
    const content: CampaignContent = {
      channelAccountId: account.id,
      templateName: dto.templateName,
      templateLanguage: dto.templateLanguage,
      variables: dto.variables,
      segment: dto.segment,
    };

    const campaign = await prisma.campaign.create({
      data: {
        organizationId,
        name: dto.name,
        type: 'WHATSAPP',
        status: scheduled ? 'SCHEDULED' : 'SENDING',
        content: content as object,
        scheduledAt: scheduled,
        startedAt: scheduled ? null : new Date(),
        createdById: requestContext.get()?.userId ?? null,
        stats: { total: audience.members.length, sent: 0, failed: 0, skipped: 0 } as object,
      },
      select: { id: true, name: true, status: true, scheduledAt: true, stats: true },
    });

    // Every intended recipient, written down before anything is sent.
    await prisma.campaignRecipient.createMany({
      data: audience.members.map((member) => ({
        campaignId: campaign.id,
        customerId: member.customerId,
        status: 'PENDING' as const,
      })),
      skipDuplicates: true,
    });

    if (scheduled) return campaign;

    const ctx = requestContext.get();
    const queued = await enqueue('campaign', 'whatsapp-dispatch', {
      campaignId: campaign.id,
      ctx: { organizationId: ctx?.organizationId, userId: ctx?.userId },
    });
    if (queued) return campaign;
    return this.dispatch(campaign.id, organizationId);
  },

  /**
   * Send to everyone still pending, and stop properly when Meta says stop.
   *
   * Safe to call again: it only ever picks up rows that have not been sent,
   * so resuming a halted campaign continues rather than restarting.
   */
  async dispatch(campaignId: string, organizationId: string): Promise<CampaignOutcome> {
    const campaign = await prismaUnscoped.campaign.findFirst({
      where: { id: campaignId, organizationId, deletedAt: null },
    });
    if (!campaign) throw new NotFoundError('Campaign');
    if (campaign.type !== 'WHATSAPP') throw new ConflictError('This is not a WhatsApp campaign');
    if (campaign.status === 'CANCELLED') throw new ConflictError('This campaign was cancelled');

    const content = (campaign.content ?? {}) as CampaignContent;

    /*
     * The platform switch, checked here rather than only at launch.
     *
     * Launch is not the only way a campaign reaches dispatch: the queue worker
     * and the scheduled sweep both call straight into it, so a campaign
     * queued or scheduled before the switch was thrown would otherwise still
     * send. Nothing is deleted or cancelled — it is parked, with the reason
     * recorded and its due time kept, and handed back when the feature
     * returns.
     */
    if (!whatsappCampaignsEnabled()) {
      const parked = await prismaUnscoped.campaign.update({
        where: { id: campaignId },
        data: {
          status: 'PAUSED',
          content: {
            ...content,
            haltReason: CAMPAIGNS_DISABLED_MESSAGE,
            haltedAt: new Date().toISOString(),
            pausedByPlatform: true,
            ...(campaign.scheduledAt
              ? { platformPausedScheduledAt: campaign.scheduledAt.toISOString() }
              : {}),
          } as object,
        },
        select: { id: true, name: true, status: true, stats: true, completedAt: true },
      });
      logger.warn(
        { campaignId, organizationId },
        'WhatsApp campaign parked — campaigns are switched off platform-wide',
      );
      return parked;
    }
    if (!content.channelAccountId || !content.templateName) {
      throw new AppError('CAMPAIGN_INCOMPLETE', 400, 'This campaign is missing its WhatsApp account or template.');
    }
    const account = await loadSendingAccount(content.channelAccountId, organizationId);
    const template = await whatsappTemplateService.requireEligible(
      account.id, organizationId, content.templateName, content.templateLanguage ?? 'en_US',
    );
    const rendered = whatsappTemplateService.render(template, content.variables ?? {});
    const credentials = account.credentialsEnc
      ? (JSON.parse(decrypt(account.credentialsEnc)) as Record<string, string>)
      : {};
    const adapter = getAdapter('WHATSAPP');

    await prismaUnscoped.campaign.update({ where: { id: campaignId }, data: { status: 'SENDING', startedAt: campaign.startedAt ?? new Date() } });

    const pending = await prismaUnscoped.campaignRecipient.findMany({
      where: { campaignId, status: { in: ['PENDING', 'FAILED'] }, attempts: { lt: MAX_ATTEMPTS } },
      take: BATCH_SIZE,
      orderBy: { id: 'asc' },
    });

    let sent = 0;
    let failed = 0;
    let skipped = 0;
    let halt: { reason: string; billing: boolean } | null = null;

    for (const recipient of pending) {
      // Consent can be withdrawn between building the audience and reaching
      // this row, so it is checked again here rather than trusted from then.
      const customer = await prismaUnscoped.customer.findFirst({
        where: { id: recipient.customerId, organizationId, deletedAt: null },
        select: { phone: true, marketingOptIn: true, isBlocked: true, firstName: true, lastName: true },
      });
      const waId = customer?.phone?.replace(/\D/g, '') ?? '';
      if (!customer || !customer.marketingOptIn || customer.isBlocked || !waId) {
        await prismaUnscoped.campaignRecipient.update({
          where: { id: recipient.id },
          data: { status: 'UNSUBSCRIBED', error: 'No longer eligible when the campaign reached them' },
        });
        skipped += 1;
        continue;
      }

      try {
        const result = await adapter.sendMessage(
          {
            recipientExternalId: waId,
            text: rendered.text,
            isMarketing: true,
            templateName: template.name,
            templateLanguage: template.language,
          },
          {
            id: account.id,
            organizationId: account.organizationId,
            externalId: account.externalId,
            credentials,
            webhookSecret: account.webhookSecret,
          },
        );
        await prismaUnscoped.campaignRecipient.update({
          where: { id: recipient.id },
          data: {
            status: 'SENT', sentAt: new Date(), error: null, errorCode: null,
            providerMessageId: result.providerMessageId,
            attempts: { increment: 1 },
          },
        });
        sent += 1;
        // A paid template that Meta accepted is the only proof billing works.
        if (sent === 1) await whatsappBillingService.markReady(account.id);
      } catch (error) {
        const meta = error instanceof MetaSendError ? error : null;
        const kind = meta?.kind ?? 'UNKNOWN';
        const retryable = isRetryable(kind) && recipient.attempts + 1 < MAX_ATTEMPTS;

        await prismaUnscoped.campaignRecipient.update({
          where: { id: recipient.id },
          data: {
            status: retryable ? 'PENDING' : 'FAILED',
            error: (meta?.detail.message ?? (error as Error).message).slice(0, 500),
            errorCode: meta?.detail.code ?? null,
            attempts: { increment: 1 },
          },
        });

        if (kind === 'BILLING_REQUIRED' && meta) {
          /*
           * Stop the whole campaign. Meta will refuse every remaining
           * recipient for the same reason, and each attempt is another
           * failure against this account's quality rating.
           */
          await whatsappBillingService.markBillingRequired(account.id, meta.detail);
          halt = { reason: 'Meta requires a payment method on this WhatsApp Business Account before it will send this campaign.', billing: true };
          break;
        }
        if (kind === 'AUTH' || kind === 'TEMPLATE') {
          halt = {
            reason: kind === 'AUTH'
              ? 'WhatsApp rejected this account\'s credentials. Reconnect the channel and resume.'
              : `Meta rejected the template: ${meta?.detail.message ?? 'template unavailable'}`,
            billing: false,
          };
          break;
        }
        if (!retryable) failed += 1;
        if (kind === 'RATE_LIMIT') await wait(2_000);
      }
      await wait(SEND_SPACING_MS);
    }

    return this.settle(campaignId, organizationId, { sent, failed, skipped }, halt);
  },

  /** Work out where the campaign now stands and record it. */
  async settle(
    campaignId: string,
    organizationId: string,
    delta: { sent: number; failed: number; skipped: number },
    halt: { reason: string; billing: boolean } | null,
  ): Promise<CampaignOutcome> {
    const counts = await prismaUnscoped.campaignRecipient.groupBy({
      by: ['status'], where: { campaignId }, _count: { _all: true },
    });
    const tally = Object.fromEntries(counts.map((row) => [row.status, row._count._all]));
    const outstanding = (tally.PENDING ?? 0);
    const campaign = await prismaUnscoped.campaign.findFirstOrThrow({ where: { id: campaignId, organizationId } });
    const content = (campaign.content ?? {}) as CampaignContent;

    const status = halt
      ? 'PARTIALLY_SENT'
      : outstanding > 0
        ? 'SENDING'
        : (tally.SENT ?? 0) > 0 ? 'SENT' : 'FAILED';

    const stats = {
      total: Object.values(tally).reduce((sum, value) => sum + value, 0),
      sent: tally.SENT ?? 0,
      failed: tally.FAILED ?? 0,
      skipped: tally.UNSUBSCRIBED ?? 0,
      pending: outstanding,
      ...(halt ? { haltReason: halt.reason, billingBlocked: halt.billing } : {}),
    };

    if (delta.sent > 0) {
      const ent = await resolveEntitlements(organizationId);
      await usageService.increment(USAGE_METRICS.MARKETING_RECIPIENT, {
        organizationId, periodStart: ent.periodStart, periodEnd: ent.periodEnd,
      }, delta.sent).catch((err) => logger.warn({ err, campaignId }, 'Could not record campaign usage'));
    }

    const updated = await prismaUnscoped.campaign.update({
      where: { id: campaignId },
      data: {
        status,
        stats: stats as object,
        completedAt: status === 'SENT' || status === 'FAILED' ? new Date() : null,
        content: { ...content, ...(halt ? { haltReason: halt.reason, haltedAt: new Date().toISOString() } : {}) } as object,
      },
      select: { id: true, name: true, status: true, stats: true, completedAt: true },
    });

    // More to do and nothing blocking: come back for the next batch.
    if (status === 'SENDING' && !halt) {
      const queued = await enqueue('campaign', 'whatsapp-dispatch', { campaignId, ctx: { organizationId } });
      if (!queued) return this.dispatch(campaignId, organizationId);
    }
    if (halt) {
      logger.warn({ campaignId, organizationId, reason: halt.reason, billing: halt.billing, stats }, 'WhatsApp campaign halted');
    }
    return updated;
  },

  /**
   * Pick a halted campaign back up.
   *
   * Only the recipients who were never reached are retried; anyone already
   * sent to keeps their SENT row and is skipped by the dispatch query.
   */
  async resume(campaignId: string) {
    requireCampaignsEnabled();
    const organizationId = orgId();
    const campaign = await prismaUnscoped.campaign.findFirst({ where: { id: campaignId, organizationId, deletedAt: null } });
    if (!campaign) throw new NotFoundError('Campaign');
    if (!['PARTIALLY_SENT', 'PAUSED', 'FAILED'].includes(campaign.status)) {
      throw new ConflictError('This campaign is not waiting to be resumed');
    }
    // Give the rows that failed for a resolvable reason another chance.
    await prismaUnscoped.campaignRecipient.updateMany({
      where: { campaignId, status: 'FAILED' },
      data: { status: 'PENDING', attempts: 0, error: null, errorCode: null },
    });
    return this.dispatch(campaignId, organizationId);
  },

  async cancel(campaignId: string) {
    const organizationId = orgId();
    const campaign = await prismaUnscoped.campaign.findFirst({ where: { id: campaignId, organizationId, deletedAt: null } });
    if (!campaign) throw new NotFoundError('Campaign');
    if (campaign.status === 'SENT') throw new ConflictError('This campaign has already finished');
    return prismaUnscoped.campaign.update({
      where: { id: campaignId },
      data: { status: 'CANCELLED', completedAt: new Date() },
      select: { id: true, status: true },
    });
  },

  /** A campaign and how each recipient fared. */
  async report(campaignId: string) {
    const organizationId = orgId();
    const campaign = await prismaUnscoped.campaign.findFirst({
      where: { id: campaignId, organizationId, deletedAt: null },
      select: { id: true, name: true, status: true, stats: true, content: true, startedAt: true, completedAt: true, scheduledAt: true },
    });
    if (!campaign) throw new NotFoundError('Campaign');
    const recipients = await prismaUnscoped.campaignRecipient.findMany({
      where: { campaignId }, take: 500, orderBy: [{ status: 'asc' }, { id: 'asc' }],
      select: { customerId: true, status: true, sentAt: true, error: true, errorCode: true, providerMessageId: true, attempts: true },
    });
    const customers = await prismaUnscoped.customer.findMany({
      where: { id: { in: recipients.map((r) => r.customerId) }, organizationId },
      select: { id: true, firstName: true, lastName: true },
    });
    const names = new Map(customers.map((c) => [c.id, [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Customer']));
    const content = (campaign.content ?? {}) as CampaignContent;
    return {
      ...campaign,
      haltReason: content.haltReason ?? null,
      recipients: recipients.map((recipient) => ({ ...recipient, name: names.get(recipient.customerId) ?? 'Customer' })),
    };
  },
};

/** Entry point for the queue worker. */
export async function dispatchWhatsAppCampaign(campaignId: string, organizationId: string) {
  return whatsappCampaignService.dispatch(campaignId, organizationId);
}

export type { AudienceMember };
