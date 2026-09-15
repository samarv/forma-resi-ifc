/**
 * Parametric room layout engine for a single dwelling.
 *
 * `layoutUnit(req)` fills ONE net rect on ONE level with rooms, partitions, a wet wall, doors,
 * windows and furniture, and reports the patterns it applied. The floor organizer owns everything
 * outside the rect (party / corridor / exterior / core walls) and hands them in as `boundaryWalls`.
 *
 * ── Method ──────────────────────────────────────────────────────────────────
 * Everything is planned in a LOCAL frame anchored on the access side:
 *   u runs along the frontage (0 … F), v runs from the access side into the unit (0 … D).
 * The frame is a pure rotation of world XY, so every local rect maps to an axis-aligned world rect.
 *
 * The plan is a sequence of vertical zones along u, each sliced in v (pattern ARC-14):
 *
 *      u →   ┌──────────────┬──────────┬────────────┐   v = 0  (access side: corridor / street)
 *            │  kitchen     │ bath│ent │ ensuite    │
 *   FRONT    │  (wet band)  │ (wet band)│ + walk-in  │   ← wet wall at v = frontDepth
 *   BAND     ├──────────────┼──────────┼────────────┤
 *            │              │   hall   │            │
 *   BACK     │  living /    ├──────────┤  master    │
 *   BAND     │  dining      │ bedrooms │  bedroom   │
 *            └──────────────┴──────────┴────────────┘   v = D  (exterior / façade)
 *              zone L         zone P      zone M
 *
 * When the side OPPOSITE the entry is a party wall and the two PERPENDICULAR sides are exterior
 * (mansion block / garden walk-up: two dwellings per stair landing), the zoned plan above would
 * push the bedrooms onto the party wall, so a different plan type is used — the through flat
 * (ARC-36, Alexander APL #159): daylit rooms stand in full-depth bands at the two exterior ends of
 * u, a hall strip runs along the access wall between them, and the wet/service rooms sit under
 * that strip against the party wall:
 *
 *      u →   ┌──────────┬──────┬─────┬──────┬──────────┐   v = 0  (access side: stair landing)
 *            │ living   │ hall │entry│ hall │ bedroom  │
 *   daylit   │          ├──────┴─────┴──────┤          │   ← hall strip 1.1–1.5 m deep
 *   BAND     │ dining   │ kitchen │  bath   │ master   │   ← wet band on the party wall
 *            └──────────┴─────────┴─────────┴──────────┘   v = D  (party wall)
 *             façade A    service columns     façade B
 *
 * Rooms are always rectangles, the slices tile the rect exactly (100 % coverage, no overlaps),
 * and every room that needs daylight touches an exterior side. Interior partitions are emitted one
 * per shared edge with their centreline ON the shared boundary (rooms are net-to-centreline);
 * fixtures are set back by half the wet-wall thickness so nothing lands inside a wall.
 *
 * Degradation order when the rect is too small (brief): shrink closets → drop droppable service
 * rooms → move the smallest daylit room into the service band → squeeze to minimum widths → warn.
 */
import type {
  Compass, DoorDef, FurnitureDef, FurnitureType, PatternApplication, Rect, Region, RoomDef, RoomProgram,
  RoomType, Side, UnitTemplateDef, Vec2, WallDef, WindowDef, Zone,
} from '../../core/types.ts';
import type { UnitLayout, UnitLayoutFn, UnitLayoutRequest } from './unit-layout-types.ts';
import {
  projectOnSegment, rectContainsRect, rectToPolygon, rectsOverlap, round, solarScore,
  stripsXByWidths, stripsYByHeights,
} from '../../core/geometry.ts';
import { IdFactory, roomId } from '../../core/ids.ts';
import { SIZES } from '../../core/coordination.ts';
import { CLEARANCE, FURNITURE_CATALOG, storageVolume } from './furniture.ts';
import { UNIT_LEVEL_SPLIT } from './templates.ts';

// ============================================================================
// Constants and small tables
// ============================================================================

const STAIR_TREAD = 0.26;
const STAIR_CLEAR_WIDTH = 1.0;
/** Minimum overlap of two room edges before a wall/door is worth generating (m) */
const MIN_EDGE = 0.6;
/** Minimum clear overlap needed to hang a door (m) — below this a room is landlocked */
const MIN_DOOR_EDGE = 0.7;
const E = 1e-6;

interface RoomLimit { maxWidth: number; maxDepth: number }
const ROOM_LIMITS: Partial<Record<RoomType, RoomLimit>> = {
  living: { maxWidth: 7.0, maxDepth: 7.0 },
  'living-kitchen': { maxWidth: 8.5, maxDepth: 8.5 },
  dining: { maxWidth: 5.0, maxDepth: 5.5 },
  kitchen: { maxWidth: 6.0, maxDepth: 4.6 },
  bedroom: { maxWidth: 4.8, maxDepth: 5.6 },
  'master-bedroom': { maxWidth: 5.6, maxDepth: 6.2 },
  study: { maxWidth: 4.6, maxDepth: 5.0 },
  den: { maxWidth: 3.6, maxDepth: 4.4 },
  flex: { maxWidth: 4.8, maxDepth: 5.6 },
  bathroom: { maxWidth: 3.2, maxDepth: 4.4 },
  ensuite: { maxWidth: 3.0, maxDepth: 4.4 },
  powder: { maxWidth: 2.2, maxDepth: 3.2 },
  wc: { maxWidth: 2.2, maxDepth: 3.2 },
  entry: { maxWidth: 3.2, maxDepth: 4.4 },
  hall: { maxWidth: 40, maxDepth: 2.8 },
  corridor: { maxWidth: 40, maxDepth: 40 },
  closet: { maxWidth: 2.4, maxDepth: 4.4 },
  'walk-in-closet': { maxWidth: 3.0, maxDepth: 4.4 },
  laundry: { maxWidth: 2.8, maxDepth: 4.4 },
  utility: { maxWidth: 2.8, maxDepth: 4.4 },
  storage: { maxWidth: 3.0, maxDepth: 4.4 },
  garage: { maxWidth: 4.4, maxDepth: 6.6 },
  stair: { maxWidth: 2.4, maxDepth: 6.5 },
  'shared-living': { maxWidth: 13, maxDepth: 8 },
  'shared-kitchen': { maxWidth: 13, maxDepth: 6 },
};
const DEFAULT_LIMIT: RoomLimit = { maxWidth: 6, maxDepth: 6 };
const limitOf = (t: RoomType): RoomLimit => ROOM_LIMITS[t] ?? DEFAULT_LIMIT;

/** Rooms that must touch the façade band; everything else is service/circulation. */
const BACK_TYPES = new Set<RoomType>(['living', 'living-kitchen', 'dining', 'bedroom', 'master-bedroom', 'shared-living', 'shared-kitchen', 'flex', 'study']);
const PRIVATE_TYPES = new Set<RoomType>(['bedroom', 'master-bedroom']);
const WET_TYPES = new Set<RoomType>(['kitchen', 'living-kitchen', 'bathroom', 'ensuite', 'powder', 'wc', 'laundry', 'utility', 'shared-kitchen']);
const BATH_TYPES = new Set<RoomType>(['bathroom', 'ensuite', 'powder', 'wc']);
const DROPPABLE = new Set<RoomType>(['closet', 'storage', 'walk-in-closet', 'laundry', 'utility', 'powder', 'wc']);
/**
 * Rooms whose loss is absorbed by furniture rather than reported: a dropped closet becomes a
 * wardrobe run in the bedroom it served (ARC-27/ARC-30), a dropped store becomes shelving.
 * Everything else that gets dropped is still worth a warning.
 */
const SILENT_DROP = new Set<RoomType>(['closet', 'walk-in-closet', 'storage']);
/** Rooms whose minimum clear width is a code/usability failure rather than a tight fit */
const CRITICAL_WIDTH = new Set<RoomType>(['kitchen', 'living-kitchen', 'bathroom', 'ensuite', 'shared-kitchen']);

/**
 * Share of a wall's glazing budget a room claims per metre of façade (ARC-16). Living spaces take
 * the largest share, bedrooms a normal one, wet rooms a small obscure-glazed one, and circulation
 * or storage none at all — its share is spent on the habitable rooms beside it.
 */
const GLAZE_WEIGHT: Partial<Record<RoomType, number>> = {
  living: 1.3, 'living-kitchen': 1.3, dining: 1.3, kitchen: 1.3, 'shared-living': 1.3, 'shared-kitchen': 1.3,
  study: 1.15, flex: 1.15, den: 1.0, bedroom: 1.0, 'master-bedroom': 1.0,
  bathroom: 0.4, ensuite: 0.4, powder: 0.4, wc: 0.4, laundry: 0.4, utility: 0.4,
  hall: 0, entry: 0, corridor: 0, stair: 0, closet: 0, 'walk-in-closet': 0, storage: 0, garage: 0,
  balcony: 0, terrace: 0,
};
const glazeWeight = (t: RoomType): number => GLAZE_WEIGHT[t] ?? 0.8;
/** Rooms that get a 0.6 m sill so a seated person sees the ground (APL #221) */
const GLAZE_LOW_SILL = new Set<RoomType>(['living', 'living-kitchen', 'shared-living', 'dining', 'kitchen']);
/** Glazed leaf fraction of a sliding balcony door: frames and rails are not glass (ARC-16/ARC-17) */
const DOOR_GLAZED = 0.8;
/** Rooms joined by a cased opening instead of a door leaf */
const OPEN_PLAN = new Set<RoomType>(['living', 'living-kitchen', 'dining', 'kitchen', 'hall', 'entry', 'corridor', 'stair', 'shared-living', 'shared-kitchen', 'flex']);

/** Cost of routing circulation THROUGH a room — keeps the door tree in the halls (ARC-19). */
const TRANSIT_COST: Partial<Record<RoomType, number>> = {
  hall: 0.1, corridor: 0.1, entry: 0.3, stair: 0.5,
  living: 1.2, 'living-kitchen': 1.4, 'shared-living': 1.2, dining: 2.0, 'shared-kitchen': 2.4,
  kitchen: 4.0, flex: 3.0, study: 6.0, den: 6.0, garage: 6.0,
  bedroom: 40, 'master-bedroom': 40, bathroom: 120, ensuite: 120, powder: 120, wc: 120,
  closet: 200, 'walk-in-closet': 200, laundry: 90, utility: 90, storage: 90, balcony: 400,
};
const transitCost = (t: RoomType): number => TRANSIT_COST[t] ?? 20;

const ROOM_LABELS: Record<string, string> = {
  living: 'Living Room', dining: 'Dining Room', kitchen: 'Kitchen', 'living-kitchen': 'Living / Kitchen',
  bedroom: 'Bedroom', 'master-bedroom': 'Master Bedroom', bathroom: 'Bathroom', ensuite: 'En-suite',
  powder: 'Powder Room', wc: 'WC', hall: 'Hall', entry: 'Entry', closet: 'Closet',
  'walk-in-closet': 'Walk-in Closet', laundry: 'Laundry', utility: 'Utility', storage: 'Store',
  study: 'Study', den: 'Den', balcony: 'Balcony', terrace: 'Terrace', garage: 'Garage', stair: 'Stair',
  corridor: 'Corridor', 'shared-kitchen': 'Shared Kitchen', 'shared-living': 'Shared Living', flex: 'Flex Room',
};
/** Regional vocabulary (UK/IE/AU/NZ differ from US/CA) */
const ROOM_LABELS_REGION: Partial<Record<Region, Partial<Record<RoomType, string>>>> = {
  UK: { closet: 'Store', 'walk-in-closet': 'Dressing Room', laundry: 'Utility', powder: 'Cloakroom', entry: 'Hall', 'master-bedroom': 'Principal Bedroom', storage: 'Store' },
  IE: { closet: 'Store', 'walk-in-closet': 'Dressing Room', laundry: 'Utility', powder: 'Cloakroom', entry: 'Hall', 'master-bedroom': 'Principal Bedroom' },
  AU: { closet: 'Robe', 'walk-in-closet': 'Walk-in Robe', powder: 'Powder Room', entry: 'Entry', 'master-bedroom': 'Main Bedroom' },
  NZ: { closet: 'Wardrobe', 'walk-in-closet': 'Walk-in Wardrobe', powder: 'Powder Room', 'master-bedroom': 'Main Bedroom' },
  CA: { 'master-bedroom': 'Primary Bedroom' },
  US: { 'master-bedroom': 'Primary Bedroom' },
};

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

// ============================================================================
// Local frame (access side → u/v)
// ============================================================================

type LDir = 'u+' | 'u-' | 'v+' | 'v-';

interface Frame {
  F: number;
  D: number;
  toWorld(u: number, v: number): Vec2;
  toWorldRect(r: Rect): Rect;
  /** local side → world side */
  side(local: Side): Side;
  /** world side → local side */
  localSide(world: Side): Side;
  dir(d: LDir): Vec2;
  /** world rect → local (u, v) rect */
  toLocalRect(r: Rect): Rect;
  /** world distance along the access side → local u */
  alongToU(along: number): number;
}

const LOCAL_TO_WORLD_SIDE: Record<Side, Record<Side, Side>> = {
  front: { front: 'front', rear: 'rear', left: 'left', right: 'right' },
  rear: { front: 'rear', rear: 'front', left: 'right', right: 'left' },
  left: { front: 'left', rear: 'right', left: 'rear', right: 'front' },
  right: { front: 'right', rear: 'left', left: 'front', right: 'rear' },
};

function makeFrame(r: Rect, access: Side): Frame {
  const toWorld = (u: number, v: number): Vec2 => {
    switch (access) {
      case 'front': return [r.x + u, r.y + v];
      case 'rear': return [r.x + r.w - u, r.y + r.h - v];
      case 'left': return [r.x + v, r.y + r.h - u];
      default: return [r.x + r.w - v, r.y + u];
    }
  };
  const horiz = access === 'front' || access === 'rear';
  const l2w = LOCAL_TO_WORLD_SIDE[access];
  const w2l: Record<Side, Side> = { front: 'front', rear: 'rear', left: 'left', right: 'right' };
  for (const k of ['front', 'rear', 'left', 'right'] as Side[]) w2l[l2w[k]] = k;
  const dirs: Record<LDir, Vec2> = {
    'u+': sub2(toWorld(1, 0), toWorld(0, 0)),
    'u-': sub2(toWorld(0, 0), toWorld(1, 0)),
    'v+': sub2(toWorld(0, 1), toWorld(0, 0)),
    'v-': sub2(toWorld(0, 0), toWorld(0, 1)),
  };
  return {
    F: horiz ? r.w : r.h,
    D: horiz ? r.h : r.w,
    toWorld,
    toWorldRect: (lr: Rect): Rect => {
      const a = toWorld(lr.x, lr.y);
      const b = toWorld(lr.x + lr.w, lr.y + lr.h);
      return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]) };
    },
    side: (local: Side) => l2w[local],
    localSide: (world: Side) => w2l[world],
    dir: (d: LDir) => dirs[d],
    toLocalRect: (wr: Rect): Rect => {
      const o = toWorld(0, 0);
      const du = dirs['u+'];
      const dv = dirs['v+'];
      const pt = (x: number, y: number): Vec2 => [(x - o[0]) * du[0] + (y - o[1]) * du[1], (x - o[0]) * dv[0] + (y - o[1]) * dv[1]];
      const a = pt(wr.x, wr.y);
      const b = pt(wr.x + wr.w, wr.y + wr.h);
      return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]) };
    },
    alongToU: (along: number) => {
      switch (access) {
        case 'front': return along;
        case 'rear': return r.w - along;
        case 'left': return r.h - along;
        default: return along;
      }
    },
  };
}

function sub2(a: Vec2, b: Vec2): Vec2 { return [round(a[0] - b[0], 6), round(a[1] - b[1], 6)]; }

// ============================================================================
// Program resolution
// ============================================================================

interface Inst { type: RoomType; prog: RoomProgram; n: number }

function allInstances(t: UnitTemplateDef): Inst[] {
  const out: Inst[] = [];
  const seen = new Map<RoomType, number>();
  for (const r of t.rooms) {
    for (let i = 0; i < r.count; i++) {
      const n = (seen.get(r.type) ?? 0) + 1;
      seen.set(r.type, n);
      out.push({ type: r.type, prog: r, n });
    }
  }
  return out;
}

/** Rooms belonging to `level` of a multi-level template (deterministic across independent calls). */
function programForLevel(t: UnitTemplateDef, level: number, levelsTotal: number, warnings: string[]): Inst[] {
  const all = allInstances(t);
  if (levelsTotal <= 1 || t.storeysInUnit <= 1) return level === 0 ? all : [];
  const split = UNIT_LEVEL_SPLIT[t.id];
  if (!split) {
    if (level === 0) warnings.push(`template ${t.id} has ${t.storeysInUnit} storeys but no level split; everything placed on the entry level`);
    return level === 0 ? all : [];
  }
  const pools = new Map<RoomType, Inst[]>();
  for (const i of all) {
    const p = pools.get(i.type) ?? [];
    p.push(i);
    pools.set(i.type, p);
  }
  const taken = new Map<RoomType, number>();
  let mine: Inst[] = [];
  for (let L = 0; L < Math.max(split.length, levelsTotal); L++) {
    const want = split[L] ?? {};
    const picked: Inst[] = [];
    for (const key of Object.keys(want) as RoomType[]) {
      const count = want[key] ?? 0;
      const pool = pools.get(key) ?? [];
      const start = taken.get(key) ?? 0;
      for (let k = 0; k < count; k++) {
        const idx = start + k;
        const found = pool[idx];
        if (found) picked.push(found);
        else if (pool.length > 0) picked.push({ type: key, prog: pool[pool.length - 1].prog, n: idx + 1 });
      }
      taken.set(key, start + count);
    }
    if (L === level) mine = picked;
  }
  return mine;
}

// ============================================================================
// Width fitting
// ============================================================================

interface FitItem { key: string; min: number; target: number; max: number; drop: boolean; type?: RoomType }

function toFitItem(i: Inst, depth: number): FitItem {
  const lim = limitOf(i.type);
  const target = depth > 0 ? i.prog.targetArea / depth : i.prog.minWidth;
  const min = Math.max(0.6, Math.min(i.prog.minWidth, lim.maxWidth));
  const max = Math.max(min, Math.min(lim.maxWidth, Math.max(target, (i.prog.targetArea * 1.8) / Math.max(depth, 0.5))));
  return { key: `${i.type}${i.n}`, min, target: clamp(target, min, max), max, drop: DROPPABLE.has(i.type), type: i.type };
}

const minWidthOf = (i: Inst): number => Math.max(0.6, Math.min(i.prog.minWidth, limitOf(i.type).maxWidth));

/**
 * Distribute `total` across items. Returns widths summing to `total` (or less, with `leftover`),
 * dropping droppable items and squeezing below minimums only as a last resort.
 */
function fitWidths(items: FitItem[], total: number, label: string, warnings: string[]): { widths: number[]; kept: number[]; dropped: number[]; leftover: number } {
  const idx = items.map((_, i) => i);
  const keep = [...idx];
  const dropped: number[] = [];
  const minSum = (): number => sum(keep.map(i => items[i].min));
  let guard = 0;
  while (minSum() > total + E && guard++ < items.length) {
    let d = -1;
    for (let k = keep.length - 1; k >= 0; k--) if (items[keep[k]].drop) { d = k; break; }
    if (d < 0) break;
    dropped.push(keep[d]);
    keep.splice(d, 1);
  }
  if (keep.length === 0) return { widths: [], kept: [], dropped, leftover: total };
  let w = keep.map(i => clamp(items[i].target, items[i].min, items[i].max));
  let s = sum(w);
  let leftover = 0;
  if (s > total + E) {
    const slack = w.map((x, k) => x - items[keep[k]].min);
    const slackSum = sum(slack);
    const excess = s - total;
    if (slackSum >= excess - E && slackSum > E) {
      w = w.map((x, k) => x - (excess * slack[k]) / slackSum);
    } else {
      const mins = keep.map(i => items[i].min);
      // the entry keeps its 1.2 m: squeeze it and the front door no longer fits its own wall
      const hold = keep.map(i => items[i].type === 'entry');
      const holdSum = sum(mins.filter((_, k) => hold[k]));
      const restSum = sum(mins.filter((_, k) => !hold[k]));
      if (holdSum > E && restSum > E && total - holdSum > 0.55 * restSum) {
        const f = (total - holdSum) / restSum;
        w = mins.map((x, k) => (hold[k] ? x : x * f));
      } else {
        const f = total / Math.max(sum(mins), E);
        w = mins.map(x => x * f);
      }
      // Squeezing a closet or a hall below its nominal width is a tight plan, not a defect; a
      // kitchen or a bathroom below its minimum genuinely stops working (ARC-15).
      const hurt = keep
        .map((i, k) => ({ it: items[i], w: w[k] }))
        .filter(x => x.it.type && CRITICAL_WIDTH.has(x.it.type) && x.w < x.it.min - 0.15);
      if (hurt.length > 0) {
        warnings.push(`${label}: ${hurt.map(x => `${x.it.type} ${x.w.toFixed(2)} m (min ${x.it.min.toFixed(2)} m)`).join(', ')} — only ${total.toFixed(2)} m available for ${sum(mins).toFixed(2)} m of rooms`);
      }
    }
  } else if (s < total - E) {
    const head = w.map((x, k) => Math.max(0, items[keep[k]].max - x));
    const headSum = sum(head);
    const deficit = total - s;
    const give = Math.min(deficit, headSum);
    if (headSum > E) w = w.map((x, k) => x + (give * head[k]) / headSum);
    leftover = deficit - give;
  }
  return { widths: w, kept: keep, dropped, leftover };
}

