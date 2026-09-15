/**
 * Regional electrical code presets.
 *
 *   US / CA → NEC 2023 / CEC C22.1: 120/240 V 1ph per dwelling; building service
 *             208Y/120 V 3ph once there are 6+ dwellings, otherwise 240/120 V 1ph.
 *   UK / IE → BS 7671 / ET101: 230 V 1ph per dwelling (ring final circuits);
 *             400Y/230 V 3ph service for anything bigger than a single house.
 *   AU / NZ → AS/NZS 3000: 230 V 1ph per dwelling, 400Y/230 V 3ph service.
 */
import type { Region } from '../../core/types.ts';

export const SERVICE_VOLTAGES = [
  '240/120 V 1ph',
  '208Y/120 V 3ph',
  '230 V 1ph',
  '400Y/230 V 3ph',
  '480Y/277 V 3ph',
] as const;
export type ServiceVoltage = (typeof SERVICE_VOLTAGES)[number];

/** Standard service / main-breaker frame sizes (A) */
export const STANDARD_SERVICE_AMPS = [100, 200, 400, 600, 800, 1200, 1600, 2000, 2500, 3000, 4000];

/** Receptacle count caps per room group (non-NEC regions count sockets, not spacing) */
export interface ReceptacleCap { min: number; max: number }
export type RoomGroup = 'living' | 'bedroom' | 'kitchen' | 'circulation' | 'other';

export interface ElecRegionPreset {
  region: Region;
  /** Wiring code cited in psets and pattern applications */
  code: string;
  /** Section that drives receptacle placement */
  receptacleCode: string;
  /** Building service */
  service: ServiceVoltage;
  serviceV: number;
  phases: 1 | 3;
  serviceVoltageIndex: number;
  /** Per-dwelling feeder */
  unitService: string;
  /** Line-to-line volts used to convert a dwelling's VA to amps */
  unitServiceV: number;
  /** Branch-circuit volts for lighting / receptacles */
  branchV: number;
  /** 240 V (US/CA) or 230 V (UK/AU) appliance circuits */
  applianceV: number;
  /** BS 7671 ring final circuits for socket outlets */
  ring: boolean;
  /** Local name of the earth-leakage protected outlet */
  earthLeakName: string;
  /** Local name of the dwelling distribution board */
  panelName: string;
  /** NEC 210.11(C)(1) small-appliance branch circuits */
  smallApplianceCircuits: number;
  /** NEC 220.52(B) laundry allowance (0 where not a code load) */
  laundryCircuitVa: number;
  /** NEC 220.12 general lighting VA per m² (3 VA/ft²) */
  generalLightingVaPerM2: number;
  /** Max spacing between general receptacles along a wall (m) */
  maxReceptacleSpacing: number;
  /** Max distance from any point of a wall space to a receptacle (m) */
  maxReceptacleReach: number;
  /** Max spacing of counter receptacles (m) */
  counterSpacing: number;
  /** Per-room-group socket caps; null = pure NEC spacing rule with no cap */
  caps: Record<RoomGroup, ReceptacleCap> | null;
  /** Fit a CO alarm even with no fuel-burning appliance */
  coAlarmAlways: boolean;
  /** Dwelling main switch / consumer unit rating (A) by bedroom count */
  unitPanelAmps: (bedrooms: number, isHouse: boolean) => number;
}

const NEC_UNIT_AMPS = (bedrooms: number, isHouse: boolean): number => {
  if (isHouse) return bedrooms >= 3 ? 200 : 150;
  if (bedrooms <= 1) return 100;
  if (bedrooms === 2) return 125;
  return 200;
};

const BS_UNIT_AMPS = (): number => 100;
const AS_UNIT_AMPS = (bedrooms: number, isHouse: boolean): number => (isHouse || bedrooms >= 3 ? 100 : 80);

