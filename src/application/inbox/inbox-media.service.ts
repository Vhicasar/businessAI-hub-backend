import { prisma } from '../../infrastructure/database/prisma';
import { filesService } from '../files/files.service';
import { getAdapter } from '../../infrastructure/channels/registry';
import { decrypt } from '../../shared/crypto';
import { logger } from '../../shared/logger';
import type { InboundMedia } from './channel-adapter';
import type { ChannelType } from '@prisma/client';

/**
 * Copying an inbound attachment into Vhicasar's own storage.
 *
 * Provider media links are temporary. Meta's CDN URLs expire within minutes
 * and WhatsApp does not hand over a link at all — only an id that has to be
 * exchanged for one using the account's token. Keeping either in the database
 * would mean an inbox where every photo older than an afternoon is a broken
 * image, and where a customer's proof-of-payment screenshot is gone by the
 * time anyone looks for it.
 *
 * So the bytes are fetched once, while the reference is still good, and stored
 * as an ordinary Vhicasar File — the same storage every other upload uses.
 *
 * Failure here is never fatal. A message whose photo could not be fetched is
 * still a message the customer sent, and losing the text as well because a CDN
 * was slow would be the worse outcome.
 */

/** Anything larger is left with the provider rather than pulled into storage. */
const MAX_BYTES = 25 * 1024 * 1024;

export function isHtmlResponseMimeType(value: string): boolean {
  const mimeType = value.split(';')[0]?.trim().toLowerCase();
  return mimeType === 'text/html' || mimeType === 'application/xhtml+xml';
}

export async function ingestInboundMedia(input: {
  messageId: string;
  organizationId: string;
  channelType: ChannelType;
  accountId: string;
  media: InboundMedia;
  caption?: string | null;
}): Promise<string | null> {
  const { media, channelType } = input;
  if (!media.externalId && !media.url) return null;

  try {
    const adapter = getAdapter(channelType);
    if (!adapter.downloadMedia) return null;

    const account = await prisma.channelAccount.findFirst({
      where: { id: input.accountId },
      select: { id: true, organizationId: true, externalId: true, credentialsEnc: true, webhookSecret: true },
    });
    if (!account) return null;

    const downloaded = await adapter.downloadMedia(media, {
      id: account.id,
      organizationId: account.organizationId,
      externalId: account.externalId,
      credentials: account.credentialsEnc
        ? (JSON.parse(decrypt(account.credentialsEnc)) as Record<string, string>)
        : {},
      webhookSecret: account.webhookSecret,
    });
    if (!downloaded) return null;

    const failureReason = downloaded.failureReason ?? (isHtmlResponseMimeType(downloaded.mimeType) ? 'unexpected_html_response' : undefined);
    if (failureReason) {
      let sourceHost: string | undefined;
      try { sourceHost = media.url ? new URL(media.url).hostname : undefined; } catch { /* never log an unsafe URL */ }
      if (failureReason === 'unexpected_html_response') {
        logger.warn(
          {
            event: 'html_response_detected', action: 'classified_as_failed_media_download',
            messageId: input.messageId, channelType, sourceHost,
          },
          'Claimed inbound media returned HTML and was not stored'
        );
      }
      const current = await prisma.message.findUnique({
        where: { id: input.messageId }, select: { providerMetadata: true },
      }).catch(() => null);
      const existingMetadata = current?.providerMetadata && typeof current.providerMetadata === 'object' && !Array.isArray(current.providerMetadata)
        ? current.providerMetadata as Record<string, unknown> : {};
      await prisma.message.update({
        where: { id: input.messageId },
        data: { providerMetadata: { ...existingMetadata, mediaResolution: { status: 'FAILED', reason: failureReason } } },
      }).catch(() => undefined);
      logger.warn(
        { event: 'external_media_download_failed', messageId: input.messageId, channelType, reason: failureReason, sourceHost },
        'Inbound media download did not return binary media'
      );
      return null;
    }

    if (downloaded.buffer.length > MAX_BYTES) {
      logger.warn(
        { messageId: input.messageId, bytes: downloaded.buffer.length },
        'Inbound attachment too large to store'
      );
      return null;
    }

    const file = await filesService.upload(
      {
        buffer: downloaded.buffer,
        originalname: downloaded.filename,
        mimetype: downloaded.mimeType,
        size: downloaded.buffer.length,
      },
      {
        organizationId: input.organizationId,
        // Nobody on staff uploaded this — the customer sent it.
        uploadedById: null,
        entity: 'inbox',
        // Customer attachments are not public: they reach the agent through
        // the app, which already knows who may read this conversation.
        isPublic: false,
        // Provider messages can contain a narrowly allow-listed set of images,
        // documents, audio and video. This is deliberately separate from
        // ordinary user uploads so enabling reels does not broaden every route.
        allow: 'inbox-media',
      }
    );

    const fileId = file.id;
    await prisma.messageAttachment.create({
      data: {
        messageId: input.messageId,
        fileId,
        caption: input.caption?.trim() || null,
      },
    });
    return fileId;
  } catch (err) {
    logger.warn(
      { err, messageId: input.messageId, channelType },
      'Inbound attachment could not be stored; the message itself is kept'
    );
    return null;
  }
}
