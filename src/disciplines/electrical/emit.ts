/**
 * ModelElement emission. Anchors (see internal.ts) become `box` geometry; tray / conduit /
 * busduct runs become `axis` geometry. Every element carries a Forma_Electrical pset, the
 * discipline colour, an MEP system id and the pattern ids that produced it.
 */
import type {
  Circuit, ElecDevice, ElecPanel, ModelElement, PropertySetDef, Vec3,
} from '../../core/types.ts';
import { systemId } from '../../core/ids.ts';
import { DEVICE_SPEC, PANEL_SPEC, type MountMode } from './catalog.ts';
import { extraOf, round3, type ElecCtx } from './internal.ts';

function boxFromAnchor(anchor: Vec3, rotation: number, w: number, d: number, h: number, mount: MountMode): Vec3 {
  const c = Math.cos(rotation);
  const s = Math.sin(rotation);
  if (mount === 'wall') {
    return [round3(anchor[0] - (c * w) / 2), round3(anchor[1] - (s * w) / 2), round3(anchor[2] - h / 2)];
  }
  const x = anchor[0] - (c * w - s * d) / 2;
  const y = anchor[1] - (s * w + c * d) / 2;
  const z = mount === 'ceiling' ? anchor[2] - h : mount === 'center' ? anchor[2] - h / 2 : anchor[2];
  return [round3(x), round3(y), round3(z)];
}

/** Exposed for tests: the geometric centre of a device's box */
export function deviceBoxCenter(dev: ElecDevice): Vec3 {
  const spec = DEVICE_SPEC[dev.type];
  const p = boxFromAnchor(dev.position, dev.rotation, spec.w, spec.d, spec.h, spec.mount);
  const c = Math.cos(dev.rotation);
  const s = Math.sin(dev.rotation);
  return [
    p[0] + (c * spec.w - s * spec.d) / 2,
    p[1] + (s * spec.w + c * spec.d) / 2,
    p[2] + spec.h / 2,
  ];
}

const MOUNTING_TYPE: Partial<Record<string, string>> = {
  'light-ceiling': 'SURFACE',
  'light-recessed': 'RECESSED',
  'light-pendant': 'SUSPENDED',
  'light-wall': 'SURFACE',
  'light-vanity': 'SURFACE',
  'light-under-cabinet': 'SURFACE',
  'light-emergency': 'SURFACE',
  'exit-sign': 'SURFACE',
  'light-exterior': 'SURFACE',
  'light-bollard': 'POLE',
  'light-pole': 'POLE',
};

