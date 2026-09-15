/**
 * Placement geometry for electrical devices: room wall faces, blocked spans from doors and
 * windows, spacing rules, ceiling grids, furniture edges and anchor → box conversion.
 *
 * A RoomFace is the INSIDE face of one wall as seen from one room: the wall centreline offset
 * by thickness/2 toward the room, clipped to the part of the room edge that wall actually covers.
 * Faces are oriented so that perp(direction) = (-sin r, cos r) points INTO the room, which makes
 * `rotation` directly usable as the rotation of a `box` sitting on the face (pattern in catalog.ts).
 *
 * Two upstream conventions are both accepted, because architecture uses both:
 *   - the room polygon is already the inside face (boundary walls: centreline at −t/2 from the edge);
 *   - the wall centreline lies ON the room polygon edge (interior partitions that straddle the
 *     boundary between two rooms), in which case the face is t/2 inboard of the polygon edge.
 * Anything between the two is accepted and the face is placed at centreline + t/2 inward.
 */
import type { DoorDef, FurnitureDef, Rect, RoomDef, Segment2, Vec2, Vec3, WallDef, WindowDef, WallType } from '../../core/types.ts';
import {
  add, cross, dist, ensureCCW, norm, perp, polygonCentroid, projectOnSegment, scale, segDir,
  segLength, segPointAt, sub,
} from '../../core/geometry.ts';

export interface RoomFace {
  wallId: string;
  wallType: WallType;
  isExternal: boolean;
  thickness: number;
  /** inside-face segment, oriented so perp(dir) points into the room */
  seg: Segment2;
  length: number;
  /** direction angle of seg (radians) */
  rotation: number;
  /** unit normal pointing into the room */
  inward: Vec2;
}

export interface Span { a: number; b: number }

/** rotation whose inward normal (-sin r, cos r) equals n */
export function rotationForInward(n: Vec2): number {
  return Math.atan2(-n[0], n[1]);
}

export function inwardOf(rotation: number): Vec2 {
  return [-Math.sin(rotation), Math.cos(rotation)];
}

export function centroidOf(room: RoomDef): Vec2 {
  if (room.polygon && room.polygon.length >= 3) return polygonCentroid(room.polygon);
  return [room.rect.x + room.rect.w / 2, room.rect.y + room.rect.h / 2];
}

/**
 * Inside faces of a room. For every CCW polygon edge, find the wall(s) from room.wallIds whose
 * centreline is parallel and offset outward by thickness/2, and clip the edge to the wall span.
 */
export function roomFaces(room: RoomDef, wallById: Map<string, WallDef>, minLength = 0.25): RoomFace[] {
  const poly = ensureCCW(room.polygon && room.polygon.length >= 3
    ? room.polygon
    : [[room.rect.x, room.rect.y], [room.rect.x + room.rect.w, room.rect.y], [room.rect.x + room.rect.w, room.rect.y + room.rect.h], [room.rect.x, room.rect.y + room.rect.h]]);
  const walls: WallDef[] = [];
  for (const id of room.wallIds) {
    const w = wallById.get(id);
    if (w) walls.push(w);
  }
  const faces: RoomFace[] = [];
  for (let i = 0; i < poly.length; i++) {
    const edge: Segment2 = { a: poly[i], b: poly[(i + 1) % poly.length] };
    const eLen = segLength(edge);
    if (eLen < minLength) continue;
    const d = segDir(edge);
    const inward = perp(d);
    let covered = 0;
    for (const w of walls) {
      const wd = norm(sub(w.end, w.start));
      if (Math.abs(cross(d, wd)) > 2e-3) continue;
      const p1 = projectOnSegment(edge, w.start);
      const p2 = projectOnSegment(edge, w.end);
      if (Math.abs(p1.offset - p2.offset) > 0.01) continue;
      // Where the inside face of this wall sits, measured inward from the polygon edge
      const shift = (p1.offset + p2.offset) / 2 + w.thickness / 2;
      if (shift < -0.03 || shift > w.thickness / 2 + 0.03) continue;
      const s1 = Math.max(0, Math.min(p1.along, p2.along));
      const s2 = Math.min(eLen, Math.max(p1.along, p2.along));
      if (s2 - s1 < minLength) continue;
      const off = Math.max(0, shift);
      const seg: Segment2 = {
        a: add(segPointAt(edge, s1), scale(inward, off)),
        b: add(segPointAt(edge, s2), scale(inward, off)),
      };
      faces.push({
        wallId: w.id,
        wallType: w.type,
        isExternal: w.isExternal,
        thickness: w.thickness,
        seg,
        length: s2 - s1,
        rotation: Math.atan2(d[1], d[0]),
        inward,
      });
      covered += s2 - s1;
    }
    if (covered < minLength) {
      // No wall matched (open edge / cased opening): still usable as a face, with no wallId.
      faces.push({
        wallId: '',
        wallType: 'partition',
        isExternal: false,
        thickness: 0.1,
        seg: edge,
        length: eLen,
        rotation: Math.atan2(d[1], d[0]),
        inward,
      });
    }
  }
  return faces;
}

