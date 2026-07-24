import { Router } from 'express';
import type { ChannelType } from '@prisma/client';
import { randomUUID } from 'crypto';
import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { logger } from '../../shared/logger';
import { getAdapter } from '../../infrastructure/channels/registry';
import { inboxService } from '../../application/inbox/inbox.service';
import { decrypt } from '../../shared/crypto';

/**
 * Public webhook receivers: /api/webhooks/:channel/:accountId
 *
 * No auth middleware — verification is per-adapter (signatures/secrets).
 * Always answers 200 quickly (providers retry on non-2xx; processing errors
 * are logged, not surfaced). Tenant context is bound from the channel account
 * so all downstream queries are auto-scoped.
 */
export const webhookRoutes = Router();

/**
 * Meta (WhatsApp/Messenger/Instagram) webhook subscription handshake:
 * echoes hub.challenge when hub.verify_token matches the account secret.
 */
webhookRoutes.get('/:channel/:accountId', (req, res) => {
  void (async () => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode !== 'subscribe' || typeof challenge !== 'string') {
      res.sendStatus(400);
      return;
    }
    const account = await prismaUnscoped.channelAccount.findFirst({
      where: { id: req.params.accountId, isActive: true, deletedAt: null },
      select: { webhookSecret: true },
    });
    if (account && token === account.webhookSecret) {
      res.status(200).send(challenge);
    } else {
      logger.warn({ accountId: req.params.accountId }, 'Webhook verification token mismatch');
      res.sendStatus(403);
    }
  })().catch(() => res.sendStatus(500));
});

webhookRoutes.post('/:channel/:accountId', (req, res) => {
  // Ack immediately; process async.
  res.status(200).json({ ok: true });

  void (async () => {
    try {
      const channelType = String(req.params.channel).toUpperCase() as ChannelType;
      const account = await prismaUnscoped.channelAccount.findFirst({
        where: {
          id: req.params.accountId,
          channelType,
          isActive: true,
          deletedAt: null,
        },
      });
      if (!account) {
        logger.warn({ accountId: req.params.accountId }, 'Webhook for unknown channel account');
        return;
      }

      const adapter = getAdapter(channelType);
      const verified = adapter.verifyWebhook(
        {
          headers: req.headers,
          body: req.body,
          query: req.query as Record<string, unknown>,
          rawBody: (req as unknown as { rawBody?: Buffer }).rawBody,
        },
        {
          id: account.id,
          organizationId: account.organizationId,
          externalId: account.externalId,
          credentials: account.credentialsEnc
            ? (JSON.parse(decrypt(account.credentialsEnc)) as Record<string, string>)
            : {},
          webhookSecret: account.webhookSecret,
        }
      );
      if (!verified) {
        logger.warn({ accountId: account.id, channelType }, 'Webhook signature verification failed');
        return;
      }

      const messages = adapter.parseInbound(req.body);
      if (messages.length === 0) return;

      // Bind tenant context so the inbox service is auto-scoped.
      await requestContext.run(
        { requestId: randomUUID(), organizationId: account.organizationId },
        async () => {
          for (const inbound of messages) {
            await inboxService.processInbound(
              { id: account.id, organizationId: account.organizationId, channelType },
              inbound
            );
          }
        }
      );
    } catch (e) {
      logger.error({ err: e, path: req.path }, 'Webhook processing failed');
    }
  })();
});
