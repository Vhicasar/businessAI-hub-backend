/**
 * Settle a payment the gateway took but this system never acted on.
 *
 * Deliberately not "set the plan to Growth". The plan is derived from a
 * verified transaction: the reference is re-checked against the gateway's own
 * API, and only a charge the gateway itself calls successful activates
 * anything. Anything else would be a way to hand out paid plans by typing, and
 * it would be indistinguishable in the record from a real payment.
 *
 * Dry by default — it prints what it would do and changes nothing until
 * `--apply` is passed.
 *
 *   npx tsx scripts/reconcile-subscription.ts <org-slug> [--reference <ref>] [--apply]
 *
 * With no reference, it looks for this org's own references among the recent
 * transactions the gateway reports.
 */
import { prismaUnscoped as db } from '../src/infrastructure/database/prisma';
import { billingService } from '../src/application/billing/billing.service';
import { getActivePaymentProvider } from '../src/infrastructure/payments';

const args = process.argv.slice(2);
const slug = args[0];
const apply = args.includes('--apply');
const refFlag = args.indexOf('--reference');
const reference = refFlag >= 0 ? args[refFlag + 1] : undefined;

async function main() {
  if (!slug) {
    console.error('Usage: npx tsx scripts/reconcile-subscription.ts <org-slug> [--reference <ref>] [--apply]');
    process.exit(1);
  }

  const org = await db.organization.findFirst({
    where: { OR: [{ slug }, { id: slug }] },
    select: { id: true, name: true, slug: true },
  });
  if (!org) {
    console.error(`No organization "${slug}".`);
    process.exit(1);
  }

  console.log(`\n${org.name} (${org.slug})`);
  console.log(apply ? 'APPLYING CHANGES\n' : 'DRY RUN — nothing will be changed. Add --apply to commit.\n');

  if (!reference) {
    console.log('No --reference given.');
    console.log(`References for this business start "bh_${org.id.slice(0, 8)}_".`);
    console.log('Find the successful charge in the gateway dashboard and pass it with --reference.');
    return;
  }

  // Refuse a reference that belongs to someone else. The metadata is checked
  // again inside verifyReference, but failing here says why, rather than
  // activating the wrong business and being discovered later.
  const expectedPrefix = `bh_${org.id.slice(0, 8)}_`;
  if (!reference.startsWith(expectedPrefix)) {
    console.error(
      `Reference "${reference}" does not belong to ${org.slug} — it should start "${expectedPrefix}".`,
    );
    process.exit(1);
  }

  const already = await db.billingRecord.findFirst({ where: { providerRef: reference } });
  if (already) {
    console.log(`A billing record already exists for ${reference} (${already.status}).`);
    // The record existing is not proof the subscription moved: `verifyReference`
    // short-circuits on it, so this is exactly the case that can sit unnoticed.
    const subs = await db.subscription.findMany({
      where: { organizationId: org.id },
      include: { plan: { select: { slug: true } } },
      orderBy: { createdAt: 'desc' },
    });
    const active = subs.find((s) => ['TRIALING', 'ACTIVE', 'PAST_DUE'].includes(s.status));
    console.log(`Current effective plan: ${active ? `${active.plan.slug} (${active.status})` : 'none'}`);
    if (active && active.plan.slug !== 'starter') {
      console.log('Already on a paid plan — nothing to do.');
      return;
    }
    console.log('\nPayment recorded but the plan was not moved. Re-activating from the');
    console.log('transaction metadata.');
  }

  const provider = getActivePaymentProvider();
  console.log(`Verifying ${reference} with ${provider.name}…`);
  const txn = await provider.verifyTransaction(reference);
  console.log(`  gateway says: ${txn.status} · ${txn.currency} ${txn.amount / 100}`);
  if (txn.status !== 'success') {
    console.error('  Not a successful charge — refusing to activate anything.');
    process.exit(1);
  }

  const meta = (txn.metadata ?? {}) as Record<string, unknown>;
  const metaOrg = String(meta.organizationId ?? '');
  const planId = String(meta.planId ?? '');
  if (metaOrg !== org.id) {
    console.error(`  This charge belongs to organization ${metaOrg || '(none)'}, not ${org.id}.`);
    process.exit(1);
  }
  if (!planId) {
    console.error('  The charge carries no plan in its metadata — cannot tell what was bought.');
    process.exit(1);
  }

  const plan = await db.plan.findUnique({ where: { id: planId }, select: { name: true, slug: true } });
  console.log(`  paid for: ${plan?.name ?? planId} (${plan?.slug ?? '?'})`);

  if (!apply) {
    console.log('\nWould activate that plan for this business. Re-run with --apply.');
    return;
  }

  // The same path the webhook takes, so the result is identical to the one
  // that should have happened at the time — including the billing record.
  await billingService.verifyReference(reference);

  const after = await db.subscription.findFirst({
    where: { organizationId: org.id, status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] } },
    orderBy: { createdAt: 'desc' },
    include: { plan: { select: { name: true, slug: true } } },
  });
  console.log(`\nNow on: ${after ? `${after.plan.name} (${after.plan.slug}) — ${after.status}` : 'still nothing'}`);
  console.log('The customer may need to sign out and in for the app to re-read its limits.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
