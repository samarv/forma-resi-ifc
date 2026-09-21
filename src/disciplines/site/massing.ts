/**
 * Site frame (boundary, setbacks, buildable envelope, orientation) and massing
 * (footprint shape → bars → corridors → cores → roof → storeys).
 *
 * Rules implemented here: SIT-01 Setbacks and Yards, SIT-02 Building Faces the Street,
 * SIT-03 Courtyard Which Lives, SIT-04 South-Facing Garden, SIT-05 Back-of-Lot Dwelling,
 * SIT-06 Active Street Wall, SIT-08 Two Ways Out, SIT-09 Bar Depth from Unit Depth.
 *
 * World frame reminder: origin = site front-left corner, +X along the street, +Y from the
 * street into the site. So for any bar, "front" = its min-Y edge and "rear" = its max-Y edge.
 *
 * v2: "resolve, then record" — a resolution (a clipped dimension, a degraded shape, a core that
 * had to move) is an `info` Issue carrying its `ResolutionId`; only a real contradiction (zoning
 * exceeded, travel distance over the limit, exits too close together) stays a `deviation` and so
 * keeps its string in `warnings`. Nothing in this file calls `warnings.push` any more.
 * The corridor topology is owned by `corridor-graph.ts`: `buildMassing` asks it for the spines,
 * the legs, the knuckles and the break slots, and `placeCores` spends cores in those slots first.
 */
import type {
  BuildingSpec, TypologyDef, Rng, Rect, Polygon, Side, Compass, FootprintShape,
  MassingBar, MassingModel, CorePlacement, CorridorSpine, PatternApplication, StoreyDef, AccessType,
  UnitTemplateDef, UnitTemplateId, Vec2,
} from '../../core/types.ts';
import type { RuleSet } from '../../core/rules/types.ts';
import {
  rectToPolygon, rectCenter, rectilinearOutline, insetSides, inset,
  exposureOf, rearExposure, solarScore, compassToRad, polygonCentroid, round,
} from '../../core/geometry.ts';
import { buildStoreys } from '../../core/spec.ts';
import { structuralSystemFor, foundationFor } from '../../core/typologies.ts';
import { SIZES } from '../../core/coordination.ts';
import type { IdFactory } from '../../core/ids.ts';
import { SITE_STOREY } from '../../core/ids.ts';
// Read-only: the dwelling catalogue is architecture's, but the core count, the house count and
// the bar's frontage rhythm are all derived from the SAME unit areas, so both modules must
// read one source of truth (see ARC/SITE coordination note at the top of index.ts).
import { UNIT_TEMPLATES } from '../architecture/templates.ts';
import { clampNum } from './util.ts';
import { RULE, deviation, info, nullSink, ruleNum, travelRule, type IssueSink } from './issues.ts';
import { buildCorridorGraph, coreSlotsOn, resolveDeadEnds, type BreakSlot, type CorridorGraph } from './corridor-graph.ts';

// ---------------------------------------------------------------------------
// Rule constants (see SITE_PATTERNS for provenance)
// ---------------------------------------------------------------------------

/** SIT-03: a courtyard below this clear dimension does not live */
export const MIN_COURTYARD = 15.0;
/** Shortest usable rear wing */
const MIN_WING = 6.0;
/** Shortest usable courtyard opening for a U */
const MIN_U_OPENING = 8.0;
/** SIT-01: envelope below this in either direction is unbuildable */
const MIN_ENVELOPE = 4.0;
/** SIT-08 */
const CORE_END_CLEARANCE = 6.0;
/** Two 1.1 m stair flights side by side, plus the gap between them */
export const CORE_STAIR_BAY = 2.6;
/**
 * XD-04 service shaft bay held INSIDE the core rect, immediately beside the stair along the bar:
 * a combined M/E riser (1.2 × 0.8) and a refuse chute (1.0 × 1.0) with the remainder as resident
 * storage. Reserving it here stops architecture carving it out of a dwelling.
 */
export const CORE_SHAFT_BAY = 2.4;
/** Along-bar width of every core rect: stair bay + shaft bay */
export const CORE_WIDTH_ALONG_BAR = CORE_STAIR_BAY + CORE_SHAFT_BAY;
/**
 * How far a core will move along the bar to land in a corridor break slot: its own width plus a
 * slot. Further than that and the egress geometry (end clearance, exit separation, travel
 * distance) is worth more than the free break, so `alongPositions` wins.
 */
const CORE_SNAP_WINDOW = CORE_WIDTH_ALONG_BAR + 5.0;
/** Lift bank slice across the bar (2 × 2.0 m shafts share the bay width; 2.3 m is the shaft depth) */
const LIFT_BANK_DEPTH = 2.3;
/** Lift lobby in front of the bank / at the head of the stair */
const LIFT_LOBBY_DEPTH = 1.2;
/** Stair geometry: max riser, min tread (mirrors SIZES.stairRiserMax / stairTreadMin) */
const RISER_MAX = 0.175;
const TREAD_MIN = SIZES.stairTreadMin;
/** Half-landing at the turn of a dog-leg */
const STAIR_LANDING = 1.2;
/** Landing beside a stair core, across the bar (mansion blocks get the more generous hall) */
const LANDING_STAIR_CORE = 2.4;
const LANDING_MANSION = 2.6;
const POINT_CORE_W = 9.0;
const POINT_CORE_D = 7.0;
const TRAVEL_SPRINKLERED = 76.0;
const TRAVEL_UNSPRINKLERED = 61.0;
const SINGLE_EXIT_MAX_UNITS = 4;
const SINGLE_EXIT_MAX_STOREYS = 3;
/** SIT-09 sanity band for the implied unit depth */
const UNIT_DEPTH_MIN = 6.5;
const UNIT_DEPTH_MAX = 14.0;
/** SIT-02 nominal frontage of a direct-access dwelling, used only as a last-resort fallback */
export const HOUSE_FRONTAGE = 6.0;
/** Detached double garage bay beside a house (see parking.ts GARAGE_SIDE) */
const GARAGE_BAY = 6.0;
/** GFA per dwelling: 85 m² net + 25% for circulation, walls and cores */
export const GFA_PER_UNIT = 106.25;
/** Both faces of a bar carry a 0.3 m external wall, so a unit strip is barDepth − 0.6 deep */
const EXTERNAL_WALL_PAIR = 2 * SIZES.exteriorWallT;
/** SIT-05 */
const ADU_SEPARATION = 3.0;
export const EXISTING_HOUSE_HEIGHT = 7.0;

// ---------------------------------------------------------------------------
// Stair / core sizing (SIT-08) and the unit mix the counts are derived from
// ---------------------------------------------------------------------------

/**
 * Run of a dog-leg stair ACROSS the bar for the tallest floor-to-floor: half the risers in each
 * flight, so the run is `ceil(risers / 2)` treads plus one half-landing. Rounded up to the 50 mm
 * dimensional module. 3.6 m f2f → 21 risers → 11 × 0.28 + 1.2 = 4.3 m.
 */
export function stairRunFor(floorToFloor: number): number {
  const risers = Math.ceil(Math.max(2.2, floorToFloor) / RISER_MAX);
  const treads = Math.ceil(risers / 2);
  return round(Math.ceil((treads * TREAD_MIN + STAIR_LANDING) / 0.05) * 0.05, 3);
}

/** Depth a core needs ACROSS the bar: dog-leg stair + lift bank + lift lobby (SIT-08) */
export function coreAcrossFor(floorToFloor: number, hasElevator: boolean): number {
  return round(stairRunFor(floorToFloor) + (hasElevator ? LIFT_BANK_DEPTH : 0) + LIFT_LOBBY_DEPTH, 3);
}

/** Tallest floor-to-floor in the building — what the stair has to climb in one flight pair */
function tallestFloorToFloor(spec: BuildingSpec, typology: TypologyDef): number {
  let f2f = Math.max(
    spec.massing.floorToFloor ?? typology.floorToFloor.typical,
    spec.massing.groundFloorToFloor ?? typology.floorToFloor.ground,
  );
  for (const f of spec.floors) {
    if (f.index >= 0 && f.floorToFloor !== undefined) f2f = Math.max(f2f, f.floorToFloor);
  }
  return f2f;
}

interface UnitMix {
  /** Weight-dominant template (ties broken by the larger dwelling) */
  dominant: UnitTemplateDef;
  /** Weighted mean target net internal area (m²) */
  meanArea: number;
}

/**
 * The building's unit mix, resolved exactly the way architecture's `mixPool` resolves it
 * (typology default overlaid by `spec.unitMix`), so both modules count the same dwellings.
 */
function resolveUnitMix(spec: BuildingSpec, typology: TypologyDef): UnitMix {
  const mix: Partial<Record<UnitTemplateId, number>> = { ...(typology.defaultUnitMix ?? {}), ...(spec.unitMix ?? {}) };
  const templates: UnitTemplateDef[] = [];
  const weights: number[] = [];
  for (const id of Object.keys(mix) as UnitTemplateId[]) {
    const w = mix[id];
    const t = UNIT_TEMPLATES[id];
    if (!t || w === undefined || w <= 0) continue;
    templates.push(t);
    weights.push(w);
  }
  if (templates.length === 0) {
    templates.push(UNIT_TEMPLATES['1b1b']);
    weights.push(1);
  }
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const meanArea = templates.reduce((a, t, i) => a + t.area.target * weights[i], 0) / total;
  let di = 0;
  for (let i = 1; i < templates.length; i++) {
    if (weights[i] > weights[di] || (weights[i] === weights[di] && templates[i].area.target > templates[di].area.target)) di = i;
  }
  return { dominant: templates[di], meanArea };
}

