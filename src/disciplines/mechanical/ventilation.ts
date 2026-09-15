/**
 * Ventilation: balanced heat recovery per dwelling, wet-room extract, kitchen and dryer
 * exhaust, the shared exhaust risers and their roof fans, and transfer air.
 * Patterns MEC-03, MEC-09, MEC-11 (+ XD-01 / XD-04).
 */
import type {
  DuctSystemType, MechEquipment, RoomDef, Riser, ShaftDef, Vec2, Vec3, WallDef,
} from '../../core/types.ts';
import { add, scale, dist, midpoint, rectCenter, projectOnSegment, segPointAt } from '../../core/geometry.ts';
import type { MechBuild } from './context.ts';
import type { UnitInfo } from './unit-systems.ts';
import { EXTRACT_LS, r1 } from './loads.ts';
import {
  anchorInRoom, boxAtCentre, closestOnRect, isKitchen, joinPath, needsExtract, pushInside, roomCentre,
  routeOrthogonal, nearestShaft, wallFrame, wallFacePoint, wallMountedBox, furnitureCentre,
  plantClosetFor, pathLength,
} from './placement.ts';

/** Above this many residential storeys, dwelling intake/discharge use the shaft, not the facade (MEC-09) */
export const TOWER_STOREY_THRESHOLD = 8;

type ExhaustSystem = Extract<DuctSystemType, 'exhaust' | 'kitchen-exhaust' | 'dryer-exhaust'>;

interface RiserDest { kind: 'riser'; xy: Vec2; riser: Riser; shaft: ShaftDef }
interface WallDest { kind: 'wall'; inside: Vec2; outside: Vec2; wall: WallDef }
interface HrvDest { kind: 'hrv'; xy: Vec2 }
type Dest = RiserDest | WallDest | HrvDest;

/** Where a run enters the plenum-level destination, and where (if anywhere) it leaves the building */
function destPoints(d: Dest): { target: Vec2; outside: Vec2 | null } {
  return d.kind === 'wall' ? { target: d.inside, outside: d.outside } : { target: d.xy, outside: null };
}

function destNote(d: Dest | null): string {
  if (!d) return 'unresolved';
  if (d.kind === 'hrv') return 'to heat-recovery unit';
  if (d.kind === 'riser') return `riser in ${d.shaft.id}`;
  return 'through the exterior wall';
}

export function generateVentilation(b: MechBuild, infos: UnitInfo[]): void {
  const towerMode = b.resiStoreys.length > TOWER_STOREY_THRESHOLD;
  for (const info of infos) {
    const hrv = heatRecoveryFor(b, info);
    const extractRooms = info.rooms.filter(needsExtract);
    let extractLs = 0;
    for (const room of extractRooms) extractLs += extractRoom(b, info, room, hrv);
    kitchenExhaust(b, info);
    dryerExhaust(b, info);
    if (hrv) outdoorAirPair(b, info, hrv, towerMode);
    if (b.ventilation === 'exhaust-only') bathroomFans(b, info, extractRooms);
    if (b.ventilation === 'central-doas') transferAtEntry(b, info);
    b.apply('MEC-09', {
      storey: info.storey.id,
      unitId: info.unit.id,
      params: {
        strategy: b.ventilation,
        standard: info.load.standard,
        wholeDwellingLs: info.load.ventilationLs,
        extractLs: r1(extractLs),
        occupants: info.load.occupants,
        balanced: !!hrv,
      },
    });
  }
  roofExhaustFans(b);
  transferAirSweep(b, infos);
}

// ----------------------------------------------------------------------------
// Heat recovery box (MEC-09)
// ----------------------------------------------------------------------------

export interface Hrv { eq: MechEquipment; xy: Vec2; storey: string; room: RoomDef | null }

