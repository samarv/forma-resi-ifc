/**
 * Parking and bicycle storage — SIT-07 Parking Behind.
 *
 * Surface parking is packed into the yards in preference order (rear → side → front, never the
 * front while another yard can hold it), in double-loaded 16.8 m modules off a single 6.0 m
 * aisle. Structured parking (podium / underground) fills the parking storey's outline with the
 * same module plus one ramp at the rear. Garage parking is a bay beside a detached house, or an
 * integral garage per dwelling in a row.
 *
 * `ParkingSpace.rect` is always the axis-aligned footprint of the stall (already transposed for
 * rows that run along +Y); `rotation` is the bearing of the stall's long axis — the direction a
 * parked car points — and must NOT be applied to `rect` a second time.
 */
import type {
  BuildingSpec, TypologyDef, Rng, Rect, ParkingLot, ParkingSpace, ModelElement, Entrance,
  PatternApplication, ParkingType,
} from '../../core/types.ts';
import { rectCenter, rectToPolygon, relativeTo, round } from '../../core/geometry.ts';
import { SIZES } from '../../core/coordination.ts';
import type { IdFactory } from '../../core/ids.ts';
import { SITE_STOREY, storeyIdFor } from '../../core/ids.ts';
import type { SiteFrame, MassingResult } from './massing.ts';
import { clampNum, subtractRects, pset, SITE_COLORS } from './util.ts';

const STALL_W = SIZES.parkingStallW;   // 2.6
const STALL_L = SIZES.parkingStallL;   // 5.4
const AISLE = SIZES.parkingAisleW;     // 6.0
const ACC_W = SIZES.accessibleStallW;  // 3.6
const RAMP_W = 3.5;
const RAMP_L = 12.0;
const GARAGE_SIDE = 6.0;               // detached double garage, 6 × 6
const BIKE_AREA_PER_SPACE = 1.2;       // m² per bicycle in a two-tier rack room

export interface ParkingResult {
  lot: ParkingLot;
  elements: ModelElement[];
  driveway: Rect | null;
  /** Everything hard-surfaced, so landscape can subtract it */
  hardscape: Rect[];
  garages: Rect[];
  extraEntrances: Entrance[];
  required: number;
  achieved: number;
  accessible: number;
  ev: number;
  apps: PatternApplication[];
}

/** Integral garage width for a dwelling in a row: one door plus a hall beside it. */
export function integralGarageWidth(frontage: number): number {
  return clampNum(frontage - 3.0, 2.9, 6.0);
}