/**
 * The narrowest frontage a template tolerates at this depth — the same rule architecture uses
 * (`floor-organizer.minFrontage`): a template's `frontage.min` assumes its own depth band, so a
 * dwelling spanning a deeper bar reaches its area on a proportionally narrower bay.
 */
function minTemplateFrontage(t: UnitTemplateDef, netDepth: number): number {
  const k = clampNum(t.depth.max / Math.max(1, netDepth), 0.45, 1);
  return Math.max(2.6, round(t.frontage.min * k, 3));
}

/** Frontage one dwelling of `t` takes on a `netDepth` deep strip spread over `levels` floors */
function templateFrontage(t: UnitTemplateDef, netDepth: number, levels = 1): number {
  const raw = t.area.target / Math.max(2, netDepth * levels);
  return clampNum(raw, minTemplateFrontage(t, netDepth), t.frontage.max);
}

// ---------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------

export interface SiteFrame {
  boundary: Rect;
  /** Buildable envelope after setbacks (SIT-01) */
  env: Rect;
  setbacks: { front: number; side: number; rear: number };
  streetFacing: Compass;
  /** Rotation (rad, CCW from +Y) of true north in the world frame */
  northRad: number;
  frontExposure: Compass;
  rearExposure: Compass;
  southernHemisphere: boolean;
  /** SIT-04: which yard holds the main garden */
  gardenSide: 'front' | 'rear';
  urban: boolean;
}

/**
 * SIT-01 + SIT-04. Setbacks come from the spec when given, else the typology. If they leave
 * less than MIN_ENVELOPE in either direction they are relaxed proportionally and reported.
 */
export function resolveFrame(
  spec: BuildingSpec,
  typology: TypologyDef,
  sink: IssueSink,
  apps: PatternApplication[],
): SiteFrame {
  const boundary: Rect = { x: 0, y: 0, w: spec.site.width, h: spec.site.depth };
  const over = spec.site.setbacks ?? {};
  let front = Math.max(0, over.front ?? typology.setbacks.front);
  let side = Math.max(0, over.side ?? typology.setbacks.side);
  let rear = Math.max(0, over.rear ?? typology.setbacks.rear);

  // Relax setbacks that would leave nothing to build on.
  if (boundary.w - 2 * side < MIN_ENVELOPE) {
    const relaxed = Math.max(0, (boundary.w - MIN_ENVELOPE) / 2);
    sink.add(info(RULE.setbacks,
      `Side setbacks ${side.toFixed(1)} m leave no buildable width on a ${boundary.w} m frontage; relaxed to ${relaxed.toFixed(1)} m (SIT-01).`,
      { observed: side, limit: relaxed, source: 'SIT-01', resolution: { id: 'clamp', from: round(side), to: round(relaxed) } }));
    side = relaxed;
  }
  if (boundary.h - front - rear < MIN_ENVELOPE) {
    const total = front + rear;
    const budget = Math.max(0, boundary.h - MIN_ENVELOPE);
    const k = total > 0 ? budget / total : 0;
    sink.add(info(RULE.setbacks,
      `Front+rear setbacks ${total.toFixed(1)} m leave no buildable depth on a ${boundary.h} m deep site; scaled to ${(k * 100).toFixed(0)}% (SIT-01).`,
      { observed: round(total), limit: round(budget), source: 'SIT-01', resolution: { id: 'clamp', from: round(total), to: round(budget) } }));
    front = front * k;
    rear = rear * k;
  }

  const env = insetSides(boundary, { front, rear, left: side, right: side });
  const frontExposure = exposureOf([0, -1], spec.site.streetFacing);
  const rearExp = rearExposure(spec.site.streetFacing);
  const southernHemisphere = spec.region === 'AU' || spec.region === 'NZ';
  const frontScore = solarScore(frontExposure, southernHemisphere);
  const rearScore = solarScore(rearExp, southernHemisphere);
  // SIT-04: only direct-access dwellings flip — a block with shared access keeps its street line.
  const flip = typology.access === 'direct' && typology.id !== 'adu-laneway'
    && frontScore - rearScore > 0.2 && front >= 4.5;
  const gardenSide: 'front' | 'rear' = flip ? 'front' : 'rear';

  apps.push({
    patternId: 'SIT-01',
    storey: SITE_STOREY,
    params: {
      front: round(front), side: round(side), rear: round(rear),
      siteArea: round(boundary.w * boundary.h, 1),
      envelopeArea: round(env.w * env.h, 1),
      source: spec.site.setbacks ? 'spec.site.setbacks' : 'typology.setbacks',
    },
  });
  apps.push({
    patternId: 'SIT-04',
    storey: SITE_STOREY,
    params: {
      hemisphere: southernHemisphere ? 'southern' : 'northern',
      frontExposure, rearExposure: rearExp,
      frontScore: round(frontScore, 2), rearScore: round(rearScore, 2),
      gardenSide, flipped: flip,
    },
    note: flip
      ? 'Street side is materially sunnier: building pushed to the rear of the envelope so the main garden faces the sun.'
      : 'Rear (or equal) exposure keeps the garden at the rear and the building on the front build-to line.',
  });

  return {
    boundary, env,
    setbacks: { front, side, rear },
    streetFacing: spec.site.streetFacing,
    northRad: compassToRad(rearExp),
    frontExposure, rearExposure: rearExp,
    southernHemisphere, gardenSide,
    urban: spec.site.context === 'urban',
  };
}

// ---------------------------------------------------------------------------
// Massing
// ---------------------------------------------------------------------------

export interface MassingResult {
  massing: MassingModel;
  /** Bounds of the ground-floor footprint (= podium when there is one) */
  footprintRect: Rect;
  /** Bounds of the typical residential plate (union of `bars`) */
  plateRect: Rect;
  /** Net area of the typical plate (sum of bar areas, so a courtyard is not counted) */
  plateArea: number;
  podiumRect: Rect | null;
  towerRect: Rect | null;
  courtyardRect: Rect | null;
  /** Notional existing house in front of an ADU (SIT-05), else null */
  existingHouseRect: Rect | null;
  travelLimit: number;
  maxTravel: number;
  estimatedUnits: number;
  unitsPerFloor: number;
  /** Total direct-access dwellings (frontage count × stacked levels) */
  dwellings: number;
  /** Direct-access dwellings side by side along the frontage (one front door each) */
  dwellingsAcross: number;
  dwellingFrontage: number;
  /** Dominant unit template the row was sized from, and the unit strip depth it was sized on */
  dwellingTemplate: UnitTemplateId;
  dwellingNetDepth: number;
  impliedUnitDepth: number;
  foundationDepth: number;
  residentialFloors: number;
}

