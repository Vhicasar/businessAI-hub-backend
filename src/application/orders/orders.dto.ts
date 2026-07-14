import { z } from 'zod';

export const listOrdersSchema = z.object({
  status: z
    .enum([
      'PENDING', 'CONFIRMED', 'PROCESSING', 'PICKING', 'PACKING', 'READY_FOR_DISPATCH',
      'DISPATCHED', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED',
    ])
    .optional(),
  customerId: z.string().optional(),
  search: z.string().trim().max(120).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const createOrderSchema = z.object({
  customerId: z.string().min(1),
  warehouseId: z.string().optional(),
  shippingAddressId: z.string().nullable().optional(),
  source: z
    .enum(['POS', 'WEB', 'WHATSAPP', 'INSTAGRAM', 'FACEBOOK', 'MESSENGER', 'TIKTOK',
      'TELEGRAM', 'WEB_CHAT', 'PHONE', 'MANUAL', 'API'])
    .default('MANUAL'),
  notes: z.string().trim().max(2000).nullable().optional(),
  shippingTotal: z.coerce.number().nonnegative().default(0),
  items: z
    .array(
      z.object({
        variantId: z.string().min(1),
        quantity: z.coerce.number().positive(),
        // optional price override (e.g. negotiated in chat); defaults to variant price
        unitPrice: z.coerce.number().nonnegative().optional(),
      })
    )
    .min(1),
});

export const transitionSchema = z.object({
  status: z.enum([
    'CONFIRMED', 'PROCESSING', 'PICKING', 'PACKING', 'READY_FOR_DISPATCH',
    'DISPATCHED', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED', 'CANCELLED',
  ]),
  note: z.string().trim().max(500).optional(),
});

export const recordPaymentSchema = z.object({
  amount: z.coerce.number().positive(),
  method: z.enum(['CASH', 'CARD', 'BANK_TRANSFER', 'MOBILE_MONEY', 'WALLET', 'CHEQUE', 'ONLINE_GATEWAY', 'COD']),
  reference: z.string().trim().max(120).optional(),
});

export type ListOrdersDto = z.infer<typeof listOrdersSchema>;
export type CreateOrderDto = z.infer<typeof createOrderSchema>;
export type TransitionDto = z.infer<typeof transitionSchema>;
export type RecordPaymentDto = z.infer<typeof recordPaymentSchema>;
