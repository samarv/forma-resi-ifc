/**
 * Step 1 — fixtures.
 *
 * Reads architecture furniture flagged `needsWater`, maps it to plumbing fixtures, and attaches
 * every fixture to the wet wall it drains into (pattern XD-01 / PLB-09). Bathrooms whose furniture
 * is missing are given a synthesised wc + lavatory + shower so the plumbing model is always
 * complete. Also places hose bibbs and floor drains.
 */
import type {
  ArchModel, FurnitureDef, PlumbingFixture, RoomDef, Segment2, UnitInstance, Vec2, WallDef,
} from '../../core/types.ts';
import {
  dist, dot, perp, polygonBounds, polygonCentroid, projectOnSegment, scale, segDir, segLength,
  segPointAt, add, sub, rectCenter, rectEdges, norm,
} from '../../core/geometry.ts';
import { MOUNTING } from '../../core/coordination.ts';
import { FIXTURES, fixtureTypeForFurniture, type FixtureSpec, type FixtureType } from './tables.ts';
import { addFixture, bump, warn, type PlumbState } from './state.ts';

export interface PlacedFixture {
  fixture: PlumbingFixture;
  spec: FixtureSpec;
  storey: string;
  unitId?: string;
  roomId?: string;
  center: Vec2;
  /** Wet wall centreline this fixture drains into */
  wall: Segment2;
  wallId: string;
  wallThickness: number;
  /** Station along the wall from `wall.a` (m) */
  along: number;
  /** Signed perpendicular offset from the wall centreline (left of wall direction positive) */
  offset: number;
  /** Assigned in stacks.ts */
  stackIdx: number;
  /**
   * Set by stacks.ts when the fixture is further from its dwelling's stack than the UNVENTED
   * trap-arm limit allows: it is drained by an individually vented branch drain (IPC 905/912)
   * instead of opening another stack.
   */
  vented?: boolean;
}

const WET_ROOM_TYPES = new Set(['bathroom', 'ensuite', 'powder', 'wc']);
const DRAIN_ROOM_TYPES = new Set(['mech-room', 'water-room', 'elec-room', 'plant', 'parking', 'trash']);

/** Plan centre of a furniture item (position is the min corner BEFORE rotation about that corner) */
export function furnitureCenter(f: FurnitureDef): Vec2 {
  const c = Math.cos(f.rotation), s = Math.sin(f.rotation);
  const hx = f.width / 2, hy = f.depth / 2;
  return [f.position[0] + hx * c - hy * s, f.position[1] + hx * s + hy * c];
}

function wallSegment(w: WallDef): Segment2 {
  return { a: w.start, b: w.end };
}

/** Perpendicular distance from a point to a segment (clamped to its extent) */
function distToSegment(seg: Segment2, p: Vec2): number {
  const pr = projectOnSegment(seg, p);
  return dist(segPointAt(seg, pr.clamped), p);
}

/**
 * Pick the wet wall a fixture drains into: the closest wall of the unit's wetWallIds, preferring
 * walls on the fixture's own storey. Falls back to the nearest wall of type 'wet' on that storey,
 * then to a virtual wall on the room's nearest long edge.
 */
