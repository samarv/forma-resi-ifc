/**
 * App shell: header, sidebar form, tabbed views, status bar.
 * Generation runs on the main thread behind a non-blocking spinner; every stage is
 * guarded so a failure shows in the status bar instead of blanking the page.
 */
import type { BuildingSpec, DesignModel, Discipline, StoreyDef } from '../core/types.ts';
import { normalizeSpec, PRESETS, type PartialSpec } from '../core/spec.ts';
import { asArray, backend, hasMock, mockRequested } from './backend.ts';
import { buildAxon } from './axon-svg.ts';
import { renderElements, findElement } from './elements-view.ts';
import { BUILD_BACKEND, BUILD_ID } from './env.ts';
import { buildReport, copyText, downloadText, readJsonFile, safeFileName, specFromLoaded } from './export.ts';
import { attachForm, renderForm } from './form.ts';
import { renderMetrics } from './metrics-view.ts';
import { renderPatterns } from './patterns-view.ts';
import { buildPlan, elementIndex, type Drawing, type Hit } from './plan-svg.ts';
import { buildSite } from './site-svg.ts';
import { DEFAULT_LAYERS, state, structuredCloneSafe, type Layers, type TabId } from './state.ts';
import { byId, debounce, delegate, esc, fmtBytes, fmtMs, humanize, nextFrame, q } from './util.ts';
import { IfcLiteEmbed, isFileProtocol, parseIdGuidMap } from './viewer-embed.ts';
import { Viewport } from './viewport.ts';

// ---------------------------------------------------------------------------
const TABS: [TabId, string][] = [
  ['plans', 'Plans'], ['viewer', '3D (ifc-lite)'], ['site', 'Site'],
  ['metrics', 'Metrics'], ['patterns', 'Patterns'], ['elements', 'Elements'],
];

const LAYER_CHIPS: [keyof Layers, string, string][] = [
  ['rooms', 'Rooms', 'var(--dwg-room-pub)'],
  ['arch', 'Architecture', 'var(--dwg-wall-ext)'],
  ['struct', 'Structure', 'var(--dwg-struct)'],
  ['mech', 'Mechanical', 'var(--dwg-mech)'],
  ['plumb', 'Plumbing', 'var(--dwg-plumb)'],
  ['elec', 'Electrical', 'var(--dwg-elec)'],
  ['furniture', 'Furniture', 'var(--dwg-wall-part)'],
  ['labels', 'Labels', 'var(--ink-3)'],
  ['grid', 'Grid', 'var(--dwg-grid)'],
];

const DISC_RGBA: Record<string, [number, number, number, number]> = {
  architecture: [0.78, 0.76, 0.72, 1], structure: [0.29, 0.23, 0.65, 1], mechanical: [0.16, 0.47, 0.84, 1],
  plumbing: [0.1, 0.69, 0.48, 1], electrical: [0.92, 0.41, 0.2, 1], site: [0.2, 0.55, 0.2, 1],
};

let planVp: Viewport | null = null;
let siteVp: Viewport | null = null;
let axonVp: Viewport | null = null;
let planDrawing: Drawing | null = null;
let siteDrawing: Drawing | null = null;
let embed: IfcLiteEmbed | null = null;
let embedState: 'none' | 'connecting' | 'ready' | 'failed' = 'none';
let embedMsg = '';
let embedLoading = false;
let loadedIfcFor: DesignModel | null = null;
let planBuildMs = 0;
let fitted = { plans: false, site: false, axon: false };
let queuedRun = false;
let lastSpecUsed: BuildingSpec | null = null;

// ---------------------------------------------------------------------------
export function boot(): void {
  try {
    document.body.dataset.backend = safeBackendKind();
    buildShell();
    wireHeader();
    renderForm(byId('sidebar'));
    attachForm(byId('sidebar'), {
      onChange: () => { scheduleRun(); },
      rerender: () => renderForm(byId('sidebar')),
    });
    renderStatus();
    void run(true);
  } catch (err) {
    fatal(err);
  }
}

function safeBackendKind(): string {
  try { return backend().kind; } catch { return 'none'; }
}

function fatal(err: unknown): void {
  const bar = document.getElementById('statusbar');
  const text = `Startup failed: ${errText(err)}`;
  if (bar) bar.innerHTML = `<span class="stat-err">${esc(text)}</span>`;
  else document.body.innerHTML = `<pre style="padding:16px;color:#d03b3b">${esc(text)}</pre>`;
  console.error(err);
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message || String(err);
  return String(err);
}

