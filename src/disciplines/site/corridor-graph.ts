/**
 * F7 — Corridor graph (frozen header; body implemented by the site agent in wave 1).
 *
 * Site owns the corridor topology: each spine is split into legs ≤ ARC-03.maxLegLength with break slots, bars meeting
 * at a corner are joined through a knuckle (an O-plan is ONE cyclic corridor), and dead ends beyond SIT-08.deadEnd get
 * a core or a shortened leg. `placeCores` consumes break slots first; the architecture placer consumes the graph as
 * blocked intervals per leg and instantiates BreakModules into the slots.
 *
 * IMPLEMENTATION NOTES (v2 wave 1)
 * - `CorridorSpine.centerline` keeps its v1 meaning — the FULL spine of the bar — so the five v1 consumers
 *   (`floor-organizer`, `mechanical/building`, `plumbing/service`, `electrical/panels`, `app/site-svg`) are untouched;
 *   `legs` carries the split. `centerline` therefore deep-equals `legs[0]` exactly when a spine needs only one leg.
 *   Step 7 flips those five consumers onto `legs` in one commit.
 * - A leg that reaches a knuckle is extended past the corner to `width / 2` beyond the other spine's centreline, so the
 *   two corridor bands overlap in a `width × width` square: the corner is closed and travel turns it.
 * - A dead end is measured to an EXIT, and the exits are the cores, which are placed from this graph's break slots.
 *   So the pass is split: `buildCorridorGraph` returns `deadEnds: []`, and `resolveDeadEnds` (called by `placeCores`
 *   once the cores exist) measures every free leg end against the real core stations and the knuckles, reserves a
 *   further core break slot where one is over the limit, and fills in `deadEnds`. `MassingModel.corridorGraph` always
 *   carries the resolved graph.
 */
import type { AccessType, CorridorSpine, FootprintShape, MassingBar, Rect, Segment2, Vec2 } from '../../core/types.ts';
import type { Issue, Ledger, RuleSet } from '../../core/rules/types.ts';
import type { IdFactory } from '../../core/ids.ts';
import { SITE_STOREY } from '../../core/ids.ts';
import { cross } from '../../core/geometry.ts';
import { clampNum } from './util.ts';
import { RULE, deviation, info, issueSink, ruleNum, type IssueSink } from './issues.ts';

export interface BreakSlot {
  id: string;
  barId: string;
  /** arc-length station along the bar's spine */
  station: number;
  length: number;
  want: 'core' | 'lounge' | 'window-bay' | 'knuckle';
  reason: string;
}

export interface Knuckle {
  id: string;
  barIds: readonly string[];
  rect: Rect;
  want: 'corner-core' | 'lounge';
}

export interface CorridorLeg {
  id: string;
  spineId: string;
  barId: string;
  centerline: Segment2[];
  length: number;
}

export interface CorridorGraph {
  /** spines with `legs` populated (centerline === legs[0] during migration) */
  spines: CorridorSpine[];
  legs: readonly CorridorLeg[];
  breakSlots: readonly BreakSlot[];
  knuckles: readonly Knuckle[];
  deadEnds: readonly { legId: string; end: 'a' | 'b'; length: number }[];
  /** longest continuous run through the graph (the ARC-03 / IBC 1020 metric) */
  longestRunM: number;
  issues: readonly Issue[];
}

export interface CorridorGraphInput {
  bars: readonly MassingBar[];
  access: AccessType;
  width: number;
  footprintCentroid: Vec2;
  shape: FootprintShape;
  sprinklered: boolean;
  /** Optional until `src/core/rules/**` lands: every tunable falls back to its v1 constant */
  rules?: RuleSet;
  ids: IdFactory;
  ledger?: Ledger;
  /** v1 string projection, used only when no ledger is wired yet */
  warnings?: string[];
  sink?: IssueSink;
}

