/**
 * The coordination number tables: clearances, hangers, slopes, trap arms, clear heights, where each kind of service
 * lives when it is not in the ceiling (`ROUTE_HOME`) and how hard it is to move (`MOVE_COST`).
 *
 * Every number carries a `source`. These tables are the single owner of the values; `builtin.ts` lifts them into
 * `Rule` records (so they appear on the Rules tab and can be overridden per project), and the profiles, lanes,
 * registry and support checks read them from here.
 *
 * Units: metres, and slopes as a dimensionless fall (1:100 = 0.01).
 */
import type { Region } from '../types.ts';
import { cite } from '../rules/SOURCES.ts';
import type { ElementKind, Home, ProfileId } from './types.ts';

// ---------------------------------------------------------------------------------------------------------------
// Hangers — what holds a horizontal run up, and how far below the soffit it may hang
// ---------------------------------------------------------------------------------------------------------------

export interface HangerSpec {
  /** Longest hanger rod / drop from the supporting soffit (m) */
  maxDrop: number;
  /** Longest spacing between hangers along the run (m) */
  maxSpacing: number;
  source: string;
  note: string;
}

export interface HangerQuery {
  /** Outside diameter (m) for pipes, or the larger duct side */
  diameter?: number;
  material?: 'copper' | 'plastic' | 'cast-iron' | 'steel';
  round?: boolean;
}

export const HANGER_DUCT_RECT: HangerSpec = {
  maxDrop: 1.5,
  maxSpacing: 2.44,
  source: cite('SMACNA 3rd ed.', 'Table 5-1'),
  note: 'Rectangular duct on strap or trapeze hangers at 8 ft centres.',
};
export const HANGER_DUCT_ROUND: HangerSpec = {
  maxDrop: 1.5,
  maxSpacing: 3.66,
  source: cite('SMACNA 3rd ed.', 'Table 5-2'),
  note: 'Round duct up to Ø600 on 12 ft centres.',
};
export const HANGER_PIPE_COPPER_SMALL: HangerSpec = {
  maxDrop: 1.2,
  maxSpacing: 1.83,
  source: cite('IPC 2021', 'Table 308.5'),
  note: 'Copper tubing 1 1/4 in and smaller: 6 ft horizontal spacing.',
};
export const HANGER_PIPE_COPPER_LARGE: HangerSpec = {
  maxDrop: 1.2,
  maxSpacing: 3.05,
  source: cite('IPC 2021', 'Table 308.5'),
  note: 'Copper tubing 1 1/2 in and larger: 10 ft horizontal spacing.',
};
export const HANGER_PIPE_PLASTIC: HangerSpec = {
  maxDrop: 1.2,
  maxSpacing: 1.22,
  source: cite('IPC 2021', 'Table 308.5'),
  note: 'PVC / ABS drainage: 4 ft horizontal spacing.',
};
export const HANGER_PIPE_CAST_IRON: HangerSpec = {
  maxDrop: 1.2,
  maxSpacing: 1.52,
  source: cite('IPC 2021', 'Table 308.5'),
  note: 'Cast iron: 5 ft, and at every joint.',
};
export const HANGER_SPRINKLER: HangerSpec = {
  maxDrop: 0.9,
  maxSpacing: 3.66,
  source: cite('NFPA 13 2022', 'Table 9.2.2.1'),
  note: 'Ø25–Ø50 steel branch line: 12 ft between hangers.',
};
export const HANGER_TRAY: HangerSpec = {
  maxDrop: 1.5,
  maxSpacing: 1.52,
  source: cite('NEC 2023', '392.30(A)'),
  note: 'Cable tray supported at 5 ft; see also NEMA VE 2 installation guidance.',
};
export const HANGER_BUSDUCT: HangerSpec = {
  maxDrop: 1.5,
  maxSpacing: 1.52,
  source: cite('NEC 2023', '368.30'),
  note: 'Busway supported at 5 ft unless designed otherwise.',
};

