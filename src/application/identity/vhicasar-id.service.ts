import { randomInt } from 'crypto';
import type { VhicasarId } from '@prisma/client';
import { prisma, prismaUnscoped } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { hashPassword, verifyPassword } from '../../shared/crypto';
import { normalizeEmail, normalizePhone, phoneVariants } from '../../shared/phone';
import { emitEvent } from '../../shared/domain-events';
import { ConflictError, NotFoundError, UnauthorizedError } from '../../shared/errors';
import { auditService } from '../audit/audit.service';
import type {
  LinkCustomerDto,
  LoginIdentityDto,
  RegisterDeviceDto,
  RegisterIdentityDto,
} from './identity.dto';

/**
 * Vhicasar ID — the global, cross-tenant consumer identity (Platform Core /
 * Identity Service). One person = one VhicasarId, associated with many orgs'
 * Customer records via CustomerLink. Identity is never duplicated across
 * tenants (Database Bible §21).
 *
 * VhicasarId and Device are NOT tenant-scoped models, so we use the unscoped
 * client for them; CustomerLink IS tenant-scoped, so admin-side link operations
 * use the scoped client (which enforces the caller's org) and consumer-side
 * cross-org reads use the unscoped client explicitly.
 */

// Crockford base32 without I/L/O/U to avoid ambiguity.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomBlock(len: number): string {
  let out = '';
  for (let i = 0; i < len; i += 1) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/**
 * Canonical E.164, shared with CRM/POS so the same person can't end up as two
 * records (§9). Falls back to the raw input only if it can't be parsed at all,
 * which the DTO's regex already makes unlikely.
 */
function normalisePhone(phone: string, country?: string): string {
  return normalizePhone(phone, country) ?? phone.trim();
}

const publicView = (id: VhicasarId) => ({
  id: id.id,
  publicId: id.publicId,
  phone: id.phone,
  email: id.email,
  firstName: id.firstName,
  lastName: id.lastName,
  displayName: id.displayName,
  avatarUrl: id.avatarUrl,
  status: id.status,
  kycLevel: id.kycLevel,
  hasPin: Boolean(id.pinHash),
  phoneVerifiedAt: id.phoneVerifiedAt,
  emailVerifiedAt: id.emailVerifiedAt,
  createdAt: id.createdAt,
});
export type PublicIdentity = ReturnType<typeof publicView>;

async function generatePublicId(): Promise<string> {
  // "VH-XXXX-XXXX" — ~1e12 space; retry on the rare collision.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = `VH-${randomBlock(4)}-${randomBlock(4)}`;
    const clash = await prismaUnscoped.vhicasarId.findUnique({
      where: { publicId: candidate },
      select: { id: true },
    });
    if (!clash) return candidate;
  }
  throw new ConflictError('Could not allocate a Vhicasar ID, please retry');
}

