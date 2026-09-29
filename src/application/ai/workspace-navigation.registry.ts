/**
 * Canonical, server-side navigation knowledge for the workspace assistant.
 *
 * Keep this aligned with web/src/layouts/navItems.ts and web/src/app/router.tsx.
 * The assistant may only emit actions from this registry; model-written URLs
 * are never trusted as navigation actions.
 */
export interface WorkspaceDestination {
  id: string;
  label: string;
  path: string;
  section: string;
  description: string;
  keywords: string[];
  actions?: string[];
  /** Existing dynamic routes represented by this safe parent destination. */
  pathPatterns?: string[];
  requiredParameters?: string[];
  permissions?: string[];
  feature?: string;
  businessTypes?: string[];
  module?: string;
  offeredChannel?: string;
  mobilePath?: string;
}

export interface NavigationAccessContext {
  permissions: Set<string>;
  bypassPermissions: boolean;
  features: Set<string>;
  businessType: string;
  modules: Set<string>;
  offeredChannels: Set<string>;
}

export interface DestinationAccess {
  destination: WorkspaceDestination;
  allowed: boolean;
  reason?: 'permission' | 'plan' | 'business_type' | 'module' | 'channel_unavailable';
}

const destination = (
  id: string,
  label: string,
  path: string,
  section: string,
  description: string,
  keywords: string[],
  access: Partial<Omit<WorkspaceDestination, 'id' | 'label' | 'path' | 'section' | 'description' | 'keywords'>> = {},
): WorkspaceDestination => ({ id, label, path, section, description, keywords, ...access });

