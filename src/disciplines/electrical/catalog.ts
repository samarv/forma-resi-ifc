/**
 * Device / panel catalogue: IFC mapping, box sizes, mounting mode, colour, system and
 * electrical characteristics for every ElecDeviceType and ElecPanel['type'].
 *
 * MOUNTING MODES (how an anchor point becomes a `box` geometry):
 *   'wall'    anchor lies ON the inside wall face at the device's vertical CENTRE.
 *             rotation r is the wall direction; the inward normal is (-sin r, cos r);
 *             the box grows +width along r, +depth along the inward normal, and is
 *             centred vertically on the anchor.
 *   'ceiling' anchor is the fixture centre at the ceiling; the box hangs below it.
 *   'floor'   anchor is the footprint centre at floor level; the box sits on the floor.
 *   'center'  anchor is the geometric centre of the box.
 */
import type { ElecDeviceType, ElecPanel, RGB } from '../../core/types.ts';

export type MountMode = 'wall' | 'ceiling' | 'floor' | 'center';
export type ElecSystem = 'POWER-LV' | 'LIGHTING' | 'LIFE-SAFETY' | 'DATA' | 'PV' | 'EV';

export interface DeviceSpec {
  ifcType: string;
  predefinedType?: string;
  objectType?: string;
  name: string;
  /** id kind code (ELE-<STOREY>-<KIND>-nnn) */
  kind: string;
  w: number;
  d: number;
  h: number;
  mount: MountMode;
  color: RGB;
  system: ElecSystem;
  /** Connected wattage (0 for outlets — their load is a VA allowance, not a fixture) */
  watts: number;
  /** Load allowance in VA used for circuit fill */
  va: number;
  /** Delivered lumens (lighting only) — drives ELE-13 fixture counts */
  lumens?: number;
  /** Default mounting height (storey-local Z) when the caller has no better value */
  z?: number;
}

const OUTLET_C: RGB = [1.0, 0.6, 0.2];
const DATA_C: RGB = [0.2, 0.7, 0.9];
const SWITCH_C: RGB = [0.9, 0.9, 0.5];
const LIGHT_C: RGB = [1.0, 0.95, 0.6];
const ALARM_C: RGB = [0.95, 0.2, 0.2];
const PANEL_C: RGB = [0.25, 0.25, 0.3];
const PV_C: RGB = [0.1, 0.15, 0.4];
const EV_C: RGB = [0.2, 0.8, 0.5];
const XFMR_C: RGB = [0.35, 0.35, 0.35];