export const vhicasarIdService = {
  publicView,

  async register(dto: RegisterIdentityDto): Promise<VhicasarId> {
    const phone = normalisePhone(dto.phone);
    const existing = await prismaUnscoped.vhicasarId.findUnique({ where: { phone }, select: { id: true } });
    if (existing) throw new ConflictError('An account with this phone number already exists');
    if (dto.email) {
      const emailClash = await prismaUnscoped.vhicasarId.findUnique({
        where: { email: dto.email },
        select: { id: true },
      });
      if (emailClash) throw new ConflictError('An account with this email already exists');
    }

    const publicId = await generatePublicId();
    const identity = await prismaUnscoped.vhicasarId.create({
      data: {
        publicId,
        phone,
        email: dto.email ?? null,
        firstName: dto.firstName,
        lastName: dto.lastName ?? null,
        displayName: [dto.firstName, dto.lastName].filter(Boolean).join(' ') || dto.firstName,
        passwordHash: await hashPassword(dto.password),
        country: dto.country ?? null,
        locale: dto.locale ?? 'en',
      },
    });

    await emitEvent({
      name: 'VhicasarIdRegistered',
      aggregateType: 'VhicasarId',
      aggregateId: identity.id,
      payload: { publicId: identity.publicId },
      organizationId: null,
    });
    return identity;
  },

  /**
   * Find the account someone is trying to sign in to, however they typed it.
   *
   * A customer should never have to remember whether they registered as
   * `08055512345`, `+2348055512345` or `2348055512345`, so every spelling of
   * the number is tried, and an email or Vhicasar ID is accepted too. Returns
   * null rather than throwing so the caller can give one generic message and
   * not leak which accounts exist.
   */
  async resolveIdentifier(raw: string, country?: string): Promise<VhicasarId | null> {
    const trimmed = raw.trim();
    if (!trimmed) return null;

    // Email — unambiguous, so check it first and skip the phone work entirely.
    if (trimmed.includes('@')) {
      const email = normalizeEmail(trimmed);
      return email
        ? prismaUnscoped.vhicasarId.findFirst({ where: { email, deletedAt: null } })
        : null;
    }

    // Vhicasar ID, e.g. "VH-7QK2-9F3P".
    if (/^VH-/i.test(trimmed)) {
      return prismaUnscoped.vhicasarId.findFirst({
        where: { publicId: trimmed.toUpperCase(), deletedAt: null },
      });
    }

    const variants = phoneVariants(trimmed, country);
    if (variants.length === 0) return null;

    // Records written before normalisation existed may hold any of these
    // spellings, so match on all of them rather than only the canonical one.
    const matches = await prismaUnscoped.vhicasarId.findMany({
      where: { phone: { in: variants }, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    if (matches.length === 0) return null;

    // Prefer the canonical E.164 record when several spellings exist, so a
    // duplicate written years ago never shadows the real account.
    const canonical = normalizePhone(trimmed, country);
    return matches.find((m) => m.phone === canonical) ?? matches[0]!;
  },

  async login(dto: LoginIdentityDto): Promise<VhicasarId> {
    const identity = await this.resolveIdentifier(dto.phone, dto.country);
    if (!identity || !identity.passwordHash || identity.deletedAt) {
      throw new UnauthorizedError('Invalid phone number or password', 'INVALID_CREDENTIALS');
    }
    if (identity.status !== 'ACTIVE') {
      throw new UnauthorizedError('This account is not active', 'ACCOUNT_INACTIVE');
    }
    const ok = await verifyPassword(identity.passwordHash, dto.password);
    if (!ok) throw new UnauthorizedError('Invalid phone number or password', 'INVALID_CREDENTIALS');

    await prismaUnscoped.vhicasarId.update({
      where: { id: identity.id },
      data: { lastLoginAt: new Date() },
    });
    return identity;
  },

  async getById(id: string): Promise<VhicasarId> {
    const identity = await prismaUnscoped.vhicasarId.findUnique({ where: { id } });
    if (!identity || identity.deletedAt) throw new NotFoundError('Vhicasar ID');
    return identity;
  },

  async setPin(id: string, pin: string): Promise<void> {
    await prismaUnscoped.vhicasarId.update({
      where: { id },
      data: { pinHash: await hashPassword(pin) },
    });
  },

  async verifyPin(id: string, pin: string): Promise<boolean> {
    const identity = await prismaUnscoped.vhicasarId.findUnique({
      where: { id },
      select: { pinHash: true },
    });
    if (!identity?.pinHash) return false;
    return verifyPassword(identity.pinHash, pin);
  },

  // ---- Devices ----

  async registerDevice(vhicasarId: string, dto: RegisterDeviceDto, ip?: string) {
    const device = await prismaUnscoped.device.upsert({
      where: { vhicasarId_deviceId: { vhicasarId, deviceId: dto.deviceId } },
      create: {
        vhicasarId,
        deviceId: dto.deviceId,
        platform: dto.platform,
        model: dto.model ?? null,
        osVersion: dto.osVersion ?? null,
        appVersion: dto.appVersion ?? null,
        publicKey: dto.publicKey ?? null,
        pushToken: dto.pushToken ?? null,
        isBiometricEnabled: dto.isBiometricEnabled ?? false,
        trustLevel: 'RECOGNIZED',
        lastSeenAt: new Date(),
        lastIp: ip ?? null,
      },
      update: {
        platform: dto.platform,
        model: dto.model ?? null,
        osVersion: dto.osVersion ?? null,
        appVersion: dto.appVersion ?? null,
        ...(dto.publicKey ? { publicKey: dto.publicKey } : {}),
        ...(dto.pushToken ? { pushToken: dto.pushToken } : {}),
        ...(dto.isBiometricEnabled !== undefined ? { isBiometricEnabled: dto.isBiometricEnabled } : {}),
        lastSeenAt: new Date(),
        lastIp: ip ?? null,
        revokedAt: null,
      },
    });
    await emitEvent({
      name: 'DeviceRegistered',
      aggregateType: 'Device',
      aggregateId: device.id,
      payload: { vhicasarId, platform: dto.platform },
      organizationId: null,
    });
    return device;
  },

  async listDevices(vhicasarId: string) {
    return prismaUnscoped.device.findMany({
      where: { vhicasarId, revokedAt: null },
      orderBy: { lastSeenAt: 'desc' },
      select: {
        id: true,
        deviceId: true,
        platform: true,
        model: true,
        trustLevel: true,
        isBiometricEnabled: true,
        lastSeenAt: true,
        createdAt: true,
      },
    });
  },

  async revokeDevice(vhicasarId: string, deviceId: string): Promise<void> {
    await prismaUnscoped.device.updateMany({
      where: { vhicasarId, deviceId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    // Revoking a device must end its sessions too — otherwise a stolen phone
    // keeps refreshing long after the user removed it.
    await prismaUnscoped.appRefreshToken.updateMany({
      where: { vhicasarId, deviceId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  },

  // ---- Consumer view of linked businesses (cross-tenant, unscoped) ----

  async listBusinesses(vhicasarId: string) {
    const links = await prismaUnscoped.customerLink.findMany({
      where: { vhicasarId, status: 'ACTIVE' },
      orderBy: { linkedAt: 'desc' },
      select: {
        id: true,
        organizationId: true,
        customerId: true,
        linkedAt: true,
        organization: { select: { id: true, name: true, slug: true, logoFileId: true, businessType: true } },
      },
    });
    return links.map((l) => ({
      linkId: l.id,
      organizationId: l.organizationId,
      customerId: l.customerId,
      name: l.organization.name,
      slug: l.organization.slug,
      businessType: l.organization.businessType,
      linkedAt: l.linkedAt,
    }));
  },

  // ---- Business Admin side: link a Customer to a Vhicasar ID ----

  /**
   * Associate one of the caller-org's Customer records with a Vhicasar ID.
   * Tenant-scoped client guarantees the customer belongs to the caller's org.
   */
  async linkCustomerToIdentity(customerId: string, dto: LinkCustomerDto) {
    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true, organizationId: true, link: { select: { id: true } } },
    });
    if (!customer) throw new NotFoundError('Customer');
    if (customer.link) throw new ConflictError('Customer is already linked to a Vhicasar ID');

    const identity = dto.vhicasarPublicId
      ? await prismaUnscoped.vhicasarId.findUnique({ where: { publicId: dto.vhicasarPublicId.toUpperCase() } })
      : await prismaUnscoped.vhicasarId.findUnique({ where: { phone: normalisePhone(dto.phone as string) } });
    if (!identity || identity.deletedAt) throw new NotFoundError('Vhicasar ID');

    // One identity ↔ one customer per org (enforced by the unique index too).
    const link = await prisma.customerLink.create({
      data: {
        vhicasarId: identity.id,
        organizationId: customer.organizationId,
        customerId: customer.id,
        source: 'INVITE',
      },
    });

    await auditService.record({
      action: 'identity.customer_linked',
      entityType: 'Customer',
      entityId: customer.id,
      after: { vhicasarId: identity.id, publicId: identity.publicId },
    });
    await emitEvent({
      name: 'CustomerLinked',
      aggregateType: 'CustomerLink',
      aggregateId: link.id,
      payload: { vhicasarId: identity.id, customerId: customer.id },
      organizationId: customer.organizationId,
    });

    return { link, identity: publicView(identity) };
  },

  async getCustomerLink(customerId: string) {
    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
      select: { id: true },
    });
    if (!customer) throw new NotFoundError('Customer');
    const link = await prisma.customerLink.findUnique({ where: { customerId } });
    if (!link) return null;
    const identity = await prismaUnscoped.vhicasarId.findUnique({ where: { id: link.vhicasarId } });
    return identity ? { link, identity: publicView(identity) } : null;
  },

  async unlinkCustomer(customerId: string): Promise<void> {
    const link = await prisma.customerLink.findUnique({ where: { customerId }, select: { id: true } });
    if (!link) throw new NotFoundError('Link');
    await prisma.customerLink.delete({ where: { customerId } });
    await auditService.record({
      action: 'identity.customer_unlinked',
      entityType: 'Customer',
      entityId: customerId,
    });
  },
};
