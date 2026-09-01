/**
 * Vhicasar Hub AI — Permission catalog (single source of truth).
 * Seeded into the Permission table; imported by backend middleware and web UI;
 * codegen'd to Dart for Flutter (scripts/gen-dart-constants, Phase 4).
 *
 * Key format: `module.action`
 */

export const PERMISSION_MODULES = {
  dashboard: ['view'],
  // `manage_channels` covers connecting and configuring a channel;
  // `purchase_channels` is the money decision of buying another instance, and
  // `configure_auto_reply` is separable because deciding what answers a
  // customer unattended is not the same trust as adding an inbox.
  inbox: ['read', 'reply', 'assign', 'resolve', 'delete', 'manage_channels', 'purchase_channels', 'configure_auto_reply'],
  customers: ['read', 'create', 'update', 'delete', 'export', 'merge'],
  companies: ['read', 'create', 'update', 'delete'],
  // `convert` and `reengage` are split out from `update`: turning a lead into
  // an opportunity and re-opening one against a prospect are pipeline
  // decisions, not edits to a record.
  // Notes are split out because editing or removing a colleague's written
  // observation is a different trust level from adding your own — `note_create`
  // is routine, the other two are not. `change_value` is separate for the same
  // reason: it rewrites what a deal is worth.
  crm: [
    'read', 'create', 'update', 'delete', 'manage_pipelines',
    'convert', 'reengage', 'change_stage', 'change_value', 'assign',
    'note_create', 'note_update', 'note_delete',
  ],
  quotations: ['read', 'create', 'update', 'delete', 'send'],
  contracts: ['read', 'create', 'update', 'delete'],
  catalog: ['read', 'create', 'update', 'delete', 'manage_pricing'],
  // Requisitions are split from `transfer` because asking, agreeing and
  // physically sending are done by different people: a branch raises the
  // request, the source warehouse decides, and only then does stock move.
  inventory: [
    'read', 'adjust', 'transfer', 'manage_warehouses', 'set_reorder_levels',
    'requisition_create', 'requisition_approve', 'requisition_dispatch', 'requisition_receive',
  ],
  // Who you buy from. Separate from `purchasing` because maintaining the
  // supplier book is a different job from raising and receiving orders — a
  // buyer needs both, a warehouse hand only needs to read.
  suppliers: ['read', 'create', 'update', 'delete', 'manage_products'],
  purchasing: ['read', 'create', 'update', 'delete', 'receive', 'configure_reorder'],
  // Couriers and shipments. `configure` is an integration change (credentials,
  // webhook secrets); `dispatch` and `update_status` are day-to-day fulfilment,
  // so a packer can send a parcel without being able to swap the courier
  // account or read its keys.
  delivery: ['read', 'configure', 'dispatch', 'update_status'],
  promotions: ['read', 'create', 'update', 'publish'],
  orders: ['read', 'create', 'update', 'cancel', 'fulfill', 'refund', 'export'],
  pos: ['operate'],
  invoices: ['read', 'create', 'update', 'void', 'send'],
  // Taking money. `request` raises a payment intent against something owed and
  // is the everyday job of anyone serving a customer; `configure_methods` and
  // `connect_provider` change how the business gets paid at all, which is a
  // finance decision, not a counter-staff one. `cancel` and `refund` move money
  // that has already been promised or taken, so they stay separate again.
  payments: [
    'read',
    'record',
    'refund',
    'request',
    'cancel',
    'history',
    'configure_methods',
    'connect_provider',
    'manage_settings',
    'view_reports',
    'reconcile',
  ],
  payment_links: ['read', 'create', 'cancel', 'share'],
  vhicasar_pay: ['read', 'session_create', 'session_cancel', 'settle', 'chargeback', 'payout', 'payout_account'],
  marketing: ['read', 'create', 'update', 'delete', 'send'],
  segments: ['read', 'create', 'update', 'delete'],
  automations: ['read', 'create', 'update', 'delete'],
  loyalty: ['read', 'manage'],
  support: ['read', 'create', 'update', 'assign', 'escalate', 'manage_sla'],
  kb: ['read', 'create', 'update', 'delete', 'publish'],
  properties: ['read', 'create', 'update', 'delete'],
  leases: ['read', 'create', 'update', 'terminate'],
  bookings: ['read', 'create', 'update', 'cancel'],
  appointments: ['read', 'create', 'cancel', 'configure'],
  maintenance: ['read', 'create', 'update', 'assign'],
  commissions: ['read', 'approve', 'pay'],
  // People. The HR areas below are deliberately separate modules rather than
  // `employees` actions: reading the staff directory must not imply reading
  // salaries, payslips, medical leave or interview feedback.
  employees: ['read', 'create', 'update', 'delete', 'invite', 'manage_departments', 'view_salary'],
  leave: ['read', 'request', 'approve', 'manage_types'],
  attendance: ['read', 'clock', 'manage_shifts', 'manage_roster'],
  payroll: ['read', 'configure', 'process', 'approve', 'pay'],
  assets: ['read', 'create', 'update', 'delete', 'assign'],
  expenses: ['read', 'create', 'approve', 'reimburse'],
  recruitment: ['read', 'create', 'update', 'delete', 'hire'],
  performance: ['read', 'manage_cycles', 'review', 'manage_goals', 'give_feedback'],
  learning: ['read', 'manage_courses', 'enroll'],
  analytics: ['view', 'export'],
  ai: ['use_assistant', 'configure'],
  files: ['read', 'upload', 'delete'],
  settings: ['manage_org', 'manage_users', 'manage_roles', 'manage_integrations', 'manage_security'],
  billing: ['view', 'manage'],
  audit: ['read'],
  api_keys: ['read', 'create', 'revoke'],
  webhooks: ['read', 'create', 'update', 'delete'],
} as const;

