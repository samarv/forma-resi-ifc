/**
 * Hand-built mock DesignModel for UI development: a 2-storey, 4-unit walk-up bar
 * with a real (if small) slice of every discipline, plus mock metric definitions,
 * unit templates and an IFC writer. Used when the real generator is not bundled
 * (`--mock`) or when the page is opened with `?mock=1`.
 *
 * Nothing here is authoritative geometry — it exists so every tab renders.
 */
import type {
  AirTerminal, ArchModel, BalconyDef, BuildingSpec, CableTrayRun, CoreDef, CorridorDef, DesignModel,
  DoorDef, DuctRun, ElecDevice, ElecModel, ElecPanel, ElementGeometry, FloorPlan, FurnitureDef,
  FurnitureType, GridLine, IfcOutput, LandscapeZone, MechEquipment, MechModel, MetricDef, MetricId,
  MetricResult, ModelElement, ParkingSpace, Pattern, PatternApplication, PipeRun, PlumbModel,
  PlumbingFixture, PlumbingStack, Polygon, Rect, RoomDef, RoomType, ShaftDef, SiteModel, StairDef,
  StoreyDef, StructBeam, StructColumn, StructModel, UnitInstance, UnitTemplateDef, UnitTemplateId,
  WallDef, WindowDef, Zone,
} from '../core/types.ts';
import { normalizeSpec, buildStoreys, UNIT_TEMPLATE_IDS, type PartialSpec } from '../core/spec.ts';
import { getTypology, TYPOLOGIES } from '../core/typologies.ts';
import { CROSS_PATTERNS } from '../core/patterns.ts';

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function rectPoly(r: Rect): Polygon {
  return [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]];
}
function sub(r: Rect, dx: number, dy: number, w: number, h: number): Rect {
  return { x: r.x + dx, y: r.y + dy, w, h };
}
const ZONE_OF: Partial<Record<RoomType, Zone>> = {
  'living-kitchen': 'public', living: 'public', bedroom: 'private', bathroom: 'service',
  hall: 'circulation', closet: 'service', balcony: 'outdoor', corridor: 'circulation',
  stair: 'circulation', 'lift-lobby': 'circulation', shaft: 'service', lobby: 'circulation',
};

// ---------------------------------------------------------------------------
// mock unit templates (20 ids, plausible numbers)
// ---------------------------------------------------------------------------

const TPL_SEED: Record<UnitTemplateId, [beds: number, baths: number, area: number]> = {
  'micro-studio': [0, 1, 24], studio: [0, 1, 35], 'junior-1b': [1, 1, 42], '1b1b': [1, 1, 52],
  '1b-den': [1, 1, 60], '2b1b': [2, 1, 68], '2b2b': [2, 2, 78], '3b2b': [3, 2, 98],
  '4b2b': [4, 2, 120], 'dual-key': [2, 2, 84], 'corner-2b2b': [2, 2, 86], 'loft-live-work': [1, 1, 70],
  'maisonette-2s': [2, 2, 92], 'townhouse-2s': [3, 2, 110], 'townhouse-3s': [4, 3, 140],
  'ranch-3b': [3, 2, 130], 'colonial-4b': [4, 3, 185], 'adu-1b': [1, 1, 45],
  'coliving-cluster': [6, 3, 190], 'senior-1b-accessible': [1, 1, 58],
};

export const MOCK_TEMPLATES: UnitTemplateDef[] = UNIT_TEMPLATE_IDS.map((id) => {
  const [bedrooms, bathrooms, area] = TPL_SEED[id];
  const label = id.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return {
    id,
    name: label,
    regionalNames: { UK: label.replace('Apartment', 'Flat'), AU: label, CA: label, NZ: label, IE: label },
    description: `${bedrooms === 0 ? 'Studio' : `${bedrooms}-bedroom`} dwelling, ${bathrooms} bath, ~${area} m² NIA (mock template).`,
    bedrooms,
    bathrooms,
    occupants: Math.max(1, bedrooms + 1),
    area: { min: area * 0.9, target: area, max: area * 1.15 },
    frontage: { min: 3.6, max: 9.5 },
    depth: { min: 7, max: 12.5 },
    storeysInUnit: id.includes('-2s') ? 2 : id.includes('-3s') ? 3 : 1,
    aspect: id.startsWith('corner') ? 'corner' : bedrooms >= 2 ? 'dual' : 'single',
    rooms: [],
    suitableTypologies: Object.keys(TYPOLOGIES) as UnitTemplateDef['suitableTypologies'],
    patterns: ['ARC-01', 'XD-01'],
  } satisfies UnitTemplateDef;
});

// ---------------------------------------------------------------------------
// mock metric definitions (full MetricId set; ranks 1..20 are the headline set)
// ---------------------------------------------------------------------------

type MDef = [MetricId, number, string, MetricDef['category'], string, string];
const MDEFS: MDef[] = [
  ['gfa', 1, 'Gross floor area', 'area', 'm²', 'sf'],
  ['nia', 2, 'Net internal area', 'area', 'm²', 'sf'],
  ['efficiency', 3, 'Net-to-gross efficiency', 'area', '%', '%'],
  ['unit-count', 4, 'Dwelling count', 'program', 'units', 'units'],
  ['unit-mix', 5, 'Unit mix', 'program', 'units', 'units'],
  ['avg-unit-area', 6, 'Average unit area', 'program', 'm²', 'sf'],
  ['far', 7, 'Floor area ratio', 'density', 'FAR', 'FAR'],
  ['site-coverage', 8, 'Site coverage', 'density', '%', '%'],
  ['density-dph', 9, 'Residential density', 'density', 'dph', 'du/ac'],
  ['building-height', 10, 'Building height', 'form', 'm', 'ft'],
  ['storeys', 11, 'Storeys', 'form', 'storeys', 'storeys'],
  ['circulation-ratio', 12, 'Circulation ratio', 'access', '%', '%'],
  ['bedspaces', 13, 'Bedspaces', 'program', 'people', 'people'],
  ['wwr', 14, 'Window-to-wall ratio', 'form', '%', '%'],
  ['dual-aspect', 15, 'Dual-aspect units', 'access', '%', '%'],
  ['parking-ratio', 16, 'Parking ratio', 'systems', 'sp/unit', 'sp/unit'],
  ['open-space-per-unit', 17, 'Open space per unit', 'open-space', 'm²', 'sf'],
  ['egress-travel', 18, 'Max egress travel', 'access', 'm', 'ft'],
  ['eui', 19, 'Energy use intensity', 'sustainability', 'kWh/m²·a', 'kBtu/sf·a'],
  ['construction-cost', 20, 'Construction cost', 'economics', '$/m²', '$/sf'],
  ['floor-to-floor', 21, 'Floor-to-floor', 'form', 'm', 'ft'],
  ['wall-to-floor', 22, 'Wall-to-floor ratio', 'form', 'ratio', 'ratio'],
  ['facade-area', 23, 'Facade area', 'form', 'm²', 'sf'],
  ['bike-ratio', 24, 'Bicycle parking ratio', 'systems', 'sp/unit', 'sp/unit'],
  ['setback-compliance', 25, 'Setback compliance', 'form', 'm', 'ft'],
  ['structural-tributary', 26, 'Structural tributary area', 'systems', 'm²', 'sf'],
  ['electrical-service', 27, 'Electrical service', 'systems', 'A', 'A'],
  ['plumbing-dfu', 28, 'Drainage fixture units', 'systems', 'DFU', 'DFU'],
  ['cooling-load', 29, 'Peak cooling load', 'systems', 'kW', 'tons'],
  ['embodied-carbon', 30, 'Embodied carbon', 'sustainability', 'kgCO₂e/m²', 'kgCO₂e/sf'],
];

export const MOCK_METRICS: MetricDef[] = MDEFS.map(([id, rank, name, category, mu, iu]) => ({
  id,
  rank,
  name,
  altNames: { UK: name, AU: name, NZ: name, CA: name, IE: name },
  category,
  unit: { metric: mu, imperial: iu, factor: 1 },
  description: `${name} (mock definition — the real definition lives in src/core/metrics.ts).`,
  formula: `${id} = mock()`,
}));

// ---------------------------------------------------------------------------
// the mock model
// ---------------------------------------------------------------------------

interface Ctx {
  els: ModelElement[];
  seq: number;
}
function push(ctx: Ctx, e: Omit<ModelElement, 'id'> & { id?: string }): ModelElement {
  const el: ModelElement = { ...e, id: e.id ?? `MOCK-${++ctx.seq}` } as ModelElement;
  ctx.els.push(el);
  return el;
}

