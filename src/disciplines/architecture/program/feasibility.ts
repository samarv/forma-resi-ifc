/**
 * Feasibility: plan shapes, the one size allocator, and the witness gate.
 *
 * A dwelling plan is a three-level guillotine subdivision of the unit's net rect in the local frame
 * (u along the frontage from the access side, v inward):
 *
 *   spine   — an optional full-depth column at u = 0 holding the entry, the stair and small service
 *             rooms (the terrace / own-door case)
 *   bands   — slabs across the remaining frontage, in v order from the access side
 *   columns — slices of a band along u, each a STACK of rooms subdividing the band's depth
 *
 * `planShapesFor(g, o)` derives the candidate shapes for a program graph deterministically — the plan
 * TYPE (zoned / house / through / cluster / dual-key) plus a preference-ordered list of variants that
 * differ only in how much stacking they use. `feasibleShape(shape, F, D)` then decides whether a
 * concrete (frontage, depth) admits the shape and, if it does, returns the per-node width bounds that
 * make up the `Feasibility` witness. Nothing downstream may lay out a unit without one.
 *
 * `allocate()` is the single size distributor used for band depths, column widths, stack depths and
 * (by the placer) slot frontages. It returns `null` rather than squeezing: the caller must change the
 * shape, never the minima. `fill()` is the separate, explicitly-lossy variant the solver uses when it
 * has been handed a rect outside the admissible region (the v1 organiser does that today); every use
 * of it produces a `Deviation`, and a `warning` only when a room ends more than 0.30 m below its kit.
 */
import type { Rect, Region, RoomType, UnitTemplateId, Zone } from '../../../core/types.ts';
import type {
  BandSpec, Feasibility, FeasibilityOpts, FeasibilityResult, Infeasible, NodeRef, PlanShape,
  PlanShapeType, ProgramGraph, ProgramNode, Range,
} from './types.ts';
import { nodesAtLevel, programFor } from './programs.ts';

const E = 1e-6;
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const round2 = (v: number): number => Math.round(v * 100) / 100;
/** a minimum rounds UP to the 5 mm grid and a maximum DOWN, so a published range is always honourable */
const ceil5 = (v: number): number => Math.ceil(v * 200 - 1e-9) / 200;
const floor5 = (v: number): number => Math.floor(v * 200 + 1e-9) / 200;
/** every boundary lands on a 5 mm grid so reruns are byte-identical */
const QUANTUM = 0.005;

// ---------------------------------------------------------------------------------------------------
// 1. The allocator
// ---------------------------------------------------------------------------------------------------

export interface SizeItem { min: number; target: number; max: number }

/**
 * Distribute `total` over `items`, never below `min`, preferring `target`, and clamping at `max` while
 * anything is still unsaturated. Returns `null` when `Σ min > total` — the caller must pick another
 * shape, not squeeze. Deterministic and independent of item order.
 */
export function allocate(total: number, items: readonly SizeItem[]): number[] | null {
  const nI = items.length;
  if (nI === 0) return total <= E ? [] : null;
  const mins = items.map(i => Math.max(0, i.min));
  if (sum(mins) > total + E) return null;
  const out = [...mins];
  const maxs = items.map((i, k) => Math.max(mins[k], i.max));
  const weights = items.map((i, k) => Math.max(0, Math.min(maxs[k], i.target) - mins[k]));
  const wSum = sum(weights);
  const w = wSum > E ? weights : items.map(() => 1);
  let residual = total - sum(out);
  for (let pass = 0; pass < nI + 1 && residual > E; pass++) {
    const open: number[] = [];
    for (let k = 0; k < nI; k++) if (out[k] < maxs[k] - E) open.push(k);
    if (open.length === 0) break;
    const openW = sum(open.map(k => w[k]));
    const share = openW > E ? open.map(k => (residual * w[k]) / openW) : open.map(() => residual / open.length);
    let used = 0;
    for (let j = 0; j < open.length; j++) {
      const k = open[j];
      const give = Math.min(share[j], maxs[k] - out[k]);
      out[k] += give;
      used += give;
    }
    if (used <= E) break;
    residual -= used;
  }
  if (residual > E) {
    // every item saturated: park the remainder on the item that wants it most (largest target)
    let best = 0;
    for (let k = 1; k < nI; k++) if (items[k].target > items[best].target) best = k;
    out[best] += residual;
    residual = 0;
  }
  return snapToTotal(out, total);
}

/** Snap each size to the 5 mm quantum and put the rounding error on the largest item. */
function snapToTotal(sizes: number[], total: number): number[] {
  const out = sizes.map(v => Math.round(v / QUANTUM) * QUANTUM);
  let err = total - sum(out);
  if (Math.abs(err) > 1e-9) {
    let best = 0;
    for (let k = 1; k < out.length; k++) if (out[k] > out[best]) best = k;
    out[best] += err;
    err = 0;
  }
  return out.map(v => Math.round(v * 1e6) / 1e6);
}

export interface FillResult {
  sizes: number[];
  /** indices squeezed below their `min`, with the shortfall in metres */
  squeezed: { index: number; by: number }[];
  /** indices pushed above their `max`, with the excess in metres */
  overflowed: { index: number; by: number }[];
}

/**
 * The lossy allocator: always tiles `total` exactly, even when `Σ min > total` (proportional squeeze,
 * protecting the largest minima last) or `Σ max < total` (proportional stretch). Only the solver's
 * fallback path uses it, and every squeeze/stretch it reports becomes a `Deviation`.
 */
export function fill(total: number, items: readonly SizeItem[]): FillResult {
  const nI = items.length;
  if (nI === 0) return { sizes: [], squeezed: [], overflowed: [] };
  const mins = items.map(i => Math.max(0, i.min));
  const minSum = sum(mins);
  if (minSum > total + E) {
    const f = total / Math.max(minSum, E);
    const sizes = snapToTotal(mins.map(v => v * f), total);
    return {
      sizes,
      squeezed: sizes.map((v, k) => ({ index: k, by: mins[k] - v })).filter(x => x.by > 0.005),
      overflowed: [],
    };
  }
  const sizes = allocate(total, items) ?? mins;
  const overflowed = sizes
    .map((v, k) => ({ index: k, by: v - Math.max(mins[k], items[k].max) }))
    .filter(x => x.by > 0.005);
  return { sizes, squeezed: [], overflowed };
}

// ---------------------------------------------------------------------------------------------------
// 2. Plan shapes
// ---------------------------------------------------------------------------------------------------

const WET_TYPES = new Set<RoomType>(['kitchen', 'living-kitchen', 'bathroom', 'ensuite', 'powder', 'wc', 'laundry', 'utility', 'shared-kitchen']);
export const HOUSE_TEMPLATES = new Set<UnitTemplateId>(['maisonette-2s', 'townhouse-2s', 'townhouse-3s', 'ranch-3b', 'colonial-4b', 'adu-1b']);

/** Which node refs belong to the lock-off studio of a dual-key plan (ARC-25). */
export const STUDIO_REFS: readonly NodeRef[] = ['livingkitchen2', 'ensuite2'];

interface Build {
  type: PlanShapeType;
  spine: NodeRef[];
  bands: NodeRef[][][];
  /** a note describing the variant, for deviations */
  variant: string;
  /** bands run along u and are sliced in v (the cluster's corridor down the middle) */
  transpose?: boolean;
}

const byRefMap = (nodes: readonly ProgramNode[]): Map<NodeRef, ProgramNode> => new Map(nodes.map(x => [x.ref, x]));

