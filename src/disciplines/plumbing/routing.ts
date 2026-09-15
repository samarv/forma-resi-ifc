/**
 * Manhattan routing primitives — the single place that decides HOW a horizontal plumbing run
 * gets from A to B. Pure functions only (no PlumbState), so `state.ts` can depend on this file.
 *
 * THE RULE (PLB-11 / XD-02): a horizontal pipe is built from axis-parallel legs. Every leg of an
 * emitted run changes exactly ONE of x / y / z:
 *   - horizontal legs run along +-X or +-Y at a constant z,
 *   - a change of height is always its own vertical leg (dx = dy = 0).
 * Diagonals are how a model looks when a route was "drawn" between two points instead of routed,
 * and a polyline that visits many points in id order is how a floor plate ends up with a zig-zag
 * snake across it. Both are prevented here:
 *   - `orthogonalize` turns any path into Manhattan legs (and swallows sub-tolerance jogs so a
 *     rounding artefact never becomes a 3 mm diagonal),
 *   - `splitPath` caps a single run's point count and developed length,
 *   - a `Spine` (corridor lane or bar trunk) gives every riser its own short L-shaped tap instead
 *     of chaining risers into one polyline.
 */
import type { Rect, Segment2, Vec2, Vec3 } from '../../core/types.ts';
import { round, projectOnSegment, segLength, segPointAt } from '../../core/geometry.ts';
import { lanePath } from '../../core/coordination.ts';

/** Maximum points in one emitted PipeRun (a longer polyline is split into several runs) */
export const MAX_RUN_POINTS = 12;
/** A jog smaller than this collapses onto the previous coordinate instead of becoming a diagonal */
export const ORTHO_SNAP = 0.02;
/** How far inside the exterior wall a bar trunk sits */
export const TRUNK_WALL_INSET = 1.0;
/** Drop from the underside of the slab to a trunk on a floor with no corridor */
export const TRUNK_SOFFIT_DROP = 0.35;

// ----------------------------------------------------------------------------
// Polyline helpers
// ----------------------------------------------------------------------------

export function polylineLength(path: Vec3[]): number {
  let l = 0;
  for (let i = 0; i < path.length - 1; i++) {
    l += Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1], path[i + 1][2] - path[i][2]);
  }
  return l;
}

/** True when the segment a→b changes at most one coordinate */
export function isOrthogonal(a: Vec3, b: Vec3, eps = 1e-4): boolean {
  const moves = (Math.abs(b[0] - a[0]) > eps ? 1 : 0)
    + (Math.abs(b[1] - a[1]) > eps ? 1 : 0)
    + (Math.abs(b[2] - a[2]) > eps ? 1 : 0);
  return moves <= 1;
}

/**
 * Rewrite a path so every leg is axis-parallel.
 *
 * 1. points are rounded to the emitted precision FIRST,
 * 2. a per-axis delta below `snap` is collapsed (the point is pulled onto the previous coordinate),
 *    which is what stops a dropped 3 mm jog from turning a vertical leg into a diagonal,
 * 3. a leg that still moves on more than one axis gets corners inserted, in x → y → z order
 *    (horizontal first, height last), so the result is deterministic.
 */
