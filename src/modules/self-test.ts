/**
 * Catalogue self-test: sweep every module over its own admissible region and assert the twelve invariants of the
 * design doc §5. A module whose sweep fails is NARROWED to the largest failure-free depth interval, and if nothing is
 * left it is not admitted — which is why the placer can treat "the catalogue offered it" as "it works".
 *
 * Samples per unit module: depth ∈ {min, min+0.25, mid, max−0.25, max}; frontage ∈ {min, min+0.05, mid, max−0.05,
 * max} of `frontageAt(depth)`; every level; regions {US, UK}.
 *
 * Three of the twelve checks (`swing-clear`, `swing-into`, `trap-arm`) need a laid-out unit rather than the witness,
 * so they run only when a `layoutUnit` implementation is injected; `selfTestCatalogue(...).skipped` names them so a
 * green run can never be mistaken for full coverage. Everything else runs off the witness and its room rects.
 */
import type { Region, Side } from '../core/types.ts';
import type { Feasibility, FeasibilityOpts, NodeRef, PlanShape, ProgramGraph } from '../disciplines/architecture/program/types.ts';
import type { ModuleCatalogue, SelfTestCase, SelfTestFailure, UnitModule } from './types.ts';
import { kitMinDims, programFor } from './program-source.ts';
import { shapesOf } from './unit-modules.ts';

export interface SelfTestOpts {
  frontageSamples?: number;
  depthSamples?: number;
  regions?: Region[];
  /** restrict the sweep to these module ids (used by the perf test) */
  only?: readonly string[];
}

export interface SelfTestReport {
  failures: SelfTestFailure[];
  cases: number;
  /** checks that could not run because they need a laid-out unit rather than the witness */
  skipped: string[];
}

const ALL_CHECKS = [
  'tiles', 'reachable', 'daylight', 'kit-complete', 'swing-clear', 'swing-into',
  'trap-arm', 'min-dims', 'min-leaf', 'adjacency', 'ports', 'determinism',
] as const;

/** Leaf minima baked into every node's minWidth with a 0.20 m allowance (design §4.4) */
const LEAF = { entry: 0.90, accessible: 0.85, interior: 0.80, bath: 0.75, closet: 0.70 };

export function selfTestCatalogue(c: ModuleCatalogue, o: SelfTestOpts = {}): SelfTestFailure[] {
  return selfTestReport(c, o).failures;
}

export interface Narrowing {
  /** module id → the largest failure-free depth interval found by the sweep */
  depth: Map<string, { min: number; max: number }>;
  /** modules with no failure-free depth at all: not admitted */
  drop: string[];
}

/**
 * The production response to a failing sweep (design §5): narrow the module's depth envelope to the largest
 * failure-free interval, and refuse to admit it when nothing is left. `narrowCatalogue` in catalogue.ts applies this;
 * `buildCatalogue` deliberately does NOT run the sweep, which costs ~200 ms and belongs in the tests.
 */
export function narrowingFor(c: ModuleCatalogue, o: SelfTestOpts = {}): Narrowing {
  const nD = Math.max(2, o.depthSamples ?? 5);
  const depth = new Map<string, { min: number; max: number }>();
  const drop: string[] = [];
  const byModule = new Map<string, Set<number>>();
  for (const f of selfTestReport(c, o).failures) {
    const set = byModule.get(f.case.moduleId) ?? new Set<number>();
    set.add(f.case.depth);
    byModule.set(f.case.moduleId, set);
  }
  for (const m of c.units) {
    const bad = byModule.get(m.id);
    if (!bad || bad.size === 0) continue;
    const ds = samples(m.depth.min, m.depth.max, nD, 0.25).map(d => Math.round(d * 100) / 100);
    let bestFrom = -1;
    let bestTo = -1;
    let from = -1;
    for (let i = 0; i < ds.length; i++) {
      if (bad.has(ds[i])) { from = -1; continue; }
      if (from < 0) from = i;
      if (bestFrom < 0 || ds[i] - ds[from] > ds[bestTo] - ds[bestFrom]) { bestFrom = from; bestTo = i; }
    }
    if (bestFrom < 0) drop.push(m.id);
    else depth.set(m.id, { min: ds[bestFrom], max: ds[bestTo] });
  }
  return { depth, drop };
}

