/**
 * F8 — Furniture type library for recognisable, lightweight 3D (IfcFurnitureType + IfcRepresentationMap +
 * IfcMappedItem). One entry per FurnitureType (45), each 3–8 primitives in the type's LOCAL frame, which is the
 * FurnitureDef convention: origin = footprint MIN corner before rotation, +x along `width`, +y along `depth` (the back
 * of an unrotated item is the y = 0 edge), +z up, z = 0 at the floor. For box/prism, (x, y, z) is the solid's own min
 * corner (prism.poly relative to x, y); for cyl/ellipse, (x, y) is the CENTRE. `axis` is the extrusion direction
 * (default 'z'; 'x'/'y' for portholes, grab rails, car wheels).
 *
 * Stretchable items (kitchen-counter runs) are PER-LENGTH TYPES with the width quantised to STRETCH_QUANTUM, ids
 * `FT-<type>-w<cm>` — not a non-uniform scale, because door divisions must change in COUNT with length and reveals must
 * not smear. arch-elements quantises FurnitureDef.width for those items so plan, axon and IFC agree.
 *
 * `symbol` is the top-view plan symbol (polylines/rings, local frame) precomputed from the solids and drawn by the 2D
 * plan per instance instead of a letter glyph. Filled in by the IFC-furniture agent; this file freezes the shape.
 */
import type { FurnitureType, RGB, Vec2 } from './types.ts';

export type SolidAxis = 'z' | 'x' | 'y';

export type Solid =
  | { kind: 'box'; x: number; y: number; z: number; w: number; d: number; h: number; axis?: SolidAxis; color?: RGB }
  | { kind: 'cyl'; x: number; y: number; z: number; r: number; h: number; axis?: SolidAxis; color?: RGB }
  | { kind: 'ellipse'; x: number; y: number; z: number; rx: number; ry: number; h: number; axis?: SolidAxis; color?: RGB }
  | { kind: 'prism'; x: number; y: number; z: number; poly: Vec2[]; h: number; axis?: SolidAxis; color?: RGB };

export type FurnitureIfcType = 'IfcFurnitureType' | 'IfcSanitaryTerminalType' | 'IfcElectricApplianceType' | 'IfcBuildingElementProxyType';

/** Occurrence entity written for each type kind (IfcFurnishingElement is the styled, classified one in ifc-lite) */
export const OCCURRENCE_OF: Readonly<Record<FurnitureIfcType, string>> = {
  IfcFurnitureType: 'IFCFURNISHINGELEMENT',
  IfcSanitaryTerminalType: 'IFCSANITARYTERMINAL',
  IfcElectricApplianceType: 'IFCELECTRICAPPLIANCE',
  IfcBuildingElementProxyType: 'IFCBUILDINGELEMENTPROXY',
};

export interface FurnitureTypeDef {
  /** 'FT-<furnitureType>' | 'FT-<furnitureType>-w<cm>' (cm = width × 100 rounded to STRETCH_QUANTUM) */
  id: string;
  furnitureType: FurnitureType;
  ifcType: FurnitureIfcType;
  /** e.g. BED, SOFA, TABLE, CHAIR, CABINET, SHELF, DESK, TOILETPAN, WASHHANDBASIN, SINK, BATH, SHOWER, FRIDGE_FREEZER … */
  predefinedType?: string;
  /** === FURNITURE_CATALOG[type].{w,d} exactly (the layout engine's footprint) */
  footprint: { w: number; d: number };
  /** real bounding height = max(z + h) over solids; ≥ FURNITURE_CATALOG[type].h */
  height: number;
  solids: readonly Solid[];
  /** top-view plan rings/polylines in the local frame, precomputed from the solids (+ symbolExtra) */
  symbol: readonly Vec2[][];
  /** authored plan lines that are not a solid outline (shower corner diagonal, treadmill belt centreline) */
  symbolExtra?: readonly Vec2[][];
  /** items whose width varies per placement are emitted as per-length types along this local axis */
  stretch?: 'x' | null;
  /** default colour when a solid does not carry its own */
  color: RGB;
}

export const FURNITURE_TYPE_ID_PREFIX = 'FT-';
/** Width quantum for stretchable items (m) */
export const STRETCH_QUANTUM = 0.10;
export const STRETCH_MIN = 0.30;
export const STRETCH_MAX = 6.00;

/** Filled by the IFC-furniture agent (one entry per FurnitureType). Empty until then → producers keep emitting boxes. */
export const FURNITURE_TYPES: Partial<Record<FurnitureType, FurnitureTypeDef>> = {};

export function furnitureTypeDef(t: FurnitureType): FurnitureTypeDef | undefined {
  return FURNITURE_TYPES[t];
}

/** Quantised width for a stretchable item (identity for the others) */
export function quantizeFurnitureWidth(t: FurnitureType, w: number): number {
  const def = FURNITURE_TYPES[t];
  if (!def || !def.stretch) return w;
  const c = Math.min(STRETCH_MAX, Math.max(STRETCH_MIN, w));
  return Math.round(c / STRETCH_QUANTUM) * STRETCH_QUANTUM;
}

/** The geometry id for an instance: 'FT-<type>' or 'FT-<type>-w<cm>' for stretchable items */
export function stretchKey(t: FurnitureType, w: number): string {
  const def = FURNITURE_TYPES[t];
  if (!def || !def.stretch) return `${FURNITURE_TYPE_ID_PREFIX}${t}`;
  const cm = Math.round(quantizeFurnitureWidth(t, w) * 100);
  return `${FURNITURE_TYPE_ID_PREFIX}${t}-w${cm}`;
}