/** Point on a wall centreline at `along` from its start */
export function wallPointAt(wall: WallDef, along: number): Vec2 {
  return segPointAt({ a: wall.start, b: wall.end }, along);
}

/** Map an opening on a wall onto a face of that wall; returns null when it misses the face */
export function openingSpan(face: RoomFace, wall: WallDef, along: number, width: number, pad = 0.05): Span | null {
  const c = wallPointAt(wall, along);
  const p = projectOnSegment(face.seg, c);
  const a = p.along - width / 2 - pad;
  const b = p.along + width / 2 + pad;
  if (b <= 0 || a >= face.length) return null;
  return { a, b };
}

/** Spans blocked for a receptacle: doors always, low-sill glazing below the outlet height */
export function blockedSpans(
  face: RoomFace,
  doors: DoorDef[],
  windows: WindowDef[],
  wallById: Map<string, WallDef>,
  maxSill = 0.45,
): Span[] {
  if (!face.wallId) return [];
  const wall = wallById.get(face.wallId);
  if (!wall) return [];
  const out: Span[] = [];
  for (const d of doors) {
    const s = openingSpan(face, wall, d.along, d.width);
    if (s) out.push(s);
  }
  for (const w of windows) {
    if (w.sill > maxSill) continue;
    const s = openingSpan(face, wall, w.along, w.width);
    if (s) out.push(s);
  }
  return mergeSpans(out);
}

export function mergeSpans(spans: Span[]): Span[] {
  if (spans.length < 2) return spans;
  const s = [...spans].sort((a, b) => a.a - b.a);
  const out: Span[] = [s[0]];
  for (let i = 1; i < s.length; i++) {
    const last = out[out.length - 1];
    if (s[i].a <= last.b) last.b = Math.max(last.b, s[i].b);
    else out.push({ ...s[i] });
  }
  return out;
}

/** Complement of `blocked` inside [0, length], dropping pieces shorter than minLength */
export function freeSpans(length: number, blocked: Span[], minLength = 0.6): Span[] {
  const out: Span[] = [];
  let cursor = 0;
  for (const b of mergeSpans(blocked)) {
    if (b.a - cursor >= minLength) out.push({ a: cursor, b: b.a });
    cursor = Math.max(cursor, b.b);
  }
  if (length - cursor >= minLength) out.push({ a: cursor, b: length });
  return out;
}

/**
 * NEC 210.52(A): outlets so that no point of the wall space is farther than `reach` from one.
 * Returns evenly spread positions within [0, L] satisfying first/last ≤ reach and gap ≤ 2·reach.
 */
export function spacedPositions(L: number, maxSpacing: number): number[] {
  if (L <= 0) return [];
  const n = L <= maxSpacing ? 1 : Math.ceil((L - maxSpacing) / maxSpacing) + 1;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((L * (2 * i + 1)) / (2 * n));
  return out;
}

/** Positions every `spacing` along a length, centred (used for corridors, paths, counters) */
export function runPositions(L: number, spacing: number, min = 1): number[] {
  if (L <= 0) return [];
  const n = Math.max(min, Math.ceil(L / spacing));
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((L * (2 * i + 1)) / (2 * n));
  return out;
}

export function anchorOnFace(face: RoomFace, along: number, z: number): Vec3 {
  const p = segPointAt(face.seg, Math.max(0, Math.min(face.length, along)));
  return [p[0], p[1], z];
}

/**
 * The face nearest a point, preferring faces at least `minLength` long. The result is kept
 * `margin` clear of both ends of the face so a device never lands in a corner.
 */
export function nearestFace(faces: RoomFace[], p: Vec2, minLength = 0.4, margin = 0.15): { face: RoomFace; along: number } | null {
  let best: { face: RoomFace; along: number; dd: number } | null = null;
  for (const f of faces) {
    if (f.length < minLength) continue;
    const m = Math.min(margin, f.length / 3);
    const pr = projectOnSegment(f.seg, p);
    const along = Math.max(m, Math.min(f.length - m, pr.along));
    const q = segPointAt(f.seg, along);
    const dd = dist(q, p);
    if (!best || dd < best.dd) best = { face: f, along, dd };
  }
  return best ? { face: best.face, along: best.along } : null;
}

/** The longest free span across all faces matching a filter */
export function bestFreeSpan(
  faces: RoomFace[],
  blockedFor: (f: RoomFace) => Span[],
  need: number,
  prefer?: (f: RoomFace) => number,
): { face: RoomFace; span: Span } | null {
  let best: { face: RoomFace; span: Span; score: number } | null = null;
  for (const f of faces) {
    for (const s of freeSpans(f.length, blockedFor(f), need)) {
      const score = (s.b - s.a) + (prefer ? prefer(f) : 0);
      if (!best || score > best.score) best = { face: f, span: s, score };
    }
  }
  return best ? { face: best.face, span: best.span } : null;
}

// ----------------------------------------------------------------------------
// Ceiling grids
// ----------------------------------------------------------------------------

