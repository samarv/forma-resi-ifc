/**
 * Plumbing reference data: fixture units, IFC mapping, pipe sizing (Hunter's curve) and colours.
 *
 * DFU (drainage fixture units) per IPC 2021 Table 709.1, private use.
 * WSFU (water supply fixture units) per IPC 2021 Table E103.3(2), private use.
 */
import type { PipeSystemType, PlumbingFixture, FurnitureType, RGB } from '../../core/types.ts';

export type FixtureType = PlumbingFixture['type'];

export interface FixtureSpec {
  /** Drainage fixture units (IPC Table 709.1, private) */
  dfu: number;
  /** Water supply fixture units (IPC Table E103.3(2), private) */
  wsfu: number;
  connections: PipeSystemType[];
  ifcType: string;
  predefinedType?: string;
  objectType?: string;
  name: string;
  /** Default footprint w × d × h (m) when the fixture has to be synthesised */
  size: [number, number, number];
  /** Storey-local Z of the supply connection (m) */
  supplyZ: number;
  /** Waste branch (trap arm) diameter (m); 0 = no drain */
  wasteD: number;
  /** Supply branch diameter (m); 0 = no supply */
  supplyD: number;
}

const SAN = 'IfcSanitaryTerminal';

export const FIXTURES: Record<FixtureType, FixtureSpec> = {
  'wc': {
    dfu: 3, wsfu: 2.2, connections: ['dcw', 'waste', 'vent'],
    ifcType: SAN, predefinedType: 'TOILETPAN', name: 'Water closet (1.6 gpf tank)',
    size: [0.4, 0.72, 0.78], supplyZ: 0.3, wasteD: 0.1, supplyD: 0.015,
  },
  'lavatory': {
    dfu: 1, wsfu: 0.7, connections: ['dcw', 'dhw', 'waste', 'vent'],
    ifcType: SAN, predefinedType: 'WASHHANDBASIN', name: 'Lavatory',
    size: [0.6, 0.5, 0.85], supplyZ: 1.0, wasteD: 0.05, supplyD: 0.015,
  },
  'shower': {
    dfu: 2, wsfu: 1.4, connections: ['dcw', 'dhw', 'waste', 'vent'],
    ifcType: SAN, predefinedType: 'SHOWER', name: 'Shower',
    size: [0.9, 0.9, 2.1], supplyZ: 1.1, wasteD: 0.05, supplyD: 0.02,
  },
  'bathtub': {
    dfu: 2, wsfu: 1.4, connections: ['dcw', 'dhw', 'waste', 'vent'],
    ifcType: SAN, predefinedType: 'BATH', name: 'Bathtub',
    size: [1.7, 0.75, 0.6], supplyZ: 0.75, wasteD: 0.05, supplyD: 0.02,
  },
  'kitchen-sink': {
    dfu: 2, wsfu: 1.4, connections: ['dcw', 'dhw', 'waste', 'vent'],
    ifcType: SAN, predefinedType: 'SINK', name: 'Kitchen sink',
    size: [0.6, 0.6, 0.9], supplyZ: 1.0, wasteD: 0.05, supplyD: 0.02,
  },
  'dishwasher': {
    dfu: 2, wsfu: 1.4, connections: ['dcw', 'dhw', 'waste', 'vent'],
    ifcType: SAN, predefinedType: 'SINK', objectType: 'Dishwasher water connection',
    name: 'Dishwasher connection', size: [0.6, 0.6, 0.85], supplyZ: 0.6, wasteD: 0.05, supplyD: 0.015,
  },
  'washer': {
    dfu: 3, wsfu: 1.4, connections: ['dcw', 'dhw', 'waste', 'vent'],
    ifcType: SAN, predefinedType: 'SINK', objectType: 'Clothes washer outlet box',
    name: 'Clothes washer connection', size: [0.6, 0.65, 0.9], supplyZ: 1.0, wasteD: 0.05, supplyD: 0.02,
  },
  'utility-sink': {
    dfu: 2, wsfu: 1.4, connections: ['dcw', 'dhw', 'waste', 'vent'],
    ifcType: SAN, predefinedType: 'SINK', name: 'Utility sink',
    size: [0.6, 0.6, 0.9], supplyZ: 1.0, wasteD: 0.05, supplyD: 0.015,
  },
  'drinking-fountain': {
    dfu: 0.5, wsfu: 0.25, connections: ['dcw', 'waste', 'vent'],
    ifcType: SAN, predefinedType: 'SANITARYFOUNTAIN', name: 'Drinking fountain',
    size: [0.4, 0.4, 1.0], supplyZ: 0.6, wasteD: 0.05, supplyD: 0.015,
  },
  'hose-bibb': {
    dfu: 0, wsfu: 2.5, connections: ['dcw'],
    ifcType: 'IfcValve', predefinedType: 'FAUCET', objectType: 'Hose bibb (frost-free)',
    name: 'Hose bibb', size: [0.12, 0.12, 0.12], supplyZ: 0.5, wasteD: 0, supplyD: 0.02,
  },
  'floor-drain': {
    dfu: 2, wsfu: 0, connections: ['waste', 'vent'],
    ifcType: 'IfcWasteTerminal', predefinedType: 'FLOORTRAP', name: 'Floor drain',
    size: [0.2, 0.2, 0.1], supplyZ: 0, wasteD: 0.075, supplyD: 0,
  },
  'water-heater': {
    dfu: 0, wsfu: 0, connections: ['dcw', 'dhw'],
    ifcType: 'IfcTank', predefinedType: 'STORAGE', objectType: 'Water heater',
    name: 'Water heater', size: [0.6, 0.6, 1.5], supplyZ: 1.4, wasteD: 0, supplyD: 0.025,
  },
  'water-meter': {
    dfu: 0, wsfu: 0, connections: ['dcw'],
    ifcType: 'IfcFlowMeter', predefinedType: 'WATERMETER', name: 'Water meter',
    size: [0.35, 0.2, 0.3], supplyZ: 0.6, wasteD: 0, supplyD: 0.05,
  },
  'backflow-preventer': {
    dfu: 0, wsfu: 0, connections: ['dcw'],
    ifcType: 'IfcValve', predefinedType: 'CHECK', objectType: 'Reduced-pressure backflow preventer',
    name: 'Backflow preventer', size: [0.5, 0.2, 0.3], supplyZ: 0.6, wasteD: 0, supplyD: 0.05,
  },
  'booster-pump': {
    dfu: 0, wsfu: 0, connections: ['dcw'],
    ifcType: 'IfcPump', predefinedType: 'ENDSUCTION', objectType: 'Domestic water booster set',
    name: 'Booster pump set', size: [1.2, 0.6, 1.2], supplyZ: 0.4, wasteD: 0, supplyD: 0.05,
  },
  'roof-drain': {
    dfu: 0, wsfu: 0, connections: ['storm'],
    ifcType: 'IfcWasteTerminal', predefinedType: 'ROOFDRAIN', name: 'Roof drain',
    size: [0.3, 0.3, 0.1], supplyZ: 0, wasteD: 0.1, supplyD: 0,
  },
  'sprinkler-head': {
    dfu: 0, wsfu: 0, connections: ['sprinkler'],
    ifcType: 'IfcFireSuppressionTerminal', predefinedType: 'SPRINKLER',
    objectType: 'Residential pendent sprinkler', name: 'Sprinkler head',
    size: [0.08, 0.08, 0.05], supplyZ: 0, wasteD: 0, supplyD: 0.025,
  },
  'fire-hose-valve': {
    dfu: 0, wsfu: 0, connections: ['standpipe'],
    ifcType: 'IfcFireSuppressionTerminal', predefinedType: 'HOSEREEL',
    objectType: 'Class I hose valve', name: 'Fire hose valve',
    size: [0.25, 0.2, 0.3], supplyZ: 1.2, wasteD: 0, supplyD: 0.065,
  },
  // v2 — pumped drainage for storeys below the sewer invert (IPC 2021 §712); placed by the plumbing agent from InvertModel
  'sump-pit': {
    dfu: 0, wsfu: 0, connections: ['waste', 'vent'],
    ifcType: 'IfcDistributionChamberElement', predefinedType: 'SUMP', objectType: 'Sewage sump pit',
    name: 'Sump pit', size: [0.9, 0.9, 1.2], supplyZ: 0, wasteD: 0.1, supplyD: 0,
  },
  'sewage-ejector': {
    dfu: 0, wsfu: 0, connections: ['waste'],
    ifcType: 'IfcPump', predefinedType: 'SUBMERSIBLEPUMP', objectType: 'Duplex sewage ejector',
    name: 'Sewage ejector (duplex)', size: [0.5, 0.5, 0.6], supplyZ: 0, wasteD: 0.08, supplyD: 0,
  },
};

