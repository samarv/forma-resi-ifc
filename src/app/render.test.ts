/**
 * Renderers and the mock model are pure string/geometry builders, so they can be
 * exercised without a DOM. Also guards the "plan builds in < 100 ms" budget.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS } from '../core/spec.ts';
import { buildMockModel, mockWriteIfc, MOCK_METRICS, MOCK_TEMPLATES } from './mock-model.ts';
import { buildPlan, elementFootprint, pickHit, along } from './plan-svg.ts';
import { buildSite } from './site-svg.ts';
import { buildAxon, ccw, project } from './axon-svg.ts';
import { DEFAULT_LAYERS } from './state.ts';
import { parseIdGuidMap } from './viewer-embed.ts';
import { niceScaleLength, northScreenDeg } from './viewport.ts';
import { arcPath } from './svg.ts';
import { swingArc } from '../core/openings.ts';
import type { Vec2 } from '../core/types.ts';

const model = buildMockModel(PRESETS[0].spec);

test('mock model is internally consistent', () => {
  assert.ok(model.elements.length > 100, `only ${model.elements.length} elements`);
  assert.ok(model.arch.units.length === 4, `units ${model.arch.units.length}`);
  assert.ok(model.metrics.length >= 5);
  assert.ok(model.patterns.book.length >= 3);
  assert.ok(model.patterns.applications.length > 0);
  const ids = new Set<string>();
  for (const e of model.elements) {
    assert.ok(!ids.has(e.id), `duplicate element id ${e.id}`);
    ids.add(e.id);
    assert.ok(model.storeys.some((s) => s.id === e.storey), `element ${e.id} on unknown storey ${e.storey}`);
  }
  for (const a of model.patterns.applications) {
    assert.ok(model.patterns.book.some((p) => p.id === a.patternId), `application of unregistered ${a.patternId}`);
  }
  assert.equal(MOCK_TEMPLATES.length, 20);
  assert.ok(MOCK_METRICS.filter((m) => m.rank <= 20).length === 20);
});

test('no NaN coordinates in any mock element footprint', () => {
  for (const e of model.elements) {
    const pts = elementFootprint(e.geometry);
    if (!pts) continue;
    for (const p of pts) {
      assert.ok(Number.isFinite(p[0]) && Number.isFinite(p[1]), `NaN in ${e.id}`);
    }
  }
});

test('plan builds for every storey, batched and under budget', () => {
  for (const st of model.storeys) {
    const t0 = performance.now();
    const d = buildPlan(model, st.id, DEFAULT_LAYERS, 'metric', null);
    const ms = performance.now() - t0;
    assert.ok(ms < 100, `${st.id} took ${ms.toFixed(1)} ms`);
    assert.ok(!d.body.includes('NaN'), `${st.id} emitted NaN`);
    assert.ok(d.bounds.w > 0 && d.bounds.h > 0, `${st.id} empty bounds`);
    if (st.index >= 0 && st.index < 100) {
      assert.ok(d.hits.length > 10, `${st.id} only ${d.hits.length} hits`);
      assert.ok(d.body.includes('<path'), `${st.id} has no paths`);
    }
    // batching: far fewer <path> nodes than hits
    const paths = d.body.split('<path').length - 1;
    assert.ok(paths < Math.max(60, d.hits.length), `${st.id} not batched: ${paths} paths for ${d.hits.length} hits`);
  }
});

test('layer toggles remove their layer from the drawing', () => {
  const all = buildPlan(model, 'L02', DEFAULT_LAYERS, 'metric', null);
  const noElec = buildPlan(model, 'L02', { ...DEFAULT_LAYERS, elec: false }, 'metric', null);
  assert.ok(all.body.includes('l-elec'));
  assert.ok(!noElec.body.includes('l-elec'));
  const noLabels = buildPlan(model, 'L02', { ...DEFAULT_LAYERS, labels: false }, 'metric', null);
  assert.ok(all.body.includes('l-room-labels'));
  assert.ok(!noLabels.body.includes('l-room-labels'));
  const noStruct = buildPlan(model, 'L02', { ...DEFAULT_LAYERS, struct: false }, 'metric', null);
  assert.ok(!noStruct.body.includes('l-struct'));
});

test('hit picking prefers the smallest containing box', () => {
  const hits = [
    { id: 'big', kind: 'Room', label: 'big', x0: 0, y0: 0, x1: 10, y1: 10, meta: [] as [string, string][] },
    { id: 'small', kind: 'Wall', label: 'small', x0: 4, y0: 4, x1: 5, y1: 5, meta: [] as [string, string][] },
  ];
  assert.equal(pickHit(hits, 4.5, 4.5)?.id, 'small');
  assert.equal(pickHit(hits, 1, 1)?.id, 'big');
  assert.equal(pickHit(hits, 99, 99), null);
});

test('opening placement along a wall', () => {
  const w = { start: [0, 0] as [number, number], end: [10, 0] as [number, number] };
  const { a, b, dir, nrm } = along(w, 5, 1);
  assert.deepEqual(a, [4.5, 0]);
  assert.deepEqual(b, [5.5, 0]);
  assert.deepEqual(dir, [1, 0]);
  assert.ok(Math.abs(nrm[0]) < 1e-12 && nrm[1] === 1);
});

test('door arcs are a quarter turn on all four wall directions', () => {
  // v1 built the arc from two absolute atan2 angles, so a wall pointing -X wrapped to +270° and drew a
  // three-quarter arc across the room (large=1, sweep=0). The sweep is normalised now, so every leaf is 90°.
  const walls: [string, Vec2, Vec2][] = [
    ['+X', [0, 0], [10, 0]], ['-X', [10, 0], [0, 0]], ['+Y', [0, 0], [0, 10]], ['-Y', [0, 10], [0, 0]],
  ];
  for (const [label, start, end] of walls) {
    for (const hinge of ['start', 'end'] as const) {
      for (const swing of ['left', 'right'] as const) {
        const d = { along: 5, width: 0.9, motion: 'swing' as const, hinge, swing };
        const arc = swingArc(d, { start, end });
        assert.ok(arc, label);
        const path = arcPath(arc!.centre[0], arc!.centre[1], arc!.radius, arc!.fromAngle, arc!.toAngle);
        const flags = path.split('A')[1].trim().split(/\s+/);
        assert.equal(flags[3], '0', `${label}/${hinge}/${swing}: large-arc flag set — the sweep wrapped`);
        // the drawn endpoints are the closed leaf (latch) and the open leaf tip, 90° apart
        const chord = Math.hypot(arc!.to[0] - arc!.from[0], arc!.to[1] - arc!.from[1]);
        assert.ok(Math.abs(chord - 0.9 * Math.SQRT2) < 1e-9, `${label}: chord ${chord.toFixed(4)}`);
      }
    }
  }
});

test('site plan and axon build', () => {
  const s = buildSite(model, 'metric', null);
  assert.ok(s.body.length > 500);
  assert.ok(!s.body.includes('NaN'));
  assert.ok(s.hits.some((h) => h.id === 'SITE-BOUNDARY'));
  assert.ok(s.body.includes('STREET'));

  const a = buildAxon(model);
  assert.ok(a.counts.drawn > 20, `axon drew ${a.counts.drawn}`);
  assert.ok(!a.body.includes('NaN'));
  assert.ok(a.bounds.w > 0 && a.bounds.h > 0);
  assert.deepEqual(project(0, 0, 0), [0, 0]);
  assert.ok(project(1, 0, 0)[0] > 0 && project(0, 1, 0)[0] < 0);
  // z up must move the point up the screen (smaller SVG y)
  assert.ok(project(0, 0, 3)[1] < project(0, 0, 0)[1]);
  // a clockwise ring comes back reversed
  assert.deepEqual(ccw([[0, 0], [0, 1], [1, 1], [1, 0]]), [[1, 0], [1, 1], [0, 1], [0, 0]]);
  // an already counter-clockwise ring is returned untouched
  assert.deepEqual(ccw([[0, 0], [1, 0], [1, 1], [0, 1]]), [[0, 0], [1, 0], [1, 1], [0, 1]]);
});

test('mock IFC writer output parses back to a GUID map', () => {
  const ifc = mockWriteIfc(model);
  assert.ok(ifc.content.startsWith('ISO-10303-21;'));
  assert.ok(ifc.content.includes('END-ISO-10303-21;'));
  assert.equal(ifc.fileSize, ifc.content.length);
  assert.ok(ifc.entityCount > model.elements.length);
  assert.equal(Object.keys(ifc.idMap).length, model.elements.length);
  const map = parseIdGuidMap(ifc.content);
  for (const e of model.elements.slice(0, 20)) {
    const n = ifc.idMap[e.id];
    assert.ok(map.has(n), `no GUID for expressId ${n} (${e.id})`);
    assert.equal(map.get(n)!.length, 22);
  }
});

test('parseIdGuidMap handles a hand-written STEP snippet', () => {
  const step = [
    'ISO-10303-21;',
    'DATA;',
    "#1=IFCPROJECT('2AFsdfg$H4x3Qm9nFtYzZ1',#2,'Project',$);",
    "#12 = IFCWALLSTANDARDCASE( '0hqU2Ff1j9$9uBcDeFgHiJ' , #2 , 'Wall' ) ;",
    "#13=IFCCARTESIANPOINT((0.,0.,0.));",
    "#14=IFCDOOR('tooshort',#2,'Door');",
    'ENDSEC;',
  ].join('\n');
  const m = parseIdGuidMap(step);
  assert.equal(m.get(1), '2AFsdfg$H4x3Qm9nFtYzZ1');
  assert.equal(m.get(12), '0hqU2Ff1j9$9uBcDeFgHiJ');
  assert.equal(m.has(13), false, 'IFCCARTESIANPOINT has no GUID');
  assert.equal(m.has(14), false, 'a non-22-char first argument is not a GUID');
});

test('scale bar and north arrow maths', () => {
  assert.equal(niceScaleLength(12), 10);
  assert.equal(niceScaleLength(3), 2);
  assert.equal(niceScaleLength(7), 5);
  assert.equal(niceScaleLength(0.4), 0.2);
  // street at the bottom: facing south → +Y is north → arrow points up
  assert.equal(northScreenDeg('S'), 0);
  assert.equal(northScreenDeg('N'), -180);
  assert.equal(northScreenDeg('E'), -270);
  assert.equal(northScreenDeg('W'), -90);
});

test('plan of a 20-storey-scale element load stays under 100 ms', () => {
  // clone the mock storey into a big synthetic model to check the batching budget
  const big = buildMockModel({ ...PRESETS[2].spec });
  const storey = big.arch.floors[0]?.storey ?? 'L01';
  const fat = { ...big, elements: [...big.elements] };
  for (let i = 0; i < 3000; i++) {
    const src = big.elements[i % big.elements.length];
    fat.elements.push({ ...src, id: `${src.id}-copy${i}`, storey });
  }
  const t0 = performance.now();
  const d = buildPlan(fat, storey, DEFAULT_LAYERS, 'metric', null);
  const ms = performance.now() - t0;
  assert.ok(ms < 100, `fat plan took ${ms.toFixed(1)} ms`);
  assert.ok(d.hits.length > 0);
});

test('furniture draws its 3D type symbol, batched into one path', () => {
  const storey = model.arch.furniture[0]?.storey;
  assert.ok(storey, 'the mock model has no furniture');
  const items = model.arch.furniture.filter((f) => f.storey === storey);

  const layerOf = (m: typeof model): string => {
    const d = buildPlan(m, storey, DEFAULT_LAYERS, 'metric', null);
    const layer = /<g class="l-furn">([\s\S]*?)<\/g>/.exec(d.body);
    assert.ok(layer, 'no furniture layer');
    return layer[1];
  };

  const full = layerOf(model);
  // Still ONE <path> for the whole layer: the symbol rings go into the same
  // batched outline array, not into per-item nodes.
  assert.equal((full.match(/<path/g) ?? []).length, 1);
  // The letter glyphs are gone.
  assert.ok(!full.includes('<text'), 'furniture still emits text glyphs');

  // Rings per item: the footprint plus the type symbol, and never more than the
  // eight primitives a type may have.
  const subpaths = (layer: string): number => (layer.match(/M/g) ?? []).length;
  const low = layerOf({
    ...model,
    spec: { ...model.spec, options: { ...model.spec.options, detail: 'low' } },
  });
  assert.equal(subpaths(low), items.length, 'low detail draws the footprint ring only');
  assert.ok(subpaths(full) > subpaths(low), 'no symbol rings were drawn');
  assert.ok(subpaths(full) <= items.length * 9,
    `${subpaths(full)} rings for ${items.length} items exceeds the budget`);

  // A mapped-item occurrence is pickable and measured exactly like a box.
  const instance = model.elements.find((e) => e.geometry.kind === 'instance');
  assert.ok(instance, 'the mock model has no instance element');
  const pts = elementFootprint(instance.geometry);
  assert.ok(pts && pts.length === 4);
  const axon = buildAxon(model);
  assert.ok(axon.hits.some((h) => h.id === instance.id), 'instance missing from the axon');
});
