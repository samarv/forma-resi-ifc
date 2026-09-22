/**
 * Internal generation state and element emitters for the plumbing discipline.
 *
 * Z CONVENTIONS (all storey-local, 0 = top of this storey's structural slab)
 *   -1.2   sewer / storm lateral leaving the building (L01 only)
 *   -1.0   buried storm main (L01 only)
 *   -0.9   buried cold water service (L01 only)
 *   -0.55  building drain collector below the ground slab (L01 only)
 *   -0.12  trap arms / waste branches, in the floor build-up under the fixture
 *    0.00  finished floor, fixture connection point
 *    0.45  DCW branch in the wet wall
 *    0.55  DHW branch in the wet wall
 *    1.50  branch vent above the fixture flood rim
 *  pipeZ   corridor mains (core/coordination.plenumBands → below the duct band)
 *  ceiling-0.05  sprinkler heads
 */
import type {
  GenContext, ModelElement, PatternApplication, PipeRun, PipeSystemType, PlumbingFixture,
  PlumbingStack, FloorPlan, Rect, StoreyDef, Vec2, Vec3, PropertySetDef,
} from '../../core/types.ts';
import { IdFactory, systemId } from '../../core/ids.ts';
import { plenumBands, type PlenumBands } from '../../core/coordination.ts';
import { dist, polygonBounds, round } from '../../core/geometry.ts';
import { SYSTEM_COLOR, SYSTEM_NAME, FIXTURE_COLOR, FIXTURES, type FixtureType } from './tables.ts';
import {
  isOrthogonal, orthogonalize, polylineLength, splitPath, MAX_RUN_POINTS, TRUNK_SOFFIT_DROP,
} from './routing.ts';

export const WASTE_Z = -0.12;
export const DCW_BRANCH_Z = 0.45;
export const DHW_BRANCH_Z = 0.55;
export const BRANCH_VENT_Z = 1.5;
export const SERVICE_Z = -0.9;
export const BUILDING_DRAIN_Z = -0.55;
export const SEWER_Z = -1.2;
export const STORM_MAIN_Z = -1.0;
export const MIN_SEGMENT = 0.02;
/** Spacing of the parallel pipes inside a wet wall */
export const STACK_PIPE_SPACING = 0.08;
/** A single PipeRun may not be longer than this multiple of the floor outline's longest dimension */
export const RUN_LENGTH_FACTOR = 1.5;

export interface StoreyInfo {
  id: string;
  index: number;
  elevation: number;
  /** Floor-to-floor height (m) */
  f2f: number;
  ceiling: number;
  slabT: number;
  use: string;
  /** Carries dwellings */
  hasUnits: boolean;
  plan: FloorPlan | null;
  bands: PlenumBands;
  /** This storey has corridor rooms, so mains follow the corridor service spine (XD-02) */
  hasCorridors: boolean;
  /** Z of a trunk on a floor with no corridor: just under the slab soffit */
  trunkZ: number;
  /** Cap on the developed length of ONE PipeRun on this storey (RUN_LENGTH_FACTOR x longest plan dimension) */
  maxRunLength: number;
}

export interface StackInfo {
  stack: PlumbingStack;
  /** Unit wall direction (unit vector) the stack sits on */
  dir: Vec2;
  /** Per-system XY (the parallel pipes are offset along the wall) */
  systemXY: Map<PipeSystemType, Vec2>;
  diameters: Map<PipeSystemType, number>;
  /** Wet wall id this stack belongs to, per storey */
  wallIds: Set<string>;
  storeys: string[];
  fixtureIds: string[];
  dfu: number;
  wsfu: number;
  /** Set when the stack was added because a fixture broke the trap-arm limit */
  secondary: boolean;
}

