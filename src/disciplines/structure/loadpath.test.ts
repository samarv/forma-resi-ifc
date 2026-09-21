/**
 * Load-path constructability tests. Run with:
 *   node --test src/disciplines/structure/loadpath.test.ts
 *
 * One synthetic fixture per failure mode, each built from a KNOWN-GOOD two-storey frame with exactly one thing
 * broken, so a failure names the rule that fired rather than "something is wrong":
 *   STR-C1  a column with nothing below it, and a transfer beam with one unsupported end
 *   STR-C2  a lowest support no foundation reaches
 *   STR-C3  a core wall line missing on a storey it continues above
 *   STR-C4  a slab edge cantilevering past the support limit
 *   STR-C5  a balcony with too little backspan, and one too thin for its cantilever
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type {
  BalconyDef, FoundationElement, Polygon, StoreyDef, StructBeam, StructColumn, StructSlab, StructWall, Vec2,
} from '../../core/types.ts';
import type { Severity } from '../../core/rules/types.ts';
import { rectToPolygon } from '../../core/geometry.ts';

import { checkLoadPath, loadPathBases } from './loadpath.ts';
import { presizeStructure, type StructuralPresize } from './presize.ts';
import { createProfileBook } from './profiles-seam.ts';
import { collectingLedger, passthroughRuleSet } from './fallbacks.ts';
import { makeArchFixture } from './test-fixtures.ts';

const rules = passthroughRuleSet();
const profiles = createProfileBook(rules);

/** A real pre-sizing, so the checker sees the same transfer numbers the generator would */
const PRESIZE: StructuralPresize = (() => {
  const f = makeArchFixture('midrise-bar');
  return presizeStructure({ spec: f.spec, typology: f.typology, site: f.site, storeys: f.storeys, profiles, rules, ledger: collectingLedger() });
})();

const STOREYS: StoreyDef[] = [
  { id: 'L01', name: 'Level 1', index: 0, elevation: 0, height: 4.0, use: 'parking' },
  { id: 'L02', name: 'Level 2', index: 1, elevation: 4.0, height: 3.0, use: 'residential' },
];

const PLATE = { x: 0, y: 0, w: 16, h: 16 };
const OUTLINE: Polygon = rectToPolygon(PLATE);
/** The 3 x 3 grid the good model is built on */
const XS = [0.5, 8, 15.5];
const YS = [0.5, 8, 15.5];

function col(id: string, storey: string, p: Vec2): StructColumn {
  return { id, storey, position: p, width: 0.5, depth: 0.5, height: 3.0, gridRef: id, material: 'concrete' };
}
function wall(id: string, storey: string, a: Vec2, b: Vec2, role: StructWall['role'] = 'bearing'): StructWall {
  return { id, storey, start: a, end: b, thickness: 0.25, height: 3.0, role, material: 'concrete' };
}
function beam(id: string, storey: string, a: Vec2, b: Vec2, role: StructBeam['role'] = 'transfer'): StructBeam {
  return { id, storey, start: a, end: b, z: 2.8, width: 0.5, depth: 0.9, material: 'concrete', role };
}
function slab(id: string, storey: string, outline: Polygon, type: StructSlab['type'] = 'floor', thickness = 0.2): StructSlab {
  return { id, storey, outline, thickness, type, openings: [] };
}
function pad(id: string, p: Vec2): FoundationElement {
  return { id, type: 'pad', position: p, width: 2.0, depth: 2.0, height: 0.5 };
}

interface Model {
  columns: StructColumn[];
  walls: StructWall[];
  beams: StructBeam[];
  slabs: StructSlab[];
  foundations: FoundationElement[];
  balconies: BalconyDef[];
}

