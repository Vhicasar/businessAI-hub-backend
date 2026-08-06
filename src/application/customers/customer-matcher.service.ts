import type { Customer } from '@prisma/client';
import { prisma, prismaUnscoped } from '../../infrastructure/database/prisma';
import { normalizeEmail, normalizePhone, phoneVariants } from '../../shared/phone';
import { emitEvent } from '../../shared/domain-events';
import { auditService } from '../audit/audit.service';

/**
 * Smart customer matching (§9, §23).
 *
 * One person should be one record. Whether they arrive through the Super App,
 * a POS sale, an import or a booking, we look for an existing record before
 * creating anything — using a strict priority so a weak signal can never
 * overwrite a strong one:
 *
 *   1. Email (exact, normalised)
 *   2. Normalised phone (incl. legacy spellings already in the database)
 *   3. Government ID / membership number
 *   4. Customer UUID
 *
 * Name similarity is *never* used to auto-merge — it only produces a
 * suggestion for a human to confirm, because two real people genuinely do
 * share names.
 */

export interface MatchInput {
  email?: string | null;
  phone?: string | null;
  customerId?: string | null;
  membershipNumber?: string | null;
  governmentId?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  /** Country used to resolve a bare national phone number. */
  country?: string | null;
}

export type MatchStrength = 'EMAIL' | 'PHONE' | 'GOVERNMENT_ID' | 'CUSTOMER_ID' | 'NONE';

export interface MatchResult {
  customer: Customer | null;
  matchedBy: MatchStrength;
  /** Records a human should look at — never merged automatically. */
  possibleDuplicates: Array<{ id: string; displayName: string; reason: string }>;
}

/** Normalise the identifying fields once so every caller matches identically. */
export function canonicalise(input: MatchInput, orgCountry?: string | null) {
  const country = input.country ?? orgCountry ?? undefined;
  return {
    email: normalizeEmail(input.email),
    phone: normalizePhone(input.phone, country ?? undefined),
    phoneLookups: phoneVariants(input.phone, country ?? undefined),
  };
}

