/**
 * Hand-built ArchModel / SiteModel / GenContext fixtures for the structure tests.
 *
 * These exist so the structural discipline can be developed and tested while
 * `src/disciplines/architecture/index.ts` is still being written. They are deliberately
 * coherent rather than minimal: real party-wall rhythms, real corridor wall positions, real
 * core / stair / lift / shaft rects, windows and doors wide enough to need headers.
 *
 *   'midrise-bar'    5 storeys, 60 x 20 m double-loaded bar, podium parking at L01, 2 cores,
 *                    2 shafts, party walls every 7.5 m, corridor walls at depth 9.15 / 10.85,
 *                    flat roof            → wood-over-podium, pad footings
 *   'townhouse-row'  3 storeys, 36 x 11 m terrace, party walls every 6 m, gable roof
 *                                         → light wood frame, strip footings
 *   'point-tower'    20 storeys, 28 x 28 m point plate, 9 x 7 core, 3-storey 40 x 40 parking
 *                    podium, flat roof    → RC flat plate + core, piles
 */
import type {
  ArchModel, BalconyDef, BuildingSpec, CoreDef, CorridorDef, DoorDef, ElevatorDef, FloorPlan,
  GenContext, MassingBar, MassingModel, Polygon, Rect, RoofDef, RoomDef, RoomType, ShaftDef,
  Side, SiteModel, StairDef, StoreyDef, TypologyDef, UnitInstance, UnitTemplateId, Vec2, WallDef,
  WallType, WindowDef,
} from '../../core/types.ts';
import { polygonArea, rectToPolygon } from '../../core/geometry.ts';
import { createRng } from '../../core/rng.ts';
import { buildStoreys, normalizeSpec } from '../../core/spec.ts';
import { getTypology } from '../../core/typologies.ts';

export type FixtureId = 'midrise-bar' | 'townhouse-row' | 'point-tower';

export interface Fixture {
  id: FixtureId;
  label: string;
  spec: BuildingSpec;
  typology: TypologyDef;
  storeys: StoreyDef[];
  site: SiteModel;
  arch: ArchModel;
  ctx: GenContext;
  /** Outer footprint rect of the building on its widest storey */
  buildingRect: Rect;
}

// ----------------------------------------------------------------------------
// Small builders
// ----------------------------------------------------------------------------

class Builder {
  walls: WallDef[] = [];
  doors: DoorDef[] = [];
  windows: WindowDef[] = [];
  rooms: RoomDef[] = [];
  units: UnitInstance[] = [];
  private n = 0;

  private id(kind: string, storey: string): string {
    this.n += 1;
    return `ARC-${storey}-${kind}-${String(this.n).padStart(3, '0')}`;
  }

  wall(storey: string, a: Vec2, b: Vec2, type: WallType, thickness: number, height: number, extra: Partial<WallDef> = {}): WallDef {
    const w: WallDef = {
      id: this.id('WALL', storey),
      storey,
      start: a,
      end: b,
      thickness,
      height,
      type,
      isExternal: type === 'exterior' || type === 'parapet' || type === 'retaining',
      loadBearingHint: type === 'exterior' || type === 'party' || type === 'core' || type === 'corridor',
      ...extra,
    };
    this.walls.push(w);
    return w;
  }

  door(storey: string, wallId: string, along: number, width: number, height: number, type: DoorDef['type'], unitId?: string): DoorDef {
    const d: DoorDef = { id: this.id('DOOR', storey), storey, wallId, along, width, height, type, operation: 'SINGLE_SWING_LEFT', unitId };
    this.doors.push(d);
    return d;
  }

  window(storey: string, wallId: string, along: number, width: number, roomId: string, unitId?: string): void {
    this.windows.push({ id: this.id('WIN', storey), storey, wallId, along, sill: 0.9, width, height: 1.4, roomId, unitId });
  }

  room(storey: string, rect: Rect, type: RoomType, name: string, height: number, unitId?: string): RoomDef {
    const r: RoomDef = {
      id: this.id('ROOM', storey),
      storey,
      unitId,
      type,
      name,
      polygon: rectToPolygon(rect),
      rect,
      area: rect.w * rect.h,
      height,
      isWet: type === 'bathroom' || type === 'kitchen' || type === 'ensuite',
      hasExterior: true,
      exteriorWallIds: [],
      wallIds: [],
      doorIds: [],
      windowIds: [],
      furnitureIds: [],
      occupancy: 2,
      zone: type === 'corridor' || type === 'stair' || type === 'lobby' || type === 'lift-lobby' ? 'circulation' : type === 'shaft' || type === 'elevator' ? 'service' : 'private',
    };
    this.rooms.push(r);
    return r;
  }

