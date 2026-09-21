# Exploration: coordination kernel, pipeline, structure, MEP, site

_Generated 2026-09-21 by a read-only design/exploration pass over this repository; line numbers refer to the v1 code at commit 05246fb. Source of truth for v2 contracts is docs/design/v2-plan.md and the files under src/core._

# Code map: cross-discipline coordination, structure, MEP, site

Repo root: `/Users/samarvir/formaIFC/generator` (not a git repo). ~50.8k LOC of TS, no runtime deps, Node 24 type-stripping.

---

## 1. `src/core/types.ts` — the contract (1215 lines)

### Coordinate conventions (`types.ts:1-20`, mirrored in `CONTRACT.md:25-31`)
Metres/radians; world origin = site front-left corner; **+X along street frontage, +Y street→rear, +Z up, street edge is y = 0**. Element Z is **storey-local** (0 = top of that storey's structural slab); XY is world. Polygons CCW, not closed. `Rect = {x,y,w,h}` min corner. Walls: centreline start/end, thickness centred.

### `StoreyDef` (`types.ts:321-332`)
```ts
{ id: string; name: string; index: number; elevation: number; height: number;
  use: FloorUse | 'site' | 'foundation' }
```
Sorting indices: `SITE` = -101, `FND` = -100, basements negative, `L01`.. = 0.., `ROOF` = 100. Built by `buildStoreys(spec, floors, foundationDepth = 1.2, region)` at `src/core/spec.ts:133-154`.

### `ElementGeometry` — 16 kinds (`types.ts:346-376`)
`wall` · `slab` · `column` · `beam` · `box` · `prism` · `axis` · `stair` · `door-in-wall` · `window-in-wall` · `footing` (`footingType: 'STRIP_FOOTING'|'PAD_FOOTING'|'PILE_CAP'`) · `pile` · `roof` · `gable-roof` · `railing` · `ramp`.
`axis` is the only MEP run primitive: `{ kind:'axis'; start: Vec3; end: Vec3; profile: {type:'circle';radius} | {type:'rect';width;height} }` — **no notion of hanger, support, host, or slope**.

### `ModelElement` (`types.ts:411-433`)
`id, discipline, ifcType, predefinedType?, name, objectType?, description?, storey, geometry, psets?, quantities?, material?, color?, system?, unitId?, roomId?, patterns?: string[], tags?`.

### `GenContext` (`types.ts:1164-1176`)
```ts
{ spec; typology; rng; storeys: StoreyDef[];
  site: SiteModel; arch: ArchModel|null; struct: StructModel|null;
  mech: MechModel|null; plumb: PlumbModel|null; elec: ElecModel|null;
  warnings: string[] }
```
Generator signatures (`types.ts:1178-1183`): site takes `(spec, typology, rng, warnings)`; all five others take `(ctx: GenContext) => <X>Model`. **Note: `ctx` is spread-copied per discipline in the pipeline, so a discipline cannot mutate `ctx.arch` — only the shared `warnings` array.**

### `DesignModel` (`types.ts:1185-1201`)
`spec, typology, storeys, site, arch, struct, mech, plumb, elec, elements: ModelElement[], metrics: MetricResult[], patterns: {book: Pattern[]; applications: PatternApplication[]}, warnings: string[], timings: Record<string, number>`.

### The six discipline model interfaces

| interface | line | fields |
|---|---|---|
| `SiteModel` | 589-606 | `boundary, area, buildableEnvelope, setbacks{front,side,rear}, streetFacing, northRad, massing: MassingModel, parking: ParkingLot|null, landscape: LandscapeZone[], paths: Rect[], driveway, entrances, elements, patterns, derived` |
| `ArchModel` | 828-847 | `storeys, floors: FloorPlan[], units: UnitInstance[], rooms, walls, doors, windows, furniture, cores: CoreDef[], stairs, elevators, shafts: ShaftDef[], roof: RoofDef, templatesUsed, elements, patterns, derived` |
| `StructModel` | 915-933 | `system, foundation, grid: GridLine[], columns, beams, walls, slabs, foundations, transferStorey?, sizes{columnW,columnD,beamW,beamD,slabT,shearWallT}, loads{deadKpa,liveKpa,roofLiveKpa}, plenumClearance{corridorSoffitZ}, elements, patterns, derived` |
| `MechModel` | 991-1003 | `system, ventilation, equipment: MechEquipment[], ducts: DuctRun[], terminals: AirTerminal[], risers: Riser[], plantRoomIds, loads{coolingWPerM2,heatingWPerM2,ventilationLsPerPerson,totalCoolingKw,totalHeatingKw}, elements, patterns, derived` |
| `PlumbModel` | 1051-1062 | `dhw, sprinklered, fixtures, stacks: PlumbingStack[], pipes: PipeRun[], roofDrains: Vec2[], totals{dfu,wsfu,fixtureCount,serviceDiameter}, elements, patterns, derived` |
| `ElecModel` | 1134-1146 | `service{voltage,amps,phases}, panels, devices, circuits, trays: CableTrayRun[], risers: ElecRiser[], pv?, loads{connectedVa,demandVa,perUnitVa}, elements, patterns, derived` |

Supporting MEP types: `MechEquipment` (941-953), `DuctRun` (955-966, `path: Vec3[]`), `AirTerminal` (968-977), `Riser` (979-989, `{shaftId, systemType, fromStorey, toStorey, xy, width, height, shape}`), `PlumbingFixture` (1011-1027, `dfu`/`wsfu`), `PlumbingStack` (1029-1038, `{id, shaftId?, wetWallId?, xy, systems, fromStorey, toStorey, servesUnitIds}`), `PipeRun` (1040-1049), `ElecPanel` (1075-1089), `ElecDevice` (1091-1102), `Circuit` (1104-1112), `CableTrayRun` (1114-1121), `ElecRiser` (1123-1132).
Structure: `GridLine{id,axis,offset}` (853-857), `StructColumn` (859-868, `gridRef`), `StructBeam` (870-881, `role: 'primary'|'secondary'|'rim'|'lintel'|'transfer'`), `StructWall` (883-893, `role: 'bearing'|'shear'|'core'|'foundation'`, `archWallId?`), `StructSlab` (895-902, `type: 'floor'|'roof'|'ground'|'podium-transfer'`, `openings: Rect[]`), `FoundationElement` (904-913).

Architecture's shaft contract — the **only** existing "shaft contract" (`types.ts:779-787`):
```ts
interface ShaftDef { id; rect: Rect; storeys: string[];
  purpose: 'plumbing'|'mechanical'|'electrical'|'combined'|'trash'|'elevator';
  servesUnitIds: string[]; accessFrom: 'corridor'|'unit'|'core' }
```
No per-system slot reservation, no capacity, no riser inventory, no clash geometry.

### Pattern / metric / spec types
- `PatternParameter{value: number|string|boolean; unit?; source?}` (439-444) — `source` is a free string, examples in the doc comment: `'typology' | 'spec' | 'code:IBC 2021 §1020' | 'Alexander APL #159' | 'default'`.
- `Pattern{id, name, discipline: Discipline|'cross', problem, solution, parameters: Record<string,PatternParameter>, dependsOn?, references?}` (446-459).
- `PatternApplication{patternId, storey?, unitId?, elementIds?, params?: Record<string, number|string|boolean>, note?}` (461-469).
- `MetricDef{id, rank, name, altNames: Partial<Record<Region,string>>, category, unit{metric,imperial,factor}, description, formula}` (484-494); `MetricResult{id, value, display, unit, breakdown?, status?: 'ok'|'warn'|'fail', note?}` (496-505). 30 `MetricId`s (477-482).
- `GenerationOptions` (290-300): `furniture, site, structure, mechanical, plumbing, electrical: boolean; detail: 'low'|'medium'|'high'; ifcSchema: 'IFC2X3'|'IFC4'|'IFC4X3'`.
- `BuildingSpec` (302-315): `name, seed, region, displayUnits, typology, site: SiteSpec, massing: MassingSpec, floors: FloorSpec[], unitMix?, options`.
- `SiteSpec` (236-252): `width, depth, streetFacing, context, setbacks?, slopePercent?, maxHeight?, maxFar?, maxCoverage?, parking?{type?,ratio?,evShare?,bikeRatio?}`.
- `MassingSpec` (254-272): `storeys, footprintShape?, buildingDepth?, buildingLength?, floorToFloor?, groundFloorToFloor?, podiumStoreys?, podiumUse?: 'retail'|'parking'|'amenity', basementStoreys?, corridorWidth?, coreCount?, roof, roofPitchDeg?, parapetHeight?, balconyDepth?`.
- `FloorSpec` (274-288): `index, name?, use: FloorUse, floorToFloor?, ceilingHeight?, unitMix?, targetUnits?, balconies?, setbackFromBelow?, wwr?`.
- `FloorUse` (233-234): `'residential'|'lobby-residential'|'retail'|'parking'|'amenity'|'mechanical'|'roof'|'basement'`.

### Where `warnings` live and how they aggregate

**One flat `string[]` for the whole run, no per-discipline field.** No discipline model interface has a `warnings` field.

- Created once: `src/pipeline.ts:23` `const warnings: string[] = []`.
- Handed to site as the 4th arg (`pipeline.ts:29`) and put on `ctx.warnings` (`pipeline.ts:34`).
- Every discipline pushes onto `ctx.warnings` with a self-chosen, **inconsistent** prefix:
  - structure: `[structure] …` — `structure/index.ts:77`
  - plumbing: `[plumbing] …` — `plumbing/state.ts:224` (with de-dup by key, `warnedKeys`)
  - mechanical: `MEC: …` — `mechanical/context.ts:423`
  - electrical: `electrical: …` — `electrical/panels.ts:70,118,183`
  - architecture: `[architecture] …` with a 3-occurrence cap then a roll-up — `architecture/arch-elements.ts:266-284`
  - site: **no prefix at all** — e.g. `site/massing.ts:315`
- Pipeline also pushes `Duplicate element id …` (`pipeline.ts:113`) and `Pattern application references unknown pattern …` (`pipeline.ts:80`).
- Lands on `DesignModel.warnings` (`pipeline.ts:97`).
- **Writer warnings are separate**: `IfcOutput.warnings?: string[]` (`types.ts:1203-1215`), format `writer: <elementId> (<kind>): <message>`, never merged into `model.warnings`.
- Display:
  - CLI: `src/cli/main.ts:388-390` prints `warnings model N, writer M` + the **first 5 of each**; full lists go into the JSON report at `cli/main.ts:290` under `warnings: { model, writer }`.
  - App: `src/app/main.ts:778-817` — a `▲ N warnings` button in the status bar, click opens a `<ol>` popover of `model.warnings` only (`ifc.warnings` surfaces only as `state.ifcError`). `src/app/export.ts:62` copies `model.warnings` into the exported JSON.
- **There is no severity, no code, no owning-discipline field, no link to the element/pattern that triggered it.** A warning is an opaque sentence.

---

## 2. `src/core/coordination.ts` — the whole coordination kernel today (124 lines)

This is the entire file. Every export:

| export | line | value / signature |
|---|---|---|
| `interface PlenumBands` | 16-29 | `{soffitZ, ductZ, pipeZ, sprinklerZ, trayZ, ceilingZ, plenumDepth}` |
| `interface LaneOffsets` | 31-37 | `{duct, pipe, sprinkler, tray}` — lateral offsets from corridor centreline, + = corridor-left |
| `const DEFAULT_LANES` | 39 | `{ duct: 0, pipe: -0.35, sprinkler: -0.15, tray: 0.35 }` |
| `function plenumBands(floorToFloor, slabT, beamDepth, corridorCeiling): PlenumBands` | 41-57 | `soffitZ = f2f - slabT`; `ductZ = max(soffitZ - beamDepth - 0.05 - 0.15, ceiling + 0.15)`; `pipeZ = max(ductZ - 0.25, ceiling + 0.05)`; `sprinklerZ = trayZ = pipeZ`; `plenumDepth = f2f - ceiling` |
| `function lanePath(centerline: Segment2[], lateral, z): Vec3[]` | 60-71 | offsets a corridor polyline laterally by `perp(segDir)` at constant `z` |
| `const MOUNTING` | 77-93 | `receptacle .4, counterReceptacle 1.1, switch 1.2, thermostat 1.5, panelBottom 1.2, wallLight 2.0, ceilingLightDrop 0, smokeAlarmDrop 0, windowSill .9, doorHeight 2.1, unitEntryDoorHeight 2.1, lavatoryRim .85, showerValve 1.1, hoseBibb .5, sprinklerHeadDrop .05` |
| `const SIZES` | 96-123 | `exteriorWallT .3, partyWallT .25, corridorWallT .2, partitionT .12, wetWallT .2, coreWallT .25, shaftWallT .15, slabT .2, doorInterior .8, doorBathroom .75, doorUnitEntry .9, doorBuildingEntry 1.8, doorHeight 2.1, windowHeight 1.4, windowSill .9, stairWidth 1.1, stairRiserMax .18, stairTreadMin .28, elevatorCarW 1.6, elevatorCarD 1.5, elevatorShaftW 2.0, elevatorShaftD 2.2, parkingStallW 2.6, parkingStallL 5.4, parkingAisleW 6.0, accessibleStallW 3.6` |

**What is NOT here — critical for your redesign:**
- **No shaft slots.** `shaftSlot(rect, slot)` lives in `src/disciplines/mechanical/placement.ts:370-387` (mechanical takes centre, steps along the long axis within the middle third). Plumbing independently implements `plumbingShaftCorner(rect) = [rect.x+0.15, rect.y+0.15]` at `plumbing/storm.ts:31-33`. Electrical independently hard-codes the opposite corner inline at `electrical/panels.ts:385`: `[rect.x + rect.w - 0.15, rect.y + rect.h - 0.15]`. The convention is documented in **three prose comments** (`mechanical/placement.ts:6-15`, `mechanical/index.ts:12-14`, `electrical/patterns.ts:233`) and enforced by nothing. Two of the three disciplines say "corridor-left / corridor-right" while the code actually uses **min-corner / max-corner in world XY**, which is not corridor-relative at all.
- **No per-floor-use differentiation anywhere.** `plenumBands` takes four scalars. There is no band set for parking, retail, residential, or MEP rooms. There is no "ceiling zoning" concept in the codebase.
- **No 3D reservation / occupancy / clash structure.** Lanes are 1-D lateral offsets; bands are single Z values, not extents. Nothing records that a band is taken.
- **No `sprinkler` lane consumer verification** — each discipline just calls `lanePath` with its own constant.

### Consumption sites (complete)

| caller | line | uses |
|---|---|---|
| mechanical `context.ts:247` | | `plenumBands(f2f, slabT, beamDepth, ceiling)` per storey → `StoreyInfo.bands`, `corridorDuctZ = bands.ductZ` |
| mechanical `context.ts:303` | | fallback `plenumBands(3.0, 0.2, 0, 2.6)` for unknown storeys |
| mechanical `building.ts:56` | | `lanePath(corridor.centerline, DEFAULT_LANES.duct /*0*/, st.corridorDuctZ)` — corridor make-up air (MEC-05) |
| plumbing `state.ts:147` | | `plenumBands(f2f, st, beamD, ceiling)` per storey → `StoreyInfo.bands` |
| plumbing `state.ts:193` | | fallback `plenumBands(3.0, 0.2, 0.3, 2.55)` |
| plumbing `routing.ts:159` | | `orthogonalize(lanePath(centerline, lateral, z))` inside `laneSpine` |
| plumbing `service.ts:168,286` | | `spineFor(st, storey, anchors, DEFAULT_LANES.pipe /*-0.35*/)` — DCW/DHW/HWR mains + building drain |
| plumbing `sprinkler.ts:276` | | `laneSpine(corridors, DEFAULT_LANES.sprinkler /*-0.15*/, si.bands.sprinklerZ)` |
| electrical `panels.ts:319-322` | | `plenumBands(st.height, slabT, beamDepth, ceiling)`; `lanePath(segs, DEFAULT_LANES.tray /*0.35*/, bands.trayZ)` for power, `+0.15` for data |
| `SIZES` / `MOUNTING` | many | architecture (`cores.ts`, `common-rooms.ts`, `floor-organizer.ts`, `unit-layout.ts`, `index.ts`), site (`massing.ts`, `parking.ts`), structure (`index.ts:45,176,675,679,700,705,888`), plumbing `fixtures.ts:16`, electrical `devices.ts`/`common.ts` |

**`beamDepth` is computed three times, independently, with three slightly different rules**: mechanical `context.ts:288-295` (`beamDepthUnder`), electrical `panels.ts:365-369` (`beamDepthFor`), plumbing `state.ts:113` (just `ctx.struct?.sizes.beamD ?? 0.3`, never zero even for a flat slab). So plumbing's `pipeZ` sits 0.3 m lower than mechanical's assumption on a flat-slab building.

**`slabT` is sourced inconsistently**: mechanical `context.ts:242` and plumbing `state.ts:133` prefer **architecture's** `FloorPlan.slabThickness` and fall back to `struct.sizes.slabT`; electrical `panels.ts:302` uses **only** `ctx.struct?.sizes.slabT ?? 0.2`. This directly contradicts the "structure is authoritative" warning in §3.

---

## 3. Pipeline, upstream feedback, and the slab-thickness warning

### Sequence — `src/pipeline.ts:19-104`, function `generateBuilding(input): DesignModel`
1. `normalizeSpec` (`core/spec.ts:16`) unless already a full spec (`pipeline.ts:20`, guard at 106-108).
2. `getTypology`, `createRng(spec.seed)`, `warnings = []`, `timings = {}`, `new PatternBook()` + `book.register(...CROSS, ...SITE, ...ARCH, ...STRUCT, ...MECH, ...PLUMB, ...ELEC)` (`pipeline.ts:25-26`).
3. **site** — `generateSite(spec, typology, rng.fork('site'), warnings)` (`:29`).
4. `storeys = site.massing.storeys.length > 0 ? site.massing.storeys : buildStoreys(spec, spec.floors)` (`:32`) — **site owns the storey stack**.
5. `ctx` built with all five model slots `null` (`:34`).
6. **architecture** — `ctx.arch = generateArchitecture({...ctx, rng: rng.fork('architecture')})` (`:37`) — unconditional.
7. **structure** if `spec.options.structure` (`:40-44`), **mechanical** if `.mechanical` (`:45-49`), **plumbing** (`:50-54`), **electrical** (`:55-59`). Each receives a **fresh spread of `ctx`** carrying whatever earlier models have been assigned.
8. Element merge in write order: site, arch, struct, mech, plumb, elec (`:61-68`), then `assertUniqueIds` (`:69`).
9. Pattern applications concatenated and replayed into the book (`:71-82`).
10. `computeMetrics(model)` (`:101`).

### Can any discipline feed back upstream? **No.**
- The pipeline is a single forward pass. `ctx.arch` is set once at `:37` and never revisited.
- Each discipline gets `{...ctx}`, a shallow copy — writing `ctx.arch = …` inside a discipline mutates only the copy.
- There is no second pass, no fixed-point loop, no "pre-sizing" stage, no re-entry.
- The **only** backward channel is the shared `warnings` array, i.e. prose for a human.
- Structure *does* publish forward-facing hints — `StructModel.sizes`, `StructModel.plenumClearance.corridorSoffitZ` (`structure/index.ts:1215, 1274`), `derived.structuralDepthAtCorridor` — but those are consumed only by mech/plumb/elec, never by architecture, which has already run.

### The slab-thickness warning
Emitted at **`src/disciplines/structure/index.ts:205-209`**:
```ts
const typicalPlan = planByStorey.get(typicalStorey.id);
if (typicalPlan && typicalPlan.slabThickness > 0 && Math.abs(typicalPlan.slabThickness - slabTOf(typicalStorey.id)) > 0.02) {
  warn(`arch.floors[${typicalStorey.id}].slabThickness ${...} differs from the structural slab ${...} — structure is authoritative; architecture should adopt ${...} for ceiling heights.`);
}
```
Checked **only on the "typical storey"** — `residentialStoreys[floor(n/2)]` or the top storey (`structure/index.ts:143-146`). Every other storey's mismatch is silent.

`slabTOf(storeyId)` (`structure/index.ts:189-193`): `TRANSFER.slabT = 0.3` at the transfer storey; `groundSlabT = max(sizes.slabT, basements||parking ? 0.3 : 0.25)` at the lowest storey; else `sizes.slabT`, which comes from `sizesFor(system, …)` at `sizing.ts:179`: **`0.25` for `rc-flat-plate-core`, `0.2` for everything else**.

### How architecture picks slab thickness and core wall thickness today
- **Slab**: `src/disciplines/architecture/index.ts:262`
  ```ts
  const slabThickness = podiumStoreys > 0 && s.index + 1 === podiumStoreys ? 0.25 : SIZES.slabT; // 0.2
  ```
  A hard-coded two-case constant, with no knowledge of system, span, or storey count. Drives `wallHeight = max(2.2, f2f - slabThickness)` (`:274`) and `FloorPlan.slabThickness` (`:192`, `:275`). Note the transfer slab is off by one storey vs structure's (`structure/index.ts:98` puts the transfer at `storeyIdFor(podiumStoreys)`; architecture thickens `s.index + 1 === podiumStoreys`) **and** by 0.05 m (0.25 vs `TRANSFER.slabT = 0.3`).
  → For `rc-flat-plate-core` (any building > 12 storeys, `typologies.ts:451`) architecture always says 0.200 and structure always says 0.250 → **the L08 warning fires on every tall building, by construction.**
- **Core walls**: always `SIZES.coreWallT = 0.25` (`architecture/cores.ts:101, 290, 342, 439`; `floor-organizer.ts:734`). Structure wants `sizes.shearWallT = 0.3` unconditionally (`sizing.ts:186`) → warns once per run at `structure/index.ts:530-533`, `designThicknessWarned` guard. **Also fires by construction on every building with a core.**
- Roof: `slabThickness: roof.thickness` (`architecture/index.ts:207`).

### What a structural pre-sizing step would need as inputs
From the existing computations, the minimal input set is:
- **Storeys**: `StoreyDef[]` (index, elevation, height, use) — already available before architecture, from `site.massing.storeys` / `buildStoreys`.
- **System + foundation**: `structuralSystemFor(typology, storeyCount)` (`typologies.ts:447-452`) and `foundationFor(system, storeys, parking)` (`:454-459`) — both pure functions of typology + storey count + parking type, **already callable pre-architecture**; `site/massing.ts:386-388` already calls both to derive `foundationDepth`.
- **Loads**: `loadsFor(system)` → `{deadKpa, liveKpa: 1.9, roofLiveKpa: 1.0}` (`sizing.ts:107-117`), plus `LIVE_CORRIDOR_KPA = 2.4` (`sizing.ts:29`).
- **Spans**: currently derived *after* architecture from `buildGrid(...)` on architecture's walls → `maxTribX * maxTribY` (`structure/index.ts:182-184`). Pre-architecture the same number is obtainable from `MassingBar.depth`/`length`, `CorridorSpine.centerline`+`width`, `CorePlacement.rect`, and the unit frontage already computed by site (`massing.ts` `dwellingFrontage`, `impliedUnitDepth`) — i.e. the party-wall rhythm is knowable from site's massing without architecture's walls. `GRID_RULES = {minSpacing 4.0, maxSpacing 9.0, pointPlateTarget 7.5, snapDistance 0.6}` (`sizing.ts:197`).
- **Use**: per-storey `FloorUse`, to pick parking module (`TRANSFER.moduleAlong 8.4 / moduleAcross 16.8`, `sizing.ts:195`) vs residential grid, and ground/podium slab thickening.
- **Podium/transfer**: `spec.massing.podiumStoreys`, `isHybridPodiumSystem` (`sizing.ts:76-78`).
- Outputs it must publish *before* architecture runs: `slabT` per storey, `beamD`, `shearWallT` (→ `SIZES.coreWallT`), `columnW/D` band, `corridorSoffitZ`, `transferStorey`, grid offsets. `sizesFor(system, storeys, typicalTributaryM2, loads)` (`sizing.ts:159-188`) and `columnSide(material, storeysAbove, tributaryM2, loads)` (`sizing.ts:139-150`) are already pure and need only those inputs.

---

## 4. `src/disciplines/structure/*`

### `grid.ts` (329 lines) — grid derivation
`buildGrid(opts: BuildGridOptions): GridPlan` (`grid.ts:170-276`).
`BuildGridOptions` (`:57-72`): `{typicalOutline, podiumOutline, longAxis, shape, walls: WallDef[], cores: CoreDef[], exteriorWallT, includeParkingGrid, namer}`.
`GridPlan` (`:38-55`): `{lines, mainX, mainY, parkX, parkY, longAxis, corridorAxis, corridorOffsets, avgSpacingX, avgSpacingY, label(axis,offset), ref(x,y)}`.

Derivation — **from architecture's walls, party walls dominant**:
- `snapWallsOf(walls, ['exterior','party','corridor','core','retaining'])` (`:78-92`) reduces axis-aligned walls to `SnapWall{constAxis, at, lo, hi, type, thickness}`; skew walls are silently dropped.
- `wallOffsets(snaps, types, axis, minLength)` (`:95-98`) collects constant coordinates: exterior/retaining ≥ 2.0 m, corridor ≥ 3.0 m, party ≥ 2.0 m.
- Perimeter fallback when < 2 exterior lines: outline bounds ± `t/2` (`:189-190`).
- Three branches (`:199-227`):
  - **squarish** (`shape === 'point'` or within 1.5× aspect): perimeter + core + party in both directions, `normalizeOffsets(…, 4.0, 9.0, mustKeep = perim+party)`; if fewer than 3 lines, `moduleOffsets(…, 7.5, 9.0)`.
  - **bar along X**: longitudinal = perimeter-Y + corridor-Y, `normalizeOffsets(longitudinal, 1.5, 11, …)` (keeps the tight corridor pair, only subdivides > 11 m depth); transverse = perimeter-X + **party-X** + core-X with `mustKeep = [perimX, partyX]` — comment at `:215-216`: "Party walls outrank core edges".
  - **bar along Y**: mirrored.
- `normalizeOffsets(raw, minSpacing, maxSpacing, mustKeep)` (`:123-152`): merge closer than `minSpacing` (must-keep wins), then subdivide gaps > `maxSpacing * SPLIT_TOLERANCE` (`SPLIT_TOLERANCE = 1.12`, `:117`) into `ceil(gap/max)` equal bays.
- **Parking grid** (`:229-237`): `moduleOffsets` on `podiumOutline ?? typicalOutline` at `TRANSFER.moduleAlong 8.4` / `moduleAcross 16.8`, only when `includeParkingGrid`.
- Labels (`:239-258`): union of main+park offsets, X → letters skipping I/O via `letterLabel` (`:17-25`), Y → 1,2,3…; `ref(x,y) = 'C-3'`.
- `tributaryExtent(offsets, i)` (`:288-293`): half-bay each side, floor 3.0 m.
- `snapToWalls(p, snaps, GRID_RULES.snapDistance /*0.6*/)` (`:303-321`): STR-03, pulls a grid intersection onto any wall centreline within 0.6 m. **Called per storey with that storey's own walls** (`structure/index.ts:154-161, 422`) — so a column can shift laterally between storeys.
- `insideAnyRect(p, rects, margin = 0.05)` (`:324-329`).

### `sizing.ts` (326 lines) — sizing tables and code refs
- Classification: `isBearingWallSystem` (light-wood-frame, masonry-bearing, mass-timber-clt), `isFrameSystem` (rc-flat-slab, rc-flat-plate-core, steel-frame), `isHybridPodiumSystem` (wood-over-podium) — `:66-78`. `columnMaterialFor` / `bearingWallMaterialFor` / `floorPlateMaterialFor` — `:80-101`.
- `loadsFor(system)` (`:107-117`): dead 5.0 (wood, CLT) / 5.5 (masonry, steel) / 6.0 (rc-flat-slab, wood-over-podium) / 7.0 (rc-flat-plate-core) kPa; **live 1.9 kPa and roof live 1.0 kPa for every system**. `LIVE_CORRIDOR_KPA = 2.4` (`:29`) — exported but **only reported in `derived.liveCorridorKpa`, never used in sizing**.
- `columnSide(material, storeysAbove, tributaryM2, loads)` (`:139-150`): timber → flat 0.14; steel → HSS ladder 0.3/0.35/0.4/0.45/0.5 at 1500/3000/5000/8000 kN; concrete → `A = N/(0.3·f'c)`, `f'c = FC_KPA = 30 000` kPa (`:124`), side rounded up to 50 mm, **clamped to [0.4, 0.9]**. No slenderness, no moment, no eccentricity.
- `columnBand(material)` (`:152-156`).
- `sizesFor(system, storeys, typicalTributaryM2, loads)` (`:159-188`): beam `w × d` per system — light-wood 0.05×0.3, masonry 0.2×0.3, CLT 0.2×0.45, wood-over-podium 0.3×0.5, steel 0.25×0.45, default RC 0.3×0.5. **`slabT = system === 'rc-flat-plate-core' ? 0.25 : 0.2` — not span-derived.** `shearWallT = 0.3` — **constant**.
- Constants: `TIMBER_RIM {w .05, d .3}` (`:191`); `LINTEL {depth .2, bearing .15, clearance .05, triggerWidth 1.2}` (`:193`); `TRANSFER {slabT .3, beamW .5, beamD .9, moduleAlong 8.4, moduleAcross 16.8}` (`:195`); `GRID_RULES` (`:197`); `FOUNDATION_RULES {stripWidth .6, stripHeight .3, stemWallT .25, padHeight .5, padMax 3.5, raftT .8, pileCapSize 1.8, pileCapHeight .9, pileDiameter .6, pileLength 18, pileLengthTall 25, slabOnGradeEdge .4}` (`:199-212`); `padSide(storeys) = min(3.5, 0.15·storeys + 1.2)` (`:215-217`).
- Section naming: `W_SHAPES` ladder W8x18…W24x68 (`:226-235`), `wShapeFor`, `columnSection` (`HSS wxdx12` / `Glulam GL24h` / `RC`), `beamSection`, `slabSection` (`CLT 5-ply` / `timber floor cassette` / `RC flat slab`) — `:237-261`.
- Materials `MATERIALS` (`:267-275`, C30/37, S355, GL24h, CLT, blockwork); colours `COLORS` (`:287-294`).
- Carbon: `CARBON {concreteKgCO2ePerM3 = 2400·0.13, rebarKgPerM3 86, rebarKgCO2ePerKg 1.95, steelKgCO2ePerKg 1.5, timberKgCO2ePerM3 = 500·0.4}` (`:304-315`), `RC_KGCO2E_PER_M3` (`:318`), `timberIntensity(system)` 0.14/0.18 m³/m² (`:321-323`), `STEEL_KG_PER_M2 = 60` (`:326`).
- **Code references live only in pattern `parameters[].source` strings** (`structure/patterns.ts`), not in `sizing.ts`. `sizing.ts` cites practice only in inline comments (`// 2-ply LVL rim board 45 x 300`, `// W18x50-ish`).

### `index.ts` (1331 lines) — `generateStructure(ctx): StructModel`
Ownership contract, `index.ts:4-32`: architecture emits **every** `IfcWall` for exterior/party/corridor/core/partition; structure records them as `StructWall{archWallId}` and emits **no element**, relying on the writer to set `Pset_WallCommon.LoadBearing = TRUE`. Structure emits walls only for basement retaining walls and foundation stem walls. Structure owns all structural slabs, columns, beams, footings, pile caps, piles. **Architecture owns balcony slabs and pitched roofs.**

Elements emitted, with geometry kind:

| element | kind | ifcType | where |
|---|---|---|---|
| floor / ground / roof / podium-transfer slab | `slab` | `IfcSlab` (`FLOOR`/`BASESLAB`/`ROOF`) | `emitSlab` `:278-346`, loop `:348-377` |
| column | `column` (`shape:'rect'`) | `IfcColumn` `COLUMN` | `:406-482` |
| basement retaining wall | `wall` | `IfcWall` `SOLIDWALL`, `objectType 'RetainingWall'` | `:551-593` |
| foundation stem wall | `wall` | `IfcWall` `SOLIDWALL`, `'StemWall'` | `:1016-1055` |
| beam: rim / primary / secondary / lintel / transfer | `beam` | `IfcBeam` (`EDGEBEAM`/`BEAM`/`JOIST`/`LINTEL`) | `pushBeam` `:599-659`, loop `:661-783` |
| strip / pad footing, pile cap | `footing` | `IfcFooting` | `emitFooting` `:791-842` |
| bored pile | `pile` | `IfcPile` `BORED` | `emitPile` `:844-879` |
| raft | `slab` | `IfcSlab` `BASESLAB`, `'Raft'` | `:958-995` |
| slab-on-grade | *(none — pattern application only)* | — | `:997-1006` |
| grid lines | *(no element; `GridLine[]` only)* | — | `grid.ts:255-258` |

**Shear walls, core walls and bearing walls emit NO geometry** — they are `StructWall` records pointing at architecture wall ids.

Beam logic by mode (`modeOf`, `:102-107`):
- `frame-rc`: **rim/edge beams at the slab perimeter only**, plus the courtyard edge (`:697-709`) — flat slab otherwise.
- `frame-steel`: primary beams between adjacent columns that both exist (`at` set check, `:710-727`); secondary beams at ~3 m only at `detail === 'high'` (`:728-743`).
- `bearing`: rim beam on every bearing wall (`:752-756`, LVL rim / glulam / RC ring beam) + lintels over openings > `LINTEL.triggerWidth = 1.2` (`:757-782`, `emitLintel` `:769-782`).
- **Podium top** (`isPodiumTop`, `:665-695`): `TRANSFER.beamW 0.5 × beamD 0.9` transfer beams on `grid.mainX`/`mainY`, clipped to the plate above, at `zUnder = s.height - 0.3 - 0.9`, then `continue` (skipping rim beams entirely on that storey).

### Load-path / continuity — **there is none**
- Columns are generated **independently per storey** (`:406-482`) from `parking ? grid.parkX/parkY : grid.mainX/mainY`. A podium storey uses the 8.4/16.8 parking module; the storey above uses the party-wall grid. **No check that a column above lands on a column, a transfer beam, or a wall below.** Transfer beams are laid on `grid.mainX`/`mainY` (`:673-680`) whether or not columns above actually sit on those lines.
- `snapToWalls` is applied with **per-storey** walls (`snapsFor(s.id)`, `:154-161, 422`), so the same grid intersection can land at different XY on different storeys — a silent 0.6 m kink in the column line, unreported.
- `blockerRects(storeyId)` (`:387-398`) drops any intersection inside a core / elevator / shaft / stair-or-shaft room on **that** storey. If a shaft exists only on upper floors, the column below is kept and the one above dropped — again unchecked.
- `setbackFromBelow` (`FloorSpec`) and courtyard voids change the outline per storey; `pointInPolygon(p, outline)` (`:425`) drops out-of-outline columns. **Nothing verifies the column below a dropped column now carries a cantilever.**
- Footings are derived **only from the lowest storey**: `lowestColumns = columnsByStorey.get(lowestStorey.id)` (`:881`) and `lowestWalls` (`:882`). A column that exists on `L02` but not `L01` therefore has **no footing and no support**, silently.
- Balconies: `BalconyDef` / balcony slabs are emitted by architecture; structure never sees them and never adds a cantilever, upstand, or edge beam. Grep for `cantilever` across `src`: **zero matches**.
- The only three structural self-checks are the fallback warnings at `:919`, `:1010`, `:1259` (no bearing walls → perimeter strips; nothing to found on; no columns and no bearing walls at all).

Pattern applications recorded (`:1058-1162`): STR-01 (system), STR-02 (grid), STR-03 (snapping stats), STR-04 (transfer), STR-05 (core/shear), STR-06 (foundations), STR-07 (openings), STR-08 (lintels), STR-09 (spans), STR-10 (column sizes), STR-11 (roof diaphragm), **XD-03**.
`derived` (`:1217-1256`) publishes ~40 numbers incl. `corridorSoffitZ`, `structuralDepthAtCorridor`, `slabT`, `beamDepth`, `shearWallT`, `maxColumnTributaryAreaM2`, `embodiedCarbonA1A5PerM2`.

Patterns: `STR-01` System by Height · `STR-02` Grid on Party Walls · `STR-03` Columns Hide in Walls · `STR-04` Podium Transfer Level · `STR-05` Core as Shear Spine · `STR-06` Foundation by Load and Ground · `STR-07` Slab Openings Follow Shafts · `STR-08` Headers over Openings · `STR-09` Economic Span · `STR-10` Balanced Column Sizes · `STR-11` Stiff Roof Diaphragm.

---

## 5. `src/disciplines/mechanical/*`

Files: `index.ts` (216), `context.ts` (731), `unit-systems.ts` (822), `ventilation.ts` (606), `building.ts` (349), `placement.ts` (470), `loads.ts`, `patterns.ts` (221), `test-fixtures.ts`, `mechanical.test.ts`.

### `generateMechanical(ctx)` — `index.ts:54-195`
`resolveHvac` / `resolveVentilation` (`:44-52`) read an ad-hoc `spec.hvac` / `spec.ventilation` override (cast through `MechOverrides`, `:39-42`) else `typology.hvac` / `typology.ventilation`. Then: loads per unit → `MEC-12` + `XD-05` + `MEC-01` applications (`:67-109`) → `buildUnitInfo` + `generateUnitSystem` per unit (`:112-119`) → `generateVentilation(b, infos)` (`:122`) → `generateBuildingSystems(b, totals)` (`:123`) → `XD-04` / `XD-02` applications (`:129-142`) → aggregate warnings (`:143-148`) → `finalizePatternTrace()`.

### What `context.ts` computes — `class MechBuild` (`:175-677`)
- Indexes: `rooms, walls, doors, windowsByRoom, furnitureByRoom, floors, units, shafts` (`:225-235`).
- **`StoreyInfo` per storey** (`:81-99`, built `:239-271`):
  `{id, index, elevation, floorToFloor, ceilingHeight, slabT, isResidential, corridors, unitIds, bands: PlenumBands, corridorDuctZ, corridorDuctDepth, unitDuctZ, unitDuctDepth}`.
  - `f2f = FloorPlan.floorToFloor ?? storey.height ?? 3.0`; `slabT = FloorPlan.slabThickness ?? struct.sizes.slabT ?? 0.2`; `ceilingWanted = FloorPlan.ceilingHeight ?? clamp(f2f-0.45, 2.3, 2.7)`, then `ceiling = min(ceilingWanted, max(0.4, f2f - slabT - 0.1))` (`:245`).
  - `beamDepthUnder(f2f, slabT)` (`:288-295`): **0 when `struct.beams` is empty**; else `soffit - struct.plenumClearance.corridorSoffitZ` if that is in range, else `struct.sizes.beamD`.
  - `corridorDuctDepth = fitDepth(0.3, ductZ, ceilingZ, soffitZ)` (`:713-717`) — largest depth that fits.
  - `unitDuctBand(f2f, slabT, ceiling, 0.25)` (`:724-730`) — the **dwelling** band, separate from the corridor band: trunk tight under the soffit minus 0.05, or sitting on the ceiling with `tight = true` → warning at `:268-270`.
  - `isResidential = FloorPlan.unitIds.length > 0`. **This is the only per-floor-use discrimination in mechanical, and it is binary.**
- Roof plant zone: `arch.roof.plantZone ?? derivePlantZone(roofBounds, units.length)` → `PlantGrid(plantZone, 1.0)` (`:274-277`).
- Ground pad origin at the rear of the roof bounds (`:280`) for MEC-04 last resort.
- Shaft slots: `nextShaftSlot(shaftId)` starts at **1** (slot 0 reserved for the main air riser) (`:394-398`); `claimShaftXY(shaft, preferCentre)` (`:406-412`) → `shaftSlot(rect, 0)` for the first, then stepped slots.
- `riserSpan(fromId, toId)` (`:319-327`) — storeys `index >= from.index && < hi && index >= 0 && id !== ROOF`.
- Emitters: `addEquipment` (`box`, `:447-489`), `addTerminal` (`box` 50 mm faceplate under the ceiling, `:491-529`), `addDuct` (splits a `Vec3[]` path into one `axis` element per leg + `IfcDuctFitting BEND` boxes at interior corners unless `detail === 'low'`, `:531-614`), `ensureRiser(key, make)` / `addRiser` (one `axis` element **per storey**, `z = 0 → f2f`, tagged `'riser'`, `shaft:<id>`, `:621-676`).
- Pattern trace capped at `PATTERN_APP_CAP = 64` per id (`:173`, `:425-441`).
- `EQUIPMENT_IFC` map (`:54-71`) — 16 equipment types → IFC entity/predefined/system; `TERMINAL_IFC` (`:73-79`); `SYSTEM_COLOR` (`:29-41`).

### Per-floor-use placement — **there is essentially none**
Room classification is entirely by `RoomType`, not `FloorUse` (`placement.ts:29-54`):
- `HABITABLE` = living, dining, kitchen, living-kitchen, bedroom, master-bedroom, den, study, flex, shared-living, shared-kitchen, lounge.
- `EXTRACT_ROOMS` = bathroom, ensuite, wc, powder, laundry, utility.
- `WET_ROOMS` = bathroom, ensuite, wc, powder.
- `PLANT_CLOSETS` = utility, laundry, storage, closet (walk-in-closet deliberately excluded).
- `HALL_ROOMS` = hall, entry, corridor.

**Confirmed absent (grep over `src/disciplines/mechanical/*.ts` for `parking|retail|amenity|basement`):**
- **No parking garage exhaust**, no CO-based demand ventilation, no jet fans, no CO sensors, no `IfcSensor` for CO. `'parking'` appears **nowhere** in the mechanical discipline.
- **No retail** ventilation, no tenant RTU, no retail make-up air, no grease duct beyond the per-dwelling `range-hood`.
- **No MEP-room** logic other than `centralPlant` looking for `room.type === 'mech-room' || 'plant'` to drop boilers into (`building.ts:257, 280-311`) and `plantRoomIds` reporting (`index.ts:164`).
- `'basement'` never appears.

What *is* per-floor-use-adjacent: `b.resiStoreys` (residential only) drives the corridor make-up air spine and stair pressurisation; `isPodiumStorey`-style logic exists in structure but not here.

### Corridor + building systems — `building.ts`
- `corridorSpine(b)` (`:42-148`): for every `resiStoreys × corridors`: `q = max(30, area · CORRIDOR_MAKEUP_LS_PER_M2)`, rect duct `width = rectTrunkWidth(q, depth)` on `lanePath(centerline, DEFAULT_LANES.duct /*0*/, st.corridorDuctZ)`; diffusers every 9 m (12 at `detail 'low'`); feed riser in `shaftNearCore` (`:150-164`) with `claimShaftXY(shaft, true)` → shaft **centre**; one L-shaped riser tap; one `rtu` per feeding shaft on the roof.
- `placeOnRoof(b, type, size, opts)` (`:179-196`) — `PlantGrid.place` packing, `overflow` counter → warning at `index.ts:146-148`.
- `stairPressurisation(b)` (`:202-245`): trigger `top > 23 m` measured to the **highest residential elevation**; roof fan per core + `corridor-pressurization` riser in `inset(core.rect, 0.35)` min corner, `label: 'PRESS'`.
- `centralPlant(b, totals)` (`:251-322`): chillers (`ceil(coolingKw/350)`, max 4) + one AHU on the roof for `central-ahu-fan-coil`; boilers (`ceil(heatingKw/300)`, max 3) into `mech-room`/`plant` rooms, else the roof.
- `vrfCondensers` (`:324-346`): one per 8 dwellings, roof.

### Shaft usage
`nearestShaft(shafts, p, storey)` (`placement.ts:392-400`) with **no purpose filter** — mechanical will happily claim a `purpose: 'plumbing'` shaft. Riser keys: `${shaft.id}:supply`, `${core.id}:pressurisation`, plus per-unit refrigerant/kitchen-exhaust/outdoor-air risers from `unit-systems.ts` / `ventilation.ts`. `shaftSlot(rect, slot)` (`placement.ts:370-387`) keeps mechanical inside the middle third of the long axis; `SHAFT_SLOT_CAPACITY = 7` (`:390`).

### Loads model — `loads.ts`, used at `index.ts:67-109`
`REGION_LOADS[region] → {coolingWPerM2, heatingWPerM2, ventStandard, source}`; `computeUnitLoad(region, unitId, area, bedrooms, occupants) → UnitLoad{coolingW, heatingW, ventilationLs, occupants}`. Occupancy = bedrooms + 1 (XD-05). Supply air from cooling at 400 cfm/ton (`MEC-12` param `supplyAirPerCooling 53.7 l/s per kW`). `CORRIDOR_MAKEUP_LS_PER_M2`, `rectTrunkWidth(q, depth)`, `r1`/`r3` rounding helpers also live there. `MechModel.loads` reports `coolingWPerM2, heatingWPerM2, ventilationLsPerPerson, totalCoolingKw, totalHeatingKw`.

### MEC-01 … MEC-12 (`mechanical/patterns.ts`)
| id | name | one-line intent |
|---|---|---|
| MEC-01 | System Follows Typology and Region | take the HVAC system from the typology and load intensities from the region table, never from habit |
| MEC-02 | Short Ducts from a Central Hall | air handler at the dwelling's centre of gravity, one flat hall trunk, short branches, no run > 12 m, no duct across a bedroom |
| MEC-03 | Exhaust Rises in the Wet Wall | extract runs to the wet wall, joins above the ceiling, rises in the nearest shaft to a roof fan; kitchen keeps its own riser; houses discharge through the facade |
| MEC-04 | Outdoor Units Out of Sight | ODU on the balcony first, then the roof plant zone, then a screened rear ground pad — never the street elevation |
| MEC-05 | Corridor Make-up Air Spine | one make-up duct on the corridor centreline duct lane, diffuser every 9 m, corridor held positive |
| MEC-06 | Plant on the Roof | shared plant in a roof zone at 0.25 m²/dwelling on a grid with 1 m aisles, behind a screen |
| MEC-07 | Pressurised Stairs above 23 m | roof pressurisation fan per stair core above 23 m to the highest occupied floor, 50 Pa |
| MEC-08 | Heating Under the Window | emitter centred under the window, ~60 % of window width, top below the sill |
| MEC-09 | Balanced Ventilation per Dwelling | one balanced heat-recovery box per dwelling, rate from occupancy not area |
| MEC-10 | One Thermostat per Home | exactly one thermostat on an interior hall wall at 1.5 m; electrical picks it up from `mech.equipment` type `thermostat` |
| MEC-11 | Range Hood over the Range | ducted hood over the range, face 0.75 m above the cooktop, dedicated smooth-bore duct |
| MEC-12 | Loads from People not Area | occupancy = bedrooms + 1; ventilation from occupancy, cooling/heating from regional intensity × area |

---

## 6. `src/disciplines/plumbing/*`

Files: `index.ts` (192), `state.ts` (579), `fixtures.ts` (332), `stacks.ts` (571), `branches.ts` (160), `routing.ts` (312), `service.ts` (373), `sprinkler.ts` (417), `storm.ts` (299), `dhw.ts` (266), `tables.ts` (249), `patterns.ts` (248), `plumbing.test.ts` (1074).

Order of operations — `index.ts:47-56`: `buildFixtures` → `buildFloorDrains` → `buildHoseBibbs` → `buildStacks` → `buildBranches` → `buildDhw` → `buildService` → `buildFireProtection` → `buildStorm` → `buildGas`.

### `state.ts` — Z conventions and state
Constants (`:29-41`): `WASTE_Z -0.12`, `DCW_BRANCH_Z 0.45`, `DHW_BRANCH_Z 0.55`, `BRANCH_VENT_Z 1.5`, `SERVICE_Z -0.9`, **`BUILDING_DRAIN_Z -0.55`**, **`SEWER_Z -1.2`**, `STORM_MAIN_Z -1.0`, `MIN_SEGMENT 0.02`, `STACK_PIPE_SPACING 0.08`, `RUN_LENGTH_FACTOR 1.5`.
`StoreyInfo` (`:43-62`): `{id, index, elevation, f2f, ceiling, slabT, use, hasUnits, plan, bands, hasCorridors, trunkZ, maxRunLength}`. `trunkZ = max(0.6, f2f - slabT - TRUNK_SOFFIT_DROP /*0.35*/)` (`:149`). `use: String(s.use)` is **captured but never branched on** — grep confirms `info(st,…).use` is never read for a decision.
`StackInfo` (`:64-79`): `{stack, dir, systemXY: Map<PipeSystemType,Vec2>, diameters, wallIds, storeys, fixtureIds, dfu, wsfu, secondary}`.
`PlumbState` (`:81-106`) incl. `buildingStoreys` (index in (-100,100), ascending), `unitStoreys`, `roofStorey`, `groundStorey` (first `index >= 0`), `bars: Rect[]` from `site.massing.bars`, `warnedKeys`, `counts`.
Emitters: `emitAxis` (one `axis` element, `isOrthogonal` self-check → `counts.nonOrthogonal`, `:276-308`), `emitBox` (`:332-364`), `emitRun` (orthogonalize → `splitPath(MAX_RUN_POINTS 12, storey cap)` → one `axis` per leg + `IfcPipeFitting BEND` at `detail 'high'`, `:396-466`), `addFixture` (`:527-579` — **thin 0.15×0.15×0.1 marker** for furniture-derived fixtures to avoid duplicating architecture's furnishing solid; `solid: true` for equipment architecture does not draw).

### `fixtures.ts` — how fixtures are derived
`buildFixtures(st): PlacedFixture[]` (`:139-258`), `PlacedFixture` (`:20-43`): `{fixture, spec, storey, unitId?, roomId?, center, wall: Segment2, wallId, wallThickness, along, offset, stackIdx, vented?}`.
1. **From architecture furniture** (`:156-182`): every `FurnitureDef` with `needsWater`, mapped by `fixtureTypeForFurniture(type)` (`tables.ts:148-157` — `FURNITURE_TO_FIXTURE` table, `NO_WATER = [dryer, fridge, range, kitchen-island]`, then substring heuristics `sink`/`counter`/`toilet`, **fallback `'utility-sink'`**). `water-heater` is skipped (handled by `dhw.ts`).
2. **Wall attachment** — `chooseWall(center, storey, unit, room, wallById, wetByStorey)` (`:70-113`): closest of `unit.wetWallIds` preferring the fixture's own storey → else nearest `type: 'wet'` wall on that storey within 6 m → else a **virtual wall** on the nearest room-rect edge, id `VW-<roomId>`, thickness 0.2. No wall at all → warning `nowall:<type>` + `counts.unpipedFixtures`.
3. **Synthesised bathrooms** (`:185-231`): any room of type bathroom/ensuite/powder/wc with no water furniture gets `['wc','lavatory','shower']` (powder/wc → `['wc','lavatory']`) spread along the wet wall at `(i+0.5)/n` of the room's span, pushed **0.4 m off the wall face** (`side * 0.4`, `:218`), `solid: true`. → warning `synth:<roomType>`: **"bathroom furniture missing (bathroom); synthesised wc/lavatory/shower on the wet wall 0.4 m off the face"** (`:229-231`).
4. **Kitchens with no sink** (`:234-255`): per `unit.kitchenRoomId`, one `kitchen-sink` at the wet-wall projection of the room centre, again 0.4 m off the face → warning `synth:kitchen`: **"kitchen had no sink in the furniture; synthesised one on the wet wall"** (`:254`).
5. `buildFloorDrains(st)` (`:261-282`): rooms in `DRAIN_ROOM_TYPES = {mech-room, water-room, elec-room, plant, parking, trash}` (`:46`) with area ≥ 2 m², `1..6` drains at 1 per 300 m² for parking, 1 per 40 m² otherwise.
6. `buildHoseBibbs(st)` (`:288-323`): only `access === 'direct'` / `garden-walkup` / `stacked-townhouse`; two exterior walls at grade.

`tables.ts`: `FIXTURES: Record<FixtureType, FixtureSpec>` (`:33-126`) with `dfu`/`wsfu` (IPC 709.1 / E103.3(2) private), `ifcType`/`predefinedType`, default `size`, `supplyZ`, `wasteD`, `supplyD`. Sizing: `hunterGpm(wsfu) = max(5, 0.95·wsfu^0.63)` (`:208-211`), `diameterForFlowLps(lps, v=2.4)` (`:214-218`), `serviceDiameterFor(wsfu, dwellings)` with code floor 0.05/0.025 (`:221-225`), `mainDiameterFor(wsfu)` (`:228-230`), `stackSystems(storeys, central)` → waste Ø100, vent Ø75, dcw Ø32 (Ø50 > 10 storeys), dhw Ø25, + hwr Ø20 when central (`:233-242`), **`maxTrapArm(d)`: ≥ 0.1 → 3.0 m; ≥ 0.075 → 1.8 m; else 1.5 m** (IPC 2021 Table 1002.2) (`:245-249`).

### `stacks.ts` — stack location, second stacks, vented fallback
`buildStacks(st, placed): StackInfo[]` (`:325-566`).

Constants: `ALIGN_TOL 0.3` (vertical clustering), `MERGE_RADIUS 3.0` (PLB-09 consolidation), `MAX_STACKS_PER_GROUP 2` (XD-01 budget), `MAX_STACKS_HARD 4`, **`MAX_VENTED_BRANCH 12.0`** (`:20-36`, justified in the comment: IPC 912 + Table 704.1, 12 m at 1 % fall drops 120 mm = the depth at `WASTE_Z`).

1. **Grouping** (`:327-334`): fixtures grouped by `unitId` (a *dwelling column*, all its storeys) or, for common areas, by `${storey}|${wallId}`.
2. **Primary wet wall** — `primaryWall(group)` (`:262-298`): fixtures bucketed by `wallLineKey(f)` (`:51-56`, world-coordinate line identity `y:<v>` / `x:<v>` / `w:<wallId>`, so the same wet wall on several storeys collapses to one key). Best line by `lineScore` (`:59-64`) = `drained·10 + 6 if bath&kitchen + 3 if bath + fixtureCount`. On that line, the station (among the line centroid and each fixture's own station) covering the most fixtures inside their trap-arm limits. **There is no `stackAlong` field anywhere in the codebase** — the "along" position is this computed station (`stationOnLine`, `:67-79`; `stationXY(f, along, off)`, `:81-85`).
3. **Assignment loop** — `stationsForGroup(st, group, seed)` (`:103-194`): while fixtures remain unassigned, `nearestStation(stations, f, limitFor(f))` where `limitFor = maxTrapArm(spec.wasteD)` (`:307-309`) and `routedLength(f, xy)` is the **actual L-shaped developed length** `|f.offset - pr.offset| + |f.along - pr.along|` (`:316-319`, identical geometry to `branches.ts`).
4. **Second stack** (`:154-175`): `bestStationFor(pool)` (`:201-238`) — greedy cover over candidate stations (each wall line's centroid + each fixture's own station), tie-broken by `lineScore` then total branch length. Two warning variants:
   - if the fixture is within its limit *perpendicular* to the wall → `split:<type>` **"lavatory was 7.48 m from its dwelling's stack (e.g. …), over the 1.5 m trap-arm limit (IPC Table 1002.2); a second stack was added on its own wet wall"** (`:167-168`).
   - if the fixture is *off the wall* beyond the limit → `chase:<type>` **"lavatory sits 2.13 m off the wet wall (e.g. …), beyond the 1.5 m trap-arm limit; a local stack/chase was added at the fixture (architecture should move the fixture onto the wet wall — XD-01)"** (`:170-171`).
   Both `bump(st, 'trapArmSplits')`.
5. **Individually vented fallback** (`:131-152`): once `stations.length >= MAX_STACKS_PER_GROUP (2)`, a leftover reachable within `MAX_VENTED_BRANCH (12 m)` keeps the existing stack, gets `f.vented = true`, `bump('ventedFixtures')`, and warning `vented:<type>` **"washer is 2.93 m from its dwelling's stack (e.g. …), past the 1.5 m unvented trap-arm limit (IPC Table 1002.2); it is routed as an individually vented branch drain rather than opening another stack (architecture should move it onto the wet wall — XD-01)"** (`:138-139`). Past `MAX_STACKS_HARD (4)` or when `bestStationFor` returns null, everything left is force-assigned and marked vented, **silently** (`:143-149`, `:156-162`).
6. **Vertical clustering** (`:348-373`): grid buckets of `cell = 0.6`, cluster when within `ALIGN_TOL 0.3` and no storey collision → stacked identical dwellings share one riser.
7. **PLB-09 consolidation** (`:375-411`): two clusters within `MERGE_RADIUS 3.0` merge if a single station satisfies every trap-arm limit on both sides; `bump('stacksMerged')`, records a PLB-09 application.
8. **Emission** (`:425-561`): per cluster, `systemXY` places waste exactly on the station and the other pipes alternating ±`STACK_PIPE_SPACING 0.08` along `dir` (`:440-446`); `shaftId` set only if the XY falls inside a `plumbing`/`combined` shaft rect (`:448-451`); `wetWallId` omitted for virtual `VW-` walls (`:455`). Risers: **one `axis` element per storey per system**, `z = 0 → f2f`. Then the **vent alone** continues from the highest served storey to `topAboveIdx` (`:504-519`) and a `Vent through roof Ø75` 0.9 m above the roof slab (`:520-531`, IPC 904.1).
   `warn(st, 'nostacks', 'no plumbing stacks were generated (no wet-wall fixtures found)')` at `:564`.
`stackXY(si, system)` exported at `:569-571`.

### `branches.ts` — trap arms
`buildBranches(st, placed)` (`:37-160`). Per fixture with `spec.wasteD > 0`:
- `armLen = |f.offset - s.off| + |f.along - s.along|`, `limit = maxTrapArm(spec.wasteD)` (`:49-50`).
- `vented = !!f.vented || armLen > limit + 1e-3`; `diameter = vented ? max(wasteD, 0.075) : wasteD` (`:53-54`).
- Path (`:55-62`): at `detail 'low'` a 2-point run at `WASTE_Z`; otherwise fixture drop → perpendicular into the wall → along the wall to the stack. Named `Vented branch drain Ø…` / `Waste branch Ø…`, psets `TrapArmLength`, `TrapArmLimit`, `Vented`, `Slope: 0.02`.
- Warning `arm:<type>` **"trap arm 2.36 m on Ø50 exceeds the 1.5 m unvented limit (IPC Table 1002.2) at <roomId>; drained as an individually vented Ø75 branch (IPC 912)"** (`:80-83`).
- Supply branches at `DCW_BRANCH_Z 0.45` / `DHW_BRANCH_Z 0.55` rising to `spec.supplyZ` (`:89-112`).
- **Branch vents, one per (storey, room, stack) trap group** (`:115-143`) at `BRANCH_VENT_Z 1.5`, venting the fixture furthest from the stack.
- PLB-02 applications per stack with `worstTrapArm` (`:145-159`).
- `Slope: 0.02` is a **pset string only** — every pipe path is emitted at constant Z with no fall (see `routing.ts` below).

### `routing.ts` — the Manhattan / spine engine
`MAX_RUN_POINTS 12`, `ORTHO_SNAP 0.02`, `TRUNK_WALL_INSET 1.0`, `TRUNK_SOFFIT_DROP 0.35` (`:23-29`).
- `isOrthogonal(a,b)` (`:44-49`), `orthogonalize(path, snap)` (`:60-79`) — rounds first, collapses sub-`snap` deltas, inserts corners in x→y→z order so **every leg changes exactly one of x/y/z**. This is why **nothing is ever sloped**: a "fall" would be a diagonal and is structurally impossible in this emitter.
- `subdivideLong` (`:82-100`), `splitPath(path, maxPoints, maxLength)` (`:106-126`), `manhattanLink(a,b,prefer)` (`:129-140`).
- `interface Spine {kind: 'lane'|'trunk'; paths: Vec3[][]; z}` (`:146-152`).
- `laneSpine(corridors, lateral, z)` (`:155-163`) — one path per corridor, `lanePath` + `orthogonalize`.
- `barTrunk(bar, anchors, z, inset = 1.0)` (`:190-216`) / `trunkSpine(bars, anchors, z, inset)` (`:219-230`) — one trunk per bar along its long axis, 1 m inside the exterior wall on the side nearest its anchors, spanning the anchors' stations. Anchors go to `nearestBar` (`:172-180`).
- `spineAt(s, z)` (`:233-235`), `footOn`/`spineFoot`/`spineStation` (`:246-282`), `spineTap(s, p, z, zEnd?)` — two-leg L off the spine (`:288-294`), `spinePaths(s, z)` (`:297-299`), `streetLateral(s, target, z, lateralZ, streetY)` (`:305-312`).

### `service.ts` — building drain, sewer lateral, and the basement warning
`spineFor(st, storey, anchors, lateral)` (`:42-53`): corridors present → `laneSpine(corridors, lateral, bands.pipeZ)`; else `trunkSpine(barsOn(st, storey), anchors, trunkZ, 1.0)`. `mainZ` (`:56-58`).
`buildService(st, corridorSystems)` (`:60-273`):
- Meter room from `findPlantRoom(st, arch)` (`dhw.ts:251`, preference `water-room, mech-room, plant, utility, basement, garage, storage`); `nometer` warning if none.
- Water meter + `backflow-preventer` at `z 0.6`; `booster-pump` when `aboveGrade > 8` (PLB-12) (`:82-116`).
- Buried service from the street at `SERVICE_Z -0.9`, rising to 0.6 (`:120-137`).
- Horizontal mains per storey with stacks (`:164-231`): `spineFor(..., DEFAULT_LANES.pipe /*-0.35*/)`, DCW at `baseZ`, DHW at `baseZ - 0.12`, HWR at `baseZ - 0.2`; one run **per spine path** (never a polyline across the plate); L-shaped `spineTap` to each stack, ordered by `spineStation`.
- Ground main from the meter to the spine, or straight to the single stack for a house (`:234-265`).
- `buildBuildingDrain(st, room)` (`:276-360`): anchors = ground-storey stack waste XYs + ground floor drains; a collector exists only when `on.length >= 2 || drains.length >= 2`, at **`BUILDING_DRAIN_Z -0.55`** on the same spine geometry; `drainD = 0.2 / 0.15 / 0.1` by total DFU. Stack bases drop `WASTE_Z → BUILDING_DRAIN_Z` then tap the collector; floor drains drop from `-0.25`, skipped when their tap is > 30 m away (`:323`). Sewer lateral via `streetLateral(collector, streetTarget, -0.55, SEWER_Z /*-1.2*/, siteBounds.y)`, aiming at `meterOrNearestX` = the drainage anchor nearest the street (`:366-373`). Single-stack case handled at `:345-359`.
- **The basement warning** — `service.ts:268-271`:
  ```ts
  if (st.buildingStoreys.some(s => s.index < 0)) {
    warn(st, 'basement',
      `the building drain and the sewer lateral are modelled at ${ground} (z ${BUILDING_DRAIN_Z} / ${SEWER_Z}); fixtures in a basement below the sewer invert would need a sump and ejector pump, which is not modelled`);
  }
  ```
  Fires whenever **any** basement storey exists, regardless of whether there are fixtures down there. `ground = st.groundStorey` = first `index >= 0`, normally `L01`. Grep for `sump|ejector` across `src`: matches **only** in this one warning string and the corresponding PLB pattern text — no sump pit, no `IfcPump` ejector, no `IfcTank` basin, and `buildBuildingDrain` collects only `f.storey === ground` (`:279`), so **basement fixtures are simply not drained at all**, silently.

### `sprinkler.ts` (417 lines)
`MAX_SPACING 3.7`, `COVERAGE 15`, `WALL_CLEARANCE 0.1`, `MIN_GRID_AREA 3.0`, `MIN_HEAD_AREA 2.0`, `NO_HEAD_ROOMS` (`:17-25`). `sprinklersRequired(st)` (`:38-50`) — typology sprinklered, or above the storey/height trigger; else warning `nosprinkler`. `headRows(rect, area)` / `headGrid` (`:52-79`) → straight rows. `emitRoomPipework` (`:95-124`): branch line straight along a grid row, room mains at right angles, unit mains above the entry door (`doorPoint`, `:81-93`), corridor main on `laneSpine(corridors, DEFAULT_LANES.sprinkler /*-0.15*/, bands.sprinklerZ)` (`:276`) or the bar trunk, riser per stair core; `fdcPosition` (`:406`) for the fire department connection. Standpipes + hose valves (PLB-10).

### `storm.ts` (299 lines)
`AREA_PER_DRAIN 400`, `MIN_DRAINS 2`, `DOWNPIPE_D 0.1`, `STORM_MAIN_D 0.15` (`:20-23`). `plumbingShaftCorner(rect) = [rect.x + 0.15, rect.y + 0.15]` (`:31-33`) — **plumbing's shaft convention, defined here, not in core**. `buildStorm` (`:35-…`): roof drains at low points, downpipe anchors at plumbing/combined shaft corners + core corners `±0.3` (`:52-58`), buried storm main at `STORM_MAIN_Z -1.0`. Warnings `noroof` (`:45`) and `gutter` for pitched roofs (`:140`). `buildGas` (`:244-…`, `detail 'high'` only): one Ø20 riser in the plumbing shaft corner + a meter bank; warnings `nogas` (`:254`) and `gas` (`:296`).

### `dhw.ts` (266 lines)
`HEATER_ROOM_PREFERENCE` (`:21`), `PLANT_ROOM_PREFERENCE = ['water-room','mech-room','plant','utility','basement','garage','storage']` (`:26`). `buildDhw(st): DhwResult` (`:74-…`) — per-unit tank/tankless in the preferred closet (`heaterRoom`, `:37-45`; `cornerNear`, `:47-61`; `nearestStack`, `:63-72`), or central plant + HWR loop (`corridorSystems: ('dhw'|'hwr')[]` fed back into `buildService`). Warnings `noheater` (`:170`), `noplant` (`:177`), `hiu` (`:230`). `findPlantRoom` exported at `:251`.

### Where each plumbing warning originates (complete list — 20 sites, de-duplicated by key at `state.ts:221-225`)

| key | file:line | text (abridged) |
|---|---|---|
| `synth:<roomType>` | `fixtures.ts:229-231` | bathroom furniture missing; synthesised wc/lavatory/shower 0.4 m off the face |
| `synth:kitchen` | `fixtures.ts:254` | kitchen had no sink; synthesised one on the wet wall |
| `nowall:<type>` | `fixtures.ts:176-178` | no wet wall or room edge for `<type>`; fixture recorded but unpiped |
| `nobathwall:<storey>` | `fixtures.ts:192` | bathroom has no wet wall; no fixtures synthesised |
| `split:<type>` | `stacks.ts:167-168` | over the trap-arm limit; **a second stack was added on its own wet wall** |
| `chase:<type>` | `stacks.ts:170-171` | sits N m off the wet wall; **a local stack/chase was added at the fixture** |
| `vented:<type>` | `stacks.ts:138-139` | past the unvented limit; **routed as an individually vented branch drain** |
| `nostacks` | `stacks.ts:564` | no plumbing stacks generated |
| `arm:<type>` | `branches.ts:81-83` | **trap arm N m on Ø50 exceeds the 1.5 m unvented limit; drained as an individually vented Ø75 branch (IPC 912)** |
| `nometer` | `service.ts:74` | no ground-floor room for the water meter |
| `basement` | `service.ts:269-270` | **building drain / sewer lateral at L01 (z −0.55 / −1.2); basement fixtures would need a sump and ejector, not modelled** |
| `noheater` | `dhw.ts:170` | no water heaters could be placed |
| `noplant` | `dhw.ts:177` | no water/mech room for the central DHW plant |
| `hiu` | `dhw.ts:230` | heat-network DHW: HIUs are placed by mechanical |
| `nosprinkler` | `sprinkler.ts:133` | typology not sprinklered at N storeys |
| `noroof` | `storm.ts:45` | no roof outline; storm drainage omitted |
| `gutter` | `storm.ts:140` | pitched roof: eaves gutters assumed, not modelled |
| `nogas` | `storm.ts:254` | no plumbing/combined shaft for a gas riser |
| `gas` | `storm.ts:296` | fuel gas modelled minimally |
| `noarch` | `index.ts:43` | no architecture model; plumbing skipped |

### PLB-01 … PLB-12 (`plumbing/patterns.ts`)
| id | name | one-line intent |
|---|---|---|
| PLB-01 | One Stack per Dwelling Column | count stacks per dwelling not per wall; one stack on the busiest wet-wall line, five pipes in it, stacked dwellings share it |
| PLB-02 | Short Trap Arms | put the stack where the fixtures are; unvented arm within the Table 1002.2 limit; a second stack only when unreachable, then an individually vented branch |
| PLB-03 | Vent Through Roof | every waste stack paired with a vent past the highest fixture to 0.9 m above the roof |
| PLB-04 | Hot Water Close to the Tap | short dead legs; central plant gets an HWR loop with the circulator above storage temperature |
| PLB-05 | Sprinklers Where People Sleep | a head in every occupiable room on a coverage grid; straight branch lines; room → unit → corridor main → stair riser |
| PLB-06 | Roof Drains at Low Points, Downpipes at Cores | two outlets minimum at the low points; downpipes in core corners or the plumbing shaft corner, never through a dwelling |
| PLB-07 | Service Entry at the Street | water in perpendicular to the frontage below frost to meter → backflow → booster; the building drain mirrors it and leaves as an L |
| PLB-08 | Fixture Units Size the Pipe | WSFU → Hunter's curve → smallest nominal diameter under the design velocity, never below the code minimum |
| PLB-09 | Wet Rooms Share a Wall | kitchen backs onto bathroom across one 200 mm wet wall; neighbours share a chase |
| PLB-10 | Standpipes in the Stairs | wet standpipe in every exit stair corner from the FDC to the top floor, hose valve per floor once tall enough |
| PLB-11 | Pipes Below Ducts, Beside Trays | fixed lanes before anyone draws a run; a floor with no corridor gets one trunk per bar; a main never chains risers in id order |
| PLB-12 | Booster Above Eight Storeys | booster set downstream of meter/backflow above the threshold, risers zoned to the max working pressure |

---

## 7. `src/disciplines/electrical/*`

Files: `index.ts` (583), `devices.ts` (636), `panels.ts` (504), `placement.ts` (360), `region.ts` (198), `common.ts` (334), `internal.ts` (324), `catalog.ts`, `load.ts`, `circuits.ts` (208), `emit.ts` (244), `pv-ev.ts`, `patterns.ts` (269).

### `placement.ts` — geometry primitives (no floor-use awareness)
`RoomFace` (`:22-34`): inside face of one wall as seen from one room, oriented so `perp(dir)` points into the room, so `rotation` is directly usable as a `box` rotation. `roomFaces(room, wallById, minLength = 0.25)` (`:56-117`) accepts both upstream conventions (room polygon already the inside face, or wall centreline on the polygon edge) and falls back to an "open edge" face with `wallId: ''`. `openingSpan` (`:125-132`), `blockedSpans(face, doors, windows, wallById, maxSill = 0.45)` (`:135-156`), `mergeSpans`, `freeSpans(length, blocked, minLength = 0.6)` (`:171-180`), `spacedPositions(L, maxSpacing)` — NEC 210.52(A) (`:186-192`), `runPositions(L, spacing, min)` (`:195-201`), `anchorOnFace` (`:203-206`), `nearestFace(faces, p, minLength, margin)` (`:212-224`), `bestFreeSpan(faces, blockedFor, need, prefer?)` (`:227-241`), `ceilingGrid(rect, n, inset = 0.6)` (`:248-268`), `alongLongAxis` (`:271-277`), `alongPolyline` (`:280-295`), `polylineLength`, `closestOnPolyline` (`:304-323`), furniture helpers `furnitureQuad`/`furnitureCenter`/`backEdge`/`furnitureRun` (`:330-360`).

### `region.ts` — code presets
`ElecRegionPreset` (`:28-71`): `{region, code, receptacleCode, service: ServiceVoltage, serviceV, phases, serviceVoltageIndex, unitService, unitServiceV, branchV, applianceV, ring, earthLeakName, panelName, smallApplianceCircuits, laundryCircuitVa, generalLightingVaPerM2, maxReceptacleSpacing, maxReceptacleReach, counterSpacing, caps: Record<RoomGroup,ReceptacleCap>|null, coAlarmAlways, unitPanelAmps(bedrooms, isHouse)}`.
`necBase` (`:83-110`, 3ph at ≥ 6 dwellings, 33 VA/m², 3.6 m spacing / 1.8 m reach / 1.2 m counter, `caps: null`), `bsBase` (`:112-145`, ring finals, socket caps living 4-8 / bedroom 3-5 / kitchen 6-8 / circulation 1-2 / other 1-4), `asBase` (`:147-159`). `elecRegion(region, unitCount, force3ph)` (`:165-179`). `MAX_SINGLE_PHASE_AMPS = 400` (`:182`). `roomGroupOf(roomType)` (`:184-198`) — `living|bedroom|kitchen|circulation|other`.

### `panels.ts` — panels, trays, risers, feeders
- `placeUnitPanel` (ELE-02) — `PANEL_PREFERENCE: RoomType[] = ['hall','entry','utility','laundry','storage','den','study','basement','garage']` (`:29`); warning at `:70` if no eligible wall.
- `placeServiceEquipment` (ELE-01) — room order `['elec-room','mech-room','plant','water-room','utility','storage','lobby','garage','basement']` (`:81`); warnings at `:118` and `:183` (meter banks don't fit).
- `placeFloorDistribution` (`:…-283`) — one `floor-distribution` board (225 A, 12 circuits) per storey, on a corridor / lift-lobby / lobby face **nearest the shaft centre** (`ref = shaft ? rectCenter(shaft.rect) : rectCenter(corridor.rect)`, `:263-265`), nudged clear of blocked spans.
- `elecShafts(ec)` (`:285-287`) — `purpose === 'electrical' || 'combined'` **only** (stricter than mechanical, which filters not at all).
- `buildTrays(ec): TrayResult` (ELE-07, `:299-357`): per storey, corridor centrelines (or `rectSpine(room.rect)` fallback, `:359-363`); `bands = plenumBands(st.height, slabT, beamDepthFor(...), ceiling)`; **power tray** `lanePath(segs, DEFAULT_LANES.tray /*+0.35*/, bands.trayZ)` 300×100, **data tray** at `+0.50` 200×50; one `axis` element per leg, `IfcCableCarrierSegment CABLETRAYSEGMENT`, `system: 'POWER-LV'` / `'DATA'`. `laneByStorey` records the power lane for feeders. `beamDepthFor` (`:365-369`) — `struct.plenumClearance.corridorSoffitZ` first, else `struct.sizes.beamD ?? 0`.
- `buildRisers(ec)` (ELE-12/XD-04, `:375-416`): per electrical/combined shaft, `xy = [rect.x + rect.w - 0.15, rect.y + rect.h - 0.15]` (**world max corner**, `:385`); `type = storeys > 6 ? 'busduct' : 'cable-riser'`, 0.3 × 0.2; one `axis` element per storey `z = 0 → st.height`.
- `buildFeeders(ec, lanes, panels)` (`:422-457`): per unit panel, `closestOnPolyline(lane, entryDoorPoint)` → horizontal leg to the panel XY at tray Z → vertical drop to the panel top; Ø32 conduit, `IfcCableCarrierSegment CONDUITSEGMENT`. Skipped at `detail 'low'`.
- `placeEvPanel(ec, chargerCount, near, storey)` (`:463-480`): looks for `room.type === 'parking' || 'garage'`, puts the EV panel on its best free wall span; amps `max(100, ceil(chargers·40·0.5 / 50)·50)` (50 % diversity, NEC 625.42).
- `placePvEquipment(ec, kwDc, zone)` (`:482-500`): combiner + inverter beside `arch.roof.plantZone`.

### Per-floor-use differences
All keyed on `RoomType`, never `FloorUse`:
- `devices.ts:416-419` — **`case 'parking':`** ceiling lights on a grid at 1 per 81 m², inset 1.5.
- `devices.ts:452-454` — `NO_LOCAL_SWITCH = {corridor, lobby, lift-lobby, shaft, elevator, parking}`.
- `devices.ts:543` — parking included in a set (with garage, mech-room, plant, elec-room, trash) — heat detection rather than smoke (ELE-06).
- `devices.ts:146` — GFCI/RCD trigger set includes `mech-room, water-room, basement`.
- `devices.ts:31-35` — receptacle density class per room type: `'full'` (lounge, shared-living, dining-hall, amenity, gym, basement) vs `'one'` (terrace, porch, storage, mech-room, elec-room, water-room, lobby, lift-lobby, mail, bike-store).
- `catalog.ts:164-170` — lux targets: `parking: 75`, `mech-room: 200`, `elec-room: 200`, `amenity: 200`.
- `common.ts:206-218` — one 6 m light pole per 20 surface stalls, on `lot.storey`.
- `pv-ev.ts:65` — EV chargers from `ctx.site.parking` spaces flagged `type === 'ev'`.
- **No retail-specific electrical anywhere** (`'retail'` never appears in the electrical discipline).

### `circuits.ts` (208 lines)
`config(ec, type, va)` (`:20-57`) — per-`Circuit['type']` `{amps, volts, maxDevices}`, ring vs radial. `ORDER` (`:59-63`) fixes schedule order. `groupByWant` (`:65-75`) uses each device's `extraOf(ec, d.id).want`. `circuitCount` (`:83-104`) — lighting from `load.generalLightingVa · 0.4`, general receptacles from `· 0.6` (or `area/100` for rings), small-appliance from `region.smallApplianceCircuits`. `emit` (`:106-141`) round-robins devices into buckets and writes `d.circuitId`. `buildCircuits(ec, targets, loads)` (`:152-208`) — per-unit then house/common (EV → `evPanel`, PV → `pvCombiner`, else `houseFallback`), plus one dedicated elevator feeder each at 20 kVA.

### ELE-01 … ELE-13 (`electrical/patterns.ts`)
| id | name | one-line intent |
|---|---|---|
| ELE-01 | Service at the Street, Meters at the Entrance | one buried lateral at 0.8 m cover to a ground switchroom near the entrance; meters in banks of six; pad-mount transformer above 600 A |
| ELE-02 | One Panel per Dwelling in the Hall | one panelboard per dwelling in the entry hall/utility, bottom at 1.2 m, never in a bathroom/bedroom/closet/kitchen |
| ELE-03 | No Point Farther Than Six Feet | walk every wall space; no point > 1.8 m from an outlet, never > 3.6 m apart, at 0.4 m; socket minima in BS/AS regions |
| ELE-04 | Kitchen Counter Circuits | two 20 A small-appliance circuits alternating, outlet every 1.2 m at 1.1 m, all GFCI; dedicated appliance circuits; under-cabinet task light |
| ELE-05 | Switch at the Latch Side | one switch inside every room on the latch side, 0.15 m clear, at 1.2 m; three-way for two-entry rooms; dimmer in living |
| ELE-06 | Alarms Where People Sleep | interconnected smoke in every bedroom, outside sleeping areas, per level; corridors every 15 m; CO per dwelling; heat detection in garages/plant |
| ELE-07 | Corridor Tray Spine | tray spine 0.35 m off the corridor centreline opposite the wet pipes, data tray 0.15 m outboard; feeder drops above each entry door |
| ELE-08 | Emergency Light the Way Out | exit sign at 2.3 m on every exit/stair door; emergency luminaires every 15 m on a life-safety circuit with 90 min autonomy |
| ELE-09 | Sun on the Roof | fill the PV zone clear of plant and parapet, 0.5 m row gaps, combiner + inverter beside the plant zone, capped at building demand |
| ELE-10 | Charge Where You Park | charger at every EV-ready stall and private garage, dedicated EV panel, 50 % diversity, spare conduit to the rest |
| ELE-11 | Demand not Connected Load | NEC 220.82 per-dwelling demand, then the 220.84 multifamily factor, plus house load at 100 %, rounded to a standard frame |
| ELE-12 | Risers at the Core | vertical distribution up the electrical/combined shaft on its far corner (mech centre, plumbing near corner); busduct above six storeys; floor board per level |
| ELE-13 | Light by Task not Watts | lux target per room → fixture count from delivered lumens at 0.7 utilisation, min one per 6 m²; placement by task; under 5 W/m² |

---

## 8. `src/disciplines/site/*` — massing, parking, cores

### Storey validation against typology max — **warning only, no clamp**
`src/disciplines/site/massing.ts:312-319`:
```ts
const storeysAbove = spec.massing.storeys;
if (storeysAbove > typology.storeys.max) {
  warnings.push(`${storeysAbove} storeys exceeds the typology maximum of ${typology.storeys.max} for ${typology.name}.`);
}
if (storeysAbove < typology.storeys.min) {
  warnings.push(`${storeysAbove} storeys is below the typology minimum of ${typology.storeys.min} for ${typology.name}.`);
}
```
`storeysAbove` is used unchanged from there on. The **only** clamp in the storey path is `normalizeSpec`: `clamp(input.massing?.storeys ?? t.storeys.default, 1, 60)` (`src/core/spec.ts:18`) — a global 1..60, not the typology band. For `courtyard-block`: `storeys: {min: 4, max: 8, default: 6}`, `name: 'Courtyard / perimeter block'` (`core/typologies.ts:247-254`), which reproduces the exact warning text verbatim. Downstream, exceeding the max silently changes the structural system (`structuralSystemFor(typology, 15)` → `rc-flat-plate-core` at > 12, `typologies.ts:451`), the foundation (`foundationFor` → `piles`), and turns on the slab-thickness mismatch (0.20 vs 0.25).

Other massing warnings (31 `warnings.push` sites in `massing.ts`): storeys below min (`:318`), depth/length clipped by envelope (`:330, :334`), courtyard below 15 m → degraded to U (`:611`), U → L (`:626`), L → bar (`:636`), T → bar (`:645`), point plate side reduced (`:587`), `impliedUnitDepth` outside 6.5–14 m (`:427, :429`), height over `maxHeight` (`:448`), ADU separation (`:461, :464`), street wall < 70 % (`:490`), FAR / coverage over the cap (`:536, :539`), footprint clipped (`:541`), row dwellings outside the typology's `unitsPerFloor` band (`:792`), point core too shallow for a dog-leg stair (`:910`), point plate travel over limit (`:933`), cores don't fit in the corridor length (`:956`), core straddles the corridor (`:1004`), exits under the required separation (`:1020`), travel distance over the limit (`:1056`). **Every one is advisory; only `decompose` actually degrades geometry (O → U → L → bar, T → bar).**

### Parking demand vs capacity — **warning only, no adaptation**
`src/disciplines/site/parking.ts:54-241` `buildParking(spec, typology, frame, m, mainEntrance, rng, ids, warnings): ParkingResult`.
- Demand: `required = type === 'none' ? 0 : ceil(units · ratio)` where `units = m.estimatedUnits` and `ratio = spec.site.parking?.ratio ?? typology.parkingRatio` (`:65-72`). `bikeSpaces = ceil(units · bikeRatio)`.
- Dispatch by `type` (`:86-119`): `garage-attached` → `buildGarages`; `podium`/`underground` → `structuredParking`; `surface` → `surfaceParking`; `none` → nothing.
- **Structured** — `structuredParking(...)` (`:379-425`): finds the first `spec.floors` entry with `use === 'parking'` (basement for `underground`, ≥ 0 for `podium`); `outline = floor.index < 0 ? frame.env : (m.podiumRect ?? m.footprintRect)`; `zone = outline` inset 0.4; one `RAMP_W 3.5 × RAMP_L 12.0` ramp at the zone's max corner; `packZone(zone, required + 12, ceil(required·0.05), evEvery, storey, ids)`; stalls fouling the ramp dropped, then `.slice(0, required)`. Then:
  ```ts
  if (clear.length < required) {
    warnings.push(`Structured parking on ${storey} fits ${clear.length} of ${required} spaces in a ${zone.w.toFixed(1)} × ${zone.h.toFixed(1)} m plate (SIT-07).`);
  }
  ```
  (`parking.ts:406-408`) — the "Structured parking on B1 fits 110 of 222 spaces" message. **It uses exactly one parking storey**; `floors.find(...)` picks the first matching floor and the rest are ignored.
- **Building-level shortfall** — `parking.ts:130-135`:
  ```ts
  const achieved = spaces.length;
  if (required > 0 && achieved < required) {
    warnings.push(`Parking: ${required} spaces required (${units} units × ${ratio}), ${achieved} achieved (${note}).`);
  }
  ```
  — the "Parking: 222 spaces required (277 units × 0.8), 110 achieved" message.
- **Adaptation mechanisms that exist:** exactly one — `podium`/`underground` with no `use: 'parking'` storey falls back to **surface** parking with a warning (`:104-111`). Surface packing prefers rear/side over front and warns if it has to use the front yard (`:287`). `buildGarages` warns if fewer garages than dwellings fit (`:489`).
- **Adaptation mechanisms that do NOT exist:** no adding basement levels, no reducing the required ratio, no reducing unit count, no stacking/mechanical parking, no spreading across several parking storeys, no feedback into `spec.massing.basementStoreys`. `basementStoreys` is fixed in `normalizeSpec` at `spec.ts:47`: `input.massing?.basementStoreys ?? (t.parking === 'underground' ? 1 : 0)` — **one basement, always**.
- `packZone(zone, want, accessibleLeft, evEvery, storey, ids)` (`:310-367`): double-loaded 16.8 m modules (`2·STALL_L + AISLE`), then one single-loaded module if `≥ STALL_L + AISLE` remains; 5 % accessible at 3.6 m, every `round(1/evShare)`-th standard stall flagged `ev`. `capacityOf(r)` (`:295-304`) ranks candidate yards.
- Elements: one `prism` `IfcSpace PARKING` per stall + ~40 % cars as `box IfcFurnishingElement` (capped at 120, `:162`), paving slabs (`pavingElement`, `:568-583`), `ramp` for structured decks, bike racks.
- `site/index.ts:103-107` publishes `parkingSpaces`, `parkingRequired`, `evSpaces`, `accessibleSpaces`, `bikeSpaces`; `:138` `parkingRatioAchieved`. The metric `parking-ratio` reads these.

### Core counting and placement — `massing.ts:856-1059` `placeCores(...)` + `:1077-1198` `placeStairCores(...)`
Constants: `CORE_END_CLEARANCE 6.0`, `CORE_STAIR_BAY 2.6`, **`CORE_SHAFT_BAY 2.4`** (the XD-04 service shaft bay, *inside* the core rect), `CORE_WIDTH_ALONG_BAR = 2.6 + 2.4 = 5.0`, `LIFT_BANK_DEPTH 2.3`, `LIFT_LOBBY_DEPTH 1.2`, `RISER_MAX 0.175`, `STAIR_LANDING 1.2`, `LANDING_STAIR_CORE 2.4`, `LANDING_MANSION 2.6`, `POINT_CORE_W 9.0`, `POINT_CORE_D 7.0`, `TRAVEL_SPRINKLERED 76.0`, `TRAVEL_UNSPRINKLERED 61.0`, `SINGLE_EXIT_MAX_UNITS 4`, `SINGLE_EXIT_MAX_STOREYS 3` (`massing.ts:45-72`).

- `access === 'direct'` → **zero cores** (`:870-877`).
- `elevatorTotal = typology.elevator ? max(1, ceil(max(estimatedUnits/60, storeys/8))) : 0` (`:879-881`).
- `stairRunFor(f2f)` (`:98-103`) and `coreAcrossFor(f2f, hasElevator)` (`:105-108`) size the core across the bar (dog-leg stair + lift bank + lift lobby).
- `access === 'point-core'` (`:888-935`) → **one** core at the plate centre, `(POINT_CORE_W + CORE_SHAFT_BAY) × POINT_CORE_D` = 11.4 × 7, clipped to `bar.rect − 2`; `scissor-stair` above 12 storeys; `elevatorCount = clamp(elevatorTotal, 2, 3)`.
- `access === 'stair-core'` → `placeStairCores(...)` (`:1077-1198`), one core per repeating **module of frontage**: `module = coreAlongBar + landing + unitsAlong × frontage` (doc comment `:1064-1075`).
- **corridor / gallery / cluster** (`:943-1058`) — **this is the "core count from frontage" rule**:
  ```ts
  const totalLength = bars.reduce((s, b) => s + b.length, 0);
  const singleAllowed = unitsPerFloor <= 4 && storeys <= 3 && totalLength <= 2 * travelLimit;
  const override = spec.massing.coreCount;
  let total = override > 0 ? override
            : singleAllowed ? 1
            : Math.max(2, Math.ceil(totalLength / travelLimit), Math.ceil(unitsPerFloor / 12));
  const fits = Math.max(1, Math.floor(totalLength / 10));  // a core needs ~10 m of corridor
  if (total > fits) { warnings.push(`${total} cores do not fit in ${totalLength} m of corridor; reduced to ${fits} (SIT-08).`); total = fits; }
  ```
  (`:944-959`). Then `allocate(total, bars.map(b => b.length))` (`:1249`) distributes cores across bars by length; `alongPositions(bar.length, n, CORE_END_CLEARANCE)` (`:1199`) places them, relaxed to 2.0 m clearance if the IBC §1007.1.1 separation (`diagonal × 1/3` sprinklered, `1/2` unsprinklered) is not met (`:978-986`). Each core alternates side of the corridor, preferring the wider band, never a band < 4.0 m; if neither band fits, the core **straddles the corridor** with a warning (`:997-1005`). `coreRect(bar, along, acrossLen, acrossStart)` (`:1234-1247`) clips both dimensions to the bar. Records `SIT-08` + `XD-04` applications (`:1028-1054`).

### Footprint shapes — `decompose(...)` (`massing.ts:566-647`)
- `point` → a square of side `min(depth, env.w, env.h)` centred in the envelope (`:584-589`).
- `bar` → one rect `{x0, placeY, blockW, depth}` (`:579-582`).
- `O` (`:598-617`) → front + left + right + rear bars of `depth`, courtyard = `inset(envelope-block, depth)`; requires `min(court.w, court.h) >= MIN_COURTYARD 15.0` **and** `sideLen = env.h - 2·depth >= depth`, else **degrades to U** with the warning at `:611` and a `SIT-03` application recording `degraded: 'U'`.
- `U` (`:619-628`) → front + two wings; requires `wingLen >= max(MIN_WING 6.0, depth)` and `blockW - 2·depth >= MIN_U_OPENING 8.0`, else **degrades to L** (`:626`).
- `L` (`:630-638`) → front + one wing on a random side (`rng.pick`); requires `wingLen >= minWing && blockW - depth >= MIN_WING`, else **bar** (`:636`).
- `T` (`:640-646`) → front + a central wing; requires `blockW - depth >= 2·MIN_WING`, else **bar**.
- `exteriorSidesOf(r, all)` (`:663-680`) — a side stays exterior when < 95 % shared.
- `MassingBar.axis` comes from the decomposition, not from which side is longer (`:358-367`).

### Corridors — `buildCorridors(bars, access, width, footprintCentroid, ids)` (`massing.ts:815-848`)
`CORRIDOR_ACCESS = ['corridor-double','corridor-single','gallery','cluster']` (`:804`). Double-loaded / cluster corridors at `bar.depth / 2`. Single-loaded / gallery spines **hard against the long face away from the street** (or away from the courtyard): `offset = outwardSign < 0 ? bar.depth - width/2 : width/2`, clamped (`:830-838`); `loaded` derived from `cross(dir, bandNormal)`. One `CorridorSpine` per bar.

Other massing outputs: `plateOutline = rectilinearOutline(rects)`, podium fills the envelope when `podiumStoreys > 0` (`:377-383`), `foundationDepth = foundation === 'piles' || 'raft' ? 2.0 : 1.2` (`:388`), `storeys = buildStoreys(spec, spec.floors, foundationDepth, spec.region)` (`:389`), GFA per floor with podium area vs plate area (`:399-405`), `estimatedUnits = access === 'direct' ? dw.count : max(1, round(residentialGfa / GFA_PER_UNIT /*106.25*/))` (`:407-409`), `impliedUnitDepthFor(access, depth, corridorWidth)` (`:686-701`), `dwellingsAcross(...)` (`:759-798`).

### `site/index.ts` — assembly + self-checks
`generateSite(spec, typology, rng, warnings): SiteModel` (`:44-161`): frame → massing → entrances → parking → landscape → site pad/existing house → `derived` (~45 numbers, `:91-139`) → `validate(model, frame, m, warnings)` (`:222-277`). `validate` checks: non-finite geometry/metrics, footprint inside boundary, bars inside boundary and non-overlapping, cores contained in their bar, corridors referencing known bars, parking spaces inside boundary and (structured) inside the envelope, duplicate ids, and `storeys.length < 3`. All warnings, never throws.

Patterns `SIT-01 Setbacks and Yards` · `SIT-02 Building Faces the Street` · `SIT-03 Courtyard Which Lives` · `SIT-04 South-Facing Garden` · `SIT-05 Back-of-Lot Dwelling` · `SIT-06 Active Street Wall` · `SIT-07 Parking Behind` · `SIT-08 Two Ways Out` · `SIT-09 Bar Depth from Unit Depth` · `SIT-10 Trees and Ground` · `SIT-11 Entrance Transition` · `SIT-12 Hierarchy of Open Space`.

---

## 9. `src/core/patterns.ts` (PatternBook) and `src/core/metrics.ts`

### `PatternBook` — `core/patterns.ts:10-35`
```ts
class PatternBook {
  private patterns = new Map<string, Pattern>();
  private applications: PatternApplication[] = [];
  register(...patterns: Pattern[]): void       // throws on id collision (:16-18)
  apply(app: PatternApplication): void         // throws if the id is not registered (:24-26)
  get(id): Pattern | undefined
  all(): Pattern[]
  byDiscipline(d: Discipline | 'cross'): Pattern[]
  trace(): PatternApplication[]
  merge(apps: PatternApplication[]): void
}
```
Used once, in `pipeline.ts:25-26` (register all 7 sets) and `:79-82` (replay every application, pushing a warning instead of throwing for an unknown id). Total pattern count: 12 SIT + ARC-nn + 11 STR + 12 MEC + 12 PLB + 13 ELE + 5 XD.

**Parameter model**: `PatternParameter{value: number|string|boolean; unit?: string; source?: string}`. `value` is often a *prose* string (`'40–70 by region'`, `'balcony → roof plant zone → rear ground pad'`, `'typology.hvac'`, `'0.10–0.25'`), so parameters are **documentation, not a machine-readable rule set**. `source` is a free-text convention: `'typology'`, `'spec (site.parking.evShare)'`, `'code:IPC 2021 Table 1002.2'`, `'default'`, `'XD-02'`, `'core/coordination.plenumBands'`, `'Alexander APL #144'`, `'physics (ρgh, 3.05 m)'`, `'SIZES.coreWallT'`. **Nothing reads `parameters` at runtime** — the real values are duplicated as module constants (e.g. `MAX_VENTED_BRANCH = 12.0` in `stacks.ts:36` vs `maxVentedBranchDrain: {value: 12.0}` in `patterns.ts:44`). Verified: no `.parameters[` access outside `patterns-view.ts`.

**App display** — `src/app/patterns-view.ts:12-59`: Patterns tab, grouped by `DISC_ORDER = [cross, site, architecture, structure, mechanical, plumbing, electrical]`, header strip with `N registered / N applied / N applications / ▲ N never applied`, text filter over id+name+problem+solution+references+parameter keys (`:27-28`). `patternRow` (`:62-…`) renders Problem, Solution, a read-only Parameters table (Name / Value / Unit / Source), Depends on, References, and up to 20 applications (Storey / Unit / Elements / Parameters / Note). **Entirely read-only.** `src/app/form.ts` edits only `BuildingSpec` paths (`data-p` attributes such as `massing.storeys`, `site.parking.ratio`, `massing.podiumStoreys`) plus per-floor `FloorSpec` fields — **there is no UI anywhere for editing a rule, a pattern parameter, a `SIZES`/`MOUNTING` constant, or a lane offset.**

### `core/metrics.ts` (975 lines) — how a metric reads models
- `METRICS: MetricDef[]` (`:80-267`) — 30 definitions, ranks 1..20 headline then supplementary, each with `altNames` per region, `unit{metric,imperial,factor}`, `description`, `formula` prose. `getMetric(id)` (`:269-273`).
- `computeMetrics(model): MetricResult[]` (`:551-570`): `buildContext(model)` once, then `computeOne(def, ctx)` per definition inside a `try/catch` that degrades to `{value: 0, display: 'n/a', status: 'warn', note: 'unavailable (…)'}`. **Never throws, never returns NaN** (doc comment `:9-13`).
- `Ctx` (`:310-346`) pre-computes siteArea/siteHa, footprintArea, gia, giaByStorey, nia, units, bedspaces, circulationArea, extWallArea, windowArea, openSpace, balconyArea, parkingSpaces, height, wwr, dualAspectShare, familyShare, egress, egressLimit, plus a `missing: Set<MetricId>`.
- **Reading strategy** — `derived(source, ...keys)` (`:280-288`) takes the first finite value among several plausible key names in a discipline's `derived` map, falling back to a recomputation from the raw model arrays, then to 0. E.g. `derived(site?.derived, 'siteArea', 'area') ?? site?.area ?? spec.site.width * spec.site.depth` (`:352-355`). `metrics.test.ts:399` asserts "discipline derived maps win over the recomputation".
- Benchmarks: `EUI_BASE` per region (`:30`), `COST_BENCHMARK` per region (`:33-40`), `EMBODIED_BY_SYSTEM` per structural system (`:43-51`), `EGRESS_LIMIT {sprinklered 76, unsprinklered 61}` (`:54`), room-set constants (`:56-67`).
- Status flags come from zoning caps and thresholds (`metrics.test.ts:358`), e.g. `setback-compliance` = `min(achieved − required)` over front/side/rear (`:938-943`).

---

## 10. Tests

| file | lines | what it asserts (coordination-relevant items in bold) |
|---|---|---|
| `src/disciplines/structure/structure.test.ts` | 588 | 17 tests: non-empty/finite/unique per fixture; system+foundation+transfer follow typology & height; **columns inside outline, never inside a core, sizes step down**; **column height = f2f − slab above**; one slab per storey + ground/roof, **openings follow shafts**; struct walls reference real arch walls and never duplicate geometry; foundations exist and honour the footing z convention; grid spacing in the economic band, labels unique; beams under the soffit, headers only over wide openings; **`plenumClearance.corridorSoffitZ > 2.0`, `<= typicalF2f`, `== derived.corridorSoffitZ`, `structuralDepthAtCorridor >= slabT` (`:365-375`) — the single structure↔MEP coordination test**; embodied carbon plausible; pattern refs resolve with concrete params; deterministic + tower fast; **podium uses the parking module and dwellings above the party-wall grid**; every system × detail coherent; **integration site → architecture → structure per preset** (`:511`); standard psets. **No load-path / column-lands-on-column / cantilever test.** |
| `src/disciplines/mechanical/mechanical.test.ts` | 593 | per-system matrix (6 systems × 6 assertions): coherent model, every habitable room served & every wet room extracted, equipment/terminals inside their room, **duct geometry stays in the ceiling plenum band (`:165`, `:552`)**, **risers inside shaft rects and per storey (`:189`)**, roof plant inside the plant zone. Then per-system specifics; **corridor make-up air on the duct lane with a diffuser every 9 m (`:322`, comment at `:330` confirms `DEFAULT_LANES.duct = 0` → duct on the centreline at y = 13)**; **"mechanical risers take the shaft centre (plumbing/electrical get the corners)" (`:343`) — the closest thing to a shaft-slot contract test, and it only checks mechanical's own claim**; loads follow region & occupancy; stair pressurisation only above 23 m; houses put condensers on a ground pad; houses with no shaft discharge through the wall; detail caps element count; pattern book well formed; perf 150 ms / 2 s; **integration site → arch → struct → mech (`:529`, skipped unless `UPSTREAM_READY`)**. |
| `src/disciplines/plumbing/plumbing.test.ts` | 1074 | 33 tests: complete model; needsWater furniture → fixtures with right connections; **one stack per dwelling column aligned across storeys (PLB-01, `:121`)**; per-storey risers + vent through roof; **every fixture drains within the trap-arm limit (PLB-02, `:194`)**; sprinklers cover every habitable room + corridor; storm drains at low points; service sized from fixture units; DHW per dwelling / central + HWR; booster above 8 storeys; **synthesises bathroom fixtures when architecture furnished nothing (`:366`)**; falls back to a nearby wet wall when `wetWallIds` is empty; detail density; gas only at detail high; totals consistent; clean geometry; pattern book complete; perf < 200 ms; degrades with no arch / no struct+mech; single storey; gable gutters; house hose bibbs; **no corridors → trunk per bar not a spine through the stacks (`:608`)**; detail low still connects every fixture; **every pipe leg Manhattan, height changes their own leg (PLB-11, `:693`)**; **mains follow the corridor lane or one trunk per bar (`:717`)**; straight sprinkler branch lines; deterministic; **3 integration tests across all presets (`:830`, `:948`, `:1042`)** incl. Manhattan/run-cap/element-budget checks. Comment at `:556`: "corridor mains still land in the plenum, using the default slab/beam assumptions". |
| `src/disciplines/electrical/electrical.test.ts` | 542 | 26 tests: unique/no-NaN; ELE-03/05/13 per habitable room; receptacles on a wall face inside their room; ELE-04 kitchen counter GFCIs; ELE-06 alarms; ELE-02 one panel per dwelling never in a bathroom/bedroom/kitchen; ELE-01 service + meters + lateral; ELE-08 every exit/stair door signed; **ELE-07/XD-02 tray spine on the corridor lane of every storey (`:209`)**; **ELE-12/XD-04 riser per storey inside an electrical shaft (`:236`)**; ELE-10 charger per EV stall; ELE-09 PV fills ≥ 60 % of the zone; ELE-11 demand < connected, standard service size; circuits reference existing panels/devices; psets/systems/patterns present; pattern book aligned; detail scaling; UK ring finals + socket minima; works without struct/mech/plumb; 20-storey busduct + fast; empty arch degrades; perf < 300 ms; **"no warnings for the reference fixture" (`:446`)**; **2 integration tests (`:461` full chain, `:527` every element reaches the IFC file)**. |
| `src/disciplines/site/site.test.ts` | 602 | 17 tests: pattern book covers SIT-01..10 + every id the typologies reference; per-preset valid site model; determinism; **ie-courtyard courtyard ≥ 15 m clear (`:259`)**; ca-point-tower podium + tower + one core; **us-5-over-1 two cores + double-loaded spine (`:301`)**; us-detached garage/driveway/garden; **uk-terrace `'unit'` entrance count equals architecture's house-count formula (`:354`) — a real site↔architecture contract test**; au-walkup 2–3 stair cores no lift; **uk-mansion exactly two cores each big enough for a dog-leg stair, a lift and the shaft bay (`:424`)**; ca-laneway ADU behind a notional house; us-senior L plan with a core per wing; `coreCount` override + SIT-08 reporting; **every core sits inside its own bar (`:504`)**; deck-access spine hugs the far face; 22-storey podium tower < 300 ms; every typology × shape sane. **No test asserts that storeys ≤ typology max, or that parking achieved == required.** |
| `src/core/metrics.test.ts` | 567 | 11 tests: `METRICS` covers every `MetricId` once with ranks 1..20 then supplementary; one finite result per definition; headline numbers computed from the model arrays; unit strings follow `displayUnits`; zoning caps drive status flags; **discipline `derived` maps win over recomputation (`:399`)**; circulation ratio adds cores and falls back to floor-plan corridors; empty model → finite zeros + `unavailable` notes, never NaN; breakdowns in display units; embodied carbon A1–A5; every region complete. |
| others | | `src/app/{export,form,render,svg,util}.test.ts`, `src/ifc/{writer,validate}.test.ts`, `src/disciplines/architecture/{architecture,unit-layout}.test.ts` |

**There is no dedicated cross-discipline coordination test file.** No test asserts: that two disciplines' runs do not intersect in 3D; that plumbing/electrical/mechanical risers in the same shaft have distinct XY; that a duct and a pipe on the same corridor are at different Z; that a column above lands on something; that MEP is under a slab; or that the slab thickness MEP assumes matches the one structure built.

---

## 11. Assessment — root cause per warning family, and what must change

### A. Typology max storeys exceeded
**Root cause.** `spec.massing.storeys` is a free user input clamped only to `[1, 60]` (`core/spec.ts:18`), while `typology.storeys` carries a `{min, max, default}` band that is **compared but never enforced** (`site/massing.ts:314-319`). The typology band is meant to describe a *form* ("stair-core walk-up, no lift, 4 storeys"), but the generator then silently switches the structural system (`typologies.ts:447-452`), foundation, and slab thickness, producing a "courtyard block" that is structurally a high-rise flat-plate tower.
**To eliminate by construction.** This is a **spec-validation** problem, not a discipline problem. Options, in order of how honest they are: (1) clamp in `normalizeSpec` (`core/spec.ts:18`) to `clamp(storeys, t.storeys.min, t.storeys.max)` and report the clamp as a resolved-value note rather than a warning; (2) when the request exceeds the band, **switch typology** (e.g. `courtyard-block` → `slab-tower`/`podium-tower`) and say so; (3) keep the band as a soft constraint but make the downstream consequences explicit and validated. Modules to change: `src/core/spec.ts` (`normalizeSpec`, `resolveFloors`), `src/core/typologies.ts` (a typology-selection function), `src/disciplines/site/massing.ts:312-319` (drop the warning). Nothing else consumes the band.

### B. Parking shortfall
**Root cause.** Three independent facts, none of them reconciled:
1. `required` is computed from `m.estimatedUnits` **after** the massing is fixed (`parking.ts:69-71`) — demand is an output of massing, not an input to it.
2. Capacity is computed from **one** parking storey, chosen as `spec.floors.find(f => f.use === 'parking')` (`parking.ts:390-391`), and `basementStoreys` is hard-wired to 1 in `normalizeSpec` (`spec.ts:47`).
3. `packZone` is a greedy geometric packer with no feedback loop (`parking.ts:310-367`).
So a 277-unit courtyard block at 0.8 cars/unit wants 222 stalls and gets whatever one 1-basement plate holds (110).
**To eliminate by construction.** Requires a **sizing pass before massing** that solves for either (a) basement/podium level count from demand — `levels = ceil(required / stallsPerPlate(envelope))` — and writes it back into `spec.massing.basementStoreys` / `spec.floors`, or (b) the achievable unit count from a fixed parking envelope, or (c) explicitly relaxes `ratio` and records the relaxation. Modules: `src/core/spec.ts` (`resolveFloors` must be able to emit N basements), `src/disciplines/site/parking.ts` (`structuredParking` must iterate storeys; factor out a pure `stallCapacity(zone)` from `capacityOf`/`packZone`), `src/disciplines/site/massing.ts` (`buildStoreys` call at `:389` must happen after the parking solve, or the solve must be pre-massing), plus `core/metrics.ts` parking-ratio status. Note the knock-on: more basements changes `foundationFor(system, storeys, 'underground')` → piles (`typologies.ts:455`) and the structure's `groundSlabT`.

### C. Structure slab thickness / core wall thickness mismatch with architecture
**Root cause.** Two disciplines own the same number, and the one that owns it *authoritatively* runs **second**:
- Architecture hard-codes `slabThickness = (podium transfer ? 0.25 : SIZES.slabT /*0.2*/)` (`architecture/index.ts:262`) with no structural input, and uses it for `wallHeight` and `FloorPlan.ceilingHeight`.
- Structure computes the real value from the system (`sizing.ts:179`, `structure/index.ts:189-193`) and can only complain (`structure/index.ts:207-209`).
- Same for walls: architecture always `SIZES.coreWallT = 0.25` (`cores.ts:101,290,342,439`); structure always wants `shearWallT = 0.3` (`sizing.ts:186`) → `structure/index.ts:530-533`.
- Worse, the mismatch **propagates into MEP inconsistently**: mechanical (`context.ts:242`) and plumbing (`state.ts:133`) prefer **architecture's** 0.2, while electrical (`panels.ts:302`) uses **structure's** value — so the tray lane and the duct/pipe lanes are computed against different soffits on the same corridor. And plumbing always assumes `beamD = 0.3` (`state.ts:113`) even on a flat slab where mechanical assumes 0 (`context.ts:290`), so `pipeZ` and `ductZ` are derived from incompatible structural depths.
**To eliminate by construction.** This is the clearest case for your **structural pre-sizing pass as single source of truth**. The work is small because the sizing functions are already pure: run `structuralSystemFor` → `foundationFor` → `loadsFor` → `sizesFor` **before** architecture (all inputs available from site's massing per §3), publish a `StructuralPresize {slabTByStorey, beamD, coreWallT, shearWallT, columnBand, corridorSoffitZByStorey, transferStorey, gridOffsets}` on `GenContext`, and make architecture and all three MEP modules read *only* that. Modules to change: new `src/core/presize.ts` (or `src/disciplines/structure/presize.ts`), `src/pipeline.ts:36-59` (insert the pass before `:37`), `src/core/coordination.ts` (`SIZES.slabT`/`coreWallT` must become derived, not constants), `src/disciplines/architecture/index.ts:262,274-275` and `cores.ts`, `src/disciplines/structure/index.ts:186-209,530-533` (drop the two warnings; adopt the pre-sized values), `src/disciplines/mechanical/context.ts:237-247,288-295`, `src/disciplines/plumbing/state.ts:112-113,137-151`, `src/disciplines/electrical/panels.ts:302,365-369`. Also fix the transfer-slab off-by-one between `architecture/index.ts:262` (`s.index + 1 === podiumStoreys`, 0.25) and `structure/index.ts:98` (`storeyIdFor(podiumStoreys)`, 0.30).

### D. Plumbing: fixtures far from stack / trap arm exceeded / second stack added / synthesised fixtures
**Root cause — the whole family is one thing: plumbing has no say in where a fixture goes.** Plumbing runs 4th and reads `arch.furniture` / `arch.rooms` as fixed truth (`fixtures.ts:139-258`). It then does the only thing it can: pick the best wet wall it can find (`primaryWall`, `stacks.ts:262-298`), measure the L-shaped developed length (`routedLength`, `:316-319`), and when that exceeds `maxTrapArm(d)` (`tables.ts:245-249`) either open a second stack, add a local chase, or upsize to a vented branch — each with a warning naming architecture as the fixer ("architecture should move it onto the wet wall — XD-01").

Three distinct sub-causes:
1. **Fixture-to-stack distance.** The unit layout engine (`architecture/unit-layout.ts`, 3101 lines, and `floor-organizer.ts`, 1629) places rooms and furniture with `RoomProgram.wet` and `UnitInstance.wetWallIds` as hints, but **never checks a trap-arm budget**. A washer in a laundry 2.93 m off the wet wall is a perfectly legal architectural layout; plumbing discovers it afterwards.
2. **Fixtures off the wet wall.** `chooseWall` (`fixtures.ts:70-113`) attaches a fixture to a wall up to **6 m** away, and falls back to a *virtual* wall on the room edge (`VW-<roomId>`), so a fixture's "wet wall" may not be a wet wall at all → the `chase:` warning.
3. **Synthesised fixtures.** `architecture` emits bathrooms with no water furniture (or kitchens with no sink), so plumbing invents `wc/lavatory/shower` at 0.4 m off the wall (`fixtures.ts:185-231`) and a `kitchen-sink` (`:234-255`). Root cause is entirely upstream: `FurnitureDef.needsWater` is not guaranteed to be set for every wet room. Grep the furniture generator (`architecture/furniture.ts`) and the `RoomProgram.wet` flag — the invariant "every `wet: true` room carries at least one `needsWater` furniture item" is not enforced anywhere.

**To eliminate by construction.** (a) Make the **stack location an input to the unit layout, not an output of plumbing**: reserve a wet-wall chase per dwelling column in the layout engine (the analogue of site's `CORE_SHAFT_BAY = 2.4` reservation inside `CorePlacement.rect`, `massing.ts:47-55`), publish it on `UnitInstance` (e.g. `stackStation: Vec2` / `stackAlong: number` — **note this field does not exist today**), and have `unit-layout.ts` place every wet fixture inside `maxTrapArm(wasteD)` of it, rejecting/repairing layouts that cannot. (b) Make `maxTrapArm` a **layout constraint** rather than a post-hoc check: it is already a pure function in `plumbing/tables.ts:245-249` and can be lifted into core or the rule engine. (c) Enforce the fixture completeness invariant at the source — every `RoomProgram.wet` room gets its `needsWater` furniture in `architecture/furniture.ts`, so `fixtures.ts:185-255` becomes dead code. Modules: `src/disciplines/architecture/unit-layout.ts`, `unit-patterns.ts`, `furniture.ts`, `floor-organizer.ts`; `src/core/types.ts` (a stack-station field on `UnitInstance`, plus the `ShaftDef`/chase contract); `src/disciplines/plumbing/{fixtures,stacks}.ts` (constraint satisfied → warnings become assertions).

### E. Building drain at L01 vs basement fixtures (sump / ejector)
**Root cause — two separate gaps.**
1. **Geometric**: `BUILDING_DRAIN_Z = -0.55` and `SEWER_Z = -1.2` are **global constants** relative to `st.groundStorey` (`state.ts:34-35`), and `buildBuildingDrain` only ever collects stacks and floor drains with `storey === ground` (`service.ts:279-280`). A basement stack's base is therefore never picked up: its waste riser stops at the basement floor and connects to nothing. A basement floor drain (and `DRAIN_ROOM_TYPES` includes `parking`, so **every underground car park generates 1-6 floor drains**, `fixtures.ts:46,267`) is likewise orphaned.
2. **Equipment**: there is no sump pit, no ejector pump, no vented basin. `PlumbingFixture['type']` (`types.ts:1014`) has `booster-pump` but **no ejector/sump type**; `FIXTURES` (`tables.ts:33-126`) has no such spec. Grep `sump|ejector` across `src`: only the warning string and the matching pattern prose.
3. **Contributing**: nothing is ever sloped. `orthogonalize` (`routing.ts:60-79`) guarantees every leg changes exactly one axis, so a "building drain" is a horizontal line at −0.55 with `Slope: 0.02` as a **pset label only** (`service.ts:300`, `branches.ts:76`). The invert never falls, so there is no gravity model against which a basement fixture could be judged "below the sewer invert" in the first place.
**To eliminate by construction.** (1) Make the drainage datum **per-storey and sloped**: an invert-elevation model (`invertZ(storey, station)`) instead of two constants, and a `sloped-axis` capability so a run can fall (either a new geometry kind, or allow `axis` legs with a controlled dz and relax `isOrthogonal` for `waste`/`storm`). (2) Extend `buildBuildingDrain` to walk **all** `buildingStoreys`, compare each fixture's invert against the lateral invert at the point of connection, and route gravity-drainable fixtures to the collector. (3) Add `sump-pit` + `ejector-pump` fixture types with a vented basin, a discharge riser to the gravity drain above the invert, and a check valve — a *constructability rule*: "no fixture below the sewer invert without an ejector". Modules: `src/disciplines/plumbing/state.ts` (Z constants → an invert model), `routing.ts` (sloped legs), `service.ts:276-360` (multi-storey collector), `tables.ts`+`fixtures.ts` (new fixture types), `src/core/types.ts` (`PlumbingFixture['type']` union). Also worth noting: `spec.ts:106` makes every basement `use: 'parking'` by default, so every underground-parking typology hits this on every run.

### F. Is there any notion of "support" for horizontal MEP runs?
**No — none at all.**
- `ElementGeometry` has no hanger/support/host concept; the only run primitive is `axis` (`types.ts:359-360`). No `IfcDiscreteAccessory`, `IfcMechanicalFastener`, or `IfcSupport` anywhere in the repo.
- Grep for `hanger|bracket|strut|clevis|trapeze` across mechanical, plumbing, electrical: **zero hits** (matches are unrelated prose).
- There is no "is this run under a slab?" test. `plenumBands` returns a `soffitZ` but nothing verifies a run is below it; the closest thing is the *mechanical test* asserting ducts lie in the band (`mechanical.test.ts:165, 552`) and the plumbing self-check `counts.nonOrthogonal` (`state.ts:282`).
- A run can therefore float in mid-air with nothing above it: the electrical feeder drop (`panels.ts:452-453`), the plumbing bar trunk on a floor with no corridor (`routing.ts:190-216`, 1 m inside the exterior wall at `trunkZ`), the storm main at −1.0, the mechanical refrigerant line to a ground pad (`context.ts:11-13` explicitly allows leaving the plenum). Nothing links any of these to a slab, beam, or wall.

### G. Load-path continuity for structure?
**No.** Detailed in §4. Summary: columns per storey from possibly different grids (park vs main), per-storey wall snapping that can shift XY, per-storey blocker and outline tests that silently drop columns, footings derived **only** from the lowest storey's columns and walls, transfer beams laid on grid lines rather than on the columns they actually pick up, and balcony/cantilever structure entirely absent (architecture owns balcony slabs, `structure/index.ts:12`). The only checks are three "nothing to found on" fallbacks (`:919`, `:1010`, `:1259`).

### H. Any existing per-floor-use ceiling zoning?
**No.**
- `plenumBands(floorToFloor, slabT, beamDepth, corridorCeiling)` is use-blind (`coordination.ts:41-57`) and returns single Z values, not extents.
- The only use-adjacent discrimination in MEP is binary: mechanical `StoreyInfo.isResidential = FloorPlan.unitIds.length > 0` (`context.ts:257`) and plumbing `StoreyInfo.hasUnits` / `hasCorridors` (`state.ts:145,148`). Plumbing captures `use: String(s.use)` on `StoreyInfo` (`state.ts:144`) and **never reads it**.
- The one place a floor's *lack* of a corridor changes routing is `spineFor` → `trunkSpine` (`service.ts:42-53`, `routing.ts:219-230`) and the same in `sprinkler.ts` — a "parking, retail, lobby, terrace" branch keyed on `hasCorridors`, not on `FloorUse`. Pattern PLB-11's prose (`plumbing/patterns.ts:215`) names parking/retail/lobby explicitly, but the code only tests for corridors.
- Nothing anywhere allocates a different band stack for a parking deck (where ducts are large, ceilings are absent, and clear height to the drive aisle governs), a retail floor (deep tenant plenum, separate tenant systems), a residential corridor (the only case actually modelled), or a mech room (no ceiling, equipment-driven).
- Structure has the richer use-awareness — `isPodiumStorey(s)` = `s.index < 0 || s.index < podiumStoreys || s.use === 'parking'` (`structure/index.ts:108`), `slabMaterialOf` (`:270-276`), `groundSlabT` (`:188`), and the parking-module grid (`grid.ts:229-237`) — but it publishes only **one** scalar for the whole building, `plenumClearance.corridorSoffitZ` computed from the *typical residential* storey (`:1212-1215`), which MEP then applies to parking, retail and residential floors alike.

### I. Two additional coordination hazards worth fixing in the same pass
- **The shaft-slot convention is triply duplicated and mutually inconsistent.** `shaftSlot` (mechanical, centre + middle third of the long axis, `mechanical/placement.ts:370-387`), `plumbingShaftCorner` (min corner + 0.15, `plumbing/storm.ts:31-33`), and an inline max-corner literal (electrical, `panels.ts:385`). The prose says "corridor-left / corridor-right"; the code says "world min / max corner". Two of three disciplines also disagree on which shafts they may use: mechanical's `nearestShaft` has **no purpose filter** (`placement.ts:392-400`) while electrical filters strictly to `electrical|combined` (`panels.ts:286`) and plumbing to `plumbing|combined` (`stacks.ts:448-451`, `storm.ts:54`). A shared, validated shaft-slot allocator in `core/coordination.ts` — returning a reserved XY *and* a footprint per (shaft, discipline, system) — would remove this class of clash entirely. The only test covering it (`mechanical.test.ts:343`) checks mechanical's own claim, not that the three disciplines are disjoint.
- **The `sprinkler` lane and the `pipe` lane are 0.20 m apart at the same Z.** `DEFAULT_LANES.pipe = -0.35`, `DEFAULT_LANES.sprinkler = -0.15`, and `plenumBands` sets `sprinklerZ = pipeZ = trayZ` (`coordination.ts:52-53`). A Ø150 DCW main and a Ø50 sprinkler main on the same centreline height 200 mm apart is a clash, unflagged; the tray at `+0.35` shares that Z too. Lanes need widths, not just offsets.