/** Zone rank used to order the daylit band: public rooms toward the entry side, bedrooms away. */
const ZONE_RANK: Record<Zone, number> = { public: 0, circulation: 1, service: 2, private: 3, outdoor: 4 };

function daylitOrder(nodes: ProgramNode[]): ProgramNode[] {
  return [...nodes].sort((a, b) =>
    ZONE_RANK[a.zone] - ZONE_RANK[b.zone]
    || b.area.target - a.area.target
    || (a.ref < b.ref ? -1 : 1));
}

/** Service columns: the wet cluster first (so they share one wall), then the dry rooms, then the entry. */
function serviceOrder(nodes: ProgramNode[]): ProgramNode[] {
  const rank = (x: ProgramNode): number => (x.wet ? 0 : x.type === 'entry' ? 2 : 1);
  return [...nodes].sort((a, b) =>
    rank(a) - rank(b) || b.area.target - a.area.target || (a.ref < b.ref ? -1 : 1));
}

/**
 * Move the `k` smallest stackable nodes out of their own column and into the stack of the column with
 * the most depth headroom, so a short frontage does not have to carry a column per broom cupboard.
 */
function applyStacking(cols: NodeRef[][], by: Map<NodeRef, ProgramNode>, k: number): { cols: NodeRef[][]; stacked: NodeRef[] } {
  let out = cols.map(c => [...c]);
  const stacked: NodeRef[] = [];
  for (let i = 0; i < k; i++) {
    const singles = out
      .map((c, idx) => ({ idx, ref: c[0], node: by.get(c[0]) }))
      .filter(x => x.node !== undefined && out[x.idx].length === 1 && x.node.stackable);
    if (singles.length === 0) break;
    singles.sort((a, b) => (a.node as ProgramNode).area.target - (b.node as ProgramNode).area.target
      || ((a.ref as string) < (b.ref as string) ? -1 : 1));
    const move = singles[0];
    const hosts = out
      .map((c, idx) => ({ idx, head: sum(c.map(r => by.get(r)?.maxDepth ?? 0)) - sum(c.map(r => by.get(r)?.minDepth ?? 0)) }))
      .filter(x => x.idx !== move.idx && out[x.idx].length > 0);
    if (hosts.length === 0) break;
    hosts.sort((a, b) => b.head - a.head || a.idx - b.idx);
    out[hosts[0].idx].push(move.ref);
    stacked.push(move.ref);
    out = out.filter((_, idx) => idx !== move.idx);
  }
  return { cols: out, stacked };
}

/**
 * Order the service band so each column sits under the daylit column it serves: every column's desired
 * position is the mean position of its adjacency partners in the daylit band, and the wet cluster moves
 * as one block so it keeps a single wet wall (XD-01).
 */
function alignColumns(band0: NodeRef[][], band1: NodeRef[][], g: ProgramGraph, by: Map<NodeRef, ProgramNode>): NodeRef[][] {
  const areaOf = (c: NodeRef[]): number => sum(c.map(r => by.get(r)?.area.target ?? 1));
  const total1 = Math.max(sum(band1.map(areaOf)), E);
  const centre = new Map<NodeRef, number>();
  let acc = 0;
  for (const c of band1) {
    const w = areaOf(c) / total1;
    for (const r of c) centre.set(r, acc + w / 2);
    acc += w;
  }
  const partnersOf = (col: NodeRef[]): number[] => {
    const out: number[] = [];
    for (const rule of g.rules) {
      if (rule.kind === 'not-adjacent' || rule.kind === 'no-door') continue;
      for (const [a, b] of [[rule.a, rule.b], [rule.b, rule.a]]) {
        if (!col.includes(a as NodeRef)) continue;
        const c = centre.get(b as NodeRef);
        if (c !== undefined) out.push(c);
      }
    }
    return out;
  };
  const scored = band0.map((col, idx) => {
    const p = partnersOf(col);
    return { col, idx, want: p.length > 0 ? sum(p) / p.length : 0.5, wet: col.some(r => by.get(r)?.wet === true) };
  });
  scored.sort((a, b) => a.want - b.want || a.idx - b.idx);
  const wet = scored.filter(x => x.wet);
  if (wet.length === 0 || wet.length === scored.length) return scored.map(x => x.col);
  const dry = scored.filter(x => !x.wet);
  const wetWant = sum(wet.map(x => x.want)) / wet.length;
  const out: NodeRef[][] = [];
  let placed = false;
  for (const d of dry) {
    if (!placed && d.want > wetWant) { out.push(...wet.map(x => x.col)); placed = true; }
    out.push(d.col);
  }
  if (!placed) out.push(...wet.map(x => x.col));
  return out;
}

function zonedBuilds(g: ProgramGraph, level: number): Build[] {
  const nodes = nodesAtLevel(g, level);
  const by = byRefMap(nodes);
  const hall = nodes.find(x => x.type === 'hall');
  const dayl = daylitOrder(nodes.filter(x => x.band === 'daylit'));
  const serv = nodes.filter(x => x.band === 'service');
  const circ = nodes.filter(x => x.band === 'circulation' && x.type !== 'hall');
  let band1: NodeRef[][] = dayl.map(x => [x.ref]);
  if (hall) {
    const firstPrivate = dayl.findIndex(x => x.zone === 'private');
    const at = firstPrivate >= 0 ? firstPrivate : Math.max(0, dayl.length - 1);
    if (band1.length === 0) band1 = [[hall.ref]];
    else band1[at] = [hall.ref, ...band1[at]];
  }
  const band0base = [...serviceOrder(serv), ...circ].map(x => [x.ref]);
  /**
   * With no hall to open off, the threshold itself is the circulation, so it goes next to the wet
   * block: the bathroom then opens off it (ARC-19) through a lateral wall instead of through its own
   * wet wall, which is what used to push the fixture run onto the opposite side of the room.
   */
  const hubRef = hall ? undefined : (nodes.find(x => x.type === 'entry') ?? nodes.find(x => x.type === 'stair'))?.ref;
  const hubAfterWet = (cols: NodeRef[][]): NodeRef[][] => {
    if (!hubRef) return cols;
    const at = cols.findIndex(c => c.includes(hubRef));
    if (at < 0) return cols;
    const hub = cols[at];
    const rest = cols.filter((_, i) => i !== at);
    let last = -1;
    rest.forEach((c, i) => { if (c.some(r => by.get(r)?.wet === true)) last = i; });
    if (last < 0) return cols;
    // and the wet room the rules want a door to goes at the hub end of the block
    const wants = new Set<NodeRef>();
    for (const rule of g.rules) {
      if (rule.kind !== 'door') continue;
      if (rule.a === hubRef) wants.add(rule.b as NodeRef);
      if (rule.b === hubRef) wants.add(rule.a as NodeRef);
    }
    const head = rest.slice(0, last + 1);
    const served = head.findIndex(c => c.some(r => wants.has(r)));
    const ordered = served >= 0 && served < head.length - 1
      ? [...head.filter((_, i) => i !== served), head[served]]
      : head;
    return [...ordered, hub, ...rest.slice(last + 1)];
  };
  const out: Build[] = [];
  const maxK = Math.min(4, band0base.filter(c => by.get(c[0])?.stackable === true).length);
  for (let k = 0; k <= maxK; k++) {
    const s0 = applyStacking(band0base, by, k);
    const band0 = hubAfterWet(alignColumns(s0.cols, band1, g, by));
    const bands = band0.length > 0 ? [band0, band1] : [band1];
    if (band1.length === 0) continue;
    out.push({ type: 'zoned', spine: [], bands, variant: `zoned/stack${k}` });
  }
  return out;
}