/** Parse a type id back to its FurnitureType and (for stretchable items) width in metres */
export function parseTypeId(id: string): { type: string; width: number | null } | null {
  if (!id.startsWith(FURNITURE_TYPE_ID_PREFIX)) return null;
  const rest = id.slice(FURNITURE_TYPE_ID_PREFIX.length);
  const m = /^(.*)-w(\d{2,3})$/.exec(rest);
  if (m) return { type: m[1], width: Number(m[2]) / 100 };
  return { type: rest, width: null };
}

/**
 * Type definition for a concrete id (stretched variants are derived from the base type by the implementing agent's
 * builder). Returns undefined until the library is populated.
 */
export function typeById(id: string): FurnitureTypeDef | undefined {
  const p = parseTypeId(id);
  if (!p) return undefined;
  const base = FURNITURE_TYPES[p.type as FurnitureType];
  if (!base) return undefined;
  if (p.width === null || !base.stretch) return base;
  return stretchedType(base, p.width);
}

/** Per-length variant of a stretchable type; overridden by the implementing agent's builder via setStretchBuilder */
let stretchBuilder: (base: FurnitureTypeDef, width: number) => FurnitureTypeDef = (base, width) => ({
  ...base,
  id: `${base.id}-w${Math.round(width * 100)}`,
  footprint: { w: width, d: base.footprint.d },
});
export function setStretchBuilder(fn: (base: FurnitureTypeDef, width: number) => FurnitureTypeDef): void { stretchBuilder = fn; }
export function stretchedType(base: FurnitureTypeDef, width: number): FurnitureTypeDef { return stretchBuilder(base, width); }

/**
 * Axis-aligned bounds of a solid in the type's local frame.
 * Sideways extrusions (axis 'x' | 'y'): (x, y, z) is the CENTRE of the start face for cyl/ellipse (rx horizontal, ry
 * vertical in the profile plane) and the min corner of the profile plane for prism; `h` runs along the axis.
 */
export function solidBounds(s: Solid): { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number } {
  const axis = s.axis ?? 'z';
  if (s.kind === 'box') return { x0: s.x, y0: s.y, z0: s.z, x1: s.x + s.w, y1: s.y + s.d, z1: s.z + s.h };
  let rx: number, ry: number;
  if (s.kind === 'cyl') { rx = s.r; ry = s.r; }
  else if (s.kind === 'ellipse') { rx = s.rx; ry = s.ry; }
  else {
    let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
    for (const p of s.poly) { u0 = Math.min(u0, p[0]); v0 = Math.min(v0, p[1]); u1 = Math.max(u1, p[0]); v1 = Math.max(v1, p[1]); }
    if (axis === 'z') return { x0: s.x + u0, y0: s.y + v0, z0: s.z, x1: s.x + u1, y1: s.y + v1, z1: s.z + s.h };
    if (axis === 'x') return { x0: s.x, y0: s.y + u0, z0: s.z + v0, x1: s.x + s.h, y1: s.y + u1, z1: s.z + v1 };
    return { x0: s.x + u0, y0: s.y, z0: s.z + v0, x1: s.x + u1, y1: s.y + s.h, z1: s.z + v1 };
  }
  if (axis === 'z') return { x0: s.x - rx, y0: s.y - ry, z0: s.z, x1: s.x + rx, y1: s.y + ry, z1: s.z + s.h };
  if (axis === 'x') return { x0: s.x, y0: s.y - rx, z0: s.z - ry, x1: s.x + s.h, y1: s.y + rx, z1: s.z + ry };
  return { x0: s.x - rx, y0: s.y, z0: s.z - ry, x1: s.x + rx, y1: s.y + s.h, z1: s.z + ry };
}

/**
 * Plan symbol from the solids: the outline of every solid whose top is at or above `height × topFrac`, plus the
 * largest-footprint solid (the base); circles/ellipses as 16-gons; rings sorted by descending area.
 */
export function symbolFromSolids(solids: readonly Solid[], height: number, topFrac = 0.5): Vec2[][] {
  const ring = (s: Solid): Vec2[] => {
    switch (s.kind) {
      case 'box': return [[s.x, s.y], [s.x + s.w, s.y], [s.x + s.w, s.y + s.d], [s.x, s.y + s.d]];
      case 'cyl': return polygon(s.x, s.y, s.r, s.r);
      case 'ellipse': return polygon(s.x, s.y, s.rx, s.ry);
      case 'prism': return s.poly.map(p => [s.x + p[0], s.y + p[1]] as Vec2);
    }
  };
  const area = (pts: Vec2[]): number => {
    let a = 0;
    for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; }
    return Math.abs(a) / 2;
  };
  const rings = solids.map(s => ({ s, r: ring(s), a: 0 })).map(o => ({ ...o, a: area(o.r) }));
  let base = rings[0];
  for (const o of rings) if (o.a > base.a) base = o;
  const picked = rings.filter(o => o === base || solidBounds(o.s).z1 >= height * topFrac);
  picked.sort((p, q) => q.a - p.a);
  return picked.map(o => o.r);
}

function polygon(cx: number, cy: number, rx: number, ry: number, n = 16): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]); }
  return pts;
}
