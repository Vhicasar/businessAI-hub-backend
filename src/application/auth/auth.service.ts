import { randomUUID } from 'crypto';
import { authenticator } from 'otplib';
import {
  ConflictError,
  ForbiddenError,
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
import { prisma, prismaUnscoped } from '../../infrastructure/database/prisma';
import { mailer } from '../../infrastructure/mail/mailer';
import { SYSTEM_ROLE_TEMPLATES, OWNER_ROLE_NAME } from '../../shared/permissions';
import { PLAN_CATALOG } from '../../shared/plans';
import { modulesFor } from '../modules/business-modules';
import { resolveEntitlements } from '../billing/entitlements';
import { resolveLocale } from '../../shared/currency';
import { tokenService } from './token.service';
import { filesService } from '../files/files.service';
import type { CreateOrganizationDto, LoginDto, MfaVerifyDto, RegisterDto } from './auth.dto';
import type { Prisma } from '@prisma/client';

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

/** The transaction client our extended Prisma client actually yields. */
type TenantTransactionClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

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
  organization: { id: string; name: string; slug: string; businessType: string; logoUrl: string | null } | null;
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
  presetRefreshToken?: string,
  /**
   * Treat `organizationId` as a preference rather than a requirement.
   *
   * A remembered business can stop being reachable between sessions — the user
   * is removed from it, or it is closed. On refresh that must not strand them
   * with no organization at all; falling back to one they still belong to is
   * the only useful outcome. A *switch* keeps the strict behaviour, because
   * asking for a business you cannot access is an error worth reporting.
   */
  organizationIsPreference = false
): Promise<SessionResult> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

  // Unscoped deliberately. Building a session is inherently cross-tenant: the
  // caller may be switching *out* of the org in the current request context,
  // and the tenant extension would AND that context onto this lookup — so the
  // target membership could never be found and the session would come back
  // with no organisation at all.
  //
  // `userId` is the security boundary here: we only ever return memberships
  // belonging to the user we already authenticated.
  const membershipWhere: Prisma.MembershipWhereInput = {
    userId,
    isActive: true,
    deletedAt: null,
    organization: { deletedAt: null, status: { in: ['ACTIVE', 'TRIAL'] } },
  };
  const membershipInclude = {
    organization: { select: { id: true, name: true, slug: true, businessType: true, logoFileId: true } },
  };

  let membership = await prismaUnscoped.membership.findFirst({
    where: { ...membershipWhere, ...(organizationId ? { organizationId } : {}) },
    orderBy: { createdAt: 'asc' },
    include: membershipInclude,
  });

  // The remembered business is gone or no longer ours — fall back rather than
  // hand back a session with no organization.
  if (!membership && organizationId && organizationIsPreference) {
    membership = await prismaUnscoped.membership.findFirst({
      where: membershipWhere,
      orderBy: { createdAt: 'asc' },
      include: membershipInclude,
    });
  }

  if (!membership && !user.isSuperAdmin) {
    const unavailable = await prismaUnscoped.membership.findFirst({
      where: { userId, ...(organizationId ? { organizationId } : {}) },
      orderBy: { createdAt: 'asc' },
      select: { organization: { select: { name: true, status: true, deletedAt: true } } },
    });
    if (unavailable?.organization.deletedAt || unavailable?.organization.status === 'CANCELLED') {
      throw new UnauthorizedError(
        `${unavailable.organization.name} has been deleted by the platform administrator. Contact support if this was unexpected.`,
        'ORGANIZATION_DELETED',
      );
    }
    if (unavailable?.organization.status === 'SUSPENDED') {
      throw new UnauthorizedError(
        `${unavailable.organization.name} has been suspended by the platform administrator. Contact support for assistance.`,
        'ORGANIZATION_SUSPENDED',
      );
    }
  }

  const accessToken = tokenService.signAccessToken({
    sub: user.id,
    org: membership?.organizationId ?? null,
    mem: membership?.id ?? null,
    role: membership?.roleId ?? null,
    sa: user.isSuperAdmin,
  });
  // Stamp the business onto the new session so the very first refresh already
  // knows where to return to, rather than re-deriving the default membership.
  const refreshToken =
    presetRefreshToken ??
    (await tokenService.issueRefreshToken(user.id, null, meta, membership?.organizationId ?? null)).raw;

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
    organization: membership
      ? {
          id: membership.organization.id,
          name: membership.organization.name,
          slug: membership.organization.slug,
          businessType: membership.organization.businessType,
          logoUrl: await filesService.urlFor(membership.organization.logoFileId),
        }
      : null,
  };
}

