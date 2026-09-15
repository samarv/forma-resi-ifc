/**
 * Per-dwelling HVAC systems (patterns MEC-01, MEC-02, MEC-04, MEC-08, MEC-10).
 * One function per HvacSystemId; everything shares the trunk-and-branch distribution,
 * the outdoor-unit placement rule and the single dwelling thermostat.
 */
import type {
  DuctSystemType, MechEquipment, RoomDef, Segment2, UnitInstance, Vec2, Vec3,
} from '../../core/types.ts';
import {
  add, scale, angleOf, dist, rectUnionBounds, rectCenter,
} from '../../core/geometry.ts';
import { MOUNTING } from '../../core/coordination.ts';
import type { MechBuild, StoreyInfo } from './context.ts';
import type { UnitLoad } from './loads.ts';
import { r1, r3, rectTrunkWidth, roundBranchDiameter } from './loads.ts';
import {
  anchorInRoom, boxAgainstWall, boxAtCentre, clampFootprint, closestOnPath, closestOnRect, closestOnSegment, hallOf,
  isHabitable, longAxis, pathLength, pushInside, rectSpine, roomAreaOf, roomCentre, routeOrthogonal,
  joinPath, wallAnchor, wallFrame, wallMountedBox, windowPoint, firstOfType, plantClosetFor, nearestShaft,
} from './placement.ts';

export interface UnitInfo {
  unit: UnitInstance;
  /** Entry storey */
  storey: StoreyInfo;
  rooms: RoomDef[];
  hall: RoomDef | null;
  habitable: RoomDef[];
  load: UnitLoad;
  entry: Vec2 | null;
  centre: Vec2;
}

/** Rooms of a dwelling grouped by the storey they sit on (multi-level dwellings) */
export function roomsByStorey(rooms: RoomDef[]): Map<string, RoomDef[]> {
  const m = new Map<string, RoomDef[]>();
  for (const r of rooms) {
    const arr = m.get(r.storey);
    if (arr) arr.push(r);
    else m.set(r.storey, [r]);
  }
  return m;
}

export function buildUnitInfo(b: MechBuild, unit: UnitInstance, load: UnitLoad): UnitInfo {
  const storeyId = unit.storeys[0] ?? b.lowestResidentialStoreyId();
  const rooms = b.unitRooms(unit);
  const entry = b.entryPoint(unit);
  const entryRooms = rooms.filter(r => r.storey === storeyId);
  return {
    unit,
    storey: b.storey(storeyId),
    rooms,
    hall: hallOf(entryRooms.length > 0 ? entryRooms : rooms, entry),
    habitable: rooms.filter(isHabitable),
    load,
    entry,
    centre: rectCenter(unit.rect),
  };
}

// ----------------------------------------------------------------------------
// Shared distribution (MEC-02)
// ----------------------------------------------------------------------------

export interface SupplyResult {
  diffusers: number;
  maxRunM: number;
  trunkM: number;
}

export interface SupplyOpts {
  info: UnitInfo;
  /** Plenum connection point of the source (air handler / fan coil / MVHR) */
  sourceXY: Vec2;
  sourceStorey: string;
  totalLs: number;
  trunkDepth: number;
  patterns: string[];
  systemType?: DuctSystemType;
  returnGrille: boolean;
  /** Name prefix for the runs */
  label: string;
}

/**
 * Trunk along the hall ceiling + one short round branch per habitable room, ending in a
 * ceiling diffuser at the room edge nearest the hall (coordination rule: never cross a
 * bedroom). Runs once per storey occupied by the dwelling.
 */
