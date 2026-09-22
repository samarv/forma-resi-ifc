/**
 * The floor organiser: massing bars + cores + the site's corridor graph → a `FloorLayout` v2 of placed MODULES, then
 * dwelling instances via the unit-layout engine.
 *
 * Three stages now, deliberately separated so the typical floor is planned once, edited once and repeated:
 *   1. `planFloorLayout` produces the editable document: strips (the one place `netDepth` is defined), slots (one
 *      module each, stable ids, resolved ports), the corridor graph, the grid handshake and the mix report. It is a
 *      pure function of the spec, so identical floors share one plan → wet walls, stacks and shafts stack (ARC-08).
 *   2. `applyOverrides(base, spec.overrides, ctx)` (placer/apply-overrides.ts) edits it deterministically.
 *   3. `instantiateFloor` realises the document on one storey: envelope walls, cores, corridors, units (calling
 *      `layoutUnit` with the module's feasibility witness), common rooms, balconies.
 *
 * Template PICKING is gone. The packer draws modules whose admissible frontage at the strip's own net depth contains
 * the width it hands them, so "below the minimum for that template at D m depth" has nothing left to report.
 */
import type {
  BalconyDef, Compass, CorridorDef, DoorDef, FurnitureDef, GenContext, Rect, RoomDef,
  RoomType, Side, Segment2, UnitInstance, UnitTemplateDef, UnitTemplateId, Vec2, WallDef, WindowDef,
} from '../../core/types.ts';
import type { UnitBoundaryWalls, UnitLayoutFn, UnitLayoutRequest } from './unit-layout-types.ts';
import { SIZES } from '../../core/coordination.ts';
import {
  exposureOf, insetSides, oppositeSide, polygonArea, polygonBounds, rectContainsRect, rectEdges,
  rectToPolygon, rectsOverlap, round, segDir, sideNormal, dist,
} from '../../core/geometry.ts';
import { alongInWall, reachRect, solveSwing } from '../../core/openings.ts';
import { createRng } from '../../core/rng.ts';
import { unitId as makeUnitId } from '../../core/ids.ts';
import {
  alongRange, acrossRange, apportion, frameOfRect, ivLen, mergeIntervals, rectFromAC, sideSpan,
  subtractIntervals, type BarFrame, type Interval,
} from './bar-frame.ts';
import { ArchBuilder, railingElement, slabElement } from './arch-elements.ts';
import { buildCoreOnFloor, coreAcrossIn, coreBlockedIn, coresFor, deckRailing, type CoreLayout } from './cores.ts';
import { EnvelopeBuilder, glazeWall } from './envelope.ts';
import {
  amenityProgram, buildCommonRoom, buildParkingRamp, clusterAmenityProgram, furnishCommonRoom,
  groundProgram, programLength, retailProgram, sliceProgram, type ProgramItem,
} from './common-rooms.ts';
import type {
  CommonRoomSlot, CorridorSlot, FloorCtx, SideWallSpec,
} from './types-internal.ts';
import type { Deviation } from '../../core/rules/types.ts';
import type { Rng } from '../../core/types.ts';
import type { Feasibility, FeasibilityOpts, ProgramGraph } from './program/types.ts';
import type { ModuleCatalogue } from '../../modules/types.ts';
import type { BayGrid } from '../structure/presize.ts';
import type { CorridorGraph } from '../site/corridor-graph.ts';
import type { FloorLayout, Slot, StripDef } from './placer/types.ts';
import { templateOf } from '../../modules/ids.ts';
import { canonicalJson, fnv1a } from '../../core/overrides.ts';
import { packStrip as packModules } from './placer/packer.ts';
import { blockersFor, freeIntervals, makeStrip, type StripSide } from './placer/strips.ts';
import { instantiateBreaks, legCentrelines } from './placer/corridors.ts';
import type { QuotaState } from './placer/quota.ts';

export interface OrganizerDeps {
  templates: Map<UnitTemplateId, UnitTemplateDef>;
  layoutUnit: UnitLayoutFn;
  /** the module catalogue, so instantiation can name a slot's module without rebuilding it */
  catalogue?: ModuleCatalogue;
}

const EXT = SIZES.exteriorWallT;
const PARTY = SIZES.partyWallT;
const CORR = SIZES.corridorWallT;

const WALL_EXT: SideWallSpec = { type: 'exterior', thickness: EXT };
const WALL_PARTY: SideWallSpec = { type: 'party', thickness: PARTY };
const WALL_CORR: SideWallSpec = { type: 'corridor', thickness: CORR };
const WALL_PART: SideWallSpec = { type: 'partition', thickness: SIZES.partitionT };
/** ARC-07: depth of a stair landing measured across the bar */
const LANDING_DEPTH = 2.6;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Stable hash of a slot's unit edits — part of the per-unit RNG label and of the canonical layout cache key */
function hashUnitEdits(edits: readonly import('../../core/overrides.ts').UnitEdit[]): string {
  return fnv1a(canonicalJson(edits));
}

// ============================================================================
// Stage 1 — abstract plan
// ============================================================================

export interface PlanArgs {
  b: ArchBuilder;
  ctx: GenContext;
  f: FloorCtx;
  cores: CoreLayout[];
  deps: OrganizerDeps;
  /** number of dwellings expected in the whole building, for sizing common program */
  unitsInBuilding: number;
  hasAmenityFloor: boolean;
  /** the module catalogue, memoised per rule set */
  catalogue: ModuleCatalogue;
  /** the structural handshake: planning module, admissible bay band, wall thicknesses */
  grid: BayGrid;
  /** BUILDING-WIDE mix ledger, carried across strips and storeys */
  quota: QuotaState;
  /** the site's corridor topology (legs, break slots, knuckles), or null before it lands */
  graph: CorridorGraph | null;
  opts: FeasibilityOpts;
}

export function planFloorLayout(a: PlanArgs): FloorLayout {
  const key = planKey(a.f, a.ctx);
  const use = a.f.use;
  if (use === 'parking' || use === 'mechanical' || use === 'basement') return planServiceFloor(a, key);
  if (use === 'retail') return planRetailFloor(a, key);
  if (use === 'amenity') return planAmenityFloor(a, key);
  const access = a.ctx.typology.access;
  // 'direct' (own front door) never arrives here: houses span storeys, so the whole stack is
  // planned once by `planHouses` before the per-floor loop reaches `planFloorLayout`.
  switch (access) {
    case 'stair-core': return planStairCoreFloor(a, key);
    case 'point-core': return planPointCoreFloor(a, key);
    case 'gallery': return planCorridorFloor(a, key, 'gallery');
    case 'corridor-single': return planCorridorFloor(a, key, 'single');
    case 'cluster': return planCorridorFloor(a, key, clusterMode(a));
    default: return planCorridorFloor(a, key, 'double');
  }
}

/**
 * ARC-12: a co-living cluster wants the full depth of the bar (its own internal circulation runs
 * across it). Load the corridor on one side when the bar is deep enough for that, otherwise fall
 * back to a double-loaded plan.
 */
function clusterMode(a: PlanArgs): 'double' | 'single' {
  const corridor = a.ctx.spec.massing.corridorWidth ?? a.ctx.typology.corridorWidth ?? 1.6;
  const clusters = a.catalogue.units.filter(m => m.variant === 'cluster');
  if (clusters.length === 0 || a.f.bars.length === 0) return 'double';
  // Load the corridor on one side only when a cluster module is admissible at the resulting depth AND the bar has a
  // free run long enough for its minimum frontage. Otherwise the cores have cut the plate into bays too short for a
  // cluster and the honest plan is a double-loaded corridor of small dwellings — which is a mix deviation, recorded,
  // not a squeezed cluster with six windowless bedrooms.
  for (const frame of a.f.bars) {
    const netDepth = round(frame.depth - corridor - EXT * 2 - CORR, 3);
    const blocks = coresFor(a.cores, frame).map(c => coreBlockedIn(c, frame));
    const runs = subtractIntervals({ s: frame.a0 + EXT / 2, e: frame.a1 - EXT / 2 }, blocks, 3.0);
    const longest = runs.reduce((m, iv) => Math.max(m, ivLen(iv)), 0);
    for (const m of clusters) {
      const r = a.catalogue.frontageAt(m.id, netDepth, a.opts);
      if (r && longest >= r.min - 0.05) return 'single';
    }
  }
  return 'double';
}

export function planKey(f: FloorCtx, ctx: GenContext): string {
  const o = polygonBounds(f.outline);
  const mix = Object.entries(f.unitMix).filter(([, v]) => (v ?? 0) > 0).map(([k, v]) => `${k}:${v}`).sort().join(',');
  return [
    f.use,
    `${round(o.x, 2)},${round(o.y, 2)},${round(o.w, 2)},${round(o.h, 2)}`,
    f.targetUnits ?? '-',
    mix,
    f.isGround ? 'G' : 'T',
    f.balconies ? 'B' : '-',
    round(f.wwr, 2),
    round(f.ceilingHeight, 2),
    ctx.typology.access,
  ].join('|');
}

function emptyLayout(a: PlanArgs, key: string): FloorLayout {
  return {
    version: 2,
    key,
    layoutKey: `${key}#0`,
    strips: [],
    slots: [],
    corridor: a.graph,
    corridorSlots: [],
    commons: [],
    grid: { module: a.grid.module, bay: { min: a.grid.bay.min, max: a.grid.bay.max }, lines: {} },
    mix: a.quota.report(),
    blocked: {},
    remnantArea: 0,
    deviations: [],
  };
}

/** Column lines of a bar, accumulated across its strips and returned to structure as `ArchModel.partyLines` */
function addLines(layout: FloorLayout, barId: string, boundaries: readonly { at: number; column: boolean }[]): void {
  const list = layout.grid.lines[barId] ?? [];
  for (const b of boundaries) if (b.column) list.push(round(b.at, 4));
  layout.grid.lines[barId] = [...new Set(list)].sort((x, y) => x - y);
}

// ---------------------------------------------------------------------------
// Strip packing
// ---------------------------------------------------------------------------

interface StripArgs {
  a: PlanArgs;
  frame: BarFrame;
  iv: Interval;
  cLow: number;
  cHigh: number;
  /** which side of the unit rect faces the access */
  accessSide: Side;
  /** exterior sides shared by every unit in the strip (the across face) */
  baseExterior: Side[];
  atStart: boolean;
  atEnd: boolean;
  startWall: SideWallSpec;
  endWall: SideWallSpec;
  accessWall: SideWallSpec;
  rng: Rng;
  targetCount?: number;
  coreId?: string;
  levels?: number;
  levelsExact?: boolean;
  storeySpan?: string[];
  stairRect?: Rect;
  legId?: string;
  blocked?: Interval[];
  /** which face of the bar the strip is on, and its index, for the stable strip id */
  side: StripSide;
  stripIndex: number;
  /** running slot number inside the strip */
  seq: { n: number };
}