/**
 * Provision a workspace: the organisation, its system roles, the owner's
 * membership and a trial subscription.
 *
 * Extracted from `register` so that creating a *second* business gets exactly
 * the same setup as the first. A user's Nth business must not be a lesser
 * citizen than their first — same roles, same trial, same everything.
 *
 * Runs inside the caller's transaction.
 */
async function provisionOrganization(
  // Derived from the extended client rather than Prisma.TransactionClient:
  // the tenant extension changes the client's shape, so the stock type doesn't
  // match what $transaction actually hands us.
  tx: TenantTransactionClient,
  input: {
    userId: string;
    name: string;
    businessType: RegisterDto['businessType'];
    email: string;
    timezone?: string;
    locale?: string;
    currency?: string;
  },
  permByKey: Map<string, string>,
): Promise<{ orgId: string }> {
  const baseSlug = slugify(input.name) || 'workspace';
  let slug = baseSlug;
  if (await tx.organization.findUnique({ where: { slug } })) {
    slug = `${baseSlug}-${randomUUID().slice(0, 6)}`;
  }

  // Where the owner is decides what the org trades in (see shared/currency).
  const locale = resolveLocale({
    timezone: input.timezone,
    locale: input.locale,
    currency: input.currency,
  });

  const org = await tx.organization.create({
    data: {
      name: input.name,
      slug,
      businessType: input.businessType,
      email: input.email,
      currency: locale.currency,
      country: locale.country,
      timezone: locale.timezone,
      ...(input.locale ? { locale: input.locale } : {}),
    },
  });

  let ownerRoleId: string | null = null;
  for (const [name, tpl] of Object.entries(SYSTEM_ROLE_TEMPLATES)) {
    const role = await tx.role.create({
      data: { organizationId: org.id, name, description: tpl.description, isSystem: true },
    });
    const wanted = tpl.permissions.map((k) => permByKey.get(k)).filter((id): id is string => Boolean(id));
    if (wanted.length > 0) {
      await tx.rolePermission.createMany({
        data: wanted.map((permissionId) => ({ roleId: role.id, permissionId })),
      });
    }
    if (name === OWNER_ROLE_NAME) ownerRoleId = role.id;
  }
  if (!ownerRoleId) throw new Error('Owner role template missing');

  await tx.membership.create({
    data: { organizationId: org.id, userId: input.userId, roleId: ownerRoleId, isOwner: true },
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

  return { orgId: org.id };
}

export const authService = {
  // ---------------------------------------------------------------- register
  async register(
    dto: RegisterDto,
    meta: RequestMeta,
  ): Promise<{ verificationRequired: true; email: string; emailSent: boolean }> {
    const existing = await prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) throw new ConflictError('An account with this email already exists');

    const passwordHash = await hashPassword(dto.password);

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

      const { orgId } = await provisionOrganization(
        tx,
        {
          userId: user.id,
          name: dto.organizationName,
          businessType: dto.businessType,
          email: dto.email,
          timezone: dto.timezone,
          locale: dto.locale,
          currency: dto.currency,
        },
        permByKey,
      );

      return { userId: user.id, orgId };
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
    // Send the verification email immediately. The mailer retries internally
    // (3× with backoff) and never throws, so a mail hiccup can't fail a
    // registration whose user is already created. The outcome is persisted to
    // EmailDeliveryLog; if it didn't get through, the durable retry sweep
    // (email-retry.service) re-sends — surviving restarts, unlike a setTimeout.
    const result = await mailer.sendEmailVerification(dto.email, rawToken, userId);
    if (!result.delivered) {
      logger.warn(
        { email: dto.email, userId, error: result.error },
        'Verification email not delivered — durable retry sweep will re-send',
      );
    }
    await audit('auth.register', userId, orgId, meta);

    return { verificationRequired: true, email: dto.email, emailSent: result.delivered };
  },

  // --------------------------------------------------- multiple businesses
  /**
   * Every business this user belongs to. Drives the switcher, so it returns
   * enough to render one without a second round-trip.
   */
  async organizations(userId: string) {
    // Unscoped: the whole point is to see every business, not just the active
    // one. Scoped by userId instead.
    const memberships = await prismaUnscoped.membership.findMany({
      where: { userId, isActive: true, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        isOwner: true,
        createdAt: true,
        role: { select: { id: true, name: true } },
        organization: {
          select: { id: true, name: true, slug: true, businessType: true, currency: true, logoFileId: true },
        },
      },
    });
    return memberships.map((m) => ({
      membershipId: m.id,
      isOwner: m.isOwner,
      role: m.role,
      joinedAt: m.createdAt,
      ...m.organization,
    }));
  },

  /**
   * Create an additional business for an existing user, and switch into it.
   * Same provisioning as signup: system roles, owner membership, trial.
   */
  /** Throws when the user has hit their plan's business-creation limit. */
  async assertCanCreateBusiness(userId: string): Promise<void> {
    const memberships = await prismaUnscoped.membership.findMany({
      where: { userId, deletedAt: null },
      select: { organizationId: true },
    });
    if (memberships.length === 0) return; // first business is always allowed

    const subs = await prismaUnscoped.subscription.findMany({
      where: {
        organizationId: { in: memberships.map((m) => m.organizationId) },
        status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] },
      },
      include: { plan: { select: { slug: true } } },
    });
    const starterMax = PLAN_CATALOG.find((p) => p.slug === 'starter')?.maxBusinesses ?? 1;
    // No paid subscription anywhere → treat as the free (starter) allowance.
    const slugs = subs.length ? subs.map((s) => s.plan.slug) : ['starter'];
    let allowance = 0;
    for (const slug of slugs) {
      const max = PLAN_CATALOG.find((p) => p.slug === slug)?.maxBusinesses ?? starterMax;
      if (max === null) return; // an unlimited plan → allow
      allowance = Math.max(allowance, max);
    }
    if (memberships.length >= allowance) {
      throw new ValidationError(
        `Your plan allows up to ${allowance} business${allowance === 1 ? '' : 'es'}. Upgrade your plan to add more.`,
      );
    }
  },

  async createOrganization(
    userId: string,
    dto: CreateOrganizationDto,
    meta: RequestMeta,
  ): Promise<SessionResult> {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true },
    });

    // Enforce the plan's business-creation limit (Free 1, Growth 2, …), server-
    // side regardless of the client. Based on the most generous plan the user
    // is already on.
    await this.assertCanCreateBusiness(userId);

    const permissions = await prisma.permission.findMany({ select: { id: true, key: true } });
    const permByKey = new Map(permissions.map((p) => [p.key, p.id]));

    const { orgId } = await prisma.$transaction((tx) =>
      provisionOrganization(
        tx,
        {
          userId,
          name: dto.name,
          businessType: dto.businessType,
          email: user.email,
          timezone: dto.timezone,
          locale: dto.locale,
          currency: dto.currency,
        },
        permByKey,
      ),
    );

    await audit('auth.organization_created', userId, orgId, meta);
    // Drop them straight into the new business — that's why they made it.
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
    if (!user.emailVerifiedAt) {
      throw new UnauthorizedError(
        'Verify your email address before signing in.',
        'EMAIL_NOT_VERIFIED',
      );
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
    if (!user.emailVerifiedAt) {
      throw new UnauthorizedError('Verify your email address before signing in.', 'EMAIL_NOT_VERIFIED');
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
    const { userId, newRaw, organizationId } = await tokenService.rotateRefreshToken(rawToken, meta);
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { emailVerifiedAt: true } });
    if (!user?.emailVerifiedAt) {
      await tokenService.revokeAllForUser(userId);
      throw new UnauthorizedError('Verify your email address before signing in.', 'EMAIL_NOT_VERIFIED');
    }
    // Pass the remembered business so a page reload or app restart lands where
    // the user left off. Without it buildSession falls back to the *oldest*
    // membership, which is how a reload used to bounce them to their default.
    // Marked as a preference: if that business is no longer reachable, the user
    // still gets a working session in one they do belong to.
    return buildSession(userId, meta, organizationId ?? undefined, newRaw, true);
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
    await mailer.sendPasswordReset(email, raw, user.id);
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
    await mailer.sendPasswordChangedNotice(user.email, user.id);
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

  async resendEmailVerification(email: string): Promise<{ sent: boolean }> {
    const user = await prisma.user.findUnique({ where: { email } });
    // Do not reveal whether an address is registered or already verified.
    if (!user || user.deletedAt || user.emailVerifiedAt) return { sent: false };

    // Dedup: if a verification email was already issued in the last 60s, don't
    // send another — prevents duplicate emails from double-clicks / retries.
    const recent = await prisma.securityToken.findFirst({
      where: {
        userId: user.id,
        type: 'EMAIL_VERIFY',
        usedAt: null,
        createdAt: { gt: new Date(Date.now() - 60_000) },
      },
    });
    if (recent) {
      logger.info({ userId: user.id }, 'Verification resend skipped — one was just sent (dedup)');
      return { sent: true };
    }

    // Invalidate outstanding tokens and issue a fresh one.
    await prisma.securityToken.updateMany({
      where: { userId: user.id, type: 'EMAIL_VERIFY', usedAt: null },
      data: { usedAt: new Date() },
    });
    const rawToken = generateOpaqueToken();
    await prisma.securityToken.create({
      data: {
        userId: user.id,
        type: 'EMAIL_VERIFY',
        tokenHash: sha256(rawToken),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });
    const result = await mailer.sendEmailVerification(user.email, rawToken, user.id);
    return { sent: result.delivered };
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
    const otpauthUrl = authenticator.keyuri(user.email, 'Vhicasar Hub AI', secret);
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
            organization: { select: { id: true, name: true, slug: true, businessType: true, logoFileId: true } },
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
    // Resolve every org's logo in one batch rather than per-membership.
    const logoUrls = await filesService.urlMap(user.memberships.map((m) => m.organization.logoFileId));
    // Each org's plan features, so the UI can gate modules by plan (not just RBAC).
    const featureEntries = await Promise.all(
      user.memberships.map(async (m) => [m.organization.id, [...(await resolveEntitlements(m.organization.id)).features]] as const),
    );
    const featuresByOrg = new Map(featureEntries);
    /*
     * And each org's optional modules, decided from its business type and any
     * administrator override. Sent rather than derived on the client: a menu
     * that works out its own answer is a menu that will eventually disagree
     * with the API it opens.
     */
    const moduleEntries = await Promise.all(
      user.memberships.map(async (m) => [m.organization.id, await modulesFor(m.organization.id)] as const),
    );
    const modulesByOrg = new Map(moduleEntries);
    return {
      ...user,
      memberships: user.memberships.map((m) => ({
        ...m,
        features: featuresByOrg.get(m.organization.id) ?? [],
        modules: modulesByOrg.get(m.organization.id) ?? [],
        organization: {
          id: m.organization.id,
          name: m.organization.name,
          slug: m.organization.slug,
          businessType: m.organization.businessType,
          logoUrl: m.organization.logoFileId ? logoUrls.get(m.organization.logoFileId) ?? null : null,
        },
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

  /**
   * Switch the active business, minting a session scoped to it.
   *
   * The active org is a claim inside the access token, so switching cannot be a
   * client-side toggle — it has to come back through here. Membership is
   * re-checked rather than trusted from the request: this function is the
   * boundary between two tenants' data.
   *
   * Also used by the invite-accept flow to open a session in the org a user has
   * just joined.
   */
  async switchOrganization(userId: string, organizationId: string, meta: RequestMeta): Promise<SessionResult> {
    // Unscoped: we're checking membership of the org being switched *to*, which
    // by definition isn't the one in the current context. userId is the guard.
    const membership = await prismaUnscoped.membership.findFirst({
      where: { userId, organizationId, isActive: true, deletedAt: null },
      select: { id: true },
    });
    // Forbidden, not NotFound: the org may well exist — this user just has no
    // membership in it, and saying which is a needless information leak.
    if (!membership) throw new ForbiddenError('You do not have access to that business');

    await audit('auth.organization_switched', userId, organizationId, meta);

    // buildSession mints a fresh refresh token stamped with this organization,
    // and the controller sets it as the cookie — so the next refresh comes back
    // here rather than to the user's default membership.
    return buildSession(userId, meta, organizationId);
  },
};
