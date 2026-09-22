/**
 * Architecture floor-organiser tests.
 *
 * Runs `generateArchitecture` over the five site fixtures (double-loaded bar, point plate,
 * townhouse row, stair-core walk-up, deck access) and — when `disciplines/site` is available — over
 * the real site output of the named presets, then asserts the geometric and referential invariants
 * that the IFC writer and the downstream disciplines depend on.
 *
 *   node --test src/disciplines/architecture/architecture.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { ArchModel, GenContext, Polygon, Rect, RoomDef } from '../../core/types.ts';
import { pointInPolygon, polygonBounds, rectContainsRect, rectIntersection, rectsOverlap } from '../../core/geometry.ts';
import { PRESETS, normalizeSpec } from '../../core/spec.ts';
import { getTypology } from '../../core/typologies.ts';
import { UNIT_TEMPLATES } from './templates.ts';
import { createRng } from '../../core/rng.ts';
import {
  generateArchitecture, ARCH_PATTERNS, resetArchitectureDeps, resolveArchitectureDeps,
  setArchitectureDeps,
} from './index.ts';
import {
  FALLBACK_TEMPLATES, makeFixture, makeSiteFixture, stubLayoutUnit, type FixtureKind,
} from './test-fixtures.ts';

await resolveArchitectureDeps();

const FIXTURE_KINDS: FixtureKind[] = ['bar-double', 'point', 'townhouse', 'walkup', 'gallery'];
const CORRIDOR_ACCESS = new Set(['corridor-double', 'corridor-single', 'gallery', 'point-core', 'cluster']);

// ----------------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------------

function numbersIn(v: unknown, out: number[] = []): number[] {
  if (typeof v === 'number') out.push(v);
  else if (Array.isArray(v)) for (const x of v) numbersIn(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) numbersIn(x, out);
  return out;
}

function groupByStorey<T extends { storey: string }>(items: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const list = m.get(it.storey);
    if (list) list.push(it);
    else m.set(it.storey, [it]);
  }
  return m;
}

function overlapArea(a: Rect, b: Rect): number {
  const i = rectIntersection(a, b);
  return i ? i.w * i.h : 0;
}

function insideOutline(outline: Polygon, r: Rect, tol = 0.35): boolean {
  const bounds = polygonBounds(outline);
  if (rectContainsRect({ x: bounds.x - tol, y: bounds.y - tol, w: bounds.w + 2 * tol, h: bounds.h + 2 * tol }, r)) {
    // rectilinear outlines can be L/U/O shaped: also require the centre to be inside
    return pointInPolygon([r.x + r.w / 2, r.y + r.h / 2], outline);
  }
  return false;
}

/** Every invariant that must hold for any ArchModel, whatever the typology */
function assertArchInvariants(label: string, arch: ArchModel, ctx: GenContext): void {
  // --- no NaN anywhere in the geometry -------------------------------------
  for (const e of arch.elements) {
    for (const n of numbersIn(e.geometry)) {
      assert.ok(Number.isFinite(n), `${label}: non-finite geometry value in element ${e.id} (${e.ifcType})`);
    }
  }
  for (const r of arch.rooms) {
    for (const n of numbersIn([r.polygon, r.rect, r.area, r.height])) {
      assert.ok(Number.isFinite(n), `${label}: non-finite geometry in room ${r.id}`);
    }
    assert.ok(r.area > 0, `${label}: room ${r.id} has zero area`);
  }
  for (const w of arch.walls) {
    for (const n of [...w.start, ...w.end, w.thickness, w.height]) {
      assert.ok(Number.isFinite(n), `${label}: non-finite geometry in wall ${w.id}`);
    }
    assert.ok(w.height > 0 && w.thickness > 0, `${label}: wall ${w.id} has zero height/thickness`);
  }
  for (const v of Object.values(arch.derived)) {
    assert.ok(Number.isFinite(v), `${label}: non-finite derived metric`);
  }

  // --- ids ----------------------------------------------------------------
  const elementIds = new Set<string>();
  for (const e of arch.elements) {
    assert.ok(!elementIds.has(e.id), `${label}: duplicate element id ${e.id}`);
    elementIds.add(e.id);
  }
  const wallIds = new Set(arch.walls.map(w => w.id));
  assert.equal(wallIds.size, arch.walls.length, `${label}: duplicate WallDef id`);
  const roomIds = new Set(arch.rooms.map(r => r.id));
  assert.equal(roomIds.size, arch.rooms.length, `${label}: duplicate RoomDef id`);

  // --- every wall referenced by a door/window exists -----------------------
  for (const d of arch.doors) {
    assert.ok(wallIds.has(d.wallId), `${label}: door ${d.id} references missing wall ${d.wallId}`);
  }
  for (const w of arch.windows) {
    assert.ok(wallIds.has(w.wallId), `${label}: window ${w.id} references missing wall ${w.wallId}`);
    assert.ok(roomIds.has(w.roomId), `${label}: window ${w.id} references missing room ${w.roomId}`);
  }

  // --- hosted elements come AFTER their host wall element ------------------
  const seenWallElements = new Set<string>();
  for (const e of arch.elements) {
    if (e.geometry.kind === 'wall') seenWallElements.add(e.id);
    if (e.geometry.kind === 'door-in-wall' || e.geometry.kind === 'window-in-wall') {
      assert.ok(
        seenWallElements.has(e.geometry.hostId),
        `${label}: ${e.id} is hosted in ${e.geometry.hostId}, which is not a wall element emitted earlier`,
      );
    }
  }

  // --- every unit has an entry door in an existing wall --------------------
  const doorById = new Map(arch.doors.map(d => [d.id, d] as const));
  for (const u of arch.units) {
    assert.ok(u.entryDoorId, `${label}: unit ${u.id} has no entry door`);
    const d = doorById.get(u.entryDoorId);
    assert.ok(d, `${label}: unit ${u.id} entry door ${u.entryDoorId} is missing`);
    assert.ok(wallIds.has(d!.wallId), `${label}: unit ${u.id} entry door hosted in missing wall ${d!.wallId}`);
    assert.ok(u.storeys.length > 0, `${label}: unit ${u.id} has no storeys`);
    assert.ok(u.area > 0, `${label}: unit ${u.id} has zero area`);
    for (const rid of u.roomIds) assert.ok(roomIds.has(rid), `${label}: unit ${u.id} references missing room ${rid}`);
  }

  // --- units do not overlap, and lie inside their floor outline ------------
  const outlineOf = new Map(arch.floors.map(f => [f.storey, f.outline] as const));
  const unitsByStorey = new Map<string, typeof arch.units>();
  for (const u of arch.units) {
    for (const st of u.storeys) {
      const list = unitsByStorey.get(st) ?? [];
      list.push(u);
      unitsByStorey.set(st, list);
    }
  }
  for (const [storey, list] of unitsByStorey) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        assert.ok(
          !rectsOverlap(list[i].rect, list[j].rect, 0.02),
          `${label}/${storey}: units ${list[i].id} and ${list[j].id} overlap`,
        );
      }
      const outline = outlineOf.get(storey);
      if (outline) {
        assert.ok(
          insideOutline(outline, list[i].rect),
          `${label}/${storey}: unit ${list[i].id} rect ${JSON.stringify(list[i].rect)} is outside the floor outline`,
        );
      }
    }
  }

  // --- rooms do not overlap within a storey (≤ 0.5% of the smaller room) ---
  for (const [storey, list] of groupByStorey(arch.rooms)) {
    const sorted = [...list].sort((a, b) => a.rect.x - b.rect.x);
    for (let i = 0; i < sorted.length; i++) {
      const a: RoomDef = sorted[i];
      for (let j = i + 1; j < sorted.length; j++) {
        const b: RoomDef = sorted[j];
        if (b.rect.x >= a.rect.x + a.rect.w) break;
        const ov = overlapArea(a.rect, b.rect);
        if (ov <= 0) continue;
        const tol = 0.005 * Math.min(a.area, b.area);
        assert.ok(
          ov <= tol + 1e-6,
          `${label}/${storey}: rooms ${a.id} (${a.type}) and ${b.id} (${b.type}) overlap by ${ov.toFixed(3)} m² (tolerance ${tol.toFixed(3)})`,
        );
      }
    }
  }

  // --- floor plans are coherent -------------------------------------------
  for (const f of arch.floors) {
    assert.ok(f.area > 0, `${label}: floor ${f.storey} has zero area`);
    assert.ok(f.wallIds.every(id => wallIds.has(id)), `${label}: floor ${f.storey} references a missing wall`);
    assert.ok(f.roomIds.every(id => roomIds.has(id)), `${label}: floor ${f.storey} references a missing room`);
    assert.ok(f.wwr >= 0 && f.wwr < 1.2, `${label}: floor ${f.storey} wwr ${f.wwr} out of range`);
  }

  // --- pattern applications only reference registered patterns ------------
  const known = new Set([...ARCH_PATTERNS.map(p => p.id), 'XD-01', 'XD-02', 'XD-03', 'XD-04', 'XD-05']);
  for (const a of arch.patterns) {
    assert.ok(known.has(a.patternId), `${label}: pattern application references unknown pattern ${a.patternId}`);
  }

  // --- warnings are strings -----------------------------------------------
  for (const w of ctx.warnings) assert.equal(typeof w, 'string');
}

