/**
 * TEST-ONLY fixtures for the architecture floor organiser.
 *
 * Three things live here, and none of them are part of the production path:
 *   - `makeSiteFixture(kind)` — a valid `SiteModel` (massing bars, cores, corridor spines, storeys,
 *     entrances) for each access type, so the organiser can be tested before `disciplines/site`
 *     exists.
 *   - `FALLBACK_TEMPLATES` — a minimal `UnitTemplateDef` table, used only until `templates.ts`
 *     (owned by the unit-layout agent) lands.
 *   - `stubLayoutUnit` — a deliberately crude `UnitLayoutFn`: a service band on the wet-wall side
 *     (hall + bathrooms) and the habitable rooms as strips beyond it. Used only until
 *     `unit-layout.ts` lands.
 *
 * `index.ts` reaches for these ONLY when the real modules cannot be imported (see
 * `resolveArchitectureDeps`).
 */
import type {
  BuildingSpec, CorePlacement, CorridorSpine, DoorDef, Entrance, FurnitureDef, FurnitureType, GenContext,
  LandscapeZone, MassingBar, Polygon, Rect, RoomDef, RoomProgram, RoomType, Side, SiteModel,
  StoreyDef, UnitTemplateDef, UnitTemplateId, Vec2, WallDef,
} from '../../core/types.ts';
import type { UnitLayout, UnitLayoutFn, UnitLayoutRequest } from './unit-layout-types.ts';
import { SIZES } from '../../core/coordination.ts';
import { normalizeSpec, buildStoreys, type PartialSpec } from '../../core/spec.ts';
import { getTypology } from '../../core/typologies.ts';
import { createRng } from '../../core/rng.ts';
import { polygonArea, rectToPolygon, round } from '../../core/geometry.ts';
import { reachRect, solveSwing } from '../../core/openings.ts';
import { roomIsWet, roomZone } from './arch-elements.ts';

// ============================================================================
// Unit templates (fallback)
// ============================================================================

function rp(type: RoomType, targetArea: number, o: Partial<RoomProgram> = {}): RoomProgram {
  return {
    type,
    count: 1,
    targetArea,
    minArea: round(targetArea * 0.8, 2),
    minWidth: 2.2,
    needsExterior: type === 'bedroom' || type === 'master-bedroom' || type === 'living'
      || type === 'living-kitchen' || type === 'dining',
    wet: roomIsWet(type),
    zone: roomZone(type),
    prefer: 'either',
    ...o,
  };
}

function tpl(
  id: UnitTemplateId, name: string, bedrooms: number, bathrooms: number, occupants: number,
  area: [number, number, number], frontage: [number, number], depth: [number, number],
  storeysInUnit: 1 | 2 | 3, aspect: 'single' | 'dual' | 'corner', rooms: RoomProgram[],
  suitableTypologies: UnitTemplateDef['suitableTypologies'] = [],
): UnitTemplateDef {
  return {
    id, name, regionalNames: {}, description: `${name} (fallback fixture template)`,
    bedrooms, bathrooms, occupants,
    area: { min: area[0], target: area[1], max: area[2] },
    frontage: { min: frontage[0], max: frontage[1] },
    depth: { min: depth[0], max: depth[1] },
    storeysInUnit, aspect, rooms, suitableTypologies, patterns: ['ARC-06', 'XD-01'],
  };
}

const CORE_ROOMS = (beds: number, baths: number, living: number): RoomProgram[] => [
  rp('entry', 4, { minWidth: 1.2, needsExterior: false }),
  rp('living-kitchen', living),
  ...Array.from({ length: beds }, (_, i) => rp(i === 0 ? 'master-bedroom' : 'bedroom', i === 0 ? 14 : 11)),
  ...Array.from({ length: baths }, () => rp('bathroom', 5.2, { minWidth: 1.7 })),
  rp('storage', 2.0, { minWidth: 0.8, needsExterior: false }),
];

