/**
 * Corridor consumption (design §4.7). Site OWNS the corridor topology — `buildCorridorGraph` splits each spine into
 * legs ≤ ARC-03.maxLegLength with break slots, joins bars at knuckles (so an O-plan is ONE cyclic corridor) and flags
 * dead ends. The placer only CONSUMES it:
 *
 *   · break slots and knuckles become blocked intervals before any unit is packed (`strips.blockersFor`)
 *   · each break slot is instantiated as a `BreakModule` slot, which is what resets the leg counter — the v1
 *     "corridor C on S runs 71.7 m without a break" warning has nothing left to report
 *   · `CorridorDef.centerline` is the leg polyline rather than one segment per rect
 *   · travel distance is Dijkstra over the graph, replacing the Manhattan estimate in index.ts:409-429
 *
 * `corridorGraphFor` is the ONE place the graph is obtained: `massing.corridorGraph` when site has published it,
 * otherwise built here from the same site function so both paths agree exactly.
 */
import type { GenContext, Rect, Segment2, Side, Vec2 } from '../../../core/types.ts';
import type { Deviation } from '../../../core/rules/types.ts';
import type { BreakSlot, CorridorGraph, CorridorLeg } from '../../site/corridor-graph.ts';
import type { BreakModule, ModuleCatalogue } from '../../../modules/types.ts';
import type { CorridorSlot, SideWallSpec } from '../types-internal.ts';
import type { Slot, StripDef } from './types.ts';
import { buildCorridorGraph, legGraph } from '../../site/corridor-graph.ts';
import { IdFactory } from '../../../core/ids.ts';
import { dist, oppositeSide, polygonCentroid, round } from '../../../core/geometry.ts';
import { breakForWant } from '../../../modules/corridor-modules.ts';
import { alongRange, rectFromAC, type BarFrame, type Interval } from '../bar-frame.ts';
import { breakInterval, slotIdFor, spineOrigin } from './strips.ts';

const EPS = 1e-6;

/**
 * The graph for this generation. When site has published `massing.corridorGraph` we consume it verbatim; otherwise we
 * build it here from `buildCorridorGraph` with a private id factory and a throwaway issue sink, so the legs, break
 * slots and knuckles are byte-identical to the ones site will publish.
 */