export function buildMassing(
  spec: BuildingSpec,
  typology: TypologyDef,
  frame: SiteFrame,
  rng: Rng,
  ids: IdFactory,
  sink: IssueSink,
  apps: PatternApplication[],
  rules?: RuleSet,
): MassingResult {
  const env = frame.env;
  const storeysAbove = spec.massing.storeys;
  // The typology band is ENFORCED by `normalizeSpec` (clamp, or an explicit
  // `massing.allowStoreyOverride`); reaching here outside the band means the override was asked
  // for (or a hand-built spec skipped normalisation), so it is recorded, not warned about twice.
  if (storeysAbove > typology.storeys.max || storeysAbove < typology.storeys.min) {
    const over = storeysAbove > typology.storeys.max;
    sink.add(deviation(RULE.storeyBand,
      `${storeysAbove} storeys is outside the ${typology.storeys.min}–${typology.storeys.max} storey band for ${typology.name}${spec.massing.allowStoreyOverride ? ' (override requested)' : ''}.`, {
      observed: storeysAbove,
      limit: over ? typology.storeys.max : typology.storeys.min,
      source: 'typology.storeys',
      resolution: over
        ? { id: 'switch-highrise-ruleset', from: typology.storeys.max, to: storeysAbove, note: "rule profile 'high-rise' applied" }
        : { id: 'none', from: typology.storeys.min, to: storeysAbove },
    }));
  }

  // --- depth and length, clipped to the envelope (SIT-09) --------------------
  const requested = spec.massing.footprintShape ?? typology.footprintShapes[0];
  const dims = resolveDims(spec, typology, env);
  const { wantDepth, wantLength, depth, length } = dims;
  let clipped = false;
  if (depth < wantDepth - 1e-6) {
    clipped = true;
    sink.add(info(RULE.buildingSize,
      `Building depth clipped from ${wantDepth.toFixed(1)} m to ${depth.toFixed(1)} m by the buildable envelope (${env.w.toFixed(1)} × ${env.h.toFixed(1)} m).`,
      { observed: round(wantDepth), limit: round(env.h), source: 'SIT-01 envelope', resolution: { id: 'clamp', from: round(wantDepth), to: round(depth) } }));
  }
  if (length < wantLength - 1e-6) {
    clipped = true;
    sink.add(info(RULE.buildingSize,
      `Building length clipped from ${wantLength.toFixed(1)} m to ${length.toFixed(1)} m by the buildable envelope.`,
      { observed: round(wantLength), limit: round(env.w), source: 'SIT-01 envelope', resolution: { id: 'clamp', from: round(wantLength), to: round(length) } }));
  }

  // --- placement in Y (SIT-02 / SIT-04 / SIT-05 / SIT-06) -------------------
  const adu = typology.id === 'adu-laneway';
  let placeY = env.y;
  if (adu) placeY = env.y + Math.max(0, env.h - depth);              // SIT-05: hard to the rear
  else if (frame.gardenSide === 'front') placeY = env.y + Math.max(0, env.h - depth); // SIT-04 flip

  // --- placement in X -------------------------------------------------------
  const dw = houseRow(spec, typology, length, depth, storeysAbove, sink);
  let placeX = env.x + (env.w - length) / 2;
  if (typology.access === 'direct' && dw.count === 1 && typology.parking === 'garage-attached') {
    // A house with a garage hugs one side of the envelope so the bay fits beside it.
    placeX = rng.next() < 0.5 ? env.x : env.x + env.w - length;
  }
  placeX = clampNum(placeX, env.x, env.x + Math.max(0, env.w - length));

  // --- shape decomposition --------------------------------------------------
  const decomposed = decomposeFootprint(requested, env, depth, length, placeX, placeY, rng, sink, apps);
  const shape = decomposed.shape;
  const rects = decomposed.parts.map(p => p.rect);
  const courtyardRect = decomposed.courtyard;

  // The long axis is decided by the decomposition, not by which side happens to be longer:
  // a perimeter-block side wing always runs in +Y even when the courtyard makes it stubby.
  const bars: MassingBar[] = decomposed.parts.map(p => ({
    id: ids.next(SITE_STOREY, 'BAR'),
    rect: p.rect,
    axis: p.axis,
    depth: p.axis === 'x' ? p.rect.h : p.rect.w,
    length: p.axis === 'x' ? p.rect.w : p.rect.h,
    exteriorSides: exteriorSidesOf(p.rect, rects),
  }));
  const plateOutline: Polygon = rectilinearOutline(rects);
  const plateRect = boundsOf(rects);

  // --- podium / tower -------------------------------------------------------
  const podiumStoreys = Math.min(spec.massing.podiumStoreys ?? 0, storeysAbove);
  let podiumRect: Rect | null = null;
  let towerRect: Rect | null = null;
  let footprint: Polygon = plateOutline;
  let footprintRect = plateRect;
  if (podiumStoreys > 0) {
    // Podium fills the envelope; the bars become the tower above it.
    podiumRect = { x: env.x, y: env.y, w: env.w, h: env.h };
    towerRect = plateRect;
    footprint = rectToPolygon(podiumRect);
    footprintRect = podiumRect;
  }

  // --- storeys (foundation depth from the effective foundation type) --------
  const system = structuralSystemFor(typology, storeysAbove);
  const foundation = foundationFor(system, storeysAbove, typology.parking);
  const foundationDepth = foundation === 'piles' || foundation === 'raft' ? 2.0 : 1.2;
  const storeys: StoreyDef[] = buildStoreys(spec, spec.floors, foundationDepth, spec.region);

  // --- GFA and unit estimate ------------------------------------------------
  // Bars never overlap, so their summed area is the net plate area. (polygonArea of the
  // outline would include a courtyard, because rectilinearOutline drops holes.)
  const plateArea = rects.reduce((s, r) => s + r.w * r.h, 0);
  const podiumArea = podiumRect ? podiumRect.w * podiumRect.h : plateArea;
  const { gfa, residentialGfa, residentialFloors } = gfaBreakdown(spec, plateArea, podiumArea, podiumRect ? podiumStoreys : 0);

  const estimatedUnits = typology.access === 'direct'
    ? dw.count
    : Math.max(1, Math.round(residentialGfa / GFA_PER_UNIT));
  const unitsPerFloor = typology.access === 'direct'
    ? dw.count
    : Math.max(1, Math.round(estimatedUnits / Math.max(1, residentialFloors)));

  // --- SIT-09: implied unit depth ------------------------------------------
  const corridorWidth = spec.massing.corridorWidth ?? typology.corridorWidth ?? 1.5;
  const impliedUnitDepth = impliedUnitDepthFor(typology.access, depth, corridorWidth);
  const unitDepthMin = ruleNum(rules, RULE.unitDepthMin, UNIT_DEPTH_MIN);
  const unitDepthMax = ruleNum(rules, RULE.unitDepthMax, UNIT_DEPTH_MAX);
  apps.push({
    patternId: 'SIT-09',
    storey: SITE_STOREY,
    params: {
      access: typology.access, barDepth: round(depth), corridorWidth: round(corridorWidth),
      impliedUnitDepth: round(impliedUnitDepth),
      rule: ruleTextFor(typology.access),
    },
  });
  if (impliedUnitDepth < unitDepthMin) {
    sink.add(deviation(RULE.unitDepthMin,
      `Bar depth ${depth.toFixed(1)} m implies a ${impliedUnitDepth.toFixed(1)} m unit depth, below the ${unitDepthMin} m minimum (SIT-09).`,
      { observed: round(impliedUnitDepth), limit: unitDepthMin, source: 'SIT-09 unitDepthMin' }));
  } else if (impliedUnitDepth > unitDepthMax) {
    sink.add(deviation(RULE.unitDepthMax,
      `Bar depth ${depth.toFixed(1)} m implies a ${impliedUnitDepth.toFixed(1)} m unit depth, beyond the ${unitDepthMax} m daylight limit (SIT-09).`,
      { observed: round(impliedUnitDepth), limit: unitDepthMax, source: 'SIT-09 unitDepthMax' }));
  }

  // --- corridor graph, then cores in its break slots ------------------------
  const centroid = polygonCentroid(plateOutline);
  const graph = buildCorridorGraph({
    bars, access: typology.access, width: corridorWidth, footprintCentroid: centroid as Vec2,
    shape, sprinklered: typology.sprinklered, rules, ids, sink,
  });
  const corridors = graph.spines;
  const coreOut = placeCores(spec, typology, bars, corridors, storeysAbove, estimatedUnits, unitsPerFloor, ids, sink, apps, graph, rules);

  // --- roof -----------------------------------------------------------------
  const longest = bars.reduce((a, b) => (b.length > a.length ? b : a), bars[0]);
  const roofType = spec.massing.roof;
  const pitchRad = roofType === 'flat' ? 0 : ((spec.massing.roofPitchDeg ?? 30) * Math.PI) / 180;
  const parapetHeight = spec.massing.parapetHeight ?? 1.1;
  const roofStorey = storeys.find(s => s.id === 'ROOF');
  const topOfFloors = roofStorey ? roofStorey.elevation : storeysAbove * (spec.massing.floorToFloor ?? 3.0);
  const roofRise = roofType === 'flat' ? parapetHeight : Math.tan(pitchRad) * (longest.depth / 2);
  const heightAboveGrade = topOfFloors + roofRise;

  if (spec.site.maxHeight !== undefined && heightAboveGrade > spec.site.maxHeight + 1e-6) {
    sink.add(deviation(RULE.maxHeight,
      `Height ${heightAboveGrade.toFixed(1)} m exceeds the zoning limit of ${spec.site.maxHeight} m.`,
      { observed: round(heightAboveGrade), limit: spec.site.maxHeight, source: 'spec.site.maxHeight' }));
  }

  // --- notional existing house in front of an ADU (SIT-05) ------------------
  let existingHouseRect: Rect | null = null;
  if (adu) {
    // The notional house fills the front strip, holding as much separation as the lot allows
    // (never less than 1.5 m). Shallow lots get a shallower house and a reported shortfall.
    const houseDepth = clampNum(placeY - 1.5, 2.5, 9.0);
    const separation = placeY - houseDepth;
    if (placeY - 1.5 >= 2.5) {
      existingHouseRect = { x: env.x, y: Math.max(0, placeY - separation - houseDepth), w: env.w, h: houseDepth };
    } else {
      sink.add(info(RULE.aduSeparation,
        'Lot is too shallow to show the notional main house in front of the ADU (SIT-05).',
        { source: 'SIT-05', resolution: { id: 'drop-band', note: 'notional context house omitted' } }));
    }
    if (existingHouseRect && separation + 1e-6 < ADU_SEPARATION) {
      sink.add(deviation(RULE.aduSeparation,
        `ADU sits ${separation.toFixed(1)} m from the notional main house, below the ${ADU_SEPARATION} m separation target (SIT-05).`,
        { observed: round(separation), limit: ADU_SEPARATION, source: 'SIT-05' }));
    }
    apps.push({
      patternId: 'SIT-05',
      storey: SITE_STOREY,
      params: {
        aduRearOffset: round(env.y + env.h - (placeY + depth)),
        separation: round(existingHouseRect ? separation : 0),
        notionalHouseDepth: round(existingHouseRect ? existingHouseRect.h : 0),
        notionalHouseHeight: EXISTING_HOUSE_HEIGHT,
      },
    });
  }

  // --- SIT-02 / SIT-06 (measured on what actually meets the street: the ground floor) ------
  const groundRects: Rect[] = podiumRect ? [podiumRect] : rects;
  const frontFaceY = Math.min(...groundRects.map(r => r.y));
  if (frame.setbacks.front <= 0.01 && frame.urban) {
    const frontWall = groundRects.filter(r => Math.abs(r.y - frontFaceY) < 0.01).reduce((s, r) => s + r.w, 0);
    const fraction = frontWall / Math.max(1e-6, frame.boundary.w);
    apps.push({
      patternId: 'SIT-06',
      storey: SITE_STOREY,
      params: { frontSetback: 0, buildToFraction: round(fraction, 3), frontageLength: round(frontWall) },
      note: fraction >= 0.7 ? 'Continuous street wall achieved.' : 'Street wall below the 70% build-to target.',
    });
    if (fraction < 0.7) {
      sink.add(deviation(RULE.streetWall,
        `Active street wall covers only ${(fraction * 100).toFixed(0)}% of the frontage (SIT-06 target 70%).`,
        { observed: round(fraction, 3), limit: 0.7, source: 'SIT-06 buildToFraction' }));
    }
  }
  apps.push({
    patternId: 'SIT-02',
    storey: SITE_STOREY,
    params: {
      shape, buildToLineY: round(frontFaceY), frontSetback: round(frame.setbacks.front),
      barLength: round(length), barDepth: round(depth), bars: bars.length,
      ...(typology.access === 'direct'
        ? {
          dwellingsAcross: dw.across,
          dwellingFrontage: round(dw.frontage),
          dwellingTemplate: dw.templateId,
          netDepth: dw.netDepth,
          levels: dw.levels,
          targetFrontage: dw.targetFrontage,
          minFrontage: dw.minFrontage,
          rule: 'n = round(barLength / clamp(area.target / (levels × netDepth), minFrontage, frontage.max))',
        }
        : {}),
    },
  });

  const massing: MassingModel = {
    shape,
    footprint,
    footprintArea: podiumRect ? podiumArea : plateArea,
    bars,
    storeys,
    heightAboveGrade,
    gfa,
    courtyard: courtyardRect ? rectToPolygon(courtyardRect) : undefined,
    podium: podiumRect
      ? { storeys: podiumStoreys, footprint: rectToPolygon(podiumRect), use: spec.massing.podiumUse ?? 'retail' }
      : undefined,
    towerFootprint: towerRect ? rectilinearOutline(rects) : undefined,
    cores: coreOut.cores,
    corridors,
    corridorGraph: coreOut.graph,
    roof: { type: roofType, pitchRad, parapetHeight, ridgeAxis: longest.axis },
  };

  // --- zoning compliance ----------------------------------------------------
  const siteArea = frame.boundary.w * frame.boundary.h;
  const far = gfa / Math.max(1e-6, siteArea);
  const coverage = massing.footprintArea / Math.max(1e-6, siteArea);
  if (spec.site.maxFar !== undefined && far > spec.site.maxFar + 1e-6) {
    sink.add(deviation(RULE.maxFar, `FAR ${far.toFixed(2)} exceeds the zoning limit of ${spec.site.maxFar}.`,
      { observed: round(far, 3), limit: spec.site.maxFar, source: 'spec.site.maxFar' }));
  }
  if (spec.site.maxCoverage !== undefined && coverage > spec.site.maxCoverage + 1e-6) {
    sink.add(deviation(RULE.maxCoverage,
      `Site coverage ${(coverage * 100).toFixed(0)}% exceeds the zoning limit of ${(spec.site.maxCoverage * 100).toFixed(0)}%.`,
      { observed: round(coverage, 3), limit: spec.site.maxCoverage, source: 'spec.site.maxCoverage' }));
  }
  if (clipped) {
    sink.add(info(RULE.buildingSize,
      'Footprint was clipped by the buildable envelope; check the massing against the intended dimensions.',
      { source: 'SIT-01 envelope', resolution: { id: 'clamp' } }));
  }

  return {
    massing, footprintRect, plateRect, plateArea, podiumRect, towerRect, courtyardRect, existingHouseRect,
    travelLimit: coreOut.travelLimit, maxTravel: coreOut.maxTravel,
    estimatedUnits, unitsPerFloor,
    dwellings: dw.count, dwellingsAcross: dw.across, dwellingFrontage: dw.frontage,
    dwellingTemplate: dw.templateId, dwellingNetDepth: dw.netDepth,
    impliedUnitDepth, foundationDepth, residentialFloors,
  };
}

