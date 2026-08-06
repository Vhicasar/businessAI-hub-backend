import { Prisma } from '@prisma/client';
import type { CashMovementType, PaymentSession, Payment } from '@prisma/client';
import { prisma, prismaUnscoped } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { emitEvent } from '../../shared/domain-events';
import { AppError, ConflictError, ForbiddenError, NotFoundError } from '../../shared/errors';
import { money, ZERO } from '../../shared/money';
import { auditService } from '../audit/audit.service';
import { vhicasarPayService } from '../payments/vhicasar-pay.service';
import type {
  CashMovementDto,
  CashSaleDto,
  CloseShiftDto,
  CreateRegisterDto,
  OpenShiftDto,
  PayCheckoutDto,
  UpdateRegisterDto,
} from './pos.dto';

/**
 * Point of Sale (System Bible III / Database Bible §8). Registers + cashier
 * shifts + cash-drawer movements + receipts, layered on the platform. Sales are
 * taken through Vhicasar Pay (dynamic QR / wallet) or recorded as cash against
 * the open shift; every completed sale issues a sequential receipt.
 */

// Signed contribution of each cash movement to the drawer total.
const CASH_SIGN: Record<CashMovementType, number> = {
  OPENING_FLOAT: 1,
  SALE: 1,
  PAYIN: 1,
  PAYOUT: -1,
  REFUND: -1,
  DROP: -1,
};

function requireOrg(): string {
  const orgId = requestContext.get()?.organizationId;
  if (!orgId) throw new ForbiddenError('Organization context required');
  return orgId;
}

async function nextReceiptNumber(organizationId: string): Promise<number> {
  const agg = await prismaUnscoped.receipt.aggregate({
    where: { organizationId },
    _max: { number: true },
  });
  return (agg._max.number ?? 0) + 1;
}

