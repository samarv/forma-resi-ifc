# Design: module library, program solver, door convention, floor placer, overrides

_Generated 2026-09-21 by a read-only design/exploration pass over this repository; line numbers refer to the v1 code at commit 05246fb. Source of truth for v2 contracts is docs/design/v2-plan.md and the files under src/core._

I have read the plan file and the code. Here is the implementation plan.

---

# forma-resi-ifc v2 — legos, program solver, door convention, floor placer

All paths absolute. Erasable TypeScript only (no `enum`, no `namespace`, no parameter properties), `import type`, `.ts` import extensions, zero runtime deps, no `Math.random`/`Date.now`, determinism via the passed `Rng` or a `createRng(label)` derived from `spec.seed`.

---

## 0. The five mechanisms this plan installs

| # | Mechanism | Kills |
|---|---|---|
| 1 | **Feasibility witness gate.** A room layout can only be produced by passing a `Feasibility` witness (band depths + per-node width bounds) into the solver. No witness → no layout, and the placer never asks for one it cannot get. | every "too small / squeezed / dropped room / no window" warning |
| 2 | **Kit-derived minima.** Each room's `minWidth`/`minDepth` are *computed from its furniture kit* and asserted ≥ kit dims at build time. A room that exists is a room whose complete kit fits. | kitchen-with-only-a-fridge, washer-does-not-fit, no-clear-position |
| 3 | **Ports, not rediscovery.** Modules declare stack/exhaust/panel/party-line ports as fractions of frontage; `UnitLayout`/`UnitInstance` persist the resolved ports and the room graph; plumbing/mech/elec consume them. | trap-arm splits, second stacks, synthesised fixtures, three shaft-slot conventions |
| 4 | **Geometric probe once, at production.** `hinge`/`swing` on `DoorDef` are derived from one probe against the room rect; every consumer reads the fields. | 537/822 wrong door arcs, arcs on sliding doors, lying `OperationType` |
| 5 | **Quota ledger + grid snap in a 1-D packer.** Deterministic two-phase packing over admissible-at-this-depth modules, with a building-wide mix ledger and party lines snapped to the structural bay band. | mix drift, remnants, undersized bays, corridor legs, disjoint bars |

Everything that cannot be honoured becomes a `Deviation` record (code + named resolution), never a warning. Warnings become reserved for true contradictions; the acceptance test is `warnings.length === 0` on all 10 presets.

---

## 1. New and changed files

### New

| File | Purpose |
|---|---|
| `/Users/samarvir/formaIFC/generator/src/core/openings.ts` | Door/window geometry algebra: `solveSwing`, `hingePoint`, `leafTip`, `swingRect`, `latchSide`, `doorOperation`, `drawsArc`. The single owner of the hinge/swing convention. |
| `/Users/samarvir/formaIFC/generator/src/core/grid.ts` | `BayGrid` — the frozen handshake with the structural pre-sizing pass (planning module, bay/span bands, `slabT`, `beamDepth`, `coreWallT`, `shearWallT`) + `defaultBayGrid(system)`. |
| `/Users/samarvir/formaIFC/generator/src/core/overrides.ts` | `OverrideDoc`, `LayoutEdit`, `UnitEdit` schema + `hashOverrides()`; pure types + hash, no logic. |
| `.../src/disciplines/architecture/program/types.ts` | `ProgramGraph`, `ProgramNode`, `AdjacencyRule`, `PlanShape`, `BandSpec`, `Feasibility`, `ResolvedProgramGraph`, port types. |
| `.../src/disciplines/architecture/program/kits.ts` | `KIT` table (room kits with clearances), `kitMinDims`, `fitKit` (offset sweep + fallback walls + mandatory items). Extracted and generalised from `unit-layout.ts` `furnish*`. |
| `.../src/disciplines/architecture/program/programs.ts` | The 20 program graphs (data). |
| `.../src/disciplines/architecture/program/feasibility.ts` | `planShapesFor`, `feasibleShape`, `feasibleAt`, `admissibleDepths`, `allocate` (the one width/depth allocator). |
| `.../src/disciplines/architecture/program/solver.ts` | `solveStrip` (band/column layout), `layoutUnitCanonical` (pure, memoised), `placeCanonical` (world mapping + id minting). Replaces the planning half of `unit-layout.ts`. |
| `.../src/disciplines/architecture/program/doors-in-unit.ts` | Connectivity tree from the graph's required edges, door placement rules, swing reservation. |
| `.../src/disciplines/architecture/program/validate.ts` | `validateUnitLayout` — the per-unit invariant checker (reachability, daylight, kits, swings, trap arms, min leaves). Used by the module self-test and by `--dev` assertions. |
| `.../src/modules/types.ts` | `ModuleKind`, `Port`, `UnitModule`, `CoreModule`, `CorridorModule`, `BreakModule`, `AmenityModule`, `MEPRoomModule`, `ParkingModule`, `ModuleCatalogue`. |
| `.../src/modules/ids.ts` | Id grammar + variant naming. |
| `.../src/modules/unit-modules.ts` | Derives unit modules (template × variant × shape) and their elastic ranges from the program graphs. |
| `.../src/modules/core-modules.ts` | Stair configs (single / dog-leg / scissor) × lift count × 3 shaft slots + trash + lobby; footprint ranges. |
| `.../src/modules/corridor-modules.ts` | Corridor segments and break modules (lounge, widened lift lobby, window bay, cross-corridor, exit stair). |
| `.../src/modules/mep-modules.ts` | Switchroom, water entry, fire pump, generator, trash, sump. |
| `.../src/modules/amenity-modules.ts`, `.../src/modules/parking-modules.ts` | Amenity program modules; 16.8 m double / 8.4+aisle single stall bays, ramp. |
| `.../src/modules/catalogue.ts` | `buildCatalogue()` (memoised), `frontageAt(moduleId, depth)`, `candidatesFor(strip)`. |
| `.../src/modules/self-test.ts` | Catalogue × frontage/depth sample sweep → `SelfTestReport`. |
| `.../src/disciplines/architecture/placer/types.ts` | `Slot`, `StripDef`, `FloorLayout` v2, `CorridorGraph`, `MixReport`, `Deviation`. |
| `.../src/disciplines/architecture/placer/strips.ts` | Bar → strips (corridor/gallery/point/stair-core/house), blockers, net depth. |
| `.../src/disciplines/architecture/placer/packer.ts` | 1-D packing with quotas + grid snap. |
| `.../src/disciplines/architecture/placer/corridors.ts` | Corridor graph, knuckle joining, break insertion, dead-end check, travel distance. |
| `.../src/disciplines/architecture/placer/quota.ts` | Building-wide mix ledger + `mixDeviation`. |
| `.../src/disciplines/architecture/placer/apply-overrides.ts` | `applyOverrides(layout, doc, ctx) → FloorLayout` (deterministic, clamping, deviations). |

### Changed

| File | Change |
|---|---|
`/Users/samarvir/formaIFC/generator/src/core/types.ts` | `DoorDef` v2 (drop `operation`, add `motion`/`hinge`/`swing`/`swingIntoRoomId`); `UnitInstance` gains ports + `moduleId`/`slotId`/`mirrored`/`roomGraph`; `ArchModel.deviations`; `BuildingSpec.overrides`; `ShaftDef.slotId`.
`.../src/disciplines/architecture/unit-layout-types.ts` | `UnitLayoutRequest` gains `moduleId`, `program`, `fit` (witness), `edits`, `gridLinesLocal`; drops `stackAlong`. `UnitLayout` gains `graph`, `stackPorts`, `exhaustPorts`, `panelPort`, `swings`, `deviations`.
`.../src/disciplines/architecture/types-internal.ts` | `FloorLayout` → re-export of `placer/types.ts` v2; `UnitSlot` → `Slot`.
`.../src/disciplines/architecture/unit-layout.ts` | Shrinks to furnishing glue + re-export; planning moves to `program/`. Dead code deleted in M9.
`.../src/disciplines/architecture/floor-organizer.ts` | `planFloorLayout` delegates to `placer/`; `instantiateFloor` consumes `Slot`; template picking deleted.
`.../src/disciplines/architecture/cores.ts` | `planCores` consumes `CoreModule`; the three shaft slots become purpose-tagged `ShaftDef`s; doors get hinge/swing.
`.../src/disciplines/architecture/common-rooms.ts`, `.../arch-elements.ts` | Doors get hinge/swing; `crossLink` dedupes all four id arrays; door element `operation` from `doorOperation(d)`.
`.../src/app/plan-svg.ts` | Arc/leaf from `openings.ts`; no arc for non-swing motions.
`.../src/ifc/writer.ts` | `OperationType` from the geometry's derived token (already the case) — no change beyond the producers being truthful.
`.../src/disciplines/electrical/devices.ts` | `switchSpot` uses `latchSide(d, wall)` instead of `operation.includes('RIGHT')`.
`.../src/disciplines/plumbing/{fixtures,stacks}.ts` | Consume `UnitInstance.stackPorts`; delete synthesis + second-stack repair (M8).
`.../src/disciplines/mechanical/placement.ts`, `.../src/disciplines/electrical/panels.ts` | `shaftSlotFor(purpose)` from `arch.shafts`; exhaust/panel ports (M8).
`.../src/app/mock-model.ts` | Mock doors get the new fields (keeps the offline single-file app honest).
Test fixtures in `architecture|mechanical|plumbing|electrical|structure/test-fixtures.ts` | New door fields.

---

## 2. Frozen contracts (freeze on day 0, one no-behaviour commit)

### 2.1 Doors — `src/core/types.ts` + `src/core/openings.ts`

```ts
// core/types.ts
export type DoorMotion = 'swing' | 'double-swing' | 'sliding' | 'folding' | 'rolling' | 'opening';
export type DoorHinge = 'start' | 'end';
export type DoorSwing = 'left' | 'right' | 'none';

export interface DoorDef {
  id: string;
  storey: string;
  wallId: string;
  /** Distance from the HOST WALL's stored `start` to the door centre. */
  along: number;
  width: number;
  height: number;
  type: 'unit-entry' | 'interior' | 'building-entry' | 'balcony' | 'garage' | 'exit' | 'closet' | 'service';
  /** How the leaf moves. Only 'swing' | 'double-swing' draw an arc. */
  motion: DoorMotion;
  /**
   * End of the host wall — in the wall's STORED start→end direction — that carries the hinge
   * (for sliding/folding: the end the leaf parks at). Convention-independent because it is a
   * property of the WallDef object the door already resolves through `wallId`.
   */
  hinge: DoorHinge;
  /**
   * Side of the host wall the leaf's motion volume occupies: 'left' | 'right' of the stored
   * start→end direction. 'none' only for motion 'rolling' | 'opening'.
   */
  swing: DoorSwing;
  /** Room whose floor the leaf sweeps over. REQUIRED for swing/double-swing; must be fromRoomId or toRoomId. */
  swingIntoRoomId?: string;
  fromRoomId?: string;
  toRoomId?: string;
  fireRated?: boolean;
  unitId?: string;
}
```

