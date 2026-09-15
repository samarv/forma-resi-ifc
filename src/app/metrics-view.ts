/**
 * Metrics tab: the headline 20 as stat tiles grouped by category, then the
 * supplementary metrics as a compact table (which doubles as the table view that
 * the breakdown bars lean on for accessibility).
 */
import type { DesignModel, MetricCategory, MetricDef, MetricResult } from '../core/types.ts';
import type { DisplayUnits } from '../core/units.ts';
import { compact, esc, humanize, slotFor, STATUS_CLASS, STATUS_GLYPH, STATUS_WORD } from './util.ts';

const CAT_ORDER: MetricCategory[] = [
  'area', 'program', 'density', 'form', 'access', 'open-space', 'systems', 'sustainability', 'economics',
];
const CAT_LABEL: Record<MetricCategory, string> = {
  area: 'Area', program: 'Programme', density: 'Density', form: 'Form', access: 'Access & circulation',
  'open-space': 'Open space', systems: 'Building systems', sustainability: 'Sustainability', economics: 'Economics',
};

export function renderMetrics(root: HTMLElement, model: DesignModel, defs: MetricDef[], units: DisplayUnits): void {
  const results = model.metrics ?? [];
  if (!results.length) {
    root.innerHTML = `<p class="empty">No metrics in this model. <code>computeMetrics()</code> returned an empty list.</p>`;
    return;
  }
  const defById = new Map(defs.map((d) => [d.id, d]));
  const region = model.spec.region;

  const head = results.filter((r) => rank(defById, r) <= 20).sort((a, b) => rank(defById, a) - rank(defById, b));
  const rest = results.filter((r) => rank(defById, r) > 20).sort((a, b) => rank(defById, a) - rank(defById, b));

  const counts = { ok: 0, warn: 0, fail: 0 } as Record<string, number>;
  for (const r of results) if (r.status) counts[r.status] = (counts[r.status] ?? 0) + 1;

  const out: string[] = [];
  out.push(`<div class="strip">
    <span><b>${results.length}</b> metrics</span>
    <span><b>${head.length}</b> headline</span>
    <span class="tile-status ${STATUS_CLASS.ok}">${STATUS_GLYPH.ok} ${counts.ok ?? 0} OK</span>
    <span class="tile-status ${STATUS_CLASS.warn}">${STATUS_GLYPH.warn} ${counts.warn ?? 0} check</span>
    <span class="tile-status ${STATUS_CLASS.fail}">${STATUS_GLYPH.fail} ${counts.fail ?? 0} fail</span>
    <span class="badge">${esc(region)} terminology</span>
  </div>`);

  const byCat = new Map<MetricCategory, MetricResult[]>();
  for (const r of head) {
    const c = defById.get(r.id)?.category ?? 'area';
    const arr = byCat.get(c) ?? [];
    arr.push(r);
    byCat.set(c, arr);
  }
  const cats = [...byCat.keys()].sort((a, b) => CAT_ORDER.indexOf(a) - CAT_ORDER.indexOf(b));
  for (const c of cats) {
    out.push(`<h3 class="cat-h">${esc(CAT_LABEL[c] ?? humanize(c))}</h3>`);
    out.push(`<div class="mgrid">${byCat.get(c)!.map((r) => tile(r, defById.get(r.id), region, units)).join('')}</div>`);
  }

  if (rest.length) {
    out.push(`<h3 class="cat-h">Supplementary metrics</h3>`);
    out.push(`<table class="tbl"><thead><tr>
      <th>Metric</th><th class="num">Value</th><th>Unit</th><th>Status</th><th>Note</th>
    </tr></thead><tbody>${rest.map((r) => {
      const d = defById.get(r.id);
      return `<tr>
        <td>${esc(d?.name ?? humanize(r.id))}</td>
        <td class="num">${esc(r.display || compact(r.value))}</td>
        <td>${esc(r.unit || unitOf(d, units))}</td>
        <td>${r.status ? `<span class="tile-status ${STATUS_CLASS[r.status]}">${STATUS_GLYPH[r.status]} ${STATUS_WORD[r.status]}</span>` : '—'}</td>
        <td>${esc(r.note ?? d?.description ?? '')}</td>
      </tr>`;
    }).join('')}</tbody></table>`);
  }

  root.innerHTML = out.join('');
}

function rank(defs: Map<string, MetricDef>, r: MetricResult): number {
  return defs.get(r.id)?.rank ?? 999;
}

function unitOf(d: MetricDef | undefined, units: DisplayUnits): string {
  if (!d) return '';
  return units === 'imperial' ? d.unit.imperial : d.unit.metric;
}

function tile(r: MetricResult, d: MetricDef | undefined, region: string, units: DisplayUnits): string {
  const alt = d?.altNames?.[region as keyof MetricDef['altNames']];
  const unit = r.unit || unitOf(d, units);
  const value = r.display && r.display.trim() !== '' ? r.display : compact(r.value);
  // The display string usually carries its own unit; only append when it does not.
  const showUnit = unit && !value.includes(unit) && value.length < 14;
  const st = r.status;
  return `<div class="tile${st ? ` is-${st}` : ''}" title="${esc(d?.formula ?? '')}">
    <div class="tile-top">
      <span class="tile-label">${esc(d?.name ?? humanize(r.id))}${alt && alt !== d?.name ? `<br><span class="tile-alt">${esc(alt)}</span>` : ''}</span>
      ${d?.rank ? `<span class="tile-rank">#${d.rank}</span>` : ''}
    </div>
    <div class="tile-value">${esc(value)}${showUnit ? `<span class="tile-unit">${esc(unit)}</span>` : ''}</div>
    ${st ? `<div class="tile-status ${STATUS_CLASS[st]}">${STATUS_GLYPH[st]} ${STATUS_WORD[st]}</div>` : ''}
    ${r.note ? `<div class="tile-note">${esc(r.note)}</div>` : ''}
    ${bars(r)}
  </div>`;
}

/** Breakdown bars: one measure across categories = a single series, so one hue + direct labels. */
function bars(r: MetricResult): string {
  const bd = r.breakdown;
  if (!bd) return '';
  const entries = Object.entries(bd).filter(([, v]) => Number.isFinite(v));
  if (!entries.length) return '';
  entries.sort((a, b) => b[1] - a[1]);
  const shown = entries.slice(0, 7);
  const max = Math.max(...shown.map(([, v]) => Math.abs(v)), 1e-9);
  const isMix = r.id === 'unit-mix';
  const rows = shown.map(([k, v]) => `<div class="bar-row">
    <span title="${esc(k)}">${isMix ? `<span class="chip-dot" style="background:var(--s${slotFor(k)})"></span>` : ''}${esc(humanize(k))}</span>
    <span class="bar-track"><span class="bar-fill" style="width:${Math.max(2, (Math.abs(v) / max) * 100).toFixed(1)}%;background:var(--s1)"></span></span>
    <span class="bar-val">${esc(compact(v))}</span>
  </div>`).join('');
  const more = entries.length > shown.length ? `<div class="bar-row"><span>+${entries.length - shown.length} more</span><span></span><span></span></div>` : '';
  return `<div class="bars">${rows}${more}</div>`;
}
