import { NotFoundError, ValidationError } from '../../shared/errors';
import { prisma } from '../../infrastructure/database/prisma';
import { storage } from '../../infrastructure/storage/storage';
import { env } from '../../shared/config/env';

/**
 * The bridge between raw storage and the domain: it owns the File table.
 *
 * Every uploaded file becomes one File row (who uploaded it, what entity it
 * belongs to, its storage key + driver). Features reference files by id and ask
 * here for a browser URL — they never touch the storage driver directly.
 */

/** What we accept. Images for the visual features; PDF for documents. */
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml'];
const DOC_TYPES = ['application/pdf'];

export interface UploadedFile {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
}

export interface UploadOptions {
  /** Owner + uploader, passed explicitly. See the note below on why. */
  organizationId: string | null;
  uploadedById: string | null;
  entity: string;
  entityType?: string;
  entityId?: string;
  isPublic?: boolean;
  allow?: 'image' | 'any';
}

export const filesService = {
  /**
   * Store an uploaded file and record it.
   *
   * `organizationId`/`uploadedById` are passed EXPLICITLY, not read from the
   * request's AsyncLocalStorage context — multer buffers the upload on its own
   * stream, which can run outside that context, so reading it here would
   * intermittently lose the tenant and misfile (or cross-tenant) the object.
   * The route reads them from `req.auth`, which lives on the request object and
   * survives multer.
   */
  async upload(file: UploadedFile, opts: UploadOptions) {
    if (!file || !file.buffer?.length) throw new ValidationError('No file was uploaded');
    if (file.size > env.storage.maxBytes) {
      throw new ValidationError(`File is too large (max ${env.storage.maxBytes / 1024 / 1024}MB)`);
    }
    const allowed = opts.allow === 'any' ? [...IMAGE_TYPES, ...DOC_TYPES] : IMAGE_TYPES;
    if (!allowed.includes(file.mimetype)) {
      throw new ValidationError(`Unsupported file type "${file.mimetype}"`);
    }

    const stored = await storage.put({
      organizationId: opts.organizationId,
      entity: opts.entity,
      buffer: file.buffer,
      mimeType: file.mimetype,
      originalName: file.originalname,
      isPublic: opts.isPublic ?? true,
    });

    const record = await prisma.file.create({
      data: {
        organizationId: opts.organizationId,
        driver: stored.driver,
        key: stored.key,
        fileName: file.originalname.slice(0, 200),
        mimeType: file.mimetype,
        sizeBytes: stored.sizeBytes,
        checksum: stored.checksum,
        uploadedById: opts.uploadedById,
        entityType: (opts.entityType as never) ?? null,
        entityId: opts.entityId ?? null,
        isPublic: opts.isPublic ?? true,
      },
      select: { id: true, key: true, driver: true, isPublic: true, fileName: true, mimeType: true },
    });

    return { ...record, url: await storage.url(record.key, record.driver, record.isPublic) };
  },

  /** Resolve a file id to a browser URL, or null if the id is null/missing. */
  async urlFor(fileId: string | null | undefined): Promise<string | null> {
    if (!fileId) return null;
    const f = await prisma.file.findFirst({
      where: { id: fileId, deletedAt: null },
      select: { key: true, driver: true, isPublic: true },
    });
    if (!f) return null;
    return storage.url(f.key, f.driver, f.isPublic);
  },

  /**
   * Resolve many file ids at once (avoids N queries when listing). Returns a
   * map of id → url for the ids that exist.
   */
  async urlMap(fileIds: (string | null | undefined)[]): Promise<Map<string, string>> {
    const ids = [...new Set(fileIds.filter((x): x is string => Boolean(x)))];
    if (ids.length === 0) return new Map();
    const rows = await prisma.file.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: { id: true, key: true, driver: true, isPublic: true },
    });
    const out = new Map<string, string>();
    for (const r of rows) out.set(r.id, await storage.url(r.key, r.driver, r.isPublic));
    return out;
  },

  /** Soft-delete the record and remove the underlying object. */
  async remove(fileId: string) {
    const f = await prisma.file.findFirst({ where: { id: fileId, deletedAt: null } });
    if (!f) throw new NotFoundError('File');
    await prisma.file.update({ where: { id: fileId }, data: { deletedAt: new Date() } });
    await storage.delete(f.key, f.driver);
  },
};
