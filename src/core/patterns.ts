/**
 * Pattern book: the explicit pattern language. Each discipline registers its patterns
 * (Alexander-style problem/solution with parameters) and records where it applied them.
 *
 * Id prefixes: SIT (site), ARC (architecture), STR (structure), MEC (mechanical),
 * PLB (plumbing), ELE (electrical), XD (cross-discipline, owned by core).
 */
import type { Pattern, PatternApplication, Discipline } from './types.ts';
import { CLEARANCES, CLEAR_HEIGHTS, HANGERS, MOVE_COST_BANDS, SLOPES, ZONE_CLEARS } from './kernel/clearances.ts';
import { PROFILE_DEFS } from './kernel/profiles.ts';
import type { BandPurpose, ProfileId } from './kernel/types.ts';

/**
 * The cross-discipline patterns XD-06…XD-12 document the coordination kernel, so their parameters are READ FROM the
 * kernel tables rather than restated here: one owner per fact. `bandDepth('resi-corridor', 'service')` is the same
 * number `stackProfile` uses and the same number the Rules tab shows as `XD-06.band.resi-corridor.service.depth`.
 */
function bandDepth(profileId: ProfileId, purpose: BandPurpose): number {
  const profile = PROFILE_DEFS.find(p => p.id === profileId);
  const band = profile?.bands.find(b => b.purpose === purpose);
  return band ? band.depth : 0;
}
function bandMinDepth(profileId: ProfileId, purpose: BandPurpose): number {
  const profile = PROFILE_DEFS.find(p => p.id === profileId);
  const band = profile?.bands.find(b => b.purpose === purpose);
  return band ? band.minDepth : 0;
}
function bandSource(profileId: ProfileId, purpose: BandPurpose): string {
  const profile = PROFILE_DEFS.find(p => p.id === profileId);
  const band = profile?.bands.find(b => b.purpose === purpose);
  return band ? band.source : 'default';
}
function zoneClear(profileId: ProfileId, zone: string): number {
  return ZONE_CLEARS.find(z => z.profile === profileId && z.zone === zone)?.minClear ?? 0;
}
function zoneSource(profileId: ProfileId, zone: string): string {
  return ZONE_CLEARS.find(z => z.profile === profileId && z.zone === zone)?.source ?? 'default';
}
function clearanceOf(a: string, b: string, order?: string): { min: number; source: string } {
  const hit = CLEARANCES.find(c => c.a === a && c.b === b && (order === undefined || c.order === order));
  return hit ? { min: hit.min, source: hit.source } : { min: 0, source: 'default' };
}
/** The band order of a profile, from the soffit down — the pattern's own "solution", as data. */
function bandOrderOf(profileId: ProfileId): string {
  const profile = PROFILE_DEFS.find(p => p.id === profileId);
  return (profile?.bands ?? []).map(b => `${b.purpose}(${b.flexibility})`).join(' → ');
}

export class PatternBook {
  private patterns = new Map<string, Pattern>();
  private applications: PatternApplication[] = [];

  register(...patterns: Pattern[]): void {
    for (const p of patterns) {
      if (this.patterns.has(p.id) && this.patterns.get(p.id) !== p) {
        throw new Error(`Pattern id collision: ${p.id}`);
      }
      this.patterns.set(p.id, p);
    }
  }

  apply(app: PatternApplication): void {
    if (!this.patterns.has(app.patternId)) {
      throw new Error(`Pattern ${app.patternId} applied before registration`);
    }
    this.applications.push(app);
  }

  get(id: string): Pattern | undefined { return this.patterns.get(id); }
  all(): Pattern[] { return [...this.patterns.values()]; }
  byDiscipline(d: Discipline | 'cross'): Pattern[] { return this.all().filter(p => p.discipline === d); }
  trace(): PatternApplication[] { return [...this.applications]; }
  merge(apps: PatternApplication[]): void { for (const a of apps) this.apply(a); }
}

