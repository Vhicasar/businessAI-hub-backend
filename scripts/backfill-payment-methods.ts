/**
 * Turn on sensible payment methods for businesses that were already collecting.
 *
 * The resolver treats "no setting" as off, so a business must opt in to each
 * way of taking money. That is right for a new business and wrong for one that
 * was already taking card payments yesterday — without this they would wake up
 * to a payment page offering nothing.
 *
 * So: any business with a connected, enabled gateway gets the methods it was
 * effectively already using switched on, bounded by what its provider actually
 * supports. Businesses that never connected a gateway are left alone; there is
 * nothing to preserve and enabling methods for them would be inventing intent.
 *
 * Idempotent — it only ever creates rows that are missing, and never overrides
 * a choice a business has already made.
 *
 *   npx tsx scripts/backfill-payment-methods.ts [--dry-run]
 */
import type { PaymentMethodKind } from '@prisma/client';
import { prismaUnscoped as db } from '../src/infrastructure/database/prisma';
import { PROVIDER_CAPABILITIES } from '../src/infrastructure/payments/capabilities';
import type { PaymentProviderName } from '../src/infrastructure/payments';

const DRY_RUN = process.argv.includes('--dry-run');

/**
 * What a business collecting through a gateway was already able to take.
 * Deliberately conservative: card and bank transfer are what a payment link
 * actually offered before this change. Anything more exotic is a new capability
 * and should be a deliberate choice, not a surprise.
 */
const DEFAULTS: PaymentMethodKind[] = ['CARD', 'BANK_TRANSFER'];

async function main() {
  const orgs = await db.organization.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true, settings: true },
  });

  let touched = 0;
  let created = 0;
  let skipped = 0;

  for (const org of orgs) {
    const account = ((org.settings as Record<string, unknown>) ?? {}).paymentAccount as
      | { provider?: PaymentProviderName; enabled?: boolean; secretKeyEnc?: string | null }
      | undefined;

    if (!account?.provider || !account.enabled || !account.secretKeyEnc) {
      skipped += 1;
      continue;
    }

    const supported = new Set(
      (PROVIDER_CAPABILITIES[account.provider] ?? []).map((c) => c.method)
    );
    const wanted = DEFAULTS.filter((m) => supported.has(m));
    if (wanted.length === 0) {
      skipped += 1;
      continue;
    }

    const existing = await db.paymentMethodSetting.findMany({
      where: { organizationId: org.id },
      select: { method: true },
    });
    const have = new Set(existing.map((e) => e.method));
    const missing = wanted.filter((m) => !have.has(m));
    if (missing.length === 0) {
      skipped += 1;
      continue;
    }

    touched += 1;
    if (DRY_RUN) {
      console.log(`  would enable ${missing.join(', ')} for ${org.name}`);
      created += missing.length;
      continue;
    }

    for (const method of missing) {
      await db.paymentMethodSetting.create({
        data: {
          organizationId: org.id,
          method,
          enabled: true,
          currencies: [],
          sortOrder: DEFAULTS.indexOf(method),
        },
      });
      created += 1;
    }
    console.log(`  ✓ ${org.name}: ${missing.join(', ')}`);
  }

  console.log(
    `\n${touched} business(es) updated, ${created} method(s) enabled, ${skipped} left alone` +
      (DRY_RUN ? ' (dry run)' : '')
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
