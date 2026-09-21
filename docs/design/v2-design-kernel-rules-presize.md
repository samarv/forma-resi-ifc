# Design: coordination kernel, ceiling profiles, structural pre-sizing, constructability, rule engine, resolutions

_Generated 2026-09-21 by a read-only design/exploration pass over this repository; line numbers refer to the v1 code at commit 05246fb. Source of truth for v2 contracts is docs/design/v2-plan.md and the files under src/core._

I have read the plan file and the code. Here is the design.

---

# v2 Backbone — Coordination Kernel, Structural Pre-Sizing, Constructability, Rule Engine

**Measured baseline** (`node src/pipeline.ts`, 2026-09-21): `ca-point-tower` 22 storeys = 45 331 elements / **256 ms**; `ie-courtyard` = 67 189 elements (24 892 `axis`) / **337 ms** / 59 warnings (40 architecture, 18 plumbing, 1 structure). The 2 s budget has ~6× headroom, so the whole backbone must stay **O(n)** with small constants — no pairwise clash loop anywhere.

---

## 1. New and changed files

### New

| File | Purpose |
|---|---|
| `src/core/kernel/types.ts` | `Box3`, `ElementKind`, `Band`, `CeilingProfile`, `Lane`, `Reservation`, `Conflict`, `ShaftSlot`, `Chase`, `Sleeve`, `Kernel`. The frozen contract. |
| `src/core/kernel/profiles.ts` | The 9 ceiling-profile tables + `resolveProfile`, `stackProfile`, `ProfileBook`. |
| `src/core/kernel/lanes.ts` | Lane tables with **widths**, `laneSetFor`, `lanePathIn`, `laneBoxes`, `LateralAllocator`, `StationAllocator`. |
| `src/core/kernel/clearances.ts` | `CLEARANCES`, `ROUTE_HOME`, `MOVE_COST`, `HANGERS`, `SLOPES`, `CLEAR_HEIGHTS` — all with code sources. |
| `src/core/kernel/shafts.ts` | The single shaft-slot allocator. |
| `src/core/kernel/chases.ts` | Wet-wall chase reservations per dwelling column. |
| `src/core/kernel/sleeves.ts` | Sleeves / firestopped penetrations at rated walls and slabs. |
| `src/core/kernel/registry.ts` | `createKernel`, `reserve`, `reserveLaneRun`, `reserveRiser`, grid broadphase. |
| `src/core/kernel/validate.ts` | Element→reservation post-check + `ELEMENT_KIND` classifier. |
| `src/core/kernel/support.ts` | `checkSupport` — no free-floating MEP, riser continuity, slope monotonicity, branch/stack reachability, structure penetration. |
| `src/core/kernel/mounting.ts` | `MOUNTING` (moved verbatim from `coordination.ts`). |
| `src/core/kernel/sizes.ts` | `ELEMENT_SIZES` = old `SIZES` **minus `slabT` and `coreWallT`**. |
| `src/core/kernel/index.ts` | Barrel. |
| `src/core/rules/types.ts` | `Rule`, `RuleScope`, `PredicateId`, `ResolutionId`, `Issue`, `Severity`, `RuleSet`, `World`, `Subject`. |
| `src/core/rules/predicates.ts` | The closed predicate vocabulary (24 implementations) + `PREDICATE_SIGNATURES`. |
| `src/core/rules/builtin.ts` | Hand-authored constraint rules (~60) + `RULE_PROFILES` (`high-rise`, `sprinklered`, `uk`, `us`). |
| `src/core/rules/from-patterns.ts` | `rulesFromPatterns` — lifts every numeric pattern parameter into a `kind:'param'` Rule. |
| `src/core/rules/schema.ts` | JSON schema + hand-written validator for `spec.rules`. |
| `src/core/rules/engine.ts` | `createRuleSet`, `num`/`str`/`bool`/`table`, `scopeMatches`, `check`. |
| `src/core/rules/ledger.ts` | `createLedger` + the `warnings(): string[]` back-compat projection. |
| `src/core/rules/graph.ts` | `RoomGraph` — the persisted adjacency/connectivity graph (today discarded at `unit-layout.ts:1355`). |
| `src/disciplines/structure/presize.ts` | `presizeStructure` → `StructuralPresize`. |
| `src/disciplines/structure/loadpath.ts` | `checkLoadPath` — column continuity, foundations, slab edge, balcony cantilever. |
| `src/disciplines/plumbing/invert.ts` | `buildInvertModel` — replaces `BUILDING_DRAIN_Z` / `SEWER_Z`. |
| `src/disciplines/site/parking-solver.ts` | `solveParking`, `estimateUnits`, `stallCapacity`. |
| `src/disciplines/site/corridor-graph.ts` | `buildCorridorGraph` — legs, break slots, knuckles, dead ends. |
| `src/core/kernel/kernel.test.ts` | |
| `src/core/rules/rules.test.ts` | |
| `src/coordination.test.ts` | The cross-discipline test. |
| `src/presets.test.ts` | Zero-violation invariant across all 10 presets. |
| `src/no-duplicate-constants.test.ts` | Source-text test asserting deleted identifiers are gone. |

### Changed

`src/core/types.ts` (additive), `src/core/coordination.ts` (shim then **deleted**), `src/core/spec.ts`, `src/core/patterns.ts`, `src/pipeline.ts`, `src/disciplines/structure/{index,grid,sizing}.ts`, `src/disciplines/architecture/{index,cores,floor-organizer}.ts`, `src/disciplines/mechanical/{context,building,placement,ventilation,unit-systems,index}.ts`, `src/disciplines/plumbing/{state,fixtures,stacks,branches,routing,service,storm,sprinkler,tables,index}.ts`, `src/disciplines/electrical/{panels,devices,internal,index}.ts`, `src/disciplines/site/{massing,parking,index}.ts`, `src/app/{form,state}.ts`, `CONTRACT.md`.

---

## 2. TypeScript interfaces and key signatures

Erasable TS throughout: no `enum`, no `namespace`, no parameter properties, `import type`, `.ts` extensions, classes with explicit field declarations only.

### 2.1 Kernel primitives — `src/core/kernel/types.ts`

```ts
import type {
  Discipline, FloorUse, RoomType, Rect, Segment2, Vec2, Vec3, ModelElement, ShaftDef, WallDef,
} from '../types.ts';
import type { Issue } from '../rules/types.ts';

/** Axis-aligned box. XY world, Z storey-local (0 = that storey's FFL). */
export interface Box3 { x: number; y: number; z: number; w: number; d: number; h: number; }

export type ElementKind =
  | 'slab' | 'beam' | 'column' | 'drop-panel' | 'wall' | 'shaft-void'
  | 'duct' | 'duct-fitting' | 'air-terminal' | 'fan' | 'ahu' | 'jet-fan'
  | 'waste' | 'vent' | 'storm' | 'trench-drain' | 'dcw' | 'dhw' | 'hwr' | 'gas'
  | 'sprinkler-main' | 'sprinkler-branch' | 'sprinkler-head' | 'standpipe'
  | 'tray-power' | 'tray-data' | 'conduit' | 'busduct' | 'panel' | 'switchgear'
  | 'light' | 'sensor' | 'ev-charger' | 'pump' | 'tank' | 'sump' | 'ejector' | 'plinth';

export type BandPurpose =
  | 'structure' | 'transfer' | 'sprinkler' | 'duct' | 'gravity-drain' | 'pressure-pipe'
  | 'tray' | 'crossing' | 'ceiling-void' | 'ceiling' | 'clear' | 'equipment'
  | 'tenant-plenum' | 'landlord-service' | 'access';

export type BandClass = 'structure' | 'parallel' | 'crossing' | 'void' | 'ceiling' | 'clear' | 'equipment';
export type BandOwner = Discipline | 'shared' | 'none';
export type Home = 'ceiling' | 'wall' | 'chase' | 'shaft' | 'floor' | 'slab' | 'plinth' | 'exterior';

export interface Band {
  id: string;                        // 'resi-corridor/duct'
  purpose: BandPurpose;
  cls: BandClass;
  owner: BandOwner;
  /** Distance from the slab soffit down to the TOP of this band (m) */
  topBelowSoffit: number;
  depth: number;
  minDepth: number;
  /** Installation gap kept above / below the band (m) */
  clearanceAbove: number;
  clearanceBelow: number;
  allows: readonly ElementKind[];
  /** 1 = cannot be moved (structure, gravity), 5 = trivially rerouted (conduit) */
  flexibility: 1 | 2 | 3 | 4 | 5;
  droppable: boolean;
  /** Filled from `presize.beamDAbove` rather than a constant */
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
  soffitZ: number;              // f2f - slabTAbove
  structureBottomZ: number;     // soffitZ - beamDAbove
  ceilingZ: number;
  clearZ: number;               // lowest permitted obstruction
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
export function createProfileBook(rules: RuleSet): ProfileBook;

/** Resolve a profile against a concrete storey; compresses / drops / asks for a taller storey. */
export function stackProfile(o: {
  profile: CeilingProfile;
  storey: string;
  floorToFloor: number;
  slabTAbove: number;
  beamDAbove: number;
  beamDAboveUnit: number;
  transferZoneDepth: number;
  ceilingWanted?: number;
  rules: RuleSet;
}): { resolved: StoreyProfile; raiseFloorToFloorTo: number | null };
```

### 2.2 Lanes with widths — `src/core/kernel/lanes.ts`

```ts
export type LaneVAlign = 'top' | 'middle' | 'bottom';

export interface Lane {
  id: string;                  // 'duct' | 'sprinkler' | 'gravity' | 'pressure' | 'tray-power' | 'tray-data'
  owner: Discipline;
  bandPurpose: BandPurpose;
  /** Lateral offset of the lane CENTRE from the corridor centreline (+ = toward `loaded` left) */
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
  /** Fallback applied when it is not: which lane drops into the crossing band */
  overflowLaneId: string | null;
}

export function laneSetFor(profileId: ProfileId, corridorWidth: number, rules: RuleSet):
  { set: LaneSet; issues: Issue[] };

/** Polyline for a lane, at a lateral shift inside the lane (from the allocator) */
export function lanePathIn(centerline: readonly Segment2[], lane: Lane, z: number, lateralShift: number): Vec3[];
/** Boxes a lane run occupies, for the registry */
export function laneBoxes(path: readonly Vec3[], w: number, h: number): Box3[];
```

`LateralAllocator` / `StationAllocator` are classes with explicit fields:

```ts
export interface LateralSpan { a: number; b: number; centre: number; }

export class LateralAllocator {
  readonly lane: Lane;
  private claims = new Map<string, LateralSpan>();   // systemKey → span (memoised, idempotent)
  private cursorInboard = 0;
  constructor(lane: Lane);
  /** k-th claimer by CANONICAL system order, from the inboard edge. Idempotent. */
  claim(systemKey: string, width: number): LateralSpan | null;
  used(): number;
}

export class StationAllocator {
  readonly bandId: string;
  readonly pitch: number;
  private taken: { a: number; b: number; key: string }[] = [];
  constructor(bandId: string, pitch: number);
  /** Deterministic outward walk: +p, −p, +2p, −2p, … up to 40 steps. */
  claim(key: string, station: number, length: number): { station: number; shifted: number } | null;
}
```

### 2.3 Shaft slots, chases, sleeves

```ts
export type ShaftSystem =
  | 'air-supply' | 'air-exhaust' | 'air-outdoor' | 'kitchen-exhaust' | 'dryer-exhaust'
  | 'refrigerant' | 'hydronic' | 'stair-pressurisation'
  | 'waste' | 'vent' | 'dcw' | 'dhw' | 'hwr' | 'storm' | 'sprinkler' | 'standpipe' | 'gas'
  | 'power' | 'data' | 'life-safety' | 'trash';

/** THE canonical order. Slot position is a pure function of this + the shaft rect. */
export const SHAFT_SYSTEM_ORDER: readonly ShaftSystem[];
export const SHAFT_ZONE_OF: Readonly<Record<ShaftSystem, 'plumbing' | 'mechanical' | 'electrical' | 'trash'>>;

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
  zone: 'plumbing' | 'mechanical' | 'electrical' | 'trash';
  storeys: readonly string[];
  reservationId: string;
}

export interface ShaftAllocator {
  /** Registers a shaft (from ArchModel.shafts, or synthesised from a CoreDef). */
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
```