function throughBuilds(g: ProgramGraph, level: number): Build[] {
  const nodes = nodesAtLevel(g, level);
  const by = byRefMap(nodes);
  const entry = nodes.find(x => x.type === 'entry');
  const hall = nodes.find(x => x.type === 'hall');
  const strip: NodeRef[][] = [];
  if (entry) strip.push([entry.ref]);
  if (hall) strip.push([hall.ref]);
  const dayl = daylitOrder(nodes.filter(x => x.band === 'daylit'));
  const serv = nodes.filter(x => x.band === 'service');
  const circ = nodes.filter(x => x.band === 'circulation' && x.type !== 'hall' && x.type !== 'entry');
  const out: Build[] = [];
  if (dayl.length === 0 || strip.length === 0) return out;
  for (const deep of [false, true]) {
    let ends: NodeRef[][];
    if (!deep || dayl.length < 3) {
      ends = dayl.map(x => [x.ref]);
    } else {
      // two end columns, each a v-stack: public rooms at one end, private at the other
      // the two ends partition the daylit rooms: public at one end, private at the other, and when a
      // level is all one zone (the bedroom floor of a house) it splits in half
      const pub = dayl.filter(x => x.zone !== 'private');
      const priv = dayl.filter(x => x.zone === 'private');
      const half = (xs: ProgramNode[]): [ProgramNode[], ProgramNode[]] =>
        [xs.slice(0, Math.ceil(xs.length / 2)), xs.slice(Math.ceil(xs.length / 2))];
      const [lo, hi] = pub.length === 0 ? half(priv) : priv.length === 0 ? half(pub) : [pub, priv];
      // deepest room in the private stack = farthest from the front door: the principal bedroom
      // (ARC-19, Alexander APL #127 "Intimacy Gradient")
      ends = [lo.map(x => x.ref), [...hi].reverse().map(x => x.ref)];
      if (ends[1].length === 0) ends = [ends[0]];
    }
    const mid0 = [...serviceOrder(serv), ...circ].map(x => [x.ref]);
    const maxK = Math.min(4, mid0.filter(c => by.get(c[0])?.stackable === true).length);
    for (let k = 0; k <= maxK; k++) {
      const mid = applyStacking(mid0, by, k).cols;
      const cols = ends.length >= 2
        ? [ends[0], ...mid, ...ends.slice(1)]
        : [...ends, ...mid];
      out.push({
        type: 'through',
        spine: [],
        bands: [strip, cols].filter(b => b.length > 0),
        variant: `through/${deep ? 'deep' : 'flat'}/stack${k}`,
      });
    }
  }
  return out;
}

function houseBuilds(g: ProgramGraph, level: number): Build[] {
  const nodes = nodesAtLevel(g, level);
  const by = byRefMap(nodes);
  const circ = nodes.filter(x => x.band === 'circulation');
  const servAll = nodes.filter(x => x.band === 'service');
  // the garage is always the band on the access side: its door is in the access wall
  const garage = servAll.filter(x => x.type === 'garage');
  const serv = servAll.filter(x => x.type !== 'garage');
  const hosts = [...garage, ...daylitOrder(nodes.filter(x => x.band === 'daylit'))];
  if (hosts.length === 0) return [];
  // circulation first (entry at v = 0 so the front door has a room to open into), then the narrowest
  // service rooms, in width order — a variant per spine size
  // the threshold comes first so the front door has a room to open into at v = 0, then the stair, so
  // its slot is the same on every level (ARC-22), then the rest of the circulation
  const circRank = (x: ProgramNode): number =>
    (x.type === 'entry' ? 0 : x.type === 'hall' ? 1 : x.type === 'corridor' ? 2 : 3);
  const spineOrder = [...circ].sort((a, b) => circRank(a) - circRank(b) || (a.ref < b.ref ? -1 : 1));
  const spineExtra = [...serv].sort((a, b) => a.minWidth - b.minWidth || (a.ref < b.ref ? -1 : 1));
  const out: Build[] = [];
  // a bounded sweep: the band counts that change the plan meaningfully, and at most six spine sizes —
  // the whole point of a variant list is to be searched exhaustively, so it has to stay small
  const bandCounts = [...new Set([hosts.length, Math.max(1, hosts.length - 1), Math.max(1, Math.ceil(hosts.length / 2)), 1])];
  const spineSizes = spineExtra.length <= 5
    ? Array.from({ length: spineExtra.length + 1 }, (_, i) => spineExtra.length - i)
    : [...new Set([0, 1, 2, 3, 4, 5].map(i => Math.round((spineExtra.length * (5 - i)) / 5)))];
  const hallNode = circ.find(x => x.type === 'hall');
  for (const hallAsBand of hallNode ? [true, false] : [false]) {
    for (const bands0 of bandCounts) {
      if (hallAsBand && bands0 < 2) continue;
      for (const k of spineSizes) {
      const spineCirc = hallAsBand ? spineOrder.filter(x => x !== hallNode) : spineOrder;
      const spine = [...spineCirc.map(x => x.ref), ...spineExtra.slice(0, k).map(x => x.ref)];
      // the stair keeps one slot on every level, so something has to stand in front of it: the
      // threshold downstairs, and upstairs the narrowest store beside the stair head
      const stairAt = spine.findIndex(r => by.get(r)?.type === 'stair');
      if (stairAt === 0) {
        // a room that may be merged away cannot be the one holding the stair's slot, or the merge
        // variant would move the stair and break ARC-22
        const front = spine.findIndex((r, i2) => i2 > 0 && by.get(r)?.mergeInto === undefined);
        if (front < 0) continue;
        const st = spine[0];
        spine[0] = spine[front];
        spine[front] = st;
      }
      const attach = spineExtra.slice(k);
      const groups: ProgramNode[][] = Array.from({ length: bands0 }, () => []);
      hosts.forEach((h, i) => groups[i % bands0].push(h));
      const bands: NodeRef[][][] = groups.map(gr => gr.map(h => [h.ref]));
      // remaining service rooms become extra columns, biggest band first, host stays last in its band
      const order = bands.map((b, i) => ({ i, area: sum(b.flat().map(r => by.get(r)?.area.target ?? 0)) }))
        .sort((a, b) => b.area - a.area || a.i - b.i);
      attach.forEach((s, j) => {
        // a service room joins the band of the room the rules want it to open off, standing just
        // before that host so the host still reaches the façade at u = F
        const partner = g.rules.find(r2 => r2.kind === 'door' && (r2.a === s.ref || r2.b === s.ref));
        const wants = partner ? (partner.a === s.ref ? partner.b : partner.a) : undefined;
        const withPartner = bands.findIndex(bb => bb.some(c => c.includes(wants as NodeRef)));
        const target = withPartner >= 0 ? withPartner : order[j % Math.max(order.length, 1)].i;
        const at = withPartner >= 0 ? Math.max(0, bands[target].length - 1) : 0;
        bands[target] = [...bands[target].slice(0, at), [s.ref], ...bands[target].slice(at)];
      });
      // the landing as its own band across the plan: then every bedroom opens off circulation (ARC-19)
      // instead of off its neighbour, which is what a spine-only plan forces on the middle bands
      if (hallAsBand && hallNode) bands.splice(1, 0, [[hallNode.ref]]);
      if (spine.length === 0 && bands.length === 0) continue;
      if (bands.some(b => b.length === 0)) continue;
      out.push({ type: 'house', spine, bands, variant: `house/${hallAsBand ? 'landing' : 'spine'}/bands${bands0}/spine${k}` });
      }
    }
  }
  return out;
}

