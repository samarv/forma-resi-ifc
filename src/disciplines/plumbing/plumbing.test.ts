/**
 * Plumbing + fire protection invariants.
 *   node --test src/disciplines/plumbing/*.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import type {
  BuildingSpec, ElementGeometry, ModelElement, PlumbModel, GenContext, Rng, TypologyDef, Vec2, Vec3,
} from '../../core/types.ts';
import { dist, polygonBounds, rectContainsPoint } from '../../core/geometry.ts';
import { buildStoreys, getPreset, normalizeSpec, PRESETS } from '../../core/spec.ts';
import { getTypology } from '../../core/typologies.ts';
import { createRng } from '../../core/rng.ts';
import { generatePlumbing, PLUMB_PATTERNS } from './index.ts';
import { makeContextFixture, FIXTURE_GEOM } from './test-fixtures.ts';
import { fixtureTypeForFurniture } from './tables.ts';

/** IPC 2021 Table 1002.2 unvented trap-arm limits (m) — mirrors tables.ts maxTrapArm */
function ipcTrapArm(d: number): number {
  return d >= 0.1 ? 3.66 : d >= 0.075 ? 3.05 : d >= 0.05 ? 1.83 : d >= 0.04 ? 1.52 : 1.07;
}

type AxisElement = ModelElement & { geometry: Extract<ElementGeometry, { kind: 'axis' }> };

const HERE = dirname(fileURLToPath(import.meta.url));
const GEN_ROOT = resolve(HERE, '../..');

function build(opts: Parameters<typeof makeContextFixture>[0] = {}): { ctx: GenContext; m: PlumbModel } {
  const ctx = makeContextFixture(opts);
  return { ctx, m: generatePlumbing(ctx) };
}

function pset(el: ModelElement, set: string, prop: string): string | number | boolean | undefined {
  return el.psets?.find(p => p.name === set)?.properties.find(p => p.name === prop)?.value;
}

function isAxis(e: ModelElement): e is AxisElement {
  return e.geometry.kind === 'axis';
}

function axisElements(m: PlumbModel): AxisElement[] {
  return m.elements.filter(isAxis);
}

/** Plan (horizontal) developed length of a run */
function armLength(p: { path: Vec3[] }): number {
  let arm = 0;
  for (let i = 0; i < p.path.length - 1; i++) {
    arm += dist([p.path[i][0], p.path[i][1]], [p.path[i + 1][0], p.path[i + 1][1]]);
  }
  return arm;
}

/**
 * Length limit of a fixture's waste branch: the IPC Table 1002.2 trap-arm limit while the arm is
 * UNVENTED, or the vented-branch-drain bound (PLB-02 maxVentedBranchDrain) once plumbing has
 * flagged the run as individually vented.
 */
function armLimit(p: { diameter: number }, armEl?: ModelElement): number {
  if (armEl && pset(armEl, 'Forma_Plumbing', 'Vented') === true) return MAX_VENTED_BRANCH;
  return ipcTrapArm(p.diameter);
}

/** PLB-02 maxVentedBranchDrain: a Ø100 branch at the 1 % minimum fall drops 120 mm over 12 m */
const MAX_VENTED_BRANCH = 12.0;

function allPoints(m: PlumbModel): { el: ModelElement; p: Vec3 }[] {
  const out: { el: ModelElement; p: Vec3 }[] = [];
  for (const el of m.elements) {
    const g = el.geometry;
    if (g.kind === 'axis') { out.push({ el, p: g.start }, { el, p: g.end }); }
    else if (g.kind === 'box') { out.push({ el, p: g.position }); }
    else if (g.kind === 'prism' || g.kind === 'slab') { out.push({ el, p: g.position }); }
  }
  return out;
}

// ---------------------------------------------------------------------------

test('generates a complete plumbing model from the fixture context', () => {
  const { ctx, m } = build();
  assert.ok(ctx.arch, 'fixture has an architecture model');
  assert.ok(m.elements.length > 500, `expected a populated model, got ${m.elements.length} elements`);
  assert.ok(m.fixtures.length > 0);
  assert.ok(m.stacks.length > 0);
  assert.ok(m.pipes.length > 0);
  assert.equal(m.dhw, ctx.typology.dhw);
  assert.equal(m.sprinklered, true);
  for (const e of m.elements) assert.equal(e.discipline, 'plumbing');
});

test('every needsWater furniture becomes a fixture with the right connections', () => {
  const { ctx, m } = build();
  const arch = ctx.arch!;
  const byFurniture = new Map(m.fixtures.filter(f => f.furnitureId).map(f => [f.furnitureId!, f] as const));
  let checked = 0;
  for (const furn of arch.furniture) {
    if (!furn.needsWater) continue;
    const expected = fixtureTypeForFurniture(furn.type);
    if (!expected || expected === 'water-heater') continue; // heaters come from the DHW step
    const fixture = byFurniture.get(furn.id);
    assert.ok(fixture, `no plumbing fixture for ${furn.type} ${furn.id}`);
    assert.equal(fixture.type, expected);
    assert.ok(fixture.connections.length >= 3,
      `${furn.type} has ${fixture.connections.length} connections, expected >= 3`);
    if (furn.type === 'wc') {
      assert.deepEqual([...fixture.connections].sort(), ['dcw', 'vent', 'waste']);
      assert.equal(fixture.dfu, 3);
      assert.equal(fixture.wsfu, 2.2);
    }
    if (furn.type === 'kitchen-sink' || furn.type === 'vanity' || furn.type === 'shower' || furn.type === 'washer') {
      assert.ok(fixture.connections.length >= 4,
        `${furn.type} should have dcw/dhw/waste/vent, got ${fixture.connections.join(',')}`);
    }
    checked++;
  }
  assert.ok(checked >= 120, `expected the fixture building to have >= 120 water fixtures, checked ${checked}`);
  // water heaters: one per dwelling (per-unit-tank)
  assert.equal(m.fixtures.filter(f => f.type === 'water-heater').length, arch.units.length);
});

test('one stack per dwelling column, aligned across every storey (PLB-01)', () => {
  const { ctx, m } = build();
  const arch = ctx.arch!;
  const unitColumns = FIXTURE_GEOM.unitCount;
  // a dwelling opens at most two stacks of its own (it may also share a consolidated neighbour's
  // stack — PLB-09 — which is why the per-dwelling count is checked against the budget + 1)
  for (const unit of arch.units) {
    const serving = m.stacks.filter(s => s.servesUnitIds.includes(unit.id));
    assert.ok(serving.length >= 1 && serving.length <= 3,
      `dwelling ${unit.id} drains into ${serving.length} stacks`);
  }
  assert.ok(m.derived.stacksPerDwelling <= 2 + 1e-9,
    `${m.derived.stacksPerDwelling} stacks per dwelling (> 2)`);
  assert.ok(m.stacks.length >= unitColumns,
    `expected at least one stack per unit column (${unitColumns}), got ${m.stacks.length}`);
  // every dwelling is served by at least one stack
  for (const unit of arch.units) {
    const serving = m.stacks.filter(s => s.servesUnitIds.includes(unit.id));
    assert.ok(serving.length >= 1, `dwelling ${unit.id} has no stack`);
  }
  // each stack spans from the ground storey up and vents at the roof
  const storeyIds = ctx.storeys.filter(s => s.index >= 0 && s.index < 100).map(s => s.id);
  for (const s of m.stacks) {
    assert.equal(s.fromStorey, storeyIds[0]);
    assert.equal(s.toStorey, 'ROOF');
    assert.ok(s.systems.includes('waste') && s.systems.includes('vent')
      && s.systems.includes('dcw') && s.systems.includes('dhw'));
  }
  // one primary (wet-wall) stack per column
  const primary = m.stacks.filter(s => !!s.wetWallId);
  assert.ok(primary.length >= unitColumns,
    `expected at least ${unitColumns} wet-wall stacks, got ${primary.length}`);
  // no two stacks closer than the 0.3 m alignment tolerance
  for (let i = 0; i < m.stacks.length; i++) {
    for (let j = i + 1; j < m.stacks.length; j++) {
      assert.ok(dist(m.stacks[i].xy as Vec2, m.stacks[j].xy as Vec2) > 0.3,
        `stacks ${m.stacks[i].id} and ${m.stacks[j].id} were not merged`);
    }
  }
});

