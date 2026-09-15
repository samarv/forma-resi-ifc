/** Elements tab: counts by discipline × IFC type, plus a bounded element list. */
import type { DesignModel, ModelElement } from '../core/types.ts';
import { esc, humanize } from './util.ts';

const LIST_CAP = 200;

export function renderElements(root: HTMLElement, model: DesignModel, selectedType: string | null, highlight: string | null): void {
  const els = model.elements ?? [];
  if (!els.length) {
    root.innerHTML = `<p class="empty">This model has no elements.</p>`;
    return;
  }
  // discipline → ifcType → count
  const byDisc = new Map<string, Map<string, number>>();
  for (const e of els) {
    const m = byDisc.get(e.discipline) ?? new Map<string, number>();
    m.set(e.ifcType, (m.get(e.ifcType) ?? 0) + 1);
    byDisc.set(e.discipline, m);
  }
  const out: string[] = [];
  out.push(`<div class="strip">
    <span><b>${els.length.toLocaleString('en-US')}</b> elements</span>
    <span><b>${byDisc.size}</b> disciplines</span>
    <span><b>${new Set(els.map((e) => e.ifcType)).size}</b> IFC types</span>
    <span><b>${new Set(els.map((e) => e.storey)).size}</b> storeys</span>
  </div>`);

  out.push(`<table class="tbl"><thead><tr>
    <th>Discipline</th><th>IFC type</th><th class="num">Count</th><th class="num">Share</th><th></th>
  </tr></thead><tbody>`);
  for (const [disc, types] of [...byDisc.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const total = [...types.values()].reduce((a, b) => a + b, 0);
    out.push(`<tr><td colspan="2"><b>${esc(humanize(disc))}</b></td><td class="num"><b>${total.toLocaleString('en-US')}</b></td>
      <td class="num">${((total / els.length) * 100).toFixed(1)} %</td><td></td></tr>`);
    for (const [t, c] of [...types.entries()].sort((a, b) => b[1] - a[1])) {
      const sel = selectedType === t;
      out.push(`<tr${sel ? ' class="tr-hl"' : ''}>
        <td></td><td class="mono">${esc(t)}</td>
        <td class="num">${c.toLocaleString('en-US')}</td>
        <td class="num">${((c / els.length) * 100).toFixed(1)} %</td>
        <td><button class="btn btn-sm" type="button" data-eltype="${esc(t)}">${sel ? 'Hide' : 'List'}</button></td>
      </tr>`);
    }
  }
  out.push(`</tbody></table>`);

  if (selectedType) {
    const list = els.filter((e) => e.ifcType === selectedType);
    out.push(`<h3 class="cat-h">${esc(selectedType)} — first ${Math.min(LIST_CAP, list.length)} of ${list.length}</h3>`);
    out.push(`<table class="tbl"><thead><tr>
      <th>Id</th><th>Name</th><th>Storey</th><th>Unit</th><th>Room</th><th>Geometry</th><th>Patterns</th><th></th>
    </tr></thead><tbody>${list.slice(0, LIST_CAP).map((e) => row(e, e.id === highlight)).join('')}</tbody></table>`);
  } else {
    out.push(`<p class="hint">Pick a type above to list its elements. Use “Find” to jump to an element id in the Plans tab.</p>`);
  }
  root.innerHTML = out.join('');
}

function row(e: ModelElement, hl: boolean): string {
  return `<tr${hl ? ' class="tr-hl"' : ''}>
    <td class="mono">${esc(e.id)}</td>
    <td>${esc(e.name)}</td>
    <td>${esc(e.storey)}</td>
    <td>${esc(e.unitId ?? '—')}</td>
    <td>${esc(e.roomId ?? '—')}</td>
    <td>${esc(e.geometry.kind)}</td>
    <td class="mono">${esc((e.patterns ?? []).join(' '))}</td>
    <td><button class="btn btn-sm" type="button" data-find="${esc(e.id)}">Show</button></td>
  </tr>`;
}

/** Storey of an element id, for the "Find" jump. */
export function findElement(model: DesignModel, id: string): ModelElement | null {
  const q = id.trim();
  if (!q) return null;
  const exact = model.elements.find((e) => e.id === q);
  if (exact) return exact;
  const ci = q.toLowerCase();
  return model.elements.find((e) => e.id.toLowerCase() === ci)
    ?? model.elements.find((e) => e.id.toLowerCase().includes(ci))
    ?? null;
}