export function buildParking(
  spec: BuildingSpec,
  typology: TypologyDef,
  frame: SiteFrame,
  m: MassingResult,
  mainEntrance: Entrance | null,
  rng: Rng,
  ids: IdFactory,
  warnings: string[],
): ParkingResult {
  const p = spec.site.parking ?? {};
  const type: ParkingType = p.type ?? typology.parking;
  const ratio = p.ratio ?? typology.parkingRatio;
  const evShare = clampNum(p.evShare ?? 0.2, 0, 1);
  const bikeRatio = p.bikeRatio ?? typology.bikeRatio;
  const units = m.estimatedUnits;
  // 'none' means the typology is deliberately car-free, so nothing is owed.
  const required = type === 'none' ? 0 : Math.max(0, Math.ceil(units * ratio));
  const bikeSpaces = Math.max(0, Math.ceil(units * bikeRatio));
  const apps: PatternApplication[] = [];
  const elements: ModelElement[] = [];
  const hardscape: Rect[] = [];
  const garages: Rect[] = [];
  const extraEntrances: Entrance[] = [];
  let driveway: Rect | null = null;

  let spaces: ParkingSpace[] = [];
  let aisles: Rect[] = [];
  let storey = SITE_STOREY;
  let builtType: ParkingType = type;
  let note = '';

  if (type === 'garage-attached') {
    const g = buildGarages(frame, m, ids, warnings);
    spaces = g.spaces; garages.push(...g.garages); driveway = g.driveway;
    for (const r of g.hardscape) hardscape.push(r);
    for (const e of g.entrances) extraEntrances.push(e);
    for (const el of g.elements) elements.push(el);
    note = g.note;
  } else if (type === 'podium' || type === 'underground') {
    const s = structuredParking(spec, type, frame, m, required, evShare, ids, warnings);
    if (s) {
      spaces = s.spaces; aisles = s.aisles; storey = s.storey;
      for (const el of s.elements) elements.push(el);
      note = s.note;
      driveway = drivewayToRamp(s.ramp, frame);
      if (driveway) {
        hardscape.push(driveway);
        elements.push(pavingElement(ids, driveway, 'Driveway', SITE_COLORS.driveway, ['SIT-07', 'SIT-11']));
      }
    } else {
      warnings.push(`${type} parking requested but no storey has use 'parking'; falling back to surface parking (SIT-07).`);
      const surf = surfaceParking(frame, m, required, evShare, ids, warnings);
      spaces = surf.spaces; aisles = surf.aisles;
      for (const r of surf.hardscape) hardscape.push(r);
      builtType = surf.spaces.length > 0 ? 'surface' : 'none';
      note = `fallback from ${type}: ${surf.note}`;
    }
  } else if (type === 'surface') {
    const surf = surfaceParking(frame, m, required, evShare, ids, warnings);
    spaces = surf.spaces; aisles = surf.aisles;
    for (const r of surf.hardscape) hardscape.push(r);
    note = surf.note;
  } else {
    note = 'no car parking provided for this typology';
  }

  // Driveway to a surface lot (SIT-11 keeps it separate from the entrance path).
  if (driveway === null && builtType === 'surface' && aisles.length > 0) {
    driveway = drivewayTo(aisles[0], frame, mainEntrance);
    if (driveway) {
      hardscape.push(driveway);
      elements.push(pavingElement(ids, driveway, 'Driveway', SITE_COLORS.driveway, ['SIT-07', 'SIT-11']));
    }
  }

  const achieved = spaces.length;
  const accessible = spaces.filter(s => s.type === 'accessible').length;
  const ev = spaces.filter(s => s.type === 'ev').length;
  if (required > 0 && achieved < required) {
    warnings.push(`Parking: ${required} spaces required (${units} units × ${ratio}), ${achieved} achieved (${note}).`);
  }

  // --- stall + car elements -------------------------------------------------
  const detail = spec.options.detail;
  const carEvery = detail === 'low' ? 0 : 1;
  let carCount = 0;
  for (let i = 0; i < spaces.length; i++) {
    const s = spaces[i];
    const color = s.type === 'accessible' ? SITE_COLORS.accessibleStall : s.type === 'ev' ? SITE_COLORS.evStall : SITE_COLORS.stall;
    elements.push({
      id: ids.next(s.storey, 'STALL'),
      discipline: 'site',
      ifcType: 'IfcSpace',
      predefinedType: 'PARKING',
      name: `P-${String(i + 1).padStart(3, '0')}`,
      objectType: `ParkingSpace-${s.type}`,
      storey: s.storey,
      geometry: { kind: 'prism', position: [s.rect.x, s.rect.y, 0], profile: relativeTo(rectToPolygon(s.rect), [s.rect.x, s.rect.y]), height: 0.05 },
      psets: [pset('Forma_Site', {
        Category: 'Parking', StallType: s.type, Width: round(s.rect.w), Length: round(s.rect.h),
        Rotation: round(s.rotation, 4), ParkingType: builtType,
      })],
      color,
      patterns: ['SIT-07'],
      tags: ['parking', s.type],
    });
    // ~40% of stalls get a car so the model reads as occupied without doubling the element count
    if (carEvery > 0 && carCount < 120 && i % 5 < 2) {
      const c = rectCenter(s.rect);
      const along = s.rect.w >= s.rect.h;                  // stall long axis along +X
      const cw = along ? 4.5 : 1.8;
      const cd = along ? 1.8 : 4.5;
      elements.push({
        id: ids.next(s.storey, 'CAR'),
        discipline: 'site',
        ifcType: 'IfcFurnishingElement',
        name: `Car ${carCount + 1}`,
        objectType: 'Car',
        storey: s.storey,
        geometry: { kind: 'box', position: [c[0] - cw / 2, c[1] - cd / 2, 0], width: cw, depth: cd, height: 1.5, rotation: 0 },
        psets: [pset('Forma_Site', { Category: 'Parking', Occupant: 'Car', StallId: s.id })],
        color: SITE_COLORS.car,
        patterns: ['SIT-07'],
        tags: ['furniture', 'car'],
      });
      carCount++;
    }
  }

  // Surface aisles are paving; structured aisles are part of the building floor slab.
  if (builtType === 'surface' || builtType === 'garage-attached') {
    for (const a of aisles) {
      elements.push(pavingElement(ids, a, 'ParkingAisle', SITE_COLORS.driveway, ['SIT-07']));
      hardscape.push(a);
    }
  }

  // --- bicycles -------------------------------------------------------------
  const bikeStoreRect = bikeSpaces > 0 ? bikeStore(bikeSpaces, frame, m, mainEntrance, typology) : undefined;
  if (bikeStoreRect) {
    hardscape.push(bikeStoreRect);
    const racks = Math.min(40, Math.ceil(bikeSpaces / 2));
    if (detail !== 'low') {
      for (let i = 0; i < racks; i++) {
        const cols = Math.max(1, Math.floor(bikeStoreRect.w / 0.8));
        const col = i % cols, row = Math.floor(i / cols);
        const x = bikeStoreRect.x + 0.1 + col * 0.8;
        const y = bikeStoreRect.y + 0.2 + row * 2.0;
        if (y + 1.8 > bikeStoreRect.y + bikeStoreRect.h + 0.05) break;
        elements.push({
          id: ids.next(SITE_STOREY, 'BIKE'),
          discipline: 'site',
          ifcType: 'IfcFurnishingElement',
          name: `Bike rack ${i + 1}`,
          objectType: 'BikeRack',
          storey: SITE_STOREY,
          geometry: { kind: 'box', position: [x, y, 0], width: 0.6, depth: 1.8, height: 1.1, rotation: 0 },
          psets: [pset('Forma_Site', { Category: 'Bicycle', Spaces: 2 })],
          color: SITE_COLORS.bike,
          patterns: ['SIT-07'],
          tags: ['furniture', 'bike'],
        });
      }
    }
  }

  apps.push({
    patternId: 'SIT-07',
    storey,
    params: {
      requestedType: type, builtType, required, achieved,
      units, ratio, accessible, ev, evShare,
      bikeSpaces, stallWidth: STALL_W, stallLength: STALL_L, aisleWidth: AISLE,
      rows: aisles.length, note,
    },
  });

  const lot: ParkingLot = {
    type: builtType,
    spaces,
    aisles,
    bikeSpaces,
    bikeStoreRect,
    storey,
  };
  return { lot, elements, driveway, hardscape, garages, extraEntrances, required, achieved, accessible, ev, apps };
}

