# Vendored from ifc-lite (LTplus-AG/ifc-lite)

Files in this directory are copied from `packages/create/src` and `packages/encoding/src/guid.ts`
of https://github.com/LTplus-AG/ifc-lite (version 9.0.1 monorepo, `@ifc-lite/create` 2.4.0),
licensed under the Mozilla Public License 2.0 (see LICENSE). Modifications:

- Import specifiers retargeted to local `.ts` files (no workspace resolution needed).
- `addIfcSystem` / `addIfcZone` grouping helpers appended (see bottom of `ifc-creator.ts`).
- `addSharedIfcPropertySet` / `addSharedIfcElementQuantity`: one definition, many products.
- Shared geometry-resource caches (points, directions, axis placements, parametric profiles,
  `IfcPropertySingleValue`, `IfcLocalPlacement`).
- Mapped-item type library: `addCartesianTransformationOperator3D`, `addRepresentationMap`,
  `addMappedItem`, `addMappedShapeRepresentation`, `addBodyRepresentation`, `addTypeObject`
  (IfcFurnitureType / IfcSanitaryTerminalType / IfcElectricApplianceType /
  IfcBuildingElementProxyType), `addRelDefinesByType`, `addInstanceElement` (many occurrences
  share one `IfcProductDefinitionShape` — `ShapeOfProduct` is an inverse SET) and
  `setSolidColor` (type-level styling; `finalizeStyles` styles solids before elements and never
  twice). `addAxis2Placement3D` promoted to public (with a new `addCartesianPoint3D`) so
  `addExtrudedAreaSolid`'s `positionId` is reachable.
- `addIfcWall` honours `PredefinedType`; IFC2X3 styled items go through an
  `IfcPresentationStyleAssignment`.

## Modifications in detail (forma-resi-ifc)

Every change below is marked with a `forma-resi-ifc addition` comment in the source.

### `types.ts`

| Type | Added field | Purpose |
|---|---|---|
| `ProjectParams` | `Site?: SiteParams` | give the preamble `IfcSite` a real name/description |
| `ProjectParams` | `Building?: BuildingParams` | give the preamble `IfcBuilding` a real name/description |
| `ProjectParams` | `FileName?: string` | STEP `FILE_NAME` logical name (was always `created.ifc`) |
| `ProjectParams` | `FileDescription?: string` | STEP `FILE_DESCRIPTION`, where IFC declares the MVD (was always `Created by ifc-lite`) |
| `SlabParams` | `PredefinedType?: 'FLOOR' \| 'ROOF' \| 'LANDING' \| 'BASESLAB' \| 'USERDEFINED' \| 'NOTDEFINED'` | ground slabs / roof slabs / stair landings were all emitted as `.FLOOR.` |
| `RoofParams` | `PredefinedType?: string` | `IfcRoofTypeEnum` (was hardcoded `.FLAT_ROOF.`) |
| `GableRoofParams` | `PredefinedType?: 'FLAT_ROOF' \| 'SHED_ROOF' \| 'GABLE_ROOF' \| 'HIP_ROOF' \| 'HIPPED_GABLE_ROOF' \| 'GAMBREL_ROOF' \| 'MANSARD_ROOF' \| 'BARREL_ROOF' \| 'RAINBOW_ROOF' \| 'BUTTERFLY_ROOF' \| 'PAVILION_ROOF' \| 'DOME_ROOF' \| 'FREEFORM' \| 'USERDEFINED' \| 'NOTDEFINED'` | `IfcRoofTypeEnum` (was hardcoded `.GABLE_ROOF.`, so a hipped or gambrel variant of the same dual-pitch solid could not be labelled); schema-aware |
| `RailingParams` | `PredefinedType?: 'HANDRAIL' \| 'GUARDRAIL' \| 'BALUSTRADE' \| 'USERDEFINED' \| 'NOTDEFINED'` | balcony guardrails vs handrails (was hardcoded `.HANDRAIL.`) |
| `PileParams` | `PredefinedType?: string` | `IfcPileTypeEnum` — bored vs driven piles (was hardcoded `.DRIVEN.`) |
| `SpaceParams` | `PredefinedType?: 'SPACE' \| 'PARKING' \| 'GFA' \| 'INTERNAL' \| 'EXTERNAL' \| 'USERDEFINED' \| 'NOTDEFINED'` | `IfcSpaceTypeEnum` (was hardcoded `.INTERNAL.`); schema-aware |
| `WallParams` | `PredefinedType?: string` | `IfcWallTypeEnum` (was hardcoded `.STANDARD.`, so shear walls, parapets and partitions were indistinguishable) |
| new `SystemParams` | — | options for `addIfcSystem` |
| new `ZoneParams` | — | options for `addIfcZone` |

