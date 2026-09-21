# Exploration: web app, IFC writer, vendored IfcCreator, ifc-lite engine, tooling

_Generated 2026-09-21 by a read-only design/exploration pass over this repository; line numbers refer to the v1 code at commit 05246fb. Source of truth for v2 contracts is docs/design/v2-plan.md and the files under src/core._

I have a complete picture. Here is the map.

---

# forma-resi-ifc — exhaustive map for (a) floorplan editor, (b) rules UI, (c) mapped-item furniture

All paths absolute. Repo root `/Users/samarvir/formaIFC/generator`, upstream clone `/Users/samarvir/formaIFC/ifc-lite`.

---

## 1. App architecture (`src/app/*`)

### 1.1 Entry points, backend registry, build-time constants

| File | Role |
|---|---|
`/Users/samarvir/formaIFC/generator/src/app/entry.real.ts` (38 L) | Statically injects `setArchitectureDeps({ templates: UNIT_TEMPLATES, layoutUnit })` at line 20 (a single-file bundle cannot `await` a dynamic import before the first sync generate), builds `REAL_BACKEND` (25-34), registers real **and** mock, then `boot()`.
`/Users/samarvir/formaIFC/generator/src/app/entry.mock.ts` (7 L) | Mock only.
`/Users/samarvir/formaIFC/generator/src/app/backend.ts` (49 L) | `interface Backend { kind: 'real'\|'mock'; generateBuilding(spec: PartialSpec\|BuildingSpec): DesignModel; writeIfc(model: DesignModel): IfcOutput; metrics: MetricDef[]; templates: UnitTemplateDef[] }` (9-15). `registerBackend` (20), `mockRequested()` = `?mock=1` (26-32), `backend()` (34-38), `asArray<T>()` (44-47).
`/Users/samarvir/formaIFC/generator/src/app/env.ts` (6 L) | `BUILD_BACKEND`, `BUILD_ID` from esbuild `--define:__BACKEND_MODE__` / `__BUILD_ID__`.
`/Users/samarvir/formaIFC/generator/src/app/mock-generate.ts` (20 L) | `MOCK_BACKEND` wrapping `buildMockModel` / `mockWriteIfc`.

`entry.real.ts:28-31` calls `writeIfc(model, { schema: model.spec.options?.ifcSchema, author: 'forma-resi-ifc web app' })` via a `WriterFn` cast — note it does **not** pass `compact`, so compactness is derived from `spec.options.detail !== 'high'` (`writer.ts:349`).

### 1.2 State

`/Users/samarvir/formaIFC/generator/src/app/state.ts` (97 L) — **one mutable module-level object**, no framework:

```ts
export interface AppState {
  presetId: string; spec: PartialSpec; model: DesignModel | null; ifc: IfcOutput | null;
  ifcError: string | null; busy: boolean; error: string | null; genMs: number;
  tab: TabId; storey: string; layers: Layers; pinned: string | null; highlight: string | null;
  showAllTemplates: boolean; patternQuery: string; elementType: string | null;
  axonMode: boolean; specJsonOpen: boolean;
}                                                             // state.ts:20-39
export const state: AppState = { … }                          // state.ts:50-69
export interface Layers { rooms; arch; site; struct; mech; plumb; elec; furniture; labels; grid: boolean } // 7-18
export const DEFAULT_LAYERS: Layers                            // 41-44
export function defaultSpec(): PartialSpec                     // 46-48  (clone of PRESETS[0].spec)
export function structuredCloneSafe<T>(v: T): T                // 91-97
```

**`subscribe` / `emit` / `setState` (state.ts:74-88) are dead code** — nothing imports them (verified by grep). `main.ts` mutates `state` directly and calls `renderX()` imperatively. There is no reactivity layer to fight, which is good news for an editor, but also no change-notification to hook into.

`Layers.site` exists but has **no toolbar chip** (`LAYER_CHIPS` in `main.ts:29-39` omits it), so it is permanently `true`.

### 1.3 Generation: synchronous, main thread, no worker

`grep -rn "new Worker" src/` → **zero hits**. Generation is fully synchronous:

```
main.ts:228   const scheduleRun = debounce(() => void run(false), 400);
main.ts:230   async function run(force: boolean): Promise<void>
main.ts:231     if (state.busy) { queuedRun = true; return; }   // re-entrancy guard
main.ts:233     showSpinner('Generating…');
main.ts:234     await nextFrame();                              // util.ts:116 rAF×2 racing a 60 ms timer
main.ts:240     full = normalizeSpec(state.spec);
main.ts:245     const model = b.generateBuilding(full);          // ← blocking
main.ts:252     state.ifc = b.writeIfc(model);                   // ← blocking, separate try/catch → state.ifcError
main.ts:259     if (!model.storeys?.some(…)) state.storey = defaultStorey(model);
main.ts:260-262 state.pinned = null; state.highlight = null; fitted = {plans:true,site:true,axon:true};
main.ts:277     if (queuedRun) { queuedRun = false; void run(false); }
```

`nextFrame()` exists purely so the spinner paints before the block. `force` is accepted and then discarded (`void force`, line 264) — there is no caching/short-circuit. Measured cost of a full `us-5-over-1` regeneration (below) is ~1-2 s, so a debounced editor drag that triggers `run()` per mousemove will stall the UI; see §9.

### 1.4 Spec editing — `form.ts` (524 L)

`/Users/samarvir/formaIFC/generator/src/app/form.ts` renders the sidebar as **one `innerHTML` string** and binds delegated listeners once on the sidebar root.

Path helpers (the mechanism any "overrides"/"rules" editor should reuse):
```ts
export function getPath(obj: unknown, path: string): unknown            // form.ts:18-25
export function setPath(obj: Record<string,unknown>, path: string, value: unknown): void  // 27-38 (deletes key when value===undefined)
export function parseValue(kind: string, raw: string, units): unknown   // 41-57 ('bool'|'len'|'num'|'int'|str; 'len' converts ft→m, rounds to mm)
```

Control factories: `numRow` (62-71), `selRow` (73-79), `option` (81-83), `chk` (85-87), `section` (275-277), `field` (278-280), `numInput` (281-285), `sel` (286-288). Every control carries `data-p="<dot.path>"`, `data-t="<kind>"`, optional `data-s="1"` = *structural* (triggers a full form rebuild).

`renderForm(root: HTMLElement)` (109-268) — 8 sections:
1. **Project** (129-144): preset `<select data-preset>`, name, seed + `data-act="dice"`, region, metric/imperial segmented control (`data-units`).
2. **Typology & height** (155-167): grouped `<optgroup>` by `AccessType`, storey slider + number twinned on `massing.storeys`.
3. **Site** (172-198): width/depth/streetFacing/context/slope, setback overrides, zoning caps (maxFar/maxHeight/maxCoverage), parking type + ratios.
4. **Massing** (202-227): footprintShape, buildingDepth/Length, f2f, groundF2F, podium, basements, corridorWidth, coreCount, balconyDepth, roof + pitch, parapet.
5. **Unit mix** (230-232 → `unitMixTable`, 290-315): a `<table>` of `UNIT_TEMPLATE_IDS` filtered by `tpl.suitableTypologies.includes(t.id) || mix[id] > 0`, each row a `<input type=range min=0 max=5 data-mix="<id>">`; "Show all 20 templates" checkbox (`data-act="all-tpl"`).
6. **Floors** (235 → `floorTable`, 317-346): **the per-floor table**. One row per resolved floor; cells carry `data-f="<index>" data-ff="<field>"`:
   - `Lvl` label (`B{n}` / `L{n+1}`), `use` `<select>`, `floorToFloor`, `ceilingHeight`, `wwr`, `balconies` checkbox, `targetUnits`, and a `data-mixfor="<index>"` button that expands a nested `<tr class="mix-row">` of per-floor unit-mix sliders (`data-f` + `data-mix`). Open rows tracked in a module-level `const openMixFloors = new Set<number>()` (348).
   - Edits go through `handleFloor` (492-505) → `ensureFloor(index)` (507-520) which lazily pushes `{ index, use }` into `state.spec.floors` and keeps it sorted. Hint text at 345: *"Edits are stored as per-index overrides in `spec.floors`"* — **this is the existing precedent for the `overrides` section you want.**
7. **Generation options** (239-250): 6 discipline checkboxes, `detail`, `ifcSchema`.
8. **Spec JSON** (253-255): `<pre>` of `JSON.stringify(state.spec, null, 2)` inside a `<details data-json>`; open state persisted in `state.specJsonOpen`.

Re-render preserves `<details>` open state keyed by `sectionKey()` (271-273, which strips the `" (6)"` count) and `root.scrollTop` (115, 264).

Wiring — `attachForm(root, hooks: FormHooks)` (380-469):
```ts
export interface FormHooks { onChange: (structural: boolean) => void; rerender: () => void }  // 373-378
```
- `delegate(root,'input','[data-p]')` + `delegate(root,'change','[data-p]')` → `handlePath` (471-490). The `(isSelect||isCheck) !== isChange` guard at 478 makes text/number/range fire on `input` and select/checkbox on `change`.
- `[data-ff]` → `handleFloor`.
- `[data-mix]` → inline unit-mix mutation (402-423), building-wide or per-floor, `hooks.onChange(false)`.
- `[data-preset]` (426-435): replaces `state.spec` with `structuredCloneSafe(p.spec)`, clears `openMixFloors`, structural commit.
- `[data-units]` (438-441), `[data-act]` dice/reset/all-tpl (443-458), `[data-mixfor]` (460-464).
- Any `[data-p]`/`[data-ff]` edit sets `state.presetId = '__custom'` (488, 503).

`main.ts:68-71` supplies `{ onChange: () => scheduleRun(), rerender: () => renderForm(byId('sidebar')) }` — note `onChange`'s `structural` argument is **ignored** by main.ts; the form itself calls `hooks.rerender()` for structural edits (385-390) and refocuses via `data-p`/`data-ff` (386-389).

### 1.5 Tabs, warnings, export, persistence

**Tabs** — `main.ts:24-27`: `['plans','Plans'], ['viewer','3D (ifc-lite)'], ['site','Site'], ['metrics','Metrics'], ['patterns','Patterns'], ['elements','Elements']`. `TabId` in `state.ts:5`. Shell built once in `buildShell()` (99-183); the panel markup (106-143) is a single template string. `selectTab` (293-302) toggles `aria-selected` + `.is-active`, then `renderTab` (304-329) dispatches to `renderPlans` / `renderViewer` / `renderSitePanel` / `renderMetrics` / `renderPatterns` / `renderElements`, each wrapped in a try/catch that writes `state.error` and calls `renderStatus()`. `updateTabCounts()` (335-347) writes `[data-count="<tab>"]` badges.

Views: `/Users/samarvir/formaIFC/generator/src/app/metrics-view.ts` (120 L, `renderMetrics(root, model, defs, units)`, headline-20 tiles by `MetricCategory` then a supplementary table), `/Users/samarvir/formaIFC/generator/src/app/patterns-view.ts` (92 L, `renderPatterns(root, model, query)` grouped by discipline, search over id/name/problem/solution/references/param keys at line 27-28), `/Users/samarvir/formaIFC/generator/src/app/elements-view.ts` (82 L, `renderElements(root, model, selectedType, highlight)` + `findElement(model, id)` with exact → case-insensitive → substring fallback at 73-82, list capped at `LIST_CAP = 200`).

**Warnings** — `renderStatus()` (`main.ts:775-820`). Status bar shows element count, IFC entity count, file size, gen time, a "slow" nudge above 3 s (785-787), a `▲ N warnings` button when `model.warnings.length` (788-790), `state.ifcError`, `state.error`, the mock/real badge and the build id. The warning button toggles a `div.warn-pop` `<ol>` appended to `document.body` with an outside-click dismisser (802-818). `flashStatus(msg)` (761-773) shows a 4 s transient `.stat-flash`.
> **Gap:** `IfcOutput.warnings` (populated by the writer, up to `MAX_WARNINGS = 500`) is **never read** — not in `renderStatus`, not in `buildReport`. Only a thrown writer error surfaces (`state.ifcError`). Verified by grep.

**Export** — `/Users/samarvir/formaIFC/generator/src/app/export.ts` (111 L):
```ts
export function safeFileName(name: string): string                       // 4-7
export function downloadText(filename, mime, text): void                 // 9-20 (Blob + <a download>, revokes after 4 s)
export interface Report { generatedAt; backend; spec; typology; storeys[]; metrics; patterns{registered,applied,applications,byPattern}; elements{total,byDiscipline,byIfcType}; ifc{entityCount,fileSize,schema}|null; warnings; timings }  // 22-34
export function buildReport(model, ifc, backend): Report                 // 36-65
export async function copyText(text): Promise<boolean>                   // 67-86 (clipboard → hidden textarea fallback)
export function readJsonFile(file: File): Promise<unknown>               // 88-101
export function specFromLoaded(data: unknown): unknown                   // 104-111 (accepts a bare spec with `typology`, or a report with `.spec`)
```
Header buttons wired in `wireHeader()` (`main.ts:185-223`): Generate, Download IFC (`.ifc`, `application/x-step`), Download report (`-report.json`), Copy spec (clipboard JSON), Load spec (`<input type=file>` → `readJsonFile` → `specFromLoaded` → `normalizeSpec` as validation → adopt → `presetId='__custom'` → `renderForm` → `run(true)`).

**Persistence: none.** `grep -rn "localStorage|sessionStorage|location.hash|history.replaceState"` over `src/` yields exactly one hit — `new URLSearchParams()` in `viewer-embed.ts:46`, building the iframe query. The only URL input the app reads is `?mock=1` (`backend.ts:27`). State lives entirely in memory; the persistence story is "Copy spec / Load spec". A debug handle is exposed at `main.ts:832-843`: `globalThis.__forma = { state, presets, run(), get plan, get site, get viewer, layers, q }`.

---

## 2. 2D plan rendering (`plan-svg.ts` 655 L, `svg.ts` 137 L, `viewport.ts` 249 L, `site-svg.ts` 207 L, `axon-svg.ts` 181 L, `util.ts` 149 L)

### 2.1 Technique: string templating, one `<path>` per colour bucket

`buildPlan()` is a **pure function producing an SVG markup string** — no DOM, which is why `render.test.ts` can run it under `node --test`.

```ts
export interface Hit { id: string; kind: string; label: string; x0,y0,x1,y1: number; meta: [string,string][] }  // plan-svg.ts:21-27
export interface Drawing { body: string; defs: string; hits: Hit[]; bounds: Rect; counts: Record<string,number> } // 29-36
export function buildPlan(model: DesignModel, storeyId: string, layers: Layers, units: DisplayUnits, highlight: string|null): Drawing  // 153
```

Batching: `type Bucket = Map<string,string[]>` + `bput()` (41-45) accumulates `d` fragments per colour key, then one `pathEl(ds.join(''), {...})` per bucket. `const HAIR = { 'vector-effect':'non-scaling-stroke' }` (39) keeps linework at constant pixel weight at any zoom. `render.test.ts:59-62` asserts `paths < max(60, hits.length)`.

Coordinates: **world (metres, +Y from street into site) in, drawing coords (x, −y) out** — every `svg.ts` builder negates Y (`svg.ts:1-8`, `polyPath` at 10-15). No flip transform on the group.

### 2.2 Layer order (painting order = z-order)