/**
 * The co-living cluster (ARC-24 / Alexander APL #75): a corridor down the middle of the frontage with
 * en-suite rooms either side, so every room reaches one of the two long façades. This is the plan that
 * needs `transpose` — its bands run along u, not v.
 */
function clusterBuilds(g: ProgramGraph, level: number): Build[] {
  const nodes = nodesAtLevel(g, level);
  const beds = nodes.filter(x => x.type === 'bedroom').sort((a, b) => (a.ref < b.ref ? -1 : 1));
  const suites = nodes.filter(x => x.type === 'ensuite').sort((a, b) => (a.ref < b.ref ? -1 : 1));
  const corridor = nodes.find(x => x.type === 'corridor');
  if (beds.length < 2 || !corridor) return [];
  const entry = nodes.find(x => x.type === 'entry');
  const kitchen = nodes.find(x => x.type === 'shared-kitchen');
  const living = nodes.find(x => x.type === 'shared-living');
  const rest = nodes.filter(x =>
    !beds.includes(x) && !suites.includes(x) && x !== corridor && x !== entry && x !== kitchen && x !== living);
  const out: Build[] = [];
  for (const rows of [2, 1]) {
    const half = rows === 2 ? Math.ceil(beds.length / 2) : beds.length;
    const lo = beds.slice(0, half);
    const hi = beds.slice(half);
    // One room per v-slice, so every room reaches BOTH the façade at the outer end of its band and the
    // corridor at the inner end: the bedroom opens off the corridor (ARC-24) and its en-suite opens off
    // the bedroom across their shared v-boundary, which is the full width of the band.
    const colsOf = (group: readonly ProgramNode[]): NodeRef[][] => {
      const out2: NodeRef[][] = [];
      for (const b of group) {
        out2.push([b.ref]);
        const e = suites[beds.indexOf(b)];
        if (e) out2.push([e.ref]);
      }
      return out2;
    };
    const left = colsOf(lo);
    const right = colsOf(hi);
    if (kitchen) left.push([kitchen.ref]);
    if (living && right.length > 0) right.push([living.ref]);
    else if (living) left.push([living.ref]);
    const mid: NodeRef[][] = [];
    if (entry) mid.push([entry.ref]);
    mid.push([corridor.ref]);
    for (const x of rest) mid.push([x.ref]);
    const bands = [left, mid, right].filter(b => b.length > 0);
    if (bands.length < 2) continue;
    out.push({ type: 'cluster', spine: [], bands, variant: `cluster/rows${rows}`, transpose: true });
  }
  return out;
}

function buildToShape(b: Build, by: Map<NodeRef, ProgramNode>, level: number): PlanShape {
  const bands: BandSpec[] = b.bands.map((cols, i) => {
    const nodesIn = cols.flat().map(r => by.get(r)).filter((x): x is ProgramNode => x !== undefined);
    const dMin = Math.max(...cols.map(c => sum(c.map(r => by.get(r)?.minDepth ?? 0))), 0);
    const dMaxRaw = Math.min(...cols.map(c => sum(c.map(r => by.get(r)?.maxDepth ?? 0))));
    return {
      columns: cols,
      depth: { min: ceil5(dMin), max: floor5(Math.max(ceil5(dMin), Number.isFinite(dMaxRaw) ? dMaxRaw : dMin)) },
      daylit: nodesIn.some(x => x.needsExterior) || i === b.bands.length - 1,
    };
  });
  const shape: PlanShape = { type: b.type, bands, transpose: b.transpose === true, level };
  if (b.spine.length > 0) {
    const sn = b.spine.map(r => by.get(r)).filter((x): x is ProgramNode => x !== undefined);
    const wMin = Math.max(...sn.map(x => x.minWidth), 0.6);
    const governing = sn.filter(x => x.minWidth >= wMin - E);
    const wMax = Math.max(wMin, Math.min(...governing.map(x => x.maxWidth)));
    shape.spine = { nodes: b.spine, width: { min: ceil5(wMin), max: floor5(Math.max(ceil5(wMin), wMax)) } };
  }
  return shape;
}

const shapeCache = new Map<string, PlanShape[]>();

/** Deterministic, preference-ordered candidate shapes for one level of a program graph. */
export function planShapesFor(g: ProgramGraph, o: FeasibilityOpts): PlanShape[] {
  const level = Math.max(0, Math.min(g.levels - 1, o.levels ?? 0));
  const key = `${g.id}|${level}|${o.region}|${o.accessible ? 1 : 0}|${o.rulesHash ?? ''}`;
  const hit = shapeCache.get(key);
  if (hit) return hit;
  const nodes = nodesAtLevel(g, level);
  const by = byRefMap(nodes);
  const builds: Build[] = [];
  if (g.templateId === 'coliving-cluster') builds.push(...clusterBuilds(g, level));
  // a spine plan is what a stair or a garage needs: a full-depth column the levels can stack on
  if (nodes.some(x => x.type === 'stair' || x.type === 'garage')) builds.push(...houseBuilds(g, level));
  builds.push(...zonedBuilds(g, level));
  builds.push(...throughBuilds(g, level));
  const shapes = builds
    .filter(b => b.bands.length > 0 && b.bands.every(band => band.length > 0))
    .map(b => {
      const s = buildToShape(b, by, level);
      if (g.templateId === 'dual-key' && s.type === 'zoned') s.type = 'dual-key';
      return s;
    });
  shapeCache.set(key, shapes);
  return shapes;
}

/** Every node ref the shape places (spine + bands). */
export function refsOf(shape: PlanShape): NodeRef[] {
  return [...(shape.spine?.nodes ?? []), ...shape.bands.flatMap(b => b.columns.flat())];
}

// ---------------------------------------------------------------------------------------------------
// 3. Laying a shape out at a concrete (F, D)
// ---------------------------------------------------------------------------------------------------

export interface PlacedNode {
  ref: NodeRef;
  node: ProgramNode;
  rect: Rect;
  bandIndex: number;
  colIndex: number;
  stackIndex: number;
  /** true for the spine column at u = 0 */
  spine: boolean;
}

export interface ShapeLayout {
  ok: boolean;
  /** false when the shape's declared maxima cannot reach its own minimum frontage at this depth */
  admits: boolean;
  cells: PlacedNode[];
  spineWidth: number;
  bandDepths: number[];
  widths: Record<NodeRef, Range>;
  frontage: Range;
  /** nodes forced below their kit minimum, and by how much */
  squeezed: { ref: NodeRef; axis: 'w' | 'd'; by: number }[];
  /** nodes grown past their declared maximum (a generous room, never a failure) */
  overflowed: NodeRef[];
}

interface ColStat { min: number; target: number; max: number }

function colStats(col: NodeRef[], by: Map<NodeRef, ProgramNode>, depth: number): ColStat {
  const ns = col.map(r => by.get(r)).filter((x): x is ProgramNode => x !== undefined);
  if (ns.length === 0) return { min: 0, target: 0, max: 0 };
  const minW = Math.max(...ns.map(x => x.minWidth));
  const areaMin = sum(ns.map(x => x.area.min));
  const areaMax = sum(ns.map(x => x.area.max));
  const areaTgt = sum(ns.map(x => x.area.target));
  const d = Math.max(depth, 0.5);
  // only the node(s) that set the column's minimum width cap its maximum: a 0.6 m shelf stacked behind
  // a 3.1 m kitchen must follow the kitchen's width, not cap it
  const governing = ns.filter(x => x.minWidth >= minW - E);
  const min = Math.max(minW, areaMin / d);
  const max = Math.max(min, Math.min(Math.min(...governing.map(x => x.maxWidth)), areaMax / d));
  return { min: ceil5(min), target: clamp(areaTgt / d, min, max), max: floor5(Math.max(min, max)) };
}

