/**
 * Member sizing, load assumptions, section naming and embodied-carbon factors for the
 * structural discipline. Pure functions — no geometry, no ids, no randomness.
 *
 * Patterns implemented here: STR-01 (system by height), STR-09 (economic span),
 * STR-10 (balanced column sizes), STR-06 (foundation sizing rules).
 */
import type { FoundationType, MaterialDef, RGB, StructuralSystemId } from '../../core/types.ts';

export type FrameMaterial = 'concrete' | 'steel' | 'timber';
export type WallMaterial = 'concrete' | 'masonry' | 'timber' | 'clt';

export interface Sizes {
  columnW: number;
  columnD: number;
  beamW: number;
  beamD: number;
  slabT: number;
  shearWallT: number;
}

export interface Loads {
  deadKpa: number;
  liveKpa: number;
  roofLiveKpa: number;
}

/** Live load on corridors and lobbies above the first floor (kPa) */
export const LIVE_CORRIDOR_KPA = 2.4;

/** Canonical order used to encode `derived.structureSystem` as a number */
export const SYSTEM_ORDER: StructuralSystemId[] = [
  'light-wood-frame',
  'masonry-bearing',
  'mass-timber-clt',
  'wood-over-podium',
  'rc-flat-slab',
  'rc-flat-plate-core',
  'steel-frame',
];

/** Canonical order used to encode `derived.foundationType` as a number */
export const FOUNDATION_ORDER: FoundationType[] = [
  'slab-on-grade',
  'strip-footing',
  'pad-footing',
  'raft',
  'piles',
];

export function systemIndex(s: StructuralSystemId): number {
  const i = SYSTEM_ORDER.indexOf(s);
  return i < 0 ? -1 : i;
}

export function foundationIndex(f: FoundationType): number {
  const i = FOUNDATION_ORDER.indexOf(f);
  return i < 0 ? -1 : i;
}

// ----------------------------------------------------------------------------
// System classification (STR-01)
// ----------------------------------------------------------------------------

/** Systems whose gravity load is carried by walls, not columns */
export function isBearingWallSystem(s: StructuralSystemId): boolean {
  return s === 'light-wood-frame' || s === 'masonry-bearing' || s === 'mass-timber-clt';
}

/** Systems framed with columns and beams/flat slabs on every storey */
export function isFrameSystem(s: StructuralSystemId): boolean {
  return s === 'rc-flat-slab' || s === 'rc-flat-plate-core' || s === 'steel-frame';
}

/** Wood/mass-timber over a non-combustible podium: frame below, bearing walls above */
export function isHybridPodiumSystem(s: StructuralSystemId): boolean {
  return s === 'wood-over-podium';
}

export function columnMaterialFor(s: StructuralSystemId): FrameMaterial {
  if (s === 'steel-frame') return 'steel';
  if (s === 'mass-timber-clt') return 'timber';
  return 'concrete';
}

export function bearingWallMaterialFor(s: StructuralSystemId): WallMaterial {
  switch (s) {
    case 'masonry-bearing': return 'masonry';
    case 'mass-timber-clt': return 'clt';
    case 'light-wood-frame':
    case 'wood-over-podium': return 'timber';
    default: return 'concrete';
  }
}

/** Material of the floor plate on a residential storey (podium storeys are always concrete) */
export function floorPlateMaterialFor(s: StructuralSystemId): FrameMaterial {
  if (s === 'light-wood-frame' || s === 'wood-over-podium') return 'timber';
  if (s === 'mass-timber-clt') return 'timber';
  return 'concrete';
}

// ----------------------------------------------------------------------------
// Loads
// ----------------------------------------------------------------------------

export function loadsFor(system: StructuralSystemId): Loads {
  const dead =
    system === 'light-wood-frame' ? 5.0 :
    system === 'mass-timber-clt' ? 5.0 :
    system === 'masonry-bearing' ? 5.5 :
    system === 'steel-frame' ? 5.5 :
    system === 'rc-flat-slab' ? 6.0 :
    system === 'wood-over-podium' ? 6.0 :
    7.0; // rc-flat-plate-core
  return { deadKpa: dead, liveKpa: 1.9, roofLiveKpa: 1.0 };
}

// ----------------------------------------------------------------------------
// Member sizes (STR-09, STR-10)
// ----------------------------------------------------------------------------

/** Concrete cylinder strength used for column sizing (kPa) */
const FC_KPA = 30_000;

