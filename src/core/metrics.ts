/**
 * The metric sheet: the twenty numbers residential developers, architects and
 * planners across the English-speaking world argue about, plus the engineering
 * numbers that fall out of the discipline models.
 *
 * Ranks 1–20 are the headline metrics (with regional alt names: GIA/GFA,
 * plot ratio/FAR/FSR/FSI, dph/du-per-acre …). Ranks above 20 are supplementary.
 *
 * `computeMetrics` NEVER throws and NEVER returns NaN: every value falls back to
 * a recomputation from the raw model arrays, and finally to 0 with
 * `note: 'unavailable'`. Discipline `derived` maps are consulted first (under
 * several plausible key names) so that a discipline that computes a number
 * properly always wins over the writer's approximation.
 */
import type {
  DesignModel, MetricDef, MetricId, MetricResult, Region, RoomType, UnitInstance,
} from './types.ts';
import {
  fmtArea, fmtDensity, fmtLength, fmtNumber,
  HA_TO_ACRE, KW_TO_TON, M2_TO_FT2, M_TO_FT,
} from './units.ts';
import { polygonArea as polyArea } from './geometry.ts';

// ============================================================================
// Regional benchmarks
// ============================================================================

/** Whole-building energy use intensity proxies (kWh/m²/yr) before WWR adjustment. */
export const EUI_BASE: Record<Region, number> = { US: 120, UK: 90, AU: 80, CA: 130, NZ: 85, IE: 90 };

/** All-in construction cost benchmarks per m² GIA, in local currency. */
export const COST_BENCHMARK: Record<Region, { rate: number; currency: string; symbol: string }> = {
  US: { rate: 2900, currency: 'USD', symbol: '$' },
  CA: { rate: 3300, currency: 'CAD', symbol: 'C$' },
  UK: { rate: 2600, currency: 'GBP', symbol: '£' },
  AU: { rate: 3400, currency: 'AUD', symbol: 'A$' },
  NZ: { rate: 3600, currency: 'NZD', symbol: 'NZ$' },
  IE: { rate: 2800, currency: 'EUR', symbol: '€' },
};

/** Upfront embodied carbon proxies by structural system (kgCO₂e/m² GIA, A1–A5). */
const EMBODIED_BY_SYSTEM: Record<string, number> = {
  'light-wood-frame': 200,
  'masonry-bearing': 320,
  'mass-timber-clt': 250,
  'wood-over-podium': 300,
  'rc-flat-slab': 450,
  'rc-flat-plate-core': 500,
  'steel-frame': 420,
};

/** Maximum permitted travel distance to an exit (m). IBC 1017.2 R-2 / ADB equivalents. */
const EGRESS_LIMIT = { sprinklered: 76, unsprinklered: 61 };

const CIRCULATION_ROOMS = new Set<RoomType>([
  'hall', 'corridor', 'lobby', 'lift-lobby', 'stair', 'elevator', 'shaft', 'mail',
]);

/** Rooms that make up the common circulation + core area of rank 13. */
const CORE_ROOMS = new Set<RoomType>([
  'stair', 'elevator', 'lift-lobby', 'lobby', 'corridor', 'shaft',
]);

const OPEN_SPACE_LANDSCAPE = new Set([
  'lawn', 'planting', 'courtyard', 'playground', 'private-garden', 'communal-garden', 'bioswale',
]);

// ============================================================================
// Metric definitions
// ============================================================================

const AREA_UNIT = { metric: 'm²', imperial: 'sf', factor: M2_TO_FT2 };
const LENGTH_UNIT = { metric: 'm', imperial: 'ft', factor: M_TO_FT };
const PERCENT_UNIT = { metric: '%', imperial: '%', factor: 1 };
const RATIO_UNIT = { metric: 'ratio', imperial: 'ratio', factor: 1 };
const COUNT_UNIT = { metric: 'count', imperial: 'count', factor: 1 };

