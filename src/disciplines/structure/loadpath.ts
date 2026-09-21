/**
 * Load-path constructability — STR-C1 … STR-C5.
 *
 * v1 generated columns independently per storey and took footings from the lowest storey's columns only, so a
 * column could land on nothing, a transfer beam could hang between two unsupported ends, a core could stop
 * mid-height and a slab edge or balcony could cantilever as far as the plan happened to reach — all silently.
 * This module is the check that makes those impossible to ship unnoticed:
 *
 *   STR-C1 column / bearing-wall continuity: every support on storey k lands on a column or wall on k−1, or on a
 *          transfer beam whose BOTH ends land on supports on k−1.
 *   STR-C2 a foundation under every lowest support on each vertical line.
 *   STR-C3 core and shear walls continuous from the lowest framed storey to their top storey.
 *   STR-C4 slab edge within min(2.0, 10 × slabT) of a rim beam, bearing wall or column line.
 *   STR-C5 balcony cantilever L ≤ min(maxCantilever, B/2) and thickness t ≥ max(0.18, L/10). Architecture emits
 *          the balcony slab; structure is still the discipline that has to verify it.
 *
 * Complexity is O(Σ supports) with hash lookups — no pairwise loop.
 */
import type {
  BalconyDef, Rect, Segment2, StoreyDef, StructBeam, StructColumn, StructSlab, StructWall, Vec2,
} from '../../core/types.ts';
import type { Issue, Ledger } from '../../core/rules/types.ts';
import type { LoadPathInput, LoadPathNode, LoadPathResult, Support } from '../../core/kernel/types.ts';
import { dist, pointInPolygon, polygonBounds, round } from '../../core/geometry.ts';

/** Plan tolerance for "the same vertical line" (m): half a column, so a 0.15 m offset is still one line. */
const TOL = 0.15;

function keyOf(p: Vec2, tol: number): string {
  return `${Math.round(p[0] / tol)}:${Math.round(p[1] / tol)}`;
}

/** The 9 cells of a 3×3 neighbourhood, so a point 0.14 m away is still found in one hash lookup */
function neighbourKeys(p: Vec2, tol: number): string[] {
  const i = Math.round(p[0] / tol);
  const j = Math.round(p[1] / tol);
  const out: string[] = [];
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) out.push(`${i + a}:${j + b}`);
  return out;
}

function midOf(a: Vec2, b: Vec2): Vec2 {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

function rectOf(p: Vec2, w: number, d: number): Rect {
  return { x: p[0] - w / 2, y: p[1] - d / 2, w, h: d };
}

/** Distance from `p` to the segment a–b */
function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const l2 = vx * vx + vy * vy;
  if (l2 < 1e-12) return dist(p, a);
  let t = ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / l2;
  t = Math.max(0, Math.min(1, t));
  return dist(p, [a[0] + vx * t, a[1] + vy * t]);
}

function rectContains(r: Rect, p: Vec2, margin: number): boolean {
  return p[0] >= r.x - margin && p[0] <= r.x + r.w + margin && p[1] >= r.y - margin && p[1] <= r.y + r.h + margin;
}

/** A wall line keyed for continuity: the axis-aligned centreline rounded to 0.1 m */
function wallLineKey(w: StructWall): string {
  const a = w.start;
  const b = w.end;
  const [lo, hi] = a[0] + a[1] <= b[0] + b[1] ? [a, b] : [b, a];
  return `${Math.round(lo[0] * 10)}:${Math.round(lo[1] * 10)}:${Math.round(hi[0] * 10)}:${Math.round(hi[1] * 10)}`;
}

interface StoreyLayer {
  storey: StoreyDef;
  columns: StructColumn[];
  walls: StructWall[];
  transfers: StructBeam[];
  /** transfer beams whose own two ends land on a column, a wall, or a column-to-column transfer beam */
  supportedTransfers: StructBeam[];
  /** column XY hash */
  colAt: Map<string, StructColumn>;
}

type Recorder = (key: string, d: Parameters<Ledger['add']>[0]) => void;

interface Walk {
  layers: StoreyLayer[];
  indexOfStorey: Map<string, number>;
  nodes: LoadPathNode[];
  bases: Support[];
  carried: number;
  viaTransfer: number;
  unsupported: number;
}

