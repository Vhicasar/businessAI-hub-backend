import { describe, expect, it } from 'vitest';
import {
  BUILTIN_RECEIPT_TEMPLATES,
  renderReceiptHtml,
  renderReceiptText,
  resolveTemplate,
  type ReceiptData,
} from '../../src/application/payments/receipt-document.service';

/**
 * One receipt, three places.
 *
 * The public link, the emailed copy and the business's own order screen all
 * render from this, so what is asserted here is what all three show.
 */

const receipt = (overrides: Partial<ReceiptData> = {}): ReceiptData => ({
  receiptNumber: 'VH-RC-ABC1234',
  reference: 'VH-PI-ABC1234',
  orderNumber: 'ORD-2026-0148',
  invoiceNumber: 'INV-2026-0045',
  issuedAt: '2026-10-14T09:00:00.000Z',
  status: 'PAID',
  currency: 'NGN',
  business: {
    name: 'Harmattan Beverages',
    email: 'hello@example.example',
    phone: '+2341000000000',
    website: null,
    addressLines: '1 Market Road\nLagos',
    footer: null,
  },
  customer: { name: 'Adaeze Okonkwo', email: 'adaeze@example.example', phone: '+2348031000101' },
  fulfilment: { method: 'DELIVERY', address: '12 Allen Avenue, Ikeja, NG', instructions: 'Blue gate' },
  items: [{ name: 'Citra Lime 50cl', sku: 'FG-CIT50', quantity: 400, unitPrice: 4640, total: 1_856_000 }],
  subtotal: 1_856_000,
  discount: 0,
  tax: 139_200,
  delivery: 45_000,
  total: 2_040_200,
  amountPaid: 2_040_200,
  outstanding: 0,
  payments: [{ amount: 2_040_200, method: 'CARD', provider: 'paystack', paidAt: '2026-10-14T09:00:00.000Z', reference: 'ps_123' }],
  payUrl: null,
  template: BUILTIN_RECEIPT_TEMPLATES[0]!,
  ...overrides,
});

describe('receipt template resolution', () => {
  it('uses the business’s chosen built-in design', () => {
    const chosen = resolveTemplate('receipt-compact');
    expect(chosen.id).toBe('receipt-compact');
    expect(chosen.paperWidth).toBe('58mm');
    expect(chosen.showSku).toBe(false);
  });

  it('uses a custom design the business defined', () => {
    const chosen = resolveTemplate('house-style', [
      { id: 'house-style', name: 'House', accent: '00aa88', layout: 'modern', font: 'serif', showCustomer: false, showSku: true, paperWidth: 'a4' },
    ]);
    expect(chosen.name).toBe('House');
    // Stored without the hash, used with it, so the CSS is valid either way.
    expect(chosen.accent).toBe('#00aa88');
    expect(chosen.showCustomer).toBe(false);
  });

  it('falls back to the default rather than rendering nothing', () => {
    expect(resolveTemplate(undefined).id).toBe('receipt-classic');
    expect(resolveTemplate('a-design-that-was-deleted').id).toBe('receipt-classic');
  });
});

describe('rendered receipt', () => {
  it('carries the business, the amounts and the references', async () => {
    const html = await renderReceiptHtml(receipt());
    expect(html).toContain('Harmattan Beverages');
    expect(html).toContain('VH-RC-ABC1234');
    expect(html).toContain('ORD-2026-0148');
    expect(html).toContain('INV-2026-0045');
    expect(html).toContain('Citra Lime 50cl');
    expect(html).toContain('FG-CIT50');
    expect(html).toContain('Paid');
  });

  it('shows the delivery charge as its own line, not folded into the total', async () => {
    const html = await renderReceiptHtml(receipt());
    expect(html).toContain('Delivery');
    expect(html).toContain('12 Allen Avenue, Ikeja, NG');
  });

  it('calls the fee collection when the customer collected', async () => {
    const html = await renderReceiptHtml(
      receipt({ fulfilment: { method: 'PICKUP', address: null, instructions: null }, delivery: 250 }),
    );
    expect(html).toContain('Collection');
    expect(html).not.toContain('12 Allen Avenue');
  });

  it('hides the customer when the chosen design says to', async () => {
    const html = await renderReceiptHtml(
      receipt({ template: { ...BUILTIN_RECEIPT_TEMPLATES[0]!, showCustomer: false } }),
    );
    expect(html).not.toContain('Adaeze Okonkwo');
  });

  it('escapes anything a customer typed, so a name cannot close a tag', async () => {
    const html = await renderReceiptHtml(
      receipt({ customer: { name: '<script>alert(1)</script>', email: null, phone: null } }),
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('shows a balance and a way to pay it only when one is owed', async () => {
    const settled = await renderReceiptHtml(receipt());
    expect(settled).not.toContain('Scan to pay the balance');

    const partial = await renderReceiptHtml(
      receipt({ status: 'PART_PAID', amountPaid: 1_000_000, outstanding: 1_040_200, payUrl: 'https://example.test/pay/tok' }),
    );
    expect(partial).toContain('Scan to pay the balance');
    expect(partial).toContain('Part paid');
    expect(partial).toContain('Outstanding');
  });

  it('has a plain-text twin for mail clients that refuse HTML', () => {
    const text = renderReceiptText(receipt());
    expect(text).toContain('Receipt VH-RC-ABC1234');
    expect(text).toContain('400 x Citra Lime 50cl');
    expect(text).toContain('Delivery');
    expect(text).not.toContain('<');
  });
});
