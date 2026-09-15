/**
 * Coherent upstream fixture for the electrical discipline: a 4-storey double-loaded corridor
 * mid-rise, 6 dwellings per storey (24 total), two cores, two combined shafts, a lobby /
 * switchroom / plant room on L01, a flat roof with plant and PV zones, and a 12-stall surface
 * car park with 2 EV stalls.
 *
 * Everything is built the way the architecture module is expected to build it:
 *   - rooms are laid out on a CENTRELINE grid; RoomDef.rect / polygon are the NET (inside-face)
 *     extents, obtained by insetting each side by half the thickness of the wall that covers it;
 *   - RoomDef.wallIds lists every wall that covers a side of the room;
 *   - DoorDef.along / WindowDef.along are measured from the host wall's start point.
 *
 * Building geometry (wall centrelines, metres):
 *   bar        x 15 … 51, y 4 … 24            corridor walls y 13.15 / 14.85 (centre y = 14)
 *   core A     x 15 … 18   lift lobby + stair (lobby + stair on L01)
 *   core B     x 48 … 51   stair + storage (switchroom + plant room on L01)
 *   dwellings  x 18 … 48   three 10 m bays per side, mirrored about the corridor
 */
import type {
  ArchModel, BalconyDef, BuildingSpec, CoreDef, CorePlacement, CorridorDef, CorridorSpine, DoorDef,
  ElevatorDef, Entrance, FloorPlan, FurnitureDef, FurnitureType, GenContext, LandscapeZone,
  MassingBar, MassingModel, MechEquipment, MechModel, ParkingLot, ParkingSpace, PlumbModel,
  PlumbingFixture, Polygon, Rect, RoofDef, RoomDef, RoomType, Segment2, ShaftDef, SiteModel,
  StairDef, StoreyDef, StructModel, UnitInstance, Vec2, WallDef, WallType, WindowDef,
} from '../../core/types.ts';
import { IdFactory, roomId, unitId } from '../../core/ids.ts';
import { createRng } from '../../core/rng.ts';
import { buildStoreys, normalizeSpec } from '../../core/spec.ts';
import { getTypology } from '../../core/typologies.ts';
import { dist, polygonArea, rectToPolygon } from '../../core/geometry.ts';

// ---------------------------------------------------------------------------
// Geometry constants
// ---------------------------------------------------------------------------

const BAR_X0 = 15;
const BAR_X1 = 51;
const BAR_Y0 = 4;
const BAR_Y1 = 24;
const CORRIDOR_Y0 = 13.15;
const CORRIDOR_Y1 = 14.85;
const CORE_A_X1 = 18;
const CORE_B_X0 = 48;
const UNIT_BAY = 10;

const T = {
  exterior: 0.3,
  corridor: 0.2,
  party: 0.25,
  core: 0.25,
  partition: 0.12,
  wet: 0.2,
} as const;

interface LocalRect { u0: number; u1: number; v0: number; v1: number }

interface RoomSpec {
  key: string;
  type: RoomType;
  name: string;
  local: LocalRect;
}

/** Dwelling layout in centreline-grid coordinates: u along the frontage, v from the façade */
const UNIT_ROOMS: RoomSpec[] = [
  { key: 'LK', type: 'living-kitchen', name: 'Living / kitchen', local: { u0: 0, u1: 4.6, v0: 0, v1: 6.0 } },
  { key: 'BED1', type: 'master-bedroom', name: 'Bedroom 1', local: { u0: 4.6, u1: 7.3, v0: 0, v1: 4.5 } },
  { key: 'BED2', type: 'bedroom', name: 'Bedroom 2', local: { u0: 7.3, u1: 10, v0: 0, v1: 4.5 } },
  { key: 'HALL', type: 'hall', name: 'Hall', local: { u0: 4.6, u1: 10, v0: 4.5, v1: 6.0 } },
  { key: 'ENTRY', type: 'entry', name: 'Entry', local: { u0: 4.6, u1: 7.3, v0: 6.0, v1: 9.15 } },
  { key: 'BATH', type: 'bathroom', name: 'Bathroom', local: { u0: 7.3, u1: 10, v0: 6.0, v1: 8.0 } },
  { key: 'LNDRY', type: 'laundry', name: 'Laundry', local: { u0: 7.3, u1: 10, v0: 8.0, v1: 9.15 } },
  { key: 'WIC', type: 'walk-in-closet', name: 'Walk-in closet', local: { u0: 0, u1: 1.8, v0: 6.0, v1: 9.15 } },
  { key: 'STUDY', type: 'study', name: 'Study', local: { u0: 1.8, u1: 4.6, v0: 6.0, v1: 9.15 } },
];

interface WallSpec {
  axis: 'u' | 'v';
  at: number;
  from: number;
  to: number;
  thickness: number;
  type: WallType;
}

const UNIT_WALLS: WallSpec[] = [
  { axis: 'u', at: 1.8, from: 6.0, to: 9.15, thickness: T.partition, type: 'partition' },
  { axis: 'u', at: 4.6, from: 0, to: 9.15, thickness: T.partition, type: 'partition' },
  { axis: 'u', at: 7.3, from: 0, to: 4.5, thickness: T.partition, type: 'partition' },
  { axis: 'u', at: 7.3, from: 6.0, to: 9.15, thickness: T.wet, type: 'wet' },
  { axis: 'v', at: 4.5, from: 4.6, to: 10, thickness: T.partition, type: 'partition' },
  { axis: 'v', at: 6.0, from: 0, to: 10, thickness: T.partition, type: 'partition' },
  { axis: 'v', at: 8.0, from: 7.3, to: 10, thickness: T.wet, type: 'wet' },
];

interface DoorSpec {
  onAxis: 'u' | 'v';
  at: number;
  pos: number;
  width: number;
  type: DoorDef['type'];
  from: string;
  to: string;
  fireRated?: boolean;
}

