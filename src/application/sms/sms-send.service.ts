import { randomUUID } from 'crypto';
import { prisma, prismaUnscoped } from '../../infrastructure/database/prisma';
import { smsProvider } from '../../infrastructure/sms/registry';
import { smsWalletService } from '../billing/sms-wallet.service';
import { senderIdService } from './sender-id.service';
import { segmentsFor, totalSegments } from './sms-segments';
import { resolveRecipients } from './phone-numbers';
import { logger } from '../../shared/logger';
import { ValidationError } from '../../shared/errors';
import { isChannelEnabled } from '../settings/workspace-config';
import type { SendSmsInput, SmsRoute } from './sms-provider';

/**
 * Sending SMS: the one path everything else goes through.
 *
 * The order of operations is the whole design, and it is deliberate:
 *
 *   1. resolve and deduplicate recipients — one person, one charge
 *   2. drop anyone who has opted out (marketing only)
 *   3. render each message, so segments are counted on the real text
 *   4. reserve the entire cost up front
 *   5. hand it to the provider
 *   6. refund whatever the provider refused
 *
 * Reserving before sending is what stops a business starting a 5,000-recipient
 * campaign on credit for 400 and discovering it four hundred messages in.
 * Refunding afterwards is what keeps that honest rather than a rounding-up in
 * Vhicasar's favour.
 */

export interface Recipient {
  phone: string;
  customerId?: string;
  /** Values for {{firstName}} and friends. */
  variables?: Record<string, string>;
}

export interface SendRequest {
  organizationId: string;
  /** May contain {{variables}}; rendered per recipient. */
  template: string;
  recipients: Recipient[];
  route: SmsRoute;
  senderIdId?: string;
  campaignId?: string;
  /** For transactional sends: which kind, so a business can switch it off. */
  eventType?: string;
}

export interface SendOutcome {
  queued: number;
  rejected: { phone: string; reason: string }[];
  suppressed: number;
  duplicates: number;
  segments: number;
  cost: number;
  reference: string;
}

/**
 * Fill {{variables}} in.
 *
 * An unresolved variable is replaced with nothing rather than left as
 * "{{firstName}}" — a customer receiving literal braces is worse than a
 * slightly awkward sentence, and it is the sort of thing nobody notices until
 * it has gone to five thousand people.
 */
export function renderTemplate(template: string, variables: Record<string, string> = {}): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) =>
    (variables[key] ?? '').trim(),
  );
}

/** The variables a composer should offer, and what they resolve from. */
export const SUPPORTED_VARIABLES = [
  'firstName', 'lastName', 'businessName', 'orderNumber', 'amount', 'appointmentDate',
] as const;

