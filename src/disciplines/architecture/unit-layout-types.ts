/**
 * Interface between the two halves of the architecture discipline:
 *  - `templates.ts` + `unit-layout.ts` (floor-plan templates, room layout engine, furniture) implement `layoutUnit`.
 *  - `index.ts` (floor organizer: massing → cores, corridors, unit packing, common rooms, roof) calls it.
 *
 * The organizer owns every wall SHARED between two units or between a unit and the outside/corridor
 * (party, corridor, exterior, core walls). The layout engine owns everything INSIDE the unit rect:
 * partitions, wet walls, interior doors, furniture — and it places the unit entry door and the
 * windows into the boundary walls it is handed (referencing their ids).
 */
import type {
  Rect, Side, Compass, Region, UnitTemplateDef, RoomDef, WallDef, DoorDef, WindowDef, FurnitureDef,
  PatternApplication, Rng, GenerationOptions,
} from '../../core/types.ts';

/** Boundary walls of the unit rect, keyed by the side of the rect they lie on (wall centreline is outside the NET rect by thickness/2). */
export interface UnitBoundaryWalls {
  front?: WallDef;
  rear?: WallDef;
  left?: WallDef;
  right?: WallDef;
}

export interface UnitLayoutRequest {
  unitId: string;
  template: UnitTemplateDef;
  /** NET unit footprint on this storey: inside faces of the boundary walls */
  rect: Rect;
  storey: string;
  /** Multi-storey units: 0 = entry level, 1 = first upper level, … The organizer calls layoutUnit once per level with the same unitId. */
  level: number;
  levelsTotal: number;
  /** Side of `rect` the access (corridor / street / gallery / landing) is on. The entry door goes in boundaryWalls[accessSide]. */
  accessSide: Side;
  /** Sides of `rect` that are exterior walls (windows possible) */
  exteriorSides: Side[];
  /** Compass exposure of each exterior side's outside face */
  exposures: Partial<Record<Side, Compass>>;
  boundaryWalls: UnitBoundaryWalls;
  floorToFloor: number;
  ceilingHeight: number;
  /** Window-to-wall ratio target for this unit's exterior walls */
  wwr: number;
  /** Balcony attached on the given side (outside the rect); the layout must place a balcony door and a 'balcony' RoomDef with rect outside `rect` */
  balcony: { side: Side; depth: number } | null;
  region: Region;
  options: GenerationOptions;
  rng: Rng;
  /**
   * Side on which the wet wall (kitchen + bathrooms back-to-back) must sit — normally the accessSide
   * (pattern XD-01 / ARC-14) so stacks and shafts stay next to the corridor.
   */
  wetWallSide: Side;
  /**
   * Distance along the wet-wall side (from rect.x when the side is front/rear, from rect.y when left/right)
   * where the plumbing stack must be, so that identical units stack vertically. Optional.
   */
  stackAlong?: number;
  /** Fixed internal stair footprint for multi-storey units (identical on every level) */
  stairRect?: Rect;
}

export interface UnitLayout {
  rooms: RoomDef[];
  /** Interior walls only (partitions, wet walls). Boundary walls belong to the organizer. */
  walls: WallDef[];
  /** All doors, including the unit entry door hosted in boundaryWalls[accessSide] */
  doors: DoorDef[];
  /** Windows hosted in exterior boundary walls */
  windows: WindowDef[];
  furniture: FurnitureDef[];
  entryDoorId: string;
  wetWallIds: string[];
  kitchenRoomId?: string;
  bathroomRoomIds: string[];
  balconyRoomId?: string;
  /** Internal stair for multi-storey units (nose of first tread at position, treads along direction) */
  stair?: { rect: Rect; position: [number, number]; direction: number; risers: number; riserHeight: number; tread: number; width: number };
  patterns: PatternApplication[];
  warnings: string[];
}

export type UnitLayoutFn = (req: UnitLayoutRequest) => UnitLayout;