// ---------------------------------------------------------------------------
// Surface parking
// ---------------------------------------------------------------------------

interface PackResult { spaces: ParkingSpace[]; aisles: Rect[]; hardscape: Rect[]; note: string }

function surfaceParking(
  frame: SiteFrame,
  m: MassingResult,
  required: number,
  evShare: number,
  ids: IdFactory,
  warnings: string[],
): PackResult {
  const spaces: ParkingSpace[] = [];
  const aisles: Rect[] = [];
  if (required <= 0) return { spaces, aisles, hardscape: [], note: 'no spaces required' };

  // Free ground: the site inside a 1 m boundary margin, minus every bar (plus 1 m of clearance)
  // and the notional existing house.
  const inner: Rect = { x: 1, y: 1, w: frame.boundary.w - 2, h: frame.boundary.h - 2 };
  const obstacles: Rect[] = m.massing.bars.map(b => ({ x: b.rect.x - 1, y: b.rect.y - 1, w: b.rect.w + 2, h: b.rect.h + 2 }));
  if (m.podiumRect) obstacles.push({ x: m.podiumRect.x - 1, y: m.podiumRect.y - 1, w: m.podiumRect.w + 2, h: m.podiumRect.h + 2 });
  if (m.existingHouseRect) obstacles.push({ x: m.existingHouseRect.x - 1, y: m.existingHouseRect.y - 1, w: m.existingHouseRect.w + 2, h: m.existingHouseRect.h + 2 });
  const free = subtractRects(inner, obstacles, 1.0);

  const buildingFrontY = Math.min(...m.massing.bars.map(b => b.rect.y));
  const candidates = free
    .map(r => ({ r, front: rectCenter(r)[1] < buildingFrontY, cap: capacityOf(r) }))
    .filter(c => c.cap > 0)
    .sort((a, b) => (a.front === b.front ? b.cap - a.cap : a.front ? 1 : -1));

  const evEvery = evShare > 0 ? Math.max(1, Math.round(1 / evShare)) : 0;
  let accessibleLeft = Math.ceil(required * 0.05);
  let usedFront = false;
  for (const c of candidates) {
    if (spaces.length >= required) break;
    const packed = packZone(c.r, required - spaces.length, accessibleLeft, evEvery, SITE_STOREY, ids);
    if (packed.spaces.length === 0) continue;
    if (c.front) usedFront = true;
    accessibleLeft = Math.max(0, accessibleLeft - packed.spaces.filter(s => s.type === 'accessible').length);
    for (const s of packed.spaces) spaces.push(s);
    for (const a of packed.aisles) aisles.push(a);
  }
  if (usedFront) warnings.push('Surface parking had to use the front yard: no other yard could hold it (SIT-07).');
  const note = candidates.length === 0
    ? 'no yard large enough for a 5.4 m stall row plus a 6.0 m aisle'
    : `${aisles.length} aisle(s) across ${candidates.length} candidate yard(s)`;
  return { spaces, aisles, hardscape: [], note };
}

