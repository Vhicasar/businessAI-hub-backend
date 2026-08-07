import { Router, type Request, type RequestHandler, type Response } from 'express';

import { validate } from '../middleware/validate';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import {
  deliveryService,
  dispatchSchema,
  providerSchema,
  shipmentStatusSchema,
  updateProviderSchema,
} from '../../../application/delivery/delivery.service';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

/**
 * Delivery gateways and shipments. Mounted at /api/v1/delivery.
 *
 * Connecting a gateway (`delivery.configure`) is an integration change; using
 * one to move a parcel (`delivery.dispatch`, `delivery.update_status`) is
 * day-to-day fulfilment. A warehouse hand can send a parcel without being able
 * to swap out the courier account or read its credentials.
 */
export const deliveryRoutes = Router();

/**
 * Courier callback. Deliberately mounted before `authenticate`: the gateway has
 * no session and proves itself with the per-provider HMAC instead.
 */
deliveryRoutes.post(
  '/webhook/:providerId',
  wrap(async (req, res) => {
    const raw = (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    const signature =
      (req.headers['x-vhicasar-signature'] as string | undefined) ??
      (req.headers['x-webhook-signature'] as string | undefined);
    const data = await deliveryService.handleWebhook(req.params.providerId as string, raw.toString('utf8'), signature);
    res.json({ success: true, data });
  })
);

deliveryRoutes.use(authenticate, requireTenant);

/** The connect form's field definitions — what each adapter needs. */
deliveryRoutes.get(
  '/adapters',
  requirePermission('delivery.configure', 'delivery.dispatch'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: deliveryService.adapterCatalog() });
  })
);

deliveryRoutes.get(
  '/providers',
  requirePermission('delivery.read', 'delivery.configure', 'delivery.dispatch'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await deliveryService.listProviders() });
  })
);

deliveryRoutes.post(
  '/providers',
  requirePermission('delivery.configure'),
  validate({ body: providerSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await deliveryService.createProvider(req.body) });
  })
);

deliveryRoutes.patch(
  '/providers/:id',
  requirePermission('delivery.configure'),
  validate({ body: updateProviderSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await deliveryService.updateProvider(req.params.id as string, req.body) });
  })
);

deliveryRoutes.delete(
  '/providers/:id',
  requirePermission('delivery.configure'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await deliveryService.removeProvider(req.params.id as string) });
  })
);

/** Callback URL + secret to paste into the courier's dashboard. */
deliveryRoutes.get(
  '/providers/:id/webhook',
  requirePermission('delivery.configure'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await deliveryService.webhookCredentials(req.params.id as string) });
  })
);

deliveryRoutes.post(
  '/providers/:id/webhook/rotate',
  requirePermission('delivery.configure'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await deliveryService.rotateWebhookSecret(req.params.id as string) });
  })
);

// ---- Shipments ----

deliveryRoutes.get(
  '/orders/:orderId/shipments',
  requirePermission('delivery.read', 'orders.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await deliveryService.shipmentsForOrder(req.params.orderId as string) });
  })
);

deliveryRoutes.post(
  '/orders/:orderId/dispatch',
  requirePermission('delivery.dispatch'),
  validate({ body: dispatchSchema }),
  wrap(async (req, res) => {
    const data = await deliveryService.dispatchOrder(req.params.orderId as string, req.body, req.auth!.userId);
    res.status(201).json({ success: true, message: 'Delivery booked.', data });
  })
);

deliveryRoutes.post(
  '/shipments/:id/status',
  requirePermission('delivery.update_status'),
  validate({ body: shipmentStatusSchema }),
  wrap(async (req, res) => {
    const data = await deliveryService.setShipmentStatus(req.params.id as string, req.body, req.auth!.userId);
    res.json({ success: true, data });
  })
);
