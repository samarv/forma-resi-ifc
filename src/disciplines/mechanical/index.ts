/**
 * MECHANICAL discipline — HVAC and ventilation.
 *
 * `generateMechanical(ctx)` reads `ctx.arch` (rooms, units, shafts, corridors, roof) and
 * `ctx.struct` (slab thickness, beams, plenum clearance) and returns a `MechModel`:
 * equipment, air ducts, terminals, risers, loads, ModelElements, pattern applications and
 * derived metrics.
 *
 * Coordination summary (the other disciplines rely on these):
 * - Dwelling ducts stay in the hall-ceiling band: ceilingHeight ≤ z ≤ floorToFloor − slabT.
 * - Corridor ducts use `lanePath(centerline, DEFAULT_LANES.duct, plenumBands(...).ductZ)` only.
 * - Mechanical risers take the shaft CENTRE; plumbing takes the corridor-left corner and
 *   electrical the corridor-right corner. Extra mechanical risers step along the shaft's long
 *   axis inside `inset(rect, 0.12)` and never touch a corner.
 * - Risers are emitted PER STOREY (element Z is storey-local).
 * - `equipment` of type 'thermostat' is the electrical discipline's hook for control wiring.
 */
import type {
  GenContext, HvacSystemId, MechModel, Region, VentilationStrategy,
} from '../../core/types.ts';
import { KW_TO_TON } from '../../core/units.ts';
import { MechBuild } from './context.ts';
import { MECH_PATTERNS } from './patterns.ts';
import { computeUnitLoad, r1, REGION_LOADS, type UnitLoad } from './loads.ts';
import { buildUnitInfo, generateUnitSystem, type UnitInfo } from './unit-systems.ts';
import { generateVentilation } from './ventilation.ts';
import { generateBuildingSystems } from './building.ts';

export { MECH_PATTERNS };
export { MECH_PATTERN_IDS } from './patterns.ts';
export type { UnitLoad } from './loads.ts';
export { REGION_LOADS } from './loads.ts';

export const HVAC_SYSTEM_ORDER: HvacSystemId[] = [
  'ducted-heat-pump', 'ductless-mini-split', 'ptac', 'vrf', 'mvhr-radiators', 'central-ahu-fan-coil',
];

/** The BuildingSpec has no hvac/ventilation field yet, so an override may be attached ad hoc. */
interface MechOverrides {
  hvac?: HvacSystemId;
  ventilation?: VentilationStrategy;
}

export function resolveHvac(ctx: GenContext): HvacSystemId {
  const o = ctx.spec as unknown as MechOverrides;
  return o.hvac ?? ctx.typology.hvac;
}

export function resolveVentilation(ctx: GenContext): VentilationStrategy {
  const o = ctx.spec as unknown as MechOverrides;
  return o.ventilation ?? ctx.typology.ventilation;
}

