import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission, requireSuperAdmin } from '../middleware/require-permission';
import { prisma, prismaUnscoped } from '../../../infrastructure/database/prisma';
import {
  senderIdSchema,
  senderIdService,
} from '../../../application/sms/sender-id.service';
import { smsSendService, SUPPORTED_VARIABLES } from '../../../application/sms/sms-send.service';
import { smsWalletService } from '../../../application/billing/sms-wallet.service';
import { smsProvider } from '../../../infrastructure/sms/registry';
import { isChannelEnabled } from '../../../application/settings/workspace-config';
import { transactionalSmsService } from '../../../application/sms/transactional-sms.service';
import { ForbiddenError } from '../../../shared/errors';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

export const smsRoutes = Router();
smsRoutes.use(authenticate, requireTenant);

/**
 * SMS switched off means the whole module is closed, not just sending.
 *
 * Gating only the send path left everything else answering normally: a
 * business with SMS disabled could still request Sender IDs, read message
 * history, price a campaign and edit notification settings. That is a feature
 * that looks available right up to the moment it refuses, which is worse than
 * one plainly absent.
 *
 * `/status` is the deliberate exception. It is how the app finds out SMS is
 * unavailable, so refusing it would leave the page unable to explain itself.
 */
const requireSmsEnabled: RequestHandler = (req, _res, next) => {
  if (req.path === '/status' || isChannelEnabled('SMS')) {
    next();
    return;
  }
  next(new ForbiddenError('SMS is not available on this workspace.'));
};
smsRoutes.use(requireSmsEnabled);

// ── Sender IDs ─────────────────────────────────────────────────────────────

smsRoutes.get(
  '/sender-ids',
  requirePermission('marketing.read'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await senderIdService.list() });
  }),
);

smsRoutes.post(
  '/sender-ids',
  requirePermission('marketing.create', 'settings.manage_integrations'),
  validate({ body: senderIdSchema }),
  wrap(async (req, res) => {
    res.status(201).json({
      success: true,
      data: await senderIdService.request(req.auth!.organizationId!, req.body),
    });
  }),
);

smsRoutes.post(
  '/sender-ids/:id/submit',
  requirePermission('marketing.create', 'settings.manage_integrations'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await senderIdService.submit(req.params.id as string) });
  }),
);

// ── Composing ──────────────────────────────────────────────────────────────

const recipientSchema = z.object({
  phone: z.string().trim().min(3).max(30),
  customerId: z.string().optional(),
  variables: z.record(z.string(), z.string()).optional(),
});

const composeSchema = z.object({
  template: z.string().trim().min(1).max(1600),
  recipients: z.array(recipientSchema).min(1).max(10_000),
  senderIdId: z.string().optional(),
  campaignId: z.string().optional(),
});

/** What it will cost and reach — the confirmation step, charging nothing. */
smsRoutes.post(
  '/preview',
  requirePermission('marketing.read'),
  validate({ body: composeSchema }),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await smsSendService.preview({
        organizationId: req.auth!.organizationId!,
        route: 'PROMOTIONAL',
        ...req.body,
      }),
    });
  }),
);

/**
 * Send now.
 *
 * `marketing.send` specifically: reading a customer list and spending a
 * business's credit on it are different levels of trust.
 */
smsRoutes.post(
  '/send',
  requirePermission('marketing.send'),
  validate({ body: composeSchema }),
  wrap(async (req, res) => {
    const outcome = await smsSendService.send({
      organizationId: req.auth!.organizationId!,
      route: 'PROMOTIONAL',
      ...req.body,
    });
    res.status(201).json({
      success: true,
      message: `${outcome.queued} message${outcome.queued === 1 ? '' : 's'} sent.`,
      data: outcome,
    });
  }),
);

/** The variables a composer may offer, so the UI does not hard-code them. */
smsRoutes.get(
  '/variables',
  requirePermission('marketing.read'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: { variables: SUPPORTED_VARIABLES } });
  }),
);

// ── History and analytics ──────────────────────────────────────────────────