/** Architecture furniture types that carry a water/waste connection */
export const FURNITURE_TO_FIXTURE: Partial<Record<FurnitureType, FixtureType>> = {
  'wc': 'wc',
  'lavatory': 'lavatory',
  'vanity': 'lavatory',
  'shower': 'shower',
  'bathtub': 'bathtub',
  'kitchen-sink': 'kitchen-sink',
  'dishwasher': 'dishwasher',
  'washer': 'washer',
  'water-heater': 'water-heater',
};

/** Furniture that may be flagged needsWater but has no plumbing connection of its own */
const NO_WATER: FurnitureType[] = ['dryer', 'fridge', 'range', 'kitchen-island'];

/**
 * Best-effort mapping from an architecture furniture type to a plumbing fixture type.
 * Unknown-but-flagged items fall back to a utility sink so the model stays complete.
 */
export function fixtureTypeForFurniture(type: FurnitureType): FixtureType | null {
  const direct = FURNITURE_TO_FIXTURE[type];
  if (direct) return direct;
  if (NO_WATER.includes(type)) return null;
  const t = String(type);
  if (t.includes('sink')) return 'kitchen-sink';
  if (t.includes('counter')) return 'kitchen-sink';
  if (t.includes('toilet') || t === 'bidet') return 'wc';
  return 'utility-sink';
}

