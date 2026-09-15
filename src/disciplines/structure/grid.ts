/**
 * Structural grid construction — patterns STR-02 (Grid on Party Walls, a specialisation of
 * XD-03), STR-03 (Columns Hide in Walls) and STR-09 (Economic Span).
 *
 * GRID LINE CONVENTION
 *   axis: 'x'  →  `offset` is an X coordinate; the line runs parallel to +Y. Labelled A, B, C…
 *   axis: 'y'  →  `offset` is a Y coordinate; the line runs parallel to +X. Labelled 1, 2, 3…
 *   Letters skip I and O, as in structural drafting practice. A column's `gridRef` is 'C-3'.
 */
import type { CoreDef, FootprintShape, GridLine, Polygon, Rect, Vec2, WallDef, WallType } from '../../core/types.ts';
import { EPS, polygonBounds, round } from '../../core/geometry.ts';
import { GRID_RULES, TRANSFER } from './sizing.ts';

/** Grid letters used along +X. I and O are skipped so they cannot be read as 1 and 0. */
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

export function letterLabel(i: number): string {
  let s = '';
  let n = i;
  do {
    s = LETTERS[n % LETTERS.length] + s;
    n = Math.floor(n / LETTERS.length) - 1;
  } while (n >= 0);
  return s;
}

/** An axis-aligned wall centreline reduced to the data STR-03 needs for snapping */
export interface SnapWall {
  /** 'x' = line of constant x (wall runs along +Y); 'y' = line of constant y (wall runs along +X) */
  constAxis: 'x' | 'y';
  at: number;
  lo: number;
  hi: number;
  type: WallType;
  thickness: number;
}

export interface GridPlan {
  lines: GridLine[];
  /** Main (residential / typical floor) grid offsets, sorted */
  mainX: number[];
  mainY: number[];
  /** Parking-module offsets used on podium and basement parking storeys, sorted */
  parkX: number[];
  parkY: number[];
  longAxis: 'x' | 'y';
  /** Offsets of the corridor lines and the axis they are measured on */
  corridorAxis: 'x' | 'y';
  corridorOffsets: number[];
  /** Mean bay dimension (m) of the main grid */
  avgSpacingX: number;
  avgSpacingY: number;
  label(axis: 'x' | 'y', offset: number): string;
  ref(x: number, y: number): string;
}

export interface BuildGridOptions {
  /** Outline of the typical (residential) floor plate */
  typicalOutline: Polygon;
  /** Outline of the podium / lowest parking plate, if different */
  podiumOutline: Polygon | null;
  /** Long axis of the bar; 'x' for a plate wider than deep */
  longAxis: 'x' | 'y';
  shape: FootprintShape;
  /** Walls of the typical floor (any type; only axis-aligned ones are used) */
  walls: WallDef[];
  cores: CoreDef[];
  exteriorWallT: number;
  /** Only publish the parking-module grid when there actually is a podium or basement storey */
  includeParkingGrid: boolean;
  namer: (label: string) => string;
}

// ----------------------------------------------------------------------------
// Wall helpers
// ----------------------------------------------------------------------------

export function snapWallsOf(walls: WallDef[], types: WallType[]): SnapWall[] {
  const wanted = new Set<WallType>(types);
  const out: SnapWall[] = [];
  for (const w of walls) {
    if (!wanted.has(w.type)) continue;
    const dx = Math.abs(w.start[0] - w.end[0]);
    const dy = Math.abs(w.start[1] - w.end[1]);
    if (dy < 1e-6 && dx > 1e-6) {
      out.push({ constAxis: 'y', at: w.start[1], lo: Math.min(w.start[0], w.end[0]), hi: Math.max(w.start[0], w.end[0]), type: w.type, thickness: w.thickness });
    } else if (dx < 1e-6 && dy > 1e-6) {
      out.push({ constAxis: 'x', at: w.start[0], lo: Math.min(w.start[1], w.end[1]), hi: Math.max(w.start[1], w.end[1]), type: w.type, thickness: w.thickness });
    }
  }
  return out;
}

