/**
 * Architecture discipline — FLOOR ORGANISER half.
 *
 * `generateArchitecture` turns the site massing (bars, cores, corridor spines, storeys) into a
 * complete `ArchModel`: floor plans, dwellings, rooms, walls, doors, windows, furniture, cores,
 * stairs, lifts, shafts, balconies, the roof and the `ModelElement` stream the IFC writer consumes.
 *
 * The dwelling INTERIOR is not planned here: every unit rect is handed to `layoutUnit`
 * (`unit-layout.ts`, see `unit-layout-types.ts`) as a NET rect plus its boundary walls, access
 * side, exterior sides, exposures, wet-wall side, stack offset and (for houses) a fixed stair
 * footprint. This module owns every wall SHARED between a unit and anything else.
 */
import type {
  ArchModel, FloorPlan, FloorSpec, FloorUse, GenContext, MassingBar, ModelElement, Pattern,
  PatternApplication, Polygon, Rect, RoofDef, Side, StoreyDef, UnitInstance, UnitTemplateDef,
  UnitTemplateId, Vec2,
} from '../../core/types.ts';
import type { UnitLayoutFn } from './unit-layout-types.ts';
import type { FeasibilityOpts } from './program/types.ts';
import type { Deviation, Rule, RuleSet, ScopeContext, SubjectKind } from '../../core/rules/types.ts';
import { layoutUnitV2 } from './program/solver.ts';
import { UNIT_TEMPLATES } from './templates.ts';
import { buildCatalogue } from '../../modules/catalogue.ts';
import { programFor } from '../../modules/program-source.ts';
import { templateOf } from '../../modules/ids.ts';
import { bayGridFrom, defaultBayGrid, type BayGrid } from '../structure/presize.ts';
import { structuralSystemFor } from '../../core/typologies.ts';
import { newQuota, mergeMix } from './placer/quota.ts';
import { applyOverrides } from './placer/apply-overrides.ts';
import { corridorGraphFor, longestLeg, travelFrom, travelGraph } from './placer/corridors.ts';
import { portAlignment } from './placer/ports.ts';
import { fitsStrip } from './placer/packer.ts';
import { UNIT_PATTERNS } from './unit-patterns.ts';
import { SIZES } from '../../core/coordination.ts';
import {
  dist, polygonArea, polygonBounds, rectToPolygon, round, segDir, rectsOverlap,
} from '../../core/geometry.ts';
import { ArchBuilder, emitElements } from './arch-elements.ts';
import { barFrame, frameOfRect, type BarFrame } from './bar-frame.ts';
import { planCores, type CoreLayout } from './cores.ts';
import { buildFloorSlab, buildRoof } from './envelope.ts';
import { FLOOR_PATTERNS } from './patterns.ts';
import {
  instantiateFloor, planFloorLayout, planHouses, planKey, type FloorResult, type OrganizerDeps,
} from './floor-organizer.ts';
import type { FloorCtx, FloorLayout } from './types-internal.ts';
import type { ModuleCatalogue } from '../../modules/types.ts';
import type { CorridorGraph } from '../site/corridor-graph.ts';

// ============================================================================
// Pattern book
// ============================================================================

/**
 * ARC-01..13 + ARC-31..35 are the floor-organisation patterns defined here; ARC-14..30 are the
 * unit-layout patterns from `unit-patterns.ts`.
 */
export const ARCH_PATTERNS: Pattern[] = [...FLOOR_PATTERNS, ...UNIT_PATTERNS];

export { FLOOR_PATTERNS, UNIT_PATTERNS };

// ============================================================================
// Dependency resolution (templates + layoutUnit)
// ============================================================================

const DEFAULT_DEPS: OrganizerDeps = {
  templates: normalizeTemplates(UNIT_TEMPLATES),
  // the v2 program solver: a layout exists only for a (frontage, depth) its program admits
  layoutUnit: layoutUnitV2,
};

let injected: Partial<OrganizerDeps> = {};
let resolvedDeps: OrganizerDeps = DEFAULT_DEPS;

export function setArchitectureDeps(d: {
  templates?: Map<UnitTemplateId, UnitTemplateDef> | UnitTemplateDef[] | Record<string, UnitTemplateDef>;
  layoutUnit?: UnitLayoutFn;
}): void {
  if (d.templates) injected.templates = normalizeTemplates(d.templates);
  if (d.layoutUnit) injected.layoutUnit = d.layoutUnit;
  resolvedDeps = {
    templates: injected.templates ?? DEFAULT_DEPS.templates,
    layoutUnit: injected.layoutUnit ?? DEFAULT_DEPS.layoutUnit,
  };
}

/** Drop any `setArchitectureDeps` override and go back to templates.ts + unit-layout.ts */
export function resetArchitectureDeps(): void {
  injected = {};
  resolvedDeps = DEFAULT_DEPS;
}

