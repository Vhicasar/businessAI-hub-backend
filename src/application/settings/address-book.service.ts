import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { ValidationError } from '../../shared/errors';

const currentOrgId = (): string => {
  const id = requestContext.get()?.organizationId;
  if (!id) throw new ValidationError('No tenant in context');
  return id;
};

export interface AddressBook {
  /** Cities already used, most frequent first, each with its usual state/country. */
  cities: { city: string; state: string | null; country: string | null; uses: number }[];
  states: string[];
  countries: string[];
  /** The country to preselect on a blank form: the organization's own. */
  defaultCountry: string | null;
}

/**
 * Places this business already deals with.
 *
 * Feeds address autocomplete without an external geocoder. The set of places a
 * given business uses is small and repetitive — its own records are the most
 * accurate autofill source available, cost nothing, and keep customer addresses
 * from being sent to a third party just to complete a form.
 *
 * Frequency-ordered so the city typed forty times outranks the one typed once,
 * and each city carries the state and country it is usually paired with, so
 * picking a city fills the rest of the address in.
 */
export async function addressBook(): Promise<AddressBook> {
  const organizationId = currentOrgId();

  const [org, customerAddresses, suppliers, warehouses, branches] = await Promise.all([
    prismaUnscoped.organization.findUnique({
      where: { id: organizationId },
      select: { country: true, city: true },
    }),
    prismaUnscoped.customerAddress.findMany({
      where: { customer: { organizationId } },
      select: { city: true, state: true, country: true },
      take: 2000,
    }),
    prismaUnscoped.supplier.findMany({
      where: { organizationId, deletedAt: null },
      select: { city: true, state: true, country: true },
    }),
    prismaUnscoped.warehouse.findMany({
      where: { organizationId, deletedAt: null },
      select: { city: true, state: true, country: true },
    }),
    prismaUnscoped.branch.findMany({
      where: { organizationId, deletedAt: null },
      select: { city: true, state: true, country: true },
    }),
  ]);

  const rows = [...customerAddresses, ...suppliers, ...warehouses, ...branches];

  // Keyed case-insensitively so "Lagos" and "lagos" are one entry, but the
  // spelling shown is the one the business actually uses most.
  const cities = new Map<
    string,
    { city: string; state: string | null; country: string | null; uses: number }
  >();
  const states = new Map<string, number>();
  const countries = new Map<string, number>();

  for (const row of rows) {
    if (row.city?.trim()) {
      const key = row.city.trim().toLowerCase();
      const existing = cities.get(key);
      if (existing) {
        existing.uses += 1;
        // Fill in details a sparser record was missing.
        existing.state ??= row.state?.trim() || null;
        existing.country ??= row.country ?? null;
      } else {
        cities.set(key, {
          city: row.city.trim(),
          state: row.state?.trim() || null,
          country: row.country ?? null,
          uses: 1,
        });
      }
    }
    if (row.state?.trim()) {
      const key = row.state.trim();
      states.set(key, (states.get(key) ?? 0) + 1);
    }
    if (row.country) countries.set(row.country, (countries.get(row.country) ?? 0) + 1);
  }

  const byUse = <T extends { uses?: number }>(a: [string, number], b: [string, number]) => b[1] - a[1];

  return {
    cities: [...cities.values()].sort((a, b) => b.uses - a.uses).slice(0, 100),
    states: [...states.entries()].sort(byUse).map(([s]) => s).slice(0, 100),
    countries: [...countries.entries()].sort(byUse).map(([c]) => c).slice(0, 60),
    // A new supplier is usually in the same country as the business itself.
    defaultCountry: org?.country ?? null,
  };
}
