import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OAUTH_PROVIDERS } from '../../src/application/integrations/oauth-providers';

describe('Google Calendar compliance', () => {
  it('requests the owned-events scope and no broader Calendar scope', () => {
    const calendarScopes = OAUTH_PROVIDERS.google_calendar!.scopes.filter((scope) => scope.includes('/auth/calendar'));
    expect(calendarScopes).toEqual(['https://www.googleapis.com/auth/calendar.events.owned']);
  });

  it('calendar synchronization has no AI dependency', () => {
    const source = readFileSync(new URL('../../src/application/integrations/calendar-sync.service.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/deepseek|getAiProvider|resolveAi|\.complete\(/);
  });

  it('appointment create/update/cancel/delete logic has no AI dependency', () => {
    const source = readFileSync(new URL('../../src/application/appointments/appointments.service.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/deepseek|getAiProvider|resolveAi|\.complete\(/);
    expect(source).toContain('calendarSync.pushToGoogle');
    const sync = readFileSync(new URL('../../src/application/integrations/calendar-sync.service.ts', import.meta.url), 'utf8');
    expect(sync).toContain("method: 'POST'");
    expect(sync).toContain("method: 'PATCH'");
    expect(sync).toContain("method: 'DELETE'");
  });

  it('persists Google response provenance', () => {
    const source = readFileSync(new URL('../../src/application/integrations/calendar-sync.service.ts', import.meta.url), 'utf8');
    const migration = readFileSync(new URL('../../prisma/migrations/20260909120000_google_data_provenance/migration.sql', import.meta.url), 'utf8');
    expect(source).toContain("dataSource: 'GOOGLE_API_MIXED'");
    expect(migration).toContain("WHERE \"externalProvider\" = 'google_calendar'");
  });
});
