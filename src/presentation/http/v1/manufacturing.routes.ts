import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';

import { validate } from '../middleware/validate';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import { requireModule } from '../middleware/require-module';

import {
  manufacturingSettings,
  manufacturingSettingsSchema,
} from '../../../application/manufacturing/settings.service';
import {
  bomService,
  createBomSchema,
  listBomsSchema,
  updateBomSchema,
} from '../../../application/manufacturing/bom.service';
import {
  createPlanSchema,
  listPlansSchema,
  productionPlanningService,
  updatePlanSchema,
} from '../../../application/manufacturing/production-planning.service';
import {
  createProductionOrderSchema,
  listProductionOrdersSchema,
  productionOrdersService,
  updateProductionOrderSchema,
} from '../../../application/manufacturing/production-orders.service';
import {
  consumeMaterialSchema,
  issueMaterialSchema,
  materialConsumptionService,
  returnMaterialSchema,
} from '../../../application/manufacturing/material-consumption.service';
import {
  productionOutputService,
  recordOutputSchema,
} from '../../../application/manufacturing/production-output.service';
import {
  actOnRecommendationSchema,
  procurementRecommendationsService,
  requisitionFromShortageSchema,
} from '../../../application/manufacturing/procurement-recommendations.service';
import {
  calculateCostSchema,
  costingService,
} from '../../../application/manufacturing/costing.service';
import {
  dashboardFiltersSchema,
  manufacturingDashboard,
} from '../../../application/manufacturing/dashboard.service';
import {
  analyticsRangeSchema,
  manufacturingAnalytics,
} from '../../../application/manufacturing/analytics.service';
import { manufacturingAi } from '../../../application/manufacturing/manufacturing-ai.service';
import { manufacturingAlerts } from '../../../application/manufacturing/manufacturing-alerts.service';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

/**
 * Manufacturing & Operations — planning, recipes, runs and what they cost.
 *
 * Two gates on every route, and they answer different questions. `requireModule`
 * asks whether this kind of business has manufacturing at all; `requirePermission`
 * asks whether this person may do the thing. A production manager at an estate
 * agency fails the first; a cashier at a bottling plant fails the second.
 *
 * The module gate is applied once at the router rather than repeated per route,
 * because forgetting it on one endpoint is how an estate agency ends up able to
 * create a bill of materials by URL.
 */
export const manufacturingRoutes = Router();
manufacturingRoutes.use(authenticate, requireTenant, requireModule('manufacturing'));

// ── Settings ───────────────────────────────────────────────────────────────
manufacturingRoutes.get(
  '/settings',
  requirePermission('manufacturing.read'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await manufacturingSettings.get() });
  }),
);

manufacturingRoutes.patch(
  '/settings',
  requirePermission('manufacturing.manage_settings'),
  validate({ body: manufacturingSettingsSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await manufacturingSettings.update(req.body) });
  }),
);

// ── Bills of material ──────────────────────────────────────────────────────
manufacturingRoutes.get(
  '/boms',
  requirePermission('bom.read'),
  validate({ query: listBomsSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await bomService.list(req.query as never) });
  }),
);

manufacturingRoutes.get(
  '/boms/:id',
  requirePermission('bom.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await bomService.get(req.params.id as string) });
  }),
);

/** What making a given quantity would need. Read-only — nothing is reserved. */
manufacturingRoutes.get(
  '/boms/:id/requirements',
  requirePermission('bom.read'),
  validate({ query: z.object({ quantity: z.coerce.number().positive() }) }),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await bomService.requirementsFor(
        req.params.id as string,
        Number(req.query.quantity),
      ),
    });
  }),
);

manufacturingRoutes.post(
  '/boms',
  requirePermission('bom.create'),
  validate({ body: createBomSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await bomService.create(req.body) });
  }),
);

manufacturingRoutes.patch(
  '/boms/:id',
  requirePermission('bom.update'),
  validate({ body: updateBomSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await bomService.update(req.params.id as string, req.body) });
  }),
);

