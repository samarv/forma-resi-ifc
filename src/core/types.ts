/**
 * forma-resi-ifc — shared contract between all discipline agents.
 *
 * COORDINATE CONVENTIONS (read before writing any geometry)
 * - Units: metres and radians everywhere in the model. Display conversion happens only in the UI.
 * - World frame: origin at the site's front-left corner. +X runs along the street frontage
 *   (left → right when standing on the street looking at the site). +Y runs from the street
 *   into the site (front → rear). +Z is up. The street edge is the y = 0 edge of the site.
 * - Storey-relative Z: every ModelElement carries a `storey` id and its geometry Z values are
 *   measured from THAT storey's finished floor level (z = 0 is the top of the structural slab
 *   of that storey, i.e. the level the storey's `elevation` refers to). The IFC writer never
 *   adds elevations itself — the vendored IfcCreator applies `StoreyDef.elevation` once via the
 *   storey placement. XY is always world XY (storeys are never translated in plan).
 * - Special storeys: 'SITE' (elevation 0, site works and landscape), 'FND' (foundations, negative
 *   elevation), 'ROOF' (top of roof slab), 'B1'.. for basements, 'L01'.. for above-grade floors.
 * - Polygons are simple, counter-clockwise, NOT closed (first point is not repeated).
 * - Rect = axis-aligned {x, y, w, h} with (x, y) the MIN corner.
 * - Walls: start/end define the centreline in plan; thickness is centred on it.
 * - Ids are deterministic strings (see core/ids.ts). Never use Math.random — use core/rng.ts.
 */

// ============================================================================
// Primitives
// ============================================================================

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
/** RGB in 0..1 */
export type RGB = [number, number, number];

/** Axis-aligned rectangle, min corner + size */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Simple CCW polygon, not closed */
export type Polygon = Vec2[];

export interface Segment2 {
  a: Vec2;
  b: Vec2;
}

export type Compass = 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW';
/** Site sides: front = street side (y = 0 edge), rear = y = depth edge, left = x = 0 edge, right = x = width edge */
export type Side = 'front' | 'rear' | 'left' | 'right';

// ============================================================================
// Disciplines, regions
// ============================================================================

export type Discipline = 'site' | 'architecture' | 'structure' | 'mechanical' | 'plumbing' | 'electrical';

/** English-speaking design regions; drive terminology, code presets and defaults */
export type Region = 'US' | 'UK' | 'CA' | 'AU' | 'NZ' | 'IE';

// ============================================================================
// Typologies (building types)
// ============================================================================

export type TypologyId =
  | 'detached-house'      // single-family detached / freestanding house
  | 'adu-laneway'         // accessory dwelling unit / laneway house / granny flat
  | 'semi-detached'       // semi-detached / side-by-side duplex
  | 'townhouse-row'       // terraced houses / rowhouses / townhomes
  | 'stacked-townhouse'   // triple-decker / stacked flats / Tyneside flats / maisonettes over flats
  | 'garden-walkup'       // low-rise walk-up, garden apartments, small stair cores, no lift
  | 'mansion-block'       // pre-war apartment / mansion block: 2 large units per landing per core
  | 'corridor-midrise'    // double-loaded corridor mid-rise (5-over-1, block of flats)
  | 'deck-access'         // single-loaded / gallery / deck access
  | 'courtyard-block'     // perimeter block around a shared courtyard
  | 'point-tower'         // point block: compact central core, 4–8 units per floor
  | 'slab-tower'          // high-rise double-loaded slab
  | 'podium-tower'        // retail/parking/amenity podium with residential tower
  | 'coliving-cluster'    // co-living / student cluster flats
  | 'senior-living'       // independent / assisted living
  | 'mixed-use-midrise';  // ground-floor retail with residential above, corridor access

export type AccessType =
  | 'direct'           // each dwelling has its own front door to the street/garden
  | 'stair-core'       // small stair core serving 2–4 units per landing, no corridor
  | 'corridor-double'  // units on both sides of an internal corridor
  | 'corridor-single'  // units on one side of an internal corridor
  | 'gallery'          // external deck / gallery access
  | 'point-core'       // units arranged around a compact central core
  | 'cluster';         // shared entrance to a cluster of private rooms + shared living

export type FootprintShape = 'bar' | 'L' | 'U' | 'O' | 'point' | 'T';
export type ParkingType = 'none' | 'surface' | 'garage-attached' | 'podium' | 'underground';
export type RoofType = 'flat' | 'gable' | 'hip';

export type StructuralSystemId =
  | 'light-wood-frame'     // platform frame, bearing walls (US/CA/AU/NZ houses and low-rise)
  | 'masonry-bearing'      // load-bearing cavity masonry (UK/IE houses)
  | 'mass-timber-clt'      // CLT panels + glulam
  | 'wood-over-podium'     // 4–5 storeys wood over RC podium ("5-over-1")
  | 'rc-flat-slab'         // RC columns + flat slab, RC core
  | 'rc-flat-plate-core'   // high-rise RC flat plate + shear-wall core
  | 'steel-frame';         // steel columns/beams + composite deck

export type FoundationType = 'slab-on-grade' | 'strip-footing' | 'pad-footing' | 'raft' | 'piles';