function chooseWall(
  center: Vec2,
  storey: string,
  unit: UnitInstance | undefined,
  room: RoomDef | undefined,
  wallById: Map<string, WallDef>,
  wetByStorey: Map<string, WallDef[]>,
): { seg: Segment2; id: string; thickness: number } | null {
  const candidates: WallDef[] = [];
  for (const id of unit?.wetWallIds ?? []) {
    const w = wallById.get(id);
    if (w) candidates.push(w);
  }
  const sameStorey = candidates.filter(w => w.storey === storey);
  const pool = sameStorey.length > 0 ? sameStorey : candidates;
  let best: WallDef | null = null;
  let bestD = Infinity;
  for (const w of pool) {
    if (segLength(wallSegment(w)) < 0.3) continue;
    const d = distToSegment(wallSegment(w), center);
    if (d < bestD) { bestD = d; best = w; }
  }
  if (!best) {
    for (const w of wetByStorey.get(storey) ?? []) {
      if (segLength(wallSegment(w)) < 0.3) continue;
      const d = distToSegment(wallSegment(w), center);
      if (d < bestD && d < 6) { bestD = d; best = w; }
    }
  }
  if (best) return { seg: wallSegment(best), id: best.id, thickness: best.thickness };
  if (room) {
    // Virtual wet wall: the room edge closest to the fixture, shortened to the room's extent
    const edges = rectEdges(room.rect);
    let bestSeg: Segment2 | null = null;
    let bd = Infinity;
    for (const key of ['front', 'rear', 'left', 'right'] as const) {
      const e = edges[key];
      const d = distToSegment(e, center);
      if (d < bd) { bd = d; bestSeg = e; }
    }
    if (bestSeg) return { seg: bestSeg, id: `VW-${room.id}`, thickness: 0.2 };
  }
  return null;
}

function place(
  st: PlumbState,
  out: PlacedFixture[],
  fixture: PlumbingFixture,
  spec: FixtureSpec,
  center: Vec2,
  wall: { seg: Segment2; id: string; thickness: number },
  storey: string,
  unitId?: string,
  roomId?: string,
): void {
  const pr = projectOnSegment(wall.seg, center);
  out.push({
    fixture, spec, storey, unitId, roomId, center,
    wall: wall.seg, wallId: wall.id, wallThickness: wall.thickness,
    along: pr.along, offset: pr.offset, stackIdx: -1, vented: false,
  });
}

/**
 * Build every dwelling fixture. Returns the placed (wall-attached) fixtures; fixtures with no
 * drainage (water heaters, hose bibbs) are registered but returned separately by the callers
 * that need them.
 */
