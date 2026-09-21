/**
 * 2D storey plan built from the DesignModel (never from the IFC text).
 *
 * Everything is batched: one <path> per layer/colour bucket, so a 20-storey tower
 * plan with a few thousand elements builds in a handful of milliseconds. Labels and
 * grid bubbles are the only per-object nodes.
 *
 * Output coordinates are drawing coordinates (world X, negated world Y) so +Y is up.
 */
import type {
  DesignModel, ElementGeometry, ModelElement, Rect, RoomDef, Vec2, WallDef, Zone,
} from '../core/types.ts';
import type { DisplayUnits } from '../core/units.ts';
import type { Layers } from './state.ts';
import {
  arcPath, bboxOf, boxQuad, circlePath, hatchDefs, linePath, pathEl, polyPath, rectPath,
  starPath, text, unionRect, wallQuad,
} from './svg.ts';
import { fmtArea, humanize, n3, slotFor } from './util.ts';
import { doorOperation, hingePoint, latchPoint, leafTip, swingArc, swingNormal } from '../core/openings.ts';
import { stretchKey, typeById } from '../core/furniture-3d.ts';

export interface Hit {
  id: string;
  kind: string;
  label: string;
  x0: number; y0: number; x1: number; y1: number;
  meta: [string, string][];
}

export interface Drawing {
  /** inner markup of the camera group */
  body: string;
  defs: string;
  hits: Hit[];
  bounds: Rect;
  counts: Record<string, number>;
}

/** Linework strokes stay at a constant pixel weight at any zoom. */
const HAIR = { 'vector-effect': 'non-scaling-stroke' } as const;

type Bucket = Map<string, string[]>;
function bput(b: Bucket, key: string, d: string): void {
  const a = b.get(key);
  if (a) a.push(d); else b.set(key, [d]);
}

const ZONE_FILL: Record<Zone, string> = {
  public: 'var(--dwg-room-pub)',
  private: 'var(--dwg-room-priv)',
  service: 'var(--dwg-room-serv)',
  circulation: 'var(--dwg-room-circ)',
  outdoor: 'var(--dwg-room-out)',
};

const WALL_FILL: Record<string, string> = {
  exterior: 'var(--dwg-wall-ext)',
  parapet: 'var(--dwg-wall-ext)',
  retaining: 'var(--dwg-wall-ext)',
  party: 'var(--dwg-wall-party)',
  core: 'var(--dwg-wall-core)',
  shaft: 'var(--dwg-wall-core)',
  corridor: 'var(--dwg-wall-party)',
  partition: 'var(--dwg-wall-part)',
  wet: 'var(--dwg-wall-part)',
  balcony: 'var(--dwg-wall-part)',
};

const PIPE_COLOR: Record<string, string> = {
  dcw: 'var(--s1)', dhw: 'var(--s8)', hwr: 'var(--s5)', waste: 'var(--s7)', vent: 'var(--ink-3)',
  storm: 'var(--s3)', sprinkler: 'var(--s8)', standpipe: 'var(--s2)', gas: 'var(--s4)',
};

// element index cache (id → element) so tooltips can show psets/patterns
const elIndexCache = new WeakMap<DesignModel, Map<string, ModelElement>>();
export function elementIndex(model: DesignModel): Map<string, ModelElement> {
  let m = elIndexCache.get(model);
  if (!m) {
    m = new Map(model.elements.map((e) => [e.id, e]));
    elIndexCache.set(model, m);
  }
  return m;
}

/** Plan footprint of any element geometry, in world coordinates. */
export function elementFootprint(g: ElementGeometry): Vec2[] | null {
  switch (g.kind) {
    case 'wall':
      return wallQuad([g.start[0], g.start[1]], [g.end[0], g.end[1]], g.thickness);
    case 'beam':
      return wallQuad([g.start[0], g.start[1]], [g.end[0], g.end[1]], g.width);
    case 'railing':
      return wallQuad([g.start[0], g.start[1]], [g.end[0], g.end[1]], g.width ?? 0.06);
    case 'axis': {
      const w = g.profile.type === 'circle' ? g.profile.radius * 2 : g.profile.width;
      return wallQuad([g.start[0], g.start[1]], [g.end[0], g.end[1]], w);
    }
    case 'slab':
    case 'prism':
      return g.profile.map((p) => [g.position[0] + p[0], g.position[1] + p[1]] as Vec2);
    case 'column':
      return boxQuad(g.position[0] - g.width / 2, g.position[1] - g.depth / 2, g.width, g.depth, 0);
    case 'box':
    // A mapped-item occurrence carries its own placed footprint, so the plan
    // never has to resolve the furniture type just to draw an outline.
    case 'instance':
      return boxQuad(g.position[0], g.position[1], g.width, g.depth, g.rotation ?? 0);
    case 'footing':
      return boxQuad(g.position[0] - g.width / 2, g.position[1] - g.depth / 2, g.width, g.depth, 0);
    case 'pile':
      return boxQuad(g.position[0] - g.diameter / 2, g.position[1] - g.diameter / 2, g.diameter, g.diameter, 0);
    case 'roof':
    case 'gable-roof':
      return boxQuad(g.position[0], g.position[1], g.width, g.depth, 0);
    case 'ramp':
      return boxQuad(g.position[0], g.position[1], g.width, g.length, 0);
    case 'stair':
      return boxQuad(g.position[0], g.position[1], g.width, g.risers * g.tread, g.direction - Math.PI / 2);
    default:
      return null;
  }
}

