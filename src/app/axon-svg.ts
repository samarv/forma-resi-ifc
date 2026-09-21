/**
 * Offline axonometric fallback for the 3D tab: a true isometric projection of every
 * storey's wall / slab / column / roof footprints extruded by height, painted
 * back-to-front (by storey, then by depth). No WebGPU, no network.
 *
 * Projection: px = (x − y)·cos30, py = (x + y)·sin30 − z   (SVG y grows downward)
 */
import type { DesignModel, ModelElement, Rect, Vec2 } from '../core/types.ts';
import type { Drawing, Hit } from './plan-svg.ts';
import { elementFootprint } from './plan-svg.ts';
import { n3 } from './util.ts';

const C30 = Math.cos(Math.PI / 6);
const S30 = 0.5;

export function project(x: number, y: number, z: number): Vec2 {
  return [(x - y) * C30, (x + y) * S30 - z];
}

const SKIP_TYPES = /^(IfcSpace|IfcAnnotation|IfcOpeningElement|IfcGrid)/;
const DISC_COLOR: Record<string, string> = {
  architecture: 'var(--dwg-wall-ext)', structure: 'var(--dwg-struct)', mechanical: 'var(--dwg-mech)',
  plumbing: 'var(--dwg-plumb)', electrical: 'var(--dwg-elec)', site: 'var(--dwg-site)',
};

interface Item {
  el: ModelElement;
  pts: Vec2[];
  z0: number;
  h: number;
  depth: number;
  storeyIndex: number;
}

export function buildAxon(model: DesignModel, opts: { maxItems?: number } = {}): Drawing {
  const maxItems = opts.maxItems ?? 2400;
  const elev = new Map(model.storeys.map((s) => [s.id, s.elevation]));
  const sIdx = new Map(model.storeys.map((s) => [s.id, s.index]));

  const items: Item[] = [];
  for (const el of model.elements) {
    if (SKIP_TYPES.test(el.ifcType)) continue;
    const g = el.geometry;
    const h = heightOf(el);
    if (h === null) continue;
    const raw = elementFootprint(g);
    if (!raw || raw.length < 3) continue;
    const pts = ccw(raw); // back-face culling below needs a known winding
    const base = (elev.get(el.storey) ?? 0) + zOf(el);
    let cx = 0, cy = 0;
    for (const p of pts) { cx += p[0]; cy += p[1]; }
    cx /= pts.length; cy /= pts.length;
    items.push({ el, pts, z0: base, h, depth: cx + cy + base, storeyIndex: sIdx.get(el.storey) ?? 0 });
  }

  // priority: keep the elements that define the form when we have to cut
  items.sort((a, b) => prio(a.el) - prio(b.el));
  const kept = items.slice(0, maxItems);
  kept.sort((a, b) => (a.storeyIndex - b.storeyIndex) || (a.depth - b.depth));

  const body: string[] = [];
  const hits: Hit[] = [];
  let dx0 = Infinity, dy0 = Infinity, dx1 = -Infinity, dy1 = -Infinity;
  const grow = (p: Vec2) => {
    if (p[0] < dx0) dx0 = p[0];
    if (p[1] < dy0) dy0 = p[1];
    if (p[0] > dx1) dx1 = p[0];
    if (p[1] > dy1) dy1 = p[1];
  };

  for (const it of kept) {
    const color = DISC_COLOR[it.el.discipline] ?? 'var(--dwg-outline)';
    const top = it.pts.map((p) => project(p[0], p[1], it.z0 + it.h));
    const bot = it.pts.map((p) => project(p[0], p[1], it.z0));
    for (const p of top) grow(p);
    for (const p of bot) grow(p);

    let sides = '';
    if (it.h > 0.02) {
      for (let i = 0; i < it.pts.length; i++) {
        const j = (i + 1) % it.pts.length;
        // Only the two faces turned toward the viewer are drawn (back-face cull):
        // the outward edge normal must point toward +X/+Y in projected space.
        const ax = it.pts[i][0], ay = it.pts[i][1], bx = it.pts[j][0], by = it.pts[j][1];
        const ex = bx - ax, ey = by - ay;
        if (ex - ey > 0) continue; // edge facing away
        sides += `M${n3(bot[i][0])} ${n3(bot[i][1])}L${n3(bot[j][0])} ${n3(bot[j][1])}L${n3(top[j][0])} ${n3(top[j][1])}L${n3(top[i][0])} ${n3(top[i][1])}Z`;
      }
    }
    if (sides) {
      body.push(`<path d="${sides}" fill="${color}" fill-opacity="0.45" stroke="${color}" stroke-opacity="0.35" stroke-width="0.02"/>`);
    }
    body.push(`<path d="${poly(top)}" fill="${color}" fill-opacity="${it.h > 0.02 ? 0.8 : 0.3}" stroke="${color}" stroke-opacity="0.5" stroke-width="0.02"/>`);

    // hit box in the viewport's (dx, -dy) space
    let hx0 = Infinity, hy0 = Infinity, hx1 = -Infinity, hy1 = -Infinity;
    for (const p of [...top, ...bot]) {
      hx0 = Math.min(hx0, p[0]); hx1 = Math.max(hx1, p[0]);
      hy0 = Math.min(hy0, -p[1]); hy1 = Math.max(hy1, -p[1]);
    }
    hits.push({
      id: it.el.id, kind: it.el.ifcType, label: `${it.el.name} (${it.el.storey})`,
      x0: hx0, y0: hy0, x1: hx1, y1: hy1,
      meta: [
        ['IFC', it.el.ifcType], ['Discipline', it.el.discipline], ['Storey', it.el.storey],
        ['Base Z', `${it.z0.toFixed(2)} m`], ['Height', `${it.h.toFixed(2)} m`],
        ...(it.el.unitId ? [['Unit', it.el.unitId] as [string, string]] : []),
      ],
    });
  }

  if (!Number.isFinite(dx0)) { dx0 = 0; dy0 = 0; dx1 = 20; dy1 = 20; }
  const bounds: Rect = { x: dx0, y: -dy1, w: Math.max(dx1 - dx0, 1), h: Math.max(dy1 - dy0, 1) };
  return {
    body: body.join(''),
    defs: '',
    hits,
    bounds,
    counts: { drawn: kept.length, total: items.length },
  };
}

