/**
 * Bars and corridor legs → `StripDef`s.
 *
 * THE ONE PLACE `netDepth` IS COMPUTED. Everything downstream — the module depth filter, the module picker in the
 * editor, the fit-conformance test — reads `StripDef.netDepth`, so there is exactly one definition of "how deep is
 * this strip": the boundary depth less half of each bounding wall. (v1 computed it inline in `packStrip`,
 * floor-organizer.ts:382, and then compared it against a template minimum that had been derived at a different
 * depth — which is the whole "unit X has N m frontage, below the M m minimum at D m depth" warning family.)
 *
 * Blockers are the intervals along the bar the packer may not use: cores with their shaft bay, corridor knuckles, and
 * the break slots the site's corridor graph reserved. They are subtracted BEFORE any unit is placed.
 */
import type { Rect, Side } from '../../../core/types.ts';
import type { BreakSlot, CorridorGraph, CorridorLeg, Knuckle } from '../../site/corridor-graph.ts';
import type { SideWallSpec } from '../types-internal.ts';
import type { SlotId, StripDef, StripId } from './types.ts';
import { alongRange, ivLen, mergeIntervals, rectFromAC, subtractIntervals, type BarFrame, type Interval } from '../bar-frame.ts';

export type StripSide = 'low' | 'high' | 'start' | 'end';

const CODE: Record<StripSide, string> = { low: 'L', high: 'H', start: 'S', end: 'E' };

export function stripIdFor(barId: string, side: StripSide, n: number): StripId {
  return `ST-${barId}-${CODE[side]}-${n}`;
}

export function slotIdFor(stripId: StripId, n: number): SlotId {
  return `S-${stripId.slice(3)}-${String(n).padStart(3, '0')}`;
}

/** Inserted slots derive from their anchor: 'S-BAR1-L-007' → 'S-BAR1-L-007.1' */
export function insertedSlotId(anchor: SlotId, k: number): SlotId {
  return `${anchor}.${k}`;
}

/**
 * THE net-depth definition: the boundary rect's across extent less half of each bounding wall, i.e. the clear
 * distance between the inside faces of the two walls the module actually lives between.
 */
export function netDepthOf(cLow: number, cHigh: number, low: SideWallSpec, high: SideWallSpec): number {
  return round3(cHigh - cLow - low.thickness / 2 - high.thickness / 2);
}

export interface StripInput {
  frame: BarFrame;
  side: StripSide;
  /** along-bar interval the strip may fill, already clipped to the envelope */
  along: Interval;
  cLow: number;
  cHigh: number;
  accessSide: Side;
  exteriorSides: Side[];
  lowSpec: SideWallSpec;
  highSpec: SideWallSpec;
  legId?: string;
  blocked?: Interval[];
  index: number;
}

export function makeStrip(i: StripInput): StripDef {
  return {
    id: stripIdFor(i.frame.barId, i.side, i.index),
    barId: i.frame.barId,
    side: i.side,
    along: { s: round3(i.along.s), e: round3(i.along.e) },
    across: { s: round3(i.cLow), e: round3(i.cHigh) },
    netDepth: netDepthOf(i.cLow, i.cHigh, i.lowSpec, i.highSpec),
    accessSide: i.accessSide,
    exteriorSides: [...i.exteriorSides],
    legId: i.legId,
    blocked: mergeIntervals(i.blocked ?? [], 0.05),
  };
}

/** The free intervals of a strip: its `along` extent minus its blockers, dropping anything shorter than `minLen` */
export function freeIntervals(strip: StripDef, minLen = 2.0): Interval[] {
  return subtractIntervals(strip.along, [...strip.blocked], minLen);
}

// ---------------------------------------------------------------------------------------------------------------
// Blockers
// ---------------------------------------------------------------------------------------------------------------

export interface BlockerInput {
  frame: BarFrame;
  /** cores with their shaft bay, as along-intervals in the frame's terms */
  cores: readonly Interval[];
  graph: CorridorGraph | null;
  /** across-interval of the strip, so a knuckle that misses this strip is not a blocker for it */
  cLow: number;
  cHigh: number;
  /** extra reservations (the ground-floor common program) */
  reserved?: readonly Interval[];
}