export function normalizeTemplates(
  t: Map<UnitTemplateId, UnitTemplateDef> | UnitTemplateDef[] | Record<string, UnitTemplateDef>,
): Map<UnitTemplateId, UnitTemplateDef> {
  if (t instanceof Map) return t;
  const list = Array.isArray(t) ? t : Object.values(t);
  return new Map(list.map(x => [x.id, x] as const));
}

/**
 * Historical escape hatch from when `templates.ts` / `unit-layout.ts` did not exist yet: both are
 * now imported statically, so this simply returns the active dependencies. Kept because tests and
 * tools call it, and because it still honours `setArchitectureDeps` overrides.
 */
export async function resolveArchitectureDeps(): Promise<OrganizerDeps> {
  return resolvedDeps;
}

export const resolveLayoutUnit = async (): Promise<UnitLayoutFn> => (await resolveArchitectureDeps()).layoutUnit;

function currentDeps(): OrganizerDeps {
  return resolvedDeps;
}

// ============================================================================
// generateArchitecture
// ============================================================================

export function generateArchitecture(ctx: GenContext): ArchModel {
  const b = new ArchBuilder(ctx.warnings);
  const spec = ctx.spec;
  const site = ctx.site;
  const massing = site.massing;
  const floorSpecs = new Map(spec.floors.map(f => [f.index, f] as const));

  // ---- the three things the placer needs, resolved once ---------------------------------------
  // the module catalogue (memoised by the rule set's hash), the structural handshake, and the corridor topology
  const catalogue = buildCatalogue(ctx.rules);
  const grid: BayGrid = ctx.presize
    ? bayGridFrom(ctx.presize)
    : defaultBayGrid(structuralSystemFor(ctx.typology, Math.max(1, spec.massing.storeys)));
  const graph = corridorGraphFor(ctx);
  const opts: FeasibilityOpts = {
    region: spec.region,
    detail: spec.options.detail,
    rulesHash: catalogue.rulesHash,
  };
  const deps = { ...currentDeps(), catalogue };

  const built = ctx.storeys
    .filter(s => s.id !== 'SITE' && s.id !== 'FND' && s.id !== 'ROOF')
    .sort((p, q) => p.index - q.index);
  const roofStorey = ctx.storeys.find(s => s.id === 'ROOF');

  const podiumStoreys = massing.podium?.storeys ?? 0;
  const floorCtxs = built.map(s => makeFloorCtx(ctx, s, floorSpecs.get(s.index) ?? null, podiumStoreys));

  // ---- cores + shafts (once for the whole building) ----------------------
  const cores = planCores(b, massing.cores, massing.bars, ctx.storeys, spec, ctx.typology.access, {
    catalogue, presize: ctx.presize ?? null,
  });

  // ---- floors -------------------------------------------------------------
  const planCache = new Map<string, FloorLayout>();
  const unitRegistry = new Map<string, UnitInstance>();
  const results = new Map<string, FloorResult>();
  const layouts: Record<string, FloorLayout> = {};
  const emitSlabs = spec.options.structure === false;
  const residentialStoreys = floorCtxs.filter(f => f.isResidential).map(f => f.storeyId);
  const unitsEstimate = estimateUnits(ctx, floorCtxs.length);
  const hasAmenityFloor = floorCtxs.some(f => f.use === 'amenity');
  let houseLayout: FloorLayout | null = null;

  // ONE building-wide mix ledger, carried across strips and storeys in storey-index order: a template the geometry
  // pushed off one floor is the first pick on the next, which is what holds the mix deviation under 0.08.
  const requestedMix = { ...(ctx.typology.defaultUnitMix ?? {}), ...(spec.unitMix ?? {}) };
  const targetTotal = floorCtxs.reduce((a, f) => a + (f.targetUnits ?? 0), 0) || unitsEstimate;
  const quota = newQuota(requestedMix, targetTotal);
  const fitFor = (moduleId: string, frontage: number, depth: number, level: number): ReturnType<typeof catalogue.fitFor> =>
    catalogue.fitFor(moduleId, frontage, depth, { ...opts, levels: level });
  const programOf = (moduleId: string): ReturnType<typeof programFor> | undefined => {
    const t = templateOf(moduleId);
    return t ? programFor(t) : undefined;
  };

  for (const f of floorCtxs) {
    const planArgs = {
      b, ctx, f, cores: coresOn(cores, f), deps, unitsInBuilding: unitsEstimate, hasAmenityFloor,
      catalogue, grid, quota, graph, opts,
    };
    let layout: FloorLayout;
    if (ctx.typology.access === 'direct' && f.isResidential) {
      houseLayout ??= planHouses(planArgs, residentialStoreys);
      layout = houseLayout;
    } else {
      const key = planKey(f, ctx);
      const cached = planCache.get(key);
      if (cached) layout = cached;
      else {
        layout = planFloorLayout(planArgs);
        planCache.set(key, layout);
      }
    }
    // the editable document: base plan → overrides → geometry. An empty override doc returns the base by reference,
    // so every existing output stays byte-identical.
    const edited = applyOverrides(layout, spec.overrides, {
      catalogue, grid, rules: ctx.rules ?? FALLBACK_RULES, region: spec.region, level: 0, storeyId: f.storeyId,
    });
    layouts[f.storeyId] = edited;
    const res = instantiateFloor({
      b, ctx, f, layout: edited, cores: coresOn(cores, f), deps, unitRegistry, emitSlabs,
      fitFor, programFor: programOf,
    });
    results.set(f.storeyId, res);
    if (emitSlabs) buildFloorSlab(b, f.storeyId, f.outline, f.slabThickness);
  }

  // ---- the placer's own report: deviations, fit conformance, port alignment, party lines -------
  reportPlacer(ctx, layouts, catalogue, opts);
  const partyLines = partyLinesOf(layouts, massing);

  // ---- roof ---------------------------------------------------------------
  const top = floorCtxs[floorCtxs.length - 1];
  const roofOutline: Polygon = top ? top.outline : massing.footprint;
  const roof: RoofDef = roofStorey
    ? buildRoof(b, {
      outline: roofOutline,
      type: massing.roof.type === 'hip' ? 'gable' : massing.roof.type,
      pitchRad: massing.roof.pitchRad || ((spec.massing.roofPitchDeg ?? 30) * Math.PI) / 180,
      ridgeAxis: massing.roof.ridgeAxis,
      parapetHeight: massing.roof.parapetHeight || spec.massing.parapetHeight || 1.1,
      storey: roofStorey.id,
      coreRect: cores[0]?.rect,
      bars: (top?.bars ?? massing.bars.map(barFrame)).map(fr => frameRect(fr)),
      emitSlab: emitSlabs,
      streetFacing: site.streetFacing,
    })
    : {
      type: massing.roof.type, outline: roofOutline, thickness: 0.25, pitchRad: massing.roof.pitchRad,
      ridgeAxis: massing.roof.ridgeAxis, parapetHeight: massing.roof.parapetHeight,
    };

  // ---- floor plans --------------------------------------------------------
  b.crossLink();
  const wallsByStorey = groupBy(b.walls, w => w.storey);
  const roomsByStorey = groupBy(b.rooms, r => r.storey);
  const floors: FloorPlan[] = floorCtxs.map(f => {
    const res = results.get(f.storeyId)!;
    const walls = wallsByStorey.get(f.storeyId) ?? [];
    const rooms = roomsByStorey.get(f.storeyId) ?? [];
    const extWalls = walls.filter(w => w.isExternal && w.type !== 'parapet');
    const extArea = extWalls.reduce((a, w) => a + dist(w.start, w.end) * w.height, 0);
    return {
      storey: f.storeyId,
      use: f.use,
      outline: f.outline,
      area: round(polygonArea(f.outline), 2),
      floorToFloor: f.floorToFloor,
      ceilingHeight: f.ceilingHeight,
      slabThickness: f.slabThickness,
      corridors: res.corridors,
      unitIds: res.unitIds,
      roomIds: rooms.map(r => r.id),
      commonRoomIds: res.commonRoomIds,
      wallIds: walls.map(w => w.id),
      exteriorWallIds: extWalls.map(w => w.id),
      balconies: b.balconies.filter(x => x.storey === f.storeyId),
      wwr: extArea > 0 ? round(res.windowArea / extArea, 4) : 0,
    };
  });
  if (roofStorey) {
    const walls = wallsByStorey.get(roofStorey.id) ?? [];
    floors.push({
      storey: roofStorey.id, use: 'roof', outline: roofOutline, area: round(polygonArea(roofOutline), 2),
      floorToFloor: roofStorey.height, ceilingHeight: 0, slabThickness: roof.thickness,
      corridors: [], unitIds: [], roomIds: (roomsByStorey.get(roofStorey.id) ?? []).map(r => r.id),
      commonRoomIds: (roomsByStorey.get(roofStorey.id) ?? []).map(r => r.id),
      wallIds: walls.map(w => w.id), exteriorWallIds: walls.map(w => w.id), balconies: [], wwr: 0,
    });
  }

  // ---- derived + patterns -------------------------------------------------
  const derived = computeDerived(ctx, b, floors, cores, results, graph, spec.massing.corridorWidth ?? ctx.typology.corridorWidth ?? 1.6);
  recordPatterns(ctx, b, floors, cores, derived);

  b.flushWarnings();

  const ceilingHeight = new Map(floorCtxs.map(f => [f.storeyId, f.ceilingHeight] as const));
  if (roofStorey) ceilingHeight.set(roofStorey.id, 2.4);
  const unitTemplateOf = new Map(b.units.map(u => [u.id, u.templateId] as const));
  const elements: ModelElement[] = emitElements(b, { ceilingHeight, unitTemplateOf, detail: spec.options.detail });

  const mix = Object.values(layouts).reduce<ReturnType<typeof mergeMix> | null>(
    (acc, l) => (acc ? mergeMix(acc, l.mix) : l.mix), null);
  if (mix) derived.mixDeviation = mix.deviation;

  return {
    storeys: ctx.storeys,
    floors,
    units: b.units,
    partyLines,
    layouts,
    rooms: b.rooms,
    walls: b.walls,
    doors: b.doors,
    windows: b.windows,
    furniture: b.furniture,
    cores: b.cores,
    stairs: b.stairs,
    elevators: b.elevators,
    shafts: b.shafts,
    roof,
    templatesUsed: [...new Set(b.units.map(u => u.templateId))],
    elements,
    patterns: b.patterns,
    derived,
  };
}

