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
        // Customers send documents and voice notes, not only pictures.
        allow: 'any',
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