export interface PlumbState {
  ctx: GenContext;
  ids: IdFactory;
  elements: ModelElement[];
  fixtures: PlumbingFixture[];
  pipes: PipeRun[];
  stacks: StackInfo[];
  apps: PatternApplication[];
  storeyInfo: Map<string, StoreyInfo>;
  /** Above-grade + basement storeys in ascending order (no SITE/FND/ROOF) */
  buildingStoreys: StoreyDef[];
  /** Storeys carrying dwellings, ascending */
  unitStoreys: string[];
  roofStorey: string;
  groundStorey: string;
  detail: 'low' | 'medium' | 'high';
  pipeLength: Map<PipeSystemType, number>;
  /** Site bounds used to sanity-check geometry */
  siteBounds: Rect;
  /** Longest plan dimension of any floor (fallback for storeys with no plan) */
  buildingLongestDim: number;
  /** Bars of the massing, used as trunk routes on floors with no corridor */
  bars: Rect[];
  warnedKeys: Set<string>;
  counts: Record<string, number>;
}

export function createState(ctx: GenContext): PlumbState {
  const arch = ctx.arch;
  const planByStorey = new Map<string, FloorPlan>();
  for (const f of arch?.floors ?? []) planByStorey.set(f.storey, f);
  const slabT = ctx.struct?.sizes.slabT ?? 0.2;
  const beamD = ctx.struct?.sizes.beamD ?? 0.3;

  // Longest plan dimension of the whole building — the fallback for the per-run length cap
  let buildingLongestDim = 0;
  for (const f of arch?.floors ?? []) {
    if (f.outline.length < 3) continue;
    const b = polygonBounds(f.outline);
    buildingLongestDim = Math.max(buildingLongestDim, b.w, b.h);
  }
  if (buildingLongestDim <= 0) {
    const b = polygonBounds(ctx.site.boundary.length > 2 ? ctx.site.boundary : [[0, 0], [1, 0], [1, 1], [0, 1]]);
    buildingLongestDim = Math.max(1, b.w, b.h);
  }

  const storeyInfo = new Map<string, StoreyInfo>();
  const buildingStoreys: StoreyDef[] = [];
  for (const s of ctx.storeys) {
    const plan = planByStorey.get(s.id) ?? null;
    const f2f = plan?.floorToFloor ?? (s.height > 0 ? s.height : 3.0);
    const ceiling = plan?.ceilingHeight ?? Math.max(2.2, f2f - 0.45);
    const st = plan?.slabThickness ?? slabT;
    const planLongest = plan && plan.outline.length > 2
      ? Math.max(polygonBounds(plan.outline).w, polygonBounds(plan.outline).h)
      : buildingLongestDim;
    storeyInfo.set(s.id, {
      id: s.id,
      index: s.index,
      elevation: s.elevation,
      f2f,
      ceiling,
      slabT: st,
      use: String(s.use),
      hasUnits: (plan?.unitIds.length ?? 0) > 0,
      plan,
      bands: plenumBands(f2f, st, beamD, ceiling),
      hasCorridors: (plan?.corridors.length ?? 0) > 0,
      trunkZ: round(Math.max(0.6, f2f - st - TRUNK_SOFFIT_DROP), 3),
      maxRunLength: round(RUN_LENGTH_FACTOR * Math.max(1, planLongest), 3),
    });
    if (s.index > -100 && s.index < 100) buildingStoreys.push(s);
  }
  buildingStoreys.sort((a, b) => a.index - b.index);

  const unitStoreys = buildingStoreys.filter(s => storeyInfo.get(s.id)!.hasUnits).map(s => s.id);
  const above = buildingStoreys.filter(s => s.index >= 0);
  const groundStorey = (above[0] ?? buildingStoreys[0])?.id ?? 'L01';
  const roofStorey = ctx.storeys.find(s => s.index === 100)?.id ?? 'ROOF';

  const bounds = polygonBounds(ctx.site.boundary.length > 2 ? ctx.site.boundary : [[0, 0], [1, 0], [1, 1], [0, 1]]);
  const bars = (ctx.site.massing?.bars ?? []).map(b => b.rect).filter(r => r.w > 0.5 && r.h > 0.5);

  return {
    ctx,
    ids: new IdFactory('plumbing'),
    elements: [],
    fixtures: [],
    pipes: [],
    stacks: [],
    apps: [],
    storeyInfo,
    buildingStoreys,
    unitStoreys: unitStoreys.length > 0 ? unitStoreys : above.map(s => s.id),
    roofStorey,
    groundStorey,
    detail: ctx.spec.options.detail,
    pipeLength: new Map(),
    siteBounds: bounds,
    buildingLongestDim,
    bars,
    warnedKeys: new Set(),
    counts: {},
  };
}