// ============================================================================
// The placer's report
// ============================================================================

/**
 * Minimal `RuleSet` for the paths that run before the rule set is wired (test fixtures, the mock app). Every reader
 * takes the fallback argument, which is today's constant, so behaviour is identical either way.
 */
const FALLBACK_RULES: RuleSet = {
  all: () => [],
  get: () => null,
  num: (_id: string, fallback: number) => fallback,
  str: (_id: string, fallback: string) => fallback,
  bool: (_id: string, fallback: boolean) => fallback,
  table: () => [],
  forSubject: (_kind: SubjectKind, _ctx: ScopeContext) => [] as readonly Rule[],
  disabled: () => false,
  profileApplied: () => false,
  hash: () => 'v1',
};

/**
 * Everything the placer has to say goes into the issues ledger: its own deviations (declared remnants, strips that
 * admit no dwelling, clamped overrides), the FIT CONFORMANCE assertion (every slot inside its module's admissible
 * frontage at its strip's net depth) and the PORT ALIGNMENT assertion (identical modules resolve identical stack
 * fractions). A failure of either assertion is a `violation` — a placer bug — not a warning about the design.
 */
function reportPlacer(
  ctx: GenContext, layouts: Record<string, FloorLayout>, catalogue: ModuleCatalogue, opts: FeasibilityOpts,
): void {
  const seen = new Set<string>();
  for (const [storey, layout] of Object.entries(layouts).sort()) {
    for (const d of layout.deviations) {
      const key = `${d.ruleId}|${d.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      ctx.issues?.add({ ...d, storey: d.storey ?? storey });
    }
    for (const slot of layout.slots) {
      if (slot.kind !== 'unit') continue;
      const strip = layout.strips.find(st => st.id === slot.stripId);
      if (!strip) continue;
      const fit = fitsStrip(slot, strip, catalogue, opts);
      if (fit.ok) continue;
      ctx.issues?.add({
        severity: 'violation', ruleId: 'ARC-D01', discipline: 'architecture', storey,
        message: `slot ${slot.id} (${slot.moduleId}) has ${round(fit.frontage, 2)} m frontage, outside the ${fit.range ? `${round(fit.range.min, 2)}–${round(fit.range.max, 2)} m` : 'inadmissible'} range at ${round(strip.netDepth, 2)} m depth`,
        observed: round(fit.frontage, 2),
      });
    }
    for (const bad of portAlignment(layout.slots)) {
      ctx.issues?.add({
        severity: 'violation', ruleId: 'ARC-D05', discipline: 'architecture', storey,
        message: `stack ports of ${bad.key} resolved to different fractions (${bad.fracs.join(', ')}) — identical modules must stack`,
      });
    }
  }
}

/** Actual party/column lines per bar, returned to the structural detailing pass (the other half of the handshake) */
function partyLinesOf(
  layouts: Record<string, FloorLayout>, massing: { bars: MassingBar[] },
): { barId: string; axis: 'x' | 'y'; offsets: number[] }[] {
  const byBar = new Map<string, Set<number>>();
  for (const layout of Object.values(layouts)) {
    for (const [barId, lines] of Object.entries(layout.grid.lines)) {
      const set = byBar.get(barId) ?? new Set<number>();
      for (const v of lines) set.add(round(v, 3));
      byBar.set(barId, set);
    }
  }
  const axisOf = new Map(massing.bars.map(bar => [bar.id, bar.axis] as const));
  return [...byBar.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([barId, set]) => ({
      barId,
      axis: axisOf.get(barId) ?? 'x',
      offsets: [...set].sort((a, c) => a - c),
    }));
}

// ============================================================================
// Floor context
// ============================================================================

function makeFloorCtx(ctx: GenContext, s: StoreyDef, spec: FloorSpec | null, podiumStoreys: number): FloorCtx {
  const massing = ctx.site.massing;
  const outline: Polygon = s.index < 0
    ? ctx.site.buildableEnvelope
    : massing.podium && s.index < podiumStoreys
      ? massing.podium.footprint
      : podiumStoreys > 0
        ? (massing.towerFootprint ?? massing.footprint)
        : massing.footprint;
  const use = (spec?.use ?? (s.use === 'site' || s.use === 'foundation' ? 'residential' : s.use)) as FloorUse;
  /*
   * The STRUCTURAL PRE-SIZING is the single owner of every number in this block (principle 1). `slabTAbove` is the
   * slab whose soffit forms this storey's ceiling, so it — not a constant — sets the wall height; `floorToFloor` may
   * have been RAISED so the ceiling profile fits, and `ceilingZ` already allows for the beam depth over the unit.
   * Falling back to today's constants keeps the paths that run before the pre-sizing byte-identical.
   */
  const sizing = ctx.presize?.byStorey.get(s.id);
  const f2f = sizing?.floorToFloor ?? spec?.floorToFloor ?? s.height ?? ctx.spec.massing.floorToFloor ?? 3.0;
  const slabThickness = sizing?.slabTAbove
    ?? (podiumStoreys > 0 && s.index + 1 === podiumStoreys ? 0.25 : SIZES.slabT);
  const ceilingHeight = spec?.ceilingHeight ?? sizing?.ceilingZ ?? Math.min(f2f - 0.45, s.index === 0 ? 3.2 : 2.7);
  const bars = barsForOutline(outline, massing.bars);
  return {
    storey: s,
    storeyId: s.id,
    spec,
    use,
    outline,
    bars,
    floorToFloor: f2f,
    ceilingHeight: round(Math.max(2.2, ceilingHeight), 3),
    wallHeight: round(Math.max(2.2, f2f - slabThickness), 3),
    slabThickness,
    wwr: spec?.wwr ?? 0.35,
    balconies: spec?.balconies ?? false,
    targetUnits: spec?.targetUnits,
    unitMix: spec?.unitMix ?? ctx.spec.unitMix ?? ctx.typology.defaultUnitMix,
    isGround: s.index === 0,
    isResidential: use === 'residential' || use === 'lobby-residential',
  };
}

/**
 * Bars present on a storey. When the massing bars do not cover the storey outline (a podium plate
 * or a basement), the whole plate is treated as one bar so the organisers keep working.
 */
function barsForOutline(outline: Polygon, bars: MassingBar[]): BarFrame[] {
  const ob = polygonBounds(outline);
  const inside = bars.filter(bar => rectsOverlap(ob, bar.rect, 0.2));
  const covered = inside.reduce((a, bar) => a + bar.rect.w * bar.rect.h, 0);
  // compare against the outline's own AREA: an L/U/O footprint is much smaller than its bounds
  const plateArea = polygonArea(outline);
  if (inside.length > 0 && plateArea > 0 && covered / plateArea > 0.6) return inside.map(barFrame);
  const sides: Side[] = ['front', 'rear', 'left', 'right'];
  return [frameOfRect('PLATE', ob, ob.w >= ob.h ? 'x' : 'y', sides)];
}

function frameRect(f: BarFrame): Rect {
  return f.axis === 'x'
    ? { x: f.a0, y: f.c0, w: f.a1 - f.a0, h: f.c1 - f.c0 }
    : { x: f.c0, y: f.a0, w: f.c1 - f.c0, h: f.a1 - f.a0 };
}

function coresOn(cores: CoreLayout[], f: FloorCtx): CoreLayout[] {
  const rects = f.bars.map(frameRect);
  return cores.filter(c => c.storeys.includes(f.storeyId) && rects.some(r => rectsOverlap(r, c.rect, 0.2)));
}

function estimateUnits(ctx: GenContext, storeyCount: number): number {
  const t = ctx.typology;
  const per = Math.max(1, Math.round((t.unitsPerFloor.min + t.unitsPerFloor.max) / 2));
  return Math.max(1, per * Math.max(1, storeyCount - 1));
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const list = m.get(k);
    if (list) list.push(it);
    else m.set(k, [it]);
  }
  return m;
}

// ============================================================================
// Derived metrics
// ============================================================================

function computeDerived(
  ctx: GenContext, b: ArchBuilder, floors: FloorPlan[], cores: CoreLayout[], results: Map<string, FloorResult>,
  graph: CorridorGraph | null, corridorWidth: number,
): Record<string, number> {
  const habitable = floors.filter(f => f.use !== 'roof');
  const gia = habitable.reduce((a, f) => a + f.area, 0);
  const residentialGia = habitable
    .filter(f => f.use === 'residential' || f.use === 'lobby-residential')
    .reduce((a, f) => a + f.area, 0);
  const nia = b.units.reduce((a, u) => a + u.area, 0);
  const unitsByTemplate: Record<string, number> = {};
  for (const u of b.units) unitsByTemplate[`units.${u.templateId}`] = (unitsByTemplate[`units.${u.templateId}`] ?? 0) + 1;
  const exteriorWallArea = b.walls
    .filter(w => w.isExternal && w.type !== 'parapet')
    .reduce((a, w) => a + dist(w.start, w.end) * w.height, 0);
  const windowArea = b.windows.reduce((a, w) => a + w.width * w.height, 0);
  const circulationArea = [...results.values()].reduce((a, r) => a + r.circulationArea, 0);
  const CORE_ROOMS = new Set(['stair', 'elevator', 'lift-lobby', 'shaft']);
  const coreArea = b.rooms.filter(r => CORE_ROOMS.has(r.type)).reduce((a, r) => a + r.area, 0);
  const corridorLength = b.corridors.reduce((a, c) => a + Math.max(...c.centerline.map(s => dist(s.a, s.b))), 0);
  const travel = maxTravel(ctx, b, cores, graph, corridorWidth);

  const dualAspect = b.units.filter(u => u.aspect === 'dual').length;
  const corner = b.units.filter(u => u.aspect === 'corner').length;
  const storeyHeightMax = Math.max(0, ...floors.map(f => f.floorToFloor));

  // ---- issues, not warnings ------------------------------------------------
  // Every one of these was a v1 warning. They are now RECORDED against their rule with the metric that triggered
  // them: break modules cut every leg to ARC-03, travel is measured on the corridor graph, and the remnant bound
  // keeps net-to-gross up. A `violation` here means the placer failed at something it owns.
  const limit = ctx.rules?.num('ARC-33.egressTravel', ctx.typology.sprinklered ? 76 : 61)
    ?? (ctx.typology.sprinklered ? 76 : 61);
  if (travel > limit) {
    ctx.issues?.add({
      severity: 'deviation', ruleId: 'ARC-33.egressTravel', discipline: 'architecture',
      message: `egress travel ${round(travel, 1)} m on the corridor graph exceeds the ${limit} m limit (IBC 2021 Table 1017.2)`,
      observed: round(travel, 1), limit, resolution: { id: 'add-core' },
    });
  }
  const maxLeg = ctx.rules?.num('ARC-03.maxLegLength', 45) ?? 45;
  const longest = longestLeg(graph);
  if (longest > maxLeg + 0.5) {
    ctx.issues?.add({
      severity: 'violation', ruleId: 'ARC-03.maxLegLength', discipline: 'architecture',
      message: `corridor leg of ${round(longest, 1)} m survived the break slots (limit ${maxLeg} m)`,
      observed: round(longest, 1), limit: maxLeg,
    });
  }
  if (b.units.length === 0) {
    ctx.issues?.add({
      severity: 'violation', ruleId: 'ARC-01.dwellingPlaced', discipline: 'architecture',
      message: 'no dwellings were placed — the massing bars, cores or unit mix admit no module',
    });
  }
  if (residentialGia > 0 && nia / residentialGia < 0.5 && b.units.length > 0) {
    ctx.issues?.add({
      severity: 'deviation', ruleId: 'ARC-08.netToGross', discipline: 'architecture',
      message: `residential net-to-gross is ${round(nia / residentialGia, 3)} — cores, landings and service bays take more than half the plate`,
      observed: round(nia / residentialGia, 3), limit: 0.5,
    });
  }

  return {
    gia: round(gia, 2),
    nia: round(nia, 2),
    unitCount: b.units.length,
    ...unitsByTemplate,
    bedrooms: b.units.reduce((a, u) => a + u.bedrooms, 0),
    bathrooms: b.units.reduce((a, u) => a + u.bathrooms, 0),
    bedspaces: b.units.reduce((a, u) => a + u.occupants, 0),
    circulationArea: round(circulationArea, 2),
    coreArea: round(coreArea, 2),
    efficiency: gia > 0 ? round(nia / gia, 4) : 0,
    residentialGia: round(residentialGia, 2),
    /** nia / gia of the residential floors only — the meaningful number for podium schemes */
    residentialEfficiency: residentialGia > 0 ? round(nia / residentialGia, 4) : 0,
    exteriorWallArea: round(exteriorWallArea, 2),
    windowArea: round(windowArea, 2),
    wwr: exteriorWallArea > 0 ? round(windowArea / exteriorWallArea, 4) : 0,
    dualAspectUnits: dualAspect,
    cornerUnits: corner,
    dualAspectShare: b.units.length > 0 ? round((dualAspect + corner) / b.units.length, 4) : 0,
    maxTravelDistance: round(travel, 2),
    corridorLength: round(corridorLength, 2),
    doorCount: b.doors.length,
    windowCount: b.windows.length,
    roomCount: b.rooms.length,
    furnitureCount: b.furniture.length,
    balconyCount: b.balconies.length,
    stairCount: b.stairs.length,
    elevatorCount: b.elevators.length,
    shaftCount: b.shafts.length,
    avgUnitArea: b.units.length > 0 ? round(nia / b.units.length, 2) : 0,
    floors: floors.length,
    storeyHeightMax: round(storeyHeightMax, 3),
    wallCount: b.walls.length,
  };
}

/**
 * Travel from the farthest unit entry door to the nearest exit, walked along the CORRIDOR GRAPH (Dijkstra from every
 * core, plus the step from the door onto the nearest leg). The v1 estimate was a Manhattan distance straight across
 * the plate, which under-reported on an L or O plan and over-reported past a knuckle.
 */
function maxTravel(
  ctx: GenContext, b: ArchBuilder, cores: CoreLayout[], graph: CorridorGraph | null, corridorWidth: number,
): number {
  if (ctx.typology.access === 'direct' || cores.length === 0) return 0;
  const doorById = new Map(b.doors.map(d => [d.id, d] as const));
  const wallById = new Map(b.walls.map(w => [w.id, w] as const));
  const tg = travelGraph(graph, cores.map(c => c.rect), corridorWidth);
  let worst = 0;
  for (const u of b.units) {
    const d = doorById.get(u.entryDoorId);
    const w = d ? wallById.get(d.wallId) : undefined;
    if (!d || !w) continue;
    const dir = segDir({ a: w.start, b: w.end });
    const p: Vec2 = [w.start[0] + dir[0] * d.along, w.start[1] + dir[1] * d.along];
    let best = Infinity;
    if (tg) best = travelFrom(tg, p);
    if (!Number.isFinite(best) || best <= 0) {
      // no corridor graph (stair-core, point-core, houses): the door opens onto its own landing
      for (const c of cores) {
        const dx = Math.max(0, Math.max(c.rect.x - p[0], p[0] - (c.rect.x + c.rect.w)));
        const dy = Math.max(0, Math.max(c.rect.y - p[1], p[1] - (c.rect.y + c.rect.h)));
        best = Math.min(best, dx + dy);
      }
    }
    if (Number.isFinite(best)) worst = Math.max(worst, best);
  }
  return worst;
}

// ============================================================================
// Pattern applications
// ============================================================================

function recordPatterns(
  ctx: GenContext, b: ArchBuilder, floors: FloorPlan[], cores: CoreLayout[], derived: Record<string, number>,
): void {
  const access = ctx.typology.access;
  const add = (app: PatternApplication): void => b.apply(app);
  const unitIds = b.units.map(u => u.id);

  if (access === 'direct') {
    const entryDoors = b.doors.filter(d => d.type === 'unit-entry' || d.type === 'building-entry').map(d => d.id);
    add({
      patternId: 'ARC-01', elementIds: entryDoors,
      params: { doors: entryDoors.length, dwellings: b.units.length, doorWidth: SIZES.doorUnitEntry },
      note: 'every dwelling entered from the street face at its site entrance',
    });
    add({
      patternId: 'ARC-10',
      params: { dwellings: b.units.length, barDepth: round(ctx.spec.massing.buildingDepth ?? 0, 2) },
      note: 'street → threshold → front rooms → kitchen/garden; stair and services on the party wall',
    });
    const garages = b.doors.filter(d => d.type === 'garage');
    if (garages.length > 0) {
      add({ patternId: 'ARC-11', elementIds: garages.map(d => d.id), params: { garages: garages.length } });
    }
  }

  const frontages = b.units.map(u => Math.min(u.rect.w, u.rect.h) === 0 ? 0 : moduleOf(u.rect, u.accessSide));
  if (frontages.length > 0) {
    const sorted = [...frontages].sort((p, q) => p - q);
    add({
      patternId: 'ARC-02', elementIds: b.walls.filter(w => w.type === 'party').map(w => w.id),
      params: {
        module: round(sorted[Math.floor(sorted.length / 2)], 3),
        partyWalls: b.walls.filter(w => w.type === 'party').length,
        partyWallThickness: SIZES.partyWallT,
        acousticRating: 'STC 55',
      },
    });
  }

  if (access === 'corridor-double' || access === 'corridor-single' || access === 'cluster') {
    for (const c of b.corridors) {
      const len = Math.max(...c.centerline.map(s => dist(s.a, s.b)));
      add({
        patternId: 'ARC-03', storey: c.storey, elementIds: [c.id],
        params: { length: round(len, 2), width: c.width, withinLimit: len <= 45 },
      });
    }
  }
  if (access === 'gallery') {
    add({
      patternId: 'ARC-09', elementIds: b.corridors.map(c => c.id),
      params: { decks: b.corridors.length, railingHeight: 1.1, dualAspectShare: derived.dualAspectShare },
    });
  }
  if (access === 'stair-core') {
    add({
      patternId: 'ARC-07', elementIds: cores.map(c => c.id),
      params: { unitsPerCore: ctx.typology.unitsPerCore ?? 2, cores: cores.length, landingDepth: 2.4 },
    });
  }
  if (access === 'point-core') {
    add({
      patternId: 'ARC-07', elementIds: cores.map(c => c.id),
      params: { unitsPerCore: ctx.typology.unitsPerCore ?? 6, cores: cores.length, ringWidth: 1.6 },
    });
  }
  if (ctx.typology.id === 'coliving-cluster') {
    add({
      patternId: 'ARC-12', elementIds: unitIds,
      params: { clusters: b.units.length, roomsPerCluster: ctx.typology.defaultUnitMix['coliving-cluster'] ? 6 : 0 },
    });
  }
  if (ctx.typology.id === 'senior-living') {
    add({
      patternId: 'ARC-13', elementIds: b.corridors.map(c => c.id),
      params: { corridorWidth: ctx.typology.corridorWidth ?? 2.0, doorClearWidth: 0.9, hardware: 'lever' },
    });
  }

  const cornerCount = derived.cornerUnits ?? 0;
  if (cornerCount > 0) {
    add({
      patternId: 'ARC-05', elementIds: b.units.filter(u => u.aspect === 'corner').map(u => u.id),
      params: { cornerUnits: cornerCount, dualAspectUnits: derived.dualAspectUnits ?? 0 },
    });
  }
  add({
    patternId: 'ARC-06',
    params: { wwr: derived.wwr ?? 0, windows: b.windows.length, dualAspectShare: derived.dualAspectShare ?? 0 },
    note: 'wwr target and exterior sides passed to every unit layout request',
  });

  const typical = new Map<string, number>();
  for (const f of floors) if (f.use === 'residential') typical.set(`${f.unitIds.length}`, (typical.get(`${f.unitIds.length}`) ?? 0) + 1);
  add({
    patternId: 'ARC-08',
    params: {
      residentialFloors: floors.filter(f => f.use === 'residential').length,
      distinctPlans: typical.size,
      unitsPerTypicalFloor: floors.find(f => f.use === 'residential')?.unitIds.length ?? 0,
    },
    note: 'one typical plan per (use, outline, mix); wet walls and shafts therefore stack',
  });
  if (b.units.some(u => u.wetWallIds.length > 0)) {
    add({
      patternId: 'XD-01', elementIds: b.units.flatMap(u => u.wetWallIds),
      params: { wetWallThickness: SIZES.wetWallT, unitsStacked: b.units.length },
    });
  }

  const lobbies = b.rooms.filter(r => r.type === 'lobby' || r.type === 'mail' || r.type === 'lift-lobby');
  if (lobbies.length > 0) {
    add({
      patternId: 'ARC-31', storey: lobbies[0].storey, elementIds: lobbies.map(r => r.id),
      params: {
        lobbyArea: round(b.rooms.filter(r => r.type === 'lobby').reduce((a, r) => a + r.area, 0), 1),
        mailRooms: b.rooms.filter(r => r.type === 'mail').length,
        liftLobbies: b.rooms.filter(r => r.type === 'lift-lobby').length,
      },
    });
  }
  add({
    patternId: 'ARC-33', elementIds: b.stairs.filter(s => s.isExit).map(s => s.id),
    params: {
      maxTravelDistance: derived.maxTravelDistance ?? 0,
      limit: ctx.typology.sprinklered ? 76 : 61,
      sprinklered: ctx.typology.sprinklered,
      exitStairs: cores.length,
    },
  });
  const retail = b.rooms.filter(r => r.type === 'retail');
  if (retail.length > 0) {
    add({
      patternId: 'ARC-34', storey: retail[0].storey, elementIds: retail.map(r => r.id),
      params: {
        tenancies: retail.length,
        retailArea: round(retail.reduce((a, r) => a + r.area, 0), 1),
        shopfrontSill: 0.3,
        shopfrontHeight: 3.0,
      },
    });
  }
}

function moduleOf(r: Rect, accessSide: Side): number {
  return accessSide === 'front' || accessSide === 'rear' ? r.w : r.h;
}

export { rectToPolygon };
export type { OrganizerDeps, FloorCtx };
