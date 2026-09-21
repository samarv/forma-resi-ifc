/**
 * F5b — Furniture kits: what a room MUST contain, the clear dimensions those items imply, and the ONE placement
 * routine every room type shares.
 *
 * Two things were wrong in v1 and both are fixed here:
 *  1. Room minima were table constants unrelated to the furniture that had to fit, so a 2.2 m "kitchen" existed
 *     into which a sink, a range and a fridge do not go. `kitMinDims(kit)` now DERIVES the minimum from the kit's
 *     mandatory run plus its clearance sources, and `program/programs.ts` asserts every node against it.
 *  2. Only `furnishBathroom` walked the run along the wall in 100 mm steps and turned the last item onto a lateral
 *     wall; the kitchen laid its run once, centred, and silently lost every item the door swing covered (5 kitchens
 *     on `us-5-over-1` ended up holding nothing but a fridge). `fitKit` is that offset sweep plus the two-wall
 *     fallback, now shared, so "every kitchen has a sink, a range and a fridge" is an invariant of placement.
 *
 * Everything here is pure geometry in the unit-local (u, v) frame — no ids, no world coordinates, no Rng — so a
 * caller (the v1 `furnishRoom`, the v2 program solver, the module self-test) maps the result however it likes.
 *
 * Clearance sources: IPC 2021 §405.3.1 (WC 381 mm centreline / 533 mm front), ADA 2010 §304.3.1 (1.5 m turning
 * circle), §604/§608 (WC, roll-in shower), NKBA 2016 (1.2 m kitchen aisle, work triangle 4–8 m), London Plan
 * Housing SPG Table 3.3 (bedroom widths 2.15 / 2.75), Neufert 5th ed. (beds, tables, counter runs).
 */
import type { FurnitureType, Rect, Side } from '../../../core/types.ts';
import type { KitId } from './types.ts';
import { CLEARANCE, FURNITURE_CATALOG } from '../furniture.ts';

/** Local direction an item faces: the unit frame's u/v axes (same strings as unit-layout's `LDir`) */
export type KitFace = 'u+' | 'u-' | 'v+' | 'v-';

/** The subset of `RuleSet` a kit reads. Optional everywhere: without it the constants below apply unchanged. */
export interface KitRules {
  num(id: string, fallback: number): number;
}

export interface KitOpts {
  accessible?: boolean;
  occupants?: number;
  detail?: 'low' | 'medium' | 'high';
  /** room area (m²) — some kits swap a lavatory for a vanity, or a shower for a tub, above a threshold */
  area?: number;
  /** allow the second-order items (island, extra sofa): the old `big` flag */
  big?: boolean;
  /** true for an en-suite: no bathtub */
  ensuite?: boolean;
  rules?: KitRules;
}

export interface KitItem {
  type: FurnitureType;
  w: number;
  d: number;
  /** a kit is only placed if every mandatory item is placed */
  mandatory: boolean;
}

export interface KitDef {
  id: KitId;
  /** the invariant: a room with this kit has every one of these items, or the kit did not fit */
  mandatory: FurnitureType[];
  /** …and at least one item out of each group (a bath needs a basin and a shower OR a tub) */
  oneOf?: FurnitureType[][];
  /**
   * Minimum clear internal dimensions (m): `w` along the run wall, `d` across the room. This is the frozen number
   * `program/programs.ts` asserts every node's `minWidth`/`minDepth` against; `kits.test.ts` checks that the kit's
   * own mandatory run actually fits inside it.
   */
  min: { w: number; d: number };
  /** where the numbers come from, for the report and the rule set */
  source: string;
  /** the run for a wall of `along` metres, mandatory items first */
  items(along: number, o: KitOpts): KitItem[];
}

export interface Placement {
  type: FurnitureType;
  /** footprint in the same local frame as the room rect passed to `fitKit` */
  aabb: Rect;
  face: KitFace;
  w: number;
  d: number;
  mandatory: boolean;
}

export interface FitResult {
  /** every mandatory item was placed */
  ok: boolean;
  items: Placement[];
  missing: FurnitureType[];
  /** the wall the run ended up on (local side), null when nothing was placed */
  wall: Side | null;
  /** sink → range → fridge, 0 when the kit has no work triangle */
  triangle: number;
  /** the run landed on the wall opposite the wet wall (longer branch; XD-01 allows 3 m) */
  oppositeWetWall: boolean;
}

// ---------------------------------------------------------------------------------------------------------------
// Local rect algebra — shared with unit-layout.ts (imported there, not duplicated)
// ---------------------------------------------------------------------------------------------------------------

export function insetLocal(r: Rect, d: number): Rect {
  return { x: r.x + d, y: r.y + d, w: Math.max(0, r.w - 2 * d), h: Math.max(0, r.h - 2 * d) };
}

