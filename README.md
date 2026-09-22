# forma-resi-ifc — parametric residential building → IFC

A design-based parametric generator for residential buildings. A human picks a **building
typology** and per-floor parameters; six discipline agents then design the building in sequence
and the result is written to **IFC4** with ifc-lite's `IfcCreator`:

```
spec ──► site + massing ──► architecture (floor plans, furniture) ──► structure
                                                                     └──► mechanical ──► plumbing ──► electrical ──► IFC + metrics + pattern trace
```

**Live app:** https://samarv.github.io/forma-resi-ifc/ (GitHub Pages, served from `docs/index.html`).

Everything is deterministic (seeded), dependency-free TypeScript that runs in Node 24 and in the
browser. The shareable artifact is the single file `dist/forma-resi-ifc.html` (≈ 1.2 MB, works
offline; the optional 3D tab embeds the ifc-lite WebGPU viewer from embed.ifclite.com).

## What v2 changed (2026-09-22)

v1 generated each discipline in turn and pushed a warning whenever an upstream decision made its job impossible
(51 on the courtyard preset). v2 makes those conflicts impossible by construction:

- **One owner per number.** A structural pre-sizing pass (`src/disciplines/structure/presize.ts`) runs before
  architecture and publishes slab thickness, beam depth, core-wall thickness, transfer storey and the bay grid;
  architecture and MEP read it. A load-path check (`loadpath.ts`) verifies column continuity, foundations under every
  support, slab-edge support and balcony cantilevers on every preset.
- **Modules ("legos") with ports.** Unit plans are 20 program graphs (rooms with kit-derived minima, required and
  forbidden adjacencies, wet groups) solved only where a feasibility witness proves the frontage/depth fits
  (`src/disciplines/architecture/program/`). A catalogue of 87 modules — 45 unit template × variant, cores with
  purpose-tagged shaft slots, corridor breaks, MEP rooms, parking bays — is packed along corridor legs by a quota
  packer that snaps party walls to the structural bay (`src/modules/`, `src/disciplines/architecture/placer/`).
  Every dwelling publishes stack, exhaust and panel ports; plumbing puts its stacks where the ports are.
- **Doors.** `DoorDef` stores motion, hinge and swing, derived once at production (`src/core/openings.ts`); the plan
  arc, the IFC operation token and the switch position all read the same fields. On all ten presets every swing door
  sweeps the room it serves (v1: 492 of 1,827).
- **Complete kits.** 28 furniture kits with sourced clearances; every kitchen has a sink, range and fridge, every
  bath a WC, basin and shower/tub (v1 placed 243 of 805 complete baths).
- **Site resolves instead of warning.** The parking solver adds basement levels until the ratio is met; corridors are
  split into legs ≤ 45 m with break slots and joined at knuckles (an O-plan is one corridor); the storey count is held
  to the typology band unless explicitly overridden.
- **Coordination kernel + rules.** Nine per-use ceiling profiles (dwelling, corridor spine, parking, retail shell,
  plant room, roof) as data with band order, clearances and rationale; lanes with widths; one shaft-slot allocator;
  a 766-rule set lifted from the pattern parameters; structured issues (`model.issues`) with a warnings projection
  (`src/core/kernel/`, `src/core/rules/`).
- **IFC furniture as mapped items.** 45 furniture types built from 3–8 primitives, written once as
  `IfcFurnitureType` + `IfcRepresentationMap` and instanced with `IfcMappedItem`; property values and placements
  are shared. us-5-over-1 went from 313k to 225k entities and 21.5 to 16.0 MiB while gaining 3D furniture.

Deferred (designed in `docs/design/v2-plan.md`, not built): the interactive floorplan editor and rules tab, moving
mechanical/electrical onto the kernel's reservations, and the sump/ejector for basement drainage. The kernel already
records the mechanical/electrical coordination findings on every preset as issues.

## Quick start

