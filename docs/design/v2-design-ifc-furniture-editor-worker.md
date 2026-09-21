# Design: IFC furniture type library (mapped items), editor internals, worker generation

_Generated 2026-09-21 by a read-only design pass; consumes the frozen contracts F1–F8. Corrections adopted into the contracts: per-length counter types (FT-<type>-w<cm>), Solid.axis, ~4.0 entities per furniture occurrence (budget ≤ 5.0 incl. library)._

# v2 design pass: IFC furniture type library · editor internals · worker generation

Contracts F1–F8, `OverrideDoc`/`LayoutEdit`/`UnitEdit`, `DoorDef` v2, `Slot`/`FloorLayout` v2, `RuleOverrides`, `Issue`/`Ledger` are consumed as frozen. Line anchors below are current-state (pre-change).

---

# PART 1 — IFC furniture type library with mapped items

## 1a. `src/core/furniture-3d.ts` (new, ~640 lines)

```ts
export type SolidAxis = 'z' | 'x' | 'y';        // extrusion direction, default 'z'
export type Solid =
  | { kind: 'box';     x: number; y: number; z: number; w: number; d: number; h: number; axis?: SolidAxis; color?: RGB }
  | { kind: 'cyl';     x: number; y: number; z: number; r: number;  h: number; axis?: SolidAxis; color?: RGB }
  | { kind: 'ellipse'; x: number; y: number; z: number; rx: number; ry: number; h: number; axis?: SolidAxis; color?: RGB }
  | { kind: 'prism';   x: number; y: number; z: number; poly: Vec2[]; h: number; axis?: SolidAxis; color?: RGB };

export type FurnitureIfcType =
  | 'IfcFurnitureType' | 'IfcSanitaryTerminalType' | 'IfcElectricApplianceType' | 'IfcBuildingElementProxyType';

export interface FurnitureTypeDef {
  id: string;                       // 'FT-<furnitureType>' | 'FT-<furnitureType>-w<cm>'
  furnitureType: FurnitureType;
  ifcType: FurnitureIfcType;
  predefinedType?: string;
  footprint: { w: number; d: number };   // === FURNITURE_CATALOG[t].{w,d} exactly
  height: number;                        // = max(z+h) over solids; >= FURNITURE_CATALOG[t].h
  solids: Solid[];                       // 3–8
  symbol: Vec2[][];                      // top-view plan rings, local coords, precomputed
  stretch?: 'x' | null;
}

export const FURNITURE_TYPES: Record<FurnitureType, FurnitureTypeDef>;
export function typeById(id: string): FurnitureTypeDef | null;        // parses '-w<cm>', memoised
export function stretchKey(t: FurnitureType, w: number): string;      // the geometry id for an instance
export function furnitureTypeAt(t: FurnitureType, w: number): FurnitureTypeDef;
export function symbolFromSolids(solids: Solid[], height: number, topFrac?: number): Vec2[][];
export const STRETCH_QUANTUM = 0.10;
export const OCCURRENCE_OF: Record<FurnitureIfcType, string>;         // → 'IFCFURNISHINGELEMENT' etc.
```

**Local frame.** Origin = footprint **min corner**, +x width, +y depth, +z up, z=0 at floor — identical to `ElementGeometry.box.position` and `FurnitureDef.position` (core/types.ts:677), so nothing upstream changes. For `box`/`prism`, `x,y,z` is the solid's own min corner (`prism.poly` relative to `x,y`); for `cyl`/`ellipse`, `x,y` is the **centre** (because `addCircleProfile` centres the profile at the 2D origin). `axis` exists so portholes, grab rails and car wheels extrude sideways; it costs nothing (the direction entity is cached).

**`height` vs `FURNITURE_CATALOG.h`.** `FURNITURE_CATALOG.h` stays the *layout engine's* clear height (unchanged, it feeds kit minima). `FurnitureTypeDef.height` is the real bounding height, which is larger for 6 items (tv-unit 1.07, kitchen-sink 0.49, lavatory 1.02, water-heater 1.50, planter 0.85, shower 2.03). Plan/axon/writer use `FurnitureTypeDef.height`. Test: `footprint` equals catalogue w/d to the byte; `height >= catalog.h`; the six deltas are asserted explicitly so a future edit cannot silently grow an item.

**Colours** (per solid, RGB 0–1): `W` wood `[0.72,0.58,0.42]` · `F` fabric `[0.55,0.58,0.62]` · `N` appliance white `[0.94,0.94,0.92]` · `M` metal `[0.72,0.74,0.76]` · `G` glass `[0.72,0.82,0.86]` · `K` dark `[0.22,0.23,0.25]` · `T` mattress `[0.88,0.87,0.83]` · `C` ceramic `[0.96,0.96,0.94]` · `V` foliage `[0.42,0.55,0.35]` · `R` rubber `[0.20,0.20,0.22]` · `S` car body `[0.35,0.42,0.52]`. `FURNITURE_COLOR` (arch-elements.ts:150-161) stays as the `detail:'low'`/IFC2X3 box colour.

**The 45 types.** Shorthand: `B x,y,z w×d×h C` box · `Y x,y,z r×h C` cylinder · `E x,y,z rx,ry×h C` ellipse · `P` prism · `[x]`/`[y]` = `axis`. Written as five parametric builders (`bed`, `carcass`, `table`, `seating`, `appliance`) plus per-type literals, so the file is data, not 45 hand-rolled blocks.

