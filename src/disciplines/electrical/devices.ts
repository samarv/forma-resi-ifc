/**
 * Room-level device generation inside dwellings:
 *   ELE-03 No Point Farther Than Six Feet   general receptacles along every wall space
 *   ELE-04 Kitchen Counter Circuits         counter GFCIs + dedicated appliance outlets
 *   ELE-05 Switch at the Latch Side         one switch per lighting group
 *   ELE-06 Alarms Where People Sleep        smoke / CO / heat detection
 *   ELE-13 Light by Task not Watts          fixture counts from lux targets
 */
import type {
  Circuit, DoorDef, ElecDevice, ElecDeviceType, FurnitureDef, FurnitureType, RoomDef, RoomType, Vec2,
} from '../../core/types.ts';
import { MOUNTING } from '../../core/coordination.ts';
import { dist, segPointAt, projectOnSegment } from '../../core/geometry.ts';
import { latchSide } from '../../core/openings.ts';
import { APPLIANCE_VA, DEVICE_SPEC, LUX_TARGET } from './catalog.ts';
import { fixturesForLux } from './load.ts';
import { roomGroupOf } from './region.ts';
import {
  addDevice, ceilingOf, doorsOfRoom, doorsOnFace, facesOf, windowsOnFace,
  type ElecCtx, type UnitContext,
} from './internal.ts';
import {
  alongLongAxis, anchorOnFace, backEdge, blockedSpans, ceilingGrid, centroidOf, freeSpans,
  furnitureCenter, nearestFace, runPositions, spacedPositions, type RoomFace, type Span,
} from './placement.ts';

type ReceptacleRule = 'full' | 'one' | 'none';

const RECEPTACLE_RULE: Partial<Record<RoomType, ReceptacleRule>> = {
  living: 'full', dining: 'full', 'living-kitchen': 'full', kitchen: 'full', 'shared-kitchen': 'full',
  bedroom: 'full', 'master-bedroom': 'full', study: 'full', den: 'full', flex: 'full',
  lounge: 'full', 'shared-living': 'full', 'dining-hall': 'full', amenity: 'full', gym: 'full',
  basement: 'full',
  hall: 'one', entry: 'one', laundry: 'one', utility: 'one', garage: 'one', balcony: 'one',
  terrace: 'one', porch: 'one', storage: 'one', 'mech-room': 'one', 'elec-room': 'one',
  'water-room': 'one', lobby: 'one', 'lift-lobby': 'one', mail: 'one', 'bike-store': 'one',
  bathroom: 'none', ensuite: 'none', powder: 'none', wc: 'none', closet: 'none',
  'walk-in-closet': 'none', stair: 'none', corridor: 'none', shaft: 'none', elevator: 'none',
};

const HABITABLE: Partial<Record<RoomType, boolean>> = {
  living: true, dining: true, 'living-kitchen': true, kitchen: true, bedroom: true,
  'master-bedroom': true, study: true, den: true, flex: true, lounge: true, 'shared-living': true,
  'shared-kitchen': true,
};

export function isHabitable(t: RoomType): boolean {
  return HABITABLE[t] === true;
}

const BATHROOMS: Partial<Record<RoomType, boolean>> = { bathroom: true, ensuite: true, powder: true, wc: true };
export function isBathroom(t: RoomType): boolean {
  return BATHROOMS[t] === true;
}

const KITCHENS: Partial<Record<RoomType, boolean>> = { kitchen: true, 'living-kitchen': true, 'shared-kitchen': true };
export function isKitchen(t: RoomType): boolean {
  return KITCHENS[t] === true;
}

const LIVING_LIKE: Partial<Record<RoomType, boolean>> = {
  living: true, dining: true, 'living-kitchen': true, lounge: true, 'shared-living': true,
  study: true, den: true, flex: true,
};

export interface PlacedReceptacle {
  device: ElecDevice;
  face: RoomFace;
  along: number;
}

/** All devices for one dwelling */
export function generateUnitDevices(ec: ElecCtx, uc: UnitContext): void {
  for (const room of uc.rooms) roomDevices(ec, room, uc);
  unitLifeSafety(ec, uc);
  unitComms(ec, uc);
}

/** All devices for a common (non-dwelling) room */
export function generateCommonRoomDevices(ec: ElecCtx, room: RoomDef): void {
  roomDevices(ec, room, null);
}

