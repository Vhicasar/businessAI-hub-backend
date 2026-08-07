import { prisma } from '../../infrastructure/database/prisma';
import { logger } from '../../shared/logger';
import { customersService } from '../customers/customers.service';
import { crmService } from '../crm/crm.service';
import { canSeeSalary, employeesService } from '../employees/employees.service';
import { catalogService } from '../catalog/catalog.service';
import { kbService } from '../support/kb.service';
import { suppliersService } from '../purchasing/suppliers.service';
import { purchaseOrdersService } from '../purchasing/purchase-orders.service';
import { reorderService } from '../purchasing/reorder.service';
import { parseCsv, splitName, toCsv } from './csv';
import { analyzeColumns, toColumns, type ColumnAnalysis } from './mapping';
import { EITHER_OR, ENTITIES, FIELD_DEFS, type Entity } from './fields';

export { ENTITIES, FIELD_DEFS, type Entity };

/**
 * CSV import/export for migrating in from other platforms (Zendesk, HubSpot,
 * Google Workspace, Shopify…).
 *
 * Two-step import: `analyzeCsv` previews the file and proposes a column→field
 * mapping (from headers AND content sniffing); `importEntity` then runs with a
 * mapping the user has confirmed. Rows go through the domain services, so
 * dedupe, lead assignment and timeline entries all still apply, and each row
 * fails independently — one bad row never aborts the batch.
 */

export interface AnalyzeResult {
  entity: Entity;
  totalRows: number;
  headers: string[];
  columns: ColumnAnalysis[];
  /** First few rows as raw cells, for the preview table. */
  sampleRows: string[][];
  fields: {
    key: string; label: string; required: boolean; hint?: string; enumValues?: string[];
  }[];
  /** Required fields that no column maps to — import is blocked until resolved. */
  missingRequired: string[];
  warnings: string[];
}

export interface ImportResult {
  total: number;
  created: number;
  skipped: number;
  failed: number;
  errors: { row: number; message: string }[];
}

/** column index → target field key (null = ignore this column). */
export type Mapping = Record<number, string | null>;

const SAMPLE_ROWS = 5;
const DETECT_ROWS = 50; // enough to classify a column without reading the file twice
const MAX_ROWS = 5000;