export const FALLBACK_TEMPLATES: UnitTemplateDef[] = [
  tpl('micro-studio', 'Micro studio', 0, 1, 1, [20, 26, 32], [3.8, 6.5], [5, 9], 1, 'single', CORE_ROOMS(0, 1, 16)),
  tpl('studio', 'Studio', 0, 1, 1, [28, 36, 44], [4.2, 7.5], [6, 11], 1, 'single', CORE_ROOMS(0, 1, 24)),
  tpl('junior-1b', 'Junior one-bedroom', 1, 1, 2, [38, 45, 52], [4.8, 8.0], [6, 11], 1, 'single', CORE_ROOMS(1, 1, 22)),
  tpl('1b1b', 'One-bedroom', 1, 1, 2, [45, 55, 68], [5.4, 9.0], [6, 12], 1, 'single', CORE_ROOMS(1, 1, 28)),
  tpl('1b-den', 'One-bedroom and den', 1, 1, 3, [52, 63, 76], [5.8, 9.5], [6, 12], 1, 'single', CORE_ROOMS(1, 1, 30)),
  tpl('2b1b', 'Two-bedroom, one bath', 2, 1, 3, [58, 70, 84], [6.2, 11.0], [7, 13], 1, 'dual', CORE_ROOMS(2, 1, 30)),
  tpl('2b2b', 'Two-bedroom, two bath', 2, 2, 4, [66, 80, 96], [6.8, 11.5], [7, 13], 1, 'dual', CORE_ROOMS(2, 2, 32)),
  tpl('3b2b', 'Three-bedroom', 3, 2, 5, [84, 100, 120], [7.8, 13.0], [8, 14], 1, 'dual', CORE_ROOMS(3, 2, 36)),
  tpl('4b2b', 'Four-bedroom', 4, 2, 6, [104, 122, 145], [8.6, 14.0], [8, 15], 1, 'dual', CORE_ROOMS(4, 2, 40)),
  tpl('dual-key', 'Dual key', 2, 2, 4, [70, 84, 100], [7.0, 12.0], [7, 13], 1, 'dual', CORE_ROOMS(2, 2, 26)),
  tpl('corner-2b2b', 'Corner two-bedroom', 2, 2, 4, [78, 94, 112], [7.4, 13.0], [7, 14], 1, 'corner', CORE_ROOMS(2, 2, 38)),
  tpl('loft-live-work', 'Live-work loft', 1, 1, 2, [62, 78, 95], [6.0, 11.0], [8, 14], 1, 'single', CORE_ROOMS(1, 1, 44)),
  tpl('maisonette-2s', 'Maisonette', 2, 1, 3, [74, 90, 108], [4.8, 8.0], [7, 13], 2, 'dual', CORE_ROOMS(2, 1, 32)),
  tpl('townhouse-2s', 'Two-storey townhouse', 3, 2, 4, [92, 110, 132], [5.2, 7.5], [8, 13], 2, 'dual', CORE_ROOMS(3, 2, 34)),
  tpl('townhouse-3s', 'Three-storey townhouse', 3, 3, 5, [118, 140, 166], [5.5, 6.5], [8, 13], 3, 'dual', [
    ...CORE_ROOMS(3, 3, 34), rp('garage', 18, { minWidth: 3.0, needsExterior: true }),
  ]),
  tpl('ranch-3b', 'Single-storey house', 3, 2, 5, [110, 135, 165], [9.0, 16.0], [8, 14], 1, 'dual', CORE_ROOMS(3, 2, 42)),
  tpl('colonial-4b', 'Two-storey detached house', 4, 3, 6, [160, 195, 240], [8.0, 16.0], [8, 14], 2, 'dual', [
    ...CORE_ROOMS(4, 3, 40), rp('garage', 20, { minWidth: 3.0, needsExterior: true }),
  ]),
  tpl('adu-1b', 'Accessory dwelling unit', 1, 1, 2, [36, 46, 58], [4.6, 9.0], [5, 9], 1, 'dual', CORE_ROOMS(1, 1, 22)),
  tpl('coliving-cluster', 'Co-living cluster', 6, 6, 6, [148, 178, 214], [10.5, 17.0], [8, 14], 1, 'dual', [
    rp('entry', 5), rp('shared-kitchen', 16), rp('shared-living', 26),
    ...Array.from({ length: 6 }, () => rp('bedroom', 13)),
    ...Array.from({ length: 6 }, () => rp('ensuite', 3.6, { minWidth: 1.4 })),
  ]),
  tpl('senior-1b-accessible', 'Accessible one-bedroom', 1, 1, 2, [46, 56, 68], [5.8, 9.5], [6, 12], 1, 'single', CORE_ROOMS(1, 1, 26)),
];

// ============================================================================
// Site fixtures
// ============================================================================

export type FixtureKind = 'bar-double' | 'point' | 'townhouse' | 'walkup' | 'gallery';

interface FixtureSpec {
  partial: PartialSpec;
  bars: MassingBar[];
  cores: CorePlacement[];
  corridors: (bars: MassingBar[]) => CorridorSpine[];
  entrances: Entrance[];
  envelope: Rect;
}

function bar(id: string, r: Rect, axis: 'x' | 'y', exteriorSides: Side[]): MassingBar {
  return { id, rect: r, axis, depth: axis === 'x' ? r.h : r.w, length: axis === 'x' ? r.w : r.h, exteriorSides };
}

function core(id: string, barId: string, r: Rect, type: CorePlacement['type'], lifts: number): CorePlacement {
  return { id, rect: r, barId, type, hasElevator: lifts > 0, elevatorCount: lifts };
}

const ALL_SIDES: Side[] = ['front', 'rear', 'left', 'right'];