  unit(id: string, templateId: UnitTemplateId, storeys: string[], rect: Rect, accessSide: Side, entryDoorId: string, roomIds: string[]): UnitInstance {
    const u: UnitInstance = {
      id,
      templateId,
      storeys,
      rect,
      polygon: rectToPolygon(rect),
      area: rect.w * rect.h * storeys.length,
      bedrooms: 2,
      bathrooms: 1,
      occupants: 3,
      aspect: 'single',
      accessSide,
      entryDoorId,
      roomIds,
      wetWallIds: [],
      bathroomRoomIds: [],
    };
    this.units.push(u);
    return u;
  }
}

function emptySite(spec: BuildingSpec, massing: MassingModel): SiteModel {
  const boundary = rectToPolygon({ x: 0, y: 0, w: spec.site.width, h: spec.site.depth });
  return {
    boundary,
    area: spec.site.width * spec.site.depth,
    buildableEnvelope: boundary,
    setbacks: { front: 3, side: 3, rear: 3 },
    streetFacing: spec.site.streetFacing,
    northRad: 0,
    massing,
    parking: null,
    landscape: [],
    paths: [],
    driveway: null,
    entrances: [],
    elements: [],
    patterns: [],
    derived: {},
  };
}

function bar(id: string, rect: Rect, axis: 'x' | 'y'): MassingBar {
  return {
    id,
    rect,
    axis,
    depth: axis === 'x' ? rect.h : rect.w,
    length: axis === 'x' ? rect.w : rect.h,
    exteriorSides: ['front', 'rear', 'left', 'right'],
  };
}

function plan(
  s: StoreyDef,
  outline: Polygon,
  slabThickness: number,
  wallIds: string[],
  unitIds: string[],
  roomIds: string[],
  corridors: CorridorDef[],
  balconies: BalconyDef[] = [],
): FloorPlan {
  return {
    storey: s.id,
    use: s.use === 'site' || s.use === 'foundation' ? 'residential' : s.use,
    outline,
    area: polygonArea(outline),
    floorToFloor: s.height,
    ceilingHeight: Math.min(s.height - 0.45, 2.7),
    slabThickness,
    corridors,
    unitIds,
    roomIds,
    commonRoomIds: [],
    wallIds,
    exteriorWallIds: [],
    balconies,
    wwr: 0.35,
  };
}

function makeCtx(spec: BuildingSpec, typology: TypologyDef, storeys: StoreyDef[], site: SiteModel, arch: ArchModel): GenContext {
  return {
    spec,
    typology,
    rng: createRng(spec.seed).fork('structure'),
    storeys,
    site,
    arch,
    struct: null,
    mech: null,
    plumb: null,
    elec: null,
    warnings: [],
  };
}

// ----------------------------------------------------------------------------
// (a) 5-storey double-loaded bar over a parking podium
// ----------------------------------------------------------------------------