```bash
# Node 24 runs TypeScript natively (erasable syntax only)
export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"

node src/cli/main.ts --list-presets
node src/cli/main.ts --preset us-5-over-1 --out dist/samples --validate --report
node src/cli/main.ts --all-presets --out dist/samples --validate --report
node --test 'src/**/*.test.ts'        # 548 tests
npm run typecheck                     # tsc --noEmit --strict, must exit 0
node scripts/build.mjs                # → dist/forma-resi-ifc.html
node scripts/serve.mjs 8765           # serve dist/ locally
```

The project itself has **no dependencies** — `npm run typecheck` is the one exception: it shells out
to the TypeScript 5.9 compiler of the sibling `formaCAD` checkout
(`/Users/samarvir/formaCAD/node_modules/.bin/tsc`, with its `@types/node` as the only type root), so
it needs that install present. Everything else (tests, generation, build) runs on bare Node 24.
The flags mirror what Node's type-stripping accepts: `--erasableSyntaxOnly`,
`--verbatimModuleSyntax` and `--allowImportingTsExtensions`.

## Inputs (what the human selects)

| Level | Parameters |
|---|---|
| Typology | 16 residential types of the English-speaking world (`src/core/typologies.ts`): detached house, ADU/laneway, semi-detached, townhouse row, stacked flats, garden walk-up, mansion block, corridor mid-rise (5-over-1), deck access, courtyard block, point tower, slab tower, podium + tower, co-living cluster, senior living, mixed-use mid-rise. Each carries regional names (US/UK/CA/AU/NZ/IE), access type, storey range, bar depth, unit mix, parking, structural/HVAC/DHW defaults and the patterns it relies on. |
| Site | frontage, depth, street orientation, context, setbacks, zoning caps (FAR, height, coverage), parking type/ratio/EV share |
| Massing | storeys, footprint shape (bar/L/U/O/point/T), bar depth/length, floor-to-floor, podium, basements, corridor width, cores, roof, balconies |
| Per floor | use, floor-to-floor, ceiling, window-to-wall ratio, balconies, target units, unit-mix override |
| Unit mix | weights over 20 floor-plan templates (`src/disciplines/architecture/templates.ts`) |
| Options | disciplines on/off, furniture, detail level, IFC schema, seed |

## The 20 floor-plan templates

studio · micro-studio · junior 1-bed · 1b1b · 1-bed + den · 2b1b · 2b2b · 3b2b · 4b2b · dual-key ·
corner 2b2b · loft live-work · maisonette (2 levels) · townhouse 2-storey · townhouse 3-storey ·
ranch 3-bed · colonial 4-bed · ADU 1-bed · co-living cluster · senior accessible 1-bed.

Each template is a room program (target/min areas, min widths, wet/exterior needs, public/private
zone) laid out parametrically inside whatever unit rectangle the floor organiser hands it. Two plan
types exist: the zoned plan (service band on the access side, daylit band opposite) and the
through-flat plan (side entry from a landing, rooms on both long faces, hall between) used by
stair-core typologies. Furniture is placed by rule from a 45-item catalogue (bed opposite the door,
kitchen run along the wet wall, WC clearances, work triangle …).

## Pattern language

Every rule is an explicit, parametric **pattern** (`Pattern` in `src/core/types.ts`) with an
Alexander-style problem/solution, parameters with units and sources, and a recorded trace of where it
was applied. 100 patterns are registered: five cross-discipline (XD-01 Wet Wall Stacking, XD-02
Corridor Service Spine, XD-03 Structure Follows Party Walls, XD-04 Shafts at the Core, XD-05 Design
Occupancy Drives Systems) plus SIT-01…12, ARC-01…36, STR-01…11, MEC-01…12, PLB-01…12, ELE-01…13.

## Metrics