interface StripResult {
  strip: StripDef;
  slots: Slot[];
  deviations: Deviation[];
  boundaries: { at: number; column: boolean }[];
  remnantArea: number;
}

/**
 * Build the `StripDef` — the ONE place `netDepth` is computed, from the boundary depth less half of each bounding
 * wall — and hand it to the placer's packer.
 */
function packInto(s: StripArgs): StripResult {
  const { a, frame, iv, cLow, cHigh } = s;
  // the two across-side wall specs are the same for every unit in the strip
  const acrossSpec = {} as Record<Side, SideWallSpec>;
  if (s.accessSide === frame.lowSide) {
    acrossSpec[frame.lowSide] = s.accessWall;
    acrossSpec[frame.highSide] = WALL_EXT;
  } else if (s.accessSide === frame.highSide) {
    acrossSpec[frame.highSide] = s.accessWall;
    acrossSpec[frame.lowSide] = WALL_EXT;
  } else {
    acrossSpec[frame.lowSide] = s.baseExterior.includes(frame.lowSide) ? WALL_EXT : WALL_PARTY;
    acrossSpec[frame.highSide] = s.baseExterior.includes(frame.highSide) ? WALL_EXT : WALL_PARTY;
  }
  const strip = makeStrip({
    frame,
    side: s.side,
    along: iv,
    cLow,
    cHigh,
    accessSide: s.accessSide,
    exteriorSides: s.baseExterior,
    lowSpec: acrossSpec[frame.lowSide],
    highSpec: acrossSpec[frame.highSide],
    legId: s.legId,
    blocked: s.blocked,
    index: s.stripIndex,
  });
  const res = packModules({
    strip,
    interval: iv,
    frame,
    catalogue: a.catalogue,
    grid: a.grid,
    quota: a.quota,
    rng: s.rng,
    opts: a.opts,
    typology: a.ctx.typology.id,
    region: a.ctx.spec.region,
    lowSpec: acrossSpec[frame.lowSide],
    highSpec: acrossSpec[frame.highSide],
    startWall: s.startWall,
    endWall: s.endWall,
    accessWall: s.accessWall,
    partyWall: WALL_PARTY,
    extWall: WALL_EXT,
    atStart: s.atStart,
    atEnd: s.atEnd,
    targetCount: s.targetCount,
    coreId: s.coreId,
    levels: s.levels,
    levelsExact: s.levelsExact,
    storeySpan: s.storeySpan,
    stairRect: s.stairRect,
    seq: s.seq,
  });
  return { strip, ...res };
}

/** Fold one strip's result into the floor document */
function absorb(layout: FloorLayout, r: StripResult): void {
  layout.strips.push(r.strip);
  layout.slots.push(...r.slots);
  layout.deviations.push(...r.deviations);
  layout.remnantArea = round(layout.remnantArea + r.remnantArea, 3);
  addLines(layout, r.strip.barId, r.boundaries);
}

// ---------------------------------------------------------------------------
// Corridor / gallery floors
// ---------------------------------------------------------------------------

function spinesFor(a: PlanArgs, frame: BarFrame): { across: number; width: number; along: Interval; loaded: 'both' | 'left' | 'right'; id: string; dir: Vec2 } | null {
  const spines = a.ctx.site.massing.corridors.filter(c => c.barId === frame.barId);
  if (spines.length === 0) {
    const width = a.ctx.spec.massing.corridorWidth ?? a.ctx.typology.corridorWidth ?? 1.6;
    return {
      across: (frame.c0 + frame.c1) / 2, width,
      along: { s: frame.a0 + EXT / 2, e: frame.a1 - EXT / 2 },
      loaded: 'both', id: `${frame.barId}-SPINE-SYN`, dir: frame.axis === 'x' ? [1, 0] : [0, 1],
    };
  }
  const s = spines[0];
  const ivs = spines.map(sp => {
    const p = frame.axis === 'x' ? [sp.centerline.a[0], sp.centerline.b[0]] : [sp.centerline.a[1], sp.centerline.b[1]];
    return { s: Math.min(p[0], p[1]), e: Math.max(p[0], p[1]) };
  });
  const along = { s: Math.min(...ivs.map(i => i.s)), e: Math.max(...ivs.map(i => i.e)) };
  const across = frame.axis === 'x'
    ? (s.centerline.a[1] + s.centerline.b[1]) / 2
    : (s.centerline.a[0] + s.centerline.b[0]) / 2;
  return { across, width: s.width, along, loaded: s.loaded, id: s.id, dir: segDir(s.centerline) };
}

function planCorridorFloor(a: PlanArgs, key: string, mode: 'double' | 'single' | 'gallery'): FloorLayout {
  const layout = emptyLayout(a, key);
  const isCluster = a.ctx.typology.access === 'cluster';

  for (const frame of a.f.bars) {
    const spine = spinesFor(a, frame);
    if (!spine) continue;
    const eStart = frame.a0 + EXT / 2;
    const eEnd = frame.a1 - EXT / 2;
    const eLow = frame.c0 + EXT / 2;
    const eHigh = frame.c1 - EXT / 2;
    const width = Math.max(1.2, spine.width);
    const barCores = coresFor(a.cores, frame);
    layout.blocked[frame.barId] = barCores.map(c => coreBlockedIn(c, frame));

    const strips: {
      cLow: number; cHigh: number; accessSide: Side; baseExterior: Side[]; accessWall: SideWallSpec;
    }[] = [];
    let corridorAcross: Interval;
    let corridorExternal = false;
    let deckSide: Side | null = null;

    if (mode === 'gallery') {
      const nearLow = Math.abs(spine.across - frame.c0) <= Math.abs(spine.across - frame.c1);
      deckSide = nearLow ? frame.lowSide : frame.highSide;
      corridorExternal = true;
      corridorAcross = nearLow ? { s: frame.c0 - width, e: frame.c0 } : { s: frame.c1, e: frame.c1 + width };
      strips.push({
        cLow: eLow, cHigh: eHigh, accessSide: deckSide,
        baseExterior: [frame.lowSide, frame.highSide], accessWall: WALL_EXT,
      });
    } else if (mode === 'single') {
      const nearLow = Math.abs(spine.across - frame.c0) <= Math.abs(spine.across - frame.c1);
      if (nearLow) {
        corridorAcross = { s: frame.c0 + EXT, e: frame.c0 + EXT + width };
        strips.push({
          cLow: corridorAcross.e + CORR / 2, cHigh: eHigh, accessSide: frame.lowSide,
          baseExterior: [frame.highSide], accessWall: WALL_CORR,
        });
      } else {
        corridorAcross = { s: frame.c1 - EXT - width, e: frame.c1 - EXT };
        strips.push({
          cLow: eLow, cHigh: corridorAcross.s - CORR / 2, accessSide: frame.highSide,
          baseExterior: [frame.lowSide], accessWall: WALL_CORR,
        });
      }
    } else {
      const c = clamp(spine.across, frame.c0 + width / 2 + 5, frame.c1 - width / 2 - 5);
      corridorAcross = { s: c - width / 2, e: c + width / 2 };
      const leftIsHigh = (frame.axis === 'x' ? spine.dir[0] : -spine.dir[1]) > 0;
      const wantLow = spine.loaded === 'both' || (spine.loaded === 'left') === !leftIsHigh;
      const wantHigh = spine.loaded === 'both' || (spine.loaded === 'left') === leftIsHigh;
      if (wantLow) {
        strips.push({
          cLow: eLow, cHigh: corridorAcross.s - CORR / 2, accessSide: frame.highSide,
          baseExterior: [frame.lowSide], accessWall: WALL_CORR,
        });
      }
      if (wantHigh) {
        strips.push({
          cLow: corridorAcross.e + CORR / 2, cHigh: eHigh, accessSide: frame.lowSide,
          baseExterior: [frame.highSide], accessWall: WALL_CORR,
        });
      }
    }

    // ---- corridor segments (skip core blocks that sit on the corridor line) ----
    const corridorBlocks = barCores
      .filter(c => {
        const ca = acrossRange(frame, c.rect);
        return ca.s < corridorAcross.e - 0.05 && corridorAcross.s < ca.e - 0.05;
      })
      .map(c => coreBlockedIn(c, frame));
    const corridorSpan: Interval = {
      s: Math.max(eStart, Math.min(spine.along.s, eStart + 2)),
      e: Math.min(eEnd, Math.max(spine.along.e, eEnd - 2)),
    };
    // Two bars meeting at a knuckle both reach the corner. The bar listed FIRST on the knuckle owns it and runs
    // through; the other stops at its edge, so the corner is one corridor room rather than two overlapping ones.
    const knuckleCuts = (a.graph?.knuckles ?? [])
      .filter(k => k.barIds.includes(frame.barId) && k.barIds[0] !== frame.barId)
      .map(k => alongRange(frame, k.rect));
    for (const seg of subtractIntervals(corridorSpan, [...corridorBlocks, ...knuckleCuts], 1.2)) {
      const rect = rectFromAC(frame, seg.s, seg.e, corridorAcross.s, corridorAcross.e);
      const daylit: Side[] = [];
      if (seg.s <= eStart + 0.3) daylit.push(frame.startSide);
      if (seg.e >= eEnd - 0.3) daylit.push(frame.endSide);
      layout.corridorSlots!.push({
        rect, barId: frame.barId, spineId: spine.id, width,
        wallSides: corridorExternal ? [] : strips.map(st => oppositeSide(st.accessSide)),
        external: corridorExternal, daylitEnds: daylit,
        outerSide: deckSide ?? undefined,
      });
    }


    // Blockers BEFORE anything is placed: cores with their shaft bay, the corridor graph's knuckles and its break
    // slots. The ground programme is sited around them too, so a residents' lounge can never land on the bay the
    // graph reserved for an exit stair.
    const stripBlockers = strips.map(st => blockersFor({
      frame,
      cores: blockingCores(barCores, frame, st.cLow, st.cHigh).map(c => coreBlockedIn(c, frame)),
      graph: a.graph,
      cLow: st.cLow,
      cHigh: st.cHigh,
    }));

    // ---- ground-floor common program -----------------------------------------
    const reserved: Record<number, Interval[]> = {};
    if (a.f.use === 'lobby-residential' || (a.f.isGround && a.f.use === 'residential' && a.ctx.typology.access !== 'direct')) {
      const anchor = groundAnchor(a, frame);
      const streetSide = frame.axis === 'x' ? frame.lowSide : frame.startSide;
      const prog = groundProgram({
        unitsInBuilding: a.unitsInBuilding, bikeRatio: a.ctx.typology.bikeRatio,
        storeys: a.ctx.spec.massing.storeys, region: a.ctx.spec.region, typology: a.ctx.typology,
        accessSide: strips[0]?.accessSide ?? frame.lowSide, streetSide, hasAmenityFloor: a.hasAmenityFloor,
      });
      const extra = isCluster ? clusterAmenityProgram(strips[0]?.accessSide ?? frame.lowSide) : [];
      for (let si = 0; si < strips.length; si++) {
        const st = strips[si];
        const streetward = st.baseExterior.includes(streetSide) || strips.length === 1;
        const items = streetward ? [...prog.street, ...extra] : prog.rear;
        if (items.length === 0) continue;
        const depth = st.cHigh - st.cLow - EXT / 2 - st.accessWall.thickness / 2;
        const need = Math.min(programLength(items, depth), (eEnd - eStart) * 0.55);
        const free = subtractIntervals({ s: eStart, e: eEnd }, [...stripBlockers[si]], 1.0);
        const target = pickInterval(free, anchor, need);
        if (!target) continue;
        const from: 'start' | 'end' = anchor - target.s < target.e - anchor ? 'start' : 'end';
        const ivUse: Interval = from === 'start' ? { s: target.s, e: target.s + need } : { s: target.e - need, e: target.e };
        const extSides: Partial<Record<Side, boolean>> = {};
        for (const sd of st.baseExterior) extSides[sd] = true;
        if (ivUse.s <= eStart + 0.1) extSides[frame.startSide] = true;
        if (ivUse.e >= eEnd - 0.1) extSides[frame.endSide] = true;
        const sliced = sliceProgram(frame, ivUse, st.cLow, st.cHigh, items, extSides, from);
        for (const slot of sliced.slots) {
          slot.sides = { [st.accessSide]: st.accessWall } as Partial<Record<Side, SideWallSpec>>;
          slot.accessSide = st.accessSide;
          if (slot.entrance && slot.entrance.type === 'service') slot.entrance.side = oppositeSide(st.accessSide);
        }
        layout.commons.push(...sliced.slots);
        if (sliced.used) (reserved[si] ??= []).push(sliced.used);
      }
    }

    // ---- pack the unit strips -------------------------------------------------
    // Blockers first: cores with their shaft bay, the corridor graph's knuckles and its break slots, plus whatever
    // the ground programme reserved. Only then does any dwelling get a metre of frontage.
    const stripDefs: { st: typeof strips[number]; def: StripDef; side: StripSide; seq: { n: number } }[] = [];
    for (let si = 0; si < strips.length; si++) {
      const st = strips[si];
      const blocked = mergeIntervals([...stripBlockers[si], ...(reserved[si] ?? [])], 0.05);
      const side: StripSide = st.accessSide === frame.lowSide ? 'high' : st.accessSide === frame.highSide ? 'low' : 'start';
      stripDefs.push({
        st,
        side,
        seq: { n: 1 },
        def: makeStrip({
          frame, side, along: { s: eStart, e: eEnd }, cLow: st.cLow, cHigh: st.cHigh,
          accessSide: st.accessSide, exteriorSides: [...st.baseExterior],
          lowSpec: st.accessSide === frame.lowSide ? st.accessWall : WALL_EXT,
          highSpec: st.accessSide === frame.highSide ? st.accessWall : WALL_EXT,
          blocked, index: si + 1,
        }),
      });
    }
    layout.blocked[frame.barId] = stripDefs[0]?.def.blocked ?? [];

    // break modules go into the reserved slots, which is what resets the ARC-03 leg counter
    const usedByCore = new Set<string>();
    for (const sd of stripDefs) {
      const br = instantiateBreaks({
        frame, strip: sd.def, graph: a.graph, catalogue: a.catalogue, usedBy: usedByCore,
        lowSpec: sd.def.accessSide === frame.lowSide ? WALL_CORR : WALL_EXT,
        highSpec: sd.def.accessSide === frame.highSide ? WALL_CORR : WALL_EXT,
        partyWall: WALL_PARTY, seq: sd.seq,
      });
      layout.slots.push(...br.slots);
      layout.deviations.push(...br.deviations);
    }

    const intervals: { i: number; iv: Interval }[] = [];
    for (let i = 0; i < stripDefs.length; i++) {
      for (const iv of freeIntervals(stripDefs[i].def, 3.0)) intervals.push({ i, iv });
    }
    const counts = a.f.targetUnits !== undefined
      ? apportion(a.f.targetUnits, intervals.map(x => ivLen(x.iv)))
      : intervals.map(() => undefined as number | undefined);

    for (let k = 0; k < intervals.length; k++) {
      const { i, iv } = intervals[k];
      const sd = stripDefs[i];
      const res = packInto({
        a, frame, iv, cLow: sd.st.cLow, cHigh: sd.st.cHigh, accessSide: sd.st.accessSide,
        baseExterior: [...sd.st.baseExterior],
        atStart: iv.s <= eStart + 0.05, atEnd: iv.e >= eEnd - 0.05,
        startWall: WALL_PART, endWall: WALL_PART, accessWall: sd.st.accessWall,
        rng: a.ctx.rng.fork(`strip:${sd.def.id}`), targetCount: counts[k],
        coreId: nearestCore(barCores, frame, (iv.s + iv.e) / 2)?.id,
        side: sd.side, stripIndex: i + 1, seq: sd.seq, blocked: sd.def.blocked,
      });
      layout.slots.push(...res.slots);
      layout.deviations.push(...res.deviations);
      layout.remnantArea = round(layout.remnantArea + res.remnantArea, 3);
      addLines(layout, frame.barId, res.boundaries);
    }
    for (const sd of stripDefs) layout.strips.push(sd.def);
  }
  layout.mix = a.quota.report();
  return layout;
}

