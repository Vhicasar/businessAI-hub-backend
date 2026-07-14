/**
 * Test environment bootstrap — runs before any application import.
 *
 * Unit tests need env defaults so `shared/config/env` validates.
 * Integration tests additionally need TEST_DATABASE_URL pointing at a
 * dedicated, migrated database (see docs/PHASE-7-REVIEW.md); it becomes
 * DATABASE_URL for the whole test process.
 */
process.env.NODE_ENV = 'test';
process.env.JWT_ALG ??= 'HS256';
process.env.JWT_SECRET ??= 'test-secret-test-secret-test-secret-42';
process.env.ENCRYPTION_KEY ??=
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
process.env.LOG_LEVEL ??= 'error';
process.env.AI_PROVIDER ??= 'none';
process.env.SMTP_HOST ??= '';

if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
} else {
  // Unit tests never touch the DB, but the Prisma client is constructed on
  // import — give it a syntactically valid URL.
  process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/businesshub_test';
}