function roomDevices(ec: ElecCtx, room: RoomDef, uc: UnitContext | null): void {
  if (room.type === 'shaft' || room.type === 'elevator' || room.type === 'corridor') return;
  const faces = facesOf(ec, room);
  if (faces.length === 0) return;
  const placed = generalReceptacles(ec, room, faces, uc);
  if (isKitchen(room.type)) kitchenDevices(ec, room, faces, uc);
  applianceReceptacles(ec, room, faces, uc);
  if (isBathroom(room.type)) bathroomDevices(ec, room, faces, uc);
  const group = roomLighting(ec, room, faces, uc);
  roomSwitches(ec, room, faces, uc, group);
  roomDataOutlets(ec, room, placed, uc);
  roomDetectors(ec, room, uc);
}

// ----------------------------------------------------------------------------
// ELE-03 general receptacles
// ----------------------------------------------------------------------------

function receptacleCandidates(ec: ElecCtx, room: RoomDef, faces: RoomFace[], spacing: number): { face: RoomFace; along: number }[] {
  const out: { face: RoomFace; along: number }[] = [];
  const ordered = [...faces].sort((a, b) => b.length - a.length);
  for (const face of ordered) {
    if (face.length < 0.6) continue;
    const blocked: Span[] = blockedSpans(face, doorsOnFace(ec, face), windowsOnFace(ec, face), ec.wallById);
    for (const span of freeSpans(face.length, blocked, 0.6)) {
      const L = span.b - span.a;
      for (const t of spacedPositions(L, spacing)) out.push({ face, along: span.a + t });
    }
  }
  return out;
}

function strideSelect<T>(list: T[], n: number): T[] {
  if (n >= list.length) return list;
  if (n <= 0) return [];
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(list[Math.min(list.length - 1, Math.floor(((i + 0.5) * list.length) / n))]);
  return out;
}

function generalReceptacles(ec: ElecCtx, room: RoomDef, faces: RoomFace[], uc: UnitContext | null): PlacedReceptacle[] {
  const rule: ReceptacleRule = RECEPTACLE_RULE[room.type] ?? 'none';
  if (rule === 'none') return [];
  // NEC 210.52(H): a hallway needs an outlet only when it is 3 m or longer
  if (rule === 'one' && (room.type === 'hall' || room.type === 'entry')) {
    if (Math.max(room.rect.w, room.rect.h) < 3.0 && !ec.region.caps) return [];
  }
  const base = receptacleCandidates(ec, room, faces, ec.region.maxReceptacleSpacing);
  if (base.length === 0) return [];
  let target = base.length;
  const caps = ec.region.caps;
  if (caps) {
    const c = caps[roomGroupOf(room.type)];
    target = Math.max(c.min, Math.min(c.max, target));
  }
  if (rule === 'one') target = Math.min(target, ec.region.caps ? 2 : 1);
  if (ec.detail === 'low') target = 1;
  else if (ec.detail === 'medium') target = Math.min(target, 6);
  const list = target <= base.length ? base : receptacleCandidates(ec, room, faces, 1.5);
  const chosen = strideSelect(list, target);
  const out: PlacedReceptacle[] = [];
  const outdoor = room.type === 'balcony' || room.type === 'terrace' || room.type === 'porch';
  const damp = outdoor || room.type === 'garage' || room.type === 'laundry' || room.type === 'utility'
    || room.type === 'mech-room' || room.type === 'water-room' || room.type === 'basement';
  for (const c of chosen) {
    const device = addDevice(ec, room.storey, damp ? 'gfci-receptacle' : 'receptacle',
      anchorOnFace(c.face, c.along, MOUNTING.receptacle), c.face.rotation, {
        roomId: room.id,
        unitId: uc?.unit.id ?? room.unitId,
        wallId: c.face.wallId || undefined,
        want: room.type === 'laundry' ? 'laundry' : 'general-receptacle',
        note: `${ec.region.receptacleCode}; wall space ≤ ${ec.region.maxReceptacleSpacing} m spacing`,
      });
    out.push({ device, face: c.face, along: c.along });
  }
  return out;
}

// ----------------------------------------------------------------------------
// ELE-04 kitchen
// ----------------------------------------------------------------------------