`operation` is **removed** from `DoorDef`. The IFC token is derived, never authored:

```ts
// core/openings.ts
import type { DoorDef, DoorHinge, DoorMotion, DoorSwing, Rect, Vec2, WallDef } from './types.ts';

export type WallRef = Pick<WallDef, 'start' | 'end'>;

export interface SwingSolution { hinge: DoorHinge; swing: DoorSwing; }

/**
 * Derive hinge + swing from geometry. `into` is the world rect of the room the leaf must sweep
 * into; `avoid` is a world point the hinge should be far from (the wet wall / fixture run).
 */
export function solveSwing(args: {
  wall: WallRef; along: number; width: number; motion: DoorMotion;
  into: Rect | null; avoid?: Vec2 | null; preferHinge?: DoorHinge;
}): SwingSolution;

export function hingePoint(d: Pick<DoorDef, 'along' | 'width' | 'hinge'>, wall: WallRef): Vec2;
export function leafTip(d: Pick<DoorDef, 'along' | 'width' | 'hinge' | 'swing'>, wall: WallRef): Vec2;
/** Quarter-square swing clearance in world XY; null for non-swing motions. */
export function swingRect(d: Pick<DoorDef, 'along' | 'width' | 'hinge' | 'swing' | 'motion'>, wall: WallRef): Rect | null;
/** Point 60 mm inside `swing` at the latch end — where a light switch goes. */
export function latchSide(d: Pick<DoorDef, 'along' | 'width' | 'hinge' | 'swing'>, wall: WallRef): Vec2;
export function drawsArc(d: Pick<DoorDef, 'motion'>): boolean;
/** IFC4 IfcDoorTypeOperationEnum token. */
export function doorOperation(d: Pick<DoorDef, 'motion' | 'hinge' | 'swing'>, leaves?: 1 | 2): string;
```

Implementation rules (implementers must use exactly these):

```
dir   = norm(end − start);  leftN = [−dir.y, dir.x]
c     = start + dir·along
probe = c + leftN·0.06
swing = (into && rectContainsPoint(into, probe)) ? 'left' : 'right'
hinge: with `avoid` given, hinge = |along − project(avoid)| maximised → the end farther from the
       fixture run, so the open leaf lies flat on the wall away from the fixtures; otherwise
       hinge = along ≤ wallLen/2 ? 'start' : 'end'  (leaf folds against the nearer return wall)
hingePoint = c ∓ dir·(width/2)                 (− for 'start', + for 'end')
leafTip    = hingePoint ± leftN·width          (+ for swing 'left')
arc        = arcPath(hingePoint, width, angleOf(hinge==='start' ? dir : −dir), angleOf(±leftN))
```

