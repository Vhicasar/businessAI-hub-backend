import { z } from 'zod';
import { ConflictError, ForbiddenError, NotFoundError } from '../../shared/errors';
import { prisma } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { callerHasPermission } from '../roles/role-permissions';
import { filesService } from '../files/files.service';

function orgId(): string {
  const id = requestContext.get()?.organizationId;
  if (!id) throw new Error('No tenant in request context');
  return id;
}

const EMPLOYMENT_TYPES = ['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN'] as const;
const STATUSES = ['ACTIVE', 'ON_LEAVE', 'TERMINATED'] as const;

export const listEmployeesSchema = z.object({
  status: z.enum(STATUSES).optional(),
  departmentId: z.string().optional(),
  search: z.string().trim().max(120).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export const createEmployeeSchema = z.object({
  /** Optional: preserve the ID from a system you're migrating off. Auto-generated when omitted. */
  employeeNumber: z.string().trim().min(1).max(40).nullable().optional(),
  status: z.enum(STATUSES).optional(),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  email: z.string().trim().toLowerCase().email().nullable().optional(),
  phone: z.string().trim().max(32).nullable().optional(),
  jobTitle: z.string().trim().max(120).nullable().optional(),
  departmentId: z.string().nullable().optional(),
  branchId: z.string().nullable().optional(),
  employmentType: z.enum(EMPLOYMENT_TYPES).default('FULL_TIME'),
  salary: z.coerce.number().nonnegative().nullable().optional(),
  hiredAt: z.coerce.date().nullable().optional(),
  /** Profile photo — an already-uploaded File id (see /files). */
  avatarFileId: z.string().min(1).nullable().optional(),
});
export const updateEmployeeSchema = createEmployeeSchema.partial().extend({
  status: z.enum(STATUSES).optional(),
});
export const departmentSchema = z.object({
  name: z.string().trim().min(1).max(120),
  code: z.string().trim().min(1).max(20).toUpperCase(),
  isActive: z.boolean().default(true),
});

const employeeSelect = {
  id: true, employeeNumber: true, firstName: true, lastName: true, email: true, phone: true,
  jobTitle: true, departmentId: true, branchId: true, employmentType: true, status: true,
  salary: true, currency: true, hiredAt: true, terminatedAt: true, createdAt: true, avatarFileId: true,
} as const;

/** Attach an avatarUrl to a page of rows, resolved from avatarFileId. */
async function withAvatars<T extends { avatarFileId: string | null }>(rows: T[]): Promise<(T & { avatarUrl: string | null })[]> {
  const urls = await filesService.urlMap(rows.map((r) => r.avatarFileId));
  return rows.map((r) => ({ ...r, avatarUrl: r.avatarFileId ? urls.get(r.avatarFileId) ?? null : null }));
}

/** Same, for a single row. */
async function withAvatar<T extends { avatarFileId: string | null }>(row: T): Promise<T & { avatarUrl: string | null }> {
  return { ...row, avatarUrl: await filesService.urlFor(row.avatarFileId) };
}

async function nextNumber(): Promise<string> {
  const count = await prisma.employee.count({ where: { employeeNumber: { startsWith: 'EMP-' } } });
  return `EMP-${String(count + 1).padStart(5, '0')}`;
}

/**
 * Salary rides along on the employee record, so `employees.read` would expose
 * every wage to anyone who can open the staff directory. Reading pay is its own
 * decision: strip the field unless the caller was granted it explicitly.
 */
export async function canSeeSalary(): Promise<boolean> {
  return callerHasPermission('employees.view_salary', 'payroll.read');
}

/** Setting pay is as sensitive as reading it — don't let update smuggle it in. */
async function assertMaySetSalary(salary: unknown): Promise<void> {
  if (salary === undefined) return;
  if (await canSeeSalary()) return;
  throw new ForbiddenError('Missing permission: employees.view_salary');
}

type MaybePaid = { salary?: unknown };
function redactSalary<T extends MaybePaid>(row: T): T {
  // Delete rather than null it: a null would read as "no salary recorded",
  // which is a different (and misleading) statement from "you can't see this".
  const { salary: _salary, ...rest } = row;
  return rest as T;
}

export const employeesService = {
  async list(dto: z.infer<typeof listEmployeesSchema>) {
    const rows = await prisma.employee.findMany({
      where: {
        deletedAt: null,
        ...(dto.status ? { status: dto.status } : {}),
        ...(dto.departmentId ? { departmentId: dto.departmentId } : {}),
        ...(dto.search
          ? {
              OR: [
                { firstName: { contains: dto.search, mode: 'insensitive' as const } },
                { lastName: { contains: dto.search, mode: 'insensitive' as const } },
                { employeeNumber: { contains: dto.search, mode: 'insensitive' as const } },
                { email: { contains: dto.search, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      select: employeeSelect,
      orderBy: { createdAt: 'desc' },
      take: dto.limit + 1,
      ...(dto.cursor ? { cursor: { id: dto.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > dto.limit;
    const page = hasMore ? rows.slice(0, dto.limit) : rows;
    const priced = (await canSeeSalary()) ? page : page.map(redactSalary);
    const items = await withAvatars(priced);
    return { items, nextCursor: hasMore ? items[items.length - 1]?.id ?? null : null };
  },

  async get(id: string) {
    const employee = await prisma.employee.findFirst({ where: { id, deletedAt: null }, select: employeeSelect });
    if (!employee) throw new NotFoundError('Employee');
    const priced = (await canSeeSalary()) ? employee : redactSalary(employee);
    return withAvatar(priced);
  },

  async create(dto: z.infer<typeof createEmployeeSchema>) {
    await assertMaySetSalary(dto.salary);
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId() }, select: { currency: true } });
    // An explicit number (e.g. carried over from another system) must stay unique.
    if (dto.employeeNumber) {
      const dup = await prisma.employee.findFirst({ where: { employeeNumber: dto.employeeNumber, deletedAt: null } });
      if (dup) throw new ConflictError(`Employee number "${dto.employeeNumber}" is already in use`);
    }
    const created = await prisma.employee.create({
      data: {
        organizationId: orgId(),
        employeeNumber: dto.employeeNumber || (await nextNumber()),
        status: dto.status ?? 'ACTIVE',
        firstName: dto.firstName,
        lastName: dto.lastName,
        email: dto.email ?? null,
        phone: dto.phone ?? null,
        jobTitle: dto.jobTitle ?? null,
        departmentId: dto.departmentId ?? null,
        branchId: dto.branchId ?? null,
        employmentType: dto.employmentType,
        salary: dto.salary ?? null,
        currency: org.currency,
        hiredAt: dto.hiredAt ?? null,
        avatarFileId: dto.avatarFileId ?? null,
      },
      select: employeeSelect,
    });
    return withAvatar(created);
  },

  async update(id: string, dto: z.infer<typeof updateEmployeeSchema>) {
    await assertMaySetSalary(dto.salary);
    const existing = await prisma.employee.findFirst({ where: { id, deletedAt: null }, select: { avatarFileId: true } });
    if (!existing) throw new NotFoundError('Employee');
    const updated = await prisma.employee.update({
      where: { id },
      data: {
        ...(dto.firstName !== undefined ? { firstName: dto.firstName } : {}),
        ...(dto.lastName !== undefined ? { lastName: dto.lastName } : {}),
        ...(dto.email !== undefined ? { email: dto.email } : {}),
        ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
        ...(dto.jobTitle !== undefined ? { jobTitle: dto.jobTitle } : {}),
        ...(dto.departmentId !== undefined ? { departmentId: dto.departmentId } : {}),
        ...(dto.branchId !== undefined ? { branchId: dto.branchId } : {}),
        ...(dto.employmentType !== undefined ? { employmentType: dto.employmentType } : {}),
        ...(dto.salary !== undefined ? { salary: dto.salary } : {}),
        ...(dto.hiredAt !== undefined ? { hiredAt: dto.hiredAt } : {}),
        ...(dto.avatarFileId !== undefined ? { avatarFileId: dto.avatarFileId } : {}),
        ...(dto.status !== undefined
          ? { status: dto.status, ...(dto.status === 'TERMINATED' ? { terminatedAt: new Date() } : {}) }
          : {}),
      },
      select: employeeSelect,
    });
    // Replaced avatar → clean up the old file so orphans don't accumulate.
    if (dto.avatarFileId !== undefined && existing.avatarFileId && existing.avatarFileId !== dto.avatarFileId) {
      await filesService.remove(existing.avatarFileId).catch(() => undefined);
    }
    return withAvatar(updated);
  },

  async remove(id: string) {
    const existing = await prisma.employee.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new NotFoundError('Employee');
    await prisma.employee.update({ where: { id }, data: { deletedAt: new Date(), status: 'TERMINATED' } });
    return { deleted: true };
  },

  /** Departments for the employee-form dropdown. */
  async listDepartments() {
    const rows = await prisma.department.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true, code: true, isActive: true },
      orderBy: { name: 'asc' },
    });
    const counts = await prisma.employee.groupBy({
      by: ['departmentId'],
      where: { deletedAt: null, departmentId: { in: rows.map((r) => r.id) } },
      _count: { _all: true },
    });
    return rows.map((r) => ({
      ...r,
      employeeCount: counts.find((c) => c.departmentId === r.id)?._count._all ?? 0,
    }));
  },

  async createDepartment(dto: z.infer<typeof departmentSchema>) {
    const dup = await prisma.department.findFirst({ where: { code: dto.code, deletedAt: null } });
    if (dup) throw new ConflictError(`A department with code "${dto.code}" already exists`);
    return prisma.department.create({
      data: { organizationId: orgId(), name: dto.name, code: dto.code, isActive: dto.isActive },
      select: { id: true, name: true, code: true, isActive: true },
    });
  },

  async updateDepartment(id: string, dto: z.infer<typeof departmentSchema>) {
    const existing = await prisma.department.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new NotFoundError('Department');
    if (dto.code !== existing.code) {
      const dup = await prisma.department.findFirst({ where: { code: dto.code, deletedAt: null, id: { not: id } } });
      if (dup) throw new ConflictError(`A department with code "${dto.code}" already exists`);
    }
    return prisma.department.update({
      where: { id },
      data: { name: dto.name, code: dto.code, isActive: dto.isActive },
      select: { id: true, name: true, code: true, isActive: true },
    });
  },

  async deleteDepartment(id: string) {
    const inUse = await prisma.employee.count({ where: { departmentId: id, deletedAt: null } });
    if (inUse > 0) throw new ConflictError('Department has employees — reassign them first');
    await prisma.department.update({ where: { id }, data: { deletedAt: new Date(), isActive: false } });
    return { deleted: true };
  },
};