// ---------------------------------------------------------------------------
// Shape decomposition
// ---------------------------------------------------------------------------

interface BarPart { rect: Rect; axis: 'x' | 'y' }
interface Decomposition { shape: FootprintShape; parts: BarPart[]; courtyard: Rect | null }

/**
 * Turn a requested footprint shape into non-overlapping bar rects inside the envelope, each with
 * its intended long axis. Shapes degrade (O → U → L → bar, T → bar) rather than producing
 * unbuildable geometry: a wing must be at least as long as the bar is deep, or it is a stub that
 * no corridor or core can serve.
 */
export function decomposeFootprint(
  shape: FootprintShape,
  env: Rect,
  depth: number,
  length: number,
  placeX: number,
  placeY: number,
  rng?: Rng,
  sink?: IssueSink,
  apps?: PatternApplication[],
): Decomposition {
  const report = sink ?? nullSink();
  const blockW = Math.min(length, env.w);
  const x0 = clampNum(placeX, env.x, env.x + Math.max(0, env.w - blockW));
  const barOnly = (): Decomposition => {
    const r: Rect = { x: x0, y: placeY, w: blockW, h: depth };
    return { shape: 'bar', parts: [{ rect: r, axis: r.w >= r.h ? 'x' : 'y' }], courtyard: null };
  };

  if (shape === 'point') {
    const side = Math.min(depth, env.w, env.h);
    const r: Rect = { x: env.x + (env.w - side) / 2, y: env.y + (env.h - side) / 2, w: side, h: side };
    if (side < depth - 1e-6) {
      report.add(info(RULE.buildingSize,
        `Point plate side reduced from ${depth.toFixed(1)} m to ${side.toFixed(1)} m to fit the envelope.`,
        { observed: round(depth), limit: round(side), source: 'SIT-01 envelope', resolution: { id: 'clamp', from: round(depth), to: round(side) } }));
    }
    return { shape: 'point', parts: [{ rect: r, axis: 'x' }], courtyard: null };
  }

  if (shape === 'bar') return barOnly();

  // L / T / U / O all start from a front bar on the build-to line and run wings to the rear.
  const front: BarPart = { rect: { x: x0, y: env.y, w: blockW, h: depth }, axis: 'x' };
  const wingLen = env.h - depth;
  const minWing = Math.max(MIN_WING, depth);

  if (shape === 'O') {
    const court = inset({ x: x0, y: env.y, w: blockW, h: env.h }, depth);
    const sideLen = env.h - 2 * depth;
    if (Math.min(court.w, court.h) >= MIN_COURTYARD && sideLen >= depth) {
      const rear: BarPart = { rect: { x: x0, y: env.y + env.h - depth, w: blockW, h: depth }, axis: 'x' };
      const left: BarPart = { rect: { x: x0, y: env.y + depth, w: depth, h: sideLen }, axis: 'y' };
      const right: BarPart = { rect: { x: x0 + blockW - depth, y: env.y + depth, w: depth, h: sideLen }, axis: 'y' };
      apps?.push({
        patternId: 'SIT-03',
        params: { courtyardWidth: round(court.w), courtyardDepth: round(court.h), minClear: MIN_COURTYARD, area: round(court.w * court.h, 1) },
      });
      return { shape: 'O', parts: [front, left, right, rear], courtyard: court };
    }
    report.add(info(RULE.courtyard,
      `Courtyard would be only ${Math.max(0, Math.min(court.w, court.h)).toFixed(1)} m clear (minimum ${MIN_COURTYARD} m, side wings ${Math.max(0, sideLen).toFixed(1)} m long vs ${depth.toFixed(1)} m deep): perimeter block degraded to a U (SIT-03).`,
      { observed: round(Math.max(0, Math.min(court.w, court.h))), limit: MIN_COURTYARD, source: 'SIT-03 minCourtyard', resolution: { id: 'drop-band', from: 'O', to: 'U' } }));
    apps?.push({
      patternId: 'SIT-03',
      params: { courtyardWidth: round(Math.max(0, court.w)), courtyardDepth: round(Math.max(0, court.h)), minClear: MIN_COURTYARD, degraded: 'U' },
    });
    return decomposeFootprint('U', env, depth, length, placeX, placeY, rng, sink, apps);
  }

  if (shape === 'U') {
    if (wingLen >= minWing && blockW - 2 * depth >= MIN_U_OPENING) {
      const left: BarPart = { rect: { x: x0, y: env.y + depth, w: depth, h: wingLen }, axis: 'y' };
      const right: BarPart = { rect: { x: x0 + blockW - depth, y: env.y + depth, w: depth, h: wingLen }, axis: 'y' };
      const court: Rect = { x: x0 + depth, y: env.y + depth, w: blockW - 2 * depth, h: wingLen };
      return { shape: 'U', parts: [front, left, right], courtyard: court };
    }
    report.add(info(RULE.buildingSize,
      `U shape needs ${minWing.toFixed(1)} m of wing length and a ${MIN_U_OPENING} m court opening; degraded to an L.`,
      { observed: round(Math.max(0, wingLen)), limit: round(minWing), source: 'SIT-03', resolution: { id: 'drop-band', from: 'U', to: 'L' } }));
    return decomposeFootprint('L', env, depth, length, placeX, placeY, rng, sink, apps);
  }

  if (shape === 'L') {
    if (wingLen >= minWing && blockW - depth >= MIN_WING) {
      const side = rng ? rng.pick(['left', 'right'] as const) : 'left';
      const wing: BarPart = { rect: { x: side === 'left' ? x0 : x0 + blockW - depth, y: env.y + depth, w: depth, h: wingLen }, axis: 'y' };
      return { shape: 'L', parts: [front, wing], courtyard: null };
    }
    report.add(info(RULE.buildingSize,
      `L shape needs ${minWing.toFixed(1)} m of wing length; degraded to a bar.`,
      { observed: round(Math.max(0, wingLen)), limit: round(minWing), source: 'SIT-02', resolution: { id: 'drop-band', from: 'L', to: 'bar' } }));
    return barOnly();
  }

  // 'T'
  if (wingLen >= minWing && blockW - depth >= 2 * MIN_WING) {
    const wing: BarPart = { rect: { x: x0 + (blockW - depth) / 2, y: env.y + depth, w: depth, h: wingLen }, axis: 'y' };
    return { shape: 'T', parts: [front, wing], courtyard: null };
  }
  report.add(info(RULE.buildingSize,
    `T shape needs ${minWing.toFixed(1)} m of wing length; degraded to a bar.`,
    { observed: round(Math.max(0, wingLen)), limit: round(minWing), source: 'SIT-02', resolution: { id: 'drop-band', from: 'T', to: 'bar' } }));
  return barOnly();
}

