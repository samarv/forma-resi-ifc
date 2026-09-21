/**
 * F7 — Corridor graph (frozen header; body implemented by the site agent in wave 1).
 *
 * Site owns the corridor topology: each spine is split into legs ≤ ARC-03.maxLegLength with break slots, bars meeting
 * at a corner are joined through a knuckle (an O-plan is ONE cyclic corridor), and dead ends beyond SIT-08.deadEnd get
 * a core or a shortened leg. `placeCores` consumes break slots first; the architecture placer consumes the graph as
 * blocked intervals per leg and instantiates BreakModules into the slots.
 */
import type { AccessType, CorridorSpine, FootprintShape, MassingBar, Rect, Segment2, Vec2 } from '../../core/types.ts';
import type { Issue, Ledger, RuleSet } from '../../core/rules/types.ts';
import type { IdFactory } from '../../core/ids.ts';

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
  rules: RuleSet;
  ids: IdFactory;
  ledger: Ledger;
}

export function buildCorridorGraph(_o: CorridorGraphInput): CorridorGraph {
  throw new Error('buildCorridorGraph: not implemented yet (wave 1, site agent)');
}