### `ifc-creator.ts`

- `buildPreamble` uses `params.Site` / `params.Building` for the `IFCSITE` / `IFCBUILDING`
  `Name` + `Description` attributes (previously the literals `'Site'` / `'Building'`).
- `IFCGEOMETRICREPRESENTATIONCONTEXT` precision is written as `0.00001` instead of `1.0E-5`
  (identical value). `src/ifc/validate.ts` rejects exponent literals in numeric tokens, because
  some downstream STEP readers mis-parse them.
- `addElement` / `addAxisElement` emit the trailing `PredefinedType` attribute only for
  IFC4/IFC4X3 (via the existing `ifc4Only()` helper, like `addIfcWall`/`addIfcColumn` already
  did). IFC2X3 `IfcElement` ends at `Tag`, so the old unconditional emission produced one
  attribute too many under IFC2X3.
- `addIfcSlab` / `addIfcRoof` / `addIfcGableRoof` / `addIfcRailing` / `addIfcSpace` / `addIfcPile` honour
  the new optional `PredefinedType` (defaults preserve the previous hardcoded tokens).
- `addIfcSpace` maps IFC4 `IfcSpaceTypeEnum` values that do not exist in IFC2X3's
  `InteriorOrExteriorSpace` (`SPACE`, `PARKING`, `GFA`) to `INTERNAL` when the schema is IFC2X3.
- `addIfcGableRoof` writes `GableRoofParams.PredefinedType` into the `IFCROOF` enum attribute
  (default `GABLE_ROOF`, the previous hardcoded token). `USERDEFINED` is not a member of IFC2X3's
  `IfcRoofTypeEnum`, so under IFC2X3 it falls back to `GABLE_ROOF`.
- New grouping API (`IfcGroup` subtypes have no placement/representation, so they cannot go
  through `addElement`):

  ```ts
  addIfcSystem(name: string, elementIds: number[], opts?: SystemParams): number
  addIfcZone(name: string, spaceIds: number[], opts?: ZoneParams): number
  ```

  `addIfcSystem` emits `IFCDISTRIBUTIONSYSTEM` (IFC4/IFC4X3, with `PredefinedType`) or
  `IFCSYSTEM` (IFC2X3, no `PredefinedType`), plus `IFCRELSERVICESBUILDINGS` linking the system
  to the preamble building (suppress with `ServesBuilding: false`). `addIfcZone` emits
  `IFCZONE` (with `LongName` on IFC4+). Both emit membership as `IFCRELASSIGNSTOGROUP`
  chunked at 500 ids per relationship (module constant `GROUP_CHUNK`).

- `addIfcWall` emits `PredefinedType` from the new optional `WallParams.PredefinedType`
  (default `STANDARD`, i.e. the previous hardcoded value) through `ifc4Only()`, since IFC2X3
  `IfcWall` has no such attribute.

### `ifc-creator.ts` — file size (the ~36 → ~11 STEP entities per product work)

A generated mid-rise is ~30 000 products. The upstream creator emits every geometry primitive
and every property set per product, which cost ~36 entities and ~2.4 KiB per product (67 MB for
one preset). Three changes, none of which alters what a reader sees — same products, same
property values, same colours, same containment and grouping:

