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
import type { ExhaustPort, PanelPort, StackPort } from './program/types.ts';
import {
  projectOnSegment, rectContainsRect, rectToPolygon, rectsOverlap, round, segPointAt, solarScore,
  stripsXByWidths, stripsYByHeights,
} from '../../core/geometry.ts';
import { IdFactory, roomId } from '../../core/ids.ts';
import { SIZES } from '../../core/coordination.ts';
import { CLEARANCE, FURNITURE_CATALOG, storageVolume } from './furniture.ts';
import { UNIT_LEVEL_SPLIT } from './templates.ts';
import { LEAF_MIN, reachRect, solveSwing, swingRect } from '../../core/openings.ts';
import { unitPorts } from './program/ports.ts';
import type { DoorMotion } from '../../core/types.ts';
import type { KitId } from './program/types.ts';
import type { KitRules, Placement } from './program/kits.ts';
import {
  againstSide, fitKit, insetLocal, KIT, offsetFrom, offsets, oppSide, sideCentre, sideLength, TRIANGLE_MAX,
  TRIANGLE_MIN, triangleOf,
} from './program/kits.ts';

// ============================================================================
// Constants and small tables
// ============================================================================

const STAIR_TREAD = 0.26;
/** Minimum overlap of two room edges before a wall/door is worth generating (m) */
const MIN_EDGE = 0.6;
/** Minimum clear overlap needed to hang a door (m) — below this a room is landlocked */
export const MIN_DOOR_EDGE = 0.7;
const E = 1e-6;

/** Rooms that want the façade band — the fallback when a cell carries no program node. */
const BACK_TYPES = new Set<RoomType>(['living', 'living-kitchen', 'dining', 'bedroom', 'master-bedroom', 'shared-living', 'shared-kitchen', 'flex', 'study']);
const PRIVATE_TYPES = new Set<RoomType>(['bedroom', 'master-bedroom']);
const WET_TYPES = new Set<RoomType>(['kitchen', 'living-kitchen', 'bathroom', 'ensuite', 'powder', 'wc', 'laundry', 'utility', 'shared-kitchen']);
const BATH_TYPES = new Set<RoomType>(['bathroom', 'ensuite', 'powder', 'wc']);

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

/**
 * Total reveal (both sides) a door gives up to the wall that hosts it: 0.30 m on a comfortable
 * partition, 0.20 m where the shared edge is tight and 0.15 m at the limit. The leaf's CLEAR width is
 * the dimension a person passes through and the one the leaf minima are written against, while a door
 * lining is only ~25 mm of the reveal — so the reveal yields before the leaf does.
 */
function doorReveal(span: number): number {
  return span >= 1.15 ? 0.3 : span >= 1.0 ? 0.2 : 0.15;
}
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
export const transitCost = (t: RoomType): number => TRANSIT_COST[t] ?? 20;

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

export type LDir = 'u+' | 'u-' | 'v+' | 'v-';