/** Reuse the box the HVAC system already placed, or add one for erv/mvhr-per-unit strategies */
function heatRecoveryFor(b: MechBuild, info: UnitInfo): Hrv | null {
  const existing = b.equipment.find(e => e.unitId === info.unit.id && (e.type === 'erv' || e.type === 'mvhr'));
  if (existing) {
    return {
      eq: existing,
      xy: centreOf(existing),
      storey: existing.storey,
      room: existing.roomId ? b.rooms.get(existing.roomId) ?? null : null,
    };
  }
  if (b.ventilation !== 'erv-per-unit' && b.ventilation !== 'mvhr-per-unit') return null;
  const host = plantClosetFor(info.rooms) ?? info.hall;
  if (!host) { b.warn(`${info.unit.id} has no room to host an ERV/MVHR`); return null; }
  const c = roomCentre(host);
  const wall = b.interiorWallOf(host) ?? b.exteriorWallOf(host, info.unit);
  // Stack above anything the HVAC system already put in this room (e.g. the air handler)
  const st = b.storey(host.storey);
  let z = 1.2;
  for (const e of b.equipment) {
    if (e.roomId === host.id) z = Math.max(z, e.position[2] + e.height + 0.05);
  }
  z = Math.min(z, Math.max(0.3, st.ceilingHeight - 0.95));
  const box = wallMountedBox(host, wall, 0.6, 0.6, z);
  const type: MechEquipment['type'] = b.ventilation === 'mvhr-per-unit' ? 'mvhr' : 'erv';
  const eq = b.addEquipment({
    storey: host.storey,
    type,
    roomId: host.id,
    unitId: info.unit.id,
    position: box.position,
    width: 0.6,
    depth: 0.6,
    height: 0.9,
    rotation: box.rotation,
    name: `${type.toUpperCase()} — ${info.unit.id}`,
    patterns: ['MEC-09'],
    serves: info.unit.id,
    airflowLs: info.load.ventilationLs,
    tags: ['heat-recovery'],
  });
  return { eq, xy: centreOf(eq), storey: host.storey, room: host };
}

function centreOf(e: MechEquipment): Vec2 {
  const u: Vec2 = [Math.cos(e.rotation), Math.sin(e.rotation)];
  const v: Vec2 = [-u[1], u[0]];
  return add(add([e.position[0], e.position[1]], scale(u, e.width / 2)), scale(v, e.depth / 2));
}

// ----------------------------------------------------------------------------
// Wet-room extract (MEC-03)
// ----------------------------------------------------------------------------

function extractRoom(b: MechBuild, info: UnitInfo, room: RoomDef, hrv: Hrv | null): number {
  const st = b.storey(room.storey);
  const airflow = (EXTRACT_LS as Record<string, number>)[room.type] ?? 25;
  const grille = anchorInRoom(room, pushInside(room.rect, closestOnRect(room.rect, wetWallPoint(b, info) ?? roomCentre(room)), 0.4));
  b.addTerminal({
    storey: room.storey,
    type: 'exhaust-grille',
    roomId: room.id,
    unitId: info.unit.id,
    xy: grille,
    z: st.ceilingHeight,
    width: 0.15,
    depth: 0.15,
    airflowLs: airflow,
    patterns: ['MEC-03'],
    name: `Extract grille — ${room.name}`,
  });
  const dia = airflow >= 20 ? 0.15 : 0.1;
  const dest: Dest | null = hrv && hrv.storey === room.storey
    ? { kind: 'hrv', xy: hrv.xy }
    : exhaustDest(b, info, room.storey, grille, 'exhaust');
  if (!dest) {
    b.warn(`${room.id}: no shaft or exterior wall for extract`);
    return airflow;
  }
  const { target, outside } = destPoints(dest);
  const path = buildExtractPath(b, info, room.storey, grille, target, outside);
  const runM = pathLength(path);
  if (runM > 12) {
    b.longExtractRuns++;
    b.longestExtractM = Math.max(b.longestExtractM, runM);
  }
  b.addDuct({
    storey: room.storey,
    systemType: 'exhaust',
    path,
    shape: 'round',
    width: dia,
    height: dia,
    servesRoomIds: [room.id],
    unitId: info.unit.id,
    airflowLs: airflow,
    name: `Extract — ${room.name}`,
    patterns: ['MEC-03', 'XD-01'],
  });
  b.apply('MEC-03', {
    storey: room.storey,
    unitId: info.unit.id,
    params: { room: room.type, extractLs: airflow, ductDiameter: dia, route: destNote(dest) },
  });
  return airflow;
}