smsRoutes.get(
  '/messages',
  requirePermission('marketing.read'),
  validate({
    query: z.object({
      campaignId: z.string().optional(),
      status: z.enum(['QUEUED', 'SENT', 'DELIVERED', 'FAILED', 'REJECTED', 'EXPIRED']).optional(),
      route: z.enum(['TRANSACTIONAL', 'PROMOTIONAL']).optional(),
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      cursor: z.string().optional(),
    }),
  }),
  wrap(async (req, res) => {
    const q = req.query as never as {
      campaignId?: string; status?: string; route?: string;
      from?: Date; to?: Date; limit: number; cursor?: string;
    };
    const rows = await prisma.smsMessage.findMany({
      where: {
        ...(q.campaignId ? { campaignId: q.campaignId } : {}),
        ...(q.status ? { status: q.status as never } : {}),
        ...(q.route ? { route: q.route as never } : {}),
        ...(q.from || q.to
          ? { queuedAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } }
          : {}),
      },
      select: {
        id: true, recipient: true, body: true, status: true, route: true,
        segments: true, cost: true, senderValue: true, eventType: true,
        failureReason: true, queuedAt: true, sentAt: true, deliveredAt: true,
        campaignId: true,
      },
      orderBy: { queuedAt: 'desc' },
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > q.limit;
    const items = hasMore ? rows.slice(0, q.limit) : rows;
    res.json({
      success: true,
      data: {
        // The provider's own failure wording never leaves the server.
        items: items.map(({ failureReason, ...rest }) => ({
          ...rest,
          cost: Number(rest.cost),
          failed: Boolean(failureReason),
        })),
        nextCursor: hasMore ? items[items.length - 1]?.id ?? null : null,
      },
    });
  }),
);

/** Totals for the reporting screen. */
smsRoutes.get(
  '/analytics',
  requirePermission('marketing.read'),
  validate({
    query: z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() }),
  }),
  wrap(async (req, res) => {
    const q = req.query as never as { from?: Date; to?: Date };
    const window = q.from || q.to
      ? { queuedAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } }
      : {};

    const [byStatus, byRoute, totals] = await Promise.all([
      prisma.smsMessage.groupBy({ by: ['status'], where: window, _count: true }),
      prisma.smsMessage.groupBy({
        by: ['route'], where: window, _count: true, _sum: { segments: true, cost: true },
      }),
      prisma.smsMessage.aggregate({ where: window, _sum: { segments: true, cost: true }, _count: true }),
    ]);

    const counts = Object.fromEntries(byStatus.map((r) => [r.status, r._count]));
    const sent = totals._count;
    const delivered = counts.DELIVERED ?? 0;
    const failed = (counts.FAILED ?? 0) + (counts.REJECTED ?? 0) + (counts.EXPIRED ?? 0);
    /*
     * Measured only over messages that have finished.
     *
     * A message sent thirty seconds ago has not failed — its receipt simply
     * has not arrived. Counting it against the rate showed "0% delivered"
     * moments after a successful send, which reads as total failure.
     */
    const settled = delivered + failed;

    res.json({
      success: true,
      data: {
        totalMessages: sent,
        delivered,
        failed,
        // Everything still waiting on the network to report back.
        pending: sent - settled,
        deliveryRate: settled > 0 ? Math.round((delivered / settled) * 1000) / 10 : null,
        totalSegments: totals._sum.segments ?? 0,
        totalSpent: Number(totals._sum.cost ?? 0),
        byRoute: byRoute.map((r) => ({
          route: r.route,
          messages: r._count,
          segments: r._sum.segments ?? 0,
          spent: Number(r._sum.cost ?? 0),
        })),
        byStatus: counts,
      },
    });
  }),
);

// ── Opt-outs ───────────────────────────────────────────────────────────────

