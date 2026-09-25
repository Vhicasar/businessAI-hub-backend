import { describe, expect, it } from 'vitest';
import { parseWhatsAppSignupMessage, whatsappLoginOptions } from '../../../web/src/features/settings/whatsappEmbeddedSignup';

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