// ============================================================================
// Plan cells
// ============================================================================

interface Cell {
  type: RoomType;
  rect: Rect;
  prog?: RoomProgram;
  n: number;
  wetEdge?: LDir;
  tag?: 'hall' | 'filler' | 'stair' | 'garage';
  sub?: string;
  prefParent?: RoomType;
  /** the plan already reported why this room has no façade; do not warn again per room */
  daylightWaived?: boolean;
}

interface StairPlan { rect: Rect; risers: number; riserHeight: number; tread: number; width: number }

interface PlanOpts {
  accessible: boolean;
  level: number;
  levelsTotal: number;
  floorToFloor: number;
  /** the access side is also an exterior side (own-door houses) */
  accessExterior: boolean;
  /** local left (u = 0) / right (u = F) sides are exterior */
  extLow: boolean;
  extHigh: boolean;
  stackU?: number;
  /** the daylit band sits on the access side because the far side is not exterior */
  flipV: boolean;
  /** the side opposite the access is exterior (the classic corridor / own-door case) */
  extFar: boolean;
  /** solar quality 0..1 of the local low-u / high-u / far exterior faces */
  solarLow: number;
  solarHigh: number;
  solarFar: number;
  /** stair footprint requested by the organizer, already in local coordinates */
  stairLocal?: Rect;
  warnings: string[];
  /** rooms the plan could not fit; merged into furniture instead (ARC-27/ARC-30) */
  dropped: RoomType[];
  /** set by the planner: true when a bathroom span ended up covering `stackU` */
  stackHit?: boolean;
  /** what sits on `stackU` when the wet cluster could not reach it (undefined = off the band) */
  stackBlockedBy?: RoomType;
}

interface PlanResult {
  cells: Cell[];
  frontDepth: number;
  hallDepth: number;
  stair?: StairPlan;
  kind?: 'standard' | 'through' | 'cluster' | 'dual-key';
  /** local u span the wet rooms occupy — the wall the plumbing stack can stand in (XD-01) */
  wetSpan?: { lo: number; hi: number };
}

/** Standard plan: optional full-depth stair and garage columns, then the zoned two-band region. */
function planStandard(F: number, D: number, insts: Inst[], o: PlanOpts): PlanResult {
  const cells: Cell[] = [];
  let u0 = 0;
  let stair: StairPlan | undefined;
  let rest = insts;

  const stairInst = rest.find(i => i.type === 'stair');
  if (stairInst) {
    rest = rest.filter(i => i !== stairInst);
    // round UP: rounding down puts the riser over the code maximum (ARC-22)
    const risers = Math.max(12, Math.ceil(round(o.floorToFloor / SIZES.stairRiserMax, 4)));
    const run = (risers - 1) * STAIR_TREAD;
    // honour the organizer's footprint when it hugs the party wall (so its slab opening lines up)
    const hint = o.stairLocal;
    const useHint = Boolean(hint && hint.w >= 0.9 && hint.h >= 2.0 && hint.x < 0.45 && hint.y + hint.h <= D + 0.05);
    let sw = useHint
      ? clamp((hint as Rect).x + (hint as Rect).w, 1.1, Math.min(2.4, F * 0.34))
      : clamp(STAIR_CLEAR_WIDTH + 0.15, 1.1, Math.max(1.15, Math.min(2.2, F * 0.3)));
    // A terrace house with a garage has no frontage left for an entry beside the stair, so the
    // front door opens into a hall IN FRONT of the stair instead (ARC-18): the standard plan of
    // every narrow-fronted house. The hall keeps the 1.2 m the entry door needs on its own wall.
    const entryInst0 = rest.find(i => i.type === 'entry');
    const garageMin = rest.find(i => i.type === 'garage')?.prog.minWidth ?? 0;
    const tightFrontage = F - sw - garageMin < Math.max(1.35, (entryInst0?.prog.minWidth ?? 1.2) + 0.15);
    let sv = useHint ? clamp((hint as Rect).y, 0, Math.max(0, D - 2.4))
      : entryInst0 && tightFrontage && D >= 5.2
        ? clamp(entryInst0.prog.targetArea / sw, 1.6, Math.min(2.8, D - 2.6))
        : 0;
    const entryInFront = Boolean(entryInst0) && tightFrontage && sv >= 1.35;
    if (entryInFront) sw = clamp(Math.max(sw, 1.25), 1.25, Math.max(1.25, F * 0.4));
    let sh = useHint ? clamp((hint as Rect).h, 2.4, D - sv) : clamp(run + 0.35, 2.4, D - sv);
    if (sv > 0 && sv < 0.95) { sh = Math.min(D - 0, sh + sv); sv = 0; }
    if (D - sv - sh < 0.95) sh = D - sv;
    if (entryInFront && sv > E) {
      rest = rest.filter(i => i !== entryInst0);
      cells.push({ type: 'entry', rect: { x: 0, y: 0, w: sw, h: sv }, n: (entryInst0 as Inst).n, prog: (entryInst0 as Inst).prog });
    } else if (sv > E) cells.push({ type: 'hall', rect: { x: 0, y: 0, w: sw, h: sv }, n: 2, tag: 'hall' });
    cells.push({ type: 'stair', rect: { x: 0, y: sv, w: sw, h: sh }, n: 1, tag: 'stair', prog: stairInst.prog });
    if (sv + sh < D - E) cells.push({ type: 'storage', rect: { x: 0, y: sv + sh, w: sw, h: D - sv - sh }, n: 9, tag: 'filler' });
    stair = { rect: { x: 0, y: sv, w: sw, h: sh }, risers, riserHeight: o.floorToFloor / risers, tread: STAIR_TREAD, width: Math.min(STAIR_CLEAR_WIDTH, sw - 0.12) };
    u0 = sw;
  }

  const garageInst = rest.find(i => i.type === 'garage');
  if (garageInst) {
    rest = rest.filter(i => i !== garageInst);
    const gw = clamp(garageInst.prog.targetArea / Math.min(6.0, D), garageInst.prog.minWidth, Math.max(garageInst.prog.minWidth, Math.min(4.4, (F - u0) * 0.62)));
    const gd = clamp(Math.max(5.0, garageInst.prog.targetArea / gw), 4.8, D);
    cells.push({ type: 'garage', rect: { x: u0, y: 0, w: gw, h: gd }, n: 1, tag: 'garage', prog: garageInst.prog });
    if (D - gd > 1.8) {
      const flexInst = rest.find(i => i.type === 'flex') ?? rest.find(i => i.type === 'storage');
      if (flexInst) rest = rest.filter(i => i !== flexInst);
      cells.push({ type: flexInst?.type ?? 'storage', rect: { x: u0, y: gd, w: gw, h: D - gd }, n: flexInst?.n ?? 8, prog: flexInst?.prog, tag: flexInst ? undefined : 'filler' });
    } else if (D - gd > E) {
      cells[cells.length - 1].rect.h = D;
    }
    u0 += gw;
  }

  let entryAtLowEdge = u0 > 0;
  // single-aspect toward the access side: the daylit band has to sit on the access side, so the
  // entry becomes a full-depth spine from the front door back to the service band.
  if (o.flipV) {
    const entryInst = rest.find(i => i.type === 'entry');
    if (entryInst) {
      rest = rest.filter(i => i !== entryInst);
      const ew = clamp(entryInst.prog.targetArea / D, Math.max(1.1, entryInst.prog.minWidth), Math.min(2.0, (F - u0) * 0.3));
      cells.push({ type: 'entry', rect: { x: u0, y: 0, w: ew, h: D }, n: entryInst.n, prog: entryInst.prog });
      u0 += ew;
      entryAtLowEdge = true;
    }
  }
  const region: Rect = { x: u0, y: 0, w: Math.max(1.2, F - u0), h: D };
  const r = planRegion(region, rest, o, entryAtLowEdge);
  if (o.flipV) {
    for (const c of r.cells) {
      c.rect.y = D - (c.rect.y + c.rect.h);
      if (c.wetEdge === 'v+') c.wetEdge = 'v-';
      else if (c.wetEdge === 'v-') c.wetEdge = 'v+';
    }
  }
  cells.push(...r.cells);
  return { cells, frontDepth: o.flipV ? D - r.frontDepth : r.frontDepth, hallDepth: r.hallDepth, stair };
}

interface ZonePlan {
  kind: 'L' | 'P' | 'M';
  back: Inst[];
  front: Inst[];
  depth: number;
  width: number;
  minWidth: number;
  raw: number;
}

function planRegion(region: Rect, insts: Inst[], o: PlanOpts, entryAtLowEdge: boolean): { cells: Cell[]; frontDepth: number; hallDepth: number } {
  const W = region.w;
  const D = region.h;
  const warnings = o.warnings;
  const minW = (i: Inst): number => Math.max(0.6, Math.min(i.prog.minWidth, limitOf(i.type).maxWidth));

  // a room belongs to the daylit band iff its program asks for an exterior wall
  let back = insts.filter(i => i.prog.needsExterior === true && !BATH_TYPES.has(i.type));
  let front = insts.filter(i => !back.includes(i) && i.type !== 'hall');
  const hallInst = insts.find(i => i.type === 'hall');

  // --- feasibility: daylit rooms must sit side by side along the frontage -----
  let guard = 0;
  while (guard++ < 12 && back.length > 1) {
    const need = sum(back.map(minW));
    if (need <= W + 0.45) break;
    const cand = [...back].sort((a, b) => minW(a) - minW(b) || a.prog.targetArea - b.prog.targetArea)[0];
    back = back.filter(i => i !== cand);
    front = [...front, cand];
    // it keeps a window if a perpendicular wall is glazed — it takes the end of the service band
    if (!o.accessExterior && !o.extLow && !o.extHigh) {
      warnings.push(`${cand.type} moved into the service band with no exterior wall — frontage ${W.toFixed(1)} m is too narrow for ${cand.type} beside the other ${back.length + 1} daylit rooms`);
    }
  }
  const backNeed = sum(back.map(minW));
  if (backNeed > W + E) warnings.push(`daylit rooms squeezed below minimum width (need ${backNeed.toFixed(2)} m, have ${W.toFixed(2)} m)`);

  const privates = back.filter(i => PRIVATE_TYPES.has(i.type));
  const publics = back.filter(i => !PRIVATE_TYPES.has(i.type));
  const masterInst = privates.find(i => i.type === 'master-bedroom');
  const ensuiteInst = front.find(i => i.type === 'ensuite');
  const walkinInst = front.find(i => i.type === 'walk-in-closet');
  const suite = Boolean(masterInst && ensuiteInst && privates.length > 1 && W > 6.5);
  const bedrooms = suite ? privates.filter(i => i !== masterInst) : privates;

  // --- band depths -----------------------------------------------------------
  const frontRooms = front;
  const frontArea = sum(frontRooms.map(i => i.prog.targetArea));
  const hasFrontDaylit = frontRooms.some(i => BACK_TYPES.has(i.type));
  const minFd = hasFrontDaylit ? 3.3 : o.accessible ? 2.8 : 2.4;
  const maxFd = Math.max(minFd, Math.min(4.4, D * 0.48));
  let Fd = frontRooms.length === 0 ? 0 : clamp(frontArea / W, minFd, maxFd);
  let Hd = bedrooms.length > 0 ? (o.accessible ? 1.4 : 1.25) : 0;
  // keep the daylit band from becoming a corridor of very deep rooms
  if (Fd > 0 && D - Fd - Hd > 5.4) Fd = clamp(D - Hd - 5.4, minFd, maxFd);
  if (Fd > 0 && D - Fd < 3.2) Fd = Math.max(0, D - 3.2);

  const backDepth = Math.max(1.0, D - Fd);
  let bedDepth = Math.max(2.4, backDepth - Hd);

  // --- front room assignment (which zone each service room sits over) -------
  const frontM: Inst[] = suite ? [ensuiteInst as Inst, ...(walkinInst ? [walkinInst] : [])] : [];
  const others = frontRooms.filter(i => !frontM.includes(i));
  const hasL = publics.length > 0;
  const hasP = bedrooms.length > 0 || !hasL;
  const frontL: Inst[] = [];
  const frontP: Inst[] = [];
  for (const i of others) {
    if (!hasP) { frontL.push(i); continue; }
    if (!hasL) { frontP.push(i); continue; }
    if (i.type === 'kitchen' || i.type === 'dining' || i.type === 'den' || i.type === 'study') frontL.push(i);
    else frontP.push(i);
  }

  // --- zone widths: driven by the daylit band only --------------------------
  // The service band is one continuous strip across the region, so service rooms are never
  // squeezed by the zone they happen to sit over; only daylit rooms set the zone widths.
  const zones: ZonePlan[] = [];
  const mkZone = (kind: 'L' | 'P' | 'M', backList: Inst[], frontList: Inst[], depth: number): ZonePlan => {
    const bMin = sum(backList.map(minW));
    const bRaw = depth > 0 ? sum(backList.map(i => i.prog.targetArea)) / depth : 0;
    return { kind, back: backList, front: frontList, depth, width: 0, minWidth: Math.max(bMin, 0.9), raw: Math.max(bRaw, bMin, 0.9) };
  };
  if (hasL) zones.push(mkZone('L', publics, frontL, backDepth));
  if (hasP) zones.push(mkZone('P', bedrooms, frontP, bedDepth));
  if (suite && masterInst) zones.push(mkZone('M', [masterInst], frontM, backDepth));

  // order along u: entry near the low edge for own-door / multi-level / dual-key plans
  const order: ('L' | 'P' | 'M')[] = entryAtLowEdge ? ['P', 'M', 'L'] : ['L', 'P', 'M'];
  zones.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));

  const rawTotal = sum(zones.map(z => z.raw));
  if (rawTotal > W) {
    const minTotal = sum(zones.map(z => z.minWidth));
    if (minTotal >= W - E) {
      const f = W / Math.max(minTotal, E);
      for (const z of zones) z.width = z.minWidth * f;
    } else {
      const excess = rawTotal - W;
      const slack = zones.map(z => z.raw - z.minWidth);
      const slackSum = sum(slack);
      zones.forEach((z, k) => { z.width = z.raw - (excess * slack[k]) / Math.max(slackSum, E); });
    }
  } else {
    const surplus = W - rawTotal;
    const wBack = zones.map(z => sum(z.back.map(i => i.prog.targetArea)) + 0.5);
    const wSum = sum(wBack);
    zones.forEach((z, k) => { z.width = z.raw + (surplus * wBack[k]) / Math.max(wSum, E); });
  }
  const wErr = W - sum(zones.map(z => z.width));
  if (zones.length > 0) zones[zones.length - 1].width += wErr;

  // hall depth from the hall program once zone P's width is known
  const zoneP = zones.find(z => z.kind === 'P');
  if (zoneP && Hd > 0) {
    const target = hallInst ? hallInst.prog.targetArea / Math.max(zoneP.width, 1) : Hd;
    Hd = clamp(target, o.accessible ? 1.4 : 1.15, 2.8);
    if (backDepth - Hd < 2.6) Hd = Math.max(1.0, backDepth - 2.6);
    bedDepth = Math.max(2.4, backDepth - Hd);
  }

  const cells: Cell[] = [];
  const anyBack = zones.some(z => z.back.length > 0);

  // --- service band: one continuous strip in zone order ---------------------
  const frontCells: Cell[] = [];
  if (Fd > 0) {
    let ordered: Inst[] = [];
    for (const z of zones) ordered.push(...orderFront(z, entryAtLowEdge));
    // a daylit room that could not stand in the façade band still gets a window if it takes the
    // end of the service band against a perpendicular exterior wall (ARC-26)
    const exiled = ordered.filter(i => i.prog.needsExterior === true && BACK_TYPES.has(i.type));
    if (exiled.length > 0 && (o.extLow || o.extHigh)) {
      const others = ordered.filter(i => !exiled.includes(i));
      ordered = o.extLow ? [...exiled, ...others] : [...others, ...exiled];
    }
    const items = ordered.map(i => toFitItem(i, Fd));
    const fit = fitWidths(items, W, 'service band', warnings);
    const widths = [...fit.widths];
    const kept = fit.kept.map(k => ordered[k]);
    if (fit.leftover > 0.7) { widths.push(fit.leftover); kept.push(fillerInst('storage', 7)); }
    else if (fit.leftover > E && widths.length > 0) { const add = fit.leftover / widths.length; for (let k = 0; k < widths.length; k++) widths[k] += add; }
    const strips = stripsXByWidths({ x: region.x, y: 0, w: W, h: anyBack ? Fd : D }, widths);
    strips.forEach((st, k) => {
      const inst = kept[k];
      const c: Cell = {
        type: inst.type, rect: st, prog: inst.prog, n: inst.n,
        wetEdge: WET_TYPES.has(inst.type) ? 'v+' : undefined,
      };
      frontCells.push(c);
      cells.push(c);
    });
    // XD-01: slide the wet cluster along the band so a bathroom column covers the requested
    // stack coordinate. Only the column ORDER changes, so the band still tiles exactly.
    if (o.stackU !== undefined) {
      o.stackHit = slideWetCluster(frontCells, region.x, o.stackU);
      if (!o.stackHit) {
        const at = frontCells.find(c => o.stackU! >= c.rect.x - E && o.stackU! <= c.rect.x + c.rect.w + E);
        o.stackBlockedBy = at?.type;
      }
    }
    // rooms that could not stand side by side go in a second row at the hall side of a
    // deep-enough service column (linen closet behind the bathroom, store behind the kitchen)
    // Only wet/service columns may carry a second row: the entry and the kitchen must keep their
    // own edge onto the hall or the living room, or the plan loses its circulation.
    const bandDepth = anyBack ? Fd : D;
    const rowDepth = clamp(bandDepth - 2.3, 0.9, anyBack ? 1.7 : 2.4);
    const hostRank = (c: Cell): number => (BATH_TYPES.has(c.type) ? 0 : c.type === 'laundry' || c.type === 'utility' || c.type === 'storage' ? 1 : 9);
    const queue = fit.dropped.map(di => ordered[di]);
    if (queue.length > 0 && rowDepth >= 0.9 && bandDepth - rowDepth >= 2.2) {
      const hosts = frontCells
        .filter(c => hostRank(c) < 9 && c.rect.h >= bandDepth - E)
        .sort((a, b) => hostRank(a) - hostRank(b) || b.rect.w - a.rect.w);
      for (const host of hosts) {
        if (queue.length === 0) break;
        const picks: Inst[] = [];
        let used = 0;
        while (queue.length > 0 && used + minW(queue[0]) <= host.rect.w + E) {
          const it = queue.shift() as Inst;
          picks.push(it);
          used += minW(it);
        }
        if (picks.length === 0) continue;
        host.rect.h = bandDepth - rowDepth;
        const rowFit = fitWidths(picks.map(i => toFitItem(i, rowDepth)), host.rect.w, 'second service row', warnings);
        const rw = [...rowFit.widths];
        if (rowFit.leftover > E && rw.length > 0) { const add = rowFit.leftover / rw.length; for (let k = 0; k < rw.length; k++) rw[k] += add; }
        const rowStrips = stripsXByWidths({ x: host.rect.x, y: bandDepth - rowDepth, w: host.rect.w, h: rowDepth }, rw);
        rowStrips.forEach((st, k) => {
          const inst = picks[rowFit.kept[k]];
          cells.push({
            type: inst.type, rect: st, prog: inst.prog, n: inst.n,
            wetEdge: WET_TYPES.has(inst.type) ? 'v-' : undefined,
          });
        });
      }
    }
    for (const inst of queue) o.dropped.push(inst.type);
  }
  if (!anyBack) {
    if (frontCells.length === 0) cells.push({ type: 'storage', rect: { x: region.x, y: 0, w: W, h: D }, n: 6, tag: 'filler' });
    return { cells, frontDepth: 0, hallDepth: 0 };
  }

  // --- daylit band, zone by zone --------------------------------------------
  let u = region.x;
  for (const z of zones) {
    const backTop = z.kind === 'P' && Hd > 0 ? Fd + Hd : Fd;
    if (z.kind === 'P' && Hd > 0) {
      cells.push({ type: 'hall', rect: { x: u, y: Fd, w: z.width, h: Hd }, n: 1, tag: 'hall', prog: hallInst?.prog });
    }
    const depth = Math.max(0.8, D - backTop);
    const ordered = orderBack(z, o);
    const items = ordered.map(i => toFitItem(i, depth));
    const fit = fitWidths(items, z.width, `${z.kind}-daylit`, warnings);
    const widths = [...fit.widths];
    const kept = fit.kept.map(k => ordered[k]);
    if (fit.leftover > E && widths.length > 0) { const add = fit.leftover / widths.length; for (let k = 0; k < widths.length; k++) widths[k] += add; }
    const strips = stripsXByWidths({ x: u, y: backTop, w: z.width, h: depth }, widths);
    strips.forEach((st, k) => {
      const inst = kept[k];
      cells.push({
        type: inst.type, rect: st, prog: inst.prog, n: inst.n,
        wetEdge: WET_TYPES.has(inst.type) ? 'v-' : undefined,
      });
    });
    u += z.width;
  }
  return { cells, frontDepth: Fd, hallDepth: Hd };
}

/**
 * XD-01: reorder a row of fixed-width columns so that a bathroom column covers `stackU`.
 * Widths are preserved (the row still tiles exactly) and the kitchen is kept immediately beside
 * the bathroom so their fixtures stay back to back on one wet wall (ARC-21).
 * Returns true when the requested coordinate ends up inside a bathroom span.
 */