export function info(st: PlumbState, storey: string): StoreyInfo {
  const i = st.storeyInfo.get(storey);
  if (i) return i;
  const fallback: StoreyInfo = {
    id: storey, index: 0, elevation: 0, f2f: 3.0, ceiling: 2.55, slabT: 0.2,
    use: 'residential', hasUnits: false, plan: null,
    bands: plenumBands(3.0, 0.2, 0.3, 2.55),
    hasCorridors: false,
    trunkZ: round(3.0 - 0.2 - TRUNK_SOFFIT_DROP, 3),
    maxRunLength: round(RUN_LENGTH_FACTOR * Math.max(1, st.buildingLongestDim), 3),
  };
  st.storeyInfo.set(storey, fallback);
  return fallback;
}

/**
 * Bar rectangles available as trunk routes on a storey: the massing bars that overlap this
 * storey's outline, else the outline itself (a podium plate is wider than the bar above it).
 */
export function barsOn(st: PlumbState, storey: string): Rect[] {
  const plan = info(st, storey).plan;
  const outline = plan && plan.outline.length > 2 ? polygonBounds(plan.outline) : null;
  if (st.bars.length > 1) {
    const hit = outline
      ? st.bars.filter(b => b.x < outline.x + outline.w && outline.x < b.x + b.w
        && b.y < outline.y + outline.h && outline.y < b.y + b.h)
      : st.bars;
    if (hit.length > 0) return hit;
  }
  if (outline) return [outline];
  return st.bars.length > 0 ? st.bars : [st.siteBounds];
}

/** Deduplicated warning (one per key) */
export function warn(st: PlumbState, key: string, message: string): void {
  if (st.warnedKeys.has(key)) return;
  st.warnedKeys.add(key);
  st.ctx.warnings.push(`[plumbing] ${message}`);
}

/** v2: a resolution applied by construction — recorded as an info issue, never projected into warnings */
export function noteInfo(st: PlumbState, key: string, ruleId: string, message: string, resolution: 'vent-branch' | 'none' = 'vent-branch'): void {
  if (st.warnedKeys.has(key)) return;
  st.warnedKeys.add(key);
  st.ctx.issues?.add({ severity: 'info', ruleId, discipline: 'plumbing', message, resolution: { id: resolution } });
}

export function bump(st: PlumbState, key: string, by = 1): void {
  st.counts[key] = (st.counts[key] ?? 0) + by;
}

// ----------------------------------------------------------------------------
// Element emitters
// ----------------------------------------------------------------------------

export interface AxisOpts {
  storey: string;
  system: PipeSystemType;
  diameter: number;
  a: Vec3;
  b: Vec3;
  name?: string;
  unitId?: string;
  roomId?: string;
  stackId?: string;
  patterns?: string[];
  psetExtra?: { name: string; value: string | number | boolean }[];
  objectType?: string;
}

function pipePsets(o: AxisOpts, length: number): PropertySetDef[] {
  const props: { name: string; value: string | number | boolean }[] = [
    { name: 'System', value: SYSTEM_NAME[o.system] },
    { name: 'SystemType', value: o.system },
    { name: 'Diameter', value: round(o.diameter, 4) },
    { name: 'Length', value: round(length, 3) },
  ];
  if (o.stackId) props.push({ name: 'StackId', value: o.stackId });
  for (const p of o.psetExtra ?? []) props.push(p);
  return [
    { name: 'Forma_Plumbing', properties: props },
    {
      name: 'Pset_PipeSegmentTypeCommon',
      properties: [
        { name: 'NominalDiameter', value: round(o.diameter, 4) },
        { name: 'Shape', value: 'CIRCULAR' },
      ],
    },
  ];
}

