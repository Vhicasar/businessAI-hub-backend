import { Router, type Request, type RequestHandler, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { paymentLinksService } from '../../application/payments/payment-links.service';
import {
  publicPaymentView,
  publicReceipt,
  initiatePublicPayment,
  verifyPublicPayment,
} from '../../application/payments/payment-public.service';
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
      res.json({ success: true, data: await publicPaymentView(token) });
    } catch (error) {
      // Invoice/order QR codes and the existing payment-link dialog still mint
      // PaymentLink rows. Keep those already-shared tokens payable while the
      // newer PaymentIntent flow is rolled out.
      if (!(error instanceof NotFoundError)) throw error;
      res.json({ success: true, data: await paymentLinksService.publicView(token) });
    }
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
      res.json({ success: true, data: await paymentLinksService.receipt(token) });
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
