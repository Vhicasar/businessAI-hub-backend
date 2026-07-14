import { AsyncLocalStorage } from 'async_hooks';

/**
 * Request-scoped context carried through the async call chain.
 * The tenant Prisma extension reads organizationId from here to
 * auto-scope every query (see infrastructure/database/prisma.ts).
 */
export interface RequestContext {
  requestId: string;
  userId?: string;
  organizationId?: string;
  membershipId?: string;
  roleId?: string;
  isSuperAdmin?: boolean;
  /** Set true only by platform-admin code paths and system jobs. */
  bypassTenant?: boolean;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const requestContext = {
  run<T>(ctx: RequestContext, fn: () => T): T {
    return storage.run(ctx, fn);
  },
  get(): RequestContext | undefined {
    return storage.getStore();
  },
  /** Mutates the current store (e.g. after JWT verification). */
  assign(patch: Partial<RequestContext>): void {
    const store = storage.getStore();
    if (store) Object.assign(store, patch);
  },
};
