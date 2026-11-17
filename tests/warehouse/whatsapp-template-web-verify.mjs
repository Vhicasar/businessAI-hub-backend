/*
 * The template composer: the screen and the server agreeing.
 *
 * Structural, because the failure that survives a passing backend suite is the
 * two drifting apart — a field the composer sends that the schema drops, a
 * route it calls that does not exist, or a rule enforced on only one side.
 *
 * Run: node tests/warehouse/whatsapp-template-web-verify.mjs
 */
import { readFileSync } from 'node:fs';

const WEB = '/Users/mac/Desktop/Development/businesshub-ai/web/src';
const API = '/Users/mac/Desktop/Development/businesshub-ai/backend/src';

let passed = 0, failed = 0;
const check = (n, ok, d = '') => {
  if (ok) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); }
};

const composer = readFileSync(`${WEB}/features/marketing/TemplateComposerDialog.tsx`, 'utf8');
const dialog = readFileSync(`${WEB}/features/marketing/WhatsAppCampaignDialog.tsx`, 'utf8');
const routes = readFileSync(`${API}/presentation/http/v1/marketing.routes.ts`, 'utf8');
const svc = readFileSync(`${API}/application/messaging/whatsapp-template.service.ts`, 'utf8');
const campaigns = readFileSync(`${API}/application/messaging/whatsapp-campaign.service.ts`, 'utf8');
const webhooks = readFileSync(`${API}/presentation/http/webhooks.routes.ts`, 'utf8');

