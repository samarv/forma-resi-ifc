/**
 * SITE + MASSING discipline.
 *
 * `generateSite` turns a BuildingSpec + TypologyDef into a SiteModel: site boundary, buildable
 * envelope, massing (footprint shape → bars → corridors → cores → roof → storeys), parking,
 * landscape, entrances, the site's own IFC elements, the pattern trace and derived metrics.
 *
 * Reading order: `patterns.ts` (the rules), `massing.ts` (frame + form + cores),
 * `entrances.ts`, `parking.ts`, `landscape.ts`, then this file (assembly + metrics + checks).
 *
 * Conventions other modules rely on:
 * - `massing.footprint` is the GROUND floor outline (the podium when there is one);
 *   `massing.bars` / `towerFootprint` describe the typical residential plate.
 * - `CorePlacement.rect` is CORE_WIDTH_ALONG_BAR (5.0 m = a 2.6 m stair bay + a 2.4 m SERVICE
 *   SHAFT BAY, XD-04) along the bar's long axis. The shaft bay is INSIDE the rect: architecture
 *   must NOT reserve a further bay beside the core, or the same 2.4 m is charged twice to the
 *   dwellings. Across the bar the rect is `stairRun(tallest f2f) + lift bank + lift lobby`,
 *   clipped to one unit strip for corridor typologies (flush against one edge of the corridor, so
 *   the spine stays continuous past it) and to the bar depth for stair-core typologies, where the
 *   landing sits beside the core across the bar. A point plate gets one (9 + 2.4) × 7 m core.
 * - Direct-access rows: `derived.dwellingsAcross` front doors, one per `derived.dwellingFrontage`
 *   bay, emitted as `'unit'` (and `'garage'`) entrances in ascending X. The count is
 *   `round(barLength / frontage)` with the same template maths architecture's `planHouses` uses.
 * - Gallery / deck-access spines sit within half a deck width of the long bar face away from the
 *   street, because architecture models the deck outside the envelope.
 * - Parking storeys: 'SITE' for surface and garage stalls, 'B1' for underground, the first
 *   above-grade floor whose `use` is 'parking' (normally 'L01') for podium decks.
 */
import type {
  BuildingSpec, TypologyDef, Rng, SiteModel, ModelElement, PatternApplication, Rect, LandscapeZone, Entrance,
} from '../../core/types.ts';
import { rectToPolygon, relativeTo, rectContainsRect, rectsOverlap, round } from '../../core/geometry.ts';
import { IdFactory, SITE_STOREY } from '../../core/ids.ts';
import { resolveFrame, buildMassing, EXISTING_HOUSE_HEIGHT, type MassingResult, type SiteFrame } from './massing.ts';
import { buildEntrances } from './entrances.ts';
import { buildParking } from './parking.ts';
import { buildLandscape } from './landscape.ts';
import { allFinite, pset, SITE_COLORS } from './util.ts';

export { SITE_PATTERNS, SITE_PATTERN_IDS } from './patterns.ts';
export type { SiteFrame, MassingResult } from './massing.ts';