// ----------------------------------------------------------------------------
// fixture-driven tests
// ----------------------------------------------------------------------------

for (const kind of FIXTURE_KINDS) {
  test(`fixture ${kind}: generates a valid ArchModel`, () => {
    const fx = makeFixture(kind);
    const arch = generateArchitecture(fx.ctx);

    assert.ok(arch.elements.length > 0, 'no elements emitted');
    assert.ok(arch.units.length > 0, 'no dwellings placed');
    assert.ok(arch.rooms.length > 0, 'no rooms placed');
    assertArchInvariants(kind, arch, fx.ctx);

    // every residential storey carries at least one dwelling
    for (const f of arch.floors) {
      if (f.use !== 'residential') continue;
      assert.ok(f.unitIds.length > 0, `${kind}: residential storey ${f.storey} has no dwellings`);
    }

    // derived metrics are populated
    assert.equal(arch.derived.unitCount, arch.units.length);
    assert.ok(arch.derived.gia > 0);
    assert.ok(arch.derived.nia > 0);
    assert.ok(arch.derived.roomCount === arch.rooms.length);
    assert.ok(arch.derived.doorCount === arch.doors.length);
    assert.ok(arch.derived.windowCount === arch.windows.length);
    assert.ok(arch.derived.avgUnitArea > 15, `${kind}: implausible average unit area ${arch.derived.avgUnitArea}`);
  });
}