1. **Shared property / quantity sets.** New public API:

   ```ts
   addSharedIfcPropertySet(elementIds: number[], pset: PropertySetDef): number
   addSharedIfcElementQuantity(elementIds: number[], qset: QuantitySetDef): number
   ```

   Each emits ONE `IFCPROPERTYSET` / `IFCELEMENTQUANTITY` (with its
   `IFCPROPERTYSINGLEVALUE` / `IFCQUANTITY*` children) and one
   `IFCRELDEFINESBYPROPERTIES` per 250 related objects (module constant
   `PROPERTY_REL_CHUNK`), with duplicate ids collapsed. `RelatedObjects` is a SET in the
   schema and an `IfcPropertySet` is a definition rather than a per-object value holder, so
   this is the idiomatic encoding; the caller decides which products may share a set.
   `addIfcPropertySet` / `addIfcElementQuantity` keep their exact previous behaviour and are
   now thin wrappers over the same `buildPropertySet` / `buildElementQuantity` +
   `relateDefinition` internals.

2. **Shared geometry resources.** `addCartesianPoint`, `addCartesianPoint2D`, `addDirection`,
   `addAxis2Placement3D`, the new private `addAxis2Placement2D` (extracted from the nine
   profile constructors, which each built their own), `addRectangleProfile` and
   `addCircleProfile` now return a cached entity instead of a fresh one. Every cache key is
   the exact serialized STEP argument text, so two calls share an entity precisely when they
   would otherwise have emitted a byte-identical line — these are immutable, value-typed
   geometry RESOURCES that the schema lets any number of entities reference. Ids are still
   handed out in first-use order, so output stays byte-reproducible. The world
   `IFCAXIS2PLACEMENT3D` in `buildPreamble` is now created through `addAxis2Placement3D`
   (identical line) so it primes the cache.

   Effect on the `us-5-over-1` preset (~28 500 products): `IFCCARTESIANPOINT` 92 746 → 6 710,
   `IFCDIRECTION` 40 691 → 51, `IFCAXIS2PLACEMENT3D` 59 386 → 6 448, `IFCAXIS2PLACEMENT2D`
   28 952 → 177, `IFCRECTANGLEPROFILEDEF` 18 837 → 329, `IFCCIRCLEPROFILEDEF` 10 115 → 12.

3. **Styles.** `finalizeStyles` already cached one `IFCSURFACESTYLE` (+ `IFCSURFACESTYLERENDERING`
   + `IFCCOLOURRGB`) per distinct colour and emits the one mandatory `IFCSTYLEDITEM` per solid,
   so nothing was removed. What was added is schema correctness: IFC4/IFC4X3 keep referencing
   the `IfcSurfaceStyle` directly from `IfcStyledItem.Styles` (allowed since IFC4 widened
   `IfcStyleAssignmentSelect`), while IFC2X3 — where `Styles` is a SET OF
   `IfcPresentationStyleAssignment` and a direct reference is invalid — now goes through one
   cached `IFCPRESENTATIONSTYLEASSIGNMENT` per style (new private `styleReference`).

No behaviour changes to any existing call signature: all additions are optional fields or new
methods, and the existing defaults equal the previous hardcoded values.

### `ifc-creator.ts` — mapped-item type library (the furniture work)

The upstream creator can only author geometry **per product**: every `addIfc*` builds one
`IfcExtrudedAreaSolid`, one `IfcShapeRepresentation` and one `IfcProductDefinitionShape`, and
there is no `IfcRepresentationMap`, `IfcMappedItem`, transformation operator, type object or
`IfcRelDefinesByType` anywhere in the 92 entity types it can emit. A model with 1 810 pieces of
furniture therefore paid for 1 810 copies of the same bounding box (~6.6 STEP entities each).

Nine new public methods add the type-library encoding, so a type's 3–8 primitives are authored
once and every occurrence is a mapped item that shares them:

```ts
addCartesianTransformationOperator3D(params?): number   // cached; identity appears ONCE per file
addRepresentationMap(shapeRepId, mappingOrigin?): number
addMappedItem(mapId, operatorId): number
addMappedShapeRepresentation(mappedItemIds): number     // 'Body','MappedRepresentation'
addBodyRepresentation(solidIds): number                 // 'Body','SolidModel', any item count
addTypeObject(ifcType, params): number
addRelDefinesByType(typeId, objectIds): void            // chunked at TYPE_REL_CHUNK = 500
addInstanceElement(storeyId, params): number
setSolidColor(solidId, name, rgb): void
```