/** `at` is the wall line, `pos` the position along it (grid coordinates) */
const UNIT_DOORS: DoorSpec[] = [
  { onAxis: 'v', at: 9.15, pos: 5.95, width: 0.9, type: 'unit-entry', from: 'CORRIDOR', to: 'ENTRY' },
  { onAxis: 'v', at: 6.0, pos: 5.95, width: 0.9, type: 'interior', from: 'ENTRY', to: 'HALL' },
  { onAxis: 'v', at: 4.5, pos: 5.95, width: 0.8, type: 'interior', from: 'HALL', to: 'BED1' },
  { onAxis: 'v', at: 4.5, pos: 8.6, width: 0.8, type: 'interior', from: 'HALL', to: 'BED2' },
  { onAxis: 'u', at: 4.6, pos: 5.25, width: 0.9, type: 'interior', from: 'HALL', to: 'LK' },
  { onAxis: 'v', at: 6.0, pos: 8.6, width: 0.75, type: 'interior', from: 'HALL', to: 'BATH' },
  { onAxis: 'u', at: 4.6, pos: 7.5, width: 0.8, type: 'interior', from: 'ENTRY', to: 'STUDY' },
  { onAxis: 'u', at: 7.3, pos: 8.6, width: 0.8, type: 'interior', from: 'ENTRY', to: 'LNDRY' },
  { onAxis: 'v', at: 6.0, pos: 0.9, width: 0.8, type: 'closet', from: 'LK', to: 'WIC' },
];

interface WindowSpec { room: string; pos: number; width: number }

const UNIT_WINDOWS: WindowSpec[] = [
  { room: 'LK', pos: 1.2, width: 1.5 },
  { room: 'LK', pos: 3.4, width: 1.5 },
  { room: 'BED1', pos: 5.95, width: 1.5 },
  { room: 'BED2', pos: 8.6, width: 1.5 },
];

interface FurnSpec {
  room: string;
  type: FurnitureType;
  local: LocalRect;
  height: number;
  power?: boolean;
  water?: boolean;
}

const UNIT_FURNITURE: FurnSpec[] = [
  { room: 'LK', type: 'kitchen-counter', local: { u0: 0.125, u1: 0.775, v0: 0.5, v1: 3.7 }, height: 0.9, power: true },
  { room: 'LK', type: 'kitchen-counter', local: { u0: 0.9, u1: 2.7, v0: 5.29, v1: 5.94 }, height: 0.9, power: true },
  { room: 'LK', type: 'kitchen-sink', local: { u0: 0.125, u1: 0.775, v0: 1.5, v1: 2.4 }, height: 0.9, water: true },
  { room: 'LK', type: 'dishwasher', local: { u0: 0.125, u1: 0.725, v0: 2.5, v1: 3.1 }, height: 0.85, power: true, water: true },
  { room: 'LK', type: 'fridge', local: { u0: 0.125, u1: 0.825, v0: 3.9, v1: 4.6 }, height: 1.8, power: true },
  { room: 'LK', type: 'range', local: { u0: 0.125, u1: 0.775, v0: 4.7, v1: 5.46 }, height: 0.9, power: true },
  { room: 'LK', type: 'sofa-3', local: { u0: 2.3, u1: 4.5, v0: 0.3, v1: 1.2 }, height: 0.8 },
  { room: 'LK', type: 'dining-table-4', local: { u0: 2.4, u1: 3.8, v0: 2.6, v1: 3.6 }, height: 0.75 },
  { room: 'LK', type: 'tv-unit', local: { u0: 3.9, u1: 4.5, v0: 4.5, v1: 5.9 }, height: 0.5, power: true },
  { room: 'BED1', type: 'bed-queen', local: { u0: 5.3, u1: 6.9, v0: 0.3, v1: 2.3 }, height: 0.6 },
  { room: 'BED1', type: 'nightstand', local: { u0: 4.9, u1: 5.2, v0: 0.3, v1: 0.7 }, height: 0.55 },
  { room: 'BED1', type: 'wardrobe', local: { u0: 4.7, u1: 5.3, v0: 3.3, v1: 4.4 }, height: 2.1 },
  { room: 'BED2', type: 'bed-double', local: { u0: 8.0, u1: 9.4, v0: 0.3, v1: 2.2 }, height: 0.6 },
  { room: 'BED2', type: 'wardrobe', local: { u0: 7.5, u1: 8.1, v0: 3.3, v1: 4.4 }, height: 2.1 },
  { room: 'BATH', type: 'vanity', local: { u0: 7.5, u1: 8.7, v0: 6.15, v1: 6.65 }, height: 0.85, water: true },
  { room: 'BATH', type: 'wc', local: { u0: 9.1, u1: 9.5, v0: 6.15, v1: 6.85 }, height: 0.4, water: true },
  { room: 'BATH', type: 'shower', local: { u0: 7.5, u1: 8.4, v0: 7.0, v1: 7.85 }, height: 2.0, water: true },
  { room: 'LNDRY', type: 'washer', local: { u0: 7.5, u1: 8.1, v0: 8.2, v1: 8.8 }, height: 0.9, power: true, water: true },
  { room: 'LNDRY', type: 'dryer', local: { u0: 8.2, u1: 8.8, v0: 8.2, v1: 8.8 }, height: 0.9, power: true },
  { room: 'LNDRY', type: 'water-heater', local: { u0: 9.0, u1: 9.6, v0: 8.2, v1: 8.8 }, height: 1.5, power: true, water: true },
  { room: 'STUDY', type: 'desk', local: { u0: 2.0, u1: 3.4, v0: 6.2, v1: 6.8 }, height: 0.75 },
  { room: 'STUDY', type: 'chair', local: { u0: 2.5, u1: 2.9, v0: 6.9, v1: 7.3 }, height: 0.9 },
];

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export interface FixtureOptions {
  detail?: 'low' | 'medium' | 'high';
  region?: BuildingSpec['region'];
  storeys?: number;
  /** omit the mechanical / plumbing / structure stubs to test the fallbacks */
  withMech?: boolean;
  withPlumb?: boolean;
  withStruct?: boolean;
  withPv?: boolean;
  withParking?: boolean;
}