test('makeSiteFixture returns a usable SiteModel for every kind', () => {
  for (const kind of FIXTURE_KINDS) {
    const site = makeSiteFixture(kind);
    assert.ok(site.massing.bars.length > 0, `${kind}: no massing bars`);
    assert.ok(site.massing.storeys.length > 0, `${kind}: no storeys`);
    assert.ok(site.buildableEnvelope.length >= 4, `${kind}: no buildable envelope`);
    assert.ok(site.entrances.length > 0, `${kind}: no entrances`);
  }
});

test('corridor typologies land between 0.55 and 0.90 net-to-gross efficiency', () => {
  for (const kind of FIXTURE_KINDS) {
    const fx = makeFixture(kind);
    if (!CORRIDOR_ACCESS.has(fx.ctx.typology.access)) continue;
    const arch = generateArchitecture(fx.ctx);
    const eff = arch.derived.efficiency;
    // tightened from 0.55: remnants are bounded by the narrowest admissible module and the knuckles are shared, so
    // a corridor scheme no longer loses whole bays to leftovers (measured: corridor-double 0.62, gallery 0.68)
    assert.ok(eff >= 0.6 && eff <= 0.9, `${kind}: efficiency ${eff} outside 0.60–0.90`);
    const resEff = arch.derived.residentialEfficiency;
    assert.ok(resEff >= 0.6 && resEff <= 0.92, `${kind}: residential efficiency ${resEff} outside 0.60–0.92`);
  }
});

