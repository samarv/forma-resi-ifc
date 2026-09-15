/**
 * Writer tests. The discipline modules are generated in parallel with this one,
 * so the fixture is a hand-built DesignModel that exercises EVERY geometry kind
 * rather than a pipeline run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildStoreys, normalizeSpec } from '../core/spec.ts';
import { getTypology } from '../core/typologies.ts';
import type {
  ArchModel, BuildingSpec, DesignModel, ModelElement, SiteModel, StoreyDef, StructModel,
} from '../core/types.ts';
import { boxFootprint, boxPlacement, systemClassification, writeIfc } from './writer.ts';
import { validateStep } from './validate.ts';

// ============================================================================
// Fixture
// ============================================================================

function syntheticElements(): ModelElement[] {
  const elements: ModelElement[] = [
    // --- walls (hosts) -----------------------------------------------------
    {
      id: 'ARC-L01-WALL-001', discipline: 'architecture', ifcType: 'IfcWall', name: 'External wall',
      storey: 'L01', predefinedType: 'STANDARD',
      geometry: { kind: 'wall', start: [0, 0, 0], end: [8, 0, 0], thickness: 0.3, height: 3 },
      psets: [{ name: 'Pset_WallCommon', properties: [{ name: 'IsExternal', value: true }, { name: 'ThermalTransmittance', value: 0.18 }] }],
      quantities: [{ name: 'Qto_WallBaseQuantities', quantities: [{ name: 'Length', value: 8, kind: 'IfcQuantityLength' }, { name: 'GrossSideArea', value: 24, kind: 'IfcQuantityArea' }] }],
      material: { name: 'Timber frame wall', layers: [{ name: 'Gypsum', thickness: 0.013 }, { name: 'Timber stud + insulation', thickness: 0.14 }, { name: 'Brick', thickness: 0.1 }] },
      color: [0.85, 0.83, 0.78], patterns: ['ARC-01', 'XD-01'], unitId: 'U-L01-01',
    },
    {
      id: 'ARC-L01-WALL-002', discipline: 'architecture', ifcType: 'IfcWall', name: 'Party wall with opening',
      storey: 'L01',
      geometry: {
        kind: 'wall', start: [0, 0, 0], end: [0, 9, 0], thickness: 0.25, height: 3,
        openings: [{ name: 'Service penetration', width: 0.6, height: 0.6, position: [4, 0, 2.2] }],
      },
      patterns: ['ARC-02'],
    },
    // --- slab with an opening ---------------------------------------------
    {
      id: 'ARC-L01-SLAB-001', discipline: 'architecture', ifcType: 'IfcSlab', name: 'Floor slab',
      storey: 'L01', predefinedType: 'FLOOR',
      geometry: {
        kind: 'slab', position: [0, 0, -0.25], thickness: 0.25,
        profile: [[0, 0], [24, 0], [24, 14], [0, 14]],
        openings: [{ name: 'Stair void', width: 3, height: 5, position: [12, 7, 0] }],
      },
      material: { name: 'Concrete C30/37', category: 'Structural' },
      color: [0.6, 0.6, 0.62],
    },
    // --- columns -----------------------------------------------------------
    {
      id: 'STR-L01-COL-001', discipline: 'structure', ifcType: 'IfcColumn', name: 'RC column',
      storey: 'L01', predefinedType: 'COLUMN',
      geometry: { kind: 'column', position: [6, 6, 0], width: 0.4, depth: 0.4, height: 3 },
      psets: [{ name: 'Pset_ColumnCommon', properties: [{ name: 'LoadBearing', value: true }, { name: 'Reference', value: 'C1' }] }],
    },
    {
      id: 'STR-L01-COL-002', discipline: 'structure', ifcType: 'IfcColumn', name: 'Circular column',
      storey: 'L01',
      geometry: { kind: 'column', position: [12, 6, 0], width: 0.5, depth: 0.5, height: 3, shape: 'circle' },
    },
    // --- beam --------------------------------------------------------------
    {
      id: 'STR-L01-BEAM-001', discipline: 'structure', ifcType: 'IfcBeam', name: 'Transfer beam',
      storey: 'L01',
      geometry: { kind: 'beam', start: [6, 6, 2.7], end: [12, 6, 2.7], width: 0.4, depth: 0, height: 0.6 } as ModelElement['geometry'],
    },
    // --- boxes -------------------------------------------------------------
    {
      id: 'ARC-L01-FURN-001', discipline: 'architecture', ifcType: 'IfcFurnishingElement', name: 'Double bed',
      storey: 'L01', unitId: 'U-L01-01', roomId: 'R-U-L01-01-BED1',
      geometry: { kind: 'box', position: [3, 2, 0], width: 1.5, depth: 2, height: 0.55, rotation: Math.PI / 2 },
      color: [0.4, 0.3, 0.25],
    },
    {
      id: 'ELE-L01-PNL-001', discipline: 'electrical', ifcType: 'IfcElectricDistributionBoard', name: 'Unit panel',
      storey: 'L01', unitId: 'U-L01-01', system: 'SYS-ELE-POWER', predefinedType: 'CONSUMERUNIT',
      geometry: { kind: 'box', position: [1, 0.3, 1.2], width: 0.4, depth: 0.12, height: 0.6, rotation: 0.3 },
      psets: [{ name: 'Forma_Electrical', properties: [{ name: 'Amps', value: 100 }, { name: 'Voltage', value: '120/240V' }] }],
    },
    // --- prisms ------------------------------------------------------------
    {
      id: 'ARC-L01-SPACE-001', discipline: 'architecture', ifcType: 'IfcSpace', name: 'Living / kitchen',
      storey: 'L01', unitId: 'U-L01-01', roomId: 'R-U-L01-01-LIVINGKITCHEN1',
      description: 'Living / kitchen', predefinedType: 'SPACE',
      geometry: { kind: 'prism', position: [0.15, 0.15, 0], profile: [[0, 0], [5, 0], [5, 4], [0, 4]], height: 2.7 },
      quantities: [{ name: 'Qto_SpaceBaseQuantities', quantities: [{ name: 'NetFloorArea', value: 20, kind: 'IfcQuantityArea' }] }],
    },
    {
      id: 'ARC-L01-SPACE-002', discipline: 'architecture', ifcType: 'IfcSpace', name: 'Bedroom 1',
      storey: 'L01', unitId: 'U-L01-01', roomId: 'R-U-L01-01-BED1',
      geometry: { kind: 'prism', position: [5.3, 0.15, 0], profile: [[0, 0], [3.4, 0], [3.4, 4], [0, 4]], height: 2.7 },
    },
    {
      id: 'ARC-L01-SPACE-003', discipline: 'architecture', ifcType: 'IfcSpace', name: 'Corridor',
      storey: 'L01', predefinedType: 'INTERNAL',
      geometry: { kind: 'prism', position: [0.15, 4.3, 0], profile: [[0, 0], [23, 0], [23, 1.5], [0, 1.5]], height: 2.7 },
    },
    {
      id: 'SIT-SITE-PAD-001', discipline: 'site', ifcType: 'IfcBuildingElementProxy', name: 'Transformer pad',
      storey: 'SITE',
      geometry: { kind: 'prism', position: [20, 2, 0], profile: [[0, 0], [3, 0], [3, 2.5], [0, 2.5]], height: 0.2 },
    },
    {
      id: 'SIT-SITE-TREE-001', discipline: 'site', ifcType: 'IfcGeographicElement', name: 'Street tree',
      storey: 'SITE', predefinedType: 'VEGETATION',
      geometry: { kind: 'prism', position: [4, 1, 0], profile: [[0, 0], [1.2, 0], [1.2, 1.2], [0, 1.2]], height: 6 },
      color: [0.25, 0.5, 0.2],
    },
    // --- axis (MEP) --------------------------------------------------------
    {
      id: 'PLB-L01-PIPE-001', discipline: 'plumbing', ifcType: 'IfcPipeSegment', name: 'DCW branch',
      storey: 'L01', system: 'SYS-PLB-DCW', predefinedType: 'RIGIDSEGMENT', unitId: 'U-L01-01',
      geometry: { kind: 'axis', start: [1, 1, 2.6], end: [6, 1, 2.6], profile: { type: 'circle', radius: 0.0125 } },
      color: [0.2, 0.4, 0.9],
    },
    {
      id: 'PLB-L01-PIPE-002', discipline: 'plumbing', ifcType: 'IfcPipeSegment', name: 'DCW riser drop',
      storey: 'L01', system: 'SYS-PLB-DCW', predefinedType: 'RIGIDSEGMENT',
      geometry: { kind: 'axis', start: [1, 1, 0], end: [1, 1, 2.6], profile: { type: 'circle', radius: 0.0125 } },
    },
    {
      id: 'MEC-L01-DUCT-001', discipline: 'mechanical', ifcType: 'IfcDuctSegment', name: 'Supply duct',
      storey: 'L01', system: 'SYS-MEC-SUPPLY', predefinedType: 'RIGIDSEGMENT',
      geometry: { kind: 'axis', start: [2, 5, 2.55], end: [14, 5, 2.55], profile: { type: 'rect', width: 0.3, height: 0.2 } },
    },
    // --- stair, hosted openings, foundations, roofs, railing, ramp --------
    {
      id: 'ARC-L01-STAIR-001', discipline: 'architecture', ifcType: 'IfcStair', name: 'Egress stair',
      storey: 'L01',
      geometry: { kind: 'stair', position: [12, 7, 0], direction: Math.PI / 2, risers: 17, riserHeight: 0.176, tread: 0.28, width: 1.1 },
    },
    {
      id: 'ARC-L01-DOOR-001', discipline: 'architecture', ifcType: 'IfcDoor', name: 'Unit entry door',
      storey: 'L01', unitId: 'U-L01-01', predefinedType: 'DOOR',
      geometry: { kind: 'door-in-wall', hostId: 'ARC-L01-WALL-001', along: 2, width: 0.9, height: 2.1, operation: 'single-swing-left' },
      psets: [{ name: 'Pset_DoorCommon', properties: [{ name: 'FireRating', value: 'FD30S' }, { name: 'IsExternal', value: false }] }],
    },
    {
      id: 'ARC-L01-WIN-001', discipline: 'architecture', ifcType: 'IfcWindow', name: 'Living room window',
      storey: 'L01', unitId: 'U-L01-01',
      geometry: { kind: 'window-in-wall', hostId: 'ARC-L01-WALL-001', along: 5.5, sill: 0.9, width: 1.8, height: 1.5 },
    },
    {
      id: 'ARC-L01-WIN-002', discipline: 'architecture', ifcType: 'IfcWindow', name: 'Orphan window',
      storey: 'L01',
      geometry: { kind: 'window-in-wall', hostId: 'ARC-L01-WALL-404', along: 1, sill: 0.9, width: 1, height: 1.2 },
    },
    {
      id: 'STR-FND-FTG-001', discipline: 'structure', ifcType: 'IfcFooting', name: 'Pad footing',
      storey: 'FND',
      geometry: { kind: 'footing', position: [6, 6, 0], width: 1.8, depth: 1.8, height: 0.6, footingType: 'PAD_FOOTING' },
    },
    {
      id: 'STR-FND-PILE-001', discipline: 'structure', ifcType: 'IfcPile', name: 'Bored pile',
      storey: 'FND',
      geometry: { kind: 'pile', position: [12, 6, 0], diameter: 0.45, length: 12 },
    },
    {
      id: 'ARC-ROOF-ROOF-001', discipline: 'architecture', ifcType: 'IfcRoof', name: 'Flat roof',
      storey: 'ROOF', predefinedType: 'FLAT_ROOF',
      geometry: { kind: 'roof', position: [0, 0, 0], width: 24, depth: 14, thickness: 0.35, slope: 0.02 },
    },
    {
      id: 'ARC-ROOF-ROOF-002', discipline: 'architecture', ifcType: 'IfcRoof', name: 'Gable roof',
      storey: 'ROOF', predefinedType: 'GABLE_ROOF',
      geometry: { kind: 'gable-roof', position: [26, 0, 0], width: 10, depth: 8, thickness: 0.3, slope: 30 * Math.PI / 180, overhang: 0.4 },
    },
    {
      id: 'ARC-ROOF-RAIL-001', discipline: 'architecture', ifcType: 'IfcRailing', name: 'Roof guardrail',
      storey: 'ROOF', predefinedType: 'GUARDRAIL',
      geometry: { kind: 'railing', start: [0, 0, 0], end: [24, 0, 0], height: 1.1, width: 0.05 },
    },
    {
      id: 'SIT-SITE-RAMP-001', discipline: 'site', ifcType: 'IfcRamp', name: 'Accessible ramp',
      storey: 'SITE',
      geometry: { kind: 'ramp', position: [2, 1, 0], width: 1.5, length: 6, thickness: 0.2, rise: 0.5 },
    },
    // --- wall/beam kinds whose ifcType overrides the default entity -------
    {
      id: 'ARC-L01-CW-001', discipline: 'architecture', ifcType: 'IfcCurtainWall', name: 'Podium glazing',
      storey: 'L01',
      geometry: { kind: 'wall', start: [8, 0, 0], end: [16, 0, 0], thickness: 0.08, height: 3 },
    },
    {
      id: 'STR-L01-BRC-001', discipline: 'structure', ifcType: 'IfcMember', name: 'Brace',
      storey: 'L01',
      geometry: { kind: 'beam', start: [0, 0, 0], end: [3, 0, 3], width: 0.1, height: 0.1 },
    },
    // --- deliberately broken ---------------------------------------------
    {
      id: 'STR-L01-COL-BAD', discipline: 'structure', ifcType: 'IfcColumn', name: 'Column with NaN',
      storey: 'L01',
      geometry: { kind: 'column', position: [Number.NaN, 6, 0], width: 0.4, depth: 0.4, height: 3 },
    },
    {
      id: 'STR-L01-BEAM-BAD', discipline: 'structure', ifcType: 'IfcBeam', name: 'Zero-length beam',
      storey: 'L01',
      geometry: { kind: 'beam', start: [2, 2, 2.7], end: [2, 2, 2.7], width: 0.2, height: 0.3 },
    },
  ];
  return elements;
}

function syntheticModel(overrides: Partial<DesignModel> = {}): DesignModel {
  const spec: BuildingSpec = normalizeSpec({
    name: 'Writer Test Block',
    seed: 99,
    region: 'UK',
    displayUnits: 'metric',
    typology: 'corridor-midrise',
    site: { width: 40, depth: 24 },
    massing: { storeys: 2 },
  });
  const typology = getTypology(spec.typology);
  const storeys: StoreyDef[] = buildStoreys(spec, spec.floors);

  const site: SiteModel = {
    boundary: [[0, 0], [40, 0], [40, 24], [0, 24]],
    area: 960,
    buildableEnvelope: [[3, 6], [37, 6], [37, 18], [3, 18]],
    setbacks: { front: 6, side: 3, rear: 6 },
    streetFacing: 'S',
    northRad: 0,
    massing: {
      shape: 'bar',
      footprint: [[0, 0], [24, 0], [24, 14], [0, 14]],
      footprintArea: 336,
      bars: [],
      storeys,
      heightAboveGrade: 7,
      gfa: 672,
      cores: [],
      corridors: [],
      roof: { type: 'flat', pitchRad: 0, parapetHeight: 1.1, ridgeAxis: 'x' },
    },
    parking: {
      type: 'surface',
      spaces: [{ id: 'SIT-SITE-PRK-001', rect: { x: 30, y: 2, w: 2.5, h: 5 }, rotation: 0, type: 'standard', storey: 'SITE' }],
      aisles: [],
      bikeSpaces: 4,
      storey: 'SITE',
    },
    landscape: [{ id: 'SIT-LZ-001', type: 'communal-garden', polygon: [[0, 16], [24, 16], [24, 24], [0, 24]], area: 192 }],
    paths: [],
    driveway: null,
    entrances: [],
    elements: [],
    patterns: [],
    derived: {},
  };

  const arch: ArchModel = {
    storeys,
    floors: [{
      storey: 'L01', use: 'residential',
      outline: [[0, 0], [24, 0], [24, 14], [0, 14]], area: 336,
      floorToFloor: 3, ceilingHeight: 2.7, slabThickness: 0.25,
      corridors: [], unitIds: ['U-L01-01'], roomIds: [], commonRoomIds: [], wallIds: [], exteriorWallIds: [],
      balconies: [], wwr: 0.35,
    }],
    units: [{
      id: 'U-L01-01', templateId: '2b1b', storeys: ['L01'],
      rect: { x: 0, y: 0, w: 9, h: 8 }, polygon: [[0, 0], [9, 0], [9, 8], [0, 8]],
      area: 72, bedrooms: 2, bathrooms: 1, occupants: 3, aspect: 'dual', accessSide: 'rear',
      entryDoorId: 'ARC-L01-DOOR-001', roomIds: [], wetWallIds: [], bathroomRoomIds: [],
    }],
    rooms: [],
    walls: [
      { id: 'ARC-L01-WALL-001', storey: 'L01', start: [0, 0], end: [8, 0], thickness: 0.3, height: 3, type: 'exterior', isExternal: true, loadBearingHint: true },
      { id: 'ARC-L01-WALL-002', storey: 'L01', start: [0, 0], end: [0, 9], thickness: 0.25, height: 3, type: 'party', isExternal: false, loadBearingHint: true },
    ],
    doors: [],
    windows: [{ id: 'ARC-L01-WIN-001', storey: 'L01', wallId: 'ARC-L01-WALL-001', along: 5.5, sill: 0.9, width: 1.8, height: 1.5, roomId: 'R-U-L01-01-LIVINGKITCHEN1' }],
    furniture: [],
    cores: [],
    stairs: [],
    elevators: [],
    shafts: [],
    roof: { type: 'flat', outline: [[0, 0], [24, 0], [24, 14], [0, 14]], thickness: 0.35, pitchRad: 0, ridgeAxis: 'x', parapetHeight: 1.1 },
    templatesUsed: ['2b1b'],
    elements: [],
    patterns: [],
    derived: {},
  };

  const struct: StructModel = {
    system: 'rc-flat-slab',
    foundation: 'pad-footing',
    grid: [],
    columns: [],
    beams: [],
    // Structure claims the architecture wall as load bearing.
    walls: [{ id: 'STR-L01-WALL-001', storey: 'L01', archWallId: 'ARC-L01-WALL-001', start: [0, 0], end: [8, 0], thickness: 0.3, height: 3, role: 'bearing', material: 'concrete' }],
    slabs: [],
    foundations: [],
    sizes: { columnW: 0.4, columnD: 0.4, beamW: 0.4, beamD: 0.6, slabT: 0.25, shearWallT: 0.25 },
    loads: { deadKpa: 2.5, liveKpa: 1.5, roofLiveKpa: 1 },
    plenumClearance: { corridorSoffitZ: 2.4 },
    elements: [],
    patterns: [],
    derived: {},
  };

  return {
    spec, typology, storeys, site, arch, struct,
    mech: null, plumb: null, elec: null,
    elements: syntheticElements(),
    metrics: [],
    patterns: { book: [], applications: [] },
    warnings: [],
    timings: {},
    ...overrides,
  };
}

/**
 * A `count`-element model of boxes on one storey, every element carrying the
 * property and quantity sets a discipline module would attach. Used to measure
 * the STEP entities written per ModelElement.
 */