export function orthogonalize(path: Vec3[], snap = ORTHO_SNAP): Vec3[] {
  const out: Vec3[] = [];
  let cur: Vec3 | null = null;
  for (const raw of path) {
    if (!Number.isFinite(raw[0]) || !Number.isFinite(raw[1]) || !Number.isFinite(raw[2])) continue;
    const p: Vec3 = [round(raw[0]), round(raw[1]), round(raw[2])];
    if (!cur) { out.push(p); cur = p; continue; }
    const d: Vec3 = [p[0] - cur[0], p[1] - cur[1], p[2] - cur[2]];
    for (let i = 0; i < 3; i++) {
      if (Math.abs(d[i]) < snap) { p[i] = cur[i]; d[i] = 0; }
    }
    const moves = (d[0] !== 0 ? 1 : 0) + (d[1] !== 0 ? 1 : 0) + (d[2] !== 0 ? 1 : 0);
    if (moves === 0) continue;
    if (moves === 1) { out.push(p); cur = p; continue; }
    if (d[0] !== 0) { const q: Vec3 = [p[0], cur[1], cur[2]]; out.push(q); cur = q; }
    if (d[1] !== 0) { const q: Vec3 = [cur[0], p[1], cur[2]]; out.push(q); cur = q; }
    if (d[2] !== 0) { const q: Vec3 = [cur[0], cur[1], p[2]]; out.push(q); cur = q; }
  }
  return out;
}

/** Break any leg longer than `maxLength` into equal parts, so the run cap can always be met */
export function subdivideLong(path: Vec3[], maxLength: number): Vec3[] {
  if (!(maxLength > 0) || !Number.isFinite(maxLength)) return path;
  const out: Vec3[] = [];
  for (let i = 0; i < path.length; i++) {
    const a = path[i];
    if (i === 0) { out.push(a); continue; }
    const p = path[i - 1];
    const L = Math.hypot(a[0] - p[0], a[1] - p[1], a[2] - p[2]);
    const n = L > maxLength ? Math.ceil(L / maxLength) : 1;
    for (let k = 1; k <= n; k++) {
      out.push([
        round(p[0] + (a[0] - p[0]) * k / n),
        round(p[1] + (a[1] - p[1]) * k / n),
        round(p[2] + (a[2] - p[2]) * k / n),
      ]);
    }
  }
  return out;
}

/**
 * Split a polyline into consecutive chunks, each with at most `maxPoints` points and at most
 * `maxLength` developed length. Chunks share their boundary point, so the pipework stays connected.
 */
export function splitPath(path: Vec3[], maxPoints = MAX_RUN_POINTS, maxLength = Infinity): Vec3[][] {
  if (path.length < 2) return path.length > 0 ? [path] : [];
  const src = subdivideLong(path, maxLength);
  if (src.length <= maxPoints && polylineLength(src) <= maxLength + 1e-9) return [src];
  const out: Vec3[][] = [];
  let cur: Vec3[] = [src[0]];
  let len = 0;
  for (let i = 1; i < src.length; i++) {
    const seg = Math.hypot(src[i][0] - src[i - 1][0], src[i][1] - src[i - 1][1], src[i][2] - src[i - 1][2]);
    if (cur.length >= 2 && (cur.length + 1 > maxPoints || len + seg > maxLength + 1e-9)) {
      out.push(cur);
      cur = [src[i - 1]];
      len = 0;
    }
    cur.push(src[i]);
    len += seg;
  }
  if (cur.length >= 2) out.push(cur);
  else if (out.length > 0 && cur.length === 1) out[out.length - 1].push(cur[0]);
  return out;
}

/** Two-leg (L-shaped) Manhattan connection a → b; `prefer` names the axis travelled first */
export function manhattanLink(a: Vec3, b: Vec3, prefer: 'x' | 'y' = 'x'): Vec3[] {
  const dx = Math.abs(b[0] - a[0]) >= ORTHO_SNAP;
  const dy = Math.abs(b[1] - a[1]) >= ORTHO_SNAP;
  const dz = Math.abs(b[2] - a[2]) >= ORTHO_SNAP;
  const out: Vec3[] = [a];
  if (dx && dy) {
    out.push(prefer === 'x' ? [b[0], a[1], a[2]] : [a[0], b[1], a[2]]);
  }
  if (dx || dy) out.push([b[0], b[1], a[2]]);
  if (dz) out.push([b[0], b[1], b[2]]);
  return out.length > 1 ? out : [a, b];
}

// ----------------------------------------------------------------------------
// Spines: the horizontal route a floor's mains follow
// ----------------------------------------------------------------------------