/** A 16 x 16 m two-storey frame: 9 columns per storey, rim beams, pads under every lowest column. */
function goodModel(): Model {
  const columns: StructColumn[] = [];
  for (const s of ['L01', 'L02']) {
    for (const x of XS) for (const y of YS) columns.push(col(`COL-${s}-${x}-${y}`, s, [x, y]));
  }
  const rim: StructBeam[] = [];
  const ring: Vec2[] = [[0.5, 0.5], [15.5, 0.5], [15.5, 15.5], [0.5, 15.5]];
  for (const s of ['L01', 'L02']) {
    for (let i = 0; i < ring.length; i++) rim.push(beam(`RIM-${s}-${i}`, s, ring[i], ring[(i + 1) % ring.length], 'rim'));
    // an interior line each way, so a mid-edge sample is never more than a bay from a beam
    rim.push(beam(`MIDX-${s}`, s, [8, 0.5], [8, 15.5], 'primary'));
    rim.push(beam(`MIDY-${s}`, s, [0.5, 8], [15.5, 8], 'primary'));
  }
  return {
    columns,
    walls: [],
    beams: rim,
    slabs: [slab('SLAB-L01', 'L01', OUTLINE, 'ground'), slab('SLAB-L02', 'L02', OUTLINE)],
    foundations: XS.flatMap(x => YS.map(y => pad(`PAD-${x}-${y}`, [x, y]))),
    balconies: [],
  };
}

function run(m: Model): { issues: ReturnType<typeof collectingLedger>; result: ReturnType<typeof checkLoadPath> } {
  const issues = collectingLedger();
  const result = checkLoadPath({
    storeysAscending: STOREYS,
    columns: m.columns,
    walls: m.walls,
    beams: m.beams,
    slabs: m.slabs,
    foundations: m.foundations,
    balconies: m.balconies,
    presize: PRESIZE,
    rules,
    ledger: issues,
  });
  return { issues, result };
}

function expectOne(m: Model, ruleId: string, severity: Severity = 'violation'): void {
  const { issues, result } = run(m);
  const all = issues.all();
  const hit = all.filter(i => i.ruleId === ruleId);
  assert.equal(hit.length, 1, `expected exactly one ${ruleId}, got ${all.length} issues: ${all.map(i => i.ruleId).join(', ')}`);
  assert.equal(hit[0].severity, severity, `${ruleId} severity`);
  assert.ok(hit[0].message.length > 30, `${ruleId} needs a message a human can act on`);
  assert.ok(hit[0].source && hit[0].source.length > 10, `${ruleId} needs a code source, got '${hit[0].source}'`);
  assert.ok((hit[0].elementIds ?? []).length > 0, `${ruleId} must name the element`);
  assert.equal(all.length, 1, `${ruleId} fixture produced other issues too: ${all.map(i => i.ruleId).join(', ')}`);
  assert.equal(result.issues.length, 1, `${ruleId} must be returned in the result as well as recorded`);
}

// ----------------------------------------------------------------------------
// The baseline must be clean, or nothing else here means anything
// ----------------------------------------------------------------------------

test('a coherent frame produces no issues at all', () => {
  const { issues, result } = run(goodModel());
  assert.deepEqual(issues.all().map(i => i.ruleId), [], 'the good model must be silent');
  assert.equal(result.derived.unsupportedSupports, 0);
  assert.equal(result.derived.unfoundedBases, 0);
  assert.equal(result.derived.bases, 9, 'nine lowest supports');
  assert.equal(result.derived.supports, 18, 'nine columns on each of two storeys');
  assert.equal(result.derived.supportsCarried, 9, 'the upper nine are carried');
  assert.equal(result.nodes.filter(n => n.via === 'column').length, 9);
  assert.ok(result.derived.slabEdgeSamples > 0, 'the slab edge was actually sampled');
});

test('loadPathBases agrees with checkLoadPath about what needs a foundation', () => {
  const m = goodModel();
  const bases = loadPathBases({ storeysAscending: STOREYS, columns: m.columns, walls: m.walls, beams: m.beams, rules });
  const { result } = run(m);
  assert.deepEqual(bases.map(b => b.id).sort(), result.bases.map(b => b.id).sort());
  assert.ok(bases.every(b => b.storey === 'L01'), 'every base is on the lowest framed storey');
});

// ----------------------------------------------------------------------------
// STR-C1 continuity
// ----------------------------------------------------------------------------

test('STR-C1: a column with nothing below it is one violation', () => {
  const m = goodModel();
  m.columns = m.columns.filter(c => c.id !== 'COL-L01-8-8');
  m.foundations = m.foundations.filter(f => f.id !== 'PAD-8-8');
  expectOne(m, 'STR-C1.columnContinuity');
  const { issues } = run(m);
  assert.match(issues.all()[0].message, /COL-L02-8-8/, 'the message must name the unsupported column');
  assert.match(issues.all()[0].message, /L01/, 'the message must name the storey it lands on');
});