/** v1 defaults, all lifted to `Rule` records by the kernel agent (see the `rules.num` ids below). */
const DEFAULT_MAX_LEG = 45;
const DEFAULT_BREAK_SLOT = 5.0;
const DEFAULT_DEAD_END_SPRINKLERED = 15;
const DEFAULT_DEAD_END = 6;
/** Two stations closer than this are the same place (slots never overlap) */
const SAME_STATION = 0.05;
/**
 * A free end this close to a knuckle turns the corner instead of dead-ending. A spine extended
 * into a knuckle ends exactly `width / 2` past the other centreline, so the tolerance has to
 * grow with the corridor.
 */
function atKnuckle(width: number): number {
  return Math.max(1.0, width / 2 + 0.05);
}

const CORRIDOR_ACCESS: AccessType[] = ['corridor-double', 'corridor-single', 'gallery', 'cluster'];

/**
 * One spine per bar. Double-loaded and cluster corridors sit at mid-depth.
 *
 * Single-loaded and gallery spines sit HARD AGAINST the long face away from the street (or away
 * from the courtyard, for a bar in a ring): the centreline is half the deck width off that face,
 * i.e. always within 1 m of it. Architecture models the deck outside the envelope and gives the
 * whole bar depth to the dwellings, so a spine drawn anywhere else would describe a building that
 * is not built — and would push the core off the face it has to open onto.
 */
export function buildCorridors(
  bars: readonly MassingBar[],
  access: AccessType,
  width: number,
  footprintCentroid: Vec2,
  ids: IdFactory,
): CorridorSpine[] {
  if (!CORRIDOR_ACCESS.includes(access)) return [];
  const single = access === 'corridor-single' || access === 'gallery';
  const out: CorridorSpine[] = [];
  for (const bar of bars) {
    const r = bar.rect;
    const acrossIsY = bar.axis === 'x';
    const barMid = acrossIsY ? r.y + r.h / 2 : r.x + r.w / 2;
    const centroidAcross = acrossIsY ? footprintCentroid[1] : footprintCentroid[0];
    let offset = bar.depth / 2;
    let outwardSign = -1;                   // -1: outer (street / away-from-court) face is the across-min face
    if (single) {
      // The deck takes the inner face — the one looking at the rest of the block, or the rear of
      // a lone bar — so every dwelling keeps the street / outward aspect.
      if (centroidAcross < barMid - 0.5) outwardSign = 1;
      offset = outwardSign < 0 ? bar.depth - width / 2 : width / 2;
      offset = clampNum(offset, width / 2, bar.depth - width / 2);
    }
    const dir: Vec2 = acrossIsY ? [1, 0] : [0, 1];
    const bandNormal: Vec2 = acrossIsY ? [0, outwardSign] : [outwardSign, 0];
    const loaded: CorridorSpine['loaded'] = single ? (cross(dir, bandNormal) > 0 ? 'left' : 'right') : 'both';
    const centerline = acrossIsY
      ? { a: [r.x, r.y + offset] as Vec2, b: [r.x + r.w, r.y + offset] as Vec2 }
      : { a: [r.x + offset, r.y] as Vec2, b: [r.x + offset, r.y + r.h] as Vec2 };
    out.push({ id: ids.next(SITE_STOREY, 'CORR'), barId: bar.id, centerline, width, loaded });
  }
  return out;
}

interface Axis {
  /** 'x' when the spine runs along +X */
  along: 'x' | 'y';
  /** Fixed coordinate across the spine */
  across: number;
  /** Station range of the spine on its along-axis, in world coordinates */
  a: number;
  b: number;
}

interface SpineWork {
  spine: CorridorSpine;
  bar: MassingBar;
  axis: Axis;
  /** Extension of each end past the bar (knuckles), in metres */
  extendA: number;
  extendB: number;
  /** Stations (0 = the extended `a` end) at which a leg ends */
  joints: number[];
  /** Stations of the knuckle centres on this spine */
  knuckleStations: number[];
  legs: CorridorLeg[];
}