function wallGeom(w: WallDef): ElementGeometry {
  return { kind: 'wall', start: [w.start[0], w.start[1], 0], end: [w.end[0], w.end[1], 0], thickness: w.thickness, height: w.height };
}

export function buildMockModel(input: PartialSpec): DesignModel {
  const spec: BuildingSpec = normalizeSpec({ ...input, massing: { ...input.massing, storeys: 2 } });
  const typology = getTypology(spec.typology);
  const storeys: StoreyDef[] = buildStoreys(spec, spec.floors, 1.2, spec.region);
  const above = storeys.filter((s) => s.index >= 0 && s.index < 100);
  const ctx: Ctx = { els: [], seq: 0 };

  // --- site ----------------------------------------------------------------
  const W = Math.max(26, spec.site.width);
  const D = Math.max(20, spec.site.depth);
  const boundary: Polygon = [[0, 0], [W, 0], [W, D], [0, D]];
  const setbacks = { front: 5, side: 3, rear: 6 };
  const env: Rect = { x: setbacks.side, y: setbacks.front, w: W - 2 * setbacks.side, h: D - setbacks.front - setbacks.rear };
  const bldg: Rect = { x: env.x, y: env.y, w: Math.min(env.w, 24), h: Math.min(env.h, 12) };
  const footprint = rectPoly(bldg);

  const parking: ParkingSpace[] = [];
  for (let i = 0; i < 6; i++) {
    parking.push({
      id: `SIT-SITE-STALL-${String(i + 1).padStart(3, '0')}`,
      rect: { x: 2 + i * 2.7, y: D - 5.2, w: 2.5, h: 5 },
      rotation: 0,
      type: i === 0 ? 'accessible' : i < 3 ? 'ev' : 'standard',
      storey: 'SITE',
    });
  }
  const landscape: LandscapeZone[] = [
    { id: 'SIT-LZ-1', type: 'lawn', polygon: rectPoly({ x: 1, y: 1, w: W - 2, h: setbacks.front - 1.5 }), area: (W - 2) * (setbacks.front - 1.5) },
    { id: 'SIT-LZ-2', type: 'communal-garden', polygon: rectPoly({ x: 2, y: bldg.y + bldg.h + 0.6, w: W - 4, h: 3.2 }), area: (W - 4) * 3.2 },
  ];
  for (let i = 0; i < 5; i++) {
    landscape.push({ id: `SIT-TREE-${i + 1}`, type: 'tree', polygon: rectPoly({ x: 3 + i * 5.4, y: 1.8, w: 2.4, h: 2.4 }), area: 4.5 });
  }
  for (const p of parking) {
    push(ctx, {
      discipline: 'site', ifcType: 'IfcAnnotation', name: `Parking stall ${p.type}`, storey: 'SITE', id: p.id,
      geometry: { kind: 'prism', position: [p.rect.x, p.rect.y, 0], profile: rectPoly({ x: 0, y: 0, w: p.rect.w, h: p.rect.h }), height: 0.02 },
      color: [0.55, 0.55, 0.52], patterns: ['SIT-07'], tags: [p.type],
    });
  }
  for (const lz of landscape) {
    push(ctx, {
      discipline: 'site', ifcType: 'IfcGeographicElement', predefinedType: 'SOIL_BOARD', name: `Landscape ${lz.type}`, storey: 'SITE', id: lz.id,
      geometry: { kind: 'prism', position: [0, 0, 0], profile: lz.polygon, height: 0.05 },
      color: [0.32, 0.55, 0.3], patterns: ['SIT-03'],
    });
  }

  const site: SiteModel = {
    boundary,
    area: W * D,
    buildableEnvelope: rectPoly(env),
    setbacks,
    streetFacing: spec.site.streetFacing,
    northRad: 0,
    massing: {
      shape: 'bar',
      footprint,
      footprintArea: bldg.w * bldg.h,
      bars: [{ id: 'BAR-1', rect: bldg, axis: 'x', depth: bldg.h, length: bldg.w, exteriorSides: ['front', 'rear', 'left', 'right'] }],
      storeys,
      heightAboveGrade: above.reduce((a, s) => a + s.height, 0),
      gfa: bldg.w * bldg.h * above.length,
      cores: [{ id: 'CORE-1', rect: { x: bldg.x, y: bldg.y, w: 4, h: 6 }, barId: 'BAR-1', type: 'stair-elevator', hasElevator: true, elevatorCount: 1 }],
      corridors: [{ id: 'SPINE-1', barId: 'BAR-1', centerline: { a: [bldg.x + 4, bldg.y + 0.8], b: [bldg.x + bldg.w, bldg.y + 0.8] }, width: 1.6, loaded: 'right' }],
      roof: { type: 'flat', pitchRad: 0, parapetHeight: 1.1, ridgeAxis: 'x' },
    },
    parking: { type: 'surface', spaces: parking, aisles: [{ x: 1, y: D - 10.4, w: W - 2, h: 5 }], bikeSpaces: 8, storey: 'SITE' },
    landscape,
    paths: [{ x: bldg.x + 1.4, y: 0.5, w: 1.6, h: bldg.y - 0.5 }],
    driveway: { x: 1, y: D - 10.6, w: 3.2, h: 10 },
    entrances: [{ id: 'ENT-1', position: [bldg.x + 2.2, bldg.y], side: 'front', type: 'main' }],
    elements: ctx.els.slice(),
    patterns: [
      { patternId: 'SIT-01', storey: 'SITE', params: { frontSetback: 5, sideSetback: 3 }, note: 'Street wall alignment (mock)' },
      { patternId: 'SIT-07', storey: 'SITE', elementIds: parking.map((p) => p.id), params: { stalls: parking.length, evShare: 0.33 } },
    ],
    derived: { siteArea: W * D, coverage: (bldg.w * bldg.h) / (W * D) },
  };

  // --- architecture --------------------------------------------------------
  const arch = buildArch(ctx, spec, storeys, above, bldg);

  // --- structure -----------------------------------------------------------
  const struct = spec.options.structure ? buildStruct(ctx, above, bldg) : null;
  const mech = spec.options.mechanical ? buildMech(ctx, above, bldg, arch) : null;
  const plumb = spec.options.plumbing ? buildPlumb(ctx, above, arch) : null;
  const elec = spec.options.electrical ? buildElec(ctx, above, bldg, arch) : null;

  const elements = ctx.els;
  const units = arch.units;
  const gfa = bldg.w * bldg.h * above.length;
  const nia = units.reduce((a, u) => a + u.area, 0);
  const height = above.reduce((a, s) => a + s.height, 0);
  const mix: Record<string, number> = {};
  for (const u of units) mix[u.templateId] = (mix[u.templateId] ?? 0) + 1;
  const gfaByStorey: Record<string, number> = {};
  for (const s of above) gfaByStorey[s.name] = bldg.w * bldg.h;

  const metrics: MetricResult[] = [
    m('gfa', gfa, `${gfa.toFixed(0)} m²`, 'm²', 'ok', 'Measured to the outside face of the external wall.', gfaByStorey),
    m('nia', nia, `${nia.toFixed(0)} m²`, 'm²', 'ok'),
    m('efficiency', (nia / gfa) * 100, `${((nia / gfa) * 100).toFixed(1)} %`, '%', (nia / gfa) > 0.75 ? 'ok' : 'warn', 'Target ≥ 78 % for a double-loaded bar.'),
    m('unit-count', units.length, String(units.length), 'units', 'ok'),
    m('unit-mix', units.length, Object.entries(mix).map(([k, v]) => `${v}×${k}`).join(', '), 'units', 'ok', undefined, mix),
    m('avg-unit-area', nia / units.length, `${(nia / units.length).toFixed(1)} m²`, 'm²', 'ok'),
    m('far', gfa / site.area, (gfa / site.area).toFixed(2), 'FAR', 'ok', 'No zoning FAR limit set.'),
    m('site-coverage', (bldg.w * bldg.h) / site.area * 100, `${((bldg.w * bldg.h) / site.area * 100).toFixed(1)} %`, '%', 'ok'),
    m('density-dph', units.length / (site.area / 10000), `${(units.length / (site.area / 10000)).toFixed(0)} dph`, 'dph', 'warn', 'Below the typology range (mock).'),
    m('building-height', height, `${height.toFixed(2)} m`, 'm', 'ok'),
    m('storeys', above.length, String(above.length), 'storeys', 'ok'),
    m('circulation-ratio', 14.2, '14.2 %', '%', 'warn', 'Single stair core, 1.6 m corridor.'),
    m('bedspaces', units.length * 2, String(units.length * 2), 'people', 'ok'),
    m('wwr', 32, '32 %', '%', 'ok', undefined, { front: 18, rear: 41, left: 24, right: 24 }),
    m('dual-aspect', 50, '50 %', '%', 'warn', 'Two of four dwellings are single-aspect.'),
    m('parking-ratio', 1.5, '1.5 sp/unit', 'sp/unit', 'fail', 'Exceeds the 1.0 sp/unit urban maximum.'),
    m('open-space-per-unit', 26.4, '26.4 m²', 'm²', 'ok'),
    m('egress-travel', 18.6, '18.6 m', 'm', 'ok', 'Limit 22.9 m (IBC 1017.2, sprinklered).'),
    m('eui', 78, '78 kWh/m²·a', 'kWh/m²·a', 'warn'),
    m('construction-cost', 2450, '$2,450 /m²', '$/m²', 'ok'),
    m('floor-to-floor', spec.massing.floorToFloor ?? 2.9, `${(spec.massing.floorToFloor ?? 2.9).toFixed(2)} m`, 'm', 'ok'),
    m('wall-to-floor', 0.42, '0.42', 'ratio', 'ok'),
    m('facade-area', 2 * (bldg.w + bldg.h) * height, `${(2 * (bldg.w + bldg.h) * height).toFixed(0)} m²`, 'm²', 'ok'),
    m('bike-ratio', 2, '2.0 sp/unit', 'sp/unit', 'ok'),
    m('electrical-service', 400, '400 A', 'A', 'ok'),
    m('plumbing-dfu', plumb?.totals.dfu ?? 0, String(plumb?.totals.dfu ?? 0), 'DFU', 'ok'),
    m('cooling-load', 24.5, '24.5 kW', 'kW', 'ok'),
    m('embodied-carbon', 410, '410 kgCO₂e/m²', 'kgCO₂e/m²', 'warn'),
  ];

  const book: Pattern[] = [...CROSS_PATTERNS, ...MOCK_EXTRA_PATTERNS];
  const applications: PatternApplication[] = [
    ...site.patterns,
    ...arch.patterns,
    ...(struct?.patterns ?? []),
    ...(mech?.patterns ?? []),
    ...(plumb?.patterns ?? []),
    ...(elec?.patterns ?? []),
  ].filter((a) => book.some((p) => p.id === a.patternId));

  return {
    spec,
    typology,
    storeys,
    site,
    arch,
    struct,
    mech,
    plumb,
    elec,
    elements,
    metrics,
    patterns: { book, applications },
    warnings: [
      'MOCK MODEL — the real generator is not bundled in this build; geometry and metrics are placeholders.',
      'Unit mix ignores the requested weights in mock mode.',
    ],
    timings: { site: 0.4, architecture: 1.9, structure: 0.6, mechanical: 0.5, plumbing: 0.4, electrical: 0.7, metrics: 0.2 },
  };
}

