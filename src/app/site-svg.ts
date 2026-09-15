/** Site plan: boundary, setbacks, buildable envelope, stacked footprints, parking, landscape. */
import type { DesignModel, Polygon, Rect, Vec2 } from '../core/types.ts';
import type { DisplayUnits } from '../core/units.ts';
import type { Drawing, Hit } from './plan-svg.ts';
import { rectPts } from './plan-svg.ts';
import { bboxOf, circlePath, hatchDefs, linePath, pathEl, polyPath, rectPath, text, unionRect } from './svg.ts';
import { fmtArea, fmtLenPlain, humanize } from './util.ts';

export function buildSite(model: DesignModel, units: DisplayUnits, highlight: string | null): Drawing {
  const site = model.site;
  const out: string[] = [];
  const hits: Hit[] = [];
  const counts: Record<string, number> = {};
  let bounds: Rect | null = null;
  const grow = (pts: Vec2[]) => { bounds = unionRect(bounds, bboxOf(pts)); };

  if (!site) {
    return { body: '', defs: hatchDefs(), hits, bounds: { x: 0, y: 0, w: 20, h: 20 }, counts };
  }

  const b = site.boundary?.length ? site.boundary : [[0, 0], [30, 0], [30, 20], [0, 20]] as Polygon;
  grow(b);

  // ---- boundary + envelope
  out.push(`<g class="s-boundary">
    ${pathEl(polyPath(b), { fill: 'var(--dwg-room-out)', 'fill-opacity': 0.35, stroke: 'var(--dwg-outline)', 'stroke-width': 0.14 })}
  </g>`);
  hits.push(hit('SITE-BOUNDARY', 'Site', `Site ${fmtArea(site.area, units)}`, b, [
    ['Area', fmtArea(site.area, units)],
    ['Street facing', site.streetFacing],
    ['Setbacks', `${site.setbacks.front} / ${site.setbacks.side} / ${site.setbacks.rear} m`],
  ]));

  if (site.buildableEnvelope?.length) {
    grow(site.buildableEnvelope);
    out.push(pathEl(polyPath(site.buildableEnvelope), {
      fill: 'var(--accent)', 'fill-opacity': 0.06, stroke: 'var(--accent)', 'stroke-width': 0.08, 'stroke-dasharray': '1.1 .7',
    }));
    hits.push(hit('SITE-ENVELOPE', 'Buildable envelope', 'Buildable envelope', site.buildableEnvelope, [
      ['Front setback', `${site.setbacks.front} m`], ['Side setback', `${site.setbacks.side} m`], ['Rear setback', `${site.setbacks.rear} m`],
    ]));
  }

  // ---- landscape
  if (site.landscape?.length) {
    const zones: string[] = [];
    const trees: string[] = [];
    for (const lz of site.landscape) {
      if (!lz.polygon?.length) continue;
      grow(lz.polygon);
      if (lz.type === 'tree') {
        const c = bboxOf(lz.polygon);
        trees.push(circlePath(c.x + c.w / 2, c.y + c.h / 2, Math.max(c.w, c.h) / 2));
      } else {
        zones.push(polyPath(lz.polygon));
      }
      counts.landscape = (counts.landscape ?? 0) + 1;
      hits.push(hit(lz.id, 'Landscape', `${humanize(lz.type)} ${fmtArea(lz.area, units)}`, lz.polygon, [
        ['Type', humanize(lz.type)], ['Area', fmtArea(lz.area, units)],
      ]));
    }
    out.push(`<g class="s-landscape">
      ${pathEl(zones.join(''), { fill: 'var(--dwg-site)', 'fill-opacity': 0.16, stroke: 'var(--dwg-site)', 'stroke-width': 0.05 })}
      ${pathEl(trees.join(''), { fill: 'var(--dwg-site)', 'fill-opacity': 0.3, stroke: 'var(--dwg-site)', 'stroke-width': 0.06 })}
    </g>`);
  }

  // ---- driveway, paths
  const hard: string[] = [];
  if (site.driveway) { hard.push(rectPath(site.driveway)); grow(rectPts(site.driveway)); }
  for (const p of site.paths ?? []) { hard.push(rectPath(p)); grow(rectPts(p)); }
  for (const a of site.parking?.aisles ?? []) { hard.push(rectPath(a)); grow(rectPts(a)); }
  if (hard.length) {
    out.push(pathEl(hard.join(''), { fill: 'var(--surface-2)', stroke: 'var(--dwg-grid)', 'stroke-width': 0.04 }));
  }

  // ---- parking
  if (site.parking?.spaces?.length) {
    const byType = new Map<string, string[]>();
    const marks: string[] = [];
    for (const s of site.parking.spaces) {
      const pts = rectPts(s.rect);
      grow(pts);
      const arr = byType.get(s.type) ?? [];
      arr.push(rectPath(s.rect));
      byType.set(s.type, arr);
      counts.parking = (counts.parking ?? 0) + 1;
      if (s.type === 'ev' || s.type === 'accessible') {
        marks.push(text(s.rect.x + s.rect.w / 2, s.rect.y + s.rect.h / 2 - 0.25,
          s.type === 'ev' ? 'EV' : '♿', { size: 0.7, fill: 'var(--ink-2)', weight: 700 }));
      }
      hits.push(hit(s.id, 'Parking', `${humanize(s.type)} stall`, pts, [
        ['Type', humanize(s.type)], ['Size', `${s.rect.w.toFixed(1)} × ${s.rect.h.toFixed(1)} m`], ['Storey', s.storey],
      ]));
    }
    const g: string[] = [];
    for (const [t, ds] of byType) {
      const fill = t === 'ev' ? 'var(--s3)' : t === 'accessible' ? 'var(--s1)' : t === 'compact' ? 'var(--s4)' : 'var(--ink-3)';
      g.push(pathEl(ds.join(''), { fill, 'fill-opacity': 0.14, stroke: fill, 'stroke-width': 0.05 }));
    }
    out.push(`<g class="s-parking">${g.join('')}${marks.join('')}</g>`);
  }

  // ---- stacked storey footprints (podium vs tower)
  const mass = site.massing;
  if (mass) {
    const stack: string[] = [];
    for (const f of model.arch?.floors ?? []) {
      if (!f.outline?.length) continue;
      stack.push(polyPath(f.outline));
      grow(f.outline);
    }
    if (stack.length) {
      out.push(pathEl(stack.join(''), {
        fill: 'var(--dwg-wall-ext)', 'fill-opacity': 0.055, stroke: 'var(--dwg-wall-ext)', 'stroke-width': 0.03, 'stroke-opacity': 0.35,
      }));
    }
    if (mass.podium?.footprint?.length) {
      grow(mass.podium.footprint);
      out.push(pathEl(polyPath(mass.podium.footprint), {
        fill: 'var(--s2)', 'fill-opacity': 0.12, stroke: 'var(--s2)', 'stroke-width': 0.1, 'stroke-dasharray': '1.4 .6',
      }));
      hits.push(hit('SITE-PODIUM', 'Podium', `Podium ${mass.podium.storeys} storeys (${mass.podium.use})`, mass.podium.footprint, [
        ['Storeys', String(mass.podium.storeys)], ['Use', humanize(mass.podium.use)],
      ]));
    }
    if (mass.footprint?.length) {
      grow(mass.footprint);
      out.push(pathEl(polyPath(mass.footprint), {
        fill: 'var(--dwg-wall-ext)', 'fill-opacity': 0.16, stroke: 'var(--dwg-wall-ext)', 'stroke-width': 0.12,
      }));
      hits.push(hit('SITE-FOOTPRINT', 'Footprint', `Footprint ${fmtArea(mass.footprintArea, units)}`, mass.footprint, [
        ['Shape', mass.shape], ['Area', fmtArea(mass.footprintArea, units)],
        ['GFA', fmtArea(mass.gfa, units)], ['Height', fmtLenPlain(mass.heightAboveGrade, units)],
      ]));
    }
    if (mass.towerFootprint?.length) {
      grow(mass.towerFootprint);
      out.push(pathEl(polyPath(mass.towerFootprint), {
        fill: 'var(--dwg-wall-ext)', 'fill-opacity': 0.22, stroke: 'var(--dwg-wall-ext)', 'stroke-width': 0.1,
      }));
    }
    if (mass.courtyard?.length) {
      out.push(pathEl(polyPath(mass.courtyard), { fill: 'var(--dwg-room-out)', stroke: 'var(--dwg-site)', 'stroke-width': 0.07 }));
    }
    // cores + corridor spines
    const cores = (mass.cores ?? []).map((c) => rectPath(c.rect)).join('');
    if (cores) out.push(pathEl(cores, { fill: 'url(#hx)', stroke: 'var(--dwg-wall-core)', 'stroke-width': 0.06 }));
    for (const c of mass.cores ?? []) {
      hits.push(hit(c.id, 'Core', `${humanize(c.type)} core`, rectPts(c.rect), [
        ['Type', humanize(c.type)], ['Lifts', String(c.elevatorCount)], ['Bar', c.barId],
      ]));
    }
    const spines = (mass.corridors ?? []).map((c) => linePath(c.centerline.a, c.centerline.b)).join('');
    if (spines) {
      out.push(pathEl(spines, { fill: 'none', stroke: 'var(--accent)', 'stroke-width': 0.09, 'stroke-dasharray': '1.6 .8' }));
    }
  }

  // ---- entrances
  if (site.entrances?.length) {
    const arrows: string[] = [];
    for (const e of site.entrances) {
      const dir: Vec2 = e.side === 'front' ? [0, -1] : e.side === 'rear' ? [0, 1] : e.side === 'left' ? [-1, 0] : [1, 0];
      const a: Vec2 = [e.position[0] - dir[0] * 2.6, e.position[1] - dir[1] * 2.6];
      arrows.push(linePath(a, e.position));
      hits.push(hit(e.id, 'Entrance', `${humanize(e.type)} entrance`, [a, e.position], [
        ['Type', humanize(e.type)], ['Side', e.side], ...(e.unitId ? [['Unit', e.unitId] as [string, string]] : []),
      ]));
    }
    out.push(pathEl(arrows.join(''), { fill: 'none', stroke: 'var(--dwg-site)', 'stroke-width': 0.12, 'marker-end': 'url(#arw)' }));
  }

  // ---- dimensions
  const bb = bboxOf(b);
  const dim: string[] = [];
  const off = Math.max(1.2, bb.h * 0.04);
  dim.push(linePath([bb.x, bb.y - off], [bb.x + bb.w, bb.y - off]));
  dim.push(linePath([bb.x, bb.y - off * 1.4], [bb.x, bb.y - off * 0.6]));
  dim.push(linePath([bb.x + bb.w, bb.y - off * 1.4], [bb.x + bb.w, bb.y - off * 0.6]));
  dim.push(linePath([bb.x - off, bb.y], [bb.x - off, bb.y + bb.h]));
  dim.push(linePath([bb.x - off * 1.4, bb.y], [bb.x - off * 0.6, bb.y]));
  dim.push(linePath([bb.x - off * 1.4, bb.y + bb.h], [bb.x - off * 0.6, bb.y + bb.h]));
  out.push(`<g class="s-dims">
    ${pathEl(dim.join(''), { fill: 'none', stroke: 'var(--ink-3)', 'stroke-width': 0.04 })}
    ${text(bb.x + bb.w / 2, bb.y - off - 0.55, `${fmtLenPlain(bb.w, units, 1)} frontage`, { size: 0.75, fill: 'var(--ink-2)' })}
    ${text(bb.x - off - 0.3, bb.y + bb.h / 2, `${fmtLenPlain(bb.h, units, 1)} deep`, { size: 0.75, fill: 'var(--ink-2)', anchor: 'end' })}
    ${text(bb.x + bb.w / 2, bb.y - off - 1.8, 'STREET', { size: 0.9, fill: 'var(--ink-3)', weight: 700 })}
  </g>`);
  grow([[bb.x - off * 3, bb.y - off * 3], [bb.x + bb.w + off, bb.y + bb.h + off]]);

  if (highlight) {
    const h = hits.find((x) => x.id === highlight);
    if (h) {
      out.push(pathEl(rectPath({ x: h.x0 - 0.3, y: h.y0 - 0.3, w: h.x1 - h.x0 + 0.6, h: h.y1 - h.y0 + 0.6 }), {
        fill: 'none', stroke: 'var(--dwg-hl)', 'stroke-width': 0.12, 'stroke-dasharray': '.6 .3',
      }));
    }
  }

  return { body: out.join(''), defs: hatchDefs(), hits, bounds: (bounds ?? bb) as Rect, counts };
}

function hit(id: string, kind: string, label: string, pts: readonly Vec2[], meta: [string, string][]): Hit {
  const bb = bboxOf(pts);
  return { id, kind, label, x0: bb.x, y0: bb.y, x1: bb.x + bb.w, y1: bb.y + bb.h, meta };
}
