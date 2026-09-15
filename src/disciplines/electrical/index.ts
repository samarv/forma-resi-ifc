/**
 * ELECTRICAL + LIGHTING + LIFE SAFETY discipline.
 *
 * Consumes ctx.site (parking, paths, entrances), ctx.arch (rooms, walls, doors, windows,
 * furniture, units, cores, shafts, corridors, roof zones), ctx.struct (slab / beam depths for the
 * plenum bands), ctx.mech (thermostats and equipment needing a circuit and a disconnect) and
 * ctx.plumb (water heaters, pumps). Produces devices, panels, circuits, trays, risers, a PV array
 * and the load / demand calculation, plus one ModelElement per physical item.
 *
 * Patterns: ELE-01 … ELE-13 (see patterns.ts), cross patterns XD-02 and XD-04.
 */
import type {
  Circuit, ElecDevice, ElecModel, ElecPanel, GenContext, ModelElement, PatternApplication,
  RoomDef, RoomType, UnitInstance,
} from '../../core/types.ts';
import { polygonArea } from '../../core/geometry.ts';
import { ELEC_PATTERNS } from './patterns.ts';
import { elecRegion, MAX_SINGLE_PHASE_AMPS } from './region.ts';
import {
  demandFactor220_84, houseLoad, roundServiceAmps, serviceAmpsFor, unitLoad, type UnitLoad,
} from './load.ts';
import { extraOf, makeElecCtx, type ElecCtx, type UnitContext } from './internal.ts';
import { generateCommonRoomDevices, generateUnitDevices } from './devices.ts';
import {
  generateCorridorDevices, generateEgressDevices, generateEntryIntercom, generateEquipmentDevices,
  generateSiteLighting,
} from './common.ts';
import {
  buildFeeders, buildRisers, buildTrays, placeEvPanel, placeFloorDistribution, placePvEquipment,
  placeServiceEquipment, placeUnitPanel,
} from './panels.ts';
import { generateEv, generatePv } from './pv-ev.ts';
import { buildCircuits } from './circuits.ts';
import { emitElements } from './emit.ts';

export { ELEC_PATTERNS } from './patterns.ts';
export { elecRegion, SERVICE_VOLTAGES, STANDARD_SERVICE_AMPS } from './region.ts';
export { DEVICE_SPEC, PANEL_SPEC } from './catalog.ts';
export { deviceBoxCenter } from './emit.ts';
export { roomFaces } from './placement.ts';

const OUTDOOR_ROOMS: Partial<Record<RoomType, boolean>> = {
  balcony: true, terrace: true, porch: true, courtyard: true, landscape: true, roof: true,
};

const UNIT_PANEL_FRAMES = [60, 80, 100, 125, 150, 200, 225, 400];

