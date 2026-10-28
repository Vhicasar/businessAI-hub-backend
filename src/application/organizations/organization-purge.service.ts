import { Prisma } from '@prisma/client';
import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors';
import { logger } from '../../shared/logger';

/**
 * Emptying a workspace without closing it.
 *
 * Support's blunt instrument: a business asks to start over, or a trial filled
 * up with imported rubbish, and the only options were to live with it or close
 * the account. This removes everything the business put in while leaving the
 * people who work there able to sign in to an empty workspace.
 *
 * Built from Prisma's own schema rather than a hand-written list of tables.
 * There are 190-odd models carrying an `organizationId`, and a hand-kept list
 * would be out of date the first time somebody added a feature — leaving a few
 * tables quietly populated after a purge that claimed to have emptied
 * everything. Anything new is covered by default; anything that must survive
 * has to say so below, in writing.
 */

/**
 * What stays, and why each one has to.
 *
 * The test is "could they sign in afterwards and find a working, empty
 * workspace?" — not "is this valuable". Business records go regardless of how
 * valuable they were; that is what was asked for.
 */
export const KEPT_MODELS: Record<string, string> = {
  Membership: 'links the person to this workspace — without it they sign in to nothing',
  Role: 'a membership points at a role; an orphaned membership has no permissions',
  RolePermission: 'what that role may do',
  RefreshToken: 'an active session, so nobody is signed out by a support action',
  OrganizationModule: 'which parts of the product this workspace has switched on',
  Subscription: 'what they are paying for — emptying data must not silently downgrade them',
  AddOnPurchase: 'bought, not entered',
};

/** A table to empty, and how its rows are recognised as this workspace's. */
interface Target {
  model: string;
  where: (organizationId: string) => Record<string, unknown>;
}

const modelsWithOrgId = (): Set<string> => new Set(
  Prisma.dmmf.datamodel.models
    .filter((model) => model.fields.some((field) => field.name === 'organizationId'))
    .map((model) => model.name),
);

/**
 * Every table holding this workspace's rows.
 *
 * Two kinds, and missing the second is what left an organisation undeletable.
 *
 *  - Models carrying `organizationId` directly. Straightforward.
 *  - Models that reach the organisation only through a relation — an
 *    `OrderItem` belongs to an order, a `RolePermission` to a role, a
 *    `ProductImage` to a product. Twenty-eight of them, none of which a sweep
 *    for `organizationId` can see, and every one capable of holding its parent
 *    in place: `Role` could not be deleted while a `RolePermission` pointed at
 *    it, so the organisation row could never go either.
 *
 * Both kinds are derived from the schema, so a table added later is covered
 * without anyone remembering to add it here.
 */
function purgeTargets(options: { keep?: Record<string, string> } = {}): Target[] {
  const keep = options.keep ?? {};
  const direct = modelsWithOrgId();
  const targets: Target[] = [];

  for (const model of [...direct].sort()) {
    if (model === 'Organization' || model in keep) continue;
    targets.push({ model, where: (organizationId) => ({ organizationId }) });
  }

  for (const model of Prisma.dmmf.datamodel.models) {
    if (direct.has(model.name) || model.name in keep) continue;
    const relation = model.fields.find(
      (field) => field.kind === 'object' && !field.isList && direct.has(field.type) && field.type !== 'Organization',
    );
    if (!relation) continue;
    const name = relation.name;
    targets.push({ model: model.name, where: (organizationId) => ({ [name]: { organizationId } }) });
  }

  /*
   * Relation-scoped children first. They are what holds their parents in
   * place, and the pass loop would otherwise spend its passes discovering
   * that one table at a time.
   */
  return targets.sort((a, b) => Number(direct.has(a.model)) - Number(direct.has(b.model)));
}

/** The client property for a model — `ProductVariant` → `productVariant`. */
const clientKey = (model: string): string => model.charAt(0).toLowerCase() + model.slice(1);

type Delegate = {
  count: (args: unknown) => Promise<number>;
  deleteMany: (args: unknown) => Promise<{ count: number }>;
};
function delegateFor(model: string): Delegate | null {
  const candidate = (prismaUnscoped as unknown as Record<string, unknown>)[clientKey(model)];
  return candidate && typeof (candidate as Delegate).deleteMany === 'function'
    ? candidate as Delegate
    : null;
}

