import { prisma } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { ForbiddenError, NotFoundError } from '../../shared/errors';

/**
 * Per-member warehouse scoping.
 *
 * A warehouse manager who is given two warehouses should see those two and
 * nothing else — not every warehouse in the business. The rule is opt-in:
 *
 *   no assignment rows  → unrestricted (what every member is today)
 *   one or more rows    → confined to exactly those warehouses
 *
 * Owners are never confined; someone has to be able to hand out access.
 *
 * The lookup is memoised per request so a handler that touches the scope a
 * dozen times still costs one query.
 */

const CACHE = new WeakMap<object, Promise<Scope>>();

export interface Scope {
  /** null means "no restriction". */
  readable: string[] | null;
  /** null means "no restriction". Always a subset of `readable`. */
  writable: string[] | null;
}

const UNRESTRICTED: Scope = { readable: null, writable: null };

async function load(membershipId: string): Promise<Scope> {
  const membership = await prisma.membership.findFirst({
    where: { id: membershipId },
    select: { isOwner: true },
  });
  if (!membership || membership.isOwner) return UNRESTRICTED;

  const rows = await prisma.warehouseAssignment.findMany({
    where: { membershipId },
    select: { warehouseId: true, canManage: true },
  });
  if (rows.length === 0) return UNRESTRICTED;

  return {
    readable: rows.map((r) => r.warehouseId),
    writable: rows.filter((r) => r.canManage).map((r) => r.warehouseId),
  };
}

/** The current actor's warehouse scope. */
export async function warehouseScope(): Promise<Scope> {
  const ctx = requestContext.get();
  // Background jobs and system paths carry no membership and are unrestricted.
  if (!ctx?.membershipId) return UNRESTRICTED;
  const cached = CACHE.get(ctx);
  if (cached) return cached;
  const pending = load(ctx.membershipId);
  CACHE.set(ctx, pending);
  return pending;
}

/**
 * A `where` fragment for queries whose row IS a warehouse.
 * Spread it: `where: { deletedAt: null, ...(await warehouseIdFilter()) }`.
 */
export async function warehouseIdFilter(): Promise<{ id?: { in: string[] } }> {
  const { readable } = await warehouseScope();
  return readable ? { id: { in: readable } } : {};
}

/**
 * A `where` fragment for queries whose row merely POINTS at a warehouse.
 * `field` is the FK name, which differs between models (stock transfers have
 * two, receipts have one).
 */
export async function warehouseFieldFilter(
  field = 'warehouseId'
): Promise<Record<string, { in: string[] }>> {
  const { readable } = await warehouseScope();
  return readable ? { [field]: { in: readable } } : {};
}

/** Throws unless the actor may read this warehouse. */
export async function assertCanRead(warehouseId: string): Promise<void> {
  const { readable } = await warehouseScope();
  if (readable && !readable.includes(warehouseId)) {
    throw new ForbiddenError('You do not have access to this warehouse');
  }
}

/** Throws unless the actor may move stock in this warehouse. */
export async function assertCanManage(warehouseId: string): Promise<void> {
  const { writable } = await warehouseScope();
  if (writable && !writable.includes(warehouseId)) {
    throw new ForbiddenError('You do not have permission to manage this warehouse');
  }
}

/** True when the actor is confined to a subset — used to hide "all warehouses" UI. */
export async function isScoped(): Promise<boolean> {
  const { readable } = await warehouseScope();
  return readable !== null;
}

// ── Administration ─────────────────────────────────────────────────────────

export interface AssignmentInput {
  warehouseId: string;
  canManage?: boolean;
}

/** The warehouses a given member is confined to (empty array = unrestricted). */
export async function listAssignments(membershipId: string) {
  return prisma.warehouseAssignment.findMany({
    where: { membershipId },
    select: {
      warehouseId: true,
      canManage: true,
      warehouse: { select: { id: true, name: true, code: true, isActive: true } },
    },
    orderBy: { warehouse: { name: 'asc' } },
  });
}

/**
 * Replaces a member's warehouse access wholesale.
 *
 * Passing an empty list removes every restriction rather than locking the
 * member out of everything — "no assignments" has always meant unrestricted,
 * and an admin clearing the boxes is asking for exactly that.
 */
export async function setAssignments(
  membershipId: string,
  assignments: AssignmentInput[],
  organizationId: string
) {
  const membership = await prisma.membership.findFirst({
    where: { id: membershipId },
    select: { id: true },
  });
  if (!membership) throw new NotFoundError('Member');

  const ids = [...new Set(assignments.map((a) => a.warehouseId))];
  if (ids.length) {
    const found = await prisma.warehouse.count({ where: { id: { in: ids }, deletedAt: null } });
    if (found !== ids.length) throw new NotFoundError('Warehouse');
  }

  await prisma.$transaction(async (tx) => {
    await tx.warehouseAssignment.deleteMany({ where: { membershipId } });
    if (ids.length) {
      await tx.warehouseAssignment.createMany({
        data: assignments.map((a) => ({
          organizationId,
          membershipId,
          warehouseId: a.warehouseId,
          canManage: a.canManage ?? true,
        })),
        skipDuplicates: true,
      });
    }
  });

  return listAssignments(membershipId);
}