/**
 * Making a recipe live is its own permission.
 *
 * Writing a draft is drafting; activating one changes what the factory
 * actually makes tomorrow, and those are not the same decision.
 */
manufacturingRoutes.post(
  '/boms/:id/activate',
  requirePermission('bom.activate'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await bomService.activate(req.params.id as string) });
  }),
);

manufacturingRoutes.post(
  '/boms/:id/archive',
  requirePermission('bom.delete'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await bomService.archive(req.params.id as string) });
  }),
);

// ── Production plans ───────────────────────────────────────────────────────
manufacturingRoutes.get(
  '/plans',
  requirePermission('production.read'),
  validate({ query: listPlansSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await productionPlanningService.list(req.query as never) });
  }),
);

manufacturingRoutes.get(
  '/plans/:id',
  requirePermission('production.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await productionPlanningService.get(req.params.id as string) });
  }),
);

manufacturingRoutes.get(
  '/plans/:id/requirements',
  requirePermission('production.read'),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await productionPlanningService.requirements(req.params.id as string),
    });
  }),
);

manufacturingRoutes.post(
  '/plans',
  requirePermission('production.plan'),
  validate({ body: createPlanSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await productionPlanningService.create(req.body) });
  }),
);

manufacturingRoutes.patch(
  '/plans/:id',
  requirePermission('production.plan'),
  validate({ body: updatePlanSchema }),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await productionPlanningService.update(req.params.id as string, req.body),
    });
  }),
);

manufacturingRoutes.post(
  '/plans/:id/status',
  requirePermission('production.approve'),
  validate({
    body: z.object({
      status: z.enum(['DRAFT', 'PLANNED', 'APPROVED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']),
      reason: z.string().trim().max(500).optional(),
    }),
  }),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await productionPlanningService.transition(
        req.params.id as string,
        req.body.status,
        req.body.reason,
      ),
    });
  }),
);

/** Commit the plan: turn it into a production order. */
manufacturingRoutes.post(
  '/plans/:id/raise-order',
  requirePermission('production.create'),
  wrap(async (req, res) => {
    res.status(201).json({
      success: true,
      data: await productionPlanningService.raiseOrder(req.params.id as string),
    });
  }),
);

// ── Production orders ──────────────────────────────────────────────────────
manufacturingRoutes.get(
  '/orders',
  requirePermission('production.read'),
  validate({ query: listProductionOrdersSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await productionOrdersService.list(req.query as never) });
  }),
);

manufacturingRoutes.get(
  '/orders/:id',
  requirePermission('production.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await productionOrdersService.get(req.params.id as string) });
  }),
);

/** §7: can this run actually go ahead? Reports; never refuses. */
manufacturingRoutes.get(
  '/orders/:id/material-check',
  requirePermission('production.read'),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await productionOrdersService.materialCheck(req.params.id as string),
    });
  }),
);

/**
 * §8: what would fix each shortage.
 *
 * A GET on purpose — this is the screen a planner reads while deciding, and
 * looking at options must never itself commit to one.
 */
manufacturingRoutes.get(
  '/orders/:id/procurement-recommendations',
  requirePermission('production.read'),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await procurementRecommendationsService.forProductionOrder(req.params.id as string),
    });
  }),
);

/**
 * Act on the recommendation by raising draft purchase orders.
 *
 * Drafts only, and only when asked — §8 is explicit that nothing is ordered
 * without a person agreeing to it. Needs the purchasing permission, not a
 * production one: this is spending money.
 */
manufacturingRoutes.post(
  '/orders/:id/create-purchase-drafts',
  requirePermission('purchasing.create'),
  validate({ body: actOnRecommendationSchema }),
  wrap(async (req, res) => {
    res.status(201).json({
      success: true,
      data: await procurementRecommendationsService.createDraftPurchaseOrders(
        req.params.id as string,
        req.body,
      ),
    });
  }),
);