export type HvacSystemId =
  | 'ducted-heat-pump'     // per-unit ducted air-source heat pump (US/CA)
  | 'ductless-mini-split'  // per-room wall cassettes (AU/NZ/US)
  | 'ptac'                 // packaged terminal units under windows
  | 'vrf'                  // variable refrigerant flow, central condensers, per-unit indoor units
  | 'mvhr-radiators'       // MVHR ventilation + wet radiators from heat network (UK/IE)
  | 'central-ahu-fan-coil';// central plant, fan coils per unit, corridor DOAS

export type DhwSystemId = 'per-unit-tank' | 'per-unit-tankless' | 'central-plant' | 'heat-network';

export type VentilationStrategy = 'mvhr-per-unit' | 'erv-per-unit' | 'exhaust-only' | 'central-doas';

export interface TypologyDef {
  id: TypologyId;
  name: string;
  regionalNames: Partial<Record<Region, string>>;
  description: string;
  access: AccessType;
  footprintShapes: FootprintShape[];
  storeys: { min: number; max: number; default: number };
  /** Floor-to-floor heights in metres */
  floorToFloor: { typical: number; ground: number };
  /** Depth of a bar (external face to external face) in metres */
  buildingDepth: { min: number; max: number; default: number };
  /** Units per floor per bar (corridor types) or per core landing (stair/point cores) */
  unitsPerFloor: { min: number; max: number };
  unitsPerCore?: number;
  corridorWidth?: number;
  defaultUnitMix: Partial<Record<UnitTemplateId, number>>;
  parking: ParkingType;
  /** Car spaces per dwelling */
  parkingRatio: number;
  /** Bicycle spaces per dwelling */
  bikeRatio: number;
  setbacks: { front: number; side: number; rear: number };
  structure: StructuralSystemId;
  foundation: FoundationType;
  hvac: HvacSystemId;
  ventilation: VentilationStrategy;
  dhw: DhwSystemId;
  sprinklered: boolean;
  elevator: boolean;
  /** Typical dwellings per hectare */
  density: { min: number; max: number };
  /** Ids of patterns fundamental to this typology (see core/patterns.ts) */
  patterns: string[];
}

// ============================================================================
// Unit (floor-plan) templates
// ============================================================================

export type UnitTemplateId =
  | 'studio'
  | 'micro-studio'
  | 'junior-1b'
  | '1b1b'
  | '1b-den'
  | '2b1b'
  | '2b2b'
  | '3b2b'
  | '4b2b'
  | 'dual-key'
  | 'corner-2b2b'
  | 'loft-live-work'
  | 'maisonette-2s'
  | 'townhouse-2s'
  | 'townhouse-3s'
  | 'ranch-3b'
  | 'colonial-4b'
  | 'adu-1b'
  | 'coliving-cluster'
  | 'senior-1b-accessible';

export type RoomType =
  | 'living' | 'dining' | 'kitchen' | 'living-kitchen' | 'bedroom' | 'master-bedroom' | 'bathroom' | 'ensuite'
  | 'powder' | 'wc' | 'hall' | 'entry' | 'closet' | 'walk-in-closet' | 'laundry' | 'utility' | 'storage'
  | 'study' | 'den' | 'balcony' | 'terrace' | 'garage' | 'stair' | 'corridor' | 'lobby' | 'lift-lobby'
  | 'elevator' | 'shaft' | 'mech-room' | 'elec-room' | 'water-room' | 'trash' | 'bike-store' | 'mail'
  | 'amenity' | 'gym' | 'lounge' | 'retail' | 'parking' | 'plant' | 'roof' | 'courtyard' | 'landscape'
  | 'shared-kitchen' | 'shared-living' | 'dining-hall' | 'flex' | 'porch' | 'basement';

export type Zone = 'public' | 'private' | 'service' | 'circulation' | 'outdoor';

export interface RoomProgram {
  type: RoomType;
  count: number;
  /** Target and minimum net floor area (m²) */
  targetArea: number;
  minArea: number;
  /** Minimum clear width (m) */
  minWidth: number;
  /** Needs an exterior wall (window) */
  needsExterior: boolean;
  /** Is a wet room (plumbing fixtures, backs onto the wet wall) */
  wet: boolean;
  zone: Zone;
  /** Preferred position relative to the unit entry: 'front' = near entry / corridor side, 'back' = far exterior side */
  prefer: 'front' | 'back' | 'either';
}

export interface UnitTemplateDef {
  id: UnitTemplateId;
  name: string;
  regionalNames: Partial<Record<Region, string>>;
  description: string;
  bedrooms: number;
  bathrooms: number;
  /** Design occupancy (bedspaces) */
  occupants: number;
  /** Net internal area (m²) */
  area: { min: number; target: number; max: number };
  /** Width along the access side (corridor / street) in metres */
  frontage: { min: number; max: number };
  /** Depth perpendicular to the access side in metres */
  depth: { min: number; max: number };
  storeysInUnit: 1 | 2 | 3;
  aspect: 'single' | 'dual' | 'corner';
  rooms: RoomProgram[];
  suitableTypologies: TypologyId[];
  patterns: string[];
}

// ============================================================================
// Input specification (what the human selects)
// ============================================================================

export type FloorUse =
  | 'residential' | 'lobby-residential' | 'retail' | 'parking' | 'amenity' | 'mechanical' | 'roof' | 'basement';