export const WORKSPACE_DESTINATIONS: readonly WorkspaceDestination[] = [
  destination('dashboard', 'Dashboard', '/', 'Workspace', 'Workspace overview and key activity.', ['dashboard', 'home', 'overview']),
  destination('inbox', 'Inbox', '/inbox', 'Workspace', 'Read and reply to customer conversations across connected channels.', ['inbox', 'message', 'conversation', 'reply', 'whatsapp', 'instagram', 'facebook', 'messenger', 'email'], { permissions: ['inbox.read'], mobilePath: '/inbox' }),
  destination('customers', 'Customers', '/customers', 'Sales', 'View and manage customer contacts and profiles.', ['customer', 'customers', 'contact', 'contacts', 'client', 'clients'], { permissions: ['customers.read'], mobilePath: '/customers', actions: ['add a customer', 'search/filter customers', 'open a customer profile'], pathPatterns: ['/customers/:id'], requiredParameters: ['customer id'] }),
  destination('crm', 'CRM', '/crm', 'Sales', 'Manage leads, deals, stages, pipelines, follow-ups and CRM automations.', ['crm', 'lead', 'leads', 'deal', 'deals', 'pipeline', 'opportunity', 'automation', 'automations'], { permissions: ['crm.read'], actions: ['create a lead or deal', 'move deals through pipeline stages', 'configure CRM automations'] }),
  destination('orders', 'Orders', '/orders', 'Sales', 'Review and manage customer orders.', ['order', 'orders', 'sale', 'sales'], { permissions: ['orders.read'], mobilePath: '/orders', actions: ['create or review an order', 'filter orders', 'open an order'], pathPatterns: ['/orders/:id'], requiredParameters: ['order id'] }),
  destination('pos', 'POS', '/pos', 'Sales', 'Take an in-person sale through Point of Sale.', ['pos', 'point of sale', 'checkout', 'cashier'], { permissions: ['pos.operate'], feature: 'pos' }),
  destination('products', 'Products', '/catalog', 'Operations', 'Manage products, variants, categories and brands.', ['product', 'products', 'catalog', 'category', 'categories', 'brand', 'brands', 'variant', 'variants', 'add product'], { permissions: ['catalog.read'], actions: ['add or edit a product', 'manage categories and brands', 'manage variants'] }),
  destination('inventory', 'Inventory', '/inventory', 'Operations', 'Review stock levels and inventory movements.', ['inventory', 'stock', 'stock level', 'adjustment'], { permissions: ['inventory.read'] }),
  destination('warehouses', 'Warehouses', '/warehouses', 'Operations', 'Manage warehouses and storage locations.', ['warehouse', 'warehouses', 'storage location', 'add warehouse'], { permissions: ['inventory.read'], actions: ['add or edit a warehouse', 'review warehouse stock'] }),
  destination('requisitions', 'Requisitions', '/requisitions', 'Operations', 'Create and review internal stock requisitions.', ['requisition', 'requisitions', 'request stock'], { permissions: ['inventory.read'] }),
  destination('suppliers', 'Suppliers', '/suppliers', 'Operations', 'Manage supplier records.', ['supplier', 'suppliers', 'vendor', 'vendors'], { permissions: ['suppliers.read', 'purchasing.read', 'catalog.read'] }),
  destination('purchase_orders', 'Purchase orders', '/purchase-orders', 'Operations', 'Create and track purchase orders.', ['purchase order', 'purchase orders', 'procurement', 'purchasing'], { permissions: ['purchasing.read'], actions: ['create a purchase order', 'review purchasing status'] }),
  destination('invoices', 'Invoices', '/invoices', 'Operations', 'Review, create and send invoices.', ['invoice', 'invoices', 'billing document'], { permissions: ['invoices.read'], actions: ['review invoices', 'open an invoice', 'create an invoice'], pathPatterns: ['/invoices/:id', '/invoices/:id/edit'], requiredParameters: ['invoice id'] }),
  destination('new_invoice', 'Create invoice', '/invoices/new', 'Operations', 'Create a new invoice.', ['create invoice', 'new invoice', 'send invoice'], { permissions: ['invoices.read'], actions: ['choose a customer', 'add invoice items', 'save and send the invoice'] }),
  destination('manufacturing', 'Manufacturing', '/manufacturing', 'Manufacturing', 'Manufacturing and operations overview.', ['manufacturing', 'factory', 'operations'], { permissions: ['manufacturing.read'], module: 'manufacturing' }),
  destination('production', 'Production', '/manufacturing/orders', 'Manufacturing', 'Plan and track production orders.', ['production', 'production order', 'production orders'], { permissions: ['production.read'], module: 'manufacturing' }),
  destination('recipes', 'Recipes', '/manufacturing/recipes', 'Manufacturing', 'Manage bills of materials and recipes.', ['recipe', 'recipes', 'bill of materials', 'bom'], { permissions: ['bom.read'], module: 'manufacturing' }),
  destination('batches', 'Batches', '/manufacturing/batches', 'Manufacturing', 'Track manufacturing batches.', ['batch', 'batches'], { permissions: ['production.read', 'qc.read', 'inventory.read'], module: 'manufacturing' }),
  destination('quality', 'Quality', '/manufacturing/quality', 'Manufacturing', 'Manage quality-control checks.', ['quality', 'quality control', 'qc'], { permissions: ['qc.read'], module: 'manufacturing' }),
  destination('equipment', 'Equipment', '/manufacturing/equipment', 'Manufacturing', 'Manage equipment and maintenance.', ['equipment', 'machine', 'machines', 'maintenance'], { permissions: ['equipment.read', 'maintenance.read'], module: 'manufacturing' }),
  destination('marketing', 'Marketing', '/marketing', 'Growth', 'Manage marketing campaigns.', ['marketing', 'campaign', 'campaigns', 'promotion', 'create campaign'], { permissions: ['marketing.read'], feature: 'marketing', actions: ['create and manage campaigns', 'review campaign performance'] }),
  destination('sms', 'SMS', '/sms', 'Growth', 'Manage SMS messaging and transactional notifications.', ['sms', 'text message', 'sender id'], { permissions: ['marketing.read'], offeredChannel: 'SMS' }),
  destination('support', 'Support', '/support', 'Growth', 'Manage customer support tickets.', ['support', 'ticket', 'tickets', 'helpdesk'], { permissions: ['support.read'] }),
  destination('analytics', 'Analytics', '/analytics', 'Growth', 'Review workspace reports and analytics.', ['analytics', 'report', 'reports', 'performance', 'metrics'], { permissions: ['analytics.view'] }),
  destination('ai_insights', 'AI Insights', '/insights', 'Growth', 'Open AI-powered business insights.', ['ai insights', 'forecast', 'trend', 'analysis'], { permissions: ['analytics.view'], feature: 'ai_insights' }),
  destination('payments', 'Payments', '/payments', 'Business', 'Configure and review business payment methods and settings.', ['payment', 'payments', 'payment gateway', 'payment method', 'settlement', 'wallet'], { permissions: ['payments.read', 'settings.manage_org'], actions: ['configure payment methods', 'review payment settings'] }),
  destination('booking', 'Booking', '/booking', 'Business', 'View and manage bookings and appointments.', ['booking', 'bookings', 'appointment', 'appointments', 'calendar'], { permissions: ['appointments.read'] }),
  destination('booking_settings', 'Booking settings', '/booking/settings', 'Business', 'Configure booking and appointment availability.', ['booking settings', 'appointment settings', 'availability', 'schedule setup'], { permissions: ['appointments.configure', 'appointments.read'] }),
  destination('ai_settings', 'AI settings', '/ai', 'Business', 'Configure the business AI assistant and its knowledge.', ['ai', 'assistant', 'knowledge', 'ai provider'], { permissions: ['ai.use_assistant', 'ai.configure'], actions: ['manage assistant knowledge', 'configure the AI provider'] }),
  destination('real_estate', 'Real Estate', '/realestate', 'Modules', 'Manage properties and real-estate workflows.', ['real estate', 'property', 'properties', 'listing', 'listings'], { permissions: ['properties.read'], businessTypes: ['REAL_ESTATE'] }),
  destination('employees', 'Employees', '/employees', 'Modules', 'Manage employee records.', ['employee', 'employees', 'staff', 'hr'], { permissions: ['employees.read'], pathPatterns: ['/employees/:id'], requiredParameters: ['employee id'] }),
  destination('account', 'Account Management', '/account', 'Administration', 'Manage team members, invitations, roles and permissions.', ['account management', 'team member', 'team members', 'invite user', 'add team member', 'role', 'roles', 'permission', 'permissions'], { permissions: ['settings.manage_users', 'settings.manage_roles'], actions: ['invite a member', 'manage members', 'manage roles and permissions'] }),
  destination('billing', 'Billing & plans', '/billing', 'Administration', 'Review the subscription, plan, usage and add-ons.', ['billing', 'plan', 'plans', 'subscription', 'usage', 'upgrade', 'add-on', 'addon'], { permissions: ['billing.view'], mobilePath: '/billing' }),
  destination('audit', 'Audit log', '/audit', 'Administration', 'Review security and workspace audit events.', ['audit', 'audit log', 'activity log'], { permissions: ['audit.read'] }),
  destination('developers', 'Developers', '/developers', 'Administration', 'Manage API keys and developer access.', ['developer', 'developers', 'api key', 'api keys', 'api'], { permissions: ['api_keys.read'], feature: 'api' }),
  destination('settings', 'Settings', '/settings', 'Administration', 'Manage personal preferences and workspace settings.', ['settings', 'preference', 'preferences', 'security', 'notification settings']),
  destination('organization_settings', 'Organization settings', '/settings/organization', 'Administration', 'Manage organization identity and business details.', ['organization settings', 'company settings', 'business profile', 'company profile'], { permissions: ['settings.manage_org'] }),
  destination('integrations', 'Integrations & channels', '/settings/integrations', 'Administration', 'Connect and manage customer communication channels and integrations.', ['integration', 'integrations', 'connect channel', 'connect whatsapp', 'connect instagram', 'connect facebook', 'channel settings', 'google calendar'], { permissions: ['settings.manage_integrations', 'inbox.manage_channels'], actions: ['connect or manage a supported channel', 'review channel connection status'] }),
] as const;