/** Grille → up into the plenum → wet wall → destination */
function buildExtractPath(b: MechBuild, info: UnitInfo, storeyId: string, from: Vec2, target: Vec2, outside: Vec2 | null): Vec3[] {
  const st = b.storey(storeyId);
  const z = st.unitDuctZ;
  const wet = wetWallPoint(b, info);
  const parts: Vec3[][] = [[[from[0], from[1], st.ceilingHeight + 0.03]], [[from[0], from[1], z]]];
  let cursor = from;
  // Route via the wet wall (XD-01) only when the detour is nearly free
  const direct = manhattan(from, target);
  const viaWet = wet ? manhattan(from, wet) + manhattan(wet, target) : Infinity;
  if (wet && dist(wet, from) > 0.6 && dist(wet, target) > 0.6 && viaWet <= direct * 1.15 + 0.5) {
    parts.push(routeOrthogonal(cursor, wet, z));
    cursor = wet;
  }
  parts.push(routeOrthogonal(cursor, target, z));
  if (outside) parts.push([[outside[0], outside[1], z]]);
  return joinPath(...parts);
}

/** Routed (orthogonal) plan distance — what a duct actually has to travel */
function manhattan(a: Vec2, b: Vec2): number {
  return Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]);
}

/** Midpoint of the dwelling's wet wall (XD-01 routing waypoint) */
function wetWallPoint(b: MechBuild, info: UnitInfo): Vec2 | null {
  for (const id of info.unit.wetWallIds) {
    const w = b.walls.get(id);
    if (w) return midpoint(w.start, w.end);
  }
  return null;
}

/**
 * Maximum ROUTED plan distance to a shaft before extract is better taken straight out
 * through the facade: beyond this the horizontal duct would cross several dwellings.
 * Matches the 12 m branch target of MEC-03. Towers never use the facade.
 */
export const MAX_DISTANCE_TO_SHAFT = 12;

/**
 * Where an extract branch goes (MEC-03). A shared riser in the nearest shaft is preferred
 * while it is within the 12 m branch target; past that the facade wins if it is genuinely
 * closer (houses always use the facade, towers never do — facade discharge is not acceptable
 * at height).
 */
function exhaustDest(b: MechBuild, info: UnitInfo, storeyId: string, from: Vec2, system: ExhaustSystem): Dest | null {
  const shaft = b.shafts.length > 0 ? (nearestShaft(b.shafts, from, storeyId) ?? nearestShaft(b.shafts, from)) : null;
  const towerMode = b.resiStoreys.length > TOWER_STOREY_THRESHOLD;
  const shaftDist = shaft ? manhattan(rectCenter(shaft.rect), from) : Infinity;
  if (!towerMode && shaftDist > MAX_DISTANCE_TO_SHAFT) {
    const facade = wallDest(b, info, from, 0);
    if (facade && (!shaft || manhattan(facade.inside, from) < shaftDist)) return facade;
  }
  if (shaft) {
    const merged: ExhaustSystem = system === 'dryer-exhaust' && b.detail !== 'high' ? 'exhaust' : system;
    const riser = b.ensureRiser(`${shaft.id}:${merged}`, () => ({
      shaftId: shaft.id,
      systemType: merged,
      fromStorey: b.lowestResidentialStoreyId(),
      toStorey: b.roofStoreyId(),
      xy: b.claimShaftXY(shaft, merged === 'exhaust'),
      width: riserSize(b, shaft, merged),
      height: riserSize(b, shaft, merged),
      shape: 'round',
      patterns: ['MEC-03', 'XD-04'],
      serves: shaft.servesUnitIds.join(' ') || shaft.id,
    }));
    return { kind: 'riser', xy: riser.xy, riser, shaft };
  }
  return wallDest(b, info, from, 0);
}

