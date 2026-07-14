import { randomUUID } from 'crypto';
import { authenticator } from 'otplib';
import {
  ConflictError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '../../shared/errors';
import {
  decrypt,
  encrypt,
  generateOpaqueToken,
  hashPassword,
  sha256,
  verifyPassword,
} from '../../shared/crypto';
import { logger } from '../../shared/logger';
import { prisma } from '../../infrastructure/database/prisma';
import { mailer } from '../../infrastructure/mail/mailer';
import { SYSTEM_ROLE_TEMPLATES, OWNER_ROLE_NAME } from '../../shared/permissions';
import { tokenService } from './token.service';
import type { LoginDto, MfaVerifyDto, RegisterDto } from './auth.dto';

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

export interface RequestMeta {
  userAgent?: string;
  ipAddress?: string;
}

export interface SessionResult {
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    emailVerified: boolean;
    twoFactorEnabled: boolean;
  };
  organization: { id: string; name: string; slug: string } | null;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

async function audit(
  action: string,
  userId: string | null,
  organizationId: string | null,
  meta: RequestMeta,
  after?: Record<string, unknown>
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        action,
        actorUserId: userId,
        organizationId,
        actorType: 'USER',
        ipAddress: meta.ipAddress?.slice(0, 64),
        userAgent: meta.userAgent?.slice(0, 255),
        after: after ?? undefined,
      },
    });
  } catch (e) {
    logger.error({ err: e, action }, 'Failed to write audit log');
  }
}

/**
 * Builds the session for a user's (default or explicit) membership.
 * Pass `presetRefreshToken` when the refresh token was already rotated
 * (refresh flow) so we don't mint a redundant one.
 */
async function buildSession(
  userId: string,
  meta: RequestMeta,
  organizationId?: string,
  presetRefreshToken?: string
): Promise<SessionResult> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

  const membership = await prisma.membership.findFirst({
    where: {
      userId,
      isActive: true,
      deletedAt: null,
      ...(organizationId ? { organizationId } : {}),
    },
    orderBy: { createdAt: 'asc' },
    include: { organization: { select: { id: true, name: true, slug: true } } },
  });

  const accessToken = tokenService.signAccessToken({
    sub: user.id,
    org: membership?.organizationId ?? null,
    mem: membership?.id ?? null,
    role: membership?.roleId ?? null,
    sa: user.isSuperAdmin,
  });
  const refreshToken =
    presetRefreshToken ?? (await tokenService.issueRefreshToken(user.id, null, meta)).raw;

  return {
    accessToken,
    refreshToken,
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      emailVerified: Boolean(user.emailVerifiedAt),
      twoFactorEnabled: user.twoFactorEnabled,
    },
    organization: membership?.organization ?? null,
  };
}