function boxModel(count: number): DesignModel {
  const storeys: StoreyDef[] = [{ id: 'L01', name: 'Level 1', index: 0, elevation: 0, height: 3, use: 'residential' }];
  const elements: ModelElement[] = [];
  for (let i = 0; i < count; i++) {
    const size = 0.3 + (i % 5) * 0.1;
    elements.push({
      id: `ELE-L01-DEV-${String(i).padStart(4, '0')}`,
      discipline: 'electrical', ifcType: 'IfcOutlet', name: `Outlet ${i}`,
      storey: 'L01', predefinedType: 'POWEROUTLET',
      unitId: `U-L01-${String(i % 20).padStart(2, '0')}`,
      roomId: `R-U-L01-${String(i % 20).padStart(2, '0')}-BED1`,
      system: 'SYS-ELE-POWER',
      geometry: { kind: 'box', position: [i % 25, Math.floor(i / 25), 0.3], width: size, depth: 0.05, height: 0.12 },
      psets: [{ name: 'Pset_OutletTypeCommon', properties: [{ name: 'Reference', value: 'GFCI' }, { name: 'NumberOfSockets', value: 2 }] }],
      quantities: [{ name: 'Qto_OutletBaseQuantities', quantities: [{ name: 'Count', value: 1, kind: 'IfcQuantityCount' }] }],
      color: [0.9, 0.9, 0.2], patterns: ['ELE-03'],
    });
  }
  return syntheticModel({ storeys, elements });
}

