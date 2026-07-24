import type { DetectedType } from './detect';

/**
 * Declarative target-field registry. Drives three things at once: the mapping
 * UI, header-alias matching, and content-type suggestions. Adding a field here
 * is all that's needed for it to appear in the importer.
 */

export const ENTITIES = ['customers', 'leads', 'employees', 'products', 'kb-articles'] as const;
export type Entity = (typeof ENTITIES)[number];

export interface FieldDef {
  key: string;
  label: string;
  required?: boolean;
  /** Content types that plausibly belong in this field (drives auto-suggest). */
  accepts: DetectedType[];
  /** Header spellings seen in the wild. */
  aliases: string[];
  hint?: string;
  enumValues?: string[];
  /** Grouping for the mapping UI. */
  group?: string;
}

/** Split into first/last when the source only has one combined name column. */
const FULL_NAME: FieldDef = {
  key: 'fullName',
  label: 'Full name (split automatically)',
  accepts: ['fullName', 'text'],
  aliases: ['name', 'full name', 'fullname', 'contact name', 'display name', 'requester', 'customer'],
  hint: 'Only needed when there are no separate first/last columns',
};
// Deliberately do NOT accept 'fullName': a column detected as a full name must
// win the dedicated fullName field (which splits it), not be silently dumped
// into firstName. A "First name" header still matches on the header alone.
const FIRST: FieldDef = { key: 'firstName', label: 'First name', accepts: ['text'], aliases: ['first name', 'firstname', 'first', 'given name', 'givenname'] };
const LAST: FieldDef = { key: 'lastName', label: 'Last name', accepts: ['text'], aliases: ['last name', 'lastname', 'last', 'family name', 'surname'] };
const EMAIL: FieldDef = { key: 'email', label: 'Email', accepts: ['email'], aliases: ['email', 'email address', 'e-mail', 'primary email', 'work email'] };
const PHONE: FieldDef = { key: 'phone', label: 'Phone', accepts: ['phone', 'number'], aliases: ['phone', 'phone number', 'mobile', 'telephone', 'tel', 'cell'] };

/** Preserves the record's ID from the system you're migrating off. */
const externalId = (label: string, aliases: string[]): FieldDef => ({
  key: 'externalId',
  label,
  accepts: ['text', 'number'],
  aliases,
  hint: 'Kept for reference and used to avoid re-importing the same record twice',
  group: 'Identity',
});

const ADDRESS: FieldDef[] = [
  {
    key: 'addressLine1', label: 'Address line 1', accepts: ['text'],
    aliases: ['address line 1', 'address1', 'address', 'street', 'street address', 'addressline1'],
    hint: 'A saved address needs line 1, city and country; anything less is kept as a note on the record',
    group: 'Address',
  },
  { key: 'addressLine2', label: 'Address line 2', accepts: ['text'], aliases: ['address line 2', 'address2', 'apartment', 'suite', 'unit', 'addressline2'], group: 'Address' },
  { key: 'city', label: 'City', accepts: ['text'], aliases: ['city', 'town', 'locality'], group: 'Address' },
  { key: 'state', label: 'State / region', accepts: ['text'], aliases: ['state', 'region', 'province', 'county'], group: 'Address' },
  { key: 'postalCode', label: 'Postal code', accepts: ['text', 'number'], aliases: ['postal code', 'postcode', 'zip', 'zip code', 'postalcode'], group: 'Address' },
  {
    key: 'country', label: 'Country', accepts: ['text'],
    aliases: ['country', 'country code', 'nation'],
    hint: 'A 2-letter code (NG, US, GB) or a common country name',
    group: 'Address',
  },
];