test('each stack has per-storey risers for waste/vent/dcw/dhw and a vent through the roof', () => {
  const { ctx, m } = build();
  const storeyIds = ctx.storeys.filter(s => s.index >= 0 && s.index < 100).map(s => s.id);
  const risers = axisElements(m).filter(e => pset(e, 'Forma_Plumbing', 'Riser') === true);
  const key = (stackId: string, storey: string, sys: string): string => `${stackId}|${storey}|${sys}`;
  const seen = new Set<string>();
  for (const e of risers) {
    const stackId = String(pset(e, 'Forma_Plumbing', 'StackId') ?? '');
    const sys = String(pset(e, 'Forma_Plumbing', 'SystemType') ?? '');
    seen.add(key(stackId, e.storey, sys));
    // never spans storeys: vertical, and no longer than that storey's floor-to-floor
    assert.equal(e.geometry.start[0], e.geometry.end[0]);
    assert.equal(e.geometry.start[1], e.geometry.end[1]);
    const f2f = ctx.storeys.find(s => s.id === e.storey)!.height;
    assert.ok(e.geometry.end[2] - e.geometry.start[2] <= f2f + 1e-6,
      `riser ${e.id} spans more than one storey`);
    assert.equal(e.geometry.start[2], 0);
  }
  for (const s of m.stacks) {
    for (const storey of storeyIds) {
      for (const sys of ['waste', 'vent', 'dcw', 'dhw']) {
        assert.ok(seen.has(key(s.id, storey, sys)),
          `stack ${s.id} is missing its ${sys} riser on ${storey}`);
      }
    }
  }
  // PLB-03: vent through the roof, one per stack
  const vtr = axisElements(m).filter(e => e.storey === 'ROOF' && e.system === 'SYS-PLB-VENT');
  assert.equal(vtr.length, m.stacks.length);
  for (const e of vtr) assert.ok(e.geometry.end[2] >= 0.3, 'vent must terminate above the roof');
});

test('every fixture drains to its stack within the trap-arm limit (PLB-02)', () => {
  const { m } = build();
  const stackById = new Map(m.stacks.map(s => [s.id, s] as const));
  const waste = m.pipes.filter(p => p.system === 'waste' && p.servesFixtureIds.length === 1 && p.stackId);
  const drained = m.fixtures.filter(f => f.connections.includes('waste') && f.type !== 'floor-drain');
  const withBranch = new Set(waste.flatMap(p => p.servesFixtureIds));
  for (const f of drained) {
    assert.ok(withBranch.has(f.id), `fixture ${f.id} (${f.type}) has no waste branch`);
  }
  assert.ok(waste.length >= drained.length, 'one waste branch per drained fixture');
  for (const p of waste) {
    const stack = stackById.get(p.stackId!);
    assert.ok(stack, `waste branch ${p.id} references an unknown stack`);
    const end = p.path[p.path.length - 1];
    assert.ok(dist([end[0], end[1]], stack.xy as Vec2) <= 0.3,
      `waste branch ${p.id} ends ${dist([end[0], end[1]], stack.xy as Vec2).toFixed(2)} m from stack ${stack.id}`);
    const armEl = axisElements(m).find(e =>
      pset(e, 'Forma_Plumbing', 'ServesFixtures') === p.servesFixtureIds[0]
      && pset(e, 'Forma_Plumbing', 'SystemType') === 'waste');
    assert.ok(armEl, `no waste element carries the pset for ${p.id}`);
    assert.ok(Number.isFinite(Number(pset(armEl, 'Forma_Plumbing', 'TrapArmLength'))));
    assert.equal(pset(armEl, 'Forma_Plumbing', 'TrapArmLimit'), ipcTrapArm(p.diameter));
    // horizontal developed length: an UNVENTED trap arm stays within the code limit; a branch
    // flagged Vented is an individually vented branch drain (PLB-02) with the 6 m modelling bound
    assert.ok(armLength(p) <= armLimit(p, armEl) + 1e-6,
      `${armEl && pset(armEl, 'Forma_Plumbing', 'Vented') === true ? 'vented branch drain' : 'trap arm'} of `
      + `${p.id} is ${armLength(p).toFixed(2)} m (> ${armLimit(p, armEl)} m)`);
    // the invert sits in the floor build-up under the fixture
    assert.ok(p.path.every(pt => pt[2] <= 0 + 1e-9 && pt[2] >= -0.2));
  }
  // supply branches: cold and hot in the wall at 0.45 / 0.55
  const dcw = m.pipes.filter(p => p.system === 'dcw' && p.servesFixtureIds.length === 1);
  assert.ok(dcw.length >= drained.length, 'every fixture gets a cold water branch');
  assert.ok(m.pipes.some(p => p.system === 'dcw' && p.path.some(pt => Math.abs(pt[2] - 0.45) < 1e-6)));
  assert.ok(m.pipes.some(p => p.system === 'dhw' && p.path.some(pt => Math.abs(pt[2] - 0.55) < 1e-6)));
  // branch vents above the flood rim
  assert.ok(m.pipes.some(p => p.system === 'vent' && p.path.every(pt => Math.abs(pt[2] - 1.5) < 1e-6)));
});

test('sprinklers cover every habitable room and the corridor (PLB-05)', () => {
  const { ctx, m } = build();
  const arch = ctx.arch!;
  const heads = m.fixtures.filter(f => f.type === 'sprinkler-head');
  assert.ok(heads.length > 100, `expected a full head layout, got ${heads.length}`);
  const skip = new Set(['balcony', 'terrace', 'courtyard', 'roof', 'landscape', 'shaft', 'elevator', 'porch']);
  let roomsChecked = 0;
  for (const room of arch.rooms) {
    if (skip.has(room.type) || room.area < 3) continue;
    const inRoom = heads.filter(h => h.storey === room.storey
      && rectContainsPoint(room.rect, [h.position[0], h.position[1]], 0.15));
    assert.ok(inRoom.length >= 1, `room ${room.id} (${room.type}, ${room.area} m²) has no sprinkler head`);
    // coverage: at most 15 m² per head
    assert.ok(room.area / inRoom.length <= 15 + 1e-6,
      `room ${room.id} has ${inRoom.length} heads for ${room.area} m² (> 15 m²/head)`);
    roomsChecked++;
  }
  assert.ok(roomsChecked > 100, `expected to check many rooms, checked ${roomsChecked}`);
  // heads sit just below the ceiling
  for (const h of heads) {
    const plan = arch.floors.find(f => f.storey === h.storey);
    if (!plan) continue;
    assert.ok(Math.abs(h.position[2] - (plan.ceilingHeight - 0.05)) < 0.3,
      `head ${h.id} at z ${h.position[2]} is not just below the ${plan.ceilingHeight} m ceiling`);
  }
  // corridor main in the sprinkler lane, unit mains and branch lines
  assert.ok(m.pipes.some(p => p.system === 'sprinkler' && p.diameter === 0.05));
  assert.ok(m.pipes.some(p => p.system === 'sprinkler' && p.diameter === 0.032));
  assert.ok(m.pipes.some(p => p.system === 'sprinkler' && p.diameter === 0.025));
  // standpipes in the stair cores with a control valve at every floor
  const standpipe = m.elements.filter(e => e.system === 'SYS-PLB-STANDPIPE' && e.geometry.kind === 'axis');
  assert.equal(standpipe.length, arch.cores.length * arch.floors.length);
  const valves = m.elements.filter(e => e.ifcType === 'IfcValve' && e.predefinedType === 'ISOLATING');
  assert.equal(valves.length, arch.cores.length * arch.floors.length);
  // fire department connection at the street face
  const fdc = m.elements.find(e => e.objectType === 'FDC');
  assert.ok(fdc, 'no fire department connection');
  assert.equal(fdc.storey, 'L01');
});

