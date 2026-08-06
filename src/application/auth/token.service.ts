import jwt, { JwtPayload, SignOptions } from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { env } from '../../shared/config/env';
import { UnauthorizedError } from '../../shared/errors';
import { generateOpaqueToken, sha256 } from '../../shared/crypto';
import { prisma } from '../../infrastructure/database/prisma';

export interface AccessTokenPayload {
  sub: string; // userId
  org: string | null;
  mem: string | null; // membershipId
  role: string | null;
  sa: boolean; // isSuperAdmin
}

export interface MfaTokenPayload {
  sub: string;
  scope: 'mfa';
}

const signOpts: SignOptions = { algorithm: env.jwt.alg };

export const tokenService = {
  signAccessToken(payload: AccessTokenPayload): string {
    return jwt.sign(payload as object, env.jwt.signKey, {
      ...signOpts,
      expiresIn: env.jwt.accessTtl as SignOptions['expiresIn'],
      jwtid: randomUUID(),
    });
  },

  verifyAccessToken(token: string): AccessTokenPayload & JwtPayload {
    try {
      const decoded = jwt.verify(token, env.jwt.verifyKey, {
        algorithms: [env.jwt.alg],
      }) as AccessTokenPayload & JwtPayload;
      if ((decoded as unknown as MfaTokenPayload).scope === 'mfa') {
        throw new UnauthorizedError('MFA token cannot be used for API access');
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

  /** Short-lived token bridging password check → TOTP verification. */
  signMfaToken(userId: string): string {
    const payload: MfaTokenPayload = { sub: userId, scope: 'mfa' };
    return jwt.sign(payload as object, env.jwt.signKey, {
      ...signOpts,
      expiresIn: '5m',
      jwtid: randomUUID(),
    });
  },

  verifyMfaToken(token: string): string {
    try {
      const decoded = jwt.verify(token, env.jwt.verifyKey, {
        algorithms: [env.jwt.alg],
      }) as MfaTokenPayload & JwtPayload;
      if (decoded.scope !== 'mfa' || !decoded.sub) {
        throw new UnauthorizedError('Invalid MFA token');
      }
      return decoded.sub;
    } catch (e) {
      if (e instanceof UnauthorizedError) throw e;
      throw new UnauthorizedError('Invalid or expired MFA token', 'MFA_TOKEN_INVALID');
    }
  },

  // ---- Refresh tokens: opaque, rotated, family reuse-detection ----

  async issueRefreshToken(
    userId: string,
    familyId: string | null,
    meta: { userAgent?: string; ipAddress?: string },
    /** Business this session is in, so a reload returns to it rather than the default. */
    organizationId?: string | null
  ): Promise<{ raw: string; familyId: string }> {
    const raw = generateOpaqueToken();
    const family = familyId ?? randomUUID();
    const expiresAt = new Date(Date.now() + env.jwt.refreshTtlDays * 24 * 60 * 60 * 1000);
    await prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: sha256(raw),
        familyId: family,
        organizationId: organizationId ?? null,
        userAgent: meta.userAgent?.slice(0, 255),
        ipAddress: meta.ipAddress?.slice(0, 64),
        expiresAt,
      },
    });
    return { raw, familyId: family };
  },

  /**
   * Rotate: validate presented token, revoke it, issue a replacement in the
   * same family. Presenting an already-revoked token burns the whole family.
   */
  async rotateRefreshToken(
    raw: string,
    meta: { userAgent?: string; ipAddress?: string }
  ): Promise<{ userId: string; newRaw: string; organizationId: string | null }> {
    const record = await prisma.refreshToken.findUnique({ where: { tokenHash: sha256(raw) } });
    if (!record) throw new UnauthorizedError('Invalid refresh token', 'REFRESH_INVALID');

    if (record.revokedAt) {
      // Reuse detected — revoke every token in the family.
      await prisma.refreshToken.updateMany({
        where: { familyId: record.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedError('Refresh token reuse detected — session revoked', 'REFRESH_REUSED');
    }
    if (record.expiresAt < new Date()) {
      throw new UnauthorizedError('Refresh token expired', 'REFRESH_EXPIRED');
    }

    // Carry the business forward: rotation must not quietly move the session
    // back to the user's default org.
    const { raw: newRaw } = await this.issueRefreshToken(
      record.userId,
      record.familyId,
      meta,
      record.organizationId
    );
    await prisma.refreshToken.update({
      where: { id: record.id },
      data: { revokedAt: new Date(), replacedBy: sha256(newRaw).slice(0, 16) },
    });
    return { userId: record.userId, newRaw, organizationId: record.organizationId };
  },

  async revokeFamilyByToken(raw: string): Promise<void> {
    const record = await prisma.refreshToken.findUnique({ where: { tokenHash: sha256(raw) } });
    if (!record) return; // already gone — logout is idempotent
    await prisma.refreshToken.updateMany({
      where: { familyId: record.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  },

  async revokeAllForUser(userId: string): Promise<void> {
    await prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  },
};
