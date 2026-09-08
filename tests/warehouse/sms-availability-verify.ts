/*
 * Switching SMS off for a workspace.
 *
 * Turning SMS off in the admin's channel policy did nothing visible: the
 * status endpoint only ever reported whether the *provider* was configured,
 * which is a deployment fact, not a decision about this business. So the menu
 * item stayed, the page loaded, and sending still worked.
 *
 * Three things have to follow from that switch, and the last is the one that
 * matters: the server has to refuse, not merely the UI to hide.
 */
import { prismaUnscoped as db } from '../../src/infrastructure/database/prisma';
import { requestContext } from '../../src/shared/context';
import { setWorkspaceConfigOverride } from '../../src/application/settings/workspace-config';
import { smsSendService } from '../../src/application/sms/sms-send.service';
import { senderIdService } from '../../src/application/sms/sender-id.service';
import { setPricingForTesting } from '../../src/application/billing/sms-wallet.service';
import { setSmsProviderForTesting } from '../../src/infrastructure/sms/registry';
import { MockSmsProvider } from '../../src/infrastructure/sms/mock.provider';
import { authService } from '../../src/application/auth/auth.service';

let passed = 0, failed = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); }
};
const rejects = async (fn: () => Promise<unknown>, match: RegExp): Promise<boolean> => {
  try { await fn(); return false; } catch (e) { return match.test((e as Error).message); }
};

const stamp = Date.now();
let orgId = '', userId = '';
let provider: MockSmsProvider;

const as = <T>(fn: () => Promise<T>): Promise<T> =>
  requestContext.run({ requestId: `av-${stamp}`, organizationId: orgId, userId } as never, fn);

