/**
 * Placement helpers for the mechanical discipline: room classification, wall-mounted and
 * ceiling-mounted box framing, orthogonal duct routing, roof plant packing and the
 * shaft-slot convention shared with plumbing and electrical.
 *
 * SHAFT SLOT CONVENTION (documented once, relied on by three disciplines)
 * ---------------------------------------------------------------------
 * A shaft rect is divided between the MEP disciplines so risers never coincide:
 *   - MECHANICAL takes the shaft CENTRE (`shaftSlot(rect, 0)`); extra mechanical risers
 *     (kitchen exhaust, outdoor air, refrigerant, hydronic) step along the shaft's LONG
 *     axis either side of the centre, never leaving the MIDDLE THIRD of that axis.
 *   - PLUMBING takes the corner toward corridor-LEFT.
 *   - ELECTRICAL takes the corner toward corridor-RIGHT.
 * Everything mechanical emits inside a shaft therefore stays within the middle third of
 * the rect and never occupies a corner.
 */
import type {
  Rect, Vec2, Vec3, RoomDef, WallDef, WindowDef, FurnitureDef, Segment2, ShaftDef,
} from '../../core/types.ts';
import {
  add, sub, scale, norm, perp, dot, midpoint, angleOf, dist, rectCenter, inset, rectContainsPoint,
  segPointAt, polygonArea, polygonCentroid, pointInPolygon, rectToPolygon, projectOnSegment,
} from '../../core/geometry.ts';

// ----------------------------------------------------------------------------
// Room classification
// ----------------------------------------------------------------------------

/** Rooms that are conditioned and need a supply terminal or a local unit (MEC-02) */
export const HABITABLE: ReadonlySet<string> = new Set([
  'living', 'dining', 'kitchen', 'living-kitchen', 'bedroom', 'master-bedroom', 'den', 'study',
  'flex', 'shared-living', 'shared-kitchen', 'lounge',
]);

/** Rooms that must be mechanically extracted (MEC-03 / Part F Table 1.2, ASHRAE 62.2 Table 5.1) */
export const EXTRACT_ROOMS: ReadonlySet<string> = new Set([
  'bathroom', 'ensuite', 'wc', 'powder', 'laundry', 'utility',
]);

/** Strictly wet rooms (sanitary) — always get an exhaust grille */
export const WET_ROOMS: ReadonlySet<string> = new Set(['bathroom', 'ensuite', 'wc', 'powder']);

/**
 * Rooms that can host an air handler / ERV / HIU inside the dwelling, in order of
 * preference. A walk-in closet is deliberately excluded — it is wardrobe space.
 */
export const PLANT_CLOSETS: readonly string[] = ['utility', 'laundry', 'storage', 'closet'];

/** Rooms that count as the dwelling's circulation spine (duct trunk zone) */
export const HALL_ROOMS: readonly string[] = ['hall', 'entry', 'corridor'];

export function isHabitable(r: RoomDef): boolean { return HABITABLE.has(r.type); }
export function needsExtract(r: RoomDef): boolean { return EXTRACT_ROOMS.has(r.type) || (r.isWet && r.type !== 'kitchen' && r.type !== 'living-kitchen'); }
export function isKitchen(r: RoomDef): boolean { return r.type === 'kitchen' || r.type === 'living-kitchen' || r.type === 'shared-kitchen'; }

export function firstOfType(rooms: RoomDef[], types: readonly string[]): RoomDef | null {
  for (const t of types) {
    const hit = rooms.find(r => r.type === t);
    if (hit) return hit;
  }
  return null;
}

/** The dwelling's hall (duct trunk lives in its ceiling). Falls back to the largest circulation or service room. */
export function hallOf(rooms: RoomDef[], entryPoint: Vec2 | null): RoomDef | null {
  const direct = firstOfType(rooms, HALL_ROOMS);
  if (direct) return direct;
  const circ = rooms.filter(r => r.zone === 'circulation');
  if (circ.length > 0) return largest(circ);
  if (entryPoint) {
    let best: RoomDef | null = null;
    let bestD = Infinity;
    for (const r of rooms) {
      const d = dist(rectCenter(r.rect), entryPoint);
      if (d < bestD) { bestD = d; best = r; }
    }
    if (best) return best;
  }
  return rooms.length > 0 ? largest(rooms) : null;
}

