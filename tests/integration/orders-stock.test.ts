import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prismaUnscoped, disconnectDatabase } from '../../src/infrastructure/database/prisma';
import { ordersService } from '../../src/application/orders/orders.service';
import {
  HAS_TEST_DB, asTenant, createCommerceFixture, createOrgFixture, resetDb,
} from './helpers';

describe.skipIf(!HAS_TEST_DB)('orders: stock accounting & payments', () => {
  let orgId: string;
  let fixture: Awaited<ReturnType<typeof createCommerceFixture>>;

  beforeAll(async () => {
    await resetDb();
    const { org } = await createOrgFixture('Commerce');
    orgId = org.id;
    fixture = await createCommerceFixture(orgId);
  });

  afterAll(async () => {
    await disconnectDatabase();
  });

  async function stock() {
    const level = await prismaUnscoped.stockLevel.findUniqueOrThrow({
      where: { id: fixture.stock.id },
    });
    return { quantity: Number(level.quantity), reserved: Number(level.reserved) };
  }

  it('creating an order reserves stock and snapshots prices', async () => {
    const order = await asTenant(orgId, () =>
      ordersService.create(
        {
          customerId: fixture.customer.id,
          warehouseId: fixture.warehouse.id,
          source: 'MANUAL',
          shippingTotal: 0,
          items: [{ variantId: fixture.variant.id, quantity: 2 }],
        },
        null
      )
    );
    expect(order.number).toMatch(/^ORD-\d{4}-\d{5}$/);
    expect(Number(order.total)).toBe(100); // 2 × 50, no tax
    expect(order.items[0]).toMatchObject({ sku: fixture.variant.sku });
    expect(await stock()).toEqual({ quantity: 10, reserved: 2 });
  });

  it('rejects orders beyond available stock', async () => {
    await expect(
      asTenant(orgId, () =>
        ordersService.create(
          {
            customerId: fixture.customer.id,
            warehouseId: fixture.warehouse.id,
            source: 'MANUAL',
            shippingTotal: 0,
            items: [{ variantId: fixture.variant.id, quantity: 9 }], // only 8 available
          },
          null
        )
      )
    ).rejects.toThrow(/Insufficient stock/);
  });

  it('dispatch decrements stock and releases the reservation', async () => {
    const order = await asTenant(orgId, () =>
      ordersService.list({ limit: 1, assignedToId: undefined } as never)
    ).then((r) => r.items[0]!);

    for (const status of ['CONFIRMED', 'PICKING', 'PACKING', 'READY_FOR_DISPATCH', 'DISPATCHED'] as const) {
      await asTenant(orgId, () => ordersService.transition(order.id, { status }, 'tester'));
    }
    expect(await stock()).toEqual({ quantity: 8, reserved: 0 });

    const movements = await prismaUnscoped.stockMovement.count({
      where: { referenceId: order.id, type: 'SALE' },
    });
    expect(movements).toBe(1);
  });

  it('blocks illegal transitions', async () => {
    const order = await asTenant(orgId, () =>
      ordersService.list({ limit: 1 } as never)
    ).then((r) => r.items[0]!);
    await expect(
      asTenant(orgId, () => ordersService.transition(order.id, { status: 'PICKING' }, 'tester'))
    ).rejects.toThrow(/Cannot move order/);
  });

  it('cancelling a fresh order releases its reservation', async () => {
    const order = await asTenant(orgId, () =>
      ordersService.create(
        {
          customerId: fixture.customer.id,
          warehouseId: fixture.warehouse.id,
          source: 'MANUAL',
          shippingTotal: 0,
          items: [{ variantId: fixture.variant.id, quantity: 3 }],
        },
        null
      )
    );
    expect((await stock()).reserved).toBe(3);
    await asTenant(orgId, () =>
      ordersService.transition(order.id, { status: 'CANCELLED', note: 'test' }, 'tester')
    );
    expect(await stock()).toEqual({ quantity: 8, reserved: 0 });
  });

  it('full payment marks the order paid and updates customer CLV', async () => {
    const order = await asTenant(orgId, () =>
      ordersService.list({ status: 'DISPATCHED', limit: 1 } as never)
    ).then((r) => r.items[0]!);

    const paid = await asTenant(orgId, () =>
      ordersService.recordPayment(order.id, { amount: 100, method: 'CASH' }, null)
    );
    expect(paid.paymentStatus).toBe('PAID');

    const customer = await prismaUnscoped.customer.findUniqueOrThrow({
      where: { id: fixture.customer.id },
    });
    expect(Number(customer.lifetimeValue)).toBe(100);
    expect(customer.totalOrders).toBe(1);

    // Overpayment is rejected.
    await expect(
      asTenant(orgId, () =>
        ordersService.recordPayment(order.id, { amount: 1, method: 'CASH' }, null)
      )
    ).rejects.toThrow();
  });
});
