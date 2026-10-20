/*
 * Plan versioning: the three scenarios the specification names, plus the
 * guarantee underneath all of them.
 *
 * That guarantee is the point of the whole feature: editing a plan must never
 * change what a business already subscribed to. Before versioning, the admin
 * sync upserted the plan row by slug every few minutes, so a price change in
 * the admin silently re-priced and re-limited every existing subscriber,
 * retroactively and with no record.
 *
 * Throwaway plans and organizations; everything is removed at the end.
 */
import { prismaUnscoped as db } from '../../src/infrastructure/database/prisma';
import { resolveEntitlements } from '../../src/application/billing/entitlements';
import { createVersion, diffTerms, termsOfVersion } from '../../src/application/billing/plan-versions';
import { planMigrationService } from '../../src/application/billing/plan-migration.service';
import { planVersionAdmin } from '../../src/application/billing/plan-version-admin.service';

let passed = 0, failed = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); }
};

const stamp = Date.now();
let planId = '', v1Id = '', v2Id = '';
const orgIds: string[] = [];

const V1 = {
  priceMonthly: 50_000, priceYearly: 500_000, currency: 'NGN', prices: null,
  maxUsers: 5, maxBranches: 2, maxProducts: null, maxChannels: 3,
  maxContacts: 1000, maxMarketingReach: 1000, aiCreditsMonthly: 500,
  features: ['featureA', 'featureB'],
};
const V2 = {
  ...V1, priceMonthly: 75_000, priceYearly: 750_000,
  maxUsers: 10, maxBranches: 5, maxMarketingReach: 5000,
  features: ['featureA', 'featureB', 'featureC'],
};

async function makeOrgOn(versionId: string, label: string) {
  const org = await db.organization.create({
    data: { name: `PV ${label} ${stamp}`, slug: `pv-${label}-${stamp}`.toLowerCase(), currency: 'NGN', status: 'ACTIVE', country: 'NG' },
  });
  orgIds.push(org.id);
  const now = new Date();
  await db.subscription.create({
    data: {
      organizationId: org.id, planId, planVersionId: versionId, status: 'ACTIVE', interval: 'MONTHLY',
      currentPeriodStart: now, currentPeriodEnd: new Date(now.getTime() + 30 * 86_400_000),
    },
  });
  return org.id;
}