export function generateElectrical(ctx: GenContext): ElecModel {
  const arch = ctx.arch;
  if (!arch) {
    ctx.warnings.push('electrical: no architecture model — nothing generated');
    return emptyModel(ctx);
  }
  let region = elecRegion(ctx.spec.region, arch.units.length);
  const ec = makeElecCtx(ctx, arch, region);

  // ---- devices ------------------------------------------------------------
  const unitCtxs = buildUnitContexts(ec);
  for (const uc of unitCtxs) generateUnitDevices(ec, uc);

  const commonRooms: RoomDef[] = [];
  for (const st of ec.storeys) {
    for (const room of ec.roomsByStorey.get(st.id) ?? []) {
      if (room.unitId) continue;
      if (room.type === 'corridor' || room.type === 'shaft' || room.type === 'elevator') continue;
      commonRooms.push(room);
      generateCommonRoomDevices(ec, room);
    }
  }
  const corridorByStorey = new Map<string, { corridorLength: number; fixtures: string[] }>();
  for (const st of ec.storeys) corridorByStorey.set(st.id, generateCorridorDevices(ec, st.id));
  const egress = generateEgressDevices(ec);
  generateEntryIntercom(ec);
  const site = generateSiteLighting(ec);
  const equipment = generateEquipmentDevices(ec);
  const ev = generateEv(ec);

  // ---- loads (ELE-11) -----------------------------------------------------
  const loads = new Map<string, UnitLoad>();
  for (const uc of unitCtxs) loads.set(uc.unit.id, computeUnitLoad(ec, uc, equipment));
  let unitConnected = 0;
  let unitDemand = 0;
  for (const l of loads.values()) {
    unitConnected += l.connectedVa;
    unitDemand += l.demandVa;
  }
  const commonAreaM2 = commonRooms.reduce((a, r) => a + r.area, 0)
    + sumCorridorArea(ec);
  const centralMechKw = (ctx.mech?.equipment ?? [])
    .filter(e => !e.unitId && (e.type === 'rtu' || e.type === 'ahu' || e.type === 'chiller' || e.type === 'boiler' || e.type === 'vrf-condenser'))
    .reduce((a, e) => a + (e.capacityKw ?? 0), 0);
  const house = houseLoad({
    commonAreaM2,
    elevators: arch.elevators.length,
    centralMechKw,
    evChargers: ev.chargers,
  });
  const units = arch.units.length;
  const factor = demandFactor220_84(units);
  const connectedVa = Math.round(unitConnected + house.totalVa);
  const demandVa = Math.round(units >= 3 ? unitConnected * factor + house.totalVa : unitDemand + house.totalVa);
  let calcAmps = serviceAmpsFor(demandVa, region.serviceV, region.phases);
  if (region.phases === 1 && calcAmps > MAX_SINGLE_PHASE_AMPS) {
    // the demand has outgrown a single-phase supply: take the three-phase service instead
    ec.region = elecRegion(ctx.spec.region, units, true);
    region = ec.region;
    calcAmps = serviceAmpsFor(demandVa, region.serviceV, region.phases);
  }
  const serviceAmps = roundServiceAmps(calcAmps);

  // ---- panels -------------------------------------------------------------
  const unitPanelByUnit = new Map<string, ElecPanel>();
  const isHouse = ctx.typology.access === 'direct';
  for (const uc of unitCtxs) {
    const load = loads.get(uc.unit.id);
    const preset = region.unitPanelAmps(uc.unit.bedrooms, isHouse);
    const amps = Math.max(preset, frameFor((load?.amps ?? 0) * 1.25));
    const panel = placeUnitPanel(ec, uc, amps);
    if (panel) unitPanelByUnit.set(uc.unit.id, panel);
  }
  const houseCircuitEstimate = 6 + ec.storeys.length + arch.elevators.length;
  const service = placeServiceEquipment(ec, serviceAmps, units, houseCircuitEstimate);
  const floorBoards = placeFloorDistribution(ec);
  const evPanel = placeEvPanel(ec, ev.chargers, ev.near, ev.storey);

  // ---- PV (ELE-09) --------------------------------------------------------
  const pv = generatePv(ec, demandVa);
  const pvEquip = placePvEquipment(ec, pv.kwDc, pv.zone);

  // ---- distribution -------------------------------------------------------
  const trays = buildTrays(ec);
  const risers = buildRisers(ec);
  const feederLength = buildFeeders(ec, trays.laneByStorey, ec.panels);

  // ---- circuits -----------------------------------------------------------
  buildCircuits(ec, {
    unitPanelByUnit,
    housePanel: service.housePanel,
    evPanel,
    pvCombiner: pvEquip.combiner,
    elevators: arch.elevators.length,
  }, loads);

  // ---- elements + patterns ------------------------------------------------
  emitElements(ec);
  recordPatterns(ec, {
    unitCtxs, loads, unitPanelByUnit, service, floorBoards, egress, site, ev, pv, trays, risers,
    corridorByStorey, serviceAmps, connectedVa, demandVa, factor,
  });

  const counts = countDevices(ec);
  const interiorArea = arch.rooms.filter(r => !OUTDOOR_ROOMS[r.type]).reduce((a, r) => a + r.area, 0);
  const interiorWatts = ec.devices
    .filter(d => isInteriorLight(d))
    .reduce((a, d) => a + (d.watts ?? 0), 0);

  const model: ElecModel = {
    service: { voltage: region.service, amps: serviceAmps, phases: region.phases },
    panels: ec.panels,
    devices: ec.devices,
    circuits: ec.circuits,
    trays: ec.trays,
    risers: ec.risers,
    pv: pv.panelRects.length > 0 ? { panelRects: pv.panelRects, kwDc: pv.kwDc } : undefined,
    loads: {
      connectedVa,
      demandVa,
      perUnitVa: units > 0 ? Math.round(unitDemand / units) : 0,
    },
    elements: ec.elements,
    patterns: ec.patterns,
    derived: {
      connectedVa,
      demandVa,
      perUnitVa: units > 0 ? Math.round(unitDemand / units) : 0,
      perUnitConnectedVa: units > 0 ? Math.round(unitConnected / units) : 0,
      serviceAmps,
      serviceCalcAmps: Math.round(calcAmps),
      serviceVoltageIndex: region.serviceVoltageIndex,
      servicePhases: region.phases,
      multifamilyDemandFactor: factor,
      houseVa: house.totalVa,
      receptacleCount: counts.receptacle,
      gfciCount: counts.gfci,
      lightCount: counts.light,
      switchCount: counts.switch,
      smokeAlarms: counts['smoke-alarm'],
      coAlarms: counts['co-alarm'],
      heatDetectors: counts['heat-detector'],
      exitSigns: counts['exit-sign'],
      emergencyLights: counts['light-emergency'],
      dataOutlets: counts['data-outlet'] + counts['tv-outlet'],
      thermostats: counts.thermostat,
      disconnects: counts.disconnect,
      panelCount: ec.panels.length,
      unitPanelCount: unitPanelByUnit.size,
      floorBoardCount: floorBoards.length,
      meterCount: units,
      circuitCount: ec.circuits.length,
      trayLengthM: round1(trays.trayLengthM),
      riserLengthM: round1(risers.lengthM),
      conduitLengthM: round1(feederLength + service.lateralLengthM),
      evChargers: ev.chargers,
      pvKwDc: pv.kwDc,
      pvPanels: pv.panelRects.length,
      pvZoneCoverage: round2(pv.coverage),
      lightingPowerDensityWPerM2: interiorArea > 0 ? round2(interiorWatts / interiorArea) : 0,
      devicesPerUnit: units > 0 ? Math.round(ec.devices.filter(d => d.unitId).length / units) : 0,
      deviceCount: ec.devices.length,
      elementCount: ec.elements.length,
      exteriorLights: site.exterior,
      bollards: site.bollards,
      poles: site.poles,
    },
  };
  return model;
}

