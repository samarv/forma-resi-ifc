/**
 * Coherent synthetic GenContext for plumbing tests (and for developing against architecture,
 * structure and mechanical while those modules are still being written).
 *
 * The building is a 4-storey single-loaded corridor bar, 6 identical dwellings per storey, stacked
 * identically floor to floor:
 *
 *   y 15.45 ─── rear exterior wall
 *   y 14.45 ─── corridor centreline (1.7 m wide corridor, y 13.6 … 15.3)
 *   y 13.50 ─── corridor wall
 *              ┌── hall ──┬─ laundry ─┐          per dwelling, local u = x − unit.x
 *              │ bathroom │           │          wet wall at u = 5.0 (type 'wet')
 *              │ living-kitchen (u 0…4.9)        kitchen sink + dishwasher on the west face
 *   y  8.80 ─── cross partition
 *              │ master bedroom │ bedroom │
 *   y  4.00 ─── front exterior wall
 *
 * Cores + shafts sit at both ends of the bar; L01 additionally has a water room (for the incoming
 * service and the meter) and a lobby.
 */
import type {
  ArchModel, BuildingSpec, CoreDef, CorridorDef, DoorDef, FloorPlan, FurnitureDef,
  FurnitureType, GenContext, MassingBar, MechModel, Polygon, Rect, RoomDef, RoomType, ShaftDef,
  SiteModel, StairDef, StoreyDef, StructModel, UnitInstance, Vec2, WallDef, WallType, Zone,
} from '../../core/types.ts';
import { normalizeSpec, buildStoreys, type PartialSpec } from '../../core/spec.ts';
import { getTypology } from '../../core/typologies.ts';
import { createRng } from '../../core/rng.ts';
import { rectToPolygon, round } from '../../core/geometry.ts';
import { unitId as makeUnitId, roomId as makeRoomId } from '../../core/ids.ts';

// ---------------------------------------------------------------------------
// Geometry of the fixture building
// ---------------------------------------------------------------------------

export const FIXTURE_GEOM = {
  site: { width: 80, depth: 40 },
  /** exterior wall centrelines */
  frontY: 4.0,
  rearY: 15.45,
  leftX: 3.0,
  rightX: 72.6,
  extT: 0.3,
  /** corridor */
  corridorWallY: 13.5,
  corridorWallT: 0.2,
  corridorY0: 13.6,
  corridorY1: 15.3,
  corridorCenterY: 14.45,
  /** dwellings */
  unitCount: 6,
  unitPitch: 10.0,
  unitX0: 7.85,
  unitW: 9.8,
  unitY0: 4.15,
  unitH: 9.25,
  partyT: 0.2,
  /** wet wall, local u */
  wetU: 5.0,
  wetT: 0.2,
  cores: [
    { x: 3.15, y: 7.6, w: 4.5, h: 5.8 },
    { x: 67.85, y: 7.6, w: 4.6, h: 5.8 },
  ] as Rect[],
  shafts: [
    { x: 3.15, y: 12.0, w: 1.4, h: 1.4 },
    { x: 71.05, y: 12.0, w: 1.4, h: 1.4 },
  ] as Rect[],
  waterRoom: { x: 3.15, y: 4.15, w: 4.5, h: 3.45 } as Rect,
  lobby: { x: 67.85, y: 4.15, w: 4.6, h: 3.45 } as Rect,
  barOuter: { x: 2.85, y: 3.85, w: 69.9, h: 11.75 } as Rect,
} as const;

/** Rooms of one dwelling in local (u, v) coordinates, u from unit.x, v from unit.y */
const UNIT_ROOMS: { key: string; type: RoomType; u0: number; v0: number; u1: number; v1: number; zone: Zone; wet: boolean; ext: boolean }[] = [
  { key: 'MBED', type: 'master-bedroom', u0: 0, v0: 0, u1: 4.8, v1: 4.6, zone: 'private', wet: false, ext: true },
  { key: 'BED2', type: 'bedroom', u0: 4.9, v0: 0, u1: 9.8, v1: 4.6, zone: 'private', wet: false, ext: true },
  { key: 'LIVK', type: 'living-kitchen', u0: 0, v0: 4.7, u1: 4.9, v1: 9.25, zone: 'public', wet: true, ext: true },
  { key: 'BATH', type: 'bathroom', u0: 5.1, v0: 4.7, u1: 7.5, v1: 7.4, zone: 'service', wet: true, ext: false },
  { key: 'HALL', type: 'hall', u0: 5.1, v0: 7.5, u1: 9.8, v1: 9.25, zone: 'circulation', wet: false, ext: false },
  { key: 'UTIL', type: 'laundry', u0: 7.6, v0: 4.7, u1: 9.8, v1: 7.4, zone: 'service', wet: true, ext: false },
];

