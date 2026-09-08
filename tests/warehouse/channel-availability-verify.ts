/*
 * Turning a channel off from the platform admin.
 *
 * `available: false` already existed and already stopped a channel being
 * connected — but the business still saw its card, captioned "not available on
 * this platform". That is an odd thing to show somebody: an option they can
 * see, cannot use, and never asked about.
 *
 * TikTok in particular could not be switched off at all, because the admin's
 * editor listed seven channel types and the product supports eight. This pins
 * both: the two lists agree, and a disabled channel actually disappears.
 */
import { readFileSync } from 'node:fs';
import { prismaUnscoped as db } from '../../src/infrastructure/database/prisma';
import { requestContext } from '../../src/shared/context';
import { supportedChannels } from '../../src/infrastructure/channels/registry';
import { setWorkspaceConfigOverride } from '../../src/application/settings/workspace-config';
import { channelsService } from '../../src/application/inbox/channels.service';

let passed = 0, failed = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); }
};
const rejects = async (fn: () => Promise<unknown>, match: RegExp): Promise<boolean> => {
  try { await fn(); return false; } catch (e) { return match.test((e as Error).message); }
};

const stamp = Date.now();
let orgId = '';

const as = <T>(fn: () => Promise<T>): Promise<T> =>
  requestContext.run({ requestId: `av-${stamp}`, organizationId: orgId } as never, fn);

/** Set the admin's channel policy, the way the workspace-config sync does. */
function setPolicy(channels: Record<string, Record<string, unknown>>): void {
  setWorkspaceConfigOverride({ channels } as never);
}

async function main() {
  orgId = (await db.organization.create({
    data: { name: 'Avail Co', slug: `avail-${stamp}`, currency: 'NGN', status: 'ACTIVE', country: 'NG' },
  })).id;

  // ── 1. The admin can reach every channel the product runs ────────────────
  console.log('\nThe admin editor covers every channel the product supports');
  {
    const editor = readFileSync(
      '../../web/vhicasar-admin/vhicasar-admin-frontend/src/components/ChannelPolicySection.tsx',
      'utf8',
    );
    const listed = new Set(
      [...editor.matchAll(/\{\s*id:\s*'([A-Z_]+)'/g)].map((m) => m[1]!),
    );
    const missing = supportedChannels().filter((c) => !listed.has(c));
    check(
      'no supported channel is missing from the admin editor',
      missing.length === 0,
      `${missing.join(', ')} cannot be configured — this is how TikTok slipped through`,
    );
    check('TikTok specifically can be configured', listed.has('TIKTOK'));
  }

  // ── 2. On by default ─────────────────────────────────────────────────────
  console.log('\nWith nothing configured, channels are offered');
  setWorkspaceConfigOverride(null);
  await as(async () => {
    const { supported } = await channelsService.list(orgId);
    check('TikTok is offered', supported.includes('TIKTOK'));
    check('and so is WhatsApp', supported.includes('WHATSAPP'));
  });

  // ── 3. Disabled means gone, not greyed out ───────────────────────────────
  console.log('\nA channel the platform switched off is not shown at all');
  setPolicy({ TIKTOK: { available: false } });
  await as(async () => {
    const { supported, channels, allowances } = await channelsService.list(orgId);
    check('TikTok is not in the supported list', !supported.includes('TIKTOK'));
    check('and has no card to render', !channels.some((c) => c.channelType === 'TIKTOK'));
    check('and no allowance row either', !allowances.some((a) => a.channelType === 'TIKTOK'),
      'a row would put the name back on screen');
    check('every other channel is untouched', supported.includes('WHATSAPP') && supported.includes('EMAIL'));
  });

  // ── 4. And it cannot be connected behind the UI's back ───────────────────
  console.log('\nHiding it is not the only defence');
  await as(async () => {
    check(
      'connecting a disabled channel is refused',
      await rejects(
        () => channelsService.connect(orgId, {
          channelType: 'TIKTOK',
          name: 'Sneaky',
          purpose: 'GENERAL',
          autoReply: false,
          credentials: {
            clientKey: 'k', clientSecret: 's', accessToken: 't', openId: 'o',
          },
        } as never),
        /not available|cannot be connected|limit/i,
      ),
      'the API must refuse it even though the card is gone',
    );
  });

  // ── 5. An existing connection is not hidden out from under them ──────────
  console.log('\nA channel already in use stays visible when it is switched off');
  {
    setWorkspaceConfigOverride(null);
    await db.channelAccount.create({
      data: {
        organizationId: orgId, channelType: 'TIKTOK', name: 'Shop TikTok',
        externalId: `tt-${stamp}`, isActive: true,
      },
    });
    setPolicy({ TIKTOK: { available: false } });
    await as(async () => {
      const { supported, accounts } = await channelsService.list(orgId);
      check('the connected account is still listed',
        accounts.some((a) => a.channelType === 'TIKTOK'));
      check('and its channel stays on screen', supported.includes('TIKTOK'),
        'hiding it would leave a live connection with no way to disconnect it');
    });

    // But no second one can be added.
    await as(async () => {
      const { allowances } = await channelsService.list(orgId);
      const tiktok = allowances.find((a) => a.channelType === 'TIKTOK');
      check('adding another is still blocked', tiktok?.canAddMore === false);
    });
  }

  // ── 6. Turning it back on restores it ────────────────────────────────────
  console.log('\nTurning it back on restores it');
  setPolicy({ TIKTOK: { available: true } });
  await as(async () => {
    const { supported } = await channelsService.list(orgId);
    check('TikTok is offered again', supported.includes('TIKTOK'));
  });

  setWorkspaceConfigOverride(null);
  await cleanup();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

async function cleanup() {
  await db.channelAccount.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.activity.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.auditLog.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.organization.delete({ where: { id: orgId } }).catch(() => {});
}

main().catch(async (e) => { console.error(e); await cleanup(); process.exit(1); });
