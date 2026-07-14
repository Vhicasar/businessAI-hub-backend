import { z } from 'zod';
import { ConflictError, ForbiddenError, NotFoundError } from '../../shared/errors';
import { prisma } from '../../infrastructure/database/prisma';
import { invalidateRoleCache } from '../../presentation/http/middleware/require-permission';
import { ALL_PERMISSION_KEYS } from '../../shared/permissions';

export const roleSchema = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(300).nullable().optional(),
  permissions: z
    .array(z.string())
    .min(1)
    .refine((keys) => keys.every((k) => ALL_PERMISSION_KEYS.includes(k)), {
      message: 'Unknown permission key',
    }),
});

export type RoleDto = z.infer<typeof roleSchema>;

const roleSelect = {
  id: true,
  name: true,
  description: true,
  isSystem: true,
  createdAt: true,
  permissions: { select: { permission: { select: { key: true } } } },
  _count: { select: { memberships: true } },
} as const;

function shape(role: {
  id: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  createdAt: Date;
  permissions: { permission: { key: string } }[];
  _count: { memberships: number };
}) {
  return {
    id: role.id,
    name: role.name,
    description: role.description,
    isSystem: role.isSystem,
    createdAt: role.createdAt,
    permissions: role.permissions.map((p) => p.permission.key),
    memberCount: role._count.memberships,
  };
}

async function permissionIds(keys: string[]): Promise<string[]> {
  const rows = await prisma.permission.findMany({
    where: { key: { in: keys } },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

export const rolesService = {
  async list() {
    const roles = await prisma.role.findMany({ select: roleSelect, orderBy: { createdAt: 'asc' } });
    return roles.map(shape);
  },

  async catalog() {
    return prisma.permission.findMany({
      select: { key: true, module: true, description: true },
      orderBy: [{ module: 'asc' }, { key: 'asc' }],
    });
  },

  async create(organizationId: string, dto: RoleDto) {
    const dup = await prisma.role.findFirst({ where: { name: dto.name } });
    if (dup) throw new ConflictError('A role with this name already exists');

    const ids = await permissionIds(dto.permissions);
    const role = await prisma.role.create({
      data: {
        organizationId,
        name: dto.name,
        description: dto.description ?? null,
        isSystem: false,
        permissions: { create: ids.map((permissionId) => ({ permissionId })) },
      },
      select: roleSelect,
    });
    return shape(role);
  },

  async update(roleId: string, dto: RoleDto) {
    const role = await prisma.role.findFirst({ where: { id: roleId } });
    if (!role) throw new NotFoundError('Role');
    if (role.isSystem) throw new ForbiddenError('System roles cannot be edited');

    const ids = await permissionIds(dto.permissions);
    const updated = await prisma.$transaction(async (tx) => {
      await tx.rolePermission.deleteMany({ where: { roleId } });
      return tx.role.update({
        where: { id: roleId },
        data: {
          name: dto.name,
          description: dto.description ?? null,
          permissions: { create: ids.map((permissionId) => ({ permissionId })) },
        },
        select: roleSelect,
      });
    });
    invalidateRoleCache(roleId);
    return shape(updated);
  },

  async remove(roleId: string) {
    const role = await prisma.role.findFirst({
      where: { id: roleId },
      include: { _count: { select: { memberships: true } } },
    });
    if (!role) throw new NotFoundError('Role');
    if (role.isSystem) throw new ForbiddenError('System roles cannot be deleted');
    if (role._count.memberships > 0) {
      throw new ConflictError('Reassign members before deleting this role', {
        memberCount: role._count.memberships,
      });
    }
    await prisma.$transaction([
      prisma.rolePermission.deleteMany({ where: { roleId } }),
      prisma.role.delete({ where: { id: roleId } }),
    ]);
    invalidateRoleCache(roleId);
  },
};
