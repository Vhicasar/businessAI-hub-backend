import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSION_KEYS,
  ALL_PERMISSIONS,
  OWNER_ROLE_NAME,
  SYSTEM_ROLE_TEMPLATES,
} from '../../src/shared/permissions';

describe('permission catalog', () => {
  it('has unique, well-formed keys', () => {
    expect(new Set(ALL_PERMISSION_KEYS).size).toBe(ALL_PERMISSION_KEYS.length);
    for (const key of ALL_PERMISSION_KEYS) {
      expect(key).toMatch(/^[a-z_]+\.[a-z_]+$/);
    }
    expect(ALL_PERMISSIONS.length).toBeGreaterThan(100);
  });

  it('every role template references only existing permission keys', () => {
    const valid = new Set(ALL_PERMISSION_KEYS);
    for (const [role, tpl] of Object.entries(SYSTEM_ROLE_TEMPLATES)) {
      const unknown = tpl.permissions.filter((k) => !valid.has(k));
      expect(unknown, `role "${role}" has unknown keys: ${unknown.join(', ')}`).toEqual([]);
      expect(new Set(tpl.permissions).size, `role "${role}" has duplicates`).toBe(
        tpl.permissions.length
      );
    }
  });

  it('Owner has every permission; others are strict subsets', () => {
    const owner = SYSTEM_ROLE_TEMPLATES[OWNER_ROLE_NAME]!;
    expect(new Set(owner.permissions)).toEqual(new Set(ALL_PERMISSION_KEYS));
    for (const [name, tpl] of Object.entries(SYSTEM_ROLE_TEMPLATES)) {
      if (name === OWNER_ROLE_NAME) continue;
      expect(tpl.permissions.length).toBeLessThan(owner.permissions.length);
    }
  });

  it('guard rails: only Owner and Manager can manage billing or security', () => {
    for (const [name, tpl] of Object.entries(SYSTEM_ROLE_TEMPLATES)) {
      if (name === 'Owner') continue;
      expect(tpl.permissions).not.toContain('billing.manage');
      if (name !== 'Manager') {
        expect(tpl.permissions).not.toContain('settings.manage_users');
      }
    }
  });
});
