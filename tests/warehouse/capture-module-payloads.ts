/*
 * What the module endpoints actually return, for a business with real data.
 *
 * The mobile workspaces are laid out against assumed field names. Assumptions
 * are exactly what has been wrong — employees have no `fullName`, campaigns
 * have no `scheduledAt` — so this seeds a business, calls the same services
 * the routes call, and writes the payloads out to drive the layout tests.
 */
import { writeFileSync } from 'node:fs';
import { prismaUnscoped as db } from '../../src/infrastructure/database/prisma';
import { requestContext } from '../../src/shared/context';

const stamp = Date.now();
let orgId = '', userId = '';
const asUser = <T>(fn: () => Promise<T>): Promise<T> =>
  requestContext.run({ organizationId: orgId, userId } as never, fn);

async function main() {
  const org = await db.organization.create({
    data: { name: 'Payload Co', slug: `payload-${stamp}`, currency: 'NGN', status: 'ACTIVE', country: 'NG' },
  });
  orgId = org.id;
  userId = (await db.user.create({
    data: { email: `p-${stamp}@t.test`, passwordHash: 'x', firstName: 'Pay', lastName: 'Load' },
  })).id;

  // Employees, with the variety a real staff list has.
  await db.employee.createMany({
    data: [
      { organizationId: orgId, employeeNumber: `EMP-1-${stamp}`, firstName: 'Oluwaseun', lastName: 'Adebayo-Williams', jobTitle: 'Regional Operations Manager', email: 'o.adebayo@example.com', phone: '+2348012345678', status: 'ACTIVE', employmentType: 'FULL_TIME', hiredAt: new Date('2024-02-01') },
      { organizationId: orgId, employeeNumber: `EMP-2-${stamp}`, firstName: 'Ngozi', lastName: 'Eze', jobTitle: 'Cashier', status: 'ON_LEAVE', employmentType: 'PART_TIME', hiredAt: new Date('2025-06-15') },
      { organizationId: orgId, employeeNumber: `EMP-3-${stamp}`, firstName: 'Tunde', lastName: 'Bello', status: 'TERMINATED', employmentType: 'CONTRACT', hiredAt: new Date('2023-01-05'), terminatedAt: new Date('2025-12-31') },
    ],
  });

  await db.campaign.createMany({
    data: [
      { organizationId: orgId, name: 'End of year clearance — everything must go', type: 'EMAIL', status: 'SCHEDULED', subject: 'Our biggest sale of the year starts tomorrow', content: 'Everything reduced until Sunday.' },
      { organizationId: orgId, name: 'Loyalty members early access', type: 'WHATSAPP', status: 'SENT', content: 'Early access opens today.', startedAt: new Date('2026-08-20'), completedAt: new Date('2026-08-20') },
      { organizationId: orgId, name: 'Draft idea', type: 'SMS', status: 'DRAFT', content: 'TBC' },
    ],
  });

  await db.promotion.createMany({
    data: [
      { organizationId: orgId, name: 'Buy two cartons get one free — August only', description: 'Applies to all dairy lines while stocks last.', discountType: 'PERCENTAGE', discountValue: 33.5, status: 'ACTIVE', startsAt: new Date('2026-08-01'), endsAt: new Date('2026-08-31') },
      { organizationId: orgId, name: 'Flash sale', discountType: 'FIXED_AMOUNT', discountValue: 500, status: 'SCHEDULED', startsAt: new Date('2026-09-01'), endsAt: new Date('2026-09-02') },
    ],
  });

  const program = await db.loyaltyProgram.create({
    data: { organizationId: orgId, name: 'Rewards Club', pointsPerAmount: 1.5, redeemRate: 0.02, expiryMonths: 12, isActive: true },
  });
  const c1 = await db.customer.create({ data: { organizationId: orgId, firstName: 'Adaeze', lastName: 'Okonkwo', email: 'adaeze@example.com', phone: '+2348012345678' } });
  const c2 = await db.customer.create({ data: { organizationId: orgId, firstName: 'Chinedu', lastName: 'Balogun', phone: '+2348090000000' } });
  for (const [customer, balance] of [[c1, 48200], [c2, 410]] as const) {
    const acct = await db.loyaltyAccount.create({ data: { programId: program.id, customerId: customer.id, balance } });
    await db.loyaltyTransaction.create({ data: { accountId: acct.id, type: 'EARN', points: balance, note: 'Points earned from paid order' } });
  }

  // Now read them back through the services the routes use.
  const { employeesService } = await import('../../src/application/employees/employees.service');
  const { campaignService } = await import('../../src/application/messaging/campaign.service');
  const { promotionsService } = await import('../../src/application/marketing/promotions.service');
  const { loyaltyService } = await import('../../src/application/marketing/loyalty.service');

  const payloads = await asUser(async () => ({
    employees: await employeesService.list({ limit: 25 } as never),
    marketing: await campaignService.list(),
    promotions: await promotionsService.listPromotions(),
    loyalty: await loyaltyService.get(),
  }));

  const out = 'tests/warehouse/module-payloads.json';
  writeFileSync(out, JSON.stringify(payloads, null, 2));
  console.log(`wrote ${out}`);
  for (const [k, v] of Object.entries(payloads)) {
    const rows = Array.isArray(v) ? v : (v as { items?: unknown[] }).items;
    console.log(`  ${k}: ${Array.isArray(rows) ? `${rows.length} rows` : 'object'} — keys ${Object.keys(Array.isArray(rows) && rows[0] ? rows[0] as object : v as object).join(', ')}`);
  }
  await cleanup();
}

async function cleanup() {
  await db.loyaltyTransaction.deleteMany({ where: { account: { program: { organizationId: orgId } } } }).catch(() => {});
  await db.loyaltyAccount.deleteMany({ where: { program: { organizationId: orgId } } }).catch(() => {});
  await db.loyaltyProgram.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.promotion.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.campaign.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.employee.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.customer.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.auditLog.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.user.delete({ where: { id: userId } }).catch(() => {});
  await db.organization.delete({ where: { id: orgId } }).catch(() => {});
}

main().catch(async (e) => { console.error(e); await cleanup(); process.exit(1); });
