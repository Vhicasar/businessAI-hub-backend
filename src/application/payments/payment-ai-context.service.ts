import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { paymentMethodsService } from './payment-methods.service';
import { readPaymentSettings } from './payment-settings.service';
import { paymentIntentService } from './payment-intent.service';

/**
 * What the assistant is allowed to say about paying (§11).
 *
 * Built from the same resolver the payment page uses, so the AI cannot offer a
 * method the business has switched off. Nothing here is a hint or a preference:
 * the assistant is told the exact list and told not to invent others, and the
 * server refuses anything outside it anyway if the model gets it wrong.
 */

export interface PaymentAiContext {
  /** Rendered for the prompt. */
  text: string;
  /** Whether the assistant may raise a payment request at all (§12). */
  canCreateRequests: boolean;
  methods: string[];
}

export async function buildPaymentAiContext(
  organizationId: string,
  customerId?: string | null
): Promise<PaymentAiContext> {
  const org = await prismaUnscoped.organization.findUnique({
    where: { id: organizationId },
    select: { currency: true, country: true, name: true },
  });
  const [resolved, settings] = await Promise.all([
    paymentMethodsService.resolve({
      organizationId,
      currency: org?.currency ?? 'NGN',
      country: org?.country ?? null,
    }),
    readPaymentSettings(organizationId),
  ]);

  const lines: string[] = [];

  if (resolved.available.length === 0) {
    lines.push(
      'This business is not currently accepting online payments. Do not offer any payment method. ' +
        'If asked how to pay, say you will connect them to the team to arrange it.'
    );
  } else {
    lines.push(
      'ACCEPTED PAYMENT METHODS (the ONLY ones you may ever mention or offer):',
      ...resolved.available.map(
        (m) => `- ${m.label}${m.instructions ? ` — ${m.instructions}` : ''}`
      )
    );
  }

  if (settings.paymentInstructions) {
    lines.push(`Payment instructions from the business: ${settings.paymentInstructions}`);
  }
  // Bank details only when transfer is genuinely on offer — reading out an
  // account number for a method the business has disabled invites payments it
  // is not expecting and will not reconcile.
  const transferOn = resolved.available.some(
    (m) => m.method === 'BANK_TRANSFER' || m.method === 'VIRTUAL_ACCOUNT'
  );
  if (transferOn && settings.bankTransferInstructions) {
    lines.push(`Bank transfer details: ${settings.bankTransferInstructions}`);
  }

  // What this customer actually owes, so "how much do I owe?" is answerable
  // without the model guessing.
  if (customerId) {
    const outstanding = await prismaUnscoped.paymentIntent.findMany({
      where: {
        organizationId,
        customerId,
        status: { in: ['AWAITING_PAYMENT', 'PROCESSING', 'PARTIALLY_PAID'] },
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
    if (outstanding.length > 0) {
      lines.push(
        'OUTSTANDING PAYMENTS for this customer:',
        ...outstanding.map(
          (p) =>
            `- ${p.reference}: ${p.currency} ${paymentIntentService
              .outstanding(p)
              .toFixed(2)} outstanding${p.description ? ` for ${p.description}` : ''}`
        )
      );
    }
  }

  lines.push(
    settings.aiCanCreatePaymentRequests
      ? 'You MAY create a payment request when the customer asks to pay for a specific order or ' +
          'invoice: return "paymentRequest" with the resourceType and resourceId. The server sets ' +
          'the amount from the record — never state an amount you were not given. You can NEVER ' +
          'confirm a payment; only the provider can. Say it is pending until confirmed.'
      : 'You may NOT create payment requests. Explain how to pay and offer to connect them to the team.'
  );

  return {
    text: lines.join('\n'),
    canCreateRequests: settings.aiCanCreatePaymentRequests,
    methods: resolved.available.map((m) => m.method),
  };
}
