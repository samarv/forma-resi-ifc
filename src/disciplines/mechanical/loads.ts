/**
 * Mechanical loads and airflows (patterns MEC-01, MEC-09, MEC-12 / XD-05).
 *
 * Everything here is pure arithmetic on region + dwelling data: no geometry, no ids.
 * Loads are deliberately derived from DESIGN OCCUPANCY (bedrooms + 1) and floor area,
 * not from a full heat-balance model — this is a schematic generator.
 */
import type { Region } from '../../core/types.ts';

export type VentStandard = 'ASHRAE 62.2' | 'UK Part F';

export interface RegionLoadFactors {
  /** Sensible cooling design load per m² of dwelling NIA (W/m²) */
  coolingWPerM2: number;
  /** Design heat loss per m² of dwelling NIA (W/m²) */
  heatingWPerM2: number;
  ventStandard: VentStandard;
  /** Reference for the load intensity */
  source: string;
}

/**
 * Regional design intensities. Mid-range values for a reasonably insulated modern
 * apartment; they are intentionally coarse (a schematic sizing check, not a load calc).
 */
export const REGION_LOADS: Record<Region, RegionLoadFactors> = {
  US: { coolingWPerM2: 65, heatingWPerM2: 50, ventStandard: 'ASHRAE 62.2', source: 'ACCA Manual J typical mixed-humid apartment' },
  CA: { coolingWPerM2: 55, heatingWPerM2: 70, ventStandard: 'ASHRAE 62.2', source: 'NBC 9.36 / CSA F280 cold-climate apartment' },
  UK: { coolingWPerM2: 40, heatingWPerM2: 60, ventStandard: 'UK Part F', source: 'CIBSE Guide A domestic; Part L 2021 fabric' },
  IE: { coolingWPerM2: 40, heatingWPerM2: 60, ventStandard: 'UK Part F', source: 'TGD Part L 2022 / CIBSE Guide A' },
  AU: { coolingWPerM2: 70, heatingWPerM2: 30, ventStandard: 'ASHRAE 62.2', source: 'NCC 2022 Vol 2 climate zone 5–6' },
  NZ: { coolingWPerM2: 45, heatingWPerM2: 45, ventStandard: 'ASHRAE 62.2', source: 'NZBC H1 5th edition' },
};

/** Supply airflow per kW of sensible cooling (400 cfm/ton ≈ 188.8 l/s per 3.517 kW) */
export const LS_PER_KW_COOLING = 53.7;

/** ASHRAE 62.2-2019 §4.1.1 (SI): Qtot = 0.15 l/s·m² + 3.5 l/s per (Nbr + 1) */
export const ASHRAE_LS_PER_M2 = 0.15;
export const ASHRAE_LS_PER_PERSON = 3.5;

/**
 * Approved Document F (2021) Table 1.3 / ADF 2010 Table 5.1b — whole-dwelling
 * ventilation rate (l/s) indexed by number of bedrooms (index 0 unused, 1..5+).
 */
export const PART_F_WHOLE_DWELLING_LS = [13, 13, 17, 21, 25, 29];

/** Part F Table 1.2 / ASHRAE 62.2 Table 5.1 local extract rates (l/s, intermittent) */
export const EXTRACT_LS = {
  bathroom: 25,
  ensuite: 25,
  wc: 13,
  powder: 13,
  kitchen: 50,
  utility: 15,
  laundry: 15,
} as const;

/** Corridor make-up air (pattern MEC-05): l/s per m² of corridor floor area */
export const CORRIDOR_MAKEUP_LS_PER_M2 = 0.5;

export function ashraeVentilationLs(areaM2: number, occupants: number): number {
  return ASHRAE_LS_PER_M2 * areaM2 + ASHRAE_LS_PER_PERSON * occupants;
}

export function partFVentilationLs(bedrooms: number): number {
  const b = Math.max(1, Math.min(5, Math.round(bedrooms)));
  return PART_F_WHOLE_DWELLING_LS[b];
}

export interface UnitLoad {
  unitId: string;
  areaM2: number;
  occupants: number;
  bedrooms: number;
  /** Whole-dwelling continuous ventilation rate (l/s) */
  ventilationLs: number;
  coolingW: number;
  heatingW: number;
  /** Design supply airflow of a ducted/fan-coil system (l/s) */
  supplyLs: number;
  standard: VentStandard;
}

export function computeUnitLoad(
  region: Region,
  unitId: string,
  areaM2: number,
  bedrooms: number,
  occupants: number,
): UnitLoad {
  const f = REGION_LOADS[region];
  const occ = occupants > 0 ? occupants : Math.max(1, Math.round(bedrooms) + 1);
  const ventilationLs = f.ventStandard === 'UK Part F'
    ? partFVentilationLs(bedrooms)
    : ashraeVentilationLs(areaM2, occ);
  const coolingW = f.coolingWPerM2 * areaM2;
  const heatingW = f.heatingWPerM2 * areaM2;
  return {
    unitId,
    areaM2,
    occupants: occ,
    bedrooms,
    ventilationLs: r1(ventilationLs),
    coolingW: r1(coolingW),
    heatingW: r1(heatingW),
    supplyLs: r1(Math.max((coolingW / 1000) * LS_PER_KW_COOLING, ventilationLs)),
    standard: f.ventStandard,
  };
}

/** Round to 0.1 so derived numbers stay readable and stable */
export function r1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** Round to 0.001 (metres) */
export function r3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/**
 * Round duct diameter for a branch airflow at ~4 m/s, snapped to the
 * 100/125/150/200/250 mm ladder used by residential flex and rigid duct.
 */
export function roundBranchDiameter(airflowLs: number): number {
  const ladder = [0.1, 0.125, 0.15, 0.2, 0.25, 0.315];
  const areaNeeded = (airflowLs / 1000) / 4.0; // m² at 4 m/s
  const dNeeded = 2 * Math.sqrt(areaNeeded / Math.PI);
  for (const d of ladder) if (d >= dNeeded - 1e-9) return d;
  return ladder[ladder.length - 1];
}

/** Rectangular trunk width for an airflow at ~5 m/s given a fixed depth, snapped to 50 mm */
export function rectTrunkWidth(airflowLs: number, depth: number): number {
  const area = (airflowLs / 1000) / 5.0;
  const w = Math.max(0.25, area / Math.max(0.1, depth));
  return Math.min(1.2, Math.ceil(w / 0.05) * 0.05);
}