/**
 * One straight pipe segment. Returns null for degenerate segments.
 * Coordinates are rounded FIRST so the length test matches the geometry that is actually emitted
 * (a 20 mm segment must not become a 19 mm segment through rounding).
 */
export function emitAxis(st: PlumbState, o: AxisOpts): ModelElement | null {
  const a = roundPoint(o.a);
  const b = roundPoint(o.b);
  const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  if (!Number.isFinite(length) || length < MIN_SEGMENT) return null;
  // Self-check: every emitted segment must be axis-parallel (counted in derived for the tests)
  if (!isOrthogonal(a, b)) bump(st, 'nonOrthogonal');
  const el: ModelElement = {
    id: st.ids.next(o.storey, 'PIPE'),
    discipline: 'plumbing',
    ifcType: 'IfcPipeSegment',
    predefinedType: 'RIGIDSEGMENT',
    name: o.name ?? `${SYSTEM_NAME[o.system]} Ø${Math.round(o.diameter * 1000)}`,
    objectType: o.objectType,
    storey: o.storey,
    geometry: {
      kind: 'axis',
      start: a,
      end: b,
      profile: { type: 'circle', radius: o.diameter / 2 },
    },
    psets: pipePsets(o, length),
    quantities: [{ name: 'Qto_PipeSegmentBaseQuantities', quantities: [{ name: 'Length', value: round(length, 3), kind: 'IfcQuantityLength' }] }],
    color: SYSTEM_COLOR[o.system],
    system: systemId('plumbing', o.system),
    unitId: o.unitId,
    roomId: o.roomId,
    patterns: o.patterns,
  };
  st.elements.push(el);
  st.pipeLength.set(o.system, (st.pipeLength.get(o.system) ?? 0) + length);
  return el;
}

export interface BoxOpts {
  storey: string;
  ifcType: string;
  predefinedType?: string;
  objectType?: string;
  name: string;
  /** Centre of the box in plan; z is the BOTTOM of the box */
  center: Vec3;
  width: number;
  depth: number;
  height: number;
  rotation?: number;
  system?: PipeSystemType;
  unitId?: string;
  roomId?: string;
  psets?: PropertySetDef[];
  patterns?: string[];
  color?: [number, number, number];
  kind?: string;
}

/** A box element positioned by its plan CENTRE (the geometry stores the min corner). */
export function emitBox(st: PlumbState, o: BoxOpts): ModelElement {
  const rot = o.rotation ?? 0;
  const c = Math.cos(rot), s = Math.sin(rot);
  // position = centre - R(rot)·(w/2, d/2)
  const hx = o.width / 2, hy = o.depth / 2;
  const px = o.center[0] - (hx * c - hy * s);
  const py = o.center[1] - (hx * s + hy * c);
  const el: ModelElement = {
    id: st.ids.next(o.storey, o.kind ?? 'EQP'),
    discipline: 'plumbing',
    ifcType: o.ifcType,
    predefinedType: o.predefinedType,
    name: o.name,
    objectType: o.objectType,
    storey: o.storey,
    geometry: {
      kind: 'box',
      position: [round(px), round(py), round(o.center[2])],
      width: round(o.width, 4),
      depth: round(o.depth, 4),
      height: round(o.height, 4),
      rotation: round(rot, 5),
    },
    psets: o.psets,
    color: o.color ?? (o.system ? SYSTEM_COLOR[o.system] : FIXTURE_COLOR),
    system: o.system ? systemId('plumbing', o.system) : undefined,
    unitId: o.unitId,
    roomId: o.roomId,
    patterns: o.patterns,
  };
  st.elements.push(el);
  return el;
}