// ----------------------------------------------------------------------------
// Unit contexts and loads
// ----------------------------------------------------------------------------

function buildUnitContexts(ec: ElecCtx): UnitContext[] {
  const out: UnitContext[] = [];
  for (const unit of ec.arch.units) {
    const rooms: RoomDef[] = [];
    for (const id of unit.roomIds) {
      const r = ec.roomById.get(id);
      if (r) rooms.push(r);
    }
    if (rooms.length === 0) {
      for (const r of ec.arch.rooms) if (r.unitId === unit.id) rooms.push(r);
    }
    const furniture = rooms.flatMap(r => ec.furnByRoom.get(r.id) ?? []);
    const hasGarage = rooms.some(r => r.type === 'garage');
    const fuel = (ec.ctx.plumb?.pipes ?? []).some(p => p.system === 'gas' && p.unitId === unit.id)
      || (ec.ctx.mech?.equipment ?? []).some(e => e.unitId === unit.id && (e.type === 'boiler' || e.type === 'heat-interface-unit'));
    out.push({
      unit,
      storey: unit.storeys[0] ?? rooms[0]?.storey ?? ec.storeys[0]?.id ?? 'L01',
      rooms,
      roomById: new Map(rooms.map(r => [r.id, r])),
      furniture,
      entryDoor: ec.doorById.get(unit.entryDoorId) ?? null,
      hasGarage,
      hasEv: hasGarage,
      fuelAppliance: fuel || hasGarage,
      areaM2: unit.area > 0 ? unit.area : rooms.reduce((a, r) => a + r.area, 0),
    });
  }
  return out;
}

const NAMEPLATE_WANTS: Partial<Record<Circuit['type'], string>> = {
  range: 'range',
  dryer: 'dryer',
  dishwasher: 'dishwasher',
  refrigerator: 'fridge',
  disposal: 'disposal',
  'water-heater': 'waterHeater',
};

