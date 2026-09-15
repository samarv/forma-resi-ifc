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
browser. The shareable artifact is the single file `dist/forma-resi-ifc.html` (≈ 830 kB, works
offline; the optional 3D tab embeds the ifc-lite WebGPU viewer from embed.ifclite.com).

## Quick start

```bash
# Node 24 runs TypeScript natively (erasable syntax only)
export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"

node src/cli/main.ts --list-presets
node src/cli/main.ts --preset us-5-over-1 --out dist/samples --validate --report
node src/cli/main.ts --all-presets --out dist/samples --validate --report
node --test 'src/**/*.test.ts'        # 296 tests
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

| preset | typology | storeys | dwellings | IFC |
|---|---|---|---|---|
| us-5-over-1 | corridor mid-rise on parking podium | 6 | 80 | 21.5 MiB |
| uk-terrace | terraced houses | 3 | 7 | 3.6 MiB |
| ca-point-tower | podium + point tower | 22 | 114 | 34.2 MiB |
| au-walkup | garden walk-up | 3 | 24 | 6.2 MiB |
| us-detached | detached house | 2 | 1 | 0.7 MiB |
| uk-mansion | mansion block | 5 | 20 | 7.7 MiB |
| ie-courtyard | courtyard block | 5 | 171 | 52 MiB |
| nz-coliving | co-living cluster | 4 | 12 | 5.1 MiB |
| us-senior | assisted living (L-plan) | 3 | 72 | 18.8 MiB |
| ca-laneway | laneway house | 2 | 1 | 0.4 MiB |

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

Rectilinear geometry only (no curved or angled plans); L/U/O wings each carry their own corridor
and core, and the corridors do not yet join at the knuckle; achieved building-wide WWR is below the
per-unit target because cores and podium floors are lightly glazed; loads are intensity-based
estimates, not heat-balance or circuit calculations; IFC is IFC4 STEP with extruded solids
(no mapped items), so large presets are tens of megabytes.

## Licence

Generator code: MPL-2.0 (to match the vendored ifc-lite code in `src/ifc/vendor/`).
