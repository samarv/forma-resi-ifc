# Exploration: architecture discipline (floor organiser, unit layout, templates, doors, furniture)

_Generated 2026-09-21 by a read-only design/exploration pass over this repository; line numbers refer to the v1 code at commit 05246fb. Source of truth for v2 contracts is docs/design/v2-plan.md and the files under src/core._

I have a complete picture, verified by running the generator. Here is the map.

---

# ARCHITECTURE DISCIPLINE — CODE MAP

All paths relative to `/Users/samarvir/formaIFC/generator`. Line numbers are from the current working tree.

## 0. Shape of the module

| File | Lines | Role |
|---|---|---|
`src/disciplines/architecture/index.ts` | 584 | `generateArchitecture(ctx)`: storeys → FloorCtx → plan/instantiate loop → roof → FloorPlans → derived metrics → pattern trace → `ModelElement[]`. Owns dependency injection (`setArchitectureDeps`). |
`floor-organizer.ts` | 1629 | Stage 1 `planFloorLayout` (abstract rects + template ids), Stage 2 `instantiateFloor` (walls/cores/corridors/units/commons/balconies). |
`unit-layout.ts` | 3101 | `layoutUnit(req)`: one net rect → rooms, partitions, wet walls, doors, windows, furniture, stair, patterns, warnings. |
`templates.ts` | 794 | 20 `UnitTemplateDef`s + `UNIT_LEVEL_SPLIT` + `recommendedRect`. |
`unit-layout-types.ts` | 83 | The `UnitLayoutRequest` / `UnitLayout` contract (the one real seam). |
`types-internal.ts` | 107 | `FloorCtx`, `UnitSlot`, `CommonRoomSlot`, `CorridorSlot`, `FloorLayout`, `SideWallSpec`. |
`bar-frame.ts` | 147 | `BarFrame` (along/across) + interval algebra (`subtractIntervals`, `apportion`). |
`cores.ts` | 553 | `planCores` (once per building) + `buildCoreOnFloor`. |
`envelope.ts` | 289 | `EnvelopeBuilder` (break-then-cut exterior walls), `glazeWall`, `buildRoof`, parapets. |
`common-rooms.ts` | 315 | Ground/retail/amenity programs, `sliceProgram`, `buildCommonRoom`, `furnishCommonRoom`. |
`arch-elements.ts` | 866 | `ArchBuilder` accumulator + `emitElements` (ModelElement phases). |
`furniture.ts` | 139 | 45-item `FURNITURE_CATALOG`, `CLEARANCE`, `storageVolume`. |
`patterns.ts` / `unit-patterns.ts` | 312 / 337 | ARC-01…13 + 31…35 / ARC-14…30 + 36. |
`test-fixtures.ts` | 647 | `makeSiteFixture`, `FALLBACK_TEMPLATES`, `stubLayoutUnit`. |

Data flow: `generateArchitecture` (index.ts:105) → `planCores` (122) → per storey `planFloorLayout` **cached by `planKey`** (141-147) → `instantiateFloor` (149) → `buildUnit` → `deps.layoutUnit(req)` (floor-organizer.ts:1406).

---

## 1. floor-organizer.ts + index.ts — how a floor becomes unit rects

### 1.1 Storey → bars

`makeFloorCtx` (index.ts:250-283) resolves the outline (podium / tower / basement), f2f, `ceilingHeight`, `wallHeight = f2f − slabT`, `wwr` (default 0.35, index.ts:276), `targetUnits`, `unitMix` (floor ?? spec ?? typology), and `bars` via `barsForOutline` (index.ts:289-298): massing bars overlapping the outline bounds, **but only if they cover > 60 % of the outline area**, otherwise the whole plate becomes one synthetic bar `frameOfRect('PLATE', …)`. Each bar becomes a `BarFrame` (bar-frame.ts:31-47) giving `(a0,a1)` along, `(c0,c1)` across, and `lowSide/highSide/startSide/endSide`, so all packing code is axis-agnostic.

### 1.2 Dispatch

`planFloorLayout` (floor-organizer.ts:70-87): by `FloorCtx.use` first (`planServiceFloor`, `planRetailFloor`, `planAmenityFloor`), then by `ctx.typology.access`: `stair-core` → `planStairCoreFloor`, `point-core` → `planPointCoreFloor`, `gallery`/`corridor-single`/`cluster` → `planCorridorFloor(mode)`, default `'double'`. `'direct'` never arrives — `planHouses` (925) is called once for the whole residential stack (index.ts:137-139).

### 1.3 Cutting a strip into bays (the core algorithm)

`packStrip(s: StripArgs)` — floor-organizer.ts:367-451. Given `frame`, an along-`iv`, and across bounds `cLow..cHigh`:

1. Wall specs per side (371-381); `netDepth = boundaryDepth − ½t(low) − ½t(high)` (382). **Bail if `netDepth < 4.0` or `ivLen(iv) < 2.0`** (383).
2. `choosePicks(pool, ivLen(iv), netDepth, rng, cornerAtStart, cornerAtEnd, targetCount)`.
3. Walk a cursor, emitting one `UnitSlot` per pick (390-428). The last bay snaps to `iv.e` only when `remnant <= 0.001` (394).
4. Soft warning if the bay is narrower than the template wants (410-414):
   `unit ${templateId} on ${storeyId} has ${alongLen} m frontage, below the ${minF} m minimum for that template at ${netDepth} m depth`
5. Remnant (429-449): ≤ 1.6 m → **stretch the last unit** to absorb it; otherwise emit a `CommonRoomSlot` typed `'flex'` (≥ 3 m) or `'storage'`, and warn `floor …: X m of frontage left over on bar … — placed as a flex room/store`.

### 1.4 Template assignment — order, fitting, fallbacks

`mixPool` (143-170): mix = `{...typology.defaultUnitMix, ...spec.unitMix, ...floor.unitMix}` (144). Empty → `'1b1b'` fallback + warn (156-161). Also computes `largest` (by `area.target`), `corner` (`corner-2b2b` if in the mix else `largest`), and `catalogue` = **all single-level templates sorted by `frontage.min`**, "used only to rescue a bay the mix cannot fill" (166-168).

`choosePicks` (195-229):
- Bay count `n` = `round(avail / weightedAvgFrontage)`, then capped by `floor(avail / narrowest)` (210-211); `avail < floorMin*0.9` → no units at all (212). `targetCount` (from `apportion(f.targetUnits, …)`, 625-627) overrides.
- `per = avail / n`; `narrowPool(pool, per, depth)` (237-262) keeps templates with `minFrontage(t,depth) ≤ per*1.12+0.05` **and** `t.frontage.max ≥ per*0.55`; two successive fallbacks (empty → min-fits-only → narrowest in mix).
- Corner bays (i === 0/n−1 when `atStart`/`atEnd`) take `corner-2b2b` if present else the largest usable (219-222). All other bays: **independent weighted draw** `usable.templates[weightedIndex(usable.weights, rng.next())]` (226).

Frontage sizing:
```ts
minFrontage(t, depth) = max(2.6, t.frontage.min * clamp(t.depth.max / depth, 0.45, 1))   // :177-180
frontageOf(t, depth, levels) = clamp(t.area.target / (depth*levels), minFrontage, t.frontage.max) // :182-185
```
`fitFrontages` (275-339) then reconciles picks with `avail`: while minima don't fit, **swap the widest bay for the largest template that fits the残 budget**, else `list.pop()` — i.e. drop a dwelling (282-300). Overflow → shrink toward minima, then uniform scale (303-316). Underflow → the largest bays absorb slack up to `frontage.max`, then **everything is inflated up to `frontage.max * 1.2`** (317-336).

**Compatibility checks that exist:** only `narrowPool`'s ±12 %/0.55 band and the soft frontage warning. **Absent:** any check of `t.depth.min/max` against the rect depth (grep: `depth.max` is used only inside `minFrontage`, `depth.min` only in `clusterMode`), any check of `t.area.min/max` against `rect w*h`, and any use of `recommendedRect` (templates.ts:783) — it is referenced *only* by `unit-layout.test.ts`. Measured on real presets:

| preset | units | rect frontage outside template range | depth outside | NIA outside `area.min..max` |
|---|---|---|---|---|
us-5-over-1 | 80 | 35 | 0 | 70 |
ie-courtyard | 171 | 46 | **171** | 133 |
au-walkup | 24 | 7 | **24** | 24 |

And the delivered mix drifts badly from the requested weights (weighted draw per bay + `narrowPool` filtering + corner override, with no quota accounting):

| preset | requested | delivered |
|---|---|---|
us-5-over-1 | studio 18 / 1b1b 36 / 2b2b 27 / 3b2b 9 / corner 9 | studio 25 / 1b1b 38 / 2b2b 19 / **3b2b 0** / corner 19 |
ie-courtyard | 1b1b 25 / 2b2b 33 / 3b2b 17 / corner 17 / studio 8 | **corner 57** / 2b2b 19 / 3b2b 6 / 1b1b 18 / studio 0 |
au-walkup | 1b1b 25 / 2b1b 38 / 2b2b 25 / studio 13 | 1b1b 71 / 2b1b 29 |

