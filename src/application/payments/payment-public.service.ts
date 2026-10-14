import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { NotFoundError, ValidationError } from '../../shared/errors';
import { paymentIntentService, publicPayUrl } from './payment-intent.service';
import { paymentMethodsService } from './payment-methods.service';
import { readPaymentSettings } from './payment-settings.service';
import { receiptNumberFor } from './payment-receipt.service';
import { resolveOrgProvider } from './org-account.service';
import { verifyWithProvider } from './payment-verification.service';
import { settlePaymentIntent } from './payment-settlement.service';

/**
 * What a customer sees when they open a payment — on the hosted page, in the
 * app, from a QR code or through the API.
 *
 * The method list is resolved here, live, on every read. That is what makes a
 * business's toggle take effect everywhere at once (§22): there is no copy of
 * the list anywhere else to go stale, and a page left open on a customer's
 * phone shows the truth the moment they refresh.
 */

export interface PublicPaymentView {
  token: string;
  reference: string;
  businessName: string;
  description: string | null;
  amount: number;
  amountPaid: number;
  outstanding: number;
  currency: string;
  status: string;
  allowPartial: boolean;
  expiresAt: Date | null;
  payable: boolean;
  onlineEnabled: boolean;
  /** Why not, when it is not payable — so the page can say something useful. */
  unavailableReason: string | null;
  methods: { method: string; label: string; instructions: string | null }[];
  instructions: string;
  bankTransferInstructions: string;
  payUrl: string;
}

const OFFLINE_ONLY_METHODS = new Set(['WALLET', 'CASH_ON_DELIVERY']);

export async function publicPaymentView(token: string): Promise<PublicPaymentView> {
  const intent = await prismaUnscoped.paymentIntent.findUnique({ where: { token } });
  if (!intent) throw new NotFoundError('Payment');

  const [org, settings] = await Promise.all([
    prismaUnscoped.organization.findUnique({
      where: { id: intent.organizationId },
      select: { name: true, status: true, deletedAt: true, country: true },
    }),
    readPaymentSettings(intent.organizationId),
  ]);

  const outstanding = paymentIntentService.outstanding(intent);
  const expired = Boolean(intent.expiresAt && intent.expiresAt.getTime() < Date.now());

  // A payment code outlives the moment it was created — one printed on an
  // invoice may be scanned months later — so the business's standing is
  // checked now, not only when it was issued. A suspended or closed business
  // must not keep collecting.
  const collectible =
    Boolean(org) && !org!.deletedAt && (org!.status === 'ACTIVE' || org!.status === 'TRIAL');

  const payable = collectible && !expired && paymentIntentService.isPayable(intent);

  const unavailableReason = payable
    ? null
    : !collectible
      ? 'This business is not currently taking payments.'
      : intent.status === 'PAID' || intent.status === 'OVERPAID'
        ? 'This payment has already been settled.'
        : intent.status === 'CANCELLED'
          ? 'This payment request was cancelled.'
          : expired || intent.status === 'EXPIRED'
            ? 'This payment request has expired.'
            : outstanding <= 0.005
              ? 'There is nothing left to pay.'
              : 'This payment cannot be completed right now.';

  // Only resolve methods when there is actually something to pay — offering a
  // way to pay a settled bill is how a customer pays twice.
  const resolved = payable
    ? await paymentMethodsService.resolve({
        organizationId: intent.organizationId,
        currency: intent.currency,
        country: org?.country ?? null,
        amount: outstanding,
      })
    : null;

  return {
    token,
    reference: intent.reference,
    businessName: org?.name ?? 'Vhicasar Hub AI',
    description: intent.description,
    amount: Number(intent.amount),
    amountPaid: Number(intent.amountPaid),
    outstanding,
    currency: intent.currency,
    status: expired && intent.status === 'AWAITING_PAYMENT' ? 'EXPIRED' : intent.status,
    allowPartial: intent.allowPartial,
    expiresAt: intent.expiresAt,
    payable,
    onlineEnabled: Boolean(
      payable && resolved?.providerConnected && resolved.available.some((item) => !OFFLINE_ONLY_METHODS.has(item.method)),
    ),
    unavailableReason,
    methods: (resolved?.available ?? []).map((m) => ({
      method: m.method,
      label: m.label,
      instructions: m.instructions,
    })),
    instructions: settings.paymentInstructions,
    bankTransferInstructions: settings.bankTransferInstructions,
    payUrl: publicPayUrl(token),
  };
}