const COUNTER_TYPES: Partial<Record<FurnitureType, boolean>> = { 'kitchen-counter': true, 'kitchen-island': true };

function kitchenDevices(ec: ElecCtx, room: RoomDef, faces: RoomFace[], uc: UnitContext | null): void {
  const centroid = centroidOf(room);
  const counters = (ec.furnByRoom.get(room.id) ?? []).filter(f => COUNTER_TYPES[f.type]);
  let index = 0;
  let placedCount = 0;
  const unitId = uc?.unit.id ?? room.unitId;
  for (const f of counters) {
    const edge = backEdge(f, centroid);
    const L = dist(edge.a, edge.b);
    if (L < 0.4) continue;
    for (const t of runPositions(L, ec.region.counterSpacing, 1)) {
      const p = segPointAt(edge, t);
      const hit = nearestFace(faces, p, 0.4);
      const wantA: Circuit['type'] = 'kitchen-small-appliance';
      if (hit && dist(segPointAt(hit.face.seg, hit.along), p) < 1.0) {
        addDevice(ec, room.storey, 'gfci-receptacle', anchorOnFace(hit.face, hit.along, MOUNTING.counterReceptacle), hit.face.rotation, {
          roomId: room.id, unitId, wallId: hit.face.wallId || undefined, want: wantA,
          name: `Counter ${ec.region.earthLeakName} receptacle`,
          note: `NEC 210.52(C) / 210.11(C)(1) — circuit ${index % ec.region.smallApplianceCircuits + 1} of ${ec.region.smallApplianceCircuits}`,
        });
      } else {
        const dir = Math.atan2(edge.b[1] - edge.a[1], edge.b[0] - edge.a[0]);
        addDevice(ec, room.storey, 'gfci-receptacle', [p[0], p[1], MOUNTING.counterReceptacle], dir, {
          roomId: room.id, unitId, want: wantA, name: 'Island receptacle', note: 'NEC 210.52(C)(2) island/peninsula outlet',
        });
      }
      index++;
      placedCount++;
      if (ec.detail === 'low' && placedCount >= 2) break;
    }
    if (ec.detail === 'low' && placedCount >= 2) break;
  }
  if (placedCount === 0) {
    // No counter furniture: fall back to the longest free wall space at counter height
    const cand = receptacleCandidates(ec, room, faces, ec.region.counterSpacing * 2);
    for (const c of strideSelect(cand, Math.max(2, Math.min(4, cand.length)))) {
      addDevice(ec, room.storey, 'gfci-receptacle', anchorOnFace(c.face, c.along, MOUNTING.counterReceptacle), c.face.rotation, {
        roomId: room.id, unitId, wallId: c.face.wallId || undefined, want: 'kitchen-small-appliance',
        name: `Counter ${ec.region.earthLeakName} receptacle`, note: 'NEC 210.52(C) (counter position inferred)',
      });
      placedCount++;
    }
  }
  // Dedicated microwave outlet above the counter
  const micro = counters.length > 0
    ? nearestFace(faces, furnitureCenter(counters[0]), 0.4)
    : nearestFace(faces, centroid, 0.6);
  if (micro) {
    addDevice(ec, room.storey, 'receptacle', anchorOnFace(micro.face, Math.min(micro.face.length - 0.2, micro.along + 0.6), 1.8), micro.face.rotation, {
      roomId: room.id, unitId, wallId: micro.face.wallId || undefined, want: 'kitchen-small-appliance',
      va: APPLIANCE_VA.microwave, name: 'Microwave receptacle', note: 'Dedicated over-range microwave outlet',
    });
  }
  // Under-cabinet task lighting along the counter run
  if (ec.detail !== 'low') {
    for (const f of counters) {
      if (f.type === 'kitchen-island') continue;
      const edge = backEdge(f, centroid);
      const L = dist(edge.a, edge.b);
      for (const t of runPositions(L, 1.2, 1)) {
        const p = segPointAt(edge, t);
        const hit = nearestFace(faces, p, 0.4);
        if (!hit) continue;
        addDevice(ec, room.storey, 'light-under-cabinet', anchorOnFace(hit.face, hit.along, DEVICE_SPEC['light-under-cabinet'].z ?? 1.45), hit.face.rotation, {
          roomId: room.id, unitId, wallId: hit.face.wallId || undefined, want: 'lighting',
          group: `${room.id}:under-cabinet`,
        });
      }
    }
  }
}

