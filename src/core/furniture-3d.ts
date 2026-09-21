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
// The catalogue owns every footprint; this file only adds the third dimension, so the
// w/d of a type is READ from it rather than restated (FURNITURE_CATALOG has no imports
// of its own beyond the FurnitureType union, so there is no cycle).
import { FURNITURE_CATALOG } from '../disciplines/architecture/furniture.ts';

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

// ============================================================================
// The library
// ============================================================================

/**
 * Palette (RGB 0–1). Eleven colours for the whole library, so the IFC file
 * carries eleven IfcSurfaceStyles no matter how many types are used.
 */
const WOOD: RGB = [0.72, 0.58, 0.42];
const FABRIC: RGB = [0.55, 0.58, 0.62];
const WHITE: RGB = [0.94, 0.94, 0.92];
const METAL: RGB = [0.72, 0.74, 0.76];
const GLASS: RGB = [0.72, 0.82, 0.86];
const DARK: RGB = [0.22, 0.23, 0.25];
const MATTRESS: RGB = [0.88, 0.87, 0.83];
const CERAMIC: RGB = [0.96, 0.96, 0.94];
const FOLIAGE: RGB = [0.42, 0.55, 0.35];
const RUBBER: RGB = [0.20, 0.20, 0.22];
const CARBODY: RGB = [0.35, 0.42, 0.52];

/** Every authored coordinate is quantised to 0.1 mm so the STEP file has no float noise. */
function r4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

/**
 * A box takes no `axis`: its bounding box is w × d × h whichever direction it is
 * extruded in (which is what `solidBounds` says), so the writer always extrudes +Z.
 */
function bx(x: number, y: number, z: number, w: number, d: number, h: number, color: RGB): Solid {
  return { kind: 'box', x: r4(x), y: r4(y), z: r4(z), w: r4(w), d: r4(d), h: r4(h), color };
}
function cy(x: number, y: number, z: number, r: number, h: number, color: RGB, axis?: SolidAxis): Solid {
  return { kind: 'cyl', x: r4(x), y: r4(y), z: r4(z), r: r4(r), h: r4(h), ...(axis ? { axis } : {}), color };
}
function el(x: number, y: number, z: number, rx: number, ry: number, h: number, color: RGB, axis?: SolidAxis): Solid {
  return { kind: 'ellipse', x: r4(x), y: r4(y), z: r4(z), rx: r4(rx), ry: r4(ry), h: r4(h), ...(axis ? { axis } : {}), color };
}
function pr(x: number, y: number, z: number, poly: Vec2[], h: number, color: RGB, axis?: SolidAxis): Solid {
  return {
    kind: 'prism', x: r4(x), y: r4(y), z: r4(z), h: r4(h), color,
    poly: poly.map(p => [r4(p[0]), r4(p[1])] as Vec2), ...(axis ? { axis } : {}),
  };
}

/** Occurrence class of a type, in the same order as {@link OCCURRENCE_OF}. */
const SANITARY = 'IfcSanitaryTerminalType' as const;
const APPLIANCE = 'IfcElectricApplianceType' as const;
const PROXY = 'IfcBuildingElementProxyType' as const;

interface DefInput {
  type: FurnitureType;
  ifcType?: FurnitureIfcType;
  predefinedType?: string;
  solids: Solid[];
  color: RGB;
  symbolExtra?: Vec2[][];
  stretch?: 'x';
  /** per-length variants only: the stretched footprint width and the `-w<cm>` id */
  width?: number;
  id?: string;
}

/**
 * Assemble a type: the footprint comes from the catalogue (the layout engine owns it),
 * the height from the solids, and the plan symbol from {@link symbolFromSolids} plus the
 * authored `symbolExtra` lines. Identical rings are dropped (a WC bowl and its seat share
 * one outline) so the plan layer does not draw the same path twice per instance.
 */