export function emitElements(ec: ElecCtx): void {
  const circuitByDevice = new Map<string, Circuit>();
  for (const c of ec.circuits) for (const id of c.deviceIds) circuitByDevice.set(id, c);
  const panelById = new Map(ec.panels.map(p => [p.id, p] as const));

  for (const dev of ec.devices) {
    const spec = DEVICE_SPEC[dev.type];
    const extra = extraOf(ec, dev.id);
    const circuit = circuitByDevice.get(dev.id);
    const panel = circuit ? panelById.get(circuit.panelId) : undefined;
    const psets: PropertySetDef[] = [{
      name: 'Forma_Electrical',
      properties: [
        { name: 'Circuit', value: circuit?.id ?? '' },
        { name: 'Panel', value: panel?.id ?? '' },
        { name: 'Voltage', value: circuit?.voltage ?? ec.region.branchV },
        { name: 'VA', value: extra.va },
        { name: 'MountingHeight', value: round3(dev.position[2]) },
        { name: 'DeviceType', value: dev.type },
        { name: 'Code', value: ec.region.code },
      ],
    }];
    if (spec.ifcType === 'IfcOutlet') {
      psets.push({ name: 'Pset_OutletTypeCommon', properties: [{ name: 'IsPluggableOutlet', value: true }] });
    } else if (spec.ifcType === 'IfcLightFixture') {
      psets.push({
        name: 'Pset_LightFixtureTypeCommon',
        properties: [
          { name: 'NumberOfSources', value: 1 },
          { name: 'TotalWattage', value: dev.watts ?? spec.watts },
          { name: 'LightFixtureMountingType', value: MOUNTING_TYPE[dev.type] ?? 'SURFACE' },
          { name: 'MaintenanceFactor', value: 0.7 },
        ],
      });
    } else if (spec.ifcType === 'IfcSensor') {
      psets.push({
        name: 'Pset_SensorTypeCommon',
        properties: [{ name: 'Interconnected', value: true }, { name: 'BatteryBackup', value: true }],
      });
    }
    const tags: string[] = [];
    if (dev.wallId) tags.push(`wall:${dev.wallId}`);
    if (circuit) tags.push(`circuit:${circuit.id}`);
    ec.elements.push({
      id: dev.id,
      discipline: 'electrical',
      ifcType: spec.ifcType,
      predefinedType: spec.predefinedType,
      name: extra.name || spec.name,
      objectType: spec.objectType,
      description: extra.note,
      storey: dev.storey,
      geometry: {
        kind: 'box',
        position: boxFromAnchor(dev.position, dev.rotation, spec.w, spec.d, spec.h, spec.mount),
        width: spec.w,
        depth: spec.d,
        height: spec.h,
        rotation: dev.rotation,
      },
      psets,
      color: spec.color,
      system: systemId('electrical', spec.system),
      unitId: dev.unitId,
      roomId: dev.roomId,
      patterns: patternsForDevice(dev),
      tags: tags.length > 0 ? tags : undefined,
    });
  }

  for (const panel of ec.panels) {
    const spec = PANEL_SPEC[panel.type];
    const circuits = ec.circuits.filter(c => c.panelId === panel.id).length;
    ec.elements.push({
      id: panel.id,
      discipline: 'electrical',
      ifcType: spec.ifcType,
      predefinedType: spec.predefinedType,
      name: `${spec.name} (${panel.amps} A)`,
      objectType: spec.objectType,
      description: panel.type === 'unit-panel' ? `${ec.region.panelName} — ${ec.region.code}` : undefined,
      storey: panel.storey,
      geometry: {
        kind: 'box',
        position: boxFromAnchor(panel.position, panel.rotation, panel.width, panel.depth, panel.height, spec.mount),
        width: panel.width,
        depth: panel.depth,
        height: panel.height,
        rotation: panel.rotation,
      },
      psets: [
        {
          name: 'Forma_Electrical',
          properties: [
            { name: 'Circuit', value: '' },
            { name: 'Panel', value: panel.id },
            { name: 'Voltage', value: panel.voltage },
            { name: 'VA', value: Math.round(panel.amps * ec.region.branchV) },
            { name: 'MountingHeight', value: round3(spec.mount === 'wall' ? spec.bottom : 0) },
            { name: 'PanelType', value: panel.type },
            { name: 'Code', value: ec.region.code },
          ],
        },
        {
          name: 'Pset_ElectricalDeviceCommon',
          properties: [
            { name: 'RatedCurrent', value: panel.amps },
            { name: 'RatedVoltage', value: panel.voltage },
            { name: 'NumberOfCircuits', value: Math.max(circuits, panel.circuitCount) },
          ],
        },
      ],
      color: spec.color,
      system: systemId('electrical', panel.type === 'pv-combiner' ? 'PV' : panel.type === 'ev-panel' ? 'EV' : 'POWER-LV'),
      unitId: panel.unitId,
      roomId: panel.roomId,
      patterns: panel.type === 'unit-panel' ? ['ELE-02'] : panel.type === 'pv-combiner' ? ['ELE-09'] : panel.type === 'ev-panel' ? ['ELE-10'] : ['ELE-01'],
    });
  }

  for (const run of ec.runs) {
    ec.elements.push({
      id: run.id,
      discipline: 'electrical',
      ifcType: run.ifcType,
      predefinedType: run.predefinedType,
      name: run.name,
      objectType: run.objectType,
      description: run.note,
      storey: run.storey,
      geometry: { kind: 'axis', start: run.start, end: run.end, profile: run.profile },
      psets: [{
        name: 'Forma_Electrical',
        properties: [
          { name: 'Circuit', value: '' },
          { name: 'Panel', value: '' },
          { name: 'Voltage', value: ec.region.service },
          { name: 'VA', value: 0 },
          { name: 'MountingHeight', value: round3((run.start[2] + run.end[2]) / 2) },
          { name: 'Code', value: ec.region.code },
        ],
      }],
      quantities: [{ name: 'Qto_CableCarrierSegmentBaseQuantities', quantities: [{ name: 'Length', value: run.lengthM, kind: 'IfcQuantityLength' }] }],
      color: run.color,
      system: systemId('electrical', run.system),
      unitId: run.unitId,
      roomId: run.roomId,
      patterns: run.patterns,
    });
  }
}

function patternsForDevice(dev: ElecDevice): string[] {
  switch (dev.type) {
    case 'receptacle':
      return ['ELE-03'];
    case 'gfci-receptacle':
    case 'range-receptacle':
    case 'dryer-receptacle':
      return ['ELE-04'];
    case 'switch':
    case 'dimmer':
      return ['ELE-05'];
    case 'smoke-alarm':
    case 'co-alarm':
    case 'heat-detector':
      return ['ELE-06'];
    case 'light-emergency':
    case 'exit-sign':
      return ['ELE-08'];
    case 'pv-panel':
    case 'inverter':
      return ['ELE-09'];
    case 'ev-charger':
      return ['ELE-10'];
    case 'transformer':
      return ['ELE-01'];
    case 'light-ceiling':
    case 'light-recessed':
    case 'light-pendant':
    case 'light-wall':
    case 'light-vanity':
    case 'light-under-cabinet':
    case 'light-exterior':
    case 'light-bollard':
    case 'light-pole':
      return ['ELE-13'];
    default:
      return [];
  }
}

export { boxFromAnchor };
