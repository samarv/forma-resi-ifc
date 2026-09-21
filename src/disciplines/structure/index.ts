/**
 * STRUCTURE discipline — grid, columns, beams, structural walls, slabs and foundations.
 *
 * OWNERSHIP (agreed with the architecture agent)
 *  - Architecture emits EVERY IfcWall for exterior / party / corridor / core / partition walls.
 *    This module records them as `StructWall` entries carrying `archWallId` and emits NO element
 *    for them; the IFC writer must set Pset_WallCommon.LoadBearing = TRUE (and PredefinedType
 *    SHEAR for role 'shear' | 'core') on every architecture wall listed in `struct.walls[].archWallId`.
 *  - Structure emits `wall` elements ONLY where architecture has none: basement retaining walls
 *    and foundation stem walls.
 *  - Structure owns every structural slab (floor, ground/base, roof, podium transfer), every
 *    column, beam, footing, pile cap and pile. Architecture owns balcony slabs and pitched roofs.
 *
 * Z CONVENTIONS
 *  - Element Z is storey-local (0 = that storey's finished floor level).
 *  - Floor slab: `position.z = -thickness`, so the slab TOP is the storey's FFL.
 *  - Column: base at z = 0, height = floorToFloor - (thickness of the slab above).
 *  - Beam: the section is centred on the axis, and the beam top is at
 *    floorToFloor - slabTAbove, so it occupies [f2f - slabT - depth, f2f - slabT].
 *    `StructBeam.z` records the UNDERSIDE.
 *  - FOOTINGS (the convention chosen here): on the `FND` storey, local z = 0 is the FOUNDING
 *    LEVEL (the `FND` storey elevation = lowest floor level - foundation depth). Every footing
 *    and pile cap is placed with its UNDERSIDE on that datum, i.e. `position.z = height`
 *    (footing geometry position is the TOP centre and extrudes downward). A 0.3 m strip footing
 *    therefore has its top at z = 0.3; a 0.5 m pad at z = 0.5; a 0.9 m pile cap at z = 0.9.
 *    Piles hang from the pile-cap underside: pile top at z = 0, extending down by `length`.
 *    Stem walls run from the strip-footing top (z = 0.3) to the underside of the ground slab
 *    (z = foundationDepth - groundSlabThickness).
 *
 * SLAB OPENING CONVENTION: `RectangularOpeningDef.position` for a slab is the opening CENTRE
 * relative to the slab position (this is what the vendored IfcCreator's addSlabOpening expects —
 * it centres the rectangle profile on the placement). Width = X extent, height = Y extent.
 */
import type {
  BalconyDef, FloorPlan, FootprintShape, FoundationElement, FoundationType, GenContext,
  GridLine, ModelElement, PatternApplication, Polygon, PropertySetDef, QuantitySetDef, Rect,
  RectangularOpeningDef, StairDef, StoreyDef, StructBeam, StructColumn, StructModel,
  StructSlab, StructWall, StructuralSystemId, Vec2, Vec3, WallDef,
} from '../../core/types.ts';
import type { Box3, ElementKind } from '../../core/kernel/types.ts';
import type { Ledger, RuleSet } from '../../core/rules/types.ts';
import {
  dist, inset, offsetPolygon, pointInPolygon, polygonArea, polygonBounds, rectArea, rectCenter,
  rectIntersection, rectToPolygon, rectUnionBounds, relativeTo, round,
} from '../../core/geometry.ts';
import { IdFactory, FOUNDATION_STOREY, ROOF_STOREY, storeyIdFor } from '../../core/ids.ts';
import { buildGrid, insideAnyRect, tributaryExtent, type GridPlan } from './grid.ts';
import { collectingLedger, passthroughRuleSet } from './fallbacks.ts';
import { checkLoadPath, loadPathBases } from './loadpath.ts';
import { presizeStructure, type StructuralPresize } from './presize.ts';
import { createProfileBook } from './profiles-seam.ts';
import {
  CARBON, COLORS, FOUNDATION_RULES, LINTEL, MATERIALS,
  RC_KGCO2E_PER_M3, STEEL_KG_PER_M2, TIMBER_RIM, TRANSFER, beamSection, bearingWallMaterialFor,
  columnMaterialFor, columnSection, columnSide, floorPlateMaterialFor, foundationIndex,
  frameColor, isBearingWallSystem, isFrameSystem, isHybridPodiumSystem, materialFor,
  padSide, sizesFor, slabSection, systemIndex, timberIntensity,
  type FrameMaterial, type Loads, type Sizes, type WallMaterial,
} from './sizing.ts';

export { STRUCT_PATTERNS } from './patterns.ts';
export { checkLoadPath, loadPathBases } from './loadpath.ts';

/**
 * Every MEP kind that may not enter a structural member or a lift hoistway. Registered as the `bans` of the
 * structure keep-outs so `kernel.validate` reports a penetration instead of a silent clash.
 * *No designed openings exist in this model: sleeves go through slabs and non-structural walls only.*
 */
const MEP_KINDS: readonly ElementKind[] = [
  'duct', 'duct-fitting', 'air-terminal', 'fan', 'ahu', 'jet-fan',
  'waste', 'vent', 'storm', 'trench-drain', 'dcw', 'dhw', 'hwr', 'gas',
  'sprinkler-main', 'sprinkler-branch', 'sprinkler-head', 'standpipe',
  'tray-power', 'tray-data', 'conduit', 'busduct', 'panel', 'switchgear',
  'light', 'sensor', 'ev-charger', 'pump', 'tank', 'sump', 'ejector', 'plinth',
];

/** How a storey is framed: RC/steel column frame, or load-bearing walls */
type StoreyMode = 'frame-rc' | 'frame-steel' | 'bearing';

