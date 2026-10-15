import QRCode from 'qrcode';
import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { NotFoundError } from '../../shared/errors';
import { receiptNumberFor } from './payment-receipt.service';
import { publicPayUrl } from './payment-intent.service';

/**
 * The receipt, built once, on this side.
 *
 * It used to be built three ways. The business's order screen assembled one in
 * the browser from data it already had, using the business's chosen template;
 * the public link had no page at all; and the email had a single line of text
 * with a URL in it. Three implementations, two of them missing, and no reason
 * for any of them to agree.
 *
 * So the document is rendered here and served to all three. The template, the
 * accent colour, the paper width, whether to show the customer or the SKU —
 * all of it comes from the business's receipt settings, which already existed
 * and were only ever read by the browser.
 */

export type ReceiptLayout = 'classic' | 'compact' | 'modern' | 'elegant' | 'bold';
export type ReceiptFont = 'sans' | 'serif' | 'mono';
export type PaperWidth = '80mm' | '58mm' | 'a4';

export interface ReceiptTemplate {
  id: string;
  name: string;
  accent: string;
  layout: ReceiptLayout;
  font: ReceiptFont;
  footer?: string;
  showCustomer: boolean;
  showSku: boolean;
  paperWidth: PaperWidth;
}

/**
 * The built-in designs.
 *
 * Kept identical to the five the settings page offers, so a business that
 * picked "Compact POS" there gets the compact receipt here and not a default
 * that silently ignores the choice.
 */
export const BUILTIN_RECEIPT_TEMPLATES: ReceiptTemplate[] = [
  { id: 'receipt-classic', name: 'Classic', accent: '#f97316', layout: 'classic', font: 'sans', showCustomer: true, showSku: true, paperWidth: '80mm' },
  { id: 'receipt-compact', name: 'Compact POS', accent: '#111827', layout: 'compact', font: 'mono', showCustomer: true, showSku: false, paperWidth: '58mm' },
  { id: 'receipt-modern', name: 'Modern', accent: '#0d9488', layout: 'modern', font: 'sans', showCustomer: true, showSku: true, paperWidth: '80mm' },
  { id: 'receipt-elegant', name: 'Elegant', accent: '#7c3aed', layout: 'elegant', font: 'serif', showCustomer: true, showSku: false, paperWidth: 'a4' },
  { id: 'receipt-bold', name: 'Bold Retail', accent: '#dc2626', layout: 'bold', font: 'sans', showCustomer: true, showSku: true, paperWidth: '80mm' },
];

export interface ReceiptBusiness {
  name: string;
  email: string | null;
  phone: string | null;
  website: string | null;
  addressLines: string | null;
  footer: string | null;
}

export interface ReceiptLine {
  name: string;
  sku: string | null;
  quantity: number;
  unitPrice: number;
  total: number;
}

/** Everything the three channels agree on. */
export interface ReceiptData {
  receiptNumber: string;
  reference: string;
  orderNumber: string | null;
  invoiceNumber: string | null;
  issuedAt: string;
  status: 'PAID' | 'PART_PAID';
  currency: string;
  business: ReceiptBusiness;
  customer: { name: string; email: string | null; phone: string | null } | null;
  fulfilment: { method: 'PICKUP' | 'DELIVERY' | null; address: string | null; instructions: string | null };
  items: ReceiptLine[];
  subtotal: number;
  discount: number;
  tax: number;
  delivery: number;
  total: number;
  amountPaid: number;
  outstanding: number;
  payments: { amount: number; method: string | null; provider: string | null; paidAt: string | null; reference: string | null }[];
  /** Only present while a balance remains; a paid receipt carries no pay code. */
  payUrl: string | null;
  template: ReceiptTemplate;
}

const esc = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const money = (currency: string, amount: number): string => {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
};

const n = (value: unknown): number => Number(value ?? 0);
const round2 = (v: number): number => Math.round(v * 100) / 100;