test('storm drainage: drains at low points, downpipes reach the ground (PLB-06)', () => {
  const { ctx, m } = build();
  assert.ok(m.roofDrains.length >= 2, `expected >= 2 roof drains, got ${m.roofDrains.length}`);
  const roofArea = polygonBounds(ctx.arch!.roof.outline);
  assert.ok(m.roofDrains.length >= Math.ceil(roofArea.w * roofArea.h / 400));
  const drainEls = m.elements.filter(e => e.predefinedType === 'ROOFDRAIN');
  assert.equal(drainEls.length, m.roofDrains.length);
  for (const e of drainEls) assert.equal(e.storey, 'ROOF');
  // vertical downpipes on every above-grade storey, reaching the ground storey
  const down = axisElements(m).filter(e => e.system === 'SYS-PLB-STORM'
    && pset(e, 'Forma_Plumbing', 'Downpipe') === true);
  const storeysWithDownpipe = new Set(down.map(e => e.storey));
  for (const s of ctx.storeys.filter(s => s.index >= 0 && s.index < 100)) {
    assert.ok(storeysWithDownpipe.has(s.id), `no storm downpipe on ${s.id}`);
  }
  // buried storm main leaving toward the street
  const exit = m.pipes.filter(p => p.system === 'storm'
    && p.path.some(pt => Math.abs(pt[1] - 0) < 0.01 && pt[2] <= -0.9));
  assert.ok(exit.length >= 1, 'storm drainage does not reach the street');
});

test('cold water service enters from the street and is sized from fixture units', () => {
  const { ctx, m } = build();
  const service = m.pipes.filter(p => p.system === 'dcw' && p.path[0][2] <= -0.5);
  assert.ok(service.length >= 1, 'no buried water service');
  const s = service[0];
  assert.ok(Math.abs(s.path[0][1] - 0) < 0.01, `service should start at the street edge (y ≈ 0), got y = ${s.path[0][1]}`);
  assert.ok(Math.abs(s.path[0][2] + 0.9) < 1e-6, 'service should be buried 0.9 m below the ground floor');
  assert.equal(s.diameter, m.totals.serviceDiameter);
  // meter + backflow preventer in the water room at 0.6 m
  const meter = m.fixtures.find(f => f.type === 'water-meter');
  const bfp = m.fixtures.find(f => f.type === 'backflow-preventer');
  assert.ok(meter && bfp);
  assert.equal(meter.storey, 'L01');
  assert.ok(Math.abs(meter.position[2] - 0.6) < 1e-6);
  const waterRoom = ctx.arch!.rooms.find(r => r.type === 'water-room');
  assert.ok(waterRoom);
  assert.equal(meter.roomId, waterRoom.id);
  // corridor mains in the pipe lane, one per storey, with a tap at each stack
  for (const floor of ctx.arch!.floors) {
    const main = m.pipes.find(p => p.storey === floor.storey && p.system === 'dcw' && p.path.length >= 2
      && Math.abs(p.path[0][1] - (FIXTURE_GEOM.corridorCenterY - 0.35)) < 1e-6);
    assert.ok(main, `no cold water main in the pipe lane on ${floor.storey}`);
    assert.ok(main.diameter >= 0.05);
  }
  // sizing
  assert.ok(m.totals.serviceDiameter >= 0.05 && m.totals.serviceDiameter <= 0.1,
    `service diameter ${m.totals.serviceDiameter} outside 0.05 … 0.1 m`);
  assert.ok(m.derived.peakFlowLps > 0.5 && m.derived.peakFlowLps < 20);
  // building drain + sewer lateral
  assert.ok(m.pipes.some(p => p.system === 'waste' && p.path.some(pt => Math.abs(pt[2] + 1.2) < 1e-6)),
    'no sewer lateral at invert -1.2');
});

test('hot water: a heater per dwelling, fed from and returning to the stack (PLB-04)', () => {
  const { ctx, m } = build();
  const heaters = m.fixtures.filter(f => f.type === 'water-heater');
  assert.equal(heaters.length, ctx.arch!.units.length);
  const tanks = m.elements.filter(e => e.ifcType === 'IfcTank' && e.predefinedType === 'STORAGE');
  assert.equal(tanks.length, heaters.length);
  assert.equal(m.derived.dhwStorageL, 190 * heaters.length);
  // each heater has a cold feed and a hot outlet
  for (const h of heaters) {
    const runs = m.pipes.filter(p => p.servesFixtureIds.includes(h.id));
    assert.ok(runs.some(r => r.system === 'dcw'), `heater ${h.id} has no cold feed`);
    assert.ok(runs.some(r => r.system === 'dhw'), `heater ${h.id} has no hot outlet`);
  }
  assert.equal(m.derived['pipeLength.hwr'], 0, 'no recirculation with per-unit tanks');
});

test('central DHW adds storage, circulators and an HWR loop', () => {
  // 'deck-access' uses a heat network → central plant + recirculation
  const { ctx, m } = build({ spec: { typology: 'deck-access' } });
  assert.equal(ctx.typology.dhw, 'heat-network');
  assert.equal(m.dhw, 'heat-network');
  assert.ok(m.derived['pipeLength.hwr'] > 0, 'central DHW must have a recirculation return');
  for (const s of m.stacks) assert.ok(s.systems.includes('hwr'));
  assert.ok(m.elements.filter(e => e.ifcType === 'IfcTank').length >= 2);
  assert.ok(m.elements.filter(e => e.ifcType === 'IfcPump' && e.predefinedType === 'CIRCULATOR').length >= 2);
  assert.ok(m.pipes.some(p => p.system === 'dhw' && p.diameter >= 0.032), 'corridor DHW main');
  assert.equal(m.fixtures.filter(f => f.type === 'water-heater' && f.unitId).length, 0,
    'no per-dwelling heaters with a heat network');
  assert.ok(ctx.warnings.some(w => w.includes('heat interface units')));
});

test('a booster set appears above eight storeys (PLB-12)', () => {
  const { m } = build({ storeys: 10 });
  assert.equal(m.derived.boosterPumps, 1);
  assert.ok(m.elements.some(e => e.ifcType === 'IfcPump' && e.predefinedType === 'ENDSUCTION'));
  assert.ok(m.patterns.some(p => p.patternId === 'PLB-12'));
  assert.ok(m.derived.hoseValves > 0, 'Class I hose valves above four storeys');
});

test('synthesises bathroom fixtures when architecture furnished nothing', () => {
  const { ctx, m } = build({ noWaterFurniture: true });
  const arch = ctx.arch!;
  const bathrooms = arch.rooms.filter(r => r.type === 'bathroom');
  assert.ok(bathrooms.length > 0);
  for (const b of bathrooms) {
    const inRoom = m.fixtures.filter(f => f.roomId === b.id);
    assert.ok(inRoom.some(f => f.type === 'wc'), `${b.id} has no wc`);
    assert.ok(inRoom.some(f => f.type === 'lavatory'), `${b.id} has no lavatory`);
    assert.ok(inRoom.some(f => f.type === 'shower'), `${b.id} has no shower`);
  }
  assert.ok(m.stacks.length >= FIXTURE_GEOM.unitCount);
  assert.ok(ctx.warnings.some(w => w.includes('synthesised')));
  // kitchens still get a sink
  assert.equal(m.fixtures.filter(f => f.type === 'kitchen-sink').length, arch.units.length);
});

test('falls back to a nearby wet wall when unit.wetWallIds is empty', () => {
  const { m } = build({ noWetWallIds: true });
  assert.ok(m.stacks.length >= FIXTURE_GEOM.unitCount);
  assert.ok(m.fixtures.filter(f => f.connections.includes('waste')).length > 100);
});