export function generateStructure(ctx: GenContext): StructModel {
  const ids = new IdFactory('structure');
  const spec = ctx.spec;
  const arch = ctx.arch;
  const detail = spec.options.detail;
  const elements: ModelElement[] = [];
  const apps: PatternApplication[] = [];
  const warn = (m: string): void => { ctx.warnings.push(`[structure] ${m}`); };

  // ---------------------------------------------------------------- rules, issues, pre-sizing
  // `ctx.rules` / `ctx.issues` / `ctx.presize` are optional until the pipeline threads them (step 7 makes them
  // required). Without a rule set every `rules.num(id, fallback)` keeps today's constant; without a ledger the
  // issues are collected locally so nothing is lost and no new warning string is invented.
  const rules: RuleSet = ctx.rules ?? passthroughRuleSet();
  const ledger: Ledger = ctx.issues ?? collectingLedger();
  // The pipeline owns the pre-sizing (it runs BEFORE architecture and publishes `storeysResolved`). When it has
  // not been wired yet, structure runs the same pure function itself against a throwaway ledger, so slab, beam,
  // core-wall and transfer numbers still have exactly one owner. Geometry always follows `ctx.storeys`.
  const presize: StructuralPresize = ctx.presize ?? presizeStructure({
    spec,
    typology: ctx.typology,
    site: ctx.site,
    storeys: ctx.storeys,
    profiles: createProfileBook(rules),
    rules,
    ledger: collectingLedger(),
  });

  // ---------------------------------------------------------------- storeys
  const byId = new Map<string, StoreyDef>(ctx.storeys.map(s => [s.id, s]));
  const aboveGrade = ctx.storeys.filter(s => s.index >= 0 && s.index < 100).sort((a, b) => a.index - b.index);
  const basements = ctx.storeys.filter(s => s.index < 0 && s.index > -100).sort((a, b) => a.index - b.index);
  const framedStoreys = [...basements, ...aboveGrade];
  const roofStorey = ctx.storeys.find(s => s.id === ROOF_STOREY) ?? null;
  const fndStorey = ctx.storeys.find(s => s.id === FOUNDATION_STOREY) ?? null;
  const storeyCount = Math.max(1, aboveGrade.length);
  const topStorey = aboveGrade[aboveGrade.length - 1] ?? ctx.storeys[0];
  const lowestStorey = framedStoreys[0] ?? topStorey;
  const orderIndex = new Map<string, number>(framedStoreys.map((s, i) => [s.id, i]));

  // ---------------------------------------------------------------- system (all from the pre-sizing)
  const system: StructuralSystemId = presize.system;
  const parkingType = spec.site.parking?.type ?? ctx.typology.parking;
  const foundation: FoundationType = presize.foundation;
  const podiumStoreys = presize.podiumStoreys;
  // ONE owner for the transfer level: its FLOOR slab is the transfer slab, and the storey BELOW it carries the
  // transfer zone. v1 had architecture thicken `index + 1 === podiumStoreys` and structure `storeyIdFor(podium)`.
  const transferStorey = presize.transferStorey ?? undefined;
  const podiumTopStoreyId = presize.transferBelowStorey ?? undefined;
  const loads: Loads = presize.loads;

  const modeOf = (s: StoreyDef): StoreyMode => {
    if (system === 'steel-frame') return 'frame-steel';
    if (isFrameSystem(system)) return 'frame-rc';
    if (isHybridPodiumSystem(system)) return s.index < 0 || s.index < podiumStoreys ? 'frame-rc' : 'bearing';
    return 'bearing';
  };
  const isPodiumStorey = (s: StoreyDef): boolean => s.index < 0 || (s.index >= 0 && s.index < podiumStoreys) || s.use === 'parking';

  // ---------------------------------------------------------------- plans
  const planByStorey = new Map<string, FloorPlan>((arch?.floors ?? []).map(f => [f.storey, f]));
  const siteFootprint = ctx.site?.massing?.footprint ?? [];
  const fallbackOutline: Polygon = siteFootprint.length >= 3
    ? siteFootprint
    : rectToPolygon({ x: 0, y: 0, w: Math.max(6, spec.massing.buildingLength ?? 20), h: Math.max(6, spec.massing.buildingDepth ?? 12) });
  const outlineOf = (id: string): Polygon => {
    const p = planByStorey.get(id);
    if (p && p.outline.length >= 3) return p.outline;
    if (id === ROOF_STOREY || id === FOUNDATION_STOREY) {
      const t = planByStorey.get(id === ROOF_STOREY ? topStorey.id : lowestStorey.id);
      if (t && t.outline.length >= 3) return t.outline;
    }
    return fallbackOutline;
  };

  // A courtyard / perimeter block has a hole in every floor plate above the podium. `Polygon`
  // cannot express a hole, so the void is carried as a slab opening and as a column blocker.
  const courtyardPoly = ctx.site?.massing?.courtyard;
  const courtyardRect: Rect | null = courtyardPoly && courtyardPoly.length >= 3 ? polygonBounds(courtyardPoly) : null;
  const courtyardOn = (storeyId: string): boolean => {
    if (!courtyardRect || courtyardRect.w < 2 || courtyardRect.h < 2) return false;
    const s = byId.get(storeyId);
    if (!s) return false;
    // a podium deck normally fills the courtyard at its own level
    if (podiumStoreys > 0 && s.index >= 0 && s.index < podiumStoreys) return false;
    if (s.index < 0) return false;
    return pointInPolygon(rectCenter(courtyardRect), outlineOf(storeyId));
  };
  /** Structural floor area of a storey, with the courtyard void removed */
  const netFloorArea = (storeyId: string): number =>
    Math.max(0, polygonArea(outlineOf(storeyId)) - (courtyardOn(storeyId) && courtyardRect ? rectArea(courtyardRect) : 0));

  const residentialStoreys = aboveGrade.filter(s => s.index >= podiumStoreys && (s.use === 'residential' || s.use === 'lobby-residential'));
  const typicalStorey = residentialStoreys.length > 0
    ? residentialStoreys[Math.floor(residentialStoreys.length / 2)]
    : topStorey;

  const wallsByStorey = new Map<string, WallDef[]>();
  for (const w of arch?.walls ?? []) {
    const list = wallsByStorey.get(w.storey);
    if (list) list.push(w); else wallsByStorey.set(w.storey, [w]);
  }
  // ---------------------------------------------------------------- grid
  const bars = ctx.site?.massing?.bars ?? [];
  const typicalBounds = polygonBounds(outlineOf(typicalStorey.id));
  const longAxis: 'x' | 'y' = bars.length > 0 ? bars[0].axis : (typicalBounds.w >= typicalBounds.h ? 'x' : 'y');
  const shape: FootprintShape = spec.massing.footprintShape ?? ctx.typology.footprintShapes[0];
  const podiumOutline = podiumStoreys > 0 ? outlineOf(storeyIdFor(0)) : (basements.length > 0 ? outlineOf(lowestStorey.id) : null);
  const exteriorWallT = presize.exteriorWallT;
  const grid: GridPlan = buildGrid({
    typicalOutline: outlineOf(typicalStorey.id),
    podiumOutline,
    longAxis,
    shape,
    walls: wallsByStorey.get(typicalStorey.id) ?? [],
    cores: arch?.cores ?? [],
    exteriorWallT,
    includeParkingGrid: podiumStoreys > 0 || basements.length > 0 || aboveGrade.some(s => s.use === 'parking'),
    partyLines: arch?.partyLines,
    namer: label => ids.named('GRID', label),
  });
  const gridLines: GridLine[] = grid.lines;

  const maxTribX = Math.max(...grid.mainX.map((_, i) => tributaryExtent(grid.mainX, i)), 3);
  const maxTribY = Math.max(...grid.mainY.map((_, i) => tributaryExtent(grid.mainY, i)), 3);
  // Column and beam WIDTHS still come from the real grid (it is finer than the pre-sizing's proposal); slab,
  // beam depth and shear-wall thickness are the pre-sizing's to own, because other disciplines read them.
  const sizes: Sizes = {
    ...sizesFor(system, storeyCount, maxTribX * maxTribY, loads),
    slabT: presize.sizes.slabT,
    beamD: presize.sizes.beamD,
    shearWallT: presize.shearWallT,
  };

  // ---------------------------------------------------------------- slab thickness per storey (from the pre-sizing)
  const usesRaft = foundation === 'raft';
  const sizingOf = (storeyId: string): { slabTOwn: number; slabTAbove: number } | null => presize.byStorey.get(storeyId) ?? null;
  const slabTOf = (storeyId: string): number => {
    const s = sizingOf(storeyId);
    if (s) return s.slabTOwn;
    if (transferStorey && storeyId === transferStorey) return presize.transferSlabT;
    return sizes.slabT;
  };
  const groundSlabT = slabTOf(lowestStorey.id);
  const storeyAbove = (storeyId: string): StoreyDef | null => {
    const i = orderIndex.get(storeyId);
    if (i === undefined) return null;
    return i + 1 < framedStoreys.length ? framedStoreys[i + 1] : roofStorey;
  };
  const thicknessAbove = (storeyId: string): number => {
    const s = sizingOf(storeyId);
    if (s) return s.slabTAbove;
    const a = storeyAbove(storeyId);
    if (!a || a.id === ROOF_STOREY) return sizes.slabT;
    return slabTOf(a.id);
  };

  // One owner, so this can only fire while architecture still computes its own slab (deviation, not a warning:
  // it becomes unreachable the moment architecture reads `ctx.presize.byStorey[...].slabTAbove`).
  // `FloorPlan.slabThickness` is the slab ABOVE the storey — it is what architecture subtracts from the
  // floor-to-floor to get its wall height and ceiling, so it must equal `slabTAbove`, not the storey's own slab.
  for (const s of framedStoreys) {
    const plan = planByStorey.get(s.id);
    const want = thicknessAbove(s.id);
    if (!plan || plan.slabThickness <= 0 || Math.abs(plan.slabThickness - want) <= 0.02) continue;
    const added = ledger.addOnce(`STR-09.slabThickness:${s.id}`, {
      severity: 'deviation',
      ruleId: 'STR-09.slabThickness',
      discipline: 'structure',
      storey: s.id,
      message: `arch.floors[${s.id}].slabThickness ${plan.slabThickness.toFixed(3)} differs from the pre-sized slab above it ${want.toFixed(3)} — the pre-sizing is the single owner; architecture should read presize.byStorey.get('${s.id}').slabTAbove.`,
      observed: round(plan.slabThickness, 3),
      limit: round(want, 3),
      source: 'presize / STR-09',
      resolution: { id: 'none', note: 'structure uses the pre-sized thickness; architecture ceiling heights stay 0.05 m out until it adopts it' },
    });
    if (added) break; // one issue per run, not one per storey
  }

  // ---------------------------------------------------------------- openings (STR-07)
  // One opening per stair FLIGHT (not per core), deduped across storeys: the stairwell footprint
  // repeats identically on every level, and a per-core union would swallow the lift zone.
  const stairwellByCore = new Map<string, Rect[]>();
  for (const core of arch?.cores ?? []) {
    const rects: Rect[] = [];
    const seen = new Set<string>();
    for (const st of arch?.stairs ?? []) {
      if (st.coreId !== core.id) continue;
      const run = st.landingRect ? rectUnionBounds([stairRunRect(st), st.landingRect]) : stairRunRect(st);
      const clipped = rectIntersection(core.rect, run);
      if (!clipped) continue;
      const k = `${round(clipped.x, 2)}:${round(clipped.y, 2)}:${round(clipped.w, 2)}:${round(clipped.h, 2)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      rects.push(clipped);
    }
    if (rects.length > 0) stairwellByCore.set(core.id, rects);
  }

  const openingsFor = (storeyId: string): { rect: Rect; name: string }[] => {
    const out: { rect: Rect; name: string }[] = [];
    const seen = new Set<string>();
    const push = (r: Rect, name: string): void => {
      if (r.w < 0.25 || r.h < 0.25) return;
      const k = `${round(r.x, 2)}:${round(r.y, 2)}:${round(r.w, 2)}:${round(r.h, 2)}`;
      if (seen.has(k)) return;
      // never nest one void inside another
      for (const o of out) {
        if (r.x >= o.rect.x - 0.01 && r.y >= o.rect.y - 0.01
          && r.x + r.w <= o.rect.x + o.rect.w + 0.01 && r.y + r.h <= o.rect.y + o.rect.h + 0.01) return;
      }
      seen.add(k);
      out.push({ rect: r, name });
    };
    // The courtyard void first, so anything that falls inside it is not cut twice
    if (courtyardOn(storeyId) && courtyardRect) push(courtyardRect, 'Courtyard void');
    // A stair or lift that stops at the lowest slab must not be cut through it
    const cutVertical = storeyId !== lowestStorey.id || basements.length > 0;
    if (cutVertical) {
      for (const core of arch?.cores ?? []) {
        if (!core.storeys.includes(storeyId)) continue;
        for (const r of stairwellByCore.get(core.id) ?? []) push(r, `Stairwell opening ${core.id}`);
      }
      for (const e of arch?.elevators ?? []) {
        if (e.storeys.includes(storeyId)) push(e.rect, `Lift shaft opening ${e.id}`);
      }
    }
    for (const sh of arch?.shafts ?? []) {
      if (!sh.storeys.includes(storeyId)) continue;
      if (sh.purpose === 'elevator' && !cutVertical) continue;
      push(sh.rect, `${sh.purpose} riser opening ${sh.id}`);
    }
    return out;
  };

  // ---------------------------------------------------------------- slabs
  const slabs: StructSlab[] = [];
  const flatRoof = (arch?.roof.type ?? spec.massing.roof) === 'flat';
  const slabMaterialOf = (storeyId: string): FrameMaterial => {
    const s = byId.get(storeyId);
    if (storeyId === lowestStorey.id) return 'concrete';
    if (transferStorey && storeyId === transferStorey) return 'concrete';
    if (s && isPodiumStorey(s)) return 'concrete';
    return floorPlateMaterialFor(system);
  };

  const emitSlab = (
    storeyId: string,
    outline: Polygon,
    thickness: number,
    type: StructSlab['type'],
    predefinedType: string,
    material: FrameMaterial,
  ): StructSlab => {
    const b = polygonBounds(outline);
    const position: Vec3 = [round(b.x, 4), round(b.y, 4), round(-thickness, 4)];
    const profile = relativeTo(outline, [position[0], position[1]]).map(p => [round(p[0], 4), round(p[1], 4)] as Vec2);
    const raw = openingsFor(storeyId).filter(o => pointInPolygon(rectCenter(o.rect), outline));
    const openings: RectangularOpeningDef[] = raw.map(o => ({
      name: o.name,
      width: round(o.rect.w, 4),
      height: round(o.rect.h, 4),
      // CENTRE of the opening relative to the slab position (IfcCreator centres the profile)
      position: [round(o.rect.x + o.rect.w / 2 - position[0], 4), round(o.rect.y + o.rect.h / 2 - position[1], 4), 0],
    }));
    const grossArea = polygonArea(outline);
    const holeArea = raw.reduce((a, o) => a + rectArea(o.rect), 0);
    const netArea = Math.max(0, grossArea - holeArea);
    const slab: StructSlab = {
      id: ids.next(storeyId, 'SLAB'),
      storey: storeyId,
      outline,
      thickness,
      type,
      openings: raw.map(o => o.rect),
    };
    slabs.push(slab);
    const isConcrete = material === 'concrete';
    const isExternal = type === 'ground' || type === 'roof';
    elements.push({
      id: slab.id,
      discipline: 'structure',
      ifcType: 'IfcSlab',
      predefinedType,
      name: `${type === 'ground' ? 'Ground slab' : type === 'roof' ? 'Roof slab' : type === 'podium-transfer' ? 'Podium transfer slab' : 'Floor slab'} ${storeyId}`,
      objectType: type === 'podium-transfer' ? 'TransferSlab' : type === 'ground' ? 'BaseSlab' : undefined,
      storey: storeyId,
      geometry: { kind: 'slab', position, profile, thickness, openings },
      psets: [
        pset('Pset_SlabCommon', [
          { name: 'LoadBearing', value: true },
          { name: 'IsExternal', value: isExternal },
          { name: 'Reference', value: slabSection(material, thickness, system) },
          { name: 'PitchAngle', value: 0 },
        ]),
        formaStructure(system, isConcrete ? 'Reinforced concrete' : material === 'timber' ? MATERIALS.clt.name : MATERIALS.steel.name, slabSection(material, thickness, system), netArea, '-', {
          SlabType: type,
          OpeningCount: raw.length,
          StructuralDepth: thickness,
        }),
      ],
      quantities: [qset('Qto_SlabBaseQuantities', [
        { name: 'Depth', value: round(thickness, 4), kind: 'IfcQuantityLength' },
        { name: 'GrossArea', value: round(grossArea, 3), kind: 'IfcQuantityArea' },
        { name: 'NetArea', value: round(netArea, 3), kind: 'IfcQuantityArea' },
        { name: 'GrossVolume', value: round(grossArea * thickness, 3), kind: 'IfcQuantityVolume' },
        { name: 'NetVolume', value: round(netArea * thickness, 3), kind: 'IfcQuantityVolume' },
      ])],
      material: isConcrete ? MATERIALS.reinforcedConcrete : material === 'timber' ? (system === 'mass-timber-clt' ? MATERIALS.clt : MATERIALS.glulam) : MATERIALS.reinforcedConcrete,
      color: COLORS.slab,
      patterns: type === 'roof' ? ['STR-11', 'STR-07'] : type === 'podium-transfer' ? ['STR-04', 'STR-07'] : ['STR-07'],
      tags: ['structure', 'slab', type],
    });
    return slab;
  };

  for (const s of framedStoreys) {
    if (s.id === lowestStorey.id && usesRaft) continue; // the raft IS the lowest slab
    const isGround = s.id === lowestStorey.id;
    const isTransfer = transferStorey === s.id;
    const t = slabTOf(s.id);
    emitSlab(
      s.id,
      outlineOf(s.id),
      t,
      isGround ? 'ground' : isTransfer ? 'podium-transfer' : 'floor',
      isGround ? 'BASESLAB' : 'FLOOR',
      slabMaterialOf(s.id),
    );
  }
  if (roofStorey && flatRoof) {
    const roofOutline = arch?.roof.outline && arch.roof.outline.length >= 3 ? arch.roof.outline : outlineOf(topStorey.id);
    emitSlab(roofStorey.id, roofOutline, sizes.slabT, 'roof', 'ROOF', slabMaterialOf(roofStorey.id));
    apps.push({
      patternId: 'STR-11',
      storey: roofStorey.id,
      params: { roofType: 'flat', slabThickness: sizes.slabT, roofLiveKpa: loads.roofLiveKpa, diaphragm: 'RC slab tied to core and rim beam' },
    });
  } else if (roofStorey) {
    apps.push({
      patternId: 'STR-11',
      storey: roofStorey.id,
      params: { roofType: arch?.roof.type ?? spec.massing.roof, slabThickness: 0, diaphragm: 'sheathed and blocked, continuous ties over party walls' },
      note: 'Pitched roof: architecture emits the IfcRoof; structure records the diaphragm requirement only.',
    });
  }

  // ---------------------------------------------------------------- columns
  const columns: StructColumn[] = [];
  const colMaterial: FrameMaterial = columnMaterialFor(system);
  const columnsByStorey = new Map<string, StructColumn[]>();
  let snapCount = 0;
  let droppedInCores = 0;
  let maxTributary = 0;

  const blockerRects = (storeyId: string): Rect[] => {
    const out: Rect[] = [];
    if (courtyardOn(storeyId) && courtyardRect) out.push(courtyardRect);
    for (const c of arch?.cores ?? []) if (c.storeys.includes(storeyId)) out.push(c.rect);
    for (const e of arch?.elevators ?? []) if (e.storeys.includes(storeyId)) out.push(e.rect);
    for (const sh of arch?.shafts ?? []) if (sh.storeys.includes(storeyId)) out.push(sh.rect);
    for (const r of arch?.rooms ?? []) {
      if (r.storey !== storeyId) continue;
      if (r.type === 'stair' || r.type === 'elevator' || r.type === 'shaft') out.push(r.rect);
    }
    return out;
  };

  const columnsOnStorey = (s: StoreyDef): boolean => {
    if (isFrameSystem(system)) return true;
    if (isHybridPodiumSystem(system)) return s.index < 0 || s.index < podiumStoreys;
    return false;
  };

  /**
   * STR-C1 by construction. A parking storey runs on the 8.4 / 16.8 module and the storey above runs on the
   * party-wall grid; that jump is only legal across a TRANSFER level. A basement under a residential frame with
   * no podium (uk-mansion, ie-courtyard) therefore has to carry BOTH sets of lines, or every column on the
   * ground floor lands on a slab with nothing underneath — which is exactly what v1 produced, unreported.
   */
  const gridKindOf = (s: StoreyDef): 'park' | 'main' => (isPodiumStorey(s) ? 'park' : 'main');
  const carriesGridAbove = (s: StoreyDef): boolean => {
    const a = storeyAbove(s.id);
    if (!a || a.id === ROOF_STOREY) return false;
    if (transferStorey !== undefined && a.id === transferStorey) return false; // the transfer level makes the jump
    return gridKindOf(a) !== gridKindOf(s);
  };
  for (const s of framedStoreys) {
    if (!columnsOnStorey(s)) continue;
    // A parking storey that has to carry the frame above WITHOUT a transfer level cannot run on the parking
    // module at all: it has to be the same grid, or nothing lands on anything.
    const parking = isPodiumStorey(s) && !carriesGridAbove(s);
    const xs = parking ? grid.parkX : grid.mainX;
    const ys = parking ? grid.parkY : grid.mainY;
    const outline = outlineOf(s.id);
    const blockers = blockerRects(s.id);
    const height = round(s.height - thicknessAbove(s.id), 4);
    const storeysAbove = Math.max(1, topStorey.index - s.index + 1);
    const list: StructColumn[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < xs.length; i++) {
      for (let j = 0; j < ys.length; j++) {
        // ONE grid for the whole building: the intersection is used as-is on every storey. STR-03 is satisfied
        // by the grid itself (its transverse lines ARE wall centrelines), not by a per-storey snap that used to
        // move the same column by up to 0.6 m between levels.
        const p: Vec2 = [xs[i], ys[j]];
        if (insideAnyRect(p, blockers)) { droppedInCores++; continue; }
        if (!pointInPolygon(p, outline)) continue;
        const key = `${round(p[0], 2)}:${round(p[1], 2)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const onWall = grid.isWallLine('x', p[0]) && grid.isWallLine('y', p[1]);
        if (onWall) snapCount++;
        const tributary = round(tributaryExtent(xs, i) * tributaryExtent(ys, j), 3);
        maxTributary = Math.max(maxTributary, tributary);
        const side = columnSide(colMaterial, storeysAbove, tributary, loads);
        const gridRef = grid.ref(p[0], p[1]);
        const col: StructColumn = {
          id: ids.next(s.id, 'COL'),
          storey: s.id,
          position: [round(p[0], 4), round(p[1], 4)],
          width: side,
          depth: side,
          height,
          gridRef,
          material: colMaterial,
        };
        list.push(col);
        columns.push(col);
        const section = columnSection(colMaterial, side, side);
        elements.push({
          id: col.id,
          discipline: 'structure',
          ifcType: 'IfcColumn',
          predefinedType: 'COLUMN',
          name: `Column ${gridRef} ${s.id}`,
          objectType: section,
          storey: s.id,
          geometry: { kind: 'column', position: [col.position[0], col.position[1], 0], width: side, depth: side, height, shape: 'rect' },
          psets: [
            pset('Pset_ColumnCommon', [
              { name: 'LoadBearing', value: true },
              { name: 'Reference', value: gridRef },
              { name: 'Slope', value: 0 },
              { name: 'IsExternal', value: false },
            ]),
            formaStructure(system, materialFor(colMaterial).name, section, tributary, gridRef, {
              StoreysAbove: storeysAbove,
              AxialLoadKn: round(storeysAbove * (loads.deadKpa + loads.liveKpa) * tributary, 1),
              OnWallCentreline: onWall,
            }),
          ],
          quantities: [qset('Qto_ColumnBaseQuantities', [
            { name: 'Length', value: height, kind: 'IfcQuantityLength' },
            { name: 'CrossSectionArea', value: round(side * side, 4), kind: 'IfcQuantityArea' },
            { name: 'GrossVolume', value: round(side * side * height, 4), kind: 'IfcQuantityVolume' },
          ])],
          material: materialFor(colMaterial),
          color: frameColor(colMaterial),
          patterns: ['STR-02', 'STR-03', 'STR-10', 'XD-03'],
          tags: ['structure', 'column'],
        });
      }
    }
    columnsByStorey.set(s.id, list);
  }

  // ---------------------------------------------------------------- structural walls
  const walls: StructWall[] = [];
  const bearingWallIds = new Set<string>();
  const coreRects = (arch?.cores ?? []).map(c => c.rect);
  const nearCore = (w: WallDef): boolean => {
    const mid: Vec2 = [(w.start[0] + w.end[0]) / 2, (w.start[1] + w.end[1]) / 2];
    return coreRects.some(r => {
      const grown = inset(r, -2.0);
      return mid[0] >= grown.x && mid[0] <= grown.x + grown.w && mid[1] >= grown.y && mid[1] <= grown.y + grown.h;
    });
  };
  const bearingMaterial: WallMaterial = bearingWallMaterialFor(system);
  /**
   * Shortest wall for which `WallDef.loadBearingHint` is taken up as a real bearing wall. Below this an internal
   * wall is a stub partition, not a line of support (STR-09 timber span band).
   */
  const minHintedBearingLength = rules.num('STR-09.minHintedBearingLength', 3.0);

  for (const w of arch?.walls ?? []) {
    const s = byId.get(w.storey);
    if (!s || s.index >= 100 || s.index <= -100) continue;
    const mode = modeOf(s);
    let role: StructWall['role'] | null = null;
    let material: WallMaterial = 'concrete';
    if (w.type === 'core') {
      role = 'core';
      material = 'concrete';
    } else if (w.type === 'retaining') {
      role = 'foundation';
      material = 'concrete';
    } else if (mode === 'bearing' && (w.type === 'exterior' || w.type === 'party' || w.type === 'corridor')) {
      role = 'bearing';
      material = bearingMaterial;
    } else if (mode === 'bearing' && w.loadBearingHint && dist(w.start, w.end) >= minHintedBearingLength
      && (w.type === 'partition' || w.type === 'wet')) {
      // Architecture's hint, taken up where it is structurally credible: an internal spine wall
      // long enough to halve the joist span really does carry floor (WallDef.loadBearingHint —
      // "architecture's hint; structure makes the final call"). Short stub partitions do not.
      role = 'bearing';
      material = bearingMaterial;
    } else if (w.type === 'exterior' && s.id === lowestStorey.id && isPodiumStorey(s)) {
      // At grade the podium / parking perimeter is a concrete bearing-and-retaining wall,
      // so it needs a strip footing of its own (STR-06) rather than sitting on the slab.
      role = 'bearing';
      material = 'concrete';
    } else if (system === 'rc-flat-plate-core' && storeyCount > 20 && w.type === 'party' && nearCore(w)) {
      role = 'shear';
      material = 'concrete';
    }
    if (!role) continue;
    // No core/shear-wall thickness warning any more: `presize.coreWallT` IS the number architecture builds to
    // (0.25 m for a low-rise fire enclosure, 0.30 m once the core is the shear spine — ACI 318-19 §18.10.2.1).
    const sw: StructWall = {
      id: ids.next(w.storey, role === 'core' ? 'CORWALL' : role === 'shear' ? 'SHRWALL' : role === 'foundation' ? 'RETWALL' : 'BRGWALL'),
      storey: w.storey,
      archWallId: w.id,
      start: w.start,
      end: w.end,
      thickness: w.thickness,
      height: w.height,
      role,
      material,
    };
    walls.push(sw);
    if (role === 'bearing') bearingWallIds.add(w.id);
  }

  // Basement retaining walls where architecture has none on that storey
  const archWallTypesOn = (storeyId: string): Set<string> => new Set((wallsByStorey.get(storeyId) ?? []).map(w => w.type));
  for (const s of basements) {
    const types = archWallTypesOn(s.id);
    if (types.has('retaining') || types.has('exterior')) continue;
    const ring = offsetPolygon(outlineOf(s.id), 0.15);
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      if (dist(a, b) < 0.5) continue;
      const sw: StructWall = {
        id: ids.next(s.id, 'RETWALL'),
        storey: s.id,
        start: a,
        end: b,
        thickness: 0.3,
        height: s.height,
        role: 'foundation',
        material: 'concrete',
      };
      walls.push(sw);
      elements.push({
        id: sw.id,
        discipline: 'structure',
        ifcType: 'IfcWall',
        predefinedType: 'SOLIDWALL',
        name: `Basement retaining wall ${s.id}`,
        objectType: 'RetainingWall',
        storey: s.id,
        geometry: { kind: 'wall', start: [a[0], a[1], 0], end: [b[0], b[1], 0], thickness: 0.3, height: s.height },
        psets: [
          pset('Pset_WallCommon', [
            { name: 'LoadBearing', value: true },
            { name: 'IsExternal', value: true },
            { name: 'ExtendToStructure', value: true },
          ]),
          formaStructure(system, MATERIALS.reinforcedConcrete.name, '300 mm RC retaining wall', round(dist(a, b) * s.height, 2), '-', { Role: 'foundation', RetainedHeight: round(s.height, 3) }),
        ],
        material: MATERIALS.reinforcedConcrete,
        color: COLORS.foundation,
        patterns: ['STR-06'],
        tags: ['structure', 'wall', 'retaining'],
      });
    }
  }

  // ---------------------------------------------------------------- beams
  const beams: StructBeam[] = [];
  const archWallById = new Map<string, WallDef>((arch?.walls ?? []).map(w => [w.id, w]));

  const pushBeam = (
    storeyId: string,
    a: Vec2,
    b: Vec2,
    width: number,
    depth: number,
    material: FrameMaterial,
    role: StructBeam['role'],
    zUnder: number,
    gridRef: string,
  ): void => {
    const length = dist(a, b);
    if (length < 0.4) return;
    const beam: StructBeam = {
      id: ids.next(storeyId, role === 'lintel' ? 'LINTEL' : role === 'transfer' ? 'TBEAM' : 'BEAM'),
      storey: storeyId,
      start: [round(a[0], 4), round(a[1], 4)],
      end: [round(b[0], 4), round(b[1], 4)],
      z: round(zUnder, 4),
      width,
      depth,
      material,
      role,
    };
    beams.push(beam);
    const zAxis = round(zUnder + depth / 2, 4);
    const section = beamSection(material, width, depth);
    elements.push({
      id: beam.id,
      discipline: 'structure',
      ifcType: 'IfcBeam',
      predefinedType: role === 'lintel' ? 'LINTEL' : role === 'secondary' ? 'JOIST' : role === 'rim' ? 'EDGEBEAM' : 'BEAM',
      name: `${role[0].toUpperCase()}${role.slice(1)} beam ${gridRef} ${storeyId}`,
      objectType: section,
      storey: storeyId,
      geometry: { kind: 'beam', start: [beam.start[0], beam.start[1], zAxis], end: [beam.end[0], beam.end[1], zAxis], width, height: depth },
      psets: [
        pset('Pset_BeamCommon', [
          { name: 'LoadBearing', value: true },
          { name: 'Reference', value: gridRef },
          { name: 'Slope', value: 0 },
          { name: 'Span', value: round(length, 3) },
          { name: 'IsExternal', value: role === 'rim' },
        ]),
        formaStructure(system, materialFor(material).name, section, round(length * (role === 'rim' ? 1.5 : 3.0), 2), gridRef, {
          Role: role,
          SoffitZ: round(zUnder, 4),
          SpanDepthRatio: round(length / depth, 1),
        }),
      ],
      quantities: [qset('Qto_BeamBaseQuantities', [
        { name: 'Length', value: round(length, 3), kind: 'IfcQuantityLength' },
        { name: 'CrossSectionArea', value: round(width * depth, 4), kind: 'IfcQuantityArea' },
        { name: 'GrossVolume', value: round(width * depth * length, 4), kind: 'IfcQuantityVolume' },
      ])],
      material: materialFor(material),
      color: frameColor(material),
      patterns: role === 'transfer' ? ['STR-04', 'STR-09'] : role === 'lintel' ? ['STR-08'] : ['STR-09'],
      tags: ['structure', 'beam', role],
    });
  };

  /**
   * STR-C4. The slab of storey k+1 is carried by storey k's structure, so wherever the plate ABOVE reaches past
   * this storey's own plate edge (a deeper basement under a shallower ground floor, a podium under a tower) its
   * edge needs a beam here. v1 only ever ringed the storey's own outline, so the ground-floor plate's rear edge
   * over a deeper basement cantilevered as far as the plan happened to reach.
   */
  const edgeBeamsUnderPlateAbove = (s: StoreyDef, zTop: number, material: FrameMaterial): void => {
    const a = storeyAbove(s.id);
    if (!a || a.id === ROOF_STOREY) return;
    const ab = polygonBounds(outlineOf(a.id));
    const ob = polygonBounds(outlineOf(s.id));
    const differs = Math.abs(ab.x - ob.x) > 0.5 || Math.abs(ab.y - ob.y) > 0.5
      || Math.abs(ab.w - ob.w) > 0.5 || Math.abs(ab.h - ob.h) > 0.5;
    if (!differs) return;
    const ring = offsetPolygon(outlineOf(a.id), exteriorWallT / 2);
    for (let i = 0; i < ring.length; i++) {
      pushBeam(s.id, ring[i], ring[(i + 1) % ring.length], sizes.beamW, sizes.beamD, material, 'rim', zTop - sizes.beamD, `edge of the ${a.id} plate`);
    }
  };

  for (const s of framedStoreys) {
    const mode = modeOf(s);
    const outline = outlineOf(s.id);
    const zTop = s.height - thicknessAbove(s.id);
    const isPodiumTop = podiumTopStoreyId === s.id && transferStorey !== undefined;

    if (isPodiumTop) {
      // STR-04, corrected: a transfer beam is only a transfer beam if BOTH ends land on something. v1 laid them
      // on the residential grid across the whole plate, so a beam could hang between two points in mid-air.
      // The grillage is built in two levels instead:
      //   primary   — between CONSECUTIVE PODIUM COLUMNS on each podium grid line;
      //   secondary — under each residential line that carries load above, ending on the primaries it crosses.
      const zUnder = s.height - presize.transferSlabT - presize.transferBeamD;
      const beamW = rules.num('STR-04.transferBeamWidth', TRANSFER.beamW);
      const podiumCols = columnsByStorey.get(s.id) ?? [];
      interface TransferLine { a: Vec2; b: Vec2; constAxis: 'x' | 'y'; at: number }
      const primaries: TransferLine[] = [];
      const colsOnLine = (axis: 'x' | 'y', at: number): StructColumn[] => podiumCols
        .filter(c => Math.abs(c.position[axis === 'x' ? 0 : 1] - at) < 0.3)
        .sort((p, q) => p.position[axis === 'x' ? 1 : 0] - q.position[axis === 'x' ? 1 : 0]);
      for (const px of grid.parkX) {
        const on = colsOnLine('x', px);
        for (let k = 0; k + 1 < on.length; k++) primaries.push({ a: on[k].position, b: on[k + 1].position, constAxis: 'x', at: px });
      }
      for (const py of grid.parkY) {
        const on = colsOnLine('y', py);
        for (let k = 0; k + 1 < on.length; k++) primaries.push({ a: on[k].position, b: on[k + 1].position, constAxis: 'y', at: py });
      }
      for (const pr of primaries) {
        pushBeam(s.id, pr.a, pr.b, beamW, presize.transferBeamD, 'concrete', 'transfer', zUnder,
          `${grid.label(pr.constAxis, pr.at)} (podium column line)`);
      }
      // Secondary lines: where the load above actually is. Ends must sit on a primary that spans across them.
      const emitted: { constAxis: 'x' | 'y'; at: number }[] = [];
      const secondary = (constAxis: 'x' | 'y', at: number): void => {
        if (primaries.some(pr => pr.constAxis === constAxis && Math.abs(pr.at - at) < 0.3)) return;
        if (emitted.some(pr => pr.constAxis === constAxis && Math.abs(pr.at - at) < 0.3)) return;
        emitted.push({ constAxis, at });
        const crossAxis: 'x' | 'y' = constAxis === 'x' ? 'y' : 'x';
        const i = constAxis === 'x' ? 0 : 1;
        const ends = primaries
          .filter(pr => pr.constAxis === crossAxis && Math.min(pr.a[i], pr.b[i]) - 0.15 <= at && at <= Math.max(pr.a[i], pr.b[i]) + 0.15)
          .map(pr => pr.at)
          .sort((p, q) => p - q);
        if (ends.length < 2) return;
        const lo = ends[0];
        const hi = ends[ends.length - 1];
        const a: Vec2 = constAxis === 'x' ? [at, lo] : [lo, at];
        const b: Vec2 = constAxis === 'x' ? [at, hi] : [hi, at];
        pushBeam(s.id, a, b, beamW, presize.transferBeamD, 'concrete', 'transfer', zUnder,
          `${grid.label(constAxis, at)} (carries the plate above)`);
      };
      const above = polygonBounds(outlineOf(transferStorey!));
      const plate = rectIntersection(polygonBounds(outline), above) ?? above;
      for (const x of grid.mainX) {
        if (x < plate.x - 0.01 || x > plate.x + plate.w + 0.01) continue;
        secondary('x', x);
      }
      for (const y of grid.mainY) {
        if (y < plate.y - 0.01 || y > plate.y + plate.h + 0.01) continue;
        secondary('y', y);
      }
      // A transfer level carries whatever bears on it, and on a bearing-wall system above a podium that is not
      // the grid but the WALL LINES of the storey above (including internal spine walls taken up from
      // `loadBearingHint`). Each distinct line gets a beam that ends on the primaries it crosses.
      const carriedLines: { constAxis: 'x' | 'y'; at: number }[] = [];
      for (const w of walls) {
        if (w.storey !== transferStorey) continue;
        if (w.role !== 'bearing' && w.role !== 'core' && w.role !== 'shear') continue;
        if (dist(w.start, w.end) < 1.0) continue;
        const dx = Math.abs(w.end[0] - w.start[0]);
        const dy = Math.abs(w.end[1] - w.start[1]);
        const constAxis: 'x' | 'y' | null = dy < 1e-3 ? 'y' : dx < 1e-3 ? 'x' : null;
        if (constAxis === null) continue;
        const at = round(constAxis === 'x' ? w.start[0] : w.start[1], 3);
        if (carriedLines.some(l => l.constAxis === constAxis && Math.abs(l.at - at) < 0.3)) continue;
        carriedLines.push({ constAxis, at });
      }
      carriedLines.sort((a, b) => (a.constAxis === b.constAxis ? a.at - b.at : a.constAxis < b.constAxis ? -1 : 1));
      for (const l of carriedLines) secondary(l.constAxis, l.at);
      apps.push({
        patternId: 'STR-04',
        storey: transferStorey,
        elementIds: beams.filter(x => x.role === 'transfer').map(x => x.id),
        params: {
          podiumStoreys,
          transferSlabThickness: presize.transferSlabT,
          transferBeam: `${beamW}x${presize.transferBeamD}`,
          transferZoneDepth: presize.transferZoneDepth,
          parkingModuleAlong: presize.gridProposal.parkingModule.along,
          podiumGridLines: grid.parkX.length * grid.parkY.length,
          primaryTransferBeams: primaries.length,
        },
        note: `Podium storeys 0..${podiumStoreys - 1} on the parking module; dwellings above on the party-wall grid; transfer level at ${transferStorey}. Primary beams run column to column; secondary beams under the residential lines end on the primaries.`,
      });
      continue;
    }

    if (mode === 'frame-rc') {
      // Flat slab: rim/edge beams at the slab edges only — the perimeter, and the courtyard
      // edge, which is just as much a slab edge
      const ring = offsetPolygon(outline, exteriorWallT / 2);
      for (let i = 0; i < ring.length; i++) {
        pushBeam(s.id, ring[i], ring[(i + 1) % ring.length], sizes.beamW, sizes.beamD, 'concrete', 'rim', zTop - sizes.beamD, 'perimeter');
      }
      if (courtyardOn(s.id) && courtyardRect) {
        const cy = offsetPolygon(rectToPolygon(courtyardRect), -exteriorWallT / 2);
        for (let i = 0; i < cy.length; i++) {
          pushBeam(s.id, cy[i], cy[(i + 1) % cy.length], sizes.beamW, sizes.beamD, 'concrete', 'rim', zTop - sizes.beamD, 'courtyard');
        }
      }
      edgeBeamsUnderPlateAbove(s, zTop, 'concrete');
    } else if (mode === 'frame-steel') {
      const cols = columnsByStorey.get(s.id) ?? [];
      const at = new Set(cols.map(c => `${round(c.position[0], 2)}:${round(c.position[1], 2)}`));
      const parking = isPodiumStorey(s) && !carriesGridAbove(s);
      const xs = parking ? grid.parkX : grid.mainX;
      const ys = parking ? grid.parkY : grid.mainY;
      for (const x of xs) {
        for (let j = 0; j + 1 < ys.length; j++) {
          if (!at.has(`${round(x, 2)}:${round(ys[j], 2)}`) || !at.has(`${round(x, 2)}:${round(ys[j + 1], 2)}`)) continue;
          pushBeam(s.id, [x, ys[j]], [x, ys[j + 1]], sizes.beamW, sizes.beamD, 'steel', 'primary', zTop - sizes.beamD, `${grid.label('x', x)}`);
        }
      }
      for (const y of ys) {
        for (let i = 0; i + 1 < xs.length; i++) {
          if (!at.has(`${round(xs[i], 2)}:${round(y, 2)}`) || !at.has(`${round(xs[i + 1], 2)}:${round(y, 2)}`)) continue;
          pushBeam(s.id, [xs[i], y], [xs[i + 1], y], sizes.beamW, sizes.beamD, 'steel', 'primary', zTop - sizes.beamD, `${grid.label('y', y)}`);
        }
      }
      if (detail === 'high') {
        // Secondary beams at 3 m spacing spanning the short direction of each bay
        const spanX = longAxis === 'x';
        const primary = spanX ? xs : ys;
        const cross = spanX ? ys : xs;
        for (let i = 0; i + 1 < primary.length; i++) {
          const gap = primary[i + 1] - primary[i];
          const n = Math.max(1, Math.round(gap / 3.0));
          for (let k = 1; k < n; k++) {
            const at2 = primary[i] + (gap * k) / n;
            const a: Vec2 = spanX ? [at2, cross[0]] : [cross[0], at2];
            const b2: Vec2 = spanX ? [at2, cross[cross.length - 1]] : [cross[cross.length - 1], at2];
            pushBeam(s.id, a, b2, sizes.beamW * 0.8, sizes.beamD * 0.8, 'steel', 'secondary', zTop - sizes.beamD * 0.8, 'secondary');
          }
        }
      }
      edgeBeamsUnderPlateAbove(s, zTop, 'steel');
    } else {
      // Bearing walls: rim beam on top of each bearing wall, plus headers over wide openings.
      // Platform frame gets an LVL rim board; CLT gets a glulam edge beam; masonry gets a
      // reinforced concrete ring beam at each floor level.
      const platformFrame = system === 'light-wood-frame' || system === 'wood-over-podium';
      const rimW = platformFrame ? TIMBER_RIM.w : sizes.beamW;
      const rimD = platformFrame ? TIMBER_RIM.d : sizes.beamD;
      const rimMaterial: FrameMaterial = system === 'masonry-bearing' ? 'concrete' : 'timber';
      const onStorey = (wallsByStorey.get(s.id) ?? []).filter(w => bearingWallIds.has(w.id));
      for (const w of onStorey) {
        if (detail === 'low' && w.type === 'corridor') continue;
        pushBeam(s.id, w.start, w.end, Math.min(rimW, w.thickness), rimD, rimMaterial, 'rim', zTop - rimD, w.type);
      }
      if (detail !== 'low') {
        for (const d of arch?.doors ?? []) {
          if (d.storey !== s.id || !bearingWallIds.has(d.wallId) || d.width <= LINTEL.triggerWidth) continue;
          emitLintel(d.wallId, d.along, d.width, d.height);
        }
        for (const wd of arch?.windows ?? []) {
          if (wd.storey !== s.id || !bearingWallIds.has(wd.wallId) || wd.width <= LINTEL.triggerWidth) continue;
          emitLintel(wd.wallId, wd.along, wd.width, wd.sill + wd.height);
        }
      }
    }

    function emitLintel(wallId: string, along: number, width: number, headZ: number): void {
      const host = archWallById.get(wallId);
      if (!host) return;
      const len = dist(host.start, host.end);
      if (len < 0.5) return;
      const ux = (host.end[0] - host.start[0]) / len;
      const uy = (host.end[1] - host.start[1]) / len;
      const a0 = Math.max(0, along - width / 2 - LINTEL.bearing);
      const a1 = Math.min(len, along + width / 2 + LINTEL.bearing);
      if (a1 - a0 < 0.4) return;
      const a: Vec2 = [host.start[0] + ux * a0, host.start[1] + uy * a0];
      const b: Vec2 = [host.start[0] + ux * a1, host.start[1] + uy * a1];
      pushBeam(s.id, a, b, host.thickness, LINTEL.depth, system === 'masonry-bearing' ? 'concrete' : 'timber', 'lintel', headZ + LINTEL.clearance, `over opening in ${wallId}`);
    }
  }

  // ---------------------------------------------------------------- foundations
  const foundations: FoundationElement[] = [];
  const fndId = fndStorey?.id ?? FOUNDATION_STOREY;
  const fndDepth = fndStorey?.height ?? 1.2;
  let pileCount = 0;

  const emitFooting = (
    position: Vec2,
    width: number,
    depthY: number,
    height: number,
    footingType: 'STRIP_FOOTING' | 'PAD_FOOTING' | 'PILE_CAP',
    kind: FoundationElement['type'],
    name: string,
    length?: number,
  ): FoundationElement => {
    const fe: FoundationElement = {
      id: ids.next(fndId, footingType === 'PILE_CAP' ? 'PCAP' : footingType === 'STRIP_FOOTING' ? 'STRIP' : 'PAD'),
      type: kind,
      position: [round(position[0], 4), round(position[1], 4)],
      width: round(width, 4),
      depth: round(depthY, 4),
      height: round(height, 4),
      length: length === undefined ? undefined : round(length, 4),
    };
    foundations.push(fe);
    elements.push({
      id: fe.id,
      discipline: 'structure',
      ifcType: 'IfcFooting',
      predefinedType: footingType,
      name,
      objectType: footingType,
      storey: fndId,
      // Footing position is the TOP centre; underside sits on the FND datum (z = 0)
      geometry: { kind: 'footing', position: [fe.position![0], fe.position![1], round(height, 4)], width: round(width, 4), depth: round(depthY, 4), height: round(height, 4), footingType },
      psets: [
        pset('Pset_FootingCommon', [
          { name: 'LoadBearing', value: true },
          { name: 'IsExternal', value: true },
          { name: 'Reference', value: footingType },
        ]),
        formaStructure(system, MATERIALS.reinforcedConcrete.name, `${Math.round(width * 1000)}x${Math.round(depthY * 1000)}x${Math.round(height * 1000)} RC`, round(width * depthY, 3), '-', {
          FoundingLevelZ: 0,
          TopOfFootingZ: round(height, 4),
          BearingPressureKpa: 150,
        }),
      ],
      quantities: [qset('Qto_FootingBaseQuantities', [
        { name: 'GrossVolume', value: round(width * depthY * height, 4), kind: 'IfcQuantityVolume' },
      ])],
      material: MATERIALS.reinforcedConcrete,
      color: COLORS.foundation,
      patterns: ['STR-06'],
      tags: ['structure', 'foundation', footingType],
    });
    return fe;
  };

  const emitPile = (position: Vec2, diameter: number, length: number, capRef: string): void => {
    const id = ids.next(fndId, 'PILE');
    pileCount++;
    foundations.push({ id, type: 'pile', position: [round(position[0], 4), round(position[1], 4)], width: diameter, depth: diameter, height: length, length });
    elements.push({
      id,
      discipline: 'structure',
      ifcType: 'IfcPile',
      predefinedType: 'BORED',
      name: `Bored pile ${capRef}`,
      objectType: `Bored pile D${Math.round(diameter * 1000)}`,
      storey: fndId,
      // Pile top hangs at the pile-cap underside (z = 0) and extends down by `length`
      geometry: { kind: 'pile', position: [round(position[0], 4), round(position[1], 4), 0], diameter, length },
      psets: [
        pset('Pset_PileCommon', [
          { name: 'LoadBearing', value: true },
          { name: 'IsExternal', value: true },
          { name: 'Reference', value: capRef },
        ]),
        formaStructure(system, MATERIALS.reinforcedConcrete.name, `Bored pile D${Math.round(diameter * 1000)} x ${length} m`, round(Math.PI * diameter * length, 2), capRef, {
          PileLength: length,
          PileDiameter: diameter,
          ShaftFrictionKpa: 60,
        }),
      ],
      quantities: [qset('Qto_PileBaseQuantities', [
        { name: 'Length', value: length, kind: 'IfcQuantityLength' },
        { name: 'GrossVolume', value: round((Math.PI * diameter * diameter) / 4 * length, 4), kind: 'IfcQuantityVolume' },
      ])],
      material: MATERIALS.reinforcedConcrete,
      color: COLORS.pile,
      patterns: ['STR-06'],
      tags: ['structure', 'foundation', 'pile'],
    });
  };

  // STR-C2: the things to found are the LOWEST supports on each vertical line, from the load-path walk — not
  // "the columns and walls of the lowest storey". A column that only exists on L02, or a core that starts in a
  // basement the lowest plate does not reach, used to get no footing at all.
  const bases = loadPathBases({
    storeysAscending: framedStoreys,
    columns,
    walls,
    beams,
    rules,
  });
  const baseColumnIds = new Set(bases.filter(b => b.kind === 'column').map(b => b.id));
  const baseWallIds = new Set(bases.filter(b => b.kind === 'wall').map(b => b.id));
  const columnById = new Map<string, StructColumn>(columns.map(c => [c.id, c]));
  const lowestColumns = [...baseColumnIds].map(id => columnById.get(id)).filter((c): c is StructColumn => c !== undefined);
  const lowestWalls = walls.filter(w => baseWallIds.has(w.id) && (w.role === 'bearing' || w.role === 'core' || w.role === 'shear'));
  /** A line of wall to found: from a structural wall, or from the outline when there is none */
  interface BearingLine { start: Vec2; end: Vec2; ref: string }
  const stripLines: BearingLine[] = [];

  const perimeterLines = (): BearingLine[] => {
    const ring = offsetPolygon(outlineOf(lowestStorey.id), exteriorWallT / 2);
    return ring.map((p, i) => ({ start: p, end: ring[(i + 1) % ring.length], ref: 'outline perimeter' }))
      .filter(l => dist(l.start, l.end) > 0.5);
  };

  const emitStrips = (lines: BearingLine[]): void => {
    for (const w of lines) {
      const len = dist(w.start, w.end);
      if (len < 0.5) continue;
      const dx = Math.abs(w.end[0] - w.start[0]);
      const dy = Math.abs(w.end[1] - w.start[1]);
      const mid: Vec2 = [(w.start[0] + w.end[0]) / 2, (w.start[1] + w.end[1]) / 2];
      const width = FOUNDATION_RULES.stripWidth;
      if (dy < 1e-3) {
        emitFooting(mid, len, width, FOUNDATION_RULES.stripHeight, 'STRIP_FOOTING', 'strip', `Strip footing under ${w.ref}`, len);
        stripLines.push(w);
      } else if (dx < 1e-3) {
        emitFooting(mid, width, len, FOUNDATION_RULES.stripHeight, 'STRIP_FOOTING', 'strip', `Strip footing under ${w.ref}`, len);
        stripLines.push(w);
      } else {
        // Skewed wall: fall back to pads at the two ends
        emitFooting(w.start, 0.9, 0.9, FOUNDATION_RULES.padHeight, 'PAD_FOOTING', 'pad', `Pad footing at end of ${w.ref}`);
        emitFooting(w.end, 0.9, 0.9, FOUNDATION_RULES.padHeight, 'PAD_FOOTING', 'pad', `Pad footing at end of ${w.ref}`);
      }
    }
  };

  // STR-C2: EVERY wall base gets a strip, whatever the headline foundation type. v1 founded core walls only on
  // a pad-footing scheme, so a bearing wall at grade (a podium perimeter, a senior-living spine wall) carried
  // load into nothing.
  if (foundation !== 'raft' && foundation !== 'piles') {
    let lines: BearingLine[] = lowestWalls.map(w => ({ start: w.start, end: w.end, ref: w.archWallId ?? w.id }));
    if (lines.length === 0 && foundation === 'strip-footing') {
      warn('no bearing walls on the lowest storey — strip footings fall back to the floor-plate perimeter.');
      lines = perimeterLines();
    }
    emitStrips(lines);
  }

  if (foundation === 'pad-footing') {
    const side = round(padSide(storeyCount), 3);
    for (const c of lowestColumns) {
      emitFooting(c.position, side, side, FOUNDATION_RULES.padHeight, 'PAD_FOOTING', 'pad', `Pad footing under column ${c.gridRef}`);
    }
  }

  if (foundation === 'piles') {
    const capSize = FOUNDATION_RULES.pileCapSize;
    const pileLen = storeyCount > 25 ? FOUNDATION_RULES.pileLengthTall : FOUNDATION_RULES.pileLength;
    const perCap = storeyCount > 15 ? 4 : 2;
    const capPoints: { p: Vec2; ref: string }[] = lowestColumns.map(c => ({ p: c.position, ref: c.gridRef }));
    // STR-C2: a wall base needs a cap too — a core wall on a basement level the core rect does not describe,
    // or a bearing wall at grade, otherwise its load reaches the ground through nothing.
    for (const w of lowestWalls) {
      const ref = w.archWallId ?? w.id;
      capPoints.push({ p: w.start, ref: `${ref} start` }, { p: w.end, ref: `${ref} end` });
    }
    for (const core of arch?.cores ?? []) {
      const r = core.rect;
      capPoints.push({ p: [r.x + 0.6, r.y + 0.6], ref: `${core.id} SW` });
      capPoints.push({ p: [r.x + r.w - 0.6, r.y + 0.6], ref: `${core.id} SE` });
      capPoints.push({ p: [r.x + 0.6, r.y + r.h - 0.6], ref: `${core.id} NW` });
      capPoints.push({ p: [r.x + r.w - 0.6, r.y + r.h - 0.6], ref: `${core.id} NE` });
    }
    const seenCaps = new Set<string>();
    const placed: Vec2[] = [];
    for (const { p, ref } of capPoints) {
      const key = `${round(p[0], 1)}:${round(p[1], 1)}`;
      if (seenCaps.has(key)) continue;
      seenCaps.add(key);
      // Two caps closer than one cap size are one cap: a core corner and the wall end that meets it.
      if (placed.some(q => Math.abs(q[0] - p[0]) < capSize && Math.abs(q[1] - p[1]) < capSize)) continue;
      placed.push(p);
      emitFooting(p, capSize, capSize, FOUNDATION_RULES.pileCapHeight, 'PILE_CAP', 'pile-cap', `Pile cap ${ref}`);
      const o = 0.45;
      const offs: Vec2[] = perCap === 4
        ? [[-o, -o], [o, -o], [-o, o], [o, o]]
        : longAxis === 'x' ? [[-o, 0], [o, 0]] : [[0, -o], [0, o]];
      for (const d of offs) emitPile([p[0] + d[0], p[1] + d[1]], FOUNDATION_RULES.pileDiameter, pileLen, ref);
    }
  }

  if (foundation === 'raft') {
    const outline = outlineOf(lowestStorey.id);
    const b = polygonBounds(outline);
    const id = ids.next(fndId, 'RAFT');
    foundations.push({ id, type: 'raft', rect: b, height: FOUNDATION_RULES.raftT });
    slabs.push({ id, storey: fndId, outline, thickness: FOUNDATION_RULES.raftT, type: 'ground', openings: [] });
    const profile = relativeTo(outline, [b.x, b.y]).map(p => [round(p[0], 4), round(p[1], 4)] as Vec2);
    elements.push({
      id,
      discipline: 'structure',
      ifcType: 'IfcSlab',
      predefinedType: 'BASESLAB',
      name: 'Raft foundation',
      objectType: 'Raft',
      storey: fndId,
      geometry: { kind: 'slab', position: [round(b.x, 4), round(b.y, 4), 0], profile, thickness: FOUNDATION_RULES.raftT },
      psets: [
        pset('Pset_SlabCommon', [
          { name: 'LoadBearing', value: true },
          { name: 'IsExternal', value: true },
          { name: 'Reference', value: `${Math.round(FOUNDATION_RULES.raftT * 1000)} mm raft` },
        ]),
        formaStructure(system, MATERIALS.reinforcedConcrete.name, `${Math.round(FOUNDATION_RULES.raftT * 1000)} mm RC raft`, round(polygonArea(outline), 2), '-', {
          FoundingLevelZ: 0,
          BearingPressureKpa: 150,
        }),
      ],
      quantities: [qset('Qto_SlabBaseQuantities', [
        { name: 'Depth', value: FOUNDATION_RULES.raftT, kind: 'IfcQuantityLength' },
        { name: 'GrossArea', value: round(polygonArea(outline), 3), kind: 'IfcQuantityArea' },
        { name: 'GrossVolume', value: round(polygonArea(outline) * FOUNDATION_RULES.raftT, 3), kind: 'IfcQuantityVolume' },
      ])],
      material: MATERIALS.reinforcedConcrete,
      color: COLORS.foundation,
      patterns: ['STR-06'],
      tags: ['structure', 'foundation', 'raft'],
    });
  }

  if (foundation === 'slab-on-grade') {
    const b = polygonBounds(outlineOf(lowestStorey.id));
    foundations.push({ id: ids.next(fndId, 'SOG'), type: 'slab-on-grade', rect: b, height: FOUNDATION_RULES.slabOnGradeEdge });
    apps.push({
      patternId: 'STR-06',
      storey: fndId,
      params: { type: 'slab-on-grade', thickenedEdgeDepth: FOUNDATION_RULES.slabOnGradeEdge, groundSlabThickness: groundSlabT },
      note: 'Thickened-edge slab on grade; no separate footing elements.',
    });
  }

  // Last-resort safety net: a building must always be founded on something
  if (foundations.length === 0) {
    warn(`foundation type '${foundation}' produced nothing to found on (no bearing walls, no columns) — falling back to a perimeter strip footing.`);
    emitStrips(perimeterLines());
  }

  // Stem walls from the strip footings up to the ground slab (STR-06)
  const stemHeight = round(fndDepth - groundSlabT - FOUNDATION_RULES.stripHeight, 4);
  if (foundation === 'strip-footing' && stripLines.length > 0 && stemHeight > 0.1) {
    for (const w of stripLines) {
      const id = ids.next(fndId, 'STEM');
      walls.push({
        id, storey: fndId, start: w.start, end: w.end,
        thickness: FOUNDATION_RULES.stemWallT, height: stemHeight, role: 'foundation', material: 'concrete',
      });
      elements.push({
        id,
        discipline: 'structure',
        ifcType: 'IfcWall',
        predefinedType: 'SOLIDWALL',
        name: `Foundation stem wall under ${w.ref}`,
        objectType: 'StemWall',
        storey: fndId,
        geometry: {
          kind: 'wall',
          start: [w.start[0], w.start[1], FOUNDATION_RULES.stripHeight],
          end: [w.end[0], w.end[1], FOUNDATION_RULES.stripHeight],
          thickness: FOUNDATION_RULES.stemWallT,
          height: stemHeight,
        },
        psets: [
          pset('Pset_WallCommon', [
            { name: 'LoadBearing', value: true },
            { name: 'IsExternal', value: true },
            { name: 'ExtendToStructure', value: true },
          ]),
          formaStructure(system, MATERIALS.reinforcedConcrete.name, `${Math.round(FOUNDATION_RULES.stemWallT * 1000)} mm RC stem wall`, round(dist(w.start, w.end) * stemHeight, 2), '-', {
            BaseZ: FOUNDATION_RULES.stripHeight,
            TopZ: round(FOUNDATION_RULES.stripHeight + stemHeight, 4),
          }),
        ],
        material: MATERIALS.reinforcedConcrete,
        color: COLORS.foundation,
        patterns: ['STR-06'],
        tags: ['structure', 'wall', 'stem'],
      });
    }
  }

  // ---------------------------------------------------------------- constructability (STR-C1 .. STR-C5)
  // Architecture emits the balcony slabs; structure still has to verify them, so they are handed to the checker
  // as `StructSlab`s of type 'balcony' (never added to `slabs`, which stays one structural slab per storey).
  const balconies: BalconyDef[] = (arch?.floors ?? []).flatMap(f => f.balconies ?? []);
  const balconySlabs: StructSlab[] = [];
  if (balconies.length > 0) {
    const archSlabAt = new Map<string, number>();
    for (const e of arch?.elements ?? []) {
      if (e.geometry.kind !== 'slab' || e.unitId === undefined) continue;
      archSlabAt.set(`${e.storey}:${round(e.geometry.position[0], 2)}:${round(e.geometry.position[1], 2)}`, e.geometry.thickness);
    }
    for (const b of balconies) {
      const t = archSlabAt.get(`${b.storey}:${round(b.rect.x, 2)}:${round(b.rect.y, 2)}`);
      if (t === undefined || t <= 0) continue;
      balconySlabs.push({ id: b.id, storey: b.storey, outline: rectToPolygon(b.rect), thickness: t, type: 'balcony', openings: [] });
    }
  }
  const loadPath = checkLoadPath({
    storeysAscending: framedStoreys,
    columns,
    walls,
    beams,
    slabs: [...slabs, ...balconySlabs],
    foundations,
    balconies,
    presize,
    rules,
    ledger,
  });
  if (loadPath.nodes.length > 0) {
    apps.push({
      patternId: 'STR-C1',
      params: {
        supports: loadPath.derived.supports,
        carried: loadPath.derived.supportsCarried,
        onTransferBeams: loadPath.derived.supportsOnTransfer,
        unsupported: loadPath.derived.unsupportedSupports,
        continuityTolerance: rules.num('STR-C1.continuityTolerance', 0.15),
      },
      note: 'Every column and bearing wall is carried by a column, a wall or a fully supported transfer beam below.',
    });
    apps.push({
      patternId: 'STR-C2',
      storey: fndStorey?.id ?? FOUNDATION_STOREY,
      params: { bases: loadPath.derived.bases, unfounded: loadPath.derived.unfoundedBases, foundationType: foundation },
      note: 'Footings are generated from the load-path bases, not from the lowest storey\'s columns.',
    });
    apps.push({
      patternId: 'STR-C3',
      params: { coreWallLines: walls.filter(w => w.role === 'core' || w.role === 'shear').length, discontinuous: loadPath.derived.discontinuousCoreLines, coreWallThickness: presize.coreWallT },
    });
    apps.push({
      patternId: 'STR-C4',
      params: {
        edgeSamples: loadPath.derived.slabEdgeSamples,
        unsupportedEdges: loadPath.derived.unsupportedSlabEdges,
        maxCantilever: Math.min(rules.num('STR-C4.maxCantilever', 2.0), 10 * sizes.slabT),
        edgeSampleStep: rules.num('STR-C4.edgeSampleStep', 1.0),
      },
    });
    if (balconies.length > 0) {
      apps.push({
        patternId: 'STR-C5',
        params: {
          balconies: balconies.length,
          verified: loadPath.derived.balconiesVerified,
          cantileverFails: loadPath.derived.balconyCantileverFails,
          thicknessFails: loadPath.derived.balconyThicknessFails,
          minBalconyThickness: rules.num('STR-C5.minBalconyThickness', 0.18),
        },
        note: 'Architecture owns the balcony slab geometry; structure verifies the cantilever and the thickness.',
      });
    }
  }

  // ---------------------------------------------------------------- kernel keep-outs (before any MEP runs)
  if (ctx.kernel) {
    const kernel = ctx.kernel;
    const boxesByStorey = new Map<string, { beams: Box3[]; columns: Box3[]; drops: Box3[]; shafts: Box3[] }>();
    const bucket = (storeyId: string): { beams: Box3[]; columns: Box3[]; drops: Box3[]; shafts: Box3[] } => {
      let b = boxesByStorey.get(storeyId);
      if (!b) { b = { beams: [], columns: [], drops: [], shafts: [] }; boxesByStorey.set(storeyId, b); }
      return b;
    };
    for (const b of beams) {
      const x0 = Math.min(b.start[0], b.end[0]);
      const y0 = Math.min(b.start[1], b.end[1]);
      const dx = Math.abs(b.end[0] - b.start[0]);
      const dy = Math.abs(b.end[1] - b.start[1]);
      bucket(b.storey).beams.push({
        x: round(x0 - (dy > dx ? b.width / 2 : 0), 4), y: round(y0 - (dx >= dy ? b.width / 2 : 0), 4), z: round(b.z, 4),
        w: round(dx + (dy > dx ? b.width : 0), 4), d: round(dy + (dx >= dy ? b.width : 0), 4), h: round(b.depth, 4),
      });
    }
    for (const c of columns) {
      bucket(c.storey).columns.push({
        x: round(c.position[0] - c.width / 2, 4), y: round(c.position[1] - c.depth / 2, 4), z: 0,
        w: c.width, d: c.depth, h: c.height,
      });
      // Flat plate / flat slab: the local thickening at the column head is the governing obstruction under the
      // soffit even though it is not modelled as its own element (parking profile, band 1).
      if (!isFrameSystem(system)) continue;
      const dropDepth = rules.num('STR-04.dropPanelDepth', 0.1);
      const dropSide = rules.num('STR-04.dropPanelSide', 2.4);
      bucket(c.storey).drops.push({
        x: round(c.position[0] - dropSide / 2, 4), y: round(c.position[1] - dropSide / 2, 4),
        z: round(c.height - dropDepth, 4), w: dropSide, d: dropSide, h: dropDepth,
      });
    }
    for (const e of arch?.elevators ?? []) {
      for (const sid of e.storeys) {
        const st = byId.get(sid);
        if (!st) continue;
        bucket(sid).shafts.push({ x: e.rect.x, y: e.rect.y, z: 0, w: e.rect.w, d: e.rect.h, h: round(st.height, 4) });
      }
    }
    for (const [storeyId, b] of [...boxesByStorey.entries()].sort((p, q) => (p[0] < q[0] ? -1 : 1))) {
      if (b.beams.length > 0) kernel.keepOut({ owner: 'structure', kind: 'beam', storey: storeyId, boxes: b.beams, bans: MEP_KINDS, note: 'No designed openings: nothing may pass through a beam (touching the soffit is legal).' });
      if (b.columns.length > 0) kernel.keepOut({ owner: 'structure', kind: 'column', storey: storeyId, boxes: b.columns, bans: MEP_KINDS, note: 'No designed openings in columns.' });
      if (b.drops.length > 0) kernel.keepOut({ owner: 'structure', kind: 'drop-panel', storey: storeyId, boxes: b.drops, bans: MEP_KINDS, note: 'Flat-plate drop panel at the column head.' });
      if (b.shafts.length > 0) kernel.keepOut({ owner: 'structure', kind: 'shaft-void', storey: storeyId, boxes: b.shafts, bans: MEP_KINDS, note: 'IBC 2021 §3005.3 / ASME A17.1 §2.8: a hoistway contains no piping or ducting that does not serve it.' });
    }
  }

  // ---------------------------------------------------------------- pattern trace
  apps.push({
    patternId: 'STR-01',
    params: {
      system,
      storeys: storeyCount,
      access: ctx.typology.access,
      typologyDefault: ctx.typology.structure,
      podiumStoreys,
      foundation,
    },
    note: `structuralSystemFor(${ctx.typology.id}, ${storeyCount}) = ${system}; foundationFor(${system}, ${storeyCount}, ${parkingType}) = ${foundation}.`,
  });
  apps.push({
    patternId: 'STR-02',
    storey: typicalStorey.id,
    elementIds: gridLines.map(g => g.id),
    params: {
      linesX: grid.mainX.length,
      linesY: grid.mainY.length,
      avgSpacingX: grid.avgSpacingX,
      avgSpacingY: grid.avgSpacingY,
      minSpacing: presize.gridProposal.bay.min,
      maxSpacing: presize.gridProposal.bay.max,
      targetSpacing: presize.gridProposal.bay.target,
      longAxis,
      source: grid.source,
      sourceWalls: (wallsByStorey.get(typicalStorey.id) ?? []).filter(w => w.type === 'party').length,
    },
    note: grid.source === 'party-lines'
      ? 'Transverse grid on exactly the party lines the placer published (ArchModel.partyLines).'
      : 'Transverse grid derived once from the typical storey\'s wall centrelines; the placer has not published party lines yet.',
  });
  if (columns.length > 0) {
    apps.push({
      patternId: 'STR-03',
      params: {
        snapTolerance: presize.gridProposal.snapTolerance,
        gridSource: grid.source,
        columnsOnWallLines: snapCount,
        intersectionsDroppedInCores: droppedInCores,
        columns: columns.length,
      },
      note: 'One grid for the whole building: the transverse lines are the wall centrelines, so no column is snapped per storey.',
    });
    apps.push({
      patternId: 'STR-10',
      params: {
        maxTributaryAreaM2: round(maxTributary, 2),
        minSide: Math.min(...columns.map(c => c.width)),
        maxSide: Math.max(...columns.map(c => c.width)),
        distinctSizes: new Set(columns.map(c => c.width)).size,
        deadKpa: loads.deadKpa,
        liveKpa: loads.liveKpa,
      },
    });
  }
  const coreWalls = walls.filter(w => w.role === 'core');
  const shearWalls = walls.filter(w => w.role === 'shear');
  if (coreWalls.length > 0 || shearWalls.length > 0) {
    apps.push({
      patternId: 'STR-05',
      elementIds: [...coreWalls, ...shearWalls].map(w => w.archWallId ?? w.id),
      params: {
        coreWalls: coreWalls.length,
        flankingShearWalls: shearWalls.length,
        designThickness: sizes.shearWallT,
        cores: (arch?.cores ?? []).length,
        recruitAbove: 20,
      },
      note: 'Core walls are architecture elements flagged LoadBearing / SHEAR by the writer, not duplicated here.',
    });
  }
  if (foundations.length > 0 && foundation !== 'slab-on-grade') {
    apps.push({
      patternId: 'STR-06',
      storey: fndId,
      params: {
        type: foundation,
        count: foundations.length,
        piles: pileCount,
        foundingLevelM: round(fndStorey?.elevation ?? 0, 3),
        foundationDepth: fndDepth,
        footingUndersideZ: 0,
      },
      note: 'Footing convention: FND storey-local z = 0 is the founding level; every footing/cap underside sits on it, so position.z = height.',
    });
  }
  const totalOpenings = slabs.reduce((a, s) => a + s.openings.length, 0);
  if (totalOpenings > 0) {
    apps.push({
      patternId: 'STR-07',
      params: { openings: totalOpenings, cores: (arch?.cores ?? []).length, shafts: (arch?.shafts ?? []).length, lowestSlabCutThrough: basements.length > 0 },
    });
  }
  const lintels = beams.filter(b => b.role === 'lintel');
  if (lintels.length > 0) {
    apps.push({
      patternId: 'STR-08',
      elementIds: lintels.map(b => b.id),
      params: { lintels: lintels.length, triggerWidth: LINTEL.triggerWidth, bearingEachEnd: LINTEL.bearing, depth: LINTEL.depth },
    });
  }
  apps.push({
    patternId: 'STR-09',
    params: {
      spanX: grid.avgSpacingX,
      spanY: grid.avgSpacingY,
      slabThickness: sizes.slabT,
      spanDepthRatio: round(Math.max(grid.avgSpacingX, grid.avgSpacingY) / Math.max(0.05, sizes.slabT), 1),
      beamDepth: sizes.beamD,
    },
  });
  apps.push({
    patternId: 'XD-03',
    storey: typicalStorey.id,
    params: {
      gridOnPartyWalls: true,
      handshake: grid.source,
      maxSpan: presize.gridProposal.bay.max,
      parkingModule: presize.gridProposal.parkingModule.along,
      transferStorey: transferStorey ?? 'none',
    },
  });

  // ---------------------------------------------------------------- derived
  const concreteSlabVol = slabs
    .filter(s => s.type === 'ground' || s.type === 'podium-transfer' || slabMaterialOf(s.storey) === 'concrete')
    .reduce((a, s) => a + Math.max(0, polygonArea(s.outline) - s.openings.reduce((b, r) => b + rectArea(r), 0)) * s.thickness, 0);
  const netSlabArea = (s: StructSlab): number =>
    Math.max(0, polygonArea(s.outline) - s.openings.reduce((b, r) => b + rectArea(r), 0));
  const timberSlabArea = slabs
    .filter(s => s.type !== 'ground' && s.type !== 'podium-transfer' && slabMaterialOf(s.storey) === 'timber')
    .reduce((a, s) => a + netSlabArea(s), 0);
  const columnVol = columns.filter(c => c.material === 'concrete').reduce((a, c) => a + c.width * c.depth * c.height, 0);
  const beamVol = beams.filter(b => b.material === 'concrete').reduce((a, b) => a + b.width * b.depth * dist(b.start, b.end), 0);
  const timberBeamVol = beams.filter(b => b.material === 'timber').reduce((a, b) => a + b.width * b.depth * dist(b.start, b.end), 0);
  const wallVol = (ws: StructWall[]): number => ws.reduce((a, w) => a + dist(w.start, w.end) * w.thickness * w.height, 0);
  const concreteWallVol = wallVol(walls.filter(w => w.material === 'concrete'));
  const coreShearWallVol = wallVol(walls.filter(w => w.material === 'concrete' && (w.role === 'core' || w.role === 'shear')));
  const foundationVol = foundations.reduce((a, f) => {
    if (f.type === 'raft') return a + (f.rect ? rectArea(f.rect) : 0) * f.height;
    if (f.type === 'slab-on-grade') return a;
    if (f.type === 'pile') return a + (Math.PI * (f.width ?? 0.6) ** 2) / 4 * f.height;
    return a + (f.width ?? 0) * (f.depth ?? 0) * f.height;
  }, 0);
  const concreteVolumeM3 = concreteSlabVol + columnVol + beamVol + concreteWallVol + foundationVol;

  // Floor areas exclude the courtyard void, so the carbon intensity is per real m² of floor
  const grossFloorArea = aboveGrade.reduce((a, s) => a + netFloorArea(s.id), 0);
  const framedArea = framedStoreys.reduce((a, s) => a + netFloorArea(s.id), 0);
  const slabArea = slabs.reduce((a, s) => a + netSlabArea(s), 0);
  const steelTonnes = system === 'steel-frame' ? (STEEL_KG_PER_M2 * framedArea) / 1000 : 0;
  const timberVolumeM3 = isBearingWallSystem(system) || isHybridPodiumSystem(system)
    ? timberIntensity(system) * timberSlabArea + timberBeamVol
    : timberBeamVol;
  const embodiedCarbonKgCO2e =
    concreteVolumeM3 * RC_KGCO2E_PER_M3 +
    steelTonnes * 1000 * CARBON.steelKgCO2ePerKg +
    timberVolumeM3 * CARBON.timberKgCO2ePerM3;
  const embodiedCarbonPerM2 = grossFloorArea > 0 ? embodiedCarbonKgCO2e / grossFloorArea : 0;
  /** A4–A5 (transport to site + construction) allowance on top of the A1–A3 product stage */
  const A4A5_FACTOR = 1.12;
  // Mean floor area carried by one column, averaged over the storeys that have columns
  let tribSum = 0;
  let tribStoreys = 0;
  for (const [sid, list] of columnsByStorey) {
    if (list.length === 0) continue;
    tribSum += polygonArea(outlineOf(sid)) / list.length;
    tribStoreys += 1;
  }
  const avgTributary = tribStoreys > 0 ? tribSum / tribStoreys : 0;

  // The plenum the MEP disciplines may occupy: the lowest permitted obstruction on each storey, from the
  // pre-sizing's resolved ceiling profiles (slab + beams, or the transfer zone on the transfer-below storey).
  const typicalSizing = presize.byStorey.get(typicalStorey.id) ?? null;
  const corridorBeamDepth = typicalSizing ? typicalSizing.beamDAbove : (system === 'steel-frame' || system === 'mass-timber-clt' ? sizes.beamD : 0);
  const typicalSlabT = thicknessAbove(typicalStorey.id);
  const corridorSoffitZ = typicalSizing
    ? typicalSizing.corridorSoffitZ
    : round(typicalStorey.height - typicalSlabT - corridorBeamDepth, 4);
  const plenumByStorey: Record<string, number> = {};
  for (const s of [...framedStoreys, ...(roofStorey ? [roofStorey] : [])]) {
    const z = presize.byStorey.get(s.id);
    plenumByStorey[s.id] = z ? z.corridorSoffitZ : round(s.height - thicknessAbove(s.id) - corridorBeamDepth, 4);
  }

  const derived: Record<string, number> = {
    columnCount: columns.length,
    beamCount: beams.length,
    structuralWallCount: walls.length,
    slabCount: slabs.length,
    slabArea: round(slabArea, 2),
    grossFloorArea: round(grossFloorArea, 2),
    concreteVolumeM3: round(concreteVolumeM3, 2),
    concreteWallVolumeM3: round(concreteWallVol, 2),
    coreShearWallVolumeM3: round(coreShearWallVol, 2),
    steelTonnes: round(steelTonnes, 2),
    timberVolumeM3: round(timberVolumeM3, 2),
    // A1–A3 (product stage) of the elements this module actually models
    embodiedCarbonKgCO2e: round(embodiedCarbonKgCO2e, 1),
    embodiedCarbon: round(embodiedCarbonKgCO2e, 1),
    embodiedCarbonPerM2: round(embodiedCarbonPerM2, 2),
    embodiedCarbonA1A5PerM2: round(embodiedCarbonPerM2 * A4A5_FACTOR, 2),
    maxColumnTributaryAreaM2: round(maxTributary, 2),
    avgTributaryArea: round(avgTributary, 2),
    gridSpacingX: grid.avgSpacingX,
    gridSpacingY: grid.avgSpacingY,
    gridLineCount: gridLines.length,
    foundationCount: foundations.length,
    pileCount,
    transferStorey: transferStorey ? 1 : 0,
    podiumStoreys,
    structuralDepthAtCorridor: round(typicalSlabT + corridorBeamDepth, 4),
    corridorSoffitZ,
    structureSystem: systemIndex(system),
    foundationType: foundationIndex(foundation),
    slabT: sizes.slabT,
    columnSide: sizes.columnW,
    beamDepth: sizes.beamD,
    shearWallT: sizes.shearWallT,
    deadKpa: loads.deadKpa,
    liveKpa: loads.liveKpa,
    liveCorridorKpa: presize.loads.liveCorridorKpa,
    roofLiveKpa: loads.roofLiveKpa,
    storeysAboveGrade: storeyCount,
    coreWallT: presize.coreWallT,
    partyWallT: presize.partyWallT,
    transferZoneDepth: transferStorey ? presize.transferZoneDepth : 0,
    bayTarget: presize.gridProposal.bay.target,
    gridFromPartyLines: grid.source === 'party-lines' ? 1 : 0,
    floorToFloorRaised: presize.issues.filter(i => i.ruleId === 'XD-02.plenumDepth').length,
    ...loadPath.derived,
  };

  if (columns.length === 0 && walls.filter(w => w.role === 'bearing').length === 0 && arch) {
    warn('no columns and no bearing walls were produced — architecture may not have emitted exterior/party walls on the residential storeys.');
  }

  return {
    system,
    foundation,
    grid: gridLines,
    columns,
    beams,
    walls,
    slabs,
    foundations,
    transferStorey,
    sizes,
    loads: { deadKpa: loads.deadKpa, liveKpa: loads.liveKpa, roofLiveKpa: loads.roofLiveKpa },
    plenumClearance: { corridorSoffitZ, byStorey: plenumByStorey },
    elements,
    patterns: apps,
    derived,
  };
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function pset(name: string, properties: { name: string; value: string | number | boolean }[]): PropertySetDef {
  return { name, properties };
}

