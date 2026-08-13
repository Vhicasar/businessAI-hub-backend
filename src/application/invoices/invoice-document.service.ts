import PDFDocument from 'pdfkit';
import { prisma } from '../../infrastructure/database/prisma';
import { NotFoundError } from '../../shared/errors';
import { settingsService } from '../settings/settings.service';

/**
 * The invoice itself — as an email body and as a PDF.
 *
 * Sending used to be a one-line notice saying an invoice existed, which is not
 * an invoice: a customer needs the line items, the totals, what is still owed
 * and by when, and something they can file or forward. This builds both from
 * the same data so the two never disagree.
 */

export interface InvoiceDocument {
  number: string;
  subject: string;
  html: string;
  text: string;
  pdf: Buffer;
  filename: string;
}

interface BusinessDetails {
  name?: string;
  email?: string;
  phone?: string;
  website?: string;
  addressLines?: string;
  taxId?: string;
  footer?: string;
}

const money = (currency: string, value: number): string =>
  `${currency} ${amount(value)}`;

/** The bare number, for tables where the currency is stated once at the top. */
const amount = (value: number): string =>
  value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const day = (date: Date | null): string =>
  date ? date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';

/** Keep customer-supplied text out of the HTML structure. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function loadInvoice(invoiceId: string) {
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, deletedAt: null },
    select: {
      id: true, number: true, status: true, currency: true,
      subtotal: true, taxTotal: true, discountTotal: true, total: true, amountPaid: true,
      issuedAt: true, dueAt: true, notes: true, createdAt: true,
      customer: { select: { firstName: true, lastName: true, email: true, phone: true } },
      items: {
        select: { description: true, quantity: true, unitPrice: true, taxRate: true, total: true },
      },
    },
  });
  if (!invoice) throw new NotFoundError('Invoice');
  return invoice;
}

async function businessDetails(): Promise<BusinessDetails> {
  try {
    const settings = await settingsService.getInvoiceSettings();
    return (settings?.business ?? {}) as BusinessDetails;
  } catch {
    // A missing settings row must not stop an invoice going out.
    return {};
  }
}

/** The full invoice, ready to email and to attach. */
export async function buildInvoiceDocument(
  invoiceId: string,
  opts: { payUrl?: string | null } = {},
): Promise<InvoiceDocument> {
  const invoice = await loadInvoice(invoiceId);
  const business = await businessDetails();

  const currency = invoice.currency;
  const total = Number(invoice.total);
  const paid = Number(invoice.amountPaid);
  const outstanding = Number((total - paid).toFixed(2));
  const customerName = `${invoice.customer.firstName} ${invoice.customer.lastName ?? ''}`.trim();
  const businessName = business.name || 'Your business';

  const rows = invoice.items.map((item) => ({
    description: item.description,
    quantity: Number(item.quantity),
    unitPrice: Number(item.unitPrice),
    total: Number(item.total),
  }));

  return {
    number: invoice.number,
    subject: `Invoice ${invoice.number} from ${businessName} — ${money(currency, total)}`,
    html: renderHtml({ invoice, business, rows, currency, total, paid, outstanding, customerName, businessName, payUrl: opts.payUrl ?? null }),
    text: renderText({ invoice, business, rows, currency, total, paid, outstanding, customerName, businessName, payUrl: opts.payUrl ?? null }),
    pdf: await renderPdf({ invoice, business, rows, currency, total, paid, outstanding, customerName, businessName }),
    // Spaces and slashes in an invoice number would make an awkward filename.
    filename: `Invoice-${invoice.number.replace(/[^\w.-]+/g, '-')}.pdf`,
  };
}

type RenderInput = {
  invoice: Awaited<ReturnType<typeof loadInvoice>>;
  business: BusinessDetails;
  rows: { description: string; quantity: number; unitPrice: number; total: number }[];
  currency: string;
  total: number;
  paid: number;
  outstanding: number;
  customerName: string;
  businessName: string;
  payUrl?: string | null;
};

