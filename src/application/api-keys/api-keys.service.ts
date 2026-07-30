import { createHash, randomBytes } from 'node:crypto';
import { prisma, prismaUnscoped } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { NotFoundError, ValidationError } from '../../shared/errors';

const currentOrgId = (): string => {
  const id = requestContext.get()?.organizationId;
  if (!id) throw new ValidationError('No tenant in context');
  return id;
};

/**
 * Public-API access keys for a business's own developers. A key authenticates
 * requests AS the organization (no user session) and is limited to a set of
 * scopes. The raw secret is shown once at creation; only its SHA-256 hash and a
 * short visible prefix are stored.
 */

/** Fine-grained scopes a key can be granted (module.action). */
export const API_SCOPES = [
  'customers.read',
  'customers.write',
  'catalog.read',
  'orders.read',
  'orders.write',
  'inventory.read',
  'crm.read',
  'ai.use',
] as const;
export type ApiScope = (typeof API_SCOPES)[number];

const sha256 = (raw: string) => createHash('sha256').update(raw).digest('hex');

export const apiKeysService = {
  /** Keys for the current org (never the hash or raw secret). */
  async list() {
    const rows = await prisma.apiKey.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, name: true, prefix: true, scopes: true,
        lastUsedAt: true, expiresAt: true, revokedAt: true, createdAt: true,
      },
    });
    return rows.map((r) => ({ ...r, scopes: Array.isArray(r.scopes) ? (r.scopes as string[]) : [] }));
  },

  /** Create a key; returns the raw secret ONCE (never retrievable again). */
  async create(dto: { name: string; scopes: string[]; expiresAt?: string | null }, createdById: string | null) {
    const raw = `bh_live_${randomBytes(24).toString('hex')}`;
    const prefix = raw.slice(0, 16); // e.g. bh_live_a1b2c3d4 — a stable public identifier
    const key = await prisma.apiKey.create({
      data: {
        organizationId: currentOrgId(),
        name: dto.name,
        keyHash: sha256(raw),
        prefix,
        scopes: dto.scopes,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
        createdById,
      },
      select: { id: true, name: true, prefix: true },
    });
    return { ...key, scopes: dto.scopes, key: raw };
  },

  async revoke(id: string) {
    const key = await prisma.apiKey.findFirst({ where: { id } });
    if (!key) throw new NotFoundError('API key');
    await prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
    return { revoked: true };
  },

  /**
   * Resolve a raw key to its org + scopes for the key-auth middleware. Runs
   * before any tenant context exists, so it uses the unscoped client and looks
   * up by the globally-unique hash. Refreshes lastUsedAt at most once a minute.
   */
  async authenticate(rawKey: string) {
    const key = await prismaUnscoped.apiKey.findUnique({ where: { keyHash: sha256(rawKey) } });
    if (!key || key.revokedAt || (key.expiresAt && key.expiresAt.getTime() < Date.now())) return null;
    if (!key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() > 60_000) {
      void prismaUnscoped.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
    }
    return {
      keyId: key.id,
      organizationId: key.organizationId,
      scopes: Array.isArray(key.scopes) ? (key.scopes as string[]) : [],
    };
  },
};