/** Matches `SiteGenerator` in core/types.ts */
export function generateSite(
  spec: BuildingSpec,
  typology: TypologyDef,
  rng: Rng,
  warnings: string[],
): SiteModel {
  const ids = new IdFactory('site');
  const patterns: PatternApplication[] = [];
  const elements: ModelElement[] = [];

  // 1. Frame: boundary, setbacks, envelope, orientation, garden side.
  const frame = resolveFrame(spec, typology, warnings, patterns);

  // 2. Massing: shape → bars → corridors → cores → roof → storeys.
  const m = buildMassing(spec, typology, frame, rng.fork('massing'), ids, warnings, patterns);

  // 3. Entrances (main / unit / service / courtyard); garages are appended by parking.
  const ent = buildEntrances(spec, typology, frame, m, rng.fork('entrances'), ids, warnings);
  for (const a of ent.apps) patterns.push(a);
  const mainEntrance = ent.entrances.find(e => e.type === 'main') ?? ent.entrances[0] ?? null;

  // 4. Parking and bicycles.
  const parking = buildParking(spec, typology, frame, m, mainEntrance, rng.fork('parking'), ids, warnings);
  for (const a of parking.apps) patterns.push(a);
  for (const e of parking.elements) elements.push(e);
  const entrances: Entrance[] = [...ent.entrances, ...parking.extraEntrances];

  // 5. Landscape: paths, yards, gardens, courtyard, trees, fences.
  const hardscape: Rect[] = [...parking.hardscape, ...parking.garages];
  const siteStalls = parking.lot.spaces.filter(s => s.storey === SITE_STOREY).map(s => s.rect);
  if (siteStalls.length > 0) hardscape.push(boundsOf(siteStalls));
  const land = buildLandscape(spec, typology, frame, m, entrances, hardscape, rng.fork('landscape'), ids);
  for (const a of land.apps) patterns.push(a);
  for (const e of land.elements) elements.push(e);

  // 6. Site works: the graded pad, plus the notional existing house in front of an ADU.
  elements.unshift(sitePad(ids, frame));
  if (m.existingHouseRect) elements.push(existingHouse(ids, m.existingHouseRect));

  // 7. Derived metrics.
  const siteArea = frame.boundary.w * frame.boundary.h;
  const buildableArea = frame.env.w * frame.env.h;
  const footprintArea = m.massing.footprintArea;
  const gfa = m.massing.gfa;
  const landscapeArea = land.landscapeArea;
  const openSpaceArea = land.openSpaceArea;
  const elevatorCount = m.massing.cores.reduce((s, c) => s + c.elevatorCount, 0);
  const derived: Record<string, number> = {
    siteArea: round(siteArea, 2),
    buildableArea: round(buildableArea, 2),
    footprintArea: round(footprintArea, 2),
    plateArea: round(m.plateArea, 2),
    coverage: round(siteArea > 0 ? footprintArea / siteArea : 0, 4),
    gfa: round(gfa, 2),
    far: round(siteArea > 0 ? gfa / siteArea : 0, 4),
    openSpaceArea: round(openSpaceArea, 2),
    landscapeArea: round(landscapeArea, 2),
    landscapeRatio: round(openSpaceArea > 0 ? Math.min(1, landscapeArea / openSpaceArea) : 0, 4),
    hardscapeArea: round(hardscape.reduce((s, r) => s + r.w * r.h, 0), 2),
    parkingSpaces: parking.achieved,
    parkingRequired: parking.required,
    evSpaces: parking.ev,
    accessibleSpaces: parking.accessible,
    bikeSpaces: parking.lot.bikeSpaces,
    estimatedUnits: m.estimatedUnits,
    unitsPerFloor: m.unitsPerFloor,
    dwellings: m.dwellings,
    // Direct-access rows only: front doors side by side, and the bay each one gets. Architecture
    // slices the bar the same way, so these two must stay in step with `entrances` of type 'unit'.
    dwellingsAcross: m.dwellingsAcross,
    dwellingFrontage: round(m.dwellingFrontage, 3),
    densityDph: round(siteArea > 0 ? m.estimatedUnits / (siteArea / 10000) : 0, 2),
    treeCount: land.treeCount,
    pathCount: land.paths.length,
    heightAboveGrade: round(m.massing.heightAboveGrade, 3),
    storeysAboveGrade: spec.massing.storeys,
    residentialFloors: m.residentialFloors,
    setbackFront: round(frame.setbacks.front, 3),
    setbackSide: round(frame.setbacks.side, 3),
    setbackRear: round(frame.setbacks.rear, 3),
    coreCount: m.massing.cores.length,
    elevatorCount,
    corridorCount: m.massing.corridors.length,
    barCount: m.massing.bars.length,
    maxTravelDistance: round(m.maxTravel, 2),
    travelLimit: m.travelLimit,
    impliedUnitDepth: round(m.impliedUnitDepth, 3),
    foundationDepth: m.foundationDepth,
    courtyardArea: round(m.courtyardRect ? m.courtyardRect.w * m.courtyardRect.h : 0, 2),
    podiumStoreys: m.massing.podium ? m.massing.podium.storeys : 0,
    elementCount: elements.length,
  };
  if (m.estimatedUnits > 0) {
    derived.openSpacePerUnit = round(openSpaceArea / m.estimatedUnits, 2);
    derived.parkingRatioAchieved = round(parking.achieved / m.estimatedUnits, 3);
  }

  const model: SiteModel = {
    boundary: rectToPolygon(frame.boundary),
    area: siteArea,
    buildableEnvelope: rectToPolygon(frame.env),
    setbacks: frame.setbacks,
    streetFacing: frame.streetFacing,
    northRad: frame.northRad,
    massing: m.massing,
    parking: parking.lot,
    landscape: land.zones,
    paths: land.paths,
    driveway: parking.driveway,
    entrances,
    elements,
    patterns,
    derived,
  };

  validate(model, frame, m, warnings);
  return model;
}

// ---------------------------------------------------------------------------
// Site works elements
// ---------------------------------------------------------------------------

/** Graded pad: 0.3 m of made ground with its top at grade (z = 0 on the SITE storey). */
function sitePad(ids: IdFactory, frame: SiteFrame): ModelElement {
  const b = frame.boundary;
  return {
    id: ids.next(SITE_STOREY, 'PAD'),
    discipline: 'site',
    ifcType: 'IfcSlab',
    predefinedType: 'BASESLAB',
    name: 'Site terrain',
    objectType: 'SiteTerrain',
    storey: SITE_STOREY,
    geometry: { kind: 'slab', position: [b.x, b.y, -0.3], profile: relativeTo(rectToPolygon(b), [b.x, b.y]), thickness: 0.3 },
    psets: [pset('Forma_Site', {
      Category: 'SiteWorks', Width: round(b.w), Depth: round(b.h), Area: round(b.w * b.h, 2),
      StreetFacing: frame.streetFacing, Hemisphere: frame.southernHemisphere ? 'southern' : 'northern',
    })],
    quantities: [{ name: 'Qto_SlabBaseQuantities', quantities: [{ name: 'GrossArea', value: round(b.w * b.h, 2), kind: 'IfcQuantityArea' }] }],
    material: { name: 'Topsoil / made ground', category: 'earth' },
    color: SITE_COLORS.terrain,
    patterns: ['SIT-01'],
    tags: ['siteworks', 'terrain'],
  };
}