export function buildFixtures(st: PlumbState): PlacedFixture[] {
  const arch = st.ctx.arch as ArchModel;
  const out: PlacedFixture[] = [];
  const wallById = new Map(arch.walls.map(w => [w.id, w] as const));
  const roomById = new Map(arch.rooms.map(r => [r.id, r] as const));
  const unitById = new Map(arch.units.map(u => [u.id, u] as const));
  const furnById = new Map(arch.furniture.map(f => [f.id, f] as const));

  const wetByStorey = new Map<string, WallDef[]>();
  for (const w of arch.walls) {
    if (w.type !== 'wet') continue;
    const list = wetByStorey.get(w.storey);
    if (list) list.push(w); else wetByStorey.set(w.storey, [w]);
  }

  // --- from furniture -------------------------------------------------------
  const roomsWithFixtures = new Set<string>();
  for (const f of arch.furniture) {
    if (!f.needsWater) continue;
    const type = fixtureTypeForFurniture(f.type);
    if (!type) continue;
    const center = furnitureCenter(f);
    const room = roomById.get(f.roomId);
    const unit = f.unitId ? unitById.get(f.unitId) : undefined;
    if (type === 'water-heater') continue; // handled by dhw.ts
    const spec = FIXTURES[type];
    const fixture = addFixture(st, {
      type, storey: f.storey, center: [center[0], center[1], 0], rotation: f.rotation,
      roomId: f.roomId, unitId: f.unitId, furnitureId: f.id,
      width: f.width, depth: f.depth, height: f.height,
      patterns: ['PLB-01', 'PLB-09'],
    });
    roomsWithFixtures.add(f.roomId);
    bump(st, 'fixturesFromFurniture');
    // The fixture is always registered (it counts toward DFU/WSFU); only its pipework needs a wall.
    const wall = chooseWall(center, f.storey, unit, room, wallById, wetByStorey);
    if (!wall) {
      warn(st, `nowall:${f.type}`,
        `no wet wall or room edge found for ${f.type} (e.g. ${f.id} on ${f.storey}); the fixture is recorded but left unpiped`);
      bump(st, 'unpipedFixtures');
      continue;
    }
    place(st, out, fixture, spec, center, wall, f.storey, f.unitId, f.roomId);
  }

  // --- synthesised bathrooms (architecture furnished nothing) ---------------
  for (const room of arch.rooms) {
    if (!WET_ROOM_TYPES.has(room.type)) continue;
    if (roomsWithFixtures.has(room.id)) continue;
    if (room.furnitureIds.some(id => furnById.get(id)?.needsWater)) continue;
    const unit = room.unitId ? unitById.get(room.unitId) : undefined;
    const wall = chooseWall(rectCenter(room.rect), room.storey, unit, room, wallById, wetByStorey);
    if (!wall) {
      warn(st, `nobathwall:${room.storey}`, `bathroom ${room.id} has no wet wall; no fixtures synthesised`);
      continue;
    }
    const types: FixtureType[] = room.type === 'powder' || room.type === 'wc'
      ? ['wc', 'lavatory']
      : ['wc', 'lavatory', 'shower'];
    const seg = wall.seg;
    const d = segDir(seg);
    const n = perp(d);
    const center = rectCenter(room.rect);
    const pr = projectOnSegment(seg, center);
    const side = pr.offset >= 0 ? 1 : -1;
    // Span of the room measured along the wall
    const stations: number[] = [];
    for (const corner of [[room.rect.x, room.rect.y], [room.rect.x + room.rect.w, room.rect.y],
      [room.rect.x + room.rect.w, room.rect.y + room.rect.h], [room.rect.x, room.rect.y + room.rect.h]] as Vec2[]) {
      stations.push(projectOnSegment(seg, corner).along);
    }
    const a0 = Math.max(0, Math.min(...stations));
    const a1 = Math.min(segLength(seg), Math.max(...stations));
    const usable = Math.max(0.6, a1 - a0);
    for (let i = 0; i < types.length; i++) {
      const type = types[i];
      const spec = FIXTURES[type];
      const t = types.length === 1 ? 0.5 : (i + 0.5) / types.length;
      const along = a0 + usable * t;
      const p = add(segPointAt(seg, along), scale(n, side * 0.4));
      const fixture = addFixture(st, {
        type, storey: room.storey, center: [p[0], p[1], 0],
        rotation: Math.atan2(n[1] * side, n[0] * side),
        roomId: room.id, unitId: room.unitId,
        patterns: ['PLB-01', 'PLB-09'],
        solid: true,
      });
      place(st, out, fixture, spec, p, wall, room.storey, room.unitId, room.id);
      bump(st, 'fixturesSynthesised');
    }
    warn(st, `synth:${room.type}`,
      `bathroom furniture missing (${room.type}); synthesised wc/lavatory/shower on the wet wall 0.4 m off the face`);
  }

  // --- kitchens with no sink ------------------------------------------------
  for (const unit of arch.units) {
    const kitchen = unit.kitchenRoomId ? roomById.get(unit.kitchenRoomId) : undefined;
    if (!kitchen) continue;
    const hasSink = out.some(p => p.roomId === kitchen.id && p.fixture.type === 'kitchen-sink');
    if (hasSink) continue;
    const wall = chooseWall(rectCenter(kitchen.rect), kitchen.storey, unit, kitchen, wallById, wetByStorey);
    if (!wall) continue;
    const d = segDir(wall.seg);
    const n = perp(d);
    const pr = projectOnSegment(wall.seg, rectCenter(kitchen.rect));
    const side = pr.offset >= 0 ? 1 : -1;
    const along = Math.max(0.4, Math.min(segLength(wall.seg) - 0.4, pr.along));
    const p = add(segPointAt(wall.seg, along), scale(n, side * 0.4));
    const fixture = addFixture(st, {
      type: 'kitchen-sink', storey: kitchen.storey, center: [p[0], p[1], 0],
      rotation: Math.atan2(n[1] * side, n[0] * side),
      roomId: kitchen.id, unitId: unit.id, patterns: ['PLB-01', 'PLB-09'], solid: true,
    });
    place(st, out, fixture, FIXTURES['kitchen-sink'], p, wall, kitchen.storey, unit.id, kitchen.id);
    bump(st, 'fixturesSynthesised');
    warn(st, 'synth:kitchen', 'kitchen had no sink in the furniture; synthesised one on the wet wall');
  }

  return out;
}