function def(input: DefInput): FurnitureTypeDef {
  const spec = FURNITURE_CATALOG[input.type];
  const footprint = { w: input.width ?? spec.w, d: spec.d };
  let height = 0;
  for (const s of input.solids) height = Math.max(height, solidBounds(s).z1);
  height = r4(height);
  const rings = symbolFromSolids(input.solids, height, 0.5)
    .map(ring => ring.map(p => [r4(p[0]), r4(p[1])] as Vec2));
  const seen = new Set<string>();
  const symbol: Vec2[][] = [];
  for (const ring of [...rings, ...(input.symbolExtra ?? [])]) {
    const key = ring.map(p => `${p[0]},${p[1]}`).join(';');
    if (seen.has(key)) continue;
    seen.add(key);
    symbol.push(ring);
  }
  return {
    id: input.id ?? `${FURNITURE_TYPE_ID_PREFIX}${input.type}`,
    furnitureType: input.type,
    ifcType: input.ifcType ?? 'IfcFurnitureType',
    predefinedType: input.predefinedType,
    footprint,
    height,
    solids: input.solids,
    symbol,
    ...(input.stretch ? { stretch: input.stretch } : {}),
    color: input.color,
  };
}

// ---- the five parametric builders ------------------------------------------

/**
 * Bed: recessed frame, mattress, headboard on the BACK edge (y = 0, the wall side —
 * `againstSide()` puts the item's y = 0 edge against the wall), pillows beside it and a
 * duvet over the foot end.
 */
function bed(type: FurnitureType, pillowW: number, pillows: number): FurnitureTypeDef {
  const { w, d } = FURNITURE_CATALOG[type];
  const gap = 0.03;
  const margin = (w - pillows * pillowW - (pillows - 1) * gap) / 2;
  const solids: Solid[] = [
    bx(0.05, 0.05, 0.10, w - 0.10, d - 0.10, 0.25, WOOD),
    bx(0, 0, 0.35, w, d, 0.22, MATTRESS),
    bx(0, 0, 0, w, 0.05, 0.95, WOOD),
  ];
  for (let i = 0; i < pillows; i++) {
    solids.push(bx(margin + i * (pillowW + gap), 0.08, 0.57, pillowW, 0.40, 0.10, WHITE));
  }
  solids.push(bx(0, d - 1.30, 0.57, w, 1.30, 0.04, FABRIC));
  return def({ type, predefinedType: 'BED', solids, color: WOOD });
}

/**
 * Cased goods: recessed dark plinth, body, and `cols × rows` door/drawer fronts in the
 * front 20 mm of the footprint (y = d − 0.02 … d), so nothing protrudes past the
 * catalogue footprint and the item can sit hard against a wall.
 */
function carcass(w: number, d: number, h: number, o: {
  body: RGB; plinth?: number; cols?: number; rows?: number;
}): Solid[] {
  const plinthH = o.plinth ?? 0.05;
  const cols = o.cols ?? 0;
  const rows = o.rows ?? 1;
  const solids: Solid[] = [
    bx(0.02, 0.02, 0, w - 0.04, d - 0.04, plinthH, DARK),
    bx(0, 0, plinthH, w, d - 0.02, h - plinthH, o.body),
  ];
  if (cols > 0) {
    const z0 = plinthH + 0.03;
    const panelH = (h - 0.03 - z0 - (rows - 1) * 0.02) / rows;
    const panelW = (w - 0.02 - (cols - 1) * 0.01) / cols;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        solids.push(bx(0.01 + i * (panelW + 0.01), d - 0.02, z0 + j * (panelH + 0.02), panelW, 0.02, panelH, o.body));
      }
    }
  }
  return solids;
}

/** Top + four round legs. `h` is the top surface. */
function table(w: number, d: number, h: number, o: {
  topH: number; legR: number; leg: RGB; top: RGB;
}): Solid[] {
  const inset = o.legR + 0.03;
  const legH = h - o.topH;
  return [
    bx(0, 0, legH, w, d, o.topH, o.top),
    cy(inset, inset, 0, o.legR, legH, o.leg),
    cy(w - inset, inset, 0, o.legR, legH, o.leg),
    cy(inset, d - inset, 0, o.legR, legH, o.leg),
    cy(w - inset, d - inset, 0, o.legR, legH, o.leg),
  ];
}

