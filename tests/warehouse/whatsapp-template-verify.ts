/*
 * Authoring a WhatsApp template without WhatsApp Manager, end to end.
 *
 * The claim being tested: a business can write a marketing template inside the
 * product, submit it to Meta, and have the approval come back on its own. What
 * is deliberately NOT claimed is that approval is skipped — half of these
 * checks exist to prove a template stays unsendable until Meta says otherwise.
 *
 * Meta is stubbed throughout. No real WhatsApp Business Account is contacted,
 * and both organizations are removed at the end.
 *
 * Run with the stub's address in the environment, because env is read at
 * import time:
 *   META_GRAPH_BASE_URL=http://127.0.0.1:4976 npx tsx tests/warehouse/whatsapp-template-verify.ts
 */
import { createServer, type Server } from 'node:http';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { prismaUnscoped as db } from '../../src/infrastructure/database/prisma';
import { requestContext } from '../../src/shared/context';
import { encrypt } from '../../src/shared/crypto';
import { createApp } from '../../src/app';
import {
  parseTemplateStatusUpdates,
  slugifyTemplateName,
  validateDraft,
  whatsappTemplateService,
  type TemplateDraft,
} from '../../src/application/messaging/whatsapp-template.service';
import { whatsappCampaignService } from '../../src/application/messaging/whatsapp-campaign.service';

let passed = 0, failed = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); }
};

const stamp = Date.now();
const META_PORT = 4976;
const WABA = `waba-tpl-${stamp}`;
const APP_SECRET = 'stub-app-secret';

let orgId = '', otherOrgId = '', userId = '', accountId = '', otherAccountId = '';
let meta: Server | null = null;
let appServer: Server | null = null;
let appPort = 0;

const asOrg = <T>(fn: () => Promise<T>, organizationId = orgId) =>
  requestContext.run({ requestId: `wat-${stamp}`, organizationId, userId }, fn);

/** What the stub does on the next create: accept, or refuse with a code. */
let createMode: 'ok' | 'rate_limit' | 'duplicate_name' = 'ok';
/** Every create body the stub was handed, so the request itself can be read. */
const createCalls: Array<Record<string, unknown>> = [];
const deleteCalls: string[] = [];

async function startStubMeta() {
  meta = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      const url = req.url ?? '';

      if (req.method === 'POST' && url.includes('/message_templates')) {
        createCalls.push(JSON.parse(body || '{}') as Record<string, unknown>);
        if (createMode === 'rate_limit') {
          res.statusCode = 400;
          return res.end(JSON.stringify({ error: { code: 80008, message: 'Too many calls to this WhatsApp Business Account' } }));
        }
        if (createMode === 'duplicate_name') {
          res.statusCode = 400;
          return res.end(JSON.stringify({ error: { code: 100, message: 'Template name already exists in the same language' } }));
        }
        res.statusCode = 200;
        return res.end(JSON.stringify({ id: `tpl-${createCalls.length}`, status: 'PENDING', category: 'MARKETING' }));
      }

      if (req.method === 'DELETE' && url.includes('/message_templates')) {
        deleteCalls.push(decodeURIComponent(new URL(url, 'http://x').searchParams.get('name') ?? ''));
        return res.end(JSON.stringify({ success: true }));
      }

      // GET list, with the summary the quota display depends on.
      return res.end(JSON.stringify({
        data: [{
          name: 'synced_offer', language: 'en_US', category: 'MARKETING', status: 'APPROVED',
          components: [{ type: 'BODY', text: 'Hello {{1}}', example: { body_text: [['Ada']] } }],
        }],
        summary: { message_template_count: 42, message_template_limit: 250 },
      }));
    });
  });
  await new Promise<void>((resolve) => meta!.listen(META_PORT, '127.0.0.1', resolve));
}

async function startApp() {
  const app = createApp();
  appServer = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => appServer!.once('listening', resolve));
  appPort = (appServer!.address() as AddressInfo).port;
}

/** A Meta webhook delivery, signed the way Meta signs it. */
async function postWebhook(payload: unknown, sign = true) {
  const raw = JSON.stringify(payload);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (sign) headers['x-hub-signature-256'] = `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;
  const res = await fetch(`http://127.0.0.1:${appPort}/api/webhooks/whatsapp`, { method: 'POST', headers, body: raw });
  // The route acknowledges before processing; give the async pass a moment.
  await new Promise((r) => setTimeout(r, 400));
  return res;
}