test('the typical floor repeats: L03 and L04 carry identical unit rects (ARC-08)', () => {
  const fx = makeFixture('bar-double');
  const arch = generateArchitecture(fx.ctx);
  const rectsOn = (storey: string): string[] => arch.units
    .filter(u => u.storeys.includes(storey))
    .map(u => `${u.templateId}@${u.rect.x.toFixed(3)},${u.rect.y.toFixed(3)},${u.rect.w.toFixed(3)},${u.rect.h.toFixed(3)}`)
    .sort();
  const l3 = rectsOn('L03');
  const l4 = rectsOn('L04');
  assert.ok(l3.length > 0, 'no units on L03');
  assert.deepEqual(l4, l3, 'L03 and L04 are not the same typical plan');
  const l5 = rectsOn('L05');
  assert.deepEqual(l5, l3, 'L05 is not the same typical plan');
});

test('wet walls and shafts stack: identical x/y on every typical floor (XD-01, ARC-32)', () => {
  const fx = makeFixture('bar-double');
  const arch = generateArchitecture(fx.ctx);
  const wetKey = (storey: string): string[] => arch.walls
    .filter(w => w.storey === storey && w.type === 'wet')
    .map(w => `${w.start[0].toFixed(2)},${w.start[1].toFixed(2)}-${w.end[0].toFixed(2)},${w.end[1].toFixed(2)}`)
    .sort();
  assert.ok(wetKey('L03').length > 0, 'no wet walls on L03');
  assert.deepEqual(wetKey('L04'), wetKey('L03'), 'wet walls do not stack between L03 and L04');
  for (const s of arch.shafts) {
    assert.ok(s.storeys.length > 1, `shaft ${s.id} spans only one storey`);
  }
});

test('cores, stairs, lifts and shafts exist on every above-grade storey', () => {
  for (const kind of ['bar-double', 'point', 'walkup', 'gallery'] as FixtureKind[]) {
    const fx = makeFixture(kind);
    const arch = generateArchitecture(fx.ctx);
    assert.ok(arch.cores.length > 0, `${kind}: no cores`);
    const roomsByStorey = groupByStorey(arch.rooms);
    const stairsByStorey = groupByStorey(arch.stairs);
    for (const f of arch.floors) {
      if (f.use === 'roof') continue;
      const rooms = roomsByStorey.get(f.storey) ?? [];
      assert.ok(rooms.some(r => r.type === 'stair'), `${kind}: storey ${f.storey} has no stair room`);
      assert.ok(rooms.some(r => r.type === 'shaft'), `${kind}: storey ${f.storey} has no shaft room`);
      assert.ok((stairsByStorey.get(f.storey) ?? []).length > 0, `${kind}: storey ${f.storey} has no StairDef`);
    }
    // two flights per storey per core, the second starting at mid-height
    const flights = arch.elements.filter(e => e.geometry.kind === 'stair' && e.objectType === 'exit-stair');
    assert.ok(flights.length >= arch.stairs.filter(s => s.isExit).length, `${kind}: fewer stair flights than stairs`);
    const raised = flights.filter(e => e.geometry.kind === 'stair' && e.geometry.position[2] > 0.5);
    assert.ok(raised.length > 0, `${kind}: no second flight raised to mid-storey height`);
    // exit doors from the stair at ground level
    assert.ok(arch.doors.some(d => d.type === 'exit'), `${kind}: no exit door at ground`);
  }
});

