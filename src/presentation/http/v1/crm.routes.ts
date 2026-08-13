import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission, callerHasPermission } from '../middleware/require-permission';
import { ForbiddenError } from '../../../shared/errors';
import {
  assignSchema,
  assignmentConfigSchema,
  closeDealSchema,
  convertLeadSchema,
  createPipelineSchema,
  crmService,
  dealAutomationSchema,
  dealSchema,
  leadSchema,
  leadStatusSchema,
  updateLeadSchema,
  listLeadsSchema,
  listNotesSchema,
  listTasksSchema,
  mergeLeadSchema,
  moveDealSchema,
  noteSchema,
  reorderStagesSchema,
  stageInputSchema,
  taskSchema,
  updatePipelineSchema,
  updateTaskSchema,
} from '../../../application/crm/crm.service';
import { activityService, listTimelineSchema } from '../../../application/crm/activity.service';
import { findLeadMatches, reengageLead } from '../../../application/crm/lead-matching.service';
import { leadFieldCatalog } from '../../../application/crm/lead-fields.service';
import { saveWorkflowsSchema, workflowService } from '../../../application/crm/workflow.service';
import { invoicesService } from '../../../application/invoices/invoices.service';
import { deliveryOptions } from '../../../application/invoices/invoice-delivery.service';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

export const crmRoutes = Router();
crmRoutes.use(authenticate, requireTenant);

// ------------------------------------------------------ pipelines
crmRoutes.get(
  '/pipelines',
  requirePermission('crm.read'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await crmService.listPipelines() });
  })
);

crmRoutes.post(
  '/pipelines',
  requirePermission('crm.manage_pipelines'),
  validate({ body: createPipelineSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await crmService.createPipeline(req.body) });
  })
);

crmRoutes.patch(
  '/pipelines/:id',
  requirePermission('crm.manage_pipelines'),
  validate({ body: updatePipelineSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await crmService.updatePipeline(req.params.id as string, req.body) });
  })
);

crmRoutes.delete(
  '/pipelines/:id',
  requirePermission('crm.manage_pipelines'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await crmService.deletePipeline(req.params.id as string) });
  })
);

crmRoutes.post(
  '/pipelines/:id/stages',
  requirePermission('crm.manage_pipelines'),
  validate({ body: stageInputSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await crmService.addStage(req.params.id as string, req.body) });
  })
);

crmRoutes.post(
  '/pipelines/:id/stages/reorder',
  requirePermission('crm.manage_pipelines'),
  validate({ body: reorderStagesSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await crmService.reorderStages(req.params.id as string, req.body.stageIds) });
  })
);

crmRoutes.patch(
  '/stages/:stageId',
  requirePermission('crm.manage_pipelines'),
  validate({ body: stageInputSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await crmService.updateStage(req.params.stageId as string, req.body) });
  })
);

crmRoutes.delete(
  '/stages/:stageId',
  requirePermission('crm.manage_pipelines'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await crmService.deleteStage(req.params.stageId as string) });
  })
);

// workflow automation
crmRoutes.get(
  '/workflows',
  requirePermission('crm.read'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await workflowService.getWorkflows() });
  })
);

crmRoutes.put(
  '/workflows',
  requirePermission('crm.manage_pipelines'),
  validate({ body: saveWorkflowsSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await workflowService.saveWorkflows(req.body.workflows) });
  })
);

// deal automation
crmRoutes.get(
  '/automation',
  requirePermission('crm.read'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await crmService.getDealAutomation() });
  })
);

crmRoutes.put(
  '/automation',
  requirePermission('crm.manage_pipelines'),
  validate({ body: dealAutomationSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await crmService.saveDealAutomation(req.body) });
  })
);

// deals board
crmRoutes.get(
  '/board',
  requirePermission('crm.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await crmService.board(req.query.pipelineId as string | undefined) });
  })
);

crmRoutes.post(
  '/deals',
  requirePermission('crm.create'),
  validate({ body: dealSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await crmService.createDeal(req.body) });
  })
);

crmRoutes.post(
  '/deals/:id/move',
  requirePermission('crm.update'),
  validate({ body: moveDealSchema }),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await crmService.moveDeal(req.params.id as string, req.body.stageId),
    });
  })
);

crmRoutes.post(
  '/deals/:id/close',
  requirePermission('crm.update'),
  validate({ body: closeDealSchema }),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await crmService.closeDeal(req.params.id as string, req.body),
    });
  })
);

// Generate an invoice from a deal (manual). Auto-generation on win is
// controlled by the deal-automation settings.
/** Change what a deal is worth. A reason is required, not optional. */
crmRoutes.patch(
  '/deals/:id/value',
  requirePermission('crm.change_value', 'crm.update'),
  validate({
    body: z.object({
      value: z.coerce.number().nonnegative(),
      reason: z.string().trim().min(3).max(500),
    }),
  }),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await crmService.changeDealValue(req.params.id as string, req.body.value, req.body.reason),
    });
  })
);