export interface SiteSpec {
  /** Street frontage along +X (m) */
  width: number;
  /** Depth from street into the site along +Y (m) */
  depth: number;
  /** Compass direction the street (front) faces, i.e. the direction from the building toward the street */
  streetFacing: Compass;
  context: 'urban' | 'suburban' | 'rural';
  /** Overrides of typology setback defaults (m) */
  setbacks?: Partial<{ front: number; side: number; rear: number }>;
  slopePercent?: number;
  /** Zoning limits, reported as metric compliance */
  maxHeight?: number;
  maxFar?: number;
  maxCoverage?: number;
  parking?: { type?: ParkingType; ratio?: number; evShare?: number; bikeRatio?: number };
}

export interface MassingSpec {
  storeys: number;
  footprintShape?: FootprintShape;
  /** Bar depth, external face to external face (m) */
  buildingDepth?: number;
  /** Bar length along the frontage (m); default fills the buildable width */
  buildingLength?: number;
  floorToFloor?: number;
  groundFloorToFloor?: number;
  podiumStoreys?: number;
  podiumUse?: 'retail' | 'parking' | 'amenity';
  basementStoreys?: number;
  corridorWidth?: number;
  coreCount?: number;
  roof: RoofType;
  roofPitchDeg?: number;
  parapetHeight?: number;
  balconyDepth?: number;
}

export interface FloorSpec {
  /** 0 = ground floor (US Level 1 / UK Ground). Negative = basements. */
  index: number;
  name?: string;
  use: FloorUse;
  floorToFloor?: number;
  ceilingHeight?: number;
  unitMix?: Partial<Record<UnitTemplateId, number>>;
  targetUnits?: number;
  balconies?: boolean;
  /** Step this floor's rear face back by this many metres relative to the floor below */
  setbackFromBelow?: number;
  /** Window-to-wall ratio target (0.2–0.6) */
  wwr?: number;
}

export interface GenerationOptions {
  furniture: boolean;
  site: boolean;
  structure: boolean;
  mechanical: boolean;
  plumbing: boolean;
  electrical: boolean;
  /** Controls element density (e.g. 'low' places one receptacle per room, 'high' applies full spacing rules) */
  detail: 'low' | 'medium' | 'high';
  ifcSchema: 'IFC2X3' | 'IFC4' | 'IFC4X3';
}

export interface BuildingSpec {
  name: string;
  seed: number;
  region: Region;
  displayUnits: 'metric' | 'imperial';
  typology: TypologyId;
  site: SiteSpec;
  massing: MassingSpec;
  /** Per-floor overrides; floors not listed are generated from massing + typology defaults */
  floors: FloorSpec[];
  /** Building-wide unit mix weights; overrides typology default */
  unitMix?: Partial<Record<UnitTemplateId, number>>;
  options: GenerationOptions;
}

// ============================================================================
// Storeys
// ============================================================================

export interface StoreyDef {
  /** 'SITE' | 'FND' | 'B1'.. | 'L01'.. | 'ROOF' */
  id: string;
  name: string;
  /** 0 = ground; negative = basement; FND/SITE/ROOF use -100/-101/100 respectively for sorting */
  index: number;
  /** Elevation of finished floor level above site datum (m) */
  elevation: number;
  /** Floor-to-floor height (m); for ROOF the parapet height; for SITE 0 */
  height: number;
  use: FloorUse | 'site' | 'foundation';
}

// ============================================================================
// Universal model element (what the IFC writer and the 2D/3D renderers consume)
// ============================================================================

export interface RectangularOpeningDef {
  name?: string;
  width: number;
  height: number;
  /** Position relative to host: walls [along, 0, sill]; slabs [x, y, 0] relative to slab position */
  position: Vec3;
}

export type ElementGeometry =
  /** Wall centreline start/end (storey-local Z), thickness centred, extruded up by height */
  | { kind: 'wall'; start: Vec3; end: Vec3; thickness: number; height: number; openings?: RectangularOpeningDef[] }
  /** Slab: profile points are RELATIVE to position; extruded +Z by thickness from position.z */
  | { kind: 'slab'; position: Vec3; profile: Vec2[]; thickness: number; openings?: RectangularOpeningDef[] }
  /** Column: position is base centre */
  | { kind: 'column'; position: Vec3; width: number; depth: number; height: number; shape?: 'rect' | 'circle' }
  /** Beam/member: axis start→end, section width × height centred on axis */
  | { kind: 'beam'; start: Vec3; end: Vec3; width: number; height: number }
  /** Box: min corner at position, rotated about position by rotation (radians) — furniture, equipment, panels */
  | { kind: 'box'; position: Vec3; width: number; depth: number; height: number; rotation?: number }
  /** Prism: arbitrary footprint (points RELATIVE to position) extruded by height — spaces, zones, pads, courtyards */
  | { kind: 'prism'; position: Vec3; profile: Vec2[]; height: number }
  /** Axis element: pipe/duct/tray/conduit from start to end with a round or rectangular section */
  | { kind: 'axis'; start: Vec3; end: Vec3; profile: { type: 'circle'; radius: number } | { type: 'rect'; width: number; height: number } }
  /** Straight stair run: position = nose of first tread, treads run along direction (radians) */
  | { kind: 'stair'; position: Vec3; direction: number; risers: number; riserHeight: number; tread: number; width: number }
  /** Door hosted in a wall element: along = distance from wall start to door centre */
  | { kind: 'door-in-wall'; hostId: string; along: number; width: number; height: number; operation?: string }
  /** Window hosted in a wall element */
  | { kind: 'window-in-wall'; hostId: string; along: number; sill: number; width: number; height: number }
  /** Footing: position is TOP centre; extends downward by height */
  | { kind: 'footing'; position: Vec3; width: number; depth: number; height: number; footingType: 'STRIP_FOOTING' | 'PAD_FOOTING' | 'PILE_CAP' }
  /** Pile: position is top centre; extends downward by length */
  | { kind: 'pile'; position: Vec3; diameter: number; length: number }
  /** Flat roof slab or mono-pitch: position = min corner */
  | { kind: 'roof'; position: Vec3; width: number; depth: number; thickness: number; slope?: number }
  /** Gable roof over a rectangle: position = min corner at eaves level */
  | { kind: 'gable-roof'; position: Vec3; width: number; depth: number; thickness: number; slope: number; overhang?: number }
  | { kind: 'railing'; start: Vec3; end: Vec3; height: number; width?: number }
  | { kind: 'ramp'; position: Vec3; width: number; length: number; thickness: number; rise: number };