function renderHtml(input: RenderInput): string {
  const { invoice, business, rows, currency, total, paid, outstanding, customerName, businessName, payUrl } = input;

  const itemRows = rows
    .map(
      (r) => `<tr>
        <td style="padding:8px 0;border-bottom:1px solid #eee">${escapeHtml(r.description)}</td>
        <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right">${r.quantity}</td>
        <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right">${money(currency, r.unitPrice)}</td>
        <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right">${money(currency, r.total)}</td>
      </tr>`,
    )
    .join('');

  const totalRow = (label: string, value: string, bold = false) =>
    `<tr>
      <td colspan="3" style="padding:4px 0;text-align:right;${bold ? 'font-weight:700' : 'color:#555'}">${label}</td>
      <td style="padding:4px 0;text-align:right;${bold ? 'font-weight:700' : ''}">${value}</td>
    </tr>`;

  return `
  <div style="font-family:Arial,Helvetica,sans-serif;color:#111;max-width:640px">
    <h2 style="margin:0 0 4px">${escapeHtml(businessName)}</h2>
    ${business.addressLines ? `<p style="margin:0;color:#555;white-space:pre-line">${escapeHtml(business.addressLines)}</p>` : ''}
    ${business.email ? `<p style="margin:0;color:#555">${escapeHtml(business.email)}</p>` : ''}
    ${business.phone ? `<p style="margin:0;color:#555">${escapeHtml(business.phone)}</p>` : ''}
    ${business.taxId ? `<p style="margin:0;color:#555">Tax ID: ${escapeHtml(business.taxId)}</p>` : ''}

    <hr style="border:none;border-top:1px solid #ddd;margin:16px 0" />

    <p style="margin:0 0 12px">Hello ${escapeHtml(customerName)},</p>
    <p style="margin:0 0 16px">Please find invoice <strong>${escapeHtml(invoice.number)}</strong> below. A PDF copy is attached.</p>

    <table style="width:100%;border-collapse:collapse;margin-bottom:8px">
      <tr>
        <td style="color:#555">Invoice number</td><td style="text-align:right">${escapeHtml(invoice.number)}</td>
      </tr>
      <tr><td style="color:#555">Issued</td><td style="text-align:right">${day(invoice.issuedAt ?? invoice.createdAt)}</td></tr>
      <tr><td style="color:#555">Due</td><td style="text-align:right">${day(invoice.dueAt)}</td></tr>
    </table>

    <table style="width:100%;border-collapse:collapse;margin-top:16px">
      <thead>
        <tr>
          <th style="text-align:left;padding-bottom:6px;border-bottom:2px solid #333">Description</th>
          <th style="text-align:right;padding-bottom:6px;border-bottom:2px solid #333">Qty</th>
          <th style="text-align:right;padding-bottom:6px;border-bottom:2px solid #333">Unit</th>
          <th style="text-align:right;padding-bottom:6px;border-bottom:2px solid #333">Amount</th>
        </tr>
      </thead>
      <tbody>${itemRows || '<tr><td colspan="4" style="padding:8px 0;color:#777">No line items</td></tr>'}</tbody>
      <tfoot>
        ${totalRow('Subtotal', money(currency, Number(invoice.subtotal)))}
        ${Number(invoice.discountTotal) > 0 ? totalRow('Discount', `-${money(currency, Number(invoice.discountTotal))}`) : ''}
        ${Number(invoice.taxTotal) > 0 ? totalRow('Tax', money(currency, Number(invoice.taxTotal))) : ''}
        ${totalRow('Total', money(currency, total), true)}
        ${paid > 0 ? totalRow('Paid', `-${money(currency, paid)}`) : ''}
        ${paid > 0 ? totalRow('Amount due', money(currency, outstanding), true) : ''}
      </tfoot>
    </table>

    ${payUrl ? `<p style="margin:24px 0"><a href="${escapeHtml(payUrl)}" style="background:#F97316;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">Pay this invoice</a></p>` : ''}
    ${invoice.notes ? `<p style="margin-top:20px;color:#555;white-space:pre-line">${escapeHtml(invoice.notes)}</p>` : ''}
    ${business.footer ? `<p style="margin-top:24px;color:#777;font-size:12px;white-space:pre-line">${escapeHtml(business.footer)}</p>` : ''}
  </div>`;
}