/** Upholstery: base, back panel on the y = 0 edge, two arms, and `cushions` seat cushions. */
function seating(w: number, d: number, h: number, o: {
  backH: number; cushions: number; armW?: number; baseH?: number;
}): Solid[] {
  const armW = o.armW ?? 0.20;
  const baseH = o.baseH ?? 0.30;
  const backD = 0.24;
  const solids: Solid[] = [
    bx(0, 0, 0, w, d, baseH, FABRIC),
    bx(0, 0, h - o.backH, w, backD, o.backH, FABRIC),
    bx(0, backD, baseH, armW, d - backD, 0.25, FABRIC),
    bx(w - armW, backD, baseH, armW, d - backD, 0.25, FABRIC),
  ];
  const span = w - 2 * armW;
  const gap = 0.0275;
  const cushionW = (span - (o.cushions + 1) * gap) / o.cushions;
  const cushionD = d - backD - 0.10;
  for (let i = 0; i < o.cushions; i++) {
    solids.push(bx(armW + gap + i * (cushionW + gap), backD + 0.02, baseH, cushionW, cushionD, 0.12, FABRIC));
  }
  return solids;
}

/** White goods: body, a hinged door front or a glass porthole, a control strip, and one detail. */
function appliance(w: number, d: number, h: number, o: {
  front: 'door' | 'porthole'; extra: 'handle' | 'drawer' | 'vent'; stripZ: number;
}): Solid[] {
  const face = d - 0.02;
  const solids: Solid[] = [bx(0, 0, 0, w, face, h, WHITE)];
  solids.push(o.front === 'door'
    ? bx(0.01, face, 0.02, w - 0.02, 0.02, o.stripZ - 0.04, WHITE)
    : cy(w / 2, face, 0.45, 0.17, 0.02, GLASS, 'y'));
  solids.push(bx(0.01, face, o.stripZ, w - 0.02, 0.02, 0.08, DARK));
  if (o.extra === 'handle') solids.push(cy(0.05, face + 0.005, o.stripZ - 0.06, 0.012, w - 0.10, METAL, 'x'));
  if (o.extra === 'drawer') solids.push(bx(0.01, face, o.stripZ - 0.06, 0.30, 0.02, 0.05, WHITE));
  if (o.extra === 'vent') solids.push(cy(w - 0.12, 0, 0.12, 0.04, 0.04, METAL, 'y'));
  return solids;
}

/** The ∩ outline of a bike hoop, in the (x, z) plane — extruded along y. */
const HOOP: Vec2[] = [
  [0, 0], [0.05, 0], [0.05, 0.85], [0.45, 0.85], [0.45, 0], [0.50, 0], [0.50, 0.90], [0, 0.90],
];

/**
 * Per-length kitchen counter: the door panel COUNT changes with the run length
 * (`n = clamp(round(w / 0.6), 1, 5)`), which is what a non-uniform scale could never do.
 */
function counterAt(w: number, id?: string): FurnitureTypeDef {
  const { d } = FURNITURE_CATALOG['kitchen-counter'];
  const n = Math.min(5, Math.max(1, Math.round(w / 0.6)));
  const bay = w / n;
  const solids: Solid[] = [
    bx(0.02, 0.02, 0, w - 0.04, 0.53, 0.10, DARK),
    bx(0, 0.02, 0.10, w, 0.56, 0.76, WOOD),
    bx(0, 0, 0.86, w, d, 0.04, DARK),
  ];
  for (let i = 0; i < n; i++) solids.push(bx(i * bay + 0.005, 0.58, 0.12, bay - 0.01, 0.02, 0.70, WOOD));
  return def({
    type: 'kitchen-counter', predefinedType: 'USERDEFINED', solids, color: WOOD,
    stretch: 'x', width: r4(w), id,
  });
}

/**
 * One entry per FurnitureType, in catalogue order (which fixes the STEP id order for a
 * given model). `footprint` is the catalogue's w/d to the byte; `height` is the real
 * bounding height of the solids, which exceeds the catalogue's clear height wherever the
 * item has a headboard, a tap, a screen or a shower head.
 */