The `unit-mix` metric (core/metrics.ts:671-677) reports the *delivered* breakdown only; nothing compares it to the request.

### 1.5 Corridors, and the ARC-03 length warning

Corridors originate in the **site** discipline: `buildCorridors` (site/massing.ts:815-848) makes **one `CorridorSpine` per bar**, centreline spanning the bar's whole length, at mid-depth (double-loaded) or hard against the inner face (single/gallery). `spinesFor` (floor-organizer.ts:457-477) reads them back, **synthesising** one at mid-depth if the bar has none (459-466).

`planCorridorFloor` (479-646) builds the corridor band, then:
```ts
const corridorBlocks = barCores.filter(c => /* core across-range overlaps the corridor band */)
                               .map(c => coreBlockedIn(c, frame));      // :550-555
const corridorSpan = { s: max(eStart, min(spine.along.s, eStart+2)), e: … };  // :556-559
for (const seg of subtractIntervals(corridorSpan, corridorBlocks, 1.2)) { … } // :560-571
```
Each segment becomes a `CorridorSlot` with `daylitEnds` (563-564, glazed in `instantiateFloor` at 1256-1265 with `wwr 0.4, sill 0.9, h 1.8`).

`instantiateFloor` (1231-1267) turns each slot into a `CorridorDef` whose `centerline` is **one single segment** spanning `max(rect.w, rect.h)` (1240-1248).

The warning is emitted in **`index.ts:362-365`**, inside `computeDerived`:
```ts
for (const c of b.corridors) {
  const len = Math.max(...c.centerline.map(s => dist(s.a, s.b)));
  if (len > 60) b.warn(`corridor ${c.id} on ${c.storey} runs ${round(len,1)} m without a break (ARC-03 limit 45 m, hard warn 60 m)`);
}
```
ARC-03 is *also* recorded as a pattern application with `withinLimit: len <= 45` (index.ts:474-482). Reproduced live: `us-5-over-1` 71.7 m, `us-senior` 75.7 m, `ie-courtyard` 69.7 m ×2.

**Break mechanism: none beyond cores.** The only splitter is `subtractIntervals` against cores whose *across* range intrudes into the corridor band. In practice it never fires: in `us-5-over-1` the two cores sit at `y 3..12.15` and `y 13.85..23`, i.e. *beside* the 1.7 m band, so `corridorBlocks` is empty and one 71.7 m `CorridorDef` results. There is no concept of a lounge, a widened lift lobby bay, a cross-corridor, a light well, or a corridor node graph. Corridors of different bars are never joined: `ie-courtyard` (O-plan) produces 4 disjoint corridors that do not meet at the corners.

Egress travel is checked separately: `maxTravel` (index.ts:409-429) = orthogonal `dx+dy` from each unit entry door to the nearest core rect, warned against 61 m / 76 m sprinklered (358-361).

### 1.6 L/U/O footprints, wings, knuckles

The site decomposes shapes into **non-overlapping, edge-butting rects** (`decompose`, site/massing.ts:566-650): a full-width `front` bar on the build-to line plus wings starting at `env.y + depth`; `O` adds a rear bar and two side wings of length `env.h − 2*depth`; degradation chain O → U → L → bar with warnings. `exteriorSidesOf` (site/massing.ts:663-680) marks a side exterior when **less than 95 %** of it is shared with another bar.

Architecture then treats **each bar completely independently**: its own `BarFrame`, own spine, own cores (`coresFor`), own `packStrip` run. Consequences:
- There is **no knuckle element**. The corner area belongs to the front/rear bar, whose full width already covers it; the wing simply stops at the bar's face.
- A unit at an inside corner can be given an `exteriorSide` that actually faces the adjacent wing (the 95 % rule), which is why `balconyIsClear` (1581-1596) exists as a post-hoc veto (probes overlap against all units, corridors, commons, cores, shaft blocks and the site bounds).
- Corner units are chosen purely by position in the strip (`atStart`/`atEnd`), not by their exterior-side count; `aspectOf` (1618-1626) classifies aspect afterwards from `exteriorSides`.

### 1.7 "Frontage" and the data structures

Frontage is never a stored field. It is:
- the along extent of the bay, `alongLen = a1 − a0` in `packStrip` (410);
- reported for ARC-02 as `moduleOf(u.rect, u.accessSide)` = `rect.w` if access is front/rear else `rect.h` (index.ts:579-581).

**`UnitSlot`** (types-internal.ts:42-61) — the abstract, storey-independent bay:
```ts
index, templateId, boundary /* wall CENTRELINES */, accessSide, exteriorSides: Side[],
sides: Record<Side, SideWallSpec>, barId, coreId?, stackAlong, stairRect?,
storeySpan?: string[], extraDoors?: {side,width,height,type,offset?}[], notes?
```
**`FloorLayout`** (types-internal.ts:99-107): `{ key, units: UnitSlot[], corridors: CorridorSlot[], commons: CommonRoomSlot[], blocked: Record<barId, Interval[]>, remnantArea }` — cached per `planKey` (`use | outline bounds | targetUnits | mix | ground/typical | balconies | wwr | ceiling | access`, 102-116). This is what makes wet walls stack.

**`UnitInstance`** (core/types.ts:710-732) — the realised dwelling:
```ts
id, templateId, storeys: string[], rect: Rect /* boundary, NOT net */, polygon, area /* Σ room areas */,
bedrooms, bathrooms, occupants, aspect: 'single'|'dual'|'corner', accessSide: Side,
entryDoorId, roomIds: string[], wetWallIds: string[], kitchenRoomId?, bathroomRoomIds: string[],
balconyRoomId?, barId?, coreId?
```
**`FloorPlan`** (core/types.ts:797-814): `storey, use, outline, area, floorToFloor, ceilingHeight, slabThickness, corridors: CorridorDef[], unitIds, roomIds, commonRoomIds, wallIds, exteriorWallIds, balconies: BalconyDef[], wwr`.

`buildUnit` (1312-1575) is the single bridge: boundary walls (reuse envelope segment via `env.wallFor`, else `b.addWall`), `net = insetSides(boundary, halves)` with **skip if `net.w<2.2 || net.h<2.2`** (1364-1367), the `UnitLayoutRequest`, then merge with id validation (`door hosted in unknown wall … dropped`, 1433-1435), stair adoption, extra doors, balcony, `UnitInstance`, and a **fallback entry door** if the layout returned none (1558-1571).

---

## 2. unit-layout.ts — the two plan types

Everything is planned in a local frame anchored on the access side: `u` along the frontage `0..F`, `v` from the access side inward `0..D`; `makeFrame` (199-248) is a pure rotation (all four `accessSide` cases are right-handed), with `toWorld`, `toWorldRect`, `toLocalRect`, `side`/`localSide` mapping via `LOCAL_TO_WORLD_SIDE` (192-197), `dir(LDir)` and `alongToU`.

Plan selection — `layoutUnit` 1426-1433:
```
coliving-cluster → planCluster;  dual-key → planDualKey;
useThroughPlan(F,D,insts,opts) && no stair/garage → planThrough;  else planStandard
```

### 2.A Zoned plan (`planStandard` 444-527 → `planRegion` 539-758)

`planStandard` first carves **full-depth columns** off the low-u end: stair (450-485, risers `ceil(f2f/0.18)`, honours `stairLocal` hint only if it hugs the party wall, and can put an entry *in front of* the stair for narrow terraces — ARC-18), then garage (487-501), then, when `flipV`, a full-depth entry spine (506-515). The remainder `region = {x:u0, y:0, w:F−u0, h:D}` goes to `planRegion`; if `flipV`, all cells are mirrored in v afterwards (518-524).

`planRegion`:
1. **Band membership** (546-548): `back` = rooms with `prog.needsExterior === true && !BATH_TYPES`; `front` = everything else except the hall.
2. **Feasibility loop** (551-562): while `Σ minWidth(back) > W + 0.45`, evict the *smallest* daylit room into the service band — warning ➋ below.
3. **Band depths** (574-587): `Fd = clamp(frontArea/W, minFd, maxFd)` with `minFd` 3.3 / 2.8 (accessible) / 2.4, `maxFd = min(4.4, D*0.48)`; hall depth `Hd` 1.25 (1.4 accessible), refined from the hall program at 641-648; `bedDepth = backDepth − Hd`.
4. **Zones** L (public) / P (bedrooms) / M (master suite, only if `master && ensuite && privates>1 && W>6.5`), ordered `['P','M','L']` when the entry is at the low edge else `['L','P','M']` (616-618); widths proportional to `raw` (target area / depth) with min-clamping (620-639).
5. **Service band** = one continuous strip across the whole region, ordered by `orderFront` (825-835), exiles put at the glazed end (659-664), widths from `fitWidths(items, W, 'service band', warnings)` (666) — warning ➊.
6. **XD-01 stack**: `slideWetCluster(frontCells, region.x, o.stackU)` (683-689, impl 766-818) permutes the *order* of the non-daylit columns (preserving widths, so the band still tiles) to get a wet column over `stackU`; sets `o.stackHit` / `o.stackBlockedBy`.
7. **Second service row** behind bath/laundry/store columns for rooms dropped by `fitWidths` (691-726); whatever remains goes to `o.dropped` (726).
8. **Daylit band**, zone by zone, with a hall cell across zone P (733-757).