export interface Spine {
  /** 'lane' = corridor service spine (XD-02); 'trunk' = one line per bar on a floor with no corridor */
  kind: 'lane' | 'trunk';
  /** One Manhattan polyline per corridor / per bar; runs are emitted one per path, never chained */
  paths: Vec3[][];
  z: number;
}

/** A lane per corridor, offset laterally from its centreline (never one polyline across corridors) */
export function laneSpine(corridors: Segment2[][], lateral: number, z: number): Spine | null {
  const paths: Vec3[][] = [];
  for (const centerline of corridors) {
    if (centerline.length === 0) continue;
    const p = orthogonalize(lanePath(centerline, lateral, z));
    if (p.length >= 2) paths.push(p);
  }
  return paths.length > 0 ? { kind: 'lane', paths, z } : null;
}

/** Manhattan distance from a point to a rect (0 inside) */
function rectDistance(r: Rect, p: Vec2): number {
  const dx = Math.max(r.x - p[0], 0, p[0] - (r.x + r.w));
  const dy = Math.max(r.y - p[1], 0, p[1] - (r.y + r.h));
  return dx + dy;
}

function nearestBar(bars: Rect[], p: Vec2): number {
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < bars.length; i++) {
    const d = rectDistance(bars[i], p);
    if (d < bd - 1e-9) { bd = d; best = i; }
  }
  return best;
}

function clamp(v: number, lo: number, hi: number): number {
  return hi < lo ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v));
}

/**
 * One trunk along a bar's long axis, `inset` metres inside the exterior wall on the side nearest
 * the anchors it serves, spanning the anchors' stations (never the whole site).
 */
export function barTrunk(bar: Rect, anchors: Vec2[], z: number, inset = TRUNK_WALL_INSET): Vec3[] {
  const axis: 'x' | 'y' = bar.w >= bar.h ? 'x' : 'y';
  const along = (p: Vec2): number => (axis === 'x' ? p[0] : p[1]);
  const across = (p: Vec2): number => (axis === 'x' ? p[1] : p[0]);
  const aMin = axis === 'x' ? bar.x : bar.y;
  const aLen = axis === 'x' ? bar.w : bar.h;
  const cMin = axis === 'x' ? bar.y : bar.x;
  const cLen = axis === 'x' ? bar.h : bar.w;

  const meanAcross = anchors.reduce((s, p) => s + across(p), 0) / anchors.length;
  const nearLow = meanAcross - cMin <= cMin + cLen - meanAcross;
  const margin = Math.min(0.5, cLen / 4);
  const offset = round(clamp(nearLow ? cMin + inset : cMin + cLen - inset, cMin + margin, cMin + cLen - margin));

  const stations = anchors.map(along);
  const endMargin = Math.min(0.3, aLen / 8);
  let a0 = clamp(Math.min(...stations) - 0.5, aMin + endMargin, aMin + aLen - endMargin);
  let a1 = clamp(Math.max(...stations) + 0.5, aMin + endMargin, aMin + aLen - endMargin);
  if (a1 - a0 < 1.0) {
    const mid = (a0 + a1) / 2;
    a0 = clamp(mid - 0.5, aMin, aMin + aLen);
    a1 = clamp(mid + 0.5, aMin, aMin + aLen);
  }
  return axis === 'x'
    ? [[round(a0), offset, round(z)], [round(a1), offset, round(z)]]
    : [[offset, round(a0), round(z)], [offset, round(a1), round(z)]];
}