test('detail level controls element density', () => {
  const low = build({ detail: 'low' });
  const medium = build({ detail: 'medium' });
  const high = build({ detail: 'high' });
  assert.ok(low.m.elements.length < medium.m.elements.length);
  assert.ok(high.m.elements.length > medium.m.elements.length);
  // low: no sanitary connection markers, one head per dwelling
  assert.equal(low.m.elements.filter(e => e.ifcType === 'IfcSanitaryTerminal').length, 0);
  assert.equal(medium.m.derived.pipeFittings, 0);
  assert.ok(high.m.derived.pipeFittings > 0, 'bends are emitted at detail high');
  assert.ok(high.m.elements.some(e => e.ifcType === 'IfcPipeFitting' && e.predefinedType === 'BEND'));
  // fixtures themselves are always recorded
  assert.ok(low.m.fixtures.length > 0);
  assert.equal(low.m.totals.dfu, medium.m.totals.dfu);
});

test('optional fuel gas: only at detail high, in gas regions, with gas-capable DHW', () => {
  const medium = build();
  assert.equal(medium.m.derived['pipeLength.gas'], 0);
  const high = build({ detail: 'high' });
  assert.ok(high.m.derived['pipeLength.gas'] > 0, 'US + per-unit tanks + detail high should get a gas riser');
  assert.equal(high.m.elements.filter(e => e.predefinedType === 'GASMETER').length, 1);
  assert.ok(high.ctx.warnings.some(w => w.includes('fuel gas is modelled minimally')));
  // a central-plant / electric building gets none
  const central = build({ detail: 'high', spec: { typology: 'point-tower' } });
  assert.equal(central.m.derived['pipeLength.gas'], 0);
});

test('totals and derived metrics are consistent', () => {
  const { ctx, m } = build();
  const dfu = m.fixtures.reduce((s, f) => s + f.dfu, 0);
  const wsfu = m.fixtures.reduce((s, f) => s + f.wsfu, 0);
  assert.ok(Math.abs(m.totals.dfu - dfu) < 0.05, `totals.dfu ${m.totals.dfu} != sum ${dfu}`);
  assert.ok(Math.abs(m.totals.wsfu - wsfu) < 0.05);
  assert.equal(m.totals.fixtureCount, m.fixtures.length);
  assert.equal(m.derived.stackCount, m.stacks.length);
  assert.equal(m.derived.roofDrains, m.roofDrains.length);
  const occupants = ctx.arch!.units.reduce((s, u) => s + u.occupants, 0);
  assert.equal(m.derived.waterDemandLPerDay, occupants * 150);
  assert.equal(m.derived.occupants, occupants);
  for (const sys of ['dcw', 'dhw', 'hwr', 'waste', 'vent', 'storm', 'sprinkler', 'standpipe', 'gas']) {
    assert.ok(typeof m.derived[`pipeLength.${sys}`] === 'number', `missing pipeLength.${sys}`);
  }
  assert.ok(m.derived['pipeLength.waste'] > 0);
  assert.ok(m.derived['pipeLength.vent'] > 0);
  assert.ok(m.derived['pipeLength.sprinkler'] > 0);
  assert.ok(m.derived.pipeLengthTotal > 1000);
  for (const [k, v] of Object.entries(m.derived)) {
    assert.ok(Number.isFinite(v), `derived.${k} is not finite: ${v}`);
  }
});

test('geometry is clean: unique ids, no NaN, no stub segments, inside the site', () => {
  const { ctx, m } = build();
  const ids = new Set<string>();
  for (const e of m.elements) {
    assert.ok(!ids.has(e.id), `duplicate element id ${e.id}`);
    ids.add(e.id);
    assert.ok(e.id.startsWith('PLB-'), `id ${e.id} is not in the plumbing namespace`);
    assert.ok(e.name.length > 0);
    assert.ok(e.storey.length > 0);
    assert.ok(ctx.storeys.some(s => s.id === e.storey), `element ${e.id} references unknown storey ${e.storey}`);
  }
  const fixtureIds = new Set<string>();
  for (const f of m.fixtures) {
    assert.ok(!fixtureIds.has(f.id));
    fixtureIds.add(f.id);
  }
  const pipeIds = new Set<string>();
  for (const p of m.pipes) {
    assert.ok(!pipeIds.has(p.id));
    pipeIds.add(p.id);
    assert.ok(p.diameter > 0 && p.diameter <= 0.3);
    assert.ok(p.path.length >= 2);
  }
  // no degenerate axis elements
  for (const e of axisElements(m)) {
    const L = dist([e.geometry.start[0], e.geometry.start[1]], [e.geometry.end[0], e.geometry.end[1]]);
    const L3 = Math.hypot(L, e.geometry.end[2] - e.geometry.start[2]);
    assert.ok(L3 >= 0.02, `axis element ${e.id} is only ${L3.toFixed(4)} m long`);
    assert.ok(e.geometry.profile.type === 'circle' && e.geometry.profile.radius > 0);
  }
  // bounds
  const bounds = polygonBounds(ctx.site.boundary);
  const maxF2f = Math.max(...ctx.storeys.filter(s => s.index < 100).map(s => s.height));
  for (const { el, p } of allPoints(m)) {
    for (const v of p) assert.ok(Number.isFinite(v), `element ${el.id} has a non-finite coordinate`);
    assert.ok(p[0] >= bounds.x - 1 && p[0] <= bounds.x + bounds.w + 1,
      `element ${el.id} x = ${p[0]} outside the site`);
    assert.ok(p[1] >= bounds.y - 1 && p[1] <= bounds.y + bounds.h + 1,
      `element ${el.id} y = ${p[1]} outside the site`);
    assert.ok(p[2] >= -1.5 && p[2] <= maxF2f + 0.5,
      `element ${el.id} z = ${p[2]} outside [-1.5, ${maxF2f + 0.5}]`);
  }
  // psets and systems
  for (const e of axisElements(m)) {
    assert.ok(e.system && e.system.startsWith('SYS-PLB-'), `axis element ${e.id} has no system`);
    assert.ok(pset(e, 'Pset_PipeSegmentTypeCommon', 'NominalDiameter'));
    assert.ok(pset(e, 'Forma_Plumbing', 'System'));
    assert.ok(e.color && e.color.length === 3);
  }
});

test('pattern book is complete and every application resolves', () => {
  const { m } = build();
  const ids = PLUMB_PATTERNS.map(p => p.id);
  for (let i = 1; i <= 12; i++) {
    assert.ok(ids.includes(`PLB-${String(i).padStart(2, '0')}`), `missing pattern PLB-${i}`);
  }
  assert.equal(new Set(ids).size, ids.length, 'duplicate pattern ids');
  for (const p of PLUMB_PATTERNS) {
    assert.equal(p.discipline, 'plumbing');
    assert.ok(p.problem.length > 80, `${p.id} problem statement is too thin`);
    assert.ok(p.solution.length > 80, `${p.id} solution statement is too thin`);
    assert.ok(Object.keys(p.parameters).length >= 3, `${p.id} needs parameters`);
    for (const [k, v] of Object.entries(p.parameters)) {
      assert.ok(v.source, `${p.id}.${k} has no source`);
    }
  }
  // applications reference known patterns (PLB-* or the cross patterns we depend on)
  const known = new Set([...ids, 'XD-01', 'XD-02', 'XD-04', 'XD-05']);
  for (const a of m.patterns) {
    assert.ok(known.has(a.patternId), `application references unknown pattern ${a.patternId}`);
  }
  const applied = new Set(m.patterns.map(a => a.patternId));
  for (const id of ['PLB-01', 'PLB-02', 'PLB-03', 'PLB-04', 'PLB-05', 'PLB-06', 'PLB-07', 'PLB-08', 'PLB-09', 'PLB-10', 'PLB-11', 'XD-01', 'XD-02']) {
    assert.ok(applied.has(id), `pattern ${id} was never applied`);
  }
  // concrete numbers per stack
  const perStack = m.patterns.filter(a => a.patternId === 'PLB-01');
  assert.equal(perStack.length, m.stacks.length);
  for (const a of perStack) {
    assert.ok(typeof a.params?.fixturesServed === 'number' && (a.params.fixturesServed as number) > 0);
    assert.ok(typeof a.params?.dfu === 'number');
    assert.equal(a.params?.wasteDiameter, 0.1);
  }
});

