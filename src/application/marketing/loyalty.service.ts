import { z } from 'zod';
import { prisma } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { NotFoundError, ValidationError } from '../../shared/errors';

const oid = () => { const id = requestContext.get()?.organizationId; if (!id) throw new Error('No tenant'); return id; };
export const loyaltyProgramSchema = z.object({ name: z.string().trim().min(2).max(100), pointsPerAmount: z.coerce.number().positive().max(10000), redeemRate: z.coerce.number().positive().max(10000), expiryMonths: z.coerce.number().int().positive().max(120).nullable().optional(), isActive: z.boolean().default(true) });

type LoyaltyDb = Pick<typeof prisma, 'loyaltyProgram' | 'loyaltyAccount' | 'loyaltyTransaction'>;
export async function awardOrderPoints(tx: LoyaltyDb, customerId: string, amount: number, orderId: string) {
  const program = await tx.loyaltyProgram.findFirst({ where: { organizationId: oid(), isActive: true } });
  if (!program) return 0;
  const points = Math.floor(amount * Number(program.pointsPerAmount));
  if (points <= 0) return 0;
  const account = await tx.loyaltyAccount.upsert({ where: { customerId }, create: { programId: program.id, customerId }, update: {} });
  const existing = await tx.loyaltyTransaction.findFirst({ where: { accountId: account.id, referenceType: 'ORDER', referenceId: orderId, type: 'EARN' } });
  if (existing) return 0;
  await tx.loyaltyTransaction.create({ data: { accountId: account.id, type: 'EARN', points, referenceType: 'ORDER', referenceId: orderId, note: 'Points earned from paid order' } });
  await tx.loyaltyAccount.update({ where: { id: account.id }, data: { balance: { increment: points } } });
  return points;
}

export const loyaltyService = {
  get: async () => ({ program: await prisma.loyaltyProgram.findFirst({ where: { organizationId: oid() } }), accounts: await prisma.loyaltyAccount.findMany({ where: { program: { organizationId: oid() } }, include: { customer: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } }, transactions: { orderBy: { createdAt: 'desc' }, take: 5 } }, orderBy: { balance: 'desc' }, take: 100 }) }),
  configure: (data: z.infer<typeof loyaltyProgramSchema>) => prisma.loyaltyProgram.upsert({ where: { organizationId: oid() }, create: { organizationId: oid(), ...data }, update: data }),
  adjust: async (customerId: string, points: number, note?: string) => {
    const program = await prisma.loyaltyProgram.findFirst({ where: { organizationId: oid() } }); if (!program) throw new NotFoundError('Loyalty program');
    const customer = await prisma.customer.findFirst({ where: { id: customerId, deletedAt: null }, select: { id: true } }); if (!customer) throw new NotFoundError('Customer');
    let account = await prisma.loyaltyAccount.findFirst({ where: { customerId, programId: program.id } });
    if (!account) account = await prisma.loyaltyAccount.create({ data: { programId: program.id, customerId } });
    if (account.balance + points < 0) throw new ValidationError('Adjustment would make the points balance negative');
    await prisma.$transaction([prisma.loyaltyTransaction.create({ data: { accountId: account.id, type: 'ADJUST', points, note: note ?? 'Manual adjustment' } }), prisma.loyaltyAccount.update({ where: { id: account.id }, data: { balance: { increment: points } } })]);
    return prisma.loyaltyAccount.findUnique({ where: { id: account.id } });
  },
};
