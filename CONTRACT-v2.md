# forma-resi-ifc v2 — implementation brief for discipline agents

You are ONE Opus implementation agent working on v2 of the parametric residential building → IFC generator. Fable
orchestrates (contracts, integration, review, commits); you implement your owned scope, ship its tests, and report.

## Read first, in this order

1. `docs/design/v2-plan.md` — the approved plan: context, principles, current-state findings with file:line seams,
   the target architecture, the 51-warnings-to-zero mapping, waves and ownership, verification.
2. Your design document(s) in `docs/design/`:
   - kernel / rules / pre-sizing / constructability / resolutions → `v2-design-kernel-rules-presize.md`
   - modules / program solver / doors / placer / overrides → `v2-design-modules-placer-doors.md`
   - IFC furniture type library / editor internals / worker → `v2-design-ifc-furniture-editor-worker.md`
   The exploration reports (`v2-explore-*.md`) explain the v1 code you are replacing, with line numbers as of commit
   05246fb; verify against the current tree before relying on a line number.
3. The frozen contract files (below). Read them fully; implement against them exactly.

## Runtime and tooling

- Node 24 native TypeScript type-stripping: run anything with `/Users/samarvir/.nvm/versions/node/v24.21.0/bin/node`.
- **Erasable TypeScript only**: no `enum`, no value `namespace`, no parameter properties, no decorators, no `const enum`.
  `import type` for types. Relative imports MUST carry the `.ts` extension. Classes declare fields explicitly.
- Zero runtime dependencies. No `Math.random` (use the passed `Rng` or `createRng(label)` from `src/core/rng.ts`),
  no `Date.now()` in geometry, no `Map` iteration order that is load-bearing for output (sort or use canonical orders).
- Type-check: `npm run typecheck` (TypeScript 5.9 from the sibling formaCAD checkout) **must exit 0** at every step.
- Tests: `node --test 'src/**/*.test.ts'` **must pass** at every step. Add your own `*.test.ts` next to your code.
- Performance budget: the 22-storey `ca-point-tower` and the 171-unit `ie-courtyard` must each generate in < 2 s in
  Node (baseline 256 ms / 337 ms). Everything is O(n) with small constants — never a pairwise clash loop over elements.
- No `console.log` in library code. No files outside the repo. Do not touch `dist/` or `docs/index.html`.
- **Do not commit.** Fable commits once per wave. Leave the working tree clean of scratch files.

## The six principles (from the plan) — apply them, do not re-litigate them

1. One owner per fact, decided before anyone consumes it (structural pre-sizing runs before architecture).
2. Reservations, not collision checks: every MEP element sits inside a reservation of its discipline (kernel).
3. Modules with ports: unit plans/cores/breaks/MEP rooms are pre-validated legos; ports give stacking for free.
4. Feasibility before placement: a module's admissible frontage range is derived from its program; the placer only
   uses admissible ranges — "too small for the template" cannot occur.
5. Rules are data: tunables are `Rule` records read through `ctx.rules` (`rules.num('ARC-03.maxLegLength', 45)`);
   the fallback argument is today's constant so behaviour is unchanged until the rule set lands.
6. Resolve, then record: when an input cannot be honoured, apply a named resolution and add an `info`/`deviation`
   issue. **Never add a new `ctx.warnings.push`.** Use `ctx.issues?.add({...})` (the ledger mirrors into `warnings`
   during migration). A `violation` means the generator failed to satisfy a rule it should have — treat it as a bug.

## Frozen contracts (do not change; if a field is genuinely missing, add it OPTIONAL and list it in your report)

| # | file | what |
|---|---|---|
| F1 | `src/core/rules/types.ts` | Rule, RuleScope, PredicateId, ResolutionId, Issue, Deviation, Ledger, RuleSet, Subject, World, RoomGraph, RuleOverrides, CustomRule |
| F2 | `src/core/kernel/types.ts` | Box3, ElementKind, Band, CeilingProfile, StoreyProfile, ProfileBook, Lane, LaneSet, Reservation, Conflict, ShaftSlot, Chase, Sleeve, Kernel, InvertModel, Support, SHAFT_SYSTEM_ORDER |
| F3 | `src/disciplines/structure/presize.ts` | StructuralPresize, StoreySizing, GridProposal, BayGrid, bayGridFrom, defaultBayGrid (body of presizeStructure owed by S) |
| F4 | `src/core/openings.ts` + DoorDef v2 in `src/core/types.ts` | solveSwing, hingePoint, latchPoint, leafTip, swingRect, swingArc, latchSide, drawsArc, doorOperation, LEAF_MIN |
| F5 | `src/disciplines/architecture/program/types.ts`, `src/modules/types.ts`, `src/disciplines/architecture/placer/types.ts`, `unit-layout-types.ts` v2 fields | ProgramGraph/Feasibility/ports, ModuleCatalogue, Slot/FloorLayout v2/ClampCtx/ClampResult, UnitLayoutRequest/UnitLayout v2 |
| F6 | `src/core/overrides.ts` | OverrideDoc, LayoutEdit, UnitEdit, hashEdits/hashOverrides, editsFor |
| F7 | `src/disciplines/site/corridor-graph.ts` | CorridorGraph, CorridorLeg, BreakSlot, Knuckle (body of buildCorridorGraph owed by R) |
| F8 | `src/core/furniture-3d.ts` + `ElementGeometry.instance` | Solid, FurnitureTypeDef, FURNITURE_TYPES, stretchKey/typeById/quantizeFurnitureWidth, symbolFromSolids |
| — | `src/core/types.ts` v2 optional fields | GenContext.presize/kernel/rules/issues/onPhase, DesignModel.issues/rules, BuildingSpec.rules/overrides, MassingSpec v2, ArchModel.partyLines/chases/layouts, UnitInstance ports/slotId/layoutKey, *.ref, CorridorSpine.legs, fixture/slab type unions |