/** One trunk per bar that actually has anchors; anchors go to their nearest bar */
export function trunkSpine(bars: Rect[], anchors: Vec2[], z: number, inset = TRUNK_WALL_INSET): Spine | null {
  if (bars.length === 0 || anchors.length === 0) return null;
  const groups: Vec2[][] = bars.map(() => []);
  for (const a of anchors) groups[nearestBar(bars, a)].push(a);
  const paths: Vec3[][] = [];
  for (let i = 0; i < bars.length; i++) {
    if (groups[i].length === 0) continue;
    const t = barTrunk(bars[i], groups[i], z, inset);
    if (Math.hypot(t[1][0] - t[0][0], t[1][1] - t[0][1]) >= ORTHO_SNAP) paths.push(t);
  }
  return paths.length > 0 ? { kind: 'trunk', paths, z } : null;
}

/** The same route at a different height (e.g. the building drain under the cold water main) */
export function spineAt(s: Spine, z: number): Spine {
  return { kind: s.kind, z, paths: s.paths.map(p => p.map(q => [q[0], q[1], round(z)] as Vec3)) };
}

interface Foot {
  pathIndex: number;
  /** Cumulative plan distance from the start of that path */
  station: number;
  point: Vec3;
  /** Axis of the segment the foot landed on */
  axis: 'x' | 'y';
}

function footOn(s: Spine, p: Vec2): Foot | null {
  let best: Foot | null = null;
  let bd = Infinity;
  for (let i = 0; i < s.paths.length; i++) {
    const path = s.paths[i];
    let acc = 0;
    for (let j = 0; j < path.length - 1; j++) {
      const seg: Segment2 = { a: [path[j][0], path[j][1]], b: [path[j + 1][0], path[j + 1][1]] };
      const L = segLength(seg);
      if (L < 1e-9) continue;
      const pr = projectOnSegment(seg, p);
      const q = segPointAt(seg, pr.clamped);
      const d = Math.abs(q[0] - p[0]) + Math.abs(q[1] - p[1]);
      if (d < bd - 1e-9) {
        bd = d;
        best = {
          pathIndex: i,
          station: acc + pr.clamped,
          point: [round(q[0]), round(q[1]), path[j][2]],
          axis: Math.abs(seg.b[1] - seg.a[1]) <= Math.abs(seg.b[0] - seg.a[0]) ? 'x' : 'y',
        };
      }
      acc += L;
    }
  }
  return best;
}

/** Point on the spine that serves `p`, and the station used to order taps along the spine */
export function spineFoot(s: Spine, p: Vec2): Vec3 | null {
  return footOn(s, p)?.point ?? null;
}

export function spineStation(s: Spine, p: Vec2): number {
  const f = footOn(s, p);
  return f ? f.pathIndex * 1e6 + f.station : 0;
}

/**
 * L-shaped tap off the spine to `p`: along the spine's own axis first, then perpendicular, then
 * (optionally) a single vertical leg down/up to `zEnd`. Two horizontal segments at most.
 */
export function spineTap(s: Spine, p: Vec2, z: number, zEnd?: number): Vec3[] {
  const f = footOn(s, p);
  if (!f) return [];
  const a: Vec3 = [f.point[0], f.point[1], round(z)];
  const b: Vec3 = [round(p[0]), round(p[1]), round(zEnd ?? z)];
  return manhattanLink(a, b, f.axis);
}

/** Every path of the spine at height `z` (one emitted run per path) */
export function spinePaths(s: Spine, z = s.z): Vec3[][] {
  return s.paths.map(p => p.map(q => [q[0], q[1], round(z)] as Vec3));
}

/**
 * Buried lateral leaving the building perpendicular to the street: along the spine to the exit
 * station, a vertical leg to the lateral invert, then straight out to `streetY`.
 */
export function streetLateral(s: Spine, target: Vec2, z: number, lateralZ: number, streetY: number): Vec3[] {
  const f = footOn(s, target);
  if (!f) return [];
  const out: Vec3[] = [[f.point[0], f.point[1], round(z)]];
  if (Math.abs(lateralZ - z) >= ORTHO_SNAP) out.push([f.point[0], f.point[1], round(lateralZ)]);
  out.push([f.point[0], round(streetY), round(lateralZ)]);
  return out;
}