/** Cross-discipline patterns owned by core; disciplines reference these by id. */
export const CROSS_PATTERNS: Pattern[] = [
  {
    id: 'XD-01',
    name: 'Wet Wall Stacking',
    discipline: 'cross',
    problem: 'Kitchens and bathrooms scattered across a plan multiply risers, penetrations and cost, and make stacking of pipes impossible between floors.',
    solution: 'Every unit template backs its kitchen and bathrooms onto one shared wet wall. Units are stacked identically floor to floor so wet walls align vertically, and each wet wall hosts one plumbing stack. Mechanical exhaust and electrical panels share the same service zone.',
    parameters: {
      wetWallThickness: { value: 0.2, unit: 'm', source: 'default (2×6 / 150 mm stud + finishes)' },
      maxFixtureDistanceToStack: { value: 3.0, unit: 'm', source: 'trap-arm and branch-length limits (IPC Table 1002.2)' },
    },
    references: ['IPC 2021 §1002', 'BS EN 12056'],
  },
  {
    id: 'XD-02',
    name: 'Corridor Service Spine',
    discipline: 'cross',
    problem: 'Horizontal services crossing units cause coordination clashes and acoustic leaks between dwellings.',
    solution: 'All horizontal distribution runs in the corridor ceiling plenum in fixed lanes: ducts on the centreline at the top, wet pipes and sprinkler main in the lane toward the units on one side, cable trays in the lane on the other side. Branches enter units perpendicular to the corridor, above the unit entry door.',
    parameters: {
      plenumDepthMin: { value: 0.45, unit: 'm', source: 'default' },
      ductLaneOffset: { value: 0, unit: 'm (from corridor centreline)', source: 'default' },
      pipeLaneOffset: { value: -0.35, unit: 'm', source: 'default' },
      trayLaneOffset: { value: 0.35, unit: 'm', source: 'default' },
    },
    dependsOn: ['ARC-03'],
  },
  {
    id: 'XD-03',
    name: 'Structure Follows Party Walls',
    discipline: 'cross',
    problem: 'A structural grid that ignores the unit rhythm puts columns inside living rooms and forces transfer structure.',
    solution: 'Grid lines are placed on party walls and corridor walls; column spacing equals one or two unit frontages. Below a podium, the grid transfers to a parking module (2 × 2.6 m bays + column).',
    parameters: {
      maxSpan: { value: 9.0, unit: 'm', source: 'RC flat slab economic span' },
      parkingModule: { value: 8.4, unit: 'm', source: 'three 2.6–2.8 m bays' },
    },
    dependsOn: ['ARC-02'],
  },
  {
    id: 'XD-04',
    name: 'Shafts at the Core',
    discipline: 'cross',
    problem: 'Vertical risers scattered through a plan puncture every slab and steal usable area from units.',
    solution: 'Vertical mechanical, electrical and trash shafts sit adjacent to each stair/elevator core and open to the corridor. Plumbing stacks alone are permitted inside unit wet walls.',
    parameters: {
      shaftAreaPerUnitServed: { value: 0.12, unit: 'm²/unit', source: 'default' },
    },
    dependsOn: ['ARC-04'],
  },
  {
    id: 'XD-05',
    name: 'Design Occupancy Drives Systems',
    discipline: 'cross',
    problem: 'Systems sized on floor area alone ignore how many people actually live in a dwelling.',
    solution: 'Occupancy = bedrooms + 1 (bedspaces = 2 per double bedroom). Ventilation, DHW, electrical demand and fixture counts derive from occupancy, not area.',
    parameters: {
      occupantsPerBedroom: { value: 1, unit: 'person', source: 'ASHRAE 62.2 default (bedrooms + 1)' },
    },
  },
  {
    id: 'XD-06',
    name: 'Ceiling Sandwich',
    discipline: 'cross',
    problem: 'Six disciplines each want the deepest part of the same plenum, and the one that routes first wins. The result is a duct hard against the slab where the sprinkler main has to be, a drain that has to hop over it, a tray nobody can reach from a ceiling tile, and a corridor ceiling height nobody decided.',
    solution: 'Stack the plenum in one fixed order, from the slab soffit downward, and make that order the order of how hard each thing is to move: structure first (fixed by span), then the sprinkler main tight to the soffit (the deflector distance forces it), then the ducts (biggest rigid section, so they set the depth), then gravity crossings (one invert, one slope), then pressure pipes (which can offset), then the electrical void (altered many times over the building’s life, so it must stay reachable), then the ceiling. When the storey is too short, compress the most flexible bands to their minimum, drop droppable bands, and only then ask for a taller storey. The ceiling height is an OUTPUT of this stack, never an input.',
    parameters: {
      bandOrder: { value: bandOrderOf('resi-corridor'), unit: 'purpose(flexibility), soffit → down', source: 'core/kernel/profiles.ts resi-corridor' },
      corridorClearMin: { value: CLEAR_HEIGHTS['resi-corridor'].min, unit: 'm', source: CLEAR_HEIGHTS['resi-corridor'].source },
      corridorClearTarget: { value: CLEAR_HEIGHTS['resi-corridor'].target, unit: 'm', source: CLEAR_HEIGHTS['resi-corridor'].source },
      sprinklerBandDepth: { value: bandDepth('resi-corridor', 'sprinkler'), unit: 'm', source: bandSource('resi-corridor', 'sprinkler') },
      serviceBandDepth: { value: bandDepth('resi-corridor', 'service'), unit: 'm', source: bandSource('resi-corridor', 'service') },
      serviceBandMinDepth: { value: bandMinDepth('resi-corridor', 'service'), unit: 'm', source: bandSource('resi-corridor', 'service') },
      crossingBandDepth: { value: bandDepth('resi-corridor', 'crossing'), unit: 'm', source: bandSource('resi-corridor', 'crossing') },
      ceilingVoidMin: { value: bandMinDepth('resi-corridor', 'ceiling-void'), unit: 'm', source: bandSource('resi-corridor', 'ceiling-void') },
      ceilingThickness: { value: bandDepth('resi-corridor', 'ceiling'), unit: 'm', source: bandSource('resi-corridor', 'ceiling') },
      compressBeforeDrop: { value: true, source: 'core/kernel/profiles.ts stackProfile (compress → drop → raise)' },
      moveCostOrder: { value: MOVE_COST_BANDS.map(b => `${b.flexibility}:${b.cost}`).join(' '), source: 'core/kernel/clearances.ts MOVE_COST' },
    },
    dependsOn: ['XD-02', 'STR-09'],
    references: ['NFPA 13 2022 §8.6.4.1.1.1', 'SMACNA HVAC Duct Construction Standards 3rd ed. Table 5-1', 'NEC 2023 110.26', 'IBC 2021 §1003.2'],
  },
  {
    id: 'XD-07',
    name: 'Flat Soffit Dwelling',
    discipline: 'cross',
    problem: 'Services routed through a flat costs the flat its ceiling. A drain crossing a living room means a bulkhead over the sofa, a slab penetration on every floor, and an acoustic path between dwellings; once one service crosses, the rest follow and the ceiling becomes a patchwork of soffits.',
    solution: 'Nothing crosses a dwelling. Every stack, riser and wet service is in the wet-wall chase; the branch services run in one shallow service band over the hall and the wet strip; the living rooms and bedrooms keep a flat soffit at the full clear height. A dwelling therefore has exactly one bulkhead, over the one place nobody stands still.',
    parameters: {
      roomClearTarget: { value: CLEAR_HEIGHTS['resi-unit'].target, unit: 'm', source: CLEAR_HEIGHTS['resi-unit'].source },
      roomClearMin: { value: CLEAR_HEIGHTS['resi-unit'].min, unit: 'm', source: CLEAR_HEIGHTS['resi-unit'].source },
      hallBulkheadClear: { value: zoneClear('resi-unit', 'hall-bulkhead'), unit: 'm', source: zoneSource('resi-unit', 'hall-bulkhead') },
      unitServiceBandDepth: { value: bandDepth('resi-unit', 'service'), unit: 'm', source: bandSource('resi-unit', 'service') },
      unitServiceBandMinDepth: { value: bandMinDepth('resi-unit', 'service'), unit: 'm', source: bandSource('resi-unit', 'service') },
      bulkheadAreaShare: { value: 0.33, unit: 'fraction of room area', source: 'code:IBC 2021 §1208.2 exception (soffits over up to one third of the area)' },
      stacksInChase: { value: true, source: 'code:IPC 2021 §704 + Approved Document E §5 (acoustic separation)' },
      panelOnHallWall: { value: true, source: 'code:NEC 2023 240.24(D)/(E) (not in a bathroom, a clothes closet or over stairs)' },
    },
    dependsOn: ['XD-01', 'XD-06'],
    references: ['IBC 2021 §1208.2', 'London Housing SPG 2016 §3.3.6', 'IPC 2021 §704', 'NEC 2023 240.24'],
  },
  {
    id: 'XD-08',
    name: 'Exposed Garage Services',
    discipline: 'cross',
    problem: 'A car park has no ceiling to hide behind, so every duct, pipe and tray is measured directly against the vehicle envelope — and the one dimension that is never negotiable, the 2.5 m over an accessible route, is the one a big extract duct takes first.',
    solution: 'Put the extract duct on the AISLE centreline, where the clear height is measured and where a 5.4 m deep stall is never walked under; hang the dry sprinkler main tight to the soffit; put the EV tray over the stall HEAD so charging capacity can be added later without touching the clear height; keep the drain in the floor, falling to the low point; and keep the accessible route and the van stalls as clear-height zones that nothing may enter.',
    parameters: {
      aisleClear: { value: zoneClear('parking', 'drive-aisle'), unit: 'm', source: zoneSource('parking', 'drive-aisle') },
      accessibleRouteClear: { value: zoneClear('parking', 'accessible-route'), unit: 'm', source: zoneSource('parking', 'accessible-route') },
      vanStallClear: { value: zoneClear('parking', 'van-stall'), unit: 'm', source: zoneSource('parking', 'van-stall') },
      exhaustBandDepth: { value: bandDepth('parking', 'exhaust'), unit: 'm', source: bandSource('parking', 'exhaust') },
      exhaustBandMinDepth: { value: bandMinDepth('parking', 'exhaust'), unit: 'm', source: bandSource('parking', 'exhaust') },
      ventilationRate: { value: 3.8, unit: 'L/s·m²', source: 'code:IMC 2021 §404.2 (0.75 cfm/ft²); 1.5 L/s·m² with CO/NO₂ control per ASHRAE 62.1-2019 Table 6-4' },
      jetFanSpacing: { value: 17.5, unit: 'm', source: 'BS 7346-7:2013 §6 (impulse ventilation, 15–20 m)' },
      jetFanThrust: { value: 50, unit: 'N', source: 'BS 7346-7:2013 §6' },
      drainBandDepth: { value: bandDepth('parking', 'gravity-drain'), unit: 'm', source: bandSource('parking', 'gravity-drain') },
      trenchSlope: { value: SLOPES.trenchDrain.slope, unit: 'm/m', source: SLOPES.trenchDrain.source },
      evTrayOverStallHead: { value: true, source: 'code:NEC 2023 625.40' },
      coSetpoint: { value: 25, unit: 'ppm (1 h TWA)', source: 'NFPA 88A 2019 §5.4 / ASHRAE 62.1-2019 §6.2' },
    },
    dependsOn: ['SIT-07', 'XD-06'],
    references: ['IBC 2021 §406.4.1', 'ADA 2010 §502.5', 'IMC 2021 §404.2', 'BS 7346-7:2013', 'NFPA 13 2022 §8.3.3'],
  },
  {
    id: 'XD-09',
    name: 'Shell-and-Core Demise',
    discipline: 'cross',
    problem: 'Base-build services drawn straight through a retail unit are cut out on the first day of the tenant fit-out, and the deep plenum the tenant was promised has a landlord duct in it. Nobody notices until the lease is signed.',
    solution: 'Divide the retail ceiling into a shallow landlord band tight under the structure and a deep tenant plenum that is reserved EMPTY. Every landlord service terminates capped, valved and metered within a metre of the demise line; every tower stack is taken out of the tenancy into a rated chase inside a demising or core wall. The tenant plenum is a reservation of emptiness, and the transfer zone above it belongs to structure alone.',
    parameters: {
      tenantPlenumDepth: { value: bandDepth('retail-shell', 'tenant-plenum'), unit: 'm', source: bandSource('retail-shell', 'tenant-plenum') },
      tenantPlenumMinDepth: { value: bandMinDepth('retail-shell', 'tenant-plenum'), unit: 'm', source: bandSource('retail-shell', 'tenant-plenum') },
      landlordBandDepth: { value: bandDepth('retail-shell', 'landlord-service'), unit: 'm', source: bandSource('retail-shell', 'landlord-service') },
      shellClearMin: { value: CLEAR_HEIGHTS['retail-shell'].min, unit: 'm', source: CLEAR_HEIGHTS['retail-shell'].source },
      shellClearTarget: { value: CLEAR_HEIGHTS['retail-shell'].target, unit: 'm', source: CLEAR_HEIGHTS['retail-shell'].source },
      stackEnclosureRating: { value: '1 h', source: 'code:IBC 2021 §713.4 (shaft enclosure) / §708 (fire partition)' },
      meteredAtDemise: { value: true, source: 'default (shell-and-core lease standard: capped, valved, metered)' },
      transferZoneExclusive: { value: true, source: 'STR-04 (no MEP inside the transfer zone)' },
    },
    dependsOn: ['XD-06', 'STR-04'],
    references: ['IBC 2021 §713.4', 'IBC 2021 §708', 'IBC 2021 §1208.2'],
  },
  {
    id: 'XD-10',
    name: 'Plant Room Clearances',
    discipline: 'cross',
    problem: 'Plant rooms are sized by adding up equipment footprints, so the pump that has to be lifted out in year eight cannot be reached, the switchgear has a pipe in its working space, and the floor is a maze of plinths with nowhere to stand.',
    solution: 'Size the room by the ACCESS envelope, not the equipment: everything that can be overhead goes tight to the soffit so the floor stays clear; equipment sits on a housekeeping plinth with its maintenance clearance all round; switchgear keeps its full working space in front and its dedicated space above, free of every foreign system; and the room has a floor drain because it will be washed down and it will leak.',
    parameters: {
      overheadBandDepth: { value: bandDepth('mep-room', 'service'), unit: 'm', source: bandSource('mep-room', 'service') },
      accessClear: { value: CLEAR_HEIGHTS['mep-room'].min, unit: 'm', source: CLEAR_HEIGHTS['mep-room'].source },
      plinthHeight: { value: bandDepth('mep-room', 'equipment'), unit: 'm', source: bandSource('mep-room', 'equipment') },
      switchgearFront: { value: clearanceOf('switchgear', 'any', 'front').min, unit: 'm', source: clearanceOf('switchgear', 'any', 'front').source },
      switchgearWorkingHeight: { value: clearanceOf('panel', 'any', 'height').min, unit: 'm', source: clearanceOf('panel', 'any', 'height').source },
      dedicatedSpaceAbove: { value: clearanceOf('switchgear', 'any', 'dedicated space above').min, unit: 'm', source: clearanceOf('switchgear', 'any', 'dedicated space above').source },
      applianceAccess: { value: clearanceOf('pump', 'any').min, unit: 'm', source: clearanceOf('pump', 'any').source },
      burnerAccess: { value: 0.75, unit: 'm', source: 'code:IMC 2021 §306.3 (burner / coil withdrawal)' },
      manwayAccess: { value: 1.0, unit: 'm', source: 'code:IMC 2021 §306.3 (tank manway)' },
    },
    dependsOn: ['XD-06'],
    references: ['IMC 2021 §306.3', 'IMC 2021 §303.3', 'NEC 2023 Table 110.26(A)(1)', 'NEC 2023 110.26(E)'],
  },
  {
    id: 'XD-11',
    name: 'Gravity First',
    discipline: 'cross',
    problem: 'A drain has one invert, one direction and one slope, and it is always routed last — so it ends up hopping over a duct that could have moved, or falling below the sewer it is supposed to reach, and the fix is a pump nobody budgeted for.',
    solution: 'Decide the gravity horizon before anything else is routed. Derive the sewer invert from cover plus fall over the longest run, then work upward: every level whose drain invert is above it drains by gravity through its own band and its own crossing stations; every level below it is a pumped level with a sump, a duplex ejector and a rising discharge in the pressure lane. Gravity gets its band and its stations first; pressure services, which can rise and fall freely, fit around it.',
    parameters: {
      slopeUpTo75: { value: SLOPES.sanitary[0].slope, unit: 'm/m', source: SLOPES.sanitary[0].source },
      slope100to150: { value: SLOPES.sanitary[1].slope, unit: 'm/m', source: SLOPES.sanitary[1].source },
      slope200Plus: { value: SLOPES.sanitary[2].slope, unit: 'm/m', source: SLOPES.sanitary[2].source },
      slopeUkIe: { value: SLOPES.sanitaryUK[1].slope, unit: 'm/m', source: SLOPES.sanitaryUK[1].source },
      maxSlope: { value: SLOPES.maxGravity.slope, unit: 'm/m', source: SLOPES.maxGravity.source },
      trapArmMaxFall: { value: SLOPES.trapArmMaxFall.slope, unit: 'm/m', source: SLOPES.trapArmMaxFall.source },
      sewerInvertMin: { value: -3.0, unit: 'm below the ground storey', source: 'default (deeper than this is a pumping station, not a connection)' },
      sewerInvertMax: { value: -1.2, unit: 'm below the ground storey', source: 'default (reproduces the v1 SEWER_Z constant)' },
      sumpSize: { value: '0.9 × 0.9 × 1.2', unit: 'm', source: 'code:IPC 2021 §712.1' },
      ejectorDuplex: { value: true, source: 'code:IPC 2021 §712.4.2 (alternating duplex pumps)' },
      dcwAboveWaste: { value: clearanceOf('dcw', 'waste', 'dcw above waste').min, unit: 'm', source: clearanceOf('dcw', 'waste', 'dcw above waste').source },
    },
    dependsOn: ['PLB-01', 'XD-06'],
    references: ['IPC 2021 Table 704.1', 'IPC 2021 §712', 'BS EN 12056-2:2000 §6.3', 'IPC 2021 §603.2'],
  },
  {
    id: 'XD-12',
    name: 'Everything Hangs From Something',
    discipline: 'cross',
    problem: 'A run drawn in mid-air at the depth that suited the drawing has to be built from rod hangers two metres long, or from a trapeze nobody designed; and a riser that passes a storey where its shaft stops has nothing to be strapped to at all.',
    solution: 'Every horizontal run declares what it hangs from and how far below it: within the hanger drop and the hanger spacing of its own code table, or inside a wall, chase, shaft, floor or plinth, where support is by definition. Every riser needs its shaft slot or chase on every storey it passes, against a wall face it can be clamped to. Anything that satisfies neither is not a coordination problem; it is a thing that cannot be built.',
    parameters: {
      ductMaxDrop: { value: HANGERS['duct']?.maxDrop ?? 1.5, unit: 'm', source: HANGERS['duct']?.source ?? 'default' },
      ductSpacing: { value: HANGERS['duct']?.maxSpacing ?? 2.44, unit: 'm', source: HANGERS['duct']?.source ?? 'default' },
      pipeMaxDrop: { value: HANGERS['dcw']?.maxDrop ?? 1.2, unit: 'm', source: HANGERS['dcw']?.source ?? 'default' },
      pipePlasticSpacing: { value: HANGERS['waste']?.maxSpacing ?? 1.22, unit: 'm', source: HANGERS['waste']?.source ?? 'default' },
      sprinklerMaxDrop: { value: HANGERS['sprinkler-main']?.maxDrop ?? 0.9, unit: 'm', source: HANGERS['sprinkler-main']?.source ?? 'default' },
      sprinklerSpacing: { value: HANGERS['sprinkler-main']?.maxSpacing ?? 3.66, unit: 'm', source: HANGERS['sprinkler-main']?.source ?? 'default' },
      traySpacing: { value: HANGERS['tray-power']?.maxSpacing ?? 1.52, unit: 'm', source: HANGERS['tray-power']?.source ?? 'default' },
      riserSupportedEveryStorey: { value: true, source: 'code:IPC 2021 §308.5 / NEC 2023 392.30(A)' },
      sleeveAnnulus: { value: 0.025, unit: 'm', source: 'code:IBC 2021 §714.5 (through-penetration firestop system)' },
    },
    dependsOn: ['XD-06', 'XD-04'],
    references: ['SMACNA 3rd ed. Table 5-1', 'IPC 2021 Table 308.5', 'NFPA 13 2022 Table 9.2.2.1', 'NEC 2023 392.30(A)'],
  },
];
