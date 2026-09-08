/*
 * Sender IDs, and what they are for.
 *
 * A network will not carry marketing SMS from an arbitrary string, so each
 * business registers a name and waits on somebody else's approval queue. Two
 * things have to hold or the whole feature is theatre: nothing sends under an
 * unapproved name, and one business can never send under another's.
 *
 * Also covers the billing fix — quoting a send by segments rather than by
 * recipient count.
 */
import { prismaUnscoped as db } from '../../src/infrastructure/database/prisma';
import { requestContext } from '../../src/shared/context';
import { senderIdService, senderIdSchema } from '../../src/application/sms/sender-id.service';
import { smsWalletService } from '../../src/application/billing/sms-wallet.service';

let passed = 0, failed = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); }
};
const rejects = async (fn: () => Promise<unknown>, match: RegExp): Promise<boolean> => {
  try { await fn(); return false; } catch (e) { return match.test((e as Error).message); }
};

const stamp = Date.now();
let orgA = '', orgB = '', senderA = '';

const as = (org: string) => <T>(fn: () => Promise<T>): Promise<T> =>
  requestContext.run({ requestId: `s-${stamp}`, organizationId: org } as never, fn);

async function main() {
  const mkOrg = async (name: string) => (await db.organization.create({
    data: { name, slug: `${name}-${stamp}`, currency: 'NGN', status: 'ACTIVE', country: 'NG' },
  })).id;
  orgA = await mkOrg('pharma');
  orgB = await mkOrg('rival');

  // ── 1. What the network will accept ──────────────────────────────────────
  console.log('\nA Sender ID has to be something a network will carry');
  {
    check('a normal one passes', senderIdSchema.safeParse({ value: 'ABCPHARM' }).success);
    check('11 characters is the limit', senderIdSchema.safeParse({ value: 'ABCDEFGHIJK' }).success);
    check('12 is refused', !senderIdSchema.safeParse({ value: 'ABCDEFGHIJKL' }).success,
      'GSM caps alphanumeric sender IDs at 11');
    check('too short is refused', !senderIdSchema.safeParse({ value: 'AB' }).success);
    check('punctuation is refused', !senderIdSchema.safeParse({ value: 'ABC!PHARM' }).success);
    // Trimmed rather than rejected: a value pasted with a stray space either
    // side is what the business meant, and refusing it teaches nothing.
    check('surrounding whitespace is trimmed away',
      senderIdSchema.safeParse({ value: '  ABCPHARM  ' }).success &&
        senderIdSchema.parse({ value: '  ABCPHARM  ' }).value === 'ABCPHARM');
    check('spaces inside are fine', senderIdSchema.safeParse({ value: 'ABC PHARM' }).success);
  }

  // ── 2. The lifecycle ─────────────────────────────────────────────────────
  console.log('\nA request travels Draft → Pending → Approved');
  await as(orgA)(async () => {
    const created = await senderIdService.request(orgA, { value: 'ABCPHARM', useCase: 'Order alerts' });
    senderA = created.id;
    check('it starts as a draft', created.status === 'DRAFT',
      'nothing is with the network until the business submits it');

    const submitted = await senderIdService.submit(senderA);
    check('submitting makes it pending', submitted.status === 'PENDING');
    check('and records when', submitted.submittedAt !== null);

    check('it cannot be submitted twice',
      await rejects(() => senderIdService.submit(senderA), /cannot be submitted again/i));
  });

  // ── 3. Nothing sends under an unapproved name ────────────────────────────
  console.log('\nNothing sends under a name the network has not approved');
  await as(orgA)(async () => {
    check('a pending Sender ID is refused',
      await rejects(() => senderIdService.requireApproved(orgA, senderA), /waiting for network approval/i));

    await senderIdService.decide(senderA, 'APPROVED', { note: 'Looks fine' });
    const ok = await senderIdService.requireApproved(orgA, senderA);
    check('once approved it can be used', ok.value === 'ABCPHARM');

    await senderIdService.decide(senderA, 'SUSPENDED', { note: 'Complaint received' });
    check('a suspended one stops working again',
      await rejects(() => senderIdService.requireApproved(orgA, senderA), /suspended/i),
      'approval can be withdrawn after the fact');
    await senderIdService.decide(senderA, 'APPROVED', {});
  });

  // ── 4. One business cannot use another's ─────────────────────────────────
  console.log("\nOne business can never send under another's name");
  await as(orgB)(async () => {
    check(
      "the rival cannot use ABCPHARM by id",
      await rejects(() => senderIdService.requireApproved(orgB, senderA), /does not exist/i),
      'impersonation is exactly what registration exists to prevent',
    );
    check(
      'and has none of its own to fall back on',
      await rejects(() => senderIdService.requireApproved(orgB), /No approved Sender ID/i),
    );
    const mine = await senderIdService.list();
    check("it cannot even see the other business's", mine.length === 0);
  });

  // ── 5. Duplicates ────────────────────────────────────────────────────────
  console.log('\nThe same name is not requested twice');
  await as(orgA)(async () => {
    check('an exact repeat is refused',
      await rejects(() => senderIdService.request(orgA, { value: 'ABCPHARM' }), /already requested/i));
    check('and so is a different casing',
      await rejects(() => senderIdService.request(orgA, { value: 'abcpharm' }), /already requested/i),
      'networks treat them as one name');
  });

  // ── 6. The admin queue ───────────────────────────────────────────────────
  console.log('\nThe platform sees every request waiting on it');
  {
    await as(orgB)(async () => {
      const r = await senderIdService.request(orgB, { value: 'RIVALCO' });
      await senderIdService.submit(r.id);
    });
    const queue = await senderIdService.pendingQueue();
    check('the pending request is in the queue',
      queue.some((q) => q.value === 'RIVALCO'));
    check('and it says which business it is for',
      queue.find((q) => q.value === 'RIVALCO')?.organization.name === 'rival');
    check('an already-approved one is not',
      !queue.some((q) => q.value === 'ABCPHARM'));
  }

  // ── 7. Billing by segments, not by recipient ─────────────────────────────
  console.log('\nA send is quoted by what the network will charge');
  await as(orgA)(async () => {
    const short = Array.from({ length: 250 }, () => 'Your order is ready');
    const quoteShort = await smsWalletService.quoteSms(orgA, short);
    check('250 short messages are 250 units', quoteShort.segments === 250);

    const long = Array.from({ length: 250 }, () => 'x'.repeat(200));
    const quoteLong = await smsWalletService.quoteSms(orgA, long);
    check('250 long messages are 500 units', quoteLong.segments === 500,
      'this is the bug: it used to quote 250 and the network charged for 500');
    check('so the cost doubles too', quoteLong.totalCost === quoteShort.totalCost * 2);
    check('and the recipient count is still reported', quoteLong.recipients === 250);
    check('with the per-message segments for the composer', quoteLong.segmentsPerMessage === 2);

    const emoji = await smsWalletService.quoteSms(orgA, ['Thanks for shopping 🎉']);
    check('an emoji is flagged', emoji.forcedUnicodeBy === '🎉',
      'one character can double a campaign; the sender should know before sending');
    check('and reported as unicode', emoji.encoding === 'UCS2');
  });

  await cleanup();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

async function cleanup() {
  for (const org of [orgA, orgB].filter(Boolean)) {
    await db.senderId.deleteMany({ where: { organizationId: org } }).catch(() => {});
    await db.smsWalletTransaction.deleteMany({ where: { organizationId: org } }).catch(() => {});
    await db.smsWallet.deleteMany({ where: { organizationId: org } }).catch(() => {});
    await db.auditLog.deleteMany({ where: { organizationId: org } }).catch(() => {});
    await db.organization.delete({ where: { id: org } }).catch(() => {});
  }
}

main().catch(async (e) => { console.error(e); await cleanup(); process.exit(1); });
