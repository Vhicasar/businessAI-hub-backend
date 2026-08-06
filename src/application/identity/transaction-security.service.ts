import { Prisma } from '@prisma/client';
import type { TransactionAuthMode } from '@prisma/client';

import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { hashPassword, verifyPassword, sha256, generateOpaqueToken } from '../../shared/crypto';
import { AppError, NotFoundError, UnauthorizedError, ValidationError } from '../../shared/errors';
import { logger } from '../../shared/logger';

/**
 * Platform policy for transaction PINs (§1). Deliberately data, not scattered
 * literals, so a single place decides how strict the platform is.
 */
export const PIN_POLICY = {
  minLength: 4,
  maxLength: 8,
  /** Consecutive failures before the PIN locks. */
  maxAttempts: 5,
  lockoutMinutes: 15,
  /** Whether a customer may turn the PIN off entirely. */
  allowDisable: false,
  /** Default step-up threshold when the customer hasn't set one. */
  defaultHighValueThreshold: new Prisma.Decimal('50000'),
  resetTokenMinutes: 10,
} as const;

/**
 * Actions that can require a transaction PIN. Each one says whether the PIN is
 * unconditional or only under adaptive rules, because "send money out of the
 * platform" and "pay a merchant on your own phone" are not the same risk.
 */
export const PIN_ACTIONS = {
  WALLET_PAYMENT: { alwaysRequired: false },
  WALLET_WITHDRAWAL: { alwaysRequired: true },
  WALLET_TRANSFER: { alwaysRequired: true },
  LOCKED_WALLET_USE: { alwaysRequired: true },
  REWARD_TRANSFER: { alwaysRequired: true },
  SENSITIVE_ACCOUNT_CHANGE: { alwaysRequired: true },
} as const;

export type PinAction = keyof typeof PIN_ACTIONS;

export interface AuthorizeInput {
  vhicasarId: string;
  action: PinAction;
  /** Transaction amount, when the action moves money. */
  amount?: Prisma.Decimal | string | number;
  /** The device making the request — an unknown device always steps up. */
  deviceId?: string;
  pin?: string;
  /** The client asserts a successful local biometric check. */
  biometricAsserted?: boolean;
  ip?: string;
}

export interface AuthorizeResult {
  ok: true;
  /** What actually satisfied the check, for the audit trail. */
  satisfiedBy: 'PIN' | 'BIOMETRIC' | 'PIN_AND_BIOMETRIC' | 'TRUSTED_DEVICE';
}

async function record(vhicasarId: string) {
  return prismaUnscoped.transactionSecurity.upsert({
    where: { vhicasarId },
    create: { vhicasarId },
    update: {},
  });
}

function assertPinShape(pin: string) {
  if (!/^\d+$/.test(pin)) throw new ValidationError('Your PIN must be digits only');
  if (pin.length < PIN_POLICY.minLength || pin.length > PIN_POLICY.maxLength) {
    throw new ValidationError(
      `Your PIN must be between ${PIN_POLICY.minLength} and ${PIN_POLICY.maxLength} digits`
    );
  }
  // A PIN that is all one digit or a straight run is barely a PIN at all.
  if (/^(\d)\1+$/.test(pin)) throw new ValidationError('Choose a PIN that is not all the same digit');
  const ascending = '0123456789';
  const descending = '9876543210';
  if (ascending.includes(pin) || descending.includes(pin)) {
    throw new ValidationError('Choose a PIN that is not a simple sequence');
  }
}