interface ApplianceRule {
  device: ElecDeviceType;
  want: Circuit['type'];
  va: number;
  z: number;
  name: string;
}

function applianceRule(ec: ElecCtx, type: FurnitureType): ApplianceRule | null {
  const heavy = !ec.region.ring;
  switch (type) {
    case 'fridge':
      return { device: 'receptacle', want: 'refrigerator', va: APPLIANCE_VA.fridge, z: MOUNTING.receptacle, name: 'Refrigerator receptacle' };
    case 'dishwasher':
      return { device: 'receptacle', want: 'dishwasher', va: APPLIANCE_VA.dishwasher, z: MOUNTING.receptacle, name: 'Dishwasher receptacle' };
    case 'range':
      return { device: heavy ? 'range-receptacle' : 'receptacle', want: 'range', va: APPLIANCE_VA.range, z: 0.3, name: heavy ? 'Range receptacle (50 A/240 V)' : 'Cooker connection unit (32 A)' };
    case 'washer':
      return { device: 'gfci-receptacle', want: 'laundry', va: APPLIANCE_VA.washer, z: 0.9, name: 'Washer receptacle' };
    case 'dryer':
      return { device: heavy ? 'dryer-receptacle' : 'receptacle', want: 'dryer', va: APPLIANCE_VA.dryer, z: 0.3, name: heavy ? 'Dryer receptacle (30 A/240 V)' : 'Dryer receptacle' };
    case 'water-heater':
      return { device: 'disconnect', want: 'water-heater', va: APPLIANCE_VA.waterHeater, z: MOUNTING.thermostat, name: 'Water heater disconnect' };
    case 'kitchen-sink':
      return heavy ? { device: 'receptacle', want: 'disposal', va: APPLIANCE_VA.disposal, z: MOUNTING.receptacle, name: 'Disposal receptacle' } : null;
    default:
      return null;
  }
}

function applianceReceptacles(ec: ElecCtx, room: RoomDef, faces: RoomFace[], uc: UnitContext | null): void {
  const items = ec.furnByRoom.get(room.id) ?? [];
  for (const f of items) {
    const rule = applianceRule(ec, f.type);
    if (!rule) continue;
    if (f.type !== 'kitchen-sink' && f.type !== 'water-heater' && f.needsPower === false) continue;
    const c = furnitureCenter(f);
    const hit = nearestFace(faces, c, 0.3);
    const unitId = uc?.unit.id ?? room.unitId;
    if (hit && dist(segPointAt(hit.face.seg, hit.along), c) < 1.5) {
      addDevice(ec, room.storey, rule.device, anchorOnFace(hit.face, hit.along, rule.z), hit.face.rotation, {
        roomId: room.id, unitId, wallId: hit.face.wallId || undefined, want: rule.want, va: rule.va,
        name: rule.name, note: `Dedicated circuit for ${f.type}`,
      });
    } else {
      addDevice(ec, room.storey, rule.device, [c[0], c[1], rule.z], f.rotation ?? 0, {
        roomId: room.id, unitId, want: rule.want, va: rule.va, name: rule.name,
        note: `Dedicated circuit for ${f.type} (free-standing connection)`,
      });
    }
  }
}

// ----------------------------------------------------------------------------
// Bathrooms
// ----------------------------------------------------------------------------

const VANITY_TYPES: Partial<Record<FurnitureType, boolean>> = { vanity: true, lavatory: true };