function hitFromPoints(id: string, kind: string, label: string, pts: Vec2[], meta: [string, string][]): Hit {
  const b = bboxOf(pts);
  return { id, kind, label, x0: b.x, y0: b.y, x1: b.x + b.w, y1: b.y + b.h, meta };
}

function elMeta(model: DesignModel, id: string, extra: [string, string][] = []): [string, string][] {
  const e = elementIndex(model).get(id);
  const meta: [string, string][] = [...extra];
  if (e) {
    meta.push(['IFC', e.ifcType + (e.predefinedType ? ` · ${e.predefinedType}` : '')]);
    if (e.system) meta.push(['System', e.system]);
    if (e.unitId && !extra.some(([k]) => k === 'Unit')) meta.push(['Unit', e.unitId]);
    if (e.roomId && !extra.some(([k]) => k === 'Room')) meta.push(['Room', e.roomId]);
    if (e.patterns?.length) meta.push(['Patterns', e.patterns.join(', ')]);
  }
  return meta;
}

// ---------------------------------------------------------------------------

export function buildPlan(
  model: DesignModel, storeyId: string, layers: Layers, units: DisplayUnits, highlight: string | null,
): Drawing {
  const out: string[] = [];
  const hits: Hit[] = [];
  const counts: Record<string, number> = {};
  let bounds: Rect | null = null;
  const grow = (pts: Vec2[]) => { bounds = unionRect(bounds, bboxOf(pts)); };

  const arch = model.arch;
  const floor = arch?.floors?.find((f) => f.storey === storeyId) ?? null;
  const storey = model.storeys.find((s) => s.id === storeyId);
  const labelsOn = layers.labels;

  // ---- site boundary for context. It only drives the fit on storeys that have no
  // floor plan (SITE/FND), otherwise a 78 m site would shrink the plan to a stamp.
  if (model.site?.boundary?.length) {
    if (!floor) grow(model.site.boundary);
    out.push(`<g class="l-site-ctx">${pathEl(polyPath(model.site.boundary), {
      fill: 'none', stroke: 'var(--dwg-grid)', 'stroke-width': 1, 'stroke-dasharray': '6 4',
      'vector-effect': 'non-scaling-stroke', opacity: 0.8,
    })}</g>`);
  }

  // ---- floor outline
  if (floor?.outline?.length) {
    grow(floor.outline);
    out.push(`<g class="l-outline">${pathEl(polyPath(floor.outline), {
      fill: 'var(--dwg-bg)', stroke: 'var(--dwg-outline)', 'stroke-width': 1.4, 'vector-effect': 'non-scaling-stroke',
    })}</g>`);
  }

  // ---- rooms
  if (layers.rooms && arch) {
    const fills: Bucket = new Map();
    const labels: string[] = [];
    const unitTpl = new Map(arch.units.map((u) => [u.id, u.templateId]));
    for (const r of arch.rooms) {
      if (r.storey !== storeyId) continue;
      const pts = r.polygon?.length ? r.polygon : rectPts(r.rect);
      grow(pts);
      const key = r.unitId ? `unit:${slotFor(String(unitTpl.get(r.unitId) ?? r.unitId))}` : `zone:${r.zone}`;
      bput(fills, key, polyPath(pts));
      counts.rooms = (counts.rooms ?? 0) + 1;
      hits.push(hitFromPoints(r.id, 'Room', `${r.name} · ${fmtArea(r.area, units)}`, pts, [
        ['Type', humanize(r.type)], ['Zone', r.zone], ['Area', fmtArea(r.area, units)],
        ...(r.unitId ? [['Unit', r.unitId] as [string, string]] : []),
        ...(r.unitId ? [['Template', String(unitTpl.get(r.unitId) ?? '—')] as [string, string]] : []),
      ]));
      if (labelsOn && r.area > 1.2) {
        // Measure before placing: a label that does not fit is dropped, never clipped.
        const c = centroid(pts);
        const w = r.rect?.w ?? bboxOf(pts).w;
        const name = fits(r.name, 0.52, w) ? r.name : shortName(r.name, 0.52, w);
        const area = fmtArea(r.area, units);
        const twoLines = (r.rect?.h ?? bboxOf(pts).h) > 1.5;
        if (name) labels.push(text(c[0], c[1] + (twoLines ? 0.28 : 0.05), name, { size: 0.52, weight: 550 }));
        if (twoLines && fits(area, 0.42, w)) {
          labels.push(text(c[0], c[1] - 0.34, area, { size: 0.42, fill: 'var(--ink-3)' }));
        }
      }
    }
    const body: string[] = [];
    for (const [key, ds] of fills) {
      const fill = key.startsWith('unit:') ? `var(--s${key.slice(5)})` : ZONE_FILL[key.slice(5) as Zone] ?? 'var(--dwg-room)';
      body.push(pathEl(ds.join(''), {
        fill, 'fill-opacity': key.startsWith('unit:') ? 0.16 : 1, stroke: 'none', 'fill-rule': 'evenodd',
      }));
    }
    out.push(`<g class="l-rooms">${body.join('')}</g>`);
    if (labels.length) out.push(`<g class="l-room-labels" pointer-events="none">${labels.join('')}</g>`);
  }

  // ---- hatched circulation: corridors, cores, shafts
  if (layers.arch && arch) {
    const hatch: string[] = [];
    for (const c of floor?.corridors ?? []) {
      const pts = c.polygon?.length ? c.polygon : [];
      if (pts.length) { hatch.push(polyPath(pts)); grow(pts); }
    }
    const coreD: string[] = [];
    for (const core of arch.cores ?? []) {
      if (!core.storeys.includes(storeyId)) continue;
      coreD.push(rectPath(core.rect));
      grow(rectPts(core.rect));
      hits.push(hitFromPoints(core.id, 'Core', `${humanize(core.type)} core`, rectPts(core.rect), [
        ['Type', humanize(core.type)], ['Stairs', String(core.stairIds.length)], ['Lifts', String(core.elevatorIds.length)],
        ['Exit', core.isExit ? 'yes' : 'no'],
      ]));
    }
    const shaftD: string[] = [];
    for (const sh of arch.shafts ?? []) {
      if (!sh.storeys.includes(storeyId)) continue;
      shaftD.push(rectPath(sh.rect));
      grow(rectPts(sh.rect));
      hits.push(hitFromPoints(sh.id, 'Shaft', `${humanize(sh.purpose)} shaft`, rectPts(sh.rect), [
        ['Purpose', humanize(sh.purpose)], ['Serves', `${sh.servesUnitIds.length} units`], ['Access', sh.accessFrom],
      ]));
    }
    const g: string[] = [];
    if (hatch.length) g.push(pathEl(hatch.join(''), { fill: 'url(#hx2)', stroke: 'none' }));
    if (coreD.length) g.push(pathEl(coreD.join(''), { fill: 'url(#hx)', stroke: 'var(--dwg-wall-core)', 'stroke-width': 1, ...HAIR }));
    if (shaftD.length) g.push(pathEl(shaftD.join(''), { fill: 'url(#hx)', stroke: 'var(--dwg-wall-core)', 'stroke-width': 1, ...HAIR }));
    if (g.length) out.push(`<g class="l-circ">${g.join('')}</g>`);
  }

  // ---- walls + openings
  const wallIdx = new Map<string, WallDef>();
  if (layers.arch && arch) {
    const walls: Bucket = new Map();
    for (const w of arch.walls) {
      if (w.storey !== storeyId) continue;
      wallIdx.set(w.id, w);
      const pts = wallQuad(w.start, w.end, w.thickness);
      grow(pts);
      bput(walls, w.type, polyPath(pts));
      counts.walls = (counts.walls ?? 0) + 1;
      hits.push(hitFromPoints(w.id, 'Wall', `${humanize(w.type)} wall ${w.thickness.toFixed(2)} m`, pts,
        elMeta(model, w.id, [
          ['Type', humanize(w.type)], ['Thickness', `${w.thickness.toFixed(3)} m`], ['Height', `${w.height.toFixed(2)} m`],
          ['External', w.isExternal ? 'yes' : 'no'],
          ...(w.fireRating ? [['Fire', w.fireRating] as [string, string]] : []),
        ])));
    }
    const body: string[] = [];
    for (const [type, ds] of walls) {
      body.push(pathEl(ds.join(''), { fill: WALL_FILL[type] ?? 'var(--dwg-wall-part)', stroke: 'none' }));
    }
    out.push(`<g class="l-walls">${body.join('')}</g>`);

    // openings punched with the background colour, then door/window symbols
    const cut: string[] = [];
    const leaf: string[] = [];
    const arcs: string[] = [];
    for (const d of arch.doors) {
      if (d.storey !== storeyId) continue;
      const w = wallIdx.get(d.wallId);
      if (!w) continue;
      const { a, b } = along(w, d.along, d.width);
      cut.push(polyPath(wallQuad(a, b, w.thickness * 1.6)));
      // hinge, leaf and arc all come from the stored motion/hinge/swing (core/openings.ts) — nothing is
      // inferred from the wall normal, and only a swing leaf gets a leaf line plus a quarter arc
      const hinge = hingePoint(d, w);
      const tip = leafTip(d, w);
      const arc = swingArc(d, w);
      if (arc) {
        leaf.push(linePath(hinge, tip));
        arcs.push(arcPath(arc.centre[0], arc.centre[1], arc.radius, arc.fromAngle, arc.toAngle));
      } else if (d.motion === 'sliding' || d.motion === 'folding') {
        // a sliding or folding leaf parks parallel to the wall on the side its pocket is on
        const n = swingNormal(d, w) ?? [0, 0];
        const off = Math.max(0.04, w.thickness * 0.35);
        const latch = latchPoint(d, w);
        leaf.push(linePath([hinge[0] + n[0] * off, hinge[1] + n[1] * off], [latch[0] + n[0] * off, latch[1] + n[1] * off]));
      }
      // 'rolling' and 'opening' draw the break in the wall only
      counts.doors = (counts.doors ?? 0) + 1;
      hits.push(hitFromPoints(d.id, 'Door', `${humanize(d.type)} ${d.width.toFixed(2)}×${d.height.toFixed(2)} m`,
        arc ? [a, b, tip] : [a, b], elMeta(model, d.id, [
          ['Type', humanize(d.type)], ['Operation', doorOperation(d)], ['Host wall', d.wallId],
          ...(d.fireRated ? [['Fire rated', 'yes'] as [string, string]] : []),
        ])));
    }
    const winL: string[] = [];
    for (const wd of arch.windows) {
      if (wd.storey !== storeyId) continue;
      const w = wallIdx.get(wd.wallId);
      if (!w) continue;
      const { a, b, nrm } = along(w, wd.along, wd.width);
      cut.push(polyPath(wallQuad(a, b, w.thickness * 1.5)));
      const o = w.thickness * 0.3;
      winL.push(linePath([a[0] + nrm[0] * o, a[1] + nrm[1] * o], [b[0] + nrm[0] * o, b[1] + nrm[1] * o]));
      winL.push(linePath([a[0] - nrm[0] * o, a[1] - nrm[1] * o], [b[0] - nrm[0] * o, b[1] - nrm[1] * o]));
      counts.windows = (counts.windows ?? 0) + 1;
      hits.push(hitFromPoints(wd.id, 'Window', `Window ${wd.width.toFixed(2)}×${wd.height.toFixed(2)} m`, [a, b],
        elMeta(model, wd.id, [['Sill', `${wd.sill.toFixed(2)} m`], ['Host wall', wd.wallId], ['Room', wd.roomId]])));
    }
    out.push(`<g class="l-openings">
      ${pathEl(cut.join(''), { fill: 'var(--dwg-bg)', stroke: 'none' })}
      ${pathEl(leaf.join(''), { fill: 'none', stroke: 'var(--dwg-open)', 'stroke-width': 1.4, ...HAIR })}
      ${pathEl(arcs.join(''), { fill: 'none', stroke: 'var(--dwg-open)', 'stroke-width': 1, ...HAIR, opacity: 0.75 })}
      ${pathEl(winL.join(''), { fill: 'none', stroke: 'var(--dwg-open)', 'stroke-width': 1.2, ...HAIR })}
    </g>`);
  }

  // ---- furniture
  // Every item draws the top-view SYMBOL of its 3D type (a bed reads as frame +
  // pillows, a WC as bowl + cistern), transformed per instance into the same
  // batched path as the footprint outline — so the layer is still one <path> and
  // the letter glyphs are gone. `low` detail keeps the footprint ring only.
  if (layers.furniture && arch?.furniture?.length) {
    const outl: string[] = [];
    const symbolsOn = model.spec.options?.detail !== 'low';
    for (const f of arch.furniture) {
      if (f.storey !== storeyId) continue;
      const pts = boxQuad(f.position[0], f.position[1], f.width, f.depth, f.rotation);
      grow(pts);
      outl.push(polyPath(pts));
      counts.furniture = (counts.furniture ?? 0) + 1;
      const type3d = symbolsOn ? typeById(stretchKey(f.type, f.width)) : undefined;
      if (type3d) {
        const cos = Math.cos(f.rotation);
        const sin = Math.sin(f.rotation);
        for (const ring of type3d.symbol) {
          outl.push(polyPath(ring.map(p => [
            f.position[0] + p[0] * cos - p[1] * sin,
            f.position[1] + p[0] * sin + p[1] * cos,
          ] as Vec2)));
        }
      }
      hits.push(hitFromPoints(f.id, 'Furniture', humanize(f.type), pts, elMeta(model, f.id, [
        ['Type', humanize(f.type)], ['Size', `${f.width.toFixed(2)} × ${f.depth.toFixed(2)} m`],
        ...(f.needsWater ? [['Needs water', 'yes'] as [string, string]] : []),
        ...(f.needsPower ? [['Needs power', 'yes'] as [string, string]] : []),
      ])));
    }
    out.push(`<g class="l-furn">${pathEl(outl.join(''), {
      fill: 'none', stroke: 'var(--dwg-wall-part)', 'stroke-width': 0.9, ...HAIR, opacity: 0.95,
    })}</g>`);
  }

  // ---- structure
  if (layers.struct && model.struct) {
    const s = model.struct;
    const g: string[] = [];
    if (layers.grid && s.grid?.length && bounds) {
      const b = bounds as Rect;
      const gl: string[] = [];
      const bub: string[] = [];
      for (const line of s.grid) {
        if (line.axis === 'x') {
          gl.push(linePath([line.offset, b.y - 1.5], [line.offset, b.y + b.h + 1.5]));
          bub.push(pathEl(circlePath(line.offset, b.y + b.h + 2.1, 0.55), { fill: 'var(--dwg-bg)', stroke: 'var(--dwg-grid)', 'stroke-width': 1, ...HAIR }));
          bub.push(text(line.offset, b.y + b.h + 1.92, line.id, { size: 0.5, fill: 'var(--dwg-grid)', weight: 600 }));
        } else {
          gl.push(linePath([b.x - 1.5, line.offset], [b.x + b.w + 1.5, line.offset]));
          bub.push(pathEl(circlePath(b.x - 2.1, line.offset, 0.55), { fill: 'var(--dwg-bg)', stroke: 'var(--dwg-grid)', 'stroke-width': 1, ...HAIR }));
          bub.push(text(b.x - 2.1, line.offset - 0.18, line.id, { size: 0.5, fill: 'var(--dwg-grid)', weight: 600 }));
        }
      }
      g.push(pathEl(gl.join(''), { fill: 'none', stroke: 'var(--dwg-grid)', 'stroke-width': 1, 'stroke-dasharray': '14 4 2 4', ...HAIR, opacity: 0.85 }));
      g.push(bub.join(''));
      // keep the bubbles inside the fitted view
      grow([[b.x - 2.8, b.y - 1.6], [b.x + b.w + 1.6, b.y + b.h + 2.8]]);
    }
    const cols: string[] = [];
    for (const c of s.columns ?? []) {
      if (c.storey !== storeyId) continue;
      const pts = boxQuad(c.position[0] - c.width / 2, c.position[1] - c.depth / 2, c.width, c.depth, 0);
      grow(pts);
      cols.push(polyPath(pts));
      counts.columns = (counts.columns ?? 0) + 1;
      hits.push(hitFromPoints(c.id, 'Column', `Column ${c.gridRef}`, pts, elMeta(model, c.id, [
        ['Grid', c.gridRef], ['Size', `${c.width.toFixed(2)} × ${c.depth.toFixed(2)} m`], ['Material', c.material],
      ])));
    }
    const bms: string[] = [];
    for (const bm of s.beams ?? []) {
      if (bm.storey !== storeyId) continue;
      bms.push(linePath(bm.start, bm.end));
      counts.beams = (counts.beams ?? 0) + 1;
      hits.push(hitFromPoints(bm.id, 'Beam', `${humanize(bm.role)} beam ${bm.width.toFixed(2)}×${bm.depth.toFixed(2)}`,
        wallQuad(bm.start, bm.end, Math.max(bm.width, 0.2)), elMeta(model, bm.id, [
          ['Role', humanize(bm.role)], ['Material', bm.material],
        ])));
    }
    const sw: string[] = [];
    for (const w of s.walls ?? []) {
      if (w.storey !== storeyId) continue;
      sw.push(polyPath(wallQuad(w.start, w.end, w.thickness)));
      hits.push(hitFromPoints(w.id, 'Struct wall', `${humanize(w.role)} wall`, wallQuad(w.start, w.end, w.thickness),
        elMeta(model, w.id, [['Role', humanize(w.role)], ['Material', w.material]])));
    }
    g.push(pathEl(bms.join(''), { fill: 'none', stroke: 'var(--dwg-struct)', 'stroke-width': 1.8, 'stroke-dasharray': '7 4', ...HAIR, opacity: 0.85 }));
    g.push(pathEl(sw.join(''), { fill: 'var(--dwg-struct)', 'fill-opacity': 0.25, stroke: 'var(--dwg-struct)', 'stroke-width': 1, ...HAIR }));
    g.push(pathEl(cols.join(''), { fill: 'var(--dwg-struct)', stroke: 'none' }));
    out.push(`<g class="l-struct">${g.join('')}</g>`);
  }

  // ---- mechanical
  if (layers.mech && model.mech) {
    const m = model.mech;
    const runs: Bucket = new Map();
    for (const d of m.ducts ?? []) {
      if (d.storey !== storeyId || d.path.length < 2) continue;
      const w = Math.max(0.08, Math.min(0.9, d.shape === 'round' ? d.width : Math.max(d.width, d.height)));
      bput(runs, w.toFixed(2), polyPath(d.path.map((p) => [p[0], p[1]] as Vec2), false));
      counts.ducts = (counts.ducts ?? 0) + 1;
      const pts = d.path.map((p) => [p[0], p[1]] as Vec2);
      grow(pts);
      hits.push(hitFromPoints(d.id, 'Duct', `${humanize(d.systemType)} duct ${(d.width * 1000).toFixed(0)}×${(d.height * 1000).toFixed(0)}`,
        pts, elMeta(model, d.id, [['System', humanize(d.systemType)], ['Shape', d.shape], ['Serves', `${d.servesRoomIds.length} rooms`]])));
    }
    const terms: string[] = [];
    for (const t of m.terminals ?? []) {
      if (t.storey !== storeyId) continue;
      const pts = boxQuad(t.position[0] - t.width / 2, t.position[1] - t.depth / 2, t.width, t.depth, 0);
      terms.push(polyPath(pts));
      counts.terminals = (counts.terminals ?? 0) + 1;
      hits.push(hitFromPoints(t.id, 'Air terminal', `${humanize(t.type)} ${t.airflowLs.toFixed(0)} L/s`, pts,
        elMeta(model, t.id, [['Type', humanize(t.type)], ['Airflow', `${t.airflowLs.toFixed(0)} L/s`], ['Room', t.roomId]])));
    }
    const eq: string[] = [];
    for (const e of m.equipment ?? []) {
      if (e.storey !== storeyId) continue;
      const pts = boxQuad(e.position[0], e.position[1], e.width, e.depth, e.rotation);
      eq.push(polyPath(pts));
      counts.mechEquipment = (counts.mechEquipment ?? 0) + 1;
      hits.push(hitFromPoints(e.id, 'Mech equipment', humanize(e.type), pts, elMeta(model, e.id, [
        ['Type', humanize(e.type)], ...(e.capacityKw ? [['Capacity', `${e.capacityKw} kW`] as [string, string]] : []),
      ])));
    }
    const g: string[] = [];
    for (const [w, ds] of runs) {
      g.push(pathEl(ds.join(''), {
        fill: 'none', stroke: 'var(--dwg-mech)', 'stroke-width': w, 'stroke-opacity': 0.32,
        'stroke-linejoin': 'round', 'stroke-linecap': 'butt',
      }));
      g.push(pathEl(ds.join(''), { fill: 'none', stroke: 'var(--dwg-mech)', 'stroke-width': 1, ...HAIR, 'stroke-opacity': 0.9 }));
    }
    g.push(pathEl(terms.join(''), { fill: 'var(--dwg-mech)', 'fill-opacity': 0.5, stroke: 'var(--dwg-mech)', 'stroke-width': 1, ...HAIR }));
    g.push(pathEl(eq.join(''), { fill: 'var(--dwg-mech)', 'fill-opacity': 0.18, stroke: 'var(--dwg-mech)', 'stroke-width': 1.2, ...HAIR }));
    out.push(`<g class="l-mech">${g.join('')}</g>`);
  }

  // ---- plumbing
  if (layers.plumb && model.plumb) {
    const p = model.plumb;
    const runs: Bucket = new Map();
    for (const r of p.pipes ?? []) {
      if (r.storey !== storeyId || r.path.length < 2) continue;
      bput(runs, r.system, polyPath(r.path.map((x) => [x[0], x[1]] as Vec2), false));
      counts.pipes = (counts.pipes ?? 0) + 1;
      const pts = r.path.map((x) => [x[0], x[1]] as Vec2);
      hits.push(hitFromPoints(r.id, 'Pipe', `${r.system.toUpperCase()} Ø${(r.diameter * 1000).toFixed(0)} mm`, pts,
        elMeta(model, r.id, [['System', r.system.toUpperCase()], ['Diameter', `${(r.diameter * 1000).toFixed(0)} mm`],
          ...(r.stackId ? [['Stack', r.stackId] as [string, string]] : [])])));
    }
    const fx: string[] = [];
    for (const f of p.fixtures ?? []) {
      if (f.storey !== storeyId) continue;
      const r = Math.max(0.12, Math.min(f.width, f.depth) / 2);
      fx.push(circlePath(f.position[0], f.position[1], r));
      counts.fixtures = (counts.fixtures ?? 0) + 1;
      hits.push(hitFromPoints(f.id, 'Plumbing fixture', humanize(f.type),
        [[f.position[0] - r, f.position[1] - r], [f.position[0] + r, f.position[1] + r]],
        elMeta(model, f.id, [['Type', humanize(f.type)], ['DFU', String(f.dfu)], ['WSFU', String(f.wsfu)],
          ['Connections', f.connections.join(', ')]])));
    }
    const stk: string[] = [];
    const stkT: string[] = [];
    for (const s of p.stacks ?? []) {
      stk.push(circlePath(s.xy[0], s.xy[1], 0.16));
      stkT.push(text(s.xy[0], s.xy[1] - 0.12, 'S', { size: 0.26, fill: 'var(--dwg-bg)', weight: 700 }));
      hits.push(hitFromPoints(s.id, 'Stack', `Stack ${s.systems.join('/')}`,
        [[s.xy[0] - 0.2, s.xy[1] - 0.2], [s.xy[0] + 0.2, s.xy[1] + 0.2]],
        [['Systems', s.systems.join(', ')], ['From', s.fromStorey], ['To', s.toStorey], ['Serves', `${s.servesUnitIds.length} units`]]));
    }
    const g: string[] = [];
    for (const [sys, ds] of runs) {
      g.push(pathEl(ds.join(''), { fill: 'none', stroke: PIPE_COLOR[sys] ?? 'var(--dwg-plumb)', 'stroke-width': 1.8, ...HAIR, 'stroke-linejoin': 'round' }));
    }
    g.push(pathEl(fx.join(''), { fill: 'var(--dwg-plumb)', 'fill-opacity': 0.35, stroke: 'var(--dwg-plumb)', 'stroke-width': 1, ...HAIR }));
    g.push(pathEl(stk.join(''), { fill: 'var(--dwg-plumb)', stroke: 'none' }));
    out.push(`<g class="l-plumb">${g.join('')}${stkT.join('')}</g>`);
  }

  // ---- electrical
  if (layers.elec && model.elec) {
    const e = model.elec;
    const glyph: string[] = [];
    const lights: string[] = [];
    const letters: string[] = [];
    for (const d of e.devices ?? []) {
      if (d.storey !== storeyId) continue;
      const [x, y] = [d.position[0], d.position[1]];
      counts.elecDevices = (counts.elecDevices ?? 0) + 1;
      if (d.type.startsWith('light')) {
        lights.push(starPath(x, y, 0.17));
      } else if (d.type === 'switch' || d.type === 'dimmer') {
        letters.push(text(x, y - 0.1, 'S', { size: 0.3, fill: 'var(--dwg-elec)', weight: 700 }));
      } else if (d.type.includes('alarm') || d.type.includes('detector')) {
        letters.push(text(x, y - 0.1, 'SD', { size: 0.26, fill: 'var(--dwg-elec)', weight: 700 }));
      } else if (d.type === 'thermostat') {
        letters.push(text(x, y - 0.1, 'T', { size: 0.28, fill: 'var(--dwg-elec)', weight: 700 }));
      } else {
        // receptacle: ⊥ symbol (semicircle + stem)
        glyph.push(`M${n3(x - 0.14)} ${n3(-y)}L${n3(x + 0.14)} ${n3(-y)}M${n3(x)} ${n3(-y)}L${n3(x)} ${n3(-y - 0.16)}`);
      }
      hits.push(hitFromPoints(d.id, 'Electrical device', humanize(d.type),
        [[x - 0.14, y - 0.14], [x + 0.14, y + 0.14]],
        elMeta(model, d.id, [['Type', humanize(d.type)], ...(d.circuitId ? [['Circuit', d.circuitId] as [string, string]] : []),
          ...(d.watts ? [['Watts', String(d.watts)] as [string, string]] : [])])));
    }
    const panels: string[] = [];
    for (const p of e.panels ?? []) {
      if (p.storey !== storeyId) continue;
      const pts = boxQuad(p.position[0], p.position[1], p.width, Math.max(p.depth, 0.12), p.rotation);
      panels.push(polyPath(pts));
      counts.panels = (counts.panels ?? 0) + 1;
      hits.push(hitFromPoints(p.id, 'Panel', `${humanize(p.type)} ${p.amps} A`, pts, elMeta(model, p.id, [
        ['Type', humanize(p.type)], ['Amps', String(p.amps)], ['Voltage', p.voltage], ['Circuits', String(p.circuitCount)],
      ])));
    }
    const trays: string[] = [];
    for (const t of e.trays ?? []) {
      if (t.storey !== storeyId || t.path.length < 2) continue;
      trays.push(polyPath(t.path.map((x) => [x[0], x[1]] as Vec2), false));
      counts.trays = (counts.trays ?? 0) + 1;
      hits.push(hitFromPoints(t.id, 'Cable tray', `${humanize(t.purpose)} tray ${(t.width * 1000).toFixed(0)} mm`,
        t.path.map((x) => [x[0], x[1]] as Vec2), elMeta(model, t.id, [['Purpose', humanize(t.purpose)]])));
    }
    out.push(`<g class="l-elec">
      ${pathEl(trays.join(''), { fill: 'none', stroke: 'var(--dwg-elec)', 'stroke-width': 2.2, ...HAIR, 'stroke-opacity': 0.8 })}
      ${pathEl(glyph.join(''), { fill: 'none', stroke: 'var(--dwg-elec)', 'stroke-width': 1.2, ...HAIR })}
      ${pathEl(lights.join(''), { fill: 'none', stroke: 'var(--dwg-elec)', 'stroke-width': 1.2, ...HAIR })}
      ${pathEl(panels.join(''), { fill: 'var(--dwg-elec)', 'fill-opacity': 0.3, stroke: 'var(--dwg-elec)', 'stroke-width': 1.2, ...HAIR })}
      ${letters.join('')}
    </g>`);
  }

  // ---- generic elements for storeys without an architectural floor plan
  if (!floor) {
    const buckets: Bucket = new Map();
    for (const el of model.elements) {
      if (el.storey !== storeyId) continue;
      if (!layerFor(el.discipline, layers)) continue;
      const pts = elementFootprint(el.geometry);
      if (!pts || pts.length < 2) continue;
      grow(pts);
      bput(buckets, el.discipline, polyPath(pts));
      counts.generic = (counts.generic ?? 0) + 1;
      hits.push(hitFromPoints(el.id, el.ifcType, el.name, pts, elMeta(model, el.id, [
        ['Discipline', humanize(el.discipline)], ['Geometry', el.geometry.kind],
      ])));
    }
    const g: string[] = [];
    for (const [disc, ds] of buckets) {
      const c = DISC_DWG[disc] ?? 'var(--dwg-outline)';
      g.push(pathEl(ds.join(''), { fill: c, 'fill-opacity': 0.18, stroke: c, 'stroke-width': 1, ...HAIR }));
    }
    out.push(`<g class="l-generic">${g.join('')}</g>`);
    if (labelsOn && storey) {
      const b = (bounds ?? { x: 0, y: 0, w: 10, h: 10 }) as Rect;
      out.push(text(b.x + b.w / 2, b.y + b.h + 1.2, `${storey.name} — ${counts.generic ?? 0} elements`, { size: 0.8, fill: 'var(--ink-3)' }));
      grow([[b.x, b.y], [b.x + b.w, b.y + b.h + 2.4]]); // keep the caption in view
    }
  }

  // ---- highlight
  if (highlight) {
    const hit = hits.find((h) => h.id === highlight);
    if (hit) {
      const pad = 0.25;
      out.push(pathEl(rectPath({ x: hit.x0 - pad, y: hit.y0 - pad, w: hit.x1 - hit.x0 + 2 * pad, h: hit.y1 - hit.y0 + 2 * pad }), {
        fill: 'none', stroke: 'var(--dwg-hl)', 'stroke-width': 2.2, 'stroke-dasharray': '6 4', ...HAIR,
      }));
    }
  }

  if (!bounds) bounds = { x: 0, y: 0, w: 20, h: 20 };
  return { body: out.join(''), defs: hatchDefs(), hits, bounds: bounds as Rect, counts };
}

