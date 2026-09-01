/**
 * Why is a business still on the wrong plan after paying?
 *
 * A subscription only moves when `billingService.activate()` runs, and that
 * happens in exactly two places: the gateway's webhook, and the browser
 * callback calling `/billing/verify`. The web app does both; a payment started
 * from the phone opens the gateway in an external browser and never comes
 * back, so the webhook is its only path. When that path fails there is nothing
 * to notice it — the money is taken, the subscription is untouched, and both
 * the app and the admin go on reporting the old plan because that is what the
 * database says.
 *
 * This reads, and only reads. It prints what the org's subscription actually
 * is, what was actually paid, and which of the two is missing — so the answer
 * comes from production rather than from a guess about it.
 *
 *   npx tsx scripts/diagnose-subscription.ts <org-slug-or-id>
 */
import { prismaUnscoped as db } from '../src/infrastructure/database/prisma';
import { syncPaymentConfigFromAdmin } from '../src/application/billing/payment-config-sync';
import { getPaymentConfig } from '../src/infrastructure/payments/config';

const ACTIVE = ['TRIALING', 'ACTIVE', 'PAST_DUE'] as const;

const money = (v: unknown, c = '') => `${c} ${Number(v).toLocaleString()}`.trim();
const when = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 16).replace('T', ' ') : '—');

async function main() {
  const key = process.argv[2];
  if (!key) {
    console.error('Usage: npx tsx scripts/diagnose-subscription.ts <org-slug-or-id>');
    process.exit(1);
  }

  const org = await db.organization.findFirst({
    where: { OR: [{ slug: key }, { id: key }] },
    select: { id: true, name: true, slug: true, currency: true, createdAt: true },
  });
  if (!org) {
    console.error(`No organization with slug or id "${key}".`);
    process.exit(1);
  }

  console.log(`\nBUSINESS  ${org.name}  (${org.slug})`);
  console.log(`          id ${org.id} · signed up ${when(org.createdAt)} · ${org.currency}`);

  // ── What the app and the admin are both reading ────────────────────────
  const subs = await db.subscription.findMany({
    where: { organizationId: org.id },
    orderBy: { createdAt: 'desc' },
    include: { plan: { select: { name: true, slug: true } } },
  });

  console.log(`\nSUBSCRIPTIONS (${subs.length})`);
  for (const s of subs) {
    const counted = (ACTIVE as readonly string[]).includes(s.status);
    console.log(
      `  ${counted ? '→' : ' '} ${s.plan.slug.padEnd(10)} ${s.status.padEnd(10)}` +
        ` period ${when(s.currentPeriodStart)} → ${when(s.currentPeriodEnd)}` +
        ` · trial ends ${when(s.trialEndsAt)} · created ${when(s.createdAt)}`,
    );
    if (s.providerSubscriptionCode) {
      console.log(`      gateway subscription ${s.providerSubscriptionCode}`);
    }
  }

  // The resolver's own rule, repeated here rather than imported, so this says
  // what the running system reads and not what a refactor intended.
  const effective = subs.find(
    (s) => (ACTIVE as readonly string[]).includes(s.status) && s.currentPeriodEnd > new Date(),
  );
  console.log(
    `\nEFFECTIVE PLAN  ${effective ? `${effective.plan.name} (${effective.plan.slug}) — ${effective.status}` : 'starter (no active subscription)'}`,
  );
  console.log('  This is exactly what the app gates on and what the admin displays.');

  // ── What was actually paid ─────────────────────────────────────────────
  const records = await db.billingRecord.findMany({
    where: { subscription: { organizationId: org.id } },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  console.log(`\nBILLING RECORDS (${records.length})`);
  if (records.length === 0) {
    console.log('  none — no payment has ever been recorded against this business');
  }
  for (const r of records) {
    console.log(
      `  ${r.status.padEnd(8)} ${money(r.amount, r.currency).padEnd(16)}` +
        ` ${when(r.paidAt ?? r.createdAt)} · ${r.provider ?? '—'} · ref ${r.providerRef ?? '—'}`,
    );
  }

  // ── The verdict ────────────────────────────────────────────────────────
  /*
   * Which gateway account this deployment actually talks to.
   *
   * The admin installs the provider and keys at runtime, so a script has to
   * ask for them explicitly or it reads the local env instead — and then
   * reports on the wrong Paystack account without saying so.
   */
  const fromAdmin = await syncPaymentConfigFromAdmin().catch(() => false);
  const config = getPaymentConfig();
  const mode = !config.secretKey
    ? 'MISSING'
    : config.secretKey.startsWith('sk_test_')
      ? 'TEST'
      : 'live';
  console.log(
    `\nGATEWAY  ${config.provider} · key ${mode} · from ${fromAdmin ? 'admin' : 'local env'}`,
  );
  if (mode !== 'live') {
    console.log('  A charge made on the live account cannot be found with this key.');
    console.log('  Check Admin → Products → payment configuration for this product.');
  }

  console.log('\nVERDICT');
  const paidPlanSub = subs.find((s) => s.plan.slug !== 'starter' && (ACTIVE as readonly string[]).includes(s.status));
  const hasPayment = records.some((r) => r.status === 'PAID');

  if (paidPlanSub) {
    console.log('  The paid plan is active. If the app still shows the old one, the');
    console.log('  client is holding a stale session — sign out and in to re-read it.');
  } else if (hasPayment) {
    console.log('  Money was recorded but the subscription was never moved onto the');
    console.log('  paid plan — a partial activation. Re-run the reference through');
    console.log('  activation with');
    console.log(`    npx tsx scripts/reconcile-subscription.ts ${org.slug} --find --apply`);
  } else {
    console.log('  No payment is recorded here at all. Either the customer never');
    console.log('  completed the gateway checkout, or it succeeded there and nothing');
    console.log('  ever told this system about it.');
    console.log('');
    console.log('  The second is what happened before the billing callback was fixed:');
    console.log('  the gateway returned the customer to /settings/billing, an alias');
    console.log('  that redirected to /billing and dropped the ?reference on the way,');
    console.log('  so the page had nothing to verify. That left the webhook as the');
    console.log('  only route to activation — and a payment made while it was not');
    console.log('  firing was never recorded anywhere.');
    console.log('');
    console.log('  Deploying the fix does not settle a payment already in that state.');
    console.log('  Ask the gateway what it has, and settle it:');
    console.log(`    npx tsx scripts/reconcile-subscription.ts ${org.slug} --find`);
    console.log(`    npx tsx scripts/reconcile-subscription.ts ${org.slug} --find --apply`);
  }
  console.log('');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