function slideWetCluster(cells: Cell[], u0: number, stackU: number): boolean {
  // a daylit room parked at the end of the band is there for its window: leave it alone
  const pin = (c: Cell): boolean => BACK_TYPES.has(c.type);
  let p0 = 0;
  while (p0 < cells.length && pin(cells[p0])) p0++;
  let p1 = cells.length;
  while (p1 > p0 && pin(cells[p1 - 1])) p1--;
  const head = cells.slice(0, p0);
  const mid = cells.slice(p0, p1);
  const tail = cells.slice(p1);
  const base = u0 + sum(head.map(c => c.rect.w));
  const bath = mid.find(c => BATH_TYPES.has(c.type));
  if (!bath) return false;
  // The stack stands in the wet wall behind the whole cluster, so it may land anywhere along the
  // kitchen or the bathrooms; the bathroom is preferred because its branch is the longest.
  const wetScore = (list: Cell[]): number => {
    let acc = base;
    let best = Infinity;
    for (const c of list) {
      if (WET_TYPES.has(c.type)) {
        const margin = Math.min(0.2, c.rect.w / 4);
        const lo = acc + margin;
        const hi = acc + c.rect.w - margin;
        const d = (stackU < lo ? lo - stackU : stackU > hi ? stackU - hi : 0) + (BATH_TYPES.has(c.type) ? 0 : 0.05);
        best = Math.min(best, d);
      }
      acc += c.rect.w;
    }
    return best === Infinity ? 99 : best;
  };
  let best = mid;
  let bestScore = wetScore(mid);
  if (bestScore > E) {
    const kit = mid.find(c => c.type === 'kitchen' || c.type === 'living-kitchen');
    const others = mid.filter(c => c !== bath && c !== kit);
    for (const pair of kit ? [[bath, kit], [kit, bath]] : [[bath]]) {
      for (let k = 0; k <= others.length; k++) {
        const trial = [...others.slice(0, k), ...pair, ...others.slice(k)];
        const s = wetScore(trial);
        if (s < bestScore - 1e-9) { bestScore = s; best = trial; }
        if (bestScore <= E) break;
      }
      if (bestScore <= E) break;
    }
  }
  const out = [...head, ...best, ...tail];
  let acc = u0;
  for (const c of out) { c.rect.x = acc; acc += c.rect.w; }
  cells.length = 0;
  cells.push(...out);
  // the margin only ranks the candidates: a stack anywhere inside a wet room's span is a hit
  return out.some(c => WET_TYPES.has(c.type) && stackU >= c.rect.x - 0.02 && stackU <= c.rect.x + c.rect.w + 0.02);
}

function fillerInst(type: RoomType, n: number): Inst {
  return { type, n, prog: { type, count: 1, targetArea: 1.5, minArea: 0.8, minWidth: 0.7, needsExterior: false, wet: false, zone: 'service' as Zone, prefer: 'front' } };
}

/** Front-band column order: wet rooms adjacent to the neighbouring zone's kitchen (ARC-14/21). */
function orderFront(z: ZonePlan, entryAtLowEdge: boolean): Inst[] {
  const rank = (i: Inst): number => {
    if (i.type === 'entry') return entryAtLowEdge ? 0 : 3;
    if (BATH_TYPES.has(i.type)) return z.kind === 'P' ? 1 : 2;
    if (i.type === 'kitchen') return z.kind === 'L' ? 8 : 2;
    if (i.type === 'dining' || i.type === 'den' || i.type === 'study') return 6;
    if (BACK_TYPES.has(i.type)) return 5;
    return 4;
  };
  return [...z.front].sort((a, b) => rank(a) - rank(b) || b.prog.targetArea - a.prog.targetArea);
}

/** Daylit band order: living toward an exterior corner (ARC-26), bedrooms largest farthest. */
function orderBack(z: ZonePlan, o: PlanOpts): Inst[] {
  if (z.kind === 'P') return [...z.back].sort((a, b) => a.prog.targetArea - b.prog.targetArea);
  const rank = (i: Inst): number => (i.type === 'living' || i.type === 'living-kitchen' || i.type === 'shared-living' ? 0 : i.type === 'dining' ? 1 : 2);
  const sorted = [...z.back].sort((a, b) => rank(a) - rank(b));
  // if the outer exterior side is at the high-u end, flip so the living room takes that corner
  if (o.extHigh && !o.extLow) sorted.reverse();
  return sorted;
}

// --- through unit: dual-aspect side entry (ARC-36) --------------------------

/** One column of the through plan, spanning `vDepth` from `vTop`, filled with a v-stack of rooms. */
interface ThroughCol {
  kind: 'band' | 'service' | 'spur';
  rooms: Inst[];
  vTop: number;
  vDepth: number;
  min: number;
  raw: number;
  max: number;
  /** may be dropped when the frontage runs short */
  optional: boolean;
  width: number;
  end?: 'low' | 'high';
}

/**
 * Is the through plan (daylight on the two ends of u, hall along the access wall) the right plan
 * for this rect? True when the side opposite the entry is NOT glazed but a perpendicular side is —
 * the mansion-block / walk-up landing unit — or when the end façades are simply longer than the
 * far wall, which is the case for any unit deeper than it is wide.
 */
function useThroughPlan(F: number, D: number, insts: Inst[], o: PlanOpts): boolean {
  if (o.accessExterior || o.flipV) return false;
  if (!o.extLow && !o.extHigh) return false;
  const hallD = o.accessible ? 1.5 : 1.2;
  if (D < hallD + 2.4 || F < 5.4) return false;
  // nothing else can light this unit: the only glazed walls are the ends of u
  if (!o.extFar) return true;
  // too shallow for the zoned plan's service band plus a daylit band on the far wall
  if (D < 5.4) return true;
  // both plans are possible. The through plan stands every daylit room and every service room
  // side by side along the frontage, so it only wins on a unit deeper than it is wide AND with
  // enough frontage to take all of those columns at once.
  const daylit = insts.filter(i => i.prog.needsExterior === true && !BATH_TYPES.has(i.type));
  const svc = insts.filter(i => !daylit.includes(i) && (WET_TYPES.has(i.type) || PRIVATE_TYPES.has(i.type)));
  const need = sum(daylit.map(minWidthOf)) + sum(svc.map(i => Math.min(minWidthOf(i), D - hallD)));
  return D > F + 1.0 && need <= F;
}

function planThrough(F: number, D: number, insts: Inst[], o: PlanOpts): PlanResult {
  const warnings = o.warnings;
  // no glazed end to hang a band on: there is nothing for this plan type to do
  if (!o.extLow && !o.extHigh) return planStandard(F, D, insts, o);
  const hallD = clamp(o.accessible ? 1.5 : 1.2, 1.1, Math.max(1.1, D - 2.4));
  const sd = D - hallD;

  const hallInst = insts.find(i => i.type === 'hall');
  const entryInst = insts.find(i => i.type === 'entry');
  const rest = insts.filter(i => i !== hallInst && i !== entryInst && i.type !== 'corridor');
  const daylit = rest.filter(i => i.prog.needsExterior === true && !BATH_TYPES.has(i.type));
  const service = rest.filter(i => !daylit.includes(i));

  // --- which end takes the public rooms: the better solar exposure (APL #128) ---
  const ends: ('low' | 'high')[] = [];
  if (o.extLow) ends.push('low');
  if (o.extHigh) ends.push('high');
  const pubEnd: 'low' | 'high' = ends.length > 1 ? (o.solarLow >= o.solarHigh ? 'low' : 'high') : ends[0];
  const privEnd: 'low' | 'high' | null = ends.length > 1 ? (pubEnd === 'low' ? 'high' : 'low') : null;

  const band: Record<'low' | 'high', Inst[]> = { low: [], high: [] };
  if (privEnd) {
    band[pubEnd] = daylit.filter(i => !PRIVATE_TYPES.has(i.type));
    band[privEnd] = daylit.filter(i => PRIVATE_TYPES.has(i.type));
    // a bedroom-only unit (or a template with no private rooms) still deserves both façades
    if (band[pubEnd].length === 0) { band[pubEnd] = band[privEnd].slice(0, 1); band[privEnd] = band[privEnd].slice(1); }
  } else {
    band[pubEnd] = [...daylit.filter(i => !PRIVATE_TYPES.has(i.type)), ...daylit.filter(i => PRIVATE_TYPES.has(i.type))];
  }

  // --- feasibility: each façade is only D long -----------------------------
  const internal: Inst[] = [];
  for (const e of ends) {
    let guard = 0;
    while (band[e].length > 1 && sum(band[e].map(minWidthOf)) > D + 0.05 && guard++ < 8) {
      const cand = [...band[e]].sort((a, b) => minWidthOf(a) - minWidthOf(b) || a.prog.targetArea - b.prog.targetArea)[0];
      band[e] = band[e].filter(i => i !== cand);
      const other: 'low' | 'high' | null = e === 'low' ? (o.extHigh ? 'high' : null) : (o.extLow ? 'low' : null);
      if (other && sum([...band[other], cand].map(minWidthOf)) <= D + 0.05) band[other].push(cand);
      else internal.push(cand);
    }
  }

  // --- service rooms packed into columns on the party wall -----------------
  // Each column carries ONE room that needs its own door off the hall (kitchen, bathroom, a
  // bedroom that lost its façade) in the slot against the hall strip, with cupboards, the laundry
  // and stores stacked behind it on the party wall. Nothing is ever reached through a bathroom.
  const rank = (t: RoomType): number => (t === 'kitchen' || t === 'living-kitchen' || t === 'shared-kitchen' ? 0
    : t === 'bathroom' ? 1 : t === 'ensuite' || t === 'powder' || t === 'wc' ? 2
    : t === 'laundry' || t === 'utility' ? 3 : t === 'bedroom' || t === 'master-bedroom' ? 6 : 4);
  const secondary = (t: RoomType): boolean => t === 'closet' || t === 'walk-in-closet' || t === 'storage' || t === 'laundry' || t === 'utility';
  const packs: Inst[][] = service.filter(i => !secondary(i.type))
    .sort((a, b) => rank(a.type) - rank(b.type) || b.prog.targetArea - a.prog.targetArea)
    .map(i => [i]);
  // a room that lost its façade keeps a full-depth column: it then touches the hall AND, where the
  // far side is glazed, the party-side exterior wall, so it can still be given a window
  for (const i of internal) packs.push([i]);
  const packRaw = (p: Inst[]): number => Math.max(
    sum(p.map(r => r.prog.targetArea)) / sd,
    ...p.map(r => Math.min(minWidthOf(r), sd)),
  );
  const packMin = (p: Inst[]): number => Math.max(
    0.9,
    sum(p.map(r => r.prog.minArea)) / sd,
    ...p.map(r => Math.min(minWidthOf(r), sd)),
  );
  const packV = (p: Inst[]): number => sum(p.map(r => minWidthOf(r)));
  const hostScore = (p: Inst[], s: Inst): number => {
    const h = p[0].type;
    if (PRIVATE_TYPES.has(h) || BACK_TYPES.has(h)) return 99;
    if (s.type === 'laundry' || s.type === 'utility') return h === 'kitchen' ? 0 : BATH_TYPES.has(h) ? 1 : 3;
    return h === 'kitchen' ? 1 : BATH_TYPES.has(h) ? 0 : 2;
  };
  for (const s of service.filter(i => secondary(i.type)).sort((a, b) => b.prog.targetArea - a.prog.targetArea)) {
    const host = packs
      .filter(p => hostScore(p, s) < 99 && packV([...p, s]) <= sd - 0.1)
      .sort((a, b) => hostScore(a, s) - hostScore(b, s) || packV(a) - packV(b))[0];
    if (host) host.push(s);
    else packs.push([s]);
  }
  packs.sort((a, b) => rank(a[0].type) - rank(b[0].type));
  if (pubEnd === 'high') packs.reverse();

  // --- columns in u order --------------------------------------------------
  const cols: ThroughCol[] = [];
  const mkBand = (e: 'low' | 'high'): void => {
    const rooms = orderBandV(band[e], o);
    if (rooms.length === 0) return;
    const min = Math.max(1.6, sum(rooms.map(r => r.prog.minArea)) / D, ...rooms.map(minWidthOf));
    const raw = Math.max(min, sum(rooms.map(r => r.prog.targetArea)) / D);
    const max = Math.max(raw, Math.min(...rooms.map(r => Math.max(limitOf(r.type).maxWidth, limitOf(r.type).maxDepth))));
    cols.push({ kind: 'band', rooms, vTop: 0, vDepth: D, min, raw, max, optional: false, width: 0, end: e });
  };
  const mkSpur = (e: 'low' | 'high'): void => {
    const rooms = band[e];
    if (rooms.length < 2) return;
    // rooms behind the first one need their own way out: a bedroom may not be a passage (APL #127)
    const needs = rooms.slice(1).some(r => !OPEN_PLAN.has(r.type));
    if (!needs) return;
    const w = clamp(hallD, 1.0, 1.4);
    cols.push({ kind: 'spur', rooms: [], vTop: hallD, vDepth: sd, min: w, raw: w, max: w, optional: true, width: 0, end: e });
  };
  mkBand('low');
  mkSpur('low');
  for (const p of packs) {
    // keep service columns close to the width their rooms actually need: the surplus of a
    // generous rect belongs to the living room and the bedrooms, not to the cupboards
    cols.push({
      kind: 'service', rooms: p, vTop: hallD, vDepth: sd,
      min: packMin(p), raw: Math.max(packMin(p), packRaw(p)),
      max: Math.max(packMin(p), sum(p.map(r => r.prog.targetArea)) / sd + 0.5),
      optional: p.every(r => DROPPABLE.has(r.type)), width: 0,
    });
  }
  mkSpur('high');
  mkBand('high');

  // --- degrade until the columns fit the frontage --------------------------
  const minTotal = (): number => sum(cols.map(c => c.min));
  let guard = 0;
  while (minTotal() > F - 1.4 && guard++ < 16) {
    const dry = cols.map((c, k) => ({ c, k })).filter(x => x.c.kind === 'service' && x.c.optional);
    if (dry.length > 0) {
      const victim = dry.sort((a, b) => a.c.min - b.c.min)[0];
      for (const r of victim.c.rooms) o.dropped.push(r.type);
      cols.splice(victim.k, 1);
      continue;
    }
    const spur = cols.map((c, k) => ({ c, k })).filter(x => x.c.kind === 'spur')
      .sort((a, b) => (a.c.end === pubEnd ? 0 : 1) - (b.c.end === pubEnd ? 0 : 1))[0];
    if (spur) { cols.splice(spur.k, 1); continue; }
    break;
  }
  const items: FitItem[] = cols.map((c, k) => ({
    key: `col${k}`, min: c.min, target: clamp(c.raw, c.min, c.max), max: Math.max(c.max, c.min), drop: false,
    type: c.rooms[0]?.type,
  }));
  const fit = fitWidths(items, F, 'through plan', warnings);
  fit.kept.forEach((ci, k) => { cols[ci].width = fit.widths[k]; });
  if (fit.leftover > E && cols.length > 0) {
    const bands = cols.filter(c => c.kind === 'band');
    const share = bands.length > 0 ? bands : cols;
    for (const c of share) c.width += fit.leftover / share.length;
  }
  const err = F - sum(cols.map(c => c.width));
  if (cols.length > 0) cols[cols.length - 1].width += err;
  // keep the tiling exact while nothing ends up narrower than a doorway: a column that got
  // squeezed to a sliver borrows from the widest one instead of being dropped
  for (let pass = 0; pass < 3; pass++) {
    const thin = cols.filter(c => c.width < 0.4);
    if (thin.length === 0) break;
    let moved = 0;
    for (const c of thin) {
      const widest = cols.reduce((m, x) => (x.width > m.width ? x : m), cols[0]);
      const need = 0.4 - c.width;
      if (widest === c || widest.width - need < 0.9) continue;
      c.width += need;
      widest.width -= need;
      moved++;
    }
    if (moved === 0) break;
  }

  // --- emit cells ----------------------------------------------------------
  const cells: Cell[] = [];
  let u = 0;
  let stripLo = 0;
  let stripHi = F;
  const wetSpan = { lo: F, hi: 0 };
  /** u boundaries of the columns under the hall strip, so the strip can be split in line with them */
  const inner: number[] = [];
  for (const c of cols) {
    if (c.kind === 'band' && c.end === 'low') stripLo = u + c.width;
    if (c.kind === 'band' && c.end === 'high') stripHi = u;
    if (c.kind !== 'band') inner.push(u);
    if (c.kind === 'spur') {
      cells.push({ type: 'hall', rect: { x: u, y: c.vTop, w: c.width, h: c.vDepth }, n: 5, tag: 'hall', prog: hallInst?.prog });
    } else {
      const depth = c.vDepth;
      const fitV = fitWidths(c.rooms.map(r => toFitItem(r, c.width)), depth, c.kind === 'band' ? `${c.end}-façade` : 'service column', warnings);
      const hs = [...fitV.widths];
      const kept = fitV.kept.map(k => c.rooms[k]);
      for (const di of fitV.dropped) o.dropped.push(c.rooms[di].type);
      if (hs.length === 0) { hs.push(depth); kept.push(fillerInst('storage', 30 + cells.length)); }
      else if (Math.abs(sum(hs) - depth) > E) { const add = (depth - sum(hs)) / hs.length; for (let k = 0; k < hs.length; k++) hs[k] += add; }
      const strips = stripsYByHeights({ x: u, y: c.vTop, w: c.width, h: depth }, hs);
      strips.forEach((st, k) => {
        const inst = kept[k];
        const wet = WET_TYPES.has(inst.type);
        if (wet && c.kind === 'service') { wetSpan.lo = Math.min(wetSpan.lo, u); wetSpan.hi = Math.max(wetSpan.hi, u + c.width); }
        cells.push({
          type: inst.type, rect: st, prog: inst.prog, n: inst.n,
          daylightWaived: internal.includes(inst) && !o.extFar,
        });
      });
    }
    u += c.width;
  }
  // --- hall strip along the access wall, with the entry carved out of it ---
  // The strip is cut only ON column boundaries, so every room under it keeps its FULL width onto
  // one circulation room and its door never has to squeeze into a 0.7 m offcut (ARC-28).
  const stripW = Math.max(0, stripHi - stripLo);
  if (stripW > 0.5) {
    const cuts = [stripLo, ...inner.filter(x => x > stripLo + E && x < stripHi - E), stripHi];
    const ew = clamp(entryInst ? entryInst.prog.targetArea / hallD : 2.0, 1.3, Math.min(3.0, stripW));
    // the run of whole columns closest to `ew` and to the middle of the strip becomes the entry
    let best: { lo: number; hi: number; score: number } | null = null;
    for (let i = 0; i < cuts.length - 1; i++) {
      for (let j = i + 1; j < cuts.length; j++) {
        const w = cuts[j] - cuts[i];
        if (w < 1.3 - E && j < cuts.length - 1) continue;
        const centre = (cuts[i] + cuts[j]) / 2;
        const score = Math.abs(w - ew) + 0.35 * Math.abs(centre - (stripLo + stripHi) / 2);
        if (w > 3.4 + E) continue;
        if (!best || score < best.score) best = { lo: cuts[i], hi: cuts[j], score };
      }
    }
    const eLo = best ? best.lo : stripLo;
    const eHi = best ? best.hi : stripHi;
    const parts: { t: RoomType; lo: number; hi: number }[] = [];
    if (eLo > stripLo + E) parts.push({ t: 'hall', lo: stripLo, hi: eLo });
    parts.push({ t: 'entry', lo: eLo, hi: eHi });
    if (eHi < stripHi - E) parts.push({ t: 'hall', lo: eHi, hi: stripHi });
    parts.forEach((p, k) => {
      cells.push({
        type: p.t, rect: { x: p.lo, y: 0, w: p.hi - p.lo, h: hallD }, n: k + 1, tag: 'hall',
        prog: p.t === 'entry' ? entryInst?.prog : hallInst?.prog,
      });
    });
  }
  // --- wet edges: the wall shared by the kitchen and the bathroom ----------
  markThroughWetEdges(cells, hallD);
  if (internal.length > 0 && !o.extFar) {
    warnings.push(`${internal.map(i => i.type).join(', ')} placed away from the façade: a through unit ${round(D, 2)} m wide offers ${round(ends.length * D, 2)} m of end façade for ${round(sum(daylit.map(minWidthOf)), 2)} m of habitable rooms`);
  }
  return {
    cells, frontDepth: D, hallDepth: hallD, kind: 'through',
    wetSpan: wetSpan.hi > wetSpan.lo ? wetSpan : undefined,
  };
}

/** Order the rooms of one façade band along v: public near the entry, the master farthest (APL #127). */
function orderBandV(rooms: Inst[], o: PlanOpts): Inst[] {
  const rank = (i: Inst): number => {
    if (i.type === 'living' || i.type === 'living-kitchen' || i.type === 'shared-living') return 0;
    if (i.type === 'dining' || i.type === 'kitchen') return 1;
    if (i.type === 'study' || i.type === 'den' || i.type === 'flex') return 2;
    if (i.type === 'master-bedroom') return 9;
    return 5;
  };
  const sorted = [...rooms].sort((a, b) => rank(a) - rank(b) || a.prog.targetArea - b.prog.targetArea);
  // where the far wall is glazed as well, the living room takes the corner (ARC-26 / APL #159)
  if (o.extFar && sorted.length > 1 && rank(sorted[0]) === 0 && sorted.every(i => !PRIVATE_TYPES.has(i.type))) {
    sorted.push(sorted.shift() as Inst);
  }
  return sorted;
}