export interface PropertyDef {
  name: string;
  value: string | number | boolean;
}

export interface PropertySetDef {
  name: string;
  properties: PropertyDef[];
}

export type QuantityKind = 'IfcQuantityLength' | 'IfcQuantityArea' | 'IfcQuantityVolume' | 'IfcQuantityCount' | 'IfcQuantityWeight';

export interface QuantityDef {
  name: string;
  value: number;
  kind: QuantityKind;
}

export interface QuantitySetDef {
  name: string;
  quantities: QuantityDef[];
}

export interface MaterialDef {
  name: string;
  category?: string;
  layers?: { name: string; thickness: number; category?: string }[];
}

/**
 * The universal element. Every discipline emits these; the IFC writer maps them 1:1 to IfcCreator calls.
 * `ifcType` is the IFC entity name in PascalCase (e.g. 'IfcWall', 'IfcPipeSegment', 'IfcLightFixture').
 */
export interface ModelElement {
  id: string;
  discipline: Discipline;
  ifcType: string;
  predefinedType?: string;
  name: string;
  objectType?: string;
  description?: string;
  storey: string;
  geometry: ElementGeometry;
  psets?: PropertySetDef[];
  quantities?: QuantitySetDef[];
  material?: MaterialDef;
  color?: RGB;
  /** MEP system id (grouped into IfcDistributionSystem / IfcSystem by the writer) */
  system?: string;
  /** Unit (dwelling) id → grouped into an IfcZone by the writer */
  unitId?: string;
  roomId?: string;
  /** Pattern ids that produced or constrained this element */
  patterns?: string[];
  tags?: string[];
}

// ============================================================================
// Pattern language
// ============================================================================

export interface PatternParameter {
  value: number | string | boolean;
  unit?: string;
  /** Where the value comes from: 'typology' | 'spec' | 'code:IBC 2021 §1020' | 'Alexander APL #159' | 'default' */
  source?: string;
}

export interface Pattern {
  /** e.g. 'SIT-03', 'ARC-12', 'STR-04', 'MEC-02', 'PLB-05', 'ELE-07', 'XD-01' (cross-discipline) */
  id: string;
  name: string;
  discipline: Discipline | 'cross';
  /** Alexander-style: the recurring problem in context */
  problem: string;
  /** The parametric rule that resolves it */
  solution: string;
  parameters: Record<string, PatternParameter>;
  /** Upstream patterns this depends on */
  dependsOn?: string[];
  references?: string[];
}

export interface PatternApplication {
  patternId: string;
  storey?: string;
  unitId?: string;
  elementIds?: string[];
  /** Concrete parameter values used in this application */
  params?: Record<string, number | string | boolean>;
  note?: string;
}

// ============================================================================
// Metrics
// ============================================================================

export type MetricCategory = 'area' | 'density' | 'program' | 'form' | 'access' | 'open-space' | 'systems' | 'sustainability' | 'economics';

export type MetricId =
  | 'gfa' | 'nia' | 'efficiency' | 'far' | 'site-coverage' | 'density-dph' | 'unit-count' | 'unit-mix'
  | 'avg-unit-area' | 'bedspaces' | 'building-height' | 'floor-to-floor' | 'circulation-ratio'
  | 'wall-to-floor' | 'wwr' | 'dual-aspect' | 'parking-ratio' | 'bike-ratio' | 'open-space-per-unit'
  | 'egress-travel' | 'structural-tributary' | 'electrical-service' | 'plumbing-dfu' | 'cooling-load'
  | 'embodied-carbon' | 'eui' | 'construction-cost' | 'setback-compliance' | 'facade-area' | 'storeys';

export interface MetricDef {
  id: MetricId;
  /** Rank in the "top 20" list (1..20); >20 = supplementary */
  rank: number;
  name: string;
  altNames: Partial<Record<Region, string>>;
  category: MetricCategory;
  unit: { metric: string; imperial: string; factor: number };
  description: string;
  formula: string;
}

export interface MetricResult {
  id: MetricId;
  value: number;
  /** Formatted in the spec's display units */
  display: string;
  unit: string;
  breakdown?: Record<string, number>;
  status?: 'ok' | 'warn' | 'fail';
  note?: string;
}

// ============================================================================
// Site + massing model
// ============================================================================