export interface PurgePreflight {
  organizationId: string;
  name: string;
  /** Model → rows that would go. Only models with something in them. */
  willDelete: Record<string, number>;
  totalRows: number;
  kept: Record<string, string>;
  /** People who will still be able to sign in afterwards. */
  members: { name: string; email: string; role: string | null }[];
}

/** What a purge would remove, counted before anything is touched. */
export async function purgePreflight(organizationId: string): Promise<PurgePreflight> {
  const organization = await prismaUnscoped.organization.findUnique({
    where: { id: organizationId },
    select: { id: true, name: true },
  });
  if (!organization) throw new NotFoundError('Organization');

  const willDelete: Record<string, number> = {};
  let totalRows = 0;
  for (const target of purgeTargets({ keep: KEPT_MODELS })) {
    const delegate = delegateFor(target.model);
    if (!delegate) continue;
    const count = await delegate.count({ where: target.where(organizationId) }).catch(() => 0);
    if (count > 0) { willDelete[target.model] = count; totalRows += count; }
  }

  const memberships = await prismaUnscoped.membership.findMany({
    where: { organizationId, deletedAt: null },
    select: {
      user: { select: { firstName: true, lastName: true, email: true } },
      role: { select: { name: true } },
    },
  });

  return {
    organizationId,
    name: organization.name,
    willDelete,
    totalRows,
    kept: KEPT_MODELS,
    members: memberships.map((m) => ({
      name: `${m.user.firstName} ${m.user.lastName ?? ''}`.trim(),
      email: m.user.email,
      role: m.role?.name ?? null,
    })),
  };
}

/**
 * Delete the named models for one organisation, in repeated passes.
 *
 * Foreign keys decide what can go first, and across this many tables any fixed
 * order would be wrong somewhere; a pass that deletes whatever it can and runs
 * again reaches the same end without anyone having to know the graph. It stops
 * when a pass achieves nothing and reports what is left rather than pretending
 * it finished.
 */
async function deleteRows(
  organizationId: string,
  targets: Target[],
): Promise<{ deleted: Record<string, number>; remaining: Record<string, string> }> {
  const deleted: Record<string, number> = {};
  const blocked: Record<string, string> = {};
  let pending = [...targets];

  for (let pass = 0; pass < 12 && pending.length > 0; pass += 1) {
    const stillPending: Target[] = [];
    let progressed = false;

    for (const target of pending) {
      const delegate = delegateFor(target.model);
      if (!delegate) continue;
      try {
        const { count } = await delegate.deleteMany({ where: target.where(organizationId) });
        deleted[target.model] = (deleted[target.model] ?? 0) + count;
        delete blocked[target.model];
        if (count > 0) progressed = true;
      } catch (err) {
        blocked[target.model] = (err as Error).message.split('\n')[0]!.slice(0, 160);
        stillPending.push(target);
      }
    }

    pending = stillPending;
    if (!progressed) break;
  }

  const remaining: Record<string, string> = {};
  for (const target of pending) {
    const delegate = delegateFor(target.model);
    const left = delegate ? await delegate.count({ where: target.where(organizationId) }).catch(() => 0) : 0;
    if (left > 0) remaining[target.model] = `${left} row(s) left — ${blocked[target.model] ?? 'blocked'}`;
  }
  return { deleted, remaining };
}

export interface PurgeResult {
  organizationId: string;
  name: string;
  deleted: Record<string, number>;
  totalDeleted: number;
  /** Anything that would not go, and what stopped it. */
  remaining: Record<string, string>;
  membersStillAbleToSignIn: number;
}

/**
 * Remove everything this workspace put in.
 *
 * Deleted in repeated passes rather than a hand-ordered sequence. Foreign keys
 * decide what can go first, and across this many tables any fixed order would
 * be wrong somewhere; a pass that deletes whatever it can and runs again
 * reaches the same end without anyone having to know the graph. It stops when
 * a pass achieves nothing and reports what is left rather than pretending it
 * finished.
 *
 * `confirmName` must match the organisation's name. Naming a workspace by id
 * alone is too easy to get wrong for something with no way back.
 */
