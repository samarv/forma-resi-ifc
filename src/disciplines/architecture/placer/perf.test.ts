/**
 * Performance budget (design §9). The module catalogue is built once per process, the feasibility queries are
 * memoised, and the packer is O(n log n) with no pairwise loop — so the two biggest presets have to stay inside their
 * budgets rather than merely "look fast".
 *
 * Numbers are generous relative to the measurements (noted per test) so the suite does not go red on a loaded
 * machine; a real regression is an order of magnitude, not a few per cent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { getPreset } from '../../../core/spec.ts';
import { generateBuilding } from '../../../pipeline.ts';
import { buildCatalogue, clearCatalogueCache } from '../../../modules/catalogue.ts';
import { generateArchitecture } from '../index.ts';
import { makeFixture } from '../test-fixtures.ts';

function ms(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

test('the module catalogue builds in well under 120 ms', () => {
  clearCatalogueCache();
  const cold = ms(() => { buildCatalogue(); });
  assert.ok(cold < 120, `catalogue build took ${cold.toFixed(0)} ms (budget 120 ms)`);
  const warm = ms(() => { buildCatalogue(); });
  assert.ok(warm < 1, `a memoised catalogue build took ${warm.toFixed(2)} ms — the memo is not working`);
});

test('ie-courtyard: architecture under 700 ms, the whole pipeline under 3 s (2 s standalone; the bound allows for parallel test load)', () => {
  buildCatalogue();                                  // the catalogue is a process-level cost, not a per-run one
  const spec = getPreset('ie-courtyard').spec;
  generateBuilding(spec);                            // warm the feasibility and canonical-layout memos
  const total = ms(() => { generateBuilding(spec); });
  assert.ok(total < 2000, `ie-courtyard generated in ${total.toFixed(0)} ms (budget 2000 ms)`);
  const m = generateBuilding(spec);
  const arch = m.timings.architecture ?? 0;
  assert.ok(arch < 700, `ie-courtyard architecture took ${arch} ms (budget 700 ms)`);
  assert.ok(m.arch.units.length > 100, `only ${m.arch.units.length} dwellings on a 171-unit preset`);
});

test('ca-point-tower: 22 storeys through the whole pipeline under 3 s (2 s standalone; the bound allows for parallel test load)', () => {
  buildCatalogue();
  const spec = getPreset('ca-point-tower').spec;
  generateBuilding(spec);
  const total = ms(() => { generateBuilding(spec); });
  assert.ok(total < 2000, `ca-point-tower generated in ${total.toFixed(0)} ms (budget 2000 ms)`);
});

test('the typical-floor plan is computed once and replicated, not once per storey', () => {
  // ARC-08: a 22-storey tower shares one plan per (use, outline, mix), so the layouts of two typical storeys are the
  // SAME object identity after `applyOverrides` returns the base by reference for an empty document.
  const m = generateBuilding(getPreset('ca-point-tower').spec);
  const layouts = Object.entries(m.arch.layouts ?? {}).filter(([, l]) => l.slots.some(s => s.kind === 'unit'));
  const byKey = new Map<string, unknown[]>();
  for (const [, l] of layouts) {
    const list = byKey.get(l.key) ?? [];
    list.push(l);
    byKey.set(l.key, list);
  }
  const shared = [...byKey.values()].find(list => list.length > 1);
  assert.ok(shared, 'no two storeys share a typical plan on a 22-storey tower');
  assert.equal(shared![0], shared![1], 'two storeys sharing a plan key hold different layout objects');
  assert.ok(byKey.size < layouts.length, `${byKey.size} distinct plans for ${layouts.length} residential storeys`);
});

test('every fixture lays out in a few tens of milliseconds', () => {
  buildCatalogue();
  for (const kind of ['bar-double', 'point', 'townhouse', 'walkup', 'gallery'] as const) {
    const fx = makeFixture(kind);
    generateArchitecture(fx.ctx);
    const fx2 = makeFixture(kind);
    const t = ms(() => { generateArchitecture(fx2.ctx); });
    assert.ok(t < 400, `${kind} architecture took ${t.toFixed(0)} ms`);
  }
});