export function supplyDistribution(b: MechBuild, o: SupplyOpts): SupplyResult {
  const out: SupplyResult = { diffusers: 0, maxRunM: 0, trunkM: 0 };
  const groups = roomsByStorey(o.info.habitable);
  if (groups.size === 0) return out;
  const totalArea = o.info.habitable.reduce((s, r) => s + roomAreaOf(r), 0) || 1;
  const systemType: DuctSystemType = o.systemType ?? 'supply';

  for (const [storeyId, rooms] of groups) {
    const st = b.storey(storeyId);
    const z = st.unitDuctZ;
    const ceiling = st.ceilingHeight;
    const storeyRooms = o.info.rooms.filter(r => r.storey === storeyId);
    const hall = storeyId === o.info.storey.id ? o.info.hall : hallOf(storeyRooms, null);
    const spine = spineFor(storeyRooms.length > 0 ? storeyRooms : rooms, hall);
    const source: Vec2 = storeyId === o.sourceStorey ? o.sourceXY : closestOnSegment(spine, o.info.centre);

    const attach = closestOnSegment(spine, source);
    const far = dist(attach, spine.a) > dist(attach, spine.b) ? spine.a : spine.b;
    const storeyLs = o.totalLs * (rooms.reduce((s, r) => s + roomAreaOf(r), 0) / totalArea);
    const trunkWidth = rectTrunkWidth(storeyLs, o.trunkDepth);
    const trunkPath = joinPath(routeOrthogonal(source, attach, z), [[far[0], far[1], z]]);
    const trunk = b.addDuct({
      storey: storeyId,
      systemType,
      path: trunkPath,
      shape: 'rect',
      width: trunkWidth,
      height: o.trunkDepth,
      servesRoomIds: rooms.map(r => r.id),
      unitId: o.info.unit.id,
      airflowLs: storeyLs,
      name: `${o.label} trunk`,
      patterns: o.patterns,
    });
    const trunkLen = trunk ? pathLength(trunk.path) : 0;
    out.trunkM += trunkLen;

    for (const room of rooms) {
      const share = roomAreaOf(room) / totalArea;
      const branchLs = Math.max(8, o.totalLs * share);
      const dia = roundBranchDiameter(branchLs);
      const start = trunk ? closestOnPath(trunk.path, roomCentre(room)) : [source[0], source[1], z] as Vec3;
      const edge = closestOnRect(room.rect, [start[0], start[1]]);
      const term = anchorInRoom(room, pushInside(room.rect, edge, 0.5));
      const branchPath = joinPath(
        routeOrthogonal([start[0], start[1]], term, z),
        [[term[0], term[1], ceiling + 0.03]],
      );
      b.addDuct({
        storey: storeyId,
        systemType,
        path: branchPath,
        shape: 'round',
        width: dia,
        height: dia,
        servesRoomIds: [room.id],
        unitId: o.info.unit.id,
        airflowLs: branchLs,
        name: `${o.label} branch to ${room.name}`,
        patterns: o.patterns,
      });
      b.addTerminal({
        storey: storeyId,
        type: 'supply-diffuser',
        roomId: room.id,
        unitId: o.info.unit.id,
        xy: term,
        z: ceiling,
        airflowLs: branchLs,
        patterns: o.patterns,
        name: `Supply diffuser — ${room.name}`,
      });
      out.diffusers++;
      const developed = trunkLen + pathLength(branchPath);
      out.maxRunM = Math.max(out.maxRunM, developed);
    }

    if (o.returnGrille && hall) {
      const hc = roomCentre(hall);
      b.addTerminal({
        storey: storeyId,
        type: 'return-grille',
        roomId: hall.id,
        unitId: o.info.unit.id,
        xy: hc,
        z: ceiling,
        width: 0.5,
        depth: 0.4,
        airflowLs: storeyLs * 0.9,
        patterns: o.patterns,
        name: `Return grille — ${hall.name}`,
      });
      if (b.detail !== 'low' && dist(hc, source) > 1.2) {
        b.addDuct({
          storey: storeyId,
          systemType: 'return',
          path: joinPath([[hc[0], hc[1], ceiling + 0.03]], routeOrthogonal(hc, source, z)),
          shape: 'rect',
          width: trunkWidth,
          height: o.trunkDepth,
          servesRoomIds: [hall.id],
          unitId: o.info.unit.id,
          airflowLs: storeyLs * 0.9,
          name: `${o.label} return`,
          patterns: o.patterns,
        });
      }
    }
  }
  return out;
}

function spineFor(rooms: RoomDef[], hall: RoomDef | null): Segment2 {
  if (hall) return rectSpine(hall.rect, 0.3);
  return rectSpine(rectUnionBounds(rooms.map(r => r.rect)), 1.0);
}

// ----------------------------------------------------------------------------
// Indoor plant placement
// ----------------------------------------------------------------------------