interface WallRecord extends WallDef {
  /** axis-aligned line key for lookups */
  axis: 'x' | 'y';
  at: number;
  lo: number;
  hi: number;
}

class StoreyBuilder {
  ids: IdFactory;
  storey: StoreyDef;
  walls: WallRecord[] = [];
  rooms: RoomDef[] = [];
  doors: DoorDef[] = [];
  windows: WindowDef[] = [];
  furniture: FurnitureDef[] = [];
  units: UnitInstance[] = [];
  roomByKey = new Map<string, RoomDef>();
  ceiling: number;

  constructor(ids: IdFactory, storey: StoreyDef, ceiling: number) {
    this.ids = ids;
    this.storey = storey;
    this.ceiling = ceiling;
  }

  wall(axis: 'x' | 'y', at: number, lo: number, hi: number, thickness: number, type: WallType, opts: { external?: boolean; exposure?: WallDef['exposure']; unitId?: string } = {}): WallRecord {
    const start: Vec2 = axis === 'x' ? [lo, at] : [at, lo];
    const end: Vec2 = axis === 'x' ? [hi, at] : [at, hi];
    const w: WallRecord = {
      id: this.ids.next(this.storey.id, 'WALL'),
      storey: this.storey.id,
      start,
      end,
      thickness,
      height: this.storey.height,
      type,
      isExternal: opts.external ?? false,
      loadBearingHint: type === 'exterior' || type === 'party' || type === 'core',
      fireRating: type === 'party' || type === 'core' || type === 'corridor' ? '1 h' : undefined,
      unitId: opts.unitId,
      exposure: opts.exposure,
      axis,
      at,
      lo,
      hi,
    };
    this.walls.push(w);
    return w;
  }

  /** Walls covering a side of a grid rect, plus the resulting net inset */
  coveringWalls(grid: Rect): { walls: WallRecord[]; inset: { front: number; rear: number; left: number; right: number } } {
    const out: WallRecord[] = [];
    const inset = { front: 0, rear: 0, left: 0, right: 0 };
    const overlap = (a0: number, a1: number, b0: number, b1: number): number =>
      Math.min(a1, b1) - Math.max(a0, b0);
    for (const w of this.walls) {
      if (w.axis === 'x') {
        const ov = overlap(w.lo, w.hi, grid.x, grid.x + grid.w);
        if (ov <= 0.2) continue;
        if (Math.abs(w.at - grid.y) < 1e-6) {
          out.push(w);
          inset.front = Math.max(inset.front, w.thickness / 2);
        } else if (Math.abs(w.at - (grid.y + grid.h)) < 1e-6) {
          out.push(w);
          inset.rear = Math.max(inset.rear, w.thickness / 2);
        }
      } else {
        const ov = overlap(w.lo, w.hi, grid.y, grid.y + grid.h);
        if (ov <= 0.2) continue;
        if (Math.abs(w.at - grid.x) < 1e-6) {
          out.push(w);
          inset.left = Math.max(inset.left, w.thickness / 2);
        } else if (Math.abs(w.at - (grid.x + grid.w)) < 1e-6) {
          out.push(w);
          inset.right = Math.max(inset.right, w.thickness / 2);
        }
      }
    }
    return { walls: out, inset };
  }

  room(key: string, id: string, type: RoomType, name: string, grid: Rect, opts: { unitId?: string; zone?: RoomDef['zone'] } = {}): RoomDef {
    const { walls, inset } = this.coveringWalls(grid);
    const rect: Rect = {
      x: grid.x + inset.left,
      y: grid.y + inset.front,
      w: grid.w - inset.left - inset.right,
      h: grid.h - inset.front - inset.rear,
    };
    const polygon: Polygon = rectToPolygon(rect);
    const wet = type === 'bathroom' || type === 'ensuite' || type === 'kitchen' || type === 'living-kitchen'
      || type === 'laundry' || type === 'wc' || type === 'powder' || type === 'water-room';
    const exterior = walls.filter(w => w.isExternal);
    const room: RoomDef = {
      id,
      storey: this.storey.id,
      unitId: opts.unitId,
      type,
      name,
      polygon,
      rect,
      area: Math.round(rect.w * rect.h * 100) / 100,
      height: this.ceiling,
      isWet: wet,
      hasExterior: exterior.length > 0,
      exteriorWallIds: exterior.map(w => w.id),
      wallIds: walls.map(w => w.id),
      doorIds: [],
      windowIds: [],
      furnitureIds: [],
      occupancy: type === 'bedroom' || type === 'master-bedroom' ? 2 : type === 'living-kitchen' ? 4 : 1,
      zone: opts.zone ?? zoneFor(type),
    };
    this.rooms.push(room);
    this.roomByKey.set(key, room);
    return room;
  }

  findWall(axis: 'x' | 'y', at: number, pos: number): WallRecord | null {
    let best: WallRecord | null = null;
    for (const w of this.walls) {
      if (w.axis !== axis || Math.abs(w.at - at) > 1e-6) continue;
      if (pos < w.lo - 1e-6 || pos > w.hi + 1e-6) continue;
      if (!best || w.hi - w.lo < best.hi - best.lo) best = w;
    }
    return best;
  }

  door(axis: 'x' | 'y', at: number, pos: number, width: number, type: DoorDef['type'], from: RoomDef | null, to: RoomDef | null, opts: { unitId?: string; fireRated?: boolean; operation?: string } = {}): DoorDef | null {
    const wall = this.findWall(axis, at, pos);
    if (!wall) return null;
    const point: Vec2 = axis === 'x' ? [pos, at] : [at, pos];
    const door: DoorDef = {
      id: this.ids.next(this.storey.id, 'DOOR'),
      storey: this.storey.id,
      wallId: wall.id,
      along: Math.round(dist(wall.start, point) * 1000) / 1000,
      width,
      height: 2.1,
      type,
      operation: opts.operation ?? 'SINGLE_SWING_LEFT',
      fromRoomId: from?.id,
      toRoomId: to?.id,
      fireRated: opts.fireRated,
      unitId: opts.unitId,
    };
    this.doors.push(door);
    if (from) from.doorIds.push(door.id);
    if (to) to.doorIds.push(door.id);
    return door;
  }