export const METRICS: MetricDef[] = [
  {
    id: 'gfa', rank: 1, name: 'Gross floor area', category: 'area', unit: AREA_UNIT,
    altNames: { US: 'GFA gross floor area', UK: 'GIA gross internal area', AU: 'GFA gross floor area', NZ: 'GFA', CA: 'GFA', IE: 'GIA' },
    description: 'Total enclosed floor area of every storey, measured to the inside face of the external walls.',
    formula: 'Σ storey floor area',
  },
  {
    id: 'nia', rank: 2, name: 'Net internal area', category: 'area', unit: AREA_UNIT,
    altNames: { US: 'Net rentable / sellable area', UK: 'NIA net internal area', AU: 'NSA net saleable area', NZ: 'NSA', CA: 'Net saleable area', IE: 'NIA' },
    description: 'Usable area inside the dwellings, excluding common circulation, cores, plant and structure.',
    formula: 'Σ dwelling area',
  },
  {
    id: 'efficiency', rank: 3, name: 'Efficiency (net to gross)', category: 'area', unit: PERCENT_UNIT,
    altNames: { UK: 'NIA:GIA efficiency', US: 'Net-to-gross / load factor', AU: 'Efficiency ratio' },
    description: 'Share of the gross area that ends up inside dwellings. Below 70% the plan is carrying too much circulation and core.',
    formula: 'NIA / GIA',
  },
  {
    id: 'far', rank: 4, name: 'Floor area ratio', category: 'density', unit: RATIO_UNIT,
    altNames: { US: 'FAR floor area ratio', UK: 'Plot ratio', AU: 'FSR floor space ratio', NZ: 'Site intensity', CA: 'FSI floor space index', IE: 'Plot ratio' },
    description: 'Gross floor area divided by site area — the single number zoning uses to cap bulk.',
    formula: 'GFA / site area',
  },
  {
    id: 'site-coverage', rank: 5, name: 'Site coverage', category: 'density', unit: PERCENT_UNIT,
    altNames: { UK: 'Site coverage', AU: 'Site cover', US: 'Lot coverage', CA: 'Lot coverage', NZ: 'Building coverage', IE: 'Site coverage' },
    description: 'Share of the site covered by the building footprint.',
    formula: 'footprint area / site area',
  },
  {
    id: 'density-dph', rank: 6, name: 'Density', category: 'density',
    unit: { metric: 'dph', imperial: 'du/ac', factor: 1 / HA_TO_ACRE },
    altNames: { UK: 'Dwellings per hectare (dph)', IE: 'Units per hectare', US: 'Dwelling units per acre (du/ac)', CA: 'Units per hectare', AU: 'Dwellings per hectare', NZ: 'Dwellings per hectare' },
    description: 'Dwellings per hectare of site (dwelling units per acre in the US).',
    formula: 'dwellings / site hectares',
  },
  {
    id: 'unit-count', rank: 7, name: 'Unit count', category: 'program', unit: { metric: 'dwellings', imperial: 'units', factor: 1 },
    altNames: { UK: 'Number of homes', US: 'Unit count', AU: 'Number of dwellings', IE: 'Number of homes' },
    description: 'Total dwellings generated.',
    formula: 'count(units)',
  },
  {
    id: 'unit-mix', rank: 8, name: 'Unit mix (family share)', category: 'program', unit: PERCENT_UNIT,
    altNames: { UK: 'Dwelling mix / family housing share', US: 'Unit mix', AU: 'Apartment mix', IE: 'Dwelling mix' },
    description: 'Share of dwellings with two or more bedrooms (the "family" test in most housing policies). The breakdown gives the count per template.',
    formula: 'count(bedrooms ≥ 2) / count(units)',
  },
  {
    id: 'avg-unit-area', rank: 9, name: 'Average unit area', category: 'program', unit: AREA_UNIT,
    altNames: { UK: 'Average dwelling size (GIA)', US: 'Average unit size', AU: 'Average apartment size' },
    description: 'Mean net internal area per dwelling.',
    formula: 'NIA / dwellings',
  },
  {
    id: 'bedspaces', rank: 10, name: 'Bedspace density', category: 'density',
    unit: { metric: 'bedspaces/ha', imperial: 'bedspaces/ac', factor: 1 / HA_TO_ACRE },
    altNames: { UK: 'Habitable rooms / bedspaces per hectare', IE: 'Bedspaces per hectare', US: 'Bedrooms per acre', AU: 'Bedspaces per hectare' },
    description: 'Design occupancy per hectare — the UK measure that stops dph being gamed with tiny flats.',
    formula: 'Σ occupants / site hectares',
  },
  {
    id: 'building-height', rank: 11, name: 'Building height', category: 'form', unit: LENGTH_UNIT,
    altNames: { UK: 'Height to parapet/ridge', US: 'Building height', AU: 'Overall height', CA: 'Building height' },
    description: 'Height above grade to the top of the roof (parapet or ridge), with the storey count in the breakdown.',
    formula: 'max(storey elevation + height)',
  },
  {
    id: 'floor-to-floor', rank: 12, name: 'Floor-to-floor height', category: 'form', unit: LENGTH_UNIT,
    altNames: { UK: 'Floor-to-floor / floor-to-ceiling', US: 'Floor-to-floor height', AU: 'Floor-to-floor' },
    description: 'Typical residential floor-to-floor, with ground floor and clear ceiling height in the breakdown.',
    formula: 'spec.massing.floorToFloor',
  },
  {
    id: 'circulation-ratio', rank: 13, name: 'Circulation ratio', category: 'access', unit: PERCENT_UNIT,
    altNames: { UK: 'Common circulation ratio', US: 'Circulation / common area factor', AU: 'Common area ratio' },
    description: 'Corridor, lobby and core area as a share of the gross area. The main cost driver a plan can actually control.',
    formula: '(corridor + core area) / GIA',
  },
  {
    id: 'wall-to-floor', rank: 14, name: 'Wall-to-floor ratio', category: 'form', unit: RATIO_UNIT,
    altNames: { UK: 'Wall-to-floor ratio', US: 'Envelope-to-floor ratio', AU: 'Facade efficiency' },
    description: 'External envelope area per m² of floor. Under 0.5 is efficient; over 0.8 means a very articulated or thin plan.',
    formula: 'external wall area / GIA',
  },
  {
    id: 'wwr', rank: 15, name: 'Window-to-wall ratio', category: 'form', unit: PERCENT_UNIT,
    altNames: { UK: 'Glazing ratio', US: 'WWR window-to-wall ratio', AU: 'Glazing ratio', IE: 'Glazing ratio' },
    description: 'Glazed area as a share of the external wall area. Energy codes want 0.25–0.40; daylight wants more.',
    formula: 'window area / external wall area',
  },
  {
    id: 'dual-aspect', rank: 16, name: 'Dual-aspect share', category: 'access', unit: PERCENT_UNIT,
    altNames: { UK: 'Dual aspect homes (London Plan D6)', IE: 'Dual aspect share', US: 'Corner / through-unit share', AU: 'Cross-ventilated apartments (ADG 4B)' },
    description: 'Share of dwellings with windows on two or more orientations — cross ventilation and daylight.',
    formula: 'count(dual or corner aspect) / count(units)',
  },
  {
    id: 'parking-ratio', rank: 17, name: 'Parking ratio', category: 'access', unit: { metric: 'spaces/dwelling', imperial: 'spaces/unit', factor: 1 },
    altNames: { UK: 'Car parking standard', US: 'Parking ratio', AU: 'Car parking rate', CA: 'Parking ratio' },
    description: 'Car spaces per dwelling, against the typology default.',
    formula: 'parking spaces / dwellings',
  },
  {
    id: 'bike-ratio', rank: 17, name: 'Cycle parking ratio', category: 'access', unit: { metric: 'spaces/dwelling', imperial: 'spaces/unit', factor: 1 },
    altNames: { UK: 'Cycle parking standard (London Plan T5)', US: 'Bicycle parking ratio', AU: 'Bicycle parking rate' },
    description: 'Long-stay cycle spaces per dwelling.',
    formula: 'bike spaces / dwellings',
  },
  {
    id: 'open-space-per-unit', rank: 18, name: 'Open space per unit', category: 'open-space', unit: AREA_UNIT,
    altNames: { UK: 'Amenity space per dwelling (London Plan D6)', IE: 'Private amenity space', US: 'Open space per unit', AU: 'Private open space (POS)', NZ: 'Outdoor living space' },
    description: 'Private plus communal external amenity area per dwelling (landscape, courtyards, balconies).',
    formula: '(landscape + courtyard + balcony area) / dwellings',
  },
  {
    id: 'egress-travel', rank: 19, name: 'Egress travel distance', category: 'access', unit: LENGTH_UNIT,
    altNames: { US: 'Exit access travel distance (IBC 1017)', UK: 'Travel distance to a protected stair (ADB)', AU: 'Travel distance (NCC D1.4)', CA: 'Travel distance (NBC 3.4.2.5)' },
    description: 'Longest travel distance from a dwelling door to a protected exit, against the sprinklered / unsprinklered limit.',
    formula: 'max(corridor run + unit depth)',
  },
  {
    id: 'electrical-service', rank: 20, name: 'Electrical service size', category: 'systems', unit: { metric: 'A', imperial: 'A', factor: 1 },
    altNames: { US: 'Service size (NEC 220)', UK: 'Incoming supply capacity', AU: 'Main switchboard rating', CA: 'Service size (CEC)' },
    description: 'Main service ampacity from the demand load calculation.',
    formula: 'demand VA / service voltage',
  },

  // ---- supplementary -------------------------------------------------------
  {
    id: 'structural-tributary', rank: 21, name: 'Structural tributary area', category: 'systems', unit: AREA_UNIT,
    altNames: { UK: 'Tributary area per column', US: 'Tributary area' },
    description: 'Average floor area carried by one column — the sanity check on the grid.',
    formula: 'GIA / column count',
  },
  {
    id: 'plumbing-dfu', rank: 22, name: 'Drainage fixture units', category: 'systems', unit: { metric: 'DFU', imperial: 'DFU', factor: 1 },
    altNames: { US: 'DFU (IPC/UPC)', UK: 'Discharge units (BS EN 12056)', AU: 'Fixture unit rating (AS/NZS 3500)' },
    description: 'Total drainage fixture units, which sizes the building drain and stacks.',
    formula: 'Σ fixture DFU',
  },
  {
    id: 'cooling-load', rank: 23, name: 'Cooling load', category: 'systems',
    unit: { metric: 'kW', imperial: 'tons', factor: KW_TO_TON },
    altNames: { US: 'Cooling load (tons)', UK: 'Cooling duty (kW)', AU: 'Cooling capacity (kW)' },
    description: 'Peak sensible cooling load, with W/m² and tons in the breakdown.',
    formula: 'Σ zone cooling load',
  },
  {
    id: 'embodied-carbon', rank: 24, name: 'Embodied carbon', category: 'sustainability',
    unit: { metric: 'kgCO₂e/m²', imperial: 'kgCO₂e/m²', factor: 1 },
    altNames: { UK: 'Upfront embodied carbon (LETI/RIBA, A1–A5)', US: 'Embodied carbon intensity', AU: 'Upfront carbon', IE: 'Embodied carbon' },
    description: 'Upfront embodied carbon per m² GIA of the modelled structural elements: A1–A5 (product + transport + construction) when the structure model publishes it, A1–A3 otherwise. The note says which.',
    formula: 'structure kgCO₂e (A1–A5) / GIA',
  },
  {
    id: 'eui', rank: 25, name: 'Energy use intensity', category: 'sustainability',
    unit: { metric: 'kWh/m²/yr', imperial: 'kBtu/sf/yr', factor: 0.317 },
    altNames: { UK: 'EUI (LETI target 35 kWh/m²/yr)', US: 'EUI (kBtu/sf/yr)', AU: 'NatHERS / NABERS energy intensity', CA: 'TEUI' },
    description: 'Regional whole-building energy use intensity proxy, adjusted for the achieved glazing ratio.',
    formula: 'regional base × (1 + (WWR − 0.35) × 0.5)',
  },
  {
    id: 'construction-cost', rank: 26, name: 'Construction cost', category: 'economics',
    unit: { metric: 'currency', imperial: 'currency', factor: 1 },
    altNames: { UK: 'Build cost (BCIS £/m²)', US: 'Hard cost ($/sf)', AU: 'Construction cost (A$/m²)', CA: 'Construction cost (C$/m²)' },
    description: 'All-in construction cost from a regional benchmark rate applied to the gross area.',
    formula: 'regional rate × GIA',
  },
  {
    id: 'setback-compliance', rank: 27, name: 'Setback compliance', category: 'form', unit: LENGTH_UNIT,
    altNames: { UK: 'Building line compliance', US: 'Setback compliance', AU: 'Boundary setback compliance' },
    description: 'Smallest margin between an achieved setback and the required one. Negative means an encroachment.',
    formula: 'min(achieved − required) over front/side/rear',
  },
  {
    id: 'facade-area', rank: 28, name: 'Facade area', category: 'form', unit: AREA_UNIT,
    altNames: { UK: 'External envelope area', US: 'Facade area' },
    description: 'Total external wall area including glazing — drives cladding cost and heat loss.',
    formula: 'Σ external wall length × height',
  },
  {
    id: 'storeys', rank: 29, name: 'Storeys above grade', category: 'form', unit: COUNT_UNIT,
    altNames: { UK: 'Number of storeys', US: 'Number of stories', AU: 'Number of levels' },
    description: 'Count of above-grade storeys.',
    formula: 'count(storeys with index ≥ 0)',
  },
];

