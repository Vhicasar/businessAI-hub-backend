import { randomBytes, randomInt } from 'node:crypto';
import type {
  PaymentIntentResource,
  PaymentIntentStatus,
  PaymentMethodKind,
  Prisma,
} from '@prisma/client';
import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { AppError, NotFoundError } from '../../shared/errors';
import { logger } from '../../shared/logger';
import { env } from '../../shared/config/env';
import { readPaymentSettings } from './payment-settings.service';

/**
 * The Payment Intent: one record of "what this customer is trying to pay for",
 * whatever they are paying for and wherever they started.
 *
 * Everything that collects money goes through here — orders, invoices, deals,
 * property, bookings, chat, the AI, links, QR codes and the API — so there is
 * one lifecycle to reason about and one place where money is recognised.
 *
 * Two rules hold everywhere in this file:
 *
 *  * the amount is the server's, computed from the resource, never taken from
 *    a client;
 *  * an intent becomes PAID only through `applyTransaction`, which is called
 *    from verified provider data. Nothing a customer or a frontend says — and
 *    no uploaded receipt — can move it there.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;
/** Money is equal if it agrees to within half a minor unit. */
const EPSILON = 0.005;

/**
 * Reference alphabet: Crockford base32 without I, L, O or U, so a customer
 * reading a reference down the phone or typing it into a bank narration cannot
 * turn a 1 into an I or a 0 into an O.
 */
const REF_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function makeReference(): string {
  let out = '';
  for (let i = 0; i < 7; i += 1) out += REF_ALPHABET[randomInt(REF_ALPHABET.length)];
  return `VH-PI-${out}`;
}

/**
 * The access token is long and random, and deliberately unrelated to the
 * reference. The reference is printed on bills and read aloud; if it also
 * opened the payment page, quoting your own invoice number would hand over
 * control of the payment.
 */
function makeToken(): string {
  return randomBytes(32).toString('base64url');
}

export function publicPayUrl(token: string): string {
  return `${env.WEB_APP_URL.replace(/\/+$/, '')}/pay/${token}`;
}

/** Statuses from which no further payment is accepted. */
const TERMINAL: PaymentIntentStatus[] = [
  'PAID',
  'CANCELLED',
  'EXPIRED',
  'REFUNDED',
  'REVERSED',
];

export interface CreateIntentInput {
  organizationId: string;
  resourceType: PaymentIntentResource;
  resourceId?: string | null;
  customerId?: string | null;
  orderId?: string | null;
  invoiceId?: string | null;
  dealId?: string | null;
  propertyId?: string | null;
  /** Minor-unit-safe decimal. Callers pass a server-derived figure. */
  amount: number;
  currency: string;
  description?: string | null;
  allowPartial?: boolean;
  /** WEB | APP | INBOX | AI | LINK | QR | API | POS */
  channel?: string | null;
  createdById?: string | null;
  aiCreated?: boolean;
  /** Overrides the business's default expiry. Zero means "never expires". */
  expiryMinutes?: number | null;
  metadata?: Prisma.InputJsonValue;
  /**
   * Reuse an open intent for the same resource instead of minting a second.
   * On by default: two live intents for one bill is how a customer ends up
   * paying twice.
   */
  reuseOpen?: boolean;
}

export interface ApplyTransactionInput {
  organizationId: string;
  paymentIntentId: string;
  provider: string;
  /** Gateway's own id. The idempotency anchor. */
  providerRef: string;
  method: PaymentMethodKind;
  amount: number;
  currency: string;
  fee?: number | null;
  status: 'SUCCESS' | 'FAILED';
  failureReason?: string | null;
  paidAt?: Date | null;
  rawPayload?: Prisma.InputJsonValue;
}

export interface ApplyResult {
  /** False when this provider reference had already been booked. */
  applied: boolean;
  intentId: string;
  status: PaymentIntentStatus;
  amountPaid: number;
  /** True only on the transition into a fully-paid state, so callers can fan
   *  out exactly once. */
  becamePaid: boolean;
}

/**
 * Work out the status implied by the money booked so far.
 *
 * Kept as a pure function so the rules are visible in one place and can be
 * tested without a database.
 */
export function statusForAmounts(
  amount: number,
  paid: number,
  opts: { expired?: boolean } = {}
): PaymentIntentStatus {
  if (paid <= EPSILON) return opts.expired ? 'EXPIRED' : 'AWAITING_PAYMENT';
  if (paid > amount + EPSILON) return 'OVERPAID';
  if (paid >= amount - EPSILON) return 'PAID';
  // Part-paid bills stay part-paid even past their expiry: money has changed
  // hands, and calling that EXPIRED would hide a real balance.
  return 'PARTIALLY_PAID';
}

