import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const backendSource = (path: string) => readFileSync(resolve(process.cwd(), 'src', path), 'utf8');
const webSource = (path: string) => readFileSync(resolve(process.cwd(), '..', 'web', 'src', path), 'utf8');

describe('channel lifecycle UX regression guards', () => {
  it('marks completed automatic WhatsApp setup connected without waiting for traffic', () => {
    const oauthRoute = backendSource('presentation/http/channel-oauth.routes.ts');
    const inboxRoute = backendSource('presentation/http/v1/inbox.routes.ts');
    expect(oauthRoute).toContain('await markChannelConnected(account.id)');
    expect(oauthRoute).not.toContain('connect=setup');
    expect(inboxRoute).toContain("status: 'CONNECTED'");
    expect(inboxRoute).not.toContain('markChannelAwaitingWebhook');
  });

  it('keeps real setup failure handling in both OAuth completion paths', () => {
    const oauthRoute = backendSource('presentation/http/channel-oauth.routes.ts');
    const inboxRoute = backendSource('presentation/http/v1/inbox.routes.ts');
    expect(oauthRoute).toContain('markChannelSetupFailed');
    expect(inboxRoute).toContain('markChannelSetupFailed');
  });

  it('has no user-facing manual channel diagnostic endpoint or control', () => {
    expect(backendSource('presentation/http/v1/inbox.routes.ts')).not.toContain("'/channels/:id/diagnostic'");
    expect(backendSource('application/inbox/channels.service.ts')).not.toContain('async diagnose(');
    expect(webSource('features/settings/ChannelsSettingsPage.tsx')).not.toMatch(/Run diagnostics?/i);
  });

  it('uses messaging terminology only for the send mutation', () => {
    const inbox = webSource('features/inbox/InboxPage.tsx');
    expect(inbox).toContain("meta: { success: 'Message sent' }");
    expect(webSource('App.tsx')).toContain("meta?.success ?? 'Saved'");
  });
});