export const FIELD_DEFS: Record<Entity, FieldDef[]> = {
  customers: [
    externalId('Customer ID (from your old system)', ['customer id', 'customerid', 'id', 'external id', 'contact id', 'user id', 'reference']),
    { ...FIRST, required: true },
    LAST,
    EMAIL,
    PHONE,
    FULL_NAME,
    { key: 'company', label: 'Company name', accepts: ['text', 'fullName'], aliases: ['company', 'company name', 'organisation', 'organization', 'account', 'business'] },
    { key: 'marketingOptIn', label: 'Marketing opt-in', accepts: ['boolean'], aliases: ['marketing opt in', 'marketingoptin', 'subscribed', 'opt in', 'consent', 'newsletter', 'email marketing'] },
    {
      key: 'status', label: 'Status / active', accepts: ['text', 'boolean'],
      // Deliberately no 'state' alias: customers carry an address, and a "State"
      // column is far more often Lagos/California than ACTIVE/BLOCKED.
      aliases: ['status', 'active', 'is active', 'customer status', 'account status', 'enabled'],
      enumValues: ['ACTIVE', 'BLOCKED'],
      hint: 'Accepts ACTIVE/BLOCKED, or yes/no for active',
    },
    { key: 'isBlocked', label: 'Blocked', accepts: ['boolean'], aliases: ['blocked', 'is blocked', 'banned', 'suspended'], hint: 'Takes precedence over Status if both are mapped' },
    { key: 'language', label: 'Language', accepts: ['text'], aliases: ['language', 'locale', 'lang', 'preferred language'] },
    { key: 'notes', label: 'Notes', accepts: ['text'], aliases: ['notes', 'note', 'comments', 'details', 'about'] },
    { key: 'tags', label: 'Tags', accepts: ['text'], aliases: ['tags', 'labels', 'segments'], hint: 'Comma-separated' },
    ...ADDRESS,
  ],

  leads: [
    externalId('Lead ID (from your old system)', ['lead id', 'leadid', 'id', 'external id', 'record id', 'reference']),
    { ...FIRST, required: true },
    LAST,
    EMAIL,
    PHONE,
    FULL_NAME,
    { key: 'company', label: 'Company name', accepts: ['text', 'fullName'], aliases: ['company', 'company name', 'organisation', 'organization', 'account', 'business'] },
    { key: 'source', label: 'Source', accepts: ['text'], aliases: ['source', 'lead source', 'channel', 'origin', 'utm source'] },
    {
      key: 'status', label: 'Status', accepts: ['text'],
      aliases: ['status', 'stage', 'lead status', 'state'],
      enumValues: ['NEW', 'CONTACTED', 'QUALIFIED', 'UNQUALIFIED', 'CONVERTED', 'LOST'],
      hint: 'Unrecognised values fall back to NEW',
    },
    { key: 'estimatedValue', label: 'Estimated value', accepts: ['currency', 'number'], aliases: ['estimated value', 'value', 'deal size', 'amount', 'budget', 'opportunity value'] },
    {
      key: 'score', label: 'Score (0-100)', accepts: ['number'],
      aliases: ['score', 'lead score', 'ai score', 'rating', 'grade'],
      hint: 'Existing scores are preserved instead of being recalculated',
    },
    {
      key: 'owner', label: 'Assigned to', accepts: ['email', 'text', 'fullName'],
      aliases: ['owner', 'assigned to', 'assignee', 'assigned', 'sales rep', 'account owner', 'agent'],
      hint: 'Matched to a team member by email, name or employee ID; unknown owners fail the row',
    },
    { key: 'interest', label: 'Interest', accepts: ['text'], aliases: ['interest', 'product interest', 'property interest', 'interested in', 'looking for', 'requirement'] },
    { key: 'notes', label: 'Notes', accepts: ['text'], aliases: ['notes', 'note', 'comments', 'details'] },
  ],

  employees: [
    {
      key: 'employeeNumber', label: 'Employee ID', accepts: ['text', 'number'],
      aliases: ['employee id', 'employeeid', 'employee number', 'employeenumber', 'staff id', 'payroll id', 'id', 'external id'],
      hint: 'Preserved as-is; auto-generated when left unmapped',
      group: 'Identity',
    },
    { ...FIRST, required: true },
    { ...LAST, required: true },
    EMAIL,
    PHONE,
    FULL_NAME,
    { key: 'jobTitle', label: 'Job title', accepts: ['text'], aliases: ['job title', 'title', 'position', 'role', 'designation'] },
    {
      key: 'department', label: 'Department (by name or code)', accepts: ['text'],
      aliases: ['department', 'department name', 'department code', 'dept', 'org unit path', 'team'],
      hint: 'Created automatically if it does not exist; org unit paths use the last segment',
    },
    {
      key: 'employmentType', label: 'Employment type', accepts: ['text'],
      aliases: ['employment type', 'type', 'contract type', 'employment'],
      enumValues: ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN'],
    },
    {
      key: 'status', label: 'Status / active', accepts: ['text', 'boolean'],
      aliases: ['status', 'active', 'is active', 'employee status', 'state', 'employment status'],
      enumValues: ['ACTIVE', 'ON_LEAVE', 'TERMINATED'],
      hint: 'Accepts ACTIVE/ON_LEAVE/TERMINATED, or yes/no for active',
    },
    { key: 'salary', label: 'Salary', accepts: ['currency', 'number'], aliases: ['salary', 'basic salary', 'pay', 'annual salary', 'compensation', 'base pay'] },
    { key: 'hiredAt', label: 'Hire date', accepts: ['date'], aliases: ['hired at', 'hire date', 'start date', 'joined', 'joining date', 'employment date'] },
  ],

  products: [
    externalId('Product ID (from your old system)', ['product id', 'productid', 'id', 'external id', 'handle', 'reference']),
    { key: 'name', label: 'Product name', required: true, accepts: ['text', 'fullName'], aliases: ['name', 'title', 'product name', 'product'] },
    { key: 'sku', label: 'SKU', accepts: ['text', 'number'], aliases: ['sku', 'variant sku', 'code', 'item code', 'product code'], hint: 'Generated from the product name when left unmapped' },
    { key: 'price', label: 'Price', required: true, accepts: ['currency', 'number'], aliases: ['price', 'variant price', 'unit price', 'selling price', 'retail price'] },
    { key: 'compareAtPrice', label: 'Compare-at price', accepts: ['currency', 'number'], aliases: ['compare at price', 'compareatprice', 'rrp', 'list price', 'was price', 'msrp'] },
    { key: 'costPrice', label: 'Cost price', accepts: ['currency', 'number'], aliases: ['cost price', 'cost', 'buy price', 'cost per item', 'wholesale price'] },
    { key: 'stock', label: 'Opening stock', accepts: ['number'], aliases: ['stock', 'quantity', 'qty', 'inventory quantity', 'on hand', 'initial stock', 'available'] },
    { key: 'barcode', label: 'Barcode', accepts: ['text', 'number'], aliases: ['barcode', 'ean', 'upc', 'gtin', 'isbn'] },
    { key: 'description', label: 'Description', accepts: ['text'], aliases: ['description', 'body', 'body html', 'details', 'summary'] },
    { key: 'category', label: 'Category', accepts: ['text', 'fullName'], aliases: ['category', 'product category', 'type', 'product type', 'collection'], hint: 'Created automatically if it does not exist' },
    { key: 'brand', label: 'Brand', accepts: ['text', 'fullName'], aliases: ['brand', 'vendor', 'manufacturer', 'make'], hint: 'Created automatically if it does not exist' },
    { key: 'variantName', label: 'Variant name', accepts: ['text'], aliases: ['variant name', 'variant', 'option', 'variant title'] },
    { key: 'taxRate', label: 'Tax rate (%)', accepts: ['number'], aliases: ['tax rate', 'tax', 'vat', 'vat rate'] },
    {
      key: 'status', label: 'Status', accepts: ['text', 'boolean'],
      aliases: ['status', 'published', 'active', 'state', 'visibility'],
      enumValues: ['ACTIVE', 'DRAFT', 'ARCHIVED'],
      hint: 'Accepts ACTIVE/DRAFT/ARCHIVED, or yes/no for published',
    },
  ],

  'kb-articles': [
    { key: 'title', label: 'Title', required: true, accepts: ['text', 'fullName'], aliases: ['title', 'name', 'subject', 'article title', 'question'] },
    { key: 'body', label: 'Body', required: true, accepts: ['text'], aliases: ['body', 'content', 'description', 'article body', 'html', 'answer'] },
    {
      key: 'status', label: 'Status', accepts: ['text', 'boolean'],
      aliases: ['status', 'state', 'published', 'draft'],
      enumValues: ['DRAFT', 'PUBLISHED', 'ARCHIVED'],
    },
    { key: 'isPublic', label: 'Public', accepts: ['boolean'], aliases: ['is public', 'public', 'visible', 'visibility', 'internal'] },
  ],
};

/** Fields that satisfy a required-field check as a group (either/or). */
export const EITHER_OR: Record<Entity, string[][]> = {
  customers: [['email', 'phone'], ['firstName', 'fullName']],
  leads: [['email', 'phone'], ['firstName', 'fullName']],
  employees: [['firstName', 'fullName'], ['lastName', 'fullName']],
  products: [],
  'kb-articles': [],
};
