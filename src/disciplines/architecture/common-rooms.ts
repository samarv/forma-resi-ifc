/**
 * Non-dwelling program: the ground-floor lobby sequence (ARC-31), retail frontage (ARC-34),
 * parking plates, amenity floors and back-of-house.
 *
 * A "program" is an ordered list of rooms with target areas; `sliceProgram` lays them out along a
 * reserved interval of a bar strip, in order, from the anchor (normally the entrance core) outward.
 */
import type { Compass, DoorMotion, FurnitureType, RoomDef, RoomType, Side, TypologyDef } from '../../core/types.ts';
import { SIZES } from '../../core/coordination.ts';
import { rectEdges, round } from '../../core/geometry.ts';
import { alongInWall, LEAF_MIN, reachRect, solveSwing } from '../../core/openings.ts';
import type { ArchBuilder } from './arch-elements.ts';
import { rampElement } from './arch-elements.ts';
import { rectFromAC, sideSpan, type BarFrame, type Interval } from './bar-frame.ts';
import { EnvelopeBuilder, glazeWall } from './envelope.ts';
import type { CommonRoomSlot, FloorCtx } from './types-internal.ts';

export interface ProgramItem {
  type: RoomType;
  name?: string;
  /** Target net area (m²) */
  area: number;
  /** Minimum length along the strip (m) */
  minLen?: number;
  glazing?: { sill: number; height: number; wwr?: number };
  accessSide?: Side;
  entrance?: CommonRoomSlot['entrance'];
  open?: boolean;
}

export interface GroundProgramInput {
  unitsInBuilding: number;
  bikeRatio: number;
  storeys: number;
  region: string;
  typology: TypologyDef;
  /** side of the strip that faces the corridor (interior) */
  accessSide: Side;
  /** side of the strip that faces the street */
  streetSide: Side;
  hasAmenityFloor: boolean;
}

/** ARC-31 Lobby Sequence: entrance → lobby → mail → lift lobby, with back-of-house behind */
export function groundProgram(i: GroundProgramInput): { street: ProgramItem[]; rear: ProgramItem[] } {
  const bikes = Math.max(4, Math.round(i.unitsInBuilding * i.bikeRatio));
  const street: ProgramItem[] = [
    {
      type: 'lobby', name: 'Residential Lobby', area: 42, minLen: 4.5,
      accessSide: i.accessSide,
      entrance: { side: i.streetSide, width: SIZES.doorBuildingEntry, type: 'building-entry' },
    },
    { type: 'mail', name: 'Mail & Parcel Room', area: 9, minLen: 2.2, accessSide: i.accessSide },
  ];
  if (!i.hasAmenityFloor) {
    street.push({ type: 'lounge', name: 'Residents Lounge', area: 38, minLen: 4.0, accessSide: i.accessSide });
  }
  const rear: ProgramItem[] = [
    { type: 'bike-store', name: 'Bicycle Store', area: Math.min(90, Math.max(12, bikes * 1.2)), minLen: 3.0, accessSide: i.accessSide, entrance: { side: i.accessSide === 'front' ? 'rear' : i.accessSide === 'rear' ? 'front' : i.accessSide === 'left' ? 'right' : 'left', width: 1.2, type: 'service' } },
    { type: 'trash', name: 'Refuse & Recycling', area: 16, minLen: 3.0, accessSide: i.accessSide },
    { type: 'mech-room', name: 'Mechanical Room', area: 20, minLen: 3.2, accessSide: i.accessSide },
    { type: 'elec-room', name: 'Electrical Switch Room', area: 12, minLen: 2.6, accessSide: i.accessSide },
    { type: 'water-room', name: 'Water Service Room', area: 9, minLen: 2.4, accessSide: i.accessSide },
  ];
  return { street, rear };
}

/** ARC-34 Retail Frontage: shallow tenancies with a full-height shopfront on the street face */
export function retailProgram(streetLen: number, depth: number, streetSide: Side, accessSide: Side): ProgramItem[] {
  const tenancyArea = 120;
  const n = Math.max(1, Math.round((streetLen * depth) / tenancyArea));
  const out: ProgramItem[] = [];
  for (let k = 0; k < n; k++) {
    out.push({
      type: 'retail',
      name: `Retail Unit ${k + 1}`,
      area: tenancyArea,
      minLen: 5.0,
      glazing: { sill: 0.3, height: 3.0, wwr: 0.75 },
      entrance: { side: streetSide, width: 1.6, type: 'building-entry' },
      accessSide,
    });
  }
  return out;
}