function m(
  id: MetricId, value: number, display: string, unit: string,
  status: MetricResult['status'], note?: string, breakdown?: Record<string, number>,
): MetricResult {
  return { id, value, display, unit, status, note, breakdown };
}

const MOCK_EXTRA_PATTERNS: Pattern[] = [
  {
    id: 'SIT-01', name: 'Street Wall Alignment', discipline: 'site',
    problem: 'Buildings set back at random break the street edge and leave useless slivers of land.',
    solution: 'Hold the front facade on a single line at the front setback; push parking and service behind the building line.',
    parameters: { frontSetback: { value: 5, unit: 'm', source: 'typology default' } },
    references: ['Alexander APL #122 (Building Fronts)'],
  },
  {
    id: 'SIT-07', name: 'Parking Behind the Building Line', discipline: 'site',
    problem: 'Surface parking in front of a residential building destroys the street frontage.',
    solution: 'Place stalls in the rear yard, reached by a single 3.2 m driveway; accessible and EV stalls closest to the entrance.',
    parameters: { stallWidth: { value: 2.5, unit: 'm', source: 'default' }, evShare: { value: 0.33, unit: 'fraction', source: 'spec' } },
    dependsOn: ['SIT-01'],
  },
  {
    id: 'ARC-01', name: 'Unit Zoning Front to Back', discipline: 'architecture',
    problem: 'Bedrooms beside the front door and living rooms with no daylight make a dwelling unusable.',
    solution: 'Service and circulation rooms sit on the access side; living and sleeping rooms take the external facade.',
    parameters: { serviceBandDepth: { value: 2.6, unit: 'm', source: 'default' } },
    references: ['Alexander APL #127 (Intimacy Gradient)'],
    dependsOn: ['XD-01'],
  },
  {
    id: 'ARC-03', name: 'Corridor Service Spine', discipline: 'architecture',
    problem: 'A corridor that only moves people wastes the one continuous horizontal route in the building.',
    solution: 'Keep a 1.6 m clear corridor with a 0.45 m ceiling plenum reserved for ducts, pipes and trays.',
    parameters: { clearWidth: { value: 1.6, unit: 'm', source: 'code:IBC 1020.2' }, plenum: { value: 0.45, unit: 'm', source: 'default' } },
    dependsOn: ['XD-02'],
  },
  {
    id: 'STR-01', name: 'Grid on Party Walls', discipline: 'structure',
    problem: 'A structural grid that ignores the unit rhythm puts columns in living rooms.',
    solution: 'Grid lines follow party and corridor walls at one unit frontage; 6 m bays here.',
    parameters: { bay: { value: 6, unit: 'm', source: 'derived' } },
    dependsOn: ['XD-03'],
  },
  {
    id: 'MEC-01', name: 'Per-unit Ducted Heat Pump', discipline: 'mechanical',
    problem: 'Central air systems in small residential buildings need shafts the plan cannot spare.',
    solution: 'One ducted indoor unit per dwelling in the service band; supply trunk in the unit hall ceiling.',
    parameters: { supplyLsPerM2: { value: 1.4, unit: 'L/s·m²', source: 'ASHRAE 62.2' } },
  },
  {
    id: 'PLB-01', name: 'One Stack per Wet Wall', discipline: 'plumbing',
    problem: 'Scattered fixtures multiply stacks and slab penetrations.',
    solution: 'Every dwelling backs its bathroom and kitchen onto one wet wall carrying a single DWV stack.',
    parameters: { maxTrapArm: { value: 3, unit: 'm', source: 'code:IPC 1002.2' } },
    dependsOn: ['XD-01'],
  },
  {
    id: 'ELE-01', name: 'Panel at the Unit Entry', discipline: 'electrical',
    problem: 'Unit panels buried in bedrooms cannot be reached for maintenance.',
    solution: 'Each dwelling panel sits in the entry hall within 1 m of the door, fed from the corridor tray.',
    parameters: { panelAmps: { value: 100, unit: 'A', source: 'default' } },
    dependsOn: ['XD-02'],
  },
];

// ---------------------------------------------------------------------------
// architecture
// ---------------------------------------------------------------------------

