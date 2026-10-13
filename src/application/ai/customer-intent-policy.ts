export type CustomerIntent =
  | 'PURCHASE'
  | 'PRODUCT_DISCOVERY'
  | 'CART_OR_CHECKOUT'
  | 'ORDER_STATUS_OR_CHANGE'
  | 'PAYMENT_OR_INVOICE'
  | 'SERVICE_BOOKING'
  | 'PROPERTY_ENQUIRY'
  | 'COMPLAINT_OR_SUPPORT'
  | 'HUMAN_HANDOFF'
  | 'AMBIGUOUS';

export type IntentDecision = {
  primary: CustomerIntent;
  confidence: number;
  evidence: string[];
  permitsTicket: boolean;
  permitsHandoff: boolean;
  hasPurchaseIntent: boolean;
  hasComplaintIntent: boolean;
};

const test = (value: string, expression: RegExp) => expression.test(value);

/**
 * A deliberately small, auditable policy boundary around consequential AI
 * actions. The model can understand nuance and compose the reply, but it is
 * not allowed to turn an ordinary sales question into a support case.
 */
export function classifyCustomerIntent(message: string): IntentDecision {
  const value = message.normalize('NFKC').trim().toLowerCase();
  const evidence: string[] = [];

  const explicitTicket = test(value, /\b(open|create|raise|log|make)\s+(a\s+)?(support\s+)?(ticket|case)\b|\bsupport ticket\b/);
  const human = test(value, /\b(speak|talk|connect|transfer)\s+(me\s+)?(to|with)\s+(a\s+)?(human|person|agent|representative|staff|manager)\b|\bhuman agent\b/);
  const complaint = test(value, /\b(complain|complaint|damaged|broken|wrong item|never arrived|not arrived|missing order|charged twice|double charged|refund|not working|doesn'?t work|didn'?t work|cold food|poor service|bad service|problem with|issue with)\b/);
  const existingOrder = test(value, /\b(where|track|status|cancel|change|modify|return)\b.{0,30}\b(my\s+)?order\b|\b(my\s+)?order\b.{0,30}\b(where|track|status|cancel|change|modify|arrive|delivered)\b/);
  const payment = test(value, /\b(invoice|receipt|how much do i owe|pay now|payment status|received my payment|charged)\b/);
  const booking = test(value, /\b(book|booking|schedule|appointment|reserve|reservation|available (time|slot)|consultation)\b/);
  const property = test(value, /\b(property|properties|house|apartment|flat|land|bedroom|viewing|rent|real estate)\b/);
  const cart = test(value, /\b(cart|checkout|remove .+ from|add .+ to|change (the )?quantity)\b/);
  const asksForNamedThing = test(value, /\b(i\s+)?(want|need|would like)\s+(?!help\b|support\b|a refund\b|to complain\b)(?:to\s+(?:get|have)\s+)?(?:some\s+)?(?:\d+\s+)?[a-z][a-z0-9 '-]{1,50}$/);
  const purchase = test(value,
    /\b(place|make|start)\s+(an?\s+)?order\b|\b(i\s+)?(want|need|would like|i'?ll take|can i get)\b.{0,50}\b(buy|order|purchase|plates?|pieces?|packs?|units?|bottles?|bags?|cups?)\b|\b(buy|purchase|order)\b.{0,60}\b(product|item|food|something|one|two|three|four|five|six|seven|eight|nine|ten|\d+)\b|\b(want|need|give me|get me)\s+\d+\b/,
  ) || asksForNamedThing;
  const discovery = test(value, /\b(show|browse|see|looking for|what do you (sell|have|offer)|catalog(?:ue)?|menu|products?|available items?)\b/);

  if (explicitTicket) evidence.push('explicit_ticket_request');
  if (human) evidence.push('explicit_human_request');
  if (complaint) evidence.push('complaint_or_problem');
  if (purchase) evidence.push('purchase_language');
  if (existingOrder) evidence.push('existing_order_reference');

  let primary: CustomerIntent = 'AMBIGUOUS';
  let confidence = 0.45;
  if (explicitTicket || complaint) { primary = 'COMPLAINT_OR_SUPPORT'; confidence = explicitTicket ? 0.99 : 0.9; }
  else if (human) { primary = 'HUMAN_HANDOFF'; confidence = 0.99; }
  else if (existingOrder) { primary = 'ORDER_STATUS_OR_CHANGE'; confidence = 0.9; }
  else if (payment) { primary = 'PAYMENT_OR_INVOICE'; confidence = 0.86; }
  else if (property) { primary = 'PROPERTY_ENQUIRY'; confidence = 0.82; }
  else if (booking) { primary = 'SERVICE_BOOKING'; confidence = 0.84; }
  else if (cart) { primary = 'CART_OR_CHECKOUT'; confidence = 0.86; }
  else if (purchase) { primary = 'PURCHASE'; confidence = 0.92; }
  else if (discovery) { primary = 'PRODUCT_DISCOVERY'; confidence = 0.82; }

  return {
    primary,
    confidence,
    evidence,
    permitsTicket: explicitTicket || complaint,
    permitsHandoff: explicitTicket || complaint || human,
    hasPurchaseIntent: purchase,
    hasComplaintIntent: explicitTicket || complaint,
  };
}

export function isGeneralPurchaseRequest(message: string): boolean {
  const decision = classifyCustomerIntent(message);
  if (decision.primary !== 'PURCHASE') return false;
  const value = message.toLowerCase();
  return /\b(place|make|start)\s+(an?\s+)?order\b|\b(want|would like|need)\s+to\s+(order|buy|purchase)\b|\bbuy something\b/.test(value)
    && !/\b\d+\s+[a-z]/.test(value);
}
