import jwt, { JwtPayload, SignOptions } from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { env } from '../../shared/config/env';
import { UnauthorizedError } from '../../shared/errors';
import { generateOpaqueToken, sha256 } from '../../shared/crypto';
import { prismaUnscoped } from '../../infrastructure/database/prisma';

/**
 * Tokens for the Customer Super App. Distinct from the business (User) access
 * tokens: the subject is a VhicasarId and the token carries `scope: 'app'`, so
 * the two auth surfaces can never be confused.
 *
 * Refresh tokens are opaque, stored hashed, and rotated on every use. Presenting
 * an already-rotated token burns the whole family — a stolen token can be used
 * at most once before the real device's next refresh revokes the session
 * (API Bible §18 replay prevention).
 */
export interface AppTokenPayload {
  sub: string; // VhicasarId
  scope: 'app';
  did?: string; // device id (present once a device is registered)
}

const signOpts: SignOptions = { algorithm: env.jwt.alg };

export const identityTokenService = {
  signAppToken(vhicasarId: string, deviceId?: string): string {
    const payload: AppTokenPayload = { sub: vhicasarId, scope: 'app', did: deviceId };
    return jwt.sign(payload as object, env.jwt.signKey, {
      ...signOpts,
      expiresIn: env.jwt.accessTtl as SignOptions['expiresIn'],
      jwtid: randomUUID(),
    });
  },

  verifyAppToken(token: string): AppTokenPayload & JwtPayload {
    try {
      const decoded = jwt.verify(token, env.jwt.verifyKey, {
        algorithms: [env.jwt.alg],
      }) as AppTokenPayload & JwtPayload;
      if (decoded.scope !== 'app' || !decoded.sub) {
        throw new UnauthorizedError('Invalid app token');
      }
      return decoded;
    } catch (e) {
      if (e instanceof UnauthorizedError) throw e;
      if (e instanceof jwt.TokenExpiredError) {
        throw new UnauthorizedError('Access token expired', 'TOKEN_EXPIRED');
      }
      throw new UnauthorizedError('Invalid access token');
    }
  },

  // ---- Refresh tokens: opaque, rotated, family reuse-detection ----

  async issueRefreshToken(
    vhicasarId: string,
    familyId: string | null,
    meta: { userAgent?: string; ipAddress?: string; deviceId?: string }
  ): Promise<{ raw: string; familyId: string }> {
    const raw = generateOpaqueToken();
    const family = familyId ?? randomUUID();
    const expiresAt = new Date(Date.now() + env.jwt.refreshTtlDays * 24 * 60 * 60 * 1000);
    await prismaUnscoped.appRefreshToken.create({
      data: {
        vhicasarId,
        tokenHash: sha256(raw),
        familyId: family,
        deviceId: meta.deviceId ?? null,
        userAgent: meta.userAgent?.slice(0, 255),
        ipAddress: meta.ipAddress?.slice(0, 64),
        expiresAt,
      },
    });
    return { raw, familyId: family };
  },

  /** Issue a full session (access + refresh) for a Vhicasar ID. */
  async issueSession(
    vhicasarId: string,
    meta: { userAgent?: string; ipAddress?: string; deviceId?: string } = {}
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: string }> {
    const accessToken = this.signAppToken(vhicasarId, meta.deviceId);
    const { raw } = await this.issueRefreshToken(vhicasarId, null, meta);
    return { accessToken, refreshToken: raw, expiresIn: String(env.jwt.accessTtl) };
  },

  /**
   * Rotate: validate the presented token, revoke it, issue a replacement in the
   * same family. Presenting an already-revoked token burns the whole family.
   */
  async rotateRefreshToken(
    raw: string,
    meta: { userAgent?: string; ipAddress?: string }
  ): Promise<{ vhicasarId: string; accessToken: string; refreshToken: string }> {
    const record = await prismaUnscoped.appRefreshToken.findUnique({ where: { tokenHash: sha256(raw) } });
    if (!record) throw new UnauthorizedError('Invalid refresh token', 'REFRESH_INVALID');

    if (record.revokedAt) {
      await prismaUnscoped.appRefreshToken.updateMany({
        where: { familyId: record.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedError('Refresh token reuse detected — session revoked', 'REFRESH_REUSED');
    }
    if (record.expiresAt < new Date()) {
      throw new UnauthorizedError('Refresh token expired', 'REFRESH_EXPIRED');
    }

    // The identity must still be usable, or the session ends here.
    const identity = await prismaUnscoped.vhicasarId.findUnique({
      where: { id: record.vhicasarId },
      select: { status: true, deletedAt: true },
    });
    if (!identity || identity.deletedAt || identity.status !== 'ACTIVE') {
      await prismaUnscoped.appRefreshToken.updateMany({
        where: { familyId: record.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedError('Account is not active', 'ACCOUNT_INACTIVE');
    }

    const { raw: newRaw } = await this.issueRefreshToken(record.vhicasarId, record.familyId, {
      ...meta,
      deviceId: record.deviceId ?? undefined,
    });
    await prismaUnscoped.appRefreshToken.update({
      where: { id: record.id },
      data: { revokedAt: new Date(), replacedBy: sha256(newRaw).slice(0, 16) },
    });

    return {
      vhicasarId: record.vhicasarId,
      accessToken: this.signAppToken(record.vhicasarId, record.deviceId ?? undefined),
      refreshToken: newRaw,
    };
  },

  /** Logout — idempotent: an unknown token is already "logged out". */
  async revokeFamilyByToken(raw: string): Promise<void> {
    const record = await prismaUnscoped.appRefreshToken.findUnique({ where: { tokenHash: sha256(raw) } });
    if (!record) return;
    await prismaUnscoped.appRefreshToken.updateMany({
      where: { familyId: record.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  },

  /** Revoke every session for an identity (device revoked, PIN reset, fraud). */
  async revokeAllForIdentity(vhicasarId: string): Promise<void> {
    await prismaUnscoped.appRefreshToken.updateMany({
      where: { vhicasarId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  },
};