// ============================================================================
// STEP parsing helpers
// ============================================================================

/** IfcRelDefinesByProperties, both ways round: definition ⇄ related products. */
function propertyRelations(content: string): {
  membersOf: Map<number, number[]>;
  definitionsOf: Map<number, number[]>;
  relCount: Map<number, number>;
} {
  const membersOf = new Map<number, number[]>();
  const definitionsOf = new Map<number, number[]>();
  const relCount = new Map<number, number>();
  const re = /#\d+=IFCRELDEFINESBYPROPERTIES\('[^']*',#\d+,\$,\$,\(([^)]*)\),#(\d+)\);/g;
  for (const match of content.matchAll(re)) {
    const members = match[1].split(',').map(ref => Number(ref.trim().replace('#', '')));
    const definition = Number(match[2]);
    membersOf.set(definition, [...(membersOf.get(definition) ?? []), ...members]);
    relCount.set(definition, (relCount.get(definition) ?? 0) + 1);
    for (const member of members) {
      definitionsOf.set(member, [...(definitionsOf.get(member) ?? []), definition]);
    }
  }
  return { membersOf, definitionsOf, relCount };
}

/** expressIds of the IfcPropertySets with this Name. */
function propertySetsNamed(content: string, name: string): number[] {
  const re = new RegExp(`#(\\d+)=IFCPROPERTYSET\\('[^']*',#\\d+,'${name}',`, 'g');
  return [...content.matchAll(re)].map(match => Number(match[1]));
}