  window(axis: 'x' | 'y', at: number, pos: number, width: number, room: RoomDef, exposure: WindowDef['exposure']): WindowDef | null {
    const wall = this.findWall(axis, at, pos);
    if (!wall) return null;
    const point: Vec2 = axis === 'x' ? [pos, at] : [at, pos];
    const win: WindowDef = {
      id: this.ids.next(this.storey.id, 'WIN'),
      storey: this.storey.id,
      wallId: wall.id,
      along: Math.round(dist(wall.start, point) * 1000) / 1000,
      sill: 0.9,
      width,
      height: 1.4,
      roomId: room.id,
      exposure,
      unitId: room.unitId,
    };
    this.windows.push(win);
    room.windowIds.push(win.id);
    return win;
  }

  furn(room: RoomDef, type: FurnitureType, rect: Rect, height: number, power?: boolean, water?: boolean): FurnitureDef {
    const f: FurnitureDef = {
      id: this.ids.next(this.storey.id, 'FURN'),
      storey: this.storey.id,
      roomId: room.id,
      unitId: room.unitId,
      type,
      position: [rect.x, rect.y],
      width: rect.w,
      depth: rect.h,
      height,
      rotation: 0,
      needsWater: water,
      needsPower: power,
    };
    this.furniture.push(f);
    room.furnitureIds.push(f.id);
    return f;
  }
}

function zoneFor(t: RoomType): RoomDef['zone'] {
  switch (t) {
    case 'living': case 'dining': case 'living-kitchen': case 'kitchen': case 'lobby': case 'amenity':
      return 'public';
    case 'bedroom': case 'master-bedroom': case 'bathroom': case 'ensuite': case 'study':
    case 'walk-in-closet': case 'closet':
      return 'private';
    case 'hall': case 'entry': case 'corridor': case 'stair': case 'lift-lobby': case 'elevator':
      return 'circulation';
    case 'balcony': case 'terrace': case 'porch': case 'courtyard':
      return 'outdoor';
    default:
      return 'service';
  }
}

// ---------------------------------------------------------------------------

export interface Fixture {
  ctx: GenContext;
  spec: BuildingSpec;
  storeys: StoreyDef[];
  site: SiteModel;
  arch: ArchModel;
  struct: StructModel | null;
  mech: MechModel | null;
  plumb: PlumbModel | null;
}

