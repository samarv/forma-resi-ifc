/**
 * Cores and shafts — pattern ARC-04 (Core as Anchor) and ARC-32 / XD-04 (Shafts Beside Cores).
 *
 * Every `CorePlacement` from the massing becomes ONE `CoreLayout`, computed once for the whole
 * building so that the core repeats identically on every storey (ARC-08). The layout subdivides
 * the placement rect into a scissor-free dog-leg stair, a lift bank and a lift lobby, and reserves
 * a shaft bay immediately beside the core along the bar (combined M/E riser + refuse chute, with
 * the remainder of the bay becoming resident storage).
 */
import type {
  AccessType, BuildingSpec, Compass, CorePlacement, CoreDef, ElevatorDef, MassingBar, Rect, ShaftDef,
  Side, StoreyDef, Vec2, WallDef,
} from '../../core/types.ts';
import { SIZES } from '../../core/coordination.ts';
import { exposureOf, inset, rectEdges, rectsOverlap, round, sideNormal } from '../../core/geometry.ts';
import { alongInWall, reachRect, solveSwing } from '../../core/openings.ts';
import { barFrame, rectFromAC, alongRange, acrossRange, sideSpan, type BarFrame, type Interval } from './bar-frame.ts';
import type { CoreModule, ModuleCatalogue } from '../../modules/types.ts';
import type { StructuralPresize } from '../structure/presize.ts';
import { pickCoreModule } from '../../modules/core-modules.ts';
import { ArchBuilder, railingElement, liftCarElement } from './arch-elements.ts';
import type { FloorCtx } from './types-internal.ts';

/** The subset of `EnvelopeBuilder` the core builder needs (avoids an import cycle) */
export interface EnvelopeLookup {
  wallFor(side: Side, across: number, a0: number, a1: number): WallDef | undefined;
}

export interface StairGeom {
  rect: Rect;
  /** World axis the flights run along */
  runAxis: 'x' | 'y';
  laneSpan: number;
  width: number;
}

export interface CoreLayout {
  id: string;
  placement: CorePlacement;
  /** the `CoreModule` this core was built from (stair configuration, lifts, purpose-tagged shaft slots) */
  module: CoreModule | null;
  /** the three purpose-tagged shaft rects plus the refuse chute, in the bay beside the core */
  shaftRects: { purpose: ShaftDef['purpose']; rect: Rect }[];
  /** Gross rect — wall centrelines lie on these edges */
  rect: Rect;
  /** Net rect inside the core walls */
  net: Rect;
  barId: string;
  stair: StairGeom;
  liftBank: Rect | null;
  liftRects: Rect[];
  lobby: Rect | null;
  /** Shaft bay beside the core (gross) */
  shaftBlock: Rect | null;
  combinedShaft: Rect | null;
  trashShaft: Rect | null;
  storage: Rect | null;
  /** Side of the core rect that faces the corridor / building interior */
  corridorSide: Side;
  /** Sides of the core rect that sit on the building envelope */
  exteriorSides: Side[];
  /** Along-interval (bar frame) blocked by core + shaft bay */
  blocked: Interval;
  storeys: string[];
  elevatorCount: number;
  /** Building-wide defs */
  coreDef: CoreDef;
  elevatorDefs: ElevatorDef[];
  shaftDefs: ShaftDef[];
  frame: BarFrame;
}

const LANDING_MIN = 1.1;
const LIFT_SLICE = 2.3;

export interface PlanCoresOpts {
  /** the module catalogue: the core's stair run, lift bank and shaft slots come from its `CoreModule` */
  catalogue?: ModuleCatalogue;
  /** the single owner of `coreWallT` and the slab thicknesses */
  presize?: StructuralPresize | null;
}