// ----------------------------------------------------------------------------
// Pipe runs (polylines → segments + fittings)
// ----------------------------------------------------------------------------

export interface RunOpts {
  storey: string;
  system: PipeSystemType;
  diameter: number;
  path: Vec3[];
  servesFixtureIds?: string[];
  unitId?: string;
  roomId?: string;
  stackId?: string;
  name?: string;
  patterns?: string[];
  psetExtra?: { name: string; value: string | number | boolean }[];
  /** Suppress IfcPipeFitting bends even at detail 'high' */
  noFittings?: boolean;
  /** Override the storey's run-length cap (metres of developed length per emitted run) */
  maxLength?: number;
}

/**
 * Emit a polyline pipe run: one IfcPipeSegment per leg (degenerate legs dropped),
 * plus IfcPipeFitting bends at interior corners when detail = 'high'.
 *
 * Every path goes through `orthogonalize` first, so an emitted run is always Manhattan, and is
 * then split so no single PipeRun carries more than MAX_RUN_POINTS points or runs longer than the
 * storey's length cap. Chunks share their boundary point, so the pipework stays connected.
 */
export function emitRun(st: PlumbState, o: RunOpts): PipeRun | null {
  const straight = compactPath(orthogonalize(o.path));
  if (straight.length < 2) return null;
  const cap = o.maxLength ?? info(st, o.storey).maxRunLength;
  const chunks = splitPath(straight, MAX_RUN_POINTS, cap);
  if (chunks.length > 1) bump(st, 'runSplits', chunks.length - 1);
  let first: PipeRun | null = null;
  for (const path of chunks) {
    const run = emitRunChunk(st, o, path);
    if (run && !first) first = run;
  }
  return first;
}

function emitRunChunk(st: PlumbState, o: RunOpts, path: Vec3[]): PipeRun | null {
  const run: PipeRun = {
    id: st.ids.next(o.storey, 'RUN'),
    storey: o.storey,
    system: o.system,
    path,
    diameter: o.diameter,
    servesFixtureIds: o.servesFixtureIds ?? [],
    unitId: o.unitId,
    stackId: o.stackId,
  };
  let emitted = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const el = emitAxis(st, {
      storey: o.storey,
      system: o.system,
      diameter: o.diameter,
      a: path[i],
      b: path[i + 1],
      name: o.name,
      unitId: o.unitId,
      roomId: o.roomId,
      stackId: o.stackId,
      patterns: o.patterns,
      psetExtra: [
        ...(o.servesFixtureIds && o.servesFixtureIds.length > 0
          ? [{ name: 'ServesFixtures', value: o.servesFixtureIds.join(',') }]
          : []),
        ...(o.psetExtra ?? []),
      ],
    });
    if (el) emitted++;
  }
  if (emitted === 0) return null;
  if (st.detail === 'high' && !o.noFittings) {
    for (let i = 1; i < path.length - 1; i++) {
      if (dist([path[i - 1][0], path[i - 1][1]], [path[i][0], path[i][1]]) < MIN_SEGMENT
        && Math.abs(path[i - 1][2] - path[i][2]) < MIN_SEGMENT) continue;
      emitBox(st, {
        storey: o.storey,
        ifcType: 'IfcPipeFitting',
        predefinedType: 'BEND',
        name: `Bend Ø${Math.round(o.diameter * 1000)}`,
        center: path[i],
        width: 0.1, depth: 0.1, height: 0.1,
        system: o.system,
        unitId: o.unitId,
        roomId: o.roomId,
        patterns: o.patterns,
        kind: 'FIT',
      });
      bump(st, 'fittings');
    }
  }
  st.pipes.push(run);
  return run;
}

export function roundPoint(p: Vec3): Vec3 {
  return [round(p[0]), round(p[1]), round(p[2])];
}

/**
 * Round every point and drop legs shorter than MIN_SEGMENT, so a run's stored polyline and the
 * segments emitted from it agree exactly.
 */