// ---------------------------------------------------------------------------
// shell
// ---------------------------------------------------------------------------
function buildShell(): void {
  const tabs = byId('tabs');
  tabs.innerHTML = TABS.map(([id, label]) =>
    `<button class="tab" type="button" role="tab" data-tab="${id}" aria-selected="${state.tab === id}">${esc(label)}<span class="tab-count" data-count="${id}"></span></button>`,
  ).join('');
  delegate(tabs, 'click', '[data-tab]', (el) => selectTab(el.getAttribute('data-tab') as TabId));

  byId('panels').innerHTML = `
<div class="panel" data-panel="plans">
  <div class="toolbar" id="tb-plans"></div>
  <div class="viewport-wrap">
    <div class="viewport" id="vp-plans"></div>
    <aside class="side-card" id="card-plans" hidden></aside>
  </div>
</div>
<div class="panel" data-panel="viewer">
  <div class="toolbar" id="tb-viewer"></div>
  <div class="viewer-host" id="viewer-host"></div>
  <div class="viewport-wrap" id="axon-wrap" hidden><div class="viewport" id="vp-axon"></div></div>
</div>
<div class="panel" data-panel="site">
  <div class="toolbar" id="tb-site"></div>
  <div class="viewport-wrap">
    <div class="viewport" id="vp-site"></div>
    <aside class="side-card" id="card-site" hidden></aside>
  </div>
</div>
<div class="panel" data-panel="metrics"><div class="panel-scroll" id="pane-metrics"></div></div>
<div class="panel" data-panel="patterns">
  <div class="toolbar" id="tb-patterns">
    <span class="toolbar-label">Search</span>
    <input class="search" type="text" id="pat-search" placeholder="problem, solution, parameter, reference…">
  </div>
  <div class="panel-scroll" id="pane-patterns"></div>
</div>
<div class="panel" data-panel="elements">
  <div class="toolbar" id="tb-elements">
    <span class="toolbar-label">Find element id</span>
    <input class="search" type="text" id="el-find" placeholder="ARC-L02-WALL-003">
    <button class="btn btn-sm" type="button" id="el-find-go">Show in plan</button>
    <span class="spacer"></span>
    <span class="toolbar-label" id="el-find-msg"></span>
  </div>
  <div class="panel-scroll" id="pane-elements"></div>
</div>`;

  // plans + site viewports
  planVp = new Viewport(byId('vp-plans'), {
    units: () => displayUnits(),
    streetFacing: () => state.model?.site?.streetFacing ?? 'S',
    onPick: (hit) => pinHit('plans', hit),
  });
  siteVp = new Viewport(byId('vp-site'), {
    units: () => displayUnits(),
    streetFacing: () => state.model?.site?.streetFacing ?? 'S',
    onPick: (hit) => pinHit('site', hit),
  });

  delegate(byId('panels'), 'click', '[data-eltype]', (el) => {
    const t = el.getAttribute('data-eltype');
    state.elementType = state.elementType === t ? null : t;
    renderTab('elements');
  });
  delegate(byId('panels'), 'click', '[data-find]', (el) => {
    jumpToElement(el.getAttribute('data-find') ?? '');
  });
  delegate(byId('panels'), 'click', '[data-close-card]', (el) => {
    const which = el.getAttribute('data-close-card')!;
    state.pinned = null;
    const card = document.getElementById(`card-${which}`);
    if (card) card.hidden = true;
  });

  const search = byId<HTMLInputElement>('pat-search');
  search.addEventListener('input', debounce(() => {
    state.patternQuery = search.value;
    renderTab('patterns');
  }, 180));

  const find = byId<HTMLInputElement>('el-find');
  byId('el-find-go').addEventListener('click', () => jumpToElement(find.value));
  find.addEventListener('keydown', (ev) => { if ((ev as KeyboardEvent).key === 'Enter') jumpToElement(find.value); });

  selectTab(state.tab);
}

function wireHeader(): void {
  byId('btn-generate').addEventListener('click', () => void run(true));
  byId('btn-ifc').addEventListener('click', () => {
    const { ifc, model } = state;
    if (!ifc || !model) { flashStatus('No IFC available — generate first.'); return; }
    downloadText(`${safeFileName(model.spec.name)}.ifc`, 'application/x-step', ifc.content);
  });
  byId('btn-report').addEventListener('click', () => {
    const { model, ifc } = state;
    if (!model) { flashStatus('Nothing to report — generate first.'); return; }
    downloadText(`${safeFileName(model.spec.name)}-report.json`, 'application/json',
      JSON.stringify(buildReport(model, ifc, safeBackendKind()), null, 2));
  });
  byId('btn-copy').addEventListener('click', async () => {
    const ok = await copyText(JSON.stringify(state.spec, null, 2));
    flashStatus(ok ? 'Spec JSON copied to the clipboard.' : 'Copy failed — select the JSON in the sidebar instead.');
  });
  const file = byId<HTMLInputElement>('file-spec');
  byId('btn-load').addEventListener('click', () => file.click());
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (!f) return;
    try {
      const data = await readJsonFile(f);
      const spec = specFromLoaded(data) as PartialSpec;
      normalizeSpec(spec); // validate before adopting
      state.spec = structuredCloneSafe(spec);
      state.presetId = '__custom';
      renderForm(byId('sidebar'));
      await run(true);
      flashStatus(`Loaded spec from ${f.name}`);
    } catch (err) {
      state.error = `Spec load failed: ${errText(err)}`;
      renderStatus();
    } finally {
      file.value = '';
    }
  });
}

