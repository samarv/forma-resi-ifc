/**
 * 2D geometry helpers shared by all disciplines. Pure functions, metres.
 * Rectilinear-first: most residential plans are rectangles and unions of rectangles.
 */
import type { Vec2, Vec3, Rect, Polygon, Segment2, Side, Compass } from './types.ts';

export const EPS = 1e-6;

export function round(v: number, decimals = 3): number {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}

export function approxEq(a: number, b: number, eps = EPS): boolean {
  return Math.abs(a - b) <= eps;
}

// ----------------------------------------------------------------------------
// Vectors
// ----------------------------------------------------------------------------

export function add(a: Vec2, b: Vec2): Vec2 { return [a[0] + b[0], a[1] + b[1]]; }
export function sub(a: Vec2, b: Vec2): Vec2 { return [a[0] - b[0], a[1] - b[1]]; }
export function scale(a: Vec2, s: number): Vec2 { return [a[0] * s, a[1] * s]; }
export function len(a: Vec2): number { return Math.hypot(a[0], a[1]); }
export function dist(a: Vec2, b: Vec2): number { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
export function norm(a: Vec2): Vec2 { const l = len(a); return l < EPS ? [0, 0] : [a[0] / l, a[1] / l]; }
export function perp(a: Vec2): Vec2 { return [-a[1], a[0]]; }
export function dot(a: Vec2, b: Vec2): number { return a[0] * b[0] + a[1] * b[1]; }
export function cross(a: Vec2, b: Vec2): number { return a[0] * b[1] - a[1] * b[0]; }
export function lerp(a: Vec2, b: Vec2, t: number): Vec2 { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; }
export function midpoint(a: Vec2, b: Vec2): Vec2 { return lerp(a, b, 0.5); }
export function angleOf(a: Vec2): number { return Math.atan2(a[1], a[0]); }
export function fromAngle(rad: number, length = 1): Vec2 { return [Math.cos(rad) * length, Math.sin(rad) * length]; }
export function rotate(p: Vec2, rad: number, origin: Vec2 = [0, 0]): Vec2 {
  const c = Math.cos(rad), s = Math.sin(rad);
  const x = p[0] - origin[0], y = p[1] - origin[1];
  return [origin[0] + x * c - y * s, origin[1] + x * s + y * c];
}
export function to3(p: Vec2, z = 0): Vec3 { return [p[0], p[1], z]; }
export function to2(p: Vec3): Vec2 { return [p[0], p[1]]; }

// ----------------------------------------------------------------------------
// Rect
// ----------------------------------------------------------------------------

export function rect(x: number, y: number, w: number, h: number): Rect { return { x, y, w, h }; }
export function rectFromCorners(a: Vec2, b: Vec2): Rect {
  const x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]);
  return { x, y, w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]) };
}
export function rectArea(r: Rect): number { return r.w * r.h; }
export function rectCenter(r: Rect): Vec2 { return [r.x + r.w / 2, r.y + r.h / 2]; }
export function rectMax(r: Rect): Vec2 { return [r.x + r.w, r.y + r.h]; }
export function rectMin(r: Rect): Vec2 { return [r.x, r.y]; }
/** CCW polygon of a rect */
export function rectToPolygon(r: Rect): Polygon {
  return [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]];
}
/** Shrink (positive) or grow (negative) a rect on all sides */
export function inset(r: Rect, d: number): Rect {
  return { x: r.x + d, y: r.y + d, w: Math.max(0, r.w - 2 * d), h: Math.max(0, r.h - 2 * d) };
}
/** Shrink a rect by different amounts per side */
export function insetSides(r: Rect, s: Partial<Record<Side, number>>): Rect {
  const l = s.left ?? 0, ri = s.right ?? 0, f = s.front ?? 0, re = s.rear ?? 0;
  return { x: r.x + l, y: r.y + f, w: Math.max(0, r.w - l - ri), h: Math.max(0, r.h - f - re) };
}
export function rectContainsPoint(r: Rect, p: Vec2, eps = EPS): boolean {
  return p[0] >= r.x - eps && p[0] <= r.x + r.w + eps && p[1] >= r.y - eps && p[1] <= r.y + r.h + eps;
}
export function rectContainsRect(outer: Rect, inner: Rect, eps = EPS): boolean {
  return inner.x >= outer.x - eps && inner.y >= outer.y - eps
    && inner.x + inner.w <= outer.x + outer.w + eps && inner.y + inner.h <= outer.y + outer.h + eps;
}
export function rectsOverlap(a: Rect, b: Rect, eps = EPS): boolean {
  return a.x < b.x + b.w - eps && b.x < a.x + a.w - eps && a.y < b.y + b.h - eps && b.y < a.y + a.h - eps;
}
export function rectIntersection(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  if (x2 - x <= EPS || y2 - y <= EPS) return null;
  return { x, y, w: x2 - x, h: y2 - y };
}
export function rectUnionBounds(rects: Rect[]): Rect {
  if (rects.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const r of rects) {
    x1 = Math.min(x1, r.x); y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.w); y2 = Math.max(y2, r.y + r.h);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}