/** SIT-05 context: the existing house the ADU sits behind. */
function existingHouse(ids: IdFactory, r: Rect): ModelElement {
  return {
    id: ids.next(SITE_STOREY, 'CTX'),
    discipline: 'site',
    ifcType: 'IfcBuildingElementProxy',
    predefinedType: 'USERDEFINED',
    name: 'Existing house (context)',
    objectType: 'ExistingHouse',
    storey: SITE_STOREY,
    geometry: { kind: 'prism', position: [r.x, r.y, 0], profile: relativeTo(rectToPolygon(r), [r.x, r.y]), height: EXISTING_HOUSE_HEIGHT },
    psets: [pset('Forma_Site', { Category: 'Context', Element: 'ExistingHouse', Height: EXISTING_HOUSE_HEIGHT, Area: round(r.w * r.h, 2) })],
    color: SITE_COLORS.existing,
    patterns: ['SIT-05'],
    tags: ['context'],
  };
}

function boundsOf(rects: Rect[]): Rect {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const r of rects) {
    x1 = Math.min(x1, r.x); y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.w); y2 = Math.max(y2, r.y + r.h);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

// ---------------------------------------------------------------------------
// Self-checks (never throw: the caller collects warnings)
// ---------------------------------------------------------------------------

function validate(model: SiteModel, frame: SiteFrame, m: MassingResult, warnings: string[]): void {
  const B = frame.boundary;
  const eps = 1e-3;

  if (!allFinite(model.massing.footprint) || !allFinite(model.derived)) {
    warnings.push('Site geometry or metrics contain non-finite numbers.');
  }
  for (const e of model.elements) {
    if (!allFinite(e.geometry)) warnings.push(`Element ${e.id} has non-finite geometry.`);
  }
  for (const p of model.massing.footprint) {
    if (p[0] < B.x - eps || p[0] > B.x + B.w + eps || p[1] < B.y - eps || p[1] > B.y + B.h + eps) {
      warnings.push('Massing footprint falls outside the site boundary.');
      break;
    }
  }
  const bars = model.massing.bars;
  for (let i = 0; i < bars.length; i++) {
    if (!rectContainsRect(B, bars[i].rect, eps)) warnings.push(`Bar ${bars[i].id} falls outside the site boundary.`);
    for (let j = i + 1; j < bars.length; j++) {
      if (rectsOverlap(bars[i].rect, bars[j].rect, 1e-4)) warnings.push(`Bars ${bars[i].id} and ${bars[j].id} overlap.`);
    }
  }
  const barById = new Map(bars.map(b => [b.id, b]));
  for (const c of model.massing.cores) {
    const bar = barById.get(c.barId);
    if (!bar) { warnings.push(`Core ${c.id} references unknown bar ${c.barId}.`); continue; }
    if (!rectContainsRect(bar.rect, c.rect, 1e-3)) warnings.push(`Core ${c.id} is not contained in bar ${c.barId}.`);
  }
  for (const co of model.massing.corridors) {
    if (!barById.has(co.barId)) warnings.push(`Corridor ${co.id} references unknown bar ${co.barId}.`);
  }
  if (model.parking) {
    for (const s of model.parking.spaces) {
      if (!rectContainsRect(B, s.rect, 0.05)) warnings.push(`Parking space ${s.id} falls outside the site boundary.`);
      else if (s.storey !== SITE_STOREY && !rectContainsRect(frame.env, s.rect, 0.5)) {
        warnings.push(`Structured parking space ${s.id} falls outside the buildable envelope.`);
      }
    }
  }
  const seen = new Set<string>();
  const allIds: string[] = [
    ...model.elements.map(e => e.id),
    ...model.massing.bars.map(b => b.id),
    ...model.massing.cores.map(c => c.id),
    ...model.massing.corridors.map(c => c.id),
    ...model.entrances.map(e => e.id),
    ...model.landscape.map((z: LandscapeZone) => z.id),
    ...(model.parking ? model.parking.spaces.map(s => s.id) : []),
  ];
  for (const id of allIds) {
    if (seen.has(id)) warnings.push(`Duplicate site id ${id}.`);
    seen.add(id);
  }
  if (m.massing.storeys.length < 3) warnings.push('Storey stack is missing SITE / FND / ROOF levels.');
}