function buildArch(ctx: Ctx, spec: BuildingSpec, storeys: StoreyDef[], above: StoreyDef[], bldg: Rect): ArchModel {
  const walls: WallDef[] = [];
  const doors: DoorDef[] = [];
  const windows: WindowDef[] = [];
  const rooms: RoomDef[] = [];
  const units: UnitInstance[] = [];
  const furniture: FurnitureDef[] = [];
  const floors: FloorPlan[] = [];
  const balconies: BalconyDef[] = [];
  const stairs: StairDef[] = [];
  const corridorDefs: CorridorDef[] = [];
  const patterns: PatternApplication[] = [];

  const coreRect: Rect = { x: bldg.x, y: bldg.y, w: 4, h: 6 };
  const shaftRect: Rect = { x: bldg.x + 4.15, y: bldg.y + 0.2, w: 0.8, h: 1.2 };
  const corridorY = bldg.y + 1.7;
  const unitW = (bldg.w - 4) / 2;

  const core: CoreDef = {
    id: 'ARC-CORE-1', rect: coreRect, storeys: above.map((s) => s.id), type: 'stair-elevator',
    stairIds: [], elevatorIds: ['ARC-LIFT-1'], roomIds: [], isExit: true,
  };
  const shaft: ShaftDef = {
    id: 'ARC-SHAFT-1', rect: shaftRect, storeys: above.map((s) => s.id), purpose: 'combined',
    servesUnitIds: [], accessFrom: 'corridor',
  };

  for (const st of above) {
    const sid = st.id;
    const f2f = st.height;
    const wallH = f2f - 0.25;
    const isGround = st.index === 0;

    // perimeter
    const P = rectPoly(bldg);
    const extIds: string[] = [];
    for (let i = 0; i < 4; i++) {
      const a = P[i], b = P[(i + 1) % 4];
      const id = `ARC-${sid}-WALL-E${i + 1}`;
      walls.push({
        id, storey: sid, start: a, end: b, thickness: 0.3, height: wallH, type: 'exterior',
        isExternal: true, loadBearingHint: true, fireRating: '1 h',
        exposure: (['S', 'E', 'N', 'W'] as const)[i],
      });
      extIds.push(id);
    }
    // party wall + core walls + corridor wall
    walls.push({
      id: `ARC-${sid}-WALL-P1`, storey: sid, start: [bldg.x + 4 + unitW, corridorY], end: [bldg.x + 4 + unitW, bldg.y + bldg.h],
      thickness: 0.25, height: wallH, type: 'party', isExternal: false, loadBearingHint: true, fireRating: '1 h',
    });
    walls.push({
      id: `ARC-${sid}-WALL-C1`, storey: sid, start: [bldg.x + 4, bldg.y], end: [bldg.x + 4, bldg.y + 6],
      thickness: 0.2, height: wallH, type: 'core', isExternal: false, loadBearingHint: true, fireRating: '2 h',
    });
    const corrWallId = `ARC-${sid}-WALL-K1`;
    walls.push({
      id: corrWallId, storey: sid, start: [bldg.x + 4, corridorY], end: [bldg.x + bldg.w, corridorY],
      thickness: 0.15, height: wallH, type: 'corridor', isExternal: false, loadBearingHint: false, fireRating: '1 h',
    });

    // corridor + core rooms
    const corrRect: Rect = { x: bldg.x + 4, y: bldg.y + 0.15, w: bldg.w - 4, h: corridorY - bldg.y - 0.15 };
    const corrRoom = mkRoom(rooms, sid, undefined, 'corridor', 'Corridor', corrRect, st.height - 0.45);
    corridorDefs.push({
      id: `ARC-${sid}-CORR-1`, storey: sid, polygon: rectPoly(corrRect),
      centerline: [{ a: [corrRect.x, corrRect.y + corrRect.h / 2], b: [corrRect.x + corrRect.w, corrRect.y + corrRect.h / 2] }],
      width: corrRect.h, roomId: corrRoom.id,
    });
    const stairRoom = mkRoom(rooms, sid, undefined, 'stair', 'Stair', { x: coreRect.x + 0.2, y: coreRect.y + 1.6, w: 2.4, h: 4.2 }, st.height - 0.45);
    const liftRoom = mkRoom(rooms, sid, undefined, 'elevator', 'Lift', { x: coreRect.x + 2.7, y: coreRect.y + 1.6, w: 1.1, h: 1.6 }, st.height - 0.45);
    const shaftRoom = mkRoom(rooms, sid, undefined, 'shaft', 'Services shaft', shaftRect, st.height - 0.45);
    core.roomIds.push(stairRoom.id, liftRoom.id);
    stairs.push({
      id: `ARC-${sid}-STAIR-1`, coreId: core.id, storey: sid, position: [coreRect.x + 0.5, coreRect.y + 1.8],
      direction: Math.PI / 2, risers: Math.round(f2f / 0.175), riserHeight: 0.175, tread: 0.28, width: 1.1, flights: 2, isExit: true,
    });
    if (isGround) {
      mkRoom(rooms, sid, undefined, 'lobby', 'Entrance lobby', { x: coreRect.x + 0.2, y: coreRect.y + 0.2, w: 3.6, h: 1.2 }, st.height - 0.45);
      doors.push({
        id: `ARC-${sid}-DOOR-ENT`, storey: sid, wallId: `ARC-${sid}-WALL-E1`, along: 2.2, width: 1.8, height: 2.2,
        type: 'building-entry', operation: 'DOUBLE_DOOR_SINGLE_SWING', fireRated: false,
      });
    }

    // two units per floor
    for (let u = 0; u < 2; u++) {
      const uRect: Rect = { x: bldg.x + 4 + u * unitW, y: corridorY, w: unitW, h: bldg.y + bldg.h - corridorY };
      const uid = `U-${sid}-${String(u + 1).padStart(2, '0')}`;
      const tpl: UnitTemplateId = u === 0 ? '2b1b' : '1b1b';
      const roomIds: string[] = [];

      const hall = mkRoom(rooms, sid, uid, 'hall', 'Hall', sub(uRect, 0.1, 0.1, 2.3, 2.4), st.height - 0.45);
      const bath = mkRoom(rooms, sid, uid, 'bathroom', 'Bathroom', sub(uRect, 2.5, 0.1, 2.4, 2.4), st.height - 0.45);
      const closet = mkRoom(rooms, sid, uid, 'closet', 'Closet', sub(uRect, 5.0, 0.1, 1.2, 2.4), st.height - 0.45);
      const livW = Math.max(4, uRect.w * 0.55);
      const liv = mkRoom(rooms, sid, uid, 'living-kitchen', 'Living / kitchen', sub(uRect, 0.1, 2.6, livW, uRect.h - 2.8), st.height - 0.45);
      const bed = mkRoom(rooms, sid, uid, 'bedroom', 'Bedroom', sub(uRect, livW + 0.3, 2.6, uRect.w - livW - 0.5, uRect.h - 2.8), st.height - 0.45);
      roomIds.push(hall.id, bath.id, closet.id, liv.id, bed.id);

      // partitions
      const parts: [number, number, number, number][] = [
        [uRect.x + 2.4, corridorY, uRect.x + 2.4, corridorY + 2.5],
        [uRect.x + 4.9, corridorY, uRect.x + 4.9, corridorY + 2.5],
        [uRect.x + 6.2, corridorY, uRect.x + 6.2, corridorY + 2.5],
        [uRect.x, corridorY + 2.5, uRect.x + uRect.w, corridorY + 2.5],
        [uRect.x + livW + 0.2, corridorY + 2.5, uRect.x + livW + 0.2, uRect.y + uRect.h],
      ];
      parts.forEach(([x1, y1, x2, y2], i) => {
        walls.push({
          id: `ARC-${sid}-WALL-U${u + 1}-${i + 1}`, storey: sid, start: [x1, y1], end: [x2, y2],
          thickness: i === 0 || i === 1 ? 0.2 : 0.12, height: wallH,
          type: i === 0 || i === 1 ? 'wet' : 'partition', isExternal: false, loadBearingHint: false, unitId: uid,
        });
      });

      // doors
      doors.push({
        id: `ARC-${sid}-DOOR-U${u + 1}-ENT`, storey: sid, wallId: corrWallId, along: (u + 0.5) * unitW, width: 0.95, height: 2.1,
        type: 'unit-entry', operation: 'SINGLE_SWING_LEFT', fireRated: true, unitId: uid, toRoomId: hall.id, fromRoomId: corrRoom.id,
      });
      doors.push({
        id: `ARC-${sid}-DOOR-U${u + 1}-BATH`, storey: sid, wallId: `ARC-${sid}-WALL-U${u + 1}-1`, along: 1.4, width: 0.8, height: 2.05,
        type: 'interior', operation: 'SINGLE_SWING_RIGHT', unitId: uid, fromRoomId: hall.id, toRoomId: bath.id,
      });
      doors.push({
        id: `ARC-${sid}-DOOR-U${u + 1}-BED`, storey: sid, wallId: `ARC-${sid}-WALL-U${u + 1}-5`, along: 1.2, width: 0.85, height: 2.05,
        type: 'interior', operation: 'SINGLE_SWING_LEFT', unitId: uid, fromRoomId: liv.id, toRoomId: bed.id,
      });

      // windows on the rear wall (index 2 of the perimeter = y = max)
      const rearWall = `ARC-${sid}-WALL-E3`;
      const wallLen = bldg.w;
      windows.push({
        id: `ARC-${sid}-WIN-U${u + 1}-1`, storey: sid, wallId: rearWall,
        along: wallLen - ((uRect.x - bldg.x) + livW / 2), sill: 0.9, width: 2.4, height: 1.5,
        roomId: liv.id, unitId: uid, exposure: 'N',
      });
      windows.push({
        id: `ARC-${sid}-WIN-U${u + 1}-2`, storey: sid, wallId: rearWall,
        along: wallLen - ((uRect.x - bldg.x) + livW + (uRect.w - livW) / 2), sill: 0.9, width: 1.5, height: 1.5,
        roomId: bed.id, unitId: uid, exposure: 'N',
      });

      // balcony on upper floors
      let balconyRoomId: string | undefined;
      if (!isGround) {
        const bRect: Rect = { x: uRect.x + 1, y: bldg.y + bldg.h, w: 3.2, h: 1.5 };
        const bRoom = mkRoom(rooms, sid, uid, 'balcony', 'Balcony', bRect, 2.4);
        balconyRoomId = bRoom.id;
        roomIds.push(bRoom.id);
        balconies.push({ id: `ARC-${sid}-BAL-U${u + 1}`, storey: sid, unitId: uid, rect: bRect, roomId: bRoom.id });
        push(ctx, {
          discipline: 'architecture', ifcType: 'IfcSlab', predefinedType: 'BALCONY', name: 'Balcony slab', storey: sid,
          id: `ARC-${sid}-BALSLAB-U${u + 1}`,
          geometry: { kind: 'slab', position: [bRect.x, bRect.y, -0.18], profile: rectPoly({ x: 0, y: 0, w: bRect.w, h: bRect.h }), thickness: 0.18 },
          unitId: uid, roomId: bRoom.id, color: [0.72, 0.71, 0.68], patterns: ['ARC-09'],
        });
      }

      if (spec.options.furniture) {
        const fSpec: [FurnitureType, number, number, number, number, number][] = [
          ['bed-queen', bed.rect.x + 0.4, bed.rect.y + 0.4, 1.6, 2.1, 0.55],
          ['nightstand', bed.rect.x + 0.4, bed.rect.y + 2.6, 0.45, 0.45, 0.55],
          ['wardrobe', bed.rect.x + 0.4, bed.rect.y + bed.rect.h - 0.7, 1.8, 0.6, 2.1],
          ['sofa-3', liv.rect.x + 0.4, liv.rect.y + liv.rect.h - 1.3, 2.1, 0.9, 0.8],
          ['coffee-table', liv.rect.x + 0.9, liv.rect.y + liv.rect.h - 2.5, 1.1, 0.6, 0.4],
          ['dining-table-4', liv.rect.x + 0.6, liv.rect.y + 0.9, 1.4, 0.9, 0.75],
          ['kitchen-counter', liv.rect.x + livW - 2.9, liv.rect.y + 0.1, 2.6, 0.62, 0.9],
          ['fridge', liv.rect.x + livW - 0.9, liv.rect.y + 0.1, 0.7, 0.7, 1.8],
          ['range', liv.rect.x + livW - 2.2, liv.rect.y + 0.1, 0.6, 0.62, 0.9],
          ['kitchen-sink', liv.rect.x + livW - 2.9, liv.rect.y + 0.1, 0.8, 0.6, 0.2],
          ['wc', bath.rect.x + 0.25, bath.rect.y + 0.2, 0.4, 0.7, 0.8],
          ['lavatory', bath.rect.x + 1.0, bath.rect.y + 0.2, 0.6, 0.45, 0.85],
          ['shower', bath.rect.x + bath.rect.w - 1.0, bath.rect.y + bath.rect.h - 1.0, 0.9, 0.9, 2.0],
          ['washer', closet.rect.x + 0.1, closet.rect.y + 0.1, 0.6, 0.6, 0.85],
        ];
        for (const [type, x, y, w, d, h] of fSpec) {
          const roomOf = type === 'wc' || type === 'lavatory' || type === 'shower' ? bath
            : type === 'washer' ? closet
            : type.startsWith('bed') || type === 'wardrobe' || type === 'nightstand' ? bed : liv;
          const fid = `ARC-${sid}-FURN-U${u + 1}-${furniture.length + 1}`;
          furniture.push({
            id: fid, storey: sid, roomId: roomOf.id, unitId: uid, type, position: [x, y], width: w, depth: d, height: h,
            rotation: 0, needsWater: ['wc', 'lavatory', 'shower', 'kitchen-sink', 'washer'].includes(type),
            needsPower: ['fridge', 'range', 'washer'].includes(type),
          });
          roomOf.furnitureIds.push(fid);
          push(ctx, {
            discipline: 'architecture', ifcType: 'IfcFurnishingElement', name: type, storey: sid, id: fid,
            geometry: { kind: 'box', position: [x, y, 0], width: w, depth: d, height: h, rotation: 0 },
            unitId: uid, roomId: roomOf.id, color: [0.62, 0.6, 0.56], patterns: ['ARC-11'],
          });
        }
      }

      units.push({
        id: uid, templateId: tpl, storeys: [sid], rect: uRect, polygon: rectPoly(uRect),
        area: uRect.w * uRect.h, bedrooms: u === 0 ? 2 : 1, bathrooms: 1, occupants: u === 0 ? 3 : 2,
        aspect: u === 0 ? 'dual' : 'single', accessSide: 'front',
        entryDoorId: `ARC-${sid}-DOOR-U${u + 1}-ENT`, roomIds,
        wetWallIds: [`ARC-${sid}-WALL-U${u + 1}-1`], kitchenRoomId: liv.id, bathroomRoomIds: [bath.id],
        balconyRoomId, barId: 'BAR-1', coreId: core.id,
      });
      shaft.servesUnitIds.push(uid);
      patterns.push({ patternId: 'ARC-01', storey: sid, unitId: uid, params: { serviceBandDepth: 2.6, aspect: u === 0 ? 'dual' : 'single' } });
    }

    patterns.push({ patternId: 'ARC-03', storey: sid, elementIds: [corrWallId], params: { clearWidth: 1.6, plenum: 0.45 } });

    // elements for walls / doors / windows / slab
    for (const w of walls.filter((x) => x.storey === sid)) {
      push(ctx, {
        discipline: 'architecture', ifcType: 'IfcWall', predefinedType: w.isExternal ? 'SOLIDWALL' : 'PARTITIONING',
        name: `${w.type} wall`, storey: sid, id: w.id, geometry: wallGeom(w),
        color: w.isExternal ? [0.2, 0.2, 0.19] : [0.55, 0.54, 0.5], unitId: w.unitId,
        patterns: w.type === 'wet' ? ['XD-01'] : undefined,
        psets: [{ name: 'Pset_WallCommon', properties: [{ name: 'IsExternal', value: w.isExternal }, { name: 'FireRating', value: w.fireRating ?? '' }] }],
      });
    }
    for (const d of doors.filter((x) => x.storey === sid)) {
      push(ctx, {
        discipline: 'architecture', ifcType: 'IfcDoor', predefinedType: 'DOOR', name: d.type, storey: sid, id: d.id,
        geometry: { kind: 'door-in-wall', hostId: d.wallId, along: d.along, width: d.width, height: d.height, operation: d.operation },
        unitId: d.unitId, color: [0.45, 0.35, 0.25],
      });
    }
    for (const w of windows.filter((x) => x.storey === sid)) {
      push(ctx, {
        discipline: 'architecture', ifcType: 'IfcWindow', predefinedType: 'WINDOW', name: 'Window', storey: sid, id: w.id,
        geometry: { kind: 'window-in-wall', hostId: w.wallId, along: w.along, sill: w.sill, width: w.width, height: w.height },
        unitId: w.unitId, roomId: w.roomId, color: [0.35, 0.55, 0.7],
      });
    }
    push(ctx, {
      discipline: 'architecture', ifcType: 'IfcSlab', predefinedType: 'FLOOR', name: 'Floor slab', storey: sid,
      id: `ARC-${sid}-SLAB-001`,
      geometry: { kind: 'slab', position: [bldg.x, bldg.y, -0.25], profile: rectPoly({ x: 0, y: 0, w: bldg.w, h: bldg.h }), thickness: 0.25 },
      color: [0.78, 0.77, 0.74], patterns: ['STR-01'],
    });
    for (const r of rooms.filter((x) => x.storey === sid)) {
      push(ctx, {
        discipline: 'architecture', ifcType: 'IfcSpace', predefinedType: 'SPACE', name: r.name, storey: sid,
        id: `ARC-${sid}-SPACE-${r.id}`,
        geometry: { kind: 'prism', position: [r.rect.x, r.rect.y, 0], profile: rectPoly({ x: 0, y: 0, w: r.rect.w, h: r.rect.h }), height: r.height },
        roomId: r.id, unitId: r.unitId, color: [0.8, 0.82, 0.85],
        quantities: [{ name: 'Qto_SpaceBaseQuantities', quantities: [{ name: 'NetFloorArea', value: r.area, kind: 'IfcQuantityArea' }] }],
      });
    }

    floors.push({
      storey: sid,
      use: st.use === 'site' || st.use === 'foundation' ? 'residential' : st.use,
      outline: rectPoly(bldg), area: bldg.w * bldg.h, floorToFloor: f2f,
      ceilingHeight: f2f - 0.45, slabThickness: 0.25,
      corridors: corridorDefs.filter((c) => c.storey === sid),
      unitIds: units.filter((u) => u.storeys.includes(sid)).map((u) => u.id),
      roomIds: rooms.filter((r) => r.storey === sid).map((r) => r.id),
      commonRoomIds: rooms.filter((r) => r.storey === sid && !r.unitId).map((r) => r.id),
      wallIds: walls.filter((w) => w.storey === sid).map((w) => w.id),
      exteriorWallIds: extIds,
      balconies: balconies.filter((b) => b.storey === sid),
      wwr: 0.32,
    });
  }

  // roof + foundation storeys
  const roofStorey = storeys.find((s) => s.index === 100);
  if (roofStorey) {
    push(ctx, {
      discipline: 'architecture', ifcType: 'IfcRoof', predefinedType: 'FLAT_ROOF', name: 'Roof', storey: roofStorey.id,
      id: 'ARC-ROOF-001',
      geometry: { kind: 'roof', position: [bldg.x, bldg.y, 0], width: bldg.w, depth: bldg.h, thickness: 0.3 },
      color: [0.6, 0.59, 0.56], patterns: ['ARC-12'],
    });
    for (let i = 0; i < 4; i++) {
      const P = rectPoly(bldg);
      const a = P[i], b = P[(i + 1) % 4];
      push(ctx, {
        discipline: 'architecture', ifcType: 'IfcWall', predefinedType: 'PARAPET', name: 'Parapet', storey: roofStorey.id,
        id: `ARC-ROOF-PARAPET-${i + 1}`,
        geometry: { kind: 'wall', start: [a[0], a[1], 0], end: [b[0], b[1], 0], thickness: 0.25, height: 1.1 },
        color: [0.3, 0.3, 0.28],
      });
    }
  }

  return {
    storeys, floors, units, rooms, walls, doors, windows, furniture,
    cores: [core], stairs, elevators: [{ id: 'ARC-LIFT-1', coreId: core.id, rect: { x: coreRect.x + 2.7, y: coreRect.y + 1.6, w: 1.1, h: 1.6 }, storeys: above.map((s) => s.id), capacityKg: 630 }],
    shafts: [shaft],
    roof: { type: 'flat', outline: rectPoly(bldg), thickness: 0.3, pitchRad: 0, ridgeAxis: 'x', parapetHeight: 1.1 },
    templatesUsed: ['2b1b', '1b1b'],
    elements: ctx.els.filter((e) => e.discipline === 'architecture'),
    patterns,
    derived: { unitCount: units.length, nia: units.reduce((a, u) => a + u.area, 0) },
  };
}

