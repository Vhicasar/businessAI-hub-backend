import { randomBytes } from 'crypto';
import { z } from 'zod';
import { prisma, prismaUnscoped } from '../../infrastructure/database/prisma';
import { requestContext } from '../../shared/context';
import { env } from '../../shared/config/env';
import { logger } from '../../shared/logger';
import { messagingService } from '../messaging/messaging.service';
import { NotFoundError, ValidationError } from '../../shared/errors';
import { calendarSync } from '../integrations/calendar-sync.service';
import { activityService } from '../crm/activity.service';
import { workflowService } from '../crm/workflow.service';
import { mailer } from '../../infrastructure/mail/mailer';

/**
 * Appointment booking (spec #12). Backed by the Meeting model. Availability is
 * computed from an org-configured weekly schedule in the org's timezone, minus
 * existing appointments (conflict detection). Bookings can come from the website
 * chat (public) or staff (authed), optionally linked to a real-estate property
 * and its assigned agent. On booking we email a confirmation with add-to-calendar
 * links + an .ics, record the CRM timeline, and a background sweep sends
 * reminders. Google/Outlook integration is provided via universal add-to-calendar
 * links + .ics (works with both) rather than per-user OAuth sync.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function orgId(): string {
  const id = requestContext.get()?.organizationId;
  if (!id) throw new Error('No tenant in request context');
  return id;
}

// ── config ────────────────────────────────────────────────────────────────

const hoursIntervalSchema = z.object({ start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/) });
export const appointmentConfigSchema = z.object({
  enabled: z.boolean().default(false),
  timezone: z.string().min(1).default('UTC'),
  slotMinutes: z.coerce.number().int().min(5).max(240).default(30),
  leadTimeHours: z.coerce.number().int().min(0).max(720).default(2),
  horizonDays: z.coerce.number().int().min(1).max(90).default(14),
  location: z.string().trim().max(200).optional().default(''),
  /** Weekly schedule keyed by weekday 0=Sun … 6=Sat. */
  hours: z.record(z.string(), z.array(hoursIntervalSchema)).default({}),
  types: z
    .array(z.object({ id: z.string().min(1), name: z.string().min(1), durationMin: z.coerce.number().int().min(5).max(480) }))
    .default([]),
});
export type AppointmentConfig = z.infer<typeof appointmentConfigSchema>;

const DEFAULT_CONFIG: AppointmentConfig = {
  enabled: false,
  timezone: 'UTC',
  slotMinutes: 30,
  leadTimeHours: 2,
  horizonDays: 14,
  location: '',
  hours: { '1': [{ start: '09:00', end: '17:00' }], '2': [{ start: '09:00', end: '17:00' }], '3': [{ start: '09:00', end: '17:00' }], '4': [{ start: '09:00', end: '17:00' }], '5': [{ start: '09:00', end: '17:00' }] },
  types: [{ id: 'general', name: 'General appointment', durationMin: 30 }],
};

/** Lightweight enabled check for the widget config (no slot computation). */
export async function appointmentsEnabled(organizationId: string): Promise<boolean> {
  return (await readConfig(organizationId)).enabled;
}

async function readConfig(organizationId: string): Promise<AppointmentConfig> {
  const org = await prismaUnscoped.organization.findUnique({ where: { id: organizationId }, select: { settings: true } });
  const raw = ((org?.settings as Record<string, unknown>) ?? {}).appointments;
  if (!raw) return DEFAULT_CONFIG;
  const parsed = appointmentConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_CONFIG;
}

// ── timezone helpers (no external lib) ──────────────────────────────────────

/** Parse Intl date-time parts into a numeric lookup with safe defaults. */
function partsOf(fmt: Intl.DateTimeFormat, date: Date): Record<string, string> {
  return fmt.formatToParts(date).reduce<Record<string, string>>((a, x) => { a[x.type] = x.value; return a; }, {});
}
const n = (v: string | undefined) => Number(v ?? '0');

/** How many ms the IANA `tz` is ahead of UTC at instant `date`. */
function tzOffsetMs(date: Date, tz: string): number {
  const p = partsOf(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }), date);
  const asUTC = Date.UTC(n(p.year), n(p.month) - 1, n(p.day), n(p.hour), n(p.minute), n(p.second));
  return asUTC - date.getTime();
}