export function amenityProgram(plateArea: number, accessSide: Side): ProgramItem[] {
  const a = Math.max(120, plateArea * 0.8);
  return [
    { type: 'gym', name: 'Fitness Room', area: a * 0.3, minLen: 6.0, accessSide },
    { type: 'lounge', name: 'Residents Lounge', area: a * 0.34, minLen: 6.0, accessSide },
    { type: 'flex', name: 'Co-working / Flex Room', area: a * 0.24, minLen: 4.5, accessSide },
    { type: 'wc', name: 'Accessible WC', area: 6, minLen: 2.2, accessSide },
    { type: 'storage', name: 'Amenity Store', area: 8, minLen: 2.2, accessSide },
  ];
}

export function clusterAmenityProgram(accessSide: Side): ProgramItem[] {
  return [
    { type: 'dining-hall', name: 'Communal Dining Hall', area: 70, minLen: 7.0, accessSide },
    { type: 'shared-living', name: 'Shared Living', area: 55, minLen: 6.0, accessSide },
    { type: 'laundry', name: 'Shared Laundry', area: 18, minLen: 3.0, accessSide },
  ];
}

// ----------------------------------------------------------------------------
// Slicing a program into a reserved strip interval
// ----------------------------------------------------------------------------

export function programLength(items: ProgramItem[], depth: number): number {
  return items.reduce((a, it) => a + Math.max(it.minLen ?? 2.0, it.area / Math.max(1, depth)), 0);
}

/**
 * Lay `items` out along `iv` between across `c0..c1`. Items are placed in order from `from`
 * ('start' = low along). Items that do not fit are dropped and reported.
 */
export function sliceProgram(
  frame: BarFrame, iv: Interval, c0: number, c1: number, items: ProgramItem[],
  exteriorSides: Partial<Record<Side, boolean>>, from: 'start' | 'end' = 'start',
): { slots: CommonRoomSlot[]; dropped: ProgramItem[]; used: Interval | null } {
  const depth = c1 - c0;
  const avail = iv.e - iv.s;
  const keep: ProgramItem[] = [];
  const dropped: ProgramItem[] = [];
  let total = 0;
  for (const it of items) {
    const len = Math.max(it.minLen ?? 2.0, it.area / Math.max(1, depth));
    if (total + len <= avail + 0.01) { keep.push(it); total += len; } else dropped.push(it);
  }
  if (keep.length === 0) return { slots: [], dropped, used: null };
  // distribute any slack proportionally
  const lens = keep.map(it => Math.max(it.minLen ?? 2.0, it.area / Math.max(1, depth)));
  const slack = Math.min(avail - total, total * 0.6);
  if (slack > 0) {
    const sum = lens.reduce((a, c) => a + c, 0);
    for (let k = 0; k < lens.length; k++) lens[k] += (slack * lens[k]) / sum;
  }
  const consumed = lens.reduce((a, c) => a + c, 0);
  let cursor = from === 'start' ? iv.s : iv.e - consumed;
  const slots: CommonRoomSlot[] = [];
  for (let k = 0; k < keep.length; k++) {
    const it = keep[k];
    const a0 = cursor;
    const a1 = cursor + lens[k];
    cursor = a1;
    const rect = rectFromAC(frame, a0, a1, c0, c1);
    const ext: Side[] = [];
    for (const s of ['front', 'rear', 'left', 'right'] as Side[]) if (exteriorSides[s]) ext.push(s);
    if (a0 > iv.s + 0.05) removeSide(ext, frame.startSide);
    if (a1 < iv.e - 0.05) removeSide(ext, frame.endSide);
    slots.push({
      rect, type: it.type, name: it.name, exteriorSides: ext, glazing: it.glazing,
      accessSide: it.accessSide, entrance: it.entrance, open: it.open,
    });
  }
  return { slots, dropped, used: { s: from === 'start' ? iv.s : iv.e - consumed, e: from === 'start' ? iv.s + consumed : iv.e } };
}

function removeSide(list: Side[], s: Side): void {
  const i = list.indexOf(s);
  if (i >= 0) list.splice(i, 1);
}

