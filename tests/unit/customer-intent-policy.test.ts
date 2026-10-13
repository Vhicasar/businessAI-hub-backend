import { describe, expect, it } from 'vitest';
import { classifyCustomerIntent, isGeneralPurchaseRequest } from '../../src/application/ai/customer-intent-policy';

describe('customer AI intent policy', () => {
  it.each([
    'I want to place an order',
    'I want 5 plates of rice',
    'Can I buy 2 bottles?',
    'I want jollof rice',
  ])('routes purchase language without permitting a support ticket: %s', (message) => {
    const result = classifyCustomerIntent(message);
    expect(result.primary).toBe('PURCHASE');
    expect(result.permitsTicket).toBe(false);
  });

  it('recognizes a broad purchase request that should show the live catalogue', () => {
    expect(isGeneralPurchaseRequest('I want to place an order')).toBe(true);
    expect(isGeneralPurchaseRequest('I want 5 plates of rice')).toBe(false);
  });

  it.each([
    'My order never arrived',
    'I was charged twice',
    'Please create a support ticket',
    'The product is damaged',
  ])('permits a ticket only for a genuine issue or explicit request: %s', (message) => {
    expect(classifyCustomerIntent(message).permitsTicket).toBe(true);
  });

  it('does not classify an existing-order query as a new purchase', () => {
    const result = classifyCustomerIntent('Where is my order?');
    expect(result.primary).toBe('ORDER_STATUS_OR_CHANGE');
    expect(result.hasPurchaseIntent).toBe(false);
  });

  it('keeps property enquiries out of support', () => {
    const result = classifyCustomerIntent('I am looking for a three bedroom apartment to rent');
    expect(result.primary).toBe('PROPERTY_ENQUIRY');
    expect(result.permitsTicket).toBe(false);
  });

  it('asks for clarification rather than authorizing an arbitrary ticket', () => {
    const result = classifyCustomerIntent('Can you help me?');
    expect(result.primary).toBe('AMBIGUOUS');
    expect(result.permitsTicket).toBe(false);
  });
});
