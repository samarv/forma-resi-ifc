/**
 * Load calculation — ELE-11 Demand not Connected Load.
 *
 *   NEC 220.12   general lighting 3 VA/ft² (33 VA/m²) of habitable floor area
 *   NEC 210.11(C) two 20 A small-appliance circuits (1500 VA each) + laundry 1500 VA
 *   NEC 220.82   optional dwelling calculation: first 10 kVA at 100 %, remainder at 40 %,
 *                plus the largest heating / air-conditioning load at 100 %
 *   NEC 220.84   multifamily demand factors by number of dwellings (45 % → 23 %)
 *   BS 7671 App. A / IET OSG: diversity applied per circuit class (UK/IE/AU/NZ path)
 */
import { APPLIANCE_VA, UTILISATION } from './catalog.ts';
import { STANDARD_SERVICE_AMPS, type ElecRegionPreset } from './region.ts';

export interface UnitLoad {
  unitId: string;
  areaM2: number;
  bedrooms: number;
  generalLightingVa: number;
  smallApplianceVa: number;
  laundryVa: number;
  applianceVa: number;
  hvacVa: number;
  evVa: number;
  connectedVa: number;
  demandVa: number;
  amps: number;
  appliances: Record<string, number>;
}

export interface UnitLoadInput {
  unitId: string;
  areaM2: number;
  bedrooms: number;
  /** appliance name → nameplate VA (already resolved from furniture / plumbing / mechanical) */
  appliances: Record<string, number>;
  hvacVa: number;
  evVa: number;
  hasLaundry: boolean;
}

export function unitLoad(input: UnitLoadInput, region: ElecRegionPreset): UnitLoad {
  const generalLightingVa = Math.round(input.areaM2 * region.generalLightingVaPerM2);
  const smallApplianceVa = region.smallApplianceCircuits * 1500;
  const laundryVa = input.hasLaundry ? region.laundryCircuitVa : 0;
  let applianceVa = 0;
  for (const k of Object.keys(input.appliances)) applianceVa += input.appliances[k];
  const connectedVa = generalLightingVa + smallApplianceVa + laundryVa + applianceVa + input.hvacVa + input.evVa;
  const other = generalLightingVa + smallApplianceVa + laundryVa + applianceVa + input.evVa;
  const demandVa = region.ring
    ? demandDiversityBs(generalLightingVa, smallApplianceVa, input.appliances, input.hvacVa, input.evVa)
    : demand220_82(other, input.hvacVa);
  return {
    unitId: input.unitId,
    areaM2: round1(input.areaM2),
    bedrooms: input.bedrooms,
    generalLightingVa,
    smallApplianceVa,
    laundryVa,
    applianceVa,
    hvacVa: input.hvacVa,
    evVa: input.evVa,
    connectedVa: Math.round(connectedVa),
    demandVa: Math.round(demandVa),
    amps: round1(demandVa / region.unitServiceV),
    appliances: input.appliances,
  };
}

/** NEC 220.82(B)+(C): first 10 kVA at 100 %, rest at 40 %, HVAC at 100 % */
export function demand220_82(otherVa: number, hvacVa: number): number {
  const first = Math.min(otherVa, 10000);
  const rest = Math.max(0, otherVa - 10000) * 0.4;
  return first + rest + hvacVa;
}

/**
 * BS 7671 Appendix A / IET On-Site Guide diversity for a single dwelling:
 * lighting 66 %, cooking 10 A + 30 % of the remainder, socket circuits 100 % of the largest +
 * 40 % of the rest, water heating and EV at 100 % (EV needs load curtailment in practice).
 */
export function demandDiversityBs(
  lightingVa: number,
  socketVa: number,
  appliances: Record<string, number>,
  hvacVa: number,
  evVa: number,
): number {
  const cook = appliances.range ?? 0;
  const water = appliances.waterHeater ?? 0;
  const others = Object.keys(appliances)
    .filter(k => k !== 'range' && k !== 'waterHeater')
    .map(k => appliances[k])
    .sort((a, b) => b - a);
  const largest = others.length > 0 ? others[0] : 0;
  const restOfOthers = others.slice(1).reduce((a, b) => a + b, 0);
  const cooking = cook > 0 ? 10 * 230 + Math.max(0, cook - 10 * 230) * 0.3 : 0;
  return lightingVa * 0.66 + socketVa + largest + restOfOthers * 0.4 + cooking + water + hvacVa + evVa;
}

/** NEC Table 220.84 demand factor (fraction) for `n` dwelling units */
export function demandFactor220_84(n: number): number {
  if (n < 3) return 1;
  const table: [number, number][] = [
    [5, 0.45], [7, 0.44], [10, 0.43], [11, 0.42], [13, 0.41], [15, 0.4], [17, 0.39], [20, 0.38],
    [21, 0.37], [23, 0.36], [25, 0.35], [27, 0.34], [30, 0.33], [31, 0.32], [33, 0.31], [36, 0.3],
    [38, 0.29], [42, 0.28], [45, 0.27], [50, 0.26], [55, 0.25], [61, 0.24],
  ];
  for (const [upto, f] of table) if (n <= upto) return f;
  return 0.23;
}

export interface HouseLoadInput {
  /** common / circulation floor area (m²) */
  commonAreaM2: number;
  elevators: number;
  /** central mechanical equipment kW (RTUs, AHUs, boilers, pumps) */
  centralMechKw: number;
  evChargers: number;
  /** house receptacles, controls, lifts of doors etc. */
  miscVa?: number;
}

export interface HouseLoad {
  lightingVa: number;
  elevatorVa: number;
  mechVa: number;
  evVa: number;
  miscVa: number;
  totalVa: number;
}

export function houseLoad(input: HouseLoadInput): HouseLoad {
  const lightingVa = Math.round(input.commonAreaM2 * 10);
  const elevatorVa = input.elevators * APPLIANCE_VA.elevator;
  const mechVa = Math.round(input.centralMechKw * 1000);
  // NEC 625.42 permits EV energy-management diversity; 50 % of connected charger load.
  const evVa = Math.round(input.evChargers * APPLIANCE_VA.ev * 0.5);
  const miscVa = input.miscVa ?? 2000;
  return {
    lightingVa,
    elevatorVa,
    mechVa,
    evVa,
    miscVa,
    totalVa: lightingVa + elevatorVa + mechVa + evVa + miscVa,
  };
}

export function serviceAmpsFor(va: number, voltage: number, phases: 1 | 3): number {
  return phases === 3 ? va / (voltage * Math.sqrt(3)) : va / voltage;
}

export function roundServiceAmps(a: number): number {
  for (const s of STANDARD_SERVICE_AMPS) if (a <= s) return s;
  return STANDARD_SERVICE_AMPS[STANDARD_SERVICE_AMPS.length - 1];
}

/** ELE-13: number of fixtures needed to reach a lux target, given lumens per fixture */
export function fixturesForLux(areaM2: number, lux: number, lumensPerFixture: number): number {
  if (lumensPerFixture <= 0 || areaM2 <= 0) return 0;
  return Math.ceil((lux * areaM2) / (lumensPerFixture * UTILISATION));
}

/** Delivered illuminance (lux) of `count` fixtures of `lumens` in `areaM2` */
export function luxAchieved(areaM2: number, count: number, lumensPerFixture: number): number {
  if (areaM2 <= 0) return 0;
  return (count * lumensPerFixture * UTILISATION) / areaM2;
}

/** Branch circuit capacity in VA at 80 % continuous loading */
export function circuitCapacityVa(amps: number, volts: number): number {
  return amps * volts * 0.8;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