/** Split a rect along X (vertical cut) at distance d from its left edge */
export function splitX(r: Rect, d: number): [Rect, Rect] {
  return [{ x: r.x, y: r.y, w: d, h: r.h }, { x: r.x + d, y: r.y, w: r.w - d, h: r.h }];
}
/** Split a rect along Y (horizontal cut) at distance d from its front (min y) edge */
export function splitY(r: Rect, d: number): [Rect, Rect] {
  return [{ x: r.x, y: r.y, w: r.w, h: d }, { x: r.x, y: r.y + d, w: r.w, h: r.h - d }];
}
/** Divide a rect into n equal strips along X */
export function stripsX(r: Rect, n: number): Rect[] {
  const w = r.w / n;
  return Array.from({ length: n }, (_, i) => ({ x: r.x + i * w, y: r.y, w, h: r.h }));
}
/** Divide a rect along X by explicit widths (last strip absorbs rounding) */
export function stripsXByWidths(r: Rect, widths: number[]): Rect[] {
  const out: Rect[] = [];
  let x = r.x;
  for (let i = 0; i < widths.length; i++) {
    const w = i === widths.length - 1 ? r.x + r.w - x : widths[i];
    out.push({ x, y: r.y, w, h: r.h });
    x += w;
  }
  return out;
}
export function stripsYByHeights(r: Rect, heights: number[]): Rect[] {
  const out: Rect[] = [];
  let y = r.y;
  for (let i = 0; i < heights.length; i++) {
    const h = i === heights.length - 1 ? r.y + r.h - y : heights[i];
    out.push({ x: r.x, y, w: r.w, h });
    y += h;
  }
  return out;
}
/** The four edges of a rect as segments, keyed by side (front = min y edge) */
export function rectEdges(r: Rect): Record<Side, Segment2> {
  const [x1, y1] = [r.x, r.y];
  const [x2, y2] = [r.x + r.w, r.y + r.h];
  return {
    front: { a: [x1, y1], b: [x2, y1] },
    right: { a: [x2, y1], b: [x2, y2] },
    rear: { a: [x2, y2], b: [x1, y2] },
    left: { a: [x1, y2], b: [x1, y1] },
  };
}
export function oppositeSide(s: Side): Side {
  return s === 'front' ? 'rear' : s === 'rear' ? 'front' : s === 'left' ? 'right' : 'left';
}
/** Outward unit normal of a rect side */
export function sideNormal(s: Side): Vec2 {
  return s === 'front' ? [0, -1] : s === 'rear' ? [0, 1] : s === 'left' ? [-1, 0] : [1, 0];
}

// ----------------------------------------------------------------------------
// Polygon
// ----------------------------------------------------------------------------

/** Signed area (positive = CCW) */
export function signedArea(poly: Polygon): number {
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}
export function polygonArea(poly: Polygon): number { return Math.abs(signedArea(poly)); }
export function ensureCCW(poly: Polygon): Polygon { return signedArea(poly) < 0 ? [...poly].reverse() : poly; }
export function polygonCentroid(poly: Polygon): Vec2 {
  const a = signedArea(poly);
  if (Math.abs(a) < EPS) {
    const n = poly.length;
    return [poly.reduce((s, p) => s + p[0], 0) / n, poly.reduce((s, p) => s + p[1], 0) / n];
  }
  let cx = 0, cy = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    const f = p[0] * q[1] - q[0] * p[1];
    cx += (p[0] + q[0]) * f;
    cy += (p[1] + q[1]) * f;
  }
  return [cx / (6 * a), cy / (6 * a)];
}
export function polygonBounds(poly: Polygon): Rect {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const [x, y] of poly) {
    x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}
