/*
 * The mobile app's create/edit forms, checked against the server that receives
 * them.
 *
 * The forms are declared in Dart and validated in TypeScript, so nothing links
 * the two. A field renamed here becomes a field the phone silently stops
 * sending; a field the schema requires and the form does not ask for becomes a
 * form that cannot be submitted at all — and neither shows up until someone
 * with a phone tries it.
 *
 * This reads the Dart declarations and holds them against the real zod schemas
 * and the real routes.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { z } from 'zod';

import { warehouseSchema } from '../../src/application/inventory/inventory.service';
import { supplierSchema } from '../../src/application/purchasing/suppliers.service';
import { createEmployeeSchema } from '../../src/application/employees/employees.service';
import { createProductSchema, variantSchema } from '../../src/application/catalog/catalog.dto';
import { promotionSchema } from '../../src/application/marketing/promotions.service';
import { createRequisitionSchema } from '../../src/application/inventory/requisitions.service';
import { dealSchema } from '../../src/application/crm/crm.service';
import { purchaseOrderSchema } from '../../src/application/purchasing/purchase-orders.service';
import { branchSchema, updateBranchSchema } from '../../src/application/branches/branches.service';
import { createInvoiceSchema, invoicePaymentSchema } from '../../src/application/invoices/invoices.service';
import { updateSupplierSchema } from '../../src/application/purchasing/suppliers.service';
import { updateEmployeeSchema } from '../../src/application/employees/employees.service';
import { updateProductSchema } from '../../src/application/catalog/catalog.dto';
import { updateWarehouseSchema } from '../../src/application/inventory/inventory.service';
import { updateTicketSchema, createTicketSchema } from '../../src/application/support/support.service';

let passed = 0, failed = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); }
};

const FORMS = '../flutter/lib/features/tablet/module_forms.dart';
const dart = readFileSync(FORMS, 'utf8');

/** Pull each `ModuleForm(...)` block out of the Dart source. */
function parseForms() {
  const out: {
    slug: string; endpoint: string; createPermission: string;
    updatePermission?: string;
    fields: { key: string; required: boolean; optionsEndpoint: string | null }[];
    editFields: { key: string; required: boolean; optionsEndpoint: string | null }[] | null;
  }[] = [];
  // Blocks start at `ModuleForm(` and run to the line `  ),` at that depth.
  const blocks = dart.split(/\n  ModuleForm\(/).slice(1);
  for (const raw of blocks) {
    const block = raw.split(/\n  \),/)[0]!;
    const slug = block.match(/slug: '([^']+)'/)?.[1];
    const endpoint = block.match(/endpoint: '([^']+)'/)?.[1];
    const createPermission = block.match(/createPermission: '([^']+)'/)?.[1];
    const updatePermission = block.match(/updatePermission: '([^']+)'/)?.[1];
    if (!slug || !endpoint || !createPermission) continue;
    // `fields:` and `editFields:` are separate lists in the same block.
    const editSplit = block.split('editFields:');
    const createPart = editSplit[0]!;
    const editPart = editSplit[1];
    const specs = (text: string) =>
      [...text.matchAll(/FormFieldSpec\(\s*'([a-zA-Z0-9]+)',\s*'[^']*'([^)]*)\)/g)]
        .map((m) => ({
          key: m[1]!,
          required: /required: true/.test(m[2] ?? ''),
          optionsEndpoint: /optionsEndpoint: '([^']+)'/.exec(m[2] ?? '')?.[1] ?? null,
        }));
    out.push({
      slug, endpoint, createPermission, updatePermission,
      fields: specs(createPart),
      editFields: editPart ? specs(editPart) : null,
    });
  }
  return out;
}

