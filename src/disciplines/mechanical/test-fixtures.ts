/**
 * Test fixture: a coherent `GenContext` for a 4-storey double-loaded corridor mid-rise with
 * 6 dwellings per floor, so the mechanical discipline can be developed and tested before the
 * real site / architecture / structure modules land.
 *
 * PLAN (world metres, +X along the street, +Y from the street into the site)
 *
 *   site 66 × 35, setbacks front/side 3, rear 6
 *   bar          x 3 … 45,  y 3 … 23      (42 × 20)
 *   core A       x 3 … 9,   y 9.6 … 16.4  (shaft A inside it, x 8 … 9)
 *   core B       x 39 … 45, y 9.6 … 16.4  (shaft B inside it, x 39 … 40)
 *   corridor     x 9 … 39,  y 12.15 … 13.85, centreline y = 13
 *   front units  x 9/19/29 + 10 wide, y 3 … 12.15     accessSide 'rear'   balcony to the street
 *   rear units   x 9/19/29 + 10 wide, y 13.85 … 23    accessSide 'front'  balcony to the rear
 *   roof         flat, plant zone x 18 … 30, y 9 … 17
 *
 * Each dwelling is a single-aspect 2b2b: hall, 2 wet rooms on the corridor side sharing one
 * wet wall, a walk-in closet, a laundry (odd dwellings only, to exercise both the
 * closet-mounted and the hall-ceiling air handler), 2 bedrooms and a living-kitchen with a
 * range and a sink on the window wall.
 */
import type {
  ArchModel, BalconyDef, BuildingSpec, CoreDef, CorePlacement, CorridorDef, CorridorSpine, DoorDef,
  FloorPlan, FurnitureDef, FurnitureType, GenContext, MassingBar, Rect, RoomDef, RoomType, ShaftDef,
  SiteModel, StoreyDef, StructModel, TypologyDef, UnitInstance, WallDef, WindowDef, Zone,
} from '../../core/types.ts';
import { normalizeSpec, buildStoreys } from '../../core/spec.ts';
import { getTypology } from '../../core/typologies.ts';
import { createRng } from '../../core/rng.ts';
import { rectToPolygon, rectArea, rectCenter } from '../../core/geometry.ts';
import { reachRect, solveSwing } from '../../core/openings.ts';
import { roomId as makeRoomId, unitId as makeUnitId, ROOF_STOREY } from '../../core/ids.ts';

export interface FixtureOptions {
  storeys?: number;
  unitsPerSide?: number;
  seed?: number;
  detail?: 'low' | 'medium' | 'high';
  region?: BuildingSpec['region'];
  /** Give the rear-row dwellings a balcony (front row then uses the roof plant zone) */
  balconies?: boolean;
  plantZone?: Rect | null;
  shafts?: boolean;
}

export const BAR: Rect = { x: 3, y: 3, w: 42, h: 20 };
export const CORRIDOR_WIDTH = 1.7;
export const CORRIDOR_Y = 13;
export const CORE_A: Rect = { x: 3, y: 9.6, w: 6, h: 6.8 };
export const CORE_B: Rect = { x: 39, y: 9.6, w: 6, h: 6.8 };
export const SHAFT_A: Rect = { x: 8, y: 11, w: 1, h: 1.2 };
export const SHAFT_B: Rect = { x: 39, y: 11, w: 1, h: 1.2 };
export const PLANT_ZONE: Rect = { x: 18, y: 9, w: 12, h: 8 };
export const UNIT_W = 10;
export const UNIT_D = (BAR.h - CORRIDOR_WIDTH) / 2; // 9.15

/** Local room layout of one dwelling: u along the frontage, v from the access edge inward */
interface LocalRoom {
  type: RoomType;
  name: string;
  u: number;
  v: number;
  w: number;
  d: number;
  wet?: boolean;
  exterior?: boolean;
  zone: Zone;
  occupancy?: number;
  oddOnly?: boolean;
}