async function main() {
  const plan = await db.plan.create({
    data: {
      name: `Growth PV ${stamp}`, slug: `growth-pv-${stamp}`,
      priceMonthly: V1.priceMonthly, priceYearly: V1.priceYearly, currency: 'NGN',
      maxUsers: V1.maxUsers, maxBranches: V1.maxBranches, maxChannels: V1.maxChannels,
      maxContacts: V1.maxContacts, maxMarketingReach: V1.maxMarketingReach,
      aiCreditsMonthly: V1.aiCreditsMonthly, features: V1.features, isPublic: false,
    },
  });
  planId = plan.id;
  v1Id = (await createVersion(planId, V1, { notes: 'v1' })).id;

  // ── The guarantee ────────────────────────────────────────────────────────
  console.log('\nEditing a plan does not change an existing subscriber');
  const orgA = await makeOrgOn(v1Id, 'a');
  const before = await resolveEntitlements(orgA);
  check('a subscriber starts on v1 terms',
    before.limits.maxUsers === 5 && before.limits.maxBranches === 2 && !before.features.has('featureC'),
    JSON.stringify(before.limits));
  check('and the entitlements say which version answered', before.planVersion === 1, String(before.planVersion));

  // The old hazard, reproduced exactly: rewrite the plan row in place.
  await db.plan.update({
    where: { id: planId },
    data: { priceMonthly: V2.priceMonthly, maxUsers: V2.maxUsers, maxBranches: V2.maxBranches, features: V2.features },
  });
  const afterEdit = await resolveEntitlements(orgA);
  check('rewriting the plan row leaves the subscriber untouched',
    afterEdit.limits.maxUsers === 5 && afterEdit.limits.maxBranches === 2 && !afterEdit.features.has('featureC'),
    `users=${afterEdit.limits.maxUsers} businesses=${afterEdit.limits.maxBranches} featureC=${afterEdit.features.has('featureC')}`);

  // ── Scenario A — grandfather ─────────────────────────────────────────────
  console.log('\nScenario A — publish v2, keep existing subscribers');
  v2Id = (await createVersion(planId, V2, { notes: 'v2 — more seats, more credits, Feature C' })).id;
  const stillA = await resolveEntitlements(orgA);
  check('the existing business stays on v1', stillA.planVersion === 1, String(stillA.planVersion));
  check('with v1 limits and no new feature',
    stillA.limits.maxUsers === 5 && !stillA.features.has('featureC'));

  const orgB = await makeOrgOn(v2Id, 'b');
  const newB = await resolveEntitlements(orgB);
  check('a business subscribing afterwards gets v2',
    newB.planVersion === 2 && newB.limits.maxUsers === 10 && newB.features.has('featureC'),
    `v${newB.planVersion} users=${newB.limits.maxUsers}`);

  const v1Row = await db.planVersion.findUniqueOrThrow({ where: { id: v1Id } });
  check('v1 is retired but not deleted', v1Row.retiredAt !== null);
  const overview = (await planVersionAdmin.overview()).find((p) => p.id === planId)!;
  check('the admin sees who is grandfathered',
    overview.grandfatheredSubscribers === 1 && overview.activeSubscribers === 1,
    `grandfathered=${overview.grandfatheredSubscribers} current=${overview.activeSubscribers}`);

  // ── The comparison an admin sees before publishing ───────────────────────
  console.log('\nComparison before publishing');
  const changes = diffTerms(termsOfVersion(v1Row), termsOfVersion(await db.planVersion.findUniqueOrThrow({ where: { id: v2Id } })));
  const byKey = new Map(changes.map((c) => [c.key, c]));
  check('the price increase is shown as an increase', byKey.get('priceMonthly')?.direction === 'increase');
  check('extra seats are shown as an increase', byKey.get('maxUsers')?.direction === 'increase');
  check('the new feature is shown as added', byKey.get('feature:featureC')?.direction === 'added');
  check('nothing is reported as removed', !changes.some((c) => c.direction === 'removed'));

  // ── Preview ──────────────────────────────────────────────────────────────
  console.log('\nMigration preview');
  const preview = await planMigrationService.preview({ toVersionId: v2Id, fromVersionId: v1Id });
  check('it counts exactly the businesses on v1', preview.affected === 1, String(preview.affected));
  check('it names the price on both sides',
    preview.from.priceMonthly === 50_000 && preview.to.priceMonthly === 75_000);
  check('a price rise is flagged as unfavourable', preview.unfavourable === true);
  check('and renewal is recommended over immediate', preview.recommendedTiming === 'NEXT_RENEWAL');

  // ── Scenario B — migrate at next renewal ─────────────────────────────────
  console.log('\nScenario B — move existing subscribers at next renewal');
  const scheduled = await planMigrationService.start({
    toVersionId: v2Id, fromVersionId: v1Id, timing: 'NEXT_RENEWAL',
    pricing: 'APPLY_AT_RENEWAL', reason: 'New Growth plan', expectedCount: preview.affected,
    initiatedByEmail: 'admin@example.invalid',
  });
  check('the migration is recorded', scheduled.status === 'COMPLETED' || scheduled.status === 'PARTIAL', scheduled.status);
  const scheduledSub = await db.subscription.findFirstOrThrow({ where: { organizationId: orgA } });
  check('the subscription is scheduled, not moved', scheduledSub.pendingPlanVersionId === v2Id && scheduledSub.planVersionId === v1Id);
  const duringSchedule = await resolveEntitlements(orgA);
  check('and keeps v1 entitlements until renewal',
    duringSchedule.planVersion === 1 && duringSchedule.limits.maxUsers === 5 && !duringSchedule.features.has('featureC'),
    `v${duringSchedule.planVersion} users=${duringSchedule.limits.maxUsers}`);

  const applied = await planMigrationService.applyPendingAtRenewal(scheduledSub.id);
  check('at renewal it becomes v2', applied?.version === 2);
  const afterRenewal = await resolveEntitlements(orgA);
  check('with v2 limits and the new feature',
    afterRenewal.planVersion === 2 && afterRenewal.limits.maxUsers === 10 && afterRenewal.features.has('featureC'),
    `v${afterRenewal.planVersion} users=${afterRenewal.limits.maxUsers}`);

  // ── Scenario C — immediate ───────────────────────────────────────────────
  console.log('\nScenario C — move existing subscribers immediately');
  const orgC = await makeOrgOn(v1Id, 'c');
  const immediate = await planMigrationService.start({
    toVersionId: v2Id, fromVersionId: v1Id, timing: 'IMMEDIATE',
    pricing: 'APPLY_IMMEDIATELY', reason: 'Immediate move', initiatedByEmail: 'admin@example.invalid',
  });
  check('the run completes', immediate.status === 'COMPLETED', immediate.status);
  const nowC = await resolveEntitlements(orgC);
  check('the business is on v2 at once',
    nowC.planVersion === 2 && nowC.limits.maxUsers === 10 && nowC.features.has('featureC'),
    `v${nowC.planVersion}`);

  // ── Safety ───────────────────────────────────────────────────────────────
  console.log('\nSafety');
  const again = await planMigrationService.run(immediate.id);
  const tally = await db.subscriptionHistory.count({ where: { organizationId: orgC, changeType: 'MIGRATED' } });
  check('running it again changes nothing', again.status === 'COMPLETED' && tally === 1, `${tally} migration rows`);

  const mismatch = await planMigrationService.start({
    toVersionId: v2Id, fromVersionId: v1Id, timing: 'IMMEDIATE', pricing: 'APPLY_IMMEDIATELY', expectedCount: 99,
  }).catch((e) => e);
  check('a count that no longer matches is refused', mismatch instanceof Error,
    'a migration ran against a different number than was confirmed');

  const sameVersion = await planMigrationService.preview({ toVersionId: v2Id, fromVersionId: v2Id }).catch((e) => e);
  check('a version cannot be migrated to itself', sameVersion instanceof Error);

  // ── History ──────────────────────────────────────────────────────────────
  console.log('\nSubscription history');
  const history = await planMigrationService.historyFor(orgA);
  check('the business has a timeline', history.length >= 1, `${history.length} rows`);
  const migratedRow = history.find((row) => row.changeType === 'MIGRATED');
  check('the migration is on it', Boolean(migratedRow));
  check('with the version it moved to', migratedRow?.version === 2);
  check('and who asked for it', migratedRow?.initiatedBy === 'admin@example.invalid' || migratedRow?.reason !== null,
    JSON.stringify({ by: migratedRow?.initiatedBy, reason: migratedRow?.reason }));
  const runs = await planMigrationService.migrationsFor(planId);
  check('the plan has a migration history', runs.length === 2, `${runs.length} runs`);

  await cleanup();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

async function cleanup() {
  for (const orgId of orgIds) {
    await db.subscriptionHistory.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
    await db.billingRecord.deleteMany({ where: { subscription: { organizationId: orgId } } }).catch(() => {});
    await db.subscription.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
    await db.organization.delete({ where: { id: orgId } }).catch(() => {});
  }
  if (planId) {
    await db.subscriptionHistory.deleteMany({ where: { planId } }).catch(() => {});
    await db.planMigration.deleteMany({ where: { planId } }).catch(() => {});
    await db.plan.update({ where: { id: planId }, data: { currentVersionId: null } }).catch(() => {});
    await db.planVersion.deleteMany({ where: { planId } }).catch(() => {});
    await db.plan.delete({ where: { id: planId } }).catch((e: Error) => console.log('plan:', e.message.split('\n').pop()));
  }
}

main().catch(async (e) => { console.error(e); await cleanup(); process.exit(1); });
