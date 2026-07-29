-- Appointment booking (#12) extends Meeting into a bookable appointment:
-- lifecycle status, the customer it's for, the appointment type, where it was
-- booked from, an unguessable public manage/cancel token, and a reminder-sent
-- marker so the reminder sweep never double-sends.
ALTER TABLE "Meeting" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'CONFIRMED';
ALTER TABLE "Meeting" ADD COLUMN "customerId" TEXT;
ALTER TABLE "Meeting" ADD COLUMN "typeId" TEXT;
ALTER TABLE "Meeting" ADD COLUMN "source" TEXT;
ALTER TABLE "Meeting" ADD COLUMN "bookingToken" TEXT;
ALTER TABLE "Meeting" ADD COLUMN "reminderSentAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "Meeting_bookingToken_key" ON "Meeting"("bookingToken");
CREATE INDEX "Meeting_customerId_idx" ON "Meeting"("customerId");
CREATE INDEX "Meeting_status_startAt_idx" ON "Meeting"("status", "startAt");