const LOCAL_ROOMS: LocalRoom[] = [
  { type: 'hall', name: 'Hall', u: 3.4, v: 0, w: 3.2, d: 4.8, zone: 'circulation' },
  { type: 'bathroom', name: 'Bathroom', u: 6.6, v: 0, w: 2.6, d: 2.6, wet: true, zone: 'service', occupancy: 0 },
  { type: 'ensuite', name: 'Ensuite', u: 6.6, v: 2.6, w: 2.6, d: 2.2, wet: true, zone: 'service', occupancy: 0 },
  { type: 'laundry', name: 'Laundry', u: 0.6, v: 0, w: 1.8, d: 2, wet: true, zone: 'service', oddOnly: true },
  { type: 'walk-in-closet', name: 'Walk-in closet', u: 0.6, v: 2, w: 2.8, d: 2.8, zone: 'private' },
  { type: 'bedroom', name: 'Bedroom 1', u: 0, v: 4.8, w: 3.4, d: UNIT_D - 4.8, exterior: true, zone: 'private', occupancy: 2 },
  { type: 'bedroom', name: 'Bedroom 2', u: 3.4, v: 4.8, w: 3, d: UNIT_D - 4.8, exterior: true, zone: 'private', occupancy: 1 },
  { type: 'living-kitchen', name: 'Living / kitchen', u: 6.4, v: 4.8, w: 3.6, d: UNIT_D - 4.8, exterior: true, zone: 'public', occupancy: 3 },
];

interface LocalFurniture {
  type: FurnitureType;
  room: string;
  u: number;
  v: number;
  w: number;
  d: number;
  water?: boolean;
  power?: boolean;
}

const LOCAL_FURNITURE: LocalFurniture[] = [
  { type: 'range', room: 'Living / kitchen', u: 7.0, v: 5.1, w: 0.76, d: 0.6, power: true },
  { type: 'kitchen-sink', room: 'Living / kitchen', u: 8.2, v: 5.1, w: 0.6, d: 0.5, water: true },
  { type: 'kitchen-counter', room: 'Living / kitchen', u: 6.6, v: 5.1, w: 0.4, d: 0.6 },
  { type: 'sofa-3', room: 'Living / kitchen', u: 6.8, v: 7.6, w: 2.1, d: 0.9 },
  { type: 'wc', room: 'Bathroom', u: 6.8, v: 0.3, w: 0.4, d: 0.7, water: true },
  { type: 'lavatory', room: 'Bathroom', u: 7.4, v: 0.3, w: 0.6, d: 0.45, water: true },
  { type: 'bathtub', room: 'Bathroom', u: 8.2, v: 0.6, w: 0.8, d: 1.7, water: true },
  { type: 'wc', room: 'Ensuite', u: 6.8, v: 2.9, w: 0.4, d: 0.7, water: true },
  { type: 'lavatory', room: 'Ensuite', u: 7.4, v: 2.9, w: 0.6, d: 0.45, water: true },
  { type: 'shower', room: 'Ensuite', u: 8.3, v: 3.5, w: 0.9, d: 0.9, water: true },
  { type: 'washer', room: 'Laundry', u: 0.8, v: 0.3, w: 0.6, d: 0.6, water: true, power: true },
  { type: 'dryer', room: 'Laundry', u: 1.6, v: 0.3, w: 0.6, d: 0.6, power: true },
  { type: 'bed-queen', room: 'Bedroom 1', u: 0.6, v: 5.4, w: 1.5, d: 2, power: false },
  { type: 'bed-single', room: 'Bedroom 2', u: 4.0, v: 5.4, w: 1, d: 2 },
];

/** Map a local (u, v, w, d) box to world coordinates for a unit rect and access side */
export function mapRect(r: Rect, accessSide: 'front' | 'rear', u: number, v: number, w: number, d: number): Rect {
  if (accessSide === 'rear') {
    // Access edge is at max Y; v grows toward min Y
    return { x: r.x + u, y: r.y + r.h - v - d, w, h: d };
  }
  // Access edge is at min Y; v grows toward max Y
  return { x: r.x + u, y: r.y + v, w, h: d };
}