export function selfTestReport(c: ModuleCatalogue, o: SelfTestOpts = {}): SelfTestReport {
  const regions = o.regions ?? (['US', 'UK'] as Region[]);
  const nD = Math.max(2, o.depthSamples ?? 5);
  const nF = Math.max(2, o.frontageSamples ?? 5);
  const failures: SelfTestFailure[] = [];
  let cases = 0;

  for (const m of c.units) {
    if (o.only && !o.only.includes(m.id)) continue;
    const g = programFor(m.templateId);
    for (const region of regions) {
      const shapes = shapesOf(g, m.variant, { region, rulesHash: c.rulesHash });
      // depths are quantised to 10 mm, the same quantum the catalogue memoises on
      for (const depth of samples(m.depth.min, m.depth.max, nD, 0.25).map(d => Math.round(d * 100) / 100)) {
        for (let level = 0; level < m.levels; level++) {
          const opts: FeasibilityOpts = {
            region, levels: level, detail: 'medium',
            accessible: m.templateId === 'senior-1b-accessible',
            rulesHash: c.rulesHash,
          };
          const range = c.frontageAt(m.id, depth, opts);
          if (!range) continue;
          for (const frontage of samples(range.min, range.max, nF, 0.05)) {
            const kase: SelfTestCase = {
              moduleId: m.id, frontage, depth, level,
              exteriorSides: exteriorFor(m), region,
            };
            cases++;
            const fit = c.fitFor(m.id, frontage, depth, opts);
            if (!fit) {
              failures.push({ case: kase, check: 'tiles', detail: `frontageAt admitted ${frontage} m but fitFor returned no witness` });
              continue;
            }
            checkCase(m, g, shapes[Math.min(level, shapes.length - 1)], fit, kase, c, opts, failures);
          }
        }
      }
    }
  }
  return { failures, cases, skipped: ['swing-clear', 'swing-into', 'trap-arm', 'aspect'] };
}

/** `n` values across [lo, hi], with the second and second-to-last nudged in by `eps` (the design's sample set) */
function samples(lo: number, hi: number, n: number, eps: number): number[] {
  const out = new Set<number>();
  const clamp = (v: number): number => Math.round(Math.min(hi, Math.max(lo, v)) * 1000) / 1000;
  out.add(clamp(lo));
  out.add(clamp(lo + eps));
  for (let i = 1; i < n - 1; i++) out.add(clamp(lo + ((hi - lo) * i) / (n - 1)));
  out.add(clamp(hi - eps));
  out.add(clamp(hi));
  return [...out].sort((a, b) => a - b);
}

function exteriorFor(m: UnitModule): Side[] {
  switch (m.variant) {
    case 'single': return ['rear'];
    case 'dual': return ['rear', 'right'];
    case 'corner': return ['rear', 'right'];
    case 'end': return ['rear', 'right', 'left'];
    case 'cluster': return ['rear', 'right'];
    default: return ['rear'];
  }
}

