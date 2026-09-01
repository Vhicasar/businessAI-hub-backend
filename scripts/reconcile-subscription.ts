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
import { getPaymentConfig } from '../src/infrastructure/payments/config';
import { syncPaymentConfigFromAdmin } from '../src/application/billing/payment-config-sync';

const args = process.argv.slice(2);
const slug = args[0];
const apply = args.includes('--apply');
const refFlag = args.indexOf('--reference');
let reference = refFlag >= 0 ? args[refFlag + 1] : undefined;
const find = args.includes('--find');
const daysFlag = args.indexOf('--days');
const days = daysFlag >= 0 ? Number(args[daysFlag + 1]) : 30;

/**
 * Find this business's successful charges at the gateway.
 *
 * Deliberately outside the PaymentProvider abstraction: listing transactions
 * is not something the running system ever needs, and adding it to the
 * interface would mean implementing it for five gateways to serve a recovery
 * script. Activation still goes through `verifyReference`, which re-checks the
 * charge through the provider proper — this only answers "which reference?".
 *
 * Paystack only. Other gateways: find the reference in their dashboard and
 * pass it with --reference.
 */
async function findReferences(orgId: string): Promise<{ reference: string; amount: number; currency: string; paidAt: string }[]> {
  // Already refreshed from the admin in main().
  const config = getPaymentConfig();
  if (config.provider !== 'paystack') {
    throw new Error(`--find only supports Paystack; this deployment uses ${config.provider}.`);
  }
  if (!config.secretKey) throw new Error('No gateway secret key is configured.');

  const from = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const url = `https://api.paystack.co/transaction?status=success&perPage=100&from=${from}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${config.secretKey}` } });
  if (!res.ok) throw new Error(`Gateway returned ${res.status} listing transactions.`);
  const body = (await res.json()) as { data?: unknown[] };

  const prefix = `bh_${orgId.slice(0, 8)}_`;
  return (body.data ?? [])
    .map((t) => t as { reference?: string; amount?: number; currency?: string; paid_at?: string; metadata?: Record<string, unknown> })
    // Match on our own reference prefix, and on the metadata we set at
    // checkout — a charge is only this business's if it says so.
    .filter((t) =>
      (t.reference ?? '').startsWith(prefix) ||
      String((t.metadata ?? {}).organizationId ?? '') === orgId)
    .map((t) => ({
      reference: String(t.reference),
      amount: Number(t.amount ?? 0) / 100,
      currency: String(t.currency ?? ''),
      paidAt: String(t.paid_at ?? ''),
    }));
}

async function main() {
  if (!slug) {
      console.error(
      'Usage: npx tsx scripts/reconcile-subscription.ts <org-slug> [--find | --reference <ref>] [--days N] [--apply]',
    );
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

  /*
   * Load the gateway credentials the running API uses.
   *
   * The admin is the source of truth for which gateway and which keys, and it
   * installs them into an in-memory override at startup. A script is a fresh
   * process, so without this it silently falls back to the local PAYSTACK_*
   * env — a different account, or none. The charge is then genuinely absent
   * from whichever account it does ask, and the gateway answers "transaction
   * reference not found" about a transaction that plainly exists.
   */
  const fromAdmin = await syncPaymentConfigFromAdmin().catch(() => false);
  const config = getPaymentConfig();
  const keySource = config.secretKey
    ? (config.secretKey.startsWith('sk_live_') || config.secretKey.startsWith('FLWSECK-')
        ? 'live'
        : config.secretKey.startsWith('sk_test_')
          ? 'TEST'
          : 'unrecognised prefix')
    : 'MISSING';
  console.log(
    `Gateway: ${config.provider} · key: ${keySource} · from: ${fromAdmin ? 'admin' : 'local env'}`,
  );
  if (!fromAdmin) {
    console.log(
      '  The admin did not supply a payment configuration, so the local\n' +
      '  PAYSTACK_* env is being used. If the charge was taken with the\n' +
      '  admin-managed account, it will not be found here.',
    );
  }
  if (!config.secretKey) {
    console.error(
      '\nNo gateway secret key resolved. The admin has none configured for this\n' +
      'product and no local key is set, so nothing can be verified.',
    );
    process.exit(1);
  }
  if (keySource === 'TEST') {
    console.warn(
      'This is a TEST key. A live charge will not be found with it — check the\n' +
      'gateway configured in Admin → Products for this deployment.',
    );
  }
  console.log('');

  if (!reference && find) {
    console.log(`Asking the gateway for successful charges in the last ${days} days…`);
    const hits = await findReferences(org.id);
    if (hits.length === 0) {
      console.log('\nThe gateway reports no successful charge for this business in that window.');
      console.log('Either the payment never completed, or it is older — try --days 90.');
      return;
    }
    console.log(`\nFound ${hits.length}:`);
    for (const h of hits) {
      console.log(`  ${h.reference}  ${h.currency} ${h.amount}  ${h.paidAt.slice(0, 16).replace('T', ' ')}`);
    }
    if (hits.length > 1) {
      console.log('\nMore than one. Pass the intended one with --reference.');
      return;
    }
    reference = hits[0]!.reference;
    console.log(`\nUsing ${reference}.`);
  }

  if (!reference) {
    console.log('No --reference given.');
    console.log(`References for this business start "bh_${org.id.slice(0, 8)}_".`);
    console.log('Either pass one with --reference, or let the gateway be asked:');
    console.log(`  npx tsx scripts/reconcile-subscription.ts ${org.slug} --find`);
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