export function planCores(
  b: ArchBuilder,
  placements: CorePlacement[],
  bars: MassingBar[],
  storeys: StoreyDef[],
  spec: BuildingSpec,
  access: AccessType = 'corridor-double',
  o: PlanCoresOpts = {},
): CoreLayout[] {
  const coreWallT = o.presize?.coreWallT ?? SIZES.coreWallT;
  const barById = new Map(bars.map(bar => [bar.id, bar] as const));
  const buildingStoreys = storeys.filter(s => s.index >= 0 && s.index < 100).map(s => s.id);
  const allStoreys = storeys.filter(s => s.index > -100 && s.index < 100).map(s => s.id);
  const out: CoreLayout[] = [];

  for (const p of placements) {
    const bar = barById.get(p.barId) ?? bars[0];
    if (!bar) continue;
    const frame = barFrame(bar);
    // The site now sizes CorePlacement.rect to INCLUDE the 2.4 m service-shaft bay along the bar
    // (5.0 m for a stair/lift core, 11.4 m for a point core). Carve that bay out of the placement
    // instead of reserving a second one outside it (which charged dwellings twice). Legacy 2.6 m
    // rects (no room left for a bay) fall back to the external bay below.
    const BAY_LEN = 2.4;
    const along0 = alongRange(frame, p.rect);
    const across0 = acrossRange(frame, p.rect);
    let rect = p.rect;
    let innerBay: Interval | null = null;
    if (along0.e - along0.s - BAY_LEN >= 2.55) {
      const towardCentre0 = along0.s - frame.a0 < frame.a1 - along0.e ? 1 : -1;
      const coreS = towardCentre0 > 0 ? along0.s : along0.s + BAY_LEN;
      const coreE = towardCentre0 > 0 ? along0.e - BAY_LEN : along0.e;
      rect = rectFromAC(frame, coreS, coreE, across0.s, across0.e);
      innerBay = towardCentre0 > 0 ? { s: coreE, e: along0.e } : { s: along0.s, e: coreS };
    }
    const net = inset(rect, coreWallT / 2);
    if (net.w < 2.0 || net.h < 2.0) {
      b.warn(`core ${p.id} rect ${fmtRect(rect)} is too small to hold a stair — skipped`);
      continue;
    }

    // ---- which side faces the corridor / interior of the bar --------------
    const cAcross = acrossRange(frame, rect);
    const barAcross: Interval = { s: frame.c0, e: frame.c1 };
    const spansDepth = cAcross.s <= barAcross.s + 0.6 && cAcross.e >= barAcross.e - 0.6;
    const towardHigh = (cAcross.s + cAcross.e) / 2 < (barAcross.s + barAcross.e) / 2;
    const lowRoom = cAcross.s - barAcross.s;
    const highRoom = barAcross.e - cAcross.e;
    let corridorSide: Side = spansDepth
      ? frame.endSide
      : towardHigh ? frame.highSide : frame.lowSide;
    if (access === 'gallery' || access === 'corridor-single') {
      // the deck / single-loaded corridor is on the face the core touches
      if (lowRoom < 0.4) corridorSide = frame.lowSide;
      else if (highRoom < 0.4) corridorSide = frame.highSide;
    } else if (access === 'stair-core') {
      // the lift lobby must open onto the landing, which takes the deeper side
      corridorSide = lowRoom >= highRoom ? frame.lowSide : frame.highSide;
    } else if (access === 'point-core' || p.type === 'point-core') {
      corridorSide = frame.lowSide;
    }

    const exteriorSides: Side[] = [];
    if (cAcross.s <= barAcross.s + 0.35) exteriorSides.push(frame.lowSide);
    if (cAcross.e >= barAcross.e - 0.35) exteriorSides.push(frame.highSide);
    const cAlong = alongRange(frame, rect);
    if (cAlong.s <= frame.a0 + 0.35) exteriorSides.push(frame.startSide);
    if (cAlong.e >= frame.a1 - 0.35) exteriorSides.push(frame.endSide);

    // ---- subdivide: stair | lift bank | lift lobby ------------------------
    const axis: 'x' | 'y' = net.w >= net.h ? 'x' : 'y';
    const cf = { long: axis === 'x' ? net.w : net.h, short: axis === 'x' ? net.h : net.w };
    const slice = (s: number, len: number): Rect => axis === 'x'
      ? { x: round(net.x + s), y: round(net.y), w: round(len), h: round(net.h) }
      : { x: round(net.x), y: round(net.y + s), w: round(net.w), h: round(len) };

    /*
     * The stair run comes from the CORE MODULE (`catalogue.coreFootprintAt`), which sizes it from the floor-to-floor
     * once: risers(f2f) × tread + landings across the bar, flights + lift bank + lobby along it. The placer asked the
     * same function for the footprint BEFORE it packed, so "core spacing leaves only N m per landing side" and "core
     * is only N m wide internally" have nothing left to report — the reservation and the build agree by construction.
     */
    const f2fMax = Math.max(spec.massing.floorToFloor ?? 3, spec.massing.groundFloorToFloor ?? 3);
    const wantLift = p.hasElevator && p.elevatorCount > 0;
    const mod = o.catalogue
      ? pickCoreModule(o.catalogue.cores, wantLift ? Math.max(1, p.elevatorCount) : 0, p.type === 'scissor-stair') ?? null
      : null;
    const foot = mod && o.catalogue ? o.catalogue.coreFootprintAt(mod.id, f2fMax) : null;
    const runNeed = foot
      ? foot.across
      : round(Math.ceil(Math.ceil(f2fMax / 0.175) / 2) * SIZES.stairTreadMin + LANDING_MIN + 0.1, 3);
    const runAcross = cf.short >= runNeed;
    let stairSliceLen = runAcross
      ? (mod ? Math.max(2.4, 2 * mod.stairWidth + 0.1) : 2.4)
      : Math.max(runNeed, 3.0);
    let liftSliceLen = wantLift ? LIFT_SLICE : 0;
    if (stairSliceLen + liftSliceLen > cf.long - 0.2) {
      // shrink the lift bank first, then the stair
      liftSliceLen = Math.max(0, Math.min(liftSliceLen, cf.long - stairSliceLen - 0.2));
      if (stairSliceLen > cf.long) {
        stairSliceLen = cf.long;
        liftSliceLen = 0;
      }
    }
    const lobbyLen = Math.max(0, cf.long - stairSliceLen - liftSliceLen);

    const stairRect = slice(0, stairSliceLen);
    const liftBank = liftSliceLen > 1.4 ? slice(stairSliceLen, liftSliceLen) : null;
    const lobby = lobbyLen >= 1.2 ? slice(stairSliceLen + liftSliceLen, lobbyLen) : null;
    if (!lobby && !liftBank) {
      // everything went to the stair; acceptable for a pure stair core
    }

    // lift cars across the bank
    const liftRects: Rect[] = [];
    let elevatorCount = 0;
    if (liftBank) {
      const bankAcross = axis === 'x' ? liftBank.h : liftBank.w;
      const maxCars = Math.max(1, Math.floor(bankAcross / (SIZES.elevatorShaftW - 0.05)));
      elevatorCount = Math.max(1, Math.min(p.elevatorCount || 1, maxCars));
      const carW = Math.min(SIZES.elevatorShaftW, bankAcross / elevatorCount);
      for (let i = 0; i < elevatorCount; i++) {
        liftRects.push(axis === 'x'
          ? { x: liftBank.x, y: round(liftBank.y + i * carW), w: liftBank.w, h: round(carW) }
          : { x: round(liftBank.x + i * carW), y: liftBank.y, w: round(carW), h: liftBank.h });
      }
    }

    const stair: StairGeom = stairGeomFor(stairRect, runAcross ? (axis === 'x' ? 'y' : 'x') : axis);

    // ---- shaft bay beside the core along the bar --------------------------
    const nStoreys = spec.massing.storeys;
    const bayLen = BAY_LEN;
    const towardCentre = cAlong.s - frame.a0 < frame.a1 - cAlong.e ? 1 : -1;
    const bayA0 = innerBay ? innerBay.s : towardCentre > 0 ? cAlong.e : cAlong.s - bayLen;
    const bayA1 = innerBay ? innerBay.e : bayA0 + bayLen;
    const fits = innerBay !== null || (bayA0 >= frame.a0 - 0.01 && bayA1 <= frame.a1 + 0.01);
    let shaftBlock: Rect | null = null;
    let combinedShaft: Rect | null = null;
    let trashShaft: Rect | null = null;
    let storage: Rect | null = null;
    const shaftRects: { purpose: ShaftDef['purpose']; rect: Rect }[] = [];
    if (fits) {
      const bayC0 = cAcross.s, bayC1 = cAcross.e;
      shaftBlock = rectFromAC(frame, bayA0, bayA1, bayC0, bayC1);
      // corridor end of the bay: the across end nearest the corridor side
      const atHigh = corridorSide === frame.highSide;
      const cStart = atHigh ? bayC1 : bayC0;
      const sgn = atHigh ? -1 : 1;
      const bayLenAlong = bayA1 - bayA0;
      const bayLenAcross = Math.abs(bayC1 - bayC0);
      /*
       * THREE PURPOSE-TAGGED SLOTS plus the refuse chute, at the fractions the `CoreModule` declares (design §2.3).
       * v1 cut one 'combined' riser and left plumbing, mechanical and electrical to share it by three different
       * conventions; each discipline now has a rect of its own, in a fixed order, in the same bay.
       */
      const slots = mod
        ? mod.shaftSlots
        : [{ purpose: 'combined' as ShaftDef['purpose'], atFrac: 0.27, wFrac: 0.5, dFrac: 0.34 },
          { purpose: 'trash' as ShaftDef['purpose'], atFrac: 0.77, wFrac: 0.42, dFrac: 0.42 }];
      let deepest = 0;
      for (const sl of slots) {
        if (sl.purpose === 'trash' && nStoreys < 4) continue;
        const len = Math.max(0.45, bayLenAlong * sl.wFrac);
        const a0 = Math.max(bayA0 + 0.05, Math.min(bayA1 - len - 0.05, bayA0 + bayLenAlong * sl.atFrac - len / 2));
        const dep = Math.max(0.8, Math.min(bayLenAcross - 0.3, bayLenAcross * sl.dFrac));
        const c1 = cStart + sgn * dep;
        const rect = rectFromAC(frame, round(a0, 3), round(a0 + len, 3), Math.min(cStart, c1), Math.max(cStart, c1));
        shaftRects.push({ purpose: sl.purpose, rect });
        deepest = Math.max(deepest, dep);
        if (sl.purpose === 'trash') trashShaft = rect;
        else if (!combinedShaft) combinedShaft = rect;
      }
      const rest0 = atHigh ? bayC0 : cStart + deepest + 0.15;
      const rest1 = atHigh ? cStart - deepest - 0.15 : bayC1;
      if (rest1 - rest0 >= 1.6) storage = rectFromAC(frame, bayA0 + 0.1, bayA1 - 0.1, rest0, rest1);
    }

    const blocked: Interval = {
      s: Math.min(cAlong.s, shaftBlock ? bayA0 : cAlong.s),
      e: Math.max(cAlong.e, shaftBlock ? bayA1 : cAlong.e),
    };

    const coreDef: CoreDef = {
      id: b.ids.named('CORE', p.id.replace(/[^A-Za-z0-9]/g, '')),
      rect,
      storeys: allStoreys,
      type: p.type,
      stairIds: [],
      elevatorIds: [],
      roomIds: [],
      isExit: true,
    };
    const elevatorDefs: ElevatorDef[] = liftRects.map((r, i) => ({
      id: b.ids.named('LIFT', p.id.replace(/[^A-Za-z0-9]/g, ''), i + 1),
      coreId: coreDef.id,
      rect: r,
      storeys: allStoreys,
      capacityKg: 1000,
    }));
    coreDef.elevatorIds = elevatorDefs.map(e => e.id);

    const shaftDefs: ShaftDef[] = [];
    const TAG: Record<string, string> = {
      plumbing: 'PLB', mechanical: 'MEC', electrical: 'ELE', trash: 'TRASH', combined: 'ME', elevator: 'LIFT',
    };
    for (const sr of shaftRects) {
      shaftDefs.push({
        id: b.ids.named('SHAFT', p.id.replace(/[^A-Za-z0-9]/g, ''), TAG[sr.purpose] ?? sr.purpose.toUpperCase()),
        rect: sr.rect,
        storeys: buildingStoreys,
        purpose: sr.purpose,
        servesUnitIds: [],
        accessFrom: 'corridor',
      });
    }
    for (const e of elevatorDefs) {
      shaftDefs.push({
        id: b.ids.named('SHAFT', p.id.replace(/[^A-Za-z0-9]/g, ''), `LIFT${e.id.slice(-1)}`),
        rect: e.rect,
        storeys: allStoreys,
        purpose: 'elevator',
        servesUnitIds: [],
        accessFrom: 'core',
      });
    }

    b.cores.push(coreDef);
    b.elevators.push(...elevatorDefs);
    b.shafts.push(...shaftDefs);

    out.push({
      id: coreDef.id, placement: p, module: mod, shaftRects, rect, net, barId: bar.id, stair, liftBank, liftRects, lobby,
      shaftBlock, combinedShaft, trashShaft, storage, corridorSide, exteriorSides, blocked,
      storeys: allStoreys, elevatorCount, coreDef, elevatorDefs, shaftDefs, frame,
    });
  }

  if (out.length > 0) {
    b.apply({
      patternId: 'ARC-04',
      elementIds: out.map(c => c.id),
      params: {
        cores: out.length,
        coreWallThickness: coreWallT,
        fireRating: '2HR',
        liftsTotal: out.reduce((a, c) => a + c.elevatorCount, 0),
      },
      note: 'stair, lift bank, lift lobby and service shafts gathered into one repeating rectangle per core',
    });
    const shaftIds = out.flatMap(c => c.shaftDefs.filter(s => s.purpose !== 'elevator').map(s => s.id));
    if (shaftIds.length > 0) {
      b.apply({
        patternId: 'ARC-32',
        elementIds: shaftIds,
        params: { shaftsPerCore: shaftIds.length / out.length, accessFrom: 'corridor', trashChute: spec.massing.storeys >= 4 },
      });
      b.apply({ patternId: 'XD-04', elementIds: shaftIds, params: { shaftAreaPerUnitServed: 0.12 } });
    }
  }
  return out;
}