// ---------------------------------------------------------------------------
// generation
// ---------------------------------------------------------------------------
const scheduleRun = debounce(() => void run(false), 400);

async function run(force: boolean): Promise<void> {
  if (state.busy) { queuedRun = true; return; }
  state.busy = true;
  showSpinner('Generating…');
  await nextFrame();
  const t0 = performance.now();
  try {
    const b = backend();
    let full: BuildingSpec;
    try {
      full = normalizeSpec(state.spec);
    } catch (err) {
      throw new Error(`Spec is invalid: ${errText(err)}`);
    }
    lastSpecUsed = full;
    const model = b.generateBuilding(full);
    if (!model || !Array.isArray(model.elements)) throw new Error('Generator returned no model');
    state.model = model;
    state.error = null;
    state.genMs = performance.now() - t0;

    try {
      state.ifc = b.writeIfc(model);
      state.ifcError = null;
    } catch (err) {
      state.ifc = null;
      state.ifcError = errText(err);
    }

    if (!model.storeys?.some((s) => s.id === state.storey)) state.storey = defaultStorey(model);
    state.pinned = null;
    state.highlight = null;
    fitted = { plans: true, site: true, axon: true };
    loadedIfcFor = null;
    void force;
  } catch (err) {
    state.error = errText(err);
    state.model = null;
    state.ifc = null;
    console.error(err);
  } finally {
    state.busy = false;
    hideSpinner();
  }
  renderSubtitle();
  renderStatus();
  renderTab(state.tab);
  if (queuedRun) { queuedRun = false; void run(false); }
}

function defaultStorey(model: DesignModel): string {
  const above = model.storeys.filter((s) => s.index >= 0 && s.index < 100);
  return (above[0] ?? model.storeys[0])?.id ?? 'L01';
}

function displayUnits(): 'metric' | 'imperial' {
  return state.model?.spec.displayUnits ?? lastSpecUsed?.displayUnits
    ?? (state.spec.displayUnits ?? (state.spec.region === 'US' || !state.spec.region ? 'imperial' : 'metric'));
}

// ---------------------------------------------------------------------------
// tabs
// ---------------------------------------------------------------------------
function selectTab(tab: TabId): void {
  state.tab = tab;
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('.tab'))) {
    el.setAttribute('aria-selected', String(el.getAttribute('data-tab') === tab));
  }
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('.panel'))) {
    el.classList.toggle('is-active', el.getAttribute('data-panel') === tab);
  }
  renderTab(tab);
}

function renderTab(tab: TabId): void {
  updateTabCounts();
  try {
    if (tab === 'plans') renderPlans();
    else if (tab === 'viewer') renderViewer();
    else if (tab === 'site') renderSitePanel();
    else if (tab === 'metrics') {
      const m = state.model;
      byId('pane-metrics').innerHTML = '';
      if (m) renderMetrics(byId('pane-metrics'), m, asArray(backend().metrics), displayUnits());
      else byId('pane-metrics').innerHTML = emptyMsg();
    } else if (tab === 'patterns') {
      const m = state.model;
      if (m) renderPatterns(byId('pane-patterns'), m, state.patternQuery);
      else byId('pane-patterns').innerHTML = emptyMsg();
    } else if (tab === 'elements') {
      const m = state.model;
      if (m) renderElements(byId('pane-elements'), m, state.elementType, state.highlight);
      else byId('pane-elements').innerHTML = emptyMsg();
    }
  } catch (err) {
    state.error = `${humanize(tab)} view failed: ${errText(err)}`;
    renderStatus();
    console.error(err);
  }
}

function emptyMsg(): string {
  return `<p class="empty">${state.error ? esc(state.error) : 'Nothing generated yet — press Generate.'}</p>`;
}

