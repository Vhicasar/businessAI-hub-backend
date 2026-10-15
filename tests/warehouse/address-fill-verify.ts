/*
 * Choosing an address must fill the whole form.
 *
 * Three separate bugs made it fill only part of one, and all three were the
 * same shape: state written twice in a tick from a value captured at render,
 * so the last write won and the rest vanished. The symptom was a street line
 * and a pair of coordinates landing while the city, state and postcode did
 * not — which looks like a provider fault and is not one.
 *
 * These are source assertions rather than behaviour, because the web app has
 * no test runner. They are here to make the mistake hard to repeat.
 *
 *   npx tsx tests/warehouse/address-fill-verify.ts
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

const WEB = join(__dirname, '../../../web/src');
const read = (relative: string): string => {
  const path = join(WEB, relative);
  if (!existsSync(path)) throw new Error(`missing: ${relative}`);
  return readFileSync(path, 'utf8');
};

/** Strip comments, so prose about a mistake is not read as the mistake. */
const code = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function main(): void {
  console.log('\nThe shared field hands back one patch, not a call per field');
  {
    const field = code(read('components/address/FlatAddressField.tsx'));
    check('it exposes a single onChange', /onChange:\s*\(patch/.test(field));
    check('and no per-field callback to race with itself', !field.includes('onFieldChange'));
    check('every part is collected before anything is told about it',
      field.includes('onChange(patch)') && (field.match(/onChange\(/g) ?? []).length === 1);
    check('coordinates are reported separately, on purpose',
      field.includes('onCoordinates?.(next.coordinates)'));
  }

  console.log('\nEvery form applies that patch without losing half of it');
  {
    const callers: [string, string][] = [
      ['components/AddressFields.tsx', 'the shared address block'],
      ['features/branches/BranchesPage.tsx', 'branches'],
      ['features/inventory/WarehousesPage.tsx', 'warehouses'],
      ['features/customers/CustomerDetailPage.tsx', 'customer addresses'],
      ['features/settings/OrganizationSettingsPage.tsx', 'the organisation profile'],
    ];
    for (const [file, label] of callers) {
      const source = code(read(file));
      const usesField = source.includes('<FlatAddressField');
      if (!usesField) {
        check(`${label} still uses the shared field`, false, `${file} no longer renders it`);
        continue;
      }
      // Either a functional state update, or a single spread into one object.
      const handler = source.match(/onChange=\{\(patch\)[^\n]*\n?[^\n]*/)?.[0] ?? '';
      const safe =
        /\(\s*\w+\s*\)\s*=>\s*\(?\s*\{?\s*\.\.\.\s*\w+\s*,\s*\.\.\.patch/.test(handler) ||
        /set\w*\(\s*patch\b/.test(handler) ||
        /\.\.\.patch/.test(handler);
      check(`${label} applies the whole patch at once`, safe, handler.trim().slice(0, 80));
    }
  }

  console.log('\nThe fulfilment settings write state from state, not from a snapshot');
  {
    const card = code(read('features/settings/FulfilmentSettingsCard.tsx'));
    /*
     * This is the one that produced the reported fault: the address and the
     * coordinates arrive as two updates in one tick, and a spread of the
     * rendered `form` in the second discarded the first.
     */
    check('setPickup starts from current state', /setPickup\s*=[\s\S]{0,200}?setForm\(\(current\)/.test(card));
    check('setDelivery too', /setDelivery\s*=[\s\S]{0,200}?setForm\(\(current\)/.test(card));
    check('and setPricing', /setPricing\s*=[\s\S]{0,260}?setForm\(\(current\)/.test(card));
    check('none of them spread the rendered form', !/setForm\(\s*\{\s*\.\.\.form/.test(card));
  }

  console.log('\nThe autocomplete actually searches what is typed');
  {
    const auto = code(read('components/address/AddressAutocomplete.tsx'));
    /*
     * The guard used to be `query === value.formatted`, which reads as "do not
     * re-search what we already have" and was in fact "never search": every
     * form echoes the typed text back into the value as it is typed, so the
     * two were always equal.
     */
    check('it does not skip the search whenever the box matches the value',
      !/query\s*===\s*value\.formatted/.test(auto));
    check('a selection is what suppresses the next search', auto.includes('justChose.current'));
    check('short input still costs nothing', auto.includes('query.length < MIN_QUERY'));
    check('and typing is debounced', auto.includes('DEBOUNCE_MS'));
  }

  console.log('\nA place id goes back to the provider that issued it');
  {
    const auto = code(read('components/address/AddressAutocomplete.tsx'));
    const api = code(read('components/address/addressApi.ts'));
    check('the component sends the issuer with the id',
      auto.includes('lookup.resolve(suggestion.placeId, suggestion.provider)'));
    check('both transports carry it', (api.match(/provider\s*\?\s*`&provider=/g) ?? []).length === 2);
  }

  console.log('\nThe checkout shows the street, with the rest in their own boxes');
  {
    const pay = code(read('features/payments/PayPage.tsx'));
    check('the box is fed the street line', /formatted:\s*draft\.address\.line1/.test(pay));
    check('and the parts are spread across the sibling fields',
      pay.includes('next.address.city ?? draft.address.city'));
    check('the resolved point is sent as a hint only',
      pay.includes('latitude: draft.resolved.coordinates?.latitude ?? null'));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