### 2.4 Reservations and the kernel — `src/core/kernel/registry.ts`

```ts
export type Container = 'band' | 'shaft' | 'chase' | 'wall' | 'floor' | 'plinth' | 'exterior' | 'keepout';

export interface Reservation {
  id: string;                    // 'RSV-0001', deterministic sequence
  owner: Discipline;
  kind: ElementKind;
  purpose: BandPurpose;
  storey: string;
  container: Container;
  containerId: string | null;    // bandId / shaftId / chaseId / wallId
  boxes: readonly Box3[];
  /** Offsets the resolver applied, in metres */
  shift: { lateral: number; along: number; vertical: number };
  /** Set for keep-outs: only the owner may be inside; listed kinds are banned outright */
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
export function isConflict(r: ReserveResult | ShaftSlot | Chase | Sleeve): r is Conflict;

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
  keepOut(o: { owner: Discipline; kind: ElementKind; storey: string; boxes: readonly Box3[]; bans: readonly ElementKind[]; note: string }): Reservation;

  reservations(): readonly Reservation[];
  reservationsOn(storey: string, owner?: Discipline): readonly Reservation[];
  /** Post-check: every MEP element lies inside a reservation of its own discipline and band */
  validate(elements: readonly ModelElement[]): Issue[];
  derived(): Record<string, number>;
}

export function createKernel(o: KernelOptions): Kernel;
```

### 2.5 Rules and issues — `src/core/rules/types.ts`

```ts
export type Severity = 'info' | 'deviation' | 'violation' | 'error';
export type RuleKind = 'param' | 'constraint';

export interface RuleParam { value: number | string | boolean; unit?: string; source: string; }

export interface RuleScope {
  floorUse?: readonly FloorUse[];
  roomType?: readonly RoomType[];
  elementKinds?: readonly ElementKind[];
  templateIds?: readonly UnitTemplateId[];
  storeys?: readonly string[];
  storeyIndexMin?: number;
  storeyIndexMax?: number;
  typologies?: readonly TypologyId[];
  regions?: readonly Region[];
  sprinklered?: boolean;
}

export type PredicateId =
  | 'minDim' | 'minArea' | 'maxArea' | 'aspect'
  | 'adjacent' | 'connected' | 'notThrough'
  | 'exterior' | 'daylight'
  | 'withinDistance' | 'clearance' | 'notOver'
  | 'band' | 'lane' | 'inReservation'
  | 'maxRun' | 'deadEnd' | 'egressTravel'
  | 'supported' | 'slope' | 'continuous' | 'reaches'
  | 'clearHeight' | 'swingClear'
  | 'loadPath' | 'cappedAtDemise' | 'count' | 'ratio';

export type ResolutionId =
  | 'none' | 'clamp' | 'shift-along-lane' | 'shift-lateral' | 'compress-band' | 'drop-band'
  | 'raise-floor-to-floor' | 'lower-ceiling' | 'oversize-pipe'
  | 'add-basement-level' | 'add-podium-level' | 'relax-parking-ratio'
  | 'split-corridor' | 'add-core' | 'switch-highrise-ruleset'
  | 'add-sump' | 'vent-branch' | 'reroute-in-wall' | 'enlarge-shaft' | 'snap-to-party-line';

export interface Rule {
  id: string;                               // 'ARC-03.maxLegLength', 'PLB-02.trapArm'
  title: string;
  discipline: Discipline | 'xd';
  patternId?: string;
  kind: RuleKind;
  scope: RuleScope;
  params: Readonly<Record<string, RuleParam>>;
  predicate?: { id: PredicateId; args: readonly (string | number | boolean)[] };
  severity: Severity;
  resolution?: ResolutionId;
  rationale?: string;
  /** Predicate is evaluated per subject of this kind */
  subject?: Subject['kind'];
}

export interface Issue {
  id: string;                               // 'ISS-0001'
  severity: Severity;
  ruleId: string;
  discipline: Discipline | 'xd';
  storey?: string;
  unitId?: string;
  roomId?: string;
  elementIds?: readonly string[];
  message: string;
  observed?: number | string;
  limit?: number | string;
  source?: string;
  resolution?: { id: ResolutionId; from?: number | string; to?: number | string; note?: string };
  /** Deduplication count when added via addOnce */
  count?: number;
}

export interface Ledger {
  add(i: Omit<Issue, 'id'>): Issue;
  addOnce(key: string, i: Omit<Issue, 'id'>): Issue | null;
  all(): readonly Issue[];
  bySeverity(s: Severity): readonly Issue[];
  byRule(ruleId: string): readonly Issue[];
  counts(): Record<Severity, number>;
  /** Back-compat: the string list DesignModel.warnings / the CLI / the app still read */
  warnings(o?: { includeInfo?: boolean }): string[];
}
export function createLedger(o?: { mirrorInto?: string[] }): Ledger;

export interface RuleSet {
  all(): readonly Rule[];
  get(id: string): Rule | null;
  num(id: string, fallback: number): number;
  str(id: string, fallback: string): string;
  bool(id: string, fallback: boolean): boolean;
  /** Stepped tables, e.g. PLB-02.trapArm: [[0.032, 1.07], [0.04, 1.52], …] */
  table(id: string): readonly [number, number][];
  /** Rules whose scope matches a subject, in canonical id order */
  forSubject(kind: Subject['kind'], ctx: ScopeContext): readonly Rule[];
  disabled(id: string): boolean;
  profileApplied(name: string): boolean;
}
export function createRuleSet(o: {
  builtin: readonly Rule[];
  fromPatterns: readonly Rule[];
  overrides?: RuleOverrides;
  spec: BuildingSpec;
  typology: TypologyDef;
  ledger: Ledger;
}): RuleSet;

export function check(o: { rules: RuleSet; world: World; ledger: Ledger }): void;
```

`Subject`, `World`, `RoomGraph`, `Predicate` as specified earlier in §D of the brief:

```ts
export type Subject =
  | { kind: 'building' }
  | { kind: 'floor'; floor: FloorPlan }
  | { kind: 'unit'; unit: UnitInstance }
  | { kind: 'room'; room: RoomDef }
  | { kind: 'door'; door: DoorDef }
  | { kind: 'corridor'; corridor: CorridorDef }
  | { kind: 'element'; element: ModelElement }
  | { kind: 'run'; id: string; storey: string; system: string; path: readonly Vec3[]; diameter: number }
  | { kind: 'support'; support: Support };

export interface RoomGraph {
  adjacent(roomId: string): readonly string[];     // share a wall
  connected(roomId: string): readonly string[];    // share a door
  path(a: string, b: string): readonly string[] | null;
  through(a: string, b: string): readonly string[];
}

export interface World {
  spec: BuildingSpec; typology: TypologyDef; storeys: readonly StoreyDef[];
  site: SiteModel; arch: ArchModel | null; struct: StructModel | null;
  mech: MechModel | null; plumb: PlumbModel | null; elec: ElecModel | null;
  presize: StructuralPresize; kernel: Kernel; graph: RoomGraph; invert: InvertModel | null;
  elementById: Map<string, ModelElement>;
  roomById: Map<string, RoomDef>;
}
export type Predicate = (w: World, rule: Rule, s: Subject) => { ok: boolean; observed?: number | string; limit?: number | string; detail?: string };
export const PREDICATES: Readonly<Record<PredicateId, Predicate>>;
export const PREDICATE_SIGNATURES: Readonly<Record<PredicateId, {
  subjects: readonly Subject['kind'][];
  object?: readonly ('roomType' | 'elementKind' | 'system' | 'none')[];
  limitType: 'number' | 'string' | 'boolean';
  unit?: string;
  description: string;
}>>;
```

### 2.6 Custom rules in the spec — `src/core/rules/schema.ts`

```ts
export interface RuleOverrides {
  version: 1;
  /** ruleId → paramName → value */
  params?: Record<string, Record<string, number | string | boolean>>;
  severity?: Record<string, Severity>;
  disabled?: string[];
  custom?: CustomRule[];
  /** Named rule sets layered on top, e.g. 'high-rise' */
  profiles?: string[];
}

export type SubjectSelector =
  | { kind: 'room'; roomType?: string[]; zone?: string[] }
  | { kind: 'unit'; templateId?: string[] }
  | { kind: 'floor'; floorUse?: string[] }
  | { kind: 'corridor' }
  | { kind: 'door'; doorType?: string[] }
  | { kind: 'element'; elementKind?: string[] }
  | { kind: 'run'; system?: string[] }
  | { kind: 'support' }
  | { kind: 'building' };

export type ObjectSelector =
  | { kind: 'roomType'; value: string }
  | { kind: 'elementKind'; value: string }
  | { kind: 'system'; value: string }
  | { kind: 'none' };

export interface CustomRule {
  id: string;                                       // must match /^USR-[A-Za-z0-9_-]{1,32}$/
  title: string;
  subject: SubjectSelector;
  predicate: PredicateId;
  object?: ObjectSelector;
  limit: { op: '>=' | '<=' | '==' | '!='; value: number | string | boolean; unit?: string };
  scope?: RuleScope;
  severity?: Severity;
  resolution?: ResolutionId;
  source?: string;
}

export const RULE_OVERRIDES_SCHEMA: unknown;        // JSON-Schema draft-07 document, for docs + the UI
export function validateRuleOverrides(raw: unknown): { overrides: RuleOverrides | null; issues: Omit<Issue, 'id'>[] };
export function customToRule(c: CustomRule): Rule;
```

**UI form → JSON mapping.** One row of the Rules tab is exactly one `CustomRule`:

| form field | widget | JSON path |
|---|---|---|
| Subject | select, options = `PREDICATE_SIGNATURES[p].subjects` ∩ subject kinds; second select for `roomType` / `templateId` / `system` | `subject` |
| Predicate | select over `PredicateId`, filtered to those legal for the chosen subject | `predicate` |
| Object | shown only when `PREDICATE_SIGNATURES[p].object` is non-empty; select over the declared object kind | `object` |
| Comparator | select `≥ ≤ = ≠` | `limit.op` |
| Limit | number / text / checkbox, chosen from `limitType`; unit label from `unit` | `limit.value`, `limit.unit` |
| Scope | multi-select: floor use, room type, template, storey range, region | `scope` |
| Severity | select `info / deviation / violation` (`error` is reserved for the engine) | `severity` |
| Resolution | select over `ResolutionId`, filtered to those the predicate supports | `resolution` |

Examples the form produces:
```json
{ "id": "USR-bed-min-width", "title": "Bedrooms at least 2.7 m wide",
  "subject": { "kind": "room", "roomType": ["bedroom", "master-bedroom"] },
  "predicate": "minDim", "limit": { "op": ">=", "value": 2.7, "unit": "m" },
  "scope": { "floorUse": ["residential"] }, "severity": "violation" }
{ "id": "USR-no-wet-over-gear", "title": "No wet services over switchgear",
  "subject": { "kind": "element", "elementKind": ["waste", "storm", "dcw", "dhw"] },
  "predicate": "notOver", "object": { "kind": "elementKind", "value": "switchgear" },
  "limit": { "op": "==", "value": true }, "severity": "violation",
  "source": "NEC 2023 110.26(E)(1)(b)" }
```

