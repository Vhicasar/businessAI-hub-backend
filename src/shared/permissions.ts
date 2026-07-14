/**
 * BusinessHub AI — Permission catalog (single source of truth).
 * Seeded into the Permission table; imported by backend middleware and web UI;
 * codegen'd to Dart for Flutter (scripts/gen-dart-constants, Phase 4).
 *
 * Key format: `module.action`
 */

export const PERMISSION_MODULES = {
  dashboard: ['view'],
  inbox: ['read', 'reply', 'assign', 'resolve', 'delete', 'manage_channels'],
  customers: ['read', 'create', 'update', 'delete', 'export', 'merge'],
  companies: ['read', 'create', 'update', 'delete'],
  crm: ['read', 'create', 'update', 'delete', 'manage_pipelines'],
  quotations: ['read', 'create', 'update', 'delete', 'send'],
  contracts: ['read', 'create', 'update', 'delete'],
  catalog: ['read', 'create', 'update', 'delete', 'manage_pricing'],
  inventory: ['read', 'adjust', 'transfer', 'manage_warehouses'],
  purchasing: ['read', 'create', 'update', 'delete', 'receive'],
  orders: ['read', 'create', 'update', 'cancel', 'fulfill', 'refund', 'export'],
  pos: ['operate'],
  invoices: ['read', 'create', 'update', 'void', 'send'],
  payments: ['read', 'record', 'refund'],
  marketing: ['read', 'create', 'update', 'delete', 'send'],
  segments: ['read', 'create', 'update', 'delete'],
  automations: ['read', 'create', 'update', 'delete'],
  loyalty: ['read', 'manage'],
  support: ['read', 'create', 'update', 'assign', 'escalate', 'manage_sla'],
  kb: ['read', 'create', 'update', 'delete', 'publish'],
  properties: ['read', 'create', 'update', 'delete'],
  leases: ['read', 'create', 'update', 'terminate'],
  bookings: ['read', 'create', 'update', 'cancel'],
  maintenance: ['read', 'create', 'update', 'assign'],
  commissions: ['read', 'approve', 'pay'],
  employees: ['read', 'create', 'update', 'delete'],
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
      'analytics.view', 'ai.use_assistant', 'files.read', 'files.upload',
    ],
  },
  'Customer Support': {
    description: 'Unified inbox, tickets and knowledge base',
    permissions: [
      'dashboard.view',
      ...keysFor('inbox', 'support', 'kb'),
      'customers.read', 'customers.update',
      'orders.read', 'invoices.read',
      'ai.use_assistant', 'files.read', 'files.upload',
    ],
  },
  Warehouse: {
    description: 'Inventory, transfers, purchasing and order fulfillment',
    permissions: [
      'dashboard.view',
      ...keysFor('inventory', 'purchasing'),
      'catalog.read', 'orders.read', 'orders.fulfill',
      'files.read', 'files.upload',
    ],
  },
  Accountant: {
    description: 'Invoices, payments and financial reporting',
    permissions: [
      'dashboard.view',
      ...keysFor('invoices', 'payments'),
      'orders.read', 'customers.read', 'contracts.read',
      'analytics.view', 'analytics.export', 'audit.read',
      'files.read', 'files.upload',
    ],
  },
  Marketing: {
    description: 'Campaigns, segments, automations and loyalty',
    permissions: [
      'dashboard.view',
      ...keysFor('marketing', 'segments', 'automations', 'loyalty'),
      'customers.read', 'customers.export', 'catalog.read',
      'analytics.view', 'ai.use_assistant', 'files.read', 'files.upload',
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
