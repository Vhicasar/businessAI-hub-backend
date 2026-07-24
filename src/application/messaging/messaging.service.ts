import type { ChannelType } from '@prisma/client';
import { prisma } from '../../infrastructure/database/prisma';
import { decrypt } from '../../shared/crypto';
import { getAdapter } from '../../infrastructure/channels/registry';
import { logger } from '../../shared/logger';
import { smsWalletService } from '../billing/sms-wallet.service';

/**
 * Single outbound-send path shared by campaigns and workflow actions. Resolves
 * the org's active channel account, the customer's address on that channel, and
 * delivers via the provider adapter. Best-effort: returns a result, never throws.
 */

export interface SendOutcome {
  ok: boolean;
  error?: string;
  providerMessageId?: string;
}

export const messagingService = {
  async sendToCustomer(
    customerId: string,
    channelType: ChannelType,
    text: string,
    context: { campaignId?: string; subject?: string; templateName?: string; templateLanguage?: string } = {},
  ): Promise<SendOutcome> {
    const account = await prisma.channelAccount.findFirst({
      where: { channelType, isActive: true, deletedAt: null },
    });
    if (!account) return { ok: false, error: `No active ${channelType} channel is configured` };

    // Resolve the recipient address. Email can fall back to the customer record.
    let recipientExternalId: string | null = null;
    if (channelType === 'EMAIL') {
      const customer = await prisma.customer.findFirst({ where: { id: customerId }, select: { email: true } });
      recipientExternalId = customer?.email ?? null;
    }
    if (!recipientExternalId) {
      const identity = await prisma.customerIdentity.findFirst({ where: { customerId, channelType } });
      recipientExternalId = identity?.externalId ?? null;
    }
    if (!recipientExternalId) return { ok: false, error: `Customer has no ${channelType} address on file` };

    let creditReservation: string | null = null;
    try {
      const paidChannel =
        channelType === 'SMS' ||
        (Boolean(context.campaignId) && (channelType === 'EMAIL' || channelType === 'WHATSAPP'));
      if (paidChannel) {
        creditReservation = await smsWalletService.debit({
          organizationId: account.organizationId,
          channelType: channelType as 'SMS' | 'EMAIL' | 'WHATSAPP',
          customerId,
          campaignId: context.campaignId,
        });
      }
      const adapter = getAdapter(channelType);
      const result = await adapter.sendMessage(
        {
          recipientExternalId,
          text,
          subject: context.subject,
          isMarketing: Boolean(context.campaignId),
          templateName: context.templateName,
          templateLanguage: context.templateLanguage,
        },
        {
          id: account.id,
          organizationId: account.organizationId,
          externalId: account.externalId,
          credentials: account.credentialsEnc
            ? (JSON.parse(decrypt(account.credentialsEnc)) as Record<string, string>)
            : {},
          webhookSecret: account.webhookSecret,
        },
      );
      return { ok: true, providerMessageId: result.providerMessageId };
    } catch (err) {
      if (creditReservation) {
        await smsWalletService.rollback(account.organizationId, creditReservation);
      }
      logger.error({ err, customerId, channelType }, 'messaging.sendToCustomer failed');
      return { ok: false, error: err instanceof Error ? err.message : 'Send failed' };
    }
  },
};

/** Replace {{field}} tokens (e.g. {{firstName}}) with values. */
export function renderTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => vars[k] ?? '');
}