/** §11: ask another warehouse for what is short. */
manufacturingRoutes.post(
  '/orders/:id/request-materials',
  requirePermission('inventory.requisition_create'),
  validate({ body: requisitionFromShortageSchema }),
  wrap(async (req, res) => {
    res.status(201).json({
      success: true,
      data: await procurementRecommendationsService.requestFromWarehouse(
        req.params.id as string,
        req.body,
      ),
    });
  }),
);

manufacturingRoutes.post(
  '/orders',
  requirePermission('production.create'),
  validate({ body: createProductionOrderSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await productionOrdersService.create(req.body) });
  }),
);

manufacturingRoutes.patch(
  '/orders/:id',
  requirePermission('production.create'),
  validate({ body: updateProductionOrderSchema }),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await productionOrdersService.update(req.params.id as string, req.body),
    });
  }),
);

/**
 * Move a run along.
 *
 * Approving, starting, completing and cancelling are separate permissions in
 * the catalogue but share one endpoint, so the guard is chosen by what is
 * being asked for rather than by which URL was called.
 */
manufacturingRoutes.post(
  '/orders/:id/status',
  requirePermission('production.approve', 'production.start', 'production.complete', 'production.cancel'),
  validate({
    body: z.object({
      status: z.enum(['APPROVED', 'READY', 'IN_PROGRESS', 'PAUSED', 'COMPLETED', 'CANCELLED']),
      reason: z.string().trim().max(500).optional(),
    }),
  }),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await productionOrdersService.transition(
        req.params.id as string,
        req.body.status,
        req.body.reason,
      ),
    });
  }),
);

// ── Materials on the line ──────────────────────────────────────────────────
manufacturingRoutes.get(
  '/orders/:id/material-history',
  requirePermission('production.read'),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await materialConsumptionService.history(req.params.id as string),
    });
  }),
);

manufacturingRoutes.post(
  '/orders/:id/issue-materials',
  requirePermission('production.issue_material'),
  validate({ body: issueMaterialSchema }),
  wrap(async (req, res) => {
    res.status(201).json({
      success: true,
      data: await materialConsumptionService.issue(
        req.params.id as string,
        req.body,
        req.auth!.userId,
      ),
    });
  }),
);

manufacturingRoutes.post(
  '/orders/:id/consume-materials',
  requirePermission('production.issue_material'),
  validate({ body: consumeMaterialSchema }),
  wrap(async (req, res) => {
    res.status(201).json({
      success: true,
      data: await materialConsumptionService.consume(
        req.params.id as string,
        req.body,
        req.auth!.userId,
      ),
    });
  }),
);

manufacturingRoutes.post(
  '/orders/:id/return-materials',
  requirePermission('production.issue_material'),
  validate({ body: returnMaterialSchema }),
  wrap(async (req, res) => {
    res.status(201).json({
      success: true,
      data: await materialConsumptionService.returnToStore(
        req.params.id as string,
        req.body,
        req.auth!.userId,
      ),
    });
  }),
);

// ── Finished production ────────────────────────────────────────────────────
manufacturingRoutes.get(
  '/orders/:id/output',
  requirePermission('production.read'),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await productionOutputService.listForOrder(req.params.id as string),
    });
  }),
);

manufacturingRoutes.post(
  '/orders/:id/output',
  requirePermission('production.record_output'),
  validate({ body: recordOutputSchema }),
  wrap(async (req, res) => {
    res.status(201).json({
      success: true,
      data: await productionOutputService.record(
        req.params.id as string,
        req.body,
        req.auth!.userId,
      ),
    });
  }),
);

// ── Costing and variance ───────────────────────────────────────────────────
manufacturingRoutes.get(
  '/orders/:id/cost',
  requirePermission('production.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await costingService.forOrder(req.params.id as string) });
  }),
);

manufacturingRoutes.post(
  '/orders/:id/cost',
  requirePermission('production.complete'),
  validate({ body: calculateCostSchema }),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await costingService.calculate(req.params.id as string, req.body),
    });
  }),
);

// ── Dashboard and analytics ────────────────────────────────────────────────
/**
 * §23. Read-only, and gated on `manufacturing.read` rather than on each of the
 * things it summarises: a dashboard that shows some panels and hides others
 * depending on the reader is harder to act on than one that is either
 * available or not.
 */