/**
 * Through-wall destination on the exterior wall nearest `from`. The penetration sits at the
 * point on that wall CLOSEST to `from` (architecture walls can span a whole bar, so a fixed
 * fraction along the wall would send the duct across the building); `offsetM` shifts it
 * along the wall, which is how the intake and the discharge are kept apart (MEC-09).
 */
function wallDest(b: MechBuild, info: UnitInfo, from: Vec2, offsetM: number): WallDest | null {
  let best: WallDef | null = null;
  let bestD = Infinity;
  let bestAlong = 0;
  const measure = (w: WallDef): { d: number; along: number } => {
    const proj = projectOnSegment({ a: w.start, b: w.end }, from);
    const at = segPointAt({ a: w.start, b: w.end }, proj.clamped);
    return { d: dist(at, from), along: proj.clamped };
  };
  for (const room of info.rooms) {
    for (const id of room.exteriorWallIds) {
      const w = b.walls.get(id);
      if (!w) continue;
      const m = measure(w);
      if (m.d < bestD) { bestD = m.d; best = w; bestAlong = m.along; }
    }
  }
  if (!best) {
    const any = b.exteriorWallOf(null, info.unit);
    if (!any) return null;
    const m = measure(any);
    if (m.d < bestD) { bestD = m.d; best = any; bestAlong = m.along; }
  }
  if (!best) return null;
  const wall = best;
  const frame = wallFrame(wall, info.centre);
  const along = Math.min(Math.max(bestAlong + offsetM, 0.3), Math.max(0.3, frame.length - 0.3));
  const inside = wallFacePoint(wall, frame, along);
  const outside = add(inside, scale(frame.inward, -(wall.thickness + 0.2)));
  return { kind: 'wall', inside, outside, wall };
}

function riserSize(b: MechBuild, shaft: ShaftDef, system: ExhaustSystem): number {
  const unitsPerShaft = shaft.servesUnitIds.length > 0
    ? shaft.servesUnitIds.length
    : Math.max(1, Math.round(b.units.length / Math.max(1, b.shafts.length) / Math.max(1, b.resiStoreys.length)));
  const storeys = Math.max(1, b.resiStoreys.length);
  const perUnit = system === 'kitchen-exhaust' ? EXTRACT_LS.kitchen : system === 'dryer-exhaust' ? 60 : 2 * EXTRACT_LS.bathroom;
  const q = perUnit * unitsPerShaft * storeys * 0.4; // l/s with diversity
  const dia = 2 * Math.sqrt((q / 1000) / 8.0 / Math.PI); // 8 m/s in the riser
  return Math.min(0.6, Math.max(0.15, Math.ceil(dia / 0.05) * 0.05));
}

// ----------------------------------------------------------------------------
// Kitchen (MEC-11) and dryer exhaust
// ----------------------------------------------------------------------------