function updateTabCounts(): void {
  const m = state.model;
  const set = (tab: string, s: string) => {
    const el = document.querySelector(`[data-count="${tab}"]`);
    if (el) el.textContent = s;
  };
  set('plans', m ? String(m.storeys.length) : '');
  set('metrics', m ? String(m.metrics.length) : '');
  set('patterns', m ? String(m.patterns?.book?.length ?? 0) : '');
  set('elements', m ? String(m.elements.length) : '');
  set('site', '');
  set('viewer', state.ifc ? fmtBytes(state.ifc.fileSize) : '');
}

// ---------------------------------------------------------------------------
// plans
// ---------------------------------------------------------------------------
function renderPlans(): void {
  const m = state.model;
  const tb = byId('tb-plans');
  if (!m) {
    tb.innerHTML = `<span class="toolbar-label">${state.error ? 'Generation failed' : 'No model'}</span>`;
    planVp?.clear();
    return;
  }
  const storeys = [...m.storeys].sort((a, b) => a.index - b.index);
  tb.innerHTML = `
    <span class="toolbar-label">Storey</span>
    <span class="chips">${storeys.map((s) => chip(s.id, s.id === state.storey, storeyChipLabel(s), '')).join('')}</span>
    <span class="spacer"></span>
    <span class="chips">${LAYER_CHIPS.map(([k, label, color]) =>
      `<button class="chip" type="button" data-layer="${k}" aria-pressed="${state.layers[k]}"><span class="chip-dot" style="background:${color}"></span>${esc(label)}</button>`).join('')}</span>
    <button class="btn btn-sm" type="button" data-act="fit-plan">Fit</button>
    <span class="toolbar-label" id="plan-stats"></span>`;

  delegateOnce(tb, 'plans', () => {
    delegate(tb, 'click', '[data-chip]', (el) => {
      state.storey = el.getAttribute('data-chip')!;
      state.pinned = null;
      state.highlight = null;
      fitted.plans = true;
      const card = document.getElementById('card-plans');
      if (card) card.hidden = true;
      renderPlans();
    });
    delegate(tb, 'click', '[data-layer]', (el) => {
      const k = el.getAttribute('data-layer') as keyof Layers;
      state.layers[k] = !state.layers[k];
      renderPlans();
    });
    delegate(tb, 'click', '[data-act="fit-plan"]', () => planVp?.fit());
  });

  const t0 = performance.now();
  planDrawing = buildPlan(m, state.storey, state.layers, displayUnits(), state.highlight);
  planBuildMs = performance.now() - t0;
  planVp!.setDrawing(planDrawing, fitted.plans);
  fitted.plans = false;

  const stats = document.getElementById('plan-stats');
  if (stats) {
    const c = planDrawing.counts;
    const summary = Object.entries(c).filter(([, v]) => v > 0).map(([k, v]) => `${v} ${k}`).join(' · ');
    stats.textContent = `${summary || 'empty storey'} — drawn in ${planBuildMs.toFixed(1)} ms`;
  }
  if (state.highlight) {
    const hit = planDrawing.hits.find((h) => h.id === state.highlight);
    if (hit) {
      planVp!.centerOn({ x: hit.x0, y: hit.y0, w: hit.x1 - hit.x0, h: hit.y1 - hit.y0 });
      pinHit('plans', hit);
    }
  }
}

function storeyChipLabel(s: StoreyDef): string {
  return `${s.id}${s.index >= 0 && s.index < 100 ? '' : ` · ${s.name}`}`;
}

function chip(id: string, on: boolean, label: string, dot: string): string {
  return `<button class="chip" type="button" data-chip="${esc(id)}" aria-pressed="${on}">${dot}${esc(label)}</button>`;
}

const wired = new Set<string>();
function delegateOnce(_root: HTMLElement, key: string, fn: () => void): void {
  if (wired.has(key)) return;
  wired.add(key);
  fn();
}

