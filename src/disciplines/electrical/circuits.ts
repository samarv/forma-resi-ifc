/**
 * Branch-circuit schedule. Devices carry a `want` (the circuit class they belong on); this module
 * groups them per panel, splits them by code limits and writes `circuitId` back onto each device.
 *
 *   NEC 210.11(C)  two 20 A small-appliance circuits, a 20 A laundry circuit, a 20 A bathroom circuit
 *   NEC 210.23     branch-circuit loading; continuous loads at 80 %
 *   BS 7671        32 A ring final per ~100 m², 6 A lighting circuits, 32 A cooker radial
 */
import type { Circuit, ElecDevice, ElecPanel } from '../../core/types.ts';
import { circuitCapacityVa } from './load.ts';
import type { UnitLoad } from './load.ts';
import { extraOf, type ElecCtx } from './internal.ts';

interface CircuitConfig {
  amps: number;
  volts: number;
  maxDevices: number;
}

function config(ec: ElecCtx, type: Circuit['type'], va: number): CircuitConfig {
  const b = ec.region.branchV;
  const a = ec.region.applianceV;
  const ring = ec.region.ring;
  switch (type) {
    case 'lighting':
    case 'house-lighting':
      return { amps: ring ? 6 : 15, volts: b, maxDevices: 24 };
    case 'general-receptacle':
      return { amps: ring ? 32 : 20, volts: b, maxDevices: ring ? 30 : 10 };
    case 'kitchen-small-appliance':
      return { amps: 20, volts: b, maxDevices: 10 };
    case 'bathroom':
    case 'laundry':
    case 'dishwasher':
    case 'refrigerator':
    case 'disposal':
      return { amps: ring ? 20 : 20, volts: b, maxDevices: 6 };
    case 'range':
      return { amps: ring ? 32 : 50, volts: a, maxDevices: 2 };
    case 'dryer':
      return { amps: ring ? 16 : 30, volts: a, maxDevices: 2 };
    case 'water-heater':
      return { amps: ring ? 16 : 30, volts: a, maxDevices: 2 };
    case 'hvac': {
      const amps = Math.max(30, Math.min(60, Math.ceil(va / a / 0.8 / 5) * 5));
      return { amps, volts: a, maxDevices: 4 };
    }
    case 'ev':
      return { amps: ring ? 32 : 40, volts: a, maxDevices: 1 };
    case 'life-safety':
      return { amps: ring ? 6 : 15, volts: b, maxDevices: 30 };
    case 'elevator':
      return { amps: 60, volts: a, maxDevices: 1 };
    case 'pv':
      return { amps: 40, volts: a, maxDevices: 40 };
  }
}

const ORDER: Circuit['type'][] = [
  'lighting', 'general-receptacle', 'kitchen-small-appliance', 'bathroom', 'laundry',
  'refrigerator', 'dishwasher', 'disposal', 'range', 'dryer', 'water-heater', 'hvac', 'ev',
  'life-safety', 'house-lighting', 'elevator', 'pv',
];

function groupByWant(ec: ElecCtx, devices: ElecDevice[]): Map<Circuit['type'], ElecDevice[]> {
  const m = new Map<Circuit['type'], ElecDevice[]>();
  for (const d of devices) {
    const want = extraOf(ec, d.id).want;
    if (!want) continue;
    const a = m.get(want);
    if (a) a.push(d);
    else m.set(want, [d]);
  }
  return m;
}

function sumVa(ec: ElecCtx, devices: ElecDevice[]): number {
  let va = 0;
  for (const d of devices) va += extraOf(ec, d.id).va;
  return va;
}

function circuitCount(ec: ElecCtx, type: Circuit['type'], devices: ElecDevice[], cfg: CircuitConfig, load: UnitLoad | null): number {
  const cap = circuitCapacityVa(cfg.amps, cfg.volts);
  const byDevices = Math.ceil(devices.length / cfg.maxDevices);
  switch (type) {
    case 'lighting': {
      const va = load ? load.generalLightingVa * 0.4 : sumVa(ec, devices);
      return Math.max(1, byDevices, Math.ceil(va / cap));
    }
    case 'house-lighting':
    case 'life-safety':
      return Math.max(1, byDevices, Math.ceil(sumVa(ec, devices) / cap));
    case 'general-receptacle': {
      if (ec.region.ring) return Math.max(1, Math.ceil((load?.areaM2 ?? 60) / 100), byDevices);
      const va = load ? load.generalLightingVa * 0.6 : devices.length * 180;
      return Math.max(2, byDevices, Math.ceil(va / cap));
    }
    case 'kitchen-small-appliance':
      return Math.max(ec.region.smallApplianceCircuits, byDevices);
    default:
      return Math.max(1, byDevices);
  }
}