/** The business's chosen design, custom ones included. */
export function resolveTemplate(
  id: string | undefined,
  custom: Partial<ReceiptTemplate>[] = [],
): ReceiptTemplate {
  const fallback = BUILTIN_RECEIPT_TEMPLATES[0]!;
  const found =
    BUILTIN_RECEIPT_TEMPLATES.find((t) => t.id === id) ??
    custom.find((t) => t.id === id);
  if (!found) return fallback;
  return {
    id: found.id ?? fallback.id,
    name: found.name ?? fallback.name,
    accent: (found.accent ?? fallback.accent).startsWith('#') ? found.accent! : `#${found.accent}`,
    layout: (found.layout as ReceiptLayout) ?? fallback.layout,
    font: (found.font as ReceiptFont) ?? fallback.font,
    footer: found.footer,
    showCustomer: found.showCustomer ?? true,
    showSku: found.showSku ?? true,
    paperWidth: (found.paperWidth as PaperWidth) ?? fallback.paperWidth,
  };
}

/**
 * Gather the receipt for a settled payment intent.
 *
 * Reads what was persisted — the intent, its transactions, the order behind it
 * and the business's own settings. Nothing is passed in from a page, which is
 * why the same call works from a public link with no session, from a webhook
 * with no request context, and from the business's own order screen.
 */
