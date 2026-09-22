/**
 * The 1-D packer (design §4.6). Four phases, no back-tracking search, no pairwise loops:
 *
 *   Phase 0  candidates = `catalogue.candidatesFor(strip)` filtered by `frontageAt(id, strip.netDepth) ≠ null`.
 *            That filter is THE reason "unit X has N m frontage, below the M m minimum at D m depth" cannot happen:
 *            a module the depth does not admit is never considered, so it can never be squeezed in.
 *   Phase 1  a multiset of n modules drawn by largest building-wide quota DEFICIT, ties broken by the seeded rng;
 *            the first/last slot of a bar end takes the corner/end variant of the same template. Repair swaps the
 *            widest module for a narrower one (never squeezes) until Σmin ≤ L, and inserts while Σmax < L.
 *   Phase 2  `allocate(L, ranges)` for the widths — it returns null rather than going below a minimum — then the
 *            interior boundaries snap to `grid.module`, and the column-line SUBSET is chosen so consecutive column
 *            spacing lies in [bay.min, bay.max].
 *   Phase 3  whatever is left is a DECLARED remnant, and only ever when it is narrower than the smallest admissible
 *            dwelling: 'A-flex' at 3 m or more, otherwise 'A-store', with deviation ARC-D02.
 *   Phase 4  module ports resolved to world XY through the slot boundary and its `mirrored` flag.
 */
import type { Region, Rect, Rng, RoomType, Side, TypologyId } from '../../../core/types.ts';
import type { Deviation } from '../../../core/rules/types.ts';
import type { FeasibilityOpts, Range } from '../program/types.ts';
import type { ModuleCatalogue, Port, UnitModule } from '../../../modules/types.ts';
import type { BayGrid } from '../../structure/presize.ts';
import type { SideWallSpec } from '../types-internal.ts';
import type { Slot, SlotKind, StripDef } from './types.ts';
import { round } from '../../../core/geometry.ts';
import { allocate } from '../../../modules/program-source.ts';
import { remnantModuleId } from '../../../modules/amenity-modules.ts';
import { narrowestUnitFrontage } from '../../../modules/catalogue.ts';
import { ivLen, rectFromAC, type BarFrame, type Interval } from '../bar-frame.ts';
import { slotIdFor } from './strips.ts';
import { resolvePorts } from './ports.ts';
import type { QuotaState } from './quota.ts';

const EPS = 1e-6;

export interface PackArgs {
  strip: StripDef;
  /** the free sub-interval of the strip this call fills (blockers already subtracted) */
  interval: Interval;
  frame: BarFrame;
  catalogue: ModuleCatalogue;
  grid: BayGrid;
  quota: QuotaState;
  rng: Rng;
  opts: FeasibilityOpts;
  typology: TypologyId;
  region: Region;
  /** wall spec per side of the slot boundary; start/end apply to the interval's own ends */
  lowSpec: SideWallSpec;
  highSpec: SideWallSpec;
  startWall: SideWallSpec;
  endWall: SideWallSpec;
  accessWall: SideWallSpec;
  partyWall: SideWallSpec;
  extWall: SideWallSpec;
  /** the interval touches the bar's start / end face */
  atStart: boolean;
  atEnd: boolean;
  targetCount?: number;
  coreId?: string;
  levels?: number;
  /**
   * A terrace of houses is a row of dwellings that all span the SAME storeys, so a direct-access strip asks for
   * modules with exactly `levels` levels and only falls back to fewer when the mix has none.
   */
  levelsExact?: boolean;
  storeySpan?: string[];
  stairRect?: Rect;
  /** running slot number within the strip, so ids are stable left to right */
  seq: { n: number };
}

export interface PackResult {
  slots: Slot[];
  deviations: Deviation[];
  /** along-bar boundaries of the packed slots, and whether each is a structural column line */
  boundaries: { at: number; column: boolean }[];
  remnantArea: number;
}