**IFC token derivation** (derived once, documented, don't re-reason it):
observer stands on the side the leaf does *not* sweep into, looking through the opening; with
`dir = +X`, `leftN = +Y`, swing `left` → observer at −Y, forward `+Y`, right `= forward × up = +X`,
so a hinge at the `start` (low-X) end is on the observer's **left**. Therefore

```ts
const token = (d.swing === 'left') === (d.hinge === 'start') ? 'LEFT' : 'RIGHT';
// swing        → `SINGLE_SWING_${token}` (leaves 2 → `DOUBLE_DOOR_SINGLE_SWING`)
// double-swing → `DOUBLE_SWING_${token}` (leaves 2 → `DOUBLE_DOOR_DOUBLE_SWING`)
// sliding      → `SLIDING_TO_${token}`   (leaves 2 → `DOUBLE_DOOR_SLIDING`)
// folding      → `FOLDING_TO_${token}`   (leaves 2 → `DOUBLE_DOOR_FOLDING`)
// rolling      → 'ROLLINGUP';  opening → 'NOTDEFINED'
```

Every token is in the writer's `DOOR_OPERATIONS` set (`src/ifc/writer.ts:244`), so nothing degrades.

**Producers to update (17 sites, all found by typecheck):**
`unit-layout.ts:1628` (entry), `:1652` (garage), `:1681` (balcony), `:1727` (interior);
`floor-organizer.ts:1482` (extra doors), `:1505` (balcony), `:1561` (fallback entry);
`cores.ts:460` (stair door), `:469` (lobby), `:480` (ground exit);
`common-rooms.ts:204` (interior), `:219` (entrance);
`app/mock-model.ts:450,488,492,496`;
test fixtures `architecture:430,462,480,526`, `mechanical:245,310`, `plumbing:365`, `electrical:313`, `structure:78`.

**Consumers to update:** `app/plan-svg.ts:287-302` (hinge + arc + `drawsArc` gate), `arch-elements.ts:507` (`operation: doorOperation(d)` + pset), `electrical/devices.ts:491-512` (`latchSide`), `unit-layout.ts:1733-1738` (`swingRect` instead of the discarded `dirIn`).

Also: `arch-elements.ts:385-403` `crossLink` must dedupe `doorIds`, `windowIds`, `furnitureIds` the way it already dedupes `wallIds` — today the solver pushes at `unit-layout.ts:1731-1732` and `:1900` and `crossLink` pushes again at `:388-392`, so both doors and furniture are double-registered.

### 2.2 Unit layout contract — `unit-layout-types.ts`

```ts
export interface StackPort {
  id: string;                 // 'stack.1'
  /** world XY of the station on the wet-wall centreline */
  xy: Vec2;
  /** local u as a FRACTION of frontage — identical modules therefore stack vertically */
  atFrac: number;
  wallId: string;
  /** node refs (rooms) draining into this station */
  serves: string[];
  systems: ('waste' | 'vent' | 'dcw' | 'dhw')[];
  /** longest developed trap-arm length inside this group (m) — asserted ≤ maxTrapArm */
  maxArm: number;
}
export interface ExhaustPort { id: string; xy: Vec2; atFrac: number; side: Side; kind: 'kitchen' | 'bath' | 'dryer' | 'mvhr'; flowLs: number; }
export interface PanelPort  { id: string; xy: Vec2; wallId: string; roomId: string; height: number; }

export interface UnitLayoutRequest {
  unitId: string; storey: string; level: number; levelsTotal: number;
  moduleId: string;
  program: ProgramGraph;
  /** Feasibility witness for (frontage, depth). The solver ASSERTS it and cannot fail. */
  fit: Feasibility;
  rect: Rect; accessSide: Side; exteriorSides: Side[]; exposures: Partial<Record<Side, Compass>>;
  boundaryWalls: UnitBoundaryWalls;
  floorToFloor: number; ceilingHeight: number; wwr: number;
  balcony: { side: Side; depth: number } | null;
  region: Region; options: GenerationOptions; rng: Rng;
  mirrored: boolean;
  /** party/column lines in LOCAL u, for partition snapping */
  gridLinesLocal: number[];
  /** per-unit edits from spec.overrides, already resolved to this slot */
  edits?: UnitEdit[];
  stairRect?: Rect;
}

export interface UnitLayout {
  rooms: RoomDef[]; walls: WallDef[]; doors: DoorDef[]; windows: WindowDef[]; furniture: FurnitureDef[];
  entryDoorId: string; wetWallIds: string[];
  kitchenRoomId?: string; bathroomRoomIds: string[]; balconyRoomId?: string;
  stair?: { rect: Rect; position: Vec2; direction: number; risers: number; riserHeight: number; tread: number; width: number };
  /** persisted for plumbing / MEP / the editor */
  graph: ResolvedProgramGraph;
  stackPorts: StackPort[];
  exhaustPorts: ExhaustPort[];
  panelPort: PanelPort | null;
  swings: { doorId: string; roomId: string; rect: Rect }[];
  patterns: PatternApplication[];
  deviations: Deviation[];
  /** reserved for true contradictions only; empty in every preset after M3 */
  warnings: string[];
}
```

`UnitInstance` gains `moduleId`, `slotId`, `mirrored`, `stackPorts`, `exhaustPorts`, `panelPort`, `roomGraph: ResolvedProgramGraph`, `partyLines: [number, number]`. `stackAlong` disappears from the slot: **ports are outputs, not inputs** — vertical alignment comes from the same module producing the same `atFrac` on every floor, which the placer verifies (`portAlignment` check) instead of the unit chasing an imposed coordinate.

### 2.3 Module catalogue — `src/modules/types.ts`

```ts
export type ModuleKind = 'unit' | 'core' | 'corridor' | 'break' | 'amenity' | 'mep' | 'parking';
export type PortKind = 'entry' | 'stack' | 'party-line' | 'exhaust' | 'panel' | 'balcony'
  | 'shaft' | 'riser' | 'corridor-connect' | 'ramp' | 'daylight' | 'exit';

export interface Port {
  id: string;
  kind: PortKind;
  /** module-local side: 'front' = access side, u runs along it, v goes inward */
  side: Side | 'interior';
  /** position along that side as a FRACTION of its length (mirroring maps f → 1 − f) */
  atFrac: number;
  /** clear length the port needs along the side (m); 0 = point port */
  width: number;
  purpose?: ShaftDef['purpose'];
  required: boolean;
}

export interface Range { min: number; max: number }

export interface ModuleBase {
  id: string; kind: ModuleKind; name: string;
  /** envelope of the admissible region — the first-pass filter; the exact test is catalogue.frontageAt */
  frontage: Range; depth: Range;
  ports: Port[];
  mirrorable: boolean;
  patterns: string[];
}

export interface UnitModule extends ModuleBase {
  kind: 'unit';
  templateId: UnitTemplateId;
  variant: 'single' | 'dual' | 'corner' | 'end' | 'cluster' | 'dual-key';
  programId: string;
  /** the FROZEN plan shape: bands + optional spine. Plan type is module identity, not a runtime guess. */
  shape: PlanShape;
  levels: 1 | 2 | 3;
  areaTarget: number; bedrooms: number; bathrooms: number; occupants: number;
  /** what the placer must give it */
  needs: { exteriorSides: Side[]; minExteriorCount: number; endOfBar: boolean };
}

export interface CoreModule extends ModuleBase {
  kind: 'core';
  stair: 'single' | 'dog-leg' | 'scissor';
  stairCount: 1 | 2;
  lifts: number;
  /** three purpose-tagged shaft slots + trash, as fractions of the footprint */
  shaftSlots: { purpose: ShaftDef['purpose']; atFrac: number; wFrac: number; dFrac: number }[];
  lobby: boolean;
  /** required across-bar depth for the stair run at a given floor-to-floor */
  runNeedAt(f2f: number): number;   // exposed by the catalogue, not stored on the record
}

export interface BreakModule extends ModuleBase {
  kind: 'break';
  role: 'lounge' | 'lift-lobby' | 'window-bay' | 'cross-corridor' | 'exit-stair';
  /** does it reset the ARC-03 45 m leg counter, and does it count as an exit? */
  resetsLeg: boolean; isExit: boolean; needsFacade: boolean;
}

export interface MEPRoomModule extends ModuleBase {
  kind: 'mep';
  role: 'switchroom' | 'water-entry' | 'fire-pump' | 'generator' | 'trash' | 'sump';
  constraints: { streetSide?: boolean; noWetAbove?: boolean; lowestPoint?: boolean; externalDoor?: boolean; ventToOutside?: boolean };
}

export interface ParkingModule extends ModuleBase {
  kind: 'parking';
  role: 'double-loaded' | 'single-loaded' | 'ramp';
  /** 2×5.4 stalls + 6.0 aisle = 16.8 m bay across; single = 5.4 + 6.0 = 11.4 */
  bayAcross: number; stallPitch: number; aisle: number; rampSlope?: number;
}

export interface ModuleCatalogue {
  all: ModuleBase[];
  byId(id: string): ModuleBase | undefined;
  units: UnitModule[]; cores: CoreModule[]; breaks: BreakModule[];
  amenities: AmenityModule[]; mep: MEPRoomModule[]; parking: ParkingModule[];
  /** exact admissible frontage at a net depth; null when the depth is inadmissible. Memoised. */
  frontageAt(id: string, depth: number, o: FeasibilityOpts): Range | null;
  /** the witness for a concrete (frontage, depth) — the only way to get a layout */
  fitFor(id: string, frontage: number, depth: number, o: FeasibilityOpts): Feasibility | null;
  candidatesFor(strip: { netDepth: number; atStart: boolean; atEnd: boolean; exteriorSides: Side[]; levels: number; typology: TypologyId; region: Region }): UnitModule[];
}
export function buildCatalogue(): ModuleCatalogue;   // memoised per process
```

Ids (`src/modules/ids.ts`):

```
unit      U-<templateId>-<variant>            U-2b2b-single, U-2b2b-corner, U-townhouse-2s-end
core      C-<stair>[-lift<n>][-scissor]       C-dogleg, C-dogleg-lift2, C-scissor-lift4
break     K-<role>                            K-lounge, K-lift-lobby, K-window-bay, K-cross, K-exit-stair
corridor  X-<width×100>                       X-150, X-180, X-240
amenity   A-<role>                            A-gym, A-lounge, A-coworking, A-bike, A-mail, A-parcel
mep       M-<role>                            M-switchroom, M-water-entry, M-fire-pump, M-generator, M-trash, M-sump
parking   P-<role>[-<angle>]                  P-double-90, P-single-90, P-ramp
```

`mirrored` is an **instance** property (`Slot.mirrored`), not part of the id: mirroring is `u → 1 − u` on the frozen shape, so the catalogue stays ~55 records instead of ~110, and the override op is `{ op:'mirror' }`. The brief's "mirrored flag" lives on the slot; the catalogue carries `mirrorable`.

Template → variant map (55 unit modules):

| Template | Variants |
|---|---|
| micro-studio, studio, junior-1b, 1b1b, 1b-den, senior-1b-accessible, loft-live-work | `single`, `end` |
| 2b1b, 2b2b, 3b2b, 4b2b | `single`, `dual`, `corner`, `end` |
| corner-2b2b | `corner` |
| dual-key | `dual-key` |
| coliving-cluster | `cluster` |
| maisonette-2s | `dual`, `end` |
| townhouse-2s, townhouse-3s, ranch-3b, colonial-4b, adu-1b | `end` (mid-terrace), `corner` (end-terrace / detached) |

`single` = access + one opposite façade (zoned shape). `dual` = access + opposite + a short end façade (through shape allowed). `corner` = two perpendicular façades. `end` = end-of-bar, three façades. `cluster`/`dual-key` = their own shapes.

### 2.4 FloorLayout as the editable document — `placer/types.ts`

```ts
export type SlotId = string;   // 'S-<barId>-<stripCode>-<nnn>' (+ '.<k>' for inserted slots)
export type StripId = string;  // 'ST-<barId>-<L|H|S|E>-<n>'

export interface ResolvedPort extends Port { xy: Vec2; along: number; wallSide: Side; }

export interface Slot {
  id: SlotId; stripId: StripId;
  kind: 'unit' | 'break' | 'common' | 'remnant' | 'core' | 'mep' | 'amenity';
  moduleId: string; mirrored: boolean;
  /** boundary rect: edges on the CENTRELINES of the bounding walls (unchanged semantics) */
  boundary: Rect;
  accessSide: Side; exteriorSides: Side[]; sides: Record<Side, SideWallSpec>;
  barId: string; coreId?: string; storeySpan?: string[]; stairRect?: Rect;
  ports: ResolvedPort[];
  /** the slot's two boundaries along the bar, and whether each is a column line */
  partyLines: [{ at: number; column: boolean }, { at: number; column: boolean }];
  extraDoors?: { side: Side; width: number; height: number; type: 'garage' | 'building-entry' | 'exit'; offset?: number }[];
  deviations?: Deviation[];
  notes?: string;
}

export interface FloorLayout {
  version: 2;
  /** typical-floor identity (the old planKey) — the override propagation key */
  key: string;
  /** key + hashOverrides(edits for this key) — the cache identity */
  layoutKey: string;
  strips: StripDef[];
  slots: Slot[];
  corridor: CorridorGraph;
  commons: CommonRoomSlot[];
  grid: { module: number; bay: Range; lines: Record<string, number[]> };
  mix: MixReport;
  blocked: Record<string, Interval[]>;
  remnantArea: number;
  deviations: Deviation[];
}
```

**Id stability rules**

1. Base ids are minted during base generation in a fixed traversal order (bars in massing order → strips in `low, high, start, end` order → slots left-to-right along the bar). Base generation is a pure function of the spec, so the same spec always yields the same ids.
2. Overrides are applied **after** base generation and never renumber base slots. A removal leaves a hole; ids are never reused.
3. An inserted slot's id is derived from its anchor: `insertSlot { afterSlotId: 'S-BAR1-L-007' }` → `S-BAR1-L-007.1`, then `.2`, ... (stable under further insertions elsewhere).
4. In-unit refs never use minted ids: room ref = `<roomType><n>` (the program node ref, e.g. `bedroom2`), door ref = `<fromRef>~<toRef>` (or `entry`, `balcony`, `garage`), partition ref = `<refA>|<refB>` sorted, furniture ref = `<roomRef>#<kitSlot>`. These come from the program graph and are stable across regenerations.

**Override schema** (`src/core/overrides.ts`, stored in `spec.overrides` so it round-trips with the existing spec-JSON editor in `src/app/form.ts` and stays deterministic and shareable):

```ts
export interface OverrideDoc {
  version: 1;
  /** keyed by FloorLayout.key → applies to every storey sharing that typical plan */
  layouts?: Record<string, LayoutEdit[]>;
  /** keyed by storeyId → applied after the layout edits, for a one-off floor */
  storeys?: Record<string, LayoutEdit[]>;
}

export type LayoutEdit =
  | { op: 'swapModule';  slotId: SlotId; moduleId: string }
  | { op: 'mirror';      slotId: SlotId; mirrored: boolean }
  | { op: 'moveBoundary'; slotId: SlotId; edge: 'start' | 'end'; delta: number }
  | { op: 'insertSlot';  stripId: StripId; afterSlotId: SlotId | null; moduleId: string; frontage?: number }
  | { op: 'removeSlot';  slotId: SlotId }
  | { op: 'setSlotKind'; slotId: SlotId; kind: 'common' | 'remnant' | 'amenity'; roomType?: RoomType }
  | { op: 'moveCore';    coreId: string; along: number }
  | { op: 'unit';        slotId: SlotId; edits: UnitEdit[] };

export type UnitEdit =
  | { op: 'flipDoor';        doorRef: string }                                  // swaps hinge end
  | { op: 'reverseDoor';     doorRef: string }                                  // swaps swing side
  | { op: 'moveDoor';        doorRef: string; along: number }
  | { op: 'setDoorMotion';   doorRef: string; motion: DoorMotion }
  | { op: 'dragPartition';   edgeRef: string; delta: number }
  | { op: 'moveFurniture';   itemRef: string; du: number; dv: number; rotate?: number }
  | { op: 'addFurniture';    roomRef: string; type: FurnitureType; u: number; v: number; rotation: number }
  | { op: 'removeFurniture'; itemRef: string }
  | { op: 'swapRoomType';    roomRef: string; type: RoomType };
```

Application point in `generateArchitecture` (`architecture/index.ts:134-152`):

```
planFloorLayout(args)              → base layout, cached by key
applyOverrides(base, doc, ctx)     → edited layout, cached by layoutKey
instantiateFloor({ layout, ... })  → geometry (unchanged role)
```

Unit edits ride on the slot into `UnitLayoutRequest.edits`; they participate in the canonical layout cache key via `editsHash`, so an edit on L02 with `key` scope re-solves **once** and replicates to L02–L14.

### 2.5 Structural handshake — `src/core/grid.ts`

```ts
export interface BayGrid {
  /** planning module the placer snaps party walls to (m) */
  module: number;                   // 0.1 metric default; 0.3048/4 for imperial-friendly output
  /** admissible structural bay spacing ALONG the bar */
  bay: { min: number; target: number; max: number };
  /** admissible span ACROSS the bar */
  span: { min: number; target: number; max: number };
  slabT: number; beamDepth: number; coreWallT: number; shearWallT: number;
  source: 'presize' | 'default';
}
export function defaultBayGrid(system: StructuralSystemId): BayGrid;
```

Protocol: `site.massing` → `presizeStructure(spec, typology, massing) → BayGrid` (all the sizing functions in `structure/sizing.ts` are already pure and callable pre-architecture) → placer snaps party lines to `module` and selects the **subset** of party lines that are column lines such that consecutive spacing lies in `[bay.min, bay.max]` (not every party wall is a column line; a module wider than `bay.max` declares an interior `party-line` port at `atFrac 0.5`) → placer returns `FloorLayout.grid.lines[barId]` → structure's detailing pass builds columns on exactly those lines. This retires `snapToWalls` and the per-storey column drops, and makes architecture read `slabT`/`coreWallT` from `BayGrid` instead of `SIZES` (`architecture/index.ts:262`, `cores.ts:101,290,342,439`).

---

## 3. Program-graph schema and data

```ts
export type NodeRef = string;   // '<roomType><n>' — e.g. 'bedroom2', 'kitchen1'
export type KitId =
  | 'living-3seat' | 'living-compact' | 'living-kitchen' | 'dining-4' | 'dining-6'
  | 'kitchen-galley' | 'kitchen-galley-washer' | 'kitchen-island' | 'kitchen-accessible'
  | 'bed-double' | 'bed-single' | 'bed-master' | 'bath-3pc-tub' | 'bath-3pc-shower'
  | 'bath-accessible' | 'wc-2pc' | 'laundry-stack' | 'laundry-side' | 'shelf' | 'wardrobe-run'
  | 'entry' | 'desk' | 'garage-1car' | 'balcony-2' | 'none';

export interface ProgramNode {
  ref: NodeRef; type: RoomType; zone: Zone; level: number;
  area: { min: number; target: number; max: number };
  /** clear internal dims; min* are ASSERTED ≥ kitMinDims(kit) at build time */
  minWidth: number; minDepth: number; maxWidth: number; maxDepth: number;
  aspect: { min: number; max: number };
  needsExterior: boolean; wet: boolean;
  kit: KitId;
  /** may sit in a second row behind a wet/service column when the band is deep enough */
  stackable: boolean;
  /** declared alternative: becomes furniture in another room instead of a room (NOT a dropped room) */
  mergeInto?: { ref: NodeRef; kit: KitId };
  band: 'daylit' | 'service' | 'circulation';
}

export interface AdjacencyRule {
  a: NodeRef | RoomType; b: NodeRef | RoomType;
  kind: 'share-edge' | 'door' | 'no-door' | 'not-adjacent';
  regions?: Region[]; reason: string;
}

export interface ProgramGraph {
  id: string; templateId: UnitTemplateId; levels: number;
  nodes: ProgramNode[];
  rules: AdjacencyRule[];
  /** v order from the access side; each entry is a set of zones allowed in that band */
  zoneOrder: Zone[][];
  wetGroups: NodeRef[][];
  maxStacks: 1 | 2;
}
```

Builder used by the data file:

```ts
const n = (ref: NodeRef, type: RoomType, area: [number, number, number],
           dims: [number, number], kit: KitId, o: Partial<ProgramNode> = {}): ProgramNode => ({ ... });
```

### 3.1 `studio` — 35/40/45 m², 1 level, shapes: zoned

```ts
nodes: [
  n('livingkitchen1','living-kitchen',[21,25,30],[3.6,4.2],'living-kitchen',
    { band:'daylit', needsExterior:true, wet:true, zone:'public', maxWidth:8.5, maxDepth:8.5, aspect:{min:1,max:2.2} }),
  n('bathroom1','bathroom',[3.7,4.2,5.2],[1.7,2.2],'bath-3pc-tub',
    { band:'service', wet:true, zone:'service', maxWidth:3.2, maxDepth:4.4, aspect:{min:1,max:2.4} }),
  n('entry1','entry',[2.0,3.0,4.0],[1.2,1.5],'entry',
    { band:'circulation', zone:'circulation', maxWidth:3.2, maxDepth:4.4 }),
  n('laundry1','laundry',[1.2,1.4,2.0],[0.8,0.7],'laundry-stack',
    { band:'service', wet:true, stackable:true, mergeInto:{ ref:'bathroom1', kit:'laundry-stack' } }),
  n('closet1','closet',[0.8,1.6,2.2],[0.6,0.6],'shelf',
    { band:'service', stackable:true, mergeInto:{ ref:'entry1', kit:'wardrobe-run' } }),
],
rules: [
  { a:'entry1', b:'livingkitchen1', kind:'door', reason:'ARC-18 entry opens into the living space' },
  { a:'entry1', b:'bathroom1',      kind:'door', reason:'ARC-19 bath off circulation, not off a habitable room' },
  { a:'bathroom1', b:'livingkitchen1', kind:'no-door', regions:['UK','IE'],
    reason:'ADG G/Part F: a WC must not open directly into a kitchen or food-prep space' },
  { a:'bathroom1', b:'laundry1', kind:'share-edge', reason:'XD-01 wet rooms share one stack' },
],
zoneOrder: [['circulation','service'],['public']],
wetGroups: [['livingkitchen1','bathroom1','laundry1']], maxStacks: 1,
```

Derived admissible region (the expected test values):

| net depth | service band Fd | Fmin | Fmax (binding) |
|---|---|---|---|
| 7.5 | 2.4 | 4.30 | 6.00 (area.max/D) |
| 8.5 | 2.4 | 4.30 | 5.30 (area.max/D) |
| 9.5 | 2.4 | 4.30 | 4.74 (area.max/D) |

Compare `UNIT_TEMPLATES.studio.frontage = {min 4.2, max 5.8}` — derived Fmin agrees to 0.1 m and Fmax is now depth-aware, which is exactly the check the old code never made.

### 3.2 `1b1b` — 55/58/65 m², 1 level, shapes: zoned, through (dual variant)

```ts
nodes: [
  n('living1','living',[16,20,26],[3.4,3.05],'living-3seat',{ band:'daylit', needsExterior:true, zone:'public', maxWidth:7.0, maxDepth:7.0 }),
  n('kitchen1','kitchen',[6.5,8.5,11],[3.1,1.8],'kitchen-galley-washer',{ band:'service', wet:true, zone:'service', maxWidth:6.0, maxDepth:4.6 }),
  n('bedroom1','bedroom',[11.5,13,16],[2.75,2.6],'bed-double',{ band:'daylit', needsExterior:true, zone:'private', maxWidth:4.8, maxDepth:5.6 }),
  n('bathroom1','bathroom',[3.7,4.6,5.5],[1.7,2.2],'bath-3pc-tub',{ band:'service', wet:true }),
  n('entry1','entry',[2.0,3.6,4.5],[1.2,1.5],'entry',{ band:'circulation', zone:'circulation' }),
  n('hall1','hall',[2.0,2.8,4.0],[1.1,1.1],'none',{ band:'circulation', zone:'circulation', maxDepth:2.8 }),
  n('laundry1','laundry',[1.2,1.6,2.2],[0.8,0.7],'laundry-stack',{ band:'service', wet:true, stackable:true, mergeInto:{ ref:'kitchen1', kit:'kitchen-galley-washer' } }),
  n('closet1','closet',[0.8,1.4,2.2],[0.6,0.6],'shelf',{ band:'service', stackable:true, mergeInto:{ ref:'bedroom1', kit:'wardrobe-run' } }),
  n('closet2','closet',[0.8,1.4,2.2],[0.6,0.6],'shelf',{ band:'service', stackable:true, mergeInto:{ ref:'entry1', kit:'wardrobe-run' } }),
],
rules: [
  { a:'entry1', b:'hall1', kind:'door', reason:'ARC-18' },
  { a:'kitchen1', b:'living1', kind:'share-edge', reason:'ARC-20 kitchen serves the living/dining' },
  { a:'kitchen1', b:'living1', kind:'door', reason:'ARC-20' },
  { a:'hall1', b:'bathroom1', kind:'door', reason:'ARC-19 bath off a hall' },
  { a:'hall1', b:'bedroom1', kind:'door', reason:'ARC-19' },
  { a:'bedroom1', b:'kitchen1', kind:'not-adjacent', reason:'ARC-19 a bedroom is not entered off a kitchen' },
  { a:'bathroom1', b:'kitchen1', kind:'no-door', reason:'ARC-19' },
  { a:'bathroom1', b:'living1', kind:'no-door', regions:['UK','IE'], reason:'ADG G/Part F' },
  { a:'kitchen1', b:'bathroom1', kind:'share-edge', reason:'XD-01 one wet wall, one stack' },
],
zoneOrder: [['circulation','service'],['private','public']],
wetGroups: [['kitchen1','bathroom1','laundry1']], maxStacks: 1,
```

Derived at D = 8.5 (Fd 2.4, hall strip 1.25 in front of the bedroom): service Σmin = 3.1 + 1.7 + 1.2 = 6.0, daylit Σmin = 3.4 + 2.75 = 6.15 → **Fmin 6.15**, Fmax = area.max/D = **7.65**. Template says `{6.0, 7.8}`.

### 3.3 `2b2b` — 85/92/100 m², 1 level, shapes: zoned, through

```ts
nodes: [
  n('living1','living',[19,25,30],[3.8,3.05],'living-3seat',{ band:'daylit', needsExterior:true, zone:'public', maxWidth:7.0, maxDepth:7.0 }),
  n('kitchen1','kitchen',[7.5,10.5,13],[3.1,1.8],'kitchen-island',{ band:'service', wet:true }),
  n('masterbedroom1','master-bedroom',[12.5,14.5,18],[2.9,2.8],'bed-master',{ band:'daylit', needsExterior:true, zone:'private', maxWidth:5.6, maxDepth:6.2 }),
  n('bedroom2','bedroom',[11.5,12,15],[2.75,2.6],'bed-double',{ band:'daylit', needsExterior:true, zone:'private' }),
  n('ensuite1','ensuite',[3.4,4.4,5.2],[1.6,2.1],'bath-3pc-shower',{ band:'service', wet:true }),
  n('bathroom1','bathroom',[3.7,4.8,5.6],[1.7,2.2],'bath-3pc-tub',{ band:'service', wet:true }),
  n('entry1','entry',[2.0,4.2,5.0],[1.2,1.5],'entry',{ band:'circulation', zone:'circulation' }),
  n('hall1','hall',[2.0,4.4,6.0],[1.1,1.1],'none',{ band:'circulation', zone:'circulation', maxDepth:2.8 }),
  n('walkincloset1','walk-in-closet',[1.5,2.6,3.5],[1.0,1.5],'wardrobe-run',{ band:'service', stackable:true, mergeInto:{ ref:'masterbedroom1', kit:'wardrobe-run' } }),
  n('laundry1','laundry',[1.2,2.0,2.6],[0.8,0.7],'laundry-stack',{ band:'service', wet:true, stackable:true, mergeInto:{ ref:'kitchen1', kit:'kitchen-galley-washer' } }),
  n('closet1','closet',[0.8,1.5,2.2],[0.6,0.6],'shelf',{ band:'service', stackable:true, mergeInto:{ ref:'entry1', kit:'wardrobe-run' } }),
  n('closet2','closet',[0.8,1.5,2.2],[0.6,0.6],'shelf',{ band:'service', stackable:true, mergeInto:{ ref:'bedroom2', kit:'wardrobe-run' } }),
],
rules: [
  { a:'entry1', b:'hall1', kind:'door', reason:'ARC-18' },
  { a:'hall1', b:'living1', kind:'door', reason:'ARC-19' },
  { a:'hall1', b:'bathroom1', kind:'door', reason:'ARC-19' },
  { a:'hall1', b:'masterbedroom1', kind:'door', reason:'ARC-19' },
  { a:'hall1', b:'bedroom2', kind:'door', reason:'ARC-19' },
  { a:'masterbedroom1', b:'ensuite1', kind:'door', reason:'ARC-21 en-suite opens off its bedroom' },
  { a:'masterbedroom1', b:'walkincloset1', kind:'door', reason:'ARC-21' },
  { a:'kitchen1', b:'living1', kind:'door', reason:'ARC-20' },
  { a:'ensuite1', b:'bathroom1', kind:'share-edge', reason:'XD-01 two baths on one stack' },
  { a:'kitchen1', b:'bathroom1', kind:'share-edge', reason:'XD-01' },
  { a:'bathroom1', b:'living1', kind:'no-door', regions:['UK','IE'], reason:'ADG G/Part F' },
  { a:'bedroom2', b:'living1', kind:'no-door', reason:'ARC-19 a bedroom is not a passage room' },
],
zoneOrder: [['circulation','service'],['private','public']],
wetGroups: [['kitchen1','bathroom1','laundry1'],['ensuite1']], maxStacks: 2,
```

Derived at D = 9.5: service Σmin 3.1 + 1.7 + 1.6 + 1.2 = 7.6, daylit Σmin 3.8 + 2.9 + 2.75 = 9.45 → **F ∈ [9.45, 10.53]** (Fmax = 100/9.5). Template `{8.8, 11.5}` — v2 is tighter and honest.

### 3.4 `3b2b` — 105/115/125 m², 1 level, shapes: zoned, through

Same pattern, plus `dining1` (`[7,10,13]`, dims `[2.7,2.3]`, kit `dining-4`, band `service`, `needsExterior:false`, `prefer` front — it is the front-band daylit room that forces `Fd ≥ 3.3`) and `bedroom3` single (`[7.5,9.5,12]`, dims `[2.15,2.6]`, kit `bed-single`).
Rules add `{ a:'dining1', b:'kitchen1', kind:'share-edge' }`, `{ a:'dining1', b:'living1', kind:'door' }`, `{ a:'dining1', b:'kitchen1', kind:'door' }`.
Derived at D = 9.5, Fd 3.3: daylit Σmin 4.0 + 2.9 + 2.75 + 2.15 = **11.8**; service Σmin 3.1 + 1.7 + 1.6 + 1.2 + 2.7 = 10.3 → **F ∈ [11.8, 13.16]**. Template `{10.5, 13.5}`.

### 3.5 `townhouse-2s` — 110/126/140 m², 2 levels, shape: house (spine + 3 v-bands)

```ts
levels: 2,
nodes: [
  // level 0 — spine column: entry + stair, full depth
  n('entry1','entry',[2.4,4.4,5.5],[1.2,1.5],'entry',{ level:0, band:'circulation', zone:'circulation' }),
  n('stair1','stair',[3.2,4.8,6.0],[1.0,3.8],'none',{ level:0, band:'circulation', zone:'circulation', maxWidth:2.4, maxDepth:6.5 }),
  n('living1','living',[20,25,30],[3.4,3.05],'living-3seat',{ level:0, band:'daylit', needsExterior:true, zone:'public' }),
  n('kitchen1','kitchen',[8.5,13,16],[3.1,1.8],'kitchen-galley-washer',{ level:0, band:'daylit', needsExterior:true, wet:true }),
  n('dining1','dining',[7,10,13],[2.7,2.3],'dining-4',{ level:0, band:'daylit', needsExterior:true, zone:'public' }),
  n('powder1','powder',[1.8,2.5,3.2],[1.1,1.5],'wc-2pc',{ level:0, band:'service', wet:true }),
  n('storage1','storage',[1.2,2.4,3.0],[0.9,0.6],'shelf',{ level:0, band:'service', stackable:true, mergeInto:{ ref:'entry1', kit:'wardrobe-run' } }),
  // level 1
  n('stair2','stair',[3.2,4.8,6.0],[1.0,3.8],'none',{ level:1, band:'circulation', zone:'circulation' }),
  n('hall2','hall',[2.0,5.0,7.0],[1.1,1.1],'none',{ level:1, band:'circulation', zone:'circulation', maxDepth:2.8 }),
  n('masterbedroom1','master-bedroom',[12.5,15,18],[2.9,2.8],'bed-master',{ level:1, band:'daylit', needsExterior:true, zone:'private' }),
  n('bedroom2','bedroom',[11.5,12,15],[2.75,2.6],'bed-double',{ level:1, band:'daylit', needsExterior:true, zone:'private' }),
  n('bedroom3','bedroom',[7.5,9.5,12],[2.15,2.6],'bed-single',{ level:1, band:'daylit', needsExterior:true, zone:'private' }),
  n('bathroom1','bathroom',[3.7,5.2,6.0],[1.7,2.2],'bath-3pc-tub',{ level:1, band:'service', wet:true }),
  n('laundry1','laundry',[1.2,2.4,3.0],[0.8,0.7],'laundry-stack',{ level:1, band:'service', wet:true, stackable:true, mergeInto:{ ref:'bathroom1', kit:'laundry-stack' } }),
  // closets ×3 merge into their bedrooms
],
rules: [
  { a:'entry1', b:'stair1', kind:'share-edge', reason:'ARC-22 one stair stacks on the party wall' },
  { a:'stair1', b:'stair2', kind:'share-edge', reason:'ARC-22 identical footprint on every level' },
  { a:'entry1', b:'living1', kind:'door', reason:'ARC-10 street → threshold → front room' },
  { a:'living1', b:'dining1', kind:'door', reason:'ARC-10' },
  { a:'dining1', b:'kitchen1', kind:'door', reason:'ARC-20' },
  { a:'entry1', b:'powder1', kind:'door', reason:'ARC-19' },
  { a:'powder1', b:'kitchen1', kind:'no-door', regions:['UK','IE'], reason:'ADG G/Part F' },
  { a:'hall2', b:'masterbedroom1', kind:'door' }, { a:'hall2', b:'bedroom2', kind:'door' },
  { a:'hall2', b:'bedroom3', kind:'door' },       { a:'hall2', b:'bathroom1', kind:'door' },
  { a:'kitchen1', b:'powder1', kind:'share-edge', reason:'XD-01' },
  { a:'bathroom1', b:'kitchen1', kind:'share-edge', reason:'XD-01 wet rooms stack level to level' },
],
zoneOrder: [['circulation','public'],['public','service'],['service']],
wetGroups: [['kitchen1','powder1','bathroom1','laundry1']], maxStacks: 1,
```

This is the shape a narrow-frontage terrace actually has: a full-depth spine (entry + stair, ~1.15 m), then **v-bands** — living at the street, dining, kitchen at the garden — not rooms side by side. Level 1 uses 2 bands each sliced in u (master + bed3 at the front, bath + bed2 at the rear).
Derived at D = 9.0: `Fmin = 1.15 + max(living 3.4, kitchen 3.1, dining 2.7, level-1 front pair 2.9+2.15=5.05, level-1 rear pair 1.7+2.75=4.45) = 6.20`; `Fmax = min(area.max/levels/D, Σmax) = 140/2/9.0 = 7.78`. Template `{6.0, 7.8}`.

### 3.6 Kit table (the source of every `minWidth`/`minDepth`)

| KitId | Mandatory items | Derived min w × d (m) | Clearance source |
|---|---|---|---|
| `kitchen-galley` | sink, range, fridge (+counter, dishwasher) | 2.50 × 1.80 | run 0.8+0.76+0.9 = 2.46; counter 0.6 + aisle 1.2 (CLEARANCE.kitchenAisle) |
| `kitchen-galley-washer` | + washer | 3.10 × 1.80 | +0.6 |
| `kitchen-island` | + island | 3.10 × 3.30 | 0.6 + 1.2 + 0.9 + 0.6 |
| `kitchen-accessible` | sink, range, fridge | 2.70 × 2.70 | ADA 1.5 m turning circle clear of the 0.6 counter |
| `bath-3pc-tub` | wc, basin, bathtub | 1.70 × 2.20 | tub 1.7 across; wc 0.381 centreline→wall + 0.533 front (IPC 405.3.1); basin 0.7 front (CLEARANCE.lavatoryFront) |
| `bath-3pc-shower` | wc, basin, shower | 1.60 × 2.00 | shower 0.9 × 0.9 |
| `bath-accessible` | wc, vanity, roll-in shower, 2 grab rails | 2.20 × 2.60 | ADA 603/604/608; 1.5 m circle |
| `wc-2pc` | wc, basin | 1.10 × 1.50 | IPC 405.3.1 + 0.7 basin front |
| `bed-double` | bed-double, nightstand, wardrobe | 2.75 × 3.20 | 1.37 + 0.75 walkway + 0.45; 1.9 + 0.7 foot; London Plan width 2.75 governs |
| `bed-single` | bed-single, wardrobe | 2.15 × 2.90 | 0.99 + 0.75 + 0.30; London Plan 2.15 |
| `bed-master` | bed-queen, 2 nightstands, wardrobe | 2.90 × 3.40 | 1.52 + 0.75 + 0.5 |
| `living-3seat` | sofa-3, coffee-table, tv-unit | 3.40 × 3.05 | 0.9 + 0.4 + 0.6 + 0.7 + 0.45 |
| `living-kitchen` | `living-compact` + `kitchen-galley` | 3.60 × 4.20 | both runs + 1.2 aisle |
| `dining-4` / `dining-6` | table + 4/6 chairs | 2.70 × 2.30 / 3.30 × 2.40 | 0.75 pull each side (CLEARANCE.diningPull) |
| `laundry-stack` | washer (+stacked dryer) | 0.80 × 0.70 | appliance 0.6 + 0.1 |
| `entry` | bench or shelf + door swing | 1.20 × 1.50 | 0.9 leaf swing square + 0.3 |
| `garage-1car` | car | 3.00 × 5.60 | 1.8 + 2×0.6 door clearance; 4.5 + 1.1 |

`kitMinDims(kit)` returns these; `program/programs.ts` asserts `node.minWidth >= kitMinDims(node.kit).w && node.minDepth >= kitMinDims(node.kit).d` for all 20 graphs in a build-time test. Note the deliberate change: kitchen `minWidth` rises from 2.2 (today, `templates.ts:206`) to 2.5/3.1. That is the price of "every kitchen has a sink, a range and a fridge" and it shifts `Fmin` for `1b1b`, `2b1b`, `dual-key` by +0.3 m; record it in the migration notes.

---

## 4. Algorithms

### 4.1 Plan shapes — the one generalisation that unifies the four plan types

```ts
export interface BandSpec {
  /** columns along the band's slicing axis; each column is a stack of nodes along the band's depth axis */
  columns: NodeRef[][];
  depth: Range; daylit: boolean;
}
export interface PlanShape {
  type: 'zoned' | 'house' | 'through' | 'cluster' | 'dual-key';
  /** full-depth column at u = 0 (stair, entry spine, garage) */
  spine?: { nodes: NodeRef[]; width: Range };
  /** in v order from the access side */
  bands: BandSpec[];
  /** true → bands run along u and are sliced in v (the through plan is the transpose) */
  transpose: boolean;
  level: number;
}
export function planShapesFor(g: ProgramGraph, o: FeasibilityOpts): PlanShape[];  // deterministic, preference-ordered
```

`zoned` = 2 bands (service+circulation, then daylit, hall strip inside the private column).
`house` = spine + 2–3 bands, the access band daylit (own front door).
`through` = `transpose: true`, two end bands daylit, service columns on the party wall, hall strip along the access wall.
`cluster` = hall band with bedroom/en-suite pairs either side.
`dual-key` = two sub-shapes sharing a vestibule column.

Each module variant **freezes one shape**, so `useThroughPlan` (`unit-layout.ts:870`) and the `flipV` surprise disappear: the plan type is module identity, chosen by the placer from what the strip offers.

### 4.2 Feasibility / frontage-range derivation

```
feasibleShape(shape, F, D):
  1. band depths: for each band b,
       dMin(b) = max over columns of Σ node.minDepth,   dMax(b) = min over columns of Σ node.maxDepth
     allocate(D − spineFixed, bands by dMin/dTarget/dMax)  →  fails ⇒ shape infeasible at D
  2. per band b with depth d:
       colMin(col,d) = max( max node.minWidth , Σ node.area.min / d )
       colMax(col,d) = min( min node.maxWidth , Σ node.area.max / d )
       bandMin(b) = Σ colMin,   bandMax(b) = Σ colMax
  3. Fmin = spine.width.min + max over bands of bandMin
     Fmax = spine.width.max + min( min over bands of bandMax , area.max(level) / D )
  4. if Fmin > Fmax: try, in order — (a) move a `stackable` node into a second row behind a wet
     column (needs band depth ≥ node.minDepth + 2.2), (b) apply `mergeInto` for the smallest
     mergeable node, (c) next shape. Each successful (a)/(b) is recorded in the witness, not warned.
  5. return { ok:true, frontage:{min:Fmin,max:Fmax}, bands, widths: per-node bounds }
```

`feasibleAt(g, D, o)` = best (widest) feasible shape at `D`; `admissibleDepths(g,o)` = bisect `D` over `[4, 22]` at 0.25 m steps, memoised per `(programId, shapeType, optsHash)`. `catalogue.frontageAt(id, depth)` memoises by `round(depth, 2)`.

### 4.3 Width allocation (one function, used for band depths, room widths and slot frontages)

```ts
export function allocate(total: number, items: { min: number; target: number; max: number }[]): number[] | null;
```

```
if Σmin > total + 1e-6 → null            (caller must change the shape, never squeeze)
w = min;  slack = total − Σmin
weight_i = max(0, target_i − min_i);  if Σweight == 0 → weight_i = 1
loop ≤ n times:
  give slack proportionally to weight over the unsaturated set, clamp at max, recompute residual
residual < 1e-6 → done;  else park the residual on the largest-`target` unsaturated item
snap every boundary to 0.005 m and put the rounding error on the largest item
```

Deterministic, allocation-order-independent, never below `min`, never above `max`.

### 4.4 Door placement (`program/doors-in-unit.ts`)

```
1. required edges: every rule with kind 'door' becomes a mandatory door; the graph's
   connectivity is then completed with Dijkstra over `transitCost` (reuse unit-layout.ts:140)
   restricted to edges not forbidden by 'no-door' rules for the region.
2. for each edge (a,b):
   into  = the room served: b unless (b is a bath/closet with area < 4.6 m² or min dim < 1.55 m)
           or (b is accessible) → then into = a (swing out) and motion stays 'swing';
           if neither room can hold the swing clear of its kit → motion = 'sliding'
           (pocket on the side with more wall), or 'folding' for a cupboard front.
   width = leafFor(kind): 0.90 entry, 0.85 accessible interior, 0.80 interior, 0.75 bath,
           0.70 closet-front; the shared edge is ≥ width + 0.20 BY CONSTRUCTION because the
           program's minWidth for every node was derived with that allowance.
   avoid = centre of the kit's fixture run in `into` (the wet wall side)
   { hinge, swing } = solveSwing({ wall, along, width, motion, into: into.world, avoid })
   reserve swingRect in `into` BEFORE kits are placed (kits then cannot occupy it)
3. accessible: also reserve a 1.5 m circle on the approach side; hinge such that the pull side
   has 0.45 m latch clearance.
4. assert: probe(hingePoint + dirAtLeaf·0.3·width + normal·0.05) ∈ into.rect  → otherwise throw
   (a solver bug, not a warning).
```

### 4.5 Kit placement (`program/kits.ts`)

```
fitKit(room, kit, swings, wetEdge):
  candidates = [wetWall, lateralA, lateralB, opposite]           // same order as furnishBathroom today
  for wall in candidates:
    items = kit.items(alongLength(wall))                          // mandatory first
    for off in offsets(spare)                                     // centred, then 0.1 m sweep
      if every box clear of swings/taken/inner → place, return ok
  // two-wall fallback: keep the mandatory run on the wet wall, turn the last item onto a lateral
  // (the bathroom's existing fallback, now shared by the kitchen — today only furnishBathroom has it)
  if still unplaced mandatory → throw  (impossible: min dims came from this kit)
```

The kitchen gets the bathroom's offset sweep and fallback wall (`unit-layout.ts:2692-2724` generalised), which is exactly the missing piece behind the 5 fridge-only kitchens on `us-5-over-1`.

### 4.6 1-D packing with quotas (`placer/packer.ts`)

```ts
export function packStrip(args: {
  strip: StripDef; catalogue: ModuleCatalogue; grid: BayGrid;
  quota: QuotaState; rng: Rng; breaks: Interval[]; opts: FeasibilityOpts;
}): { slots: Slot[]; remnants: Slot[]; report: StripReport };
```

```
Phase 0 — candidates
  C = catalogue.candidatesFor(strip) filtered by catalogue.frontageAt(id, strip.netDepth) != null
      (THE depth filter, at the netDepth computed exactly where floor-organizer.ts:382 computes it)
      + end positions restricted to variants with needs.endOfBar / minExteriorCount satisfied.
  if C is empty → the strip is not a dwelling strip: emit an amenity/MEP/storage slot and record
    deviation ARC-D07 (strip depth D admits no dwelling module).

Phase 1 — multiset by quota
  L = strip length; target n = round(L / weightedMeanFrontage(C, quota))
  pick n modules by largest quota deficit (deficit_t = requested_t·N − delivered_t − ledger_t),
  ties broken by rng.weighted over equal-deficit ids (seeded `${seed}:${stripId}`)
  ends: replace slot 0 / n−1 with the best corner/end variant of the same template when available
  repair: while Σ frontage.min > L → swap the largest-min module for the best-fitting smaller one
          in deficit order; if none fits, n -= 1
          while Σ frontage.max < L → insert the highest-deficit module that fits the residual;
          if none fits, the residual goes to Phase 3

Phase 2 — widths + grid snap
  w = allocate(L, modules.map(m => catalogue.frontageAt(m.id, netDepth) with target = areaTarget/netDepth))
  cumulative boundaries b_k; snap each to the nearest multiple of grid.module subject to
  w_k ∈ [min_k, max_k] (left-to-right, backtrack ≤ 2 boundaries); then choose the column-line
  subset: greedily keep boundaries so consecutive column spacing ∈ [bay.min, bay.max]; a module
  wider than bay.max contributes its interior `party-line` port at atFrac 0.5.

Phase 3 — remnants
  r = L − Σw;  if r < min over C of frontage.min → emit kind 'remnant' with roomType
  'flex' (r ≥ 3.0) or 'storage', and record deviation ARC-D02 with r. Never widen a unit past max.

Phase 4 — ports
  for each slot: resolve module ports into world XY via the boundary + mirrored flag;
  assert stack ports of vertically-identical slots share atFrac (else deviation ARC-D05).
```

Quota state (`placer/quota.ts`) is **building-wide**: `apportion(targetUnits, stripLengths)` (reuse `bar-frame.ts:123`) per floor, and a `ledger` of per-template deficits carried across floors in storey-index order. `mixDeviation = 0.5 · Σ_t |delivered_t/N − requested_t|` (total variation), asserted ≤ 0.08.

### 4.7 Knuckle joining and corridor legs (`placer/corridors.ts`)

```
1. one band per bar from massing.corridors (unchanged), clipped to the bar envelope
2. for each ordered pair of bars (bi, bj) sharing a corner: k = intersection of the two bands
   (extend each band along its axis by width/2 to close the corner). If k is non-empty and inside
   both bar rects → knuckle node at rectCenter(k), rect = k widened to max(width_i, width_j).
   Register k as a blocker in BOTH bars' strip intervals (that is why bars are independent today).
3. graph: nodes = { ends, knuckles, core-adjacent points, break slots }; edges = band segments
   between consecutive nodes, each with its length.
4. legs: walk each edge chain between nodes of degree ≥ 3 / core / exit; while cumulative length
   > 45 m (ARC-03) insert a BreakModule at the best position — preference: a daylit end
   (`K-window-bay`), then a core side (`K-lift-lobby`), then mid-run (`K-lounge`) — consuming
   frontage from the adjacent unit strip (Phase 3 of the packer runs after break reservation).
5. dead ends: any degree-1 node whose path to the nearest exit/degree-3 node exceeds 6.0 m
   (15.0 m when typology.sprinklered) → insert `K-exit-stair` or shorten the strip; record
   deviation ARC-D03 with the applied resolution.
6. travel distance: Dijkstra on the graph from each unit entry port to the nearest core node,
   replacing the Manhattan approximation in `architecture/index.ts:409-429`.
7. O/U/L/T: an O-plan yields 4 knuckles and one cyclic graph — a single connected corridor,
   which is also what makes 4 disjoint corridors impossible.
```

### 4.8 Override application (`placer/apply-overrides.ts`)

```
applyOverrides(base, doc, ctx):
  edits = [...(doc.layouts?.[base.key] ?? []), ...(doc.storeys?.[ctx.storeyId] ?? [])]
  sort edits by (opRank, slotId) so the result is order-independent:
    opRank: removeSlot < swapModule < mirror < setSlotKind < moveBoundary < insertSlot < moveCore < unit
  for each edit:
    validate against the same machinery that produced the base:
      swapModule    : catalogue.frontageAt(new, netDepth) must contain the slot frontage, else
                      widen/narrow within the neighbours' elastic ranges; if impossible → clamp to
                      the nearest admissible module of the same template and record ARC-D10
      moveBoundary  : clamp delta so both slots stay inside [min,max] at netDepth AND the boundary
                      stays on grid.module; column-line subset recomputed
      insertSlot    : take frontage from neighbours down to their min; if not enough → reject with
                      ARC-D11 (never overlap)
      removeSlot    : give the frontage to neighbours up to their max, remainder → remnant slot
      moveCore      : clamp `along` to the admissible positions (end clearance 6 m, exit separation
                      ≥ diagonal/3 sprinklered) and re-run the strips for that bar
      unit          : forwarded to UnitLayoutRequest.edits; the solver clamps partition drags to the
                      program's [min,max] area/width, furniture moves to the room minus swings,
                      door moves to the opening tracker's free spans, room-type swaps to types whose
                      kit fits the existing rect
  recompute: ports, party lines, mix report, corridor graph, layoutKey = `${key}#${hashOverrides(edits)}`
```

Everything is a pure function of `(base, edits)`, so byte-identical reruns hold, and the layout cache keyed on `layoutKey` keeps typical-floor propagation free: editing L02 with layout scope re-solves once for L02–L14.

---

## 5. Module self-test

```ts
export interface SelfTestCase { moduleId: string; frontage: number; depth: number; level: number; exteriorSides: Side[]; region: Region; }
export interface SelfTestFailure { case: SelfTestCase; check: string; detail: string; }
export function selfTestCatalogue(c: ModuleCatalogue, o?: { frontageSamples?: number; depthSamples?: number }): SelfTestFailure[];
```

Samples per unit module: depth ∈ {min, min+0.25, mid, max−0.25, max}; frontage ∈ {min, min+0.05, mid, max−0.05, max} of `frontageAt(depth)`; levels 0..levels−1; regions {US, UK}; exterior-side sets from `variant`. ≈ 55 × 5 × 5 × 2 ≈ 2 750 layouts.

Checks (each is one assertion with a named `check` string):

| check | assertion |
|---|---|
| `tiles` | rooms tile the net rect ≥ 99.5 %, no pairwise overlap |
| `reachable` | BFS from the entry room over `graph.edges` with a door/opening reaches every non-balcony room |
| `daylight` | every node with `needsExterior` has ≥ 1 window |
| `kit-complete` | every room's kit mandatory items all placed (kitchen ⇒ sink+range+fridge; bath ⇒ wc+basin+(shower\|tub)) |
| `swing-clear` | no furniture/fixture intersects any `swings[]` rect |
| `swing-into` | for every swing door, the probe point lies inside `swingIntoRoomId`'s rect |
| `trap-arm` | every wet fixture's routed length to its assigned `StackPort` ≤ `maxTrapArm(dia)`; stacks ≤ `maxStacks` |
| `min-dims` | every room ≥ its node's `minWidth × minDepth`, aspect within bounds |
| `min-leaf` | every door width ≥ the leaf minimum for its kind |
| `adjacency` | every `share-edge`/`door` rule satisfied; no `no-door`/`not-adjacent` rule violated for the region |
| `ports` | every `required` port resolved; `atFrac` invariant under mirroring |
| `determinism` | two runs of the same case are deep-equal |

A module whose sweep produces any failure is **not admitted to the catalogue** — `buildCatalogue()` in dev mode throws, in production narrows the module's `frontage`/`depth` envelope to the largest failure-free interval and records it.

---

## 6. Warnings-to-zero mapping

| Warning family (source) | Mechanism that makes it impossible | Test that asserts it |
|---|---|---|
| `unit <t> has N m frontage, below the M m minimum for that template at D m depth` (`floor-organizer.ts:413`) | Packer only uses modules with `frontageAt(netDepth) ≠ null` and allocates inside `[min,max]` | `packer.test.ts` **fit conformance**: for every slot of every preset, `frontageAt(slot.moduleId, strip.netDepth)` contains the slot frontage |
| `unit slot too small (w×h) — skipped` (`:1365`) | Slots are created from module ranges, never from leftover geometry; leftovers become declared remnants | fit conformance + `slots.every(s => s.kind !== 'unit' \|\| fits)` |
| `N m of frontage left over — placed as a flex room/store` (`:448`) | Remnant only when `r < min module frontage`; otherwise absorbed by the allocator | `remnants.every(r => r.boundary width < minModuleFrontage)` |
| `service band: kitchen 1.90 m (min 2.20 m) — only …` (`fitWidths` squeeze, `unit-layout.ts:370`) | `allocate` returns `null` rather than squeezing; the witness gate means it is never called below `Σmin` | `feasibility.test.ts`: `allocate` never returns a value below any `min`; solver throws if `F < fit.frontage.min` |
| `<room> moved into the service band with no exterior wall` / `daylit rooms squeezed below minimum width` (`:560`, `:564`) | Band membership is declared in the program; the eviction loop is gone; `Fmin` already counts every daylit room side by side | self-test `daylight` over the whole catalogue |
| `no room for laundry, closet … in a F × D rect` (`:1457`) | `stackable` second row + declared `mergeInto` are program alternatives recorded in the witness | self-test `kit-complete` + `feasibility.test.ts` asserts the witness lists the merges |
| `<room> needs daylight but has no exterior wall on this rect` (`:1886`) | Program declares `needsExterior`; `Fmin` includes every such room's `minWidth` in a daylit band; variants declare `needs.minExteriorCount` | self-test `daylight`; `bedroom-exterior` test over all presets: every room of type bedroom/master-bedroom has ≥ 1 window |
| `door narrowed to 0.60 m — below the 0.75 m minimum leaf` (`:1722`) | Every node's `minWidth` was derived with leaf + 0.20 m; shared edges are therefore ≥ leaf + 0.2 | self-test `min-leaf`; preset test `doors.every(d => d.width >= leafMin(d))` |
| `requested stack position u=… sits in the kitchen and no order of the wet band covers it` (`:1447`) | Stack is an **output** port at the wet cluster's own fraction; nothing imposes a coordinate | `ports.test.ts`: identical `moduleId+mirrored+frontage` slots on different storeys have equal `atFrac` and equal world XY |
| `counter run only N m — no space for a range` / `kitchen fixtures reduced` (`:2556`, `:2558`) | `kitchen-galley*` kit min dims are the room's min dims; sweep + fallback wall added | self-test `kit-complete`; `kits.test.ts`: `fitKit` succeeds on the exact `kitMinDims` rect with a worst-case door swing |
| `no clear position for the wc/vanity in a w×h room` (`:2746`), `washer does not fit` (`:2789`) | Same mechanism per kit; swing reserved before kits | self-test `kit-complete` + `swing-clear` |
| `fixtures run on the wall opposite the wet wall because the door swing covers it` (`:2700`) | Hinge chosen with `avoid` = fixture-run centre, so the swing never covers the run | self-test `swing-clear` + `trap-arm` |
| `work triangle N m outside the 4–8 m guideline` (`:2614`) | Kit lays sink–range–fridge in one run with gaps sized from the available length; triangle is bounded by the kit's own geometry | `kits.test.ts`: triangle ∈ [3.6, 8.0] for every kitchen kit at every admissible room size |
| `glazing reaches N % of the glazable façade against an M % target` (`:1875`) | Module declares `daylight` ports (glazable façade length) and the feasibility gate rejects a frontage where the WWR budget cannot be met at the given floor-to-floor | `wwr.test.ts`: achieved ≥ target − 0.03 on every preset |
| `corridor C on S runs 77.7 m without a break` (`architecture/index.ts:364`), egress travel (`:360`) | Break modules every ≤ 45 m; dead ends ≤ 6/15 m; travel on the corridor graph | `corridor.test.ts`: every leg ≤ 45 m, every dead end within limit, graph one component per bar ring |
| `residential net-to-gross is only 0.4` (`:368`) | Remnants bounded, landings sized from `CoreModule` footprint ranges, knuckles shared | `efficiency` test (already exists at `architecture.test.ts:241`) tightened to 0.62–0.90 |
| `core spacing leaves only N m per landing side` (`:784`, `:798`) | `CoreModule` footprint ranges + the stair-core module pitch (`core + landing + k·admissible frontage`) drive `coreCount`, instead of validating it afterwards | `packer.test.ts` stair-core case: every landing side ≥ the narrowest admissible module |
| `door <id> hosted in unknown wall — dropped` (`:1434`) | Doors are minted by `placeCanonical` against walls it also mints/looks up; the canonical layout's wall refs are indices, resolved at placement | `writer.test.ts` + preset test `doors.every(d => wallById.has(d.wallId))` |
| **plumbing**: `vented:<t>`, `split:<t>`, `chase:<t>` (`stacks.ts:137-175`) | `stationsForGroup` seeds from `UnitInstance.stackPorts`; `maxArm` was already asserted by the module self-test | `plumbing.test.ts`: `derived.trapArmSplits === 0 && derived.ventedFixtures === 0` on all presets |
| **plumbing**: synthesised wc/lavatory/shower (`fixtures.ts:185-255`) | Kits guarantee the fixtures exist as `needsWater` furniture | `plumbing.test.ts`: `derived.synthesisedFixtures === 0`; delete the synthesis branch |
| **plumbing**: `VW-<roomId>` virtual wet wall (`fixtures.ts:103-110`) | Every fixture's room is in a `wetGroup` bound to a real wet wall | `plumbing.test.ts`: no fixture has a `wallId` starting `VW-` |
| door arc on the wrong side (`plan-svg.ts:287-302`) | `hinge`/`swing` from one geometric probe; all consumers read them | `doors.test.ts` **swing regression**: for every preset, for every swing door, probe inside `swingIntoRoomId`; non-swing doors produce no arc path |

---

## 7. Migration steps (tests stay green at every step)

| Step | Work | Green because |
|---|---|---|
| **M0** | `core/openings.ts`; `DoorDef` v2; update the 17 producers + 4 consumers; `crossLink` dedupe; new `doors.test.ts` | Only door arcs/psets change; update the 2 assertions that read `operation` (`unit-layout.test.ts`, `writer.test.ts`) |
| **M1** | `program/kits.ts` extracted from `unit-layout.ts` `furnish*`; kitchen sweep + fallback; `kitMinDims`; `furnishRoom` delegates | Pure refactor + strictly more kitchens complete; existing furniture assertions hold |
| **M2** | `program/types.ts`, `programs.ts` (all 20), `feasibility.ts`; conformance test vs `UNIT_TEMPLATES` ranges | Nothing consumes it yet |
| **M3** | `program/solver.ts` + `doors-in-unit.ts` + `validate.ts`; export `layoutUnitV2`; run the whole `unit-layout.test.ts` suite against both; flip `DEFAULT_DEPS.layoutUnit` (`architecture/index.ts:52`) | The test suite is the switch criterion; `setArchitectureDeps` already allows A/B |
| **M4** | `src/modules/*` + `self-test.ts` + `modules.test.ts` | Additive |
| **M5** | `placer/{types,strips,packer,quota}.ts`; `planFloorLayout` delegates for `corridor-double/single/gallery`; `instantiateFloor` consumes `Slot` (adapter keeps the old `UnitSlot` path for the not-yet-ported access types) | ARC-08 typical-floor tests and the efficiency band still hold; mix/fit tests added |
| **M6** | Port `stair-core`, `point-core`, `cluster`, `houses`; `placer/corridors.ts` (graph, knuckles, breaks); travel distance from the graph | `architecture.test.ts:382` (ARC-07) and `:371` (ARC-09) updated to the graph |
| **M7** | `core/overrides.ts` + `placer/apply-overrides.ts` + `spec.overrides`; `overrides.test.ts` | Empty doc = identity, so all existing outputs are byte-identical |
| **M8** | Downstream ports: plumbing `stackPorts` (delete synthesis/second stack/virtual wall), mechanical `shaftSlotFor(purpose)` + exhaust ports, electrical panel port + `latchSide` | Each discipline's own test suite plus the new zero-warning assertions |
| **M9** | Delete dead code (below); tighten `warnings.length === 0` in `architecture.test.ts:423` | Nothing references it |

**Dead code deleted at M9**

`floor-organizer.ts`: `choosePicks` (195-229), `narrowPool` (237-262), `weightedIndex` (264-272), `fitFrontages` (275-339) incl. the `list.pop()` escape and the `frontage.max × 1.2` stretch, `minFrontage` (177-180), `frontageOf` (182-185), `MixPool`/`Pick`, the remnant-widening branch (429-436).
`unit-layout.ts`: `fitWidths` squeeze branch (351-372) and the whole function, `toFitItem`, the `planRegion` eviction loop (551-562), the `planThrough` column-dropping loop (921-929) and its optional-column drop, `slideWetCluster` (766-818), `wetStackU` (1969-1978), the dropped-room tally (1451-1458), `SILENT_DROP`, `DROPPABLE`, `stackHit`/`stackBlockedBy`.
`templates.ts`: `recommendedRect` (783-789) — superseded by `frontageAt`; keep `programArea`/`programBedspaces` for the XD-05 checks.
`types-internal.ts`: `UnitSlot.stackAlong`.
`plumbing/fixtures.ts`: the synthesis block (185-255) and the `VW-` fallback (103-110). `plumbing/stacks.ts`: the second-stack/`chase` paths (≈137-175) reduce to "seed from ports, assert".

---

## 8. Tests to add or replace

| File | Content |
|---|---|
`/Users/samarvir/formaIFC/generator/src/modules/modules.test.ts` | `selfTestCatalogue()` must return `[]`; catalogue shape (ids unique, every template represented, every `required` port present); JSON round-trip of module records
`.../src/disciplines/architecture/program/feasibility.test.ts` | worked examples of §3 (studio/1b1b/2b2b/3b2b/townhouse-2s at 2–3 depths, ±0.05 m); monotonicity (`Fmin` non-increasing in `D` until a room's `maxDepth` binds); `allocate` never violates min/max; every `UNIT_TEMPLATES[x]` range intersects the derived region (documented exceptions listed)
`.../src/disciplines/architecture/program/kits.test.ts` | `fitKit` succeeds on exactly `kitMinDims(kit)` with a worst-case swing on each wall; mandatory sets; kitchen work triangle 3.6–8.0; `node.minWidth ≥ kitMinDims(node.kit).w` for all 20 graphs
`.../src/disciplines/architecture/doors.test.ts` | swing regression over all 10 presets (probe ∈ `swingIntoRoomId`); `doorOperation` XOR table (all 8 hinge×swing×motion combinations); `drawsArc` false for sliding/folding/rolling/opening; `latchSide` opposite the hinge; every door width ≥ its leaf minimum
`.../src/disciplines/architecture/placer/packer.test.ts` | fit conformance; mix deviation ≤ 0.08 per preset; grid snap (boundaries on `grid.module`, column spacing ∈ `[bay.min, bay.max]`); remnant bound; corner/end variants at bar ends; determinism
`.../src/disciplines/architecture/placer/corridor.test.ts` | legs ≤ 45 m; dead ends ≤ 6/15 m; O-plan single component with 4 knuckles; knuckle rects disjoint from every slot; graph travel ≤ the typology limit
`.../src/disciplines/architecture/placer/overrides.test.ts` | empty doc = byte-identical model; id stability under insert/remove; clamping + deviation records; typical-floor propagation (edit on L02's key changes L02–L14, storey scope changes only L02); order independence (shuffled edit arrays → deep-equal layout)
`.../src/ports.test.ts` (new, cross-discipline) | stack ports align vertically; every wet fixture ≤ `maxTrapArm` of its port; `shaftSlotFor(purpose)` returns disjoint rects for plumbing/mechanical/electrical; exhaust ports terminate at an exterior or shaft
`.../src/perf.test.ts` (new) | `ie-courtyard` full pipeline < 2 000 ms and architecture < 700 ms; `ca-point-tower` (22 storeys) full pipeline < 2 000 ms; catalogue build < 120 ms
Replace in `.../src/disciplines/architecture/architecture.test.ts` | `:423` "warnings flag remnants, undersized frontages…" → **`warnings.length === 0` for all 10 presets** plus `deviations` carry the expected codes; `:241` efficiency band tightened; `:268` wet-wall stacking now asserts port equality

---

## 9. Performance

Budget: `ie-courtyard` (171 units, 5 storeys) and a 22-storey tower each < 2 s for the whole pipeline.

| Lever | Detail |
|---|---|
**Canonical layout cache** | `layoutUnitCanonical` is pure in the local `(u,v)` frame that `makeFrame` already provides. Key = `moduleId ∣ frontage(mm) ∣ depth(mm) ∣ level ∣ exteriorLocal ∣ exposureLocal ∣ wwr ∣ region ∣ detail ∣ balcony ∣ editsHash`. `ie-courtyard` collapses 171 solver runs to ≈ 40; `placeCanonical` is a translate + id mint (O(rooms)). This also *guarantees* identical stacking rather than hoping for it.
**Memoised feasibility** | `frontageAt` memoised by `(moduleId, round(depth,2), optsHash)`; `admissibleDepths` computed lazily per module on first use. Whole-catalogue worst case ≈ 55 × 70 depth samples × ~20 nodes of arithmetic ≈ 80 k operations ≈ 10 ms.
**Catalogue once per process** | `buildCatalogue()` memoised; self-test runs in tests only (`selfTestCatalogue` is not on the generate path).
**Packing is O(n log n)** | Two-phase, no DP over quota vectors; snapping backtracks ≤ 2 boundaries.
**Corridor graph** | O(bars²) knuckle detection with ≤ 4 bars; Dijkstra over ≤ 40 nodes per floor, computed once per typical floor and reused.
**No new O(n²)** | The per-unit adjacency scan stays O(rooms²) with rooms ≤ 26 (`coliving-cluster`); everything above the unit is interval arithmetic.
**Measured split target** | site 150 ms · arch plan 150 ms · arch instantiate 350 ms · structure 200 ms · MEP 700 ms · writer 400 ms.

---

## 10. Split into three implementation agents

### Day 0 — one freeze commit, no behaviour change (whoever starts first, reviewed by all three)

Land the type-only skeleton so the three agents compile against each other:
`src/core/openings.ts` (signatures + implementations, they are 40 lines), `DoorDef` v2 in `src/core/types.ts`, `src/core/grid.ts`, `src/core/overrides.ts`, `src/disciplines/architecture/program/types.ts`, `src/modules/types.ts`, `src/disciplines/architecture/placer/types.ts`, `unit-layout-types.ts` v2, `UnitInstance`/`ArchModel`/`BuildingSpec` additions. Functions throw `new Error('not implemented')` where a body is still owed.

### Agent A — "Openings, kits, downstream ports" (steps M0, M1, M8)

Owns `src/core/openings.ts`, `src/core/types.ts`, `program/kits.ts`, every door producer/consumer, `crossLink`, and the cross-discipline port consumption in plumbing/mechanical/electrical. Smallest and first; unblocks B and C. Deliverables: `doors.test.ts`, `kits.test.ts`, `ports.test.ts`, plumbing/mech/elec suites green with the synthesis paths deleted.

### Agent B — "Program solver v2" (steps M2, M3)

Owns `program/{types,programs,feasibility,solver,doors-in-unit,validate}.ts` and the shrinking of `unit-layout.ts`. Depends on A's `kits.ts` and `openings.ts` only (both frozen day 0; can stub `fitKit` from `kitMinDims` until A lands). Deliverables: all 20 program graphs, `feasibility.test.ts`, `layoutUnitV2` passing the whole existing `unit-layout.test.ts` suite, then the dep flip.

### Agent C — "Modules, placer, overrides" (steps M4, M5, M6, M7)

Owns `src/modules/*`, `placer/*`, `floor-organizer.ts`, `cores.ts` core-module consumption, `architecture/index.ts` wiring. Depends only on B's frozen `feasibility` API — stub `feasibleAt` with the current `UNIT_TEMPLATES` frontage/depth ranges on day 0 and swap to the real one when B lands; every downstream test is written against the real API. Deliverables: catalogue + self-test, packer + quota, corridor graph + knuckles + breaks, `FloorLayout` v2 + overrides, `packer.test.ts`, `corridor.test.ts`, `overrides.test.ts`, `perf.test.ts`.

**Dependency order:** freeze → A(M0) → {B(M2,M3) ‖ C(M4,M5)} → C(M6,M7) → A(M8) → M9 cleanup (any agent, one commit).

**Contracts frozen first, in priority order:** (1) `DoorDef` v2 + `openings.ts` signatures; (2) `ProgramGraph` + `Feasibility` + `allocate`; (3) `ModuleCatalogue` (`frontageAt`, `fitFor`, `candidatesFor`) + `Port`; (4) `UnitLayoutRequest`/`UnitLayout` v2 incl. `StackPort`/`ExhaustPort`/`PanelPort`; (5) `Slot`/`FloorLayout` v2 + `OverrideDoc`; (6) `BayGrid`. None of these may change after day 0 without a three-way review, because each is the seam between two agents.

---

### Critical Files for Implementation

- `/Users/samarvir/formaIFC/generator/src/core/types.ts` — `DoorDef` v2, `UnitInstance` ports, `ArchModel.deviations`, `BuildingSpec.overrides`
- `/Users/samarvir/formaIFC/generator/src/disciplines/architecture/unit-layout.ts` — the deform-then-warn machinery being replaced (`fitWidths` :328-382, `planRegion` :539-758, `planThrough` :888, `slideWetCluster` :766, door `dirIn` :1733-1738, kitchen run :2528, bathroom sweep :2628)
- `/Users/samarvir/formaIFC/generator/src/disciplines/architecture/floor-organizer.ts` — `choosePicks`/`narrowPool`/`fitFrontages` :195-339, `packStrip` `netDepth` :382 (the depth filter), `FloorLayout` producer/consumer seam :70 and :1206
- `/Users/samarvir/formaIFC/generator/src/disciplines/architecture/templates.ts` — the 20 room programs the program graphs are derived from
- `/Users/samarvir/formaIFC/generator/src/app/plan-svg.ts` — the visible door bug (arc at :287-302, `along()` helper at :630)