/** Every value change on a deal, so the current figure can be explained. */
crmRoutes.get(
  '/deals/:id/value-history',
  requirePermission('crm.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await crmService.dealValueHistory(req.params.id as string) });
  })
);

/** Original vs current value, invoiced, paid and outstanding. */
crmRoutes.get(
  '/deals/:id/financials',
  requirePermission('crm.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await crmService.dealFinancials(req.params.id as string) });
  })
);

/**
 * Whether this deal already has an invoice, and whether the deal value has
 * moved since — what the UI needs to ask before creating another.
 */
crmRoutes.get(
  '/deals/:id/invoice-status',
  requirePermission('invoices.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await invoicesService.dealInvoiceStatus(req.params.id as string) });
  })
);

/**
 * Void the deal's current invoice and raise a replacement.
 *
 * `allowPaid` is the caller stating they accept voiding something already paid;
 * it additionally requires `invoices.void`, because that is a reconciliation
 * decision rather than a billing correction.
 */
crmRoutes.post(
  '/deals/:id/invoice/replace',
  requirePermission('invoices.create'),
  validate({
    body: z.object({
      reason: z.string().trim().max(500).optional(),
      allowPaid: z.boolean().optional(),
      dueInDays: z.coerce.number().int().min(0).max(365).optional(),
    }),
  }),
  wrap(async (req, res) => {
    if (req.body.allowPaid && !(await callerHasPermission('invoices.void'))) {
      throw new ForbiddenError('Voiding an invoice that has received payment requires the invoices.void permission');
    }
    res.json({
      success: true,
      data: await invoicesService.replaceDealInvoice(req.params.id as string, req.body),
    });
  })
);

crmRoutes.post(
  '/deals/:id/invoice',
  requirePermission('invoices.create'),
  wrap(async (req, res) => {
    const dueInDays = Number(req.body?.dueInDays);
    res.status(201).json({
      success: true,
      data: await (async () => {
        const invoice = await invoicesService.createFromDeal(
          req.params.id as string,
          Number.isFinite(dueInDays) ? dueInDays : undefined,
        );
        // Returned with the invoice so the UI can immediately ask whether to
        // send it, and show which channels are actually usable — rather than
        // sending on the user's behalf.
        const delivery = await deliveryOptions(invoice.id).catch(() => null);
        return { invoice, delivery };
      })(),
    });
  })
);

// leads
crmRoutes.get(
  '/leads',
  requirePermission('crm.read'),
  validate({ query: listLeadsSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await crmService.listLeads(req.query as never) });
  })
);

crmRoutes.post(
  '/leads',
  requirePermission('crm.create'),
  validate({ body: leadSchema.extend({ onDuplicate: z.enum(['ask', 'reengage', 'create']).optional() }) }),
  wrap(async (req, res) => {
    const { onDuplicate, ...lead } = req.body;
    // Defaults to `ask`, which 409s with the matches so the UI can offer the
    // choice instead of the server silently merging.
    res.status(201).json({ success: true, data: await crmService.createLead(lead, { onDuplicate }) });
  })
);

crmRoutes.get(
  '/leads/:id',
  requirePermission('crm.read'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await crmService.getLead(req.params.id as string) });
  })
);

crmRoutes.patch(
  '/leads/:id',
  requirePermission('crm.update'),
  validate({ body: updateLeadSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await crmService.updateLead(req.params.id as string, req.body) });
  })
);

crmRoutes.patch(
  '/leads/:id/status',
  requirePermission('crm.update'),
  validate({ body: leadStatusSchema }),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await crmService.updateLeadStatus(req.params.id as string, req.body.status, req.body.close),
    });
  })
);

/**
 * Turn a lead into a deal. The body is optional — the confirmation dialog may
 * send an adjusted title, value, pipeline or owner, and sends nothing when the
 * user simply confirms.
 */
crmRoutes.post(
  '/leads/:id/convert',
  requirePermission('crm.convert', 'crm.update'),
  validate({ body: convertLeadSchema.partial() }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await crmService.convertLead(req.params.id as string, req.body) });
  })
);

/**
 * Who this prospect might already be, before anything is written.
 *
 * The create dialog calls this so it can show the user the matches and let them
 * decide — the server no longer picks for them.
 */
/**
 * The Lead fields an automation may test, and the operators each one allows.
 *
 * The automation builder renders its dropdowns from this, so the choices a user
 * sees and the rules the server accepts come from one place.
 */
crmRoutes.get(
  '/automation/lead-fields',
  requirePermission('crm.read'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await leadFieldCatalog() });
  })
);

