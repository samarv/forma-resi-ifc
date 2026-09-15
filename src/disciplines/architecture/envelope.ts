/**
 * The envelope: exterior wall segmentation around a floor outline, glazing, parapets and roof.
 *
 * The exterior wall CENTRELINE polygon is the floor outline offset inward by half the exterior wall
 * thickness, so the outside face of the wall sits exactly on the massing footprint. Every organiser
 * registers its boundary breakpoints (unit frontages, common-room divisions, core faces, corridor
 * ends) BEFORE the walls are built; the envelope is then cut once at those breakpoints, and the
 * units / rooms look their segment up instead of creating overlapping walls.
 */
import type {
  Compass, ModelElement, Polygon, Rect, RoofDef, RoofType, Side, Vec2, WallDef,
} from '../../core/types.ts';
import { SIZES } from '../../core/coordination.ts';
import {
  EPS, exposureOf, offsetPolygon, polygonArea, polygonBounds, round, sideNormal,
  simplifyCollinear, norm, sub,
} from '../../core/geometry.ts';
import { ArchBuilder, gableRoofElement, slabElementPoly, zoneProxyElement } from './arch-elements.ts';

export interface EnvelopeEdge {
  side: Side;
  /** constant coordinate of the wall centreline (y for front/rear, x for left/right) */
  across: number;
  a0: number;
  a1: number;
  exposure: Compass;
  breaks: number[];
  walls: { a0: number; a1: number; wall: WallDef }[];
}

const KEY = (side: Side, across: number): string => `${side}|${(Math.round(across * 100) / 100).toFixed(2)}`;

export class EnvelopeBuilder {
  readonly storey: string;
  readonly height: number;
  readonly edges: EnvelopeEdge[] = [];
  private byKey = new Map<string, EnvelopeEdge[]>();
  private built = false;

  constructor(outline: Polygon, storey: string, height: number, streetFacing: Compass, thickness = SIZES.exteriorWallT) {
    this.storey = storey;
    this.height = height;
    const centre = simplifyCollinear(offsetPolygon(outline, thickness / 2));
    const n = centre.length;
    for (let i = 0; i < n; i++) {
      const p = centre[i];
      const q = centre[(i + 1) % n];
      const d = norm(sub(q, p));
      if (Math.hypot(q[0] - p[0], q[1] - p[1]) < 0.2) continue;
      // outward normal of a CCW polygon edge is right of the direction
      const outward: Vec2 = [round(d[1], 6), round(-d[0], 6)];
      let side: Side;
      if (Math.abs(outward[1]) > Math.abs(outward[0])) side = outward[1] < 0 ? 'front' : 'rear';
      else side = outward[0] < 0 ? 'left' : 'right';
      const horizontal = side === 'front' || side === 'rear';
      const across = horizontal ? p[1] : p[0];
      const a0 = Math.min(horizontal ? p[0] : p[1], horizontal ? q[0] : q[1]);
      const a1 = Math.max(horizontal ? p[0] : p[1], horizontal ? q[0] : q[1]);
      const edge: EnvelopeEdge = {
        side, across: round(across, 4), a0: round(a0, 4), a1: round(a1, 4),
        exposure: exposureOf(sideNormal(side), streetFacing), breaks: [], walls: [],
      };
      this.edges.push(edge);
      const k = KEY(side, across);
      const list = this.byKey.get(k) ?? [];
      list.push(edge);
      this.byKey.set(k, list);
    }
  }

  /** The (unique) edge on `side` whose centreline coordinate is `across` and that contains [a0,a1] */
  edgeFor(side: Side, across: number, a0: number, a1: number): EnvelopeEdge | undefined {
    const exact = this.byKey.get(KEY(side, across));
    const pool = exact ?? this.edges.filter(e => e.side === side && Math.abs(e.across - across) < 0.2);
    return pool.find(e => a0 >= e.a0 - 0.3 && a1 <= e.a1 + 0.3);
  }

  /** Register a break so the envelope is cut here */
  addBreak(side: Side, across: number, along: number): void {
    if (this.built) return;
    const e = this.edgeFor(side, across, along, along);
    if (e) e.breaks.push(along);
  }

  addSpan(side: Side, across: number, a0: number, a1: number): void {
    this.addBreak(side, across, a0);
    this.addBreak(side, across, a1);
  }

