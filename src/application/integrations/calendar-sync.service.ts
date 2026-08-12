import { prismaUnscoped } from '../../infrastructure/database/prisma';
import { logger } from '../../shared/logger';
import { oauthConnections } from './oauth-connection.service';

/**
 * Keeping bookings and the business's own calendar in step.
 *
 * Two different shapes, because the two providers are different tools:
 *
 * - Google Calendar is a *destination*. Bookings taken in Vhicasar Hub are
 *   mirrored onto the connected calendar so the business sees them beside
 *   everything else in their day.
 * - Calendly is a *source*. Bookings are made there and imported here, so the
 *   Bookings calendar is complete rather than showing only what came through
 *   this app.
 *
 * Every operation degrades quietly: a booking must still save when the calendar
 * is unreachable. A sync failure is logged and retried on the next change, and
 * `externalSyncedAt` shows an operator when a connection has stopped working.
 */

const GOOGLE_EVENTS = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

interface MeetingForSync {
  id: string;
  organizationId: string;
  title: string;
  description: string | null;
  location: string | null;
  meetingUrl: string | null;
  startAt: Date;
  endAt: Date;
  status: string;
  externalProvider: string | null;
  externalEventId: string | null;
}

async function googleFetch(
  token: string,
  url: string,
  init: RequestInit = {}
): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Google Calendar ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.status === 204 ? {} : ((await res.json()) as Record<string, unknown>);
}

function googleEventBody(meeting: MeetingForSync) {
  return {
    summary: meeting.title,
    description: [meeting.description, meeting.meetingUrl].filter(Boolean).join('\n\n') || undefined,
    location: meeting.location ?? undefined,
    start: { dateTime: meeting.startAt.toISOString() },
    end: { dateTime: meeting.endAt.toISOString() },
    // Cancelling here should grey the event out rather than silently leave a
    // confirmed-looking slot on the business's calendar.
    status: meeting.status === 'CANCELLED' ? 'cancelled' : 'confirmed',
  };
}

export const calendarSync = {
  /**
   * Mirror one booking onto the connected Google Calendar.
   *
   * Safe to call on every create and update: it creates the event the first
   * time and patches it afterwards, keyed on the stored event id.
   */
  async pushToGoogle(meetingId: string): Promise<void> {
    const meeting = (await prismaUnscoped.meeting.findUnique({
      where: { id: meetingId },
      select: {
        id: true, organizationId: true, title: true, description: true, location: true,
        meetingUrl: true, startAt: true, endAt: true, status: true,
        externalProvider: true, externalEventId: true,
      },
    })) as MeetingForSync | null;
    if (!meeting) return;

    // A booking imported *from* Calendly is not ours to push to Google.
    if (meeting.externalProvider && meeting.externalProvider !== 'google_calendar') return;

    const token = await oauthConnections.accessToken('google_calendar', meeting.organizationId);
    if (!token) return; // not connected, or needs re-authorising

    try {
      const existing = meeting.externalProvider === 'google_calendar' ? meeting.externalEventId : null;
      const event = existing
        ? await googleFetch(token, `${GOOGLE_EVENTS}/${encodeURIComponent(existing)}`, {
            method: 'PATCH',
            body: JSON.stringify(googleEventBody(meeting)),
          })
        : await googleFetch(token, GOOGLE_EVENTS, {
            method: 'POST',
            body: JSON.stringify(googleEventBody(meeting)),
          });

      await prismaUnscoped.meeting.update({
        where: { id: meeting.id },
        data: {
          externalProvider: 'google_calendar',
          externalEventId: event.id ? String(event.id) : meeting.externalEventId,
          externalUrl: event.htmlLink ? String(event.htmlLink) : null,
          externalSyncedAt: new Date(),
        },
      });
    } catch (err) {
      // An event deleted at Google leaves a stale id; clearing it lets the next
      // push recreate rather than fail forever on a 404.
      const message = (err as Error).message;
      if (message.includes('404') && meeting.externalEventId) {
        await prismaUnscoped.meeting.update({
          where: { id: meeting.id },
          data: { externalEventId: null, externalProvider: null },
        });
      }
      logger.warn({ err: message, meetingId }, 'google calendar push failed');
    }
  },

  /** Remove the mirrored event when a booking is deleted outright. */
  async removeFromGoogle(organizationId: string, externalEventId: string): Promise<void> {
    const token = await oauthConnections.accessToken('google_calendar', organizationId);
    if (!token) return;
    try {
      await googleFetch(token, `${GOOGLE_EVENTS}/${encodeURIComponent(externalEventId)}`, { method: 'DELETE' });
    } catch (err) {
      logger.warn({ err: (err as Error).message, externalEventId }, 'google calendar delete failed');
    }
  },

  /**
   * Import Calendly's scheduled events as bookings.
   *
   * Upserts on the event URI, so re-running is harmless and a rescheduled event
   * updates the same booking rather than creating a second one.
   */
  async pullFromCalendly(organizationId: string, since?: Date): Promise<{ imported: number; updated: number }> {
    const token = await oauthConnections.accessToken('calendly', organizationId);
    if (!token) return { imported: 0, updated: 0 };

    const userUri = await oauthConnections.externalId('calendly', organizationId);
    if (!userUri) {
      logger.warn({ organizationId }, 'calendly connected but no user uri recorded');
      return { imported: 0, updated: 0 };
    }

    const from = since ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const params = new URLSearchParams({
      user: userUri,
      min_start_time: from.toISOString(),
      count: '100',
      sort: 'start_time:asc',
    });

    let imported = 0;
    let updated = 0;
    try {
      const res = await fetch(`https://api.calendly.com/scheduled_events?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Calendly ${res.status}`);
      const body = (await res.json()) as { collection?: Record<string, unknown>[] };

      for (const event of body.collection ?? []) {
        const uri = String(event.uri ?? '');
        if (!uri) continue;
        const location = (event.location ?? {}) as Record<string, unknown>;
        const startAt = new Date(String(event.start_time));
        const endAt = new Date(String(event.end_time));
        if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) continue;

        const data = {
          title: String(event.name ?? 'Calendly booking'),
          startAt,
          endAt,
          // Calendly's own vocabulary is active/canceled.
          status: String(event.status ?? 'active') === 'canceled' ? 'CANCELLED' : 'CONFIRMED',
          location: typeof location.location === 'string' ? location.location : null,
          meetingUrl: typeof location.join_url === 'string' ? location.join_url : null,
          externalUrl: uri,
          externalSyncedAt: new Date(),
          source: 'CALENDLY',
        };

        const existing = await prismaUnscoped.meeting.findFirst({
          where: { organizationId, externalProvider: 'calendly', externalEventId: uri },
          select: { id: true },
        });
        if (existing) {
          await prismaUnscoped.meeting.update({ where: { id: existing.id }, data });
          updated += 1;
        } else {
          await prismaUnscoped.meeting.create({
            data: { ...data, organizationId, externalProvider: 'calendly', externalEventId: uri },
          });
          imported += 1;
        }
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message, organizationId }, 'calendly pull failed');
    }
    return { imported, updated };
  },

  /** Whether an organisation has a working connection to a calendar provider. */
  async connectedProviders(organizationId: string): Promise<string[]> {
    const rows = await prismaUnscoped.integrationCredential.findMany({
      where: { organizationId, provider: { in: ['google_calendar', 'calendly'] }, isActive: true },
      select: { provider: true, metadata: true },
    });
    return rows
      .filter((row) => !(row.metadata as Record<string, unknown> | null)?.needsReauth)
      .map((row) => row.provider);
  },
};
