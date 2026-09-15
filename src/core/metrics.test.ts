import { test } from 'node:test';
import assert from 'node:assert/strict';

import { COST_BENCHMARK, EUI_BASE, METRICS, computeMetrics, getMetric } from './metrics.ts';
import { buildStoreys, normalizeSpec } from './spec.ts';
import { getTypology } from './typologies.ts';
import { HA_TO_ACRE, M2_TO_FT2, M_TO_FT } from './units.ts';
import type {
  ArchModel, BuildingSpec, DesignModel, ElecModel, MechModel, MetricResult, PlumbModel,
  Region, RoomDef, SiteModel, StructModel, UnitInstance,
} from './types.ts';

// ============================================================================
// Fixture: a 6-storey corridor mid-rise with 48 dwellings
// ============================================================================

function makeUnits(count: number): UnitInstance[] {
  const units: UnitInstance[] = [];
  for (let i = 0; i < count; i++) {
    const storey = `L${String(Math.floor(i / 8) + 1).padStart(2, '0')}`;
    const twoBed = i % 3 !== 0;
    units.push({
      id: `U-${storey}-${String((i % 8) + 1).padStart(2, '0')}`,
      templateId: twoBed ? '2b2b' : '1b1b',
      storeys: [storey],
      rect: { x: (i % 8) * 8, y: 0, w: 8, h: 11 },
      polygon: [[0, 0], [8, 0], [8, 11], [0, 11]],
      area: twoBed ? 78 : 52,
      bedrooms: twoBed ? 2 : 1,
      bathrooms: twoBed ? 2 : 1,
      occupants: twoBed ? 3 : 2,
      aspect: i % 4 === 0 ? 'corner' : i % 2 === 0 ? 'dual' : 'single',
      accessSide: 'front',
      entryDoorId: `ARC-${storey}-DOOR-${i}`,
      roomIds: [],
      wetWallIds: [],
      bathroomRoomIds: [],
    });
  }
  return units;
}

function makeRooms(): RoomDef[] {
  const rooms: RoomDef[] = [];
  for (let level = 1; level <= 6; level++) {
    const storey = `L${String(level).padStart(2, '0')}`;
    rooms.push({
      id: `R-${storey}-CORRIDOR1`, storey, type: 'corridor', name: 'Corridor',
      polygon: [[0, 11], [64, 11], [64, 12.5], [0, 12.5]], rect: { x: 0, y: 11, w: 64, h: 1.5 },
      area: 96, height: 2.7, isWet: false, hasExterior: false,
      exteriorWallIds: [], wallIds: [], doorIds: [], windowIds: [], furnitureIds: [],
      occupancy: 0, zone: 'circulation',
    });
    rooms.push({
      id: `R-${storey}-STAIR1`, storey, type: 'stair', name: 'Stair',
      polygon: [[30, 11], [35, 11], [35, 17], [30, 17]], rect: { x: 30, y: 11, w: 5, h: 6 },
      area: 30, height: 2.7, isWet: false, hasExterior: false,
      exteriorWallIds: [], wallIds: [], doorIds: [], windowIds: [], furnitureIds: [],
      occupancy: 0, zone: 'circulation',
    });
  }
  return rooms;
}