const FIXTURES: Record<FixtureKind, FixtureSpec> = {
  // 60 × 20 m double-loaded bar, 2 stair/lift cores, one spine, 5 storeys
  'bar-double': {
    partial: {
      name: 'Fixture double-loaded bar', seed: 7, region: 'US', typology: 'corridor-midrise',
      site: { width: 70, depth: 34, streetFacing: 'S', context: 'urban' },
      massing: { storeys: 5, buildingDepth: 20, buildingLength: 60, footprintShape: 'bar', roof: 'flat', coreCount: 2 },
    },
    bars: [bar('BAR-1', { x: 5, y: 7, w: 60, h: 20 }, 'x', ALL_SIDES)],
    cores: [
      core('CORE-1', 'BAR-1', { x: 17, y: 7, w: 6, h: 9.15 }, 'stair-elevator', 2),
      core('CORE-2', 'BAR-1', { x: 43, y: 7, w: 6, h: 9.15 }, 'stair-elevator', 2),
    ],
    corridors: () => [{
      id: 'SPINE-1', barId: 'BAR-1', width: 1.7, loaded: 'both',
      centerline: { a: [5.15, 17], b: [64.85, 17] },
    }],
    entrances: [
      { id: 'ENT-MAIN', position: [20, 7], side: 'front', type: 'main' },
      { id: 'ENT-SERVICE', position: [46, 27], side: 'rear', type: 'service' },
    ],
    envelope: { x: 3, y: 5, w: 64, h: 26 },
  },

  // 28 × 28 m point plate, central core, 12 storeys
  point: {
    partial: {
      name: 'Fixture point tower', seed: 11, region: 'CA', displayUnits: 'metric', typology: 'point-tower',
      site: { width: 38, depth: 38, streetFacing: 'W', context: 'urban' },
      massing: { storeys: 12, buildingDepth: 28, footprintShape: 'point', roof: 'flat', coreCount: 1 },
    },
    bars: [bar('BAR-1', { x: 5, y: 5, w: 28, h: 28 }, 'x', ALL_SIDES)],
    cores: [core('CORE-1', 'BAR-1', { x: 15, y: 15, w: 8, h: 8 }, 'point-core', 3)],
    corridors: () => [],
    entrances: [{ id: 'ENT-MAIN', position: [19, 5], side: 'front', type: 'main' }],
    envelope: { x: 3, y: 3, w: 32, h: 32 },
  },

  // 36 m townhouse bar → 6 × ~6 m houses, 3 storeys, gable roof
  townhouse: {
    partial: {
      name: 'Fixture townhouse row', seed: 3, region: 'UK', displayUnits: 'metric', typology: 'townhouse-row',
      site: { width: 45, depth: 34, streetFacing: 'N', context: 'urban' },
      massing: { storeys: 3, buildingDepth: 11, buildingLength: 39, roof: 'gable', roofPitchDeg: 35 },
    },
    bars: [bar('BAR-1', { x: 3, y: 3, w: 39, h: 11 }, 'x', ALL_SIDES)],
    cores: [],
    corridors: () => [],
    entrances: Array.from({ length: 6 }, (_, k) => ([
      { id: `ENT-U${k + 1}`, position: [round(3.15 + (k + 0.5) * 6.45), 3] as Vec2, side: 'front' as Side, type: 'unit' as const },
      { id: `ENT-G${k + 1}`, position: [round(3.15 + k * 6.45 + 1.8), 3] as Vec2, side: 'front' as Side, type: 'garage' as const },
    ])).flat(),
    envelope: { x: 1.5, y: 3, w: 42, h: 25 },
  },

  // 42 × 14 m walk-up bar, 2 stair cores, 4 units per landing, 3 storeys
  walkup: {
    partial: {
      name: 'Fixture walk-up', seed: 5, region: 'AU', displayUnits: 'metric', typology: 'garden-walkup',
      site: { width: 48, depth: 30, streetFacing: 'N', context: 'suburban' },
      massing: { storeys: 3, buildingDepth: 14, buildingLength: 42, footprintShape: 'bar', roof: 'flat', coreCount: 2 },
    },
    bars: [bar('BAR-1', { x: 3, y: 6, w: 42, h: 14 }, 'x', ALL_SIDES)],
    cores: [
      core('CORE-1', 'BAR-1', { x: 10.1, y: 6, w: 4.5, h: 9.6 }, 'stair', 0),
      core('CORE-2', 'BAR-1', { x: 33.4, y: 6, w: 4.5, h: 9.6 }, 'stair', 0),
    ],
    corridors: () => [],
    entrances: [
      { id: 'ENT-C1', position: [12.35, 6], side: 'front', type: 'main' },
      { id: 'ENT-C2', position: [35.65, 6], side: 'front', type: 'main' },
    ],
    envelope: { x: 3, y: 6, w: 42, h: 18 },
  },

  // 40 × 12 m single-loaded bar with an external access deck on the street face, 5 storeys
  gallery: {
    partial: {
      name: 'Fixture deck access', seed: 13, region: 'NZ', displayUnits: 'metric', typology: 'deck-access',
      site: { width: 46, depth: 30, streetFacing: 'N', context: 'urban' },
      massing: { storeys: 5, buildingDepth: 12, buildingLength: 40, footprintShape: 'bar', roof: 'flat', coreCount: 1 },
    },
    bars: [bar('BAR-1', { x: 3, y: 8, w: 40, h: 12 }, 'x', ALL_SIDES)],
    cores: [core('CORE-1', 'BAR-1', { x: 19, y: 8, w: 5, h: 5.5 }, 'stair-elevator', 1)],
    corridors: () => [{
      id: 'SPINE-1', barId: 'BAR-1', width: 1.5, loaded: 'right',
      centerline: { a: [3.15, 7.25], b: [42.85, 7.25] },
    }],
    entrances: [{ id: 'ENT-MAIN', position: [21.5, 8], side: 'front', type: 'main' }],
    envelope: { x: 3, y: 6, w: 40, h: 20 },
  },
};