/** Constant coordinates of the axis-aligned walls of the given types, on the given axis */
function wallOffsets(snaps: SnapWall[], types: WallType[], constAxis: 'x' | 'y', minLength = 1.0): number[] {
  const wanted = new Set<WallType>(types);
  return snaps.filter(s => s.constAxis === constAxis && wanted.has(s.type) && s.hi - s.lo >= minLength).map(s => s.at);
}

// ----------------------------------------------------------------------------
// Offset normalisation (STR-02 / STR-09)
// ----------------------------------------------------------------------------

export function dedupeOffsets(raw: number[], tol = 0.25): number[] {
  const sorted = [...raw].filter(v => Number.isFinite(v)).sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of sorted) {
    if (out.length === 0 || v - out[out.length - 1] > tol) out.push(round(v, 4));
  }
  return out;
}

/**
 * A bay is only subdivided when it exceeds the economic span by more than 12%, so a 9.4 m bay
 * keeps its clear span instead of collapsing into two 4.7 m bays with a column in a living room.
 */
export const SPLIT_TOLERANCE = 1.12;

/**
 * Merge lines closer than `minSpacing` and subdivide bays longer than `maxSpacing`.
 * `mustKeep` offsets (normally the two outer lines) are never dropped.
 */
export function normalizeOffsets(raw: number[], minSpacing: number, maxSpacing: number, mustKeep: number[] = []): number[] {
  const all = dedupeOffsets(raw);
  if (all.length === 0) return [];
  if (all.length === 1) return all;
  const keep = new Set(dedupeOffsets(mustKeep).map(v => round(v, 3)));
  const isKeep = (v: number): boolean => keep.has(round(v, 3));

  // 1. merge
  const merged: number[] = [all[0]];
  for (let i = 1; i < all.length; i++) {
    const v = all[i];
    const last = merged[merged.length - 1];
    if (v - last >= minSpacing - EPS) { merged.push(v); continue; }
    // too close: prefer the must-keep one, otherwise keep the one already placed
    if (isKeep(v) && !isKeep(last)) merged[merged.length - 1] = v;
    else if (isKeep(v) && isKeep(last)) merged.push(v);
  }

  // 2. subdivide long bays
  const out: number[] = [merged[0]];
  for (let i = 1; i < merged.length; i++) {
    const gap = merged[i] - merged[i - 1];
    if (gap > maxSpacing * SPLIT_TOLERANCE) {
      const n = Math.ceil(gap / maxSpacing - 1e-9);
      for (let k = 1; k < n; k++) out.push(round(merged[i - 1] + (gap * k) / n, 4));
    }
    out.push(merged[i]);
  }
  return out;
}

/** Evenly spaced module offsets from lo to hi, close to `module` and never longer than `maxBay` */
export function moduleOffsets(lo: number, hi: number, module: number, maxBay = 12): number[] {
  const span = hi - lo;
  if (span <= 0.01) return [round(lo, 4)];
  let n = Math.max(1, Math.round(span / module));
  n = Math.max(n, Math.ceil(span / maxBay - 1e-9));
  const step = span / n;
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(round(lo + i * step, 4));
  return out;
}

// ----------------------------------------------------------------------------
// Grid construction
// ----------------------------------------------------------------------------