/** Cores (with their shaft bay) whose across-extent intrudes into a strip */
function blockingCores(cores: CoreLayout[], frame: BarFrame, cLow: number, cHigh: number): CoreLayout[] {
  return cores.filter(c => {
    const ca = coreAcrossIn(c, frame);
    return ca.s < cHigh - 0.05 && cLow < ca.e - 0.05;
  });
}

function groundAnchor(a: PlanArgs, frame: BarFrame): number {
  const main = a.ctx.site.entrances.find(e => e.type === 'main');
  if (main) return frame.axis === 'x' ? main.position[0] : main.position[1];
  const core = coresFor(a.cores, frame)[0];
  if (core) {
    const r = alongRange(frame, core.rect);
    return (r.s + r.e) / 2;
  }
  return (frame.a0 + frame.a1) / 2;
}

function pickInterval(free: Interval[], anchor: number, need: number): Interval | null {
  const fits = free.filter(i => ivLen(i) >= need + 3.0);
  if (fits.length === 0) {
    const any = free.filter(i => ivLen(i) >= need);
    if (any.length === 0) return null;
    return any.sort((p, q) => Math.abs(mid(p) - anchor) - Math.abs(mid(q) - anchor))[0];
  }
  return fits.sort((p, q) => Math.abs(mid(p) - anchor) - Math.abs(mid(q) - anchor))[0];
}

function mid(i: Interval): number { return (i.s + i.e) / 2; }