console.log('\n=== 1. EVERY CALL THE SCREEN MAKES HAS AN ENDPOINT ===');
check('submitting a template posts to the templates route',
  /api<ComposedTemplate>\(`\/marketing\/whatsapp\/accounts\/\$\{accountId\}\/templates`/.test(composer)
  && routes.includes("'/whatsapp/accounts/:accountId/templates',"));
check('the server serves that POST', /marketingRoutes\.post\(\s*'\/whatsapp\/accounts\/:accountId\/templates'/.test(routes));
check('deleting a template calls the delete route',
  /\/marketing\/whatsapp\/accounts\/\$\{accountId\}\/templates\/\$\{encodeURIComponent\(name\)\}/.test(dialog)
  && /marketingRoutes\.delete\(\s*'\/whatsapp\/accounts\/:accountId\/templates\/:name'/.test(routes));
check('the composer is mounted by the campaign builder',
  dialog.includes('<TemplateComposerDialog') && dialog.includes("from './TemplateComposerDialog'"));

console.log('\n=== 2. THE BODY IT SENDS IS THE BODY THE SCHEMA ACCEPTS ===');
{
  const schema = /export const templateDraftSchema = z\.object\(\{([\s\S]*?)\n\}\);/.exec(svc)?.[1] ?? '';
  const accepted = [...schema.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);
  const sent = ['name', 'language', 'category', 'headerText', 'bodyText', 'footerText', 'examples'];
  for (const field of sent) {
    check(`the schema accepts "${field}"`, accepted.includes(field), `accepts ${accepted.join(', ')}`);
  }
  /*
   * Read the keys out of the request body itself rather than searching the
   * file: `language` and `category` are sent in shorthand, which a naive
   * `name:` search misses, and that false alarm would train people to ignore
   * this check.
   */
  const bodyBlock = /body: \{([\s\S]*?)\n      \},/.exec(composer)?.[1] ?? '';
  const keys = bodyBlock
    .split(/[,\n]/)
    .map((part) => part.trim().split(':')[0].trim())
    .filter((part) => /^\w+$/.test(part));
  for (const field of sent) {
    check(`the composer sends "${field}"`, keys.includes(field), `sends ${keys.join(', ')}`);
  }
  check('nothing in the schema goes unsent',
    accepted.every((f) => sent.includes(f)), `schema also has ${accepted.filter((f) => !sent.includes(f)).join(', ')}`);
}

console.log('\n=== 3. THE SAME RULES ON BOTH SIDES ===');
check('both slugify to lowercase, numbers and underscores',
  svc.includes("replace(/[^a-z0-9]+/g, '_')") && composer.includes("replace(/[^a-z0-9]+/g, '_')"));
check('both strip accents the same way',
  svc.includes("normalize('NFKD')") && composer.includes("normalize('NFKD')"));
check('both cap the name at Meta’s 512', svc.includes('slice(0, 512)') && composer.includes('slice(0, 512)'));
check('both require an example per placeholder',
  /has no example/.test(svc) && /needs an example/.test(composer));
check('both reject a gap in the numbering',
  /value === position \+ 1/.test(svc) && /value === position \+ 1/.test(composer));
check('both reject a placeholder in the header',
  /variablesIn\(draft\.headerText \?\? ''\)\.length/.test(svc)
  && /placeholdersIn\(headerText\)\.length/.test(composer));
check('the server validates regardless of what the screen did',
  /const \{ name, errors \} = validateDraft\(draft\);[\s\S]{0,120}throw new ValidationError/.test(svc));

console.log('\n=== 4. MESSAGE LIMITS MATCH META ===');
check('header capped at 60', /header: 60/.test(composer));
check('body capped at 1024', /body: 1024/.test(composer));
check('footer capped at 60', /footer: 60/.test(composer));
check('the server bounds the body too', /bodyText: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(1024\)/.test(svc));
check('and the header and footer', /headerText: z\.string\(\)\.trim\(\)\.max\(60\)/.test(svc) && /footerText: z\.string\(\)\.trim\(\)\.max\(60\)/.test(svc));

console.log('\n=== 5. APPROVAL ARRIVES WITHOUT ANYONE ASKING ===');
check('the Meta receiver looks for template decisions',
  webhooks.includes('parseTemplateStatusUpdates(body)'));
check('and applies them to the account that owns them',
  /whatsappTemplateService\.applyStatusUpdate\(account\.id, update\)/.test(webhooks));
check('a failure there does not drop the inbound messages',
  /applyStatusUpdate\(account\.id, update\)\s*\n\s*\.catch\(/.test(webhooks));
check('the parser keys on Meta’s field name',
  svc.includes("change.field !== 'message_template_status_update'"));
check('the screen says approval needs no babysitting',
  /becomes selectable here on its own once/.test(dialog));

console.log('\n=== 6. WHAT MUST NOT REGRESS ===');
check('Meta may re-file a miscategorised template', /allow_category_change: true/.test(svc));
check('a rate limit is not reported as a bad template',
  /code === 80008/.test(svc) && /nothing is wrong with the template/.test(svc));
check('a pending template cannot be sent', svc.includes("const eligible = status === 'APPROVED'"));
check('the composer never promises instant approval',
  !/approved immediately|instant approval/i.test(composer) && /usually finish within a day/.test(composer));
check('the empty state no longer sends people to WhatsApp Manager',
  !/WhatsApp Manager,\s*\n?\s*then refresh/.test(dialog));
check('template authoring follows the campaigns platform switch',
  /function requireWhatsAppCampaigns/.test(routes)
  && (routes.match(/requireWhatsAppCampaigns\(\);/g) ?? []).length >= 2);
check('and sits behind the marketing plan feature',
  routes.includes("requireFeature('marketing')"));
check('both writes need permission to change how the business sends',
  (routes.match(/requirePermission\('marketing\.update'\),\n\s*(validate|wrap)/g) ?? []).length >= 2);

console.log('\n=== 7. MONEY IS ATTRIBUTED TO META, NOT TO US ===');
{
  const pricing = readFileSync(`${API}/application/messaging/whatsapp-pricing.service.ts`, 'utf8');
  const userFacing = pricing.split('export const whatsappPricingService')[1] ?? '';
  check('no cost message blames the platform administrator',
    !/platform administrator/.test(userFacing),
    'a user-facing string still names the platform administrator');
  check('having no rates is its own case, not a generic failure',
    /reasonCode: 'NO_RATES'/.test(pricing) && /reasonCode === 'NO_RATES'/.test(dialog));
  check('and reads as Meta charging rather than something being unavailable',
    /Meta charges for this campaign/.test(dialog));
  check('every cost message offers the way to Meta\u2019s payment settings',
    (dialog.match(/<MetaPaymentLink billing=/g) ?? []).length === 3,
    `${(dialog.match(/<MetaPaymentLink billing=/g) ?? []).length} of 3 link out`);
  check('the link opens in its own tab, safely',
    /target="_blank"/.test(dialog) && /rel="noopener noreferrer"/.test(dialog));
  check('aimed at the URL the server supplies, not one hard-coded in the screen',
    /href=\{billing\.setupUrl\}/.test(dialog) && !/business\.facebook\.com/.test(dialog));
}

console.log('\n=== 8. THE HEADROOM IS REAL, NOT GUESSED ===');
check('the cap comes from Meta’s own summary', /summary=true/.test(svc));
check('but asking for it can never cost us the template list',
  /retrying without it/.test(svc) && /await read\(base\)/.test(svc));
check('and a capability refusal names the missing permission',
  /whatsapp_business_management permission/.test(svc) && /code === 3 \|\| code === 200/.test(svc));
check('it is stored only when Meta reports it',
  /count === null && limit === null \? \{\} : \{ templateQuota/.test(svc));
check('the account list carries it', /templateLimit: quotaLimit\(metadata\)/.test(campaigns));
check('and the screen shows it against the count',
  /\{selectedAccount\.templateCount\} of \{selectedAccount\.templateLimit\} used/.test(dialog));
check('a missing cap simply shows nothing', /selectedAccount\?\.templateLimit != null &&/.test(dialog));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
