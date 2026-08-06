import { Prisma } from '@prisma/client';

/** Vhicasar Pay uses Prisma.Decimal end-to-end (no floats). */
export type Money = Prisma.Decimal;

export function money(value: Prisma.Decimal | number | string): Money {
  return new Prisma.Decimal(value);
}

export const ZERO = new Prisma.Decimal(0);

/** Serialise a Decimal for API responses as a fixed-2 string. */
export function formatMoney(value: Prisma.Decimal | number | string, currency: string): {
  amount: string;
  currency: string;
} {
  return { amount: new Prisma.Decimal(value).toFixed(2), currency };
}

export function isPositive(value: Prisma.Decimal): boolean {
  return value.greaterThan(ZERO);
}