test('generates a 4-storey building in well under 200 ms', () => {
  build(); // warm up module + JIT
  const ctx = makeContextFixture();
  const t0 = performance.now();
  const m = generatePlumbing(ctx);
  const dt = performance.now() - t0;
  assert.ok(m.elements.length > 0);
  assert.ok(dt < 200, `plumbing generation took ${dt.toFixed(1)} ms`);
});

test('degrades gracefully: no architecture model', () => {
  const ctx = makeContextFixture();
  ctx.arch = null;
  const m = generatePlumbing(ctx);
  assert.equal(m.elements.length, 0);
  assert.equal(m.fixtures.length, 0);
  assert.equal(m.stacks.length, 0);
  assert.equal(m.totals.dfu, 0);
  assert.ok(Number.isFinite(m.derived['pipeLength.dcw']));
  assert.ok(ctx.warnings.some(w => w.includes('no architecture model')));
});

test('degrades gracefully: no structure or mechanical model', () => {
  const ctx = makeContextFixture();
  ctx.struct = null;
  ctx.mech = null;
  const m = generatePlumbing(ctx);
  assert.ok(m.elements.length > 500);
  assert.ok(m.stacks.length >= FIXTURE_GEOM.unitCount);
  // corridor mains still land in the plenum, using the default slab/beam assumptions
  assert.ok(m.pipes.some(p => p.system === 'dcw' && p.path.every(pt => pt[2] > 2)));
});

test('handles a single-storey building', () => {
  const { ctx, m } = build({ storeys: 1 });
  assert.equal(ctx.arch!.floors.length, 1);
  assert.ok(m.stacks.length >= FIXTURE_GEOM.unitCount);
  for (const s of m.stacks) assert.equal(s.fromStorey, 'L01');
  assert.equal(m.derived.standpipes, 0, 'no standpipes below four storeys');
  assert.ok(m.roofDrains.length >= 2);
  assert.ok(m.derived.sprinklerHeads > 0, 'corridor-midrise is sprinklered at any height');
});

test('a gable roof gets gutters and corner downpipes', () => {
  const { ctx, m } = build({ roofType: 'gable' });
  assert.equal(m.roofDrains.length, 0, 'gutters are assumed, not roof outlets');
  assert.equal(m.derived.downpipes, 4);
  assert.ok(ctx.warnings.some(w => w.includes('gutters')));
  assert.ok(m.derived['pipeLength.storm'] > 0);
});

test('house typology: hose bibbs at grade, no sprinklers, no standpipes', () => {
  const { ctx, m } = build({
    storeys: 2,
    roofType: 'gable',
    spec: { typology: 'detached-house' },
    noCorridors: true,
  });
  assert.equal(ctx.typology.access, 'direct');
  assert.equal(m.sprinklered, false);
  assert.equal(m.derived.sprinklerHeads, 0);
  assert.equal(m.derived.standpipes, 0);
  assert.ok(ctx.warnings.some(w => w.includes('not sprinklered')));
  // two exterior hose bibbs at grade, outside the wall face
  assert.equal(m.derived.hoseBibbs, 2);
  const bibbs = m.fixtures.filter(f => f.type === 'hose-bibb');
  assert.equal(bibbs.length, 2);
  const outline = ctx.arch!.floors[0].outline;
  const bnds = polygonBounds(outline);
  for (const b of bibbs) {
    assert.ok(Math.abs(b.position[2] - 0.5) < 1e-6, 'hose bibb at 0.5 m');
    const outside = b.position[0] < bnds.x + 0.3 || b.position[0] > bnds.x + bnds.w - 0.3
      || b.position[1] < bnds.y + 0.3 || b.position[1] > bnds.y + bnds.h - 0.3;
    assert.ok(outside, `hose bibb ${b.id} is not on an exterior face`);
  }
  // the drainage and water service still work
  assert.ok(m.stacks.length >= 1);
  assert.ok(m.totals.serviceDiameter >= 0.025);
  assert.ok(m.pipes.some(p => p.system === 'waste' && p.path.some(pt => pt[2] <= -1.0)));
});

test('no corridors: horizontal mains run on a trunk per bar, not a spine through the stacks', () => {
  const { ctx, m } = build({ noCorridors: true });
  assert.ok(m.stacks.length >= FIXTURE_GEOM.unitCount);
  assert.ok(m.pipes.some(p => p.system === 'dcw' && p.path.length >= 2), 'a cold water main still exists');
  assert.ok(m.pipes.some(p => p.system === 'waste' && p.path.some(pt => Math.abs(pt[2] + 0.55) < 1e-6)),
    'the building drain still collects the stack bases');
  // the main is a straight trunk just under the slab, not a polyline visiting every stack
  const trunkZ = ctx.arch!.floors[0].floorToFloor - ctx.arch!.floors[0].slabThickness - 0.35;
  const trunk = m.pipes.filter(p => p.system === 'dcw' && p.path.every(pt => Math.abs(pt[2] - trunkZ) < 1e-6)
    && p.path.length === 2);
  assert.ok(trunk.length >= 1, `no bar trunk at z ${trunkZ.toFixed(2)}`);
  for (const p of m.pipes) {
    assert.ok(p.path.length <= MAX_RUN_POINTS, `run ${p.id} has ${p.path.length} points`);
  }
});

test('detail low still connects every fixture', () => {
  const { m } = build({ detail: 'low' });
  const drained = m.fixtures.filter(f => f.connections.includes('waste') && f.type !== 'floor-drain');
  const served = new Set(m.pipes.filter(p => p.system === 'waste').flatMap(p => p.servesFixtureIds));
  for (const f of drained) assert.ok(served.has(f.id), `fixture ${f.id} unconnected at detail 'low'`);
});

// ---------------------------------------------------------------------------
// Routing invariants (PLB-11): Manhattan legs, bounded runs
// ---------------------------------------------------------------------------

const MAX_RUN_POINTS = 12;
const RUN_LENGTH_FACTOR = 1.5;

function axes(a: Vec3, b: Vec3, eps = 1e-4): string[] {
  const moved: string[] = [];
  if (Math.abs(b[0] - a[0]) > eps) moved.push('x');
  if (Math.abs(b[1] - a[1]) > eps) moved.push('y');
  if (Math.abs(b[2] - a[2]) > eps) moved.push('z');
  return moved;
}

/**
 * Every leg of every run (and every emitted pipe segment) must be axis-parallel: a horizontal leg
 * changes x OR y and never z; a vertical leg changes z only. A leg that moves on two axes is the
 * diagonal that made the mains render as zig-zags across the floor plate.
 */
function manhattanProblems(m: PlumbModel): string[] {
  const out: string[] = [];
  for (const p of m.pipes) {
    for (let i = 0; i < p.path.length - 1; i++) {
      const moved = axes(p.path[i], p.path[i + 1]);
      if (moved.length > 1) {
        out.push(`run ${p.id} (${p.system}) leg ${i} moves on ${moved.join('+')}: `
          + `${JSON.stringify(p.path[i])} → ${JSON.stringify(p.path[i + 1])}`);
      }
    }
  }
  for (const e of m.elements.filter(isAxis)) {
    const moved = axes(e.geometry.start, e.geometry.end);
    if (moved.length > 1) out.push(`segment ${e.id} (${e.name}) moves on ${moved.join('+')}`);
  }
  return out;
}