/**
 * STR-C1: the continuity walk, top storey to bottom. Shared by `checkLoadPath` and `loadPathBases`, so the
 * footing generator and the checker agree on exactly which supports are bases by construction.
 */
function walkSupports(
  o: Pick<LoadPathInput, 'storeysAscending' | 'columns' | 'walls' | 'beams'>, tol: number, record: Recorder | null,
): Walk {
  const ascending = [...o.storeysAscending].filter(s => s.index > -100 && s.index < 100).sort((a, b) => a.index - b.index);
  const layers: StoreyLayer[] = ascending.map(s => ({ storey: s, columns: [], walls: [], transfers: [], supportedTransfers: [], colAt: new Map() }));
  const layerOf = new Map<string, StoreyLayer>(layers.map(l => [l.storey.id, l]));
  const indexOfStorey = new Map<string, number>(layers.map((l, k) => [l.storey.id, k]));

  for (const c of o.columns) layerOf.get(c.storey)?.columns.push(c);
  for (const w of o.walls) {
    const l = layerOf.get(w.storey);
    if (!l || w.role === 'foundation') continue;
    l.walls.push(w);
  }
  for (const bm of o.beams) if (bm.role === 'transfer') layerOf.get(bm.storey)?.transfers.push(bm);
  for (const l of layers) for (const c of l.columns) l.colAt.set(keyOf(c.position, tol), c);
  const coreWallIds = new Set<string>(o.walls.filter(w => w.role === 'core' || w.role === 'shear').map(w => w.id));

  /** Is the point on a column or a bearing/core/shear wall of this storey? */
  const onVertical = (l: StoreyLayer, p: Vec2, slack: number): boolean => {
    for (const k of neighbourKeys(p, tol)) {
      const hit = l.colAt.get(k);
      if (hit && dist(hit.position, p) <= slack + Math.max(hit.width, hit.depth) / 2) return true;
    }
    for (const w of l.walls) if (distToSegment(p, w.start, w.end) <= slack + w.thickness / 2) return true;
    return false;
  };

  // A transfer grillage is two-level: primary beams run column to column, secondary beams land on the primaries.
  // Both are "supported"; a beam with a free end carries nothing.
  for (const l of layers) {
    const primary = l.transfers.filter(bm => onVertical(l, bm.start, tol * 2) && onVertical(l, bm.end, tol * 2));
    const onPrimary = (p: Vec2): boolean => primary.some(bm => distToSegment(p, bm.start, bm.end) <= tol * 2 + bm.width / 2);
    l.supportedTransfers = l.transfers.filter(bm =>
      (onVertical(l, bm.start, tol * 2) || onPrimary(bm.start)) && (onVertical(l, bm.end, tol * 2) || onPrimary(bm.end)));
  }

  const supportOf = (l: StoreyLayer): Support[] => {
    const out: Support[] = [];
    for (const c of l.columns) {
      out.push({ id: c.id, kind: 'column', storey: l.storey.id, storeyIndex: l.storey.index, xy: c.position, footprint: rectOf(c.position, c.width, c.depth) });
    }
    for (const w of l.walls) {
      const mid = midOf(w.start, w.end);
      const line: Segment2 = { a: w.start, b: w.end };
      out.push({ id: w.id, kind: 'wall', storey: l.storey.id, storeyIndex: l.storey.index, xy: mid, footprint: rectOf(mid, Math.max(w.thickness, Math.abs(w.end[0] - w.start[0])), Math.max(w.thickness, Math.abs(w.end[1] - w.start[1]))), line });
    }
    return out;
  };

  /** Does anything on `below` carry the point `p`? */
  const carrier = (below: StoreyLayer | null, p: Vec2): { id: string; via: LoadPathNode['via'] } | null => {
    if (!below) return null;
    for (const k of neighbourKeys(p, tol)) {
      const hit = below.colAt.get(k);
      if (hit && dist(hit.position, p) <= tol + Math.max(hit.width, hit.depth) / 2) return { id: hit.id, via: 'column' };
    }
    for (const w of below.walls) {
      if (distToSegment(p, w.start, w.end) <= tol + w.thickness / 2) return { id: w.id, via: 'wall' };
    }
    for (const bm of below.supportedTransfers) {
      if (distToSegment(p, bm.start, bm.end) <= tol + bm.width / 2) return { id: bm.id, via: 'transfer' };
    }
    return null;
  };

  const nodes: LoadPathNode[] = [];
  const bases: Support[] = [];
  let carried = 0;
  let viaTransfer = 0;
  let unsupported = 0;
  for (let k = layers.length - 1; k >= 0; k--) {
    const below = k > 0 ? layers[k - 1] : null;
    for (const s of supportOf(layers[k])) {
      const hit = carrier(below, s.xy);
      if (hit) {
        nodes.push({ support: s, carriedBy: hit.id, via: hit.via });
        carried += 1;
        if (hit.via === 'transfer') viaTransfer += 1;
        continue;
      }
      nodes.push({ support: s, carriedBy: null, via: null });
      if (below === null) {
        bases.push(s);
        continue;
      }
      // A core or shear wall that stops mid-height is STR-C3's story, not STR-C1's: one defect, one issue.
      if (coreWallIds.has(s.id)) continue;
      unsupported += 1;
      record?.(`STR-C1:${s.storey}:${s.id}`, {
        severity: 'violation',
        ruleId: 'STR-C1.columnContinuity',
        discipline: 'structure',
        storey: s.storey,
        elementIds: [s.id],
        message: `${s.kind} ${s.id} on ${s.storey} lands on nothing on ${below.storey.id}: no column, bearing wall or fully supported transfer beam within ${tol.toFixed(2)} m.`,
        observed: `${round(s.xy[0], 2)},${round(s.xy[1], 2)}`,
        limit: round(tol, 3),
        source: 'ACI 318-19 §18 (transfer of forces at discontinuities)',
      });
    }
  }
  return { layers, indexOfStorey, nodes, bases, carried, viaTransfer, unsupported };
}