export const DEVICE_SPEC: Record<ElecDeviceType, DeviceSpec> = {
  'receptacle': { ifcType: 'IfcOutlet', predefinedType: 'POWEROUTLET', name: 'Duplex receptacle', kind: 'RCPT', w: 0.08, d: 0.04, h: 0.12, mount: 'wall', color: OUTLET_C, system: 'POWER-LV', watts: 0, va: 180, z: 0.4 },
  'gfci-receptacle': { ifcType: 'IfcOutlet', predefinedType: 'POWEROUTLET', objectType: 'GFCI receptacle', name: 'GFCI receptacle', kind: 'GFCI', w: 0.08, d: 0.04, h: 0.12, mount: 'wall', color: OUTLET_C, system: 'POWER-LV', watts: 0, va: 180, z: 0.4 },
  'range-receptacle': { ifcType: 'IfcOutlet', predefinedType: 'POWEROUTLET', objectType: 'Range receptacle 50A', name: 'Range receptacle', kind: 'RANG', w: 0.14, d: 0.06, h: 0.16, mount: 'wall', color: OUTLET_C, system: 'POWER-LV', watts: 0, va: 8000, z: 0.3 },
  'dryer-receptacle': { ifcType: 'IfcOutlet', predefinedType: 'POWEROUTLET', objectType: 'Dryer receptacle 30A', name: 'Dryer receptacle', kind: 'DRYR', w: 0.12, d: 0.06, h: 0.15, mount: 'wall', color: OUTLET_C, system: 'POWER-LV', watts: 0, va: 5000, z: 0.3 },
  'switch': { ifcType: 'IfcSwitchingDevice', predefinedType: 'TOGGLESWITCH', name: 'Light switch', kind: 'SW', w: 0.08, d: 0.03, h: 0.12, mount: 'wall', color: SWITCH_C, system: 'LIGHTING', watts: 0, va: 0, z: 1.2 },
  'dimmer': { ifcType: 'IfcSwitchingDevice', predefinedType: 'DIMMERSWITCH', name: 'Dimmer', kind: 'DIM', w: 0.08, d: 0.03, h: 0.12, mount: 'wall', color: SWITCH_C, system: 'LIGHTING', watts: 0, va: 0, z: 1.2 },
  'light-ceiling': { ifcType: 'IfcLightFixture', predefinedType: 'POINTSOURCE', name: 'Ceiling luminaire', kind: 'LTC', w: 0.3, d: 0.3, h: 0.08, mount: 'ceiling', color: LIGHT_C, system: 'LIGHTING', watts: 16, va: 16, lumens: 1600 },
  'light-recessed': { ifcType: 'IfcLightFixture', predefinedType: 'POINTSOURCE', objectType: 'Recessed downlight', name: 'Recessed downlight', kind: 'LTR', w: 0.15, d: 0.15, h: 0.05, mount: 'ceiling', color: LIGHT_C, system: 'LIGHTING', watts: 10, va: 10, lumens: 900 },
  'light-pendant': { ifcType: 'IfcLightFixture', predefinedType: 'POINTSOURCE', objectType: 'Pendant', name: 'Pendant luminaire', kind: 'LTP', w: 0.35, d: 0.35, h: 0.5, mount: 'ceiling', color: LIGHT_C, system: 'LIGHTING', watts: 15, va: 15, lumens: 1200 },
  'light-wall': { ifcType: 'IfcLightFixture', predefinedType: 'DIRECTIONSOURCE', name: 'Wall luminaire', kind: 'LTW', w: 0.25, d: 0.12, h: 0.25, mount: 'wall', color: LIGHT_C, system: 'LIGHTING', watts: 9, va: 9, lumens: 800, z: 2.0 },
  'light-vanity': { ifcType: 'IfcLightFixture', predefinedType: 'DIRECTIONSOURCE', objectType: 'Vanity light', name: 'Vanity luminaire', kind: 'LTV', w: 0.9, d: 0.1, h: 0.12, mount: 'wall', color: LIGHT_C, system: 'LIGHTING', watts: 14, va: 14, lumens: 1300, z: 2.0 },
  'light-under-cabinet': { ifcType: 'IfcLightFixture', predefinedType: 'DIRECTIONSOURCE', objectType: 'Under-cabinet light', name: 'Under-cabinet luminaire', kind: 'LTU', w: 0.6, d: 0.06, h: 0.05, mount: 'wall', color: LIGHT_C, system: 'LIGHTING', watts: 6, va: 6, lumens: 500, z: 1.45 },
  'light-emergency': { ifcType: 'IfcLightFixture', predefinedType: 'SECURITYLIGHTING', objectType: 'Emergency luminaire', name: 'Emergency luminaire', kind: 'EMER', w: 0.3, d: 0.12, h: 0.12, mount: 'ceiling', color: ALARM_C, system: 'LIFE-SAFETY', watts: 5, va: 5, lumens: 350 },
  'exit-sign': { ifcType: 'IfcLightFixture', predefinedType: 'SECURITYLIGHTING', objectType: 'Exit sign', name: 'Exit sign', kind: 'EXIT', w: 0.35, d: 0.05, h: 0.2, mount: 'wall', color: ALARM_C, system: 'LIFE-SAFETY', watts: 3, va: 3, lumens: 0, z: 2.3 },
  'light-exterior': { ifcType: 'IfcLightFixture', predefinedType: 'DIRECTIONSOURCE', objectType: 'Exterior wall light', name: 'Exterior wall luminaire', kind: 'LTX', w: 0.25, d: 0.15, h: 0.3, mount: 'wall', color: LIGHT_C, system: 'LIGHTING', watts: 12, va: 12, lumens: 1100, z: 2.2 },
  'light-bollard': { ifcType: 'IfcLightFixture', predefinedType: 'DIRECTIONSOURCE', objectType: 'Bollard light', name: 'Bollard luminaire', kind: 'BOLL', w: 0.15, d: 0.15, h: 1.0, mount: 'center', color: LIGHT_C, system: 'LIGHTING', watts: 8, va: 8, lumens: 400, z: 0.5 },
  'light-pole': { ifcType: 'IfcLightFixture', predefinedType: 'DIRECTIONSOURCE', objectType: 'Pole light 6 m', name: 'Pole luminaire', kind: 'POLE', w: 0.2, d: 0.2, h: 6.0, mount: 'floor', color: LIGHT_C, system: 'LIGHTING', watts: 60, va: 60, lumens: 7000 },
  'smoke-alarm': { ifcType: 'IfcSensor', predefinedType: 'SMOKESENSOR', name: 'Smoke alarm', kind: 'SMOK', w: 0.12, d: 0.12, h: 0.04, mount: 'ceiling', color: ALARM_C, system: 'LIFE-SAFETY', watts: 1, va: 1 },
  'co-alarm': { ifcType: 'IfcSensor', predefinedType: 'COSENSOR', name: 'Carbon monoxide alarm', kind: 'COAL', w: 0.12, d: 0.12, h: 0.04, mount: 'ceiling', color: ALARM_C, system: 'LIFE-SAFETY', watts: 1, va: 1 },
  'heat-detector': { ifcType: 'IfcSensor', predefinedType: 'HEATSENSOR', name: 'Heat detector', kind: 'HEAT', w: 0.12, d: 0.12, h: 0.04, mount: 'ceiling', color: ALARM_C, system: 'LIFE-SAFETY', watts: 1, va: 1 },
  'data-outlet': { ifcType: 'IfcOutlet', predefinedType: 'DATAOUTLET', name: 'Data outlet', kind: 'DATA', w: 0.08, d: 0.04, h: 0.12, mount: 'wall', color: DATA_C, system: 'DATA', watts: 0, va: 0, z: 0.4 },
  'tv-outlet': { ifcType: 'IfcOutlet', predefinedType: 'AUDIOVISUALOUTLET', name: 'TV outlet', kind: 'TVO', w: 0.08, d: 0.04, h: 0.12, mount: 'wall', color: DATA_C, system: 'DATA', watts: 0, va: 0, z: 0.4 },
  'thermostat': { ifcType: 'IfcUnitaryControlElement', predefinedType: 'THERMOSTAT', name: 'Thermostat', kind: 'TSTAT', w: 0.11, d: 0.03, h: 0.08, mount: 'wall', color: DATA_C, system: 'DATA', watts: 0, va: 0, z: 1.5 },
  'doorbell': { ifcType: 'IfcAudioVisualAppliance', predefinedType: 'USERDEFINED', objectType: 'Doorbell', name: 'Doorbell push', kind: 'BELL', w: 0.07, d: 0.03, h: 0.1, mount: 'wall', color: DATA_C, system: 'DATA', watts: 0, va: 0, z: 1.2 },
  'intercom': { ifcType: 'IfcAudioVisualAppliance', predefinedType: 'USERDEFINED', objectType: 'Intercom', name: 'Intercom station', kind: 'ICOM', w: 0.2, d: 0.05, h: 0.3, mount: 'wall', color: DATA_C, system: 'DATA', watts: 5, va: 5, z: 1.4 },
  'ev-charger': { ifcType: 'IfcElectricAppliance', predefinedType: 'USERDEFINED', objectType: 'EVCharger', name: 'EV charger', kind: 'EVC', w: 0.3, d: 0.15, h: 1.2, mount: 'floor', color: EV_C, system: 'EV', watts: 7200, va: 7200 },
  'disconnect': { ifcType: 'IfcSwitchingDevice', predefinedType: 'CIRCUITBREAKER', objectType: 'Disconnect', name: 'Equipment disconnect', kind: 'DISC', w: 0.2, d: 0.12, h: 0.3, mount: 'wall', color: PANEL_C, system: 'POWER-LV', watts: 0, va: 0, z: 1.4 },
  'junction-box': { ifcType: 'IfcJunctionBox', predefinedType: 'POWER', name: 'Junction box', kind: 'JB', w: 0.1, d: 0.05, h: 0.1, mount: 'wall', color: PANEL_C, system: 'POWER-LV', watts: 0, va: 0, z: 2.4 },
  'pv-panel': { ifcType: 'IfcSolarDevice', predefinedType: 'SOLARPANEL', name: 'PV module 400 Wp', kind: 'PV', w: 1.0, d: 1.7, h: 0.05, mount: 'floor', color: PV_C, system: 'PV', watts: 0, va: 400, z: 0.3 },
  'inverter': { ifcType: 'IfcTransformer', predefinedType: 'INVERTER', objectType: 'PV inverter', name: 'PV inverter', kind: 'INV', w: 0.8, d: 0.35, h: 1.2, mount: 'floor', color: XFMR_C, system: 'PV', watts: 0, va: 0 },
  'transformer': { ifcType: 'IfcTransformer', predefinedType: 'VOLTAGE', objectType: 'Pad-mounted transformer', name: 'Pad-mounted transformer', kind: 'XFMR', w: 1.6, d: 1.2, h: 1.5, mount: 'floor', color: XFMR_C, system: 'POWER-LV', watts: 0, va: 0 },
  'generator': { ifcType: 'IfcElectricGenerator', predefinedType: 'USERDEFINED', objectType: 'Standby generator', name: 'Standby generator', kind: 'GEN', w: 2.4, d: 1.2, h: 1.8, mount: 'floor', color: XFMR_C, system: 'POWER-LV', watts: 0, va: 0 },
};

