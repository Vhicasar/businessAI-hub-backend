import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  NoAuthorizationCodeError,
  parseWhatsAppSignupMessage,
  prefersRedirectSignup,
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
describe('mobile browsers take the redirect dialog', () => {
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
  const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36';
  const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

  it('sends phones down the redirect path', () => {
    expect(prefersRedirectSignup(IPHONE, true)).toBe(true);
    expect(prefersRedirectSignup(ANDROID, true)).toBe(true);
  });

  it('catches an iPad, which reports a desktop user agent', () => {
    expect(prefersRedirectSignup(MAC, true)).toBe(true);
  });

  it('leaves laptops on the popup flow that already works there', () => {
    expect(prefersRedirectSignup(MAC, false)).toBe(false);
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

  it('the settings page asks for the redirect flow, up front and as a fallback', () => {
    const page = readFileSync(
      join(__dirname, '../../../web/src/features/settings/ChannelsSettingsPage.tsx'), 'utf8',
    );
    expect(page).toMatch(/browserPrefersRedirectSignup\(\)/);
    expect(page).toMatch(/NoAuthorizationCodeError/);
    expect(page).toMatch(/start\('redirect'\)/);
  });

  it('the server honours a redirect-flow request instead of forcing the popup', () => {
    const route = readFileSync(
      join(__dirname, '../../src/presentation/http/v1/inbox.routes.ts'), 'utf8',
    );
    expect(route).toMatch(/wantsRedirect/);
    expect(route).toMatch(/whatsappConfigId && !wantsRedirect/);
  });
});