export interface IndoorSpot {
  eq: MechEquipment;
  /** Where the duct connects in the plenum */
  plenum: Vec2;
  inCloset: boolean;
}

/** Air handler in a closet if one will take it, else recessed in the hall ceiling (MEC-02) */
export function placeIndoorUnit(
  b: MechBuild,
  info: UnitInfo,
  type: MechEquipment['type'],
  horizontal: { w: number; d: number; h: number },
  patterns: string[],
  capacityKw: number,
  forceCeiling = false,
): IndoorSpot | null {
  const st = info.storey;
  const closet = forceCeiling ? null : plantCloset(b, info);
  if (closet) {
    const c = roomCentre(closet);
    const rot = angleOf(longAxis(closet.rect));
    const box = boxAtCentre(c, 0.6, 0.7, 0.05, rot);
    const eq = b.addEquipment({
      storey: closet.storey,
      type,
      roomId: closet.id,
      unitId: info.unit.id,
      position: box.position,
      width: 0.6,
      depth: 0.7,
      height: 1.6,
      rotation: box.rotation,
      capacityKw,
      name: `Air handler — ${info.unit.id}`,
      patterns,
      serves: info.unit.id,
      airflowLs: info.load.supplyLs,
    });
    return { eq, plenum: c, inCloset: true };
  }
  const hall = info.hall;
  const anchor = hall ?? (info.rooms.length > 0 ? info.rooms[0] : null);
  if (!anchor) return null;
  const c = roomCentre(anchor);
  const rot = angleOf(longAxis(anchor.rect));
  const z = Math.max(0.1, st.ceilingHeight - horizontal.h);
  const box = boxAtCentre(c, horizontal.w, horizontal.d, z, rot);
  const eq = b.addEquipment({
    storey: anchor.storey,
    type,
    roomId: anchor.id,
    unitId: info.unit.id,
    position: box.position,
    width: horizontal.w,
    depth: horizontal.d,
    height: horizontal.h,
    rotation: box.rotation,
    capacityKw,
    name: `Indoor unit — ${info.unit.id}`,
    patterns,
    serves: info.unit.id,
    airflowLs: info.load.supplyLs,
  });
  return { eq, plenum: c, inCloset: false };
}

export function plantCloset(b: MechBuild, info: UnitInfo): RoomDef | null {
  return plantClosetFor(info.rooms);
}

// ----------------------------------------------------------------------------
// Outdoor units (MEC-04)
// ----------------------------------------------------------------------------

export interface OutdoorSpot {
  eq: MechEquipment;
  storey: string;
  centre: Vec2;
  topZ: number;
  where: 'balcony' | 'roof' | 'ground';
}

export function placeOutdoorUnit(
  b: MechBuild,
  info: UnitInfo,
  type: MechEquipment['type'],
  size: { w: number; d: number; h: number },
  capacityKw: number,
  patterns: string[],
): OutdoorSpot {
  const balcony = info.unit.balconyRoomId ? b.rooms.get(info.unit.balconyRoomId) : undefined;
  const direct = b.ctx.typology.access === 'direct';
  const roofOk = !!b.ctx.arch?.roof.plantZone || b.ctx.arch?.roof.type === 'flat';

  if (balcony && balcony.rect.w >= size.w + 0.2 && balcony.rect.h >= size.d + 0.2) {
    // Tuck it against the balcony's far corner, clear of the door
    const min: Vec2 = [balcony.rect.x + balcony.rect.w - size.w - 0.1, balcony.rect.y + 0.1];
    const eq = b.addEquipment({
      storey: balcony.storey,
      type,
      roomId: balcony.id,
      unitId: info.unit.id,
      position: [min[0], min[1], 0.1],
      width: size.w, depth: size.d, height: size.h,
      capacityKw,
      name: `Outdoor unit — ${info.unit.id} (balcony)`,
      patterns,
      serves: info.unit.id,
      tags: ['outdoor-unit', 'balcony'],
    });
    return { eq, storey: balcony.storey, centre: [min[0] + size.w / 2, min[1] + size.d / 2], topZ: 0.1 + size.h, where: 'balcony' };
  }

  if (!direct && roofOk) return roofSpot(b, info, type, size, capacityKw, patterns);
  if (direct || !roofOk) {
    const min = b.nextGroundPad(size.w, size.d);
    const storey = b.lowestResidentialStoreyId();
    const eq = b.addEquipment({
      storey,
      type,
      unitId: info.unit.id,
      position: [min[0], min[1], 0.1],
      width: size.w, depth: size.d, height: size.h,
      capacityKw,
      name: `Outdoor unit — ${info.unit.id} (ground pad)`,
      patterns,
      serves: info.unit.id,
      tags: ['outdoor-unit', 'ground-pad'],
    });
    return { eq, storey, centre: [min[0] + size.w / 2, min[1] + size.d / 2], topZ: 0.1 + size.h, where: 'ground' };
  }
  return roofSpot(b, info, type, size, capacityKw, patterns);
}

