/**
 * Architecture accumulator + ModelElement emission.
 *
 * `ArchBuilder` is the mutable bag every organiser writes into: walls, doors, windows, rooms,
 * furniture, units, cores, stairs, lifts, shafts, balconies and floor plans. It owns the id
 * factory and a geometric wall registry so that a boundary requested twice (party wall between
 * two neighbouring units) yields ONE WallDef.
 *
 * `emitElements` turns the accumulated definitions into `ModelElement[]` in a fixed phase order
 *   walls → doors → windows → spaces → furniture → stairs → late (lifts, railings, slabs, roofs)
 * so that a `door-in-wall` / `window-in-wall` element always follows its host `wall` element.
 */
import type {
  BalconyDef, CoreDef, CorridorDef, DoorDef, ElevatorDef, FloorPlan, FurnitureDef, FurnitureType,
  MaterialDef, ModelElement, PatternApplication, Polygon, PropertySetDef, Rect, RGB, RoomDef, RoomType,
  ShaftDef, StairDef, UnitInstance, WallDef, WallType, WindowDef, Zone, StoreyDef, Vec2, Vec3,
} from '../../core/types.ts';
import { IdFactory, roomId as makeRoomId } from '../../core/ids.ts';
import { polygonArea, polygonBounds, rectToPolygon, relativeTo, round } from '../../core/geometry.ts';
import { doorOperation } from '../../core/openings.ts';
import { furnitureTypeDef, quantizeFurnitureWidth, stretchKey } from '../../core/furniture-3d.ts';

/** At or above this clear width a door set is two leaves, so the IFC token gains its DOUBLE_DOOR_ prefix */
const DOUBLE_LEAF_MIN = 1.35;

// ----------------------------------------------------------------------------
// Room taxonomy
// ----------------------------------------------------------------------------

const WET_ROOMS = new Set<RoomType>([
  'kitchen', 'living-kitchen', 'bathroom', 'ensuite', 'powder', 'wc', 'laundry', 'utility',
  'shared-kitchen', 'water-room',
]);

const ZONE_OF: Partial<Record<RoomType, Zone>> = {
  living: 'public', dining: 'public', kitchen: 'public', 'living-kitchen': 'public',
  'shared-kitchen': 'public', 'shared-living': 'public', 'dining-hall': 'public',
  amenity: 'public', gym: 'public', lounge: 'public', retail: 'public', flex: 'public',
  bedroom: 'private', 'master-bedroom': 'private', study: 'private', den: 'private',
  closet: 'private', 'walk-in-closet': 'private',
  bathroom: 'service', ensuite: 'service', powder: 'service', wc: 'service', laundry: 'service',
  utility: 'service', storage: 'service', shaft: 'service', 'mech-room': 'service',
  'elec-room': 'service', 'water-room': 'service', trash: 'service', 'bike-store': 'service',
  mail: 'service', plant: 'service', parking: 'service', garage: 'service', basement: 'service',
  hall: 'circulation', entry: 'circulation', stair: 'circulation', corridor: 'circulation',
  lobby: 'circulation', 'lift-lobby': 'circulation', elevator: 'circulation',
  balcony: 'outdoor', terrace: 'outdoor', courtyard: 'outdoor', landscape: 'outdoor',
  roof: 'outdoor', porch: 'outdoor',
};

/** m² per person (IBC 2021 Table 1004.5 gross, converted) */
const OCCUPANCY_FACTOR: Partial<Record<RoomType, number>> = {
  retail: 5.6, amenity: 1.4, gym: 4.6, lounge: 1.4, 'dining-hall': 1.4, 'shared-living': 1.4,
  'shared-kitchen': 9.3, lobby: 1.4, mail: 9.3, parking: 18.6, storage: 46.5, 'bike-store': 46.5,
  'mech-room': 27.9, 'elec-room': 27.9, 'water-room': 27.9, plant: 27.9, trash: 46.5,
  corridor: 0, 'lift-lobby': 0, stair: 0, shaft: 0, elevator: 0, flex: 9.3, garage: 18.6,
};

export function prettyRoomName(type: RoomType): string {
  const map: Partial<Record<RoomType, string>> = {
    'living-kitchen': 'Living / Kitchen', 'master-bedroom': 'Master Bedroom',
    'walk-in-closet': 'Walk-in Closet', 'lift-lobby': 'Lift Lobby', 'mech-room': 'Mechanical Room',
    'elec-room': 'Electrical Room', 'water-room': 'Water Service Room', 'bike-store': 'Bicycle Store',
    'shared-kitchen': 'Shared Kitchen', 'shared-living': 'Shared Living', 'dining-hall': 'Dining Hall',
    wc: 'WC', mail: 'Mail Room', trash: 'Refuse Room', flex: 'Flexible Room',
  };
  if (map[type]) return map[type]!;
  return type.split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' ');
}

export function roomZone(type: RoomType): Zone {
  return ZONE_OF[type] ?? 'service';
}

export function roomIsWet(type: RoomType): boolean {
  return WET_ROOMS.has(type);
}