function pinHit(which: 'plans' | 'site', hit: Hit | null): void {
  const card = document.getElementById(`card-${which}`);
  if (!card) return;
  if (!hit) {
    state.pinned = null;
    card.hidden = true;
    return;
  }
  state.pinned = hit.id;
  const el = state.model ? elementIndex(state.model).get(hit.id) : undefined;
  card.hidden = false;
  card.innerHTML = `
    <button class="btn btn-sm side-card-close" type="button" data-close-card="${which}">✕</button>
    <h4>${esc(hit.label)}</h4>
    <div class="mono" style="color:var(--ink-3)">${esc(hit.id)}</div>
    <dl>${hit.meta.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
    ${el?.psets?.length ? `<h4 style="margin-top:9px">Property sets</h4>${el.psets.map((ps) => `
      <div class="mono" style="color:var(--ink-3);margin-top:4px">${esc(ps.name)}</div>
      <dl>${ps.properties.map((p) => `<dt>${esc(p.name)}</dt><dd>${esc(String(p.value))}</dd>`).join('')}</dl>`).join('')}` : ''}
    ${el?.quantities?.length ? `<h4 style="margin-top:9px">Quantities</h4>${el.quantities.map((qs) => `
      <dl>${qs.quantities.map((qq) => `<dt>${esc(qq.name)}</dt><dd>${qq.value.toFixed(2)}</dd>`).join('')}</dl>`).join('')}` : ''}
    ${el ? `<p class="hint" style="margin-top:8px">Discipline ${esc(el.discipline)} · storey ${esc(el.storey)} · geometry ${esc(el.geometry.kind)}</p>` : ''}`;
}

function jumpToElement(raw: string): void {
  const msg = document.getElementById('el-find-msg');
  const m = state.model;
  if (!m) return;
  const el = findElement(m, raw);
  if (!el) {
    if (msg) msg.textContent = `No element matching “${raw}”`;
    return;
  }
  if (msg) msg.textContent = `${el.id} on ${el.storey}`;
  state.highlight = el.id;
  state.storey = el.storey;
  fitted.plans = false;
  selectTab('plans');
}

// ---------------------------------------------------------------------------
// site
// ---------------------------------------------------------------------------
function renderSitePanel(): void {
  const m = state.model;
  const tb = byId('tb-site');
  if (!m) {
    tb.innerHTML = `<span class="toolbar-label">${state.error ? 'Generation failed' : 'No model'}</span>`;
    siteVp?.clear();
    return;
  }
  const metric = (id: string) => m.metrics.find((x) => x.id === id);
  const defs = new Map(asArray(backend().metrics).map((d) => [String(d.id), d]));
  const badges: string[] = [];
  for (const id of ['far', 'site-coverage', 'density-dph', 'parking-ratio', 'open-space-per-unit']) {
    const r = metric(id);
    if (!r) continue;
    const label = defs.get(id)?.name ?? humanize(id);
    badges.push(`<span class="badge">${esc(label)} <b>${esc(r.display || String(r.value))}</b></span>`);
  }
  tb.innerHTML = `<span class="toolbar-label">Site plan</span>
    ${badges.join(' ')}
    <span class="spacer"></span>
    <span class="legend">
      <span><i style="background:var(--dwg-site)"></i>landscape</span>
      <span><i style="background:var(--accent)"></i>envelope / corridor spine</span>
      <span><i style="background:var(--dwg-wall-ext)"></i>footprint</span>
      <span><i style="background:var(--s3)"></i>EV stall</span>
    </span>
    <button class="btn btn-sm" type="button" data-act="fit-site">Fit</button>`;
  delegateOnce(tb, 'site', () => {
    delegate(tb, 'click', '[data-act="fit-site"]', () => siteVp?.fit());
  });
  siteDrawing = buildSite(m, displayUnits(), state.pinned);
  siteVp!.setDrawing(siteDrawing, fitted.site);
  fitted.site = false;
}