- `addAxis2Placement3D` is promoted from private to public, and a public `addCartesianPoint3D`
  wrapper added (like the existing `addDirection3D`), because `addExtrudedAreaSolid`'s
  `positionId` parameter was public but unreachable — no public method could produce a value for
  it, so no caller could put more than one solid in a shape representation.
- `addInstanceElement` deliberately does **not** record the shape's solids in `elementSolids`:
  those solids belong to the type and are styled once through `setSolidColor`. Registering them
  per occurrence would make `finalizeStyles` emit N × M `IfcStyledItem`s. It also omits the
  trailing `PredefinedType` for `IFCFURNISHINGELEMENT` (`NO_PREDEFINED_TYPES`), which has no
  such attribute in IFC4 — the same rule `addIfcFurnishingElement` already follows.
- Sharing one `IfcProductDefinitionShape` between occurrences is the idiomatic encoding, not a
  trick: `IfcProductDefinitionShape.ShapeOfProduct` is an INVERSE `SET [1:?] OF IfcProduct FOR
  Representation`, so N products referencing one shape is precisely how that set acquires N
  members. The geometry is authored at the type origin and each occurrence carries its position
  **and rotation** in its own `IfcLocalPlacement`, which is what keeps the identity operator
  shared. Occurrences are linked to their type with `IfcRelDefinesByType`, which also stops a
  viewer from drawing the type's representation map a second time as orphan type-only geometry.
- `finalizeStyles` gained a first loop over `solidColors` that records what it styled, so the
  existing per-element loop skips those solids: a solid must carry at most one `IfcStyledItem`.
  The `IfcSurfaceStyle` cache is shared by both loops, so a whole 45-type furniture library
  costs one surface style per palette colour.
- **Attribute count correction.** `IFCFURNITURETYPE` has ELEVEN attributes in IFC4, not ten:
  IFC4 kept IFC2X3's `AssemblyPlace` (as optional) and appended `PredefinedType` after it. The
  three other type objects (`IFCSANITARYTERMINALTYPE`, `IFCELECTRICAPPLIANCETYPE`,
  `IFCBUILDINGELEMENTPROXYTYPE`) do have the flat ten-attribute `IfcElementType` layout.
  `HasPropertySets` is always `$` — occurrence property sets already go through the shared-pset
  path.
- IFC2X3 is **not** supported for mapped furniture (its type entities have different attributes
  and enum members); `src/ifc/writer.ts` routes `instance` geometry to the box path there.

Measured on `us-5-over-1` (1 975 furniture items, 30 types used): **6.53 → 3.01 STEP entities per
item** (12 891 → 5 936 furniture-attributable entities) while the geometry goes from one bounding
box to 3–8 primitives each; `IFCSTYLEDITEM`, `IFCEXTRUDEDAREASOLID` and `IFCSHAPEREPRESENTATION`
each drop by ~1 900.

### `ifc-creator.ts` — two more shared resource caches

Both are schema-legal for the same reason as the geometry resources: the owning attribute is an
INVERSE set, so one entity may serve many owners.

- **`IfcPropertySingleValue`** by its exact argument text = (Name, Type, NominalValue), inside
  `buildPropertySet`. `IfcProperty.PartOfPset` is `SET [0:?] OF IfcPropertySet FOR
  HasProperties`, so one property entity may belong to many sets — and `Discipline` /
  `Storey` / `System` / `Patterns` recur across thousands of otherwise distinct sets even after
  the shared-pset work. Measured on `us-5-over-1`: 102 829 property entities would be written,
  7 520 are (95 309 collapsed).
  `buildPropertySet` now also collapses a repeated property within one set, because
  `HasProperties` is a SET and `(#7,#7)` would be invalid.
- **`IfcLocalPlacement`** by `(relativeTo, axis2Id)`. `IfcObjectPlacement.PlacesObject` is
  `SET [1:?] OF IfcProduct FOR ObjectPlacement`, and two products share a placement only when
  they sit at an identical origin *and* orientation relative to the same parent (a space prism
  and its floor finish, a column and its footing, MEP stacked at one XY). Measured on
  `us-5-over-1`: 30 607 placements would be written, 28 653 are (1 954 collapsed, 6.4 %).
