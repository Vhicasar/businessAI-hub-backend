import { z } from 'zod';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors';
import { prisma } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { activityService } from '../crm/activity.service';
import { workflowService } from '../crm/workflow.service';

function orgId(): string {
  const id = requestContext.get()?.organizationId;
  if (!id) throw new Error('No tenant in request context');
  return id;
}
function actorMembershipId(): string | null {
  return requestContext.get()?.membershipId ?? null;
}
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Payroll settings (org.settings.payroll). Overtime pay derives from H2 attendance. */
interface PayrollConfig {
  monthlyHours: number; // divisor to get an hourly rate from monthly basic
  overtimeMultiplier: number;
  includeOvertime: boolean;
}
const DEFAULT_PAYROLL: PayrollConfig = { monthlyHours: 160, overtimeMultiplier: 1.5, includeOvertime: true };

export const payrollConfigSchema = z.object({
  monthlyHours: z.coerce.number().min(1).max(744),
  overtimeMultiplier: z.coerce.number().min(1).max(5),
  includeOvertime: z.boolean(),
});
export const payComponentSchema = z.object({
  name: z.string().trim().min(1).max(80),
  code: z.string().trim().min(1).max(20).toUpperCase(),
  type: z.enum(['EARNING', 'DEDUCTION']),
  calc: z.enum(['FIXED', 'PERCENT_OF_BASIC']).default('FIXED'),
  amount: z.coerce.number().min(0).max(1_000_000_000),
  appliesToAll: z.boolean().default(false),
  isActive: z.boolean().default(true),
});
export const assignComponentSchema = z.object({
  employeeId: z.string().min(1),
  componentId: z.string().min(1),
  amountOverride: z.coerce.number().min(0).nullable().optional(),
});
export const createRunSchema = z.object({
  periodStart: z.coerce.date(),
  periodEnd: z.coerce.date(),
  notes: z.string().trim().max(500).nullable().optional(),
});

async function readConfig(): Promise<PayrollConfig> {
  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: orgId() },
    select: { settings: true },
  });
  const cfg = ((org.settings as Record<string, unknown>) ?? {}).payroll as Partial<PayrollConfig> | undefined;
  return { ...DEFAULT_PAYROLL, ...(cfg ?? {}) };
}

/**
 * Compute one payslip. Pure so the maths is testable without a database.
 * Deductions are applied to gross; PERCENT_OF_BASIC always resolves off basic.
 */
export function computePayslip(input: {
  basicSalary: number;
  overtimeMinutes: number;
  components: { name: string; code: string; type: 'EARNING' | 'DEDUCTION'; calc: 'FIXED' | 'PERCENT_OF_BASIC'; amount: number }[];
  config: PayrollConfig;
}) {
  const { basicSalary, overtimeMinutes, components, config } = input;
  const lines: { name: string; code: string; type: string; amount: number }[] = [];

  const hourlyRate = config.monthlyHours > 0 ? basicSalary / config.monthlyHours : 0;
  const overtimePay =
    config.includeOvertime && overtimeMinutes > 0
      ? round2((overtimeMinutes / 60) * hourlyRate * config.overtimeMultiplier)
      : 0;

  let earnings = 0;
  let deductions = 0;
  for (const c of components) {
    const amount = round2(c.calc === 'PERCENT_OF_BASIC' ? (basicSalary * c.amount) / 100 : c.amount);
    lines.push({ name: c.name, code: c.code, type: c.type, amount });
    if (c.type === 'EARNING') earnings = round2(earnings + amount);
    else deductions = round2(deductions + amount);
  }

  const grossPay = round2(basicSalary + overtimePay + earnings);
  const netPay = round2(grossPay - deductions);
  return { basicSalary: round2(basicSalary), overtimePay, grossPay, totalDeductions: deductions, netPay, lines };
}

const runSelect = {
  id: true, reference: true, periodStart: true, periodEnd: true, status: true, currency: true,
  totalGross: true, totalDeductions: true, totalNet: true, employeeCount: true, notes: true,
  approvedAt: true, paidAt: true, createdAt: true,
} as const;

async function nextReference(): Promise<string> {
  const year = new Date().getFullYear();
  const count = await prisma.payrollRun.count({ where: { reference: { startsWith: `PR-${year}-` } } });
  return `PR-${year}-${String(count + 1).padStart(4, '0')}`;
}

