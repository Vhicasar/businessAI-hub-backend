import { describe, expect, it } from 'vitest';
import {
  classifyCustomerIntent,
  isGeneralPurchaseRequest,
} from '../../src/application/ai/customer-intent-policy';

/**
 * Locks in the deterministic routing + action-authorization policy that guards
 * the AI chat assistant. These are the signals the server uses to (a) decide
 * whether a turn is a purchase/discovery vs a support case, and (b) authorize
 * consequential actions (ticket / handoff). Regressions here are what produced
 * "I couldn't find 'place a new order' in the catalogue" and silently-dropped
 * complaint tickets, so keep them green.
 */

// Mirrors the hybrid authorization in ai.service.ts: a ticket is allowed when
// the policy saw a complaint/explicit request, OR the model classified a support
// intent AND the policy is not positively protecting a sales/booking intent.
const MODEL_SUPPORT = new Set(['COMPLAINT', 'EXPLICIT_SUPPORT', 'HUMAN', 'ORDER_STATUS', 'ORDER_CHANGE']);
const POLICY_SALES = new Set(['PURCHASE', 'PRODUCT_DISCOVERY', 'CART_OR_CHECKOUT', 'SERVICE_BOOKING', 'PROPERTY_ENQUIRY']);
function ticketAuthorized(message: string, modelIntent: string): boolean {
  const policy = classifyCustomerIntent(message);
  const modelWantsSupport = MODEL_SUPPORT.has(modelIntent.toUpperCase());
  return policy.permitsTicket || (modelWantsSupport && !POLICY_SALES.has(policy.primary));
}

describe('classifyCustomerIntent — purchase vs discovery', () => {
  it('treats "place a new order" (with adjective) as a general purchase, not a product name', () => {
    expect(classifyCustomerIntent('I want to place a new order').primary).toBe('PURCHASE');
    expect(isGeneralPurchaseRequest('I want to place a new order')).toBe(true);
  });

  it.each([
    'i want to order',
    "I'd like to make an order",
    'can I order?',
    'I want to order something',
    'could I buy from you',
  ])('routes "%s" to general catalogue discovery', (msg) => {
    expect(isGeneralPurchaseRequest(msg)).toBe(true);
  });

  it('treats a specific quantity+item as a concrete purchase, not discovery', () => {
    expect(classifyCustomerIntent('I want 3 red shirts').primary).toBe('PURCHASE');
    expect(isGeneralPurchaseRequest('I want 3 red shirts')).toBe(false);
  });

  it('does not mistake "I want to speak to someone" for a product request', () => {
    const d = classifyCustomerIntent('I want to speak to someone');
    expect(d.primary).not.toBe('PURCHASE');
    expect(isGeneralPurchaseRequest('I want to speak to someone')).toBe(false);
  });
});

describe('classifyCustomerIntent — non-purchase intents', () => {
  it.each([
    ['where is my order #1234', 'ORDER_STATUS_OR_CHANGE'],
    ['can I speak to a human', 'HUMAN_HANDOFF'],
    ['how much do I owe on invoice 20', 'PAYMENT_OR_INVOICE'],
    ['I want to book a viewing tomorrow', 'PROPERTY_ENQUIRY'],
    ['show me your menu', 'PRODUCT_DISCOVERY'],
  ])('classifies "%s" as %s', (msg, expected) => {
    expect(classifyCustomerIntent(msg).primary).toBe(expected);
  });
});

describe('complaint detection + ticket authorization', () => {
  const regexCoveredComplaints = [
    'you sent the wrong size',
    'my laptop stopped working after one day',
    'the item is defective',
    'your service is terrible',
    "I'm really disappointed",
    'I want my money back',
    'this is unacceptable',
    'please open a support ticket',
  ];

  it.each(regexCoveredComplaints)('authorizes a ticket for "%s" on the deterministic signal alone', (msg) => {
    expect(classifyCustomerIntent(msg).permitsTicket).toBe(true);
    // Even if the model reported no intent, the policy alone authorizes it.
    expect(ticketAuthorized(msg, '')).toBe(true);
  });

  // Phrasings the keyword list still cannot anticipate: the model's complaint
  // classification must carry them through.
  const modelOnlyComplaints = [
    "I've been waiting a week and nothing",
    'the food was cold',
    'nobody has responded to me',
  ];

  it.each(modelOnlyComplaints)('authorizes a ticket for "%s" via the model when the keyword list misses it', (msg) => {
    expect(ticketAuthorized(msg, 'COMPLAINT')).toBe(true);
  });

  it('NEVER turns a sales/booking enquiry into a ticket, even if the model misfires', () => {
    for (const msg of ['I want to place a new order', 'do you have 3 bedroom apartments', 'I want to book a viewing']) {
      expect(ticketAuthorized(msg, 'COMPLAINT')).toBe(false);
    }
  });
});
