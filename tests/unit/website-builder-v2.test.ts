import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { isLegacyAutoCreatedShell, pageSeoSchema, pageSlug, updateWebsitePageSchema } from '../../src/application/sites/site-builder.service';
import {
  DEFAULT_NAVIGATION, DEFAULT_THEME_V2, SITE_SCHEMA_VERSION, blankHomepage, normalizeSections,
  siteNavigationSchema, siteSectionSchema, siteThemeSchema,
} from '../../src/application/sites/site-schema';

describe('Website Builder v2 structured schema', () => {
  it('does not count an untouched v1 auto-created shell as a real website', () => {
    expect(isLegacyAutoCreatedShell({
      theme: { primaryColor: '#f97316', font: 'Inter' },
      publishedAt: null,
      publishedSnapshot: null,
      subdomain: null,
      customDomain: null,
      pages: [{ blocks: [{ type: 'hero' }] }],
    })).toBe(true);
  });

  it('never treats published or v2 websites as disposable legacy shells', () => {
    const base = { publishedSnapshot: null, subdomain: null, customDomain: null, pages: [{ blocks: [] }] };
    expect(isLegacyAutoCreatedShell({ ...base, theme: { colors: {}, typography: {} }, publishedAt: null })).toBe(false);
    expect(isLegacyAutoCreatedShell({ ...base, theme: { primaryColor: '#f97316' }, publishedAt: new Date() })).toBe(false);
  });
  it('uses the new schema version and validates global design tokens', () => {
    expect(SITE_SCHEMA_VERSION).toBe(3);
    expect(siteThemeSchema.parse(DEFAULT_THEME_V2)).toEqual(DEFAULT_THEME_V2);
    expect(DEFAULT_THEME_V2.darkColors.background).not.toBe(DEFAULT_THEME_V2.colors.background);
    expect(DEFAULT_THEME_V2.allowVisitorSwitch).toBe(true);
  });

  it('creates a responsive, editable blank homepage', () => {
    const sections = blankHomepage('Vhicasar Test');
    expect(sections.map((section) => section.type)).toEqual(['hero', 'about', 'contact']);
    expect(sections.every((section) => section.id.startsWith('sec_'))).toBe(true);
    expect(sections.every((section) => siteSectionSchema.safeParse(section).success)).toBe(true);
  });

  it('supports dynamic business-data bindings without embedding records', () => {
    const result = siteSectionSchema.parse({
      id: 'sec_products', type: 'products', variant: 'editorial-grid', hidden: false,
      props: { heading: 'Latest products' },
      binding: { source: 'PRODUCTS', filter: { category: 'shoes' }, sort: 'NEWEST', limit: 8 },
      responsive: { desktop: { columns: 4 }, tablet: { columns: 2 }, mobile: { columns: 1 } },
      animation: 'reveal',
    });
    expect(result.binding?.source).toBe('PRODUCTS');
    expect(result.props).not.toHaveProperty('products');
  });

  it('rejects arbitrary code section types and strips invalid AI output', () => {
    expect(siteSectionSchema.safeParse({ id: 'x', type: 'script', props: { html: '<script />' } }).success).toBe(false);
    expect(normalizeSections([{ id: 'x', type: 'script', props: {} }])).toEqual([]);
  });

  it('constrains collections and responsive settings to safe limits', () => {
    expect(siteSectionSchema.safeParse({
      id: 'sec_bad', type: 'products', props: {}, hidden: false, variant: 'default', animation: 'none',
      binding: { source: 'PRODUCTS', filter: {}, sort: 'NEWEST', limit: 1000 }, responsive: {},
    }).success).toBe(false);
  });

  it('normalizes omitted or null page SEO and supports advanced metadata', () => {
    expect(updateWebsitePageSchema.parse({ seo: null }).seo).toEqual({ title: '', description: '', socialImageUrl: '', canonicalUrl: '', index: true });
    expect(pageSeoSchema.parse({ canonicalUrl: 'https://example.com/about', socialImageUrl: 'https://example.com/share.jpg', index: false }).index).toBe(false);
  });

  it('defaults every public organisation footer visibility control safely', () => {
    const navigation = siteNavigationSchema.parse(DEFAULT_NAVIGATION);
    expect(navigation.footer).toMatchObject({ useOrganizationData: true, showLogo: true, showAddress: true, showPhone: true, showEmail: true, showBusinessHours: true, showSocialLinks: true });
  });

  it('preserves the exact preview page through simulated form submission', () => {
    const renderer = readFileSync(new URL('../../src/application/sites/site-public.service.ts', import.meta.url), 'utf8');
    const routes = readFileSync(new URL('../../src/presentation/http/site-host.routes.ts', import.meta.url), 'utf8');
    expect(renderer).toContain('name="previewPath"');
    expect(routes).toContain('Back to preview');
    expect(routes).toContain("previewPath.split('/').map(encodeURIComponent)");
    expect(routes).not.toContain('history.back()');
  });

  it('uses canonical file URLs rather than constructing upload paths in the website renderer', () => {
    const renderer = readFileSync(new URL('../../src/application/sites/site-public.service.ts', import.meta.url), 'utf8');
    expect(renderer).toContain('filesService.urlFor');
    expect(renderer).not.toContain('function fileUrl');
  });

  it('ships every persisted public profile column in the Prisma migration', () => {
    const schema = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');
    const migration = readFileSync(new URL('../../prisma/migrations/20261001143000_public_business_profile/migration.sql', import.meta.url), 'utf8');
    for (const field of ['supportEmail', 'salesEmail', 'alternativePhone', 'whatsappNumber', 'socialLinks']) {
      expect(schema).toContain(field);
      expect(migration).toContain(`"${field}"`);
    }
  });
});