function fixture(region: Region = 'US', overrides: Partial<DesignModel> = {}): DesignModel {
  const spec: BuildingSpec = normalizeSpec({
    name: 'Metric Test Commons',
    seed: 4,
    region,
    displayUnits: region === 'US' ? 'imperial' : 'metric',
    typology: 'corridor-midrise',
    site: { width: 78, depth: 42, maxFar: 3.5, maxCoverage: 0.6, maxHeight: 22 },
    massing: { storeys: 6 },
  });
  const typology = getTypology(spec.typology);
  const storeys = buildStoreys(spec, spec.floors);
  const units = makeUnits(48);
  const rooms = makeRooms();

  const site: SiteModel = {
    boundary: [[0, 0], [78, 0], [78, 42], [0, 42]],
    area: 78 * 42,
    buildableEnvelope: [[3, 6], [75, 6], [75, 36], [3, 36]],
    setbacks: { front: 6, side: 3, rear: 7.5 },
    streetFacing: 'S',
    northRad: 0,
    massing: {
      shape: 'bar',
      footprint: [[6, 6], [70, 6], [70, 24], [6, 24]],
      footprintArea: 64 * 18,
      bars: [],
      storeys,
      heightAboveGrade: 19.6,
      gfa: 64 * 18 * 6,
      cores: [],
      corridors: [],
      roof: { type: 'flat', pitchRad: 0, parapetHeight: 1.1, ridgeAxis: 'x' },
    },
    parking: {
      type: 'podium',
      spaces: Array.from({ length: 34 }, (_, i) => ({
        id: `SIT-B1-PRK-${i}`, rect: { x: i * 2.6, y: 0, w: 2.5, h: 5 }, rotation: 0,
        type: 'standard' as const, storey: 'B1',
      })),
      aisles: [],
      bikeSpaces: 60,
      storey: 'B1',
    },
    landscape: [
      { id: 'LZ-1', type: 'communal-garden', polygon: [[6, 26], [70, 26], [70, 36], [6, 36]], area: 640 },
      { id: 'LZ-2', type: 'paving', polygon: [[0, 0], [78, 0], [78, 6], [0, 6]], area: 468 },
    ],
    paths: [],
    driveway: null,
    entrances: [],
    elements: [],
    patterns: [],
    derived: {},
  };

  const arch: ArchModel = {
    storeys,
    floors: Array.from({ length: 6 }, (_, level) => ({
      storey: `L${String(level + 1).padStart(2, '0')}`,
      use: 'residential' as const,
      outline: [[6, 6], [70, 6], [70, 24], [6, 24]] as [number, number][],
      area: 64 * 18,
      floorToFloor: level === 0 ? 3.6 : 3.2,
      ceilingHeight: 2.7,
      slabThickness: 0.25,
      corridors: [],
      unitIds: [],
      roomIds: [],
      commonRoomIds: [],
      wallIds: [],
      exteriorWallIds: [],
      balconies: Array.from({ length: 8 }, (_, i) => ({
        id: `ARC-L${level}-BAL-${i}`, storey: `L${String(level + 1).padStart(2, '0')}`,
        unitId: `U-L${String(level + 1).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`,
        rect: { x: i * 8, y: 24, w: 3, h: 1.5 }, roomId: `R-BAL-${level}-${i}`,
      })),
      wwr: 0.35,
    })),
    units,
    rooms,
    walls: Array.from({ length: 6 }, (_, level) => ([
      { id: `ARC-L${level}-WALL-N`, storey: `L${String(level + 1).padStart(2, '0')}`, start: [6, 6] as [number, number], end: [70, 6] as [number, number], thickness: 0.3, height: 3.2, type: 'exterior' as const, isExternal: true, loadBearingHint: false },
      { id: `ARC-L${level}-WALL-S`, storey: `L${String(level + 1).padStart(2, '0')}`, start: [6, 24] as [number, number], end: [70, 24] as [number, number], thickness: 0.3, height: 3.2, type: 'exterior' as const, isExternal: true, loadBearingHint: false },
      { id: `ARC-L${level}-WALL-P`, storey: `L${String(level + 1).padStart(2, '0')}`, start: [6, 6] as [number, number], end: [6, 24] as [number, number], thickness: 0.2, height: 3.2, type: 'party' as const, isExternal: false, loadBearingHint: true },
    ])).flat(),
    doors: [],
    windows: Array.from({ length: 96 }, (_, i) => ({
      id: `ARC-WIN-${i}`, storey: `L${String(Math.floor(i / 16) + 1).padStart(2, '0')}`,
      wallId: 'ARC-L0-WALL-N', along: (i % 16) * 4, sill: 0.9, width: 1.8, height: 1.5,
      roomId: `R-${i}`,
    })),
    furniture: [],
    cores: [],
    stairs: [],
    elevators: [],
    shafts: [],
    roof: { type: 'flat', outline: [[6, 6], [70, 6], [70, 24], [6, 24]], thickness: 0.35, pitchRad: 0, ridgeAxis: 'x', parapetHeight: 1.1 },
    templatesUsed: ['1b1b', '2b2b'],
    elements: [],
    patterns: [],
    derived: { maxTravelDistance: 34 },
  };

  const struct: StructModel = {
    system: 'wood-over-podium',
    foundation: 'raft',
    grid: [],
    columns: Array.from({ length: 84 }, (_, i) => ({
      id: `STR-COL-${i}`, storey: i < 14 ? 'L01' : `L${String(Math.floor(i / 14) + 1).padStart(2, '0')}`,
      position: [(i % 14) * 4.6, 6] as [number, number], width: 0.4, depth: 0.4, height: 3.2,
      gridRef: `A${i}`, material: 'concrete' as const,
    })),
    beams: [],
    walls: [],
    slabs: [],
    foundations: [],
    sizes: { columnW: 0.4, columnD: 0.4, beamW: 0.4, beamD: 0.6, slabT: 0.2, shearWallT: 0.25 },
    loads: { deadKpa: 2.5, liveKpa: 1.9, roofLiveKpa: 1 },
    plenumClearance: { corridorSoffitZ: 2.4 },
    elements: [],
    patterns: [],
    derived: { embodiedCarbonKgCo2e: 2_100_000 },
  };

  const mech: MechModel = {
    system: 'ducted-heat-pump',
    ventilation: 'erv-per-unit',
    equipment: [], ducts: [], terminals: [], risers: [], plantRoomIds: [],
    loads: { coolingWPerM2: 55, heatingWPerM2: 40, ventilationLsPerPerson: 8, totalCoolingKw: 380, totalHeatingKw: 276 },
    elements: [], patterns: [], derived: {},
  };

  const plumb: PlumbModel = {
    dhw: 'central-plant',
    sprinklered: true,
    fixtures: [], stacks: [], pipes: [], roofDrains: [],
    totals: { dfu: 640, wsfu: 512, fixtureCount: 268, serviceDiameter: 0.1 },
    elements: [], patterns: [], derived: {},
  };

  const elec: ElecModel = {
    service: { voltage: '120/208V', amps: 1200, phases: 3 },
    panels: [], devices: [], circuits: [], trays: [], risers: [],
    loads: { connectedVa: 520_000, demandVa: 249_600, perUnitVa: 5200 },
    elements: [], patterns: [], derived: {},
  };

  return {
    spec, typology, storeys, site, arch, struct, mech, plumb, elec,
    elements: [], metrics: [], patterns: { book: [], applications: [] },
    warnings: [], timings: {},
    ...overrides,
  };
}

