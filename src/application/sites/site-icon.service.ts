import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveEntitlements } from '../billing/entitlements';
import { getProductBranding } from '../catalog/site-catalog.service';
import { logger } from '../../shared/logger';

/**
 * The icon a published website shows in the browser tab.
 *
 * Published sites carried no icon at all, so every customer website showed the
 * browser's blank page glyph — the one thing on a tab that says whether a site
 * is a real business or a parked domain.
 *
 * Who gets whose mark is an entitlement question, and it is answered here,
 * server-side, at render time:
 *
 *  - A business with the white-label entitlement shows its own logo.
 *  - Everyone else shows the Vhicasar mark.
 *
 * Deliberately *not* read from the published snapshot or from anything the
 * site editor can set. The snapshot is written by the business, so a branding
 * decision taken from it would be a branding decision the business makes —
 * which is exactly what the entitlement is there to prevent. Resolving at
 * render time also means an existing published site picks its icon up without
 * being republished, and loses it the moment the entitlement lapses.
 */

/** Resolved per organisation and held briefly — this runs on every page view. */
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { href: string; whiteLabel: boolean; expiresAt: number }>();

/** The bundled mark, read from disk once and inlined so the tab needs no request. */
let bundledIcon: string | null = null;

async function bundledIconHref(): Promise<string> {
  if (bundledIcon) return bundledIcon;
  try {
    const file = await readFile(path.join(process.cwd(), 'public', 'brand-icon.png'));
    bundledIcon = `data:image/png;base64,${file.toString('base64')}`;
  } catch (err) {
    // A missing asset must not cost the page its icon, let alone the page.
    logger.warn({ err: (err as Error).message }, 'Bundled brand icon unavailable — using a drawn mark');
    bundledIcon = letterMark('V', '#F97316');
  }
  return bundledIcon;
}

/**
 * The platform's own mark, as the administrator has configured it.
 *
 * The admin owns product branding — the dashboard's own tab icon already
 * follows it — so a customer website showing a hard-coded file would drift
 * from the platform the moment someone uploaded a new logo. The admin's logo
 * is used by URL rather than inlined: it is already a public asset, the
 * browser caches it across every page of every site, and it means a change in
 * the admin reaches live websites without a deployment.
 *
 * The bundled file is the fallback for an admin that has configured no logo,
 * or is unreachable.
 */
async function platformIconHref(): Promise<string> {
  try {
    const branding = await getProductBranding();
    const logo = branding.logoUrl?.trim();
    if (logo && /^https?:\/\//i.test(logo)) return logo;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Admin branding unavailable for site icon — using the bundled mark');
  }
  return bundledIconHref();
}

/**
 * A letter mark, for a white-label business that has not uploaded a logo.
 *
 * The alternative would be falling back to the Vhicasar mark, which would put
 * platform branding on the one kind of site that has paid for it not to be
 * there. An initial on the site's own colour is nobody else's branding, and it
 * is never a broken image.
 */
export function letterMark(initial: string, color: string): string {
  const letter = (initial || 'W').slice(0, 1).toUpperCase();
  const fill = /^#[0-9a-f]{3,8}$/i.test(color) ? color : '#F97316';
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
    + `<rect width="32" height="32" rx="8" fill="${fill}"/>`
    + '<text x="16" y="22" text-anchor="middle" font-family="system-ui,sans-serif" '
    + `font-size="18" font-weight="700" fill="#ffffff">${escapeXml(letter)}</text>`
    + '</svg>';
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!
  ));
}

export interface SiteIconInput {
  organizationId: string;
  /** The business's uploaded logo, already resolved to a URL. */
  logoUrl: string | null;
  /** The business's name, for the letter mark. */
  name: string | null;
  /** The site's primary colour, so a letter mark looks like the site it sits on. */
  themeColor: string;
}

/**
 * The icon href for one site, and which branding it represents.
 *
 * `whiteLabel` is returned alongside so a caller can tell the two apart
 * without repeating the entitlement lookup.
 */
export async function resolveSiteIcon(
  input: SiteIconInput,
): Promise<{ href: string; whiteLabel: boolean }> {
  const cached = cache.get(input.organizationId);
  if (cached && cached.expiresAt > Date.now()) {
    return { href: cached.href, whiteLabel: cached.whiteLabel };
  }

  let whiteLabel = false;
  try {
    const entitlements = await resolveEntitlements(input.organizationId);
    whiteLabel = entitlements.features.has('white_label');
  } catch (err) {
    /*
     * Fail to the platform mark, never to no mark.
     *
     * An entitlement lookup that fails is not evidence of a white-label
     * entitlement, and treating it as one would hand out the thing the
     * entitlement exists to sell.
     */
    logger.warn(
      { err: (err as Error).message, organizationId: input.organizationId },
      'Could not resolve white-label entitlement for site icon — using platform branding',
    );
  }

  const href = whiteLabel
    ? (input.logoUrl ?? letterMark(input.name?.trim().slice(0, 1) ?? 'W', input.themeColor))
    : await platformIconHref();

  cache.set(input.organizationId, { href, whiteLabel, expiresAt: Date.now() + CACHE_TTL_MS });
  return { href, whiteLabel };
}

/** Drop a cached decision — used by tests and after an entitlement change. */
export function clearSiteIconCache(organizationId?: string): void {
  if (organizationId) cache.delete(organizationId);
  else cache.clear();
}