export function compactPath(path: Vec3[]): Vec3[] {
  const out: Vec3[] = [];
  for (const raw of path) {
    if (!Number.isFinite(raw[0]) || !Number.isFinite(raw[1]) || !Number.isFinite(raw[2])) continue;
    const p = roundPoint(raw);
    const last = out[out.length - 1];
    if (last && Math.hypot(p[0] - last[0], p[1] - last[1], p[2] - last[2]) < MIN_SEGMENT) continue;
    out.push(p);
  }
  return out;
}

export function pathLength(path: Vec3[]): number {
  return polylineLength(path);
}

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

export interface FixtureOpts {
  type: FixtureType;
  storey: string;
  center: Vec3;
  rotation?: number;
  roomId?: string;
  unitId?: string;
  furnitureId?: string;
  width?: number;
  depth?: number;
  height?: number;
  /** Emit an element for this fixture (markers are suppressed at detail 'low') */
  emit?: boolean;
  name?: string;
  ifcType?: string;
  predefinedType?: string;
  objectType?: string;
  /** Emit the full solid rather than a thin connection marker */
  solid?: boolean;
  patterns?: string[];
  extraProps?: { name: string; value: string | number | boolean }[];
}

/**
 * Register a PlumbingFixture and (optionally) its IFC element.
 *
 * Architecture already emits the visible sanitary furniture as IfcFurnishingElement, so for
 * fixtures derived from furniture we emit only a thin connection MARKER (0.15 × 0.15 × 0.1) to
 * avoid duplicated solids — and only when detail !== 'low'. Equipment that architecture does not
 * draw (tanks, meters, pumps, drains, sprinklers) is emitted as a real solid.
 */
export function addFixture(st: PlumbState, o: FixtureOpts): PlumbingFixture {
  const spec = FIXTURES[o.type];
  const marker = !o.solid;
  const fixture: PlumbingFixture = {
    id: st.ids.next(o.storey, 'FIX'),
    storey: o.storey,
    type: o.type,
    roomId: o.roomId,
    unitId: o.unitId,
    furnitureId: o.furnitureId,
    position: [round(o.center[0]), round(o.center[1]), round(o.center[2])],
    rotation: round(o.rotation ?? 0, 5),
    width: round(o.width ?? spec.size[0], 3),
    depth: round(o.depth ?? spec.size[1], 3),
    height: round(o.height ?? spec.size[2], 3),
    connections: [...spec.connections],
    dfu: spec.dfu,
    wsfu: spec.wsfu,
  };
  st.fixtures.push(fixture);

  const wantElement = o.emit !== false && (o.solid === true || st.detail !== 'low');
  if (wantElement) {
    const props: { name: string; value: string | number | boolean }[] = [
      { name: 'FixtureType', value: o.type },
      { name: 'DFU', value: spec.dfu },
      { name: 'WSFU', value: spec.wsfu },
      { name: 'Connections', value: spec.connections.join(',') },
      { name: 'FixtureId', value: fixture.id },
    ];
    if (o.furnitureId) props.push({ name: 'FurnitureId', value: o.furnitureId });
    for (const p of o.extraProps ?? []) props.push(p);
    emitBox(st, {
      storey: o.storey,
      ifcType: o.ifcType ?? spec.ifcType,
      predefinedType: o.predefinedType ?? spec.predefinedType,
      objectType: o.objectType ?? spec.objectType ?? (marker ? `${spec.name} connection` : spec.name),
      name: o.name ?? spec.name,
      center: marker ? [o.center[0], o.center[1], o.center[2]] : o.center,
      width: marker ? 0.15 : fixture.width,
      depth: marker ? 0.15 : fixture.depth,
      height: marker ? 0.1 : fixture.height,
      rotation: o.rotation ?? 0,
      unitId: o.unitId,
      roomId: o.roomId,
      psets: [{ name: 'Forma_Plumbing', properties: props }],
      patterns: o.patterns,
      color: FIXTURE_COLOR,
      kind: 'FIX',
    });
  }
  return fixture;
}