export function buildCorridorGraph(o: CorridorGraphInput): CorridorGraph {
  const sink = o.sink ?? issueSink(o.ledger, o.warnings);
  const issuesBefore = sink.all().length;
  const spines = buildCorridors(o.bars, o.access, o.width, o.footprintCentroid, o.ids);
  if (spines.length === 0) {
    return { spines, legs: [], breakSlots: [], knuckles: [], deadEnds: [], longestRunM: 0, issues: [] };
  }

  const maxLeg = Math.max(5, ruleNum(o.rules, 'ARC-03.maxLegLength', DEFAULT_MAX_LEG));
  const slotLen = Math.max(1, ruleNum(o.rules, 'ARC-03.breakSlotLength', DEFAULT_BREAK_SLOT));
  const barById = new Map(o.bars.map(b => [b.id, b]));

  const work: SpineWork[] = [];
  for (const spine of spines) {
    const bar = barById.get(spine.barId);
    if (!bar) continue;
    work.push({ spine, bar, axis: axisOf(spine), extendA: 0, extendB: 0, joints: [], knuckleStations: [], legs: [] });
  }

  // --- 1. knuckles: join every pair of perpendicular spines that meets at a corner -----------
  const knuckles: Knuckle[] = [];
  for (let i = 0; i < work.length; i++) {
    for (let j = i + 1; j < work.length; j++) {
      const p = work[i], q = work[j];
      if (p.axis.along === q.axis.along) continue;
      const xSpine = p.axis.along === 'x' ? p : q;      // runs along +X, fixed in Y
      const ySpine = p.axis.along === 'x' ? q : p;      // runs along +Y, fixed in X
      const px = ySpine.axis.across;
      const py = xSpine.axis.across;
      const reachX = reach(xSpine, px);                 // how far the crossing is off each spine
      const reachY = reach(ySpine, py);
      if (reachX === null || reachY === null) continue;
      if (!insideBar(xSpine.bar.rect, px, py, o.width) && !insideBar(ySpine.bar.rect, px, py, o.width)) continue;
      // Reach the other centreline, then half a corridor past it, so the corner square is closed.
      extendTo(xSpine, reachX, o.width);
      extendTo(ySpine, reachY, o.width);
      knuckles.push({
        id: o.ids.next(SITE_STOREY, 'KNUK'),
        barIds: [xSpine.bar.id, ySpine.bar.id].sort(),
        rect: { x: round3(px - o.width / 2), y: round3(py - o.width / 2), w: o.width, h: o.width },
        want: 'lounge',
      });
    }
  }
  for (const w of work) {
    for (const k of knuckles) {
      if (!k.barIds.includes(w.bar.id)) continue;
      w.knuckleStations.push(round3(stationOf(w, [k.rect.x + k.rect.w / 2, k.rect.y + k.rect.h / 2])));
    }
    w.knuckleStations.sort((a, b) => a - b);
  }

  // --- 2. legs ≤ maxLeg, with a break slot at every interior joint ---------------------------
  const breakSlots: BreakSlot[] = [];
  const legs: CorridorLeg[] = [];
  const singleLoaded = o.access === 'corridor-single' || o.access === 'gallery';
  for (const w of work) {
    const total = spineLength(w);
    const n = Math.max(1, Math.ceil(total / maxLeg - 1e-9));
    const legLen = total / n;
    for (let k = 1; k < n; k++) w.joints.push(round3(k * legLen));
    // The most central joint is the one a core wants; the others become a lounge or, on a
    // single-loaded deck, a window bay on the open face.
    const centre = total / 2;
    let best = -1;
    for (let k = 0; k < w.joints.length; k++) {
      if (best < 0 || Math.abs(w.joints[k] - centre) < Math.abs(w.joints[best] - centre) - 1e-9) best = k;
    }
    for (let k = 0; k < w.joints.length; k++) {
      breakSlots.push({
        id: o.ids.next(SITE_STOREY, 'BRK'),
        barId: w.bar.id,
        station: w.joints[k],
        length: Math.min(slotLen, legLen),
        want: k === best ? 'core' : singleLoaded ? 'window-bay' : 'lounge',
        reason: `leg ${k + 1} of ${n} on a ${round1(total)} m spine (ARC-03 ${maxLeg} m)`,
      });
    }
    if (w.joints.length > 0) {
      sink.add(info(RULE.legLength,
        `Corridor on bar ${w.bar.id} split into ${n} legs of ${round1(legLen)} m with ${w.joints.length} break slot(s) (ARC-03 ${maxLeg} m).`, {
        observed: round1(total),
        limit: maxLeg,
        source: 'ARC-03 maxLegLength',
        resolution: { id: 'split-corridor', from: round1(total), to: round1(legLen) },
      }));
    }
    // Leg geometry. Knuckle stations are cuts too, so the corner is a NODE of the graph: without
    // them an O-plan would be four unconnected spines crossing each other mid-leg.
    const cuts = mergeCuts([0, ...w.joints, total], w.knuckleStations, total, atKnuckle(o.width));
    const polyline: Segment2[] = [];
    for (let k = 0; k + 1 < cuts.length; k++) {
      const seg: Segment2 = { a: pointAt(w, cuts[k]), b: pointAt(w, cuts[k + 1]) };
      polyline.push(seg);
      const leg: CorridorLeg = {
        id: `${w.spine.id}-LEG-${String(k + 1).padStart(3, '0')}`,
        spineId: w.spine.id,
        barId: w.bar.id,
        centerline: [seg],
        length: round3(cuts[k + 1] - cuts[k]),
      };
      w.legs.push(leg);
      legs.push(leg);
    }
    w.spine.legs = polyline;
  }

  breakSlots.sort((a, b) => (a.barId < b.barId ? -1 : a.barId > b.barId ? 1 : a.station - b.station));

  return {
    spines,
    legs,
    breakSlots,
    knuckles,
    deadEnds: [],                      // filled in by resolveDeadEnds once the cores exist
    longestRunM: round1(longestRun(legs, o.width)),
    issues: sink.all().slice(issuesBefore),
  };
}