test('STR-C1: a transfer beam carries only when BOTH its ends land on a support', () => {
  // Remove the middle column of the lower storey and bridge it with a transfer beam between the two columns
  // either side: that is legal, and the column above is then carried 'via transfer'.
  const good = goodModel();
  good.columns = good.columns.filter(c => c.id !== 'COL-L01-8-8');
  good.foundations = good.foundations.filter(f => f.id !== 'PAD-8-8');
  good.beams.push(beam('TB-1', 'L01', [8, 0.5], [8, 15.5]));
  const ok = run(good);
  assert.deepEqual(ok.issues.all().map(i => i.ruleId), [], 'a transfer beam on two columns must carry the column above');
  assert.equal(ok.result.derived.supportsOnTransfer, 1, 'the column above must be carried via the transfer beam');
  assert.equal(ok.result.nodes.find(n => n.support.id === 'COL-L02-8-8')?.via, 'transfer');

  // Now cut one end loose: the beam ends in mid-air, so it carries nothing.
  const bad = goodModel();
  bad.columns = bad.columns.filter(c => c.id !== 'COL-L01-8-8');
  bad.foundations = bad.foundations.filter(f => f.id !== 'PAD-8-8');
  bad.beams.push(beam('TB-1', 'L01', [8, 4.0], [8, 15.5]));
  expectOne(bad, 'STR-C1.columnContinuity');
  assert.equal(run(bad).result.derived.supportsOnTransfer, 0);
});

test('STR-C1: a secondary transfer beam landing on a primary still carries', () => {
  const m = goodModel();
  m.columns = m.columns.filter(c => c.id !== 'COL-L01-8-8');
  m.foundations = m.foundations.filter(f => f.id !== 'PAD-8-8');
  // primary: column to column along y; secondary: across it, ending on the primary, not on a column
  m.beams.push(beam('TB-PRIMARY-A', 'L01', [0.5, 0.5], [0.5, 15.5]));
  m.beams.push(beam('TB-PRIMARY-B', 'L01', [15.5, 0.5], [15.5, 15.5]));
  m.beams.push(beam('TB-SECONDARY', 'L01', [0.5, 8], [15.5, 8]));
  const { issues, result } = run(m);
  assert.deepEqual(issues.all().map(i => i.ruleId), [], 'a two-level grillage must carry the column above');
  assert.equal(result.nodes.find(n => n.support.id === 'COL-L02-8-8')?.carriedBy, 'TB-SECONDARY');
});

// ----------------------------------------------------------------------------
// STR-C2 foundations
// ----------------------------------------------------------------------------

test('STR-C2: a lowest support no foundation reaches is one violation', () => {
  const m = goodModel();
  m.foundations = m.foundations.filter(f => f.id !== 'PAD-8-8');
  expectOne(m, 'STR-C2.foundationUnderSupport');
  assert.match(run(m).issues.all()[0].message, /COL-L01-8-8/);
});

test('STR-C2: a raft founds everything above it, and a wall bears along its whole line', () => {
  const raft = goodModel();
  raft.foundations = [{ id: 'RAFT', type: 'raft', rect: PLATE, height: 0.8 }];
  assert.deepEqual(run(raft).issues.all().map(i => i.ruleId), [], 'a raft under the plate founds every support');

  const walled = goodModel();
  walled.walls.push(wall('W-L01', 'L01', [0.5, 0.5], [15.5, 0.5]));
  walled.walls.push(wall('W-L02', 'L02', [0.5, 0.5], [15.5, 0.5]));
  // one strip under part of the line is enough: the wall bears along its length
  walled.foundations.push({ id: 'STRIP', type: 'strip', position: [8, 0.5], width: 15, depth: 0.6, height: 0.3, length: 15 });
  assert.deepEqual(run(walled).issues.all().map(i => i.ruleId), [], 'a strip under the wall line founds the wall');
});

// ----------------------------------------------------------------------------
// STR-C3 core continuity
// ----------------------------------------------------------------------------