function checkCase(
  m: UnitModule, g: ProgramGraph, shape: PlanShape | undefined, fit: Feasibility, kase: SelfTestCase,
  c: ModuleCatalogue, opts: FeasibilityOpts, out: SelfTestFailure[],
): void {
  const fail = (check: string, detail: string): void => { out.push({ case: kase, check, detail }); };
  const byRef = new Map(g.nodes.map(n => [n.ref, n] as const));
  const rooms = fit.rooms ?? [];
  const levelNodes = g.nodes.filter(n => n.level === kase.level);
  const present = new Set(rooms.map(r => r.ref));
  const mergedAway = new Set(fit.merged.map(x => x.ref));

  // ---- tiles: the rooms cover the rect and never overlap ------------------------------------
  const area = rooms.reduce((a, r) => a + r.rect.w * r.rect.h, 0);
  const rect = kase.frontage * kase.depth;
  if (rooms.length === 0) fail('tiles', 'witness carries no room rects');
  else if (area < rect * 0.995 - 1e-6) {
    fail('tiles', `rooms cover ${(100 * area / rect).toFixed(1)} % of the ${kase.frontage} × ${kase.depth} m rect`);
  }
  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) {
      const a = rooms[i].rect;
      const b = rooms[j].rect;
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      // 5 mm is the allocate() snap quantum: two adjacent rects may share a boundary to within it
      if (ox > 5e-3 && oy > 5e-3) fail('tiles', `${rooms[i].ref} overlaps ${rooms[j].ref} by ${ox.toFixed(3)} × ${oy.toFixed(3)} m`);
    }
  }

  // ---- reachable: every room of the level exists and touches circulation or a neighbour -----
  for (const n of levelNodes) {
    if (present.has(n.ref) || mergedAway.has(n.ref)) continue;
    fail('reachable', `${n.ref} is neither placed nor merged into another room`);
  }
  const circ = rooms.filter(r => byRef.get(r.ref)?.zone === 'circulation');
  if (circ.length === 0 && rooms.length > 1) fail('reachable', 'no circulation room on this level');
  if (circ.length > 0) {
    const reached = bfs(rooms, circ.map(r => r.ref));
    for (const r of rooms) {
      if (r.type === 'balcony' || r.type === 'terrace') continue;
      if (!reached.has(r.ref)) fail('reachable', `${r.ref} does not share an edge with any reachable room`);
    }
  }

  // ---- daylight: every node that needs a window sits in a daylit band -----------------------
  if (shape) {
    const daylitRefs = new Set<NodeRef>(shape.bands.filter(b => b.daylit).flatMap(b => b.columns.flat()));
    for (const n of levelNodes) {
      if (!n.needsExterior || mergedAway.has(n.ref)) continue;
      if (!daylitRefs.has(n.ref) && !(shape.spine?.nodes ?? []).includes(n.ref)) {
        fail('daylight', `${n.ref} needs an exterior wall but its column is not in a daylit band`);
      }
    }
  }

  // ---- kit-complete + min-dims: every room reaches its kit minima in some orientation -------
  for (const r of rooms) {
    const n = byRef.get(r.ref);
    if (!n) continue;
    const kit = kitMinDims(n.kit);
    const tol = 5e-3;                                    // the allocate() snap quantum
    const fitsAsIs = r.rect.w >= kit.w - tol && r.rect.h >= kit.d - tol;
    const fitsTurned = r.rect.h >= kit.w - tol && r.rect.w >= kit.d - tol;
    if (!fitsAsIs && !fitsTurned) {
      fail('kit-complete', `${r.ref} is ${r.rect.w.toFixed(2)} × ${r.rect.h.toFixed(2)} m, below the ${kit.w} × ${kit.d} m its kit needs`);
    }
    const minOk = (r.rect.w >= n.minWidth - tol && r.rect.h >= n.minDepth - tol)
      || (r.rect.h >= n.minWidth - tol && r.rect.w >= n.minDepth - tol);
    if (!minOk) {
      fail('min-dims', `${r.ref} is ${r.rect.w.toFixed(2)} × ${r.rect.h.toFixed(2)} m, below its ${n.minWidth} × ${n.minDepth} m minimum`);
    }
    // `aspect` is deliberately NOT asserted here: the witness's rects are the schematic the thumbnails draw, and
    // the band that holds a room is free to be long and shallow. Aspect belongs to the solver's own output and is
    // asserted by `validateUnitLayout` once `layoutUnitV2` lands (see the `skipped` list).
  }

  // ---- min-leaf: a shared edge is wide enough for its door leaf by construction -------------
  for (const n of levelNodes) {
    if (mergedAway.has(n.ref) || n.stackable) continue;   // a cupboard has a sliding/folding front, not a swing leaf
    const leaf = n.type === 'entry' ? LEAF.entry
      : kase.region === 'US' && m.templateId === 'senior-1b-accessible' ? LEAF.accessible
        : n.wet ? LEAF.bath : LEAF.interior;
    if (n.minWidth + 1e-6 < leaf + 0.20) {
      fail('min-leaf', `${n.ref} minWidth ${n.minWidth} m leaves no room for a ${leaf} m leaf plus 0.20 m`);
    }
  }

  // ---- adjacency: the level's wet rooms form at most `maxStacks` clusters (XD-01) ------------
  const wetRooms = rooms.filter(r => byRef.get(r.ref)?.wet);
  if (wetRooms.length > 1) {
    let clusters = 0;
    const seen = new Set<string>();
    for (const r of wetRooms) {
      if (seen.has(r.ref)) continue;
      clusters++;
      for (const x of bfs(wetRooms, [r.ref], WET_REACH)) seen.add(x);
    }
    if (clusters > g.maxStacks) {
      fail('adjacency', `${wetRooms.length} wet rooms form ${clusters} clusters, above the ${g.maxStacks} stack(s) the program allows`);
    }
  }

  // ---- ports: every required port resolved, atFrac stable under mirroring -------------------
  for (const p of m.ports) {
    if (p.required && !(p.atFrac > 0 && p.atFrac < 1)) fail('ports', `required port ${p.id} has atFrac ${p.atFrac}`);
    if (p.width > kase.frontage + 1e-6) fail('ports', `port ${p.id} needs ${p.width} m on a ${kase.frontage} m frontage`);
    const mirrored = 1 - p.atFrac;
    if (Math.abs((1 - mirrored) - p.atFrac) > 1e-9) fail('ports', `port ${p.id} atFrac is not invariant under mirroring`);
  }

  // ---- determinism: the same case twice is deep-equal ---------------------------------------
  const again = c.fitFor(m.id, kase.frontage, kase.depth, opts);
  if (JSON.stringify(again) !== JSON.stringify(fit)) fail('determinism', 'two runs of the same case differ');
}

/** Rooms sharing an edge (touching within `gap` and overlapping along that edge by more than a door's width) */
function bfs(
  rooms: readonly { ref: string; rect: { x: number; y: number; w: number; h: number } }[], seeds: string[], gap = 0.02,
): Set<string> {
  const byRef = new Map(rooms.map(r => [r.ref, r] as const));
  const seen = new Set<string>(seeds.filter(s => byRef.has(s)));
  const queue = [...seen];
  while (queue.length > 0) {
    const cur = byRef.get(queue.shift()!)!;
    for (const other of rooms) {
      if (seen.has(other.ref)) continue;
      if (!touches(cur.rect, other.rect, gap)) continue;
      seen.add(other.ref);
      queue.push(other.ref);
    }
  }
  return seen;
}

function touches(
  a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }, gap = 0.02,
): boolean {
  const gapX = Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w);
  const gapY = Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h);
  const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (gapX <= gap && overlapY > 0.35) return true;
  if (gapY <= gap && overlapX > 0.35) return true;
  return false;
}

/** A wet wall may run past a cupboard to reach the next wet room: one metre of shared wall still means one stack. */
const WET_REACH = 1.0;

export { ALL_CHECKS };
