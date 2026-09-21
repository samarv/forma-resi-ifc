/**
 * F2 — Coordination kernel contract (frozen).
 *
 * A shared 3D reservation model replaces `coordination.ts`. Per-floor-use ceiling profiles hand every discipline a
 * band (Z extent) and lane (lateral extent with width); shafts are split into disciplinary zones by one allocator;
 * each dwelling column gets one wet-wall chase; penetrations get sleeves. Elements may only be emitted inside a
 * reservation owned by their discipline — conflicts between ordinary reservations are impossible by construction, so
 * the only pairwise test in the kernel is against keep-outs.
 *
 * Coordinates: XY world, Z storey-local (0 = that storey's finished floor). Band depths are measured from the slab
 * soffit DOWNWARD. Erasable TypeScript only.
 */
import type {
  Discipline, FloorUse, RoomType, Rect, Segment2, Vec2, Vec3, ModelElement, ShaftDef, StoreyDef, ArchModel, SiteModel,
  BuildingSpec, StructColumn, StructWall, StructBeam, StructSlab, FoundationElement, BalconyDef,
} from '../types.ts';
import type { Issue, Ledger, RuleSet } from '../rules/types.ts';
import type { StructuralPresize } from '../../disciplines/structure/presize.ts';

/** Axis-aligned box. XY world, Z storey-local. */
export interface Box3 { x: number; y: number; z: number; w: number; d: number; h: number; }

export type ElementKind =
  | 'slab' | 'beam' | 'column' | 'drop-panel' | 'wall' | 'shaft-void'
  | 'duct' | 'duct-fitting' | 'air-terminal' | 'fan' | 'ahu' | 'jet-fan'
  | 'waste' | 'vent' | 'storm' | 'trench-drain' | 'dcw' | 'dhw' | 'hwr' | 'gas'
  | 'sprinkler-main' | 'sprinkler-branch' | 'sprinkler-head' | 'standpipe'
  | 'tray-power' | 'tray-data' | 'conduit' | 'busduct' | 'panel' | 'switchgear'
  | 'light' | 'sensor' | 'ev-charger' | 'pump' | 'tank' | 'sump' | 'ejector' | 'plinth';

export type BandPurpose =
  | 'structure' | 'transfer' | 'sprinkler' | 'duct' | 'service' | 'gravity-drain' | 'pressure-pipe'
  | 'tray' | 'crossing' | 'ceiling-void' | 'ceiling' | 'clear' | 'equipment'
  | 'tenant-plenum' | 'landlord-service' | 'access' | 'exhaust' | 'lighting';

export type BandClass = 'structure' | 'parallel' | 'crossing' | 'void' | 'ceiling' | 'clear' | 'equipment';
export type BandOwner = Discipline | 'shared' | 'none';
/** Where a kind of element lives when it is NOT in the ceiling */
export type Home = 'ceiling' | 'wall' | 'chase' | 'shaft' | 'floor' | 'slab' | 'plinth' | 'exterior';

export interface Band {
  /** 'resi-corridor/service' */
  id: string;
  purpose: BandPurpose;
  cls: BandClass;
  owner: BandOwner;
  /** Distance from the slab soffit down to the TOP of this band (m); resolved by stackProfile */
  topBelowSoffit: number;
  depth: number;
  minDepth: number;
  /** Installation gap kept above / below the band (m) */
  clearanceAbove: number;
  clearanceBelow: number;
  allows: readonly ElementKind[];
  /** 1 = cannot be moved (structure, gravity), 5 = trivially rerouted (conduit). Most flexible is compressed first. */
  flexibility: 1 | 2 | 3 | 4 | 5;
  droppable: boolean;
  /** Depth comes from the structural pre-sizing instead of the constant */
  depthFromPresize?: 'beamDAbove' | 'beamDAboveUnit' | 'transferZoneDepth';
  rationale: string;
  source: string;
}

export interface ResolvedBand extends Band {
  /** Storey-local Z, z0 < z1 */
  z0: number;
  z1: number;
  compressedBy: number;
  dropped: boolean;
}

export type ProfileId =
  | 'resi-unit' | 'resi-corridor' | 'lobby' | 'amenity'
  | 'parking' | 'retail-shell' | 'mep-room' | 'roof-plant' | 'basement-service';

export interface ProfileZone { id: string; minClear: number; source: string; note: string; }

export interface CeilingProfile {
  id: ProfileId;
  label: string;
  appliesTo: { floorUses: readonly FloorUse[]; roomTypes: readonly RoomType[] };
  hasCeiling: boolean;
  clearHeight: { min: number; target: number; source: string };
  /** Sub-zones with a higher requirement (accessible route in a car park, bulkhead over a hall) */
  zones: readonly ProfileZone[];
  /** Ordered from the slab soffit DOWNWARD */
  bands: readonly Band[];
  laneSetId: string | null;
  /** "What stays in the ceiling vs in walls/shafts" as data */
  elsewhere: readonly { kind: ElementKind; home: Home; why: string; source: string }[];
  notes: string;
}

