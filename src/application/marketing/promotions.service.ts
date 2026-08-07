import { z } from 'zod';
import { prisma } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors';
import { promotionEngine } from './promotion-engine.service';

const oid = () => { const id = requestContext.get()?.organizationId; if (!id) throw new Error('No tenant'); return id; };
export const couponSchema = z.object({
  code: z.string().trim().min(2).max(40).transform((v) => v.toUpperCase()), description: z.string().trim().max(300).nullable().optional(),
  discountType: z.enum(['PERCENTAGE', 'FIXED_AMOUNT']), discountValue: z.coerce.number().positive(), minOrderAmount: z.coerce.number().nonnegative().nullable().optional(),
  maxDiscount: z.coerce.number().positive().nullable().optional(), usageLimit: z.coerce.number().int().positive().nullable().optional(), usageLimitPerCustomer: z.coerce.number().int().positive().nullable().optional(),
  startsAt: z.coerce.date().nullable().optional(), expiresAt: z.coerce.date().nullable().optional(), isActive: z.boolean().default(true),
});
export const promotionSchema = z.object({
  name: z.string().trim().min(2).max(120), description: z.string().trim().max(1000).nullable().optional(), discountType: z.enum(['PERCENTAGE', 'FIXED_AMOUNT']),
  discountValue: z.coerce.number().positive(), status: z.enum(['SCHEDULED', 'ACTIVE', 'PAUSED', 'ENDED']).default('ACTIVE'),
  scope: z.enum(['ALL', 'PRODUCTS', 'PROPERTIES']), targetIds: z.array(z.string()).default([]), startsAt: z.coerce.date(), endsAt: z.coerce.date(),
  /** Announce it to linked customers. On unless the merchant says otherwise. */
  notifyCustomers: z.boolean().default(true),
  minSpend: z.coerce.number().nonnegative().nullable().optional(),
  maxPerCustomer: z.coerce.number().int().positive().default(1),
  terms: z.string().trim().max(4000).nullable().optional(),
}).refine((v) => v.endsAt > v.startsAt, { message: 'End date must be after start date' });

export async function validateCoupon(code: string, amount: number, customerId?: string) {
  const coupon = await prisma.coupon.findFirst({ where: { code: code.trim().toUpperCase(), isActive: true } });
  if (!coupon) throw new NotFoundError('Coupon');
  const now = new Date();
  if (coupon.startsAt && coupon.startsAt > now) throw new ValidationError('This coupon is not active yet');
  if (coupon.expiresAt && coupon.expiresAt < now) throw new ValidationError('This coupon has expired');
  if (coupon.usageLimit && coupon.usedCount >= coupon.usageLimit) throw new ValidationError('This coupon has reached its usage limit');
  if (coupon.minOrderAmount && amount < Number(coupon.minOrderAmount)) throw new ValidationError(`Minimum sale amount is ${Number(coupon.minOrderAmount).toFixed(2)}`);
  if (customerId && coupon.usageLimitPerCustomer) {
    const used = await prisma.couponRedemption.count({ where: { couponId: coupon.id, customerId } });
    if (used >= coupon.usageLimitPerCustomer) throw new ValidationError('This customer has reached the coupon usage limit');
  }
  let discount = coupon.discountType === 'PERCENTAGE' ? amount * Number(coupon.discountValue) / 100 : Number(coupon.discountValue);
  if (coupon.maxDiscount) discount = Math.min(discount, Number(coupon.maxDiscount));
  return { coupon, discount: Math.max(0, Math.min(amount, Math.round(discount * 100) / 100)) };
}

export const promotionsService = {
  listCoupons: () => prisma.coupon.findMany({ orderBy: { createdAt: 'desc' }, include: { _count: { select: { redemptions: true } } } }),
  createCoupon: async (data: z.infer<typeof couponSchema>) => {
    const exists = await prisma.coupon.findFirst({ where: { code: data.code } }); if (exists) throw new ConflictError('Coupon code already exists');
    return prisma.coupon.create({ data: { organizationId: oid(), ...data } });
  },
  listPromotions: () => prisma.promotion.findMany({ orderBy: { createdAt: 'desc' } }),

  /**
   * Created through the promotion engine rather than a direct write.
   *
   * There is one creation path on purpose: the engine is what schedules the
   * customer announcement, writes the audit row and emits the event. A
   * promotion created here used to do none of that, so an offer made from the
   * web app existed but nobody was ever told about it.
   */
  createPromotion: (data: z.infer<typeof promotionSchema>) =>
    promotionEngine.upsert(oid(), {
      name: data.name,
      description: data.description ?? undefined,
      discountType: data.discountType,
      discountValue: data.discountValue,
      status: data.status,
      startsAt: data.startsAt,
      endsAt: data.endsAt,
      appliesTo: { scope: data.scope, ids: data.targetIds },
      notifyCustomers: data.notifyCustomers,
      minSpend: data.minSpend ?? undefined,
      maxPerCustomer: data.maxPerCustomer,
      terms: data.terms ?? undefined,
    }),
  validate: validateCoupon,
};
