/**
 * Mechanical discipline tests. Run with:
 *   node --test src/disciplines/mechanical/*.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { GenContext, HvacSystemId, MechModel, ModelElement, Rect, RoomDef } from '../../core/types.ts';
import { rectContainsPoint } from '../../core/geometry.ts';
import { generateMechanical, HVAC_SYSTEM_ORDER, MECH_PATTERNS } from './index.ts';
import { makeContextFixture, withHvac, PLANT_ZONE } from './test-fixtures.ts';
import { HABITABLE, WET_ROOMS } from './placement.ts';

const SYSTEMS: HvacSystemId[] = [...HVAC_SYSTEM_ORDER];

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function allNumbers(e: ModelElement): number[] {
  const g = e.geometry;
  switch (g.kind) {
    case 'axis': return [...g.start, ...g.end, ...(g.profile.type === 'circle' ? [g.profile.radius] : [g.profile.width, g.profile.height])];
    case 'box': return [...g.position, g.width, g.depth, g.height, g.rotation ?? 0];
    default: return [];
  }
}

function ductSegments(m: MechModel): ModelElement[] {
  return m.elements.filter(e => e.geometry.kind === 'axis' && e.tags?.includes('duct-segment'));
}

function riserSegments(m: MechModel): ModelElement[] {
  return m.elements.filter(e => e.geometry.kind === 'axis' && e.tags?.includes('riser'));
}

function storeyBand(ctx: GenContext, storeyId: string): { ceiling: number; f2f: number } {
  const fp = ctx.arch!.floors.find(f => f.storey === storeyId);
  if (fp) return { ceiling: fp.ceilingHeight, f2f: fp.floorToFloor };
  const st = ctx.storeys.find(s => s.id === storeyId)!;
  return { ceiling: 0, f2f: Math.max(st.height, 3.0) };
}

function habitableRooms(ctx: GenContext): RoomDef[] {
  return ctx.arch!.rooms.filter(r => r.unitId && HABITABLE.has(r.type));
}

function wetRooms(ctx: GenContext): RoomDef[] {
  return ctx.arch!.rooms.filter(r => r.unitId && WET_ROOMS.has(r.type));
}

function boxFootprint(e: ModelElement): Rect | null {
  if (e.geometry.kind !== 'box') return null;
  const g = e.geometry;
  return rotatedFootprint([g.position[0], g.position[1]], g.width, g.depth, g.rotation ?? 0);
}

/** Axis-aligned bounds of a `box` footprint (position = min corner before rotation about it) */
function rotatedFootprint(position: [number, number], width: number, depth: number, rotation: number): Rect {
  const u = [Math.cos(rotation), Math.sin(rotation)];
  const v = [-u[1], u[0]];
  const corners = [[0, 0], [width, 0], [width, depth], [0, depth]].map(([a, d]) => [
    position[0] + u[0] * a + v[0] * d,
    position[1] + u[1] * a + v[1] * d,
  ]);
  const xs = corners.map(c => c[0]);
  const ys = corners.map(c => c[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

function rectInside(outer: Rect, inner: Rect, tol = 0.06): boolean {
  return inner.x >= outer.x - tol && inner.y >= outer.y - tol
    && inner.x + inner.w <= outer.x + outer.w + tol && inner.y + inner.h <= outer.y + outer.h + tol;
}

// ----------------------------------------------------------------------------
// Per-system suite
// ----------------------------------------------------------------------------

for (const system of SYSTEMS) {
  test(`${system}: generates a coherent mechanical model`, () => {
    const ctx = withHvac(makeContextFixture(), system);
    const m = generateMechanical(ctx);

    assert.equal(m.system, system);
    assert.ok(m.elements.length > 100, `expected elements, got ${m.elements.length}`);
    assert.equal(m.derived.hvacSystemIndex, HVAC_SYSTEM_ORDER.indexOf(system));

    // ids unique
    const ids = new Set<string>();
    for (const e of m.elements) {
      assert.ok(!ids.has(e.id), `duplicate element id ${e.id}`);
      ids.add(e.id);
    }
    const objIds = new Set<string>();
    for (const o of [...m.equipment, ...m.ducts, ...m.terminals, ...m.risers]) {
      assert.ok(!objIds.has(o.id), `duplicate model-object id ${o.id}`);
      objIds.add(o.id);
    }

    // no NaN / Infinity anywhere in the geometry, and every element has a known storey
    const storeyIds = new Set(ctx.storeys.map(s => s.id));
    for (const e of m.elements) {
      for (const v of allNumbers(e)) {
        assert.ok(Number.isFinite(v), `non-finite coordinate in ${e.id} (${e.ifcType})`);
      }
      assert.ok(storeyIds.has(e.storey), `${e.id} on unknown storey ${e.storey}`);
      assert.ok(e.discipline === 'mechanical');
      assert.ok(e.ifcType.startsWith('Ifc'));
      assert.ok(e.system && e.system.startsWith('SYS-MEC-'), `${e.id} has no mechanical system id`);
    }
    for (const d of Object.values(m.derived)) assert.ok(Number.isFinite(d));
    for (const v of Object.values(m.loads)) assert.ok(Number.isFinite(v));
  });

  test(`${system}: every habitable room is served, every wet room is extracted`, () => {
    const ctx = withHvac(makeContextFixture(), system);
    const m = generateMechanical(ctx);

    const served = new Set<string>();
    for (const t of m.terminals) served.add(t.roomId);
    for (const e of m.equipment) if (e.roomId && e.type !== 'thermostat') served.add(e.roomId);
    for (const room of habitableRooms(ctx)) {
      assert.ok(served.has(room.id), `${system}: habitable room ${room.id} (${room.type}) has no terminal or equipment`);
    }

    const extracted = new Set(m.terminals.filter(t => t.type === 'exhaust-grille').map(t => t.roomId));
    for (const room of wetRooms(ctx)) {
      assert.ok(extracted.has(room.id), `${system}: wet room ${room.id} (${room.type}) has no exhaust grille`);
    }

    // A range hood over every kitchen (MEC-11)
    const hoods = m.equipment.filter(e => e.type === 'range-hood');
    assert.equal(hoods.length, ctx.arch!.units.length, `${system}: expected one range hood per dwelling`);

    // Exactly one thermostat per dwelling (MEC-10)
    const stats = m.equipment.filter(e => e.type === 'thermostat');
    assert.equal(stats.length, ctx.arch!.units.length);
    assert.equal(new Set(stats.map(e => e.unitId)).size, ctx.arch!.units.length);
  });

  test(`${system}: equipment and terminals sit inside the room they serve`, () => {
    const ctx = withHvac(makeContextFixture(), system);
    const m = generateMechanical(ctx);
    const rooms = new Map(ctx.arch!.rooms.map(r => [r.id, r] as const));

    for (const e of m.equipment) {
      if (!e.roomId) continue;
      const room = rooms.get(e.roomId);
      assert.ok(room, `${e.id} references unknown room ${e.roomId}`);
      const fp = rotatedFootprint([e.position[0], e.position[1]], e.width, e.depth, e.rotation);
      assert.ok(rectInside(room!.rect, fp), `${e.id} (${e.type}) is not inside ${room!.type} ${JSON.stringify(room!.rect)}`);
      assert.ok(e.position[2] >= 0, `${e.id} has a negative z`);
      assert.ok(e.position[2] + e.height <= room!.height + 0.06, `${e.id} (${e.type}) pokes through the ceiling of ${room!.type}`);
    }
    for (const t of m.terminals) {
      if (t.type === 'louver') continue; // louvres sit on the outside face of the facade
      const room = rooms.get(t.roomId);
      if (!room) continue;
      assert.ok(rectContainsPoint(room.rect, [t.position[0], t.position[1]], 0.03),
        `terminal ${t.id} (${t.type}) is outside ${room.type}`);
    }
  });

  test(`${system}: duct geometry stays in the ceiling plenum band`, () => {
    const ctx = withHvac(makeContextFixture(), system);
    const m = generateMechanical(ctx);

    for (const e of ductSegments(m)) {
      const g = e.geometry;
      if (g.kind !== 'axis') continue;
      const len = Math.hypot(g.end[0] - g.start[0], g.end[1] - g.start[1], g.end[2] - g.start[2]);
      assert.ok(len > 0.05, `${e.id} is degenerate (${len.toFixed(4)} m)`);
      const { ceiling, f2f } = storeyBand(ctx, e.storey);
      for (const z of [g.start[2], g.end[2]]) {
        assert.ok(z >= ceiling - 1e-6, `${e.id} z=${z} is below the ceiling ${ceiling} on ${e.storey}`);
        assert.ok(z <= f2f + 1e-6, `${e.id} z=${z} is above floor-to-floor ${f2f} on ${e.storey}`);
      }
    }

    // Terminals sit at their room's ceiling (or just below it)
    for (const t of m.terminals) {
      if (t.type === 'louver') continue;
      const { ceiling, f2f } = storeyBand(ctx, t.storey);
      assert.ok(t.position[2] > 0 && t.position[2] <= Math.max(ceiling, f2f), `terminal ${t.id} z=${t.position[2]}`);
    }
  });

  test(`${system}: risers sit inside shaft rects and are emitted per storey`, () => {
    const ctx = withHvac(makeContextFixture(), system);
    const m = generateMechanical(ctx);
    // Pressurisation risers live in the stair enclosure, so cores count as hosts too
    const shafts = new Map<string, Rect>([
      ...ctx.arch!.shafts.map(s => [s.id, s.rect] as const),
      ...ctx.arch!.cores.map(c => [c.id, c.rect] as const),
    ]);
    assert.ok(m.risers.length > 0, 'expected at least one riser');

    for (const r of m.risers) {
      const rect = shafts.get(r.shaftId);
      assert.ok(rect, `riser ${r.id} references unknown shaft ${r.shaftId}`);
      assert.ok(rectContainsPoint(rect!, r.xy, 1e-6), `riser ${r.id} at ${r.xy} is outside shaft ${r.shaftId}`);
    }

    const resiStoreys = ctx.arch!.floors.map(f => f.storey);
    for (const r of m.risers) {
      const segs = m.elements.filter(e => e.tags?.includes('riser') && e.id.startsWith(`${r.id}-`));
      assert.equal(segs.length, resiStoreys.length, `riser ${r.id} should have one segment per storey`);
      for (const s of segs) {
        assert.equal(s.geometry.kind, 'axis');
        if (s.geometry.kind !== 'axis') continue;
        const { f2f } = storeyBand(ctx, s.storey);
        assert.equal(s.geometry.start[2], 0, `riser segment ${s.id} must start at storey-local z 0`);
        assert.ok(Math.abs(s.geometry.end[2] - f2f) < 1e-6, `riser segment ${s.id} must end at floor-to-floor ${f2f}`);
        assert.ok(rectContainsPoint(shafts.get(r.shaftId)!, [s.geometry.start[0], s.geometry.start[1]], 1e-6));
      }
    }
    // Vertical risers must never be modelled as one element spanning several storeys
    for (const e of riserSegments(m)) {
      if (e.geometry.kind !== 'axis') continue;
      const { f2f } = storeyBand(ctx, e.storey);
      assert.ok(e.geometry.end[2] <= f2f + 1e-6, `${e.id} spans past its storey`);
    }
  });

  test(`${system}: roof plant stays inside the plant zone`, () => {
    const ctx = withHvac(makeContextFixture(), system);
    const m = generateMechanical(ctx);
    const zone = ctx.arch!.roof.plantZone!;
    assert.deepEqual(zone, PLANT_ZONE);
    const plant = m.elements.filter(e => e.tags?.includes('roof-plant'));
    for (const e of plant) {
      assert.equal(e.storey, 'ROOF');
      const fp = boxFootprint(e);
      assert.ok(fp, `${e.id} should be a box`);
      assert.ok(fp!.x >= zone.x - 1e-6 && fp!.y >= zone.y - 1e-6
        && fp!.x + fp!.w <= zone.x + zone.w + 1e-6 && fp!.y + fp!.h <= zone.y + zone.h + 1e-6,
        `${e.id} (${e.name}) is outside the plant zone`);
    }
  });
}

// ----------------------------------------------------------------------------
// System-specific behaviour
// ----------------------------------------------------------------------------

test('ducted-heat-pump: air handler in a closet where there is one, hall ceiling otherwise', () => {
  const ctx = withHvac(makeContextFixture(), 'ducted-heat-pump');
  const m = generateMechanical(ctx);
  const indoor = m.equipment.filter(e => e.type === 'indoor-unit');
  assert.equal(indoor.length, ctx.arch!.units.length);
  const byRoomType = indoor.map(e => ctx.arch!.rooms.find(r => r.id === e.roomId)!.type);
  assert.ok(byRoomType.includes('laundry'), 'odd dwellings have a laundry to host the air handler');
  assert.ok(byRoomType.includes('hall'), 'even dwellings fall back to the hall ceiling');
  // one outdoor unit per dwelling, on a balcony or in the roof plant zone
  const odu = m.equipment.filter(e => e.type === 'heat-pump-outdoor');
  assert.equal(odu.length, ctx.arch!.units.length);
  assert.ok(odu.some(e => e.storey === 'ROOF'), 'dwellings without a balcony use the roof');
  assert.ok(odu.some(e => e.roomId && ctx.arch!.rooms.find(r => r.id === e.roomId)?.type === 'balcony'), 'balcony dwellings use the balcony');
});

test('ptac: one packaged unit under a window of every habitable room', () => {
  const ctx = withHvac(makeContextFixture(), 'ptac');
  const m = generateMechanical(ctx);
  const ptacs = m.equipment.filter(e => e.type === 'ptac');
  assert.equal(ptacs.length, habitableRooms(ctx).length);
  for (const p of ptacs) {
    const room = ctx.arch!.rooms.find(r => r.id === p.roomId)!;
    const win = ctx.arch!.windows.find(w => w.roomId === room.id);
    assert.ok(win, `${room.id} should have a window`);
    assert.ok(p.position[2] >= 0.05 && p.position[2] + p.height <= win!.sill + 0.01, 'PTAC must sit below the sill');
  }
  assert.equal(m.equipment.filter(e => e.type === 'heat-pump-outdoor').length, 0, 'PTACs need no outdoor units');
});

test('mvhr-radiators: MVHR box, radiators under windows and a hydronic riser', () => {
  const ctx = withHvac(makeContextFixture(), 'mvhr-radiators', 'mvhr-per-unit');
  const m = generateMechanical(ctx);
  assert.equal(m.equipment.filter(e => e.type === 'mvhr').length, ctx.arch!.units.length);
  assert.equal(m.equipment.filter(e => e.type === 'radiator').length, habitableRooms(ctx).length);
  assert.equal(m.equipment.filter(e => e.type === 'heat-interface-unit').length, ctx.arch!.units.length);
  assert.ok(m.risers.some(r => r.systemType === 'hydronic'));
  for (const rad of m.equipment.filter(e => e.type === 'radiator')) {
    assert.ok(Math.abs(rad.position[2] - 0.15) < 1e-6, 'radiators sit 150 mm above the floor');
  }
});

test('vrf: refrigerant riser in a shaft and one condenser per eight dwellings', () => {
  const ctx = withHvac(makeContextFixture(), 'vrf');
  const m = generateMechanical(ctx);
  assert.ok(m.risers.some(r => r.systemType === 'refrigerant'));
  const cond = m.equipment.filter(e => e.type === 'vrf-condenser');
  assert.equal(cond.length, Math.ceil(ctx.arch!.units.length / 8));
  for (const c of cond) assert.equal(c.storey, 'ROOF');
});

test('central-ahu-fan-coil: fan coils, chiller, AHU and hydronic risers', () => {
  const ctx = withHvac(makeContextFixture(), 'central-ahu-fan-coil');
  const m = generateMechanical(ctx);
  assert.equal(m.equipment.filter(e => e.type === 'fan-coil').length, ctx.arch!.units.length);
  assert.ok(m.equipment.some(e => e.type === 'chiller'));
  assert.ok(m.equipment.some(e => e.type === 'ahu'));
  assert.ok(m.risers.some(r => r.systemType === 'hydronic'));
});

test('ductless-mini-split: one cassette per living room and bedroom, capped refrigerant lines', () => {
  const ctx = withHvac(makeContextFixture(), 'ductless-mini-split');
  const m = generateMechanical(ctx);
  const cassettes = m.equipment.filter(e => e.type === 'indoor-unit');
  assert.equal(cassettes.length, habitableRooms(ctx).length);
  const lines = m.elements.filter(e => e.tags?.includes('refrigerant') && e.ifcType === 'IfcPipeSegment');
  assert.ok(lines.length > 0);
  const high = generateMechanical(withHvac(makeContextFixture({ detail: 'high' }), 'ductless-mini-split'));
  const highLines = high.elements.filter(e => e.tags?.includes('refrigerant') && e.ifcType === 'IfcPipeSegment');
  assert.ok(highLines.length > lines.length, 'detail high runs one line per cassette');
});

// ----------------------------------------------------------------------------
// Corridor spine, plant, loads, patterns, performance
// ----------------------------------------------------------------------------

test('corridor make-up air runs on the duct lane with a diffuser every 9 m', () => {
  const ctx = makeContextFixture();
  const m = generateMechanical(ctx);
  const spineSegs = m.elements.filter(e => e.tags?.includes('corridor-spine'));
  assert.ok(spineSegs.length >= ctx.arch!.floors.length, 'one make-up air spine per storey');
  for (const e of spineSegs) {
    assert.equal(e.geometry.kind, 'axis');
    if (e.geometry.kind !== 'axis') continue;
    // DEFAULT_LANES.duct = 0 → the corridor duct sits exactly on the centreline (y = 13)
    for (const p of [e.geometry.start, e.geometry.end]) {
      assert.ok(Math.abs(p[1] - 13) < 1e-6, `corridor duct must stay on the centreline lane (y=${p[1]})`);
    }
    const fp = ctx.arch!.floors.find(f => f.storey === e.storey)!;
    assert.ok(e.geometry.start[2] > fp.ceilingHeight && e.geometry.start[2] < fp.floorToFloor - fp.slabThickness);
  }
  const corridorDiffusers = m.terminals.filter(t => t.type === 'supply-diffuser' && ctx.arch!.rooms.find(r => r.id === t.roomId)?.type === 'corridor');
  assert.equal(corridorDiffusers.length, 4 * ctx.arch!.floors.length, '30 m corridor → 4 diffusers per storey');
  assert.ok(m.equipment.some(e => e.type === 'rtu' && e.storey === 'ROOF'), 'fed by a rooftop unit');
  assert.ok(m.derived.corridorMakeUpLs > 0);
});

test('mechanical risers take the shaft centre (plumbing/electrical get the corners)', () => {
  const ctx = makeContextFixture();
  const m = generateMechanical(ctx);
  const shafts = new Map(ctx.arch!.shafts.map(s => [s.id, s.rect] as const));
  const centred = m.risers.filter(r => {
    const rect = shafts.get(r.shaftId)!;
    return Math.abs(r.xy[0] - (rect.x + rect.w / 2)) < 1e-6 && Math.abs(r.xy[1] - (rect.y + rect.h / 2)) < 1e-6;
  });
  assert.ok(centred.length > 0, 'the main air riser of a shaft sits at its centre');
  // Every mechanical riser stays in the middle third of the shaft's long axis and on the
  // centreline of the short axis, so both corners stay free for plumbing and electrical.
  for (const r of m.risers) {
    const rect = shafts.get(r.shaftId)!;
    const longIsX = rect.w >= rect.h;
    const along = longIsX ? r.xy[0] - (rect.x + rect.w / 2) : r.xy[1] - (rect.y + rect.h / 2);
    const across = longIsX ? r.xy[1] - (rect.y + rect.h / 2) : r.xy[0] - (rect.x + rect.w / 2);
    const band = Math.max(rect.w, rect.h) / 6;
    assert.ok(Math.abs(along) <= band + 1e-6, `riser ${r.id} left the middle third (${along})`);
    assert.ok(Math.abs(across) <= 1e-6, `riser ${r.id} left the short-axis centreline (${across})`);
  }
});

test('loads follow region and occupancy (MEC-12 / XD-05)', () => {
  const us = generateMechanical(makeContextFixture({ region: 'US' }));
  const uk = generateMechanical(makeContextFixture({ region: 'UK' }));
  assert.equal(us.loads.coolingWPerM2, 65);
  assert.equal(uk.loads.coolingWPerM2, 40);
  assert.equal(us.loads.heatingWPerM2, 50);
  assert.equal(uk.loads.heatingWPerM2, 60);
  assert.ok(us.derived.totalCoolingKw > uk.derived.totalCoolingKw);
  assert.ok(uk.derived.totalHeatingKw > us.derived.totalHeatingKw);
  // 24 dwellings × 91.5 m² × 65 W/m²
  assert.ok(Math.abs(us.derived.totalCoolingKw - 24 * 91.5 * 65 / 1000) < 1);
  // ASHRAE 62.2: 0.15 × 91.5 + 3.5 × 3 = 24.2 l/s per dwelling; Part F 2-bed = 17 l/s
  const usPerUnit = (us.derived.ventilationLs - us.derived.corridorMakeUpLs) / 24;
  const ukPerUnit = (uk.derived.ventilationLs - uk.derived.corridorMakeUpLs) / 24;
  assert.ok(Math.abs(usPerUnit - 24.2) < 0.3, `ASHRAE rate ${usPerUnit}`);
  assert.ok(Math.abs(ukPerUnit - 17) < 0.3, `Part F rate ${ukPerUnit}`);
  assert.ok(us.derived.coolingTons > 0);
});

test('stair pressurisation appears only above 23 m, and towers route ventilation up the shaft', () => {
  const low = generateMechanical(makeContextFixture({ storeys: 4 }));
  assert.equal(low.derived.pressurisedStairs, 0);
  assert.equal(low.elements.filter(e => e.tags?.includes('stair-pressurisation')).length, 0);

  const tallCtx = makeContextFixture({ storeys: 9 });
  const tall = generateMechanical(tallCtx);
  const top = Math.max(...tallCtx.arch!.floors.map(f => tallCtx.storeys.find(s => s.id === f.storey)!.elevation));
  assert.ok(top > 23, `fixture should be taller than 23 m, got ${top}`);
  assert.equal(tall.derived.pressurisedStairs, 1);
  const fans = tall.elements.filter(e => e.tags?.includes('stair-pressurisation'));
  assert.equal(fans.length, tallCtx.arch!.cores.length);
  for (const f of fans) assert.equal(f.storey, 'ROOF');
  // and the fan feeds a duct down the stair enclosure
  const press = tall.risers.filter(r => r.systemType === 'corridor-pressurization');
  assert.equal(press.length, tallCtx.arch!.cores.length);
  for (const r of press) {
    const core = tallCtx.arch!.cores.find(c => c.id === r.shaftId)!;
    assert.ok(rectContainsPoint(core.rect, r.xy, 1e-6));
  }
  assert.ok(tall.risers.some(r => r.systemType === 'outdoor-air'), 'above 8 storeys the intake uses the shaft');
});

test('houses (direct access) put condensers on a ground pad, not on the roof', () => {
  const base = makeContextFixture({ balconies: false });
  const ctx: GenContext = { ...base, typology: { ...base.typology, access: 'direct', hvac: 'ducted-heat-pump' }, warnings: [] };
  const m = generateMechanical(ctx);
  const odu = m.equipment.filter(e => e.type === 'heat-pump-outdoor');
  assert.equal(odu.length, ctx.arch!.units.length);
  for (const e of odu) {
    assert.notEqual(e.storey, 'ROOF', 'a house puts its condenser in the garden, not on the roof');
    assert.ok(e.position[1] > 23, 'ground pads sit at the rear of the footprint');
  }
  assert.equal(m.elements.filter(e => e.tags?.includes('ground-pad')).length, ctx.arch!.units.length);
});

test('houses with no shaft discharge through the exterior wall', () => {
  const ctx = makeContextFixture({ shafts: false });
  const m = generateMechanical(ctx);
  assert.equal(m.risers.filter(r => r.systemType === 'exhaust').length, 0);
  const wallRuns = m.elements.filter(e => e.tags?.includes('through-wall'));
  assert.ok(wallRuns.length > 0, 'ventilation discharges through the facade');
  for (const room of wetRooms(ctx)) {
    assert.ok(m.terminals.some(t => t.type === 'exhaust-grille' && t.roomId === room.id));
  }
});

test('detail level caps the element count', () => {
  const low = generateMechanical(makeContextFixture({ detail: 'low' }));
  const med = generateMechanical(makeContextFixture({ detail: 'medium' }));
  assert.ok(low.elements.length < med.elements.length, 'detail low omits duct fittings and return ducts');
  assert.equal(low.elements.filter(e => e.ifcType === 'IfcDuctFitting').length, 0);
  assert.ok(med.elements.filter(e => e.ifcType === 'IfcDuctFitting').length > 0);
});

test('pattern book is well formed and every application references a known pattern', () => {
  const ids = new Set(MECH_PATTERNS.map(p => p.id));
  assert.equal(ids.size, MECH_PATTERNS.length);
  for (let i = 1; i <= 12; i++) assert.ok(ids.has(`MEC-${String(i).padStart(2, '0')}`), `missing MEC-${i}`);
  for (const p of MECH_PATTERNS) {
    assert.equal(p.discipline, 'mechanical');
    assert.ok(p.problem.length > 80, `${p.id} needs a real problem statement`);
    assert.ok(p.solution.length > 80, `${p.id} needs a real solution statement`);
    assert.ok(Object.keys(p.parameters).length >= 3, `${p.id} needs parameters`);
    for (const [k, v] of Object.entries(p.parameters)) {
      assert.ok(v.source, `${p.id}.${k} needs a source`);
    }
  }
  const known = new Set([...ids, 'XD-01', 'XD-02', 'XD-03', 'XD-04', 'XD-05']);
  for (const system of SYSTEMS) {
    const m = generateMechanical(withHvac(makeContextFixture(), system));
    assert.ok(m.patterns.length > 0);
    for (const a of m.patterns) assert.ok(known.has(a.patternId), `unknown pattern application ${a.patternId}`);
    // every element carries the patterns that produced it
    assert.ok(m.elements.filter(e => (e.patterns ?? []).length > 0).length > m.elements.length * 0.8);
  }
});

test('4 storeys × 6 dwellings generates in under 150 ms', () => {
  const ctx = makeContextFixture();
  generateMechanical(withHvac(ctx, 'ducted-heat-pump')); // warm up
  let worst = 0;
  for (const system of SYSTEMS) {
    const c = withHvac(makeContextFixture(), system);
    const t0 = performance.now();
    generateMechanical(c);
    worst = Math.max(worst, performance.now() - t0);
  }
  assert.ok(worst < 150, `slowest system took ${worst.toFixed(1)} ms`);
});

test('a 20-storey stack stays inside the 2 s budget', () => {
  const ctx = makeContextFixture({ storeys: 20 });
  const t0 = performance.now();
  const m = generateMechanical(ctx);
  const dt = performance.now() - t0;
  assert.ok(dt < 2000, `20 storeys took ${dt.toFixed(0)} ms`);
  assert.equal(m.equipment.filter(e => e.type === 'thermostat').length, 120);
});

// ----------------------------------------------------------------------------
// Integration with the real upstream modules (skipped until they exist)
// ----------------------------------------------------------------------------

const UPSTREAM_READY = await (async (): Promise<boolean> => {
  try {
    await import('../site/index.ts');
    await import('../architecture/index.ts');
    await import('../structure/index.ts');
    return true;
  } catch {
    return false;
  }
})();

/** Runs site → architecture → structure. Returns null (rather than throwing) while those modules are still in flight. */
async function buildUpstream(presetId: string): Promise<{ ctx: GenContext; error?: string } | { ctx: null; error: string }> {
  try {
    const { normalizeSpec, getPreset, buildStoreys } = await import('../../core/spec.ts');
    const { getTypology } = await import('../../core/typologies.ts');
    const { createRng } = await import('../../core/rng.ts');
    const site = await import('../site/index.ts');
    const architecture = await import('../architecture/index.ts');
    const structure = await import('../structure/index.ts');

    const spec = normalizeSpec(getPreset(presetId).spec);
    const typology = getTypology(spec.typology);
    const rng = createRng(spec.seed);
    const warnings: string[] = [];
    const siteModel = site.generateSite(spec, typology, rng.fork('site'), warnings);
    const storeys = siteModel.massing.storeys.length > 0 ? siteModel.massing.storeys : buildStoreys(spec, spec.floors);
    const ctx: GenContext = {
      spec, typology, rng, storeys, site: siteModel,
      arch: null, struct: null, mech: null, plumb: null, elec: null, warnings,
    };
    // The architecture organizer resolves its template / unit-layout dependencies lazily
    if (typeof architecture.resolveArchitectureDeps === 'function') await architecture.resolveArchitectureDeps();
    ctx.arch = architecture.generateArchitecture({ ...ctx, rng: rng.fork('architecture') });
    ctx.struct = structure.generateStructure({ ...ctx, rng: rng.fork('structure') });
    return { ctx };
  } catch (err) {
    return { ctx: null, error: (err as Error).message };
  }
}

test('integration: site → architecture → structure → mechanical for the us-5-over-1 preset', { skip: !UPSTREAM_READY }, async t => {
  const built = await buildUpstream('us-5-over-1');
  if (!built.ctx) {
    t.skip(`upstream site/architecture/structure not ready yet: ${built.error}`);
    return;
  }
  const ctx = built.ctx as GenContext & { arch: NonNullable<GenContext['arch']> };
  const t0 = performance.now();
  const m = generateMechanical({ ...ctx, rng: ctx.rng.fork('mechanical') });
  const dt = performance.now() - t0;

  assert.ok(m.elements.length > 0, 'mechanical produced no elements for the preset');
  assert.ok(dt < 2000, `preset took ${dt.toFixed(0)} ms`);
  const storeyIds = new Set(ctx.storeys.map(s => s.id));
  const floors = new Map(ctx.arch.floors.map(f => [f.storey, f] as const));
  for (const e of m.elements) {
    assert.ok(storeyIds.has(e.storey), `${e.id} on unknown storey ${e.storey}`);
    for (const v of allNumbers(e)) assert.ok(Number.isFinite(v), `non-finite coordinate in ${e.id}`);
    if (e.geometry.kind === 'axis' && e.tags?.includes('duct-segment')) {
      const fp = floors.get(e.storey);
      if (!fp) continue;
      for (const z of [e.geometry.start[2], e.geometry.end[2]]) {
        assert.ok(z >= fp.ceilingHeight - 1e-6 && z <= fp.floorToFloor + 1e-6,
          `${e.id} z=${z} outside the plenum band of ${e.storey}`);
      }
    }
  }
  // ids unique across the real model too
  const ids = new Set<string>();
  for (const e of m.elements) {
    assert.ok(!ids.has(e.id), `duplicate element id ${e.id}`);
    ids.add(e.id);
  }
  const hosts = new Map<string, Rect>([
    ...ctx.arch.shafts.map(s => [s.id, s.rect] as const),
    ...ctx.arch.cores.map(c => [c.id, c.rect] as const),
  ]);
  for (const r of m.risers) {
    const rect = hosts.get(r.shaftId);
    assert.ok(rect, `riser ${r.id} references unknown host ${r.shaftId}`);
    assert.ok(rectContainsPoint(rect!, r.xy, 1e-6), `riser ${r.id} outside ${r.shaftId}`);
    const segs = m.elements.filter(e => e.tags?.includes('riser') && e.id.startsWith(`${r.id}-`));
    assert.ok(segs.length > 0, `riser ${r.id} emitted no per-storey segments`);
    for (const s of segs) {
      if (s.geometry.kind !== 'axis') continue;
      assert.equal(s.geometry.start[2], 0, `${s.id} must start at storey-local z 0`);
    }
  }
  const zone = ctx.arch.roof.plantZone;
  if (zone) {
    for (const e of m.elements.filter(x => x.tags?.includes('roof-plant'))) {
      const fp = boxFootprint(e);
      assert.ok(fp && rectInside(zone, fp, 1e-6), `${e.id} (${e.name}) outside the roof plant zone`);
    }
  }
  for (const room of ctx.arch.rooms.filter(x => x.unitId && WET_ROOMS.has(x.type))) {
    assert.ok(m.terminals.some(t => t.type === 'exhaust-grille' && t.roomId === room.id), `no extract in ${room.id}`);
  }
  for (const room of ctx.arch.rooms.filter(x => x.unitId && HABITABLE.has(x.type))) {
    const servedByTerminal = m.terminals.some(t => t.roomId === room.id);
    const servedByEquipment = m.equipment.some(e => e.roomId === room.id && e.type !== 'thermostat');
    assert.ok(servedByTerminal || servedByEquipment, `habitable room ${room.id} (${room.type}) unserved`);
  }
  assert.equal(m.equipment.filter(e => e.type === 'thermostat').length, ctx.arch.units.length);
});