export interface PanelSpec {
  ifcType: string;
  predefinedType: string;
  objectType?: string;
  name: string;
  kind: string;
  w: number;
  d: number;
  h: number;
  /** 'wall' = surface/flush mounted with its bottom at `bottom`; 'floor' = free-standing against a wall */
  mount: 'wall' | 'floor';
  bottom: number;
  color: RGB;
}

export const PANEL_SPEC: Record<ElecPanel['type'], PanelSpec> = {
  'unit-panel': { ifcType: 'IfcElectricDistributionBoard', predefinedType: 'DISTRIBUTIONBOARD', name: 'Dwelling panelboard', kind: 'PNL', w: 0.36, d: 0.1, h: 0.75, mount: 'wall', bottom: 1.2, color: PANEL_C },
  'main-switchboard': { ifcType: 'IfcElectricDistributionBoard', predefinedType: 'SWITCHBOARD', name: 'Main switchboard', kind: 'MSB', w: 2.0, d: 0.6, h: 2.2, mount: 'floor', bottom: 0, color: PANEL_C },
  'meter-bank': { ifcType: 'IfcElectricDistributionBoard', predefinedType: 'DISTRIBUTIONBOARD', objectType: 'Meter bank', name: 'Meter bank', kind: 'MTR', w: 1.2, d: 0.3, h: 1.8, mount: 'wall', bottom: 0.3, color: PANEL_C },
  'house-panel': { ifcType: 'IfcElectricDistributionBoard', predefinedType: 'DISTRIBUTIONBOARD', objectType: 'House panel', name: 'House panel', kind: 'HPN', w: 0.6, d: 0.2, h: 1.2, mount: 'wall', bottom: 0.9, color: PANEL_C },
  'floor-distribution': { ifcType: 'IfcElectricDistributionBoard', predefinedType: 'DISTRIBUTIONBOARD', objectType: 'Floor distribution board', name: 'Floor distribution board', kind: 'FDB', w: 0.6, d: 0.2, h: 1.2, mount: 'wall', bottom: 0.9, color: PANEL_C },
  'ev-panel': { ifcType: 'IfcElectricDistributionBoard', predefinedType: 'DISTRIBUTIONBOARD', objectType: 'EV panel', name: 'EV charging panel', kind: 'EVP', w: 0.6, d: 0.2, h: 1.2, mount: 'wall', bottom: 0.9, color: EV_C },
  'pv-combiner': { ifcType: 'IfcElectricDistributionBoard', predefinedType: 'DISTRIBUTIONBOARD', objectType: 'PV combiner', name: 'PV combiner box', kind: 'PVC', w: 0.4, d: 0.15, h: 0.5, mount: 'wall', bottom: 1.2, color: PV_C },
};