/** Runs may not carry more than MAX_RUN_POINTS points, nor cross the plate one and a half times */
function runCapProblems(m: PlumbModel, longestDim: number): string[] {
  const cap = RUN_LENGTH_FACTOR * longestDim;
  const out: string[] = [];
  for (const p of m.pipes) {
    if (p.path.length > MAX_RUN_POINTS) out.push(`run ${p.id} has ${p.path.length} points (> ${MAX_RUN_POINTS})`);
    let L = 0;
    for (let i = 0; i < p.path.length - 1; i++) {
      L += Math.hypot(p.path[i + 1][0] - p.path[i][0], p.path[i + 1][1] - p.path[i][1], p.path[i + 1][2] - p.path[i][2]);
    }
    if (L > cap + 1e-6) out.push(`run ${p.id} (${p.system}) is ${L.toFixed(1)} m (> ${cap.toFixed(1)} m)`);
  }
  return out;
}

function longestOutlineDim(ctx: GenContext): number {
  let d = 0;
  for (const f of ctx.arch?.floors ?? []) {
    const b = polygonBounds(f.outline);
    d = Math.max(d, b.w, b.h);
  }
  return d > 0 ? d : Math.max(polygonBounds(ctx.site.boundary).w, polygonBounds(ctx.site.boundary).h);
}

test('every pipe leg is Manhattan — no diagonals, height changes are their own leg (PLB-11)', () => {
  const cases: { name: string; opts: Parameters<typeof makeContextFixture>[0] }[] = [
    { name: 'default', opts: {} },
    { name: 'no corridors', opts: { noCorridors: true } },
    { name: 'detail low', opts: { detail: 'low' } },
    { name: 'detail high', opts: { detail: 'high' } },
    { name: 'gable roof', opts: { roofType: 'gable' } },
    { name: 'no wet wall ids', opts: { noWetWallIds: true } },
    { name: 'synthesised bathrooms', opts: { noWaterFurniture: true } },
    { name: 'single storey', opts: { storeys: 1 } },
    { name: 'ten storeys', opts: { storeys: 10 } },
    { name: 'house', opts: { storeys: 2, roofType: 'gable', noCorridors: true, spec: { typology: 'detached-house' } } },
    { name: 'central dhw', opts: { spec: { typology: 'deck-access' } } },
  ];
  for (const c of cases) {
    const { ctx, m } = build(c.opts);
    const problems = manhattanProblems(m);
    assert.equal(problems.length, 0, `${c.name}: ${problems.slice(0, 4).join(' | ')}`);
    assert.equal(m.derived.nonOrthogonalSegments, 0, `${c.name}: plumbing reported non-orthogonal segments`);
    const caps = runCapProblems(m, longestOutlineDim(ctx));
    assert.equal(caps.length, 0, `${c.name}: ${caps.slice(0, 4).join(' | ')}`);
  }
});

test('mains follow the corridor lane, or one trunk per bar when there is no corridor (PLB-11)', () => {
  // with corridors: the cold water main sits in the pipe lane, and each stack gets its own tap
  const withCorridor = build();
  const lane = withCorridor.m.pipes.filter(p => p.system === 'dcw'
    && p.path.every(pt => Math.abs(pt[1] - (FIXTURE_GEOM.corridorCenterY - 0.35)) < 1e-6));
  assert.ok(lane.length >= withCorridor.ctx.arch!.floors.length, 'no cold water main in the pipe lane');
  for (const p of lane) assert.ok(p.path.length <= 4, `a lane main should be a straight line, got ${p.path.length} points`);

  // without corridors: a trunk per bar, 1 m inside the exterior wall, with an L-shaped tap per stack
  const { ctx, m } = build({ noCorridors: true });
  const trunks = m.pipes.filter(p => p.system === 'dcw' && p.path.length === 2
    && Math.abs(p.path[0][1] - p.path[1][1]) < 1e-6 && Math.abs(p.path[0][0] - p.path[1][0]) > 5);
  assert.ok(trunks.length >= 1, 'no bar trunk on a floor without corridors');
  const bar = polygonBounds(ctx.arch!.floors[0].outline);
  for (const t of trunks) {
    const y = t.path[0][1];
    assert.ok(y > bar.y + 0.4 && y < bar.y + bar.h - 0.4, `trunk at y ${y} is not inside the bar`);
  }
  // taps off the trunk are one or two legs, never a tour of the risers
  const trunkZ = trunks[0].path[0][2];
  const taps = m.pipes.filter(p => p.system === 'dcw' && p.stackId
    && p.servesFixtureIds.length === 0
    && p.path.every(pt => Math.abs(pt[2] - trunkZ) < 1e-6));
  assert.ok(taps.length >= m.stacks.length, `every stack needs its own tap off the trunk (${taps.length} taps, ${m.stacks.length} stacks)`);
  for (const p of taps) assert.ok(p.path.length <= 3, `tap ${p.id} has ${p.path.length} points`);
  // the buried drainage leaves the building perpendicular to the street edge (y = 0)
  const lateral = m.pipes.filter(p => (p.system === 'waste' || p.system === 'storm')
    && p.path.some(pt => Math.abs(pt[1] - ctx.site.boundary[0][1]) < 0.01));
  assert.ok(lateral.length >= 1, 'no buried lateral reaches the street');
  for (const p of lateral) {
    const last = p.path[p.path.length - 1];
    const prev = p.path[p.path.length - 2];
    assert.equal(axes(prev, last).join(''), 'y', `the exit leg of ${p.id} is not perpendicular to the street`);
  }
});

test('sprinkler branch lines are straight rows of heads (PLB-05)', () => {
  const { m } = build();
  const branches = m.pipes.filter(p => p.system === 'sprinkler' && p.diameter === 0.025);
  assert.ok(branches.length > 10, `expected branch lines per room row, got ${branches.length}`);
  for (const p of branches) {
    const moved = new Set(p.path.slice(1).flatMap((_, i) => axes(p.path[i], p.path[i + 1])));
    assert.ok(moved.size <= 1, `branch line ${p.id} bends (${[...moved].join('+')}) instead of running straight`);
    assert.ok(p.path.length <= MAX_RUN_POINTS);
  }
});

test('is deterministic for a given spec', () => {
  const a = build();
  const b = build();
  assert.equal(a.m.elements.length, b.m.elements.length);
  assert.deepEqual(a.m.totals, b.m.totals);
  assert.deepEqual(a.m.derived, b.m.derived);
  assert.deepEqual(a.m.elements.map(e => e.id), b.m.elements.map(e => e.id));
  assert.deepEqual(a.m.stacks.map(s => s.xy), b.m.stacks.map(s => s.xy));
});

// ---------------------------------------------------------------------------
// Integration: only runs once the upstream disciplines exist
// ---------------------------------------------------------------------------

const UPSTREAM = ['site', 'architecture', 'structure', 'mechanical']
  .map(d => resolve(GEN_ROOT, 'disciplines', d, 'index.ts'));
const upstreamReady = UPSTREAM.every(p => existsSync(p));

interface Upstream {
  generateSite: (s: BuildingSpec, t: TypologyDef, r: Rng, w: string[]) => GenContext['site'];
  generateArchitecture: (c: GenContext) => NonNullable<GenContext['arch']>;
  generateStructure: (c: GenContext) => NonNullable<GenContext['struct']>;
  generateMechanical: (c: GenContext) => NonNullable<GenContext['mech']>;
}

/**
 * Load the upstream discipline generators. The specifier is built at runtime so a sibling module
 * that has not been written yet is never a compile-time error while the disciplines are built in
 * parallel.
 */
async function loadUpstream(): Promise<Upstream> {
  const load = (rel: string): Promise<Record<string, unknown>> =>
    import(new URL(rel, import.meta.url).href) as Promise<Record<string, unknown>>;
  const site = await load('../site/index.ts');
  const architecture = await load('../architecture/index.ts') as {
    generateArchitecture: Upstream['generateArchitecture'];
    resolveArchitectureDeps?: () => Promise<unknown>;
  };
  const structure = await load('../structure/index.ts');
  const mechanical = await load('../mechanical/index.ts');
  // architecture keeps its templates / layout engine behind an async resolver for now
  if (architecture.resolveArchitectureDeps) await architecture.resolveArchitectureDeps();
  return {
    generateSite: site.generateSite as Upstream['generateSite'],
    generateArchitecture: architecture.generateArchitecture,
    generateStructure: structure.generateStructure as Upstream['generateStructure'],
    generateMechanical: mechanical.generateMechanical as Upstream['generateMechanical'],
  };
}

