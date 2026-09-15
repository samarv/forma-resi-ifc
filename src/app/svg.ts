/**
 * SVG path builders. Every function takes WORLD coordinates (metres, +Y from the
 * street into the site) and emits DRAWING coordinates with Y negated, so that +Y
 * points UP the screen when the group is rendered without a flip transform.
 * Pure — unit-tested in svg.test.ts.
 */
import type { Rect, Vec2 } from '../core/types.ts';
import { n3 } from './util.ts';

export function polyPath(pts: readonly Vec2[], close = true): string {
  if (!pts.length) return '';
  let d = `M${n3(pts[0][0])} ${n3(-pts[0][1])}`;
  for (let i = 1; i < pts.length; i++) d += `L${n3(pts[i][0])} ${n3(-pts[i][1])}`;
  return close ? `${d}Z` : d;
}

export function rectPath(r: Rect): string {
  return polyPath([[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]]);
}

export function linePath(a: Vec2, b: Vec2): string {
  return `M${n3(a[0])} ${n3(-a[1])}L${n3(b[0])} ${n3(-b[1])}`;
}

/** Filled quad for a wall drawn along its centreline with `t` total thickness. */
export function wallQuad(a: Vec2, b: Vec2, t: number): Vec2[] {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l = Math.hypot(dx, dy) || 1;
  const nx = (-dy / l) * (t / 2), ny = (dx / l) * (t / 2);
  return [
    [a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny],
    [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny],
  ];
}

export function wallPath(a: Vec2, b: Vec2, t: number): string {
  return polyPath(wallQuad(a, b, t));
}

/** Rotated box footprint (rotation about the min corner, radians CCW). */
export function boxQuad(x: number, y: number, w: number, d: number, rot = 0): Vec2[] {
  const c = Math.cos(rot), s = Math.sin(rot);
  const p = (dx: number, dy: number): Vec2 => [x + dx * c - dy * s, y + dx * s + dy * c];
  return [p(0, 0), p(w, 0), p(w, d), p(0, d)];
}

/** Circle in drawing space. */
export function circlePath(cx: number, cy: number, r: number): string {
  return `M${n3(cx - r)} ${n3(-cy)}a${n3(r)} ${n3(r)} 0 1 0 ${n3(2 * r)} 0a${n3(r)} ${n3(r)} 0 1 0 ${n3(-2 * r)} 0`;
}

/** Arc for a door swing: centre (cx,cy), radius r, from angle a0 to a1 (world radians). */
export function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
  const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
  const large = Math.abs(a1 - a0) > Math.PI ? 1 : 0;
  // Y is negated, so the sweep flag flips relative to world orientation.
  const sweep = a1 > a0 ? 0 : 1;
  return `M${n3(x0)} ${n3(-y0)}A${n3(r)} ${n3(r)} 0 ${large} ${sweep} ${n3(x1)} ${n3(-y1)}`;
}

export function crossPath(cx: number, cy: number, r: number): string {
  return `M${n3(cx - r)} ${n3(-cy)}L${n3(cx + r)} ${n3(-cy)}M${n3(cx)} ${n3(-cy - r)}L${n3(cx)} ${n3(-cy + r)}`;
}

export function starPath(cx: number, cy: number, r: number): string {
  let d = '';
  for (let i = 0; i < 3; i++) {
    const a = (i * Math.PI) / 3;
    d += `M${n3(cx - r * Math.cos(a))} ${n3(-(cy - r * Math.sin(a)))}L${n3(cx + r * Math.cos(a))} ${n3(-(cy + r * Math.sin(a)))}`;
  }
  return d;
}

export function polylinePath(pts: readonly (readonly [number, number, number] | Vec2)[]): string {
  return polyPath(pts.map((p) => [p[0], p[1]] as Vec2), false);
}

export function bboxOf(pts: readonly Vec2[]): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    if (p[0] < x0) x0 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[0] > x1) x1 = p[0];
    if (p[1] > y1) y1 = p[1];
  }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, w: 1, h: 1 };
  return { x: x0, y: y0, w: Math.max(x1 - x0, 1e-6), h: Math.max(y1 - y0, 1e-6) };
}

export function padRect(r: Rect, pad: number): Rect {
  return { x: r.x - pad, y: r.y - pad, w: r.w + 2 * pad, h: r.h + 2 * pad };
}

export function unionRect(a: Rect | null, b: Rect): Rect {
  if (!a) return { ...b };
  const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w), y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function text(x: number, y: number, s: string, opts: {
  size?: number; fill?: string; anchor?: 'start' | 'middle' | 'end'; weight?: number; opacity?: number;
} = {}): string {
  const { size = 0.5, fill = 'var(--dwg-label)', anchor = 'middle', weight = 400, opacity } = opts;
  return `<text x="${n3(x)}" y="${n3(-y)}" font-size="${n3(size)}" fill="${fill}" text-anchor="${anchor}"`
    + (weight !== 400 ? ` font-weight="${weight}"` : '')
    + (opacity !== undefined ? ` opacity="${opacity}"` : '')
    + `>${escSvg(s)}</text>`;
}

export function escSvg(v: unknown): string {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** One <path> per layer/colour — the batching that keeps a 20-storey plan under 100 ms. */
export function pathEl(d: string, attrs: Record<string, string | number | undefined>): string {
  if (!d) return '';
  let s = `<path d="${d}"`;
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== '') s += ` ${k}="${v}"`;
  return `${s}/>`;
}

/** Diagonal hatch pattern definition (used for cores, shafts, corridors). */
export function hatchDefs(): string {
  return `<defs>
<pattern id="hx" width="0.5" height="0.5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
<line x1="0" y1="0" x2="0" y2="0.5" stroke="var(--dwg-hatch)" stroke-width="0.055"/>
</pattern>
<pattern id="hx2" width="0.34" height="0.34" patternUnits="userSpaceOnUse" patternTransform="rotate(135)">
<line x1="0" y1="0" x2="0" y2="0.34" stroke="var(--dwg-hatch)" stroke-width="0.045"/>
</pattern>
<marker id="arw" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
<path d="M0 0L10 5L0 10z" fill="var(--dwg-site)"/>
</marker>
</defs>`;
}
