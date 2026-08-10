import { createHash } from 'node:crypto';
import type { PaymentMethodKind, Prisma } from '@prisma/client';
import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { logger } from '../../shared/logger';
import { paymentIntentService } from './payment-intent.service';
import { settlePaymentIntent } from './payment-settlement.service';

/**
 * Turning a provider webhook into money we recognise.
 *
 * The order below is the whole point and none of it may be skipped:
 *
 *     record → verify signature → find intent → validate amount and currency
 *            → validate against the provider's own API → book → fan out
 *
 * Nothing here trusts the request body until the signature has been checked
 * against the *addressed business's* secret, and even then the amount is
 * re-read from the provider rather than taken from the payload, because a
 * webhook body is attacker-shaped input until proven otherwise.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;
const EPSILON = 0.005;

/**
 * A stable identity for an event, so a retry is recognisable.
 *
 * Providers vary: some send an event id, some do not. Where one is missing we
 * hash the payload, which gives the same answer for a genuine retry (identical
 * body) and a different one for a distinct event.
 */
export function eventKeyFor(provider: string, body: unknown): string {
  const b = (body ?? {}) as Record<string, unknown>;
  const data = (b.data ?? {}) as Record<string, unknown>;
  const explicit =
    (typeof b.id === 'string' && b.id) ||
    (typeof data.id === 'string' && data.id) ||
    (typeof data.id === 'number' && String(data.id)) ||
    (typeof data.reference === 'string' && `ref:${data.reference}`) ||
    null;
  if (explicit) return `${b.event ?? b.type ?? 'event'}:${explicit}`;
  return `sha256:${createHash('sha256').update(JSON.stringify(body ?? {})).digest('hex')}`;
}

/** Map a gateway's own channel name onto our method vocabulary. */
export function methodFromProviderChannel(channel: unknown): PaymentMethodKind {
  const c = String(channel ?? '').toLowerCase();
  if (c.includes('bank_transfer') || c === 'banktransfer') return 'BANK_TRANSFER';
  if (c.includes('dedicated') || c.includes('virtual')) return 'VIRTUAL_ACCOUNT';
  if (c.includes('ussd')) return 'USSD';
  if (c.includes('qr')) return 'QR_CODE';
  if (c.includes('mobile_money') || c.includes('momo')) return 'MOBILE_MONEY';
  if (c === 'bank') return 'PAY_WITH_BANK';
  if (c.includes('apple')) return 'APPLE_PAY';
  if (c.includes('google')) return 'GOOGLE_PAY';
  // Card is the honest default: it is what every gateway falls back to, and
  // guessing something exotic would mislabel the payment on a receipt.
  return 'CARD';
}

export interface IngestInput {
  provider: string;
  organizationId: string | null;
  body: unknown;
  signatureValid: boolean;
}

export interface IngestResult {
  status: 'PROCESSED' | 'IGNORED' | 'FAILED' | 'DUPLICATE';
  detail?: string;
  paymentIntentId?: string;
}

/** Pull the pieces we care about out of a gateway's charge event. */
function readCharge(body: unknown): {
  isCharge: boolean;
  reference: string | null;
  providerRef: string | null;
  amountMinor: number | null;
  currency: string | null;
  channel: unknown;
  succeeded: boolean;
} {
  const b = (body ?? {}) as Record<string, unknown>;
  const name = String(b.event ?? b.type ?? '').toLowerCase();
  const data = (b.data ?? (b.object as Record<string, unknown>) ?? {}) as Record<string, unknown>;

  const isCharge =
    name.includes('charge') ||
    name.includes('payment_intent.succeeded') ||
    name.includes('transaction') ||
    name === 'successful';
  const succeeded =
    name.includes('success') ||
    name.includes('succeeded') ||
    String(data.status ?? '').toLowerCase() === 'success' ||
    String(data.status ?? '').toLowerCase() === 'successful';

  const reference =
    (typeof data.reference === 'string' && data.reference) ||
    (typeof data.tx_ref === 'string' && data.tx_ref) ||
    null;
  const providerRef =
    (typeof data.id === 'string' && data.id) ||
    (typeof data.id === 'number' && String(data.id)) ||
    (typeof data.flw_ref === 'string' && data.flw_ref) ||
    reference;

  const amountMinor = typeof data.amount === 'number' ? data.amount : null;
  const currency = typeof data.currency === 'string' ? data.currency.toUpperCase() : null;

  return { isCharge, reference, providerRef, amountMinor, currency, channel: data.channel, succeeded };
}