export const posService = {
  // ------------------------------------------------------------- Registers

  async createRegister(dto: CreateRegisterDto) {
    return prisma.register.create({
      data: { organizationId: requireOrg(), name: dto.name, code: dto.code, branchId: dto.branchId ?? null },
    });
  },

  async listRegisters() {
    return prisma.register.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
  },

  async getRegister(id: string) {
    const register = await prisma.register.findUnique({ where: { id } });
    if (!register || register.deletedAt) throw new NotFoundError('Register');
    const openShift = await prisma.posShift.findFirst({ where: { registerId: id, status: 'OPEN' } });
    return { ...register, openShift };
  },

  async updateRegister(id: string, dto: UpdateRegisterDto) {
    await this.getRegister(id);
    return prisma.register.update({ where: { id }, data: dto });
  },

  // ---------------------------------------------------------------- Shifts

  async openShift(dto: OpenShiftDto) {
    const existing = await prisma.posShift.findFirst({
      where: { registerId: dto.registerId, status: 'OPEN' },
    });
    if (existing) throw new ConflictError('Register already has an open shift');

    const ctx = requestContext.get();
    const organizationId = requireOrg();
    const float = money(dto.openingFloat);
    const shift = await prisma.posShift.create({
      data: {
        organizationId,
        registerId: dto.registerId,
        currency: dto.currency,
        openingFloat: float,
        openedByMembershipId: ctx?.membershipId ?? null,
        movements: float.greaterThan(ZERO)
          ? {
              create: [
                {
                  organizationId: requireOrg(),
                  type: 'OPENING_FLOAT',
                  amount: float,
                  createdByMembershipId: ctx?.membershipId ?? null,
                },
              ],
            }
          : undefined,
      },
    });
    return shift;
  },

  async currentShift(registerId: string) {
    return prisma.posShift.findFirst({
      where: { registerId, status: 'OPEN' },
      include: { movements: { orderBy: { createdAt: 'desc' }, take: 20 } },
    });
  },

  async addCashMovement(shiftId: string, dto: CashMovementDto) {
    const shift = await prisma.posShift.findUnique({ where: { id: shiftId }, select: { status: true } });
    if (!shift) throw new NotFoundError('Shift');
    if (shift.status !== 'OPEN') throw new ConflictError('Shift is closed');
    const ctx = requestContext.get();
    return prisma.cashMovement.create({
      data: {
        organizationId: requireOrg(),
        shiftId,
        type: dto.type,
        amount: money(dto.amount),
        reason: dto.reason ?? null,
        createdByMembershipId: ctx?.membershipId ?? null,
      },
    });
  },

  async closeShift(shiftId: string, dto: CloseShiftDto) {
    const shift = await prisma.posShift.findUnique({
      where: { id: shiftId },
      include: { movements: true },
    });
    if (!shift) throw new NotFoundError('Shift');
    if (shift.status !== 'OPEN') throw new ConflictError('Shift is already closed');

    let expected = ZERO;
    for (const m of shift.movements) expected = expected.add(money(m.amount).mul(CASH_SIGN[m.type]));
    const counted = money(dto.countedCash);
    const variance = counted.sub(expected);
    const ctx = requestContext.get();

    const closed = await prisma.posShift.update({
      where: { id: shiftId },
      data: {
        status: 'CLOSED',
        countedCash: counted,
        expectedCash: expected,
        variance,
        notes: dto.notes ?? null,
        closedByMembershipId: ctx?.membershipId ?? null,
        closedAt: new Date(),
      },
    });

    await auditService.record({
      action: 'pos.shift_closed',
      entityType: 'PosShift',
      entityId: shiftId,
      after: { expected: expected.toFixed(2), counted: counted.toFixed(2), variance: variance.toFixed(2) },
    });
    await emitEvent({ name: 'ShiftClosed', aggregateType: 'PosShift', aggregateId: shiftId, payload: { variance: variance.toFixed(2) } });

    return {
      id: closed.id,
      status: closed.status,
      openingFloat: money(shift.openingFloat).toFixed(2),
      expectedCash: expected.toFixed(2),
      countedCash: counted.toFixed(2),
      variance: variance.toFixed(2),
      currency: shift.currency,
    };
  },

  async shiftReport(shiftId: string) {
    const shift = await prisma.posShift.findUnique({
      where: { id: shiftId },
      include: { movements: true, receipts: true },
    });
    if (!shift) throw new NotFoundError('Shift');

    const byMethod: Record<string, string> = {};
    let salesTotal = ZERO;
    for (const r of shift.receipts) {
      salesTotal = salesTotal.add(money(r.total));
      byMethod[r.method] = money(byMethod[r.method] ?? '0').add(money(r.total)).toFixed(2);
    }
    let cashIn = ZERO;
    for (const m of shift.movements) cashIn = cashIn.add(money(m.amount).mul(CASH_SIGN[m.type]));

    return {
      shiftId: shift.id,
      status: shift.status,
      currency: shift.currency,
      salesCount: shift.receipts.length,
      salesTotal: salesTotal.toFixed(2),
      byMethod,
      cashInDrawer: cashIn.toFixed(2),
      openedAt: shift.openedAt,
      closedAt: shift.closedAt,
    };
  },

  // ----------------------------------------------------------------- Sales

  /** Record a cash sale against the shift and issue a receipt. */
  async recordCashSale(shiftId: string, dto: CashSaleDto) {
    const organizationId = requireOrg();
    const shift = await prisma.posShift.findUnique({ where: { id: shiftId } });
    if (!shift) throw new NotFoundError('Shift');
    if (shift.status !== 'OPEN') throw new ConflictError('Shift is closed');
    const total = money(dto.amount);
    const ctx = requestContext.get();

    await prisma.cashMovement.create({
      data: {
        organizationId,
        shiftId,
        type: 'SALE',
        amount: total,
        createdByMembershipId: ctx?.membershipId ?? null,
      },
    });
    const receipt = await this.issueReceipt({
      organizationId,
      shiftId,
      registerId: shift.registerId,
      method: 'CASH',
      total,
      currency: dto.currency,
      customerVhicasarId: dto.customerVhicasarId ?? null,
    });
    return receipt;
  },

  /** Create a Vhicasar Pay session for a POS sale (customer scans the QR). */
  async createPayCheckout(shiftId: string, dto: PayCheckoutDto) {
    const shift = await prisma.posShift.findUnique({ where: { id: shiftId } });
    if (!shift) throw new NotFoundError('Shift');
    if (shift.status !== 'OPEN') throw new ConflictError('Shift is closed');
    return vhicasarPayService.createSession(
      {
        amount: dto.amount,
        currency: dto.currency,
        description: dto.description,
        method: 'WALLET',
        registerId: shift.registerId,
        expiresInSec: dto.expiresInSec,
      },
      requestContext.get()?.membershipId ?? null
    );
  },

  /**
   * Hook invoked by Vhicasar Pay when a session completes. If the session was a
   * POS checkout (has a register), issue a receipt against that register's open
   * shift and publish SaleCompleted. Called via dynamic import to avoid a cycle.
   */
  async onSessionPaid(session: PaymentSession, payment: Payment): Promise<void> {
    if (!session.registerId) return;
    const shift = await prismaUnscoped.posShift.findFirst({
      where: { registerId: session.registerId, status: 'OPEN' },
      select: { id: true },
    });
    await this.issueReceipt({
      organizationId: session.organizationId,
      shiftId: shift?.id ?? null,
      registerId: session.registerId,
      method: 'WALLET',
      total: money(session.amount),
      currency: session.currency,
      paymentId: payment.id,
      paymentSessionId: session.id,
      customerVhicasarId: session.customerVhicasarId,
    });
  },

  /** Create a sequential receipt (retries on the rare number collision). */
  async issueReceipt(input: {
    organizationId: string;
    shiftId?: string | null;
    registerId?: string | null;
    method: string;
    total: Prisma.Decimal;
    currency: string;
    paymentId?: string | null;
    paymentSessionId?: string | null;
    customerVhicasarId?: string | null;
  }) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const number = await nextReceiptNumber(input.organizationId);
        const receipt = await prismaUnscoped.receipt.create({
          data: {
            organizationId: input.organizationId,
            number,
            shiftId: input.shiftId ?? null,
            registerId: input.registerId ?? null,
            method: input.method,
            total: input.total,
            currency: input.currency,
            paymentId: input.paymentId ?? null,
            paymentSessionId: input.paymentSessionId ?? null,
            customerVhicasarId: input.customerVhicasarId ?? null,
          },
        });
        await emitEvent({
          name: 'SaleCompleted',
          aggregateType: 'Receipt',
          aggregateId: receipt.id,
          payload: { total: input.total.toFixed(2), currency: input.currency, method: input.method },
          organizationId: input.organizationId,
        });
        await emitEvent({
          name: 'ReceiptIssued',
          aggregateType: 'Receipt',
          aggregateId: receipt.id,
          payload: { number: receipt.number },
          organizationId: input.organizationId,
        });
        return {
          id: receipt.id,
          number: receipt.number,
          method: receipt.method,
          total: input.total.toFixed(2),
          currency: receipt.currency,
          issuedAt: receipt.issuedAt,
        };
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') continue;
        throw e;
      }
    }
    throw new AppError('RECEIPT_ALLOCATION_FAILED', 500, 'Could not allocate a receipt number');
  },
};