/**
 * Point every wet room's fixture wall at the neighbour it shares plumbing with: the kitchen and the
 * bathroom stand back to back on one wall (ARC-21), and a lone wet room backs onto the hall strip
 * so its stack still lands in a partition the organizer can chase (ARC-14).
 */
function markThroughWetEdges(cells: Cell[], hallD: number): void {
  const wet = cells.filter(c => WET_TYPES.has(c.type));
  for (const c of wet) {
    const touching = (other: Cell, dir: LDir): boolean => {
      if (dir === 'u+' || dir === 'u-') {
        const edge = dir === 'u+' ? c.rect.x + c.rect.w : c.rect.x;
        const onIt = dir === 'u+' ? Math.abs(other.rect.x - edge) < 1e-3 : Math.abs(other.rect.x + other.rect.w - edge) < 1e-3;
        return onIt && Math.min(c.rect.y + c.rect.h, other.rect.y + other.rect.h) - Math.max(c.rect.y, other.rect.y) > MIN_EDGE;
      }
      const edge = dir === 'v+' ? c.rect.y + c.rect.h : c.rect.y;
      const onIt = dir === 'v+' ? Math.abs(other.rect.y - edge) < 1e-3 : Math.abs(other.rect.y + other.rect.h - edge) < 1e-3;
      return onIt && Math.min(c.rect.x + c.rect.w, other.rect.x + other.rect.w) - Math.max(c.rect.x, other.rect.x) > MIN_EDGE;
    };
    const dirs: LDir[] = ['u+', 'u-', 'v+', 'v-'];
    let picked: LDir | undefined;
    for (const d of dirs) {
      if (wet.some(o2 => o2 !== c && touching(o2, d))) { picked = d; break; }
    }
    if (!picked) {
      // back onto the hall strip when there is no wet neighbour
      picked = Math.abs(c.rect.y - hallD) < 1e-3 ? 'v-' : 'v+';
    }
    c.wetEdge = picked;
  }
}

// --- cluster (co-living) ----------------------------------------------------

function planCluster(F: number, D: number, insts: Inst[], o: PlanOpts): PlanResult {
  const cells: Cell[] = [];
  const warnings = o.warnings;
  const beds = insts.filter(i => i.type === 'bedroom');
  const ensuites = insts.filter(i => i.type === 'ensuite');
  const sharedLiving = insts.find(i => i.type === 'shared-living');
  const sharedKitchen = insts.find(i => i.type === 'shared-kitchen');
  const entryInst = insts.find(i => i.type === 'entry');
  const laundryInst = insts.find(i => i.type === 'laundry');
  const storeInst = insts.find(i => i.type === 'storage');
  const corridorInst = insts.find(i => i.type === 'corridor');

  const cw = clamp(corridorInst ? 1.4 : 1.3, 1.2, Math.max(1.2, F * 0.16));
  const sharedArea = (sharedLiving?.prog.targetArea ?? 26) + (sharedKitchen?.prog.targetArea ?? 16);
  const sd = clamp(sharedArea / F, 3.6, Math.max(3.6, D * 0.35));
  const entryD = clamp(entryInst ? entryInst.prog.targetArea / cw : 2.2, 1.6, 3.0);
  const uc = (F - cw) / 2;
  const rowTop = 0;
  const rowBottom = D - sd;
  const rowSpan = rowBottom - rowTop;
  if (rowSpan < 3.0 || uc < 2.6) {
    warnings.push(`cluster rect ${F.toFixed(1)} × ${D.toFixed(1)} m is too small for ${beds.length} en-suite rooms; falling back to the standard plan`);
    return planStandard(F, D, insts, o);
  }

  // corridor + entry down the middle
  cells.push({ type: 'entry', rect: { x: uc, y: 0, w: cw, h: entryD }, n: 1, prog: entryInst?.prog });
  cells.push({ type: 'corridor', rect: { x: uc, y: entryD, w: cw, h: rowBottom - entryD }, n: 1, tag: 'hall', prog: corridorInst?.prog });

  // bedroom rows either side, each row = bedroom + (en-suite over closet)
  const perSide = [Math.ceil(beds.length / 2), Math.floor(beds.length / 2)];
  const sides: { u0: number; w: number; wetDir: LDir; ensuiteAtHigh: boolean }[] = [
    { u0: 0, w: uc, wetDir: 'u+', ensuiteAtHigh: true },
    { u0: uc + cw, w: F - uc - cw, wetDir: 'u-', ensuiteAtHigh: false },
  ];
  let bi = 0;
  let extraIdx = 0;
  const extras: (Inst | undefined)[] = [laundryInst, storeInst];
  for (let s = 0; s < 2; s++) {
    const side = sides[s];
    const rows = Math.max(1, perSide[s]);
    const rowH = rowSpan / rows;
    for (let r = 0; r < rows; r++) {
      const bed = beds[bi];
      const ens = ensuites[bi];
      bi++;
      const y = rowTop + r * rowH;
      const ew = clamp((ens?.prog.targetArea ?? 3.9) / Math.min(rowH, 2.6), 1.5, Math.max(1.5, side.w * 0.42));
      const bedW = side.w - ew;
      const bedX = side.ensuiteAtHigh ? side.u0 : side.u0 + ew;
      const ensX = side.ensuiteAtHigh ? side.u0 + bedW : side.u0;
      if (bed) {
        cells.push({ type: 'bedroom', rect: { x: bedX, y, w: bedW, h: rowH }, n: bed.n, prog: bed.prog });
      } else {
        cells.push({ type: 'storage', rect: { x: bedX, y, w: bedW, h: rowH }, n: 20 + r, tag: 'filler' });
      }
      const ensH = clamp((ens?.prog.targetArea ?? 3.9) / ew, 2.0, rowH);
      cells.push({
        type: 'ensuite', rect: { x: ensX, y, w: ew, h: ensH }, n: ens?.n ?? bi, prog: ens?.prog,
        wetEdge: side.wetDir, prefParent: 'bedroom',
      });
      if (rowH - ensH > 0.8) {
        const extra = extras[extraIdx];
        if (extra) extraIdx++;
        cells.push({
          type: extra?.type ?? 'closet', rect: { x: ensX, y: y + ensH, w: ew, h: rowH - ensH },
          n: extra?.n ?? bi, prog: extra?.prog, tag: extra ? undefined : 'filler',
          wetEdge: extra && WET_TYPES.has(extra.type) ? side.wetDir : undefined,
        });
      } else if (rowH - ensH > E) {
        cells[cells.length - 1].rect.h = rowH;
      }
    }
  }

  // shared kitchen + living across the daylit end
  const kw = sharedKitchen ? clamp(sharedKitchen.prog.targetArea / sd, sharedKitchen.prog.minWidth, F * 0.5) : 0;
  if (sharedKitchen) {
    cells.push({ type: 'shared-kitchen', rect: { x: 0, y: rowBottom, w: kw, h: sd }, n: 1, prog: sharedKitchen.prog, wetEdge: 'v-' });
  }
  cells.push({
    type: 'shared-living', rect: { x: kw, y: rowBottom, w: F - kw, h: sd }, n: 1,
    prog: sharedLiving?.prog,
  });
  return { cells, frontDepth: 0, hallDepth: cw };
}

// --- dual-key ---------------------------------------------------------------

function planDualKey(F: number, D: number, insts: Inst[], o: PlanOpts): PlanResult {
  const warnings = o.warnings;
  const studioLiving = insts.find(i => i.type === 'living-kitchen');
  const studioBath = insts.filter(i => i.type === 'ensuite').pop();
  if (!studioLiving || !studioBath) {
    warnings.push('dual-key template needs a living-kitchen and an en-suite for the lock-off studio');
    return planStandard(F, D, insts, o);
  }
  const rest = insts.filter(i => i !== studioLiving && i !== studioBath);
  const studioArea = studioLiving.prog.targetArea + studioBath.prog.targetArea + 3.4;
  const Sw = clamp(studioArea / D, 3.0, Math.max(3.0, Math.min(4.8, F * 0.4)));
  const Fd = clamp(studioBath.prog.targetArea / clamp(Sw * 0.5, 1.5, 2.1), 2.2, 2.8);
  const bw = clamp(studioBath.prog.targetArea / Fd, 1.5, Math.max(1.5, Sw - 1.1));
  const cells: Cell[] = [
    { type: 'ensuite', rect: { x: 0, y: 0, w: bw, h: Fd }, n: studioBath.n, prog: studioBath.prog, wetEdge: 'v+', sub: 'studio' },
    { type: 'hall', rect: { x: bw, y: 0, w: Sw - bw, h: Fd }, n: 2, tag: 'hall', sub: 'studio' },
    { type: 'living-kitchen', rect: { x: 0, y: Fd, w: Sw, h: D - Fd }, n: studioLiving.n, prog: studioLiving.prog, wetEdge: 'v-', sub: 'studio' },
  ];
  const region: Rect = { x: Sw, y: 0, w: F - Sw, h: D };
  const main = planRegion(region, rest, o, true);
  for (const c of main.cells) c.sub = 'main';
  return { cells: [...cells, ...main.cells], frontDepth: main.frontDepth, hallDepth: main.hallDepth };
}

// ============================================================================
// Opening allocation (no two openings overlap on one wall)
// ============================================================================

interface Taken { a: number; b: number }

function makeOpeningTracker(): {
  reserve(wallId: string, lo: number, hi: number, width: number, prefer: number, margin?: number): number | null;
  usedArea(wallId: string, lo: number, hi: number): number;
  add(wallId: string, centre: number, width: number, area: number): void;
} {
  const spans = new Map<string, Taken[]>();
  const areas = new Map<string, { a: number; b: number; area: number }[]>();
  const free = (wallId: string, a: number, b: number): boolean => {
    const list = spans.get(wallId) ?? [];
    return list.every(t => b <= t.a + 1e-9 || a >= t.b - 1e-9);
  };
  return {
    reserve(wallId, lo, hi, width, prefer, margin = 0.15) {
      if (width <= 0.05 || hi - lo < width + 2 * margin - 1e-9) return null;
      const min = lo + margin + width / 2;
      const max = hi - margin - width / 2;
      const start = clamp(prefer, min, max);
      for (let step = 0; step <= 60; step++) {
        for (const s of step === 0 ? [0] : [step, -step]) {
          const c = start + s * 0.05;
          if (c < min - 1e-9 || c > max + 1e-9) continue;
          if (free(wallId, c - width / 2 - margin, c + width / 2 + margin)) {
            const list = spans.get(wallId) ?? [];
            list.push({ a: c - width / 2 - margin, b: c + width / 2 + margin });
            spans.set(wallId, list);
            return c;
          }
        }
      }
      return null;
    },
    usedArea(wallId, lo, hi) {
      const list = areas.get(wallId) ?? [];
      return sum(list.filter(x => x.b > lo + 1e-9 && x.a < hi - 1e-9).map(x => x.area));
    },
    add(wallId, centre, width, area) {
      const list = areas.get(wallId) ?? [];
      list.push({ a: centre - width / 2, b: centre + width / 2, area });
      areas.set(wallId, list);
    },
  };
}

// ============================================================================
// Room / wall / door records
// ============================================================================

interface RoomRec {
  id: string;
  cell: Cell;
  local: Rect;
  world: Rect;
  def: RoomDef;
  wet: boolean;
  outside: boolean;
}

interface Adj {
  a: number;
  b: number;
  /** 'u' = the shared edge runs along u (constant v); 'v' = runs along v (constant u) */
  axis: 'u' | 'v';
  coord: number;
  s0: number;
  s1: number;
  wallId?: string;
}

function facingOf(v: Vec2): number {
  if (Math.abs(v[1]) > Math.abs(v[0])) return v[1] > 0 ? 0 : Math.PI;
  return v[0] < 0 ? Math.PI / 2 : (3 * Math.PI) / 2;
}

// ============================================================================
// layoutUnit
// ============================================================================