export interface StoreyProfile {
  storey: string;
  profileId: ProfileId;
  floorToFloor: number;
  slabTAbove: number;
  /** f2f - slabTAbove */
  soffitZ: number;
  /** soffitZ - structural depth (beams / transfer zone) */
  structureBottomZ: number;
  ceilingZ: number;
  /** lowest permitted obstruction (clear height) */
  clearZ: number;
  bands: readonly ResolvedBand[];
  band(purpose: BandPurpose): ResolvedBand | null;
  bandById(id: string): ResolvedBand | null;
  zoneClear(zoneId: string): number;
  issues: readonly Issue[];
}

export interface ProfileBook {
  profile(id: ProfileId): CeilingProfile;
  resolve(use: FloorUse | 'site' | 'foundation' | 'roof', roomType?: RoomType): ProfileId;
  all(): readonly CeilingProfile[];
}

export interface StackProfileInput {
  profile: CeilingProfile;
  storey: string;
  floorToFloor: number;
  slabTAbove: number;
  beamDAbove: number;
  beamDAboveUnit: number;
  transferZoneDepth: number;
  ceilingWanted?: number;
  rules: RuleSet;
}
export interface StackProfileResult { resolved: StoreyProfile; raiseFloorToFloorTo: number | null; }

// ---------------------------------------------------------------------------------------------------------------
// Lanes (lateral extents inside a band along a corridor)
// ---------------------------------------------------------------------------------------------------------------

export type LaneVAlign = 'top' | 'middle' | 'bottom';

export interface Lane {
  /** 'duct' | 'sprinkler' | 'gravity' | 'pressure' | 'tray-power' | 'tray-data' */
  id: string;
  owner: Discipline;
  bandPurpose: BandPurpose;
  /** Lateral offset of the lane CENTRE from the corridor centreline (+ = toward CorridorSpine.loaded 'left') */
  offset: number;
  /** Full lateral width of the lane (m). Reservations must fit inside. */
  width: number;
  minWidth: number;
  /** Vertical extent the lane claims inside its band */
  height: number;
  vAlign: LaneVAlign;
  allows: readonly ElementKind[];
  /** Systems in canonical claim order, so allocation is call-order independent */
  systemOrder: readonly string[];
  source: string;
}

export interface LaneSet {
  id: string;
  lanes: readonly Lane[];
  /** 2 × max(|offset| + width/2); corridor must be at least this wide */
  requiredCorridorWidth: number;
  /** Lane that drops into the crossing band when the corridor is narrower */
  overflowLaneId: string | null;
}

export interface LateralSpan { a: number; b: number; centre: number; }

// ---------------------------------------------------------------------------------------------------------------
// Shafts, chases, sleeves
// ---------------------------------------------------------------------------------------------------------------

export type ShaftSystem =
  | 'air-supply' | 'air-exhaust' | 'air-outdoor' | 'kitchen-exhaust' | 'dryer-exhaust'
  | 'refrigerant' | 'hydronic' | 'stair-pressurisation'
  | 'waste' | 'vent' | 'dcw' | 'dhw' | 'hwr' | 'storm' | 'sprinkler' | 'standpipe' | 'gas'
  | 'power' | 'data' | 'life-safety' | 'trash';

export type ShaftZone = 'plumbing' | 'mechanical' | 'electrical' | 'trash';

/** THE canonical order. Slot position is a pure function of this + the shaft rect — never of call order. */
export const SHAFT_SYSTEM_ORDER: readonly ShaftSystem[] = [
  'waste', 'vent', 'storm', 'dcw', 'dhw', 'hwr', 'sprinkler', 'standpipe', 'gas',
  'air-supply', 'air-exhaust', 'air-outdoor', 'kitchen-exhaust', 'dryer-exhaust', 'refrigerant', 'hydronic', 'stair-pressurisation',
  'power', 'life-safety', 'data',
  'trash',
];

export const SHAFT_ZONE_OF: Readonly<Record<ShaftSystem, ShaftZone>> = {
  'waste': 'plumbing', 'vent': 'plumbing', 'storm': 'plumbing', 'dcw': 'plumbing', 'dhw': 'plumbing', 'hwr': 'plumbing',
  'sprinkler': 'plumbing', 'standpipe': 'plumbing', 'gas': 'plumbing',
  'air-supply': 'mechanical', 'air-exhaust': 'mechanical', 'air-outdoor': 'mechanical', 'kitchen-exhaust': 'mechanical',
  'dryer-exhaust': 'mechanical', 'refrigerant': 'mechanical', 'hydronic': 'mechanical', 'stair-pressurisation': 'mechanical',
  'power': 'electrical', 'data': 'electrical', 'life-safety': 'electrical',
  'trash': 'trash',
};