export function roomOccupancy(type: RoomType, area: number): number {
  const f = OCCUPANCY_FACTOR[type];
  if (f === 0) return 0;
  if (f !== undefined) return Math.max(1, Math.round(area / f));
  // dwelling rooms
  if (type === 'bedroom') return 1;
  if (type === 'master-bedroom') return 2;
  if (type === 'living' || type === 'living-kitchen' || type === 'dining') return Math.max(2, Math.round(area / 9.3));
  return 0;
}

// ----------------------------------------------------------------------------
// Palette / materials
// ----------------------------------------------------------------------------

const WALL_COLOR: Record<WallType, RGB> = {
  exterior: [0.85, 0.82, 0.78],
  party: [0.75, 0.75, 0.8],
  corridor: [0.88, 0.88, 0.9],
  partition: [0.92, 0.92, 0.92],
  core: [0.6, 0.6, 0.65],
  shaft: [0.65, 0.65, 0.7],
  wet: [0.7, 0.85, 0.9],
  parapet: [0.85, 0.82, 0.78],
  retaining: [0.6, 0.6, 0.6],
  balcony: [0.85, 0.82, 0.78],
};

const WALL_PREDEFINED: Record<WallType, string> = {
  exterior: 'SOLIDWALL', party: 'SOLIDWALL', corridor: 'SOLIDWALL', partition: 'PARTITIONING',
  core: 'SOLIDWALL', shaft: 'SOLIDWALL', wet: 'PARTITIONING', parapet: 'PARAPET',
  retaining: 'SOLIDWALL', balcony: 'PARAPET',
};

function wallMaterial(type: WallType, thickness: number): MaterialDef {
  switch (type) {
    case 'exterior':
    case 'parapet':
    case 'balcony':
      return {
        name: 'Brick veneer / insulation / stud',
        category: 'wall',
        layers: [
          { name: 'Brick veneer', thickness: 0.1, category: 'masonry' },
          { name: 'Insulation', thickness: 0.1, category: 'insulation' },
          { name: 'Stud', thickness: 0.1, category: 'framing' },
        ],
      };
    case 'party':
      return {
        name: 'Double stud party wall',
        category: 'wall',
        layers: [
          { name: 'Gypsum 2 layer', thickness: 0.032, category: 'board' },
          { name: 'Stud + cavity', thickness: Math.max(0.09, thickness - 0.064), category: 'framing' },
          { name: 'Gypsum 2 layer', thickness: 0.032, category: 'board' },
        ],
      };
    case 'core':
    case 'retaining':
      return { name: 'Reinforced concrete', category: 'concrete' };
    case 'shaft':
      return { name: 'Reinforced concrete shaft wall', category: 'concrete' };
    case 'wet':
      return { name: 'Gypsum on stud (wet area board)', category: 'wall' };
    case 'corridor':
      return { name: 'Gypsum on stud (1HR rated)', category: 'wall' };
    default:
      return { name: 'Gypsum on stud', category: 'wall' };
  }
}

const WARM = [0.8, 0.65, 0.5] as RGB;
const KITCHEN = [0.55, 0.6, 0.65] as RGB;
const SANITARY = [0.95, 0.95, 0.97] as RGB;
const WOOD = [0.6, 0.45, 0.3] as RGB;

const FURNITURE_COLOR: Partial<Record<FurnitureType, RGB>> = {
  'bed-king': WARM, 'bed-queen': WARM, 'bed-double': WARM, 'bed-single': WARM, 'bed-bunk': WARM,
  crib: WARM, 'sofa-3': WARM, 'sofa-2': WARM, armchair: WARM, 'lounge-chair': WARM, bench: WARM,
  'kitchen-counter': KITCHEN, 'kitchen-island': KITCHEN, fridge: KITCHEN, range: KITCHEN,
  dishwasher: KITCHEN, 'kitchen-sink': KITCHEN, washer: KITCHEN, dryer: KITCHEN, 'water-heater': KITCHEN,
  wc: SANITARY, lavatory: SANITARY, vanity: SANITARY, shower: SANITARY, bathtub: SANITARY,
  'grab-rail': SANITARY,
  wardrobe: WOOD, dresser: WOOD, nightstand: WOOD, desk: WOOD, bookcase: WOOD, shelving: WOOD,
  'coffee-table': WOOD, 'tv-unit': WOOD, 'dining-table-4': WOOD, 'dining-table-6': WOOD,
  'dining-chair': WOOD, chair: WOOD, 'outdoor-table': WOOD, 'reception-desk': WOOD,
};

const FURNITURE_IFC: Partial<Record<FurnitureType, { ifcType: string; predefinedType?: string }>> = {
  fridge: { ifcType: 'IfcElectricAppliance', predefinedType: 'FRIDGE_FREEZER' },
  range: { ifcType: 'IfcElectricAppliance', predefinedType: 'ELECTRICCOOKER' },
  dishwasher: { ifcType: 'IfcElectricAppliance', predefinedType: 'DISHWASHER' },
  washer: { ifcType: 'IfcElectricAppliance', predefinedType: 'WASHINGMACHINE' },
  dryer: { ifcType: 'IfcElectricAppliance', predefinedType: 'TUMBLEDRYER' },
  wc: { ifcType: 'IfcSanitaryTerminal', predefinedType: 'TOILETPAN' },
  lavatory: { ifcType: 'IfcSanitaryTerminal', predefinedType: 'WASHHANDBASIN' },
  vanity: { ifcType: 'IfcSanitaryTerminal', predefinedType: 'WASHHANDBASIN' },
  shower: { ifcType: 'IfcSanitaryTerminal', predefinedType: 'SHOWER' },
  bathtub: { ifcType: 'IfcSanitaryTerminal', predefinedType: 'BATH' },
  'kitchen-sink': { ifcType: 'IfcSanitaryTerminal', predefinedType: 'SINK' },
  car: { ifcType: 'IfcBuildingElementProxy' },
};