export function getMetric(id: MetricId): MetricDef {
  const def = METRICS.find(m => m.id === id);
  if (!def) throw new Error(`Unknown metric: ${id}`);
  return def;
}

// ============================================================================
// Computation
// ============================================================================

/** First finite value among the given keys of a `derived` map. */
function derived(source: Record<string, number> | undefined, ...keys: string[]): number | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function finite(value: number | undefined, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function safeDiv(a: number, b: number): number {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(b) > 1e-9 ? a / b : 0;
}

function sum(values: number[]): number {
  let total = 0;
  for (const v of values) if (Number.isFinite(v)) total += v;
  return total;
}

/** `geometry.polygonArea`, tolerant of the missing / degenerate polygons a raw model may hold. */
function polygonArea(points: [number, number][] | undefined): number {
  return points && points.length >= 3 ? polyArea(points) : 0;
}

interface Ctx {
  model: DesignModel;
  region: Region;
  imperial: boolean;
  /** metrics that had to fall back to 0 */
  missing: Set<MetricId>;
  siteArea: number;
  siteHa: number;
  footprintArea: number;
  gia: number;
  giaByStorey: Record<string, number>;
  nia: number;
  units: UnitInstance[];
  unitCount: number;
  bedspaces: number;
  habitableRooms: number;
  circulationArea: number;
  extWallArea: number;
  windowArea: number;
  openSpace: number;
  balconyArea: number;
  landscapeArea: number;
  parkingSpaces: number;
  bikeSpaces: number;
  height: number;
  storeysAbove: number;
  wwr: number;
  dualAspectShare: number;
  familyShare: number;
  mixByTemplate: Record<string, number>;
  egress: number;
  egressLimit: number;
}

function buildContext(model: DesignModel): Ctx {
  const spec = model.spec;
  const site = model.site;
  const arch = model.arch;
  const missing = new Set<MetricId>();

  const siteArea = finite(
    derived(site?.derived, 'siteArea', 'area') ?? site?.area,
    finite(spec.site.width) * finite(spec.site.depth),
  );
  const siteHa = siteArea / 10000;

  const footprintArea = finite(
    derived(site?.derived, 'footprintArea', 'coverageArea')
      ?? site?.massing?.footprintArea
      ?? polygonArea(site?.massing?.footprint as [number, number][] | undefined),
  );

  // --- areas ---------------------------------------------------------------
  const floors = arch?.floors ?? [];
  const giaByStorey: Record<string, number> = {};
  for (const floor of floors) {
    const area = finite(floor.area);
    if (area > 0) giaByStorey[floor.storey] = (giaByStorey[floor.storey] ?? 0) + area;
  }
  let gia = finite(derived(arch?.derived, 'gia', 'gfa', 'grossFloorArea', 'grossInternalArea'));
  if (gia <= 0) gia = sum(Object.values(giaByStorey));
  if (gia <= 0) gia = finite(derived(site?.derived, 'gfa') ?? site?.massing?.gfa);
  if (gia <= 0) missing.add('gfa');

  const units = arch?.units ?? [];
  let nia = finite(derived(arch?.derived, 'nia', 'netInternalArea', 'nsa', 'netSaleableArea'));
  if (nia <= 0) nia = sum(units.map(u => finite(u.area)));
  if (nia <= 0) missing.add('nia');

  const unitCount = units.length > 0 ? units.length : Math.round(finite(derived(arch?.derived, 'unitCount', 'units', 'dwellings')));
  if (unitCount <= 0) missing.add('unit-count');

  // --- program -------------------------------------------------------------
  const rooms = arch?.rooms ?? [];
  let bedspaces = finite(derived(arch?.derived, 'bedspaces', 'occupants'));
  if (bedspaces <= 0) bedspaces = sum(units.map(u => finite(u.occupants)));
  if (bedspaces <= 0) bedspaces = sum(units.map(u => finite(u.bedrooms) + 1));

  let habitableRooms = finite(derived(arch?.derived, 'habitableRooms'));
  if (habitableRooms <= 0) {
    habitableRooms = rooms.filter(r => r.unitId && ['living', 'dining', 'living-kitchen', 'bedroom', 'master-bedroom', 'study', 'den'].includes(r.type)).length;
  }

  // The architecture discipline publishes the corridors and circulation commons as
  // `circulationArea` and the stair / lift / shaft cores separately as `coreArea`;
  // rank 13 is `(corridor + core area) / GIA`, so both keys are added together.
  let circulationArea = finite(derived(arch?.derived, 'circulationArea', 'commonCirculationArea'))
    + finite(derived(arch?.derived, 'coreArea'));
  if (circulationArea <= 0) {
    circulationArea = sum(rooms.filter(r => !r.unitId && (r.zone === 'circulation' || CIRCULATION_ROOMS.has(r.type))).map(r => finite(r.area)));
  }
  if (circulationArea <= 0) {
    // Corridors live on the floor plans (`FloorPlan.corridors`), never on the model root.
    const corridorDefs = floors.flatMap(f => f.corridors ?? []);
    const corridorRoomIds = new Set(corridorDefs.map(c => c.roomId));
    circulationArea = sum(corridorDefs.map(c => polygonArea(c.polygon)))
      + sum(rooms.filter(r => CORE_ROOMS.has(r.type) && !corridorRoomIds.has(r.id)).map(r => finite(r.area)));
  }

  // --- envelope ------------------------------------------------------------
  const walls = arch?.walls ?? [];
  let extWallArea = finite(derived(arch?.derived, 'externalWallArea', 'facadeArea', 'envelopeArea'));
  if (extWallArea <= 0) {
    extWallArea = sum(walls.filter(w => w.isExternal).map(w =>
      Math.hypot(finite(w.end?.[0]) - finite(w.start?.[0]), finite(w.end?.[1]) - finite(w.start?.[1])) * finite(w.height)));
  }
  const windows = arch?.windows ?? [];
  let windowArea = finite(derived(arch?.derived, 'windowArea', 'glazedArea'));
  if (windowArea <= 0) windowArea = sum(windows.map(w => finite(w.width) * finite(w.height)));

  let wwr = finite(derived(arch?.derived, 'wwr', 'windowWallRatio'));
  if (wwr <= 0) wwr = safeDiv(windowArea, extWallArea);
  if (wwr <= 0 && floors.length > 0) wwr = safeDiv(sum(floors.map(f => finite(f.wwr))), floors.filter(f => Number.isFinite(f.wwr)).length);
  if (wwr <= 0) {
    wwr = safeDiv(sum(spec.floors.map(f => finite(f.wwr))), spec.floors.filter(f => typeof f.wwr === 'number').length) || 0.35;
    missing.add('wwr');
  }

  // --- open space ----------------------------------------------------------
  const landscapeArea = sum((site?.landscape ?? [])
    .filter(z => OPEN_SPACE_LANDSCAPE.has(z.type))
    .map(z => finite(z.area) > 0 ? finite(z.area) : polygonArea(z.polygon as [number, number][])));
  const balconyArea = sum(floors.flatMap(f => (f.balconies ?? []).map(b => finite(b.rect?.w) * finite(b.rect?.h))));
  const courtyardArea = polygonArea(site?.massing?.courtyard as [number, number][] | undefined);
  const openSpace = finite(derived(site?.derived, 'openSpace', 'amenityArea'), landscapeArea + balconyArea + courtyardArea);

  // --- parking -------------------------------------------------------------
  const parkingSpaces = site?.parking?.spaces?.length ?? Math.round(finite(derived(site?.derived, 'parkingSpaces', 'carSpaces')));
  const bikeSpaces = finite(site?.parking?.bikeSpaces ?? derived(site?.derived, 'bikeSpaces'));

  // --- height --------------------------------------------------------------
  const aboveGrade = model.storeys.filter(s => s.index >= 0 && s.index < 100);
  let height = finite(derived(site?.derived, 'heightAboveGrade', 'buildingHeight') ?? site?.massing?.heightAboveGrade);
  if (height <= 0 && aboveGrade.length > 0) {
    height = Math.max(...aboveGrade.map(s => finite(s.elevation) + finite(s.height)));
    const roof = model.storeys.find(s => s.id === 'ROOF');
    if (roof) height = Math.max(height, finite(roof.elevation) + finite(roof.height));
  }
  if (height <= 0) {
    height = finite(spec.massing.groundFloorToFloor, 3) + Math.max(0, spec.massing.storeys - 1) * finite(spec.massing.floorToFloor, 3);
  }
  const storeysAbove = aboveGrade.length > 0 ? aboveGrade.length : spec.massing.storeys;

  // --- aspect / mix --------------------------------------------------------
  const mixByTemplate: Record<string, number> = {};
  let family = 0;
  let dual = 0;
  for (const unit of units) {
    mixByTemplate[unit.templateId] = (mixByTemplate[unit.templateId] ?? 0) + 1;
    if (finite(unit.bedrooms) >= 2) family += 1;
    if (unit.aspect === 'dual' || unit.aspect === 'corner') dual += 1;
  }
  const familyShare = unitCount > 0 ? safeDiv(family, unitCount) : 0;
  let dualAspectShare = finite(derived(arch?.derived, 'dualAspectShare'));
  if (dualAspectShare <= 0) dualAspectShare = unitCount > 0 ? safeDiv(dual, unitCount) : 0;

  // --- egress --------------------------------------------------------------
  const sprinklered = model.typology?.sprinklered ?? false;
  const egressLimit = sprinklered ? EGRESS_LIMIT.sprinklered : EGRESS_LIMIT.unsprinklered;
  let egress = finite(derived(arch?.derived, 'maxTravelDistance', 'egressTravelDistance', 'travelDistance'));
  if (egress <= 0) {
    const corridorRun = Math.max(0, ...floors.flatMap(f => f.corridors ?? []).map(c =>
      sum((c.centerline ?? []).map(s => Math.hypot(finite(s.b?.[0]) - finite(s.a?.[0]), finite(s.b?.[1]) - finite(s.a?.[1]))))));
    const unitDepth = Math.max(0, ...units.map(u => finite(u.rect?.h)));
    egress = corridorRun / 2 + unitDepth;
    if (egress <= 0) {
      egress = finite(spec.massing.buildingLength, finite(spec.site.width)) / 2 + finite(spec.massing.buildingDepth, 12) / 2;
      missing.add('egress-travel');
    }
  }

  return {
    model, region: spec.region, imperial: spec.displayUnits === 'imperial', missing,
    siteArea, siteHa, footprintArea, gia, giaByStorey, nia, units, unitCount,
    bedspaces, habitableRooms, circulationArea, extWallArea, windowArea,
    openSpace, balconyArea, landscapeArea, parkingSpaces, bikeSpaces,
    height, storeysAbove, wwr, dualAspectShare, familyShare, mixByTemplate,
    egress, egressLimit,
  };
}

/** Physical dimension of a breakdown entry, for the display-unit conversion. */
type BreakdownDim = 'area' | 'length' | 'hectare';

/**
 * Which breakdown keys carry a physical dimension, per metric. `'*'` covers
 * every key not named explicitly (GFA's breakdown is keyed by storey id, so it
 * cannot be listed). Anything not matched is left exactly as computed: counts,
 * ratios, percentages, currency, amps, DFU, kgCO₂e, and every key whose NAME
 * already states its unit (`ratePerM2`, `wPerM2`, `kBtuPerSfYr`, `kw`, `tons`).
 */
const BREAKDOWN_DIMS: Partial<Record<MetricId, Record<string, BreakdownDim>>> = {
  'gfa': { '*': 'area' },
  'efficiency': { nia: 'area', gia: 'area' },
  'far': { gfa: 'area', siteArea: 'area' },
  'site-coverage': { footprint: 'area', siteArea: 'area' },
  'density-dph': { hectares: 'hectare' },
  'bedspaces': { hectares: 'hectare' },
  'floor-to-floor': { '*': 'length' },
  'circulation-ratio': { circulationArea: 'area', gia: 'area' },
  'wall-to-floor': { externalWallArea: 'area', gia: 'area' },
  'wwr': { windowArea: 'area', externalWallArea: 'area' },
  'open-space-per-unit': { '*': 'area' },
  'egress-travel': { limit: 'length' },
  'plumbing-dfu': { serviceDiameter: 'length' },
  'embodied-carbon': { gia: 'area' },
  'setback-compliance': { '*': 'length' },
  'facade-area': { '*': 'area' },
};

/**
 * Put a breakdown into the SAME unit system as the result's `display` and
 * `unit`.
 *
 * Every metric is COMPUTED in SI (metres, m², hectares) — `MetricResult.value`
 * is always SI and stays that way, because the pipeline, the tests and the
 * zoning comparisons all rely on it. Only the human-facing side is converted,
 * and `breakdown` is part of that side: a report that prints "74,380 sf" next
 * to `{"L03": 1152}` is lying by omission about the 1152.
 *
 * So, for an imperial spec, dimensioned breakdown entries are converted the
 * same way `display` is (m² → sf, m → ft, ha → acres) per
 * {@link BREAKDOWN_DIMS}, and dimensionless ones are passed through. Note that
 * the target is the display UNIT SYSTEM, not the metric's own `unit`: the
 * lengths inside a DFU or a percentage breakdown become feet too.
 */
function toDisplayUnits(
  id: MetricId, breakdown: Record<string, number> | undefined, imperial: boolean,
): Record<string, number> | undefined {
  if (!breakdown || !imperial) return breakdown;
  const dims = BREAKDOWN_DIMS[id];
  if (!dims) return breakdown;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(breakdown)) {
    const dim = dims[key] ?? dims['*'];
    const factor = dim === 'area' ? M2_TO_FT2 : dim === 'length' ? M_TO_FT : dim === 'hectare' ? HA_TO_ACRE : 1;
    // Round away the float noise the conversion introduces (0.0001 sf is 1/100
    // of a square inch), but never round a value that was not converted.
    out[key] = factor === 1 || !Number.isFinite(value) ? value : Math.round(value * factor * 1e4) / 1e4;
  }
  return out;
}