/**
 * Service room that can host an air handler / ERV / HIU: first by PLANT_CLOSETS preference
 * order, then by area. Needs ≥ 1.2 m² and ≥ 0.8 m each way.
 */
export function plantClosetFor(rooms: RoomDef[]): RoomDef | null {
  const fits = (r: RoomDef): boolean => r.rect.w >= 0.8 && r.rect.h >= 0.8 && roomAreaOf(r) >= 1.2;
  for (const t of PLANT_CLOSETS) {
    const cand = rooms.filter(r => r.type === t && fits(r));
    if (cand.length > 0) return cand.reduce((a, c) => (roomAreaOf(c) > roomAreaOf(a) ? c : a));
  }
  return null;
}

export function largest(rooms: RoomDef[]): RoomDef {
  return rooms.reduce((a, b) => (b.area > a.area ? b : a));
}

export function roomCentre(r: RoomDef): Vec2 { return rectCenter(r.rect); }

export function roomAreaOf(r: RoomDef): number {
  if (r.area > 0) return r.area;
  return r.polygon.length >= 3 ? polygonArea(r.polygon) : r.rect.w * r.rect.h;
}

// ----------------------------------------------------------------------------
// Points on / in rects
// ----------------------------------------------------------------------------

/** Closest point on the boundary of `r` to `p` (p may be inside or outside) */
export function closestOnRect(r: Rect, p: Vec2): Vec2 {
  const cx = Math.min(Math.max(p[0], r.x), r.x + r.w);
  const cy = Math.min(Math.max(p[1], r.y), r.y + r.h);
  if (!rectContainsPoint(r, p)) return [cx, cy];
  // p is inside: push out to the nearest edge
  const dl = p[0] - r.x, dr = r.x + r.w - p[0], df = p[1] - r.y, db = r.y + r.h - p[1];
  const m = Math.min(dl, dr, df, db);
  if (m === dl) return [r.x, p[1]];
  if (m === dr) return [r.x + r.w, p[1]];
  if (m === df) return [p[0], r.y];
  return [p[0], r.y + r.h];
}

/**
 * Keep an anchor point inside a room that is NOT a simple rectangle (L-shaped corner units,
 * chamfered plans). `RoomDef.rect` is only the bounding box, so a point derived from it can
 * fall in the notch; this snaps it back into the polygon, as close to the wanted point as a
 * coarse grid allows.
 */
export function anchorInRoom(room: RoomDef, desired: Vec2): Vec2 {
  const poly = room.polygon;
  if (poly.length < 3) return desired;
  const bboxArea = room.rect.w * room.rect.h;
  if (bboxArea <= 0) return desired;
  const polyArea = polygonArea(poly);
  // Rectangular enough that the bounding box is the room
  if (polyArea >= bboxArea * 0.98) return desired;
  if (pointInPolygon(desired, poly)) return desired;
  const c = polygonCentroid(poly);
  if (pointInPolygon(c, poly)) return c;
  let best: Vec2 | null = null;
  let bestD = Infinity;
  const n = 6;
  for (let i = 1; i < n; i++) {
    for (let j = 1; j < n; j++) {
      const p: Vec2 = [room.rect.x + (room.rect.w * i) / n, room.rect.y + (room.rect.h * j) / n];
      if (!pointInPolygon(p, poly)) continue;
      const d = dist(p, desired);
      if (d < bestD) { bestD = d; best = p; }
    }
  }
  return best ?? desired;
}

/** Move `p` (assumed on or near the boundary of `r`) `d` metres toward the rect centre */
export function pushInside(r: Rect, p: Vec2, d: number): Vec2 {
  const c = rectCenter(r);
  const v = sub(c, p);
  const l = Math.hypot(v[0], v[1]);
  if (l < 1e-6) return c;
  const step = Math.min(d, l);
  return add(p, scale([v[0] / l, v[1] / l], step));
}

/** Clamp a w×d footprint's min corner so the footprint stays inside `r` */
export function clampFootprint(r: Rect, min: Vec2, w: number, d: number): Vec2 {
  return [
    Math.min(Math.max(min[0], r.x), Math.max(r.x, r.x + r.w - w)),
    Math.min(Math.max(min[1], r.y), Math.max(r.y, r.y + r.h - d)),
  ];
}