function roofSpot(
  b: MechBuild,
  info: UnitInfo,
  type: MechEquipment['type'],
  size: { w: number; d: number; h: number },
  capacityKw: number,
  patterns: string[],
): OutdoorSpot {
  const min = b.roofGrid.place(size.w, size.d);
  const storey = b.roofStoreyId();
  const eq = b.addEquipment({
    storey,
    type,
    unitId: info.unit.id,
    position: [min[0], min[1], 0.1],
    width: size.w, depth: size.d, height: size.h,
    capacityKw,
    name: `Outdoor unit — ${info.unit.id} (roof plant)`,
    patterns: [...patterns, 'MEC-06'],
    serves: info.unit.id,
    tags: ['outdoor-unit', 'roof-plant'],
  });
  return { eq, storey, centre: [min[0] + size.w / 2, min[1] + size.d / 2], topZ: 0.1 + size.h, where: 'roof' };
}

/**
 * Refrigerant line from a dwelling to its condenser. Same storey → routed in the ceiling
 * band and dropped to the unit; roof → routed to the nearest shaft and a shared refrigerant
 * riser. Emitted as IfcPipeSegment, so it is allowed to leave the duct plenum band.
 */
export function refrigerantLine(b: MechBuild, info: UnitInfo, fromXY: Vec2, spot: OutdoorSpot, patterns: string[]): void {
  const st = info.storey;
  const z = st.unitDuctZ;
  if (spot.storey === st.id) {
    const path = joinPath(
      [[fromXY[0], fromXY[1], z]],
      routeOrthogonal(fromXY, spot.centre, z),
      [[spot.centre[0], spot.centre[1], r3(spot.topZ)]],
    );
    b.addDuct({
      storey: st.id,
      systemType: 'outdoor-air',
      systemOverride: 'refrigerant',
      path,
      shape: 'round',
      width: 0.03,
      height: 0.03,
      unitId: info.unit.id,
      name: `Refrigerant line — ${info.unit.id}`,
      patterns,
      pipe: true,
      tags: ['refrigerant'],
    });
    return;
  }
  // Condenser is on the roof: run to the shaft and share a refrigerant riser
  const shaft = nearestShaft(b.shafts, fromXY, st.id) ?? nearestShaft(b.shafts, fromXY);
  if (!shaft) {
    b.warn(`no shaft for the refrigerant riser of ${info.unit.id}; line omitted`);
    return;
  }
  const riser = b.ensureRiser(`${shaft.id}:refrigerant`, () => ({
    shaftId: shaft.id,
    systemType: 'refrigerant',
    fromStorey: b.lowestResidentialStoreyId(),
    toStorey: b.roofStoreyId(),
    xy: b.claimShaftXY(shaft, false),
    width: 0.09,
    height: 0.09,
    shape: 'round',
    patterns: [...patterns, 'XD-04'],
    serves: shaft.servesUnitIds.join(' ') || shaft.id,
  }));
  const xy = riser.xy;
  b.addDuct({
    storey: st.id,
    systemType: 'outdoor-air',
    systemOverride: 'refrigerant',
    path: joinPath([[fromXY[0], fromXY[1], z]], routeOrthogonal(fromXY, xy, z)),
    shape: 'round',
    width: 0.03,
    height: 0.03,
    unitId: info.unit.id,
    name: `Refrigerant branch — ${info.unit.id}`,
    patterns,
    pipe: true,
    tags: ['refrigerant'],
  });
}

