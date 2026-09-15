/** Patterns tab: the pattern book grouped by discipline, with applications. */
import type { DesignModel, Pattern, PatternApplication } from '../core/types.ts';
import { esc, humanize } from './util.ts';

const DISC_ORDER = ['cross', 'site', 'architecture', 'structure', 'mechanical', 'plumbing', 'electrical'] as const;
const DISC_LABEL: Record<string, string> = {
  cross: 'Cross-discipline (XD)', site: 'Site (SIT)', architecture: 'Architecture (ARC)',
  structure: 'Structure (STR)', mechanical: 'Mechanical (MEC)', plumbing: 'Plumbing (PLB)',
  electrical: 'Electrical (ELE)',
};

export function renderPatterns(root: HTMLElement, model: DesignModel, query: string): void {
  const book: Pattern[] = model.patterns?.book ?? [];
  const apps: PatternApplication[] = model.patterns?.applications ?? [];
  if (!book.length) {
    root.innerHTML = `<p class="empty">No patterns registered in this model.</p>`;
    return;
  }
  const byPattern = new Map<string, PatternApplication[]>();
  for (const a of apps) {
    const arr = byPattern.get(a.patternId) ?? [];
    arr.push(a);
    byPattern.set(a.patternId, arr);
  }
  const applied = book.filter((p) => (byPattern.get(p.id)?.length ?? 0) > 0).length;
  const q = query.trim().toLowerCase();
  const match = (p: Pattern) => !q || [p.id, p.name, p.problem, p.solution, ...(p.references ?? []), ...Object.keys(p.parameters ?? {})]
    .join(' ').toLowerCase().includes(q);

  const out: string[] = [];
  out.push(`<div class="strip">
    <span><b>${book.length}</b> registered</span>
    <span><b>${applied}</b> applied</span>
    <span><b>${apps.length}</b> applications</span>
    ${apps.length && applied < book.length ? `<span class="tile-status st-warn">▲ ${book.length - applied} never applied</span>` : ''}
    ${q ? `<span class="badge">filter “${esc(query)}”</span>` : ''}
  </div>`);

  let shown = 0;
  for (const disc of DISC_ORDER) {
    const group = book.filter((p) => p.discipline === disc && match(p))
      .sort((a, b) => a.id.localeCompare(b.id));
    if (!group.length) continue;
    out.push(`<h3 class="cat-h">${esc(DISC_LABEL[disc])} — ${group.length}</h3>`);
    for (const p of group) {
      shown++;
      const list = byPattern.get(p.id) ?? [];
      out.push(patternRow(p, list, !!q));
    }
  }
  // patterns with an unexpected discipline value
  const others = book.filter((p) => !DISC_ORDER.includes(p.discipline as never) && match(p));
  if (others.length) {
    out.push(`<h3 class="cat-h">Other</h3>`);
    for (const p of others) { shown++; out.push(patternRow(p, byPattern.get(p.id) ?? [], !!q)); }
  }
  if (!shown) out.push(`<p class="empty">No pattern matches “${esc(query)}”.</p>`);
  root.innerHTML = out.join('');
}

function patternRow(p: Pattern, apps: PatternApplication[], open: boolean): string {
  const params = Object.entries(p.parameters ?? {});
  return `<details class="pat"${open ? ' open' : ''}>
    <summary>
      <span class="pat-id">${esc(p.id)}</span>
      <span class="pat-name">${esc(p.name)}</span>
      <span class="pat-count">${apps.length ? `${apps.length} applied` : 'not applied'}</span>
    </summary>
    <div class="pat-body">
      <h5>Problem</h5><p>${esc(p.problem)}</p>
      <h5>Solution</h5><p>${esc(p.solution)}</p>
      ${params.length ? `<h5>Parameters</h5>
      <table class="tbl tbl-mini"><thead><tr><th>Name</th><th class="num">Value</th><th>Unit</th><th>Source</th></tr></thead>
      <tbody>${params.map(([k, v]) => `<tr>
        <td>${esc(k)}</td><td class="num">${esc(String(v.value))}</td><td>${esc(v.unit ?? '')}</td><td>${esc(v.source ?? '')}</td>
      </tr>`).join('')}</tbody></table>` : ''}
      ${p.dependsOn?.length ? `<h5>Depends on</h5>${p.dependsOn.map((d) => `<span class="pill">${esc(d)}</span>`).join('')}` : ''}
      ${p.references?.length ? `<h5>References</h5>${p.references.map((r) => `<span class="pill">${esc(r)}</span>`).join('')}` : ''}
      ${apps.length ? `<h5>Applications (${Math.min(20, apps.length)} of ${apps.length})</h5>
      <table class="tbl tbl-mini"><thead><tr><th>Storey</th><th>Unit</th><th class="num">Elements</th><th>Parameters</th><th>Note</th></tr></thead>
      <tbody>${apps.slice(0, 20).map((a) => `<tr>
        <td>${esc(a.storey ?? '—')}</td>
        <td>${esc(a.unitId ?? '—')}</td>
        <td class="num">${a.elementIds?.length ?? 0}</td>
        <td class="mono">${esc(a.params ? Object.entries(a.params).map(([k, v]) => `${k}=${v}`).join(' · ') : '')}</td>
        <td>${esc(a.note ?? '')}</td>
      </tr>`).join('')}</tbody></table>` : ''}
    </div>
  </details>`;
}

export { humanize };
