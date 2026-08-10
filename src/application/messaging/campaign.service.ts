import { z } from 'zod';
import type { ChannelType } from '@prisma/client';
import { ConflictError, NotFoundError } from '../../shared/errors';
import { prisma } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { activityService } from '../crm/activity.service';
import { messagingService, renderTemplate } from './messaging.service';
import { enqueue } from '../../infrastructure/queue/queue';
import { resolveEntitlements } from '../billing/entitlements';
import { usageService } from '../billing/usage.service';
import { USAGE_METRICS } from '../billing/usage.service';
import { AppError } from '../../shared/errors';
import { smsWalletService } from '../billing/sms-wallet.service';

function orgId(): string {
  const id = requestContext.get()?.organizationId;
  if (!id) throw new Error('No tenant in request context');
  return id;
}

// CampaignType → the ChannelType used to deliver it.
function channelFor(type: string): ChannelType {
  return type === 'SMS' ? 'SMS' : type === 'WHATSAPP' ? 'WHATSAPP' : 'EMAIL';
}

/** Cap a single send batch — protects against accidental mass-sends. */
const MAX_RECIPIENTS = 1000;

export const createCampaignSchema = z.object({
  name: z.string().trim().min(1).max(160),
  type: z.enum(['EMAIL', 'SMS', 'WHATSAPP']),
  subject: z.string().trim().max(200).nullable().optional(),
  body: z.string().trim().min(1).max(5000),
  imageUrl: z.string().url().max(2000).nullable().optional(),
  templateName: z.string().trim().max(512).nullable().optional(),
  templateLanguage: z.string().trim().max(20).default('en_US'),
  audience: z.enum(['ALL_OPTED_IN', 'SELECTED']).default('ALL_OPTED_IN'),
  recipientIds: z.array(z.string().cuid()).max(MAX_RECIPIENTS).default([]),
}).superRefine((value, ctx) => {
  if (value.audience === 'SELECTED' && value.recipientIds.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['recipientIds'],
      message: 'Select at least one contact',
    });
  }
});
export const updateCampaignSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  subject: z.string().trim().max(200).nullable().optional(),
  body: z.string().trim().min(1).max(5000).optional(),
});

type CreateCampaignDto = z.infer<typeof createCampaignSchema>;

const campaignSelect = {
  id: true, name: true, type: true, status: true, subject: true, content: true,
  stats: true, startedAt: true, completedAt: true, createdAt: true,
} as const;