| # | Layer group | plan-svg.ts | Content / fill rule |
|---|---|---|---|
1 | `g.l-site-ctx` | 169-174 | `model.site.boundary`, dashed `6 4`; only drives the fit when the storey has no `FloorPlan` |
2 | `g.l-outline` | 178-183 | `floor.outline`, `fill:var(--dwg-bg)`, `stroke:var(--dwg-outline)` 1.4 |
3 | `g.l-rooms` + `g.l-room-labels` | 186-224 | **Fill by unit template or by zone**: key `unit:${slotFor(templateId)}` → `var(--s${n})` @ `fill-opacity .16`, else `zone:${r.zone}` → `ZONE_FILL[zone]` (47-53) @ opacity 1, `fill-rule: evenodd`. Labels are per-object `<text>`, **measured before placing** (`fits`/`shortName`, 604-617) and dropped if they don't fit; second line = area when `rect.h > 1.5`; `pointer-events="none"` on the label group (223). |
4 | `g.l-circ` | 227-257 | Corridors → `fill:url(#hx2)`; cores and shafts → `fill:url(#hx)` + `stroke:var(--dwg-wall-core)`. **This is the core/shaft hatch.** Patterns defined in `svg.ts:125-137` (`#hx` 45°, `#hx2` 135°, plus a `#arw` marker). |
5 | `g.l-walls` | 260-281 | One bucket per `WallType` via `WALL_FILL` (55-66); `wallQuad(start,end,thickness)` solid fill, no stroke. `wallIdx: Map<string,WallDef>` built here (263) and reused by doors/windows. |
6 | `g.l-openings` | 283-322 | Four sub-paths: `cut` (background-coloured quad, `thickness*1.6` for doors / `*1.5` for windows), `leaf`, `arcs`, `winL` (two lines offset ±`thickness*0.3`). |
7 | `g.l-furn` | 326-348 | `boxQuad(position, width, depth, rotation)` outline only (`fill:none`, `stroke:var(--dwg-wall-part)` 0.9), plus a one/two-letter glyph per item when `w*d > 0.12` — `FURN_GLYPH` regex table at 73-80, `furnGlyph()` at 81-84. |
8 | `g.l-struct` | 351-406 | Grid lines (dashed `14 4 2 4`) + bubbles (circle + text, only when `layers.grid` **and** bounds already exist, 354), beams (dashed lines), struct walls (translucent), columns (solid fill). |
9 | `g.l-mech` | 409-452 | Ducts drawn twice per width bucket: a fat translucent stroke at real width (world units) + a hairline; terminals and equipment as boxes. |
10 | `g.l-plumb` | 455-494 | Pipes bucketed by `r.system` → `PIPE_COLOR` (68-71); fixtures as circles; stacks as filled circles + an `S` glyph. |
11 | `g.l-elec` | 497-548 | Trays (polyline), receptacles (hand-built `⊥` path at 516), lights (`starPath`), letters (`S`/`SD`/`T`), panels (boxes). |
12 | `g.l-generic` | 551-576 | **Only when the storey has no `FloorPlan`** (SITE/FND/ROOF/basement): every `ModelElement` footprint via `elementFootprint()`, bucketed by discipline (`DISC_DWG`, 593-596), gated by `layerFor()` (598-601). |
13 | highlight | 579-587 | Dashed `var(--dwg-hl)` rect, 0.25 m padding, around `hits.find(h => h.id === highlight)`. |

Geometry → footprint: `export function elementFootprint(g: ElementGeometry): Vec2[] | null` (98-131) handles wall/beam/railing/axis (as `wallQuad`), slab/prism (profile + position), column/box/footing/pile/roof/gable-roof/ramp/stair (as `boxQuad`). Returns `null` for `door-in-wall`/`window-in-wall`. Shared with `axon-svg.ts:10`.

Element lookup: `export function elementIndex(model): Map<string, ModelElement>` (88-95) is cached in a `WeakMap<DesignModel, …>` (87) — reusable for an editor's id→element resolution. `elMeta()` (138-149) appends IFC type, system, unitId, roomId and pattern ids to a hit's meta.

### 2.3 Hit-testing and the hover card

Hit boxes are **axis-aligned bounding boxes only** — `hitFromPoints(id, kind, label, pts, meta)` (133-136) stores `bboxOf(pts)`. No polygon-inside test anywhere.

```ts
export function pickHit(hits: readonly Hit[], x: number, y: number, tol = 0.15): Hit | null {  // plan-svg.ts:644-653
  // smallest-area hit whose bbox (expanded by tol) contains (x,y)
}
```

