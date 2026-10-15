import { Router, type Request, type RequestHandler, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { paymentLinksService } from '../../application/payments/payment-links.service';
import {
  publicReceipt,
  initiatePublicPayment,
  verifyPublicPayment,
} from '../../application/payments/payment-public.service';
import { checkoutView, chooseFulfilment } from '../../application/payments/checkout.service';
import { suggest, resolveSuggestion } from '../../application/maps/address-suggest.service';
import { validate } from './middleware/validate';
import { NotFoundError } from '../../shared/errors';
import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { buildInvoiceDocument } from '../../application/invoices/invoice-document.service';
import { randomUUID } from 'node:crypto';
import { publicPayUrl } from '../../application/payments/payment-intent.service';

/**
 * Public payment-link API for the /pay/<token> page. No auth — possession of
 * the unguessable token is the credential. Permissive CORS + rate limited.
 */
export const payRoutes = Router();

const payLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Slow down a little' } },
});
payRoutes.use(payLimiter);

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

/**
 * Public details for the pay page.
 *
 * Served from the Payment Intent, which every payment link was migrated onto,
 * so tokens already printed on invoices and encoded in QR codes keep working.
 * The `methods` list is resolved on every read rather than stored, which is
 * what makes a business's toggle apply here immediately (§22).
 */
payRoutes.get(
  '/:token',
  wrap(async (req, res) => {
    const token = req.params.token as string;
    try {
      res.json({ success: true, data: await checkoutView(token) });
    } catch (error) {
      // Invoice/order QR codes and the existing payment-link dialog still mint
      // PaymentLink rows. Keep those already-shared tokens payable while the
      // newer PaymentIntent flow is rolled out.
      if (!(error instanceof NotFoundError)) throw error;
      res.json({ success: true, data: await paymentLinksService.publicView(token) });
    }
  }),
);

/**
 * Choose collection or delivery, and price it.
 *
 * Returns the whole checkout rather than just a fee: the order total, the
 * invoice and the amount about to be charged all move together, and the
 * customer must see the same set of numbers the gateway is about to be given.
 */
payRoutes.post(
  '/:token/fulfilment',
  validate({
    body: z.object({
      method: z.enum(['PICKUP', 'DELIVERY']),
      contact: z.object({
        name: z.string().trim().min(1).max(120),
        phone: z.string().trim().min(4).max(32),
        email: z.string().trim().email().max(320).optional().or(z.literal('')),
      }),
      destination: z
        .object({
          line1: z.string().trim().min(1).max(180),
          line2: z.string().trim().max(180).optional(),
          city: z.string().trim().min(1).max(100),
          state: z.string().trim().max(100).optional(),
          country: z.string().trim().min(2).max(2),
          postalCode: z.string().trim().max(30).optional(),
          instructions: z.string().trim().max(600).optional(),
          // Accepted as a hint from a map pin and re-validated server-side;
          // never as a way to choose the distance the fee is based on.
          latitude: z.coerce.number().min(-90).max(90).nullable().optional(),
          longitude: z.coerce.number().min(-180).max(180).nullable().optional(),
        })
        .optional(),
    }),
  }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await chooseFulfilment(req.params.token as string, req.body) });
  }),
);

/**
 * Address suggestions for the delivery step.
 *
 * Public, because the customer paying has no login — but not unbounded. The
 * token is the credential and ties the request to one business, the limiter
 * below is far tighter than the one on the rest of this router, and the
 * business's own address book is deliberately excluded: a payment link must
 * not become a way to read a business's customer addresses.
 */