const msg = (e: unknown) => (e instanceof Error ? e.message : 'Unknown error');
const num = (v: string | undefined): number | null => {
  if (v === undefined || v.trim() === '') return null;
  const n = Number(v.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const bool = (v: string | undefined, dflt = false): boolean => {
  if (v === undefined || v.trim() === '') return dflt;
  return /^(true|yes|y|1)$/i.test(v.trim());
};
/** A date column, or null when it is blank or unparseable. */
const date = (v: string | undefined): Date | null => {
  if (v === undefined || v.trim() === '') return null;
  const d = new Date(v.trim());
  return Number.isNaN(d.getTime()) ? null : d;
};

// -------------------------------------------------------------------- analyze

export function analyzeCsv(entity: Entity, csv: string): AnalyzeResult {
  const rows = parseCsv(csv);
  const fields = FIELD_DEFS[entity];
  if (rows.length === 0) {
    return { entity, totalRows: 0, headers: [], columns: [], sampleRows: [], fields: [], missingRequired: [], warnings: ['The file is empty.'] };
  }

  const headers = rows[0]!;
  const body = rows.slice(1);
  const columns = analyzeColumns(headers, toColumns(body.slice(0, DETECT_ROWS), headers.length), fields);

  const mapped = new Set(columns.map((c) => c.suggestedField).filter(Boolean) as string[]);
  const missingRequired = requiredGaps(entity, mapped);

  const warnings: string[] = [];
  if (body.length === 0) warnings.push('The file has headers but no data rows.');
  if (body.length > MAX_ROWS) warnings.push(`${body.length} rows found — only the first ${MAX_ROWS} can be imported at once. Split the file into batches.`);
  const ragged = body.filter((r) => r.length !== headers.length).length;
  if (ragged > 0) warnings.push(`${ragged} row(s) have a different number of columns than the header — those cells may shift.`);
  const unmapped = columns.filter((c) => !c.suggestedField).length;
  if (unmapped > 0) warnings.push(`${unmapped} column(s) aren't mapped and will be ignored unless you assign them.`);

  return {
    entity,
    totalRows: body.length,
    headers,
    columns,
    sampleRows: body.slice(0, SAMPLE_ROWS),
    fields: fields.map((f) => ({ key: f.key, label: f.label, required: Boolean(f.required), hint: f.hint, enumValues: f.enumValues })),
    missingRequired,
    warnings,
  };
}

/** Required fields with no column, honouring either/or groups (email OR phone). */
function requiredGaps(entity: Entity, mapped: Set<string>): string[] {
  const fields = FIELD_DEFS[entity];
  const groups = EITHER_OR[entity];
  const gaps: string[] = [];

  for (const f of fields) {
    if (!f.required || mapped.has(f.key)) continue;
    // Fields inside an either/or group are reported by the group check below —
    // listing both would tell the user the same thing twice.
    if (groups.some((g) => g.includes(f.key))) continue;
    gaps.push(f.label);
  }
  for (const g of groups) {
    if (g.some((k) => mapped.has(k))) continue;
    const labels = g.map((k) => fields.find((f) => f.key === k)?.label ?? k);
    const gap = `${labels.join(' or ')}`;
    if (!gaps.includes(gap)) gaps.push(gap);
  }
  return [...new Set(gaps)];
}

// --------------------------------------------------------------------- import

/** A row keyed by target field, after the mapping is applied. */
type MappedRow = Record<string, string>;

const val = (row: MappedRow, key: string): string | undefined => {
  const v = row[key];
  return v !== undefined && v.trim() !== '' ? v.trim() : undefined;
};

/** Resolve first/last from either explicit columns or a combined fullName. */
function names(row: MappedRow): { first?: string; last?: string } {
  const full = val(row, 'fullName');
  const split = full ? splitName(full) : null;
  return {
    first: val(row, 'firstName') ?? split?.firstName,
    last: val(row, 'lastName') ?? (split?.lastName || undefined),
  };
}

type RowImporter = (row: MappedRow) => Promise<'created' | 'skipped'>;

interface Ctx {
  currency: string;
  defaultCountry: string | null;
  departments: { id: string; code: string; name: string }[];
  /**
   * Every department code in the org, including soft-deleted ones. The unique
   * constraint is on (organizationId, code) regardless of deletedAt, so a
   * generated code has to dodge codes we can no longer see in `departments`.
   */
  deptCodes: Set<string>;
  /** `employeeNumber` is present when a member's user is linked to an employee record. */
  members: { id: string; email: string; name: string; employeeNumber: string | null }[];
  /**
   * Employees with no user account. A lead's owner is a *membership*, so these
   * can't be assigned — but matching them yields an error that says so.
   */
  unlinkedStaff: { employeeNumber: string; name: string }[];
  /** Lazily-created lookups so an import doesn't need them pre-seeded. */
  categories: Map<string, string>;
  brands: Map<string, string>;
  /** SKUs claimed earlier in this same batch, so generated ones don't collide. */
  skus: Set<string>;
  /** Suppliers by lower-cased name *and* code, so a file can use either. */
  suppliers: Map<string, { id: string; currency: string | null; leadTimeDays: number | null }>;
  /** Variants by SKU — how a purchasing file points at a product. */
  variantsBySku: Map<string, { id: string; productId: string; costPrice: string | null }>;
  warehouses: { id: string; name: string; code: string; isDefault: boolean }[];
  /**
   * Purchase orders opened earlier in the same file, keyed by supplier +
   * warehouse. One row per line item is how these files come, so lines have to
   * accumulate onto one order rather than raising one order each.
   */
  openOrders: Map<string, string>;
}

/** Common country names → ISO-3166 alpha-2, since the column requires a 2-letter code. */
const COUNTRIES: Record<string, string> = {
  nigeria: 'NG', ghana: 'GH', kenya: 'KE', southafrica: 'ZA', egypt: 'EG',
  unitedstates: 'US', usa: 'US', unitedstatesofamerica: 'US', america: 'US',
  unitedkingdom: 'GB', uk: 'GB', greatbritain: 'GB', england: 'GB',
  canada: 'CA', australia: 'AU', ireland: 'IE', india: 'IN', germany: 'DE',
  france: 'FR', spain: 'ES', italy: 'IT', netherlands: 'NL', uae: 'AE',
  unitedarabemirates: 'AE', china: 'CN', japan: 'JP', brazil: 'BR',
};

function toCountryCode(raw: string): string | null {
  const v = raw.trim();
  if (/^[a-z]{2}$/i.test(v)) return v.toUpperCase();
  return COUNTRIES[v.toLowerCase().replace(/[^a-z]/g, '')] ?? null;
}

/** Resolve an "assigned to" cell to a membership, by email, name or employee ID. */
function resolveOwner(ref: string, members: Ctx['members']): string | null {
  const v = ref.trim().toLowerCase();
  return (
    members.find((m) => m.email.toLowerCase() === v)?.id ??
    members.find((m) => m.employeeNumber?.toLowerCase() === v)?.id ??
    members.find((m) => m.name.toLowerCase() === v)?.id ??
    null
  );
}

/**
 * Derive a SKU from the product name when the file has no SKU column, keeping
 * it unique against both the database and the rest of this batch.
 */
export async function generateSku(name: string, taken: Set<string>): Promise<string> {
  const base =
    name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'ITEM';
  for (let n = 0; n < 1000; n++) {
    const candidate = n === 0 ? base : `${base}-${n + 1}`;
    if (taken.has(candidate)) continue;
    const clash = await prisma.productVariant.findFirst({ where: { sku: candidate, deletedAt: null }, select: { id: true } });
    if (!clash) {
      taken.add(candidate);
      return candidate;
    }
    taken.add(candidate); // don't re-probe a known-taken candidate
  }
  // Astronomically unlikely; a timestamp suffix guarantees termination.
  const fallback = `${base}-${Date.now().toString(36).toUpperCase()}`;
  taken.add(fallback);
  return fallback;
}

/**
 * Google Workspace exports departments as an org unit path ("/Engineering/Backend").
 * The leaf is the department; the ancestry has nowhere to live here.
 */
export function departmentName(raw: string): string {
  const leaf = raw.split('/').filter((s) => s.trim()).pop() ?? '';
  return leaf.trim().replace(/\s+/g, ' ').slice(0, 120);
}

/** Derive a code that fits the column (20 chars) and is free across the org. */
export function departmentCode(name: string, taken: Set<string>): string {
  const base = name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'DEPT';
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    // Trim the stem so stem + "-<n>" still fits inside the 20-char limit.
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, 20 - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `D-${Date.now().toString(36).toUpperCase()}`.slice(0, 20);
}

/**
 * Match a department cell against existing departments by name or code,
 * creating one on first sight so an import doesn't need them pre-seeded.
 */
async function resolveDepartment(raw: string, ctx: Ctx): Promise<string> {
  const name = departmentName(raw);
  if (!name) throw new Error(`Unreadable department "${raw}"`);
  const key = name.toLowerCase();
  const hit = ctx.departments.find((d) => d.name.toLowerCase() === key || d.code.toLowerCase() === key);
  if (hit) return hit.id;

  const code = departmentCode(name, ctx.deptCodes);
  const created = await employeesService.createDepartment({ name, code, isActive: true });
  // Cache both so later rows in this batch reuse it instead of creating a twin.
  ctx.departments.push({ id: created.id, code: created.code, name: created.name });
  ctx.deptCodes.add(created.code);
  return created.id;
}

/** Look up a category/brand by name, creating it on first sight. */
async function lookupOrCreate(
  cache: Map<string, string>,
  name: string,
  create: (n: string) => Promise<{ id: string }>,
): Promise<string> {
  const key = name.trim().toLowerCase();
  const hit = cache.get(key);
  if (hit) return hit;
  const created = await create(name.trim());
  cache.set(key, created.id);
  return created.id;
}

/** Merge the source system's ID into customFields so it survives the migration. */
function withExternalId(row: MappedRow, extra: Record<string, unknown> = {}) {
  const ext = val(row, 'externalId');
  const fields = { ...extra, ...(ext ? { externalId: ext } : {}) };
  return Object.keys(fields).length > 0 ? fields : undefined;
}

function importerFor(entity: Entity, ctx: Ctx): RowImporter {
  switch (entity) {
    case 'customers':
      return async (row) => {
        const { first, last } = names(row);
        const email = val(row, 'email');
        const phone = val(row, 'phone');
        if (!first) throw new Error('Missing name');
        if (!email && !phone) throw new Error('Needs an email or phone');

        // An address row needs line 1, a city and a country (all NOT NULL). A
        // file that only carries some of those is common and must not fail the
        // import — we keep the customer and park the fragments in customFields
        // rather than dropping them, so nothing is lost in the migration.
        const line1 = val(row, 'addressLine1');
        const city = val(row, 'city');
        const countryRaw = val(row, 'country');
        // A bad country code is a mistake worth reporting, not a fragment.
        if (countryRaw && !toCountryCode(countryRaw)) {
          throw new Error(`Unrecognised country "${countryRaw}" — use a 2-letter code (e.g. NG) or a country name`);
        }
        const country = countryRaw ? toCountryCode(countryRaw) : ctx.defaultCountry;

        let address: { addressLine1: string; addressLine2: string | null; city: string; state: string | null; country: string; postalCode: string | null; isDefault: boolean } | null = null;
        let partialAddress: Record<string, string> | undefined;
        if (line1 && city && country) {
          address = {
            addressLine1: line1, addressLine2: val(row, 'addressLine2') ?? null,
            city, state: val(row, 'state') ?? null, country, postalCode: val(row, 'postalCode') ?? null,
            isDefault: true,
          };
        } else {
          const fragments: Record<string, string> = {};
          for (const k of ['addressLine1', 'addressLine2', 'city', 'state', 'postalCode', 'country'] as const) {
            const v = val(row, k);
            if (v) fragments[k] = v;
          }
          if (Object.keys(fragments).length > 0) partialAddress = fragments;
        }

        // Blocked state can arrive as an explicit flag or as a status/active
        // column. An explicit `isBlocked` wins; otherwise derive from status.
        let blocked = false;
        const blockedRaw = val(row, 'isBlocked');
        const statusRaw = (val(row, 'status') ?? '').toUpperCase().replace(/[\s-]/g, '_');
        if (blockedRaw !== undefined) {
          blocked = bool(blockedRaw);
        } else if (statusRaw) {
          if (/^(ACTIVE|ENABLED|TRUE|YES|Y|1)$/.test(statusRaw)) blocked = false;
          else if (/^(BLOCKED|SUSPENDED|BANNED|INACTIVE|DISABLED|FALSE|NO|N|0)$/.test(statusRaw)) blocked = true;
          else throw new Error(`Unrecognised status "${val(row, 'status')}" — use ACTIVE or BLOCKED`);
        }

        const extras: Record<string, unknown> = {};
        const company = val(row, 'company');
        const notes = val(row, 'notes');
        const tags = val(row, 'tags');
        if (company) extras.company = company;
        if (notes) extras.notes = notes;
        if (tags) extras.tags = tags.split(/[,;]/).map((t) => t.trim()).filter(Boolean);
        // Too incomplete to be a real address, but kept so the data survives.
        if (partialAddress) extras.partialAddress = partialAddress;

        let customer: { id: string };
        try {
          customer = await customersService.create({
            firstName: first, lastName: last ?? null, email: email ?? null, phone: phone ?? null,
            language: val(row, 'language') ?? null,
            marketingOptIn: bool(val(row, 'marketingOptIn'), true),
            customFields: withExternalId(row, extras),
          } as never);
        } catch (e) {
          if (/already|exists|in use/i.test(msg(e))) return 'skipped';
          throw e;
        }

        if (address) await customersService.addAddress(customer.id, address as never);
        if (blocked) await customersService.update(customer.id, { isBlocked: true } as never);
        return 'created';
      };

    case 'leads':
      return async (row) => {
        const { first, last } = names(row);
        const email = val(row, 'email');
        const phone = val(row, 'phone');
        if (!first) throw new Error('Missing name');
        if (!email && !phone) throw new Error('Needs an email or phone');

        // Resolve the owner up front — an unknown name shouldn't half-import.
        const ownerRef = val(row, 'owner');
        let ownerId: string | null = null;
        if (ownerRef) {
          ownerId = resolveOwner(ownerRef, ctx.members);
          if (!ownerId) {
            // Distinguish "no such person" from "that person can't be an owner":
            // an employee record only becomes assignable once it has a login.
            const v = ownerRef.trim().toLowerCase();
            const staff = ctx.unlinkedStaff.find(
              (e) => e.employeeNumber.toLowerCase() === v || e.name.toLowerCase() === v,
            );
            throw new Error(
              staff
                ? `"${ownerRef}" is ${staff.name}, who has no user account yet — leads can only be assigned to people who can sign in. Invite them under Employees first, or leave this cell blank.`
                : `Unknown assignee "${ownerRef}" — no team member with that email, name or employee ID`,
            );
          }
        }

        const extras: Record<string, unknown> = {};
        for (const k of ['company', 'interest', 'notes'] as const) {
          const v = val(row, k);
          if (v) extras[k] = v;
        }

        // createLead dedupes and routes through the assignment rules.
        const lead = await crmService.createLead({
          firstName: first, lastName: last ?? null, email: email ?? null, phone: phone ?? null,
          source: val(row, 'source') ?? 'IMPORT',
          estimatedValue: num(val(row, 'estimatedValue')),
        } as never);

        // Apply the fields createLead doesn't take, preserving what the source had.
        const statusRaw = (val(row, 'status') ?? '').toUpperCase().replace(/[\s-]/g, '_');
        const status = LEAD_STATUSES.includes(statusRaw) ? statusRaw : null;
        const score = num(val(row, 'score'));
        const custom = withExternalId(row, extras);
        if (status || score !== null || ownerId || custom) {
          await prisma.lead.update({
            where: { id: lead.id },
            data: {
              ...(status ? { status: status as never } : {}),
              ...(score !== null ? { aiScore: Math.max(0, Math.min(100, Math.round(score))), aiScoreReason: 'Imported from source system' } : {}),
              ...(ownerId ? { ownerId } : {}),
              ...(custom ? { customFields: custom as never } : {}),
            },
          });
        }
        return 'created';
      };

    case 'employees':
      return async (row) => {
        const { first, last } = names(row);
        if (!first || !last) throw new Error('Needs both a first and last name');
        const deptRef = val(row, 'department');
        const departmentId = deptRef ? await resolveDepartment(deptRef, ctx) : null;

        const type = (val(row, 'employmentType') ?? 'FULL_TIME').toUpperCase().replace(/[\s-]/g, '_');
        const hired = val(row, 'hiredAt');
        if (hired && Number.isNaN(Date.parse(hired))) throw new Error(`Unreadable hire date "${hired}"`);

        // "Status" may be an enum or a yes/no "active" flag.
        const statusRaw = (val(row, 'status') ?? '').toUpperCase().replace(/[\s-]/g, '_');
        let status: string | undefined;
        if (statusRaw) {
          if (EMPLOYEE_STATUSES.includes(statusRaw)) status = statusRaw;
          else if (/^(TRUE|YES|Y|1|ACTIVE)$/.test(statusRaw)) status = 'ACTIVE';
          else if (/^(FALSE|NO|N|0|INACTIVE|TERMINATED)$/.test(statusRaw)) status = 'TERMINATED';
          else throw new Error(`Unrecognised status "${val(row, 'status')}"`);
        }

        try {
          await employeesService.create({
            employeeNumber: val(row, 'employeeNumber') ?? null,
            status: status as never,
            firstName: first, lastName: last,
            email: val(row, 'email') ?? null,
            phone: val(row, 'phone') ?? null,
            jobTitle: val(row, 'jobTitle') ?? null,
            departmentId,
            employmentType: (['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN'].includes(type) ? type : 'FULL_TIME') as never,
            // Only send salary when the file actually carries one: `num` maps a
            // missing cell to null, and passing null would read as "clear the
            // salary" — which the caller may not even be allowed to do.
            ...(val(row, 'salary') !== undefined ? { salary: num(val(row, 'salary')) } : {}),
            hiredAt: hired ? new Date(hired) : null,
          } as never);
          return 'created';
        } catch (e) {
          if (/employee number .* already in use/i.test(msg(e))) return 'skipped';
          throw e;
        }
      };

    case 'products':
      return async (row) => {
        const name = val(row, 'name');
        const price = num(val(row, 'price'));
        if (!name) throw new Error('Missing product name');
        if (price === null) throw new Error('Missing or invalid price');
        // A SKU column is optional — derive one from the name when absent.
        const sku = val(row, 'sku') ?? (await generateSku(name, ctx.skus));

        const statusRaw = (val(row, 'status') ?? '').toUpperCase();
        const status = PRODUCT_STATUSES.includes(statusRaw)
          ? statusRaw
          : /^(TRUE|YES|Y|1|PUBLISHED|LIVE)$/.test(statusRaw) ? 'ACTIVE'
          : /^(FALSE|NO|N|0|UNPUBLISHED|HIDDEN)$/.test(statusRaw) ? 'DRAFT'
          : 'ACTIVE';

        const categoryName = val(row, 'category');
        const brandName = val(row, 'brand');
        const categoryId = categoryName
          ? await lookupOrCreate(ctx.categories, categoryName, (n) => catalogService.createCategory(n))
          : null;
        const brandId = brandName
          ? await lookupOrCreate(ctx.brands, brandName, (n) => catalogService.createBrand(n))
          : null;

        try {
          await catalogService.createProduct(
            {
              name,
              description: val(row, 'description') ?? null,
              categoryId, brandId,
              status: status as never,
              taxRate: num(val(row, 'taxRate')) ?? 0,
              customFields: withExternalId(row),
              variants: [{
                sku, price,
                name: val(row, 'variantName') ?? null,
                barcode: val(row, 'barcode') ?? null,
                compareAtPrice: num(val(row, 'compareAtPrice')),
                costPrice: num(val(row, 'costPrice')),
                initialStock: num(val(row, 'stock')) ?? 0,
                isDefault: true,
              }],
            } as never,
            ctx.currency,
          );
          return 'created';
        } catch (e) {
          if (/sku .* already in use/i.test(msg(e))) return 'skipped';
          throw e;
        }
      };

    case 'suppliers':
      return async (row) => {
        const name = val(row, 'name');
        if (!name) throw new Error('Missing supplier name');
        const countryRaw = val(row, 'country');
        const country = countryRaw ? toCountryCode(countryRaw) : null;
        if (countryRaw && !country) throw new Error(`Unrecognised country "${countryRaw}"`);

        try {
          const created = await suppliersService.create({
            name,
            code: val(row, 'code') ?? null,
            contactName: val(row, 'contactName') ?? null,
            email: val(row, 'email') ?? null,
            phone: val(row, 'phone') ?? null,
            website: val(row, 'website') ?? null,
            addressLine1: val(row, 'addressLine1') ?? null,
            addressLine2: val(row, 'addressLine2') ?? null,
            city: val(row, 'city') ?? null,
            state: val(row, 'state') ?? null,
            postalCode: val(row, 'postalCode') ?? null,
            country: country ?? ctx.defaultCountry,
            paymentTerms: val(row, 'paymentTerms') ?? null,
            currency: (val(row, 'currency') ?? '').toUpperCase() || null,
            taxId: val(row, 'taxId') ?? null,
            leadTimeDays: num(val(row, 'leadTimeDays')),
            rating: num(val(row, 'rating')),
            tags: (val(row, 'tags') ?? '').split(',').map((x) => x.trim()).filter(Boolean),
            notes: val(row, 'notes') ?? null,
          } as never);
          ctx.suppliers.set(name.toLowerCase(), {
            id: created.id, currency: created.currency, leadTimeDays: created.leadTimeDays,
          });
          return 'created';
        } catch (e) {
          // A name that already exists is a re-run of the same file, not a
          // failure worth stopping on.
          if (/already exists/i.test(msg(e))) return 'skipped';
          throw e;
        }
      };

    case 'supplier-products':
      return async (row) => {
        const supplierName = val(row, 'supplier');
        const sku = val(row, 'sku');
        if (!supplierName) throw new Error('Missing supplier');
        if (!sku) throw new Error('Missing product SKU');
        const supplier = ctx.suppliers.get(supplierName.toLowerCase());
        if (!supplier) throw new Error(`No supplier called "${supplierName}"`);
        const variant = ctx.variantsBySku.get(sku.toLowerCase());
        if (!variant) throw new Error(`No product with SKU "${sku}"`);

        await suppliersService.linkProduct(supplier.id, {
          productId: variant.productId,
          supplierSku: val(row, 'supplierSku') ?? null,
          // Fall back to what the product already costs, so a file that only
          // names the pairing still records a usable price.
          costPrice: num(val(row, 'costPrice')) ?? (variant.costPrice ? Number(variant.costPrice) : null),
          currency: (val(row, 'currency') ?? '').toUpperCase() || null,
          leadTimeDays: num(val(row, 'leadTimeDays')),
          minOrderQty: num(val(row, 'minOrderQty')),
          isPreferred: bool(val(row, 'isPreferred')),
        } as never);
        return 'created';
      };

    case 'purchase-orders':
      return async (row) => {
        const supplierName = val(row, 'supplier');
        const sku = val(row, 'sku');
        const quantity = num(val(row, 'quantity'));
        if (!supplierName) throw new Error('Missing supplier');
        if (!sku) throw new Error('Missing product SKU');
        if (quantity === null || quantity <= 0) throw new Error('Missing or invalid quantity');

        const supplier = ctx.suppliers.get(supplierName.toLowerCase());
        if (!supplier) throw new Error(`No supplier called "${supplierName}"`);
        const variant = ctx.variantsBySku.get(sku.toLowerCase());
        if (!variant) throw new Error(`No product with SKU "${sku}"`);

        const warehouseName = val(row, 'warehouse');
        const warehouse = warehouseName
          ? ctx.warehouses.find(
              (w) => w.name.toLowerCase() === warehouseName.toLowerCase() ||
                     w.code.toLowerCase() === warehouseName.toLowerCase()
            )
          : ctx.warehouses.find((w) => w.isDefault) ?? ctx.warehouses[0];
        if (!warehouse) throw new Error(warehouseName ? `No warehouse called "${warehouseName}"` : 'No warehouse to deliver to');

        const unitCost = num(val(row, 'unitCost')) ?? (variant.costPrice ? Number(variant.costPrice) : 0);
        const line = {
          variantId: variant.id,
          quantity,
          unitCost,
          taxRate: num(val(row, 'taxRate')) ?? 0,
        };

        // One row per line: append to the order already open for this
        // supplier/warehouse in this file rather than raising a new one.
        const key = `${supplier.id}:${warehouse.id}`;
        const existingId = ctx.openOrders.get(key);
        if (existingId) {
          const existing = await purchaseOrdersService.get(existingId);
          await purchaseOrdersService.update(existingId, {
            items: [
              ...existing.items.map((i) => ({
                variantId: i.variantId,
                quantity: Number(i.quantity),
                unitCost: Number(i.unitCost),
                taxRate: Number(i.taxRate),
              })),
              line,
            ],
          } as never);
          return 'created';
        }

        const created = await purchaseOrdersService.create({
          supplierId: supplier.id,
          warehouseId: warehouse.id,
          expectedAt: date(val(row, 'expectedAt')),
          notes: val(row, 'notes') ?? null,
          items: [line],
        } as never);
        ctx.openOrders.set(key, created.id);
        return 'created';
      };

    case 'reorder-levels':
      return async (row) => {
        const sku = val(row, 'sku');
        const point = num(val(row, 'reorderPoint'));
        if (!sku) throw new Error('Missing product SKU');
        if (point === null) throw new Error('Missing reorder point');
        const variant = ctx.variantsBySku.get(sku.toLowerCase());
        if (!variant) throw new Error(`No product with SKU "${sku}"`);

        const warehouseName = val(row, 'warehouse');
        const warehouse = warehouseName
          ? ctx.warehouses.find(
              (w) => w.name.toLowerCase() === warehouseName.toLowerCase() ||
                     w.code.toLowerCase() === warehouseName.toLowerCase()
            )
          : ctx.warehouses.find((w) => w.isDefault) ?? ctx.warehouses[0];
        if (!warehouse) throw new Error(warehouseName ? `No warehouse called "${warehouseName}"` : 'No warehouse');

        // The stock row may not exist yet for a product never counted here.
        const level = await prisma.stockLevel.upsert({
          where: { warehouseId_variantId: { warehouseId: warehouse.id, variantId: variant.id } },
          update: {},
          create: {
            organizationId: (await prisma.warehouse.findFirstOrThrow({ where: { id: warehouse.id }, select: { organizationId: true } })).organizationId,
            warehouseId: warehouse.id,
            variantId: variant.id,
            quantity: 0,
          },
        });
        await reorderService.setReorderLevel(level.id, {
          reorderPoint: point,
          reorderQty: num(val(row, 'reorderQty')),
        });
        return 'created';
      };

    case 'kb-articles':
      return async (row) => {
        const title = val(row, 'title');
        const body = val(row, 'body');
        if (!title) throw new Error('Missing title');
        if (!body) throw new Error('Missing body');
        const raw = (val(row, 'status') ?? '').toUpperCase();
        const status = ['DRAFT', 'PUBLISHED', 'ARCHIVED'].includes(raw)
          ? raw
          : /^(TRUE|YES|PUBLISHED|LIVE)$/i.test(raw) ? 'PUBLISHED' : 'DRAFT';
        await kbService.createArticle({
          title, body,
          isPublic: bool(val(row, 'isPublic'), true),
          status: status as never,
        } as never);
        return 'created';
      };
  }
}

const LEAD_STATUSES = ['NEW', 'CONTACTED', 'QUALIFIED', 'UNQUALIFIED', 'CONVERTED', 'LOST'];
const EMPLOYEE_STATUSES = ['ACTIVE', 'ON_LEAVE', 'TERMINATED'];
const PRODUCT_STATUSES = ['ACTIVE', 'DRAFT', 'ARCHIVED'];

/**
 * Import with an explicit column→field mapping. When omitted, the suggested
 * mapping from `analyzeCsv` is used, so a straight import still works.
 */
export async function importEntity(entity: Entity, csv: string, mapping?: Mapping): Promise<ImportResult> {
  const rows = parseCsv(csv);
  const result: ImportResult = { total: 0, created: 0, skipped: 0, failed: 0, errors: [] };
  if (rows.length <= 1) return result;

  const headers = rows[0]!;
  const body = rows.slice(1);
  result.total = body.length;
  if (body.length > MAX_ROWS) {
    throw new Error(`Too many rows (${body.length}). Split the file into batches of ${MAX_ROWS} or fewer.`);
  }

  // Fall back to the auto-suggested mapping when the caller didn't confirm one.
  const effective: Mapping =
    mapping ??
    Object.fromEntries(
      analyzeColumns(headers, toColumns(body.slice(0, DETECT_ROWS), headers.length), FIELD_DEFS[entity])
        .map((c) => [c.index, c.suggestedField]),
    );

  const mappedFields = new Set(Object.values(effective).filter(Boolean) as string[]);
  const gaps = requiredGaps(entity, mappedFields);
  if (gaps.length > 0) {
    throw new Error(`Unmapped required field(s): ${gaps.join(', ')}. Assign a column to each before importing.`);
  }

  // Load the lookups each entity needs once, not per row.
  const [org, allDepartments, members, staff, categories, brands] = await Promise.all([
    prisma.organization.findFirstOrThrow({ select: { currency: true, country: true } }),
    // Soft-deleted rows are fetched too: they still hold their code against the
    // (organizationId, code) unique constraint, so generated codes must avoid them.
    entity === 'employees'
      ? prisma.department.findMany({ select: { id: true, code: true, name: true, deletedAt: true } })
      : Promise.resolve([]),
    entity === 'leads'
      ? prisma.membership.findMany({
          where: { deletedAt: null, isActive: true },
          select: { id: true, userId: true, user: { select: { email: true, firstName: true, lastName: true } } },
        })
      : Promise.resolve([]),
    // Employee records carry the employee ID; they reach a membership via userId.
    // Employees *without* a user account are loaded too — they can't own a lead,
    // but recognising them lets us say why instead of "no such team member".
    entity === 'leads'
      ? prisma.employee.findMany({
          where: { deletedAt: null },
          select: { employeeNumber: true, userId: true, firstName: true, lastName: true },
        })
      : Promise.resolve([]),
    entity === 'products' ? catalogService.listCategories() : Promise.resolve([]),
    entity === 'products' ? catalogService.listBrands() : Promise.resolve([]),
  ]);

  // Purchasing files reference suppliers by name and products by SKU, so both
  // lookups are loaded up front rather than queried per row.
  const purchasingEntity = entity === 'suppliers' || entity === 'supplier-products'
    || entity === 'purchase-orders' || entity === 'reorder-levels';
  const [supplierRows, variantRows, warehouseRows] = await Promise.all([
    purchasingEntity
      ? prisma.supplier.findMany({
          where: { deletedAt: null },
          select: { id: true, name: true, code: true, currency: true, leadTimeDays: true },
        })
      : Promise.resolve([]),
    purchasingEntity
      ? prisma.productVariant.findMany({
          where: { deletedAt: null },
          select: { id: true, sku: true, productId: true, costPrice: true },
        })
      : Promise.resolve([]),
    purchasingEntity
      ? prisma.warehouse.findMany({
          where: { deletedAt: null, isActive: true },
          select: { id: true, name: true, code: true, isDefault: true },
        })
      : Promise.resolve([]),
  ]);

  const suppliersByKey = new Map<string, { id: string; currency: string | null; leadTimeDays: number | null }>();
  for (const s of supplierRows) {
    const entry = { id: s.id, currency: s.currency, leadTimeDays: s.leadTimeDays };
    suppliersByKey.set(s.name.toLowerCase(), entry);
    // Files often carry the code rather than the full name.
    if (s.code) suppliersByKey.set(s.code.toLowerCase(), entry);
  }

  const importRow = importerFor(entity, {
    currency: org.currency,
    defaultCountry: org.country ?? null,
    suppliers: suppliersByKey,
    variantsBySku: new Map(
      variantRows.map((v) => [
        v.sku.toLowerCase(),
        { id: v.id, productId: v.productId, costPrice: v.costPrice?.toString() ?? null },
      ])
    ),
    warehouses: warehouseRows,
    openOrders: new Map<string, string>(),
    departments: allDepartments.filter((d) => !d.deletedAt).map((d) => ({ id: d.id, code: d.code, name: d.name })),
    deptCodes: new Set(allDepartments.map((d) => d.code)),
    members: members.map((m) => ({
      id: m.id,
      email: m.user.email,
      name: `${m.user.firstName} ${m.user.lastName ?? ''}`.trim(),
      // Guard against null === null matching an unlinked employee to a member.
      employeeNumber: staff.find((e) => e.userId && e.userId === m.userId)?.employeeNumber ?? null,
    })),
    unlinkedStaff: staff
      .filter((e) => !e.userId)
      .map((e) => ({
        employeeNumber: e.employeeNumber,
        name: `${e.firstName} ${e.lastName ?? ''}`.trim(),
      })),
    categories: new Map(categories.map((c) => [c.name.toLowerCase(), c.id])),
    brands: new Map(brands.map((b) => [b.name.toLowerCase(), b.id])),
    skus: new Set<string>(),
  });

  for (let i = 0; i < body.length; i++) {
    const cells = body[i]!;
    const row: MappedRow = {};
    for (const [idxStr, field] of Object.entries(effective)) {
      if (!field) continue;
      row[field] = cells[Number(idxStr)] ?? '';
    }
    try {
      const outcome = await importRow(row);
      if (outcome === 'created') result.created += 1;
      else result.skipped += 1;
    } catch (e) {
      result.failed += 1;
      // +2 = 1-based, plus the header row — matches what the user sees in Excel.
      if (result.errors.length < 100) result.errors.push({ row: i + 2, message: msg(e) });
      logger.debug({ err: e, entity, row: i + 2 }, 'import row failed');
    }
  }
  return result;
}

// --------------------------------------------------------------------- export

export async function exportEntity(entity: Entity): Promise<{ filename: string; csv: string }> {
  const stamp = new Date().toISOString().slice(0, 10);
  switch (entity) {
    // Exports mirror the import fields, so an export can be edited and re-imported.
    case 'customers': {
      const rows = await prisma.customer.findMany({
        where: { deletedAt: null, isProvisional: false },
        select: {
          id: true, firstName: true, lastName: true, email: true, phone: true, language: true,
          marketingOptIn: true, isBlocked: true, customFields: true,
          lifetimeValue: true, totalOrders: true, createdAt: true,
          addresses: {
            orderBy: { isDefault: 'desc' },
            take: 1,
            select: { addressLine1: true, addressLine2: true, city: true, state: true, country: true, postalCode: true },
          },
        },
        orderBy: { createdAt: 'desc' },
      });
      const flat = rows.map((c) => {
        const cf = (c.customFields ?? {}) as Record<string, unknown>;
        const a = c.addresses[0];
        return {
          customerId: c.id,
          externalId: cf.externalId ?? '',
          firstName: c.firstName, lastName: c.lastName ?? '', email: c.email ?? '', phone: c.phone ?? '',
          company: cf.company ?? '',
          addressLine1: a?.addressLine1 ?? '', addressLine2: a?.addressLine2 ?? '',
          city: a?.city ?? '', state: a?.state ?? '', postalCode: a?.postalCode ?? '', country: a?.country ?? '',
          language: c.language ?? '', marketingOptIn: c.marketingOptIn, isBlocked: c.isBlocked,
          tags: Array.isArray(cf.tags) ? (cf.tags as string[]).join(', ') : '',
          notes: cf.notes ?? '',
          lifetimeValue: c.lifetimeValue, totalOrders: c.totalOrders, createdAt: c.createdAt,
        };
      });
      const headers = ['customerId', 'externalId', 'firstName', 'lastName', 'email', 'phone', 'company',
        'addressLine1', 'addressLine2', 'city', 'state', 'postalCode', 'country',
        'language', 'marketingOptIn', 'isBlocked', 'tags', 'notes', 'lifetimeValue', 'totalOrders', 'createdAt'];
      return { filename: `customers-${stamp}.csv`, csv: toCsv(headers, flat) };
    }
    case 'leads': {
      const rows = await prisma.lead.findMany({
        where: { deletedAt: null },
        select: {
          id: true, firstName: true, lastName: true, email: true, phone: true, source: true,
          status: true, estimatedValue: true, aiScore: true, ownerId: true, customFields: true, createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
      });
      const owners = await prisma.membership.findMany({
        where: { id: { in: rows.map((r) => r.ownerId).filter((x): x is string => Boolean(x)) } },
        select: { id: true, user: { select: { email: true } } },
      });
      const flat = rows.map((l) => {
        const cf = (l.customFields ?? {}) as Record<string, unknown>;
        return {
          leadId: l.id,
          externalId: cf.externalId ?? '',
          firstName: l.firstName, lastName: l.lastName ?? '', email: l.email ?? '', phone: l.phone ?? '',
          company: cf.company ?? '',
          source: l.source ?? '', status: l.status,
          estimatedValue: l.estimatedValue ?? '', score: l.aiScore ?? '',
          owner: owners.find((o) => o.id === l.ownerId)?.user.email ?? '',
          interest: cf.interest ?? '', notes: cf.notes ?? '',
          createdAt: l.createdAt,
        };
      });
      const headers = ['leadId', 'externalId', 'firstName', 'lastName', 'email', 'phone', 'company',
        'source', 'status', 'estimatedValue', 'score', 'owner', 'interest', 'notes', 'createdAt'];
      return { filename: `leads-${stamp}.csv`, csv: toCsv(headers, flat) };
    }
    case 'employees': {
      const rows = await prisma.employee.findMany({
        where: { deletedAt: null },
        select: {
          employeeNumber: true, firstName: true, lastName: true, email: true, phone: true,
          jobTitle: true, departmentId: true, employmentType: true, status: true,
          salary: true, currency: true, hiredAt: true, terminatedAt: true,
        },
        orderBy: { createdAt: 'desc' },
      });
      const depts = await prisma.department.findMany({ select: { id: true, name: true } });
      // An export must not become the back door around employees.view_salary.
      const paid = await canSeeSalary();
      const flat = rows.map((e) => ({
        employeeNumber: e.employeeNumber,
        firstName: e.firstName, lastName: e.lastName, email: e.email ?? '', phone: e.phone ?? '',
        jobTitle: e.jobTitle ?? '',
        department: depts.find((d) => d.id === e.departmentId)?.name ?? '',
        employmentType: e.employmentType, status: e.status,
        ...(paid ? { salary: e.salary ?? '', currency: e.currency } : {}),
        hiredAt: e.hiredAt ?? '', terminatedAt: e.terminatedAt ?? '',
      }));
      const headers = ['employeeNumber', 'firstName', 'lastName', 'email', 'phone', 'jobTitle', 'department',
        'employmentType', 'status', ...(paid ? ['salary', 'currency'] : []), 'hiredAt', 'terminatedAt'];
      return { filename: `employees-${stamp}.csv`, csv: toCsv(headers, flat) };
    }
    case 'products': {
      const rows = await prisma.product.findMany({
        where: { deletedAt: null },
        select: {
          id: true, name: true, description: true, status: true, taxRate: true, customFields: true,
          category: { select: { name: true } },
          brand: { select: { name: true } },
          variants: {
            where: { deletedAt: null },
            take: 1,
            orderBy: { isDefault: 'desc' },
            select: {
              sku: true, name: true, barcode: true, price: true, compareAtPrice: true, costPrice: true,
              stockLevels: { select: { quantity: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      });
      const flat = rows.map((p) => {
        const v = p.variants[0];
        const cf = (p.customFields ?? {}) as Record<string, unknown>;
        return {
          productId: p.id,
          externalId: cf.externalId ?? '',
          name: p.name,
          sku: v?.sku ?? '',
          variantName: v?.name ?? '',
          price: v?.price ?? '',
          compareAtPrice: v?.compareAtPrice ?? '',
          costPrice: v?.costPrice ?? '',
          stock: v ? v.stockLevels.reduce((s, l) => s + Number(l.quantity), 0) : '',
          barcode: v?.barcode ?? '',
          category: p.category?.name ?? '',
          brand: p.brand?.name ?? '',
          description: p.description ?? '',
          taxRate: p.taxRate,
          status: p.status,
        };
      });
      const headers = ['productId', 'externalId', 'name', 'sku', 'variantName', 'price', 'compareAtPrice',
        'costPrice', 'stock', 'barcode', 'category', 'brand', 'description', 'taxRate', 'status'];
      return { filename: `products-${stamp}.csv`, csv: toCsv(headers, flat) };
    }
    case 'kb-articles': {
      const rows = await prisma.kbArticle.findMany({
        where: { deletedAt: null },
        select: { title: true, body: true, status: true, isPublic: true, viewCount: true },
        orderBy: { updatedAt: 'desc' },
      });
      return { filename: `kb-articles-${stamp}.csv`, csv: toCsv(['title', 'body', 'status', 'isPublic', 'viewCount'], rows as never) };
    }

    case 'suppliers': {
      const rows = await prisma.supplier.findMany({
        where: { deletedAt: null },
        orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      });
      const flat = rows.map((s) => ({
        name: s.name, code: s.code, contactName: s.contactName, email: s.email, phone: s.phone,
        website: s.website, addressLine1: s.addressLine1, addressLine2: s.addressLine2,
        city: s.city, state: s.state, postalCode: s.postalCode, country: s.country,
        paymentTerms: s.paymentTerms, currency: s.currency, taxId: s.taxId,
        leadTimeDays: s.leadTimeDays, rating: s.rating,
        // Re-importable: the importer splits this back on commas.
        tags: s.tags.join(', '),
        notes: s.notes, isActive: s.isActive,
      }));
      const headers = ['name', 'code', 'contactName', 'email', 'phone', 'website', 'addressLine1',
        'addressLine2', 'city', 'state', 'postalCode', 'country', 'paymentTerms', 'currency',
        'taxId', 'leadTimeDays', 'rating', 'tags', 'notes', 'isActive'];
      return { filename: `suppliers-${stamp}.csv`, csv: toCsv(headers, flat as never) };
    }

    case 'supplier-products': {
      const rows = await prisma.supplierProduct.findMany({
        include: {
          supplier: { select: { name: true, deletedAt: true } },
          product: { select: { name: true, variants: { where: { deletedAt: null }, select: { sku: true }, take: 1 } } },
        },
        orderBy: [{ isPreferred: 'desc' }],
      });
      const flat = rows
        .filter((r) => r.supplier.deletedAt === null)
        .map((r) => ({
          supplier: r.supplier.name,
          product: r.product.name,
          sku: r.product.variants[0]?.sku ?? '',
          supplierSku: r.supplierSku,
          costPrice: r.costPrice?.toFixed(2) ?? '',
          currency: r.currency,
          leadTimeDays: r.leadTimeDays,
          minOrderQty: r.minOrderQty?.toString() ?? '',
          isPreferred: r.isPreferred,
        }));
      const headers = ['supplier', 'product', 'sku', 'supplierSku', 'costPrice', 'currency',
        'leadTimeDays', 'minOrderQty', 'isPreferred'];
      return { filename: `supplier-products-${stamp}.csv`, csv: toCsv(headers, flat as never) };
    }

    case 'purchase-orders': {
      const rows = await prisma.purchaseOrder.findMany({
        include: {
          supplier: { select: { name: true } },
          warehouse: { select: { name: true } },
          items: { include: { variant: { select: { sku: true, product: { select: { name: true } } } } } },
        },
        orderBy: { createdAt: 'desc' },
      });
      // One row per line, which is both how the importer reads them and how a
      // spreadsheet is usually wanted for reconciliation.
      const flat = rows.flatMap((po) =>
        po.items.map((i) => ({
          number: po.number,
          status: po.status,
          supplier: po.supplier.name,
          warehouse: po.warehouse.name,
          product: i.variant.product.name,
          sku: i.variant.sku,
          supplierSku: i.supplierSku,
          quantity: i.quantity.toString(),
          receivedQty: i.receivedQty.toString(),
          unitCost: i.unitCost.toFixed(2),
          taxRate: i.taxRate.toString(),
          lineTotal: i.total.toFixed(2),
          currency: po.currency,
          orderTotal: po.total.toFixed(2),
          expectedAt: po.expectedAt?.toISOString().slice(0, 10) ?? '',
          orderedAt: po.orderedAt?.toISOString().slice(0, 10) ?? '',
          receivedAt: po.receivedAt?.toISOString().slice(0, 10) ?? '',
          autoGenerated: po.autoGenerated,
          notes: po.notes,
        }))
      );
      const headers = ['number', 'status', 'supplier', 'warehouse', 'product', 'sku', 'supplierSku',
        'quantity', 'receivedQty', 'unitCost', 'taxRate', 'lineTotal', 'currency', 'orderTotal',
        'expectedAt', 'orderedAt', 'receivedAt', 'autoGenerated', 'notes'];
      return { filename: `purchase-orders-${stamp}.csv`, csv: toCsv(headers, flat as never) };
    }

    case 'reorder-levels': {
      const rows = await prisma.stockLevel.findMany({
        include: {
          warehouse: { select: { name: true } },
          variant: { select: { sku: true, product: { select: { name: true } } } },
        },
        orderBy: { id: 'asc' },
      });
      const flat = rows.map((l) => ({
        sku: l.variant.sku,
        product: l.variant.product.name,
        warehouse: l.warehouse.name,
        onHand: l.quantity.toString(),
        reserved: l.reserved.toString(),
        // Blank rather than "null" so an export can be filled in and re-imported.
        reorderPoint: l.reorderPoint?.toString() ?? '',
        reorderQty: l.reorderQty?.toString() ?? '',
      }));
      const headers = ['sku', 'product', 'warehouse', 'onHand', 'reserved', 'reorderPoint', 'reorderQty'];
      return { filename: `reorder-levels-${stamp}.csv`, csv: toCsv(headers, flat as never) };
    }
  }
}
