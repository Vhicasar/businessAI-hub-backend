import { describe, expect, it } from 'vitest';
import {
  decrypt,
  encrypt,
  generateOpaqueToken,
  hashPassword,
  sha256,
  verifyPassword,
} from '../../src/shared/crypto';

describe('crypto', () => {
  it('encrypt/decrypt roundtrips arbitrary strings', () => {
    const samples = ['hello', '', '🔐 unicode ✓', JSON.stringify({ botToken: '123:AAF' })];
    for (const s of samples) {
      expect(decrypt(encrypt(s))).toBe(s);
    }
  });

  it('produces a different ciphertext per call (random IV)', () => {
    expect(encrypt('same')).not.toBe(encrypt('same'));
  });

  it('rejects tampered ciphertext (GCM auth tag)', () => {
    const payload = encrypt('secret');
    const [iv, tag, data] = payload.split('.');
    const flipped = data!.slice(0, -2) + (data!.endsWith('AA') ? 'BB' : 'AA');
    expect(() => decrypt(`${iv}.${tag}.${flipped}`)).toThrow();
  });

  it('sha256 is deterministic and hex-shaped', () => {
    expect(sha256('token')).toBe(sha256('token'));
    expect(sha256('token')).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256('token')).not.toBe(sha256('token2'));
  });

  it('opaque tokens are unique and url-safe', () => {
    const a = generateOpaqueToken();
    const b = generateOpaqueToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('argon2 hash verifies the right password and rejects the wrong one', async () => {
    const hash = await hashPassword('Sup3rSecret42');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(hash, 'Sup3rSecret42')).toBe(true);
    expect(await verifyPassword(hash, 'wrong-password')).toBe(false);
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
  });
});
