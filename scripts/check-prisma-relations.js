#!/usr/bin/env node
/**
 * Offline Prisma schema consistency checker.
 * Verifies: relation targets exist, FK/reference fields exist, every relation
 * has a matching back-relation, self-relations have both sides, and duplicate
 * relations between the same model pair are explicitly named.
 *
 * Usage: node scripts/check-prisma-relations.js [path/to/schema.prisma]
 */
const fs = require('fs');
const path = require('path');

const schemaPath =
  process.argv[2] || path.join(__dirname, '..', 'prisma', 'schema.prisma');
const src = fs.readFileSync(schemaPath, 'utf8');
const lines = src.split('\n').map((l) => l.replace(/\/\/.*$/, ''));

const models = {};
const enums = new Set();
let cur = null;
let kind = null;
for (const l of lines) {
  const m = l.match(/^\s*(model|enum)\s+(\w+)\s*\{/);
  if (m) {
    kind = m[1];
    cur = m[2];
    if (kind === 'model') models[cur] = { fields: [] };
    else enums.add(cur);
    continue;
  }
  if (/^\s*\}/.test(l)) {
    cur = null;
    kind = null;
    continue;
  }
  if (cur && kind === 'model') {
    const f = l.match(/^\s*(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/);
    if (f && !f[1].startsWith('@'))
      models[cur].fields.push({ name: f[1], type: f[2], attrs: f[5] || '' });
  }
}

const scalar = new Set(['String', 'Int', 'BigInt', 'Float', 'Decimal', 'Boolean', 'DateTime', 'Json', 'Bytes']);
const errs = [];
const edges = [];

for (const [mn, m] of Object.entries(models)) {
  for (const f of m.fields) {
    if (scalar.has(f.type) || enums.has(f.type)) continue;
    if (!models[f.type]) {
      errs.push(`${mn}.${f.name}: unknown type ${f.type}`);
      continue;
    }
    const rel = f.attrs.match(/@relation\(\s*(?:"([^"]+)")?/);
    const relName = rel && rel[1] ? rel[1] : null;
    const hasFields = /fields:/.test(f.attrs);
    edges.push({ from: mn, fieldName: f.name, to: f.type, relName, hasFields });
    const fm = f.attrs.match(/fields:\s*\[([^\]]*)\]/);
    if (fm)
      for (const fk of fm[1].split(',').map((s) => s.trim()).filter(Boolean))
        if (!m.fields.find((x) => x.name === fk))
          errs.push(`${mn}.${f.name}: fk field '${fk}' not found on ${mn}`);
    const rm = f.attrs.match(/references:\s*\[([^\]]*)\]/);
    if (rm)
      for (const rf of rm[1].split(',').map((s) => s.trim()).filter(Boolean))
        if (!models[f.type].fields.find((x) => x.name === rf))
          errs.push(`${mn}.${f.name}: referenced field '${rf}' not found on ${f.type}`);
  }
}

for (const e of edges) {
  if (e.from === e.to) {
    const self = edges.filter(
      (x) => x.from === e.from && x.to === e.to && (x.relName || null) === (e.relName || null)
    );
    if (self.length !== 2)
      errs.push(`self-relation ${e.from}.${e.fieldName} ('${e.relName}'): found ${self.length} sides, need 2`);
    continue;
  }
  const back = edges.filter(
    (x) => x.from === e.to && x.to === e.from && (x.relName || null) === (e.relName || null) && x !== e
  );
  if (back.length === 0)
    errs.push(`missing back-relation: ${e.from}.${e.fieldName} -> ${e.to} (relation '${e.relName || 'default'}')`);
  if (back.length > 1)
    errs.push(
      `ambiguous back-relation: ${e.from}.${e.fieldName} -> ${e.to} matches: ${back.map((b) => b.fieldName).join(', ')}`
    );
}

const pairKey = {};
for (const e of edges.filter((x) => x.hasFields)) {
  const k = `${e.from}->${e.to}:${e.relName || 'default'}`;
  pairKey[k] = (pairKey[k] || 0) + 1;
  if (pairKey[k] > 1) errs.push(`duplicate relation (needs explicit names): ${k}`);
}

console.log(`models: ${Object.keys(models).length}, enums: ${enums.size}, relation edges: ${edges.length}`);
const unique = [...new Set(errs)];
if (unique.length) {
  console.log('ERRORS:');
  unique.forEach((e) => console.log(' -', e));
  process.exit(1);
}
console.log('OK: relations consistent');
