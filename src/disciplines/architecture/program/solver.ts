/**
 * The v2 unit solver: a program graph + a feasibility witness → a laid-out dwelling.
 *
 *   layoutUnitCanonical(args)  pure, memoised: the plan in the unit-local (u, v) frame
 *   placeCanonical(canon, req) world mapping + id minting (walls, doors, windows, furniture, patterns)
 *   layoutUnitV2(req)          the `UnitLayoutFn` the organiser/placer calls
 *
 * The canonical plan is a pure function of
 *   `moduleId | frontage | depth | level | exteriorLocal | exposureLocal | wwr | region | detail |
 *    balcony | editsHash`
 * so identical modules on different storeys produce IDENTICAL local plans — which is what makes wet
 * walls, stacks and shafts line up vertically instead of being nudged there by a requested coordinate.
 * `placeCanonical` is a translate plus an id mint on top of it.
 *
 * The solver cannot fail: it is given a witness that the program fits. When the placer has not
 * supplied one (the v1 organiser hands out rects that ignore the template's own ranges), the solver
 * derives the best shape for the rect it was given and records every compromise as a `Deviation` —
 * only a genuine contradiction (a room more than 0.30 m below its furniture kit, a daylit room with no
 * façade to stand on) is still a `warning`.
 */
import type {
  Compass, Rect, Region, RoomProgram, RoomType, Side, UnitTemplateId, Vec2, WallDef,
} from '../../../core/types.ts';
import type { Deviation, ResolutionId } from '../../../core/rules/types.ts';
import type {
  ExhaustPort, Feasibility, FeasibilityOpts, NodeRef, PanelPort, PlanShape, ProgramGraph, ProgramNode,
  ResolvedProgramGraph, StackPort,
} from './types.ts';
import type { UnitLayout, UnitLayoutFn, UnitLayoutRequest } from '../unit-layout-types.ts';
import type { Cell, Frame, LDir, PlanProvider, PlanResult, StairPlan } from '../unit-layout.ts';
import { layoutUnitWithPlan, makeFrame } from '../unit-layout.ts';
import { round, solarScore } from '../../../core/geometry.ts';
import { SIZES } from '../../../core/coordination.ts';
import { canonicalJson, fnv1a } from '../../../core/overrides.ts';
import { nodesAtLevel, programFor } from './programs.ts';
import {
  fill, fitFor, layoutShape, planShapesFor, pruneShape, STUDIO_REFS, type PlacedNode,
  type ShapeLayout, type SizeItem, type StairPin,
} from './feasibility.ts';
import { planUnitDoors } from './doors-in-unit.ts';
import { TRAP_ARM_MAX } from './ports.ts';
import type { UnitDoorPlan } from './doors-in-unit.ts';
import { kitMinDims } from './kits-api.ts';

const E = 1e-6;
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const r2 = (v: number): number => Math.round(v * 100) / 100;

/** A room this much below its kit minimum has genuinely stopped working — the only surviving warning. */
const CRITICAL_SHORTFALL = 0.3;
const STAIR_TREAD = 0.26;
const BATH_TYPES = new Set<RoomType>(['bathroom', 'ensuite', 'powder', 'wc']);
const CIRCULATION_TYPES = new Set<RoomType>(['hall', 'entry', 'corridor', 'stair']);

/**
 * Furnishing-pass notes that describe a resolution rather than a failure: the room still holds its
 * complete kit (`validateUnitLayout`'s `kit-complete` check is what catches an actually missing item),
 * it just holds it in the second arrangement the kit offers.
 */