function necBase(region: Region, units: number, force3ph = false): ElecRegionPreset {
  const threePhase = units >= 6 || force3ph;
  return {
    region,
    code: region === 'CA' ? 'CEC C22.1-21' : 'NEC 2023',
    receptacleCode: 'NEC 210.52(A)',
    service: threePhase ? '208Y/120 V 3ph' : '240/120 V 1ph',
    serviceV: threePhase ? 208 : 240,
    phases: threePhase ? 3 : 1,
    serviceVoltageIndex: threePhase ? 1 : 0,
    unitService: '120/240 V 1ph 3W',
    unitServiceV: 240,
    branchV: 120,
    applianceV: 240,
    ring: false,
    earthLeakName: 'GFCI',
    panelName: 'Load centre',
    smallApplianceCircuits: 2,
    laundryCircuitVa: 1500,
    generalLightingVaPerM2: 33,
    maxReceptacleSpacing: 3.6,
    maxReceptacleReach: 1.8,
    counterSpacing: 1.2,
    caps: null,
    coAlarmAlways: true,
    unitPanelAmps: NEC_UNIT_AMPS,
  };
}

function bsBase(region: Region, units: number, force3ph = false): ElecRegionPreset {
  const threePhase = units > 1 || force3ph;
  return {
    region,
    code: region === 'IE' ? 'ET 101:2008 (IE)' : 'BS 7671:2018+A2',
    receptacleCode: 'BS 7671 App. 15 / IET On-Site Guide',
    service: threePhase ? '400Y/230 V 3ph' : '230 V 1ph',
    serviceV: threePhase ? 400 : 230,
    phases: threePhase ? 3 : 1,
    serviceVoltageIndex: threePhase ? 3 : 2,
    unitService: '230 V 1ph',
    unitServiceV: 230,
    branchV: 230,
    applianceV: 230,
    ring: true,
    earthLeakName: 'RCD',
    panelName: 'Consumer unit',
    smallApplianceCircuits: 1,
    laundryCircuitVa: 0,
    generalLightingVaPerM2: 33,
    maxReceptacleSpacing: 3.6,
    maxReceptacleReach: 1.8,
    counterSpacing: 1.2,
    caps: {
      living: { min: 4, max: 8 },
      bedroom: { min: 3, max: 5 },
      kitchen: { min: 6, max: 8 },
      circulation: { min: 1, max: 2 },
      other: { min: 1, max: 4 },
    },
    coAlarmAlways: true,
    unitPanelAmps: BS_UNIT_AMPS,
  };
}

function asBase(region: Region, units: number, force3ph = false): ElecRegionPreset {
  const p = bsBase(region, units, force3ph);
  return {
    ...p,
    code: 'AS/NZS 3000:2018',
    receptacleCode: 'AS/NZS 3000 §4 (socket-outlet provision)',
    ring: false,
    earthLeakName: 'RCD',
    panelName: 'Switchboard',
    coAlarmAlways: false,
    unitPanelAmps: AS_UNIT_AMPS,
  };
}

/**
 * Resolve the code preset for a region and dwelling count. `force3ph` upgrades the service to the
 * three-phase variant — used when the calculated demand outgrows a single-phase supply.
 */
export function elecRegion(region: Region, unitCount: number, force3ph = false): ElecRegionPreset {
  switch (region) {
    case 'US':
    case 'CA':
      return necBase(region, unitCount, force3ph);
    case 'UK':
    case 'IE':
      return bsBase(region, unitCount, force3ph);
    case 'AU':
    case 'NZ':
      return asBase(region, unitCount, force3ph);
    default:
      return necBase('US', unitCount, force3ph);
  }
}

/** Largest practical single-phase service (A) before a three-phase supply is required */
export const MAX_SINGLE_PHASE_AMPS = 400;

export function roomGroupOf(roomType: string): RoomGroup {
  switch (roomType) {
    case 'living': case 'dining': case 'living-kitchen': case 'lounge': case 'shared-living':
    case 'study': case 'den': case 'flex': case 'amenity':
      return 'living';
    case 'bedroom': case 'master-bedroom':
      return 'bedroom';
    case 'kitchen': case 'shared-kitchen':
      return 'kitchen';
    case 'hall': case 'entry': case 'corridor': case 'lobby': case 'lift-lobby': case 'stair':
      return 'circulation';
    default:
      return 'other';
  }
}
