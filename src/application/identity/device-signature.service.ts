import { createPublicKey, createVerify, randomBytes, verify as cryptoVerify } from 'crypto';
import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { AppError, ForbiddenError } from '../../shared/errors';
import { logger } from '../../shared/logger';

/**
 * Device-bound payment authorisation (Flutter Bible §14/§16, API Bible §18).
 *
 * A registered device holds a private key in its secure enclave / keystore and
 * registers only the public half. To confirm a payment it signs
 * `sessionToken.nonce.amount.currency` — proving the confirmation came from
 * that physical device and not a replayed API call.
 *
 * The nonce is server-issued, single-use and short-lived, so a captured
 * signature is worthless the moment it has been redeemed.
 */

const NONCE_TTL_MS = 5 * 60 * 1000;

/** Canonical bytes the device must sign. Order is part of the contract. */
export function signaturePayload(parts: {
  sessionToken: string;
  nonce: string;
  amount: string;
  currency: string;
}): string {
  return `${parts.sessionToken}.${parts.nonce}.${parts.amount}.${parts.currency}`;
}

/**
 * Verify a base64 signature against a registered public key. Accepts both
 * Ed25519 and ECDSA P-256 SPKI keys (base64 DER or PEM) — the two things
 * Android Keystore and iOS Secure Enclave realistically produce.
 */
/** DER prefix that turns a raw 32-byte Ed25519 key into an SPKI key. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function verifySignature(publicKeyRaw: string, message: string, signatureB64: string): boolean {
  try {
    let key;
    if (publicKeyRaw.includes('BEGIN')) {
      key = createPublicKey(publicKeyRaw);
    } else {
      const der = Buffer.from(publicKeyRaw.replace(/\s+/g, ''), 'base64');
      // Mobile crypto libraries hand back the bare 32-byte Ed25519 point; Node
      // needs SPKI, so wrap it. Anything longer is already DER-encoded.
      const spki = der.length === 32 ? Buffer.concat([ED25519_SPKI_PREFIX, der]) : der;
      key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    }
    const signature = Buffer.from(signatureB64, 'base64');
    const data = Buffer.from(message, 'utf8');

    if (key.asymmetricKeyType === 'ed25519') {
      return cryptoVerify(null, data, key, signature);
    }
    // ECDSA / RSA — SHA-256 digest.
    const verifier = createVerify('SHA256');
    verifier.update(data);
    verifier.end();
    return verifier.verify(key, signature);
  } catch (err) {
    logger.warn({ err }, 'device signature verification error');
    return false;
  }
}

export const deviceSignatureService = {
  signaturePayload,

  /** Issue a single-use challenge for an upcoming payment confirmation. */
  async issueNonce(vhicasarId: string, deviceId: string, sessionId?: string) {
    const nonce = randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + NONCE_TTL_MS);
    await prismaUnscoped.paymentNonce.create({
      data: { vhicasarId, deviceId, nonce, sessionId: sessionId ?? null, expiresAt },
    });
    return { nonce, expiresAt };
  },

  /**
   * Consume a nonce. Atomic: the update only matches an unused, unexpired row,
   * so two concurrent confirmations can never both redeem it.
   */
  async consumeNonce(vhicasarId: string, nonce: string): Promise<boolean> {
    const claimed = await prismaUnscoped.paymentNonce.updateMany({
      where: { vhicasarId, nonce, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    return claimed.count === 1;
  },

  /**
   * Enforce the device-signature policy for a payment confirmation.
   *
   * A device that registered a public key is *capable* of signing, so it must
   * sign — otherwise an attacker could downgrade to PIN-only by simply omitting
   * the signature. Devices with no registered key fall back to PIN (the fraud
   * engine already penalises unknown devices).
   */
  async requireForPayment(params: {
    vhicasarId: string;
    deviceId?: string | null;
    sessionToken: string;
    amount: string;
    currency: string;
    nonce?: string;
    signature?: string;
  }): Promise<{ verified: boolean; reason?: string }> {
    const { vhicasarId, deviceId, sessionToken, amount, currency, nonce, signature } = params;
    if (!deviceId) return { verified: false, reason: 'NO_DEVICE' };

    const device = await prismaUnscoped.device.findUnique({
      where: { vhicasarId_deviceId: { vhicasarId, deviceId } },
      select: { publicKey: true, revokedAt: true },
    });
    if (!device) return { verified: false, reason: 'DEVICE_NOT_REGISTERED' };
    if (device.revokedAt) throw new ForbiddenError('This device has been revoked');
    if (!device.publicKey) return { verified: false, reason: 'DEVICE_HAS_NO_KEY' };

    // Capable device ⇒ signature is mandatory. Refuse the silent downgrade.
    if (!signature || !nonce) {
      throw new AppError(
        'DEVICE_SIGNATURE_REQUIRED',
        403,
        'This device must confirm the payment with its secure key.'
      );
    }
    const fresh = await this.consumeNonce(vhicasarId, nonce);
    if (!fresh) {
      throw new AppError('NONCE_INVALID', 403, 'Authorisation challenge expired or already used.');
    }
    const message = signaturePayload({ sessionToken, nonce, amount, currency });
    if (!verifySignature(device.publicKey, message, signature)) {
      throw new ForbiddenError('Device signature verification failed');
    }
    return { verified: true };
  },

  /** Housekeeping: drop spent/expired challenges. */
  async purgeExpiredNonces(): Promise<number> {
    const { count } = await prismaUnscoped.paymentNonce.deleteMany({
      where: { OR: [{ expiresAt: { lt: new Date() } }, { usedAt: { not: null } }] },
    });
    return count;
  },
};