function midriseBar(): Fixture {
  const spec = normalizeSpec({
    name: 'Fixture — 5-over-1 bar',
    seed: 7,
    region: 'US',
    typology: 'corridor-midrise',
    site: { width: 78, depth: 42, streetFacing: 'S', context: 'urban' },
    massing: {
      storeys: 5, podiumStoreys: 1, podiumUse: 'parking', footprintShape: 'bar',
      roof: 'flat', buildingDepth: 20, buildingLength: 60, corridorWidth: 1.7, coreCount: 2,
    },
    options: { detail: 'medium' },
  });
  const typology = getTypology(spec.typology);
  const storeys = buildStoreys(spec, spec.floors);
  const above = storeys.filter(s => s.index >= 0 && s.index < 100);
  const roofStorey = storeys.find(s => s.id === 'ROOF')!;

  const rect: Rect = { x: 9, y: 3, w: 60, h: 20 };
  const outline = rectToPolygon(rect);
  const extT = 0.3, partyT = 0.25, corrT = 0.2, coreT = 0.25;
  const xL = rect.x + extT / 2, xR = rect.x + rect.w - extT / 2;
  const yF = rect.y + extT / 2, yR = rect.y + rect.h - extT / 2;
  const corrFront = rect.y + 9.15;   // front corridor wall centreline
  const corrRear = rect.y + 10.85;   // rear corridor wall centreline
  const partyX = [1, 2, 3, 4, 5, 6, 7].map(k => rect.x + 7.5 * k);
  const bayEdges = [rect.x, ...partyX, rect.x + rect.w];

  const coreRects: Rect[] = [
    { x: partyX[1], y: corrRear, w: 5.2, h: 6.0 },   // in the rear bay 24.0 → 31.5
    { x: partyX[4], y: corrRear, w: 5.2, h: 6.0 },   // in the rear bay 46.5 → 54.0
  ];
  const shaftRects: Rect[] = [
    { x: coreRects[0].x + coreRects[0].w + 0.2, y: corrRear + 0.1, w: 1.0, h: 1.2 },
    { x: coreRects[1].x - 1.2, y: corrRear + 0.1, w: 1.0, h: 1.2 },
  ];

  const b = new Builder();
  const cores: CoreDef[] = [];
  const stairs: StairDef[] = [];
  const elevators: ElevatorDef[] = [];
  const shafts: ShaftDef[] = [];
  const floors: FloorPlan[] = [];
  const storeyIdsAll = above.map(s => s.id);

  coreRects.forEach((cr, i) => {
    const stairRect: Rect = { x: cr.x + 0.2, y: cr.y + 0.2, w: 2.6, h: 5.6 };
    const liftRect: Rect = { x: cr.x + 3.0, y: cr.y + 0.2, w: 2.0, h: 2.2 };
    const stairIds: string[] = [];
    for (const s of above) {
      const st: StairDef = {
        id: `ARC-${s.id}-STAIR-${i + 1}`,
        coreId: `ARC-CORE-${i + 1}`,
        storey: s.id,
        position: [stairRect.x + 1.3, stairRect.y],
        direction: Math.PI / 2,
        risers: 18,
        riserHeight: s.height / 18,
        tread: 0.28,
        width: 1.1,
        flights: 2,
        landingRect: stairRect,
        isExit: true,
      };
      stairs.push(st);
      stairIds.push(st.id);
    }
    const lift: ElevatorDef = { id: `ARC-LIFT-${i + 1}`, coreId: `ARC-CORE-${i + 1}`, rect: liftRect, storeys: storeyIdsAll, capacityKg: 1000 };
    elevators.push(lift);
    cores.push({
      id: `ARC-CORE-${i + 1}`,
      rect: cr,
      storeys: storeyIdsAll,
      type: 'stair-elevator',
      stairIds,
      elevatorIds: [lift.id],
      roomIds: [],
      isExit: true,
    });
  });
  shaftRects.forEach((sr, i) => {
    shafts.push({
      id: `ARC-SHAFT-${i + 1}`,
      rect: sr,
      storeys: storeyIdsAll,
      purpose: i === 0 ? 'combined' : 'plumbing',
      servesUnitIds: [],
      accessFrom: 'corridor',
    });
  });

  for (const s of above) {
    const h = s.height;
    const wallIds: string[] = [];
    const unitIds: string[] = [];
    const roomIds: string[] = [];
    // exterior envelope
    const extFront = b.wall(s.id, [xL, yF], [xR, yF], 'exterior', extT, h, { exposure: 'S' });
    const extRear = b.wall(s.id, [xR, yR], [xL, yR], 'exterior', extT, h, { exposure: 'N' });
    wallIds.push(
      extFront.id,
      extRear.id,
      b.wall(s.id, [xL, yR], [xL, yF], 'exterior', extT, h, { exposure: 'W' }).id,
      b.wall(s.id, [xR, yF], [xR, yR], 'exterior', extT, h, { exposure: 'E' }).id,
    );
    // core walls
    for (const cr of coreRects) {
      wallIds.push(
        b.wall(s.id, [cr.x, cr.y], [cr.x + cr.w, cr.y], 'core', coreT, h).id,
        b.wall(s.id, [cr.x + cr.w, cr.y], [cr.x + cr.w, cr.y + cr.h], 'core', coreT, h).id,
        b.wall(s.id, [cr.x + cr.w, cr.y + cr.h], [cr.x, cr.y + cr.h], 'core', coreT, h).id,
        b.wall(s.id, [cr.x, cr.y + cr.h], [cr.x, cr.y], 'core', coreT, h).id,
      );
    }

    if (s.use === 'parking') {
      const r = b.room(s.id, { x: rect.x + 0.3, y: rect.y + 0.3, w: rect.w - 0.6, h: rect.h - 0.6 }, 'parking', 'Podium parking', h - 0.5);
      roomIds.push(r.id);
      floors.push(plan(s, outline, 0.3, wallIds, unitIds, roomIds, []));
      continue;
    }

    // corridor walls + corridor room
    const corrWallFront = b.wall(s.id, [xL, corrFront], [xR, corrFront], 'corridor', corrT, h);
    const corrWallRear = b.wall(s.id, [xL, corrRear], [xR, corrRear], 'corridor', corrT, h);
    wallIds.push(corrWallFront.id, corrWallRear.id);
    const corridorRoom = b.room(s.id, { x: xL, y: corrFront + corrT / 2, w: xR - xL, h: corrRear - corrFront - corrT }, 'corridor', 'Corridor', h - 0.45);
    roomIds.push(corridorRoom.id);
    const corridors: CorridorDef[] = [{
      id: `ARC-${s.id}-CORR-1`,
      storey: s.id,
      polygon: rectToPolygon(corridorRoom.rect),
      centerline: [{ a: [xL, (corrFront + corrRear) / 2], b: [xR, (corrFront + corrRear) / 2] }],
      width: corrRear - corrFront - corrT,
      roomId: corridorRoom.id,
    }];

    // party walls, both sides of the corridor
    for (const px of partyX) {
      wallIds.push(
        b.wall(s.id, [px, yF], [px, corrFront], 'party', partyT, h).id,
        b.wall(s.id, [px, corrRear], [px, yR], 'party', partyT, h).id,
      );
    }

    // units: 8 on the street side, 6 on the rear (two rear bays hold the cores)
    let unitN = 0;
    for (let i = 0; i < bayEdges.length - 1; i++) {
      const x0 = bayEdges[i] + (i === 0 ? extT / 2 : partyT / 2);
      const x1 = bayEdges[i + 1] - (i === bayEdges.length - 2 ? extT / 2 : partyT / 2);
      for (const side of ['front', 'rear'] as const) {
        const y0 = side === 'front' ? yF + extT / 2 : corrRear + corrT / 2;
        const y1 = side === 'front' ? corrFront - corrT / 2 : yR - extT / 2;
        const uRect: Rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
        if (side === 'rear' && coreRects.some(c => c.x < uRect.x + uRect.w && uRect.x < c.x + c.w)) continue;
        unitN += 1;
        const uid = `U-${s.id}-${String(unitN).padStart(2, '0')}`;
        const living = b.room(s.id, { x: uRect.x, y: uRect.y, w: uRect.w, h: uRect.h * 0.62 }, 'living-kitchen', 'Living / kitchen', h - 0.45, uid);
        const bed = b.room(s.id, { x: uRect.x, y: uRect.y + uRect.h * 0.62, w: uRect.w, h: uRect.h * 0.38 }, 'bedroom', 'Bedroom', h - 0.45, uid);
        roomIds.push(living.id, bed.id);
        const hostWall = side === 'front' ? corrWallFront : corrWallRear;
        const entry = b.door(s.id, hostWall.id, uRect.x + uRect.w / 2 - xL, 0.9, 2.1, 'unit-entry', uid);
        // a 2.4 m window in the exterior wall — wide enough to need a header (STR-08)
        const extWall = side === 'front' ? extFront : extRear;
        const along = side === 'front' ? uRect.x + uRect.w / 2 - xL : xR - (uRect.x + uRect.w / 2);
        b.window(s.id, extWall.id, along, 2.4, living.id, uid);
        // a 1.8 m balcony door as well, so the header rule fires on doors too
        b.door(s.id, extWall.id, along + 0.1, 1.8, 2.1, 'balcony', uid);
        b.unit(uid, side === 'front' ? '1b1b' : '2b2b', [s.id], uRect, side === 'front' ? 'rear' : 'front', entry.id, [living.id, bed.id]);
        unitIds.push(uid);
      }
    }
    // core + shaft rooms
    for (const c of cores) {
      const sr = b.room(s.id, { x: c.rect.x + 0.2, y: c.rect.y + 0.2, w: 2.6, h: 5.6 }, 'stair', 'Stair', h);
      const lr = b.room(s.id, { x: c.rect.x + 3.0, y: c.rect.y + 0.2, w: 2.0, h: 2.2 }, 'elevator', 'Lift', h);
      c.roomIds.push(sr.id, lr.id);
      roomIds.push(sr.id, lr.id);
    }
    for (const sh of shafts) {
      roomIds.push(b.room(s.id, sh.rect, 'shaft', 'Riser', h).id);
    }
    floors.push(plan(s, outline, 0.2, wallIds, unitIds, roomIds, corridors));
  }

  const roof: RoofDef = { type: 'flat', outline, thickness: 0.2, pitchRad: 0, ridgeAxis: 'x', parapetHeight: 1.1 };
  const massing: MassingModel = {
    shape: 'bar',
    footprint: outline,
    footprintArea: polygonArea(outline),
    bars: [bar('BAR-1', rect, 'x')],
    storeys,
    heightAboveGrade: roofStorey.elevation,
    gfa: polygonArea(outline) * above.length,
    podium: { storeys: 1, footprint: outline, use: 'parking' },
    cores: coreRects.map((r, i) => ({ id: `SIT-CORE-${i + 1}`, rect: r, barId: 'BAR-1', type: 'stair-elevator' as const, hasElevator: true, elevatorCount: 1 })),
    corridors: [{ id: 'SIT-CORR-1', barId: 'BAR-1', centerline: { a: [xL, (corrFront + corrRear) / 2], b: [xR, (corrFront + corrRear) / 2] }, width: 1.7, loaded: 'both' }],
    roof: { type: 'flat', pitchRad: 0, parapetHeight: 1.1, ridgeAxis: 'x' },
  };
  const site = emptySite(spec, massing);
  const arch: ArchModel = {
    storeys, floors, units: b.units, rooms: b.rooms, walls: b.walls, doors: b.doors, windows: b.windows,
    furniture: [], cores, stairs, elevators, shafts, roof,
    templatesUsed: ['1b1b', '2b2b'], elements: [], patterns: [], derived: {},
  };
  return { id: 'midrise-bar', label: '5-over-1 double-loaded bar', spec, typology, storeys, site, arch, ctx: makeCtx(spec, typology, storeys, site, arch), buildingRect: rect };
}