/** Default hanger spec per element kind; refine with `hangerFor` when the diameter/material is known. */
export const HANGERS: Readonly<Partial<Record<ElementKind, HangerSpec>>> = {
  'duct': HANGER_DUCT_RECT,
  'duct-fitting': HANGER_DUCT_RECT,
  'air-terminal': HANGER_DUCT_ROUND,
  'fan': HANGER_DUCT_RECT,
  'jet-fan': HANGER_DUCT_RECT,
  'waste': HANGER_PIPE_PLASTIC,
  'vent': HANGER_PIPE_PLASTIC,
  'storm': HANGER_PIPE_PLASTIC,
  'trench-drain': HANGER_PIPE_CAST_IRON,
  'dcw': HANGER_PIPE_COPPER_LARGE,
  'dhw': HANGER_PIPE_COPPER_LARGE,
  'hwr': HANGER_PIPE_COPPER_SMALL,
  'gas': HANGER_PIPE_COPPER_LARGE,
  'sprinkler-main': HANGER_SPRINKLER,
  'sprinkler-branch': HANGER_SPRINKLER,
  'sprinkler-head': HANGER_SPRINKLER,
  'standpipe': HANGER_PIPE_CAST_IRON,
  'tray-power': HANGER_TRAY,
  'tray-data': HANGER_TRAY,
  'conduit': HANGER_TRAY,
  'busduct': HANGER_BUSDUCT,
  'light': { maxDrop: 1.5, maxSpacing: 2.0, source: cite('NEC 2023', '410.36'), note: 'Luminaire securely supported from the structure or the ceiling grid.' },
  'sensor': { maxDrop: 1.5, maxSpacing: 2.0, source: cite('NEC 2023', '314.23'), note: 'Device box supported from the structure or the ceiling grid.' },
};

export function hangerFor(kind: ElementKind, q?: HangerQuery): HangerSpec | null {
  if (kind === 'duct' || kind === 'duct-fitting') return q?.round ? HANGER_DUCT_ROUND : HANGER_DUCT_RECT;
  if (kind === 'waste' || kind === 'vent' || kind === 'storm') {
    if (q?.material === 'cast-iron') return HANGER_PIPE_CAST_IRON;
    return HANGER_PIPE_PLASTIC;
  }
  if (kind === 'dcw' || kind === 'dhw' || kind === 'hwr' || kind === 'gas') {
    return (q?.diameter ?? 0.05) >= 0.032 ? HANGER_PIPE_COPPER_LARGE : HANGER_PIPE_COPPER_SMALL;
  }
  return HANGERS[kind] ?? null;
}

// ---------------------------------------------------------------------------------------------------------------
// Slopes — gravity systems only. A run steeper than `maxGravity` must become a vertical leg.
// ---------------------------------------------------------------------------------------------------------------

export interface SlopeStep {
  /** Applies to diameters up to and including this (m) */
  maxDiameter: number;
  /** Minimum fall as a ratio */
  slope: number;
  source: string;
}

export const SLOPES = {
  /** IPC Table 704.1: 1/4 in/ft to Ø75, 1/8 in/ft Ø100–Ø150, 1/16 in/ft Ø200 and larger */
  sanitary: [
    { maxDiameter: 0.075, slope: 1 / 50, source: cite('IPC 2021', 'Table 704.1') },
    { maxDiameter: 0.15, slope: 1 / 100, source: cite('IPC 2021', 'Table 704.1') },
    { maxDiameter: Number.POSITIVE_INFINITY, slope: 1 / 200, source: cite('IPC 2021', 'Table 704.1') },
  ] as readonly SlopeStep[],
  /** UK / Ireland practice: 1:80 on Ø100 foul drains */
  sanitaryUK: [
    { maxDiameter: 0.075, slope: 1 / 40, source: cite('BS EN 12056-2:2000', '§6.3') },
    { maxDiameter: Number.POSITIVE_INFINITY, slope: 1 / 80, source: cite('ADH 2015', 'Table 10') },
  ] as readonly SlopeStep[],
  storm: { slope: 1 / 100, source: cite('IPC 2021', 'Table 1106.2') },
  trenchDrain: { slope: 1 / 100, source: cite('IPC 2021', '§1101.2') },
  condensate: { slope: 1 / 100, source: cite('IMC 2021', '§307.2.2') },
  /** Maximum fall on a trap arm before the trap self-siphons */
  trapArmMaxFall: { slope: 1 / 48, source: cite('IPC 2021', '§1002.2') },
  /** Steeper than this is not a sloped run any more */
  maxGravity: { slope: 1 / 12, source: cite('default', '(steeper → model it as a vertical leg)') },
} as const;