**Validation** (`validateRuleOverrides`, zero deps): `version === 1`; every `id` matches the `USR-` pattern and is unique; `predicate ∈ PredicateId`; `subject.kind ∈ PREDICATE_SIGNATURES[p].subjects`; `object` present ⟺ the signature declares one, and its `kind` is declared; `typeof limit.value === limitType`; `limit.op` legal for the type; every `scope` enum member is a member of the corresponding union; `params` keys reference existing rules and existing param names; `severity` and `resolution` are members of their unions. Any failure → `Issue{severity:'error', ruleId:'USR-SCHEMA', message}` and that rule is **dropped** (generation continues, deterministically).

**Determinism:** `createRuleSet` sorts by id; `forSubject` returns rules in id order; evaluation iterates subjects in a canonical sort (`storey index → id`). No `Map` iteration order is ever load-bearing.

### 2.7 Structural pre-sizing — `src/disciplines/structure/presize.ts`

```ts
export interface StoreySizing {
  storey: string;
  index: number;
  use: FloorUse | 'site' | 'foundation' | 'roof';
  profileId: ProfileId;
  floorToFloor: number;               // may have been RAISED by the presize
  /** Slab whose soffit forms this storey's ceiling */
  slabTAbove: number;
  /** Structural depth below that slab over the corridor / over the unit */
  beamDAbove: number;
  beamDAboveUnit: number;
  soffitZ: number;
  corridorSoffitZ: number;
  ceilingZ: number;
  corridorCeilingZ: number;
  /** This storey's slab ABOVE is the transfer slab */
  isTransferBelow: boolean;
  transferZoneDepth: number;
  /** Slab of THIS storey (position.z = -slabTOwn), for the detailing pass */
  slabTOwn: number;
}

export interface GridProposal {
  longAxis: 'x' | 'y';
  bay: { min: number; target: number; max: number; source: string };
  transverse: { barId: string; axis: 'x' | 'y'; offsets: number[] }[];
  longitudinal: { barId: string; axis: 'x' | 'y'; offsets: number[] }[];
  parkingModule: { along: number; across: number };
  /** How far a returned party wall may move before structure would have to kink */
  snapTolerance: number;
}

export interface StructuralPresize {
  system: StructuralSystemId;
  foundation: FoundationType;
  loads: Loads;
  sizes: Sizes;                        // { columnW, columnD, beamW, beamD, slabT, shearWallT }
  columnBand: { min: number; max: number };
  coreWallT: number;
  shearWallT: number;
  partyWallT: number;
  exteriorWallT: number;
  corridorWallT: number;
  storeys: readonly StoreySizing[];
  byStorey: Map<string, StoreySizing>;
  /** Corrected storey list (elevations recomputed if any f2f was raised) */
  storeysResolved: StoreyDef[];
  /** Storey whose FLOOR slab is the transfer slab = storeyIdFor(podiumStoreys) */
  transferStorey: string | null;
  /** Storey BELOW it, whose ceiling carries the transfer depth */
  transferBelowStorey: string | null;
  transferSlabT: number;
  transferBeamD: number;
  transferZoneDepth: number;
  podiumStoreys: number;
  gridProposal: GridProposal;
  issues: readonly Issue[];
}

export interface PresizeInput {
  spec: BuildingSpec; typology: TypologyDef; site: SiteModel;
  storeys: readonly StoreyDef[]; profiles: ProfileBook; rules: RuleSet; ledger: Ledger;
}
export function presizeStructure(i: PresizeInput): StructuralPresize;

export function proposeBay(typology: TypologyDef, site: SiteModel, spec: BuildingSpec, rules: RuleSet): GridProposal['bay'];
export function bayOffsets(a0: number, a1: number, bay: GridProposal['bay']): number[];
```

### 2.8 Load path — `src/disciplines/structure/loadpath.ts`

```ts
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
export interface LoadPathNode { support: Support; carriedBy: string | null; via: 'column' | 'wall' | 'transfer' | 'foundation' | null; }
export interface LoadPathResult {
  nodes: readonly LoadPathNode[];
  /** Lowest supports that need a foundation */
  bases: readonly Support[];
  issues: readonly Issue[];
  derived: Record<string, number>;
}
export function checkLoadPath(o: {
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
}): LoadPathResult;
```

### 2.9 Slope / invert — `src/disciplines/plumbing/invert.ts`, `routing.ts`

```ts
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
  /** Where each pumped level's sump sits (set by the caller, read by the discharge router) */
  sumpXY: Map<string, Vec2>;
  issues: readonly Issue[];
}
export function buildInvertModel(o: {
  storeys: readonly StoreyDef[]; groundStorey: string; site: SiteModel; spec: BuildingSpec;
  longestRunM: number; rules: RuleSet; ledger: Ledger;
}): InvertModel;

// routing.ts — sloped-axis capability
export interface OrthoOptions { snap?: number; sloped?: boolean; slope?: number; }
export function orthogonalize(path: readonly Vec3[], o?: number | OrthoOptions): Vec3[];
/** Monotonic fall: each horizontal leg drops slope × its plan length */
export function applyFall(path: readonly Vec3[], slope: number, startZ: number): Vec3[];
export function isOrthogonalOrSloped(a: Vec3, b: Vec3, maxSlope: number, eps?: number): boolean;
export function fallOf(path: readonly Vec3[]): { monotonic: boolean; minSlope: number; maxSlope: number };
```

### 2.10 Resolutions — parking solver, corridor graph

```ts
// src/disciplines/site/parking-solver.ts
export interface ParkingLevel { storeyIndex: number; kind: 'surface' | 'basement' | 'podium'; zone: Rect; capacity: number; }
export interface ParkingPlan {
  type: ParkingType;
  required: number;
  achieved: number;
  basementStoreys: number;
  podiumStoreys: number;
  podiumUse: 'retail' | 'parking' | 'amenity';
  levels: readonly ParkingLevel[];
  ratioRequested: number;
  ratioApplied: number;
  issues: readonly Issue[];
}
/** Pure: upper bound on stalls in a rect. THE single capacity function (packer + solver share it). */
export function stallCapacity(zone: Rect, o?: { stallW?: number; stallL?: number; aisleW?: number; accessible?: number; rampAllowance?: number }): number;
/** Pure: units from the envelope + storeys + frontage, WITHOUT needing bars */
export function estimateUnits(spec: BuildingSpec, typology: TypologyDef, frame: SiteFrame): number;
export function solveParking(o: {
  spec: BuildingSpec; typology: TypologyDef; frame: SiteFrame; estimatedUnits: number;
  rules: RuleSet; ledger: Ledger;
}): ParkingPlan;

// src/disciplines/site/corridor-graph.ts
export interface BreakSlot {
  id: string; barId: string; station: number; length: number;
  want: 'core' | 'lounge' | 'window-bay' | 'knuckle'; reason: string;
}
export interface Knuckle { id: string; barIds: readonly string[]; rect: Rect; want: 'corner-core' | 'lounge'; }
export interface CorridorLeg { id: string; spineId: string; barId: string; centerline: Segment2[]; length: number; }
export interface CorridorGraph {
  spines: CorridorSpine[];                 // legs: Segment2[] populated
  legs: readonly CorridorLeg[];
  breakSlots: readonly BreakSlot[];
  knuckles: readonly Knuckle[];
  deadEnds: readonly { legId: string; end: 'a' | 'b'; length: number }[];
  /** Longest continuous run through the graph (the ARC-03 / IBC 1020 metric) */
  longestRunM: number;
  issues: readonly Issue[];
}
export function buildCorridorGraph(o: {
  bars: readonly MassingBar[]; access: AccessType; width: number; footprintCentroid: Vec2;
  shape: FootprintShape; sprinklered: boolean; rules: RuleSet; ids: IdFactory; ledger: Ledger;
}): CorridorGraph;
```

### 2.11 `core/types.ts` additions (all optional in step 0)

```ts
export interface GenContext {
  /* … existing … */
  presize: StructuralPresize | null;
  kernel: Kernel | null;
  rules: RuleSet;
  issues: Ledger;
  /** @deprecated live projection of `issues`; removed in step 7 */
  warnings: string[];
}
export interface DesignModel { /* … */ issues: Issue[]; }
export interface BuildingSpec { /* … */ rules?: RuleOverrides; }
export interface MassingSpec {
  /* … */
  allowStoreyOverride?: boolean;
  maxBasementStoreys?: number;   // default 3
  maxPodiumStoreys?: number;     // default 3
}
export interface ArchModel {
  /* … */
  /** Actual party-wall lines returned to structure (the handshake) */
  partyLines: { barId: string; axis: 'x' | 'y'; offsets: number[] }[];
  chases: Chase[];
}
export interface StructModel {
  /* … */
  plenumClearance: { corridorSoffitZ: number; byStorey: Record<string, number> };
}
export interface CorridorSpine { /* … */ legs: Segment2[]; }
export interface CorridorDef { /* centerline already Segment2[] — no change */ }
export type StructSlabType = 'floor' | 'roof' | 'ground' | 'podium-transfer' | 'balcony';
// PlumbingFixture['type'] |= 'sump-pit' | 'sewage-ejector'
// DoorDef gains hinge/swing (owned by the door-bug agent; listed here so the type change lands once)
```

---

## 3. Data tables

All numbers below are the literal contents of `src/core/kernel/profiles.ts`, `lanes.ts` and `clearances.ts`, and are exposed as `Rule` records (so the Patterns/Rules tab renders them and generators read them via `rules.num(...)`).

### 3.1 Ceiling profiles

Z is measured **downward from the slab soffit**; `soffitZ = f2f − slabTAbove`. `beamD` = `presize.byStorey.get(s).beamDAbove` (0 for a flat slab).

#### `resi-unit` — dwelling interior. Flat soffit; the only drop is over the service band.
`clearHeight` min 2.30 / target 2.50 — *IBC 2021 §1208.2 (2134 mm); NCC 2022 Table F5.1 (2.4 m habitable); London Housing SPG 3.3.6 (2.5 m)*.
`zones`: `hall-bulkhead` min 2.10 — *IBC 2021 §1208.2 exception (soffits over ≤ ⅓ of the area)*; `bathroom` min 2.10.

| # | band | cls | depth | top below soffit | owner | allows | clr above/below | flex | rationale / source |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `resi-unit/structure` | structure | `beamDAboveUnit` | 0 | structure | slab, beam, drop-panel | – | 1 | Sized by span; nothing else may claim it. *presize / STR-09* |
| 2 | `resi-unit/service-band` | parallel | 0.25 (min 0.15) | +0.05 | shared | duct, dcw, dhw, waste, vent, sprinkler-branch, conduit | 0.05 / 0.05 | 3 | The only dropped zone in the flat: over the hall + wet-wall strip, so the living rooms keep a flat 2.5 m ceiling. *SMACNA Table 5-1 hanger spacing 2.44 m* |
| 3 | `resi-unit/ceiling-void` | void | remainder ≥ 0.05 | – | shared | light, sensor, sprinkler-head, air-terminal | – | 5 | Downlights, detectors, diffuser plenum. |
| 4 | `resi-unit/ceiling` | ceiling | 0.03 | at `ceilingZ` | architecture | – | 2.30 clear below | 2 | *IBC 2021 §1208.2* |

`elsewhere`: `waste`→`chase` ("a stack in a flat ceiling is a slab penetration per storey and an acoustic leak — IPC 2021 §704, ADE §5"); `dcw`/`dhw`/`vent`→`chase`; `panel`→`wall` ("NEC 240.24(D)/(E) excludes bathrooms, clothes closets and over stairs; hall wall only"); `sprinkler-head`→`ceiling` ("deflector 25–300 mm below the ceiling, NFPA 13 2022 §8.6.4.1.1.1").

#### `resi-corridor` — the service spine (XD-02). Lanes run *along*; only crossings need their own depth.
`clearHeight` min 2.10 / target 2.40 — *IBC 2021 §1003.2 (2032 mm means-of-egress headroom); ADB B1 (2.0 m)*.

