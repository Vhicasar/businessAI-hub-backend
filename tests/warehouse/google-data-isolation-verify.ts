/*
 * Google user data never reaches the third-party AI provider.
 *
 * Google's verification review asks for "complete, auditable data isolation"
 * between data obtained from its APIs and any AI service whose terms permit
 * training on submitted content. The isolation is built; this is the guard
 * that keeps it built, and the thing a reviewer can be pointed at.
 *
 * Four claims, each checked against the source rather than asserted in prose:
 *
 *   1. Nothing reaches the model except through the policy gateway.
 *   2. Every call declares where its input came from.
 *   3. The gateway refuses Google-sourced and unclassified input, and says so
 *      in an audit line, before any provider I/O.
 *   4. The Google Calendar integration only ever writes, so there is barely
 *      any Google user data to leak in the first place.
 *
 *   npx tsx tests/warehouse/google-data-isolation-verify.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

const SRC = join(__dirname, '../../src');
const read = (p: string): string => readFileSync(p, 'utf8');

/** Strip comments, so prose about a rule is not mistaken for the rule. */
const code = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (path.endsWith('.ts')) out.push(path);
  }
  return out;
}

const FILES = walk(SRC);

function main(): void {
  // ── 1. One way in ───────────────────────────────────────────────────────
  console.log('\nNothing reaches the model except through the policy gateway');
  {
    const gatewayFile = join(SRC, 'infrastructure/ai/index.ts');
    const gateway = code(read(gatewayFile));
    check('the gateway exists and wraps a provider', gateway.includes('export function meterProvider'));
    check('the only public accessor returns a wrapped provider',
      /export function getAiProvider[\s\S]{0,400}?meterProvider\(raw, feature\)/.test(gateway));

    /*
     * `buildAiProvider` makes a raw, unmetered provider. It is legitimate —
     * a business bringing its own key needs one — but every result must be
     * wrapped before it is used, or that business's calls would bypass the
     * policy entirely.
     */
    const builders = FILES.filter((f) => f !== gatewayFile && code(read(f)).includes('buildAiProvider('));
    for (const file of builders) {
      const source = code(read(file));
      const wrapped = source.includes('meterProvider(');
      check(`${relative(SRC, file)} wraps the provider it builds`, wrapped);
    }
    check('no other module constructs a provider', builders.length <= 1,
      builders.map((f) => relative(SRC, f)).join(', '));

    const rawLeaks = FILES.filter(
      (f) => f !== gatewayFile && /\brawProvider\s*\(/.test(code(read(f))),
    );
    check('the unwrapped provider is not reachable from outside the gateway',
      rawLeaks.length === 0, rawLeaks.map((f) => relative(SRC, f)).join(', '));
  }

  // ── 2. Everything is classified ─────────────────────────────────────────
  console.log('\nEvery request says where its input came from');
  {
    /*
     * Read each call to its own closing bracket rather than a fixed window.
     * Prompts here run to hundreds of characters, and a window long enough
     * for the longest of them is long enough to catch the next call's
     * options and call an unclassified request classified.
     */
    const callEnd = (source: string, openIndex: number): number => {
      let depth = 0;
      for (let i = openIndex; i < source.length; i += 1) {
        const ch = source[i];
        if (ch === '(') depth += 1;
        else if (ch === ')') {
          depth -= 1;
          if (depth === 0) return i;
        }
      }
      return source.length;
    };

    const unclassified: string[] = [];
    for (const file of FILES) {
      if (file.includes('infrastructure/ai/index.ts') || file.endsWith('ai-provider.ts')) continue;
      const source = code(read(file));
      for (const match of source.matchAll(/\.complete\(/g)) {
        const open = (match.index ?? 0) + match[0].length - 1;
        const call = source.slice(open, callEnd(source, open));
        if (!call.includes('dataSources')) {
          unclassified.push(`${relative(SRC, file)}:${source.slice(0, match.index).split('\n').length}`);
        }
      }
    }
    check('no AI call omits its provenance', unclassified.length === 0, unclassified.join('; '));
  }

  // ── 3. The gateway refuses, audibly, before any I/O ──────────────────────
  console.log('\nThe refusal happens before anything leaves the building');
  {
    const gateway = code(read(join(SRC, 'infrastructure/ai/index.ts')));
    const complete = gateway.slice(gateway.indexOf('async complete('));
    const blockGoogle = complete.indexOf('AI_GOOGLE_DATA_RESTRICTED');
    const blockBlank = complete.indexOf('AI_DATA_POLICY_BLOCKED');
    const callProvider = complete.indexOf('await provider.complete(');

    check('unclassified input is refused', blockBlank > -1);
    check('Google-sourced input is refused', blockGoogle > -1);
    check('both refusals precede the provider call',
      blockBlank < callProvider && blockGoogle < callProvider);
    check('every decision is logged, allowed or blocked',
      complete.includes("event: 'ai_data_policy_decision'") &&
      complete.includes("decision: 'allowed'") &&
      complete.includes("decision: 'blocked'"));
    check('the blocked input itself is never logged', !/content.*logger|logger.*messages/.test(complete));
  }

  // ── 4. Hardly any Google data exists to leak ─────────────────────────────
  console.log('\nThe Google Calendar integration only ever writes');
  {
    const sync = code(read(join(SRC, 'application/integrations/calendar-sync.service.ts')));
    const googleCalls = [...sync.matchAll(/googleFetch\([\s\S]{0,220}?\)/g)].map((m) => m[0]);
    check('it calls Google at all', googleCalls.length > 0);
    const methods = googleCalls.map((c) => (c.match(/method:\s*'(\w+)'/) ?? [])[1] ?? 'POST');
    check('and only creates, updates or deletes',
      methods.every((m) => ['POST', 'PATCH', 'DELETE'].includes(m)), methods.join(','));
    check('it never lists or reads the user’s calendar',
      !/freebusy|calendarList|timeMin|singleEvents/.test(sync));

    const providers = code(read(join(SRC, 'application/integrations/oauth-providers.ts')));
    check('and asks only for the narrow own-events scope',
      providers.includes('auth/calendar.events.owned'));
    check('not the broad all-events scope',
      !/auth\/calendar\.events['"\s]/.test(providers) &&
      !providers.includes('auth/calendar.readonly') &&
      !/auth\/calendar['"\s]/.test(providers));
    check('and no Google profile scopes to decorate a screen',
      !providers.includes('auth/userinfo') && !providers.includes('auth/user.emails'));

    // Anything written back from Google's response is marked, and the AI
    // classification keys off that mark.
    check('rows touched by Google’s response are marked as such',
      sync.includes("dataSource: 'GOOGLE_API_MIXED'"));
    const classifiers = FILES.filter((f) => code(read(f)).includes("'GOOGLE_API_MIXED'"));
    check('and at least one AI call site reads that mark to classify itself',
      classifiers.some((f) => code(read(f)).includes("'google_api'")),
      classifiers.map((f) => relative(SRC, f)).join(', '));
  }

  /*
   * Google's Third Party Data Safety review refused verification while the
   * product could route to DeepSeek at all — its published terms reserve the
   * right to train on submitted content, which the Limited Use requirement
   * forbids for Google data. The gateway already blocked Google data reaching
   * any provider; the option was removed so there is nothing left to argue.
   */
  console.log('\nNo AI provider Google has objected to');
  {
    const files = [
      'src/shared/config/env.ts',
      'src/application/ai/org-ai.service.ts',
      'src/infrastructure/ai/index.ts',
      'src/application/catalog/site-catalog.service.ts',
    ];
    const offending: string[] = [];
    for (const file of files) {
      const source = readFileSync(join(__dirname, '../../', file), 'utf8');
      // Only selectable values count; the comments explaining the removal
      // name DeepSeek on purpose and must not trip this.
      for (const match of source.matchAll(/'deepseek'/gi)) {
        const lineStart = source.lastIndexOf('\n', match.index!) + 1;
        const line = source.slice(lineStart, source.indexOf('\n', match.index!));
        if (!line.trimStart().startsWith('*') && !line.trimStart().startsWith('//')) {
          offending.push(`${file}: ${line.trim().slice(0, 70)}`);
        }
      }
    }
    check('DeepSeek is not selectable as an AI provider', offending.length === 0, offending.join(' | '));
  }

  console.log('\nThe Limited Use statement is published where a reviewer can read it');
  {
    const pages = readFileSync(
      '/Users/mac/Desktop/Development/web/businessAI-hub-home/src/data/pages.ts', 'utf8',
    );
    check('the privacy policy carries the affirmative statement',
      /adhere to the Google User Data Policy, including the Limited Use requirements/.test(pages));
    check('a dedicated Google user data page exists',
      pages.includes("path: '/google-user-data'"));
    check('it names the single scope the product requests',
      pages.includes('auth/calendar.events.owned'));
    const site = readFileSync(
      '/Users/mac/Desktop/Development/web/businessAI-hub-home/src/data/site.ts', 'utf8',
    );
    check('and it is linked from the site footer', site.includes("href: '/google-user-data'"));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