export function packStrip(a: PackArgs): PackResult {
  const { strip, interval, catalogue, grid, quota, rng, opts } = a;
  const L = ivLen(interval);
  const deviations: Deviation[] = [];
  if (L < 1.0) return { slots: [], deviations, boundaries: [], remnantArea: 0 };

  // ---- Phase 0: candidates ------------------------------------------------------------------
  const query = {
    netDepth: strip.netDepth,
    exteriorSides: strip.exteriorSides,
    levels: a.levels ?? 1,
    typology: a.typology,
    region: a.region,
  };
  const wantLevels = a.levels ?? 1;
  const admissible = (list: readonly UnitModule[]): UnitModule[] => {
    const ok = list.filter(m => catalogue.frontageAt(m.id, strip.netDepth, opts) !== null);
    if (!a.levelsExact) return ok;
    const exact = ok.filter(m => m.levels === wantLevels);
    return exact.length > 0 ? exact : ok;
  };
  const midPool = admissible(catalogue.candidatesFor({ ...query, atStart: false, atEnd: false }));
  const startPool = a.atStart
    ? admissible(catalogue.candidatesFor({ ...query, atStart: true, atEnd: false }))
    : midPool;
  const endPool = a.atEnd
    ? admissible(catalogue.candidatesFor({ ...query, atStart: false, atEnd: true }))
    : midPool;
  const anyPool = midPool.length > 0 ? midPool : startPool.length > 0 ? startPool : endPool;
  if (midPool.length === 0 && anyPool.length > 0) {
    // Nothing that suits a MID position is admissible at this depth, so the strip has to fall back on a variant that
    // wants more façades than it will get. Declared, because the module's own `needs` are then not met.
    deviations.push({
      severity: 'deviation', ruleId: 'ARC-D08', discipline: 'architecture',
      message: `strip ${strip.id} at ${round(strip.netDepth, 2)} m depth admits no mid-strip dwelling variant — ${anyPool[0].id} is used with fewer façades than it asks for`,
      observed: round(strip.netDepth, 2),
      resolution: { id: 'swap-module', note: 'end variant mid-strip' },
    });
  }
  if (anyPool.length === 0) {
    // not a dwelling strip: the depth admits no module at all. Declare it, do not squeeze one in.
    deviations.push({
      severity: 'deviation', ruleId: 'ARC-D07', discipline: 'architecture',
      message: `strip ${strip.id} is ${round(strip.netDepth, 2)} m deep, which admits no dwelling module — packed as shared floor area`,
      observed: round(strip.netDepth, 2),
      resolution: { id: 'swap-module', note: 'amenity slot' },
    });
    const slot = makeSlot(a, interval, remnantModuleId(L), 'amenity', L >= 3 ? 'flex' : 'storage', []);
    return { slots: [slot], deviations, boundaries: boundaryPair(interval, false, false), remnantArea: 0 };
  }

  const rangeOf = (m: UnitModule): Range => catalogue.frontageAt(m.id, strip.netDepth, opts)!;
  const targetOf = (m: UnitModule): number => {
    const r = rangeOf(m);
    const want = m.areaTarget / Math.max(1, m.levels) / Math.max(1, strip.netDepth);
    return Math.min(r.max, Math.max(r.min, want));
  };

  // ---- Phase 1: the multiset ----------------------------------------------------------------
  const pools = { midPool, startPool, endPool, anyPool };
  const picks = drawMultiset(a, pools, L, rangeOf, targetOf);
  if (picks.length === 0) {
    const r = round(L, 2);
    deviations.push({
      severity: 'deviation', ruleId: 'ARC-D02', discipline: 'architecture',
      message: `${r} m of frontage on ${strip.id} is narrower than the smallest admissible dwelling — declared as a ${L >= 3 ? 'flexible room' : 'store'}`,
      observed: r,
      limit: round(narrowestUnitFrontage(catalogue, anyPool, strip.netDepth, opts), 2),
      resolution: { id: 'none', note: 'remnant' },
    });
    const slot = makeSlot(a, interval, remnantModuleId(L), 'remnant', L >= 3 ? 'flex' : 'storage', []);
    return { slots: [slot], deviations, boundaries: boundaryPair(interval, false, false), remnantArea: round(L * strip.netDepth, 3) };
  }

  // ---- Phase 2: widths, grid snap, column lines ----------------------------------------------
  /*
   * A module's admissible frontage is a NET dimension — the clear width between the inside faces of its party walls,
   * exactly as `netDepth` is the clear depth. The packer allocates BOUNDARY widths (centreline to centreline, so the
   * slots tile the strip), so every range is widened by that slot's own wall allowance first. Allocating the net
   * range as if it were a boundary width is a quarter of a metre of silent error per slot.
   */
  const netRanges = picks.map(rangeOf);
  const alw = picks.map((_, i) => allowanceOf(a, i, picks.length));
  const ranges = netRanges.map((r, i) => ({ min: r.min + alw[i], max: r.max + alw[i] }));
  const sumMax = ranges.reduce((s, r) => s + r.max, 0);
  // never widen a module past its maximum: the surplus becomes a declared remnant instead
  const remnant = Math.max(0, L - sumMax);
  const packLen = L - remnant;
  const widths = allocate(packLen, picks.map((m, i) => ({
    min: ranges[i].min, target: targetOf(m) + alw[i], max: ranges[i].max,
  })));
  if (!widths) {
    // the repair loop guarantees Σmin ≤ packLen, so this is a solver bug rather than a geometry problem
    deviations.push({
      severity: 'violation', ruleId: 'ARC-D02', discipline: 'architecture',
      message: `packer could not allocate ${round(packLen, 2)} m over ${picks.length} modules on ${strip.id}`,
      observed: round(packLen, 2),
    });
    return { slots: [], deviations, boundaries: [], remnantArea: round(L * strip.netDepth, 3) };
  }

  // the end/corner variant goes in only once we know the slot really reaches the bar's end face: a declared remnant
  // takes that end, and a module whose program counts on three façades must not sit behind one
  if (remnant <= 0.45) {
    if (a.atStart) picks[0] = variantAt(picks[0], startPool, true) ?? picks[0];
    if (a.atEnd) picks[picks.length - 1] = variantAt(picks[picks.length - 1], endPool, true) ?? picks[picks.length - 1];
  }

  const bounds = snapBoundaries(interval.s, widths, ranges, grid.module);
  const columns = columnSubset(bounds, grid.bay);

  // ---- slots + Phase 4: ports ----------------------------------------------------------------
  const slots: Slot[] = [];
  for (let k = 0; k < picks.length; k++) {
    const m = picks[k];
    const iv: Interval = { s: bounds[k], e: bounds[k + 1] };
    const mirrored = k % 2 === 1 && m.mirrorable;
    const slot = makeSlot(a, iv, m.id, 'unit', undefined, [], {
      mirrored,
      first: k === 0,
      last: k === picks.length - 1,
      columnStart: columns.has(bounds[k]),
      columnEnd: columns.has(bounds[k + 1]),
      ports: m.ports,
    });
    slots.push(slot);
    quota.record(m.templateId);
  }

  // ---- Phase 3: the declared remnant ---------------------------------------------------------
  let remnantArea = 0;
  if (remnant > 0.45) {
    const iv: Interval = { s: bounds[bounds.length - 1], e: interval.e };
    const narrowest = narrowestUnitFrontage(catalogue, anyPool, strip.netDepth, opts);
    slots.push(makeSlot(a, iv, remnantModuleId(remnant), 'remnant', remnant >= 3 ? 'flex' : 'storage', [], {
      first: false, last: true, columnStart: columns.has(iv.s), columnEnd: true,
    }));
    remnantArea = round(remnant * strip.netDepth, 3);
    deviations.push({
      severity: 'info', ruleId: 'ARC-D02', discipline: 'architecture',
      message: `${round(remnant, 2)} m left over on ${strip.id} after every module reached its maximum frontage — declared as a ${remnant >= 3 ? 'flexible room' : 'store'}`,
      observed: round(remnant, 2),
      limit: round(narrowest, 2),
      resolution: { id: 'none', note: 'remnant' },
    });
  }

  const boundaryList = bounds.map(at => ({ at: round(at, 4), column: columns.has(at) }));
  if (remnant > 0.45) boundaryList.push({ at: round(interval.e, 4), column: true });
  return { slots, deviations, boundaries: boundaryList, remnantArea };
}