/** Counter-clockwise winding, so an edge's outward normal is (dy, −dx). */
export function ccw(pts: Vec2[]): Vec2[] {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
  }
  return a < 0 ? [...pts].reverse() : pts;
}

function poly(pts: Vec2[]): string {
  let d = `M${n3(pts[0][0])} ${n3(pts[0][1])}`;
  for (let i = 1; i < pts.length; i++) d += `L${n3(pts[i][0])} ${n3(pts[i][1])}`;
  return `${d}Z`;
}

function zOf(el: ModelElement): number {
  const g = el.geometry;
  switch (g.kind) {
    case 'wall': return g.start[2] ?? 0;
    case 'slab': case 'prism': case 'column': case 'box': case 'instance':
    case 'roof': case 'gable-roof': case 'ramp':
      return g.position[2] ?? 0;
    case 'beam': case 'axis': case 'railing': return g.start[2] ?? 0;
    case 'footing': return (g.position[2] ?? 0) - g.height;
    case 'pile': return (g.position[2] ?? 0) - g.length;
    case 'stair': return g.position[2] ?? 0;
    default: return 0;
  }
}

function heightOf(el: ModelElement): number | null {
  const g = el.geometry;
  switch (g.kind) {
    case 'wall': return g.height;
    case 'slab': return g.thickness;
    case 'column': return g.height;
    case 'box': return g.height;
    // A mapped-item occurrence draws as the extruded footprint prism: the right
    // silhouette at one prism per item, rather than 3-8 in a 2400-item budget.
    case 'instance': return g.height;
    case 'prism': return g.height;
    case 'beam': return g.height;
    case 'roof': case 'gable-roof': return g.thickness;
    case 'footing': return g.height;
    case 'pile': return g.length;
    case 'ramp': return g.thickness;
    case 'stair': return g.risers * g.riserHeight;
    case 'axis': return g.profile.type === 'circle' ? g.profile.radius * 2 : g.profile.height;
    case 'railing': return g.height;
    default: return null;
  }
}

function prio(el: ModelElement): number {
  if (el.geometry.kind === 'wall') return el.ifcType === 'IfcWall' ? 0 : 1;
  if (el.geometry.kind === 'slab' || el.geometry.kind === 'roof' || el.geometry.kind === 'gable-roof') return 1;
  if (el.geometry.kind === 'column') return 2;
  if (el.discipline === 'site') return 3;
  if (el.geometry.kind === 'beam') return 4;
  if (el.geometry.kind === 'box' || el.geometry.kind === 'instance') return 6;
  return 5;
}