export function makeSiteFixture(kind: FixtureKind): SiteModel {
  return makeFixture(kind).site;
}

export interface Fixture {
  kind: FixtureKind;
  spec: BuildingSpec;
  site: SiteModel;
  storeys: StoreyDef[];
  ctx: GenContext;
}

export function makeFixture(kind: FixtureKind, override?: Partial<PartialSpec>): Fixture {
  const fx = FIXTURES[kind];
  const spec = normalizeSpec({ ...fx.partial, ...(override ?? {}) } as PartialSpec);
  const typology = getTypology(spec.typology);
  const storeys = buildStoreys(spec, spec.floors);
  const footprint: Polygon = fx.bars.length === 1
    ? rectToPolygon(fx.bars[0].rect)
    : rectToPolygon(unionRect(fx.bars.map(b => b.rect)));
  const gross = fx.bars.reduce((a, b) => a + b.rect.w * b.rect.h, 0);
  const landscape: LandscapeZone[] = [{
    id: 'LZ-1', type: 'lawn', polygon: rectToPolygon(fx.envelope), area: round(fx.envelope.w * fx.envelope.h, 2),
  }];
  const site: SiteModel = {
    boundary: rectToPolygon({ x: 0, y: 0, w: spec.site.width, h: spec.site.depth }),
    area: round(spec.site.width * spec.site.depth, 2),
    buildableEnvelope: rectToPolygon(fx.envelope),
    setbacks: { ...typology.setbacks, ...(spec.site.setbacks ?? {}) },
    streetFacing: spec.site.streetFacing,
    northRad: 0,
    massing: {
      shape: spec.massing.footprintShape ?? 'bar',
      footprint,
      footprintArea: round(polygonArea(footprint), 2),
      bars: fx.bars,
      storeys,
      heightAboveGrade: round(storeys.filter(s => s.index >= 0 && s.index < 100).reduce((a, s) => a + s.height, 0), 3),
      gfa: round(gross * spec.massing.storeys, 2),
      cores: fx.cores,
      corridors: fx.corridors(fx.bars),
      roof: {
        type: spec.massing.roof,
        pitchRad: ((spec.massing.roofPitchDeg ?? 30) * Math.PI) / 180,
        parapetHeight: spec.massing.parapetHeight ?? 1.1,
        ridgeAxis: fx.bars[0].axis,
      },
    },
    parking: null,
    landscape,
    paths: [],
    driveway: null,
    entrances: fx.entrances,
    elements: [],
    patterns: [],
    derived: {},
  };
  const warnings: string[] = [];
  const ctx: GenContext = {
    spec, typology, rng: createRng(spec.seed).fork('architecture'), storeys, site,
    arch: null, struct: null, mech: null, plumb: null, elec: null, warnings,
  };
  return { kind, spec, site, storeys, ctx };
}