// ---------------------------------------------------------------------------------------------------------------
// Phase 1 — the multiset
// ---------------------------------------------------------------------------------------------------------------

interface Pools { midPool: UnitModule[]; startPool: UnitModule[]; endPool: UnitModule[]; anyPool: UnitModule[] }

function drawMultiset(
  a: PackArgs, pools: Pools, L: number, rangeOf: (m: UnitModule) => Range, targetOf: (m: UnitModule) => number,
): UnitModule[] {
  const { quota } = a;
  // how many bays fit, from the requested mix's weighted mean TARGET frontage at this depth
  const weightOf = (m: UnitModule): number => (quota.requested[m.templateId] ?? 0) + 1e-3;
  let wsum = 0;
  let fsum = 0;
  for (const m of pools.anyPool) { wsum += weightOf(m); fsum += weightOf(m) * targetOf(m); }
  const meanF = wsum > EPS ? fsum / wsum : 8;
  const narrowest = Math.min(...pools.anyPool.map(m => rangeOf(m).min));
  // The walls BETWEEN the slots belong to the strip, not to the modules: a module's admissible frontage is a net
  // dimension (like `netDepth`), so every candidate count has its own usable length.
  const usableFor = (n: number): number => L - wallsFor(a, n);
  const cap = Math.max(0, Math.floor((usableFor(1) + 1e-6) / Math.max(1.5, narrowest + a.partyWall.thickness)));
  const n0 = Math.min(a.targetCount ?? Math.max(1, Math.round(L / Math.max(2, meanF + a.partyWall.thickness))), cap);
  if (n0 <= 0) return [];

  /*
   * Try n − 1, n and n + 1 and keep the multiset with the best MIX contribution. One count is not enough: a 22.5 m
   * bay wants either three narrow dwellings or two wide ones, and the repair loop on its own always converges on the
   * narrowest module in the pool — which is how a 36 % / 27 % one-bed / two-bed request came out 71 % / 18 %.
   */
  let best: UnitModule[] | null = null;
  let bestScore = Infinity;
  let bestFill = -Infinity;
  for (const n of [n0, n0 - 1, n0 + 1]) {
    if (n <= 0 || n > cap) continue;
    const picks = drawFor(a, pools, usableFor(n), n, rangeOf);
    if (picks.length === 0) continue;
    const usable = usableFor(picks.length);
    const sumMax = picks.reduce((s, m) => s + rangeOf(m).max, 0);
    // HARD first: a multiset that cannot reach the end of the strip leaves a remnant, and a remnant is worse for the
    // plan than any mix deviation. Only among the ones that can fill it does the mix decide.
    const fillable = sumMax >= usable - 0.5;
    const score = mixScore(quota, picks)
      + (Math.abs(usable - picks.reduce((x, m) => x + targetOf(m), 0)) / Math.max(1, usable)) * 0.25;
    if (fillable) {
      if (bestFill < 0 || score < bestScore - 1e-9) { bestScore = score; best = picks; bestFill = 0; }
    } else if (bestFill < 0 && sumMax > bestFill) {
      bestFill = -1;
      if (!best || sumMax > best.reduce((x, m) => x + rangeOf(m).max, 0)) best = picks;
    }
  }
  return best ?? [];
}