The hover card is built in `Viewport.hover()` (`viewport.ts:221-234`) into a single absolutely-positioned `div.dwg-tip` (created in the constructor at line 62, styled at `styles.css:298-306`, `pointer-events:none`):
```ts
this.tip.innerHTML = `<b>${esc(hit.label)}</b><br><span class="mono">${esc(hit.id)}</span>
  <dl>${hit.meta.slice(0,7).map(([k,v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;  // viewport.ts:228-229
```
Your example card — "Bedroom 1 · 7.1 m² … Template 3b2b" — is produced at `plan-svg.ts:197-201`: `label = \`${r.name} · ${fmtArea(r.area, units)}\``, `meta = [['Type',humanize(r.type)],['Zone',r.zone],['Area',…],['Unit',r.unitId],['Template', unitTpl.get(r.unitId)]]`, where `unitTpl` is `new Map(arch.units.map(u => [u.id, u.templateId]))` (189).

The **click** path is separate: `pinHit(which, hit)` (`main.ts:424-446`) sets `state.pinned` and fills `aside.side-card#card-plans` with label, id, `hit.meta`, then the element's `psets`, `quantities`, discipline/storey/geometry kind (pulled from `elementIndex`). Closed by `[data-close-card]` (`main.ts:165-170`).

Tolerances are inconsistent: hover uses `6 / this.k` world units (`viewport.ts:225`), click uses `0.2 / this.k * 10` = `2 / this.k` (`viewport.ts:212`).

### 2.4 Pan/zoom — `viewport.ts`

```ts
export class Viewport {
  constructor(host: HTMLElement, hooks: ViewportHooks)          // 58-78
  setDrawing(d: Drawing, refit: boolean): void                   // 80-86
  clear(): void                                                  // 88-92
  size(): [number, number]                                       // 94-97
  fit(): void                                                    // 99-119
  zoomBy(f: number, px: number, py: number): void                // 121-127
  toWorld(px: number, py: number): [number, number]              // 137-139
  centerOn(r: Rect): void                                        // 241-248
  private apply(): void                                          // 129-134
  private overlay(): void                                        // 141-167
  private bind(): void                                           // 169-219
  private hover(px, py): void                                    // 221-234
  private hideTip(): void                                        // 236-238
}
export interface ViewportHooks { units: () => DisplayUnits; streetFacing: () => Compass; onPick?: (hit: Hit|null) => void; showOverlay?: boolean }  // 33-38
export function northScreenDeg(streetFacing: Compass): number     // 18-23
export function niceScaleLength(target: number): number           // 26-31
```

Camera model: `screen = drawing * k + t`, with `drawing = (worldX, −worldY)`. Only the `<g class="cam">` `transform` changes while panning (`apply()`, 130), plus a rAF-coalesced screen-space overlay (scale bar 1:N, north arrow, "street at bottom (−Y)" caption). DOM skeleton created in the constructor at line 62:
```html
<svg><g class="defs"></g><g class="cam"></g><g class="ov"></g></svg><div class="dwg-tip" hidden></div>
```
`setDrawing` replaces `g.defs.innerHTML` and `g.cam.innerHTML` wholesale. Zoom clamp `[0.4, 4000]` (122). A `ResizeObserver` (70-77) defers the first `fit()` until the panel has a real size (`needsFit`, `fit()` bails below 24 px, 103-107).

Event model (`bind()`, 169-219) — **this is where a drag interaction has to slot in**:
- `wheel` (171-176), `{passive:false}`, `preventDefault`, exponential factor, zooms about the cursor.
- `pointerdown` (178-185): **`if (ev.button !== 0) return;`** then unconditionally `dragging = true`, `setPointerCapture`, `host.classList.add('is-panning')`.
- `pointermove` (186-199): if dragging → pan by delta, `hideTip()`, `return`; else `hover()`.
- `pointerup` (206-214): `if (!wasMove && this.hooks.onPick)` → `pickHit(...)` → `hooks.onPick(hit)`. `moved` is set once `|dx|+|dy| > 2` px (190), so a click is "a press that didn't move" — the existing click-vs-drag discriminator you can reuse.
- `pointercancel`, `pointerleave` (hide tip), `dblclick` → `fit()`, `window.resize` → `apply()`.
- CSS: `.viewport { cursor: grab }`, `.viewport.is-panning { cursor: grabbing }`, `svg { touch-action: none }` (`styles.css:290-293`).

**There is no selection or edit interaction today.** `state.pinned` and `state.highlight` are display-only (`pinned` shows the side card and highlights the matching hit in `site-svg.ts:192-199`; `highlight` draws the dashed rect and drives `centerOn` in `renderPlans`, `main.ts:400-406`). Nothing writes back to the model or spec, and there are no per-element DOM nodes to attach handlers to (everything is batched into shared `<path>` elements).

### 2.5 `svg.ts` builders

```ts
polyPath(pts, close=true)      // 10-15   rectPath(r)            // 17-19   linePath(a,b)      // 21-23
wallQuad(a,b,t): Vec2[]        // 26-34   wallPath(a,b,t)        // 36-38
boxQuad(x,y,w,d,rot=0): Vec2[] // 41-45   (rotation about the MIN CORNER, CCW radians)
circlePath(cx,cy,r)            // 48-50   arcPath(cx,cy,r,a0,a1) // 53-60
crossPath  // 62-64   starPath // 66-73   polylinePath // 75-77
bboxOf(pts): Rect // 79-89   padRect // 91-93   unionRect(a|null,b) // 95-100
text(x,y,s,{size,fill,anchor,weight,opacity}) // 102-110   escSvg // 112-114
pathEl(d, attrs) // 117-122   hatchDefs() // 125-137
```

### 2.6 THE DOOR SWING BUG — exact code and diagnosis

The producing code, `/Users/samarvir/formaIFC/generator/src/app/plan-svg.ts:287-302`:

```ts
for (const d of arch.doors) {
  if (d.storey !== storeyId) continue;
  const w = wallIdx.get(d.wallId);
  if (!w) continue;
  const { a, b, nrm, dir } = along(w, d.along, d.width);
  cut.push(polyPath(wallQuad(a, b, w.thickness * 1.6)));
  const tip: Vec2 = [a[0] + nrm[0] * d.width, a[1] + nrm[1] * d.width];
  leaf.push(linePath(a, tip));
  arcs.push(arcPath(a[0], a[1], d.width, Math.atan2(nrm[1], nrm[0]), Math.atan2(dir[1], dir[0])));
  counts.doors = (counts.doors ?? 0) + 1;
  hits.push(hitFromPoints(d.id, 'Door', `${humanize(d.type)} ${d.width.toFixed(2)}×${d.height.toFixed(2)} m`,
    [a, b, tip], elMeta(model, d.id, [
      ['Type', humanize(d.type)], ['Operation', d.operation], ['Host wall', d.wallId],
      ...(d.fireRated ? [['Fire rated', 'yes'] as [string, string]] : []),
    ])));
}
```

Supporting geometry, `plan-svg.ts:630-641`:
```ts
export function along(w: Pick<WallDef,'start'|'end'>, at: number, width: number): { a: Vec2; b: Vec2; dir: Vec2; nrm: Vec2 } {
  const dx = w.end[0] - w.start[0], dy = w.end[1] - w.start[1];
  const l = Math.hypot(dx, dy) || 1;
  const dir: Vec2 = [dx / l, dy / l];
  const nrm: Vec2 = [-dir[1], dir[0]];                       // LEFT normal of start→end
  const c: Vec2 = [w.start[0] + dir[0] * at, w.start[1] + dir[1] * at];
  return { a: [c[0]-dir[0]*width/2, c[1]-dir[1]*width/2], b: [c[0]+dir[0]*width/2, c[1]+dir[1]*width/2], dir, nrm };
}
```

And the arc itself, `/Users/samarvir/formaIFC/generator/src/app/svg.ts:52-60`:
```ts
/** Arc for a door swing: centre (cx,cy), radius r, from angle a0 to a1 (world radians). */
export function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
  const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
  const large = Math.abs(a1 - a0) > Math.PI ? 1 : 0;
  // Y is negated, so the sweep flag flips relative to world orientation.
  const sweep = a1 > a0 ? 0 : 1;
  return `M${n3(x0)} ${n3(-y0)}A${n3(r)} ${n3(r)} 0 ${large} ${sweep} ${n3(x1)} ${n3(-y1)}`;
}
```

There are **three independent defects**:

**(i) `atan2` wrap → a 270° arc on walls pointing −X.** `a0 = atan2(nrm)`, `a1 = atan2(dir)`; the two are always 90° apart, but `atan2` returns `(−π, π]`, so the *difference* wraps. I ran the exact code:

```
wall dir   nrmAng  dirAng  a1−a0    large  sweepFlag
+X           90°      0°    −90.0°    0        1      ✓ correct quarter arc
+Y          180°     90°    −90.0°    0        1      ✓
-X          −90°    180°   +270.0°    1        0      ✗ draws a 270° arc the wrong way
-Y            0°    −90°    −90.0°    0        1      ✓
diag −X−Y   −45°   −135°    −90.0°    0        1      ✓
```
Any wall whose `start→end` points in −X (`dirAng = 180°`) gets `large=1, sweep=0` and a three-quarter arc sweeping across the room. Fix: normalise the delta into `(−π, π]` before computing `large`/`sweep`, or pass a signed sweep angle instead of two absolute angles.

**(ii) The hinge and swing side are hard-coded, not derived from `DoorDef`.** The hinge is always `a` — the end of the opening nearer `wall.start` — and the leaf always swings toward `+nrm`, the **left** normal of `start→end`. `DoorDef` (`/Users/samarvir/formaIFC/generator/src/core/types.ts:634-648`) carries:
```ts
export interface DoorDef {
  id; storey; wallId; along; width; height;
  type: 'unit-entry'|'interior'|'building-entry'|'balcony'|'garage'|'exit'|'closet'|'service';
  operation: string;            // 'SINGLE_SWING_LEFT' | 'SINGLE_SWING_RIGHT' | 'SLIDING_TO_LEFT'
                                // | 'DOUBLE_DOOR_SLIDING' | 'DOUBLE_DOOR_FOLDING' | 'ROLLINGUP' | 'NOTDEFINED' | …
  fromRoomId?; toRoomId?; fireRated?; unitId?;
}
```
`operation` is read for the hover meta (`plan-svg.ts:299`) and **never used geometrically**. So:
- `SINGLE_SWING_RIGHT` renders identically to `SINGLE_SWING_LEFT`.
- `SLIDING_TO_LEFT` / `DOUBLE_DOOR_SLIDING` / `DOUBLE_DOOR_FOLDING` / `ROLLINGUP` / `NOTDEFINED` (a cased opening) all get a swing leaf + arc, which is simply wrong symbology. `unit-layout.ts:2145` explicitly emits `operation: 'NOTDEFINED'` for cased openings and `unit-layout.ts:3074` counts them as `casedOpenings`.
- For an exterior or corridor wall whose `+nrm` faces outdoors/into the corridor, the leaf and arc are drawn **outside the room** — "into the wall" / into the wrong space.

**(iii) The swing intent exists upstream but is thrown away.** `unit-layout.ts:1735-1740` computes the correct side at layout time and reserves clearance for it:
```ts
if (spec.leaf) {
  // swing into the room being entered
  const dirIn: LDir = adj.axis === 'v' ? (to.local.x > from.local.x ? 'u+' : 'u-')
                                       : (to.local.y > from.local.y ? 'v+' : 'v-');
  addSwing(swings, to, along, width, dirIn, seg, frame);
}
```
`addSwing` (`unit-layout.ts:2150-2165`) pushes a keep-clear `Rect` into a `Map<roomId, Rect[]>` that furniture placement respects (`unit-layout.ts:2213, 2251, 2329`) — and that map is **local to `layoutUnit` and discarded**. Nothing lands on `DoorDef`, so neither the plan nor the IFC can reproduce it.

The data needed for a correct fix is already present without touching `DoorDef`: `WallDef.leftRoomId` / `rightRoomId` (`types.ts:627-629`) are populated exactly against the left normal — `unit-layout.ts:1575-1582`:
```ts
const leftN: Vec2 = [-dir[1]/l, dir[0]/l];
const probe: Vec2 = [mid[0] + leftN[0]*0.05, mid[1] + leftN[1]*0.05];
const leftIsA = pointInRect(ra.world, probe);
w.leftRoomId = leftIsA ? ra.id : rb.id;
w.rightRoomId = leftIsA ? rb.id : ra.id;
```
(also set in `common-rooms.ts:200`, `cores.ts:440,511`; `unit-layout.test.ts:438-439` asserts both are present and distinct for interior walls). So `swingSide = (door.toRoomId === wall.leftRoomId) ? +nrm : −nrm`, and `hingeEnd = operation.endsWith('RIGHT') ? b : a`, with sliding/folding/rolling/NOTDEFINED getting no arc. Adding an explicit optional `DoorDef.swing?: { side: 'left'|'right'; hinge: 'start'|'end' }` written by `layoutUnit` (where `dirIn` is already known) is the cleaner long-term fix and also lets the writer pick the right `IfcDoorTypeOperationEnum` and, later, a mapped door leaf.

The writer has a mirror of the same blind spot: `writer.ts:755` maps `g.operation` through `pick(DOOR_OPERATIONS, g.operation, 'SINGLE_SWING_LEFT')` into the `IFCDOOR` enum, and `addIfcWallDoor` (`ifc-creator.ts:699-735`) draws a plain full-width panel box regardless — no leaf, no swing, no handing.

### 2.7 `site-svg.ts` and `axon-svg.ts`

`buildSite(model, units, highlight): Drawing` (`site-svg.ts:9-202`) — same `Drawing` contract: boundary, buildable envelope, landscape zones + trees, driveway/paths/aisles, parking by type (`ev`/`accessible` get `EV`/`♿` glyphs), stacked storey footprints, podium, footprint, tower footprint, courtyard, cores (`url(#hx)`), corridor spines (dashed `var(--accent)`), entrance arrows (`marker-end:url(#arw)`), frontage/depth dimension lines and a `STREET` caption. Stroke widths here are **world-unit** (0.04-0.14), not `non-scaling-stroke`.

`buildAxon(model, {maxItems=2400})` (`axon-svg.ts:35-121`) — offline isometric fallback for the 3D tab. `project(x,y,z) = [(x−y)·cos30, (x+y)·sin30 − z]` (16-18). Per element: `elementFootprint` → `ccw()` (124-131) → extrude by `heightOf(el)` (153-171) from `zOf(el)` (139-151) + storey elevation; back-face cull `if (ex − ey > 0) continue` (86); painted by `(storeyIndex, depth)`; priority-capped by `prio()` (173-181). `SKIP_TYPES = /^(IfcSpace|IfcAnnotation|IfcOpeningElement|IfcGrid)/` (20). Hits are in `(dx, −dy)` space so the same `Viewport`/`pickHit` works.

### 2.8 `util.ts`

`esc` (5-9), `humanize` (12-15), `clamp` (17-19), `n3` (23-27, ≤3 dp, no `-0`), `compact` (29-35), `fmtBytes` (37-42), `fmtMs` (44-47), `lenUnit`/`areaUnit` (50-51), `lenIn`/`lenOut`/`areaIn`/`areaOut` (54-68), `fmtLenPlain` (71-73), `byId`/`q`/`qa`/`setHtml` (76-89), **`delegate(root, type, sel, fn)`** (92-101, `closest`-based), `debounce` (103-109), `nextFrame(timeoutMs=60)` (116-125), **`slotFor(key, slots=8)`** FNV-1a categorical colour slot (129-133) + `slotVar` (134-136), `DISCIPLINE_VAR` (138-145), `STATUS_CLASS/GLYPH/WORD` (147-149).

---

## 3. `viewer-embed.ts` (172 L) and the embed SDK surface

`/Users/samarvir/formaIFC/generator/src/app/viewer-embed.ts` is a **hand-inlined subset of `@ifc-lite/embed-sdk`** (MPL-2.0), the only network code in the artifact.

```ts
const EMBED_SOURCE = 'ifc-lite-embed';  const PROTOCOL_VERSION = '1.0';
export const DEFAULT_EMBED_ORIGIN = 'https://embed.ifclite.com';        // 10-12
export interface ModelStats { entities: number; triangles: number; vertices: number }   // 14
export interface EmbedInit { container: HTMLElement; theme?: 'light'|'dark'; origin?: string; timeoutMs?: number; hideTypes?: string[] }  // 26-32

export class IfcLiteEmbed {
  readonly ready: Promise<void>;
  constructor(opts: EmbedInit)                                          // 43-67
  loadModelBuffer(buffer: ArrayBuffer): Promise<ModelStats>             // 72-74   (transferable, 180 s timeout)
  fitToView(ids?: number[]): Promise<void>                              // 75
  isolate(ids: number[]): Promise<void>                                 // 76
  hide(ids: number[]): Promise<void>                                    // 77
  showAll(): Promise<void>                                              // 78
  select(ids: number[]): Promise<void>                                  // 79
  selectByGuid(guids: string[]): Promise<{ resolved: number[] }>         // 80-82
  setColors(colorMap: Record<number,[number,number,number,number]>): Promise<void>  // 83-87
  resetColors(): Promise<void>                                          // 88
  setTheme(theme): Promise<void>                                        // 89
  setView(preset: 'top'|'front'|'left'|'right'|'back'|'bottom'): Promise<void>  // 90-92
  on(event: string, cb: (data: unknown) => void): () => void            // 94-99
  destroy(): void                                                       // 101-108
}
export function parseIdGuidMap(step: string): Map<number, string>        // 154-167
export function isFileProtocol(): boolean                               // 170-172
```

Iframe: `${origin}/v1?autoLoad=false&theme=…&hideTypes=…`, `allow="cross-origin-isolated"` (50-56). Handshake `READY → INIT → INIT_ACK` with a 12 s timeout (59-66). `onMessage` (110-126) verifies `ev.origin === expected` **and** `ev.source === iframe.contentWindow`, routes `responseId` to pending requests, and dispatches events by kebab-casing the type (`MODEL_LOADED` → `model-loaded`).

How bytes get in — `main.ts:614-639`:
```ts
const buf = new TextEncoder().encode(ifc.content).buffer;
const stats = await embed.loadModelBuffer(buf as ArrayBuffer);
```
i.e. the STEP **string** is re-encoded to UTF-8 and transferred. Gated by `AUTO_LOAD_LIMIT = 24 * 1024 * 1024` (`main.ts:612`) — above that the load must be user-initiated. `isFileProtocol()` short-circuits auto-connect with an explanatory message (`main.ts:568-575`). Failure always degrades to the axon view (`paintViewerMessage`, 641-675).

**Element selection / isolation available today:** `expressIdsFor(pred)` (681-691) maps `ModelElement.discipline` → `ifc.idMap[el.id]` → express ids; `isolateDiscipline(d)` (693-713) calls `embed.isolate(ids)`, falling back to `guidsFor()` + `selectByGuid` + `isolate` when `idMap` is empty; `colourByDiscipline()` (729-741) builds `Record<expressId, RGBA>` from `DISC_RGBA` and calls `setColors`. `embed.select()` exists but **nothing calls it** — there is no plan→3D selection sync.

**Storey isolation: not implemented, but trivially available.** `ModelElement.storey` is on every element and `ifc.idMap` is keyed by element id, so `embed.isolate(expressIdsFor(el => el.storey === state.storey))` would isolate a storey today with no new API. The protocol has no storey concept of its own.

**Full upstream protocol** (`/Users/samarvir/formaIFC/ifc-lite/packages/embed-protocol/src/index.ts`) — commands the local client does **not** yet expose: `ADD_MODEL`, `REMOVE_MODEL`, `CLEAR_SELECTION`, `SHOW`, `SET_CAMERA` (`{azimuth, elevation}`, `zoom` deliberately ignored — see the doc comment at 132-140), `SET_SECTION` (`{axis:'down'|'front'|'side', position, enabled, flipped}`), `SET_TYPE_VISIBILITY` (flags `spaces | spatialZones | openings | virtualElements | site | ifcAnnotations | ifcGrid`, `TYPE_VISIBILITY_FLAG_KEYS` at 105-113), `GET_PROPERTIES` → `EntityProperties { expressId, ifcType, name, globalId, attributes, propertySets, quantitySets }`, `GET_SCREENSHOT`, `GET_MODEL_INFO`. Events not subscribed: **`ENTITY_SELECTED { id, globalId?, modelId?, ifcType? }`**, `ENTITY_DESELECTED`, **`ENTITY_HOVERED`**, `CAMERA_CHANGED`, `SECTION_CHANGED`, `MODEL_LOADING { progress, phase }`. `ENTITY_SELECTED` is the hook for 3D→plan selection sync in an editor.

---

## 4. `src/ifc/writer.ts` (1123 L)

### 4.1 Entry point and options

```ts
export interface WriteIfcOptions {
  schema?: 'IFC2X3'|'IFC4'|'IFC4X3';    // default model.spec.options.ifcSchema
  author?: string;
  deterministic?: boolean;               // default TRUE: seeded GUIDs + fixed timestamp
  compact?: boolean;                     // default spec.options.detail !== 'high'
}                                                                    // writer.ts:56-88
export const DETERMINISTIC_TIMESTAMP_MS = Date.UTC(2024,0,1,12,0,0); // 91
export function writeIfc(model: DesignModel, opts: WriteIfcOptions = {}): IfcOutput  // 339
```
`IfcCreator` is constructed at 352-370 with `GuidSource: () => generateIfcGuid(guidRng.next)` where `guidRng = createRng(\`${spec.name}:${spec.seed}:ifc-guid\`)` (350) — **the writer has its own RNG stream, seeded from the spec**.

### 4.2 Storeys

`writer.ts:373-400`. One `creator.addIfcBuildingStorey({ Name: storey.name || storey.id, Description: String(storey.use), Elevation })` per `StoreyDef`, in model order, recorded in `storeyIds: Map<string, number>`. Fallback single `L01` storey when the model has none (374-377). `resolveStorey(element)` (392-400) falls back to `index===0` (or `[0]`) and warns once per unknown storey id.

### 4.3 Write order and the geometry dispatch table

Elements are partitioned at 403-419 into `wallElements` / `bodyElements` / `hostedElements` (`door-in-wall`, `window-in-wall`) and written in that order so hosts exist before their openings. `wallGeometryById: Map<string, wall-geometry>` (407) is the host registry. `writeOne` (438-462) guards: missing geometry, `allNumbersFinite()` (312-317), duplicate ids, then `writeGeometry(...)` → `idMap[element.id] = expressId` → `collectDefinitions(...)`. Every element is individually try/caught (459-461) → `writer: <id> (<kind>): <msg>`.

Structure's overrides, computed before the loop: `loadBearingArchWalls` from `model.struct.walls[].archWallId` (422-424) and `shearArchWalls` (role `core`/`shear`, 428-433).

`writeGeometry(creator, element, storeyId, idMap, wallGeometryById, schema, isShearWall, warn): number | null` — `writer.ts:544-882`. Common attrs at 555-560: `{ Name: element.name || element.id, Description, ObjectType, Tag: element.id }`.

| `geometry.kind` | IfcCreator call | writer.ts | Notes |
|---|---|---|---|
`wall` | `addIfcCurtainWall` if `ifcType==='IfcCurtainWall'` (openings dropped + warning), else **`addIfcWall`** | 567-594 | `PredefinedType: isShearWall ? 'SHEAR' : pick(WALL_TYPES, …, 'STANDARD')`; `Openings: mapOpenings(...)` |
`slab` | **`addIfcSlab`** | 596-610 | `profileBounds()` fills Width/Depth; `PredefinedType` from `SLAB_TYPES` default `FLOOR` |
`column` | **`addIfcCircularColumn`** when `shape==='circle'`, else **`addIfcColumn`** | 612-625 | |
`beam` | **`addIfcMember`** when `ifcType==='IfcMember'`, else **`addIfcBeam`** | 627-637 | |
`box` | **`addIfcFurnishingElement`** when `ifcType.toUpperCase()==='IFCFURNISHINGELEMENT'`; otherwise **`addElement`** with `Profile:{ProfileType:'AREA',XDim:width,YDim:depth}`, `Depth: height`, `Placement` from `boxPlacement()` | 639-661 | **the furniture path** |
`prism` | `IfcSpace` → **`addIfcSpace`** (element id goes into `Description`, since IfcSpace has no `Tag`); `IfcBuildingElementProxy`/unset → **`addIfcBuildingElementProxy`**; else **`addElement`** with `Profile:{OuterCurve}` | 663-702 | |
`axis` | **`addAxisElement`** with circle or rect profile | 704-722 | pipes/ducts/trays/conduit |
`stair` | **`addIfcStair`** | 724-736 | |
`door-in-wall` | **`addIfcWallDoor(hostExpressId, { Position:[along,0,0], Width, Height, PredefinedType, OperationType })`**; degrades to **`addIfcDoor`** on the wall line (or storey origin) with a warning when the host was never written or is not a wall | 738-794 | |
`window-in-wall` | **`addIfcWallWindow(..., Position:[along,0,sill], PartitioningType)`**; degrades to **`addIfcWindow`** | 738-794 | |
`footing` | **`addIfcFooting`** (`PredefinedType: g.footingType ?? 'PAD_FOOTING'`) | 796-806 | |
`pile` | **`addIfcPile`** (`PILE_TYPES`, default `BORED`) | 808-817 | |
`roof` | **`addIfcRoof`** (`Slope` via `clampSlope`, `ROOF_TYPES` default `SHED_ROOF`/`FLAT_ROOF`) | 819-831 | |
`gable-roof` | **`addIfcGableRoof`** (`Slope` min 0.01, `Overhang`) | 833-847 | |
`railing` | **`addIfcRailing`** (`Width` default 0.05, `RAILING_TYPES` default `HANDRAIL`) | 849-861 | |
`ramp` | **`addIfcRamp`** | 863-874 | |
default | warn + skip | 876-880 | |

Helpers: `boxPlacement(position, width, depth, rotation)` (266-279, pushes the location to the box centre because `addRectangleProfile` centres its profile; `refDirection = [cos, sin, 0]`), `boxFootprint` (285-293), `profileBounds` (296-305), `dist3` (307), `allNumbersFinite` (312-317), `positive` (319-321), `enumToken` (324-328), `pick(set, value, fallback)` (330-333), `clampSlope` (885-894), `mapOpenings` (896-914), `ifcTypeToken(ifcType, fallback, schema)` (917-924). Enum whitelists at 229-255 (`WALL_TYPES`, `SLAB_TYPES`, `RAILING_TYPES`, `ROOF_TYPES`, `SPACE_TYPES`, `PILE_TYPES`, `DOOR_TYPES`, `DOOR_OPERATIONS`, `WINDOW_PARTITIONS`). IFC2X3 down-mapping table `IFC2X3_TYPE_FALLBACKS` at 190-227 (36 entries).

### 4.4 How furniture is written **today**

Two paths, chosen by the `ifcType` that `arch-elements.ts` assigned:

`/Users/samarvir/formaIFC/generator/src/disciplines/architecture/arch-elements.ts:610-635` (phase 5) emits, for each `FurnitureDef`:
```ts
const ifc = FURNITURE_IFC[f.type] ?? { ifcType: 'IfcFurnishingElement' };
geometry: { kind: 'box', position: [f.position[0], f.position[1], 0], width: f.width, depth: f.depth, height: f.height, rotation: f.rotation },
psets: [{ name: 'Forma_Architecture', properties: [FurnitureType, NeedsWater, NeedsPower] }],
color: FURNITURE_COLOR[f.type] ?? [0.7,0.7,0.7], unitId, roomId,
objectType: f.type,
```
with `FURNITURE_IFC` (163-176) overriding 12 of the ~45 types:
```
fridge/range/dishwasher/washer/dryer → IfcElectricAppliance (FRIDGE_FREEZER/ELECTRICCOOKER/DISHWASHER/WASHINGMACHINE/TUMBLEDRYER)
wc/lavatory/vanity/shower/bathtub/kitchen-sink → IfcSanitaryTerminal (TOILETPAN/WASHHANDBASIN/…/BATH/SINK)
car → IfcBuildingElementProxy
```
So:
- `IfcFurnishingElement` → `writer.ts:642-650` → `creator.addIfcFurnishingElement(storeyId, { Position, Width, Depth, Height, Direction: rotation })` → a **single extruded rectangle = one bounding box**.
- everything else → `writer.ts:652-660` → `creator.addElement(storeyId, { IfcType, Placement: boxPlacement(...), Profile: rectangle, Depth: height, PredefinedType })` → also **one extruded box**.

There is **no `IfcFurniture`**, no `IfcFurnitureType`, no `IfcSystemFurnitureElement`, no multi-solid furniture, no mapped items. Real counts on the `us-5-over-1` preset (measured, see §9.2): 1197 `IFCFURNISHINGELEMENT` + 775 `IFCSANITARYTERMINAL` + 358 `IFCELECTRICAPPLIANCE`. `README.md:122-123` states the limitation outright: *"IFC is IFC4 STEP with extruded solids (no mapped items), so large presets are tens of megabytes."*

The furniture catalogue that a mapped-item library would key off is `/Users/samarvir/formaIFC/generator/src/disciplines/architecture/furniture.ts` (139 L): `FURNITURE_CATALOG: Record<FurnitureType, { w; d; h; needsWater?; needsPower? }>` (33-88, ~45 real nominal sizes with sources), `CLEARANCE` (91-114), `furnitureSpec()` (116), `storageVolume()` (121-131), `WATER_ITEMS` / `POWER_ITEMS` (134-139). `FurnitureDef` (`types.ts:671-686`) places the footprint **min corner** at `position` and rotates about that corner; the back of an unrotated item is the `y = 0` edge (`furniture.ts:5-7`).

### 4.5 Styles, materials, psets, systems, zones

`collectDefinitions(creator, element, expressId, forceLoadBearing, compact, shared, warn)` — `writer.ts:960-1010`:
- **Colour** (969-972): clamps `element.color` to `[0,1]` and calls `creator.setColor(expressId, styleName(element), rgb)`. `styleName()` (1063-1065) deliberately returns a **class-level** label — `element.material?.name ?? objectType ?? ifcType ?? 'Forma'` — never the element name (the comment at 1053-1062 records that using `element.name` produced 1135 styles for 64 distinct colours).
- **Material** (974-981): `creator.addIfcMaterial(expressId, { Name, Category, Layers? })`, layers filtered to positive thickness.
- **Property sets** (983-992): each `PropertySetDef` → `toCreatorPropertySet` (1087-1097, non-finite numbers dropped with a warning, `propertyType()` at 1081-1085 maps boolean/number/string → `IfcBoolean`/`IfcReal`/`IfcLabel`) → `canonicalPropertySet` → `queue(shared.psets, …, expressId)`. Plus a `Forma_Common` set for **every** product (992, built by `formaCommon(element, compact)` at 1110-1123: `Discipline`, `Storey`, optionally `ElementId`/`UnitId`/`RoomId` in full mode, `System`, `Patterns`).
- **Quantities** (994-1009): in compact mode only for `COMPACT_QUANTITY_TYPES = new Set(['IFCSPACE','IFCSLAB'])` (954).
- `withLoadBearing()` (1068-1079) merges `Pset_WallCommon.LoadBearing = TRUE` without mutating the model.

**Grouping** (`writer.ts:468-506`): a single pass collects `systemGroups: Map<systemId, expressId[]>` from `element.system` and `zoneGroups: Map<unitId, expressId[]>` from `element.unitId` where `ifcType === 'IfcSpace'`. Then `creator.addIfcSystem(systemId, memberIds, { PredefinedType, ObjectType, LongName, Description })` per system, and `creator.addIfcZone(unitId, spaceIds, { ObjectType: 'Dwelling', LongName: \`Dwelling ${unitId}\` })` per dwelling. `SYSTEM_TYPES` (110-173, ~70 entries) + `systemClassification(systemId)` (176-184) map `SYS-<DISC>-<NAME>` → `IfcDistributionSystemEnum` token + label, by exact key, then last segment, then `USERDEFINED`.

### 4.6 Entity-count budget mechanisms

Four, documented in the file header (`writer.ts:28-41`):

1. **Shared property/quantity sets.** `interface SharedSets { psets: Map<string,{set,members:number[]}>; qsets: Map<string,{set,members:number[]}> }` (944-951). `canonicalPropertySet(pset)` (1028-1037) sorts properties by name and builds the identity key as `JSON.stringify([Name, props.map(p => [p.Name, p.Type ?? null, typeof p.NominalValue, p.NominalValue])])` — JSON rather than concatenation so no two distinct lists collide, and `typeof` so `'1'` never merges with `1`. `canonicalQuantitySet` is the analogue (1040-1047). Emission is deferred to **after** every product id is known (508-524) → `creator.addSharedIfcPropertySet(members, set)` / `addSharedIfcElementQuantity`, which emit one set + **one `IfcRelDefinesByProperties` per `PROPERTY_REL_CHUNK = 250`** related objects. Map insertion order = first-use order → deterministic.
2. **Compact mode** (`opts.compact`, default on): drops `ElementId`/`UnitId`/`RoomId` from `Forma_Common` (they'd make the pset unique per element) and skips quantities except for spaces and slabs.
3. **Resource caching in the creator** (see §5.4).
4. **Chunked group membership**: `GROUP_CHUNK = 500` per `IfcRelAssignsToGroup`.

### 4.7 `IfcOutput`

`/Users/samarvir/formaIFC/generator/src/core/types.ts:1203-1215`:
```ts
export interface IfcOutput {
  content: string;                       // the whole STEP file
  entityCount: number;                   // = creator.lines.length
  fileSize: number;                      // UTF-8 byte length
  idMap: Record<string, number>;         // ModelElement.id → IFC expressId
  warnings?: string[];                   // `writer: <id> (<kind>): <msg>`, capped at 500 + a "N further suppressed" line
}
```
Returned at `writer.ts:528-535` from `creator.toIfc()`.

---

## 5. Vendored `IfcCreator` (`src/ifc/vendor/ifc-lite-create/`)

Files: `ifc-creator.ts` (3103 L), `types.ts` (909 L), `ifc-creator-math.ts` (97 L), `guid.ts` (162 L), `index.ts` (6 L), `NOTICE.md`.

### 5.1 Complete public API

```ts
class IfcCreator {
  constructor(params: ProjectParams = {})                                              // 188

  // --- spatial ---
  addIfcBuildingStorey(params: StoreyParams): number                                    // 235

  // --- building elements ---
  addIfcWall(storeyId, params: WallParams): number                                      // 286
  addIfcSlab(storeyId, params: SlabParams): number                                      // 346
  addIfcColumn(storeyId, params: ColumnParams): number                                  // 397
  addIfcColumnUnvalidated(storeyId, params: ColumnParams): number                       // 418
  addIfcBeam(storeyId, params: BeamParams): number                                      // 453
  addIfcStair(storeyId, params: StairParams): number                                    // 497
  addIfcRoof(storeyId, params: RoofParams): number                                      // 559
  addIfcGableRoof(storeyId, params: GableRoofParams): number                            // 610
  addIfcWallDoor(wallId, params: WallDoorParams): number                                // 699
  addIfcWallWindow(wallId, params: WallWindowParams): number                            // 741
  addIfcDoor(storeyId, params: DoorParams): number                                      // 781
  addIfcWindow(storeyId, params: WindowParams): number                                  // 815
  addIfcRamp(storeyId, params: RampParams): number                                      // 849
  addIfcRailing(storeyId, params: RailingParams): number                                // 894
  addIfcPlate(storeyId, params: PlateParams): number                                    // 969
  addIfcMember(storeyId, params: MemberParams): number                                  // 1006
  addIfcFooting(storeyId, params: FootingParams): number                                // 1045
  addIfcPile(storeyId, params: PileParams): number                                      // 1078
  addIfcSpace(storeyId, params: SpaceParams): number                                    // 1120
  addIfcCurtainWall(storeyId, params: CurtainWallParams): number                        // 1164
  addIfcFurnishingElement(storeyId, params: FurnishingParams): number                   // 1204
  addIfcBuildingElementProxy(storeyId, params: ProxyParams): number                     // 1237

  // --- parametric-profile convenience ---
  addIfcCircularColumn(storeyId, { Position, Radius, Height } & ElementAttributes)      // 1279
  addIfcIShapeBeam(storeyId, {...})                                                     // 1313
  addIfcLShapeMember(storeyId, {...})                                                   // 1370
  addIfcTShapeMember(storeyId, {...})                                                   // 1419
  addIfcUShapeMember(storeyId, {...})                                                   // 1476
  addIfcHollowCircularColumn(storeyId, {...})                                           // 1533
  addIfcRectangleHollowBeam(storeyId, {...})                                            // 1568

  // --- properties / quantities ---
  addIfcPropertySet(elementId: number, pset: PropertySetDef): number                    // 1626
  addSharedIfcPropertySet(elementIds: number[], pset: PropertySetDef): number           // 1651  ← local addition
  addIfcElementQuantity(elementId: number, qset: QuantitySetDef): number                // 1695
  addSharedIfcElementQuantity(elementIds: number[], qset: QuantitySetDef): number       // 1707  ← local addition

  // --- styling / materials ---
  setColor(elementId: number, name: string, rgb: [number,number,number]): void          // 1745
  addIfcMaterial(elementId: number, def: MaterialDef): void                             // 1760

  // --- 4D scheduling ---
  addIfcWorkSchedule(params: WorkScheduleParams): number                                // 1798
  addIfcWorkPlan(params: WorkPlanParams): number                                        // 1806
  addIfcTask(params: TaskParams): number                                                // 1815
  addIfcRelSequence(...)                                                                // 1899
  addIfcRelAssignsToControl(relatingControlId, relatedObjectIds): number                // 1930
  assignTasksToWorkSchedule(scheduleId, taskIds): number                                // 1944
  assignSchedulesToWorkPlan(planId, scheduleIds): number                                // 1952
  addIfcRelAssignsToProcess(relatingProcessId, relatedObjectIds): number                // 1961
  assignProductsToTask(taskId, productIds): number                                      // 1972
  addIfcRelNests(relatingObjectId, relatedObjectIds): number                            // 1980
  nestTasks(parentTaskId, childTaskIds): number                                         // 1991

  // --- export ---
  toIfc(): CreateResult                                                                 // 2034  (single-shot; throws on reuse)

  // --- low-level geometry ---
  addLocalPlacement(relativeTo: number, placement: Placement3D): number                 // 2366
  addRectangleProfile(xDim, yDim, center?: Point2D): number                             // 2391
  addCircleProfile(radius): number                                                      // 2404
  addCircleHollowProfile(radius, wallThickness): number                                 // 2412
  addIShapeProfile(...)      // 2421      addLShapeProfile(...)     // 2436
  addTShapeProfile(...)      // 2450      addUShapeProfile(...)     // 2465
  addCShapeProfile(...)      // 2480      addRectangleHollowProfile(...) // 2493
  addArbitraryProfile(points: Point2D[]): number                                        // 2508
  addExtrudedAreaSolid(profileId, depth, extrusionDir?, positionId?): number            // 2529
  addShapeRepresentation(repType: string, itemIds: number[]): number                    // 2547
  addProductDefinitionShape(repIds: number[]): number                                   // 2559
  getWorldPlacementId(): number                                                         // 2571
  addDirection3D(d: Point3D): number                                                    // 2576
  createProfile(profile: ProfileDef): number                                            // 2592

  // --- generic element creation ---
  addElement(storeyId: number, params: GenericElementParams): number                    // 2672
  addAxisElement(storeyId: number, params: AxisElementParams): number                    // 2741

  // --- grouping (local addition) ---
  addIfcSystem(name: string, elementIds: number[], opts: SystemParams = {}): number     // 3032
  addIfcZone(name: string, spaceIds: number[], opts: ZoneParams = {}): number           // 3069
}
```

Private internals worth knowing: `newGlobalId()` (212-228, 100-attempt collision retry, validates a user `GuidSource`), `getStoreyPlacement` (267-273, throws on unknown storey), `addWallOpening` (private, ~2800-2860), `addHostedWallFillPlacement` (2980-2993), `addIfcRelFillsElement` (2951), `finalizeStyles` (2210-2235), `styleReference` (2246-2255), `buildColorStyle` (2258-2269), `getOrCreateMaterial` (2271-2281), `finalizeMaterials` (2284-2299), `finalizeRelationships` (2920-…), `assignToGroup` (3090-3101), `id()` (2962-2964), `line()` (2966-2968), `trackElement` (2995-3002), `computeRefDirection` (3005-3009), `ifc4Only(v)` (2901).

### 5.2 Answers to the specific capability questions — **all NO**

I enumerated every entity name the creator can emit: `grep -oE "'IFC[A-Z0-9]+'" ifc-creator.ts | sort -u` → **92 tokens** (3 are schema names). The complete set is:

```
IFCAPPLICATION IFCARBITRARYCLOSEDPROFILEDEF IFCAXIS2PLACEMENT2D IFCAXIS2PLACEMENT3D IFCBEAM
IFCBOOLEAN IFCBUILDING IFCBUILDINGELEMENTPROXY IFCBUILDINGSTOREY IFCCABLETRAYSEGMENT
IFCCARTESIANPOINT IFCCIRCLEHOLLOWPROFILEDEF IFCCIRCLEPROFILEDEF IFCCOLOURRGB IFCCOLUMN
IFCCSHAPEPROFILEDEF IFCCURTAINWALL IFCDIMENSIONALEXPONENTS IFCDIRECTION IFCDISTRIBUTIONELEMENT
IFCDISTRIBUTIONSYSTEM IFCDOOR IFCELEMENTQUANTITY IFCEXTRUDEDAREASOLID IFCFLOWSEGMENT IFCFOOTING
IFCFURNISHINGELEMENT IFCGEOMETRICREPRESENTATIONCONTEXT IFCGEOMETRICREPRESENTATIONSUBCONTEXT
IFCISHAPEPROFILEDEF IFCLAGTIME IFCLOCALPLACEMENT IFCLOGICAL IFCLSHAPEPROFILEDEF IFCMATERIAL
IFCMATERIALLAYER IFCMATERIALLAYERSET IFCMEMBER IFCOPENINGELEMENT IFCORGANIZATION IFCOWNERHISTORY
IFCPERSON IFCPERSONANDORGANIZATION IFCPILE IFCPIPESEGMENT IFCPLATE IFCPOLYLINE
IFCPRESENTATIONSTYLEASSIGNMENT IFCPRODUCTDEFINITIONSHAPE IFCPROJECT IFCPROPERTYSET
IFCPROPERTYSINGLEVALUE IFCRAILING IFCRAMP IFCRECTANGLEHOLLOWPROFILEDEF IFCRECTANGLEPROFILEDEF
IFCRELAGGREGATES IFCRELASSIGNSTOCONTROL IFCRELASSIGNSTOGROUP IFCRELASSIGNSTOPROCESS
IFCRELASSOCIATESMATERIAL IFCRELCONTAINEDINSPATIALSTRUCTURE IFCRELDEFINESBYPROPERTIES
IFCRELFILLSELEMENT IFCRELNESTS IFCRELSEQUENCE IFCRELSERVICESBUILDINGS IFCRELVOIDSELEMENT IFCROOF
IFCSHAPEREPRESENTATION IFCSITE IFCSIUNIT IFCSLAB IFCSPACE IFCSTAIR IFCSTYLEDITEM IFCSURFACESTYLE
IFCSURFACESTYLERENDERING IFCSYSTEM IFCTASK IFCTASKTIME IFCTSHAPEPROFILEDEF IFCUNITASSIGNMENT
IFCUSHAPEPROFILEDEF IFCWALL IFCWINDOW IFCWORKPLAN IFCWORKSCHEDULE IFCZONE
```

Therefore, **absent entirely** (no method, no type, no emitted token — confirmed by case-insensitive grep over both `ifc-creator.ts` and `types.ts`):

| Capability | Status |
|---|---|
`IfcRepresentationMap` | ✗ absent |
`IfcMappedItem` | ✗ absent |
`IfcTypeObject` / `IfcTypeProduct` / `IfcWallType` / `IfcFurnitureType` / `IfcDoorType` / any `Ifc*Type` | ✗ absent |
`IfcRelDefinesByType` | ✗ absent |
`IfcCartesianTransformationOperator3D` (+ `Uniform`/`NonUniform`, 2D) | ✗ absent |
`IfcFurniture` (the IFC4 entity) / `IfcSystemFurnitureElement` | ✗ absent — only `IfcFurnishingElement` (the IFC2X3-era supertype) |
`IfcBooleanResult` / `IfcBooleanClippingResult` / `IfcHalfSpaceSolid` | ✗ absent |
`IfcCsgSolid` / `IfcBlock` / `IfcSphere` | ✗ absent |
`IfcRevolvedAreaSolid` | ✗ absent |
`IfcSweptDiskSolid` (the natural choice for pipes) | ✗ absent — pipes are `IfcExtrudedAreaSolid` with a circle profile via `addAxisElement` |
`IfcFacetedBrep` / `IfcTriangulatedFaceSet` / `IfcPolygonalFaceSet` / `IfcShellBasedSurfaceModel` | ✗ absent |
Composite geometry (multiple solids in one `IfcShapeRepresentation`) | **⚠ partially present**: `addShapeRepresentation(repType, itemIds: number[])` accepts an array and switches `RepresentationType` to `'SolidModel'` when `itemIds.length > 1` (`ifc-creator.ts:2547-2557`) — but **no public method routes more than one solid into it**. Every `addIfc*` builds exactly one `addExtrudedAreaSolid` and passes `[solidId]`. `addIfcGableRoof` (610) and `addIfcStair` (497) are the closest to multi-solid; worth reading before extending. |

`addShapeRepresentation` also hardcodes `RepresentationIdentifier` to `'Axis'` or `'Body'` and `RepresentationType` to `'SweptSolid'`/`'SolidModel'` — a mapped-item representation needs `RepresentationType = 'MappedRepresentation'`, so this method must be extended or joined by a sibling.

### 5.3 How a generic extruded element is written

`addElement(storeyId, params: GenericElementParams)` — `ifc-creator.ts:2672-2739`:
```ts
const placementId = this.addLocalPlacement(this.getStoreyPlacement(storeyId), params.Placement);
const profileId   = this.createProfile(params.Profile);
let extrusionDirId; if (params.ExtrusionDirection) extrusionDirId = this.addDirection(params.ExtrusionDirection);
const solidId     = this.addExtrudedAreaSolid(profileId, params.Depth, extrusionDirId);
const shapeId     = this.addShapeRepresentation('Body', [solidId]);
const prodShapeId = this.addProductDefinitionShape([shapeId]);
const elementId   = this.id();
// NON_ELEMENT_TYPES (ifc-creator-math.ts) end at Representation; IfcElement subtypes add Tag + (IFC4-only) PredefinedType
this.line(elementId, params.IfcType,
  `'${globalId}',#${this.ownerHistoryId},'${esc(name)}',${desc},${objType},#${placementId},#${prodShapeId},${tag}${this.ifc4Only(predefinedType)}`);
this.elementSolids.set(elementId, [solidId]);
this.trackElement(storeyId, elementId);
this.entities.push({ expressId: elementId, type: params.IfcType, Name: name });
```
`addAxisElement` (2741-2800) is the same shape but computes `Axis = normalize(End − Start)` and `RefDirection = normalize(cross(dir, [0,0,1]))` (falling back to `cross(dir,[1,0,0])` when parallel to Z), and extrudes by `|End − Start|`.

`addIfcFurnishingElement` (1204-1231) is identical except the profile is `addRectangleProfile(W, D, [W/2, D/2])` (so `Position` is the min corner), the placement `RefDirection = [cos θ, sin θ, 0]` when `Direction ≠ 0`, and the entity has **no** `PredefinedType` attribute.

`addIfcColumn` (397-417) → `addRectangleProfile(Width, Depth)` centred + `addExtrudedAreaSolid(profile, Height)`, placement at `Position` (base centre).

### 5.4 Numbering, serialisation, and the resource cache — quoted

Numbering and output are a **plain array of strings** joined once:
```ts
private nextId = 1;
private lines: string[] = [];
private entities: CreatedEntity[] = [];                                    // 108-110

private id(): number { return this.nextId++; }                             // 2962-2964
private line(id: number, type: string, args: string): void {
  this.lines.push(stepLine(id, type, args));
}                                                                          // 2966-2968
```
`toIfc()` (2034-2054):
```ts
if (this.finalized) throw new Error('toIfc() has already been called — creator is not reusable');
this.finalized = true;
this.finalizeStyles(); this.finalizeMaterials(); this.finalizeRelationships();
const content = `${this.buildHeader()}DATA;\n${this.lines.join('\n')}\nENDSEC;\nEND-ISO-10303-21;\n`;
return { content, entities: [...this.entities], stats: { entityCount: this.lines.length, fileSize: new TextEncoder().encode(content).length } };
```
Note `entityCount === lines.length` — ids are handed out in strict first-use order, which is what makes deterministic mode byte-reproducible.

**The cache mechanism** — declarations at `ifc-creator.ts:144-167`:
```ts
  // ---- Shared geometry-resource caches (forma-resi-ifc addition, NOTICE.md) --
  //
  // IfcCartesianPoint, IfcDirection, IfcAxis2Placement2D/3D and the parametric
  // profile definitions are immutable, value-typed geometry RESOURCES: the
  // schema lets any number of entities reference the same instance, and every
  // real-world IFC file does. Emitting one per use is what made a 28 000-element
  // model cost ~36 STEP entities per element.
  //
  // Every cache key is the exact serialized STEP argument text, so two calls
  // share an entity precisely when they would otherwise have emitted a
  // byte-identical line — the file loses duplicates and nothing else. Ids are
  // still handed out in first-use order, so output stays deterministic.
  /** `(x,y[,z])` argument text → IfcCartesianPoint id (2D and 3D share the map) */
  private pointCache: Map<string, number> = new Map();
  /** `(x,y,z)` argument text → IfcDirection id */
  private directionCache: Map<string, number> = new Map();
  /** `originId|axisId|refDirId` → IfcAxis2Placement3D id */
  private axis2Placement3DCache: Map<string, number> = new Map();
  /** `originId` → IfcAxis2Placement2D id */
  private axis2Placement2DCache: Map<number, number> = new Map();
  /** `kind|dims|positionId` → parametric profile id (rectangle / circle) */
  private profileCache: Map<string, number> = new Map();
  /** IFC2X3 only: IfcSurfaceStyle id → its IfcPresentationStyleAssignment id */
  private styleAssignments: Map<number, number> = new Map();
```
and the single get-or-emit primitive, `ifc-creator.ts:2305-2356`:
```ts
  /**
   * Get or emit the shared IfcCartesianPoint / IfcDirection / profile entity
   * whose STEP line would be `#n=<type>(<args>);`. The cache key includes the
   * type so one map can hold several entity types without colliding.
   */
  private sharedResource(cache: Map<string, number>, type: string, args: string): number {
    const key = `${type}(${args})`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const id = this.id();
    this.line(id, type, args);
    cache.set(key, id);
    return id;
  }

  private addCartesianPoint(p: Point3D): number {
    return this.sharedResource(this.pointCache, 'IFCCARTESIANPOINT',
      `(${num(p[0])},${num(p[1])},${num(p[2])})`);
  }
  private addCartesianPoint2D(p: Point2D): number { /* same map, 2-tuple args */ }
  private addDirection(d: Point3D): number { /* directionCache */ }

  private addAxis2Placement3D(originId: number, axisId?: number, refDirId?: number): number {
    const axis = axisId ? `#${axisId}` : '$';
    const refDir = refDirId ? `#${refDirId}` : '$';
    const key = `${originId}|${axisId ?? 0}|${refDirId ?? 0}`;
    const cached = this.axis2Placement3DCache.get(key);
    if (cached !== undefined) return cached;
    const id = this.id();
    this.line(id, 'IFCAXIS2PLACEMENT3D', `#${originId},${axis},${refDir}`);
    this.axis2Placement3DCache.set(key, id);
    return id;
  }
  private addAxis2Placement2D(originId: number): number { /* axis2Placement2DCache */ }
```
`addRectangleProfile` / `addCircleProfile` (2391-2410) go through `sharedResource(this.profileCache, …)`. **Not cached:** `IFCLOCALPLACEMENT` (2366-2389 always emits a fresh line), `IFCEXTRUDEDAREASOLID`, `IFCSHAPEREPRESENTATION`, `IFCPRODUCTDEFINITIONSHAPE`, `IFCARBITRARYCLOSEDPROFILEDEF`/`IFCPOLYLINE`, `IFCCIRCLEHOLLOWPROFILEDEF` and the other non-parametric profiles. On the measured preset there are 29,057 `IFCLOCALPLACEMENT` lines against only 6,271 `IFCAXIS2PLACEMENT3D` — caching `IfcLocalPlacement` on `relativeTo|axis2Id` is an easy, independent win.

Styles: `finalizeStyles()` (2210-2235) walks `elementSolids: Map<number, number[]>`, caches one `IfcSurfaceStyle` per `${name}|${rgb}` and emits **one `IFCSTYLEDITEM` per solid**. `styleReference()` (2246-2255) inserts an `IFCPRESENTATIONSTYLEASSIGNMENT` indirection for IFC2X3 only. Materials are batched in `finalizeMaterials()` (2284-2299): one `IfcRelAssociatesMaterial` per distinct material ref, listing every element.

### 5.5 Local modifications vs upstream (`NOTICE.md`)

Vendored from `LTplus-AG/ifc-lite` monorepo 9.0.1, `@ifc-lite/create` **2.4.0**, MPL-2.0. Every change is marked `forma-resi-ifc addition` in source. Summary:

*`types.ts`*: `ProjectParams.Site` / `.Building` / `.FileName` / `.FileDescription`; `PredefinedType` added to `SlabParams`, `RoofParams`, `GableRoofParams`, `RailingParams`, `PileParams`, `SpaceParams`, `WallParams`; new `SystemParams`, `ZoneParams`.

*`ifc-creator.ts`*:
- `buildPreamble` uses real Site/Building names; context precision written `0.00001` not `1.0E-5` (because `src/ifc/validate.ts` rejects exponent literals).
- `addElement`/`addAxisElement` route the trailing `PredefinedType` through `ifc4Only()` (IFC2X3 `IfcElement` ends at `Tag`).
- The seven `PredefinedType` honourings; IFC2X3 `IfcSpaceTypeEnum` down-mapping (`SPACE`/`PARKING`/`GFA` → `INTERNAL`).
- New grouping API `addIfcSystem` / `addIfcZone` (+ `IFCRELSERVICESBUILDINGS`, `GROUP_CHUNK = 500`).
- **The file-size work**: `addSharedIfcPropertySet` / `addSharedIfcElementQuantity` (+ `PROPERTY_REL_CHUNK = 250`); the geometry-resource caches; IFC2X3 `IfcPresentationStyleAssignment` correctness.

Quantified in `NOTICE.md` for `us-5-over-1` (~28 500 products): `IFCCARTESIANPOINT` 92 746 → 6 710, `IFCDIRECTION` 40 691 → 51, `IFCAXIS2PLACEMENT3D` 59 386 → 6 448, `IFCAXIS2PLACEMENT2D` 28 952 → 177, `IFCRECTANGLEPROFILEDEF` 18 837 → 329, `IFCCIRCLEPROFILEDEF` 10 115 → 12.

> **Upstream has nothing newer to vendor.** `/Users/samarvir/formaIFC/ifc-lite/packages/create/src/ifc-creator.ts` is 2843 L with the **identical** method list minus the four local additions (compare the two `grep -nE "^  [a-zA-Z_#]…\("` dumps: upstream stops at `addAxisElement` at line 2575, no `addIfcSystem`/`addIfcZone`/`addShared*`). `packages/create/package.json` says `2.4.0`, matching `NOTICE.md`. The adjacent `packages/create/src/in-store/` (57 files: `wall.ts`, `door.ts`, `window.ts`, `slab.ts`, `beam.ts`, `column.ts`, `space.ts`, `roof.ts`, `plate.ts`, `member.ts`, `spatial-zone.ts`, `duplicate.ts`, `apply-style.ts`, `drawing-markup*.ts`, `extract-walls*.ts`, `anchor.ts`, `placement-frame.ts`, `generate-spaces.ts`, `auto-space-detect.ts`, …) is a **different** API — mutation-based editing of an already-parsed model via `@ifc-lite/mutations`, not a from-scratch writer. Notably `in-store/apply-style.test.ts` references `IfcCartesianTransformationOperator`, so that editing path is mapped-item aware; it is not a drop-in replacement for `IfcCreator` but is the place to look for reference encodings.

---

## 6. Upstream `ifc-lite` geometry/parser support

### 6.1 The authoritative "what can the engine mesh" table

`/Users/samarvir/formaIFC/ifc-lite/rust/geometry/src/router/processor_registry.rs:22-95` — 19 processor slots:

```rust
pub(super) const TYPES: [&[IfcType]; 19] = [
    &[IfcType::IfcExtrudedAreaSolid],
    &[IfcType::IfcExtrudedAreaSolidTapered],
    &[IfcType::IfcTriangulatedFaceSet, IfcType::IfcTriangulatedIrregularNetwork],
    &[IfcType::IfcPolygonalFaceSet],
    &[IfcType::IfcFacetedBrep],
    &[IfcType::IfcBooleanResult, IfcType::IfcBooleanClippingResult],
    &[IfcType::IfcSweptDiskSolid],
    &[IfcType::IfcRevolvedAreaSolid],
    &[IfcType::IfcSurfaceCurveSweptAreaSolid, IfcType::IfcFixedReferenceSweptAreaSolid],
    &[IfcType::IfcSectionedSolidHorizontal],
    &[IfcType::IfcAdvancedBrep, IfcType::IfcAdvancedBrepWithVoids],
    &[IfcType::IfcBSplineSurfaceWithKnots, IfcType::IfcRationalBSplineSurfaceWithKnots],
    &[IfcType::IfcShellBasedSurfaceModel],
    &[IfcType::IfcFaceBasedSurfaceModel],
    &[IfcType::IfcBlock],
    &[IfcType::IfcSphere],
    &[IfcType::IfcCsgSolid],
    &[IfcType::IfcAlignment],
    &[IfcType::IfcEdge],
];
```
The doc comment at 96-110 calls `builtin_processor` *"the single 'what can the engine mesh' table"*. Implementations live in `/Users/samarvir/formaIFC/ifc-lite/rust/geometry/src/processors/` (`extrusion.rs`, `extrusion_tapered.rs`, `tessellated/`, `brep/`, `boolean/`, `swept/`, `sectioned.rs`, `advanced_face/`, `surface.rs`, `csg_primitive.rs`, `sphere.rs`, `alignment.rs`, `structural_edge.rs`).

So every one of your questions answers **yes**: `IfcSweptDiskSolid` ✓ (slot 6), `IfcRevolvedAreaSolid` ✓ (slot 7), `IfcBooleanClippingResult` ✓ (slot 5), `IfcCsgSolid` ✓ (slot 16), `IfcFacetedBrep` ✓ (slot 4), `IfcTriangulatedFaceSet` ✓ (slot 2), `IfcPolygonalFaceSet` ✓ (slot 3).

### 6.2 `IfcMappedItem` / `IfcRepresentationMap` / `IfcCartesianTransformationOperator3D`

Fully supported, with a dedicated module:

- `/Users/samarvir/formaIFC/ifc-lite/rust/geometry/src/router/mapped_item.rs` — header: *"`IfcMappedItem` source resolution: caching, cyclic/depth-bounded recursion, and merging an `IfcRepresentationMap`'s items into one source-coords mesh."* `process_mapped_item_cached` (25-32) → `..._inner` (43-66, depth bound `MAX_MAPPED_ITEM_DEPTH`, cycle detection via `visited: FxHashSet<u32>`) → `..._body` (69-90), which documents the attribute layout: *"0: MappingSource (IfcRepresentationMap), 1: MappingTarget (IfcCartesianTransformationOperator)"*.
- `/Users/samarvir/formaIFC/ifc-lite/rust/geometry/src/router/transforms/operator.rs` — *"`IfcCartesianTransformationOperator` (2D / 3D, uniform + non-uniform)"*. All four subtypes matched by name: `IfcCartesianTransformationOperator2D` | `2DnonUniform` (58-59) and `3D` | `3DnonUniform` (104-105); `Scale` at attribute 3, `Scale2`/`Scale3` for the non-uniform variants (90-105); `#1985` fix at 274 for `2DnonUniform` `Scale2`. Non-uniform handling also threads through `transforms/mesh_world.rs:179`.
- Regression tests: `/Users/samarvir/formaIFC/ifc-lite/rust/processing/tests/issue_1985_mapped_item_transform.rs`, `issue_2256_mapped_item_unresolved.rs`, `issue_4103_shared_map_buffer_identity.rs`, `issue_1994_transform2d_mirror.rs`, `site_local_instancing.rs`, `issue_957_type_only_geometry.rs`.

### 6.3 Type objects and `IfcRelDefinesByType`

- `/Users/samarvir/formaIFC/ifc-lite/rust/processing/src/prepass_type_material.rs:20-80` — *"Walk `defines_by_type` spans (`IFCRELDEFINESBYTYPE`)"*, with the attribute indices (`RelatedObjects` = 4, `RelatingType` = 5) and a worked STEP fixture in the doc comment. Type-level material/style is inherited by occurrences *"UNLESS the occurrence carries its own"*.
- `/Users/samarvir/formaIFC/ifc-lite/rust/processing/src/element.rs:75-79` — `ElementJobKind::TypeProduct { rep_maps: Vec<(u32, u8)> }`, *"#957 type geometry: render these RepresentationMaps directly"*; the orphan/instanced decision is documented at 148-186.
- `/Users/samarvir/formaIFC/ifc-lite/rust/processing/src/processor/mod.rs:540-560` explains the classification and the exact hazard to avoid:
  > *"#957 follow-up: type ids that an `IfcRelDefinesByType` instantiates (the type has at least one occurrence). Such a type's geometry is already drawn through its occurrences — directly or via an `IfcMappedItem` — so it must NOT also be rendered as orphan type-only geometry. Real-world exporters (e.g. ArchiCAD AC20) attach a RepresentationMap to nearly every door/window/furniture type while the occurrence carries its own body, leaving the type map referenced by no IfcMappedItem; without this gate every such type double-renders at its MappingOrigin (duplicate boxes at the wrong position)."*

  **Read as guidance for us: emit the rep map AND reference it from `IfcMappedItem`s AND link occurrences with `IfcRelDefinesByType`, and nothing double-draws.**
- GPU instancing: `/Users/samarvir/formaIFC/ifc-lite/rust/processing/src/processor/mod.rs:547-552` builds a *"#1623 Phase 2 don't-bake plan"* — `IfcRepresentationMap id ⇒ (occurrence count, min IfcMappedItem express id)`, filtered to `count >= 2`; the min-id occurrence materialises as the template, the rest instance against it. Mirrored on the TS side in `/Users/samarvir/formaIFC/ifc-lite/packages/geometry/src/geometry.worker.ts:149, 537` and typed in `packages/geometry/src/types.ts:73, 145-148` (mesh class `0` = normal occurrence, `1` = orphan type geometry, `2` = instanced template — *"DO NOT RENDER in normal/Model view"*).

### 6.4 `IfcFurnishingElement` / `IfcFurniture`

`IfcFurnishingElement` is a first-class class in the pipeline: `/Users/samarvir/formaIFC/ifc-lite/rust/processing/src/processor/mod.rs:315` assigns it shard class 10, and `rust/processing/src/style/mod.rs:201-202` gives it a default colour `Rgba::new(0.7, 0.55, 0.4, 1.0)` ("Furniture — light wood"), cross-checked against the wasm table at 298-300. **`IfcFurniture` itself does not appear** in `rust/processing/src` — but it is in the generated schema (`packages/parser/src/generated/entities.ts`, `rust/core/src/generated/type_ids.rs`), and the geometry router dispatches on the *representation item* type, not the product type, so an `IfcFurniture` occurrence would still mesh; it would just fall to a default rather than the furniture colour. **Recommendation: keep emitting `IfcFurnishingElement` for the occurrences** (it is the styled, classified one) and use `IfcFurnitureType` for the type object.

### 6.5 Selection and colour on instanced geometry

`/Users/samarvir/formaIFC/ifc-lite/packages/renderer/src/pick-resolve.ts:141-177` — *"the point and instanced shaders write the express id straight into the sample"*, `if (decoded.kind === 'instanced') return decoded.instanceExpressId;`. Per-instance colour override exists: `packages/renderer/src/scene.ts:34` imports `composeInstancedOverrideColor`, and the instance buffer carries `INSTANCE_COLOR_OFFSET` / `INSTANCE_FLAG_SELECTED` / `INSTANCE_FLAG_HIDDEN` (55-58). So `SET_COLORS`, `ISOLATE`, `HIDE` and picking all keep working on mapped/instanced furniture. Per-occurrence `IfcStyledItem` on an `IfcMappedItem` is also recognised: `rust/processing/src/appearance/evaluated_source.rs:51` and `appearance/page_material.rs:50` both match `IfcMappedItem` / `IfcRepresentationMap` as style parents, and `rust/processing/src/element.rs:566-570` *"Direct style wins; else chase IfcMappedItem so mapped sub-geometry inherits its underlying style (#913 §2.7)"*.

---

## 7. Tooling

### 7.1 `package.json`

```json
"scripts": {
  "test":      "node --test 'src/**/*.test.ts'",
  "typecheck": "/Users/samarvir/formaCAD/node_modules/.bin/tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --lib ES2022,DOM --allowImportingTsExtensions --erasableSyntaxOnly --verbatimModuleSyntax --skipLibCheck --typeRoots /Users/samarvir/formaCAD/node_modules/@types --types node src/core/*.ts src/disciplines/*/*.ts src/ifc/*.ts src/ifc/vendor/ifc-lite-create/*.ts src/cli/*.ts src/pipeline.ts src/app/*.ts",
  "gen":       "node src/cli/main.ts",
  "build":     "node scripts/build.mjs",
  "samples":   "node src/cli/main.ts --all-presets --out dist/samples"
},
"engines": { "node": ">=24" },  "type": "module",  "license": "MPL-2.0",  "private": true
```
No dependencies, no devDependencies. `tsc` and `esbuild` are borrowed from absolute paths outside the repo.

### 7.2 `scripts/build.mjs` (148 L)

Produces **one file**: `dist/forma-resi-ifc.html`.

- Flags: `--mock`, `--strict`, `--watch`, `--no-minify`.
- `ESBUILD = process.env.ESBUILD_BIN || '/Users/samarvir/.npm/_npx/fd45a72a545557e9/node_modules/.bin/esbuild'`.
- `REAL_DEPS` (35-46) lists the 10 modules the real backend imports; `missingRealDeps()` falls back to the mock backend with a loud warning (or exits 1 under `--strict`).
- `bundle(mode)` (53-70): entry `src/app/entry.{mock,real}.ts`, `--bundle --format=iife --target=es2022 --platform=browser --loader:.ts=ts --charset=utf8 --legal-comments=none`, `--define:__BACKEND_MODE__` and `--define:__BUILD_ID__` (ISO minute), `--minify` unless suppressed. Output captured as a **string** (`encoding:'utf8'`, `maxBuffer: 256 MB`).
- Inlining (99-124): reads `src/app/index.html` + `src/app/styles.css`, requires the `<!--APP_CSS-->` and `<!--APP_JS-->` markers, neutralises `</style`, `</script`, `<!--`, `-->` in the payloads, and substitutes with **replacer functions** (not strings) so minified `$&`/`$'` sequences are not expanded (comment at 118-119). Also substitutes `<!--APP_MODE-->` into `<body data-backend>`.
- `--watch` uses `fs.watch(src, {recursive:true})` with a 120 ms debounce, filtered to `.ts|.css|.html`.

`src/app/index.html` (43 L): header with the five action buttons + hidden `#file-spec`, `<aside id="sidebar">`, `<main>` with `<nav id="tabs">` + `<div id="panels">`, `<footer id="statusbar">`, `<div id="spinner">`.

### 7.3 `scripts/serve.mjs` (34 L)

`node scripts/serve.mjs [port=8765]` — `node:http` static server rooted at `dist/`, `/` → `/forma-resi-ifc.html`, small MIME table including `.ifc → application/x-step`, path-traversal guard (`!file.startsWith(ROOT)` → 403), `cache-control: no-store`.

### 7.4 Test layout

`node --test 'src/**/*.test.ts'` over 15 files (`node:test` + `node:assert/strict`, Node 24 native TS type-stripping):

```
src/app/{export,form,render,svg,util}.test.ts
src/core/metrics.test.ts
src/disciplines/architecture/{architecture,unit-layout}.test.ts
src/disciplines/{electrical,mechanical,plumbing,site,structure}/*.test.ts
src/ifc/{validate,writer}.test.ts
```

**How `src/app` tests render SVG without a DOM** — `/Users/samarvir/formaIFC/generator/src/app/render.test.ts` (175 L). Because `buildPlan` / `buildSite` / `buildAxon` are pure `(model, …) → Drawing` string builders and `mock-model.ts` builds a `DesignModel` from plain objects, no DOM is needed at all — the tests import the builders directly and assert on the returned strings/hits. Notable assertions:
- `mock model is internally consistent` (18-35): >100 elements, 4 units, unique ids, every element on a known storey, every pattern application registered.
- `no NaN coordinates in any mock element footprint` (37-45).
- `plan builds for every storey, batched and under budget` (47-63): **`ms < 100` per storey**, no `NaN` in the body, non-zero bounds, `>10` hits on habitable storeys, and the batching invariant `paths < max(60, hits.length)`.
- `layer toggles remove their layer from the drawing` (65-75): asserts `l-elec`, `l-room-labels`, `l-struct` presence/absence.
- `hit picking prefers the smallest containing box` (77-85).
- `opening placement along a wall` (87-94): pins `along()`'s `a`/`b`/`dir`/`nrm` for a +X wall — **note it only covers the +X case, which is exactly why the −X arc bug survived.**
- `site plan and axon build` (96-115): `project()` sanity, `ccw()` both directions.
- `mock IFC writer output parses back to a GUID map` (117-130) and a hand-written STEP snippet test for `parseIdGuidMap` (132-147).
- `scale bar and north arrow maths` (149-159).
- `plan of a 20-storey-scale element load stays under 100 ms` (161-175): clones 3000 synthetic elements onto one storey.

Other app tests: `svg.test.ts` (50 L, path builders), `util.test.ts` (60 L), `form.test.ts` (83 L, `getPath`/`setPath`/`parseValue`), `export.test.ts` (46 L, `safeFileName`/`buildReport`/`specFromLoaded`).

`src/ifc/writer.test.ts` (810 L, 22 tests) — highlights: `every geometry kind reaches the right IFC entity` (402), `idMap covers every writable element and carries the id into the Tag` (432), `bad elements produce warnings instead of throwing` (451), `deterministic mode is byte-identical across runs` (489, 748), `identical property sets are written once and bound to every product` (631), `property sets are only merged when every value agrees` (666), `box placement matches the addIfcFurnishingElement footprint` (609), **`a 500-box model costs at most 16 STEP entities per element`** (735), `a 20-storey point tower writes in well under 2 s` (784).

`src/ifc/validate.ts` (306 L) + `validate.test.ts` — a self-contained STEP structural validator (not a schema checker): header sequence, `#<int>=<TYPE>(...);` per line, unique ids, balanced parens with `''` escaping, every `#n` reference resolves, **numeric tokens must be plain decimals (no `1e-7`, no NaN/Infinity)**, exactly one `IFCPROJECT`, at least one `IFCSITE`/`IFCBUILDING`/`IFCBUILDINGSTOREY`, non-empty member sets for 6 relationship types (`MEMBER_LIST_RELATIONSHIPS`, 39-47). O(file length). **Any new entity you add must satisfy these** — in particular no exponent literals and no empty relationship sets.

### 7.5 `CONTRACT.md` summary

The per-discipline agent brief (86 L). Key content:
- **Scope discipline**: implement one discipline folder; never edit `src/core/types.ts` (add optional fields in a new `src/core/types-ext-<discipline>.ts` and report it instead).
- **Runtime**: Node 24 native TS, `/Users/samarvir/.nvm/versions/node/v24.21.0/bin/node`. **Erasable TypeScript only** — no `enum`, no value `namespace`, no parameter properties, no decorators, no `const enum`; `import type` for types; relative imports **must** carry `.ts`.
- **No runtime deps, no `Math.random` (use the injected `Rng`), no `Date.now()` in geometry.**
- Coordinates: metres/radians; world origin = site front-left; +X along the street, +Y street→site, +Z up; street edge at `y = 0`; **element Z is storey-local, XY is world**; storey ids `SITE|FND|B1..|L01..|ROOF`; polygons CCW and not closed; `Rect` = min corner + size.
- **The `geometry.kind` → IfcCreator table** (38-51) — the same table implemented in `writer.ts`, including the line `| box | addIfcFurnishingElement (IfcFurnishingElement) or addElement (any IfcType) | min corner + rotation about that corner |`.
- `ifcType` is PascalCase with an explicit list of the ~25 expected entity names and their `predefinedType` values (53-60).
- Attach `psets` (standard `Pset_*` + a `Forma_<Discipline>`), `quantities`, `color`, `system`, `unitId`/`roomId`, `patterns: [ids]`. Ids from `new IdFactory('<discipline>').next(storeyId, 'KIND')`.
- Export `<DISC>_PATTERNS: Pattern[]` with Alexander-style problem/solution + sourced parameters; record every application as a `PatternApplication`.
- **Performance budget: a 20-storey point tower in < 2 s in Node**; prefer O(n) sweeps; cap density with `spec.options.detail`.

### 7.6 `README.md` known limitations (lines 116-123, verbatim substance)

> Rectilinear geometry only (no curved or angled plans); L/U/O wings each carry their own corridor and core, and the corridors do not yet join at the knuckle; achieved building-wide WWR is below the per-unit target because cores and podium floors are lightly glazed; loads are intensity-based estimates, not heat-balance or circuit calculations; **IFC is IFC4 STEP with extruded solids (no mapped items), so large presets are tens of megabytes.**

### 7.7 What is `src/app/mock-model.ts` (972 L)?

Its own header (1-8):
> *"Hand-built mock `DesignModel` for UI development: a 2-storey, 4-unit walk-up bar with a real (if small) slice of every discipline, plus mock metric definitions, unit templates and an IFC writer. Used when the real generator is not bundled (`--mock`) or when the page is opened with `?mock=1`. Nothing here is authoritative geometry — it exists so every tab renders."*

Exports `buildMockModel(spec: PartialSpec): DesignModel`, `mockWriteIfc(model): IfcOutput` (946-972 — a hand-rolled STEP emitter: header, `IFCPROJECT`, `IFCBUILDING`, one `IFCBUILDINGSTOREY` per storey, **one line per element with no geometry at all**, deterministic `mockGuid()`), `MOCK_METRICS` (20 ranked defs), `MOCK_TEMPLATES` (20 templates). It is also the **fixture for every `src/app` test** (`render.test.ts:8, 16`), which is why it has to satisfy the real `DesignModel` contract. The 3D tab shows a `badge-mock` warning when the mock backend is active because its IFC has no geometry (`main.ts:522`).

---

## 8. `src/core/spec.ts` + `GenerationOptions` + CLI

### 8.1 `BuildingSpec` — the full shape

`/Users/samarvir/formaIFC/generator/src/core/types.ts:236-315`:

```ts
export interface BuildingSpec {
  name: string;
  seed: number;
  region: Region;                                  // 'US'|'UK'|'CA'|'AU'|'NZ'|'IE'
  displayUnits: 'metric' | 'imperial';
  typology: TypologyId;                            // 20 ids, types.ts:64-81
  site: SiteSpec;
  massing: MassingSpec;
  /** Per-floor overrides; floors not listed are generated from massing + typology defaults */
  floors: FloorSpec[];
  /** Building-wide unit mix weights; overrides typology default */
  unitMix?: Partial<Record<UnitTemplateId, number>>;
  options: GenerationOptions;
}

export interface SiteSpec {                        // 236-252
  width: number; depth: number; streetFacing: Compass; context: 'urban'|'suburban'|'rural';
  setbacks?: Partial<{ front: number; side: number; rear: number }>;
  slopePercent?: number; maxHeight?: number; maxFar?: number; maxCoverage?: number;
  parking?: { type?: ParkingType; ratio?: number; evShare?: number; bikeRatio?: number };
}

export interface MassingSpec {                     // 254-272
  storeys: number; footprintShape?: FootprintShape; buildingDepth?: number; buildingLength?: number;
  floorToFloor?: number; groundFloorToFloor?: number; podiumStoreys?: number;
  podiumUse?: 'retail'|'parking'|'amenity'; basementStoreys?: number; corridorWidth?: number;
  coreCount?: number; roof: RoofType; roofPitchDeg?: number; parapetHeight?: number; balconyDepth?: number;
}

export interface FloorSpec {                       // 274-288
  index: number;                                   // 0 = ground, negative = basements
  name?: string; use: FloorUse; floorToFloor?: number; ceilingHeight?: number;
  unitMix?: Partial<Record<UnitTemplateId, number>>; targetUnits?: number;
  balconies?: boolean; setbackFromBelow?: number; wwr?: number;
}

export interface GenerationOptions {               // 290-300
  furniture: boolean; site: boolean; structure: boolean;
  mechanical: boolean; plumbing: boolean; electrical: boolean;
  detail: 'low' | 'medium' | 'high';               // element density
  ifcSchema: 'IFC2X3' | 'IFC4' | 'IFC4X3';
}
```

**It is plain, serialisable JSON already** — every field is a string, number, boolean, array or plain object. No `Date`, no `Map`, no class instances, no functions. `state.spec` round-trips through `structuredClone` (with a `JSON.parse(JSON.stringify())` fallback, `state.ts:91-97`), `JSON.stringify` (the Copy-spec button and the sidebar `<pre>`) and `JSON.parse` (Load spec). Adding `overrides` and `rules` keys is purely additive and needs no serialisation work.

### 8.2 `normalizeSpec` — the merge/normalise seam

`/Users/samarvir/formaIFC/generator/src/core/spec.ts:9-71`:
```ts
export type PartialSpec = Partial<Omit<BuildingSpec,'site'|'massing'|'options'>> & {
  typology: BuildingSpec['typology'];              // the ONLY required field
  site?: Partial<BuildingSpec['site']>;
  massing?: Partial<BuildingSpec['massing']>;
  options?: Partial<BuildingSpec['options']>;
};

export function normalizeSpec(input: PartialSpec): BuildingSpec
```
It resolves the typology (`getTypology`, which throws on an unknown id — this is what makes `normalizeSpec` usable as a validator in `main.ts:210` and `form.ts:118-123`), clamps `storeys` to `[1,60]`, then fills **every** optional field from the typology: name, `seed ?? 42`, `region ?? 'US'`, `displayUnits` from region, site defaults via `defaultSiteWidth`/`defaultSiteDepth` (77-97), massing defaults, `unitMix ?? t.defaultUnitMix`, and `options` defaults (`furniture/site/structure/mechanical/plumbing/electrical: true`, `detail:'medium'`, `ifcSchema:'IFC4'`) spread-overridden by `input.options`. Finally `spec.floors = resolveFloors(spec, t)`.

`resolveFloors(spec, t)` (100-130) is the pattern an `overrides` section should copy: build `const overrides = new Map(spec.floors.map(f => [f.index, f]))`, generate the canonical list (basements → ground → podium → residential), and spread `...(overrides.get(i) ?? {})` **last** so user values win.

`buildStoreys(spec, floors, foundationDepth=1.2, region)` (133-154) produces the `StoreyDef[]` ladder (`SITE` index −101, `FND` −100, basements, `L01..`, `ROOF` 100), `storeyName(index, region)` (156-162) regionalises floor naming.

Presets: `export interface Preset { id; label; spec: PartialSpec }` (174-178) and `export const PRESETS: Preset[]` (180-231) — 10 presets (`us-5-over-1`, `uk-terrace`, `ca-point-tower`, `au-walkup`, `us-detached`, `uk-mansion`, `ie-courtyard`, `nz-coliving`, `us-senior`, `ca-laneway`), each a tiny `PartialSpec`. `getPreset(id)` (233-237) throws on unknown. `UNIT_TEMPLATE_IDS: UnitTemplateId[]` (239-243) — the canonical 20-template order the UI iterates.

**Preset loading in the UI** (`form.ts:426-435`): `state.spec = structuredCloneSafe(p.spec)` — a *replacement*, not a merge; `openMixFloors.clear()`; structural commit. `[data-act="reset"]` (448-453) does the same for the current preset. Both are full-clobber, so any `overrides`/`rules` section you add will be wiped by a preset switch unless you explicitly carry it across (a design decision worth making early — I'd wipe `overrides` and keep `rules`).

### 8.3 CLI — `src/cli/main.ts` (454 L)

Uses `node:util parseArgs` with `strict: true, allowPositionals: false` (71-92). Usage block at 26-50:
```
--preset <id> | --spec <file.json> | --all-presets
--out <dir>   (default dist/samples)   --seed <n>   --schema IFC2X3|IFC4|IFC4X3
--detail low|medium|high   --no-mep   --no-site   --validate | --no-validate   --report
--list-presets | --list-typologies | --list-templates | --help
```
**`--spec` takes a JSON file** read with `readFileSync` and parsed as a `PartialSpec` — *"partial spec JSON (must contain at least `typology`)"*. Output: `<out>/<name>.ifc`, plus `<out>/<name>.report.json` under `--report`. Exit 1 when `validateStep` fails or on bad input. `export interface MainDeps { generate?: (input: PartialSpec|BuildingSpec) => DesignModel }` (63-65) is an injection seam for tests.

So the CLI and the web app already consume the identical JSON envelope — an `overrides` section added to `PartialSpec` is immediately usable from both, and `Copy spec` → file → `--spec` is a working round trip today.

### 8.4 Where the seed/RNG flows (needed for §9.iv)

`/Users/samarvir/formaIFC/generator/src/core/rng.ts` (48 L) — mulberry32 with an FNV-1a string hash:
```ts
export function createRng(seed: number | string): Rng            // rng.ts:15
fork: label => createRng(hashString(`${state}:${label}`))         // rng.ts:45  ← forks off CURRENT state
```
`Rng` interface at `types.ts:1152-1162` (`next`, `int`, `pick`, `weighted`, `shuffle`, `fork`).

`pipeline.ts:22` `const rng = createRng(spec.seed)`, then one fork per discipline: `rng.fork('site')` (29), `'architecture'` (37), `'structure'` (42), `'mechanical'` (47), `'plumbing'` (52), `'electrical'` (57). **`fork` derives from the current internal `state`, so forks are order-dependent** — the fork labels are fixed, but the parent's state advances only when the parent itself is drawn from, which it isn't between forks, so the sequence is stable as long as the fork *order* is.

Inside architecture the per-unit fork is `floor-organizer.ts:1398`:
```ts
rng: ctx.rng.fork(`unit:${slot.templateId}:${slot.index}:${level}`),
```
— **keyed by template id, slot index and level, not by storey**. That is deliberate (identical units stack identically, ARC-08) and is exactly the hook an override needs: a "this unit differs" override must change either the slot's `templateId` or the fork label, or it will collide with its stacked twins.

The abstract layout is also memoised by content: `planKey(f, ctx)` (`floor-organizer.ts:102-116`) hashes `use | outline bounds | targetUnits | mix | ground? | balconies? | wwr | ceilingHeight | access`, and `FloorLayout.key` (`types-internal.ts:99-107`) carries it so one layout is computed per distinct floor and replicated across storeys.

The writer has its own independent stream: `createRng(\`${spec.name}:${spec.seed}:ifc-guid\`)` (`writer.ts:350`). So GUIDs shift whenever the name or seed changes but are otherwise stable in element order.

---

## 9. Assessment

### 9.i The cleanest seam for a floorplan editor

**Who owns the SVG today.** `plan-svg.ts` owns *content* (a pure `(model, storey, layers, units, highlight) → Drawing` string builder); `viewport.ts` owns *presentation and input* (the `<svg>`, the camera, `pointerdown/move/up`, hover tip, `onPick`); `main.ts` owns *orchestration* (toolbar, `state`, calling `buildPlan` then `planVp.setDrawing`). The three are cleanly separated and nothing else touches the SVG.

**The good news.** You do not need to rewrite anything:
1. `Drawing.hits: Hit[]` is already a complete, ordered, pickable index of every drawn object with `id`, `kind`, `label`, a bbox and meta — `pickHit` already prefers the smallest containing box, and `Viewport` already discriminates click from drag via `moved` (`viewport.ts:190, 207-213`).
2. `elementIndex(model)` (`plan-svg.ts:88-95`) gives `id → ModelElement` in O(1), WeakMap-cached per model.
3. The `hooks` object on `Viewport` (`ViewportHooks`, `viewport.ts:33-38`) is the designed extension point, and it is already parameterised per instance (plans / site / axon each pass their own).
4. `toWorld(px, py)` (`viewport.ts:137-139`) is public — screen→world is one call.
5. Batched `<path>` rendering means there are **no per-element DOM nodes to keep in sync**; an interaction layer is inherently a separate `<g>`.

**The recommended shape.**

- **Extend `Hit`, don't replace it.** Add optional, discriminated payload: `srcKind?: 'room'|'wall'|'door'|'window'|'furniture'|'unit'|'column'|…`, `unitId?`, `roomId?`, `wallId?`, and — critically — the *handles* an editor needs: `poly?: Vec2[]` (the true footprint, so you can do a real point-in-polygon test instead of a bbox test) and `anchor?: Vec2`. `buildPlan` already has all of these in hand at each `hits.push(...)` site; this is ~15 one-line additions and no behavioural change (existing consumers read only the fields they know).
- **Add a `kind: 'unit'` hit.** There is currently no unit-level hit — only rooms. `arch.units: UnitInstance[]` has `rect`, `polygon`, `templateId`, `accessSide`, `entryDoorId`, `roomIds` (`types.ts:710-732`), everything "select a unit/module, move/swap it along the corridor" needs. Emit a unit hit with a large bbox so `pickHit`'s smallest-area rule keeps rooms selectable inside it; select the unit via a modifier or via a mode toggle.
- **Add an `overlay` layer, not a new renderer.** Put selection outlines, drag ghosts, snap guides and handles into a second `<g class="edit">` inside the camera group, redrawn on its own (cheap: a handful of paths) without touching `cam.innerHTML`. That means one new method on `Viewport`, e.g. `setOverlay(markup: string)`, mirroring `setDrawing`.
- **Add the gesture in `Viewport.bind()`, gated by a hook.** The minimal, non-invasive change to `viewport.ts:178-214`:
  ```
  hooks.onDragStart?(hit, world) → returns true to claim the gesture
  ```
  In `pointerdown`, run `pickHit` first; if `hooks.onDragStart` claims it, set `mode='edit'` instead of `dragging=true` and route `pointermove` to `hooks.onDragMove(world)` and `pointerup` to `hooks.onDragEnd(world)`. Panning stays the default when nothing is claimed (and keep middle/right-button pan, which currently returns early at 179). Everything else — pointer capture, `touch-action:none`, the `moved` threshold — is already correct for dragging.
- **Constraint evaluation belongs in a new `src/core/edit/` (or `src/app/edit-*.ts`) module, not in `plan-svg.ts`.** `plan-svg.ts` must stay a pure, DOM-free, testable builder; `render.test.ts` depends on that. Constraints have real source material to reuse: `CLEARANCE` and `FURNITURE_CATALOG` in `furniture.ts`, the `swings` keep-clear rects logic in `unit-layout.ts:2150-2165`, `SIZES` in `coordination.ts`, and `UnitSlot.boundary` / `stackAlong` / `sides` in `types-internal.ts:42-61`.
- **Decouple the drag from `run()`.** A full regenerate is ~1-2 s on the mid-rise preset and blocks the main thread (§1.3). Drag must move the overlay only; commit on `pointerup` writes the override and triggers the existing debounced `scheduleRun()`. If even that feels heavy, the natural next step is moving `generateBuilding` into a worker (the pipeline is pure and the `DesignModel` is structured-cloneable — `structuredCloneSafe` already proves it), which also fixes the "slow — try detail low" nudge at `main.ts:785-787`.

**Things to watch.**
- `main.ts:260-261` clears `state.pinned` and `state.highlight` on every run; an editor needs its selection to *survive* regeneration, keyed by a stable id (`UnitInstance.id`, `RoomDef.id` — all deterministic per `ids.ts`).
- `delegateOnce` (`main.ts:417-422`) attaches toolbar handlers once via a module-level `Set<string>`; a new "Edit" toolbar must either use a new key or be attached in `buildShell()`.
- `renderPlans()` (352-407) rebuilds the whole toolbar `innerHTML` on every storey/layer change; an edit-mode toggle should live in `state` so it survives.
- `fitted` / `state.highlight` interplay at 400-406 calls `pinHit` as a side effect of rendering — worth untangling before adding a second selection concept.
- Stroke widths in `plan-svg.ts` are pixel-space (`non-scaling-stroke`) while `site-svg.ts` uses world-space; keep edit handles pixel-space (`HAIR` + `vector-effect`) so they stay grabbable at any zoom.

### 9.ii What the writer/IfcCreator lacks for mapped-item furniture, and the entity cost

**What's missing** (all confirmed absent in §5.2). You need to add to the vendored creator, in dependency order:

1. `addIfcRepresentationMap(axis2Placement3dId, representationId): number` → `IFCREPRESENTATIONMAP`.
2. `addIfcMappedItem(representationMapId, transformOperatorId): number` → `IFCMAPPEDITEM`.
3. `addIfcCartesianTransformationOperator3D({ Axis1?, Axis2?, LocalOrigin, Scale?, Axis3? })` → `IFCCARTESIANTRANSFORMATIONOPERATOR3D` (+ the `NonUniform` variant if you ever want per-instance scaling, e.g. a stretched kitchen counter run — `unit-layout.ts` already stretches `kitchen-counter` width, see `furniture.ts:62`). **Cache it** through `sharedResource` — the identity operator will be referenced thousands of times.
4. A shape-representation variant that emits `RepresentationType = 'MappedRepresentation'`. `addShapeRepresentation` (`ifc-creator.ts:2547-2557`) hardcodes `'SweptSolid'`/`'SolidModel'`; either add an optional `repTypeName` parameter or add `addMappedShapeRepresentation(mappedItemIds)`.
5. `addIfcFurnitureType({ Name, PredefinedType, RepresentationMaps, Tag })` → `IFCFURNITURETYPE` (IFC4; under IFC2X3 use `IFCFURNITURETYPE` too — it exists there — but `IfcFurnitureTypeEnum`/`AssemblyPlace` attribute order differs, so route through `ifc4Only()` like the existing enums). Also generalisable to `IfcDoorType`, `IfcWindowType`, `IfcSanitaryTerminalType`, `IfcElectricApplianceType`.
6. `addIfcRelDefinesByType(typeId, occurrenceIds)` → `IFCRELDEFINESBYTYPE`, **chunked** like `assignToGroup` (reuse `GROUP_CHUNK`/`PROPERTY_REL_CHUNK`).
7. Multi-solid support: a way to route N solids into one `IfcShapeRepresentation`. The plumbing is already there (`addShapeRepresentation` takes `itemIds: number[]` and switches to `'SolidModel'`); you just need a public path, e.g. `addSolidGroup(profiles: {profile, depth, placement}[]): number[]`.
8. **Styling needs rethinking.** `finalizeStyles()` (2210-2235) walks `elementSolids: Map<elementId, solidIds[]>` and emits one `IFCSTYLEDITEM` per solid per element. For mapped furniture the solids belong to the *type*, and an occurrence has no solids of its own. Two options, both supported by ifc-lite (§6.5): (a) style the type's solids once → colour becomes per-type (fine, since `styleName()` is already class-level, `writer.ts:1063-1065`); (b) emit an `IfcStyledItem` on the per-occurrence `IfcMappedItem` for per-instance colour. Start with (a).
9. **Validator compatibility**: `validate.ts` requires non-empty member sets for its `MEMBER_LIST_RELATIONSHIPS` — add `IFCRELDEFINESBYTYPE` to that set for consistency, and keep all numbers as plain decimals (no exponents).

**On the writer side**: `writer.ts:639-661` (the `box` branch) needs a furniture-library pre-pass — one type per distinct `(objectType, width, depth, height)` tuple, since `FurnitureDef` dimensions can be stretched per instance and mapped items with identity targets cannot absorb a size change. A `Map<typeKey, { typeId, prodShapeId }>` built lazily on first use, plus `Map<typeKey, expressId[]>` for the deferred `IfcRelDefinesByType` chunks, mirrors the existing `SharedSets` pattern exactly.

**Measured entity cost** (I ran the real pipeline + writer on `us-5-over-1`; `furniture: true` vs `false`, all other disciplines off, compact mode):

```
furniture elements: 1810
entities with: 58604   without: 46711   delta: 11893   → 6.57 entities per furniture instance
bytes delta: 753,951                                    → 417 bytes per instance

per instance breakdown:
  1.00  IFCLOCALPLACEMENT
  1.00  IFCEXTRUDEDAREASOLID
  1.00  IFCSHAPEREPRESENTATION
  1.00  IFCPRODUCTDEFINITIONSHAPE
  1.00  IFCSTYLEDITEM
  1.00  the product (0.63 IFCFURNISHINGELEMENT + 0.19 IFCELECTRICAPPLIANCE + 0.18 IFCSANITARYTERMINAL)
  0.21  IFCCARTESIANPOINT      ← cached; storey-local coords mean stacked floors share points
  0.20  IFCAXIS2PLACEMENT3D    ← cached
  0.02  IFCRECTANGLEPROFILEDEF / styles / psets (all effectively free)
```

Whole-preset baseline for context (all disciplines on): **27,921 elements → 313,146 entities (11.22/element), 22.5 MB**. Top types: `IFCPROPERTYSINGLEVALUE` 91,478; `IFCEXTRUDEDAREASOLID` 29,733; `IFCLOCALPLACEMENT` 29,057; `IFCSHAPEREPRESENTATION` 29,047; `IFCPRODUCTDEFINITIONSHAPE` 29,047; `IFCSTYLEDITEM` 28,607; `IFCRELDEFINESBYPROPERTIES` 13,651; `IFCPROPERTYSET` 13,423.

**Projected cost with mapped items.** Put the rotation in the occurrence's `IfcLocalPlacement` (as `addIfcFurnishingElement` already does) and use a **shared identity** `IfcCartesianTransformationOperator3D`, so the `IfcMappedItem` → `IfcShapeRepresentation('MappedRepresentation')` → `IfcProductDefinitionShape` chain is **identical for every occurrence of a type and can be shared**:

| per instance | today (1 box) | mapped (any complexity) | today, 4-solid model |
|---|---|---|---|
IfcCartesianPoint | 0.21 | 0.21 | 0.21 |
IfcAxis2Placement3D | 0.20 | 0.20 | 0.20 |
IfcLocalPlacement | 1.00 | 1.00 | 1.00 |
IfcExtrudedAreaSolid | 1.00 | — | 4.00 |
IfcStyledItem | 1.00 | — | 4.00 |
IfcShapeRepresentation | 1.00 | — | 1.00 |
IfcProductDefinitionShape | 1.00 | — | 1.00 |
the product | 1.00 | 1.00 | 1.00 |
**total** | **≈ 6.4** | **≈ 2.4** | **≈ 12.4** |

Per-type one-off (say ~45 types × a 4-solid recognisable model): `IfcFurnitureType` 1 + `IfcRepresentationMap` 1 + type `IfcShapeRepresentation` 1 + 4 solids + 4 styled items + `IfcMappedItem` 1 + mapped `IfcShapeRepresentation` 1 + `IfcProductDefinitionShape` 1 + profiles/placements ~2 ≈ **16 entities/type ≈ 720 total**, plus `⌈1810/500⌉ = 4` `IfcRelDefinesByType` lines. Negligible.

Net for this preset's furniture:
- today, one box each: **11,893 entities / 754 kB**
- mapped, one box each: 1810 × 2.4 + ~350 ≈ **4,700 entities (−60 %)**
- mapped, **4-solid recognisable** furniture: 1810 × 2.4 + ~720 ≈ **5,100 entities** — i.e. *recognisable* furniture for **57 % fewer entities than today's boxes*
- unmapped, 4-solid: ≈ **22,400 entities** — 4.4× worse than the mapped version

That's the whole argument for (c): mapping makes geometric richness roughly free per instance, since the only per-instance cost left is the placement chain and the product line. Two adjacent freebies while you're in there: **cache `IfcLocalPlacement`** on `relativeTo|axis2Id` (29,057 lines today, and stacked identical floors would collapse hard), and note that `IFCPROPERTYSINGLEVALUE` at 91,478 is now the single largest entity class — a shared-property *value* cache (one `IfcPropertySingleValue` per distinct name/type/value across all psets) is a bigger absolute win than anything geometric.

### 9.iii Will the embedded viewer render `IfcMappedItem`? — Yes, with strong evidence

1. **Dedicated resolver module**: `/Users/samarvir/formaIFC/ifc-lite/rust/geometry/src/router/mapped_item.rs` — caching, depth-bounded and cycle-safe recursion, merges an `IfcRepresentationMap`'s items into one source-coords mesh; documents `MappingSource`/`MappingTarget` attribute indices.
2. **All four transformation operators**: `rust/geometry/src/router/transforms/operator.rs` matches `IfcCartesianTransformationOperator2D`, `2DnonUniform`, `3D`, `3DnonUniform`, reading `Scale`/`Scale2`/`Scale3`; non-uniform scaling is threaded through `transforms/mesh_world.rs:179` and the voids probe (`router/voids/probe.rs:378`).
3. **Regression suite**: `rust/processing/tests/issue_1985_mapped_item_transform.rs`, `issue_2256_mapped_item_unresolved.rs`, `issue_4103_shared_map_buffer_identity.rs`, `issue_1994_transform2d_mirror.rs`, `site_local_instancing.rs`, `issue_957_type_only_geometry.rs`.
4. **`IfcRelDefinesByType` is honoured** for type→occurrence material/style inheritance: `rust/processing/src/prepass_type_material.rs:20-80`.
5. **Type geometry is a first-class job kind**: `rust/processing/src/element.rs:75-79` `ElementJobKind::TypeProduct { rep_maps }`, with the orphan-vs-instanced decision documented at 148-186.
6. **The instancing path is built for exactly our pattern**: `rust/processing/src/processor/mod.rs:547-552` builds a don't-bake plan keyed `IfcRepresentationMap id ⇒ (occurrence count, min IfcMappedItem express id)`, filtered to `count >= 2`; mesh classes in `packages/geometry/src/types.ts:145-148` keep the template out of the normal view so nothing double-draws. `packages/geometry/src/geometry.worker.ts:149, 537` installs the plan on the live viewer path.
7. **The double-render hazard is already gated** — `processor/mod.rs:553-560` explicitly handles the ArchiCAD case (a type rep map with no `IfcMappedItem` reference), so as long as we reference our rep maps from `IfcMappedItem`s **and** link occurrences with `IfcRelDefinesByType`, we're on the well-tested path.
8. **The live-viewer path specifically has its own guard test**: `packages/wasm/test/type-only-geometry.test.mjs` — *"the browser viewer renders through `buildPrePassOnce` + `processGeometryBatch` … A rust `process_geometry` test cannot catch a regression on THIS path."* It exercises the buildingSMART annex-E `IfcBoilerType` + `RepresentationMaps` files.
9. **Selection, colour and isolate survive instancing**: `packages/renderer/src/pick-resolve.ts:141-177` (instanced shader writes the express id straight into the pick sample), `packages/renderer/src/scene.ts:34, 55-58` (`composeInstancedOverrideColor`, `INSTANCE_COLOR_OFFSET`, `INSTANCE_FLAG_SELECTED`/`HIDDEN`). So `main.ts`'s `isolateDiscipline` and `colourByDiscipline` keep working on mapped furniture.

**Caveats.** (a) The clone is monorepo 9.0.1; `embed.ifclite.com` is a deployed service whose version we cannot verify from here — validate empirically with one small mapped-item file before committing to the encoding. (b) `IfcFurniture` (the IFC4 leaf) has no entry in `rust/processing/src/style/mod.rs`, whereas `IfcFurnishingElement` gets the light-wood default (`style/mod.rs:201-202`) and shard class 10 (`processor/mod.rs:315`) — emit `IfcFurnishingElement` occurrences with `IfcFurnitureType` types. (c) `rust/geometry/src/router/mapped_item.rs` bounds nesting at `MAX_MAPPED_ITEM_DEPTH`; keep the chain flat (one level). (d) The axonometric fallback (`axon-svg.ts`) reads `ModelElement.geometry`, not the IFC, so it is unaffected — but it will keep drawing furniture as bounding boxes unless `ElementGeometry` grows a composite kind.

### 9.iv How spec overrides should thread through deterministically

The determinism chain, end to end:
```
spec.seed ──createRng──► rng ──fork('architecture')──► ctx.rng
                                     │
                                     └─fork(`unit:${slot.templateId}:${slot.index}:${level}`) ──► layoutUnit's rng
                                                                      (floor-organizer.ts:1398)
spec.name + spec.seed ──createRng(`${name}:${seed}:ifc-guid`)──► GUID stream   (writer.ts:350)
element ids ── IdFactory(discipline).next(storey, KIND) ──► ARC-L03-WALL-017   (core/ids.ts:30-35)  [no RNG at all]
abstract layout memo ── planKey(f, ctx) ──► FloorLayout.key                    (floor-organizer.ts:102-116)
```

**The five rules that fall out of that:**

1. **Overrides live in the spec, not in the model.** `BuildingSpec` is already plain JSON (§8.1) and already has the precedent — `spec.floors` is described in `types.ts:310` as *"Per-floor overrides; floors not listed are generated from massing + typology defaults"* and merged by `resolveFloors` spreading `...(overrides.get(i) ?? {})` last (`spec.ts:126`). Copy that shape:
   ```ts
   overrides?: {
     units?: { slotKey: string; templateId?: UnitTemplateId; alongDelta?: number; mirror?: boolean }[];
     rooms?: { roomId: string; /* partition offsets */ walls?: { wallId: string; offset: number }[] }[];
     furniture?: { id: string; position?: Vec2; rotation?: number; remove?: true }[];
     doors?: { id: string; along?: number; swing?: { side: 'left'|'right'; hinge: 'start'|'end' }; operation?: string }[];
   }
   rules?: { id: string; enabled: boolean; params?: Record<string, number|string|boolean> }[]
   ```
   This keeps every existing invariant: the spec stays serialisable, `Copy spec`/`Load spec`/`--spec` keep working, `buildReport.spec` captures the edits, and `deterministic: true` in the writer still yields byte-identical output for the same spec.

2. **Key overrides by the ids that don't move.** Element ids (`ARC-L03-WALL-017`) come from a *counter*, not the RNG (`ids.ts:30-35`), so they are stable **only while the generation order is stable** — inserting one wall renumbers everything after it. `UnitInstance.id` (`U-L03-04`), `RoomDef.id` (`R-U-L03-04-BED1`) and `FurnitureDef.id` are much more stable because they are derived from the unit/room identity. For unit-level moves, key on the abstract slot: `UnitSlot` has `{ index, templateId, barId, coreId }` (`types-internal.ts:42-61`) and slots are computed once per `planKey` and replicated across storeys — a `slotKey` of `${barId}:${index}` (optionally `+ storey` when the override should apply to one floor only) is the right handle, and it also tells you whether the edit propagates up the stack (which is the *feature*: "move this module" should normally move it on every identical floor).

3. **Apply overrides at the layout seam, not after the fact.** The ideal injection point is `UnitLayoutRequest` (`/Users/samarvir/formaIFC/generator/src/disciplines/architecture/unit-layout-types.ts:24-61`) → `UnitLayout` (63-81), with `type UnitLayoutFn = (req: UnitLayoutRequest) => UnitLayout` (83). Add one optional field — `overrides?: UnitOverride` — to `UnitLayoutRequest` and have `layoutUnit` honour it. Downstream disciplines then regenerate *automatically*: `pipeline.ts:40-59` runs structure → mechanical → plumbing → electrical from `ctx.arch`, so a moved wet wall drags its stack, a moved `needsWater` item drags its fixture (`furniture.ts:134-139` `WATER_ITEMS`/`POWER_ITEMS` are exactly that contract), and a moved `needsPower` item drags its circuit. **This is the single biggest reason to put overrides in the spec rather than post-editing the `DesignModel`** — post-editing would desynchronise all five other disciplines.
   For unit *reordering* along the corridor, the seam is one level up: `planFloorLayout(a: PlanArgs): FloorLayout` (`floor-organizer.ts:70-87`) and its `planCorridorFloor`/`planStairCoreFloor`/`planPointCoreFloor` branches, which produce `FloorLayout.units: UnitSlot[]`. A post-`planFloorLayout` "apply slot overrides" transform that permutes/retypes slots inside the same `boundary` intervals is the least invasive place to intervene.

4. **Do not let overrides shift the RNG stream for unaffected units.** The fork label `unit:${templateId}:${index}:${level}` is content-addressed enough that swapping unit 3's template changes only unit 3's stream — *provided the label keys stay the same for the others*. So: (a) never renumber `slot.index` when applying an override (permute contents, keep indices); (b) when an override makes a unit genuinely different from its stacked twins, fold the override into the label — `unit:${templateId}:${index}:${level}:${overrideHash}` — so the differing instance gets its own stream and the untouched twins keep theirs bit-for-bit; (c) **add the override digest to `planKey`** (`floor-organizer.ts:102-116`), or two floors that differ only by an override will share one memoised `FloorLayout` and the edit will leak to both (or be silently dropped).

5. **Everything downstream is already deterministic and needs no change.** `rng.ts` is pure mulberry32, `CONTRACT.md:18` bans `Math.random` and `Date.now()` in geometry, the writer's GUID stream is seeded from `name:seed:ifc-guid`, `DETERMINISTIC_TIMESTAMP_MS` fixes the header, resource-cache ids are handed out in first-use order, and `SharedSets` uses `Map` insertion order. `writer.test.ts:489` and `:748` pin byte-identical output across runs in both compact and full mode. The one thing that *will* change on any override is the express-id numbering (and therefore GUIDs), so the app's `ifc.idMap` must be re-read after each run — which `main.ts` already does, since `state.ifc` is replaced wholesale and `loadedIfcFor` is reset to `null` (`main.ts:263`).

**For the rules UI (b) specifically**: the `Pattern` type is already the declarative-rule vocabulary you want — `/Users/samarvir/formaIFC/generator/src/core/types.ts:446-459`:
```ts
export interface Pattern { id; name; discipline: Discipline|'cross'; problem: string; solution: string;
  parameters: Record<string, PatternParameter>; dependsOn?: string[]; references?: string[] }
export interface PatternParameter { value: number|string|boolean; unit?: string; source?: string }  // 439-444
```
Patterns are registered in `PatternBook` (`core/patterns.ts:9-35`, with a collision guard and an "applied before registration" guard), already rendered and *searchable* in the Patterns tab (`patterns-view.ts:27-28` searches id/name/problem/solution/references/param keys), and every application is traced with concrete params (`PatternApplication`, `types.ts:461-469`). A "custom rules" UI is therefore best framed as **parameter overrides on existing patterns** (`rules: [{ patternId, params }]`) plus a small set of declarative constraints — which reuses the existing Patterns tab as the browse/edit surface, reuses `form.ts`'s `getPath`/`setPath`/`parseValue` for the editors, and gives you provenance (`PatternParameter.source`) for free. The parameters are currently hard-coded literals inside each discipline's `*_PATTERNS` array, so the work is threading a resolved-parameter lookup through `GenContext` rather than building new machinery.
