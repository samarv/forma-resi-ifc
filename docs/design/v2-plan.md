# forma-resi-ifc v2 — correct-by-construction coordination, lego modules, floorplan editor

## Context

Iteration 1 (live at https://samarv.github.io/forma-resi-ifc/) generates a full six-discipline
residential building to IFC4, but it works **generate-then-warn**: each discipline lays out what it
can and pushes a string into `ctx.warnings` when an upstream decision made its job impossible. The
ie-courtyard run shows 51 warnings, all of which trace to five root causes:

| symptom (from the 51) | root cause today |
|---|---|
| unit too small for its template (laundry, service band, daylit width, bedroom w/o window, 0.60 m door) | floor organiser cuts rects *then* forces a template into them; templates have no admissible frontage range |
| fixtures off the wet wall, trap arms > limit, second stacks, synthesised WC/sink | unit layout does not treat the stack as a port; plumbing discovers fixtures after the fact and repairs |
| slab 0.20 vs 0.25, core wall 0.25 vs 0.30 | structure sizes *after* architecture; two owners for one number |
| 77.7 m corridor, 4 cores 11.5 m apart, parking 110/222, 15 > 8 storeys | massing/site validates instead of resolving; UI lets the user enter an out-of-range spec |
| door arc on the wrong side | `DoorDef` has no hinge/swing fields — the renderer and the writer each infer one |

The user's brief for v2 (verbatim intent): editable apartment floorplans in the app; furniture with
lightweight-but-recognisable 3D in IFC; every apartment plan must make sense (sizes, connectivity,
adjacency); MEP + structure line up with the plan; floorplans/cores as prebuilt *legos* the user
places and spreads over a footprint; a rule system so coordination issues **cannot arise**;
custom rules defined via UI; constructability (no unsupported cantilevers, no free-floating pipes);
explicit ceiling-stacking patterns per floor use (parking + MEP rooms vs retail vs living); the door
bug; and a system that makes the 51 warnings go away by construction.

Standing constraints: Fable orchestrates, **every sub-agent runs on Opus**; erasable TypeScript only,
zero runtime deps, Node 24 type-stripping (`/Users/samarvir/.nvm/versions/node/v24.21.0/bin/node`),
`npm run typecheck` must exit 0, deterministic output (seeded RNG, byte-identical reruns), the single-file
app must keep working offline, deploy = copy build to `docs/index.html` and push.

## Design principles (what makes issues impossible rather than reported)

1. **One owner per fact, decided before anyone consumes it.** Where the natural order is inverted
   (structure needs walls; architecture needs slab thickness) split the discipline into a table-driven
   *pre-sizing* pass that runs early and a *detailing* pass that runs in its normal slot.
2. **Reservations, not collision checks.** A shared 3D reservation registry (the *coordination kernel*)
   hands each discipline its band/lane/shaft slot per floor use; elements may only be emitted inside a
   reservation owned by their discipline. Bands are disjoint by construction.
3. **Modules with ports.** Unit plans, cores, corridors, amenity/MEP rooms and parking bays are
   pre-validated legos whose *interface* is fixed geometry plus typed ports (entry, wet wall/stack,
   party-wall = column line, exhaust exit, panel). Placing modules by ports along a corridor spine gives
   vertical stacking, shaft continuity and column alignment for free.
4. **Feasibility before placement.** A module's admissible frontage/depth range is *derived from its
   room program*; the placer only uses admissible ranges, so "too small for template" cannot occur.
5. **Rules are data.** Every constraint is a `Rule` record (parameters, predicate, scope, severity,
   source, resolution strategy) that generators consume and the validator re-checks. Built-in rules
   come from the existing 100 patterns; users add/override rules in the UI; the rule set lives in the
   spec so results stay deterministic and shareable.
6. **Resolve, then record.** When an input cannot be honoured (parking, storeys), the system applies a
   named resolution (add basement level; switch egress rule set) and records it as an *info/deviation*
   issue, never a warning. Warnings are reserved for true contradictions; violations are test failures.

## Decisions (confirmed with the user)

1. **Editor model:** constrained parametric editing. Drag partitions/doors/furniture within rule limits; swap/mirror/insert/
   remove modules; move cores to admissible spots. Every edit stays valid, is stored as an override in the spec, and
   structure/MEP regenerate to match. No free-form wall drawing.
2. **Custom rules:** guided builder + parameter overrides. Any built-in pattern parameter is editable (units + sources);
   new constraints are composed from a fixed predicate vocabulary via a form; JSON import/export; rules live in the spec.
3. **Delivery:** everything in one iteration, in waves (kernel + pre-sizing + modules + layout solver + door fix →
   MEP v2 on the kernel + IFC furniture → editor + rules UI → integration, zero-violation tests, deploy).

Routine calls made without asking: typology storey band is clamped in the UI with an explicit "override typology
limits" toggle (recorded as a *deviation* and switching to the high-rise rule profile); parking shortfall is resolved by
adding basement levels (max 3, then podium levels if allowed, then a recorded ratio relaxation); furniture 3D uses
`IfcFurnitureType` + `IfcRepresentationMap` + `IfcMappedItem` with 2–8 primitives per type; preset switch keeps
`spec.rules` and wipes `spec.overrides`; the trap-arm table is corrected to IPC 2021 Table 1002.2 (Ø50 → 1.83 m,
Ø100 → 3.66 m).

## Current-state findings (seams the work hangs on)

### Architecture (`src/disciplines/architecture/`)
- Data flow: `generateArchitecture` (index.ts:105) → `planCores` once per building (cores.ts:68) → per storey
  `planFloorLayout` cached by `planKey` (index.ts:141-147) → `instantiateFloor` → `buildUnit` →
  `deps.layoutUnit(req)` (floor-organizer.ts:1406). `FloorLayout` (types-internal.ts:99) =
  `{key, units: UnitSlot[], corridors: CorridorSlot[], commons: CommonRoomSlot[], blocked, remnantArea}` is a small,
  serialisable, storey-independent document and `instantiateFloor` is a pure function of it → **this is the
  editor's document and the module placer's output.**
- Template assignment = `choosePicks → narrowPool → fitFrontages` (floor-organizer.ts:195-339): per-bay
  weighted draw, ±12 % frontage tolerance, **no depth check, no area check**, stretch-to-`frontage.max×1.2`
  or `list.pop()` escapes. Measured: ie-courtyard 171/171 units outside template depth range; delivered mix
  drifts badly (3b2b 0 % vs 9 % requested; corner 57 % vs 17 %). `recommendedRect` (templates.ts:783) exists
  and is unused. `packStrip` computes `netDepth` at :382 — the one place a depth filter belongs.
- Unit layout warnings all come from `fitWidths` (unit-layout.ts:328-382, squeeze branch :351-372), the
  `planRegion` eviction loop (:551-562), `planThrough` column dropping (:1005-1020) and the dropped-room tally
  (:1454-1457) — i.e. from being handed an infeasible frontage. Pre-validated modules make all of it dead code.
- Wet wall: `stackAlong` → `slideWetCluster` (:766-818) only permutes column order; **nothing measures
  fixture→stack distance**; the stack point is only a pattern param (:2933). Plumbing rediscovers fixtures
  (plumbing/fixtures.ts:174-255) and repairs with second stacks.
- Kitchen run (`furnishKitchenRun` :2528-2617) places items in one pass with **no offset sweep / no fallback
  wall / no warning** → kitchens with only a fridge when a door swing covers the run (5 on us-5-over-1);
  `furnishBathroom` (:2628-2750) has the sweep. Every-room-has-a-door and every-bedroom-has-a-bed are tested;
  kitchen⇒sink and bath⇒wc are not.
- Adjacency is a transient graph (`Adj` :1355, Dijkstra `spanningTree` :2071 with `transitCost` :140) discarded
  after doors are cut; `RoomProgram.prefer` is never read; there is no declared adjacency/connectivity requirement.
- Corridors: **one `CorridorSpine` per bar** from site (massing.ts:815-848); architecture splits only at cores
  that intrude into the band (floor-organizer.ts:550-571) — which never happens because `placeCores` puts cores
  beside the band. `CorridorDef.centerline` is always one segment (:1240-1248). Bars are independent; no
  knuckle; O-plans give 4 disjoint corridors.
- **Door bug root cause**: `DoorDef` (core/types.ts:634) has no hinge/swing field. `operation` is a constant
  (`'SINGLE_SWING_LEFT'` nearly everywhere). The correct direction `dirIn` is computed at unit-layout.ts:1733-1739
  for the swing-clearance rect and then discarded. plan-svg.ts:287-302 draws every door hinged at the low-`along`
  end swinging to the **left normal of the wall's stored direction**; two wall-direction conventions coexist
  (CCW `rectEdges` for cores/commons vs ascending-coordinate for envelope/party/partition walls) → 537 of 822 doors
  on us-5-over-1 open into the wrong room; sliding/folding/rolling doors are drawn as 90° swings; the IFC door is a
  flat panel with the `operation` token as metadata only (ifc-creator.ts:699-735).
- Furniture: 45-item `FURNITURE_CATALOG` (furniture.ts:33-88) is 2D footprint + height; `FURNITURE_IFC`
  (arch-elements.ts:163-176) maps type → IfcType/PredefinedType; geometry is always one `box`. `RoomDef.furnitureIds`
  gets duplicates (layoutUnit :1900 and `crossLink` arch-elements.ts:392).
- Cores: `CoreLayout` (cores.ts:33-63) computed once; 2.4 m shaft bay with `combinedShaft` 1.2×0.8, `trashShaft`,
  storage; `SIZES` in core/coordination.ts:96-123 (`coreWallT 0.25`).
- Envelope protocol: register breaks → `env.build(b)` → `wallFor(side, across, a0, a1)`; unit windows by WWR budget
  with `makeOpeningTracker`; floor WWR measured not imposed.
- `PatternBook` (core/patterns.ts:10-35) is additive-only; `PatCtx` (unit-layout.ts:2886-2909) already carries
  full per-unit geometry — the natural hook for per-unit rule evaluation.

### Coordination kernel, pipeline, structure, MEP, site
- `src/core/coordination.ts` (124 lines) is the entire kernel: `plenumBands(f2f, slabT, beamDepth, ceiling)` → single Z
  values (`ductZ`, `pipeZ`, `sprinklerZ = trayZ = pipeZ`), `DEFAULT_LANES {duct 0, pipe −0.35, sprinkler −0.15, tray +0.35}`
  (offsets without widths — a Ø150 main and the sprinkler main sit 0.2 m apart at the same Z), `lanePath`, `MOUNTING`,
  `SIZES` (`slabT 0.2`, `coreWallT 0.25` as constants). **Use-blind, no extents, no reservations, no shaft slots.**
- Shaft slots are implemented three different, inconsistent ways: mechanical `shaftSlot` (centre, middle third,
  mechanical/placement.ts:370-387, `nearestShaft` has no purpose filter), plumbing `plumbingShaftCorner` (min corner
  +0.15, plumbing/storm.ts:31-33), electrical inline max corner (electrical/panels.ts:385). `beamDepth` is derived three
  ways (mechanical context.ts:288-295 → 0 for flat slab; plumbing state.ts:113 → always `sizes.beamD ?? 0.3`; electrical
  panels.ts:365-369). `slabT` comes from architecture in mech/plumb but from structure in elec.
- Pipeline (`src/pipeline.ts:19-104`) is one forward pass; `ctx` is spread-copied per discipline; the only backward
  channel is `warnings: string[]` with inconsistent prefixes (`[structure]`, `[plumbing]`, `MEC:`, `electrical:`,
  `[architecture]`, none for site). No severity, code, owner or element link. Writer warnings are separate (`IfcOutput.warnings`).
- Slab/core-wall mismatch is by construction: architecture hard-codes `slabThickness = podiumTop ? 0.25 : SIZES.slabT`
  (architecture/index.ts:262) and `SIZES.coreWallT` (cores.ts:101,290,342,439); structure computes `sizesFor` →
  `slabT = rc-flat-plate-core ? 0.25 : 0.2`, `shearWallT = 0.3` constant (sizing.ts:159-188) and warns at
  structure/index.ts:205-209 / 530-533. Transfer slab is off by one storey and 0.05 m between the two. All sizing
  functions (`structuralSystemFor`, `foundationFor`, `loadsFor`, `sizesFor`, `columnSide`) are pure and callable
  pre-architecture from `site.massing` (bars, spines, core placements, dwelling frontage).
- Structure (`structure/index.ts`): columns generated per storey from `parkX/parkY` (podium 8.4×16.8 module) or
  `mainX/mainY` (party-wall grid) with per-storey `snapToWalls` (0.6 m kinks) and per-storey blocker/outline drops;
  footings only from the lowest storey's columns/walls (`:881-882`); transfer beams laid on grid lines, not on the
  columns they carry; shear/core walls are `StructWall{archWallId}` records with **no geometry**; balconies owned by
  architecture, structure never sees them; `grep cantilever` → 0 hits. **No load-path check exists.**
- Mechanical: room-type keyed (`HABITABLE`, `EXTRACT_ROOMS` … placement.ts:29-54); `StoreyInfo.isResidential` is the
  only floor discrimination; `'parking'`/`'retail'`/`'basement'` never appear; corridor make-up spine `building.ts:42-148`;
  risers one `axis` per storey; `PATTERN_APP_CAP = 64`.
- Plumbing: `chooseWall` attaches a fixture to a wet wall up to **6 m** away or to a virtual wall `VW-<roomId>`
  (fixtures.ts:70-113); synthesises bathroom/kitchen fixtures (:185-255); `primaryWall`/`stationsForGroup`/second-stack/
  vented fallback in stacks.ts:103-238; `maxTrapArm(d)` (tables.ts:245-249: Ø100 → 3.0, Ø75 → 1.8, else 1.5 m);
  `BUILDING_DRAIN_Z −0.55`/`SEWER_Z −1.2` are constants relative to the ground storey and `buildBuildingDrain` only
  collects ground-storey stacks (service.ts:279-280) → basement stacks/floor drains are orphaned; `Slope: 0.02` is a
  pset label only — `orthogonalize` (routing.ts:60-79) forbids sloped legs; no sump/ejector fixture type exists.
- Electrical: room-type keyed; parking lights 1/81 m² (devices.ts:416); EV panel finds a `parking`/`garage` room; trays
  `lanePath(+0.35)` power / `+0.50` data (panels.ts:299-357); risers at world max corner; `'retail'` never appears.
- Site: storeys vs typology band is **warning only** (massing.ts:312-319; `normalizeSpec` clamps to 1..60 at spec.ts:18);
  exceeding it silently switches structural system/foundation. Parking: demand from `estimatedUnits` after massing,
  capacity from **one** `use:'parking'` floor (parking.ts:390-391), `basementStoreys` fixed to 1 (spec.ts:47), no
  adaptation. Cores: `total = max(2, ceil(totalLength/travelLimit), ceil(unitsPerFloor/12))` (massing.ts:944-959),
  placed beside the corridor band; one `CorridorSpine` per bar (:815-848). `decompose` degrades O→U→L→bar.
- `PatternBook` parameters are prose (`'40–70 by region'`); **nothing reads `parameters` at runtime** — real values are
  duplicated module constants (e.g. `MAX_VENTED_BRANCH = 12` vs pattern param). Patterns tab is read-only; `form.ts`
  edits only `BuildingSpec` paths via `data-p` attributes.
- Tests: no cross-discipline coordination test file; the single structure↔MEP check is `plenumClearance.corridorSoffitZ`
  (structure.test.ts:365-375); mechanical asserts ducts in band (:165) and its own shaft-centre claim (:343); plumbing
  asserts PLB-01/02 and Manhattan runs; no test asserts storeys ≤ typology max, parking achieved == required,
  column-on-column, MEP-under-slab, or disjoint shaft slots.

### App, IFC writer, vendored IfcCreator, tooling
- App = one mutable `state` object (state.ts:50; `subscribe/emit/setState` are dead code), imperative `renderX()` calls
  from main.ts; generation is **synchronous on the main thread** (`run()` main.ts:230-277, `nextFrame()` only paints
  the spinner; no Worker anywhere); `scheduleRun` debounced 400 ms. No persistence (no localStorage/hash) — only
  Copy spec / Load spec; `?mock=1` is the only URL input.
- Sidebar `form.ts` renders one `innerHTML` string with `data-p="<dot.path>"` controls and `getPath/setPath/parseValue`
  (form.ts:18-57); per-floor table stores edits as per-index overrides in `spec.floors` via `ensureFloor` — **the
  existing precedent for `spec.overrides`/`spec.rules`**. Preset load is a full clobber of `state.spec`.
- 2D plan: `buildPlan(model, storey, layers, units, highlight) → Drawing{body, defs, hits, bounds, counts}` is a pure
  SVG-string builder batched one `<path>` per colour (plan-svg.ts:153); `Hit` = bbox + meta, `pickHit` smallest-area
  (:644); `elementIndex()` WeakMap-cached (:88). `Viewport` (viewport.ts) owns the `<svg>`, camera, pointer events
  (`pointerdown` always pans; click = press without >2 px move), hover tip; `ViewportHooks{onPick}` is the extension
  point; `toWorld(px,py)` public. **No selection/edit interaction, no per-element DOM nodes** → an editor is a separate
  overlay `<g>` + a drag hook in `bind()`. Stroke widths are `non-scaling-stroke`.
- Door arc bug has **three defects** in plan-svg.ts:287-302 / svg.ts:52-60: (i) `atan2` wrap → 270° arc on −X walls
  (`large=1, sweep=0`); (ii) hinge always at `a`, swing always to the left normal, `operation` ignored (sliding/folding/
  rolling/cased drawn as swings); (iii) the correct `dirIn` is discarded upstream. `WallDef.leftRoomId/rightRoomId` are
  populated against the left normal, so `swing = toRoomId === leftRoomId ? +nrm : −nrm` is derivable even today.
- Warnings UI: `▲ N warnings` button → `<ol>` popover of `model.warnings` (main.ts:775-820); `IfcOutput.warnings` never shown.
- viewer-embed.ts is a hand-inlined subset of `@ifc-lite/embed-sdk`: `loadModelBuffer`, `isolate/hide/showAll/select/
  selectByGuid/setColors/resetColors/setView/on()`; the app uses isolate + setColors by discipline; `select()` unused;
  `ENTITY_SELECTED`/`ENTITY_HOVERED` events available but unsubscribed → 3D↔plan selection sync is possible.
  Storey isolation is trivially `embed.isolate(expressIdsFor(el => el.storey === s))`.
- Writer (`writer.ts:544-882`) maps kinds → IfcCreator; furniture is the `box` branch → `addIfcFurnishingElement` or
  `addElement` = **one extruded box per item**; `FURNITURE_IFC` (arch-elements.ts:163-176) maps 12 types to
  IfcSanitaryTerminal/IfcElectricAppliance. Measured on us-5-over-1: 1810 furniture items = 11,893 entities (6.57/instance,
  417 bytes). Whole preset: 27,921 elements → 313,146 entities (11.2/element, 22.5 MB); top types
  IFCPROPERTYSINGLEVALUE 91k, IFCEXTRUDEDAREASOLID 29.7k, IFCLOCALPLACEMENT 29k, IFCSTYLEDITEM 28.6k.
- Vendored IfcCreator has **no** `IfcRepresentationMap`/`IfcMappedItem`/`IfcCartesianTransformationOperator3D`/
  `IfcTypeObject`/`IfcRelDefinesByType`; `addShapeRepresentation` hardcodes `SweptSolid|SolidModel`; styles are per
  element solid (`finalizeStyles` 2210-2235); resource caching exists for points/directions/placements/profiles.
  Upstream `packages/create` is the same 2.4.0 minus our four additions (no mapped items there either).
- ifc-lite engine **fully supports** IfcMappedItem/IfcRepresentationMap (rust/geometry/src/router/mapped_item.rs), all
  four transformation operators incl. non-uniform (transforms/operator.rs), IfcRelDefinesByType style inheritance
  (prepass_type_material.rs), GPU instancing keyed by representation map (processor/mod.rs:547-552) with a gate against
  double-rendering type geometry, and picking/colour on instanced meshes. `IfcFurnishingElement` has a default style;
  `IfcFurniture` does not → emit `IfcFurnishingElement` occurrences + `IfcFurnitureType` types. Also meshes
  SweptDiskSolid, RevolvedAreaSolid, BooleanClippingResult, CsgSolid, FacetedBrep, Triangulated/PolygonalFaceSet.
- Projected cost with mapping (corrected by the design pass): ≈ 4.0 entities/instance regardless of solid count
  (shared identity operator and shared IfcProductDefinitionShape per type; rotation in the occurrence placement, whose
  point + axis placement are unique per item) + ≈ 2·solids + 7 per type; recognisable 3–8-solid furniture for **~31 %
  fewer entities than today's boxes**. Further freebies: cache `IfcLocalPlacement` by (relativeTo, axis2) and `IfcPropertySingleValue` by
  (name, type, value).
- `validate.ts` requires plain decimals (no exponents) and non-empty member sets for relationship entities — new
  entities must comply. Build: `scripts/build.mjs` (esbuild IIFE, CSS/JS inlined via replacer functions, `--mock/--strict/
  --watch`); tests `node --test 'src/**/*.test.ts'` (15 files); `render.test.ts` renders SVG without a DOM because the
  builders are pure.
- Spec is plain JSON; `normalizeSpec`/`resolveFloors` (spec.ts:9-130) is the merge seam; CLI `--spec file.json` and the
  app share the envelope. RNG: mulberry32 `createRng(seed)`, `fork(label)` per discipline; per-unit fork label
  `unit:${templateId}:${index}:${level}` (floor-organizer.ts:1398); `planKey` memo (:102-116); writer GUID stream
  `createRng(`${name}:${seed}:ifc-guid`)`.

Measured baseline (Node, 2026-09-21): ca-point-tower 22 storeys = 45,331 elements / 256 ms; ie-courtyard = 67,189
elements / 337 ms / 59 warnings. The 2 s budget has ~6× headroom — everything below stays O(n); **no pairwise clash loop**.

---

## Target architecture v2

### Pipeline order (src/pipeline.ts)

```
spec (+ rules + overrides) → normalizeSpec (typology storey band: clamp or explicit override) → RuleSet + Ledger
→ SITE: frame → parking solver (basement/podium level count) → massing (bars; cores consume corridor break slots)
        → corridor graph (legs ≤ 45 m, knuckles, break slots, dead ends) → storeys
→ STRUCTURAL PRE-SIZING: system/foundation/loads/sizes → slabT/beamD per storey, coreWallT, transfer storey,
        bay proposal; resolves every storey's ceiling profile (may raise a f2f) → storeysResolved
→ ARCHITECTURE: module catalogue (memo by rules hash) → placer per typical floor (FloorLayout v2)
        → applyOverrides(spec.overrides) → instantiateFloor (modules → layouts with ports) → cores from CoreModule
        → returns partyLines, shafts, chases(stack ports)
→ KERNEL: profiles per storey (from presize), shaft-slot allocator (arch.shafts), chases (unit stackPorts), lanes
→ STRUCTURE DETAILING: columns on partyLines (no per-storey kinks), transfer beams on the columns they carry,
        footings from loadpath.bases, keep-outs registered (beams/columns/lift shafts/switchgear space), load-path check
→ MECHANICAL → PLUMBING → ELECTRICAL: every horizontal run via kernel.reserveLaneRun/reserveCrossing, every riser via
        reserveRiser (shaft slot), every stack via chaseOf(unitId), every penetration via sleeve(); per-use profiles
→ kernel.validate + checkSupport (hangers, riser continuity, slopes, reachability, no structure penetration)
        + rule post-check → issues (info | deviation | violation | error); `warnings` = string projection
→ metrics, pattern trace → DesignModel → writer (type library, mapped items)
```

Each discipline receives `ctx.presize`, `ctx.kernel`, `ctx.rules`, `ctx.issues`. Structure is split into `presize.ts`
(early, table-driven) and the existing detailing pass. No discipline writes upstream; there is nothing left to write back.

### Frozen contracts (land in one types-only commit before any implementation agent starts)

| # | File | Contract |
|---|---|---|
| F1 | `src/core/rules/types.ts` | `Rule`, `RuleScope`, `PredicateId`, `ResolutionId`, `Issue`, `Severity`, `Ledger`, `RuleSet`, `Subject`, `World`, `RoomGraph`; `DesignModel.rules: Rule[]` (resolved built-in + custom, for the Rules tab) |
| F2 | `src/core/kernel/types.ts` | `Box3`, `ElementKind`, `Band`, `ResolvedBand`, `CeilingProfile`, `StoreyProfile`, `ProfileBook`, `Lane`, `LaneSet`, `Reservation`, `Conflict`, `ShaftSlot`, `Chase`, `Sleeve`, `Kernel` |
| F3 | `src/disciplines/structure/presize.ts` (header) | `StructuralPresize`, `StoreySizing`, `GridProposal`; `bayGridFrom(presize): BayGrid` (the placer's view) |
| F4 | `src/core/openings.ts` + `DoorDef` v2 in `types.ts` | `DoorMotion/DoorHinge/DoorSwing`, `solveSwing`, `hingePoint`, `leafTip`, `swingRect`, `latchSide`, `drawsArc`, `doorOperation` |
| F5 | `src/disciplines/architecture/program/types.ts`, `src/modules/types.ts`, `src/disciplines/architecture/placer/types.ts`, `unit-layout-types.ts` v2 | `ProgramGraph/ProgramNode/AdjacencyRule/PlanShape/Feasibility`, `UnitModule/CoreModule/BreakModule/MEPRoomModule/ParkingModule/ModuleCatalogue/Port`, `Slot/StripDef/FloorLayout v2/CorridorGraph consumer`, `UnitLayoutRequest/UnitLayout` v2 with `StackPort/ExhaustPort/PanelPort` |
| F6 | `src/core/overrides.ts` | `OverrideDoc`, `LayoutEdit`, `UnitEdit`, `hashOverrides` |
| F7 | `src/disciplines/site/corridor-graph.ts` (header) | `CorridorGraph`, `CorridorLeg`, `BreakSlot`, `Knuckle` |
| F8 | `src/core/furniture-3d.ts` (header) + `ElementGeometry` `instance` kind | `FurnitureTypeDef`, `Solid`, type-library id grammar (from the app/IFC design pass) |
| — | `src/core/types.ts` additions (all optional at first) | `GenContext.presize/kernel/rules/issues`; `DesignModel.issues`; `BuildingSpec.rules/overrides`; `MassingSpec.allowStoreyOverride/maxBasementStoreys/maxPodiumStoreys`; `ArchModel.partyLines/chases/layouts`; `UnitInstance.moduleId/slotId/mirrored/stackPorts/exhaustPorts/panelPort/roomGraph`; program refs for the editor `RoomDef.ref`, `DoorDef.ref`, `WallDef.ref`, `FurnitureDef.ref`; `CorridorSpine.legs`; `PlumbingFixture.type += 'sump-pit'|'sewage-ejector'`; `StructSlab.type += 'balcony'`; `StructModel.plenumClearance.byStorey`; `ElementGeometry += instance` |

`CONTRACT.md` → `CONTRACT-v2.md`: core owns `types.ts`; disciplines request additions; generators read tunables via
`rules.num/table`, never module constants; every emitted MEP element must sit inside a reservation of its discipline.

### Reconciliations between the two design passes

- **Corridor graph is owned by site** (`site/corridor-graph.ts`: legs, knuckles, break slots, dead ends, `longestRunM`);
  `placeCores` consumes break slots; architecture's `placer/corridors.ts` only *consumes* the graph (blocked intervals
  per leg, instantiates `BreakModule`s, `CorridorDef.centerline` polylines, travel distance by Dijkstra on the graph).
- **One structural handshake type:** `StructuralPresize.gridProposal` is the source; `bayGridFrom(presize)` gives the
  placer its `{module, bay, span, slabT, beamDepth, coreWallT, shearWallT}`; architecture returns
  `ArchModel.partyLines`; structure detailing builds columns on exactly those lines (retires `snapToWalls`).
- **One issue type:** `Deviation = Omit<Issue,'id'>`; `UnitLayout.deviations` and placer deviations are pushed into the
  ledger by `generateArchitecture`; no separate `ArchModel.deviations`.
- **Chase = stack port:** modules emit `StackPort`s (`atFrac` of frontage → identical modules stack vertically);
  `createKernel({arch})` registers one `Chase` per dwelling column from `UnitInstance.stackPorts`; plumbing uses
  `kernel.chaseOf(unitId)` (`systemXY` laid out in `SHAFT_SYSTEM_ORDER`, waste at the centre) and never searches.
- **Rules feed the layout engine:** kit clearances, leaf minima, trap arms, min room widths per region are `param`
  rules; `buildCatalogue(rules)` is memoised by `rules.hash()` so custom rules change feasibility deterministically.
- **Site sizes cores from the module catalogue** (`CoreModule` footprint ranges at the storey's f2f); architecture
  builds the core interior from the same module.

### Kernel (src/core/kernel/) — the coordination backbone

`Band` = `{id, purpose, cls: 'structure'|'parallel'|'crossing'|'void'|'ceiling'|'clear'|'equipment', owner,
topBelowSoffit, depth, minDepth, clearanceAbove/Below, allows: ElementKind[], flexibility 1..5, droppable,
depthFromPresize?, rationale, source}`. `CeilingProfile` = `{id, appliesTo{floorUses, roomTypes}, hasCeiling,
clearHeight{min,target,source}, zones[{id,minClear,source}], bands[] (ordered from the soffit DOWN), laneSetId,
elsewhere[{kind, home, why, source}], notes}`. `stackProfile()` resolves a profile against a storey: places bands at
natural depth → compresses the most flexible bands to `minDepth` → drops droppable bands → asks presize to raise the
f2f (recorded as a deviation). **The corridor ceiling height is an output of the profile.**

`Lane` = `{id, owner, bandPurpose, offset, width, minWidth, height, vAlign, allows, systemOrder, source}`;
`LaneSet.requiredCorridorWidth = 2·max(|offset|+width/2)`; narrower corridors scale offsets, floor widths at
`minWidth`, and overflow the `pressure` lane into the crossing band with an info issue.

Kernel API: `profileOf(storey, roomType?)`, `laneSetOf`, `reserve(req) → Reservation|Conflict`,
`reserveLaneRun` (lateral allocator: k-th claimer by canonical system order — call-order independent),
`reserveCrossing` (station allocator: deterministic outward walk ±pitch), `reserveRiser` (shaft slot),
`shafts.slot({shaftId, discipline, system, w, d, wantWall, storeys})` (zones plumbing 35 % | mechanical 35 % |
electrical 22 % | trash 8 % along the shaft's long axis, first-fit in `SHAFT_SYSTEM_ORDER`, idempotent),
`chase(req)`, `chaseOf(unitId)`, `sleeve(req)`, `keepOut({owner, kind, boxes, bans})`, `validate(elements) → Issue[]`.
Conflicts between ordinary reservations are impossible by construction (bands disjoint in Z, lanes disjoint laterally,
shaft zones disjoint in XY, one chase per wall station); the only pairwise test is against keep-outs through a 2 m grid.

### Ceiling profiles — the explicit per-use patterns (user item 10)

Order is always from the slab soffit downward. Rationale encoded on every band: **structure first** (fixed by span);
**sprinkler tight to the slab** (NFPA 13 §8.6.4.1.1.1 deflector 25–300 mm below ceiling); **ducts set the depth**
(biggest rigid section, straight runs); **gravity drains cross in their own band** (one invert, one slope — least
flexible after structure, so they get dedicated crossing stations); **pressure pipes fit around** (can rise/fall);
**electrical lowest and most accessible** (altered many times over the building's life; NEC 110.26; tray support
≤ 1.52 m NEC 392.30(A)); then void, then ceiling.

| profile | applies | clear height | band order (soffit → down) | what lives elsewhere |
|---|---|---|---|---|
| `resi-unit` | dwelling rooms | 2.30 min / 2.50 target (IBC 1208.2; London Housing SPG 2.5 m); hall bulkhead 2.10 | structure(beamD_unit) → **service-band bulkhead 0.25 only over hall + wet strip** (duct branch, dcw/dhw, sprinkler branch, conduit) → void → ceiling | waste/vent/dcw/dhw → wet-wall **chase**; panel → hall wall (NEC 240.24(D)/(E)); heads on ceiling |
| `resi-corridor` | corridors, lift lobbies | 2.10 min / 2.40 target (IBC 1003.2) | structure(beamD) → sprinkler 0.10 → **service 0.30** (duct lane centre; pressure lane one side; power+data trays other side) → **crossing 0.20** (waste/vent/storm crossings, branch ducts into units, tray drops) → void ≥ 0.05 → ceiling 0.03 | risers → shaft; floor board → corridor wall |
| `parking` | parking, basement | 2.10 drive aisle (IBC 406.4.1) / **2.50 accessible route + van stall** (ADA 502.5) | structure(beamD + 0.10 drop panel) → CO/NO₂ **exhaust 0.40** on aisle centreline (IMC 404.2 3.8 L/s·m² or 1.5 with CO/NO₂ control, ASHRAE 62.1) → jet fans (BS 7346-7) → **drain trench 0.15 sloped** (IPC 1101.2, Ø150 1:100) → dry sprinkler 0.10 (NFPA 13 §8.3.3) → EV tray 0.10 **over stall heads** (NEC 625.40) → lighting 0.12 → clear | **keep-out**: nothing wet/ducted over switchgear footprint × 1.8 m (NEC 110.26(E)(1)(b)); sprinkler allowed with drip protection ((E)(1)(c)); sump at low point |
| `retail-shell` | retail podium | 2.70 min / 3.20 target | structure → **transfer zone 1.20 on the storey under the transfer slab** (STR-04; no MEP inside) → landlord services 0.30 capped at the demise → **tenant plenum 1.00 kept empty** → (tenant ceiling not built) | tower stacks → 1-h chase in demising/core wall (IBC 713.4); landlord runs terminate capped/valved/metered ≤ 1.0 m from the demise |
| `mep-room` | mech/elec/water/plant rooms | 2.10 (IMC 306.3) | structure → overhead 0.45 (all services tight to soffit) → **access clear to 2.10** → plinth 0.15 (IMC 303.3) | switchgear working space 1.07 front (NEC Table 110.26(A)(1)); boiler 0.60 / 0.75 at burner; floor drain 1/40 m² |
| `roof-plant` | roof | walkway 2.00 (OSHA 1910.25) | plinth 0.15 → plant envelope to 2.50; 1.00 aisles; 2.00 setback from parapets < 1.10 (OSHA 1910.28(b)(13)); crossings on sleepers ≥ 0.15 above membrane | PV rows in the PV zone |
| `lobby` / `amenity` | ground/amenity | 2.40 / 2.70 (3.00 amenity) | as corridor | |
| `basement-service` | service basements | as parking | + sump equipment band at the low point; inverts from the invert model | |

Lane table (`resi-corridor`, 1.70 m nominal; offsets + = corridor-left): sprinkler 0.00 w0.12 (band sprinkler) ·
duct 0.00 w0.60 h0.30 (service) · gravity −0.45 w0.30 (crossing) · pressure −0.75 w0.30 (service) · tray-power
+0.45 w0.34 (service, bottom) · tray-data +0.72 w0.22 (≥ 0.15 from power, BS 7671 528.1). Required width 1.66 m.
This fixes today's Ø150 main 0.20 m from the sprinkler main at the same Z, and the 0.15 m tray-centre gap.

Clearance/hanger/slope tables (all `param` rules with sources): hanger max drop duct 1.50 / pipe 1.20 / sprinkler
0.90 / tray 1.50, spacing SMACNA Table 5-1, IPC Table 308.5, NFPA 13 Table 9.2.2.1, NEC 392.30(A); slopes IPC Table
704.1 (≤ Ø75 1:50, Ø100–150 1:100, ≥ Ø200 1:200; UK/IE 1:80 BS EN 12056-2), storm 1:100, max gravity 1:12; trap
arms IPC 2021 Table 1002.2 (Ø32 1.07, Ø40 1.52, Ø50 1.83, Ø75 3.05, Ø100 3.66); switchgear working space 1.07 /
2.00 high; dcw above waste at crossings (IPC 603.2); no MEP through beams/columns; nothing in the lift hoistway
(IBC 3005.3); tray-power↔tray-data 0.15 (EMC). `MOVE_COST` table (1 fixed: slab, beam, column, drains, sprinkler
main · 2 hard: shafts, standpipe, transfer zone, ceiling plane · 3 medium: ducts, fans, AHUs · 4 easy: pressure
pipes, gas · 5 trivial: trays, conduit, lights, sensors, EV) is exposed on the Patterns tab as XD-06…XD-12:
XD-06 Ceiling Sandwich · XD-07 Flat Soffit Dwelling · XD-08 Exposed Garage Services · XD-09 Shell-and-Core Demise ·
XD-10 Plant Room Clearances · XD-11 Gravity First (invert model) · XD-12 Everything Hangs From Something.

### Structural pre-sizing + constructability (src/disciplines/structure/)

`presizeStructure({spec, typology, site, storeys, profiles, rules, ledger}) → StructuralPresize {system, foundation,
loads, sizes, columnBand, coreWallT, shearWallT, partyWallT, exteriorWallT, corridorWallT, storeys: StoreySizing[]
{storey, profileId, floorToFloor, slabTAbove, beamDAbove, beamDAboveUnit, soffitZ, corridorSoffitZ, ceilingZ,
corridorCeilingZ, isTransferBelow, transferZoneDepth, slabTOwn}, byStorey, storeysResolved, transferStorey
(= storeyIdFor(podiumStoreys)), transferBelowStorey, transferSlabT 0.30, transferBeamD 0.90, gridProposal {bay
{min,target,max}, transverse/longitudinal offsets per bar, parkingModule 8.4×16.8, snapTolerance}, issues}`. All
inputs exist pre-architecture (`structuralSystemFor`, `foundationFor`, `loadsFor`, `sizesFor`, `columnSide` are pure;
spans from `site.massing` bars/spines/cores). Architecture reads `slabTAbove`/`coreWallT`/`ceilingZ` from it; `SIZES.slabT`
and `SIZES.coreWallT` are deleted; the two structure warnings (index.ts:205-209, 530-533) become unreachable; the
transfer off-by-one is fixed once.

`checkLoadPath()` (`loadpath.ts`): column on k lands on a column/wall on k−1 within 0.15 m, or on a transfer beam whose
**both** ends land on supports (STR-C1); cores/shear walls continuous (STR-C3); a foundation under every lowest support
(STR-C2, replaces footings-from-lowest-storey-columns); slab edge within `min(2.0, 10·slabT)` of a support line
(STR-C4, ACI 318-19 Table 9.3.1.1); balcony `L ≤ min(maxCantilever, B/2)`, `t ≥ max(0.18, L/10)` (STR-C5). Structure
detailing lays transfer beams on the columns they carry and registers keep-outs (beams, columns, drop panels, lift
shafts) before MEP runs.

`checkSupport()` (`kernel/support.ts`): every MEP element maps to a reservation (XD-S0), soffit within
`HANGERS[kind].maxDrop` unless in wall/chase/shaft/floor/plinth (XD-S1), riser continuity — shaft/chase exists on every
storey crossed (XD-S2), gravity runs monotonic within the slope band (PLB-S1), union-find reachability fixture → stack →
building drain or sump → gravity above sewer invert (PLB-S2..S4), no interior overlap with structure keep-outs (XD-S5).

`plumbing/invert.ts`: `sewerInvert = clamp(−(cover 0.45 + slope·longestRun + 0.15), −3.0, −1.2)`; per-storey
`drainInvertZ`; storeys whose invert falls below the sewer are `pumpedStoreys` → sump pit 0.9×0.9×1.2 with Ø50 vent
(IPC 712.1) + **duplex** ejector (IPC 712.4.2) + check/gate valves + Ø80 discharge in the pressure lane up to the
gravity drain. `routing.ts` gains `orthogonalize(path, {sloped, slope})`, `applyFall`, `isOrthogonalOrSloped`,
`fallOf`; `BUILDING_DRAIN_Z`/`SEWER_Z` deleted; `buildBuildingDrain` walks all storeys.

### Rule engine + issues (src/core/rules/)

`Rule {id ('ARC-03.maxLegLength'), title, discipline|'xd', patternId?, kind 'param'|'constraint', scope
{floorUse?, roomType?, elementKinds?, templateIds?, storeys?, storeyIndexMin/Max?, typologies?, regions?, sprinklered?},
params: Record<name,{value, unit?, source}>, predicate?: {id, args}, severity, resolution?, subject?}`. Predicate
vocabulary (closed, 27): minDim · minArea · maxArea · aspect · adjacent · connected · notThrough · exterior · daylight
· withinDistance · clearance · notOver · band · lane · inReservation · maxRun · deadEnd · egressTravel · supported ·
slope · continuous · reaches · clearHeight · swingClear · loadPath · cappedAtDemise · count · ratio. `rulesFromPatterns`
lifts every numeric pattern parameter into a `param` rule so generators call `rules.num('PLB-02.trapArm…')` /
`rules.table(...)` instead of private constants (a source-text test asserts the deleted constants are gone).
`RuleSet.forSubject` pre-buckets by subject kind and scope; evaluation order is canonical (storey index → id).

`Issue {id, severity 'info'|'deviation'|'violation'|'error', ruleId, discipline, storey?, unitId?, roomId?,
elementIds?, message, observed?, limit?, source?, resolution? {id, from?, to?, note?}, count?}`; `Ledger.add/addOnce/
bySeverity/byRule/warnings()`; `createLedger({mirrorInto: warnings})` keeps every legacy string byte-identical during
migration. **Invariant (test):** all 10 presets → zero `violation`, zero `error`.

`spec.rules: RuleOverrides {version 1, params?, severity?, disabled?, custom?: CustomRule[], profiles?}`;
`CustomRule {id 'USR-…', title, subject: SubjectSelector, predicate, object?, limit {op, value, unit?}, scope?,
severity?, resolution?, source?}`; `PREDICATE_SIGNATURES[p] = {subjects, object?, limitType, unit?, description}` drives
the UI form; `validateRuleOverrides` drops only the offending rule with an `error` issue. Rule profiles: `high-rise`,
`sprinklered`, `uk`, `us`.

### Resolutions (site + spec)

- **Storey band:** `normalizeSpec` clamps `massing.storeys` to `typology.storeys.{min,max}` unless
  `massing.allowStoreyOverride`; override → `deviation` + `RULE_PROFILES['high-rise']`. UI: storeys input gets
  `data-min/data-max` + the override checkbox.
- **Parking:** `solveParking()` runs before massing: `estimateUnits(spec, typology, frame)` (pure, no bars) →
  `required` → add basement levels (`stallCapacity(zone)` is the single capacity function) up to
  `maxBasementStoreys` (3) → podium levels if `podiumUse` allows → else `relax-parking-ratio` deviation with the
  achieved ratio. Feeds `resolveFloors`/`buildStoreys`. `structuredParking` packs **every** parking storey.
- **Corridors:** `buildCorridorGraph()` splits each spine into legs ≤ `ARC-03.maxLegLength` (45) with 5.0 m break
  slots (core preferred, else lounge/window bay), joins bars at knuckles (an O-plan is **one** cyclic corridor),
  flags dead ends > `SIT-08.deadEnd` (6 m / 15 m sprinklered) → core at that end or leg shortened; `placeCores` consumes
  break slots first (removes the "4 cores 11.5 m apart" pathology); the placer lays units per leg.

### Modules ("legos", src/modules/) and the program solver (src/disciplines/architecture/program/)

**Five mechanisms:** (1) *feasibility witness gate* — a layout exists only for a `(frontage, depth)` the solver proved
feasible; (2) *kit-derived minima* — a room's `minWidth/minDepth` are computed from its furniture kit, so a room that
exists is a room whose complete kit fits; (3) *ports, not rediscovery* — modules declare stack/exhaust/panel/party-line
ports as fractions of frontage, persisted on `UnitLayout`/`UnitInstance`; (4) *one geometric probe at production* for
door hinge/swing; (5) *quota ledger + grid snap* in a 1-D packer.

`ProgramGraph {id, templateId, levels, nodes: ProgramNode[] {ref 'bedroom2', type, zone, level, area{min,target,max},
minWidth, minDepth, maxWidth, maxDepth, aspect, needsExterior, wet, kit: KitId, stackable, mergeInto?, band
'daylit'|'service'|'circulation'}, rules: AdjacencyRule[] {a, b, kind 'share-edge'|'door'|'no-door'|'not-adjacent',
regions?, reason}, zoneOrder: Zone[][], wetGroups: NodeRef[][], maxStacks 1|2}` — 20 graphs (data), e.g. UK/IE
`no-door` between WC and kitchen/living (ADG Part G), bedroom `not-adjacent` kitchen, en-suite `door` off its bedroom,
`share-edge` for wet groups (XD-01). `PlanShape` (zoned | house | through | cluster | dual-key) is **module identity**,
not a runtime guess. `feasibleShape(shape, F, D)` → band depths by `allocate()` → per-column min/max widths →
`Fmin/Fmax`; fallbacks in order: stack a `stackable` node in a second row, apply `mergeInto`, next shape — each
recorded in the witness, never warned. `allocate(total, items{min,target,max})` returns `null` rather than squeezing.
Doors: required edges + Dijkstra completion over `transitCost`; swing into the room served (out for tight baths/
closets, sliding where a swing would cover fixtures); hinge chosen *away from the fixture run*; `swingRect` reserved
before kits are placed; leaf minima 0.90 entry / 0.85 accessible / 0.80 interior / 0.75 bath / 0.70 closet baked into
node minima (+0.20). Kits (`KIT` table: kitchen-galley 2.50×1.80 with sink+range+fridge mandatory, kitchen-galley-washer
3.10×1.80, kitchen-island 3.10×3.30, bath-3pc-tub 1.70×2.20, bath-3pc-shower 1.60×2.00, bath-accessible 2.20×2.60,
wc-2pc 1.10×1.50, bed-double 2.75×3.20, bed-single 2.15×2.90, bed-master 2.90×3.40, living-3seat 3.40×3.05, dining-4
2.70×2.30, laundry-stack 0.80×0.70, entry 1.20×1.50, garage-1car 3.00×5.60 …) with clearances (WC 0.38 centreline /
0.53 front IPC 405.3.1, lavatory 0.70 front, bed walkway 0.75, kitchen aisle 1.20, ADA 1.5 m circle). `fitKit` = the
bathroom's offset sweep + fallback wall, now shared by the kitchen. Kitchen `minWidth` rises 2.2 → 2.5/3.1 (shifts
`Fmin` of 1b1b/2b1b/dual-key by +0.3 m — documented).

`ModuleCatalogue {units (55: template × variant single|dual|corner|end|cluster|dual-key), cores (single|dog-leg|
scissor × lifts, three purpose-tagged shaft slots + trash + lobby), breaks (lounge | lift-lobby | window-bay | cross |
exit-stair), amenities, mep (switchroom{streetSide, noWetAbove}, water-entry, fire-pump, generator, trash,
sump{lowestPoint}), parking (double-loaded 16.8 | single 11.4 | ramp); frontageAt(id, depth) → Range|null;
fitFor(id, F, D) → Feasibility|null; candidatesFor(strip)}`. Ids `U-2b2b-corner`, `C-dogleg-lift2`, `K-lounge`,
`M-switchroom`, `P-double-90`; `mirrored` is a slot property. `selfTestCatalogue()` sweeps every module × 5 depths ×
5 frontages × levels × {US, UK}: tiles ≥ 99.5 %, reachable, daylight, kit-complete, swing-clear, swing-into,
trap-arm ≤ `maxTrapArm`, min-dims, min-leaf, adjacency, ports, determinism. A failing module is not admitted.

Placer (`placer/packer.ts`): candidates = modules with `frontageAt(netDepth) ≠ null` (**the depth filter at the one
place `netDepth` is computed**); multiset by building-wide quota deficit (`apportion` per floor, ledger across floors);
`allocate()` widths; boundaries snapped to `grid.module` with column-line subset in `[bay.min, bay.max]`; corner/end
variants at bar ends and knuckles; break slots reserved first; remnant only when `< min module frontage`
(`flex ≥ 3.0 m` else `storage`, recorded); ports resolved to world XY; vertical `atFrac` alignment asserted.
`mixDeviation = ½·Σ|delivered − requested| ≤ 0.08`.

`FloorLayout v2 {version 2, key (typical-floor identity), layoutKey (= key # hashOverrides), strips, slots: Slot[]
{id 'S-<bar>-<strip>-<nnn>' (inserted '.k'), stripId, kind, moduleId, mirrored, boundary, accessSide, exteriorSides,
sides, barId, coreId?, storeySpan?, stairRect?, ports: ResolvedPort[], partyLines, extraDoors?}, corridor, commons,
grid, mix, blocked, remnantArea}` is the **editable document**. `spec.overrides: OverrideDoc {version 1, layouts?:
Record<key, LayoutEdit[]>, storeys?: Record<storeyId, LayoutEdit[]>}`; `LayoutEdit` = swapModule | mirror |
moveBoundary | insertSlot | removeSlot | setSlotKind | moveCore | unit{edits: UnitEdit[]}; `UnitEdit` = flipDoor |
reverseDoor | moveDoor | setDoorMotion | dragPartition | moveFurniture | addFurniture | removeFurniture | swapRoomType;
in-unit refs are program-node refs (`bedroom2`, `entry1~hall1`, `refA|refB`, `roomRef#kitSlot`) — never minted ids.
`applyOverrides(base, doc, ctx)` sorts edits canonically, clamps each to the same machinery that produced the base
(admissible module ranges, neighbours' elastic ranges, grid module, program min/max, room minus swing zones, free wall
spans), records clamps as deviations, and is applied between `planFloorLayout` and `instantiateFloor`; the per-unit RNG
fork label gains the edit hash so untouched twins stay bit-identical; a typical-floor edit re-solves once and
replicates. Canonical layout cache: `layoutUnitCanonical` keyed by `moduleId|F|D|level|exterior|exposure|wwr|region|
detail|balcony|editsHash` (ie-courtyard 171 units → ≈ 40 solves).

### Doors (the visible bug) — src/core/openings.ts

`DoorDef` v2: `{…, motion: 'swing'|'double-swing'|'sliding'|'folding'|'rolling'|'opening', hinge: 'start'|'end'
(end of the host wall in its STORED start→end direction), swing: 'left'|'right'|'none' (side of the stored
direction the leaf sweeps), swingIntoRoomId?}`; `operation` removed — `doorOperation(d)` derives the IFC token
(`token = (swing==='left') === (hinge==='start') ? 'LEFT' : 'RIGHT'` → `SINGLE_SWING_${token}`, `SLIDING_TO_…`,
`FOLDING_TO_…`, `DOUBLE_DOOR_*`, `ROLLINGUP`, `NOTDEFINED`). `solveSwing({wall, along, width, motion, into, avoid})`
probes 0.06 m along the left normal into the target room rect; hinge = end farther from `avoid` (the fixture run).
Producers (17 sites: unit-layout entry/garage/balcony/interior, floor-organizer extra/balcony/fallback, cores stair/
lobby/exit, common-rooms interior/entrance, mock-model, test fixtures) populate it; consumers read it: plan-svg arc from
`hingePoint/leafTip` with `drawsArc` gate (no arc for sliding/folding/rolling/cased) and a sweep-normalised `arcPath`
(fixes the 270° arc on −X walls), arch-elements `operation: doorOperation(d)`, electrical `latchSide()` for switches,
unit-layout `swingRect` instead of the discarded `dirIn`. `crossLink` dedupes door/window/furniture ids. Regression
test: for every preset, every swing door's probe lies inside `swingIntoRoomId` (537/822 fail today).

### App: generation in a worker, the floorplan editor, issues panel, rules tab (src/app/)

**Worker.** `src/app/worker/protocol.ts`: `WorkerRequest = {type:'generate', runId, spec, wantIfc} | {type:'writeIfc',
runId} | {type:'elementDetail', runId, id} | {type:'cancel', runId}`; `WorkerResponse = {type:'progress', runId, stage,
ms} | {type:'result', runId, model, timings} | {type:'ifc', runId, bytes: ArrayBuffer (transferred), entityCount,
fileSize, idMap, warnings} | {type:'error', runId, message}`. `src/app/worker/entry.worker.ts` runs `generateBuilding`
and retains the last `DesignModel` so IFC is written **lazily** (3D tab / Download) without re-transfer. Build:
`scripts/build.mjs` bundles the worker entry (IIFE) and embeds it as `<script type="text/plain" id="forma-worker">`;
runtime creates it from a Blob URL; a superseded run terminates + respawns the worker; sync fallback on the main
thread when Workers/Blob URLs are unavailable (file://). `Backend` becomes async (`generateBuilding(spec):
Promise<DesignModel>`, `writeIfc(): Promise<IfcOutput>`); `run()`'s synchronous path and the `nextFrame()` spinner hack
are deleted. Measure the structured-clone cost of the tower model; if > 300 ms strip `psets/quantities` from the UI copy
and fetch them per element via `elementDetail`.

**Editor (constrained parametric).** State: `editMode: 'view'|'floor'|'unit'`, `editScope: 'typical'|'storey'`,
`selection: {kind: 'slot'|'unit'|'room'|'door'|'furniture'|'wall'|'core', id, ref?}`, `history: {past: OverrideDoc[],
future: OverrideDoc[]}`. `Hit` gains optional `srcKind, slotId, unitId, roomId, wallId, ref (program ref), poly (true
outline), handles[{id, at, axis}]`; new `slot` and `unit` hits; `pickHit` uses polygon containment when `poly` exists
and a per-mode preference (floor mode: slot/core first; unit mode: door/furniture/wall first). `Viewport.setOverlay
(markup)` writes a `<g class="edit">` inside `.cam` (selection outline, pixel-sized handles via `vector-effect`, drag
ghost, snap guides, clamp-range bar, red tint on rejection) redrawn independently of the batched drawing;
`ViewportHooks` gain `onDragStart(hit, world, ev) → DragSession|null` (claim-gesture: pan stays the default),
`onDragMove`, `onDragEnd`, `onKey`. Pure reducers in `src/app/edit/` (`reducers.ts`, `overlay.ts`, `snap.ts`,
`history.ts`, `thumbs.ts`): `dragToEdit(session, world, ctx) → {edit, preview, ok, reason?, range?}` snapping to
0.05 m / wall lines / the planning grid and clamping through the same engine functions the generator uses —
`clampLayoutEdit(layout, edit, ctx)` (placer) and `clampUnitEdit(unitLayout, edit, program, ctx)` (solver) — so the
ghost shows the admissible range live; commit on pointerup → `appendOverride(spec, scope, edit)` → regenerate; undo/
redo over whole `OverrideDoc`s; selection re-resolved after regeneration by stable ids/refs. Extra optional model
fields for the editor: `ArchModel.layouts: Record<storeyId, FloorLayout>`, `RoomDef.ref`, `DoorDef.ref`, `WallDef.ref`
(partition edgeRef), `FurnitureDef.ref`, `UnitInstance.slotId`.

Tools — floor mode: select/inspect (existing card + slot/module facts), drag slot boundary (`moveBoundary`, ghost
clamps at the module range and neighbours' slack), swap module (picker = `catalogue.candidatesFor(strip)` ∩
`frontageAt(id, netDepth)` containing the slot frontage ± slack, with `buildUnitThumb(moduleId, F, D)` previews), mirror,
insert (lounge/window-bay/unit; frontage taken from neighbours down to their min), remove, move core (drag along the
bar over highlighted admissible positions), scope toggle typical-floors ↔ this storey, reset slot/floor. Unit mode
(double-click a unit): drag partition (`dragPartition`, clamped to program min/max), door drag along its wall
(`moveDoor`), flip hinge (`flipDoor`), reverse swing (`reverseDoor`), motion select (`setDoorMotion`), furniture drag/
rotate 90° (`moveFurniture`, rejected inside swing zones or over fixtures), add from a catalogue palette
(`addFurniture`), delete (`removeFurniture`), room type swap limited to types whose kit fits (`swapRoomType`), reset
unit. Keyboard: `E` edit, `Esc` back/deselect, `M` mirror, `F` flip, `V` reverse, `R` rotate, `Del` remove,
`⌘/Ctrl+Z` / `⇧⌘Z` undo/redo, `T` scope, `[`/`]` storey. Drags never regenerate; only commits do.

**Issues panel** (replaces the warnings popover): severity → rule (title from `DesignModel.rules`) → storey groups with
counts; filters by discipline/severity/storey; click → jump to storey + highlight `elementIds`/rooms/units; deviation
chips in the status bar ("B2 added for parking · 114/85", "corridor ceiling 2.15 m"); badge counts; `IfcOutput.warnings`
shown as a `writer` group; per-rule violation counts shared with the Rules tab. `DesignModel.rules: Rule[]` (resolved
built-in + custom) is added to F1.

**Rules tab** (guided builder + parameter overrides): discipline → pattern → rule rows; each param: value input (unit-
converted for lengths), unit, source, reset; enabled toggle; severity select; violation badge. "New rule" form is a
state machine driven by `PREDICATE_SIGNATURES`: subject kind → subject filter (roomType/templateId/floorUse/elementKind/
system) → predicate (filtered by legal subjects) → object (only if the signature declares one) → comparator → typed
limit + unit → scope → severity → resolution → title/source; assembled into `CustomRule`, validated with
`validateRuleOverrides` (inline messages), written to `spec.rules` with the existing `setPath`, regeneration debounced;
JSON import/export buttons. Preset switch keeps `rules`, wipes `overrides` (confirm when overrides exist). Reuses
`form.ts` primitives (`numRow/selRow/chk/section`, `delegate`, `getPath/setPath/parseValue`).

**3D ↔ plan.** Subscribe `entity-selected`/`entity-hovered` (reverse `idMap`) → highlight in plan; plan pick →
`embed.select([expressId])`; storey isolate (`isolate(expressIdsFor(el => el.storey === state.storey))`); furniture
visibility toggle; verification step: load a generated file in embed.ifclite.com and confirm mapped-item furniture is
visible, pickable and coloured.

### IFC: furniture type library with mapped items (src/core/furniture-3d.ts, vendored IfcCreator, src/ifc/writer.ts)

`Solid = {kind:'box'|'cylinder'|'ellipse'|'prism', …local dims, color?}`; `FurnitureTypeDef {id 'FT-<type>',
furnitureType, ifcType: 'IfcFurnitureType'|'IfcSanitaryTerminalType'|'IfcElectricApplianceType'|
'IfcBuildingElementProxyType', predefinedType, footprint{w,d}, height, solids (2–8), symbol: Vec2[][] (top-view plan
polylines precomputed from the solids), stretch?: 'x'}`. One entry per `FurnitureType` (45), dims from
`FURNITURE_CATALOG`. Decomposition (primitives): beds = base + mattress + headboard + 2 pillows (1 for single; bunk =
2 mattresses + 4 posts + ladder) · nightstand/dresser/wardrobe = carcass + drawer fronts / 2 handles · desk/tables =
top + 4 legs (outdoor-table pedestal) · chair/dining-chair = seat + back + 4 legs · sofa-3/2, armchair, lounge-chair =
base + cushions + back + 2 arms · coffee-table = top + 4 legs · tv-unit = cabinet + thin TV · kitchen-counter = base
cabinet + worktop overhang + upstand (**stretchable along X as PER-LENGTH TYPES with the width quantised to 0.10 m — ids `FT-kitchen-counter-w120` —
because door divisions must change in count with length and reveals must not smear; a non-uniform scale operator is
rejected for that reason**) · kitchen-island = base + worktop ·
fridge = body + 2 door leaves + handle · range = body + cooktop + 4 burner cylinders + backguard · dishwasher/washer/
dryer = body + door disc + control strip · kitchen-sink = rim frame (4 thin boxes + bottom) + faucet cylinder · wc =
bowl ellipse + tank + seat · lavatory = basin + pedestal + faucet · vanity = cabinet + basin rim + faucet · shower =
tray + 2 glass panels + head + riser · bathtub = base + 4 rim walls + spout · water-heater = cylinder + cap ·
shelving/bookcase = 2 sides + back + 4 shelves · crib = base + 4 posts + 2 rails · bench = seat + 2 legs · planter =
box + soil + trunk + canopy prism · bike-rack = rail + 4 hoops · mailbox-bank = carcass + 6 door boxes ·
reception-desk = counter + top + front panel · treadmill = deck + 2 uprights + console · grab-rail = tube + 2 flanges ·
car = body + cabin prism + 4 wheel cylinders.

`ElementGeometry` += `{kind:'instance', typeId, position: Vec3 (min corner before rotation, as `box`), rotation,
scale?: Vec3}`; `arch-elements.ts` emits `instance` for furniture at `detail ≥ medium` (boxes at `low`);
`elementFootprint()`/axon use the type footprint (solids extruded at `high`); plan-svg draws `symbol` per instance in
the existing furniture bucket — `FURN_GLYPH` letters are deleted.

Vendored IfcCreator additions (documented in NOTICE.md): `addCartesianTransformationOperator3D({localOrigin, scale?,
scale2?, scale3?})` (cached; identity shared), `addRepresentationMap(shapeRepId)`, `addMappedItem(mapId, operatorId)`,
`addMappedShapeRepresentation(mappedItemIds)` ('Body', 'MappedRepresentation'), `addBodyRepresentation(solidIds)`
(multi-item 'SolidModel'), `addTypeObject(ifcType, {Name, PredefinedType, RepresentationMaps, Tag})`,
`addRelDefinesByType(typeId, objectIds)` chunked at 500, `addInstanceElement(storeyId, {IfcType, Name, Tag, Placement,
ProductShapeId, PredefinedType})` where all occurrences of a type **share one `IfcProductDefinitionShape`** (legal —
`ShapeOfProduct` is an inverse set; ifc-lite has shared-map tests), `setSolidColor(solidId, styleName, rgb)` for type-
level styles (occurrences carry no solids). Writer pre-pass: `Map<typeKey, {typeId, mapId, prodShapeId}>` built lazily,
deferred `IfcRelDefinesByType` chunks after all products (mirrors `SharedSets`), rotation carried by the occurrence
`IfcLocalPlacement`. Per occurrence = product + IfcLocalPlacement + its own IfcCartesianPoint + IfcAxis2Placement3D (positions are
unique, so the placement chain is NOT free) ≈ **4.0 entities** (today 6.57); per type ≈ 2·solids + 7 ≈ 17–23;
us-5-over-1 furniture 11,893 → ≈ 8,240 entities (−31 %) with 3–8 primitives per item instead of one box. Caches added
at the same time: `IfcPropertySingleValue` by (Name, Type, NominalValue) (`PartOfPset` is an inverse set; 91k → est.
25–35k) and `IfcLocalPlacement` by (relativeTo, axis2). IFC2X3 export degrades furniture to boxes. `validate.ts`: add
`IFCRELDEFINESBYTYPE` to `MEMBER_LIST_RELATIONSHIPS`; plain decimals only. Tests: one type per FurnitureType (plus per-length counter variants), ≤ 5.0 entities per instance amortised
including the type library, exactly one IfcCartesianTransformationOperator3D in the file, IfcStyledItem count = Σ type
solids, deterministic output, validator passes, viewer check in the browser.

---

## Warnings → zero: the 51 reported warnings and what makes each impossible

| # (user list) | family | mechanism | test that asserts it |
|---|---|---|---|
| 1 | 15 storeys > typology max 8 | `normalizeSpec` clamps to the band; UI min/max; explicit override → `deviation` + high-rise profile | `site.test`: storeys within band or a recorded override deviation |
| 2, 3 | parking 110 / 222 | `solveParking` before massing adds B2/B3 (or podium levels), packs every parking storey, else records `relax-parking-ratio` | `coordination.test` #27: achieved == required or a deviation; `estimateUnits` ≈ massing ±2 |
| 4–7 (+61 more) | fixtures opposite the wet wall because the door swing covers it | hinge chosen away from the fixture run (`solveSwing.avoid`), `swingRect` reserved before kits; kit-derived room minima include the swing | module self-test `swing-clear`, `trap-arm` |
| 8, 9, 11, 14, 21, 22 (+2) | no room for laundry in a rect below the template minimum | feasibility witness gate: the placer only assigns modules whose `frontageAt(netDepth)` contains the slot; `stackable`/`mergeInto` are program alternatives, not drops | `packer.test` fit conformance; `feasibility.test`; self-test `kit-complete` |
| 10 | door narrowed to 0.60 m | node minima derived with leaf + 0.20 m; `allocate()` never squeezes | self-test `min-leaf`; preset test `doors.every(width ≥ leafMin)` |
| 12, 13, 20 (+1) | daylit rooms squeezed below min width | `Fmin` counts every daylit room side by side; eviction loop deleted | self-test `min-dims`, `daylight` |
| 15, 17, 23, 24 | bedroom moved into the service band / no exterior wall | program declares `needsExterior`; variants declare `minExteriorCount`; infeasible frontage never assigned | self-test `daylight`; preset test every bedroom has a window |
| 16, 18, 19 (+3) | service band too narrow (kitchen 2.10 < 2.40 …) | same witness gate; `allocate` returns `null` instead of squeezing | `feasibility.test`: allocate never below min |
| 25–27 (+10) | corridor 77.7 m without a break | `buildCorridorGraph` legs ≤ 45 m with break slots; knuckles join bars; dead ends ≤ 6/15 m | `corridor.test`; `coordination.test` #29 |
| 33 | arch slab 0.200 vs struct 0.250 | single owner: `presize.byStorey[s].slabTAbove`; `SIZES.slabT` deleted; warning code deleted | `coordination.test` #17, #18; `no-duplicate-constants.test` |
| 34 | core wall 0.25 vs 0.30 | `presize.coreWallT` read by cores.ts; `SIZES.coreWallT` deleted | same |
| 35, 36 | synthesised WC / kitchen sink | kits guarantee complete fixture sets (sink+range+fridge; wc+basin+shower/tub); plumbing synthesis path deleted | self-test `kit-complete`; `plumbing.test` `synthesisedFixtures === 0` |
| 37–46 | fixture far from stack / second stack / chase / vented branch | stack **ports** from the module (≤ 2 per dwelling, wet groups share a wall); kernel chase per column; plumbing consumes `chaseOf(unitId)`; repair machinery deleted | self-test `trap-arm`; `ports.test`; `plumbing.test` `trapArmSplits === 0 && ventedFixtures === 0` |
| 47–50 | trap arm > unvented limit | same + corrected IPC Table 1002.2 rule table | same |
| 51 | building drain at L01 vs basement fixtures | invert model → pumped storeys get sump pit + duplex ejector + discharge to gravity; collectors per level | `coordination.test` #24; `loadpath`/`support` checks |
| bug | door arc on the wrong side | `DoorDef` v2 populated at production; plan-svg reads hinge/swing; sweep-normalised arc; no arc for non-swing motions | `doors.test` swing regression over all presets; `render.test` four wall directions |

Not in the list but eliminated by the same work: mix drift (quota ledger, `mixDeviation ≤ 0.08`), 4 disjoint corridors
on O-plans (knuckles), kitchens with only a fridge (kit sweep), duplicate `furnitureIds`, cores 11.5 m apart (break
slots), Ø150 main clashing with the sprinkler main (lane widths), three shaft-slot conventions (one allocator),
columns kinking between storeys (partyLines), footings missing under upper-storey columns (load path), free-floating
runs (support check).

---

## Work breakdown — waves and Opus executor agents

Fable orchestrates: writes the frozen contracts and `CONTRACT-v2.md`, spawns agents, integrates, reviews, commits per
wave. Every implementation agent runs on **Opus**. Each agent ships its own tests and ends with a report (files, API,
deleted code, test command + result, cross-module asks). Tests and `npm run typecheck` must pass at every commit.

### Wave 0 — contracts (Fable, one commit, no behaviour change)
`src/core/types.ts` additions (optional fields), F1–F8 type files with `throw new Error('not implemented')` bodies
where needed, `src/core/openings.ts` fully implemented (≈ 40 lines, it is the door bug's root), `CONTRACT-v2.md`,
skipped invariant test scaffolds (`src/coordination.test.ts`, `src/presets.test.ts`, `src/no-duplicate-constants.test.ts`).

### Wave 1 — backbone (parallel)
| agent | owns | delivers | depends on |
|---|---|---|---|
| **K** kernel + rules | `src/core/kernel/**`, `src/core/rules/**`, `pipeline.ts` wiring, `coordination.ts` shim → deletion | profiles/lanes/clearances tables, registry + allocators + validate + support, ledger (`mirrorInto` warnings), `rulesFromPatterns` over all 100 patterns, schema + validator, `kernel.test`, `rules.test` | F1, F2 |
| **S** structure | `structure/**` | `presize.ts` (+ f2f raise), `grid.ts` on `arch.partyLines` (delete `snapToWalls`), `loadpath.ts`, transfer beams on carried columns, footings from `loadpath.bases`, keep-out registration, `plenumClearance.byStorey`, delete the two warnings + off-by-one | F1, F2; publishes F3 first |
| **R** site + spec | `site/**`, `core/spec.ts` | `parking-solver.ts` (+ `stallCapacity` extraction), `corridor-graph.ts`, `placeCores` on break slots, storey-band clamp + `allowStoreyOverride`, high-rise profile, `site.test` additions | F1, F7 |
| **D** doors + kits + ports | `openings.ts` consumers, `program/kits.ts`, `arch-elements.ts` crossLink, all 17 door producers, mock/test fixtures | door fields everywhere, `doors.test`, `kits.test` (kitchen sweep + fallback), `ports.test` | F4 |
| **P** program solver | `architecture/program/**`, shrink `unit-layout.ts` | 20 program graphs, `feasibility.ts`, `solver.ts`, `doors-in-unit.ts`, `validate.ts`, `layoutUnitV2` passing the whole existing `unit-layout.test.ts`, dep flip | F4, F5; D's `kits.ts` (stub from `kitMinDims` until D lands) |
| **L** modules + placer + overrides | `src/modules/**`, `architecture/placer/**`, `floor-organizer.ts`, `cores.ts`, `architecture/index.ts` | catalogue + self-test, packer + quota + grid snap, corridor consumption (knuckles, breaks, travel), `FloorLayout` v2, `applyOverrides`, `packer/corridor/overrides/perf` tests | F3 (`bayGridFrom`), F5, F6, F7; P's `feasibility` API (stub from `UNIT_TEMPLATES` ranges until P lands) |
| **F** IFC furniture | `src/core/furniture-3d.ts`, vendored IfcCreator extensions, `writer.ts` type pre-pass, `validate.ts`, plan/axon symbols, NOTICE.md | type library (~45 types), mapped items, caches, `writer.test` budgets | F8 |

Order inside the wave: K commits F1/F2 implementations first; S publishes F3; D lands before P's dep flip; L swaps its
feasibility stub for P's API when P lands. Wave 1 ends with: all existing tests green, `warnings` byte-identical where
not yet migrated, doors correct, modules placed, presize authoritative.

### Wave 2 — consumers (parallel)
| agent | owns | delivers |
|---|---|---|
| **M1** mechanical + electrical | `mechanical/**`, `electrical/**` | kernel lanes/risers/profiles per use (parking CO/NO₂ exhaust + jet fans, retail landlord zone, MEP rooms, resi corridor spine, unit bulkheads), exhaust/panel ports, NEC 110.26 keep-outs, EV trays over stall heads, delete `shaftSlot`/`nearestShaft`/`beamDepthUnder`/`beamDepthFor`/inline riser corner, rewritten tests |
| **M2** plumbing | `plumbing/**` | chases from ports (delete synthesis, second stack, `VW-` walls, `plumbingShaftCorner`, `MAX_VENTED_BRANCH`), invert model + sloped legs + sump/ejector + per-level collectors, corrected trap-arm table, sprinkler/pressure lanes, sleeves, rewritten Manhattan assertion (pressure Manhattan, gravity Manhattan-or-sloped) |
| **A1** app editor | `src/app/edit/**`, `viewport.ts`, `plan-svg.ts` hits/overlay/symbols, `main.ts` modes, 3D↔plan sync | constrained parametric editor per the App section above (floor + unit tools, overlay, snapping/clamping via `clampLayoutEdit`/`clampUnitEdit`, undo/redo, thumbnails, keyboard) |
| **A2** app rules + issues + worker | `src/app/worker/**`, `backend.ts`, `entry.real.ts`, `scripts/build.mjs`, rules tab, issues panel, `form.ts`, `export.ts` | worker generation + lazy IFC, issues panel, rules tab (guided builder), storeys min/max + override toggle, spec round-trip incl. `rules`/`overrides` |
| **K** (continues) | | registry hardening, `coordination.test`, `presets.test`, step-7 deletions once M1/M2 are green |

### Wave 3 — integration (Fable + one Opus agent **I**)
Zero-violation suite over all 10 presets at `medium` (+ two at `low`/`high`), determinism (byte-identical issues and
ids), perf (< 1.2 s per preset in Node), `npm run typecheck` 0 errors, esbuild build, browser verification (doors on
all four wall directions, editor drag/swap/undo, issues panel, rules form → regeneration, 3D furniture in
embed.ifclite.com, storey isolate), README/CONTRACT-v2 refresh with new preset numbers, `docs/index.html` refresh,
commits per wave, push, Pages redeploy. Memory notes updated.

### Commit plan
`v2-0 contracts` → `v2-1a kernel+rules` / `v2-1b presize+loadpath` / `v2-1c site resolutions` / `v2-1d doors+kits` /
`v2-1e program solver` / `v2-1f modules+placer+overrides` / `v2-1g ifc type library` → `v2-2a mech+elec on kernel` /
`v2-2b plumbing on kernel` / `v2-2c app editor` / `v2-2d app rules+issues+worker` → `v2-3 integration, docs, deploy`.

---

## Verification

```bash
export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
node --test 'src/**/*.test.ts'          # all suites incl. coordination / presets / no-duplicate-constants / modules self-test
npm run typecheck                        # tsc --noEmit --strict … must exit 0 (uses the formaCAD tsc)
node src/cli/main.ts --all-presets --out dist/samples --validate --report   # 10 presets, STEP validator, reports
node scripts/build.mjs --strict          # single-file app; fails if the real backend is missing
node scripts/serve.mjs 8765              # then browser checks below
```

Invariant tests that must pass before wave 3 closes: `presets.test` (zero violation/error on all presets; byte-identical
reruns; timings < 1.2 s), `coordination.test` #14–#29 (every MEP element in its own discipline's reservation and band;
shaft slots disjoint; one slab thickness; MEP under the slab; nothing wet over switchgear; no penetration of
beams/columns/lift shafts; hangers; riser continuity; drains monotonic + reachable + sump discharge; parking clear
heights; load path; parking achieved; storeys within band; corridor legs/dead ends/one graph), `modules.test`
(`selfTestCatalogue() === []`), `doors.test` (probe inside `swingIntoRoomId` for every swing door), `packer.test`
(fit conformance, `mixDeviation ≤ 0.08`), `writer.test` (≤ 5.0 entities per furniture instance amortised incl. the type library, deterministic),
`no-duplicate-constants.test` (deleted identifiers absent; every `rules.num(...)` id exists).

Browser checks (Chrome tools against `scripts/serve.mjs` and then the deployed Pages URL): generate us-5-over-1 and
ie-courtyard with **0 violations** in the issues panel and only deviation chips (parking levels, band compressions);
door arcs correct on all four wall orientations and no arcs on sliding/cased openings; edit-floor: drag a slot
boundary (ghost clamps at the module range), swap a module from the admissible picker, mirror, insert a lounge break,
undo/redo, scope typical-vs-storey; edit-unit: drag a partition (clamped), flip/reverse a door, move furniture into a
swing zone (rejected), add a wardrobe from the palette; rules tab: change `PLB-02.trapArm` and add a `USR-` rule,
regenerate, see per-rule counts; 3D tab: mapped-item furniture renders in embed.ifclite.com, storey isolate, plan pick
→ 3D select and back; IFC download validates; file size for us-5-over-1 ≤ today's 22.5 MB despite 3D furniture.

Deploy: `node scripts/build.mjs && cp dist/forma-resi-ifc.html docs/index.html`, commit, push to
`github.com/samarv/forma-resi-ifc`, confirm https://samarv.github.io/forma-resi-ifc/ serves the new build.
