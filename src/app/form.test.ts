import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSpec, PRESETS, type PartialSpec } from '../core/spec.ts';
import { getPath, parseValue, setPath, typologyLabel } from './form.ts';
import { TYPOLOGIES } from '../core/typologies.ts';

test('setPath creates nested objects, getPath reads them back', () => {
  const o: Record<string, unknown> = {};
  setPath(o, 'site.setbacks.front', 4.5);
  setPath(o, 'massing.storeys', 6);
  assert.equal(getPath(o, 'site.setbacks.front'), 4.5);
  assert.equal(getPath(o, 'massing.storeys'), 6);
  assert.equal(getPath(o, 'massing.nope.deep'), undefined);
});

test('setPath with undefined deletes the override', () => {
  const o: Record<string, unknown> = { site: { width: 40 } };
  setPath(o, 'site.width', undefined);
  assert.deepEqual(o, { site: {} });
});

test('parseValue converts display units to metres and handles blanks', () => {
  assert.equal(parseValue('len', '10', 'metric'), 10);
  assert.equal(parseValue('len', '32.808', 'imperial'), 10);
  assert.equal(parseValue('int', '6.4', 'metric'), 6);
  assert.equal(parseValue('num', '0.35', 'metric'), 0.35);
  assert.equal(parseValue('bool', 'true', 'metric'), true);
  assert.equal(parseValue('bool', 'false', 'metric'), false);
  assert.equal(parseValue('len', '', 'metric'), undefined);
  assert.equal(parseValue('num', 'abc', 'metric'), undefined);
  assert.equal(parseValue('str', 'flat', 'metric'), 'flat');
});

test('spec → form → spec round-trip keeps every edited field', () => {
  const spec: PartialSpec = JSON.parse(JSON.stringify(PRESETS[0].spec));
  // the edits a user would make through the form controls
  const edits: [string, string, 'len' | 'num' | 'int' | 'str' | 'bool'][] = [
    ['site.width', '262.467', 'len'],        // 80 m in feet
    ['site.setbacks.front', '19.685', 'len'], // 6 m
    ['site.maxFar', '3.5', 'num'],
    ['massing.storeys', '7', 'int'],
    ['massing.roof', 'flat', 'str'],
    ['options.mechanical', 'false', 'bool'],
    ['options.detail', 'low', 'str'],
    ['name', 'Edited Building', 'str'],
  ];
  for (const [path, raw, kind] of edits) {
    setPath(spec as unknown as Record<string, unknown>, path, parseValue(kind, raw, 'imperial'));
  }
  assert.ok(Math.abs((getPath(spec, 'site.width') as number) - 80) < 0.01);
  assert.ok(Math.abs((getPath(spec, 'site.setbacks.front') as number) - 6) < 0.01);

  const full = normalizeSpec(spec);
  assert.equal(full.massing.storeys, 7);
  assert.equal(full.options.mechanical, false);
  assert.equal(full.options.detail, 'low');
  assert.equal(full.name, 'Edited Building');
  assert.ok(Math.abs(full.site.width - 80) < 0.01);
  assert.equal(full.site.maxFar, 3.5);
  assert.equal(full.floors.length, 7);
  // per-floor override merges into the resolved floor list
  spec.floors = [{ index: 2, use: 'amenity', wwr: 0.5 }];
  const full2 = normalizeSpec(spec);
  const f2 = full2.floors.find((f) => f.index === 2)!;
  assert.equal(f2.use, 'amenity');
  assert.equal(f2.wwr, 0.5);
  assert.ok(typeof f2.floorToFloor === 'number');
  // untouched floors keep their generated use
  assert.equal(full2.floors.find((f) => f.index === 3)!.use, 'residential');
});

test('every preset normalises and every typology has a label', () => {
  for (const p of PRESETS) {
    const full = normalizeSpec(p.spec);
    assert.ok(full.floors.length > 0, `${p.id} floors`);
    assert.ok(full.site.width > 0 && full.site.depth > 0, `${p.id} site`);
    assert.ok(full.massing.footprintShape, `${p.id} shape`);
  }
  for (const t of Object.values(TYPOLOGIES)) {
    assert.ok(typologyLabel(t, 'UK').length > 0);
    assert.ok(typologyLabel(t, 'US').includes(t.name));
  }
});