| # | band | cls | depth | top below soffit | owner | allows | clr above/below | flex | rationale / source |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `resi-corridor/structure` | structure | `beamDAbove` | 0 | structure | slab, beam, drop-panel | – | **1** | **Structure first**: it is fixed by span and cannot be moved to suit a service. *presize / STR-09* |
| 2 | `resi-corridor/sprinkler` | parallel | 0.10 (min 0.08) | +0.025 | plumbing | sprinkler-main, sprinkler-branch | 0.025 / 0.025 | **1** | **Tight to the slab by NFPA 13**: the deflector must sit 25–300 mm below a smooth ceiling, so the main hugs the soffit and branch lines can drop anywhere without jogging round a duct. *NFPA 13 2022 §8.6.4.1.1.1, §9.2.2* |
| 3 | `resi-corridor/service` | parallel | 0.30 (min 0.20) | below #2 + 0.025 | shared | duct, dcw, dhw, hwr, gas, tray-power, tray-data, conduit, busduct, standpipe | 0.05 / 0.05 | 3 | **Ducts are biggest, so they set the depth**; everything else that runs *along* the corridor fits beside them in its own lane (§3.2), not under them. *SMACNA 3rd ed.; ASHRAE Fundamentals Ch. 21* |
| 4 | `resi-corridor/crossing` | crossing | 0.20 (min 0.15) | below #3 + 0.05 | shared | waste, vent, storm, duct (branch), conduit, sprinkler-branch | 0.05 / 0.05 | **2** | **Gravity is least flexible**, so drain *crossings* get their own depth and their own along-stations; a branch duct into a flat and a tray drop cross here too. *IPC 2021 Table 704.1* |
| 5 | `resi-corridor/ceiling-void` | void | remainder ≥ 0.05 | – | shared | light, sensor, air-terminal, sprinkler-head | – | 5 | **Electrical last, most accessible**: the void + tile plane is where trays and their taps are reached for the building's life. *NEC 2023 110.26; NEC 392.30(A) tray support ≤ 1.52 m* |
| 6 | `resi-corridor/ceiling` | ceiling | 0.03 | at `corridorCeilingZ` | architecture | – | 2.10 clear below | 2 | *IBC 2021 §1003.2* |

Depth needed = `beamD + 0.025 + 0.10 + 0.025 + 0.30 + 0.05 + 0.20 + 0.05 + 0.05 = beamD + 0.80`. Flat slab `beamD = 0`: with f2f 3.05 and slabT 0.20 → `soffitZ = 2.85`, `corridorCeilingZ = 2.05` → below the 2.10 minimum by 0.05, so `stackProfile` compresses `crossing` 0.20→0.15 (flexibility 2 is compressed after `service` 0.30→0.25 at flexibility 3) and lands at 2.15 m. **This is why the corridor ceiling is an output of the profile, not an input.**

`elsewhere`: `waste`/`vent`/`dcw`/`dhw` risers → `shaft`; `panel` → `wall` (floor distribution board in the corridor wall); `duct` riser → `shaft`.

#### `parking` — exposed structure, no ceiling.
`clearHeight` min 2.10 / target 2.30 — *IBC 2021 §406.4.1 (2134 mm); AS 2890.1-2004 (2.2 m)*.
`zones`: `accessible-route` min **2.50** — *ADA 2010 §502.5 (98 in = 2489 mm); AS 2890.6 (2.5 m)*; `drive-aisle` min 2.10; `van-stall` min 2.50.

| # | band | cls | depth | owner | allows | clearance | flex | rationale / source |
|---|---|---|---|---|---|---|---|---|
| 1 | `parking/structure` | structure | `beamDAbove` (+0.10 drop panel at columns) | structure | slab, beam, column, drop-panel | – | 1 | Exposed; the drop panel at each column is the governing local obstruction. |
| 2 | `parking/exhaust` | parallel | 0.40 (min 0.30) | mechanical | duct, duct-fitting, fan | 0.05 / 0.05 | 3 | CO/NO₂ extract on the aisle centreline where the clear height is measured, because a stall is 5.4 m deep and never walked under. *IMC 2021 §404.2 (0.75 cfm/ft² = 3.8 L/s·m²); ASHRAE 62.1-2019 Table 6-4 (1.5 L/s·m² with CO/NO₂ control); CO setpoint 25 ppm 1 h TWA, NO₂ 3 ppm* |
| 3 | `parking/jet-fan` | equipment | 0.35 | mechanical | jet-fan | 0.25 below (discharge), 1.0 in front | 3 | Impulse ventilation instead of a full duct network; spacing 15–20 m, thrust ≈ 50 N. *BS 7346-7:2013; NFPA 88A* |
| 4 | `parking/drain` | crossing | 0.15 (min 0.12) **sloped** | plumbing | trench-drain, storm, waste | 0.05 / 0.05 | **1** | Collector trench along the aisle low line, falling **monotonically** toward the sewer / sump. *IPC 2021 §1101.2, Table 704.1 (Ø150 → 1:100)* |
| 5 | `parking/sprinkler` | parallel | 0.10 | plumbing | sprinkler-main, sprinkler-branch, sprinkler-head | 0.025 above | 1 | Dry-pipe in an unheated garage; tight to the soffit. *NFPA 13 2022 §8.3.3, §8.6.4.1.1.1* |
| 6 | `parking/ev-tray` | parallel | 0.10 | electrical | tray-power, conduit, ev-charger | 0.05 | 5 | Tray over the stall **head** (not the aisle), so EV capacity can be added without touching the clear height. *NEC 2023 625.40, 392.30(A)* |
| 7 | `parking/lighting` | parallel | 0.12 | electrical | light, sensor | 0.05 | 5 | 1 luminaire / 81 m² (today `devices.ts:416`), now `ELE-06.parkingLightingM2`. |
| 8 | `parking/clear` | clear | to FFL | none | – | – | 1 | Nothing may occupy this band. |

**Keep-out (NEC 110.26(E)):** `keepOut({ owner:'electrical', kind:'switchgear', boxes: footprint × [0, min(1.80, soffitZ)], bans: ['waste','vent','storm','trench-drain','dcw','dhw','hwr','gas','duct'] })` — *"Foreign systems shall not be located in this zone", NEC 2023 110.26(E)(1)(b)*. Sprinkler piping is **permitted** in the dedicated space provided drip protection is installed — *NEC 2023 110.26(E)(1)(c)* — so `sprinkler-*` is excluded from `bans` and instead raises `Issue{severity:'info', ruleId:'ELE-13.dripProtection'}`.

#### `retail-shell` — shell and core with a deep tenant plenum.
`clearHeight` min 2.70 / target 3.20 — *IBC 2021 §1208.2 + landlord shell standard*.

| # | band | cls | depth | owner | allows | flex | rationale / source |
|---|---|---|---|---|---|---|---|
| 1 | `retail/structure` | structure | `beamDAbove` | structure | slab, beam, drop-panel | 1 | |
| 2 | `retail/transfer` | structure | `transferZoneDepth` (1.20 = 0.90 beam + 0.30 slab) **only on `transferBelowStorey`** | structure | beam, slab | 1 | The podium/tower interface eats the top 1.2 m; nothing MEP may enter it. *STR-04; TRANSFER = {slabT 0.30, beamD 0.90}* |
| 3 | `retail/landlord` | parallel | 0.30 (min 0.25) | shared | sprinkler-main, duct, dcw, waste, tray-power, standpipe | 2 | Base-build grid + smoke extract + landlord power, tight under the structure and **capped at the demise**. |
| 4 | `retail/tenant-plenum` | void | **1.00 (min 0.70)** | none | – | 4 | Reserved empty for the tenant's own fit-out; a landlord service inside it gets cut on the first fit-out. |
| 5 | `retail/tenant-ceiling` | ceiling | 0 (not built) | – | – | – | |

`elsewhere`: every `waste`/`vent`/`dcw`/`dhw`/`storm` **tower stack** → `shaft` ("a tower stack in a tenant plenum is cut at the first fit-out; enclose it in a 1-hour chase inside a demising or core wall — *IBC 2021 §713.4, §708*"); landlord services crossing a demise line terminate in a capped, valved, metered assembly within `rules.num('XD-07.demiseCapDistance', 1.0)` m of the line (predicate `cappedAtDemise`).

#### `mep-room` — equipment clearances, plinths, drains, no ceiling.
`clearHeight` min 2.10 / target 2.30 — *IMC 2021 §306.3 appliance access*.

| # | band | cls | depth | owner | allows | rationale / source |
|---|---|---|---|---|---|---|
| 1 | `mep/structure` | structure | `beamDAbove` | structure | slab, beam | |
| 2 | `mep/overhead` | parallel | 0.45 | shared | duct, all pipe kinds, tray-power, tray-data, conduit | Everything overhead, tight to the soffit, so the floor stays clear for equipment replacement. |
| 3 | `mep/access` | clear | to 2.10 above FFL | none | – | Nothing but equipment inside its own footprint + plinth. |
| 4 | `mep/plinth` | equipment | 0.15 above FFL | shared | plinth, pump, tank, ahu, ejector | Housekeeping pad. *IMC 2021 §303.3* |

Equipment clearances (same table as §3.4): switchgear front 1.07, boiler/water heater 0.60 all round + 0.75 at the burner (*IMC 2021 §306.3*), pump 0.60, tank 0.60 + 1.00 at the manway. Floor drain: 1 per 40 m², max 6 (*IPC 2021 §1101, §802 indirect wastes*) — matches today's `buildFloorDrains` ratio, now `PLB-07.drainPerM2`.

#### `roof-plant` — Z measured **up** from the roof slab.
Plinth 0.15; plant envelope 0–2.50; access aisle 1.00 between rows (matches `PlantGrid` today); edge setback 2.00 from a parapet < 1.10 m (*OSHA 1910.28(b)(13); EN 13374 Class A*); duct/pipe crossings on sleepers ≥ 0.15 above the membrane (never on it); PV row pitch from the plant zone. `clearHeight` (walkway) 2.00 — *OSHA 1910.25*.

#### `lobby` / `amenity` / `basement-service`
`lobby`: `resi-corridor` band order, ceiling target 2.70 (min 2.40) — *IBC 2021 §1208.2*.
`amenity`: as `lobby`, target 3.00.
`basement-service`: as `parking` plus a `basement/sump` equipment band at the low point; all drain inverts referenced to `InvertModel`, and any level whose invert is below `sewerInvertSite` is a `pumpedStorey`.

### 3.2 Lane table — `resi-corridor` (corridor width 1.70 m nominal)

Offsets are from the corridor centreline, **positive toward `CorridorSpine.loaded === 'left'`**.

| lane | owner | band | offset | width | min w | height | v-align | allows | source |
|---|---|---|---|---|---|---|---|---|---|
| `sprinkler` | plumbing | `sprinkler` | 0.00 | 0.12 | 0.10 | 0.10 | top | sprinkler-main, sprinkler-branch | Ø50 main + hanger; *NFPA 13 2022 §8.6.4.1.1.1* |
| `duct` | mechanical | `service` | 0.00 | 0.60 | 0.45 | 0.30 | top | duct, duct-fitting | 500 × 300 trunk + 50 mm insulation each side; *SMACNA 3rd ed.* |
| `gravity` | plumbing | `crossing` | −0.45 | 0.30 | 0.22 | 0.20 | top | waste, vent, storm | Ø100 + 50 mm fall allowance; *IPC 2021 Table 704.1* |
| `pressure` | plumbing | `service` | −0.75 | 0.30 | 0.20 | 0.15 | middle | dcw, dhw, hwr, gas, standpipe | Ø50 DCW + Ø32 DHW at 60 mm centres + 25 mm insulation; *ASHRAE 90.1 Table 6.8.3-1* |
| `tray-power` | electrical | `service` | +0.45 | 0.34 | 0.32 | 0.10 | bottom | tray-power, busduct, conduit | 300 × 100 tray + 20 mm each side; *NEC 2023 392.18(A)* |
| `tray-data` | electrical | `service` | +0.72 | 0.22 | 0.20 | 0.05 | bottom | tray-data | 200 × 50 tray, ≥ 0.15 m from power for EMC; *BS 7671 §528.1; EN 50174-2 Table 8* |