/** Water fixtures of one dwelling in local (u, v) — centres, not corners */
const UNIT_FIXTURES: { room: string; type: FurnitureType; u: number; v: number; w: number; d: number; h: number }[] = [
  { room: 'BATH', type: 'wc', u: 5.3, v: 5.15, w: 0.4, d: 0.72, h: 0.78 },
  { room: 'BATH', type: 'vanity', u: 5.3, v: 6.1, w: 0.6, d: 0.5, h: 0.85 },
  { room: 'BATH', type: 'shower', u: 5.6, v: 6.8, w: 0.9, d: 0.9, h: 2.1 },
  { room: 'LIVK', type: 'kitchen-sink', u: 4.7, v: 6.0, w: 0.6, d: 0.6, h: 0.9 },
  { room: 'LIVK', type: 'dishwasher', u: 4.7, v: 6.8, w: 0.6, d: 0.6, h: 0.85 },
];

function poly(r: Rect): Polygon { return rectToPolygon(r); }
function rectOf(x0: number, y0: number, x1: number, y1: number): Rect {
  return { x: round(x0, 4), y: round(y0, 4), w: round(x1 - x0, 4), h: round(y1 - y0, 4) };
}

export interface FixtureOptions {
  storeys?: number;
  spec?: PartialSpec;
  /** Omit the water-heater furniture so the DHW step has to place tanks itself */
  noWaterHeaterFurniture?: boolean;
  /** Drop every needsWater flag so the bathroom-synthesis path is exercised */
  noWaterFurniture?: boolean;
  /** Clear unit.wetWallIds so the fallback wall search is exercised */
  noWetWallIds?: boolean;
  detail?: 'low' | 'medium' | 'high';
  /** 'gable' switches the roof to gutters + corner downpipes */
  roofType?: 'flat' | 'gable';
  /** Drop the corridors so the horizontal-main fallback is exercised */
  noCorridors?: boolean;
}