function boundsOf(rects: Rect[]): Rect {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const r of rects) {
    x1 = Math.min(x1, r.x); y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.w); y2 = Math.max(y2, r.y + r.h);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/**
 * A side is exterior when it is not (almost) entirely shared with another bar.
 * A partially shared side — e.g. the rear of the front bar of a perimeter block — still
 * faces outside over most of its length, so it stays exterior.
 */
function exteriorSidesOf(r: Rect, all: Rect[]): Side[] {
  const others = all.filter(o => o !== r);
  const out: Side[] = [];
  const overlap = (a1: number, a2: number, b1: number, b2: number): number => Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
  const shared: Record<Side, number> = { front: 0, rear: 0, left: 0, right: 0 };
  for (const o of others) {
    if (Math.abs(o.y + o.h - r.y) < 1e-3) shared.front += overlap(r.x, r.x + r.w, o.x, o.x + o.w);
    if (Math.abs(o.y - (r.y + r.h)) < 1e-3) shared.rear += overlap(r.x, r.x + r.w, o.x, o.x + o.w);
    if (Math.abs(o.x + o.w - r.x) < 1e-3) shared.left += overlap(r.y, r.y + r.h, o.y, o.y + o.h);
    if (Math.abs(o.x - (r.x + r.w)) < 1e-3) shared.right += overlap(r.y, r.y + r.h, o.y, o.y + o.h);
  }
  const sides: Side[] = ['front', 'rear', 'left', 'right'];
  for (const s of sides) {
    const len = s === 'front' || s === 'rear' ? r.w : r.h;
    if (shared[s] < 0.95 * len) out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------------------
// SIT-09 helpers
// ---------------------------------------------------------------------------

function impliedUnitDepthFor(access: AccessType, depth: number, corridorWidth: number): number {
  switch (access) {
    case 'corridor-double':
    case 'cluster':
      return (depth - corridorWidth) / 2;
    case 'corridor-single':
    case 'gallery':
      return depth - corridorWidth;
    case 'point-core':
      return (depth - POINT_CORE_D) / 2;
    case 'stair-core':
      return depth / 2;                     // two units back to back off a landing
    default:
      return depth;                         // a house is one unit deep
  }
}

function ruleTextFor(access: AccessType): string {
  switch (access) {
    case 'corridor-double':
    case 'cluster':
      return 'depth = 2 × unitDepth + corridor';
    case 'corridor-single':
    case 'gallery':
      return 'depth = unitDepth + gallery';
    case 'point-core':
      return 'depth = coreDepth + 2 × unitDepth';
    case 'stair-core':
      return 'depth = 2 × unitDepth (back-to-back off a landing)';
    default:
      return 'depth = unitDepth (single dwelling)';
  }
}

/**
 * Bar depth and length after clipping to the buildable envelope. Extracted so the parking solver
 * can size demand from the same dimensions `buildMassing` builds (`estimateUnits` runs before the
 * bars exist), and so the clip is measured in exactly one place.
 */
export function resolveDims(
  spec: BuildingSpec,
  typology: TypologyDef,
  env: Rect,
): { wantDepth: number; wantLength: number; depth: number; length: number } {
  const wantDepth = spec.massing.buildingDepth ?? typology.buildingDepth.default;
  const wantLength = spec.massing.buildingLength ?? defaultLength(typology, env, wantDepth);
  return {
    wantDepth,
    wantLength,
    depth: clampNum(wantDepth, 4, env.h),
    length: clampNum(wantLength, 4, env.w),
  };
}

/**
 * GFA of the resolved floor list. Basements are not GFA; a podium floor takes the podium plate.
 * Residential GFA counts a shared-entrance ground floor at 80 % (the lobby is not lettable), and
 * `GFA_PER_UNIT` turns it into dwellings — the one unit-count rule site and the solver share.
 */
export function gfaBreakdown(
  spec: BuildingSpec,
  plateArea: number,
  podiumArea: number,
  podiumStoreys: number,
): { gfa: number; residentialGfa: number; residentialFloors: number } {
  let gfa = 0;
  let residentialGfa = 0;
  let residentialFloors = 0;
  for (const f of spec.floors) {
    if (f.index < 0) continue;                       // basements are not GFA
    const area = f.index < podiumStoreys ? podiumArea : plateArea;
    gfa += area;
    if (f.use === 'residential') { residentialGfa += area; residentialFloors++; }
    else if (f.use === 'lobby-residential') { residentialGfa += area * 0.8; residentialFloors++; }
  }
  return { gfa, residentialGfa, residentialFloors };
}

/**
 * Default bar length. Most typologies fill the buildable width, but a single dwelling does not
 * spread across its lot: a detached house or an ADU takes its own frontage (0.9–1.6 × its depth)
 * and leaves room for the garage bay and the side yards (SIT-02).
 */
function defaultLength(typology: TypologyDef, env: Rect, depth: number): number {
  if (typology.id === 'detached-house' || typology.id === 'adu-laneway') {
    const garageBay = typology.parking === 'garage-attached' ? GARAGE_BAY + 0.5 : 0;
    return clampNum(env.w - garageBay, Math.min(env.w, depth * 0.9), depth * 1.6);
  }
  return env.w;
}

export interface HouseRow {
  /** Total dwellings (frontage bays × stacked levels) */
  count: number;
  /** Front doors side by side along the frontage */
  across: number;
  /** Frontage of one bay (m) */
  frontage: number;
  /** Dominant template the row was sized from */
  templateId: UnitTemplateId;
  /** Depth of the unit strip: barDepth − 0.6 */
  netDepth: number;
  /** Floors one dwelling occupies */
  levels: number;
  /** Frontage the template wants at this depth, before dividing the bar up */
  targetFrontage: number;
  minFrontage: number;
}

/**
 * Direct-access dwellings side by side along the frontage (SIT-02).
 *
 * The count has to agree with architecture's `planHouses`, which slices the bar into
 * `round(len / frontage)` houses where `frontage` is the dominant template's target area spread
 * over the residential floors and the net bar depth, clamped to the template's own frontage band.
 * Anything else leaves the site's front doors and garages out of step with the dwellings.
 */
export function houseRow(
  spec: BuildingSpec,
  typology: TypologyDef,
  length: number,
  depth: number,
  storeys: number,
  sink?: IssueSink,
): HouseRow {
  const netDepth = Math.max(2, depth - EXTERNAL_WALL_PAIR);
  const mix = resolveUnitMix(spec, typology);
  const template = mix.dominant;
  const stackedType = typology.id === 'stacked-townhouse';
  // Architecture spreads the dwelling over the building's residential floors (one fewer for
  // stacked flats, where the ground floor is a separate dwelling). For every row typology in the
  // catalogue that equals `template.storeysInUnit`.
  const levels = Math.max(1, stackedType ? storeys - 1 : storeys);
  const wanted = templateFrontage(template, netDepth, levels);
  const targetFrontage = Number.isFinite(wanted) && wanted >= 2 ? wanted : HOUSE_FRONTAGE;
  const minF = minTemplateFrontage(template, netDepth);
  const base: HouseRow = {
    count: 0, across: 0, frontage: 0, templateId: template.id,
    netDepth: round(netDepth), levels, targetFrontage: round(targetFrontage), minFrontage: round(minF),
  };
  if (typology.access !== 'direct') return base;

  let across: number;
  if (typology.id === 'detached-house' || typology.id === 'adu-laneway') across = 1;
  else if (typology.id === 'semi-detached') across = 2;
  else {
    across = Math.max(1, Math.round(length / Math.max(2, targetFrontage)));
    if (length / across < minF - 0.05) across = Math.max(1, Math.floor(length / Math.max(2, minF)));
    const band = typology.unitsPerFloor;
    if (across < band.min || across > band.max) {
      sink?.add(deviation(RULE.dwellingBand,
        `Row of ${across} dwellings at ${(length / across).toFixed(1)} m frontage sits outside the typology's ${band.min}–${band.max} dwellings-per-floor band for ${typology.name} (SIT-02).`,
        { observed: across, limit: `${band.min}–${band.max}`, source: 'typology.unitsPerFloor' }));
    }
  }
  // Stacked flats put one dwelling per floor behind each front door.
  const stack = stackedType ? Math.max(1, storeys) : 1;
  return { ...base, count: Math.max(1, across * stack), across, frontage: length / across };
}

// ---------------------------------------------------------------------------
// Corridors: owned by corridor-graph.ts (spines, legs, knuckles, break slots, dead ends)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SIT-08 Two Ways Out — cores
// ---------------------------------------------------------------------------

interface CoreResult {
  cores: CorePlacement[];
  travelLimit: number;
  maxTravel: number;
  /** The graph with the consumed break slots removed (slots and cores are disjoint) */
  graph?: CorridorGraph;
}

/**
 * SIT-08. v2: on a corridor the core stations come from the corridor graph's BREAK SLOTS first —
 * a core dropped into a slot costs the corridor nothing, because the slot was already subtracted
 * from the unit frontage — and only fall back to `alongPositions` when a bar has no slot to
 * spend. The exit separation is checked against the chosen slot stations, and the slots a core
 * takes are removed from the graph, so the architecture placer never puts a lounge in a core.
 */
export function placeCores(
  spec: BuildingSpec,
  typology: TypologyDef,
  bars: MassingBar[],
  corridors: CorridorSpine[],
  storeys: number,
  estimatedUnits: number,
  unitsPerFloor: number,
  ids: IdFactory,
  sink: IssueSink,
  apps: PatternApplication[],
  graph?: CorridorGraph,
  rules?: RuleSet,
): CoreResult {
  const travelLimit = ruleNum(rules, travelRule(typology.sprinklered),
    typology.sprinklered ? TRAVEL_SPRINKLERED : TRAVEL_UNSPRINKLERED);
  const endClearance = ruleNum(rules, 'SIT-08.endClearance', CORE_END_CLEARANCE);
  const separationFraction = ruleNum(rules, RULE.exitSeparation, typology.sprinklered ? 1 / 3 : 1 / 2);
  const access = typology.access;
  if (access === 'direct') {
    apps.push({
      patternId: 'SIT-08',
      storey: SITE_STOREY,
      params: { access, cores: 0, reason: 'every dwelling has its own door to the street; internal stairs only' },
    });
    return { cores: [], travelLimit, maxTravel: 0, graph };
  }

  const elevatorTotal = typology.elevator
    ? Math.max(1, Math.ceil(Math.max(estimatedUnits / 60, storeys / 8)))
    : 0;
  const f2fMax = tallestFloorToFloor(spec, typology);
  const stairRun = stairRunFor(f2fMax);
  /** Depth the core needs across the bar: dog-leg stair + lift bank + lift lobby */
  const coreAcross = coreAcrossFor(f2fMax, typology.elevator);

  // --- point core: one compact core at the plate centre ---------------------
  if (access === 'point-core') {
    const bar = bars[0];
    const c = rectCenter(bar.rect);
    // The service shaft bay sits against one long side of the 9 × 7 m core (XD-04), so the
    // central rectangle is (9 + 2.4) × 7: stairs, lifts and lobby in the 9 m band, the combined
    // M/E riser and the refuse chute in the 2.4 m band, and no shaft left to carve out of a
    // dwelling. The bay extends the core ALONG the long side rather than deepening it, which
    // keeps the two deep dwelling bands in front of and behind the core at full depth.
    const w = Math.min(POINT_CORE_W + CORE_SHAFT_BAY, bar.rect.w - 2);
    const d = Math.min(POINT_CORE_D, bar.rect.h - 2);
    const scissor = storeys > 12;
    const elevatorCount = clampNum(elevatorTotal, 2, 3);
    const core: CorePlacement = {
      id: ids.next(SITE_STOREY, 'CORE'),
      rect: { x: c[0] - w / 2, y: c[1] - d / 2, w, h: d },
      barId: bar.id,
      type: scissor ? 'scissor-stair' : 'point-core',
      hasElevator: typology.elevator,
      elevatorCount: typology.elevator ? elevatorCount : 0,
    };
    const maxTravel = Math.hypot(bar.rect.w, bar.rect.h) / 2;
    if (d + 1e-6 < stairRun) {
      sink.add(deviation(RULE.coreFit,
        `Point core is only ${d.toFixed(1)} m deep; a dog-leg stair for a ${f2fMax.toFixed(1)} m floor-to-floor needs ${stairRun.toFixed(1)} m (SIT-08).`,
        { elementIds: [core.id], observed: round(d), limit: round(stairRun), source: 'SIT-08' }));
    }
    apps.push({
      patternId: 'SIT-08',
      storey: SITE_STOREY,
      elementIds: [core.id],
      params: {
        access, cores: 1, stairs: 2, scissorStair: scissor, elevators: core.elevatorCount,
        coreW: round(w), coreD: round(d), shaftBayAlong: CORE_SHAFT_BAY,
        stairRun: round(stairRun), floorToFloor: round(f2fMax),
        maxTravel: round(maxTravel), travelLimit,
      },
      note: scissor
        ? 'Two scissor stairs in one shaft give the required independent exits from a tall point plate.'
        : 'Two stairs plus lifts in one central core; the loop corridor around it is left to architecture.',
    });
    apps.push({
      patternId: 'XD-04',
      storey: SITE_STOREY,
      elementIds: [core.id],
      params: { shaftBayAlong: CORE_SHAFT_BAY, bayOn: 'long side of the point core', cores: 1 },
      note: 'The core rect reserves the M/E riser and refuse chute bay, so no shaft is taken out of a dwelling.',
    });
    if (maxTravel > travelLimit) {
      sink.add(deviation(travelRule(typology.sprinklered),
        `Point plate travel distance ${maxTravel.toFixed(1)} m exceeds the ${travelLimit} m limit (SIT-08).`,
        { elementIds: [core.id], observed: round(maxTravel), limit: travelLimit, source: 'SIT-08 travelLimit' }));
    }
    return { cores: [core], travelLimit, maxTravel, graph };
  }

  // --- stair cores: one per core MODULE of frontage --------------------------
  if (access === 'stair-core') {
    const out = placeStairCores(spec, typology, bars, storeys, unitsPerFloor, elevatorTotal, coreAcross, stairRun, f2fMax, ids, sink, apps);
    return { ...out, travelLimit, graph };
  }

  // --- corridor / gallery / cluster -----------------------------------------
  const totalLength = bars.reduce((s, b) => s + b.length, 0);
  const singleAllowed = unitsPerFloor <= SINGLE_EXIT_MAX_UNITS
    && storeys <= SINGLE_EXIT_MAX_STOREYS
    && totalLength <= 2 * travelLimit;
  const override = spec.massing.coreCount;
  let total = override !== undefined && override > 0
    ? override
    : singleAllowed
      ? 1
      : Math.max(2, Math.ceil(totalLength / travelLimit), Math.ceil(unitsPerFloor / 12));
  const fits = Math.max(1, Math.floor(totalLength / 10));   // a core needs ~10 m of corridor to serve
  if (total > fits) {
    sink.add(info(RULE.coreCount,
      `${total} cores do not fit in ${totalLength.toFixed(1)} m of corridor; reduced to ${fits} (SIT-08).`,
      { observed: total, limit: fits, source: 'SIT-08', resolution: { id: 'clamp', from: total, to: fits } }));
    total = fits;
  }
  total = clampNum(total, 1, fits);

  const allocation = allocate(total, bars.map(b => b.length));
  const cores: CorePlacement[] = [];
  /** Break slots a core was dropped into, so the graph can drop them */
  const takenSlots = new Set<string>();
  let maxTravel = 0;
  let minEndDistance = Infinity;
  const noCoreBars: MassingBar[] = [];
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const n = allocation[i];
    if (n === 0) { noCoreBars.push(bar); continue; }
    const corridor = corridors.find(c => c.barId === bar.id);
    const corridorOffset = corridor
      ? (bar.axis === 'x' ? corridor.centerline.a[1] - bar.rect.y : corridor.centerline.a[0] - bar.rect.x)
      : bar.depth / 2;
    const corridorWidth = corridor ? corridor.width : 1.5;
    const required = coreAcross;
    const frontBand = corridorOffset - corridorWidth / 2;
    const rearBand = bar.depth - (corridorOffset + corridorWidth / 2);
    const diagonal = Math.hypot(bar.length, bar.depth);
    const requiredSeparation = diagonal * separationFraction;
    let positions = alongPositions(bar.length, n, endClearance);
    // A short bar cannot separate its exits with a 6 m end clearance; give the clearance up
    // before giving up the separation (IBC §1007.1.1).
    if (n >= 2 && positions.length === n && positions[n - 1] - positions[0] + 1e-6 < requiredSeparation) {
      const relaxed = alongPositions(bar.length, n, 2.0);
      if (relaxed[n - 1] - relaxed[0] > positions[n - 1] - positions[0]) positions = relaxed;
    }
    // v2: spend the corridor graph's break slots first — a core in a slot costs no corridor —
    // and keep the ideal spacing when the slots would push the exits closer together.
    const snapped = snapToSlots(positions, coreSlotsOn(graph, bar.id), bar.length, CORE_SNAP_WINDOW);
    if (snapped && minSeparation(snapped.stations) >= Math.min(requiredSeparation, minSeparation(positions)) - 1e-6) {
      positions = snapped.stations;
      for (const id of snapped.slotIds) takenSlots.add(id);
      sink.add(info(RULE.coreCount,
        `${snapped.slotIds.length} core(s) on bar ${bar.id} placed in corridor break slot(s) at ${snapped.stations.map(v => v.toFixed(1)).join(', ')} m (ARC-03 / SIT-08).`,
        { observed: snapped.slotIds.length, limit: n, source: 'ARC-03 break slots', resolution: { id: 'add-core' } }));
    }
    for (let k = 0; k < positions.length; k++) {
      // Alternate which side of the corridor the core sits on — the first core takes the wider
      // side so its lobby can reach the street — but never pick a side too thin for a stair.
      const bigger = frontBand >= rearBand - 0.01;
      let preferFront = k % 2 === 0 ? bigger : !bigger;
      if (preferFront && frontBand < 4.0 && rearBand >= 4.0) preferFront = false;
      if (!preferFront && rearBand < 4.0 && frontBand >= 4.0) preferFront = true;
      const band = preferFront ? frontBand : rearBand;
      let acrossLen: number;
      let acrossStart: number;
      if (band >= 4.0) {
        // Flush with the corridor edge; swallow the leftover strip when it is too thin to use.
        acrossLen = band - required < 3.0 ? band : required;
        acrossStart = preferFront ? corridorOffset - corridorWidth / 2 - acrossLen : corridorOffset + corridorWidth / 2;
      } else {
        acrossLen = Math.min(required, bar.depth - 0.4);
        acrossStart = clampNum(corridorOffset - acrossLen / 2, 0.2, bar.depth - acrossLen - 0.2);
        sink.add(info(RULE.coreFit,
          `Core on bar ${bar.id} cannot fit beside a ${corridorWidth.toFixed(1)} m corridor in a ${bar.depth.toFixed(1)} m bar; it straddles the corridor (SIT-08).`,
          { observed: round(band), limit: 4.0, source: 'SIT-08', resolution: { id: 'shift-lateral', note: 'core straddles the spine' } }));
      }
      cores.push({
        id: ids.next(SITE_STOREY, 'CORE'),
        rect: coreRect(bar, positions[k], acrossLen, acrossStart),
        barId: bar.id,
        type: typology.elevator ? 'stair-elevator' : 'stair',
        hasElevator: typology.elevator,
        elevatorCount: typology.elevator ? Math.max(1, Math.round(elevatorTotal / total)) : 0,
      });
    }
    maxTravel = Math.max(maxTravel, travelOnBar(bar.length, positions));
    minEndDistance = Math.min(minEndDistance, positions[0], bar.length - positions[positions.length - 1]);
    if (positions.length >= 2) {
      const separation = positions[positions.length - 1] - positions[0];
      if (separation + 1e-6 < requiredSeparation) {
        sink.add(deviation(RULE.exitSeparation,
          `Exits on bar ${bar.id} are ${separation.toFixed(1)} m apart, less than the required ${requiredSeparation.toFixed(1)} m (1/${typology.sprinklered ? 3 : 2} of the ${diagonal.toFixed(1)} m diagonal) (SIT-08).`,
          { observed: round(separation), limit: round(requiredSeparation), source: 'SIT-08 exitSeparationFraction' }));
      }
    }
  }
  for (const bar of noCoreBars) {
    maxTravel = Math.max(maxTravel, bar.length + (Number.isFinite(minEndDistance) ? minEndDistance : 0));
  }

  apps.push({
    patternId: 'SIT-08',
    storey: SITE_STOREY,
    elementIds: cores.map(c => c.id),
    params: {
      access, cores: cores.length,
      singleExitAllowed: singleAllowed,
      unitsPerFloor, storeys,
      sprinklered: typology.sprinklered, travelLimit,
      corridorSystemLength: round(totalLength), maxTravel: round(maxTravel),
      endClearance: round(endClearance),
      coreAlongBar: CORE_WIDTH_ALONG_BAR, stairBayAlong: CORE_STAIR_BAY, shaftBayAlong: CORE_SHAFT_BAY,
      coreAcross: round(coreAcross), stairRun: round(stairRun), floorToFloor: round(f2fMax),
      liftBank: typology.elevator ? LIFT_BANK_DEPTH : 0, liftLobby: LIFT_LOBBY_DEPTH,
      source: override !== undefined && override > 0 ? 'spec.massing.coreCount' : 'SIT-08 rule',
    },
    note: 'Each core rect holds a dog-leg stair, the lift bank, the lift lobby and the service shaft bay, flush against one side of the corridor so the spine runs past it.',
  });
  if (cores.length > 0) {
    apps.push({
      patternId: 'XD-04',
      storey: SITE_STOREY,
      elementIds: cores.map(c => c.id),
      params: { shaftBayAlong: CORE_SHAFT_BAY, bayOn: 'beside the stair along the bar', cores: cores.length },
      note: 'The core rect reserves the M/E riser and refuse chute bay, so no shaft is taken out of a dwelling.',
    });
  }
  if (maxTravel > travelLimit) {
    sink.add(deviation(travelRule(typology.sprinklered),
      `Travel distance ${maxTravel.toFixed(1)} m exceeds the ${travelLimit} m limit for ${typology.sprinklered ? 'a sprinklered' : 'an unsprinklered'} building; add a core (SIT-08).`,
      { observed: round(maxTravel), limit: travelLimit, source: 'SIT-08 travelLimit' }));
  }
  // The cores ARE the exits a dead end is measured to, so the dead-end pass runs last.
  const placed = withoutCoreSlots(graph, takenSlots, cores, bars);
  const resolved = placed
    ? resolveDeadEnds({
      graph: placed, bars, exits: coreStations(cores, bars),
      sprinklered: typology.sprinklered, rules, sink,
    })
    : placed;
  return { cores, travelLimit, maxTravel, graph: resolved };
}

/** Core centres — the exit list the dead-end check measures along each spine. */
function coreStations(
  cores: readonly CorePlacement[],
  bars: readonly MassingBar[],
): { barId: string; at: Vec2; length: number }[] {
  const barById = new Map(bars.map(b => [b.id, b]));
  const out: { barId: string; at: Vec2; length: number }[] = [];
  for (const c of cores) {
    const bar = barById.get(c.barId);
    if (!bar) continue;
    out.push({
      barId: c.barId,
      at: [c.rect.x + c.rect.w / 2, c.rect.y + c.rect.h / 2],
      length: round(bar.axis === 'x' ? c.rect.w : c.rect.h, 3),
    });
  }
  return out;
}

/**
 * Assign each ideal core station to the nearest unclaimed break slot (slots wanting a core come
 * first). Returns null when the bar has no slots, so the caller keeps `alongPositions`.
 */
function snapToSlots(
  ideal: number[],
  slots: BreakSlot[],
  barLength: number,
  window: number,
): { stations: number[]; slotIds: string[] } | null {
  if (slots.length === 0 || ideal.length === 0) return null;
  const half = CORE_WIDTH_ALONG_BAR / 2;
  const free = slots.filter(s => s.station >= half - 1e-6 && s.station <= barLength - half + 1e-6);
  if (free.length === 0) return null;
  const used = new Set<string>();
  const stations: number[] = [];
  const slotIds: string[] = [];
  for (const want of ideal) {
    let best: BreakSlot | null = null;
    for (const s of free) {
      if (used.has(s.id) || Math.abs(s.station - want) > window) continue;
      if (best === null) { best = s; continue; }
      const better = Math.abs(s.station - want) < Math.abs(best.station - want) - 1e-9
        || (Math.abs(s.station - want) < Math.abs(best.station - want) + 1e-9 && s.want === 'core' && best.want !== 'core');
      if (better) best = s;
    }
    if (best === null) { stations.push(want); continue; }
    used.add(best.id);
    stations.push(round(best.station, 3));
    slotIds.push(best.id);
  }
  if (slotIds.length === 0) return null;
  stations.sort((a, b) => a - b);
  return { stations, slotIds };
}

/** Smallest gap between consecutive stations (Infinity for a single core). */
function minSeparation(stations: number[]): number {
  let min = Infinity;
  for (let i = 1; i < stations.length; i++) min = Math.min(min, stations[i] - stations[i - 1]);
  return min;
}

/**
 * Break slots minus the ones a core took, and minus any slot a core now overlaps along its bar:
 * what is left is what the architecture placer may fill with a lounge or a window bay.
 */
function withoutCoreSlots(
  graph: CorridorGraph | undefined,
  taken: Set<string>,
  cores: CorePlacement[],
  bars: MassingBar[],
): CorridorGraph | undefined {
  if (!graph) return graph;
  const barById = new Map(bars.map(b => [b.id, b]));
  const spans = new Map<string, { a: number; b: number }[]>();
  for (const c of cores) {
    const bar = barById.get(c.barId);
    if (!bar) continue;
    const a = bar.axis === 'x' ? c.rect.x - bar.rect.x : c.rect.y - bar.rect.y;
    const w = bar.axis === 'x' ? c.rect.w : c.rect.h;
    const list = spans.get(c.barId);
    if (list) list.push({ a, b: a + w });
    else spans.set(c.barId, [{ a, b: a + w }]);
  }
  const kept = graph.breakSlots.filter(s => {
    if (taken.has(s.id)) return false;
    for (const sp of spans.get(s.barId) ?? []) {
      if (s.station + s.length / 2 > sp.a && sp.b > s.station - s.length / 2) return false;
    }
    return true;
  });
  return kept.length === graph.breakSlots.length ? graph : { ...graph, breakSlots: kept };
}

/**
 * SIT-08 for stair-core typologies (garden walk-up, mansion block).
 *
 * A stair core here is not a far exit on a corridor — it is the hinge of a repeating MODULE of
 * frontage: `core + landing + the unit frontages the landing serves on both sides`. Counting
 * cores by anything else (a flat 7 m per unit, say) puts four cores on a 46 m mansion bar and
 * leaves 4 m per landing side — too narrow for any flat in the mix, so architecture fills the
 * gaps with shared flex rooms and the residential efficiency collapses.
 *
 * So: module = coreAlongBar + landing + unitsAlong × frontage, where `unitsAlong` is how many
 * unit frontages the landing has to line up along the bar (`unitsPerCore` divided by the number
 * of across-bar strips architecture will use: 2 per landing for a mansion block, one on each side
 * of the landing; 4 per landing for a walk-up but in two front/rear bands, so still 2 along) and
 * `frontage` is the mix's mean dwelling area over the strip depth. Cores then sit at the centre
 * of each module so every landing gets the same frontage on both sides.
 */
function placeStairCores(
  spec: BuildingSpec,
  typology: TypologyDef,
  bars: MassingBar[],
  storeys: number,
  unitsPerFloor: number,
  elevatorTotal: number,
  coreAcross: number,
  stairRun: number,
  f2fMax: number,
  ids: IdFactory,
  sink: IssueSink,
  apps: PatternApplication[],
): { cores: CorePlacement[]; maxTravel: number } {
  const perCore = Math.max(1, typology.unitsPerCore ?? 2);
  // Matches architecture's `acrossStrips`: 4 units per landing are stacked front/rear.
  const bandsAcross = perCore >= 4 ? 2 : 1;
  const unitsAlong = Math.max(1, perCore / bandsAcross);
  const landing = typology.id === 'mansion-block' ? LANDING_MANSION : LANDING_STAIR_CORE;
  const meanArea = resolveUnitMix(spec, typology).meanArea;
  const override = spec.massing.coreCount;

  const natural: number[] = [];
  const modules: number[] = [];
  const frontages: number[] = [];
  const fitsPerBar: number[] = [];
  for (const bar of bars) {
    const netDepth = Math.max(2, bar.depth - EXTERNAL_WALL_PAIR);
    const frontage = meanArea / (netDepth / bandsAcross);
    const module = CORE_WIDTH_ALONG_BAR + landing + unitsAlong * frontage;
    // A core still needs its own width plus one landing of frontage to sit in.
    const fits = Math.max(1, Math.floor(bar.length / (CORE_WIDTH_ALONG_BAR + landing)));
    natural.push(clampNum(Math.max(1, Math.floor(bar.length / module)), 1, fits));
    modules.push(module);
    frontages.push(frontage);
    fitsPerBar.push(fits);
  }

  // SIT-08: a single stair is only allowed at most 3 storeys AND at most 4 units per floor.
  const singleAllowed = storeys <= SINGLE_EXIT_MAX_STOREYS && unitsPerFloor <= SINGLE_EXIT_MAX_UNITS;
  let counts = natural;
  let source = 'SIT-08 core module';
  if (override !== undefined && override > 0) {
    // The override is a building total; every bar of a stair-core block still needs one core,
    // or the bar gets no dwellings at all.
    counts = allocate(Math.max(override, bars.length), bars.map(b => b.length)).map(v => Math.max(1, v));
    source = 'spec.massing.coreCount';
    if (!singleAllowed && counts.reduce((a, b) => a + b, 0) < 2) {
      sink.add(deviation(RULE.coreCount,
        `massing.coreCount asks for one stair core, but ${storeys} storeys / ${unitsPerFloor} units per floor need two ways out (SIT-08).`,
        { observed: 1, limit: 2, source: 'spec.massing.coreCount' }));
    }
  } else if (!singleAllowed && counts.reduce((a, b) => a + b, 0) < 2) {
    const longest = bars.reduce((best, b, i) => (b.length > bars[best].length ? i : best), 0);
    if (counts[longest] < fitsPerBar[longest]) {
      counts = counts.slice();
      counts[longest] += 1;
      source = 'SIT-08 egress minimum (2 exits)';
    } else {
      sink.add(deviation(RULE.coreCount,
        `${storeys} storeys / ${unitsPerFloor} units per floor need two ways out, but a ${bars[longest].length.toFixed(1)} m bar holds only one stair core and its landing (SIT-08).`,
        { observed: 1, limit: 2, source: 'SIT-08 singleExitMaxStoreys' }));
    }
  }

  const cores: CorePlacement[] = [];
  const perBar: number[] = [];
  let maxTravel = 0;
  const totalCores = counts.reduce((a, b) => a + b, 0);
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const n = Math.max(1, counts[i]);
    const positions = segmentCenters(bar.length, n);
    // The landing sits beside the core ACROSS the bar, so the core may take the full bar depth.
    const acrossLen = Math.min(coreAcross, bar.depth - 0.5);
    if (acrossLen + 1e-6 < stairRun) {
      sink.add(deviation(RULE.coreFit,
        `Stair core on bar ${bar.id} is only ${acrossLen.toFixed(1)} m across; a dog-leg stair for a ${f2fMax.toFixed(1)} m floor-to-floor needs ${stairRun.toFixed(1)} m (SIT-08).`,
        { observed: round(acrossLen), limit: round(stairRun), source: 'SIT-08' }));
    }
    for (const p of positions) {
      cores.push({
        id: ids.next(SITE_STOREY, 'CORE'),
        rect: coreRect(bar, p, acrossLen, (bar.depth - acrossLen) / 2),
        barId: bar.id,
        type: typology.elevator ? 'stair-elevator' : 'stair',
        hasElevator: typology.elevator,
        elevatorCount: typology.elevator ? Math.max(1, Math.round(elevatorTotal / Math.max(1, totalCores))) : 0,
      });
    }
    perBar.push(n);
    maxTravel = Math.max(maxTravel, travelOnBar(bar.length, positions));
    const side = (bar.length / n - CORE_WIDTH_ALONG_BAR) / 2;
    if (side < landing + 2.6) {
      sink.add(deviation(RULE.coreFit,
        `${n} stair core(s) on bar ${bar.id} leave ${Math.max(0, side).toFixed(1)} m of frontage per landing side, too little for a landing plus a dwelling (SIT-08)${n > 1 ? '; set massing.coreCount lower' : ''}.`,
        { observed: round(Math.max(0, side)), limit: round(landing + 2.6), source: 'SIT-08' }));
    }
  }

  apps.push({
    patternId: 'SIT-08',
    storey: SITE_STOREY,
    elementIds: cores.map(c => c.id),
    params: {
      access: typology.access, cores: cores.length, coresPerBar: perBar.join('+'),
      unitsPerCore: perCore, bandsAcross, unitsAlongPerCore: unitsAlong,
      landing, unitFrontage: round(frontages[0] ?? 0), coreModule: round(modules[0] ?? 0),
      meanUnitArea: round(meanArea, 1),
      coreAlongBar: CORE_WIDTH_ALONG_BAR, stairBayAlong: CORE_STAIR_BAY, shaftBayAlong: CORE_SHAFT_BAY,
      coreAcross: round(coreAcross), stairRun: round(stairRun), floorToFloor: round(f2fMax),
      frontagePerLandingSide: round((bars[0].length / Math.max(1, perBar[0]) - CORE_WIDTH_ALONG_BAR) / 2),
      storeys, unitsPerFloor, maxTravel: round(maxTravel), source,
      rule: 'cores = floor(barLength / (coreAlongBar + landing + unitsAlong × frontage))',
    },
    note: 'Open stair cores at the centre of each frontage module, so every landing gets the same frontage on both sides; no corridor, so travel is within the landing.',
  });
  if (cores.length > 0) {
    apps.push({
      patternId: 'XD-04',
      storey: SITE_STOREY,
      elementIds: cores.map(c => c.id),
      params: { shaftBayAlong: CORE_SHAFT_BAY, bayOn: 'beside the stair along the bar', cores: cores.length },
      note: 'The core rect reserves the M/E riser and refuse chute bay, so no shaft is taken out of a dwelling.',
    });
  }
  return { cores, maxTravel };
}