// ----------------------------------------------------------------------------
// Thermostat (MEC-10)
// ----------------------------------------------------------------------------

export function addThermostat(b: MechBuild, info: UnitInfo): void {
  const room = info.hall ?? (info.rooms.length > 0 ? info.rooms[0] : null);
  if (!room) return;
  const box = wallMountedBox(room, b.interiorWallOf(room), 0.1, 0.03, MOUNTING.thermostat);
  b.addEquipment({
    storey: room.storey,
    type: 'thermostat',
    roomId: room.id,
    unitId: info.unit.id,
    position: box.position,
    width: 0.1,
    depth: 0.03,
    height: 0.1,
    rotation: box.rotation,
    name: `Thermostat — ${info.unit.id}`,
    patterns: ['MEC-10'],
    serves: info.unit.id,
    tags: ['thermostat'],
  });
  b.apply('MEC-10', {
    storey: room.storey,
    unitId: info.unit.id,
    params: { mountingZ: MOUNTING.thermostat, room: room.type, count: 1 },
  });
}

// ----------------------------------------------------------------------------
// Under-window emitters (MEC-08)
// ----------------------------------------------------------------------------

/** Box under the room's first window (or against its exterior wall) */
export function underWindow(b: MechBuild, room: RoomDef, w: number, d: number, mode: 'radiator' | 'ptac'): { position: Vec3; rotation: number } | null {
  const wins = b.windowsOf(room.id);
  const c = roomCentre(room);
  const win = wins[0];
  if (win) {
    const wall = b.walls.get(win.wallId);
    if (wall) {
      const frame = wallFrame(wall, c);
      const p = windowPoint(win, wall);
      const face = add(p, scale(frame.inward, wall.thickness / 2));
      const z = mode === 'radiator' ? 0.15 : Math.max(0.05, win.sill - d - 0.05);
      return boxAgainstWall(face, frame, w, d, mode === 'ptac' ? Math.max(0.05, win.sill - 0.45) : z);
    }
  }
  const ext = b.exteriorWallOf(room);
  if (ext) {
    const anchor = wallAnchor(room, ext, w);
    if (anchor) return boxAgainstWall(anchor.face, anchor.frame, w, d, mode === 'radiator' ? 0.15 : 0.45);
  }
  return null;
}

// ----------------------------------------------------------------------------
// The six systems
// ----------------------------------------------------------------------------

export function ductedHeatPump(b: MechBuild, info: UnitInfo): void {
  const patterns = ['MEC-01', 'MEC-02'];
  const capacityKw = info.load.coolingW / 1000;
  const indoor = placeIndoorUnit(b, info, 'indoor-unit', { w: 1.2, d: 0.6, h: 0.35 }, patterns, capacityKw);
  if (!indoor) { b.warn(`${info.unit.id} has no room to host an air handler`); return; }
  const res = supplyDistribution(b, {
    info,
    sourceXY: indoor.plenum,
    sourceStorey: indoor.eq.storey,
    totalLs: info.load.supplyLs,
    trunkDepth: Math.min(0.25, info.storey.unitDuctDepth),
    patterns,
    returnGrille: true,
    label: 'Supply',
  });
  const spot = placeOutdoorUnit(b, info, 'heat-pump-outdoor', { w: 0.9, d: 0.35, h: 0.8 }, capacityKw, ['MEC-04']);
  refrigerantLine(b, info, indoor.plenum, spot, ['MEC-04']);
  recordSupply(b, info, res, indoor.inCloset ? 'closet' : 'hall ceiling');
  recordOutdoor(b, info, spot);
}