`requiredCorridorWidth = 2 × (0.72 + 0.11) = 1.66 m`. For a 1.50 m corridor (`typology.corridorWidth` default), `laneSetFor` scales offsets by `1.50/1.66` with widths floored at `minWidth`; if `Σ minWidth` still does not fit, the `overflowLaneId = 'pressure'` lane drops into the `crossing` band and an `info` issue records it.

**This fixes two real clashes in the current code:** `DEFAULT_LANES` (`coordination.ts:39`) puts `sprinkler` at −0.15 and `pipe` at −0.35 *with no widths and the same Z* (`sprinklerZ === pipeZ === trayZ`), so a Ø150 storm main and the Ø50 sprinkler main are 0.20 m apart at the same height; and `tray` at +0.35 with `tray-data` at +0.50 (`panels.ts:322`) leaves only 0.15 m between two tray centres that are 0.30 and 0.20 wide.

### 3.3 Hanger, spacing and slope tables

`HANGERS` — `maxDrop` is the hanger-rod length used by `supported`:

| kind | max drop (m) | max spacing (m) | source |
|---|---|---|---|
| duct rect | 1.50 | 2.44 | SMACNA HVAC Duct Construction Standards 3rd ed. Table 5-1 |
| duct round ≤ Ø600 | 1.50 | 3.66 | SMACNA Table 5-2 |
| pipe copper Ø ≤ 25 | 1.20 | 1.83 | IPC 2021 Table 308.5 |
| pipe copper Ø ≥ 32 | 1.20 | 3.05 | IPC 2021 Table 308.5 |
| pipe PVC/ABS drain | 1.20 | 1.22 | IPC 2021 Table 308.5 |
| pipe cast iron | 1.20 | 1.52 + every joint | IPC 2021 Table 308.5 |
| sprinkler Ø25–Ø50 | 0.90 | 3.66 | NFPA 13 2022 Table 9.2.2.1 |
| tray-power / tray-data | 1.50 | 1.52 | NEC 2023 392.30(A); NEMA VE-2 |
| busduct | 1.50 | 1.52 | NEC 2023 368.30 |

`SLOPES`:

| system | Ø (m) | min slope | source |
|---|---|---|---|
| sanitary | ≤ 0.075 | 1:50 | IPC 2021 Table 704.1 (¼ in/ft) |
| sanitary | 0.10–0.15 | 1:100 | IPC 2021 Table 704.1 (⅛ in/ft) |
| sanitary | ≥ 0.20 | 1:200 | IPC 2021 Table 704.1 (1/16 in/ft) |
| sanitary (UK/IE) | 0.10 | 1:80 | BS EN 12056-2 §6.3; ADH Table 10 |
| storm horizontal | any | 1:100 | IPC 2021 Table 1106.2 |
| parking trench drain | – | 1:100 | IPC 2021 §1101.2 |
| condensate | – | 1:100 | IMC 2021 §307.2.2 |
| trap arm, max fall | – | 1:48 | IPC 2021 §1002.2 |
| any gravity, max | – | 1:12 | steeper → make it a vertical leg |

`TRAP_ARMS` (**corrects `tables.ts:245-249`, which mis-bins Ø50 at 1.5 m**):

| trap Ø (m) | max developed trap arm (m) | source |
|---|---|---|
| 0.032 (1¼ in) | 1.07 | IPC 2021 Table 1002.2 |
| 0.040 (1½ in) | 1.52 | IPC 2021 Table 1002.2 |
| 0.050 (2 in) | **1.83** | IPC 2021 Table 1002.2 |
| 0.075 (3 in) | 3.05 | IPC 2021 Table 1002.2 |
| ≥ 0.100 | 3.05 | IPC 2021 Table 1002.2 |

### 3.4 Clearance table (`CLEARANCES`, queried by `clearanceBetween`)

| a | b | min (m) | kind | source / why |
|---|---|---|---|---|
| duct | slab (soffit) | 0.05 | install | SMACNA hanger + flange |
| duct | duct | 0.05 | install | |
| duct | tray-power | 0.05 | install | tray must be **below** |
| sprinkler-head | ceiling | 0.025–0.30 | fire | NFPA 13 2022 §8.6.4.1.1.1 (deflector distance) |
| sprinkler-head | any obstruction | 0.45 (or 3 × obstruction width) | fire | NFPA 13 2022 Table 8.6.5.1.2 |
| switchgear / panel | any (front) | **1.07** | electrical-safety | NEC 2023 Table 110.26(A)(1) Cond. 2 |
| switchgear / panel | any (width) | max(0.76, equipment width) | electrical-safety | NEC 2023 110.26(A)(2) |
| switchgear / panel | any (height) | 2.00 | electrical-safety | NEC 2023 110.26(A)(3) |
| switchgear (dedicated space above) | **any foreign system** | footprint × 1.80 — **forbidden** | electrical-safety | NEC 2023 110.26(E)(1)(a)+(b) |
| switchgear (dedicated space) | sprinkler-* | permitted **with drip protection** | electrical-safety | NEC 2023 110.26(E)(1)(c) |
| dcw | waste (crossing) | 0.05 vertical, **dcw above** | potable | IPC 2021 §603.2 |
| dcw | waste (buried) | 0.30 horizontal / 0.45 vertical | potable | IPC 2021 §603.2 |
| gas | any electrical | 0.05 | fire | BS 6891 §8.11; NFPA 54 |
| tray-power | tray-data | 0.15 | EMC | BS 7671 §528.1; EN 50174-2 Table 8 |
| any MEP | beam / column | **no penetration** | structural | No designed openings in this model; sleeves only through slabs and non-structural walls |
| any MEP | elevator shaft | **forbidden** | code | IBC 2021 §3005.3 (hoistway shall contain no piping/ducting not serving the hoistway); ASME A17.1 §2.8 |
| boiler / water heater | any | 0.60 all round, 0.75 at the burner | access | IMC 2021 §306.3 |
| pump / tank | any | 0.60 (1.00 at a manway) | access | IMC 2021 §306.3 |
| roof plant row | roof plant row | 1.00 | access | current `PlantGrid` aisle |
| roof plant | parapet < 1.10 m | 2.00 | fall | OSHA 1910.28(b)(13); EN 13374 |

### 3.5 `ROUTE_HOME` and `MOVE_COST` (the "what stays where" / "easy vs hard to move" tables)

`ROUTE_HOME` (excerpt; the full table has one row per `ElementKind` × profile):

| kind | home | why | source |
|---|---|---|---|
| waste, vent | chase (unit) / shaft (tower) | one invert, one slope: a drain cannot be rerouted after the slab is poured | IPC 2021 §704, §708 |
| dcw, dhw, hwr | chase / shaft, then `pressure` lane | pressure services can rise, fall and offset — they take the squeeze | IPC 2021 §305 |
| duct (trunk) | ceiling, `duct` lane | biggest section; hung from the slab both sides | SMACNA |
| duct (unit branch) | `crossing` band over the entry door, then the unit service band | keeps the living-room ceiling flat | MEC-02 |
| sprinkler-main | ceiling, tight to soffit | deflector distance forces it | NFPA 13 §8.6.4.1.1.1 |
| tray-power, tray-data | ceiling void, bottom of the plenum | must stay reachable from a tile for the building's life | NEC 110.26 |
| panel | wall (hall / corridor / plant room) | needs a 1.07 m working space and cannot be in a bathroom, closet or over stairs | NEC 240.24(D)/(E) |
| switchgear | plant room floor + plinth | dedicated space above must stay free of foreign systems | NEC 110.26(E) |
| sump, ejector | floor pit, plant room / lowest level | gravity horizon | IPC 2021 §712 |
| ev-charger, tray | parking, over the **stall head** | so capacity can be added without touching clear height | NEC 2023 625.40 |

`MOVE_COST` — the ordering that justifies the band sequence:

| flexibility | cost | kinds | why |
|---|---|---|---|
| 1 | fixed | slab, beam, column, drop-panel, waste, vent, storm, trench-drain, sprinkler-main | poured, or has one invert / one code-mandated soffit distance |
| 2 | hard | shaft-void, standpipe, transfer zone, ceiling plane | changing these changes the architecture |
| 3 | medium | duct, fan, ahu, air-terminal | re-sizeable but only in whole-section steps |
| 4 | easy | dcw, dhw, hwr, gas, tenant plenum | offsets and drops are free |
| 5 | trivial | tray-power, tray-data, conduit, light, sensor, ev-charger | altered many times over the building's life; must stay accessible |

---

## 4. Algorithms

### 4.1 `stackProfile` — band resolution, compression, drop, raise (deterministic)

```
soffitZ        = f2f - slabTAbove
structureDepth = beamDAbove (or transferZoneDepth on transferBelowStorey)
minClear       = max(profile.clearHeight.min, max over zones of zone.minClear where the zone exists on this storey)
available      = soffitZ - structureDepth - minClear
need           = Σ over non-structure bands of (depth + clearanceAbove + clearanceBelow)

if need <= available:
    place bands top→bottom at natural depth; the `void` band absorbs available - need
    ceilingZ = soffitZ - structureDepth - need - voidDepth
else:
    short = need - available
    for band in bands sorted by (flexibility DESC, id ASC):          # most flexible squeezed first
        give = min(short, band.depth - band.minDepth)
        band.depth -= give; band.compressedBy = give; short -= give
        if give > 0: ledger.addOnce('compress:'+band.id, info, 'XD-02.bandDepth', resolution compress-band)
        if short <= 1e-9: break
    if short > 1e-9:
        for band in bands sorted by (flexibility DESC, id ASC) where band.droppable:
            band.dropped = true; short -= band.depth + band.clearanceAbove + band.clearanceBelow
            ledger.add(info, 'XD-02.bandDropped', resolution drop-band)
            if short <= 1e-9: break
    if short > 1e-9:
        raiseFloorToFloorTo = roundUpTo(f2f + short, 0.05)
        ledger.add(deviation, 'XD-02.plenumDepth', resolution raise-floor-to-floor, from f2f, to raised)
```

The `raise` branch is returned to **presize**, which rewrites `floorToFloor` and recomputes every storey elevation into `storeysResolved`; the pipeline uses that list from then on. That is why band resolution must happen in the presize pass, not in a discipline.

### 4.2 `reserve` — conflict resolution inside the owner's band

```
reserve(req):
  if req.container == 'band':
      p    = profileOf(req.storey, req.roomType)
      band = p.band(req.purpose ?? PURPOSE_OF[req.kind])
      if !band or band.dropped          -> Conflict('no-band',        ruleId 'XD-02.bandExists')
      if !band.allows.includes(req.kind)-> Conflict('kind-not-allowed', ruleId 'XD-02.bandAllows')
      for each box: if box.z < band.z0 - tol or box.z + box.h > band.z1 + tol
                                        -> Conflict('outside-band',   ruleId 'XD-02.inBand')
  # keep-out test: ONLY against keepout reservations that ban this kind (grid broadphase)
  for r in keepOutsOverlapping(req.storey, boxes):
      if r.bans.includes(req.kind)      -> Conflict('keepout', with [r.id], ruleId of the banning rule)
  record(reservation); return it
```

Conflicts *between* two ordinary reservations are impossible by construction and are therefore never tested: bands are disjoint in Z, lanes are disjoint in lateral extent within a band, shaft zones are disjoint in XY, chases are disjoint per wall. The only pairwise test in the whole kernel is against `keepout` reservations, of which there are ~200 on the largest preset.