/** Total variation the ledger WOULD be at if these picks were recorded — the multiset's mix cost */
function mixScore(quota: QuotaState, picks: readonly UnitModule[]): number {
  const delivered: Record<string, number> = { ...quota.delivered };
  for (const m of picks) delivered[m.templateId] = (delivered[m.templateId] ?? 0) + 1;
  const total = quota.total + picks.length;
  if (total <= 0) return 0;
  const ids = new Set([...Object.keys(quota.requested), ...Object.keys(delivered)]);
  let sum = 0;
  for (const id of ids) sum += Math.abs((delivered[id] ?? 0) / total - (quota.requested[id] ?? 0));
  return sum / 2;
}

/** The wall length a strip of `n` slots spends on its own party walls and its two end walls */
function wallsFor(a: PackArgs, n: number): number {
  const start = a.atStart ? a.extWall : a.startWall;
  const end = a.atEnd ? a.extWall : a.endWall;
  return start.thickness / 2 + end.thickness / 2 + Math.max(0, n - 1) * a.partyWall.thickness;
}

/** One multiset of exactly `n` modules, drawn by deficit and repaired so Σ NET min ≤ usable ≤ Σ NET max */
function drawFor(
  a: PackArgs, pools: Pools, L: number, n: number, rangeOf: (m: UnitModule) => Range,
): UnitModule[] {
  const { quota, rng } = a;
  const midPool = pools.midPool.length > 0 ? pools.midPool : pools.anyPool;
  const poolFor = (i: number, count: number): UnitModule[] => {
    if (i === 0 && a.atStart && pools.startPool.length > 0) return pools.startPool;
    if (i === count - 1 && a.atEnd && pools.endPool.length > 0) return pools.endPool;
    return midPool;
  };

  // draw against a PROVISIONAL ledger so each pick sees the deficit the previous one moved, then roll back: the
  // real records land in Phase 2, once the widths are known and the repair loop has settled
  const before = quota.snapshot();
  const picks: UnitModule[] = [];
  for (let i = 0; i < n; i++) {
    const m = drawOne(poolFor(i, n), quota, rng);
    if (!m) { quota.restore(before); return []; }
    picks.push(m);
    quota.record(m.templateId);
  }
  quota.restore(before);

  // repair: never squeeze. Swap the widest module for the best narrower one, and only then drop a bay.
  let guard = 0;
  while (picks.length > 0 && guard++ < picks.length * 3 + 6) {
    // dropping a slot gives its party wall back to the usable length
    const usable = L + (n - picks.length) * a.partyWall.thickness;
    const sumMin = picks.reduce((s, m) => s + rangeOf(m).min, 0);
    if (sumMin <= usable + 1e-6) break;
    let wi = 0;
    for (let i = 1; i < picks.length; i++) if (rangeOf(picks[i]).min > rangeOf(picks[wi]).min) wi = i;
    const budget = usable - (sumMin - rangeOf(picks[wi]).min);
    // always a MID module: the end/corner variant is promoted later, once we know the slot reaches the end face
    const swap = bestUnder(midPool, budget, rangeOf, quota);
    if (swap && rangeOf(swap).min < rangeOf(picks[wi]).min - 1e-6) picks[wi] = swap;
    else picks.splice(wi, 1);
  }
  // fill: while the maxima cannot reach L, add the highest-deficit module that still fits once everyone shrinks
  // toward their minima. The added module is a MID module — an end variant is promoted later, once we know the slot
  // really reaches the bar's end face.
  guard = 0;
  while (guard++ < 16) {
    // adding a slot costs one more party wall
    const usable = L + (n - picks.length - 1) * a.partyWall.thickness;
    const sumMin = picks.reduce((s, m) => s + rangeOf(m).min, 0);
    const sumMax = picks.reduce((s, m) => s + rangeOf(m).max, 0);
    if (sumMax >= usable - 0.05) break;
    const add = bestFitting(midPool, usable - sumMin, rangeOf, quota);
    if (!add || sumMin + rangeOf(add).min > usable + 1e-6) break;
    picks.push(add);
  }
  return picks;
}