function unionRect(rects: Rect[]): Rect {
  const x1 = Math.min(...rects.map(r => r.x));
  const y1 = Math.min(...rects.map(r => r.y));
  const x2 = Math.max(...rects.map(r => r.x + r.w));
  const y2 = Math.max(...rects.map(r => r.y + r.h));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

// ============================================================================
// stubLayoutUnit
// ============================================================================

/**
 * Crude fallback unit layout: a service band on the wet-wall side (entry hall + bathrooms) with a
 * single wet wall, and the habitable rooms as equal strips beyond it. Enough to exercise every
 * organiser path (entry door, windows, furniture, balcony, internal stair) without pretending to
 * be a real plan.
 */
export const stubLayoutUnit: UnitLayoutFn = (req: UnitLayoutRequest): UnitLayout => {
  const out: UnitLayout = {
    rooms: [], walls: [], doors: [], windows: [], furniture: [],
    entryDoorId: '', wetWallIds: [], bathroomRoomIds: [], patterns: [], warnings: [],
  };
  const { template, accessSide } = req;
  const horizontal = accessSide === 'front' || accessSide === 'rear';
  let counter = 0;
  const nid = (kind: string): string => `${req.unitId}-${req.level}-${kind}${++counter}`;
  const rid = (type: RoomType): string => `R-${req.unitId}-${req.level}-${type.toUpperCase().replace(/[^A-Z0-9]/g, '')}${++counter}`;

  const rect = req.rect;
  const alongMin = horizontal ? rect.x : rect.y;
  const alongMax = horizontal ? rect.x + rect.w : rect.y + rect.h;
  const depth = horizontal ? rect.h : rect.w;

  /** rect from (along range, distance-from-access-face range) */
  const mk = (a0: number, a1: number, c0: number, c1: number): Rect => {
    const A0 = Math.max(alongMin, Math.min(a0, a1));
    const A1 = Math.min(alongMax, Math.max(a0, a1));
    const C0 = Math.max(0, Math.min(c0, c1));
    const C1 = Math.min(depth, Math.max(c0, c1));
    switch (accessSide) {
      case 'front': return { x: round(A0), y: round(rect.y + C0), w: round(A1 - A0), h: round(C1 - C0) };
      case 'rear': return { x: round(A0), y: round(rect.y + rect.h - C1), w: round(A1 - A0), h: round(C1 - C0) };
      case 'left': return { x: round(rect.x + C0), y: round(A0), w: round(C1 - C0), h: round(A1 - A0) };
      default: return { x: round(rect.x + rect.w - C1), y: round(A0), w: round(C1 - C0), h: round(A1 - A0) };
    }
  };

  const addRoom = (type: RoomType, r: Rect, name?: string): RoomDef => {
    const room: RoomDef = {
      id: rid(type), storey: req.storey, unitId: req.unitId, type,
      name: name ?? prettify(type), polygon: rectToPolygon(r), rect: r,
      area: round(r.w * r.h, 3), height: req.ceilingHeight, isWet: roomIsWet(type),
      hasExterior: false, exteriorWallIds: [], wallIds: [], doorIds: [], windowIds: [],
      furnitureIds: [], occupancy: type === 'bedroom' ? 1 : type === 'master-bedroom' ? 2 : 0,
      zone: roomZone(type),
    };
    out.rooms.push(room);
    return room;
  };

  const addWallAC = (c: number, a0: number, a1: number, type: WallDef['type'], t: number): WallDef => {
    const r = mk(a0, a1, c, c);
    const w: WallDef = {
      id: nid('W'), storey: req.storey, unitId: req.unitId,
      start: horizontal ? [r.x, r.y] : [r.x, r.y],
      end: horizontal ? [r.x + r.w, r.y] : [r.x, r.y + r.h],
      thickness: t, height: req.floorToFloor - 0.2, type,
      isExternal: false, loadBearingHint: false,
    };
    out.walls.push(w);
    return w;
  };

  const addWallAlong = (a: number, c0: number, c1: number, type: WallDef['type'], t: number): WallDef => {
    const r = mk(a, a, c0, c1);
    const w: WallDef = {
      id: nid('W'), storey: req.storey, unitId: req.unitId,
      start: horizontal ? [r.x, r.y] : [r.x, r.y],
      end: horizontal ? [r.x, r.y + r.h] : [r.x + r.w, r.y],
      thickness: t, height: req.floorToFloor - 0.2, type,
      isExternal: false, loadBearingHint: false,
    };
    out.walls.push(w);
    return w;
  };

  // ---- internal stair strip (multi-level houses) --------------------------
  let a0 = alongMin;
  const a1 = alongMax;
  if (req.stairRect) {
    const sAlong = horizontal
      ? { s: req.stairRect.x, e: req.stairRect.x + req.stairRect.w }
      : { s: req.stairRect.y, e: req.stairRect.y + req.stairRect.h };
    const stripEnd = Math.min(alongMax - 2.5, Math.max(sAlong.e + 0.1, alongMin + 1.2));
    if (stripEnd > alongMin + 0.8) {
      const runLen = Math.min(depth * 0.5, 4.0);
      const stairRoom = addRoom('stair', mk(alongMin, stripEnd, 1.2, 1.2 + runLen), 'Stair');
      addRoom('hall', mk(alongMin, stripEnd, 0, 1.2), 'Hall');
      if (depth - (1.2 + runLen) > 1.2) addRoom('storage', mk(alongMin, stripEnd, 1.2 + runLen, depth), 'Store');
      addWallAlong(stripEnd, 0, depth, 'partition', SIZES.partitionT);
      const risers = Math.max(2, Math.ceil(req.floorToFloor / 0.18));
      out.stair = {
        rect: stairRoom.rect,
        position: startOfRun(stairRoom.rect, horizontal ? 'y' : 'x'),
        direction: horizontal ? Math.PI / 2 : 0,
        risers, riserHeight: round(req.floorToFloor / risers, 4), tread: 0.28, width: 1.0,
      };
      a0 = stripEnd;
    }
  }

  const alongLen = a1 - a0;
  if (alongLen < 1.6 || depth < 3.0) {
    out.warnings.push(`stub layout: rect ${round(rect.w, 2)}x${round(rect.h, 2)} too small`);
    return out;
  }

  // ---- how much program on this level ------------------------------------
  const multi = req.levelsTotal > 1;
  const entryLevel = req.level === 0;
  const upperLevels = Math.max(1, req.levelsTotal - 1);
  const beds = !multi
    ? template.bedrooms
    : entryLevel ? 0 : distribute(template.bedrooms, upperLevels, req.level - 1);
  const baths = !multi ? Math.max(1, template.bathrooms) : entryLevel ? 1 : Math.max(1, Math.round(template.bathrooms / upperLevels));
  const wantLiving = !multi || entryLevel;

  // ---- service band on the wet-wall side ---------------------------------
  const serviceDepth = round(Math.min(2.6, Math.max(1.8, depth * 0.3)), 3);
  const bathLenWanted = 2.4 * baths;
  const hallLen = Math.max(1.2, alongLen - bathLenWanted);
  const bathLen = baths > 0 ? Math.max(1.5, (alongLen - hallLen) / baths) : 0;
  const hall = addRoom('hall', mk(a0, a0 + hallLen, 0, serviceDepth), entryLevel ? 'Entry Hall' : 'Landing');
  const bathRooms: RoomDef[] = [];
  for (let i = 0; i < baths; i++) {
    const b0 = a0 + hallLen + i * bathLen;
    const type: RoomType = multi && entryLevel ? 'powder' : i === 0 ? 'bathroom' : 'ensuite';
    const room = addRoom(type, mk(b0, b0 + bathLen, 0, serviceDepth));
    bathRooms.push(room);
    out.bathroomRoomIds.push(room.id);
    const divider = addWallAlong(b0, 0, serviceDepth, 'wet', SIZES.partitionT);
    const bathSwing = solveSwing({
      wall: divider, along: round(serviceDepth / 2), width: SIZES.doorBathroom, motion: 'swing',
      into: reachRect(room.rect, divider),
    });
    out.doors.push({
      id: nid('D'), storey: req.storey, wallId: divider.id, along: round(serviceDepth / 2),
      width: SIZES.doorBathroom, height: SIZES.doorHeight, type: 'interior',
      motion: 'swing', hinge: bathSwing.hinge, swing: bathSwing.swing, swingIntoRoomId: room.id,
      fromRoomId: hall.id, toRoomId: room.id, unitId: req.unitId, ref: `hall1~${type}${i + 1}`,
    });
    room.wallIds.push(divider.id);
  }

  // the wet wall: kitchen and bathrooms back onto it (XD-01)
  const wetWall = addWallAC(serviceDepth, a0, a1, 'wet', SIZES.wetWallT);
  out.wetWallIds.push(wetWall.id);
  hall.wallIds.push(wetWall.id);

  // ---- habitable strips beyond the service band --------------------------
  const weights: { type: RoomType; w: number }[] = [];
  if (wantLiving) weights.push({ type: 'living-kitchen', w: 1.7 });
  for (let i = 0; i < beds; i++) weights.push({ type: i === 0 && wantLiving === false ? 'master-bedroom' : i === 0 ? 'master-bedroom' : 'bedroom', w: 1.0 });
  if (weights.length === 0) weights.push({ type: 'flex', w: 1.0 });
  const wSum = weights.reduce((a, x) => a + x.w, 0);
  let cursor = a0;
  const habitable: RoomDef[] = [];
  for (let i = 0; i < weights.length; i++) {
    const len = (alongLen * weights[i].w) / wSum;
    const r = mk(cursor, i === weights.length - 1 ? a1 : cursor + len, serviceDepth, depth);
    const room = addRoom(weights[i].type, r);
    habitable.push(room);
    if (i > 0) {
      const div = addWallAlong(cursor, serviceDepth, depth, 'partition', SIZES.partitionT);
      room.wallIds.push(div.id);
    }
    // door from the hall through the wet wall
    const doorAlong = Math.abs(dotAlong(wetWall, r) );
    const sol = solveSwing({
      wall: wetWall, along: round(doorAlong), width: SIZES.doorInterior, motion: 'swing',
      into: reachRect(room.rect, wetWall),
    });
    out.doors.push({
      id: nid('D'), storey: req.storey, wallId: wetWall.id, along: round(doorAlong),
      width: SIZES.doorInterior, height: SIZES.doorHeight, type: 'interior',
      motion: 'swing', hinge: sol.hinge, swing: sol.swing, swingIntoRoomId: room.id,
      fromRoomId: hall.id, toRoomId: room.id, unitId: req.unitId, ref: `hall1~${weights[i].type}${i + 1}`,
    });
    cursor += len;
  }
  out.kitchenRoomId = habitable.find(r => r.type === 'living-kitchen')?.id;

  // ---- entry door --------------------------------------------------------
  const accessWall = req.boundaryWalls[accessSide];
  if (accessWall && entryLevel) {
    const along = clampAlong(accessWall, projectRange(accessWall, hall.rect), SIZES.doorUnitEntry);
    const sol = solveSwing({
      wall: accessWall, along: round(along), width: SIZES.doorUnitEntry, motion: 'swing',
      into: reachRect(hall.rect, accessWall),
    });
    const d: DoorDef = {
      id: nid('D'), storey: req.storey, wallId: accessWall.id, along: round(along),
      width: SIZES.doorUnitEntry, height: SIZES.doorHeight, type: 'unit-entry' as const,
      motion: 'swing', hinge: sol.hinge, swing: sol.swing, swingIntoRoomId: hall.id,
      fromRoomId: hall.id, unitId: req.unitId, fireRated: true, ref: 'entry',
    };
    out.doors.push(d);
    out.entryDoorId = d.id;
  } else if (!accessWall) {
    out.warnings.push(`stub layout: no boundary wall on the access side ${accessSide}`);
  }

  // ---- windows in every exterior boundary wall the room touches ----------
  for (const room of [...habitable, ...out.rooms.filter(r => r.type === 'stair' || r.type === 'hall')]) {
    for (const side of req.exteriorSides) {
      const wall = req.boundaryWalls[side];
      if (!wall) continue;
      if (!touches(rect, room.rect, side)) continue;
      const range = projectRange(wall, room.rect);
      const wallLen = Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]);
      const span = Math.min(range.e, wallLen) - Math.max(range.s, 0);
      if (span < 1.0) continue;
      const width = Math.max(0.9, Math.min(2.2, span * 0.6));
      const along = clampAlong(wall, range, width);
      out.windows.push({
        id: nid('N'), storey: req.storey, wallId: wall.id, along: round(along),
        sill: room.type === 'living-kitchen' ? 0.45 : SIZES.windowSill, width: round(width, 3),
        height: SIZES.windowHeight, roomId: room.id, exposure: req.exposures[side], unitId: req.unitId,
      });
      room.hasExterior = true;
      if (!room.exteriorWallIds.includes(wall.id)) room.exteriorWallIds.push(wall.id);
    }
  }

  // ---- balcony -----------------------------------------------------------
  if (req.balcony) {
    const side = req.balcony.side;
    const d = req.balcony.depth;
    const bRect: Rect = side === 'front'
      ? { x: round(rect.x + 0.3), y: round(rect.y - d), w: round(Math.max(1, rect.w - 0.6)), h: round(d) }
      : side === 'rear'
        ? { x: round(rect.x + 0.3), y: round(rect.y + rect.h), w: round(Math.max(1, rect.w - 0.6)), h: round(d) }
        : side === 'left'
          ? { x: round(rect.x - d), y: round(rect.y + 0.3), w: round(d), h: round(Math.max(1, rect.h - 0.6)) }
          : { x: round(rect.x + rect.w), y: round(rect.y + 0.3), w: round(d), h: round(Math.max(1, rect.h - 0.6)) };
    const room = addRoom('balcony', bRect, 'Balcony');
    room.height = req.ceilingHeight;
    out.balconyRoomId = room.id;
    const wall = req.boundaryWalls[side];
    const host = habitable[0];
    if (wall && host) {
      const range = projectRange(wall, host.rect);
      const balAlong = round(clampAlong(wall, range, 1.6));
      const sol = solveSwing({ wall, along: balAlong, width: 1.6, motion: 'sliding', into: reachRect(host.rect, wall) });
      out.doors.push({
        id: nid('D'), storey: req.storey, wallId: wall.id, along: balAlong,
        width: 1.6, height: 2.2, type: 'balcony', motion: 'sliding', hinge: sol.hinge, swing: sol.swing,
        fromRoomId: host.id, toRoomId: room.id, unitId: req.unitId, ref: 'balcony',
      });
    }
  }

  // ---- furniture ---------------------------------------------------------
  if (req.options.furniture) {
    for (const room of out.rooms) furnish(out, req, room);
  }

  out.patterns.push({
    patternId: 'XD-01', unitId: req.unitId, storey: req.storey, elementIds: [wetWall.id],
    params: { wetWallSide: req.wetWallSide, stackAlong: req.stackAlong ?? 0, bathrooms: baths },
    note: 'stub layout: single wet wall on the access side',
  });
  return out;
};