function stairGeomFor(rect: Rect, runAxis: 'x' | 'y'): StairGeom {
  const laneSpan = runAxis === 'x' ? rect.h : rect.w;
  const width = Math.min(SIZES.stairWidth, Math.max(0.85, laneSpan / 2 - 0.05));
  return { rect, runAxis, laneSpan, width };
}

// ----------------------------------------------------------------------------
// Per-storey construction
// ----------------------------------------------------------------------------

export function buildCoreOnFloor(
  b: ArchBuilder, core: CoreLayout, f: FloorCtx, streetFacing: Compass, env?: EnvelopeLookup,
  coreWallT: number = SIZES.coreWallT,
): void {
  const st = f.storeyId;
  const h = f.wallHeight;
  const edges = rectEdges(core.rect);
  const perimeter: Partial<Record<Side, WallDef>> = {};
  for (const side of ['front', 'rear', 'left', 'right'] as Side[]) {
    const e = edges[side];
    const isExt = core.exteriorSides.includes(side);
    if (isExt && env) {
      // the envelope already carries this wall; reuse it rather than doubling it up
      const span = sideSpan(core.rect, side);
      const found = env.wallFor(side, span.across, span.a0, span.a1);
      if (found) {
        perimeter[side] = found;
        continue;
      }
    }
    perimeter[side] = b.addWall({
      storey: st,
      start: e.a,
      end: e.b,
      thickness: isExt ? SIZES.exteriorWallT : coreWallT,
      height: h,
      type: isExt ? 'exterior' : 'core',
      isExternal: isExt,
      loadBearingHint: true,
      fireRating: '2HR',
      exposure: isExt ? exposureOf(sideNormal(side), streetFacing) : undefined,
    });
  }

  // --- stair room + flights ------------------------------------------------
  const stairRoom = b.addRoom({
    storey: st, type: 'stair', rect: core.stair.rect, height: f.ceilingHeight,
    name: 'Stair', wallIds: Object.values(perimeter).map(w => w!.id),
  });
  core.coreDef.roomIds.push(stairRoom.id);

  const riserMax = core.module?.riserMax ?? 0.175;
  const total = Math.max(2, Math.ceil(f.floorToFloor / riserMax));
  const riserHeight = round(f.floorToFloor / total, 4);
  const r1 = Math.ceil(total / 2);
  const r2 = total - r1;
  const runAvail = core.stair.runAxis === 'x' ? core.stair.rect.w : core.stair.rect.h;
  let tread: number = core.module?.treadMin ?? SIZES.stairTreadMin;
  let run1 = r1 * tread;
  if (run1 + LANDING_MIN > runAvail) {
    tread = round(Math.max(0.22, (runAvail - LANDING_MIN) / r1), 4);
    run1 = r1 * tread;
    if (tread < SIZES.stairTreadMin - 1e-6) {
      b.warn(`core ${core.id} on ${st}: stair run only ${round(runAvail, 2)} m — tread reduced to ${tread} m (below ${SIZES.stairTreadMin} m minimum)`);
    }
  }
  const landingDepth = round(Math.max(LANDING_MIN, runAvail - run1), 3);
  const w = core.stair.width;
  const sr = core.stair.rect;
  const lane1 = core.stair.runAxis === 'x' ? sr.y + w / 2 : sr.x + w / 2;
  const lane2 = core.stair.runAxis === 'x' ? sr.y + core.stair.laneSpan - w / 2 : sr.x + core.stair.laneSpan - w / 2;
  const p1: Vec2 = core.stair.runAxis === 'x' ? [sr.x, lane1] : [lane1, sr.y];
  const p2: Vec2 = core.stair.runAxis === 'x' ? [sr.x + run1, lane2] : [lane2, sr.y + run1];
  const dir = core.stair.runAxis === 'x' ? 0 : Math.PI / 2;
  const landingRect = core.stair.runAxis === 'x'
    ? { x: round(sr.x + run1), y: sr.y, w: landingDepth, h: sr.h }
    : { x: sr.x, y: round(sr.y + run1), w: sr.w, h: landingDepth };

  const stairDef = {
    id: b.ids.next(st, 'STR'),
    coreId: core.id,
    storey: st,
    position: [round(p1[0]), round(p1[1])] as Vec2,
    direction: dir,
    risers: total,
    riserHeight,
    tread,
    width: w,
    flights: 2 as const,
    landingRect,
    isExit: true,
  };
  b.stairs.push(stairDef);
  core.coreDef.stairIds.push(stairDef.id);
  b.stairRuns.push({
    id: b.ids.next(st, 'FLIGHT'), stairId: stairDef.id, coreId: core.id, storey: st,
    position: p1, direction: dir, risers: r1, riserHeight, tread, width: w, z: 0, isExit: true,
  });
  if (r2 > 0) {
    b.stairRuns.push({
      id: b.ids.next(st, 'FLIGHT'), stairId: stairDef.id, coreId: core.id, storey: st,
      position: p2, direction: dir + Math.PI, risers: r2, riserHeight, tread, width: w,
      z: round(r1 * riserHeight, 4), isExit: true,
    });
  }

  // --- lift shafts ---------------------------------------------------------
  for (let i = 0; i < core.liftRects.length; i++) {
    const r = core.liftRects[i];
    const room = b.addRoom({ storey: st, type: 'elevator', rect: r, height: f.ceilingHeight, name: `Lift ${i + 1} shaft` });
    core.coreDef.roomIds.push(room.id);
    if (i > 0) {
      const prev = core.liftRects[i - 1];
      const vertical = Math.abs(r.x - prev.x) > Math.abs(r.y - prev.y);
      const seg = vertical
        ? { a: [r.x, r.y] as Vec2, b: [r.x, r.y + r.h] as Vec2 }
        : { a: [r.x, r.y] as Vec2, b: [r.x + r.w, r.y] as Vec2 };
      b.addWall({
        storey: st, start: seg.a, end: seg.b, thickness: SIZES.shaftWallT, height: h,
        type: 'shaft', loadBearingHint: false, fireRating: '2HR',
      });
    }
    if (f.storey.index === 0) liftCarElement(b, st, inset(r, 0.2), core.elevatorDefs[i]);
  }

  // --- lift lobby / stair enclosure walls ----------------------------------
  const sliceAxis: 'x' | 'y' = core.net.w >= core.net.h ? 'x' : 'y';
  const wallAcross = (at: number): { start: Vec2; end: Vec2 } => sliceAxis === 'x'
    ? { start: [at, core.net.y], end: [at, core.net.y + core.net.h] }
    : { start: [core.net.x, at], end: [core.net.x + core.net.w, at] };
  const stairEnd = sliceAxis === 'x' ? core.stair.rect.x + core.stair.rect.w : core.stair.rect.y + core.stair.rect.h;
  const stairWall = b.addWall({
    storey: st, ...wallAcross(round(stairEnd)), thickness: coreWallT, height: h,
    type: 'core', loadBearingHint: true, fireRating: '2HR', leftRoomId: stairRoom.id,
  });
  if (core.liftBank) {
    const bankEnd = sliceAxis === 'x' ? core.liftBank.x + core.liftBank.w : core.liftBank.y + core.liftBank.h;
    b.addWall({
      storey: st, ...wallAcross(round(bankEnd)), thickness: SIZES.shaftWallT, height: h,
      type: 'shaft', loadBearingHint: false, fireRating: '2HR',
    });
  }
  let lobbyRoomId: string | undefined;
  if (core.lobby) {
    const room = b.addRoom({ storey: st, type: 'lift-lobby', rect: core.lobby, height: f.ceilingHeight, name: 'Lift Lobby' });
    core.coreDef.roomIds.push(room.id);
    lobbyRoomId = room.id;
  }

  // stair door off the lobby (or straight off the corridor): the leaf sweeps the lift lobby, i.e. in the
  // direction of egress travel out of the stair (IBC 1010.1.2.1). Without a lobby it sweeps the stair landing.
  const doorHost = lobbyRoomId ? stairWall : perimeter[core.corridorSide];
  if (doorHost) {
    const into = lobbyRoomId && core.lobby ? core.lobby : core.stair.rect;
    const along = round(alongInWall(doorHost, into, 0.95));
    const sol = solveSwing({ wall: doorHost, along, width: 0.95, motion: 'swing', into: reachRect(into, doorHost) });
    b.addDoor({
      storey: st, wallId: doorHost.id, along, width: 0.95, height: SIZES.doorHeight,
      type: 'interior', motion: 'swing', hinge: sol.hinge, swing: sol.swing,
      swingIntoRoomId: lobbyRoomId ?? stairRoom.id,
      fromRoomId: lobbyRoomId, toRoomId: stairRoom.id, fireRated: true, ref: 'core.stair-door',
    });
  }
  // lobby opening onto the corridor
  const corridorWall = perimeter[core.corridorSide];
  if (corridorWall && lobbyRoomId && core.lobby) {
    const along = round(alongInWall(corridorWall, core.lobby, 1.4));
    const sol = solveSwing({ wall: corridorWall, along, width: 1.4, motion: 'swing', into: reachRect(core.lobby, corridorWall) });
    b.addDoor({
      storey: st, wallId: corridorWall.id, along, width: 1.4,
      height: SIZES.doorHeight, type: 'interior', motion: 'swing', hinge: sol.hinge, swing: sol.swing,
      swingIntoRoomId: lobbyRoomId, fromRoomId: lobbyRoomId, fireRated: true, ref: 'core.lobby-door',
    });
  }
  // exit door to outside at ground level — swings out, away from the stair (egress direction)
  if (f.storey.index === 0) {
    const extSide = core.exteriorSides[0];
    const host = extSide ? perimeter[extSide] : corridorWall;
    if (host) {
      const along = round(alongInWall(host, core.stair.rect, 1.0));
      // `into` is the stair mirrored across the wall: the leaf sweeps to the OUTSIDE face
      const sol = solveSwing({ wall: host, along, width: 1.0, motion: 'swing', into: reachRect(core.stair.rect, host) });
      b.addDoor({
        storey: st, wallId: host.id, along, width: 1.0,
        height: SIZES.doorHeight, type: 'exit', motion: 'swing',
        hinge: sol.hinge, swing: sol.swing === 'left' ? 'right' : 'left',
        fromRoomId: stairRoom.id, fireRated: true, ref: 'core.exit-door',
      });
    }
  }

  // --- shafts + storage ----------------------------------------------------
  if (core.combinedShaft) {
    const room = b.addRoom({ storey: st, type: 'shaft', rect: core.combinedShaft, height: f.floorToFloor, name: 'Mechanical / Electrical Riser' });
    enclose(b, st, core.combinedShaft, SIZES.shaftWallT, h, 'shaft', room.id, '2HR');
  }
  if (core.trashShaft) {
    const room = b.addRoom({ storey: st, type: 'shaft', rect: core.trashShaft, height: f.floorToFloor, name: 'Refuse Chute' });
    enclose(b, st, core.trashShaft, SIZES.shaftWallT, h, 'shaft', room.id, '2HR');
  }
  if (core.storage && f.isResidential) {
    const room = b.addRoom({ storey: st, type: 'storage', rect: core.storage, height: f.ceilingHeight, name: 'Resident Storage' });
    enclose(b, st, core.storage, SIZES.partitionT, h, 'partition', room.id);
  }
}

