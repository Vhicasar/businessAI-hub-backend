import { Router, type Request, type RequestHandler, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { paymentLinksService } from '../../application/payments/payment-links.service';
import { validate } from './middleware/validate';

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

/** Public details for the pay page. */
payRoutes.get(
  '/:token',
  wrap(async (req, res) => {
    res.json({ success: true, data: await paymentLinksService.publicView(req.params.token as string) });
  }),
);

/** Start a gateway checkout; returns the authorization URL to redirect to. */
payRoutes.post(
  '/:token/initiate',
  validate({ body: z.object({ email: z.string().trim().email(), amount: z.coerce.number().positive().optional() }) }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await paymentLinksService.initiate(req.params.token as string, req.body) });
  }),
);

/** Verify a gateway reference after redirect back and settle the link. */
payRoutes.get(
  '/:token/verify',
  validate({ query: z.object({ reference: z.string().min(1) }) }),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await paymentLinksService.verify(req.params.token as string, String(req.query.reference)),
    });
  }),
);

/** QR code (PNG data URL) encoding the pay URL. */
payRoutes.get(
  '/:token/qr',
  wrap(async (req, res) => {
    res.json({ success: true, data: { dataUrl: await paymentLinksService.qrDataUrl(req.params.token as string) } });
  }),
);

/** Printable receipt for a settled link. */
payRoutes.get(
  '/:token/receipt',
  wrap(async (req, res) => {
    res.json({ success: true, data: await paymentLinksService.receipt(req.params.token as string) });
  }),
);
