import { Prisma } from '@prisma/client';
import { prisma } from '../../infrastructure/database/prisma';

/**
 * The Lead fields an automation condition may test.
 *
 * Conditions used to take a free-text field name, so a typo produced a rule
 * that silently never matched and there was no way to discover what could be
 * tested. This is the single catalog the dropdown renders from and the server
 * validates against — a rule can only reference something that exists.
 *
 * Custom fields have no definition table in this product; they are a free-form
 * JSON blob on the lead. So rather than hardcoding a list that would go stale,
 * the keys actually in use are discovered from the data — a custom field
 * becomes available for automation as soon as any lead carries it.
 */

export type FieldType = 'text' | 'number' | 'date' | 'boolean' | 'select';

export interface FieldDef {
  /** Matches the key in the automation payload. */
  id: string;
  label: string;
  type: FieldType;
  /** For `select`, the allowed values — so the value input is a dropdown too. */
  options?: string[];
  /** True when discovered from data rather than declared on the model. */
  custom?: boolean;
}

/** Operators that make sense for each field type. */
export const OPERATORS: Record<FieldType, { id: string; label: string }[]> = {
  text: [
    { id: 'eq', label: 'Equals' },
    { id: 'ne', label: 'Does not equal' },
    { id: 'contains', label: 'Contains' },
    { id: 'not_contains', label: 'Does not contain' },
    { id: 'starts_with', label: 'Starts with' },
  ],
  number: [
    { id: 'eq', label: 'Equals' },
    { id: 'gt', label: 'Greater than' },
    { id: 'lt', label: 'Less than' },
    { id: 'gte', label: 'Greater than or equal' },
    { id: 'lte', label: 'Less than or equal' },
  ],
  date: [
    { id: 'eq', label: 'Is' },
    { id: 'lt', label: 'Before' },
    { id: 'gt', label: 'After' },
    { id: 'lte', label: 'Before or equal' },
    { id: 'gte', label: 'After or equal' },
  ],
  boolean: [
    { id: 'is_true', label: 'Is true' },
    { id: 'is_false', label: 'Is false' },
  ],
  select: [
    { id: 'eq', label: 'Equals' },
    { id: 'ne', label: 'Does not equal' },
  ],
};

/** Every operator id the condition schema accepts. */
export const ALL_OPERATORS = [
  ...new Set(Object.values(OPERATORS).flatMap((ops) => ops.map((o) => o.id))),
];

export const LEAD_STATUSES = [
  'NEW', 'CONTACTED', 'ENGAGED', 'QUALIFIED', 'NURTURING', 'UNQUALIFIED', 'CONVERTED', 'LOST',
];

/**
 * Standard fields, keyed to what the automation payload actually carries.
 *
 * Deliberately hand-listed rather than reflected off Prisma: the payload is a
 * flattened view built at dispatch time (`name`, `owner`), not the row, and a
 * catalog generated from columns would offer fields no rule could ever read.
 */
const STANDARD_FIELDS: FieldDef[] = [
  { id: 'status', label: 'Lead Status', type: 'select', options: LEAD_STATUSES },
  { id: 'source', label: 'Lead Source', type: 'text' },
  { id: 'owner', label: 'Lead Owner', type: 'text' },
  { id: 'aiScore', label: 'Lead Score', type: 'number' },
  { id: 'name', label: 'Name', type: 'text' },
  { id: 'email', label: 'Email', type: 'text' },
  { id: 'phone', label: 'Phone', type: 'text' },
  { id: 'company', label: 'Company', type: 'text' },
  { id: 'estimatedValue', label: 'Estimated Value', type: 'number' },
  { id: 'createdAt', label: 'Created Date', type: 'date' },
  { id: 'lastActivityAt', label: 'Last Activity', type: 'date' },
  { id: 'reengagementCount', label: 'Re-engagement Count', type: 'number' },
];

/** JSON is untyped, so infer from the value the business actually stored. */
function inferType(value: unknown): FieldType {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return 'date';
  return 'text';
}

/** Turn `annualRevenue` into "Annual Revenue" for the dropdown. */
function humanize(key: string): string {
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

/**
 * Custom field keys this business actually uses.
 *
 * Sampled rather than exhaustive: the point is to populate a dropdown, and
 * scanning every lead of a large workspace to build a form would be a poor
 * trade. Recent leads are what carry current fields.
 */
async function discoverCustomFields(): Promise<FieldDef[]> {
  const rows = await prisma.lead.findMany({
    where: { deletedAt: null, customFields: { not: Prisma.DbNull } },
    select: { customFields: true },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });

  const byKey = new Map<string, FieldDef>();
  for (const row of rows) {
    const fields = (row.customFields ?? {}) as Record<string, unknown>;
    for (const [key, value] of Object.entries(fields)) {
      if (byKey.has(key) || value === null || value === undefined) continue;
      byKey.set(key, {
        id: `customFields.${key}`,
        label: humanize(key),
        type: inferType(value),
        custom: true,
      });
    }
  }
  return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** Standard fields plus whatever custom fields this business uses. */
export async function leadFieldCatalog(): Promise<{ fields: FieldDef[]; operators: typeof OPERATORS }> {
  const custom = await discoverCustomFields().catch(() => []);
  return { fields: [...STANDARD_FIELDS, ...custom], operators: OPERATORS };
}

/**
 * Whether a rule may test this field with this operator.
 *
 * Enforced on save so an invalid rule cannot be written through the API — the
 * dropdown is presentation, and the endpoint is reachable without it. Custom
 * fields are accepted by prefix because a business may legitimately automate on
 * a key no lead carries yet.
 */
export async function validateLeadCondition(
  field: string,
  op: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const isCustom = field.startsWith('customFields.');
  if (isCustom) {
    const key = field.slice('customFields.'.length);
    if (!key || !/^[\w-]{1,60}$/.test(key)) {
      return { ok: false, reason: `"${field}" is not a valid custom field name` };
    }
    // A custom field's type is only known once data exists, so any operator is
    // allowed — evaluation coerces and simply fails to match when it cannot.
    return ALL_OPERATORS.includes(op)
      ? { ok: true }
      : { ok: false, reason: `"${op}" is not a supported operator` };
  }

  const def = STANDARD_FIELDS.find((f) => f.id === field);
  if (!def) return { ok: false, reason: `"${field}" is not a Lead field that can be automated on` };

  const allowed = OPERATORS[def.type].map((o) => o.id);
  return allowed.includes(op)
    ? { ok: true }
    : { ok: false, reason: `"${op}" cannot be used with ${def.label} (a ${def.type} field)` };
}