export const FURNITURE_TYPES: Partial<Record<FurnitureType, FurnitureTypeDef>> = {
  // --- beds and bedroom -----------------------------------------------------
  'bed-king': bed('bed-king', 0.85, 2),
  'bed-queen': bed('bed-queen', 0.66, 2),
  'bed-double': bed('bed-double', 0.60, 2),
  'bed-single': bed('bed-single', 0.70, 1),
  'bed-bunk': def({
    type: 'bed-bunk', predefinedType: 'BED', color: WOOD,
    solids: [
      bx(0.05, 0.05, 0.30, 0.89, 1.80, 0.15, WOOD),
      bx(0, 0, 0.45, 0.99, 1.90, 0.18, MATTRESS),
      bx(0.05, 0.05, 1.20, 0.89, 1.80, 0.15, WOOD),
      bx(0, 0, 1.35, 0.99, 1.90, 0.18, MATTRESS),
      cy(0.05, 0.05, 0, 0.03, 1.70, METAL),
      cy(0.94, 0.05, 0, 0.03, 1.70, METAL),
      cy(0.05, 1.85, 0, 0.03, 1.70, METAL),
      cy(0.94, 1.85, 0, 0.03, 1.70, METAL),
    ],
  }),
  nightstand: def({
    type: 'nightstand', predefinedType: 'TABLE', color: WOOD,
    solids: [
      ...carcass(0.50, 0.40, 0.55, { body: WOOD, cols: 1 }),
      cy(0.25, 0.38, 0.30, 0.015, 0.02, METAL, 'y'),
    ],
  }),
  wardrobe: def({
    type: 'wardrobe', predefinedType: 'USERDEFINED', color: WOOD,
    solids: [
      ...carcass(1.20, 0.60, 2.10, { body: WOOD, cols: 2 }),
      cy(0.575, 0.585, 1.00, 0.012, 0.10, METAL),
      cy(0.625, 0.585, 1.00, 0.012, 0.10, METAL),
    ],
  }),
  dresser: def({
    type: 'dresser', predefinedType: 'USERDEFINED', color: WOOD,
    solids: carcass(1.20, 0.50, 0.80, { body: WOOD, cols: 1, rows: 3 }),
  }),
  crib: def({
    type: 'crib', predefinedType: 'BED', color: WOOD,
    solids: [
      bx(0.04, 0.04, 0.30, 0.62, 1.22, 0.05, WOOD),
      bx(0.04, 0.04, 0.35, 0.62, 1.22, 0.10, MATTRESS),
      bx(0, 0, 0, 0.70, 0.04, 0.90, WOOD),
      bx(0, 1.26, 0, 0.70, 0.04, 0.90, WOOD),
      bx(0, 0.04, 0, 0.04, 1.22, 0.90, WOOD),
      bx(0.66, 0.04, 0, 0.04, 1.22, 0.90, WOOD),
    ],
  }),

  // --- living / study -------------------------------------------------------
  desk: def({
    type: 'desk', predefinedType: 'DESK', color: WOOD,
    solids: [
      ...table(1.20, 0.60, 0.75, { topH: 0.04, legR: 0.025, leg: METAL, top: WOOD }),
      bx(0.10, 0.02, 0.35, 1.00, 0.03, 0.30, WOOD),
    ],
  }),
  chair: def({
    type: 'chair', predefinedType: 'CHAIR', color: WOOD,
    solids: [
      ...table(0.45, 0.45, 0.49, { topH: 0.05, legR: 0.02, leg: METAL, top: WOOD }),
      bx(0.02, 0, 0.49, 0.41, 0.05, 0.36, WOOD),
    ],
  }),
  'sofa-3': def({
    type: 'sofa-3', predefinedType: 'SOFA', color: FABRIC,
    solids: seating(2.10, 0.90, 0.85, { backH: 0.45, cushions: 3 }),
  }),
  'sofa-2': def({
    type: 'sofa-2', predefinedType: 'SOFA', color: FABRIC,
    solids: seating(1.60, 0.90, 0.85, { backH: 0.45, cushions: 2 }),
  }),
  armchair: def({
    type: 'armchair', predefinedType: 'SOFA', color: FABRIC,
    solids: seating(0.85, 0.85, 0.85, { backH: 0.45, cushions: 1 }),
  }),
  'coffee-table': def({
    type: 'coffee-table', predefinedType: 'TABLE', color: WOOD,
    solids: [
      ...table(1.20, 0.60, 0.45, { topH: 0.04, legR: 0.025, leg: WOOD, top: WOOD }),
      bx(0.06, 0.06, 0.12, 1.08, 0.48, 0.03, WOOD),
    ],
  }),
  'tv-unit': def({
    type: 'tv-unit', predefinedType: 'USERDEFINED', color: WOOD,
    solids: [
      ...carcass(1.60, 0.45, 0.50, { body: WOOD, cols: 2 }),
      bx(0.25, 0.18, 0.50, 1.10, 0.04, 0.57, DARK),
    ],
  }),
  'dining-table-4': def({
    type: 'dining-table-4', predefinedType: 'TABLE', color: WOOD,
    solids: table(1.20, 0.80, 0.75, { topH: 0.04, legR: 0.03, leg: WOOD, top: WOOD }),
  }),
  'dining-table-6': def({
    type: 'dining-table-6', predefinedType: 'TABLE', color: WOOD,
    solids: [
      ...table(1.80, 0.90, 0.75, { topH: 0.04, legR: 0.03, leg: WOOD, top: WOOD }),
      bx(0.10, 0.435, 0.30, 1.60, 0.06, 0.06, WOOD),
    ],
  }),
  'dining-chair': def({
    type: 'dining-chair', predefinedType: 'CHAIR', color: WOOD,
    solids: [
      ...table(0.45, 0.45, 0.49, { topH: 0.04, legR: 0.02, leg: WOOD, top: WOOD }),
      bx(0.02, 0, 0.49, 0.41, 0.05, 0.41, WOOD),
    ],
  }),
  shelving: def({
    type: 'shelving', predefinedType: 'SHELF', color: WOOD,
    solids: [
      bx(0, 0, 0, 0.02, 0.35, 2.00, WOOD),
      bx(0.88, 0, 0, 0.02, 0.35, 2.00, WOOD),
      bx(0.02, 0, 0.40, 0.86, 0.35, 0.025, WOOD),
      bx(0.02, 0, 0.90, 0.86, 0.35, 0.025, WOOD),
      bx(0.02, 0, 1.40, 0.86, 0.35, 0.025, WOOD),
      bx(0.02, 0, 1.95, 0.86, 0.35, 0.025, WOOD),
    ],
  }),
  bookcase: def({
    type: 'bookcase', predefinedType: 'SHELF', color: WOOD,
    solids: [
      bx(0, 0, 0, 0.02, 0.35, 2.00, WOOD),
      bx(0.88, 0, 0, 0.02, 0.35, 2.00, WOOD),
      bx(0.02, 0, 0, 0.86, 0.02, 2.00, WOOD),
      bx(0.02, 0.02, 0.40, 0.86, 0.33, 0.025, WOOD),
      bx(0.02, 0.02, 0.90, 0.86, 0.33, 0.025, WOOD),
      bx(0.02, 0.02, 1.40, 0.86, 0.33, 0.025, WOOD),
      bx(0.02, 0.02, 1.95, 0.86, 0.33, 0.025, WOOD),
    ],
  }),
  'lounge-chair': def({
    type: 'lounge-chair', predefinedType: 'CHAIR', color: FABRIC,
    solids: seating(0.75, 0.85, 0.90, { backH: 0.55, cushions: 1 }),
  }),
  bench: def({
    type: 'bench', predefinedType: 'NOTDEFINED', color: WOOD,
    solids: [
      bx(0, 0, 0.41, 1.20, 0.40, 0.04, WOOD),
      bx(0.06, 0.05, 0, 0.05, 0.30, 0.41, WOOD),
      bx(1.09, 0.05, 0, 0.05, 0.30, 0.41, WOOD),
      bx(0.11, 0.18, 0.12, 0.98, 0.04, 0.04, WOOD),
    ],
  }),

  // --- kitchen --------------------------------------------------------------
  'kitchen-counter': counterAt(FURNITURE_CATALOG['kitchen-counter'].w),
  'kitchen-island': def({
    type: 'kitchen-island', predefinedType: 'USERDEFINED', color: WOOD,
    solids: [
      bx(0.07, 0.07, 0, 1.66, 0.76, 0.10, DARK),
      bx(0.05, 0.05, 0.10, 1.70, 0.80, 0.76, WOOD),
      bx(0, 0, 0.86, 1.80, 0.90, 0.04, DARK),
      bx(0.06, 0.85, 0.12, 0.5567, 0.02, 0.70, WOOD),
      bx(0.6267, 0.85, 0.12, 0.5567, 0.02, 0.70, WOOD),
      bx(1.1933, 0.85, 0.12, 0.5567, 0.02, 0.70, WOOD),
    ],
  }),
  fridge: def({
    type: 'fridge', ifcType: APPLIANCE, predefinedType: 'FRIDGE_FREEZER', color: WHITE,
    solids: [
      bx(0, 0, 0, 0.90, 0.73, 1.80, WHITE),
      bx(0, 0.73, 0, 0.90, 0.02, 0.55, WHITE),
      bx(0, 0.73, 0.57, 0.90, 0.02, 1.23, WHITE),
      cy(0.83, 0.735, 0.68, 0.015, 0.35, METAL),
      cy(0.83, 0.735, 0.22, 0.015, 0.25, METAL),
    ],
  }),
  range: def({
    type: 'range', ifcType: APPLIANCE, predefinedType: 'ELECTRICCOOKER', color: WHITE,
    solids: [
      bx(0, 0, 0, 0.76, 0.63, 0.86, WHITE),
      bx(0, 0, 0.86, 0.76, 0.65, 0.04, DARK),
      cy(0.21, 0.20, 0.89, 0.09, 0.01, DARK),
      cy(0.55, 0.20, 0.89, 0.09, 0.01, DARK),
      cy(0.21, 0.45, 0.89, 0.09, 0.01, DARK),
      cy(0.55, 0.45, 0.89, 0.09, 0.01, DARK),
      bx(0, 0.63, 0.06, 0.76, 0.02, 0.66, DARK),
      cy(0.03, 0.635, 0.76, 0.015, 0.70, METAL, 'x'),
    ],
  }),
  dishwasher: def({
    type: 'dishwasher', ifcType: APPLIANCE, predefinedType: 'DISHWASHER', color: WHITE,
    solids: appliance(0.60, 0.60, 0.85, { front: 'door', extra: 'handle', stripZ: 0.74 }),
  }),
  'kitchen-sink': def({
    type: 'kitchen-sink', ifcType: SANITARY, predefinedType: 'SINK', color: METAL,
    solids: [
      bx(0, 0, 0.15, 0.80, 0.60, 0.05, METAL),
      bx(0.06, 0.08, 0, 0.50, 0.44, 0.15, METAL),
      bx(0.58, 0.08, 0.13, 0.18, 0.44, 0.02, METAL),
      cy(0.40, 0.08, 0.20, 0.018, 0.28, METAL),
      bx(0.375, 0.08, 0.45, 0.05, 0.14, 0.04, METAL),
    ],
  }),

  // --- bathroom / laundry ---------------------------------------------------
  wc: def({
    type: 'wc', ifcType: SANITARY, predefinedType: 'TOILETPAN', color: CERAMIC,
    solids: [
      bx(0, 0, 0.30, 0.40, 0.15, 0.50, CERAMIC),
      bx(0.09, 0.20, 0, 0.22, 0.40, 0.32, CERAMIC),
      el(0.20, 0.42, 0.32, 0.19, 0.26, 0.08, CERAMIC),
      el(0.20, 0.42, 0.40, 0.19, 0.26, 0.04, WHITE),
    ],
  }),
  lavatory: def({
    type: 'lavatory', ifcType: SANITARY, predefinedType: 'WASHHANDBASIN', color: CERAMIC,
    solids: [
      bx(0.22, 0.15, 0, 0.16, 0.20, 0.78, CERAMIC),
      el(0.30, 0.25, 0.78, 0.29, 0.24, 0.07, CERAMIC),
      cy(0.30, 0.06, 0.85, 0.018, 0.14, METAL),
      bx(0.282, 0.06, 0.98, 0.036, 0.12, 0.04, METAL),
    ],
  }),
  vanity: def({
    type: 'vanity', ifcType: SANITARY, predefinedType: 'WASHHANDBASIN', color: WOOD,
    solids: [
      ...carcass(0.90, 0.55, 0.80, { body: WOOD, cols: 2 }),
      bx(0, 0, 0.80, 0.90, 0.55, 0.05, CERAMIC),
      el(0.45, 0.28, 0.78, 0.22, 0.19, 0.07, CERAMIC),
      cy(0.45, 0.06, 0.85, 0.018, 0.12, METAL),
    ],
  }),
  shower: def({
    type: 'shower', ifcType: SANITARY, predefinedType: 'SHOWER', color: CERAMIC,
    symbolExtra: [[[0, 0], [0.90, 0.90]]],
    solids: [
      bx(0, 0, 0, 0.90, 0.90, 0.12, CERAMIC),
      bx(0.88, 0, 0.12, 0.02, 0.90, 1.88, GLASS),
      bx(0, 0.88, 0.12, 0.90, 0.02, 1.88, GLASS),
      bx(0.03, 0.03, 0.12, 0.04, 0.04, 1.83, METAL),
      cy(0.05, 0.05, 1.99, 0.05, 0.04, METAL),
      cy(0.45, 0.45, 0.12, 0.05, 0.02, METAL),
    ],
  }),
  bathtub: def({
    type: 'bathtub', ifcType: SANITARY, predefinedType: 'BATH', color: CERAMIC,
    solids: [
      bx(0, 0, 0, 1.70, 0.75, 0.55, CERAMIC),
      el(0.85, 0.375, 0.45, 0.74, 0.30, 0.10, GLASS),
      cy(0.12, 0.10, 0.55, 0.018, 0.18, METAL),
      bx(0.12, 0.082, 0.69, 0.18, 0.036, 0.04, METAL),
    ],
  }),
  washer: def({
    type: 'washer', ifcType: APPLIANCE, predefinedType: 'WASHINGMACHINE', color: WHITE,
    solids: appliance(0.60, 0.60, 0.85, { front: 'porthole', extra: 'drawer', stripZ: 0.70 }),
  }),
  dryer: def({
    type: 'dryer', ifcType: APPLIANCE, predefinedType: 'TUMBLEDRYER', color: WHITE,
    solids: appliance(0.60, 0.60, 0.85, { front: 'porthole', extra: 'vent', stripZ: 0.70 }),
  }),
  'water-heater': def({
    type: 'water-heater', ifcType: APPLIANCE, predefinedType: 'FREESTANDINGWATERHEATER', color: METAL,
    solids: [
      cy(0.30, 0.30, 0, 0.29, 1.40, METAL),
      cy(0.30, 0.30, 1.40, 0.29, 0.10, WHITE),
      cy(0.18, 0.08, 1.30, 0.02, 0.20, METAL),
      cy(0.42, 0.08, 1.30, 0.02, 0.20, METAL),
    ],
  }),
  'grab-rail': def({
    type: 'grab-rail', predefinedType: 'NOTDEFINED', color: METAL,
    solids: [
      cy(0, 0.025, 0.025, 0.018, 0.60, METAL, 'x'),
      cy(0, 0.025, 0.025, 0.025, 0.02, METAL, 'x'),
      cy(0.58, 0.025, 0.025, 0.025, 0.02, METAL, 'x'),
    ],
  }),

  // --- outdoor / common / parking ------------------------------------------
  planter: def({
    type: 'planter', predefinedType: 'NOTDEFINED', color: CERAMIC,
    solids: [
      cy(0.25, 0.25, 0, 0.25, 0.55, CERAMIC),
      cy(0.25, 0.25, 0.50, 0.22, 0.05, DARK),
      cy(0.25, 0.25, 0.55, 0.18, 0.30, FOLIAGE),
    ],
  }),
  'outdoor-table': def({
    type: 'outdoor-table', predefinedType: 'TABLE', color: METAL,
    solids: [
      cy(0.40, 0.40, 0.70, 0.40, 0.04, METAL),
      cy(0.40, 0.40, 0.03, 0.04, 0.67, METAL),
      cy(0.40, 0.40, 0, 0.22, 0.03, METAL),
    ],
  }),
  'bike-rack': def({
    type: 'bike-rack', predefinedType: 'NOTDEFINED', color: METAL,
    solids: [
      pr(0.05, 0.28, 0, HOOP, 0.04, METAL, 'y'),
      pr(0.65, 0.28, 0, HOOP, 0.04, METAL, 'y'),
      pr(1.25, 0.28, 0, HOOP, 0.04, METAL, 'y'),
      bx(0.05, 0.26, 0, 1.70, 0.08, 0.06, METAL),
    ],
  }),
  'mailbox-bank': def({
    type: 'mailbox-bank', predefinedType: 'USERDEFINED', color: METAL,
    solids: carcass(1.20, 0.40, 1.20, { body: METAL, plinth: 0.10, cols: 2, rows: 2 }),
  }),
  'reception-desk': def({
    type: 'reception-desk', predefinedType: 'DESK', color: WOOD,
    solids: [
      bx(0.02, 0.02, 0, 2.36, 0.46, 0.10, DARK),
      bx(0, 0, 0.10, 2.40, 0.50, 0.62, WOOD),
      bx(0, 0, 0.72, 2.40, 0.50, 0.03, WOOD),
      bx(0, 0.50, 0, 2.40, 0.25, 1.05, WOOD),
      bx(0, 0.45, 1.05, 2.40, 0.35, 0.05, WOOD),
    ],
  }),
  treadmill: def({
    type: 'treadmill', ifcType: APPLIANCE, predefinedType: 'NOTDEFINED', color: DARK,
    symbolExtra: [[[0.45, 0.55], [0.45, 1.95]]],
    solids: [
      bx(0, 0.50, 0, 0.90, 1.50, 0.15, DARK),
      bx(0.08, 0.55, 0.15, 0.74, 1.40, 0.02, RUBBER),
      bx(0.02, 0.40, 0.15, 0.10, 0.10, 0.95, METAL),
      bx(0.78, 0.40, 0.15, 0.10, 0.10, 0.95, METAL),
      bx(0, 0.30, 1.10, 0.90, 0.22, 0.30, DARK),
      cy(0.02, 0.45, 1.05, 0.02, 0.86, METAL, 'x'),
    ],
  }),
  car: def({
    type: 'car', ifcType: PROXY, predefinedType: 'ELEMENT', color: CARBODY,
    solids: [
      bx(0, 0.30, 0.25, 1.80, 3.90, 0.55, CARBODY),
      bx(0.05, 0.10, 0.60, 1.70, 0.90, 0.20, CARBODY),
      bx(0.05, 3.60, 0.60, 1.70, 0.80, 0.20, CARBODY),
      bx(0.08, 1.20, 0.80, 1.64, 2.00, 0.70, GLASS),
      cy(0, 0.95, 0.32, 0.32, 0.20, DARK, 'x'),
      cy(1.60, 0.95, 0.32, 0.32, 0.20, DARK, 'x'),
      cy(0, 3.45, 0.32, 0.32, 0.20, DARK, 'x'),
      cy(1.60, 3.45, 0.32, 0.32, 0.20, DARK, 'x'),
    ],
  }),
};