function drawOne(pool: readonly UnitModule[], quota: QuotaState, rng: Rng): UnitModule | null {
  if (pool.length === 0) return null;
  const byTemplate = new Map<string, UnitModule[]>();
  for (const m of pool) {
    const list = byTemplate.get(m.templateId);
    if (list) list.push(m);
    else byTemplate.set(m.templateId, [m]);
  }
  const ids = [...byTemplate.keys()].sort();
  const ordered = quota.order(ids);
  const best = quota.deficit(ordered[0]);
  const tied = ordered.filter(id => Math.abs(quota.deficit(id) - best) < 1e-9);
  const templateId = tied.length === 1 ? tied[0] : rng.weighted(tied, tied.map(() => 1));
  const variants = byTemplate.get(templateId)!;
  // mid-strip prefers the plainest variant; the id sort makes that deterministic
  const order: Record<string, number> = { single: 0, dual: 1, corner: 2, end: 3, cluster: 4, 'dual-key': 5 };
  return [...variants].sort((p, q) => (order[p.variant] ?? 9) - (order[q.variant] ?? 9) || (p.id < q.id ? -1 : 1))[0];
}

/** The same template's end/corner variant, for the first and last slot of a bar */
function variantAt(m: UnitModule, pool: readonly UnitModule[], wantEnd: boolean): UnitModule | null {
  const same = pool.filter(x => x.templateId === m.templateId);
  const rank = (x: UnitModule): number => {
    if (wantEnd && x.variant === 'end') return 0;
    if (wantEnd && x.variant === 'corner') return 1;
    if (x.variant === 'dual') return 2;
    return 3;
  };
  const best = [...same].sort((p, q) => rank(p) - rank(q) || (p.id < q.id ? -1 : 1))[0];
  return best ?? null;
}