/** Keys a zod object accepts, and which of them it insists on. */
function shapeOf(schema: z.ZodTypeAny): { keys: Set<string>; required: Set<string> } {
  // A schema carrying a `.refine()` is a ZodEffects wrapping the object, and
  // the object underneath is where the fields live.
  let inner: z.ZodTypeAny = schema;
  while ((inner as unknown as { _def?: { typeName?: string } })._def?.typeName === 'ZodEffects') {
    inner = (inner as unknown as { _def: { schema: z.ZodTypeAny } })._def.schema;
  }
  const shape = (inner as unknown as z.ZodObject<z.ZodRawShape>).shape;
  const keys = new Set(Object.keys(shape));
  const required = new Set(
    Object.entries(shape)
      .filter(([, v]) => !(v as z.ZodTypeAny).isOptional())
      .map(([k]) => k),
  );
  return { keys, required };
}

const schemas: Record<string, { keys: Set<string>; required: Set<string> }> = {
  warehouses: shapeOf(warehouseSchema),
  suppliers: shapeOf(supplierSchema),
  employees: shapeOf(createEmployeeSchema),
  promotions: shapeOf(promotionSchema),
  support: shapeOf(createTicketSchema),
  crm: shapeOf(dealSchema),
  branches: shapeOf(branchSchema),
  // A product form fills in the product and its first variant together.
  catalog: (() => {
    const p = shapeOf(createProductSchema);
    const v = shapeOf(variantSchema);
    return {
      keys: new Set([...p.keys, ...v.keys]),
      // `variants` is assembled by the form, not typed by a person.
      required: new Set([...[...p.required].filter((k) => k !== 'variants'), ...v.required]),
    };
  })(),
};

/**
 * The keys one variant card sends, read from `_VariantRow.toJson()`.
 *
 * Parsed rather than listed here on purpose: a variant field added to the card
 * and forgotten in the server's schema — or the reverse — is exactly the drift
 * this suite exists to catch, and a hand-written list would hide it.
 */
function variantCardKeys(): string[] {
  const sheet = readFileSync('../flutter/lib/features/tablet/module_form_sheet.dart', 'utf8');
  const body = /Map<String, dynamic> toJson\(\) \{([\s\S]*?)\n  \}/.exec(sheet)?.[1];
  if (!body) throw new Error('Could not find _VariantRow.toJson in module_form_sheet.dart');
  return [...body.matchAll(/'([a-zA-Z0-9]+)':/g)].map((m) => m[1]!);
}

const routeFiles = [
  'src/presentation/http/v1/inventory.routes.ts',
  'src/presentation/http/v1/suppliers.routes.ts',
  'src/presentation/http/v1/employees.routes.ts',
  'src/presentation/http/v1/catalog.routes.ts',
  'src/presentation/http/v1/marketing.routes.ts',
  'src/presentation/http/v1/requisitions.routes.ts',
  'src/presentation/http/v1/support.routes.ts',
  'src/presentation/http/v1/crm.routes.ts',
  'src/presentation/http/v1/purchase-orders.routes.ts',
  'src/presentation/http/v1/branches.routes.ts',
  'src/presentation/http/v1/orders.routes.ts',
  'src/presentation/http/v1/invoices.routes.ts',
  'src/presentation/http/v1/catalog.routes.ts',
].map((f) => readFileSync(f, 'utf8')).join('\n');

const forms = parseForms();

/*
 * A module whose create screen is its own — a requisition, which is two
 * warehouses and a list of lines — declares no fields. The field checks below
 * do not apply to it, but the endpoint and permission checks very much do.
 */
const bespoke = new Set(['requisitions', 'purchase-orders', 'invoices']);
/*
 * What a PATCH actually accepts, per module. zod strips unknown keys rather
 * than refusing them, so an edit form offering a field the update schema does
 * not carry saves cleanly and changes nothing — which is worse than an error,
 * because the person believes it worked.
 */
const updateSchemas: Record<string, ReturnType<typeof shapeOf>> = {
  warehouses: shapeOf(updateWarehouseSchema),
  suppliers: shapeOf(updateSupplierSchema),
  employees: shapeOf(updateEmployeeSchema),
  catalog: shapeOf(updateProductSchema),
  support: shapeOf(updateTicketSchema),
  branches: shapeOf(updateBranchSchema),
};
const declarative = forms.filter((f) => !bespoke.has(f.slug));