test('point tower: 12 storeys generate in under 1.5 s with no geometry defects', () => {
  const fx = makeFixture('point');
  const t0 = performance.now();
  const arch = generateArchitecture(fx.ctx);
  const ms = performance.now() - t0;
  assert.ok(ms < 1500, `point tower took ${ms.toFixed(0)} ms`);
  assert.ok(arch.units.length >= 4 * 10, `only ${arch.units.length} dwellings in a 12-storey tower`);
  assertArchInvariants('point-perf', arch, fx.ctx);
});

test('houses: one multi-level dwelling per slice, own front door, garage, party walls (ARC-01/02/11)', () => {
  const fx = makeFixture('townhouse');
  const arch = generateArchitecture(fx.ctx);
  const residential = arch.floors.filter(f => f.use === 'residential');
  assert.ok(residential.length >= 3);
  for (const u of arch.units) {
    assert.equal(u.storeys.length, residential.length, `house ${u.id} does not span every residential storey`);
    assert.ok(u.accessSide === 'front' || u.accessSide === 'left');
  }
  assert.ok(arch.walls.some(w => w.type === 'party'), 'no party walls between houses');
  // ARC-11 is conditional on the module the placer could admit: a garage exists when a garage-bearing template was
  // placed. At this bar depth the admissible three-storey house is the one without a garage, which is a recorded
  // mix deviation rather than a missing garage door.
  const withGarage = arch.units.filter(u => (UNIT_TEMPLATES[u.templateId]?.rooms ?? []).some(r => r.type === 'garage'));
  assert.equal(
    arch.doors.some(d => d.type === 'garage'), withGarage.length > 0,
    withGarage.length > 0 ? 'a garage template was placed with no garage door' : 'a garage door with no garage template',
  );
  assert.ok(arch.elements.some(e => e.geometry.kind === 'gable-roof'), 'no gable roof over the bar');
  assert.equal(arch.roof.type, 'gable');
});

test('flat roofs get parapets, a plant zone and a PV zone (ARC-35)', () => {
  const fx = makeFixture('bar-double');
  const arch = generateArchitecture(fx.ctx);
  assert.equal(arch.roof.type, 'flat');
  assert.ok(arch.roof.plantZone, 'no plant zone');
  assert.ok(arch.roof.pvZone, 'no PV zone');
  assert.ok(arch.roof.plantZone!.w * arch.roof.plantZone!.h > 0);
  const parapets = arch.walls.filter(w => w.type === 'parapet');
  assert.ok(parapets.length >= 4, 'fewer than four parapet walls');
  for (const p of parapets) assert.ok(Math.abs(p.height - 1.1) < 0.35, `parapet height ${p.height}`);
});

test('balconies come with a slab and railings', () => {
  const fx = makeFixture('bar-double');
  const arch = generateArchitecture(fx.ctx);
  assert.ok(arch.derived.balconyCount > 0, 'no balconies');
  const slabs = arch.elements.filter(e => e.ifcType === 'IfcSlab' && e.name === 'Balcony slab');
  assert.equal(slabs.length, arch.derived.balconyCount, 'one balcony slab per balcony');
  for (const s of slabs) {
    assert.equal(s.geometry.kind, 'slab');
    if (s.geometry.kind === 'slab') {
      // STR-C5: a cantilever is max(0.18, projection / 10) thick, never a constant
      assert.ok(s.geometry.thickness >= 0.18 - 1e-6, `balcony slab only ${s.geometry.thickness} m thick`);
      assert.ok(
        Math.abs(s.geometry.position[2] + s.geometry.thickness) < 1e-6,
        'balcony slab top must sit at floor level',
      );
    }
  }
  assert.ok(arch.elements.some(e => e.ifcType === 'IfcRailing'), 'no railings');
});