export function corridorGraphFor(ctx: GenContext): CorridorGraph | null {
  const massing = ctx.site.massing;
  if (massing.corridorGraph) return massing.corridorGraph;
  if (massing.bars.length === 0) return null;
  const width = ctx.spec.massing.corridorWidth ?? ctx.typology.corridorWidth ?? 1.6;
  try {
    return buildCorridorGraph({
      bars: massing.bars,
      access: ctx.typology.access,
      width,
      footprintCentroid: polygonCentroid(massing.footprint),
      shape: massing.shape,
      sprinklered: ctx.typology.sprinklered,
      rules: ctx.rules,
      ids: new IdFactory('site'),
      warnings: [],
    });
  } catch {
    // the site agent's body is not in yet: no graph means no breaks and no knuckles, never a crash
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Break slots → BreakModule slots
// ---------------------------------------------------------------------------------------------------------------

export interface BreakArgs {
  frame: BarFrame;
  strip: StripDef;
  graph: CorridorGraph | null;
  catalogue: ModuleCatalogue;
  /** break slots already consumed by a core, which must not be instantiated twice */
  usedBy: ReadonlySet<string>;
  lowSpec: SideWallSpec;
  highSpec: SideWallSpec;
  partyWall: SideWallSpec;
  seq: { n: number };
}

export interface BreakResult { slots: Slot[]; deviations: Deviation[] }

/**
 * One `BreakModule` per break slot of this bar that a core did not already take. The slot's rect is the reserved
 * interval across the strip, so the corridor is physically interrupted — a lounge, a lift lobby, a daylit window bay
 * or a secondary exit stair, in the preference order the site's `want` implies.
 */
export function instantiateBreaks(a: BreakArgs): BreakResult {
  const slots: Slot[] = [];
  const deviations: Deviation[] = [];
  if (!a.graph) return { slots, deviations };
  const { frame, strip } = a;
  const origin = spineOrigin(frame, a.graph);
  for (const b of a.graph.breakSlots) {
    if (b.barId !== frame.barId || a.usedBy.has(b.id)) continue;
    const iv = breakInterval(frame, b, origin);
    if (iv.s < strip.along.s - 0.5 || iv.e > strip.along.e + 0.5) continue;
    const hasFacade = strip.exteriorSides.length > 0;
    const mod = breakForWant(a.catalogue.breaks, b.want, hasFacade);
    if (!mod) continue;
    slots.push(breakSlot(a, iv, mod, b));
    deviations.push({
      severity: 'info', ruleId: 'ARC-03.breakSlotLength', discipline: 'architecture',
      message: `break ${mod.name} placed ${round(b.station, 1)} m along ${b.barId}: ${b.reason}`,
      resolution: { id: 'split-corridor', to: mod.id },
    });
  }
  return { slots, deviations };
}

function breakSlot(a: BreakArgs, iv: Interval, mod: BreakModule, b: BreakSlot): Slot {
  const { frame, strip } = a;
  const sides = {} as Record<Side, SideWallSpec>;
  sides[frame.lowSide] = a.lowSpec;
  sides[frame.highSide] = a.highSpec;
  sides[frame.startSide] = a.partyWall;
  sides[frame.endSide] = a.partyWall;
  return {
    id: slotIdFor(strip.id, a.seq.n++),
    stripId: strip.id,
    kind: 'break',
    moduleId: mod.id,
    mirrored: false,
    boundary: rectFromAC(frame, iv.s, iv.e, strip.across.s, strip.across.e),
    accessSide: strip.accessSide,
    exteriorSides: [...strip.exteriorSides],
    sides,
    barId: strip.barId,
    legId: strip.legId,
    ports: [],
    partyLines: [{ at: round(iv.s, 4), column: true }, { at: round(iv.e, 4), column: true }],
    roomType: mod.role === 'exit-stair' ? 'stair' : mod.role === 'lift-lobby' ? 'lift-lobby' : mod.role === 'cross-corridor' ? 'corridor' : 'lounge',
    notes: b.reason,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Geometry for instantiation
// ---------------------------------------------------------------------------------------------------------------

/** Leg centrelines of one bar, as the polyline a `CorridorDef` carries */
export function legCentrelines(graph: CorridorGraph | null, barId: string): Segment2[] {
  if (!graph) return [];
  const out: Segment2[] = [];
  for (const l of graph.legs) if (l.barId === barId) out.push(...l.centerline);
  return out;
}

/** Knuckle rects as corridor slots, so the corner is a room rather than a hole between two bars */
export function knuckleSlots(graph: CorridorGraph | null, barId: string, width: number): CorridorSlot[] {
  if (!graph) return [];
  const out: CorridorSlot[] = [];
  for (const k of graph.knuckles) {
    if (k.barIds[0] !== barId) continue;    // the first bar of the pair owns the corner, so it is built once
    out.push({
      rect: k.rect, barId, spineId: `${barId}-KNUCKLE`, width,
      wallSides: [], external: false, daylitEnds: [],
    });
  }
  return out;
}

/** Break-slot intervals of a bar that a core has NOT taken, for reporting */
export function openBreaks(graph: CorridorGraph | null, frame: BarFrame, usedBy: ReadonlySet<string>): Interval[] {
  if (!graph) return [];
  const origin = spineOrigin(frame, graph);
  return graph.breakSlots
    .filter(b => b.barId === frame.barId && !usedBy.has(b.id))
    .map(b => breakInterval(frame, b, origin));
}

// ---------------------------------------------------------------------------------------------------------------
// Travel distance — Dijkstra over the corridor graph
// ---------------------------------------------------------------------------------------------------------------

export interface TravelGraph {
  /** shortest corridor distance from every node to the nearest exit */
  toExit: number[];
  nodes: Vec2[];
  legs: { a: number; b: number; leg: CorridorLeg }[];
}

/**
 * The walkable graph: `legGraph` (site) welds leg ends that meet within half a corridor width, so a knuckle is
 * already one node and an O-plan is already one cyclic component. Dijkstra from every exit gives each node its
 * distance to the nearest one; `travelFrom` then adds the walk from a unit entry onto the nearest leg.
 */
export function travelGraph(graph: CorridorGraph | null, exits: readonly Rect[], width: number): TravelGraph | null {
  if (!graph || graph.legs.length === 0) return null;
  // site owns the node/edge construction (it extends legs past a knuckle so the corner closes); we only search it
  const { adj, nodes } = legGraph(graph.legs, width);
  const legs: { a: number; b: number; leg: CorridorLeg }[] = [];
  const nodeAt = (p: Vec2): number => {
    const tol = Math.max(0.2, width / 2 + 0.05);
    for (let i = 0; i < nodes.length; i++) {
      if (Math.abs(nodes[i][0] - p[0]) <= tol && Math.abs(nodes[i][1] - p[1]) <= tol) return i;
    }
    return -1;
  };
  for (const l of graph.legs) {
    const seg = l.centerline[0];
    if (!seg) continue;
    const a = nodeAt(seg.a);
    const b = nodeAt(seg.b);
    if (a < 0 || b < 0) continue;
    legs.push({ a, b, leg: l });
  }

  // Dijkstra from every exit at once: the graph is ≤ ~40 nodes per floor, so a relaxation queue beats a heap
  const toExit = nodes.map(() => Infinity);
  const queue: number[] = [];
  for (const e of exits) {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      const d = rectDist(e, nodes[i]);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best >= 0 && bestD < toExit[best]) { toExit[best] = bestD; queue.push(best); }
  }
  let guard = 0;
  while (queue.length > 0 && guard++ < nodes.length * nodes.length + 64) {
    const cur = queue.shift()!;
    for (const e of adj.get(cur) ?? []) {
      const nd = toExit[cur] + e.len;
      if (nd < toExit[e.to] - 1e-6) {
        toExit[e.to] = nd;
        queue.push(e.to);
      }
    }
  }
  return { toExit, nodes, legs };
}

/** Travel from a unit entry to the nearest exit, walking the corridor rather than crossing the plate */
export function travelFrom(tg: TravelGraph | null, p: Vec2): number {
  if (!tg) return 0;
  let best = Infinity;
  for (const { a, b, leg } of tg.legs) {
    const segs = leg.centerline;
    for (const s of segs) {
      const { perp, alongA, alongB } = project(p, s);
      const viaA = perp + alongA + tg.toExit[a];
      const viaB = perp + alongB + tg.toExit[b];
      best = Math.min(best, viaA, viaB);
    }
  }
  return Number.isFinite(best) ? best : 0;
}

function project(p: Vec2, s: Segment2): { perp: number; alongA: number; alongB: number } {
  const dx = s.b[0] - s.a[0];
  const dy = s.b[1] - s.a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 < EPS) return { perp: dist(p, s.a), alongA: 0, alongB: 0 };
  const t = Math.max(0, Math.min(1, ((p[0] - s.a[0]) * dx + (p[1] - s.a[1]) * dy) / len2));
  const q: Vec2 = [s.a[0] + dx * t, s.a[1] + dy * t];
  const len = Math.sqrt(len2);
  return { perp: dist(p, q), alongA: len * t, alongB: len * (1 - t) };
}

function rectDist(r: Rect, p: Vec2): number {
  const dx = Math.max(r.x - p[0], 0, p[0] - (r.x + r.w));
  const dy = Math.max(r.y - p[1], 0, p[1] - (r.y + r.h));
  return Math.hypot(dx, dy);
}

/** Longest leg of the graph — the ARC-03 metric, reported instead of measured off the instantiated rects */
export function longestLeg(graph: CorridorGraph | null): number {
  if (!graph) return 0;
  return graph.legs.reduce((m, l) => Math.max(m, l.length), 0);
}

export { oppositeSide, alongRange };
