/**
 * The preset invariants (#30–#32 of docs/design/v2-design-kernel-rules-presize.md §6).
 *
 * #30 (zero violations) is the headline invariant of v2 and is skipped until wave 2: the disciplines are still on
 * their v1 code paths, so the post-check reports what v1 actually emits. The assertion body is real and prints
 * every violating issue with its rule, storey, elements, observed and limit — unskipping it is a one-word change.
 * #31 (determinism) and #32 (the regression budget) are live, because both hold today and both are the things most
 * likely to be broken by accident.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { DesignModel } from './core/types.ts';
import type { Issue } from './core/rules/types.ts';
import { generateBuilding } from './pipeline.ts';
import { PRESETS } from './core/spec.ts';

const DETAIL_CASES: { id: string; detail: 'low' | 'medium' | 'high' }[] = [
  ...PRESETS.map(p => ({ id: p.id, detail: 'medium' as const })),
  { id: 'us-5-over-1', detail: 'low' },
  { id: 'us-5-over-1', detail: 'high' },
  { id: 'ca-point-tower', detail: 'low' },
  { id: 'ca-point-tower', detail: 'high' },
];

function build(id: string, detail: 'low' | 'medium' | 'high'): DesignModel {
  const preset = PRESETS.find(p => p.id === id);
  assert.ok(preset, `unknown preset ${id}`);
  const spec = { ...preset.spec, options: { ...(preset.spec.options ?? {}), detail } };
  return generateBuilding(spec);
}

function describe(i: Issue): string {
  const bits = [i.severity.toUpperCase(), i.ruleId];
  if (i.storey) bits.push(`on ${i.storey}`);
  if (i.unitId) bits.push(`in ${i.unitId}`);
  if (i.elementIds && i.elementIds.length > 0) bits.push(`[${i.elementIds.slice(0, 3).join(', ')}]`);
  bits.push(`— ${i.message}`);
  if (i.observed !== undefined) bits.push(`(observed ${i.observed}, limit ${i.limit})`);
  if (i.count && i.count > 1) bits.push(`×${i.count}`);
  return bits.join(' ');
}

test('#30 no preset produces a violation or an error', { skip: 'wave 2: mechanical, plumbing, electrical, doors and the placer are still on their v1 code paths' }, () => {
  const failures: string[] = [];
  for (const c of DETAIL_CASES) {
    const m = build(c.id, c.detail);
    const bad = (m.issues ?? []).filter(i => i.severity === 'violation' || i.severity === 'error');
    for (const i of bad) failures.push(`${c.id}/${c.detail}: ${describe(i)}`);
  }
  assert.deepEqual(failures, [], `violations and errors across the presets:\n  ${failures.join('\n  ')}`);
});

test('#30b every preset generates, records its rules and issues, and keeps its warnings a projection of them', () => {
  for (const preset of PRESETS) {
    const m = generateBuilding(preset.spec);
    assert.ok(m.elements.length > 50, `${preset.id}: only ${m.elements.length} elements`);
    assert.ok((m.rules ?? []).length > 500, `${preset.id}: ${(m.rules ?? []).length} rules resolved`);
    assert.ok(Array.isArray(m.issues), `${preset.id}: no issues array`);
    for (const i of m.issues ?? []) {
      assert.ok(i.id.startsWith('ISS-'), `${preset.id}: issue id ${i.id}`);
      assert.ok(i.message.length > 0, `${preset.id}: empty issue message for ${i.ruleId}`);
      assert.ok(i.ruleId.length > 0, `${preset.id}: issue with no rule id`);
    }
    // An `info` issue is a recorded resolution, not a problem: it must never reach the legacy warning strings.
    const projection = (i: Issue): string => (i.discipline === 'xd' || i.discipline === 'site' ? i.message : `[${i.discipline}] ${i.message}`);
    const infoStrings = new Set((m.issues ?? []).filter(i => i.severity === 'info').map(projection));
    const leaked = m.warnings.filter(w => infoStrings.has(w));
    assert.deepEqual(leaked, [], `${preset.id}: info issues leaked into the warnings projection`);
    const ids = (m.issues ?? []).map(i => i.id);
    assert.equal(new Set(ids).size, ids.length, `${preset.id}: duplicate issue ids`);
  }
});

test('#31 two generations of a preset are identical, issue for issue and id for id', () => {
  for (const preset of PRESETS) {
    const a = generateBuilding(preset.spec);
    const b = generateBuilding(preset.spec);
    assert.equal(JSON.stringify(a.issues), JSON.stringify(b.issues), `${preset.id}: issues are not deterministic`);
    assert.deepEqual(a.warnings, b.warnings, `${preset.id}: warnings are not deterministic`);
    assert.deepEqual(a.elements.map(e => e.id), b.elements.map(e => e.id), `${preset.id}: element ids are not deterministic`);
    assert.equal(JSON.stringify(a.rules), JSON.stringify(b.rules), `${preset.id}: the rule set is not deterministic`);
    assert.deepEqual(a.storeys, b.storeys, `${preset.id}: storeys are not deterministic`);
  }
});

test('#32 every preset stays inside the regression budget', () => {
  const budgetMs = 1200;
  const slow: string[] = [];
  for (const preset of PRESETS) {
    const t = now();
    const m = generateBuilding(preset.spec);
    const wall = now() - t;
    const total = Object.values(m.timings).reduce((a, b) => a + b, 0);
    if (total > budgetMs) slow.push(`${preset.id}: ${total.toFixed(0)} ms (${JSON.stringify(roundAll(m.timings))})`);
    assert.ok(wall < 4000, `${preset.id}: ${wall.toFixed(0)} ms wall clock`);
  }
  assert.deepEqual(slow, [], `presets over the ${budgetMs} ms budget:\n  ${slow.join('\n  ')}`);
});

test('#32b the validation pass is a small fraction of the generation', () => {
  const m = build('ie-courtyard', 'medium');
  const total = Object.values(m.timings).reduce((a, b) => a + b, 0);
  const added = (m.timings.rules ?? 0) + (m.timings.presize ?? 0) + (m.timings.kernel ?? 0) + (m.timings.validate ?? 0);
  assert.ok(added < 400, `the v2 backbone added ${added.toFixed(0)} ms to ie-courtyard (${JSON.stringify(roundAll(m.timings))})`);
  assert.ok(added < total * 0.6, `validation is ${((added / total) * 100).toFixed(0)}% of the generation`);
});

test('the ceiling profiles fit every preset at its default floor-to-floor', () => {
  // The one documented exception: ca-point-tower asks for three 3.0 m retail podium storeys under a 22-storey
  // tower, and the top one carries the 0.90 m transfer beam. A shop cannot have a 2.40 m clear height under it, so
  // the pre-sizing raises that storey — which is the resolution working, not a failure. The fix is a taller default
  // podium floor-to-floor for a retail podium (core/spec.ts + core/typologies.ts), not a shallower profile.
  const expected: Record<string, number> = { 'ca-point-tower': 1 };
  for (const preset of PRESETS) {
    const m = generateBuilding(preset.spec);
    const raises = (m.issues ?? []).filter(i => i.resolution?.id === 'raise-floor-to-floor');
    assert.equal(raises.length, expected[preset.id] ?? 0,
      `${preset.id}: ${raises.length} floor-to-floor raise(s):\n  ${raises.map(describe).join('\n  ')}`);
  }
});

function roundAll(t: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(t).sort()) out[k] = Math.round(t[k]);
  return out;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : 0;
}