function statusPayload(event: string, opts: { name?: string; language?: string; reason?: string } = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: WABA,
      time: Math.floor(Date.now() / 1000),
      changes: [{
        field: 'message_template_status_update',
        value: {
          event,
          message_template_id: 123,
          message_template_name: opts.name ?? 'weekend_flash_sale',
          // Meta writes the language with a hyphen here and an underscore
          // in the template itself. Both must resolve to one template.
          message_template_language: opts.language ?? 'en-US',
          reason: opts.reason ?? 'NONE',
          ...(event === 'REJECTED' ? { rejection_info: { reason: opts.reason ?? 'INVALID_FORMAT', recommendation: 'Fix it' } } : {}),
        },
      }],
    }],
  };
}

const DRAFT: TemplateDraft = {
  name: 'Weekend Flash Sale!',
  language: 'en_US',
  category: 'MARKETING',
  headerText: 'Weekend offer',
  bodyText: 'Hi {{1}}, enjoy {{2}} off everything until Sunday.',
  footerText: 'Reply STOP to opt out',
  examples: { '1': 'Ada', '2': '20%' },
};

async function main() {
  await startStubMeta();
  await startApp();

  const org = await db.organization.create({
    data: { name: `Tpl Verify ${stamp}`, slug: `tpl-verify-${stamp}`, currency: 'NGN', status: 'ACTIVE', country: 'NG' },
  });
  orgId = org.id;
  const other = await db.organization.create({
    data: { name: `Tpl Other ${stamp}`, slug: `tpl-other-${stamp}`, currency: 'NGN', status: 'ACTIVE', country: 'NG' },
  });
  otherOrgId = other.id;
  const user = await db.user.create({
    data: { email: `tpl-verify-${stamp}@example.invalid`, firstName: 'Tpl', lastName: 'Verify', passwordHash: 'x' },
  });
  userId = user.id;

  const credentials = encrypt(JSON.stringify({
    accessToken: 'stub-token', phoneNumberId: '555', wabaId: WABA, appId: 'app', appSecret: APP_SECRET,
  }));
  accountId = (await db.channelAccount.create({
    data: {
      organizationId: orgId, channelType: 'WHATSAPP', name: 'Shop WhatsApp', externalId: `wa-tpl-${stamp}`,
      purpose: 'MARKETING', isActive: true, status: 'CONNECTED', credentialsEnc: credentials,
      metaWabaId: WABA, metaPhoneNumberId: `phone-${stamp}`,
      metadata: { wabaId: WABA, wabaName: 'Shop WABA', displayPhoneNumber: '+234 800 000 0000', messageTemplates: [] },
    },
  })).id;
  otherAccountId = (await db.channelAccount.create({
    data: {
      organizationId: otherOrgId, channelType: 'WHATSAPP', name: 'Other WhatsApp', externalId: `wa-other-${stamp}`,
      purpose: 'MARKETING', isActive: true, status: 'CONNECTED', credentialsEnc: credentials,
      metadata: { wabaId: 'waba-other', messageTemplates: [] },
    },
  })).id;

  // ── Names and drafts, before anything reaches Meta ───────────────────────
  console.log('\nTurning what a business types into what Meta accepts');
  check('a typed name becomes a legal one', slugifyTemplateName('Weekend Flash Sale!') === 'weekend_flash_sale',
    slugifyTemplateName('Weekend Flash Sale!'));
  check('runs of punctuation collapse', slugifyTemplateName('  Sale -- 2026  ') === 'sale_2026',
    slugifyTemplateName('  Sale -- 2026  '));
  check('accents are folded, not dropped', slugifyTemplateName('Café Offer') === 'cafe_offer',
    slugifyTemplateName('Café Offer'));
  check('a name of pure punctuation yields nothing', slugifyTemplateName('!!!') === '');

  console.log('\nRefusing what Meta would refuse, a day sooner');
  check('a clean draft passes', validateDraft(DRAFT).errors.length === 0,
    validateDraft(DRAFT).errors.join(' '));
  const noExample = validateDraft({ ...DRAFT, examples: { '1': 'Ada' } });
  check('a placeholder with no example is caught', noExample.errors.some((e) => e.includes('{{2}}')),
    noExample.errors.join(' '));
  const gap = validateDraft({ ...DRAFT, bodyText: 'Hi {{1}}, take {{3}} off.', examples: { '1': 'a', '3': 'b' } });
  check('a gap in the numbering is caught', gap.errors.some((e) => e.includes('without gaps')),
    gap.errors.join(' '));
  const headerVar = validateDraft({ ...DRAFT, headerText: 'Hello {{1}}' });
  check('a placeholder in the header is caught', headerVar.errors.some((e) => e.includes('header')),
    headerVar.errors.join(' '));
  check('a nameless draft is caught', validateDraft({ ...DRAFT, name: '!!!' }).errors.length > 0);

  // ── Submitting ───────────────────────────────────────────────────────────
  console.log('\nSubmitting a template to Meta');
  const created = await asOrg(() => whatsappTemplateService.create(accountId, orgId, DRAFT));
  check('it comes back pending', created.status === 'PENDING', created.status);
  check('and is not sendable yet', created.eligible === false);
  check('with the reason shown', created.ineligibleReason === 'Waiting for Meta approval', String(created.ineligibleReason));
  check('under the slugified name', created.name === 'weekend_flash_sale', created.name);

  const sent = createCalls[0] ?? {};
  check('Meta was sent the slugified name', sent.name === 'weekend_flash_sale', String(sent.name));
  check('Meta was allowed to re-categorise it', sent.allow_category_change === true);
  const components = (sent.components ?? []) as Array<Record<string, any>>;
  const body = components.find((c) => c.type === 'BODY');
  check('header, body and footer were all sent', components.length === 3, `${components.length} components`);
  check('examples were sent in placeholder order',
    JSON.stringify(body?.example?.body_text) === JSON.stringify([['Ada', '20%']]),
    JSON.stringify(body?.example?.body_text));

  const listed = await asOrg(() => whatsappTemplateService.list(accountId, orgId));
  check('it appears in the builder immediately', listed.some((t) => t.name === 'weekend_flash_sale'));

  let refusedPending = false;
  await asOrg(() => whatsappTemplateService.requireEligible(accountId, orgId, 'weekend_flash_sale', 'en_US'))
    .catch(() => { refusedPending = true; });
  check('a campaign cannot use it while pending', refusedPending);

  // ── What Meta refuses, and how it is explained ──────────────────────────
  console.log('\nWhen Meta refuses the submission');
  createMode = 'rate_limit';
  let rateErr: any = null;
  await asOrg(() => whatsappTemplateService.create(accountId, orgId, { ...DRAFT, name: 'Another One' }))
    .catch((e) => { rateErr = e; });
  check('a rate limit is reported as a rate limit', rateErr?.code === 'TEMPLATE_RATE_LIMITED', String(rateErr?.code));
  check('with a 429', rateErr?.statusCode === 429 || rateErr?.status === 429, String(rateErr?.statusCode ?? rateErr?.status));
  check('and does not blame the template', /nothing is wrong with the template/i.test(String(rateErr?.message)));

  createMode = 'duplicate_name';
  let nameErr: any = null;
  await asOrg(() => whatsappTemplateService.create(accountId, orgId, { ...DRAFT, name: 'Another One' }))
    .catch((e) => { nameErr = e; });
  check('a name clash is named as one', nameErr?.code === 'TEMPLATE_NAME_REJECTED', String(nameErr?.code));

  const afterRefusals = await asOrg(() => whatsappTemplateService.list(accountId, orgId));
  check('a refused submission stores nothing', afterRefusals.length === 1, `${afterRefusals.length} stored`);
  createMode = 'ok';

  // ── Meta's verdict, arriving on its own ─────────────────────────────────
  console.log('\nReading Meta’s verdict off the webhook');
  const parsed = parseTemplateStatusUpdates(statusPayload('APPROVED'));
  check('a status change is found in the payload', parsed.length === 1, `${parsed.length} found`);
  check('with the event', parsed[0]?.event === 'APPROVED', String(parsed[0]?.event));
  const messagesOnly = parseTemplateStatusUpdates({
    entry: [{ changes: [{ field: 'messages', value: { messages: [{ id: 'wamid.x' }] } }] }],
  });
  check('an ordinary message delivery yields none', messagesOnly.length === 0);

  const applied = await whatsappTemplateService.applyStatusUpdate(accountId, {
    name: 'weekend_flash_sale', language: 'en-US', event: 'APPROVED', reason: null,
  });
  check('the verdict is applied', applied === true);
  /*
   * The stored template says en_US and the webhook said en-US. Proving the
   * match is only half of it: a genuinely different language must still miss,
   * or "normalising" would just mean ignoring the field.
   */
  const wrongLanguage = await whatsappTemplateService.applyStatusUpdate(accountId, {
    name: 'weekend_flash_sale', language: 'fr_FR', event: 'PAUSED', reason: null,
  });
  check('a different language is not treated as the same template', wrongLanguage === false);
  const approved = (await asOrg(() => whatsappTemplateService.list(accountId, orgId)))
    .find((t) => t.name === 'weekend_flash_sale');
  check('the template becomes sendable', approved?.eligible === true, approved?.status);
  const usable = await asOrg(() => whatsappTemplateService.requireEligible(accountId, orgId, 'weekend_flash_sale', 'en_US'));
  check('and a campaign will now take it', usable.name === 'weekend_flash_sale');

  const unknown = await whatsappTemplateService.applyStatusUpdate(accountId, {
    name: 'never_submitted', language: 'en_US', event: 'APPROVED', reason: null,
  });
  check('a verdict for someone else’s template is ignored', unknown === false);

  // ── The whole path, over HTTP, signed the way Meta signs it ─────────────
  console.log('\nThe real webhook route, end to end');
  const res = await postWebhook(statusPayload('REJECTED', { reason: 'INVALID_FORMAT' }));
  check('Meta is acknowledged', res.status === 200, String(res.status));
  const rejected = (await asOrg(() => whatsappTemplateService.list(accountId, orgId)))
    .find((t) => t.name === 'weekend_flash_sale');
  check('the rejection routed by WABA id and landed', rejected?.status === 'REJECTED', rejected?.status);
  check('the reason Meta gave is kept', rejected?.rejectedReason === 'INVALID_FORMAT', String(rejected?.rejectedReason));
  check('and is shown as why it cannot be used',
    /INVALID_FORMAT/.test(String(rejected?.ineligibleReason)), String(rejected?.ineligibleReason));
  check('a rejected template is not sendable', rejected?.eligible === false);

  await postWebhook(statusPayload('APPROVED'), false);
  const afterUnsigned = (await asOrg(() => whatsappTemplateService.list(accountId, orgId)))
    .find((t) => t.name === 'weekend_flash_sale');
  check('an unsigned delivery changes nothing', afterUnsigned?.status === 'REJECTED', afterUnsigned?.status);

  // ── Withdrawing, headroom, and tenancy ──────────────────────────────────
  console.log('\nWithdrawing a template, and the headroom left');
  await asOrg(() => whatsappTemplateService.remove(accountId, orgId, 'weekend_flash_sale'));
  check('Meta was asked to delete it by name', deleteCalls.includes('weekend_flash_sale'), deleteCalls.join(','));
  const afterDelete = await asOrg(() => whatsappTemplateService.list(accountId, orgId));
  check('and it is gone locally too', afterDelete.every((t) => t.name !== 'weekend_flash_sale'));

  await asOrg(() => whatsappTemplateService.refresh(accountId, orgId));
  const accounts = await asOrg(() => whatsappCampaignService.sendingAccounts());
  const account = accounts.find((a) => a.id === accountId);
  check('a refresh records the account’s template cap', account?.templateLimit === 250, String(account?.templateLimit));

  let crossTenant = false;
  await asOrg(() => whatsappTemplateService.create(otherAccountId, orgId, DRAFT))
    .catch(() => { crossTenant = true; });
  check('another business’s channel does not resolve', crossTenant);

  await cleanup();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

async function cleanup() {
  meta?.close();
  appServer?.close();
  for (const id of [orgId, otherOrgId].filter(Boolean)) {
    for (const t of ['channelAccount', 'activity', 'auditLog', 'usageCounter'] as const) {
      await (db as any)[t]?.deleteMany({ where: { organizationId: id } }).catch(() => {});
    }
    await db.organization.delete({ where: { id } }).catch(() => {});
  }
  await db.user.delete({ where: { id: userId } }).catch(() => {});
}

main().catch(async (e) => { console.error(e); await cleanup(); process.exit(1); });