function depthItems(col: NodeRef[], by: Map<NodeRef, ProgramNode>, width: number): SizeItem[] {
  return col.map(r => {
    const x = by.get(r);
    if (!x) return { min: 0, target: 0, max: 0 };
    const t = width > E ? x.area.target / width : x.minDepth;
    return { min: x.minDepth, target: clamp(t, x.minDepth, x.maxDepth), max: x.maxDepth };
  });
}

/**
 * How wide the spine should be: its own rooms' area share, but never more than the frontage left over
 * once every band can still reach its minimum width. A 2.4 m hall is no use if it costs the bedrooms
 * behind it their London Plan width.
 */
function spineWidthFor(shape: PlanShape, by: Map<NodeRef, ProgramNode>, F: number, D: number): number {
  if (!shape.spine) return 0;
  const ns = shape.spine.nodes.map(r => by.get(r)).filter((x): x is ProgramNode => x !== undefined);
  const areaTgt = sum(ns.map(x => x.area.target));
  const lo = shape.spine.width.min;
  const need = bandsMinWidth(shape, by, Math.max(F - lo, 0.5), D);
  const hi = Math.max(lo, Math.min(shape.spine.width.max, F - need));
  return clamp(areaTgt / Math.max(D, 0.5), lo, hi);
}

/** The widest band's minimum width at the band depths a given secondary total implies. */
function bandsMinWidth(shape: PlanShape, by: Map<NodeRef, ProgramNode>, S: number, D: number): number {
  const items: SizeItem[] = shape.bands.map(b => {
    const nsIn = b.columns.flat().map(r => by.get(r)).filter((x): x is ProgramNode => x !== undefined);
    const tgt = sum(nsIn.map(x => x.area.target)) / Math.max(S, 0.5);
    return { min: b.depth.min, target: clamp(tgt, b.depth.min, b.depth.max), max: b.depth.max };
  });
  const depths = allocate(D, items) ?? items.map(i => i.min);
  return Math.max(...shape.bands.map((b, bi) => sum(b.columns.map(c => colStats(c, by, depths[bi]).min))), 0);
}

/**
 * Lay the shape out in the unit-local frame. `strict` refuses to squeeze or stretch (used by the
 * witness); otherwise the rect is always tiled exactly and every compromise is reported.
 */
/** The spine slot a multi-level unit's stair must occupy on every level (ARC-22). */
export interface StairPin { prefix: number; depth: number }

export function layoutShape(
  shape: PlanShape,
  by: Map<NodeRef, ProgramNode>,
  F: number,
  D: number,
  strict = false,
  pinSpineWidth?: number,
  pinStair?: StairPin,
): ShapeLayout {
  const squeezed: ShapeLayout['squeezed'] = [];
  const overflowed: NodeRef[] = [];
  const cells: PlacedNode[] = [];
  const widths: Record<NodeRef, Range> = {};
  // A pinned spine width (the organiser's stair rect, or the width the other levels settled on) still
  // has to clear the spine's OWN minimum — a 1.0 m stair well cannot also be the 1.2 m entry the front
  // door opens into.
  const spineW = shape.spine
    ? Math.min(Math.max(pinSpineWidth ?? spineWidthFor(shape, by, F, D), shape.spine.width.min), Math.max(0, F - 1.0))
    : 0;
  // The band axis is v for an ordinary plan and u for a transposed one (the cluster's corridor runs
  // down the middle of the frontage). Node bounds do not change with it: a band's own extent is always
  // measured in the rooms' DEPTH and a column's in their WIDTH — transposing rotates the plan, and
  // with it the rooms.
  const tp = shape.transpose;
  const P = tp ? Math.max(F - spineW, 0.5) : D;
  const S = tp ? D : Math.max(F - spineW, 0.5);
  let ok = true;

  const take = (total: number, items: SizeItem[], refs: NodeRef[], axis: 'w' | 'd'): number[] => {
    const strictOut = allocate(total, items);
    if (strictOut) {
      // growing past a declared maximum is a generous room, not an infeasibility: only a SQUEEZE
      // (Σ min > total) means the shape is wrong for this rect
      for (let k = 0; k < items.length; k++) {
        if (strictOut[k] > Math.max(items[k].min, items[k].max) + 0.005 && !overflowed.includes(refs[k])) {
          overflowed.push(refs[k]);
        }
      }
      return strictOut;
    }
    if (strict) { ok = false; }
    const r = fill(total, items);
    for (const s of r.squeezed) squeezed.push({ ref: refs[s.index], axis, by: s.by });
    for (const s of r.overflowed) if (!overflowed.includes(refs[s.index])) overflowed.push(refs[s.index]);
    return r.sizes;
  };

  // --- spine column (full depth at u = 0) -----------------------------------------------------
  if (shape.spine && shape.spine.nodes.length > 0) {
    const refs = shape.spine.nodes;
    const stairAt = refs.findIndex(r => by.get(r)?.type === 'stair');
    let depths: number[];
    if (pinStair && stairAt >= 0 && pinStair.depth > 0.5) {
      // the stair keeps the same slot on every level, so what is in front of it and behind it has to
      // fit the rest of the depth — a level that cannot is a level that needs a different shape
      const before = refs.slice(0, stairAt);
      const after = refs.slice(stairAt + 1);
      // nothing to stand in front of the stair means the pinned slot cannot be honoured: the plan still
      // tiles (the stair simply starts at the access wall) but the variant is no longer admissible,
      // because its stair would not stack on the one below
      if (before.length === 0 && pinStair.prefix > 0.01) ok = false;
      const prefix = before.length === 0 ? 0 : clamp(pinStair.prefix, 0, Math.max(0, D - pinStair.depth));
      const suffix = Math.max(0, D - prefix - pinStair.depth);
      // Nothing behind the stair means the pinned slot cannot absorb the rest of the depth. Tiling wins:
      // the stair takes the remainder and the variant is marked inadmissible, so a shape that CAN stack
      // its stair is preferred - and if none can, the deviation says the stair moved.
      if (after.length === 0 && suffix > 0.01) ok = false;
      depths = [
        ...take(prefix, depthItems(before, by, spineW), before, 'd'),
        after.length === 0 ? pinStair.depth + suffix : pinStair.depth,
        ...take(suffix, depthItems(after, by, spineW), after, 'd'),
      ];
    } else {
      depths = take(D, depthItems(refs, by, spineW), refs, 'd');
    }
    let v = 0;
    refs.forEach((ref, i) => {
      const node = by.get(ref);
      if (!node) return;
      cells.push({
        ref, node, rect: { x: 0, y: v, w: spineW, h: depths[i] },
        bandIndex: -1, colIndex: 0, stackIndex: i, spine: true,
      });
      widths[ref] = { min: spineW, max: spineW };
      v += depths[i];
    });
  }

  // --- band depths -----------------------------------------------------------------------------
  const bandItems: SizeItem[] = shape.bands.map(b => {
    const ns = b.columns.flat().map(r => by.get(r)).filter((x): x is ProgramNode => x !== undefined);
    const tgt = sum(ns.map(x => x.area.target)) / Math.max(S, 0.5);
    return { min: b.depth.min, target: clamp(tgt, b.depth.min, b.depth.max), max: b.depth.max };
  });
  const bandRefs = shape.bands.map(b => b.columns[0][0]);
  const bandDepths = take(P, bandItems, bandRefs, 'd');

  // --- columns and stacks ----------------------------------------------------------------------
  let bandOff = tp ? spineW : 0;
  shape.bands.forEach((band, bi) => {
    const d = bandDepths[bi];
    const stats = band.columns.map(c => colStats(c, by, d));
    const colRefs = band.columns.map(c => c[0]);
    const colW = take(S, stats, colRefs, 'w');
    let colOff = tp ? 0 : spineW;
    band.columns.forEach((col, ci) => {
      const w = colW[ci];
      const depths = take(d, depthItems(col, by, w), col, 'd');
      let stackOff = bandOff;
      col.forEach((ref, si) => {
        const node = by.get(ref);
        if (!node) return;
        const rect: Rect = tp
          ? { x: stackOff, y: colOff, w: depths[si], h: w }
          : { x: colOff, y: stackOff, w, h: depths[si] };
        cells.push({
          ref, node, rect,
          bandIndex: bi, colIndex: ci, stackIndex: si, spine: false,
        });
        widths[ref] = { min: round2(stats[ci].min), max: round2(stats[ci].max) };
        stackOff += depths[si];
      });
      colOff += w;
    });
    bandOff += d;
  });

  const bandMin = shape.bands.map((b, bi) => sum(b.columns.map(c => colStats(c, by, bandDepths[bi]).min)));
  const bandMax = shape.bands.map((b, bi) => sum(b.columns.map(c => colStats(c, by, bandDepths[bi]).max)));
  const spineMin = shape.spine ? shape.spine.width.min : 0;
  const spineMax = shape.spine ? shape.spine.width.max : 0;
  const all = refsOf(shape).map(r => by.get(r)).filter((x): x is ProgramNode => x !== undefined);
  const areaMin = sum(all.map(x => x.area.min));
  const areaMax = sum(all.map(x => x.area.max));
  const fMin = tp
    ? Math.max(spineMin + sum(shape.bands.map(b => b.depth.min)), areaMin / Math.max(D, 0.5))
    : Math.max(spineMin + Math.max(...bandMin, 0), areaMin / Math.max(D, 0.5));
  const fMaxRaw = tp
    ? Math.min(spineMax + sum(shape.bands.map(b => b.depth.max)), areaMax / Math.max(D, 0.5))
    : Math.min(spineMax + Math.min(...bandMax), areaMax / Math.max(D, 0.5));
  // A shape whose declared maxima cannot reach its own minimum frontage still TILES the rect (the
  // allocator grows rooms past their maximum and records it), but its admissible interval has
  // collapsed to a point, so the union prefers shapes that genuinely admit the depth.
  const admits = fMaxRaw >= fMin - 0.005;
  const fMax = Math.max(fMin, fMaxRaw);

  return {
    ok,
    admits,
    cells,
    spineWidth: spineW,
    bandDepths,
    widths,
    frontage: { min: ceil5(fMin), max: floor5(Math.max(ceil5(fMin), fMax)) },
    squeezed,
    overflowed,
  };
}