| type | n | solids | ifcType / predef |
|---|---|---|---|
| bed-king 1.93×2.03×.6 | 6 | frame B .05,.05,.10 1.83×1.93×.25 W · mattress B 0,0,.35 1.93×2.03×.22 T · headboard B 0,1.98,0 1.93×.05×.95 W · 2 pillows B .10/.98,1.55,.57 .85×.40×.10 N · duvet B 0,0,.56 1.93×1.30×.04 F | Furniture / BED |
| bed-queen 1.52×2.03 | 6 | `bed()` builder, 2 pillows .66 wide | Furniture / BED |
| bed-double 1.37×1.9 | 6 | `bed()`, 2 pillows .60 | Furniture / BED |
| bed-single .99×1.9 | 5 | `bed()`, 1 pillow .70 | Furniture / BED |
| bed-bunk .99×1.9×1.7 | 8 | 2× frame B z .30/1.20 · 2× mattress T · 4 posts Y r.03×1.70 M | Furniture / BED |
| nightstand .5×.4×.55 | 4 | carcass B 0,0,.05 .5×.4×.50 W · plinth K · drawer front B .02,−.01,.30 .46×.02×.20 W · knob Y .25,−.02,.40 .015×.02 M | Furniture / TABLE |
| wardrobe 1.2×.6×2.1 | 6 | carcass · plinth K · 2 doors B .585×.02×2.0 W · 2 handles Y .012×.10 M | Furniture / CABINET |
| dresser 1.2×.5×.8 | 5 | carcass · plinth · 3 drawer fronts W | Furniture / CABINET |
| crib .7×1.3×.9 | 6 | base B z.35 · mattress T · 4 rail frames B t.04 W | Furniture / BED |
| desk 1.2×.6×.75 | 6 | top B z.71 1.2×.6×.04 W · 4 legs Y r.025×.71 M · modesty panel B 0.1,.55,.35 1.0×.03×.30 W | Furniture / DESK |
| chair .45×.45×.85 | 6 | seat B z.44 · back B y.38 z.49 .41×.05×.36 W · 4 legs Y r.02×.44 M | Furniture / CHAIR |
| sofa-3 2.1×.9×.85 | 7 | base B .30 F · back B y.66 z.40 2.1×.24×.45 F · 2 arms B .20×.66×.25 F · 3 cushions B .53×.56×.12 F | Furniture / SOFA |
| sofa-2 1.6×.9 | 6 | as sofa-3, 2 cushions | Furniture / SOFA |
| armchair .85×.85 | 5 | base · back · 2 arms · 1 cushion F | Furniture / SOFA |
| lounge-chair .75×.85×.9 | 5 | base · tall back .55 · 2 arms · cushion F | Furniture / CHAIR |
| coffee-table 1.2×.6×.45 | 6 | top B z.41 ×.04 W · shelf B z.12 W · 4 legs Y r.025×.41 W | Furniture / TABLE |
| tv-unit 1.6×.45×.5 | 5 | carcass · plinth K · 2 doors W · screen B .25,.18,.50 1.10×.04×.57 K | Furniture / CABINET |
| dining-table-4 1.2×.8×.75 | 5 | top B z.71×.04 W · 4 legs Y r.03×.71 W | Furniture / TABLE |
| dining-table-6 1.8×.9 | 6 | + centre stretcher B [x] W | Furniture / TABLE |
| dining-chair .45×.45×.9 | 6 | seat z.45 · back .41 tall · 4 legs Y r.02×.45 W | Furniture / CHAIR |
| shelving .9×.35×2.0 | 6 | 2 sides B .02 W · 4 shelves B z .40/.90/1.40/1.95 W | Furniture / SHELF |
| bookcase .9×.35×2.0 | 7 | + back panel B .02 W | Furniture / SHELF |
| bench 1.2×.4×.45 | 4 | seat B z.41 W · 2 leg slabs W · stretcher W | Furniture / BED? → `NOTDEFINED` |
| kitchen-counter (stretch x) | 4–8 | toe-kick B .02,.02,0 (w−.04)×.55×.10 K · carcass B 0,.02,.10 w×.58×.78 W · worktop B 0,0,.88 w×.62×.04 K · n door panels, `n = clamp(round(w/.6),1,5)`, each (w/n−.01)×.02×.70 W | Furniture / CABINET |
| kitchen-island 1.8×.9×.9 | 6 | toe-kick · carcass · worktop (+.05 overhang each side) K · 3 door panels W | Furniture / CABINET |
| fridge .9×.75×1.8 | 5 | body B .9×.73×1.8 N · freezer door B .9×.02×.55 N · fridge door B z.57 ×1.23 N · 2 handles Y .015×.35/.25 M | ElectricAppliance / FRIDGE_FREEZER |
| range .76×.65×.9 | 8 | body N · hob B z.86 ×.04 K · 4 burners Y r.09×.01 K · oven door B K · handle Y [x] M | ElectricAppliance / ELECTRICCOOKER |
| dishwasher .6×.6×.85 | 4 | body N · door front N · control strip K · handle Y [x] M | ElectricAppliance / DISHWASHER |
| kitchen-sink .8×.6×.2 | 5 | rim B z.15 ×.05 M · bowl B .06,.08,0 .50×.44×.15 M · drainer B M · tap Y .40,.52,.20 .018×.28 M · spout B [y] M | SanitaryTerminal / SINK |
| wc .4×.7×.8 | 4 | cistern B 0,.55,.30 .4×.15×.50 C · pedestal B .09,.10,0 .22×.40×.32 C · bowl E .20,.28,.32 .19,.26×.08 C · seat E z.40 ×.04 N | SanitaryTerminal / TOILETPAN |
| lavatory .6×.5×.85 | 4 | pedestal B .22,.15,0 .16×.20×.78 C · basin E .30,.25,.78 .29,.24×.07 C · tap Y .018×.14 M · spout B [y] M | SanitaryTerminal / WASHHANDBASIN |
| vanity .9×.55×.85 | 7 | carcass W · plinth K · worktop C · basin E C · tap Y M · 2 doors W | SanitaryTerminal / WASHHANDBASIN |
| shower .9×.9×2.0 | 6 | tray B ×.12 C · 2 glass panels B .02×.9×1.88 G · riser B .04×.04×1.83 M · head Y .05×.04 M · drain Y r.05×.02 M; `symbolExtra` = corner diagonal | SanitaryTerminal / SHOWER |
| bathtub 1.7×.75×.6 | 4 | shell B ×.55 C · water E .85,.375,.45 .74,.30×.10 G · tap Y .018×.18 M · spout B [x] M | SanitaryTerminal / BATH |
| washer .6×.6×.85 | 4 | body N · porthole Y [y] .30,.0,.45 r.17×.02 G · control strip K · detergent drawer N | ElectricAppliance / WASHINGMACHINE |
| dryer .6×.6×.85 | 4 | as washer, vent Y [y] at rear | ElectricAppliance / TUMBLEDRYER |
| water-heater .6×.6×1.5 | 4 | tank Y .30,.30,0 r.29×1.40 M · cap Y z1.40 ×.10 N · 2 pipes Y r.02×.20 M | ElectricAppliance / FREESTANDINGWATERHEATER |
| grab-rail .6×.05×.05 | 3 | bar Y [x] 0,.025,.025 r.018×.60 M · 2 flanges Y [x] r.035×.02 M | Furniture / `NOTDEFINED` |
| planter .5×.5×.6 | 3 | pot Y .25,.25,0 r.25×.55 C · soil Y r.22×.05 K · shrub Y z.55 r.18×.30 V | Furniture / `NOTDEFINED` |
| outdoor-table .8×.8×.74 | 3 | top Y .40,.40,.70 r.40×.04 M · post Y r.04×.70 M · foot Y r.22×.03 M | Furniture / TABLE |
| bike-rack 1.8×.6×.9 | 4 | 3 hoops P (U outline extruded [y] .04) M · base rail B [x] M | Furniture / `NOTDEFINED` |
| mailbox-bank 1.2×.4×1.2 | 6 | carcass M · plinth K · 4 door panels M | Furniture / CABINET |
| reception-desk 2.4×.8×1.1 | 5 | counter B 2.4×.55×.95 W · transaction top B z.95 2.4×.8×.05 W · return B W · kick K · front panel W | Furniture / DESK |
| treadmill .9×2.0×1.4 | 6 | deck B .9×1.5×.15 K · belt B .74×1.40×.02 R · 2 uprights B .10×.10×.95 M · console B z1.20 K · handle Y [x] M; `symbolExtra` = belt centreline | ElectricAppliance / `NOTDEFINED` |
| car 1.8×4.5×1.5 | 8 | body B .25 1.8×3.9×.55 S · cabin B z.80 1.64×2.0×.45 G · bonnet B S · boot B S · 4 wheels Y [x] r.32×.20 K | BuildingElementProxy / ELEMENT |

`symbol` is **derived**, not authored: `symbolFromSolids(solids, height, topFrac = 0.5)` emits the plan ring of every solid whose `z + h >= height * topFrac`, plus the largest-area solid (the base), circles/ellipses as 16-gons, rings sorted by descending area. Types with a non-solid plan line carry `symbolExtra?: Vec2[][]` (only shower and treadmill), concatenated at module load by a `def()` helper. This is what lets the letter glyphs die: a bed reads as frame + pillows, a wc as bowl ellipse + cistern, a sofa as base + arms + cushion divisions.

**Stretchable items — decision: per-length types, width quantised to 0.10 m.** Not `IfcCartesianTransformationOperator3DnonUniform`. Justification:
1. **Correctness.** A counter stretched 1.20 → 3.40 m by a non-uniform operator scales the 0.02 m door reveals and the 0.04 m worktop overhang by 2.83× in x. The plan `symbol` smears identically. Door divisions are the thing that makes a counter readable, and their *count* must change with length — a scale factor cannot do that. `n = clamp(round(w/0.6), 1, 5)` can.
2. **Cost is a wash.** Per-length: ~16 entities per distinct length; measured runs produce 6–12 distinct counter lengths → ~190 entities. Non-uniform: 16 (one type) + 1 line per distinct factor → ~28. A ~160-entity difference against a 313k baseline is noise.
3. **Instancing survives either way** (ifc-lite keys GPU instancing on the representation map, processor/mod.rs:547-552), so that is not the tiebreaker.

`stretchKey(t, w)` returns `FT-<t>` when `stretch` is absent, else `FT-<t>-w<cm>` with `cm = Math.round(clamp(w, 0.30, 6.00) / 0.10) * 10` (e.g. `FT-kitchen-counter-w120`). **Id grammar for F8:** `FT-<furnitureType>` | `FT-<furnitureType>-w<cm>`, `cm` a 2–3 digit integer multiple of 10. `typeById` parses and memoises.

Consequence for the layout engine: the emitted counter is at most 0.05 m off its laid-out width. `arch-elements.ts` must set `FurnitureDef.width` to the quantised value (`quantizeFurnitureWidth(f)`) so plan, axon and IFC agree; otherwise the plan outline and the IFC solid differ by up to 50 mm. One line in the furniture phase.

## 1b. `ElementGeometry.instance`