`reserveLaneRun`:
```
lane  = laneOf(storey, req.laneId);  band = profileOf(storey).band(lane.bandPurpose)
alloc = lateralAllocator(storey, lane.id)                     # memoised per (storey, lane)
span  = alloc.claim(req.systemKey, min(req.width, lane.width))
if !span:
    # deterministic fallback: push into the crossing band, one step down
    fall = profileOf(storey).band('crossing')
    if fall and fall.allows.includes(req.kind): band = fall; span = stationFallback(...)
    else return Conflict('lane-full', ruleId 'XD-02.laneWidth')
z     = vAlignZ(band, lane, span)                             # top / middle / bottom of the band
path  = lanePathIn(centerline, lane, z, span.centre - lane.offset)
res   = reserve({ …, boxes: laneBoxes(path, span.b - span.a, lane.height) })
return { path, width: span.b - span.a, height: lane.height, lane, band, reservation: res }
```
`alloc.claim` is **idempotent and call-order independent**: the k-th sub-interval is assigned by the index of `systemKey` in `lane.systemOrder`, measured from the lane's inboard edge, so the same spec always produces the same lateral position regardless of which discipline asks first.

`reserveCrossing` (a branch or drain crossing the lane set):
```
band  = profileOf(storey).band('crossing')
alloc = stationAllocator(storey, band.id, pitch = rules.num('XD-02.crossingPitch', 0.30))
hit   = alloc.claim(key, req.station, req.length)             # +p, -p, +2p, -2p, … ≤ 40 steps
if !hit: return Conflict('band-full', ruleId 'XD-02.crossingPitch')
path  = crossingPath(centerline, hit.station, req)            # perpendicular crossing at the band's Z
if req.slope: path = applyFall(path, req.slope, z)            # controlled fall inside the band depth
return { path, z, shiftedBy: hit.shifted, reservation: reserve({…}) }
```
**Because the shift happens before emission, a clash is never emitted** — the only observable trace is `Reservation.shift` and an `info` issue when `|shifted| > 0`.

### 4.3 Shaft slot allocation (one function, three consumers)

```
slot(req):
  shaft = registered(req.shaftId);  if !shaft -> Conflict('no-shaft')
  zone  = SHAFT_ZONE_OF[req.system]                    # plumbing | mechanical | electrical | trash
  key   = `${req.shaftId}|${req.discipline}|${req.system}`
  if memo.has(key) return memo.get(key)                # idempotent
  # 1. split the shaft rect into zones along its LONG axis, in a fixed order:
  #      [plumbing 35%] [mechanical 35%] [electrical 22%] [trash 8%]   (normalised, min 0.20 m each)
  zr    = zoneRect(shaft.rect, zone)
  # 2. pack within the zone, in SHAFT_SYSTEM_ORDER, first-fit along the zone's long axis, gap 0.05
  #    `wantWall` systems (risers) are pushed against the zone's outer face (support from the shaft wall)
  spot  = packInZone(zr, SHAFT_SYSTEM_ORDER, req)
  if !spot:
      bigger = shafts.nearestWithRoom(rectCenter(shaft.rect), req)
      if bigger: return slot({ …req, shaftId: bigger })            # recorded as info 'XD-04.shaftOverflow'
      return Conflict('shaft-full', ruleId 'XD-04.shaftArea',
                      message 'shaft <id> needs <n> m² for <k> systems; it has <a> m²')
  memo.set(key, slot); reserve({ container:'shaft', containerId:shaft.id, boxes: perStoreyBoxes(spot, req.storeys) })
```
The zone split *preserves today's convention* (plumbing toward one corner, electrical toward the other, mechanical in the middle) so existing tests still pass conceptually, but now with **footprints**, so two Ø150 risers can no longer be assigned the same 0.15 m corner.

### 4.4 Chases

```
chase(req):
  key = req.unitId; if memo.has(key) return it
  # the module's wet-wall PORT gives the station; the chase is centred on it
  length    = Σ over systems of (OD + insulation) + gaps 0.02, min 0.30
  thickness = wallThickness (0.20 wet wall) - 2 × 0.02 finish
  xy        = segPointAt(wall, clamp(station, length/2, wallLen - length/2))
  systemXY  = the systems laid out along the wall in SHAFT_SYSTEM_ORDER, waste FIRST at the centre
              (it governs the trap arms), the rest alternating ±  — replaces stacks.ts:440-446
  reserve one box per storey, container 'chase'
  # sleeves at every rated-wall / slab crossing
  for storey in req.storeys: sleeve({ hostKind:'slab', z:0, … }) per system
```
The chase **is** the stack station, so `stacks.ts`'s `primaryWall` / `bestStationFor` / `stationsForGroup` / second-stack machinery is deleted outright: a dwelling gets exactly one chase because its module declares exactly one wet-wall port.

### 4.5 Load path

```
checkLoadPath:
  1. index supports per storey: columns by round(xy, 0.05) key; walls bucketed by constant coordinate
  2. for storey k from top to bottom:
       for each support s on k:
         hit = column on k-1 with the same key within tol (0.15)
            || wall on k-1 whose segment contains s.xy within tol
         if hit: s.carriedBy = hit; continue
         tb = transfer beam on k-1 whose axis passes within tol/2 of s.xy
              AND whose BOTH ends land within tol of a support on k-1
         if tb: s.carriedBy = tb; via = 'transfer'; continue
         issue(violation, 'STR-C1.columnContinuity', storey k, elementIds [s.id],
               'column/wall <id> on <k> lands on nothing below')
  3. cores / shear walls: every core wall LINE must appear on every storey from the lowest framed
     storey to its top storey  ->  violation 'STR-C3.coreContinuity'
  4. bases (lowest support on each vertical line): a foundation rect must contain its xy
        ->  violation 'STR-C2.foundationUnderSupport'
     (this replaces `index.ts:881-882`, which takes footings only from the lowest storey's COLUMNS)
  5. slab edge: sample each slab outline every 1.0 m; each sample must be within
     maxCantilever = min(2.0, 10 × slabT)  of a rim beam / bearing wall / column line
        ->  violation 'STR-C4.slabEdgeSupport'        [ACI 318-19 Table 9.3.1.1, ℓ/10 cantilever]
  6. balconies: L = cantilever, B = backspan into the slab from the supporting line
     require L <= min(maxCantilever, B/2) and thickness >= max(0.18, L/10)
        ->  violation 'STR-C5.balconyCantilever'       [ACI 318-19 Table 9.3.1.1; Eurocode 2 §7.4.2]
     structure records the verified balcony ids in derived; architecture keeps emitting the geometry
```
Complexity: O(Σ supports) with hash lookups ≈ 2 000 nodes on the tower → ~3 ms.

### 4.6 Support / connectivity checks (`checkSupport`)

1. **No free-floating MEP.** Every `axis`/`box` MEP element must map to a reservation (from `validate()`). Then, for `container === 'band'`: `soffitZ − z ≤ HANGERS[kind].maxDrop` → else `XD-S1` violation. For `container ∈ {wall, chase, shaft, floor, plinth}`: supported by definition. No reservation at all → `XD-S0` violation (`'free-floating <kind> <id>'`).
2. **Riser continuity.** Group vertical `axis` elements by rounded XY (0.05). For each group, the set of storeys it spans must be contiguous, and for every storey in the span a shaft-slot or chase reservation for that system must exist on that storey → else `XD-S2` violation (`'riser passes <storey> where shaft <id> does not exist'`).
3. **Slope monotonicity.** For each `waste`/`storm`/`trench-drain` run: `fallOf(path)` must be `monotonic` in the flow direction, `minSlope ≥ SLOPES[system][Ø]` and `maxSlope ≤ 1:12` → else `PLB-S1`. Pressure runs use the existing `isOrthogonal`.
4. **Reachability.** Union-find over all plumbing run endpoints keyed at 0.05 m, with stacks, the building drain and sumps as sentinel nodes. Every fixture must be in a component containing a stack (`PLB-S2`); every stack in a component containing a building-drain or sump node (`PLB-S3`); every sump's ejector discharge must terminate on a gravity node above `sewerInvertSite` (`PLB-S4`). O(n α(n)) over 25 k endpoints ≈ 20 ms.
5. **No penetration of structure.** Each MEP box tested against `keepout` reservations from structure detailing (beams, columns, drop panels, elevator-shaft prisms) using the same grid broadphase; interior overlap only (touching a soffit is legal) → `XD-S5` violation.

### 4.7 Invert model

```
slope        = SLOPES['sanitary'][Ø100]                        # 1:100 (US) / 1:80 (UK, IE)
cover        = rules.num('PLB-07.drainCover', 0.45)            # IPC 2021 §305.4.1; BS EN 752 0.6 under paving
sewerInvert  = -(cover + slope * longestRunM + 0.15)
sewerInvert  = clamp(sewerInvert, -3.0, -1.2)                  # -1.2 reproduces today's SEWER_Z
sewerSite    = storeyElevation(groundStorey) + sewerInvert     # SITE datum

for storey ascending:
    reach = developed length from the storey's furthest stack to the lateral exit
    drainInvertZ[storey] = sewerInvert + slope * reach          # upstream invert, storey-local
    if storeyElevation(storey) + drainInvertZ[storey] < sewerSite + 0.05:
        pumpedStoreys.push(storey)                              # gravity horizon crossed
```
Each pumped level gets, at the downstream end of its `parking/drain` collector: a `sump-pit` (0.9 × 0.9 × 1.2, vent Ø50 to roof — *IPC 2021 §712.1*), a **duplex** `sewage-ejector` (*IPC 2021 §712.4.2, §1113.1.2 alternating duplex*), a check valve + gate valve, and a Ø80 discharge routed in the **pressure** lane (rising, therefore exempt from the slope rule) up to the gravity building drain at the lowest gravity level. `PLB-C7.pumpedToGravity` verifies the termination.

### 4.8 Parking solver

```
units = estimateUnits(spec, typology, frame)                   # pure; extracted from buildMassing
required = type === 'none' ? 0 : ceil(units * ratio)
plan.levels = []
if type === 'surface': plan.levels = surfaceYards(frame)       # existing yard ranking, via stallCapacity
while achieved < required and plan.basementStoreys < rules.num('SIT-07.maxBasementStoreys', spec.massing.maxBasementStoreys ?? 3):
    plan.basementStoreys++
    cap = stallCapacity(inset(frame.env, 0.4), { rampAllowance: RAMP_W * RAMP_L })
    plan.levels.push({ kind:'basement', capacity: cap, … })
    ledger.add(info, 'SIT-07.parkingLevels', resolution add-basement-level, from n-1, to n)
while achieved < required and podiumAllowed and plan.podiumStoreys < rules.num('SIT-07.maxPodiumStoreys', 3):
    plan.podiumStoreys++; …                                     resolution add-podium-level
if achieved < required:
    plan.ratioApplied = achieved / max(1, units)
    ledger.add(deviation, 'SIT-07.parkingRatio', resolution relax-parking-ratio,
               from ratio, to ratioApplied)                     # NOT a warning any more
```
`solveParking` runs in `generateSite` **before** `buildMassing`; its `basementStoreys` / `podiumStoreys` feed `resolveFloors` + `buildStoreys`, which are recomputed once. `buildMassing`'s own `estimatedUnits` must agree with `estimateUnits` within ±2 (a test). On `ca-point-tower` this turns today's *"85 required, 57 achieved"* warning into `basementStoreys: 2` (114 ≥ 85) and an `info` issue.

### 4.9 Corridor graph