// ----------------------------------------------------------------------------
// Builder
// ----------------------------------------------------------------------------

export interface AddRoomInput {
  storey: string;
  type: RoomType;
  rect?: Rect;
  polygon?: Polygon;
  name?: string;
  unitId?: string;
  height: number;
  exteriorWallIds?: string[];
  wallIds?: string[];
  zone?: Zone;
  occupancy?: number;
  isWet?: boolean;
}

export interface AddWallInput {
  storey: string;
  start: Vec2;
  end: Vec2;
  thickness: number;
  height: number;
  type: WallType;
  isExternal?: boolean;
  loadBearingHint?: boolean;
  fireRating?: string;
  unitId?: string;
  leftRoomId?: string;
  rightRoomId?: string;
  exposure?: WallDef['exposure'];
}

/** One physical flight run of a stair (a StairDef of 2 flights produces two of these) */
export interface StairRun {
  id: string;
  stairId: string;
  coreId: string;
  storey: string;
  position: Vec2;
  direction: number;
  risers: number;
  riserHeight: number;
  tread: number;
  width: number;
  /** Storey-local Z of the first tread nose */
  z: number;
  isExit: boolean;
}

export class ArchBuilder {
  readonly ids: IdFactory;
  readonly warnings: string[];
  walls: WallDef[] = [];
  doors: DoorDef[] = [];
  windows: WindowDef[] = [];
  rooms: RoomDef[] = [];
  furniture: FurnitureDef[] = [];
  units: UnitInstance[] = [];
  cores: CoreDef[] = [];
  stairs: StairDef[] = [];
  stairRuns: StairRun[] = [];
  elevators: ElevatorDef[] = [];
  shafts: ShaftDef[] = [];
  balconies: BalconyDef[] = [];
  corridors: CorridorDef[] = [];
  floors: FloorPlan[] = [];
  patterns: PatternApplication[] = [];
  /** Elements with no definition object (roofs, railings, ramps, lift cars, slabs) */
  late: ModelElement[] = [];

  private wallIndex = new Map<string, WallDef>();
  private roomCounters = new Map<string, number>();
  private unitCounters = new Map<string, number>();
  private warnCounts = new Map<string, string>();
  private warnTally = new Map<string, number>();

  constructor(warnings: string[]) {
    this.ids = new IdFactory('architecture');
    this.warnings = warnings;
  }

  /**
   * A 200-unit building repeats the same handful of complaints hundreds of times. Emit the first
   * three of each distinct complaint verbatim, then roll the rest up in `flushWarnings`.
   */
  warn(msg: string): void {
    const key = msg
      .replace(/\bU-[A-Za-z0-9-]+/g, 'U-*')
      .replace(/\bARC-[A-Za-z0-9-]+/g, 'ARC-*')
      .replace(/\bSIT-[A-Za-z0-9-]+/g, 'SIT-*')
      .replace(/\bR-[A-Za-z0-9-]+/g, 'R-*')
      .replace(/-?\d+(\.\d+)?/g, '#');
    const n = (this.warnTally.get(key) ?? 0) + 1;
    this.warnTally.set(key, n);
    if (n === 1) this.warnCounts.set(key, msg);
    if (n <= 3) this.warnings.push(`[architecture] ${msg}`);
  }

  /** Roll up the warnings that were collapsed by `warn` */
  flushWarnings(): void {
    for (const [key, n] of this.warnTally) {
      if (n <= 3) continue;
      this.warnings.push(`[architecture] ${n - 3} further occurrences of: ${this.warnCounts.get(key) ?? key}`);
    }
  }

  nextUnitIndex(storey: string): number {
    const n = (this.unitCounters.get(storey) ?? 0) + 1;
    this.unitCounters.set(storey, n);
    return n;
  }

  /** Create (or reuse) the wall on a boundary segment. Dedup key = storey + endpoints + thickness. */
  addWall(input: AddWallInput): WallDef {
    const key = wallKey(input.storey, input.start, input.end, input.thickness);
    const existing = this.wallIndex.get(key);
    if (existing) {
      if (input.leftRoomId && !existing.leftRoomId) existing.leftRoomId = input.leftRoomId;
      if (input.rightRoomId && !existing.rightRoomId) existing.rightRoomId = input.rightRoomId;
      return existing;
    }
    const external = input.isExternal ?? (input.type === 'exterior' || input.type === 'parapet' || input.type === 'balcony');
    const wall: WallDef = {
      id: this.ids.next(input.storey, 'WALL'),
      storey: input.storey,
      start: [round(input.start[0]), round(input.start[1])],
      end: [round(input.end[0]), round(input.end[1])],
      thickness: input.thickness,
      height: round(input.height),
      type: input.type,
      isExternal: external,
      loadBearingHint: input.loadBearingHint ?? (input.type === 'exterior' || input.type === 'party' || input.type === 'core'),
      fireRating: input.fireRating,
      unitId: input.unitId,
      leftRoomId: input.leftRoomId,
      rightRoomId: input.rightRoomId,
      exposure: input.exposure,
    };
    this.wallIndex.set(key, wall);
    this.walls.push(wall);
    return wall;
  }