function computeUnitLoad(ec: ElecCtx, uc: UnitContext, equipment: { unitId?: string; va: number; kind: string }[]): UnitLoad {
  const appliances: Record<string, number> = {};
  let hvacVa = 0;
  let evVa = 0;
  for (const d of ec.devices) {
    if (d.unitId !== uc.unit.id) continue;
    const x = extraOf(ec, d.id);
    if (!x.want) continue;
    const key = NAMEPLATE_WANTS[x.want];
    if (key) appliances[key] = Math.max(appliances[key] ?? 0, x.va);
    else if (x.want === 'hvac') hvacVa += x.va;
    else if (x.want === 'ev') evVa += x.va;
  }
  if (hvacVa === 0) {
    const fromMech = equipment.filter(e => e.unitId === uc.unit.id).reduce((a, e) => a + e.va, 0);
    hvacVa = fromMech > 0 ? fromMech : 3500;
  }
  const hasLaundry = uc.rooms.some(r => r.type === 'laundry' || r.type === 'utility')
    || uc.furniture.some(f => f.type === 'washer' || f.type === 'dryer');
  return unitLoad({
    unitId: uc.unit.id,
    areaM2: uc.areaM2,
    bedrooms: uc.unit.bedrooms,
    appliances,
    hvacVa,
    evVa,
    hasLaundry,
  }, ec.region);
}

function sumCorridorArea(ec: ElecCtx): number {
  let a = 0;
  for (const r of ec.arch.rooms) if (r.type === 'corridor') a += r.area;
  return a;
}

function frameFor(amps: number): number {
  for (const f of UNIT_PANEL_FRAMES) if (amps <= f) return f;
  return UNIT_PANEL_FRAMES[UNIT_PANEL_FRAMES.length - 1];
}

// ----------------------------------------------------------------------------
// Counting / reporting
// ----------------------------------------------------------------------------

interface DeviceCounts {
  receptacle: number;
  gfci: number;
  light: number;
  switch: number;
  'smoke-alarm': number;
  'co-alarm': number;
  'heat-detector': number;
  'exit-sign': number;
  'light-emergency': number;
  'data-outlet': number;
  'tv-outlet': number;
  thermostat: number;
  disconnect: number;
}

function countDevices(ec: ElecCtx): DeviceCounts {
  const c: DeviceCounts = {
    receptacle: 0, gfci: 0, light: 0, switch: 0, 'smoke-alarm': 0, 'co-alarm': 0,
    'heat-detector': 0, 'exit-sign': 0, 'light-emergency': 0, 'data-outlet': 0, 'tv-outlet': 0,
    thermostat: 0, disconnect: 0,
  };
  for (const d of ec.devices) {
    switch (d.type) {
      case 'receptacle': case 'range-receptacle': case 'dryer-receptacle': c.receptacle++; break;
      case 'gfci-receptacle': c.receptacle++; c.gfci++; break;
      case 'switch': case 'dimmer': c.switch++; break;
      case 'smoke-alarm': c['smoke-alarm']++; break;
      case 'co-alarm': c['co-alarm']++; break;
      case 'heat-detector': c['heat-detector']++; break;
      case 'exit-sign': c['exit-sign']++; break;
      case 'light-emergency': c['light-emergency']++; break;
      case 'data-outlet': c['data-outlet']++; break;
      case 'tv-outlet': c['tv-outlet']++; break;
      case 'thermostat': c.thermostat++; break;
      case 'disconnect': c.disconnect++; break;
      default:
        if (d.type.startsWith('light-')) c.light++;
        break;
    }
  }
  return c;
}

function isInteriorLight(d: ElecDevice): boolean {
  if (!d.type.startsWith('light-')) return false;
  return d.type !== 'light-exterior' && d.type !== 'light-bollard' && d.type !== 'light-pole';
}

interface PatternInputs {
  unitCtxs: UnitContext[];
  loads: Map<string, UnitLoad>;
  unitPanelByUnit: Map<string, ElecPanel>;
  service: { switchboard: ElecPanel | null; housePanel: ElecPanel | null; meters: ElecPanel[]; transformer: boolean; lateralLengthM: number };
  floorBoards: ElecPanel[];
  egress: { signs: number; emergency: number };
  site: { exterior: number; bollards: number; poles: number };
  ev: { chargers: number };
  pv: { panelRects: { x: number; y: number; w: number; h: number }[]; kwDc: number; coverage: number };
  trays: { trayLengthM: number };
  risers: { risers: unknown[]; lengthM: number };
  corridorByStorey: Map<string, { corridorLength: number; fixtures: string[] }>;
  serviceAmps: number;
  connectedVa: number;
  demandVa: number;
  factor: number;
}