/** Core centre positions along a bar, kept `clearance` from both ends */
function alongPositions(length: number, n: number, clearance = 0): number[] {
  const lo = clearance + CORE_WIDTH_ALONG_BAR / 2;
  const hi = length - clearance - CORE_WIDTH_ALONG_BAR / 2;
  if (hi <= lo) return [length / 2];
  if (n <= 1) return [(lo + hi) / 2];
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(lo + (i / (n - 1)) * (hi - lo));
  return out;
}

/**
 * Core centres at the middle of each served segment — the right rule for stair cores, which
 * serve the frontage around them rather than acting as the far exits of a corridor.
 */
function segmentCenters(length: number, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(((i + 0.5) / n) * length);
  return out;
}

/** Worst-case travel along a bar: to the nearest core from either end or from between two cores */
function travelOnBar(length: number, positions: number[]): number {
  if (positions.length === 0) return length;
  let worst = Math.max(positions[0], length - positions[positions.length - 1]);
  for (let i = 1; i < positions.length; i++) worst = Math.max(worst, (positions[i] - positions[i - 1]) / 2);
  return worst;
}

/**
 * Core rect in world coordinates. `along` is the core centre measured from the bar's start
 * along its long axis; `acrossStart` is the offset of the core's near face from the bar's
 * across-min face. The rect is CORE_WIDTH_ALONG_BAR (stair bay + shaft bay) wide along the bar
 * and `acrossLen` deep across it, so it reads as two structural bays flush against the corridor.
 * Both dimensions are clipped to the bar, so the rect is always inside its bar.
 */
function coreRect(bar: MassingBar, along: number, acrossLen: number, acrossStart: number): Rect {
  const r = bar.rect;
  const alongLen = Math.min(CORE_WIDTH_ALONG_BAR, bar.axis === 'x' ? r.w : r.h);
  const across = Math.min(acrossLen, bar.axis === 'x' ? r.h : r.w);
  if (bar.axis === 'x') {
    const x = clampNum(r.x + along - alongLen / 2, r.x, r.x + r.w - alongLen);
    const y = clampNum(r.y + acrossStart, r.y, r.y + r.h - across);
    return { x, y, w: alongLen, h: across };
  }
  const y = clampNum(r.y + along - alongLen / 2, r.y, r.y + r.h - alongLen);
  const x = clampNum(r.x + acrossStart, r.x, r.x + r.w - across);
  return { x, y, w: across, h: alongLen };
}

/** Largest-remainder allocation of `total` cores across bars in proportion to their length */
function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const exact = weights.map(w => (w / sum) * total);
  const out = exact.map(v => Math.floor(v));
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  let k = 0;
  while (left > 0 && order.length > 0) {
    out[order[k % order.length].i]++;
    left--;
    k++;
  }
  return out;
}
