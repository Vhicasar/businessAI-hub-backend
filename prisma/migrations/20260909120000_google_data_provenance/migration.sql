ALTER TABLE "Meeting"
ADD COLUMN "dataSource" TEXT NOT NULL DEFAULT 'VHICASAR';

UPDATE "Meeting"
SET "dataSource" = 'GOOGLE_API_MIXED'
WHERE "externalProvider" = 'google_calendar';
