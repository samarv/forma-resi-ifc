/**
 * Bar-local coordinate frame: every organiser works in (ALONG, ACROSS) so the same packing code
 * serves a bar whose long axis is +X and a bar whose long axis is +Y.
 *
 *   axis 'x' → along = X, across = Y, sides: start=left, end=right, low=front, high=rear
 *   axis 'y' → along = Y, across = X, sides: start=front, end=rear, low=left,  high=right
 */
import type { MassingBar, Rect, Side, Vec2 } from '../../core/types.ts';
import { EPS, round } from '../../core/geometry.ts';

export interface BarFrame {
  barId: string;
  axis: 'x' | 'y';
  /** along extent of the bar rect */
  a0: number;
  a1: number;
  /** across extent of the bar rect */
  c0: number;
  c1: number;
  /** side at across = c0 / c1 */
  lowSide: Side;
  highSide: Side;
  /** side at along = a0 / a1 */
  startSide: Side;
  endSide: Side;
  length: number;
  depth: number;
  exteriorSides: Side[];
}

export function barFrame(bar: MassingBar): BarFrame {
  const r = bar.rect;
  if (bar.axis === 'x') {
    return {
      barId: bar.id, axis: 'x',
      a0: r.x, a1: r.x + r.w, c0: r.y, c1: r.y + r.h,
      lowSide: 'front', highSide: 'rear', startSide: 'left', endSide: 'right',
      length: r.w, depth: r.h, exteriorSides: bar.exteriorSides,
    };
  }
  return {
    barId: bar.id, axis: 'y',
    a0: r.y, a1: r.y + r.h, c0: r.x, c1: r.x + r.w,
    lowSide: 'left', highSide: 'right', startSide: 'front', endSide: 'rear',
    length: r.h, depth: r.w, exteriorSides: bar.exteriorSides,
  };
}

/** Frame for an arbitrary rect treated as a bar with the given long axis */
export function frameOfRect(id: string, r: Rect, axis: 'x' | 'y', exteriorSides: Side[]): BarFrame {
  return barFrame({ id, rect: r, axis, depth: axis === 'x' ? r.h : r.w, length: axis === 'x' ? r.w : r.h, exteriorSides });
}

export function rectFromAC(f: BarFrame, a0: number, a1: number, c0: number, c1: number): Rect {
  return f.axis === 'x'
    ? { x: round(a0), y: round(c0), w: round(a1 - a0), h: round(c1 - c0) }
    : { x: round(c0), y: round(a0), w: round(c1 - c0), h: round(a1 - a0) };
}

export function alongRange(f: BarFrame, r: Rect): Interval {
  return f.axis === 'x' ? { s: r.x, e: r.x + r.w } : { s: r.y, e: r.y + r.h };
}

export function acrossRange(f: BarFrame, r: Rect): Interval {
  return f.axis === 'x' ? { s: r.y, e: r.y + r.h } : { s: r.x, e: r.x + r.w };
}

export function alongOf(f: BarFrame, p: Vec2): number {
  return f.axis === 'x' ? p[0] : p[1];
}

export function acrossOf(f: BarFrame, p: Vec2): number {
  return f.axis === 'x' ? p[1] : p[0];
}

/**
 * The (across, along-range) description of one side of a rect, in the terms the envelope index
 * uses: `across` is the constant coordinate of that edge (y for front/rear, x for left/right).
 */
export function sideSpan(r: Rect, side: Side): { across: number; a0: number; a1: number } {
  switch (side) {
    case 'front': return { across: r.y, a0: r.x, a1: r.x + r.w };
    case 'rear': return { across: r.y + r.h, a0: r.x, a1: r.x + r.w };
    case 'left': return { across: r.x, a0: r.y, a1: r.y + r.h };
    default: return { across: r.x + r.w, a0: r.y, a1: r.y + r.h };
  }
}

// ----------------------------------------------------------------------------
// 1D intervals
// ----------------------------------------------------------------------------

export interface Interval { s: number; e: number }

export function ivLen(i: Interval): number { return i.e - i.s; }

export function mergeIntervals(list: Interval[], gap = 0.05): Interval[] {
  const sorted = [...list].filter(i => i.e - i.s > EPS).sort((a, b) => a.s - b.s);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.s <= last.e + gap) last.e = Math.max(last.e, i.e);
    else out.push({ ...i });
  }
  return out;
}

/** base minus the union of `cuts` */
export function subtractIntervals(base: Interval, cuts: Interval[], minLen = 0.1): Interval[] {
  const merged = mergeIntervals(cuts, 0);
  const out: Interval[] = [];
  let x = base.s;
  for (const c of merged) {
    if (c.e <= base.s + EPS || c.s >= base.e - EPS) continue;
    if (c.s > x + minLen) out.push({ s: x, e: Math.min(c.s, base.e) });
    x = Math.max(x, c.e);
  }
  if (base.e > x + minLen) out.push({ s: x, e: base.e });
  return out.filter(i => ivLen(i) >= minLen);
}

/** Largest-remainder apportionment of `total` items over weights, honouring per-slot maxima */
export function apportion(total: number, weights: number[], maxPer?: number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const sum = weights.reduce((a, c) => a + c, 0);
  if (sum <= 0) return weights.map(() => 0);
  const raw = weights.map(w => (total * w) / sum);
  const base = raw.map(v => Math.floor(v));
  let left = total - base.reduce((a, c) => a + c, 0);
  const order = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((p, q) => q.frac - p.frac || p.i - q.i);
  let guard = 0;
  while (left > 0 && guard++ < n * 4) {
    let placed = false;
    for (const o of order) {
      if (left === 0) break;
      if (maxPer && base[o.i] >= maxPer[o.i]) continue;
      base[o.i] += 1;
      left -= 1;
      placed = true;
    }
    if (!placed) break;
  }
  return base;
}