export const layoutUnit: UnitLayoutFn = (req: UnitLayoutRequest): UnitLayout => {
  const warnings: string[] = [];
  const t = req.template;
  const ids = new IdFactory('architecture');
  const scope = req.levelsTotal > 1 ? `${req.unitId}-L${req.level}` : req.unitId;
  const nid = (kind: string): string => ids.next(scope, kind);
  const frame = makeFrame(req.rect, req.accessSide);
  const F = frame.F;
  const D = frame.D;
  const wallH = Math.max(2.2, req.floorToFloor - SIZES.slabT);
  const accessible = t.id === 'senior-1b-accessible';
  const interiorDoorW = accessible ? 0.9 : SIZES.doorInterior;
  const bathDoorW = accessible ? 0.9 : SIZES.doorBathroom;
  const exteriorSides = new Set<Side>(req.exteriorSides);
  const localExt = (s: Side): boolean => exteriorSides.has(frame.side(s));

  if (req.wetWallSide !== req.accessSide) {
    warnings.push(`wetWallSide '${req.wetWallSide}' differs from accessSide '${req.accessSide}'; the wet band is kept on the access side so stacks stay by the corridor (ARC-14)`);
  }

  // --- program + plan --------------------------------------------------------
  const insts = programForLevel(t, req.level, req.levelsTotal, warnings);
  if (insts.length === 0) {
    warnings.push(`no rooms assigned to level ${req.level} of template ${t.id}`);
  }
  const southern = req.region === 'AU' || req.region === 'NZ';
  const solarOf = (ls: Side): number => {
    const c = req.exposures[frame.side(ls)];
    return c ? solarScore(c, southern) : 0;
  };
  const opts: PlanOpts = {
    accessible,
    level: req.level,
    levelsTotal: req.levelsTotal,
    floorToFloor: req.floorToFloor,
    accessExterior: exteriorSides.has(req.accessSide),
    extLow: localExt('left'),
    extHigh: localExt('right'),
    extFar: localExt('rear'),
    solarLow: solarOf('left'),
    solarHigh: solarOf('right'),
    solarFar: solarOf('rear'),
    stackU: req.stackAlong === undefined ? undefined : frame.alongToU(req.stackAlong),
    flipV: !localExt('rear') && localExt('front'),
    stairLocal: req.stairRect ? frame.toLocalRect(req.stairRect) : undefined,
    warnings,
    dropped: [],
  };
  if (opts.flipV) {
    warnings.push('unit is single-aspect toward the access side: daylit rooms placed on the access side with the service band at the back');
  }
  const wantsThrough = t.id !== 'coliving-cluster' && t.id !== 'dual-key'
    && !insts.some(i => i.type === 'stair' || i.type === 'garage')
    && useThroughPlan(F, D, insts, opts);
  let plan: PlanResult;
  if (t.id === 'coliving-cluster') plan = planCluster(F, D, insts, opts);
  else if (t.id === 'dual-key') plan = planDualKey(F, D, insts, opts);
  else if (wantsThrough) plan = planThrough(F, D, insts, opts);
  else plan = planStandard(F, D, insts, opts);

  // --- plumbing stack position (XD-01) --------------------------------------
  // The slot rect is identical on every storey, so the wet cluster lands on the same local
  // coordinate on every floor and the stacks line up whatever `stackAlong` asks for. Only warn
  // when the wet cluster could have covered the requested coordinate and did not.
  const stackAtU = wetStackU(plan, opts.stackU);
  // A room parked at the end of the band for its window, or a coordinate that lands outside the
  // wet band altogether, is a deliberate choice rather than a failure — the stacks still line up.
  const stackBlocker = opts.stackBlockedBy;
  if (opts.stackU !== undefined && plan.kind !== 'through' && opts.stackHit === false && plan.frontDepth > 0
    && stackBlocker !== undefined && !BACK_TYPES.has(stackBlocker)) {
    const baths = plan.cells.filter(c => BATH_TYPES.has(c.type));
    if (baths.length > 0) {
      warnings.push(`requested stack position u=${opts.stackU.toFixed(2)} m sits in the ${stackBlocker} and no order of the wet band covers it; the stack is placed at u=${stackAtU.toFixed(2)} m instead`);
    }
  }

  // --- rooms merged into furniture instead of being planned (ARC-27/ARC-30) --
  const mergedRooms = opts.dropped.filter(x => SILENT_DROP.has(x));
  const lostRooms = opts.dropped.filter(x => !SILENT_DROP.has(x));
  if (lostRooms.length > 0) {
    const tally = new Map<RoomType, number>();
    for (const x of lostRooms) tally.set(x, (tally.get(x) ?? 0) + 1);
    warnings.push(`no room for ${[...tally].map(([k, n]) => (n > 1 ? `${n} × ${k}` : k)).join(', ')} in a ${round(F, 2)} × ${round(D, 2)} m rect (${round(F * D, 1)} m² against a ${t.area.min} m² minimum for ${t.id})`);
  }

  // --- rooms -----------------------------------------------------------------
  const rooms: RoomRec[] = [];
  const typeCount = new Map<RoomType, number>();
  const levelOffset = req.levelsTotal > 1 ? req.level * 20 : 0;
  for (const cell of plan.cells) {
    if (cell.rect.w < 0.2 || cell.rect.h < 0.2) {
      warnings.push(`dropped ${cell.type}: resolved to ${cell.rect.w.toFixed(2)} × ${cell.rect.h.toFixed(2)} m`);
      continue;
    }
    rooms.push(makeRoom(cell, false));
  }

  function makeRoom(cell: Cell, outside: boolean): RoomRec {
    const n = (typeCount.get(cell.type) ?? 0) + 1;
    typeCount.set(cell.type, n);
    const world = frame.toWorldRect(cell.rect);
    const id = roomId(req.unitId, cell.type, levelOffset + n);
    const area = round(world.w * world.h, 3);
    const wet = cell.prog?.wet ?? WET_TYPES.has(cell.type);
    const def: RoomDef = {
      id,
      storey: req.storey,
      unitId: req.unitId,
      type: cell.type,
      name: roomName(cell.type, n, req.region, typeTotal(plan.cells, cell.type)),
      polygon: rectToPolygon(world),
      rect: world,
      area,
      height: req.ceilingHeight,
      isWet: wet,
      hasExterior: false,
      exteriorWallIds: [],
      wallIds: [],
      doorIds: [],
      windowIds: [],
      furnitureIds: [],
      occupancy: occupancyOf(cell, t.occupants),
      zone: cell.prog?.zone ?? zoneOf(cell.type),
    };
    return { id, cell, local: cell.rect, world, def, wet, outside };
  }

  // --- balcony ---------------------------------------------------------------
  let balconyRoomId: string | undefined;
  let balconyRec: RoomRec | undefined;
  if (req.balcony) {
    const lside = frame.localSide(req.balcony.side);
    const depth = Math.max(1.2, req.balcony.depth);
    if (depth < 1.8) warnings.push(`balcony depth ${depth.toFixed(2)} m is below the 1.8 m usable minimum (ARC-17)`);
    const host = pickBalconyHost(rooms, lside, F, D);
    if (host) {
      let lr: Rect;
      const span = lside === 'front' || lside === 'rear'
        ? { a: host.local.x, b: host.local.x + host.local.w }
        : { a: host.local.y, b: host.local.y + host.local.h };
      const bw = clamp(span.b - span.a, 1.8, 5.0);
      const c = (span.a + span.b) / 2;
      if (lside === 'rear') lr = { x: c - bw / 2, y: D, w: bw, h: depth };
      else if (lside === 'front') lr = { x: c - bw / 2, y: -depth, w: bw, h: depth };
      else if (lside === 'left') lr = { x: -depth, y: c - bw / 2, w: depth, h: bw };
      else lr = { x: F, y: c - bw / 2, w: depth, h: bw };
      balconyRec = makeRoom({ type: 'balcony', rect: lr, n: 1 }, true);
      balconyRec.def.hasExterior = true;
      balconyRoomId = balconyRec.id;
      rooms.push(balconyRec);
    } else {
      warnings.push(`no room faces ${req.balcony.side}; balcony omitted`);
    }
  }

  // --- adjacency + interior walls -------------------------------------------
  const adjs: Adj[] = [];
  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) {
      const a = rooms[i].local;
      const b = rooms[j].local;
      // shared edge at constant u (wall runs along v)
      if (Math.abs(a.x + a.w - b.x) < 1e-3 || Math.abs(b.x + b.w - a.x) < 1e-3) {
        const s0 = Math.max(a.y, b.y);
        const s1 = Math.min(a.y + a.h, b.y + b.h);
        if (s1 - s0 > MIN_EDGE) adjs.push({ a: i, b: j, axis: 'v', coord: Math.abs(a.x + a.w - b.x) < 1e-3 ? a.x + a.w : b.x + b.w, s0, s1 });
      }
      // shared edge at constant v (wall runs along u)
      if (Math.abs(a.y + a.h - b.y) < 1e-3 || Math.abs(b.y + b.h - a.y) < 1e-3) {
        const s0 = Math.max(a.x, b.x);
        const s1 = Math.min(a.x + a.w, b.x + b.w);
        if (s1 - s0 > MIN_EDGE) adjs.push({ a: i, b: j, axis: 'u', coord: Math.abs(a.y + a.h - b.y) < 1e-3 ? a.y + a.h : b.y + b.h, s0, s1 });
      }
    }
  }

  const walls: WallDef[] = [];
  const wetWallIds: string[] = [];
  for (const adj of adjs) {
    const ra = rooms[adj.a];
    const rb = rooms[adj.b];
    if (ra.outside || rb.outside) continue; // balcony is bounded by the organizer's exterior wall
    const wet = isWetWall(ra, rb, adj);
    const p0 = adj.axis === 'v' ? frame.toWorld(adj.coord, adj.s0) : frame.toWorld(adj.s0, adj.coord);
    const p1 = adj.axis === 'v' ? frame.toWorld(adj.coord, adj.s1) : frame.toWorld(adj.s1, adj.coord);
    const id = nid('WALL');
    const bearing = ra.cell.type === 'stair' || rb.cell.type === 'stair';
    const w: WallDef = {
      id,
      storey: req.storey,
      start: p0,
      end: p1,
      thickness: wet ? SIZES.wetWallT : SIZES.partitionT,
      height: wallH,
      type: wet ? 'wet' : 'partition',
      isExternal: false,
      loadBearingHint: bearing,
      unitId: req.unitId,
    };
    // left/right of start→end
    const mid: Vec2 = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
    const dir: Vec2 = [p1[0] - p0[0], p1[1] - p0[1]];
    const l = Math.hypot(dir[0], dir[1]) || 1;
    const leftN: Vec2 = [-dir[1] / l, dir[0] / l];
    const probe: Vec2 = [mid[0] + leftN[0] * 0.05, mid[1] + leftN[1] * 0.05];
    const leftIsA = pointInRect(ra.world, probe);
    w.leftRoomId = leftIsA ? ra.id : rb.id;
    w.rightRoomId = leftIsA ? rb.id : ra.id;
    walls.push(w);
    adj.wallId = id;
    ra.def.wallIds.push(id);
    rb.def.wallIds.push(id);
    if (wet) wetWallIds.push(id);
  }

  // --- boundary walls on each room ------------------------------------------
  for (const r of rooms) {
    if (r.outside) continue;
    for (const ls of ['front', 'rear', 'left', 'right'] as Side[]) {
      if (!touchesLocalSide(r.local, ls, F, D)) continue;
      const ws = frame.side(ls);
      const bw = req.boundaryWalls[ws];
      if (!bw) continue;
      r.def.wallIds.push(bw.id);
      if (exteriorSides.has(ws)) {
        r.def.hasExterior = true;
        r.def.exteriorWallIds.push(bw.id);
      }
    }
  }

  // --- doors -----------------------------------------------------------------
  const doors: DoorDef[] = [];
  const tracker = makeOpeningTracker();
  const swings = new Map<string, Rect[]>(); // roomId → local door-swing rects

  // unit entry door in the access boundary wall
  let entryDoorId = '';
  const accessWall = req.boundaryWalls[req.accessSide];
  const entryRoom = rooms.find(r => !r.outside && (r.cell.type === 'entry' || r.cell.type === 'hall') && Math.abs(r.local.y) < 1e-3)
    ?? rooms.find(r => !r.outside && Math.abs(r.local.y) < 1e-3 && r.cell.type !== 'garage');
  if (accessWall && entryRoom && req.level === 0) {
    const seg = { a: accessWall.start, b: accessWall.end };
    const e0 = projectOnSegment(seg, frame.toWorld(entryRoom.local.x, 0)).along;
    const e1 = projectOnSegment(seg, frame.toWorld(entryRoom.local.x + entryRoom.local.w, 0)).along;
    const lo = Math.min(e0, e1);
    const hi = Math.max(e0, e1);
    const w = SIZES.doorUnitEntry;
    const along = tracker.reserve(accessWall.id, lo, hi, w, (lo + hi) / 2, 0.15);
    if (along === null) {
      warnings.push(`unit entry door does not fit in the ${req.accessSide} boundary wall span (${(hi - lo).toFixed(2)} m)`);
    } else {
      entryDoorId = nid('DOOR');
      doors.push({
        id: entryDoorId, storey: req.storey, wallId: accessWall.id, along, width: w, height: SIZES.doorHeight,
        type: 'unit-entry', operation: 'SINGLE_SWING_LEFT', toRoomId: entryRoom.id, fireRated: true, unitId: req.unitId,
      });
      entryRoom.def.doorIds.push(entryDoorId);
      tracker.add(accessWall.id, along, w, 0);
      addSwing(swings, entryRoom, along, w, 'v+', seg, frame);
    }
  } else if (req.level === 0 && !accessWall) {
    warnings.push(`no boundary wall on the access side '${req.accessSide}'; entry door omitted`);
  }

  // garage door
  const garageRoom = rooms.find(r => r.cell.type === 'garage');
  if (garageRoom && accessWall && Math.abs(garageRoom.local.y) < 1e-3) {
    const seg = { a: accessWall.start, b: accessWall.end };
    const g0 = projectOnSegment(seg, frame.toWorld(garageRoom.local.x, 0)).along;
    const g1 = projectOnSegment(seg, frame.toWorld(garageRoom.local.x + garageRoom.local.w, 0)).along;
    const lo = Math.min(g0, g1);
    const hi = Math.max(g0, g1);
    const w = clamp(hi - lo - 0.5, 2.2, 2.8);
    const along = tracker.reserve(accessWall.id, lo, hi, w, (lo + hi) / 2, 0.1);
    if (along !== null) {
      const id = nid('DOOR');
      doors.push({
        id, storey: req.storey, wallId: accessWall.id, along, width: w, height: 2.1,
        type: 'garage', operation: 'ROLLINGUP', toRoomId: garageRoom.id, unitId: req.unitId,
      });
      garageRoom.def.doorIds.push(id);
      tracker.add(accessWall.id, along, w, 0);
    } else {
      warnings.push('garage door does not fit in the access boundary wall');
    }
  }

  // balcony door
  if (balconyRec && req.balcony) {
    const bw2 = req.boundaryWalls[req.balcony.side];
    const host = pickBalconyHost(rooms.filter(r => !r.outside), frame.localSide(req.balcony.side), F, D);
    if (bw2 && host) {
      const seg = { a: bw2.start, b: bw2.end };
      const ls = frame.localSide(req.balcony.side);
      const corners = localSideCorners(host.local, ls);
      const a0 = projectOnSegment(seg, frame.toWorld(corners[0][0], corners[0][1])).along;
      const a1 = projectOnSegment(seg, frame.toWorld(corners[1][0], corners[1][1])).along;
      const lo = Math.min(a0, a1);
      const hi = Math.max(a0, a1);
      // sit the sliding door at one end of the room's span so a window still fits beside it
      const w = clamp(hi - lo - 1.5, 0.9, 1.8);
      const bc = lo + 0.12 + w / 2;
      const along = tracker.reserve(bw2.id, lo, hi, w, bc, 0.12);
      if (along !== null) {
        const id = nid('DOOR');
        doors.push({
          id, storey: req.storey, wallId: bw2.id, along, width: w, height: SIZES.doorHeight,
          type: 'balcony', operation: 'DOUBLE_DOOR_SLIDING', fromRoomId: host.id, toRoomId: balconyRec.id, unitId: req.unitId,
        });
        host.def.doorIds.push(id);
        balconyRec.def.doorIds.push(id);
        tracker.add(bw2.id, along, w, w * SIZES.doorHeight);
      } else {
        warnings.push('balcony door does not fit in the boundary wall span');
      }
    }
  }

  // interior doors: shortest-circulation spanning tree from the entry
  const rootIdx = pickRoot(rooms);
  const parent = spanningTree(rooms, adjs, rootIdx);
  for (let i = 0; i < rooms.length; i++) {
    if (i === rootIdx) continue;
    const p = parent[i];
    if (p === undefined) {
      if (!rooms[i].outside) warnings.push(`${rooms[i].def.name} has no door (no usable shared edge)`);
      continue;
    }
    const adj = p.adj;
    const from = rooms[p.idx];
    const to = rooms[i];
    if (from.outside || to.outside) continue;
    const spec = doorSpec(from, to, accessible, interiorDoorW, bathDoorW, adj.s1 - adj.s0);
    if (spec.width < 0.6) { warnings.push(`${to.def.name}: shared edge too short for a door`); continue; }
    const wallId = adj.wallId;
    if (!wallId) continue;
    const wall = walls.find(w => w.id === wallId);
    if (!wall) continue;
    const seg = { a: wall.start, b: wall.end };
    const wallLen = Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]);
    const centre = (adj.s1 + adj.s0) / 2;
    const prefer = projectOnSegment(seg, adj.axis === 'v' ? frame.toWorld(adj.coord, centre) : frame.toWorld(centre, adj.coord)).along;
    const width = Math.min(spec.width, Math.max(0.6, wallLen - 0.15));
    const margin = Math.min(0.15, Math.max(0, (wallLen - width) / 2));
    // a cupboard front may be any width; a door to a room may not drop below a usable leaf
    if (width < 0.7 && spec.type === 'interior' && spec.leaf) {
      warnings.push(`${to.def.name}: door narrowed to ${width.toFixed(2)} m — below the 0.75 m minimum leaf`);
    }
    const along = tracker.reserve(wallId, 0, wallLen, width, prefer, margin);
    if (along === null) { warnings.push(`no clear position for the ${to.def.name} door on wall ${wallId} (${wallLen.toFixed(2)} m)`); continue; }
    const id = nid('DOOR');
    doors.push({
      id, storey: req.storey, wallId, along, width: round(width, 3), height: SIZES.doorHeight,
      type: spec.type, operation: spec.operation, fromRoomId: from.id, toRoomId: to.id, unitId: req.unitId,
    });
    from.def.doorIds.push(id);
    to.def.doorIds.push(id);
    if (spec.leaf) {
      // swing into the room being entered
      const dirIn: LDir = adj.axis === 'v'
        ? (to.local.x > from.local.x ? 'u+' : 'u-')
        : (to.local.y > from.local.y ? 'v+' : 'v-');
      addSwing(swings, to, along, width, dirIn, seg, frame);
    }
  }

  // --- windows (ARC-16: one glazing budget per exterior wall) ----------------
  // Per unit and per exterior boundary wall the glazed area targets
  // `wwr × (the unit's own span on that wall × floor-to-floor)`, shared between the rooms on the
  // wall in proportion to their wall span weighted by how much daylight the room wants. A hall or
  // a closet on the façade contributes its span to the budget but takes no glazing, so its share
  // is spent on the habitable rooms beside it.
  const windows: WindowDef[] = [];
  const wwr = clamp(req.wwr, 0.12, 0.85);
  let glazedTotal = 0;
  let facadeTotal = 0;
  /** the part of the façade that stands in front of a room that can take a window at all */
  let glazableTotal = 0;
  interface GlazeSlot {
    r: RoomRec; wallId: string; ws: Side; lo: number; hi: number; span: number;
    weight: number; sill: number; h: number; cap: number; placed: number; daylit: boolean;
  }
  const slots: GlazeSlot[] = [];

  /** place up to `want` metres of sash width in one room, splitting it as the free span allows */
  const glaze = (sl: GlazeSlot, want: number): number => {
    const mustHave = sl.daylit && sl.r.def.windowIds.length === 0;
    const room = Math.max(0, sl.cap - sl.placed);
    let remaining = Math.min(want, room);
    if (mustHave) remaining = Math.max(remaining, Math.min(0.9, sl.cap));
    const sashMax = 2.8;
    let count = Math.max(sl.span > 4.5 && remaining > 2.0 ? 2 : 1, Math.ceil(remaining / sashMax - E));
    let n = 0;
    let done = 0;
    for (let k = 0; k < 4 && remaining >= 0.9 - E; k++) {
      let w = clamp(remaining / Math.max(1, count - n), 0.9, Math.min(remaining, sashMax));
      const prefer = sl.lo + (sl.span * (n + 0.5)) / Math.max(1, count);
      let along = tracker.reserve(sl.wallId, sl.lo, sl.hi, w, prefer, n === 0 && mustHave ? 0.08 : 0.12);
      if (along === null && w > 0.95) {
        for (const w2 of [Math.max(0.9, w / 2), 0.9]) {
          along = tracker.reserve(sl.wallId, sl.lo, sl.hi, w2, prefer, 0.08);
          if (along !== null) { w = w2; count = Math.max(count + 1, n + 2); break; }
        }
      }
      if (along === null) {
        if (n === 0 && sl.daylit && sl.r.def.windowIds.length === 0) {
          warnings.push(`${sl.r.def.name}: no room for a window on the ${sl.ws} wall (span ${sl.span.toFixed(2)} m)`);
        }
        break;
      }
      const id = nid('WIN');
      windows.push({
        // floor, never round: a rounded-up sash can break out of the room's wall span
        id, storey: req.storey, wallId: sl.wallId, along, sill: sl.sill,
        width: Math.floor(w * 1000 + 1e-6) / 1000, height: sl.h,
        roomId: sl.r.id, exposure: req.exposures[sl.ws] as Compass | undefined, unitId: req.unitId,
      });
      tracker.add(sl.wallId, along, w, w * sl.h);
      glazedTotal += w * sl.h;
      sl.r.def.windowIds.push(id);
      sl.r.def.hasExterior = true;
      if (!sl.r.def.exteriorWallIds.includes(sl.wallId)) sl.r.def.exteriorWallIds.push(sl.wallId);
      sl.placed += w;
      remaining -= w;
      done += w;
      n++;
    }
    return done;
  };

  for (const ls of ['front', 'rear', 'left', 'right'] as Side[]) {
    const ws = frame.side(ls);
    if (!exteriorSides.has(ws)) continue;
    const bw = req.boundaryWalls[ws];
    if (!bw) continue;
    const seg = { a: bw.start, b: bw.end };
    const spanOf = (r: Rect): { lo: number; hi: number } => {
      const c = localSideCorners(r, ls);
      const a0 = projectOnSegment(seg, frame.toWorld(c[0][0], c[0][1])).along;
      const a1 = projectOnSegment(seg, frame.toWorld(c[1][0], c[1][1])).along;
      return { lo: Math.min(a0, a1), hi: Math.max(a0, a1) };
    };
    const unit = spanOf({ x: 0, y: 0, w: F, h: D });
    const sideLen = unit.hi - unit.lo;
    if (sideLen < 0.8) continue;
    facadeTotal += sideLen * req.floorToFloor;
    // a balcony door in this wall is glazing too — it counts against the share of the room it
    // opens from, not against the whole wall, so the other rooms keep their full windows
    glazedTotal += DOOR_GLAZED * tracker.usedArea(bw.id, unit.lo, unit.hi);
    const budget = wwr * sideLen * req.floorToFloor;
    const onWall = rooms
      .filter(r => !r.outside && touchesLocalSide(r.local, ls, F, D))
      .map(r => ({ r, span: spanOf(r.local), weight: glazeWeight(r.cell.type) }))
      .filter(x => x.span.hi - x.span.lo > 0.9);
    const weighted = sum(onWall.map(x => (x.span.hi - x.span.lo) * x.weight));
    // a garage door, a stair or a store on the façade cannot be glazed: that part of the wall is
    // left out of the target so the ratio is measured against the wall the rooms can actually use
    const glazableLen = sum(onWall.filter(x => x.weight > 0).map(x => x.span.hi - x.span.lo));
    glazableTotal += Math.min(sideLen, glazableLen) * req.floorToFloor;
    for (const { r, span, weight } of onWall) {
      const width = span.hi - span.lo;
      const daylit = r.cell.prog?.needsExterior ?? BACK_TYPES.has(r.cell.type);
      const big = (wwr > 0.4 || req.floorToFloor >= 3.3) && GLAZE_LOW_SILL.has(r.cell.type);
      const sill = big ? 0.6 : SIZES.windowSill;
      // head below the slab soffit and below the ceiling
      const h = round(clamp(Math.min(req.floorToFloor - sill - 0.3, req.ceilingHeight - sill - 0.1), 0.6, 2.4), 3);
      const own = DOOR_GLAZED * tracker.usedArea(bw.id, span.lo, span.hi);
      const share = Math.max(0, weighted > E ? (budget * width * weight) / weighted - own : 0);
      const sl: GlazeSlot = {
        r, wallId: bw.id, ws, lo: span.lo, hi: span.hi, span: width, weight,
        sill, h, cap: Math.max(0.9, width - 0.6), placed: 0, daylit,
      };
      slots.push(sl);
      const mustHave = daylit && r.def.windowIds.length === 0;
      if (share < 0.6 && !mustHave) continue;
      glaze(sl, share / h);
    }
  }
  // Second pass: a wall whose rooms ran out of span (a garage or a stair on the façade, a room
  // narrower than its share) leaves part of the budget unspent. Spend what is left on the rooms
  // that still have span, biggest daylight appetite first, so the unit reaches its target.
  {
    let shortfall = wwr * glazableTotal - glazedTotal;
    const order = [...slots].sort((a, b) => b.weight - a.weight || (b.cap - b.placed) - (a.cap - a.placed));
    for (let round2 = 0; round2 < 2 && shortfall > 0.5; round2++) {
      let progress = 0;
      for (const sl of order) {
        if (shortfall <= 0.5) break;
        if (sl.weight <= 0 || sl.cap - sl.placed < 0.9 - E) continue;
        const add = glaze(sl, Math.min(sl.cap - sl.placed, shortfall / sl.h));
        shortfall -= add * sl.h;
        progress += add;
      }
      if (progress < 0.05) break;
    }
  }
  const achievedWwr = facadeTotal > E ? glazedTotal / facadeTotal : 0;
  const glazableWwr = glazableTotal > E ? glazedTotal / glazableTotal : 0;
  if (glazableTotal > E && glazableWwr < wwr - 0.05) {
    warnings.push(`glazing reaches ${(glazableWwr * 100).toFixed(1)} % of the glazable façade against a ${(wwr * 100).toFixed(0)} % target: ${round(glazedTotal, 2)} m² of glass on ${round(glazableTotal, 2)} m² of room-facing exterior wall is the most the room spans, the ${SIZES.windowSill} m sill and the ${round(req.floorToFloor, 2)} m floor-to-floor allow (ARC-16)`);
  }

  // every daylit room must have a window — reported once per unit, with the arithmetic that
  // explains it, because the cause is always the same: too little façade for the program
  const unlit = rooms.filter(r => !r.outside && !r.cell.daylightWaived
    && (r.cell.prog?.needsExterior ?? BACK_TYPES.has(r.cell.type)) && r.def.windowIds.length === 0);
  if (unlit.length > 0) {
    const demand = sum(rooms
      .filter(r => !r.outside && (r.cell.prog?.needsExterior ?? BACK_TYPES.has(r.cell.type)))
      .map(r => Math.min(r.cell.prog?.minWidth ?? 2.4, Math.max(r.local.w, r.local.h))));
    warnings.push(`${unlit.map(r => r.def.name).join(', ')} ${unlit.length > 1 ? 'need' : 'needs'} daylight but ${unlit.length > 1 ? 'have' : 'has'} no exterior wall on this rect: ${round(facadeTotal / Math.max(req.floorToFloor, 1), 2)} m of façade (${req.exteriorSides.join('/') || 'none'}) for ${round(demand, 2)} m of habitable rooms`);
  }

  // --- furniture -------------------------------------------------------------
  const furniture: FurnitureDef[] = [];
  let triangle = 0;
  let storageM3 = 0;
  if (req.options.furniture) {
    for (const r of rooms) {
      const res = furnishRoom(r, {
        req, frame, nid, swings: swings.get(r.id) ?? [], accessible, warnings,
        detail: req.options.detail, occupants: t.occupants,
      });
      furniture.push(...res.items);
      r.def.furnitureIds.push(...res.items.map(f => f.id));
      if (res.triangle) triangle = res.triangle;
      storageM3 += res.storage;
    }
  }

  // --- stair -----------------------------------------------------------------
  let stairOut: UnitLayout['stair'];
  if (plan.stair) {
    const sp = plan.stair;
    const rect = sp.rect;
    if (req.stairRect) {
      const want = frame.toLocalRect(req.stairRect);
      const covered = want.x >= rect.x - 0.5 && want.x + want.w <= rect.x + rect.w + 0.05
        && want.y >= rect.y - 0.05 && want.y + want.h <= rect.y + rect.h + 0.05;
      if (!covered) warnings.push(`requested stairRect is not compatible with the unit plan; the stair is placed against the party wall next to the entry instead (ARC-22) — use layout.stair.rect for the floor opening`);
    }
    const worldRect = frame.toWorldRect(rect);
    const nose = frame.toWorld(rect.x + rect.w / 2, rect.y + 0.15);
    const dirV = frame.dir('v+');
    stairOut = {
      rect: worldRect,
      position: [round(nose[0], 4), round(nose[1], 4)],
      direction: Math.atan2(dirV[1], dirV[0]),
      risers: sp.risers,
      riserHeight: round(sp.riserHeight, 4),
      tread: sp.tread,
      width: round(sp.width, 3),
    };
    if (sp.riserHeight > SIZES.stairRiserMax + 1e-6) warnings.push(`stair riser ${(sp.riserHeight * 1000).toFixed(0)} mm exceeds the ${SIZES.stairRiserMax * 1000} mm maximum`);
  }

  // --- outputs ---------------------------------------------------------------
  const kitchenRoom = rooms.find(r => r.cell.type === 'kitchen')
    ?? rooms.find(r => r.cell.type === 'living-kitchen')
    ?? rooms.find(r => r.cell.type === 'shared-kitchen');
  const bathroomRoomIds = rooms.filter(r => BATH_TYPES.has(r.cell.type)).map(r => r.id);
  const patterns = buildPatternApplications({
    req, rooms, walls, doors, windows, furniture, plan, wetWallIds, triangle, storageM3, accessible, frame,
    glazedArea: glazedTotal, facadeArea: facadeTotal, glazableArea: glazableTotal,
    mergedRooms, stackAtU, stackWantU: opts.stackU,
  });

  return {
    rooms: rooms.map(r => r.def),
    walls,
    doors,
    windows,
    furniture,
    entryDoorId,
    wetWallIds,
    kitchenRoomId: kitchenRoom?.id,
    bathroomRoomIds,
    balconyRoomId,
    stair: stairOut,
    patterns,
    warnings,
  };
};