export function makeContextFixture(opts: FixtureOptions = {}): GenContext {
  const g = FIXTURE_GEOM;
  const storeyCount = opts.storeys ?? 4;
  const base: PartialSpec = {
    name: 'Plumbing Test Bar',
    seed: 7,
    region: 'US',
    typology: 'corridor-midrise',
    site: { width: g.site.width, depth: g.site.depth, streetFacing: 'S', context: 'urban' },
    massing: { storeys: storeyCount, footprintShape: 'bar', roof: opts.roofType ?? 'flat' },
  };
  const override: Partial<PartialSpec> = opts.spec ?? {};
  const spec: BuildingSpec = normalizeSpec({
    ...base,
    ...override,
    typology: override.typology ?? base.typology,
    site: { ...base.site, ...(override.site ?? {}) },
    massing: { ...base.massing, ...(override.massing ?? {}) },
    options: { ...(opts.detail ? { detail: opts.detail } : {}), ...(override.options ?? {}) },
  });
  const typology = getTypology(spec.typology);
  const storeys = buildStoreys(spec, spec.floors);
  const above = storeys.filter(s => s.index >= 0 && s.index < 100);
  const warnings: string[] = [];

  const site = makeSite(spec, storeys);
  const arch = makeArch(spec, storeys, above, opts);
  const struct = makeStruct(arch, above);
  const mech = makeMech(arch, above);

  return {
    spec,
    typology,
    rng: createRng(spec.seed).fork('plumbing'),
    storeys,
    site,
    arch,
    struct,
    mech,
    plumb: null,
    elec: null,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Site
// ---------------------------------------------------------------------------

function makeSite(spec: BuildingSpec, storeys: StoreyDef[]): SiteModel {
  const g = FIXTURE_GEOM;
  const boundary: Polygon = [[0, 0], [spec.site.width, 0], [spec.site.width, spec.site.depth], [0, spec.site.depth]];
  const bar: MassingBar = {
    id: 'BAR-1',
    rect: { ...g.barOuter },
    axis: 'x',
    depth: g.barOuter.h,
    length: g.barOuter.w,
    exteriorSides: ['front', 'rear', 'left', 'right'],
  };
  const above = storeys.filter(s => s.index >= 0 && s.index < 100);
  const f2fSum = above.reduce((s, x) => s + x.height, 0);
  return {
    boundary,
    area: spec.site.width * spec.site.depth,
    buildableEnvelope: [[3, 3], [spec.site.width - 3, 3], [spec.site.width - 3, spec.site.depth - 6], [3, spec.site.depth - 6]],
    setbacks: { front: 3, side: 3, rear: 6 },
    streetFacing: spec.site.streetFacing,
    northRad: 0,
    massing: {
      shape: 'bar',
      footprint: poly(g.barOuter),
      footprintArea: g.barOuter.w * g.barOuter.h,
      bars: [bar],
      storeys,
      heightAboveGrade: f2fSum,
      gfa: g.barOuter.w * g.barOuter.h * above.length,
      cores: g.cores.map((r, i) => ({
        id: `SIT-CORE-${i + 1}`, rect: { ...r }, barId: 'BAR-1',
        type: 'stair-elevator' as const, hasElevator: true, elevatorCount: 1,
      })),
      corridors: [{
        id: 'SIT-COR-1', barId: 'BAR-1',
        centerline: { a: [g.unitX0 - 4.7, g.corridorCenterY], b: [g.rightX - 0.15, g.corridorCenterY] },
        width: 1.7, loaded: 'left',
      }],
      roof: { type: 'flat', pitchRad: 0, parapetHeight: 1.1, ridgeAxis: 'x' },
    },
    parking: null,
    landscape: [],
    paths: [],
    driveway: null,
    entrances: [{ id: 'SIT-ENT-1', position: [g.lobby.x + g.lobby.w / 2, g.frontY], side: 'front', type: 'main' }],
    elements: [],
    patterns: [],
    derived: {},
  };
}

// ---------------------------------------------------------------------------
// Architecture
// ---------------------------------------------------------------------------

function makeArch(spec: BuildingSpec, storeys: StoreyDef[], above: StoreyDef[], opts: FixtureOptions): ArchModel {
  const g = FIXTURE_GEOM;
  const rooms: RoomDef[] = [];
  const walls: WallDef[] = [];
  const doors: DoorDef[] = [];
  const furniture: FurnitureDef[] = [];
  const units: UnitInstance[] = [];
  const floors: FloorPlan[] = [];
  const stairs: StairDef[] = [];

  const wall = (
    id: string, storey: string, a: Vec2, b: Vec2, t: number, h: number, type: WallType,
    extra: Partial<WallDef> = {},
  ): WallDef => {
    const w: WallDef = {
      id, storey, start: a, end: b, thickness: t, height: h, type,
      isExternal: type === 'exterior', loadBearingHint: type === 'exterior' || type === 'party',
      ...extra,
    };
    walls.push(w);
    return w;
  };

  for (const s of above) {
    const f2f = s.height;
    const ceiling = Math.min(s.index === 0 ? 3.2 : 2.65, f2f - 0.45);
    const wallH = ceiling;
    const storey = s.id;
    const roomIds: string[] = [];
    const commonRoomIds: string[] = [];
    const unitIds: string[] = [];
    const wallIds: string[] = [];
    const extWallIds: string[] = [];

    // --- shell walls -------------------------------------------------------
    const front = wall(`ARC-${storey}-WALL-F`, storey, [g.leftX, g.frontY], [g.rightX, g.frontY], g.extT, wallH, 'exterior', { exposure: 'S' });
    const rear = wall(`ARC-${storey}-WALL-R`, storey, [g.rightX, g.rearY], [g.leftX, g.rearY], g.extT, wallH, 'exterior', { exposure: 'N' });
    const left = wall(`ARC-${storey}-WALL-L`, storey, [g.leftX, g.rearY], [g.leftX, g.frontY], g.extT, wallH, 'exterior', { exposure: 'E' });
    const right = wall(`ARC-${storey}-WALL-RT`, storey, [g.rightX, g.frontY], [g.rightX, g.rearY], g.extT, wallH, 'exterior', { exposure: 'W' });
    for (const w of [front, rear, left, right]) { wallIds.push(w.id); extWallIds.push(w.id); }
    const corridorWall = wall(`ARC-${storey}-WALL-COR`, storey,
      [g.unitX0 - 4.7, g.corridorWallY], [g.rightX - 0.15, g.corridorWallY], g.corridorWallT, wallH, 'corridor');
    wallIds.push(corridorWall.id);
    for (let i = 0; i <= g.unitCount; i++) {
      const x = g.unitX0 - 0.1 + i * g.unitPitch;
      const w = wall(`ARC-${storey}-WALL-P${i}`, storey, [x, g.unitY0], [x, g.corridorWallY], g.partyT, wallH, 'party');
      wallIds.push(w.id);
    }

    // --- corridor ----------------------------------------------------------
    const corridorRect = rectOf(g.unitX0 - 4.7, g.corridorY0, g.rightX - 0.15, g.corridorY1);
    const corridorRoomId = makeRoomId(storey, 'CORRIDOR', 1);
    rooms.push({
      id: corridorRoomId, storey, type: 'corridor', name: 'Corridor',
      polygon: poly(corridorRect), rect: corridorRect, area: corridorRect.w * corridorRect.h,
      height: ceiling, isWet: false, hasExterior: false, exteriorWallIds: [],
      wallIds: [corridorWall.id, rear.id], doorIds: [], windowIds: [], furnitureIds: [],
      occupancy: 0, zone: 'circulation',
    });
    roomIds.push(corridorRoomId);
    commonRoomIds.push(corridorRoomId);
    const corridor: CorridorDef = {
      id: `ARC-${storey}-COR-1`, storey, polygon: poly(corridorRect),
      centerline: [{ a: [corridorRect.x, g.corridorCenterY], b: [corridorRect.x + corridorRect.w, g.corridorCenterY] }],
      width: 1.7, roomId: corridorRoomId,
    };

    // --- cores -------------------------------------------------------------
    g.cores.forEach((r, ci) => {
      const id = makeRoomId(storey, 'STAIR', ci + 1);
      rooms.push({
        id, storey, type: 'stair', name: `Stair ${ci + 1}`,
        polygon: poly(r), rect: { ...r }, area: r.w * r.h, height: ceiling,
        isWet: false, hasExterior: ci === 0, exteriorWallIds: [], wallIds: [],
        doorIds: [], windowIds: [], furnitureIds: [], occupancy: 0, zone: 'circulation',
      });
      roomIds.push(id);
      commonRoomIds.push(id);
      stairs.push({
        id: `ARC-${storey}-STR-${ci + 1}`, coreId: `ARC-CORE-${ci + 1}`, storey,
        position: [r.x + 0.6, r.y + 0.6], direction: Math.PI / 2,
        risers: Math.round(f2f / 0.175), riserHeight: 0.175, tread: 0.28, width: 1.1,
        flights: 2, isExit: true,
      });
    });

    // --- ground-floor service rooms ---------------------------------------
    if (s.index === 0) {
      const wr = makeRoomId(storey, 'WATERROOM', 1);
      rooms.push({
        id: wr, storey, type: 'water-room', name: 'Water / service room',
        polygon: poly(g.waterRoom), rect: { ...g.waterRoom }, area: g.waterRoom.w * g.waterRoom.h,
        height: ceiling, isWet: true, hasExterior: true, exteriorWallIds: [front.id, left.id],
        wallIds: [front.id, left.id], doorIds: [], windowIds: [], furnitureIds: [],
        occupancy: 0, zone: 'service',
      });
      roomIds.push(wr); commonRoomIds.push(wr);
      const lb = makeRoomId(storey, 'LOBBY', 1);
      rooms.push({
        id: lb, storey, type: 'lobby', name: 'Entrance lobby',
        polygon: poly(g.lobby), rect: { ...g.lobby }, area: g.lobby.w * g.lobby.h,
        height: ceiling, isWet: false, hasExterior: true, exteriorWallIds: [front.id, right.id],
        wallIds: [front.id, right.id], doorIds: [], windowIds: [], furnitureIds: [],
        occupancy: 4, zone: 'public',
      });
      roomIds.push(lb); commonRoomIds.push(lb);
    } else {
      for (const [ri, r] of [g.waterRoom, g.lobby].entries()) {
        const id = makeRoomId(storey, 'STORAGE', ri + 1);
        rooms.push({
          id, storey, type: 'storage', name: `Store ${ri + 1}`,
          polygon: poly(r), rect: { ...r }, area: r.w * r.h, height: ceiling,
          isWet: false, hasExterior: true, exteriorWallIds: [front.id],
          wallIds: [front.id], doorIds: [], windowIds: [], furnitureIds: [],
          occupancy: 0, zone: 'service',
        });
        roomIds.push(id); commonRoomIds.push(id);
      }
    }

    // --- dwellings ---------------------------------------------------------
    for (let i = 0; i < g.unitCount; i++) {
      const ux = g.unitX0 + i * g.unitPitch;
      const uid = makeUnitId(storey, i + 1);
      const netRect = rectOf(ux, g.unitY0, ux + g.unitW, g.unitY0 + g.unitH);
      const hasLaundry = i % 2 === 0;
      const unitRoomIds: string[] = [];
      let kitchenRoomId: string | undefined;
      const bathroomRoomIds: string[] = [];
      const furnitureIdsByRoom = new Map<string, string[]>();

      // wet wall + partitions
      const wetWall = wall(`ARC-${storey}-WET-${i + 1}`, storey,
        [ux + g.wetU, g.unitY0 + 4.7], [ux + g.wetU, g.unitY0 + g.unitH],
        g.wetT, wallH, 'wet', { unitId: uid, loadBearingHint: false });
      wallIds.push(wetWall.id);
      const cross = wall(`ARC-${storey}-PRT-${i + 1}A`, storey,
        [ux, g.unitY0 + 4.65], [ux + g.unitW, g.unitY0 + 4.65], 0.1, wallH, 'partition', { unitId: uid });
      const bedSplit = wall(`ARC-${storey}-PRT-${i + 1}B`, storey,
        [ux + 4.85, g.unitY0], [ux + 4.85, g.unitY0 + 4.6], 0.1, wallH, 'partition', { unitId: uid });
      const hallSplit = wall(`ARC-${storey}-PRT-${i + 1}C`, storey,
        [ux + 5.1, g.unitY0 + 7.45], [ux + g.unitW, g.unitY0 + 7.45], 0.1, wallH, 'partition', { unitId: uid });
      const utilSplit = wall(`ARC-${storey}-PRT-${i + 1}D`, storey,
        [ux + 7.55, g.unitY0 + 4.7], [ux + 7.55, g.unitY0 + 7.45], 0.1, wallH, 'partition', { unitId: uid });
      for (const w of [cross, bedSplit, hallSplit, utilSplit]) wallIds.push(w.id);

      // entry door in the corridor wall
      const entryDoorId = `ARC-${storey}-DOOR-U${i + 1}`;
      doors.push({
        id: entryDoorId, storey, wallId: corridorWall.id,
        along: round(ux + 7.5 - (g.unitX0 - 4.7), 4),
        width: 0.9, height: 2.1, type: 'unit-entry', operation: 'SINGLE_SWING_LEFT',
        toRoomId: makeRoomId(uid, 'HALL', 1), fromRoomId: corridorRoomId, fireRated: true, unitId: uid,
      });

      // rooms (half the dwellings get a store instead of a laundry)
      for (const r of UNIT_ROOMS) {
        const type: RoomType = r.key === 'UTIL' && !hasLaundry ? 'storage' : r.type;
        const rect = rectOf(ux + r.u0, g.unitY0 + r.v0, ux + r.u1, g.unitY0 + r.v1);
        const id = makeRoomId(uid, r.key, 1);
        const roomWallIds = [wetWall.id, cross.id, bedSplit.id, hallSplit.id, utilSplit.id];
        rooms.push({
          id, storey, unitId: uid, type,
          name: `${type} ${i + 1}`,
          polygon: poly(rect), rect, area: round(rect.w * rect.h, 3), height: ceiling,
          isWet: r.wet, hasExterior: r.ext,
          exteriorWallIds: r.ext ? [front.id] : [],
          wallIds: roomWallIds, doorIds: r.key === 'HALL' ? [entryDoorId] : [],
          windowIds: [], furnitureIds: [],
          occupancy: r.type === 'master-bedroom' ? 2 : r.type === 'bedroom' ? 1 : 0,
          zone: r.zone,
        });
        unitRoomIds.push(id);
        roomIds.push(id);
        if (r.key === 'LIVK') kitchenRoomId = id;
        if (r.key === 'BATH') bathroomRoomIds.push(id);
      }

      // water fixtures
      const addFurn = (roomKey: string, type: FurnitureType, u: number, v: number, w: number, d: number, h: number): void => {
        const roomId = makeRoomId(uid, roomKey, 1);
        const id = `ARC-${storey}-FURN-${uid}-${type}-${furniture.length}`;
        furniture.push({
          id, storey, roomId, unitId: uid, type,
          // position is the min corner BEFORE rotation; rotation 0 → centre = position + (w/2, d/2)
          position: [round(ux + u - w / 2, 4), round(g.unitY0 + v - d / 2, 4)],
          width: w, depth: d, height: h, rotation: 0,
          needsWater: !opts.noWaterFurniture,
          needsPower: type === 'dishwasher' || type === 'washer' || type === 'water-heater',
        });
        const list = furnitureIdsByRoom.get(roomId) ?? [];
        list.push(id);
        furnitureIdsByRoom.set(roomId, list);
      };
      for (const f of UNIT_FIXTURES) addFurn(f.room, f.type, f.u, f.v, f.w, f.d, f.h);
      if (hasLaundry) addFurn('UTIL', 'washer', 8.0, 5.2, 0.6, 0.65, 0.9);
      if (hasLaundry && i % 4 === 0 && !opts.noWaterHeaterFurniture) {
        addFurn('UTIL', 'water-heater', 9.2, 6.6, 0.6, 0.6, 1.5);
      }
      for (const [roomId, ids] of furnitureIdsByRoom) {
        const room = rooms.find(r => r.id === roomId && r.storey === storey);
        if (room) room.furnitureIds = ids;
      }

      units.push({
        id: uid, templateId: '2b2b', storeys: [storey],
        rect: rectOf(ux - 0.1, g.unitY0 - 0.15, ux + g.unitW + 0.1, g.corridorWallY),
        polygon: poly(netRect), area: round(netRect.w * netRect.h, 2),
        bedrooms: 2, bathrooms: 1, occupants: 3, aspect: 'single', accessSide: 'rear',
        entryDoorId, roomIds: unitRoomIds,
        wetWallIds: opts.noWetWallIds ? [] : [wetWall.id],
        kitchenRoomId, bathroomRoomIds,
        barId: 'BAR-1', coreId: i < g.unitCount / 2 ? 'ARC-CORE-1' : 'ARC-CORE-2',
      });
      unitIds.push(uid);
    }

    floors.push({
      storey, use: s.use === 'roof' || s.use === 'site' || s.use === 'foundation' ? 'residential' : s.use,
      outline: poly(g.barOuter), area: g.barOuter.w * g.barOuter.h,
      floorToFloor: f2f, ceilingHeight: ceiling, slabThickness: 0.2,
      corridors: opts.noCorridors ? [] : [corridor], unitIds, roomIds, commonRoomIds,
      wallIds, exteriorWallIds: extWallIds, balconies: [], wwr: 0.35,
    });
  }

  const cores: CoreDef[] = FIXTURE_GEOM.cores.map((r, i) => ({
    id: `ARC-CORE-${i + 1}`, rect: { ...r }, storeys: above.map(s => s.id),
    type: 'stair-elevator', stairIds: above.map(s => `ARC-${s.id}-STR-${i + 1}`),
    elevatorIds: [`ARC-LIFT-${i + 1}`],
    roomIds: above.map(s => makeRoomId(s.id, 'STAIR', i + 1)),
    isExit: true,
  }));
  const shafts: ShaftDef[] = FIXTURE_GEOM.shafts.map((r, i) => ({
    id: `ARC-SHAFT-${i + 1}`, rect: { ...r }, storeys: above.map(s => s.id),
    purpose: 'combined',
    servesUnitIds: units.filter(u => u.coreId === `ARC-CORE-${i + 1}`).map(u => u.id),
    accessFrom: 'core',
  }));

  return {
    storeys,
    floors,
    units,
    rooms,
    walls,
    doors,
    windows: [],
    furniture,
    cores,
    stairs,
    elevators: FIXTURE_GEOM.cores.map((r, i) => ({
      id: `ARC-LIFT-${i + 1}`, coreId: `ARC-CORE-${i + 1}`,
      rect: { x: r.x + 2.2, y: r.y + 0.3, w: 2.0, h: 2.2 },
      storeys: above.map(s => s.id), capacityKg: 1000,
    })),
    shafts,
    roof: {
      type: opts.roofType ?? 'flat',
      outline: poly(FIXTURE_GEOM.barOuter), thickness: 0.2,
      pitchRad: opts.roofType === 'gable' ? Math.PI / 6 : 0,
      ridgeAxis: 'x', parapetHeight: opts.roofType === 'gable' ? 0 : 1.1,
      plantZone: opts.roofType === 'gable' ? undefined : { x: 30, y: 6, w: 8, h: 6 },
    },
    templatesUsed: ['2b2b'],
    elements: [],
    patterns: [],
    derived: {
      unitCount: units.length,
      occupants: units.reduce((s, u) => s + u.occupants, 0),
      gfa: FIXTURE_GEOM.barOuter.w * FIXTURE_GEOM.barOuter.h * above.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Structure + mechanical stubs (only the fields plumbing reads)
// ---------------------------------------------------------------------------

function makeStruct(arch: ArchModel, above: StoreyDef[]): StructModel {
  const top = above[above.length - 1];
  const ceiling = Math.min(top.index === 0 ? 3.2 : 2.65, top.height - 0.45);
  return {
    system: 'wood-over-podium',
    foundation: 'pad-footing',
    grid: [],
    columns: [],
    beams: [],
    walls: [],
    slabs: above.map(s => ({
      id: `STR-${s.id}-SLAB-1`, storey: s.id, outline: arch.roof.outline,
      thickness: 0.2, type: 'floor' as const, openings: [],
    })),
    foundations: [],
    sizes: { columnW: 0.3, columnD: 0.3, beamW: 0.2, beamD: 0.3, slabT: 0.2, shearWallT: 0.2 },
    loads: { deadKpa: 2.5, liveKpa: 1.9, roofLiveKpa: 1.0 },
    plenumClearance: { corridorSoffitZ: ceiling + 0.35 },
    elements: [],
    patterns: [],
    derived: {},
  };
}

function makeMech(arch: ArchModel, above: StoreyDef[]): MechModel {
  const g = FIXTURE_GEOM;
  return {
    system: 'ducted-heat-pump',
    ventilation: 'erv-per-unit',
    equipment: [],
    ducts: [{
      id: 'MEC-L01-DUCT-1', storey: above[0].id, systemType: 'exhaust',
      path: [
        [g.unitX0 - 4.7, g.corridorCenterY, 2.8],
        [g.rightX - 0.15, g.corridorCenterY, 2.8],
      ],
      shape: 'rect', width: 0.4, height: 0.3, servesRoomIds: [],
    }],
    terminals: [],
    risers: g.shafts.map((r, i) => ({
      id: `MEC-RISER-${i + 1}`, shaftId: `ARC-SHAFT-${i + 1}`, systemType: 'exhaust' as const,
      fromStorey: above[0].id, toStorey: 'ROOF',
      xy: [r.x + r.w / 2, r.y + r.h / 2] as Vec2,
      width: 0.4, height: 0.4, shape: 'rect' as const,
    })),
    plantRoomIds: [],
    loads: {
      coolingWPerM2: 60, heatingWPerM2: 45, ventilationLsPerPerson: 8,
      totalCoolingKw: 240, totalHeatingKw: 180,
    },
    elements: [],
    patterns: [],
    derived: {},
  };
}