/*
 * The editor chrome is light, and says so in one place.
 *
 * It was converted from dark to light by a stylesheet that forces the new
 * colours with `!important`. That covered the panels and their buttons, but
 * not the selected page row — which kept its old dark background while the
 * stylesheet forced the text on top of it dark too, so the highlighted page
 * was an unreadable block. Every chrome colour now comes from BUILDER_TOKENS,
 * which is the only way the two halves cannot drift apart again.
 */
describe('website builder chrome colours', () => {
  const page = readFileSync(
    new URL('../../../web/src/features/website/WebsitePage.tsx', import.meta.url),
    'utf8',
  );

  it('keeps no colour from the old dark chrome', () => {
    const retired = [
      '#17181f', '#121319', '#25262d', '#22242c', // panel and canvas surfaces
      '#272932', '#30323b', '#2c2e37',            // borders
      '#2a2c35',                                  // the selected row
      '#8f92a0', '#9ca0ae', '#858897', '#6b6e79', // muted text
    ];
    const found = retired.filter((hex) => page.toLowerCase().includes(hex));
    expect(found).toEqual([]);
  });

  it('draws the selected page from the token the rest of the editor uses', () => {
    expect(page).toMatch(
      /bgcolor: activePage\.id === page\.id \? BUILDER_TOKENS\.selected : 'transparent'/,
    );
  });

  it('writes page names in the chrome text colour, not a hardcoded white', () => {
    const pagesPanel = page.slice(page.indexOf("{panel === 'pages' &&"), page.indexOf("{panel === 'sections' &&"));
    expect(pagesPanel).toMatch(/color: BUILDER_TOKENS\.text/);
    expect(pagesPanel).not.toMatch(/color: '#fff'/);
  });
});

/*
 * Reordering sections by dragging the layer list.
 *
 * The drag handle had been in that list since it was written with nothing
 * behind it — the row only selected a section, so the one affordance that says
 * "move me" did nothing at all.
 */