// ============================================================================
// Helpers used by layoutUnit
// ============================================================================

function typeTotal(cells: Cell[], type: RoomType): number {
  return cells.filter(c => c.type === type).length;
}

/** Local u the plumbing stack ends up on: the requested coordinate when a bathroom covers it (XD-01). */
function wetStackU(plan: PlanResult, requested?: number): number {
  const baths = plan.cells.filter(c => BATH_TYPES.has(c.type));
  if (baths.length === 0) return requested ?? 0;
  const mid = (c: Cell): number => c.rect.x + c.rect.w / 2;
  if (requested === undefined) return round(mid(baths[0]), 3);
  const hit = baths.find(c => requested >= c.rect.x - E && requested <= c.rect.x + c.rect.w + E);
  if (hit) return round(requested, 3);
  const near = [...baths].sort((a, b) => Math.abs(mid(a) - requested) - Math.abs(mid(b) - requested))[0];
  return round(mid(near), 3);
}

function roomName(type: RoomType, n: number, region: Region, total: number): string {
  const label = ROOM_LABELS_REGION[region]?.[type] ?? ROOM_LABELS[type] ?? type;
  return total > 1 ? `${label} ${n}` : label;
}

function zoneOf(type: RoomType): Zone {
  if (type === 'balcony' || type === 'terrace' || type === 'porch') return 'outdoor';
  if (type === 'hall' || type === 'entry' || type === 'corridor' || type === 'stair') return 'circulation';
  if (PRIVATE_TYPES.has(type)) return 'private';
  if (BACK_TYPES.has(type)) return 'public';
  return 'service';
}

function occupancyOf(cell: Cell, occupants: number): number {
  const t = cell.type;
  if (t === 'master-bedroom') return 2;
  if (t === 'bedroom') return (cell.prog?.count ?? 1) >= 4 ? 1 : (cell.prog?.minArea ?? 11.5) >= 11 ? 2 : 1;
  if (t === 'living' || t === 'living-kitchen' || t === 'shared-living' || t === 'dining' || t === 'shared-kitchen') return occupants;
  if (t === 'study' || t === 'den' || t === 'flex') return 1;
  return 0;
}

function pointInRect(r: Rect, p: Vec2): boolean {
  return p[0] >= r.x - 1e-9 && p[0] <= r.x + r.w + 1e-9 && p[1] >= r.y - 1e-9 && p[1] <= r.y + r.h + 1e-9;
}

function touchesLocalSide(r: Rect, s: Side, F: number, D: number): boolean {
  switch (s) {
    case 'front': return Math.abs(r.y) < 1e-3;
    case 'rear': return Math.abs(r.y + r.h - D) < 1e-3;
    case 'left': return Math.abs(r.x) < 1e-3;
    default: return Math.abs(r.x + r.w - F) < 1e-3;
  }
}

function localSideCorners(r: Rect, s: Side): [Vec2, Vec2] {
  switch (s) {
    case 'front': return [[r.x, r.y], [r.x + r.w, r.y]];
    case 'rear': return [[r.x, r.y + r.h], [r.x + r.w, r.y + r.h]];
    case 'left': return [[r.x, r.y], [r.x, r.y + r.h]];
    default: return [[r.x + r.w, r.y], [r.x + r.w, r.y + r.h]];
  }
}

function isWetWall(a: RoomRec, b: RoomRec, adj: Adj): boolean {
  if (!a.wet && !b.wet) return false;
  if (a.wet && b.wet) return true;
  for (const r of [a, b]) {
    if (!r.wet || !r.cell.wetEdge) continue;
    const e = r.cell.wetEdge;
    if (adj.axis === 'u' && (e === 'v+' || e === 'v-')) {
      const edgeV = e === 'v+' ? r.local.y + r.local.h : r.local.y;
      if (Math.abs(adj.coord - edgeV) < 1e-3) return true;
    }
    if (adj.axis === 'v' && (e === 'u+' || e === 'u-')) {
      const edgeU = e === 'u+' ? r.local.x + r.local.w : r.local.x;
      if (Math.abs(adj.coord - edgeU) < 1e-3) return true;
    }
  }
  return false;
}

function pickBalconyHost(rooms: RoomRec[], lside: Side, F: number, D: number): RoomRec | undefined {
  const cands = rooms.filter(r => !r.outside && (r.cell.type === 'living' || r.cell.type === 'living-kitchen' || r.cell.type === 'shared-living' || r.cell.type === 'dining' || r.cell.type === 'master-bedroom' || r.cell.type === 'bedroom'));
  const pool = cands.filter(r => touchesLocalSide(r.local, lside, F, D));
  pool.sort((a, b) => rankBalcony(a) - rankBalcony(b) || b.local.w * b.local.h - a.local.w * a.local.h);
  return pool[0];
}

function rankBalcony(r: RoomRec): number {
  const t = r.cell.type;
  return t === 'living' || t === 'living-kitchen' || t === 'shared-living' ? 0 : t === 'dining' ? 1 : 2;
}

interface TreeLink { idx: number; adj: Adj }

function pickRoot(rooms: RoomRec[]): number {
  const order: RoomType[] = ['entry', 'hall', 'stair', 'corridor', 'living-kitchen', 'living', 'shared-living'];
  for (const t of order) {
    const i = rooms.findIndex(r => !r.outside && r.cell.type === t);
    if (i >= 0) return i;
  }
  let best = 0;
  let area = -1;
  rooms.forEach((r, i) => {
    const a = r.local.w * r.local.h;
    if (!r.outside && a > area) { area = a; best = i; }
  });
  return best;
}

function spanningTree(rooms: RoomRec[], adjs: Adj[], root: number): (TreeLink | undefined)[] {
  const n = rooms.length;
  const nbr: { to: number; adj: Adj }[][] = Array.from({ length: n }, () => []);
  for (const a of adjs) {
    if (a.s1 - a.s0 < MIN_DOOR_EDGE) continue;
    if (rooms[a.a].outside || rooms[a.b].outside) continue;
    nbr[a.a].push({ to: a.b, adj: a });
    nbr[a.b].push({ to: a.a, adj: a });
  }
  const dist = new Array<number>(n).fill(Infinity);
  const parent = new Array<TreeLink | undefined>(n).fill(undefined);
  const done = new Array<boolean>(n).fill(false);
  dist[root] = 0;
  for (let it = 0; it < n; it++) {
    let u = -1;
    let best = Infinity;
    for (let i = 0; i < n; i++) if (!done[i] && dist[i] < best) { best = dist[i]; u = i; }
    if (u < 0) break;
    done[u] = true;
    const through = transitCost(rooms[u].cell.type);
    for (const { to, adj } of nbr[u]) {
      if (done[to]) continue;
      const w = dist[u] + (u === root ? 0.05 : through) + 0.02 * (1 / Math.max(0.5, adj.s1 - adj.s0));
      if (w < dist[to]) { dist[to] = w; parent[to] = { idx: u, adj }; }
    }
  }
  // preferred parents: an en-suite / walk-in opens off its bedroom
  const childCount = new Array<number>(n).fill(0);
  parent.forEach(p => { if (p) childCount[p.idx]++; });
  for (let i = 0; i < n; i++) {
    const r = rooms[i];
    const want = r.cell.prefParent ?? (r.cell.type === 'ensuite' ? 'master-bedroom' : r.cell.type === 'walk-in-closet' ? 'master-bedroom' : undefined);
    if (!want || childCount[i] > 0) continue;
    const opts = nbr[i].filter(x => rooms[x.to].cell.type === want || (want === 'master-bedroom' && rooms[x.to].cell.type === 'bedroom'));
    if (opts.length === 0) continue;
    opts.sort((a, b) => (rooms[a.to].cell.type === want ? 0 : 1) - (rooms[b.to].cell.type === want ? 0 : 1) || (b.adj.s1 - b.adj.s0) - (a.adj.s1 - a.adj.s0));
    const pick = opts[0];
    // avoid making a descendant the parent
    let anc: number | undefined = pick.to;
    let cyc = false;
    for (let g = 0; g < n && anc !== undefined; g++) {
      if (anc === i) { cyc = true; break; }
      anc = parent[anc]?.idx;
    }
    if (!cyc) parent[i] = { idx: pick.to, adj: pick.adj };
  }
  return parent;
}

function doorSpec(from: RoomRec, to: RoomRec, accessible: boolean, interiorW: number, bathW: number, span: number): { width: number; type: DoorDef['type']; operation: string; leaf: boolean } {
  const ta = from.cell.type;
  const tb = to.cell.type;
  const cap = Math.max(0.6, span - 0.3);
  if (tb === 'closet' || tb === 'walk-in-closet' || ta === 'closet' || ta === 'walk-in-closet') {
    return { width: Math.min(accessible ? 0.85 : 0.7, cap), type: 'closet', operation: 'SLIDING_TO_LEFT', leaf: false };
  }
  const cupboard = (r: RoomRec): boolean => (r.cell.type === 'laundry' || r.cell.type === 'utility' || r.cell.type === 'storage') && r.local.w * r.local.h < 3.2;
  if (cupboard(to) || cupboard(from)) {
    return { width: Math.min(accessible ? 0.85 : 0.75, cap), type: 'service', operation: 'DOUBLE_DOOR_FOLDING', leaf: false };
  }
  if (BATH_TYPES.has(tb) || BATH_TYPES.has(ta)) {
    const wet = BATH_TYPES.has(tb) ? to : from;
    // a swing leaf cannot be kept clear of the fixtures in a shower room under 4.6 m² (ARC-28),
    // and ADA 2010 §603.2.3 forbids a door swinging into the clear floor space at any fixture,
    // so an accessible bathroom always gets a sliding leaf
    const tight = accessible || wet.local.w * wet.local.h < 4.6 || Math.min(wet.local.w, wet.local.h) < 1.55;
    return tight
      ? { width: Math.min(bathW, cap), type: 'interior', operation: 'SLIDING_TO_LEFT', leaf: false }
      : { width: Math.min(bathW, cap), type: 'interior', operation: 'SINGLE_SWING_LEFT', leaf: true };
  }
  if (tb === 'garage' || ta === 'garage') {
    return { width: Math.min(0.85, cap), type: 'service', operation: 'SINGLE_SWING_RIGHT', leaf: true };
  }
  if (OPEN_PLAN.has(ta) && OPEN_PLAN.has(tb)) {
    return { width: clamp(cap, 0.9, accessible ? 1.5 : 1.4), type: 'interior', operation: 'NOTDEFINED', leaf: false };
  }
  return { width: Math.min(interiorW, cap), type: 'interior', operation: 'SINGLE_SWING_LEFT', leaf: true };
}

function addSwing(map: Map<string, Rect[]>, room: RoomRec, along: number, width: number, into: LDir, seg: { a: Vec2; b: Vec2 }, frame: Frame): void {
  // the swing square sits inside `room`, centred on the door, `width` deep (ARC-28)
  const list = map.get(room.id) ?? [];
  const c = pointAlong(seg, along);
  // convert the world door centre back to local by projecting onto the room's local box
  const lc = worldToLocalApprox(c, frame, room);
  let r: Rect;
  switch (into) {
    case 'v+': r = { x: lc[0] - width / 2, y: room.local.y, w: width, h: width }; break;
    case 'v-': r = { x: lc[0] - width / 2, y: room.local.y + room.local.h - width, w: width, h: width }; break;
    case 'u+': r = { x: room.local.x, y: lc[1] - width / 2, w: width, h: width }; break;
    default: r = { x: room.local.x + room.local.w - width, y: lc[1] - width / 2, w: width, h: width };
  }
  list.push(r);
  map.set(room.id, list);
}

function pointAlong(seg: { a: Vec2; b: Vec2 }, along: number): Vec2 {
  const dx = seg.b[0] - seg.a[0];
  const dy = seg.b[1] - seg.a[1];
  const l = Math.hypot(dx, dy) || 1;
  return [seg.a[0] + (dx / l) * along, seg.a[1] + (dy / l) * along];
}

/** world point → local (u, v) using the frame's inverse (rotation only) */
function worldToLocalApprox(p: Vec2, frame: Frame, room: RoomRec): Vec2 {
  const o = frame.toWorld(0, 0);
  const du = frame.dir('u+');
  const dv = frame.dir('v+');
  const u = (p[0] - o[0]) * du[0] + (p[1] - o[1]) * du[1];
  const v = (p[0] - o[0]) * dv[0] + (p[1] - o[1]) * dv[1];
  return [clamp(u, room.local.x, room.local.x + room.local.w), clamp(v, room.local.y, room.local.y + room.local.h)];
}

// ============================================================================
// Furniture
// ============================================================================

interface FurnishCtx {
  req: UnitLayoutRequest;
  frame: Frame;
  nid: (kind: string) => string;
  swings: Rect[];
  accessible: boolean;
  warnings: string[];
  detail: 'low' | 'medium' | 'high';
  occupants: number;
}

interface FurnishResult { items: FurnitureDef[]; triangle: number; storage: number }

function furnishRoom(room: RoomRec, ctx: FurnishCtx): FurnishResult {
  const items: FurnitureDef[] = [];
  const taken: Rect[] = [];
  const inner = insetLocal(room.local, CLEARANCE.wall);
  let storage = 0;
  let triangle = 0;

  const place = (type: FurnitureType, aabb: Rect, face: LDir, override?: { w?: number; d?: number }): FurnitureDef | null => {
    const box: Rect = { x: round(aabb.x, 4), y: round(aabb.y, 4), w: round(aabb.w, 4), h: round(aabb.h, 4) };
    if (box.w < 0.03 || box.h < 0.03) return null;
    if (!rectContainsRect(inner, box, 1e-3)) return null;
    if (taken.some(t => rectsOverlap(t, box, 1e-3))) return null;
    if (ctx.swings.some(s => rectsOverlap(s, box, 1e-3))) return null;
    taken.push(box);
    const spec = FURNITURE_CATALOG[type];
    const world = ctx.frame.toWorldRect(box);
    const faceWorld = ctx.frame.dir(face);
    const rotation = facingOf(faceWorld);
    const horizontal = Math.abs(faceWorld[1]) > Math.abs(faceWorld[0]);
    const w = override?.w ?? (horizontal ? world.w : world.h);
    const d = override?.d ?? (horizontal ? world.h : world.w);
    let position: Vec2;
    if (rotation === 0) position = [world.x, world.y];
    else if (Math.abs(rotation - Math.PI / 2) < 1e-9) position = [world.x + world.w, world.y];
    else if (Math.abs(rotation - Math.PI) < 1e-9) position = [world.x + world.w, world.y + world.h];
    else position = [world.x, world.y + world.h];
    const f: FurnitureDef = {
      id: ctx.nid('FURN'),
      storey: ctx.req.storey,
      roomId: room.id,
      unitId: ctx.req.unitId,
      type,
      position: [round(position[0], 4), round(position[1], 4)],
      width: round(w, 4),
      depth: round(d, 4),
      height: spec.h,
      rotation: round(rotation, 6),
      needsWater: spec.needsWater,
      needsPower: spec.needsPower,
    };
    items.push(f);
    storage += storageVolume(type, Math.max(w, d));
    return f;
  };

  const probe = (aabb: Rect): boolean => {
    const box: Rect = { x: round(aabb.x, 4), y: round(aabb.y, 4), w: round(aabb.w, 4), h: round(aabb.h, 4) };
    if (box.w < 0.03 || box.h < 0.03) return false;
    if (!rectContainsRect(inner, box, 1e-3)) return false;
    if (taken.some(x => rectsOverlap(x, box, 1e-3))) return false;
    if (ctx.swings.some(x => rectsOverlap(x, box, 1e-3))) return false;
    return true;
  };

  const t = room.cell.type;
  const wetEdge = room.cell.wetEdge;
  switch (t) {
    case 'bedroom':
    case 'master-bedroom': {
      furnishBedroom(room, ctx, place, inner);
      break;
    }
    case 'living':
    case 'shared-living':
      furnishLiving(room, ctx, place, inner, t === 'shared-living');
      break;
    case 'living-kitchen':
      triangle = furnishKitchenRun(room, ctx, place, inner, wetEdge ?? 'v-', true);
      furnishLiving(room, ctx, place, inner, false, true);
      break;
    case 'kitchen':
    case 'shared-kitchen':
      triangle = furnishKitchenRun(room, ctx, place, inner, wetEdge ?? 'v+', t === 'shared-kitchen');
      break;
    case 'dining':
      furnishDining(room, ctx, place, inner);
      break;
    case 'bathroom':
    case 'ensuite':
    case 'powder':
    case 'wc':
      furnishBathroom(room, ctx, place, probe, inner, wetEdge ?? 'v+');
      break;
    case 'laundry':
    case 'utility':
      furnishLaundry(room, ctx, place, inner, wetEdge ?? 'v+');
      break;
    case 'closet':
    case 'walk-in-closet':
    case 'storage':
      furnishStore(room, ctx, place, inner);
      break;
    case 'entry':
      furnishEntry(room, ctx, place, inner);
      break;
    case 'study':
    case 'den':
    case 'flex':
      furnishStudy(room, ctx, place, inner);
      break;
    case 'balcony':
    case 'terrace':
      furnishBalcony(room, ctx, place, inner);
      break;
    case 'garage':
      furnishGarage(room, ctx, place, inner);
      break;
    default:
      break;
  }
  return { items, triangle, storage };
}

type PlaceFn = (type: FurnitureType, aabb: Rect, face: LDir, override?: { w?: number; d?: number }) => FurnitureDef | null;

function insetLocal(r: Rect, d: number): Rect {
  return { x: r.x + d, y: r.y + d, w: Math.max(0, r.w - 2 * d), h: Math.max(0, r.h - 2 * d) };
}

/** local sides ranked by how good a back/headboard wall they are (free of doors and windows) */
function rankedWalls(room: RoomRec, ctx: FurnishCtx, exclude: Side[] = []): Side[] {
  const score: Record<Side, number> = { front: 0, rear: 0, left: 0, right: 0 };
  const F = ctx.frame.F;
  const D = ctx.frame.D;
  for (const s of ['front', 'rear', 'left', 'right'] as Side[]) {
    if (exclude.includes(s)) { score[s] = -100; continue; }
    // penalise exterior (window) walls and door swings
    if (touchesLocalSide(room.local, s, F, D)) score[s] -= 4;
    for (const sw of ctx.swings) if (swingOnSide(room.local, sw, s)) score[s] -= 6;
    // prefer the longer wall
    score[s] += (s === 'front' || s === 'rear' ? room.local.w : room.local.h) * 0.4;
  }
  return (['rear', 'front', 'left', 'right'] as Side[]).sort((a, b) => score[b] - score[a]);
}

function bestBackWall(room: RoomRec, ctx: FurnishCtx, exclude: Side[] = []): Side {
  return rankedWalls(room, ctx, exclude)[0];
}

function swingOnSide(room: Rect, sw: Rect, s: Side): boolean {
  switch (s) {
    case 'front': return Math.abs(sw.y - room.y) < 0.05;
    case 'rear': return Math.abs(sw.y + sw.h - (room.y + room.h)) < 0.05;
    case 'left': return Math.abs(sw.x - room.x) < 0.05;
    default: return Math.abs(sw.x + sw.w - (room.x + room.w)) < 0.05;
  }
}

/** place a footprint against a local side of `inner`, centred at `centre` along that side */
function againstSide(inner: Rect, s: Side, w: number, d: number, centre: number): { aabb: Rect; face: LDir } {
  switch (s) {
    case 'front': return { aabb: { x: centre - w / 2, y: inner.y, w, h: d }, face: 'v+' };
    case 'rear': return { aabb: { x: centre - w / 2, y: inner.y + inner.h - d, w, h: d }, face: 'v-' };
    case 'left': return { aabb: { x: inner.x, y: centre - w / 2, w: d, h: w }, face: 'u+' };
    default: return { aabb: { x: inner.x + inner.w - d, y: centre - w / 2, w: d, h: w }, face: 'u-' };
  }
}

function sideCentre(inner: Rect, s: Side): number {
  return s === 'front' || s === 'rear' ? inner.x + inner.w / 2 : inner.y + inner.h / 2;
}

function sideLength(inner: Rect, s: Side): number {
  return s === 'front' || s === 'rear' ? inner.w : inner.h;
}

function oppSide(s: Side): Side {
  return s === 'front' ? 'rear' : s === 'rear' ? 'front' : s === 'left' ? 'right' : 'left';
}

