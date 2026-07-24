import { Router, type Request, type RequestHandler, type Response } from 'express';
import { validate } from '../middleware/validate';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import {
  assignSchema,
  assignmentConfigSchema,
  closeDealSchema,
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
import { saveWorkflowsSchema, workflowService } from '../../../application/crm/workflow.service';

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
      data: await crmService.closeDeal(
        req.params.id as string,
        req.body.outcome,
        req.body.lostReason
      ),
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
  validate({ body: leadSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await crmService.createLead(req.body) });
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
      data: await crmService.updateLeadStatus(req.params.id as string, req.body.status),
    });
  })
);

crmRoutes.post(
  '/leads/:id/convert',
  requirePermission('crm.update', 'customers.create'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await crmService.convertLead(req.params.id as string) });
  })
);

// Integration / website / API auto-capture — always routes through assignment rules.
crmRoutes.post(
  '/leads/capture',
  requirePermission('crm.create'),
  validate({ body: leadSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await crmService.createLead(req.body, { forceAutoAssign: true }) });
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
  requirePermission('crm.create'),
  validate({ body: noteSchema }),
  wrap(async (req, res) => {
    res.status(201).json({ success: true, data: await crmService.createNote(req.body) });
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
