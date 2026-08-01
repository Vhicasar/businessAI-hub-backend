import { Router, type Request, type RequestHandler, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { prismaUnscoped, prisma } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { inboxService } from '../../application/inbox/inbox.service';
import { getProductBranding } from '../../application/catalog/site-catalog.service';
import { appointmentsEnabled } from '../../application/appointments/appointments.service';
import { resolveEntitlements } from '../../application/billing/entitlements';
import { filesService } from '../../application/files/files.service';
import { env } from '../../shared/config/env';
import { validate } from './middleware/validate';

/**
 * Public visitor API for the website live-chat widget.
 * Auth model: possession of the (unguessable) visitorId returned by /session.
 * Visitors poll for replies — no socket auth needed on the public side.
 */
export const webchatRoutes = Router();

const webchatLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Slow down a little' } },
});
webchatRoutes.use(webchatLimiter);

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

async function activeAccount(accountId: string) {
  return prismaUnscoped.channelAccount.findFirst({
    where: { id: accountId, channelType: 'WEB_CHAT', isActive: true, deletedAt: null },
  });
}

/**
 * Public widget config — lets the embed auto-inherit the business's branding
 * (theme colour, name, logo, greeting) instead of hard-coding data-color. The
 * embedder can still override via data-* attributes. No visitor identity needed.
 */
webchatRoutes.get(
  '/:accountId/config',
  wrap(async (req, res) => {
    const account = await activeAccount(req.params.accountId as string);
    if (!account) {
      res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Chat unavailable' } });
      return;
    }
    const [platformBranding, organization, entitlements] = await Promise.all([
      getProductBranding(),
      prismaUnscoped.organization.findUnique({
        where: { id: account.organizationId },
        select: { name: true, logoFileId: true },
      }),
      resolveEntitlements(account.organizationId),
    ]);
    const logoUrl = organization?.logoFileId
      ? await requestContext.run(
          { requestId: randomUUID(), organizationId: account.organizationId },
          () => filesService.urlFor(organization.logoFileId),
        )
      : null;
    const meta = (account.metadata as Record<string, unknown> | null) ?? {};
    const businessName = organization?.name || 'Our team';
    res.json({
      success: true,
      data: {
        color: (typeof meta.widgetColor === 'string' && meta.widgetColor) || platformBranding.themeColor,
        businessName,
        logoUrl,
        title: (typeof meta.widgetTitle === 'string' && meta.widgetTitle) || `Chat with ${businessName}`,
        greeting:
          (typeof meta.widgetGreeting === 'string' && meta.widgetGreeting) ||
          'Hi there 👋 How can we help you today?',
        showPoweredBy: !entitlements.features.has('white_label'),
        poweredBy: {
          name: 'Vhicasar Hub AI',
          logoUrl: null,
          url: env.WEB_APP_URL,
        },
        // Lets the widget show a "Book appointment" action when enabled (#12).
        appointmentsEnabled: await appointmentsEnabled(account.organizationId),
      },
    });
  })
);

const sessionSchema = z.object({
  name: z.string().trim().max(80).optional(),
  email: z.string().trim().toLowerCase().email().max(320).optional(),
});

webchatRoutes.post(
  '/:accountId/session',
  validate({ body: sessionSchema }),
  wrap(async (req, res) => {
    const account = await activeAccount(req.params.accountId as string);
    if (!account) {
      res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Chat unavailable' } });
      return;
    }
    const visitorId = `v_${randomUUID().replace(/-/g, '')}`;

    await requestContext.run(
      { requestId: randomUUID(), organizationId: account.organizationId },
      async () => {
        await inboxService.processInbound(
          { id: account.id, organizationId: account.organizationId, channelType: 'WEB_CHAT' },
          {
            providerMessageId: `wc_${randomUUID()}`,
            senderExternalId: visitorId,
            senderDisplayName: req.body.name || 'Website visitor',
            contentType: 'SYSTEM',
            text: `Chat started${req.body.email ? ` · ${req.body.email}` : ''}`,
          }
        );
        // Attach the email to the auto-created customer when provided.
        if (req.body.email) {
          const identity = await prisma.customerIdentity.findFirst({
            where: { channelType: 'WEB_CHAT', externalId: visitorId },
          });
          if (identity) {
            await prisma.customer
              .update({ where: { id: identity.customerId }, data: { email: req.body.email, isProvisional: false } })
              .catch(() => undefined); // duplicate email — keep identity link only
          }
        }
      }
    );
    res.status(201).json({ success: true, data: { visitorId } });
  })
);

const messageSchema = z.object({
  visitorId: z.string().min(10).max(64),
  text: z.string().trim().min(1).max(2000),
});

webchatRoutes.post(
  '/:accountId/messages',
  validate({ body: messageSchema }),
  wrap(async (req, res) => {
    const account = await activeAccount(req.params.accountId as string);
    if (!account) {
      res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Chat unavailable' } });
      return;
    }
    await requestContext.run(
      { requestId: randomUUID(), organizationId: account.organizationId },
      () =>
        inboxService.processInbound(
          { id: account.id, organizationId: account.organizationId, channelType: 'WEB_CHAT' },
          {
            providerMessageId: `wc_${randomUUID()}`,
            senderExternalId: req.body.visitorId,
            contentType: 'TEXT',
            text: req.body.text,
          }
        )
    );
    res.status(201).json({ success: true, data: { ok: true } });
  })
);

webchatRoutes.get(
  '/:accountId/messages',
  wrap(async (req, res) => {
    const account = await activeAccount(req.params.accountId as string);
    const visitorId = String(req.query.visitorId ?? '');
    if (!account || !visitorId) {
      res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Chat unavailable' } });
      return;
    }
    const identity = await prismaUnscoped.customerIdentity.findFirst({
      where: {
        organizationId: account.organizationId,
        channelType: 'WEB_CHAT',
        externalId: visitorId,
      },
    });
    if (!identity) {
      res.json({ success: true, data: { messages: [] } });
      return;
    }
    const conversation = await prismaUnscoped.conversation.findFirst({
      where: { channelAccountId: account.id, customerId: identity.customerId },
      orderBy: { createdAt: 'desc' },
    });
    if (!conversation) {
      res.json({ success: true, data: { messages: [] } });
      return;
    }
    const after = typeof req.query.after === 'string' ? req.query.after : undefined;
    const messages = await prismaUnscoped.message.findMany({
      where: {
        conversationId: conversation.id,
        contentType: { not: 'SYSTEM' },
        ...(after ? { createdAt: { gt: new Date(after) } } : {}),
      },
      orderBy: { createdAt: 'asc' },
      take: 100,
      select: { id: true, direction: true, body: true, createdAt: true },
    });
    res.json({ success: true, data: { messages } });
  })
);