export interface MassingBar {
  id: string;
  rect: Rect;
  /** Long axis of the bar */
  axis: 'x' | 'y';
  /** Bar depth (short dimension) and length (long dimension) */
  depth: number;
  length: number;
  /** Which exterior sides of this bar are open to outside (not shared with another bar) */
  exteriorSides: Side[];
}

export interface CorePlacement {
  id: string;
  rect: Rect;
  barId: string;
  type: 'stair' | 'stair-elevator' | 'scissor-stair' | 'point-core';
  hasElevator: boolean;
  elevatorCount: number;
}

export interface CorridorSpine {
  id: string;
  barId: string;
  centerline: Segment2;
  width: number;
  /** Which side(s) of the corridor have units */
  loaded: 'both' | 'left' | 'right';
}

export interface MassingModel {
  shape: FootprintShape;
  footprint: Polygon;
  footprintArea: number;
  bars: MassingBar[];
  storeys: StoreyDef[];
  heightAboveGrade: number;
  gfa: number;
  courtyard?: Polygon;
  podium?: { storeys: number; footprint: Polygon; use: 'retail' | 'parking' | 'amenity' };
  towerFootprint?: Polygon;
  cores: CorePlacement[];
  corridors: CorridorSpine[];
  roof: { type: RoofType; pitchRad: number; parapetHeight: number; ridgeAxis: 'x' | 'y' };
}

export interface ParkingSpace {
  id: string;
  rect: Rect;
  rotation: number;
  type: 'standard' | 'accessible' | 'ev' | 'compact';
  storey: string;
}

export interface ParkingLot {
  type: ParkingType;
  spaces: ParkingSpace[];
  aisles: Rect[];
  bikeSpaces: number;
  bikeStoreRect?: Rect;
  storey: string;
}

export interface LandscapeZone {
  id: string;
  type: 'lawn' | 'planting' | 'tree' | 'paving' | 'courtyard' | 'playground' | 'private-garden' | 'communal-garden' | 'bioswale';
  polygon: Polygon;
  area: number;
}

export interface Entrance {
  id: string;
  position: Vec2;
  side: Side;
  type: 'main' | 'unit' | 'service' | 'garage' | 'courtyard';
  unitId?: string;
}

export interface SiteModel {
  boundary: Polygon;
  area: number;
  buildableEnvelope: Polygon;
  setbacks: { front: number; side: number; rear: number };
  /** Compass direction the street faces, and the rotation (radians, CCW from +Y = 'N') of true north in the world frame */
  streetFacing: Compass;
  northRad: number;
  massing: MassingModel;
  parking: ParkingLot | null;
  landscape: LandscapeZone[];
  paths: Rect[];
  driveway: Rect | null;
  entrances: Entrance[];
  elements: ModelElement[];
  patterns: PatternApplication[];
  derived: Record<string, number>;
}

// ============================================================================
// Architecture model
// ============================================================================

export type WallType = 'exterior' | 'party' | 'corridor' | 'partition' | 'core' | 'shaft' | 'wet' | 'parapet' | 'retaining' | 'balcony';

export interface WallDef {
  id: string;
  storey: string;
  start: Vec2;
  end: Vec2;
  thickness: number;
  height: number;
  type: WallType;
  isExternal: boolean;
  /** Architecture's hint; structure makes the final call */
  loadBearingHint: boolean;
  fireRating?: string;
  unitId?: string;
  /** Rooms on the left / right of the wall direction (start→end) */
  leftRoomId?: string;
  rightRoomId?: string;
  /** Compass exposure of an exterior wall's outside face */
  exposure?: Compass;
}

export interface DoorDef {
  id: string;
  storey: string;
  wallId: string;
  /** Distance from wall start to door centre */
  along: number;
  width: number;
  height: number;
  type: 'unit-entry' | 'interior' | 'building-entry' | 'balcony' | 'garage' | 'exit' | 'closet' | 'service';
  operation: string;
  fromRoomId?: string;
  toRoomId?: string;
  fireRated?: boolean;
  unitId?: string;
}

export interface WindowDef {
  id: string;
  storey: string;
  wallId: string;
  along: number;
  sill: number;
  width: number;
  height: number;
  roomId: string;
  exposure?: Compass;
  unitId?: string;
}

export type FurnitureType =
  | 'bed-king' | 'bed-queen' | 'bed-double' | 'bed-single' | 'bed-bunk' | 'nightstand' | 'wardrobe' | 'dresser'
  | 'desk' | 'chair' | 'sofa-3' | 'sofa-2' | 'armchair' | 'coffee-table' | 'tv-unit' | 'dining-table-4'
  | 'dining-table-6' | 'dining-chair' | 'kitchen-counter' | 'kitchen-island' | 'fridge' | 'range' | 'dishwasher'
  | 'kitchen-sink' | 'wc' | 'lavatory' | 'vanity' | 'shower' | 'bathtub' | 'washer' | 'dryer' | 'water-heater'
  | 'shelving' | 'bookcase' | 'crib' | 'bench' | 'planter' | 'outdoor-table' | 'bike-rack' | 'mailbox-bank'
  | 'reception-desk' | 'treadmill' | 'lounge-chair' | 'grab-rail' | 'car';

export interface FurnitureDef {
  id: string;
  storey: string;
  roomId: string;
  unitId?: string;
  type: FurnitureType;
  /** Footprint min corner before rotation about that corner */
  position: Vec2;
  width: number;
  depth: number;
  height: number;
  rotation: number;
  /** Plumbing/electrical hooks: true if the item needs water/waste or a dedicated circuit */
  needsWater?: boolean;
  needsPower?: boolean;
}