function bestUnder(
  pool: readonly UnitModule[], budget: number, rangeOf: (m: UnitModule) => Range, quota: QuotaState,
): UnitModule | null {
  const fit = pool.filter(m => rangeOf(m).min <= budget + 1e-6);
  if (fit.length === 0) return null;
  return [...fit].sort((p, q) =>
    quota.deficit(q.templateId) - quota.deficit(p.templateId)
    || rangeOf(q).min - rangeOf(p).min
    || (p.id < q.id ? -1 : 1))[0];
}

function bestFitting(
  pool: readonly UnitModule[], residual: number, rangeOf: (m: UnitModule) => Range, quota: QuotaState,
): UnitModule | null {
  const fit = pool.filter(m => rangeOf(m).min <= residual + 1e-6);
  if (fit.length === 0) return null;
  return [...fit].sort((p, q) =>
    quota.deficit(q.templateId) - quota.deficit(p.templateId)
    || rangeOf(q).min - rangeOf(p).min
    || (p.id < q.id ? -1 : 1))[0];
}

// ---------------------------------------------------------------------------------------------------------------
// Phase 2 — grid snap and the column-line subset
// ---------------------------------------------------------------------------------------------------------------

/**
 * Cumulative boundaries, with every INTERIOR one snapped to the nearest multiple of the planning module subject to
 * both neighbours staying inside their admissible frontage range. Left to right, backtracking at most two
 * boundaries — O(n), no search.
 */
export function snapBoundaries(start: number, widths: readonly number[], ranges: readonly Range[], module: number): number[] {
  const out: number[] = [start];
  for (const w of widths) out.push(out[out.length - 1] + w);
  if (module <= EPS) return out.map(v => round(v, 4));
  // relative to the interval start: the envelope and the blockers fix the two ends, so what the planning module can
  // actually govern is the BAYS between them — which is what the structural handshake needs from us
  for (let i = 1; i < out.length - 1; i++) {
    const snapped = start + Math.round((out[i] - start) / module) * module;
    const left = snapped - out[i - 1];
    const right = out[i + 1] - snapped;
    const okLeft = left >= ranges[i - 1].min - 1e-6 && left <= ranges[i - 1].max + 1e-6;
    const okRight = right >= ranges[i].min - 1e-6 && right <= ranges[i].max + 1e-6;
    if (okLeft && okRight) { out[i] = snapped; continue; }
    // try one step either way, then the half-module, before giving up on this boundary
    for (const alt of [snapped - module, snapped + module, start + Math.round((out[i] - start) / (module / 2)) * (module / 2)]) {
      const l = alt - out[i - 1];
      const r = out[i + 1] - alt;
      if (l >= ranges[i - 1].min - 1e-6 && l <= ranges[i - 1].max + 1e-6
        && r >= ranges[i].min - 1e-6 && r <= ranges[i].max + 1e-6) {
        out[i] = alt;
        break;
      }
    }
  }
  return out.map(v => round(v, 4));
}

/**
 * Not every party wall is a column line. Keep the ends, then keep a boundary as LATE as possible while the span from
 * the previous column stays within [bay.min, bay.max] — the subset structure needs, nothing more.
 */
export function columnSubset(bounds: readonly number[], bay: { min: number; max: number }): Set<number> {
  const keep = new Set<number>();
  if (bounds.length === 0) return keep;
  keep.add(bounds[0]);
  let last = bounds[0];
  for (let i = 1; i < bounds.length - 1; i++) {
    const d = bounds[i] - last;
    const dNext = bounds[i + 1] - last;
    if (d >= bay.min - 1e-6 && dNext > bay.max + 1e-6) {
      keep.add(bounds[i]);
      last = bounds[i];
    }
  }
  keep.add(bounds[bounds.length - 1]);
  return keep;
}

// ---------------------------------------------------------------------------------------------------------------
// Slot construction and Phase 4 — ports
// ---------------------------------------------------------------------------------------------------------------

