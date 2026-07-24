import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../shared/errors';
import { generateOpaqueToken, hashPassword, sha256 } from '../../shared/crypto';
import { prisma } from '../../infrastructure/database/prisma';
import { mailer } from '../../infrastructure/mail/mailer';
import { auditService } from '../audit/audit.service';
import type { AcceptInviteDto, InviteUserDto, UpdateMemberDto, UpdateProfileDto } from './users.dto';

const memberSelect = {
  id: true,
  isOwner: true,
  isActive: true,
  jobTitle: true,
  createdAt: true,
  user: {
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      status: true,
      lastLoginAt: true,
      emailVerifiedAt: true,
    },
  },
  role: { select: { id: true, name: true, isSystem: true } },
  branch: { select: { id: true, name: true } },
  department: { select: { id: true, name: true } },
} as const;

export const usersService = {
  async listMembers(organizationId: string) {
    const [members, invitations] = await Promise.all([
      prisma.membership.findMany({
        where: { deletedAt: null },
        select: memberSelect,
        orderBy: { createdAt: 'asc' },
      }),
      prisma.invitation.findMany({
        where: { organizationId, acceptedAt: null, expiresAt: { gt: new Date() } },
        select: { id: true, email: true, roleId: true, createdAt: true, expiresAt: true },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    return { members, invitations };
  },

  async invite(organizationId: string, invitedById: string, dto: InviteUserDto) {
    const role = await prisma.role.findFirst({ where: { id: dto.roleId } });
    if (!role) throw new NotFoundError('Role');

    const existingMember = await prisma.membership.findFirst({
      where: { user: { email: dto.email }, deletedAt: null },
    });
    if (existingMember) throw new ConflictError('This person is already a member');

    const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
    const raw = generateOpaqueToken();

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await prisma.invitation.upsert({
      where: { organizationId_email: { organizationId, email: dto.email } },
      update: {
        roleId: dto.roleId,
        invitedById,
        employeeId: dto.employeeId ?? null,
        tokenHash: sha256(raw),
        expiresAt,
        acceptedAt: null,
      },
      create: {
        organizationId,
        email: dto.email,
        roleId: dto.roleId,
        invitedById,
        employeeId: dto.employeeId ?? null,
        tokenHash: sha256(raw),
        expiresAt,
      },
    });

    await mailer.sendInvitation(dto.email, org.name, raw);
    await auditService.record({
      action: 'member.invited',
      entityType: 'INVITATION',
      after: { email: dto.email, roleId: dto.roleId },
    });
    return { message: `Invitation sent to ${dto.email}` };
  },

  async revokeInvitation(invitationId: string) {
    const inv = await prisma.invitation.findFirst({ where: { id: invitationId } });
    if (!inv) throw new NotFoundError('Invitation');
    await prisma.invitation.delete({ where: { id: invitationId } });
  },

  /**
   * Public. Creates the user when the email is new (names+password required),
   * then the membership. Returns the userId + orgId so the controller can
   * build a session via authService.
   */
  async acceptInvite(dto: AcceptInviteDto): Promise<{ userId: string; organizationId: string }> {
    const inv = await prisma.invitation.findFirst({
      where: { tokenHash: sha256(dto.token), acceptedAt: null, expiresAt: { gt: new Date() } },
    });
    if (!inv) throw new ValidationError('Invalid or expired invitation');

    let user = await prisma.user.findUnique({ where: { email: inv.email } });
    if (!user) {
      if (!dto.firstName || !dto.lastName || !dto.password) {
        throw new ValidationError('firstName, lastName and password are required', {
          needsAccount: true,
        });
      }
      user = await prisma.user.create({
        data: {
          email: inv.email,
          firstName: dto.firstName,
          lastName: dto.lastName,
          passwordHash: await hashPassword(dto.password),
          emailVerifiedAt: new Date(), // invite delivered to this address
          passwordChangedAt: new Date(),
        },
      });
    }

    // An employee invite carries the staff record it came from, so the new
    // login can inherit its department/job title.
    // Accepting is a public route, so there is no tenant context here and the
    // Prisma extension won't scope this — pin the org from the invite by hand.
    const employee = inv.employeeId
      ? await prisma.employee.findFirst({
          where: { id: inv.employeeId, organizationId: inv.organizationId, deletedAt: null },
          select: { id: true, userId: true, departmentId: true, jobTitle: true },
        })
      : null;

    const existing = await prisma.membership.findFirst({
      where: { organizationId: inv.organizationId, userId: user.id },
    });
    if (existing) {
      if (existing.deletedAt || !existing.isActive) {
        await prisma.membership.update({
          where: { id: existing.id },
          data: { deletedAt: null, isActive: true, roleId: inv.roleId },
        });
      }
    } else {
      await prisma.membership.create({
        data: {
          organizationId: inv.organizationId,
          userId: user.id,
          roleId: inv.roleId,
          ...(employee ? { departmentId: employee.departmentId, jobTitle: employee.jobTitle } : {}),
        },
      });
    }

    // Link the staff record to the account. Employee.userId is unique, so only
    // claim it when free — if this user is already another employee, leave both
    // alone rather than stealing the link or failing an otherwise-valid invite.
    if (employee && !employee.userId) {
      // Employee.userId is unique platform-wide, so this check is deliberately
      // not org-scoped: the account may already be staff in another tenant.
      const claimed = await prisma.employee.findFirst({
        where: { userId: user.id },
        select: { id: true },
      });
      if (!claimed) {
        await prisma.employee.update({ where: { id: employee.id }, data: { userId: user.id } });
      }
    }

    await prisma.invitation.update({ where: { id: inv.id }, data: { acceptedAt: new Date() } });
    return { userId: user.id, organizationId: inv.organizationId };
  },

  async updateMember(membershipId: string, actorMembershipId: string, dto: UpdateMemberDto) {
    const member = await prisma.membership.findFirst({
      where: { id: membershipId, deletedAt: null },
      include: { role: true },
    });
    if (!member) throw new NotFoundError('Member');
    if (member.isOwner && (dto.roleId || dto.isActive === false)) {
      throw new ForbiddenError('The workspace owner cannot be demoted or deactivated');
    }
    if (member.id === actorMembershipId && dto.isActive === false) {
      throw new ForbiddenError('You cannot deactivate yourself');
    }
    if (dto.roleId) {
      const role = await prisma.role.findFirst({ where: { id: dto.roleId } });
      if (!role) throw new NotFoundError('Role');
    }

    const updated = await prisma.membership.update({
      where: { id: membershipId },
      data: {
        ...(dto.roleId ? { roleId: dto.roleId } : {}),
        ...(dto.jobTitle !== undefined ? { jobTitle: dto.jobTitle } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
      select: memberSelect,
    });
    if (dto.roleId && dto.roleId !== member.roleId) {
      await auditService.record({
        action: 'member.role_changed',
        entityType: 'MEMBERSHIP',
        entityId: membershipId,
        before: { roleId: member.roleId, role: member.role.name },
        after: { roleId: dto.roleId },
      });
    }
    if (dto.isActive !== undefined && dto.isActive !== member.isActive) {
      await auditService.record({
        action: dto.isActive ? 'member.activated' : 'member.deactivated',
        entityType: 'MEMBERSHIP',
        entityId: membershipId,
      });
    }
    return updated;
  },

  async removeMember(membershipId: string, actorMembershipId: string) {
    const member = await prisma.membership.findFirst({
      where: { id: membershipId, deletedAt: null },
    });
    if (!member) throw new NotFoundError('Member');
    if (member.isOwner) throw new ForbiddenError('The workspace owner cannot be removed');
    if (member.id === actorMembershipId) throw new ForbiddenError('You cannot remove yourself');

    await prisma.membership.update({
      where: { id: membershipId },
      data: { deletedAt: new Date(), isActive: false },
    });
    await auditService.record({
      action: 'member.removed',
      entityType: 'MEMBERSHIP',
      entityId: membershipId,
      before: { userId: member.userId },
    });
  },

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    return prisma.user.update({
      where: { id: userId },
      data: {
        ...(dto.firstName ? { firstName: dto.firstName } : {}),
        ...(dto.lastName ? { lastName: dto.lastName } : {}),
        ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
        ...(dto.preferences !== undefined ? { preferences: dto.preferences } : {}),
      },
      select: { id: true, email: true, firstName: true, lastName: true, phone: true, preferences: true },
    });
  },
};
