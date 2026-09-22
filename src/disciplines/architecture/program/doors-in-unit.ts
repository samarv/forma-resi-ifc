/**
 * Which rooms of a laid-out unit are joined by a door.
 *
 * The program graph names the doors that MUST exist (`kind: 'door'`) and the ones that must NOT
 * (`no-door`, plus `not-adjacent` pairs that should never have shared a wall in the first place).
 * Everything else is completed by a shortest-circulation tree — Dijkstra over `transitCost`, the same
 * cost model the v1 engine used, so circulation still prefers halls over bedrooms — with required
 * edges priced at almost nothing so they win whenever the geometry offers them.
 *
 * The result is a spanning tree over the realised rooms: one door per room, rooted at the threshold.
 * Hinge, swing, motion and the leaf keep-out are then derived by the producer through
 * `solveSwing`/`swingRect` (core/openings.ts); this module only decides WHICH edges carry a door, and
 * reports the required edges the geometry could not offer so they become deviations rather than
 * silence.
 */
import type { Region, RoomType } from '../../../core/types.ts';
import type { Adj, RoomRec, TreeLink } from '../unit-layout.ts';
import { MIN_DOOR_EDGE, transitCost } from '../unit-layout.ts';
import type { NodeRef, ProgramGraph } from './types.ts';

export interface UnitDoorPlan {
  root: number;
  parent: (TreeLink | undefined)[];
  /** `door` rules the realised geometry could not satisfy (no shared edge long enough) */
  unsatisfied: { a: NodeRef; b: NodeRef; reason: string }[];
  /** rooms that had to be entered through a pair the rules discourage, to avoid a landlocked room */
  relaxed: { a: string; b: string }[];
}

const ROOT_ORDER: RoomType[] = ['entry', 'hall', 'corridor', 'stair', 'living-kitchen', 'living', 'shared-living'];

interface Edge { to: number; adj: Adj; required: boolean; forbidden: boolean }