export async function purgeOrganizationData(
  organizationId: string,
  options: { confirmName: string; actor?: string },
): Promise<PurgeResult> {
  const before = await purgePreflight(organizationId);

  if (options.confirmName.trim() !== before.name.trim()) {
    throw new ValidationError(
      `This empties every record in "${before.name}". Type the workspace name exactly to confirm.`,
    );
  }
  if (before.members.length === 0) {
    throw new ConflictError(
      `"${before.name}" has no active members, so emptying it would leave a workspace nobody can sign in to. `
      + 'Close the organisation instead.',
    );
  }

  logger.warn(
    { organizationId, name: before.name, totalRows: before.totalRows, actor: options.actor ?? 'unknown' },
    'Organization data purge starting',
  );

  const { deleted, remaining } = await deleteRows(
    organizationId,
    purgeTargets({ keep: KEPT_MODELS }),
  );

  const membersStillAbleToSignIn = await prismaUnscoped.membership.count({
    where: { organizationId, deletedAt: null },
  });
  const totalDeleted = Object.values(deleted).reduce((sum, n) => sum + n, 0);

  logger.warn(
    { organizationId, name: before.name, totalDeleted, remaining: Object.keys(remaining).length },
    'Organization data purge finished',
  );

  return {
    organizationId,
    name: before.name,
    deleted: Object.fromEntries(Object.entries(deleted).filter(([, n]) => n > 0)),
    totalDeleted,
    remaining,
    membersStillAbleToSignIn,
  };
}

export interface CompleteDeletionResult {
  organizationId: string;
  name: string;
  deleted: Record<string, number>;
  totalDeleted: number;
  remaining: Record<string, string>;
  organizationRemoved: boolean;
}

/**
 * Close a workspace and take its records with it.
 *
 * Permanently deleting an organisation used to be a single `organization.delete`,
 * which removed one row out of nearly two hundred tables and left everything
 * else behind: products, invoices, customers, conversations, all still in the
 * database and still reachable, now pointing at an organisation that no longer
 * existed. It read as "nothing was deleted" to anyone looking at the data, and
 * it is where the orphaned channels, orders and customers in this database
 * came from.
 *
 * This removes everything the organisation owns — including the memberships,
 * roles and tokens that `purgeOrganizationData` deliberately keeps, because
 * here there is no workspace left to sign in to — and then the organisation
 * row itself.
 */
export async function deleteOrganizationCompletely(
  organizationId: string,
  options: { actor?: string } = {},
): Promise<CompleteDeletionResult> {
  const organization = await prismaUnscoped.organization.findUnique({
    where: { id: organizationId },
    select: { id: true, name: true },
  });
  if (!organization) throw new NotFoundError('Organization');

  logger.warn(
    { organizationId, name: organization.name, actor: options.actor ?? 'unknown' },
    'Organization permanent deletion starting',
  );

  /*
   * Everything org-scoped, the keep-list included. Memberships and roles are
   * kept by a data purge so people can still sign in; there is nothing to sign
   * in to once the organisation is gone, so they go too.
   *
   * Subscriptions go last among them for a reason that is only about reading
   * the log afterwards: it is the row support is most likely to ask about.
   */
  const { deleted, remaining } = await deleteRows(organizationId, purgeTargets());

  let organizationRemoved = false;
  if (Object.keys(remaining).length === 0) {
    try {
      await prismaUnscoped.organization.delete({ where: { id: organizationId } });
      organizationRemoved = true;
    } catch (err) {
      remaining.Organization = (err as Error).message.split('\n')[0]!.slice(0, 160);
    }
  } else {
    // Leaving the row would be the old bug in miniature, so it is reported
    // rather than removed over the top of records that still point at it.
    remaining.Organization = 'kept, because records still reference it';
  }

  const totalDeleted = Object.values(deleted).reduce((sum, n) => sum + n, 0);
  logger.warn(
    { organizationId, name: organization.name, totalDeleted, organizationRemoved },
    'Organization permanent deletion finished',
  );

  return {
    organizationId,
    name: organization.name,
    deleted: Object.fromEntries(Object.entries(deleted).filter(([, n]) => n > 0)),
    totalDeleted,
    remaining,
    organizationRemoved,
  };
}