const suggestLimiter = rateLimit({
  windowMs: 60_000,
  // Roughly one lookup every four seconds. Enough to type an address with a
  // debounced field, nowhere near enough to enumerate anything or run up a
  // provider bill.
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}:${req.params.token ?? ''}`,
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many address lookups. Type the address instead.' },
  },
});

payRoutes.get(
  '/:token/address/suggest',
  suggestLimiter,
  validate({ query: z.object({ q: z.string().trim().min(1).max(200) }) }),
  wrap(async (req, res) => {
    const intent = await prismaUnscoped.paymentIntent.findUnique({
      where: { token: req.params.token as string },
      select: { organizationId: true, status: true },
    });
    if (!intent) throw new NotFoundError('Payment');
    // A settled or cancelled payment has no address left to enter, and an
    // expired link should not keep costing the business provider requests.
    if (!['CREATED', 'AWAITING_PAYMENT', 'PROCESSING', 'PARTIALLY_PAID'].includes(intent.status)) {
      res.json({ success: true, data: { suggestions: [], attribution: '', provider: null, providerAvailable: false, error: null } });
      return;
    }
    const profile = await prismaUnscoped.businessProfile.findUnique({
      where: { organizationId: intent.organizationId },
      select: { latitude: true, longitude: true },
    });
    res.json({
      success: true,
      data: await suggest({
        organizationId: intent.organizationId,
        query: String(req.query.q),
        near:
          profile?.latitude != null && profile?.longitude != null
            ? { latitude: Number(profile.latitude), longitude: Number(profile.longitude) }
            : null,
        includeSaved: false,
      }),
    });
  }),
);

/** Resolve the suggestion the customer picked into a point. */
payRoutes.get(
  '/:token/address/resolve',
  suggestLimiter,
  validate({ query: z.object({ placeId: z.string().trim().min(1).max(300) }) }),
  wrap(async (req, res) => {
    const intent = await prismaUnscoped.paymentIntent.findUnique({
      where: { token: req.params.token as string },
      select: { id: true },
    });
    if (!intent) throw new NotFoundError('Payment');
    res.json({ success: true, data: await resolveSuggestion(String(req.query.placeId)) });
  }),
);

/** Start a gateway checkout; returns the authorization URL to redirect to. */
payRoutes.post(
  '/:token/initiate',
  validate({ body: z.object({ email: z.string().trim().email(), amount: z.coerce.number().positive().optional() }) }),
  wrap(async (req, res) => {
    const token = req.params.token as string;
    try {
      res.json({ success: true, data: await initiatePublicPayment(token, req.body) });
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
      res.json({ success: true, data: await paymentLinksService.initiate(token, req.body) });
    }
  }),
);

/** Verify a gateway reference after redirect back and settle the link. */
payRoutes.get(
  '/:token/verify',
  validate({ query: z.object({ reference: z.string().min(1) }) }),
  wrap(async (req, res) => {
    const token = req.params.token as string;
    const reference = String(req.query.reference);
    try {
      res.json({ success: true, data: await verifyPublicPayment(token, reference) });
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
      res.json({ success: true, data: await paymentLinksService.verify(token, reference) });
    }
  }),
);

/** QR code (PNG data URL) encoding the pay URL. */
payRoutes.get(
  '/:token/qr',
  wrap(async (req, res) => {
    res.json({ success: true, data: { dataUrl: await paymentLinksService.qrDataUrl(req.params.token as string) } });
  }),
);

/** Printable receipt for a settled payment. */
payRoutes.get(
  '/:token/receipt',
  wrap(async (req, res) => {
    const token = req.params.token as string;
    try {
      res.json({ success: true, data: await publicReceipt(token) });
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
      // A token printed before Payment Intents existed. Same renderer, same
      // configured design — the customer cannot tell which era it came from.
      const { buildReceiptForLegacyLink, renderReceiptHtml } = await import(
        '../../application/payments/receipt-document.service'
      );
      const receipt = await buildReceiptForLegacyLink(token);
      res.json({ success: true, data: { ...receipt, html: await renderReceiptHtml(receipt) } });
    }
  }),
);

/** Token-authorized invoice PDF. The token is tied to the invoice and tenant. */
payRoutes.get(
  '/:token/invoice',
  wrap(async (req, res) => {
    const intent = await prismaUnscoped.paymentIntent.findUnique({
      where: { token: req.params.token as string },
      select: { invoiceId: true, organizationId: true },
    });
    if (!intent?.invoiceId) throw new NotFoundError('Invoice');
    const doc = await requestContext.run(
      { requestId: randomUUID(), organizationId: intent.organizationId },
      () => buildInvoiceDocument(intent.invoiceId!, { payUrl: publicPayUrl(req.params.token as string) }),
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${doc.filename}"`);
    res.setHeader('Content-Length', String(doc.pdf.length));
    res.end(doc.pdf);
  }),
);