/**
 * STR-C2 input: the lowest support on each vertical line, i.e. what needs a foundation. Runs the same walk as
 * `checkLoadPath` but records nothing, so the footing generator can run BEFORE the checks.
 */
export function loadPathBases(
  o: Pick<LoadPathInput, 'storeysAscending' | 'columns' | 'walls' | 'beams' | 'rules'>,
): readonly Support[] {
  return walkSupports(o, o.rules.num('STR-C1.continuityTolerance', TOL), null).bases;
}

export function checkLoadPath(o: LoadPathInput): LoadPathResult {
  const { rules, ledger, presize } = o;
  const issues: Issue[] = [];
  const tol = rules.num('STR-C1.continuityTolerance', TOL);
  const record: Recorder = (key, d) => {
    const added = ledger.addOnce(key, d);
    if (added) issues.push(added);
  };

  const walk = walkSupports(o, tol, record);
  const { layers, indexOfStorey, nodes, bases, carried, viaTransfer, unsupported } = walk;

  // ---------------------------------------------------------------- STR-C2 foundation under every base
  const fndPoints: { p: Vec2; r: Rect | null }[] = [];
  const fndLines: { a: Vec2; b: Vec2; w: number }[] = [];
  let raft: Rect | null = null;
  for (const f of o.foundations) {
    if (f.type === 'raft' || f.type === 'slab-on-grade') { if (f.rect) raft = f.rect; continue; }
    if (!f.position) continue;
    const w = f.width ?? 0.6;
    const d = f.depth ?? 0.6;
    if (f.type === 'strip' && f.length !== undefined && f.length > Math.min(w, d) * 1.5) {
      const alongX = w >= d;
      const half = f.length / 2;
      fndLines.push(alongX
        ? { a: [f.position[0] - half, f.position[1]], b: [f.position[0] + half, f.position[1]], w: d }
        : { a: [f.position[0], f.position[1] - half], b: [f.position[0], f.position[1] + half], w });
      continue;
    }
    fndPoints.push({ p: f.position, r: rectOf(f.position, w, d) });
  }
  // Stem walls sit on the strip footings and are what the wall above actually bears on
  for (const w of o.walls) {
    if (w.role !== 'foundation') continue;
    fndLines.push({ a: w.start, b: w.end, w: Math.max(w.thickness, 0.3) });
  }

  const founded = (s: Support): boolean => {
    if (raft && rectContains(raft, s.xy, 0.5)) return true;
    for (const f of fndPoints) if (f.r && rectContains(f.r, s.xy, tol)) return true;
    for (const l of fndLines) if (distToSegment(s.xy, l.a, l.b) <= l.w / 2 + tol) return true;
    // A wall bears along its whole line: any part of it over a footing line counts
    if (s.line) {
      for (const l of fndLines) {
        if (distToSegment(s.line.a, l.a, l.b) <= l.w / 2 + tol || distToSegment(s.line.b, l.a, l.b) <= l.w / 2 + tol) return true;
      }
      for (const f of fndPoints) if (f.r && distToSegment([f.r.x + f.r.w / 2, f.r.y + f.r.h / 2], s.line.a, s.line.b) <= Math.max(f.r.w, f.r.h) / 2 + tol) return true;
    }
    return false;
  };

  let unfounded = 0;
  for (const s of bases) {
    if (founded(s)) continue;
    unfounded += 1;
    record(`STR-C2:${s.storey}`, {
      severity: 'violation',
      ruleId: 'STR-C2.foundationUnderSupport',
      discipline: 'structure',
      storey: s.storey,
      elementIds: [s.id],
      message: `${s.kind} ${s.id} is the lowest support on its line but no foundation reaches ${round(s.xy[0], 2)},${round(s.xy[1], 2)}.`,
      observed: `${round(s.xy[0], 2)},${round(s.xy[1], 2)}`,
      source: 'ACI 318-19 §13.1; EN 1997-1 §6',
    });
  }

  // ---------------------------------------------------------------- STR-C3 core / shear wall continuity
  const coreLines = new Map<string, { storeys: Set<string>; wall: StructWall }>();
  for (const w of o.walls) {
    if (w.role !== 'core' && w.role !== 'shear') continue;
    const k = wallLineKey(w);
    const entry = coreLines.get(k);
    if (entry) entry.storeys.add(w.storey);
    else coreLines.set(k, { storeys: new Set([w.storey]), wall: w });
  }
  let discontinuousCores = 0;
  for (const [k, entry] of [...coreLines.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const positions = [...entry.storeys].map(s => indexOfStorey.get(s)).filter((v): v is number => v !== undefined).sort((a, b) => a - b);
    if (positions.length === 0) continue;
    const top = positions[positions.length - 1];
    // A core wall must exist on every framed storey from the LOWEST framed storey up to its own top.
    const missing: string[] = [];
    for (let p = 0; p <= top; p++) if (!positions.includes(p)) missing.push(layers[p].storey.id);
    if (missing.length === 0) continue;
    discontinuousCores += 1;
    record(`STR-C3:${k}`, {
      severity: 'violation',
      ruleId: 'STR-C3.coreContinuity',
      discipline: 'structure',
      storey: missing[0],
      elementIds: [entry.wall.id],
      message: `${entry.wall.role} wall line from ${entry.wall.start.map(v => round(v, 2)).join(',')} to ${entry.wall.end.map(v => round(v, 2)).join(',')} is missing on ${missing.join(', ')} but continues above — the shear spine must be continuous to the foundation.`,
      observed: missing.length,
      limit: 0,
      source: 'ACI 318-19 §18.10; ASCE 7-22 §12.3.3 (vertical irregularity)',
    });
  }

  // ---------------------------------------------------------------- STR-C4 slab edge support
  const maxCantileverOf = (slabT: number): number => Math.min(
    rules.num('STR-C4.maxCantilever', 2.0),
    rules.num('STR-C4.spanDepthCantilever', 10) * slabT,
  );
  const edgeSampleStep = rules.num('STR-C4.edgeSampleStep', 1.0);
  let unsupportedEdges = 0;
  let edgeSamples = 0;
  for (const slab of o.slabs) {
    // A ground / base slab and a raft bear on the ground; a balcony is checked by STR-C5.
    if (slab.type === 'ground' || slab.type === 'balcony') continue;
    const below = supportLayerBelow(layers, indexOfStorey, slab.storey);
    if (!below) continue;
    // The ground-floor plate is AT grade: wherever it reaches past the basement below it, it bears on the
    // ground, not on a cantilever. (Any higher plate reaching past the storey below really is a cantilever.)
    const atGrade = (indexOfStorey.get(slab.storey) !== undefined && below.storey.index < 0
      && layers[indexOfStorey.get(slab.storey)!].storey.index === 0);
    const belowOutline = atGrade ? (o.slabs.find(s => s.storey === below.storey.id)?.outline ?? null) : null;
    const limit = maxCantileverOf(slab.thickness);
    let worst = 0;
    let worstAt: Vec2 = [0, 0];
    for (const p of sampleOutline(slab.outline, edgeSampleStep)) {
      edgeSamples += 1;
      if (belowOutline && !pointInPolygon(p, belowOutline)) continue;
      const d = nearestSupportDistance(below, o.beams, p);
      if (d > worst) { worst = d; worstAt = p; }
    }
    if (worst <= limit + 1e-6) continue;
    unsupportedEdges += 1;
    record(`STR-C4:${slab.storey}`, {
      severity: 'violation',
      ruleId: 'STR-C4.slabEdgeSupport',
      discipline: 'structure',
      storey: slab.storey,
      elementIds: [slab.id],
      message: `slab ${slab.id} on ${slab.storey} cantilevers ${worst.toFixed(2)} m past the nearest rim beam, bearing wall or column at ${round(worstAt[0], 2)},${round(worstAt[1], 2)}; a ${(slab.thickness * 1000).toFixed(0)} mm slab allows ${limit.toFixed(2)} m.`,
      observed: round(worst, 3),
      limit: round(limit, 3),
      source: 'ACI 318-19 Table 9.3.1.1 (cantilever ℓ/10); EN 1992-1-1 §7.4.2',
    });
  }

  // ---------------------------------------------------------------- STR-C5 balconies
  const minBalconyT = rules.num('STR-C5.minBalconyThickness', 0.18);
  const cantileverRatio = rules.num('STR-C5.thicknessSpanRatio', 10);
  const balconyT = new Map<string, number>();
  for (const s of o.slabs) {
    if (s.type !== 'balcony') continue;
    const b = polygonBounds(s.outline);
    balconyT.set(`${s.storey}:${Math.round(b.x * 10)}:${Math.round(b.y * 10)}`, s.thickness);
  }
  let balconiesVerified = 0;
  let balconyGeometryFails = 0;
  let balconyThicknessFails = 0;
  for (const bal of [...o.balconies].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const host = hostSlabOf(o.slabs, bal);
    if (!host) continue;
    balconiesVerified += 1;
    const { cantilever, backspan } = cantileverOf(bal, host);
    const limit = Math.min(maxCantileverOf(host.thickness), backspan / 2);
    if (cantilever > limit + 1e-6) {
      balconyGeometryFails += 1;
      record(`STR-C5:geom:${bal.storey}`, {
        severity: 'violation',
        ruleId: 'STR-C5.balconyCantilever',
        discipline: 'structure',
        storey: bal.storey,
        unitId: bal.unitId,
        elementIds: [bal.id],
        message: `balcony ${bal.id} cantilevers ${cantilever.toFixed(2)} m with only ${backspan.toFixed(2)} m of backspan; the limit is min(${maxCantileverOf(host.thickness).toFixed(2)}, backspan/2) = ${limit.toFixed(2)} m.`,
        observed: round(cantilever, 3),
        limit: round(limit, 3),
        source: 'ACI 318-19 Table 9.3.1.1; EN 1992-1-1 §7.4.2',
      });
    }
    const t = balconyT.get(`${bal.storey}:${Math.round(bal.rect.x * 10)}:${Math.round(bal.rect.y * 10)}`);
    const need = Math.max(minBalconyT, cantilever / cantileverRatio);
    if (t !== undefined && t < need - 1e-6) {
      balconyThicknessFails += 1;
      record('STR-C5:thickness', {
        severity: 'violation',
        ruleId: 'STR-C5.balconyCantilever',
        discipline: 'structure',
        storey: bal.storey,
        unitId: bal.unitId,
        elementIds: [bal.id],
        message: `balcony ${bal.id} is ${(t * 1000).toFixed(0)} mm thick over a ${cantilever.toFixed(2)} m cantilever; ACI 318-19 Table 9.3.1.1 wants at least ${(need * 1000).toFixed(0)} mm (max(180 mm, L/10)).`,
        observed: round(t, 3),
        limit: round(need, 3),
        source: 'ACI 318-19 Table 9.3.1.1; EN 1992-1-1 §7.4.2',
      });
    }
  }

  const derived: Record<string, number> = {
    supports: nodes.length,
    supportsCarried: carried,
    supportsOnTransfer: viaTransfer,
    bases: bases.length,
    unsupportedSupports: unsupported,
    unfoundedBases: unfounded,
    discontinuousCoreLines: discontinuousCores,
    slabEdgeSamples: edgeSamples,
    unsupportedSlabEdges: unsupportedEdges,
    balconiesVerified,
    balconyCantileverFails: balconyGeometryFails,
    balconyThicknessFails,
    transferStoreyPresent: presize.transferStorey ? 1 : 0,
  };

  return { nodes, bases, issues, derived };
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------

function supportLayerBelow(
  layers: StoreyLayer[], indexOfStorey: Map<string, number>, storey: string,
): StoreyLayer | null {
  const k = indexOfStorey.get(storey);
  if (k === undefined) {
    // ROOF: supported by the topmost framed storey
    return layers.length > 0 ? layers[layers.length - 1] : null;
  }
  return k > 0 ? layers[k - 1] : null;
}

/** Points along a polygon boundary, one every `step` metres, vertices always included */
function sampleOutline(outline: readonly Vec2[], step: number): Vec2[] {
  const out: Vec2[] = [];
  if (outline.length < 2) return out;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % outline.length];
    const l = dist(a, b);
    out.push(a);
    const n = Math.floor(l / Math.max(0.25, step));
    for (let k = 1; k < n; k++) {
      const t = (k * step) / l;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

function nearestSupportDistance(below: StoreyLayer, beams: readonly StructBeam[], p: Vec2): number {
  let best = Number.POSITIVE_INFINITY;
  for (const c of below.columns) {
    const d = dist(c.position, p);
    if (d < best) best = d;
    if (best < 1e-3) return 0;
  }
  for (const w of below.walls) {
    const d = distToSegment(p, w.start, w.end) - w.thickness / 2;
    if (d < best) best = d;
    if (best < 1e-3) return 0;
  }
  for (const bm of beams) {
    if (bm.storey !== below.storey.id) continue;
    if (bm.role === 'lintel') continue;
    const d = distToSegment(p, bm.start, bm.end) - bm.width / 2;
    if (d < best) best = d;
    if (best < 1e-3) return 0;
  }
  return Number.isFinite(best) ? Math.max(0, best) : 0;
}

/** The structural floor slab the balcony hangs off */
function hostSlabOf(slabs: readonly StructSlab[], bal: BalconyDef): StructSlab | null {
  let best: StructSlab | null = null;
  for (const s of slabs) {
    if (s.storey !== bal.storey || s.type === 'balcony') continue;
    if (best === null || s.thickness > best.thickness) best = s;
  }
  return best;
}

/**
 * Cantilever length and backspan of a balcony against its host plate: the cantilever is how far the balcony rect
 * reaches past the plate edge it is attached to; the backspan is the plate depth behind that edge, capped at the
 * nearest interior support line is not known here, so the plate half-depth is used (conservative in the same
 * direction as the code check).
 */
function cantileverOf(bal: BalconyDef, host: StructSlab): { cantilever: number; backspan: number } {
  const b = polygonBounds(host.outline);
  const r = bal.rect;
  const outLeft = Math.max(0, b.x - r.x);
  const outRight = Math.max(0, r.x + r.w - (b.x + b.w));
  const outFront = Math.max(0, b.y - r.y);
  const outRear = Math.max(0, r.y + r.h - (b.y + b.h));
  const outward = Math.max(outLeft, outRight, outFront, outRear);
  const alongY = outward === outFront || outward === outRear;
  // Nothing sticks out: the balcony is inset (a recessed loggia) — it spans onto the plate, not off it.
  const cantilever = outward > 0.05 ? outward : Math.min(r.w, r.h);
  const backspan = alongY ? b.h / 2 : b.w / 2;
  return { cantilever: round(cantilever, 4), backspan: round(Math.max(0, backspan), 4) };
}

export type { LoadPathInput, LoadPathNode, LoadPathResult, Support };