// ----------------------------------------------------------------------------
// Construction
// ----------------------------------------------------------------------------

export function buildCommonRoom(
  b: ArchBuilder, f: FloorCtx, slot: CommonRoomSlot, env: EnvelopeBuilder, streetFacing: Compass,
): { room: RoomDef; glazedArea: number } {
  const st = f.storeyId;
  const exteriorWallIds: string[] = [];
  const wallIds: string[] = [];
  const extWalls: { side: Side; wall: import('../../core/types.ts').WallDef }[] = [];

  for (const side of slot.exteriorSides) {
    const span = sideSpan(slot.rect, side);
    for (const w of env.wallsFor(side, span.across, span.a0, span.a1)) {
      exteriorWallIds.push(w.id);
      wallIds.push(w.id);
      extWalls.push({ side, wall: w });
    }
  }

  const room = b.addRoom({
    storey: st, type: slot.type, rect: slot.rect, height: f.ceilingHeight, name: slot.name,
    exteriorWallIds, wallIds,
  });

  // enclosing walls on interior sides
  if (!slot.open) {
    const edges = rectEdges(slot.rect);
    for (const side of ['front', 'right', 'rear', 'left'] as Side[]) {
      if (slot.exteriorSides.includes(side)) continue;
      const spec = slot.sides?.[side] ?? { type: 'partition' as const, thickness: SIZES.partitionT };
      const w = b.addWall({
        storey: st, start: edges[side].a, end: edges[side].b, thickness: spec.thickness,
        height: f.wallHeight, type: spec.type, loadBearingHint: spec.type === 'core',
        fireRating: slot.type === 'mech-room' || slot.type === 'elec-room' || slot.type === 'trash' ? '1HR' : undefined,
        leftRoomId: room.id,
      });
      room.wallIds.push(w.id);
      if (side === slot.accessSide) {
        // a leaf may not be wider than the wall that hosts it; a remnant slice too narrow for one becomes a
        // cased opening (no leaf, no arc) rather than a door hanging out past both ends of its wall
        const len = 2 * wallMid(w);
        const width = round(Math.min(slot.doorWidth ?? doorWidthFor(slot.type), Math.max(0.2, len - 0.1)));
        const motion: DoorMotion = width >= LEAF_MIN.closet ? 'swing' : 'opening';
        const along = round(alongInWall(w, slot.rect, width));
        // the leaf sweeps this room's floor, not the corridor it is entered from
        const sol = solveSwing({ wall: w, along, width, motion, into: reachRect(slot.rect, w) });
        b.addDoor({
          storey: st, wallId: w.id, along, width,
          height: SIZES.doorHeight, type: slot.type === 'lobby' ? 'interior' : 'service',
          motion, hinge: sol.hinge, swing: sol.swing,
          ...(motion === 'swing' ? { swingIntoRoomId: room.id } : {}),
          fromRoomId: room.id,
          fireRated: slot.type === 'mech-room' || slot.type === 'elec-room' || slot.type === 'trash',
        });
      }
    }
  }

  // external entrance door
  if (slot.entrance) {
    const span = sideSpan(slot.rect, slot.entrance.side);
    const host = env.wallFor(slot.entrance.side, span.across, span.a0, span.a1);
    if (host) {
      const along = wallMid(host);
      // an entrance door swings OUT to the street in the direction of egress (IBC 1010.1.2.1)
      const sol = solveSwing({ wall: host, along, width: slot.entrance.width, motion: 'swing', into: reachRect(slot.rect, host) });
      b.addDoor({
        storey: st, wallId: host.id, along, width: slot.entrance.width,
        height: 2.4, type: slot.entrance.type === 'building-entry' ? 'building-entry' : 'service',
        motion: 'swing', hinge: sol.hinge, swing: sol.swing === 'left' ? 'right' : 'left',
        fromRoomId: room.id,
      });
    }
  }

  // glazing
  let glazed = 0;
  const wwr = slot.glazing?.wwr ?? (room.zone === 'service' ? Math.min(0.12, f.wwr) : f.wwr);
  for (const { wall } of extWalls) {
    glazed += glazeWall(b, wall, room.id, {
      wwr,
      sill: slot.glazing?.sill,
      height: slot.glazing?.height,
      maxWidth: slot.glazing ? 3.0 : 2.2,
    });
  }
  void streetFacing;
  return { room, glazedArea: glazed };
}