function mkRoom(
  rooms: RoomDef[], storey: string, unitId: string | undefined, type: RoomType, name: string, rect: Rect, height: number,
): RoomDef {
  const r: RoomDef = {
    id: `R-${unitId ?? storey}-${type.toUpperCase().replace(/[^A-Z0-9]/g, '')}${rooms.length + 1}`,
    storey, unitId, type, name, polygon: rectPoly(rect), rect, area: rect.w * rect.h, height,
    isWet: type === 'bathroom' || type === 'living-kitchen',
    hasExterior: type !== 'hall' && type !== 'closet' && type !== 'bathroom',
    exteriorWallIds: [], wallIds: [], doorIds: [], windowIds: [], furnitureIds: [],
    occupancy: type === 'bedroom' ? 2 : 1, zone: ZONE_OF[type] ?? 'service',
  };
  rooms.push(r);
  return r;
}

// ---------------------------------------------------------------------------
// structure / mechanical / plumbing / electrical
// ---------------------------------------------------------------------------

function buildStruct(ctx: Ctx, above: StoreyDef[], bldg: Rect): StructModel {
  const grid: GridLine[] = [];
  const bays = 4;
  for (let i = 0; i <= bays; i++) grid.push({ id: String(i + 1), axis: 'x', offset: bldg.x + (bldg.w / bays) * i });
  grid.push({ id: 'A', axis: 'y', offset: bldg.y });
  grid.push({ id: 'B', axis: 'y', offset: bldg.y + bldg.h });
  const columns: StructColumn[] = [];
  const beams: StructBeam[] = [];
  const patterns: PatternApplication[] = [];

  for (const st of above) {
    for (const gx of grid.filter((g) => g.axis === 'x')) {
      for (const gy of grid.filter((g) => g.axis === 'y')) {
        const id = `STR-${st.id}-COL-${gx.id}${gy.id}`;
        columns.push({ id, storey: st.id, position: [gx.offset, gy.offset], width: 0.4, depth: 0.4, height: st.height, gridRef: `${gx.id}-${gy.id}`, material: 'concrete' });
        push(ctx, {
          discipline: 'structure', ifcType: 'IfcColumn', name: `Column ${gx.id}${gy.id}`, storey: st.id, id,
          geometry: { kind: 'column', position: [gx.offset, gy.offset, 0], width: 0.4, depth: 0.4, height: st.height },
          color: [0.29, 0.23, 0.65], patterns: ['STR-01'],
        });
      }
    }
    for (const gy of grid.filter((g) => g.axis === 'y')) {
      const id = `STR-${st.id}-BEAM-${gy.id}`;
      beams.push({ id, storey: st.id, start: [bldg.x, gy.offset], end: [bldg.x + bldg.w, gy.offset], z: st.height - 0.5, width: 0.3, depth: 0.5, material: 'concrete', role: 'primary' });
      push(ctx, {
        discipline: 'structure', ifcType: 'IfcBeam', name: `Beam ${gy.id}`, storey: st.id, id,
        geometry: { kind: 'beam', start: [bldg.x, gy.offset, st.height - 0.5], end: [bldg.x + bldg.w, gy.offset, st.height - 0.5], width: 0.3, height: 0.5 },
        color: [0.29, 0.23, 0.65], patterns: ['STR-01'],
      });
    }
    patterns.push({ patternId: 'STR-01', storey: st.id, params: { bay: bldg.w / bays }, elementIds: columns.filter((c) => c.storey === st.id).map((c) => c.id) });
  }
  return {
    system: 'rc-flat-slab', foundation: 'strip-footing', grid, columns, beams,
    walls: [], slabs: above.map((st) => ({ id: `STR-${st.id}-SLAB`, storey: st.id, outline: rectPoly(bldg), thickness: 0.25, type: 'floor' as const, openings: [] })),
    foundations: [{ id: 'STR-FND-RAFT', type: 'raft', rect: bldg, height: 0.5 }],
    sizes: { columnW: 0.4, columnD: 0.4, beamW: 0.3, beamD: 0.5, slabT: 0.25, shearWallT: 0.25 },
    loads: { deadKpa: 4.2, liveKpa: 1.9, roofLiveKpa: 1.0 },
    plenumClearance: { corridorSoffitZ: 2.45 },
    elements: ctx.els.filter((e) => e.discipline === 'structure'),
    patterns,
    derived: { columnCount: columns.length },
  };
}