/** Longer axis of a rect as a unit vector */
export function longAxis(r: Rect): Vec2 { return r.w >= r.h ? [1, 0] : [0, 1]; }

/** Centreline of a rect along its long axis, shortened by `margin` at each end */
export function rectSpine(r: Rect, margin: number): Segment2 {
  const c = rectCenter(r);
  if (r.w >= r.h) {
    const m = Math.min(margin, Math.max(0, r.w / 2 - 0.1));
    return { a: [r.x + m, c[1]], b: [r.x + r.w - m, c[1]] };
  }
  const m = Math.min(margin, Math.max(0, r.h / 2 - 0.1));
  return { a: [c[0], r.y + m], b: [c[0], r.y + r.h - m] };
}

/** Closest point on a segment (clamped) */
export function closestOnSegment(s: Segment2, p: Vec2): Vec2 {
  const d = sub(s.b, s.a);
  const l2 = d[0] * d[0] + d[1] * d[1];
  if (l2 < 1e-9) return s.a;
  const t = Math.max(0, Math.min(1, dot(sub(p, s.a), d) / l2));
  return add(s.a, scale(d, t));
}

// ----------------------------------------------------------------------------
// Walls, windows, furniture
// ----------------------------------------------------------------------------

export interface WallFrame {
  /** Unit vector along the wall (start → end) */
  dir: Vec2;
  /** Unit normal pointing toward the reference point (i.e. into the room) */
  inward: Vec2;
  /** Mid point of the wall centreline */
  mid: Vec2;
  length: number;
}

export function wallFrame(wall: WallDef, towards: Vec2): WallFrame {
  const dir = norm(sub(wall.end, wall.start));
  let inward = perp(dir);
  const mid = midpoint(wall.start, wall.end);
  if (dot(inward, sub(towards, mid)) < 0) inward = scale(inward, -1);
  return { dir, inward, mid, length: dist(wall.start, wall.end) };
}

/** A point on the wall's inside face (offset from the centreline by half the thickness) */
export function wallFacePoint(wall: WallDef, frame: WallFrame, along: number): Vec2 {
  const onAxis = segPointAt({ a: wall.start, b: wall.end }, Math.max(0, Math.min(frame.length, along)));
  return add(onAxis, scale(frame.inward, wall.thickness / 2));
}

/**
 * Box geometry for an object standing against a wall: `faceCentre` is the centre of the
 * object's back face (on the wall's inside face); the object is `w` long along the wall
 * and `d` deep into the room. Returns the `box` min corner + rotation.
 */
export function boxAgainstWall(faceCentre: Vec2, frame: WallFrame, w: number, d: number, z: number): { position: Vec3; rotation: number } {
  const u: Vec2 = dot(perp(frame.dir), frame.inward) >= 0 ? frame.dir : scale(frame.dir, -1);
  const p = sub(faceCentre, scale(u, w / 2));
  return { position: [p[0], p[1], z], rotation: angleOf(u) };
}

/**
 * Anchor point for something hung on `wall` inside `room`: the point on the wall's inside
 * face closest to the room centre, kept `w/2` clear of the wall ends. Returns null when the
 * wall does not actually bound the room (architecture wall lists are not always tight), so
 * callers can fall back to a free-standing position instead of placing plant in another room.
 */
export function wallAnchor(room: RoomDef, wall: WallDef, w = 0.6): { frame: WallFrame; face: Vec2 } | null {
  const c = roomCentre(room);
  const frame = wallFrame(wall, c);
  if (frame.length < w) return null;
  const proj = projectOnSegment({ a: wall.start, b: wall.end }, c);
  const along = Math.min(Math.max(proj.clamped, w / 2), frame.length - w / 2);
  const face = wallFacePoint(wall, frame, along);
  if (!rectContainsPoint(room.rect, face, 0.2)) return null;
  return { frame, face };
}

/** Wall-mounted box inside a room, falling back to the room centre if the wall does not bound it */
export function wallMountedBox(room: RoomDef, wall: WallDef | null, w: number, d: number, z: number): { position: Vec3; rotation: number } {
  if (wall) {
    const anchor = wallAnchor(room, wall, w);
    if (anchor) return boxAgainstWall(anchor.face, anchor.frame, w, d, z);
  }
  return boxAtCentre(roomCentre(room), w, d, z);
}