  /** Register a wall produced elsewhere (the unit layout engine) so ids stay resolvable */
  adoptWall(wall: WallDef): void {
    const key = wallKey(wall.storey, wall.start, wall.end, wall.thickness);
    if (!this.wallIndex.has(key)) this.wallIndex.set(key, wall);
    this.walls.push(wall);
  }

  addDoor(input: Omit<DoorDef, 'id'>): DoorDef {
    const d: DoorDef = { id: this.ids.next(input.storey, 'DOOR'), ...input, along: round(input.along) };
    this.doors.push(d);
    return d;
  }

  addWindow(input: Omit<WindowDef, 'id'>): WindowDef {
    const w: WindowDef = { id: this.ids.next(input.storey, 'WIN'), ...input, along: round(input.along) };
    this.windows.push(w);
    return w;
  }

  addRoom(input: AddRoomInput): RoomDef {
    const polygon = input.polygon ?? rectToPolygon(input.rect!);
    const rect = input.rect ?? polygonBounds(polygon);
    const area = round(polygonArea(polygon), 3);
    const owner = input.unitId ?? input.storey;
    const n = (this.roomCounters.get(`${owner}:${input.type}`) ?? 0) + 1;
    this.roomCounters.set(`${owner}:${input.type}`, n);
    const room: RoomDef = {
      id: makeRoomId(owner, input.type, n),
      storey: input.storey,
      unitId: input.unitId,
      type: input.type,
      name: input.name ?? prettyRoomName(input.type),
      polygon: polygon.map(p => [round(p[0]), round(p[1])] as Vec2),
      rect: { x: round(rect.x), y: round(rect.y), w: round(rect.w), h: round(rect.h) },
      area,
      height: round(input.height),
      isWet: input.isWet ?? roomIsWet(input.type),
      hasExterior: (input.exteriorWallIds?.length ?? 0) > 0,
      exteriorWallIds: input.exteriorWallIds ?? [],
      wallIds: input.wallIds ?? [],
      doorIds: [],
      windowIds: [],
      furnitureIds: [],
      occupancy: input.occupancy ?? roomOccupancy(input.type, area),
      zone: input.zone ?? roomZone(input.type),
    };
    this.rooms.push(room);
    return room;
  }

  addFurniture(input: Omit<FurnitureDef, 'id'>): FurnitureDef {
    const f: FurnitureDef = { id: this.ids.next(input.storey, 'FURN'), ...input };
    this.furniture.push(f);
    return f;
  }

  apply(app: PatternApplication): void {
    this.patterns.push(app);
  }

  /** Cross-link rooms ↔ doors/windows/furniture/walls once everything exists (every list deduped: the
   *  unit layout already registers its own doors, windows and furniture on the rooms it created) */
  crossLink(): void {
    const byId = new Map(this.rooms.map(r => [r.id, r] as const));
    const addUnique = (list: string[] | undefined, id: string): void => {
      if (list && !list.includes(id)) list.push(id);
    };
    for (const d of this.doors) {
      addUnique(byId.get(d.fromRoomId ?? '')?.doorIds, d.id);
      if (d.toRoomId && d.toRoomId !== d.fromRoomId) addUnique(byId.get(d.toRoomId)?.doorIds, d.id);
    }
    for (const w of this.windows) addUnique(byId.get(w.roomId)?.windowIds, w.id);
    for (const f of this.furniture) addUnique(byId.get(f.roomId)?.furnitureIds, f.id);
    for (const w of this.walls) {
      for (const rid of [w.leftRoomId, w.rightRoomId]) {
        const r = rid ? byId.get(rid) : undefined;
        if (!r) continue;
        if (!r.wallIds.includes(w.id)) r.wallIds.push(w.id);
        if (w.isExternal && !r.exteriorWallIds.includes(w.id)) {
          r.exteriorWallIds.push(w.id);
          r.hasExterior = true;
        }
      }
    }
  }
}

function wallKey(storey: string, a: Vec2, b: Vec2, t: number): string {
  const q = (v: number): string => (Math.round(v * 1000) / 1000).toFixed(3);
  const k1 = `${q(a[0])},${q(a[1])}`;
  const k2 = `${q(b[0])},${q(b[1])}`;
  const [lo, hi] = k1 <= k2 ? [k1, k2] : [k2, k1];
  return `${storey}|${lo}|${hi}|${q(t)}`;
}

// ----------------------------------------------------------------------------
// Element emission
// ----------------------------------------------------------------------------

export interface EmitOptions {
  /** Ceiling height per storey, for space extrusion */
  ceilingHeight: Map<string, number>;
  unitTemplateOf: Map<string, string>;
  detail: 'low' | 'medium' | 'high';
}