export function slopeFor(system: 'sanitary' | 'storm' | 'trench-drain' | 'condensate', diameter: number, region?: Region): number {
  if (system === 'storm') return SLOPES.storm.slope;
  if (system === 'trench-drain') return SLOPES.trenchDrain.slope;
  if (system === 'condensate') return SLOPES.condensate.slope;
  const table = region === 'UK' || region === 'IE' ? SLOPES.sanitaryUK : SLOPES.sanitary;
  for (const s of table) if (diameter <= s.maxDiameter + 1e-9) return s.slope;
  return table[table.length - 1].slope;
}

// ---------------------------------------------------------------------------------------------------------------
// Trap arms — IPC 2021 Table 1002.2. v1 (`plumbing/tables.ts`) mis-binned Ø50 at 1.5 m; the correct limit is 1.83 m.
// ---------------------------------------------------------------------------------------------------------------

export const TRAP_ARM_SOURCE = cite('IPC 2021', 'Table 1002.2');

export const TRAP_ARMS: readonly [number, number][] = [
  [0.032, 1.07],
  [0.04, 1.52],
  [0.05, 1.83],
  [0.075, 3.05],
  [0.1, 3.66],
];

/** Maximum developed length of a trap arm for a trap of this diameter (m). */
export function trapArmLimit(diameter: number): number {
  let out = TRAP_ARMS[0][1];
  for (const [d, limit] of TRAP_ARMS) {
    if (diameter >= d - 1e-9) out = limit;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Clear heights per ceiling profile (and the sub-zones with a higher requirement)
// ---------------------------------------------------------------------------------------------------------------

export interface ClearHeightSpec {
  min: number;
  target: number;
  source: string;
}

export const CLEAR_HEIGHTS: Readonly<Record<ProfileId, ClearHeightSpec>> = {
  'resi-unit': { min: 2.3, target: 2.5, source: `${cite('IBC 2021', '§1208.2')}; ${cite('NCC 2022', 'Table F5.1')}; ${cite('London Housing SPG 2016', '§3.3.6')}` },
  'resi-corridor': { min: 2.1, target: 2.4, source: `${cite('IBC 2021', '§1003.2')}; ${cite('ADB 2019', 'B1')}` },
  'lobby': { min: 2.3, target: 2.7, source: `${cite('IBC 2021', '§1208.2 (2134 mm)')}; ${cite('ADM 2015', '§3 (entrance storey)')}` },
  'amenity': { min: 2.4, target: 3.0, source: cite('IBC 2021', '§1208.2') },
  'parking': { min: 2.1, target: 2.3, source: `${cite('IBC 2021', '§406.4.1')}; ${cite('AS 2890.1-2004', '§5.3')}` },
  'retail-shell': { min: 2.4, target: 3.2, source: `${cite('IBC 2021', '§1208.2 (2134 mm)')}; ${cite('default', 'a shop unit wants 3.20 m; 2.40 m is the point at which the deep tenant plenum has to be given up')}` },
  'mep-room': { min: 2.1, target: 2.3, source: cite('IMC 2021', '§306.3') },
  'roof-plant': { min: 2.0, target: 2.2, source: cite('OSHA 1910', '1910.25 (walkway headroom)') },
  'basement-service': { min: 2.1, target: 2.3, source: cite('IBC 2021', '§1208.2') },
};

export interface ZoneClearSpec {
  profile: ProfileId;
  zone: string;
  minClear: number;
  source: string;
  note: string;
}

export const ZONE_CLEARS: readonly ZoneClearSpec[] = [
  { profile: 'resi-unit', zone: 'hall-bulkhead', minClear: 2.1, source: cite('IBC 2021', '§1208.2 exception'), note: 'Soffits and bulkheads are permitted over up to one third of the room area.' },
  { profile: 'resi-unit', zone: 'bathroom', minClear: 2.1, source: cite('IBC 2021', '§1208.2 exception'), note: 'Bathrooms, toilet rooms and kitchens may be 2.03 m; 2.10 m keeps a fan and a light in the void.' },
  { profile: 'parking', zone: 'accessible-route', minClear: 2.5, source: `${cite('ADA 2010', '§502.5')}; ${cite('AS 2890.6-2022', '§2.4')}`, note: 'Van-accessible stalls and the route to the lift lobby need 98 in of vertical clearance.' },
  { profile: 'parking', zone: 'van-stall', minClear: 2.5, source: cite('ADA 2010', '§502.5'), note: 'Same 2.50 m over the stall itself.' },
  { profile: 'parking', zone: 'drive-aisle', minClear: 2.1, source: cite('IBC 2021', '§406.4.1'), note: 'The general clear height for passenger vehicles.' },
  { profile: 'basement-service', zone: 'accessible-route', minClear: 2.5, source: cite('ADA 2010', '§502.5'), note: 'Basement service levels that carry an accessible route.' },
  { profile: 'roof-plant', zone: 'walkway', minClear: 2.0, source: cite('OSHA 1910', '1910.25'), note: 'Headroom over a maintenance walkway.' },
];

// ---------------------------------------------------------------------------------------------------------------
// Clearances between kinds (the "why" of the band and lane geometry)
// ---------------------------------------------------------------------------------------------------------------

export type ClearanceKind = 'install' | 'fire' | 'electrical-safety' | 'potable' | 'emc' | 'structural' | 'code' | 'access' | 'fall';

export interface ClearanceSpec {
  a: ElementKind | 'slab' | 'ceiling' | 'beam' | 'column' | 'any' | 'elevator-shaft' | 'parapet' | 'roof-plant-row';
  b: ElementKind | 'slab' | 'ceiling' | 'beam' | 'column' | 'any' | 'elevator-shaft' | 'parapet' | 'roof-plant-row';
  /** Minimum separation (m). 0 with `forbidden` means "not permitted at all". */
  min: number;
  kind: ClearanceKind;
  forbidden?: boolean;
  /** Direction requirement, e.g. 'dcw above waste' */
  order?: string;
  source: string;
  why: string;
}

export const CLEARANCES: readonly ClearanceSpec[] = [
  { a: 'duct', b: 'slab', min: 0.05, kind: 'install', source: cite('SMACNA 3rd ed.', 'Chapter 5'), why: 'Hanger, flange and insulation need a gap under the soffit.' },
  { a: 'duct', b: 'duct', min: 0.05, kind: 'install', source: cite('SMACNA 3rd ed.', 'Chapter 5'), why: 'Flanges and insulation between adjacent ducts.' },
  { a: 'duct', b: 'tray-power', min: 0.05, kind: 'install', order: 'tray below duct', source: cite('NEC 2023', '392.18(A)'), why: 'Tray must stay reachable from below; a duct over it is acceptable, under it is not.' },
  { a: 'sprinkler-head', b: 'ceiling', min: 0.025, kind: 'fire', source: cite('NFPA 13 2022', '§8.6.4.1.1.1'), why: 'Deflector 25–300 mm below a smooth ceiling.' },
  { a: 'sprinkler-head', b: 'any', min: 0.45, kind: 'fire', source: cite('NFPA 13 2022', 'Table 8.6.5.1.2'), why: 'Obstruction to discharge: 0.45 m, or three times the obstruction width.' },
  { a: 'sprinkler-main', b: 'slab', min: 0.025, kind: 'fire', source: cite('NFPA 13 2022', '§9.2.2'), why: 'The main hugs the soffit so branch lines can drop anywhere.' },
  { a: 'switchgear', b: 'any', min: 1.07, kind: 'electrical-safety', order: 'front', source: cite('NEC 2023', 'Table 110.26(A)(1) Condition 2'), why: 'Working space in front of live parts, 600 V or less.' },
  { a: 'panel', b: 'any', min: 1.07, kind: 'electrical-safety', order: 'front', source: cite('NEC 2023', 'Table 110.26(A)(1) Condition 2'), why: 'Working space in front of a panelboard.' },
  { a: 'panel', b: 'any', min: 0.76, kind: 'electrical-safety', order: 'width', source: cite('NEC 2023', '110.26(A)(2)'), why: 'Working space width: 762 mm or the equipment width, whichever is greater.' },
  { a: 'panel', b: 'any', min: 2.0, kind: 'electrical-safety', order: 'height', source: cite('NEC 2023', '110.26(A)(3)'), why: 'Working space height 2.0 m or the equipment height.' },
  { a: 'switchgear', b: 'any', min: 1.8, kind: 'electrical-safety', forbidden: true, order: 'dedicated space above', source: cite('NEC 2023', '110.26(E)(1)(a)+(b)'), why: 'The space above the footprint to 1.80 m (or the structural ceiling) is dedicated to electrical equipment; foreign systems are not permitted in it.' },
  { a: 'switchgear', b: 'sprinkler-branch', min: 0.0, kind: 'electrical-safety', order: 'permitted with drip protection', source: cite('NEC 2023', '110.26(E)(1)(c)'), why: 'Sprinkler protection is permitted in the dedicated space where drip protection is provided.' },
  { a: 'dcw', b: 'waste', min: 0.05, kind: 'potable', order: 'dcw above waste', source: cite('IPC 2021', '§603.2'), why: 'Potable water crosses over drainage, never under it.' },
  { a: 'dcw', b: 'waste', min: 0.3, kind: 'potable', order: 'buried, horizontal', source: cite('IPC 2021', '§603.2'), why: 'Buried potable and drainage separation: 0.30 m horizontal or 0.45 m vertical.' },
  { a: 'gas', b: 'tray-power', min: 0.05, kind: 'fire', source: `${cite('BS 6891:2015', '§8.11')}; ${cite('NFPA 54 2021', '§7.1')}`, why: 'Gas pipework separated from electrical work.' },
  { a: 'tray-power', b: 'tray-data', min: 0.15, kind: 'emc', source: `${cite('BS 7671:2018+A2:2022', '§528.1')}; ${cite('EN 50174-2:2018', 'Table 8')}`, why: 'Electromagnetic separation between power and balanced data cabling.' },
  { a: 'any', b: 'beam', min: 0.0, kind: 'structural', forbidden: true, source: cite('ACI 318-19', '§6.4 (no designed openings in this model)'), why: 'No service penetrates a beam or column; sleeves go through slabs and non-structural walls only.' },
  { a: 'any', b: 'column', min: 0.0, kind: 'structural', forbidden: true, source: cite('ACI 318-19', '§6.4'), why: 'As above.' },
  { a: 'any', b: 'elevator-shaft', min: 0.0, kind: 'code', forbidden: true, source: `${cite('IBC 2021', '§3005.3')}; ${cite('ASME A17.1-2019', '§2.8')}`, why: 'A hoistway shall contain no piping or ducting not serving the hoistway.' },
  { a: 'tank', b: 'any', min: 0.6, kind: 'access', source: cite('IMC 2021', '§306.3'), why: 'Appliance access and service clearance; 1.00 m at a manway.' },
  { a: 'pump', b: 'any', min: 0.6, kind: 'access', source: cite('IMC 2021', '§306.3'), why: 'Appliance access and service clearance.' },
  { a: 'ahu', b: 'any', min: 0.6, kind: 'access', order: '0.75 at the burner / coil pull', source: cite('IMC 2021', '§306.3'), why: 'Access for filter change and coil withdrawal.' },
  { a: 'roof-plant-row', b: 'roof-plant-row', min: 1.0, kind: 'access', source: cite('default', '(current PlantGrid aisle)'), why: 'Maintenance aisle between rows of roof plant.' },
  { a: 'roof-plant-row', b: 'parapet', min: 2.0, kind: 'fall', source: `${cite('OSHA 1910', '1910.28(b)(13)')}; ${cite('EN 13374:2013', 'Class A')}`, why: 'Setback from an unprotected roof edge where the parapet is below 1.10 m.' },
];

/** Minimum separation required between two kinds, or null when the table says nothing. */
export function clearanceBetween(a: ClearanceSpec['a'], b: ClearanceSpec['b'], order?: string): ClearanceSpec | null {
  for (const c of CLEARANCES) {
    const hit = (c.a === a && c.b === b) || (c.a === b && c.b === a);
    if (!hit) continue;
    if (order && c.order !== order) continue;
    return c;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// ROUTE_HOME — where each kind lives, and why it is not in the ceiling
// ---------------------------------------------------------------------------------------------------------------

export interface RouteHomeSpec {
  home: Home;
  /** Secondary home, e.g. a unit stack is in a chase, a tower stack in a shaft */
  alt?: Home;
  why: string;
  source: string;
}

export const ROUTE_HOME: Readonly<Partial<Record<ElementKind, RouteHomeSpec>>> = {
  'waste': { home: 'chase', alt: 'shaft', why: 'One invert, one slope: a drain cannot be rerouted once the slab is poured, and a stack in a flat ceiling is a penetration per storey and an acoustic leak.', source: `${cite('IPC 2021', '§704')}; ${cite('ADE 2015', '§5')}` },
  'vent': { home: 'chase', alt: 'shaft', why: 'Rises with its stack.', source: cite('IPC 2021', '§903') },
  'storm': { home: 'shaft', why: 'Roof drainage falls in one line to the storm connection.', source: cite('IPC 2021', '§1101.2') },
  'dcw': { home: 'chase', alt: 'ceiling', why: 'Pressure services can rise, fall and offset — they take the squeeze in the ceiling and the risers stay in the shaft.', source: cite('IPC 2021', '§305') },
  'dhw': { home: 'chase', alt: 'ceiling', why: 'As DCW; insulation thickness sets the lane width.', source: cite('ASHRAE 90.1-2019', 'Table 6.8.3-1') },
  'hwr': { home: 'chase', alt: 'ceiling', why: 'Returns with the DHW riser.', source: cite('ASHRAE 90.1-2019', '§6.5.4.6') },
  'gas': { home: 'exterior', alt: 'ceiling', why: 'Ventilated route, no concealed unsleeved joints.', source: cite('BS 6891:2015', '§8.7') },
  'duct': { home: 'ceiling', alt: 'shaft', why: 'Biggest rigid section, so it sets the plenum depth and runs straight down the corridor; risers in shafts.', source: cite('SMACNA 3rd ed.', 'Chapter 2') },
  'duct-fitting': { home: 'ceiling', why: 'With its duct.', source: cite('SMACNA 3rd ed.', 'Chapter 2') },
  'air-terminal': { home: 'ceiling', why: 'In the ceiling void, in the room it serves.', source: cite('ASHRAE 62.1-2019', '§5.16') },
  'fan': { home: 'ceiling', alt: 'plinth', why: 'In-line fans hang in the plenum; larger units sit on a plinth in a plant room.', source: cite('IMC 2021', '§306.3') },
  'ahu': { home: 'plinth', why: 'Needs access on all sides and a condensate drain.', source: cite('IMC 2021', '§306.3') },
  'jet-fan': { home: 'ceiling', why: 'Impulse ventilation under the car-park soffit, on the aisle centreline.', source: cite('BS 7346-7:2013', '§6') },
  'sprinkler-main': { home: 'ceiling', why: 'Deflector distance forces the main tight to the soffit.', source: cite('NFPA 13 2022', '§8.6.4.1.1.1') },
  'sprinkler-branch': { home: 'ceiling', why: 'Drops off the main wherever a head is needed.', source: cite('NFPA 13 2022', '§9.2.2') },
  'sprinkler-head': { home: 'ceiling', why: '25–300 mm below the ceiling plane.', source: cite('NFPA 13 2022', '§8.6.4.1.1.1') },
  'standpipe': { home: 'shaft', why: 'In the stair enclosure or a rated shaft, valved at each landing.', source: cite('NFPA 14 2019', '§7.3') },
  'tray-power': { home: 'ceiling', why: 'Bottom of the plenum: it is altered many times over the building life and must stay reachable from a ceiling tile.', source: cite('NEC 2023', '110.26') },
  'tray-data': { home: 'ceiling', why: 'As power tray, 0.15 m away for EMC.', source: cite('EN 50174-2:2018', 'Table 8') },
  'conduit': { home: 'ceiling', alt: 'wall', why: 'Trivially rerouted; drops into walls at devices.', source: cite('NEC 2023', 'Chapter 3') },
  'busduct': { home: 'shaft', why: 'Vertical distribution in the electrical riser.', source: cite('NEC 2023', '368.10') },
  'panel': { home: 'wall', why: 'Needs a 1.07 m working space and may not be in a bathroom, a clothes closet or over stairs — so it goes on a hall or corridor wall.', source: cite('NEC 2023', '240.24(D) and (E)') },
  'switchgear': { home: 'plinth', why: 'Plant-room floor on a housekeeping pad, with the dedicated space above kept free of foreign systems.', source: cite('NEC 2023', '110.26(E)') },
  'sump': { home: 'floor', why: 'The gravity horizon: below it, drainage is pumped.', source: cite('IPC 2021', '§712') },
  'ejector': { home: 'floor', why: 'With its sump, duplex, alternating.', source: cite('IPC 2021', '§712.4.2') },
  'pump': { home: 'plinth', why: 'Housekeeping pad, access all round.', source: cite('IMC 2021', '§303.3') },
  'tank': { home: 'plinth', why: 'Housekeeping pad; 1.00 m at the manway.', source: cite('IMC 2021', '§306.3') },
  'ev-charger': { home: 'wall', why: 'Over the stall head, so EV capacity can be added without touching the clear height.', source: cite('NEC 2023', '625.40') },
  'trench-drain': { home: 'floor', why: 'The low line of the car-park slab, falling to the sump or the sewer.', source: cite('IPC 2021', '§1101.2') },
  'light': { home: 'ceiling', why: 'In the ceiling plane or on the exposed soffit.', source: cite('NEC 2023', '410.36') },
  'sensor': { home: 'ceiling', why: 'In the ceiling plane.', source: cite('NEC 2023', '314.23') },
  'plinth': { home: 'floor', why: '150 mm housekeeping pad under equipment.', source: cite('IMC 2021', '§303.3') },
};

// ---------------------------------------------------------------------------------------------------------------
// MOVE_COST — the ordering that justifies the band sequence
// ---------------------------------------------------------------------------------------------------------------

export type Flexibility = 1 | 2 | 3 | 4 | 5;

export interface MoveCostBand {
  flexibility: Flexibility;
  cost: 'fixed' | 'hard' | 'medium' | 'easy' | 'trivial';
  kinds: readonly ElementKind[];
  why: string;
}

export const MOVE_COST_BANDS: readonly MoveCostBand[] = [
  {
    flexibility: 1, cost: 'fixed',
    kinds: ['slab', 'beam', 'column', 'drop-panel', 'waste', 'vent', 'storm', 'trench-drain', 'sprinkler-main'],
    why: 'Poured, or fixed by one invert and one code-mandated soffit distance.',
  },
  {
    flexibility: 2, cost: 'hard',
    kinds: ['wall', 'shaft-void', 'standpipe'],
    why: 'Moving these moves the architecture: a shaft, a rated enclosure or the ceiling plane.',
  },
  {
    flexibility: 3, cost: 'medium',
    kinds: ['duct', 'duct-fitting', 'fan', 'ahu', 'jet-fan', 'air-terminal'],
    why: 'Re-sizeable, but only in whole-section steps, and the fittings follow.',
  },
  {
    flexibility: 4, cost: 'easy',
    kinds: ['dcw', 'dhw', 'hwr', 'gas', 'pump', 'tank', 'sump', 'ejector', 'plinth'],
    why: 'Pressure services take offsets and drops for free.',
  },
  {
    flexibility: 5, cost: 'trivial',
    kinds: ['tray-power', 'tray-data', 'conduit', 'busduct', 'light', 'sensor', 'ev-charger', 'panel', 'switchgear', 'sprinkler-branch', 'sprinkler-head'],
    why: 'Altered many times over the building life, so they must stay the most accessible.',
  },
];

export const MOVE_COST: Readonly<Partial<Record<ElementKind, Flexibility>>> = (() => {
  const out: Partial<Record<ElementKind, Flexibility>> = {};
  for (const b of MOVE_COST_BANDS) for (const k of b.kinds) out[k] = b.flexibility;
  return out;
})();

export function moveCostOf(kind: ElementKind): Flexibility {
  return MOVE_COST[kind] ?? 3;
}