export const smsSendService = {
  /**
   * Numbers this business must not send marketing to.
   *
   * Checked per send rather than cached: an opt-out that arrived a minute ago
   * has to be honoured by the campaign starting now.
   */
  async suppressedNumbers(organizationId: string, phones: string[]): Promise<Set<string>> {
    if (phones.length === 0) return new Set();
    const rows = await prismaUnscoped.smsSuppression.findMany({
      where: { organizationId, phone: { in: phones } },
      select: { phone: true },
    });
    return new Set(rows.map((r) => r.phone));
  },

  /** Record that a number must not be marketed to again. */
  async suppress(organizationId: string, phone: string, reason: string, sourceMessageId?: string) {
    await prismaUnscoped.smsSuppression
      .upsert({
        where: { organizationId_phone: { organizationId, phone } },
        create: { organizationId, phone, reason, sourceMessageId: sourceMessageId ?? null },
        // Kept as first recorded: when they opted out matters more than the
        // most recent time they told us again.
        update: {},
      })
      .catch((err) => logger.warn({ err, phone }, 'Could not record SMS suppression'));
  },

  /**
   * What a send will cost and reach, without sending it.
   *
   * The composer's confirmation step: recipients after deduplication and
   * suppression, segments per message, and the real total.
   */
  async preview(request: SendRequest) {
    const resolved = resolveRecipients(
      request.recipients.map((r) => ({ phone: r.phone, source: r })),
    );
    const suppressed =
      request.route === 'PROMOTIONAL'
        ? await this.suppressedNumbers(
            request.organizationId,
            resolved.accepted.map((a) => a.e164),
          )
        : new Set<string>();

    const sendable = resolved.accepted.filter((a) => !suppressed.has(a.e164));
    const bodies = sendable.map((a) => renderTemplate(request.template, a.source.variables));
    const quote = await smsWalletService.quoteSms(request.organizationId, bodies);
    const sample = segmentsFor(renderTemplate(request.template, request.recipients[0]?.variables));

    return {
      recipients: sendable.length,
      duplicates: resolved.duplicates,
      invalid: resolved.rejected.map((r) => ({ phone: r.raw, reason: r.reason })),
      suppressed: suppressed.size,
      segmentsPerMessage: sample.segments,
      encoding: sample.encoding,
      forcedUnicodeBy: sample.forcedUnicodeBy,
      totalSegments: totalSegments(bodies),
      estimatedCost: quote.totalCost,
      currency: quote.currency,
      balance: quote.balance,
      affordable: quote.affordable,
    };
  },

  /** Resolve, reserve, send, reconcile. */
  async send(request: SendRequest): Promise<SendOutcome> {
    const provider = smsProvider();

    /*
     * Refused when the platform has switched SMS off as a means of
     * communication.
     *
     * Deliberately `communication.smsEnabled` and not the channel policy:
     * those answer different questions. The channel policy governs whether a
     * business may connect an SMS *inbox* channel — a Twilio number people
     * text in to. This module is about sending, and is switched off by the
     * master communication setting instead.
     *
     * Checked here rather than only in the UI: hiding a button is a courtesy,
     * but the endpoint behind it is what has to say no, or a disabled channel
     * is one API call away from spending credits.
     */
    if (!isChannelEnabled('SMS')) {
      throw new ValidationError('SMS is not available on this workspace.');
    }

    // Refused before anything is charged: an unapproved Sender ID means the
    // network will reject the traffic and the business will have paid for it.
    const sender = await senderIdService.requireApproved(request.organizationId, request.senderIdId);

    const resolved = resolveRecipients(
      request.recipients.map((r) => ({ phone: r.phone, source: r })),
    );
    const suppressed =
      request.route === 'PROMOTIONAL'
        ? await this.suppressedNumbers(
            request.organizationId,
            resolved.accepted.map((a) => a.e164),
          )
        : new Set<string>();
    const sendable = resolved.accepted.filter((a) => !suppressed.has(a.e164));

    if (sendable.length === 0) {
      throw new ValidationError(
        resolved.accepted.length === 0
          ? 'None of those numbers can be sent to.'
          : 'Everyone on that list has opted out of marketing messages.',
      );
    }

    /*
     * The platform's ceiling on one send.
     *
     * A limit the administrator can set but nothing enforces is worse than no
     * limit at all — it reads as a safeguard while a mistyped import still
     * spends a business's whole balance in one action.
     */
    const pricing = await smsWalletService.pricing();
    const ceiling = pricing.maxCampaignSize;
    if (ceiling && sendable.length > ceiling) {
      throw new ValidationError(
        `This send reaches ${sendable.length.toLocaleString()} people, above the ${ceiling.toLocaleString()} allowed in one go. Split it into smaller sends.`,
      );
    }

    const prepared = sendable.map((entry) => {
      const body = renderTemplate(request.template, entry.source.variables);
      return {
        e164: entry.e164,
        body,
        customerId: entry.source.customerId,
        info: segmentsFor(body),
        reference: `sms_${Date.now().toString(36)}_${randomUUID()}`,
      };
    });
    const reservedUnits = prepared.reduce((sum, p) => sum + p.info.segments, 0);

    const reservation = await smsWalletService.reserve({
      organizationId: request.organizationId,
      units: reservedUnits,
      campaignId: request.campaignId,
      route: request.route,
      description: `${request.route === 'PROMOTIONAL' ? 'SMS campaign' : 'Transactional SMS'} — ${prepared.length} recipient${prepared.length === 1 ? '' : 's'}`,
    });

    // Written before the provider is called, so a crash mid-send leaves a
    // record of what was attempted rather than a silent gap.
    await prismaUnscoped.smsMessage.createMany({
      data: prepared.map((p) => ({
        organizationId: request.organizationId,
        campaignId: request.campaignId ?? null,
        customerId: p.customerId ?? null,
        senderIdId: sender.id,
        senderValue: sender.value,
        recipient: p.e164,
        body: p.body,
        route: request.route === 'PROMOTIONAL' ? 'PROMOTIONAL' : 'TRANSACTIONAL',
        status: 'QUEUED',
        segments: p.info.segments,
        encoding: p.info.encoding,
        cost: reservation.unitCost * p.info.segments,
        reference: p.reference,
        eventType: request.eventType ?? null,
      })),
    });

    const inputs: SendSmsInput[] = prepared.map((p) => ({
      to: p.e164,
      body: p.body,
      senderId: sender.value,
      route: request.route,
      reference: p.reference,
    }));

    let accepted = 0;
    const rejected: { phone: string; reason: string }[] = [];
    try {
      const result = await provider.sendBulkSms(inputs);
      accepted = result.accepted.length;

      // Match each provider id back to its message by our own reference.
      await Promise.all(
        result.accepted.map(async (sent, index) => {
          const target = prepared[index];
          if (!target) return;
          await prismaUnscoped.smsMessage.updateMany({
            where: { organizationId: request.organizationId, reference: target.reference },
            data: {
              status: 'SENT',
              providerMessageId: sent.providerMessageId,
              sentAt: new Date(),
            },
          });
        }),
      );

      for (const failure of result.rejected) {
        rejected.push({ phone: failure.to, reason: failure.reason });
        const target = prepared.find((p) => p.e164 === failure.to);
        if (target) {
          await prismaUnscoped.smsMessage.updateMany({
            where: { organizationId: request.organizationId, reference: target.reference },
            data: { status: 'REJECTED', failureReason: failure.reason },
          });
        }
      }
    } catch (err) {
      // The whole batch failed. Everything reserved is given back — the
      // business must not pay for a send that never left Vhicasar.
      await smsWalletService.settleReservation({
        organizationId: request.organizationId,
        reference: reservation.reference,
        reservedUnits,
        actualUnits: 0,
        route: request.route,
      });
      await prismaUnscoped.smsMessage.updateMany({
        where: {
          organizationId: request.organizationId,
          reference: { in: prepared.map((p) => p.reference) },
        },
        data: { status: 'FAILED', failureReason: (err as Error).message },
      });
      throw err;
    }

    // Refund the segments the provider refused.
    const rejectedSegments = prepared
      .filter((p) => rejected.some((r) => r.phone === p.e164))
      .reduce((sum, p) => sum + p.info.segments, 0);
    const { refundedUnits } = await smsWalletService.settleReservation({
      organizationId: request.organizationId,
      reference: reservation.reference,
      reservedUnits,
      actualUnits: reservedUnits - rejectedSegments,
      route: request.route,
    });

    return {
      queued: accepted,
      rejected,
      suppressed: suppressed.size,
      duplicates: resolved.duplicates,
      segments: reservedUnits - refundedUnits,
      cost: (reservedUnits - refundedUnits) * reservation.unitCost,
      reference: reservation.reference,
    };
  },
};