/** Box geometry for an object centred on a point with no rotation */
export function boxAtCentre(centre: Vec2, w: number, d: number, z: number, rotation = 0): { position: Vec3; rotation: number } {
  if (Math.abs(rotation) < 1e-9) return { position: [centre[0] - w / 2, centre[1] - d / 2, z], rotation: 0 };
  const u: Vec2 = [Math.cos(rotation), Math.sin(rotation)];
  const v = perp(u);
  const p = sub(sub(centre, scale(u, w / 2)), scale(v, d / 2));
  return { position: [p[0], p[1], z], rotation };
}

/** World point of a window centre on its host wall centreline */
export function windowPoint(win: WindowDef, wall: WallDef): Vec2 {
  return segPointAt({ a: wall.start, b: wall.end }, win.along);
}

export function furnitureCentre(f: FurnitureDef): Vec2 {
  const u: Vec2 = [Math.cos(f.rotation), Math.sin(f.rotation)];
  const v = perp(u);
  return add(add(f.position, scale(u, f.width / 2)), scale(v, f.depth / 2));
}

// ----------------------------------------------------------------------------
// Orthogonal routing
// ----------------------------------------------------------------------------

/** Manhattan route a → b at a constant Z, long leg first; collapses degenerate points. */
export function routeOrthogonal(a: Vec2, b: Vec2, z: number): Vec3[] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const pts: Vec2[] = Math.abs(dx) >= Math.abs(dy)
    ? [a, [b[0], a[1]], b]
    : [a, [a[0], b[1]], b];
  return dedupe(pts.map(p => [p[0], p[1], z] as Vec3));
}

/** Concatenate routes, dropping repeated points */
export function joinPath(...parts: Vec3[][]): Vec3[] {
  const out: Vec3[] = [];
  for (const part of parts) for (const p of part) out.push(p);
  return dedupe(out);
}

export function dedupe(path: Vec3[], eps = 0.02): Vec3[] {
  const out: Vec3[] = [];
  for (const p of path) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1], p[2] - last[2]) > eps) out.push(p);
  }
  return out;
}

export function pathLength(path: Vec3[]): number {
  let l = 0;
  for (let i = 1; i < path.length; i++) {
    l += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1], path[i][2] - path[i - 1][2]);
  }
  return l;
}

/** Points spaced at most `spacing` apart along a polyline (used for corridor diffusers) */
export function samplePath(path: Vec3[], spacing: number): Vec3[] {
  const total = pathLength(path);
  if (total <= 1e-6) return path.slice(0, 1);
  const n = Math.max(1, Math.ceil(total / spacing));
  const step = total / n;
  const out: Vec3[] = [];
  for (let k = 0; k < n; k++) out.push(pointAlong(path, step * (k + 0.5)));
  return out;
}

/** Closest point of a 3D polyline to a plan point, keeping the polyline's Z */
export function closestOnPath(path: Vec3[], p: Vec2): Vec3 {
  if (path.length === 0) return [p[0], p[1], 0];
  let best: Vec3 = path[0];
  let bestD = Infinity;
  for (let i = 1; i < path.length; i++) {
    const q = closestOnSegment({ a: [path[i - 1][0], path[i - 1][1]], b: [path[i][0], path[i][1]] }, p);
    const d = dist(q, p);
    if (d < bestD) { bestD = d; best = [q[0], q[1], path[i][2]]; }
  }
  return best;
}

export function pointAlong(path: Vec3[], along: number): Vec3 {
  let acc = 0;
  for (let i = 1; i < path.length; i++) {
    const seg = Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1], path[i][2] - path[i - 1][2]);
    if (acc + seg >= along || i === path.length - 1) {
      const t = seg < 1e-9 ? 0 : Math.max(0, Math.min(1, (along - acc) / seg));
      return [
        path[i - 1][0] + (path[i][0] - path[i - 1][0]) * t,
        path[i - 1][1] + (path[i][1] - path[i - 1][1]) * t,
        path[i - 1][2] + (path[i][2] - path[i - 1][2]) * t,
      ];
    }
    acc += seg;
  }
  return path[path.length - 1];
}

// ----------------------------------------------------------------------------
// Shafts
// ----------------------------------------------------------------------------