export const payrollService = {
  // -------------------------------------------------------------- settings
  async getConfig() {
    return readConfig();
  },
  async saveConfig(dto: z.infer<typeof payrollConfigSchema>) {
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId() }, select: { settings: true } });
    const settings = (org.settings as Record<string, unknown>) ?? {};
    await prisma.organization.update({ where: { id: orgId() }, data: { settings: { ...settings, payroll: dto } } });
    return dto;
  },

  // ------------------------------------------------------------ components
  async listComponents() {
    return prisma.payComponent.findMany({ where: { isActive: true }, orderBy: [{ type: 'asc' }, { name: 'asc' }] });
  },
  async createComponent(dto: z.infer<typeof payComponentSchema>) {
    const dup = await prisma.payComponent.findFirst({ where: { code: dto.code } });
    if (dup) throw new ConflictError(`A pay component with code "${dto.code}" already exists`);
    return prisma.payComponent.create({ data: { organizationId: orgId(), ...dto } });
  },
  async updateComponent(id: string, dto: z.infer<typeof payComponentSchema>) {
    const existing = await prisma.payComponent.findFirst({ where: { id } });
    if (!existing) throw new NotFoundError('Pay component');
    return prisma.payComponent.update({ where: { id }, data: dto });
  },
  async deleteComponent(id: string) {
    await prisma.employeePayComponent.deleteMany({ where: { componentId: id } });
    await prisma.payComponent.deleteMany({ where: { id } });
    return { deleted: true };
  },
  async assignComponent(dto: z.infer<typeof assignComponentSchema>) {
    const [employee, component] = await Promise.all([
      prisma.employee.findFirst({ where: { id: dto.employeeId, deletedAt: null } }),
      prisma.payComponent.findFirst({ where: { id: dto.componentId } }),
    ]);
    if (!employee) throw new NotFoundError('Employee');
    if (!component) throw new NotFoundError('Pay component');
    const existing = await prisma.employeePayComponent.findFirst({
      where: { employeeId: dto.employeeId, componentId: dto.componentId },
    });
    if (existing) {
      return prisma.employeePayComponent.update({
        where: { id: existing.id },
        data: { amountOverride: dto.amountOverride ?? null },
      });
    }
    return prisma.employeePayComponent.create({
      data: {
        organizationId: orgId(),
        employeeId: dto.employeeId,
        componentId: dto.componentId,
        amountOverride: dto.amountOverride ?? null,
      },
    });
  },
  async employeeComponents(employeeId: string) {
    return prisma.employeePayComponent.findMany({
      where: { employeeId },
      select: { id: true, amountOverride: true, component: { select: { id: true, name: true, code: true, type: true, calc: true, amount: true } } },
    });
  },
  async unassignComponent(id: string) {
    await prisma.employeePayComponent.deleteMany({ where: { id } });
    return { deleted: true };
  },

  // ------------------------------------------------------------ payroll runs
  async listRuns() {
    return prisma.payrollRun.findMany({ select: runSelect, orderBy: { createdAt: 'desc' }, take: 100 });
  },

  async getRun(id: string) {
    const run = await prisma.payrollRun.findFirst({ where: { id }, select: runSelect });
    if (!run) throw new NotFoundError('Payroll run');
    const payslips = await prisma.payslip.findMany({
      where: { payrollRunId: id },
      select: {
        id: true, basicSalary: true, overtimePay: true, grossPay: true, totalDeductions: true,
        netPay: true, currency: true, overtimeMinutes: true, lines: true,
        employee: { select: { id: true, firstName: true, lastName: true, employeeNumber: true } },
      },
      orderBy: { netPay: 'desc' },
    });
    return { ...run, payslips };
  },

  /**
   * Build a DRAFT run: one payslip per active employee, pulling overtime from
   * attendance in the period and applying org-wide + per-employee components.
   */
  async createRun(dto: z.infer<typeof createRunSchema>) {
    if (dto.periodEnd < dto.periodStart) throw new ValidationError('Period end cannot be before period start');

    const overlap = await prisma.payrollRun.findFirst({
      where: {
        status: { in: ['DRAFT', 'APPROVED', 'PAID'] },
        periodStart: { lte: dto.periodEnd },
        periodEnd: { gte: dto.periodStart },
      },
    });
    if (overlap) throw new ConflictError(`Payroll run ${overlap.reference} already covers that period`);

    const [org, config, employees, allComponents] = await Promise.all([
      prisma.organization.findUniqueOrThrow({ where: { id: orgId() }, select: { currency: true } }),
      readConfig(),
      prisma.employee.findMany({
        where: { deletedAt: null, status: { in: ['ACTIVE', 'ON_LEAVE'] } },
        select: { id: true, firstName: true, lastName: true, salary: true },
      }),
      prisma.payComponent.findMany({ where: { isActive: true } }),
    ]);
    if (employees.length === 0) throw new ValidationError('No active employees to run payroll for');

    const [assignments, attendance] = await Promise.all([
      prisma.employeePayComponent.findMany({
        where: { employeeId: { in: employees.map((e) => e.id) } },
        select: { employeeId: true, componentId: true, amountOverride: true },
      }),
      prisma.attendanceRecord.groupBy({
        by: ['employeeId'],
        where: { employeeId: { in: employees.map((e) => e.id) }, date: { gte: dto.periodStart, lte: dto.periodEnd } },
        _sum: { overtimeMinutes: true },
      }),
    ]);

    const run = await prisma.payrollRun.create({
      data: {
        organizationId: orgId(),
        reference: await nextReference(),
        periodStart: dto.periodStart,
        periodEnd: dto.periodEnd,
        status: 'DRAFT',
        currency: org.currency,
        notes: dto.notes ?? null,
      },
      select: runSelect,
    });

    let totalGross = 0;
    let totalDeductions = 0;
    let totalNet = 0;

    for (const emp of employees) {
      const basic = emp.salary ? Number(emp.salary) : 0;
      const otMinutes = attendance.find((a) => a.employeeId === emp.id)?._sum.overtimeMinutes ?? 0;

      // Org-wide components + this employee's assigned ones (override wins).
      const mine = assignments.filter((a) => a.employeeId === emp.id);
      const applicable = allComponents
        .filter((c) => c.appliesToAll || mine.some((m) => m.componentId === c.id))
        .map((c) => {
          const override = mine.find((m) => m.componentId === c.id)?.amountOverride;
          return {
            name: c.name,
            code: c.code,
            type: c.type as 'EARNING' | 'DEDUCTION',
            calc: c.calc as 'FIXED' | 'PERCENT_OF_BASIC',
            amount: override ?? c.amount,
          };
        });

      const slip = computePayslip({ basicSalary: basic, overtimeMinutes: otMinutes, components: applicable, config });
      await prisma.payslip.create({
        data: {
          organizationId: orgId(),
          payrollRunId: run.id,
          employeeId: emp.id,
          basicSalary: slip.basicSalary,
          overtimePay: slip.overtimePay,
          grossPay: slip.grossPay,
          totalDeductions: slip.totalDeductions,
          netPay: slip.netPay,
          currency: org.currency,
          overtimeMinutes: otMinutes,
          lines: slip.lines,
        },
      });
      totalGross = round2(totalGross + slip.grossPay);
      totalDeductions = round2(totalDeductions + slip.totalDeductions);
      totalNet = round2(totalNet + slip.netPay);
    }

    return prisma.payrollRun.update({
      where: { id: run.id },
      data: { totalGross, totalDeductions, totalNet, employeeCount: employees.length },
      select: runSelect,
    });
  },

  async approveRun(id: string) {
    const run = await prisma.payrollRun.findFirst({ where: { id } });
    if (!run) throw new NotFoundError('Payroll run');
    if (run.status !== 'DRAFT') throw new ConflictError('Only draft runs can be approved');
    return prisma.payrollRun.update({
      where: { id },
      data: { status: 'APPROVED', approvedById: actorMembershipId(), approvedAt: new Date() },
      select: runSelect,
    });
  },

  /** Mark an approved run paid. Emits `payroll.paid` for the automation engine. */
  async markPaid(id: string) {
    const run = await prisma.payrollRun.findFirst({ where: { id } });
    if (!run) throw new NotFoundError('Payroll run');
    if (run.status !== 'APPROVED') throw new ConflictError('Only approved runs can be marked paid');

    const updated = await prisma.payrollRun.update({
      where: { id },
      data: { status: 'PAID', paidAt: new Date() },
      select: runSelect,
    });

    const payslips = await prisma.payslip.findMany({ where: { payrollRunId: id }, select: { employeeId: true, netPay: true } });
    for (const p of payslips) {
      await activityService.record({
        type: 'SYSTEM',
        entityType: 'EMPLOYEE',
        entityId: p.employeeId,
        title: `Payroll paid — ${updated.reference}`,
        body: `Net ${updated.currency} ${Number(p.netPay).toFixed(2)}`,
      });
    }
    // NOTE: there is no Accounting module in this codebase yet, so no GL entry is
    // posted. This event is the hand-off point for it (and any notifications).
    await workflowService.dispatch(
      'payroll.paid',
      { reference: updated.reference, totalNet: Number(updated.totalNet), employeeCount: updated.employeeCount, currency: updated.currency },
      { entityType: 'EMPLOYEE', entityId: payslips[0]?.employeeId ?? id },
    );
    return updated;
  },

  async cancelRun(id: string) {
    const run = await prisma.payrollRun.findFirst({ where: { id } });
    if (!run) throw new NotFoundError('Payroll run');
    if (run.status === 'PAID') throw new ConflictError('A paid run cannot be cancelled');
    await prisma.payslip.deleteMany({ where: { payrollRunId: id } });
    return prisma.payrollRun.update({ where: { id }, data: { status: 'CANCELLED' }, select: runSelect });
  },
};