`fitWidths` (328-382) is the workhorse: drop `DROPPABLE` items while minima don't fit → proportional shrink to minima → last-resort uniform squeeze (with `entry` held at 1.2 m) → warning only for `CRITICAL_WIDTH` types (kitchen, living-kitchen, bathroom, ensuite, shared-kitchen).

### 2.B Through flat (`useThroughPlan` 870-886 → `planThrough` 888-1127) — ARC-36

Chosen when: not `accessExterior`, not `flipV`, at least one of `extLow`/`extHigh` (perpendicular façades), `D ≥ hallD+2.4`, `F ≥ 5.4`, and either the far side is not glazed, or `D < 5.4`, or (`D > F+1` and all columns fit `F`).

Algorithm: hall strip depth `hallD = clamp(1.2|1.5, 1.1, D−2.4)`, service depth `sd = D − hallD`. Daylit rooms split between the two u-ends by solar score (`pubEnd` = better `solarScore`, 901-916); per-end feasibility loop moves rooms that exceed `D` of façade to the other end or to `internal[]` (918-929) — warning ➐. Service rooms become **columns** of one door-off-the-hall room plus stacked secondaries on the party wall (931-969, `rank`/`hostScore`). Columns in u-order: band(low), spur(low), service…, spur(high), band(high) (971-1003); degradation drops optional dry columns then spurs (1005-1020); `fitWidths(items, F, 'through plan', warnings)` (1025) — warning ➊ variant; thin-column repair (1036-1049); per-column `fitWidths(…, 'low-façade' | 'service column')` in v (1067). The hall strip is cut **only on column boundaries** and the entry is the best run of whole columns ≤ 3.4 m near the middle (1086-1117). `markThroughWetEdges` (1151-1175) points each wet room's fixture wall at a wet neighbour, else at the hall strip. Returns `wetSpan {lo,hi}` (1056, 1077, 1125).

`planCluster` (1179-1264) and `planDualKey` (1268-1290) are bespoke; both can bail to `planStandard`.

### 2.C Where each warning comes from