/** Upper bound on stalls in a rect, used to rank yards */
function capacityOf(r: Rect): number {
  const alongX = r.w >= r.h;
  const along = alongX ? r.w : r.h;
  const across = alongX ? r.h : r.w;
  if (across < STALL_L + AISLE || along < STALL_W) return 0;
  const modules = Math.floor(across / (2 * STALL_L + AISLE));
  const rest = across - modules * (2 * STALL_L + AISLE);
  const rows = modules * 2 + (rest >= STALL_L + AISLE ? 1 : 0);
  return rows * Math.floor(along / STALL_W);
}

/**
 * Double-loaded rows in 16.8 m modules (row | aisle | row), then one single-loaded
 * module (row | aisle) if the leftover allows it.
 */
function packZone(
  zone: Rect,
  want: number,
  accessibleLeft: number,
  evEvery: number,
  storey: string,
  ids: IdFactory,
): { spaces: ParkingSpace[]; aisles: Rect[] } {
  const spaces: ParkingSpace[] = [];
  const aisles: Rect[] = [];
  if (want <= 0) return { spaces, aisles };
  const alongX = zone.w >= zone.h;
  const along = alongX ? zone.w : zone.h;
  const across = alongX ? zone.h : zone.w;
  const acrossStart = alongX ? zone.y : zone.x;
  const alongStart = alongX ? zone.x : zone.y;

  const rowOffsets: number[] = [];
  let off = 0;
  while (true) {
    const remain = across - off;
    if (remain >= 2 * STALL_L + AISLE - 1e-9) {
      rowOffsets.push(off, off + STALL_L + AISLE);
      aisles.push(bandRect(zone, alongX, off + STALL_L, AISLE));
      off += 2 * STALL_L + AISLE;
    } else if (remain >= STALL_L + AISLE - 1e-9) {
      rowOffsets.push(off);
      aisles.push(bandRect(zone, alongX, off + STALL_L, AISLE));
      break;
    } else break;
  }

  let acc = accessibleLeft;
  let standardIdx = 0;
  for (const rowOff of rowOffsets) {
    let a = 0;
    while (spaces.length < want) {
      const useAcc = acc > 0 && a + ACC_W <= along + 1e-9;
      const w = useAcc ? ACC_W : STALL_W;
      if (a + w > along + 1e-9) break;
      const kind: ParkingSpace['type'] = useAcc ? 'accessible' : (evEvery > 0 && standardIdx % evEvery === 0 ? 'ev' : 'standard');
      if (useAcc) acc--; else standardIdx++;
      const rect: Rect = alongX
        ? { x: alongStart + a, y: acrossStart + rowOff, w, h: STALL_L }
        : { x: acrossStart + rowOff, y: alongStart + a, w: STALL_L, h: w };
      spaces.push({
        id: ids.next(storey, 'PRK'),
        rect,
        rotation: alongX ? Math.PI / 2 : 0,
        type: kind,
        storey,
      });
      a += w;
    }
    if (spaces.length >= want) break;
  }
  return { spaces, aisles };
}

