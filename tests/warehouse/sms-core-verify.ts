/*
 * The two things the rest of the SMS module has to get right before anything
 * else matters: what a message costs, and who it reaches.
 *
 * Both were wrong before. Cost was quoted per recipient with no regard for
 * message length, so a 200-character campaign to 250 people was billed as 250
 * messages and charged by the network as 500. And nothing normalised phone
 * numbers, so the same customer written five ways in a spreadsheet was five
 * recipients and five charges.
 */
import { segmentsFor, totalSegments } from '../../src/application/sms/sms-segments';
import { normalizePhone, resolveRecipients } from '../../src/application/sms/phone-numbers';

let passed = 0, failed = 0;
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { passed++; console.log(`  ✓ ${n}`); }
  else { failed++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`); }
};

function main() {
  // ── Segments: the plain case ─────────────────────────────────────────────
  console.log('\nA plain message is charged by length, not by count');
  {
    check('a short message is one segment', segmentsFor('Hello').segments === 1);
    check('exactly 160 characters is still one', segmentsFor('a'.repeat(160)).segments === 1);
    check('161 becomes two', segmentsFor('a'.repeat(161)).segments === 2,
      'this is the boundary the old quote ignored');
    check('306 is two', segmentsFor('a'.repeat(306)).segments === 2,
      'a multi-part message carries 153 each, not 160');
    check('307 is three', segmentsFor('a'.repeat(307)).segments === 3);
    check('an empty message still counts as one', segmentsFor('').segments === 1);
  }

  // ── Segments: unicode ────────────────────────────────────────────────────
  console.log('\nOne emoji changes the price of the whole message');
  {
    const plain = segmentsFor('a'.repeat(80));
    check('80 plain characters is one segment', plain.segments === 1);
    check('and reads as GSM-7', plain.encoding === 'GSM_7BIT');

    const withEmoji = segmentsFor(`${'a'.repeat(80)}🎉`);
    check('the same message with an emoji is two', withEmoji.segments === 2,
      'UCS-2 drops the limit from 160 to 70');
    check('and it says so', withEmoji.encoding === 'UCS2');
    check('naming the character that did it', withEmoji.forcedUnicodeBy === '🎉',
      'an invisible curly quote can double a bill; the sender should be told which one');

    // The one that actually catches people out.
    const curly = segmentsFor(`${'a'.repeat(80)}’`);
    check('a curly apostrophe pasted from Word does it too', curly.encoding === 'UCS2');
    // é is a GSM-7 character, so it does NOT force unicode — worth pinning,
    // because assuming every accent is unicode over-quotes every French or
    // Yoruba message.
    check('an accented GSM-7 character stays GSM-7',
      segmentsFor('é'.repeat(100)).encoding === 'GSM_7BIT');
    check('exactly 70 genuinely-unicode characters is one',
      segmentsFor('你'.repeat(70)).segments === 1);
    check('71 is two', segmentsFor('你'.repeat(71)).segments === 2);
  }

  // ── Segments: GSM-7 extended ─────────────────────────────────────────────
  console.log('\nSome GSM-7 characters quietly cost two');
  {
    check('a euro sign is two septets', segmentsFor('€').length === 2);
    check('so 80 of them fill a segment', segmentsFor('€'.repeat(80)).segments === 1);
    check('and 81 spill over', segmentsFor('€'.repeat(81)).segments === 2);
    check('square brackets too', segmentsFor('[]').length === 4);
  }

  // ── Segments: per recipient ──────────────────────────────────────────────
  console.log('\nSegments are counted per recipient, after variables resolve');
  {
    // Sized to straddle the 160 boundary: 157 against 166.
    const short = `Hi Bo, ${'x'.repeat(150)}`;
    const long = `Hi Chukwuemeka, ${'x'.repeat(150)}`;
    check('a short name fits one segment', segmentsFor(short).segments === 1);
    check('a longer name tips the same message into two', segmentsFor(long).segments === 2,
      'billing everyone at the shortest name would under-charge');
    check('the total adds them honestly', totalSegments([short, long]) === 3);
  }

  // ── Phone numbers ────────────────────────────────────────────────────────
  console.log('\nEvery way a Nigerian number gets typed is the same number');
  {
    const expected = '+2348030000001';
    for (const [label, input] of [
      ['local with leading zero', '08030000001'],
      ['without the zero', '8030000001'],
      ['international', '+2348030000001'],
      ['international without plus', '2348030000001'],
      ['with spaces', '+234 803 000 0001'],
      ['with dashes', '0803-000-0001'],
      ['with brackets', '(0803) 000 0001'],
      ['with a 00 prefix', '002348030000001'],
    ] as const) {
      check(`${label} → ${expected}`, normalizePhone(input).e164 === expected,
        normalizePhone(input).e164 ?? 'rejected');
    }
  }

  console.log('\nWhat cannot be sent is rejected, not guessed at');
  {
    check('too short is refused', normalizePhone('0803').e164 === null);
    check('with a reason worth reading', /short/i.test(normalizePhone('0803').reason ?? ''));
    check('letters are refused', normalizePhone('not a number').e164 === null);
    check('an empty string is refused', normalizePhone('').e164 === null);
    check('another country is kept as given',
      normalizePhone('+447700900123').e164 === '+447700900123',
      'not bent into a Nigerian shape');
  }

  // ── Deduplication ────────────────────────────────────────────────────────
  console.log('\nOne customer is charged once');
  {
    const result = resolveRecipients([
      { phone: '08030000001', source: 'customer-record' },
      { phone: '+234 803 000 0001', source: 'typed-by-hand' },
      { phone: '2348030000001', source: 'csv-import' },
      { phone: '08030000002', source: 'another-person' },
      { phone: '0803', source: 'broken-row' },
    ]);
    check('three spellings collapse to one recipient', result.accepted.length === 2,
      `got ${result.accepted.length}`);
    check('and the duplicates are counted, not hidden', result.duplicates === 2,
      'so the screen can explain why 5 rows became 2');
    check('the first source wins', result.accepted[0]?.source === 'customer-record',
      'the customer record carries the variables a typed number does not');
    check('the broken row is reported', result.rejected.length === 1);
    check('with the original text to show', result.rejected[0]?.raw === '0803');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
