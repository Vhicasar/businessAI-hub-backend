import { Router, type Request, type RequestHandler, type Response } from 'express';
import { validate } from '../middleware/validate';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import { requireBusinessType } from '../middleware/require-business-type';
import {
  bookingSchema,
  createPropertySchema,
  inquirySchema,
  listBookingsSchema,
  listPropertiesSchema,
  propertyMediaSchema,
  realestateService,
  reorderMediaSchema,
  updateBookingSchema,
  updateMediaSchema,
  updatePropertySchema,
} from '../../../application/realestate/realestate.service';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

export const realestateRoutes = Router();
realestateRoutes.use(authenticate, requireTenant, requireBusinessType('REAL_ESTATE'));

// properties
realestateRoutes.get(
  '/properties',
  requirePermission('properties.read'),
  validate({ query: listPropertiesSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await realestateService.listProperties(req.query as never) });
  })
);

realestateRoutes.post(
  '/properties',
  requirePermission('properties.create'),
  validate({ body: createPropertySchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await realestateService.createProperty(req.body) });
  })
);

realestateRoutes.get(
  '/properties/:id',
  requirePermission('properties.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await realestateService.getProperty(req.params.id as string) });
  })
);

realestateRoutes.patch(
  '/properties/:id',
  requirePermission('properties.update'),
  validate({ body: updatePropertySchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await realestateService.updateProperty(req.params.id as string, req.body) });
  })
);

realestateRoutes.delete(
  '/properties/:id',
  requirePermission('properties.delete'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await realestateService.deleteProperty(req.params.id as string) });
  })
);

// property media (photos, video, floor plans, documents)
realestateRoutes.post(
  '/properties/:id/media',
  requirePermission('properties.update'),
  validate({ body: propertyMediaSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await realestateService.addMedia(req.params.id as string, req.body) });
  })
);

realestateRoutes.put(
  '/properties/:id/media/order',
  requirePermission('properties.update'),
  validate({ body: reorderMediaSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await realestateService.reorderMedia(req.params.id as string, req.body.order) });
  })
);

realestateRoutes.patch(
  '/properties/:id/media/:mediaId',
  requirePermission('properties.update'),
  validate({ body: updateMediaSchema }),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await realestateService.updateMedia(req.params.id as string, req.params.mediaId as string, req.body),
    });
  })
);

realestateRoutes.delete(
  '/properties/:id/media/:mediaId',
  requirePermission('properties.update'),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await realestateService.removeMedia(req.params.id as string, req.params.mediaId as string),
    });
  })
);

realestateRoutes.post(
  '/properties/:id/inquire',
  requirePermission('crm.create'),
  validate({ body: inquirySchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await realestateService.inquire(req.params.id as string, req.body) });
  })
);

// bookings (viewings / inspections)
realestateRoutes.get(
  '/bookings',
  requirePermission('bookings.read'),
  validate({ query: listBookingsSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await realestateService.listBookings(req.query as never) });
  })
);

realestateRoutes.post(
  '/bookings',
  requirePermission('bookings.create'),
  validate({ body: bookingSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await realestateService.createBooking(req.body) });
  })
);

realestateRoutes.patch(
  '/bookings/:id',
  requirePermission('bookings.update'),
  validate({ body: updateBookingSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await realestateService.updateBooking(req.params.id as string, req.body) });
  })
);