/** Convert a wall-clock time in `tz` to the corresponding UTC Date. */
function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): Date {
  const guess = Date.UTC(y, mo, d, h, mi);
  // Correct by the offset at the guessed instant (good enough across DST edges).
  const offset = tzOffsetMs(new Date(guess), tz);
  return new Date(guess - offset);
}

/** The {year,month,day,weekday} of `date` as seen in `tz`. */
function zonedParts(date: Date, tz: string): { y: number; mo: number; d: number; weekday: number } {
  const p = partsOf(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }), date);
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { y: n(p.year), mo: n(p.month) - 1, d: n(p.day), weekday: weekdayMap[p.weekday ?? 'Sun'] ?? 0 };
}

const hm = (t: string) => ({ h: +t.slice(0, 2), m: +t.slice(3, 5) });

// ── availability ────────────────────────────────────────────────────────────

export interface Slot { start: string; end: string }

async function computeSlots(organizationId: string, cfg: AppointmentConfig, typeId: string | undefined, days: number): Promise<Slot[]> {
  const type = cfg.types.find((t) => t.id === typeId) ?? cfg.types[0];
  const durationMin = type?.durationMin ?? cfg.slotMinutes;
  const now = Date.now();
  const earliest = now + cfg.leadTimeHours * 60 * 60 * 1000;
  const horizon = Math.min(days, cfg.horizonDays);

  // Existing appointments in the window, for conflict detection.
  const windowEnd = new Date(now + horizon * DAY_MS);
  const busy = await prismaUnscoped.meeting.findMany({
    where: { organizationId, status: { not: 'CANCELLED' }, deletedAt: null, startAt: { lt: windowEnd }, endAt: { gt: new Date(now) } },
    select: { startAt: true, endAt: true },
  });
  const overlaps = (s: number, e: number) => busy.some((b) => s < b.endAt.getTime() && e > b.startAt.getTime());

  const slots: Slot[] = [];
  for (let dayOffset = 0; dayOffset < horizon && slots.length < 200; dayOffset++) {
    const dayDate = new Date(now + dayOffset * DAY_MS);
    const { y, mo, d, weekday } = zonedParts(dayDate, cfg.timezone);
    const intervals = cfg.hours[String(weekday)] ?? [];
    for (const iv of intervals) {
      const s = hm(iv.start);
      const e = hm(iv.end);
      const dayStart = zonedToUtc(y, mo, d, s.h, s.m, cfg.timezone).getTime();
      const dayEnd = zonedToUtc(y, mo, d, e.h, e.m, cfg.timezone).getTime();
      for (let t = dayStart; t + durationMin * 60_000 <= dayEnd; t += cfg.slotMinutes * 60_000) {
        const end = t + durationMin * 60_000;
        if (t < earliest) continue;
        if (overlaps(t, end)) continue;
        slots.push({ start: new Date(t).toISOString(), end: new Date(end).toISOString() });
        if (slots.length >= 200) break;
      }
    }
  }
  return slots;
}

// ── customer matching ───────────────────────────────────────────────────────

async function matchOrCreateCustomer(input: { email?: string; name?: string; phone?: string; visitorId?: string }): Promise<string> {
  // Any channel, not just the website widget. A customer booking over WhatsApp
  // arrives with their WhatsApp id, and looking only at WEB_CHAT meant they
  // were treated as a stranger and a duplicate record was created every time.
  if (input.visitorId) {
    const identity = await prisma.customerIdentity.findFirst({
      where: { externalId: input.visitorId },
      select: { customerId: true },
    });
    if (identity) return identity.customerId;
  }
  if (input.email) {
    const existing = await prisma.customer.findFirst({ where: { email: input.email, deletedAt: null }, select: { id: true } });
    if (existing) return existing.id;
  }
  // Phone is the identifier most messaging channels actually carry, and for a
  // WhatsApp or SMS booking it is often the only one.
  if (input.phone) {
    const digits = input.phone.replace(/\D/g, '');
    if (digits.length >= 7) {
      const byPhone = await prisma.customer.findFirst({
        where: { phone: { endsWith: digits.slice(-9) }, deletedAt: null },
        select: { id: true },
      });
      if (byPhone) return byPhone.id;
      const byIdentity = await prisma.customerIdentity.findFirst({
        where: { externalId: { endsWith: digits.slice(-9) } },
        select: { customerId: true },
      });
      if (byIdentity) return byIdentity.customerId;
    }
  }
  const [firstName, ...rest] = (input.name ?? 'Guest').trim().split(/\s+/);
  const created = await prisma.customer.create({
    // organizationId is injected by the tenant extension at runtime; set it
    // explicitly so the create also satisfies the Prisma types (matches the
    // rest of the codebase).
    data: { organizationId: orgId(), firstName: firstName || 'Guest', lastName: rest.join(' ') || null, email: input.email ?? null, phone: input.phone ?? null },
    select: { id: true },
  });
  return created.id;
}