export interface DeadEndInput {
  graph: CorridorGraph;
  bars: readonly MassingBar[];
  /** The exits: the world centre of every core, as `placeCores` placed them */
  exits: readonly { barId: string; at: Vec2; length: number }[];
  sprinklered: boolean;
  rules?: RuleSet;
  sink: IssueSink;
}

/**
 * SIT-08 / IBC 1020.4. Every leg end that is not a knuckle is a dead end; its length is the
 * distance to the nearest exit on the same bar (or to a knuckle, where the corridor turns the
 * corner and travel has two directions). Over the limit, a further break slot wanting a core is
 * reserved `limit` from the end — the shortened leg the architecture placer must break — and the
 * resolution is recorded. Returns the graph with `deadEnds` (and any new slot) filled in.
 */
export function resolveDeadEnds(o: DeadEndInput): CorridorGraph {
  const { graph, sink } = o;
  if (graph.legs.length === 0) return graph;
  const limit = Math.max(1, ruleNum(o.rules, 'SIT-08.deadEnd',
    o.sprinklered ? DEFAULT_DEAD_END_SPRINKLERED : DEFAULT_DEAD_END));
  const slotLen = Math.max(1, ruleNum(o.rules, 'ARC-03.breakSlotLength', DEFAULT_BREAK_SLOT));
  const source = `SIT-08 deadEnd (${o.sprinklered ? 'sprinklered' : 'unsprinklered'})`;
  const tol = atKnuckle(graph.spines[0] ? graph.spines[0].width : 1.5);
  const deadEnds: { legId: string; end: 'a' | 'b'; length: number }[] = [];
  const slots = graph.breakSlots.slice();
  let nextSlot = slots.length;

  for (const spine of graph.spines) {
    const spineLegs = graph.legs.filter(l => l.spineId === spine.id);
    if (spineLegs.length === 0) continue;
    const barId = spineLegs[0].barId;
    const total = spineLegs.reduce((s, l) => s + l.length, 0);
    const knuckleStations = graph.knuckles
      .filter(k => k.barIds.includes(barId))
      .map(k => stationOnLegs(spineLegs, [k.rect.x + k.rect.w / 2, k.rect.y + k.rect.h / 2]));
    const exits = o.exits.filter(e => e.barId === barId).map(e => stationOnLegs(spineLegs, e.at));
    const candidates = [...exits, ...knuckleStations];

    for (const end of ['a', 'b'] as const) {
      const at = end === 'a' ? 0 : total;
      if (knuckleStations.some(s => Math.abs(s - at) < tol + 1e-6)) continue;          // turns the corner
      const leg = end === 'a' ? spineLegs[0] : spineLegs[spineLegs.length - 1];
      const observed = candidates.reduce((d, s) => Math.min(d, Math.abs(s - at)), Infinity);
      if (observed <= limit + 1e-6) {
        deadEnds.push({ legId: leg.id, end, length: round1(observed) });
        continue;
      }
      const station = end === 'a' ? Math.min(limit, total / 2) : Math.max(total - limit, total / 2);
      const clash = slots.some(s => s.barId === barId
        && s.station + s.length / 2 > station - slotLen / 2 + SAME_STATION
        && station + slotLen / 2 > s.station - s.length / 2 + SAME_STATION);
      const observedM = observed === Infinity ? round1(total) : round1(observed);
      if (clash) {
        // The break is already reserved where it can go; the end stays long and is reported.
        deadEnds.push({ legId: leg.id, end, length: observedM });
        sink.add(deviation(RULE.deadEnd,
          `Corridor on bar ${barId}: a ${observedM} m dead end at end ${end} exceeds the ${limit} m limit and no further break fits (SIT-08).`,
          { observed: observedM, limit, source }));
        continue;
      }
      nextSlot++;
      slots.push({
        id: `${spine.id}-BRK-${String(nextSlot).padStart(3, '0')}`,
        barId,
        station: round3(station),
        length: slotLen,
        want: 'core',
        reason: `dead end of ${observedM} m at end ${end} exceeds the ${limit} m limit`,
      });
      deadEnds.push({ legId: leg.id, end, length: round1(Math.abs(station - at)) });
      sink.add(info(RULE.deadEnd,
        `Corridor on bar ${barId}: a ${observedM} m dead end at end ${end} exceeds the ${limit} m limit; a core break slot is reserved ${round1(Math.abs(station - at))} m from the end (SIT-08).`, {
        observed: observedM,
        limit,
        source,
        resolution: { id: 'add-core', from: observedM, to: round1(Math.abs(station - at)) },
      }));
    }
  }
  slots.sort((a, b) => (a.barId < b.barId ? -1 : a.barId > b.barId ? 1 : a.station - b.station));
  return { ...graph, breakSlots: slots, deadEnds };
}

