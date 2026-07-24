import { createHash, randomUUID } from 'crypto';
import { createReadStream, existsSync } from 'fs';
import { mkdir, unlink, writeFile } from 'fs/promises';
import { dirname, extname, join, resolve } from 'path';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../../shared/config/env';
import { logger } from '../../shared/logger';

/**
 * File storage abstraction with two interchangeable drivers:
 *
 *   • r2    — Cloudflare R2, via the S3-compatible API. Production.
 *   • local — the app's own disk, served under /uploads. Dev default, so the
 *             upload features work with no cloud account.
 *
 * The driver is chosen once from config (env.storage.driver). Everything above
 * this file — the File service, the routes, the features — is driver-agnostic:
 * it stores an opaque `key` and asks here for a URL when it needs one.
 *
 * Object keys are namespaced by organisation and content-addressed by a random
 * id, so nothing collides and nothing is guessable:
 *   org/<orgId>/<entity>/<uuid>.<ext>
 */

export interface StoredObject {
  key: string;
  driver: 'LOCAL' | 'S3';
  sizeBytes: number;
  checksum: string;
}

export interface PutInput {
  organizationId: string | null;
  entity: string; // 'logo' | 'product' | 'avatar' | 'property' | …
  buffer: Buffer;
  mimeType: string;
  originalName: string;
  /** Public objects get a stable URL; private ones are signed on read. */
  isPublic: boolean;
}

function safeExt(name: string, mime: string): string {
  const fromName = extname(name).toLowerCase().replace(/[^.a-z0-9]/g, '');
  if (fromName && fromName.length <= 6) return fromName;
  const fromMime: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/svg+xml': '.svg',
    'application/pdf': '.pdf',
  };
  return fromMime[mime] ?? '';
}

function makeKey(input: PutInput): string {
  const scope = input.organizationId ? `org/${input.organizationId}` : 'platform';
  return `${scope}/${input.entity}/${randomUUID()}${safeExt(input.originalName, input.mimeType)}`;
}

// ─────────────────────────────── R2 driver ────────────────────────────────
let s3: S3Client | null = null;
function client(): S3Client {
  if (!s3) {
    s3 = new S3Client({
      region: 'auto',
      endpoint: env.storage.r2.endpoint,
      credentials: {
        accessKeyId: env.storage.r2.accessKeyId,
        secretAccessKey: env.storage.r2.secretAccessKey,
      },
    });
  }
  return s3;
}

// ────────────────────────────── local driver ──────────────────────────────
const localRoot = resolve(env.storage.local.dir);
async function localPath(key: string): Promise<string> {
  const full = join(localRoot, key);
  // Defence in depth: a crafted key must never escape the upload root.
  if (!resolve(full).startsWith(localRoot)) throw new Error('Invalid storage key');
  return full;
}

export const storage = {
  driver: env.storage.driver,

  async put(input: PutInput): Promise<StoredObject> {
    const key = makeKey(input);
    const checksum = createHash('sha256').update(input.buffer).digest('hex');

    if (env.storage.driver === 'r2') {
      await client().send(
        new PutObjectCommand({
          Bucket: env.storage.r2.bucket,
          Key: key,
          Body: input.buffer,
          ContentType: input.mimeType,
          ChecksumSHA256: undefined,
        }),
      );
      return { key, driver: 'S3', sizeBytes: input.buffer.length, checksum };
    }

    const path = await localPath(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, input.buffer);
    return { key, driver: 'LOCAL', sizeBytes: input.buffer.length, checksum };
  },

  /**
   * A URL the browser can load.
   *
   * Public objects get a stable URL (R2 public bucket URL, or the local
   * /uploads path). Private objects on R2 get a short-lived signed URL; private
   * local objects fall back to the served path (dev only — R2 is prod).
   */
  async url(key: string, driver: 'LOCAL' | 'S3', isPublic: boolean): Promise<string> {
    if (driver === 'S3') {
      if (isPublic && env.storage.r2.publicUrl) {
        return `${env.storage.r2.publicUrl.replace(/\/+$/, '')}/${key}`;
      }
      // Signed URL, valid for an hour — long enough for a page load, short
      // enough not to leak.
      return getSignedUrl(
        client(),
        new GetObjectCommand({ Bucket: env.storage.r2.bucket, Key: key }),
        { expiresIn: 3600 },
      );
    }
    return `${env.storage.local.baseUrl}/${key}`;
  },

  async delete(key: string, driver: 'LOCAL' | 'S3'): Promise<void> {
    try {
      if (driver === 'S3') {
        await client().send(new DeleteObjectCommand({ Bucket: env.storage.r2.bucket, Key: key }));
        return;
      }
      const path = await localPath(key);
      if (existsSync(path)) await unlink(path);
    } catch (err) {
      // A failed delete of a now-orphaned object is not worth failing the
      // user's action over; it can be swept later.
      logger.warn({ err, key, driver }, 'storage delete failed');
    }
  },

  /** Local-only: a read stream for the static file route. */
  localStream(key: string) {
    const full = join(localRoot, key);
    if (!resolve(full).startsWith(localRoot) || !existsSync(full)) return null;
    return createReadStream(full);
  },
};