function distribute(total: number, buckets: number, index: number): number {
  const base = Math.floor(total / buckets);
  const extra = total - base * buckets;
  return base + (index < extra ? 1 : 0);
}

function prettify(t: string): string {
  return t.split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' ');
}

function startOfRun(r: Rect, axis: 'x' | 'y'): [number, number] {
  return axis === 'y' ? [round(r.x + r.w / 2), round(r.y)] : [round(r.x), round(r.y + r.h / 2)];
}

/** Distance range of `r` projected onto a wall's direction, measured from wall.start */
function projectRange(wall: WallDef, r: Rect): { s: number; e: number } {
  const dx = wall.end[0] - wall.start[0];
  const dy = wall.end[1] - wall.start[1];
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const ts = [
    (r.x - wall.start[0]) * ux + (r.y - wall.start[1]) * uy,
    (r.x + r.w - wall.start[0]) * ux + (r.y - wall.start[1]) * uy,
    (r.x - wall.start[0]) * ux + (r.y + r.h - wall.start[1]) * uy,
    (r.x + r.w - wall.start[0]) * ux + (r.y + r.h - wall.start[1]) * uy,
  ];
  return { s: Math.min(...ts), e: Math.max(...ts) };
}

function clampAlong(wall: WallDef, range: { s: number; e: number }, width: number): number {
  const len = Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]);
  const mid = (Math.max(range.s, 0) + Math.min(range.e, len)) / 2;
  return Math.max(width / 2 + 0.1, Math.min(len - width / 2 - 0.1, mid));
}