export interface ShaftSlotRequest {
  shaftId: string;
  discipline: Discipline;
  system: ShaftSystem;
  /** Footprint needed; round systems pass w = d = OD + 2 × insulation */
  w: number;
  d: number;
  /** Riser wants a shaft wall to hang off (NEC 392.30 / IPC 308.5 vertical support) */
  wantWall?: boolean;
  storeys: readonly string[];
}

export interface ShaftSlot {
  shaftId: string;
  discipline: Discipline;
  system: ShaftSystem;
  /** Slot CENTRE and reserved footprint */
  xy: Vec2;
  w: number;
  d: number;
  zone: ShaftZone;
  storeys: readonly string[];
  reservationId: string;
}

export interface ShaftAllocator {
  /** Registers a shaft (from ArchModel.shafts, or synthesised from a CoreDef) */
  register(shaft: ShaftDef): void;
  slot(req: ShaftSlotRequest): ShaftSlot | Conflict;
  slotsOf(shaftId: string): readonly ShaftSlot[];
  utilisation(shaftId: string): number;
  /** Shaft of the right purpose nearest `p` that has room for `req` */
  nearestWithRoom(p: Vec2, req: Omit<ShaftSlotRequest, 'shaftId'>): string | null;
}

export interface ChaseRequest {
  unitId: string;
  storeys: readonly string[];
  wallId: string;
  wall: Segment2;
  wallThickness: number;
  /** Station along the wall where the module's wet-wall PORT sits */
  station: number;
  systems: readonly ShaftSystem[];
}

export interface Chase {
  id: string;
  unitId: string;
  wallId: string;
  /** Chase centre on the wall centreline */
  xy: Vec2;
  dir: Vec2;
  /** Along the wall / across the wall (m) */
  length: number;
  thickness: number;
  storeys: readonly string[];
  /** Waste at the centre (it governs the trap arms), the rest alternating ± in SHAFT_SYSTEM_ORDER */
  systemXY: Map<ShaftSystem, Vec2>;
  systemD: Map<ShaftSystem, number>;
  reservationIds: readonly string[];
}

export interface SleeveRequest {
  storey: string;
  hostKind: 'wall' | 'slab';
  hostId: string;
  at: Vec2;
  z: number;
  outsideDiameter: number;
  system: ShaftSystem;
  /** Fire rating of the host; drives the firestop spec */
  rating?: string;
}

export interface Sleeve {
  id: string;
  storey: string;
  hostKind: 'wall' | 'slab';
  hostId: string;
  xy: Vec2;
  z: number;
  outsideDiameter: number;
  /** OD + 2 × annulus (0.025 m) rounded up to the nominal sleeve size */
  sleeveDiameter: number;
  rating: string;
  firestop: string;
  reservationId: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Reservations
// ---------------------------------------------------------------------------------------------------------------

export type Container = 'band' | 'shaft' | 'chase' | 'wall' | 'floor' | 'plinth' | 'exterior' | 'keepout';

export interface Reservation {
  /** 'RSV-0001', deterministic sequence */
  id: string;
  owner: Discipline;
  kind: ElementKind;
  purpose: BandPurpose;
  storey: string;
  container: Container;
  /** bandId / shaftId / chaseId / wallId */
  containerId: string | null;
  boxes: readonly Box3[];
  /** Offsets the resolver applied, in metres */
  shift: { lateral: number; along: number; vertical: number };
  /** Keep-outs only: listed kinds are banned inside the boxes */
  bans?: readonly ElementKind[];
  note?: string;
}

export type ConflictReason =
  | 'no-band' | 'outside-band' | 'kind-not-allowed' | 'band-full' | 'lane-full'
  | 'shaft-full' | 'no-shaft' | 'no-chase' | 'keepout' | 'unsupported';

export interface Conflict {
  kind: 'conflict';
  reason: ConflictReason;
  with: readonly string[];
  message: string;
  ruleId: string;
  suggestion?: readonly Box3[];
}
export type ReserveResult = Reservation | Conflict;

export interface ReserveRequest {
  owner: Discipline;
  kind: ElementKind;
  storey: string;
  container: Container;
  containerId?: string;
  boxes: readonly Box3[];
  purpose?: BandPurpose;
  roomType?: RoomType;
  bans?: readonly ElementKind[];
  note?: string;
}

export interface LaneRunRequest {
  owner: Discipline;
  kind: ElementKind;
  storey: string;
  laneId: string;
  centerline: readonly Segment2[];
  /** Section needed; the allocator returns the width/height it could actually give */
  width: number;
  height: number;
  systemKey: string;
  name?: string;
}
export interface LaneRun {
  path: Vec3[];
  width: number;
  height: number;
  lane: Lane;
  band: ResolvedBand;
  reservation: Reservation;
}

export interface CrossingRequest {
  owner: Discipline;
  kind: ElementKind;
  storey: string;
  centerline: readonly Segment2[];
  /** Arc-length station where the branch wants to cross */
  station: number;
  length: number;
  width: number;
  height: number;
  systemKey: string;
  /** Controlled fall permitted for gravity legs */
  slope?: number;
}
export interface Crossing { path: Vec3[]; z: number; shiftedBy: number; reservation: Reservation; }

export interface RiserRequest {
  owner: Discipline;
  kind: ElementKind;
  system: ShaftSystem;
  shaftId?: string;
  near?: Vec2;
  storeys: readonly string[];
  w: number;
  d: number;
}
export interface Riser { slot: ShaftSlot; reservation: Reservation; }

export interface KeepOutRequest {
  owner: Discipline;
  kind: ElementKind;
  storey: string;
  boxes: readonly Box3[];
  bans: readonly ElementKind[];
  note: string;
}

export interface KernelOptions {
  storeys: readonly StoreyDef[];
  presize: StructuralPresize;
  profiles: ProfileBook;
  rules: RuleSet;
  ledger: Ledger;
  arch: ArchModel | null;
  site: SiteModel;
}

export interface Kernel {
  profileOf(storey: string, roomType?: RoomType): StoreyProfile;
  laneSetOf(storey: string): LaneSet;
  laneOf(storey: string, laneId: string): Lane | null;