/** Per-length builders for the stretchable types, keyed by FurnitureType. */
const STRETCH_BUILDERS: Partial<Record<FurnitureType, (w: number, id: string) => FurnitureTypeDef>> = {
  'kitchen-counter': counterAt,
};

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

// ============================================================================
// Per-length variants
// ============================================================================

/**
 * Stretchable types are per-length TYPES, not scaled instances: the width is quantised to
 * {@link STRETCH_QUANTUM} and the builder re-derives the solids at that width, so a 3.4 m
 * counter gets five door panels instead of one smeared 2.8× reveal. Results are memoised
 * because the 2D plan resolves a type per instance per frame.
 */
const stretchCache = new Map<string, FurnitureTypeDef>();
setStretchBuilder((base, width) => {
  const w = Math.min(STRETCH_MAX, Math.max(STRETCH_MIN, width));
  const cm = Math.round(w / STRETCH_QUANTUM) * 10;
  const id = `${FURNITURE_TYPE_ID_PREFIX}${base.furnitureType}-w${cm}`;
  const cached = stretchCache.get(id);
  if (cached) return cached;
  const build = STRETCH_BUILDERS[base.furnitureType];
  const made = build
    ? build(r4(cm / 100), id)
    : { ...base, id, footprint: { w: r4(cm / 100), d: base.footprint.d } };
  stretchCache.set(id, made);
  return made;
});
