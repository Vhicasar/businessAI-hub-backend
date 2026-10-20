import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import { requireFeature } from '../middleware/plan-guard';
import {
  campaignService,
  createCampaignSchema,
  updateCampaignSchema,
} from '../../../application/messaging/campaign.service';
import { couponSchema, promotionSchema, promotionsService } from '../../../application/marketing/promotions.service';
import { loyaltyProgramSchema, loyaltyService } from '../../../application/marketing/loyalty.service';
import { launchSchema, whatsappCampaignService } from '../../../application/messaging/whatsapp-campaign.service';
import { segmentSchema, whatsappAudienceService } from '../../../application/messaging/audience.service';
import { whatsappTemplateService } from '../../../application/messaging/whatsapp-template.service';
import { whatsappBillingService } from '../../../application/inbox/whatsapp-billing.service';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

export const marketingRoutes = Router();
marketingRoutes.use(authenticate, requireTenant, requireFeature('marketing'));

marketingRoutes.get('/coupons', requirePermission('marketing.read'), wrap(async (_req, res) => { res.json({ success: true, data: await promotionsService.listCoupons() }); }));
marketingRoutes.post('/coupons', requirePermission('marketing.create'), validate({ body: couponSchema }), wrap(async (req, res) => { res.status(201).json({ success: true, data: await promotionsService.createCoupon(req.body) }); }));
marketingRoutes.post('/coupons/validate', requirePermission('orders.create', 'marketing.read'), validate({ body: z.object({ code: z.string().min(1), amount: z.coerce.number().nonnegative(), customerId: z.string().optional() }) }), wrap(async (req, res) => { const result = await promotionsService.validate(req.body.code, req.body.amount, req.body.customerId); res.json({ success: true, data: { code: result.coupon.code, discount: result.discount, description: result.coupon.description } }); }));
marketingRoutes.get('/promotions', requirePermission('marketing.read'), wrap(async (_req, res) => { res.json({ success: true, data: await promotionsService.listPromotions() }); }));
marketingRoutes.post('/promotions', requirePermission('marketing.create'), validate({ body: promotionSchema }), wrap(async (req, res) => { res.status(201).json({ success: true, data: await promotionsService.createPromotion(req.body) }); }));
marketingRoutes.get('/loyalty', requirePermission('loyalty.read'), wrap(async (_req, res) => { res.json({ success: true, data: await loyaltyService.get() }); }));
marketingRoutes.put('/loyalty', requirePermission('loyalty.manage'), validate({ body: loyaltyProgramSchema }), wrap(async (req, res) => { res.json({ success: true, data: await loyaltyService.configure(req.body) }); }));
marketingRoutes.post('/loyalty/adjust', requirePermission('loyalty.manage'), validate({ body: z.object({ customerId: z.string().min(1), points: z.coerce.number().int().refine((n) => n !== 0), note: z.string().trim().max(300).optional() }) }), wrap(async (req, res) => { res.json({ success: true, data: await loyaltyService.adjust(req.body.customerId, req.body.points, req.body.note) }); }));

marketingRoutes.get(
  '/campaigns',
  requirePermission('marketing.read'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await campaignService.list() });
  })
);

marketingRoutes.post(
  '/campaigns',
  requirePermission('marketing.create'),
  validate({ body: createCampaignSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await campaignService.create(req.body) });
  })
);

marketingRoutes.get(
  '/campaigns/audience',
  requirePermission('marketing.read'),
  validate({ query: z.object({ type: z.enum(['EMAIL', 'SMS', 'WHATSAPP']) }) }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await campaignService.audience(req.query.type as never) });
  })
);

/** The same estimate for a chosen segment, which a query string cannot carry. */
marketingRoutes.post(
  '/campaigns/audience',
  requirePermission('marketing.read'),
  validate({ body: z.object({ type: z.enum(['EMAIL', 'SMS']), segment: segmentSchema.optional() }) }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await campaignService.audience(req.body.type, req.body.segment) });
  })
);

marketingRoutes.get(
  '/campaigns/:id',
  requirePermission('marketing.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await campaignService.get(req.params.id as string) });
  })
);

marketingRoutes.patch(
  '/campaigns/:id',
  requirePermission('marketing.update'),
  validate({ body: updateCampaignSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await campaignService.update(req.params.id as string, req.body) });
  })
);

marketingRoutes.post(
  '/campaigns/:id/send',
  requirePermission('marketing.send'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await campaignService.send(req.params.id as string) });
  })
);

/*
 * WhatsApp marketing campaigns.
 *
 * Every route is tenant-scoped by the services behind it: the channel, the
 * template, the audience and the campaign are each looked up with the caller's
 * organizationId in the query, so an id from another business simply does not
 * resolve. Permissions are checked here rather than relied upon in the UI.
 */
marketingRoutes.get(
  '/whatsapp/accounts',
  requirePermission('marketing.read'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await whatsappCampaignService.sendingAccounts() });
  }),
);

marketingRoutes.get(
  '/whatsapp/accounts/:accountId/templates',
  requirePermission('marketing.read'),
  wrap(async (req, res) => {
    const organizationId = req.auth!.organizationId!;
    const refresh = String(req.query.refresh ?? '') === 'true';
    const templates = refresh
      ? await whatsappTemplateService.refresh(req.params.accountId as string, organizationId)
      : await whatsappTemplateService.list(req.params.accountId as string, organizationId);
    res.json({ success: true, data: templates });
  }),
);

marketingRoutes.get(
  '/whatsapp/accounts/:accountId/billing',
  requirePermission('marketing.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await whatsappBillingService.status(req.params.accountId as string, req.auth!.organizationId!) });
  }),
);

/** "I've completed setup — check again". Never trusts the click alone. */
marketingRoutes.post(
  '/whatsapp/accounts/:accountId/billing/check',
  requirePermission('marketing.update'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await whatsappBillingService.check(req.params.accountId as string, req.auth!.organizationId!) });
  }),
);

marketingRoutes.post(
  '/whatsapp/audience',
  requirePermission('marketing.read'),
  validate({ body: z.object({ segment: segmentSchema }) }),
  wrap(async (req, res) => {
    const audience = await whatsappAudienceService.resolve(req.auth!.organizationId!, req.body.segment);
    res.json({
      success: true,
      data: { count: audience.members.length, matched: audience.matched, excluded: audience.excluded },
    });
  }),
);

marketingRoutes.post(
  '/whatsapp/campaigns/preview',
  requirePermission('marketing.read'),
  validate({ body: launchSchema.omit({ name: true, scheduledAt: true }) }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await whatsappCampaignService.preview(req.body) });
  }),
);

marketingRoutes.post(
  '/whatsapp/campaigns',
  requirePermission('marketing.create'),
  validate({ body: launchSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await whatsappCampaignService.launch(req.body) });
  }),
);

marketingRoutes.get(
  '/whatsapp/campaigns/:campaignId',
  requirePermission('marketing.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await whatsappCampaignService.report(req.params.campaignId as string) });
  }),
);

marketingRoutes.post(
  '/whatsapp/campaigns/:campaignId/resume',
  requirePermission('marketing.update'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await whatsappCampaignService.resume(req.params.campaignId as string) });
  }),
);

marketingRoutes.post(
  '/whatsapp/campaigns/:campaignId/cancel',
  requirePermission('marketing.update'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await whatsappCampaignService.cancel(req.params.campaignId as string) });
  }),
);
