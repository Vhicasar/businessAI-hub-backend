import { Router, type Request, type RequestHandler, type Response } from 'express';
import multer from 'multer';
import { authenticate, requireTenant } from '../middleware/authenticate';
import { requirePermission } from '../middleware/require-permission';
import { filesService } from '../../../application/files/files.service';
import { env } from '../../../shared/config/env';
import { ValidationError } from '../../../shared/errors';

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

// In-memory: files go straight to the storage driver, never to a temp file.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.storage.maxBytes, files: 1 },
});

export const filesRoutes = Router();
filesRoutes.use(authenticate, requireTenant);

/**
 * Generic image upload. Returns { id, url } which the caller then attaches to
 * whatever it's illustrating (an org logo, a product, an employee). Kept
 * separate from attachment so the same primitive serves every feature.
 *
 * `files.upload` is granted to most roles; the *attaching* endpoint on each
 * feature enforces that feature's own write permission.
 */
filesRoutes.post(
  '/',
  requirePermission('files.upload'),
  upload.single('file'),
  wrap(async (req, res) => {
    if (!req.file) throw new ValidationError('Attach a file under the "file" field');
    const entity = typeof req.body.entity === 'string' ? req.body.entity.replace(/[^a-z]/gi, '') : 'misc';
    // From req.auth, not the async context — see filesService.upload.
    const data = await filesService.upload(req.file, {
      organizationId: req.auth!.organizationId!,
      uploadedById: req.auth!.userId,
      entity: entity || 'misc',
      isPublic: true,
    });
    res.status(201).json({ success: true, data });
  }),
);

filesRoutes.delete(
  '/:id',
  requirePermission('files.delete'),
  wrap(async (req, res) => {
    await filesService.remove(req.params.id as string);
    res.json({ success: true, data: { deleted: true } });
  }),
);
