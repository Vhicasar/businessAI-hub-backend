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
  console.log('\nVERDICT');
  const paidPlanSub = subs.find((s) => s.plan.slug !== 'starter' && (ACTIVE as readonly string[]).includes(s.status));
  const hasPayment = records.some((r) => r.status === 'PAID');

  if (paidPlanSub) {
    console.log('  The paid plan is active. If the app still shows the old one, the');
    console.log('  client is holding a stale session — sign out and in to re-read it.');
  } else if (hasPayment) {
    console.log('  Money was recorded but the subscription was never moved onto the');
    console.log('  paid plan. That is a partial activation: re-run the reference');
    console.log('  through activation with');
    console.log(`    npx tsx scripts/reconcile-subscription.ts ${org.slug} --apply`);
  } else {
    console.log('  No payment is recorded here at all. Either the customer never');
    console.log('  completed the gateway checkout, or the payment succeeded at the');
    console.log('  gateway and neither the webhook nor a browser callback ever told');
    console.log('  us about it — which is what happens when the checkout was started');
    console.log('  from the phone.');
    console.log('');
    console.log('  Confirm at the gateway: look for a successful charge whose');
    console.log(`  reference begins "bh_${org.id.slice(0, 8)}_". If one exists, settle it with`);
    console.log(`    npx tsx scripts/reconcile-subscription.ts ${org.slug} --reference <ref> --apply`);
  }
  console.log('');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
