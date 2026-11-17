/*
 * A workspace to drive the template composer against, plus a stubbed Meta.
 *
 * Separate from the verification suite because this one has to stay up while a
 * browser uses it. Prints the sign-in details and keeps the stub listening
 * until it is interrupted; run `… --teardown <orgId>` to remove the workspace.
 */
import { createServer } from 'node:http';
import { prismaUnscoped as db } from '../../src/infrastructure/database/prisma';
import { encrypt } from '../../src/shared/crypto';
import { authService } from '../../src/application/auth/auth.service';

const META_PORT = Number(process.env.STUB_META_PORT ?? 4976);
const PASSWORD = 'ComposerTest!2026';

/** Templates the stubbed account starts with, so the list is not empty. */
const SEED_TEMPLATES = [{
  name: 'order_ready', language: 'en_US', category: 'UTILITY', status: 'APPROVED',
  components: [{ type: 'BODY', text: 'Hi {{1}}, your order {{2}} is ready.', example: { body_text: [['Ada', 'ORD-91']] } }],
}];

const created: Array<Record<string, unknown>> = [];

function startStubMeta() {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      const url = req.url ?? '';
      if (req.method === 'POST' && url.includes('/message_templates')) {
        const payload = JSON.parse(body || '{}') as Record<string, unknown>;
        created.push(payload);
        console.log('\n[stub Meta] template submitted:', JSON.stringify(payload, null, 2));
        return res.end(JSON.stringify({ id: `tpl-${created.length}`, status: 'PENDING', category: payload.category }));
      }
      if (req.method === 'DELETE' && url.includes('/message_templates')) {
        console.log('[stub Meta] delete:', url);
        return res.end(JSON.stringify({ success: true }));
      }
      return res.end(JSON.stringify({
        data: SEED_TEMPLATES, summary: { message_template_count: 1, message_template_limit: 250 },
      }));
    });
  });
  server.listen(META_PORT, '127.0.0.1', () => console.log(`[stub Meta] listening on ${META_PORT}`));
  return server;
}

async function teardown(orgId: string) {
  const users = await db.membership.findMany({ where: { organizationId: orgId }, select: { userId: true } });
  for (const t of ['campaignRecipient', 'campaign', 'customer', 'channelAccount', 'membership', 'rolePermission', 'activity', 'auditLog', 'usageCounter', 'subscription'] as const) {
    if (t === 'rolePermission') {
      const roles = await db.role.findMany({ where: { organizationId: orgId }, select: { id: true } });
      await db.rolePermission.deleteMany({ where: { roleId: { in: roles.map((r) => r.id) } } }).catch(() => {});
      continue;
    }
    await (db as any)[t]?.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  }
  await db.role.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
  await db.organization.delete({ where: { id: orgId } }).catch(() => {});
  for (const { userId } of users) {
    await db.refreshToken.deleteMany({ where: { userId } }).catch(() => {});
    /*
     * Registration issues an email-verification token, and SecurityToken holds
     * the user with RESTRICT — so without this the user row survives teardown
     * and the fixture leaks an orphan on every run.
     */
    await db.securityToken.deleteMany({ where: { userId } }).catch(() => {});
    await db.user.delete({ where: { id: userId } })
      .catch((err) => console.warn(`could not remove user ${userId}:`, (err as Error).message.split('\n').pop()));
  }
  console.log(`removed workspace ${orgId}`);
}

async function main() {
  const teardownId = process.argv.indexOf('--teardown');
  if (teardownId !== -1) {
    await teardown(process.argv[teardownId + 1] as string);
    process.exit(0);
  }

  startStubMeta();
  const stamp = Date.now();
  const email = `composer-${stamp}@example.invalid`;
  const registered = await authService.register({
    email, password: PASSWORD, firstName: 'Composer', lastName: 'Test',
    organizationName: `Composer Test ${stamp}`, businessType: 'RETAIL',
  } as never) as { organizationId?: string; user?: { id: string } };

  const orgId = registered.organizationId
    ?? (await db.membership.findFirstOrThrow({ where: { user: { email } }, select: { organizationId: true } })).organizationId;

  const wabaId = `waba-ui-${stamp}`;
  await db.channelAccount.create({
    data: {
      organizationId: orgId, channelType: 'WHATSAPP', name: 'Shop WhatsApp',
      externalId: `wa-ui-${stamp}`, purpose: 'MARKETING', isActive: true, status: 'CONNECTED',
      metaWabaId: wabaId, metaPhoneNumberId: `phone-ui-${stamp}`,
      credentialsEnc: encrypt(JSON.stringify({
        accessToken: 'stub-token', phoneNumberId: `phone-ui-${stamp}`, wabaId,
        appId: 'app', appSecret: 'stub-app-secret',
      })),
      metadata: {
        wabaId, wabaName: 'Shop WABA', displayPhoneNumber: '+234 800 000 0000',
        messageTemplates: SEED_TEMPLATES, templateQuota: { count: 1, limit: 250 },
      },
    },
  });

  // A few opted-in customers, so the Review step has an audience to price.
  for (const [firstName, phone] of [['Ada', '08030000011'], ['Bola', '08030000012'], ['Chidi', '08030000013']]) {
    await db.customer.create({
      data: { organizationId: orgId, firstName, lastName: 'Test', phone, marketingOptIn: true },
    });
  }

  console.log('\n──────────────────────────────────────────────');
  console.log(`  org      ${orgId}`);
  console.log(`  email    ${email}`);
  console.log(`  password ${PASSWORD}`);
  console.log('──────────────────────────────────────────────');
  console.log('\nStub Meta is up. Ctrl-C when finished, then:');
  console.log(`  npx tsx tests/warehouse/whatsapp-template-ui-fixture.ts --teardown ${orgId}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
