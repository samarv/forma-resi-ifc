/**
 * Structural grid construction — patterns STR-02 (Grid on Party Walls, a specialisation of
 * XD-03), STR-03 (Columns Hide in Walls) and STR-09 (Economic Span).
 *
 * GRID LINE CONVENTION
 *   axis: 'x'  →  `offset` is an X coordinate; the line runs parallel to +Y. Labelled A, B, C…
 *   axis: 'y'  →  `offset` is a Y coordinate; the line runs parallel to +X. Labelled 1, 2, 3…
 *   Letters skip I and O, as in structural drafting practice. A column's `gridRef` is 'C-3'.
 *
 * ONE GRID FOR THE WHOLE BUILDING (v2). The grid is derived ONCE — from `ArchModel.partyLines` when the placer
 * has published them, otherwise from the typical storey's walls — and every storey reuses it. v1 additionally
 * ran `snapToWalls` per storey with that storey's own walls, so one grid intersection could land at different
 * XY on different levels: a silent 0.6 m kink in a column line, and a column that lands on nothing below.
 * `snapToWalls` / `SnapWall` / `snapWallsOf` are gone; STR-03 is now satisfied by construction, because the
 * transverse lines ARE the party/exterior/corridor/core wall centrelines. `GridPlan.isWallLine` reports which
 * of the resulting lines coincides with a wall, for the STR-03 pattern trace.
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

/** An axis-aligned wall centreline reduced to the data the grid needs. Internal: the grid is the only consumer. */
interface WallLine {
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
  /** Where the transverse lines came from: the placer's party lines, or the typical storey's walls */
  source: 'party-lines' | 'walls';
  /** True when this grid line sits on an exterior / party / corridor / core wall centreline (STR-03) */
  isWallLine(axis: 'x' | 'y', offset: number): boolean;
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
  /**
   * The structural handshake (v2): the party-wall / column lines the placer actually laid out
   * (`ArchModel.partyLines`). When present the transverse grid is built on EXACTLY these lines, with no
   * merging and no snapping — the placer has already snapped them to `presize.gridProposal`.
   */
  partyLines?: { barId: string; axis: 'x' | 'y'; offsets: number[] }[];
  namer: (label: string) => string;
}

// ----------------------------------------------------------------------------
// Wall helpers
// ----------------------------------------------------------------------------

function wallLinesOf(walls: WallDef[], types: WallType[]): WallLine[] {
  const wanted = new Set<WallType>(types);
  const out: WallLine[] = [];
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
function wallOffsets(snaps: WallLine[], types: WallType[], constAxis: 'x' | 'y', minLength = 1.0): number[] {
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
  const snaps = wallLinesOf(opts.walls, ['exterior', 'party', 'corridor', 'core', 'retaining']);
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

  // The handshake: transverse lines on exactly the party lines the placer laid out. They are already snapped to
  // `presize.gridProposal` and identical on every storey, so nothing here merges, subdivides or snaps them.
  const handX = opts.partyLines?.filter(p => p.axis === 'x').flatMap(p => p.offsets) ?? [];
  const handY = opts.partyLines?.filter(p => p.axis === 'y').flatMap(p => p.offsets) ?? [];
  const handshakeAxis: 'x' | 'y' | null = handX.length >= 2 ? 'x' : handY.length >= 2 ? 'y' : null;

  if (handshakeAxis !== null) {
    const transverse = dedupeOffsets(handshakeAxis === 'x' ? [...perimX, ...handX] : [...perimY, ...handY], 0.05);
    if (handshakeAxis === 'x') {
      mainX = transverse;
      let longitudinal = dedupeOffsets([...perimY, ...corrY]);
      if (longitudinal.length < 3) longitudinal = dedupeOffsets([...longitudinal, b.y + b.h / 2]);
      mainY = normalizeOffsets(longitudinal, 1.5, 11, [...perimY, ...corrY]);
      corridorAxis = 'y';
      corridorOffsets = dedupeOffsets(corrY);
    } else {
      mainY = transverse;
      let longitudinal = dedupeOffsets([...perimX, ...corrX]);
      if (longitudinal.length < 3) longitudinal = dedupeOffsets([...longitudinal, b.x + b.w / 2]);
      mainX = normalizeOffsets(longitudinal, 1.5, 11, [...perimX, ...corrX]);
      corridorAxis = 'x';
      corridorOffsets = dedupeOffsets(corrX);
    }
  } else if (squarish) {
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

  // Parking module grid for podium / basement storeys (STR-04). The module is laid over the podium BOUNDS, so
  // on an L / U / O plate it can miss the plate's own faces entirely — and then nothing carries the exterior
  // wall of the plate above (us-senior: a 9 m deep wing with no column line under its rear wall). The exterior
  // wall centrelines are therefore must-keep lines in the parking grid too.
  const pOutline = opts.podiumOutline ?? opts.typicalOutline;
  const pb = polygonBounds(pOutline);
  const alongX = opts.longAxis === 'x';
  const faceX = dedupeOffsets([...extX, ...perimX], 0.25);
  const faceY = dedupeOffsets([...extY, ...perimY], 0.25);
  const parkAxis = (lo: number, hi: number, module: number, faces: number[]): number[] => {
    const inside = faces.filter(v => v > lo - 0.5 && v < hi + 0.5);
    return normalizeOffsets([...moduleOffsets(lo, hi, module), ...inside], GRID_RULES.minSpacing, module, inside);
  };
  const parkX = opts.includeParkingGrid
    ? parkAxis(pb.x + t / 2, pb.x + pb.w - t / 2, alongX ? TRANSFER.moduleAlong : TRANSFER.moduleAcross, faceX)
    : mainX;
  const parkY = opts.includeParkingGrid
    ? parkAxis(pb.y + t / 2, pb.y + pb.h - t / 2, alongX ? TRANSFER.moduleAcross : TRANSFER.moduleAlong, faceY)
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

  // STR-03: which lines are absorbed into a wall zone. Party lines from the placer are wall lines by definition.
  const wallKeysX = new Set<string>([...handX, ...extX, ...corrX, ...partyX, ...coreX].map(key));
  const wallKeysY = new Set<string>([...handY, ...extY, ...corrY, ...partyY, ...coreY].map(key));

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
    source: handshakeAxis !== null ? 'party-lines' : 'walls',
    isWallLine: (axis, offset) => (axis === 'x' ? wallKeysX : wallKeysY).has(key(offset)),
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

/** True when the point falls inside any of the rects (cores, stairs, lifts, shafts), with a margin */
export function insideAnyRect(p: Vec2, rects: Rect[], margin = 0.05): boolean {
  for (const r of rects) {
    if (p[0] > r.x + margin && p[0] < r.x + r.w - margin && p[1] > r.y + margin && p[1] < r.y + r.h - margin) return true;
  }
  return false;
}