test('STR-C3: a core wall line that skips a storey is one violation', () => {
  const m = goodModel();
  // core wall on the UPPER storey only: the shear spine stops before it reaches the ground
  m.walls.push(wall('CORE-L02', 'L02', [4, 4], [4, 12], 'core'));
  m.foundations.push({ id: 'STRIP-CORE', type: 'strip', position: [4, 8], width: 0.6, depth: 8, height: 0.3, length: 8 });
  expectOne(m, 'STR-C3.coreContinuity');
  assert.match(run(m).issues.all()[0].message, /L01/, 'the message must name the storey where the line is missing');

  // the same wall on both storeys is continuous and silent
  const ok = goodModel();
  ok.walls.push(wall('CORE-L01', 'L01', [4, 4], [4, 12], 'core'), wall('CORE-L02', 'L02', [4, 4], [4, 12], 'core'));
  ok.foundations.push({ id: 'STRIP-CORE', type: 'strip', position: [4, 8], width: 0.6, depth: 8, height: 0.3, length: 8 });
  assert.deepEqual(run(ok).issues.all().map(i => i.ruleId), [], 'a continuous core must be silent');
});

// ----------------------------------------------------------------------------
// STR-C4 slab edges
// ----------------------------------------------------------------------------

test('STR-C4: a slab edge past min(2.0, 10 x slabT) of a support is one violation', () => {
  const m = goodModel();
  // Push the upper plate 3 m out on one side: the new edge is 3 m from the rim beam below.
  m.slabs = m.slabs.map(s => (s.storey === 'L02' ? slab(s.id, s.storey, rectToPolygon({ x: 0, y: 0, w: 19, h: 16 })) : s));
  expectOne(m, 'STR-C4.slabEdgeSupport');
  const msg = run(m).issues.all()[0].message;
  assert.match(msg, /cantilevers/, 'the message must say how far it cantilevers');
  assert.match(msg, /2\.00 m/, 'the message must state the limit for a 200 mm slab');
});

test('STR-C4: a ground slab bears on the ground and is never checked', () => {
  const m = goodModel();
  m.slabs = m.slabs.map(s => (s.storey === 'L01' ? slab(s.id, s.storey, rectToPolygon({ x: -6, y: -6, w: 28, h: 28 }), 'ground') : s));
  assert.deepEqual(run(m).issues.all().map(i => i.ruleId), [], 'a base slab must not be treated as a cantilever');
});

// ----------------------------------------------------------------------------
// STR-C5 balconies
// ----------------------------------------------------------------------------

function balcony(id: string, rect: { x: number; y: number; w: number; h: number }): BalconyDef {
  return { id, storey: 'L02', unitId: 'U-L02-01', rect, roomId: 'R-U-L02-01-BAL' };
}

test('STR-C5: a balcony within the cantilever limit and thick enough is silent', () => {
  const m = goodModel();
  m.balconies = [balcony('BALC-1', { x: 4, y: 16, w: 3, h: 1.5 })];
  m.slabs.push(slab('BALC-1', 'L02', rectToPolygon({ x: 4, y: 16, w: 3, h: 1.5 }), 'balcony', 0.2));
  assert.deepEqual(run(m).issues.all().map(i => i.ruleId), [], 'a 1.5 m / 200 mm balcony on a 16 m plate is fine');
  assert.equal(run(m).result.derived.balconiesVerified, 1, 'the balcony must be counted as verified');
});

test('STR-C5: a balcony thinner than max(0.18, L/10) is one violation', () => {
  const m = goodModel();
  m.balconies = [balcony('BALC-1', { x: 4, y: 16, w: 3, h: 1.5 })];
  m.slabs.push(slab('BALC-1', 'L02', rectToPolygon({ x: 4, y: 16, w: 3, h: 1.5 }), 'balcony', 0.15));
  expectOne(m, 'STR-C5.balconyCantilever');
  assert.match(run(m).issues.all()[0].message, /180 mm/, 'the message must state the minimum thickness');
  assert.equal(run(m).result.derived.balconyThicknessFails, 1);
});