Optional-today fields become required at the end of the wave that implements them (Fable flips them).

## Ownership (edit only what you own; shared seams are listed; anything else → ask in your report)

| agent | owns |
|---|---|
| **K** kernel + rules | `src/core/kernel/**` (except types.ts), `src/core/rules/**` (except types.ts), `src/pipeline.ts` wiring, `src/core/coordination.ts` (shim → deletion), `src/core/patterns.ts` (rule lifting), `src/coordination.test.ts`, `src/presets.test.ts`, `src/no-duplicate-constants.test.ts` |
| **S** structure | `src/disciplines/structure/**` |
| **R** site + spec | `src/disciplines/site/**`, `src/core/spec.ts`, storeys min/max + override toggle in `src/app/form.ts` |
| **D** doors + kits + ports | door producers/consumers everywhere (unit-layout, floor-organizer, cores, common-rooms, arch-elements crossLink, plan-svg door loop, electrical latchSide, mock-model, test fixtures), `src/disciplines/architecture/program/kits.ts`, `doors.test.ts`, `kits.test.ts`, `ports.test.ts` |
| **P** program solver | `src/disciplines/architecture/program/**` (except types.ts and kits.ts), shrinking `unit-layout.ts`, `clampUnitEdit` |
| **L** modules + placer + overrides | `src/modules/**` (except types.ts), `src/disciplines/architecture/placer/**` (except types.ts), `floor-organizer.ts`, `cores.ts`, `architecture/index.ts`, `types-internal.ts`, `clampLayoutEdit` |
| **F** IFC furniture | `src/core/furniture-3d.ts` body, `src/ifc/vendor/ifc-lite-create/**` (+ NOTICE.md), `src/ifc/writer.ts`, `src/ifc/validate.ts`, `src/ifc/furniture-types.ts`, furniture bucket + `elementFootprint` in `src/app/plan-svg.ts`, `src/app/axon-svg.ts`, furniture phase in `arch-elements.ts`, `mock-model.ts` instance samples |
| **M1** mechanical + electrical (wave 2) | `src/disciplines/mechanical/**`, `src/disciplines/electrical/**` |
| **M2** plumbing (wave 2) | `src/disciplines/plumbing/**` |
| **A1** app editor (wave 2) | `src/app/edit/**`, `src/app/viewport.ts`, hits/slot/unit buckets + pickHit in `plan-svg.ts`, modes in `main.ts`, `state.ts` editor fields, `styles.css` |
| **A2** app worker + rules + issues (wave 2) | `src/app/worker/**`, `backend.ts`, `entry.*.ts`, `index.html`, `scripts/build.mjs`, `export.ts`, `run()` in `main.ts`, rules tab, issues panel, `form.ts` |

Stub-then-swap seams (so agents run in parallel): P stubs `fitKit` from `kitMinDims` until D lands; L stubs
`feasibleAt` from `UNIT_TEMPLATES` frontage/depth ranges until P lands and uses `defaultBayGrid` until S lands;
M1/M2 start against a stub `createKernel` returning fixed profiles until K's registry lands; A1 ships against clamp
stubs until L/P land. Write every test against the real API so the swap is a one-line change.

## Conventions

- Element ids from `new IdFactory('<discipline>').next(storeyId, 'KIND')`; unit/room/door/furniture carry `ref`.
- Coordinates as in v1: metres/radians, world XY, storey-local Z (0 = finished floor), polygons CCW not closed.
- Doors: producers call `solveSwing()` and store `motion/hinge/swing/swingIntoRoomId`; consumers use the helpers in
  `src/core/openings.ts`. Nothing infers a swing from a wall normal. `operation` is derived by `doorOperation()`.
- Kernel (wave 2): every horizontal MEP run through `kernel.reserveLaneRun` / `reserveCrossing`, every riser through
  `reserveRiser`, every stack through `chaseOf(unitId)`, every penetration through `sleeve()`; `kernel.validate` must
  return zero violations for your discipline on all 10 presets.
- Patterns: keep recording `PatternApplication`s; new patterns XD-06…XD-12, STR-C1…C5, XD-S0…S5, PLB-S1…S4 are
  registered by their owners (K registers XD-*, S registers STR-C*, M2 registers PLB-S*).
- Determinism: same spec → byte-identical model JSON and IFC. Tests assert it.

## Definition of done and report

Before reporting: `npm run typecheck` exits 0; `node --test 'src/**/*.test.ts'` passes; your new tests exist; the
10 presets still generate (`node src/cli/main.ts --all-presets --out dist/samples --validate`); no stray files.
Report (short, no large code): files created/changed/deleted; exported API; what became dead code and was removed;
test command + result; performance numbers; any optional field you added to a frozen type; anything another owner
must change (exact file/field names); known limitations.