console.log('\n=== 1. EVERY FORM WAS FOUND ===');
check('every module with a form was parsed', forms.length === 11, String(forms.length));
check('the declarative ones have fields', declarative.every((f) => f.fields.length > 0));
check('the bespoke ones deliberately have none',
  forms.filter((f) => bespoke.has(f.slug)).every((f) => f.fields.length === 0));
for (const f of declarative) {
  check(`${f.slug} parsed`, Boolean(schemas[f.slug]), 'no schema mapped');
}

/**
 * Fields a form collects but does not put in the record's own body.
 *
 * A product's photos are the case: they are uploaded to /files and attached
 * through the product's gallery endpoint, because an image has to point at a
 * product that already exists. The exemption is checked below rather than
 * simply trusted — the form has to actually strip the key, and the endpoint
 * it uses instead has to exist.
 */
const sentElsewhere: Record<string, string[]> = { catalog: ['images'] };
const exempt = (slug: string, key: string) => (sentElsewhere[slug] ?? []).includes(key);

console.log('\n=== 2. NO FORM ASKS FOR A FIELD THE SERVER REFUSES ===');
for (const form of declarative) {
  const schema = schemas[form.slug];
  if (!schema) continue;
  const unknown = form.fields
    .map((f) => f.key)
    .filter((k) => !schema.keys.has(k) && !exempt(form.slug, k));
  check(`${form.slug} sends only accepted fields`, unknown.length === 0, unknown.join(', '));
}

console.log('\n=== 2b. WHAT IS SENT ELSEWHERE REALLY IS SENT ELSEWHERE ===');
{
  const dart = readFileSync(FORMS, 'utf8');
  for (const [slug, keys] of Object.entries(sentElsewhere)) {
    for (const key of keys) {
      // Stripped from the record's own body, or the create would be rejected
      // for a field the schema has never heard of.
      check(
        `${slug} strips ${key} from the body it posts`,
        new RegExp(`body\\.remove\\('${key}'\\)`).test(dart),
        'buildBody does not remove it',
      );
      // And there is somewhere else for it to go.
      const form = forms.find((f) => f.slug === slug);
      const gallery = `${form?.endpoint}/:id/${key}`;
      check(
        `${slug} has a ${key} endpoint to attach to`,
        routeFiles.includes(`'/products/:id/${key}'`),
        `${gallery} not found in the routes`,
      );
    }
  }
}

console.log('\n=== 3. NO REQUIRED FIELD IS MISSING FROM A FORM ===');
for (const form of declarative) {
  const schema = schemas[form.slug];
  if (!schema) continue;
  const asked = new Set(form.fields.map((f) => f.key));
  // A product's variant fields are filled in on the repeatable variant card
  // rather than as top-level specs, so they are read from what that card
  // actually sends. Without this the check would report sku and price as
  // missing while the phone asks for both.
  if (form.slug === 'catalog') {
    for (const key of variantCardKeys()) asked.add(key);
  }
  const missing = [...schema.required].filter((k) => !asked.has(k));
  // A form missing one of these cannot be submitted at all.
  check(`${form.slug} asks for everything the server insists on`, missing.length === 0, missing.join(', '));
}

console.log('\n=== 4. WHAT THE FORM MARKS REQUIRED, THE SERVER DOES TOO ===');
for (const form of declarative) {
  const schema = schemas[form.slug];
  if (!schema) continue;
  // The reverse is allowed — a form may insist on more than the server does.
  // What must not happen is the form waving through something the server
  // rejects, because the error then arrives after the person hits Create.
  const softWhereServerIsHard = [...schema.required].filter(
    (k) => form.fields.some((f) => f.key === k && !f.required),
  );
  check(
    `${form.slug} marks the server's required fields as required`,
    softWhereServerIsHard.length === 0,
    softWhereServerIsHard.join(', '),
  );
}