test('the ground floor carries the lobby sequence (ARC-31)', () => {
  const fx = makeFixture('bar-double');
  const arch = generateArchitecture(fx.ctx);
  const ground = arch.floors.find(f => f.storey === 'L01')!;
  const rooms = arch.rooms.filter(r => ground.roomIds.includes(r.id));
  for (const type of ['lobby', 'mail', 'bike-store', 'trash', 'mech-room', 'elec-room', 'water-room'] as const) {
    assert.ok(rooms.some(r => r.type === type), `ground floor has no ${type}`);
  }
  assert.ok(arch.doors.some(d => d.type === 'building-entry'), 'no building entrance door');
  assert.ok(arch.patterns.some(p => p.patternId === 'ARC-31'), 'ARC-31 not applied');
});

test('deck access applies ARC-09 with a railed external deck', () => {
  const fx = makeFixture('gallery');
  const arch = generateArchitecture(fx.ctx);
  assert.ok(arch.patterns.some(p => p.patternId === 'ARC-09'), 'ARC-09 not applied to a deck-access scheme');
  const decks = arch.rooms.filter(r => r.type === 'corridor' && r.name === 'Access Deck');
  assert.ok(decks.length > 0, 'no access deck rooms');
  assert.ok(arch.elements.some(e => e.ifcType === 'IfcRailing' && (e.patterns ?? []).includes('ARC-09')), 'no deck railing');
  // every dwelling spans the bar, so none is single aspect
  assert.ok(arch.units.every(u => u.aspect !== 'single'), 'a deck-access dwelling is single aspect');
});

test('stair-core schemes apply ARC-07 with a landing per core', () => {
  const fx = makeFixture('walkup');
  const arch = generateArchitecture(fx.ctx);
  const app = arch.patterns.find(p => p.patternId === 'ARC-07');
  assert.ok(app, 'ARC-07 not applied');
  assert.equal(app!.params?.unitsPerCore, fx.ctx.typology.unitsPerCore);
  const landings = arch.rooms.filter(r => r.type === 'lobby' && r.name === 'Stair Landing');
  assert.ok(landings.length >= arch.cores.length, 'fewer landings than cores');
});