export function ductlessMiniSplit(b: MechBuild, info: UnitInfo): void {
  const patterns = ['MEC-01', 'MEC-04'];
  const targets = info.habitable.filter(r => r.type === 'living' || r.type === 'living-kitchen' || r.type === 'bedroom' || r.type === 'master-bedroom' || r.type === 'shared-living');
  const rooms = targets.length > 0 ? targets : info.habitable;
  const perRoomKw = rooms.length > 0 ? info.load.coolingW / 1000 / rooms.length : info.load.coolingW / 1000;
  const cassettes: { xy: Vec2; storey: string }[] = [];
  for (const room of rooms) {
    const st = b.storey(room.storey);
    const z = Math.min(2.2, Math.max(0.5, st.ceilingHeight - 0.35));
    const spot = underWindow(b, room, 0.9, 0.25, 'radiator');
    const c = roomCentre(room);
    const box = spot ? { position: [spot.position[0], spot.position[1], z] as Vec3, rotation: spot.rotation } : boxAtCentre(c, 0.9, 0.25, z);
    b.addEquipment({
      storey: room.storey,
      type: 'indoor-unit',
      roomId: room.id,
      unitId: info.unit.id,
      position: box.position,
      width: 0.9,
      depth: 0.25,
      height: 0.3,
      rotation: box.rotation,
      capacityKw: perRoomKw,
      name: `Wall cassette — ${room.name}`,
      ifc: { predefinedType: 'SPLITSYSTEM', objectType: 'Wall-mounted indoor cassette' },
      patterns,
      serves: room.id,
      tags: ['indoor-cassette'],
    });
    cassettes.push({ xy: [box.position[0] + 0.45, box.position[1] + 0.125], storey: room.storey });
  }
  const spot = placeOutdoorUnit(b, info, 'heat-pump-outdoor', { w: 0.9, d: 0.35, h: 0.8 }, info.load.coolingW / 1000, ['MEC-04']);
  // detail 'low'/'medium': one shared line per dwelling; 'high': one per cassette
  const lines = b.detail === 'high' ? cassettes : cassettes.slice(0, 1);
  for (const c of lines) refrigerantLine(b, info, c.xy, spot, ['MEC-04']);
  b.apply('MEC-01', {
    storey: info.storey.id,
    unitId: info.unit.id,
    params: { system: 'ductless-mini-split', cassettes: cassettes.length, refrigerantLines: lines.length, coolingKw: r1(info.load.coolingW / 1000) },
  });
  recordOutdoor(b, info, spot);
}

export function ptacSystem(b: MechBuild, info: UnitInfo): void {
  const patterns = ['MEC-01', 'MEC-08'];
  const rooms = info.habitable.filter(r => b.windowsOf(r.id).length > 0 || b.exteriorWallOf(r) !== null);
  const perRoomKw = rooms.length > 0 ? info.load.coolingW / 1000 / rooms.length : 0;
  let placed = 0;
  for (const room of rooms) {
    const box = underWindow(b, room, 1.07, 0.6, 'ptac');
    if (!box) continue;
    b.addEquipment({
      storey: room.storey,
      type: 'ptac',
      roomId: room.id,
      unitId: info.unit.id,
      position: box.position,
      width: 1.07,
      depth: 0.6,
      height: 0.4,
      rotation: box.rotation,
      capacityKw: perRoomKw,
      name: `PTAC — ${room.name}`,
      patterns,
      serves: room.id,
      tags: ['ptac'],
    });
    placed++;
  }
  b.apply('MEC-08', {
    storey: info.storey.id,
    unitId: info.unit.id,
    elementIds: [],
    params: { units: placed, size: '1.07 × 0.60 × 0.40 m', underWindow: true },
  });
}