// ── calendar helpers ────────────────────────────────────────────────────────

const icsStamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

function buildIcs(appt: { id: string; title: string; description?: string | null; location?: string | null; start: Date; end: Date }): string {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Vhicasar Hub AI//Appointments//EN', 'BEGIN:VEVENT',
    `UID:${appt.id}@businesshub.ai`,
    `DTSTAMP:${icsStamp(new Date())}`,
    `DTSTART:${icsStamp(appt.start)}`,
    `DTEND:${icsStamp(appt.end)}`,
    `SUMMARY:${(appt.title || 'Appointment').replace(/\n/g, ' ')}`,
    ...(appt.description ? [`DESCRIPTION:${appt.description.replace(/\n/g, ' ')}`] : []),
    ...(appt.location ? [`LOCATION:${appt.location.replace(/\n/g, ' ')}`] : []),
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
}

function calendarLinks(appt: { title: string; description?: string | null; location?: string | null; start: Date; end: Date }) {
  const text = encodeURIComponent(appt.title || 'Appointment');
  const details = encodeURIComponent(appt.description ?? '');
  const location = encodeURIComponent(appt.location ?? '');
  const g = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${text}&dates=${icsStamp(appt.start)}/${icsStamp(appt.end)}&details=${details}&location=${location}`;
  const o = `https://outlook.office.com/calendar/0/deeplink/compose?subject=${text}&startdt=${appt.start.toISOString()}&enddt=${appt.end.toISOString()}&body=${details}&location=${location}`;
  return { google: g, outlook: o };
}

// ── booking ─────────────────────────────────────────────────────────────────

export const bookAppointmentSchema = z.object({
  start: z.string().datetime(),
  typeId: z.string().optional(),
  name: z.string().trim().max(120).optional(),
  email: z.string().trim().email().optional(),
  phone: z.string().trim().max(40).optional(),
  notes: z.string().trim().max(1000).optional(),
  /** Real-estate: link to a property (creates a PropertyBooking too). */
  propertyId: z.string().optional(),
  /** Assigned staff/agent membership id. */
  agentId: z.string().optional(),
  /** Web-chat visitor id, to resolve the existing customer. */
  visitorId: z.string().optional(),
});
export type BookAppointmentDto = z.infer<typeof bookAppointmentSchema>;