export type PermissionModule = keyof typeof PERMISSION_MODULES;

export interface PermissionDef {
  key: string;
  module: string;
  description: string;
}

export const ALL_PERMISSIONS: PermissionDef[] = Object.entries(PERMISSION_MODULES).flatMap(
  ([module, actions]) =>
    actions.map((action) => ({
      key: `${module}.${action}`,
      module,
      description: `${action.replace(/_/g, ' ')} — ${module}`,
    }))
);

export const ALL_PERMISSION_KEYS: string[] = ALL_PERMISSIONS.map((p) => p.key);

const keysFor = (...modules: PermissionModule[]): string[] =>
  ALL_PERMISSIONS.filter((p) => modules.includes(p.module as PermissionModule)).map((p) => p.key);

/**
 * System role templates — instantiated per organization at signup
 * (and re-synced by seed for existing orgs). `isSystem: true` roles
 * cannot be edited or deleted by tenants.
 */
export const SYSTEM_ROLE_TEMPLATES: Record<string, { description: string; permissions: string[] }> = {
  Owner: {
    description: 'Full access to everything, including billing',
    permissions: ALL_PERMISSION_KEYS,
  },
  Manager: {
    description: 'Full operational access; no billing or security administration',
    permissions: ALL_PERMISSION_KEYS.filter(
      (k) => !k.startsWith('billing.') && k !== 'settings.manage_security'
    ),
  },
  Sales: {
    description: 'CRM, customers, orders and inbox',
    permissions: [
      ...keysFor('dashboard', 'crm', 'quotations', 'contracts', 'companies'),
      ...keysFor('customers').filter((k) => k !== 'customers.delete'),
      'inbox.read', 'inbox.reply', 'inbox.assign', 'inbox.resolve',
      'orders.read', 'orders.create', 'orders.export',
      'catalog.read', 'invoices.read', 'invoices.create', 'invoices.send',
      // Asking a customer to pay for what was just agreed is the job. Changing
      // how the business gets paid at all is not.
      'payments.read', 'payments.request', 'payments.history',
      'payment_links.read', 'payment_links.create', 'payment_links.share',
      // Answering "where is my order?" needs the delivery, not just the order.
      'delivery.read', 'promotions.read',
      'analytics.view', 'ai.use_assistant', 'files.read', 'files.upload',
    ],
  },
  'Customer Support': {
    description: 'Unified inbox, tickets and knowledge base',
    permissions: [
      'dashboard.view',
      // Everything about running the inbox, except spending money on another
      // channel — that is the business owner's call, not the agent's.
      ...keysFor('inbox', 'support', 'kb').filter((k) => k !== 'inbox.purchase_channels'),
      'customers.read', 'customers.update',
      'orders.read', 'invoices.read', 'delivery.read', 'promotions.read',
      // §10: an agent settles "how do I pay?" inside the conversation.
      'payments.read', 'payments.request', 'payments.history',
      'payment_links.read', 'payment_links.create', 'payment_links.share',
      'ai.use_assistant', 'files.read', 'files.upload',
    ],
  },
  Warehouse: {
    description: 'Inventory, suppliers, purchasing, receiving and dispatch',
    permissions: [
      'dashboard.view',
      ...keysFor('inventory', 'purchasing', 'suppliers'),
      'catalog.read', 'orders.read', 'orders.fulfill',
      // Dispatches parcels and moves them along, but connecting a courier
      // account is an integration change that belongs to an administrator.
      'delivery.read', 'delivery.dispatch', 'delivery.update_status',
      'files.read', 'files.upload',
    ],
  },
  Accountant: {
    description: 'Invoices, payments and financial reporting',
    permissions: [
      'dashboard.view',
      ...keysFor('invoices'),
      // Everything about money except handling the gateway's credentials —
      // connecting a provider is an integration change, the same reasoning
      // that keeps `delivery.configure` away from the warehouse.
      ...keysFor('payments').filter((k) => k !== 'payments.connect_provider'),
      ...keysFor('payment_links'),
      'orders.read', 'customers.read', 'contracts.read',
      'analytics.view', 'analytics.export', 'audit.read',
      'files.read', 'files.upload',
    ],
  },
  Marketing: {
    description: 'Campaigns, segments, automations and loyalty',
    permissions: [
      'dashboard.view',
      ...keysFor('marketing', 'segments', 'automations', 'loyalty', 'promotions'),
      'customers.read', 'customers.export', 'catalog.read',
      'analytics.view', 'ai.use_assistant', 'files.read', 'files.upload',
    ],
  },
  'HR Manager': {
    description: 'People operations: directory, leave, attendance, recruitment, performance and assets — excludes payroll',
    permissions: [
      'dashboard.view',
      ...keysFor('employees').filter((k) => k !== 'employees.view_salary'),
      ...keysFor('leave', 'attendance', 'assets', 'expenses', 'recruitment', 'performance', 'learning'),
      'analytics.view', 'ai.use_assistant', 'files.read', 'files.upload',
    ],
  },
  'Payroll Officer': {
    description: 'Payroll runs, pay components and payslips, with read-only access to the staff directory',
    permissions: [
      'dashboard.view',
      ...keysFor('payroll'),
      // Salary lives on the employee record, so payroll work needs it explicitly.
      'employees.read', 'employees.view_salary',
      'leave.read', 'attendance.read',
      'expenses.read', 'expenses.reimburse',
      'analytics.view', 'files.read', 'files.upload',
    ],
  },
  Agent: {
    description: 'Real-estate: properties, leases, bookings and CRM',
    permissions: [
      'dashboard.view',
      ...keysFor('properties', 'leases', 'bookings', 'maintenance', 'crm', 'quotations', 'contracts'),
      'commissions.read',
      'customers.read', 'customers.create', 'customers.update',
      'inbox.read', 'inbox.reply', 'inbox.assign', 'inbox.resolve',
      'invoices.read', 'analytics.view', 'ai.use_assistant',
      'files.read', 'files.upload',
    ],
  },
};

export const OWNER_ROLE_NAME = 'Owner';