// ---------------------------------------------------------------------------------------------------
// 4. The witness
// ---------------------------------------------------------------------------------------------------

function witnessFrom(
  g: ProgramGraph,
  shape: PlanShape,
  layout: ShapeLayout,
  D: number,
  merged: { ref: NodeRef; into: NodeRef }[],
  stacked: NodeRef[],
): Feasibility {
  return {
    ok: true,
    programId: g.id,
    shape,
    frontage: layout.frontage,
    depth: round2(D),
    bandDepths: layout.bandDepths.map(round2),
    widths: layout.widths,
    merged,
    stacked,
    // boundaries, not sizes, carry the rounding: two rooms sharing an edge must round to one coordinate
    rooms: layout.cells.map(c => ({
      ref: c.ref,
      type: c.node.type,
      zone: c.node.zone,
      rect: {
        x: round2(c.rect.x),
        y: round2(c.rect.y),
        w: round2(c.rect.x + c.rect.w) - round2(c.rect.x),
        h: round2(c.rect.y + c.rect.h) - round2(c.rect.y),
      },
    })),
  };
}

/** Node map for a shape, with the `merged` nodes removed (they became furniture in another room). */
function nodesForShape(g: ProgramGraph, level: number, dropped: readonly NodeRef[]): Map<NodeRef, ProgramNode> {
  const by = byRefMap(nodesAtLevel(g, level));
  for (const r of dropped) by.delete(r);
  return by;
}

export function pruneShape(shape: PlanShape, dropped: readonly NodeRef[]): PlanShape {
  const keep = (r: NodeRef): boolean => !dropped.includes(r);
  const bands: BandSpec[] = shape.bands
    .map(b => ({ ...b, columns: b.columns.map(c => c.filter(keep)).filter(c => c.length > 0) }))
    .filter(b => b.columns.length > 0);
  const out: PlanShape = { type: shape.type, bands, transpose: shape.transpose, level: shape.level };
  if (shape.spine) {
    const nodes = shape.spine.nodes.filter(keep);
    if (nodes.length > 0) out.spine = { nodes, width: shape.spine.width };
  }
  return out;
}

/**
 * Does `shape` admit `(F, D)`? The witness carries the band depths, the per-node width bounds and the
 * unit-local room rects (so the editor can draw a module thumbnail without running the solver).
 */
export function feasibleShape(shape: PlanShape, g: ProgramGraph, F: number, D: number, pin?: SpinePin): FeasibilityResult {
  const by = nodesForShape(g, shape.level, []);
  const l = layoutShape(shape, by, F, D, true, pin?.width, pin?.stair);
  if (!l.ok) {
    const short = l.squeezed.length > 0 ? Math.max(...l.squeezed.map(s => s.by)) : undefined;
    return {
      ok: false,
      reason: l.squeezed.length > 0
        ? `${shape.type} plan: ${l.squeezed.map(s => `${s.ref} short by ${s.by.toFixed(2)} m`).join(', ')}`
        : `${shape.type} plan: ${F.toFixed(2)} × ${D.toFixed(2)} m cannot be tiled inside the declared maxima`,
      ...(short !== undefined ? { shortBy: round2(short) } : {}),
    };
  }
  if (F < l.frontage.min - 0.005 || F > l.frontage.max + 0.005) {
    return {
      ok: false,
      reason: `${shape.type} plan admits ${l.frontage.min.toFixed(2)}–${l.frontage.max.toFixed(2)} m of frontage at ${D.toFixed(2)} m depth, not ${F.toFixed(2)} m`,
      shortBy: round2(F < l.frontage.min ? l.frontage.min - F : F - l.frontage.max),
    };
  }
  return witnessFrom(g, shape, l, D, [], []);
}

/** Mergeable nodes, smallest first — fallback (b) when no shape fits. */
function mergeOrder(g: ProgramGraph, level: number): ProgramNode[] {
  return nodesAtLevel(g, level)
    .filter(x => x.mergeInto !== undefined)
    .sort((a, b) => a.area.target - b.area.target || (a.ref < b.ref ? -1 : 1));
}

const fitCache = new Map<string, FeasibilityResult>();

const optsKey = (o: FeasibilityOpts): string =>
  `${o.region}|${o.accessible ? 1 : 0}|${o.levels ?? 0}|${o.detail ?? 'medium'}|${o.rulesHash ?? ''}`;

/**
 * The witness for a concrete `(frontage, depth)`, trying each candidate shape in preference order and
 * then the declared `mergeInto` alternatives. Memoised by `(programId, shapeType, F, D, optsHash)`.
 */
