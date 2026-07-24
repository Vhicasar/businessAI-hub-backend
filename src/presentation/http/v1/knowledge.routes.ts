import { Router, type Request, type RequestHandler, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import { validate } from '../middleware/validate';
import { ValidationError } from '../../../shared/errors';
import { knowledgeService, extractDocumentText } from '../../../application/knowledge/knowledge.service';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

export const knowledgeRoutes = Router();
knowledgeRoutes.use(authenticate, requireTenant);

const orgId = (req: Request) => req.auth!.organizationId!;

/** List the org's knowledge sources + ingest status. */
knowledgeRoutes.get(
  '/sources',
  requirePermission('ai.use_assistant'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await knowledgeService.list(orgId(req)) });
  }),
);

const addSchema = z.object({
  type: z.enum(['URL', 'TEXT']),
  title: z.string().trim().min(1).max(200),
  url: z.string().url().optional(),
  text: z.string().max(500_000).optional(),
});

/** Add a website URL or pasted text; ingestion runs in the background. */
knowledgeRoutes.post(
  '/sources',
  requirePermission('ai.use_assistant'),
  validate({ body: addSchema }),
  wrap(async (req, res) => {
    const source = await knowledgeService.addSource(orgId(req), req.body);
    res.status(201).json({ success: true, data: source });
  }),
);

/** Upload a document (PDF / TXT / Markdown / CSV); its text is ingested. */
knowledgeRoutes.post(
  '/sources/upload',
  requirePermission('ai.use_assistant'),
  upload.single('file'),
  wrap(async (req, res) => {
    if (!req.file) throw new ValidationError('Attach a file under the "file" field');
    const text = await extractDocumentText(req.file.buffer, req.file.mimetype, req.file.originalname);
    if (text.trim().length < 20) throw new ValidationError('No readable text found in that file');
    const title = (typeof req.body.title === 'string' && req.body.title.trim()) || req.file.originalname;
    const source = await knowledgeService.addSource(orgId(req), { type: 'DOCUMENT', title, text });
    res.status(201).json({ success: true, data: source });
  }),
);

/** Re-crawl / re-ingest a source. */
knowledgeRoutes.post(
  '/sources/:id/reingest',
  requirePermission('ai.use_assistant'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await knowledgeService.reingest(orgId(req), req.params.id as string) });
  }),
);

knowledgeRoutes.delete(
  '/sources/:id',
  requirePermission('ai.use_assistant'),
  wrap(async (req, res) => {
    res.json({ success: true, data: await knowledgeService.remove(orgId(req), req.params.id as string) });
  }),
);

/** Test the assistant against the knowledge base. */
knowledgeRoutes.post(
  '/ask',
  requirePermission('ai.use_assistant'),
  validate({ body: z.object({ question: z.string().trim().min(1).max(1000) }) }),
  wrap(async (req, res) => {
    res.json({ success: true, data: await knowledgeService.answer(orgId(req), req.body.question) });
  }),
);
