import { PrismaClient } from '@prisma/client';
import { requestContext } from '../../shared/context';
import { logger } from '../../shared/logger';
import { TENANT_MODELS } from './tenant-models.generated';

/**
 * Models that carry an `organizationId` column get automatic tenant scoping:
 * - reads/updates/deletes: `where.organizationId` is injected
 * - creates: `data.organizationId` is injected when absent
 *
 * TENANT_MODELS is generated from the schema by scripts/generate-tenant-models.js
 * (runs with `npm run prisma:generate`), since Prisma 5 removed runtime DMMF access.
 */

// Ops whose `where` accepts arbitrary filters — safe to AND-inject the tenant.
const READ_OPS = new Set(['findFirst', 'findFirstOrThrow', 'findMany', 'count', 'aggregate', 'groupBy']);
const WRITE_WHERE_OPS = new Set(['updateMany', 'deleteMany']);
const CREATE_OPS = new Set(['create', 'createMany']);
// Ops keyed by a unique input — Prisma rejects AND-wrapping there, so tenant
// ownership is validated on the result instead.
const UNIQUE_OPS = new Set(['findUnique', 'findUniqueOrThrow', 'update', 'delete', 'upsert']);

function currentOrgId(): string | undefined {
  const ctx = requestContext.get();
  if (!ctx || ctx.bypassTenant) return undefined;
  return ctx.organizationId;
}

const base = new PrismaClient({
  log: [
    { emit: 'event', level: 'warn' },
    { emit: 'event', level: 'error' },
  ],
});

base.$on('warn', (e) => logger.warn({ prisma: e.message }));
base.$on('error', (e) => logger.error({ prisma: e.message }));

export const prisma = base.$extends({
  name: 'tenantScope',
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        if (!model || !TENANT_MODELS.has(model)) return query(args);
        const orgId = currentOrgId();
        if (!orgId) return query(args);

        const a = args as Record<string, unknown>;

        if (READ_OPS.has(operation) || WRITE_WHERE_OPS.has(operation)) {
          a.where = { AND: [{ organizationId: orgId }, (a.where as object) ?? {}] };
        } else if (CREATE_OPS.has(operation)) {
          if (operation === 'create') {
            const data = (a.data ?? {}) as Record<string, unknown>;
            if (data.organizationId === undefined && data.organization === undefined) {
              data.organizationId = orgId;
            }
            a.data = data;
          } else {
            const data = a.data;
            if (Array.isArray(data)) {
              a.data = data.map((d: Record<string, unknown>) =>
                d.organizationId === undefined ? { ...d, organizationId: orgId } : d
              );
            }
          }
        } else if (UNIQUE_OPS.has(operation)) {
          const result = await query(args);
          if (
            result &&
            typeof result === 'object' &&
            'organizationId' in (result as Record<string, unknown>) &&
            (result as Record<string, unknown>).organizationId !== orgId
          ) {
            if (operation === 'findUnique') return null; // behave as "not found"
            logger.error(
              { model, operation },
              'Tenant isolation violation detected on unique-keyed operation'
            );
            throw new Error('Cross-tenant access denied');
          }
          return result;
        }
        return query(args);
      },
    },
  },
});

export type Db = typeof prisma;

/** Raw client for system jobs, platform admin and migrations. Use sparingly. */
export const prismaUnscoped = base;

export async function connectDatabase(): Promise<void> {
  await base.$connect();
  logger.info('Database connected');
}

export async function disconnectDatabase(): Promise<void> {
  await base.$disconnect();
}