export function buildGrid(opts: BuildGridOptions): GridPlan {
  const b = polygonBounds(opts.typicalOutline);
  const t = opts.exteriorWallT;
  const snaps = snapWallsOf(opts.walls, ['exterior', 'party', 'corridor', 'core', 'retaining']);
  const coreX: number[] = [];
  const coreY: number[] = [];
  for (const c of opts.cores) {
    coreX.push(c.rect.x, c.rect.x + c.rect.w);
    coreY.push(c.rect.y, c.rect.y + c.rect.h);
  }

  const extX = wallOffsets(snaps, ['exterior', 'retaining'], 'x', 2.0);
  const extY = wallOffsets(snaps, ['exterior', 'retaining'], 'y', 2.0);
  const corrX = wallOffsets(snaps, ['corridor'], 'x', 3.0);
  const corrY = wallOffsets(snaps, ['corridor'], 'y', 3.0);
  const partyX = wallOffsets(snaps, ['party'], 'x', 2.0);
  const partyY = wallOffsets(snaps, ['party'], 'y', 2.0);

  // Perimeter fallback: exterior wall centrelines derived from the outline bounds
  const perimX = extX.length >= 2 ? extX : [b.x + t / 2, b.x + b.w - t / 2];
  const perimY = extY.length >= 2 ? extY : [b.y + t / 2, b.y + b.h - t / 2];

  const squarish = opts.shape === 'point' || (b.w < 1.5 * b.h && b.h < 1.5 * b.w);

  let mainX: number[];
  let mainY: number[];
  let corridorAxis: 'x' | 'y';
  let corridorOffsets: number[];

  if (squarish) {
    // Point plate: perimeter + core walls in both directions, capped at the economic span.
    // With no interior line at all, fall back to the target module across the whole plate.
    mainX = normalizeOffsets([...perimX, ...coreX, ...partyX], GRID_RULES.minSpacing, GRID_RULES.maxSpacing, [...perimX, ...partyX]);
    mainY = normalizeOffsets([...perimY, ...coreY, ...partyY], GRID_RULES.minSpacing, GRID_RULES.maxSpacing, [...perimY, ...partyY]);
    if (mainX.length < 3) mainX = moduleOffsets(perimX[0], perimX[perimX.length - 1], GRID_RULES.pointPlateTarget, GRID_RULES.maxSpacing);
    if (mainY.length < 3) mainY = moduleOffsets(perimY[0], perimY[perimY.length - 1], GRID_RULES.pointPlateTarget, GRID_RULES.maxSpacing);
    corridorAxis = 'y';
    corridorOffsets = dedupeOffsets(corrY);
  } else if (opts.longAxis === 'x') {
    // Bar running along X: longitudinal lines are constant-y, transverse lines are constant-x.
    // The longitudinal set keeps the close corridor pair (min 1.5 m) and only subdivides a
    // genuinely unbuildable depth (> 11 m between bearing lines).
    let longitudinal = dedupeOffsets([...perimY, ...corrY]);
    if (longitudinal.length < 3) longitudinal = dedupeOffsets([...longitudinal, b.y + b.h / 2]);
    mainY = normalizeOffsets(longitudinal, 1.5, 11, [...perimY, ...corrY]);
    // Party walls outrank core edges: the party wall carries the dwellings above, the core
    // carries itself, so a core edge within the merge distance of a party line gives way.
    mainX = normalizeOffsets([...perimX, ...partyX, ...coreX], GRID_RULES.minSpacing, GRID_RULES.maxSpacing, [...perimX, ...partyX]);
    corridorAxis = 'y';
    corridorOffsets = dedupeOffsets(corrY);
  } else {
    let longitudinal = dedupeOffsets([...perimX, ...corrX]);
    if (longitudinal.length < 3) longitudinal = dedupeOffsets([...longitudinal, b.x + b.w / 2]);
    mainX = normalizeOffsets(longitudinal, 1.5, 11, [...perimX, ...corrX]);
    mainY = normalizeOffsets([...perimY, ...partyY, ...coreY], GRID_RULES.minSpacing, GRID_RULES.maxSpacing, [...perimY, ...partyY]);
    corridorAxis = 'x';
    corridorOffsets = dedupeOffsets(corrX);
  }

  // Parking module grid for podium / basement storeys (STR-04)
  const pb = polygonBounds(opts.podiumOutline ?? opts.typicalOutline);
  const alongX = opts.longAxis === 'x';
  const parkX = opts.includeParkingGrid
    ? moduleOffsets(pb.x + t / 2, pb.x + pb.w - t / 2, alongX ? TRANSFER.moduleAlong : TRANSFER.moduleAcross)
    : mainX;
  const parkY = opts.includeParkingGrid
    ? moduleOffsets(pb.y + t / 2, pb.y + pb.h - t / 2, alongX ? TRANSFER.moduleAcross : TRANSFER.moduleAlong)
    : mainY;

  // Label the union of every offset that exists on any storey
  const allX = dedupeOffsets([...mainX, ...parkX], 0.05);
  const allY = dedupeOffsets([...mainY, ...parkY], 0.05);
  const labelX = new Map<string, string>();
  const labelY = new Map<string, string>();
  allX.forEach((v, i) => labelX.set(key(v), letterLabel(i)));
  allY.forEach((v, i) => labelY.set(key(v), String(i + 1)));

  const nearestLabel = (map: Map<string, string>, offsets: number[], v: number): string => {
    const direct = map.get(key(v));
    if (direct) return direct;
    let best = offsets[0];
    for (const o of offsets) if (Math.abs(o - v) < Math.abs(best - v)) best = o;
    return map.get(key(best)) ?? '?';
  };

  const lines: GridLine[] = [
    ...allX.map(v => ({ id: opts.namer(labelX.get(key(v))!), axis: 'x' as const, offset: v })),
    ...allY.map(v => ({ id: opts.namer(labelY.get(key(v))!), axis: 'y' as const, offset: v })),
  ];

  return {
    lines,
    mainX,
    mainY,
    parkX,
    parkY,
    longAxis: opts.longAxis,
    corridorAxis,
    corridorOffsets,
    avgSpacingX: meanGap(mainX),
    avgSpacingY: meanGap(mainY),
    label: (axis, offset) => (axis === 'x' ? nearestLabel(labelX, allX, offset) : nearestLabel(labelY, allY, offset)),
    ref(x, y) {
      return `${nearestLabel(labelX, allX, x)}-${nearestLabel(labelY, allY, y)}`;
    },
  };
}

