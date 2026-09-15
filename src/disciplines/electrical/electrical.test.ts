/**
 * Electrical discipline invariants. Run with:
 *   node --test src/disciplines/electrical/*.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import type { DoorDef, ElecModel, ModelElement, RoomDef, RoomType } from '../../core/types.ts';
import { pointInPolygon, projectOnSegment, rectCenter } from '../../core/geometry.ts';
import { generateElectrical } from './index.ts';
import { ELEC_PATTERNS } from './patterns.ts';
import { STANDARD_SERVICE_AMPS } from './region.ts';
import { makeContextFixture, type Fixture } from './test-fixtures.ts';

const HABITABLE: RoomType[] = ['living', 'dining', 'living-kitchen', 'kitchen', 'bedroom', 'master-bedroom', 'study', 'den'];
const SWITCHES = new Set(['switch', 'dimmer']);
const RECEPTACLES = new Set(['receptacle', 'gfci-receptacle', 'range-receptacle', 'dryer-receptacle']);

function build(opts: Parameters<typeof makeContextFixture>[0] = {}): { fixture: Fixture; model: ElecModel } {
  const fixture = makeContextFixture(opts);
  const model = generateElectrical(fixture.ctx);
  return { fixture, model };
}

const base = build({ detail: 'high' });

function isEgressDoor(f: Fixture, d: DoorDef): boolean {
  if (d.type === 'exit' || d.type === 'building-entry') return true;
  const rooms = [d.fromRoomId, d.toRoomId];
  return rooms.some(id => id && f.arch.rooms.find(r => r.id === id)?.type === 'stair');
}

function numbersOf(e: ModelElement): number[] {
  const g = e.geometry as Record<string, unknown>;
  const out: number[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'number') out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(g);
  return out;
}

// ---------------------------------------------------------------------------

test('generates a non-trivial model with unique ids and no NaN', () => {
  const { model } = base;
  assert.ok(model.elements.length > 500, `expected many elements, got ${model.elements.length}`);
  assert.ok(model.devices.length > 500);
  const ids = new Set<string>();
  for (const e of model.elements) {
    assert.ok(!ids.has(e.id), `duplicate element id ${e.id}`);
    ids.add(e.id);
    assert.equal(e.discipline, 'electrical');
    assert.ok(e.ifcType.startsWith('Ifc'), `bad ifcType ${e.ifcType}`);
    for (const n of numbersOf(e)) assert.ok(Number.isFinite(n), `non-finite geometry in ${e.id}`);
  }
  const circuitIds = new Set(model.circuits.map(c => c.id));
  assert.equal(circuitIds.size, model.circuits.length, 'duplicate circuit ids');
  for (const d of model.devices) for (const n of d.position) assert.ok(Number.isFinite(n), `NaN device position ${d.id}`);
  for (const p of model.panels) for (const n of p.position) assert.ok(Number.isFinite(n), `NaN panel position ${p.id}`);
  for (const v of Object.values(model.derived)) assert.ok(Number.isFinite(v), 'non-finite derived value');
});

test('ELE-03/05/13: every habitable room has receptacles, a light and a switch', () => {
  const { fixture, model } = base;
  const rooms = fixture.arch.rooms.filter(r => r.unitId && HABITABLE.includes(r.type));
  assert.ok(rooms.length >= 24 * 4);
  for (const room of rooms) {
    const devices = model.devices.filter(d => d.roomId === room.id);
    const recept = devices.filter(d => RECEPTACLES.has(d.type)).length;
    const lights = devices.filter(d => d.type.startsWith('light-')).length;
    const switches = devices.filter(d => SWITCHES.has(d.type)).length;
    assert.ok(recept >= 2, `${room.id} (${room.type}) has ${recept} receptacles`);
    assert.ok(lights >= 1, `${room.id} (${room.type}) has no luminaire`);
    assert.ok(switches >= 1, `${room.id} (${room.type}) has no switch`);
  }
});

test('ELE-03: receptacles sit on a wall face inside their room', () => {
  const { fixture, model } = base;
  const roomById = new Map(fixture.arch.rooms.map(r => [r.id, r] as const));
  const wallById = new Map(fixture.arch.walls.map(w => [w.id, w] as const));
  let checked = 0;
  for (const d of model.devices) {
    if (!RECEPTACLES.has(d.type) || !d.roomId || !d.wallId) continue;
    const room = roomById.get(d.roomId);
    const wall = wallById.get(d.wallId);
    if (!room || !wall) continue;
    checked++;
    const pr = projectOnSegment({ a: wall.start, b: wall.end }, [d.position[0], d.position[1]]);
    const offFace = Math.abs(Math.abs(pr.offset) - wall.thickness / 2);
    assert.ok(offFace <= 0.1, `${d.id} is ${offFace.toFixed(3)} m off the face of ${wall.id}`);
    const inward: [number, number] = [-Math.sin(d.rotation), Math.cos(d.rotation)];
    const probe: [number, number] = [d.position[0] + inward[0] * 0.06, d.position[1] + inward[1] * 0.06];
    assert.ok(pointInPolygon(probe, room.polygon), `${d.id} faces out of ${room.id}`);
    assert.ok(d.position[2] > 0.1 && d.position[2] < 2.0, `${d.id} mounting height ${d.position[2]}`);
  }
  assert.ok(checked > 300, `only ${checked} wall-hosted receptacles checked`);
});

test('ELE-04: the kitchen has counter GFCIs and dedicated appliance outlets', () => {
  const { fixture, model } = base;
  for (const unit of fixture.arch.units) {
    const kitchenId = unit.kitchenRoomId;
    assert.ok(kitchenId, `${unit.id} has no kitchen`);
    const devices = model.devices.filter(d => d.roomId === kitchenId);
    const counter = devices.filter(d => d.type === 'gfci-receptacle' && Math.abs(d.position[2] - 1.1) < 0.01);
    assert.ok(counter.length >= 4, `${unit.id} kitchen has ${counter.length} counter GFCIs`);
    assert.ok(devices.some(d => d.type === 'range-receptacle'), `${unit.id} has no range receptacle`);
    const circuitTypes = new Set(model.circuits
      .filter(c => devices.some(d => c.deviceIds.includes(d.id)))
      .map(c => c.type));
    for (const want of ['kitchen-small-appliance', 'refrigerator', 'dishwasher', 'range']) {
      assert.ok(circuitTypes.has(want as never), `${unit.id} kitchen is missing a ${want} circuit`);
    }
    const sa = model.circuits.filter(c => c.type === 'kitchen-small-appliance'
      && devices.some(d => c.deviceIds.includes(d.id)));
    assert.ok(sa.length >= 2, `${unit.id} has ${sa.length} small-appliance circuits`);
  }
});

test('ELE-06: every bedroom and hall has a smoke alarm, every dwelling a CO alarm', () => {
  const { fixture, model } = base;
  const sleeping = fixture.arch.rooms.filter(r => r.unitId
    && (r.type === 'bedroom' || r.type === 'master-bedroom' || r.type === 'hall'));
  for (const room of sleeping) {
    const alarms = model.devices.filter(d => d.roomId === room.id && d.type === 'smoke-alarm');
    assert.ok(alarms.length >= 1, `${room.id} (${room.type}) has no smoke alarm`);
    for (const a of alarms) assert.ok(a.position[2] > 2.0, `${a.id} is not at the ceiling`);
  }
  for (const unit of fixture.arch.units) {
    const co = model.devices.filter(d => d.unitId === unit.id && d.type === 'co-alarm');
    assert.equal(co.length >= 1, true, `${unit.id} has no CO alarm`);
  }
  const corridorSmoke = model.devices.filter(d => d.type === 'smoke-alarm'
    && fixture.arch.rooms.find(r => r.id === d.roomId)?.type === 'corridor');
  assert.ok(corridorSmoke.length >= fixture.storeys.filter(s => s.index >= 0 && s.index < 100).length);
});

test('ELE-02: one panel per dwelling, never in a bathroom, bedroom or kitchen', () => {
  const { fixture, model } = base;
  const roomById = new Map(fixture.arch.rooms.map(r => [r.id, r] as const));
  const forbidden: RoomType[] = ['bathroom', 'ensuite', 'powder', 'wc', 'bedroom', 'master-bedroom', 'kitchen', 'living-kitchen', 'closet', 'walk-in-closet'];
  for (const unit of fixture.arch.units) {
    const panels = model.panels.filter(p => p.type === 'unit-panel' && p.unitId === unit.id);
    assert.equal(panels.length, 1, `${unit.id} has ${panels.length} panels`);
    const panel = panels[0];
    const room = panel.roomId ? roomById.get(panel.roomId) : undefined;
    assert.ok(room, `panel ${panel.id} has no room`);
    assert.ok(!forbidden.includes(room!.type), `panel of ${unit.id} is in a ${room!.type}`);
    assert.equal(room!.unitId, unit.id, 'panel is in another dwelling');
    assert.ok(panel.amps >= 100, `panel ${panel.id} is only ${panel.amps} A`);
    assert.ok(panel.circuitCount >= 10, `panel ${panel.id} has ${panel.circuitCount} circuits`);
    // the panel body must be inside the room it serves
    const inward: [number, number] = [-Math.sin(panel.rotation), Math.cos(panel.rotation)];
    const probe: [number, number] = [panel.position[0] + inward[0] * 0.08, panel.position[1] + inward[1] * 0.08];
    assert.ok(pointInPolygon(probe, room!.polygon), `panel ${panel.id} faces out of ${room!.id}`);
  }
});

test('ELE-01: service equipment, meters and a buried lateral exist', () => {
  const { fixture, model } = base;
  const msb = model.panels.filter(p => p.type === 'main-switchboard');
  assert.equal(msb.length, 1);
  const meters = model.panels.filter(p => p.type === 'meter-bank');
  assert.equal(meters.length, Math.ceil(fixture.arch.units.length / 6));
  assert.ok(model.panels.some(p => p.type === 'house-panel'));
  const room = fixture.arch.rooms.find(r => r.id === msb[0].roomId);
  assert.equal(room?.type, 'elec-room');
  const lateral = model.elements.filter(e => e.predefinedType === 'CONDUITSEGMENT' && e.storey === 'SITE');
  assert.ok(lateral.length >= 2, 'no service lateral');
  for (const e of lateral) {
    const g = e.geometry;
    assert.equal(g.kind, 'axis');
    if (g.kind === 'axis') assert.ok(g.start[2] < 0, 'the lateral should be buried');
  }
  // > 600 A service → utility transformer on the site
  if (model.service.amps > 600) {
    assert.ok(model.devices.some(d => d.type === 'transformer' && d.storey === 'SITE'));
  }
});

test('ELE-08: every exit and stair door is signed', () => {
  const { fixture, model } = base;
  const wallById = new Map(fixture.arch.walls.map(w => [w.id, w] as const));
  const signs = model.devices.filter(d => d.type === 'exit-sign');
  const doors = fixture.arch.doors.filter(d => isEgressDoor(fixture, d));
  assert.ok(doors.length >= 8, `only ${doors.length} egress doors in the fixture`);
  for (const door of doors) {
    const wall = wallById.get(door.wallId);
    assert.ok(wall, `door ${door.id} has no wall`);
    const dir = [wall!.end[0] - wall!.start[0], wall!.end[1] - wall!.start[1]];
    const len = Math.hypot(dir[0], dir[1]);
    const p = [wall!.start[0] + (dir[0] / len) * door.along, wall!.start[1] + (dir[1] / len) * door.along];
    const near = signs.filter(s => s.storey === door.storey
      && Math.hypot(s.position[0] - p[0], s.position[1] - p[1]) < 1.0);
    assert.ok(near.length >= 1, `no exit sign at ${door.id} (${door.type})`);
    for (const s of near) assert.ok(Math.abs(s.position[2] - 2.3) < 0.01, 'exit sign height');
  }
  assert.equal(signs.length, doors.length);
  assert.ok(model.devices.filter(d => d.type === 'light-emergency').length >= doors.length);
});

test('ELE-07/XD-02: a tray spine on the corridor lane of every storey', () => {
  const { fixture, model } = base;
  const storeys = fixture.storeys.filter(s => s.index >= 0 && s.index < 100).map(s => s.id);
  for (const storey of storeys) {
    const corridor = fixture.arch.floors.find(f => f.storey === storey)?.corridors[0];
    assert.ok(corridor, `no corridor on ${storey}`);
    const trays = model.trays.filter(t => t.storey === storey);
    assert.ok(trays.length >= 2, `${storey} has ${trays.length} trays`);
    const power = trays.find(t => t.purpose === 'power');
    assert.ok(power, `${storey} has no power tray`);
    const centre = corridor!.centerline[0];
    for (const p of power!.path) {
      const pr = projectOnSegment(centre, [p[0], p[1]]);
      assert.ok(Math.abs(pr.offset - 0.35) < 0.01, `tray lateral offset ${pr.offset.toFixed(3)} on ${storey}`);
      const ceiling = fixture.arch.floors.find(f => f.storey === storey)!.ceilingHeight;
      assert.ok(p[2] > ceiling, `tray z ${p[2]} is below the ceiling ${ceiling}`);
    }
    const data = trays.find(t => t.purpose === 'data');
    assert.ok(data, `${storey} has no data tray`);
    const prData = projectOnSegment(centre, [data!.path[0][0], data!.path[0][1]]);
    assert.ok(Math.abs(prData.offset - 0.5) < 0.01, 'data tray lane');
  }
  const trayElements = model.elements.filter(e => e.predefinedType === 'CABLETRAYSEGMENT');
  assert.ok(trayElements.length >= storeys.length * 2);
  assert.ok(model.derived.trayLengthM > 100);
});

test('ELE-12/XD-04: a riser per storey inside an electrical shaft', () => {
  const { fixture, model } = base;
  const shafts = fixture.arch.shafts.filter(s => s.purpose === 'electrical' || s.purpose === 'combined');
  assert.equal(model.risers.length, shafts.length);
  for (const riser of model.risers) {
    const shaft = shafts.find(s => s.id === riser.shaftId);
    assert.ok(shaft, `riser ${riser.id} references an unknown shaft`);
    const r = shaft!.rect;
    assert.ok(riser.xy[0] >= r.x && riser.xy[0] <= r.x + r.w, 'riser x inside the shaft');
    assert.ok(riser.xy[1] >= r.y && riser.xy[1] <= r.y + r.h, 'riser y inside the shaft');
  }
  const storeys = fixture.storeys.filter(s => s.index >= 0 && s.index < 100);
  for (const st of storeys) {
    const runs = model.elements.filter(e => e.storey === st.id && e.objectType === 'Cable riser');
    assert.equal(runs.length, shafts.length, `${st.id} has ${runs.length} riser segments`);
    for (const run of runs) {
      assert.equal(run.geometry.kind, 'axis');
      if (run.geometry.kind === 'axis') {
        assert.equal(run.geometry.start[0], run.geometry.end[0]);
        assert.ok(run.geometry.end[2] > run.geometry.start[2], 'riser runs upward');
        const inShaft = shafts.some(s => run.geometry.kind === 'axis'
          && run.geometry.start[0] >= s.rect.x && run.geometry.start[0] <= s.rect.x + s.rect.w
          && run.geometry.start[1] >= s.rect.y && run.geometry.start[1] <= s.rect.y + s.rect.h);
        assert.ok(inShaft, 'riser segment outside every shaft');
      }
    }
  }
});

test('ELE-10: one charger per EV stall', () => {
  const { fixture, model } = base;
  const stalls = fixture.site.parking?.spaces.filter(s => s.type === 'ev').length ?? 0;
  assert.ok(stalls > 0, 'the fixture should have EV stalls');
  const chargers = model.devices.filter(d => d.type === 'ev-charger');
  assert.equal(chargers.length, stalls);
  assert.equal(model.derived.evChargers, stalls);
  assert.ok(model.panels.some(p => p.type === 'ev-panel'));
  for (const c of chargers) {
    const stall = fixture.site.parking!.spaces.find(s => s.type === 'ev'
      && Math.hypot(rectCenter(s.rect)[0] - c.position[0], rectCenter(s.rect)[1] - c.position[1]) < 4);
    assert.ok(stall, `charger ${c.id} is not at a stall`);
  }
});

test('ELE-09: PV fills at least 60 % of the PV zone', () => {
  const { fixture, model } = base;
  const zone = fixture.arch.roof.pvZone;
  assert.ok(zone, 'the fixture should have a PV zone');
  assert.ok(model.pv, 'no PV array');
  const covered = model.pv!.panelRects.reduce((a, r) => a + r.w * r.h, 0);
  const ratio = covered / (zone!.w * zone!.h);
  assert.ok(ratio >= 0.6, `PV covers only ${(ratio * 100).toFixed(0)} % of the zone`);
  assert.ok(model.pv!.kwDc > 0);
  for (const r of model.pv!.panelRects) {
    assert.ok(r.x >= zone!.x - 1e-6 && r.x + r.w <= zone!.x + zone!.w + 1e-6, 'panel outside the zone in x');
    assert.ok(r.y >= zone!.y - 1e-6 && r.y + r.h <= zone!.y + zone!.h + 1e-6, 'panel outside the zone in y');
  }
  assert.equal(model.devices.filter(d => d.type === 'pv-panel').length, model.pv!.panelRects.length);
  assert.ok(model.devices.some(d => d.type === 'inverter'));
  assert.ok(model.panels.some(p => p.type === 'pv-combiner'));
});

test('ELE-11: demand is below connected load and the service is a standard size', () => {
  const { fixture, model } = base;
  assert.ok(STANDARD_SERVICE_AMPS.includes(model.service.amps), `${model.service.amps} A is not a standard size`);
  assert.ok(model.loads.demandVa < model.loads.connectedVa, 'demand should be below connected load');
  assert.ok(model.loads.demandVa > 0);
  assert.ok(model.loads.perUnitVa > 5000 && model.loads.perUnitVa < 40000, `per-dwelling demand ${model.loads.perUnitVa} VA`);
  assert.equal(model.service.phases, 3, '24 dwellings in the US → 208Y/120 V 3-phase');
  const amps = model.loads.demandVa / (208 * Math.sqrt(3));
  assert.ok(model.service.amps >= amps, 'service smaller than the calculated demand');
  assert.ok(model.derived.multifamilyDemandFactor > 0.2 && model.derived.multifamilyDemandFactor < 0.5);
  assert.ok(model.derived.lightingPowerDensityWPerM2 <= 5, `LPD ${model.derived.lightingPowerDensityWPerM2} W/m²`);
  assert.ok(fixture.arch.units.length === 24);
});

test('circuits reference existing panels and devices', () => {
  const { model } = base;
  const panelIds = new Set(model.panels.map(p => p.id));
  const deviceIds = new Set(model.devices.map(d => d.id));
  assert.ok(model.circuits.length > 100);
  for (const c of model.circuits) {
    assert.ok(panelIds.has(c.panelId), `circuit ${c.id} references a missing panel`);
    for (const id of c.deviceIds) assert.ok(deviceIds.has(id), `circuit ${c.id} references a missing device ${id}`);
    assert.ok(c.amps > 0 && c.voltage > 0 && c.va >= 0);
  }
  const assigned = model.devices.filter(d => d.circuitId);
  assert.ok(assigned.length > model.devices.length * 0.6, 'most devices should be on a circuit');
  for (const d of assigned) {
    const c = model.circuits.find(x => x.id === d.circuitId);
    assert.ok(c, `device ${d.id} points at a missing circuit`);
    assert.ok(c!.deviceIds.includes(d.id), 'circuit / device link is not symmetric');
  }
});

test('elements carry psets, systems and patterns', () => {
  const { model } = base;
  const systems = new Set(model.elements.map(e => e.system));
  for (const s of ['SYS-ELE-POWER-LV', 'SYS-ELE-LIGHTING', 'SYS-ELE-LIFE-SAFETY', 'SYS-ELE-DATA', 'SYS-ELE-PV', 'SYS-ELE-EV']) {
    assert.ok(systems.has(s), `missing system ${s}`);
  }
  for (const e of model.elements) {
    assert.ok(e.psets && e.psets.length >= 1, `${e.id} has no pset`);
    assert.ok(e.psets![0].name === 'Forma_Electrical');
    assert.ok(e.color && e.color.length === 3);
  }
  const ifcTypes = new Set(model.elements.map(e => e.ifcType));
  for (const t of ['IfcOutlet', 'IfcSwitchingDevice', 'IfcLightFixture', 'IfcSensor', 'IfcElectricDistributionBoard', 'IfcCableCarrierSegment', 'IfcSolarDevice', 'IfcElectricAppliance', 'IfcUnitaryControlElement', 'IfcTransformer']) {
    assert.ok(ifcTypes.has(t), `missing ifcType ${t}`);
  }
});

test('pattern book and applications line up', () => {
  const { model } = base;
  const ids = new Set(ELEC_PATTERNS.map(p => p.id));
  assert.equal(ids.size, 13);
  for (let i = 1; i <= 13; i++) assert.ok(ids.has(`ELE-${String(i).padStart(2, '0')}`), `missing ELE-${i}`);
  for (const p of ELEC_PATTERNS) {
    assert.equal(p.discipline, 'electrical');
    assert.ok(p.problem.length > 80 && p.solution.length > 80, `${p.id} needs a fuller problem/solution`);
    assert.ok(Object.keys(p.parameters).length >= 4, `${p.id} has too few parameters`);
    for (const key of Object.keys(p.parameters)) {
      assert.ok(p.parameters[key].source, `${p.id}.${key} has no source`);
    }
  }
  const applied = new Set(model.patterns.map(a => a.patternId));
  for (const id of ['ELE-01', 'ELE-02', 'ELE-03', 'ELE-04', 'ELE-05', 'ELE-06', 'ELE-07', 'ELE-08', 'ELE-09', 'ELE-10', 'ELE-11', 'ELE-12', 'ELE-13']) {
    assert.ok(applied.has(id), `pattern ${id} was never applied`);
  }
  for (const a of model.patterns) {
    assert.ok(ids.has(a.patternId) || a.patternId.startsWith('XD-'), `unknown pattern ${a.patternId}`);
  }
  const xd = new Set(model.elements.flatMap(e => e.patterns ?? []).filter(p => p.startsWith('XD-')));
  assert.ok(xd.has('XD-02') && xd.has('XD-04'), 'cross patterns should be referenced by elements');
});

test('detail levels scale the device count', () => {
  const low = build({ detail: 'low' }).model;
  const medium = build({ detail: 'medium' }).model;
  const high = base.model;
  assert.ok(low.devices.length < medium.devices.length, 'low < medium');
  assert.ok(medium.devices.length < high.devices.length, 'medium < high');
  assert.ok(low.devices.length > 100, 'low should still be a complete installation');
  assert.ok(low.panels.length === high.panels.length, 'panels do not depend on detail');
});

test('UK preset uses 230 V ring finals and socket minima', () => {
  const { fixture, model } = build({ region: 'UK', detail: 'high' });
  assert.equal(model.service.voltage, '400Y/230 V 3ph');
  assert.equal(model.service.phases, 3);
  const unit = fixture.arch.units[0];
  const panel = model.panels.find(p => p.unitId === unit.id);
  assert.equal(panel?.amps, 100, 'UK consumer unit is 100 A');
  const rings = model.circuits.filter(c => c.type === 'general-receptacle' && c.panelId === panel!.id);
  assert.ok(rings.length >= 1);
  for (const r of rings) {
    assert.equal(r.amps, 32, 'ring final should be 32 A');
    assert.equal(r.voltage, 230);
  }
  const lighting = model.circuits.filter(c => c.type === 'lighting' && c.panelId === panel!.id);
  for (const l of lighting) assert.equal(l.amps, 6, 'UK lighting circuits are 6 A');
  const bedrooms = fixture.arch.rooms.filter(r => r.unitId === unit.id && (r.type === 'bedroom' || r.type === 'master-bedroom'));
  for (const b of bedrooms) {
    const n = model.devices.filter(d => d.roomId === b.id && RECEPTACLES.has(d.type)).length;
    assert.ok(n >= 3 && n <= 5, `UK bedroom should have 3–5 sockets, got ${n}`);
  }
});

test('works without the structure, mechanical and plumbing models', () => {
  const { model } = build({ withStruct: false, withMech: false, withPlumb: false });
  assert.ok(model.devices.length > 400);
  assert.ok(model.trays.length > 0, 'trays still run without structure');
  assert.equal(model.devices.filter(d => d.type === 'thermostat').length, 0);
  assert.ok(model.loads.demandVa > 0);
  assert.ok(model.service.amps > 0);
});

test('a 20-storey stack uses busduct risers and stays fast', () => {
  const t0 = performance.now();
  const { fixture, model } = build({ storeys: 20, detail: 'high' });
  const ms = performance.now() - t0;
  assert.equal(fixture.arch.units.length, 120);
  assert.ok(model.risers.every(r => r.type === 'busduct'), 'above 6 storeys the riser is a busduct');
  assert.ok(model.elements.some(e => e.objectType === 'Busduct'));
  assert.equal(model.panels.filter(p => p.type === 'floor-distribution').length, 20);
  assert.equal(model.panels.filter(p => p.type === 'meter-bank').length, 20);
  assert.ok(model.service.amps >= 1200, `service ${model.service.amps} A for 120 dwellings`);
  assert.ok(ms < 2000, `20 storeys took ${ms.toFixed(0)} ms`);
});

test('an empty architecture model degrades gracefully', () => {
  const fixture = makeContextFixture();
  const model = generateElectrical({ ...fixture.ctx, arch: null, warnings: [] });
  assert.equal(model.devices.length, 0);
  assert.equal(model.elements.length, 0);
  assert.equal(model.service.amps, 0);
});

test('generation of the fixture at detail high is under 300 ms', () => {
  const fixture = makeContextFixture({ detail: 'high' });
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const ctx = { ...fixture.ctx, warnings: [] as string[] };
    const t0 = performance.now();
    generateElectrical(ctx);
    best = Math.min(best, performance.now() - t0);
  }
  assert.ok(best < 300, `generation took ${best.toFixed(1)} ms`);
});

test('no warnings for the reference fixture', () => {
  const { fixture } = base;
  assert.deepEqual(fixture.ctx.warnings, []);
});

// ---------------------------------------------------------------------------
// Integration with the real upstream modules (skipped until they land)
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const disciplines = resolve(here, '..');
const upstream = ['site', 'architecture', 'structure', 'mechanical', 'plumbing'];
const upstreamReady = upstream.every(d => existsSync(resolve(disciplines, d, 'index.ts')))
  && existsSync(resolve(here, '..', '..', 'core', 'metrics.ts'));

test('integration: full chain for the us-5-over-1 preset', { skip: !upstreamReady }, async () => {
  const [{ generateBuilding }, { getPreset }, architecture] = await Promise.all([
    import('../../pipeline.ts'),
    import('../../core/spec.ts'),
    import('../architecture/index.ts') as Promise<{ resolveArchitectureDeps?: () => Promise<unknown> }>,
  ]);
  // architecture needs its unit templates / layout engine wired up before the first call
  if (typeof architecture.resolveArchitectureDeps === 'function') await architecture.resolveArchitectureDeps();
  const preset = getPreset('us-5-over-1');
  const model = generateBuilding({ ...preset.spec, options: { ...(preset.spec.options ?? {}), detail: 'high' } });
  const elec = model.elec;
  assert.ok(elec, 'the pipeline produced no electrical model');
  assert.ok(elec!.devices.length > 100, `only ${elec!.devices.length} devices`);
  assert.ok(elec!.panels.filter(p => p.type === 'unit-panel').length === model.arch.units.length, 'one panel per dwelling');
  assert.ok(STANDARD_SERVICE_AMPS.includes(elec!.service.amps));
  assert.ok(elec!.loads.demandVa < elec!.loads.connectedVa);
  assert.ok(elec!.circuits.length > 0);
  for (const e of elec!.elements) {
    for (const n of numbersOf(e)) assert.ok(Number.isFinite(n), `non-finite geometry in ${e.id}`);
  }
  const habitable: RoomDef[] = model.arch.rooms.filter(r => r.unitId && HABITABLE.includes(r.type));
  const withLight = habitable.filter(r => elec!.devices.some(d => d.roomId === r.id && d.type.startsWith('light-')));
  assert.ok(withLight.length >= habitable.length * 0.9, 'most habitable rooms should be lit');
  for (const room of habitable) {
    const devices = elec!.devices.filter(d => d.roomId === room.id);
    assert.ok(devices.filter(d => RECEPTACLES.has(d.type)).length >= 2, `${room.id} (${room.type}) has too few receptacles`);
    assert.ok(devices.some(d => SWITCHES.has(d.type)), `${room.id} (${room.type}) has no switch`);
  }

  // geometry against the real architecture model
  const roomById = new Map(model.arch.rooms.map(r => [r.id, r] as const));
  const wallById = new Map(model.arch.walls.map(w => [w.id, w] as const));
  let offWall = 0;
  let outside = 0;
  for (const d of elec!.devices) {
    if (d.wallId) {
      const wall = wallById.get(d.wallId);
      assert.ok(wall, `device ${d.id} references a missing wall`);
      const pr = projectOnSegment({ a: wall!.start, b: wall!.end }, [d.position[0], d.position[1]]);
      if (Math.abs(Math.abs(pr.offset) - wall!.thickness / 2) > 0.11) offWall++;
    }
    const room = d.roomId ? roomById.get(d.roomId) : undefined;
    if (!room) continue;
    const inward: [number, number] = [-Math.sin(d.rotation), Math.cos(d.rotation)];
    if (!pointInPolygon([d.position[0] + inward[0] * 0.06, d.position[1] + inward[1] * 0.06], room.polygon)) outside++;
  }
  assert.equal(offWall, 0, `${offWall} devices are not on the face of the wall they are tagged with`);
  assert.equal(outside, 0, `${outside} devices sit outside the room they belong to`);

  // egress and distribution against the real model
  const egress = model.arch.doors.filter(d => isEgressDoorFor(model.arch.rooms, d));
  assert.equal(elec!.devices.filter(d => d.type === 'exit-sign').length, egress.length);
  for (const floor of model.arch.floors) {
    if (floor.corridors.length === 0) continue;
    assert.ok(elec!.trays.some(t => t.storey === floor.storey), `no tray on ${floor.storey}`);
  }
  assert.deepEqual(model.warnings.filter(w => w.startsWith('electrical')), []);
});

function isEgressDoorFor(rooms: RoomDef[], d: DoorDef): boolean {
  if (d.type === 'exit' || d.type === 'building-entry') return true;
  return [d.fromRoomId, d.toRoomId].some(id => id && rooms.find(r => r.id === id)?.type === 'stair');
}

const writerReady = upstreamReady && existsSync(resolve(here, '..', '..', 'ifc', 'writer.ts'));

test('integration: every electrical element reaches the IFC file', { skip: !writerReady }, async () => {
  const [{ generateBuilding }, { getPreset }, architecture, { writeIfc }] = await Promise.all([
    import('../../pipeline.ts'),
    import('../../core/spec.ts'),
    import('../architecture/index.ts') as Promise<{ resolveArchitectureDeps?: () => Promise<unknown> }>,
    import('../../ifc/writer.ts'),
  ]);
  if (typeof architecture.resolveArchitectureDeps === 'function') await architecture.resolveArchitectureDeps();
  const preset = getPreset('au-walkup');
  const model = generateBuilding({ ...preset.spec, options: { ...(preset.spec.options ?? {}), detail: 'high' } });
  const out = writeIfc(model, { deterministic: true });
  const elements = model.elec?.elements ?? [];
  assert.ok(elements.length > 100);
  const unmapped = elements.filter(e => !out.idMap[e.id]);
  assert.deepEqual(unmapped.map(e => `${e.ifcType} ${e.id}`), [], 'every electrical element must be writable');
});