describe('layer reordering', () => {
  const page = readFileSync(
    new URL('../../../web/src/features/website/WebsitePage.tsx', import.meta.url),
    'utf8',
  );

  it('moves an item down, closing the gap behind it', async () => {
    const { moveItem } = await import('../../../web/src/features/website/reorder');
    expect(moveItem(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('moves an item up', async () => {
    const { moveItem } = await import('../../../web/src/features/website/reorder');
    expect(moveItem(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c']);
  });

  it('leaves the list alone for a move that goes nowhere or off the end', async () => {
    const { moveItem } = await import('../../../web/src/features/website/reorder');
    const items = ['a', 'b', 'c'];
    expect(moveItem(items, 1, 1)).toEqual(items);
    expect(moveItem(items, 0, 9)).toEqual(items);
    expect(moveItem(items, -1, 1)).toEqual(items);
    expect(moveItem(items, 0, 2)).not.toBe(items); // a copy, never the original
  });

  it('holds the dragged row in a ref, because state is not readable at drop', () => {
    const list = page.slice(page.indexOf('function LayerList'), page.indexOf('function EditorLeftPanel'));
    expect(list).toMatch(/const source = useRef<number \| null>\(null\)/);
    expect(list).toMatch(/const from = source\.current;/);
  });

  it('carries drag data, without which Firefox never starts the drag', () => {
    const list = page.slice(page.indexOf('function LayerList'), page.indexOf('function EditorLeftPanel'));
    expect(list).toMatch(/dataTransfer\.setData\(/);
    expect(list).toMatch(/draggable/);
  });

  it('offers the same move to a keyboard, which cannot drag at all', () => {
    const list = page.slice(page.indexOf('function LayerList'), page.indexOf('function EditorLeftPanel'));
    expect(list).toMatch(/event\.altKey/);
    expect(list).toMatch(/ArrowUp/);
    expect(list).toMatch(/ArrowDown/);
    expect(list).toMatch(/tabIndex=\{0\}/);
    expect(list).toMatch(/aria-label=/);
  });
});

/*
 * What a model actually returns, versus what the schema demands.
 *
 * `siteSectionSchema` is `.strict()`, which is right for an API client and
 * wrong for a model: one volunteered key, or a forgotten id, and the whole
 * section was discarded without a word. Enough of those and the business was
 * told "The AI did not return a valid editable website" with nothing in the
 * log to explain it.
 */
describe('AI section output is salvaged, not discarded', () => {
  it('keeps a section that volunteered an extra key, and keeps the content', async () => {
    const { coerceAiSections } = await import('../../src/application/sites/site-schema');
    const { sections } = coerceAiSections([
      { id: 'sec_a', type: 'hero', props: { headline: 'Hi' }, title: 'Hero band' },
    ]);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.props).toMatchObject({ headline: 'Hi', title: 'Hero band' });
  });

  it('mints an id when the model forgot one', async () => {
    const { coerceAiSections } = await import('../../src/application/sites/site-schema');
    const { sections } = coerceAiSections([{ type: 'features', props: {} }]);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.id).toMatch(/^sec_/);
  });

  it('folds content nested the obvious way into props rather than losing it', async () => {
    const { coerceAiSections } = await import('../../src/application/sites/site-schema');
    const { sections } = coerceAiSections([{ id: 'sec_c', type: 'about', content: { body: 'We bake at dawn.' } }]);
    expect(JSON.stringify(sections[0]!.props)).toContain('We bake at dawn');
  });

  it('still refuses a section type that cannot be rendered, and says why', async () => {
    const { coerceAiSections } = await import('../../src/application/sites/site-schema');
    const { sections, rejected } = coerceAiSections([{ id: 'sec_d', type: 'navbar', props: {} }]);
    expect(sections).toHaveLength(0);
    expect(rejected[0]?.reason).toMatch(/type/i);
  });

  it('leaves the strict schema strict for everyone else', async () => {
    const { normalizeSections } = await import('../../src/application/sites/site-schema');
    // An API client posting an unknown key should still be corrected, not
    // quietly accommodated — the tolerance is for model output only.
    expect(normalizeSections([{ id: 'sec_a', type: 'hero', props: {}, title: 'nope' }])).toHaveLength(0);
  });

  it('reports what it could not use instead of failing blank', async () => {
    const { coerceAiSections } = await import('../../src/application/sites/site-schema');
    const { rejected } = coerceAiSections('not an array');
    expect(rejected[0]?.reason).toBe('not an array');
  });
});

/*
 * The shapes a model volunteers for the two fields the prompt never described.
 *
 * gpt-5.4-mini answers `responsive: { mobile: "stack" }` and
 * `animation: { type: "none", delay: 0 }` — both reasonable readings of a
 * field list with no shape attached, both rejected by a strict schema, and
 * between them they rejected every section of every page.
 */
describe('presentation hints never cost a section', () => {
  const coerce = async () => (await import('../../src/application/sites/site-schema')).coerceAiSections;

  it('drops a responsive value given as a string', async () => {
    const { sections } = (await coerce())([
      { id: 'sec_a', type: 'hero', props: {}, responsive: { mobile: 'stack', tablet: 'columns', desktop: 'columns' } },
    ]);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.responsive).toEqual({});
  });

  it('keeps the breakpoint settings it can read and drops invented keys inside', async () => {
    const { sections } = (await coerce())([
      { id: 'sec_a', type: 'hero', props: {}, responsive: { mobile: { stack: true, columns: 1 }, nonsense: { columns: 2 } } },
    ]);
    expect(sections[0]!.responsive).toEqual({ mobile: { columns: 1 } });
  });

  it('unwraps an animation given as an object', async () => {
    const { sections } = (await coerce())([
      { id: 'sec_a', type: 'hero', props: {}, animation: { type: 'fade', delay: 0 } },
    ]);
    expect(sections[0]!.animation).toBe('fade');
  });

  it('matches a near-miss animation name rather than losing the section', async () => {
    const run = await coerce();
    expect(run([{ id: 'a', type: 'hero', props: {}, animation: 'fadeUp' }]).sections[0]!.animation).toBe('fade');
    expect(run([{ id: 'b', type: 'hero', props: {}, animation: 'slideUp' }]).sections[0]!.animation).toBe('slide-up');
    expect(run([{ id: 'c', type: 'hero', props: {}, animation: 'zoomIn' }]).sections[0]!.animation).toBe('scale');
  });

  it('falls back to the default for an animation it cannot place', async () => {
    const { sections } = (await coerce())([{ id: 'sec_a', type: 'hero', props: {}, animation: 'kaleidoscope' }]);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.animation).toBe('none');
  });

  it('reads a hidden flag sent as a string', async () => {
    const { sections } = (await coerce())([{ id: 'sec_a', type: 'hero', props: {}, hidden: 'true' }]);
    expect(sections[0]!.hidden).toBe(true);
  });
});

/*
 * The last step a build can fail at, after the model has already been paid
 * for: a page slug. Models write "/contact" and "Contact Us", and replacing
 * the bad characters one for one left "-contact", which fails validation.
 */
describe('page slugs from a model', () => {
  const slugOf = (raw: string) => pageSlug(raw, 0);

  it('survives the shapes a model writes', () => {
    expect(slugOf('/contact')).toBe('contact');
    expect(slugOf('Contact Us')).toBe('contact-us');
    expect(slugOf('contact-page/')).toBe('contact-page');
    expect(slugOf('  About   Us  ')).toBe('about-us');
  });

  it('matches what the service accepts', () => {
    const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
    for (const raw of ['/contact', 'Contact Us', 'contact-page/', 'Our Story!', '///', '']) {
      expect(SLUG.test(slugOf(raw))).toBe(true);
    }
  });

  it('falls back to a numbered page when nothing usable is left', () => {
    expect(pageSlug('///', 2)).toBe('page-3');
  });
});
