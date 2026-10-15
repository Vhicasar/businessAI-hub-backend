/*
 * Maps providers and delivery services, end to end, against a real database.
 *
 * The unit tests cover the decisions. What this covers is the wiring: that a
 * provider configured centrally reaches the thing that geocodes, that one
 * business's courier account cannot be seen by another, and that the public
 * checkout endpoint cannot be turned into a way to read a business's customer
 * addresses.
 *
 *   npx tsx tests/warehouse/maps-delivery-verify.ts
 */
import { prismaUnscoped as db } from '../../src/infrastructure/database/prisma';
import { requestContext } from '../../src/shared/context';
import { setMapsRuntime, clearMapsCache, resetUsage } from '../../src/infrastructure/maps/registry';
import { applyEnvironmentFallback } from '../../src/application/maps/maps-config-sync';
import { suggest } from '../../src/application/maps/address-suggest.service';
import {
  autocompleteAvailable,
  geocodingAvailable,
  routingAvailable,
  mapDisplayConfig,
  mapsHealth,
} from '../../src/application/maps/maps.service';
import { setDeliveryServices, selectableDeliveryServices } from '../../src/application/delivery/delivery-config-sync';
import {
  connectCarrier,
  carrierConnection,
  carrierCredentialFor,
  disconnectCarrier,
} from '../../src/application/delivery/carrier-credentials.service';
import { mapsConfigured } from '../../src/application/delivery/geo.service';

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

const stamp = Date.now();
const ids = { orgA: '', orgB: '', customerA: '' };

const as = <T>(org: string, fn: () => Promise<T>): Promise<T> =>
  requestContext.run({ requestId: `t-${stamp}`, organizationId: org } as never, fn);

/** A provider list shaped exactly as the admin's service endpoint sends it. */
const adminShapedRuntime = () => ({
  providers: [
    {
      provider: 'photon',
      baseUrl: 'https://photon.example.test',
      apiKey: null,
      publicToken: null,
      capabilities: ['autocomplete', 'geocode', 'reverse_geocode'] as never,
      options: {},
      timeoutMs: 1000,
      rateLimitPerMinute: 0,
      cacheTtlSeconds: 0,
      monthlyRequestLimit: 0,
      priority: 10,
      attribution: '© OpenStreetMap contributors',
    },
    {
      provider: 'osrm',
      baseUrl: 'https://osrm.example.test',
      apiKey: null,
      publicToken: null,
      capabilities: ['route_distance'] as never,
      options: {},
      timeoutMs: 1000,
      rateLimitPerMinute: 0,
      cacheTtlSeconds: 0,
      monthlyRequestLimit: 0,
      priority: 10,
      attribution: '© OpenStreetMap contributors',
    },
    {
      provider: 'mapbox',
      baseUrl: 'https://api.mapbox.test',
      apiKey: 'secret-server-key',
      publicToken: 'pk.public-browser-token',
      capabilities: ['map_tiles', 'autocomplete'] as never,
      options: {},
      timeoutMs: 1000,
      rateLimitPerMinute: 0,
      cacheTtlSeconds: 0,
      monthlyRequestLimit: 0,
      priority: 50,
      attribution: '© Mapbox © OpenStreetMap',
    },
  ],
  order: { autocomplete: ['photon'], route_distance: ['osrm'] } as Record<string, string[]>,
});