/**
 * Mechanical riser slot inside a shaft. Slot 0 is the exact shaft centre (the main duct
 * riser); slots 1.. step ±0.22 m along the shaft's long axis, clamped inside inset(rect, 0.12)
 * so mechanical never touches the corners reserved for plumbing (corridor-left) and
 * electrical (corridor-right).
 */
export function shaftSlot(rect: Rect, slot: number): Vec2 {
  const c = rectCenter(rect);
  if (slot <= 0) return c;
  const axis = longAxis(rect);
  // Mechanical keeps to the middle third of the shaft's long axis: the outer thirds (and so
  // both corners) stay free for the plumbing stack and the electrical riser.
  const band = Math.max(rect.w, rect.h) / 3;
  const rings = 3;
  const k = Math.min(rings, Math.ceil(slot / 2));
  const sign = slot % 2 === 1 ? 1 : -1;
  const offset = (band / 2) * (k / rings);
  const raw = add(c, scale(axis, sign * offset));
  const safe = inset(rect, 0.05);
  return [
    Math.min(Math.max(raw[0], safe.x), safe.x + safe.w),
    Math.min(Math.max(raw[1], safe.y), safe.y + safe.h),
  ];
}

/** Number of distinct mechanical slots a shaft can offer before they start repeating */
export const SHAFT_SLOT_CAPACITY = 7;

export function nearestShaft(shafts: ShaftDef[], p: Vec2, storey?: string): ShaftDef | null {
  let best: ShaftDef | null = null;
  let bestD = Infinity;
  for (const s of shafts) {
    if (storey && s.storeys.length > 0 && !s.storeys.includes(storey)) continue;
    const d = dist(rectCenter(s.rect), p);
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}

// ----------------------------------------------------------------------------
// Roof plant packing (MEC-06)
// ----------------------------------------------------------------------------

/**
 * Shelf packer for the roof plant zone. Items are placed left→right in rows with
 * `aisle` metres between them; when the zone runs out the aisle collapses to 0.15 m
 * (still non-overlapping, because the cursor always sits past the previous item).
 */
export class PlantGrid {
  readonly zone: Rect;
  private aisle: number;
  private cursorX: number;
  private cursorY: number;
  private rowDepth: number;
  private compacted = false;
  overflow = 0;

  constructor(zone: Rect, aisle = 1.0) {
    this.zone = zone;
    this.aisle = aisle;
    this.cursorX = zone.x;
    this.cursorY = zone.y;
    this.rowDepth = 0;
  }

  /** Min corner of a w×d footprint inside the zone. Never returns a footprint outside the zone. */
  place(w: number, d: number): Vec2 {
    const p = this.tryPlace(w, d);
    if (p) return p;
    if (!this.compacted) {
      this.compacted = true;
      this.aisle = 0.15;
      const q = this.tryPlace(w, d);
      if (q) return q;
    }
    // Zone genuinely full: clamp inside the zone and report an overflow.
    this.overflow++;
    return clampFootprint(this.zone, [this.zone.x, this.zone.y], w, d);
  }

  private tryPlace(w: number, d: number): Vec2 | null {
    if (w > this.zone.w + 1e-6 || d > this.zone.h + 1e-6) return null;
    if (this.cursorX + w > this.zone.x + this.zone.w + 1e-6) {
      this.cursorX = this.zone.x;
      this.cursorY += this.rowDepth + this.aisle;
      this.rowDepth = 0;
    }
    if (this.cursorY + d > this.zone.y + this.zone.h + 1e-6) return null;
    const p: Vec2 = [this.cursorX, this.cursorY];
    this.cursorX += w + this.aisle;
    this.rowDepth = Math.max(this.rowDepth, d);
    return p;
  }
}

/** Fallback plant zone: 0.25 m²/unit, min 3×3, centred in the roof outline bounds (MEC-06) */
export function derivePlantZone(bounds: Rect, unitCount: number): Rect {
  const need = Math.max(9, 0.25 * Math.max(1, unitCount));
  const usable = inset(bounds, 1.5);
  const side = Math.sqrt(need);
  const w = Math.min(Math.max(side, 3), Math.max(3, usable.w));
  const h = Math.min(Math.max(need / w, 3), Math.max(3, usable.h));
  const c = rectCenter(bounds);
  return { x: c[0] - w / 2, y: c[1] - h / 2, w, h };
}

export function rectPolygon(r: Rect): Vec2[] { return rectToPolygon(r); }