export interface RoomDef {
  id: string;
  storey: string;
  unitId?: string;
  type: RoomType;
  name: string;
  polygon: Polygon;
  /** Axis-aligned bounds; equals the polygon for rectangular rooms */
  rect: Rect;
  area: number;
  height: number;
  isWet: boolean;
  hasExterior: boolean;
  exteriorWallIds: string[];
  wallIds: string[];
  doorIds: string[];
  windowIds: string[];
  furnitureIds: string[];
  occupancy: number;
  zone: Zone;
}

export interface UnitInstance {
  id: string;
  templateId: UnitTemplateId;
  storeys: string[];
  /** Bounding rect on its entry storey */
  rect: Rect;
  polygon: Polygon;
  area: number;
  bedrooms: number;
  bathrooms: number;
  occupants: number;
  aspect: 'single' | 'dual' | 'corner';
  /** Side of the unit that faces the access (corridor/street): direction from unit centre toward access */
  accessSide: Side;
  entryDoorId: string;
  roomIds: string[];
  wetWallIds: string[];
  kitchenRoomId?: string;
  bathroomRoomIds: string[];
  balconyRoomId?: string;
  barId?: string;
  coreId?: string;
}

export interface CorridorDef {
  id: string;
  storey: string;
  polygon: Polygon;
  centerline: Segment2[];
  width: number;
  roomId: string;
}

export interface StairDef {
  id: string;
  coreId: string;
  storey: string;
  /** Nose of first tread */
  position: Vec2;
  direction: number;
  risers: number;
  riserHeight: number;
  tread: number;
  width: number;
  flights: 1 | 2;
  landingRect?: Rect;
  isExit: boolean;
}

export interface ElevatorDef {
  id: string;
  coreId: string;
  rect: Rect;
  storeys: string[];
  capacityKg: number;
}

export interface CoreDef {
  id: string;
  rect: Rect;
  storeys: string[];
  type: 'stair' | 'stair-elevator' | 'scissor-stair' | 'point-core';
  stairIds: string[];
  elevatorIds: string[];
  /** Rooms that make up the core on each storey */
  roomIds: string[];
  isExit: boolean;
}

export interface ShaftDef {
  id: string;
  rect: Rect;
  storeys: string[];
  purpose: 'plumbing' | 'mechanical' | 'electrical' | 'combined' | 'trash' | 'elevator';
  servesUnitIds: string[];
  /** Nearest wet wall / corridor it opens to */
  accessFrom: 'corridor' | 'unit' | 'core';
}

export interface BalconyDef {
  id: string;
  storey: string;
  unitId: string;
  rect: Rect;
  roomId: string;
}

export interface FloorPlan {
  storey: string;
  use: FloorUse;
  outline: Polygon;
  area: number;
  floorToFloor: number;
  ceilingHeight: number;
  slabThickness: number;
  corridors: CorridorDef[];
  unitIds: string[];
  roomIds: string[];
  commonRoomIds: string[];
  wallIds: string[];
  exteriorWallIds: string[];
  balconies: BalconyDef[];
  /** Window-to-wall ratio achieved on this floor */
  wwr: number;
}

export interface RoofDef {
  type: RoofType;
  outline: Polygon;
  thickness: number;
  pitchRad: number;
  ridgeAxis: 'x' | 'y';
  parapetHeight: number;
  /** Clear zone kept free for PV / plant */
  plantZone?: Rect;
  pvZone?: Rect;
}

export interface ArchModel {
  storeys: StoreyDef[];
  floors: FloorPlan[];
  units: UnitInstance[];
  rooms: RoomDef[];
  walls: WallDef[];
  doors: DoorDef[];
  windows: WindowDef[];
  furniture: FurnitureDef[];
  cores: CoreDef[];
  stairs: StairDef[];
  elevators: ElevatorDef[];
  shafts: ShaftDef[];
  roof: RoofDef;
  /** Which templates were used, with the resolved parameters */
  templatesUsed: UnitTemplateId[];
  elements: ModelElement[];
  patterns: PatternApplication[];
  derived: Record<string, number>;
}

// ============================================================================
// Structure model
// ============================================================================

export interface GridLine {
  id: string;
  axis: 'x' | 'y';
  offset: number;
}

export interface StructColumn {
  id: string;
  storey: string;
  position: Vec2;
  width: number;
  depth: number;
  height: number;
  gridRef: string;
  material: 'concrete' | 'steel' | 'timber';
}

export interface StructBeam {
  id: string;
  storey: string;
  start: Vec2;
  end: Vec2;
  /** Soffit Z relative to the storey ABOVE's floor level is negative; stored here as storey-local Z of the beam's underside at the TOP of this storey */
  z: number;
  width: number;
  depth: number;
  material: 'concrete' | 'steel' | 'timber';
  role: 'primary' | 'secondary' | 'rim' | 'lintel' | 'transfer';
}

export interface StructWall {
  id: string;
  storey: string;
  archWallId?: string;
  start: Vec2;
  end: Vec2;
  thickness: number;
  height: number;
  role: 'bearing' | 'shear' | 'core' | 'foundation';
  material: 'concrete' | 'masonry' | 'timber' | 'clt';
}

