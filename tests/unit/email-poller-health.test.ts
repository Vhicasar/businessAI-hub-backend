import { describe, expect, it } from 'vitest';
import {
  classifyProviderError,
  friendlyMessage,
} from '../../src/application/inbox/channel-health.service';
import { __testing as poller } from '../../src/infrastructure/channels/email.poller';

/**
 * The server was logging "Email poll failed for account" every 60 seconds —
 * 3 NO [AUTHENTICATIONFAILED] Invalid credentials — while the channel kept
 * showing as connected and nobody was told. These guard the three parts of
 * that fix: the failure is classified as fatal, the message names the real
 * remedy, and the retry slows down instead of hammering the mail server.
 */
const IMAP_REJECTION = 'Invalid credentials (Failure)';

describe('email poll failures are recognised', () => {
  it('treats a rejected mailbox login as a hard error, not a blip', () => {
    expect(classifyProviderError(IMAP_REJECTION)).toBe('ERROR');
  });

  it('detects the ImapFlow authentication failure shape', () => {
    const err = Object.assign(new Error('Command failed'), {
      response: '3 NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)',
      responseStatus: 'NO',
      responseText: 'Invalid credentials (Failure)',
      serverResponseCode: 'AUTHENTICATIONFAILED',
      authenticationFailed: true,
    });
    expect(poller.isAuthFailure(err)).toBe(true);
    // The log should carry the server's sentence, not "Command failed".
    expect(poller.describeError(err)).toBe('Invalid credentials (Failure)');
  });

  it('does not mistake a dropped connection for bad credentials', () => {
    expect(poller.isAuthFailure(Object.assign(new Error('read ECONNRESET')))).toBe(false);
    expect(poller.isAuthFailure(new Error('connect ETIMEDOUT'))).toBe(false);
  });
});

describe('the message tells the business what to do', () => {
  it('names the app password, which is the usual cause', () => {
    const message = friendlyMessage('EMAIL', 'ERROR', IMAP_REJECTION);
    expect(message).toMatch(/app password/i);
    expect(message).toMatch(/username and password/i);
    // Never the provider's own words.
    expect(message).not.toMatch(/AUTHENTICATIONFAILED|NO \[/);
  });

  it('leaves other channels and other failures on the generic sentence', () => {
    expect(friendlyMessage('WHATSAPP', 'ERROR', IMAP_REJECTION)).toMatch(/not working right now/);
    expect(friendlyMessage('EMAIL', 'ERROR', 'mailbox INBOX does not exist')).toMatch(/not working right now/);
  });
});

describe('a doomed login is not retried every minute', () => {
  it('waits a quarter of an hour, then longer, after a refused password', () => {
    expect(poller.backoffFor(1, true)).toBe(15 * 60_000);
    expect(poller.backoffFor(2, true)).toBe(60 * 60_000);
    expect(poller.backoffFor(3, true)).toBe(6 * 60 * 60_000);
    // It settles rather than growing without bound.
    expect(poller.backoffFor(50, true)).toBe(6 * 60 * 60_000);
  });

  it('retries a transient failure immediately and only then slows down', () => {
    expect(poller.backoffFor(1, false)).toBe(0);
    expect(poller.backoffFor(2, false)).toBe(5 * 60_000);
    expect(poller.backoffFor(4, false)).toBe(60 * 60_000);
    expect(poller.backoffFor(99, false)).toBe(60 * 60_000);
  });
});