// ----------------------------------------------------------------------------
// (b) 3-storey terrace with a gable roof
// ----------------------------------------------------------------------------

function townhouseRow(): Fixture {
  const spec = normalizeSpec({
    name: 'Fixture — terrace',
    seed: 3,
    region: 'UK',
    displayUnits: 'metric',
    typology: 'townhouse-row',
    site: { width: 42, depth: 34, streetFacing: 'N', context: 'urban' },
    massing: { storeys: 3, roof: 'gable', roofPitchDeg: 35, buildingDepth: 11, buildingLength: 36, footprintShape: 'bar' },
    options: { detail: 'medium' },
  });
  const typology = getTypology(spec.typology);
  const storeys = buildStoreys(spec, spec.floors);
  const above = storeys.filter(s => s.index >= 0 && s.index < 100);

  const rect: Rect = { x: 3, y: 3, w: 36, h: 11 };
  const outline = rectToPolygon(rect);
  const extT = 0.3, partyT = 0.25;
  const xL = rect.x + extT / 2, xR = rect.x + rect.w - extT / 2;
  const yF = rect.y + extT / 2, yR = rect.y + rect.h - extT / 2;
  const partyX = [1, 2, 3, 4, 5].map(k => rect.x + 6 * k);
  const bayEdges = [rect.x, ...partyX, rect.x + rect.w];

  const b = new Builder();
  const floors: FloorPlan[] = [];
  const storeyIds = above.map(s => s.id);

  for (const s of above) {
    const h = s.height;
    const wallIds: string[] = [];
    const roomIds: string[] = [];
    const unitIds: string[] = [];
    const front = b.wall(s.id, [xL, yF], [xR, yF], 'exterior', extT, h, { exposure: 'N' });
    const rear = b.wall(s.id, [xR, yR], [xL, yR], 'exterior', extT, h, { exposure: 'S' });
    wallIds.push(
      front.id, rear.id,
      b.wall(s.id, [xL, yR], [xL, yF], 'exterior', extT, h, { exposure: 'W' }).id,
      b.wall(s.id, [xR, yF], [xR, yR], 'exterior', extT, h, { exposure: 'E' }).id,
    );
    for (const px of partyX) wallIds.push(b.wall(s.id, [px, yF], [px, yR], 'party', partyT, h, { fireRating: 'REI60' }).id);

    for (let i = 0; i < bayEdges.length - 1; i++) {
      const x0 = bayEdges[i] + (i === 0 ? extT / 2 : partyT / 2);
      const x1 = bayEdges[i + 1] - (i === bayEdges.length - 2 ? extT / 2 : partyT / 2);
      const uRect: Rect = { x: x0, y: yF + extT / 2, w: x1 - x0, h: yR - yF - extT };
      const uid = `U-L01-${String(i + 1).padStart(2, '0')}`;
      const isGround = s.index === 0;
      const front1 = b.room(s.id, { x: uRect.x, y: uRect.y, w: uRect.w, h: uRect.h * 0.45 }, isGround ? 'living' : 'bedroom', isGround ? 'Living room' : 'Bedroom', h - 0.4, uid);
      const back1 = b.room(s.id, { x: uRect.x, y: uRect.y + uRect.h * 0.45, w: uRect.w, h: uRect.h * 0.55 }, isGround ? 'kitchen' : 'bedroom', isGround ? 'Kitchen / dining' : 'Bedroom', h - 0.4, uid);
      roomIds.push(front1.id, back1.id);
      // 1.5 m window to the street on every storey → needs a header
      b.window(s.id, front.id, uRect.x + uRect.w / 2 - xL, 1.5, front1.id, uid);
      if (isGround) {
        const entry = b.door(s.id, front.id, uRect.x + 0.9 - xL, 0.9, 2.1, 'unit-entry', uid);
        // 1.8 m patio door at the rear → needs a header
        b.door(s.id, rear.id, xR - (uRect.x + uRect.w / 2), 1.8, 2.1, 'balcony', uid);
        b.unit(uid, 'townhouse-3s', storeyIds, uRect, 'front', entry.id, [front1.id, back1.id]);
        unitIds.push(uid);
      }
    }
    floors.push(plan(s, outline, 0.2, wallIds, unitIds, roomIds, []));
  }

  const roof: RoofDef = { type: 'gable', outline, thickness: 0.25, pitchRad: (35 * Math.PI) / 180, ridgeAxis: 'x', parapetHeight: 0 };
  const massing: MassingModel = {
    shape: 'bar',
    footprint: outline,
    footprintArea: polygonArea(outline),
    bars: [bar('BAR-1', rect, 'x')],
    storeys,
    heightAboveGrade: storeys.find(s => s.id === 'ROOF')!.elevation,
    gfa: polygonArea(outline) * above.length,
    cores: [],
    corridors: [],
    roof: { type: 'gable', pitchRad: (35 * Math.PI) / 180, parapetHeight: 0, ridgeAxis: 'x' },
  };
  const site = emptySite(spec, massing);
  const arch: ArchModel = {
    storeys, floors, units: b.units, rooms: b.rooms, walls: b.walls, doors: b.doors, windows: b.windows,
    furniture: [], cores: [], stairs: [], elevators: [], shafts: [], roof,
    templatesUsed: ['townhouse-3s'], elements: [], patterns: [], derived: {},
  };
  return { id: 'townhouse-row', label: '3-storey terrace', spec, typology, storeys, site, arch, ctx: makeCtx(spec, typology, storeys, site, arch), buildingRect: rect };
}

