/*
 * The inbox's assignment filters.
 *
 * "Mine" never worked: the web app sent `assigned=mine` while the server's
 * filter accepts `me`, so the request was rejected outright and the list never
 * narrowed. The values are checked here against the schema that validates
 * them, because the two halves agreeing is the whole feature.
 *
 * Then the behaviour itself — "mine" has to mean the signed-in agent, not
 * merely "assigned to somebody", which is the mistake that looks right until
 * two people share an inbox.
 */
import { readFileSync } from 'node:fs';
import { prismaUnscoped as db } from '../../src/infrastructure/database/prisma';
import { requestContext } from '../../src/shared/context';
import { inboxService, listConversationsSchema } from '../../src/application/inbox/inbox.service';

let passed = 0, failed = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); }
};

const stamp = Date.now();
let orgId = '', accountId = '';
let meMembership = '', colleagueMembership = '';
let mineId = '', theirsId = '', openId = '';

const as = <T>(fn: () => Promise<T>): Promise<T> =>
  requestContext.run({ requestId: `f-${stamp}`, organizationId: orgId } as never, fn);

async function main() {
  // ── 1. The values the web app actually sends ─────────────────────────────
  console.log('\nEvery value the inbox sends is one the server accepts');
  {
    const src = readFileSync('../web/src/features/inbox/InboxPage.tsx', 'utf8');
    // Read from the chip list rather than a list typed here, so the check
    // follows the UI if somebody adds a fourth filter.
    const match = /\{\(\[([^\]]+)\] as const\)\.map\(\(f\) => \(/.exec(src);
    check('the filter chips were found', Boolean(match), 'could not parse InboxPage');
    const values = (match?.[1] ?? '')
      .split(',')
      .map((v) => v.trim().replace(/^'|'$/g, ''))
      .filter(Boolean);
    check('there are three of them', values.length === 3, values.join(', '));

    const rejected = values.filter(
      (v) => !listConversationsSchema.safeParse({ assigned: v, limit: '50' }).success,
    );
    check(
      'the server accepts all of them',
      rejected.length === 0,
      `${rejected.join(', ')} would 400 — this is exactly what "Mine" did`,
    );
  }

  // ── 2. The behaviour ─────────────────────────────────────────────────────
  orgId = (await db.organization.create({
    data: { name: 'Filter Co', slug: `filter-${stamp}`, currency: 'NGN', status: 'ACTIVE', country: 'NG' },
  })).id;
  const role = await db.role.create({ data: { organizationId: orgId, name: 'Agent', isSystem: false } });
  const mkMember = async (email: string) => {
    const u = await db.user.create({
      data: { email, passwordHash: 'x', firstName: email.slice(0, 4), lastName: 'T' },
    });
    const m = await db.membership.create({
      data: { organizationId: orgId, userId: u.id, roleId: role.id },
    });
    return m.id;
  };
  meMembership = await mkMember(`me-${stamp}@t.test`);
  colleagueMembership = await mkMember(`them-${stamp}@t.test`);

  accountId = (await db.channelAccount.create({
    data: {
      organizationId: orgId, channelType: 'WHATSAPP', name: 'Support',
      externalId: `wa-${stamp}`, isActive: true,
    },
  })).id;

  const mkConversation = async (name: string, assignedToId: string | null) => {
    const customer = await db.customer.create({
      data: { organizationId: orgId, firstName: name, lastName: 'C' },
    });
    return (await db.conversation.create({
      data: {
        organizationId: orgId, channelAccountId: accountId, customerId: customer.id,
        status: 'OPEN', assignedToId, lastMessageAt: new Date(),
      },
    })).id;
  };
  mineId = await mkConversation('Mine', meMembership);
  theirsId = await mkConversation('Theirs', colleagueMembership);
  openId = await mkConversation('Open', null);

  console.log('\n"Mine" means mine, not "assigned to anybody"');
  await as(async () => {
    const { items: rows } = await inboxService.listConversations(
      { assigned: 'me', limit: 50 } as never,
      meMembership,
    );
    const ids = rows.map((r: { id: string }) => r.id);
    check('it returns the one assigned to me', ids.includes(mineId));
    check("and not my colleague's", !ids.includes(theirsId),
      'the mistake that looks right until two people share an inbox');
    check('nor the unassigned one', !ids.includes(openId));
  });

  console.log('\nThe colleague sees their own, not mine');
  await as(async () => {
    const { items: rows } = await inboxService.listConversations(
      { assigned: 'me', limit: 50 } as never,
      colleagueMembership,
    );
    const ids = rows.map((r: { id: string }) => r.id);
    check('their own is listed', ids.includes(theirsId));
    check('and mine is not', !ids.includes(mineId));
  });

  console.log('\nUnassigned means nobody has picked it up');
  await as(async () => {
    const { items: rows } = await inboxService.listConversations(
      { assigned: 'unassigned', limit: 50 } as never,
      meMembership,
    );
    const ids = rows.map((r: { id: string }) => r.id);
    check('the open one is listed', ids.includes(openId));
    check('and neither assigned one is', !ids.includes(mineId) && !ids.includes(theirsId));
  });

  console.log('\nAll means all');
  await as(async () => {
    const { items: rows } = await inboxService.listConversations(
      { assigned: 'all', limit: 50 } as never,
      meMembership,
    );
    const ids = rows.map((r: { id: string }) => r.id);
    check('every conversation is listed',
      [mineId, theirsId, openId].every((id) => ids.includes(id)));
  });

  console.log('\nAssigning a conversation moves it into "Mine"');
  await as(async () => {
    await inboxService.assign(openId, meMembership);
    const { items: rows } = await inboxService.listConversations(
      { assigned: 'me', limit: 50 } as never,
      meMembership,
    );
    check('it appears straight away',
      rows.map((r: { id: string }) => r.id).includes(openId),
      'this is what the report was about: assign to yourself, filter shows nothing');
  });

  await cleanup();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

async function cleanup() {
  await db.message.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.conversation.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.customerIdentity.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.customer.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.channelAccount.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.activity.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.membership.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.role.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.auditLog.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.user.deleteMany({ where: { email: { contains: `-${stamp}@t.test` } } }).catch(() => {});
  await db.organization.delete({ where: { id: orgId } }).catch(() => {});
}

main().catch(async (e) => { console.error(e); await cleanup(); process.exit(1); });