function doorWidthFor(t: RoomType): number {
  if (t === 'lobby' || t === 'amenity' || t === 'lounge' || t === 'gym' || t === 'dining-hall') return 1.4;
  if (t === 'bike-store' || t === 'trash' || t === 'mech-room') return 1.1;
  return SIZES.doorUnitEntry;
}

function wallMid(w: import('../../core/types.ts').WallDef): number {
  return round(Math.hypot(w.end[0] - w.start[0], w.end[1] - w.start[1]) / 2);
}

/** Furniture for common rooms (kept light; the unit layout engine furnishes dwellings) */
export function furnishCommonRoom(b: ArchBuilder, room: RoomDef, detail: 'low' | 'medium' | 'high'): void {
  if (detail === 'low') return;
  const add = (type: FurnitureType, x: number, y: number, w: number, d: number, h: number): void => {
    b.addFurniture({ storey: room.storey, roomId: room.id, type, position: [round(x), round(y)], width: w, depth: d, height: h, rotation: 0, needsPower: type === 'treadmill' });
  };
  const r = room.rect;
  switch (room.type) {
    case 'lobby':
      add('reception-desk', r.x + 0.6, r.y + r.h - 1.4, 2.4, 0.7, 1.1);
      add('sofa-2', r.x + r.w - 2.4, r.y + 0.5, 1.6, 0.85, 0.8);
      break;
    case 'mail':
      add('mailbox-bank', r.x + 0.3, r.y + 0.3, Math.min(3.0, r.w - 0.6), 0.4, 1.8);
      break;
    case 'bike-store': {
      const n = Math.max(2, Math.min(12, Math.floor((r.w - 0.6) / 0.7)));
      for (let k = 0; k < n; k++) add('bike-rack', r.x + 0.4 + k * 0.7, r.y + 0.4, 0.5, 1.8, 1.2);
      break;
    }
    case 'gym':
      for (let k = 0; k < Math.min(4, Math.floor((r.w - 1) / 1.6)); k++) add('treadmill', r.x + 0.6 + k * 1.6, r.y + 0.6, 0.9, 1.9, 1.4);
      break;
    case 'lounge':
      add('sofa-3', r.x + 0.8, r.y + 0.8, 2.2, 0.9, 0.8);
      add('coffee-table', r.x + 1.1, r.y + 2.0, 1.2, 0.6, 0.42);
      add('lounge-chair', r.x + 0.8, r.y + 3.0, 0.8, 0.85, 0.8);
      break;
    case 'dining-hall':
      for (let k = 0; k < Math.min(4, Math.floor((r.w - 1) / 2.4)); k++) add('dining-table-6', r.x + 0.8 + k * 2.4, r.y + 1.0, 1.8, 0.9, 0.75);
      break;
    case 'flex':
      add('desk', r.x + 0.6, r.y + 0.6, 1.6, 0.8, 0.74);
      add('chair', r.x + 1.1, r.y + 1.5, 0.5, 0.5, 0.9);
      break;
    case 'wc':
      add('wc', r.x + 0.2, r.y + 0.2, 0.4, 0.7, 0.8);
      add('lavatory', r.x + 0.2, r.y + 1.1, 0.5, 0.4, 0.85);
      add('grab-rail', r.x + 0.8, r.y + 0.2, 0.05, 0.8, 0.05);
      break;
    case 'water-room':
      add('water-heater', r.x + 0.3, r.y + 0.3, 0.8, 0.8, 1.8);
      break;
    case 'parking':
      break;
    default:
      break;
  }
}

/** A parking plate with a ramp at the rear */
export function buildParkingRamp(b: ArchBuilder, f: FloorCtx, frame: BarFrame, cores: Interval[]): void {
  const rampW = 6.0;
  const rampLen = Math.min(14, frame.depth - 2);
  if (rampLen < 5) return;
  // place at the far (high-along) end, avoiding the cores
  const a1 = frame.a1 - 0.6;
  const a0 = a1 - rampW;
  const clash = cores.some(c => c.s < a1 && a0 < c.e);
  const s0 = clash ? frame.a0 + 0.6 : a0;
  const rect = rectFromAC(frame, s0, s0 + rampW, frame.c1 - rampLen, frame.c1 - 0.6);
  rampElement(b, f.storeyId, rect, f.floorToFloor);
}
