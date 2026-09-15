import { describe, expect, it } from 'vitest';
import { PaystackClient } from '../../src/infrastructure/payments/paystack';
import { StripeClient } from '../../src/infrastructure/payments/stripe';

describe('subscription payment failure normalization', () => {
  it('captures Paystack subscription, reference, and customer-safe decline reason', () => {
    const event = new PaystackClient().parseWebhookEvent({
      event: 'invoice.payment_failed',
      data: {
        subscription: { subscription_code: 'SUB_123' },
        transaction: { reference: 'INV_123', gateway_response: 'Insufficient funds' },
      },
    });
    expect(event).toMatchObject({
      type: 'charge_failed', subscriptionCode: 'SUB_123', reference: 'INV_123', failureReason: 'Insufficient funds',
    });
  });

  it('captures Stripe invoice failure details', () => {
    const event = new StripeClient().parseWebhookEvent({
      type: 'invoice.payment_failed',
      data: { object: { id: 'in_123', subscription: 'sub_123', last_payment_error: { message: 'Card declined' } } },
    });
    expect(event).toMatchObject({
      type: 'charge_failed', subscriptionCode: 'sub_123', reference: 'in_123', failureReason: 'Card declined',
    });
  });
});