export function computeMetrics(model: DesignModel): MetricResult[] {
  const ctx = buildContext(model);
  const results: MetricResult[] = [];
  for (const def of METRICS) {
    try {
      const result = computeOne(def, ctx);
      results.push(result.breakdown
        ? { ...result, breakdown: toDisplayUnits(def.id, result.breakdown, ctx.imperial) }
        : result);
    } catch (error) {
      results.push({
        id: def.id, value: 0, display: 'n/a', unit: unitLabel(def, ctx),
        status: 'warn', note: `unavailable (${(error as Error).message})`,
      });
    }
  }
  return results;
}

function unitLabel(def: MetricDef, ctx: Ctx): string {
  return ctx.imperial ? def.unit.imperial : def.unit.metric;
}

function areaResult(def: MetricDef, ctx: Ctx, m2: number, extra?: Partial<MetricResult>): MetricResult {
  return {
    id: def.id, value: m2, display: fmtArea(m2, ctx.imperial ? 'imperial' : 'metric'),
    unit: unitLabel(def, ctx), ...extra,
  };
}

function lengthResult(def: MetricDef, ctx: Ctx, m: number, extra?: Partial<MetricResult>): MetricResult {
  const units = ctx.imperial ? 'imperial' : 'metric';
  // fmtLength's feet-and-inches split is only correct for non-negative values.
  const display = m < 0 ? `-${fmtLength(-m, units)}` : fmtLength(m, units);
  return { id: def.id, value: m, display, unit: unitLabel(def, ctx), ...extra };
}

