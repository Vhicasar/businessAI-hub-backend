import { Router } from 'express';
import type { ChannelType } from '@prisma/client';
import { randomUUID } from 'crypto';
import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { logger } from '../../shared/logger';
import { getAdapter } from '../../infrastructure/channels/registry';
import { inboxService } from '../../application/inbox/inbox.service';
import { decrypt } from '../../shared/crypto';
import { markWebhookReceived } from '../../application/inbox/channel-health.service';
import { env } from '../../shared/config/env';

/**
 * Stable Meta receivers live at /whatsapp, /messenger and /instagram.
 * The legacy two-segment receiver remains for non-Meta adapters.
 *
 * No auth middleware — verification is per-adapter (signatures/secrets).
 * Always answers 200 quickly (providers retry on non-2xx; processing errors
 * are logged, not surfaced). Tenant context is bound from the channel account
 * so all downstream queries are auto-scoped.
 */
export const webhookRoutes = Router();

const META_ROUTES = {
  whatsapp: 'WHATSAPP', messenger: 'FACEBOOK_MESSENGER', instagram: 'INSTAGRAM',
} as const satisfies Record<string, ChannelType>;

export function stableMetaWebhookPath(channelType: ChannelType): string | null {
  return channelType === 'WHATSAPP' ? '/api/webhooks/whatsapp'
    : channelType === 'FACEBOOK_MESSENGER' ? '/api/webhooks/messenger'
      : channelType === 'INSTAGRAM' ? '/api/webhooks/instagram' : null;
}

export function extractMetaRoutingIds(channelType: ChannelType, entry: Record<string, unknown>) {
  const entryId = typeof entry.id === 'string' && entry.id.trim() ? entry.id : null;
  const phoneNumberId = channelType === 'WHATSAPP'
    ? ((entry.changes as Array<{ value?: { metadata?: { phone_number_id?: string } } }> | undefined)?.[0]?.value?.metadata?.phone_number_id ?? null)
    : null;
  return { entryId, phoneNumberId };
}

export function verifyMetaChallenge(query: Record<string, unknown>, expectedToken: string): string | null {
  return query['hub.mode'] === 'subscribe'
    && typeof query['hub.challenge'] === 'string'
    && Boolean(expectedToken)
    && query['hub.verify_token'] === expectedToken
    ? query['hub.challenge']
    : null;
}

type WebhookAccount = Awaited<ReturnType<typeof prismaUnscoped.channelAccount.findFirst>>;

async function processForAccount(account: NonNullable<WebhookAccount>, body: unknown, headers: Record<string, string | string[] | undefined>, query: Record<string, unknown>, rawBody?: Buffer) {
  const channelType = account.channelType;
  const adapter = getAdapter(channelType);
  const verified = adapter.verifyWebhook(
    { headers, body, query, rawBody },
    {
      id: account.id, organizationId: account.organizationId, externalId: account.externalId,
      credentials: account.credentialsEnc ? JSON.parse(decrypt(account.credentialsEnc)) as Record<string, string> : {},
      webhookSecret: account.webhookSecret,
    },
  );
  if (!verified) {
    logger.warn({ channelType }, 'Webhook signature verification failed');
    return;
  }
  await markWebhookReceived(account.id);
  const messages = adapter.parseInbound(body);
  const statuses = adapter.parseStatuses?.(body) ?? [];
  await requestContext.run(
    { requestId: randomUUID(), organizationId: account.organizationId },
    async () => {
      for (const inbound of messages) {
        await inboxService.processInbound({ id: account.id, organizationId: account.organizationId, channelType }, inbound);
      }
      for (const update of statuses) {
        await inboxService.applyStatus({ id: account.id, organizationId: account.organizationId }, update)
          .catch((err) => logger.warn({ err, providerMessageId: update.providerMessageId }, 'Delivery receipt could not be applied'));
      }
    },
  );
}

/** Application-level Meta verification: one callback per product, never per tenant. */
webhookRoutes.get('/:meta(whatsapp|messenger|instagram)', (req, res) => {
  const challenge = verifyMetaChallenge(req.query as Record<string, unknown>, env.meta.webhookVerifyToken);
  if (!challenge) {
    logger.warn({ metaChannel: req.params.meta }, 'Meta webhook verification token mismatch');
    return void res.sendStatus(403);
  }
  res.status(200).send(challenge);
});

webhookRoutes.post('/:meta(whatsapp|messenger|instagram)', (req, res) => {
  const meta = req.params.meta as keyof typeof META_ROUTES;
  const channelType = META_ROUTES[meta];
  const body = req.body as { entry?: Array<Record<string, unknown>> };
  const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
  if (!body || !Array.isArray(body.entry)) {
    res.sendStatus(400);
    return;
  }
  res.status(200).json({ ok: true });

  void (async () => {
    for (const entry of body.entry ?? []) {
      const { entryId, phoneNumberId } = extractMetaRoutingIds(channelType, entry);
      if (!entryId && !phoneNumberId) {
        logger.warn({ channelType }, 'Meta webhook entry has no routing identifier');
        continue;
      }
      const account = await prismaUnscoped.channelAccount.findFirst({
        where: {
          channelType, isActive: true, status: 'CONNECTED', deletedAt: null,
          ...(channelType === 'WHATSAPP'
            ? { OR: [{ metaPhoneNumberId: phoneNumberId ?? undefined }, { metaWabaId: entryId ?? undefined }] }
            : channelType === 'FACEBOOK_MESSENGER'
              ? { metaFacebookPageId: entryId ?? undefined }
              : { metaInstagramAccountId: entryId ?? undefined }),
        },
      });
      if (!account) {
        logger.warn({ channelType, providerIdentifierPresent: Boolean(entryId || phoneNumberId) }, 'Meta webhook for unknown or disconnected account');
        continue;
      }
      const singleBody = { ...(body as Record<string, unknown>), entry: [entry] };
      // Signature verification occurs inside processForAccount using this
      // connection's encrypted app secret. A platform-wide check here used to
      // reject customer-owned WhatsApp apps before their account could even be
      // identified; Page/Instagram platform apps happened to pass it.
      await processForAccount(account, singleBody, req.headers, req.query as Record<string, unknown>, rawBody);
    }
  })().catch((err) => logger.error({ err, channelType }, 'Meta webhook processing failed'));
});

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

      // Proof the connection works — and it clears any stale error, so a
      // channel that has recovered stops showing last week's failure.
      await markWebhookReceived(account.id);

      const messages = adapter.parseInbound(req.body);
      // One delivery can carry both new messages and receipts for old ones.
      const statuses = adapter.parseStatuses?.(req.body) ?? [];
      if (messages.length === 0 && statuses.length === 0) return;

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
          for (const update of statuses) {
            // One bad receipt must not discard the rest of the delivery, and
            // the provider will not resend: it already had its 200.
            await inboxService
              .applyStatus({ id: account.id, organizationId: account.organizationId }, update)
              .catch((err) =>
                logger.warn(
                  { err, providerMessageId: update.providerMessageId },
                  'Delivery receipt could not be applied'
                )
              );
          }
        }
      );
    } catch (e) {
      logger.error({ err: e, path: req.path }, 'Webhook processing failed');
    }
  })();
});