export function polygonPerimeter(poly: Polygon): number {
  let p = 0;
  for (let i = 0, n = poly.length; i < n; i++) p += dist(poly[i], poly[(i + 1) % n]);
  return p;
}
export function polygonEdges(poly: Polygon): Segment2[] {
  return poly.map((p, i) => ({ a: p, b: poly[(i + 1) % poly.length] }));
}
export function translatePolygon(poly: Polygon, d: Vec2): Polygon { return poly.map(p => add(p, d)); }
/** Express polygon points relative to an origin (for 'prism'/'slab' element profiles) */
export function relativeTo(poly: Polygon, origin: Vec2): Polygon { return poly.map(p => sub(p, origin)); }
export function pointInPolygon(p: Vec2, poly: Polygon): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    const intersect = ((yi > p[1]) !== (yj > p[1])) && (p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}
/** Inward (positive d) / outward (negative d) offset of a CONVEX or rectilinear polygon by moving each edge along its inward normal */
export function offsetPolygon(poly: Polygon, d: number): Polygon {
  const ccw = ensureCCW(poly);
  const n = ccw.length;
  const lines: { p: Vec2; dir: Vec2 }[] = [];
  for (let i = 0; i < n; i++) {
    const a = ccw[i], b = ccw[(i + 1) % n];
    const dir = norm(sub(b, a));
    // inward normal for CCW polygon is left of direction: (-dy, dx)
    const nrm: Vec2 = [-dir[1], dir[0]];
    lines.push({ p: add(a, scale(nrm, d)), dir });
  }
  const out: Polygon = [];
  for (let i = 0; i < n; i++) {
    const l1 = lines[(i - 1 + n) % n], l2 = lines[i];
    const x = lineIntersection(l1.p, l1.dir, l2.p, l2.dir);
    out.push(x ?? ccw[i]);
  }
  return out;
}
/** Intersection of two infinite lines given by point + direction */
export function lineIntersection(p1: Vec2, d1: Vec2, p2: Vec2, d2: Vec2): Vec2 | null {
  const den = cross(d1, d2);
  if (Math.abs(den) < EPS) return null;
  const t = cross(sub(p2, p1), d2) / den;
  return add(p1, scale(d1, t));
}
/** Union outline of a set of axis-aligned rects that form a rectilinear shape (e.g. L/U/O bars). Returns CCW outline; holes ignored. */
export function rectilinearOutline(rects: Rect[]): Polygon {
  if (rects.length === 1) return rectToPolygon(rects[0]);
  // Collect unique x and y cuts, build occupancy grid, trace boundary edges
  const xs = Array.from(new Set(rects.flatMap(r => [round(r.x, 6), round(r.x + r.w, 6)]))).sort((a, b) => a - b);
  const ys = Array.from(new Set(rects.flatMap(r => [round(r.y, 6), round(r.y + r.h, 6)]))).sort((a, b) => a - b);
  const filled = (i: number, j: number): boolean => {
    if (i < 0 || j < 0 || i >= xs.length - 1 || j >= ys.length - 1) return false;
    const cx = (xs[i] + xs[i + 1]) / 2, cy = (ys[j] + ys[j + 1]) / 2;
    return rects.some(r => rectContainsPoint(r, [cx, cy]));
  };
  // Boundary edges as directed segments keeping the filled cell on the left (CCW overall)
  const edges = new Map<string, Vec2>();
  const key = (p: Vec2): string => `${round(p[0], 6)},${round(p[1], 6)}`;
  for (let i = 0; i < xs.length - 1; i++) {
    for (let j = 0; j < ys.length - 1; j++) {
      if (!filled(i, j)) continue;
      const x1 = xs[i], x2 = xs[i + 1], y1 = ys[j], y2 = ys[j + 1];
      if (!filled(i, j - 1)) edges.set(key([x1, y1]), [x2, y1]); // bottom edge, going +x
      if (!filled(i + 1, j)) edges.set(key([x2, y1]), [x2, y2]); // right edge, going +y
      if (!filled(i, j + 1)) edges.set(key([x2, y2]), [x1, y2]); // top edge, going -x
      if (!filled(i - 1, j)) edges.set(key([x1, y2]), [x1, y1]); // left edge, going -y
    }
  }
  if (edges.size === 0) return [];
  // Trace from the lowest-left vertex
  let start: Vec2 | null = null;
  for (const k of edges.keys()) {
    const [x, y] = k.split(',').map(Number) as Vec2;
    if (!start || y < start[1] - EPS || (approxEq(y, start[1]) && x < start[0])) start = [x, y];
  }
  const out: Polygon = [];
  let cur = start as Vec2;
  for (let guard = 0; guard < edges.size + 1; guard++) {
    out.push(cur);
    const next = edges.get(key(cur));
    if (!next) break;
    if (approxEq(next[0], start![0]) && approxEq(next[1], start![1])) break;
    cur = next;
  }
  // Merge collinear points
  return simplifyCollinear(out);
}
export function simplifyCollinear(poly: Polygon): Polygon {
  const n = poly.length;
  if (n < 4) return poly;
  const out: Polygon = [];
  for (let i = 0; i < n; i++) {
    const p = poly[(i - 1 + n) % n], c = poly[i], q = poly[(i + 1) % n];
    if (Math.abs(cross(sub(c, p), sub(q, c))) > EPS) out.push(c);
  }
  return out;
}