export const customerMatcher = {
  canonicalise,

  /**
   * Find an existing customer *within the caller's organisation*.
   * Uses the tenant-scoped client, so this can never reach another org's data.
   */
  async findInOrg(input: MatchInput, orgCountry?: string | null): Promise<MatchResult> {
    const { email, phoneLookups } = canonicalise(input, orgCountry);
    const possibleDuplicates: MatchResult['possibleDuplicates'] = [];

    if (input.customerId) {
      const byId = await prisma.customer.findUnique({ where: { id: input.customerId } });
      if (byId && !byId.deletedAt) return { customer: byId, matchedBy: 'CUSTOMER_ID', possibleDuplicates };
    }

    if (email) {
      const byEmail = await prisma.customer.findFirst({
        where: { email, deletedAt: null },
      });
      if (byEmail) return { customer: byEmail, matchedBy: 'EMAIL', possibleDuplicates };
    }

    if (phoneLookups.length > 0) {
      const byPhone = await prisma.customer.findFirst({
        where: { phone: { in: phoneLookups }, deletedAt: null },
      });
      if (byPhone) return { customer: byPhone, matchedBy: 'PHONE', possibleDuplicates };
    }

    const ref = input.governmentId ?? input.membershipNumber;
    if (ref) {
      const byRef = await prisma.customer.findFirst({
        where: {
          deletedAt: null,
          OR: [
            { customFields: { path: ['governmentId'], equals: ref } },
            { customFields: { path: ['membershipNumber'], equals: ref } },
          ],
        },
      });
      if (byRef) return { customer: byRef, matchedBy: 'GOVERNMENT_ID', possibleDuplicates };
    }

    // No confident match. Surface same-name records so staff can decide rather
    // than silently creating a near-duplicate.
    if (input.firstName) {
      const sameName = await prisma.customer.findMany({
        where: {
          deletedAt: null,
          firstName: { equals: input.firstName, mode: 'insensitive' },
          ...(input.lastName ? { lastName: { equals: input.lastName, mode: 'insensitive' } } : {}),
        },
        take: 5,
        select: { id: true, firstName: true, lastName: true, phone: true, email: true },
      });
      for (const c of sameName) {
        possibleDuplicates.push({
          id: c.id,
          displayName: `${c.firstName} ${c.lastName ?? ''}`.trim(),
          reason: 'Same name',
        });
      }
    }

    return { customer: null, matchedBy: 'NONE', possibleDuplicates };
  },

  /**
   * Find the global Vhicasar identity behind these details, across every
   * organisation. Used when a business creates a walk-in customer who may
   * already have a Super App account (§23).
   */
  async findIdentity(input: MatchInput, orgCountry?: string | null) {
    const { email, phone } = canonicalise(input, orgCountry);
    if (!email && !phone) return null;
    return prismaUnscoped.vhicasarId.findFirst({
      where: {
        deletedAt: null,
        OR: [...(email ? [{ email }] : []), ...(phone ? [{ phone }] : [])],
      },
    });
  },

  /**
   * Get-or-create a customer in the caller's organisation, linking to an
   * existing Vhicasar identity when one is found.
   *
   * This is the single entry point POS, orders, bookings, invoices and
   * quotations use — so "create a customer mid-sale" can never fork a record.
   */
  async resolveOrCreate(
    input: MatchInput & { organizationId: string; source?: string; gender?: string | null; dateOfBirth?: Date | null; notes?: string | null },
    orgCountry?: string | null
  ): Promise<{ customer: Customer; created: boolean; matchedBy: MatchStrength; linkedIdentity: boolean }> {
    const match = await this.findInOrg(input, orgCountry);
    const { email, phone } = canonicalise(input, orgCountry);

    if (match.customer) {
      // Backfill contact details the existing record was missing, but never
      // overwrite something already there — that would be destructive.
      const patch: Record<string, unknown> = {};
      if (!match.customer.email && email) patch.email = email;
      if (!match.customer.phone && phone) patch.phone = phone;
      // A provisional (anonymous web-chat) record becomes real once we have
      // contact details for it.
      if (match.customer.isProvisional && (email || phone)) patch.isProvisional = false;

      const customer = Object.keys(patch).length
        ? await prisma.customer.update({ where: { id: match.customer.id }, data: patch })
        : match.customer;

      const linked = await this.ensureIdentityLink(customer, input, orgCountry);
      return { customer, created: false, matchedBy: match.matchedBy, linkedIdentity: linked };
    }

    const customer = await prisma.customer.create({
      data: {
        organizationId: input.organizationId,
        firstName: input.firstName?.trim() || 'Customer',
        lastName: input.lastName?.trim() || null,
        displayName: [input.firstName, input.lastName].filter(Boolean).join(' ').trim() || null,
        email,
        phone,
        gender: input.gender ?? null,
        dateOfBirth: input.dateOfBirth ?? null,
        ...(input.governmentId || input.membershipNumber
          ? {
              customFields: {
                ...(input.governmentId ? { governmentId: input.governmentId } : {}),
                ...(input.membershipNumber ? { membershipNumber: input.membershipNumber } : {}),
              },
            }
          : {}),
      },
    });

    await auditService.record({
      action: 'customer.created',
      entityType: 'Customer',
      entityId: customer.id,
      after: { source: input.source ?? 'MANUAL', matchedBy: 'NONE' },
    });
    await emitEvent({
      name: 'CustomerCreated',
      aggregateType: 'Customer',
      aggregateId: customer.id,
      payload: { source: input.source ?? 'MANUAL' },
      organizationId: input.organizationId,
    });

    const linked = await this.ensureIdentityLink(customer, input, orgCountry);
    return { customer, created: true, matchedBy: 'NONE', linkedIdentity: linked };
  },

  /**
   * If these contact details belong to a Vhicasar ID, associate it with this
   * organisation's customer record so the person immediately sees the business
   * in their Super App.
   */
  async ensureIdentityLink(customer: Customer, input: MatchInput, orgCountry?: string | null): Promise<boolean> {
    const existing = await prismaUnscoped.customerLink.findUnique({ where: { customerId: customer.id } });
    if (existing) return true;

    const identity = await this.findIdentity(
      { email: input.email ?? customer.email, phone: input.phone ?? customer.phone },
      orgCountry
    );
    if (!identity) return false;

    // One identity ↔ one customer per organisation.
    const clash = await prismaUnscoped.customerLink.findUnique({
      where: { vhicasarId_organizationId: { vhicasarId: identity.id, organizationId: customer.organizationId } },
    });
    if (clash) return false;

    await prismaUnscoped.customerLink.create({
      data: {
        vhicasarId: identity.id,
        organizationId: customer.organizationId,
        customerId: customer.id,
        source: input.membershipNumber ? 'IMPORT' : 'POS',
      },
    });
    await prismaUnscoped.customerBusinessHistory.create({
      data: {
        vhicasarId: identity.id,
        organizationId: customer.organizationId,
        action: 'JOINED',
        source: 'BUSINESS_CREATED',
        actorType: 'BUSINESS',
      },
    });
    await emitEvent({
      name: 'CustomerLinked',
      aggregateType: 'CustomerLink',
      aggregateId: customer.id,
      payload: { vhicasarId: identity.id, customerId: customer.id, source: 'BUSINESS_CREATED' },
      organizationId: customer.organizationId,
    });
    return true;
  },
};
