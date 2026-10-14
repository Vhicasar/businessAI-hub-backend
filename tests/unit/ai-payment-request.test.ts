import { describe, expect, it } from 'vitest';
import { formatAiPaymentRequest, type AiOrderPaymentRequest } from '../../src/application/payments/ai-payment-request.service';

const request: AiOrderPaymentRequest = {
  invoiceId: 'invoice-1',
  invoiceNumber: 'INV-2026-00001',
  amount: 400,
  currency: 'NGN',
  reference: 'VH-PI-TEST123',
  payUrl: 'https://example.test/pay/token',
  invoiceUrl: 'https://example.test/pay/token/invoice',
  autoReceipts: true,
};

describe('AI payment request presentation', () => {
  it('includes authoritative invoice and payment links', () => {
    const text = formatAiPaymentRequest(request);
    expect(text).toContain('invoice INV-2026-00001');
    expect(text).toContain('[View invoice](https://example.test/pay/token/invoice)');
    expect(text).toContain('[Pay now](https://example.test/pay/token)');
    expect(text).toContain('NGN 400');
  });

  it('mentions the receipt only when automatic receipts are enabled', () => {
    expect(formatAiPaymentRequest(request)).toContain("Once your payment is confirmed, you'll receive a receipt.");
    const disabled = formatAiPaymentRequest({ ...request, autoReceipts: false });
    expect(disabled).not.toMatch(/receipt/i);
    expect(disabled).toContain('[Pay now]');
  });
});
