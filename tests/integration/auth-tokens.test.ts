import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prismaUnscoped, disconnectDatabase } from '../../src/infrastructure/database/prisma';
import { tokenService } from '../../src/application/auth/token.service';
import { HAS_TEST_DB, createOrgFixture, resetDb } from './helpers';

describe.skipIf(!HAS_TEST_DB)('refresh token rotation & reuse detection', () => {
  let userId: string;

  beforeAll(async () => {
    await resetDb();
    const { user } = await createOrgFixture('Tokens');
    userId = user.id;
  });

  afterAll(async () => {
    await disconnectDatabase();
  });

  it('issues, rotates, and keeps one active chain per family', async () => {
    const { raw: t1, familyId } = await tokenService.issueRefreshToken(userId, null, {});
    const { userId: rotatedUser, newRaw: t2 } = await tokenService.rotateRefreshToken(t1, {});
    expect(rotatedUser).toBe(userId);
    expect(t2).not.toBe(t1);

    const active = await prismaUnscoped.refreshToken.findMany({
      where: { familyId, revokedAt: null },
    });
    expect(active).toHaveLength(1);
  });

  it('rejects unknown tokens', async () => {
    await expect(tokenService.rotateRefreshToken('forged-token', {})).rejects.toThrow(/Invalid/);
  });

  it('burns the whole family when a revoked token is replayed (theft detection)', async () => {
    const { raw: t1 } = await tokenService.issueRefreshToken(userId, null, {});
    const { newRaw: t2 } = await tokenService.rotateRefreshToken(t1, {});
    const { newRaw: t3 } = await tokenService.rotateRefreshToken(t2, {});

    // Attacker replays t1 (already rotated away).
    await expect(tokenService.rotateRefreshToken(t1, {})).rejects.toThrow(/reuse detected/);

    // The legitimate holder of t3 is now locked out too — family revoked.
    await expect(tokenService.rotateRefreshToken(t3, {})).rejects.toThrow();
  });

  it('access tokens verify and carry the payload', () => {
    const jwt = tokenService.signAccessToken({
      sub: userId, org: 'org1', mem: 'mem1', role: 'role1', sa: false,
    });
    const decoded = tokenService.verifyAccessToken(jwt);
    expect(decoded.sub).toBe(userId);
    expect(decoded.org).toBe('org1');
    expect(decoded.sa).toBe(false);
  });

  it('MFA tokens cannot be used as access tokens', () => {
    const mfa = tokenService.signMfaToken(userId);
    expect(() => tokenService.verifyAccessToken(mfa)).toThrow();
    expect(tokenService.verifyMfaToken(mfa)).toBe(userId);
  });
});