function dotAlong(wall: WallDef, r: Rect): number {
  const range = projectRange(wall, r);
  const len = Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]);
  return Math.max(0.5, Math.min(len - 0.5, (range.s + range.e) / 2));
}

function touches(unit: Rect, room: Rect, side: Side): boolean {
  const eps = 0.06;
  switch (side) {
    case 'front': return Math.abs(room.y - unit.y) < eps;
    case 'rear': return Math.abs((room.y + room.h) - (unit.y + unit.h)) < eps;
    case 'left': return Math.abs(room.x - unit.x) < eps;
    default: return Math.abs((room.x + room.w) - (unit.x + unit.w)) < eps;
  }
}

function furnish(out: UnitLayout, req: UnitLayoutRequest, room: RoomDef): void {
  const add = (type: FurnitureType, x: number, y: number, w: number, d: number, h: number, extra?: Partial<FurnitureDef>): void => {
    const f: FurnitureDef = {
      id: `${req.unitId}-${req.level}-F${out.furniture.length + 1}`,
      storey: req.storey, roomId: room.id, unitId: req.unitId, type,
      position: [round(x), round(y)], width: w, depth: d, height: h, rotation: 0, ...extra,
    };
    out.furniture.push(f);
    room.furnitureIds.push(f.id);
  };
  const r = room.rect;
  if (r.w < 1.0 || r.h < 1.0) return;
  switch (room.type) {
    case 'master-bedroom':
      add('bed-queen', r.x + 0.4, r.y + 0.3, 1.6, 2.0, 0.55);
      add('wardrobe', r.x + r.w - 0.7, r.y + 0.3, 0.6, Math.min(2.0, r.h - 0.6), 2.2);
      add('nightstand', r.x + 0.1, r.y + 0.3, 0.45, 0.4, 0.55);
      break;
    case 'bedroom':
      add('bed-double', r.x + 0.3, r.y + 0.3, 1.4, 2.0, 0.55);
      add('wardrobe', r.x + r.w - 0.7, r.y + 0.3, 0.6, Math.min(1.6, r.h - 0.6), 2.2);
      break;
    case 'living-kitchen':
    case 'living':
      add('kitchen-counter', r.x + 0.2, r.y + 0.2, Math.min(3.0, r.w - 0.4), 0.65, 0.9);
      add('kitchen-sink', r.x + 0.5, r.y + 0.25, 0.6, 0.5, 0.2, { needsWater: true });
      add('range', r.x + 1.3, r.y + 0.2, 0.6, 0.65, 0.9, { needsPower: true });
      add('fridge', r.x + 2.1, r.y + 0.2, 0.7, 0.7, 1.8, { needsPower: true });
      add('sofa-3', r.x + 0.4, r.y + r.h - 1.2, Math.min(2.2, r.w - 0.8), 0.9, 0.8);
      add('dining-table-4', r.x + Math.max(0.4, r.w - 1.6), r.y + r.h / 2 - 0.4, 1.2, 0.8, 0.75);
      break;
    case 'bathroom':
    case 'ensuite':
      add('wc', r.x + 0.15, r.y + 0.15, 0.4, 0.7, 0.8, { needsWater: true });
      add('lavatory', r.x + 0.15, r.y + Math.min(1.0, r.h - 0.5), 0.55, 0.45, 0.85, { needsWater: true });
      if (r.w > 1.6) add('shower', r.x + r.w - 0.95, r.y + 0.15, 0.9, 0.9, 2.0, { needsWater: true });
      break;
    case 'powder':
    case 'wc':
      add('wc', r.x + 0.15, r.y + 0.15, 0.4, 0.7, 0.8, { needsWater: true });
      add('lavatory', r.x + 0.15, r.y + Math.min(1.0, r.h - 0.5), 0.5, 0.4, 0.85, { needsWater: true });
      break;
    case 'balcony':
      if (r.w > 1.4 && r.h > 1.0) add('outdoor-table', r.x + 0.2, r.y + 0.2, 0.8, 0.8, 0.72);
      break;
    default:
      break;
  }
}