export function vrfSystem(b: MechBuild, info: UnitInfo): void {
  const patterns = ['MEC-01', 'MEC-02'];
  const capacityKw = info.load.coolingW / 1000;
  const indoor = placeIndoorUnit(b, info, 'indoor-unit', { w: 0.9, d: 0.5, h: 0.3 }, patterns, capacityKw, true);
  if (!indoor) { b.warn(`${info.unit.id} has no room to host a VRF indoor unit`); return; }
  const res = supplyDistribution(b, {
    info,
    sourceXY: indoor.plenum,
    sourceStorey: indoor.eq.storey,
    totalLs: info.load.supplyLs,
    trunkDepth: Math.min(0.2, info.storey.unitDuctDepth),
    patterns,
    returnGrille: true,
    label: 'Supply',
  });
  // Refrigerant rises in the shaft to the roof condensers (created in building.ts)
  const shaft = nearestShaft(b.shafts, indoor.plenum, info.storey.id) ?? nearestShaft(b.shafts, indoor.plenum);
  if (shaft) {
    const riser = b.ensureRiser(`${shaft.id}:refrigerant`, () => ({
      shaftId: shaft.id,
      systemType: 'refrigerant',
      fromStorey: b.lowestResidentialStoreyId(),
      toStorey: b.roofStoreyId(),
      xy: b.claimShaftXY(shaft, false),
      width: 0.12,
      height: 0.12,
      shape: 'round',
      patterns: ['MEC-04', 'XD-04'],
      serves: shaft.servesUnitIds.join(' ') || shaft.id,
    }));
    const xy = riser.xy;
    b.addDuct({
      storey: info.storey.id,
      systemType: 'outdoor-air',
      systemOverride: 'refrigerant',
      path: joinPath([[indoor.plenum[0], indoor.plenum[1], info.storey.unitDuctZ]], routeOrthogonal(indoor.plenum, xy, info.storey.unitDuctZ)),
      shape: 'round',
      width: 0.035,
      height: 0.035,
      unitId: info.unit.id,
      name: `Refrigerant branch — ${info.unit.id}`,
      patterns: ['MEC-04'],
      pipe: true,
      tags: ['refrigerant'],
    });
  } else {
    b.warn(`${info.unit.id}: no shaft for the VRF refrigerant riser`);
  }
  recordSupply(b, info, res, 'hall ceiling');
}

export function mvhrRadiators(b: MechBuild, info: UnitInfo): void {
  const patterns = ['MEC-01', 'MEC-09'];
  const host = plantCloset(b, info) ?? info.hall;
  if (host) {
    const c = roomCentre(host);
    const wall = b.interiorWallOf(host) ?? b.exteriorWallOf(host, info.unit);
    const box = wallMountedBox(host, wall, 0.6, 0.6, 1.2);
    b.addEquipment({
      storey: host.storey,
      type: 'mvhr',
      roomId: host.id,
      unitId: info.unit.id,
      position: box.position,
      width: 0.6,
      depth: 0.6,
      height: 0.9,
      rotation: box.rotation,
      name: `MVHR — ${info.unit.id}`,
      patterns,
      serves: info.unit.id,
      airflowLs: info.load.ventilationLs,
      tags: ['heat-recovery'],
    });
    supplyDistribution(b, {
      info,
      sourceXY: c,
      sourceStorey: host.storey,
      totalLs: info.load.ventilationLs,
      trunkDepth: Math.min(0.15, info.storey.unitDuctDepth),
      patterns,
      returnGrille: false,
      label: 'MVHR supply',
    });
    // Heat interface unit (beside the MVHR, kept inside the host room) + hydronic riser
    const hiuBox = boxAtCentre(c, 0.5, 0.3, 1.0);
    const hiuMin = clampFootprint(host.rect, [hiuBox.position[0] + 0.35, hiuBox.position[1]], 0.5, 0.3);
    b.addEquipment({
      storey: host.storey,
      type: 'heat-interface-unit',
      roomId: host.id,
      unitId: info.unit.id,
      position: [hiuMin[0], hiuMin[1], 1.0],
      width: 0.5,
      depth: 0.3,
      height: 0.7,
      capacityKw: info.load.heatingW / 1000,
      name: `HIU — ${info.unit.id}`,
      patterns: ['MEC-01'],
      serves: info.unit.id,
      tags: ['hiu'],
    });
    connectHydronic(b, info, c, ['MEC-01', 'XD-04']);
  } else {
    b.warn(`${info.unit.id} has no room to host an MVHR unit`);
  }
  // Radiators under the windows (MEC-08)
  let rads = 0;
  for (const room of info.habitable) {
    const box = underWindow(b, room, 1.0, 0.1, 'radiator');
    if (!box) continue;
    b.addEquipment({
      storey: room.storey,
      type: 'radiator',
      roomId: room.id,
      unitId: info.unit.id,
      position: box.position,
      width: 1.0,
      depth: 0.1,
      height: 0.6,
      rotation: box.rotation,
      capacityKw: (info.load.heatingW / 1000) / Math.max(1, info.habitable.length),
      name: `Radiator — ${room.name}`,
      patterns: ['MEC-08'],
      serves: room.id,
      tags: ['radiator'],
    });
    rads++;
  }
  b.apply('MEC-08', { storey: info.storey.id, unitId: info.unit.id, params: { radiators: rads, mountingZ: 0.15, heatingKw: r1(info.load.heatingW / 1000) } });
}

