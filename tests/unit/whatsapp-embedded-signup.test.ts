import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  NoAuthorizationCodeError,
  parseWhatsAppSignupMessage,
  isPhoneOrTablet,
  whatsappLoginOptions,
} from '../../../web/src/features/settings/whatsappEmbeddedSignup';

const message = (origin: string, data: unknown) => ({ origin, data } as MessageEvent);

describe('WhatsApp Embedded Signup browser contract', () => {
  it('launches with code response and the Business App onboarding selector', () => {
    expect(whatsappLoginOptions('config-1')).toEqual({
      config_id: 'config-1', response_type: 'code', override_default_response_type: true,
      extras: { setup: {}, featureType: 'whatsapp_business_app_onboarding' },
    });
  });

  it('captures WABA, phone and business ids from FINISH', () => {
    expect(parseWhatsAppSignupMessage(message('https://www.facebook.com', JSON.stringify({
      type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH',
      data: { waba_id: 'waba-1', phone_number_id: 'phone-1', business_id: 'business-1' },
    })))).toEqual({ session: {
      wabaId: 'waba-1', phoneNumberId: 'phone-1', metaBusinessId: 'business-1',
      connectionMode: 'STANDARD_CLOUD_API',
    } });
  });

  it('rejects identical data from a non-Meta origin', () => {
    expect(parseWhatsAppSignupMessage(message('https://attacker.example', {
      type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH', data: { waba_id: 'waba-1' },
    }))).toBeNull();
  });

  it('handles cancel and provider error events without treating them as success', () => {
    expect(parseWhatsAppSignupMessage(message('https://web.facebook.com', {
      type: 'WA_EMBEDDED_SIGNUP', event: 'CANCEL', data: {},
    }))).toEqual({ error: 'WhatsApp connection was cancelled.' });
    expect(parseWhatsAppSignupMessage(message('https://www.facebook.com', {
      type: 'WA_EMBEDDED_SIGNUP', event: 'ERROR', data: { error_message: 'Not eligible' },
    }))).toEqual({ error: 'Not eligible' });
  });
});

/*
 * Embedded Signup on a phone.
 *
 * The JS-SDK popup is a desktop flow: on mobile the SDK defers to the native
 * Facebook app, which cannot run a config_id signup, so the window closed and
 * the business was told "WhatsApp connection was cancelled or Meta did not
 * return an authorization code" for a connection that never started. Phones
 * must take the redirect dialog instead.
 */
describe('phones and tablets are recognised', () => {
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
  const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36';
  const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

  it('spots a phone', () => {
    expect(isPhoneOrTablet(IPHONE, true)).toBe(true);
    expect(isPhoneOrTablet(ANDROID, true)).toBe(true);
  });

  it('catches an iPad, which reports a desktop user agent', () => {
    expect(isPhoneOrTablet(MAC, true)).toBe(true);
  });

  it('leaves laptops alone, where the signup already works', () => {
    expect(isPhoneOrTablet(MAC, false)).toBe(false);
  });
});

describe('signup messages from the mobile hosts are trusted', () => {
  it('accepts FINISH from m.facebook.com', () => {
    expect(parseWhatsAppSignupMessage({ origin: 'https://m.facebook.com', data: {
      type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH', data: { waba_id: 'waba-1', phone_number_id: 'phone-1' },
    } } as MessageEvent)).toEqual({ session: {
      wabaId: 'waba-1', phoneNumberId: 'phone-1', metaBusinessId: undefined,
      connectionMode: 'STANDARD_CLOUD_API',
    } });
  });

  it('accepts a cancel from business.facebook.com', () => {
    expect(parseWhatsAppSignupMessage({ origin: 'https://business.facebook.com', data: {
      type: 'WA_EMBEDDED_SIGNUP', event: 'CANCEL', data: {},
    } } as MessageEvent)).toEqual({ error: 'WhatsApp connection was cancelled.' });
  });
});