export const paymentIntentService = {
  /**
   * Raise an intent. Returns an existing open one for the same resource unless
   * the caller explicitly wants a new one.
   */
  async create(input: CreateIntentInput) {
    const amount = round2(input.amount);
    if (!(amount > 0)) {
      throw new AppError('INVALID_AMOUNT', 400, 'A payment must be for more than zero.');
    }
    const currency = input.currency.toUpperCase();

    if (input.reuseOpen !== false && input.resourceId) {
      const open = await prismaUnscoped.paymentIntent.findFirst({
        where: {
          organizationId: input.organizationId,
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          status: { in: ['CREATED', 'AWAITING_PAYMENT', 'PROCESSING', 'PARTIALLY_PAID'] },
        },
        orderBy: { createdAt: 'desc' },
      });
      // Only reuse if it is still for the same money. A changed bill needs a
      // new intent, or the customer pays yesterday's figure.
      if (open && Math.abs(Number(open.amount) - amount) <= EPSILON && open.currency === currency) {
        const stale = open.expiresAt != null && open.expiresAt.getTime() < Date.now();
        if (!stale) return open;
        await prismaUnscoped.paymentIntent.update({
          where: { id: open.id },
          data: { status: 'EXPIRED' },
        });
      }
    }

    const settings = await readPaymentSettings(input.organizationId);
    const minutes = input.expiryMinutes ?? settings.expiryMinutes;
    const expiresAt = minutes > 0 ? new Date(Date.now() + minutes * 60_000) : null;

    // Reference collisions are vanishingly unlikely but not impossible, and a
    // duplicate would break reconciliation, so retry rather than hope.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return await prismaUnscoped.paymentIntent.create({
          data: {
            organizationId: input.organizationId,
            reference: makeReference(),
            token: makeToken(),
            resourceType: input.resourceType,
            resourceId: input.resourceId ?? null,
            customerId: input.customerId ?? null,
            orderId: input.orderId ?? null,
            invoiceId: input.invoiceId ?? null,
            dealId: input.dealId ?? null,
            propertyId: input.propertyId ?? null,
            amount,
            currency,
            description: input.description ?? null,
            allowPartial: input.allowPartial ?? false,
            channel: input.channel ?? null,
            createdById: input.createdById ?? null,
            aiCreated: input.aiCreated ?? false,
            status: 'AWAITING_PAYMENT',
            expiresAt,
            ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
          },
        });
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code !== 'P2002' || attempt === 4) throw err;
        logger.warn({ attempt }, 'payment intent reference collision, retrying');
      }
    }
    throw new AppError('REFERENCE_COLLISION', 500, 'Could not allocate a payment reference.');
  },

  async byToken(token: string) {
    const intent = await prismaUnscoped.paymentIntent.findUnique({ where: { token } });
    if (!intent) throw new NotFoundError('Payment');
    return intent;
  },

  async byReference(reference: string) {
    const intent = await prismaUnscoped.paymentIntent.findUnique({
      where: { reference: reference.trim().toUpperCase() },
    });
    if (!intent) throw new NotFoundError('Payment');
    return intent;
  },

  /**
   * Book a provider transaction against an intent.
   *
   * The single door through which money is recognised, and the only place an
   * intent can reach PAID. Safe to call repeatedly with the same provider
   * reference — a gateway that retries a webhook five times books once.
   *
   * Runs inside a transaction with the intent row locked, because two webhook
   * deliveries arriving together would otherwise both read the old total and
   * both write a figure that ignores the other.
   */
  async applyTransaction(input: ApplyTransactionInput): Promise<ApplyResult> {
    const amount = round2(input.amount);
    const currency = input.currency.toUpperCase();

    return prismaUnscoped.$transaction(async (tx) => {
      // Lock first: everything below depends on nobody else moving the totals.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "PaymentIntent" WHERE id = ${input.paymentIntentId} FOR UPDATE
      `;
      if (locked.length === 0) throw new NotFoundError('Payment');

      const intent = await tx.paymentIntent.findUniqueOrThrow({
        where: { id: input.paymentIntentId },
      });

      // Idempotency. A provider replaying a delivery finds its reference is
      // already booked and changes nothing.
      const existing = await tx.paymentTransaction.findUnique({
        where: { provider_providerRef: { provider: input.provider, providerRef: input.providerRef } },
      });
      if (existing) {
        return {
          applied: false,
          intentId: intent.id,
          status: intent.status,
          amountPaid: Number(intent.amountPaid),
          becamePaid: false,
        };
      }

      // A gateway reporting a different currency than the bill is either
      // misconfigured or the wrong transaction; either way we do not guess.
      if (input.status === 'SUCCESS' && currency !== intent.currency) {
        throw new AppError(
          'CURRENCY_MISMATCH',
          409,
          `Payment is in ${currency} but ${intent.reference} is billed in ${intent.currency}.`
        );
      }

      await tx.paymentTransaction.create({
        data: {
          organizationId: intent.organizationId,
          paymentIntentId: intent.id,
          provider: input.provider,
          providerRef: input.providerRef,
          method: input.method,
          status: input.status === 'SUCCESS' ? 'SUCCESS' : 'FAILED',
          amount,
          currency,
          fee: input.fee ?? null,
          failureReason: input.failureReason ?? null,
          paidAt: input.status === 'SUCCESS' ? (input.paidAt ?? new Date()) : null,
          ...(input.rawPayload === undefined ? {} : { rawPayload: input.rawPayload }),
        },
      });

      if (input.status !== 'SUCCESS') {
        // A failed attempt does not move a bill backwards — a customer whose
        // card is declined may still have part-paid by transfer earlier.
        const next: PaymentIntentStatus =
          Number(intent.amountPaid) > EPSILON ? intent.status : 'FAILED';
        const updated = await tx.paymentIntent.update({
          where: { id: intent.id },
          data: { status: next, method: input.method, provider: input.provider },
        });
        return {
          applied: true,
          intentId: intent.id,
          status: updated.status,
          amountPaid: Number(updated.amountPaid),
          becamePaid: false,
        };
      }

      // Recompute from the ledger rather than incrementing, so a total can
      // never drift away from the transactions that justify it.
      const agg = await tx.paymentTransaction.aggregate({
        where: { paymentIntentId: intent.id, status: 'SUCCESS' },
        _sum: { amount: true },
      });
      const paid = round2(Number(agg._sum.amount ?? 0));
      const wasPaid = intent.status === 'PAID' || intent.status === 'OVERPAID';
      const status = statusForAmounts(Number(intent.amount), paid);
      const nowPaid = status === 'PAID' || status === 'OVERPAID';

      const updated = await tx.paymentIntent.update({
        where: { id: intent.id },
        data: {
          amountPaid: paid,
          status,
          method: input.method,
          provider: input.provider,
          paidAt: nowPaid ? (intent.paidAt ?? input.paidAt ?? new Date()) : intent.paidAt,
        },
      });

      return {
        applied: true,
        intentId: intent.id,
        status: updated.status,
        amountPaid: paid,
        becamePaid: nowPaid && !wasPaid,
      };
    });
  },

  /** Stop an intent being payable. Money already taken is untouched. */
  async cancel(id: string, organizationId: string) {
    const intent = await prismaUnscoped.paymentIntent.findFirst({
      where: { id, organizationId },
    });
    if (!intent) throw new NotFoundError('Payment');
    if (TERMINAL.includes(intent.status)) {
      throw new AppError(
        'PAYMENT_NOT_CANCELLABLE',
        409,
        `A payment that is ${intent.status.toLowerCase().replace(/_/g, ' ')} cannot be cancelled.`
      );
    }
    return prismaUnscoped.paymentIntent.update({
      where: { id },
      data: { status: 'CANCELLED' },
    });
  },

  /**
   * Sweep intents past their expiry.
   *
   * Only ones nobody has paid anything towards: a part-paid bill keeps its
   * balance visible rather than quietly disappearing.
   */
  async expireOverdue(now = new Date()): Promise<number> {
    const res = await prismaUnscoped.paymentIntent.updateMany({
      where: {
        expiresAt: { not: null, lt: now },
        status: { in: ['CREATED', 'AWAITING_PAYMENT', 'PROCESSING'] },
        amountPaid: 0,
      },
      data: { status: 'EXPIRED' },
    });
    if (res.count > 0) logger.info({ count: res.count }, 'expired unpaid payment intents');
    return res.count;
  },

  /** What is still owed on this intent. */
  outstanding(intent: { amount: unknown; amountPaid: unknown }): number {
    return Math.max(0, round2(Number(intent.amount) - Number(intent.amountPaid)));
  },

  /**
   * Whether a customer can still pay this.
   *
   * Checked at payment time, not only at issue time: a printed code may be
   * scanned months later, and a business's standing can change in between.
   */
  isPayable(intent: {
    status: PaymentIntentStatus;
    expiresAt: Date | null;
    amount: unknown;
    amountPaid: unknown;
  }): boolean {
    if (TERMINAL.includes(intent.status)) return false;
    if (intent.expiresAt && intent.expiresAt.getTime() < Date.now()) return false;
    return this.outstanding(intent) > EPSILON;
  },
};