/** Four partition/shaft walls around a rect (centrelines on the rect edges) */
export function enclose(
  b: ArchBuilder, storey: string, rect: Rect, thickness: number, height: number,
  type: WallDef['type'], roomId?: string, fireRating?: string,
): WallDef[] {
  const e = rectEdges(rect);
  return (['front', 'right', 'rear', 'left'] as Side[]).map(side => b.addWall({
    storey, start: e[side].a, end: e[side].b, thickness, height, type,
    loadBearingHint: type === 'core' || type === 'shaft', fireRating, leftRoomId: roomId,
  }));
}

/** Cores that sit on the given floor frame (matched by bar id, or geometrically for a plate) */
export function coresFor(cores: CoreLayout[], frame: BarFrame): CoreLayout[] {
  const r = frame.axis === 'x'
    ? { x: frame.a0, y: frame.c0, w: frame.a1 - frame.a0, h: frame.c1 - frame.c0 }
    : { x: frame.c0, y: frame.a0, w: frame.c1 - frame.c0, h: frame.a1 - frame.a0 };
  return cores.filter(c => c.barId === frame.barId || rectsOverlap(r, c.rect, 0.2));
}

/** Along-interval (in `frame`'s terms) taken by the core plus its shaft bay */
export function coreBlockedIn(core: CoreLayout, frame: BarFrame): Interval {
  const a = alongRange(frame, core.rect);
  if (!core.shaftBlock) return { ...a };
  const s = alongRange(frame, core.shaftBlock);
  return { s: Math.min(a.s, s.s), e: Math.max(a.e, s.e) };
}

/** Across-interval (in `frame`'s terms) taken by the core plus its shaft bay */
export function coreAcrossIn(core: CoreLayout, frame: BarFrame): Interval {
  const a = acrossRange(frame, core.rect);
  if (!core.shaftBlock) return { ...a };
  const s = acrossRange(frame, core.shaftBlock);
  return { s: Math.min(a.s, s.s), e: Math.max(a.e, s.e) };
}

function fmtRect(r: Rect): string {
  return `${round(r.w, 2)}x${round(r.h, 2)} at (${round(r.x, 2)},${round(r.y, 2)})`;
}

/** Gallery / deck railing along the outer edge of an external corridor */
export function deckRailing(b: ArchBuilder, storey: string, rect: Rect, outerSide: Side, patterns: string[]): void {
  const e = rectEdges(rect)[outerSide];
  railingElement(b, storey, e.a, e.b, 1.1, 0, patterns);
}