export function fitFor(g: ProgramGraph, F: number, D: number, o: FeasibilityOpts): FeasibilityResult {
  const key = `${g.id}|F${round2(F)}|D${round2(D)}|${optsKey(o)}`;
  const hit = fitCache.get(key);
  if (hit) return hit;
  const out = witnessAt(g, F, D, o, spinePinFor(g, D, o));
  fitCache.set(key, out);
  return out;
}

/**
 * The witness for a concrete `(frontage, depth)`: the first candidate — shape variant, then declared
 * `mergeInto` alternatives smallest-first — that admits it. `feasibleAt` probes with the same function,
 * so the range it publishes and the witnesses the placer can actually get are the same thing.
 */
function witnessAt(g: ProgramGraph, F: number, D: number, o: FeasibilityOpts, pin?: SpinePin): FeasibilityResult {
  const level = Math.max(0, Math.min(g.levels - 1, o.levels ?? 0));
  const shapes = planShapesFor(g, o);
  let last: Infeasible = { ok: false, reason: `no plan shape for ${g.id}` };
  for (const shape of shapes) {
    const r = feasibleShape(shape, g, F, D, pin);
    if (r.ok) return r;
    last = r;
  }
  // fallback (b): apply `mergeInto` for the smallest mergeable nodes, one at a time
  const dropped: NodeRef[] = [];
  const merged: { ref: NodeRef; into: NodeRef }[] = [];
  for (const m of mergeOrder(g, level)) {
    dropped.push(m.ref);
    merged.push({ ref: m.ref, into: (m.mergeInto as { ref: NodeRef }).ref });
    const by = nodesForShape(g, level, dropped);
    for (const shape0 of shapes) {
      const shape = pruneShape(shape0, dropped);
      if (shape.bands.length === 0) continue;
      const l = layoutShape(shape, by, F, D, true, pin?.width, pin?.stair);
      if (l.ok && F >= l.frontage.min - 0.005 && F <= l.frontage.max + 0.005) {
        return witnessFrom(g, shape, l, D, [...merged], []);
      }
    }
  }
  return last;
}

export interface SpinePin { width: number; stair: StairPin }

/**
 * The spine a multi-storey unit's levels share at this depth: the widest spine any level needs, and the
 * stair slot level 0 puts inside it. The solver pins both (`solver.ts` `sharedSpine`), so the admissible
 * range has to be derived with them pinned too — otherwise the placer would be promised a frontage the
 * solver then has to squeeze.
 */
function spinePinFor(g: ProgramGraph, D: number, o: FeasibilityOpts): SpinePin | undefined {
  if (g.levels <= 1) return undefined;
  let width = 0;
  for (let L = 0; L < g.levels; L++) {
    const by = nodesForShape(g, L, []);
    const probe = clamp(sum([...by.values()].map(x => x.area.target)) / Math.max(D, 0.5), 1.5, 40);
    // the spine THIS level would choose on its own — not the widest any variant could want, which
    // would starve the bands on every other level
    let pick: number | null = null;
    let loose: number | null = null;
    for (const shape of planShapesFor(g, { ...o, levels: L })) {
      if (!shape.spine) continue;
      const l = layoutShape(shape, by, probe, D, true);
      if (!l.ok) continue;
      if (l.admits) { pick = l.spineWidth; break; }
      if (loose === null) loose = l.spineWidth;
    }
    width = Math.max(width, pick ?? loose ?? 0);
  }
  if (width <= 0) return undefined;
  const by0 = nodesForShape(g, 0, []);
  const probe0 = clamp(sum([...by0.values()].map(x => x.area.target)) / Math.max(D, 0.5), 1.5, 40);
  for (const shape of planShapesFor(g, { ...o, levels: 0 })) {
    if (!shape.spine) continue;
    const l = layoutShape(shape, by0, probe0, D, true, width);
    if (!l.ok) continue;
    const st = l.cells.find(c => c.spine && c.node.type === 'stair');
    if (st) return { width, stair: { prefix: round2(st.rect.y), depth: round2(st.rect.h) } };
  }
  return { width, stair: { prefix: 0, depth: 0 } };
}

export function feasibleAt(g: ProgramGraph, D: number, o: FeasibilityOpts): FeasibilityResult {
  const key = `at|${g.id}|D${round2(D)}|${optsKey({ ...o, levels: undefined })}`;
  const hit = fitCache.get(key);
  if (hit) return hit;
  let best: Feasibility | null = null;
  let last: Infeasible = { ok: false, reason: `no plan shape for ${g.id}` };
  // Every level of a multi-storey unit has to admit the SAME rect, so the admissible frontage is the
  // intersection of the levels' interval sets — not of their outer bounds, which would claim a frontage
  // that only the bedroom floor can take.
  let acc: Iv[] | null = null;
  const pin = spinePinFor(g, D, o);
  for (let level = 0; level < g.levels; level++) {
    const range = frontageRangeAtLevel(g, { ...o, levels: level }, D, pin);
    const bands = levelBands;
    if (!range.ok || bands.length === 0) { fitCache.set(key, range.ok ? last : range); return range.ok ? last : range; }
    if (level === 0) best = range;
    acc = acc === null ? bands : intersectIvs(acc, bands);
    if (acc.length === 0) {
      const r: Infeasible = {
        ok: false,
        reason: `${g.id}: its levels admit no common frontage at ${D.toFixed(2)} m depth`,
      };
      fitCache.set(key, r);
      return r;
    }
  }
  if (!best || !acc || acc.length === 0) { fitCache.set(key, last); return last; }
  const implied = clamp(sum(g.nodes.map(x => x.area.target)) / Math.max(g.levels, 1) / Math.max(D, 0.5), 1.5, 40);
  const pickIv = [...acc]
    .sort((x, y) => (y.hi - y.lo) - (x.hi - x.lo) || x.lo - y.lo)
    .sort((x, y) => Number(y.lo - 0.01 <= implied && implied <= y.hi + 0.01)
      - Number(x.lo - 0.01 <= implied && implied <= x.hi + 0.01))[0];
  // Publish only frontages the solver can actually witness: the band's ends come from one variant's
  // arithmetic, so walk each end inward in 50 mm steps until `witnessAt` answers. This is the invariant
  // the placer depends on — `fitFor(frontageAt(id, D).min | .max, D)` is never null.
  const step = 0.05;
  let lo = ceil5(pickIv.lo);
  let hi = floor5(pickIv.hi);
  let guard = 0;
  while (lo <= hi + 1e-9 && guard++ < 40 && !witnessAt(g, lo, D, { ...o, levels: 0 }, pin).ok) lo = ceil5(lo + step);
  guard = 0;
  while (hi >= lo - 1e-9 && guard++ < 40 && !witnessAt(g, hi, D, { ...o, levels: 0 }, pin).ok) hi = floor5(hi - step);
  if (hi < lo - 1e-9) {
    const r: Infeasible = { ok: false, reason: `${g.id}: no witness anywhere in ${pickIv.lo.toFixed(2)}–${pickIv.hi.toFixed(2)} m at ${D.toFixed(2)} m depth` };
    fitCache.set(key, r);
    return r;
  }
  const out: Feasibility = { ...best, frontage: { min: lo, max: hi } };
  fitCache.set(key, out);
  return out;
}

/** Interval-set intersection, both inputs sorted by `lo`. */
function intersectIvs(a: readonly Iv[], b: readonly Iv[]): Iv[] {
  const out: Iv[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const lo = Math.max(a[i].lo, b[j].lo);
    const hi = Math.min(a[i].hi, b[j].hi);
    if (hi >= lo - 0.005) out.push({ lo, hi: Math.max(lo, hi) });
    if (a[i].hi < b[j].hi) i++;
    else j++;
  }
  return out;
}