function byId(results: MetricResult[]): Map<string, MetricResult> {
  return new Map(results.map(r => [r.id, r]));
}

// ============================================================================
// Tests
// ============================================================================

test('METRICS covers every MetricId exactly once, ranks 1..20 then supplementary', () => {
  const ids = METRICS.map(m => m.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate metric ids');
  assert.ok(METRICS.length >= 20, `only ${METRICS.length} metrics`);

  const headline = METRICS.filter(m => m.rank <= 20);
  assert.ok(headline.length >= 20, `only ${headline.length} headline metrics`);
  for (let rank = 1; rank <= 20; rank++) {
    assert.ok(METRICS.some(m => m.rank === rank), `no metric at rank ${rank}`);
  }
  for (const def of METRICS) {
    assert.ok(def.name.length > 0 && def.description.length > 0 && def.formula.length > 0, `${def.id} is under-documented`);
    assert.ok(def.unit.metric.length > 0 && def.unit.imperial.length > 0);
    assert.ok(Number.isFinite(def.unit.factor) && def.unit.factor > 0, `${def.id} has a bad unit factor`);
    assert.ok(Object.keys(def.altNames).length > 0, `${def.id} has no regional alt names`);
  }
  // Regional alt names use the region codes from the contract.
  for (const def of METRICS) {
    for (const region of Object.keys(def.altNames)) {
      assert.ok(['US', 'UK', 'CA', 'AU', 'NZ', 'IE'].includes(region), `${def.id}: bad region ${region}`);
    }
  }
  assert.equal(getMetric('gfa').rank, 1);
  assert.equal(getMetric('nia').rank, 2);
  assert.equal(getMetric('electrical-service').rank, 20);
});

test('computeMetrics returns one finite result per definition', () => {
  const results = computeMetrics(fixture());
  assert.equal(results.length, METRICS.length);
  assert.ok(results.length >= 20);

  for (const result of results) {
    assert.ok(Number.isFinite(result.value), `${result.id} value is not finite: ${result.value}`);
    assert.equal(typeof result.display, 'string');
    assert.ok(result.display.length > 0, `${result.id} has no display string`);
    assert.ok(result.unit.length > 0, `${result.id} has no unit`);
    if (result.status) assert.ok(['ok', 'warn', 'fail'].includes(result.status));
    for (const [key, value] of Object.entries(result.breakdown ?? {})) {
      assert.ok(Number.isFinite(value), `${result.id}.breakdown.${key} is not finite`);
    }
  }
  assert.deepEqual(results.map(r => r.id), METRICS.map(m => m.id), 'results follow METRICS order');
});

test('headline numbers are computed from the model arrays', () => {
  const model = fixture('UK');
  const metrics = byId(computeMetrics(model));

  const gia = 64 * 18 * 6;
  assert.equal(metrics.get('gfa')!.value, gia);
  assert.equal(metrics.get('gfa')!.breakdown!.L03, 64 * 18);

  const nia = model.arch.units.reduce((a, u) => a + u.area, 0);
  assert.equal(metrics.get('nia')!.value, nia);
  assert.ok(Math.abs(metrics.get('efficiency')!.value - nia / gia) < 1e-9);
  assert.ok(Math.abs(metrics.get('far')!.value - gia / (78 * 42)) < 1e-9);
  assert.ok(Math.abs(metrics.get('site-coverage')!.value - (64 * 18) / (78 * 42)) < 1e-9);

  assert.equal(metrics.get('unit-count')!.value, 48);
  assert.ok(Math.abs(metrics.get('avg-unit-area')!.value - nia / 48) < 1e-9);
  // 32 of 48 units are 2-bed
  assert.ok(Math.abs(metrics.get('unit-mix')!.value - 32 / 48) < 1e-9);
  assert.equal(metrics.get('unit-mix')!.breakdown!['2b2b'], 32);
  assert.equal(metrics.get('unit-mix')!.breakdown!['1b1b'], 16);

  // 48 units on 0.3276 ha
  assert.ok(Math.abs(metrics.get('density-dph')!.value - 48 / ((78 * 42) / 10000)) < 1e-6);
  assert.equal(metrics.get('storeys')!.value, 6);
  assert.equal(metrics.get('building-height')!.value, 19.6);

  // circulation = 6 × (96 + 30) m²
  assert.ok(Math.abs(metrics.get('circulation-ratio')!.value - (6 * 126) / gia) < 1e-9);
  // windows 96 × 2.7 m² over 6 × (64 + 64) × 3.2 m² of external wall
  const extWall = 6 * 2 * 64 * 3.2;
  assert.ok(Math.abs(metrics.get('facade-area')!.value - extWall) < 1e-6);
  assert.ok(Math.abs(metrics.get('wwr')!.value - (96 * 1.8 * 1.5) / extWall) < 1e-9);
  assert.ok(Math.abs(metrics.get('wall-to-floor')!.value - extWall / gia) < 1e-9);
  // 12 corner + 12 dual of 48
  assert.ok(Math.abs(metrics.get('dual-aspect')!.value - 24 / 48) < 1e-9);

  assert.ok(Math.abs(metrics.get('parking-ratio')!.value - 34 / 48) < 1e-9);
  assert.ok(Math.abs(metrics.get('bike-ratio')!.value - 60 / 48) < 1e-9);
  assert.equal(metrics.get('egress-travel')!.value, 34);
  assert.equal(metrics.get('electrical-service')!.value, 1200);
  assert.equal(metrics.get('plumbing-dfu')!.value, 640);
  assert.equal(metrics.get('cooling-load')!.value, 380);
  assert.ok(Math.abs(metrics.get('embodied-carbon')!.value - 2_100_000 / gia) < 1e-6);
  assert.equal(metrics.get('setback-compliance')!.value, 0);
});

test('unit strings and formatting follow displayUnits', () => {
  const metric = byId(computeMetrics(fixture('UK')));
  const imperial = byId(computeMetrics(fixture('US')));

  assert.equal(metric.get('gfa')!.unit, 'm²');
  assert.match(metric.get('gfa')!.display, /^6,?912\.0 m²$|^6912\.0 m²$/);
  assert.equal(imperial.get('gfa')!.unit, 'sf');
  assert.equal(imperial.get('gfa')!.display, `${Math.round(6912 * M2_TO_FT2).toLocaleString('en-US')} sf`);

  assert.equal(metric.get('building-height')!.unit, 'm');
  assert.equal(metric.get('building-height')!.display, '19.60 m');
  assert.equal(imperial.get('building-height')!.unit, 'ft');
  assert.match(imperial.get('building-height')!.display, /^\d+'-\d+"$/);

  assert.equal(metric.get('density-dph')!.unit, 'dph');
  assert.match(metric.get('density-dph')!.display, /dph$/);
  assert.equal(imperial.get('density-dph')!.unit, 'du/ac');
  assert.match(imperial.get('density-dph')!.display, /du\/ac$/);

  assert.equal(metric.get('efficiency')!.unit, '%');
  assert.match(metric.get('efficiency')!.display, /%$/);

  assert.equal(metric.get('cooling-load')!.display, '380 kW');
  assert.match(imperial.get('cooling-load')!.display, /tons$/);

  // Cost is reported in the region's own currency.
  assert.equal(metric.get('construction-cost')!.unit, 'GBP');
  assert.ok(metric.get('construction-cost')!.display.startsWith('£'));
  assert.equal(imperial.get('construction-cost')!.unit, 'USD');
  assert.ok(imperial.get('construction-cost')!.display.includes('/sf'));
  assert.equal(imperial.get('construction-cost')!.value, COST_BENCHMARK.US.rate * 6912);

  // EUI uses the regional proxy adjusted by WWR.
  assert.ok(metric.get('eui')!.display.endsWith('kWh/m²/yr'));
  assert.ok(imperial.get('eui')!.display.endsWith('kBtu/sf/yr'));
  assert.ok(Math.abs(metric.get('eui')!.breakdown!.base - EUI_BASE.UK) < 1e-9);
});

test('zoning caps and design thresholds drive the status flags', () => {
  const ok = byId(computeMetrics(fixture('US')));
  assert.equal(ok.get('far')!.status, 'ok');
  assert.equal(ok.get('site-coverage')!.status, 'ok');
  assert.equal(ok.get('building-height')!.status, 'ok');
  assert.equal(ok.get('egress-travel')!.status, 'ok');
  assert.equal(ok.get('setback-compliance')!.status, 'ok');

  const tight = fixture('US');
  tight.spec.site.maxFar = 1.5;
  tight.spec.site.maxCoverage = 0.2;
  tight.spec.site.maxHeight = 12;
  tight.site.setbacks = { front: 2, side: 3, rear: 7.5 };
  tight.arch.derived = { maxTravelDistance: 92 };
  const failed = byId(computeMetrics(tight));
  assert.equal(failed.get('far')!.status, 'fail');
  assert.equal(failed.get('site-coverage')!.status, 'fail');
  assert.equal(failed.get('building-height')!.status, 'fail');
  assert.equal(failed.get('egress-travel')!.status, 'fail');
  assert.equal(failed.get('setback-compliance')!.status, 'fail');
  const required = getTypology('corridor-midrise').setbacks;
  const worst = Math.min(2 - required.front, 3 - required.side, 7.5 - required.rear);
  assert.equal(failed.get('setback-compliance')!.value, worst);
  assert.ok(worst < 0, 'the tightened front setback must encroach');

  // Efficiency, WWR and dual aspect warn rather than fail.
  const poor = fixture('UK');
  poor.arch.units = poor.arch.units.map(u => ({ ...u, area: u.area * 0.5, aspect: 'single' as const }));
  poor.arch.windows = poor.arch.windows.slice(0, 20);
  const warned = byId(computeMetrics(poor));
  assert.equal(warned.get('efficiency')!.status, 'warn');
  assert.equal(warned.get('wwr')!.status, 'warn');
  assert.equal(warned.get('dual-aspect')!.status, 'warn');
  assert.match(warned.get('dual-aspect')!.note ?? '', /London Plan/);

  // The same dual-aspect share is only advisory outside the UK/IE.
  const us = fixture('US');
  us.arch.units = us.arch.units.map(u => ({ ...u, aspect: 'single' as const }));
  assert.equal(byId(computeMetrics(us)).get('dual-aspect')!.status, 'ok');
});

test('discipline derived maps win over the recomputation', () => {
  const model = fixture('UK');
  model.arch.derived = { gia: 7000, nia: 5000, circulationArea: 800, wwr: 0.42, maxTravelDistance: 41 };
  const metrics = byId(computeMetrics(model));
  assert.equal(metrics.get('gfa')!.value, 7000);
  assert.equal(metrics.get('nia')!.value, 5000);
  assert.ok(Math.abs(metrics.get('efficiency')!.value - 5000 / 7000) < 1e-9);
  assert.ok(Math.abs(metrics.get('circulation-ratio')!.value - 800 / 7000) < 1e-9);
  assert.ok(Math.abs(metrics.get('wwr')!.value - 0.42) < 1e-9);
  assert.equal(metrics.get('egress-travel')!.value, 41);
});

test('circulation ratio adds the cores and falls back to the floor-plan corridors', () => {
  // The architecture discipline publishes corridors/commons as `circulationArea` and the
  // stair-lift-shaft cores as `coreArea`; rank 13 is (corridor + core area) / GIA.
  const split = fixture('UK');
  split.arch.derived = { gia: 7000, circulationArea: 800, coreArea: 250, maxTravelDistance: 41 };
  const derived = byId(computeMetrics(split)).get('circulation-ratio')!;
  assert.notEqual(derived.display, 'n/a', 'the derived keys must produce a real percentage');
  assert.ok(Math.abs(derived.value - (800 + 250) / 7000) < 1e-9, `got ${derived.value}`);
  assert.equal(derived.breakdown!.circulationArea, 1050);

  // Without the derived keys the metric recomputes. Corridors live on the FLOOR PLANS
  // (`arch.floors[i].corridors`) — ArchModel itself has no `corridors` array — and the
  // unit-internal stairs the room sweep skips are picked up as core area.
  const model = fixture('UK');
  const gia = 6 * 64 * 18;
  model.arch.derived = {};
  model.arch.rooms = [{ ...makeRooms()[1], unitId: 'U-L01-01' }];
  model.arch.floors = model.arch.floors.map(f => ({
    ...f,
    corridors: [{
      id: `ARC-${f.storey}-CORR-1`,
      storey: f.storey,
      polygon: [[6, 11], [70, 11], [70, 12.6], [6, 12.6]] as [number, number][],
      centerline: [{ a: [6, 11.8] as [number, number], b: [70, 11.8] as [number, number] }],
      width: 1.6,
      roomId: `R-${f.storey}-CORRIDOR1`,
    }],
  }));
  const fallback = byId(computeMetrics(model));
  const ratio = fallback.get('circulation-ratio')!;
  assert.notEqual(ratio.display, 'n/a', 'corridors on the floor plans must feed rank 13');
  // 6 storeys × 64 × 1.6 m of corridor + one 30 m² stair inside a dwelling
  assert.ok(Math.abs(ratio.value - (6 * 64 * 1.6 + 30) / gia) < 1e-9, `got ${ratio.value}`);
  assert.ok(ratio.value > 0.05 && ratio.value < 0.25, `implausible circulation ratio ${ratio.value}`);

  // the same corridors drive the egress fallback: half the corridor run + the unit depth
  assert.equal(fallback.get('egress-travel')!.value, 64 / 2 + 11);
});

test('an empty model yields finite zeros and unavailable notes, never NaN', () => {
  const model = fixture('US');
  const empty: DesignModel = {
    ...model,
    site: {
      ...model.site,
      area: 0,
      massing: { ...model.site.massing, footprintArea: 0, footprint: [], heightAboveGrade: 0, gfa: 0 },
      parking: null,
      landscape: [],
    },
    arch: {
      ...model.arch,
      floors: [], units: [], rooms: [], walls: [], windows: [], derived: {},
    },
    struct: null, mech: null, plumb: null, elec: null,
  };
  const results = computeMetrics(empty);

  assert.equal(results.length, METRICS.length);
  for (const result of results) {
    assert.ok(Number.isFinite(result.value), `${result.id} is not finite`);
    assert.ok(!Number.isNaN(result.value));
    assert.ok(result.display.length > 0);
  }
  const metrics = byId(results);
  assert.equal(metrics.get('nia')!.value, 0);
  assert.equal(metrics.get('nia')!.display, 'n/a');
  assert.equal(metrics.get('nia')!.status, 'warn');
  assert.match(metrics.get('nia')!.note ?? '', /unavailable/);
  assert.match(metrics.get('electrical-service')!.note ?? '', /not generated/);
  assert.match(metrics.get('plumbing-dfu')!.note ?? '', /not generated/);
  assert.match(metrics.get('cooling-load')!.note ?? '', /not generated/);
  // Site area falls back to width × depth, so FAR is still a real number.
  assert.equal(metrics.get('far')!.value, 0);
  assert.equal(metrics.get('parking-ratio')!.value, 0);
  // Height and storeys fall back to the massing spec.
  assert.ok(metrics.get('building-height')!.value > 0);
  assert.equal(metrics.get('storeys')!.value, 6);
  // Embodied carbon falls back to the typology's structural system benchmark.
  assert.ok(metrics.get('embodied-carbon')!.value > 0);
  assert.match(metrics.get('embodied-carbon')!.note ?? '', /benchmark/);
});

test('breakdowns are in the same units as display', () => {
  const metric = byId(computeMetrics(fixture('UK')));      // displayUnits: metric
  const imperial = byId(computeMetrics(fixture('US')));     // displayUnits: imperial

  // Metric specs are untouched — the values are computed in SI.
  assert.equal(metric.get('gfa')!.breakdown!.L03, 64 * 18);
  assert.equal(metric.get('efficiency')!.breakdown!.gia, 64 * 18 * 6);
  assert.equal(metric.get('egress-travel')!.breakdown!.limit, 76);

  // Imperial specs get the breakdown in the units the display string uses.
  const round4 = (v: number): number => Math.round(v * 1e4) / 1e4;
  assert.equal(imperial.get('gfa')!.breakdown!.L03, round4(64 * 18 * M2_TO_FT2));
  assert.equal(imperial.get('facade-area')!.breakdown!.glazed, round4(96 * 1.8 * 1.5 * M2_TO_FT2));
  assert.equal(imperial.get('egress-travel')!.breakdown!.limit, round4(76 * M_TO_FT));
  assert.equal(imperial.get('floor-to-floor')!.breakdown!.typical, round4(3.1 * M_TO_FT));
  // Density displays du/ac, so its hectares become acres.
  assert.equal(imperial.get('density-dph')!.breakdown!.hectares, round4(((78 * 42) / 10000) * HA_TO_ACRE));

  // Dimensionless entries are never scaled, in either system.
  for (const sheet of [metric, imperial]) {
    assert.equal(sheet.get('nia')!.breakdown!.dwellings, 48);
    assert.equal(sheet.get('unit-mix')!.breakdown!['2b2b'], 32);
    assert.equal(sheet.get('electrical-service')!.breakdown!.amps, 1200);
    assert.equal(sheet.get('cooling-load')!.breakdown!.kw, 380);
    assert.equal(sheet.get('construction-cost')!.breakdown!.ratePerM2, COST_BENCHMARK[sheet === metric ? 'UK' : 'US'].rate);
  }
});

test('embodied carbon reports the A1-A5 intensity when structure publishes one', () => {
  const base = fixture('UK');
  const a1a5 = byId(computeMetrics({
    ...base,
    struct: { ...base.struct!, derived: { embodiedCarbonPerM2: 300, embodiedCarbonA1A5PerM2: 336 } },
  })).get('embodied-carbon')!;
  assert.equal(a1a5.value, 336, 'A1-A5 wins over A1-A3');
  assert.match(a1a5.note ?? '', /structure A1–A5 estimate/);
  assert.equal(a1a5.breakdown!.a1a3, 300);
  assert.equal(a1a5.breakdown!.a1a5, 336);

  // A1–A3 only: the label says so rather than claiming A1–A5.
  const a1a3 = byId(computeMetrics({
    ...base,
    struct: { ...base.struct!, derived: { embodiedCarbonPerM2: 300 } },
  })).get('embodied-carbon')!;
  assert.equal(a1a3.value, 300);
  assert.match(a1a3.note ?? '', /structure A1–A3 estimate/);
  assert.equal(a1a3.breakdown!.a1a5, undefined);

  // The benchmark fallback is an A1–A5 figure.
  const benchmark = byId(computeMetrics({ ...base, struct: { ...base.struct!, derived: {} } })).get('embodied-carbon')!;
  assert.ok(benchmark.value > 0);
  assert.match(benchmark.note ?? '', new RegExp(`structure A1–A5 estimate, benchmark for ${base.struct!.system}`));

  // Structure's own total (spelled with the capitalised CO2) still resolves.
  const fromTotal = byId(computeMetrics({
    ...base,
    struct: { ...base.struct!, derived: { embodiedCarbonKgCO2e: 2_100_000 } },
  })).get('embodied-carbon')!;
  assert.ok(Math.abs(fromTotal.value - 2_100_000 / (64 * 18 * 6)) < 1e-6);
});

test('every region produces a complete, finite sheet', () => {
  for (const region of ['US', 'UK', 'CA', 'AU', 'NZ', 'IE'] as Region[]) {
    const results = computeMetrics(fixture(region));
    assert.equal(results.length, METRICS.length, region);
    for (const result of results) {
      assert.ok(Number.isFinite(result.value), `${region}/${result.id} is not finite`);
      assert.ok(result.display.length > 0, `${region}/${result.id} has no display`);
    }
    const cost = byId(results).get('construction-cost')!;
    assert.equal(cost.unit, COST_BENCHMARK[region].currency);
    assert.ok(cost.display.startsWith(COST_BENCHMARK[region].symbol), `${region}: ${cost.display}`);
  }
});