/** Build the whole upstream context */
export function makeContextFixture(options: FixtureOptions = {}): Fixture {
  const storeyCount = options.storeys ?? 4;
  const spec = normalizeSpec({
    typology: 'corridor-midrise',
    seed: 7,
    region: options.region ?? 'US',
    massing: { storeys: storeyCount },
    options: { detail: options.detail ?? 'high' },
  });
  const typology = getTypology(spec.typology);
  const storeys = buildStoreys(spec, spec.floors);
  const above = storeys.filter(s => s.index >= 0 && s.index < 100);

  const ids = new IdFactory('architecture');
  const builders: StoreyBuilder[] = [];
  const allUnits: UnitInstance[] = [];
  const corridors: CorridorDef[] = [];
  const floors: FloorPlan[] = [];
  const cores: CoreDef[] = [];
  const stairs: StairDef[] = [];
  const elevators: ElevatorDef[] = [];
  const balconies: BalconyDef[] = [];

  const coreARooms: string[] = [];
  const coreBRooms: string[] = [];

  for (const st of above) {
    const fp = spec.floors.find(f => f.index === st.index);
    const ceiling = fp?.ceilingHeight ?? Math.min((st.height ?? 3.1) - 0.45, 2.7);
    const b = new StoreyBuilder(ids, st, ceiling);
    builders.push(b);
    const ground = st.index === 0;

    // ---- shell walls ----
    const front = b.wall('x', BAR_Y0, BAR_X0, BAR_X1, T.exterior, 'exterior', { external: true, exposure: 'S' });
    const rear = b.wall('x', BAR_Y1, BAR_X0, BAR_X1, T.exterior, 'exterior', { external: true, exposure: 'N' });
    const left = b.wall('y', BAR_X0, BAR_Y0, BAR_Y1, T.exterior, 'exterior', { external: true, exposure: 'W' });
    const right = b.wall('y', BAR_X1, BAR_Y0, BAR_Y1, T.exterior, 'exterior', { external: true, exposure: 'E' });
    b.wall('x', CORRIDOR_Y0, BAR_X0, BAR_X1, T.corridor, 'corridor');
    b.wall('x', CORRIDOR_Y1, BAR_X0, BAR_X1, T.corridor, 'corridor');
    for (const x of [CORE_A_X1, 28, 38, CORE_B_X0]) {
      const type: WallType = x === CORE_A_X1 || x === CORE_B_X0 ? 'core' : 'party';
      const t = x === CORE_A_X1 || x === CORE_B_X0 ? T.core : T.party;
      b.wall('y', x, BAR_Y0, CORRIDOR_Y0, t, type);
      b.wall('y', x, CORRIDOR_Y1, BAR_Y1, t, type);
    }
    if (ground) b.wall('x', 19.5, CORE_B_X0, BAR_X1, T.partition, 'partition');

    // ---- dwelling interior walls ----
    const bays: { x0: number; side: 'front' | 'rear'; n: number }[] = [];
    let n = 0;
    for (const x0 of [18, 28, 38]) {
      bays.push({ x0, side: 'front', n: ++n });
      bays.push({ x0, side: 'rear', n: ++n });
    }
    for (const bay of bays) {
      for (const w of UNIT_WALLS) {
        if (w.axis === 'u') {
          const lo = bay.side === 'front' ? BAR_Y0 + w.from : BAR_Y1 - w.to;
          const hi = bay.side === 'front' ? BAR_Y0 + w.to : BAR_Y1 - w.from;
          b.wall('y', bay.x0 + w.at, lo, hi, w.thickness, w.type);
        } else {
          const at = bay.side === 'front' ? BAR_Y0 + w.at : BAR_Y1 - w.at;
          b.wall('x', at, bay.x0 + w.from, bay.x0 + w.to, w.thickness, w.type);
        }
      }
    }

    // ---- corridor room ----
    const corridorRoom = b.room('CORRIDOR', roomId(st.id, 'CORR', 1), 'corridor', 'Corridor',
      { x: BAR_X0, y: CORRIDOR_Y0, w: BAR_X1 - BAR_X0, h: CORRIDOR_Y1 - CORRIDOR_Y0 });
    const centerline: Segment2[] = [{
      a: [corridorRoom.rect.x, 14],
      b: [corridorRoom.rect.x + corridorRoom.rect.w, 14],
    }];
    const corridorDef: CorridorDef = {
      id: `ARC-${st.id}-CORR-001`,
      storey: st.id,
      polygon: corridorRoom.polygon,
      centerline,
      width: corridorRoom.rect.h,
      roomId: corridorRoom.id,
    };
    corridors.push(corridorDef);

    // ---- cores ----
    const coreAFront = b.room('CORE_A_F', roomId(st.id, ground ? 'LOBBY' : 'LIFTLOBBY', 1),
      ground ? 'lobby' : 'lift-lobby', ground ? 'Entrance lobby' : 'Lift lobby',
      { x: BAR_X0, y: BAR_Y0, w: CORE_A_X1 - BAR_X0, h: CORRIDOR_Y0 - BAR_Y0 });
    const coreARear = b.room('CORE_A_R', roomId(st.id, 'STAIR', 1), 'stair', 'Stair 1',
      { x: BAR_X0, y: CORRIDOR_Y1, w: CORE_A_X1 - BAR_X0, h: BAR_Y1 - CORRIDOR_Y1 });
    const coreBFront = b.room('CORE_B_F', roomId(st.id, 'STAIR', 2), 'stair', 'Stair 2',
      { x: CORE_B_X0, y: BAR_Y0, w: BAR_X1 - CORE_B_X0, h: CORRIDOR_Y0 - BAR_Y0 });
    coreARooms.push(coreAFront.id, coreARear.id);
    coreBRooms.push(coreBFront.id);
    let elecRoom: RoomDef | null = null;
    let mechRoom: RoomDef | null = null;
    if (ground) {
      elecRoom = b.room('ELEC', roomId(st.id, 'ELEC', 1), 'elec-room', 'Switchroom',
        { x: CORE_B_X0, y: CORRIDOR_Y1, w: BAR_X1 - CORE_B_X0, h: 19.5 - CORRIDOR_Y1 });
      mechRoom = b.room('MECH', roomId(st.id, 'MECH', 1), 'mech-room', 'Plant room',
        { x: CORE_B_X0, y: 19.5, w: BAR_X1 - CORE_B_X0, h: BAR_Y1 - 19.5 });
      coreBRooms.push(elecRoom.id, mechRoom.id);
    } else {
      const store = b.room('CORE_B_R', roomId(st.id, 'STORE', 1), 'storage', 'Store',
        { x: CORE_B_X0, y: CORRIDOR_Y1, w: BAR_X1 - CORE_B_X0, h: BAR_Y1 - CORRIDOR_Y1 });
      coreBRooms.push(store.id);
    }
    b.door('x', CORRIDOR_Y0, 16.5, 1.0, 'interior', corridorRoom, coreAFront);
    b.door('x', CORRIDOR_Y1, 16.5, 1.0, 'exit', corridorRoom, coreARear, { fireRated: true });
    b.door('x', CORRIDOR_Y0, 49.5, 1.0, 'exit', corridorRoom, coreBFront, { fireRated: true });
    if (ground) {
      b.door('x', CORRIDOR_Y1, 49.5, 0.9, 'service', corridorRoom, elecRoom, { fireRated: true });
      b.door('x', 19.5, 49.5, 0.9, 'service', elecRoom, mechRoom);
      b.door('x', BAR_Y0, 16.5, 1.8, 'building-entry', coreAFront, null, { operation: 'DOUBLE_DOOR_SINGLE_SWING' });
    } else {
      b.door('x', CORRIDOR_Y1, 49.5, 0.9, 'service', corridorRoom, b.roomByKey.get('CORE_B_R') ?? null);
    }

    // ---- dwellings ----
    for (const bay of bays) {
      const uid = unitId(st.id, bay.n);
      const rooms = new Map<string, RoomDef>();
      for (const rs of UNIT_ROOMS) {
        const grid = toGrid(bay.x0, bay.side, rs.local);
        const r = b.room(`${uid}:${rs.key}`, roomId(uid, rs.key, 1), rs.type, rs.name, grid, { unitId: uid });
        rooms.set(rs.key, r);
      }
      let entryDoorId = '';
      for (const ds of UNIT_DOORS) {
        const from = ds.from === 'CORRIDOR' ? corridorRoom : rooms.get(ds.from) ?? null;
        const to = rooms.get(ds.to) ?? null;
        const axis: 'x' | 'y' = ds.onAxis === 'v' ? 'x' : 'y';
        const at = ds.onAxis === 'v'
          ? (bay.side === 'front' ? BAR_Y0 + ds.at : BAR_Y1 - ds.at)
          : bay.x0 + ds.at;
        const pos = ds.onAxis === 'v'
          ? bay.x0 + ds.pos
          : (bay.side === 'front' ? BAR_Y0 + ds.pos : BAR_Y1 - ds.pos);
        const d = b.door(axis, at, pos, ds.width, ds.type, from, to, {
          unitId: uid,
          fireRated: ds.type === 'unit-entry',
          operation: ds.type === 'unit-entry' ? 'SINGLE_SWING_RIGHT' : 'SINGLE_SWING_LEFT',
        });
        if (d && ds.type === 'unit-entry') entryDoorId = d.id;
      }
      for (const ws of UNIT_WINDOWS) {
        const room = rooms.get(ws.room);
        if (!room) continue;
        const at = bay.side === 'front' ? BAR_Y0 : BAR_Y1;
        b.window('x', at, bay.x0 + ws.pos, ws.width, room, bay.side === 'front' ? 'S' : 'N');
      }
      for (const fs of UNIT_FURNITURE) {
        const room = rooms.get(fs.room);
        if (!room) continue;
        b.furn(room, fs.type, toGrid(bay.x0, bay.side, fs.local), fs.height, fs.power, fs.water);
      }
      const roomList = [...rooms.values()];
      const bounds = boundsOf(roomList.map(r => r.rect));
      const wetWalls = b.walls.filter(w => w.type === 'wet' && withinBounds(w, bounds));
      const unit: UnitInstance = {
        id: uid,
        templateId: '2b1b',
        storeys: [st.id],
        rect: bounds,
        polygon: rectToPolygon(bounds),
        area: Math.round(roomList.reduce((a, r) => a + r.area, 0) * 100) / 100,
        bedrooms: 2,
        bathrooms: 1,
        occupants: 3,
        aspect: 'single',
        accessSide: bay.side === 'front' ? 'rear' : 'front',
        entryDoorId,
        roomIds: roomList.map(r => r.id),
        wetWallIds: wetWalls.map(w => w.id),
        kitchenRoomId: rooms.get('LK')?.id,
        bathroomRoomIds: [rooms.get('BATH')!.id],
        barId: 'BAR-1',
        coreId: bay.x0 <= 28 ? 'CORE-A' : 'CORE-B',
      };
      allUnits.push(unit);
      b.units.push(unit);
    }

    // ---- stairs and lifts ----
    const riserH = 0.175;
    const risers = Math.round(st.height / riserH);
    stairs.push({
      id: `ARC-${st.id}-STAIR-001`, coreId: 'CORE-A', storey: st.id,
      position: [15.6, 15.4], direction: Math.PI / 2, risers, riserHeight: st.height / risers,
      tread: 0.28, width: 1.1, flights: 2, isExit: true,
    });
    stairs.push({
      id: `ARC-${st.id}-STAIR-002`, coreId: 'CORE-B', storey: st.id,
      position: [48.6, 4.6], direction: Math.PI / 2, risers, riserHeight: st.height / risers,
      tread: 0.28, width: 1.1, flights: 2, isExit: true,
    });

    // ---- floor plan ----
    const outline: Polygon = [
      [BAR_X0 - T.exterior / 2, BAR_Y0 - T.exterior / 2],
      [BAR_X1 + T.exterior / 2, BAR_Y0 - T.exterior / 2],
      [BAR_X1 + T.exterior / 2, BAR_Y1 + T.exterior / 2],
      [BAR_X0 - T.exterior / 2, BAR_Y1 + T.exterior / 2],
    ];
    floors.push({
      storey: st.id,
      use: fp?.use ?? 'residential',
      outline,
      area: polygonArea(outline),
      floorToFloor: st.height,
      ceilingHeight: ceiling,
      slabThickness: 0.2,
      corridors: [corridorDef],
      unitIds: b.units.map(u => u.id),
      roomIds: b.rooms.map(r => r.id),
      commonRoomIds: b.rooms.filter(r => !r.unitId).map(r => r.id),
      wallIds: b.walls.map(w => w.id),
      exteriorWallIds: [front.id, rear.id, left.id, right.id],
      balconies: [],
      wwr: 0.35,
    });
  }

  elevators.push({
    id: 'ARC-LIFT-001', coreId: 'CORE-A',
    rect: { x: 15.3, y: 4.3, w: 2.0, h: 2.2 },
    storeys: above.map(s => s.id),
    capacityKg: 1000,
  });
  cores.push({
    id: 'CORE-A', rect: { x: BAR_X0, y: BAR_Y0, w: CORE_A_X1 - BAR_X0, h: BAR_Y1 - BAR_Y0 },
    storeys: above.map(s => s.id), type: 'stair-elevator',
    stairIds: stairs.filter(s => s.coreId === 'CORE-A').map(s => s.id),
    elevatorIds: ['ARC-LIFT-001'], roomIds: coreARooms, isExit: true,
  });
  cores.push({
    id: 'CORE-B', rect: { x: CORE_B_X0, y: BAR_Y0, w: BAR_X1 - CORE_B_X0, h: BAR_Y1 - BAR_Y0 },
    storeys: above.map(s => s.id), type: 'stair',
    stairIds: stairs.filter(s => s.coreId === 'CORE-B').map(s => s.id),
    elevatorIds: [], roomIds: coreBRooms, isExit: true,
  });

  const shafts: ShaftDef[] = [
    {
      id: 'ARC-SHAFT-001', rect: { x: 15.3, y: 11.4, w: 1.2, h: 1.5 },
      storeys: above.map(s => s.id), purpose: 'combined',
      servesUnitIds: allUnits.filter(u => u.coreId === 'CORE-A').map(u => u.id),
      accessFrom: 'core',
    },
    {
      id: 'ARC-SHAFT-002', rect: { x: 48.3, y: 15.1, w: 1.2, h: 1.5 },
      storeys: above.map(s => s.id), purpose: 'combined',
      servesUnitIds: allUnits.filter(u => u.coreId === 'CORE-B').map(u => u.id),
      accessFrom: 'corridor',
    },
  ];

  const roofOutline: Polygon = [
    [BAR_X0 - 0.15, BAR_Y0 - 0.15], [BAR_X1 + 0.15, BAR_Y0 - 0.15],
    [BAR_X1 + 0.15, BAR_Y1 + 0.15], [BAR_X0 - 0.15, BAR_Y1 + 0.15],
  ];
  const roof: RoofDef = {
    type: 'flat',
    outline: roofOutline,
    thickness: 0.2,
    pitchRad: 0,
    ridgeAxis: 'x',
    parapetHeight: 1.1,
    plantZone: { x: 20, y: 6, w: 8, h: 6 },
    pvZone: options.withPv === false ? undefined : { x: 20, y: 14, w: 20, h: 7 },
  };

  const arch: ArchModel = {
    storeys,
    floors,
    units: allUnits,
    rooms: builders.flatMap(b => b.rooms),
    walls: builders.flatMap(b => b.walls.map(stripWall)),
    doors: builders.flatMap(b => b.doors),
    windows: builders.flatMap(b => b.windows),
    furniture: builders.flatMap(b => b.furniture),
    cores,
    stairs,
    elevators,
    shafts,
    roof,
    templatesUsed: ['2b1b'],
    elements: [],
    patterns: [],
    derived: { unitCount: allUnits.length },
  };

  const site = makeSite(spec, storeys, options);
  const struct = options.withStruct === false ? null : makeStruct(spec, arch);
  const mech = options.withMech === false ? null : makeMech(arch, above.map(s => s.id));
  const plumb = options.withPlumb === false ? null : makePlumb(arch);

  const ctx: GenContext = {
    spec,
    typology,
    rng: createRng(spec.seed).fork('electrical'),
    storeys,
    site,
    arch,
    struct,
    mech,
    plumb,
    elec: null,
    warnings: [],
  };
  return { ctx, spec, storeys, site, arch, struct, mech, plumb };
}