/**
 * Cores, knuckles and break slots as along-intervals. A knuckle belongs to BOTH bars that meet at it, which is what
 * stops two bars each packing a unit into the same corner (the v1 bars were independent, so they did).
 */
export function blockersFor(b: BlockerInput): Interval[] {
  const out: Interval[] = [...b.cores.map(iv => ({ ...iv }))];
  if (b.graph) {
    for (const k of b.graph.knuckles) {
      if (!k.barIds.includes(b.frame.barId)) continue;
      const iv = alongRange(b.frame, k.rect);
      out.push({ s: iv.s, e: iv.e });
    }
    const origin = spineOrigin(b.frame, b.graph);
    for (const s of b.graph.breakSlots) {
      if (s.barId !== b.frame.barId) continue;
      out.push(breakInterval(b.frame, s, origin));
    }
  }
  for (const r of b.reserved ?? []) out.push({ ...r });
  return mergeIntervals(out, 0.05);
}

/**
 * A break slot's along-interval. `station` is arc length from the `a` end of the EXTENDED spine — which reaches past
 * the bar when a knuckle closes a corner — so the origin has to come from the legs, not from `frame.a0`.
 */
export function breakInterval(frame: BarFrame, s: BreakSlot, origin: number): Interval {
  const c = origin + s.station;
  return { s: round3(c - s.length / 2), e: round3(c + s.length / 2) };
}

/** The `a` end of a bar's extended spine in world along-coordinates: the origin every `station` is measured from */
export function spineOrigin(frame: BarFrame, graph: CorridorGraph | null): number {
  if (!graph) return frame.a0;
  let lo = Infinity;
  for (const l of graph.legs) {
    if (l.barId !== frame.barId) continue;
    for (const seg of l.centerline) {
      const a = frame.axis === 'x' ? seg.a[0] : seg.a[1];
      const b = frame.axis === 'x' ? seg.b[0] : seg.b[1];
      lo = Math.min(lo, a, b);
    }
  }
  return Number.isFinite(lo) ? lo : frame.a0;
}

/** Knuckle rect clipped to the bar, for the instantiated corridor geometry */
export function knuckleRect(frame: BarFrame, k: Knuckle): Rect {
  const a = alongRange(frame, k.rect);
  return rectFromAC(frame, a.s, a.e, frame.axis === 'x' ? k.rect.y : k.rect.x,
    frame.axis === 'x' ? k.rect.y + k.rect.h : k.rect.x + k.rect.w);
}

/** Legs of the graph that belong to a bar, in along order */
export function legsOf(graph: CorridorGraph | null, barId: string, frame: BarFrame): CorridorLeg[] {
  if (!graph) return [];
  return graph.legs
    .filter(l => l.barId === barId)
    .sort((p, q) => legStation(frame, p) - legStation(frame, q));
}

function legStation(frame: BarFrame, l: CorridorLeg): number {
  const seg = l.centerline[0];
  if (!seg) return 0;
  return frame.axis === 'x' ? Math.min(seg.a[0], seg.b[0]) : Math.min(seg.a[1], seg.b[1]);
}

/** The leg whose along-extent contains `at`, or the nearest one */
export function legAt(legs: readonly CorridorLeg[], frame: BarFrame, at: number): CorridorLeg | undefined {
  let best: CorridorLeg | undefined;
  let bestD = Infinity;
  for (const l of legs) {
    const seg = l.centerline[0];
    if (!seg) continue;
    const s = frame.axis === 'x' ? Math.min(seg.a[0], seg.b[0]) : Math.min(seg.a[1], seg.b[1]);
    const e = frame.axis === 'x' ? Math.max(seg.a[0], seg.b[0]) : Math.max(seg.a[1], seg.b[1]);
    if (at >= s - 1e-6 && at <= e + 1e-6) return l;
    const d = Math.min(Math.abs(at - s), Math.abs(at - e));
    if (d < bestD) { bestD = d; best = l; }
  }
  return best;
}

export function totalBlocked(list: readonly Interval[]): number {
  return mergeIntervals([...list], 0).reduce((a, iv) => a + ivLen(iv), 0);
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
