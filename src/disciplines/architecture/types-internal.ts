/**
 * Internal types shared between the architecture organisers (not part of the cross-discipline
 * contract in core/types.ts).
 */
import type {
  FloorSpec, FloorUse, Polygon, Rect, Side, StoreyDef, UnitTemplateId, WallType,
} from '../../core/types.ts';
import type { BarFrame, Interval } from './bar-frame.ts';

/** Everything the organisers need to know about one storey */
export interface FloorCtx {
  storey: StoreyDef;
  storeyId: string;
  spec: FloorSpec | null;
  use: FloorUse;
  /** Floor outline (CCW, world XY) for this storey */
  outline: Polygon;
  /** Bars that exist on this storey, already clipped to the outline */
  bars: BarFrame[];
  floorToFloor: number;
  ceilingHeight: number;
  /** Wall height = floorToFloor − slabThickness (walls stop under the slab above) */
  wallHeight: number;
  slabThickness: number;
  wwr: number;
  balconies: boolean;
  targetUnits?: number;
  unitMix: Partial<Record<UnitTemplateId, number>>;
  isGround: boolean;
  isResidential: boolean;
}

export interface SideWallSpec {
  type: WallType;
  thickness: number;
  /** Extend the wall by this much beyond each end of the boundary edge (to close corners) */
  extendStart?: number;
  extendEnd?: number;
}

/** One dwelling slot in an abstract (storey-independent) floor layout */
export interface UnitSlot {
  index: number;
  templateId: UnitTemplateId;
  /** Boundary rect: edges lie on the CENTRELINES of the bounding walls */
  boundary: Rect;
  accessSide: Side;
  exteriorSides: Side[];
  sides: Record<Side, SideWallSpec>;
  barId: string;
  coreId?: string;
  /** Distance along the wet-wall side at which the plumbing stack must sit (vertical alignment) */
  stackAlong: number;
  /** Multi-level house: identical internal stair footprint on every level */
  stairRect?: Rect;
  /** Storeys this slot spans (multi-level units); undefined = the storey it is instantiated on */
  storeySpan?: string[];
  /** Extra doors the organiser must cut into a boundary wall (garage doors, private stair doors) */
  extraDoors?: { side: Side; width: number; height: number; type: 'garage' | 'building-entry' | 'exit'; offset?: number }[];
  notes?: string;
}

export interface CommonRoomSlot {
  rect: Rect;
  type: import('../../core/types.ts').RoomType;
  name?: string;
  /** Sides of `rect` that lie on the building envelope (get exterior walls + windows) */
  exteriorSides: Side[];
  /** Window sill/height override (shopfronts) */
  glazing?: { sill: number; height: number; wwr?: number };
  /** Enclose with walls on these sides (default: partition on every non-exterior side) */
  sides?: Partial<Record<Side, SideWallSpec>>;
  /** Interior door to the corridor / lobby */
  accessSide?: Side;
  doorWidth?: number;
  /** Door in the exterior wall (main building entrance, service door, shopfront entrance) */
  entrance?: { side: Side; width: number; type: 'building-entry' | 'service' | 'garage'; at?: number };
  /** Skip enclosing walls (large open plates: parking, retail shells) */
  open?: boolean;
  priority?: number;
}

export interface CorridorSlot {
  rect: Rect;
  barId: string;
  spineId: string;
  width: number;
  /** across-normal sides that carry the corridor wall */
  wallSides: Side[];
  /** true when the deck is outside the envelope (gallery access) */
  external: boolean;
  /** along-ends that reach an exterior face and can be daylit */
  daylitEnds: Side[];
  /** for an external deck: the side of `rect` that needs the railing */
  outerSide?: Side;
}

/** An abstract floor layout, computed once per (use, outline, mix) and replicated per storey (ARC-08) */
export interface FloorLayout {
  key: string;
  units: UnitSlot[];
  corridors: CorridorSlot[];
  commons: CommonRoomSlot[];
  /** along-intervals consumed by cores/shafts per bar, for reporting */
  blocked: Record<string, Interval[]>;
  remnantArea: number;
}