/** expressIds of the IfcElementQuantity sets with this Name. */
function quantitySetsNamed(content: string, name: string): number[] {
  const re = new RegExp(`#(\\d+)=IFCELEMENTQUANTITY\\('[^']*',#\\d+,'${name}',`, 'g');
  return [...content.matchAll(re)].map(match => Number(match[1]));
}

// ============================================================================
// Tests
// ============================================================================

test('writeIfc produces a structurally valid IFC4 file', () => {
  const model = syntheticModel();
  const out = writeIfc(model);
  const result = validateStep(out.content);

  assert.deepEqual(result.errors, [], 'validation errors');
  assert.equal(result.ok, true);
  assert.equal(result.schema, 'IFC4');
  assert.ok(out.fileSize > 5000, `file looks too small: ${out.fileSize}`);
  assert.equal(result.entityCount, out.entityCount);
  assert.equal(result.unresolvedRefs, 0);
});

test('every geometry kind reaches the right IFC entity', () => {
  const out = writeIfc(syntheticModel());
  const { byType } = validateStep(out.content);

  for (const type of [
    'IFCWALL', 'IFCSLAB', 'IFCCOLUMN', 'IFCBEAM', 'IFCFURNISHINGELEMENT', 'IFCSPACE',
    'IFCPIPESEGMENT', 'IFCDUCTSEGMENT', 'IFCSTAIR', 'IFCDOOR', 'IFCWINDOW', 'IFCFOOTING',
    'IFCPILE', 'IFCROOF', 'IFCRAILING', 'IFCRAMP', 'IFCBUILDINGELEMENTPROXY',
    'IFCGEOGRAPHICELEMENT', 'IFCELECTRICDISTRIBUTIONBOARD', 'IFCCURTAINWALL', 'IFCMEMBER',
    'IFCZONE', 'IFCDISTRIBUTIONSYSTEM', 'IFCRELASSIGNSTOGROUP', 'IFCRELSERVICESBUILDINGS',
    'IFCOPENINGELEMENT', 'IFCRELVOIDSELEMENT', 'IFCRELFILLSELEMENT',
    'IFCPROJECT', 'IFCSITE', 'IFCBUILDING', 'IFCBUILDINGSTOREY',
    'IFCPROPERTYSET', 'IFCELEMENTQUANTITY', 'IFCMATERIALLAYERSET', 'IFCSURFACESTYLE',
  ]) {
    assert.ok((byType[type] ?? 0) > 0, `expected at least one ${type}`);
  }

  // 3 spaces, 2 roofs (flat + gable), 2 pipe segments.
  assert.equal(byType.IFCSPACE, 3);
  assert.equal(byType.IFCROOF, 2);
  assert.equal(byType.IFCPIPESEGMENT, 2);
  // Two walls, and the standalone door/window fallback plus the hosted pair.
  assert.equal(byType.IFCWALL, 2);
  assert.equal(byType.IFCDOOR, 1);
  assert.equal(byType.IFCWINDOW, 2);
  // One system per `system` id (power, DCW, supply air) and one zone per unit.
  assert.equal(byType.IFCDISTRIBUTIONSYSTEM, 3);
  assert.equal(byType.IFCZONE, 1);
});