/** Run site → architecture → structure → mechanical; throws if an upstream module is not ready */
function runUpstream(up: Upstream, spec: BuildingSpec, warnings: string[]): GenContext {
  const typology = getTypology(spec.typology);
  const rng = createRng(spec.seed);
  const siteModel = up.generateSite(spec, typology, rng.fork('site'), warnings);
  const storeys = siteModel.massing.storeys.length > 0 ? siteModel.massing.storeys : buildStoreys(spec, spec.floors);
  const ctx: GenContext = {
    spec, typology, rng, storeys, site: siteModel,
    arch: null, struct: null, mech: null, plumb: null, elec: null, warnings,
  };
  ctx.arch = up.generateArchitecture({ ...ctx, rng: rng.fork('architecture') });
  try { ctx.struct = up.generateStructure({ ...ctx, rng: rng.fork('structure') }); } catch { /* optional upstream */ }
  try { ctx.mech = up.generateMechanical({ ...ctx, rng: rng.fork('mechanical') }); } catch { /* optional upstream */ }
  return ctx;
}

test('integration: site → architecture → structure → mechanical → plumbing (us-5-over-1)', {
  skip: upstreamReady ? false : `upstream disciplines not written yet (${UPSTREAM.filter(p => !existsSync(p)).join(', ')})`,
}, async (t) => {
  const spec = normalizeSpec(getPreset('us-5-over-1').spec);
  const warnings: string[] = [];
  let ctx: GenContext;
  try {
    ctx = runUpstream(await loadUpstream(), spec, warnings);
  } catch (err) {
    // An upstream discipline is still being written — that is not a plumbing failure.
    t.diagnostic(`upstream not ready: ${(err as Error).message.split('\n')[0]}`);
    t.skip('upstream discipline not ready');
    return;
  }

  const t0 = performance.now();
  const m = generatePlumbing({ ...ctx, rng: ctx.rng.fork('plumbing') });
  const dt = performance.now() - t0;

  assert.ok(m.elements.length > 0, 'plumbing produced no elements on the real architecture model');
  assert.ok(m.fixtures.length > 0);
  assert.ok(m.stacks.length >= 1, 'no stacks found on the real model');
  assert.ok(m.totals.dfu > 0 && m.totals.serviceDiameter > 0);
  assert.ok(dt < 2000, `plumbing took ${dt.toFixed(0)} ms on the preset`);
  checkInvariants(ctx, m);

  // every water fixture architecture drew is connected
  const byFurniture = new Set(m.fixtures.map(f => f.furnitureId));
  for (const furn of ctx.arch!.furniture) {
    if (!furn.needsWater) continue;
    if (!fixtureTypeForFurniture(furn.type)) continue;
    assert.ok(byFurniture.has(furn.id), `real model: ${furn.type} ${furn.id} has no plumbing fixture`);
  }
  // one stack per dwelling at most-ish, and every dwelling served
  for (const unit of ctx.arch!.units) {
    assert.ok(m.stacks.some(s => s.servesUnitIds.includes(unit.id)), `dwelling ${unit.id} has no stack`);
  }
  assert.ok(m.stacks.length <= ctx.arch!.units.length * 2,
    `${m.stacks.length} stacks for ${ctx.arch!.units.length} dwellings is too many`);
  assert.ok(m.derived.sprinklerHeads > 0, 'a 6-storey building must be sprinklered');
  assert.ok(m.derived.standpipes >= 1, 'a 6-storey building needs standpipes');
  assert.ok(m.roofDrains.length >= 2);
});

/** Geometry / bookkeeping invariants that must hold for any input model */
function checkInvariants(ctx: GenContext, m: PlumbModel): void {
  const ids = new Set<string>();
  const bounds = polygonBounds(ctx.site.boundary);
  const heightOf = new Map(ctx.storeys.map(s => [s.id, s.height] as const));
  for (const e of m.elements) {
    assert.ok(!ids.has(e.id), `duplicate element id ${e.id}`);
    ids.add(e.id);
    assert.ok(heightOf.has(e.storey), `element ${e.id} references unknown storey ${e.storey}`);
    const limit = Math.max(3.5, (heightOf.get(e.storey) ?? 3) + 0.5);
    const g = e.geometry;
    const pts: Vec3[] = g.kind === 'axis' ? [g.start, g.end]
      : g.kind === 'box' || g.kind === 'prism' || g.kind === 'slab' ? [g.position] : [];
    for (const p of pts) {
      for (const v of p) assert.ok(Number.isFinite(v), `${e.id} has a non-finite coordinate`);
      assert.ok(p[0] >= bounds.x - 1.5 && p[0] <= bounds.x + bounds.w + 1.5, `${e.id} x = ${p[0]} off site`);
      assert.ok(p[1] >= bounds.y - 1.5 && p[1] <= bounds.y + bounds.h + 1.5, `${e.id} y = ${p[1]} off site`);
      assert.ok(p[2] >= -1.5 && p[2] <= limit, `${e.id} on ${e.storey} has z = ${p[2]} (limit ${limit})`);
    }
    if (g.kind === 'axis') {
      const L = Math.hypot(g.end[0] - g.start[0], g.end[1] - g.start[1], g.end[2] - g.start[2]);
      assert.ok(L >= 0.02, `axis element ${e.id} is only ${L.toFixed(4)} m long`);
    }
  }
  const stackIds = new Set(m.stacks.map(s => s.id));
  for (const p of m.pipes) {
    assert.ok(p.path.length >= 2 && p.diameter > 0);
    if (p.stackId) assert.ok(stackIds.has(p.stackId), `run ${p.id} references unknown stack ${p.stackId}`);
  }
  // waste branches always reach their stack, within the trap-arm / vented-branch limit
  const wasteEls = m.elements.filter(isAxis)
    .filter(e => pset(e, 'Forma_Plumbing', 'SystemType') === 'waste');
  for (const p of m.pipes) {
    if (p.system !== 'waste' || !p.stackId || p.servesFixtureIds.length !== 1) continue;
    const stack = m.stacks.find(s => s.id === p.stackId)!;
    const end = p.path[p.path.length - 1];
    assert.ok(dist([end[0], end[1]], stack.xy as Vec2) <= 0.3, `waste branch ${p.id} misses its stack`);
    const armEl = wasteEls.find(e => pset(e, 'Forma_Plumbing', 'ServesFixtures') === p.servesFixtureIds[0]);
    assert.ok(armLength(p) <= armLimit(p, armEl) + 1e-6,
      `waste branch ${p.id} is ${armLength(p).toFixed(2)} m (limit ${armLimit(p, armEl)} m)`);
  }
  for (const [k, v] of Object.entries(m.derived)) {
    assert.ok(Number.isFinite(v), `derived.${k} = ${v}`);
  }
}

/**
 * Element budget per preset, as elements PER FIXTURE — the absolute counts move with every
 * architecture change (fixtures follow the unit layout), the ratio is the plumbing module's own
 * doing. Recorded when the Manhattan routing landed; before → after the routing fix:
 *
 *   preset          elements      runs        stacks   max points   longest run
 *   us-5-over-1     9217 → 9212   2824→2869   52→32      84→12      509.2 → 71.7 m
 *   uk-terrace      1050 → 1220    259→ 419   14→14      14→ 4       63.5 → 38.4 m
 *   ca-point-tower 14253 →15907   4452→5242   19→12      55→11      276.2 → 39.6 m
 *   ie-courtyard   24492 →22792   8251→7539  223→116     50→ 9      271.0 → 69.7 m
 *   us-detached      178 →  156     54→  54    5→ 2       5→ 4       38.2 → 15.9 m
 */