// ----------------------------------------------------------------------------
// Colours (RGB 0..1) — one per system, fixtures off-white
// ----------------------------------------------------------------------------

export const SYSTEM_COLOR: Record<PipeSystemType, RGB> = {
  dcw: [0.2, 0.45, 0.95],
  dhw: [0.9, 0.25, 0.2],
  hwr: [0.95, 0.55, 0.2],
  waste: [0.25, 0.5, 0.25],
  vent: [0.6, 0.85, 0.6],
  storm: [0.35, 0.4, 0.55],
  sprinkler: [1.0, 0.2, 0.1],
  standpipe: [0.8, 0.1, 0.1],
  gas: [0.95, 0.85, 0.2],
};

export const FIXTURE_COLOR: RGB = [0.95, 0.95, 0.97];

export const SYSTEM_NAME: Record<PipeSystemType, string> = {
  dcw: 'Domestic cold water',
  dhw: 'Domestic hot water',
  hwr: 'Hot water recirculation',
  waste: 'Sanitary drainage',
  vent: 'Drainage venting',
  storm: 'Storm drainage',
  sprinkler: 'Automatic sprinklers',
  standpipe: 'Fire standpipe',
  gas: 'Fuel gas',
};

// ----------------------------------------------------------------------------
// Pipe sizing — PLB-08 Fixture Units Size the Pipe
// ----------------------------------------------------------------------------

/** Nominal metric diameters actually stocked (m) */
export const NOMINAL_D: number[] = [0.015, 0.02, 0.025, 0.032, 0.04, 0.05, 0.065, 0.08, 0.1, 0.15, 0.2, 0.25];

export const GPM_TO_LPS = 0.0630902;

export function roundUpNominal(d: number): number {
  for (const n of NOMINAL_D) if (n >= d - 1e-9) return n;
  return NOMINAL_D[NOMINAL_D.length - 1];
}

/**
 * Probable simultaneous demand from water supply fixture units.
 * Approximation of Hunter's curve for predominantly flush-tank systems
 * (IPC 2021 Appendix E / Hunter BMS 65): gpm ≈ 0.95 · WSFU^0.63, floor 5 gpm.
 */
export function hunterGpm(wsfu: number): number {
  if (wsfu <= 0) return 0;
  return Math.max(5, 0.95 * Math.pow(wsfu, 0.63));
}

/** Smallest nominal diameter that carries `lps` at or below `velocity` (m/s) */
export function diameterForFlowLps(lps: number, velocity = 2.4): number {
  if (lps <= 0) return NOMINAL_D[0];
  const area = lps / 1000 / velocity;
  return roundUpNominal(2 * Math.sqrt(area / Math.PI));
}

/** Water service diameter: hydraulic size from Hunter, floored by the code minimum */
export function serviceDiameterFor(wsfu: number, dwellings: number): number {
  const hydraulic = diameterForFlowLps(hunterGpm(wsfu) * GPM_TO_LPS);
  const codeFloor = dwellings > 1 ? 0.05 : 0.025;
  return roundUpNominal(Math.max(hydraulic, codeFloor));
}

/** Diameter of a horizontal main serving `wsfu`, never below 0.025 m */
export function mainDiameterFor(wsfu: number): number {
  return roundUpNominal(Math.max(0.025, diameterForFlowLps(hunterGpm(wsfu) * GPM_TO_LPS)));
}

/** Systems and diameters carried by a stack (PLB-01) */
export function stackSystems(storeys: number, central: boolean): { system: PipeSystemType; diameter: number }[] {
  const out: { system: PipeSystemType; diameter: number }[] = [
    { system: 'waste', diameter: 0.1 },
    { system: 'vent', diameter: 0.075 },
    { system: 'dcw', diameter: storeys > 10 ? 0.05 : 0.032 },
    { system: 'dhw', diameter: 0.025 },
  ];
  if (central) out.push({ system: 'hwr', diameter: 0.02 });
  return out;
}

/** Max developed trap-arm length for a drain diameter (IPC 2021 Table 1002.2) */
export function maxTrapArm(diameter: number): number {
  // IPC 2021 Table 1002.2 — maximum distance of fixture trap from vent (unvented trap arm)
  if (diameter >= 0.1 - 1e-9) return 3.66;   // 4 in → 12 ft
  if (diameter >= 0.075 - 1e-9) return 3.05; // 3 in → 10 ft
  if (diameter >= 0.05 - 1e-9) return 1.83;  // 2 in → 6 ft
  if (diameter >= 0.04 - 1e-9) return 1.52;  // 1½ in → 5 ft
  return 1.07;                                // 1¼ in → 3 ft 6 in
}