// ---------------------------------------------------------------------------
// 3D
// ---------------------------------------------------------------------------
function renderViewer(): void {
  const tb = byId('tb-viewer');
  const host = byId('viewer-host');
  const axonWrap = byId('axon-wrap');
  const m = state.model;

  tb.innerHTML = `
    <button class="btn btn-sm" type="button" data-act="v-load"${state.ifc ? '' : ' disabled'}>Load in viewer</button>
    <button class="btn btn-sm" type="button" data-act="v-fit">Fit</button>
    <span class="toolbar-label">Isolate</span>
    <select id="v-isolate" style="width:130px">
      <option value="">All disciplines</option>
      ${(['architecture', 'structure', 'mechanical', 'plumbing', 'electrical', 'site'] as Discipline[])
      .map((d) => `<option value="${d}">${humanize(d)}</option>`).join('')}
    </select>
    <button class="btn btn-sm" type="button" data-act="v-colors">Colour by discipline</button>
    <span class="spacer"></span>
    ${safeBackendKind() === 'mock' ? `<span class="badge badge-mock">mock IFC carries no geometry — use Axon</span>` : ''}
    <button class="chip" type="button" data-act="v-axon" aria-pressed="${state.axonMode}">Axon (offline)</button>
    <span class="toolbar-label" id="v-stats"></span>`;

  delegateOnce(tb, 'viewer', () => {
    delegate(tb, 'click', '[data-act]', (el) => {
      const act = el.getAttribute('data-act');
      if (act === 'v-axon') { state.axonMode = !state.axonMode; fitted.axon = true; renderViewer(); }
      else if (act === 'v-load') { void connectViewer(true); }
      else if (act === 'v-fit') { if (state.axonMode) axonVp?.fit(); else void embed?.fitToView(); }
      else if (act === 'v-colors') { void colourByDiscipline(); }
    });
    delegate(tb, 'change', '#v-isolate', (el) => { void isolateDiscipline((el as HTMLSelectElement).value as Discipline | ''); });
  });

  if (state.axonMode) {
    host.hidden = true;
    axonWrap.hidden = false;
    if (!axonVp) {
      axonVp = new Viewport(byId('vp-axon'), {
        units: () => displayUnits(),
        streetFacing: () => state.model?.site?.streetFacing ?? 'S',
        showOverlay: false,
        onPick: () => { /* axon is read-only */ },
      });
    }
    if (m) {
      const t0 = performance.now();
      const d = buildAxon(m);
      axonVp.setDrawing(d, fitted.axon);
      fitted.axon = false;
      const stats = document.getElementById('v-stats');
      if (stats) stats.textContent = `axon: ${d.counts.drawn} of ${d.counts.total} solids in ${(performance.now() - t0).toFixed(0)} ms`;
    } else {
      axonVp.clear();
    }
    return;
  }

  axonWrap.hidden = true;
  host.hidden = false;
  if (embedState === 'none') void connectViewer(false);
  else if (embedState === 'ready') void pushModelToViewer(false);
  else paintViewerMessage();
}

async function connectViewer(userInitiated: boolean): Promise<void> {
  const host = byId('viewer-host');
  if (isFileProtocol() && !userInitiated) {
    embedState = 'failed';
    embedMsg = 'The embedded viewer cannot load from a file:// page (the iframe is cross-origin). Serve this file over http, or use the offline axonometric view.';
    paintViewerMessage();
    return;
  }
  if (!embed) {
    embedState = 'connecting';
    embedMsg = 'Connecting to embed.ifclite.com…';
    paintViewerMessage();
    try {
      embed = new IfcLiteEmbed({
        container: host,
        theme: prefersDark() ? 'dark' : 'light',
        timeoutMs: 12000,
      });
      embed.on('model-loaded', (d) => {
        const s = d as { entities?: number; triangles?: number };
        const stats = document.getElementById('v-stats');
        if (stats) stats.textContent = `viewer: ${(s.entities ?? 0).toLocaleString('en-US')} entities · ${(s.triangles ?? 0).toLocaleString('en-US')} triangles`;
      });
      embed.on('model-error', (d) => {
        const e = d as { error?: { message?: string } };
        state.error = `Viewer could not parse the IFC: ${e.error?.message ?? 'unknown error'}`;
        renderStatus();
      });
      await embed.ready;
      embedState = 'ready';
      paintViewerMessage();
    } catch (err) {
      embedState = 'failed';
      embedMsg = errText(err);
      embed?.destroy();
      embed = null;
      paintViewerMessage();
      return;
    }
  }
  await pushModelToViewer(userInitiated);
}

/** Above this, streaming + parsing takes long enough that it must be user-initiated. */
const AUTO_LOAD_LIMIT = 24 * 1024 * 1024;

async function pushModelToViewer(userInitiated = false): Promise<void> {
  const { ifc, model } = state;
  if (!embed || embedState !== 'ready' || !ifc || !model) { paintViewerMessage(); return; }
  if (loadedIfcFor === model || embedLoading) { paintViewerMessage(); return; }
  if (!userInitiated && ifc.fileSize > AUTO_LOAD_LIMIT) { paintViewerMessage(); return; }
  try {
    embedLoading = true;
    paintViewerMessage();
    const buf = new TextEncoder().encode(ifc.content).buffer;
    const stats = await embed.loadModelBuffer(buf as ArrayBuffer);
    loadedIfcFor = model;
    const el = document.getElementById('v-stats');
    if (el) {
      el.textContent = `viewer: ${(stats?.entities ?? 0).toLocaleString('en-US')} entities · ${(stats?.triangles ?? 0).toLocaleString('en-US')} triangles`
        + (stats && stats.triangles === 0 ? ' — no geometry in this IFC' : '');
    }
    embedLoading = false;
    paintViewerMessage();
    // the viewer keeps its previous camera, so frame the new model
    try { await embed.fitToView(); } catch { /* non-fatal */ }
  } catch (err) {
    embedLoading = false;
    embedMsg = `Model load failed: ${errText(err)}`;
    paintViewerMessage();
  }
}