manufacturingRoutes.get(
  '/dashboard',
  requirePermission('manufacturing.read'),
  validate({ query: dashboardFiltersSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await manufacturingDashboard.overview(req.query as never) });
  }),
);

manufacturingRoutes.get(
  '/dashboard/inventory-value',
  requirePermission('manufacturing.read', 'inventory.read'),
  validate({ query: z.object({ warehouseId: z.string().optional() }) }),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await manufacturingDashboard.inventoryValue(req.query as never),
    });
  }),
);

/**
 * §24. Five separate reports rather than one payload — they are read on
 * different screens by different people, and computing all five to show one is
 * waste.
 */
manufacturingRoutes.get(
  '/analytics/production',
  requirePermission('analytics.view', 'production.read'),
  validate({ query: analyticsRangeSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await manufacturingAnalytics.production(req.query as never) });
  }),
);

manufacturingRoutes.get(
  '/analytics/inventory',
  requirePermission('analytics.view', 'inventory.read'),
  validate({ query: analyticsRangeSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await manufacturingAnalytics.inventory(req.query as never) });
  }),
);

manufacturingRoutes.get(
  '/analytics/procurement',
  requirePermission('analytics.view', 'purchasing.read'),
  validate({ query: analyticsRangeSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await manufacturingAnalytics.procurement(req.query as never) });
  }),
);

manufacturingRoutes.get(
  '/analytics/quality',
  requirePermission('analytics.view', 'qc.read'),
  validate({ query: analyticsRangeSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await manufacturingAnalytics.quality(req.query as never) });
  }),
);

manufacturingRoutes.get(
  '/analytics/maintenance',
  requirePermission('analytics.view', 'maintenance.read'),
  validate({ query: analyticsRangeSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await manufacturingAnalytics.maintenance(req.query as never) });
  }),
);

// ── AI assistant (§25, §26) ────────────────────────────────────────────────
/**
 * Answer a manufacturing question from the business's own data.
 *
 * Every figure is queried and totalled in the database before the assistant
 * sees it, so the answer cannot drift from what the tables say. Returns null
 * when the question is not one this module knows, and the caller falls through
 * to the general assistant rather than this guessing.
 *
 * Read-only, and gated on `manufacturing.read`: the answer can contain stock,
 * cost and supplier figures, so it is not more open than the screens showing
 * the same things.
 */
manufacturingRoutes.post(
  '/assistant/ask',
  requirePermission('manufacturing.read'),
  validate({ body: z.object({ prompt: z.string().trim().min(3).max(500) }) }),
  wrap(async (req, res) => {
    const answer = await manufacturingAi.answer(req.body.prompt);
    res.json({
      success: true,
      data: answer ?? {
        intent: null,
        summary: null,
        // Said plainly rather than answered badly. A confident wrong figure is
        // worse than "I do not know that one".
        message: 'That is not a manufacturing question this assistant can answer from your data.',
        knownIntents: manufacturingAi.intents,
      },
    });
  }),
);

/**
 * What the assistant may offer to do about a production order.
 *
 * Proposals only. Each names an endpoint the client calls *after* the person
 * agrees, and carries `requiresConfirmation`, so nothing can treat one as
 * automatic (§26).
 */
manufacturingRoutes.get(
  '/orders/:id/suggested-actions',
  requirePermission('production.read'),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await manufacturingAi.actionsForProductionOrder(req.params.id as string),
    });
  }),
);

// ── Alerts (§27) ───────────────────────────────────────────────────────────
/**
 * Look for the things that are true rather than the things that just happened.
 *
 * Overdue runs and machines past their service date are states — nothing fires
 * at the instant they become true — so somebody has to look. Exposed as an
 * endpoint so a scheduler, or an administrator, can run it.
 */
manufacturingRoutes.post(
  '/alerts/sweep',
  requirePermission('manufacturing.manage_settings'),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await manufacturingAlerts.runSweep(req.auth!.organizationId!),
    });
  }),
);