/** Floor drains in mechanical / water / plant rooms and parking (IPC §802 indirect wastes) */
export function buildFloorDrains(st: PlumbState): PlumbingFixture[] {
  const arch = st.ctx.arch as ArchModel;
  const drains: PlumbingFixture[] = [];
  for (const room of arch.rooms) {
    if (!DRAIN_ROOM_TYPES.has(room.type)) continue;
    if (room.area < 2) continue;
    const perDrain = room.type === 'parking' ? 300 : 40;
    const count = Math.max(1, Math.min(6, Math.ceil(room.area / perDrain)));
    for (let i = 0; i < count; i++) {
      const t = (i + 0.5) / count;
      const p: Vec2 = room.rect.w >= room.rect.h
        ? [room.rect.x + room.rect.w * t, room.rect.y + room.rect.h / 2]
        : [room.rect.x + room.rect.w / 2, room.rect.y + room.rect.h * t];
      drains.push(addFixture(st, {
        type: 'floor-drain', storey: room.storey, center: [p[0], p[1], -0.02],
        roomId: room.id, solid: true, patterns: ['PLB-07'],
      }));
      bump(st, 'floorDrains');
    }
  }
  return drains;
}

/**
 * Hose bibbs on two exterior walls at grade — houses and walk-ups (PLB-07).
 * Multi-storey corridor buildings get theirs from the landscape irrigation main instead.
 */
export function buildHoseBibbs(st: PlumbState): PlumbingFixture[] {
  const t = st.ctx.typology;
  const houseLike = t.access === 'direct' || t.id === 'garden-walkup' || t.id === 'stacked-townhouse';
  if (!houseLike) return [];
  const arch = st.ctx.arch as ArchModel;
  const storey = st.groundStorey;
  const ext = arch.walls.filter(w => w.storey === storey && w.isExternal && segLength({ a: w.start, b: w.end }) > 2);
  if (ext.length === 0) return [];
  // Two walls with the most different orientations (front + rear / side)
  const sorted = [...ext].sort((a, b) => segLength({ a: b.start, b: b.end }) - segLength({ a: a.start, b: a.end }));
  const first = sorted[0];
  const d0 = segDir({ a: first.start, b: first.end });
  const second = sorted.find(w => Math.abs(d0[0] * segDir({ a: w.start, b: w.end })[0]
    + d0[1] * segDir({ a: w.start, b: w.end })[1]) < 0.9) ?? sorted[1] ?? first;
  // the building centre, so "outward" can be decided without relying on wall winding
  const plan = arch.floors.find(f => f.storey === storey);
  const centre = plan && plan.outline.length > 2
    ? polygonCentroid(plan.outline)
    : rectCenter(polygonBounds(arch.roof.outline));
  const out: PlumbingFixture[] = [];
  for (const w of [first, second]) {
    if (!w) continue;
    const seg = { a: w.start, b: w.end };
    const mid = segPointAt(seg, segLength(seg) / 2);
    let outward = norm(perp(segDir(seg)));
    if (dot(outward, norm(sub(centre, mid))) > 0) outward = scale(outward, -1);
    // push to the outside face of the wall
    const p = add(mid, scale(outward, w.thickness / 2 + 0.06));
    out.push(addFixture(st, {
      type: 'hose-bibb', storey, center: [p[0], p[1], MOUNTING.hoseBibb],
      solid: true, patterns: ['PLB-07'],
    }));
    bump(st, 'hoseBibbs');
  }
  return out;
}

/** Sum of a fixture list's drainage / supply fixture units */
export function sumUnits(fixtures: PlumbingFixture[]): { dfu: number; wsfu: number } {
  let dfu = 0, wsfu = 0;
  for (const f of fixtures) { dfu += f.dfu; wsfu += f.wsfu; }
  return { dfu, wsfu };
}

export { WET_ROOM_TYPES };