export function sideCentre(inner: Rect, s: Side): number {
  return s === 'front' || s === 'rear' ? inner.x + inner.w / 2 : inner.y + inner.h / 2;
}

export function sideLength(inner: Rect, s: Side): number {
  return s === 'front' || s === 'rear' ? inner.w : inner.h;
}

export function oppSide(s: Side): Side {
  return s === 'front' ? 'rear' : s === 'rear' ? 'front' : s === 'left' ? 'right' : 'left';
}

/** local side → the direction an item standing against it faces */
export function faceOfSide(s: Side): KitFace {
  return s === 'front' ? 'v+' : s === 'rear' ? 'v-' : s === 'left' ? 'u+' : 'u-';
}

/** the wet-wall direction stored on a plan cell → the local side it names */
export function sideOfFace(f: KitFace): Side {
  return f === 'v+' ? 'rear' : f === 'v-' ? 'front' : f === 'u+' ? 'right' : 'left';
}

/** place a footprint against a local side of `inner`, centred at `centre` along that side */
export function againstSide(inner: Rect, s: Side, w: number, d: number, centre: number): { aabb: Rect; face: KitFace } {
  switch (s) {
    case 'front': return { aabb: { x: centre - w / 2, y: inner.y, w, h: d }, face: 'v+' };
    case 'rear': return { aabb: { x: centre - w / 2, y: inner.y + inner.h - d, w, h: d }, face: 'v-' };
    case 'left': return { aabb: { x: inner.x, y: centre - w / 2, w: d, h: w }, face: 'u+' };
    default: return { aabb: { x: inner.x + inner.w - d, y: centre - w / 2, w: d, h: w }, face: 'u-' };
  }
}

/** the same, `off` metres in from that side */
export function offsetFrom(inner: Rect, s: Side, off: number, w: number, d: number, centre: number): { aabb: Rect; face: KitFace } {
  switch (s) {
    case 'front': return { aabb: { x: centre - w / 2, y: inner.y + off, w, h: d }, face: 'v+' };
    case 'rear': return { aabb: { x: centre - w / 2, y: inner.y + inner.h - off - d, w, h: d }, face: 'v-' };
    case 'left': return { aabb: { x: inner.x + off, y: centre - w / 2, w: d, h: w }, face: 'u+' };
    default: return { aabb: { x: inner.x + inner.w - off - d, y: centre - w / 2, w: d, h: w }, face: 'u-' };
  }
}