function bathroomDevices(ec: ElecCtx, room: RoomDef, faces: RoomFace[], uc: UnitContext | null): void {
  const unitId = uc?.unit.id ?? room.unitId;
  const vanity = (ec.furnByRoom.get(room.id) ?? []).find(f => VANITY_TYPES[f.type]);
  let hit = vanity ? nearestFace(faces, furnitureCenter(vanity), 0.4) : null;
  if (!hit) {
    const cand = receptacleCandidates(ec, room, faces, 3.6);
    hit = cand.length > 0 ? { face: cand[0].face, along: cand[0].along } : nearestFace(faces, centroidOf(room), 0.4);
  }
  if (!hit) return;
  addDevice(ec, room.storey, 'gfci-receptacle', anchorOnFace(hit.face, hit.along, MOUNTING.counterReceptacle), hit.face.rotation, {
    roomId: room.id, unitId, wallId: hit.face.wallId || undefined, want: 'bathroom',
    name: `Lavatory ${ec.region.earthLeakName} receptacle`,
    note: 'NEC 210.52(D) within 900 mm of the basin / BS 7671 701 zones',
  });
  addDevice(ec, room.storey, 'light-vanity', anchorOnFace(hit.face, hit.along, MOUNTING.wallLight), hit.face.rotation, {
    roomId: room.id, unitId, wallId: hit.face.wallId || undefined, want: 'lighting',
    group: `${room.id}:lighting`, note: 'Vanity luminaire over the basin',
  });
}

// ----------------------------------------------------------------------------
// Lighting
// ----------------------------------------------------------------------------

function luxFor(room: RoomDef): number {
  return LUX_TARGET[room.type] ?? 100;
}

function gridCount(room: RoomDef, perM2: number, min: number, max: number, lumens: number): number {
  const byArea = Math.ceil(room.area / perM2);
  const byLux = fixturesForLux(room.area, luxFor(room), lumens);
  return Math.max(min, Math.min(max, Math.max(byArea, byLux)));
}

/** Places the lighting for one room; returns the lighting group key */
function roomLighting(ec: ElecCtx, room: RoomDef, faces: RoomFace[], uc: UnitContext | null): string {
  const group = `${room.id}:lighting`;
  const unitId = uc?.unit.id ?? room.unitId;
  const z = ceilingOf(ec, room);
  const add = (type: ElecDeviceType, p: Vec2, extra?: { z?: number }): void => {
    addDevice(ec, room.storey, type, [p[0], p[1], extra?.z ?? z], 0, {
      roomId: room.id, unitId, want: 'lighting', group,
      note: `ELE-13 target ${luxFor(room)} lx`,
    });
  };
  const centroid = centroidOf(room);
  switch (room.type) {
    case 'bedroom':
    case 'master-bedroom':
      add('light-ceiling', centroid);
      break;
    case 'living':
    case 'dining':
    case 'living-kitchen':
    case 'lounge':
    case 'shared-living':
    case 'study':
    case 'den':
    case 'flex':
    case 'kitchen':
    case 'shared-kitchen':
    case 'dining-hall':
    case 'amenity':
    case 'gym': {
      const lumens = DEVICE_SPEC['light-recessed'].lumens ?? 900;
      const n = ec.detail === 'low' ? 1 : gridCount(room, 6, 2, 8, lumens);
      const g = ceilingGrid(room.rect, n, 0.7);
      for (const p of g.points) add('light-recessed', p);
      break;
    }
    case 'hall':
    case 'entry':
      for (const p of alongLongAxis(room.rect, 3.0, 1)) add('light-ceiling', p);
      break;
    case 'bathroom':
    case 'ensuite':
    case 'powder':
    case 'wc':
      add('light-ceiling', centroid);
      break;
    case 'closet':
    case 'walk-in-closet':
      if (room.area >= 2.0) add('light-ceiling', centroid);
      break;
    case 'balcony':
    case 'terrace':
    case 'porch': {
      const door = doorsOfRoom(ec, room).find(d => d.type === 'balcony') ?? doorsOfRoom(ec, room)[0];
      const hit = door
        ? nearestFace(faces, doorPoint(ec, door) ?? centroid, 0.3)
        : nearestFace(faces, centroid, 0.3);
      if (hit) {
        const along = Math.max(0.2, Math.min(hit.face.length - 0.2, hit.along + 0.7));
        addDevice(ec, room.storey, 'light-wall', anchorOnFace(hit.face, along, MOUNTING.wallLight), hit.face.rotation, {
          roomId: room.id, unitId, wallId: hit.face.wallId || undefined, want: 'lighting', group,
          note: 'Luminaire beside the balcony door',
        });
      }
      break;
    }
    case 'stair': {
      const flights = stairFlights(ec, room);
      const longest = [...faces].sort((a, b) => b.length - a.length)[0];
      if (longest) {
        for (const t of runPositions(longest.length, longest.length / Math.max(1, flights), flights)) {
          addDevice(ec, room.storey, 'light-wall', anchorOnFace(longest, t, 2.2), longest.rotation, {
            roomId: room.id, unitId, wallId: longest.wallId || undefined, want: 'house-lighting', group,
            note: `One luminaire per flight (${flights} flights)`,
          });
        }
      }
      break;
    }
    case 'lobby': {
      const n = Math.max(2, Math.min(6, Math.ceil(room.area / 9)));
      for (const p of ceilingGrid(room.rect, n, 0.8).points) add('light-pendant', p);
      break;
    }
    case 'parking': {
      for (const p of ceilingGrid(room.rect, Math.max(1, Math.ceil(room.area / 81)), 1.5).points) add('light-ceiling', p);
      break;
    }
    default: {
      const n = Math.max(1, Math.min(6, Math.ceil(room.area / 12)));
      for (const p of ceilingGrid(room.rect, n, 0.7).points) add('light-ceiling', p);
      break;
    }
  }
  return group;
}

