import { prisma, prismaUnscoped } from '../../infrastructure/database/prisma';
import { normalizeEmail, normalizePhone } from '../../shared/phone';
import { NotFoundError } from '../../shared/errors';
import { logger } from '../../shared/logger';
import { customerMatcher, type MatchStrength } from './customer-matcher.service';

/**
 * Create or find a customer without leaving the current workflow (§23).
 *
 * Staff serving a walk-in shouldn't have to stop a sale to go and create a
 * customer record — and doing so must never fork a person who already exists.
 * POS, orders, quotations, bookings, invoices and reservations all funnel
 * through here so the matching rules are identical everywhere.
 */

export interface QuickCreateInput {
  firstName: string;
  lastName?: string;
  phone?: string;
  email?: string;
  gender?: string;
  dateOfBirth?: Date;
  address?: string;
  notes?: string;
  membershipNumber?: string;
  governmentId?: string;
  /** Where in the product this came from — POS, ORDER, BOOKING… */
  source?: string;
  /** Send an app invitation after creating. */
  invite?: boolean;
}

export interface QuickCreateResult {
  customer: {
    id: string;
    firstName: string;
    lastName: string | null;
    displayName: string | null;
    email: string | null;
    phone: string | null;
  };
  created: boolean;
  matchedBy: MatchStrength;
  /** True when this person already has a Super App account we linked to. */
  linkedToVhicasarId: boolean;
  possibleDuplicates: Array<{ id: string; displayName: string; reason: string }>;
  invitationSent: boolean;
}

const publicCustomer = (c: {
  id: string;
  firstName: string;
  lastName: string | null;
  displayName: string | null;
  email: string | null;
  phone: string | null;
}) => ({
  id: c.id,
  firstName: c.firstName,
  lastName: c.lastName,
  displayName: c.displayName,
  email: c.email,
  phone: c.phone,
});

export const quickCreate = {
  /**
   * Type-ahead lookup for the "select existing customer" step. Searches the
   * caller's organisation only, matching name, email or any spelling of a
   * phone number.
   */
  async lookup(query: string, limit = 8) {
    const q = query.trim();
    if (q.length < 2) return [];

    const phone = normalizePhone(q);
    const rows = await prisma.customer.findMany({
      where: {
        deletedAt: null,
        OR: [
          { firstName: { contains: q, mode: 'insensitive' } },
          { lastName: { contains: q, mode: 'insensitive' } },
          { displayName: { contains: q, mode: 'insensitive' } },
          { email: { contains: q.toLowerCase(), mode: 'insensitive' } },
          // Match the raw digits too, so partial numbers still find people.
          { phone: { contains: q.replace(/[^\d+]/g, '') } },
          ...(phone ? [{ phone }] : []),
        ],
      },
      take: limit,
      orderBy: { lastOrderAt: 'desc' },
      select: {
        id: true, firstName: true, lastName: true, displayName: true,
        email: true, phone: true, totalOrders: true, lifetimeValue: true,
        link: { select: { vhicasarId: true } },
      },
    });

    return rows.map((c) => ({
      ...publicCustomer(c),
      totalOrders: c.totalOrders,
      lifetimeValue: c.lifetimeValue.toFixed(2),
      /** Shows staff this person already uses the app. */
      hasVhicasarAccount: Boolean(c.link),
    }));
  },

  /**
   * Find-or-create in one call. Never creates a duplicate: an existing record
   * is reused and quietly enriched, and an existing Vhicasar identity is linked
   * so the business appears in that person's Super App straight away.
   */
  async resolve(organizationId: string, input: QuickCreateInput): Promise<QuickCreateResult> {
    const org = await prismaUnscoped.organization.findUnique({
      where: { id: organizationId },
      select: { country: true, name: true },
    });

    const match = await customerMatcher.findInOrg(
      {
        email: input.email,
        phone: input.phone,
        membershipNumber: input.membershipNumber,
        governmentId: input.governmentId,
        firstName: input.firstName,
        lastName: input.lastName,
      },
      org?.country
    );

    const result = await customerMatcher.resolveOrCreate(
      {
        organizationId,
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email,
        phone: input.phone,
        gender: input.gender ?? null,
        dateOfBirth: input.dateOfBirth ?? null,
        membershipNumber: input.membershipNumber,
        governmentId: input.governmentId,
        source: input.source ?? 'MANUAL',
      },
      org?.country
    );

    // Optional extras that don't participate in matching.
    if (input.address || input.notes) {
      await prisma.customer
        .update({
          where: { id: result.customer.id },
          data: {
            ...(input.notes ? { customFields: { notes: input.notes } } : {}),
          },
        })
        .catch(() => undefined);
      if (input.address) {
        await prisma.customerAddress
          .create({
            data: {
              customerId: result.customer.id,
              addressLine1: input.address,
              city: '',
              country: org?.country ?? 'NG',
              isDefault: true,
            },
          })
          .catch(() => undefined);
      }
    }

    let invitationSent = false;
    if (input.invite && result.created && !result.linkedIdentity) {
      invitationSent = await this.sendInvitation(organizationId, result.customer.id, org?.name ?? 'a business');
    }

    return {
      customer: publicCustomer(result.customer),
      created: result.created,
      matchedBy: result.matchedBy,
      linkedToVhicasarId: result.linkedIdentity,
      possibleDuplicates: result.created ? match.possibleDuplicates : [],
      invitationSent,
    };
  },

  /**
   * Invite a newly-created customer to activate the Super App (§23).
   * Best-effort: a failed invite must never fail the sale that created them.
   */
  async sendInvitation(organizationId: string, customerId: string, businessName: string): Promise<boolean> {
    try {
      const customer = await prisma.customer.findUnique({
        where: { id: customerId },
        select: { email: true, phone: true, firstName: true },
      });
      if (!customer) return false;

      const benefits = [
        'Loyalty points on every purchase',
        'Promotions and coupons',
        'Digital receipts and order history',
        'A wallet for faster checkout',
        'All your businesses in one app',
      ];
      const inviteUrl = `${process.env.APP_INVITE_URL ?? 'https://vhicasar.com/app'}?b=${organizationId}`;

      if (customer.email) {
        const { mailer } = await import('../../infrastructure/mail/mailer');
        await mailer.sendNotice(
          customer.email,
          `${businessName} invited you to Vhicasar`,
          'Your Vhicasar account is ready',
          `<p>Hi ${customer.firstName},</p>
           <p><strong>${businessName}</strong> has added you as a customer on Vhicasar.</p>
           <p>Activate your free account to get:</p>
           <ul>${benefits.map((b) => `<li>${b}</li>`).join('')}</ul>
           <p><a href="${inviteUrl}">Activate your account</a></p>`,
          `${businessName} added you on Vhicasar. Activate your account: ${inviteUrl}`,
          { organizationId }
        );
        return true;
      }

      if (customer.phone) {
        const { messagingService } = await import('../messaging/messaging.service');
        await messagingService.sendToCustomer(
          customerId,
          'SMS',
          `${businessName} added you on Vhicasar. Get points, offers and digital receipts: ${inviteUrl}`
        );
        return true;
      }
      return false;
    } catch (err) {
      logger.warn({ err, customerId }, 'customer invitation failed');
      return false;
    }
  },
};