crmRoutes.post(
  '/leads/match',
  requirePermission('crm.read'),
  validate({
    body: z.object({
      firstName: z.string().trim().optional(),
      lastName: z.string().trim().nullable().optional(),
      email: z.string().trim().email().nullable().optional().or(z.literal('')),
      phone: z.string().trim().nullable().optional(),
      companyId: z.string().nullable().optional(),
      customerId: z.string().nullable().optional(),
    }),
  }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await findLeadMatches(req.body) });
  })
);

/** Attach a new inquiry to a lead the user chose, rather than opening another. */
crmRoutes.post(
  '/leads/:id/reengage',
  requirePermission('crm.reengage', 'crm.update'),
  validate({
    body: z.object({
      source: z.string().trim().max(60).nullable().optional(),
      note: z.string().trim().max(1000).nullable().optional(),
    }),
  }),
  wrap(async (req, res) => {
    res.json({
      success: true,
      data: await reengageLead({
        leadId: req.params.id as string,
        source: req.body.source ?? 'MANUAL',
        note: req.body.note ?? null,
      }),
    });
  })
);

// Integration / website / API auto-capture — always routes through assignment rules.
crmRoutes.post(
  '/leads/capture',
  requirePermission('crm.create'),
  validate({ body: leadSchema }),
  wrap(async (req, res) => {
    // Automated capture: re-engage a known prospect visibly rather than 409 at
    // an integration that cannot answer a dialog.
    res.status(201).json({
      success: true,
      data: await crmService.createLead(req.body, { forceAutoAssign: true, onDuplicate: 'reengage' }),
    });
  })
);

crmRoutes.post(
  '/leads/:id/assign',
  requirePermission('crm.update'),
  validate({ body: assignSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await crmService.assign('lead', req.params.id as string, req.body.ownerId) });
  })
);

crmRoutes.post(
  '/leads/:id/merge',
  requirePermission('crm.update'),
  validate({ body: mergeLeadSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await crmService.mergeLeads(req.params.id as string, req.body.duplicateId) });
  })
);

crmRoutes.post(
  '/leads/reassign-stale',
  requirePermission('crm.update'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await crmService.reassignStaleLeads() });
  })
);

// ------------------------------------------------------ members & assignment rules
crmRoutes.get(
  '/members',
  requirePermission('crm.read'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await crmService.listMembers() });
  })
);

crmRoutes.get(
  '/assignment',
  requirePermission('crm.read'),
  wrap(async (_req, res) => {
    res.json({ success: true, data: await crmService.getAssignmentConfig() });
  })
);

crmRoutes.put(
  '/assignment',
  requirePermission('crm.manage_pipelines'),
  validate({ body: assignmentConfigSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await crmService.saveAssignmentConfig(req.body) });
  })
);

crmRoutes.post(
  '/deals/:id/assign',
  requirePermission('crm.update'),
  validate({ body: assignSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await crmService.assign('deal', req.params.id as string, req.body.ownerId) });
  })
);

// ------------------------------------------------------ unified timeline
crmRoutes.get(
  '/timeline',
  requirePermission('crm.read'),
  validate({ query: listTimelineSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await activityService.list(req.query as never) });
  })
);

// ------------------------------------------------------ notes
crmRoutes.get(
  '/notes',
  requirePermission('crm.read'),
  validate({ query: listNotesSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await crmService.listNotes(req.query as never) });
  })
);

crmRoutes.post(
  '/notes',
  requirePermission('crm.note_create', 'crm.create'),
  validate({ body: noteSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await crmService.createNote(req.body) });
  })
);

/**
 * Edit a note.
 *
 * Everyone with note access may correct their own; `crm.note_update` is what
 * allows editing someone else's, and the service enforces that rather than
 * trusting the route to have checked.
 */
crmRoutes.patch(
  '/notes/:id',
  requirePermission('crm.note_create', 'crm.create'),
  validate({ body: z.object({ body: z.string().trim().min(1).max(5000) }) }),
  wrap(async (req, res) => {
    const canEditOthers = await callerHasPermission('crm.note_update');
    res.json({
      success: true,
      data: await crmService.updateNote(req.params.id as string, req.body.body, canEditOthers),
    });
  })
);

crmRoutes.delete(
  '/notes/:id',
  requirePermission('crm.note_create', 'crm.create'),
  wrap(async (req, res) => {
    const canDeleteOthers = await callerHasPermission('crm.note_delete');
    res.json({
      success: true,
      data: await crmService.deleteNote(req.params.id as string, canDeleteOthers),
    });
  })
);

// ------------------------------------------------------ tasks
crmRoutes.get(
  '/tasks',
  requirePermission('crm.read'),
  validate({ query: listTasksSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await crmService.listTasks(req.query as never) });
  })
);

crmRoutes.post(
  '/tasks',
  requirePermission('crm.create'),
  validate({ body: taskSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await crmService.createTask(req.body) });
  })
);

crmRoutes.patch(
  '/tasks/:id',
  requirePermission('crm.update'),
  validate({ body: updateTaskSchema }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await crmService.updateTask(req.params.id as string, req.body) });
  })
);