smsRoutes.get(
  '/suppressions',
  requirePermission('marketing.read'),
  wrap(async (req, res) => {
    const rows = await prismaUnscoped.smsSuppression.findMany({
      where: { organizationId: req.auth!.organizationId! },
      select: { id: true, phone: true, reason: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    res.json({ success: true, data: rows });
  }),
);

smsRoutes.post(
  '/suppressions',
  requirePermission('marketing.update'),
  validate({ body: z.object({ phone: z.string().trim().min(3).max(30), reason: z.string().trim().max(200).optional() }) }),
  wrap(async (req, res) => {
    await smsSendService.suppress(
      req.auth!.organizationId!,
      req.body.phone,
      req.body.reason ?? 'Added by the business',
    );
    res.status(201).json({ success: true, message: 'That number will no longer receive marketing SMS.' });
  }),
);

// ── Transactional notifications ────────────────────────────────────────────

smsRoutes.get(
  '/transactional',
  requirePermission('marketing.read', 'settings.manage_org'),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await transactionalSmsService.list(req.auth!.organizationId!),
    });
  }),
);

smsRoutes.patch(
  '/transactional/:eventId',
  requirePermission('marketing.update', 'settings.manage_org'),
  validate({
    body: z.object({
      enabled: z.boolean().optional(),
      template: z.string().trim().max(1600).optional(),
    }),
  }),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await transactionalSmsService.update(
        req.auth!.organizationId!,
        req.params.eventId as never,
        req.body,
      ),
    });
  }),
);

// ── Wallet ─────────────────────────────────────────────────────────────────

smsRoutes.get(
  '/wallet',
  requirePermission('marketing.read', 'billing.view'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await smsWalletService.summary() });
  }),
);

/**
 * Whether SMS is usable at all, and what is missing if not.
 *
 * Deliberately says nothing about which provider Vhicasar uses or how it is
 * configured — a business should never need to know.
 */
smsRoutes.get(
  '/status',
  requirePermission('marketing.read'),
  wrap(async (_req, res) => {
    const approved = await prisma.senderId.count({ where: { status: 'APPROVED', deletedAt: null } });
    const pending = await prisma.senderId.count({ where: { status: 'PENDING', deletedAt: null } });

    /*
     * Two separate gates, and both have to be open.
     *
     * The provider being configured is a deployment fact; whether SMS is
     * offered to this business at all is the platform administrator's
     * decision, taken in the workspace config. Reporting only the first meant
     * switching SMS off in admin changed nothing the business could see.
     */
    // The master switch for SMS as a means of communication — not the inbox
    // channel policy, which governs connecting a number people text in to.
    const offered = isChannelEnabled('SMS');
    const providerReady = smsProvider().isConfigured();

    res.json({
      success: true,
      data: {
        available: offered && providerReady,
        // Named so the UI can say "not part of your plan" rather than implying
        // something is broken.
        offered,
        hasApprovedSenderId: approved > 0,
        pendingSenderIds: pending,
        state: !offered
          ? 'UNAVAILABLE'
          : approved > 0
            ? 'ACTIVE'
            : pending > 0
              ? 'PENDING_SENDER_ID'
              : 'NOT_CONNECTED',
      },
    });
  }),
);

// ── Platform administration ────────────────────────────────────────────────

export const smsAdminRoutes = Router();
smsAdminRoutes.use(authenticate, requireSuperAdmin);

/** Every Sender ID waiting on a decision, across all businesses. */
smsAdminRoutes.get(
  '/sender-ids/pending',
  wrap(async (_req, res) => {
    res.json({ success: true, data: await senderIdService.pendingQueue() });
  }),
);

smsAdminRoutes.post(
  '/sender-ids/:id/decide',
  validate({
    body: z.object({
      decision: z.enum(['APPROVED', 'REJECTED', 'SUSPENDED']),
      note: z.string().trim().max(500).optional(),
      providerRef: z.string().trim().max(120).optional(),
    }),
  }),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await senderIdService.decide(req.params.id as string, req.body.decision, {
        note: req.body.note,
        providerRef: req.body.providerRef,
        decidedById: req.auth!.membershipId ?? undefined,
      }),
    });
  }),
);