export async function buildReceiptForIntent(intentId: string): Promise<ReceiptData> {
  const intent = await prismaUnscoped.paymentIntent.findUnique({ where: { id: intentId } });
  if (!intent) throw new NotFoundError('Payment');
  if (intent.status !== 'PAID' && intent.status !== 'OVERPAID' && intent.status !== 'PARTIALLY_PAID') {
    throw new NotFoundError('Receipt');
  }

  let orderId = intent.orderId;
  let invoiceNumber: string | null = null;
  if (intent.invoiceId) {
    const invoice = await prismaUnscoped.invoice.findUnique({
      where: { id: intent.invoiceId },
      select: { number: true, orderId: true },
    });
    invoiceNumber = invoice?.number ?? null;
    orderId = orderId ?? invoice?.orderId ?? null;
  }

  const [org, order, transactions] = await Promise.all([
    prismaUnscoped.organization.findUnique({
      where: { id: intent.organizationId },
      select: {
        name: true, email: true, phone: true, website: true, settings: true,
        addressLine1: true, addressLine2: true, city: true, state: true,
        postalCode: true, country: true,
      },
    }),
    orderId
      ? prismaUnscoped.order.findUnique({
          where: { id: orderId },
          include: {
            items: true,
            customer: { select: { firstName: true, lastName: true, email: true, phone: true } },
            invoices: { where: { deletedAt: null, status: { not: 'VOID' } }, select: { number: true }, take: 1 },
          },
        })
      : null,
    prismaUnscoped.paymentTransaction.findMany({
      where: { paymentIntentId: intent.id, status: 'SUCCESS' },
      orderBy: { createdAt: 'asc' },
      select: { amount: true, method: true, provider: true, paidAt: true, providerRef: true },
    }),
  ]);

  const invoicing = ((org?.settings as Record<string, any>) ?? {}).invoicing ?? {};
  const template = resolveTemplate(invoicing.defaultReceiptTemplateId, invoicing.customReceiptTemplates ?? []);

  const addressLines =
    invoicing.business?.addressLines ??
    [org?.addressLine1, org?.addressLine2, [org?.city, org?.state, org?.postalCode].filter(Boolean).join(', '), org?.country]
      .filter(Boolean)
      .join('\n');

  const business: ReceiptBusiness = {
    name: invoicing.business?.name ?? org?.name ?? 'Vhicasar Hub AI',
    email: invoicing.business?.email ?? org?.email ?? null,
    phone: invoicing.business?.phone ?? org?.phone ?? null,
    website: invoicing.business?.website ?? org?.website ?? null,
    addressLines: addressLines || null,
    footer: invoicing.business?.footer ?? null,
  };

  // The customer as recorded for *this* order where there is one, because the
  // name and number given at checkout is what the receipt is for.
  const contactName = order?.contactName?.trim();
  const profileName = order?.customer
    ? `${order.customer.firstName} ${order.customer.lastName ?? ''}`.trim()
    : null;
  const customer =
    contactName || profileName
      ? {
          name: contactName || profileName || '',
          email: order?.contactEmail ?? order?.customer?.email ?? null,
          phone: order?.contactPhone ?? order?.customer?.phone ?? null,
        }
      : null;

  const snapshot = (order?.deliverySnapshot as Record<string, any> | null) ?? null;
  const delivery = order ? n(order.shippingTotal) : 0;

  const items: ReceiptLine[] = order
    ? order.items.map((i) => ({
        name: i.name,
        sku: i.sku,
        quantity: n(i.quantity),
        unitPrice: n(i.unitPrice),
        total: n(i.total),
      }))
    : [
        // A payment with no order behind it — a bill, a deposit — still needs a
        // line, and its own description is the truest one available.
        {
          name: intent.description ?? 'Payment',
          sku: null,
          quantity: 1,
          unitPrice: n(intent.amount),
          total: n(intent.amount),
        },
      ];

  const total = order ? n(order.total) : n(intent.amount);
  const amountPaid = n(intent.amountPaid);
  const outstanding = round2(Math.max(0, total - amountPaid));

  return {
    receiptNumber: receiptNumberFor(intent.reference),
    reference: intent.reference,
    orderNumber: order?.number ?? null,
    invoiceNumber: invoiceNumber ?? order?.invoices?.[0]?.number ?? null,
    issuedAt: (intent.paidAt ?? transactions[0]?.paidAt ?? intent.updatedAt).toISOString(),
    status: outstanding > 0.005 ? 'PART_PAID' : 'PAID',
    currency: intent.currency,
    business,
    customer,
    fulfilment: {
      method: order?.fulfillmentMethod ?? null,
      address: snapshot?.formatted ?? null,
      instructions: snapshot?.instructions || null,
    },
    items,
    subtotal: order ? n(order.subtotal) : n(intent.amount),
    discount: order ? n(order.discountTotal) : 0,
    tax: order ? n(order.taxTotal) : 0,
    delivery,
    total,
    amountPaid,
    outstanding,
    payments: transactions.map((t) => ({
      amount: n(t.amount),
      method: t.method,
      provider: t.provider,
      paidAt: t.paidAt ? t.paidAt.toISOString() : null,
      reference: t.providerRef,
    })),
    payUrl: outstanding > 0.005 && intent.token ? publicPayUrl(intent.token) : null,
    template,
  };
}

/**
 * The same receipt, for a link raised before Payment Intents existed.
 *
 * Older invoice and order QR codes still mint `PaymentLink` rows, and those
 * tokens are printed on paper that is still in circulation. They get the
 * business's configured receipt too rather than a second, thinner one.
 */