// ----------------------------------------------------------------------------
// (c) 20-storey point tower over a 3-storey parking podium
// ----------------------------------------------------------------------------

function pointTower(): Fixture {
  const spec = normalizeSpec({
    name: 'Fixture — point tower on podium',
    seed: 11,
    region: 'CA',
    displayUnits: 'metric',
    typology: 'podium-tower',
    site: { width: 48, depth: 46, streetFacing: 'W', context: 'urban' },
    massing: { storeys: 20, podiumStoreys: 3, podiumUse: 'parking', footprintShape: 'point', roof: 'flat', buildingDepth: 28 },
    options: { detail: 'medium' },
  });
  const typology = getTypology(spec.typology);
  const storeys = buildStoreys(spec, spec.floors);
  const above = storeys.filter(s => s.index >= 0 && s.index < 100);

  const podiumRect: Rect = { x: 4, y: 3, w: 40, h: 40 };
  const towerRect: Rect = { x: 10, y: 9, w: 28, h: 28 };
  const podiumOutline = rectToPolygon(podiumRect);
  const towerOutline = rectToPolygon(towerRect);
  const extT = 0.3, partyT = 0.25, coreT = 0.3;
  const tx0 = towerRect.x + extT / 2, tx1 = towerRect.x + towerRect.w - extT / 2;
  const ty0 = towerRect.y + extT / 2, ty1 = towerRect.y + towerRect.h - extT / 2;
  const px0 = podiumRect.x + extT / 2, px1 = podiumRect.x + podiumRect.w - extT / 2;
  const py0 = podiumRect.y + extT / 2, py1 = podiumRect.y + podiumRect.h - extT / 2;
  const coreRect: Rect = { x: 19.5, y: 19.5, w: 9, h: 7 };
  const cx0 = coreRect.x, cx1 = coreRect.x + coreRect.w, cy0 = coreRect.y, cy1 = coreRect.y + coreRect.h;

  const storeyIdsAll = above.map(s => s.id);
  const stairRects: Rect[] = [
    { x: cx0 + 0.2, y: cy0 + 0.2, w: 2.6, h: 5.6 },
    { x: cx1 - 2.8, y: cy0 + 0.2, w: 2.6, h: 5.6 },
  ];
  const liftRects: Rect[] = [
    { x: 22.5, y: cy0 + 0.2, w: 2.0, h: 2.2 },
    { x: 22.5, y: cy0 + 2.6, w: 2.0, h: 2.2 },
  ];
  const shaftRects: Rect[] = [
    { x: cx0 + 0.3, y: cy1 + 0.2, w: 1.2, h: 1.2 },
    { x: cx1 - 1.5, y: cy1 + 0.2, w: 1.2, h: 1.2 },
  ];

  const b = new Builder();
  const stairs: StairDef[] = [];
  const elevators: ElevatorDef[] = liftRects.map((r, i) => ({ id: `ARC-LIFT-${i + 1}`, coreId: 'ARC-CORE-1', rect: r, storeys: storeyIdsAll, capacityKg: 1150 }));
  const shafts: ShaftDef[] = shaftRects.map((r, i) => ({
    id: `ARC-SHAFT-${i + 1}`, rect: r, storeys: storeyIdsAll,
    purpose: i === 0 ? ('combined' as const) : ('plumbing' as const), servesUnitIds: [], accessFrom: 'core' as const,
  }));
  const stairIds: string[] = [];
  for (const s of above) {
    stairRects.forEach((sr, i) => {
      const st: StairDef = {
        id: `ARC-${s.id}-STAIR-${i + 1}`,
        coreId: 'ARC-CORE-1',
        storey: s.id,
        position: [sr.x + 1.3, sr.y],
        direction: Math.PI / 2,
        risers: 18,
        riserHeight: s.height / 18,
        tread: 0.28,
        width: 1.1,
        flights: 2,
        landingRect: sr,
        isExit: true,
      };
      stairs.push(st);
      stairIds.push(st.id);
    });
  }
  const cores: CoreDef[] = [{
    id: 'ARC-CORE-1', rect: coreRect, storeys: storeyIdsAll, type: 'point-core',
    stairIds, elevatorIds: elevators.map(e => e.id), roomIds: [], isExit: true,
  }];

  // 8 units per residential floor in a pinwheel around the core
  const unitRects: Rect[] = [
    { x: tx0 + 0.15, y: ty0 + 0.15, w: cx0 - 0.125 - tx0 - 0.15, h: cy0 - 0.125 - ty0 - 0.15 },
    { x: cx0 + 0.125, y: ty0 + 0.15, w: cx1 - cx0 - 0.25, h: cy0 - 0.125 - ty0 - 0.15 },
    { x: cx1 + 0.125, y: ty0 + 0.15, w: tx1 - 0.15 - cx1 - 0.125, h: cy0 - 0.125 - ty0 - 0.15 },
    { x: tx0 + 0.15, y: cy0 + 0.125, w: cx0 - 0.125 - tx0 - 0.15, h: cy1 - cy0 - 0.25 },
    { x: cx1 + 0.125, y: cy0 + 0.125, w: tx1 - 0.15 - cx1 - 0.125, h: cy1 - cy0 - 0.25 },
    { x: tx0 + 0.15, y: cy1 + 0.125, w: cx0 - 0.125 - tx0 - 0.15, h: ty1 - 0.15 - cy1 - 0.125 },
    { x: cx0 + 0.125, y: cy1 + 0.125, w: cx1 - cx0 - 0.25, h: ty1 - 0.15 - cy1 - 0.125 },
    { x: cx1 + 0.125, y: cy1 + 0.125, w: tx1 - 0.15 - cx1 - 0.125, h: ty1 - 0.15 - cy1 - 0.125 },
  ];

  const floors: FloorPlan[] = [];
  for (const s of above) {
    const h = s.height;
    const podium = s.index < 3;
    const wallIds: string[] = [];
    const roomIds: string[] = [];
    const unitIds: string[] = [];
    // envelope
    if (podium) {
      wallIds.push(
        b.wall(s.id, [px0, py0], [px1, py0], 'exterior', extT, h, { exposure: 'W' }).id,
        b.wall(s.id, [px1, py1], [px0, py1], 'exterior', extT, h, { exposure: 'E' }).id,
        b.wall(s.id, [px0, py1], [px0, py0], 'exterior', extT, h, { exposure: 'S' }).id,
        b.wall(s.id, [px1, py0], [px1, py1], 'exterior', extT, h, { exposure: 'N' }).id,
      );
    } else {
      wallIds.push(
        b.wall(s.id, [tx0, ty0], [tx1, ty0], 'exterior', extT, h, { exposure: 'W' }).id,
        b.wall(s.id, [tx1, ty1], [tx0, ty1], 'exterior', extT, h, { exposure: 'E' }).id,
        b.wall(s.id, [tx0, ty1], [tx0, ty0], 'exterior', extT, h, { exposure: 'S' }).id,
        b.wall(s.id, [tx1, ty0], [tx1, ty1], 'exterior', extT, h, { exposure: 'N' }).id,
      );
    }
    // core box, every storey
    wallIds.push(
      b.wall(s.id, [cx0, cy0], [cx1, cy0], 'core', coreT, h).id,
      b.wall(s.id, [cx1, cy0], [cx1, cy1], 'core', coreT, h).id,
      b.wall(s.id, [cx1, cy1], [cx0, cy1], 'core', coreT, h).id,
      b.wall(s.id, [cx0, cy1], [cx0, cy0], 'core', coreT, h).id,
    );

    if (podium) {
      roomIds.push(b.room(s.id, { x: podiumRect.x + 0.3, y: podiumRect.y + 0.3, w: podiumRect.w - 0.6, h: podiumRect.h - 0.6 }, 'parking', 'Parking', h - 0.5).id);
      for (const sr of stairRects) roomIds.push(b.room(s.id, sr, 'stair', 'Stair', h).id);
      for (const lr of liftRects) roomIds.push(b.room(s.id, lr, 'elevator', 'Lift', h).id);
      floors.push(plan(s, podiumOutline, s.index === 0 ? 0.3 : 0.25, wallIds, unitIds, roomIds, []));
      continue;
    }

    // radial party walls (pinwheel), aligned with the core faces
    wallIds.push(
      b.wall(s.id, [cx0, ty0], [cx0, cy0], 'party', partyT, h).id,
      b.wall(s.id, [cx1, ty0], [cx1, cy0], 'party', partyT, h).id,
      b.wall(s.id, [cx0, cy1], [cx0, ty1], 'party', partyT, h).id,
      b.wall(s.id, [cx1, cy1], [cx1, ty1], 'party', partyT, h).id,
      b.wall(s.id, [tx0, cy0], [cx0, cy0], 'party', partyT, h).id,
      b.wall(s.id, [cx1, cy0], [tx1, cy0], 'party', partyT, h).id,
      b.wall(s.id, [tx0, cy1], [cx0, cy1], 'party', partyT, h).id,
      b.wall(s.id, [cx1, cy1], [tx1, cy1], 'party', partyT, h).id,
    );
    const extWalls = b.walls.filter(w => w.storey === s.id && w.type === 'exterior');
    unitRects.forEach((ur, i) => {
      const uid = `U-${s.id}-${String(i + 1).padStart(2, '0')}`;
      const living = b.room(s.id, { x: ur.x, y: ur.y, w: ur.w, h: ur.h * 0.6 }, 'living-kitchen', 'Living / kitchen', h - 0.4, uid);
      const bed = b.room(s.id, { x: ur.x, y: ur.y + ur.h * 0.6, w: ur.w, h: ur.h * 0.4 }, 'bedroom', 'Bedroom', h - 0.4, uid);
      roomIds.push(living.id, bed.id);
      const host = extWalls[i % extWalls.length];
      const entry = b.door(s.id, host.id, 2 + i * 1.5, 0.95, 2.1, 'unit-entry', uid);
      b.window(s.id, host.id, 3 + i * 2.2, 2.6, living.id, uid);
      b.unit(uid, i % 2 === 0 ? 'corner-2b2b' : '1b1b', [s.id], ur, 'front', entry.id, [living.id, bed.id]);
      unitIds.push(uid);
    });
    for (const sr of stairRects) roomIds.push(b.room(s.id, sr, 'stair', 'Stair', h).id);
    for (const lr of liftRects) roomIds.push(b.room(s.id, lr, 'elevator', 'Lift', h).id);
    for (const sh of shaftRects) roomIds.push(b.room(s.id, sh, 'shaft', 'Riser', h).id);
    floors.push(plan(s, towerOutline, 0.25, wallIds, unitIds, roomIds, []));
  }

  const roof: RoofDef = { type: 'flat', outline: towerOutline, thickness: 0.25, pitchRad: 0, ridgeAxis: 'x', parapetHeight: 1.1 };
  const massing: MassingModel = {
    shape: 'point',
    footprint: podiumOutline,
    footprintArea: polygonArea(podiumOutline),
    bars: [bar('BAR-1', towerRect, 'x')],
    storeys,
    heightAboveGrade: storeys.find(s => s.id === 'ROOF')!.elevation,
    gfa: polygonArea(podiumOutline) * 3 + polygonArea(towerOutline) * (above.length - 3),
    podium: { storeys: 3, footprint: podiumOutline, use: 'parking' },
    towerFootprint: towerOutline,
    cores: [{ id: 'SIT-CORE-1', rect: coreRect, barId: 'BAR-1', type: 'point-core', hasElevator: true, elevatorCount: 2 }],
    corridors: [],
    roof: { type: 'flat', pitchRad: 0, parapetHeight: 1.1, ridgeAxis: 'x' },
  };
  const site = emptySite(spec, massing);
  const arch: ArchModel = {
    storeys, floors, units: b.units, rooms: b.rooms, walls: b.walls, doors: b.doors, windows: b.windows,
    furniture: [], cores, stairs, elevators, shafts, roof,
    templatesUsed: ['1b1b', 'corner-2b2b'], elements: [], patterns: [], derived: {},
  };
  return {
    id: 'point-tower', label: '20-storey point tower on a parking podium',
    spec, typology, storeys, site, arch, ctx: makeCtx(spec, typology, storeys, site, arch), buildingRect: podiumRect,
  };
}

// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------

const BUILDERS: Record<FixtureId, () => Fixture> = {
  'midrise-bar': midriseBar,
  'townhouse-row': townhouseRow,
  'point-tower': pointTower,
};

export function makeArchFixture(id: FixtureId = 'midrise-bar'): Fixture {
  return BUILDERS[id]();
}

export function allFixtures(): Fixture[] {
  return (Object.keys(BUILDERS) as FixtureId[]).map(id => BUILDERS[id]());
}
