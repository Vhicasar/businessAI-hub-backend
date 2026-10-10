import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { isLegacyAutoCreatedShell, pageSeoSchema, updateWebsitePageSchema } from '../../src/application/sites/site-builder.service';
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