  /** Cut every edge at its breakpoints and create the WallDefs */
  build(b: ArchBuilder, type: WallDef['type'] = 'exterior', thickness = SIZES.exteriorWallT): void {
    if (this.built) return;
    this.built = true;
    for (const e of this.edges) {
      const cuts = [e.a0, ...e.breaks.filter(v => v > e.a0 + 0.25 && v < e.a1 - 0.25), e.a1]
        .map(v => round(v, 4))
        .sort((p, q) => p - q);
      const uniq: number[] = [];
      for (const v of cuts) if (uniq.length === 0 || v - uniq[uniq.length - 1] > 0.2) uniq.push(v);
      if (uniq[uniq.length - 1] < e.a1 - EPS) uniq[uniq.length - 1] = e.a1;
      for (let i = 0; i < uniq.length - 1; i++) {
        const a0 = uniq[i], a1 = uniq[i + 1];
        const horizontal = e.side === 'front' || e.side === 'rear';
        const start: Vec2 = horizontal ? [a0, e.across] : [e.across, a0];
        const end: Vec2 = horizontal ? [a1, e.across] : [e.across, a1];
        const wall = b.addWall({
          storey: this.storey, start, end, thickness, height: this.height, type,
          isExternal: true, loadBearingHint: true, exposure: e.exposure,
        });
        e.walls.push({ a0, a1, wall });
      }
    }
  }

  /** Wall segment covering [a0,a1] on the given side (the one with the largest overlap) */
  wallFor(side: Side, across: number, a0: number, a1: number): WallDef | undefined {
    const e = this.edgeFor(side, across, a0, a1);
    if (!e) return undefined;
    let best: WallDef | undefined;
    let bestOv = 0;
    for (const w of e.walls) {
      const ov = Math.min(a1, w.a1) - Math.max(a0, w.a0);
      if (ov > bestOv) { bestOv = ov; best = w.wall; }
    }
    return bestOv > 0.05 ? best : undefined;
  }

  wallsFor(side: Side, across: number, a0: number, a1: number): WallDef[] {
    const e = this.edgeFor(side, across, a0, a1);
    if (!e) return [];
    return e.walls.filter(w => Math.min(a1, w.a1) - Math.max(a0, w.a0) > 0.05).map(w => w.wall);
  }

  allWalls(): WallDef[] {
    return this.edges.flatMap(e => e.walls.map(w => w.wall));
  }

  exposureFor(side: Side, across: number): Compass | undefined {
    return this.edgeFor(side, across, -Infinity, Infinity)?.exposure
      ?? this.edges.find(e => e.side === side)?.exposure;
  }
}

// ----------------------------------------------------------------------------
// Glazing
// ----------------------------------------------------------------------------

export interface GlazeOpts {
  wwr: number;
  sill?: number;
  height?: number;
  maxWidth?: number;
  pier?: number;
}

/** Punch windows into a wall to hit a wwr target; returns the glazed area actually placed */
export function glazeWall(
  b: ArchBuilder, wall: WallDef, roomId: string, opts: GlazeOpts, unitId?: string,
): number {
  const len = Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]);
  const sill = opts.sill ?? SIZES.windowSill;
  const hMax = Math.max(0.6, Math.min(opts.height ?? SIZES.windowHeight, wall.height - sill - 0.2));
  if (len < 1.0 || hMax < 0.5) return 0;
  const target = opts.wwr * len * wall.height;
  const wMax = opts.maxWidth ?? 2.2;
  const pier = opts.pier ?? 0.6;
  const nFit = Math.max(1, Math.floor((len + pier) / (1.0 + pier)));
  let n = Math.max(1, Math.min(nFit, Math.round(target / (wMax * hMax))));
  let w = Math.min(wMax, (len - pier * (n + 1)) / n);
  if (w < 0.8) {
    n = Math.max(1, Math.floor((len - pier) / (0.8 + pier)));
    w = Math.max(0.8, Math.min(wMax, (len - pier * (n + 1)) / n));
  }
  if (w <= 0.4) return 0;
  const spacing = (len - n * w) / (n + 1);
  let placed = 0;
  for (let i = 0; i < n; i++) {
    const along = spacing * (i + 1) + w * i + w / 2;
    b.addWindow({
      storey: wall.storey, wallId: wall.id, along, sill, width: round(w, 3), height: round(hMax, 3),
      roomId, exposure: wall.exposure, unitId,
    });
    placed += w * hMax;
  }
  return placed;
}

// ----------------------------------------------------------------------------
// Parapets, roof
// ----------------------------------------------------------------------------

export function buildParapets(b: ArchBuilder, outline: Polygon, storey: string, height: number, streetFacing: Compass): WallDef[] {
  const centre = simplifyCollinear(offsetPolygon(outline, SIZES.exteriorWallT / 2));
  const out: WallDef[] = [];
  for (let i = 0; i < centre.length; i++) {
    const p = centre[i];
    const q = centre[(i + 1) % centre.length];
    if (Math.hypot(q[0] - p[0], q[1] - p[1]) < 0.2) continue;
    const d = norm(sub(q, p));
    const outward: Vec2 = [d[1], -d[0]];
    out.push(b.addWall({
      storey, start: p, end: q, thickness: SIZES.exteriorWallT, height, type: 'parapet',
      isExternal: true, loadBearingHint: false, exposure: exposureOf(outward, streetFacing),
    }));
  }
  return out;
}