const DISC_DWG: Record<string, string> = {
  site: 'var(--dwg-site)', architecture: 'var(--dwg-outline)', structure: 'var(--dwg-struct)',
  mechanical: 'var(--dwg-mech)', plumbing: 'var(--dwg-plumb)', electrical: 'var(--dwg-elec)',
};

function layerFor(d: string, l: Layers): boolean {
  return d === 'site' ? l.site : d === 'architecture' ? l.arch : d === 'structure' ? l.struct
    : d === 'mechanical' ? l.mech : d === 'plumbing' ? l.plumb : d === 'electrical' ? l.elec : true;
}

/** Rough advance width of the system sans at `size` metres, in metres. */
export function textWidth(s: string, size: number): number {
  return s.length * size * 0.54;
}
export function fits(s: string, size: number, boxWidth: number): boolean {
  return textWidth(s, size) <= boxWidth * 0.94;
}
/** Progressively shorter forms of a room name until one fits; '' when none does. */
export function shortName(name: string, size: number, boxWidth: number): string {
  const words = name.split(/[\s/]+/).filter(Boolean);
  for (const cand of [words[0] ?? '', (words[0] ?? '').slice(0, 5), (words[0] ?? '').slice(0, 3)]) {
    if (cand && fits(cand, size, boxWidth)) return cand;
  }
  return '';
}