async function main() {
  orgId = (await db.organization.create({
    data: { name: 'Gate Co', slug: `gate-${stamp}`, currency: 'NGN', status: 'ACTIVE', country: 'NG' },
  })).id;
  const role = await db.role.create({ data: { organizationId: orgId, name: 'Owner', isSystem: true } });
  const user = await db.user.create({
    data: {
      email: `gate-${stamp}@t.test`, passwordHash: 'x', firstName: 'Gate', lastName: 'T',
      emailVerifiedAt: new Date(),
    },
  });
  userId = user.id;
  await db.membership.create({
    data: { organizationId: orgId, userId, roleId: role.id, isOwner: true },
  });

  provider = new MockSmsProvider();
  setSmsProviderForTesting(provider);
  setPricingForTesting({
    currency: 'NGN', unitCost: 4,
    channels: {
      SMS: { enabled: true, unitCost: 4 },
      EMAIL: { enabled: true, unitCost: 1 },
      WHATSAPP: { enabled: true, unitCost: 6 },
    },
    lowBalanceThreshold: 500,
    packages: [{ id: 'starter', name: 'Starter', credits: 250, price: 1000 }],
  } as never);

  await as(async () => {
    const s = await senderIdService.request(orgId, { value: 'GATECO' });
    await senderIdService.submit(s.id);
    await senderIdService.decide(s.id, 'APPROVED', {});
  });
  await db.smsWallet.upsert({
    where: { organizationId: orgId },
    create: { organizationId: orgId, balance: 10_000, currency: 'NGN' },
    update: { balance: 10_000 },
  });

  // ── 1. On by default ─────────────────────────────────────────────────────
  console.log('\nWith nothing configured, SMS is offered');
  setWorkspaceConfigOverride(null);
  await as(async () => {
    const sent = await smsSendService.send({
      organizationId: orgId, template: 'Hello',
      recipients: [{ phone: '08030088001' }], route: 'PROMOTIONAL',
    });
    check('a message can be sent', sent.queued === 1);
  });

  const before = await (authService.me(userId) as Promise<{ memberships: { channels?: string[] }[] }>);
  check('and the session lists SMS as available',
    (before.memberships[0]?.channels ?? []).includes('SMS'),
    'this is what the menu reads to decide whether to show it');

  // ── 2. Switched off in admin ─────────────────────────────────────────────
  console.log('\nSwitched off, it disappears and stops working');
  setWorkspaceConfigOverride({ communication: { smsEnabled: false } } as never);

  const after = await (authService.me(userId) as Promise<{ memberships: { channels?: string[] }[] }>);
  check('the session no longer lists it',
    !(after.memberships[0]?.channels ?? []).includes('SMS'),
    'the menu item is driven from this, so it goes with it');
  check('other channels are unaffected',
    (after.memberships[0]?.channels ?? []).includes('WHATSAPP'));

  await as(async () => {
    provider.outbox.length = 0;
    check(
      'and the server refuses to send',
      await rejects(
        () => smsSendService.send({
          organizationId: orgId, template: 'Hello',
          recipients: [{ phone: '08030088002' }], route: 'PROMOTIONAL',
        }),
        /not available on this workspace/i,
      ),
      'hiding a button is a courtesy; the endpoint is what has to say no',
    );
    check('nothing reached the provider', provider.outbox.length === 0);
  });

  // ── 2b. The two switches are not the same switch ─────────────────────────
  console.log('\nStopping new SMS inbox channels does not stop sending');
  setWorkspaceConfigOverride({ channels: { SMS: { available: false } } } as never);
  {
    const session = await (authService.me(userId) as Promise<{ memberships: { channels?: string[] }[] }>);
    check(
      'SMS stays in the menu',
      (session.memberships[0]?.channels ?? []).includes('SMS'),
      'the channel policy governs connecting a number people text in to — not whether the business may send',
    );
  }
  await as(async () => {
    const sent = await smsSendService.send({
      organizationId: orgId, template: 'Still fine',
      recipients: [{ phone: '08030088010' }], route: 'PROMOTIONAL',
    });
    check('and sending still works', sent.queued === 1);
  });
  setWorkspaceConfigOverride(null);

  // ── 2c. The whole module closes, not just sending ────────────────────────
  console.log('\nEvery SMS route is closed, not only the one that sends');
  setWorkspaceConfigOverride({ communication: { smsEnabled: false } } as never);
  {
    // Read from the router itself rather than a list I remember writing, so a
    // route added later cannot quietly stay open.
    const { smsRoutes } = await import('../../src/presentation/http/v1/sms.routes');
    const layers = (smsRoutes as unknown as { stack: { route?: { path: string; methods: Record<string, boolean> } }[] }).stack;
    const paths = layers
      .filter((l) => l.route)
      .map((l) => l.route!.path);
    check('the router has routes to close', paths.length >= 10, String(paths.length));

    // By name, not by position: the first non-route layer is `authenticate`,
    // and picking that instead tested the wrong thing entirely.
    const guard = (layers as unknown as { name?: string; handle?: { name?: string } }[]).find(
      (l) => l.handle?.name === 'requireSmsEnabled',
    );
    check('a router-level guard is installed', Boolean(guard),
      'gating only the send service left history, pricing and settings open');

    // Exercise the guard directly for every path it protects.
    const { isChannelEnabled } = await import('../../src/application/settings/workspace-config');
    check('the switch reads as off', isChannelEnabled('SMS') === false);

    /*
     * The real middleware, executed — not a copy of its rule.
     *
     * Re-implementing the condition here would pass even if the guard were
     * deleted, which is exactly the bug being guarded against.
     */
    const run = (path: string): string | null => {
      let captured: string | null = null;
      const handle = (guard as unknown as { handle: (req: unknown, res: unknown, next: (e?: Error) => void) => void }).handle;
      handle(
        { path, method: 'GET' },
        {},
        (err?: Error) => { captured = err ? err.message : null; },
      );
      return captured;
    };

    const refused: string[] = [];
    const allowed: string[] = [];
    for (const path of new Set(paths)) {
      (run(path) ? refused : allowed).push(path);
    }
    check('every route but /status is refused',
      allowed.length === 1 && refused.length === new Set(paths).size - 1,
      `allowed: ${allowed.join(', ')}`);
    check('and /status stays open so the page can explain itself',
      allowed[0] === '/status');
    check('the refusal says why',
      /not available on this workspace/i.test(run('/send') ?? ''),
      run('/send') ?? 'not refused');
  }
  setWorkspaceConfigOverride(null);

  // ── 3. Back on ───────────────────────────────────────────────────────────
  console.log('\nSwitched back on, it works again');
  setWorkspaceConfigOverride({ communication: { smsEnabled: true } } as never);
  await as(async () => {
    const sent = await smsSendService.send({
      organizationId: orgId, template: 'Hello again',
      recipients: [{ phone: '08030088003' }], route: 'PROMOTIONAL',
    });
    check('sending resumes', sent.queued === 1);
  });
  const restored = await (authService.me(userId) as Promise<{ memberships: { channels?: string[] }[] }>);
  check('and it is back in the session',
    (restored.memberships[0]?.channels ?? []).includes('SMS'));

  setWorkspaceConfigOverride(null);
  setSmsProviderForTesting(null);
  setPricingForTesting(null);
  await cleanup();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

async function cleanup() {
  await db.smsMessage.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.smsSuppression.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.senderId.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.smsWalletTransaction.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.smsWallet.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.membership.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.role.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.auditLog.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.user.deleteMany({ where: { id: userId } }).catch(() => {});
  await db.organization.delete({ where: { id: orgId } }).catch(() => {});
}

main().catch(async (e) => { console.error(e); await cleanup(); process.exit(1); });