/** Station of a world point along a spine's ordered legs (0 = the first leg's `a` end). */
function stationOnLegs(legs: readonly CorridorLeg[], p: Vec2): number {
  const a = legs[0].centerline[0].a;
  const b = legs[legs.length - 1].centerline[0].b;
  const alongX = Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]);
  return alongX ? p[0] - a[0] : p[1] - a[1];
}

/** Ordered, de-duplicated cut stations: an extra cut within `tol` of an existing one is dropped. */
function mergeCuts(base: number[], extra: number[], total: number, tol: number): number[] {
  const out = base.slice();
  for (const e of extra) {
    if (e <= tol || e >= total - tol) continue;
    if (out.some(c => Math.abs(c - e) < tol)) continue;
    out.push(e);
  }
  return out.sort((a, b) => a - b);
}

/** Break slots a core may sit in, nearest first to `want` — `placeCores` consumes these. */
export function coreSlotsOn(graph: CorridorGraph | undefined, barId: string): BreakSlot[] {
  if (!graph) return [];
  return graph.breakSlots.filter(s => s.barId === barId).slice()
    .sort((a, b) => (a.want === b.want ? a.station - b.station : a.want === 'core' ? -1 : b.want === 'core' ? 1 : a.station - b.station));
}

// ---------------------------------------------------------------------------
// Geometry helpers — every spine is axis-aligned, so stations are 1-D
// ---------------------------------------------------------------------------

function axisOf(spine: CorridorSpine): Axis {
  const { a, b } = spine.centerline;
  if (Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1])) {
    return { along: 'x', across: (a[1] + b[1]) / 2, a: Math.min(a[0], b[0]), b: Math.max(a[0], b[0]) };
  }
  return { along: 'y', across: (a[0] + b[0]) / 2, a: Math.min(a[1], b[1]), b: Math.max(a[1], b[1]) };
}

function spineLength(w: SpineWork): number {
  return w.axis.b - w.axis.a + w.extendA + w.extendB;
}