export function destinationAccess(
  item: WorkspaceDestination,
  context: NavigationAccessContext,
): DestinationAccess {
  if (!context.bypassPermissions && item.permissions?.length && !item.permissions.some((key) => context.permissions.has(key))) {
    return { destination: item, allowed: false, reason: 'permission' };
  }
  if (item.feature && !context.features.has(item.feature)) {
    return { destination: item, allowed: false, reason: 'plan' };
  }
  if (item.businessTypes?.length && !item.businessTypes.includes(context.businessType)) {
    return { destination: item, allowed: false, reason: 'business_type' };
  }
  if (item.module && !context.modules.has(item.module)) {
    return { destination: item, allowed: false, reason: 'module' };
  }
  if (item.offeredChannel && !context.offeredChannels.has(item.offeredChannel)) {
    return { destination: item, allowed: false, reason: 'channel_unavailable' };
  }
  return { destination: item, allowed: true };
}

function normalizedWords(value: string): Set<string> {
  return new Set(value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean));
}

export function destinationRelevance(item: WorkspaceDestination, prompt: string): number {
  const lower = prompt.toLowerCase();
  const words = normalizedWords(prompt);
  let score = 0;
  for (const phrase of [item.label, ...item.keywords]) {
    const normalized = phrase.toLowerCase();
    if (lower.includes(normalized)) score += normalized.includes(' ') ? 8 : 4;
    for (const word of normalizedWords(normalized)) if (word.length > 2 && words.has(word)) score += 1;
  }
  // Prefer the purpose-built create page over the invoice list for creation requests.
  if (item.id === 'new_invoice' && /\b(create|new|send|make)\b.*\binvoice\b/i.test(prompt)) score += 20;
  if (item.id === 'integrations' && /\b(connect|configure|set up|setup)\b.*\b(channel|whatsapp|instagram|facebook|messenger|email)\b/i.test(prompt)) score += 20;
  if (item.id === 'production' && /\bproduction\s+orders?\b/i.test(prompt)) score += 20;
  return score;
}

export function relevantDestinations(
  prompt: string,
  decisions: DestinationAccess[],
  allowed: boolean,
  limit = 3,
): DestinationAccess[] {
  return decisions
    .filter((decision) => decision.allowed === allowed)
    .map((decision) => ({ decision, score: destinationRelevance(decision.destination, prompt) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.decision.destination.label.localeCompare(b.decision.destination.label))
    .slice(0, limit)
    .map(({ decision }) => decision);
}

export function resolveCurrentDestination(path?: string): WorkspaceDestination | null {
  if (!path) return null;
  const clean = path.split(/[?#]/)[0] || '/';
  return [...WORKSPACE_DESTINATIONS]
    .sort((a, b) => b.path.length - a.path.length)
    .find((item) => clean === item.path || (item.path !== '/' && clean.startsWith(`${item.path}/`)) ||
      item.pathPatterns?.some((pattern) => {
        const expression = `^${pattern.replace(/:[^/]+/g, '[^/]+')}$`;
        return new RegExp(expression).test(clean);
      })) ?? null;
}