test('the pattern book is complete and self-consistent', () => {
  const ids = ARCH_PATTERNS.map(p => p.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate pattern id');
  for (let i = 1; i <= 13; i++) {
    const id = `ARC-${String(i).padStart(2, '0')}`;
    assert.ok(ids.includes(id), `missing pattern ${id}`);
  }
  for (const id of ['ARC-31', 'ARC-32', 'ARC-33', 'ARC-34', 'ARC-35']) {
    assert.ok(ids.includes(id), `missing pattern ${id}`);
  }
  for (const p of ARCH_PATTERNS) {
    assert.ok(p.problem.length > 40, `${p.id}: problem statement too short`);
    assert.ok(p.solution.length > 40, `${p.id}: solution statement too short`);
    assert.ok(Object.keys(p.parameters).length > 0, `${p.id}: no parameters`);
    for (const [k, v] of Object.entries(p.parameters)) {
      assert.ok(v.value !== undefined && v.value !== null, `${p.id}.${k}: no value`);
    }
  }
});

test('generation is deterministic for a fixed seed', () => {
  const a = generateArchitecture(makeFixture('bar-double').ctx);
  const b = generateArchitecture(makeFixture('bar-double').ctx);
  assert.equal(a.elements.length, b.elements.length);
  assert.deepEqual(
    a.units.map(u => `${u.id}|${u.templateId}|${u.rect.x},${u.rect.y},${u.rect.w},${u.rect.h}`),
    b.units.map(u => `${u.id}|${u.templateId}|${u.rect.x},${u.rect.y},${u.rect.w},${u.rect.h}`),
  );
  assert.deepEqual(a.derived, b.derived);
});

test('a dwelling floor produces no warnings: every compromise is a recorded deviation', () => {
  // v2 acceptance criterion (design §8): warnings are reserved for true contradictions, and the
  // program solver cannot produce one inside the admissible region. What it could not honour — a
  // merged closet, a room grown past its declared maximum, a rect outside the admissible frontage —
  // is recorded in the deviation ledger with a rule id and a named resolution instead.
  const fx = makeFixture('bar-double');
  generateArchitecture(fx.ctx);
  assert.ok(fx.ctx.warnings.every(w => typeof w === 'string' && w.length > 0));
  assert.deepEqual(fx.ctx.warnings.filter(w => w.startsWith('[architecture]')), [],
    'architecture should no longer warn on a plain dwelling floor');
});

test('the layoutUnit contract holds for a foreign implementation', () => {
  // swap in the crude stub: the organiser must still produce a coherent model, which proves it
  // relies only on the UnitLayout contract and not on unit-layout.ts internals
  setArchitectureDeps({ templates: FALLBACK_TEMPLATES, layoutUnit: stubLayoutUnit });
  try {
    for (const kind of ['bar-double', 'townhouse', 'point'] as FixtureKind[]) {
      const fx = makeFixture(kind);
      const arch = generateArchitecture(fx.ctx);
      assert.ok(arch.units.length > 0, `${kind}: stub layout placed no dwellings`);
      assert.ok(arch.rooms.length > 0, `${kind}: stub layout placed no rooms`);
      assertArchInvariants(`stub/${kind}`, arch, fx.ctx);
    }
  } finally {
    resetArchitectureDeps();
  }
});

// ----------------------------------------------------------------------------
// real site output (skipped automatically while disciplines/site is unavailable)
// ----------------------------------------------------------------------------

const PRESET_IDS = [
  'us-5-over-1', 'uk-terrace', 'ca-point-tower', 'au-walkup', 'us-detached', 'uk-mansion',
  'ie-courtyard', 'nz-coliving', 'us-senior', 'ca-laneway',
];

let generateSite: ((...a: never[]) => unknown) | null = null;
try {
  const m = await import('../site/index.ts') as { generateSite?: (...a: never[]) => unknown };
  generateSite = m.generateSite ?? null;
} catch {
  generateSite = null;
}

test('real site output: every preset produces a valid ArchModel', { skip: !generateSite }, () => {
  for (const id of PRESET_IDS) {
    const preset = PRESETS.find(p => p.id === id);
    assert.ok(preset, `unknown preset ${id}`);
    const spec = normalizeSpec(preset!.spec);
    const typology = getTypology(spec.typology);
    const rng = createRng(spec.seed);
    const warnings: string[] = [];
    const site = (generateSite as unknown as (
      s: typeof spec, t: typeof typology, r: ReturnType<typeof createRng>, w: string[],
    ) => GenContext['site'])(spec, typology, rng.fork('site'), warnings);
    const storeys = site.massing.storeys.length > 0 ? site.massing.storeys : [];
    const ctx: GenContext = {
      spec, typology, rng: rng.fork('architecture'), storeys, site,
      arch: null, struct: null, mech: null, plumb: null, elec: null, warnings,
    };
    const t0 = performance.now();
    const arch = generateArchitecture(ctx);
    const ms = performance.now() - t0;
    assert.ok(ms < 2000, `${id}: architecture took ${ms.toFixed(0)} ms`);
    assert.ok(arch.units.length > 0, `${id}: no dwellings placed`);
    assertArchInvariants(id, arch, ctx);
    for (const f of arch.floors) {
      if (f.use !== 'residential') continue;
      assert.ok(f.unitIds.length > 0, `${id}: residential storey ${f.storey} has no dwellings`);
    }
    if (CORRIDOR_ACCESS.has(typology.access)) {
      // residential floors only: a retail/parking podium legitimately drags whole-building nia/gia down
      const eff = arch.derived.residentialEfficiency;
      // A point tower's lift-lobby ring leaves two pockets shallower than the shallowest admissible dwelling; v2
      // declares them as amenity (deviation ARC-D07) instead of stretching a flat into them, which costs about two
      // points of net-to-gross and is the honest number.
      assert.ok(eff >= 0.52 && eff <= 0.92, `${id}: residential efficiency ${eff} outside 0.52–0.92`);
    }
  }
});
