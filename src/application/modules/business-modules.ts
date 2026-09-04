import { prismaUnscoped } from '../../infrastructure/database/prisma';
import type { BusinessType } from '@prisma/client';

/**
 * Which optional modules a business may use.
 *
 * Some parts of the product only make sense for some kinds of business. A
 * bakery needs a bill of materials; an estate agent does not, and showing them
 * one is worse than not having built it — it is a menu full of things that
 * cannot be made to work.
 *
 * The decision is made here and nowhere else. A page that decides for itself
 * whether to render is a page that will disagree with the API in front of it,
 * which is how someone ends up on a screen that then refuses every request.
 * Clients read the answer; they do not compute it.
 *
 * Two inputs, in order:
 *
 *  1. The business type — the default, and right for almost everyone.
 *  2. An explicit per-business override — because a business registered as
 *     "Retail" may genuinely also assemble what it sells, and the answer to
 *     that is a switch an administrator can throw, not a support ticket asking
 *     them to change their business type and disturb everything else.
 */

export interface BusinessModuleDefinition {
  id: string;
  label: string;
  description: string;
  /** Business types that get this module without anyone asking. */
  defaultFor: BusinessType[];
}

export const BUSINESS_MODULES: BusinessModuleDefinition[] = [
  {
    id: 'manufacturing',
    label: 'Manufacturing & Operations',
    description:
      'For businesses that make, assemble, process or transform materials into finished goods.',
    /*
     * Making something is the common thread, not the industry name. A pharmacy
     * that compounds and a farm that processes have the same needs — a recipe,
     * a batch, a quality check — while a wholesaler moving sealed cases has
     * none of them, however large it is.
     */
    defaultFor: ['MANUFACTURING', 'FOOD', 'PHARMACY', 'AGRICULTURE', 'CONSTRUCTION'],
  },
];

export const MODULE_IDS = BUSINESS_MODULES.map((m) => m.id);

export function moduleDefinition(id: string): BusinessModuleDefinition | undefined {
  return BUSINESS_MODULES.find((m) => m.id === id);
}

/** Whether a business type gets this module by default. */
export function isDefaultFor(moduleId: string, businessType: BusinessType): boolean {
  return moduleDefinition(moduleId)?.defaultFor.includes(businessType) ?? false;
}

/**
 * Whether this business may use this module, override included.
 *
 * Unknown module ids answer false rather than throwing: a client asking about
 * something this deployment has never heard of should be told "no", not handed
 * a 500.
 */
export async function hasModule(organizationId: string, moduleId: string): Promise<boolean> {
  if (!moduleDefinition(moduleId)) return false;
  const [org, override] = await Promise.all([
    prismaUnscoped.organization.findUnique({
      where: { id: organizationId },
      select: { businessType: true },
    }),
    prismaUnscoped.organizationModule.findUnique({
      where: { organizationId_moduleId: { organizationId, moduleId } },
      select: { enabled: true },
    }),
  ]);
  if (!org) return false;
  // An explicit decision always wins, in both directions — a business can be
  // given a module its type does not imply, and taken off one it does.
  if (override) return override.enabled;
  return isDefaultFor(moduleId, org.businessType);
}

/** Every module this business may use. Used to gate menus in one round trip. */
export async function modulesFor(organizationId: string): Promise<string[]> {
  const [org, overrides] = await Promise.all([
    prismaUnscoped.organization.findUnique({
      where: { id: organizationId },
      select: { businessType: true },
    }),
    prismaUnscoped.organizationModule.findMany({
      where: { organizationId },
      select: { moduleId: true, enabled: true },
    }),
  ]);
  if (!org) return [];
  const decided = new Map(overrides.map((o) => [o.moduleId, o.enabled]));
  return BUSINESS_MODULES.filter((m) =>
    decided.has(m.id) ? decided.get(m.id)! : m.defaultFor.includes(org.businessType),
  ).map((m) => m.id);
}

/**
 * What an administrator sees: every module, whether it is on, and why.
 *
 * "Why" is the point. Without it an administrator cannot tell a module that is
 * off because of the business type from one somebody switched off deliberately,
 * and those need opposite actions.
 */
export async function moduleStatusFor(organizationId: string) {
  const [org, overrides] = await Promise.all([
    prismaUnscoped.organization.findUnique({
      where: { id: organizationId },
      select: { businessType: true },
    }),
    prismaUnscoped.organizationModule.findMany({ where: { organizationId } }),
  ]);
  if (!org) return [];
  const byId = new Map(overrides.map((o) => [o.moduleId, o]));
  return BUSINESS_MODULES.map((m) => {
    const override = byId.get(m.id);
    const byType = m.defaultFor.includes(org.businessType);
    return {
      id: m.id,
      label: m.label,
      description: m.description,
      enabled: override ? override.enabled : byType,
      source: override ? ('override' as const) : ('business type' as const),
      defaultForBusinessType: byType,
      reason: override?.reason ?? null,
      changedAt: override?.updatedAt ?? null,
    };
  });
}

/**
 * Turn a module on or off for one business, or clear the decision.
 *
 * Passing `null` removes the override so the business goes back to whatever
 * its type implies — which is different from switching the module off, and the
 * difference matters when the business later changes type.
 */
export async function setModuleOverride(
  organizationId: string,
  moduleId: string,
  enabled: boolean | null,
  actor: { userId?: string | null; reason?: string | null } = {},
): Promise<{ moduleId: string; enabled: boolean; source: 'override' | 'business type' }> {
  if (!moduleDefinition(moduleId)) {
    throw new Error(`Unknown module "${moduleId}"`);
  }
  if (enabled === null) {
    await prismaUnscoped.organizationModule
      .delete({ where: { organizationId_moduleId: { organizationId, moduleId } } })
      .catch(() => undefined);
  } else {
    await prismaUnscoped.organizationModule.upsert({
      where: { organizationId_moduleId: { organizationId, moduleId } },
      create: {
        organizationId,
        moduleId,
        enabled,
        reason: actor.reason ?? null,
        setByUserId: actor.userId ?? null,
      },
      update: { enabled, reason: actor.reason ?? null, setByUserId: actor.userId ?? null },
    });
  }
  const now = await hasModule(organizationId, moduleId);
  return { moduleId, enabled: now, source: enabled === null ? 'business type' : 'override' };
}
