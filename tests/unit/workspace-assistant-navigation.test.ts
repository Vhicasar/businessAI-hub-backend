import { describe, expect, it } from 'vitest';
import {
  WORKSPACE_DESTINATIONS,
  destinationAccess,
  relevantDestinations,
  resolveCurrentDestination,
  type NavigationAccessContext,
} from '../../src/application/ai/workspace-navigation.registry';

function context(overrides: Partial<NavigationAccessContext> = {}): NavigationAccessContext {
  return {
    permissions: new Set([
      'inbox.read', 'customers.read', 'crm.read', 'orders.read', 'pos.operate',
      'catalog.read', 'inventory.read', 'suppliers.read', 'purchasing.read',
      'manufacturing.read', 'production.read', 'bom.read', 'qc.read', 'equipment.read',
      'invoices.read', 'marketing.read', 'support.read', 'analytics.view',
      'payments.read', 'appointments.read', 'appointments.configure',
      'ai.use_assistant', 'properties.read', 'employees.read',
      'settings.manage_users', 'billing.view', 'audit.read', 'api_keys.read',
      'settings.manage_org', 'settings.manage_integrations',
    ]),
    bypassPermissions: false,
    features: new Set(['pos', 'marketing', 'ai_insights', 'api']),
    businessType: 'REAL_ESTATE',
    modules: new Set(['manufacturing']),
    offeredChannels: new Set(['EMAIL', 'SMS', 'WHATSAPP', 'WEB_CHAT']),
    ...overrides,
  };
}

function suggestions(prompt: string, ctx = context()) {
  const decisions = WORKSPACE_DESTINATIONS.map((item) => destinationAccess(item, ctx));
  return relevantDestinations(prompt, decisions, true).map(({ destination }) => destination.path);
}

describe('workspace assistant navigation registry', () => {
  it.each([
    ['How do I create and send an invoice?', '/invoices/new'],
    ['Where can I manage products and categories?', '/catalog'],
    ['Help me connect WhatsApp as a channel', '/settings/integrations'],
    ['Where do I review my subscription usage?', '/billing'],
    ['Show me production orders', '/manufacturing/orders'],
    ['Where are booking settings?', '/booking/settings'],
  ])('maps %s to the current route', (prompt, path) => {
    expect(suggestions(prompt)[0]).toBe(path);
  });

  it('contains no retired, redirected or unfinished assistant destinations', () => {
    const paths = WORKSPACE_DESTINATIONS.map((item) => item.path);
    expect(paths).not.toContain('/settings/billing');
    expect(paths).not.toContain('/settings/knowledge');
    expect(paths).not.toContain('/website');
    expect(paths).not.toContain('/designs');
    expect(paths.every((path) => !path.includes(':'))).toBe(true);
  });

  it('does not suggest a page the role cannot access', () => {
    expect(suggestions('Open customer contacts', context({ permissions: new Set() }))).not.toContain('/customers');
  });

  it('does not suggest plan, module, business-type or channel gated pages when unavailable', () => {
    const restricted = context({
      features: new Set(),
      businessType: 'RETAIL',
      modules: new Set(),
      offeredChannels: new Set(['EMAIL']),
    });
    expect(suggestions('Open POS marketing insights manufacturing real estate SMS', restricted)).toEqual([]);
  });

  it('reports why a relevant destination is unavailable', () => {
    const item = WORKSPACE_DESTINATIONS.find((entry) => entry.id === 'marketing')!;
    expect(destinationAccess(item, context({ features: new Set() }))).toMatchObject({ allowed: false, reason: 'plan' });
  });

  it('matches a detail URL to its parent destination without suggesting a dynamic URL', () => {
    expect(resolveCurrentDestination('/customers/cus_123?tab=orders')?.id).toBe('customers');
  });

  it('keeps every generated action inside the registry', () => {
    const known = new Set(WORKSPACE_DESTINATIONS.map((item) => item.path));
    for (const prompt of ['invoice', 'customer', 'connect instagram', 'analytics', 'stock', 'team roles']) {
      for (const path of suggestions(prompt)) expect(known.has(path)).toBe(true);
    }
  });
});