test('idMap covers every writable element and carries the id into the Tag', () => {
  const model = syntheticModel();
  const out = writeIfc(model);

  const broken = new Set(['STR-L01-COL-BAD', 'STR-L01-BEAM-BAD']);
  for (const element of model.elements) {
    if (broken.has(element.id)) {
      assert.equal(out.idMap[element.id], undefined, `${element.id} should have been skipped`);
      continue;
    }
    assert.equal(typeof out.idMap[element.id], 'number', `${element.id} missing from idMap`);
  }
  assert.equal(Object.keys(out.idMap).length, model.elements.length - broken.size);

  // Tag round trip (IfcSpace has no Tag attribute → id lands in Description).
  assert.match(out.content, /IFCWALL\('[^']+',#\d+,'External wall',\$,\$,#\d+,#\d+,'ARC-L01-WALL-001',\.STANDARD\.\)/);
  assert.match(out.content, /IFCSPACE\('[^']+',#\d+,'Living \/ kitchen','ARC-L01-SPACE-001'/);
});

test('bad elements produce warnings instead of throwing', () => {
  const out = writeIfc(syntheticModel());
  const warnings = out.warnings ?? [];

  assert.ok(warnings.some(w => w.includes('STR-L01-COL-BAD') && w.includes('non-finite')), warnings.join('\n'));
  assert.ok(warnings.some(w => w.includes('STR-L01-BEAM-BAD') && w.includes('degenerate')), warnings.join('\n'));
  assert.ok(warnings.some(w => w.includes('ARC-L01-WIN-002') && w.includes('standalone IfcWindow')), warnings.join('\n'));
  // Everything else wrote cleanly.
  assert.equal(warnings.length, 3, warnings.join('\n'));
});

test('a model of only broken elements still yields a valid file', () => {
  const model = syntheticModel({
    elements: [
      {
        id: 'BAD-1', discipline: 'structure', ifcType: 'IfcColumn', name: 'Infinity column', storey: 'L01',
        geometry: { kind: 'column', position: [0, 0, 0], width: Number.POSITIVE_INFINITY, depth: 1, height: 1 },
      },
      {
        id: 'BAD-2', discipline: 'architecture', ifcType: 'IfcWall', name: 'Zero wall', storey: 'L01',
        geometry: { kind: 'wall', start: [0, 0, 0], end: [0, 0, 0], thickness: 0, height: 0 },
      },
      {
        id: 'BAD-3', discipline: 'architecture', ifcType: 'IfcSlab', name: 'Two-point slab', storey: 'L01',
        geometry: { kind: 'slab', position: [0, 0, 0], thickness: 0.2, profile: [[0, 0], [1, 1]] },
      },
      {
        id: 'BAD-4', discipline: 'site', ifcType: 'IfcSpace', name: 'Unknown storey space', storey: 'NOPE',
        geometry: { kind: 'prism', position: [0, 0, 0], profile: [[0, 0], [1, 0], [1, 1]], height: 2 },
      },
    ],
  });
  const out = writeIfc(model);
  assert.deepEqual(validateStep(out.content).errors, []);
  assert.equal(Object.keys(out.idMap).length, 1, 'only the unknown-storey space is writable');
  assert.ok((out.warnings ?? []).some(w => w.includes("unknown storey 'NOPE'")));
});

test('deterministic mode is byte-identical across runs; non-deterministic is not', () => {
  const a = writeIfc(syntheticModel(), { deterministic: true });
  const b = writeIfc(syntheticModel(), { deterministic: true });
  assert.equal(a.content, b.content);
  assert.equal(a.fileSize, b.fileSize);

  const c = writeIfc(syntheticModel(), { deterministic: false });
  assert.notEqual(a.content, c.content, 'random GlobalIds should differ from the seeded ones');
  assert.deepEqual(validateStep(c.content).errors, []);
});

test('structure overrides the architecture LoadBearing hint', () => {
  const out = writeIfc(syntheticModel());
  // Pset_WallCommon of ARC-L01-WALL-001 gains LoadBearing = .T.
  assert.match(out.content, /IFCPROPERTYSINGLEVALUE\('LoadBearing',\$,IFCBOOLEAN\(\.T\.\),\$\)/);

  const noStruct = writeIfc(syntheticModel({ struct: null }));
  const loadBearingCount = (noStruct.content.match(/'LoadBearing',\$,IFCBOOLEAN\(\.T\.\)/g) ?? []).length;
  // Only the column's own pset keeps LoadBearing when structure is absent.
  assert.equal(loadBearingCount, 1);
});

test('Forma_Common reaches every written element, through shared property sets', () => {
  const model = syntheticModel();
  const out = writeIfc(model);
  const written = Object.values(out.idMap);
  const { membersOf } = propertyRelations(out.content);
  const formaCommonIds = propertySetsNamed(out.content, 'Forma_Common');

  // One pset per distinct (Discipline, Storey, System, Patterns) tuple — far
  // fewer than one per element — but every product is still related to one.
  assert.ok(formaCommonIds.length > 0 && formaCommonIds.length < written.length,
    `${formaCommonIds.length} Forma_Common psets for ${written.length} products`);
  const covered = new Set<number>();
  for (const psetId of formaCommonIds) for (const member of membersOf.get(psetId) ?? []) covered.add(member);
  for (const expressId of written) {
    assert.ok(covered.has(expressId), `product #${expressId} has no Forma_Common pset`);
  }

  assert.match(out.content, /IFCPROPERTYSINGLEVALUE\('Discipline',\$,IFCLABEL\('plumbing'\),\$\)/);
  assert.match(out.content, /IFCPROPERTYSINGLEVALUE\('System',\$,IFCIDENTIFIER\('SYS-PLB-DCW'\),\$\)/);
  assert.match(out.content, /IFCPROPERTYSINGLEVALUE\('Patterns',\$,IFCLABEL\('ARC-01,XD-01'\),\$\)/);
});

test('site and building carry the spec name', () => {
  const out = writeIfc(syntheticModel());
  assert.match(out.content, /FILE_DESCRIPTION\(\('ViewDefinition \[CoordinationView\]'\),'2;1'\);/);
  assert.match(out.content, /FILE_NAME\('Writer Test Block\.ifc','2024-01-01T12:00:00'/);
  assert.match(out.content, /IFCSITE\('[^']+',#\d+,'Writer Test Block Site'/);
  assert.match(out.content, /IFCBUILDING\('[^']+',#\d+,'Writer Test Block'/);
  const typologyName = getTypology('corridor-midrise').name;
  assert.ok(out.content.includes(`'Writer Test Block','${typologyName} generated by forma-resi-ifc'`), 'project description names the typology');
  assert.ok(out.content.includes(`'Writer Test Block','${typologyName}, 2 storeys'`), 'building description names the typology and storey count');
});

test('IFC2X3 output down-maps IFC4-only entity types', () => {
  const out = writeIfc(syntheticModel(), { schema: 'IFC2X3' });
  const result = validateStep(out.content);
  assert.deepEqual(result.errors, []);
  assert.equal(result.schema, 'IFC2X3');
  assert.equal(result.byType.IFCPIPESEGMENT, undefined);
  assert.ok((result.byType.IFCFLOWSEGMENT ?? 0) >= 3, 'pipes and ducts become IfcFlowSegment');
  assert.ok((result.byType.IFCSYSTEM ?? 0) > 0, 'IfcDistributionSystem becomes IfcSystem');
  assert.equal(result.byType.IFCDISTRIBUTIONSYSTEM, undefined);
});

test('MEP elements group into systems and dwelling spaces into zones', () => {
  const out = writeIfc(syntheticModel());
  // Both DCW pipes are members of one relationship.
  const dcw = out.idMap['PLB-L01-PIPE-001'];
  const dcw2 = out.idMap['PLB-L01-PIPE-002'];
  assert.ok(out.content.includes(`(#${dcw},#${dcw2})`), 'both DCW pipes in one IfcRelAssignsToGroup');
  assert.match(out.content, /IFCDISTRIBUTIONSYSTEM\('[^']+',#\d+,'SYS-PLB-DCW','2 elements','Domestic cold water','Domestic cold water',\.DOMESTICCOLDWATER\.\)/);
  assert.match(out.content, /IFCZONE\('[^']+',#\d+,'U-L01-01',\$,'Dwelling','Dwelling U-L01-01'\)/);
});

test('system id suffixes map to IfcDistributionSystemEnum values', () => {
  assert.equal(systemClassification('SYS-MEC-SUPPLY').type, 'AIRCONDITIONING');
  assert.equal(systemClassification('SYS-MEC-RETURN').type, 'AIRCONDITIONING');
  assert.equal(systemClassification('SYS-MEC-KITCHEN-EXHAUST').type, 'EXHAUST');
  assert.equal(systemClassification('SYS-MEC-EXHAUST').type, 'EXHAUST');
  assert.equal(systemClassification('SYS-PLB-DCW').type, 'DOMESTICCOLDWATER');
  assert.equal(systemClassification('SYS-PLB-DHW').type, 'DOMESTICHOTWATER');
  assert.equal(systemClassification('SYS-PLB-WASTE').type, 'WASTEWATER');
  assert.equal(systemClassification('SYS-PLB-VENT').type, 'VENT');
  assert.equal(systemClassification('SYS-PLB-STORM').type, 'RAINWATER');
  assert.equal(systemClassification('SYS-PLB-SPRINKLER').type, 'FIREPROTECTION');
  assert.equal(systemClassification('SYS-PLB-STANDPIPE').type, 'FIREPROTECTION');
  assert.equal(systemClassification('SYS-PLB-GAS').type, 'GAS');
  assert.equal(systemClassification('SYS-ELE-POWER').type, 'ELECTRICAL');
  assert.equal(systemClassification('SYS-ELE-LIGHTING').type, 'LIGHTING');
  assert.equal(systemClassification('SYS-ELE-DATA').type, 'DATA');
  assert.equal(systemClassification('SYS-ELE-PV').type, 'POWERGENERATION');
  assert.equal(systemClassification('SYS-ELE-WHATEVER').type, 'USERDEFINED');
});

test('box position is the corner at the local origin', () => {
  // rotation 0 → position is the axis-aligned min corner
  const flat = boxFootprint([10, 5, 0], 2, 3, 0);
  assert.deepEqual(flat[0], [10, 5]);
  const minX = Math.min(...flat.map(p => p[0]));
  const minY = Math.min(...flat.map(p => p[1]));
  assert.ok(Math.abs(minX - 10) < 1e-9 && Math.abs(minY - 5) < 1e-9, 'rotation 0: min corner === position');

  // rotation π/2 → the local-origin corner is still exactly `position`
  const turned = boxFootprint([10, 5, 0], 2, 3, Math.PI / 2);
  assert.ok(Math.abs(turned[0][0] - 10) < 1e-9 && Math.abs(turned[0][1] - 5) < 1e-9);
  // and the box now extends -Y…none in X: local +x maps to world +y
  assert.ok(Math.abs(turned[1][0] - 10) < 1e-9 && Math.abs(turned[1][1] - 7) < 1e-9);

  // the placement centres the profile, so location is the box centre
  const placement = boxPlacement([10, 5, 0], 2, 3, 0);
  assert.deepEqual(placement.location, [11, 6.5, 0]);
  assert.deepEqual(placement.refDirection, [1, 0, 0]);

  const turnedPlacement = boxPlacement([10, 5, 0], 2, 3, Math.PI / 2);
  assert.ok(Math.abs(turnedPlacement.location[0] - 8.5) < 1e-9);
  assert.ok(Math.abs(turnedPlacement.location[1] - 6) < 1e-9);
});

test('box placement matches the addIfcFurnishingElement footprint', () => {
  // The furnishing constructor centres addRectangleProfile(w, d, [w/2, d/2]) at
  // Position; boxPlacement must produce the same world footprint via addElement.
  const position: [number, number, number] = [3, 2, 0];
  const [w, d, rotation] = [1.5, 2, Math.PI / 2];
  const corners = boxFootprint(position, w, d, rotation);
  const { location } = boxPlacement(position, w, d, rotation);
  const centre: [number, number] = [
    corners.reduce((a, p) => a + p[0], 0) / 4,
    corners.reduce((a, p) => a + p[1], 0) / 4,
  ];
  assert.ok(Math.abs(location[0] - centre[0]) < 1e-9);
  assert.ok(Math.abs(location[1] - centre[1]) < 1e-9);
});

test('writer never throws on an empty or storey-less model', () => {
  const empty = writeIfc(syntheticModel({ elements: [], storeys: [] }));
  assert.deepEqual(validateStep(empty.content).errors, []);
  assert.ok((empty.warnings ?? []).some(w => w.includes('no storeys')));
  assert.equal(Object.keys(empty.idMap).length, 0);
});

test('identical property sets are written once and bound to every product', () => {
  const count = 600;
  const elements: ModelElement[] = [];
  for (let i = 0; i < count; i++) {
    elements.push({
      id: `STR-L01-COL-${i}`, discipline: 'structure', ifcType: 'IfcColumn', name: `Column ${i}`, storey: 'L01',
      geometry: { kind: 'column', position: [i % 30, Math.floor(i / 30), 0], width: 0.3, depth: 0.3, height: 3 },
      // Byte-identical on every column.
      psets: [{ name: 'Pset_ColumnCommon', properties: [{ name: 'Reference', value: 'C1' }, { name: 'LoadBearing', value: true }] }],
      quantities: [{ name: 'Qto_ColumnBaseQuantities', quantities: [{ name: 'Length', value: 3, kind: 'IfcQuantityLength' }] }],
    });
  }
  const out = writeIfc(syntheticModel({ elements }), { compact: false });
  assert.deepEqual(validateStep(out.content).errors, []);

  const [psetId, ...extraPsets] = propertySetsNamed(out.content, 'Pset_ColumnCommon');
  assert.equal(extraPsets.length, 0, 'one IfcPropertySet for 600 identical psets');
  const [qsetId, ...extraQsets] = quantitySetsNamed(out.content, 'Qto_ColumnBaseQuantities');
  assert.equal(extraQsets.length, 0, 'one IfcElementQuantity for 600 identical quantity sets');

  // Each property is written once too, not 600 times.
  assert.equal((out.content.match(/IFCPROPERTYSINGLEVALUE\('Reference',\$,IFCLABEL\('C1'\),\$\)/g) ?? []).length, 1);

  // Every column is still related, in chunks of at most 250 per relationship.
  const { membersOf, definitionsOf, relCount } = propertyRelations(out.content);
  assert.equal(new Set(membersOf.get(psetId)).size, count);
  assert.equal(new Set(membersOf.get(qsetId)).size, count);
  assert.equal(relCount.get(psetId), Math.ceil(count / 250), 'IfcRelDefinesByProperties chunks');
  assert.equal(relCount.get(qsetId), Math.ceil(count / 250));
  for (const expressId of Object.values(out.idMap)) {
    // Pset_ColumnCommon + Forma_Common + Qto_ColumnBaseQuantities
    assert.equal((definitionsOf.get(expressId) ?? []).length, 3, `product #${expressId} lost a definition`);
  }
});

test('property sets are only merged when every value agrees', () => {
  const elements: ModelElement[] = [];
  for (let i = 0; i < 9; i++) {
    elements.push({
      id: `ELE-L01-PNL-${i}`, discipline: 'electrical', ifcType: 'IfcElectricDistributionBoard',
      name: `Panel ${i}`, storey: 'L01',
      geometry: { kind: 'box', position: [i, 0, 1.2], width: 0.4, depth: 0.12, height: 0.6 },
      psets: [{
        name: 'Forma_Electrical',
        properties: [
          // Three distinct amp ratings → three distinct psets, never merged.
          { name: 'Amps', value: [100, 100, 100, 200, 200, 200, 225, 225, 225][i] },
          { name: 'Voltage', value: '120/240V' },
        ],
      }],
    });
  }
  const out = writeIfc(syntheticModel({ elements }));
  assert.deepEqual(validateStep(out.content).errors, []);

  const psets = propertySetsNamed(out.content, 'Forma_Electrical');
  assert.equal(psets.length, 3, 'one pset per distinct value set');
  const { membersOf } = propertyRelations(out.content);
  assert.deepEqual(psets.map(id => (membersOf.get(id) ?? []).length).sort(), [3, 3, 3]);
  for (const amps of ['100.', '200.', '225.']) {
    assert.equal((out.content.match(new RegExp(`IFCPROPERTYSINGLEVALUE\\('Amps',\\$,IFCREAL\\(${amps.replace('.', '\\.')}\\),\\$\\)`, 'g')) ?? []).length, 1);
  }

  // A number and the same digits as a string are different values.
  const mixed = writeIfc(syntheticModel({
    elements: [
      { ...elements[0], id: 'ELE-L01-PNL-A', psets: [{ name: 'Forma_Electrical', properties: [{ name: 'Amps', value: 100 }] }] },
      { ...elements[1], id: 'ELE-L01-PNL-B', psets: [{ name: 'Forma_Electrical', properties: [{ name: 'Amps', value: '100' }] }] },
    ],
  }));
  assert.equal(propertySetsNamed(mixed.content, 'Forma_Electrical').length, 2);
});

test('compact and full mode both validate, and differ only in per-element metadata', () => {
  const model = syntheticModel();
  const compact = writeIfc(model, { compact: true });
  const full = writeIfc(model, { compact: false });

  assert.deepEqual(validateStep(compact.content).errors, []);
  assert.deepEqual(validateStep(full.content).errors, []);
  // Same products either way.
  assert.deepEqual(Object.keys(compact.idMap).sort(), Object.keys(full.idMap).sort());
  assert.equal(validateStep(compact.content).byType.IFCSPACE, validateStep(full.content).byType.IFCSPACE);

  // Full mode keeps the per-element identifiers; compact mode drops them.
  for (const property of ['ElementId', 'UnitId', 'RoomId']) {
    assert.ok(full.content.includes(`IFCPROPERTYSINGLEVALUE('${property}',`), `full mode lost ${property}`);
    assert.ok(!compact.content.includes(`IFCPROPERTYSINGLEVALUE('${property}',`), `compact mode still writes ${property}`);
  }
  // Compact mode keeps quantities for spaces and slabs only.
  assert.ok(compact.content.includes("IFCELEMENTQUANTITY('") , 'space quantities survive compact mode');
  assert.equal(quantitySetsNamed(compact.content, 'Qto_SpaceBaseQuantities').length, 1);
  assert.equal(quantitySetsNamed(compact.content, 'Qto_WallBaseQuantities').length, 0);
  assert.equal(quantitySetsNamed(full.content, 'Qto_WallBaseQuantities').length, 1);

  assert.ok(compact.entityCount < full.entityCount, 'compact mode writes fewer entities');

  // detail: 'high' opts out of compact mode without passing the flag.
  const highDetail = syntheticModel();
  highDetail.spec.options.detail = 'high';
  assert.ok(writeIfc(highDetail).content.includes("IFCPROPERTYSINGLEVALUE('ElementId',"));
  assert.ok(!writeIfc(model).content.includes("IFCPROPERTYSINGLEVALUE('ElementId',"));
});

test('a 500-box model costs at most 16 STEP entities per element', () => {
  const model = boxModel(500);
  const compact = writeIfc(model);
  const full = writeIfc(model, { compact: false });

  assert.deepEqual(validateStep(compact.content).errors, []);
  const written = Object.keys(compact.idMap).length;
  assert.equal(written, 500);
  const ratio = compact.entityCount / written;
  assert.ok(ratio <= 16, `compact mode writes ${ratio.toFixed(2)} entities per element`);
  assert.ok(full.entityCount / written > ratio, 'full mode is the more expensive one');
});

test('deterministic mode is byte-identical across runs in both compact and full mode', () => {
  for (const compact of [true, false]) {
    const a = writeIfc(boxModel(120), { compact, deterministic: true });
    const b = writeIfc(boxModel(120), { compact, deterministic: true });
    assert.equal(a.content, b.content, `compact: ${compact}`);
    assert.equal(a.entityCount, b.entityCount);
    assert.deepEqual(validateStep(a.content).errors, []);
  }
});

test('structure promotes core and shear walls to PredefinedType SHEAR', () => {
  const model = syntheticModel();
  // Architecture types both walls SOLIDWALL; structure claims WALL-002 as a core wall.
  model.elements = model.elements.map(element => (
    element.id === 'ARC-L01-WALL-001' || element.id === 'ARC-L01-WALL-002'
      ? { ...element, predefinedType: 'SOLIDWALL' }
      : element
  ));
  model.struct!.walls = [
    { id: 'STR-L01-WALL-001', storey: 'L01', archWallId: 'ARC-L01-WALL-001', start: [0, 0], end: [8, 0], thickness: 0.3, height: 3, role: 'bearing', material: 'concrete' },
    { id: 'STR-L01-WALL-002', storey: 'L01', archWallId: 'ARC-L01-WALL-002', start: [0, 0], end: [0, 9], thickness: 0.25, height: 3, role: 'core', material: 'concrete' },
  ];
  const out = writeIfc(model);
  assert.deepEqual(validateStep(out.content).errors, []);

  // The bearing wall keeps architecture's SOLIDWALL, the core wall becomes SHEAR.
  assert.match(out.content, /IFCWALL\('[^']+',#\d+,'External wall',[^\n]*,'ARC-L01-WALL-001',\.SOLIDWALL\.\)/);
  assert.match(out.content, /IFCWALL\('[^']+',#\d+,'Party wall with opening',[^\n]*,'ARC-L01-WALL-002',\.SHEAR\.\)/);

  // Unknown tokens fall back to STANDARD rather than writing an invalid enum.
  const odd = syntheticModel();
  odd.elements = [{ ...odd.elements[0], predefinedType: 'not-a-wall-type' }];
  odd.struct = null;
  assert.match(writeIfc(odd).content, /IFCWALL\([^\n]*\.STANDARD\.\)/);
});

test('a 20-storey point tower writes in well under 2 s', () => {
  const elements: ModelElement[] = [];
  const storeys: StoreyDef[] = [{ id: 'SITE', name: 'Site', index: -101, elevation: 0, height: 0, use: 'site' }];
  for (let level = 0; level < 20; level++) {
    const id = `L${String(level + 1).padStart(2, '0')}`;
    storeys.push({ id, name: `Level ${level + 1}`, index: level, elevation: level * 3.1, height: 3.1, use: 'residential' });
    for (let i = 0; i < 300; i++) {
      elements.push({
        id: `ARC-${id}-WALL-${i}`, discipline: 'architecture', ifcType: 'IfcWall', name: `Wall ${i}`, storey: id,
        geometry: { kind: 'wall', start: [i % 20, Math.floor(i / 20), 0], end: [(i % 20) + 3, Math.floor(i / 20), 0], thickness: 0.15, height: 2.8 },
        psets: [{ name: 'Pset_WallCommon', properties: [{ name: 'IsExternal', value: i % 4 === 0 }] }],
      });
    }
  }
  const model = syntheticModel({ storeys, elements });
  const t0 = performance.now();
  const out = writeIfc(model);
  const writeMs = performance.now() - t0;
  const t1 = performance.now();
  const result = validateStep(out.content);
  const validateMs = performance.now() - t1;

  assert.equal(Object.keys(out.idMap).length, 6000);
  assert.deepEqual(result.errors, []);
  assert.ok(writeMs < 2000, `writeIfc took ${writeMs.toFixed(0)} ms`);
  assert.ok(validateMs < 2000, `validateStep took ${validateMs.toFixed(0)} ms`);
});
