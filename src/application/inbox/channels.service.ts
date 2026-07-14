import { z } from 'zod';
import { randomUUID } from 'crypto';
import { ConflictError, NotFoundError } from '../../shared/errors';
import { prisma } from '../../infrastructure/database/prisma';
import { encrypt } from '../../shared/crypto';
import { env } from '../../shared/config/env';
import { getAdapter, supportedChannels } from '../../infrastructure/channels/registry';

export const connectChannelSchema = z.object({
  channelType: z.enum([
    'TELEGRAM', 'WHATSAPP', 'FACEBOOK_MESSENGER', 'INSTAGRAM', 'WEB_CHAT', 'EMAIL',
  ]),
  name: z.string().trim().min(1).max(120),
  credentials: z.record(z.string()),
});

/** Stable provider-side account id per channel type. */
function deriveExternalId(dto: ConnectChannelDto): string {
  switch (dto.channelType) {
    case 'TELEGRAM':
      return (dto.credentials.botToken ?? '').split(':')[0] || randomUUID();
    case 'WHATSAPP':
      return dto.credentials.phoneNumberId || randomUUID();
    case 'FACEBOOK_MESSENGER':
    case 'INSTAGRAM':
      return dto.credentials.pageId || randomUUID();
    case 'EMAIL':
      return (dto.credentials.imapUser ?? '').toLowerCase() || randomUUID();
    case 'WEB_CHAT':
    default:
      return randomUUID();
  }
}

export type ConnectChannelDto = z.infer<typeof connectChannelSchema>;

const accountSelect = {
  id: true,
  channelType: true,
  name: true,
  externalId: true,
  isActive: true,
  metadata: true,
  createdAt: true,
} as const;

export const channelsService = {
  async list() {
    const accounts = await prisma.channelAccount.findMany({
      where: { deletedAt: null },
      select: accountSelect,
      orderBy: { createdAt: 'asc' },
    });
    return { accounts, supported: supportedChannels() };
  },

  async connect(organizationId: string, dto: ConnectChannelDto) {
    const adapter = getAdapter(dto.channelType);
    const webhookSecret = randomUUID().replace(/-/g, '');
    const externalId = deriveExternalId(dto);

    const dup = await prisma.channelAccount.findFirst({
      where: { channelType: dto.channelType, externalId, deletedAt: null },
    });
    if (dup) throw new ConflictError('This account is already connected');

    const account = await prisma.channelAccount.create({
      data: {
        channelType: dto.channelType,
        name: dto.name,
        externalId,
        credentialsEnc: encrypt(JSON.stringify(dto.credentials)),
        webhookSecret,
      },
    });

    const webhookUrl = `${env.API_BASE_URL}/api/webhooks/${dto.channelType.toLowerCase()}/${account.id}`;
    let setupNote: string | null = null;
    if (dto.channelType === 'WEB_CHAT') {
      setupNote =
        `Add this to your website before </body>:\n` +
        `<script src="${env.API_BASE_URL}/widget.js" data-account="${account.id}" ` +
        `data-color="#4f46e5" data-title="Chat with us"></script>`;
    } else if (adapter.onAccountConnected) {
      setupNote = await adapter.onAccountConnected(
        {
          id: account.id,
          organizationId,
          externalId,
          credentials: dto.credentials,
          webhookSecret,
        },
        webhookUrl
      );
    }

    return {
      account: {
        id: account.id,
        channelType: account.channelType,
        name: account.name,
        externalId: account.externalId,
        isActive: account.isActive,
        createdAt: account.createdAt,
      },
      webhookUrl,
      setupNote,
    };
  },

  async setAutoReply(accountId: string, enabled: boolean) {
    const account = await prisma.channelAccount.findFirst({
      where: { id: accountId, deletedAt: null },
    });
    if (!account) throw new NotFoundError('Channel account');
    const metadata = { ...((account.metadata as object) ?? {}), autoReply: enabled };
    return prisma.channelAccount.update({
      where: { id: accountId },
      data: { metadata },
      select: accountSelect,
    });
  },

  async disconnect(accountId: string) {
    const account = await prisma.channelAccount.findFirst({
      where: { id: accountId, deletedAt: null },
    });
    if (!account) throw new NotFoundError('Channel account');
    await prisma.channelAccount.update({
      where: { id: accountId },
      data: { isActive: false, deletedAt: new Date() },
    });
  },
};