/** The plain-text alternative, for clients that will not render HTML. */
function renderText(input: RenderInput): string {
  const { invoice, rows, currency, total, paid, outstanding, customerName, businessName, payUrl } = input;
  const lines = [
    `${businessName}`,
    '',
    `Hello ${customerName},`,
    `Invoice ${invoice.number} — a PDF copy is attached.`,
    '',
    `Issued: ${day(invoice.issuedAt ?? invoice.createdAt)}`,
    `Due:    ${day(invoice.dueAt)}`,
    '',
    ...rows.map((r) => `${r.quantity} x ${r.description} — ${money(currency, r.total)}`),
    '',
    `Subtotal: ${money(currency, Number(invoice.subtotal))}`,
  ];
  if (Number(invoice.taxTotal) > 0) lines.push(`Tax:      ${money(currency, Number(invoice.taxTotal))}`);
  lines.push(`Total:    ${money(currency, total)}`);
  if (paid > 0) {
    lines.push(`Paid:     ${money(currency, paid)}`);
    lines.push(`Due:      ${money(currency, outstanding)}`);
  }
  if (payUrl) lines.push('', `Pay online: ${payUrl}`);
  if (invoice.notes) lines.push('', invoice.notes);
  return lines.join('\n');
}

/**
 * The attachment.
 *
 * Drawn with pdfkit rather than a headless browser: an invoice is a simple
 * fixed layout, and shipping Chromium to render it would dominate both the
 * image size and the time to send.
 */