  reserve(req: ReserveRequest): ReserveResult;
  reserveLaneRun(req: LaneRunRequest): LaneRun | Conflict;
  reserveCrossing(req: CrossingRequest): Crossing | Conflict;
  reserveRiser(req: RiserRequest): Riser | Conflict;

  shafts: ShaftAllocator;
  chase(req: ChaseRequest): Chase | Conflict;
  chaseOf(unitId: string): Chase | null;
  sleeve(req: SleeveRequest): Sleeve | Conflict;

  /** Structure detailing registers its keep-outs here before MEP runs */
  keepOut(o: KeepOutRequest): Reservation;

  reservations(): readonly Reservation[];
  reservationsOn(storey: string, owner?: Discipline): readonly Reservation[];
  /** Post-check: every MEP element lies inside a reservation of its own discipline and inside its band */
  validate(elements: readonly ModelElement[]): Issue[];
  derived(): Record<string, number>;
}

export function isConflict(r: unknown): r is Conflict {
  return typeof r === 'object' && r !== null && (r as { kind?: unknown }).kind === 'conflict';
}

// ---------------------------------------------------------------------------------------------------------------
// Gravity horizon (plumbing invert model) and structural supports (load path) — cross-discipline concepts
// ---------------------------------------------------------------------------------------------------------------

export interface InvertModel {
  /** Sewer connection invert in SITE datum (m, negative) */
  sewerInvertSite: number;
  /** Downstream invert of each storey's building drain, storey-local */
  drainInvertZ: Map<string, number>;
  groundStorey: string;
  slopeFor(diameter: number): number;
  maxSlope: number;
  /** True when a waste invert at this storey-local z can reach the sewer by gravity */
  gravity(storey: string, z: number): boolean;
  pumpedStoreys: readonly string[];
  /** Where each pumped level's sump sits (set by plumbing, read by the discharge router) */
  sumpXY: Map<string, Vec2>;
  issues: readonly Issue[];
}

export interface Support {
  id: string;
  kind: 'column' | 'wall' | 'transfer-beam' | 'foundation';
  storey: string;
  storeyIndex: number;
  xy: Vec2;
  footprint: Rect;
  /** Walls carry a line, not a point */
  line?: Segment2;
}

export interface LoadPathInput {
  storeysAscending: readonly StoreyDef[];
  columns: readonly StructColumn[];
  walls: readonly StructWall[];
  beams: readonly StructBeam[];
  slabs: readonly StructSlab[];
  foundations: readonly FoundationElement[];
  balconies: readonly BalconyDef[];
  presize: StructuralPresize;
  rules: RuleSet;
  ledger: Ledger;
}

export interface LoadPathNode { support: Support; carriedBy: string | null; via: 'column' | 'wall' | 'transfer' | 'foundation' | null; }
export interface LoadPathResult {
  nodes: readonly LoadPathNode[];
  /** Lowest supports that need a foundation */
  bases: readonly Support[];
  issues: readonly Issue[];
  derived: Record<string, number>;
}

/** Element kind → default band purpose (used when a reserve request does not name one) */
export type PurposeOfKind = Readonly<Partial<Record<ElementKind, BandPurpose>>>;

export type BuildingSpecRef = BuildingSpec;