function bandRect(zone: Rect, alongX: boolean, offset: number, thickness: number): Rect {
  return alongX
    ? { x: zone.x, y: zone.y + offset, w: zone.w, h: thickness }
    : { x: zone.x + offset, y: zone.y, w: thickness, h: zone.h };
}

// ---------------------------------------------------------------------------
// Structured parking (podium / underground)
// ---------------------------------------------------------------------------

function structuredParking(
  spec: BuildingSpec,
  type: ParkingType,
  frame: SiteFrame,
  m: MassingResult,
  required: number,
  evShare: number,
  ids: IdFactory,
  warnings: string[],
): { spaces: ParkingSpace[]; aisles: Rect[]; storey: string; ramp: Rect; elements: ModelElement[]; note: string } | null {
  const wantBasement = type === 'underground';
  const floors = spec.floors.filter(f => f.use === 'parking');
  const floor = floors.find(f => (wantBasement ? f.index < 0 : f.index >= 0)) ?? floors[0];
  if (!floor) return null;
  const storey = storeyIdFor(floor.index);
  // Underground levels follow the buildable envelope; a podium level follows the podium outline.
  const outline = floor.index < 0 ? frame.env : (m.podiumRect ?? m.footprintRect);
  const zone: Rect = { x: outline.x + 0.4, y: outline.y + 0.4, w: Math.max(1, outline.w - 0.8), h: Math.max(1, outline.h - 0.8) };
  const ramp: Rect = {
    x: clampNum(zone.x + zone.w - RAMP_W - 0.5, zone.x, zone.x + Math.max(0, zone.w - RAMP_W)),
    y: clampNum(zone.y + zone.h - RAMP_L - 0.5, zone.y, zone.y + Math.max(0, zone.h - RAMP_L)),
    w: Math.min(RAMP_W, zone.w), h: Math.min(RAMP_L, zone.h),
  };
  const evEvery = evShare > 0 ? Math.max(1, Math.round(1 / evShare)) : 0;
  const packed = packZone(zone, required + 12, Math.ceil(required * 0.05), evEvery, storey, ids);
  // Drop stalls fouling the ramp, then trim to what is required.
  const clear = packed.spaces.filter(s => !overlaps(s.rect, ramp, 0.5)).slice(0, Math.max(0, required));
  if (clear.length < required) {
    warnings.push(`Structured parking on ${storey} fits ${clear.length} of ${required} spaces in a ${zone.w.toFixed(1)} × ${zone.h.toFixed(1)} m plate (SIT-07).`);
  }
  const storeyDef = m.massing.storeys.find(s => s.id === storey);
  const elements: ModelElement[] = [{
    id: ids.next(storey, 'RAMP'),
    discipline: 'site',
    ifcType: 'IfcRamp',
    predefinedType: 'STRAIGHT',
    name: 'Parking ramp',
    objectType: 'ParkingRamp',
    storey,
    geometry: { kind: 'ramp', position: [ramp.x, ramp.y, 0], width: ramp.w, length: ramp.h, thickness: 0.2, rise: storeyDef ? storeyDef.height : 3.2 },
    psets: [pset('Forma_Site', { Category: 'Parking', Element: 'Ramp', Width: round(ramp.w), Length: round(ramp.h) })],
    color: SITE_COLORS.driveway,
    patterns: ['SIT-07'],
    tags: ['parking', 'ramp'],
  }];
  return { spaces: clear, aisles: packed.aisles, storey, ramp, elements, note: `${type} deck on ${storey}` };
}

function overlaps(a: Rect, b: Rect, pad = 0): boolean {
  return a.x < b.x + b.w + pad && b.x - pad < a.x + a.w && a.y < b.y + b.h + pad && b.y - pad < a.y + a.h;
}

// ---------------------------------------------------------------------------
// Garages
// ---------------------------------------------------------------------------