function recordPatterns(ec: ElecCtx, p: PatternInputs): void {
  const byUnit = new Map<string, ElecDevice[]>();
  for (const d of ec.devices) {
    if (!d.unitId) continue;
    const a = byUnit.get(d.unitId);
    if (a) a.push(d);
    else byUnit.set(d.unitId, [d]);
  }
  ec.patterns.push({
    patternId: 'ELE-01',
    storey: p.service.switchboard?.storey,
    elementIds: [
      ...(p.service.switchboard ? [p.service.switchboard.id] : []),
      ...p.service.meters.map(m => m.id),
      ...(p.service.housePanel ? [p.service.housePanel.id] : []),
    ],
    params: {
      serviceAmps: p.serviceAmps,
      serviceVoltage: ec.region.service,
      meterBanks: p.service.meters.length,
      lateralLengthM: round1(p.service.lateralLengthM),
      transformer: p.service.transformer,
    },
    note: `${ec.region.code} service entrance; ${p.service.meters.length} meter bank(s) of up to 6`,
  });
  for (const uc of p.unitCtxs) {
    const panel = p.unitPanelByUnit.get(uc.unit.id);
    const load = p.loads.get(uc.unit.id);
    const devices = byUnit.get(uc.unit.id) ?? [];
    if (panel) {
      ec.patterns.push({
        patternId: 'ELE-02',
        storey: panel.storey,
        unitId: uc.unit.id,
        elementIds: [panel.id],
        params: {
          amps: panel.amps,
          room: panel.roomId ?? '',
          roomType: panel.roomId ? ec.roomById.get(panel.roomId)?.type ?? '' : '',
          bottomHeight: 1.2,
        },
      });
    }
    const receptacles = devices.filter(d => d.type === 'receptacle' || d.type === 'gfci-receptacle');
    ec.patterns.push({
      patternId: 'ELE-03',
      storey: uc.storey,
      unitId: uc.unit.id,
      elementIds: receptacles.map(d => d.id),
      params: {
        receptacles: receptacles.length,
        maxSpacing: ec.region.maxReceptacleSpacing,
        maxReach: ec.region.maxReceptacleReach,
        detail: ec.detail,
        habitableRooms: uc.rooms.filter(r => r.type === 'bedroom' || r.type === 'living' || r.type === 'living-kitchen' || r.type === 'master-bedroom').length,
      },
    });
    const kitchen = uc.rooms.find(r => r.id === uc.unit.kitchenRoomId) ?? uc.rooms.find(r => r.type === 'kitchen' || r.type === 'living-kitchen');
    if (kitchen) {
      const counter = devices.filter(d => d.roomId === kitchen.id && d.type === 'gfci-receptacle');
      ec.patterns.push({
        patternId: 'ELE-04',
        storey: uc.storey,
        unitId: uc.unit.id,
        elementIds: counter.map(d => d.id),
        params: {
          counterReceptacles: counter.length,
          spacing: ec.region.counterSpacing,
          smallApplianceCircuits: ec.region.smallApplianceCircuits,
          rangeVa: load?.appliances.range ?? 0,
        },
      });
    }
    const switches = devices.filter(d => d.type === 'switch' || d.type === 'dimmer');
    ec.patterns.push({
      patternId: 'ELE-05',
      storey: uc.storey,
      unitId: uc.unit.id,
      elementIds: switches.map(d => d.id),
      params: { switches: switches.length, offset: 0.15, height: 1.2 },
    });
    const alarms = devices.filter(d => d.type === 'smoke-alarm' || d.type === 'co-alarm');
    ec.patterns.push({
      patternId: 'ELE-06',
      storey: uc.storey,
      unitId: uc.unit.id,
      elementIds: alarms.map(d => d.id),
      params: {
        smokeAlarms: alarms.filter(d => d.type === 'smoke-alarm').length,
        coAlarms: alarms.filter(d => d.type === 'co-alarm').length,
        bedrooms: uc.unit.bedrooms,
        trigger: uc.fuelAppliance ? 'fuel appliance or garage' : 'baseline',
      },
    });
    const lights = devices.filter(d => d.type.startsWith('light-'));
    ec.patterns.push({
      patternId: 'ELE-13',
      storey: uc.storey,
      unitId: uc.unit.id,
      elementIds: lights.map(d => d.id),
      params: {
        fixtures: lights.length,
        watts: lights.reduce((a, d) => a + (d.watts ?? 0), 0),
        areaM2: round1(uc.areaM2),
        wPerM2: uc.areaM2 > 0 ? round2(lights.reduce((a, d) => a + (d.watts ?? 0), 0) / uc.areaM2) : 0,
      },
    });
  }
  for (const st of ec.storeys) {
    const corridor = p.corridorByStorey.get(st.id);
    const trays = ec.trays.filter(t => t.storey === st.id);
    if (trays.length > 0) {
      ec.patterns.push({
        patternId: 'ELE-07',
        storey: st.id,
        elementIds: ec.runs.filter(r => r.storey === st.id && r.patterns.includes('ELE-07')).map(r => r.id),
        params: {
          trays: trays.length,
          lateralOffset: 0.35,
          trayZ: round2(trays[0].path[0]?.[2] ?? 0),
          corridorLengthM: round1(corridor?.corridorLength ?? 0),
        },
      });
    }
    const emergency = ec.devices.filter(d => d.storey === st.id && (d.type === 'exit-sign' || d.type === 'light-emergency'));
    if (emergency.length > 0) {
      ec.patterns.push({
        patternId: 'ELE-08',
        storey: st.id,
        elementIds: emergency.map(d => d.id),
        params: {
          exitSigns: emergency.filter(d => d.type === 'exit-sign').length,
          emergencyLights: emergency.filter(d => d.type === 'light-emergency').length,
          spacing: 15,
          autonomyMin: 90,
        },
      });
    }
    const riserRuns = ec.runs.filter(r => r.storey === st.id && r.patterns.includes('ELE-12'));
    if (riserRuns.length > 0) {
      ec.patterns.push({
        patternId: 'ELE-12',
        storey: st.id,
        elementIds: riserRuns.map(r => r.id),
        params: { risers: riserRuns.length, type: ec.storeys.length > 6 ? 'busduct' : 'cable-riser', cornerOffset: 0.15 },
      });
    }
  }
  if (p.pv.panelRects.length > 0) {
    ec.patterns.push({
      patternId: 'ELE-09',
      storey: 'ROOF',
      elementIds: ec.devices.filter(d => d.type === 'pv-panel').map(d => d.id),
      params: {
        panels: p.pv.panelRects.length,
        kwDc: p.pv.kwDc,
        coverage: round2(p.pv.coverage),
        rowGap: 0.5,
      },
    });
  }
  if (p.ev.chargers > 0) {
    ec.patterns.push({
      patternId: 'ELE-10',
      elementIds: ec.devices.filter(d => d.type === 'ev-charger').map(d => d.id),
      params: { chargers: p.ev.chargers, kwEach: 7.2, diversity: 0.5 },
    });
  }
  ec.patterns.push({
    patternId: 'ELE-11',
    elementIds: [],
    params: {
      units: p.unitCtxs.length,
      connectedVa: p.connectedVa,
      demandVa: p.demandVa,
      demandFactor: p.factor,
      serviceAmps: p.serviceAmps,
      serviceVoltage: ec.region.service,
      method: ec.region.ring ? 'BS 7671 App. A diversity' : 'NEC 220.82 / 220.84',
    },
  });
}

// ----------------------------------------------------------------------------

function emptyModel(ctx: GenContext): ElecModel {
  const region = elecRegion(ctx.spec.region, 0);
  const elements: ModelElement[] = [];
  const patterns: PatternApplication[] = [];
  return {
    service: { voltage: region.service, amps: 0, phases: region.phases },
    panels: [], devices: [], circuits: [], trays: [], risers: [],
    loads: { connectedVa: 0, demandVa: 0, perUnitVa: 0 },
    elements, patterns, derived: {},
  };
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Re-exported for the metrics module: area of a unit polygon when `area` is missing */
export function unitArea(u: UnitInstance): number {
  return u.area > 0 ? u.area : polygonArea(u.polygon);
}