function stairFlights(ec: ElecCtx, room: RoomDef): number {
  let flights = 0;
  for (const s of ec.arch.stairs) {
    if (s.storey !== room.storey) continue;
    const p = s.position;
    if (p[0] >= room.rect.x - 0.5 && p[0] <= room.rect.x + room.rect.w + 0.5
      && p[1] >= room.rect.y - 0.5 && p[1] <= room.rect.y + room.rect.h + 0.5) {
      flights += s.flights ?? 2;
    }
  }
  return flights > 0 ? flights : 2;
}

function doorPoint(ec: ElecCtx, doorId: { wallId: string; along: number }): Vec2 | null {
  const wall = ec.wallById.get(doorId.wallId);
  if (!wall) return null;
  return segPointAt({ a: wall.start, b: wall.end }, doorId.along);
}

// ----------------------------------------------------------------------------
// ELE-05 switches
// ----------------------------------------------------------------------------

const NO_LOCAL_SWITCH: Partial<Record<RoomType, boolean>> = {
  corridor: true, lobby: true, 'lift-lobby': true, shaft: true, elevator: true, parking: true,
};

function roomSwitches(ec: ElecCtx, room: RoomDef, faces: RoomFace[], uc: UnitContext | null, group: string): void {
  const fixtures = ec.lightGroups.get(group);
  if (!fixtures || fixtures.length === 0) return;
  if (NO_LOCAL_SWITCH[room.type]) return;
  const unitId = uc?.unit.id ?? room.unitId;
  const doors = doorsOfRoom(ec, room);
  if (doors.length === 0) return;
  const dimmer = LIVING_LIKE[room.type] === true && (room.type === 'living' || room.type === 'living-kitchen' || room.type === 'lounge' || room.type === 'dining');
  const threeWay = (room.type === 'hall' || room.type === 'stair') && doors.length >= 2;
  const picks = threeWay ? doors.slice(0, 2) : [entryDoorOf(ec, room, doors)];
  let n = 0;
  for (const door of picks) {
    if (!door) continue;
    const spot = switchSpot(ec, room, faces, door);
    if (!spot) continue;
    addDevice(ec, room.storey, dimmer && n === 0 ? 'dimmer' : 'switch', anchorOnFace(spot.face, spot.along, MOUNTING.switch), spot.face.rotation, {
      roomId: room.id, unitId, wallId: spot.face.wallId || undefined, want: 'lighting',
      name: threeWay ? '3-way switch' : dimmer && n === 0 ? 'Dimmer' : 'Light switch',
      note: `ELE-05 latch side of ${door.id}, 0.15 m from the opening`,
    });
    n++;
  }
}

/** The door a person enters the room through: the unit entry, else a door from circulation */
function entryDoorOf(ec: ElecCtx, room: RoomDef, doors: DoorDef[]): DoorDef | null {
  const fromCirculation = doors.find(d => {
    const other = d.fromRoomId === room.id ? d.toRoomId : d.fromRoomId;
    if (!other) return false;
    const r = ec.roomById.get(other);
    return !!r && (r.type === 'hall' || r.type === 'entry' || r.type === 'corridor' || r.type === 'stair' || r.type === 'lobby');
  });
  return doors.find(d => d.type === 'unit-entry') ?? fromCirculation ?? doors[0] ?? null;
}

