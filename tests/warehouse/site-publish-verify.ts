/**
 * Website builder, end to end: create → edit → publish → serve.
 *
 * Runs against the live dev database with a throwaway organization, and never
 * touches an existing deployment configuration — if the platform already has
 * one active, this reads it rather than switching it.
 */
import { execSync } from 'node:child_process';
import { prismaUnscoped as db } from '../../src/infrastructure/database/prisma';
import { requestContext } from '../../src/shared/context';
import { siteBuilderService } from '../../src/application/sites/site-builder.service';
import { sitePublicService } from '../../src/application/sites/site-public.service';
import { domainConfigService } from '../../src/application/sites/domain-config.service';

let passed = 0, failed = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); }
};

const stamp = Date.now();
const sub = `e2e${stamp}`.slice(0, 20);
let orgId = '', userId = '', siteId = '', createdConfigId = '';

const asOrg = <T>(fn: () => Promise<T>) =>
  requestContext.run({ requestId: `e2e-${stamp}`, organizationId: orgId, userId }, fn);

async function main() {
  const org = await db.organization.create({
    data: { name: `Site E2E ${stamp}`, slug: `site-e2e-${stamp}`, currency: 'NGN', status: 'ACTIVE', country: 'NG' },
  });
  orgId = org.id;
  const user = await db.user.create({
    data: { email: `site-e2e-${stamp}@example.invalid`, firstName: 'Site', lastName: 'Tester', passwordHash: 'x' },
  });
  userId = user.id;

  // ── 1. Platform hosting configuration ───────────────────────────────────
  console.log('\nPlatform hosting configuration');
  let config = await domainConfigService.active();
  if (!config) {
    config = await domainConfigService.create({
      name: 'E2E Hostinger', provider: 'HOSTINGER',
      baseDomain: `e2e-${stamp}.example`, cnameTarget: `sites.e2e-${stamp}.example`,
      verificationTarget: null,
    });
    createdConfigId = config.id;
    await domainConfigService.activate(config.id);
    config = await domainConfigService.active();
    console.log('    (none existed; created a throwaway one)');
  } else {
    console.log(`    (using the configuration already active: ${config.baseDomain})`);
  }
  check('an active deployment configuration is resolvable', Boolean(config?.baseDomain));
  check('it names a CNAME target for customer domains', Boolean(config?.cnameTarget));

  // ── 2. Create a website ─────────────────────────────────────────────────
  console.log('\nCreating a website');
  const site = await asOrg(() => siteBuilderService.create({ name: 'E2E Shop' } as never));
  siteId = (site as { id: string }).id;
  const loaded = await asOrg(() => siteBuilderService.get(siteId));
  const pages = (loaded as { pages: { slug: string; isHome: boolean }[] }).pages;
  check('a new site starts with a homepage', pages.some((p) => p.isHome));
  check('the homepage lives at the root slug', pages.some((p) => p.isHome && p.slug === ''));

  // ── 3. Publishing is gated ──────────────────────────────────────────────
  console.log('\nPublishing gates');
  const reserved = await asOrg(() => siteBuilderService.publish(siteId, 'www')).catch((e) => e);
  check('a reserved subdomain is refused', reserved instanceof Error, 'www was accepted');
  /*
   * The renderer is mounted after every application route, so a tenant on the
   * platform's own hostname would answer for whatever those routes miss.
   */
  for (const name of ['api', 'businesshub', 'webmail', 'cdn']) {
    const taken = await asOrg(() => siteBuilderService.publish(siteId, name)).catch((e) => e);
    check(`a tenant cannot take "${name}"`, taken instanceof Error, `${name} was accepted`);
    const offered = await asOrg(() => siteBuilderService.subdomainAvailable(siteId, name));
    check(`and it is not offered as available`, (offered as { available: boolean }).available === false);
  }
  const noAddOn = await asOrg(() => siteBuilderService.publish(siteId, sub)).catch((e) => e);
  check('publishing without the add-on is refused with 402',
    (noAddOn as { statusCode?: number }).statusCode === 402,
    `got ${(noAddOn as { statusCode?: number; message?: string }).statusCode} ${(noAddOn as { message?: string }).message ?? ''}`);

  await db.addOnPurchase.create({ data: {
    organizationId: orgId, addOnId: 'website_subdomain', title: 'Website Subdomain',
    billingType: 'MONTHLY', amount: 0, currency: 'NGN', entitlements: {},
  } });

  // ── 4. Publish ──────────────────────────────────────────────────────────
  console.log('\nPublishing');
  const published = await asOrg(() => siteBuilderService.publish(siteId, sub));
  check('the site reports itself published', (published as { status: string }).status === 'PUBLISHED');
  const row = await db.site.findUniqueOrThrow({ where: { id: siteId } });
  check('a live snapshot was frozen', row.publishedSnapshot !== null);
  check('the subdomain was claimed', row.subdomain === sub);
  const versions = await db.siteVersion.count({ where: { siteId, isPublished: true } });
  check('the release was recorded as a version', versions === 1);

  // ── 5. Serve it ─────────────────────────────────────────────────────────
  console.log('\nServing the published site');
  const html = await sitePublicService.resolve(sub, '', 'subdomain');
  check('the homepage renders HTML', Boolean(html && html.includes('<!doctype html')), `got ${html ? `${html.length} chars` : 'nothing'}`);
  check('the rendered page carries the site name', Boolean(html?.includes('E2E Shop')));
  const missing = await sitePublicService.resolve(sub, 'no-such-page', 'subdomain');
  check('an unknown path renders nothing rather than the homepage', !missing);

  // ── 5b. Over real HTTP, through the host router ──────────────────────────
  console.log('\nServing over HTTP (localhost:4999)');
  const base = 'http://127.0.0.1:4999';
  const byPath = await fetch(`${base}/site/${sub}/`).catch(() => null);
  if (!byPath) {
    console.log('    (test server not reachable; skipped)');
  } else {
    const body = await byPath.text();
    check('GET /site/<subdomain>/ returns the page', byPath.status === 200, `status ${byPath.status}`);
    check('it is the published site, not the app shell', body.includes('E2E Shop'));
    check('a Content-Security-Policy is set on website responses',
      Boolean(byPath.headers.get('content-security-policy')));
    const robots = await fetch(`${base}/site/${sub}/robots.txt`);
    check('robots.txt is served and points at the sitemap',
      robots.status === 200 && (await robots.text()).includes('Sitemap:'));
    const sitemap = await fetch(`${base}/site/${sub}/sitemap.xml`);
    check('sitemap.xml lists the pages', sitemap.status === 200 && (await sitemap.text()).includes('<urlset'));
    /*
     * curl, not fetch: undici treats Host as a forbidden header and drops it,
     * so a fetch here silently tests 127.0.0.1 instead of the virtual host.
     */
    const viaHost = execSync(
      `curl -s -m 10 -o /dev/null -w '%{http_code}' -H 'Host: ${sub}.${config?.baseDomain}' ${base}/`,
      { encoding: 'utf8' },
    ).trim();
    check('the host router answers for <subdomain>.<baseDomain>', viaHost === '200', `status ${viaHost}`);
    const hostBody = execSync(
      `curl -s -m 10 -H 'Host: ${sub}.${config?.baseDomain}' ${base}/`,
      { encoding: 'utf8' },
    );
    check('and serves that site, by host alone', hostBody.includes('E2E Shop'));
  }

  // ── 6. Draft edits must not touch what is live ──────────────────────────
  console.log('\nDraft isolation');
  const home = pages.find((p) => p.isHome) as { id: string };
  await asOrg(() => siteBuilderService.updatePage(siteId, home.id, { title: 'Draft Only Title' } as never));
  const liveAgain = await sitePublicService.resolve(sub, '', 'subdomain');
  check('an unpublished edit does not reach the live site', !liveAgain?.includes('Draft Only Title'));

  // ── 7. Custom domain instructions ───────────────────────────────────────
  console.log('\nCustom domain');
  const connected = await asOrg(() => siteBuilderService.connectDomain(siteId, 'www.e2e-example.invalid'));
  const dns = (connected as { dns: { cname: { host: string; value: string }; txt: { host: string; value: string } } }).dns;
  console.log(`    CNAME ${dns.cname.host} → ${dns.cname.value}`);
  console.log(`    TXT   ${dns.txt.host} → ${dns.txt.value.slice(0, 12)}…`);
  check('a CNAME record is specified', Boolean(dns.cname.host && dns.cname.value));
  check('a TXT verification record is specified', dns.txt.host.startsWith('_vhicasar.'));
  check('the CNAME target matches the configured deployment target',
    dns.cname.value === config?.cnameTarget,
    `told the customer "${dns.cname.value}" but the active configuration says "${config?.cnameTarget}"`);
  const verified = await asOrg(() => siteBuilderService.verifyDomain(siteId));
  check('an unproved domain stays unverified', (verified as { verified: boolean }).verified === false);
  const custom = await sitePublicService.resolve('www.e2e-example.invalid', '', 'custom');
  check('an unverified custom domain serves nothing', !custom);

  // ── 8. Unpublish ────────────────────────────────────────────────────────
  console.log('\nUnpublishing');
  await asOrg(() => siteBuilderService.unpublish(siteId));
  const afterUnpublish = await sitePublicService.resolve(sub, '', 'subdomain');
  check('an unpublished site stops serving', !afterUnpublish);

  await cleanup();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

async function cleanup() {
  await db.siteEvent.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.siteVersion.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.sitePage.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.site.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.addOnPurchase.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.lead.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.activity.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.auditLog.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  if (createdConfigId) {
    await db.domainDeploymentConfig.delete({ where: { id: createdConfigId } }).catch(() => {});
  }
  await db.organization.delete({ where: { id: orgId } }).catch(() => {});
  await db.user.delete({ where: { id: userId } }).catch(() => {});
}

main().catch(async (e) => { console.error(e); await cleanup(); process.exit(1); });
