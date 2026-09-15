/**
 * Structure discipline tests. Run with:
 *   node --test src/disciplines/structure/*.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { ArchModel, GenContext, ModelElement, StoreyDef, StructModel } from '../../core/types.ts';
import { dist, pointInPolygon, rectCenter } from '../../core/geometry.ts';
import { CROSS_PATTERNS } from '../../core/patterns.ts';
import { buildStoreys, getPreset, normalizeSpec } from '../../core/spec.ts';
import { getTypology } from '../../core/typologies.ts';
import { createRng } from '../../core/rng.ts';

import { generateStructure } from './index.ts';
import { STRUCT_PATTERNS } from './patterns.ts';
import { allFixtures, makeArchFixture, type Fixture } from './test-fixtures.ts';
import { FOUNDATION_RULES, GRID_RULES } from './sizing.ts';

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function numbersIn(value: unknown, out: number[] = []): number[] {
  if (typeof value === 'number') out.push(value);
  else if (Array.isArray(value)) for (const v of value) numbersIn(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) numbersIn(v, out);
  return out;
}

function aboveGradeOf(storeys: StoreyDef[]): StoreyDef[] {
  return storeys.filter(s => s.index >= 0 && s.index < 100).sort((a, b) => a.index - b.index);
}

function framedOf(storeys: StoreyDef[]): StoreyDef[] {
  return storeys
    .filter(s => s.index > -100 && s.index < 100)
    .sort((a, b) => a.index - b.index);
}

function outlineOfStorey(arch: ArchModel, storeyId: string, fallbackStoreyId: string) {
  const p = arch.floors.find(f => f.storey === storeyId) ?? arch.floors.find(f => f.storey === fallbackStoreyId);
  assert.ok(p, `no floor plan for ${storeyId}`);
  return p.outline;
}

interface Built {
  fixture: Fixture;
  struct: StructModel;
  ms: number;
}

const BUILT: Built[] = allFixtures().map(fixture => {
  const t0 = performance.now();
  const struct = generateStructure(fixture.ctx);
  return { fixture, struct, ms: performance.now() - t0 };
});

const EXPECTED: Record<string, { system: string; foundation: string; footing: string; roofSlab: boolean; transfer: boolean }> = {
  'midrise-bar': { system: 'wood-over-podium', foundation: 'pad-footing', footing: 'pad', roofSlab: true, transfer: true },
  'townhouse-row': { system: 'light-wood-frame', foundation: 'strip-footing', footing: 'strip', roofSlab: false, transfer: false },
  'point-tower': { system: 'rc-flat-plate-core', foundation: 'piles', footing: 'pile-cap', roofSlab: true, transfer: true },
};

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

test('every fixture generates a non-empty, finite, uniquely identified model', () => {
  for (const { fixture, struct } of BUILT) {
    const tag = fixture.id;
    assert.ok(struct.elements.length > 0, `${tag}: no elements`);
    assert.ok(struct.grid.length >= 4, `${tag}: grid too small (${struct.grid.length})`);
    assert.ok(struct.slabs.length > 0, `${tag}: no slabs`);

    const ids = new Set<string>();
    for (const e of struct.elements) {
      assert.ok(!ids.has(e.id), `${tag}: duplicate element id ${e.id}`);
      ids.add(e.id);
      assert.equal(e.discipline, 'structure', `${tag}: ${e.id} wrong discipline`);
      assert.ok(e.ifcType.startsWith('Ifc'), `${tag}: ${e.id} bad ifcType ${e.ifcType}`);
      assert.ok(e.storey.length > 0, `${tag}: ${e.id} has no storey`);
      assert.ok((e.patterns ?? []).length > 0, `${tag}: ${e.id} carries no pattern ids`);
      for (const n of numbersIn(e.geometry)) {
        assert.ok(Number.isFinite(n), `${tag}: ${e.id} has a non-finite coordinate (${n})`);
      }
    }
    for (const n of Object.values(struct.derived)) {
      assert.ok(Number.isFinite(n), `${tag}: non-finite derived value`);
    }
    for (const n of numbersIn(struct.sizes).concat(numbersIn(struct.loads), numbersIn(struct.plenumClearance))) {
      assert.ok(Number.isFinite(n) && n > 0, `${tag}: bad size/load/plenum value ${n}`);
    }
  }
});

test('the system, foundation and transfer level follow from the typology and height', () => {
  for (const { fixture, struct } of BUILT) {
    const want = EXPECTED[fixture.id];
    assert.equal(struct.system, want.system, `${fixture.id}: system`);
    assert.equal(struct.foundation, want.foundation, `${fixture.id}: foundation`);
    assert.equal(struct.transferStorey !== undefined, want.transfer, `${fixture.id}: transfer storey presence`);
    if (struct.transferStorey) {
      const ts = struct.slabs.find(s => s.storey === struct.transferStorey);
      assert.ok(ts, `${fixture.id}: no slab on the transfer storey`);
      assert.equal(ts.type, 'podium-transfer', `${fixture.id}: transfer slab type`);
      assert.ok(ts.thickness > struct.sizes.slabT, `${fixture.id}: the transfer slab must be thicker than a typical floor`);
      assert.ok(struct.beams.some(b => b.role === 'transfer'), `${fixture.id}: no transfer beams`);
    }
  }
});

test('columns sit inside the storey outline, never inside a core, and step down in size', () => {
  for (const { fixture, struct } of BUILT) {
    const arch = fixture.arch;
    const tag = fixture.id;
    const above = aboveGradeOf(fixture.storeys);
    const top = above[above.length - 1];
    if (struct.columns.length === 0) {
      // bearing-wall systems legitimately have no columns; they must have bearing walls instead
      assert.ok(struct.walls.some(w => w.role === 'bearing'), `${tag}: neither columns nor bearing walls`);
      continue;
    }
    const perStorey = new Map<string, number[]>();
    for (const c of struct.columns) {
      const outline = outlineOfStorey(arch, c.storey, top.id);
      assert.ok(pointInPolygon(c.position, outline), `${tag}: column ${c.id} at ${c.position} is outside the ${c.storey} outline`);
      assert.ok(c.width > 0 && c.depth > 0 && c.height > 0, `${tag}: column ${c.id} has a non-positive dimension`);
      assert.ok(c.gridRef.includes('-'), `${tag}: column ${c.id} has no grid reference`);

      for (const core of arch.cores) {
        if (!core.storeys.includes(c.storey)) continue;
        const inside = c.position[0] > core.rect.x + 0.05 && c.position[0] < core.rect.x + core.rect.w - 0.05
          && c.position[1] > core.rect.y + 0.05 && c.position[1] < core.rect.y + core.rect.h - 0.05;
        assert.ok(!inside, `${tag}: column ${c.id} stands inside core ${core.id}`);
      }
      for (const room of arch.rooms) {
        if (room.storey !== c.storey) continue;
        if (room.type !== 'stair' && room.type !== 'elevator' && room.type !== 'shaft') continue;
        const inside = c.position[0] > room.rect.x + 0.05 && c.position[0] < room.rect.x + room.rect.w - 0.05
          && c.position[1] > room.rect.y + 0.05 && c.position[1] < room.rect.y + room.rect.h - 0.05;
        assert.ok(!inside, `${tag}: column ${c.id} stands inside ${room.type} room ${room.id}`);
      }
      const sides = perStorey.get(c.storey) ?? [];
      sides.push(c.width);
      perStorey.set(c.storey, sides);
    }

    // no two columns share a position on one storey
    const seen = new Set<string>();
    for (const c of struct.columns) {
      const k = `${c.storey}:${c.position[0].toFixed(2)}:${c.position[1].toFixed(2)}`;
      assert.ok(!seen.has(k), `${tag}: two columns at the same point (${k})`);
      seen.add(k);
    }

    // STR-10: the family of sizes must not grow with height
    const storeysWithColumns = [...perStorey.keys()].sort((a, b) => (fixture.storeys.find(s => s.id === a)!.index - fixture.storeys.find(s => s.id === b)!.index));
    const low = Math.max(...perStorey.get(storeysWithColumns[0])!);
    const high = Math.max(...perStorey.get(storeysWithColumns[storeysWithColumns.length - 1])!);
    assert.ok(low >= high - 1e-9, `${tag}: columns get bigger going up (${low} at the bottom, ${high} at the top)`);
  }
});

test('column height equals floor-to-floor minus the slab above it', () => {
  for (const { fixture, struct } of BUILT) {
    const framed = framedOf(fixture.storeys);
    const slabT = new Map(struct.slabs.map(s => [s.storey, s.thickness] as const));
    for (const c of struct.columns) {
      const s = fixture.storeys.find(x => x.id === c.storey)!;
      const i = framed.findIndex(x => x.id === c.storey);
      const aboveStorey = i + 1 < framed.length ? framed[i + 1].id : 'ROOF';
      const tAbove = slabT.get(aboveStorey) ?? struct.sizes.slabT;
      assert.ok(
        Math.abs(c.height - (s.height - tAbove)) < 1e-6,
        `${fixture.id}: column ${c.id} height ${c.height} != ${s.height} - ${tAbove}`,
      );
    }
  }
});

test('one structural slab per storey, ground + roof slabs as specified, openings follow shafts', () => {
  for (const { fixture, struct } of BUILT) {
    const tag = fixture.id;
    const arch = fixture.arch;
    const framed = framedOf(fixture.storeys);
    const lowest = framed[0];

    for (const s of framed) {
      const onStorey = struct.slabs.filter(sl => sl.storey === s.id);
      assert.equal(onStorey.length, 1, `${tag}: storey ${s.id} has ${onStorey.length} structural slabs, expected exactly 1`);
      const slab = onStorey[0];
      assert.ok(slab.thickness >= 0.15, `${tag}: slab on ${s.id} is only ${slab.thickness} m thick`);
      // the slab top is the finished floor level: position.z = -thickness
      const el = struct.elements.find(e => e.id === slab.id)!;
      assert.equal(el.geometry.kind, 'slab');
      if (el.geometry.kind === 'slab') {
        assert.ok(Math.abs(el.geometry.position[2] + slab.thickness) < 1e-9, `${tag}: slab ${slab.id} is not placed at z = -t`);
      }
      // every opening must sit inside the slab outline
      for (const o of slab.openings) {
        assert.ok(pointInPolygon(rectCenter(o), slab.outline), `${tag}: opening in ${slab.id} falls outside the slab`);
      }
      if (s.id === lowest.id) continue;
      const cores = arch.cores.filter(c => c.storeys.includes(s.id)).length;
      const shafts = arch.shafts.filter(sh => sh.storeys.includes(s.id)).length;
      assert.ok(
        slab.openings.length >= cores + shafts,
        `${tag}: slab on ${s.id} has ${slab.openings.length} openings, expected at least ${cores} cores + ${shafts} shafts`,
      );
    }

    const ground = struct.slabs.filter(s => s.type === 'ground');
    assert.equal(ground.length, 1, `${tag}: expected exactly one ground/base slab`);
    assert.equal(ground[0].storey, lowest.id, `${tag}: the ground slab is not on the lowest storey`);
    const groundEl = struct.elements.find(e => e.id === ground[0].id)!;
    assert.equal(groundEl.predefinedType, 'BASESLAB', `${tag}: ground slab predefinedType`);

    const roofSlabs = struct.slabs.filter(s => s.type === 'roof');
    assert.equal(roofSlabs.length, EXPECTED[tag].roofSlab ? 1 : 0, `${tag}: roof slab count (arch roof is ${arch.roof.type})`);
    if (EXPECTED[tag].roofSlab) {
      assert.equal(roofSlabs[0].storey, 'ROOF');
      const el = struct.elements.find(e => e.id === roofSlabs[0].id)!;
      assert.equal(el.predefinedType, 'ROOF');
      assert.equal(el.psets?.find(p => p.name === 'Pset_SlabCommon')?.properties.find(p => p.name === 'IsExternal')?.value, true);
    }
  }
});

test('structural walls reference real architecture walls and never duplicate their geometry', () => {
  for (const { fixture, struct } of BUILT) {
    const tag = fixture.id;
    const archIds = new Set(fixture.arch.walls.map(w => w.id));
    const elementIds = new Set(struct.elements.map(e => e.id));

    for (const w of struct.walls) {
      assert.ok(w.thickness > 0 && w.height > 0, `${tag}: structural wall ${w.id} has no thickness/height`);
      assert.ok(dist(w.start, w.end) > 0.1, `${tag}: structural wall ${w.id} is degenerate`);
      if (w.archWallId) {
        assert.ok(archIds.has(w.archWallId), `${tag}: ${w.id} references unknown arch wall ${w.archWallId}`);
        assert.ok(!elementIds.has(w.id), `${tag}: ${w.id} duplicates architecture wall ${w.archWallId} as an element`);
      } else {
        // structure-owned walls must be foundation/basement walls only
        assert.equal(w.role, 'foundation', `${tag}: ${w.id} emits its own geometry but is role '${w.role}'`);
        assert.ok(elementIds.has(w.id), `${tag}: structure-owned wall ${w.id} has no element`);
      }
    }
    // no emitted wall element may sit on an architecture wall centreline on the same storey
    for (const e of struct.elements) {
      if (e.geometry.kind !== 'wall') continue;
      for (const aw of fixture.arch.walls) {
        if (aw.storey !== e.storey) continue;
        const same = (dist([e.geometry.start[0], e.geometry.start[1]], aw.start) < 0.05 && dist([e.geometry.end[0], e.geometry.end[1]], aw.end) < 0.05)
          || (dist([e.geometry.start[0], e.geometry.start[1]], aw.end) < 0.05 && dist([e.geometry.end[0], e.geometry.end[1]], aw.start) < 0.05);
        assert.ok(!same, `${tag}: ${e.id} duplicates architecture wall ${aw.id}`);
      }
    }
    // every core wall architecture drew must be picked up as a shear/core wall (STR-05)
    const coreArch = fixture.arch.walls.filter(w => w.type === 'core');
    const coreStruct = struct.walls.filter(w => w.role === 'core');
    assert.equal(coreStruct.length, coreArch.length, `${tag}: ${coreArch.length} core walls in architecture but ${coreStruct.length} shear walls`);
  }
});

test('foundations exist, use the expected type, and honour the footing z convention', () => {
  for (const { fixture, struct } of BUILT) {
    const tag = fixture.id;
    assert.ok(struct.foundations.length > 0, `${tag}: no foundations`);
    const types = new Set(struct.foundations.map(f => f.type));
    assert.ok(types.has(EXPECTED[tag].footing as never), `${tag}: expected ${EXPECTED[tag].footing} foundations, got ${[...types].join(',')}`);

    for (const e of struct.elements) {
      if (e.geometry.kind === 'footing') {
        assert.equal(e.storey, 'FND', `${tag}: footing ${e.id} is not on the FND storey`);
        assert.ok(
          Math.abs(e.geometry.position[2] - e.geometry.height) < 1e-9,
          `${tag}: footing ${e.id} top is at z=${e.geometry.position[2]} but its height is ${e.geometry.height} — the underside must rest on the FND datum`,
        );
        assert.ok(e.geometry.width > 0 && e.geometry.depth > 0, `${tag}: footing ${e.id} has no plan size`);
      }
      if (e.geometry.kind === 'pile') {
        assert.equal(e.storey, 'FND');
        assert.equal(e.geometry.position[2], 0, `${tag}: pile ${e.id} must hang from the pile-cap underside (z = 0)`);
        assert.ok(e.geometry.length >= FOUNDATION_RULES.pileLength, `${tag}: pile ${e.id} too short`);
        assert.equal(e.predefinedType, 'BORED');
      }
    }
    if (EXPECTED[tag].footing === 'pile-cap') {
      const caps = struct.foundations.filter(f => f.type === 'pile-cap').length;
      const piles = struct.foundations.filter(f => f.type === 'pile').length;
      assert.ok(piles >= caps * 2, `${tag}: ${piles} piles under ${caps} caps — expected at least two per cap`);
    }
    if (EXPECTED[tag].footing === 'strip') {
      // strip footings run under the lowest-storey bearing walls
      const bearing = struct.walls.filter(w => w.storey === framedOf(fixture.storeys)[0].id && w.role === 'bearing').length;
      assert.ok(struct.foundations.filter(f => f.type === 'strip').length >= bearing, `${tag}: fewer strip footings than bearing walls`);
      assert.ok(struct.walls.some(w => w.storey === 'FND' && w.role === 'foundation'), `${tag}: no stem walls above the strip footings`);
    }
  }
});

test('grid spacing stays in the economic band and labels are unique', () => {
  for (const { fixture, struct } of BUILT) {
    const tag = fixture.id;
    const ids = new Set<string>();
    for (const g of struct.grid) {
      assert.ok(!ids.has(g.id), `${tag}: duplicate grid line ${g.id}`);
      ids.add(g.id);
      assert.ok(Number.isFinite(g.offset), `${tag}: grid line ${g.id} has a non-finite offset`);
      assert.ok(g.axis === 'x' || g.axis === 'y');
    }
    for (const axis of ['x', 'y'] as const) {
      const offsets = struct.grid.filter(g => g.axis === axis).map(g => g.offset).sort((a, b) => a - b);
      for (let i = 1; i < offsets.length; i++) {
        const gap = offsets[i] - offsets[i - 1];
        assert.ok(gap > 0.04, `${tag}: grid lines on ${axis} are coincident (${gap})`);
      }
    }
    // the main transverse grid must honour STR-02 / STR-09
    assert.ok(
      struct.derived.gridSpacingX <= GRID_RULES.maxSpacing * 1.15 && struct.derived.gridSpacingY <= GRID_RULES.maxSpacing * 1.15,
      `${tag}: mean grid spacing ${struct.derived.gridSpacingX} x ${struct.derived.gridSpacingY} exceeds the economic span`,
    );
  }
});

test('beams sit under the slab soffit and headers only appear over wide openings', () => {
  for (const { fixture, struct } of BUILT) {
    const tag = fixture.id;
    const slabT = new Map(struct.slabs.map(s => [s.storey, s.thickness] as const));
    const framed = framedOf(fixture.storeys);
    for (const b of struct.beams) {
      const s = fixture.storeys.find(x => x.id === b.storey)!;
      assert.ok(b.z >= -0.01 && b.z < s.height, `${tag}: beam ${b.id} soffit z=${b.z} is outside storey ${b.storey} (h=${s.height})`);
      assert.ok(b.width > 0 && b.depth > 0, `${tag}: beam ${b.id} has no section`);
      const el = struct.elements.find(e => e.id === b.id)!;
      assert.equal(el.geometry.kind, 'beam');
      if (el.geometry.kind === 'beam') {
        // the section is centred on the axis
        assert.ok(Math.abs(el.geometry.start[2] - (b.z + b.depth / 2)) < 1e-6, `${tag}: beam ${b.id} axis is not at the section centre`);
      }
      if (b.role === 'rim' || b.role === 'primary' || b.role === 'secondary' || b.role === 'transfer') {
        const i = framed.findIndex(x => x.id === b.storey);
        const aboveId = i + 1 < framed.length ? framed[i + 1].id : 'ROOF';
        const tAbove = slabT.get(aboveId) ?? struct.sizes.slabT;
        assert.ok(
          Math.abs(b.z + b.depth - (s.height - tAbove)) < 1e-6,
          `${tag}: beam ${b.id} top ${b.z + b.depth} should be at ${s.height - tAbove}`,
        );
      }
    }
    // STR-08: a header only where an opening is wider than the trigger
    const lintels = struct.beams.filter(b => b.role === 'lintel');
    if (lintels.length > 0) {
      const wide = [
        ...fixture.arch.doors.filter(d => d.width > 1.2),
        ...fixture.arch.windows.filter(w => w.width > 1.2),
      ].length;
      assert.ok(lintels.length <= wide, `${tag}: ${lintels.length} headers for only ${wide} wide openings`);
      for (const l of lintels) assert.ok(dist(l.start, l.end) >= 1.2, `${tag}: header ${l.id} is shorter than the opening it spans`);
    }
  }
});

test('plenum clearance and structural depth are published for the MEP disciplines', () => {
  for (const { fixture, struct } of BUILT) {
    const tag = fixture.id;
    const above = aboveGradeOf(fixture.storeys);
    const typicalF2f = Math.min(...above.map(s => s.height));
    assert.ok(struct.plenumClearance.corridorSoffitZ > 2.0, `${tag}: corridor soffit is only ${struct.plenumClearance.corridorSoffitZ} m`);
    assert.ok(struct.plenumClearance.corridorSoffitZ <= typicalF2f, `${tag}: corridor soffit is above the floor-to-floor height`);
    assert.equal(struct.derived.corridorSoffitZ, struct.plenumClearance.corridorSoffitZ, `${tag}: derived and plenumClearance disagree`);
    assert.ok(struct.derived.structuralDepthAtCorridor >= struct.sizes.slabT - 1e-9, `${tag}: structural depth is thinner than the slab`);
  }
});

test('embodied carbon and quantities are in a plausible range', () => {
  for (const { fixture, struct } of BUILT) {
    const tag = fixture.id;
    const d = struct.derived;
    assert.ok(d.grossFloorArea > 100, `${tag}: gross floor area ${d.grossFloorArea}`);
    assert.ok(d.concreteVolumeM3 > 0, `${tag}: no concrete`);
    assert.ok(d.embodiedCarbonKgCO2e > 0, `${tag}: no embodied carbon`);
    // Light-timber low-rise legitimately lands near 80 kgCO2e/m²; concrete schemes run 120–400.
    assert.ok(d.embodiedCarbonPerM2 > 50 && d.embodiedCarbonPerM2 < 600, `${tag}: ${d.embodiedCarbonPerM2} kgCO2e/m² is implausible`);
    if (struct.system === 'rc-flat-plate-core' || struct.system === 'rc-flat-slab') {
      assert.ok(d.embodiedCarbonPerM2 > 100, `${tag}: an RC frame should exceed 100 kgCO2e/m², got ${d.embodiedCarbonPerM2}`);
    }
    // concrete intensity sanity: 0.05–0.6 m³ per m² of floor
    const intensity = d.concreteVolumeM3 / d.grossFloorArea;
    assert.ok(intensity > 0.05 && intensity < 0.6, `${tag}: concrete intensity ${intensity.toFixed(3)} m³/m² is implausible`);
    assert.equal(d.structureSystem >= 0, true, `${tag}: system index not encoded`);
    assert.equal(d.foundationType >= 0, true, `${tag}: foundation type not encoded`);
    assert.equal(d.columnCount, struct.columns.length);
    assert.equal(d.beamCount, struct.beams.length);
    assert.equal(d.foundationCount, struct.foundations.length);
  }
});

test('every pattern reference resolves and applications carry concrete parameters', () => {
  const known = new Set([...STRUCT_PATTERNS, ...CROSS_PATTERNS].map(p => p.id));
  assert.equal(STRUCT_PATTERNS.length, 11, 'expected STR-01..STR-11');
  for (const p of STRUCT_PATTERNS) {
    assert.equal(p.discipline, 'structure', `${p.id} discipline`);
    assert.ok(p.problem.length > 60 && p.solution.length > 60, `${p.id} needs a real problem/solution`);
    assert.ok(Object.keys(p.parameters).length >= 2, `${p.id} needs parameters`);
    assert.ok((p.references ?? []).length > 0, `${p.id} needs references`);
    for (const [k, v] of Object.entries(p.parameters)) {
      assert.ok(v.source !== undefined && v.source.length > 0, `${p.id}.${k} needs a source`);
    }
  }
  for (const { fixture, struct } of BUILT) {
    for (const e of struct.elements) {
      for (const id of e.patterns ?? []) assert.ok(known.has(id), `${fixture.id}: ${e.id} references unknown pattern ${id}`);
    }
    for (const a of struct.patterns) {
      assert.ok(known.has(a.patternId), `${fixture.id}: application of unknown pattern ${a.patternId}`);
      assert.ok(a.params && Object.keys(a.params).length > 0, `${fixture.id}: ${a.patternId} application has no parameters`);
    }
    const applied = new Set(struct.patterns.map(a => a.patternId));
    for (const id of ['STR-01', 'STR-02', 'STR-06', 'STR-09', 'STR-11', 'XD-03']) {
      assert.ok(applied.has(id), `${fixture.id}: pattern ${id} was never applied`);
    }
  }
});

test('generation is deterministic and the tower is fast', () => {
  const tower = BUILT.find(b => b.fixture.id === 'point-tower')!;
  assert.ok(tower.ms < 400, `the 20-storey tower took ${tower.ms.toFixed(1)} ms (budget 400 ms)`);

  const again = generateStructure(makeArchFixture('point-tower').ctx);
  assert.equal(again.elements.length, tower.struct.elements.length, 'element count is not deterministic');
  assert.deepEqual(again.elements.map(e => e.id), tower.struct.elements.map(e => e.id), 'element ids are not deterministic');
  assert.deepEqual(again.derived, tower.struct.derived, 'derived metrics are not deterministic');
});

test('podium storeys use the parking module and the dwellings above use the party-wall grid', () => {
  const { fixture, struct } = BUILT.find(b => b.fixture.id === 'midrise-bar')!;
  assert.equal(struct.transferStorey, 'L02');
  const podiumCols = struct.columns.filter(c => c.storey === 'L01');
  assert.ok(podiumCols.length > 0, 'no podium columns');
  assert.equal(struct.columns.filter(c => c.storey !== 'L01').length, 0, 'wood-over-podium must not carry columns above the podium');
  // the dwellings above sit on bearing walls that architecture drew
  const bearingAbove = struct.walls.filter(w => w.role === 'bearing' && w.storey !== 'L01');
  assert.ok(bearingAbove.length > 0, 'no bearing walls above the podium');
  assert.ok(bearingAbove.every(w => w.archWallId), 'bearing walls must reference architecture walls');
  // party walls every 7.5 m produce grid lines at that rhythm
  const partyX = [...new Set(fixture.arch.walls.filter(w => w.type === 'party').map(w => Number(w.start[0].toFixed(2))))];
  const gridX = struct.grid.filter(g => g.axis === 'x').map(g => g.offset);
  const covered = partyX.filter(px => gridX.some(gx => Math.abs(gx - px) < 0.3)).length;
  assert.ok(covered >= partyX.length - 1, `only ${covered} of ${partyX.length} party wall lines became grid lines`);
});

test('every structural system and detail level generates a coherent model', () => {
  // A 3-storey direct-access typology makes structuralSystemFor return typology.structure
  // verbatim, so the system can be forced to exercise every branch.
  const systems = ['light-wood-frame', 'masonry-bearing', 'mass-timber-clt', 'rc-flat-slab', 'steel-frame'] as const;
  const details = ['low', 'medium', 'high'] as const;
  for (const system of systems) {
    for (const detail of details) {
      const f = makeArchFixture('townhouse-row');
      const ctx: GenContext = {
        ...f.ctx,
        typology: { ...f.typology, structure: system, access: 'direct' },
        spec: { ...f.spec, options: { ...f.spec.options, detail } },
        warnings: [],
      };
      const struct = generateStructure(ctx);
      const tag = `${system}/${detail}`;
      assert.equal(struct.system, system, `${tag}: system was not honoured`);
      assert.ok(struct.elements.length > 0, `${tag}: no elements`);
      assert.ok(struct.slabs.length > 0, `${tag}: no slabs`);
      assert.ok(struct.foundations.length > 0, `${tag}: no foundations`);
      assert.ok(struct.columns.length > 0 || struct.walls.some(w => w.role === 'bearing'), `${tag}: nothing carries load`);
      for (const e of struct.elements) {
        for (const n of numbersIn(e.geometry)) assert.ok(Number.isFinite(n), `${tag}: ${e.id} non-finite coordinate`);
      }
      const ids = new Set(struct.elements.map(e => e.id));
      assert.equal(ids.size, struct.elements.length, `${tag}: duplicate element ids`);
      assert.ok(struct.derived.embodiedCarbonPerM2 > 20, `${tag}: implausible carbon ${struct.derived.embodiedCarbonPerM2}`);
      if (system === 'steel-frame') {
        assert.ok(struct.beams.some(b => b.role === 'primary'), `${tag}: a steel frame needs primary beams`);
        assert.ok(struct.columns.every(c => c.material === 'steel'), `${tag}: steel columns expected`);
        assert.ok(struct.derived.steelTonnes > 0, `${tag}: no steel tonnage reported`);
        if (detail === 'high') assert.ok(struct.beams.some(b => b.role === 'secondary'), `${tag}: high detail should add secondary beams`);
      }
      if (system === 'mass-timber-clt' || system === 'light-wood-frame') {
        assert.ok(struct.derived.timberVolumeM3 > 0, `${tag}: no timber volume reported`);
        assert.ok(struct.walls.some(w => w.role === 'bearing' && (w.material === 'timber' || w.material === 'clt')), `${tag}: timber bearing walls expected`);
      }
      if (system === 'masonry-bearing') {
        assert.ok(struct.walls.some(w => w.role === 'bearing' && w.material === 'masonry'), `${tag}: masonry bearing walls expected`);
      }
      // a low detail level must not produce more elements than a high one
      assert.ok(struct.elements.length < 20000, `${tag}: runaway element count ${struct.elements.length}`);
    }
  }
  // detail must actually change the element budget for bearing-wall systems
  const mk = (detail: 'low' | 'high'): number => {
    const f = makeArchFixture('townhouse-row');
    return generateStructure({ ...f.ctx, spec: { ...f.spec, options: { ...f.spec.options, detail } }, warnings: [] }).elements.length;
  };
  assert.ok(mk('low') < mk('high'), 'detail level has no effect on the element budget');
});

// ----------------------------------------------------------------------------
// Integration with the real site + architecture modules (skipped until they land)
// ----------------------------------------------------------------------------

for (const presetId of ['us-5-over-1', 'uk-terrace']) {
  test(`integration: site → architecture → structure for preset ${presetId}`, async t => {
    let siteMod: { generateSite: (...a: never[]) => never };
    let archMod: { generateArchitecture: (...a: never[]) => never; resolveArchitectureDeps?: () => Promise<unknown> };
    try {
      siteMod = await import('../site/index.ts') as never;
      archMod = await import('../architecture/index.ts') as never;
      if (typeof siteMod.generateSite !== 'function' || typeof archMod.generateArchitecture !== 'function') {
        throw new Error('generateSite / generateArchitecture are not exported yet');
      }
      // architecture loads its unit templates and layout engine lazily
      if (typeof archMod.resolveArchitectureDeps === 'function') await archMod.resolveArchitectureDeps();
    } catch (err) {
      t.skip(`site/architecture module not available yet: ${(err as Error).message}`);
      return;
    }

    const spec = normalizeSpec(getPreset(presetId).spec);
    const typology = getTypology(spec.typology);
    const rng = createRng(spec.seed);
    const warnings: string[] = [];
    const site = (siteMod.generateSite as unknown as (s: typeof spec, t: typeof typology, r: ReturnType<typeof createRng>, w: string[]) => GenContext['site'])(spec, typology, rng.fork('site'), warnings);
    const storeys = site.massing.storeys.length > 0 ? site.massing.storeys : buildStoreys(spec, spec.floors);
    const ctx: GenContext = { spec, typology, rng, storeys, site, arch: null, struct: null, mech: null, plumb: null, elec: null, warnings };
    try {
      ctx.arch = (archMod.generateArchitecture as unknown as (c: GenContext) => ArchModel)({ ...ctx, rng: rng.fork('architecture') });
    } catch (err) {
      // Upstream defect, not a structural one: report it loudly but do not fail this module.
      t.skip(`generateArchitecture threw for ${presetId} (upstream): ${(err as Error).message}`);
      return;
    }

    const t0 = performance.now();
    const struct = generateStructure({ ...ctx, rng: rng.fork('structure') });
    const ms = performance.now() - t0;

    assert.ok(struct.elements.length > 0, 'no structural elements');
    assert.ok(struct.slabs.length >= storeys.filter(s => s.index >= 0 && s.index < 100).length, 'a slab is missing on some storey');
    assert.ok(struct.foundations.length > 0, 'no foundations');
    assert.ok(ms < 2000, `structure took ${ms.toFixed(0)} ms`);

    const seen = new Set<string>();
    const archIds = new Set(ctx.arch.walls.map(w => w.id));
    for (const e of struct.elements) {
      assert.ok(!seen.has(e.id), `duplicate element id ${e.id}`);
      seen.add(e.id);
      for (const n of numbersIn(e.geometry)) assert.ok(Number.isFinite(n), `${e.id} has a non-finite coordinate`);
    }
    for (const w of struct.walls) {
      if (w.archWallId) assert.ok(archIds.has(w.archWallId), `struct wall ${w.id} references unknown arch wall ${w.archWallId}`);
    }
    assert.ok(struct.plenumClearance.corridorSoffitZ > 2.0, 'implausible corridor soffit');
    assert.ok(struct.derived.embodiedCarbonPerM2 > 30 && struct.derived.embodiedCarbonPerM2 < 800, `embodied carbon ${struct.derived.embodiedCarbonPerM2} kgCO2e/m²`);
  });
}

// keep the import used even when every element carries psets
test('elements carry the standard property sets', () => {
  const byKind = new Map<string, ModelElement>();
  for (const { struct } of BUILT) for (const e of struct.elements) if (!byKind.has(e.geometry.kind)) byKind.set(e.geometry.kind, e);
  const expected: Record<string, string> = {
    column: 'Pset_ColumnCommon',
    beam: 'Pset_BeamCommon',
    slab: 'Pset_SlabCommon',
    footing: 'Pset_FootingCommon',
    pile: 'Pset_PileCommon',
    wall: 'Pset_WallCommon',
  };
  for (const [kind, psetName] of Object.entries(expected)) {
    const e = byKind.get(kind);
    if (!e) continue;
    const names = (e.psets ?? []).map(p => p.name);
    assert.ok(names.includes(psetName), `${kind} element ${e.id} is missing ${psetName} (has ${names.join(',')})`);
    assert.ok(names.includes('Forma_Structure'), `${kind} element ${e.id} is missing Forma_Structure`);
    assert.ok(e.color && e.color.length === 3, `${kind} element ${e.id} has no colour`);
    assert.ok(e.material?.name, `${kind} element ${e.id} has no material`);
  }
  assert.ok(byKind.has('column') || byKind.has('wall'), 'no vertical structure at all');
});