/** n points on a grid inside a rect, inset from the walls; row-major from the min corner */
export function ceilingGrid(r: Rect, n: number, inset = 0.6): { points: Vec2[]; cols: number; rows: number; spacing: number } {
  const count = Math.max(1, Math.round(n));
  const ins = Math.min(inset, r.w / 4, r.h / 4);
  const w = Math.max(0.1, r.w - 2 * ins);
  const h = Math.max(0.1, r.h - 2 * ins);
  let cols = Math.max(1, Math.min(count, Math.round(Math.sqrt((count * w) / h))));
  let rows = Math.ceil(count / cols);
  while (cols * rows - rows >= count && cols > 1) cols--;
  rows = Math.ceil(count / cols);
  const points: Vec2[] = [];
  for (let j = 0; j < rows && points.length < count; j++) {
    for (let i = 0; i < cols && points.length < count; i++) {
      points.push([
        r.x + ins + (cols === 1 ? w / 2 : (w * (2 * i + 1)) / (2 * cols)),
        r.y + ins + (rows === 1 ? h / 2 : (h * (2 * j + 1)) / (2 * rows)),
      ]);
    }
  }
  const spacing = Math.max(w / cols, h / rows);
  return { points, cols, rows, spacing };
}

/** Points every `spacing` along the long axis of a rect, on its centreline */
export function alongLongAxis(r: Rect, spacing: number, min = 1): Vec2[] {
  const horizontal = r.w >= r.h;
  const L = horizontal ? r.w : r.h;
  return runPositions(L, spacing, min).map(t => (horizontal
    ? [r.x + t, r.y + r.h / 2] as Vec2
    : [r.x + r.w / 2, r.y + t] as Vec2));
}

/** Points every `spacing` along a polyline of segments */
export function alongPolyline(segs: Segment2[], spacing: number, min = 1): { p: Vec2; t: number }[] {
  const lengths = segs.map(segLength);
  const total = lengths.reduce((a, b) => a + b, 0);
  const out: { p: Vec2; t: number }[] = [];
  for (const t of runPositions(total, spacing, min)) {
    let rest = t;
    for (let i = 0; i < segs.length; i++) {
      if (rest <= lengths[i] || i === segs.length - 1) {
        out.push({ p: segPointAt(segs[i], Math.max(0, Math.min(lengths[i], rest))), t });
        break;
      }
      rest -= lengths[i];
    }
  }
  return out;
}

export function polylineLength(pts: Vec3[]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]);
  return L;
}

/** Closest point (and its index) on a Vec3 polyline to an XY point */
export function closestOnPolyline(pts: Vec3[], p: Vec2): Vec3 {
  let best: Vec3 = pts[0] ?? [p[0], p[1], 0];
  let bestD = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const a: Vec2 = [pts[i - 1][0], pts[i - 1][1]];
    const b: Vec2 = [pts[i][0], pts[i][1]];
    const seg: Segment2 = { a, b };
    const L = segLength(seg);
    if (L < 1e-6) continue;
    const pr = projectOnSegment(seg, p);
    const t = Math.max(0, Math.min(L, pr.along));
    const q = segPointAt(seg, t);
    const dd = dist(q, p);
    if (dd < bestD) {
      bestD = dd;
      best = [q[0], q[1], pts[i][2]];
    }
  }
  return best;
}

// ----------------------------------------------------------------------------
// Furniture
// ----------------------------------------------------------------------------

/** World corners of a furniture footprint (position = min corner before rotation about it) */
export function furnitureQuad(f: FurnitureDef): [Vec2, Vec2, Vec2, Vec2] {
  const r = f.rotation ?? 0;
  const ex: Vec2 = [Math.cos(r) * f.width, Math.sin(r) * f.width];
  const ey: Vec2 = [-Math.sin(r) * f.depth, Math.cos(r) * f.depth];
  const p0: Vec2 = [f.position[0], f.position[1]];
  return [p0, add(p0, ex), add(add(p0, ex), ey), add(p0, ey)];
}

export function furnitureCenter(f: FurnitureDef): Vec2 {
  const q = furnitureQuad(f);
  return [(q[0][0] + q[2][0]) / 2, (q[0][1] + q[2][1]) / 2];
}

/**
 * The long edge of a furniture footprint that faces AWAY from `from` — i.e. the back of a
 * counter/vanity, the side that is against the wall.
 */
export function backEdge(f: FurnitureDef, from: Vec2): Segment2 {
  const [p0, p1, p2, p3] = furnitureQuad(f);
  const long = f.width >= f.depth;
  const e1: Segment2 = long ? { a: p0, b: p1 } : { a: p0, b: p3 };
  const e2: Segment2 = long ? { a: p3, b: p2 } : { a: p1, b: p2 };
  const m1 = scale(add(e1.a, e1.b), 0.5);
  const m2 = scale(add(e2.a, e2.b), 0.5);
  return dist(m1, from) >= dist(m2, from) ? e1 : e2;
}

/** Longest dimension of a furniture item in plan */
export function furnitureRun(f: FurnitureDef): number {
  return Math.max(f.width, f.depth);
}