function stripWall(w: WallRecord): WallDef {
  const { axis, at, lo, hi, ...rest } = w;
  return rest;
}

function toGrid(x0: number, side: 'front' | 'rear', l: LocalRect): Rect {
  return side === 'front'
    ? { x: x0 + l.u0, y: BAR_Y0 + l.v0, w: l.u1 - l.u0, h: l.v1 - l.v0 }
    : { x: x0 + l.u0, y: BAR_Y1 - l.v1, w: l.u1 - l.u0, h: l.v1 - l.v0 };
}

function boundsOf(rects: Rect[]): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function withinBounds(w: WallRecord, b: Rect): boolean {
  const pad = 0.3;
  const xs = [w.start[0], w.end[0]];
  const ys = [w.start[1], w.end[1]];
  return Math.min(...xs) >= b.x - pad && Math.max(...xs) <= b.x + b.w + pad
    && Math.min(...ys) >= b.y - pad && Math.max(...ys) <= b.y + b.h + pad;
}

// ---------------------------------------------------------------------------
// Site
// ---------------------------------------------------------------------------

function makeSite(spec: BuildingSpec, storeys: StoreyDef[], options: FixtureOptions): SiteModel {
  const W = spec.site.width;
  const D = spec.site.depth;
  const boundary: Polygon = [[0, 0], [W, 0], [W, D], [0, D]];
  const setbacks = { front: 3, side: 3, rear: 6 };
  const bar: MassingBar = {
    id: 'BAR-1',
    rect: { x: BAR_X0 - 0.15, y: BAR_Y0 - 0.15, w: BAR_X1 - BAR_X0 + 0.3, h: BAR_Y1 - BAR_Y0 + 0.3 },
    axis: 'x',
    depth: BAR_Y1 - BAR_Y0 + 0.3,
    length: BAR_X1 - BAR_X0 + 0.3,
    exteriorSides: ['front', 'rear', 'left', 'right'],
  };
  const above = storeys.filter(s => s.index >= 0 && s.index < 100);
  const corePlacements: CorePlacement[] = [
    { id: 'CORE-A', rect: { x: BAR_X0, y: BAR_Y0, w: 3, h: 20 }, barId: 'BAR-1', type: 'stair-elevator', hasElevator: true, elevatorCount: 1 },
    { id: 'CORE-B', rect: { x: CORE_B_X0, y: BAR_Y0, w: 3, h: 20 }, barId: 'BAR-1', type: 'stair', hasElevator: false, elevatorCount: 0 },
  ];
  const corridorSpines: CorridorSpine[] = [{
    id: 'SPINE-1', barId: 'BAR-1',
    centerline: { a: [BAR_X0 + 0.15, 14], b: [BAR_X1 - 0.15, 14] },
    width: CORRIDOR_Y1 - CORRIDOR_Y0, loaded: 'both',
  }];
  const massing: MassingModel = {
    shape: 'bar',
    footprint: rectToPolygon(bar.rect),
    footprintArea: bar.rect.w * bar.rect.h,
    bars: [bar],
    storeys,
    heightAboveGrade: above.reduce((a, s) => a + s.height, 0),
    gfa: bar.rect.w * bar.rect.h * above.length,
    cores: corePlacements,
    corridors: corridorSpines,
    roof: { type: 'flat', pitchRad: 0, parapetHeight: 1.1, ridgeAxis: 'x' },
  };

  let parking: ParkingLot | null = null;
  if (options.withParking !== false) {
    const spaces: ParkingSpace[] = [];
    for (let i = 0; i < 12; i++) {
      const type: ParkingSpace['type'] = i < 2 ? 'ev' : i === 2 ? 'accessible' : 'standard';
      spaces.push({
        id: `SIT-SITE-STALL-${String(i + 1).padStart(3, '0')}`,
        rect: { x: 16 + i * 2.6, y: 29.4, w: 2.6, h: 5.4 },
        rotation: 0,
        type,
        storey: 'SITE',
      });
    }
    parking = {
      type: 'surface',
      spaces,
      aisles: [{ x: 16, y: 24.2, w: 31.2, h: 5.2 }],
      bikeSpaces: 24,
      bikeStoreRect: { x: 4, y: 26, w: 6, h: 3 },
      storey: 'SITE',
    };
  }

  const landscape: LandscapeZone[] = [
    { id: 'SIT-LAND-001', type: 'lawn', polygon: [[3, 25], [13, 25], [13, 33], [3, 33]], area: 80 },
  ];
  const paths: Rect[] = [
    { x: 15.5, y: 0, w: 2.0, h: 3.85 },
    { x: 2, y: 1.5, w: 62, h: 1.8 },
    { x: 30, y: 24.15, w: 2.0, h: 5.05 },
  ];
  const entrances: Entrance[] = [
    { id: 'SIT-ENT-001', position: [16.5, BAR_Y0 - 0.15], side: 'front', type: 'main' },
    { id: 'SIT-ENT-002', position: [49.5, BAR_Y1 + 0.15], side: 'rear', type: 'service' },
  ];
  return {
    boundary,
    area: W * D,
    buildableEnvelope: [[3, 3], [W - 3, 3], [W - 3, D - 6], [3, D - 6]],
    setbacks,
    streetFacing: spec.site.streetFacing,
    northRad: 0,
    massing,
    parking,
    landscape,
    paths,
    driveway: { x: 28, y: 24.2, w: 6, h: 10.6 },
    entrances,
    elements: [],
    patterns: [],
    derived: {},
  };
}