`src/core/metrics.ts` defines the top-20 building metrics with regional names — GFA/GIA, NIA/NSA,
efficiency, FAR/plot ratio/FSR, coverage, dwellings per hectare (du/ac), unit count and mix, average
unit area, bedspaces, height, floor-to-floor, circulation ratio, wall-to-floor, WWR, dual aspect,
parking and bike ratios, open space per unit, egress travel distance, electrical service size — plus
supplementary structural tributary area, plumbing DFU, cooling load, embodied carbon, EUI,
construction cost, setback compliance, facade area and storeys.

## Presets and output (all validate as IFC4)

| preset | typology | storeys | dwellings | elements | IFC entities | IFC | warnings |
|---|---|---|---|---|---|---|---|
| us-5-over-1 | corridor mid-rise on parking podium | 6 | 85 | 28,288 | 224,891 | 16.0 MiB | 0 |
| uk-terrace | terraced houses | 3 | 6 | 4,484 | 42,138 | 2.8 MiB | 1 |
| ca-point-tower | podium + point tower | 22 | 190 | 53,246 | 405,703 | 29.8 MiB | 5 |
| au-walkup | garden walk-up | 3 | 16 | 6,156 | 54,266 | 3.7 MiB | 2 |
| us-detached | detached house | 2 | 1 | 721 | 9,657 | 0.6 MiB | 2 |
| uk-mansion | mansion block | 5 | 30 | 13,136 | 108,525 | 7.5 MiB | 2 |
| ie-courtyard | courtyard block | 5 | 219 | 70,649 | 570,997 | 41.0 MiB | 1 |
| nz-coliving | co-living cluster | 4 | 29 | 9,691 | 84,547 | 5.8 MiB | 0 |
| us-senior | assisted living (L-plan) | 3 | 63 | 20,148 | 179,887 | 12.4 MiB | 0 |
| ca-laneway | laneway house | 2 | 1 | 562 | 7,216 | 0.5 MiB | 3 |

The remaining warnings are genuine model limits (the sewer invert is modelled at ground so basement fixtures would
need an ejector; a laneway house sits outside its typology's site band), not coordination defects.

## Layout

```
src/core/            shared contract (types), geometry, rng, ids, units, patterns, coordination lanes, typologies, spec/presets, metrics
src/disciplines/     site · architecture (templates, unit-layout, floor organiser, cores) · structure · mechanical · plumbing · electrical
src/ifc/             writer (ModelElement → IfcCreator, shared psets, systems, zones), STEP validator, vendored ifc-lite create (MPL-2.0)
src/cli/             command line
src/app/             single-file web app (2D plans, site plan, metrics, patterns, elements, embedded ifc-lite 3D viewer, axon fallback)
scripts/             build.mjs (esbuild → single HTML), serve.mjs
```

## Conventions

Metres and radians. World origin at the site's front-left corner, +X along the street, +Y into the
site, +Z up. Element Z is storey-relative (0 = finished floor of that storey). Ids are deterministic
(`ARC-L03-WALL-017`, `U-L03-04`, `SYS-PLB-DCW`). Horizontal services run in fixed corridor lanes
(ducts on the centreline, wet pipes and sprinkler main toward one side, cable trays toward the
other); vertical risers share the core shafts (mechanical centre, plumbing min corner, electrical max
corner); plumbing stacks live in the dwellings' wet walls. See `CONTRACT.md`.

## Known limitations

Rectilinear geometry only (no curved or angled plans). The delivered unit mix follows what the bar depth admits, so it
can drift from the requested weights on shallow bars. Mechanical and electrical still route on the v1 lane conventions
(the kernel records their coordination findings as issues rather than resolving them), and basement drainage below
the sewer invert is noted, not pumped. Loads are intensity-based estimates, not heat-balance or circuit calculations.
The floorplan editor and the rules tab are designed (`docs/design/v2-plan.md`) but not yet built; edits can be applied
today by writing `spec.overrides` / `spec.rules` into the spec JSON.

## Licence

Generator code: MPL-2.0 (to match the vendored ifc-lite code in `src/ifc/vendor/`).