const FURNISH_NOTES: { re: RegExp; ruleId: string; resolution: ResolutionId }[] = [
  { re: /fixtures run on the wall opposite the wet wall/, ruleId: 'XD-01.fixtureWall', resolution: 'reroute-in-wall' },
  { re: /washer and dryer must stack/, ruleId: 'ARC-15.laundryStack', resolution: 'compress-band' },
  { re: /no wall free for a wardrobe/, ruleId: 'ARC-27.wardrobeRun', resolution: 'merge-room' },
  { re: /no clear position for the/, ruleId: 'ARC-15.kitPlacement', resolution: 'clamp' },
  { re: /does not fit \(/, ruleId: 'ARC-15.kitPlacement', resolution: 'clamp' },
  { re: /door narrowed to/, ruleId: 'ARC-28.leafWidth', resolution: 'clamp' },
  { re: /kitchen fixtures reduced|counter run only/, ruleId: 'ARC-20.kitchenRun', resolution: 'compress-band' },
  { re: /work triangle/, ruleId: 'ARC-20.workTriangle', resolution: 'none' },
  { re: /balcony depth .* below the 1\.8 m usable minimum/, ruleId: 'ARC-17.balconyDepth', resolution: 'clamp' },
  { re: /wetWallSide .* differs from accessSide/, ruleId: 'ARC-14.wetWallSide', resolution: 'none' },
  // the stair footprint is the SOLVER's output now (identical on every level by construction), so the
  // organiser's requested rect is a hint, and differing from it is a record rather than a complaint
  { re: /requested stairRect is not compatible/, ruleId: 'ARC-22.stairRect', resolution: 'clamp' },
];

// ---------------------------------------------------------------------------------------------------
// solveStrip — one band into columns and stacks
// ---------------------------------------------------------------------------------------------------

export interface StripSolution {
  /** column widths along the band's slicing axis */
  widths: number[];
  /** per column, the depths of the stacked rooms */
  depths: number[][];
  squeezed: { ref: NodeRef; by: number }[];
}

/**
 * Lay one band out: columns across `total`, then each column's stack across `depth`. Exposed so the
 * placer and the tests can exercise the band arithmetic on its own.
 */
export function solveStrip(
  columns: readonly NodeRef[][],
  by: Map<NodeRef, ProgramNode>,
  total: number,
  depth: number,
): StripSolution {
  const colItems: SizeItem[] = columns.map(col => {
    const ns = col.map(r => by.get(r)).filter((x): x is ProgramNode => x !== undefined);
    const minW = Math.max(...ns.map(x => x.minWidth), 0);
    const governing = ns.filter(x => x.minWidth >= minW - E);
    const min = Math.max(minW, sum(ns.map(x => x.area.min)) / Math.max(depth, 0.5));
    const max = Math.max(min, Math.min(Math.min(...governing.map(x => x.maxWidth)), sum(ns.map(x => x.area.max)) / Math.max(depth, 0.5)));
    return { min, target: clamp(sum(ns.map(x => x.area.target)) / Math.max(depth, 0.5), min, max), max };
  });
  const w = fill(total, colItems);
  const squeezed: { ref: NodeRef; by: number }[] = w.squeezed.map(s => ({ ref: columns[s.index][0], by: s.by }));
  const depths: number[][] = [];
  columns.forEach((col, ci) => {
    const items: SizeItem[] = col.map(r => {
      const x = by.get(r);
      if (!x) return { min: 0, target: 0, max: 0 };
      return { min: x.minDepth, target: clamp(x.area.target / Math.max(w.sizes[ci], 0.5), x.minDepth, x.maxDepth), max: x.maxDepth };
    });
    const d = fill(depth, items);
    for (const s of d.squeezed) squeezed.push({ ref: col[s.index], by: s.by });
    depths.push(d.sizes);
  });
  return { widths: w.sizes, depths, squeezed };
}

// ---------------------------------------------------------------------------------------------------
// Canonical plan
// ---------------------------------------------------------------------------------------------------

export interface CanonArgs {
  program: ProgramGraph;
  moduleId: string;
  F: number;
  D: number;
  level: number;
  levelsTotal: number;
  region: Region;
  accessible: boolean;
  detail: 'low' | 'medium' | 'high';
  wwr: number;
  balcony: boolean;
  editsHash: string;
  /** local exterior sides, in local terms (front = access side, rear = opposite, left = u 0) */
  extFront: boolean;
  extRear: boolean;
  extLow: boolean;
  extHigh: boolean;
  /** solar quality 0..1 of the local low-u / high-u / far faces */
  solarLow: number;
  solarHigh: number;
  solarFar: number;
  floorToFloor: number;
  /** mirror the frozen shape (u → F − u); derived from solar exposure when the placer says nothing */
  mirrored?: boolean;
  /** stair footprint the organiser wants, already in local coordinates */
  stairLocal?: Rect;
  fit?: Feasibility;
}

export interface CanonicalLayout {
  key: string;
  programId: string;
  shape: PlanShape;
  fit: Feasibility;
  F: number;
  D: number;
  level: number;
  mirrored: boolean;
  flipped: boolean;
  cells: Cell[];
  frontDepth: number;
  hallDepth: number;
  kind: 'standard' | 'through' | 'cluster' | 'dual-key';
  wetSpan?: { lo: number; hi: number };
  stair?: StairPlan;
  deviations: Deviation[];
  warnings: string[];
}

const canonCache = new Map<string, CanonicalLayout>();

export function canonicalKey(a: CanonArgs): string {
  const ext = `${a.extFront ? 'F' : ''}${a.extRear ? 'R' : ''}${a.extLow ? 'L' : ''}${a.extHigh ? 'H' : ''}` || '-';
  const exp = `${Math.round(a.solarLow * 100)}.${Math.round(a.solarHigh * 100)}.${Math.round(a.solarFar * 100)}`;
  return [
    a.moduleId,
    Math.round(a.F * 1000),
    Math.round(a.D * 1000),
    a.level,
    ext,
    exp,
    Math.round(a.wwr * 100),
    a.region,
    a.detail,
    a.balcony ? 'b' : '-',
    a.accessible ? 'a' : '-',
    a.mirrored === undefined ? 'auto' : a.mirrored ? 'm' : 'n',
    a.stairLocal ? `s${Math.round(a.stairLocal.x * 100)}.${Math.round(a.stairLocal.y * 100)}.${Math.round(a.stairLocal.w * 100)}.${Math.round(a.stairLocal.h * 100)}` : '-',
    a.editsHash || '0',
  ].join('|');
}

const dev = (ruleId: string, message: string, o: Partial<Deviation> = {}): Deviation => ({
  severity: 'deviation',
  ruleId,
  discipline: 'architecture',
  message,
  ...o,
});

/** Which plan type the rect and its exposures call for (the v1 `useThroughPlan` decision, made once). */
function chooseType(a: CanonArgs, nodes: ProgramNode[]): PlanShape['type'] {
  if (a.program.templateId === 'coliving-cluster') return 'cluster';
  if (nodes.some(x => x.type === 'stair' || x.type === 'garage')) return 'house';
  const flipV = !a.extRear && a.extFront;
  const through = !a.extFront && !flipV && (a.extLow || a.extHigh) && a.D >= 3.6 && a.F >= 5.4
    && (!a.extRear || a.D < 5.4 || a.D > a.F + 1);
  if (through) return 'through';
  if (a.program.templateId === 'dual-key') return 'dual-key';
  return 'zoned';
}

interface ShapePick {
  shape: PlanShape;
  layout: ShapeLayout;
  strict: boolean;
  /** nodes provided as furniture in another room instead of as a room (a recorded alternative) */
  merged: ProgramNode[];
  nodes: Map<NodeRef, ProgramNode>;
}

/**
 * The shape for this rect, in the design's fallback order: every variant of the preferred plan type,
 * then the same variants with the declared `mergeInto` alternatives applied smallest-first, then the
 * other plan types. The first combination that is strictly feasible wins; if none is, the one that
 * compromises least is used and the compromise is recorded.
 */
function pickShape(a: CanonArgs, by0: Map<NodeRef, ProgramNode>, pinSpine?: number, pinStair?: StairPin): ShapePick {
  const o: FeasibilityOpts = {
    region: a.region, accessible: a.accessible, levels: a.level, detail: a.detail,
  };
  const want = chooseType(a, [...by0.values()]);
  const all = planShapesFor(a.program, o);
  const preferred = all.filter(s => s.type === want || (want === 'zoned' && s.type === 'dual-key') || (want === 'dual-key' && s.type === 'zoned'));
  const order = preferred.length > 0 ? [...preferred, ...all.filter(s => !preferred.includes(s))] : all;
  const mergeable = [...by0.values()]
    .filter(x => x.mergeInto !== undefined)
    .sort((x, y) => x.area.target - y.area.target || (x.ref < y.ref ? -1 : 1));
  const costOf = (p: ShapePick): number =>
    sum(p.layout.squeezed.map(s => s.by)) + 0.01 * p.layout.overflowed.length
    + (p.shape.type === want ? 0 : 5) + 0.05 * p.merged.length;
  let best: ShapePick | null = null;
  for (let m = 0; m <= mergeable.length; m++) {
    const merged = mergeable.slice(0, m);
    const dropped = merged.map(x => x.ref);
    const by = new Map([...by0].filter(([r]) => !dropped.includes(r)));
    for (const shape0 of order) {
      const shape = m === 0 ? shape0 : pruneShape(shape0, dropped);
      if (shape.bands.length === 0) continue;
      const l = layoutShape(shape, by, a.F, a.D, true, pinSpine, pinStair);
      if (l.ok && a.F >= l.frontage.min - 0.005 && a.F <= l.frontage.max + 0.005) {
        return { shape, layout: layoutShape(shape, by, a.F, a.D, false, pinSpine, pinStair), strict: true, merged, nodes: by };
      }
      const cand: ShapePick = {
        shape, layout: layoutShape(shape, by, a.F, a.D, false, pinSpine, pinStair), strict: false, merged, nodes: by,
      };
      if (!best || costOf(cand) < costOf(best)) best = cand;
    }
  }
  if (best) return best;
  const shape = all[0];
  return { shape, layout: layoutShape(shape, by0, a.F, a.D, false, pinSpine, pinStair), strict: false, merged: [], nodes: by0 };
}

/**
 * The spine every level of a multi-storey unit shares: the widest spine any level needs (so the
 * bathroom upstairs is not squeezed to the width of the hall downstairs) and the stair's own slot
 * inside it, taken from level 0. Both are pinned on every level, which is what makes ARC-22 — one
 * stair footprint, identical on every level — true by construction rather than by luck.
 */
const spineCache = new Map<string, { width: number; prefix: number; depth: number } | null>();

function sharedSpine(a: CanonArgs): { width: number; prefix: number; depth: number } | null {
  if (a.program.levels <= 1) return null;
  const key = `${a.program.id}|${Math.round(a.F * 1000)}|${Math.round(a.D * 1000)}|${a.region}|${a.accessible ? 1 : 0}|${a.detail}`;
  if (spineCache.has(key)) return spineCache.get(key) ?? null;
  spineCache.set(key, null); // guard against re-entry while we are computing it
  let width = 0;
  const picks: ShapePick[] = [];
  for (let L = 0; L < a.program.levels; L++) {
    const by = new Map(nodesAtLevel(a.program, L).map(x => [x.ref, x]));
    const p = pickShape({ ...a, level: L, fit: undefined }, by);
    picks.push(p);
    width = Math.max(width, p.layout.spineWidth);
  }
  let out: { width: number; prefix: number; depth: number } | null = null;
  if (width > 0) {
    const by0 = new Map(nodesAtLevel(a.program, 0).map(x => [x.ref, x]));
    const p0 = pickShape({ ...a, level: 0, fit: undefined }, by0, width);
    const stair = p0.layout.cells.find(c => c.spine && c.node.type === 'stair');
    if (stair) out = { width, prefix: round(stair.rect.y, 4), depth: round(stair.rect.h, 4) };
    else out = { width, prefix: 0, depth: 0 };
  }
  spineCache.set(key, out);
  return out;
}

/** Choose the mirroring: the public end of the plan takes the better-lit façade. */
function mirrorFor(a: CanonArgs, type: PlanShape['type']): boolean {
  if (a.mirrored !== undefined) return a.mirrored;
  if (type === 'house' || type === 'cluster') return false;
  return a.solarHigh > a.solarLow + 0.01;
}

export function layoutUnitCanonical(a: CanonArgs): CanonicalLayout {
  const key = canonicalKey(a);
  const hit = canonCache.get(key);
  if (hit) return hit;
  const out = solveCanonical(a);
  canonCache.set(key, out);
  return out;
}

function solveCanonical(a: CanonArgs): CanonicalLayout {
  const deviations: Deviation[] = [];
  const warnings: string[] = [];
  const nodes = nodesAtLevel(a.program, a.level);
  const by0 = new Map(nodes.map(x => [x.ref, x]));
  const shared = sharedSpine(a);
  const want = a.stairLocal && a.stairLocal.w > 0.5 && a.stairLocal.h > 0.5
    ? { width: Math.min(a.stairLocal.w, a.F - 1), prefix: a.stairLocal.y, depth: a.stairLocal.h }
    : shared;
  const picked = pickShape(a, by0, want?.width, want && want.depth > 0.5 ? { prefix: want.prefix, depth: want.depth } : undefined);
  const by = picked.nodes;
  const shape = picked.shape;
  const layout = picked.layout;
  const type = shape.type;
  const cellsIn = layout.cells;

  // --- record what had to give -------------------------------------------------------------------
  for (const s of layout.squeezed) {
    const node = by.get(s.ref);
    const kit = node ? kitMinDims(node.kit) : { w: 0, d: 0 };
    const limit = s.axis === 'w' ? kit.w : kit.d;
    const msg = `${s.ref} is ${s.by.toFixed(2)} m below its ${s.axis === 'w' ? 'minimum clear width' : 'minimum clear depth'} `
      + `in a ${r2(a.F)} × ${r2(a.D)} m rect (${a.program.templateId} wants at least ${limit.toFixed(2)} m for the ${node?.kit ?? 'kit'})`;
    if (s.by > CRITICAL_SHORTFALL && limit > 0) warnings.push(msg);
    else deviations.push(dev('ARC-15.minRoomDim', msg, { observed: r2(limit - s.by), limit: r2(limit), resolution: { id: 'compress-band', from: r2(limit), to: r2(limit - s.by) } }));
  }
  for (const ref of layout.overflowed) {
    deviations.push(dev('ARC-15.maxRoomDim', `${ref} grew past its declared maximum to tile a ${r2(a.F)} × ${r2(a.D)} m rect`, {
      resolution: { id: 'clamp', note: 'generous room rather than a remnant' },
    }));
  }
  if (!picked.strict) {
    deviations.push(dev('ARC-D08.outsideAdmissible',
      `${a.program.templateId} laid out at ${r2(a.F)} × ${r2(a.D)} m, outside the ${layout.frontage.min.toFixed(2)}–${layout.frontage.max.toFixed(2)} m frontage its program admits at that depth`,
      { observed: r2(a.F), limit: `${layout.frontage.min.toFixed(2)}–${layout.frontage.max.toFixed(2)}`, resolution: { id: 'swap-module' } }));
  }

  // --- mirror / flip ------------------------------------------------------------------------------
  // ARC-22: the stair keeps one footprint on every level. When no variant could honour it, say so.
  if (shared && shared.depth > 0.5) {
    const st = cellsIn.find(c => c.spine && c.node.type === 'stair');
    if (st && (Math.abs(st.rect.y - shared.prefix) > 0.01 || Math.abs(st.rect.h - shared.depth) > 0.01)) {
      deviations.push(dev('ARC-22.stairStack',
        `the stair on level ${a.level} sits at v ${st.rect.y.toFixed(2)}–${(st.rect.y + st.rect.h).toFixed(2)} m against `
        + `${shared.prefix.toFixed(2)}–${(shared.prefix + shared.depth).toFixed(2)} m on the entry level`,
        { resolution: { id: 'clamp' } }));
    }
  }

  const mirrored = mirrorFor(a, type);
  // A garage door is cut into the ACCESS wall, so a plan holding a garage may never be flipped: the
  // garage has to stay on the street side whatever the daylight says.
  const hasGarage = cellsIn.some(c => c.node.type === 'garage');
  const flipped = !a.extRear && a.extFront && type !== 'house' && type !== 'cluster' && !hasGarage;
  let placed = cellsIn;
  if (mirrored) placed = placed.map(c => ({ ...c, rect: { ...c.rect, x: a.F - c.rect.x - c.rect.w } }));
  if (flipped) {
    placed = placed.map(c => ({ ...c, rect: { ...c.rect, y: a.D - c.rect.y - c.rect.h } }));
    deviations.push(dev('ARC-14.singleAspect',
      'single-aspect unit toward the access side: the daylit band is on the access wall and the service band at the back',
      { resolution: { id: 'none' } }));
  }

  // --- daylight ------------------------------------------------------------------------------------
  const touches = (r: Rect, s: Side): boolean => {
    switch (s) {
      case 'front': return Math.abs(r.y) < 1e-3;
      case 'rear': return Math.abs(r.y + r.h - a.D) < 1e-3;
      case 'left': return Math.abs(r.x) < 1e-3;
      default: return Math.abs(r.x + r.w - a.F) < 1e-3;
    }
  };
  const litSides: Side[] = [];
  if (a.extFront) litSides.push('front');
  if (a.extRear) litSides.push('rear');
  if (a.extLow) litSides.push('left');
  if (a.extHigh) litSides.push('right');
  const dark = placed.filter(c => c.node.needsExterior && !litSides.some(s => touches(c.rect, s)));
  if (dark.length > 0) {
    const facade = (a.extLow ? a.D : 0) + (a.extHigh ? a.D : 0) + (a.extFront ? a.F : 0) + (a.extRear ? a.F : 0);
    const demand = sum(placed.filter(c => c.node.needsExterior).map(c => c.node.minWidth));
    const names = dark.map(c => c.node.type).join(', ');
    warnings.push(`${names} placed away from the façade: a ${type} unit ${r2(a.F)} m wide offers ${r2(facade)} m of end façade for ${r2(demand)} m of habitable rooms`);
  }

  // --- cells ---------------------------------------------------------------------------------------
  const typeTotals = new Map<RoomType, number>();
  for (const x of a.program.nodes) typeTotals.set(x.type, (typeTotals.get(x.type) ?? 0) + 1);
  // Boundaries, not sizes, carry the precision: two cells that share an edge must round to the SAME
  // coordinate or the rooms overlap by the rounding error.
  const q = (v: number): number => round(v, 6);
  const cells: Cell[] = placed.map(c => ({
    type: c.node.type,
    ref: c.ref,
    rect: { x: q(c.rect.x), y: q(c.rect.y), w: q(c.rect.x + c.rect.w) - q(c.rect.x), h: q(c.rect.y + c.rect.h) - q(c.rect.y) },
    prog: progOf(c.node, typeTotals.get(c.node.type) ?? 1),
    n: numberOf(c.ref),
    ...(dark.includes(c) ? { daylightWaived: true } : {}),
    ...(STUDIO_REFS.includes(c.ref) ? { sub: 'studio' } : a.program.templateId === 'dual-key' ? { sub: 'main' } : {}),
    ...(c.node.type === 'ensuite' || c.node.type === 'walk-in-closet' ? { prefParent: 'master-bedroom' as RoomType } : {}),
  }));
  markWetEdges(cells, a, litSides);

  // --- band / hall / wet metrics the pattern trace reports ----------------------------------------
  const bandDepths = layout.bandDepths;
  const frontDepth = flipped ? (bandDepths[bandDepths.length - 1] ?? 0) : (bandDepths[0] ?? 0);
  const hallCell = cells.find(c => c.type === 'hall') ?? cells.find(c => c.type === 'corridor');
  const hallDepth = hallCell ? Math.min(hallCell.rect.w, hallCell.rect.h) : 0;
  const wet = cells.filter(c => c.prog?.wet === true);
  const wetSpan = wet.length > 0
    ? { lo: r2(Math.min(...wet.map(c => c.rect.x))), hi: r2(Math.max(...wet.map(c => c.rect.x + c.rect.w))) }
    : undefined;

  // --- stair ---------------------------------------------------------------------------------------
  let stair: StairPlan | undefined;
  const stairCell = cells.find(c => c.type === 'stair');
  if (stairCell) {
    const risers = Math.max(12, Math.ceil(a.floorToFloor / SIZES.stairRiserMax));
    stair = {
      rect: stairCell.rect,
      risers,
      riserHeight: a.floorToFloor / risers,
      tread: STAIR_TREAD,
      width: Math.max(0.9, Math.min(stairCell.rect.w, stairCell.rect.h) - 0.05),
    };
  }

  const fit: Feasibility = a.fit ?? {
    ok: true,
    programId: a.program.id,
    shape,
    frontage: layout.frontage,
    depth: r2(a.D),
    bandDepths: bandDepths.map(r2),
    widths: layout.widths,
    merged: [],
    stacked: [],
    rooms: cells.map(c => ({
      ref: c.ref ?? c.type,
      type: c.type,
      zone: c.prog?.zone ?? 'service',
      rect: c.rect,
    })),
  };

  for (const m of picked.merged) {
    deviations.push(dev('ARC-27.mergeRoom',
      `${m.ref} is provided as ${m.mergeInto?.kit} inside ${m.mergeInto?.ref} instead of a separate room`,
      { resolution: { id: 'merge-room', from: m.ref, to: m.mergeInto?.ref } }));
  }

  return {
    key: canonicalKey(a),
    programId: a.program.id,
    shape,
    fit,
    F: a.F,
    D: a.D,
    level: a.level,
    mirrored,
    flipped,
    cells,
    frontDepth: r2(frontDepth),
    hallDepth: r2(hallDepth),
    kind: type === 'through' ? 'through' : type === 'cluster' ? 'cluster' : type === 'dual-key' ? 'dual-key' : 'standard',
    ...(wetSpan ? { wetSpan } : {}),
    ...(stair ? { stair } : {}),
    deviations,
    warnings,
  };
}

/** A synthetic `RoomProgram` so the shared realisation reads the program node, not the v1 template. */
function progOf(node: ProgramNode, count: number): RoomProgram {
  return {
    type: node.type,
    count,
    targetArea: node.area.target,
    minArea: node.area.min,
    minWidth: node.minWidth,
    needsExterior: node.needsExterior,
    wet: node.wet,
    zone: node.zone,
    prefer: node.band === 'daylit' ? 'back' : node.band === 'circulation' ? 'either' : 'front',
  };
}

function numberOf(ref: NodeRef): number {
  const m = /(\d+)$/.exec(ref);
  return m ? Number(m[1]) : 1;
}

/**
 * Point every wet room's fixture run at the wall it shares with another wet room (one wet wall, one
 * stack — XD-01), never at an exterior wall, and prefer a wall perpendicular to the frontage so the
 * runs of stacked units line up.
 */
function markWetEdges(cells: Cell[], a: CanonArgs, litSides: Side[]): void {
  const lit = new Set(litSides);
  const wetSet = new Set(cells.filter(c => c.prog?.wet === true).map(c => c.ref ?? c.type));
  for (const c of cells) {
    if (c.prog?.wet !== true) continue;
    const r = c.rect;
    const options: { dir: LDir; score: number }[] = [];
    const edges: { dir: LDir; side: Side; at: number; axis: 'u' | 'v'; s0: number; s1: number }[] = [
      { dir: 'v-', side: 'front', at: r.y, axis: 'u', s0: r.x, s1: r.x + r.w },
      { dir: 'v+', side: 'rear', at: r.y + r.h, axis: 'u', s0: r.x, s1: r.x + r.w },
      { dir: 'u-', side: 'left', at: r.x, axis: 'v', s0: r.y, s1: r.y + r.h },
      { dir: 'u+', side: 'right', at: r.x + r.w, axis: 'v', s0: r.y, s1: r.y + r.h },
    ];
    for (const e of edges) {
      const onBoundary = e.axis === 'u'
        ? Math.abs(e.at) < 1e-3 || Math.abs(e.at - a.D) < 1e-3
        : Math.abs(e.at) < 1e-3 || Math.abs(e.at - a.F) < 1e-3;
      const exterior = onBoundary && lit.has(e.side);
      let score = exterior ? -10 : 0;
      // a wet neighbour across this edge is the wet wall
      for (const o of cells) {
        if (o === c) continue;
        const or = o.rect;
        const share = e.axis === 'u'
          ? (Math.abs(or.y - e.at) < 1e-3 || Math.abs(or.y + or.h - e.at) < 1e-3)
            ? Math.min(r.x + r.w, or.x + or.w) - Math.max(r.x, or.x) : 0
          : (Math.abs(or.x - e.at) < 1e-3 || Math.abs(or.x + or.w - e.at) < 1e-3)
            ? Math.min(r.y + r.h, or.y + or.h) - Math.max(r.y, or.y) : 0;
        if (share <= 0.3) continue;
        // the door almost always comes off the circulation, and a leaf sweeping over the fixture run
        // is what forced the v1 engine onto the opposite wall — so never run fixtures on that wall
        if (CIRCULATION_TYPES.has(o.type)) score -= 3;
        else if (wetSet.has(o.ref ?? o.type)) score += 4 + share * 0.1;
        else score += 1 + share * 0.05;
      }
      // a run along u keeps identical modules' stacks on the same wall
      if (e.axis === 'u') score += 0.5;
      options.push({ dir: e.dir, score });
    }
    options.sort((x, y) => y.score - x.score || (x.dir < y.dir ? -1 : 1));
    c.wetEdge = options[0].dir;
  }
}

// ---------------------------------------------------------------------------------------------------
// placeCanonical — world mapping and id minting
// ---------------------------------------------------------------------------------------------------

export function placeCanonical(canon: CanonicalLayout, req: UnitLayoutRequest, program: ProgramGraph): UnitLayout {
  const box: { plan: UnitDoorPlan | null } = { plan: null };
  const provider: PlanProvider = {
    plan: ({ opts }) => {
      opts.warnings.push(...canon.warnings);
      const out: PlanResult = {
        cells: canon.cells.map(c => ({ ...c, rect: { ...c.rect } })),
        frontDepth: canon.frontDepth,
        hallDepth: canon.hallDepth,
        kind: canon.kind,
        ...(canon.wetSpan ? { wetSpan: canon.wetSpan } : {}),
        ...(canon.stair ? { stair: canon.stair } : {}),
      };
      return out;
    },
    maxStacks: program.maxStacks,
    doors: ({ rooms, adjs }) => {
      const plan = planUnitDoors({ rooms, adjs, program, region: req.region });
      box.plan = plan;
      return { root: plan.root, parent: plan.parent };
    },
  };
  const layout = layoutUnitWithPlan(req, provider);
  const deviations = [...canon.deviations];
  // "Resolve, then record": the furnishing pass reports the compromises it made as it made them. In v2
  // those are RESOLUTIONS (the fixtures are all placed, just not in the first arrangement tried), so
  // they belong in the deviation ledger, not in warnings — which are reserved for contradictions.
  const kept: string[] = [];
  for (const w of layout.warnings) {
    const note = FURNISH_NOTES.find(n => n.re.test(w));
    if (note) deviations.push(dev(note.ruleId, w, { resolution: { id: note.resolution } }));
    else kept.push(w);
  }
  layout.warnings = kept;
  const doorPlan = box.plan;
  if (doorPlan) {
    for (const u of doorPlan.unsatisfied) {
      deviations.push(dev('ARC-19.requiredDoor',
        `the program asks for a door between ${u.a} and ${u.b}: ${u.reason}`,
        { resolution: { id: 'none' } }));
    }
    for (const r of doorPlan.relaxed) {
      deviations.push(dev('ARC-19.relaxedDoor',
        `${r.a} is entered from ${r.b}, which the program discourages, because no other wall was long enough`,
        { resolution: { id: 'clamp' } }));
    }
  }
  layout.graph = resolveGraph(layout, program, req.region);
  layout.deviations = deviations;
  for (const p of layout.stackPorts ?? []) {
    if (p.maxArm > TRAP_ARM_MAX + 1e-6) {
      deviations.push(dev('PLB-02.trapArm',
        `stack ${p.id} carries a ${p.maxArm.toFixed(2)} m developed trap arm against the ${TRAP_ARM_MAX.toFixed(2)} m unvented limit`,
        { observed: p.maxArm, limit: TRAP_ARM_MAX, resolution: { id: 'vent-branch' } }));
    }
  }
  if ((layout.stackPorts ?? []).length > program.maxStacks) {
    deviations.push(dev('XD-01.stackCount',
      `${(layout.stackPorts ?? []).length} drainage stacks where the program allows ${program.maxStacks}`,
      { observed: (layout.stackPorts ?? []).length, limit: program.maxStacks, resolution: { id: 'none' } }));
  }
  return layout;
}


// ---------------------------------------------------------------------------------------------------
// Outputs the rest of the model consumes
// ---------------------------------------------------------------------------------------------------

function resolveGraph(layout: UnitLayout, program: ProgramGraph, region: Region): ResolvedProgramGraph {
  const refOf = new Map<string, NodeRef>();
  for (const r of layout.rooms) refOf.set(r.id, r.ref ?? r.type);
  const nodes = layout.rooms.map(r => ({ ref: r.ref ?? r.type, roomId: r.id, type: r.type }));
  const edges: ResolvedProgramGraph['edges'] = [];
  for (const d of layout.doors) {
    const a = d.fromRoomId ? refOf.get(d.fromRoomId) : undefined;
    const b = d.toRoomId ? refOf.get(d.toRoomId) : undefined;
    if (!a || !b) continue;
    edges.push({ a, b, kind: d.motion === 'opening' ? 'opening' : 'door', doorId: d.id });
  }
  const seen = new Set(edges.map(e => (e.a < e.b ? `${e.a}|${e.b}` : `${e.b}|${e.a}`)));
  for (const rule of program.rules) {
    if (rule.kind !== 'share-edge') continue;
    if (rule.regions && !rule.regions.includes(region)) continue;
    const k = String(rule.a) < String(rule.b) ? `${rule.a}|${rule.b}` : `${rule.b}|${rule.a}`;
    if (seen.has(k)) continue;
    const a = nodes.find(x => x.ref === rule.a);
    const b = nodes.find(x => x.ref === rule.b);
    if (!a || !b) continue;
    seen.add(k);
    edges.push({ a: a.ref, b: b.ref, kind: 'share-edge' });
  }
  return { nodes, edges };
}


// ---------------------------------------------------------------------------------------------------
// layoutUnitV2
// ---------------------------------------------------------------------------------------------------

/**
 * The v2 `UnitLayoutFn`. Honours `req.fit` / `req.program` / `req.mirrored` / `req.edits` when the
 * placer supplies them, and otherwise derives the program and a best-fit shape from `req.template` and
 * the rect, so it is a drop-in replacement for the v1 engine under the v1 organiser.
 */
export const layoutUnitV2: UnitLayoutFn = (req: UnitLayoutRequest): UnitLayout => {
  const program = req.program ?? programFor(req.template.id as UnitTemplateId);
  const frame = makeFrame(req.rect, req.accessSide);
  const exteriorSides = new Set<Side>(req.exteriorSides);
  const localExt = (s: Side): boolean => exteriorSides.has(frame.side(s));
  const southern = req.region === 'AU' || req.region === 'NZ';
  const solarOf = (ls: Side): number => {
    const c = req.exposures[frame.side(ls)] as Compass | undefined;
    return c ? solarScore(c, southern) : 0;
  };
  const level = Math.max(0, Math.min(program.levels - 1, req.level));
  const args: CanonArgs = {
    program,
    moduleId: req.moduleId ?? `U-${req.template.id}`,
    F: round(frame.F, 4),
    D: round(frame.D, 4),
    level,
    levelsTotal: req.levelsTotal,
    region: req.region,
    accessible: req.template.id === 'senior-1b-accessible',
    detail: req.options.detail,
    wwr: req.wwr,
    balcony: req.balcony !== null,
    editsHash: req.edits && req.edits.length > 0 ? fnv1a(canonicalJson(req.edits)) : '0',
    extFront: localExt('front'),
    extRear: localExt('rear'),
    extLow: localExt('left'),
    extHigh: localExt('right'),
    solarLow: solarOf('left'),
    solarHigh: solarOf('right'),
    solarFar: solarOf('rear'),
    floorToFloor: req.floorToFloor,
    ...(req.mirrored === undefined ? {} : { mirrored: req.mirrored }),
    ...(req.stairRect ? { stairLocal: frame.toLocalRect(req.stairRect) } : {}),
    ...(req.fit && req.fit.shape.level === level ? { fit: req.fit } : {}),
  };
  const canon = layoutUnitCanonical(args);
  return placeCanonical(canon, req, program);
};

/** The witness the placer would use for this template at (F, D) — the admissible-range gate. */
export function witnessFor(templateId: UnitTemplateId, F: number, D: number, o: FeasibilityOpts): Feasibility | null {
  const r = fitFor(programFor(templateId), F, D, o);
  return r.ok ? r : null;
}

/** Test/perf helper. */
export function clearSolverCache(): void {
  canonCache.clear();
  spineCache.clear();
}