export function roundUpTo(v: number, step: number): number {
  // round the product too: Math.ceil(x / 0.05) * 0.05 leaves values like 0.6000000000000001
  return Math.round(Math.ceil(v / step - 1e-9) * step * 1e6) / 1e6;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * STR-10 Balanced Column Sizes. Square column side (m) from the load it actually carries.
 * N [kN] = storeysAbove x (dead + live) x tributaryArea; A = N / (0.3 f'c); side rounded up to 50 mm.
 */
export function columnSide(material: FrameMaterial, storeysAbove: number, tributaryM2: number, loads: Loads): number {
  const q = loads.deadKpa + loads.liveKpa;
  const nKn = Math.max(1, storeysAbove) * q * Math.max(1, tributaryM2);
  if (material === 'timber') return 0.14;
  if (material === 'steel') {
    // Square HSS ladder; the axial thresholds bracket HSS 300x300x10 .. HSS 500x500x16 at fy 355 MPa
    const side = nKn < 1500 ? 0.3 : nKn < 3000 ? 0.35 : nKn < 5000 ? 0.4 : nKn < 8000 ? 0.45 : 0.5;
    return side;
  }
  const areaM2 = nKn / (0.3 * FC_KPA);
  return clamp(roundUpTo(Math.sqrt(areaM2), 0.05), 0.4, 0.9);
}

export function columnBand(material: FrameMaterial): { min: number; max: number } {
  if (material === 'timber') return { min: 0.14, max: 0.14 };
  if (material === 'steel') return { min: 0.3, max: 0.5 };
  return { min: 0.4, max: 0.9 };
}

/** Typical sizes for the system; per-column sizes are refined by `columnSide` */
export function sizesFor(system: StructuralSystemId, storeys: number, typicalTributaryM2: number, loads: Loads): Sizes {
  const colMat = columnMaterialFor(system);
  const side = isBearingWallSystem(system) && system !== 'mass-timber-clt'
    ? 0.14
    : columnSide(colMat, storeys, typicalTributaryM2, loads);
  let beamW = 0.3, beamD = 0.5;
  switch (system) {
    case 'light-wood-frame':
      beamW = 0.05; beamD = 0.3; break;          // 2-ply LVL rim board 45 x 300
    case 'masonry-bearing':
      beamW = 0.2; beamD = 0.3; break;           // precast concrete lintel / ring beam
    case 'mass-timber-clt':
      beamW = 0.2; beamD = 0.45; break;          // glulam GL24h 200 x 450
    case 'wood-over-podium':
      beamW = 0.3; beamD = 0.5; break;           // podium RC; timber rim above uses TIMBER_RIM
    case 'steel-frame':
      beamW = 0.25; beamD = 0.45; break;         // W18x50-ish
    default:
      beamW = 0.3; beamD = 0.5; break;           // RC rim/edge beam
  }
  const slabT = system === 'rc-flat-plate-core' ? 0.25 : 0.2;
  return {
    columnW: side,
    columnD: side,
    beamW,
    beamD,
    slabT,
    shearWallT: 0.3,
  };
}

/** Laminated timber rim board used above a podium and in light frame */
export const TIMBER_RIM = { w: 0.05, d: 0.3 } as const;
/** Header / lintel over an opening (STR-08) */
export const LINTEL = { depth: 0.2, bearing: 0.15, clearance: 0.05, triggerWidth: 1.2 } as const;
/** Transfer level (STR-04) */
export const TRANSFER = { slabT: 0.3, beamW: 0.5, beamD: 0.9, moduleAlong: 8.4, moduleAcross: 16.8 } as const;
/** Grid spacing rules (STR-02, STR-09) */
export const GRID_RULES = { minSpacing: 4.0, maxSpacing: 9.0, pointPlateTarget: 7.5, snapDistance: 0.6 } as const;
/** Foundation sizing (STR-06) */
export const FOUNDATION_RULES = {
  stripWidth: 0.6,
  stripHeight: 0.3,
  stemWallT: 0.25,
  padHeight: 0.5,
  padMax: 3.5,
  raftT: 0.8,
  pileCapSize: 1.8,
  pileCapHeight: 0.9,
  pileDiameter: 0.6,
  pileLength: 18,
  pileLengthTall: 25,
  slabOnGradeEdge: 0.4,
} as const;

/** STR-06: square pad footing side under a column (m) */
export function padSide(storeys: number): number {
  return Math.min(FOUNDATION_RULES.padMax, 0.15 * storeys + 1.2);
}

// ----------------------------------------------------------------------------
// Section naming
// ----------------------------------------------------------------------------

const MM = (v: number): number => Math.round(v * 1000);

/** Nominal US wide-flange designations by section depth (mm) — used for steel beam labels */
const W_SHAPES: { depth: number; name: string }[] = [
  { depth: 200, name: 'W8x18' },
  { depth: 250, name: 'W10x22' },
  { depth: 300, name: 'W12x26' },
  { depth: 350, name: 'W14x30' },
  { depth: 400, name: 'W16x40' },
  { depth: 450, name: 'W18x50' },
  { depth: 530, name: 'W21x62' },
  { depth: 610, name: 'W24x68' },
];

export function wShapeFor(depthM: number): string {
  const d = MM(depthM);
  let best = W_SHAPES[0];
  for (const s of W_SHAPES) if (Math.abs(s.depth - d) < Math.abs(best.depth - d)) best = s;
  return best.name;
}

export function columnSection(material: FrameMaterial, w: number, d: number): string {
  if (material === 'steel') return `HSS ${MM(w)}x${MM(d)}x12`;
  if (material === 'timber') return `Glulam ${MM(w)}x${MM(d)} GL24h`;
  return `${MM(w)}x${MM(d)} RC`;
}

export function beamSection(material: FrameMaterial, w: number, d: number): string {
  if (material === 'steel') return `${wShapeFor(d)} (${MM(w)}x${MM(d)} rect. profile)`;
  if (material === 'timber') return MM(w) <= 60 ? `LVL rim ${MM(w)}x${MM(d)}` : `Glulam GL24h ${MM(w)}x${MM(d)}`;
  return `${MM(w)}x${MM(d)} RC`;
}

export function slabSection(material: FrameMaterial, t: number, system: StructuralSystemId): string {
  if (material === 'timber') {
    return system === 'mass-timber-clt' ? `CLT ${MM(t)} 5-ply` : `${MM(t)} timber floor cassette (I-joist + OSB)`;
  }
  return `${MM(t)} RC flat slab`;
}

// ----------------------------------------------------------------------------
// Materials and colours
// ----------------------------------------------------------------------------

export const MATERIALS: Record<string, MaterialDef> = {
  concrete: { name: 'Concrete C30/37', category: 'concrete' },
  reinforcedConcrete: { name: 'Reinforced concrete', category: 'concrete' },
  steel: { name: 'Steel S355', category: 'steel' },
  glulam: { name: 'Glulam GL24h', category: 'wood' },
  clt: { name: 'CLT', category: 'wood' },
  timber: { name: 'Glulam GL24h', category: 'wood' },
  masonry: { name: 'Concrete blockwork', category: 'masonry' },
};

export function materialFor(kind: FrameMaterial | WallMaterial, engineered = false): MaterialDef {
  switch (kind) {
    case 'steel': return MATERIALS.steel;
    case 'timber': return engineered ? MATERIALS.glulam : MATERIALS.glulam;
    case 'clt': return MATERIALS.clt;
    case 'masonry': return MATERIALS.masonry;
    default: return MATERIALS.reinforcedConcrete;
  }
}

export const COLORS: Record<string, RGB> = {
  rc: [0.62, 0.62, 0.66],
  steel: [0.35, 0.4, 0.5],
  timber: [0.72, 0.55, 0.35],
  slab: [0.78, 0.78, 0.8],
  foundation: [0.5, 0.45, 0.4],
  pile: [0.45, 0.4, 0.38],
};

export function frameColor(material: FrameMaterial): RGB {
  return material === 'steel' ? COLORS.steel : material === 'timber' ? COLORS.timber : COLORS.rc;
}

// ----------------------------------------------------------------------------
// Embodied carbon (upfront A1–A3, gross: biogenic storage NOT deducted)
// ----------------------------------------------------------------------------

export const CARBON = {
  /** C30/37 concrete: 2400 kg/m³ x 0.13 kgCO2e/kg */
  concreteKgCO2ePerM3: 2400 * 0.13,
  /** Average reinforcement content of the modelled RC elements */
  rebarKgPerM3: 86,
  /** Reinforcing bar, world average */
  rebarKgCO2ePerKg: 1.95,
  /** Structural steel section, world average */
  steelKgCO2ePerKg: 1.5,
  /** Softwood glulam / CLT / I-joist floor: 500 kg/m³ x 0.4 kgCO2e/kg */
  timberKgCO2ePerM3: 500 * 0.4,
} as const;

/** Reinforced concrete, including reinforcement (kgCO2e/m³) */
export const RC_KGCO2E_PER_M3 = CARBON.concreteKgCO2ePerM3 + CARBON.rebarKgPerM3 * CARBON.rebarKgCO2ePerKg;

/** Structural timber volume per m² of timber-framed floor area (m³/m²) */
export function timberIntensity(system: StructuralSystemId): number {
  return system === 'mass-timber-clt' ? 0.14 : 0.18;
}

/** Structural steel mass per m² of framed floor area (kg/m²) */
export const STEEL_KG_PER_M2 = 60;