export const campaignService = {
  async list() {
    const rows = await prisma.campaign.findMany({
      where: { deletedAt: null },
      select: { ...campaignSelect, _count: { select: { recipients: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows;
  },

  async get(id: string) {
    const campaign = await prisma.campaign.findFirst({
      where: { id, deletedAt: null },
      select: campaignSelect,
    });
    if (!campaign) throw new NotFoundError('Campaign');
    return campaign;
  },

  async create(dto: CreateCampaignDto) {
    return prisma.campaign.create({
      data: {
        organizationId: orgId(),
        name: dto.name,
        type: dto.type,
        status: 'DRAFT',
        subject: dto.subject ?? null,
        content: {
          body: dto.body,
          audience: dto.audience,
          recipientIds: dto.audience === 'SELECTED' ? [...new Set(dto.recipientIds)] : [],
          imageUrl: dto.imageUrl ?? null,
          templateName: dto.templateName ?? null,
          templateLanguage: dto.templateLanguage,
        },
        createdById: requestContext.get()?.membershipId ?? null,
      },
      select: campaignSelect,
    });
  },

  async update(id: string, dto: z.infer<typeof updateCampaignSchema>) {
    const campaign = await prisma.campaign.findFirst({ where: { id, deletedAt: null } });
    if (!campaign) throw new NotFoundError('Campaign');
    if (campaign.status !== 'DRAFT') throw new ConflictError('Only draft campaigns can be edited');
    const content = (campaign.content as Record<string, unknown>) ?? {};
    return prisma.campaign.update({
      where: { id },
      data: {
        ...(dto.name ? { name: dto.name } : {}),
        ...(dto.subject !== undefined ? { subject: dto.subject } : {}),
        ...(dto.body !== undefined ? { content: { ...content, body: dto.body } } : {}),
      },
      select: campaignSelect,
    });
  },

  /** Preview the reachable, opted-in audience size without sending. */
  async audience(type: 'EMAIL' | 'SMS' | 'WHATSAPP') {
    const channel = channelFor(type);
    const [customers, account] = await Promise.all([
      this.reachableCustomers(channel),
      prisma.channelAccount.findFirst({
        where: { channelType: channel, isActive: true, deletedAt: null },
        select: { id: true, name: true },
      }),
    ]);
    const ent = await resolveEntitlements(orgId());
    const plan = await prisma.plan.findUnique({ where: { id: ent.planId }, select: { maxMarketingReach: true } });
    const limit = plan?.maxMarketingReach ?? null;
    const reachable = limit === null ? customers.length : Math.min(customers.length, limit);
    const creditQuote = await smsWalletService.quote(
      orgId(),
      channel as 'SMS' | 'EMAIL' | 'WHATSAPP',
      reachable,
    );
    return {
      channel,
      count: customers.length,
      reachable,
      limit,
      channelConfigured: Boolean(account),
      channelAccount: account,
      creditQuote,
      sample: customers.slice(0, 5).map((c) => c.firstName),
    };
  },

  async reachableCustomers(channel: ChannelType, recipientIds?: string[]) {
    // Marketing consent is mandatory — never message customers who opted out.
    const base = { deletedAt: null, isProvisional: false, isBlocked: false, marketingOptIn: true };
    if (channel === 'EMAIL') {
      return prisma.customer.findMany({
        where: {
          ...base,
          email: { not: null },
          ...(recipientIds ? { id: { in: recipientIds } } : {}),
        },
        select: { id: true, firstName: true },
        take: MAX_RECIPIENTS,
      });
    }
    return prisma.customer.findMany({
      where: {
        ...base,
        identities: { some: { channelType: channel } },
        ...(recipientIds ? { id: { in: recipientIds } } : {}),
      },
      select: { id: true, firstName: true },
      take: MAX_RECIPIENTS,
    });
  },

  /**
   * Kick off a send. With a queue configured, the delivery loop runs in the
   * worker and this returns immediately with status SENDING; otherwise it runs
   * inline and returns SENT.
   */
  async send(id: string) {
    const campaign = await prisma.campaign.findFirst({ where: { id, deletedAt: null } });
    if (!campaign) throw new NotFoundError('Campaign');
    if (!['DRAFT', 'SCHEDULED'].includes(campaign.status)) {
      throw new ConflictError('Campaign has already been sent');
    }
    const channel = channelFor(campaign.type);
    const content = (campaign.content as { audience?: string; recipientIds?: string[] }) ?? {};
    const selectedIds = content.audience === 'SELECTED' ? content.recipientIds ?? [] : undefined;
    const [customers, ent, account] = await Promise.all([
      this.reachableCustomers(channel, selectedIds),
      resolveEntitlements(orgId()),
      prisma.channelAccount.findFirst({
        where: { channelType: channel, isActive: true, deletedAt: null },
        select: { id: true, name: true },
      }),
    ]);
    if (!account) {
      throw new AppError(
        'CHANNEL_NOT_CONFIGURED',
        400,
        `Connect an active ${campaign.type} channel in Settings → Channels before sending this campaign.`,
      );
    }
    const plan = await prisma.plan.findUnique({ where: { id: ent.planId }, select: { maxMarketingReach: true } });
    if (plan?.maxMarketingReach !== null && plan?.maxMarketingReach !== undefined && customers.length > plan.maxMarketingReach) {
      throw new AppError(
        'MARKETING_REACH_LIMIT',
        402,
        `This campaign reaches ${customers.length.toLocaleString()} contacts, above your plan limit of ${plan.maxMarketingReach.toLocaleString()}. Upgrade your plan or narrow the audience.`,
        { audience: customers.length, limit: plan.maxMarketingReach },
      );
    }
    const paidChannel = channel as 'SMS' | 'EMAIL' | 'WHATSAPP';
    const quote = await smsWalletService.quote(orgId(), paidChannel, customers.length);
    if (!quote.enabled) {
      throw new AppError(
        'CHANNEL_DELIVERY_DISABLED',
        403,
        `${campaign.type} campaign delivery is disabled by the platform administrator.`,
      );
    }
    if (!quote.affordable) {
      throw new AppError(
        'INSUFFICIENT_MESSAGE_CREDITS',
        402,
        `This campaign needs ${quote.totalCost.toFixed(2)} ${quote.currency} in messaging credits, but your balance is ${quote.balance.toFixed(2)} ${quote.currency}.`,
        quote,
      );
    }
    const updated = await prisma.campaign.update({
      where: { id },
      data: { status: 'SENDING', startedAt: new Date() },
      select: campaignSelect,
    });

    const ctx = requestContext.get();
    const queued = await enqueue('campaign', 'send', {
      campaignId: id,
      ctx: { organizationId: ctx?.organizationId, userId: ctx?.userId },
    });
    if (queued) return updated;
    return this.sendNow(id);
  },

  /** The delivery loop — runs inline or in the worker. */
  async sendNow(id: string) {
    const campaign = await prisma.campaign.findFirst({ where: { id, deletedAt: null } });
    if (!campaign) throw new NotFoundError('Campaign');
    const channel = channelFor(campaign.type);
    const content = (campaign.content as {
      body?: string;
      imageUrl?: string;
      templateName?: string;
      templateLanguage?: string;
      audience?: string;
      recipientIds?: string[];
    }) ?? {};
    const body = content.body ?? '';
    const imageUrl = content.imageUrl ?? '';

    const selectedIds = content.audience === 'SELECTED' ? content.recipientIds ?? [] : undefined;
    const customers = await this.reachableCustomers(channel, selectedIds);
    let sent = 0;
    let failed = 0;
    for (const c of customers) {
      // Attach the image by including its URL (email/WhatsApp preview it; SMS links it).
      const text = renderTemplate(body, { firstName: c.firstName }) + (imageUrl ? `\n\n${imageUrl}` : '');
      const outcome = await messagingService.sendToCustomer(c.id, channel, text, {
        campaignId: id,
        subject: campaign.subject ?? undefined,
        templateName: content.templateName,
        templateLanguage: content.templateLanguage,
      });
      await prisma.campaignRecipient.upsert({
        where: { campaignId_customerId: { campaignId: id, customerId: c.id } },
        create: {
          campaignId: id,
          customerId: c.id,
          status: outcome.ok ? 'SENT' : 'FAILED',
          sentAt: outcome.ok ? new Date() : null,
          error: outcome.error ?? null,
        },
        update: {
          status: outcome.ok ? 'SENT' : 'FAILED',
          sentAt: outcome.ok ? new Date() : null,
          error: outcome.error ?? null,
        },
      });
      if (outcome.ok) {
        sent += 1;
        await activityService.record({
          type: campaign.type === 'EMAIL' ? 'EMAIL' : campaign.type === 'SMS' ? 'SMS' : 'WHATSAPP',
          entityType: 'CUSTOMER',
          entityId: c.id,
          title: `Campaign sent — ${campaign.name}`,
        });
      } else {
        failed += 1;
      }
    }

    const stats = { total: customers.length, sent, failed };
    if (sent > 0) {
      const ent = await resolveEntitlements(orgId());
      await usageService.increment(USAGE_METRICS.MARKETING_RECIPIENT, {
        organizationId: orgId(),
        periodStart: ent.periodStart,
        periodEnd: ent.periodEnd,
      }, sent);
    }
    return prisma.campaign.update({
      where: { id },
      data: { status: 'SENT', completedAt: new Date(), stats },
      select: campaignSelect,
    });
  },
};