/**
 * The admissible frontage interval for one level at a net depth: the UNION over the candidate shapes,
 * because a frontage any variant can hold is a frontage the solver can lay out. Merging is a declared
 * program alternative (a closet becomes a wardrobe run), so the fully-merged variants set the lower
 * bound and the un-merged ones the upper bound — the two brackets are all that need evaluating.
 *
 * Two passes per shape: probe with an area-implied frontage, then re-evaluate at a frontage inside the
 * range the probe produced, so the band depths settle.
 */
export interface Iv { lo: number; hi: number }

/** the interval set the last `frontageRangeAtLevel` call found, for the multi-level intersection */
let levelBands: Iv[] = [];

function frontageRangeAtLevel(g: ProgramGraph, o: FeasibilityOpts, D: number, pin?: SpinePin): Feasibility | Infeasible {
  levelBands = [];
  const level = Math.max(0, Math.min(g.levels - 1, o.levels ?? 0));
  const by0 = nodesForShape(g, level, []);
  const mergeable = [...by0.values()]
    .filter(x => x.mergeInto !== undefined)
    .sort((x, y) => x.area.target - y.area.target || (x.ref < y.ref ? -1 : 1))
    .map(x => x.ref);
  const shapes = planShapesFor(g, o);
  const evaluate = (shape: PlanShape, by: Map<NodeRef, ProgramNode>): ShapeLayout => {
    const probe = clamp(sum([...by.values()].map(x => x.area.target)) / Math.max(D, 0.5), 1.5, 40);
    const p1 = layoutShape(shape, by, probe, D, true, pin?.width, pin?.stair);
    const f2 = clamp(probe, p1.frontage.min, p1.frontage.max);
    return layoutShape(shape, by, f2, D, true, pin?.width, pin?.stair);
  };

  // The PLAN TYPE comes first, exactly as it does in `pickShape`: the first type in preference order
  // with a variant that tiles this depth inside its own maxima. Two different plan types admit two
  // unrelated frontages, and quoting their union would promise a frontage neither can lay out.
  let last: Infeasible = { ok: false, reason: `no plan shape for ${g.id} at level ${level}` };
  interface Cand { shape: PlanShape; layout: ShapeLayout; merged: NodeRef[] }
  const feasible: Cand[] = [];
  const brackets: NodeRef[][] = mergeable.length > 0 ? [[], mergeable] : [[]];
  for (const dropped of brackets) {
    const by = nodesForShape(g, level, dropped);
    for (const shape0 of shapes) {
      const shape = dropped.length === 0 ? shape0 : pruneShape(shape0, dropped);
      if (shape.bands.length === 0) continue;
      const l = evaluate(shape, by);
      if (!l.ok) {
        last = {
          ok: false,
          reason: `${g.id} level ${level}: ${shape.type} plan cannot be tiled at ${D.toFixed(2)} m depth`,
          ...(l.squeezed.length > 0 ? { shortBy: round2(Math.max(...l.squeezed.map(x => x.by))) } : {}),
        };
        continue;
      }
      feasible.push({ shape, layout: l, merged: dropped });
    }
  }
  if (feasible.length === 0) return last;
  // preference order wins over how cleanly a variant fits: a cluster that has to grow an en-suite past
  // its declared maximum is still the right plan for a cluster program
  const type = feasible[0].shape.type;
  const ofType = feasible.filter(c => c.shape.type === type);
  const admitting = ofType.filter(c => c.layout.admits);
  const pool = admitting.length > 0 ? admitting : ofType;

  // Within one plan type the variants differ only in how much they stack or merge, so their intervals
  // overlap: merge them into contiguous bands and take the one holding the frontage the program's own
  // areas imply at this depth.
  const ivs = pool
    .map(c => ({ lo: c.layout.frontage.min, hi: c.layout.frontage.max, c }))
    .sort((x, y) => x.lo - y.lo || x.hi - y.hi);
  const bands2: { lo: number; hi: number; members: typeof ivs }[] = [];
  for (const iv of ivs) {
    const tail = bands2[bands2.length - 1];
    if (tail && iv.lo <= tail.hi + 1e-9) {
      tail.hi = Math.max(tail.hi, iv.hi);
      tail.members.push(iv);
    } else {
      bands2.push({ lo: iv.lo, hi: iv.hi, members: [iv] });
    }
  }
  const implied = clamp(sum([...by0.values()].map(x => x.area.target)) / Math.max(D, 0.5), 1.5, 40);
  const inside = (b2: { lo: number; hi: number }): boolean => b2.lo - 0.01 <= implied && implied <= b2.hi + 0.01;
  bands2.sort((x, y) => x.lo - y.lo);
  levelBands = bands2.map(b2 => ({ lo: b2.lo, hi: b2.hi }));
  const band = [...bands2]
    .sort((x, y) => (y.hi - y.lo) - (x.hi - x.lo) || x.lo - y.lo)
    .sort((x, y) => Number(inside(y)) - Number(inside(x)))[0];
  const best = band.members
    .map(m => m.c)
    .sort((x, y) => (x.merged.length - y.merged.length)
      || (y.layout.frontage.max - y.layout.frontage.min) - (x.layout.frontage.max - x.layout.frontage.min))[0];
  const merged = best.merged.map(r => ({
    ref: r,
    into: (by0.get(r)?.mergeInto as { ref: NodeRef } | undefined)?.ref ?? r,
  }));
  const w = witnessFrom(g, best.shape, best.layout, D, merged, []);
  return { ...w, frontage: { min: ceil5(band.lo), max: floor5(band.hi) } };
}

export interface DepthRange { min: number; max: number; step: number; depths: number[] }

const depthCache = new Map<string, DepthRange>();

/** Net depths that admit the program, bisected over [4, 22] m in 0.25 m steps. Memoised. */
export function admissibleDepths(g: ProgramGraph, o: FeasibilityOpts): DepthRange {
  const key = `d|${g.id}|${optsKey({ ...o, levels: undefined })}`;
  const hit = depthCache.get(key);
  if (hit) return hit;
  const step = 0.25;
  const depths: number[] = [];
  for (let d = 4; d <= 22 + E; d = round2(d + step)) {
    if (feasibleAt(g, d, o).ok) depths.push(d);
  }
  const out: DepthRange = {
    min: depths.length > 0 ? depths[0] : 0,
    max: depths.length > 0 ? depths[depths.length - 1] : 0,
    step,
    depths,
  };
  depthCache.set(key, out);
  return out;
}

/** Admissible frontage range at a depth, or null when the depth is inadmissible (catalogue.frontageAt). */
export function frontageAt(g: ProgramGraph, D: number, o: FeasibilityOpts): Range | null {
  const r = feasibleAt(g, D, o);
  return r.ok ? r.frontage : null;
}

/** Convenience for callers holding a template id rather than a graph. */
export function fitForTemplate(templateId: UnitTemplateId, F: number, D: number, o: FeasibilityOpts): FeasibilityResult {
  return fitFor(programFor(templateId), F, D, o);
}

/** Test/perf helper: drop every memo (the caches are keyed on the rule hash, so this is rarely needed). */
export function clearFeasibilityCache(): void {
  shapeCache.clear();
  fitCache.clear();
  depthCache.clear();
}

export const DEFAULT_OPTS = (region: Region): FeasibilityOpts => ({ region });
export { WET_TYPES };