export function centralFanCoil(b: MechBuild, info: UnitInfo): void {
  const patterns = ['MEC-01', 'MEC-02'];
  const indoor = placeIndoorUnit(b, info, 'fan-coil', { w: 1.0, d: 0.6, h: 0.3 }, patterns, info.load.coolingW / 1000, true);
  if (!indoor) { b.warn(`${info.unit.id} has no room to host a fan coil`); return; }
  const res = supplyDistribution(b, {
    info,
    sourceXY: indoor.plenum,
    sourceStorey: indoor.eq.storey,
    totalLs: info.load.supplyLs,
    trunkDepth: Math.min(0.2, info.storey.unitDuctDepth),
    patterns,
    returnGrille: true,
    label: 'Supply',
  });
  connectHydronic(b, info, indoor.plenum, ['MEC-01', 'XD-04']);
  recordSupply(b, info, res, 'hall ceiling');
}

/** Chilled/hot water riser in the nearest shaft + a branch to the dwelling's terminal unit */
function connectHydronic(b: MechBuild, info: UnitInfo, fromXY: Vec2, patterns: string[]): void {
  const st = info.storey;
  const shaft = nearestShaft(b.shafts, fromXY, st.id) ?? nearestShaft(b.shafts, fromXY);
  if (!shaft) return;
  const riser = b.ensureRiser(`${shaft.id}:hydronic`, () => ({
    shaftId: shaft.id,
    systemType: 'hydronic',
    fromStorey: b.lowestResidentialStoreyId(),
    toStorey: b.roofStoreyId(),
    xy: b.claimShaftXY(shaft, false),
    width: 0.15,
    height: 0.15,
    shape: 'round',
    label: 'HYDRONIC',
    patterns,
    serves: shaft.servesUnitIds.join(' ') || shaft.id,
  }));
  const xy = riser.xy;
  b.addDuct({
    storey: st.id,
    systemType: 'outdoor-air',
    systemOverride: 'hydronic',
    path: joinPath([[fromXY[0], fromXY[1], st.bands.pipeZ]], routeOrthogonal(fromXY, xy, st.bands.pipeZ)),
    shape: 'round',
    width: 0.04,
    height: 0.04,
    unitId: info.unit.id,
    name: `Hydronic branch — ${info.unit.id}`,
    patterns,
    pipe: true,
    tags: ['hydronic'],
  });
}

function recordSupply(b: MechBuild, info: UnitInfo, res: SupplyResult, where: string): void {
  if (res.maxRunM > 12.5) {
    b.warn(`${info.unit.id}: longest supply run ${r1(res.maxRunM)} m exceeds the 12 m target of MEC-02`);
  }
  b.apply('MEC-02', {
    storey: info.storey.id,
    unitId: info.unit.id,
    params: {
      airHandler: where,
      diffusers: res.diffusers,
      trunkM: r1(res.trunkM),
      longestRunM: r1(res.maxRunM),
      supplyLs: info.load.supplyLs,
      withinTarget: res.maxRunM <= 12.5,
    },
  });
}

function recordOutdoor(b: MechBuild, info: UnitInfo, spot: OutdoorSpot): void {
  b.apply('MEC-04', {
    storey: spot.storey,
    unitId: info.unit.id,
    elementIds: [spot.eq.id],
    params: { placement: spot.where, size: '0.90 × 0.35 × 0.80 m', capacityKw: r1(info.load.coolingW / 1000) },
  });
}

/** Dispatch on the resolved HvacSystemId */
export function generateUnitSystem(b: MechBuild, info: UnitInfo): void {
  switch (b.hvac) {
    case 'ducted-heat-pump': ductedHeatPump(b, info); break;
    case 'ductless-mini-split': ductlessMiniSplit(b, info); break;
    case 'ptac': ptacSystem(b, info); break;
    case 'vrf': vrfSystem(b, info); break;
    case 'mvhr-radiators': mvhrRadiators(b, info); break;
    case 'central-ahu-fan-coil': centralFanCoil(b, info); break;
    default: ductedHeatPump(b, info); break;
  }
  addThermostat(b, info);
}

export { firstOfType };