export async function buildReceiptForLegacyLink(token: string): Promise<ReceiptData> {
  const link = await prismaUnscoped.paymentLink.findUnique({ where: { token } });
  if (!link) throw new NotFoundError('Payment link');

  const [org, payments] = await Promise.all([
    prismaUnscoped.organization.findUnique({
      where: { id: link.organizationId },
      select: {
        name: true, email: true, phone: true, website: true, settings: true,
        addressLine1: true, addressLine2: true, city: true, state: true,
        postalCode: true, country: true,
      },
    }),
    prismaUnscoped.payment.findMany({
      where: {
        organizationId: link.organizationId,
        status: 'PAID',
        metadata: { path: ['token'], equals: token },
      },
      orderBy: { paidAt: 'asc' },
    }),
  ]);
  const latest = payments[payments.length - 1];
  if (!latest) throw new NotFoundError('Receipt');

  const invoicing = ((org?.settings as Record<string, any>) ?? {}).invoicing ?? {};
  const template = resolveTemplate(invoicing.defaultReceiptTemplateId, invoicing.customReceiptTemplates ?? []);
  const addressLines =
    invoicing.business?.addressLines ??
    [org?.addressLine1, org?.addressLine2, [org?.city, org?.state, org?.postalCode].filter(Boolean).join(', '), org?.country]
      .filter(Boolean)
      .join('\n');

  const total = n(link.amount);
  const amountPaid = round2(payments.reduce((sum, p) => sum + n(p.amount), 0));
  const meta = (latest.metadata as Record<string, unknown>) ?? {};

  return {
    receiptNumber: (meta.receiptNumber as string) ?? latest.id,
    reference: (meta.reference as string) ?? link.token.slice(0, 10),
    orderNumber: null,
    invoiceNumber: null,
    issuedAt: (latest.paidAt ?? latest.createdAt).toISOString(),
    status: total - amountPaid > 0.005 ? 'PART_PAID' : 'PAID',
    currency: latest.currency,
    business: {
      name: invoicing.business?.name ?? org?.name ?? 'Vhicasar Hub AI',
      email: invoicing.business?.email ?? org?.email ?? null,
      phone: invoicing.business?.phone ?? org?.phone ?? null,
      website: invoicing.business?.website ?? org?.website ?? null,
      addressLines: addressLines || null,
      footer: invoicing.business?.footer ?? null,
    },
    customer: null,
    fulfilment: { method: null, address: null, instructions: null },
    items: [
      {
        name: link.description ?? 'Payment',
        sku: null,
        quantity: 1,
        unitPrice: total,
        total,
      },
    ],
    subtotal: total,
    discount: 0,
    tax: 0,
    delivery: 0,
    total,
    amountPaid,
    outstanding: round2(Math.max(0, total - amountPaid)),
    payments: payments.map((p) => ({
      amount: n(p.amount),
      method: p.method,
      provider: p.provider,
      paidAt: p.paidAt ? p.paidAt.toISOString() : null,
      reference: p.providerRef,
    })),
    payUrl: null,
    template,
  };
}