interface SlotOpts {
  storeySpan?: string[];
  mirrored?: boolean;
  first?: boolean;
  last?: boolean;
  columnStart?: boolean;
  columnEnd?: boolean;
  ports?: readonly Port[];
}

function makeSlot(
  a: PackArgs, iv: Interval, moduleId: string, kind: SlotKind, roomType: RoomType | undefined,
  deviations: Deviation[], o: SlotOpts = {},
): Slot {
  const { frame, strip } = a;
  const boundary = rectFromAC(frame, iv.s, iv.e, strip.across.s, strip.across.e);
  const sides = {} as Record<Side, SideWallSpec>;
  sides[frame.lowSide] = a.lowSpec;
  sides[frame.highSide] = a.highSpec;
  sides[frame.startSide] = o.first ? (a.atStart ? a.extWall : a.startWall) : a.partyWall;
  sides[frame.endSide] = o.last ? (a.atEnd ? a.extWall : a.endWall) : a.partyWall;
  if (a.accessWall && (strip.accessSide === frame.startSide || strip.accessSide === frame.endSide)) {
    sides[strip.accessSide] = a.accessWall;
  }
  const exteriorSides = [...strip.exteriorSides];
  if (o.first && a.atStart && !exteriorSides.includes(frame.startSide)) exteriorSides.push(frame.startSide);
  if (o.last && a.atEnd && !exteriorSides.includes(frame.endSide)) exteriorSides.push(frame.endSide);

  const slot: Slot = {
    id: slotIdFor(strip.id, a.seq.n++),
    stripId: strip.id,
    kind,
    moduleId,
    mirrored: o.mirrored ?? false,
    boundary,
    accessSide: strip.accessSide,
    exteriorSides,
    sides,
    barId: strip.barId,
    coreId: a.coreId,
    legId: strip.legId,
    storeySpan: o.storeySpan ?? a.storeySpan,
    stairRect: a.stairRect,
    ports: [],
    partyLines: [
      { at: round(iv.s, 4), column: o.columnStart ?? false },
      { at: round(iv.e, 4), column: o.columnEnd ?? false },
    ],
    roomType,
    deviations: deviations.length > 0 ? deviations : undefined,
  };
  slot.ports = resolvePorts(o.ports ?? [], slot);
  return slot;
}

function boundaryPair(iv: Interval, colStart: boolean, colEnd: boolean): { at: number; column: boolean }[] {
  return [{ at: round(iv.s, 4), column: colStart }, { at: round(iv.e, 4), column: colEnd }];
}

/**
 * Half of each of the two walls that bound a slot ALONG the strip: party walls between neighbours, and the strip's
 * own start/end wall (exterior at a bar end) at the two ends.
 */
function allowanceOf(a: PackArgs, i: number, n: number): number {
  const first = i === 0 ? (a.atStart ? a.extWall : a.startWall) : a.partyWall;
  const last = i === n - 1 ? (a.atEnd ? a.extWall : a.endWall) : a.partyWall;
  return first.thickness / 2 + last.thickness / 2;
}

/** The NET frontage of a slot: the boundary width less half of each wall bounding it along the strip. */
export function netFrontageOf(slot: Slot): number {
  const horizontal = slot.accessSide === 'front' || slot.accessSide === 'rear';
  const gross = horizontal ? slot.boundary.w : slot.boundary.h;
  const ends: Side[] = horizontal ? ['left', 'right'] : ['front', 'rear'];
  const half = ends.reduce((acc, side) => acc + (slot.sides[side]?.thickness ?? 0.25) / 2, 0);
  return round(gross - half, 4);
}

/** Every slot of a strip must sit inside the module's admissible frontage at that strip's net depth. */
export function fitsStrip(
  slot: Slot, strip: StripDef, catalogue: ModuleCatalogue, opts: FeasibilityOpts,
): { ok: boolean; frontage: number; range: Range | null } {
  const frontage = netFrontageOf(slot);
  const range = catalogue.frontageAt(slot.moduleId, strip.netDepth, opts);
  if (!range) return { ok: false, frontage, range: null };
  return { ok: frontage >= range.min - 0.03 && frontage <= range.max + 0.03, frontage, range };
}