/** Candidate start offsets for a fixture run along a wall: centred first, then a 100 mm sweep. */
export function offsets(spare: number): number[] {
  if (spare <= 0.02) return [Math.max(0, spare / 2)];
  const out = [spare / 2, 0.02];
  for (let x = 0.1; x < spare; x += 0.1) out.push(x);
  out.push(Math.max(0.02, spare - 0.02));
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Clearances (rule ids with today's constants as fallbacks)
// ---------------------------------------------------------------------------------------------------------------

/** IPC 2021 §405.3.1: 381 mm from the WC centreline to any obstruction, 533 mm clear in front */
const WC_CENTRELINE = 0.381;
const WC_FRONT = 0.533;
/** NKBA: counter depth + working aisle */
const COUNTER_D = 0.6;
/** kitchen work triangle guideline (NKBA 2016 §5): sink → range → fridge */
export const TRIANGLE_MIN = 3.6;
export const TRIANGLE_MAX = 8.0;

export interface KitClearances {
  /** NKBA galley aisle between opposing runs */
  kitchenAisle: number;
  /** ADA 2010 §304.3.1 turning circle */
  turningCircle: number;
  /** clear space in front of a lavatory / vanity */
  lavatoryFront: number;
  /** stand-off so an item never buries a skirting */
  wall: number;
}

/**
 * The clearances a kit places to, read through the rule set when one is available (principle 5: the fallback is
 * today's constant, so behaviour is unchanged until the rule set lands).
 */
export function kitClearances(r?: KitRules): KitClearances {
  return {
    kitchenAisle: r ? r.num('ARC-15.kitchenAisle', CLEARANCE.kitchenAisle) : CLEARANCE.kitchenAisle,
    turningCircle: r ? r.num('ARC-23.turningCircle', CLEARANCE.turningCircle) : CLEARANCE.turningCircle,
    lavatoryFront: r ? r.num('ARC-15.lavatoryFront', CLEARANCE.lavatoryFront) : CLEARANCE.lavatoryFront,
    wall: CLEARANCE.wall,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The kit table
// ---------------------------------------------------------------------------------------------------------------

const F = FURNITURE_CATALOG;
const must = (type: FurnitureType, w = F[type].w, d = F[type].d): KitItem => ({ type, w, d, mandatory: true });
const opt = (type: FurnitureType, w = F[type].w, d = F[type].d): KitItem => ({ type, w, d, mandatory: false });

/** sink + range + fridge in one run, with counter fillers sized from the spare length */
function kitchenRun(along: number, o: KitOpts, extras: FurnitureType[]): KitItem[] {
  const out: KitItem[] = [must('fridge'), must('range'), must('kitchen-sink')];
  for (const e of extras) out.push(opt(e));
  const need = out.reduce((s, i) => s + i.w, 0);
  const spare = along - need;
  // two counter fillers only when there is room for a usable one on each side of the range: a filler is worth
  // having above 0.35 m, and each is a THIRD of the spare so the run can never outgrow the wall it is on
  const gap = Math.min(Math.max(spare / 3, 0.15), 0.9);
  if (spare <= 0 || gap <= 0.35) return out;
  // the run reads fridge · counter · range · counter · sink · dishwasher
  const seq: KitItem[] = [out[0], opt('kitchen-counter', gap, COUNTER_D), out[1], opt('kitchen-counter', gap, COUNTER_D), out[2], ...out.slice(3)];
  const tail = along - seq.reduce((s, i) => s + i.w, 0);
  if (tail > 0.35) seq.push(opt('kitchen-counter', tail, COUNTER_D));
  return seq;
}

function bathRun(along: number, o: KitOpts, want: 'tub' | 'shower' | 'either' | 'none'): KitItem[] {
  const area = o.area ?? along * along;
  if (o.accessible) {
    // ADA 2010 §604 (0.45 m to the WC centreline) + §608 roll-in shower 1.5 × 0.9
    return [must('wc', 0.45), must('vanity'), must('shower', 1.5, 0.9)];
  }
  const out: KitItem[] = [must('wc')];
  out.push(along > 2.4 || area > 5 ? must('vanity') : must('lavatory'));
  if (want === 'none') return out;
  const rest = along - out.reduce((s, i) => s + i.w, 0) - 0.1;
  const tub = F.bathtub;
  const wantsTub = (want === 'tub' || want === 'either') && !o.ensuite && area >= 5.4 && rest >= tub.w;
  // the bathing fixture is always in the kit: where the single run is too short for it, fitKit's two-wall
  // fallback turns it onto a lateral wall (v1 only tried that for runs of more than two items, which is why
  // a 1.70 × 2.30 m bathroom ended up with a wc and a basin and nothing to wash in)
  out.push(wantsTub ? must('bathtub') : must('shower'));
  return out;
}

/** every kit id in `program/types.ts`, its mandatory items and the minimum clear rect they need */
export const KIT: Readonly<Record<KitId, KitDef>> = {
  'kitchen-galley': {
    id: 'kitchen-galley', mandatory: ['kitchen-sink', 'range', 'fridge'], min: { w: 2.5, d: 1.8 },
    source: 'run 0.8 + 0.76 + 0.9 = 2.46; counter 0.6 + NKBA aisle 1.2',
    items: (a, o) => kitchenRun(a, o, ['dishwasher']),
  },
  'kitchen-galley-washer': {
    id: 'kitchen-galley-washer', mandatory: ['kitchen-sink', 'range', 'fridge', 'washer'], min: { w: 3.1, d: 1.8 },
    source: 'kitchen-galley + washer 0.6',
    items: (a, o) => [...kitchenRun(a, o, ['dishwasher']), must('washer')],
  },
  'kitchen-island': {
    id: 'kitchen-island', mandatory: ['kitchen-sink', 'range', 'fridge'], min: { w: 3.1, d: 3.3 },
    source: 'counter 0.6 + aisle 1.2 + island 0.9 + 0.6',
    items: (a, o) => kitchenRun(a, o, ['dishwasher']),
  },
  'kitchen-accessible': {
    id: 'kitchen-accessible', mandatory: ['kitchen-sink', 'range', 'fridge'], min: { w: 2.7, d: 2.7 },
    source: 'ADA 2010 §304.3.1 1.5 m circle clear of the 0.6 m counter',
    items: (a, o) => kitchenRun(a, o, []),
  },
  'shared-kitchen': {
    id: 'shared-kitchen', mandatory: ['kitchen-sink', 'range', 'fridge'], min: { w: 3.0, d: 2.4 },
    source: 'two appliance runs for 6+ residents + 1.2 aisle',
    items: (a, o) => kitchenRun(a, o, ['dishwasher']),
  },
  'living-kitchen': {
    // a composite: fitKit lays the kitchen run, the caller lays `living-compact` in the same room
    id: 'living-kitchen', mandatory: ['kitchen-sink', 'range', 'fridge'], min: { w: 3.6, d: 4.2 },
    source: 'kitchen-galley run + living-compact seating + 1.2 aisle between them',
    items: (a, o) => kitchenRun(a, o, ['dishwasher']),
  },
  'bath-3pc-tub': {
    id: 'bath-3pc-tub', mandatory: ['wc'], oneOf: [['lavatory', 'vanity'], ['bathtub', 'shower']], min: { w: 1.7, d: 2.2 },
    source: `tub 1.7 across; IPC 405.3.1 WC ${WC_CENTRELINE} centreline + ${WC_FRONT} front; basin 0.7 front`,
    items: (a, o) => bathRun(a, o, 'tub'),
  },
  'bath-3pc-shower': {
    id: 'bath-3pc-shower', mandatory: ['wc'], oneOf: [['lavatory', 'vanity'], ['shower', 'bathtub']], min: { w: 1.6, d: 2.0 },
    source: 'shower 0.9 × 0.9 + WC + basin run; IPC 405.3.1',
    items: (a, o) => bathRun(a, o, 'shower'),
  },
  'bath-accessible': {
    id: 'bath-accessible', mandatory: ['wc', 'shower'], oneOf: [['vanity', 'lavatory']], min: { w: 2.2, d: 2.6 },
    source: 'ADA 2010 §603/§604/§608 + 1.5 m turning circle',
    items: (a, o) => bathRun(a, { ...o, accessible: true }, 'shower'),
  },
  'wc-2pc': {
    id: 'wc-2pc', mandatory: ['wc'], oneOf: [['lavatory', 'vanity']], min: { w: 1.1, d: 1.5 },
    source: `IPC 405.3.1 (${WC_CENTRELINE} + ${WC_FRONT}) + 0.7 m basin front`,
    items: (a, o) => bathRun(a, o, 'none'),
  },
  'bed-double': {
    id: 'bed-double', mandatory: ['bed-double'], min: { w: 2.75, d: 3.2 },
    source: 'bed 1.37 + 0.75 walkway + 0.45 (London Plan 2.75 governs); 1.9 + 0.7 foot',
    items: () => [must('bed-double'), opt('nightstand'), opt('wardrobe')],
  },
  'bed-single': {
    id: 'bed-single', mandatory: ['bed-single'], min: { w: 2.15, d: 2.9 },
    source: 'bed 0.99 + 0.75 walkway + 0.3 (London Plan 2.15); 1.9 + 0.7 foot',
    items: () => [must('bed-single'), opt('wardrobe')],
  },
  'bed-master': {
    id: 'bed-master', mandatory: ['bed-queen'], min: { w: 2.9, d: 3.4 },
    source: 'queen 1.52 + 0.75 walkway + 0.5; 2.03 + 0.7 foot',
    items: () => [must('bed-queen'), opt('nightstand'), opt('nightstand'), opt('wardrobe')],
  },
  'bed-bunk': {
    id: 'bed-bunk', mandatory: ['bed-bunk'], min: { w: 2.15, d: 2.6 },
    source: 'bunk 0.99 + 0.75 walkway; 1.9 + 0.7 foot',
    items: () => [must('bed-bunk'), opt('shelving')],
  },
  'living-3seat': {
    id: 'living-3seat', mandatory: ['sofa-3'], min: { w: 3.4, d: 3.05 },
    source: 'sofa 0.9 + 0.4 coffee gap + 0.6 table + 0.7 walk + 0.45 TV unit',
    items: () => [must('sofa-3'), opt('coffee-table'), opt('tv-unit')],
  },
  'living-compact': {
    id: 'living-compact', mandatory: ['sofa-2'], min: { w: 2.8, d: 2.8 },
    source: 'sofa-2 1.6 + 0.4 side table; 0.9 + 0.4 + 0.6 + 0.45',
    items: () => [must('sofa-2'), opt('coffee-table'), opt('tv-unit')],
  },
  'shared-living': {
    id: 'shared-living', mandatory: ['sofa-3'], min: { w: 3.8, d: 3.2 },
    source: 'two sofas + coffee table for 6+ residents',
    items: () => [must('sofa-3'), opt('sofa-2'), opt('coffee-table'), opt('tv-unit')],
  },
  'dining-4': {
    id: 'dining-4', mandatory: ['dining-table-4'], min: { w: 2.7, d: 2.3 },
    source: 'table 1.2 × 0.8 + 0.75 chair pull each side',
    items: () => [must('dining-table-4'), opt('dining-chair'), opt('dining-chair'), opt('dining-chair'), opt('dining-chair')],
  },
  'dining-6': {
    id: 'dining-6', mandatory: ['dining-table-6'], min: { w: 3.3, d: 2.4 },
    source: 'table 1.8 × 0.9 + 0.75 chair pull each side',
    items: () => [must('dining-table-6'), ...Array.from({ length: 6 }, () => opt('dining-chair'))],
  },
  'laundry-stack': {
    id: 'laundry-stack', mandatory: ['washer'], min: { w: 0.8, d: 0.7 },
    source: 'appliance 0.6 + 0.1 clear; dryer stacks above',
    items: () => [must('washer'), opt('dryer', 0, 0)],
  },
  'laundry-side': {
    id: 'laundry-side', mandatory: ['washer', 'dryer'], min: { w: 1.4, d: 0.7 },
    source: 'washer 0.6 + dryer 0.6 side by side + 0.1',
    items: () => [must('washer'), must('dryer')],
  },
  shelf: {
    id: 'shelf', mandatory: [], min: { w: 0.6, d: 0.6 },
    source: 'shelving 0.9 × 0.35 + 0.25 reach',
    items: () => [opt('shelving')],
  },
  'wardrobe-run': {
    id: 'wardrobe-run', mandatory: [], min: { w: 1.0, d: 0.6 },
    source: 'wardrobe 1.2 × 0.6 (a shorter run is fitted where the wall is shorter)',
    items: () => [opt('wardrobe')],
  },
  entry: {
    id: 'entry', mandatory: [], min: { w: 1.2, d: 1.5 },
    source: 'a 0.9 m leaf swing square + 0.3 m to pass it',
    items: () => [opt('bench'), opt('shelving')],
  },
  desk: {
    id: 'desk', mandatory: ['desk'], min: { w: 1.6, d: 2.0 },
    source: 'desk 1.2 × 0.6 + 0.75 chair pull',
    items: () => [must('desk'), opt('chair'), opt('bookcase')],
  },
  'garage-1car': {
    id: 'garage-1car', mandatory: ['car'], min: { w: 3.0, d: 5.6 },
    source: 'car 1.8 + 2 × 0.6 door clearance; 4.5 + 1.1',
    items: () => [must('car')],
  },
  'balcony-2': {
    id: 'balcony-2', mandatory: [], min: { w: 1.8, d: 1.8 },
    source: 'table 0.8 + two chairs; ARC-17 usable depth 1.8',
    items: () => [opt('outdoor-table'), opt('chair'), opt('chair'), opt('planter')],
  },
  none: {
    id: 'none', mandatory: [], min: { w: 0, d: 0 }, source: 'no kit', items: () => [],
  },
};

/** Mandatory items the kit did not get: every `mandatory` type, plus the first type of any unsatisfied `oneOf` group. */
export function missingFrom(def: KitDef, items: readonly Placement[]): FurnitureType[] {
  const placed = new Set(items.map(i => i.type));
  const out = def.mandatory.filter(t => !placed.has(t));
  for (const group of def.oneOf ?? []) {
    if (!group.some(t => placed.has(t))) out.push(group[0]);
  }
  return out;
}

/** The minimum clear internal rect the kit's mandatory items plus their clearances need (m). */
export function kitMinDims(kit: KitId): { w: number; d: number } {
  return { ...KIT[kit].min };
}

/** Every kit id, sorted — used by the build-time conformance tests. */
export const KIT_IDS: KitId[] = (Object.keys(KIT) as KitId[]).sort();

/** Items whose absence means the kit is incomplete (the `kit-complete` self-test check). */
export function kitMandatory(kit: KitId): readonly FurnitureType[] {
  return KIT[kit].mandatory;
}

/** Groups of which at least one item must be placed (basin, bathing fixture). */
export function kitOneOf(kit: KitId): readonly FurnitureType[][] {
  return KIT[kit].oneOf ?? [];
}

/** Basins count as either `lavatory` or `vanity`; a bath needs one of them plus a shower or a tub. */
export const BASIN_ITEMS: readonly FurnitureType[] = ['lavatory', 'vanity'];
export const BATHING_ITEMS: readonly FurnitureType[] = ['shower', 'bathtub'];

export interface KitFit {
  ok: boolean;
  reason?: string;
  /** clear dimensions left after the swing keep-outs, in the orientation the kit was tested in */
  clear?: { w: number; d: number };
}

/**
 * Feasibility predicate (as opposed to `fitKit`, which actually lays the items out): does `kit` fit `rect` with
 * `swings` reserved? Conservative — the kit needs its minima in one of the two orientations, measured on what is
 * left once each swing keep-out has been cut off the side it touches. `program/feasibility.ts` reads this through
 * `program/kits-api.ts`, so no room can be created that its complete kit does not fit.
 */
export function kitFits(rect: Rect, kit: KitId, swings: readonly Rect[] = []): KitFit {
  const min = kitMinDims(kit);
  if (min.w <= 0) return { ok: true, clear: { w: rect.w, d: rect.h } };
  let w = rect.w;
  let d = rect.h;
  for (const s of swings) {
    const ox = Math.min(rect.x + rect.w, s.x + s.w) - Math.max(rect.x, s.x);
    const oy = Math.min(rect.y + rect.h, s.y + s.h) - Math.max(rect.y, s.y);
    if (ox <= 1e-6 || oy <= 1e-6) continue;
    // cut the swing off the shorter way, so a leaf in a corner costs the room the less of the two
    if (ox * (d - oy) >= (w - ox) * d) d -= oy;
    else w -= ox;
  }
  const fits = (a: number, b: number): boolean => a >= min.w - 1e-6 && b >= min.d - 1e-6;
  if (fits(w, d) || fits(d, w)) return { ok: true, clear: { w, d } };
  return {
    ok: false,
    clear: { w, d },
    reason: `${kit} needs ${min.w.toFixed(2)} × ${min.d.toFixed(2)} m clear; ${w.toFixed(2)} × ${d.toFixed(2)} m left`,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// fitKit — the offset sweep + two-wall fallback, shared by every room type
// ---------------------------------------------------------------------------------------------------------------

export interface FitArgs {
  /** the room's clear rect in the unit-local frame */
  room: Rect;
  kit: KitId;
  /** door-swing keep-outs in the same frame (ARC-28) */
  swings?: readonly Rect[];
  /** anything already placed in the room */
  taken?: readonly Rect[];
  /** the wall the fixture run prefers — the wet wall for kitchens and baths */
  wetEdge?: KitFace;
  /** half the wet-wall thickness: the run is pulled back by this so no fixture sits inside a wall */
  setback?: number;
  opts?: KitOpts;
}

function rectsOverlap(a: Rect, b: Rect, eps = 1e-3): boolean {
  return a.x + a.w > b.x + eps && b.x + b.w > a.x + eps && a.y + a.h > b.y + eps && b.y + b.h > a.y + eps;
}

function contains(outer: Rect, inner: Rect, eps = 1e-3): boolean {
  return inner.x >= outer.x - eps && inner.y >= outer.y - eps
    && inner.x + inner.w <= outer.x + outer.w + eps && inner.y + inner.h <= outer.y + outer.h + eps;
}

function round4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

function centreOf(r: Rect): [number, number] {
  return [r.x + r.w / 2, r.y + r.h / 2];
}

/**
 * Lay a kit into a room.
 *
 * ```
 * candidates = [wetWall, lateralA, lateralB, opposite(wetWall)]
 * for wall in candidates:
 *   items = kit.items(alongLength(wall))              // mandatory first
 *   for off in offsets(spare):                        // centred, then a 0.1 m sweep
 *     if every box is inside the room and clear of the swings and of what is taken → place, done
 * two-wall fallback: keep the mandatory run on the wet wall, turn the last item onto a lateral wall
 * then: drop the optional items and retry any wall; then place item by item
 * ```
 * A kitchen whose one-run work triangle falls below 3.6 m retries with the fridge on the return leg (L-run),
 * which is also what saves the galley too short for a single run.
 */
export function fitKit(args: FitArgs): FitResult {
  const def = KIT[args.kit];
  const o = args.opts ?? {};
  const c = kitClearances(o.rules);
  const swings = args.swings ?? [];
  const taken0 = args.taken ?? [];
  const inner = insetLocal(args.room, c.wall);
  const setback = args.setback ?? 0;
  const wetSide = sideOfFace(args.wetEdge ?? 'v+');
  const area = o.area ?? args.room.w * args.room.h;
  const opts: KitOpts = { ...o, area };

  /** the run wall, pulled back by half the wet wall so no item lands inside it */
  const baseFor = (side: Side): Rect => (side === 'rear' ? { ...inner, h: inner.h - setback }
    : side === 'front' ? { ...inner, y: inner.y + setback, h: inner.h - setback }
      : side === 'right' ? { ...inner, w: inner.w - setback }
        : { ...inner, x: inner.x + setback, w: inner.w - setback });

  const base = baseFor(wetSide);
  const lateral: Side[] = wetSide === 'front' || wetSide === 'rear' ? ['left', 'right'] : ['front', 'rear'];
  const candidates: Side[] = [wetSide, ...lateral, oppSide(wetSide)];

  const clear = (boxes: readonly Rect[], extra: readonly Rect[] = []): boolean => boxes.every(b => {
    if (b.w < 0.03 || b.h < 0.03) return false;
    if (!contains(inner, b)) return false;
    if (taken0.some(t => rectsOverlap(t, b))) return false;
    if (swings.some(s => rectsOverlap(s, b))) return false;
    if (extra.some(e => e !== b && rectsOverlap(e, b))) return false;
    return true;
  });

  // every run is measured on the WET wall's setback rect, so a lateral run still clears the wet wall
  const runFrom = (side: Side, items: readonly KitItem[], off: number): { boxes: Rect[]; face: KitFace } => {
    const b = base;
    const start = side === 'front' || side === 'rear' ? b.x : b.y;
    const boxes: Rect[] = [];
    let cur = start + off;
    for (const it of items) {
      boxes.push(againstSide(b, side, it.w, it.d, cur + it.w / 2).aabb);
      cur += it.w;
    }
    return { boxes, face: faceOfSide(side) };
  };

  const emit = (side: Side, items: readonly KitItem[], boxes: readonly Rect[]): Placement[] => items.map((it, k) => ({
    type: it.type,
    aabb: { x: round4(boxes[k].x), y: round4(boxes[k].y), w: round4(boxes[k].w), h: round4(boxes[k].h) },
    face: faceOfSide(side),
    w: it.w,
    d: it.d,
    mandatory: it.mandatory,
  }));

  const result = (items: Placement[], wall: Side | null, oppositeWetWall: boolean): FitResult => {
    const missing = missingFrom(def, items);
    return { ok: missing.length === 0, items, missing, wall, triangle: triangleOf(items), oppositeWetWall };
  };

  if (def.mandatory.length === 0 && def.items(sideLength(base, wetSide), opts).length === 0) {
    return { ok: true, items: [], missing: [], wall: null, triangle: 0, oppositeWetWall: false };
  }

  // --- one run on the best wall the swings leave free -----------------------
  for (const side of candidates) {
    const along = sideLength(base, side);
    const items = def.items(along, opts).filter(i => i.w > 0);
    const run = items.reduce((s, i) => s + i.w, 0);
    if (run > along + 1e-6) continue;
    for (const off of offsets(along - run)) {
      const { boxes } = runFrom(side, items, off);
      if (!clear(boxes, boxes)) continue;
      let out = emit(side, items, boxes);
      const t = triangleOf(out);
      if (t > 0 && (t < TRIANGLE_MIN || t > TRIANGLE_MAX)) {
        // a straight minimum-length galley has a triangle of ~3.2 m: turning the fridge onto the return leg
        // opens it into the NKBA band without moving the sink or the range
        const lRun = withFridgeOnReturn(def, side, items, off, opts, base, lateral, wetSide, clear, runFrom, emit);
        if (lRun && lRun.triangle >= TRIANGLE_MIN && lRun.triangle <= TRIANGLE_MAX) out = lRun.items;
      }
      const island = islandFor(def, side, base, c, opts, out, clear);
      if (island) out = [...out, island];
      return result(out, side, side === oppSide(wetSide));
    }
  }

  // --- two-wall fallback: mandatory run on the wet wall, the last item turned onto a lateral wall ----
  {
    const along = sideLength(base, wetSide);
    const items = def.items(along, opts).filter(i => i.w > 0);
    const last = items[items.length - 1];
    const placed: Placement[] = [];
    const rest = [...items];
    if (items.length > 2 && last) {
      for (const ls of lateral) {
        if (sideLength(base, ls) < last.w + 0.1) continue;
        const c0 = (ls === 'front' || ls === 'rear' ? base.x : base.y) + last.w / 2;
        const far = (ls === 'front' || ls === 'rear' ? base.x + base.w : base.y + base.h) - last.w / 2;
        const order = wetSide === 'rear' || wetSide === 'right' ? [c0, c0 + 0.1, far, far - 0.1] : [far, far - 0.1, c0, c0 + 0.1];
        let done = false;
        for (const cAt of order) {
          const p = againstSide(base, ls, last.w, last.d, cAt);
          if (!clear([p.aabb])) continue;
          placed.push({ type: last.type, aabb: p.aabb, face: p.face, w: last.w, d: last.d, mandatory: last.mandatory });
          rest.pop();
          done = true;
          break;
        }
        if (done) break;
      }
    }
    // drop the optional tail until the remainder fits, then try any wall for it
    while (rest.length > 1 && rest.reduce((s, i) => s + i.w, 0) > along && !rest[rest.length - 1].mandatory) rest.pop();
    for (const side of candidates) {
      const alongS = sideLength(base, side);
      const runS = rest.reduce((s, i) => s + i.w, 0);
      if (runS > alongS + 1e-6) continue;
      for (const off of offsets(alongS - runS)) {
        const { boxes } = runFrom(side, rest, off);
        if (!clear(boxes, [...boxes, ...placed.map(p => p.aabb)])) continue;
        return result([...emit(side, rest, boxes), ...placed], side, side === oppSide(wetSide));
      }
    }
    // --- last resort: item by item, mandatory first ------------------------
    const out: Placement[] = [...placed];
    for (const it of rest) {
      let done = false;
      for (const side of candidates) {
        const alongS = sideLength(base, side);
        if (it.w > alongS) continue;
        for (const off of offsets(alongS - it.w)) {
          const { boxes, face } = runFrom(side, [it], off);
          if (!clear(boxes, [...boxes, ...out.map(p => p.aabb)])) continue;
          out.push({ type: it.type, aabb: boxes[0], face, w: it.w, d: it.d, mandatory: it.mandatory });
          done = true;
          break;
        }
        if (done) break;
      }
    }
    return result(out, out.length > 0 ? wetSide : null, false);
  }
}

/**
 * An island in front of the run where the room is deep enough to keep the working aisle on both sides
 * (ARC-20 / NKBA): counter 0.6 + aisle + island + 0.8 walk-round. The aisle widens to the ADA turning circle in an
 * accessible kitchen, and both numbers come from the rule set when one is supplied.
 */
function islandFor(
  def: KitDef, side: Side, base: Rect, c: KitClearances, opts: KitOpts, placed: readonly Placement[],
  clear: (boxes: readonly Rect[], extra?: readonly Rect[]) => boolean,
): Placement | null {
  if (!opts.big || opts.detail === 'low') return null;
  if (def.mandatory.indexOf('range') < 0) return null;
  const island = FURNITURE_CATALOG['kitchen-island'];
  const aisle = opts.accessible ? c.turningCircle : c.kitchenAisle;
  const along = sideLength(base, side);
  const depth = side === 'front' || side === 'rear' ? base.h : base.w;
  if (depth < COUNTER_D + aisle + island.d + 0.8 || along < island.w + 0.6) return null;
  const w = Math.min(island.w, along - 0.6);
  const p = offsetFrom(base, side, COUNTER_D + aisle, w, island.d, sideCentre(base, side));
  if (!clear([p.aabb], [p.aabb, ...placed.map(x => x.aabb)])) return null;
  return { type: 'kitchen-island', aabb: p.aabb, face: p.face, w, d: island.d, mandatory: false };
}

/** sink → range → fridge, straight-line legs (ARC-20 / NKBA); 0 unless all three are placed */
export function triangleOf(items: readonly Placement[]): number {
  const at = (t: FurnitureType): [number, number] | undefined => {
    const hit = items.find(i => i.type === t);
    return hit ? centreOf(hit.aabb) : undefined;
  };
  const sk = at('kitchen-sink');
  const rg = at('range');
  const fr = at('fridge');
  if (!sk || !rg || !fr) return 0;
  const leg = (a: [number, number], b: [number, number]): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
  return round4(leg(sk, rg) + leg(rg, fr) + leg(fr, sk));
}

/** Retry a kitchen run with the fridge on the return leg (L-shaped run), which widens the work triangle. */
function withFridgeOnReturn(
  def: KitDef, side: Side, items: readonly KitItem[], off: number, opts: KitOpts,
  base: Rect, lateral: Side[], wetSide: Side,
  clear: (boxes: readonly Rect[], extra?: readonly Rect[]) => boolean,
  runFrom: (s: Side, it: readonly KitItem[], o: number) => { boxes: Rect[]; face: KitFace },
  emit: (s: Side, it: readonly KitItem[], boxes: readonly Rect[]) => Placement[],
): { items: Placement[]; triangle: number } | null {
  const fridge = items.find(i => i.type === 'fridge');
  if (!fridge) return null;
  const rest = items.filter(i => i !== fridge);
  const along = sideLength(base, side);
  const run = rest.reduce((s, i) => s + i.w, 0);
  if (run > along + 1e-6) return null;
  for (const ls of lateral) {
    if (sideLength(base, ls) < fridge.w + 0.1) continue;
    const c0 = (ls === 'front' || ls === 'rear' ? base.x : base.y) + fridge.w / 2 + 0.02;
    const far = (ls === 'front' || ls === 'rear' ? base.x + base.w : base.y + base.h) - fridge.w / 2 - 0.02;
    const cAt = wetSide === 'rear' || wetSide === 'right' ? c0 : far;
    const p = againstSide(base, ls, fridge.w, fridge.d, cAt);
    if (!clear([p.aabb])) continue;
    for (const o2 of offsets(along - run)) {
      const { boxes } = runFrom(side, rest, o2);
      if (!clear(boxes, [...boxes, p.aabb])) continue;
      const out = [
        ...emit(side, rest, boxes),
        { type: fridge.type, aabb: p.aabb, face: p.face, w: fridge.w, d: fridge.d, mandatory: fridge.mandatory },
      ];
      return { items: out, triangle: triangleOf(out) };
    }
  }
  return null;
}
