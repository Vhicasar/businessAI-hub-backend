import { afterEach, describe, expect, it } from 'vitest';
import {
  isAutomaticChannelConnectEnabled,
  getWorkspaceConfig,
  setWorkspaceConfigOverride,
} from '../../src/application/settings/workspace-config';
import { adminEntitlementOverride, isAdminOverrideActive } from '../../src/application/billing/entitlements';

describe('platform admin controls', () => {
  afterEach(() => setWorkspaceConfigOverride(null));

  it('can hide only the automatic WhatsApp connection flow', () => {
    setWorkspaceConfigOverride({
      communication: { whatsappAutomaticConnectEnabled: false },
    });
    expect(isAutomaticChannelConnectEnabled('WHATSAPP')).toBe(false);
    expect(isAutomaticChannelConnectEnabled('INSTAGRAM')).toBe(true);
  });

  it('defaults automatic WhatsApp connection to enabled', () => {
    expect(isAutomaticChannelConnectEnabled('WHATSAPP')).toBe(true);
  });

  it('reads a persisted per-business plan and limit override', () => {
    expect(adminEntitlementOverride({
      platformEntitlements: {
        planSlug: 'business',
        limits: { maxUsers: 25, maxChannels: null },
        reason: 'Complimentary upgrade',
      },
    })).toEqual({
      planSlug: 'business',
      limits: { maxUsers: 25, maxChannels: null },
      reason: 'Complimentary upgrade',
    });
  });

  it('does not infer overrides from unrelated organization settings', () => {
    expect(adminEntitlementOverride({ invoicing: { prefix: 'INV' } })).toBeNull();
  });

  it('expires manual access exactly at the configured end time', () => {
    const now = new Date('2026-09-14T12:00:00Z');
    expect(isAdminOverrideActive({ expiresAt: '2026-09-15T12:00:00Z' }, now)).toBe(true);
    expect(isAdminOverrideActive({ expiresAt: '2026-09-14T12:00:00Z' }, now)).toBe(false);
    expect(isAdminOverrideActive({ planSlug: 'business' }, now)).toBe(false);
  });

  it('syncs the failed-payment grace policy with a safe default', () => {
    expect(getWorkspaceConfig().billing.failedSubscriptionGraceDays).toBe(7);
    setWorkspaceConfigOverride({ billing: { failedSubscriptionGraceDays: 4 } });
    expect(getWorkspaceConfig().billing.failedSubscriptionGraceDays).toBe(4);
  });
});