```ts
/** Mapped-item occurrence of a furniture type. position = footprint min corner BEFORE rotation (like box). */
| { kind: 'instance'; typeId: string; position: Vec3; rotation: number; scale?: Vec3 }
```
`box` is kept — it is the `detail:'low'` path, the IFC2X3 path and every non-furniture box.
`scale` is declared but **unused in v2**: the writer warns and falls back to identity if present and ≠ `[1,1,1]`. It exists so the non-uniform operator can be introduced later without touching the frozen contract.

- `elementFootprint` (plan-svg.ts:98-131): `case 'instance': { const t = typeById(g.typeId); return t ? boxQuad(g.position[0], g.position[1], t.footprint.w, t.footprint.d, g.rotation) : null; }`
- axon fallback (axon-svg.ts): `zOf` → `case 'instance': return g.position[2] ?? 0;` · `heightOf` → `return typeById(g.typeId)?.height ?? null;` · `prio` → same bucket as `box` (6). The axon therefore draws the extruded footprint prism — correct silhouette, no per-solid cost in a 2400-item budget.
- plan-svg furniture bucket (:325-348) replaces the glyph block: resolve `typeId = stretchKey(f.type, f.width)`, `t = typeById(typeId)`, push `polyPath(ring transformed by rotation+translation)` for every ring of `t.symbol` into the **same `outl` array** — so the layer is still one batched `<path>`. `grow(pts)` still runs on the footprint quad only. The `Hit` is unchanged (footprint quad), so picking and tooltips are untouched. **Gate:** `model.spec.options?.detail === 'low'` → footprint ring only.
- **Deleted:** `FURN_GLYPH` (:73-80), `furnGlyph` (:81-84), the `glyphs` array and its `labelsOn && area > 0.12` branch. `text()` import may become unused in that block only — it is used elsewhere.

## 1c. Vendored `IfcCreator` extensions

All IFC4 attribute orders; every number via `num()` (plain decimals, exponent-free — satisfies validate.ts:290). `sharedResource` (2311-2319) is the caching idiom: key = exact STEP argument text, so two calls share an entity precisely when the line would be byte-identical.

```ts
// 1. cached in transformOpCache
addCartesianTransformationOperator3D(params?: {
  LocalOrigin?: Point3D; Scale?: number; Scale2?: number; Scale3?: number;
  Axis1?: Point3D; Axis2?: Point3D; Axis3?: Point3D;
}): number
```
`IfcCartesianTransformationOperator3D(Axis1, Axis2, LocalOrigin, Scale, Axis3)` — 5 attrs:
`#n=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#origin,$,$);`
When `Scale2`/`Scale3` are given, emit the 7-attribute nonUniform form:
`#n=IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM($,$,#o,1.,$,1.5,1.);`
The identity operator appears **exactly once in the file** because every occurrence shares it.

```ts
// 2. cached by `${shapeRepId}|${originId}`
addRepresentationMap(shapeRepId: number, mappingOrigin?: Point3D): number
```
`IfcRepresentationMap(MappingOrigin, MappedRepresentation)`:
`#n=IFCREPRESENTATIONMAP(#axis2,#shapeRep);` — `axis2 = addAxis2Placement3D(addCartesianPoint([0,0,0]))`, already cached, so free.

```ts
// 3. cached by `${mapId}|${operatorId}`
addMappedItem(mapId: number, operatorId: number): number      // #n=IFCMAPPEDITEM(#map,#op);
// 4.
addMappedShapeRepresentation(mappedItemIds: number[]): number
//    #n=IFCSHAPEREPRESENTATION(#ctxBody,'Body','MappedRepresentation',(#item,…));
// 5.
addBodyRepresentation(solidIds: number[]): number
//    #n=IFCSHAPEREPRESENTATION(#ctxBody,'Body','SolidModel',(#s1,…));
```
(4) and (5) exist because `addShapeRepresentation` (2547-2556) hardcodes `itemIds.length > 1 ? 'SolidModel' : 'SweptSolid'` — it can never write `MappedRepresentation`, and it would label a one-solid type `SweptSolid` while its five-solid sibling gets `SolidModel`. `addBodyRepresentation` always writes `SolidModel`, so every type is labelled the same way.

```ts
// 6.
addTypeObject(
  ifcType: 'IFCFURNITURETYPE' | 'IFCSANITARYTERMINALTYPE' | 'IFCELECTRICAPPLIANCETYPE' | 'IFCBUILDINGELEMENTPROXYTYPE',
  params: { Name: string; Description?: string; ApplicableOccurrence?: string;
            RepresentationMaps?: number[]; Tag?: string; ElementType?: string; PredefinedType?: string },
): number
```
All four share one IFC4 attribute list (10 attrs, `IfcTypeObject` → `IfcTypeProduct` → `IfcElementType` → leaf):
`GlobalId, OwnerHistory, Name, Description, ApplicableOccurrence, HasPropertySets, RepresentationMaps, Tag, ElementType, PredefinedType`
`#n=IFCFURNITURETYPE('guid',#oh,'Bed (queen)',$,$,$,(#map),'FT-bed-queen','bed-queen',.BED.);`
- `HasPropertySets` = `$` (occurrence psets already go through the shared-pset path; a second mechanism buys nothing).
- `PredefinedType` is **mandatory** on `IfcSanitaryTerminalType` / `IfcElectricApplianceType` in IFC4 → always a token, default `.NOTDEFINED.`.
- Verified: `FRIDGE_FREEZER`, `ELECTRICCOOKER`, `TUMBLEDRYER`, `WASHINGMACHINE`, `DISHWASHER` are all members of IFC4 `IfcElectricApplianceTypeEnum`, so `FURNITURE_IFC` (arch-elements.ts:163-176) needs no retokenisation. Type-level and occurrence-level tokens must be the same string — assert it in the test.
- `IFCBUILDINGELEMENTPROXYTYPE.PredefinedType` = `.ELEMENT.` for `car`.

```ts
// 7.
addRelDefinesByType(typeId: number, objectIds: number[]): void
```
`#n=IFCRELDEFINESBYTYPE('guid',#oh,$,$,(#a,#b,…),#type);` chunked at `TYPE_REL_CHUNK = 500` (mirrors `GROUP_CHUNK = 500`, ifc-creator.ts:71), duplicates collapsed with `new Set` exactly as `assignToGroup` (3092-3103) and `relateDefinition` (1682-1692) do. Not idempotent → call once per type, after all occurrences.

```ts
// 8.
addInstanceElement(storeyId: number, params: {
  IfcType: string; Name?: string; Description?: string; ObjectType?: string; Tag?: string;
  PredefinedType?: string; Placement: Placement3D; ProductShapeId: number;
}): number
```
Emits the element tail only:
`#n=IFCFURNISHINGELEMENT('guid',#oh,'Bed (queen)',$,'bed-queen',#placement,#sharedProdShape,'ARC-L03-FURN-014');`
`IfcFurnishingElement` has **no** `PredefinedType` in IFC4 (today's `addIfcFurnishingElement`, 1225-1226, confirms: it ends at Tag with no `ifc4Only`). So: `NO_PREDEFINED_TYPES = new Set(['IFCFURNISHINGELEMENT'])`; the other three append `this.ifc4Only(predefinedType)`. Routes `trackElement` + `this.entities.push` like `addElement`, but **does not** write `this.elementSolids` — see (9).

**Feasibility of one shared `IfcProductDefinitionShape` across occurrences — confirmed.** `addElement` (2672-2714) builds placement and geometry per call, but nothing in the creator couples a product shape to one product: the only per-product coupling is `this.elementSolids.set(elementId, [solidId])` at :2709, consumed by `finalizeStyles` (2208-2232). Schema side: `IfcProductDefinitionShape.ShapeOfProduct` is an **INVERSE** attribute (`SET [1:?] OF IfcProduct FOR Representation`), so N products referencing one shape is precisely how that set acquires N members. The geometry must therefore be authored at the type origin, with position **and rotation** in the occurrence's `IfcLocalPlacement` — which is exactly what keeps the identity operator shared. If `addInstanceElement` *did* populate `elementSolids`, `finalizeStyles` would emit N×M styled items (worse than today's 1 per item), so it must not.

```ts
// 9.
setSolidColor(solidId: number, styleName: string, rgb: [number, number, number]): void
```
Fills `solidColors: Map<number, {name, rgb}>`. `finalizeStyles` gains a **first** loop over `solidColors` (deterministic first-use order), recording each solid in `styled: Set<number>`; the existing per-element loop skips solids already in `styled`, so no solid ever gets two `IfcStyledItem`s. `styleCache` is hoisted so both loops share `IfcSurfaceStyle` entities. Style name must be a pure function of the colour (`'Furn-' + rgb→hex6`) because the cache key is `name|rgb`; that way the ~11 palette colours produce 11 `IfcSurfaceStyle`s for the whole library.