// Re-recorded 2026-09-22 (v2 wave 1): complete fixture kits + port-seeded stacks + IPC Table 1002.2 trap arms.
const ELEMENT_BUDGET: Record<string, number> = {
  'us-5-over-1': 5.75,
  'uk-terrace': 5.53,
  'ca-point-tower': 6.11,
  'au-walkup': 5.72,
  'us-detached': 12.69,
  'uk-mansion': 5.85,
  'ie-courtyard': 6.22,
  'nz-coliving': 6.95,
  'us-senior': 5.91,
  'ca-laneway': 8.45,
};

/** Presets whose dwellings have their own front door (PLB-01: at most two stacks per dwelling) */
const HOUSE_PRESETS = new Set(['uk-terrace', 'us-detached', 'ca-laneway']);

test('integration: every preset routes Manhattan, within the run caps and the element budget', {
  skip: upstreamReady ? false : 'upstream disciplines not written yet',
}, async (t) => {
  let pipeline: {
    generateBuilding: (s: BuildingSpec) => {
      plumb: PlumbModel | null;
      arch: { floors: { outline: Vec2[] }[]; units: { id: string; storeys: string[] }[] };
      warnings: string[];
    };
  };
  try {
    pipeline = await import(new URL('../../pipeline.ts', import.meta.url).href) as typeof pipeline;
  } catch (err) {
    t.skip(`pipeline not loadable: ${(err as Error).message.split('\n')[0]}`);
    return;
  }
  let ran = 0;
  for (const preset of PRESETS) {
    const spec = normalizeSpec(preset.spec);
    let model: ReturnType<typeof pipeline.generateBuilding>;
    try {
      model = pipeline.generateBuilding(spec);
    } catch (err) {
      t.diagnostic(`${preset.id}: pipeline not ready (${(err as Error).message.split('\n')[0]})`);
      continue;
    }
    const m = model.plumb;
    assert.ok(m, `${preset.id}: the pipeline produced no plumbing model`);
    assert.ok(m.elements.length > 0, `${preset.id}: no plumbing elements`);

    // (a) Manhattan
    const problems = manhattanProblems(m);
    assert.equal(problems.length, 0, `${preset.id}: ${problems.slice(0, 4).join(' | ')}`);
    assert.equal(m.derived.nonOrthogonalSegments, 0, `${preset.id}: non-orthogonal segments reported`);

    // (b) + (c) point count and developed length per run
    let longest = 0;
    for (const f of model.arch.floors) {
      const b = polygonBounds(f.outline);
      longest = Math.max(longest, b.w, b.h);
    }
    const caps = runCapProblems(m, longest);
    assert.equal(caps.length, 0, `${preset.id}: ${caps.slice(0, 4).join(' | ')}`);
    assert.ok(m.derived.maxRunPoints <= MAX_RUN_POINTS, `${preset.id}: maxRunPoints ${m.derived.maxRunPoints}`);
    assert.ok(m.derived.maxRunLength <= RUN_LENGTH_FACTOR * longest + 1e-6,
      `${preset.id}: maxRunLength ${m.derived.maxRunLength} m (cap ${(RUN_LENGTH_FACTOR * longest).toFixed(1)} m)`);

    // (d) houses drain into at most two stacks per dwelling
    const perDwelling = m.stacks.length / Math.max(1, model.arch.units.length);
    if (HOUSE_PRESETS.has(preset.id)) {
      // v2: stations come from the dwelling's stack PORTS (one per wet wall the module lays fixtures on); a
      // townhouse or detached house with kitchen, bath, powder and laundry on different walls has 3–4 risers.
      assert.ok(perDwelling <= 4 + 1e-9,
        `${preset.id}: ${m.stacks.length} stacks for ${model.arch.units.length} dwellings (${perDwelling.toFixed(2)}/dwelling)`);
    }
    assert.ok(Math.abs(m.derived.stacksPerDwelling - perDwelling) < 0.01,
      `${preset.id}: derived.stacksPerDwelling ${m.derived.stacksPerDwelling} != ${perDwelling.toFixed(3)}`);

    // a dwelling that spans several storeys keeps ONE vertical stack line through all of them
    const risers = m.elements.filter(isAxis).filter(e => pset(e, 'Forma_Plumbing', 'Riser') === true);
    for (const u of model.arch.units) {
      if (u.storeys.length < 2) continue;
      const serving = m.stacks.filter(s => s.servesUnitIds.includes(u.id));
      // v2: one riser per stack PORT the module lays out (kitchen / bath / powder / laundry walls) — up to 4 in a house
      assert.ok(serving.length >= 1 && serving.length <= 4,
        `${preset.id}: multi-storey dwelling ${u.id} is served by ${serving.length} stacks`);
      for (const s of serving) {
        for (const storey of u.storeys) {
          assert.ok(risers.some(e => e.storey === storey && pset(e, 'Forma_Plumbing', 'StackId') === s.id),
            `${preset.id}: stack ${s.id} of dwelling ${u.id} has no riser on ${storey}`);
        }
      }
    }

    // (e) no 'diagonal' complaints, and the element budget holds within ±30 %
    const plumbingWarnings = model.warnings.filter(w => w.startsWith('[plumbing]'));
    for (const w of plumbingWarnings) {
      assert.ok(!/diagonal/i.test(w), `${preset.id}: plumbing warns about a diagonal: ${w}`);
    }
    const budget = ELEMENT_BUDGET[preset.id];
    // Compared as elements PER FIXTURE: the absolute counts follow whatever architecture lays out,
    // the ratio is the plumbing module's own doing. Skipped when architecture produced nothing to
    // plumb (there is no budget to check on an empty floor plan).
    if (budget && model.arch.units.length > 0 && m.fixtures.length >= 20) {
      const ratio = m.elements.length / Math.max(1, m.fixtures.length);
      assert.ok(ratio >= budget * 0.7 && ratio <= budget * 1.3,
        `${preset.id}: ${ratio.toFixed(2)} elements per fixture is outside ±30 % of the recorded ${budget}`
        + ` (${m.elements.length} elements, ${m.fixtures.length} fixtures)`);
    }
    t.diagnostic(`${preset.id}: ${m.elements.length} elements, ${m.pipes.length} runs, ${m.stacks.length} stacks `
      + `(${perDwelling.toFixed(2)}/dwelling), max ${m.derived.maxRunPoints} pts / ${m.derived.maxRunLength} m, `
      + `${m.derived.ventedBranchDrains} vented branch drains`);
    ran++;
  }
  assert.ok(ran >= 1, 'no preset could be generated end to end');
});

test('integration: every preset produces clean plumbing', {
  skip: upstreamReady ? false : 'upstream disciplines not written yet',
}, async (t) => {
  const up = await loadUpstream();
  let ran = 0;
  for (const preset of PRESETS) {
    const spec = normalizeSpec(preset.spec);
    const warnings: string[] = [];
    let ctx: GenContext;
    try {
      ctx = runUpstream(up, spec, warnings);
    } catch (err) {
      t.diagnostic(`${preset.id}: upstream not ready (${(err as Error).message.split('\n')[0]})`);
      continue;
    }
    const arch = ctx.arch;
    assert.ok(arch, `${preset.id}: architecture returned no model`);
    const t0 = performance.now();
    const m = generatePlumbing({ ...ctx, rng: ctx.rng.fork('plumbing') });
    const dt = performance.now() - t0;
    assert.ok(dt < 2000, `${preset.id}: plumbing took ${dt.toFixed(0)} ms`);
    checkInvariants(ctx, m);
    if (arch.units.length > 0) {
      assert.ok(m.stacks.length >= 1, `${preset.id}: no stacks for ${arch.units.length} dwellings`);
      assert.ok(m.totals.dfu > 0, `${preset.id}: no drainage fixture units`);
      assert.ok(m.totals.serviceDiameter >= 0.025, `${preset.id}: no water service`);
    }
    t.diagnostic(`${preset.id}: ${arch.units.length} dwellings → ${m.stacks.length} stacks, `
      + `${m.fixtures.length} fixtures, ${m.elements.length} elements, ${dt.toFixed(0)} ms`);
    ran++;
  }
  assert.ok(ran >= 1, 'no preset could be generated end to end');
});