export const transactionSecurity = {
  PIN_POLICY,

  /** What the Settings → Security screen renders. Never leaks the hash. */
  async status(vhicasarId: string) {
    const row = await record(vhicasarId);
    const lockedUntil = row.lockedUntil && row.lockedUntil > new Date() ? row.lockedUntil : null;
    return {
      hasPin: Boolean(row.pinHash),
      pinLength: row.pinLength,
      authMode: row.authMode,
      isBiometricEnabled: row.isBiometricEnabled,
      isLocked: Boolean(lockedUntil),
      lockedUntil,
      /** Attempts left before a lockout, so the app can warn before the last one. */
      attemptsRemaining: Math.max(0, PIN_POLICY.maxAttempts - row.failedAttempts),
      highValueThreshold: (row.highValueThreshold ?? PIN_POLICY.defaultHighValueThreshold).toFixed(2),
      trustedDeviceCount: row.trustedDeviceIds.length,
      pinUpdatedAt: row.pinUpdatedAt,
      policy: {
        minLength: PIN_POLICY.minLength,
        maxLength: PIN_POLICY.maxLength,
        maxAttempts: PIN_POLICY.maxAttempts,
        lockoutMinutes: PIN_POLICY.lockoutMinutes,
        canDisable: PIN_POLICY.allowDisable,
      },
    };
  },

  /**
   * Create a PIN, or change an existing one.
   *
   * Changing requires the current PIN: without that, anyone holding an unlocked
   * handset could quietly replace it and drain the wallet.
   */
  async setPin(
    vhicasarId: string,
    input: { pin: string; currentPin?: string; deviceId?: string }
  ): Promise<{ created: boolean }> {
    assertPinShape(input.pin);
    const row = await record(vhicasarId);

    if (row.pinHash) {
      if (!input.currentPin) throw new ValidationError('Enter your current PIN to change it');
      const ok = await verifyPassword(row.pinHash, input.currentPin);
      if (!ok) {
        await this.registerFailure(vhicasarId);
        throw new UnauthorizedError('That PIN is not correct', 'PIN_INCORRECT');
      }
      if (input.currentPin === input.pin) {
        throw new ValidationError('Choose a PIN you have not just used');
      }
    }

    await prismaUnscoped.transactionSecurity.update({
      where: { vhicasarId },
      data: {
        pinHash: await hashPassword(input.pin),
        pinLength: input.pin.length,
        pinUpdatedAt: new Date(),
        failedAttempts: 0,
        lockedUntil: null,
        ...(input.deviceId ? { trustedDeviceIds: { push: input.deviceId } } : {}),
      },
    });

    return { created: !row.pinHash };
  },

  /**
   * Start a forgotten-PIN recovery. Returns the raw token only when the caller
   * is expected to deliver it out of band (SMS/email); it is never stored.
   */
  async requestReset(
    vhicasarId: string,
    method: 'PHONE_OTP' | 'EMAIL_OTP' | 'KYC'
  ): Promise<{ token: string; expiresAt: Date }> {
    const identity = await prismaUnscoped.vhicasarId.findUnique({
      where: { id: vhicasarId },
      select: { phoneVerifiedAt: true, emailVerifiedAt: true, kycLevel: true },
    });
    if (!identity) throw new NotFoundError('Identity');

    // Recovery must be anchored to something already proven — otherwise it is
    // just a second, weaker way in.
    if (method === 'PHONE_OTP' && !identity.phoneVerifiedAt) {
      throw new ValidationError('Verify your phone number before resetting your PIN');
    }
    if (method === 'EMAIL_OTP' && !identity.emailVerifiedAt) {
      throw new ValidationError('Verify your email address before resetting your PIN');
    }
    if (method === 'KYC' && identity.kycLevel === 'NONE') {
      throw new ValidationError('Complete identity verification before resetting your PIN');
    }

    // Only one live reset at a time.
    await prismaUnscoped.pinResetToken.deleteMany({ where: { vhicasarId, usedAt: null } });

    const token = generateOpaqueToken(24);
    const expiresAt = new Date(Date.now() + PIN_POLICY.resetTokenMinutes * 60_000);
    await prismaUnscoped.pinResetToken.create({
      data: { vhicasarId, tokenHash: sha256(token), method, expiresAt },
    });
    return { token, expiresAt };
  },

  /** Consume a reset token and set a new PIN. Clears any lockout. */
  async resetPin(vhicasarId: string, input: { token: string; pin: string }): Promise<void> {
    assertPinShape(input.pin);
    const row = await prismaUnscoped.pinResetToken.findUnique({
      where: { tokenHash: sha256(input.token) },
    });
    if (!row || row.vhicasarId !== vhicasarId || row.usedAt || row.expiresAt < new Date()) {
      throw new UnauthorizedError('That reset link is no longer valid', 'RESET_TOKEN_INVALID');
    }

    await prismaUnscoped.$transaction([
      prismaUnscoped.pinResetToken.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
      prismaUnscoped.transactionSecurity.upsert({
        where: { vhicasarId },
        create: {
          vhicasarId,
          pinHash: await hashPassword(input.pin),
          pinLength: input.pin.length,
          pinUpdatedAt: new Date(),
        },
        update: {
          pinHash: await hashPassword(input.pin),
          pinLength: input.pin.length,
          pinUpdatedAt: new Date(),
          failedAttempts: 0,
          lockedUntil: null,
        },
      }),
    ]);
  },

  /** Remove the PIN entirely — only where platform policy allows it. */
  async disablePin(vhicasarId: string, currentPin: string): Promise<void> {
    if (!PIN_POLICY.allowDisable) {
      throw new AppError(
        'PIN_REQUIRED_BY_POLICY',
        403,
        'A transaction PIN is required on this platform and cannot be turned off'
      );
    }
    const row = await record(vhicasarId);
    if (!row.pinHash) return;
    if (!(await verifyPassword(row.pinHash, currentPin))) {
      await this.registerFailure(vhicasarId);
      throw new UnauthorizedError('That PIN is not correct', 'PIN_INCORRECT');
    }
    await prismaUnscoped.transactionSecurity.update({
      where: { vhicasarId },
      data: { pinHash: null, pinLength: null, authMode: 'BIOMETRIC_ONLY' },
    });
  },

  async updateSettings(
    vhicasarId: string,
    input: {
      authMode?: TransactionAuthMode;
      isBiometricEnabled?: boolean;
      highValueThreshold?: string | number;
    }
  ) {
    const row = await record(vhicasarId);

    // Biometric-only with no biometric enrolled would lock the customer out of
    // their own money, so the combination is refused rather than saved.
    if (input.authMode === 'BIOMETRIC_ONLY' && input.isBiometricEnabled === false) {
      throw new ValidationError('Enable biometrics before choosing biometric-only');
    }
    if (input.authMode === 'BIOMETRIC_ONLY' && !input.isBiometricEnabled && !row.isBiometricEnabled) {
      throw new ValidationError('Enable biometrics before choosing biometric-only');
    }
    if ((input.authMode === 'PIN_ONLY' || input.authMode === 'PIN_AND_BIOMETRIC') && !row.pinHash) {
      throw new ValidationError('Create a transaction PIN first');
    }

    return prismaUnscoped.transactionSecurity.update({
      where: { vhicasarId },
      data: {
        ...(input.authMode ? { authMode: input.authMode } : {}),
        ...(input.isBiometricEnabled !== undefined ? { isBiometricEnabled: input.isBiometricEnabled } : {}),
        ...(input.highValueThreshold !== undefined
          ? { highValueThreshold: new Prisma.Decimal(String(input.highValueThreshold)) }
          : {}),
      },
    });
  },

  /** Remember a device so adaptive auth can stop stepping up on it. */
  async trustDevice(vhicasarId: string, deviceId: string) {
    const row = await record(vhicasarId);
    if (row.trustedDeviceIds.includes(deviceId)) return;
    await prismaUnscoped.transactionSecurity.update({
      where: { vhicasarId },
      data: { trustedDeviceIds: { push: deviceId } },
    });
  },

  async forgetDevice(vhicasarId: string, deviceId: string) {
    const row = await record(vhicasarId);
    await prismaUnscoped.transactionSecurity.update({
      where: { vhicasarId },
      data: { trustedDeviceIds: row.trustedDeviceIds.filter((d) => d !== deviceId) },
    });
  },

  /** Count a wrong PIN, locking the account once the threshold is crossed. */
  async registerFailure(vhicasarId: string): Promise<void> {
    const row = await record(vhicasarId);
    const failedAttempts = row.failedAttempts + 1;
    const locked = failedAttempts >= PIN_POLICY.maxAttempts;
    await prismaUnscoped.transactionSecurity.update({
      where: { vhicasarId },
      data: {
        failedAttempts,
        lockedUntil: locked ? new Date(Date.now() + PIN_POLICY.lockoutMinutes * 60_000) : row.lockedUntil,
      },
    });
    if (locked) {
      logger.warn({ vhicasarId, failedAttempts }, 'Transaction PIN locked after repeated failures');
    }
  },

  /**
   * The single gate every sensitive action goes through (§1).
   *
   * Decides what proof this particular action needs — mode, action risk, amount
   * and whether the device is known — then checks it. Callers never re-implement
   * the policy, so it cannot drift between payments, withdrawals and transfers.
   */
  async authorize(input: AuthorizeInput): Promise<AuthorizeResult> {
    const row = await record(input.vhicasarId);

    if (row.lockedUntil && row.lockedUntil > new Date()) {
      const minutes = Math.ceil((row.lockedUntil.getTime() - Date.now()) / 60_000);
      throw new AppError(
        'PIN_LOCKED',
        423,
        `Too many incorrect PIN attempts. Try again in ${minutes} minute(s).`,
        { lockedUntil: row.lockedUntil }
      );
    }

    const amount = input.amount === undefined ? null : new Prisma.Decimal(String(input.amount));
    const threshold = row.highValueThreshold ?? PIN_POLICY.defaultHighValueThreshold;
    const isHighValue = amount !== null && amount.greaterThanOrEqualTo(threshold);
    const deviceTrusted = Boolean(input.deviceId && row.trustedDeviceIds.includes(input.deviceId));
    const actionAlwaysNeedsPin = PIN_ACTIONS[input.action].alwaysRequired;

    let needsPin: boolean;
    let needsBiometric: boolean;
    switch (row.authMode) {
      case 'PIN_ONLY':
        needsPin = true;
        needsBiometric = false;
        break;
      case 'BIOMETRIC_ONLY':
        // Even here, moving money off-platform or a very large payment still
        // asks for the PIN when one exists — biometrics alone are a device
        // check, not proof of intent for irreversible transfers.
        needsPin = Boolean(row.pinHash) && (actionAlwaysNeedsPin || isHighValue);
        needsBiometric = true;
        break;
      case 'PIN_AND_BIOMETRIC':
        needsPin = true;
        needsBiometric = true;
        break;
      case 'ADAPTIVE':
      default:
        needsPin = actionAlwaysNeedsPin || isHighValue || !deviceTrusted;
        needsBiometric = row.isBiometricEnabled && !needsPin;
        break;
    }

    if (needsPin && !row.pinHash) {
      throw new AppError(
        'PIN_NOT_SET',
        428,
        'Set up your transaction PIN in Settings → Security before continuing',
        { action: input.action }
      );
    }

    if (needsPin) {
      if (!input.pin) {
        throw new AppError('PIN_REQUIRED', 401, 'Enter your transaction PIN to continue', {
          action: input.action,
          reason: actionAlwaysNeedsPin ? 'ACTION' : isHighValue ? 'HIGH_VALUE' : 'UNKNOWN_DEVICE',
        });
      }
      const ok = await verifyPassword(row.pinHash!, input.pin);
      if (!ok) {
        await this.registerFailure(input.vhicasarId);
        throw new UnauthorizedError('That PIN is not correct', 'PIN_INCORRECT');
      }
    }

    if (needsBiometric && !input.biometricAsserted) {
      throw new AppError('BIOMETRIC_REQUIRED', 401, 'Confirm with biometrics to continue', {
        action: input.action,
      });
    }

    // A successful check clears the failure streak — that is the whole point of
    // counting *consecutive* failures.
    if (row.failedAttempts > 0) {
      await prismaUnscoped.transactionSecurity.update({
        where: { vhicasarId: input.vhicasarId },
        data: { failedAttempts: 0, lockedUntil: null },
      });
    }

    const satisfiedBy: AuthorizeResult['satisfiedBy'] =
      needsPin && needsBiometric
        ? 'PIN_AND_BIOMETRIC'
        : needsPin
          ? 'PIN'
          : needsBiometric
            ? 'BIOMETRIC'
            : 'TRUSTED_DEVICE';
    return { ok: true, satisfiedBy };
  },
};