```
for each bar: build the centreline as buildCorridors does today (mid-depth, or hard against the
              inner face for single-loaded / gallery)
maxLeg   = rules.num('ARC-03.maxLegLength', 45)                  # ARC-03 parameter, today unread
n        = ceil(len / maxLeg)
split into n equal legs; at each interior joint emit a BreakSlot of
              rules.num('ARC-03.breakSlotLength', 5.0) m, want = 'core' for the most central, else 'lounge'
if shape in {L, U, O}: for each pair of bars that meet, emit a Knuckle at the overlap rect and
              JOIN the two centrelines through it  ->  an O-plan has ONE cyclic corridor, not four
              want = 'corner-core' when placeCores has a core to spend there, else 'lounge'
deadEnds: a leg end that is neither a knuckle nor within
              rules.num('SIT-08.deadEnd', sprinklered ? 15 : 6) m of an exit
              ->  place a core at that end (want 'core') or shorten the leg; info 'split-corridor'
longestRunM = longest simple path through the leg graph      # the IBC 1020 / ARC-03 metric
```
`placeCores` consumes `breakSlots` first (a core inside a break slot costs no corridor length), then falls back to `alongPositions`; separation is enforced against the slot list, which removes the *"4 cores 11.5 m apart"* pathology. The modules placer consumes `breakSlots` as blocked intervals on the bar frame and lays units out **per leg**.

---

## 5. Migration — ordered so the repo stays green

`npm test` and `npm run typecheck` must pass after **every** step.

**Step 0 — contracts only.** Add every new field in §2.11 to `core/types.ts` as **optional**; add `'sump-pit' | 'sewage-ejector'` to `PlumbingFixture['type']` and `'balcony'` to `StructSlab['type']`; add `legs?: Segment2[]` to `CorridorSpine`. Update `CONTRACT.md` (it currently forbids touching `types.ts`; replace that clause with "core owns `types.ts`; disciplines request additions"). Nothing behavioural. *Green: no test sees a change.*

**Step 1 — rules + ledger.** Land `src/core/rules/**`. `createLedger({ mirrorInto: warnings })` pushes into the same `warnings: string[]` the pipeline already threads, so **every existing warning string is byte-identical**. Wire `ctx.rules`/`ctx.issues` in `pipeline.ts`; `DesignModel.issues = ledger.all()`. Land `rulesFromPatterns` over all 100 patterns. *Green: `warnings` unchanged; new `rules.test.ts`.*

**Step 2 — kernel profiles/lanes/clearances + compatibility shim.** Land `src/core/kernel/**` except `registry.ts`. Re-implement `coordination.ts` as a shim: `MOUNTING` re-exported from `kernel/mounting.ts`; `SIZES` re-exported from `kernel/sizes.ts` **plus** the two doomed keys still present; `plenumBands(f2f, slabT, beamD, ceiling)` implemented on top of `stackProfile('resi-corridor')` and asserted (in `kernel.test.ts`) to reproduce the old `ductZ`/`pipeZ`/`sprinklerZ`/`trayZ` within 1 mm for the four preset geometries, so `mechanical.test.ts:165` and the plumbing band assertions still pass. `DEFAULT_LANES` becomes a projection of the new lane table's offsets. *Green: MEP untouched.*

**Step 3 — presize.** Land `presize.ts`; insert the pipeline slot between site and architecture; publish `ctx.presize` and use `presize.storeysResolved`. Change consumers with a fallback so each can be done independently:
- `architecture/index.ts:262` → `ctx.presize?.byStorey.get(s.id)?.slabTAbove ?? SIZES.slabT`
- `cores.ts:101,290,342,439` → `ctx.presize?.coreWallT ?? SIZES.coreWallT`
- `structure/index.ts:94-98,178-181,187-203` → read `presize`
- **Delete** `structure/index.ts:205-209` and `:530-533` and the `designThicknessWarned` flag.
- **Fix the transfer off-by-one**: `transferStorey = storeyIdFor(podiumStoreys)`; `transferBelowStorey = storeyIdFor(podiumStoreys - 1)` gets `slabTAbove = 0.30` and `transferZoneDepth = 1.20`. Architecture's `0.25` ternary is gone, so the two numbers can no longer differ.
*Green: update `structure.test.ts:365-375` to read from `presize`; add `presize.test.ts`.*

**Step 4 — registry + allocators + MEP consumption, one discipline at a time.**
4a. `registry.ts`, `validate.ts`, `shafts.ts`, `chases.ts`, `sleeves.ts`; `ctx.kernel` created after architecture; structure detailing registers keep-outs.
4b. **Mechanical**: `context.ts:21,237,239-271,246,248-249` → `kernel.profileOf`; delete `beamDepthUnder` (`:288-295`), `shaftSlots`/`nextShaftSlot`/`claimShaftXY`/`centreClaimed` (`:204,394-412`), the plenum-tight warning (`:268-270`) and `unitDuctBand` (`:713-730`); `building.ts:8,56,90-105,226-238` → `kernel.reserveLaneRun` / `kernel.reserveRiser`; delete `placement.ts:370-401` (`shaftSlot`, `SHAFT_SLOT_CAPACITY`, `nearestShaft`). Rewrite `mechanical.test.ts:343` from "risers take the shaft centre" to "every riser slot is disjoint and inside its discipline's zone".
4c. **Plumbing**: `state.ts:22,112-113,137-151` → kernel + presize; `emitAxis`/`emitRun` gain a required `reservation`; `fixtures.ts:70-113` `chooseWall` → `portFor` (chase + `unit.wetWallIds` only, **no 6 m fallback, no `VW-` virtual wall**); **delete** `fixtures.ts:184-231` (synthesised bathrooms) and `:233-255` (synthesised kitchen sink); replace `stacks.ts:103-238` with `kernel.chaseOf(unitId)` and delete `MAX_STACKS_PER_GROUP`, `MAX_STACKS_HARD`, `MAX_VENTED_BRANCH`, `bestStationFor`, `primaryWall`, `stationsForGroup` and the three `warn` calls at `:138,:167,:170`; `stacks.ts:440-451` → `chase.systemXY` + `kernel.shafts.slot`; `service.ts:8,42-53,168,178,286` → kernel lanes; `sprinkler.ts:11,276,281,285` → the `sprinkler` lane; **delete** `storm.ts:31-33` `plumbingShaftCorner` and its re-export (`index.ts:30`); fix `tables.ts:245-249` to the corrected `TRAP_ARMS` rule table.
4d. **Electrical**: `panels.ts:11,302,317-322` → `kernel.reserveLaneRun`; **delete** `beamDepthFor` (`:365-369`) and the inline max-corner riser XY (`:385`); `placeServiceEquipment` and `placeEvPanel` register the NEC 110.26 working space + dedicated space as `keepOut` reservations; `:70,:183` → `ctx.issues.add`; `devices.ts:416` → `rules.num('ELE-06.parkingLightingM2', 81)`.
*Green after each sub-step: that discipline's own test file, adjusted only where it asserted a discipline's private convention.*

**Step 5 — constructability.** `loadpath.ts` + `kernel/support.ts` + `invert.ts` + sloped axes + sump/ejector. `routing.ts:44-49,60-79` gain `isOrthogonalOrSloped` / `OrthoOptions` (number overload preserved). **Delete** `state.ts:34-35` (`BUILDING_DRAIN_Z`, `SEWER_Z`) and `index.ts:32-33` re-exports, plus the basement warning at `service.ts:268-271`; rewrite `buildBuildingDrain` (`service.ts:276-360`) around per-level collectors from `InvertModel`. `structure/index.ts:665-692` — transfer beams move from grid lines onto **the columns they carry**; footings come from `loadpath.bases`, not `index.ts:881-882`. `plumbing.test.ts`'s Manhattan assertion splits into "Manhattan for pressure, Manhattan-or-sloped for gravity". *Green: add `loadpath.test.ts`.*

**Step 6 — resolutions.** `parking-solver.ts` (extract `stallCapacity` from `parking.ts:295-304`, delete the duplicate maths in `packZone`, replace the shortfall warning at `parking.ts:390-391`); `spec.ts:18` clamp to the typology band + `allowStoreyOverride`; `spec.ts:47` `basementStoreys` becomes solver output; `massing.ts:312-319` warnings → clamp / override + `switch-highrise-ruleset`; `corridor-graph.ts` landed **additively** (`CorridorSpine.legs` populated, `centerline` kept as `legs[0]`); `placeCores` (`massing.ts:944-959`) consumes break slots; `form.ts` gets `data-min`/`data-max` on the storeys input plus the override checkbox and the Rules tab form. *Green: `site.test.ts` additions; consumers of `centerline` untouched.*

**Step 7 — delete the scaffolding.** Delete `src/core/coordination.ts`; remove `SIZES.slabT` / `SIZES.coreWallT` for good; flip `CorridorSpine.centerline` → `legs` in `massing.ts`, `floor-organizer.ts:550-571`, `mechanical/building.ts:49-56`, `plumbing/service.ts:45-48`, `electrical/panels.ts:307-315`, `app/site-svg.ts`; make `presize` / `kernel` / `rules` **non-optional** on `GenContext`; remove `mirrorInto` and make `DesignModel.warnings = ledger.warnings()`. Land `coordination.test.ts`, `presets.test.ts`, `no-duplicate-constants.test.ts`.

---

## 6. Tests to add

**`src/core/kernel/kernel.test.ts`**
1. For every profile × {f2f 2.7, 3.0, 3.05, 3.2, 4.0} × {slabT 0.20, 0.25, 0.30} × {beamD 0, 0.3, 0.5}: bands are ordered, **pairwise disjoint in Z** within a tolerance of 1e-6, `Σ depth ≤ soffitZ − clearZ`, and `clearZ ≥ profile.clearHeight.min`.
2. `plenumBands` shim reproduces the pre-migration `ductZ`/`pipeZ`/`sprinklerZ`/`trayZ` within 1 mm for the four preset geometries (this test is **deleted in step 7**).
3. Lane sets: `Σ` lateral extents ≤ corridor width; every pair of lanes in the same band is laterally disjoint; `laneSetFor(…, 1.5)` degrades without overlap.
4. Shaft allocator: for every preset, all slots in a shaft are **pairwise non-overlapping** footprints; allocation is idempotent (calling `slot` twice returns the same XY); allocation is **call-order independent** (shuffle the request order with a seeded RNG → identical result).
5. `reserve` refuses a `kind` the band does not allow, refuses a box outside the band, and returns a `Conflict` (never throws) for a full lane.
6. `reserveCrossing` on 40 branches at the same station produces 40 distinct, non-overlapping stations.
7. Determinism: two `createKernel` runs on the same inputs produce identical `reservations()` JSON.

**`src/core/rules/rules.test.ts`**
8. `rulesFromPatterns` covers every numeric parameter of all 100 patterns; no id collisions.
9. Every `PredicateId` has an implementation and a signature entry; every `builtin` rule's `predicate.id` and `subject` are consistent with its signature.
10. `validateRuleOverrides` rejects: bad `version`, id without `USR-`, unknown predicate, subject illegal for the predicate, limit type mismatch, unknown scope member, duplicate id — each producing exactly one `error` Issue and dropping only that rule.
11. `customToRule` round-trips the five UI examples; a custom rule actually fires on a preset.
12. Ledger: `warnings()` preserves the legacy prefixes; `info` issues are excluded by default; `addOnce` dedupes and counts.
13. Determinism: `createRuleSet` output order is independent of override key order.