function renderPdf(input: RenderInput): Promise<Buffer> {
  const { invoice, business, rows, currency, total, paid, outstanding, customerName, businessName } = input;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const LEFT = 50;
    const RIGHT = 545;

    /*
     * Column right-edges rather than left-offsets.
     *
     * Money is right-aligned, so what has to line up is where each number
     * *ends*. Widths were too narrow before and pdfkit wrapped "NGN 200,000.00"
     * after the currency code, dropping the number onto the row below.
     */
    const COL = {
      descX: LEFT,
      descW: 250,
      qtyRight: 340,
      unitRight: 440,
      amountRight: RIGHT,
    };
    const cellW = 100;

    /**
     * One cell of text that must never wrap.
     *
     * `lineBreak: false` is the point: a value too wide for its column is
     * clipped rather than silently pushed onto the next line and over the row
     * beneath it.
     */
    const cell = (
      text: string,
      rightEdge: number,
      y: number,
      width = cellW,
      align: 'right' | 'left' = 'right',
    ) => {
      doc.text(text, rightEdge - width, y, { width, align, lineBreak: false });
    };

    const line = (y: number) => doc.moveTo(LEFT, y).lineTo(RIGHT, y).strokeColor('#dddddd').stroke();

    // ---------------------------------------------------------------- header
    doc.font('Helvetica-Bold').fontSize(18).fillColor('#111')
      .text(businessName, LEFT, 50, { width: 300, lineBreak: false });

    let leftY = 74;
    doc.font('Helvetica').fontSize(9).fillColor('#555');
    for (const detail of [
      business.addressLines,
      business.email,
      business.phone,
      business.taxId ? `Tax ID: ${business.taxId}` : null,
    ]) {
      if (!detail) continue;
      doc.text(detail, LEFT, leftY, { width: 300 });
      leftY = doc.y;
    }

    doc.font('Helvetica-Bold').fontSize(22).fillColor('#111');
    cell('INVOICE', RIGHT, 50, 200);
    doc.font('Helvetica').fontSize(10).fillColor('#555');
    cell(invoice.number, RIGHT, 78, 200);
    cell(`Issued: ${day(invoice.issuedAt ?? invoice.createdAt)}`, RIGHT, 92, 200);
    cell(`Due: ${day(invoice.dueAt)}`, RIGHT, 106, 200);

    let y = Math.max(leftY, 124) + 12;
    line(y);
    y += 14;

    // --------------------------------------------------------------- bill to
    doc.font('Helvetica').fontSize(9).fillColor('#555').text('BILL TO', LEFT, y);
    y += 13;
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#111').text(customerName, LEFT, y, { width: 300 });
    y += 15;
    if (invoice.customer.email) {
      doc.font('Helvetica').fontSize(9).fillColor('#555').text(invoice.customer.email, LEFT, y, { width: 300 });
      y += 13;
    }

    // The currency is stated once here instead of on every row — repeating it
    // is what made the columns overflow.
    doc.font('Helvetica').fontSize(9).fillColor('#555');
    cell(`All amounts in ${currency}`, RIGHT, y - 13, 200);
    y += 14;

    // --------------------------------------------------------------- columns
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#111');
    doc.text('DESCRIPTION', COL.descX, y, { width: COL.descW, lineBreak: false });
    cell('QTY', COL.qtyRight, y, 60);
    cell('UNIT', COL.unitRight, y, cellW);
    cell('AMOUNT', COL.amountRight, y, cellW);
    y += 13;
    line(y);
    y += 8;

    // ----------------------------------------------------------------- items
    doc.font('Helvetica').fontSize(10).fillColor('#111');
    if (rows.length === 0) {
      doc.fillColor('#777').text('No line items', COL.descX, y, { width: COL.descW });
      y += 18;
    }
    for (const row of rows) {
      const height = doc.heightOfString(row.description, { width: COL.descW });
      // Start a new page before the row rather than after, so a row is never
      // split across the page break.
      if (y + height > 700) {
        doc.addPage();
        y = 50;
      }
      doc.fillColor('#111').text(row.description, COL.descX, y, { width: COL.descW });
      cell(String(row.quantity), COL.qtyRight, y, 60);
      cell(amount(row.unitPrice), COL.unitRight, y);
      cell(amount(row.total), COL.amountRight, y);
      y += Math.max(height, 12) + 8;
    }

    line(y);
    y += 12;

    // ---------------------------------------------------------------- totals
    const totalLine = (label: string, value: string, bold = false) => {
      if (y > 740) { doc.addPage(); y = 50; }
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 12 : 10).fillColor('#111');
      cell(label, COL.unitRight, y, 160);
      cell(value, COL.amountRight, y);
      y += bold ? 20 : 16;
    };
    totalLine('Subtotal', amount(Number(invoice.subtotal)));
    if (Number(invoice.discountTotal) > 0) totalLine('Discount', `-${amount(Number(invoice.discountTotal))}`);
    if (Number(invoice.taxTotal) > 0) totalLine('Tax', amount(Number(invoice.taxTotal)));
    totalLine('Total', amount(total), true);
    if (paid > 0) {
      totalLine('Paid', `-${amount(paid)}`);
      totalLine('Amount due', amount(outstanding), true);
    }

    if (invoice.notes) {
      y += 10;
      if (y > 740) { doc.addPage(); y = 50; }
      doc.font('Helvetica').fontSize(9).fillColor('#555')
        .text(invoice.notes, LEFT, y, { width: RIGHT - LEFT });
    }
    if (business.footer) {
      doc.font('Helvetica').fontSize(8).fillColor('#777')
        .text(business.footer, LEFT, 782, { width: RIGHT - LEFT, align: 'center', lineBreak: false });
    }

    doc.end();
  });
}
