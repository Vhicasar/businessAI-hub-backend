/*
 * "Build with AI", end to end, against a stub that answers the way a model
 * actually answers — volunteering keys the schema never asked for, forgetting
 * an id, nesting content. Exactly the output that used to be discarded whole
 * and reported as "The AI did not return a valid editable website".
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { prismaUnscoped as db } from '../../src/infrastructure/database/prisma';
import { requestContext } from '../../src/shared/context';
import { siteBuilderService } from '../../src/application/sites/site-builder.service';
import { encrypt } from '../../src/shared/crypto';

let passed = 0, failed = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); }
};
const stamp = Date.now();
const PORT = 4988;
let orgId = '', userId = '';

const MODEL_REPLY = JSON.stringify({
  theme: { mode: 'light' },
  pages: [
    {
      title: 'Home', slug: '',
      sections: [
        // volunteers a key the schema never asked for
        { id: 'sec_a', type: 'hero', variant: 'default', hidden: false, props: { headline: 'Fresh bread' }, responsive: {}, animation: 'none', title: 'Hero band' },
        // forgets the id entirely
        { type: 'features', props: { items: ['Daily bakes'] } },
        // nests content the obvious way instead of under props
        { id: 'sec_c', type: 'about', content: { body: 'We bake at dawn.' } },
        // a type that does not exist — genuinely unusable
        { id: 'sec_d', type: 'navbar', props: {} },
      ],
    },
    { title: 'Contact', slug: 'contact', sections: [{ id: 'sec_e', type: 'contact', props: {} }] },
  ],
});

/**
 * Is "Build with AI" switched on?
 *
 * Read from the schema rather than a flag here, so this guard turns itself
 * back on the moment the feature is restored and cannot be left asserting
 * against a path the product no longer offers. Skipping loudly beats passing
 * quietly: calling the service directly bypasses validation, so a paused
 * build still "succeeds" and reports numbers that mean nothing.
 */
function aiBuildEnabled(): boolean {
  const service = readFileSync(
    '/Users/mac/Desktop/Development/businesshub-ai/backend/src/application/sites/site-builder.service.ts',
    'utf8',
  );
  return /mode: z\.enum\(\['BLANK', 'TEMPLATE', 'AI'\]\)/.test(service);
}

async function main() {
  if (!aiBuildEnabled()) {
    console.log('\n  — "Build with AI" is paused; this guard is skipped until it returns.');
    console.log('\n0 passed, 0 failed (skipped)');
    process.exit(0);
  }
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        choices: [{ message: { content: MODEL_REPLY } }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', resolve));

  orgId = (await db.organization.create({ data: { name: `AI Build ${stamp}`, slug: `ai-build-${stamp}`, currency: 'NGN', status: 'ACTIVE', country: 'NG',
    settings: { aiProvider: { provider: 'custom', model: 'stub-model', apiKeyEnc: encrypt('sk-stub'), baseUrl: `http://127.0.0.1:${PORT}/v1`, enabled: true } } } })).id;
  userId = (await db.user.create({ data: { email: `ai-build-${stamp}@example.invalid`, firstName: 'AI', lastName: 'Build', passwordHash: 'x' } })).id;

  /*
   * Building with AI is a paid-plan capability, so the refusal comes first:
   * this workspace has no subscription, and the generator must not run.
   */
  console.log('\nBuilding a website with AI');
  const refused = await requestContext.run({ requestId: `aib-${stamp}`, organizationId: orgId, userId }, () =>
    siteBuilderService.create({ name: 'Free Plan Bakery', mode: 'AI', prompt: 'A small bakery in Lagos with a contact page' } as never),
  ).catch((e) => e);
  check('a free plan is asked to upgrade',
    refused instanceof Error && (refused as { code?: string }).code === 'PLAN_UPGRADE_REQUIRED',
    refused instanceof Error ? refused.message : 'it built anyway');

  // Put it on a paid plan; everything below is about the generator itself.
  const paidPlan = await db.plan.findFirst({ where: { slug: 'growth' }, select: { id: true } });
  if (paidPlan) {
    const now = new Date();
    await db.subscription.create({
      data: {
        organizationId: orgId, planId: paidPlan.id, status: 'ACTIVE', interval: 'MONTHLY',
        currentPeriodStart: now, currentPeriodEnd: new Date(now.getTime() + 30 * 86_400_000),
      },
    });
  }

  const site = await requestContext.run({ requestId: `aib-${stamp}`, organizationId: orgId, userId }, () =>
    siteBuilderService.create({ name: 'Stub Bakery', mode: 'AI', prompt: 'A small bakery in Lagos with a contact page' } as never),
  ).catch((e) => e);

  if (site instanceof Error) {
    check('the build succeeds', false, `${(site as { code?: string }).code}: ${site.message}`);
  } else {
    check('the build succeeds', true);
    const loaded = await requestContext.run({ requestId: `aib2-${stamp}`, organizationId: orgId, userId }, () =>
      siteBuilderService.get((site as { id: string }).id));
    const pages = (loaded as { pages: { title: string; slug: string; blocks: unknown[] }[] }).pages;
    console.log(`     pages: ${pages.map((p) => `${p.title}(${p.blocks.length} sections)`).join(', ')}`);
    check('both pages survived', pages.length === 2, `${pages.length} page(s)`);
    const home = pages.find((p) => p.slug === '')!;
    check('the section with a volunteered key was kept', home.blocks.length >= 1);
    check('the section with no id was kept', home.blocks.length >= 2);
    check('the section with nested content was kept', home.blocks.length >= 3, `${home.blocks.length} kept of 4`);
    check('the unusable section type was the only one dropped', home.blocks.length === 3, `${home.blocks.length} kept`);
    const blocks = home.blocks as { id: string; type: string; props: Record<string, unknown> }[];
    check('every kept section has an id', blocks.every((b) => typeof b.id === 'string' && b.id.length > 0));
    check("the volunteered key's content was preserved, not thrown away",
      blocks.some((b) => JSON.stringify(b.props).includes('Hero band')));
    check('the nested content was preserved too',
      blocks.some((b) => JSON.stringify(b.props).includes('We bake at dawn')));
  }

  server.close();
  await cleanup();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

async function cleanup() {
  for (const t of ['siteEvent','siteVersion','sitePage','site','usageCounter','aiUsage','activity','auditLog'] as const) {
    await (db as any)[t]?.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  }
  await db.organization.delete({ where: { id: orgId } }).catch(() => {});
  await db.user.delete({ where: { id: userId } }).catch(() => {});
}

main().catch(async (e) => { console.error(e); await cleanup(); process.exit(1); });