**`src/coordination.test.ts`** (new cross-discipline file — none exists today)
14. **Every MEP element is in a reservation of its own discipline**: `kernel.validate(model.elements)` returns zero `violation` for all 10 presets.
15. **Every MEP element is inside its band**: no element's Z extent leaves `[band.z0, band.z1]`.
16. **Shaft slots are disjoint across the three disciplines** (the check nobody does today).
17. **One slab thickness**: `arch.floors[s].slabThickness === presize.byStorey.get(s).slabTAbove` for every storey; `arch` core walls `=== presize.coreWallT`.
18. **Transfer storey identity**: `struct.transferStorey === presize.transferStorey`, and the thickened slab is on exactly one storey.
19. **MEP under the slab**: for every duct/pipe/tray, `z ≤ presize.byStorey.get(storey).corridorSoffitZ`.
20. **Nothing wet over switchgear**: no `waste|storm|dcw|dhw|gas` box intersects an electrical dedicated-space keep-out (NEC 110.26(E)).
21. **No penetration** of beams, columns or elevator shafts.
22. **Hangers**: every horizontal MEP run has a soffit within `HANGERS[kind].maxDrop` or is in a wall/shaft/chase/floor.
23. **Riser continuity**: every riser's shaft/chase exists on every storey it crosses.
24. **Drains**: every gravity run is monotonic and within the slope band; every fixture reaches a stack; every stack reaches a building drain or a sump; every sump discharges to gravity above the sewer invert.
25. **Clear heights**: parking drive aisles ≥ 2.10 m and the accessible route ≥ 2.50 m on every parking storey.
26. **Load path**: column-on-column or transfer for every column on every preset; a foundation under every lowest support; cores continuous.
27. **Parking achieved == required** (or a recorded `relax-parking-ratio` deviation) for all 10 presets.
28. **Storeys ≤ typology max** (or a recorded override deviation).
29. **Corridors**: no leg longer than `ARC-03.maxLegLength`; no dead end longer than `SIT-08.deadEnd`; an O-plan has **one** connected corridor graph.

**`src/presets.test.ts`** — the invariant
30. For all 10 presets at `detail: 'medium'` (plus `us-5-over-1` and `ca-point-tower` at `low` and `high`): `ledger.bySeverity('violation').length === 0` **and** `bySeverity('error').length === 0`. On failure, print every violating issue with its `ruleId`, `storey`, `elementIds`, `observed` and `limit`.
31. Determinism: two generations of each preset produce byte-identical `JSON.stringify(model.issues)` and identical element id lists.
32. Regression budget: `model.timings` total < 1 200 ms per preset on CI (headroom to the 2 s contract).

**`src/no-duplicate-constants.test.ts`** — enforces "generators read the rules"
33. `readFileSync` each named file and assert the deleted identifiers are absent: `SIZES.slabT`, `SIZES.coreWallT`, `plumbingShaftCorner`, `shaftSlot`, `SHAFT_SLOT_CAPACITY`, `beamDepthUnder`, `beamDepthFor`, `BUILDING_DRAIN_Z`, `SEWER_Z`, `MAX_VENTED_BRANCH`, `DEFAULT_LANES`, `MERGE_RADIUS`, `MIN_HINTED_BEARING_LENGTH`, `PATTERN_APP_CAP`.
34. Every rule id referenced by a `rules.num(...)` / `rules.table(...)` call (found by regex over `src/disciplines/**`) exists in the rule set.

**`src/disciplines/structure/presize.test.ts`** — slab/core-wall single ownership; transfer storey; `raise-floor-to-floor` fires when a retail ground f2f cannot hold the transfer zone; `bayOffsets` respects `bay.min/max` and absorbs the remainder in the corner bay; grid is identical on every residential storey (no kinks).

**`src/disciplines/structure/loadpath.test.ts`** — synthetic fixtures for each failure mode: a column with nothing below; a transfer beam with one unsupported end; a discontinuous core; a 3 m cantilever slab edge; a balcony with too little backspan. Each must produce exactly one issue with the right `ruleId`.

---

## 7. Risks and performance

| Risk | Mitigation |
|---|---|
| **O(n²) clash checking** would be fatal (67 k elements → 4.5 × 10⁹ pairs). | Bands are disjoint by construction, so **no pairwise clash test exists**. The only pairwise work is element-vs-keep-out and element-vs-own-reservation, through a per-storey 2 m XY grid. Budget: `validate` ≈ 40 ms at 67 k elements (≈ 4 candidate boxes per element), `checkSupport` ≈ 25 ms at 25 k axes (union-find), `checkLoadPath` ≈ 3 ms at 2 k supports, rule post-check ≈ 20 ms (scope rejection first, ~3 k subjects × 60 rules). **Total added ≈ 90 ms on a 337 ms baseline → ~430 ms, 4.6× headroom.** |
| Rule post-check becomes the hot loop as rules grow. | `forSubject` pre-buckets rules by subject kind and by scope at `createRuleSet` time; a rule whose scope excludes the storey/use is never evaluated. Hard cap: a `rules.test.ts` assertion that the post-check is < 150 ms on `ie-courtyard`. |
| **Ceiling profiles don't fit real f2f values** and every preset raises f2f (visible model change). | `stackProfile` compresses to `minDepth` and drops `void` bands *before* raising; the corridor ceiling is an **output**, so a 3.05 m f2f corridor lands at ≈ 2.15 m rather than failing. A test asserts `raiseFloorToFloorTo === null` for all 10 presets at default f2f. |
| **Deleting the synthesised-fixture path** turns today's silent repair into a violation before the modules work lands. | Step 4c is gated on the modules agent's wet-wall **port** being published on `UnitInstance` (`wetWallIds` already exists; the port adds a station). Until then keep `portFor` falling back to `unit.wetWallIds[0]` with a `deviation` issue — a `deviation`, not a `violation`, so `presets.test.ts` stays green. |
| **`CorridorSpine.centerline` → `legs`** touches six files including the app. | Landed additively in step 6 (`legs` populated, `centerline = legs[0]`), flipped in step 7 in one commit with all six call sites. |
| Two agents both edit `core/types.ts`. | Step 0 lands **every** type change in one commit, owned by Agent K, before any other agent starts. |
| Determinism regressions from `Map` iteration or call order. | Every allocator is keyed by a **canonical constant order** (`SHAFT_SYSTEM_ORDER`, `lane.systemOrder`) and memoised, never by call order. `presets.test.ts` #31 is the guard; `kernel.test.ts` #4 shuffles request order with a seeded RNG. No `Math.random`, no `Date` anywhere in the new code. |
| Parking solver ↔ massing circularity (`estimatedUnits` needs bars; bars need `basementStoreys`). | `estimateUnits` is a pure function of envelope × storeys × frontage that does **not** need bars; the solver runs once before `buildMassing`, and a test asserts the two unit estimates agree within ±2. Cost: 3 `estimateUnits` + ≤ 6 `stallCapacity` calls — pure arithmetic, µs. |
| Retail demise caps / tenant plenum have no preset exercising them (`mixed-use-midrise` is not in `PRESETS`). | Add a fixture-only test (not a preset) in `coordination.test.ts` built from a `mixed-use-midrise` partial spec, so the `retail-shell` profile is covered without changing the shipped preset list. |
| Code-citation drift (NEC/IPC/NFPA editions). | Every number carries a `source` string; `rules.test.ts` asserts every `param` rule has a non-empty `source`. Editions are pinned in one place: `src/core/rules/SOURCES.ts` as a `Record<string, string>` of short key → full citation, referenced by rules. |

---

## 8. Suggested split into parallel implementation agents

**Freeze order:** three interface files must be frozen before anyone else writes code. Agent K produces them first, in a single commit, as step 0 + the type-only halves of steps 1–2.

| Freeze | File(s) | Consumed by |
|---|---|---|
| **F1** | `src/core/rules/types.ts` (`Rule`, `Issue`, `Ledger`, `RuleSet`, `Subject`, `World`, `PredicateId`, `ResolutionId`) | everyone |
| **F2** | `src/core/kernel/types.ts` (`Box3`, `ElementKind`, `Band`, `CeilingProfile`, `StoreyProfile`, `Lane`, `Reservation`, `Conflict`, `ShaftSlot`, `Chase`, `Sleeve`, `Kernel`) | S, M |
| **F3** | `src/disciplines/structure/presize.ts` type-only header (`StructuralPresize`, `StoreySizing`, `GridProposal`) + `ArchModel.partyLines` | K, M, and the parallel modules agent |

### Agent K — Kernel & Rules (owner of `src/core/**`)
**Scope:** step 0 (all `core/types.ts` changes, `CONTRACT.md`), step 1 (rules, predicates, schema, ledger, `from-patterns`, `graph.ts`), step 2 (profiles, lanes, clearances, mounting, sizes, the `coordination.ts` shim), step 4a (registry, validate, shafts, chases, sleeves, support), `pipeline.ts` wiring, step 7 deletions.
**Tests:** `kernel.test.ts`, `rules.test.ts`, `no-duplicate-constants.test.ts`, `coordination.test.ts`, `presets.test.ts`.
**Must publish before others start:** F1, F2, F3-stub.
**Blocks:** everyone. Should complete F1+F2 in its first commit.

### Agent S — Structure (owner of `src/disciplines/structure/**`)
**Scope:** step 3 (`presize.ts`, the two warning deletions, the transfer off-by-one, `sizing.ts` clean-up), `grid.ts` rewritten around `arch.partyLines` (delete `snapToWalls`/`SnapWall`/`snapWallsOf` and the per-storey snap loop at `index.ts:411,421`), step 5's structure half (`loadpath.ts`, transfer beams onto the columns they carry, footings from `loadpath.bases`), structure keep-out registration, `StructModel.plenumClearance.byStorey`.
**Tests:** `presize.test.ts`, `loadpath.test.ts`, updated `structure.test.ts:365-375`.
**Needs frozen:** F1, F2 (`Band`, `ProfileBook`, `stackProfile` signature).
**Publishes:** F3 (`StructuralPresize`) — after which M and the architecture/modules agent unblock.
**Runs in parallel with:** R.

### Agent M — MEP consumption (owner of `mechanical/**`, `plumbing/**`, `electrical/**`)
**Scope:** step 4b–4d in that order, step 5's MEP half (`invert.ts`, sloped axes in `routing.ts`, sump + duplex ejector, per-level collectors), and every deletion in §5 steps 4–5: the three shaft-slot implementations, the three `beamDepth` derivations, the synthesised-fixture paths, `BUILDING_DRAIN_Z`/`SEWER_Z`, `MAX_VENTED_BRANCH`, `plumbingShaftCorner`, `nearestShaft`, `unitDuctBand`, the second-stack machinery.
**Tests:** rewritten `mechanical.test.ts:343`, split `plumbing.test.ts` Manhattan assertion, `electrical.test.ts` tray-lane assertions.
**Needs frozen:** F1, F2, F3. Can start against a stub `createKernel` that returns fixed profiles, so it does not wait for K's registry implementation.
**Largest surface area** — if a fourth agent is available, split M into **M-mech/elec** and **M-plumb** (plumbing is the bigger job: invert model, chases, slopes, sumps, and the deletion of `stacks.ts:103-238`). The two halves share only `kernel` and `presize`, both frozen.

### Agent R — Resolutions & Site (owner of `site/**`, `core/spec.ts`, `app/form.ts`)
**Scope:** step 6 in full — `parking-solver.ts` (+ extract `stallCapacity`, delete the duplicated capacity maths), `corridor-graph.ts` (legs, break slots, knuckles, dead ends, `longestRunM`), `placeCores` consuming break slots, `spec.ts` typology-band clamp + `allowStoreyOverride` + solver-driven `basementStoreys`, `RULE_PROFILES['high-rise']`, the `massing.ts:312-319` warnings, the Rules-tab UI form and the storeys min/max inputs in `form.ts`.
**Tests:** `site.test.ts` additions (parking achieved == required; storeys within band or deviation; corridor leg/dead-end/knuckle invariants; `estimateUnits` agrees with massing ±2).
**Needs frozen:** F1 only.
**Runs fully in parallel with S and M.**
**Cross-agent contract to freeze with the modules agent:** `BreakSlot`, `Knuckle`, `CorridorLeg`, `CorridorGraph` — the placer consumes break slots as blocked intervals and lays out per leg.

**Dependency order:** `K (F1,F2) → { S, R } → K (registry) → M → K (step 7 + the two invariant test files)`. In practice: K commits F1+F2 first; S and R start immediately; S publishes F3 within its first commit; M starts against the stub kernel; K finishes the registry and hands it to M; K lands the deletions and the two invariant tests last, once M is green.