export function emitElements(b: ArchBuilder, opts: EmitOptions): ModelElement[] {
  const out: ModelElement[] = [];
  const used = new Set<string>();
  const wallElementId = new Map<string, string>();

  const mint = (preferred: string, storey: string, kind: string): string => {
    if (!used.has(preferred)) {
      used.add(preferred);
      return preferred;
    }
    let id = b.ids.next(storey, kind);
    while (used.has(id)) id = b.ids.next(storey, kind);
    used.add(id);
    return id;
  };

  // ---- phase 1: walls -------------------------------------------------------
  for (const w of b.walls) {
    const id = mint(w.id, w.storey, 'WALL');
    wallElementId.set(w.id, id);
    const psets: PropertySetDef[] = [{
      name: 'Pset_WallCommon',
      properties: [
        { name: 'IsExternal', value: w.isExternal },
        { name: 'LoadBearing', value: w.loadBearingHint },
        { name: 'Reference', value: w.type },
        ...(w.fireRating ? [{ name: 'FireRating', value: w.fireRating }] : []),
        ...(w.type === 'party' ? [{ name: 'AcousticRating', value: 'STC 55' }] : []),
        ...(w.type === 'exterior' || w.type === 'parapet' ? [{ name: 'ThermalTransmittance', value: 0.18 }] : []),
      ],
    }, {
      name: 'Forma_Architecture',
      properties: [
        { name: 'WallType', value: w.type },
        { name: 'Thickness', value: w.thickness },
        ...(w.exposure ? [{ name: 'Exposure', value: w.exposure }] : []),
        ...(w.unitId ? [{ name: 'Unit', value: w.unitId }] : []),
      ],
    }];
    out.push({
      id,
      discipline: 'architecture',
      ifcType: 'IfcWall',
      predefinedType: WALL_PREDEFINED[w.type],
      name: `${cap(w.type)} wall`,
      objectType: `${w.type}-${Math.round(w.thickness * 1000)}`,
      storey: w.storey,
      geometry: { kind: 'wall', start: [w.start[0], w.start[1], 0], end: [w.end[0], w.end[1], 0], thickness: w.thickness, height: w.height },
      psets,
      quantities: [{
        name: 'Qto_WallBaseQuantities',
        quantities: [
          { name: 'Length', value: round(Math.hypot(w.end[0] - w.start[0], w.end[1] - w.start[1])), kind: 'IfcQuantityLength' },
          { name: 'Height', value: w.height, kind: 'IfcQuantityLength' },
          { name: 'Width', value: w.thickness, kind: 'IfcQuantityLength' },
        ],
      }],
      material: wallMaterial(w.type, w.thickness),
      color: WALL_COLOR[w.type],
      unitId: w.unitId,
      patterns: wallPatterns(w.type),
    });
  }

  // ---- phase 2: doors ------------------------------------------------------
  for (const d of b.doors) {
    const host = wallElementId.get(d.wallId);
    if (!host) {
      b.warn(`door ${d.id} references unknown wall ${d.wallId} — skipped`);
      continue;
    }
    const id = mint(d.id, d.storey, 'DOOR');
    const external = d.type === 'building-entry' || d.type === 'exit' || d.type === 'garage' || d.type === 'balcony';
    // the IFC token is DERIVED from the stored motion/hinge/swing, never authored (core/openings.ts)
    const operation = doorOperation(d, d.width >= DOUBLE_LEAF_MIN ? 2 : 1);
    out.push({
      id,
      discipline: 'architecture',
      ifcType: 'IfcDoor',
      predefinedType: d.type === 'garage' ? 'GATE' : 'DOOR',
      name: `${cap(d.type.replace(/-/g, ' '))} door`,
      objectType: d.type,
      storey: d.storey,
      geometry: { kind: 'door-in-wall', hostId: host, along: d.along, width: d.width, height: d.height, operation },
      psets: [{
        name: 'Pset_DoorCommon',
        properties: [
          { name: 'IsExternal', value: external },
          { name: 'OperationType', value: operation },
          ...(d.fireRated ? [{ name: 'FireRating', value: d.type === 'exit' ? '90 min' : '30 min' }] : []),
          { name: 'Reference', value: d.type },
        ],
      }],
      color: [0.55, 0.42, 0.32],
      material: { name: external ? 'Insulated door set' : 'Flush timber door', category: 'door' },
      unitId: d.unitId,
      roomId: d.fromRoomId,
      patterns: d.type === 'unit-entry' ? ['ARC-02'] : d.type === 'building-entry' ? ['ARC-31'] : d.type === 'exit' ? ['ARC-33'] : undefined,
    });
  }

  // ---- phase 3: windows ----------------------------------------------------
  for (const w of b.windows) {
    const host = wallElementId.get(w.wallId);
    if (!host) {
      b.warn(`window ${w.id} references unknown wall ${w.wallId} — skipped`);
      continue;
    }
    const id = mint(w.id, w.storey, 'WIN');
    out.push({
      id,
      discipline: 'architecture',
      ifcType: 'IfcWindow',
      predefinedType: 'WINDOW',
      name: 'Window',
      objectType: `w${Math.round(w.width * 1000)}x${Math.round(w.height * 1000)}`,
      storey: w.storey,
      geometry: { kind: 'window-in-wall', hostId: host, along: w.along, sill: w.sill, width: w.width, height: w.height },
      psets: [{
        name: 'Pset_WindowCommon',
        properties: [
          { name: 'IsExternal', value: true },
          { name: 'ThermalTransmittance', value: 1.4 },
          ...(w.exposure ? [{ name: 'Reference', value: w.exposure }] : []),
        ],
      }],
      color: [0.6, 0.75, 0.85],
      material: { name: 'Double glazed unit in thermally broken frame', category: 'glazing' },
      unitId: w.unitId,
      roomId: w.roomId,
      patterns: ['ARC-06'],
    });
  }

  // ---- phase 4: spaces -----------------------------------------------------
  for (const r of b.rooms) {
    const id = mint(r.id, r.storey, 'SPACE');
    const h = r.height > 0 ? r.height : (opts.ceilingHeight.get(r.storey) ?? 2.7);
    const origin: Vec3 = [r.rect.x, r.rect.y, 0];
    const template = r.unitId ? opts.unitTemplateOf.get(r.unitId) : undefined;
    out.push({
      id,
      discipline: 'architecture',
      ifcType: 'IfcSpace',
      predefinedType: r.type === 'balcony' || r.type === 'terrace' || r.type === 'courtyard' || r.type === 'porch' || r.type === 'roof'
        ? 'EXTERNAL'
        : r.type === 'parking' ? 'PARKING' : 'INTERNAL',
      name: r.name,
      objectType: r.type,
      description: template ?? (r.unitId ? undefined : `common-${r.type}`),
      storey: r.storey,
      geometry: { kind: 'prism', position: origin, profile: relativeTo(r.polygon, [origin[0], origin[1]]), height: h },
      psets: [{
        name: 'Pset_SpaceCommon',
        properties: [
          { name: 'IsExternal', value: r.zone === 'outdoor' },
          { name: 'Reference', value: template ?? r.type },
          { name: 'OccupancyNumber', value: r.occupancy },
          { name: 'PubliclyAccessible', value: r.zone === 'public' || r.zone === 'circulation' },
          { name: 'HandicapAccessible', value: r.zone !== 'outdoor' },
        ],
      }, {
        name: 'Forma_Architecture',
        properties: [
          { name: 'RoomType', value: r.type },
          { name: 'Zone', value: r.zone },
          { name: 'IsWet', value: r.isWet },
          { name: 'HasExterior', value: r.hasExterior },
          ...(r.unitId ? [{ name: 'Unit', value: r.unitId }] : []),
        ],
      }],
      quantities: [{
        name: 'Qto_SpaceBaseQuantities',
        quantities: [
          { name: 'NetFloorArea', value: r.area, kind: 'IfcQuantityArea' },
          { name: 'Height', value: h, kind: 'IfcQuantityLength' },
          { name: 'GrossVolume', value: round(r.area * h), kind: 'IfcQuantityVolume' },
        ],
      }],
      color: r.zone === 'outdoor' ? [0.7, 0.85, 0.7] : r.isWet ? [0.7, 0.85, 0.9] : [0.9, 0.9, 0.86],
      unitId: r.unitId,
      roomId: r.id,
      patterns: r.type === 'corridor' ? ['ARC-03'] : r.type === 'lobby' ? ['ARC-31'] : undefined,
    });
  }

  // ---- phase 5: furniture --------------------------------------------------
  // `furniture-3d.ts` owns the 3D type of an item: its solids, its real bounding
  // height, and the IFC class + PredefinedType that the type object and the
  // occurrence must agree on. FURNITURE_IFC remains the fallback for a type the
  // library does not cover.
  const OCCURRENCE_CLASS: Record<string, string> = {
    IfcFurnitureType: 'IfcFurnishingElement',
    IfcSanitaryTerminalType: 'IfcSanitaryTerminal',
    IfcElectricApplianceType: 'IfcElectricAppliance',
    IfcBuildingElementProxyType: 'IfcBuildingElementProxy',
  };
  for (const f of b.furniture) {
    const id = mint(f.id, f.storey, 'FURN');
    const type3d = furnitureTypeDef(f.type);
    // Stretchable runs (kitchen counters) are per-length TYPES, so the laid-out
    // width is quantised HERE, once, and written back to the FurnitureDef — plan,
    // axon and IFC then all describe the same run.
    if (type3d?.stretch) f.width = round(quantizeFurnitureWidth(f.type, f.width), 4);
    const ifc = type3d
      ? {
        ifcType: OCCURRENCE_CLASS[type3d.ifcType],
        // IfcFurnishingElement has no PredefinedType attribute in IFC4.
        predefinedType: type3d.ifcType === 'IfcFurnitureType' ? undefined : type3d.predefinedType,
      }
      : FURNITURE_IFC[f.type] ?? { ifcType: 'IfcFurnishingElement' };
    out.push({
      id,
      discipline: 'architecture',
      ifcType: ifc.ifcType,
      predefinedType: ifc.predefinedType,
      name: prettyFurniture(f.type),
      objectType: f.type,
      storey: f.storey,
      // At `low` detail (and for a type with no 3D definition) furniture stays a
      // single bounding box; otherwise it is an occurrence of the type library,
      // carrying its placed footprint so plan and axon need no type lookup.
      geometry: type3d && opts.detail !== 'low'
        ? {
          kind: 'instance', typeId: stretchKey(f.type, f.width),
          position: [f.position[0], f.position[1], 0],
          width: f.width, depth: f.depth, height: type3d.height, rotation: f.rotation,
        }
        : { kind: 'box', position: [f.position[0], f.position[1], 0], width: f.width, depth: f.depth, height: f.height, rotation: f.rotation },
      psets: [{
        name: 'Forma_Architecture',
        properties: [
          { name: 'FurnitureType', value: f.type },
          { name: 'NeedsWater', value: f.needsWater ?? false },
          { name: 'NeedsPower', value: f.needsPower ?? false },
        ],
      }],
      color: FURNITURE_COLOR[f.type] ?? [0.7, 0.7, 0.7],
      unitId: f.unitId,
      roomId: f.roomId,
    });
  }

  // ---- phase 6: stair flight runs ------------------------------------------
  for (const s of b.stairRuns) {
    const id = mint(s.id, s.storey, 'STAIR');
    out.push({
      id,
      discipline: 'architecture',
      ifcType: 'IfcStair',
      predefinedType: 'STRAIGHT_RUN_STAIR',
      name: 'Stair flight',
      objectType: s.isExit ? 'exit-stair' : 'stair',
      storey: s.storey,
      geometry: {
        kind: 'stair', position: [round(s.position[0]), round(s.position[1]), round(s.z)],
        direction: round(s.direction, 6), risers: s.risers, riserHeight: s.riserHeight, tread: s.tread, width: s.width,
      },
      psets: [{
        name: 'Pset_StairFlightCommon',
        properties: [
          { name: 'NumberOfRiser', value: s.risers },
          { name: 'NumberOfTreads', value: Math.max(1, s.risers - 1) },
          { name: 'RiserHeight', value: s.riserHeight },
          { name: 'TreadLength', value: s.tread },
          { name: 'IsExternal', value: false },
          { name: 'FireRating', value: '2HR' },
          { name: 'RequiredHeadroom', value: 2.03 },
          { name: 'Reference', value: s.stairId },
        ],
      }],
      material: { name: 'Precast concrete stair', category: 'concrete' },
      color: [0.66, 0.66, 0.7],
      patterns: ['ARC-04', 'ARC-33'],
    });
  }

  // ---- phase 7: late elements (lifts, railings, slabs, roofs, ramps) -------
  for (const e of b.late) {
    const id = mint(e.id, e.storey, 'MISC');
    out.push({ ...e, id });
  }

  return out;
}