function emit(
  ec: ElecCtx,
  panel: ElecPanel,
  type: Circuit['type'],
  devices: ElecDevice[],
  load: UnitLoad | null,
): Circuit[] {
  const va = sumVa(ec, devices);
  const cfg = config(ec, type, va);
  const n = circuitCount(ec, type, devices, cfg, load);
  const buckets: ElecDevice[][] = Array.from({ length: n }, () => []);
  devices.forEach((d, i) => buckets[i % n].push(d));
  const out: Circuit[] = [];
  for (let i = 0; i < n; i++) {
    const id = ec.ids.next(panel.storey, 'CIRC');
    const bucketVa = type === 'lighting' && load
      ? Math.round((load.generalLightingVa * 0.4) / n)
      : type === 'general-receptacle' && load && !ec.region.ring
        ? Math.round((load.generalLightingVa * 0.6) / n)
        : Math.max(sumVa(ec, buckets[i]), buckets[i].length * 180);
    const circuit: Circuit = {
      id,
      panelId: panel.id,
      type,
      amps: cfg.amps,
      voltage: cfg.volts,
      deviceIds: buckets[i].map(d => d.id),
      va: bucketVa,
    };
    for (const d of buckets[i]) d.circuitId = id;
    ec.circuits.push(circuit);
    out.push(circuit);
  }
  panel.circuitCount += n;
  return out;
}

export interface CircuitTargets {
  unitPanelByUnit: Map<string, ElecPanel>;
  housePanel: ElecPanel | null;
  evPanel: ElecPanel | null;
  pvCombiner: ElecPanel | null;
  elevators: number;
}

/** Build every circuit and assign devices to it */
export function buildCircuits(ec: ElecCtx, targets: CircuitTargets, loads: Map<string, UnitLoad>): void {
  const houseFallback = targets.housePanel
    ?? ec.panels.find(p => p.type === 'floor-distribution')
    ?? ec.panels.find(p => p.type === 'main-switchboard')
    ?? ec.panels.find(p => p.type === 'unit-panel')
    ?? null;

  // Dwelling circuits
  const byUnit = new Map<string, ElecDevice[]>();
  const house: ElecDevice[] = [];
  for (const d of ec.devices) {
    const panel = d.unitId ? targets.unitPanelByUnit.get(d.unitId) : undefined;
    if (d.unitId && panel) {
      const a = byUnit.get(d.unitId);
      if (a) a.push(d);
      else byUnit.set(d.unitId, [d]);
    } else {
      house.push(d);
    }
  }
  for (const [unitId, devices] of byUnit) {
    const panel = targets.unitPanelByUnit.get(unitId);
    if (!panel) continue;
    const load = loads.get(unitId) ?? null;
    const groups = groupByWant(ec, devices);
    for (const type of ORDER) {
      const g = groups.get(type);
      if (!g || g.length === 0) continue;
      emit(ec, panel, type, g, load);
    }
  }

  // House / common circuits
  const groups = groupByWant(ec, house);
  for (const type of ORDER) {
    const g = groups.get(type);
    if (!g || g.length === 0) continue;
    const panel = type === 'ev' ? (targets.evPanel ?? houseFallback)
      : type === 'pv' ? (targets.pvCombiner ?? houseFallback)
        : houseFallback;
    if (!panel) continue;
    emit(ec, panel, type, g, null);
  }

  // Elevators: one dedicated feeder each, no devices attached
  if (houseFallback && targets.elevators > 0) {
    for (let i = 0; i < targets.elevators; i++) {
      const cfg = config(ec, 'elevator', 20000);
      const id = ec.ids.next(houseFallback.storey, 'CIRC');
      ec.circuits.push({
        id, panelId: houseFallback.id, type: 'elevator', amps: cfg.amps, voltage: cfg.volts,
        deviceIds: [], va: 20000,
      });
      houseFallback.circuitCount += 1;
    }
  }
}