test('STR-C5: a cantilever longer than min(maxCantilever, backspan/2) is one violation', () => {
  const m = goodModel();
  // 4 m projection off a 16 m plate: the limit is min(2.0, 8.0) = 2.0 m
  m.balconies = [balcony('BALC-1', { x: 4, y: 16, w: 3, h: 4 })];
  m.slabs.push(slab('BALC-1', 'L02', rectToPolygon({ x: 4, y: 16, w: 3, h: 4 }), 'balcony', 0.4));
  expectOne(m, 'STR-C5.balconyCantilever');
  assert.equal(run(m).result.derived.balconyCantileverFails, 1);
  assert.match(run(m).issues.all()[0].message, /backspan/, 'the message must explain the backspan rule');
});

test('STR-C5: architecture keeps the geometry, structure keeps the count', () => {
  const m = goodModel();
  m.balconies = [
    balcony('BALC-1', { x: 1, y: 16, w: 3, h: 1.5 }),
    balcony('BALC-2', { x: 6, y: 16, w: 3, h: 1.5 }),
    balcony('BALC-3', { x: 11, y: 16, w: 3, h: 1.5 }),
  ];
  for (const b of m.balconies) m.slabs.push(slab(b.id, 'L02', rectToPolygon(b.rect), 'balcony', 0.2));
  const { result } = run(m);
  assert.equal(result.derived.balconiesVerified, 3, 'every balcony architecture emits must be verified');
  assert.equal(result.derived.balconyCantileverFails, 0);
  assert.equal(result.derived.balconyThicknessFails, 0);
});

test('a thin balcony repeated on many storeys is ONE issue with a count', () => {
  const m = goodModel();
  m.balconies = [];
  for (let i = 0; i < 12; i++) {
    const b = balcony(`BALC-${i}`, { x: 1 + i, y: 16, w: 0.9, h: 1.5 });
    m.balconies.push(b);
    m.slabs.push(slab(b.id, 'L02', rectToPolygon(b.rect), 'balcony', 0.15));
  }
  const { issues } = run(m);
  const hit = issues.byRule('STR-C5.balconyCantilever');
  assert.equal(hit.length, 1, 'the ledger must deduplicate');
  assert.equal(hit[0].count, 12, 'and count the repeats');
});

// ----------------------------------------------------------------------------
// Determinism and cost
// ----------------------------------------------------------------------------

test('the check is deterministic and linear in the number of supports', () => {
  const m = goodModel();
  const a = run(m);
  const b = run(m);
  assert.equal(JSON.stringify(a.result.derived), JSON.stringify(b.result.derived));
  assert.deepEqual(a.result.nodes.map(n => `${n.support.id}<${n.carriedBy}`), b.result.nodes.map(n => `${n.support.id}<${n.carriedBy}`));

  // 20 storeys x 100 columns
  const big: Model = { columns: [], walls: [], beams: [], slabs: [], foundations: [], balconies: [] };
  const storeys: StoreyDef[] = [];
  for (let k = 0; k < 20; k++) {
    const id = `L${String(k + 1).padStart(2, '0')}`;
    storeys.push({ id, name: id, index: k, elevation: k * 3, height: 3, use: 'residential' });
    for (let i = 0; i < 10; i++) {
      for (let j = 0; j < 10; j++) big.columns.push(col(`C-${id}-${i}-${j}`, id, [i * 8 + 0.5, j * 8 + 0.5]));
    }
    big.slabs.push(slab(`S-${id}`, id, rectToPolygon({ x: 0, y: 0, w: 74, h: 74 }), k === 0 ? 'ground' : 'floor'));
  }
  for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) big.foundations.push(pad(`P-${i}-${j}`, [i * 8 + 0.5, j * 8 + 0.5]));
  const t0 = performance.now();
  const r = checkLoadPath({
    storeysAscending: storeys, columns: big.columns, walls: [], beams: [], slabs: big.slabs,
    foundations: big.foundations, balconies: [], presize: PRESIZE, rules, ledger: collectingLedger(),
  });
  const ms = performance.now() - t0;
  assert.equal(r.derived.supports, 2000);
  assert.equal(r.derived.unsupportedSupports, 0);
  assert.ok(ms < 150, `checkLoadPath took ${ms.toFixed(0)} ms on 2 000 supports (budget 150 ms)`);
});
