/*
 * The assistant's map of the product, checked against the product.
 *
 * The workspace assistant may only name a page that appears in
 * WORKSPACE_DESTINATIONS — model-written URLs are deliberately never trusted
 * as navigation. The cost of that safety is that a page missing from the
 * registry is a page the assistant will tell the business does not exist.
 *
 * That is not hypothetical. Asked "how do I create my website?", the assistant
 * answered: "I don't see a separate website-builder page available in your
 * workspace right now", and sent the business to channel settings instead —
 * because the website builder had been paused, removed from the sidebar, and
 * never put back in this registry when it returned.
 *
 * So: everything in the sidebar must be something the assistant can name.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WORKSPACE_DESTINATIONS } from '../../src/application/ai/workspace-navigation.registry';

let passed = 0, failed = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); }
};

const nav = readFileSync(join(__dirname, '../../../web/src/layouts/navItems.ts'), 'utf8');

/** Sidebar entries that are actually rendered — a commented-out one is not. */
function sidebarEntries(): { label: string; path: string }[] {
  const entries: { label: string; path: string }[] = [];
  for (const match of nav.matchAll(/\{\s*label:\s*'([^']+)'[^}]*?path:\s*'([^']+)'/g)) {
    const lineStart = nav.lastIndexOf('\n', match.index!) + 1;
    if (nav.slice(lineStart, match.index!).trimStart().startsWith('//')) continue;
    entries.push({ label: match[1]!, path: match[2]! });
  }
  return entries;
}

async function main() {
  const entries = sidebarEntries();
  const known = new Set(WORKSPACE_DESTINATIONS.map((item) => item.path));

  console.log('\nThe assistant can name every page in the sidebar');
  check('the sidebar was parsed at all', entries.length > 10, `found ${entries.length}`);

  const unknown = entries.filter((entry) => !known.has(entry.path));
  check('no sidebar page is missing from the assistant registry',
    unknown.length === 0,
    unknown.map((entry) => `${entry.label} (${entry.path})`).join(', '));

  console.log('\nAnd names nothing the product does not have');
  const router = readFileSync(join(__dirname, '../../../web/src/app/router.tsx'), 'utf8');
  const livePaths = new Set<string>();
  for (const match of router.matchAll(/path:\s*'([^']*)'/g)) {
    const lineStart = router.lastIndexOf('\n', match.index!) + 1;
    if (router.slice(lineStart, match.index!).trimStart().startsWith('//')) continue;
    livePaths.add(match[1]!.startsWith('/') ? match[1]! : `/${match[1]!}`);
  }
  // Only the top-level destinations can be checked this way: settings screens
  // are nested children whose router paths are written relative to /settings.
  const topLevel = WORKSPACE_DESTINATIONS.filter((item) => item.path !== '/' && !item.path.startsWith('/settings'));
  const phantom = topLevel.filter((item) => {
    const first = `/${item.path.split('/')[1]}`;
    return !livePaths.has(item.path) && !livePaths.has(first);
  });
  check('every destination points at a route that exists',
    phantom.length === 0,
    phantom.map((item) => `${item.label} (${item.path})`).join(', '));

  console.log('\nThe website builder in particular');
  const website = WORKSPACE_DESTINATIONS.find((item) => item.path === '/website');
  check('is in the registry', Boolean(website));
  check('is gated the same way the route is', website?.permissions?.includes('marketing.read') === true);
  check('covers the editor it opens into', website?.pathPatterns?.includes('/website/:siteId') === true);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