export interface StructSlab {
  id: string;
  storey: string;
  outline: Polygon;
  thickness: number;
  type: 'floor' | 'roof' | 'ground' | 'podium-transfer';
  openings: Rect[];
}

export interface FoundationElement {
  id: string;
  type: 'strip' | 'pad' | 'raft' | 'pile' | 'pile-cap' | 'slab-on-grade';
  rect?: Rect;
  position?: Vec2;
  width?: number;
  depth?: number;
  height: number;
  length?: number;
}

export interface StructModel {
  system: StructuralSystemId;
  foundation: FoundationType;
  grid: GridLine[];
  columns: StructColumn[];
  beams: StructBeam[];
  walls: StructWall[];
  slabs: StructSlab[];
  foundations: FoundationElement[];
  transferStorey?: string;
  /** Typical member sizes chosen (m) */
  sizes: { columnW: number; columnD: number; beamW: number; beamD: number; slabT: number; shearWallT: number };
  loads: { deadKpa: number; liveKpa: number; roofLiveKpa: number };
  /** Zones that must stay free of structure for MEP (shafts, corridor plenum band) */
  plenumClearance: { corridorSoffitZ: number };
  elements: ModelElement[];
  patterns: PatternApplication[];
  derived: Record<string, number>;
}

// ============================================================================
// Mechanical model
// ============================================================================

export type DuctSystemType = 'supply' | 'return' | 'exhaust' | 'outdoor-air' | 'kitchen-exhaust' | 'dryer-exhaust' | 'corridor-pressurization';

export interface MechEquipment {
  id: string;
  storey: string;
  type: 'heat-pump-outdoor' | 'indoor-unit' | 'erv' | 'mvhr' | 'ahu' | 'rtu' | 'exhaust-fan' | 'range-hood' | 'fan-coil' | 'radiator' | 'ptac' | 'vrf-condenser' | 'boiler' | 'chiller' | 'heat-interface-unit' | 'thermostat';
  roomId?: string;
  unitId?: string;
  position: Vec3;
  width: number;
  depth: number;
  height: number;
  rotation: number;
  capacityKw?: number;
}

export interface DuctRun {
  id: string;
  storey: string;
  systemType: DuctSystemType;
  /** Polyline; consecutive points become IfcDuctSegment elements, corners become IfcDuctFitting */
  path: Vec3[];
  shape: 'rect' | 'round';
  width: number;
  height: number;
  servesRoomIds: string[];
  unitId?: string;
}

export interface AirTerminal {
  id: string;
  storey: string;
  type: 'supply-diffuser' | 'return-grille' | 'exhaust-grille' | 'louver' | 'transfer-grille';
  roomId: string;
  position: Vec3;
  width: number;
  depth: number;
  airflowLs: number;
}

export interface Riser {
  id: string;
  shaftId: string;
  systemType: DuctSystemType | 'refrigerant' | 'hydronic';
  fromStorey: string;
  toStorey: string;
  xy: Vec2;
  width: number;
  height: number;
  shape: 'rect' | 'round';
}

export interface MechModel {
  system: HvacSystemId;
  ventilation: VentilationStrategy;
  equipment: MechEquipment[];
  ducts: DuctRun[];
  terminals: AirTerminal[];
  risers: Riser[];
  plantRoomIds: string[];
  loads: { coolingWPerM2: number; heatingWPerM2: number; ventilationLsPerPerson: number; totalCoolingKw: number; totalHeatingKw: number };
  elements: ModelElement[];
  patterns: PatternApplication[];
  derived: Record<string, number>;
}

// ============================================================================
// Plumbing model
// ============================================================================

export type PipeSystemType = 'dcw' | 'dhw' | 'hwr' | 'waste' | 'vent' | 'storm' | 'sprinkler' | 'standpipe' | 'gas';

export interface PlumbingFixture {
  id: string;
  storey: string;
  type: 'wc' | 'lavatory' | 'shower' | 'bathtub' | 'kitchen-sink' | 'dishwasher' | 'washer' | 'hose-bibb' | 'floor-drain' | 'water-heater' | 'utility-sink' | 'drinking-fountain' | 'water-meter' | 'backflow-preventer' | 'booster-pump' | 'roof-drain' | 'sprinkler-head' | 'fire-hose-valve';
  roomId?: string;
  unitId?: string;
  furnitureId?: string;
  position: Vec3;
  rotation: number;
  width: number;
  depth: number;
  height: number;
  connections: PipeSystemType[];
  /** Drainage fixture units (UPC/IPC) and water supply fixture units */
  dfu: number;
  wsfu: number;
}

export interface PlumbingStack {
  id: string;
  shaftId?: string;
  wetWallId?: string;
  xy: Vec2;
  systems: PipeSystemType[];
  fromStorey: string;
  toStorey: string;
  servesUnitIds: string[];
}

export interface PipeRun {
  id: string;
  storey: string;
  system: PipeSystemType;
  path: Vec3[];
  diameter: number;
  servesFixtureIds: string[];
  unitId?: string;
  stackId?: string;
}

export interface PlumbModel {
  dhw: DhwSystemId;
  sprinklered: boolean;
  fixtures: PlumbingFixture[];
  stacks: PlumbingStack[];
  pipes: PipeRun[];
  roofDrains: Vec2[];
  totals: { dfu: number; wsfu: number; fixtureCount: number; serviceDiameter: number };
  elements: ModelElement[];
  patterns: PatternApplication[];
  derived: Record<string, number>;
}