export interface RoofInput {
  outline: Polygon;
  type: RoofType;
  pitchRad: number;
  ridgeAxis: 'x' | 'y';
  parapetHeight: number;
  storey: string;
  /** rect of a core, so the plant zone can sit next to a riser */
  coreRect?: Rect;
  bars: Rect[];
  emitSlab: boolean;
  streetFacing: Compass;
}

export function buildRoof(b: ArchBuilder, input: RoofInput): RoofDef {
  const flat = input.type === 'flat';
  const outline = input.outline;
  const bounds = polygonBounds(outline);
  const area = polygonArea(outline);
  const def: RoofDef = {
    type: input.type,
    outline,
    thickness: 0.25,
    pitchRad: flat ? 0 : input.pitchRad,
    ridgeAxis: input.ridgeAxis,
    parapetHeight: flat ? input.parapetHeight : 0,
  };

  if (flat) {
    buildParapets(b, outline, input.storey, input.parapetHeight, input.streetFacing);
    // plant zone: ~15% of the roof, beside a core, snapped inside a 1 m edge margin
    const margin = 1.0;
    const usable: Rect = {
      x: bounds.x + margin, y: bounds.y + margin,
      w: Math.max(1, bounds.w - 2 * margin), h: Math.max(1, bounds.h - 2 * margin),
    };
    const plantArea = area * 0.15;
    const alongX = usable.w >= usable.h;
    const plantLen = Math.min(alongX ? usable.w : usable.h, plantArea / (alongX ? usable.h : usable.w));
    const nearStart = input.coreRect
      ? (alongX ? input.coreRect.x - bounds.x < bounds.x + bounds.w - (input.coreRect.x + input.coreRect.w)
        : input.coreRect.y - bounds.y < bounds.y + bounds.h - (input.coreRect.y + input.coreRect.h))
      : true;
    const plant: Rect = alongX
      ? { x: round(nearStart ? usable.x : usable.x + usable.w - plantLen), y: round(usable.y), w: round(plantLen), h: round(usable.h) }
      : { x: round(usable.x), y: round(nearStart ? usable.y : usable.y + usable.h - plantLen), w: round(usable.w), h: round(plantLen) };
    const pv: Rect = alongX
      ? { x: round(nearStart ? plant.x + plant.w + 0.5 : usable.x), y: round(usable.y), w: round(Math.max(0, usable.w - plantLen - 0.5)), h: round(usable.h) }
      : { x: round(usable.x), y: round(nearStart ? plant.y + plant.h + 0.5 : usable.y), w: round(usable.w), h: round(Math.max(0, usable.h - plantLen - 0.5)) };
    def.plantZone = plant;
    if (pv.w > 1 && pv.h > 1) def.pvZone = pv;

    b.addRoom({ storey: input.storey, type: 'plant', rect: plant, height: 2.4, name: 'Roof Plant Zone' });
    zoneProxyElement(b, input.storey, plant, 'Roof plant zone', 'plant-zone', [0.6, 0.62, 0.66], ['ARC-35']);
    if (def.pvZone) zoneProxyElement(b, input.storey, def.pvZone, 'PV reserve zone', 'pv-zone', [0.25, 0.3, 0.45], ['ARC-35']);
    if (input.emitSlab) slabElementPoly(b, input.storey, outline, def.thickness, -def.thickness, 'ROOF', 'Roof slab', ['ARC-35']);
  } else {
    // gable (or hip, treated as gable) over each bar
    for (const bar of input.bars) {
      gableRoofElement(b, input.storey, bar, input.pitchRad, input.ridgeAxis, 0.25, 0.4);
    }
    def.parapetHeight = 0;
  }
  b.apply({
    patternId: 'ARC-35',
    storey: input.storey,
    params: {
      roofType: input.type,
      roofArea: round(area, 1),
      plantZoneArea: def.plantZone ? round(def.plantZone.w * def.plantZone.h, 1) : 0,
      pvZoneArea: def.pvZone ? round(def.pvZone.w * def.pvZone.h, 1) : 0,
      parapetHeight: def.parapetHeight,
    },
  });
  return def;
}

/** Floor slab for a storey — only emitted when the structure discipline is switched off */
export function buildFloorSlab(b: ArchBuilder, storey: string, outline: Polygon, thickness: number): ModelElement {
  return slabElementPoly(b, storey, outline, thickness, -thickness, 'FLOOR', 'Floor slab');
}