/** ELE-05: the switch goes on the LATCH side of the door, 0.15 m clear of the opening (core/openings.ts) */
function switchSpot(ec: ElecCtx, room: RoomDef, faces: RoomFace[], door: DoorDef): { face: RoomFace; along: number } | null {
  const wall = ec.wallById.get(door.wallId);
  const p = wall ? segPointAt({ a: wall.start, b: wall.end }, door.along) : null;
  const latch = wall ? latchSide(door, wall) : null;
  const onWall = p ? faces.filter(f => f.wallId === door.wallId) : [];
  const candidates = onWall.length > 0 ? onWall : faces;
  let best: { face: RoomFace; along: number; d: number } | null = null;
  for (const face of candidates) {
    const at = p ? projectOnSegment(face.seg, p).along : face.length / 2;
    // which way along the face the latch lies is geometry, not a token: latchSide() already carries the hinge
    const sign = latch && projectOnSegment(face.seg, latch).along < at ? -1 : 1;
    const off = door.width / 2 + 0.15;
    const options = [at + sign * off, at - sign * off];
    for (const o of options) {
      if (o < 0.12 || o > face.length - 0.12) continue;
      const d = Math.abs(o - at);
      if (!best || d < best.d) best = { face, along: o, d };
    }
    if (best) break;
  }
  if (best) return { face: best.face, along: best.along };
  const longest = [...faces].sort((a, b) => b.length - a.length)[0];
  return longest && longest.length > 0.4 ? { face: longest, along: longest.length / 2 } : null;
}

// ----------------------------------------------------------------------------
// Data / TV
// ----------------------------------------------------------------------------

function roomDataOutlets(ec: ElecCtx, room: RoomDef, placed: PlacedReceptacle[], uc: UnitContext | null): void {
  if (ec.detail === 'low') return;
  const wantsData = LIVING_LIKE[room.type] === true || room.type === 'bedroom' || room.type === 'master-bedroom';
  if (!wantsData || placed.length === 0) return;
  const unitId = uc?.unit.id ?? room.unitId;
  const host = placed[0];
  const along = Math.max(0.15, Math.min(host.face.length - 0.15, host.along + 0.3));
  addDevice(ec, room.storey, 'data-outlet', anchorOnFace(host.face, along, MOUNTING.receptacle), host.face.rotation, {
    roomId: room.id, unitId, wallId: host.face.wallId || undefined, name: 'Data outlet (2 × RJ45)',
  });
  const wantsTv = room.type === 'living' || room.type === 'living-kitchen' || room.type === 'lounge' || room.type === 'master-bedroom';
  if (wantsTv) {
    const a2 = Math.max(0.15, Math.min(host.face.length - 0.15, host.along - 0.3));
    addDevice(ec, room.storey, 'tv-outlet', anchorOnFace(host.face, a2, MOUNTING.receptacle), host.face.rotation, {
      roomId: room.id, unitId, wallId: host.face.wallId || undefined, name: 'TV outlet',
    });
  }
}

// ----------------------------------------------------------------------------
// ELE-06 life safety
// ----------------------------------------------------------------------------

const HEAT_DETECTOR_ROOMS: Partial<Record<RoomType, boolean>> = {
  garage: true, 'mech-room': true, plant: true, 'elec-room': true, trash: true, parking: true,
};

function roomDetectors(ec: ElecCtx, room: RoomDef, uc: UnitContext | null): void {
  const unitId = uc?.unit.id ?? room.unitId;
  const z = ceilingOf(ec, room);
  const c = centroidOf(room);
  if (HEAT_DETECTOR_ROOMS[room.type]) {
    addDevice(ec, room.storey, 'heat-detector', [c[0], c[1], z], 0, {
      roomId: room.id, unitId, want: 'life-safety', note: 'Heat detector — no smoke detection in dusty/vehicle areas',
    });
  }
}

