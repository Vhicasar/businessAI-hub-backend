import { requestContext } from './context';
import { ForbiddenError } from './errors';

/**
 * Attribute-Based Access Control (System Bible I §7 / API Bible §4). RBAC (the
 * requirePermission middleware) answers "can this role do this action?"; ABAC
 * adds the finer, data-dependent checks — branch scope, ownership, resource
 * attributes — that permissions alone can't express.
 *
 * These helpers run inside services once the target record is loaded, since
 * they need the resource's attributes. Super admins bypass ABAC.
 */

export interface AbacResource {
  organizationId?: string | null;
  branchId?: string | null;
  ownerUserId?: string | null;
}

function isSuperAdmin(): boolean {
  return requestContext.get()?.isSuperAdmin === true;
}

export const abac = {
  /** True if the caller may act on a resource confined to a specific branch. */
  canAccessBranch(resourceBranchId: string | null | undefined): boolean {
    if (isSuperAdmin()) return true;
    const ctx = requestContext.get();
    // A user not scoped to a branch (org-wide role) sees all branches.
    const callerBranch = (ctx as { branchId?: string } | undefined)?.branchId;
    if (!callerBranch) return true;
    if (!resourceBranchId) return true;
    return callerBranch === resourceBranchId;
  },

  /** True if the caller owns the resource. */
  isOwner(ownerUserId: string | null | undefined): boolean {
    if (isSuperAdmin()) return true;
    const uid = requestContext.get()?.userId;
    return Boolean(uid && ownerUserId && uid === ownerUserId);
  },

  /** Throw unless the caller passes the given attribute checks. */
  enforce(resource: AbacResource, opts: { requireOwner?: boolean; requireBranch?: boolean } = {}): void {
    if (isSuperAdmin()) return;
    if (opts.requireBranch && !this.canAccessBranch(resource.branchId)) {
      throw new ForbiddenError('This record belongs to another branch');
    }
    if (opts.requireOwner && !this.isOwner(resource.ownerUserId)) {
      throw new ForbiddenError('You can only act on records you own');
    }
  },
};