function extendTo(w: SpineWork, want: number, width: number): void {
  if (want === 0) return;
  const need = Math.abs(want) + width / 2;
  if (want < 0) w.extendA = Math.max(w.extendA, need);
  else w.extendB = Math.max(w.extendB, need);
}

/** World point at `station` along the extended spine (0 = the extended `a` end). */
function pointAt(w: SpineWork, station: number): Vec2 {
  const t = w.axis.a - w.extendA + station;
  return w.axis.along === 'x' ? [round3(t), round3(w.axis.across)] : [round3(w.axis.across), round3(t)];
}

/** Station of a world point on the extended spine. */
function stationOf(w: SpineWork, p: Vec2): number {
  const t = w.axis.along === 'x' ? p[0] : p[1];
  return t - (w.axis.a - w.extendA);
}

/**
 * How far `coord` sits outside the spine's own extent along its axis: 0 when the crossing is on
 * the spine, negative when it is off the `a` end, positive when off the `b` end; `null` when the
 * crossing is further than one bar depth away, i.e. these two bars do not share a corner.
 */
function reach(w: SpineWork, coord: number): number | null {
  const slack = w.bar.depth + 1e-6;
  if (coord < w.axis.a - slack || coord > w.axis.b + slack) return null;
  if (coord < w.axis.a) return coord - w.axis.a;
  if (coord > w.axis.b) return coord - w.axis.b;
  return 0;
}

function insideBar(r: Rect, x: number, y: number, width: number): boolean {
  const t = width / 2 + 1e-6;
  return x >= r.x - t && x <= r.x + r.w + t && y >= r.y - t && y <= r.y + r.h + t;
}

/**
 * Longest simple path through the leg graph — the continuous run a resident can walk without
 * passing the same junction twice. Nodes are leg endpoints merged within half a corridor width
 * (so a knuckle is ONE node and an O-plan is one cycle), edges are legs. Exhaustive DFS: the
 * graph is at most a couple of dozen legs of degree ≤ 4, and the visit budget bounds the worst
 * case.
 */
function longestRun(legs: readonly CorridorLeg[], width: number): number {
  if (legs.length === 0) return 0;
  const { adj, count } = legGraph(legs, width);
  let best = 0;
  let budget = 50000;
  const seen = new Set<number>();
  const walk = (at: number, run: number): void => {
    if (run > best) best = run;
    if (budget-- <= 0) return;
    for (const e of adj.get(at) ?? []) {
      if (seen.has(e.to)) continue;
      seen.add(e.to);
      walk(e.to, run + e.len);
      seen.delete(e.to);
    }
  };
  for (let n = 0; n < count; n++) {
    seen.add(n);
    walk(n, 0);
    seen.delete(n);
  }
  return best;
}

/** Leg endpoints merged into nodes, plus the adjacency the placer's travel search needs. */
export function legGraph(
  legs: readonly CorridorLeg[],
  width: number,
): { adj: Map<number, { to: number; len: number; leg: string }[]>; count: number; nodes: Vec2[] } {
  const tol = Math.max(0.2, width / 2 + 0.05);
  const nodes: Vec2[] = [];
  const nodeOf = (p: Vec2): number => {
    for (let i = 0; i < nodes.length; i++) {
      if (Math.abs(nodes[i][0] - p[0]) <= tol && Math.abs(nodes[i][1] - p[1]) <= tol) return i;
    }
    nodes.push(p);
    return nodes.length - 1;
  };
  const adj = new Map<number, { to: number; len: number; leg: string }[]>();
  const link = (from: number, to: number, len: number, leg: string): void => {
    const list = adj.get(from);
    if (list) list.push({ to, len, leg });
    else adj.set(from, [{ to, len, leg }]);
  };
  for (const l of legs) {
    const seg = l.centerline[0];
    const u = nodeOf(seg.a);
    const v = nodeOf(seg.b);
    if (u === v) continue;
    link(u, v, l.length, l.id);
    link(v, u, l.length, l.id);
  }
  return { adj, count: nodes.length, nodes };
}

function round1(v: number): number { return Math.round(v * 10) / 10; }
function round3(v: number): number { return Math.round(v * 1000) / 1000; }