function buildMech(ctx: Ctx, above: StoreyDef[], bldg: Rect, arch: ArchModel): MechModel {
  const ducts: DuctRun[] = [];
  const terminals: AirTerminal[] = [];
  const equipment: MechEquipment[] = [];
  const patterns: PatternApplication[] = [];
  for (const st of above) {
    const z = st.height - 0.35;
    const trunk: DuctRun = {
      id: `MEC-${st.id}-DUCT-001`, storey: st.id, systemType: 'supply',
      path: [[bldg.x + 4.5, bldg.y + 0.9, z], [bldg.x + bldg.w - 1, bldg.y + 0.9, z]],
      shape: 'rect', width: 0.4, height: 0.2, servesRoomIds: [],
    };
    ducts.push(trunk);
    push(ctx, {
      discipline: 'mechanical', ifcType: 'IfcDuctSegment', predefinedType: 'RIGIDSEGMENT', name: 'Supply trunk', storey: st.id, id: trunk.id,
      geometry: { kind: 'axis', start: trunk.path[0], end: trunk.path[1], profile: { type: 'rect', width: 0.4, height: 0.2 } },
      system: 'SYS-MEC-SUPPLY', color: [0.16, 0.47, 0.84], patterns: ['XD-02', 'MEC-01'],
    });
    for (const u of arch.units.filter((x) => x.storeys.includes(st.id))) {
      const c: [number, number] = [u.rect.x + u.rect.w / 2, u.rect.y + u.rect.h / 2];
      const branch: DuctRun = {
        id: `MEC-${st.id}-DUCT-${u.id}`, storey: st.id, systemType: 'supply',
        path: [[c[0], bldg.y + 0.9, z], [c[0], c[1], z]], shape: 'round', width: 0.2, height: 0.2,
        servesRoomIds: u.roomIds, unitId: u.id,
      };
      ducts.push(branch);
      push(ctx, {
        discipline: 'mechanical', ifcType: 'IfcDuctSegment', predefinedType: 'RIGIDSEGMENT', name: 'Supply branch', storey: st.id, id: branch.id,
        geometry: { kind: 'axis', start: branch.path[0], end: branch.path[1], profile: { type: 'circle', radius: 0.1 } },
        system: 'SYS-MEC-SUPPLY', unitId: u.id, color: [0.16, 0.47, 0.84], patterns: ['MEC-01'],
      });
      for (const rid of u.roomIds.slice(0, 3)) {
        const room = arch.rooms.find((r) => r.id === rid)!;
        const t: AirTerminal = {
          id: `MEC-${st.id}-DIFF-${rid}`, storey: st.id, type: 'supply-diffuser', roomId: rid,
          position: [room.rect.x + room.rect.w / 2, room.rect.y + room.rect.h / 2, st.height - 0.45],
          width: 0.3, depth: 0.3, airflowLs: 35,
        };
        terminals.push(t);
        push(ctx, {
          discipline: 'mechanical', ifcType: 'IfcAirTerminal', predefinedType: 'DIFFUSER', name: 'Supply diffuser', storey: st.id, id: t.id,
          geometry: { kind: 'box', position: [t.position[0] - 0.15, t.position[1] - 0.15, t.position[2]], width: 0.3, depth: 0.3, height: 0.05 },
          system: 'SYS-MEC-SUPPLY', unitId: u.id, roomId: rid, color: [0.16, 0.47, 0.84], patterns: ['MEC-01'],
        });
      }
      const eq: MechEquipment = {
        id: `MEC-${st.id}-AHU-${u.id}`, storey: st.id, type: 'indoor-unit', unitId: u.id,
        position: [u.rect.x + 0.4, u.rect.y + 0.4, st.height - 0.8], width: 1.0, depth: 0.6, height: 0.35, rotation: 0, capacityKw: 5.3,
      };
      equipment.push(eq);
      push(ctx, {
        discipline: 'mechanical', ifcType: 'IfcUnitaryEquipment', predefinedType: 'AIRHANDLER', name: 'Ducted indoor unit', storey: st.id, id: eq.id,
        geometry: { kind: 'box', position: eq.position, width: eq.width, depth: eq.depth, height: eq.height, rotation: 0 },
        system: 'SYS-MEC-SUPPLY', unitId: u.id, color: [0.16, 0.47, 0.84], patterns: ['MEC-01'],
      });
      patterns.push({ patternId: 'MEC-01', storey: st.id, unitId: u.id, params: { capacityKw: 5.3 }, elementIds: [eq.id] });
    }
  }
  return {
    system: 'ducted-heat-pump', ventilation: 'erv-per-unit', equipment, ducts, terminals,
    risers: [{ id: 'MEC-RISER-1', shaftId: 'ARC-SHAFT-1', systemType: 'exhaust', fromStorey: above[0].id, toStorey: above[above.length - 1].id, xy: [4.3, 0.6], width: 0.3, height: 0.3, shape: 'round' }],
    plantRoomIds: [],
    loads: { coolingWPerM2: 65, heatingWPerM2: 45, ventilationLsPerPerson: 7.5, totalCoolingKw: 24.5, totalHeatingKw: 18.2 },
    elements: ctx.els.filter((e) => e.discipline === 'mechanical'),
    patterns,
    derived: { ductLength: ducts.length * 6 },
  };
}