/** Smoke and CO alarms for a dwelling: every bedroom, every hall outside bedrooms, ≥ 1 per level */
function unitLifeSafety(ec: ElecCtx, uc: UnitContext): void {
  const bedrooms = uc.rooms.filter(r => r.type === 'bedroom' || r.type === 'master-bedroom');
  const halls = uc.rooms.filter(r => r.type === 'hall' || r.type === 'entry');
  let count = 0;
  for (const r of bedrooms) {
    smoke(ec, r, uc);
    count++;
  }
  const hallsOutsideBedrooms = halls.filter(h => bedrooms.some(b => roomsAdjacent(b, h)));
  const smokeHalls = hallsOutsideBedrooms.length > 0 ? hallsOutsideBedrooms : halls;
  for (const h of smokeHalls) {
    smoke(ec, h, uc);
    count++;
  }
  if (count === 0) {
    const any = uc.rooms.find(r => r.type !== 'balcony' && r.type !== 'terrace');
    if (any) smoke(ec, any, uc);
  }
  const needCo = uc.fuelAppliance || uc.hasGarage || ec.region.coAlarmAlways;
  if (needCo) {
    const hosts = smokeHalls.length > 0 ? smokeHalls : uc.rooms.slice(0, 1);
    for (const h of hosts.slice(0, Math.max(1, smokeHalls.length))) {
      const c = centroidOf(h);
      // sit clear of the smoke alarm, along the room's long axis, inside the footprint
      const horizontal = h.rect.w >= h.rect.h;
      const step = Math.min(0.4, (horizontal ? h.rect.w : h.rect.h) / 4);
      const at: Vec2 = horizontal ? [c[0] + step, c[1]] : [c[0], c[1] + step];
      const p: Vec2 = [
        Math.min(Math.max(at[0], h.rect.x + 0.15), h.rect.x + h.rect.w - 0.15),
        Math.min(Math.max(at[1], h.rect.y + 0.15), h.rect.y + h.rect.h - 0.15),
      ];
      addDevice(ec, h.storey, 'co-alarm', [p[0], p[1], ceilingOf(ec, h)], 0, {
        roomId: h.id, unitId: uc.unit.id, want: 'life-safety',
        note: uc.fuelAppliance || uc.hasGarage
          ? 'IRC R315 / BS 5839-6 — fuel-burning appliance or attached garage'
          : 'Regional baseline: one CO alarm per dwelling',
      });
    }
  }
}

function smoke(ec: ElecCtx, room: RoomDef, uc: UnitContext): void {
  const c = centroidOf(room);
  addDevice(ec, room.storey, 'smoke-alarm', [c[0], c[1], ceilingOf(ec, room)], 0, {
    roomId: room.id, unitId: uc.unit.id, want: 'life-safety',
    note: 'NFPA 72 §29 / IRC R314 / BS 5839-6 grade D LD2 — interconnected, battery backup',
  });
}

function roomsAdjacent(a: RoomDef, b: RoomDef): boolean {
  const pad = 0.45;
  return a.rect.x <= b.rect.x + b.rect.w + pad && b.rect.x <= a.rect.x + a.rect.w + pad
    && a.rect.y <= b.rect.y + b.rect.h + pad && b.rect.y <= a.rect.y + a.rect.h + pad;
}

// ----------------------------------------------------------------------------
// Comms at the dwelling entry
// ----------------------------------------------------------------------------

function unitComms(ec: ElecCtx, uc: UnitContext): void {
  const door = uc.entryDoor;
  if (!door) return;
  const entryRoom = uc.rooms.find(r => r.id === door.toRoomId) ?? uc.rooms.find(r => r.type === 'entry' || r.type === 'hall');
  if (!entryRoom) return;
  const faces = facesOf(ec, entryRoom);
  const p = doorPoint(ec, door);
  const hit = p ? nearestFace(faces, p, 0.3) : null;
  if (!hit) return;
  const along = Math.max(0.15, Math.min(hit.face.length - 0.15, hit.along + 0.8));
  const direct = ec.ctx.typology.access === 'direct';
  addDevice(ec, entryRoom.storey, direct ? 'doorbell' : 'intercom',
    anchorOnFace(hit.face, along, direct ? 1.2 : 1.4), hit.face.rotation, {
      roomId: entryRoom.id, unitId: uc.unit.id, wallId: hit.face.wallId || undefined,
      name: direct ? 'Doorbell push' : 'Door-entry handset',
      note: direct ? 'Doorbell outside the dwelling entry' : 'Door-entry handset linked to the lobby panel',
    });
}

export { roomLighting, receptacleCandidates, strideSelect, doorPoint, entryDoorOf, switchSpot };