function nearestCore(cores: CoreLayout[], frame: BarFrame, along: number): CoreLayout | undefined {
  let best: CoreLayout | undefined;
  let d = Infinity;
  for (const c of cores) {
    const r = alongRange(frame, c.rect);
    const dd = Math.abs((r.s + r.e) / 2 - along);
    if (dd < d) { d = dd; best = c; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Stair-core floors (walk-up, mansion block) — ARC-07 Two per Landing
// ---------------------------------------------------------------------------

function planStairCoreFloor(a: PlanArgs, key: string): FloorLayout {
  const layout = emptyLayout(a, key);


  for (const frame of a.f.bars) {
    const eStart = frame.a0 + EXT / 2;
    const eEnd = frame.a1 - EXT / 2;
    const eLow = frame.c0 + EXT / 2;
    const eHigh = frame.c1 - EXT / 2;
    const barCores = coresFor(a.cores, frame);
    if (barCores.length === 0) {
      a.b.warn(`bar ${frame.barId} has no core for a stair-core typology — no dwellings placed`);
      continue;
    }
    layout.blocked[frame.barId] = barCores.map(c => coreBlockedIn(c, frame));

    // landing per core, plus any leftover pocket beside the core
    const blocks: { core: CoreLayout; iv: Interval }[] = [];
    for (const core of barCores) {
      const ca = acrossRange(frame, core.rect);
      const cAl = alongRange(frame, core.rect);
      const lowRoom = ca.s - eLow;
      const highRoom = eHigh - ca.e;
      const cb = coreBlockedIn(core, frame);
      const iv: Interval = { s: Math.min(cb.s, cAl.s), e: Math.max(cb.e, cAl.e) };
      if (Math.max(lowRoom, highRoom) >= 2.0) {
        const useLow = lowRoom >= highRoom;
        const room = useLow ? lowRoom : highRoom;
        const landingDepth = Math.min(room, LANDING_DEPTH);
        const l0 = useLow ? ca.s - landingDepth : ca.e;
        const l1 = l0 + landingDepth;
        layout.commons.push({
          rect: rectFromAC(frame, cAl.s, cAl.e, l0, l1), type: 'lobby', name: 'Stair Landing',
          exteriorSides: room - landingDepth < 0.35 ? [useLow ? frame.lowSide : frame.highSide] : [],
          accessSide: undefined, open: false,
          sides: { [useLow ? frame.highSide : frame.lowSide]: { type: 'core', thickness: a.ctx.presize?.coreWallT ?? SIZES.coreWallT } } as Partial<Record<Side, SideWallSpec>>,
        });
        // pocket beyond the landing, and the shallow side, become resident storage
        const pockets: { c0: number; c1: number; ext: Side }[] = [];
        if (room - landingDepth >= 1.6) {
          pockets.push(useLow
            ? { c0: eLow, c1: l0, ext: frame.lowSide }
            : { c0: l1, c1: eHigh, ext: frame.highSide });
        }
        const other = useLow ? highRoom : lowRoom;
        if (other >= 1.6) {
          pockets.push(useLow
            ? { c0: ca.e, c1: eHigh, ext: frame.highSide }
            : { c0: eLow, c1: ca.s, ext: frame.lowSide });
        }
        for (const pk of pockets) {
          layout.commons.push({
            rect: rectFromAC(frame, cAl.s, cAl.e, pk.c0, pk.c1),
            type: 'storage', name: 'Resident Storage', exteriorSides: [pk.ext], open: false,
          });
        }
      } else {
        // no depth for a landing across the bar: take 2.4 m along the bar instead
        const toCentre = cAl.s - frame.a0 < frame.a1 - cAl.e ? 1 : -1;
        const l0 = toCentre > 0 ? cAl.e : cAl.s - LANDING_DEPTH;
        layout.commons.push({
          rect: rectFromAC(frame, l0, l0 + LANDING_DEPTH, eLow, eHigh), type: 'lobby', name: 'Stair Landing',
          exteriorSides: [frame.lowSide, frame.highSide], open: false,
        });
        iv.s = Math.min(iv.s, l0);
        iv.e = Math.max(iv.e, l0 + LANDING_DEPTH);
      }
      blocks.push({ core, iv });
    }

    // Each landing side is packed in full: the packer draws modules whose admissible frontage at THIS depth fills the
    // interval, so there is no "core spacing leaves only N m per landing side" to report and no slack to dump into a
    // shared flex room. The core footprint the site reserved is the only thing that decides how much is left.
    /*
     * A flat off a landing is entered from its END, so its FRONTAGE runs across the bar and its DEPTH runs along the
     * bar away from the landing. The packer therefore works in a frame ROTATED 90° from the bar: `along` is the bar's
     * depth (flats side by side, front to back) and `across` is the run from the landing. v1 packed along the bar and
     * then measured the template minimum against that length, so the frontage the packer allocated and the frontage
     * the unit solver saw were two different dimensions — the "core spacing leaves only N m per landing side" family.
     */
    const free = subtractIntervals({ s: eStart, e: eEnd }, blocks.map(x => x.iv), 3.0);
    const rotAxis: 'x' | 'y' = frame.axis === 'x' ? 'y' : 'x';
    const deepest = Math.max(6, ...a.catalogue.units.filter(u => u.variant !== 'cluster').map(u => u.depth.max));
    let stripIndex = 0;
    for (const iv of free) {
      const bounding = blocks.filter(x => Math.abs(x.iv.e - iv.s) < 0.3 || Math.abs(x.iv.s - iv.e) < 0.3);
      const core = bounding[0] ?? { core: barCores[0], iv: coreBlockedIn(barCores[0], frame) };
      const towardEnd = Math.abs(core.iv.s - iv.e) < Math.abs(core.iv.e - iv.s);
      // one landing block per group: nothing may be deeper than the deepest admissible dwelling
      const groups = Math.max(1, Math.ceil(ivLen(iv) / deepest - 1e-9));
      const segLen = ivLen(iv) / groups;
      for (let gi = 0; gi < groups; gi++) {
        stripIndex++;
        const seg: Interval = { s: iv.s + gi * segLen, e: iv.s + (gi + 1) * segLen };
        const rect = rectFromAC(frame, seg.s, seg.e, eLow, eHigh);
        const bf = frameOfRect(frame.barId, rect, rotAxis, [frame.lowSide, frame.highSide]);
        // the landing is at the end of the block nearest the core; that face carries the flats' entry doors
        const accessSide = towardEnd === (gi === groups - 1) ? bf.highSide : bf.lowSide;
        const exterior: Side[] = [accessSide === bf.highSide ? bf.lowSide : bf.highSide];
        const res = packInto({
          a, frame: bf, iv: { s: bf.a0, e: bf.a1 }, cLow: bf.c0, cHigh: bf.c1,
          accessSide, baseExterior: exterior,
          atStart: true, atEnd: true,
          startWall: WALL_EXT, endWall: WALL_EXT,
          accessWall: { type: 'partition', thickness: SIZES.partitionT },
          rng: a.ctx.rng.fork(`stair:${frame.barId}:${stripIndex}`),
          coreId: core.core.id, side: accessSide === bf.highSide ? 'low' : 'high',
          stripIndex, seq: { n: 1 },
        });
        absorb(layout, res);
      }
    }
  }
  layout.mix = a.quota.report();
  return layout;
}

// ---------------------------------------------------------------------------
// Point-core floors
// ---------------------------------------------------------------------------

function planPointCoreFloor(a: PlanArgs, key: string): FloorLayout {
  const layout = emptyLayout(a, key);
  const ring = 1.6;

  for (const frame of a.f.bars) {
    const core = coresFor(a.cores, frame)[0] ?? a.cores[0];
    if (!core) {
      a.b.warn(`point-core floor ${a.f.storeyId} has no core — no dwellings placed`);
      continue;
    }
    layout.blocked[frame.barId] = [coreBlockedIn(core, frame)];
    const plate: Rect = { x: frame.axis === 'x' ? frame.a0 : frame.c0, y: frame.axis === 'x' ? frame.c0 : frame.a0, w: frame.axis === 'x' ? frame.length : frame.depth, h: frame.axis === 'x' ? frame.depth : frame.length };
    const outer = insetSides(plate, { front: EXT / 2, rear: EXT / 2, left: EXT / 2, right: EXT / 2 });
    // the ring wraps the core AND its shaft bay, so nothing pokes into a dwelling
    const zone = core.shaftBlock ? unionOf(core.rect, core.shaftBlock) : core.rect;
    const ringOuter: Rect = {
      x: round(zone.x - ring), y: round(zone.y - ring),
      w: round(zone.w + 2 * ring), h: round(zone.h + 2 * ring),
    };
    // the lift-lobby ring, as four bands so it is a donut and never covers the core itself
    const ringBands: Rect[] = [
      { x: ringOuter.x, y: ringOuter.y, w: ringOuter.w, h: round(zone.y - ringOuter.y) },
      { x: ringOuter.x, y: round(zone.y + zone.h), w: ringOuter.w, h: round(ringOuter.y + ringOuter.h - (zone.y + zone.h)) },
      { x: ringOuter.x, y: zone.y, w: round(zone.x - ringOuter.x), h: zone.h },
      { x: round(zone.x + zone.w), y: zone.y, w: round(ringOuter.x + ringOuter.w - (zone.x + zone.w)), h: zone.h },
    ].filter(r => r.w > 0.4 && r.h > 0.4);
    for (const rb of ringBands) {
      layout.corridorSlots!.push({
        rect: rb, barId: frame.barId, spineId: `${frame.barId}-RING`, width: ring,
        wallSides: [], external: false, daylitEnds: [],
      });
    }

    const allBands: { rect: Rect; accessSide: Side; ext: Side[]; along: 'x' | 'y' }[] = [
      { rect: { x: outer.x, y: outer.y, w: outer.w, h: Math.max(0, ringOuter.y - CORR / 2 - outer.y) }, accessSide: 'rear', ext: ['front'], along: 'x' },
      { rect: { x: outer.x, y: ringOuter.y + ringOuter.h + CORR / 2, w: outer.w, h: Math.max(0, outer.y + outer.h - (ringOuter.y + ringOuter.h + CORR / 2)) }, accessSide: 'front', ext: ['rear'], along: 'x' },
      { rect: { x: outer.x, y: ringOuter.y, w: Math.max(0, ringOuter.x - CORR / 2 - outer.x), h: ringOuter.h }, accessSide: 'right', ext: ['left'], along: 'y' },
      { rect: { x: ringOuter.x + ringOuter.w + CORR / 2, y: ringOuter.y, w: Math.max(0, outer.x + outer.w - (ringOuter.x + ringOuter.w + CORR / 2)), h: ringOuter.h }, accessSide: 'left', ext: ['right'], along: 'y' },
    ];
    const bands = allBands.filter(b => b.rect.w > 3 && b.rect.h > 3);
    if (bands.length === 0) {
      a.b.warn(`point-core floor ${a.f.storeyId}: core ${core.id} leaves no room for dwellings`);
      continue;
    }

    const want = clamp(a.f.targetUnits ?? a.ctx.typology.unitsPerCore ?? 6, Math.max(4, bands.length), 8);
    const lens = bands.map(b => (b.along === 'x' ? b.rect.w : b.rect.h));
    const counts = apportion(want, lens);
    for (let i = 0; i < bands.length; i++) if (counts[i] === 0) counts[i] = 1;

    for (let i = 0; i < bands.length; i++) {
      const band = bands[i];
      const bf: BarFrame = {
        barId: frame.barId, axis: band.along,
        a0: band.along === 'x' ? band.rect.x : band.rect.y,
        a1: band.along === 'x' ? band.rect.x + band.rect.w : band.rect.y + band.rect.h,
        c0: band.along === 'x' ? band.rect.y : band.rect.x,
        c1: band.along === 'x' ? band.rect.y + band.rect.h : band.rect.x + band.rect.w,
        lowSide: band.along === 'x' ? 'front' : 'left',
        highSide: band.along === 'x' ? 'rear' : 'right',
        startSide: band.along === 'x' ? 'left' : 'front',
        endSide: band.along === 'x' ? 'right' : 'rear',
        length: band.along === 'x' ? band.rect.w : band.rect.h,
        depth: band.along === 'x' ? band.rect.h : band.rect.w,
        exteriorSides: band.ext,
      };
      const atStart = band.along === 'x' ? band.rect.x <= outer.x + 0.05 : band.rect.y <= outer.y + 0.05;
      const atEnd = band.along === 'x' ? band.rect.x + band.rect.w >= outer.x + outer.w - 0.05 : band.rect.y + band.rect.h >= outer.y + outer.h - 0.05;
      const res = packInto({
        a, frame: bf, iv: { s: bf.a0, e: bf.a1 }, cLow: bf.c0, cHigh: bf.c1,
        accessSide: band.accessSide, baseExterior: [...band.ext],
        atStart, atEnd, startWall: WALL_PARTY, endWall: WALL_PARTY, accessWall: WALL_CORR,
        rng: a.ctx.rng.fork(`point:${frame.barId}:${i}`), targetCount: counts[i], coreId: core.id,
        side: band.along === 'x' ? (band.accessSide === 'rear' ? 'low' : 'high') : (band.accessSide === 'right' ? 'low' : 'high'),
        stripIndex: i + 1, seq: { n: 1 },
      });
      absorb(layout, res);
    }
  }
  layout.mix = a.quota.report();
  return layout;
}

// ---------------------------------------------------------------------------
// Direct access (houses) — ARC-01 / ARC-02 / ARC-10 / ARC-11
// ---------------------------------------------------------------------------

export function planHouses(a: PlanArgs, residentialStoreys: string[]): FloorLayout {
  const key = `houses|${a.ctx.typology.id}|${residentialStoreys.join(',')}`;
  const layout = emptyLayout(a, key);
  const stacked = a.ctx.typology.id === 'stacked-townhouse';
  const groundLevels = stacked ? 1 : residentialStoreys.length;
  const upperStoreys = stacked ? residentialStoreys.slice(1) : [];

  for (const frame of a.f.bars) {
    const eStart = frame.a0 + EXT / 2;
    const eEnd = frame.a1 - EXT / 2;
    const eLow = frame.c0 + EXT / 2;
    const eHigh = frame.c1 - EXT / 2;
    const entrySide: Side = frame.axis === 'x' ? 'front' : 'left';
    const targetCount = a.ctx.typology.id === 'detached-house' || a.ctx.typology.id === 'adu-laneway'
      ? 1
      : a.ctx.typology.id === 'semi-detached' ? 2 : undefined;

    // A terrace is one strip the whole depth of the bar, entered from the street. The packer only offers modules
    // whose own program is feasible over EVERY level at this depth, so a house is never given a frontage its
    // staircase and its bedrooms cannot both live with.
    const res = packInto({
      a, frame, iv: { s: eStart, e: eEnd }, cLow: eLow, cHigh: eHigh,
      accessSide: entrySide, baseExterior: [frame.lowSide, frame.highSide],
      atStart: true, atEnd: true,
      startWall: WALL_EXT, endWall: WALL_EXT, accessWall: WALL_EXT,
      rng: a.ctx.rng.fork(`houses:${frame.barId}`),
      targetCount,
      levels: groundLevels,
      levelsExact: !stacked,
      storeySpan: stacked ? [residentialStoreys[0]] : residentialStoreys,
      side: 'low', stripIndex: 1, seq: { n: 1 },
    });
    absorb(layout, res);

    const unitEntrances = a.ctx.site.entrances
      .filter(e => e.type === 'unit')
      .map(e => (frame.axis === 'x' ? e.position[0] : e.position[1]))
      .sort((p, q) => p - q);
    const garageEntrances = a.ctx.site.entrances
      .filter(e => e.type === 'garage')
      .map(e => (frame.axis === 'x' ? e.position[0] : e.position[1]))
      .sort((p, q) => p - q);

    const houses = res.slots.filter(sl => sl.kind === 'unit');
    for (let k = 0; k < houses.length; k++) {
      const sl = houses[k];
      const al = alongRange(frame, sl.boundary);
      // an internal stair on every level of a multi-level house, identical footprint (ARC-22)
      if (!stacked && residentialStoreys.length > 1) {
        sl.stairRect = houseStairRect(frame, al.s, al.e, eLow, eHigh, entrySide);
      }
      const templateId = templateOf(sl.moduleId);
      const template = templateId ? a.deps.templates.get(templateId) : undefined;
      const wantGarage = !!template && (template.id === 'townhouse-3s' || template.rooms.some(r => r.type === 'garage'));
      if (wantGarage) {
        const width = al.e - al.s;
        sl.extraDoors = [{
          side: entrySide, width: 2.6, height: 2.2, type: 'garage',
          offset: garageEntrances[k] !== undefined ? garageEntrances[k] - al.s : (k === houses.length - 1 ? width - 1.6 : 1.6),
        }];
      }
      if (unitEntrances[k] !== undefined) sl.notes = 'street door at the site entrance';
    }

    // ---- stacked townhouse: a maisonette over each ground flat, on the same party lines --------
    if (stacked && upperStoreys.length > 0) {
      const strip = res.strip;
      for (const sl of houses) {
        const al = alongRange(frame, sl.boundary);
        const frontage = al.e - al.s;
        const upper = upperModuleFor(a, strip.netDepth, frontage, upperStoreys.length, [frame.lowSide, frame.highSide]);
        if (!upper) continue;
        layout.slots.push({
          ...sl,
          // derived from its anchor, exactly like an inserted slot, so the id stays stable
          id: `${sl.id}.u`,
          moduleId: upper,
          storeySpan: [...upperStoreys],
          stairRect: houseStairRect(frame, al.s, al.e, eLow, eHigh, entrySide),
          extraDoors: undefined,
          notes: 'maisonette over',
        });
        a.quota.record(templateOf(upper) ?? '');
      }
      for (const sl of houses) sl.notes = 'ground flat';
    }
  }
  layout.mix = a.quota.report();
  return layout;
}

/** The multi-level module a maisonette over a ground flat can use at this frontage and depth */
function upperModuleFor(
  a: PlanArgs, netDepth: number, frontage: number, levels: number, exteriorSides: Side[],
): string | null {
  const pool = a.catalogue
    .candidatesFor({ netDepth, atStart: true, atEnd: true, exteriorSides, levels, typology: a.ctx.typology.id, region: a.ctx.spec.region })
    .filter(m => m.levels > 1)
    .filter(m => {
      const r = a.catalogue.frontageAt(m.id, netDepth, a.opts);
      return !!r && frontage >= r.min - 0.05 && frontage <= r.max + 0.05;
    });
  if (pool.length === 0) return null;
  return a.quota.order(pool.map(m => m.templateId))
    .map(t => pool.find(m => m.templateId === t))
    .filter((m): m is NonNullable<typeof m> => !!m)[0]?.id ?? null;
}

function unionOf(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

function houseStairRect(frame: BarFrame, a0: number, a1: number, c0: number, c1: number, entrySide: Side): Rect {
  const runLen = Math.min(4.0, (c1 - c0) * 0.42);
  const w = 1.0;
  const alongPos = a0 + 0.25;
  const fromEntry = 1.6;
  const acrossPos = entrySide === frame.lowSide ? c0 + fromEntry : c1 - fromEntry - runLen;
  return rectFromAC(frame, alongPos, Math.min(alongPos + w, a1 - 0.2), acrossPos, acrossPos + runLen);
}

// ---------------------------------------------------------------------------
// Service floors: parking, retail, amenity, mechanical
// ---------------------------------------------------------------------------

function fullDepthFree(a: PlanArgs, frame: BarFrame): Interval[] {
  const barCores = coresFor(a.cores, frame);
  return subtractIntervals(
    { s: frame.a0 + EXT / 2, e: frame.a1 - EXT / 2 },
    barCores.map(c => coreBlockedIn(c, frame)), 2.0,
  );
}

function planServiceFloor(a: PlanArgs, key: string): FloorLayout {
  const layout = emptyLayout(a, key);
  for (const frame of a.f.bars) {
    const eLow = frame.c0 + EXT / 2;
    const eHigh = frame.c1 - EXT / 2;
    layout.blocked[frame.barId] = coresFor(a.cores, frame).map(c => coreBlockedIn(c, frame));
    const free = fullDepthFree(a, frame);
    for (let i = 0; i < free.length; i++) {
      const iv = free[i];
      const ext: Side[] = [frame.lowSide, frame.highSide];
      if (iv.s <= frame.a0 + EXT) ext.push(frame.startSide);
      if (iv.e >= frame.a1 - EXT) ext.push(frame.endSide);
      const type: RoomType = a.f.use === 'mechanical' ? 'plant' : a.f.use === 'basement' ? 'basement' : 'parking';
      layout.commons.push({
        rect: rectFromAC(frame, iv.s, iv.e, eLow, eHigh),
        type,
        name: type === 'parking' ? `Parking Deck ${i + 1}` : undefined,
        exteriorSides: ext,
        open: true,
        glazing: { sill: 1.2, height: 0.8, wwr: 0.06 },
      });
    }
  }
  return layout;
}

function planRetailFloor(a: PlanArgs, key: string): FloorLayout {
  const layout = emptyLayout(a, key);
  for (const frame of a.f.bars) {
    const eStart = frame.a0 + EXT / 2;
    const eEnd = frame.a1 - EXT / 2;
    const eLow = frame.c0 + EXT / 2;
    const eHigh = frame.c1 - EXT / 2;
    const barCores = coresFor(a.cores, frame);
    layout.blocked[frame.barId] = barCores.map(c => coreBlockedIn(c, frame));
    const streetSide = frame.axis === 'x' ? frame.lowSide : frame.startSide;
    const anchor = groundAnchor(a, frame);
    const free = fullDepthFree(a, frame);
    const depth = eHigh - eLow;
    const retailDepth = Math.min(depth, Math.max(9, depth * 0.62));
    const bohC0 = eLow + retailDepth + CORR / 2;

    for (const iv of free) {
      const ext: Side[] = [frame.lowSide];
      if (iv.s <= eStart + 0.1) ext.push(frame.startSide);
      if (iv.e >= eEnd - 0.1) ext.push(frame.endSide);
      const retailC1 = Math.min(eHigh, eLow + retailDepth);
      const nearAnchor = Math.abs(mid(iv) - anchor) < ivLen(iv) / 2 + 6;
      const items: ProgramItem[] = [];
      if (nearAnchor) {
        items.push({
          type: 'lobby', name: 'Residential Lobby', area: 45, minLen: 5.0,
          entrance: { side: streetSide, width: SIZES.doorBuildingEntry, type: 'building-entry' },
        });
      }
      items.push(...retailProgram(ivLen(iv), retailC1 - eLow, streetSide, frame.highSide));
      const extMap: Partial<Record<Side, boolean>> = { [frame.lowSide]: true };
      if (iv.s <= eStart + 0.1) extMap[frame.startSide] = true;
      if (iv.e >= eEnd - 0.1) extMap[frame.endSide] = true;
      const sliced = sliceProgram(frame, iv, eLow, retailC1, items, extMap, 'start');
      layout.commons.push(...sliced.slots);
      if (bohC0 < eHigh - 2.0) {
        const boh: ProgramItem[] = [
          { type: 'trash', name: 'Refuse & Recycling', area: 18, minLen: 3.0 },
          { type: 'mech-room', name: 'Mechanical Room', area: 22, minLen: 3.5 },
          { type: 'elec-room', name: 'Electrical Switch Room', area: 14, minLen: 3.0 },
          { type: 'bike-store', name: 'Bicycle Store', area: 40, minLen: 4.0 },
          { type: 'storage', name: 'Retail Store', area: 60, minLen: 4.0 },
        ];
        const rearExt: Partial<Record<Side, boolean>> = { [frame.highSide]: true };
        if (iv.s <= eStart + 0.1) rearExt[frame.startSide] = true;
        if (iv.e >= eEnd - 0.1) rearExt[frame.endSide] = true;
        const rear = sliceProgram(frame, iv, bohC0, eHigh, boh, rearExt, 'start');
        layout.commons.push(...rear.slots);
      }
      void ext;
    }
  }
  return layout;
}

function planAmenityFloor(a: PlanArgs, key: string): FloorLayout {
  const layout = emptyLayout(a, key);
  for (const frame of a.f.bars) {
    const eLow = frame.c0 + EXT / 2;
    const eHigh = frame.c1 - EXT / 2;
    layout.blocked[frame.barId] = coresFor(a.cores, frame).map(c => coreBlockedIn(c, frame));
    for (const iv of fullDepthFree(a, frame)) {
      const items = amenityProgram(ivLen(iv) * (eHigh - eLow), frame.highSide);
      const extMap: Partial<Record<Side, boolean>> = { [frame.lowSide]: true, [frame.highSide]: true };
      if (iv.s <= frame.a0 + EXT) extMap[frame.startSide] = true;
      if (iv.e >= frame.a1 - EXT) extMap[frame.endSide] = true;
      const sliced = sliceProgram(frame, iv, eLow, eHigh, items, extMap, 'start');
      layout.commons.push(...sliced.slots);
    }
  }
  return layout;
}

// ============================================================================
// Stage 2 — instantiate a plan on one storey
// ============================================================================

export interface InstantiateArgs {
  b: ArchBuilder;
  ctx: GenContext;
  f: FloorCtx;
  layout: FloorLayout;
  cores: CoreLayout[];
  deps: OrganizerDeps;
  /** unit instances keyed by slot key, for multi-storey dwellings */
  unitRegistry: Map<string, UnitInstance>;
  emitSlabs: boolean;
  /** the feasibility WITNESS for a module at the slot's own frontage and depth — the gate on producing a layout */
  fitFor?: (moduleId: string, frontage: number, depth: number, level: number) => Feasibility | null;
  /** the module's program graph, for the v2 solver */
  programFor?: (moduleId: string) => ProgramGraph | undefined;
}

/** A non-dwelling slot rendered as a common room: breaks, declared remnants, MEP rooms and amenities */
function commonFromSlot(slot: Slot, args: InstantiateArgs): CommonRoomSlot {
  const halves: Partial<Record<Side, number>> = {};
  for (const side of ['front', 'rear', 'left', 'right'] as Side[]) {
    halves[side] = (slot.sides[side]?.thickness ?? EXT) / 2;
  }
  const mod = args.deps.catalogue?.byId(slot.moduleId);
  const name = mod?.name;
  return {
    rect: slot.boundary,
    type: slot.roomType ?? 'flex',
    name,
    exteriorSides: [...slot.exteriorSides],
    accessSide: slot.accessSide,
    sides: { [slot.accessSide]: slot.sides[slot.accessSide] } as Partial<Record<Side, SideWallSpec>>,
    open: false,
  };
}

/** The graph's leg segments clipped to one corridor rect, so a `CorridorDef` carries the leg it belongs to */
function clipLegs(legs: readonly Segment2[], rect: Rect): Segment2[] {
  const out: Segment2[] = [];
  for (const seg of legs) {
    const horizontal = Math.abs(seg.b[0] - seg.a[0]) >= Math.abs(seg.b[1] - seg.a[1]);
    if (horizontal) {
      const y = (seg.a[1] + seg.b[1]) / 2;
      if (y < rect.y - 0.6 || y > rect.y + rect.h + 0.6) continue;
      const s = Math.max(rect.x, Math.min(seg.a[0], seg.b[0]));
      const e = Math.min(rect.x + rect.w, Math.max(seg.a[0], seg.b[0]));
      if (e - s > 0.3) out.push({ a: [round(s, 3), round(rect.y + rect.h / 2, 3)], b: [round(e, 3), round(rect.y + rect.h / 2, 3)] });
    } else {
      const x = (seg.a[0] + seg.b[0]) / 2;
      if (x < rect.x - 0.6 || x > rect.x + rect.w + 0.6) continue;
      const s = Math.max(rect.y, Math.min(seg.a[1], seg.b[1]));
      const e = Math.min(rect.y + rect.h, Math.max(seg.a[1], seg.b[1]));
      if (e - s > 0.3) out.push({ a: [round(rect.x + rect.w / 2, 3), round(s, 3)], b: [round(rect.x + rect.w / 2, 3), round(e, 3)] });
    }
  }
  if (out.length > 0) return out;
  return [rect.w >= rect.h
    ? { a: [rect.x, rect.y + rect.h / 2], b: [rect.x + rect.w, rect.y + rect.h / 2] }
    : { a: [rect.x + rect.w / 2, rect.y], b: [rect.x + rect.w / 2, rect.y + rect.h] }];
}

export interface FloorResult {
  unitIds: string[];
  corridors: CorridorDef[];
  commonRoomIds: string[];
  exteriorWallArea: number;
  windowArea: number;
  corridorLength: number;
  circulationArea: number;
  coreArea: number;
}

export function instantiateFloor(args: InstantiateArgs): FloorResult {
  const { b, ctx, f, layout, cores } = args;
  const st = f.storeyId;
  const streetFacing = ctx.site.streetFacing;
  const env = new EnvelopeBuilder(f.outline, st, f.wallHeight, streetFacing);

  const corridorSlots = layout.corridorSlots ?? [];
  // ---- register every break BEFORE the envelope is cut --------------------
  for (const u of layout.slots) registerBreaks(env, u.boundary, u.exteriorSides);
  for (const c of layout.commons) registerBreaks(env, c.rect, c.exteriorSides);
  for (const c of corridorSlots) if (!c.external) registerBreaks(env, c.rect, ['front', 'rear', 'left', 'right']);
  for (const c of cores) registerBreaks(env, c.rect, c.exteriorSides);
  env.build(b);

  const result: FloorResult = {
    unitIds: [], corridors: [], commonRoomIds: [], exteriorWallArea: 0, windowArea: 0,
    corridorLength: 0, circulationArea: 0, coreArea: 0,
  };

  // ---- cores --------------------------------------------------------------
  for (const c of cores) {
    if (!c.storeys.includes(st)) continue;
    buildCoreOnFloor(b, c, f, streetFacing, env, ctx.presize?.coreWallT);
    result.coreArea += c.rect.w * c.rect.h;
  }

  // ---- corridors ----------------------------------------------------------
  const legLines = legCentrelines(layout.corridor, corridorSlots[0]?.barId ?? '');
  for (const cs of corridorSlots) {
    const room = b.addRoom({
      storey: st, type: 'corridor', rect: cs.rect, height: f.ceilingHeight,
      name: cs.external ? 'Access Deck' : 'Corridor',
      zone: 'circulation',
    });
    result.commonRoomIds.push(room.id);
    result.circulationArea += room.area;
    const len = Math.max(cs.rect.w, cs.rect.h);
    result.corridorLength += len;
    // the centreline is the corridor GRAPH's leg polyline clipped to this rect, not one segment per rect: that is
    // what makes the ARC-03 run length and the travel distance the same number the site graph reports
    const centerline: Segment2[] = clipLegs(legLines.length > 0 ? legLines : legCentrelines(layout.corridor, cs.barId), cs.rect);
    const def: CorridorDef = {
      id: b.ids.next(st, 'CORR'), storey: st, polygon: rectToPolygon(cs.rect), centerline,
      width: cs.width, roomId: room.id,
    };
    b.corridors.push(def);
    result.corridors.push(def);

    if (cs.external) {
      deckRailing(b, st, cs.rect, cs.outerSide ?? 'front', ['ARC-09']);
      slabElement(b, st, cs.rect, 0.2, -0.2, 'FLOOR', 'Access deck slab', ['ARC-09']);
    } else {
      // daylight at the ends (ARC-03)
      for (const side of cs.daylitEnds) {
        const span = sideSpan(cs.rect, side);
        const w = env.wallFor(side, span.across, span.a0, span.a1);
        if (w) {
          result.windowArea += glazeWall(b, w, room.id, { wwr: 0.4, sill: 0.9, height: 1.8 });
          room.exteriorWallIds.push(w.id);
          room.hasExterior = true;
        }
      }
    }
  }

  // ---- units --------------------------------------------------------------
  for (const slot of layout.slots) {
    if (slot.kind !== 'unit') continue;
    const span = slot.storeySpan;
    if (span && !span.includes(st)) continue;
    const slotKey = `${layout.layoutKey}|${slot.id}`;
    const existing = span && span.length > 1 ? args.unitRegistry.get(slotKey) : undefined;
    const level = span ? Math.max(0, span.indexOf(st)) : 0;
    const inst = buildUnit(args, env, slot, level, span?.length ?? 1, existing, slotKey);
    if (inst) result.unitIds.push(inst.id);
  }

  // ---- non-dwelling slots (breaks, remnants, MEP rooms, amenities) --------
  for (const slot of layout.slots) {
    if (slot.kind === 'unit' || slot.kind === 'core') continue;
    const { room, glazedArea } = buildCommonRoom(b, f, commonFromSlot(slot, args), env, streetFacing);
    furnishCommonRoom(b, room, ctx.spec.options.detail);
    result.commonRoomIds.push(room.id);
    result.windowArea += glazedArea;
    if (room.zone === 'circulation') result.circulationArea += room.area;
  }

  // ---- common rooms -------------------------------------------------------
  for (const slot of layout.commons) {
    const { room, glazedArea } = buildCommonRoom(b, f, slot, env, streetFacing);
    furnishCommonRoom(b, room, ctx.spec.options.detail);
    result.commonRoomIds.push(room.id);
    result.windowArea += glazedArea;
    if (room.zone === 'circulation') result.circulationArea += room.area;
  }

  // parking ramp
  if (f.use === 'parking' && f.bars[0]) {
    buildParkingRamp(b, f, f.bars[0], coresFor(cores, f.bars[0]).map(c => coreBlockedIn(c, f.bars[0])));
  }

  // ---- exterior wall / window accounting ---------------------------------
  for (const w of env.allWalls()) result.exteriorWallArea += dist(w.start, w.end) * w.height;
  result.windowArea = b.windows.filter(w => w.storey === st).reduce((acc, w) => acc + w.width * w.height, 0);

  return result;
}

function registerBreaks(env: EnvelopeBuilder, rect: Rect, sides: Side[]): void {
  for (const side of sides) {
    const span = sideSpan(rect, side);
    env.addSpan(side, span.across, span.a0, span.a1);
  }
}

// ---------------------------------------------------------------------------
// One dwelling
// ---------------------------------------------------------------------------

function buildUnit(
  args: InstantiateArgs, env: EnvelopeBuilder, slot: Slot, level: number, levelsTotal: number,
  existing: UnitInstance | undefined, slotKey: string,
): UnitInstance | null {
  const { b, ctx, f, deps } = args;
  const st = f.storeyId;
  const templateId = templateOf(slot.moduleId);
  const template = templateId ? deps.templates.get(templateId) : undefined;
  if (!templateId || !template) {
    b.warn(`unknown unit module ${slot.moduleId} — slot skipped`);
    return null;
  }
  const id = existing?.id ?? makeUnitId(st, b.nextUnitIndex(st));

  // ---- boundary walls ----------------------------------------------------
  const boundaryWalls: UnitBoundaryWalls = {};
  const wallBySide = {} as Partial<Record<Side, WallDef>>;
  for (const side of ['front', 'rear', 'left', 'right'] as Side[]) {
    const spec = slot.sides[side];
    if (!spec) continue;
    const span = sideSpan(slot.boundary, side);
    if (slot.exteriorSides.includes(side) || spec.type === 'exterior') {
      const w = env.wallFor(side, span.across, span.a0, span.a1);
      if (w) {
        wallBySide[side] = w;
        boundaryWalls[side] = w;
        continue;
      }
    }
    const ext = spec.type === 'party' ? extensionsFor(slot, side) : { s: 0, e: 0 };
    const horizontal = side === 'front' || side === 'rear';
    const a0 = span.a0 - ext.s;
    const a1 = span.a1 + ext.e;
    const start: Vec2 = horizontal ? [a0, span.across] : [span.across, a0];
    const end: Vec2 = horizontal ? [a1, span.across] : [span.across, a1];
    const w = b.addWall({
      storey: st, start, end, thickness: spec.thickness, height: f.wallHeight, type: spec.type,
      isExternal: spec.type === 'exterior',
      loadBearingHint: spec.type === 'party' || spec.type === 'exterior' || spec.type === 'core',
      fireRating: spec.type === 'party' ? '1HR' : spec.type === 'corridor' ? '1HR' : undefined,
      unitId: spec.type === 'corridor' || spec.type === 'partition' ? id : undefined,
      exposure: spec.type === 'exterior' ? exposureOf(sideNormal(side), ctx.site.streetFacing) : undefined,
    });
    wallBySide[side] = w;
    boundaryWalls[side] = w;
  }

  // ---- net rect ----------------------------------------------------------
  const halves: Partial<Record<Side, number>> = {};
  for (const side of ['front', 'rear', 'left', 'right'] as Side[]) {
    halves[side] = (slot.sides[side]?.thickness ?? EXT) / 2;
  }
  const net = insetSides(slot.boundary, halves);
  // A slot can no longer be too small: it was created from a module's own admissible frontage at its strip's net
  // depth. The guard stays as an assertion — reaching it is a placer bug, recorded as a violation, never a warning.
  if (net.w < 2.2 || net.h < 2.2) {
    args.ctx.issues?.add({
      severity: 'violation', ruleId: 'ARC-D01', discipline: 'architecture', storey: st,
      message: `slot ${slot.id} (${slot.moduleId}) instantiated at ${round(net.w, 2)} × ${round(net.h, 2)} m`,
    });
    return null;
  }

  // ---- layout request ----------------------------------------------------
  const exposures: Partial<Record<Side, Compass>> = {};
  for (const side of slot.exteriorSides) exposures[side] = exposureOf(sideNormal(side), ctx.site.streetFacing);
  const balconySide = oppositeSide(slot.accessSide);
  const balconyDepth = ctx.spec.massing.balconyDepth ?? 0;
  const balRectPlanned = balconyRect(net, balconySide, balconyDepth);
  const wantBalcony = f.balconies
    && balconyDepth > 0.5
    && slot.exteriorSides.includes(balconySide)
    && level === levelsTotal - 1
    && balconyIsClear(args, slot, balRectPlanned);

  const horizontal = slot.accessSide === 'front' || slot.accessSide === 'rear';
  const frontage = horizontal ? net.w : net.h;
  const netDepth = horizontal ? net.h : net.w;
  // the stack is an OUTPUT port of the module, resolved to world XY by the packer. Passing its offset instead of an
  // imposed coordinate is what makes identical modules stack vertically without anyone remembering a number.
  const stackPort = slot.ports.find(p => p.kind === 'stack');
  const stackAlong = stackPort
    ? round(Math.max(0.3, Math.min(frontage - 0.3, stackPort.along - (horizontal ? net.x : net.y))), 3)
    : undefined;
  const fit = args.fitFor?.(slot.moduleId, frontage, netDepth, level) ?? undefined;
  // the fork label carries the module, the slot and the edit hash, so an edited unit re-solves and its untouched
  // twins stay bit-identical
  const editHash = slot.edits && slot.edits.length > 0 ? hashUnitEdits(slot.edits) : '0';

  const req: UnitLayoutRequest = {
    unitId: id,
    template,
    rect: net,
    storey: st,
    level,
    levelsTotal,
    accessSide: slot.accessSide,
    exteriorSides: slot.exteriorSides,
    exposures,
    boundaryWalls,
    floorToFloor: f.floorToFloor,
    ceilingHeight: f.ceilingHeight,
    wwr: f.wwr,
    balcony: wantBalcony ? { side: balconySide, depth: balconyDepth } : null,
    region: ctx.spec.region,
    options: ctx.spec.options,
    rng: ctx.rng.fork(`unit:${slot.moduleId}:${slot.id}:${level}:${editHash}`),
    wetWallSide: slot.accessSide,
    stackAlong,
    stairRect: slot.stairRect,
    // ---- v2: module identity, program, witness and edits -----------------
    moduleId: slot.moduleId,
    program: args.programFor?.(slot.moduleId),
    fit,
    mirrored: slot.mirrored,
    gridLinesLocal: slot.partyLines.filter(pl => pl.column).map(pl => round(pl.at - (horizontal ? slot.boundary.x : slot.boundary.y), 3)),
    edits: slot.edits,
  };

  let layout;
  try {
    layout = deps.layoutUnit(req);
  } catch (err) {
    b.warn(`layoutUnit failed for ${id} (${slot.moduleId}): ${(err as Error).message}`);
    return null;
  }

  // ---- merge -------------------------------------------------------------
  const roomIds: string[] = [];
  for (const r of layout.rooms) {
    r.storey = st;
    r.unitId = id;
    if (!r.rect || r.rect.w === 0) r.rect = polygonBounds(r.polygon);
    if (!r.area) r.area = round(polygonArea(r.polygon), 3);
    if (!r.height) r.height = f.ceilingHeight;
    b.rooms.push(r);
    roomIds.push(r.id);
  }
  for (const w of layout.walls) {
    w.storey = st;
    w.unitId = id;
    if (!w.height) w.height = f.wallHeight;
    b.adoptWall(w);
  }
  const knownWalls = new Set<string>([...layout.walls.map(w => w.id), ...Object.values(wallBySide).map(w => w!.id)]);
  for (const d of layout.doors as DoorDef[]) {
    d.storey = st;
    d.unitId = id;
    if (!knownWalls.has(d.wallId)) {
      b.warn(`unit ${id}: door ${d.id} hosted in unknown wall ${d.wallId} — dropped`);
      continue;
    }
    b.doors.push(d);
  }
  for (const w of layout.windows as WindowDef[]) {
    w.storey = st;
    w.unitId = id;
    if (!knownWalls.has(w.wallId)) {
      b.warn(`unit ${id}: window ${w.id} hosted in unknown wall ${w.wallId} — dropped`);
      continue;
    }
    b.windows.push(w);
  }
  if (ctx.spec.options.furniture) {
    for (const fu of layout.furniture as FurnitureDef[]) {
      fu.storey = st;
      fu.unitId = id;
      b.furniture.push(fu);
    }
  }
  for (const p of layout.patterns) b.apply({ ...p, unitId: id, storey: st });
  for (const wmsg of layout.warnings) b.warn(`unit ${id}: ${wmsg}`);

  // internal stair for a multi-level dwelling
  if (layout.stair) {
    const s = layout.stair;
    const total = Math.max(2, s.risers);
    b.stairs.push({
      id: b.ids.next(st, 'STR'), coreId: '', storey: st,
      position: [round(s.position[0]), round(s.position[1])], direction: s.direction,
      risers: total, riserHeight: s.riserHeight, tread: s.tread, width: s.width,
      flights: 1, landingRect: s.rect, isExit: false,
    });
    b.stairRuns.push({
      id: b.ids.next(st, 'FLIGHT'), stairId: `${id}-STAIR`, coreId: '', storey: st,
      position: s.position, direction: s.direction, risers: total, riserHeight: s.riserHeight,
      tread: s.tread, width: s.width, z: 0, isExit: false,
    });
  }

  // extra organiser-owned doors (garage, private stair)
  const extraDoorIds: string[] = [];
  for (const ed of slot.extraDoors ?? []) {
    const host = wallBySide[ed.side];
    if (!host) continue;
    const len = dist(host.start, host.end);
    const motion: DoorDef['motion'] = ed.type === 'garage' ? 'rolling' : 'swing';
    const served = roomOnWall(layout.rooms, host, ed.type === 'garage' ? ['garage'] : ['entry', 'hall'], ed.width);
    const wanted = ed.offset ?? alongInWall(host, served?.rect ?? net, ed.width);
    const along = clamp(wanted, ed.width / 2 + 0.3, len - ed.width / 2 - 0.3);
    const sol = solveSwing({
      wall: host, along, width: ed.width, motion,
      into: reachRect(served?.rect ?? net, host),
    });
    const d = b.addDoor({
      storey: st, wallId: host.id, along, width: ed.width, height: ed.height, type: ed.type,
      motion, hinge: sol.hinge, swing: sol.swing,
      ...(motion === 'swing' && served ? { swingIntoRoomId: served.id, toRoomId: served.id } : {}),
      unitId: id,
    });
    extraDoorIds.push(d.id);
    if (ed.type === 'garage') {
      b.apply({ patternId: 'ARC-11', storey: st, unitId: id, elementIds: [d.id], params: { garageDoorWidth: ed.width, garageDoorHeight: ed.height } });
    }
  }

  // ---- balcony -----------------------------------------------------------
  let balconyRoomId = layout.balconyRoomId;
  if (wantBalcony) {
    const balRect = balRectPlanned;
    if (!balconyRoomId) {
      const room = b.addRoom({
        storey: st, type: 'balcony', rect: balRect, unitId: id, height: f.ceilingHeight,
        name: 'Balcony', zone: 'outdoor',
      });
      balconyRoomId = room.id;
      roomIds.push(room.id);
      const host = wallBySide[balconySide];
      if (host) {
        // hang the slider where the room behind the wall actually is, not at the wall midpoint
        const served = roomOnWall(layout.rooms, host, ['living', 'living-kitchen', 'dining', 'bedroom', 'master-bedroom'], 1.6);
        const along = round(alongInWall(host, served?.rect ?? net, 1.6));
        const sol = solveSwing({
          wall: host, along, width: 1.6, motion: 'sliding', into: reachRect(served?.rect ?? net, host),
        });
        b.addDoor({
          storey: st, wallId: host.id, along, width: 1.6,
          height: 2.2, type: 'balcony', motion: 'sliding', hinge: sol.hinge, swing: sol.swing,
          unitId: id, toRoomId: room.id, fromRoomId: served?.id, ref: 'balcony',
        });
      }
    }
    const balDef: BalconyDef = {
      id: b.ids.next(st, 'BALC'), storey: st, unitId: id, rect: balRect, roomId: balconyRoomId ?? '',
    };
    b.balconies.push(balDef);
    /*
     * STR-C5: a cantilever is sized from its PROJECTION, never from a constant — thickness ≥ max(0.18, L/10)
     * (ACI 318-19 Table 9.3.1.1, Eurocode 2 §7.4.2). The two numbers are not rule records yet (`STR-C5` carries the
     * backspan ratio), so they live here as the constants the structure agent specified.
     */
    const BALCONY_MIN_T = 0.18;
    const BALCONY_DEPTH_RATIO = 10;
    const balProj = balRect.w >= balRect.h ? balRect.h : balRect.w;
    const balT = round(Math.max(BALCONY_MIN_T, balProj / BALCONY_DEPTH_RATIO), 3);
    slabElement(b, st, balRect, balT, -balT, 'FLOOR', 'Balcony slab', ['ARC-05', 'STR-C5'], id);
    const e = rectEdges(balRect);
    for (const side of ['front', 'rear', 'left', 'right'] as Side[]) {
      if (side === oppositeSide(balconySide)) continue;
      railingElement(b, st, e[side].a, e[side].b, 1.1, 0, ['ARC-05']);
    }
  }

  // ---- unit instance -----------------------------------------------------
  const rooms = layout.rooms;
  const netArea = round(rooms.filter(r => r.type !== 'balcony' && r.type !== 'terrace').reduce((s, r) => s + r.area, 0) || net.w * net.h, 2);
  const aspect = aspectOf(slot.exteriorSides);
  if (existing) {
    existing.storeys = [...new Set([...existing.storeys, st])];
    existing.area = round(existing.area + netArea, 2);
    existing.roomIds.push(...roomIds);
    existing.wetWallIds.push(...layout.wetWallIds);
    existing.bathroomRoomIds.push(...layout.bathroomRoomIds);
    if (!existing.kitchenRoomId) existing.kitchenRoomId = layout.kitchenRoomId;
    if (!existing.balconyRoomId) existing.balconyRoomId = balconyRoomId;
    // Upper levels of a maisonette contribute their own ports (a second stack, its own extract). The layout numbers
    // them from 1 per level, so they are renumbered here to stay unique within the dwelling.
    if (layout.stackPorts?.length) {
      const base = existing.stackPorts ?? [];
      existing.stackPorts = [...base, ...layout.stackPorts.map((s, i) => ({ ...s, id: `stack.${base.length + i + 1}` }))];
    }
    if (layout.exhaustPorts?.length) {
      const base = existing.exhaustPorts ?? [];
      existing.exhaustPorts = [...base, ...layout.exhaustPorts.map((e, i) => ({ ...e, id: `exhaust.${base.length + i + 1}` }))];
    }
    if (!existing.panelPort && layout.panelPort) existing.panelPort = layout.panelPort;
    return existing;
  }
  const inst: UnitInstance = {
    id,
    templateId,
    storeys: slot.storeySpan ?? [st],
    rect: slot.boundary,
    polygon: rectToPolygon(slot.boundary),
    area: netArea,
    bedrooms: template.bedrooms,
    bathrooms: template.bathrooms,
    occupants: template.occupants,
    aspect,
    accessSide: slot.accessSide,
    entryDoorId: layout.entryDoorId || extraDoorIds[0] || '',
    roomIds,
    wetWallIds: [...layout.wetWallIds],
    kitchenRoomId: layout.kitchenRoomId,
    bathroomRoomIds: [...layout.bathroomRoomIds],
    balconyRoomId,
    barId: slot.barId,
    coreId: slot.coreId,
    // v2 ports: outputs of the unit layout, consumed by plumbing (chase/stacks), mechanical (extract) and electrical
    stackPorts: layout.stackPorts ? [...layout.stackPorts] : undefined,
    exhaustPorts: layout.exhaustPorts ? [...layout.exhaustPorts] : undefined,
    panelPort: layout.panelPort ?? undefined,
    // v2 module/placer identity: what the editor selects by and what the mix report is computed from
    moduleId: slot.moduleId,
    slotId: slot.id,
    mirrored: slot.mirrored,
    layoutKey: `${slot.moduleId}|${Math.round(frontage * 100)}|${Math.round(netDepth * 100)}|${level}|${editHash}`,
    partyLines: [{ ...slot.partyLines[0] }, { ...slot.partyLines[1] }],
    roomGraph: layout.graph,
  };
  if (!inst.entryDoorId) {
    const host = wallBySide[slot.accessSide];
    if (host) {
      const served = roomOnWall(layout.rooms, host, ['entry', 'hall', 'corridor', 'living-kitchen', 'living'], SIZES.doorUnitEntry);
      const along = round(alongInWall(host, served?.rect ?? net, SIZES.doorUnitEntry));
      const sol = solveSwing({
        wall: host, along, width: SIZES.doorUnitEntry, motion: 'swing',
        into: reachRect(served?.rect ?? net, host),
      });
      const d = b.addDoor({
        storey: st, wallId: host.id, along, width: SIZES.doorUnitEntry,
        height: SIZES.doorHeight, type: 'unit-entry', motion: 'swing', hinge: sol.hinge, swing: sol.swing,
        swingIntoRoomId: served?.id, unitId: id,
        fireRated: true, toRoomId: served?.id ?? roomIds[0], ref: 'entry',
      });
      inst.entryDoorId = d.id;
      b.warn(`unit ${id}: layout returned no entry door — organiser inserted ${d.id}`);
    } else {
      b.warn(`unit ${id}: no entry door and no wall on the access side ${slot.accessSide}`);
    }
  }
  b.units.push(inst);
  args.unitRegistry.set(slotKey, inst);
  return inst;
}

/**
 * The room an organiser-owned door opens into: an interior room that RUNS ALONG the host wall (within 0.35 m of it
 * and overlapping it by at least a leaf), preferring the types in `prefer`, then the longest overlap. The door is
 * then hung inside that room's span with `alongInWall` and its swing solved against that room's rect, so the leaf
 * lands on its floor instead of in the corridor or over a balcony.
 */
function roomOnWall(rooms: readonly RoomDef[], wall: WallDef, prefer: readonly RoomType[], width: number): RoomDef | null {
  const dx = wall.end[0] - wall.start[0];
  const dy = wall.end[1] - wall.start[1];
  const len = Math.hypot(dx, dy) || 1;
  const dir: Vec2 = [dx / len, dy / len];
  const nrm: Vec2 = [-dir[1], dir[0]];
  let best: { room: RoomDef; rank: number; overlap: number } | null = null;
  for (const r of rooms) {
    if (r.type === 'balcony' || r.type === 'terrace') continue;
    const corners: Vec2[] = [
      [r.rect.x, r.rect.y], [r.rect.x + r.rect.w, r.rect.y],
      [r.rect.x + r.rect.w, r.rect.y + r.rect.h], [r.rect.x, r.rect.y + r.rect.h],
    ];
    let lo = Infinity;
    let hi = -Infinity;
    let perp = Infinity;
    for (const c of corners) {
      const t = (c[0] - wall.start[0]) * dir[0] + (c[1] - wall.start[1]) * dir[1];
      lo = Math.min(lo, t);
      hi = Math.max(hi, t);
      perp = Math.min(perp, Math.abs((c[0] - wall.start[0]) * nrm[0] + (c[1] - wall.start[1]) * nrm[1]));
    }
    const overlap = Math.min(hi, len) - Math.max(lo, 0);
    if (perp > 0.35 || overlap < width + 0.2) continue;
    const rank = prefer.indexOf(r.type) >= 0 ? prefer.indexOf(r.type) : prefer.length;
    if (!best || rank < best.rank || (rank === best.rank && overlap > best.overlap + 1e-9)) {
      best = { room: r, rank, overlap };
    }
  }
  return best?.room ?? null;
}

/**
 * A balcony may only project into open air: in a courtyard or L/U plan the face opposite the access
 * can look straight at the next bar, and a balcony there would land inside someone's living room.
 */
function balconyIsClear(args: InstantiateArgs, slot: Slot, bal: Rect): boolean {
  /*
   * The probe is the balcony GROWN to the full width of its unit, not the 0.3 m inset rect the organiser plans:
   * the unit solver places its own balcony room from `req.balcony.side/depth` and need not adopt that inset, so a
   * clearance test on the inset rect lets a balcony clip the resident-storage pocket beside a core by 50 mm.
   */
  const pad = 0.35;
  const wide = bal.w >= bal.h;
  const probe = {
    x: wide ? bal.x - pad : bal.x + 0.01,
    y: wide ? bal.y + 0.01 : bal.y - pad,
    w: Math.max(0.05, wide ? bal.w + 2 * pad : bal.w - 0.02),
    h: Math.max(0.05, wide ? bal.h - 0.02 : bal.h + 2 * pad),
  };
  for (const other of args.layout.slots) {
    if (other === slot) continue;
    if (rectsOverlap(probe, other.boundary, 0)) return false;
  }
  for (const c of args.layout.corridorSlots ?? []) if (!c.external && rectsOverlap(probe, c.rect, 0)) return false;
  for (const c of args.layout.commons) if (rectsOverlap(probe, c.rect, 0)) return false;
  for (const c of args.cores) {
    if (rectsOverlap(probe, c.rect, 0)) return false;
    if (c.shaftBlock && rectsOverlap(probe, c.shaftBlock, 0)) return false;
  }
  /*
   * A courtyard or L/U plan puts two bars face to face: both sets of dwellings have the courtyard as their
   * access-opposite face, so both would project a balcony into it and the two would MEET in the middle of a narrow
   * court. Another bar's own balcony zone — its rect grown by this projection — is therefore not open air either.
   */
  const proj = Math.min(bal.w, bal.h);
  for (const fr of args.f.bars) {
    if (fr.barId === slot.barId) continue;
    const r = rectFromAC(fr, fr.a0, fr.a1, fr.c0, fr.c1);
    const grown = { x: r.x - proj, y: r.y - proj, w: r.w + 2 * proj, h: r.h + 2 * proj };
    if (rectsOverlap(probe, grown, 0)) return false;
  }
  const site = polygonBounds(args.ctx.site.boundary);
  if (!rectContainsRect(site, probe, 0.5)) return false;
  return true;
}

function extensionsFor(slot: Slot, side: Side): { s: number; e: number } {
  const horizontal = side === 'front' || side === 'rear';
  const atA0: Side = horizontal ? 'left' : 'front';
  const atA1: Side = horizontal ? 'right' : 'rear';
  return {
    s: (slot.sides[atA0]?.thickness ?? 0) / 2,
    e: (slot.sides[atA1]?.thickness ?? 0) / 2,
  };
}

function balconyRect(net: Rect, side: Side, depth: number): Rect {
  const inset = 0.3;
  switch (side) {
    case 'front': return { x: round(net.x + inset), y: round(net.y - depth), w: round(Math.max(1, net.w - 2 * inset)), h: round(depth) };
    case 'rear': return { x: round(net.x + inset), y: round(net.y + net.h), w: round(Math.max(1, net.w - 2 * inset)), h: round(depth) };
    case 'left': return { x: round(net.x - depth), y: round(net.y + inset), w: round(depth), h: round(Math.max(1, net.h - 2 * inset)) };
    default: return { x: round(net.x + net.w), y: round(net.y + inset), w: round(depth), h: round(Math.max(1, net.h - 2 * inset)) };
  }
}

export function aspectOf(sides: Side[]): 'single' | 'dual' | 'corner' {
  const set = new Set(sides);
  if (set.size >= 3) return 'corner';
  if (set.size === 2) {
    const [a, c] = [...set];
    return oppositeSide(a) === c ? 'dual' : 'corner';
  }
  return 'single';
}

export type { FloorCtx, FloorLayout, Slot, CommonRoomSlot, CorridorSlot };
export { rectToPolygon };