/** Cable tray / conduit / busduct colours */
export const RUN_COLORS = {
  tray: [1.0, 0.85, 0.2] as RGB,
  dataTray: [0.2, 0.7, 0.9] as RGB,
  busduct: [0.9, 0.7, 0.1] as RGB,
  conduit: [0.8, 0.8, 0.85] as RGB,
};

/** Nameplate VA for appliances that get a dedicated circuit (NEC 220.53 / Table 220.55) */
export const APPLIANCE_VA = {
  range: 8000,
  cooktop: 6000,
  oven: 4500,
  dryer: 5000,
  dishwasher: 1200,
  disposal: 800,
  fridge: 800,
  microwave: 1500,
  waterHeater: 4500,
  washer: 1200,
  hvacDefault: 3500,
  ev: 7200,
  elevator: 20000,
} as const;

/** Illuminance targets (lux) — ELE-13 Light by Task not Watts */
export const LUX_TARGET: Record<string, number> = {
  living: 150,
  dining: 150,
  'living-kitchen': 200,
  lounge: 150,
  'shared-living': 150,
  study: 300,
  den: 150,
  flex: 150,
  kitchen: 300,
  'shared-kitchen': 300,
  bathroom: 200,
  ensuite: 200,
  powder: 200,
  wc: 150,
  bedroom: 100,
  'master-bedroom': 100,
  corridor: 100,
  hall: 100,
  entry: 100,
  stair: 150,
  lobby: 150,
  'lift-lobby': 150,
  laundry: 200,
  utility: 200,
  garage: 75,
  parking: 75,
  storage: 75,
  closet: 75,
  'walk-in-closet': 100,
  'mech-room': 200,
  'elec-room': 200,
  amenity: 200,
  gym: 300,
};

/** Maintained utilisation factor for a flat-ceiling LED layout */
export const UTILISATION = 0.7;
