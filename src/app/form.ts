/**
 * The specification form (left sidebar). Bound to `state.spec` (a PartialSpec);
 * every edit writes through `setPath` and asks main.ts for a debounced regeneration.
 *
 * Numeric length fields are shown in the current display units and stored in metres.
 */
import type {
  AccessType, BuildingSpec, Compass, FloorSpec, FootprintShape, FloorUse, Region, TypologyDef,
  TypologyId, UnitTemplateDef, UnitTemplateId,
} from '../core/types.ts';
import { PRESETS, UNIT_TEMPLATE_IDS, normalizeSpec, resolveStoreys, type PartialSpec } from '../core/spec.ts';
import { TYPOLOGIES } from '../core/typologies.ts';
import { backend } from './backend.ts';
import { state, structuredCloneSafe } from './state.ts';
import { areaIn, clamp, delegate, esc, humanize, lenIn, lenOut, lenUnit, areaUnit } from './util.ts';

// ---------------------------------------------------------------- path utils
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const k of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

export function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  const last = keys[keys.length - 1];
  if (value === undefined) delete cur[last];
  else cur[last] = value;
}

/** Parse a form control's value into the spec's representation (metres for 'len'). */
export function parseValue(kind: string, raw: string, units: 'metric' | 'imperial'): unknown {
  if (kind === 'bool') return raw === 'true';
  if (raw === '') return undefined;
  if (kind === 'len') {
    const v = Number(raw);
    return Number.isFinite(v) ? Math.round(lenOut(v, units) * 1000) / 1000 : undefined;
  }
  if (kind === 'num') {
    const v = Number(raw);
    return Number.isFinite(v) ? v : undefined;
  }
  if (kind === 'int') {
    const v = Math.round(Number(raw));
    return Number.isFinite(v) ? v : undefined;
  }
  return raw;
}

// ------------------------------------------------------------------ controls
interface NumOpts { suffix?: string; step?: number; min?: number; max?: number; structural?: boolean; kind?: 'len' | 'num' | 'int'; dec?: number; }

function numRow(label: string, path: string, valueM: number | undefined, o: NumOpts = {}): string {
  const kind = o.kind ?? 'len';
  const units = displayUnits();
  const shown = valueM === undefined ? '' : kind === 'len' ? lenIn(valueM, units, o.dec ?? 2) : valueM;
  const suffix = o.suffix ?? (kind === 'len' ? lenUnit(units) : '');
  return `<div class="row"><label for="f-${cssId(path)}">${esc(label)}</label>
<div class="suffix"><input id="f-${cssId(path)}" type="number" data-p="${path}" data-t="${kind}"${o.structural ? ' data-s="1"' : ''}
 value="${shown}"${o.step !== undefined ? ` step="${o.step}"` : ''}${o.min !== undefined ? ` min="${o.min}"` : ''}${o.max !== undefined ? ` max="${o.max}"` : ''}>
${suffix ? `<span>${esc(suffix)}</span>` : ''}</div></div>`;
}

function selRow(label: string, path: string, value: string, opts: [string, string][], structural = false, groups?: [string, [string, string][]][]): string {
  const body = groups
    ? groups.map(([g, items]) => `<optgroup label="${esc(g)}">${items.map(([v, l]) => option(v, l, value)).join('')}</optgroup>`).join('')
    : opts.map(([v, l]) => option(v, l, value)).join('');
  return `<div class="row"><label for="f-${cssId(path)}">${esc(label)}</label>
<select id="f-${cssId(path)}" data-p="${path}" data-t="str"${structural ? ' data-s="1"' : ''}>${body}</select></div>`;
}

function option(v: string, l: string, cur: string): string {
  return `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(l)}</option>`;
}

function chk(label: string, path: string, value: boolean, structural = false): string {
  return `<label class="toggle"><input type="checkbox" data-p="${path}" data-t="bool"${structural ? ' data-s="1"' : ''}${value ? ' checked' : ''}>${esc(label)}</label>`;
}

function cssId(p: string): string { return p.replace(/[^a-zA-Z0-9]/g, '-'); }

function displayUnits(): 'metric' | 'imperial' {
  return (state.spec.displayUnits ?? (state.spec.region === 'US' || !state.spec.region ? 'imperial' : 'metric'));
}