console.log('\n=== 5. THE ENDPOINTS AND PERMISSIONS EXIST ===');
for (const form of forms) {
  /*
   * Each router is mounted under a prefix and declares paths relative to it,
   * so `/suppliers` is routed as `'/'` inside suppliers.routes.ts. Both forms
   * are accepted here; the earlier version of this check only stripped some
   * prefixes and reported two perfectly good endpoints as missing.
   */
  const segments = form.endpoint.split('/').filter(Boolean);
  const candidates = new Set<string>(['/']);
  for (let i = 0; i < segments.length; i++) {
    candidates.add(`/${segments.slice(i).join('/')}`);
  }
  const routed = [...candidates].some((c) => routeFiles.includes(`'${c}',`));
  check(`${form.slug} posts to a route that exists`, routed, form.endpoint);
  check(
    `${form.slug} create permission is a real one`,
    routeFiles.includes(`'${form.createPermission}'`),
    form.createPermission,
  );
  if (form.updatePermission) {
    check(
      `${form.slug} update permission is a real one`,
      routeFiles.includes(`'${form.updatePermission}'`),
      form.updatePermission,
    );
  }
}

console.log('\n=== 5b. AN EDIT ONLY OFFERS WHAT AN UPDATE ACCEPTS ===');
for (const form of declarative) {
  if (!form.updatePermission) continue;
  const update = updateSchemas[form.slug];
  if (!update) {
    check(`${form.slug} has its update schema mapped`, false, 'not mapped');
    continue;
  }
  const offered = (form.editFields ?? form.fields).map((f) => f.key);
  // A product's variant fields are create-only and dropped before the PATCH.
  const createOnly = new Set(['sku', 'barcode', 'price', 'costPrice', 'initialStock']);
  const ignored = offered.filter(
    (k) =>
      !update.keys.has(k) &&
      !(form.slug === 'catalog' && createOnly.has(k)) &&
      !exempt(form.slug, k),
  );
  check(
    `${form.slug} edit fields are all things a PATCH keeps`,
    ignored.length === 0,
    ignored.join(', '),
  );
}

console.log('\n=== 6. THE BESPOKE SCREEN SENDS WHAT ITS SCHEMA REQUIRES ===');
{
  const screen = readFileSync(
    '../flutter/lib/features/inventory/requisition_create_screen.dart',
    'utf8',
  );
  const { required } = shapeOf(createRequisitionSchema);
  for (const key of required) {
    // `items` is assembled from the lines rather than sent as a literal key.
    const sent = screen.includes(`'${key}':`) || screen.includes(`'${key}'`);
    check(`the requisition screen sends ${key}`, sent);
  }
  check('and posts to the requisition endpoint', screen.includes("post(\n        '/requisitions'"));
  check('offering a draft as well as a submission', screen.includes("'submit': submitNow"));
  check(
    'asking the source what it can spare',
    screen.includes('/requisitions/availability'),
  );
  // The bug that made the web version show an empty product list.
  check(
    'and staying within the catalogue limit the server accepts',
    /'limit': 100/.test(screen),
  );
}

console.log('\n=== 7. THE PURCHASE ORDER SCREEN MATCHES ITS SCHEMA ===');
{
  const screen = readFileSync(
    '../flutter/lib/features/purchasing/purchase_order_create_screen.dart',
    'utf8',
  );
  const { required } = shapeOf(purchaseOrderSchema);
  for (const key of required) {
    check(`the order screen sends ${key}`, screen.includes(`'${key}'`));
  }
  // Each line carries a cost; an order without one is not an order.
  check('every line carries a unit cost', screen.includes("'unitCost': l.unitCost"));
  check('and a quantity', screen.includes("'quantity': l.quantity"));
  check('the running total is shown before it is raised', screen.includes('Order total'));
  check('within the catalogue limit', /'limit': 100/.test(screen));
}

console.log('\n=== 8. THE TILL SELLS WHAT THE ORDER ENDPOINT ACCEPTS ===');
{
  const till = readFileSync('../flutter/lib/features/pos/pos_screen.dart', 'utf8');
  check('a sale is recorded as an order', till.includes("post(\n        '/orders'"));
  // Marked as POS so the rest of the system can tell a till sale from a web
  // one — reporting, shift totals and stock all read this.
  check('marked as coming from the till', till.includes("'source': 'POS'"));
  check('with a customer, which the endpoint requires', till.includes("'customerId': _customerId"));
  check('and at least one line', till.includes("'variantId': l.variantId"));
  check('within the catalogue limit', /'limit': 100/.test(till));
}