function paintViewerMessage(): void {
  const host = byId('viewer-host');
  const old = host.querySelector('.viewer-msg');
  if (old) old.remove();
  if (embedState === 'ready' && loadedIfcFor === state.model) return;
  const div = document.createElement('div');
  div.className = 'viewer-msg';
  if (embedLoading) {
    div.innerHTML = `<div class="spinner"></div>
      <p>Streaming ${fmtBytes(state.ifc?.fileSize ?? 0)} of IFC (${(state.ifc?.entityCount ?? 0).toLocaleString('en-US')} entities) into the viewer…</p>
      <p>Large models can take a while to parse. The offline axonometric view is instant.</p>`;
  } else if (embedState === 'connecting') {
    div.innerHTML = `<div class="spinner"></div><p>${esc(embedMsg)}</p>`;
  } else if (embedState === 'failed') {
    div.innerHTML = `<h3>3D viewer unavailable</h3>
      <p>${esc(embedMsg)}</p>
      <p>Download the IFC and open it at <span class="mono">ifclite.com</span>, or switch to the offline axonometric view.</p>
      <p>
        <button class="btn" type="button" data-act="v-dl">Download IFC</button>
        <button class="btn" type="button" data-act="v-axon2">Axon (offline)</button>
        <button class="btn" type="button" data-act="v-retry">Retry</button>
      </p>`;
  } else if (!state.ifc) {
    div.innerHTML = `<h3>No IFC yet</h3><p>${esc(state.ifcError ?? 'Generate a building first.')}</p>`;
  } else {
    div.innerHTML = `<h3>Ready</h3><p>Press “Load in viewer” to stream ${fmtBytes(state.ifc.fileSize)} of IFC into the embedded ifc-lite viewer.</p>`;
  }
  host.appendChild(div);
  delegate(div, 'click', '[data-act]', (el) => {
    const a = el.getAttribute('data-act');
    if (a === 'v-dl') byId('btn-ifc').click();
    else if (a === 'v-axon2') { state.axonMode = true; fitted.axon = true; renderViewer(); }
    else if (a === 'v-retry') { embedState = 'none'; embed?.destroy(); embed = null; void connectViewer(true); }
  });
}

function prefersDark(): boolean {
  try { return window.matchMedia('(prefers-color-scheme: dark)').matches; } catch { return false; }
}

function expressIdsFor(pred: (d: string) => boolean): number[] {
  const { ifc, model } = state;
  if (!ifc || !model) return [];
  const ids: number[] = [];
  for (const el of model.elements) {
    if (!pred(el.discipline)) continue;
    const n = ifc.idMap?.[el.id];
    if (typeof n === 'number') ids.push(n);
  }
  return ids;
}

async function isolateDiscipline(d: Discipline | ''): Promise<void> {
  if (!embed || embedState !== 'ready') return;
  try {
    if (!d) { await embed.showAll(); return; }
    const ids = expressIdsFor((x) => x === d);
    if (!ids.length) {
      // Fall back to GUIDs parsed out of the STEP text when there is no idMap.
      const guids = guidsFor((x) => x === d);
      if (guids.length) {
        const res = await embed.selectByGuid(guids);
        if (res.resolved?.length) await embed.isolate(res.resolved);
        return;
      }
      flashStatus(`No IFC ids mapped for ${d}.`);
      return;
    }
    await embed.isolate(ids);
  } catch (err) {
    flashStatus(`Isolate failed: ${errText(err)}`);
  }
}

function guidsFor(pred: (d: string) => boolean): string[] {
  const { ifc, model } = state;
  if (!ifc || !model) return [];
  const map = parseIdGuidMap(ifc.content);
  const out: string[] = [];
  for (const el of model.elements) {
    if (!pred(el.discipline)) continue;
    const n = ifc.idMap?.[el.id];
    const g = typeof n === 'number' ? map.get(n) : undefined;
    if (g) out.push(g);
  }
  return out;
}

async function colourByDiscipline(): Promise<void> {
  if (!embed || embedState !== 'ready') return;
  const { ifc, model } = state;
  if (!ifc || !model) return;
  const colorMap: Record<number, [number, number, number, number]> = {};
  for (const el of model.elements) {
    const n = ifc.idMap?.[el.id];
    if (typeof n !== 'number') continue;
    colorMap[n] = DISC_RGBA[el.discipline] ?? [0.7, 0.7, 0.7, 1];
  }
  if (!Object.keys(colorMap).length) { flashStatus('No idMap from the IFC writer — cannot colour by discipline.'); return; }
  try { await embed.setColors(colorMap); } catch (err) { flashStatus(`Colouring failed: ${errText(err)}`); }
}