function kitchenExhaust(b: MechBuild, info: UnitInfo): void {
  const kitchen = info.rooms.find(isKitchen) ?? (info.unit.kitchenRoomId ? b.rooms.get(info.unit.kitchenRoomId) ?? null : null);
  if (!kitchen) return;
  const st = b.storey(kitchen.storey);
  const range = b.furnitureOf(kitchen.id).find(f => f.type === 'range');
  const counter = b.furnitureOf(kitchen.id).find(f => f.type === 'kitchen-counter' || f.type === 'kitchen-island');
  const anchor = range ?? counter;
  const xy = anchor ? furnitureCentre(anchor) : anchorInRoom(kitchen, pushInside(kitchen.rect, closestOnRect(kitchen.rect, roomCentre(kitchen)), 0.4));
  const rot = anchor ? anchor.rotation : 0;
  const hoodZ = Math.min(1.65, Math.max(1.2, st.ceilingHeight - 0.6));
  const box = boxAtCentre(xy, 0.76, 0.5, hoodZ, rot);
  b.addEquipment({
    storey: kitchen.storey,
    type: 'range-hood',
    roomId: kitchen.id,
    unitId: info.unit.id,
    position: box.position,
    width: 0.76,
    depth: 0.5,
    height: 0.15,
    rotation: box.rotation,
    name: `Range hood — ${kitchen.name}`,
    patterns: ['MEC-11'],
    serves: kitchen.id,
    airflowLs: EXTRACT_LS.kitchen,
    tags: ['range-hood'],
  });
  const dest = exhaustDest(b, info, kitchen.storey, xy, 'kitchen-exhaust');
  if (dest) {
    const { target, outside } = destPoints(dest);
    b.addDuct({
      storey: kitchen.storey,
      systemType: 'kitchen-exhaust',
      path: joinPath(
        [[xy[0], xy[1], st.ceilingHeight + 0.03]],
        [[xy[0], xy[1], st.unitDuctZ]],
        routeOrthogonal(xy, target, st.unitDuctZ),
        outside ? [[outside[0], outside[1], st.unitDuctZ]] : [],
      ),
      shape: 'round',
      width: 0.15,
      height: 0.15,
      servesRoomIds: [kitchen.id],
      unitId: info.unit.id,
      airflowLs: EXTRACT_LS.kitchen,
      name: `Kitchen exhaust — ${kitchen.name}`,
      patterns: ['MEC-11', 'MEC-03'],
    });
  }
  b.apply('MEC-11', {
    storey: kitchen.storey,
    unitId: info.unit.id,
    params: {
      overRange: !!range,
      airflowLs: EXTRACT_LS.kitchen,
      ductDiameter: 0.15,
      faceZ: hoodZ,
      dedicatedRiser: !!dest && dest.kind === 'riser',
    },
  });
}

function dryerExhaust(b: MechBuild, info: UnitInfo): void {
  let dryer: { xy: Vec2; room: RoomDef } | null = null;
  for (const room of info.rooms) {
    const f = b.furnitureOf(room.id).find(x => x.type === 'dryer');
    if (f) { dryer = { xy: furnitureCentre(f), room }; break; }
  }
  if (!dryer) {
    const laundry = info.rooms.find(r => r.type === 'laundry' || r.type === 'utility');
    if (!laundry) return;
    dryer = { xy: roomCentre(laundry), room: laundry };
  }
  const st = b.storey(dryer.room.storey);
  const dest = exhaustDest(b, info, dryer.room.storey, dryer.xy, 'dryer-exhaust');
  if (!dest) return;
  const { target, outside } = destPoints(dest);
  b.addDuct({
    storey: dryer.room.storey,
    systemType: 'dryer-exhaust',
    path: joinPath(
      [[dryer.xy[0], dryer.xy[1], st.ceilingHeight + 0.03]],
      [[dryer.xy[0], dryer.xy[1], st.unitDuctZ]],
      routeOrthogonal(dryer.xy, target, st.unitDuctZ),
      outside ? [[outside[0], outside[1], st.unitDuctZ]] : [],
    ),
    shape: 'round',
    width: 0.1,
    height: 0.1,
    servesRoomIds: [dryer.room.id],
    unitId: info.unit.id,
    airflowLs: 60,
    name: `Dryer exhaust — ${dryer.room.name}`,
    patterns: ['MEC-03'],
  });
}

// ----------------------------------------------------------------------------
// Outdoor air pair (MEC-09)
// ----------------------------------------------------------------------------