export interface Frame {
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

export function makeFrame(r: Rect, access: Side): Frame {
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




// ============================================================================
// Width fitting
// ============================================================================





// ============================================================================
// Plan cells
// ============================================================================

export interface Cell {
  type: RoomType;
  /** v2: stable program-node ref ('bedroom2'); the v1 planner leaves it undefined */
  ref?: string;
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

export interface StairPlan { rect: Rect; risers: number; riserHeight: number; tread: number; width: number }

export interface PlanOpts {
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
}

export interface PlanResult {
  cells: Cell[];
  frontDepth: number;
  hallDepth: number;
  stair?: StairPlan;
  kind?: 'standard' | 'through' | 'cluster' | 'dual-key';
  /** local u span the wet rooms occupy — the wall the plumbing stack can stand in (XD-01) */
  wetSpan?: { lo: number; hi: number };
}








// --- through unit: dual-aspect side entry (ARC-36) --------------------------






// --- cluster (co-living) ----------------------------------------------------


// --- dual-key ---------------------------------------------------------------


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

export interface RoomRec {
  id: string;
  cell: Cell;
  local: Rect;
  world: Rect;
  def: RoomDef;
  wet: boolean;
  outside: boolean;
}

export interface Adj {
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

/**
 * v2 seam: the planning half of the engine. `program/solver.ts` supplies one of these so the
 * realisation below (walls, doors, windows, furniture, patterns) is shared by the v1 template engine
 * and the v2 program solver, and the two can be A/B-tested through `setArchitectureDeps`.
 */
export interface PlanProvider {
  /** the plan cells in the local (u, v) frame — must tile the rect */
  plan(a: { req: UnitLayoutRequest; F: number; D: number; opts: PlanOpts }): PlanResult;
  /**
   * Which room pairs get a door, as a spanning tree over the realised rooms. `null` falls back to the
   * v1 shortest-circulation tree. The v2 provider seeds it from the program graph's required edges.
   */
  doors?(a: { rooms: RoomRec[]; adjs: Adj[]; accessible: boolean; F: number; D: number }):
  { root: number; parent: (TreeLink | undefined)[] } | null;
  /** how many drainage stacks the program allows (XD-01); the port pass collapses toward it */
  maxStacks?: number;
}



export function layoutUnitWithPlan(req: UnitLayoutRequest, provider: PlanProvider): UnitLayout {
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

  // --- plan ------------------------------------------------------------------
  // Which rooms belong to this level is the PROGRAM's answer now (`program/programs.ts` gives every
  // node a level), so the realisation no longer resolves a room list of its own.
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
  const plan: PlanResult = provider.plan({ req, F, D, opts });

  // --- plumbing stack position (XD-01) --------------------------------------
  // An OUTPUT, not an input: identical modules produce identical local plans, so the wet cluster lands
  // on the same local coordinate on every floor and the stacks line up without anyone imposing one.
  // (`unitPorts` derives the real stations from the fixtures; this is the pattern trace's headline.)
  const bathCells = plan.cells.filter(c => BATH_TYPES.has(c.type));
  const stackAtU = round(bathCells.length > 0
    ? bathCells[0].rect.x + bathCells[0].rect.w / 2
    : plan.wetSpan
      ? (plan.wetSpan.lo + plan.wetSpan.hi) / 2
      : 0, 3);

  // --- rooms provided as furniture instead of as rooms (ARC-27/ARC-30) ------
  // The program declares the alternative (`mergeInto`), the solver records which ones it applied, and
  // the pattern trace reports them; nothing is silently dropped, so nothing is warned about.
  const mergedRooms = opts.dropped;

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
      // v2 program-node ref ('bedroom2'), scoped to this unit and level; door refs and stack-port
      // `serves` are built from it, so it must be derived from the plan alone (never from an id counter)
      ref: cell.ref ?? `${cell.type}${n}`,
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
  /** stable program ref of a room ('kitchen1'), for door refs and stack-port `serves` */
  const refOf = (r: RoomRec): string => r.def.ref ?? r.cell.type;
  /**
   * Reserve the leaf's motion volume inside the room it sweeps into, straight from the stored fields — the
   * v1 code derived the same square from a local `dirIn` it then threw away (the door-arc bug).
   */
  const reserveSwing = (d: DoorDef, wall: { start: Vec2; end: Vec2 }, room: RoomRec): void => {
    const sw = swingRect(d, wall);
    if (!sw) return;
    const list = swings.get(room.id) ?? [];
    list.push(frame.toLocalRect(sw));
    swings.set(room.id, list);
  };
  /** Centre of the room's wet-wall fixture run in world XY — the hinge goes on the end of the opening farther from it */
  const fixtureRunCentre = (r: RoomRec): Vec2 | null => {
    const e = r.cell.wetEdge;
    if (!e || !r.wet) return null;
    const l = r.local;
    const p: Vec2 = e === 'v+' ? [l.x + l.w / 2, l.y + l.h]
      : e === 'v-' ? [l.x + l.w / 2, l.y]
      : e === 'u+' ? [l.x + l.w, l.y + l.h / 2]
      : [l.x, l.y + l.h / 2];
    return frame.toWorld(p[0], p[1]);
  };

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
      const sol = solveSwing({
        wall: accessWall, along, width: w, motion: 'swing', into: reachRect(entryRoom.world, accessWall),
      });
      const entryDoor: DoorDef = {
        id: entryDoorId, storey: req.storey, wallId: accessWall.id, along, width: w, height: SIZES.doorHeight,
        type: 'unit-entry', motion: 'swing', hinge: sol.hinge, swing: sol.swing, swingIntoRoomId: entryRoom.id,
        toRoomId: entryRoom.id, fireRated: true, unitId: req.unitId, ref: 'entry',
      };
      doors.push(entryDoor);
      entryRoom.def.doorIds.push(entryDoorId);
      tracker.add(accessWall.id, along, w, 0);
      reserveSwing(entryDoor, accessWall, entryRoom);
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
      // a rolling shutter has no leaf on the floor: motion 'rolling' ⇒ swing 'none', no arc, no keep-out
      const sol = solveSwing({
        wall: accessWall, along, width: w, motion: 'rolling', into: reachRect(garageRoom.world, accessWall),
      });
      doors.push({
        id, storey: req.storey, wallId: accessWall.id, along, width: w, height: 2.1,
        type: 'garage', motion: 'rolling', hinge: sol.hinge, swing: sol.swing,
        toRoomId: garageRoom.id, unitId: req.unitId, ref: 'garage',
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
        // sliding: `swing` is the side the leaf parks on — inside the room, never over the balcony
        const sol = solveSwing({
          wall: bw2, along, width: w, motion: 'sliding', into: reachRect(host.world, bw2),
        });
        doors.push({
          id, storey: req.storey, wallId: bw2.id, along, width: w, height: SIZES.doorHeight,
          type: 'balcony', motion: 'sliding', hinge: sol.hinge, swing: sol.swing,
          fromRoomId: host.id, toRoomId: balconyRec.id, unitId: req.unitId, ref: 'balcony',
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
  const tree = provider.doors?.({ rooms, adjs, accessible, F, D }) ?? null;
  const rootIdx = tree ? tree.root : pickRoot(rooms);
  const parent = tree ? tree.parent : spanningTree(rooms, adjs, rootIdx);
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
    const reveal = doorReveal(wallLen) / 2;
    const width = Math.min(spec.width, Math.max(0.6, wallLen - doorReveal(wallLen)));
    const margin = Math.min(reveal, Math.max(0, (wallLen - width) / 2));
    // a cupboard front may be any width; a door to a room may not drop below a usable leaf
    if (width < 0.7 && spec.type === 'interior' && spec.leaf) {
      warnings.push(`${to.def.name}: door narrowed to ${width.toFixed(2)} m — below the 0.75 m minimum leaf`);
    }
    const along = tracker.reserve(wallId, 0, wallLen, width, prefer, margin);
    if (along === null) { warnings.push(`no clear position for the ${to.def.name} door on wall ${wallId} (${wallLen.toFixed(2)} m)`); continue; }
    const id = nid('DOOR');
    // The leaf sweeps into the room it serves, except out of a room too tight to keep it clear of the
    // fixtures (< 4.6 m² or min dim < 1.55 m) and out of every room in an accessible unit (ADA 2010 §603.2.3).
    const swingOut = spec.leaf && (accessible || isTight(to)) && !isTight(from);
    const into = spec.leaf ? (swingOut ? from : to) : to;
    const sol = solveSwing({
      wall, along, width, motion: spec.motion,
      into: reachRect(into.world, wall),
      avoid: fixtureRunCentre(into),
    });
    const d: DoorDef = {
      id, storey: req.storey, wallId, along, width: round(width, 3), height: SIZES.doorHeight,
      type: spec.type, motion: spec.motion, hinge: sol.hinge, swing: sol.swing,
      ...(spec.leaf ? { swingIntoRoomId: into.id } : {}),
      fromRoomId: from.id, toRoomId: to.id, unitId: req.unitId, ref: `${refOf(from)}~${refOf(to)}`,
    };
    doors.push(d);
    from.def.doorIds.push(id);
    to.def.doorIds.push(id);
    if (spec.leaf) reserveSwing(d, wall, into);
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

  // the leaf keep-outs the furniture pass respected, in world XY, so the editor and the per-unit
  // validator can check "no fixture inside a swing" without re-deriving anything
  const swingOut: { doorId: string; roomId: string; rect: Rect }[] = [];
  for (const d of doors) {
    if (!d.swingIntoRoomId) continue;
    const host = walls.find(w => w.id === d.wallId)
      ?? (['front', 'rear', 'left', 'right'] as Side[]).map(s => req.boundaryWalls[s]).find(w => w && w.id === d.wallId);
    if (!host) continue;
    const sw = swingRect(d, host);
    if (sw) swingOut.push({ doorId: d.id, roomId: d.swingIntoRoomId, rect: sw });
  }

  // ports: the outputs plumbing, mechanical and electrical consume instead of rediscovering the unit's geometry
  const ports = unitPorts({ req, frame, rooms, furniture, walls, wetWallIds, maxStacks: provider.maxStacks ?? 2 });

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
    swings: swingOut,
    stackPorts: ports.stackPorts,
    exhaustPorts: ports.exhaustPorts,
    panelPort: ports.panelPort,
    patterns,
    warnings,
  };
}

// ============================================================================
// Helpers used by layoutUnit
// ============================================================================

function typeTotal(cells: Cell[], type: RoomType): number {
  return cells.filter(c => c.type === type).length;
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

export interface TreeLink { idx: number; adj: Adj }

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

/** A room too small to keep a swing leaf clear of its fixtures: ARC-28 / ADA 2010 §603.2.3 */
function isTight(r: RoomRec): boolean {
  return r.local.w * r.local.h < 4.6 || Math.min(r.local.w, r.local.h) < 1.55;
}

function doorSpec(from: RoomRec, to: RoomRec, accessible: boolean, interiorW: number, bathW: number, span: number): { width: number; type: DoorDef['type']; motion: DoorMotion; leaf: boolean } {
  const ta = from.cell.type;
  const tb = to.cell.type;
  const cap = Math.max(0.6, span - doorReveal(span));
  if (tb === 'closet' || tb === 'walk-in-closet' || ta === 'closet' || ta === 'walk-in-closet') {
    return { width: Math.min(accessible ? 0.85 : 0.7, cap), type: 'closet', motion: 'sliding', leaf: false };
  }
  // a store, laundry or utility that is either tiny or reached through an edge too short for a walk-through leaf
  // is a CUPBOARD: it gets a bifold front (no arc, no keep-out) rather than an undersized swing door
  const store = (r: RoomRec): boolean => r.cell.type === 'laundry' || r.cell.type === 'utility' || r.cell.type === 'storage';
  const cupboard = (r: RoomRec): boolean => store(r) && (r.local.w * r.local.h < 3.2 || cap < LEAF_MIN.interior);
  if (cupboard(to) || cupboard(from)) {
    return { width: Math.min(accessible ? 0.85 : 0.75, cap), type: 'service', motion: 'folding', leaf: false };
  }
  if (BATH_TYPES.has(tb) || BATH_TYPES.has(ta)) {
    const wet = BATH_TYPES.has(tb) ? to : from;
    // a swing leaf cannot be kept clear of the fixtures in a shower room under 4.6 m² (ARC-28),
    // and ADA 2010 §603.2.3 forbids a door swinging into the clear floor space at any fixture,
    // so an accessible bathroom always gets a sliding leaf
    const tight = accessible || isTight(wet);
    return { width: Math.min(bathW, cap), type: 'interior', motion: tight ? 'sliding' : 'swing', leaf: !tight };
  }
  if (tb === 'garage' || ta === 'garage') {
    return { width: Math.min(0.85, cap), type: 'service', motion: 'swing', leaf: true };
  }
  if (OPEN_PLAN.has(ta) && OPEN_PLAN.has(tb)) {
    // cased opening: no leaf at all, so no arc and no keep-out
    return { width: clamp(cap, 0.9, accessible ? 1.5 : 1.4), type: 'interior', motion: 'opening', leaf: false };
  }
  return { width: Math.min(interiorW, cap), type: 'interior', motion: 'swing', leaf: true };
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
  /** rule set for the kit clearances, when one is resolved (principle 5) */
  rules?: KitRules;
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
      furnishBathroom(room, ctx, place, inner, wetEdge ?? 'v+');
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

/**
 * Counter run along the wet wall (ARC-20 / NKBA): the kit library lays fridge · counter · range · counter · sink ·
 * dishwasher, sweeping the run along the wall in 100 mm steps and turning the fridge onto the return leg when a
 * straight run will not do — the same routine the bathroom uses, which is what stops a kitchen from keeping its
 * fridge and silently losing the sink and the range to a door swing.
 */
function furnishKitchenRun(room: RoomRec, ctx: FurnishCtx, place: PlaceFn, inner: Rect, wetEdge: LDir, big: boolean): number {
  const fit = fitKit({
    room: room.local,
    kit: kitchenKitFor(room, ctx, big),
    swings: ctx.swings,
    wetEdge,
    setback: SIZES.wetWallT / 2,
    opts: {
      accessible: ctx.accessible, occupants: ctx.occupants, detail: ctx.detail, big,
      area: room.local.w * room.local.h, rules: ctx.rules,
    },
  });
  const placed = placeKit(fit.items, place);
  if (fit.missing.length > 0) {
    ctx.warnings.push(`${room.def.name}: counter run only ${sideLength(insetLocal(room.local, CLEARANCE.wall), sideOfLocalDir(wetEdge)).toFixed(2)} m — no space for the ${fit.missing.join(', ')} on the wet wall`);
  }
  const triangle = triangleOf(placed);
  if (triangle > 0 && (triangle < TRIANGLE_MIN - 1.0 || triangle > TRIANGLE_MAX + 0.2)) {
    ctx.warnings.push(`${room.def.name}: work triangle ${triangle.toFixed(2)} m is outside the 4–8 m guideline (ARC-20)`);
  }
  return triangle;
}

/** Which kitchen kit a room gets: accessible first, then the shared and open-plan variants (design §3.6). */
function kitchenKitFor(room: RoomRec, ctx: FurnishCtx, big: boolean): KitId {
  if (ctx.accessible) return 'kitchen-accessible';
  if (room.cell.type === 'shared-kitchen') return 'shared-kitchen';
  if (room.cell.type === 'living-kitchen') return 'living-kitchen';
  const inner = insetLocal(room.local, CLEARANCE.wall);
  const across = Math.min(inner.w, inner.h);
  return big && across >= KIT['kitchen-island'].min.d ? 'kitchen-island' : 'kitchen-galley';
}

/** local direction → the local side it names (kits.ts owns the mapping) */
function sideOfLocalDir(d: LDir): Side {
  return d === 'v+' ? 'rear' : d === 'v-' ? 'front' : d === 'u+' ? 'right' : 'left';
}

/** Commit a kit fit through the room's `place` callback (which mints ids and maps to world coordinates). */
function placeKit(items: readonly Placement[], place: PlaceFn): Placement[] {
  const out: Placement[] = [];
  for (const it of items) {
    if (place(it.type, it.aabb, it.face, { w: it.w, d: it.d })) out.push(it);
  }
  return out;
}

/**
 * Bathroom fixtures: the kit library runs wc · basin · (tub | shower) along the wet wall (XD-01 / ARC-14, one stack),
 * sweeping the run in 100 mm steps past the door swing and turning the tub or shower onto a lateral wall when the
 * single run will not fit. `fitKit` guarantees a wc and a basin, so plumbing never has to synthesise one.
 */
function furnishBathroom(room: RoomRec, ctx: FurnishCtx, place: PlaceFn, inner: Rect, wetEdge: LDir): void {
  const wetSide = sideOfLocalDir(wetEdge);
  const kit = bathKitFor(room, ctx);
  const fit = fitKit({
    room: room.local,
    kit,
    swings: ctx.swings,
    wetEdge,
    setback: SIZES.wetWallT / 2,
    opts: {
      accessible: ctx.accessible, occupants: ctx.occupants, detail: ctx.detail,
      area: room.local.w * room.local.h, ensuite: room.cell.type === 'ensuite', rules: ctx.rules,
    },
  });
  placeKit(fit.items, place);
  if (fit.oppositeWetWall) {
    ctx.warnings.push(`${room.def.name}: fixtures run on the wall opposite the wet wall because the door swing covers it — branch length ${Math.min(room.local.w, room.local.h).toFixed(2)} m (XD-01 allows 3 m)`);
  }
  for (const m of fit.missing) {
    ctx.warnings.push(`${room.def.name}: no clear position for the ${m} in a ${room.local.w.toFixed(2)} × ${room.local.h.toFixed(2)} m room`);
  }
  furnishGrabRails(room, ctx, place, insetLocal(room.local, CLEARANCE.wall), wetSide);
  void inner;
}

/** wc/powder → two-piece, accessible → ADA, otherwise a three-piece with a tub where the area allows (§3.6) */
function bathKitFor(room: RoomRec, ctx: FurnishCtx): KitId {
  const t = room.cell.type;
  if (ctx.accessible) return 'bath-accessible';
  if (t === 'powder' || t === 'wc') return 'wc-2pc';
  const area = room.local.w * room.local.h;
  return area >= 5.4 && t !== 'ensuite' ? 'bath-3pc-tub' : 'bath-3pc-shower';
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
    swingDoors: c.doors.filter(d => d.motion === 'swing' || d.motion === 'double-swing').length,
    casedOpenings: c.doors.filter(d => d.motion === 'opening').length,
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