function percentResult(def: MetricDef, ctx: Ctx, ratio: number, extra?: Partial<MetricResult>): MetricResult {
  return {
    id: def.id, value: ratio, display: `${(ratio * 100).toFixed(1)}%`, unit: '%', ...extra,
  };
}

function plainResult(def: MetricDef, ctx: Ctx, value: number, decimals = 2, extra?: Partial<MetricResult>): MetricResult {
  return {
    id: def.id, value, display: `${fmtNumber(value, decimals)} ${unitLabel(def, ctx)}`.trim(),
    unit: unitLabel(def, ctx), ...extra,
  };
}

function unavailable(def: MetricDef, ctx: Ctx, why = 'unavailable'): MetricResult {
  return { id: def.id, value: 0, display: 'n/a', unit: unitLabel(def, ctx), status: 'warn', note: why };
}

function computeOne(def: MetricDef, ctx: Ctx): MetricResult {
  const spec = ctx.model.spec;
  const typology = ctx.model.typology;

  switch (def.id) {
    case 'gfa': {
      if (ctx.gia <= 0) return unavailable(def, ctx);
      return areaResult(def, ctx, ctx.gia, { breakdown: { ...ctx.giaByStorey } });
    }

    case 'nia': {
      if (ctx.nia <= 0) return unavailable(def, ctx);
      return areaResult(def, ctx, ctx.nia, { breakdown: { dwellings: ctx.unitCount } });
    }

    case 'efficiency': {
      const value = safeDiv(ctx.nia, ctx.gia);
      if (value <= 0) return unavailable(def, ctx);
      return percentResult(def, ctx, value, {
        status: value < 0.7 ? 'warn' : 'ok',
        note: value < 0.7 ? 'below the 70% net-to-gross most residential schemes target' : undefined,
        breakdown: { nia: ctx.nia, gia: ctx.gia },
      });
    }

    case 'far': {
      const value = safeDiv(ctx.gia, ctx.siteArea);
      const cap = spec.site.maxFar;
      const status = typeof cap === 'number' && value > cap + 1e-6 ? 'fail' : 'ok';
      return {
        id: def.id, value, display: fmtNumber(value, 2), unit: def.unit.metric, status,
        note: typeof cap === 'number' ? `limit ${fmtNumber(cap, 2)}` : undefined,
        breakdown: { gfa: ctx.gia, siteArea: ctx.siteArea },
      };
    }

    case 'site-coverage': {
      const value = safeDiv(ctx.footprintArea, ctx.siteArea);
      if (value <= 0) return unavailable(def, ctx);
      const cap = spec.site.maxCoverage;
      const status = typeof cap === 'number' && value > cap + 1e-6 ? 'fail' : 'ok';
      return percentResult(def, ctx, value, {
        status,
        note: typeof cap === 'number' ? `limit ${(cap * 100).toFixed(0)}%` : undefined,
        breakdown: { footprint: ctx.footprintArea, siteArea: ctx.siteArea },
      });
    }

    case 'density-dph': {
      if (ctx.unitCount <= 0) return unavailable(def, ctx, 'no dwellings in the model');
      const dph = safeDiv(ctx.unitCount, ctx.siteHa);
      const range = typology?.density;
      const status = range && dph > 0 && (dph < range.min * 0.5 || dph > range.max * 1.5) ? 'warn' : 'ok';
      return {
        id: def.id, value: dph, display: fmtDensity(dph, ctx.imperial ? 'imperial' : 'metric'),
        unit: unitLabel(def, ctx), status,
        note: range ? `typology range ${range.min}–${range.max} dph` : undefined,
        breakdown: { dwellings: ctx.unitCount, hectares: ctx.siteHa },
      };
    }

    case 'unit-count': {
      if (ctx.unitCount <= 0) return unavailable(def, ctx);
      return { id: def.id, value: ctx.unitCount, display: fmtNumber(ctx.unitCount, 0), unit: unitLabel(def, ctx) };
    }

    case 'unit-mix': {
      if (ctx.unitCount <= 0) return unavailable(def, ctx);
      return percentResult(def, ctx, ctx.familyShare, {
        breakdown: { ...ctx.mixByTemplate },
        note: '2-bed and larger share; breakdown = dwellings per template',
      });
    }

    case 'avg-unit-area': {
      const value = safeDiv(ctx.nia, ctx.unitCount);
      if (value <= 0) return unavailable(def, ctx);
      return areaResult(def, ctx, value);
    }

    case 'bedspaces': {
      const value = safeDiv(ctx.bedspaces, ctx.siteHa);
      if (value <= 0) return unavailable(def, ctx);
      return {
        id: def.id, value,
        display: ctx.imperial
          ? `${fmtNumber(value / HA_TO_ACRE, 0)} bedspaces/ac`
          : `${fmtNumber(value, 0)} bedspaces/ha`,
        unit: unitLabel(def, ctx),
        breakdown: { bedspaces: ctx.bedspaces, habitableRooms: ctx.habitableRooms, hectares: ctx.siteHa },
      };
    }

    case 'building-height': {
      const cap = spec.site.maxHeight;
      const status = typeof cap === 'number' && ctx.height > cap + 1e-6 ? 'fail' : 'ok';
      return lengthResult(def, ctx, ctx.height, {
        status,
        note: typeof cap === 'number' ? `limit ${fmtLength(cap, ctx.imperial ? 'imperial' : 'metric')}` : undefined,
        breakdown: { storeys: ctx.storeysAbove },
      });
    }

    case 'floor-to-floor': {
      const typical = finite(spec.massing.floorToFloor, 3);
      const ground = finite(spec.massing.groundFloorToFloor, typical);
      const ceiling = finite(
        spec.floors.find(f => f.index === 1)?.ceilingHeight ?? spec.floors.find(f => f.index === 0)?.ceilingHeight,
        typical - 0.45,
      );
      return lengthResult(def, ctx, typical, {
        status: ceiling < 2.4 ? 'warn' : 'ok',
        note: ceiling < 2.4 ? 'clear ceiling height below the 2.4 m residential minimum' : undefined,
        breakdown: { typical, ground, ceiling },
      });
    }

    case 'circulation-ratio': {
      const value = safeDiv(ctx.circulationArea, ctx.gia);
      if (value <= 0) return unavailable(def, ctx, 'no common circulation rooms in the model');
      return percentResult(def, ctx, value, {
        status: value > 0.2 ? 'warn' : 'ok',
        note: value > 0.2 ? 'over 20% of the gross area is common circulation' : undefined,
        breakdown: { circulationArea: ctx.circulationArea, gia: ctx.gia },
      });
    }

    case 'wall-to-floor': {
      const value = safeDiv(ctx.extWallArea, ctx.gia);
      if (value <= 0) return unavailable(def, ctx);
      return {
        id: def.id, value, display: fmtNumber(value, 2), unit: def.unit.metric,
        status: value > 0.8 ? 'warn' : 'ok',
        note: value > 0.8 ? 'envelope-heavy plan (> 0.8 m² wall per m² floor)' : undefined,
        breakdown: { externalWallArea: ctx.extWallArea, gia: ctx.gia },
      };
    }

    case 'wwr': {
      const value = ctx.wwr;
      const outside = value < 0.25 || value > 0.5;
      return percentResult(def, ctx, value, {
        status: outside ? 'warn' : 'ok',
        note: ctx.missing.has('wwr')
          ? 'from the spec target — no windows in the model'
          : outside ? 'outside the 25–50% band energy codes and daylight both live in' : undefined,
        breakdown: { windowArea: ctx.windowArea, externalWallArea: ctx.extWallArea },
      });
    }

    case 'dual-aspect': {
      if (ctx.unitCount <= 0) return unavailable(def, ctx);
      const londonPlan = ctx.region === 'UK' || ctx.region === 'IE';
      return percentResult(def, ctx, ctx.dualAspectShare, {
        status: londonPlan && ctx.dualAspectShare < 0.5 ? 'warn' : 'ok',
        note: londonPlan && ctx.dualAspectShare < 0.5
          ? 'London Plan D6 expects a majority of dual-aspect homes'
          : undefined,
      });
    }

    case 'parking-ratio': {
      if (ctx.unitCount <= 0) return unavailable(def, ctx);
      const value = safeDiv(ctx.parkingSpaces, ctx.unitCount);
      const target = finite(spec.site.parking?.ratio ?? typology?.parkingRatio);
      const off = target > 0 && (value < target * 0.8 || value > target * 1.2);
      return plainResult(def, ctx, value, 2, {
        status: off ? 'warn' : 'ok',
        note: target > 0 ? `typology default ${fmtNumber(target, 2)} spaces/dwelling` : undefined,
        breakdown: { spaces: ctx.parkingSpaces, dwellings: ctx.unitCount },
      });
    }

    case 'bike-ratio': {
      if (ctx.unitCount <= 0) return unavailable(def, ctx);
      const value = safeDiv(ctx.bikeSpaces, ctx.unitCount);
      const target = finite(spec.site.parking?.bikeRatio ?? typology?.bikeRatio);
      return plainResult(def, ctx, value, 2, {
        status: target > 0 && value < target * 0.8 ? 'warn' : 'ok',
        note: target > 0 ? `typology default ${fmtNumber(target, 2)} spaces/dwelling` : undefined,
        breakdown: { bikeSpaces: ctx.bikeSpaces, dwellings: ctx.unitCount },
      });
    }

    case 'open-space-per-unit': {
      if (ctx.unitCount <= 0) return unavailable(def, ctx);
      const value = safeDiv(ctx.openSpace, ctx.unitCount);
      return areaResult(def, ctx, value, {
        status: value < 5 ? 'warn' : 'ok',
        note: value < 5 ? 'less than 5 m² of amenity space per dwelling' : undefined,
        breakdown: { landscape: ctx.landscapeArea, balconies: ctx.balconyArea, total: ctx.openSpace },
      });
    }

    case 'egress-travel': {
      const status = ctx.egress > ctx.egressLimit ? 'fail' : ctx.egress > ctx.egressLimit * 0.9 ? 'warn' : 'ok';
      return lengthResult(def, ctx, ctx.egress, {
        status,
        note: `${typology?.sprinklered ? 'sprinklered' : 'unsprinklered'} limit ${ctx.egressLimit} m${ctx.missing.has('egress-travel') ? ' (estimated from massing)' : ''}`,
        breakdown: { limit: ctx.egressLimit },
      });
    }

    case 'electrical-service': {
      const elec = ctx.model.elec;
      const amps = finite(derived(elec?.derived, 'serviceAmps', 'amps') ?? elec?.service?.amps);
      if (amps <= 0) return unavailable(def, ctx, 'electrical model not generated');
      return plainResult(def, ctx, amps, 0, {
        breakdown: {
          amps,
          connectedVa: finite(elec?.loads?.connectedVa),
          demandVa: finite(elec?.loads?.demandVa),
          perUnitVa: finite(elec?.loads?.perUnitVa),
        },
        note: elec?.service ? `${elec.service.voltage}, ${elec.service.phases}-phase` : undefined,
      });
    }

    case 'structural-tributary': {
      const struct = ctx.model.struct;
      if (!struct) return unavailable(def, ctx, 'structure model not generated');
      const fromDerived = finite(derived(struct.derived, 'tributaryArea', 'avgTributaryArea'));
      if (fromDerived > 0) return areaResult(def, ctx, fromDerived);
      const storeysWithColumns = new Set(struct.columns.map(c => c.storey)).size || 1;
      const columnsPerStorey = struct.columns.length / storeysWithColumns;
      const value = columnsPerStorey > 0 ? safeDiv(ctx.gia / Math.max(ctx.storeysAbove, 1), columnsPerStorey) : 0;
      if (value <= 0) return unavailable(def, ctx, 'no columns (wall-bearing structure)');
      return areaResult(def, ctx, value, { breakdown: { columns: struct.columns.length, columnsPerStorey } });
    }

    case 'plumbing-dfu': {
      const plumb = ctx.model.plumb;
      const dfu = finite(derived(plumb?.derived, 'dfu', 'totalDfu') ?? plumb?.totals?.dfu);
      if (dfu <= 0) return unavailable(def, ctx, 'plumbing model not generated');
      return plainResult(def, ctx, dfu, 0, {
        breakdown: {
          dfu,
          wsfu: finite(plumb?.totals?.wsfu),
          fixtures: finite(plumb?.totals?.fixtureCount),
          serviceDiameter: finite(plumb?.totals?.serviceDiameter),
        },
      });
    }

    case 'cooling-load': {
      const mech = ctx.model.mech;
      const kw = finite(derived(mech?.derived, 'totalCoolingKw', 'coolingKw') ?? mech?.loads?.totalCoolingKw);
      if (kw <= 0) return unavailable(def, ctx, 'mechanical model not generated');
      const tons = kw * KW_TO_TON;
      return {
        id: def.id, value: kw, unit: unitLabel(def, ctx),
        display: ctx.imperial ? `${fmtNumber(tons, 1)} tons` : `${fmtNumber(kw, 1)} kW`,
        breakdown: {
          kw, tons,
          wPerM2: finite(mech?.loads?.coolingWPerM2, safeDiv(kw * 1000, ctx.gia)),
          heatingKw: finite(mech?.loads?.totalHeatingKw),
        },
      };
    }

    case 'embodied-carbon': {
      const struct = ctx.model.struct;
      const total = finite(derived(struct?.derived, 'embodiedCarbonKgCO2e', 'embodiedCarbonKgCo2e', 'embodiedCarbon', 'kgCo2e'));
      // Structure publishes two intensities for the elements it modelled:
      // `embodiedCarbonPerM2` is A1–A3 (product stage) and
      // `embodiedCarbonA1A5PerM2` adds transport + construction. The upfront
      // number LETI/RIBA and the benchmarks in EMBODIED_BY_SYSTEM all quote is
      // A1–A5, so prefer it and say which scope the answer is in.
      const a1a5 = finite(derived(struct?.derived, 'embodiedCarbonA1A5PerM2'));
      const a1a3 = finite(derived(struct?.derived, 'embodiedCarbonPerM2', 'embodiedCarbonIntensity'));
      let intensity = a1a5 > 0 ? a1a5 : a1a3;
      let scope = a1a5 > 0 ? 'A1–A5' : 'A1–A3';
      let estimated = false;
      if (intensity <= 0 && total > 0) intensity = safeDiv(total, ctx.gia);
      if (intensity <= 0) {
        const system = struct?.system ?? typology?.structure ?? 'light-wood-frame';
        intensity = EMBODIED_BY_SYSTEM[system] ?? 350;
        scope = 'A1–A5';
        estimated = true;
      }
      const note = estimated
        ? `structure ${scope} estimate, benchmark for ${struct?.system ?? typology?.structure ?? 'unknown system'}`
        : `structure ${scope} estimate (modelled structural elements only)`;
      return {
        id: def.id, value: intensity, display: `${fmtNumber(intensity, 0)} kgCO₂e/m²`, unit: def.unit.metric,
        status: intensity > 600 ? 'warn' : 'ok',
        note,
        breakdown: {
          intensity,
          ...(a1a3 > 0 ? { a1a3 } : {}),
          ...(a1a5 > 0 ? { a1a5 } : {}),
          total: total > 0 ? total : intensity * ctx.gia,
          gia: ctx.gia,
        },
      };
    }

    case 'eui': {
      const base = EUI_BASE[ctx.region] ?? 110;
      const value = base * (1 + (ctx.wwr - 0.35) * 0.5);
      const kBtu = value * 0.317;
      return {
        id: def.id, value, unit: unitLabel(def, ctx),
        display: ctx.imperial ? `${fmtNumber(kBtu, 1)} kBtu/sf/yr` : `${fmtNumber(value, 0)} kWh/m²/yr`,
        status: value > base * 1.2 ? 'warn' : 'ok',
        note: `${ctx.region} proxy ${base} kWh/m²/yr adjusted for ${(ctx.wwr * 100).toFixed(0)}% glazing`,
        breakdown: { base, adjusted: value, kBtuPerSfYr: kBtu, wwr: ctx.wwr },
      };
    }

    case 'construction-cost': {
      const benchmark = COST_BENCHMARK[ctx.region] ?? COST_BENCHMARK.US;
      const total = benchmark.rate * ctx.gia;
      const perSf = benchmark.rate / M2_TO_FT2;
      return {
        id: def.id, value: total, unit: benchmark.currency,
        display: `${benchmark.symbol}${Math.round(total).toLocaleString('en-US')} (${benchmark.symbol}${ctx.imperial ? `${Math.round(perSf)}/sf` : `${Math.round(benchmark.rate)}/m²`})`,
        note: `${benchmark.currency} benchmark rate × GIA`,
        breakdown: {
          total,
          ratePerM2: benchmark.rate,
          ratePerSf: perSf,
          perDwelling: safeDiv(total, ctx.unitCount),
        },
      };
    }

    case 'setback-compliance': {
      const required = {
        front: finite(spec.site.setbacks?.front ?? typology?.setbacks?.front),
        side: finite(spec.site.setbacks?.side ?? typology?.setbacks?.side),
        rear: finite(spec.site.setbacks?.rear ?? typology?.setbacks?.rear),
      };
      const achieved = ctx.model.site?.setbacks;
      if (!achieved) return unavailable(def, ctx, 'site model has no setbacks');
      const slack = {
        front: finite(achieved.front) - required.front,
        side: finite(achieved.side) - required.side,
        rear: finite(achieved.rear) - required.rear,
      };
      const worst = Math.min(slack.front, slack.side, slack.rear);
      return lengthResult(def, ctx, worst, {
        status: worst < -1e-6 ? 'fail' : 'ok',
        note: worst < -1e-6 ? 'building encroaches into a required setback' : 'all setbacks met',
        breakdown: { ...slack, requiredFront: required.front, requiredSide: required.side, requiredRear: required.rear },
      });
    }

    case 'facade-area': {
      const value = ctx.extWallArea;
      if (value <= 0) return unavailable(def, ctx);
      return areaResult(def, ctx, value, {
        breakdown: { opaque: Math.max(value - ctx.windowArea, 0), glazed: ctx.windowArea },
      });
    }

    case 'storeys': {
      return {
        id: def.id, value: ctx.storeysAbove, display: fmtNumber(ctx.storeysAbove, 0), unit: 'storeys',
        breakdown: {
          aboveGrade: ctx.storeysAbove,
          basements: ctx.model.storeys.filter(s => s.index < 0 && s.index > -100).length,
          podium: finite(spec.massing.podiumStoreys),
        },
      };
    }

    default:
      return unavailable(def, ctx, 'not implemented');
  }
}