| # | Warning text | Site | Function / decision | Upstream cause |
|---|---|---|---|---|
➊ | `service band: kitchen 2.10 m (min 2.40 m) … only 8.59 m available for 9.65 m of rooms` | **:370** (label from **:666**, also `'through plan'` :1025, `'second service row'` :713, `'{L,P,M}-daylit'` :743, `'service column'`/`'…-façade'` :1067) | `fitWidths` last-resort uniform squeeze; warns only for `CRITICAL_WIDTH` (:117) below `min − 0.15` | Σ of service-room min widths > the bay frontage `W`. Directly caused by the organiser handing a template a frontage narrower than its program needs (`narrowPool`'s 12 % tolerance + `fitFrontages` shrink). |
➋ | `bedroom moved into the service band with no exterior wall — frontage 9.0 m is too narrow for bedroom beside the other 3 daylit rooms` | **:560** | `planRegion` feasibility loop; warns only when no perpendicular wall is glazed | `Σ minWidth(needsExterior rooms) > W + 0.45`, i.e. too many daylit rooms for the frontage. |
➌ | `daylit rooms squeezed below minimum width (need 9.65 m, have 9.57 m)` | **:564** | `planRegion` after the eviction loop bottoms out (guard 12 or `back.length ≤ 1`) | Same, but eviction couldn't fix it. |
➍ | `Bedroom needs daylight but has no exterior wall on this rect: 8.98 m of façade (right) for 9.65 m of habitable rooms` | **:1880-1886** | Post-glazing sweep over rooms whose `prog.needsExterior` is true and `windowIds.length === 0`, excluding `cell.daylightWaived` (set in `planThrough` :1080) | The consequence of ➋/➌; also every `coliving-cluster` (6 bedrooms, one façade). |
➎ | `door narrowed to 0.60 m — below the 0.75 m minimum leaf` | **:1721-1723** | Interior-door loop: `width = min(spec.width, max(0.6, wallLen − 0.15))`, warns when `< 0.7` for a leafed `'interior'` door | The shared edge between the two rooms is < ~0.9 m — a narrow en-suite/store column produced by `fitWidths`. |
➏ | `fixtures run on the wall opposite the wet wall because the door swing covers it — branch length 1.80 m (XD-01 allows 3 m)` | **:2699-2701** | `furnishBathroom` candidate order `[wetSide, …lateral, oppSide(wetSide)]` (:2681) succeeded only on the opposite wall | The door swing rect (`ctx.swings`) covers the wet wall; room is small (`< 4.6 m²` gets a slider, so a *swing* door means a bigger-but-still-tight room). Note the "branch length" figure is cosmetic (`min(w,h)`). |
➐ | `bedroom placed away from the façade: a through unit 7.38 m wide offers 7.38 m of end façade for 9.05 m of habitable rooms` | **:1120-1122** | `planThrough` `internal[]` non-empty and far side not glazed | Unit depth `D` too short to stand all daylit rooms along the end façades. |
➑ | `no room for laundry in a 5.25 × 10.4 m rect (54.6 m² against a 150 m² minimum for townhouse-3s)` | **:1454-1457** | `opts.dropped` minus `SILENT_DROP` (closet/walk-in/storage) tallied once per unit | Rooms dropped by `fitWidths` (droppable) or by the `planThrough` column-degradation loop. The quoted area compares *this level's* rect against the template's **whole-unit** `area.min` — misleading for multi-level templates. |
➒ | `requested stack position u=… sits in the … and no order of the wet band covers it` | **:1443-1449** | `slideWetCluster` returned false and the blocker isn't a `BACK_TYPES` room | `stackAlong` from the organiser (floor-organizer.ts:426) lands outside the wet band. |

Others worth knowing: `wetWallSide … differs from accessSide` (:1391), `unit is single-aspect toward the access side` (:1424), `glazing reaches X % … against a Y % target` (:1874), `dropped {type}: resolved to … m` (:1466), `{room} has no door (no usable shared edge)` (:1701), `no clear position for the {room} door on wall …` (:1725), `requested stairRect is not compatible` (:1915).

### 2.D `stackAlong` / `wetWallSide`

`wetWallSide` is only *checked* — the wet band always sits on `accessSide` (:1391-1393). `stackAlong` becomes `opts.stackU = frame.alongToU(req.stackAlong)` (:1417) and is used in exactly two places: `slideWetCluster` (:683) and `wetStackU` (:1439, impl :1969-1978). The organiser sets `stackAlong = round(min(1.6, alongLen*0.3), 3)` (floor-organizer.ts:426) — a bay-relative constant, which is what makes stacks align vertically (identical slot rects per storey).

**There is no fixture-to-stack distance guarantee anywhere in architecture.** No code measures the distance from a `FurnitureDef` with `needsWater` to `stackAtU`; the only recorded value is the pattern parameter `stackHonoured` (:2934). The violation is discovered downstream in plumbing (`stacks.ts:139`, `:168`, `:171`):
> `kitchen-sink is 2.3 m from its dwelling's stack …, past the 1.5 m unvented trap-arm limit (IPC Table 1002.2) … (architecture should move it onto the wet wall — XD-01)` / `… a second stack was added on its own wet wall`

### 2.E Adjacency / connectivity today

There is a **transient** graph, discarded after doors are cut:
- `Adj { a, b, axis: 'u'|'v', coord, s0, s1, wallId? }` (:1355-1364) built by O(n²) geometric edge matching over local rects (:1531-1549), kept when the shared edge `> MIN_EDGE = 0.6`.
- One `WallDef` per `Adj` (:1553-1588), `type: 'wet' | 'partition'` via `isWetWall` (:2024-2040), with `leftRoomId`/`rightRoomId` assigned by a 0.05 m probe on the left normal (:1575-1582).
- Doors: `pickRoot` (:2056-2069, prefers entry → hall → stair → corridor → living) then `spanningTree` (:2071-2118) = Dijkstra where the edge cost is `transitCost(roomType)` (:140-147: hall 0.1 … bedroom 40, bathroom 120, closet 200, balcony 400) plus a small short-edge penalty; edges below `MIN_DOOR_EDGE = 0.7` are excluded (:2075). A post-pass re-parents en-suites/walk-ins onto their bedroom via `cell.prefParent` (:2097-2116), with cycle protection.
- `doorSpec(from,to,…)` (:2120-2148) picks width/type/operation/`leaf`.

What does **not** exist: any declared adjacency requirement in `RoomProgram` (only `prefer: 'front'|'back'|'either'`, which is in fact never read — grep: `prog.prefer` is unused in unit-layout), any "must be reachable from the hall" constraint, any persisted room graph in `UnitLayout`/`ArchModel` (only `RoomDef.doorIds` + `DoorDef.fromRoomId/toRoomId`), and any privacy/circulation validation beyond `transitCost`.

---

## 3. DOORS — the swing/hinge convention and the bug

### 3.1 The data

`DoorDef` (core/types.ts:634-648):
```ts
id, storey, wallId, along /* wall start → door CENTRE */, width, height,
type: 'unit-entry'|'interior'|'building-entry'|'balcony'|'garage'|'exit'|'closet'|'service',
operation: string,            // free-form IFC token
fromRoomId?, toRoomId?, fireRated?, unitId?
```
**There is no hinge field, no swing field, no "opens into" field.** The only encoding of handing is the `operation` string, and it is a constant everywhere:
- `doorSpec` (:2120-2148) returns `'SLIDING_TO_LEFT'` (closets, tight baths), `'DOUBLE_DOOR_FOLDING'` (cupboards), `'NOTDEFINED'` (cased openings between `OPEN_PLAN` rooms), `'SINGLE_SWING_RIGHT'` (garage-to-house) and otherwise **always `'SINGLE_SWING_LEFT'`** — the handing is never computed from geometry.
- entry door `'SINGLE_SWING_LEFT'` (:1630); balcony `'DOUBLE_DOOR_SLIDING'` (:1683); garage `'ROLLINGUP'` (:1654); organiser fallback entry `'SINGLE_SWING_LEFT'` (floor-organizer.ts:1563); cores use `SINGLE_SWING_LEFT`/`SINGLE_SWING_RIGHT` by role (cores.ts:462, 482); common rooms `'SINGLE_SWING_LEFT'`/`'DOUBLE_DOOR_SINGLE_SWING'` (common-rooms.ts:207, 222).

The *correct* swing direction **is** computed — and thrown away. In the interior-door loop:
```ts
if (spec.leaf) {
  const dirIn: LDir = adj.axis === 'v' ? (to.local.x > from.local.x ? 'u+' : 'u-')
                                       : (to.local.y > from.local.y ? 'v+' : 'v-');
  addSwing(swings, to, along, width, dirIn, seg, frame);     // unit-layout.ts:1733-1739
}
```
`addSwing` (:2150-2165) builds a `width × width` clearance square inside the room being entered, and `swings` is passed to `furnishRoom` (:1896) so furniture avoids it (`place`/`probe` reject overlaps, :2213, :2251). `dirIn` is never written to the `DoorDef`. Same for the entry door: `addSwing(swings, entryRoom, along, w, 'v+', seg, frame)` (:1634).

### 3.2 The 2D plan (`src/app/plan-svg.ts:287-302`)

```ts
const { a, b, nrm, dir } = along(w, d.along, d.width);          // :291
cut.push(polyPath(wallQuad(a, b, w.thickness * 1.6)));          // :292
const tip = [a[0] + nrm[0]*d.width, a[1] + nrm[1]*d.width];     // :293
leaf.push(linePath(a, tip));                                    // :294
arcs.push(arcPath(a[0], a[1], d.width, atan2(nrm), atan2(dir))); // :295
```
with `along()` (plan-svg.ts:630-641): `dir = normalize(end − start)`, **`nrm = [-dir[1], dir[0]]`** (the LEFT normal of the wall's start→end direction), `a = centre − dir*w/2`.

So the drawn convention is: **hinge at the low-`along` end (`a`), leaf swinging to the left of the host wall's stored direction — unconditionally, for every door.** `d.operation` is only shown in the tooltip (:299); `d.toRoomId` is never consulted.

### 3.3 The inconsistency, precisely

Two incompatible wall-direction conventions coexist:

1. **CCW-loop walls** — `rectEdges(r)` (core/geometry.ts:129-138) emits `front: (x1,y1)→(x2,y1)`, `right: (x2,y1)→(x2,y2)`, `rear: (x2,y2)→(x1,y2)`, `left: (x1,y2)→(x1,y1)`. For a CCW loop the left normal points **into** the rect. Used by `cores.ts` (`buildCoreOnFloor` :324-349, `enclose` :504-513) and `common-rooms.ts` (:193-201). Arcs on these walls are drawn correctly.
2. **Ascending-coordinate walls** — always `a0 → a1` with increasing x (front/rear) or increasing y (left/right): `EnvelopeBuilder.build` (envelope.ts:101-109), the organiser's party/corridor walls (floor-organizer.ts:1344-1345), and every unit-layout partition (`p0 = toWorld(coord, s0)`, `p1 = toWorld(coord, s1)`, :1558-1559). Left normal is then `+y` for x-running walls and `−x` for y-running walls, which is **inward for `front` and `right` sides and outward for `rear` and `left` sides**.

Consequences:
- The arc side of a unit's entry door depends only on which side of the corridor the unit sits on. A `front`-access strip draws the arc into the unit; the mirrored `rear`-access strip draws it into the corridor.
- Interior doors: because unit partitions are emitted in ascending local order, the arc always lands on the `u−` side (for v-running walls) or the `v+` side (for u-running walls) *in local coordinates*, regardless of `dirIn`. The room the door actually opens into is wrong roughly half the time.
- Sliding, folding and cased openings are drawn with a leaf line and a 90° arc anyway (the loop at plan-svg.ts:287 does not look at `operation`).

Measured on `us-5-over-1` (836 doors, probing 0.3 m along the drawn arc's normal):

| door type | arc lands inside `toRoomId` | lands in a **different** room | no `toRoomId` |
|---|---|---|---|
interior | 175 | **237** | 12 |
unit-entry | 40 | **40** | 0 |
balcony | 40 | **40** | 0 |
closet | 30 | **140** | 0 |
service | 0 | **80** | 0 |
**total** | **285** | **537** | 14 |

### 3.4 The IFC side (`src/ifc/writer.ts`)

`emitElements` (arch-elements.ts:491-523) maps `DoorDef → { kind: 'door-in-wall', hostId, along, width, height, operation }` plus `Pset_DoorCommon.OperationType`. The writer (writer.ts:738-756) calls `creator.addIfcWallDoor(hostExpressId, { Position: [g.along, 0, 0], …, OperationType: pick(DOOR_OPERATIONS, g.operation, 'SINGLE_SWING_LEFT') })`. The vendored creator (`ifc-lite-create/ifc-creator.ts:699-735`) makes a flat rectangular panel filling the opening and writes `.SINGLE_SWING_LEFT.` as attribute 13 — **no swing geometry, no hinge, no door-lining side**. So the IFC carries a handing token that nothing validates, and the 2D plan carries an arc that nothing informs. There is no single place today where "hinge side" and "opens into" are defined; the only truth (`dirIn`) is local to `layoutUnit` and discarded.

Secondary finding: unit furniture is registered into `RoomDef.furnitureIds` twice — once in `layoutUnit` (:1900) and again in `ArchBuilder.crossLink` (arch-elements.ts:392) — so room furniture lists contain duplicates (visible as `items=fridge/fridge` when probing).

---

## 4. templates.ts — the 20 templates

`UnitTemplateDef` (core/types.ts:207-227): `id, name, regionalNames, description, bedrooms, bathrooms, occupants, area{min,target,max}, frontage{min,max}, depth{min,max}, storeysInUnit: 1|2|3, aspect: 'single'|'dual'|'corner', rooms: RoomProgram[], suitableTypologies: TypologyId[], patterns: string[]`.

`RoomProgram` (core/types.ts:190-205): `type, count, targetArea, minArea, minWidth, needsExterior, wet, zone, prefer`. Built by `rp(type, count, targetArea, minArea, minWidth, overrides)` (templates.ts:67-87) with per-type defaults in `ROOM_DEFAULTS` (:35-64) — e.g. `kitchen {needsExterior:false, wet:true, zone:'service', prefer:'front'}`, `bedroom {needsExterior:true, wet:false, zone:'private', prefer:'back'}`. Shared helpers: `bedDouble` (min 11.5 / 2.75), `bedSingle` (7.5 / 2.15), `master` (12.5 / 2.9), `bath` (3.7 / 1.7), `ensuite` (3.4 / 1.6), `powder` (1.8 / 1.1), `entryHall` (2.0 / 1.2), `hall` (2.0 / 1.1), `laundryClo` (1.2 / 0.8), `closets` (0.8 / 0.6), `stairRoom` (3.2 / 1.0) — :90-104.

| id | bed/bath/occ | area min·target·max | frontage | depth | lvls | aspect | rooms (count) |
|---|---|---|---|---|---|---|---|
studio | 0/1/2 | 35·40·45 | 4.2–5.8 | 7.5–9.5 | 1 | single | living-kitchen 25, bath 4.2, entry 3.0, closet, laundry |
micro-studio | 0/1/1 | 22·26·30 | 3.4–4.6 | 6.0–8.0 | 1 | single | living-kitchen 17, bath 3.7, entry 2.2, closet |
junior-1b | 1/1/2 | 45·47·50 | 5.4–6.8 | 7.5–8.5 | 1 | single | living-kitchen 22, bed 11.8, bath, entry, hall, closet×2, laundry |
1b1b | 1/1/2 | 55·58·65 | 6.0–7.8 | 8.5–9.5 | 1 | single | living 20, kitchen 8.5(min w 2.2), bed 13, bath 4.6, entry, hall, closet×2, laundry |
1b-den | 1/1/2 | 65·70·75 | 7.0–8.8 | 8.5–10.5 | 1 | single | living 21, kitchen 9.5(2.4), bed 13.5, **den 7.5 (needsExterior false)**, bath, entry, hall, closet×2, laundry |
2b1b | 2/1/4 | 70·75·80 | 7.5–9.8 | **8.0–8.4** | 1 | single | living 21, kitchen 9(2.3), master 13, bed 11.8, bath, entry, hall 4, closet×3, laundry |
2b2b | 2/2/4 | 85·92·100 | 8.8–11.5 | 8.5–10.5 | 1 | dual | living 25, kitchen 10.5(2.4), master 14.5, bed 12, ensuite 4.4, bath 4.8, entry, hall, walk-in, closet×2, laundry |
corner-2b2b | 2/2/4 | 90·97·105 | 9.0–12.0 | 8.5–10.5 | 1 | corner | as 2b2b, larger (living 27, kitchen 11) |
3b2b | 3/2/5 | 105·115·125 | 10.5–13.5 | 8.5–10.5 | 1 | dual | living 26, **dining 10 (needsExterior false, prefer front)**, kitchen 12(2.6), master 15, bed 12, bed 9.5, ensuite, bath 5, entry, hall 6, walk-in, closet×3, laundry |
4b2b | 4/2/6 | 130·145·160 | 13.0–17.0 | 8.5–9.5 | 1 | dual | living 28, dining 11(int), kitchen 13, master 16, bed 12.5×2, bed 9.5, ensuite 5, bath 5.4, entry 5, hall 8, walk-in, closet×3, laundry 3 |
dual-key | 2/2/5 | 95·108·118 | 11.5–13.5 | 8.0–9.5 | 1 | single | main flat + **lock-off studio (living-kitchen 21, ensuite 3.8)** |
loft-live-work | 0/1/2 | 70·80·90 | 6.5–9.0 | 9.0–11.0 | 1 | single | living-kitchen 40, study 14, bath 4.8, entry, storage, closet, laundry |
maisonette-2s | 2/2/4 | 95·104·115 | 5.4–7.0 | 8.5–10.0 | **2** | dual | L0: living, kitchen, wc, entry, stair, storage; L1: master, bed, bath, hall, closet×2, laundry |
townhouse-2s | 3/2/5 | 110·126·140 | 6.0–7.8 | 8.5–9.5 | 2 | dual | L0: living, dining, kitchen 13, powder, entry, stair, storage; L1: master, bed, bed(single), bath, hall, closet×3, laundry |
townhouse-3s | 3/2.5/5 | 150·180·195 | 6.4–8.0 | 8.0–9.0 | **3** | dual | L0: **garage 19 (min 15, min w 3.0)**, flex, wc, entry, stair, storage; L1: living, dining, kitchen, powder; L2: master, bed×2, bath, hall, closets, laundry |
ranch-3b | 3/2/5 | 140·155·170 | 13.0–18.0 | 9.0–11.0 | 1 | corner | living 30, dining 12, kitchen 15(3.0), master, bed×2, ensuite 5.2, bath 5.4, entry 5.5, hall 6.5, walk-in, closet×3, laundry 4, storage |
colonial-4b | 4/2.5/6 | 200·230·260 | 10.5–14.0 | 9.0–11.5 | 2 | corner | L0: living, dining 15, kitchen 18(3.2), study 12, powder, entry 8, stair, storage; L1: master 18, bed 13/12/11, ensuite 6.5, bath 6, hall 8, walk-in, closet×3, laundry |
adu-1b | 1/1/2 | 40·48·55 | 5.4–7.6 | 6.5–8.5 | 1 | corner | living-kitchen 22, bed 12, bath, entry 2.6, utility, closet×2 |
coliving-cluster | 6/6/6 | 180·212·240 | 9.5–13.0 | **15.0–20.0** | 1 | dual | bedroom ×6 @13.5 (min 12, w 2.75), ensuite ×6 @3.9, shared-living 26, shared-kitchen 16, entry, **corridor 18**, laundry, storage |
senior-1b-accessible | 1/1/2 | 60·65·70 | 6.4–8.2 | 8.5–10.0 | 1 | single | living 22, **kitchen 10.5 min w 2.7**, bed 14, **bathroom 6.5 min w 2.2**, entry 4.5, hall, walk-in, closet, laundry 2.5 |

`UNIT_LEVEL_SPLIT` (:728-746) lists per-level room counts for `maisonette-2s`, `townhouse-2s`, `townhouse-3s`, `colonial-4b`; consumed by `programForLevel` (unit-layout.ts:272-306), which warns if a multi-storey template lacks a split.

**Per-template minima that exist:** `frontage.min/max`, `depth.min/max`, `area.min/target/max`, and per-room `minArea`/`minWidth`. **Who enforces them:** only `minFrontage`/`frontageOf`/`narrowPool` (frontage, scaled by depth) and `fitWidths` (room `minWidth`). `depth.*` and `area.*` are effectively advisory (see §1.4 table). `aspect` and `suitableTypologies` are declared but never checked by the organiser (`suitableTypologies` is only used by `templatesForTypology` :759, which nothing in the generation path calls).

**Unit-mix consumption:** `spec.unitMix ?? typology.defaultUnitMix` (core/spec.ts:56), per-floor `FloorSpec.unitMix` (core/types.ts:281), UI editing in `src/app/form.ts:290-420` → merged by `mixPool` (floor-organizer.ts:144) → weighted per-bay draw. `targetUnits` (if set) is apportioned across strip intervals with `apportion` (floor-organizer.ts:625-627).

---

## 5. furniture.ts + the placement rules in unit-layout.ts

### 5.1 `FurnitureSpec` / `FurnitureDef`

`FurnitureSpec` (furniture.ts:19-30): `{ w, d, h, needsWater?, needsPower? }` — **2D footprint + height only; no 3D representation hint, no model reference, no symbol id.** The IFC mapping is a separate table `FURNITURE_IFC` (arch-elements.ts:163-176: fridge → `IfcElectricAppliance/FRIDGE_FREEZER`, wc → `IfcSanitaryTerminal/TOILETPAN`, …) and the geometry is always `{ kind: 'box', position, width, depth, height, rotation }` (arch-elements.ts:622). 2D plan draws the box plus a one/two-letter glyph (`FURN_GLYPH`, plan-svg.ts:73-84).

`FurnitureDef` (core/types.ts:671-686): `id, storey, roomId, unitId?, type, position: Vec2 /* footprint min corner BEFORE rotation about that corner */, width, depth, height, rotation, needsWater?, needsPower?`.

Catalogue (furniture.ts:33-88), 45 entries, metres:

- **Beds/bedroom** bed-king 1.93×2.03×0.6, bed-queen 1.52×2.03, bed-double 1.37×1.9, bed-single 0.99×1.9, bed-bunk 0.99×1.9×1.7, nightstand 0.5×0.4, wardrobe 1.2×0.6×2.1, dresser 1.2×0.5, crib 0.7×1.3
- **Living/study** desk 1.2×0.6 (power), chair 0.45×0.45, sofa-3 2.1×0.9, sofa-2 1.6×0.9, armchair 0.85×0.85, coffee-table 1.2×0.6, tv-unit 1.6×0.45 (power), dining-table-4 1.2×0.8, dining-table-6 1.8×0.9, dining-chair 0.45×0.45, shelving 0.9×0.35×2.0, bookcase 0.9×0.35×2.0, lounge-chair 0.75×0.85, bench 1.2×0.4
- **Kitchen** kitchen-counter 1.2×0.6 (w stretched per run segment), kitchen-island 1.8×0.9, fridge 0.9×0.75×1.8 (power), range 0.76×0.65 (power), dishwasher 0.6×0.6 (**water+power**), kitchen-sink 0.8×0.6 (**water**)
- **Bath/laundry** wc 0.4×0.7, lavatory 0.6×0.5, vanity 0.9×0.55, shower 0.9×0.9×2.0, bathtub 1.7×0.75, washer 0.6×0.6 (water+power), dryer 0.6×0.6 (power), water-heater 0.6×0.6×1.5 (water+power), grab-rail 0.6×0.05
- **Outdoor/common/parking** planter, outdoor-table 0.8×0.8, bike-rack 1.8×0.6, mailbox-bank 1.2×0.4, reception-desk 2.4×0.8, treadmill 0.9×2.0 (power), car 1.8×4.5×1.5

`CLEARANCE` (:91-114): `bedSide 0.75, bedFoot 0.7, kitchenAisle 1.2, turningCircle 1.5, wcFront 0.75, wcSide 0.4, lavatoryFront 0.7, diningPull 0.75, sofaCoffee 0.4, sofaTv 2.2, wall 0.02`. `WATER_ITEMS`/`POWER_ITEMS` (:134-139) are the plumbing/electrical hooks.

### 5.2 Placement engine

`furnishRoom(room, ctx: FurnishCtx)` (unit-layout.ts:2201-2312). The gate is `place(type, aabb, face, override?)` (:2208-2244): rejects if the box is degenerate, **not fully inside `inner = insetLocal(room.local, 0.02)`**, overlaps anything already `taken`, or overlaps any `ctx.swings` rect. On success it converts to world via `frame.toWorldRect`, sets `rotation = facingOf(frame.dir(face))` (0 / π/2 / π / 3π/2) and picks the rotated min corner (:2223-2226). `probe(aabb)` (:2246-2253) is the same test without committing. Helpers: `rankedWalls` (:2321-2334, penalises exterior walls −4 and swing-covered walls −6, prefers longer walls ×0.4), `bestBackWall`, `againstSide` (:2350-2357), `offsetFrom`, `sideCentre`, `sideLength`, `offsets(spare)` (:2620-2626, centred then a 100 mm sweep).

Per-room rules: `furnishBedroom` (:2371-2435, bed size by area/master/accessible, headboard on the best-ranked wall, nightstands, wardrobe search over two passes, dresser at high detail), `furnishLiving` (:2437-2492, sofa on the best wall, coffee table, TV opposite, armchair, dining if > 24 m², and a bed for studio `living-kitchen`), `furnishDining` (:2503-2525), `furnishKitchenRun` (:2528-2617), `furnishBathroom` (:2628-2750), `furnishGrabRails` (:2753-2770, accessible only), `furnishLaundry` (:2772-2806), `furnishStore`, `furnishEntry`, `furnishStudy`, `furnishBalcony`, `furnishGarage`.

### 5.3 Why a kitchen ends up with no sink / a bathroom with no WC

`furnishKitchenRun` (:2528-2617): picks the run wall from `wetEdge` (:2529), insets by `SIZES.wetWallT/2` (:2530-2536), builds a sequence — full run `fridge, counter, range, counter, sink, dishwasher, counter` (:2560-2571); short run cascades to `fridge/range/sink`, then `range/sink` + `fridgeOnReturn`, then `sink` only (+ warning), then "kitchen fixtures reduced" (:2546-2559). Then:
```ts
let cur = start + max(0, (along - Σw)/2);
for (const s of seq) {
  const p = againstSide(runInner, side, s.w, d, cur + s.w/2);
  const f = place(s.type, p.aabb, p.face, { w: s.w, d });   // :2578
  if (f) spots[s.type] = …;                                  // silently ignored on failure
  cur += s.w;
}
```
**No offset sweep, no alternative wall, no per-item warning.** Any obstruction in the middle of the run — most often a door-swing rect from `addSwing` — silently deletes the range, sink and dishwasher while the fridge (laid first) survives. Verified: on `us-5-over-1`, 5 kitchens and on `ie-courtyard`, 3 kitchens end up with **only a fridge**; e.g. `R-U-L02-06-KITCHEN1`, 3.24 × 3.20 m in a 2b2b, carrying one 0.9×0.6 fridge and two doors, one of which is `interior/SINGLE_SWING_LEFT` 0.8 m. Plumbing then warns `kitchen had no sink in the furniture; synthesised one on the wet wall` (plumbing/fixtures.ts:233-255).

`furnishBathroom` is more robust: `fixturesFor(along)` (:2646-2663) composes `wc + lavatory` (powder/wc), `wc(0.45) + vanity + shower(1.5×0.9)` (accessible), or `wc + vanity|lavatory + bathtub|shower`; it then tries `[wetSide, …lateral, oppSide(wetSide)]` × `offsets(spare)` with `probe` before committing (:2680-2705) — hence warning ➏ when only the opposite wall works. Fallbacks: turn the shower/tub onto a lateral wall (:2707-2725), pop items until the run fits (:2726), retry any wall (:2728-2740), and finally place item-by-item **warning per failure** (`no clear position for the {type} in a … room`, :2741-2748). A bathroom therefore loses fixtures only when the room is genuinely too small — or when `options.furniture === false`, in which case plumbing's synthesis path (plumbing/fixtures.ts:184-231, `bathroom furniture missing (wc); synthesised wc/lavatory/shower on the wet wall 0.4 m off the face`) covers it.

---

## 6. cores.ts, common-rooms.ts, envelope.ts, arch-elements.ts, bar-frame.ts

### 6.1 What a "core" is

`CoreLayout` (cores.ts:33-63) — computed **once for the whole building** by `planCores(b, placements, bars, storeys, spec, access)` (:68-307), so it repeats identically on every storey (ARC-08):
```ts
id, placement: CorePlacement, rect /* gross, wall centrelines */, net /* inset by coreWallT/2 */,
barId, stair: StairGeom{rect, runAxis, laneSpan, width}, liftBank: Rect|null, liftRects: Rect[],
lobby: Rect|null, shaftBlock, combinedShaft, trashShaft, storage: Rect|null,
corridorSide: Side, exteriorSides: Side[], blocked: Interval, storeys: string[],
elevatorCount, coreDef: CoreDef, elevatorDefs: ElevatorDef[], shaftDefs: ShaftDef[], frame: BarFrame
```
Slotting: a 2.4 m **shaft bay** (`BAY_LEN`) is carved off the placement along the bar when `alongLen − 2.4 ≥ 2.55` (:94-100), otherwise an external bay is attempted (:190-215, warns `no room for a shaft bay beside the core … shafts omitted`). The net is sliced along its long axis into **stair | lift bank (`LIFT_SLICE = 2.3`) | lift lobby (≥ 1.2)** (:136-168); the stair needs `risersPerFlight * stairTreadMin + LANDING_MIN(1.1) + 0.1` of run, else the slice runs across (:142-150, warns if under `2*stairWidth + 0.1`). Lift cars: `floor(bankAcross / (elevatorShaftW − 0.05))` (:170-183). Bay contents: `combinedShaft` 1.2 × 0.8 M/E riser, `trashShaft` 1.0 × 1.0 when storeys ≥ 4, remainder ≥ 1.6 m → `storage` (:198-212). `corridorSide` is chosen from the access type (:107-126). Relevant `SIZES` (core/coordination.ts:96-123): `coreWallT 0.25, shaftWallT 0.15, stairWidth 1.1, stairRiserMax 0.18, stairTreadMin 0.28, elevatorShaftW 2.0, elevatorShaftD 2.2`.

`buildCoreOnFloor(b, core, f, streetFacing, env?)` (:319-501): perimeter walls (reusing envelope segments where exterior, :326-350), stair room + `StairDef` + two `StairRun`s with tread reduction and a warning (:352-411), lift shaft rooms + separating shaft walls + a lift car element at ground (:413-430), stair/bank enclosure walls + lift lobby room (:432-454), stair door off the lobby (0.95 m), lobby→corridor door (1.4 m, `DOUBLE_DOOR_SINGLE_SWING`), exit door to outside at ground (:456-486), shafts and resident storage via `enclose` (:488-500). Helpers `coresFor` (:521-526), `coreBlockedIn` (:529-534), `coreAcrossIn` (:537-542), `deckRailing` (:549-552).

### 6.2 `ArchBuilder` — how elements are emitted

`ArchBuilder` (arch-elements.ts:230-405) holds `walls, doors, windows, rooms, furniture, units, cores, stairs, stairRuns, elevators, shafts, balconies, corridors, floors, patterns, late[]`. Signatures:
```ts
addWall(input: AddWallInput): WallDef            // :294-322  — DEDUPES on storey+endpoints+thickness (wallKey :407)
adoptWall(wall: WallDef): void                   // :325-329  — register a wall made by unit-layout
addDoor(input: Omit<DoorDef,'id'>): DoorDef      // :331-335
addWindow(input: Omit<WindowDef,'id'>): WindowDef// :337-341
addRoom(input: AddRoomInput): RoomDef            // :343-372  — rect|polygon, auto name/zone/isWet/occupancy
addFurniture(input: Omit<FurnitureDef,'id'>)     // :374-378
apply(app: PatternApplication): void             // :380-382
crossLink(): void                                // :385-404  — rooms ↔ doors/windows/furniture/walls
warn(msg) / flushWarnings()                      // :266-285  — first 3 verbatim per normalised key, rest rolled up
```
`emitElements(b, {ceilingHeight, unitTemplateOf, detail})` (:426-678) emits in strict phase order **walls → doors → windows → spaces → furniture → stair runs → late**, so a `door-in-wall` always follows its host `wall`; `mint()` guarantees unique ids. Late-element constructors: `railingElement` (:704), `slabElement` (:724), `slabElementPoly` (:747), `liftCarElement` (:770), `rampElement` (:795), `gableRoofElement` (:813), `zoneProxyElement` (:843).

### 6.3 Envelope, windows vs WWR, balconies

`EnvelopeBuilder` (envelope.ts:33-142): the constructor offsets the floor outline inward by `exteriorWallT/2` and splits it into axis-aligned `EnvelopeEdge{side, across, a0, a1, exposure, breaks[], walls[]}`. Protocol: every organiser registers breakpoints first (`addSpan`/`addBreak`), then `build(b)` cuts each edge at its breaks (≥ 0.2 m apart) and creates the `WallDef`s; consumers then *look up* segments with `wallFor(side, across, a0, a1)` (largest overlap) or `wallsFor(...)`. `instantiateFloor` registers breaks for every unit, common room, corridor and core **before** `env.build(b)` (floor-organizer.ts:1212-1217).

Two glazing paths:
1. **Unit windows** — `layoutUnit` (:1742-1876). Per exterior boundary wall: `budget = clamp(req.wwr, 0.12, 0.85) × sideLen × floorToFloor`, shared between the rooms on that wall in proportion to `span × glazeWeight(roomType)` (`GLAZE_WEIGHT` :124-131: living/kitchen 1.3, bedroom 1.0, bath 0.4, hall/closet/stair/garage 0). Sill = 0.6 m for `GLAZE_LOW_SILL` rooms when `wwr > 0.4 || f2f ≥ 3.3` else `SIZES.windowSill 0.9`; head clamped below the soffit and the ceiling. Sashes 0.9–2.8 m, positions reserved through `makeOpeningTracker` (:1298-1339) so no two openings collide. A `must-have` rule forces ≥ 0.9 m in any daylit room with no window yet (:1762-1765). A second pass spends leftover budget on the highest-appetite rooms (:1854-1871). Balcony doors count as glazing at `DOOR_GLAZED = 0.8` (:1824, :1842).
2. **Common rooms / corridor ends / core** — `glazeWall(b, wall, roomId, {wwr, sill, height, maxWidth, pier}, unitId?)` (envelope.ts:157-186): counts sashes from the target, enforces a 0.6 m pier, returns the placed area.

Floor WWR is *measured*, not imposed: `FloorPlan.wwr = windowArea / exteriorWallArea` (index.ts:200), `derived.wwr` (index.ts:387).

**Balconies** are made in `buildUnit` (floor-organizer.ts:1369-1379, 1492-1521): side = `oppositeSide(accessSide)`, depth = `spec.massing.balconyDepth`, gated on `f.balconies && depth > 0.5 && exteriorSides.includes(side) && level === levelsTotal−1 && balconyIsClear(...)`. `balconyRect` (:1608-1616) is the net rect's face inset 0.3 m each end, projected outward. `layoutUnit` creates the `RoomDef` (outside the net rect) and the sliding door (:1505-1528, :1663-1692, host chosen by `pickBalconyHost` :2042-2047: living > dining > bedroom); the organiser adds the `BalconyDef`, a 0.15 m slab (`slabElement`) and three railings (:1511-1521).

`bar-frame.ts` also supplies the interval algebra everything is built on: `mergeIntervals` (:97), `subtractIntervals(base, cuts, minLen)` (:109-120), `apportion(total, weights, maxPer?)` largest-remainder (:123-147), `sideSpan(rect, side)` (:80-87), `rectFromAC` (:54).

### 6.4 Common rooms

`groundProgram` (common-rooms.ts:44-65) = street `[lobby 42 m² + building entry, mail 9, (lounge 38 if no amenity floor)]`, rear `[bike-store, trash 16, mech-room 20, elec-room 12, water-room 9]`; `retailProgram` (:68-84) one 120 m² tenancy per module with a `sill 0.3 / height 3.0 / wwr 0.75` shopfront; `amenityProgram` (:86-95); `clusterAmenityProgram` (:97-103). `programLength` (:109-111) and `sliceProgram(frame, iv, c0, c1, items, exteriorSides, from)` (:117-157) lay them along a reserved interval, dropping what doesn't fit. `buildCommonRoom` (:168-241) makes the room, enclosing walls (unless `slot.open`), the access door, the external entrance and the glazing. `furnishCommonRoom` (:254-301) is a hard-coded per-type sprinkle.

---

## 7. Patterns — registration and traces

`PatternBook` (core/patterns.ts:10-35):
```ts
register(...patterns: Pattern[]): void   // throws on id collision
apply(app: PatternApplication): void     // throws if the pattern was never registered
get(id) / all() / byDiscipline(d) / trace(): PatternApplication[] / merge(apps: PatternApplication[])
```
`Pattern` (core/types.ts:446-459): `{ id, name, discipline, problem, solution, parameters: Record<string, PatternParameter{value, unit?, source?}>, dependsOn?, references? }`.
`PatternApplication` (core/types.ts:461-469): `{ patternId, storey?, unitId?, elementIds?, params?: Record<string, number|string|boolean>, note? }`.

Wiring: `pipeline.ts:25` registers `CROSS_PATTERNS + SITE_PATTERNS + ARCH_PATTERNS + …` once, then merges every discipline's `applications` into the book. Architecture exports `ARCH_PATTERNS = [...FLOOR_PATTERNS, ...UNIT_PATTERNS]` (index.ts:44).

Two recording paths:
- **Floor level** — `ArchBuilder.apply(app)` (arch-elements.ts:380), called from `recordPatterns(ctx, b, floors, cores, derived)` (index.ts:435-577) for ARC-01/02/03/05/06/07/08/09/10/11/12/13/31/33/34 + XD-01, and inline from `planCores` (cores.ts:285-305: ARC-04, ARC-32, XD-04), `buildRoof` (envelope.ts:272-282: ARC-35) and `buildUnit` (floor-organizer.ts:1488: ARC-11).
- **Unit level** — `buildPatternApplications(c: PatCtx)` (unit-layout.ts:2911-3092) returns `PatternApplication[]` for ARC-14/15/16/17/18/19/20/21/22/23/24/25/26/27/28/29/30/36 + XD-01/XD-05 with concrete measured params (e.g. ARC-16 `achievedWwrGlazable`, `meetsTarget`; XD-01 `stackAtU`, `stackHonoured`, `wetBandFrom/To`; ARC-28 `swingDoors`, `casedOpenings`). The organiser re-stamps them with `unitId`/`storey` (floor-organizer.ts:1455).

`PatCtx` (:2886-2909) is the data a new rule would receive: `{req, rooms: RoomRec[], walls, doors, windows, furniture, plan: PlanResult, wetWallIds, triangle, storageM3, accessible, frame, glazedArea, facadeArea, glazableArea, mergedRooms, stackAtU, stackWantU}`. This is the natural hook for a rule/constraint system: it already has the full per-unit geometry and a typed params bag. Also relevant: patterns are *only* additive records — no pattern can fail a build or block an element today (`Pattern.parameters` are documentation, not constraints), and the app renders them read-only (`src/app/patterns-view.ts`).

---

## 8. Tests

| File | Coverage |
|---|---|
`architecture.test.ts` (496) | `assertArchInvariants` (:68-198): no NaN in any element/room/wall/derived; unique element/wall/room ids; every door/window references an existing wall; **hosted elements come after their host wall in the element stream**; every unit has an entry door in an existing wall; units don't overlap and lie inside the floor outline; rooms don't overlap within a storey (≤ 0.5 % tolerance); floor plans coherent (`wwr` in 0…1.2); pattern applications reference registered patterns. Then: per-`FixtureKind` generation (:205), `makeSiteFixture` sanity (:231), **corridor efficiency 0.55–0.90** (:241), **typical floor repeats — L03/L04 identical rects (ARC-08)** (:253), **wet walls and shafts stack, identical x/y per floor (XD-01/ARC-32)** (:268), cores/stairs/lifts/shafts on every above-grade storey (:282), 12-storey point tower < 1.5 s (:306), houses (ARC-01/02/11) (:316), flat roof parapets + plant/PV zones (:331), balcony slab + railings (:343), ground lobby sequence (:359), deck access ARC-09 (:371), stair-core ARC-07 (:382), pattern book completeness (:392), determinism for a fixed seed (:412), warnings tagged `[architecture]` (:423), **`layoutUnit` contract holds for a foreign implementation** (swaps in `FALLBACK_TEMPLATES` + `stubLayoutUnit`) (:430), and all 10 presets against the real site module (:464). |
`unit-layout.test.ts` (880) | Catalogue self-consistency incl. `recommendedRect` inside the declared ranges (:225); furniture catalogue ≥ 45 entries with plausible dims and correct water/power flags (:258); unit pattern book ARC-14…30 (:273); **per-template × per-level invariants** (:296-534): ≥ 92 % and ≤ 102 % tiling, no pairwise overlap, rooms inside the rect, balcony outside it, every `needsExterior` room has a window, **every room has ≥ 1 door**, entry door inside the access wall, no overlapping openings per wall, window sill/head/width limits, interior walls have both left/right rooms and a unique room pair, wet walls bound the kitchen and a bathroom, furniture inside its room and non-overlapping, every bedroom has a bed, identical stair rect per level, unique ids, no NaN. Plus accessible unit (:540), cluster (:555), dual-key (:569), corner ARC-26 (:583), townhouse-3s level split (:593), regional vocabulary (:602), determinism (:611), **degrades in a far-too-small rect** (:619), **every access side + a rotated rect give the same plan quality** (:632), four ARC-36 through-flat tests (:723-808), three ARC-16 glazing tests (:809-863), 20 templates < 50 ms (:864). |
`test-fixtures.ts` (647) | `makeSiteFixture(kind)` / `makeFixture(kind, override)` for `'bar-double' | 'point' | 'townhouse' | 'walkup' | 'gallery'`, `FALLBACK_TEMPLATES`, `stubLayoutUnit`. |

**Not covered anywhere:** door swing/hinge direction, the 2D arc convention (`src/app/render.test.ts` and `svg.test.ts` do not assert door arcs), template↔rect fit (frontage/depth/area range conformance), delivered-vs-requested unit mix, corridor length limits, fixture-to-stack distance, or "every kitchen has a sink / every bathroom has a WC" (the bedroom↔bed assertion exists; the kitchen/bath equivalents do not).

---

## 9. Assessment — what has to change, and where the seams are

### (i) Guarantee template↔rect fit — choose modules that fit, not templates forced into rects

The whole assignment path is "pick a template, then deform it": `choosePicks` → `narrowPool` → `fitFrontages` (floor-organizer.ts:195-339). Those three functions are the entire seam, and they are self-contained: `packStrip` only needs `{templateId, template, frontage}[]` back. Concretely:

- **Invert the query.** Add a `fitsRect(template, frontage, depth) → {ok, slack, violations}` predicate next to `minFrontage`/`frontageOf` (:177-185) and make the *module library* the source of truth for feasible `(frontage, depth)` pairs, replacing `frontageOf`'s "area / depth" guess. `recommendedRect` (templates.ts:783) already exists unused and is the obvious starting shape.
- **Replace the per-bay weighted draw** (`weightedIndex`, :226/264) with an assignment/packing solve over the whole strip against mix quotas. `apportion` (bar-frame.ts:123) is already the right primitive for quotas; today it is only used for `targetUnits`. This is what fixes the mix drift (3b2b delivered 0 %, corner 57 % vs 17 %).
- **Kill the deformation escapes**: `fitFrontages`'s `list.pop()` (:298) and the inflate-to-`frontage.max*1.2` branch (:328) must become "choose a different module" or "declare a remnant", not "stretch/drop".
- **Enforce depth.** Nothing checks `t.depth.min/max` against the rect (that is why `ie-courtyard` has 171/171 units out of range). `packStrip` already computes `netDepth` at :382 — that is the one line where the depth filter belongs, and the bar depth per storey is known in `FloorCtx.bars`.
- Keep `FloorLayout`/`planKey` caching (index.ts:141-147) intact — it is what makes stacking work and it is orthogonal to how modules are chosen.

If modules are pre-validated at their declared rects, most of `unit-layout.ts`'s degradation machinery (`fitWidths` squeeze branch :351-372, the `planRegion` eviction loop :551-562, `planThrough`'s column dropping :1005-1020) becomes dead code, which is what eliminates warnings ➊➋➌➍➐➑ **by construction**.

### (ii) Guarantee wet-wall / stack proximity for all fixtures

Today: `stackAlong`/`wetWallSide` in, `slideWetCluster` re-orders columns, `wetStackU` reports where the stack ended up — and nothing measures a fixture. Seams:
- `furnishKitchenRun` (:2528) and `furnishBathroom` (:2628) already know the run wall (`wetEdge`) and the stack's `u`; add `dist(fixtureCentre, stackXY) ≤ maxTrapArm` as a *placement constraint* in `place()` for `needsWater` items (:2208), not a post-hoc check.
- Persist the stack point in `UnitLayout` (it is currently only a pattern param at :2933) so `UnitInstance`/plumbing consume one authoritative value instead of `chooseWall` re-deriving it (plumbing/fixtures.ts:174, 190, 239).
- In a module library, the wet wall and the stack station become *properties of the module*, pre-validated; `slideWetCluster` then only has to pick which end of the band faces the corridor.

### (iii) Always produce complete fixture sets

The single highest-value fix is small and local: `furnishKitchenRun`'s placement loop (:2576-2581) needs the treatment `furnishBathroom` already has — the `offsets(spare)` sweep (:2620-2626, :2692), a fallback wall list, and a warning when an individual item fails. Then add the missing invariants as *tests* (kitchen ⇒ `kitchen-sink`; bathroom/wc/powder ⇒ `wc` + basin), mirroring the existing "every bedroom has a bed" assertion (unit-layout.test.ts:492-496). Also make the door-swing rect part of the module's pre-validation so a swing can never sit on a fixture run. Downstream, plumbing's synthesis paths (plumbing/fixtures.ts:184-255) should stay as a belt-and-braces net but stop firing.

### (iv) Make door swings deterministic and correct

This is a contract gap, not an algorithm gap, and the correct answer is already computed and discarded.

1. **Extend `DoorDef`** (core/types.ts:634-648) with an explicit, documented convention — e.g. `hinge: 'start'|'end'` (which end of the opening along the host wall) and `swingInto: 'left'|'right'` **relative to the host wall's stored `start→end` direction** (or, more robustly, `swingIntoRoomId: string`). `core/types.ts`'s coordinate-conventions header (lines 4-19) is where the convention must be written down.
2. **Populate it at the source**: unit-layout.ts:1733-1739 already computes `dirIn`; convert it to the new field at the point where the `DoorDef` is pushed (:1727-1730). Same for the entry door (:1628-1634, currently hard-`'v+'`), the balcony/garage doors, `cores.ts:460-485`, `common-rooms.ts:204-225` and `floor-organizer.ts:1482-1489, 1505-1509, 1561-1565`.
3. **Consume it in `plan-svg.ts:287-302`** instead of `along().nrm`; and skip the leaf+arc entirely for `SLIDING_*`, `*_FOLDING`, `ROLLINGUP` and `NOTDEFINED` (currently all drawn as 90° swings — 140/170 closet doors and all 80 service doors are drawn wrong today).
4. **Normalise the wall-direction convention**, or stop depending on it. Two conventions coexist: `rectEdges` CCW (left normal inward — cores, common rooms) vs ascending-coordinate (`envelope.ts:101-109`, `floor-organizer.ts:1344-1345`, `unit-layout.ts:1558-1559`, left normal inward only for `front`/`right`). Either flip the ascending walls to a CCW-consistent order, or make the door carry the room reference so direction no longer matters. The second is safer, because walls are deduped by unordered endpoints (`wallKey`, arch-elements.ts:407-413) and a shared wall has no natural owner.
5. **Map to IFC properly**: `writer.ts:755` passes `operation` straight through; with real handing you can emit `SINGLE_SWING_LEFT`/`RIGHT` truthfully and (optionally) a door-lining/panel placement. Note the vendored creator draws a flat panel (`ifc-creator.ts:699-735`), so IFC is *metadata-only* today — the 2D plan is the only place the error is visible, and the only place a fix is visually verifiable.
6. Add the regression test that doesn't exist: for every door with a `toRoomId`, the swing region must lie inside that room (the probe I used above, 537/822 failing, is a ready-made assertion).

### (v) Break long corridors

Three seams, in dependency order:
- **Site** — `buildCorridors` (site/massing.ts:815-848) emits one spine per bar spanning the whole bar. If corridors should be segmented by design, either emit multiple spines per bar with gaps at break positions, or (better) let architecture own segmentation and treat the spine as a centreline hint.
- **Core placement** — `placeCores` (site/massing.ts:856+, `spec.massing.coreCount` at :948/:1097) currently puts cores *beside* the corridor band (`us-5-over-1`: cores at `y 3..12.15` and `13.85..23`, band between them), so `corridorBlocks` (floor-organizer.ts:550-555) is always empty and `subtractIntervals` never cuts. Making at least some cores/lift lobbies span the band is the cheapest structural fix.
- **Architecture** — the real seam is `planCorridorFloor` lines 549-571. Insert break nodes into `corridorSpan` before `subtractIntervals`: derive break positions from `ARC-03.maxLegLength` (patterns.ts:45-62, `maxLegLength: 45`), reserve them as `CommonRoomSlot`s (a lounge, a widened lift lobby, a light well, or a cross-corridor to the opposite face) using the existing `pickInterval`/`sliceProgram` machinery, and let the existing per-segment `daylitEnds` logic glaze them. Then the warning at index.ts:362-365 becomes unreachable, and `CorridorDef.centerline` (already typed `Segment2[]`, core/types.ts:738) can hold a real polyline for cross-corridors — today it is always a single segment (floor-organizer.ts:1242-1244), and `computeDerived` measures `Math.max(...)` over segments (index.ts:350, 363), so a polyline would need that to become a sum/graph traversal.

### For the interactive editor (c)

There is no editing path today. `buildPlan(model, storeyId, layers, units, highlight) → Drawing {body, defs, hits: Hit[], bounds, counts}` (plan-svg.ts:153) is pure SVG-string generation; `Hit {id, kind, label, x0,y0,x1,y1, meta}` (:21-27) plus `pickHit(hits, x, y, tol)` (:644) already give selection and inspection, and `Viewport` (app/viewport.ts:40) handles pan/zoom. `state` (app/state.ts:50) is a single mutable object with `subscribe`/`emit`/`setState`, and generation is one-shot `run()` → `backend().generate(spec)` (app/backend.ts:9-41). The editor's natural insertion point is between `FloorLayout` and `instantiateFloor`: `FloorLayout` (types-internal.ts:99) is already a small, serialisable, storey-independent description of the floor (unit rects + template ids + corridors + commons), it is already cached by `planKey`, and `instantiateFloor` is a pure function of it. Making `FloorLayout` an editable, round-trippable document — with `layoutUnit` re-run per edited slot — is the smallest change that gets an editor, and it composes with (i): a module library is exactly what a user would drag into a `UnitSlot`.