describe('a popup that returns nothing is recoverable', () => {
  it('is its own error type, so the caller can fall back rather than give up', () => {
    const error = new NoAuthorizationCodeError();
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('NoAuthorizationCodeError');
  });

  it('the settings page keeps the redirect dialog as its fallback', () => {
    const page = readFileSync(
      join(__dirname, '../../../web/src/features/settings/ChannelsSettingsPage.tsx'), 'utf8',
    );
    expect(page).toMatch(/NoAuthorizationCodeError/);
    expect(page).toMatch(/start\('redirect'\)/);
  });

  it('sends a phone that can finish through the redirect dialog, not the popup', () => {
    const page = readFileSync(
      join(__dirname, '../../../web/src/features/settings/ChannelsSettingsPage.tsx'), 'utf8',
    );
    expect(page).toMatch(/start\(type === 'WHATSAPP' && onPhoneOrTablet \? 'redirect' : undefined\)/);
  });

  /*
   * iOS can finish the signup in a different browser than the one that started
   * it. The callback is stateless so the connection lands, but the tab left
   * behind shows nothing until it refetches.
   */
  it('catches up on a connection completed out of sight', () => {
    const page = readFileSync(
      join(__dirname, '../../../web/src/features/settings/ChannelsSettingsPage.tsx'), 'utf8',
    );
    // Armed the moment the browser is sent to a provider, by either route.
    expect(page).toMatch(/setAwaitingProvider\(true\);/);
    expect(page).toMatch(/addEventListener\('focus', catchUp\)/);
    expect(page).toMatch(/invalidateQueries\(\{ queryKey: \['channels'\] \}\)/);
    // A tab we opened but never filled must not be left stranded.
    expect(page).toMatch(/providerTab\.current\?\.close\(\)/);
  });

  /*
   * Both mobile platforms claim facebook.com for the Facebook app, which does
   * not implement this signup: it opens, closes, and nothing happens. Nothing
   * in a web page can prevent that handoff, so a phone is told to use a
   * computer rather than given a button that cannot work.
   */
  /*
   * A tab opened in the click, then filled in later, is what makes mobile work
   * — proved in the field on Android, where pasting the same link into a new
   * tab completed a signup that the in-page navigation had been losing to the
   * Facebook app. Both halves matter: a tab asked for after the network round
   * trip is blocked as a popup, and a navigation still carrying the click's
   * activation is the one Android hands to the app.
   */
  it('opens the tab in the click itself, before anything is awaited', () => {
    const page = readFileSync(
      join(__dirname, '../../../web/src/features/settings/ChannelsSettingsPage.tsx'), 'utf8',
    );
    const opens = page.indexOf('const beginConnect');
    const begin = page.slice(opens, page.indexOf('\n  };', opens));
    expect(begin).toMatch(/window\.open\('about:blank', '_blank'\)/);
    expect(begin).not.toMatch(/await/);
    // And the dialog is driven into that held tab, not this one.
    expect(page).toMatch(/held\.location\.replace\(data\.url\)/);
  });

  it('routes every connect button through it, so none can slip back', () => {
    const page = readFileSync(
      join(__dirname, '../../../web/src/features/settings/ChannelsSettingsPage.tsx'), 'utf8',
    );
    expect(page.split('beginConnect(c.type)').length - 1).toBeGreaterThanOrEqual(3);
    // No button may call the mutation directly and bypass the tab.
    expect(page).not.toMatch(/onClick=\{\(\) => startOAuth\.mutate/);
    expect(page).not.toMatch(/\n\s*startOAuth\.mutate\(c\.type\);/);
  });

  it('nobody is asked to copy a link, and nobody is told to use a computer', () => {
    const page = readFileSync(
      join(__dirname, '../../../web/src/features/settings/ChannelsSettingsPage.tsx'), 'utf8',
    );
    expect(page).not.toMatch(/handoffUrl|setHandoff|Finish connecting WhatsApp on a computer/);
    expect(page).not.toMatch(/needsComputer|COMPUTER_ONLY_NOTE/);
  });

  it('hands the outcome back to the tab that asked, and closes', () => {
    const page = readFileSync(
      join(__dirname, '../../../web/src/features/settings/ChannelsSettingsPage.tsx'), 'utf8',
    );
    expect(page).toMatch(/window\.opener\.postMessage\(/);
    expect(page).toMatch(/if \(handedBack\) window\.close\(\);/);
    // Reported locally first: a refused close must not leave a blank tab.
    const effect = page.slice(page.indexOf('let handedBack'), page.indexOf('if (handedBack)'));
    expect(effect).toMatch(/showConnectOutcome\(params\)/);
    // And only this origin's messages are believed.
    expect(page).toMatch(/if \(event\.origin !== window\.location\.origin\) return;/);
  });

  it('the server honours a redirect-flow request instead of forcing the popup', () => {
    const route = readFileSync(
      join(__dirname, '../../src/presentation/http/v1/inbox.routes.ts'), 'utf8',
    );
    expect(route).toMatch(/wantsRedirect/);
    expect(route).toMatch(/whatsappConfigId && !wantsRedirect/);
  });
});