export const authService = {
  // ---------------------------------------------------------------- register
  async register(dto: RegisterDto, meta: RequestMeta): Promise<SessionResult> {
    const existing = await prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) throw new ConflictError('An account with this email already exists');

    const passwordHash = await hashPassword(dto.password);
    const baseSlug = slugify(dto.organizationName) || 'workspace';

    const permissions = await prisma.permission.findMany({ select: { id: true, key: true } });
    if (permissions.length === 0) {
      logger.warn('Permission catalog is empty — run the database seed before registering');
    }
    const permByKey = new Map(permissions.map((p) => [p.key, p.id]));

    const { userId, orgId } = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: dto.email,
          passwordHash,
          firstName: dto.firstName,
          lastName: dto.lastName,
          passwordChangedAt: new Date(),
        },
      });

      // Unique slug: append short suffix on collision.
      let slug = baseSlug;
      if (await tx.organization.findUnique({ where: { slug } })) {
        slug = `${baseSlug}-${randomUUID().slice(0, 6)}`;
      }

      const org = await tx.organization.create({
        data: {
          name: dto.organizationName,
          slug,
          businessType: dto.businessType,
          email: dto.email,
        },
      });

      // Instantiate system roles from templates.
      let ownerRoleId: string | null = null;
      for (const [name, tpl] of Object.entries(SYSTEM_ROLE_TEMPLATES)) {
        const role = await tx.role.create({
          data: {
            organizationId: org.id,
            name,
            description: tpl.description,
            isSystem: true,
          },
        });
        const wanted = tpl.permissions
          .map((k) => permByKey.get(k))
          .filter((id): id is string => Boolean(id));
        if (wanted.length > 0) {
          await tx.rolePermission.createMany({
            data: wanted.map((permissionId) => ({ roleId: role.id, permissionId })),
          });
        }
        if (name === OWNER_ROLE_NAME) ownerRoleId = role.id;
      }
      if (!ownerRoleId) throw new Error('Owner role template missing');

      await tx.membership.create({
        data: {
          organizationId: org.id,
          userId: user.id,
          roleId: ownerRoleId,
          isOwner: true,
        },
      });

      // 14-day trial on the starter plan when seeded.
      const starter = await tx.plan.findUnique({ where: { slug: 'starter' } });
      if (starter) {
        const now = new Date();
        const trialEnd = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
        await tx.subscription.create({
          data: {
            organizationId: org.id,
            planId: starter.id,
            status: 'TRIALING',
            trialEndsAt: trialEnd,
            currentPeriodStart: now,
            currentPeriodEnd: trialEnd,
          },
        });
      }

      return { userId: user.id, orgId: org.id };
    });

    // Email verification token (24 h)
    const rawToken = generateOpaqueToken();
    await prisma.securityToken.create({
      data: {
        userId,
        type: 'EMAIL_VERIFY',
        tokenHash: sha256(rawToken),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });
    await mailer.sendEmailVerification(dto.email, rawToken);
    await audit('auth.register', userId, orgId, meta);

    return buildSession(userId, meta, orgId);
  },

  // ------------------------------------------------------------------- login
  async login(
    dto: LoginDto,
    meta: RequestMeta
  ): Promise<SessionResult | { mfaRequired: true; mfaToken: string }> {
    const user = await prisma.user.findUnique({ where: { email: dto.email } });
    const genericFail = new UnauthorizedError('Invalid email or password', 'INVALID_CREDENTIALS');

    if (!user || user.deletedAt || user.status === 'DEACTIVATED') throw genericFail;

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new UnauthorizedError(
        'Account temporarily locked due to failed attempts. Try again later.',
        'ACCOUNT_LOCKED'
      );
    }

    const valid = await verifyPassword(user.passwordHash, dto.password);
    if (!valid) {
      const attempts = user.failedLoginAttempts + 1;
      await prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginAttempts: attempts,
          lockedUntil:
            attempts >= MAX_FAILED_ATTEMPTS
              ? new Date(Date.now() + LOCK_MINUTES * 60 * 1000)
              : null,
        },
      });
      await audit('auth.login_failed', user.id, null, meta);
      throw genericFail;
    }

    if (user.status === 'SUSPENDED') {
      throw new UnauthorizedError('Account suspended. Contact support.', 'ACCOUNT_SUSPENDED');
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
    });

    if (user.twoFactorEnabled) {
      return { mfaRequired: true, mfaToken: tokenService.signMfaToken(user.id) };
    }

    await audit('auth.login', user.id, null, meta);
    return buildSession(user.id, meta);
  },

  // ------------------------------------------------------------- 2FA verify
  async verifyMfa(dto: MfaVerifyDto, meta: RequestMeta): Promise<SessionResult> {
    const userId = tokenService.verifyMfaToken(dto.mfaToken);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.twoFactorEnabled || !user.twoFactorSecretEnc) {
      throw new UnauthorizedError('Two-factor authentication is not enabled');
    }

    let ok = false;
    if (/^\d{6}$/.test(dto.code)) {
      ok = authenticator.verify({ token: dto.code, secret: decrypt(user.twoFactorSecretEnc) });
    } else {
      // Backup code: single use.
      const backup = await prisma.securityToken.findFirst({
        where: {
          userId,
          type: 'TWO_FACTOR_BACKUP',
          tokenHash: sha256(dto.code),
          usedAt: null,
          expiresAt: { gt: new Date() },
        },
      });
      if (backup) {
        await prisma.securityToken.update({
          where: { id: backup.id },
          data: { usedAt: new Date() },
        });
        ok = true;
      }
    }
    if (!ok) throw new UnauthorizedError('Invalid verification code', 'MFA_INVALID');

    await audit('auth.login_2fa', userId, null, meta);
    return buildSession(userId, meta);
  },

  // ----------------------------------------------------------------- refresh
  async refresh(rawToken: string, meta: RequestMeta): Promise<SessionResult> {
    const { userId, newRaw } = await tokenService.rotateRefreshToken(rawToken, meta);
    return buildSession(userId, meta, undefined, newRaw);
  },

  // ------------------------------------------------------------------ logout
  async logout(rawToken: string | undefined, userId: string, meta: RequestMeta): Promise<void> {
    if (rawToken) await tokenService.revokeFamilyByToken(rawToken);
    await audit('auth.logout', userId, null, meta);
  },

  async logoutAll(userId: string, meta: RequestMeta): Promise<void> {
    await tokenService.revokeAllForUser(userId);
    await audit('auth.logout_all', userId, null, meta);
  },

  // --------------------------------------------------------- password reset
  async forgotPassword(email: string): Promise<void> {
    const user = await prisma.user.findUnique({ where: { email } });
    // Always resolve successfully — no user enumeration.
    if (!user || user.deletedAt) return;

    await prisma.securityToken.deleteMany({
      where: { userId: user.id, type: 'PASSWORD_RESET', usedAt: null },
    });
    const raw = generateOpaqueToken();
    await prisma.securityToken.create({
      data: {
        userId: user.id,
        type: 'PASSWORD_RESET',
        tokenHash: sha256(raw),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    await mailer.sendPasswordReset(email, raw);
  },

  async resetPassword(rawToken: string, newPassword: string, meta: RequestMeta): Promise<void> {
    const record = await prisma.securityToken.findFirst({
      where: {
        type: 'PASSWORD_RESET',
        tokenHash: sha256(rawToken),
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
    if (!record) throw new ValidationError('Invalid or expired reset link');

    const passwordHash = await hashPassword(newPassword);
    await prisma.$transaction([
      prisma.securityToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
      prisma.user.update({
        where: { id: record.userId },
        data: {
          passwordHash,
          passwordChangedAt: new Date(),
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      }),
    ]);
    await tokenService.revokeAllForUser(record.userId);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: record.userId } });
    await mailer.sendPasswordChangedNotice(user.email);
    await audit('auth.password_reset', record.userId, null, meta);
  },

  // --------------------------------------------------------- email verify
  async verifyEmail(rawToken: string): Promise<void> {
    const record = await prisma.securityToken.findFirst({
      where: {
        type: 'EMAIL_VERIFY',
        tokenHash: sha256(rawToken),
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
    if (!record) throw new ValidationError('Invalid or expired verification link');
    await prisma.$transaction([
      prisma.securityToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
      prisma.user.update({
        where: { id: record.userId },
        data: { emailVerifiedAt: new Date() },
      }),
    ]);
  },

  // ------------------------------------------------------------------- 2FA
  async setupTwoFactor(userId: string): Promise<{ secret: string; otpauthUrl: string }> {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.twoFactorEnabled) throw new ConflictError('Two-factor is already enabled');

    const secret = authenticator.generateSecret();
    await prisma.user.update({
      where: { id: userId },
      data: { twoFactorSecretEnc: encrypt(secret) },
    });
    const otpauthUrl = authenticator.keyuri(user.email, 'BusinessHub AI', secret);
    return { secret, otpauthUrl };
  },

  async enableTwoFactor(
    userId: string,
    code: string,
    meta: RequestMeta
  ): Promise<{ backupCodes: string[] }> {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.twoFactorEnabled) throw new ConflictError('Two-factor is already enabled');
    if (!user.twoFactorSecretEnc) throw new ValidationError('Run 2FA setup first');

    const ok = authenticator.verify({ token: code, secret: decrypt(user.twoFactorSecretEnc) });
    if (!ok) throw new ValidationError('Invalid verification code');

    const backupCodes = Array.from({ length: 10 }, () => generateOpaqueToken(8));
    const tenYears = new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000);
    await prisma.$transaction([
      prisma.user.update({ where: { id: userId }, data: { twoFactorEnabled: true } }),
      prisma.securityToken.deleteMany({ where: { userId, type: 'TWO_FACTOR_BACKUP' } }),
      prisma.securityToken.createMany({
        data: backupCodes.map((c) => ({
          userId,
          type: 'TWO_FACTOR_BACKUP',
          tokenHash: sha256(c),
          expiresAt: tenYears,
        })),
      }),
    ]);
    await audit('auth.2fa_enabled', userId, null, meta);
    return { backupCodes };
  },

  async disableTwoFactor(
    userId: string,
    password: string,
    code: string,
    meta: RequestMeta
  ): Promise<void> {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.twoFactorEnabled || !user.twoFactorSecretEnc) {
      throw new ValidationError('Two-factor is not enabled');
    }
    const passOk = await verifyPassword(user.passwordHash, password);
    const codeOk = authenticator.verify({ token: code, secret: decrypt(user.twoFactorSecretEnc) });
    if (!passOk || !codeOk) throw new UnauthorizedError('Password or code incorrect');

    await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: { twoFactorEnabled: false, twoFactorSecretEnc: null },
      }),
      prisma.securityToken.deleteMany({ where: { userId, type: 'TWO_FACTOR_BACKUP' } }),
    ]);
    await audit('auth.2fa_disabled', userId, null, meta);
  },

  // ----------------------------------------------------------------- me etc.
  async me(userId: string): Promise<unknown> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        emailVerifiedAt: true,
        twoFactorEnabled: true,
        lastLoginAt: true,
        preferences: true,
        memberships: {
          where: { isActive: true, deletedAt: null },
          select: {
            id: true,
            isOwner: true,
            jobTitle: true,
            organization: { select: { id: true, name: true, slug: true, businessType: true } },
            role: {
              select: {
                id: true,
                name: true,
                permissions: { select: { permission: { select: { key: true } } } },
              },
            },
          },
        },
      },
    });
    if (!user) throw new NotFoundError('User');
    return {
      ...user,
      memberships: user.memberships.map((m) => ({
        ...m,
        role: { id: m.role.id, name: m.role.name, permissions: m.role.permissions.map((p) => p.permission.key) },
      })),
    };
  },

  async listSessions(userId: string): Promise<unknown[]> {
    const tokens = await prisma.refreshToken.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, userAgent: true, ipAddress: true, createdAt: true, familyId: true },
    });
    // One session per family (rotation keeps the chain alive).
    const seen = new Set<string>();
    return tokens.filter((t) => {
      if (seen.has(t.familyId)) return false;
      seen.add(t.familyId);
      return true;
    });
  },

  async revokeSession(userId: string, sessionId: string): Promise<void> {
    const token = await prisma.refreshToken.findFirst({ where: { id: sessionId, userId } });
    if (!token) throw new NotFoundError('Session');
    await prisma.refreshToken.updateMany({
      where: { familyId: token.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  },

  async switchOrganization(userId: string, organizationId: string, meta: RequestMeta): Promise<SessionResult> {
    const membership = await prisma.membership.findFirst({
      where: { userId, organizationId, isActive: true, deletedAt: null },
    });
    if (!membership) throw new NotFoundError('Membership in that organization');
    return buildSession(userId, meta, organizationId);
  },
};