export function generateMechanical(ctx: GenContext): MechModel {
  const hvac = resolveHvac(ctx);
  const ventilation = resolveVentilation(ctx);
  const region: Region = ctx.spec.region;
  const factors = REGION_LOADS[region];

  if (!ctx.arch) {
    ctx.warnings.push('MEC: no architecture model — mechanical skipped');
    return emptyModel(hvac, ventilation, factors.coolingWPerM2, factors.heatingWPerM2);
  }

  const b = new MechBuild(ctx, hvac, ventilation);

  // ---- Loads (MEC-12 / XD-05) --------------------------------------------
  const loads = new Map<string, UnitLoad>();
  let totalCoolingW = 0;
  let totalHeatingW = 0;
  let totalVentLs = 0;
  let totalOccupants = 0;
  let totalAreaM2 = 0;
  for (const u of b.units) {
    const area = u.area > 0 ? u.area : u.rect.w * u.rect.h;
    const load = computeUnitLoad(region, u.id, area, u.bedrooms, u.occupants);
    loads.set(u.id, load);
    totalCoolingW += load.coolingW;
    totalHeatingW += load.heatingW;
    totalVentLs += load.ventilationLs;
    totalOccupants += load.occupants;
    totalAreaM2 += area;
  }
  b.apply('MEC-12', {
    params: {
      standard: factors.ventStandard,
      dwellings: b.units.length,
      occupants: totalOccupants,
      niaM2: r1(totalAreaM2),
      ventilationLs: r1(totalVentLs),
      coolingKw: r1(totalCoolingW / 1000),
      heatingKw: r1(totalHeatingW / 1000),
    },
  });
  b.apply('XD-05', {
    params: { occupancyRule: 'bedrooms + 1', occupants: totalOccupants, dwellings: b.units.length },
    note: 'mechanical sized ventilation from design occupancy',
  });
  b.apply('MEC-01', {
    params: {
      system: hvac,
      ventilation,
      region,
      typology: ctx.typology.id,
      coolingWPerM2: factors.coolingWPerM2,
      heatingWPerM2: factors.heatingWPerM2,
      loadSource: factors.source,
    },
  });

  // ---- Per-dwelling systems ----------------------------------------------
  const infos: UnitInfo[] = [];
  for (const u of b.units) {
    const load = loads.get(u.id);
    if (!load) continue;
    const info = buildUnitInfo(b, u, load);
    infos.push(info);
    generateUnitSystem(b, info);
  }

  // ---- Ventilation, then building-wide systems ---------------------------
  generateVentilation(b, infos);
  const building = generateBuildingSystems(b, {
    coolingKw: totalCoolingW / 1000,
    heatingKw: totalHeatingW / 1000,
    ventilationLs: totalVentLs,
  });

  if (b.risers.length > 0) {
    b.apply('XD-04', {
      params: {
        risers: b.risers.length,
        shafts: new Set(b.risers.map(r => r.shaftId)).size,
        slot: 'mechanical takes the shaft centre',
      },
    });
  }
  if (b.resiStoreys.some(s => s.corridors.length > 0)) {
    b.apply('XD-02', {
      params: { lane: 'duct (centreline)', lateralOffsetM: 0, storeysWithCorridor: b.resiStoreys.filter(s => s.corridors.length > 0).length },
    });
  }
  if (b.longExtractRuns > 0) {
    b.warn(`${b.longExtractRuns} extract branch(es) exceed the 12 m target of MEC-03 (longest ${r1(b.longestExtractM)} m) — the architecture model needs a shaft nearer the middle of the corridor`);
  }
  if (b.roofGrid.overflow > 0) {
    b.warn(`roof plant zone (${r1(b.plantZone.w * b.plantZone.h)} m²) is too small for ${b.roofGrid.overflow} item(s); they overlap`);
  }
  b.finalizePatternTrace();

  const diffuserCount = b.terminals.filter(t => t.type === 'supply-diffuser').length;
  const exhaustFanCount = b.equipment.filter(e => e.type === 'exhaust-fan').length;
  const plantAreaM2 = b.plantZone.w * b.plantZone.h;
  const totalCoolingKw = totalCoolingW / 1000;
  const totalHeatingKw = totalHeatingW / 1000;

  return {
    system: hvac,
    ventilation,
    equipment: b.equipment,
    ducts: b.ducts,
    terminals: b.terminals,
    risers: b.risers,
    plantRoomIds: (ctx.arch.rooms ?? []).filter(r => r.type === 'mech-room' || r.type === 'plant').map(r => r.id),
    loads: {
      coolingWPerM2: factors.coolingWPerM2,
      heatingWPerM2: factors.heatingWPerM2,
      ventilationLsPerPerson: totalOccupants > 0 ? r1(totalVentLs / totalOccupants) : 3.5,
      totalCoolingKw: r1(totalCoolingKw),
      totalHeatingKw: r1(totalHeatingKw),
    },
    elements: b.elements,
    patterns: b.patterns,
    derived: {
      totalCoolingKw: r1(totalCoolingKw),
      totalHeatingKw: r1(totalHeatingKw),
      ventilationLs: r1(totalVentLs + building.corridorLs),
      ductLengthM: r1(b.ductLengthM),
      diffuserCount,
      equipmentCount: b.equipment.length,
      riserCount: b.risers.length,
      rooftopUnits: building.rooftopUnits,
      coolingTons: r1(totalCoolingKw * KW_TO_TON),
      plantAreaM2: r1(plantAreaM2),
      exhaustFanCount,
      pressurisedStairs: building.pressurisedStairs,
      hvacSystemIndex: Math.max(0, HVAC_SYSTEM_ORDER.indexOf(hvac)),
      terminalCount: b.terminals.length,
      ductRunCount: b.ducts.length,
      elementCount: b.elements.length,
      corridorMakeUpLs: r1(building.corridorLs),
      plantItems: building.plantItems,
    },
  };
}

function emptyModel(system: HvacSystemId, ventilation: VentilationStrategy, coolingWPerM2: number, heatingWPerM2: number): MechModel {
  return {
    system,
    ventilation,
    equipment: [],
    ducts: [],
    terminals: [],
    risers: [],
    plantRoomIds: [],
    loads: { coolingWPerM2, heatingWPerM2, ventilationLsPerPerson: 3.5, totalCoolingKw: 0, totalHeatingKw: 0 },
    elements: [],
    patterns: [],
    derived: {
      totalCoolingKw: 0, totalHeatingKw: 0, ventilationLs: 0, ductLengthM: 0, diffuserCount: 0,
      equipmentCount: 0, riserCount: 0, rooftopUnits: 0, coolingTons: 0, plantAreaM2: 0,
      exhaustFanCount: 0, pressurisedStairs: 0, hvacSystemIndex: Math.max(0, HVAC_SYSTEM_ORDER.indexOf(system)),
      terminalCount: 0, ductRunCount: 0, elementCount: 0, corridorMakeUpLs: 0, plantItems: 0,
    },
  };
}