async function main(): Promise<void> {
  const mkOrg = async (name: string) =>
    (await db.organization.create({
      data: { name, slug: `${name}-${stamp}`, currency: 'NGN', country: 'NG', status: 'ACTIVE' },
    })).id;
  ids.orgA = await mkOrg('mapsco');
  ids.orgB = await mkOrg('rivalco');
  ids.customerA = (await db.customer.create({
    data: { organizationId: ids.orgA, firstName: 'Adaeze', lastName: 'Okonkwo' },
  })).id;
  await db.customerAddress.create({
    data: {
      customerId: ids.customerA,
      addressLine1: '7 Saved Street',
      city: 'Ikeja',
      state: 'Lagos',
      country: 'NG',
      latitude: 6.6018,
      longitude: 3.3515,
    },
  });

  // ── 1. What a configured platform looks like to the product ─────────────
  console.log('\nProviders configured centrally reach the product');
  {
    setMapsRuntime(null);
    check('nothing is claimed when nothing is configured',
      !autocompleteAvailable() && !geocodingAvailable() && !routingAvailable());
    check('and the geocoding façade agrees', !mapsConfigured());

    setMapsRuntime(adminShapedRuntime() as never);
    check('autocomplete becomes available', autocompleteAvailable());
    check('routing becomes available', routingAvailable());
    check('geocoding becomes available', geocodingAvailable());
    const health = mapsHealth();
    check('the health view lists what was configured', health.providers.length === 3);
    check('and which provider leads each job', health.capabilities.autocomplete?.[0] === 'photon');
  }

  // ── 2. The browser only ever gets the public token ──────────────────────
  console.log('\nThe browser gets the public token and never the server key');
  {
    const display = mapDisplayConfig();
    check('a map token is offered', display?.token === 'pk.public-browser-token');
    check('the server key is nowhere in it',
      JSON.stringify(display).includes('secret-server-key') === false);
    check('and the attribution travels with it', Boolean(display?.attribution));
  }

  // ── 3. Suggestions, and what "verified" means ───────────────────────────
  console.log('\nSuggestions come from the business’s own records first');
  {
    // No network in this harness, so the provider half fails and the saved
    // half must still work — which is the fallback behaviour under test.
    const result = await suggest({ organizationId: ids.orgA, query: 'Saved Street' });
    check('a previously-used address is offered', result.suggestions.some((s) => s.source === 'saved'));
    const saved = result.suggestions.find((s) => s.source === 'saved')!;
    check('it is marked as verified only because it was geocoded when saved', saved.verified === true);
    check('and carries the point that was stored with it', saved.coordinates?.latitude === 6.6018);
    check('a provider outage does not empty the field', result.suggestions.length > 0);

    const other = await suggest({ organizationId: ids.orgB, query: 'Saved Street' });
    check('another business sees none of it', other.suggestions.length === 0);

    const publicView = await suggest({ organizationId: ids.orgA, query: 'Saved Street', includeSaved: false });
    check('and a public checkout cannot read the address book either',
      publicView.suggestions.every((s) => s.source !== 'saved'));
  }

  // ── 4. An unverified address stays unverified ───────────────────────────
  console.log('\nTyped text is never promoted to a verified address');
  {
    await db.customerAddress.create({
      data: {
        customerId: ids.customerA,
        addressLine1: '9 Unplaced Road',
        city: 'Ikeja',
        country: 'NG',
      },
    });
    const result = await suggest({ organizationId: ids.orgA, query: 'Unplaced' });
    const hit = result.suggestions.find((s) => s.formatted.includes('Unplaced'));
    check('an address saved without a point is offered', Boolean(hit));
    check('but is not called verified', hit?.verified === false);
    check('and carries no coordinates to price from', hit?.coordinates === null);
  }

  // ── 5. Short input never reaches a provider ─────────────────────────────
  console.log('\nTwo characters never become a billable request');
  {
    const result = await suggest({ organizationId: ids.orgA, query: 'ik' });
    check('nothing is looked up', result.suggestions.length === 0);
    check('and no error is invented either', result.error === null);
  }

  // ── 6. What a business may be offered ───────────────────────────────────
  console.log('\nBusinesses are only offered what the platform permits');
  {
    setDeliveryServices(null);
    const base = selectableDeliveryServices('NG').map((s) => s.provider);
    check('collection survives an admin outage', base.includes('pickup'));
    check('so does the business delivering it itself', base.includes('manual'));

    setDeliveryServices([
      {
        provider: 'http_carrier', label: 'Swift', capabilities: ['rate_quote'], countries: ['NG'],
        baseUrl: null, apiKey: 'platform-key', options: {}, allowBusinessCredentials: true,
        allowPlatformCredentials: true, businessSelectable: true, supportsBusinessCredentials: true,
      },
      {
        provider: 'shippo', label: 'Shippo', capabilities: ['rate_quote'], countries: [],
        baseUrl: null, apiKey: null, options: {}, allowBusinessCredentials: true,
        allowPlatformCredentials: true, businessSelectable: false, supportsBusinessCredentials: true,
      },
    ]);
    const offered = selectableDeliveryServices('NG').map((s) => s.provider);
    check('a permitted courier appears', offered.includes('http_carrier'));
    check('one the platform withheld does not', !offered.includes('shippo'));
    check('and a different country does not see the NG-only one',
      !selectableDeliveryServices('GB').map((s) => s.provider).includes('http_carrier'));
  }

  // ── 7. A business's own courier account ─────────────────────────────────
  console.log('\nA business’s own courier account stays its own');
  {
    await as(ids.orgA, () => connectCarrier({ provider: 'http_carrier', apiKey: 'org-a-secret' }));
    const connection = await as(ids.orgA, () => carrierConnection('http_carrier'));
    check('it is recorded as connected', connection.connected && connection.hasApiKey);
    check('and the secret itself is never returned',
      JSON.stringify(connection).includes('org-a-secret') === false);

    const theirs = await as(ids.orgB, () => carrierConnection('http_carrier'));
    check('another business sees no connection at all', theirs.connected === false);

    const mine = await carrierCredentialFor(ids.orgA, 'http_carrier');
    const not = await carrierCredentialFor(ids.orgB, 'http_carrier');
    check('the stored credential belongs to the business that saved it', Boolean(mine.apiKeyEnc));
    check('and is invisible to the other', not.apiKeyEnc === null);

    let refused = false;
    setDeliveryServices([
      {
        provider: 'http_carrier', label: 'Swift', capabilities: ['rate_quote'], countries: [],
        baseUrl: null, apiKey: null, options: {}, allowBusinessCredentials: false,
        allowPlatformCredentials: true, businessSelectable: true, supportsBusinessCredentials: true,
      },
    ]);
    try {
      await as(ids.orgB, () => connectCarrier({ provider: 'http_carrier', apiKey: 'nope' }));
    } catch {
      refused = true;
    }
    check('a business cannot connect an account the platform forbade', refused);

    let unknown = false;
    try {
      await as(ids.orgA, () => connectCarrier({ provider: 'not-a-service', apiKey: 'x' }));
    } catch {
      unknown = true;
    }
    check('nor one that does not exist', unknown);

    await as(ids.orgA, () => disconnectCarrier('http_carrier'));
    check('disconnecting removes it',
      (await as(ids.orgA, () => carrierConnection('http_carrier'))).connected === false);
  }

  // ── 8. Falling back to this deployment's own settings ───────────────────
  console.log('\nAn unconfigured platform falls back to the deployment');
  {
    setMapsRuntime(null);
    applyEnvironmentFallback();
    const health = mapsHealth();
    // This test environment has no MAPS_* set, so the honest answer is none —
    // and the product says so rather than reaching for a public endpoint whose
    // usage policy forbids this.
    check('nothing is invented when the environment is empty', health.providers.length === 0);
    check('and no capability claims to work', !autocompleteAvailable());
  }

  await cleanup();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

async function cleanup(): Promise<void> {
  clearMapsCache();
  resetUsage();
  setMapsRuntime(null);
  setDeliveryServices(null);
  for (const organizationId of [ids.orgA, ids.orgB].filter(Boolean)) {
    await db.integrationCredential.deleteMany({ where: { organizationId } }).catch(() => {});
    await db.customerAddress.deleteMany({ where: { customer: { organizationId } } }).catch(() => {});
    await db.customer.deleteMany({ where: { organizationId } }).catch(() => {});
    await db.organization.delete({ where: { id: organizationId } }).catch(() => {});
  }
}

main().catch(async (err) => {
  console.error(err);
  await cleanup();
  process.exit(1);
});