/** The same document, as a standalone page that can be printed or emailed. */
export async function renderReceiptHtml(receipt: ReceiptData): Promise<string> {
  const t = receipt.template;
  const dense = t.layout === 'compact';
  const bold = t.layout === 'bold';
  const modern = t.layout === 'modern';
  const width = t.paperWidth === '58mm' ? '300px' : t.paperWidth === 'a4' ? '760px' : '420px';
  const font =
    t.font === 'serif'
      ? 'Georgia,serif'
      : t.font === 'mono'
        ? 'ui-monospace,SFMono-Regular,monospace'
        : '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';

  const contact = [receipt.business.addressLines, receipt.business.phone, receipt.business.email, receipt.business.website]
    .filter(Boolean)
    .map((v) => esc(String(v)).replace(/\n/g, '<br>'))
    .join('<br>');

  const rows = receipt.items
    .map(
      (item) =>
        `<tr><td><b>${esc(item.name)}</b>${t.showSku && item.sku ? `<small>${esc(item.sku)}</small>` : ''}</td>` +
        `<td>${item.quantity}</td><td>${money(receipt.currency, item.unitPrice)}</td>` +
        `<td>${money(receipt.currency, item.total)}</td></tr>`,
    )
    .join('');

  const totalRow = (label: string, value: number, strong = false) =>
    `<div class="total ${strong ? 'grand' : ''}"><span>${esc(label)}</span><b>${money(receipt.currency, value)}</b></div>`;

  const fulfilmentPanel = receipt.fulfilment.method
    ? `<section class="customer"><label>${receipt.fulfilment.method === 'PICKUP' ? 'Collection' : 'Delivery'}</label>` +
      `<p>${esc(receipt.fulfilment.address ?? (receipt.fulfilment.method === 'PICKUP' ? 'Collection from the business' : ''))}</p>` +
      `${receipt.fulfilment.instructions ? `<p><small>${esc(receipt.fulfilment.instructions)}</small></p>` : ''}</section>`
    : '';

  const payPanel = receipt.payUrl
    ? `<section class="paypanel"><div>${await qrImage(receipt.payUrl)}</div><div>
        <div class="payhead">Scan to pay the balance</div>
        <div class="paybody">${money(receipt.currency, receipt.outstanding)} still owing.</div>
      </div></section>`
    : '';

  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Receipt ${esc(receipt.receiptNumber)}</title><style>
*{box-sizing:border-box}
body{margin:0;background:#eef1f5;color:#172b4d;font:${dense ? 11 : 13}px ${font}}
.sheet{width:${width};max-width:100%;min-height:580px;margin:24px auto;background:#fff;padding:${dense ? '20px 16px' : '34px 30px'};box-shadow:0 8px 30px #172b4d22;border-top:${bold ? `10px solid ${t.accent}` : '0'}}
.brand{text-align:${t.layout === 'elegant' ? 'left' : 'center'};border-bottom:${modern ? '0' : `2px solid ${t.accent}`};background:${modern ? `${t.accent}12` : 'transparent'};padding:${modern ? '18px' : '0 0 20px'};border-radius:${modern ? '12px' : '0'}}
.brand h1{font-size:${bold ? 26 : 22}px;margin:0 0 6px;color:${bold ? t.accent : 'inherit'}}
.brand p{margin:0;color:#6b778c;line-height:1.55}
.meta{display:grid;grid-template-columns:1fr 1fr;gap:${dense ? 7 : 14}px;margin:${dense ? '12px 0' : '20px 0'};padding:${dense ? 8 : 13}px;background:${t.accent}12;border-radius:8px}
.meta label,.customer label{display:block;color:#6b778c;font-size:9px;text-transform:uppercase;letter-spacing:.08em;margin-bottom:3px}
.customer{padding:0 0 16px}.customer p{margin:2px 0}
table{width:100%;border-collapse:collapse;margin:4px 0 16px}
th{text-align:left;font-size:9px;text-transform:uppercase;color:#6b778c;border-bottom:1px solid #dfe1e6;padding:8px 4px}
th:not(:first-child),td:not(:first-child){text-align:right}
td{padding:${dense ? 6 : 10}px 4px;border-bottom:1px dashed #dfe1e6;vertical-align:top}
td small{display:block;color:#6b778c;margin-top:2px}
.totals{margin-left:auto;width:${dense ? '100%' : '72%'}}
.total{display:flex;justify-content:space-between;padding:5px 0}
.grand{border-top:${bold ? `4px solid ${t.accent}` : '2px solid #172b4d'};margin-top:5px;padding-top:10px;font-size:${bold ? 21 : 17}px}
.paid{color:#15803d}
.footer{text-align:center;color:#6b778c;border-top:1px dashed #c7ccd5;margin-top:24px;padding-top:18px;font-size:10px}
.badge{display:inline-block;background:#dcfce7;color:#166534;padding:4px 9px;border-radius:12px;font-weight:700;font-size:9px;text-transform:uppercase}
.paypanel{display:flex;gap:14px;align-items:center;margin-top:20px;padding:12px;border:1px solid ${t.accent}33;border-radius:10px;background:${t.accent}0a}
.payhead{font-weight:700;color:${t.accent};margin-bottom:3px}
.paybody{font-size:10px;color:#555;line-height:1.5;max-width:230px}
@media print{body{background:#fff}.sheet{width:100%;margin:0;box-shadow:none;padding:6mm}}
@media (max-width:460px){.sheet{margin:0;padding:18px 14px;box-shadow:none}.meta{grid-template-columns:1fr}.totals{width:100%}}
</style></head><body><main class="sheet">
<header class="brand"><h1>${esc(receipt.business.name)}</h1>${contact ? `<p>${contact}</p>` : ''}</header>
<section class="meta">
  <div><label>Receipt</label><b>${esc(receipt.receiptNumber)}</b></div>
  <div><label>Date</label><b>${esc(new Date(receipt.issuedAt).toLocaleString('en-GB'))}</b></div>
  <div><label>Payment</label>${esc((receipt.payments[0]?.method ?? 'PAID').replace(/_/g, ' '))}</div>
  <div><label>Status</label><span class="badge">${receipt.status === 'PAID' ? 'Paid' : 'Part paid'}</span></div>
  ${receipt.orderNumber ? `<div><label>Order</label>${esc(receipt.orderNumber)}</div>` : ''}
  ${receipt.invoiceNumber ? `<div><label>Invoice</label>${esc(receipt.invoiceNumber)}</div>` : ''}
</section>
${t.showCustomer && receipt.customer ? `<section class="customer"><label>Customer</label><p><b>${esc(receipt.customer.name)}</b></p>${receipt.customer.email ? `<p>${esc(receipt.customer.email)}</p>` : ''}${receipt.customer.phone ? `<p>${esc(receipt.customer.phone)}</p>` : ''}</section>` : ''}
${fulfilmentPanel}
<table><thead><tr><th>Item</th><th>Qty</th><th>Price</th><th>Total</th></tr></thead><tbody>${rows}</tbody></table>
<section class="totals">
  ${totalRow('Subtotal', receipt.subtotal)}
  ${receipt.discount ? totalRow('Discount', -receipt.discount) : ''}
  ${receipt.tax ? totalRow('Tax', receipt.tax) : ''}
  ${receipt.delivery ? totalRow(receipt.fulfilment.method === 'PICKUP' ? 'Collection' : 'Delivery', receipt.delivery) : ''}
  ${totalRow('Total', receipt.total, true)}
  <div class="total paid"><span>Paid</span><b>${money(receipt.currency, receipt.amountPaid)}</b></div>
  ${receipt.outstanding > 0.005 ? totalRow('Outstanding', receipt.outstanding) : ''}
</section>
${payPanel}
<footer class="footer">${esc(t.footer || receipt.business.footer || 'Thank you for your business.')}<br>Powered by Vhicasar Hub AI</footer>
</main></body></html>`;
}

/** Inline so the receipt survives being saved, forwarded or printed offline. */
async function qrImage(url: string): Promise<string> {
  try {
    const dataUrl = await QRCode.toDataURL(url, { margin: 1, width: 110 });
    return `<img src="${dataUrl}" width="110" height="110" alt="Payment QR code">`;
  } catch {
    return '';
  }
}

/** A plain-text rendering, for mail clients that refuse HTML. */
export function renderReceiptText(receipt: ReceiptData): string {
  const lines = [
    `${receipt.business.name}`,
    `Receipt ${receipt.receiptNumber}`,
    receipt.orderNumber ? `Order ${receipt.orderNumber}` : '',
    new Date(receipt.issuedAt).toLocaleString('en-GB'),
    '',
    ...receipt.items.map((i) => `${i.quantity} x ${i.name} — ${money(receipt.currency, i.total)}`),
    '',
    `Subtotal: ${money(receipt.currency, receipt.subtotal)}`,
    receipt.discount ? `Discount: -${money(receipt.currency, receipt.discount)}` : '',
    receipt.tax ? `Tax: ${money(receipt.currency, receipt.tax)}` : '',
    receipt.delivery ? `${receipt.fulfilment.method === 'PICKUP' ? 'Collection' : 'Delivery'}: ${money(receipt.currency, receipt.delivery)}` : '',
    `Total: ${money(receipt.currency, receipt.total)}`,
    `Paid: ${money(receipt.currency, receipt.amountPaid)}`,
    receipt.outstanding > 0.005 ? `Outstanding: ${money(receipt.currency, receipt.outstanding)}` : '',
    '',
    receipt.payUrl ? `Pay the balance: ${receipt.payUrl}` : '',
  ];
  return lines.filter((l) => l !== '').join('\n');
}