function furnishBedroom(room: RoomRec, ctx: FurnishCtx, place: PlaceFn, inner: Rect): void {
  const isMaster = room.cell.type === 'master-bedroom';
  const area = room.local.w * room.local.h;
  const beds: FurnitureType[] = isMaster
    ? (area >= 17 ? ['bed-king', 'bed-queen', 'bed-double', 'bed-single'] : ['bed-queen', 'bed-double', 'bed-single'])
    : (ctx.accessible ? ['bed-double', 'bed-single'] : area >= 12.5 ? ['bed-double', 'bed-single'] : ['bed-single']);
  let bed: FurnitureDef | null = null;
  let bedSpec = FURNITURE_CATALOG['bed-single'];
  let head: Side = 'rear';
  search:
  for (const h of rankedWalls(room, ctx)) {
    const alongH = sideLength(inner, h);
    const acrossH = h === 'front' || h === 'rear' ? inner.h : inner.w;
    for (const b of beds) {
      const s = FURNITURE_CATALOG[b];
      // bed plus one access side, and enough depth for the mattress plus a walk-by at the foot
      if (alongH < s.w + 0.45 || acrossH < s.d + 0.35) continue;
      const lo = (h === 'front' || h === 'rear' ? inner.x : inner.y) + s.w / 2 + 0.05;
      const hi = lo + alongH - s.w - 0.1;
      for (const cc of [sideCentre(inner, h), lo, hi]) {
        const p = againstSide(inner, h, s.w, s.d, clamp(cc, lo, hi));
        const f = place(b, p.aabb, p.face);
        if (f) { bed = f; bedSpec = s; head = h; break search; }
      }
    }
  }
  if (!bed) {
    ctx.warnings.push(`${room.def.name}: no bed fits (${room.local.w.toFixed(2)} × ${room.local.h.toFixed(2)} m)`);
    return;
  }
  // nightstands either side of the headboard
  const ns = FURNITURE_CATALOG.nightstand;
  const c = sideCentre(inner, head);
  for (const sgn of [-1, 1]) {
    const off = c + sgn * (bedSpec.w / 2 + ns.w / 2 + 0.02);
    const p = againstSide(inner, head, ns.w, ns.d, off);
    place('nightstand', p.aabb, p.face);
    if (!isMaster && ctx.detail === 'low') break;
  }
  // wardrobe on a side wall clear of the door and window
  const sideWalls: Side[] = head === 'front' || head === 'rear' ? ['left', 'right'] : ['front', 'rear'];
  const wr = FURNITURE_CATALOG.wardrobe;
  let placed = false;
  wardrobe:
  for (const pass of [0, 1]) {
    for (const s of [...sideWalls, oppSide(head), head]) {
      const len = sideLength(inner, s);
      const w = pass === 0 ? clamp(len - 0.2, 0.9, isMaster ? 2.4 : 1.8) : 0.9;
      if (w < 0.85 || len < w + 0.05) continue;
      const lo = (s === 'front' || s === 'rear' ? inner.x : inner.y) + w / 2 + 0.02;
      const hi = lo + len - w - 0.04;
      for (const cc of pass === 0 ? [sideCentre(inner, s)] : [sideCentre(inner, s), lo, hi]) {
        const p = againstSide(inner, s, w, wr.d, clamp(cc, lo, hi));
        if (place('wardrobe', p.aabb, p.face, { w, d: wr.d })) { placed = true; break wardrobe; }
      }
    }
  }
  if (!placed) ctx.warnings.push(`${room.def.name}: no wall free for a wardrobe`);
  if (isMaster && ctx.detail === 'high') {
    const dr = FURNITURE_CATALOG.dresser;
    const s = oppSide(head);
    const p = againstSide(inner, s, dr.w, dr.d, sideCentre(inner, s));
    place('dresser', p.aabb, p.face);
  }
}

function furnishLiving(room: RoomRec, ctx: FurnishCtx, place: PlaceFn, inner: Rect, shared: boolean, compact = false): void {
  const occ = ctx.occupants;
  const sofaTypes: FurnitureType[] = occ >= 3 || shared ? ['sofa-3', 'sofa-2'] : ['sofa-2', 'sofa-3'];
  // sofa backs onto an internal wall and faces the opposite wall where the TV sits
  let back: Side = bestBackWall(room, ctx);
  let sofa = FURNITURE_CATALOG[sofaTypes[0]];
  let seated = false;
  sofaSearch:
  for (const b of rankedWalls(room, ctx)) {
    const alongB = sideLength(inner, b);
    const acrossB = b === 'front' || b === 'rear' ? inner.h : inner.w;
    for (const st of sofaTypes) {
      const spec = FURNITURE_CATALOG[st];
      const w = Math.min(spec.w, alongB - 0.2);
      if (w < 1.4 || acrossB < spec.d + 0.6) continue;
      const p = againstSide(inner, b, w, spec.d, sideCentre(inner, b));
      if (place(st, p.aabb, p.face, { w, d: spec.d })) { back = b; sofa = spec; seated = true; break sofaSearch; }
    }
  }
  const front = oppSide(back);
  if (!seated) ctx.warnings.push(`${room.def.name}: no wall takes a sofa (${room.local.w.toFixed(2)} × ${room.local.h.toFixed(2)} m)`);
  // coffee table 0.4 m in front of the sofa
  const ct = FURNITURE_CATALOG['coffee-table'];
  const depth = sideLength(inner, back === 'front' || back === 'rear' ? 'left' : 'front');
  if (depth > sofa.d + CLEARANCE.sofaCoffee + ct.d + 0.3) {
    const ctAabb = offsetFrom(inner, back, sofa.d + CLEARANCE.sofaCoffee, ct.w, ct.d, sideCentre(inner, back));
    place('coffee-table', ctAabb.aabb, ctAabb.face);
  }
  // TV on the opposite wall
  const tv = FURNITURE_CATALOG['tv-unit'];
  const tvP = againstSide(inner, front, tv.w, tv.d, sideCentre(inner, front));
  place('tv-unit', tvP.aabb, tvP.face);
  if (!compact && (occ >= 3 || shared)) {
    const ac = FURNITURE_CATALOG.armchair;
    const s: Side = back === 'front' || back === 'rear' ? 'left' : 'front';
    const ap = againstSide(inner, s, ac.w, ac.d, sideCentre(inner, s));
    place('armchair', ap.aabb, ap.face);
  }
  if (shared || (!compact && room.local.w * room.local.h > 24)) {
    furnishDining(room, ctx, place, inner, true);
  }
  if (compact) {
    // studio: a bed in the living/kitchen room, in the corner farthest from the kitchen run
    const bedType: FurnitureType = ctx.occupants >= 2 ? 'bed-double' : 'bed-single';
    const b = FURNITURE_CATALOG[bedType];
    const head = bestBackWall(room, ctx, [room.cell.wetEdge === 'v-' ? 'front' : 'rear']);
    const len = sideLength(inner, head);
    const cc = head === 'front' || head === 'rear' ? inner.x + Math.min(len - b.w / 2 - 0.1, b.w / 2 + 0.1) : inner.y + Math.min(len - b.w / 2 - 0.1, b.w / 2 + 0.1);
    const bp = againstSide(inner, head, b.w, b.d, cc);
    if (!place(bedType, bp.aabb, bp.face)) {
      const s2 = FURNITURE_CATALOG['bed-single'];
      const bp2 = againstSide(inner, head, s2.w, s2.d, cc);
      place('bed-single', bp2.aabb, bp2.face);
    }
  }
}

function offsetFrom(inner: Rect, s: Side, off: number, w: number, d: number, centre: number): { aabb: Rect; face: LDir } {
  switch (s) {
    case 'front': return { aabb: { x: centre - w / 2, y: inner.y + off, w, h: d }, face: 'v+' };
    case 'rear': return { aabb: { x: centre - w / 2, y: inner.y + inner.h - off - d, w, h: d }, face: 'v-' };
    case 'left': return { aabb: { x: inner.x + off, y: centre - w / 2, w: d, h: w }, face: 'u+' };
    default: return { aabb: { x: inner.x + inner.w - off - d, y: centre - w / 2, w: d, h: w }, face: 'u-' };
  }
}

function furnishDining(room: RoomRec, ctx: FurnishCtx, place: PlaceFn, inner: Rect, secondary = false): void {
  const occ = ctx.occupants;
  const type: FurnitureType = occ >= 5 ? 'dining-table-6' : 'dining-table-4';
  const spec = FURNITURE_CATALOG[type];
  // table centred in the free part of the room
  const cx = secondary ? inner.x + inner.w - spec.w / 2 - CLEARANCE.diningPull : inner.x + inner.w / 2;
  const cy = secondary ? inner.y + inner.h / 2 : inner.y + inner.h / 2;
  const aabb: Rect = { x: cx - spec.w / 2, y: cy - spec.d / 2, w: spec.w, h: spec.d };
  const t = place(type, aabb, 'v+');
  if (!t) {
    const small = FURNITURE_CATALOG['dining-table-4'];
    place('dining-table-4', { x: cx - small.w / 2, y: cy - small.d / 2, w: small.w, h: small.d }, 'v+');
    return;
  }
  const ch = FURNITURE_CATALOG['dining-chair'];
  const seats = clamp(occ, 2, 6);
  const perSide = Math.ceil(seats / 2);
  for (let k = 0; k < perSide; k++) {
    const x = aabb.x + (aabb.w * (k + 0.5)) / perSide - ch.w / 2;
    place('dining-chair', { x, y: aabb.y - ch.d - 0.03, w: ch.w, h: ch.d }, 'v+');
    if (k * 2 + 1 < seats) place('dining-chair', { x, y: aabb.y + aabb.h + 0.03, w: ch.w, h: ch.d }, 'v-');
  }
}

/** Counter run along the wet wall: fridge, counter, range, counter, sink, dishwasher (ARC-20). */
function furnishKitchenRun(room: RoomRec, ctx: FurnishCtx, place: PlaceFn, inner: Rect, wetEdge: LDir, big: boolean): number {
  const side: Side = wetEdge === 'v+' ? 'rear' : wetEdge === 'v-' ? 'front' : wetEdge === 'u+' ? 'right' : 'left';
  const setback = SIZES.wetWallT / 2;
  const base = insetLocal(inner, 0);
  // pull the run off the wet wall centreline by half the wall thickness
  const runInner: Rect = side === 'rear' ? { ...base, h: base.h - setback }
    : side === 'front' ? { ...base, y: base.y + setback, h: base.h - setback }
    : side === 'right' ? { ...base, w: base.w - setback }
    : { ...base, x: base.x + setback, w: base.w - setback };
  const along = sideLength(runInner, side);
  const d = 0.6;
  const seq: { type: FurnitureType; w: number }[] = [];
  const fridge = FURNITURE_CATALOG.fridge;
  const range = FURNITURE_CATALOG.range;
  const sink = FURNITURE_CATALOG['kitchen-sink'];
  const dw = FURNITURE_CATALOG.dishwasher;
  const need = fridge.w + range.w + sink.w + dw.w;
  let fridgeOnReturn = false;
  if (along < need + 0.2) {
    // galley too short for one run: keep sink + range on the wet wall, fridge round the corner (L-run)
    if (along >= sink.w + range.w + fridge.w) {
      seq.push({ type: 'fridge', w: fridge.w }, { type: 'range', w: range.w }, { type: 'kitchen-sink', w: sink.w });
    } else if (along >= sink.w + range.w) {
      seq.push({ type: 'range', w: range.w }, { type: 'kitchen-sink', w: sink.w });
      fridgeOnReturn = true;
    } else if (along >= sink.w) {
      seq.push({ type: 'kitchen-sink', w: sink.w });
      fridgeOnReturn = true;
      ctx.warnings.push(`${room.def.name}: counter run only ${along.toFixed(2)} m — no space for a range on the wet wall`);
    } else {
      ctx.warnings.push(`${room.def.name}: counter run only ${along.toFixed(2)} m — kitchen fixtures reduced`);
    }
  } else {
    const spare = along - need;
    const gap = clamp(spare / 3, 0.15, 0.9);
    seq.push({ type: 'fridge', w: fridge.w });
    if (gap > 0.35) seq.push({ type: 'kitchen-counter', w: gap });
    seq.push({ type: 'range', w: range.w });
    if (gap > 0.35) seq.push({ type: 'kitchen-counter', w: gap });
    seq.push({ type: 'kitchen-sink', w: sink.w });
    seq.push({ type: 'dishwasher', w: dw.w });
    const tail = along - sum(seq.map(s => s.w));
    if (tail > 0.35) seq.push({ type: 'kitchen-counter', w: tail });
  }
  // lay the sequence out from the low end of the run
  const start = side === 'front' || side === 'rear' ? runInner.x : runInner.y;
  let cur = start + Math.max(0, (along - sum(seq.map(s => s.w))) / 2);
  const spots: Partial<Record<FurnitureType, Vec2>> = {};
  for (const s of seq) {
    const p = againstSide(runInner, side, s.w, d, cur + s.w / 2);
    const f = place(s.type, p.aabb, p.face, { w: s.w, d });
    if (f) spots[s.type] = [p.aabb.x + p.aabb.w / 2, p.aabb.y + p.aabb.h / 2];
    cur += s.w;
  }
  // fridge on the return leg of an L-shaped run
  if (fridgeOnReturn) {
    const lateral: Side[] = side === 'front' || side === 'rear' ? ['left', 'right'] : ['front', 'rear'];
    for (const ls of lateral) {
      const len = sideLength(runInner, ls);
      if (len < fridge.d + 0.1) continue;
      const c0 = (ls === 'front' || ls === 'rear' ? runInner.x : runInner.y) + fridge.w / 2 + 0.02;
      const far = (ls === 'front' || ls === 'rear' ? runInner.x + runInner.w : runInner.y + runInner.h) - fridge.w / 2 - 0.02;
      const cAt = side === 'rear' || side === 'right' ? c0 : far;
      const p = againstSide(runInner, ls, fridge.w, fridge.d, cAt);
      if (place('fridge', p.aabb, p.face)) { spots.fridge = [p.aabb.x + p.aabb.w / 2, p.aabb.y + p.aabb.h / 2]; break; }
    }
  }
  // island where the room is deep enough (1.2 m aisle both sides)
  const across = side === 'front' || side === 'rear' ? runInner.h : runInner.w;
  const aisle = ctx.accessible ? CLEARANCE.turningCircle : CLEARANCE.kitchenAisle;
  const island = FURNITURE_CATALOG['kitchen-island'];
  if (big && across > d + aisle + island.d + 0.8 && along > island.w + 0.6 && ctx.detail !== 'low') {
    const p = offsetFrom(runInner, side, d + aisle, Math.min(island.w, along - 0.6), island.d, sideCentre(runInner, side));
    place('kitchen-island', p.aabb, p.face, { w: Math.min(island.w, along - 0.6), d: island.d });
  }
  // work triangle: sink → range → fridge (straight-line legs, ARC-20)
  const legs: number[] = [];
  const sk = spots['kitchen-sink'];
  const rg = spots.range;
  const fr = spots.fridge;
  const leg = (a?: Vec2, b?: Vec2): void => { if (a && b) legs.push(Math.hypot(a[0] - b[0], a[1] - b[1])); };
  leg(sk, rg);
  leg(rg, fr);
  leg(fr, sk);
  const triangle = legs.length === 3 ? sum(legs) : 0;
  if (triangle > 0 && (triangle < 2.6 || triangle > 8.2)) {
    ctx.warnings.push(`${room.def.name}: work triangle ${triangle.toFixed(2)} m is outside the 4–8 m guideline (ARC-20)`);
  }
  return triangle;
}

/** Candidate start offsets for a fixture run along a wall: centred first, then a 100 mm sweep. */
function offsets(spare: number): number[] {
  if (spare <= 0.02) return [Math.max(0, spare / 2)];
  const out = [spare / 2, 0.02];
  for (let x = 0.1; x < spare; x += 0.1) out.push(x);
  out.push(Math.max(0.02, spare - 0.02));
  return out;
}

function furnishBathroom(room: RoomRec, ctx: FurnishCtx, place: PlaceFn, probe: (r: Rect) => boolean, inner: Rect, wetEdge: LDir): void {
  const wetSide: Side = wetEdge === 'v+' ? 'rear' : wetEdge === 'v-' ? 'front' : wetEdge === 'u+' ? 'right' : 'left';
  const setback = SIZES.wetWallT / 2;
  const type = room.cell.type;
  const area = room.local.w * room.local.h;
  const wc = FURNITURE_CATALOG.wc;
  const lav = FURNITURE_CATALOG.lavatory;
  const van = FURNITURE_CATALOG.vanity;
  const sh = FURNITURE_CATALOG.shower;
  const tub = FURNITURE_CATALOG.bathtub;

  /** the run wall, pulled back by half the wet wall so no fixture sits inside the wall */
  const baseFor = (side: Side): Rect => (side === 'rear' ? { ...inner, h: inner.h - setback }
    : side === 'front' ? { ...inner, y: inner.y + setback, h: inner.h - setback }
    : side === 'right' ? { ...inner, w: inner.w - setback }
    : { ...inner, x: inner.x + setback, w: inner.w - setback });

  interface Fix { type: FurnitureType; w: number; d: number }
  const fixturesFor = (along: number): Fix[] => {
    const out: Fix[] = [];
    if (type === 'powder' || type === 'wc') {
      out.push({ type: 'wc', w: wc.w, d: wc.d }, { type: 'lavatory', w: lav.w, d: lav.d });
      return out;
    }
    if (ctx.accessible) {
      // ADA 2010 §604/§608: 0.45 m to the WC centreline, roll-in shower 1.5 × 0.9
      out.push({ type: 'wc', w: 0.45, d: wc.d }, { type: 'vanity', w: van.w, d: van.d }, { type: 'shower', w: 1.5, d: 0.9 });
      return out;
    }
    out.push({ type: 'wc', w: wc.w, d: wc.d });
    out.push(along > 2.4 || area > 5 ? { type: 'vanity', w: van.w, d: van.d } : { type: 'lavatory', w: lav.w, d: lav.d });
    const rest = along - sum(out.map(i => i.w)) - 0.1;
    if (rest >= tub.w && area >= 5.4 && type !== 'ensuite') out.push({ type: 'bathtub', w: tub.w, d: tub.d });
    else if (rest >= sh.w) out.push({ type: 'shower', w: sh.w, d: sh.d });
    return out;
  };

  const runFrom = (base: Rect, side: Side, items: Fix[], off: number): Rect[] => {
    const start = side === 'front' || side === 'rear' ? base.x : base.y;
    const out: Rect[] = [];
    let c = start + off;
    for (const it of items) {
      out.push(againstSide(base, side, it.w, it.d, c + it.w / 2).aabb);
      c += it.w;
    }
    return out;
  };

  // Choose the wall for the fixture run: the wet wall first (one stack, ARC-14/21), then the wall
  // opposite it, then the lateral walls — whichever keeps every fixture clear of the door swing.
  // A lateral run still corners into the wet wall, so it keeps the branch short; the wall opposite
  // the wet wall is the last resort.
  const lateral: Side[] = wetSide === 'front' || wetSide === 'rear' ? ['left', 'right'] : ['front', 'rear'];
  const candidates: Side[] = [wetSide, ...lateral, oppSide(wetSide)];
  for (const side of candidates) {
    // always measured on the wet-wall-setback rect so nothing lands inside the 0.2 m wall
    const base = baseFor(wetSide);
    const along = sideLength(base, side);
    const items = fixturesFor(along);
    const run = sum(items.map(i => i.w));
    if (run > along + 1e-6) continue;
    const spare = along - run;
    // walk the run along the wall in 100 mm steps: in a small room the only clear stretch is the
    // one past the door swing, and the centred position is never it (ARC-28)
    for (const off of offsets(spare)) {
      const boxes = runFrom(base, side, items, off);
      if (!boxes.every(b => probe(b))) continue;
      items.forEach((it, k) => {
        const face: LDir = side === 'front' ? 'v+' : side === 'rear' ? 'v-' : side === 'left' ? 'u+' : 'u-';
        place(it.type, boxes[k], face, { w: it.w, d: it.d });
      });
      if (side === oppSide(wetSide)) {
        ctx.warnings.push(`${room.def.name}: fixtures run on the wall opposite the wet wall because the door swing covers it — branch length ${(sideLength(base, side) > 0 ? Math.min(room.local.w, room.local.h) : 0).toFixed(2)} m (XD-01 allows 3 m)`);
      }
      furnishGrabRails(room, ctx, place, baseFor(wetSide), wetSide);
      return;
    }
  }

  // Nothing fits in one run: keep the WC and basin on the wet wall and turn the shower/tub
  // onto a lateral wall (two-wall bathroom).
  const base = baseFor(wetSide);
  const along = sideLength(base, wetSide);
  const items = fixturesFor(along);
  const last = items[items.length - 1];
  if (items.length > 2 && (last.type === 'shower' || last.type === 'bathtub')) {
    for (const ls of lateral) {
      if (sideLength(base, ls) < last.w + 0.1) continue;
      const c0 = (ls === 'front' || ls === 'rear' ? base.x : base.y) + last.w / 2;
      const far = (ls === 'front' || ls === 'rear' ? base.x + base.w : base.y + base.h) - last.w / 2;
      let done = false;
      for (const cAt of wetSide === 'rear' || wetSide === 'right' ? [c0, c0 + 0.1, far, far - 0.1] : [far, far - 0.1, c0, c0 + 0.1]) {
        const p = againstSide(base, ls, last.w, last.d, cAt);
        if (place(last.type, p.aabb, p.face, { w: last.w, d: last.d })) { items.pop(); done = true; break; }
      }
      if (done) break;
    }
  }
  while (items.length > 1 && sum(items.map(i => i.w)) > along) items.pop();
  // the shorter run (WC + basin) now only needs a clear stretch on ANY wall of the room
  for (const side of candidates) {
    const alongS = sideLength(base, side);
    const runS = sum(items.map(i => i.w));
    if (runS > alongS + 1e-6) continue;
    for (const off of offsets(alongS - runS)) {
      const boxes2 = runFrom(base, side, items, off);
      if (!boxes2.every(b => probe(b))) continue;
      const face: LDir = side === 'front' ? 'v+' : side === 'rear' ? 'v-' : side === 'left' ? 'u+' : 'u-';
      items.forEach((it, k) => place(it.type, boxes2[k], face, { w: it.w, d: it.d }));
      furnishGrabRails(room, ctx, place, base, wetSide);
      return;
    }
  }
  const spare = Math.max(0, along - sum(items.map(i => i.w)));
  const boxes = runFrom(base, wetSide, items, spare / 2);
  items.forEach((it, k) => {
    const face: LDir = wetSide === 'front' ? 'v+' : wetSide === 'rear' ? 'v-' : wetSide === 'left' ? 'u+' : 'u-';
    if (!place(it.type, boxes[k], face, { w: it.w, d: it.d })) {
      ctx.warnings.push(`${room.def.name}: no clear position for the ${it.type} in a ${room.local.w.toFixed(2)} × ${room.local.h.toFixed(2)} m room`);
    }
  });
  furnishGrabRails(room, ctx, place, base, wetSide);
}