function outdoorAirPair(b: MechBuild, info: UnitInfo, hrv: Hrv, towerMode: boolean): void {
  const st = b.storey(hrv.storey);
  const z = st.unitDuctZ;
  const dia = 0.15;
  if (!towerMode) {
    const intake = wallDest(b, info, hrv.xy, -0.6);
    const discharge = wallDest(b, info, hrv.xy, 0.6);
    if (intake && discharge) {
      addWallDuct(b, info, hrv, st.id, z, dia, intake, 'outdoor-air', 'Outdoor air intake');
      addWallDuct(b, info, hrv, st.id, z, dia, discharge, 'exhaust', 'Ventilation discharge');
      b.addTerminal({
        storey: st.id, type: 'louver', roomId: hrv.room?.id ?? info.unit.roomIds[0], unitId: info.unit.id,
        xy: intake.outside, z, width: 0.3, depth: 0.3, airflowLs: info.load.ventilationLs,
        patterns: ['MEC-09'], name: `Intake louver — ${info.unit.id}`,
      });
      b.addTerminal({
        storey: st.id, type: 'louver', roomId: hrv.room?.id ?? info.unit.roomIds[0], unitId: info.unit.id,
        xy: discharge.outside, z, width: 0.3, depth: 0.3, airflowLs: info.load.ventilationLs,
        patterns: ['MEC-09'], name: `Discharge louver — ${info.unit.id}`,
      });
      return;
    }
  }
  // Tower (or no facade available): intake and discharge use shaft risers
  const shaft = nearestShaft(b.shafts, hrv.xy, st.id) ?? nearestShaft(b.shafts, hrv.xy);
  if (!shaft) { b.warn(`${info.unit.id}: no facade or shaft for the ventilation intake`); return; }
  const intakeRiser = b.ensureRiser(`${shaft.id}:outdoor-air`, () => ({
    shaftId: shaft.id,
    systemType: 'outdoor-air',
    fromStorey: b.lowestResidentialStoreyId(),
    toStorey: b.roofStoreyId(),
    xy: b.claimShaftXY(shaft, false),
    width: 0.4,
    height: 0.4,
    shape: 'round',
    patterns: ['MEC-09', 'XD-04'],
    serves: shaft.servesUnitIds.join(' ') || shaft.id,
  }));
  b.addDuct({
    storey: st.id,
    systemType: 'outdoor-air',
    path: joinPath([[hrv.xy[0], hrv.xy[1], z]], routeOrthogonal(hrv.xy, intakeRiser.xy, z)),
    shape: 'round',
    width: dia,
    height: dia,
    unitId: info.unit.id,
    airflowLs: info.load.ventilationLs,
    name: `Outdoor air — ${info.unit.id}`,
    patterns: ['MEC-09'],
  });
  const exhaustRiser = b.findRiser(`${shaft.id}:exhaust`);
  if (exhaustRiser) {
    b.addDuct({
      storey: st.id,
      systemType: 'exhaust',
      path: joinPath([[hrv.xy[0], hrv.xy[1], z]], routeOrthogonal(hrv.xy, exhaustRiser.xy, z)),
      shape: 'round',
      width: dia,
      height: dia,
      unitId: info.unit.id,
      airflowLs: info.load.ventilationLs,
      name: `Ventilation discharge — ${info.unit.id}`,
      patterns: ['MEC-09'],
    });
  }
}

function addWallDuct(
  b: MechBuild, info: UnitInfo, hrv: Hrv, storeyId: string, z: number, dia: number,
  dest: WallDest, system: DuctSystemType, name: string,
): void {
  b.addDuct({
    storey: storeyId,
    systemType: system,
    path: joinPath([[hrv.xy[0], hrv.xy[1], z]], routeOrthogonal(hrv.xy, dest.inside, z), [[dest.outside[0], dest.outside[1], z]]),
    shape: 'round',
    width: dia,
    height: dia,
    unitId: info.unit.id,
    airflowLs: info.load.ventilationLs,
    name: `${name} — ${info.unit.id}`,
    patterns: ['MEC-09'],
    tags: ['through-wall'],
  });
}

// ----------------------------------------------------------------------------
// Exhaust-only fans, transfer air, roof fans
// ----------------------------------------------------------------------------

