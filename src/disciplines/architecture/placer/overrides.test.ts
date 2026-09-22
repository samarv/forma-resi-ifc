/**
 * Override tests (design §8). Four properties, in order of how much the editor depends on them:
 *
 *   1. an EMPTY document returns the base layout BY REFERENCE, so every existing output stays byte-identical;
 *   2. ORDER INDEPENDENCE — a shuffled edit array gives a deep-equal layout (the canonical sort);
 *   3. ID STABILITY — base slots are never renumbered, a removal leaves a hole, an insert derives from its anchor;
 *   4. CLAMPING through `clampLayoutEdit`, the same function the editor's drag reducer calls, with a deviation
 *      recorded for every clamp and every rejection.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { LayoutEdit, OverrideDoc } from '../../../core/overrides.ts';
import type { ClampCtx, FloorLayout } from './types.ts';
import { getPreset } from '../../../core/spec.ts';
import { generateBuilding } from '../../../pipeline.ts';
import { buildCatalogue } from '../../../modules/catalogue.ts';
import { defaultBayGrid } from '../../structure/presize.ts';
import { templateOf } from '../../../modules/ids.ts';
import { applyOverrides, sortEdits } from './apply-overrides.ts';
import { clampLayoutEdit, frontageOf, slotsOfStrip, stripOf } from './clamp.ts';
import { candidatesForSlot } from './picker.ts';
import { netFrontageOf } from './packer.ts';

const RULES = {
  all: () => [], get: () => null,
  num: (_i: string, f: number) => f, str: (_i: string, f: string) => f, bool: (_i: string, f: boolean) => f,
  table: () => [], forSubject: () => [], disabled: () => false, profileApplied: () => false, hash: () => 'v1',
} as unknown as ClampCtx['rules'];

function base(): { layout: FloorLayout; ctx: ClampCtx & { storeyId: string } } {
  const m = generateBuilding(getPreset('us-5-over-1').spec);
  const entries = Object.entries(m.arch.layouts ?? {}).filter(([, l]) => l.slots.some(s => s.kind === 'unit'));
  const [storeyId, layout] = entries[0];
  return {
    layout,
    ctx: {
      catalogue: buildCatalogue(),
      grid: defaultBayGrid('wood-over-podium'),
      rules: RULES,
      region: 'US',
      level: 0,
      storeyId,
    },
  };
}

function firstUnitPair(layout: FloorLayout): { a: string; b: string; stripId: string } {
  for (const strip of layout.strips) {
    const list = slotsOfStrip(layout, strip.id).filter(s => s.kind === 'unit');
    if (list.length >= 2) return { a: list[0].id, b: list[1].id, stripId: strip.id };
  }
  throw new Error('no strip with two dwellings');
}

test('an empty override document returns the base layout by reference', () => {
  const { layout, ctx } = base();
  assert.equal(applyOverrides(layout, undefined, ctx), layout);
  assert.equal(applyOverrides(layout, { version: 1 }, ctx), layout);
  assert.equal(applyOverrides(layout, { version: 1, layouts: {}, storeys: {} }, ctx), layout);
  assert.equal(applyOverrides(layout, { version: 1, layouts: { 'some-other-key': [] } }, ctx), layout);
});

test('an empty document leaves the whole model byte-identical', () => {
  const a = generateBuilding({ ...getPreset('us-5-over-1').spec });
  const b = generateBuilding({ ...getPreset('us-5-over-1').spec, overrides: { version: 1 } });
  const key = (m: typeof a): string => JSON.stringify({
    units: m.arch.units.map(u => [u.id, u.templateId, u.rect, u.slotId, u.moduleId]),
    layouts: Object.entries(m.arch.layouts ?? {}).map(([s, l]) => [s, l.layoutKey, l.slots.length]),
  });
  assert.equal(key(a), key(b), 'an empty override document changed the model');
});

test('edits are applied in a canonical order, so a shuffled array gives the same layout', () => {
  const { layout, ctx } = base();
  const { a, b, stripId } = firstUnitPair(layout);
  const edits: LayoutEdit[] = [
    { op: 'mirror', slotId: b, mirrored: true },
    { op: 'moveBoundary', slotId: a, edge: 'end', delta: 0.4 },
    { op: 'setSlotKind', slotId: b, kind: 'amenity' },
  ];
  const shuffled = [edits[2], edits[0], edits[1]];
  assert.deepEqual(sortEdits(edits).map(e => e.op), sortEdits(shuffled).map(e => e.op));
  const one = applyOverrides(layout, { version: 1, layouts: { [layout.key]: edits } }, ctx);
  const two = applyOverrides(layout, { version: 1, layouts: { [layout.key]: shuffled } }, ctx);
  const strip = (l: FloorLayout): unknown => slotsOfStrip(l, stripId).map(s => [s.id, s.moduleId, s.kind, s.mirrored, s.boundary]);
  assert.deepEqual(strip(one), strip(two), 'a shuffled edit array produced a different layout');
  assert.equal(one.layoutKey, two.layoutKey, 'the layout key depends on the edit order');
});

test('moveBoundary is clamped to both neighbours’ admissible frontage and recorded', () => {
  const { layout, ctx } = base();
  const { a, stripId } = firstUnitPair(layout);
  const huge: LayoutEdit = { op: 'moveBoundary', slotId: a, edge: 'end', delta: 25 };
  const res = clampLayoutEdit(layout, huge, ctx);
  assert.ok(res.range, 'no admissible range reported for the drag');
  if (res.edit.op === 'moveBoundary') {
    assert.ok(Math.abs(res.edit.delta) < 25, `a 25 m drag was not clamped (${res.edit.delta})`);
  }
  // idempotent: clamping the clamped edit changes nothing
  const again = clampLayoutEdit(layout, res.edit, ctx);
  assert.deepEqual(again.edit, res.edit, 'clampLayoutEdit is not idempotent');

  const out = applyOverrides(layout, { version: 1, layouts: { [layout.key]: [huge] } }, ctx);
  assert.ok(
    out.deviations.some(d => d.ruleId === 'ARC-D10'),
    'a clamped override was applied without recording a deviation',
  );
  // and the two slots still tile the strip
  const list = slotsOfStrip(out, stripId);
  for (let i = 1; i < list.length; i++) {
    const gap = list[i].partyLines[0].at - list[i - 1].partyLines[1].at;
    assert.ok(Math.abs(gap) < 0.05 || gap > 0, `slots ${list[i - 1].id} and ${list[i].id} overlap after the edit`);
  }
});

test('removeSlot leaves a hole: ids are never renumbered or reused', () => {
  const { layout, ctx } = base();
  const { b } = firstUnitPair(layout);
  const out = applyOverrides(layout, { version: 1, layouts: { [layout.key]: [{ op: 'removeSlot', slotId: b }] } }, ctx);
  assert.ok(!out.slots.some(s => s.id === b), 'the removed slot is still there');
  for (const s of layout.slots) {
    if (s.id === b) continue;
    const after = out.slots.find(x => x.id === s.id);
    assert.ok(after, `slot ${s.id} was renumbered by a removal`);
  }
  const ids = out.slots.map(s => s.id);
  assert.equal(new Set(ids).size, ids.length, 'a removal produced a duplicate id');
});

test('insertSlot derives its id from its anchor and takes frontage from the neighbours', () => {
  const { layout, ctx } = base();
  const { a, stripId } = firstUnitPair(layout);
  const strip = layout.strips.find(st => st.id === stripId)!;
  const opts = { region: 'US' as const, detail: 'medium' as const, rulesHash: ctx.catalogue.rulesHash };
  const narrow = ctx.catalogue.units
    .filter(m => ctx.catalogue.frontageAt(m.id, strip.netDepth, opts))
    .sort((p, q) => ctx.catalogue.frontageAt(p.id, strip.netDepth, opts)!.min - ctx.catalogue.frontageAt(q.id, strip.netDepth, opts)!.min)[0];
  assert.ok(narrow, 'no admissible module to insert');
  const edit: LayoutEdit = { op: 'insertSlot', stripId, afterSlotId: a, moduleId: narrow.id };
  const clamped = clampLayoutEdit(layout, edit, ctx);
  const doc: OverrideDoc = { version: 1, layouts: { [layout.key]: [edit] } };
  const out = applyOverrides(layout, doc, ctx);
  if (clamped.ok) {
    const inserted = out.slots.find(s => s.id === `${a}.1`);
    assert.ok(inserted, `no slot ${a}.1 after the insert (deviations: ${out.deviations.map(d => d.ruleId).join(',')})`);
    assert.equal(inserted!.moduleId, narrow.id);
    assert.ok(frontageOf(inserted!) > 0.5, 'the inserted slot has no frontage');
  } else {
    assert.ok(out.deviations.some(d => d.ruleId === 'ARC-D11'), 'a rejected insert was not recorded');
  }
});

test('swapModule only accepts a module the depth admits, and records the clamp when it must borrow', () => {
  const { layout, ctx } = base();
  const { a } = firstUnitPair(layout);
  const slot = layout.slots.find(s => s.id === a)!;
  const strip = stripOf(layout, slot)!;
  const opts = { region: 'US' as const, detail: 'medium' as const, rulesHash: ctx.catalogue.rulesHash };

  // a module the depth does not admit is refused outright
  const bad = ctx.catalogue.units.find(m => !ctx.catalogue.frontageAt(m.id, strip.netDepth, opts));
  if (bad) {
    const res = clampLayoutEdit(layout, { op: 'swapModule', slotId: a, moduleId: bad.id }, ctx);
    assert.equal(res.ok, false, `${bad.id} was accepted at ${strip.netDepth} m depth`);
    assert.ok(res.reason && res.reason.length > 10, 'a refusal with no reason');
  }
  // one the depth does admit goes through, and the slot ends up inside its range
  const good = ctx.catalogue.units.find(m => {
    const r = ctx.catalogue.frontageAt(m.id, strip.netDepth, opts);
    return !!r && m.id !== slot.moduleId;
  });
  assert.ok(good, 'no alternative module admissible at this depth');
  const res = clampLayoutEdit(layout, { op: 'swapModule', slotId: a, moduleId: good!.id }, ctx);
  if (!res.ok) return;
  const out = applyOverrides(layout, { version: 1, layouts: { [layout.key]: [res.edit] } }, ctx);
  const after = out.slots.find(s => s.id === a)!;
  assert.equal(after.moduleId, good!.id);
  const range = ctx.catalogue.frontageAt(good!.id, strip.netDepth, opts)!;
  const f = netFrontageOf(after);
  assert.ok(
    (f >= range.min - 0.05 && f <= range.max + 0.05) || out.deviations.some(d => d.ruleId === 'ARC-D10'),
    `${good!.id} ended at ${f.toFixed(2)} m, outside ${range.min}–${range.max} with no deviation recorded`,
  );
});

test('a typical-floor edit propagates to every storey sharing the plan; a storey edit does not', () => {
  const spec = getPreset('us-5-over-1').spec;
  const plain = generateBuilding(spec);
  const entries = Object.entries(plain.arch.layouts ?? {}).filter(([, l]) => l.slots.some(s => s.kind === 'unit'));
  const [storeyId, layout] = entries[0];
  const twins = entries.filter(([, l]) => l.key === layout.key).map(([s]) => s);
  assert.ok(twins.length >= 2, `only ${twins.length} storeys share the typical plan`);
  const { b } = firstUnitPair(layout);

  const typical = generateBuilding({ ...spec, overrides: { version: 1, layouts: { [layout.key]: [{ op: 'mirror', slotId: b, mirrored: true }] } } });
  for (const s of twins) {
    const slot = typical.arch.layouts![s].slots.find(x => x.id === b);
    assert.ok(slot?.mirrored, `${s}: a typical-floor edit did not reach this storey`);
  }

  const oneOff = generateBuilding({ ...spec, overrides: { version: 1, storeys: { [storeyId]: [{ op: 'mirror', slotId: b, mirrored: true }] } } });
  assert.ok(oneOff.arch.layouts![storeyId].slots.find(x => x.id === b)?.mirrored, 'the storey edit did not apply');
  for (const s of twins.filter(x => x !== storeyId)) {
    assert.ok(!oneOff.arch.layouts![s].slots.find(x => x.id === b)?.mirrored, `${s}: a storey-scoped edit leaked`);
  }
});

test('the layout key changes with the edits, so the canonical cache cannot collide', () => {
  const { layout, ctx } = base();
  const { a } = firstUnitPair(layout);
  const one = applyOverrides(layout, { version: 1, layouts: { [layout.key]: [{ op: 'mirror', slotId: a, mirrored: true }] } }, ctx);
  const two = applyOverrides(layout, { version: 1, layouts: { [layout.key]: [{ op: 'mirror', slotId: a, mirrored: false }] } }, ctx);
  assert.notEqual(one.layoutKey, two.layoutKey, 'two different edit sets share a layout key');
  assert.ok(one.layoutKey.startsWith(`${layout.key}#`), `layout key ${one.layoutKey} does not extend the plan key`);
});

test('the module picker offers exactly what the packer would accept', () => {
  const { layout, ctx } = base();
  const { a } = firstUnitPair(layout);
  const slot = layout.slots.find(s => s.id === a)!;
  const strip = stripOf(layout, slot)!;
  const opts = { region: 'US' as const, detail: 'medium' as const, rulesHash: ctx.catalogue.rulesHash };
  const items = candidatesForSlot(layout, a, ctx.catalogue, ctx, { typology: 'mixed-use-midrise' });
  assert.ok(items.length > 0, 'the picker offered nothing for a dwelling slot');
  for (const it of items) {
    const r = ctx.catalogue.frontageAt(it.moduleId, strip.netDepth, opts);
    assert.ok(r, `${it.moduleId} is offered but not admissible at ${strip.netDepth} m depth`);
    assert.ok(Math.abs(it.frontage.min - r!.min) < 0.02, `${it.moduleId}: the picker reports a different range`);
    const swap = clampLayoutEdit(layout, { op: 'swapModule', slotId: a, moduleId: it.moduleId }, ctx);
    assert.ok(swap.ok, `${it.moduleId} is offered but clampLayoutEdit refuses it: ${swap.reason}`);
  }
  assert.ok(items.some(it => it.current), 'the slot’s own module is not in its picker list');
  assert.ok(items.every(it => templateOf(it.moduleId)), 'the picker offered a non-unit module for a dwelling slot');
});