// -------------------------------------------------------------------- render
const REGIONS: Region[] = ['US', 'UK', 'CA', 'AU', 'NZ', 'IE'];
const COMPASS: Compass[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const ACCESS_LABEL: Record<AccessType, string> = {
  direct: 'Own front door',
  'stair-core': 'Stair core (no corridor)',
  'corridor-double': 'Double-loaded corridor',
  'corridor-single': 'Single-loaded corridor',
  gallery: 'Gallery / deck access',
  'point-core': 'Point core',
  cluster: 'Cluster / co-living',
};
const FLOOR_USES: FloorUse[] = ['residential', 'lobby-residential', 'retail', 'parking', 'amenity', 'mechanical', 'roof', 'basement'];

export function renderForm(root: HTMLElement): void {
  // Remember what the user had open/scrolled — this runs on every structural edit.
  const openState = new Map<string, boolean>();
  for (const d of Array.from(root.querySelectorAll<HTMLDetailsElement>('details.sec'))) {
    openState.set(sectionKey(d.querySelector('summary')?.textContent ?? ''), d.open);
  }
  const scrollTop = root.scrollTop;
  const spec = state.spec;
  let resolved: BuildingSpec;
  try {
    resolved = normalizeSpec(spec);
  } catch (err) {
    root.innerHTML = `<p class="hint hint-warn">Spec could not be normalised: ${esc(String(err))}</p>`;
    return;
  }
  const t = TYPOLOGIES[resolved.typology];
  const units = resolved.displayUnits;
  const parts: string[] = [];

  // ---- 1. project
  parts.push(section('Project', true, [
    `<div class="row"><label for="f-preset">Preset</label><select id="f-preset" data-preset="1">
      ${PRESETS.map((p) => option(p.id, p.label, state.presetId)).join('')}
      <option value="__custom"${state.presetId === '__custom' ? ' selected' : ''}>Custom…</option>
    </select></div>`,
    `<div class="row"><label for="f-name">Name</label><input id="f-name" type="text" data-p="name" data-t="str" value="${esc(resolved.name)}"></div>`,
    `<div class="row"><label for="f-seed">Seed</label><div class="suffix">
      <input id="f-seed" type="number" data-p="seed" data-t="int" value="${resolved.seed}" step="1" min="0">
      <button class="btn btn-icon" data-act="dice" title="Random seed" type="button">⚄</button></div></div>`,
    selRow('Region', 'region', resolved.region, REGIONS.map((r) => [r, regionLabel(r)]), true),
    `<div class="row"><label>Display units</label><div class="seg">
      <button type="button" data-units="metric" aria-pressed="${units === 'metric'}">Metric</button>
      <button type="button" data-units="imperial" aria-pressed="${units === 'imperial'}">Imperial</button>
    </div></div>`,
    `<p class="hint">Model is always metric; only the display converts.</p>`,
  ]));

  // ---- 2. typology
  const groups = new Map<AccessType, [string, string][]>();
  for (const ty of Object.values(TYPOLOGIES)) {
    const arr = groups.get(ty.access) ?? [];
    arr.push([ty.id, typologyLabel(ty, resolved.region)]);
    groups.set(ty.access, arr);
  }
  // v2: the storey band is enforced, not reported. The slider and the number input take their
  // min/max from the typology, so the band is unreachable unless the user ticks the override —
  // which `normalizeSpec` honours and records as a deviation (with the 'high-rise' rule profile).
  const band = resolveStoreys(spec.massing, t);
  const storeys = resolved.massing.storeys;
  const override = resolved.massing.allowStoreyOverride === true;
  const lo = override ? 1 : band.min;
  const hi = override ? 60 : band.max;
  parts.push(section('Typology & height', true, [
    selRow('Typology', 'typology', resolved.typology, [], true,
      [...groups.entries()].map(([a, items]) => [ACCESS_LABEL[a], items] as [string, [string, string][]])),
    `<p class="desc">${esc(t.description)}</p>`,
    `<div class="row-wide"><label for="f-storeys">Storeys above grade</label><div class="slider-row">
      <input id="f-storeys" type="range" data-p="massing.storeys" data-t="int" min="${lo}" max="${hi}" step="1" value="${clamp(storeys, lo, hi)}" data-s="1">
      <input type="number" data-p="massing.storeys" data-t="int" min="${lo}" max="${hi}" step="1" value="${storeys}" data-s="1">
    </div>
    ${chk('Allow storeys outside the typology band', 'massing.allowStoreyOverride', override, true)}
    <p class="hint${band.clamped || band.override ? ' hint-warn' : ''}">
      Typology range ${band.min}–${band.max} (default ${t.storeys.default}).
      ${band.clamped ? ` ${band.requested} storeys clamped to ${storeys}; tick the box above to build it anyway.` : ''}
      ${band.override ? ' Outside the typical range: recorded as a deviation and generated with the high-rise rule profile.' : ''}
    </p></div>`,
  ]));

  // ---- 3. site
  const sb = resolved.site.setbacks ?? {};
  const pk = resolved.site.parking ?? {};
  parts.push(section('Site', true, [
    numRow('Street frontage (width)', 'site.width', resolved.site.width, { step: 0.5, min: 4 }),
    numRow('Depth from street', 'site.depth', resolved.site.depth, { step: 0.5, min: 4 }),
    selRow('Street faces', 'site.streetFacing', resolved.site.streetFacing, COMPASS.map((c) => [c, compassLabel(c)])),
    selRow('Context', 'site.context', resolved.site.context, [['urban', 'Urban'], ['suburban', 'Suburban'], ['rural', 'Rural']]),
    numRow('Slope', 'site.slopePercent', resolved.site.slopePercent, { kind: 'num', suffix: '%', step: 0.5, min: 0, max: 30 }),
    `<p class="hint">Setback overrides (blank = typology default ${t.setbacks.front}/${t.setbacks.side}/${t.setbacks.rear} m)</p>`,
    `<div class="row-3">
      ${field('Front', numInput('site.setbacks.front', sb.front, 'len'))}
      ${field('Side', numInput('site.setbacks.side', sb.side, 'len'))}
      ${field('Rear', numInput('site.setbacks.rear', sb.rear, 'len'))}
    </div>`,
    `<p class="hint">Zoning limits (blank = unlimited)</p>`,
    `<div class="row-3">
      ${field('Max FAR', numInput('site.maxFar', resolved.site.maxFar, 'num', 0.1))}
      ${field(`Max height (${lenUnit(units)})`, numInput('site.maxHeight', resolved.site.maxHeight, 'len'))}
      ${field('Max cover %', numInput('site.maxCoverage', resolved.site.maxCoverage, 'num', 1))}
    </div>`,
    selRow('Parking type', 'site.parking.type', String(pk.type ?? t.parking), [
      ['none', 'None'], ['surface', 'Surface'], ['garage-attached', 'Attached garage'], ['podium', 'Podium'], ['underground', 'Underground'],
    ], true),
    `<div class="row-3">
      ${field('Car/unit', numInput('site.parking.ratio', pk.ratio, 'num', 0.1))}
      ${field('EV share', numInput('site.parking.evShare', pk.evShare, 'num', 0.05))}
      ${field('Bike/unit', numInput('site.parking.bikeRatio', pk.bikeRatio, 'num', 0.1))}
    </div>`,
  ]));

  // ---- 4. massing
  const mg = resolved.massing;
  parts.push(section('Massing', true, [
    selRow('Footprint shape', 'massing.footprintShape', String(mg.footprintShape), t.footprintShapes.map((s) => [s, shapeLabel(s)]), true),
    numRow('Building depth', 'massing.buildingDepth', mg.buildingDepth, { step: 0.5, min: t.buildingDepth.min, max: t.buildingDepth.max }),
    `<p class="hint">Typology depth range ${t.buildingDepth.min}–${t.buildingDepth.max} m.</p>`,
    numRow('Building length', 'massing.buildingLength', mg.buildingLength, { step: 0.5, min: 4 }),
    `<p class="hint">Blank = fill the buildable width.</p>`,
    numRow('Floor-to-floor', 'massing.floorToFloor', mg.floorToFloor, { step: 0.05, min: 2.4, dec: 2 }),
    numRow('Ground floor-to-floor', 'massing.groundFloorToFloor', mg.groundFloorToFloor, { step: 0.05, min: 2.4, dec: 2 }),
    `<div class="row-2">
      ${field('Podium storeys', numInput('massing.podiumStoreys', mg.podiumStoreys, 'int', 1, true))}
      ${field('Podium use', sel('massing.podiumUse', String(mg.podiumUse ?? 'retail'), [['retail', 'Retail'], ['parking', 'Parking'], ['amenity', 'Amenity']], true))}
    </div>`,
    `<div class="row-2">
      ${field('Basements', numInput('massing.basementStoreys', mg.basementStoreys, 'int', 1, true))}
      ${field(`Corridor width (${lenUnit(units)})`, numInput('massing.corridorWidth', mg.corridorWidth, 'len', 0.1))}
    </div>`,
    `<div class="row-2">
      ${field('Core count', numInput('massing.coreCount', mg.coreCount, 'int', 1, true))}
      ${field(`Balcony depth (${lenUnit(units)})`, numInput('massing.balconyDepth', mg.balconyDepth, 'len', 0.1))}
    </div>`,
    `<div class="row-2">
      ${field('Roof', sel('massing.roof', String(mg.roof), [['flat', 'Flat'], ['gable', 'Gable'], ['hip', 'Hip']], true))}
      ${field('Pitch °', numInput('massing.roofPitchDeg', mg.roofPitchDeg, 'num', 1))}
    </div>`,
    numRow('Parapet height', 'massing.parapetHeight', mg.parapetHeight, { step: 0.05, min: 0 }),
  ]));

  // ---- 5. unit mix
  parts.push(section(`Unit mix (${Object.values(resolved.unitMix ?? {}).filter((v) => (v ?? 0) > 0).length} active)`, true, [
    unitMixTable(resolved, t),
  ]));

  // ---- 6. floors
  parts.push(section(`Floors (${resolved.floors.length})`, false, [floorTable(resolved)]));

  // ---- 7. options
  const o = resolved.options;
  parts.push(section('Generation options', true, [
    `<div class="toggles">
      ${chk('Site', 'options.site', o.site, true)}
      ${chk('Structure', 'options.structure', o.structure, true)}
      ${chk('Mechanical', 'options.mechanical', o.mechanical, true)}
      ${chk('Plumbing', 'options.plumbing', o.plumbing, true)}
      ${chk('Electrical', 'options.electrical', o.electrical, true)}
      ${chk('Furniture', 'options.furniture', o.furniture, true)}
    </div>`,
    selRow('Detail', 'options.detail', o.detail, [['low', 'Low (fast)'], ['medium', 'Medium'], ['high', 'High (full spacing rules)']], true),
    selRow('IFC schema', 'options.ifcSchema', o.ifcSchema, [['IFC2X3', 'IFC2X3'], ['IFC4', 'IFC4'], ['IFC4X3', 'IFC4X3']], true),
  ]));

  // ---- 8. spec json
  parts.push(`<details class="sec"${state.specJsonOpen ? ' open' : ''} data-json="1"><summary>Spec JSON</summary>
    <div class="sec-body"><pre class="json">${esc(JSON.stringify(state.spec, null, 2))}</pre>
    <p class="hint">Copy / load with the header buttons.</p></div></details>`);

  parts.push(`<button class="btn btn-sm" data-act="reset" type="button">Reset to preset</button>`);

  root.innerHTML = parts.join('');
  for (const d of Array.from(root.querySelectorAll<HTMLDetailsElement>('details.sec'))) {
    const was = openState.get(sectionKey(d.querySelector('summary')?.textContent ?? ''));
    if (was !== undefined) d.open = was;
  }
  root.scrollTop = scrollTop;
  // `toggle` does not bubble, so it cannot be delegated.
  const json = root.querySelector<HTMLDetailsElement>('details[data-json]');
  json?.addEventListener('toggle', () => { state.specJsonOpen = json.open; });
}

/** Section titles carry counts ("Floors (6)"), so key on the stable part. */
function sectionKey(title: string): string {
  return title.replace(/\s*\(.*$/, '').trim().toLowerCase();
}

function section(title: string, open: boolean, body: string[]): string {
  return `<details class="sec"${open ? ' open' : ''}><summary>${esc(title)}</summary><div class="sec-body">${body.join('')}</div></details>`;
}
function field(label: string, control: string): string {
  return `<div class="field"><label>${esc(label)}</label>${control}</div>`;
}
function numInput(path: string, value: number | undefined, kind: 'len' | 'num' | 'int', step = 0.5, structural = false): string {
  const units = displayUnits();
  const shown = value === undefined ? '' : kind === 'len' ? lenIn(value, units) : value;
  return `<input type="number" data-p="${path}" data-t="${kind}"${structural ? ' data-s="1"' : ''} value="${shown}" step="${step}">`;
}
function sel(path: string, value: string, opts: [string, string][], structural = false): string {
  return `<select data-p="${path}" data-t="str"${structural ? ' data-s="1"' : ''}>${opts.map(([v, l]) => option(v, l, value)).join('')}</select>`;
}

function unitMixTable(resolved: BuildingSpec, t: TypologyDef): string {
  const tpls = backend().templates;
  const byId = new Map<string, UnitTemplateDef>(tpls.map((x) => [x.id, x]));
  const mix = resolved.unitMix ?? {};
  const all = state.showAllTemplates;
  const ids = UNIT_TEMPLATE_IDS.filter((id) => {
    if (all) return true;
    const tpl = byId.get(id);
    if (!tpl || !tpl.suitableTypologies?.length) return (mix[id] ?? 0) > 0 || !tpl;
    return tpl.suitableTypologies.includes(t.id) || (mix[id] ?? 0) > 0;
  });
  const units = resolved.displayUnits;
  const rows = ids.map((id) => {
    const tpl = byId.get(id);
    const w = mix[id] ?? 0;
    const area = tpl ? areaIn(tpl.area.target, units) : '';
    return `<tr>
      <td><span class="tpl-name">${esc(tpl?.name ?? humanize(id))}</span><br><span class="tpl-sub">${tpl ? `${tpl.bedrooms}b ${tpl.bathrooms}ba` : ''}</span></td>
      <td class="num nowrap">${area}<br><span class="tpl-sub">${areaUnit(units)}</span></td>
      <td><div class="wt"><input type="range" min="0" max="5" step="1" value="${w}" data-mix="${id}"><span>${w}</span></div></td>
    </tr>`;
  }).join('');
  return `<table class="tbl tbl-mini"><thead><tr><th>Template</th><th class="num">Target</th><th>Weight</th></tr></thead><tbody>${rows}</tbody></table>
    <label class="toggle" style="margin-top:6px"><input type="checkbox" data-act="all-tpl"${all ? ' checked' : ''}>Show all 20 templates</label>
    <p class="hint">Weights are relative; 0 excludes the template. Filtered by <code>suitableTypologies</code>.</p>`;
}

function floorTable(resolved: BuildingSpec): string {
  const units = resolved.displayUnits;
  const overrides = new Map((state.spec.floors ?? []).map((f) => [f.index, f]));
  const rows = resolved.floors.map((f) => {
    const ov = overrides.get(f.index);
    const mixOpen = openMixFloors.has(f.index);
    const main = `<tr data-floor-row="${f.index}">
      <td class="nowrap">${f.index < 0 ? `B${-f.index}` : `L${f.index + 1}`}</td>
      <td>${sel2(`use`, f.index, String(f.use), FLOOR_USES.map((u) => [u, humanize(u)]))}</td>
      <td>${numIn2('floorToFloor', f.index, f.floorToFloor, units, 0.05)}</td>
      <td>${numIn2('ceilingHeight', f.index, f.ceilingHeight, units, 0.05)}</td>
      <td>${numIn2('wwr', f.index, f.wwr, 'raw', 0.05)}</td>
      <td style="text-align:center"><input type="checkbox" data-f="${f.index}" data-ff="balconies" data-t="bool"${f.balconies ? ' checked' : ''}></td>
      <td>${numIn2('targetUnits', f.index, f.targetUnits, 'raw', 1)}</td>
      <td><button class="btn btn-icon" type="button" data-mixfor="${f.index}" aria-pressed="${mixOpen}" title="Per-floor unit mix">mix${ov?.unitMix ? ' •' : ''}</button></td>
    </tr>`;
    if (!mixOpen) return main;
    const fmix = ov?.unitMix ?? resolved.unitMix ?? {};
    const tpls = backend().templates;
    const cells = UNIT_TEMPLATE_IDS.filter((id) => (fmix[id] ?? 0) > 0 || tpls.find((t) => t.id === id)?.suitableTypologies?.includes(resolved.typology))
      .map((id) => `<label class="toggle" style="width:46%">
        <input type="range" min="0" max="5" step="1" value="${fmix[id] ?? 0}" data-f="${f.index}" data-mix="${id}" style="width:56px">
        <span class="tpl-sub">${esc(humanize(id))} ${fmix[id] ?? 0}</span></label>`).join('');
    return `${main}<tr class="mix-row"><td colspan="8"><div class="toggles">${cells || '<span class="tpl-sub">No suitable templates</span>'}</div></td></tr>`;
  }).join('');
  return `<div class="scroll-x"><table class="tbl tbl-mini tbl-floors"><thead><tr>
    <th>Lvl</th><th>Use</th><th>F2F</th><th>Clg</th><th>WWR</th><th>Balc</th><th>Units</th><th></th>
  </tr></thead><tbody>${rows}</tbody></table></div>
  <p class="hint">Edits are stored as per-index overrides in <code>spec.floors</code>. F2F / Clg in ${lenUnit(units)}.</p>`;
}

const openMixFloors = new Set<number>();

function sel2(fieldName: string, idx: number, value: string, opts: [string, string][]): string {
  return `<select data-f="${idx}" data-ff="${fieldName}" data-t="str">${opts.map(([v, l]) => option(v, l, value)).join('')}</select>`;
}
function numIn2(fieldName: string, idx: number, value: number | undefined, units: 'metric' | 'imperial' | 'raw', step: number): string {
  const shown = value === undefined ? '' : units === 'raw' ? value : lenIn(value, units);
  return `<input type="number" data-f="${idx}" data-ff="${fieldName}" data-t="${units === 'raw' ? 'num' : 'len'}" value="${shown}" step="${step}" style="width:56px">`;
}

function regionLabel(r: Region): string {
  return { US: 'United States', UK: 'United Kingdom', CA: 'Canada', AU: 'Australia', NZ: 'New Zealand', IE: 'Ireland' }[r];
}
function compassLabel(c: Compass): string {
  return { N: 'North', NE: 'North-east', E: 'East', SE: 'South-east', S: 'South', SW: 'South-west', W: 'West', NW: 'North-west' }[c];
}
function shapeLabel(s: FootprintShape): string {
  return { bar: 'Bar', L: 'L-shape', U: 'U-shape', O: 'Perimeter block (O)', point: 'Point', T: 'T-shape' }[s];
}
export function typologyLabel(t: TypologyDef, region: Region): string {
  const alt = t.regionalNames[region];
  return alt && alt !== t.name ? `${t.name} — ${alt}` : t.name;
}

// ------------------------------------------------------------------ wiring
export interface FormHooks {
  /** Called after any spec mutation. `structural` = the floor list / typology changed. */
  onChange: (structural: boolean) => void;
  /** Rebuild the form DOM (used after structural edits). */
  rerender: () => void;
}

export function attachForm(root: HTMLElement, hooks: FormHooks): void {
  const commit = (el: HTMLElement, structural: boolean) => {
    const focusKey = el.getAttribute('data-p') ?? el.getAttribute('data-ff') ?? null;
    hooks.onChange(structural);
    if (structural) {
      hooks.rerender();
      if (focusKey) {
        const again = root.querySelector<HTMLElement>(`[data-p="${focusKey}"],[data-ff="${focusKey}"]`);
        again?.focus();
      }
    }
  };

  // generic spec paths
  delegate(root, 'input', '[data-p]', (el) => handlePath(el as HTMLInputElement, commit, false));
  delegate(root, 'change', '[data-p]', (el) => handlePath(el as HTMLInputElement, commit, true));

  // per-floor overrides
  delegate(root, 'input', '[data-ff]', (el) => handleFloor(el as HTMLInputElement, commit, false));
  delegate(root, 'change', '[data-ff]', (el) => handleFloor(el as HTMLInputElement, commit, true));

  // unit mix sliders (building-wide and per-floor)
  delegate(root, 'input', '[data-mix]', (el) => {
    const input = el as HTMLInputElement;
    const id = input.dataset.mix as UnitTemplateId;
    const w = Number(input.value);
    const fIdx = input.dataset.f;
    if (fIdx === undefined) {
      const mix: Record<string, number> = { ...(state.spec.unitMix ?? {}) };
      if (w <= 0) delete mix[id]; else mix[id] = w;
      state.spec.unitMix = mix as PartialSpec['unitMix'];
      const out = input.parentElement?.querySelector('span');
      if (out) out.textContent = String(w);
    } else {
      const idx = Number(fIdx);
      const f = ensureFloor(idx);
      const mix: Record<string, number> = { ...(f.unitMix ?? {}) };
      if (w <= 0) delete mix[id]; else mix[id] = w;
      f.unitMix = mix as FloorSpec['unitMix'];
      const out = input.parentElement?.querySelector('span');
      if (out) out.textContent = `${humanize(id)} ${w}`;
    }
    hooks.onChange(false);
  });

  // preset select
  delegate(root, 'change', '[data-preset]', (el) => {
    const id = (el as HTMLSelectElement).value;
    if (id === '__custom') { state.presetId = '__custom'; return; }
    const p = PRESETS.find((x) => x.id === id);
    if (!p) return;
    state.presetId = id;
    state.spec = structuredCloneSafe(p.spec);
    openMixFloors.clear();
    commit(el, true);
  });

  // display units segmented control
  delegate(root, 'click', '[data-units]', (el) => {
    state.spec.displayUnits = el.getAttribute('data-units') as 'metric' | 'imperial';
    commit(el, true);
  });

  delegate(root, 'click', '[data-act]', (el) => {
    const act = el.getAttribute('data-act');
    if (act === 'dice') {
      state.spec.seed = Math.floor(Math.random() * 100000);
      commit(el, true);
    } else if (act === 'reset') {
      const p = PRESETS.find((x) => x.id === state.presetId) ?? PRESETS[0];
      state.presetId = p.id;
      state.spec = structuredCloneSafe(p.spec);
      openMixFloors.clear();
      commit(el, true);
    } else if (act === 'all-tpl') {
      state.showAllTemplates = (el as HTMLInputElement).checked;
      hooks.rerender();
    }
  });

  delegate(root, 'click', '[data-mixfor]', (el) => {
    const idx = Number(el.getAttribute('data-mixfor'));
    if (openMixFloors.has(idx)) openMixFloors.delete(idx); else openMixFloors.add(idx);
    hooks.rerender();
  });

  delegate(root, 'toggle', '[data-json]', (el) => {
    state.specJsonOpen = (el as HTMLDetailsElement).open;
  });
}

function handlePath(input: HTMLInputElement, commit: (el: HTMLElement, s: boolean) => void, isChange: boolean): void {
  const path = input.dataset.p!;
  const kind = input.dataset.t ?? 'str';
  const structural = input.dataset.s === '1';
  // Fire on 'input' for text/number/range, on 'change' for select/checkbox.
  const isSelect = input.tagName === 'SELECT';
  const isCheck = input.type === 'checkbox';
  if ((isSelect || isCheck) !== isChange) return;
  const raw = isCheck ? String(input.checked) : input.value;
  const value = parseValue(kind, raw, displayUnits());
  setPath(state.spec as unknown as Record<string, unknown>, path, value);
  if (path === 'massing.storeys') {
    // keep the paired slider/number in sync without a full rebuild
    for (const twin of Array.from(document.querySelectorAll<HTMLInputElement>('[data-p="massing.storeys"]'))) {
      if (twin !== input) twin.value = String(value ?? '');
    }
  }
  if (state.presetId !== '__custom') state.presetId = '__custom';
  commit(input, structural);
}

function handleFloor(input: HTMLInputElement, commit: (el: HTMLElement, s: boolean) => void, isChange: boolean): void {
  const idx = Number(input.dataset.f);
  const fieldName = input.dataset.ff!;
  const kind = input.dataset.t ?? 'num';
  const isSelect = input.tagName === 'SELECT';
  const isCheck = input.type === 'checkbox';
  if ((isSelect || isCheck) !== isChange) return;
  const f = ensureFloor(idx) as unknown as Record<string, unknown>;
  const raw = isCheck ? String(input.checked) : input.value;
  const v = parseValue(kind, raw, displayUnits());
  if (v === undefined) delete f[fieldName]; else f[fieldName] = v;
  if (state.presetId !== '__custom') state.presetId = '__custom';
  commit(input, false);
}

function ensureFloor(index: number): FloorSpec {
  if (!state.spec.floors) state.spec.floors = [];
  let f = state.spec.floors.find((x) => x.index === index);
  if (!f) {
    let use: FloorUse = 'residential';
    try {
      use = normalizeSpec(state.spec).floors.find((x) => x.index === index)?.use ?? 'residential';
    } catch { /* keep the default */ }
    f = { index, use };
    state.spec.floors.push(f);
    state.spec.floors.sort((a, b) => a.index - b.index);
  }
  return f;
}

export function currentTypology(): TypologyId {
  return state.spec.typology;
}