console.log('\n=== 9. THE MENU HIDES ONLY WHAT THE SERVER REFUSES ===');
{
  /*
   * Two ways to decide a module is unavailable, and they are not the same.
   *
   * A permission is something an administrator in the business can grant. A
   * plan feature is something the business has to pay for, and the server
   * refuses those at the endpoint with `requireFeature`. The plan catalogue
   * lists far more features than the API actually enforces, and gating the
   * menu on the catalogue would take modules away from businesses whose
   * endpoints still answer — hiding working software on the strength of a
   * price list.
   *
   * So the rule is: the app may hide a module for its plan only where the
   * server would refuse it anyway. This keeps the two in step in the one
   * direction that matters.
   */
  const catalog = readFileSync(
    '../flutter/lib/features/shell/module_catalog.dart',
    'utf8',
  );
  const routeSource = readdirSync('src/presentation/http/v1')
    .filter((f) => f.endsWith('.ts'))
    .map((f) => readFileSync(`src/presentation/http/v1/${f}`, 'utf8'))
    .join('\n');

  const enforced = new Set(
    [...routeSource.matchAll(/requireFeature\('([a-z_]+)'\)/g)].map((m) => m[1]!),
  );
  // Only lines that are actually live — a commented-out module gates nothing.
  const gated = new Set(
    catalog
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//'))
      .flatMap((l) => [...l.matchAll(/feature: '([a-z_]+)'/g)].map((m) => m[1]!)),
  );

  check('the server enforces at least one feature', enforced.size > 0,
    [...enforced].join(', '));

  const overreach = [...gated].filter((f) => !enforced.has(f));
  check(
    'the app gates nothing the server would allow',
    overreach.length === 0,
    overreach.join(', '),
  );

  // The case that prompted this: AI insights is refused on the free plan, and
  // a tile that opens onto that error reads as a broken app.
  check('AI insights is gated, because the server refuses it', gated.has('ai_insights'));

  /*
   * The other direction is a warning rather than a rule. A feature the server
   * enforces but the menu does not gate is only a problem if the module is
   * reachable — `api` is enforced on the developer routes, and the Developers
   * tile is commented out of the catalogue entirely.
   */
  const enforcedButOpen = [...enforced].filter((f) => !gated.has(f));
  for (const feature of enforcedButOpen) {
    const moduleSlug = feature === 'api' ? 'developers' : feature;
    const reachable = catalog
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//'))
      .some((l) => l.includes(`/module/${moduleSlug}'`));
    check(
      `nothing reachable needs "${feature}" without gating it`,
      !reachable,
      `/module/${moduleSlug} is in the menu but never checks the plan`,
    );
  }
}

console.log('\n=== 9b. INVOICES CAN BE RAISED AND THEN MANAGED ===');
{
  const create = readFileSync(
    '../flutter/lib/features/invoices/invoice_create_screen.dart',
    'utf8',
  );
  const { required } = shapeOf(createInvoiceSchema);
  for (const key of required) {
    check(`the invoice screen sends ${key}`, create.includes(`'${key}'`));
  }
  // A line is written, not picked from the catalogue — an invoice bills for
  // delivery and consultancy as readily as for stock.
  check('each line carries a description', create.includes("'description':"));
  check('with a quantity and a price', create.includes("'quantity':") && create.includes("'unitPrice':"));
  // Sending is a decision about contacting a customer, not a side effect of
  // saving, so both outcomes have to be reachable.
  check('a draft can be saved without sending', create.includes("_save(sendNow: false)"));
  check('and an invoice can be issued', create.includes("_save(sendNow: true)"));

  const actions = readFileSync(
    '../flutter/lib/features/invoices/invoice_actions.dart',
    'utf8',
  );
  check('an invoice can be sent', actions.includes("'/invoices/$_id/send'"));
  check('a payment can be recorded', actions.includes('/payments'));
  check('and it can be voided', actions.includes("'/invoices/$_id/void'"));
  for (const key of shapeOf(invoicePaymentSchema).required) {
    check(`the payment sheet sends ${key}`, actions.includes(`'${key}':`));
  }
  // Each action is gated on the permission its own route demands, so nothing
  // is offered that the server will refuse.
  for (const permission of ['invoices.send', 'payments.record', 'invoices.void']) {
    check(`${permission} gates its action`, actions.includes(`can('${permission}')`));
  }
}