function buildPlumb(ctx: Ctx, above: StoreyDef[], arch: ArchModel): PlumbModel {
  const fixtures: PlumbingFixture[] = [];
  const pipes: PipeRun[] = [];
  const stacks: PlumbingStack[] = [];
  const patterns: PatternApplication[] = [];
  const FIX: [PlumbingFixture['type'], number, number][] = [['wc', 6, 3], ['lavatory', 1, 1], ['shower', 2, 2], ['kitchen-sink', 2, 1.5]];
  for (const st of above) {
    for (const u of arch.units.filter((x) => x.storeys.includes(st.id))) {
      const bath = arch.rooms.find((r) => r.id === u.bathroomRoomIds[0])!;
      FIX.forEach(([type, dfu, wsfu], i) => {
        const room = type === 'kitchen-sink' ? arch.rooms.find((r) => r.id === u.kitchenRoomId)! : bath;
        const f: PlumbingFixture = {
          id: `PLB-${st.id}-FIX-${u.id}-${i + 1}`, storey: st.id, type, roomId: room.id, unitId: u.id,
          position: [room.rect.x + 0.4 + i * 0.7, room.rect.y + 0.35, 0], rotation: 0, width: 0.5, depth: 0.5, height: 0.8,
          connections: type === 'wc' ? ['dcw', 'waste', 'vent'] : ['dcw', 'dhw', 'waste', 'vent'], dfu, wsfu,
        };
        fixtures.push(f);
        push(ctx, {
          discipline: 'plumbing', ifcType: 'IfcSanitaryTerminal', predefinedType: type === 'wc' ? 'TOILETPAN' : type === 'lavatory' ? 'WASHHANDBASIN' : type === 'shower' ? 'SHOWER' : 'SINK',
          name: type, storey: st.id, id: f.id,
          geometry: { kind: 'box', position: f.position, width: f.width, depth: f.depth, height: f.height, rotation: 0 },
          system: 'SYS-PLB-DCW', unitId: u.id, roomId: room.id, color: [0.1, 0.69, 0.48], patterns: ['PLB-01', 'XD-01'],
        });
      });
      const wetX = u.rect.x + 2.4;
      const stackId = `PLB-STACK-${u.id}`;
      stacks.push({ id: stackId, wetWallId: u.wetWallIds[0], xy: [wetX, u.rect.y + 0.5], systems: ['waste', 'vent', 'dcw', 'dhw'], fromStorey: above[0].id, toStorey: above[above.length - 1].id, servesUnitIds: [u.id] });
      const run: PipeRun = {
        id: `PLB-${st.id}-PIPE-${u.id}`, storey: st.id, system: 'waste',
        path: [[bath.rect.x + 0.4, bath.rect.y + 0.35, -0.15], [wetX, u.rect.y + 0.5, -0.15]],
        diameter: 0.1, servesFixtureIds: fixtures.filter((f) => f.unitId === u.id).map((f) => f.id), unitId: u.id, stackId,
      };
      pipes.push(run);
      push(ctx, {
        discipline: 'plumbing', ifcType: 'IfcPipeSegment', predefinedType: 'RIGIDSEGMENT', name: 'Waste branch', storey: st.id, id: run.id,
        geometry: { kind: 'axis', start: run.path[0], end: run.path[1], profile: { type: 'circle', radius: 0.05 } },
        system: 'SYS-PLB-WASTE', unitId: u.id, color: [0.1, 0.69, 0.48], patterns: ['PLB-01'],
      });
      patterns.push({ patternId: 'PLB-01', storey: st.id, unitId: u.id, params: { stack: stackId, dfu: 11.5 }, elementIds: [run.id] });
      patterns.push({ patternId: 'XD-01', storey: st.id, unitId: u.id, params: { wetWallThickness: 0.2 } });
    }
  }
  const dfu = fixtures.reduce((a, f) => a + f.dfu, 0);
  return {
    dhw: 'per-unit-tank', sprinklered: true, fixtures, stacks, pipes, roofDrains: [[8, 8], [20, 8]],
    totals: { dfu, wsfu: fixtures.reduce((a, f) => a + f.wsfu, 0), fixtureCount: fixtures.length, serviceDiameter: 0.05 },
    elements: ctx.els.filter((e) => e.discipline === 'plumbing'),
    patterns,
    derived: { dfu },
  };
}