function bathroomFans(b: MechBuild, info: UnitInfo, rooms: RoomDef[]): void {
  for (const room of rooms) {
    const st = b.storey(room.storey);
    const c = anchorInRoom(room, pushInside(room.rect, closestOnRect(room.rect, roomCentre(room)), 0.35));
    const box = boxAtCentre(c, 0.25, 0.25, Math.max(0.2, st.ceilingHeight + 0.02));
    b.addEquipment({
      storey: room.storey,
      type: 'exhaust-fan',
      roomId: room.id,
      unitId: info.unit.id,
      position: box.position,
      width: 0.25,
      depth: 0.25,
      height: 0.2,
      name: `Extract fan — ${room.name}`,
      patterns: ['MEC-03', 'MEC-09'],
      serves: room.id,
      airflowLs: (EXTRACT_LS as Record<string, number>)[room.type] ?? 25,
      tags: ['inline-fan'],
    });
  }
}

/** Transfer grille above the unit entry door (central DOAS makes up air through the corridor) */
function transferAtEntry(b: MechBuild, info: UnitInfo): void {
  const st = info.storey;
  const hall = info.hall;
  const raw = info.entry ?? (hall ? roomCentre(hall) : info.centre);
  // `info.entry` is the door centre on the wall centreline: step inside the hall
  const at = hall ? anchorInRoom(hall, pushInside(hall.rect, closestOnRect(hall.rect, raw), 0.25)) : raw;
  b.addTerminal({
    storey: st.id,
    type: 'transfer-grille',
    roomId: hall?.id ?? info.unit.roomIds[0],
    unitId: info.unit.id,
    xy: at,
    z: Math.min(2.25, st.ceilingHeight - 0.1),
    width: 0.4,
    depth: 0.15,
    airflowLs: info.load.ventilationLs,
    patterns: ['MEC-05', 'MEC-09'],
    name: `Transfer grille — ${info.unit.id} entry`,
  });
}

/** One roof fan per exhaust / kitchen-exhaust riser, sitting on its shaft (MEC-03) */
function roofExhaustFans(b: MechBuild): void {
  const roof = b.roofStoreyId();
  let n = 0;
  for (const riser of b.risers) {
    if (riser.systemType !== 'exhaust' && riser.systemType !== 'kitchen-exhaust' && riser.systemType !== 'dryer-exhaust') continue;
    const box = boxAtCentre(riser.xy, 0.6, 0.6, 0.1);
    b.addEquipment({
      storey: roof,
      type: 'exhaust-fan',
      position: box.position,
      width: 0.6,
      depth: 0.6,
      height: 0.5,
      name: `Roof exhaust fan — ${riser.id}`,
      patterns: ['MEC-03', 'XD-04'],
      serves: riser.shaftId,
      tags: ['roof-fan'],
      ifc: { objectType: 'Roof-mounted exhaust fan' },
    });
    n++;
  }
  if (n > 0) b.apply('MEC-03', { storey: roof, params: { roofFans: n, risers: b.risers.length } });
}

/**
 * Safety net: any habitable room that ended up with no diffuser, cassette, PTAC or radiator
 * gets a transfer grille at the room edge nearest the hall, so no conditioned room is left
 * without an air path.
 */
function transferAirSweep(b: MechBuild, infos: UnitInfo[]): void {
  const served = new Set<string>();
  for (const t of b.terminals) served.add(t.roomId);
  for (const e of b.equipment) if (e.roomId && e.type !== 'thermostat') served.add(e.roomId);
  let added = 0;
  for (const info of infos) {
    const hallC = info.hall ? roomCentre(info.hall) : info.centre;
    for (const room of info.habitable) {
      if (served.has(room.id)) continue;
      const st = b.storey(room.storey);
      const at = anchorInRoom(room, pushInside(room.rect, closestOnRect(room.rect, hallC), 0.3));
      b.addTerminal({
        storey: room.storey,
        type: 'transfer-grille',
        roomId: room.id,
        unitId: info.unit.id,
        xy: at,
        z: Math.min(2.25, st.ceilingHeight - 0.1),
        width: 0.4,
        depth: 0.15,
        airflowLs: 15,
        patterns: ['MEC-09'],
        name: `Transfer grille — ${room.name}`,
      });
      served.add(room.id);
      added++;
    }
  }
  if (added > 0) {
    b.apply('MEC-09', { params: { transferGrilles: added }, note: 'transfer air to habitable rooms without a local terminal' });
  }
}