/** ADA 2010 §604.5 / §608.3 grab rails beside the WC and in the shower. */
function furnishGrabRails(room: RoomRec, ctx: FurnishCtx, place: PlaceFn, base: Rect, wetSide: Side): void {
  if (!ctx.accessible) return;
  const rail = FURNITURE_CATALOG['grab-rail'];
  const order: Side[] = wetSide === 'front' || wetSide === 'rear' ? ['left', 'right', 'front', 'rear'] : ['front', 'rear', 'left', 'right'];
  let rails = 0;
  for (const s of order) {
    if (rails >= 2) break;
    const len = sideLength(base, s);
    if (len < rail.w + 0.05) continue;
    const lo = (s === 'front' || s === 'rear' ? base.x : base.y) + rail.w / 2 + 0.02;
    const hi = lo + len - rail.w - 0.04;
    for (const cc of [sideCentre(base, s), lo, hi, (lo + sideCentre(base, s)) / 2]) {
      const p = againstSide(base, s, rail.w, rail.d, clamp(cc, lo, hi));
      if (place('grab-rail', p.aabb, p.face)) { rails++; break; }
    }
  }
  if (rails === 0) ctx.warnings.push(`${room.def.name}: no clear wall for a grab rail`);
}

function furnishLaundry(room: RoomRec, ctx: FurnishCtx, place: PlaceFn, inner: Rect, wetEdge: LDir): void {
  let side: Side = wetEdge === 'v+' ? 'rear' : wetEdge === 'v-' ? 'front' : wetEdge === 'u+' ? 'right' : 'left';
  let along = sideLength(inner, side);
  const w = FURNITURE_CATALOG.washer;
  let start = side === 'front' || side === 'rear' ? inner.x : inner.y;
  let wide = along >= 2 * w.w + 0.05;
  let washer: FurnitureDef | null = null;
  for (const trySide of [side, ...rankedWalls(room, ctx)]) {
    const len = sideLength(inner, trySide);
    if (len < w.w + 0.05) continue;
    const s0 = trySide === 'front' || trySide === 'rear' ? inner.x : inner.y;
    wide = len >= 2 * w.w + 0.05;
    const p1 = againstSide(inner, trySide, w.w, w.d, wide ? s0 + w.w / 2 : sideCentre(inner, trySide));
    washer = place('washer', p1.aabb, p1.face);
    if (washer) { side = trySide; start = s0; along = len; break; }
  }
  if (!washer) {
    ctx.warnings.push(`${room.def.name}: washer does not fit (${room.local.w.toFixed(2)} × ${room.local.h.toFixed(2)} m)`);
    return;
  }
  // dryer beside it, else on the opposite wall, else in line behind it (deep closet)
  const tries: { aabb: Rect; face: LDir }[] = [];
  if (wide) tries.push(againstSide(inner, side, w.w, w.d, start + 1.5 * w.w + 0.03));
  tries.push(againstSide(inner, oppSide(side), w.w, w.d, sideCentre(inner, oppSide(side))));
  tries.push(offsetFrom(inner, side, w.d + 0.05, w.w, w.d, sideCentre(inner, side)));
  let dried = false;
  for (const t2 of tries) if (place('dryer', t2.aabb, t2.face)) { dried = true; break; }
  if (!dried) ctx.warnings.push(`${room.def.name}: only ${along.toFixed(2)} m of wall and ${(side === 'front' || side === 'rear' ? inner.h : inner.w).toFixed(2)} m depth — washer and dryer must stack`);
  if (ctx.detail === 'high') {
    const wh = FURNITURE_CATALOG['water-heater'];
    const s = oppSide(side);
    const p = againstSide(inner, s, wh.w, wh.d, sideCentre(inner, s));
    place('water-heater', p.aabb, p.face);
  }
}

function furnishStore(room: RoomRec, ctx: FurnishCtx, place: PlaceFn, inner: Rect): void {
  const shelf = FURNITURE_CATALOG.shelving;
  const back = bestBackWall(room, ctx);
  const len = sideLength(inner, back);
  const w = clamp(len - 0.1, 0.5, 2.4);
  const p = againstSide(inner, back, w, shelf.d, sideCentre(inner, back));
  if (!place('shelving', p.aabb, p.face, { w, d: shelf.d })) {
    const p2 = againstSide(inner, oppSide(back), Math.min(w, 0.9), shelf.d, sideCentre(inner, oppSide(back)));
    place('shelving', p2.aabb, p2.face, { w: Math.min(w, 0.9), d: shelf.d });
  }
  if (room.cell.type === 'walk-in-closet' && ctx.detail !== 'low') {
    const s = oppSide(back);
    const len2 = sideLength(inner, s);
    const w2 = clamp(len2 - 0.1, 0.5, 2.4);
    const p2 = againstSide(inner, s, w2, shelf.d, sideCentre(inner, s));
    place('shelving', p2.aabb, p2.face, { w: w2, d: shelf.d });
  }
}

function furnishEntry(room: RoomRec, ctx: FurnishCtx, place: PlaceFn, inner: Rect): void {
  const b = FURNITURE_CATALOG.bench;
  const back = bestBackWall(room, ctx);
  const len = sideLength(inner, back);
  const w = clamp(len - 0.3, 0.6, 1.4);
  const p = againstSide(inner, back, w, b.d, sideCentre(inner, back));
  place('bench', p.aabb, p.face, { w, d: b.d });
}

function furnishStudy(room: RoomRec, ctx: FurnishCtx, place: PlaceFn, inner: Rect): void {
  const d = FURNITURE_CATALOG.desk;
  const back = bestBackWall(room, ctx);
  const p = againstSide(inner, back, d.w, d.d, sideCentre(inner, back));
  const desk = place('desk', p.aabb, p.face);
  if (desk) {
    const ch = FURNITURE_CATALOG.chair;
    const cp = offsetFrom(inner, back, d.d + 0.05, ch.w, ch.d, sideCentre(inner, back));
    place('chair', cp.aabb, cp.face);
  }
  if (ctx.detail !== 'low') {
    const s = oppSide(back);
    const bc = FURNITURE_CATALOG.bookcase;
    const p2 = againstSide(inner, s, bc.w, bc.d, sideCentre(inner, s));
    place('bookcase', p2.aabb, p2.face);
  }
}

function furnishBalcony(room: RoomRec, ctx: FurnishCtx, place: PlaceFn, inner: Rect): void {
  const tb = FURNITURE_CATALOG['outdoor-table'];
  const ch = FURNITURE_CATALOG.chair;
  const cx = inner.x + inner.w / 2;
  const cy = inner.y + inner.h / 2;
  const t = place('outdoor-table', { x: cx - tb.w / 2, y: cy - tb.d / 2, w: tb.w, h: tb.d }, 'v+');
  if (t) {
    place('chair', { x: cx - tb.w / 2 - ch.w - 0.05, y: cy - ch.d / 2, w: ch.w, h: ch.d }, 'u+');
    place('chair', { x: cx + tb.w / 2 + 0.05, y: cy - ch.d / 2, w: ch.w, h: ch.d }, 'u-');
  }
  if (ctx.detail === 'high') {
    place('planter', { x: inner.x, y: inner.y, w: FURNITURE_CATALOG.planter.w, h: FURNITURE_CATALOG.planter.d }, 'v+');
  }
}

function furnishGarage(room: RoomRec, ctx: FurnishCtx, place: PlaceFn, inner: Rect): void {
  const car = FURNITURE_CATALOG.car;
  const xs = [inner.x + inner.w / 2 - car.w / 2, inner.x, inner.x + inner.w - car.w];
  let parked = false;
  for (const x of xs) {
    if (place('car', { x, y: inner.y + 0.3, w: car.w, h: car.d }, 'v-')) { parked = true; break; }
  }
  if (!parked) ctx.warnings.push(`${room.def.name}: no room for a car (${room.local.w.toFixed(2)} × ${room.local.h.toFixed(2)} m)`);
  const br = FURNITURE_CATALOG['bike-rack'];
  const p = againstSide(inner, 'rear', Math.min(br.w, inner.w - 0.2), br.d, sideCentre(inner, 'rear'));
  place('bike-rack', p.aabb, p.face, { w: Math.min(br.w, inner.w - 0.2), d: br.d });
}

// ============================================================================
// Pattern applications
// ============================================================================

interface PatCtx {
  req: UnitLayoutRequest;
  rooms: RoomRec[];
  walls: WallDef[];
  doors: DoorDef[];
  windows: WindowDef[];
  furniture: FurnitureDef[];
  plan: PlanResult;
  wetWallIds: string[];
  triangle: number;
  storageM3: number;
  accessible: boolean;
  frame: Frame;
  /** total glazed area placed in this unit, and the unit's own exterior wall area */
  glazedArea: number;
  facadeArea: number;
  /** the part of that wall standing in front of a room that can take a window */
  glazableArea: number;
  /** closets/stores the plan merged into furniture instead of building */
  mergedRooms: RoomType[];
  /** local u the plumbing stack ended up on, and the one the organizer asked for */
  stackAtU: number;
  stackWantU?: number;
}

function buildPatternApplications(c: PatCtx): PatternApplication[] {
  const { req } = c;
  const out: PatternApplication[] = [];
  const add = (patternId: string, params: Record<string, number | string | boolean>, note?: string): void => {
    out.push({ patternId, storey: req.storey, unitId: req.unitId, params, note });
  };
  const wetRooms = c.rooms.filter(r => r.wet);
  const kitchen = c.rooms.find(r => r.cell.type === 'kitchen' || r.cell.type === 'living-kitchen' || r.cell.type === 'shared-kitchen');
  const baths = c.rooms.filter(r => BATH_TYPES.has(r.cell.type));

  if (c.wetWallIds.length > 0) {
    const longest = c.walls.filter(w => w.type === 'wet').sort((a, b) => wallLen(b) - wallLen(a))[0];
    add('ARC-14', {
      frontBandDepth: round(c.plan.frontDepth, 3),
      wetWallCount: c.wetWallIds.length,
      wetWallThickness: SIZES.wetWallT,
      wetRooms: wetRooms.length,
      stackWallLength: longest ? round(wallLen(longest), 3) : 0,
    }, 'kitchen and bathrooms share one wet band along the access side');
    add('XD-01', {
      wetWallThickness: SIZES.wetWallT,
      stackAlong: req.stackAlong === undefined ? -1 : round(req.stackAlong, 3),
      stackAtU: round(c.stackAtU, 3),
      stackHonoured: c.stackWantU === undefined || Math.abs(c.stackAtU - c.stackWantU) < 0.05,
      wetBandFrom: round(c.plan.wetSpan?.lo ?? c.stackAtU, 3),
      wetBandTo: round(c.plan.wetSpan?.hi ?? c.stackAtU, 3),
      wetRooms: wetRooms.length,
    }, c.plan.kind === 'through'
      ? 'one plumbing stack per unit in the wet wall between the kitchen and the bathroom; the slot rect repeats on every storey so the stacks align'
      : 'one plumbing stack per unit in the wet wall');
    if (kitchen && baths.length > 0) {
      add('ARC-21', { bathrooms: baths.length, sharedWetWalls: c.wetWallIds.length, backToBack: baths.length > 1 }, 'bathrooms and kitchen fixtures stand on the same wet wall');
    }
  }
  const beds = c.rooms.filter(r => PRIVATE_TYPES.has(r.cell.type));
  if (beds.length > 0) {
    const minWidth = Math.min(...beds.map(b => Math.min(b.world.w, b.world.h)));
    const minArea = Math.min(...beds.map(b => b.def.area));
    add('ARC-15', {
      bedrooms: beds.length,
      minBedroomWidth: round(minWidth, 3),
      minBedroomArea: round(minArea, 2),
      bedSideClearance: CLEARANCE.bedSide,
      compliantDouble: minWidth >= 2.75 - 0.02 && minArea >= 11.5 - 0.1,
    }, 'room sizes derived from furniture plus clearances');
    const entry = c.rooms.find(r => r.cell.type === 'entry');
    const far = beds.reduce((m, b) => Math.max(m, entry ? Math.abs(b.local.x - entry.local.x) : 0), 0);
    add('ARC-19', { bedrooms: beds.length, hallDepth: round(c.plan.hallDepth, 3), bedroomOffsetFromEntry: round(far, 2) }, 'bedrooms placed at the far end of the frontage behind a hall');
  }
  if (c.windows.length > 0) {
    const glazed = sum(c.windows.map(w => w.width * w.height));
    add('ARC-16', {
      windows: c.windows.length,
      targetWwr: round(req.wwr, 3),
      achievedWwr: round(c.facadeArea > 1e-6 ? c.glazedArea / c.facadeArea : 0, 4),
      achievedWwrGlazable: round(c.glazableArea > 1e-6 ? c.glazedArea / c.glazableArea : 0, 4),
      facadeArea: round(c.facadeArea, 2),
      glazableArea: round(c.glazableArea, 2),
      glazedArea: round(glazed, 2),
      glazedAreaWithDoors: round(c.glazedArea, 2),
      sillMin: Math.min(...c.windows.map(w => w.sill)),
      headMax: round(Math.max(...c.windows.map(w => w.sill + w.height)), 3),
      widthMin: round(Math.min(...c.windows.map(w => w.width)), 3),
      widthMax: round(Math.max(...c.windows.map(w => w.width)), 3),
      meetsTarget: c.glazableArea > 1e-6 && c.glazedArea / c.glazableArea >= req.wwr - 0.05,
    }, 'glazing budget shared per exterior wall in proportion to each room’s wall span');
  }
  if (c.plan.kind === 'through') {
    const daylitRooms = c.rooms.filter(r => !r.outside && (r.cell.prog?.needsExterior ?? BACK_TYPES.has(r.cell.type)));
    const lit = daylitRooms.filter(r => r.def.windowIds.length > 0);
    const halls = c.rooms.filter(r => r.cell.type === 'hall' || r.cell.type === 'entry');
    const facades = (['front', 'rear', 'left', 'right'] as Side[]).filter(s => req.exteriorSides.includes(s));
    add('ARC-36', {
      hallDepth: round(c.plan.hallDepth, 3),
      facadeCount: facades.length,
      facades: facades.join('/'),
      habitableRooms: daylitRooms.length,
      habitableRoomsLit: lit.length,
      dualAspect: facades.length >= 2,
      circulationArea: round(sum(halls.map(r => r.def.area)), 2),
      circulationShare: round(sum(halls.map(r => r.def.area)) / Math.max(sum(c.rooms.filter(r => !r.outside).map(r => r.def.area)), 1), 3),
      livingExposure: (() => {
        const living = c.rooms.find(r => r.cell.type === 'living' || r.cell.type === 'living-kitchen');
        if (!living) return 'none';
        const s = (['front', 'rear', 'left', 'right'] as Side[])
          .find(x => req.exteriorSides.includes(x) && touchesLocalSide(living.local, c.frame.localSide(x), c.frame.F, c.frame.D));
        return s ? `${s}:${req.exposures[s] ?? '?'}` : 'internal';
      })(),
    }, 'side entry, hall along the landing wall, daylit rooms on both end façades');
  }
  const bal = c.rooms.find(r => r.cell.type === 'balcony');
  if (bal && req.balcony) {
    add('ARC-17', { depth: round(req.balcony.depth, 2), area: round(bal.def.area, 2), side: req.balcony.side, meetsSixFoot: req.balcony.depth >= 1.8 });
  }
  const entryRoom = c.rooms.find(r => r.cell.type === 'entry');
  if (entryRoom) {
    add('ARC-18', { area: round(entryRoom.def.area, 2), minWidth: round(Math.min(entryRoom.world.w, entryRoom.world.h), 3), entryDoorWidth: SIZES.doorUnitEntry });
  }
  if (c.triangle > 0) {
    add('ARC-20', { workTriangle: round(c.triangle, 3), aisle: c.accessible ? CLEARANCE.turningCircle : CLEARANCE.kitchenAisle, inRange: c.triangle >= 3.6 && c.triangle <= 8.2 });
  }
  if (c.plan.stair) {
    add('ARC-22', {
      risers: c.plan.stair.risers,
      riserHeight: round(c.plan.stair.riserHeight, 4),
      tread: c.plan.stair.tread,
      width: round(c.plan.stair.width, 3),
      level: req.level,
      stacked: true,
    }, 'identical stair footprint on every level of the unit');
  }
  if (c.accessible) {
    const bath = baths[0];
    add('ARC-23', {
      doorWidth: 0.9,
      turningCircle: CLEARANCE.turningCircle,
      bathroomWidth: bath ? round(Math.min(bath.world.w, bath.world.h), 3) : 0,
      rollInShower: c.furniture.some(f => f.type === 'shower' && Math.max(f.width, f.depth) >= 1.4),
      grabRails: c.furniture.filter(f => f.type === 'grab-rail').length,
    });
  }
  if (req.template.id === 'coliving-cluster') {
    const rooms = c.rooms.filter(r => r.cell.type === 'bedroom').length;
    const shared = sum(c.rooms.filter(r => r.cell.type === 'shared-living' || r.cell.type === 'shared-kitchen').map(r => r.def.area));
    add('ARC-24', { rooms, sharedArea: round(shared, 2), sharedPerResident: round(shared / Math.max(rooms, 1), 2), diningSeats: c.furniture.filter(f => f.type === 'dining-chair').length });
  }
  if (req.template.id === 'dual-key') {
    const vest = c.rooms.find(r => r.cell.type === 'entry');
    add('ARC-25', {
      vestibuleArea: vest ? round(vest.def.area, 2) : 0,
      lockableDoors: c.doors.filter(d => d.type === 'interior' && d.fromRoomId === vest?.id).length,
      studioRooms: c.rooms.filter(r => r.cell.sub === 'studio').length,
    });
  }
  const extSides = req.exteriorSides.length;
  const living = c.rooms.find(r => r.cell.type === 'living' || r.cell.type === 'living-kitchen');
  if (extSides >= 2 && living) {
    const sides = (['front', 'rear', 'left', 'right'] as Side[]).filter(s => {
      const ls = c.frame.localSide(s);
      return req.exteriorSides.includes(s) && touchesLocalSide(living.local, ls, c.frame.F, c.frame.D);
    });
    add('ARC-26', { exteriorSides: extSides, livingExteriorSides: sides.length, lightOnTwoSides: sides.length >= 2 });
  }
  const closets = c.rooms.filter(r => r.cell.type === 'closet' || r.cell.type === 'walk-in-closet' || r.cell.type === 'storage');
  if (closets.length > 0 || c.mergedRooms.length > 0) {
    add('ARC-27', {
      closets: closets.length,
      bufferDepth: 0.6,
      wardrobes: c.furniture.filter(f => f.type === 'wardrobe').length,
      mergedIntoWardrobes: c.mergedRooms.length,
      merged: c.mergedRooms.join('/') || 'none',
    }, c.mergedRooms.length > 0 ? 'short frontage: built-in closets provided as wardrobe runs inside the rooms they serve' : undefined);
    add('ARC-30', {
      storageVolume: round(c.storageM3, 2),
      builtInArea: round(sum(closets.map(r => r.def.area)), 2),
      occupants: req.template.occupants,
      volumePerOccupant: round(c.storageM3 / Math.max(req.template.occupants, 1), 3),
      meetsTarget: c.storageM3 / Math.max(req.template.occupants, 1) >= 0.6,
    });
  }
  add('ARC-28', {
    doors: c.doors.length,
    swingDoors: c.doors.filter(d => d.operation.includes('SWING')).length,
    casedOpenings: c.doors.filter(d => d.operation === 'NOTDEFINED').length,
    minFromCorner: 0.15,
  }, 'every opening allocated a clear interval on its host wall');
  const dining = c.furniture.filter(f => f.type === 'dining-table-4' || f.type === 'dining-table-6');
  if (dining.length > 0) {
    add('ARC-29', {
      occupants: req.template.occupants,
      seats: c.furniture.filter(f => f.type === 'dining-chair').length,
      tableWidth: round(Math.max(...dining.map(d => d.width)), 3),
      edgePerPerson: 0.6,
    });
  }
  add('XD-05', {
    occupants: req.template.occupants,
    bedspaces: sum(c.rooms.filter(r => PRIVATE_TYPES.has(r.cell.type)).map(r => r.def.occupancy)),
    bedrooms: req.template.bedrooms,
  });
  return out;
}

function wallLen(w: WallDef): number {
  return Math.hypot(w.end[0] - w.start[0], w.end[1] - w.start[1]);
}

// re-export so the organizer can size its rects from the same source of truth
export { UNIT_TEMPLATES, recommendedRect } from './templates.ts';
export { UNIT_PATTERNS } from './unit-patterns.ts';
export { FURNITURE_CATALOG } from './furniture.ts';
