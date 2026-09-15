# Vendored from ifc-lite (LTplus-AG/ifc-lite)

Files in this directory are copied from `packages/create/src` and `packages/encoding/src/guid.ts`
of https://github.com/LTplus-AG/ifc-lite (version 9.0.1 monorepo, `@ifc-lite/create` 2.4.0),
licensed under the Mozilla Public License 2.0 (see LICENSE). Modifications:

- Import specifiers retargeted to local `.ts` files (no workspace resolution needed).
- `addIfcSystem` / `addIfcZone` grouping helpers appended (see bottom of `ifc-creator.ts`).
- `addSharedIfcPropertySet` / `addSharedIfcElementQuantity`: one definition, many products.
- Shared geometry-resource caches (points, directions, axis placements, parametric profiles).
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