function buildGarages(
  frame: SiteFrame,
  m: MassingResult,
  ids: IdFactory,
  warnings: string[],
): { spaces: ParkingSpace[]; garages: Rect[]; driveway: Rect | null; hardscape: Rect[]; entrances: Entrance[]; elements: ModelElement[]; note: string } {
  const spaces: ParkingSpace[] = [];
  const garages: Rect[] = [];
  const hardscape: Rect[] = [];
  const entrances: Entrance[] = [];
  const elements: ModelElement[] = [];
  const bar = m.massing.bars[0];
  const dwellings = Math.max(1, m.dwellingsAcross);   // one garage per frontage bay
  let driveway: Rect | null = null;
  let note = '';

  if (dwellings === 1) {
    // A bay beside the house, front face aligned with the house front.
    const leftRoom = bar.rect.x - 0.3;
    const rightRoom = frame.boundary.w - (bar.rect.x + bar.rect.w) - 0.3;
    const onRight = rightRoom >= leftRoom;
    const w = Math.min(GARAGE_SIDE, Math.max(3.0, onRight ? rightRoom : leftRoom));
    const x = onRight ? bar.rect.x + bar.rect.w + 0.2 : Math.max(0.3, bar.rect.x - 0.2 - w);
    const g: Rect = { x, y: bar.rect.y, w, h: Math.min(GARAGE_SIDE, bar.rect.h) };
    garages.push(g);
    hardscape.push(g);
    driveway = { x: g.x, y: 0, w: g.w, h: Math.max(0.5, g.y) };
    hardscape.push(driveway);
    entrances.push({ id: ids.next(SITE_STOREY, 'ENT'), position: [g.x + g.w / 2, g.y], side: 'front', type: 'garage' });
    for (const s of stallsIn(g, ids, SITE_STOREY)) spaces.push(s);
    elements.push(pavingElement(ids, driveway, 'Driveway', SITE_COLORS.driveway, ['SIT-07', 'SIT-11']));
    elements.push(pavingElement(ids, g, 'GaragePad', SITE_COLORS.driveway, ['SIT-07']));
    note = `${w.toFixed(1)} m garage bay ${onRight ? 'right' : 'left'} of the house`;
  } else {
    // Integral garage per dwelling at the front of the bar, with its own crossover.
    const frontage = m.dwellingFrontage;
    const gw = integralGarageWidth(frontage);
    const gd = Math.min(GARAGE_SIDE, bar.rect.h - 1.0);
    for (let i = 0; i < dwellings; i++) {
      const gx = bar.rect.x + i * frontage + 0.3;
      const gwi = Math.min(gw, bar.rect.x + bar.rect.w - gx - 0.1);
      if (gwi < 2.5) break;
      const g: Rect = { x: gx, y: bar.rect.y, w: gwi, h: gd };
      garages.push(g);
      entrances.push({ id: ids.next(SITE_STOREY, 'ENT'), position: [g.x + g.w / 2, g.y], side: 'front', type: 'garage' });
      for (const s of stallsIn(g, ids, SITE_STOREY)) spaces.push(s);
      elements.push(pavingElement(ids, g, 'GaragePad', SITE_COLORS.driveway, ['SIT-07']));
      if (g.y > 0.5) {
        const cross: Rect = { x: g.x, y: 0, w: g.w, h: g.y };
        hardscape.push(cross);
        elements.push(pavingElement(ids, cross, 'Crossover', SITE_COLORS.driveway, ['SIT-07']));
      }
    }
    note = `${garages.length} integral garages of ${gw.toFixed(1)} m in a ${dwellings}-dwelling row`;
    if (garages.length < dwellings) warnings.push(`Only ${garages.length} of ${dwellings} dwellings could take an integral garage (SIT-07).`);
  }
  return { spaces, garages, driveway, hardscape, entrances, elements, note };
}

