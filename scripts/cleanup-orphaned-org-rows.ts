import { Prisma } from '@prisma/client';
import { prismaUnscoped as db } from '../src/infrastructure/database/prisma';

/**
 * Rows left behind by the old permanent-delete.
 *
 * Deleting an organisation used to remove the organisation row and nothing
 * else, so everything it owned — products, invoices, customers, audit trails —
 * stayed in the database pointing at an organisation that no longer existed.
 * `deleteOrganizationCompletely` fixes that going forward; this clears what the
 * old behaviour already left.
 *
 * Every row it touches belongs to an organisation that does not exist. Nothing
 * can reach them and no workspace can show them.
 *
 *   npx tsx scripts/cleanup-orphaned-org-rows.ts          # count only
 *   npx tsx scripts/cleanup-orphaned-org-rows.ts purge    # actually remove
 */
const MODELS = Prisma.dmmf.datamodel.models
  .filter((m) => m.fields.some((f) => f.name === 'organizationId'))
  .map((m) => m.name)
  .filter((n) => n !== 'Organization')
  .sort();

const key = (m: string) => m.charAt(0).toLowerCase() + m.slice(1);

async function main() {
  const purge = process.argv[2] === 'purge';
  const live = new Set((await db.organization.findMany({ select: { id: true } })).map((o) => o.id));

  const deadOrgIds = new Set<string>();
  const counts: Record<string, number> = {};
  for (const model of MODELS) {
    const d = (db as unknown as Record<string, { findMany?: (a: unknown) => Promise<{ organizationId: string }[]> }>)[key(model)];
    if (!d?.findMany) continue;
    const rows = await d.findMany({ select: { organizationId: true } }).catch(() => []);
    const orphans = rows.filter((r) => r.organizationId && !live.has(r.organizationId));
    if (orphans.length) {
      counts[model] = orphans.length;
      for (const o of orphans) deadOrgIds.add(o.organizationId);
    }
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`${total} orphaned row(s) across ${Object.keys(counts).length} table(s), from ${deadOrgIds.size} organisation(s) that no longer exist`);
  for (const [m, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(6)}  ${m}`);
  }
  if (!purge) { console.log('\nCounting only. Re-run with "purge" to remove them.'); process.exit(0); }
  if (total === 0) process.exit(0);

  const removed: Record<string, number> = {};
  const stuck: Record<string, string> = {};
  let pending = Object.keys(counts);
  for (let pass = 0; pass < 12 && pending.length; pass += 1) {
    const next: string[] = [];
    let progressed = false;
    for (const model of pending) {
      const d = (db as unknown as Record<string, { deleteMany?: (a: unknown) => Promise<{ count: number }> }>)[key(model)];
      if (!d?.deleteMany) continue;
      try {
        const { count } = await d.deleteMany({ where: { organizationId: { in: [...deadOrgIds] } } });
        removed[model] = (removed[model] ?? 0) + count;
        if (count > 0) progressed = true;
        delete stuck[model];
      } catch (err) {
        stuck[model] = (err as Error).message.split('\n')[0]!.slice(0, 120);
        next.push(model);
      }
    }
    pending = next;
    if (!progressed) break;
  }

  console.log(`\nremoved ${Object.values(removed).reduce((a, b) => a + b, 0)} row(s)`);
  if (Object.keys(stuck).length) console.log('still blocked:', JSON.stringify(stuck, null, 1));
  process.exit(0);
}
main();