// ---------------------------------------------------------------------------
// Structure / mechanical / plumbing stubs
// ---------------------------------------------------------------------------

function makeStruct(spec: BuildingSpec, arch: ArchModel): StructModel {
  const f2f = spec.massing.floorToFloor ?? 3.1;
  return {
    system: 'wood-over-podium',
    foundation: 'pad-footing',
    grid: [{ id: 'A', axis: 'x', offset: 18 }, { id: 'B', axis: 'x', offset: 28 }, { id: 'C', axis: 'x', offset: 38 }, { id: 'D', axis: 'x', offset: 48 }],
    columns: [],
    beams: [],
    walls: [],
    slabs: [],
    foundations: [],
    sizes: { columnW: 0.4, columnD: 0.4, beamW: 0.3, beamD: 0.4, slabT: 0.2, shearWallT: 0.25 },
    loads: { deadKpa: 2.5, liveKpa: 1.9, roofLiveKpa: 1.0 },
    plenumClearance: { corridorSoffitZ: f2f - 0.2 - 0.4 },
    elements: [],
    patterns: [],
    derived: {},
  };
}

function makeMech(arch: ArchModel, storeyIds: string[]): MechModel {
  const equipment: MechEquipment[] = [];
  let n = 0;
  for (const unit of arch.units) {
    const hall = arch.rooms.find(r => r.unitId === unit.id && r.type === 'hall');
    const laundry = arch.rooms.find(r => r.unitId === unit.id && r.type === 'laundry');
    if (hall) {
      equipment.push({
        id: `MEC-${unit.storeys[0]}-TSTAT-${String(++n).padStart(3, '0')}`,
        storey: unit.storeys[0],
        type: 'thermostat',
        roomId: hall.id,
        unitId: unit.id,
        position: [hall.rect.x + 0.4, hall.rect.y + hall.rect.h / 2, 1.5],
        width: 0.11, depth: 0.03, height: 0.08, rotation: 0,
      });
    }
    if (laundry) {
      equipment.push({
        id: `MEC-${unit.storeys[0]}-ERV-${String(n).padStart(3, '0')}`,
        storey: unit.storeys[0],
        type: 'erv',
        roomId: laundry.id,
        unitId: unit.id,
        position: [laundry.rect.x + 0.4, laundry.rect.y + 0.3, 2.1],
        width: 0.6, depth: 0.6, height: 0.3, rotation: 0,
        capacityKw: 0.3,
      });
    }
  }
  for (let i = 0; i < 2; i++) {
    equipment.push({
      id: `MEC-ROOF-RTU-${String(i + 1).padStart(3, '0')}`,
      storey: 'ROOF',
      type: 'rtu',
      position: [21 + i * 3.5, 8, 0.3],
      width: 2.4, depth: 1.6, height: 1.4, rotation: 0,
      capacityKw: 8,
    });
  }
  const mechRoom = arch.rooms.find(r => r.type === 'mech-room');
  return {
    system: 'ducted-heat-pump',
    ventilation: 'erv-per-unit',
    equipment,
    ducts: [],
    terminals: [],
    risers: [],
    plantRoomIds: mechRoom ? [mechRoom.id] : [],
    loads: { coolingWPerM2: 45, heatingWPerM2: 35, ventilationLsPerPerson: 7.5, totalCoolingKw: 180, totalHeatingKw: 140 },
    elements: [],
    patterns: [],
    derived: {},
  };
}

function makePlumb(arch: ArchModel): PlumbModel {
  const fixtures: PlumbingFixture[] = [];
  let n = 0;
  for (const unit of arch.units) {
    const laundry = arch.rooms.find(r => r.unitId === unit.id && r.type === 'laundry');
    if (!laundry) continue;
    fixtures.push({
      id: `PLB-${unit.storeys[0]}-WH-${String(++n).padStart(3, '0')}`,
      storey: unit.storeys[0],
      type: 'water-heater',
      roomId: laundry.id,
      unitId: unit.id,
      position: [laundry.rect.x + laundry.rect.w - 0.6, laundry.rect.y + 0.3, 0],
      rotation: 0,
      width: 0.6, depth: 0.6, height: 1.5,
      connections: ['dcw', 'dhw'],
      dfu: 0,
      wsfu: 0,
    });
  }
  return {
    dhw: 'per-unit-tank',
    sprinklered: true,
    fixtures,
    stacks: [],
    pipes: [],
    roofDrains: [[22, 12], [44, 12]],
    totals: { dfu: 24 * 8, wsfu: 24 * 10, fixtureCount: fixtures.length, serviceDiameter: 0.1 },
    elements: [],
    patterns: [],
    derived: {},
  };
}