/** Stalls that fit side by side inside a garage rect */
function stallsIn(g: Rect, ids: IdFactory, storey: string): ParkingSpace[] {
  const n = Math.max(1, Math.floor(g.w / STALL_W));
  const out: ParkingSpace[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: ids.next(storey, 'PRK'),
      rect: { x: g.x + i * STALL_W, y: g.y + Math.max(0, (g.h - STALL_L) / 2), w: Math.min(STALL_W, g.w - i * STALL_W), h: Math.min(STALL_L, g.h) },
      rotation: Math.PI / 2,
      type: 'standard',
      storey,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Driveway and bike store
// ---------------------------------------------------------------------------

/**
 * With only one street frontage, a rear ramp is reached by a 3.5 m run down the nearer side
 * boundary. Where the building fills the envelope this strip passes beneath it — which is what
 * a ramp entrance under a podium actually looks like.
 */
function drivewayToRamp(ramp: Rect, frame: SiteFrame): Rect | null {
  if (ramp.y <= 0.6) return null;
  const w = RAMP_W;
  const centre = ramp.x + ramp.w / 2;
  const x = centre > frame.boundary.w / 2
    ? Math.max(0, frame.boundary.w - w - 0.5)
    : 0.5;
  return { x, y: 0, w, h: ramp.y };
}

/** A 3.5–6.0 m paved run from the street to the first aisle, kept off the entrance path (SIT-11). */
function drivewayTo(aisle: Rect, frame: SiteFrame, mainEntrance: Entrance | null): Rect | null {
  const w = clampNum(AISLE * 0.6, 3.5, 6.0);
  if (aisle.y <= 0.6) return null;
  // Run down whichever side is further from the main entrance.
  const entranceX = mainEntrance ? mainEntrance.position[0] : frame.boundary.w / 2;
  const left = entranceX > frame.boundary.w / 2;
  const x = left ? Math.max(0.5, aisle.x) : Math.min(frame.boundary.w - w - 0.5, aisle.x + aisle.w - w);
  return { x: clampNum(x, 0, Math.max(0, frame.boundary.w - w)), y: 0, w, h: aisle.y };
}

/**
 * Bike store near the main entrance: a garden store at the rear for houses, otherwise a room
 * inside the ground floor beside the entrance (architecture turns it into a room).
 */
function bikeStore(
  bikeSpaces: number,
  frame: SiteFrame,
  m: MassingResult,
  mainEntrance: Entrance | null,
  typology: TypologyDef,
): Rect {
  const area = bikeSpaces * BIKE_AREA_PER_SPACE;
  const w = clampNum(Math.sqrt(area * 1.5), 2.0, 12.0);
  const h = clampNum(area / w, 2.2, 10.0);   // at least one 1.8 m rack plus circulation
  const bar = m.massing.bars[0];
  if (typology.access === 'direct') {
    // A garden store behind the house, but only where the rear yard can actually hold it.
    const rearY = Math.max(...m.massing.bars.map(b => b.rect.y + b.rect.h));
    if (frame.boundary.h - rearY >= h + 1.5) {
      return { x: clampNum(bar.rect.x, 0.5, Math.max(0.5, frame.boundary.w - w - 0.5)), y: rearY + 1.0, w, h };
    }
  }
  const ex = mainEntrance ? mainEntrance.position[0] : bar.rect.x + bar.rect.w / 2;
  const x = clampNum(ex + 2.0, bar.rect.x, Math.max(bar.rect.x, bar.rect.x + bar.rect.w - w));
  const y = clampNum(bar.rect.y + 0.3, bar.rect.y, Math.max(bar.rect.y, bar.rect.y + bar.rect.h - h));
  return { x, y, w, h };
}

export function pavingElement(ids: IdFactory, r: Rect, objectType: string, color: [number, number, number], patterns: string[]): ModelElement {
  return {
    id: ids.next(SITE_STOREY, 'PAVE'),
    discipline: 'site',
    ifcType: 'IfcSlab',
    predefinedType: 'BASESLAB',
    name: objectType,
    objectType: 'Paving',
    storey: SITE_STOREY,
    geometry: { kind: 'slab', position: [r.x, r.y, -0.05], profile: relativeTo(rectToPolygon(r), [r.x, r.y]), thickness: 0.05 },
    psets: [pset('Forma_Site', { Category: 'Hardscape', Surface: objectType, Width: round(r.w), Length: round(r.h), Area: round(r.w * r.h, 2) })],
    color,
    patterns,
    tags: ['hardscape', objectType.toLowerCase()],
  };
}