// ----------------------------------------------------------------------------
// Segments and walls
// ----------------------------------------------------------------------------

export function segLength(s: Segment2): number { return dist(s.a, s.b); }
export function segDir(s: Segment2): Vec2 { return norm(sub(s.b, s.a)); }
export function segPointAt(s: Segment2, along: number): Vec2 { return add(s.a, scale(segDir(s), along)); }
/** Project point onto segment; returns distance along and perpendicular distance */
export function projectOnSegment(s: Segment2, p: Vec2): { along: number; offset: number; clamped: number } {
  const d = segDir(s);
  const v = sub(p, s.a);
  const along = dot(v, d);
  const offset = cross(d, v);
  return { along, offset, clamped: Math.max(0, Math.min(segLength(s), along)) };
}
export function segmentsCollinearOverlap(a: Segment2, b: Segment2, eps = 1e-4): Segment2 | null {
  const da = segDir(a);
  if (Math.abs(cross(da, segDir(b))) > eps) return null;
  const pb = projectOnSegment(a, b.a);
  if (Math.abs(pb.offset) > eps) return null;
  const t1 = Math.min(projectOnSegment(a, b.a).along, projectOnSegment(a, b.b).along);
  const t2 = Math.max(projectOnSegment(a, b.a).along, projectOnSegment(a, b.b).along);
  const s1 = Math.max(0, t1), s2 = Math.min(segLength(a), t2);
  if (s2 - s1 <= eps) return null;
  return { a: segPointAt(a, s1), b: segPointAt(a, s2) };
}
export function isAxisAligned(s: Segment2, eps = 1e-6): 'x' | 'y' | null {
  if (Math.abs(s.a[1] - s.b[1]) < eps) return 'x';
  if (Math.abs(s.a[0] - s.b[0]) < eps) return 'y';
  return null;
}

// ----------------------------------------------------------------------------
// Compass / orientation
// ----------------------------------------------------------------------------

const COMPASS_ORDER: Compass[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export function compassToRad(c: Compass): number { return COMPASS_ORDER.indexOf(c) * Math.PI / 4; }
export function radToCompass(rad: number): Compass {
  const idx = Math.round(((rad % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) / (Math.PI / 4)) % 8;
  return COMPASS_ORDER[idx];
}
/**
 * Compass exposure of a wall whose OUTWARD normal in the world frame is `outward` (unit Vec2),
 * given the compass direction the street (the -Y side) faces.
 * World -Y (toward the street) faces `streetFacing`; the world frame is rotated accordingly.
 */
export function exposureOf(outward: Vec2, streetFacing: Compass): Compass {
  // bearing of outward in world frame, clockwise from +Y
  const worldBearing = Math.atan2(outward[0], outward[1]); // 0 = +Y, +90° = +X
  // -Y (bearing 180°) maps to streetFacing bearing
  const streetBearing = compassToRad(streetFacing);
  const bearing = worldBearing - Math.PI + streetBearing;
  return radToCompass(bearing);
}
/** Compass direction that the world +Y axis (rear) points to */
export function rearExposure(streetFacing: Compass): Compass { return exposureOf([0, 1], streetFacing); }
/** Solar quality score 0..1 of an exposure (northern hemisphere unless AU/NZ) */
export function solarScore(c: Compass, southernHemisphere = false): number {
  const scores: Record<Compass, number> = { S: 1, SE: 0.85, SW: 0.85, E: 0.6, W: 0.55, NE: 0.35, NW: 0.3, N: 0.2 };
  if (!southernHemisphere) return scores[c];
  const flip: Record<Compass, Compass> = { N: 'S', NE: 'SE', E: 'E', SE: 'NE', S: 'N', SW: 'NW', W: 'W', NW: 'SW' };
  return scores[flip[c]];
}