function buildElec(ctx: Ctx, above: StoreyDef[], bldg: Rect, arch: ArchModel): ElecModel {
  const devices: ElecDevice[] = [];
  const panels: ElecPanel[] = [];
  const trays: CableTrayRun[] = [];
  const patterns: PatternApplication[] = [];
  for (const st of above) {
    const tray: CableTrayRun = {
      id: `ELE-${st.id}-TRAY-001`, storey: st.id,
      path: [[bldg.x + 4.3, bldg.y + 1.25, st.height - 0.3], [bldg.x + bldg.w - 1, bldg.y + 1.25, st.height - 0.3]],
      width: 0.3, height: 0.1, purpose: 'power',
    };
    trays.push(tray);
    push(ctx, {
      discipline: 'electrical', ifcType: 'IfcCableCarrierSegment', predefinedType: 'CABLETRAYSEGMENT', name: 'Cable tray', storey: st.id, id: tray.id,
      geometry: { kind: 'axis', start: tray.path[0], end: tray.path[1], profile: { type: 'rect', width: 0.3, height: 0.1 } },
      system: 'SYS-ELE-POWER', color: [0.92, 0.41, 0.2], patterns: ['XD-02'],
    });
    for (const u of arch.units.filter((x) => x.storeys.includes(st.id))) {
      const p: ElecPanel = {
        id: `ELE-${st.id}-PANEL-${u.id}`, storey: st.id, type: 'unit-panel', unitId: u.id,
        position: [u.rect.x + 0.3, u.rect.y + 0.25, 1.2], rotation: 0, width: 0.4, depth: 0.14, height: 0.6,
        amps: 100, voltage: '120/240V', circuitCount: 20,
      };
      panels.push(p);
      push(ctx, {
        discipline: 'electrical', ifcType: 'IfcElectricDistributionBoard', predefinedType: 'CONSUMERUNIT', name: 'Unit panel', storey: st.id, id: p.id,
        geometry: { kind: 'box', position: p.position, width: p.width, depth: p.depth, height: p.height, rotation: 0 },
        system: 'SYS-ELE-POWER', unitId: u.id, color: [0.92, 0.41, 0.2], patterns: ['ELE-01'],
      });
      patterns.push({ patternId: 'ELE-01', storey: st.id, unitId: u.id, params: { panelAmps: 100 }, elementIds: [p.id] });
      for (const rid of u.roomIds) {
        const room = arch.rooms.find((r) => r.id === rid);
        if (!room) continue;
        const cx = room.rect.x + room.rect.w / 2, cy = room.rect.y + room.rect.h / 2;
        const spec: [ElecDevice['type'], number, number, number][] = [
          ['light-ceiling', cx, cy, 2.5],
          ['receptacle', room.rect.x + 0.35, room.rect.y + 0.12, 0.35],
          ['receptacle', room.rect.x + room.rect.w - 0.35, room.rect.y + room.rect.h - 0.12, 0.35],
          ['switch', room.rect.x + 0.2, room.rect.y + 0.12, 1.1],
        ];
        if (room.type === 'bedroom' || room.type === 'hall') spec.push(['smoke-alarm', cx + 0.5, cy + 0.5, 2.6]);
        spec.forEach(([type, x, y, z], i) => {
          const d: ElecDevice = {
            id: `ELE-${st.id}-DEV-${rid}-${i + 1}`, storey: st.id, type, roomId: rid, unitId: u.id,
            position: [x, y, z], rotation: 0, circuitId: `C-${u.id}-${type.startsWith('light') ? 'LTG' : 'RCP'}`, watts: type.startsWith('light') ? 12 : 180,
          };
          devices.push(d);
          push(ctx, {
            discipline: 'electrical',
            ifcType: type.startsWith('light') ? 'IfcLightFixture' : type === 'switch' ? 'IfcSwitchingDevice' : type === 'smoke-alarm' ? 'IfcSensor' : 'IfcOutlet',
            predefinedType: type.startsWith('light') ? 'POINTSOURCE' : type === 'switch' ? 'SWITCH' : type === 'smoke-alarm' ? 'SMOKESENSOR' : 'POWEROUTLET',
            name: type, storey: st.id, id: d.id,
            geometry: { kind: 'box', position: [x - 0.05, y - 0.05, z], width: 0.1, depth: 0.1, height: 0.1, rotation: 0 },
            system: 'SYS-ELE-POWER', unitId: u.id, roomId: rid, color: [0.92, 0.41, 0.2],
          });
        });
      }
    }
  }
  return {
    service: { voltage: '120/240V', amps: 400, phases: 1 }, panels, devices,
    circuits: [{ id: 'C-1', panelId: panels[0]?.id ?? 'ELE-PANEL', type: 'general-receptacle', amps: 20, voltage: 120, deviceIds: devices.slice(0, 8).map((d) => d.id), va: 1800 }],
    trays,
    risers: [{ id: 'ELE-RISER-1', shaftId: 'ARC-SHAFT-1', type: 'cable-riser', fromStorey: above[0].id, toStorey: above[above.length - 1].id, xy: [4.6, 0.6], width: 0.3, depth: 0.2 }],
    loads: { connectedVa: 96000, demandVa: 62400, perUnitVa: 15600 },
    elements: ctx.els.filter((e) => e.discipline === 'electrical'),
    patterns,
    derived: { deviceCount: devices.length },
  };
}

// ---------------------------------------------------------------------------
// mock IFC writer — a STEP file with the right shape (and real-looking GUIDs)
// ---------------------------------------------------------------------------

const B64 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_$abcdefghijklmnopqrstuvwxyz';
function mockGuid(seed: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < seed.length; i++) {
    h1 = (h1 ^ seed.charCodeAt(i)) * 16777619 >>> 0;
    h2 = (h2 + seed.charCodeAt(i) * (i + 7)) >>> 0;
  }
  let out = '';
  for (let i = 0; i < 22; i++) {
    const v = i % 2 === 0 ? (h1 = (h1 * 1103515245 + 12345) >>> 0) : (h2 = (h2 * 1103515245 + 12345) >>> 0);
    out += B64[(v >>> (i % 24)) & 63];
  }
  return out;
}

export function mockWriteIfc(model: DesignModel): IfcOutput {
  const lines: string[] = [];
  const idMap: Record<string, number> = {};
  let id = 0;
  const next = () => ++id;
  lines.push('ISO-10303-21;', 'HEADER;');
  lines.push(`FILE_DESCRIPTION(('ViewDefinition [DesignTransferView]'),'2;1');`);
  lines.push(`FILE_NAME('${model.spec.name.replace(/'/g, '')}.ifc','2026-01-01T00:00:00',('forma-resi-ifc'),('mock'),'forma-resi-ifc mock writer','forma-resi-ifc','');`);
  lines.push(`FILE_SCHEMA(('${model.spec.options.ifcSchema}'));`, 'ENDSEC;', 'DATA;');
  const proj = next();
  lines.push(`#${proj}=IFCPROJECT('${mockGuid('project')}',$,'${model.spec.name}',$,$,$,$,$,$);`);
  const bldg = next();
  lines.push(`#${bldg}=IFCBUILDING('${mockGuid('building')}',$,'${model.spec.name}',$,$,$,$,$,$,$,$,$);`);
  for (const st of model.storeys) {
    const n = next();
    lines.push(`#${n}=IFCBUILDINGSTOREY('${mockGuid(st.id)}',$,'${st.name}',$,$,$,$,$,.ELEMENT.,${st.elevation.toFixed(3)});`);
  }
  for (const e of model.elements) {
    const n = next();
    idMap[e.id] = n;
    const t = e.ifcType.toUpperCase();
    lines.push(`#${n}=${t}('${mockGuid(e.id)}',$,'${e.name.replace(/'/g, '')}',$,'${e.id}',$,$,$${e.predefinedType ? `,.${e.predefinedType}.` : ''});`);
  }
  lines.push('ENDSEC;', 'END-ISO-10303-21;', '');
  const content = lines.join('\n');
  return { content, entityCount: id, fileSize: content.length, idMap };
}