console.log('\n=== 10. EVERY DROPDOWN HAS SOMEWHERE TO READ FROM ===');
{
  /*
   * A picker whose endpoint does not exist does not error — it renders an
   * empty list, which reads as "your business has no warehouses" to the person
   * holding the phone. That is the same failure mode as the requisition
   * product list that came back empty, so it is checked rather than trusted.
   */
  const routeSource = readdirSync('src/presentation/http/v1')
    .filter((f) => f.endsWith('.ts'))
    .map((f) => readFileSync(`src/presentation/http/v1/${f}`, 'utf8'))
    .join('\n');

  const endpoints = new Set(
    forms
      .flatMap((f) => [...f.fields, ...(f.editFields ?? [])])
      .map((f) => f.optionsEndpoint)
      .filter((e): e is string => e !== null),
  );
  check('some fields are filled from the API', endpoints.size > 0, [...endpoints].join(', '));

  for (const endpoint of endpoints) {
    const segments = endpoint.split('/').filter(Boolean);
    const candidates = new Set<string>(['/']);
    for (let i = 0; i < segments.length; i++) {
      candidates.add(`/${segments.slice(i).join('/')}`);
    }
    check(
      `${endpoint} is a route that exists`,
      [...candidates].some((c) => routeSource.includes(`'${c}',`)),
    );
  }
}

console.log('\n=== 11. THE PHONE ASKS FOR WHAT THE WEB ASKS FOR ===');
{
  /*
   * The mobile forms were a subset — a warehouse could be created without
   * naming its manager, a supplier without its code or tax ID — so a record
   * raised on a phone came out thinner than the same record raised at a desk,
   * and the difference only showed up later.
   *
   * The web pages hold their form state in one object literal, so the field
   * names can be read straight off it.
   */
  const webForm = (path: string, marker: RegExp): Set<string> => {
    const src = readFileSync(`../web/src/features/${path}`, 'utf8');
    const block = marker.exec(src)?.[1];
    if (!block) return new Set();
    return new Set(
      [...block.matchAll(/(\w+):/g)].map((m) => m[1]!),
    );
  };

  const cases: { slug: string; web: Set<string>; ignore: string[] }[] = [
    {
      slug: 'warehouses',
      web: webForm('inventory/WarehousesPage.tsx', /const EMPTY = \{([\s\S]*?)\};/),
      ignore: [],
    },
    {
      slug: 'suppliers',
      web: webForm('suppliers/SuppliersPage.tsx', /const EMPTY = \{([\s\S]*?)\};/),
      ignore: [],
    },
    {
      slug: 'employees',
      // Avatars are uploaded, not typed; the phone has no file picker here.
      web: webForm('employees/EmployeesPage.tsx', /const emptyForm = \{([\s\S]*?)\};/),
      ignore: ['avatarFileId', 'avatarUrl'],
    },
  ];

  for (const { slug, web, ignore } of cases) {
    check(`${slug} web form was read`, web.size > 0, `${web.size} fields`);
    const form = forms.find((f) => f.slug === slug);
    if (!form || web.size === 0) continue;
    const phone = new Set(form.fields.map((f) => f.key));
    const missing = [...web].filter((k) => !phone.has(k) && !ignore.includes(k));
    check(
      `${slug} asks for everything the web asks for`,
      missing.length === 0,
      missing.join(', '),
    );
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
