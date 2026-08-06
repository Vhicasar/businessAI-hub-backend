import { prismaUnscoped } from '../../infrastructure/database/prisma';

/**
 * What a customer may do to their own booking (§7).
 *
 * Read from the organisation's appointment settings so each business keeps
 * control: some are happy for customers to cancel themselves, others want a
 * phone call. Defaults are permissive for cancellation and conservative for
 * rescheduling, which matches how most businesses actually operate.
 */
export interface BookingPolicy {
  allowCustomerCancel: boolean;
  allowCustomerReschedule: boolean;
  /** How close to the start time self-service stops being allowed. */
  noticeMs: number;
}

export const bookings = {
  async policyFor(organizationId: string): Promise<BookingPolicy> {
    const org = await prismaUnscoped.organization.findUnique({
      where: { id: organizationId },
      select: { settings: true },
    });
    const settings = ((org?.settings as Record<string, unknown> | null)?.appointments ?? {}) as {
      allowCustomerCancel?: boolean;
      allowCustomerReschedule?: boolean;
      minNoticeHours?: number;
    };
    return {
      allowCustomerCancel: settings.allowCustomerCancel ?? true,
      allowCustomerReschedule: settings.allowCustomerReschedule ?? false,
      noticeMs: (settings.minNoticeHours ?? 2) * 3600_000,
    };
  },
};