export const appointmentsService = {
  async getConfig() {
    return readConfig(orgId());
  },

  async saveConfig(dto: AppointmentConfig) {
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId() }, select: { settings: true } });
    const settings = (org.settings as Record<string, unknown>) ?? {};
    await prisma.organization.update({ where: { id: orgId() }, data: { settings: { ...settings, appointments: dto } } });
    return dto;
  },

  /** Public-safe availability for a scope (org). */
  async availableSlots(organizationId: string, typeId: string | undefined, days = 14) {
    const cfg = await readConfig(organizationId);
    if (!cfg.enabled) return { enabled: false, timezone: cfg.timezone, types: cfg.types, slots: [] as Slot[] };
    const slots = await computeSlots(organizationId, cfg, typeId, days);
    return { enabled: true, timezone: cfg.timezone, types: cfg.types, slots };
  },

  /**
   * Book an appointment. Runs inside a tenant context. Validates the slot is
   * still free (conflict detection), creates the Meeting (+ PropertyBooking when
   * a property is linked), matches/creates the customer, records the CRM
   * timeline, emails a confirmation with calendar links, and fires a workflow.
   */
  async book(organizationId: string, dto: BookAppointmentDto, source: 'CHAT' | 'MANUAL' | 'WEB', existingCustomerId?: string) {
    const cfg = await readConfig(organizationId);
    if (!cfg.enabled) throw new ValidationError('Online booking is not enabled');

    const type = cfg.types.find((t) => t.id === dto.typeId) ?? cfg.types[0];
    const durationMin = type?.durationMin ?? cfg.slotMinutes;
    const start = new Date(dto.start);
    if (Number.isNaN(start.getTime())) throw new ValidationError('Invalid start time');
    const end = new Date(start.getTime() + durationMin * 60_000);
    if (start.getTime() < Date.now() + cfg.leadTimeHours * 60 * 60 * 1000 - 60_000) {
      throw new ValidationError('That time is no longer available');
    }

    // Conflict check against existing appointments.
    const clash = await prisma.meeting.findFirst({
      where: { status: { not: 'CANCELLED' }, deletedAt: null, startAt: { lt: end }, endAt: { gt: start } },
      select: { id: true },
    });
    if (clash) throw new ValidationError('That time was just taken — please pick another slot');

    // The AI/agent flow passes the conversation's existing customer directly so
    // we never create a duplicate; public bookings resolve by visitor/email.
    const customerId = existingCustomerId
      ?? await matchOrCreateCustomer({ email: dto.email, name: dto.name, phone: dto.phone, visitorId: dto.visitorId });
    const bookingToken = randomBytes(18).toString('base64url');
    const title = `${type?.name ?? 'Appointment'}${dto.name ? ` — ${dto.name}` : ''}`;
    const location = cfg.location || null;

    const meeting = await prisma.meeting.create({
      data: {
        organizationId,
        title,
        description: dto.notes ?? null,
        location,
        startAt: start,
        endAt: end,
        organizerId: dto.agentId ?? null,
        status: 'CONFIRMED',
        customerId,
        typeId: type?.id ?? null,
        source,
        bookingToken,
        entityType: dto.propertyId ? 'PROPERTY' : 'CUSTOMER',
        entityId: dto.propertyId ?? customerId,
        attendees: [{ type: 'customer', id: customerId, name: dto.name ?? '', email: dto.email ?? '', response: 'accepted' }],
      },
      select: { id: true, title: true, description: true, location: true, startAt: true, endAt: true, bookingToken: true },
    });

    // Mirror onto the business's own calendar where they've connected one.
    // Fire-and-forget: a booking must not fail because Google is slow or down.
    void calendarSync.pushToGoogle(meeting.id);

    // Real-estate: also create a property viewing linked to the agent (#12).
    if (dto.propertyId) {
      await prisma.propertyBooking
        .create({
          data: {
            organizationId, propertyId: dto.propertyId, customerId, agentId: dto.agentId ?? null,
            kind: 'VIEWING', status: 'CONFIRMED', scheduledAt: start, durationMin, notes: dto.notes ?? null,
          },
        })
        .catch((err) => logger.warn({ err: (err as Error).message }, 'property booking link failed'));
    }

    // CRM timeline on the customer (and property when linked).
    await activityService.record({
      type: 'MEETING',
      entityType: dto.propertyId ? 'PROPERTY' : 'CUSTOMER',
      entityId: dto.propertyId ?? customerId,
      title: `Appointment booked — ${type?.name ?? 'Appointment'}`,
      body: `${start.toISOString()} (${cfg.timezone})${dto.notes ? `\n${dto.notes}` : ''}`,
      metadata: { meetingId: meeting.id, source, typeId: type?.id, customerId },
      also: dto.propertyId ? [{ entityType: 'CUSTOMER', entityId: customerId }] : undefined,
    });

    void this.sendConfirmation(meeting, dto.email, cfg.timezone, customerId).catch(() => undefined);

    await workflowService.dispatch(
      'appointment.booked',
      { title, start: start.toISOString(), type: type?.name ?? 'Appointment' },
      { entityType: 'CUSTOMER', entityId: customerId, customerId },
    );

    return {
      id: meeting.id,
      title: meeting.title,
      start: meeting.startAt.toISOString(),
      end: meeting.endAt.toISOString(),
      timezone: cfg.timezone,
      manageToken: bookingToken,
      calendar: calendarLinks({ title, description: dto.notes, location, start, end }),
      icsUrl: `${env.API_BASE_URL.replace(/\/+$/, '')}/api/appointments/public/${meeting.id}/ics`,
    };
  },

  /** iCalendar (.ics) for an appointment — public, keyed by the meeting id. */
  async ics(meetingId: string): Promise<string> {
    const m = await prismaUnscoped.meeting.findFirst({ where: { id: meetingId, deletedAt: null }, select: { id: true, title: true, description: true, location: true, startAt: true, endAt: true } });
    if (!m) throw new NotFoundError('Appointment');
    return buildIcs({ id: m.id, title: m.title, description: m.description, location: m.location, start: m.startAt, end: m.endAt });
  },

  /**
   * Confirm the booking wherever the customer can actually be reached.
   *
   * Email only was the real reason booking "worked on the website" and nowhere
   * else: someone who booked over WhatsApp or SMS, and never gave an email
   * address, was told nothing at all. Their messaging channel is tried first,
   * because that is the conversation they are already in.
   */
  async sendConfirmation(
    meeting: { id: string; title: string; description: string | null; location: string | null; startAt: Date; endAt: Date; bookingToken: string | null },
    email: string | undefined,
    timezone: string,
    customerId?: string,
  ) {
    const links = calendarLinks({ title: meeting.title, description: meeting.description, location: meeting.location, start: meeting.startAt, end: meeting.endAt });
    const when = new Intl.DateTimeFormat('en-US', { timeZone: timezone, dateStyle: 'full', timeStyle: 'short' }).format(meeting.startAt);
    const manageUrl = `${env.WEB_APP_URL.replace(/\/+$/, '')}/appointments/${meeting.bookingToken}`;
    const bodyHtml =
      `<p>Your appointment is confirmed for <b>${when}</b> (${timezone}).</p>` +
      (meeting.location ? `<p>Location: ${meeting.location}</p>` : '') +
      `<p><a href="${links.google}">Add to Google Calendar</a> · <a href="${links.outlook}">Add to Outlook</a></p>` +
      `<p style="font-size:12px;color:#6b778c">Need to change it? <a href="${manageUrl}">Manage your appointment</a>.</p>`;
    const text =
      `Appointment confirmed for ${when} (${timezone}).` +
      (meeting.location ? `\nLocation: ${meeting.location}` : '') +
      `\nManage it here: ${manageUrl}`;

    // Whichever channels this customer is reachable on. Each is independent —
    // a customer with no WhatsApp still gets the email, and vice versa.
    if (customerId) {
      const identities = await prisma.customerIdentity.findMany({
        where: { customerId },
        select: { channelType: true },
      });
      const channels = [...new Set(identities.map((i) => i.channelType))].filter(
        (c) => c !== 'EMAIL',
      );
      for (const channel of channels) {
        await messagingService
          .sendToCustomer(customerId, channel, text, { subject: `Appointment confirmed — ${when}` })
          .catch((err) =>
            logger.warn(
              { err: (err as Error).message, channel, meetingId: meeting.id },
              'appointment confirmation channel failed',
            ),
          );
      }
    }

    if (email) {
      await mailer
        .sendNotice(email, `Appointment confirmed — ${when}`, meeting.title, bodyHtml, text)
        .catch((err) =>
          logger.warn({ err: (err as Error).message, meetingId: meeting.id }, 'appointment email failed'),
        );
    }
  },

  // ── authed management ─────────────────────────────────────────────────────

  async list(dto: { from?: string; to?: string; status?: string }) {
    const from = dto.from ? new Date(dto.from) : new Date();
    const to = dto.to ? new Date(dto.to) : new Date(Date.now() + 30 * DAY_MS);
    return prisma.meeting.findMany({
      where: { deletedAt: null, startAt: { gte: from, lte: to }, ...(dto.status ? { status: dto.status } : {}) },
      orderBy: { startAt: 'asc' },
      take: 200,
      select: { id: true, title: true, startAt: true, endAt: true, status: true, location: true, customerId: true, typeId: true, source: true, organizerId: true },
    });
  },

  /**
   * Bookings in a date range, with the names behind the ids.
   *
   * The calendar shows people and places, not foreign keys: resolving customer,
   * assigned staff, appointment type and property here means the client renders
   * one payload instead of fanning out a request per booking.
   */
  async calendar(dto: { from?: string; to?: string; status?: string; assigneeId?: string }) {
    const from = dto.from ? new Date(dto.from) : new Date();
    const to = dto.to ? new Date(dto.to) : new Date(Date.now() + 30 * DAY_MS);

    const meetings = await prisma.meeting.findMany({
      // Overlap, not containment: a booking that starts before the window and
      // runs into it still belongs on the day the user is looking at.
      where: {
        deletedAt: null,
        startAt: { lt: to },
        endAt: { gt: from },
        ...(dto.status ? { status: dto.status } : {}),
        ...(dto.assigneeId ? { organizerId: dto.assigneeId } : {}),
      },
      orderBy: { startAt: 'asc' },
      take: 500,
      select: {
        id: true, title: true, description: true, startAt: true, endAt: true, status: true,
        location: true, meetingUrl: true, customerId: true, typeId: true, source: true,
        organizerId: true, entityType: true, entityId: true, bookingToken: true,
        externalProvider: true, externalUrl: true, externalSyncedAt: true,
      },
    });
    if (meetings.length === 0) return [];

    const config = await this.getConfig().catch(() => null);
    const typeById = new Map(
      (config?.types ?? []).map((type: { id: string; name: string }) => [type.id, type.name]),
    );

    const customerIds = [...new Set(meetings.map((m) => m.customerId).filter((v): v is string => Boolean(v)))];
    const organizerIds = [...new Set(meetings.map((m) => m.organizerId).filter((v): v is string => Boolean(v)))];
    const propertyIds = [...new Set(
      meetings.filter((m) => m.entityType === 'PROPERTY').map((m) => m.entityId).filter((v): v is string => Boolean(v)),
    )];

    const [customers, organizers, properties] = await Promise.all([
      customerIds.length
        ? prisma.customer.findMany({
            where: { id: { in: customerIds } },
            select: { id: true, firstName: true, lastName: true, displayName: true, email: true, phone: true },
          })
        : [],
      organizerIds.length
        ? prisma.membership.findMany({
            where: { id: { in: organizerIds } },
            select: { id: true, jobTitle: true, user: { select: { firstName: true, lastName: true, email: true } } },
          })
        : [],
      propertyIds.length
        ? prisma.property.findMany({
            where: { id: { in: propertyIds } },
            select: { id: true, title: true, reference: true },
          })
        : [],
    ]);

    const customerById = new Map(customers.map((c) => [c.id, c]));
    const organizerById = new Map(organizers.map((o) => [o.id, o]));
    const propertyById = new Map(properties.map((p) => [p.id, p]));

    return meetings.map((m) => {
      const customer = m.customerId ? customerById.get(m.customerId) : null;
      const organizer = m.organizerId ? organizerById.get(m.organizerId) : null;
      const property = m.entityType === 'PROPERTY' && m.entityId ? propertyById.get(m.entityId) : null;
      return {
        id: m.id,
        title: m.title,
        description: m.description,
        startAt: m.startAt,
        endAt: m.endAt,
        status: m.status,
        location: m.location,
        meetingUrl: m.meetingUrl,
        source: m.source,
        service: m.typeId ? typeById.get(m.typeId) ?? null : null,
        customer: customer
          ? {
              id: customer.id,
              name: customer.displayName || [customer.firstName, customer.lastName].filter(Boolean).join(' '),
              email: customer.email,
              phone: customer.phone,
            }
          : null,
        assignee: organizer
          ? {
              id: organizer.id,
              name: [organizer.user.firstName, organizer.user.lastName].filter(Boolean).join(' ') || organizer.user.email,
              email: organizer.user.email,
              jobTitle: organizer.jobTitle,
            }
          : null,
        property: property ? { id: property.id, title: property.title, reference: property.reference } : null,
        externalProvider: m.externalProvider,
        externalUrl: m.externalUrl,
        externalSyncedAt: m.externalSyncedAt,
      };
    });
  },

  /** One booking, in the same shape the calendar uses. */
  async detail(id: string) {
    const meeting = await prisma.meeting.findFirst({ where: { id, deletedAt: null }, select: { startAt: true, endAt: true } });
    if (!meeting) throw new NotFoundError('Appointment');
    // Reuse the enrichment rather than duplicating it; the window is the
    // booking itself, so exactly one row comes back.
    const rows = await this.calendar({
      from: new Date(meeting.startAt.getTime() - 1000).toISOString(),
      to: new Date(meeting.endAt.getTime() + 1000).toISOString(),
    });
    const found = rows.find((row) => row.id === id);
    if (!found) throw new NotFoundError('Appointment');
    return found;
  },

  async cancel(id: string) {
    const meeting = await prisma.meeting.findFirst({ where: { id, deletedAt: null } });
    if (!meeting) throw new NotFoundError('Appointment');
    const updated = await prisma.meeting.update({ where: { id }, data: { status: 'CANCELLED' } });
    // A cancelled booking that stays "confirmed" on the business's calendar is
    // worse than no sync at all — they would keep the slot blocked.
    void calendarSync.pushToGoogle(id);
    await activityService.record({
      type: 'STATUS_CHANGE',
      entityType: (meeting.entityType ?? 'CUSTOMER') as 'CUSTOMER' | 'PROPERTY',
      entityId: meeting.entityId ?? meeting.customerId ?? id,
      title: `Appointment cancelled — ${meeting.title}`,
    });
    return { id: updated.id, status: updated.status };
  },

  /** Public cancel via the confirmation link's token. */
  async cancelByToken(token: string) {
    const meeting = await prismaUnscoped.meeting.findUnique({ where: { bookingToken: token } });
    if (!meeting || meeting.deletedAt) throw new NotFoundError('Appointment');
    await prismaUnscoped.meeting.update({ where: { id: meeting.id }, data: { status: 'CANCELLED' } });
    void calendarSync.pushToGoogle(meeting.id);
    return { id: meeting.id, status: 'CANCELLED' };
  },

  /**
   * Reminder sweep (best-effort): email a reminder for confirmed appointments
   * starting within the next `windowMin` minutes that haven't been reminded yet.
   */
  async sendDueReminders(windowMin = 60): Promise<number> {
    const now = new Date();
    const until = new Date(now.getTime() + windowMin * 60_000);
    const due = await prismaUnscoped.meeting.findMany({
      where: { status: 'CONFIRMED', deletedAt: null, reminderSentAt: null, startAt: { gt: now, lte: until } },
      take: 100,
      select: { id: true, title: true, location: true, startAt: true, organizationId: true, attendees: true },
    });
    let sent = 0;
    for (const m of due) {
      const attendee = (Array.isArray(m.attendees) ? m.attendees : []).find((a) => a && typeof a === 'object' && (a as { email?: string }).email) as { email?: string } | undefined;
      if (attendee?.email) {
        const cfg = await readConfig(m.organizationId);
        const when = new Intl.DateTimeFormat('en-US', { timeZone: cfg.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(m.startAt);
        await mailer
          .sendNotice(attendee.email, `Reminder: ${m.title}`, m.title, `<p>This is a reminder for your appointment on <b>${when}</b>.</p>${m.location ? `<p>Location: ${m.location}</p>` : ''}`, `Reminder: your appointment is on ${when}.`)
          .catch(() => undefined);
        sent++;
      }
      await prismaUnscoped.meeting.update({ where: { id: m.id }, data: { reminderSentAt: new Date() } });
    }
    if (sent > 0) logger.info({ sent }, 'Appointment reminders sent');
    return sent;
  },
};

/** Start the reminder sweep (best-effort). Interval in minutes; 0 disables. */
export function startAppointmentReminderSweep(intervalMin = 5): void {
  if (intervalMin <= 0) return;
  setInterval(() => {
    appointmentsService.sendDueReminders().catch((err) => logger.warn({ err: (err as Error).message }, 'Appointment reminder sweep failed'));
  }, intervalMin * 60_000).unref();
}