function key(v: number): string {
  return round(v, 2).toFixed(2);
}

export function meanGap(offsets: number[]): number {
  if (offsets.length < 2) return 0;
  return round((offsets[offsets.length - 1] - offsets[0]) / (offsets.length - 1), 3);
}

/** Half-bay tributary extent of the line at index `i` (m) */
export function tributaryExtent(offsets: number[], i: number): number {
  const prev = i > 0 ? (offsets[i] - offsets[i - 1]) / 2 : 0;
  const next = i < offsets.length - 1 ? (offsets[i + 1] - offsets[i]) / 2 : 0;
  const t = prev + next;
  return t > EPS ? t : 3.0;
}

// ----------------------------------------------------------------------------
// STR-03 Columns Hide in Walls
// ----------------------------------------------------------------------------

/**
 * Move a grid intersection onto any wall centreline within `snapDistance`, so the column is
 * absorbed into the wall zone instead of standing 300 mm clear of it.
 */
export function snapToWalls(p: Vec2, snaps: SnapWall[], snapDistance: number = GRID_RULES.snapDistance): { p: Vec2; snapped: boolean } {
  let x = p[0];
  let y = p[1];
  let bestX = snapDistance;
  let bestY = snapDistance;
  let snapped = false;
  for (const s of snaps) {
    if (s.constAxis === 'x') {
      if (p[1] < s.lo - 0.5 || p[1] > s.hi + 0.5) continue;
      const d = Math.abs(p[0] - s.at);
      if (d < bestX - EPS) { bestX = d; x = s.at; snapped = true; }
    } else {
      if (p[0] < s.lo - 0.5 || p[0] > s.hi + 0.5) continue;
      const d = Math.abs(p[1] - s.at);
      if (d < bestY - EPS) { bestY = d; y = s.at; snapped = true; }
    }
  }
  return { p: [x, y], snapped };
}

/** True when the point falls inside any of the rects (cores, stairs, lifts, shafts), with a margin */
export function insideAnyRect(p: Vec2, rects: Rect[], margin = 0.05): boolean {
  for (const r of rects) {
    if (p[0] > r.x + margin && p[0] < r.x + r.w - margin && p[1] > r.y + margin && p[1] < r.y + r.h - margin) return true;
  }
  return false;
}