function keyOf(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Required / forbidden pairs for this region, keyed by unordered node-ref pair. A rule written against
 * a room TYPE rather than a ref applies to every node of that type.
 */
function ruleSets(g: ProgramGraph, region: Region, refType: Map<string, RoomType>): { required: Set<string>; forbidden: Set<string> } {
  const required = new Set<string>();
  const forbidden = new Set<string>();
  const refs = [...refType.keys()].sort();
  const expand = (token: string): string[] => {
    if (refType.has(token)) return [token];
    return refs.filter(r => refType.get(r) === token);
  };
  for (const rule of g.rules) {
    if (rule.regions && !rule.regions.includes(region)) continue;
    for (const a of expand(String(rule.a))) {
      for (const b of expand(String(rule.b))) {
        if (a === b) continue;
        if (rule.kind === 'door') required.add(keyOf(a, b));
        else if (rule.kind === 'no-door' || rule.kind === 'not-adjacent') forbidden.add(keyOf(a, b));
      }
    }
  }
  // an explicit door always beats a discouragement (a rule set that says both is a data error, and the
  // door is the one with the safety consequence)
  for (const k of required) forbidden.delete(k);
  return { required, forbidden };
}

export function planUnitDoors(a: {
  rooms: RoomRec[];
  adjs: readonly Adj[];
  program: ProgramGraph;
  region: Region;
}): UnitDoorPlan {
  const n = a.rooms.length;
  const refOf = (i: number): string => a.rooms[i].def.ref ?? `${a.rooms[i].cell.type}${i}`;
  const refType = new Map<string, RoomType>();
  for (let i = 0; i < n; i++) if (!a.rooms[i].outside) refType.set(refOf(i), a.rooms[i].cell.type);
  const { required, forbidden } = ruleSets(a.program, a.region, refType);

  /**
   * A shared edge has to be 0.95 m long to host the 0.80 m interior leaf plus its two 0.15 m reveals, so
   * the tree is built over the edges that can and only falls back to the shorter ones for a room that
   * would otherwise be landlocked.
   */
  const LEAF_EDGE = 0.95;
  const nbr: Edge[][] = Array.from({ length: n }, () => []);
  const nbrAll: Edge[][] = Array.from({ length: n }, () => []);
  for (const adj of a.adjs) {
    if (adj.s1 - adj.s0 < MIN_DOOR_EDGE) continue;
    if (a.rooms[adj.a].outside || a.rooms[adj.b].outside) continue;
    const k = keyOf(refOf(adj.a), refOf(adj.b));
    const req = required.has(k);
    const forb = forbidden.has(k);
    nbrAll[adj.a].push({ to: adj.b, adj, required: req, forbidden: forb });
    nbrAll[adj.b].push({ to: adj.a, adj, required: req, forbidden: forb });
    if (adj.s1 - adj.s0 < LEAF_EDGE) continue;
    nbr[adj.a].push({ to: adj.b, adj, required: req, forbidden: forb });
    nbr[adj.b].push({ to: adj.a, adj, required: req, forbidden: forb });
  }

  // --- root: the threshold -----------------------------------------------------------------------
  let root = 0;
  let found = false;
  for (const t of ROOT_ORDER) {
    const i = a.rooms.findIndex(r => !r.outside && r.cell.type === t);
    if (i >= 0) { root = i; found = true; break; }
  }
  if (!found) {
    let area = -1;
    a.rooms.forEach((r, i) => {
      const s = r.local.w * r.local.h;
      if (!r.outside && s > area) { area = s; root = i; }
    });
  }

  // --- Dijkstra over transit cost, required edges almost free ------------------------------------
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
    const through = u === root ? 0.05 : transitCost(a.rooms[u].cell.type);
    for (const e of nbr[u]) {
      if (done[e.to] || e.forbidden) continue;
      const span = e.adj.s1 - e.adj.s0;
      const narrow = 0;
      // an edge the program asked for is nearly free; every other edge pays a fixed toll on top of the
      // transit cost, so a required edge wins even against a direct hop off the root
      const step = (e.required ? 0.05 : 0.6 + through + 0.02 * (1 / Math.max(0.5, span))) + narrow;
      const w = dist[u] + step;
      if (w < dist[e.to]) { dist[e.to] = w; parent[e.to] = { idx: u, adj: e.adj }; }
    }
  }

  // --- landlocked rooms: better a discouraged door than no door at all ---------------------------
  const relaxed: { a: string; b: string }[] = [];
  for (let i = 0; i < n; i++) {
    if (i === root || parent[i] !== undefined || a.rooms[i].outside) continue;
    const opts = nbrAll[i].filter(e => e.to === root || parent[e.to] !== undefined || e.to < i);
    if (opts.length === 0) continue;
    opts.sort((x, y) => (x.forbidden ? 1 : 0) - (y.forbidden ? 1 : 0)
      || (y.adj.s1 - y.adj.s0) - (x.adj.s1 - x.adj.s0)
      || x.to - y.to);
    const pick = opts[0];
    parent[i] = { idx: pick.to, adj: pick.adj };
    if (pick.forbidden) relaxed.push({ a: refOf(i), b: refOf(pick.to) });
  }

  // --- repair: a leaf needs 0.95 m of shared edge, so re-parent onto a wider wall when one exists
  const depth = (i: number): number => {
    let d = 0;
    let cur: number | undefined = i;
    for (let g = 0; g < n && cur !== undefined && cur !== root; g++) { cur = parent[cur]?.idx; d++; }
    return d;
  };
  const ancestorOf = (anc: number, i: number): boolean => {
    let cur: number | undefined = i;
    for (let g = 0; g < n && cur !== undefined; g++) {
      if (cur === anc) return true;
      cur = parent[cur]?.idx;
    }
    return false;
  };
  const order = a.rooms.map((_, i) => i).sort((x, y) => depth(x) - depth(y) || x - y);
  for (const i of order) {
    const p = parent[i];
    if (i === root || !p || a.rooms[i].outside) continue;
    if (p.adj.s1 - p.adj.s0 >= 0.95) continue;
    const better = nbrAll[i]
      .filter(e => !e.forbidden && e.adj.s1 - e.adj.s0 >= 0.95 && !ancestorOf(i, e.to))
      .sort((x, y) => (y.required ? 1 : 0) - (x.required ? 1 : 0)
        || transitCost(a.rooms[x.to].cell.type) - transitCost(a.rooms[y.to].cell.type)
        || (y.adj.s1 - y.adj.s0) - (x.adj.s1 - x.adj.s0));
    if (better.length > 0) parent[i] = { idx: better[0].to, adj: better[0].adj };
  }

  // --- required edges the geometry never offered -------------------------------------------------
  const drawn = new Set<string>();
  for (let i = 0; i < n; i++) {
    const p = parent[i];
    if (p) drawn.add(keyOf(refOf(i), refOf(p.idx)));
  }
  const unsatisfied: UnitDoorPlan['unsatisfied'] = [];
  for (const k of [...required].sort()) {
    if (drawn.has(k)) continue;
    const [x, y] = k.split('|');
    if (!refType.has(x) || !refType.has(y)) continue;
    const ix = a.rooms.findIndex((r, i) => !r.outside && refOf(i) === x);
    const iy = a.rooms.findIndex((r, i) => !r.outside && refOf(i) === y);
    const shared = ix >= 0 && iy >= 0 && nbrAll[ix].some(e => e.to === iy);
    unsatisfied.push({
      a: x,
      b: y,
      reason: shared
        ? 'both rooms are already joined through the circulation tree; a second leaf would need a cycle'
        : `no shared edge of at least ${MIN_DOOR_EDGE.toFixed(2)} m between them in this rect`,
    });
  }

  return { root, parent, unsatisfied, relaxed };
}