```ts
// 10. promoted from private to public (one-word diff)
addAxis2Placement3D(originId: number, axisId?: number, refDirId?: number): number
```
Needed because `addExtrudedAreaSolid(profileId, depth, extrusionDir?, positionId?)` is public but its `positionId` parameter is unreachable from outside — a latent gap in the vendored API. Already cached (2336-2346).

**`ellipse` implementation note.** No new profile method: emit ellipses as a 16-gon through `addArbitraryProfile`. `IfcEllipseProfileDef` would be legal but adds engine risk (unverified in ifc-lite's parametric router) for two users (bathtub water, lavatory basin). The 16 2D points are cached in `pointCache` and shared file-wide.

**`toIfc()` interaction.** `this.id()` is a monotonic counter and `this.lines` append-only, so new entities are numbered at first use in call order — determinism unchanged. The three new caches follow the `sharedResource` contract. `stats.entityCount = this.lines.length` keeps counting correctly. The deferred `IfcRelDefinesByType` chunks are emitted by the **writer** before `toIfc()`, exactly like the shared psets (writer.ts:511-524) — `toIfc()` itself changes only through `finalizeStyles`.

**IFC2X3: degrade to boxes.** `IfcRepresentationMap`/`IfcMappedItem`/the operators all exist in IFC2X3, but `IfcFurnitureType` there has `AssemblyPlace` instead of `PredefinedType`, and the three appliance/sanitary enums have different members. Rather than fork four attribute lists for a compatibility escape hatch, `writeGeometry` routes `instance` to the existing `box` path when `schema === 'IFC2X3'`. State it in the writer doc comment and NOTICE.md.

## 1d. Writer pre-pass

New `src/ifc/furniture-types.ts`:

```ts
export interface TypeLibEntry { typeId: number; mapId: number; prodShapeId: number; occurrences: number[] }
export interface TypeLibrary { entries: Map<string, TypeLibEntry>; identityOperatorId: number | null }
export function newTypeLibrary(): TypeLibrary;
export function ensureFurnitureType(creator: IfcCreator, lib: TypeLibrary, def: FurnitureTypeDef): TypeLibEntry;
export function finalizeFurnitureTypes(creator: IfcCreator, lib: TypeLibrary, warn: Warn): void;
```

`ensureFurnitureType` (lazy, at first use): identity operator → per solid {profile (cached), `addAxis2Placement3D` at the solid origin (cached), `addExtrudedAreaSolid`, `setSolidColor`} → `addBodyRepresentation` → `addRepresentationMap` → `addMappedItem` → `addMappedShapeRepresentation` → `addProductDefinitionShape` → `addTypeObject`.
`finalizeFurnitureTypes`: for each entry in insertion order, `addRelDefinesByType(typeId, occurrences)`.

In `writeIfc` (writer.ts:435-466): `const typeLib = newTypeLibrary();` beside `const shared = newSharedSets();`; `writeGeometry` gains `typeLib` as a parameter; `finalizeFurnitureTypes(creator, typeLib, warn)` runs in the "written last" block **before** the shared-pset loops (order only affects ids, but fix it for determinism). `collectDefinitions` (960-1010) guards `if (element.color && element.geometry.kind !== 'instance')` — colour now lives on the type's solids. Psets are unchanged and still collapse to ~45 shared sets.

**Entity graph — one type (`FT-bed-queen`, 6 solids):**
```
IFCCARTESIANTRANSFORMATIONOPERATOR3D  ×1 for the whole FILE
per solid: IFCCARTESIANPOINT(cached) · IFCAXIS2PLACEMENT3D(cached) · IFCRECTANGLEPROFILEDEF(cached)
           IFCEXTRUDEDAREASOLID ×1        IFCSTYLEDITEM ×1
IFCSHAPEREPRESENTATION 'Body','SolidModel'            ×1
IFCREPRESENTATIONMAP                                  ×1
IFCMAPPEDITEM                                         ×1
IFCSHAPEREPRESENTATION 'Body','MappedRepresentation'  ×1
IFCPRODUCTDEFINITIONSHAPE                             ×1
IFCFURNITURETYPE                                      ×1
IFCRELDEFINESBYTYPE                                   ×1 (deferred, per 500 occurrences)
```
Per type ≈ **2·S + 7** uncached entities (S = solid count) → 19 for S=6, plus cached resources amortised to near zero.

**One occurrence:**
```
IFCCARTESIANPOINT     (cached; furniture positions are all distinct → ~1)
IFCDIRECTION          (cached; ~4 distinct rotations building-wide → ~0)
IFCAXIS2PLACEMENT3D   (cached by (origin,axis,refDir); distinct per position → ~1)
IFCLOCALPLACEMENT     ×1
IFCFURNISHINGELEMENT  ×1
```
= **4.0 entities per occurrence.** I have to correct the findings' "≈2.4/instance": that projection treated the placement chain as free, and it is not — every furniture item is at a unique XY, so its point and axis2 placement are genuinely new entities. `ObjectPlacement` must be an `IfcObjectPlacement`, so the `IfcAxis2Placement3D` cannot be referenced directly; 4 is the floor without quantising positions (which would move furniture).

**us-5-over-1, 1810 instances:** library = 45 fixed types (avg S=5 → 17 each) + ~10 counter lengths ≈ **935 entities**, plus ~130 shared profile/point/placement resources. Occurrences = 1810 × 4 = **7,240**. Total **≈ 8,240** vs **11,893** today → **−31 % (3,653 entities)**, amortised **4.55 entities/instance including the library** (4.0 excluding). The geometry per item goes from 1 box to 3–8 primitives while the entity count falls by a third; `IFCSTYLEDITEM` for furniture drops 1810 → ~230, `IFCEXTRUDEDAREASOLID` 1810 → ~230, `IFCSHAPEREPRESENTATION` 1810 → ~110, `IFCPRODUCTDEFINITIONSHAPE` 1810 → ~55. `writer.test` budget: **≤ 5.0 entities per furniture instance including the type library** (today 6.57).

**The two extra caches.**
- **`IfcLocalPlacement` by `(relativeTo, axis2Id)`.** Legal: `PlacesObject` is an INVERSE `SET`, so N products may share one placement. Two products share only when they sit at an identical origin *and* orientation (space prism + floor finish, column + footing, stacked MEP at one XY) — realistically 5–12 % of the 29,047 today → **1,500–3,500 entities, 0.5–1.1 % of the 313k baseline**. Six lines, zero risk. Do it, but it is not the prize.
- **`IfcPropertySingleValue` by `(Name, Type, NominalValue)`.** Legal: `IfcProperty.PartOfPset` is an INVERSE `SET [0:?] OF IfcPropertySet FOR HasProperties`, so one property entity may belong to many sets. This is the prize: 91,000 `IFCPROPERTYSINGLEVALUE` survive today *after* the shared-pset work, because identical properties recur across distinct sets. Distinct triples in a residential model — `Discipline` 6, `Storey` ~25, `Patterns` ~200, `System` ~80, plus dimension-valued discipline properties — realistically **3,000–8,000** → saving **83,000–88,000 entities ≈ 27 % of the 313k baseline** and roughly 3–5 MB of the 22.5 MB file. Implementation is wholly internal: route the line in `buildPropertySet` (1661-1667) through `sharedResource(this.propertyCache, 'IFCPROPERTYSINGLEVALUE', args)`. No API change. `IFCPROPERTYSET` itself is not shareable that way (it carries a GlobalId) — leave it.

**`validate.ts`:** add `'IFCRELDEFINESBYTYPE'` to `MEMBER_LIST_RELATIONSHIPS` (:38-45). The existing rule ("≥2 refs, no empty member list, last attribute is not `$`/`*`/missing", :215-226) fits its layout exactly — `RelatedObjects` is the member set and `RelatingType` is the last attribute. No numeric-token change: every new number goes through `num()`.

**`writer.test.ts` additions** (fixture: a furniture-only model plus the existing full fixture):
- `IFCCARTESIANTRANSFORMATIONOPERATOR3D === 1`
- `IFCMAPPEDITEM === IFCREPRESENTATIONMAP === sum of the four type counts`
- `IFCSTYLEDITEM === Σ solids over used types` (proves no per-occurrence styled items)
- one `IFCRELDEFINESBYTYPE` per type at ≤ 500 occurrences; two at 501
- occurrence count: `IFCFURNISHINGELEMENT + IFCSANITARYTERMINAL + IFCELECTRICAPPLIANCE + IFCBUILDINGELEMENTPROXY === instances`
- budget: `(entityCount − nonFurnitureBaseline) / instances <= 5.0`
- `validateStep(out.content).errors` is `[]`; `unresolvedRefs === 0`
- `schema: 'IFC2X3'` → `byType.IFCMAPPEDITEM === undefined`, `IFCFURNISHINGELEMENT === instances`
- `detail: 'low'` → boxes
- deterministic: two runs byte-identical with instances present
- no two `IFCPROPERTYSINGLEVALUE` lines are byte-identical modulo the id; same for `IFCLOCALPLACEMENT`
- type-level `PredefinedType` equals occurrence-level for all 12 mapped types
Also add two `instance` elements to `src/app/mock-model.ts` so `render.test.ts` covers the new plan-symbol path without a real run.

**NOTICE.md** — one bullet in the top list plus a detail subsection:
> - Mapped-item type library: `addCartesianTransformationOperator3D`, `addRepresentationMap`, `addMappedItem`, `addMappedShapeRepresentation`, `addBodyRepresentation`, `addTypeObject` (IfcFurnitureType / IfcSanitaryTerminalType / IfcElectricApplianceType / IfcBuildingElementProxyType), `addRelDefinesByType`, `addInstanceElement` (many occurrences share one `IfcProductDefinitionShape` — `ShapeOfProduct` is an inverse SET) and `setSolidColor` (type-level styling; `finalizeStyles` styles solids before elements and never twice). `addAxis2Placement3D` promoted to public so `addExtrudedAreaSolid`'s `positionId` is reachable. Shared `IfcPropertySingleValue` and `IfcLocalPlacement` resource caches.

**Deleted in Part 1:** `FURN_GLYPH`, `furnGlyph`, the plan glyph array; the unconditional furniture `setColor`. **Kept:** `addIfcFurnishingElement` and the `box` branch (low-detail + IFC2X3).

---

# PART 2 — Editor internals

## 2a. `Hit` extension and `pickHit`

```ts
export type HitSrcKind = 'element'|'room'|'wall'|'door'|'window'|'furniture'|'unit'|'slot'|'corridor'|'core'|'grid'|'site'|'mep';
export interface HitHandle { id: string; kind: 'edge'|'corner'|'point'|'rot'; at: Vec2; axis?: 'x'|'y'|'along'|'normal'; cursor?: string }
export interface Hit {
  id: string; kind: string; label: string;
  x0: number; y0: number; x1: number; y1: number;
  meta: [string, string][];
  // v2 — all optional, so every existing producer keeps compiling
  srcKind?: HitSrcKind; slotId?: string; unitId?: string; roomId?: string; wallId?: string;
  ref?: string;          // program-node ref / edgeRef / roomRef#kitSlot — never a minted id
  poly?: Vec2[];         // exact footprint; bbox stays for cheap rejection
  handles?: HitHandle[];
}
```
Population sites in `plan-svg.ts`: rooms loop → `srcKind 'room'`, `roomId`, `unitId`, `ref: r.ref`, `poly: pts`, no handles (rooms resize by dragging partitions). Walls loop → `srcKind 'wall'`, `wallId`, `ref: w.ref`, `poly: wallQuad(...)`; for `partition`/`wet`, handles `{id:'normal',kind:'edge',at:midpoint,axis:'normal'}` + `{id:'a'|'b',kind:'point',at:start|end,axis:'along'}`. Doors loop (:287-302) → `srcKind 'door'`, `wallId`, `roomId: d.swingIntoRoomId`, `ref`, `poly` = leaf rect, handles `along` / `hinge` / `swing`(rot). Windows → `along` only. Furniture loop (:326-348) → `srcKind 'furniture'`, `roomId`, `unitId`, `ref`, `poly: pts`, handles `rot` at `pts[1]` plus an `e` edge handle when `stretch === 'x'`. **New `slot` bucket**, drawn only when mode ≠ `view`, from `model.arch.layouts[storeyId].slots`: one hit per slot with `poly: s.boundary` and one `{id:'bnd:<neighbourSlotId>',kind:'edge',axis:strip-normal}` handle per shared edge. **New `unit` bucket** from `arch.units` on the storey: `poly: u.polygon`, `slotId: u.slotId` — so a click in a unit's circulation void still selects something and the module picker has an anchor.

```ts
export type PickMode = 'view' | 'edit-floor' | 'edit-unit';
export function pickHit(hits: readonly Hit[], x: number, y: number, tol?: number, mode?: PickMode): Hit | null;
export function pickHandle(hits: readonly Hit[], x: number, y: number, rWorld: number, only?: Set<string>): { hit: Hit; handle: HitHandle } | null;
```
`pickHit`: bbox reject (as today) → if `h.poly`, require `pointInPoly(h.poly, x, y) || distToPolyEdge(h.poly,[x,y]) <= tol` (thin items stay grabbable) → rank by `(preferenceRank(h.srcKind, mode), area)`. `preferenceRank` is 0 for everything in `view`, so **today's smallest-area behaviour is preserved exactly** when `mode` is absent; `edit-floor` = slot 0, unit/core 1, corridor 2, rest 3; `edit-unit` = furniture/door 0, partition wall 1, room 2, rest 3. `pickHandle` runs **first** and searches only hits in the current selection, which is what makes handle grabbing independent of z-order. `pointInPoly`/`distToPolyEdge` go in `src/app/svg.ts` beside `bboxOf` (pure, covered by `svg.test.ts`).

## 2b. `Viewport`

```ts
export interface DragSession {
  kind: string; hit: Hit; handle: HitHandle | null;
  start: Vec2; last: Vec2;
  modifiers: { shift: boolean; alt: boolean; meta: boolean };
  data?: unknown;                 // reducer scratch; Viewport never reads it
}
export interface ViewportHooks {
  units: () => DisplayUnits; streetFacing: () => Compass;
  onPick?: (hit: Hit | null) => void; showOverlay?: boolean;
  mode?: () => PickMode;
  onDragStart?: (hit: Hit | null, world: Vec2, ev: PointerEvent) => DragSession | null;
  onDragMove?: (session: DragSession, world: Vec2) => void;
  onDragEnd?: (session: DragSession, world: Vec2, cancelled: boolean) => void;
  onKey?: (ev: KeyboardEvent) => boolean;      // true = handled
  onCamera?: (k: number) => void;              // zoom changed → editor rebuilds pixel-sized handles
}
```
DOM: the constructor's `innerHTML` (viewport.ts:62) becomes
`<svg …><g class="defs"></g><g class="cam"><g class="dwg"></g><g class="edit"></g></g><g class="ov"></g></svg><div class="dwg-tip" hidden></div>`
and `setDrawing` writes `this.dwg.innerHTML = d.body` instead of `this.cam.innerHTML` — otherwise every redraw wipes the overlay. `clear()` clears both. `setOverlay(markup: string): void { this.edit.innerHTML = markup; }` — inside `.cam`, so overlay markup is authored in **world coordinates** and pans/zooms with the drawing.

`bind()` edits, exactly:
1. **`pointerdown`** — after the `ev.button !== 0` guard (:179) and *before* `this.dragging = true`: compute `world`; if `!(ev.button === 1 || this.spaceDown)` and `hooks.onDragStart` exists, call `pickHit(…, 6/this.k, this.mode())` and then `onDragStart(hit, world, ev)`; if it returns a session, store it, `setPointerCapture`, add `is-editing`, `host.focus()`, `return`. Otherwise fall through to today's pan setup untouched. **Pan therefore remains the default** — a session exists only when the editor explicitly claims the gesture (pointer on a handle of the current selection, or on a draggable hit in an edit mode).
2. **`pointermove`** — new first branch: `if (this.session) { onDragMove(session, world); session.last = world; this.moved = true; this.hideTip(); return; }`, ahead of the existing `if (this.dragging)` pan branch.
3. **`pointerup`** — `if (this.session) { const s = this.session; this.session = null; classList.remove('is-editing'); releasePointerCapture; onDragEnd(s, world, false); return; }` before the existing click/`onPick` path, so a drag never also selects.
4. **`pointercancel`** → same with `cancelled = true`.
5. New `keydown` on `host` (add `tabindex="0"` in the constructor): `if (hooks.onKey?.(ev)) { ev.preventDefault(); return; }`. `Escape` mid-session → `onDragEnd(s, s.last, true)`.
6. `apply()` calls `hooks.onCamera?.(this.k)`; add `zoom(): number`.
Add `touch-action: none` to `.viewport` in `styles.css`.

**Pixel-sized handles.** Strokes use the established `vector-effect: non-scaling-stroke` (`HAIR`). A handle *body* cannot be sized that way, so the overlay builder emits
`<g class="h" transform="translate(x,y) scale(${1/k})"><rect x="-4" y="-4" width="8" height="8" …/></g>`
and re-renders on `onCamera` (throttled with the existing `ovRaf` pattern). Rails and ghosts are plain world-space paths with `HAIR`. `1/k` also gives the editor its snap tolerance in world units.

## 2c. Pure reducers in `src/app/edit/`

Files: `types.ts`, `drag.ts`, `snap.ts`, `overlay.ts`, `history.ts`, `select.ts`, `picker.ts`, `thumb.ts`, `layout-util.ts` + `drag.test.ts`, `snap.test.ts`, `history.test.ts`, `picker.test.ts`.

```ts
export type OverrideScope = { kind: 'typical'; key: string } | { kind: 'storey'; storeyId: string };
export interface EditCtx {
  model: DesignModel; storeyId: string; layout: FloorLayout;
  unitLayout?: UnitLayout; program?: ProgramGraph;
  catalogue: ModuleCatalogue; grid: BayGrid; rules: RuleSet;
  perPixel: number;              // 1/k — pixel-scaled snapping
  scope: OverrideScope;
}
export interface EditPreview {
  ghosts: { poly: Vec2[]; cls: 'ok' | 'bad' | 'ghost' }[];
  rails: { a: Vec2; b: Vec2; range?: [number, number] }[];
  labels: { at: Vec2; text: string }[];
}
export interface DragResult { edit: LayoutEdit | null; preview: EditPreview; ok: boolean; reason?: string; range?: [number, number] }
export function dragToEdit(session: DragSession, world: Vec2, ctx: EditCtx): DragResult;
export function buildOverlay(sel: Hit | null, preview: EditPreview | null, k: number): string;
```

`dragToEdit` is a pure switch on `session.kind`:

| kind | from | scalar | clamp | edit |
|---|---|---|---|---|
| `slot-boundary` | slot hit, `bnd:<other>` handle | offset along strip | `clampLayoutEdit` | `{op:'moveBoundary', slotId, neighbourId, delta}` |
| `core-move` | core hit | position along the corridor leg | `clampLayoutEdit` | `{op:'moveCore', coreId, breakSlotId}` |
| `partition` | partition wall, `normal` handle | signed normal offset | `clampUnitEdit` | `{op:'dragPartition', ref, delta}` |
| `door-along` | door, `along` handle | along-wall position | `clampUnitEdit` | `{op:'moveDoor', ref, along}` |
| `door-flip` | door, `hinge`/`swing` handle (click) | — | `clampUnitEdit` | `{op:'flipDoor'\|'reverseDoor', ref}` |
| `furniture-move` | furniture body | Vec2 offset | `clampUnitEdit` | `{op:'moveFurniture', ref, position, rotation}` |
| `furniture-rotate` | furniture `rot` handle | angle, quantised to π/2 unless Alt | `clampUnitEdit` | same op |

Non-drag edits (`swapModule`, `mirror`, `insertSlot`, `removeSlot`, `setSlotKind`, `setDoorMotion`, `addFurniture`, `removeFurniture`, `swapRoomType`) come from the picker/palette/keyboard and go straight to the clamp + `appendOverride`.

**Snapping** (`snap.ts`, pure):
```ts
export const SNAP_M = 0.05;
export interface SnapTargets { lines: { axis: 'x'|'y'; at: number; why: string }[]; steps?: number[]; grid?: number }
export function snapScalar(v: number, t: SnapTargets, tolWorld: number): { v: number; why?: string };
export function snapPoint(p: Vec2, t: SnapTargets, tolWorld: number): { p: Vec2; why?: string };
```
`tolWorld = max(6 * ctx.perPixel, SNAP_M)`. Priority: (1) **wall face lines** on the current storey for the dragged axis (`why: 'wall <id>'`); (2) **planning grid** for slot boundaries — `ctx.grid.module` multiples, plus the column-line subset while Shift is held, so a user drag lands exactly where the packer would have put it; (3) the **0.05 m quantum**, always last, so every committed scalar is a multiple of 0.05 and reruns stay byte-identical. Alt suppresses (1) and (2) but not (3).

**Clamping — required engine exports (the cross-module asks):**
```ts
// src/disciplines/architecture/placer/clamp.ts   (agent L)
export function clampLayoutEdit(layout: FloorLayout, edit: LayoutEdit, ctx: ClampCtx):
  { edit: LayoutEdit; ok: boolean; reason?: string; range?: [number, number] };
// src/disciplines/architecture/program/clamp.ts  (agent P)
export function clampUnitEdit(unitLayout: UnitLayout, edit: UnitEdit, program: ProgramGraph, ctx: ClampCtx):
  { edit: UnitEdit; ok: boolean; reason?: string; range?: [number, number] };
export interface ClampCtx { catalogue: ModuleCatalogue; grid: BayGrid; rules: RuleSet; region: Region; level: number }
```
Contract both must honour: **total** (never throws), **pure**, **idempotent** (`clamp(clamp(e)) === clamp(e)`), and `range` is the admissible closed interval of the edit's scalar so the overlay can draw a rail even when the pointer is outside it. `ok: false` + `reason` when no legal value exists (neighbour already at its `frontageAt` minimum; furniture would land in a `swingRect`). These are **the same functions `applyOverrides` calls**, which is the entire correctness argument: the editor's ghost and the regenerated model cannot disagree.

```ts
export function appendOverride(spec: BuildingSpec, scope: OverrideScope, edit: LayoutEdit): BuildingSpec;
export function removeOverride(spec: BuildingSpec, scope: OverrideScope, index: number): BuildingSpec;
export function clearOverrides(spec: BuildingSpec, scope?: OverrideScope): BuildingSpec;
```
Pure, structural sharing. Ensures `spec.overrides ??= { version: 1 }` and the target array (`overrides.layouts[key]` / `overrides.storeys[storeyId]`); **collapses** a continuous edit with the previous one on the same target+op (`moveBoundary` on the same pair, `moveDoor`/`moveFurniture` on the same ref) so a 40-frame drag or a burst of arrow-key nudges is one entry; drops no-ops (`delta === 0`, `swapModule` to the module already there); nests `unit{edits}` into the existing entry for that slot so a unit's edits stay one ordered array. Called on `onDragEnd`, never on `onDragMove`.

```ts
export interface EditHistory { past: OverrideDoc[]; present: OverrideDoc; future: OverrideDoc[] }
export function newHistory(doc: OverrideDoc): EditHistory;
export function push(h: EditHistory, doc: OverrideDoc, cap?: number): EditHistory;  // cap 50, clears future
export function undo(h: EditHistory): EditHistory; export function redo(h: EditHistory): EditHistory;
export function canUndo(h: EditHistory): boolean;  export function canRedo(h: EditHistory): boolean;
```
Snapshots of whole `OverrideDoc`s, not inverse edits — clamping makes edit-level inversion unreliable. Docs are a few hundred bytes, so 50 snapshots are free; `hashOverrides` (F6) dedupes consecutive identical snapshots. `main.ts` binds Cmd/Ctrl+Z and Shift+Cmd+Z through `hooks.onKey`. Preset load or spec paste resets the history (consistent with "preset switch wipes `spec.overrides`").

```ts
export interface Selection { srcKind: HitSrcKind; id: string; slotId?: string; unitId?: string; ref?: string; at?: Vec2 }
export function reselect(sel: Selection | null, hits: readonly Hit[]): Hit | null;
```
Re-resolution after regeneration, first match wins: (1) exact `id` — works for slots/cores/units, whose ids the placer mints from the layout (`S-<bar>-<strip>-<nnn>`) rather than a counter; (2) `(slotId, ref)` — the important case, since room/door/wall/furniture ids are per-run but `ref` is a program-node ref; (3) `(unitId, srcKind)` + nearest centroid to `sel.at`; (4) `slotId` alone (falls back to the slot); (5) null, and the status strip says "selection lost". `state.selection` supersedes `state.pinned`.

**Arch-model fields — confirm/amend.**
- `ArchModel.layouts: Record<storeyId, FloorLayout>` — **confirm, required**. `FloorLayout` v2 already carries `key` and `layoutKey`, so no wrapper is needed.
- `RoomDef.ref`, `DoorDef.ref`, `WallDef.ref`, `FurnitureDef.ref` — **confirm, required**. Two amendments *by specification, not by new fields*: (i) `WallDef.ref` is populated for **partitions and wet walls** (a wet-wall drag will usually be refused, but the refusal needs a named target); (ii) `FurnitureDef.ref` **is** `roomRef#kitSlot` — a room can hold two nightstands, so the kit slot must be in the ref, which the frozen ref grammar already anticipates; (iii) `DoorDef.ref` is `refA|refB` with `#k` appended when a second door joins the same pair.
- `UnitInstance.slotId` — **confirm, required**.
- **One new optional field requested:** `UnitInstance.layoutKey?: string` — the canonical-layout cache key, so the editor can say "this edit changes 8 identical units" without re-deriving it.
- **Not required** (the editor derives them): per-slot `neighbourIds` (from `stripId` + boundary order, in `edit/layout-util.ts`), and any storey→layoutKey index (`layouts[storeyId].key`).

## 2d. Module picker data

```ts
export interface PickerItem {
  moduleId: string; label: string;
  frontage: { min: number; max: number };            // admissible at this slot's netDepth
  fitsNow: boolean;
  needsNeighbour?: { slotId: string; delta: number };
  bedrooms: number; area: number; mix: string;
  thumb: string; current: boolean;
}
export function candidatesForSlot(ctx: EditCtx, slotId: string): PickerItem[];
export function buildUnitThumb(moduleId: string, F: number, D: number,
  opts?: { size?: number; catalogue?: ModuleCatalogue }): string;
```
`candidatesForSlot`: `strip = layout.strips[slot.stripId]`; `netDepth = strip.netDepth`; `ids = catalogue.candidatesFor(strip)` — **the same call the packer makes**, so the picker can never offer something the packer would reject; per id `r = catalogue.frontageAt(id, netDepth)`, skip `null` (that is the depth filter, at the one place `netDepth` lives). Neighbour slack: for each of the ≤2 neighbours `n`, `giveMax(n) = n.frontage − frontageAt(n.moduleId, netDepth).min`, `takeMax(n) = frontageAt(n.moduleId, netDepth).max − n.frontage`; admit when `[r.min, r.max] ∩ [F − Σ takeMax, F + Σ giveMax] ≠ ∅`. `fitsNow = r.min <= F <= r.max`; otherwise `needsNeighbour` names the cheaper neighbour and the `grid.module`-snapped `delta`. Sort: `fitsNow` desc, `|targetArea − slotArea|` asc, building-wide mix deficit desc (so the picker nudges the mix back toward the requested one), then id. Choosing an item emits `{op:'swapModule'}` (+ an implicit `moveBoundary` when `needsNeighbour`), both through `clampLayoutEdit` before `appendOverride`.

`buildUnitThumb` is pure and must **not** call the unit solver (55 thumbs at 60 fps): it draws `catalogue.fitFor(moduleId, F, D)?.witness.rooms` — room rects filled with `ZONE_FILL`, partitions as 1 px lines, entry tick on the access side, wet rooms hatched — into a standalone `<svg viewBox="0 0 F D">`. **Cross-module ask to P/L:** `Feasibility.witness.rooms: { ref, type, zone, rect }[]`. Memoised in a module `Map` keyed `moduleId|F.toFixed(2)|D.toFixed(2)`.

**Deleted in Part 2:** `state.pinned` (folded into `state.selection`; the pinned-tooltip behaviour becomes selection highlight). Everything else is additive.

---

# PART 3 — Worker generation

New: `src/app/worker/protocol.ts`, `entry.worker.ts`, `client.ts`, `protocol.test.ts`, `client.test.ts`. Changed: `backend.ts`, `main.ts`, `entry.real.ts`, `entry.mock.ts`, `index.html`, `scripts/build.mjs`, `state.ts`, `export.ts`.

```ts
export type Req =
  | { t: 'generate'; runId: number; spec: PartialSpec | BuildingSpec; wantIfc: boolean }
  | { t: 'writeIfc'; runId: number }
  | { t: 'elementDetail'; runId: number; id: string }
  | { t: 'cancel'; runId: number };
export type Res =
  | { t: 'ready' }
  | { t: 'progress'; runId: number; phase: string; pct: number }
  | { t: 'result'; runId: number; model: DesignModel; genMs: number; postedAt: number }
  | { t: 'ifc'; runId: number; bytes: ArrayBuffer; entityCount: number; fileSize: number;
      idMap: Record<string, number>; warnings: string[]; ifcMs: number }
  | { t: 'detail'; runId: number; id: string; element: ModelElement | null }
  | { t: 'error'; runId: number; phase: 'generate'|'ifc'|'detail'; message: string; stack?: string };
```
- `generate {wantIfc: false}` for interactive runs — the IFC is written **on demand** (`writeIfc {runId}`) when the 3D tab opens or Download is clicked. That takes the writer off the interactive path (today `run()` writes it eagerly at main.ts:252).
- The worker retains `last: { runId, model } | null`, so `writeIfc` needs **no model re-transfer**. A `writeIfc` for a stale runId answers `error` with `'run superseded'`.
- `progress` needs one optional field on `GenContext`: `onPhase?: (phase: string, pct: number) => void` (**ask to the kernel agent**). Until it lands the worker emits exactly two honest progress messages (`generate` 0, `ifc` 0) rather than a fake ramp.
- `cancel` is best-effort only: generation is synchronous inside the worker, so it can only drop a *queued* request. Real cancellation is terminate + respawn.

**`entry.worker.ts`** imports `generateBuilding`, `writeIfc`, `normalizeSpec` and repeats the static `setArchitectureDeps({ templates: UNIT_TEMPLATES, layoutUnit })` injection from `entry.real.ts` (a single-file bundle cannot await a dynamic import before the first generate). It posts `{t:'ready'}` on load. IFC bytes: `const bytes = new TextEncoder().encode(out.content).buffer; postMessage({t:'ifc',…,bytes}, [bytes])` — **transferred, not cloned**, so a 22.5 MB file costs ~0 ms on the wire instead of a 22.5 MB string copy. The app keeps it as `Uint8Array`; `export.ts` builds the download straight from `new Blob([bytes], {type:'application/x-step'})`, and only `validateStep`/"copy IFC" decode to text via a helper `ifcText(out)`. So the app's IFC record gains `bytes?: Uint8Array` and treats `content` as derived. The worker imports no DOM and no `backend.ts`.

**`client.ts`**
```ts
export type WorkerSource = { kind: 'blob'; code: string } | { kind: 'url'; url: string };
export interface WorkerClient {
  generate(spec: PartialSpec | BuildingSpec, opts?: { wantIfc?: boolean; onProgress?: (p: string, pct: number) => void }): Promise<{ model: DesignModel; genMs: number; cloneMs: number }>;
  writeIfc(): Promise<AppIfcOutput>;
  elementDetail(id: string): Promise<ModelElement | null>;
  dispose(): void;
  readonly mode: 'worker' | 'sync';
}
export function createWorkerClient(source: WorkerSource): WorkerClient;
export function createSyncClient(be: Backend): WorkerClient;
```
**Superseded runs:** the client holds `runId` and one in-flight promise. A `generate()` while a run is in flight calls `worker.terminate()`, respawns from the retained Blob URL, rejects the old promise with `{ superseded: true }` (which `main.ts` swallows), and starts the new run. Respawn is a few ms — far cheaper than waiting out a 340 ms synchronous run. `state.busy`/`queuedRun` in `main.ts` collapse into this, and `scheduleRun`'s debounce can drop 400 → 150 ms because a superseded run no longer blocks anything. Terminate drops the worker's `last`, so the client retains `lastSpec` and a `writeIfc()` after a terminate silently regenerates first.

**Sync fallback:** when `typeof Worker === 'undefined'` or Blob-URL construction throws (CSP without `blob:`), `createSyncClient` wraps today's synchronous `backend()` calls in `Promise.resolve()` + `await nextFrame()` so the spinner paints. Same interface → one code path in `main.ts`.

**`Backend` made async:**
```ts
export interface Backend {
  kind: 'real' | 'mock';
  generateBuilding: (spec: PartialSpec | BuildingSpec) => DesignModel | Promise<DesignModel>;
  writeIfc: (model: DesignModel) => IfcOutput | Promise<IfcOutput>;
  metrics: MetricDef[]; templates: UnitTemplateDef[];
  workerSource?: WorkerSource;     // absent → sync client
}
```
`run()` is already `async` (main.ts:230), so the body becomes `const { model } = await client.generate(full)` and the eager `b.writeIfc` block is deleted. The mock backend stays synchronous and goes through `createSyncClient`.

**`scripts/build.mjs`.** New `bundleWorker()` mirroring `bundle()` (lines 51-68) with entry `src/app/worker/entry.worker.ts`, same flags (`--bundle --format=iife --target=es2022 --platform=browser --loader:.ts=ts --charset=utf8 --legal-comments=none`), `--minify` when `MINIFY`. Called only for `mode === 'real'`. Embedded through a new `<!--APP_WORKER-->` marker in `index.html` as
`<script type="text/plain" id="forma-worker">…</script>`
escaped with the identical three replacements as `safeJs` (`</script`, `<!--`, `-->`, lines 112-115) and injected with a **replacer function** (the `$&`/`$'` hazard at :116-117 applies identically). The marker check at :105-108 gains `<!--APP_WORKER-->`; the size line at :127 gains `worker ${kb(...)}`. The client reads `document.getElementById('forma-worker')!.textContent`.

**Why a `text/plain` block and not a JS string define.** `--define:__WORKER_SRC__=<json>` would JSON-encode a 250–400 kB minified bundle into a string literal *inside* the main bundle: (i) triple escaping (worker `\`/`"` → esbuild re-escape → HTML inlining), each layer a chance to corrupt a regex or template literal in the worker source; (ii) ~33 % size inflation from escaped newlines and quotes; (iii) esbuild minifying a single giant literal; (iv) an unreadable diff for any worker change. The inert `<script type="text/plain">` block is never executed or fetched by the browser, is escaped by exactly the machinery the CSS/JS inlining already uses and is already tested by, keeps the two bundles textually separate in `dist/forma-resi-ifc.html`, and is read with one `getElementById`.

**Structured-clone measurement, then the lazy path.** The worker introduces one new per-run cost that did not exist when generation ran on the main thread: cloning a `DesignModel` of 67,189 elements (ie-courtyard). Measure it, don't guess: the worker stamps `postedAt = performance.timeOrigin + performance.now()` immediately before `postMessage`, and the client computes `cloneMs = (performance.timeOrigin + performance.now()) − postedAt` on receipt — this captures serialise + deserialise across the two clocks. Surface it beside `genMs` in the status strip under `?debug=1`.
**Decision rule:** if `cloneMs > 300 ms` on the largest preset, stop transferring the whole model. The worker then sends a **slim model** — `{...model, elements: elements.map(slim)}` keeping only `{id, discipline, ifcType, predefinedType, storey, geometry, color, system, unitId, roomId}` and dropping `psets`, `quantities`, `material`, `patterns`, `tags` (which are the bulk of a `ModelElement`) — and the app fetches the full record for the *single* element in a tooltip or the element inspector via `elementDetail {id}`, answered in O(1) from the worker's retained `last.model` through a lazily built `Map`. `elMeta()` (plan-svg.ts:138-149) already degrades when a field is absent, and `elements-view.ts` shows psets only for the selected row, so the slim path costs one async hop in exactly one place. `elementDetail` is in the protocol from day one so the decision needs no protocol change.

**Tests.** `protocol.test.ts`: every `Req`/`Res` variant survives `structuredClone` — the one bug class that otherwise only appears in the browser. `client.test.ts` with a fake `Worker` class (`postMessage`/`terminate`/`onmessage` driven by the test): supersede rejects the old promise and terminates exactly once; `writeIfc` after a supersede regenerates; `error` rejects with the phase; `cancel` drops a queued request; `createSyncClient` satisfies the same interface. The build gains an assertion (fail when the worker bundle is empty or the marker is missing) rather than a test.

**Deleted in Part 3:** the synchronous body of `run()` (direct `b.generateBuilding`/`b.writeIfc`, the `queuedRun` flag, the eager `state.ifc` write). `nextFrame()` stays — the sync fallback and the spinner still use it.

---

# Suggested split into three implementation agents

**Agent F — ifc-furniture.** Owns `src/core/furniture-3d.ts`, the vendored `IfcCreator` extensions + NOTICE.md, `src/ifc/furniture-types.ts`, `writer.ts`, `validate.ts`, the `plan-svg.ts` furniture bucket + `elementFootprint`, `axon-svg.ts` (`zOf`/`heightOf`/`prio`), the `arch-elements.ts` furniture phase, `mock-model.ts`, `writer.test.ts`.
Must see frozen: **F8** (`FurnitureTypeDef`, `Solid` incl. `axis`, the `FT-<type>[-w<cm>]` id grammar), `ElementGeometry.instance`, `Hit` v2 (it only reads it), the `FurnitureType` union and `FURNITURE_CATALOG` dims, `IfcOutput` shape, `validate.ts`'s numeric-token rule.

**Agent A1 — app-editor.** Owns `src/app/edit/**`, `viewport.ts`, the `plan-svg.ts` hits / slot / unit buckets and `pickHit`, `main.ts` modes, `state.ts` (`mode`, `selection`, `history`), `styles.css`.
Must see frozen: **F6** (`OverrideDoc`/`LayoutEdit`/`UnitEdit`/`hashOverrides`), **F5** (`Slot`, `FloorLayout` v2, `ModuleCatalogue` with `candidatesFor`/`frontageAt`/`fitFor`, `Feasibility.witness.rooms`), **F4** (`DoorDef` v2 + `hingePoint`/`leafTip`/`drawsArc`), **F3** (`bayGridFrom`/`BayGrid`), the `clampLayoutEdit`/`clampUnitEdit` signatures and their total/pure/idempotent contract, `ArchModel.layouts`, `RoomDef/DoorDef/WallDef/FurnitureDef.ref`, `UnitInstance.slotId` + `layoutKey`, and the `Hit`/`PickMode`/`ViewportHooks`/`DragSession` additions.

**Agent A2 — app-worker + rules + issues.** Owns `src/app/worker/**`, `backend.ts`, `entry.real.ts`/`entry.mock.ts`, `index.html`, `scripts/build.mjs`, `export.ts`, `run()` in `main.ts`, the rules tab, the issues panel, `form.ts`.
Must see frozen: **F1** (`Issue`/`Severity`/`Ledger`/`RuleOverrides`/`CustomRule`/`PREDICATE_SIGNATURES`), `DesignModel.issues`, `BuildingSpec.rules`/`overrides`, the async `Backend`, the `Req`/`Res` protocol, `GenContext.onPhase`, `MassingSpec.allowStoreyOverride`.

**Shared seams to settle in the contracts commit so the three never collide:**
- `plan-svg.ts` — F takes the furniture bucket + `elementFootprint`; A1 takes `Hit`, `pickHit`, the slot/unit buckets and `buildPlan`'s signature. Land `Hit` v2 **and** the `instance` case of `elementFootprint` in the contracts commit so both start from a compiling file.
- `main.ts` — A2 owns `run()` (it changes the function's shape); A1 hangs modes and viewport hooks off it. A2 lands first.
- `state.ts` — A2 adds `issues`/`ifcBytes`/`progress`; A1 adds `mode`/`selection`/`history`. Disjoint fields in one file → land both field sets, defaulted to `null`, in the contracts commit.
- Two clamp modules are A1's hard dependency but agent **L**'s and **P**'s deliverables. A1 ships against a stub (`{ edit, ok: true }`) behind `edit/clamp-stub.ts` and swaps to the real exports when L/P land — the same stub-then-swap pattern the plan already uses for L↔P.

### Critical Files for Implementation
- /Users/samarvir/formaIFC/generator/src/ifc/vendor/ifc-lite-create/ifc-creator.ts
- /Users/samarvir/formaIFC/generator/src/ifc/writer.ts
- /Users/samarvir/formaIFC/generator/src/app/plan-svg.ts
- /Users/samarvir/formaIFC/generator/src/app/viewport.ts
- /Users/samarvir/formaIFC/generator/scripts/build.mjs