/** Start checkout for the canonical PaymentIntent used by AI invoices. */
export async function initiatePublicPayment(
  token: string,
  input: { email: string; amount?: number },
): Promise<{ authorizationUrl: string; reference: string }> {
  const intent = await prismaUnscoped.paymentIntent.findUnique({ where: { token } });
  if (!intent) throw new NotFoundError('Payment');
  const view = await publicPaymentView(token);
  if (!view.payable) throw new ValidationError(view.unavailableReason ?? 'This payment is not payable');

  const methods = await paymentMethodsService.resolve({
    organizationId: intent.organizationId,
    currency: intent.currency,
    amount: view.outstanding,
  });
  const provider = await resolveOrgProvider(intent.organizationId);
  const gatewayMethod = methods.available.find((item) => !OFFLINE_ONLY_METHODS.has(item.method));
  if (!provider || !methods.providerConnected || !gatewayMethod) {
    throw new ValidationError('Online payments are not configured for this business');
  }

  const amount = intent.allowPartial && input.amount
    ? Math.min(input.amount, view.outstanding)
    : view.outstanding;
  if (!(amount > 0)) throw new ValidationError('Nothing remains to be paid');
  const method = gatewayMethod.method;
  const initialized = await provider.initializeTransaction({
    email: input.email,
    amount: Math.round(amount * 100),
    reference: intent.reference,
    currency: intent.currency,
    callbackUrl: `${publicPayUrl(token)}?reference=${encodeURIComponent(intent.reference)}`,
    metadata: { kind: 'payment_intent', paymentIntentId: intent.id, organizationId: intent.organizationId },
  });
  await prismaUnscoped.paymentIntent.update({
    where: { id: intent.id },
    data: { status: 'PROCESSING', provider: provider.name, method },
  });
  return { authorizationUrl: initialized.authorizationUrl, reference: intent.reference };
}

/** Verify a browser return without trusting callback query data. */
export async function verifyPublicPayment(token: string, reference: string): Promise<PublicPaymentView> {
  const intent = await prismaUnscoped.paymentIntent.findUnique({ where: { token } });
  if (!intent) throw new NotFoundError('Payment');
  if (reference !== intent.reference || !intent.provider) throw new ValidationError('Invalid payment reference');
  const verified = await verifyWithProvider({
    organizationId: intent.organizationId,
    provider: intent.provider,
    reference,
  });
  if (!verified.ok) throw new ValidationError(verified.reason);
  const result = await paymentIntentService.applyTransaction({
    organizationId: intent.organizationId,
    paymentIntentId: intent.id,
    provider: intent.provider,
    providerRef: verified.providerRef,
    method: intent.method ?? 'CARD',
    amount: verified.amount,
    currency: verified.currency,
    fee: verified.fee,
    status: 'SUCCESS',
    paidAt: verified.paidAt,
  });
  if (result.applied) await settlePaymentIntent(intent.id, { becamePaid: result.becamePaid });
  return publicPaymentView(token);
}

/** The receipt behind a settled payment. */
export async function publicReceipt(token: string) {
  const intent = await prismaUnscoped.paymentIntent.findUnique({ where: { token } });
  if (!intent) throw new NotFoundError('Payment');
  if (intent.status !== 'PAID' && intent.status !== 'OVERPAID') {
    throw new NotFoundError('Receipt');
  }
  const org = await prismaUnscoped.organization.findUnique({
    where: { id: intent.organizationId },
    select: { name: true },
  });
  const transactions = await prismaUnscoped.paymentTransaction.findMany({
    where: { paymentIntentId: intent.id, status: 'SUCCESS' },
    orderBy: { createdAt: 'asc' },
    select: { amount: true, currency: true, method: true, paidAt: true, providerRef: true },
  });

  return {
    receiptNumber: receiptNumberFor(intent.reference),
    reference: intent.reference,
    businessName: org?.name ?? 'Vhicasar Hub AI',
    description: intent.description,
    amount: Number(intent.amount),
    amountPaid: Number(intent.amountPaid),
    currency: intent.currency,
    paidAt: intent.paidAt,
    payments: transactions.map((t) => ({
      amount: Number(t.amount),
      currency: t.currency,
      method: t.method,
      paidAt: t.paidAt,
      reference: t.providerRef,
    })),
  };
}
