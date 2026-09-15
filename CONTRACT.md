# forma-resi-ifc — discipline agent contract

You are implementing ONE discipline module of a parametric residential building → IFC generator.
Read this file, then `src/core/types.ts` (the shared contract), `src/core/geometry.ts`,
`src/core/coordination.ts`, `src/core/patterns.ts`, `src/core/ids.ts`, `src/core/typologies.ts`,
`src/core/spec.ts` and `src/pipeline.ts` before writing code. Do not edit files outside your
discipline folder unless this brief says so. Do not change `src/core/types.ts` — if a field is
genuinely missing, add it as an optional field in a NEW file `src/core/types-ext-<discipline>.ts`
and ask via your final report; never break other disciplines.

## Runtime and tooling (no npm install)

- Node 24 with native TypeScript type-stripping. Run anything with
  `/Users/samarvir/.nvm/versions/node/v24.21.0/bin/node path/to/file.ts`.
- ERASABLE TypeScript ONLY: no `enum`, no `namespace` with values, no parameter properties
  (`constructor(private x)`), no decorators, no `const enum`. Use `import type` for types.
  Relative imports MUST include the `.ts` extension.
- No runtime dependencies. No `Math.random` (use the `Rng` passed to you). No `Date.now()` in geometry.
- Tests: `node --test src/disciplines/<yours>/*.test.ts` using `node:test` + `node:assert/strict`.
  Every module ships at least one test that generates a real model from a preset and asserts
  invariants (element count > 0, no NaN coordinates, ids unique, geometry inside the site, etc.).
- Type-check is not available locally (no tsc). Be strict with yourself: match the interfaces in
  `types.ts` exactly. If unsure about a field name, grep `types.ts`.

## Coordinates (also documented at the top of types.ts)

- Metres, radians. World origin = site front-left corner; +X along the street, +Y from street into
  the site, +Z up. Street edge is y = 0.
- Element Z is STOREY-LOCAL (0 = that storey's finished floor). XY is world.
- Storey ids: `SITE`, `FND`, `B1`.., `L01`.. (ground = `L01`), `ROOF`. Use `StoreyDef` from `ctx.storeys`.
- Polygons CCW, not closed. Rect = min corner + size.

## Element output

Every discipline returns a model object containing `elements: ModelElement[]`, `patterns: PatternApplication[]`,
and `derived: Record<string, number>`. The IFC writer maps `ModelElement.geometry.kind` to IfcCreator calls:

| kind | IfcCreator method | notes |
|---|---|---|
| wall | addIfcWall (+ Openings) | centreline start/end, storey-local z in start/end |
| slab | addIfcSlab | profile relative to position |
| column | addIfcColumn / addIfcCircularColumn | base centre |
| beam | addIfcBeam | axis + w × h |
| box | addIfcFurnishingElement (IfcFurnishingElement) or addElement (any IfcType) | min corner + rotation about that corner |
| prism | addIfcSpace / addIfcBuildingElementProxy / addElement | profile relative to position |
| axis | addAxisElement (any IfcType: IfcPipeSegment, IfcDuctSegment, IfcCableCarrierSegment …) | round or rect section |
| stair | addIfcStair | straight run |
| door-in-wall / window-in-wall | addIfcWallDoor / addIfcWallWindow | hostId must be a `wall` element id in the SAME discipline model or in arch |
| footing / pile | addIfcFooting / addIfcPile | top centre, extends down |
| roof / gable-roof | addIfcRoof / addIfcGableRoof | |
| railing / ramp | addIfcRailing / addIfcRamp | |

`ifcType` is PascalCase (`IfcWall`, `IfcPipeSegment`, `IfcLightFixture`, `IfcSanitaryTerminal`,
`IfcAirTerminal`, `IfcDuctSegment`, `IfcDuctFitting`, `IfcPipeFitting`, `IfcCableCarrierSegment`,
`IfcElectricDistributionBoard`, `IfcOutlet`, `IfcSwitchingDevice`, `IfcAlarm`, `IfcUnitaryEquipment`,
`IfcFan`, `IfcFlowTerminal`, `IfcTank`, `IfcPump`, `IfcValve`, `IfcFireSuppressionTerminal`, `IfcSolarDevice`,
`IfcTransformer`, `IfcSpace`, `IfcBuildingElementProxy`, …). Set `predefinedType` where IFC4 has an enum
(e.g. IfcPipeSegment → `RIGIDSEGMENT`, IfcOutlet → `POWEROUTLET`, IfcSanitaryTerminal → `WASHHANDBASIN`,
IfcLightFixture → `POINTSOURCE`/`DIRECTIONSOURCE`, IfcAirTerminal → `DIFFUSER`/`GRILLE`, IfcDuctSegment → `RIGIDSEGMENT`,
IfcAlarm → `SMOKEALARM`? — no: use `IfcSensor` `SMOKESENSOR` for smoke detection, `IfcAlarm` `SIREN`).
Attach `psets` (Pset_* standard names where they exist, plus a `Forma_<Discipline>` pset with your key
parameters), `quantities` where cheap, `color` (RGB 0..1) per your discipline palette, `system` for MEP
runs, `unitId` / `roomId` for anything inside a dwelling, and `patterns: [ids]`.

Element ids come from `new IdFactory('<discipline>')` → `ids.next(storeyId, 'KIND')`.

## Pattern language

Export `<DISC>_PATTERNS: Pattern[]` (ids `SIT-nn`, `ARC-nn`, `STR-nn`, `MEC-nn`, `PLB-nn`, `ELE-nn`).
Each pattern: Alexander-style `problem`, parametric `solution`, `parameters` with units and sources
(code sections, design guides, Alexander APL numbers). Record every application with
`PatternApplication` (which storey/unit/elements, concrete params). The typology catalog already
references these ids — implement AT LEAST the ids your discipline is referenced by in
`src/core/typologies.ts` (grep your prefix) and the cross patterns XD-01..05 in `src/core/patterns.ts`.

## Performance

A 20-storey point tower must generate in < 2 s in Node on a laptop. Prefer O(n) sweeps over O(n²)
pairwise checks; cap element counts with `spec.options.detail` ('low' | 'medium' | 'high').

## Reporting

End your work with a short report: files created, exported API, element kinds emitted, pattern ids
implemented, test command + result, known limitations, and anything the orchestrator must fix in
another module (with exact file/field names). Do not paste large code in the report.