function wallPatterns(t: WallType): string[] | undefined {
  switch (t) {
    case 'party': return ['ARC-02'];
    case 'core': return ['ARC-04'];
    case 'shaft': return ['ARC-32', 'XD-04'];
    case 'corridor': return ['ARC-03'];
    case 'parapet': return ['ARC-35'];
    case 'wet': return ['XD-01'];
    default: return undefined;
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function prettyFurniture(t: FurnitureType): string {
  return t.split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' ');
}

// ----------------------------------------------------------------------------
// Late-element constructors (used by cores / envelope / balconies)
// ----------------------------------------------------------------------------

export function railingElement(
  b: ArchBuilder, storey: string, a: Vec2, c: Vec2, height: number, z = 0, patterns?: string[],
): ModelElement {
  const e: ModelElement = {
    id: b.ids.next(storey, 'RAIL'),
    discipline: 'architecture',
    ifcType: 'IfcRailing',
    predefinedType: 'BALUSTRADE',
    name: 'Railing',
    storey,
    geometry: { kind: 'railing', start: [a[0], a[1], z], end: [c[0], c[1], z], height, width: 0.05 },
    psets: [{ name: 'Pset_RailingCommon', properties: [{ name: 'Height', value: height }, { name: 'IsExternal', value: true }] }],
    material: { name: 'Galvanised steel balustrade with glass infill', category: 'metal' },
    color: [0.45, 0.47, 0.5],
    patterns,
  };
  b.late.push(e);
  return e;
}

export function slabElement(
  b: ArchBuilder, storey: string, rect: Rect, thickness: number, z: number,
  kind: 'FLOOR' | 'ROOF' | 'BASESLAB' | 'LANDING', name: string, patterns?: string[], unitId?: string,
): ModelElement {
  const e: ModelElement = {
    id: b.ids.next(storey, 'SLAB'),
    discipline: 'architecture',
    ifcType: 'IfcSlab',
    predefinedType: kind,
    name,
    storey,
    geometry: { kind: 'slab', position: [rect.x, rect.y, z], profile: relativeTo(rectToPolygon(rect), [rect.x, rect.y]), thickness },
    psets: [{ name: 'Pset_SlabCommon', properties: [{ name: 'IsExternal', value: kind !== 'FLOOR' }, { name: 'LoadBearing', value: true }, { name: 'Thickness', value: thickness }] }],
    quantities: [{ name: 'Qto_SlabBaseQuantities', quantities: [{ name: 'GrossArea', value: round(rect.w * rect.h), kind: 'IfcQuantityArea' }] }],
    material: { name: 'Reinforced concrete slab', category: 'concrete' },
    color: [0.72, 0.72, 0.72],
    unitId,
    patterns,
  };
  b.late.push(e);
  return e;
}

export function slabElementPoly(
  b: ArchBuilder, storey: string, poly: Polygon, thickness: number, z: number,
  kind: 'FLOOR' | 'ROOF' | 'BASESLAB', name: string, patterns?: string[],
): ModelElement {
  const o = polygonBounds(poly);
  const e: ModelElement = {
    id: b.ids.next(storey, 'SLAB'),
    discipline: 'architecture',
    ifcType: 'IfcSlab',
    predefinedType: kind,
    name,
    storey,
    geometry: { kind: 'slab', position: [o.x, o.y, z], profile: relativeTo(poly, [o.x, o.y]), thickness },
    psets: [{ name: 'Pset_SlabCommon', properties: [{ name: 'IsExternal', value: kind !== 'FLOOR' }, { name: 'LoadBearing', value: true }, { name: 'Thickness', value: thickness }] }],
    quantities: [{ name: 'Qto_SlabBaseQuantities', quantities: [{ name: 'GrossArea', value: round(polygonArea(poly)), kind: 'IfcQuantityArea' }] }],
    material: { name: 'Reinforced concrete slab', category: 'concrete' },
    color: [0.72, 0.72, 0.72],
    patterns,
  };
  b.late.push(e);
  return e;
}

export function liftCarElement(b: ArchBuilder, storey: string, rect: Rect, lift: ElevatorDef): ModelElement {
  const e: ModelElement = {
    id: b.ids.next(storey, 'LIFT'),
    discipline: 'architecture',
    ifcType: 'IfcTransportElement',
    predefinedType: 'ELEVATOR',
    name: 'Passenger lift',
    objectType: 'elevator-car',
    storey,
    geometry: { kind: 'box', position: [rect.x, rect.y, 0], width: rect.w, depth: rect.h, height: 2.3, rotation: 0 },
    psets: [{
      name: 'Pset_TransportElementCommon',
      properties: [
        { name: 'CapacityPeople', value: Math.round(lift.capacityKg / 75) },
        { name: 'CapacityWeight', value: lift.capacityKg },
        { name: 'FireExit', value: false },
      ],
    }],
    color: [0.5, 0.52, 0.55],
    patterns: ['ARC-04'],
  };
  b.late.push(e);
  return e;
}

export function rampElement(b: ArchBuilder, storey: string, rect: Rect, rise: number): ModelElement {
  const e: ModelElement = {
    id: b.ids.next(storey, 'RAMP'),
    discipline: 'architecture',
    ifcType: 'IfcRamp',
    predefinedType: 'STRAIGHT_RUN_RAMP',
    name: 'Parking ramp',
    storey,
    geometry: { kind: 'ramp', position: [rect.x, rect.y, 0], width: rect.w, length: rect.h, thickness: 0.25, rise },
    psets: [{ name: 'Pset_RampCommon', properties: [{ name: 'RequiredSlope', value: round(rise / Math.max(1, rect.h)) }, { name: 'IsExternal', value: false }] }],
    material: { name: 'Reinforced concrete', category: 'concrete' },
    color: [0.68, 0.68, 0.68],
    patterns: ['SIT-06'],
  };
  b.late.push(e);
  return e;
}

export function gableRoofElement(
  b: ArchBuilder, storey: string, rect: Rect, slope: number, ridgeAxis: 'x' | 'y', thickness: number, overhang: number,
): ModelElement {
  const r = rect;
  const e: ModelElement = {
    id: b.ids.next(storey, 'ROOF'),
    discipline: 'architecture',
    ifcType: 'IfcRoof',
    predefinedType: 'GABLE_ROOF',
    name: 'Gable roof',
    objectType: `gable-${ridgeAxis}`,
    storey,
    geometry: { kind: 'gable-roof', position: [r.x, r.y, 0], width: r.w, depth: r.h, thickness, slope, overhang },
    psets: [{
      name: 'Pset_RoofCommon',
      properties: [
        { name: 'IsExternal', value: true },
        { name: 'ProjectedArea', value: round(r.w * r.h) },
        { name: 'ThermalTransmittance', value: 0.13 },
        { name: 'Reference', value: `pitch ${round(slope * 180 / Math.PI, 1)} deg` },
      ],
    }],
    material: { name: 'Concrete tile on battens / sarking / insulated rafters', category: 'roof' },
    color: [0.42, 0.36, 0.34],
    patterns: ['ARC-35'],
  };
  b.late.push(e);
  return e;
}

export function zoneProxyElement(
  b: ArchBuilder, storey: string, rect: Rect, name: string, objectType: string, color: RGB, patterns: string[],
): ModelElement {
  const e: ModelElement = {
    id: b.ids.next(storey, 'ZONE'),
    discipline: 'architecture',
    ifcType: 'IfcBuildingElementProxy',
    predefinedType: 'USERDEFINED',
    name,
    objectType,
    storey,
    geometry: { kind: 'prism', position: [rect.x, rect.y, 0], profile: relativeTo(rectToPolygon(rect), [rect.x, rect.y]), height: 0.05 },
    psets: [{ name: 'Forma_Architecture', properties: [{ name: 'ZoneType', value: objectType }, { name: 'Area', value: round(rect.w * rect.h) }] }],
    color,
    patterns,
  };
  b.late.push(e);
  return e;
}

/** Storey lookup helper shared by the organisers */
export function storeyMap(storeys: StoreyDef[]): Map<string, StoreyDef> {
  return new Map(storeys.map(s => [s.id, s] as const));
}
