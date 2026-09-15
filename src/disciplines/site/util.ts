/**
 * Small helpers used only by the site discipline: rect algebra that the shared
 * geometry module does not need (boolean subtraction for "what is left of this yard"),
 * property-set sugar and numeric guards.
 */
import type { Rect, PropertySetDef, RGB, Polygon } from '../../core/types.ts';

export function clampNum(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * `a` minus `b` expressed as up to four axis-aligned bands (bottom, top, left, right).
 * Bands thinner than `minSize` on either axis are dropped, so the result is a set of
 * usable, non-overlapping rects covering a \ b.
 */
export function subtractRect(a: Rect, b: Rect, minSize = 0.6): Rect[] {
  const ax2 = a.x + a.w, ay2 = a.y + a.h;
  const bx1 = Math.max(a.x, b.x), by1 = Math.max(a.y, b.y);
  const bx2 = Math.min(ax2, b.x + b.w), by2 = Math.min(ay2, b.y + b.h);
  if (bx2 <= bx1 || by2 <= by1) return [a]; // no overlap
  const out: Rect[] = [];
  const push = (x: number, y: number, w: number, h: number): void => {
    if (w >= minSize && h >= minSize) out.push({ x, y, w, h });
  };
  push(a.x, a.y, a.w, by1 - a.y);            // band in front of b
  push(a.x, by2, a.w, ay2 - by2);            // band behind b
  push(a.x, by1, bx1 - a.x, by2 - by1);      // band left of b
  push(bx2, by1, ax2 - bx2, by2 - by1);      // band right of b
  return out;
}

/** Subtract many rects from one; result is capped to keep the sweep O(n·k) and bounded. */
export function subtractRects(a: Rect, bs: Rect[], minSize = 0.6, cap = 24): Rect[] {
  let acc: Rect[] = [a];
  for (const b of bs) {
    const next: Rect[] = [];
    for (const r of acc) {
      for (const piece of subtractRect(r, b, minSize)) next.push(piece);
    }
    acc = next.length > cap ? next.sort((p, q) => q.w * q.h - p.w * p.h).slice(0, cap) : next;
    if (acc.length === 0) break;
  }
  return acc;
}

export function pset(name: string, props: Record<string, string | number | boolean>): PropertySetDef {
  return { name, properties: Object.keys(props).map(k => ({ name: k, value: props[k] })) };
}

/** Recursively collect every number in a value — used by geometry validation and tests. */
export function collectNumbers(v: unknown, out: number[] = []): number[] {
  if (typeof v === 'number') out.push(v);
  else if (Array.isArray(v)) { for (const x of v) collectNumbers(x, out); }
  else if (v && typeof v === 'object') {
    for (const k of Object.keys(v as Record<string, unknown>)) collectNumbers((v as Record<string, unknown>)[k], out);
  }
  return out;
}

export function allFinite(v: unknown): boolean {
  return collectNumbers(v).every(n => Number.isFinite(n));
}

/** Regular octagon approximating a circle of radius r, CCW, centred on the origin */
export function octagon(r: number): Polygon {
  const out: Polygon = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    out.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return out;
}

/** Site palette (RGB 0..1) — one place so the 3D view of the site reads consistently. */
export const SITE_COLORS: Record<string, RGB> = {
  terrain: [0.82, 0.76, 0.64],
  lawn: [0.45, 0.66, 0.35],
  planting: [0.33, 0.54, 0.29],
  courtyard: [0.5, 0.69, 0.42],
  privateGarden: [0.48, 0.68, 0.38],
  communalGarden: [0.46, 0.65, 0.36],
  playground: [0.72, 0.6, 0.35],
  bioswale: [0.4, 0.6, 0.55],
  canopy: [0.17, 0.44, 0.2],
  trunk: [0.36, 0.26, 0.16],
  paving: [0.63, 0.63, 0.61],
  driveway: [0.48, 0.48, 0.47],
  stall: [0.72, 0.82, 0.92],
  accessibleStall: [0.55, 0.7, 0.95],
  evStall: [0.6, 0.85, 0.7],
  car: [0.25, 0.25, 0.28],
  bike: [0.3, 0.3, 0.35],
  fence: [0.45, 0.32, 0.2],
  existing: [0.78, 0.78, 0.78],
};