// ---------------------------------------------------------------------------
// header + status
// ---------------------------------------------------------------------------
function renderSubtitle(): void {
  const m = state.model;
  const sub = byId('subtitle');
  if (!m) {
    sub.textContent = 'No model generated yet';
    return;
  }
  const t = m.typology;
  const alt = t.regionalNames?.[m.spec.region];
  const above = m.storeys.filter((s) => s.index >= 0 && s.index < 100).length;
  const units = m.arch?.units?.length ?? 0;
  sub.innerHTML = `${esc(m.spec.name)} — ${esc(alt && alt !== t.name ? `${t.name} (${alt})` : t.name)}
    · ${above} storeys · ${units} dwellings · ${esc(m.spec.region)} · ${esc(m.spec.displayUnits)}`;
}

let flashTimer = 0;
function flashStatus(msg: string): void {
  const bar = byId('statusbar');
  let el = bar.querySelector('.stat-flash') as HTMLElement | null;
  if (!el) {
    el = document.createElement('span');
    el.className = 'stat stat-flash';
    bar.appendChild(el);
  }
  el.textContent = msg;
  clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => { el?.remove(); }, 4000);
}

function renderStatus(): void {
  const bar = byId('statusbar');
  const m = state.model;
  const warnings = m?.warnings ?? [];
  const kind = safeBackendKind();
  const parts: string[] = [];
  parts.push(`<span class="stat">Elements <b>${m ? m.elements.length.toLocaleString('en-US') : '—'}</b></span>`);
  parts.push(`<span class="stat">IFC entities <b>${state.ifc ? state.ifc.entityCount.toLocaleString('en-US') : '—'}</b></span>`);
  parts.push(`<span class="stat">File <b>${state.ifc ? fmtBytes(state.ifc.fileSize) : '—'}</b></span>`);
  parts.push(`<span class="stat">Generated in <b>${m ? fmtMs(state.genMs) : '—'}</b></span>`);
  if (m && state.genMs > 3000) {
    parts.push(`<span class="stat tile-status st-warn">▲ slow — try detail “low” or fewer storeys</span>`);
  }
  if (warnings.length) {
    parts.push(`<button class="warn-btn" type="button" id="warn-toggle">▲ ${warnings.length} warning${warnings.length === 1 ? '' : 's'}</button>`);
  }
  if (state.ifcError) parts.push(`<span class="stat-err" title="${esc(state.ifcError)}">IFC writer: ${esc(state.ifcError)}</span>`);
  if (state.error) parts.push(`<span class="stat-err" title="${esc(state.error)}">${esc(state.error)}</span>`);
  parts.push(`<span class="spacer"></span>`);
  if (kind === 'mock') {
    parts.push(`<span class="badge badge-mock" title="${BUILD_BACKEND === 'mock' ? 'This build has no real generator bundled' : 'Forced with ?mock=1'}">mock generator</span>`);
  } else if (hasMock() && !mockRequested()) {
    parts.push(`<span class="badge">real generator</span>`);
  }
  parts.push(`<span class="badge" title="build ${esc(BUILD_ID)}">${esc(BUILD_BACKEND)} · ${esc(BUILD_ID)}</span>`);
  bar.innerHTML = parts.join('');

  const toggle = document.getElementById('warn-toggle');
  toggle?.addEventListener('click', () => {
    const existing = document.getElementById('warn-pop');
    if (existing) { existing.remove(); return; }
    const pop = document.createElement('div');
    pop.className = 'warn-pop';
    pop.id = 'warn-pop';
    pop.innerHTML = `<b>${warnings.length} warning${warnings.length === 1 ? '' : 's'}</b>
      <ol>${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ol>`;
    document.body.appendChild(pop);
    setTimeout(() => {
      const off = (ev: MouseEvent) => {
        if (!pop.contains(ev.target as Node)) { pop.remove(); document.removeEventListener('click', off); }
      };
      document.addEventListener('click', off);
    }, 0);
  });
  updateTabCounts();
}

function showSpinner(msg: string): void {
  const s = byId('spinner');
  byId('spinner-msg').textContent = msg;
  s.hidden = false;
}
function hideSpinner(): void {
  byId('spinner').hidden = true;
}

// keep the presets list reachable for console debugging
Object.assign(globalThis as Record<string, unknown>, {
  __forma: {
    state,
    presets: PRESETS,
    run: () => run(true),
    get plan() { return planDrawing; },
    get site() { return siteDrawing; },
    get viewer() { return { embedState, embedMsg, loaded: loadedIfcFor === state.model }; },
    layers: DEFAULT_LAYERS,
    q,
  },
});