// ============================================================================
// Electrical model
// ============================================================================

export type ElecDeviceType =
  | 'receptacle' | 'gfci-receptacle' | 'range-receptacle' | 'dryer-receptacle' | 'switch' | 'dimmer'
  | 'light-ceiling' | 'light-recessed' | 'light-pendant' | 'light-wall' | 'light-vanity' | 'light-under-cabinet'
  | 'light-emergency' | 'exit-sign' | 'light-exterior' | 'light-bollard' | 'light-pole'
  | 'smoke-alarm' | 'co-alarm' | 'heat-detector' | 'data-outlet' | 'tv-outlet' | 'thermostat' | 'doorbell'
  | 'intercom' | 'ev-charger' | 'disconnect' | 'junction-box' | 'pv-panel' | 'inverter' | 'transformer' | 'generator';

export interface ElecPanel {
  id: string;
  storey: string;
  type: 'main-switchboard' | 'meter-bank' | 'unit-panel' | 'house-panel' | 'floor-distribution' | 'ev-panel' | 'pv-combiner';
  roomId?: string;
  unitId?: string;
  position: Vec3;
  rotation: number;
  width: number;
  depth: number;
  height: number;
  amps: number;
  voltage: string;
  circuitCount: number;
}

export interface ElecDevice {
  id: string;
  storey: string;
  type: ElecDeviceType;
  roomId?: string;
  unitId?: string;
  wallId?: string;
  position: Vec3;
  rotation: number;
  circuitId?: string;
  watts?: number;
}

export interface Circuit {
  id: string;
  panelId: string;
  type: 'general-receptacle' | 'lighting' | 'kitchen-small-appliance' | 'bathroom' | 'laundry' | 'hvac' | 'range' | 'dryer' | 'water-heater' | 'ev' | 'dishwasher' | 'disposal' | 'refrigerator' | 'life-safety' | 'house-lighting' | 'elevator' | 'pv';
  amps: number;
  voltage: number;
  deviceIds: string[];
  va: number;
}

export interface CableTrayRun {
  id: string;
  storey: string;
  path: Vec3[];
  width: number;
  height: number;
  purpose: 'power' | 'data' | 'life-safety';
}

export interface ElecRiser {
  id: string;
  shaftId: string;
  type: 'busduct' | 'cable-riser' | 'conduit-bank';
  fromStorey: string;
  toStorey: string;
  xy: Vec2;
  width: number;
  depth: number;
}

export interface ElecModel {
  service: { voltage: string; amps: number; phases: 1 | 3 };
  panels: ElecPanel[];
  devices: ElecDevice[];
  circuits: Circuit[];
  trays: CableTrayRun[];
  risers: ElecRiser[];
  pv?: { panelRects: Rect[]; kwDc: number };
  loads: { connectedVa: number; demandVa: number; perUnitVa: number };
  elements: ModelElement[];
  patterns: PatternApplication[];
  derived: Record<string, number>;
}

// ============================================================================
// Generation context and pipeline
// ============================================================================

export interface Rng {
  /** Uniform float in [0, 1) */
  next(): number;
  int(minInclusive: number, maxInclusive: number): number;
  pick<T>(items: readonly T[]): T;
  /** Weighted pick by numeric weights */
  weighted<T>(items: readonly T[], weights: readonly number[]): T;
  shuffle<T>(items: readonly T[]): T[];
  /** Child generator with a derived seed for a named sub-scope (keeps disciplines independent) */
  fork(label: string): Rng;
}

export interface GenContext {
  spec: BuildingSpec;
  typology: TypologyDef;
  rng: Rng;
  storeys: StoreyDef[];
  site: SiteModel;
  arch: ArchModel | null;
  struct: StructModel | null;
  mech: MechModel | null;
  plumb: PlumbModel | null;
  elec: ElecModel | null;
  warnings: string[];
}

export type SiteGenerator = (spec: BuildingSpec, typology: TypologyDef, rng: Rng, warnings: string[]) => SiteModel;
export type ArchitectureGenerator = (ctx: GenContext) => ArchModel;
export type StructureGenerator = (ctx: GenContext) => StructModel;
export type MechanicalGenerator = (ctx: GenContext) => MechModel;
export type PlumbingGenerator = (ctx: GenContext) => PlumbModel;
export type ElectricalGenerator = (ctx: GenContext) => ElecModel;

export interface DesignModel {
  spec: BuildingSpec;
  typology: TypologyDef;
  storeys: StoreyDef[];
  site: SiteModel;
  arch: ArchModel;
  struct: StructModel | null;
  mech: MechModel | null;
  plumb: PlumbModel | null;
  elec: ElecModel | null;
  /** All elements from all disciplines, in write order */
  elements: ModelElement[];
  metrics: MetricResult[];
  patterns: { book: Pattern[]; applications: PatternApplication[] };
  warnings: string[];
  timings: Record<string, number>;
}

export interface IfcOutput {
  content: string;
  entityCount: number;
  fileSize: number;
  /** ModelElement id → IFC expressId */
  idMap: Record<string, number>;
  /**
   * Non-fatal problems found while writing (one per skipped/degraded element):
   * `writer: <elementId> (<geometry kind>): <message>`. Never throws for a single
   * bad element — it is reported here and generation continues.
   */
  warnings?: string[];
}