export const paymentWebhookService = {
  /**
   * Record and process one delivery.
   *
   * Always records first, even when the signature is bad: an endpoint being
   * hammered with forged events is something an operator needs to be able to
   * see (§18/§20), and a silently dropped request leaves no trace of it.
   */
  async ingest(input: IngestInput): Promise<IngestResult> {
    const eventKey = eventKeyFor(input.provider, input.body);
    const payload = (input.body ?? {}) as Prisma.InputJsonValue;

    let event;
    try {
      event = await prismaUnscoped.inboundWebhookEvent.create({
        data: {
          provider: input.provider,
          eventKey,
          eventType: String(
            (input.body as Record<string, unknown>)?.event ??
              (input.body as Record<string, unknown>)?.type ??
              ''
          ) || null,
          organizationId: input.organizationId,
          signatureValid: input.signatureValid,
          payload,
        },
      });
    } catch (err) {
      // Unique violation: this exact event has been seen. That is the normal
      // case for a provider retry, not an error.
      if ((err as { code?: string }).code === 'P2002') {
        return { status: 'DUPLICATE', detail: 'Event already received' };
      }
      throw err;
    }

    if (!input.signatureValid) {
      await this.markFailed(event.id, 'Signature verification failed');
      return { status: 'FAILED', detail: 'Signature verification failed' };
    }

    return this.process(event.id);
  },

  /**
   * Process a recorded event. Separated from `ingest` so the retry job can run
   * exactly the same path over a failed one.
   */
  async process(eventId: string): Promise<IngestResult> {
    const event = await prismaUnscoped.inboundWebhookEvent.findUnique({ where: { id: eventId } });
    if (!event) return { status: 'FAILED', detail: 'Event not found' };
    if (event.status === 'PROCESSED') return { status: 'DUPLICATE' };

    try {
      const charge = readCharge(event.payload);
      if (!charge.isCharge || !charge.succeeded) {
        await prismaUnscoped.inboundWebhookEvent.update({
          where: { id: eventId },
          data: { status: 'IGNORED', processedAt: new Date() },
        });
        return { status: 'IGNORED', detail: 'Not a successful charge' };
      }
      if (!charge.reference) {
        await this.markFailed(eventId, 'Event carries no payment reference');
        return { status: 'FAILED', detail: 'No reference' };
      }

      // Our reference is what we put on the charge when it was initiated. An
      // event for something else entirely — platform billing, a wallet top-up —
      // is not ours to process here.
      const intent = await prismaUnscoped.paymentIntent.findUnique({
        where: { reference: charge.reference.trim().toUpperCase() },
      });
      if (!intent) {
        await prismaUnscoped.inboundWebhookEvent.update({
          where: { id: eventId },
          data: { status: 'IGNORED', processedAt: new Date() },
        });
        return { status: 'IGNORED', detail: 'Reference does not belong to a payment intent' };
      }

      // The event claims to be for a business; it had better be the one whose
      // endpoint it arrived on, or a business could book payments against
      // another's bills.
      if (event.organizationId && event.organizationId !== intent.organizationId) {
        await this.markFailed(eventId, 'Event arrived on the wrong business endpoint');
        return { status: 'FAILED', detail: 'Organization mismatch' };
      }

      const { verifyWithProvider } = await import('./payment-verification.service');
      const verified = await verifyWithProvider({
        organizationId: intent.organizationId,
        provider: event.provider,
        reference: charge.reference,
        // The payload's own figures, used only when the provider API is
        // unreachable — see the fallback note in the verifier.
        fallback: {
          amountMinor: charge.amountMinor,
          currency: charge.currency,
        },
      });

      if (!verified.ok) {
        await this.markFailed(eventId, verified.reason);
        return { status: 'FAILED', detail: verified.reason };
      }

      const amount = round2(verified.amount);
      // The gateway saying "paid" for less than the bill is a part payment, not
      // a settlement; more is an overpayment. Both are handled by the intent,
      // but a wildly different figure means we matched the wrong thing.
      if (amount <= 0) {
        await this.markFailed(eventId, 'Provider reported a non-positive amount');
        return { status: 'FAILED', detail: 'Non-positive amount' };
      }
      if (verified.currency !== intent.currency) {
        await this.markFailed(
          eventId,
          `Provider reported ${verified.currency} against a bill in ${intent.currency}`
        );
        return { status: 'FAILED', detail: 'Currency mismatch' };
      }
      if (amount > Number(intent.amount) * 10 + EPSILON) {
        await this.markFailed(eventId, 'Provider amount is implausible for this bill');
        return { status: 'FAILED', detail: 'Implausible amount' };
      }

      const result = await paymentIntentService.applyTransaction({
        organizationId: intent.organizationId,
        paymentIntentId: intent.id,
        provider: event.provider,
        providerRef: verified.providerRef || charge.providerRef || charge.reference,
        method: methodFromProviderChannel(charge.channel),
        amount,
        currency: verified.currency,
        fee: verified.fee,
        status: 'SUCCESS',
        paidAt: verified.paidAt,
        rawPayload: event.payload as Prisma.InputJsonValue,
      });

      // Everything downstream — order, invoice, deal, CRM, stock, receipt,
      // notifications — happens here, once, and only for a real transition.
      if (result.applied) {
        await settlePaymentIntent(intent.id, { becamePaid: result.becamePaid });
      }

      await prismaUnscoped.inboundWebhookEvent.update({
        where: { id: eventId },
        data: {
          status: 'PROCESSED',
          processedAt: new Date(),
          organizationId: intent.organizationId,
          paymentIntentId: intent.id,
        },
      });
      return { status: 'PROCESSED', paymentIntentId: intent.id };
    } catch (err) {
      const message = (err as Error).message;
      logger.error({ err, eventId }, 'payment webhook processing failed');
      await this.markFailed(eventId, message);
      return { status: 'FAILED', detail: message };
    }
  },

  async markFailed(eventId: string, reason: string): Promise<void> {
    await prismaUnscoped.inboundWebhookEvent.update({
      where: { id: eventId },
      data: {
        status: 'FAILED',
        lastError: reason.slice(0, 2000),
        attempts: { increment: 1 },
      },
    });
  },

  /**
   * Retry the failed queue.
   *
   * Bounded attempts: a webhook that has failed ten times is failing for a
   * reason a retry will not fix, and hammering it forever buries the ones that
   * would succeed. Those stay visible in admin for a human.
   */
  async retryFailed(limit = 50, maxAttempts = 10): Promise<{ retried: number; recovered: number }> {
    const failed = await prismaUnscoped.inboundWebhookEvent.findMany({
      where: { status: 'FAILED', signatureValid: true, attempts: { lt: maxAttempts } },
      orderBy: { receivedAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    let recovered = 0;
    for (const e of failed) {
      const res = await this.process(e.id);
      if (res.status === 'PROCESSED') recovered += 1;
    }
    if (failed.length) logger.info({ retried: failed.length, recovered }, 'retried failed webhooks');
    return { retried: failed.length, recovered };
  },
};