export function rectPts(r: Rect): Vec2[] {
  return [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]];
}

export function centroid(pts: readonly Vec2[]): Vec2 {
  let x = 0, y = 0;
  for (const p of pts) { x += p[0]; y += p[1]; }
  return [x / pts.length, y / pts.length];
}

/** Point pair for an opening `along` a wall, plus the wall direction and normal. */
export function along(w: Pick<WallDef, 'start' | 'end'>, at: number, width: number): { a: Vec2; b: Vec2; dir: Vec2; nrm: Vec2 } {
  const dx = w.end[0] - w.start[0], dy = w.end[1] - w.start[1];
  const l = Math.hypot(dx, dy) || 1;
  const dir: Vec2 = [dx / l, dy / l];
  const nrm: Vec2 = [-dir[1], dir[0]];
  const c: Vec2 = [w.start[0] + dir[0] * at, w.start[1] + dir[1] * at];
  return {
    a: [c[0] - dir[0] * width / 2, c[1] - dir[1] * width / 2],
    b: [c[0] + dir[0] * width / 2, c[1] + dir[1] * width / 2],
    dir, nrm,
  };
}

/** Smallest hit whose bbox contains the point (world coords). */
export function pickHit(hits: readonly Hit[], x: number, y: number, tol = 0.15): Hit | null {
  let best: Hit | null = null;
  let bestArea = Infinity;
  for (const h of hits) {
    if (x < h.x0 - tol || x > h.x1 + tol || y < h.y0 - tol || y > h.y1 + tol) continue;
    const a = Math.max(h.x1 - h.x0, 0.05) * Math.max(h.y1 - h.y0, 0.05);
    if (a < bestArea) { bestArea = a; best = h; }
  }
  return best;
}

export { hatchDefs };
