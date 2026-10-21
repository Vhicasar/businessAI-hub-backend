import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { env } from '../../shared/config/env';
import { logger } from '../../shared/logger';
import { filesService, isAllowedUploadType } from '../files/files.service';

/**
 * Bringing a product image in from a URL in a spreadsheet.
 *
 * An import file cannot carry an image, so it carries a link to one, and this
 * fetches it. That makes the importer into something that performs HTTP
 * requests to addresses a user supplies, which is a server-side request
 * forgery primitive unless it is fenced in — the spreadsheet could just as
 * easily say `http://169.254.169.254/latest/meta-data/` as it could say
 * `https://cdn.shop.example/mug.jpg`, and the first one would have the server
 * read its own cloud credentials and file them as a picture of a mug.
 *
 * The fence, in order:
 *
 *  - http or https only. No `file:`, no `gopher:`, no `data:`.
 *  - The hostname is resolved first, and every address it resolves to must be
 *    publicly routable. Checking the *name* is useless: a name an attacker
 *    controls can point at 127.0.0.1.
 *  - Redirects are followed by hand, a few hops at most, with the same checks
 *    applied to each hop. A permissive redirect on a public host is otherwise
 *    a way straight back to the private network.
 *  - The response must declare an image type the product catalog accepts, and
 *    is read under a byte cap rather than trusted to be the size it claims.
 */

const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 10_000;

/** Never larger than an interactive upload, and never unbounded. */
function maxBytes(): number {
  return Math.min(env.storage.maxBytes, 15 * 1024 * 1024);
}

/** Addresses no import is allowed to reach. */
function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const parts = address.split('.').map(Number);
    const [a, b] = parts as [number, number, number, number];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a === 192 && b === 0) return true; // 192.0.0.0/24, 192.0.2.0/24
    if (a >= 224) return true; // multicast and reserved
    return false;
  }
  if (family === 6) {
    const value = address.toLowerCase().replace(/^\[|\]$/g, '');
    if (value === '::' || value === '::1') return true;
    if (value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb')) return true; // link-local
    if (value.startsWith('fc') || value.startsWith('fd')) return true; // unique local
    if (value.startsWith('ff')) return true; // multicast
    /*
     * IPv4-mapped addresses are the IPv4 address they carry, and must be
     * judged as one. Both spellings matter: `::ffff:127.0.0.1` is what gets
     * typed, and `::ffff:7f00:1` is what Node's URL parser turns it into — so
     * checking only the dotted form leaves the hex form to be stopped by
     * nothing but a failed connection.
     */
    const dotted = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (dotted) return isPrivateAddress(dotted[1]!);
    const hex = value.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const high = parseInt(hex[1]!, 16);
      const low = parseInt(hex[2]!, 16);
      return isPrivateAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    return false;
  }
  return true;
}

/** A URL that is safe to fetch, or the reason it is not. */
async function assertFetchable(raw: string): Promise<{ ok: true; url: URL } | { ok: false; reason: string }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'Image URL is not a valid web address' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'Image URL must start with http:// or https://' };
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  try {
    const addresses = isIP(host)
      ? [{ address: host }]
      : await lookup(host, { all: true });
    if (addresses.length === 0) return { ok: false, reason: 'Image URL host could not be resolved' };
    if (addresses.some((entry) => isPrivateAddress(entry.address))) {
      return { ok: false, reason: 'Image URL points to a private network address' };
    }
  } catch {
    return { ok: false, reason: 'Image URL host could not be resolved' };
  }
  return { ok: true, url };
}

export interface IngestResult {
  fileId: string | null;
  /** Why no image was attached. Null on success. */
  error: string | null;
}

/**
 * Fetch an image and file it against the organisation.
 *
 * Never throws: a bad image URL is a row-level validation problem for the
 * importer to report next to the row, not a reason to abandon an import of two
 * thousand products.
 */
export async function ingestImageFromUrl(
  rawUrl: string,
  opts: { organizationId: string; uploadedById: string | null; entityId?: string },
): Promise<IngestResult> {
  const trimmed = rawUrl.trim();
  if (!trimmed) return { fileId: null, error: null };
  if (trimmed.length > 2048) return { fileId: null, error: 'Image URL is too long' };

  let target = trimmed;
  let response: Response | null = null;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const checked = await assertFetchable(target);
    if (!checked.ok) return { fileId: null, error: checked.reason };
    try {
      response = await fetch(checked.url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { accept: 'image/*' },
      });
    } catch (err) {
      logger.warn({ err: (err as Error).message, url: checked.url.hostname }, 'Product image URL could not be fetched');
      return { fileId: null, error: 'Image URL could not be reached' };
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return { fileId: null, error: 'Image URL redirected to nowhere' };
      // Each hop is re-checked from the top, including its addresses.
      target = new URL(location, checked.url).toString();
      response = null;
      continue;
    }
    break;
  }

  if (!response) return { fileId: null, error: 'Image URL redirected too many times' };
  if (!response.ok) return { fileId: null, error: `Image URL returned HTTP ${response.status}` };

  const mimeType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (!isAllowedUploadType(mimeType, 'image')) {
    return { fileId: null, error: mimeType ? `Image URL is a "${mimeType}", not a supported image` : 'Image URL did not return an image' };
  }

  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes()) {
    return { fileId: null, error: 'Image is too large' };
  }

  let buffer: Buffer;
  try {
    const bytes = await response.arrayBuffer();
    // Checked again on what actually arrived — content-length is a claim.
    if (bytes.byteLength > maxBytes()) return { fileId: null, error: 'Image is too large' };
    if (bytes.byteLength === 0) return { fileId: null, error: 'Image URL returned an empty file' };
    buffer = Buffer.from(bytes);
  } catch {
    return { fileId: null, error: 'Image could not be downloaded' };
  }

  try {
    const name = decodeURIComponent(new URL(target).pathname.split('/').pop() || 'product-image')
      .replace(/[^\w.\- ]+/g, '')
      .slice(0, 120) || 'product-image';
    const stored = await filesService.upload(
      { buffer, mimetype: mimeType, originalname: name, size: buffer.length },
      {
        organizationId: opts.organizationId,
        uploadedById: opts.uploadedById,
        entity: 'products',
        entityType: 'PRODUCT',
        entityId: opts.entityId,
        isPublic: true,
        allow: 'image',
      },
    );
    return { fileId: stored.id, error: null };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Product image from URL could not be stored');
    return { fileId: null, error: 'Image could not be saved' };
  }
}