function qset(name: string, quantities: QuantitySetDef['quantities']): QuantitySetDef {
  return { name, quantities };
}

function formaStructure(
  system: StructuralSystemId,
  material: string,
  section: string,
  tributaryArea: number,
  grid: string,
  extra: Record<string, string | number | boolean> = {},
): PropertySetDef {
  return {
    name: 'Forma_Structure',
    properties: [
      { name: 'System', value: system },
      { name: 'Material', value: material },
      { name: 'Section', value: section },
      { name: 'TributaryArea', value: round(tributaryArea, 3) },
      { name: 'Grid', value: grid },
      ...Object.entries(extra).map(([name, value]) => ({ name, value })),
    ],
  };
}

/** Plan footprint of a straight stair run, widened across the run */
export function stairRunRect(st: StairDef): Rect {
  const len = Math.max(0.5, st.risers * st.tread);
  const dx = Math.cos(st.direction);
  const dy = Math.sin(st.direction);
  const px = (-dy * st.width) / 2;
  const py = (dx * st.width) / 2;
  const x1 = st.position[0];
  const y1 = st.position[1];
  const x2 = x1 + dx * len;
  const y2 = y1 + dy * len;
  const xs = [x1 + px, x1 - px, x2 + px, x2 - px];
  const ys = [y1 + py, y1 - py, y2 + py, y2 - py];
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
}