export function makeContextFixture(opts: FixtureOptions = {}): GenContext {
  const storeyCount = opts.storeys ?? 4;
  const unitsPerSide = opts.unitsPerSide ?? 3;
  const balconies = opts.balconies ?? true;
  const spec: BuildingSpec = normalizeSpec({
    name: 'Mechanical fixture block',
    seed: opts.seed ?? 7,
    region: opts.region ?? 'US',
    typology: 'corridor-midrise',
    site: { width: 66, depth: 35, streetFacing: 'S', context: 'urban' },
    // `allowStoreyOverride`: the fixture is deliberately built at 1..20 storeys on a typology
    // whose band is 4..8, so it opts out of the v2 clamp in `normalizeSpec`.
    massing: { storeys: storeyCount, allowStoreyOverride: true, footprintShape: 'bar', roof: 'flat', buildingDepth: BAR.h, buildingLength: BAR.w, corridorWidth: CORRIDOR_WIDTH },
    options: { detail: opts.detail ?? 'medium' },
  });
  const typology: TypologyDef = getTypology('corridor-midrise');
  const storeys: StoreyDef[] = buildStoreys(spec, spec.floors);
  const resiStoreys = storeys.filter(s => s.index >= 0 && s.index < storeyCount);

  const rooms: RoomDef[] = [];
  const walls: WallDef[] = [];
  const doors: DoorDef[] = [];
  const windows: WindowDef[] = [];
  const furniture: FurnitureDef[] = [];
  const units: UnitInstance[] = [];
  const floors: FloorPlan[] = [];
  const balconyDefs: BalconyDef[] = [];

  let wallSeq = 0;
  let doorSeq = 0;
  let winSeq = 0;
  let furnSeq = 0;
  const nextWallId = (): string => `ARC-WALL-${String(++wallSeq).padStart(4, '0')}`;
  const nextDoorId = (): string => `ARC-DOOR-${String(++doorSeq).padStart(4, '0')}`;
  const nextWinId = (): string => `ARC-WIN-${String(++winSeq).padStart(4, '0')}`;
  const nextFurnId = (): string => `ARC-FURN-${String(++furnSeq).padStart(4, '0')}`;

  for (const st of resiStoreys) {
    const floorSpec = spec.floors.find(f => f.index === st.index);
    const ceilingHeight = floorSpec?.ceilingHeight ?? 2.65;
    const f2f = floorSpec?.floorToFloor ?? st.height;
    const storeyUnitIds: string[] = [];
    const storeyRoomIds: string[] = [];
    const storeyWallIds: string[] = [];
    const storeyExtWallIds: string[] = [];
    const storeyBalconies: BalconyDef[] = [];

    // Corridor
    const corridorRect: Rect = { x: 9, y: CORRIDOR_Y - CORRIDOR_WIDTH / 2, w: BAR.w - 12, h: CORRIDOR_WIDTH };
    const corridorRoom: RoomDef = {
      id: makeRoomId(st.id, 'corridor', 1),
      storey: st.id,
      type: 'corridor',
      name: `Corridor ${st.name}`,
      polygon: rectToPolygon(corridorRect),
      rect: corridorRect,
      area: rectArea(corridorRect),
      height: ceilingHeight,
      isWet: false,
      hasExterior: false,
      exteriorWallIds: [],
      wallIds: [],
      doorIds: [],
      windowIds: [],
      furnitureIds: [],
      occupancy: 0,
      zone: 'circulation',
    };
    rooms.push(corridorRoom);
    storeyRoomIds.push(corridorRoom.id);
    const corridor: CorridorDef = {
      id: `ARC-${st.id}-CORR-001`,
      storey: st.id,
      polygon: rectToPolygon(corridorRect),
      centerline: [{ a: [corridorRect.x, CORRIDOR_Y], b: [corridorRect.x + corridorRect.w, CORRIDOR_Y] }],
      width: CORRIDOR_WIDTH,
      roomId: corridorRoom.id,
    };

    let unitIndex = 0;
    for (const side of ['rear', 'front'] as const) {
      for (let i = 0; i < unitsPerSide; i++) {
        unitIndex++;
        const uid = makeUnitId(st.id, unitIndex);
        const unitRect: Rect = side === 'rear'
          ? { x: 9 + i * UNIT_W, y: BAR.y, w: UNIT_W, h: UNIT_D }
          : { x: 9 + i * UNIT_W, y: CORRIDOR_Y + CORRIDOR_WIDTH / 2, w: UNIT_W, h: UNIT_D };
        const odd = unitIndex % 2 === 1;
        const accessY = side === 'rear' ? unitRect.y + unitRect.h : unitRect.y;
        const exteriorY = side === 'rear' ? unitRect.y : unitRect.y + unitRect.h;

        // Boundary and internal walls
        const extWall: WallDef = {
          id: nextWallId(), storey: st.id, start: [unitRect.x, exteriorY], end: [unitRect.x + UNIT_W, exteriorY],
          thickness: 0.3, height: ceilingHeight, type: 'exterior', isExternal: true, loadBearingHint: true,
          unitId: uid, exposure: side === 'rear' ? 'S' : 'N',
        };
        const corrWall: WallDef = {
          id: nextWallId(), storey: st.id, start: [unitRect.x, accessY], end: [unitRect.x + UNIT_W, accessY],
          thickness: 0.2, height: ceilingHeight, type: 'corridor', isExternal: false, loadBearingHint: true,
          unitId: uid, fireRating: '1 hour',
        };
        const wetWallRect = mapRect(unitRect, side, 6.6, 0, 0.2, 4.8);
        const wetWall: WallDef = {
          id: nextWallId(), storey: st.id,
          start: [wetWallRect.x, side === 'rear' ? wetWallRect.y + wetWallRect.h : wetWallRect.y],
          end: [wetWallRect.x, side === 'rear' ? wetWallRect.y : wetWallRect.y + wetWallRect.h],
          thickness: 0.2, height: ceilingHeight, type: 'wet', isExternal: false, loadBearingHint: false, unitId: uid,
        };
        const hallLeftRect = mapRect(unitRect, side, 3.4, 0, 0.12, 4.8);
        const hallLeft: WallDef = {
          id: nextWallId(), storey: st.id,
          start: [hallLeftRect.x, side === 'rear' ? hallLeftRect.y + hallLeftRect.h : hallLeftRect.y],
          end: [hallLeftRect.x, side === 'rear' ? hallLeftRect.y : hallLeftRect.y + hallLeftRect.h],
          thickness: 0.12, height: ceilingHeight, type: 'partition', isExternal: false, loadBearingHint: false, unitId: uid,
        };
        const hallInnerRect = mapRect(unitRect, side, 3.4, 4.8, 3.2, 0.12);
        const hallInner: WallDef = {
          id: nextWallId(), storey: st.id,
          start: [hallInnerRect.x, hallInnerRect.y], end: [hallInnerRect.x + hallInnerRect.w, hallInnerRect.y],
          thickness: 0.12, height: ceilingHeight, type: 'partition', isExternal: false, loadBearingHint: false, unitId: uid,
        };
        walls.push(extWall, corrWall, wetWall, hallLeft, hallInner);
        storeyWallIds.push(extWall.id, corrWall.id, wetWall.id, hallLeft.id, hallInner.id);
        storeyExtWallIds.push(extWall.id);

        // Entry door in the corridor wall — hinge/swing derived, leaf into the dwelling (core/openings.ts)
        const entrySwing = solveSwing({
          wall: corrWall, along: 5.0, width: 0.9, motion: 'swing', into: reachRect(unitRect, corrWall),
        });
        const entryDoor: DoorDef = {
          id: nextDoorId(), storey: st.id, wallId: corrWall.id, along: 5.0, width: 0.9, height: 2.1,
          type: 'unit-entry', motion: 'swing', hinge: entrySwing.hinge, swing: entrySwing.swing,
          fireRated: true, unitId: uid, ref: 'entry',
        };
        doors.push(entryDoor);

        // Rooms
        const roomIds: string[] = [];
        const bathroomRoomIds: string[] = [];
        let kitchenRoomId: string | undefined;
        const typeCounts = new Map<RoomType, number>();
        const roomByName = new Map<string, RoomDef>();
        for (const lr of LOCAL_ROOMS) {
          if (lr.oddOnly && !odd) continue;
          const n = (typeCounts.get(lr.type) ?? 0) + 1;
          typeCounts.set(lr.type, n);
          const rect = mapRect(unitRect, side, lr.u, lr.v, lr.w, lr.d);
          const room: RoomDef = {
            id: makeRoomId(uid, lr.type, n),
            storey: st.id,
            unitId: uid,
            type: lr.type,
            name: lr.name,
            polygon: rectToPolygon(rect),
            rect,
            area: rectArea(rect),
            height: ceilingHeight,
            isWet: !!lr.wet,
            hasExterior: !!lr.exterior,
            exteriorWallIds: lr.exterior ? [extWall.id] : [],
            wallIds: lr.type === 'hall'
              ? [corrWall.id, wetWall.id, hallLeft.id, hallInner.id]
              : lr.wet && lr.type !== 'laundry'
                ? [wetWall.id, corrWall.id]
                : lr.exterior ? [extWall.id, hallInner.id] : [hallLeft.id],
            doorIds: [],
            windowIds: [],
            furnitureIds: [],
            occupancy: lr.occupancy ?? 0,
            zone: lr.zone,
          };
          rooms.push(room);
          roomIds.push(room.id);
          storeyRoomIds.push(room.id);
          roomByName.set(lr.name, room);
          if (lr.type === 'bathroom' || lr.type === 'ensuite') bathroomRoomIds.push(room.id);
          if (lr.type === 'living-kitchen') kitchenRoomId = room.id;
          if (lr.type === 'hall') room.doorIds.push(entryDoor.id);

          // One window per exterior room, hosted in the unit's exterior wall
          if (lr.exterior) {
            const win: WindowDef = {
              id: nextWinId(), storey: st.id, wallId: extWall.id, along: lr.u + lr.w / 2,
              sill: 0.9, width: Math.min(1.8, lr.w - 0.6), height: 1.4, roomId: room.id,
              exposure: side === 'rear' ? 'S' : 'N', unitId: uid,
            };
            windows.push(win);
            room.windowIds.push(win.id);
          }
          // An interior door off the hall
          if (lr.type !== 'hall') {
            const host = lr.wet && lr.type !== 'laundry' ? wetWall : lr.exterior ? hallInner : hallLeft;
            const along = lr.wet && lr.type !== 'laundry'
              ? lr.v + lr.d / 2
              : lr.exterior ? Math.min(2.9, Math.max(0.3, lr.u + lr.w / 2 - 3.4)) : Math.min(4.2, lr.v + lr.d / 2);
            const motion: DoorDef['motion'] = lr.type === 'walk-in-closet' ? 'sliding' : 'swing';
            const sol = solveSwing({
              wall: host, along, width: lr.wet ? 0.75 : 0.8, motion, into: reachRect(room.rect, host),
            });
            const door: DoorDef = {
              id: nextDoorId(), storey: st.id, wallId: host.id, along, width: lr.wet ? 0.75 : 0.8, height: 2.1,
              type: lr.type === 'walk-in-closet' ? 'closet' : 'interior',
              motion, hinge: sol.hinge, swing: sol.swing,
              ...(motion === 'swing' ? { swingIntoRoomId: room.id } : {}),
              fromRoomId: roomByName.get('Hall')?.id, toRoomId: room.id, unitId: uid,
            };
            doors.push(door);
            room.doorIds.push(door.id);
          }
        }

        // Furniture
        for (const lf of LOCAL_FURNITURE) {
          const room = roomByName.get(lf.room);
          if (!room) continue;
          const rect = mapRect(unitRect, side, lf.u, lf.v, lf.w, lf.d);
          const f: FurnitureDef = {
            id: nextFurnId(), storey: st.id, roomId: room.id, unitId: uid, type: lf.type,
            position: [rect.x, rect.y], width: lf.w, depth: lf.d,
            height: lf.type === 'range' ? 0.9 : lf.type === 'bathtub' ? 0.6 : 0.85, rotation: 0,
            needsWater: lf.water, needsPower: lf.power,
          };
          furniture.push(f);
          room.furnitureIds.push(f.id);
        }

        // Balcony outside the exterior edge (rear-row dwellings only when balconies is true)
        let balconyRoomId: string | undefined;
        if (balconies && side === 'front') {
          const bRect: Rect = { x: unitRect.x + 6.4, y: unitRect.y + unitRect.h, w: 3.6, h: 1.5 };
          const bRoom: RoomDef = {
            id: makeRoomId(uid, 'balcony', 1), storey: st.id, unitId: uid, type: 'balcony', name: 'Balcony',
            polygon: rectToPolygon(bRect), rect: bRect, area: rectArea(bRect), height: ceilingHeight,
            isWet: false, hasExterior: true, exteriorWallIds: [extWall.id], wallIds: [extWall.id],
            doorIds: [], windowIds: [], furnitureIds: [], occupancy: 0, zone: 'outdoor',
          };
          rooms.push(bRoom);
          roomIds.push(bRoom.id);
          storeyRoomIds.push(bRoom.id);
          balconyRoomId = bRoom.id;
          const bal: BalconyDef = { id: `ARC-${st.id}-BAL-${String(unitIndex).padStart(2, '0')}`, storey: st.id, unitId: uid, rect: bRect, roomId: bRoom.id };
          storeyBalconies.push(bal);
          balconyDefs.push(bal);
        }

        units.push({
          id: uid,
          templateId: '2b2b',
          storeys: [st.id],
          rect: unitRect,
          polygon: rectToPolygon(unitRect),
          area: rectArea(unitRect),
          bedrooms: 2,
          bathrooms: 2,
          occupants: 3,
          aspect: 'single',
          accessSide: side,
          entryDoorId: entryDoor.id,
          roomIds,
          wetWallIds: [wetWall.id],
          kitchenRoomId,
          bathroomRoomIds,
          balconyRoomId,
          barId: 'BAR-1',
          coreId: i === 0 ? 'ARC-CORE-A' : 'ARC-CORE-B',
        });
        storeyUnitIds.push(uid);
      }
    }

    floors.push({
      storey: st.id,
      use: st.index === 0 ? 'lobby-residential' : 'residential',
      outline: rectToPolygon(BAR),
      area: rectArea(BAR),
      floorToFloor: f2f,
      ceilingHeight,
      slabThickness: 0.2,
      corridors: [corridor],
      unitIds: storeyUnitIds,
      roomIds: storeyRoomIds,
      commonRoomIds: [corridorRoom.id],
      wallIds: storeyWallIds,
      exteriorWallIds: storeyExtWallIds,
      balconies: storeyBalconies,
      wwr: 0.35,
    });
  }

  const resiIds = resiStoreys.map(s => s.id);
  const cores: CoreDef[] = [
    { id: 'ARC-CORE-A', rect: CORE_A, storeys: [...resiIds, ROOF_STOREY], type: 'stair-elevator', stairIds: ['ARC-STAIR-A'], elevatorIds: ['ARC-LIFT-A'], roomIds: [], isExit: true },
    { id: 'ARC-CORE-B', rect: CORE_B, storeys: [...resiIds, ROOF_STOREY], type: 'stair-elevator', stairIds: ['ARC-STAIR-B'], elevatorIds: ['ARC-LIFT-B'], roomIds: [], isExit: true },
  ];
  const shafts: ShaftDef[] = (opts.shafts ?? true) ? [
    { id: 'ARC-SHAFT-A', rect: SHAFT_A, storeys: [...resiIds, ROOF_STOREY], purpose: 'combined', servesUnitIds: units.filter(u => u.rect.x < 25).map(u => u.id), accessFrom: 'corridor' },
    { id: 'ARC-SHAFT-B', rect: SHAFT_B, storeys: [...resiIds, ROOF_STOREY], purpose: 'combined', servesUnitIds: units.filter(u => u.rect.x >= 25).map(u => u.id), accessFrom: 'corridor' },
  ] : [];

  const bar: MassingBar = { id: 'BAR-1', rect: BAR, axis: 'x', depth: BAR.h, length: BAR.w, exteriorSides: ['front', 'rear', 'left', 'right'] };
  const corePlacements: CorePlacement[] = cores.map(c => ({ id: c.id, rect: c.rect, barId: bar.id, type: 'stair-elevator', hasElevator: true, elevatorCount: 1 }));
  const corridorSpines: CorridorSpine[] = [{
    id: 'SPINE-1', barId: bar.id,
    centerline: { a: [9, CORRIDOR_Y], b: [BAR.x + BAR.w - 6, CORRIDOR_Y] },
    width: CORRIDOR_WIDTH, loaded: 'both',
  }];

  const topStorey = resiStoreys[resiStoreys.length - 1];
  const heightAboveGrade = topStorey.elevation + topStorey.height;

  const site: SiteModel = {
    boundary: rectToPolygon({ x: 0, y: 0, w: spec.site.width, h: spec.site.depth }),
    area: spec.site.width * spec.site.depth,
    buildableEnvelope: rectToPolygon({ x: 3, y: 3, w: spec.site.width - 6, h: spec.site.depth - 9 }),
    setbacks: { front: 3, side: 3, rear: 6 },
    streetFacing: 'S',
    northRad: 0,
    massing: {
      shape: 'bar',
      footprint: rectToPolygon(BAR),
      footprintArea: rectArea(BAR),
      bars: [bar],
      storeys,
      heightAboveGrade,
      gfa: rectArea(BAR) * resiStoreys.length,
      cores: corePlacements,
      corridors: corridorSpines,
      roof: { type: 'flat', pitchRad: 0, parapetHeight: 1.1, ridgeAxis: 'x' },
    },
    parking: null,
    landscape: [],
    paths: [],
    driveway: null,
    entrances: [{ id: 'ENT-1', position: rectCenter({ x: CORE_A.x, y: 0, w: CORE_A.w, h: 1 }), side: 'front', type: 'main' }],
    elements: [],
    patterns: [],
    derived: {},
  };

  const arch: ArchModel = {
    storeys,
    floors,
    units,
    rooms,
    walls,
    doors,
    windows,
    furniture,
    cores,
    stairs: [],
    elevators: [],
    shafts,
    roof: {
      type: 'flat',
      outline: rectToPolygon(BAR),
      thickness: 0.2,
      pitchRad: 0,
      ridgeAxis: 'x',
      parapetHeight: 1.1,
      plantZone: opts.plantZone === undefined ? PLANT_ZONE : (opts.plantZone ?? undefined),
    },
    templatesUsed: ['2b2b'],
    elements: [],
    patterns: [],
    derived: { unitCount: units.length, storeyCount: resiStoreys.length },
  };

  const struct: StructModel = {
    system: 'wood-over-podium',
    foundation: 'pad-footing',
    grid: [],
    columns: [],
    beams: [],
    walls: [],
    slabs: [],
    foundations: [],
    sizes: { columnW: 0.4, columnD: 0.4, beamW: 0.3, beamD: 0.5, slabT: 0.2, shearWallT: 0.25 },
    loads: { deadKpa: 2.5, liveKpa: 1.9, roofLiveKpa: 1.0 },
    plenumClearance: { corridorSoffitZ: 2.9 },
    elements: [],
    patterns: [],
    derived: {},
  };

  return {
    spec,
    typology,
    rng: createRng(spec.seed).fork('mechanical'),
    storeys,
    site,
    arch,
    struct,
    mech: null,
    plumb: null,
    elec: null,
    warnings: [],
  };
}

/** Shallow clone with a different HVAC system (the spec has no hvac field, so the typology carries it) */
export function withHvac(ctx: GenContext, hvac: TypologyDef['hvac'], ventilation?: TypologyDef['ventilation']): GenContext {
  return {
    ...ctx,
    typology: { ...ctx.typology, hvac, ventilation: ventilation ?? ctx.typology.ventilation },
    warnings: [],
  };
}

export function fixtureRooms(ctx: GenContext): RoomDef[] { return ctx.arch?.rooms ?? []; }
