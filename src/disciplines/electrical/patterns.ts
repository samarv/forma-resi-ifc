/**
 * The electrical pattern language (ELE-01 … ELE-13). Each pattern states the recurring problem
 * in context, the parametric rule that resolves it, and the parameters with units and sources.
 */
import type { Pattern } from '../../core/types.ts';

export const ELEC_PATTERNS: Pattern[] = [
  {
    id: 'ELE-01',
    name: 'Service at the Street, Meters at the Entrance',
    discipline: 'electrical',
    problem:
      'Power arrives from the street, but the rooms that need it are deep inside the building. If the incoming service, the meters and the main switchboard are placed wherever space is left over, the utility cannot read or maintain them, the service conductors run half the length of the building at full fault current, and the switchroom ends up behind a dwelling door.',
    solution:
      'Bring one buried service lateral in from the street edge on the shortest line, at 800 mm cover, to a switchroom on the ground floor near the entrance. Put the main switchboard against the longest clear wall with a metre of working space in front of it, and stack the meters one per dwelling in banks of six beside it so a meter reader never enters a dwelling. Where the service exceeds 600 A, give the utility a pad-mounted transformer on the front boundary within 15 m of the switchroom.',
    parameters: {
      lateralCover: { value: 0.8, unit: 'm', source: 'code:NEC 300.5 Table (600 V direct burial)' },
      lateralDiameter: { value: 0.1, unit: 'm', source: 'default (duct for 4 × 250 mm² conductors)' },
      metersPerStack: { value: 6, unit: 'meters', source: 'default (utility metering panel module)' },
      workingClearance: { value: 1.0, unit: 'm', source: 'code:NEC 110.26(A)(1) Condition 1' },
      transformerThresholdAmps: { value: 600, unit: 'A', source: 'default (utility pad-mount threshold)' },
      transformerSize: { value: '1.6 × 1.2 × 1.5', unit: 'm', source: 'default (single-phase pad-mount)' },
    },
    references: ['NEC 2023 Art. 230 (Services)', 'NEC 110.26', 'BS 7671 §8.2 / DNO cut-out requirements', 'AS/NZS 3000 §2.2'],
  },
  {
    id: 'ELE-02',
    name: 'One Panel per Dwelling in the Hall',
    discipline: 'electrical',
    problem:
      'A dwelling whose overcurrent devices live in another dwelling, in a locked riser, or behind the bathroom door cannot be isolated by the person who lives in it. Panels also attract the leftover wall — the back of a wardrobe, the wall over the stairs — where nobody can stand in front of them.',
    solution:
      'Give every dwelling one panelboard, on a wall of the entry hall or utility room within a few metres of the front door, bottom at 1.2 m so every breaker handle sits between 0.6 m and 2.0 m above the floor. Never in a bathroom, a bedroom, a clothes closet, a kitchen or over a step. Size it from the dwelling demand: 100 A for a studio or one-bed, 125 A for a two-bed, 200 A for three beds and houses; a 100 A consumer unit under BS 7671.',
    parameters: {
      panelsPerDwelling: { value: 1, unit: 'panel', source: 'code:NEC 230.71' },
      bottomHeight: { value: 1.2, unit: 'm', source: 'code:NEC 240.24(A) (handle ≤ 2.0 m)' },
      forbiddenRooms: { value: 'bathroom, bedroom, clothes closet, kitchen, over steps', source: 'code:NEC 240.24(D)(E)' },
      ampsStudio1b: { value: 100, unit: 'A', source: 'code:NEC 220.82 demand' },
      amps2b: { value: 125, unit: 'A', source: 'code:NEC 220.82 demand' },
      amps3bPlus: { value: 200, unit: 'A', source: 'code:NEC 220.82 demand' },
      ampsUk: { value: 100, unit: 'A', source: 'code:BS 7671 (100 A consumer unit)' },
    },
    dependsOn: ['ELE-01', 'ARC-06'],
    references: ['NEC 240.24', 'NEC 230.71', 'BS 7671 §421.1.201', 'AS/NZS 3000 §2.3'],
  },
  {
    id: 'ELE-03',
    name: 'No Point Farther Than Six Feet',
    discipline: 'electrical',
    problem:
      'Furniture moves; extension leads do not belong under rugs. When outlets are counted per room instead of measured along the walls, a long wall gets one outlet at the door and the sofa wall gets none — and the lamp cord crosses the floor.',
    solution:
      'Walk every wall space of every habitable room. Treat each stretch of wall 0.6 m or wider, broken by doors and by glazing whose sill falls below the outlet, as its own wall space, and place outlets so no point along the floor line is more than 1.8 m from one: an outlet within 1.8 m of each end and never more than 3.6 m apart. Mount at 0.4 m to the box centre. In BS 7671 and AS/NZS regions apply the same spacing but count sockets against the room minima — four doubles in a living room, three in a bedroom, six in a kitchen.',
    parameters: {
      maxReach: { value: 1.8, unit: 'm', source: 'code:NEC 210.52(A)(1) (6 ft)' },
      maxSpacing: { value: 3.6, unit: 'm', source: 'code:NEC 210.52(A)(1) (12 ft)' },
      minWallSpace: { value: 0.6, unit: 'm', source: 'code:NEC 210.52(A)(2) (2 ft)' },
      mountingHeight: { value: 0.4, unit: 'm', source: 'default (NEC/ADA 0.38–1.2 m reach range)' },
      hallwayThreshold: { value: 3.0, unit: 'm', source: 'code:NEC 210.52(H) (10 ft hallway)' },
      ukLivingDoubles: { value: 4, unit: 'double sockets', source: 'BS 7671 App. 15 / IET On-Site Guide' },
      ukBedroomDoubles: { value: 3, unit: 'double sockets', source: 'BS 7671 App. 15 / IET On-Site Guide' },
      ukKitchenDoubles: { value: 6, unit: 'double sockets', source: 'BS 7671 App. 15 / IET On-Site Guide' },
    },
    dependsOn: ['ELE-02'],
    references: ['NEC 210.52(A)', 'NEC 210.52(H)', 'BS 7671 Appendix 15', 'AS/NZS 3000 §4.4'],
  },
  {
    id: 'ELE-04',
    name: 'Kitchen Counter Circuits',
    discipline: 'electrical',
    problem:
      'A kitchen draws more current per square metre than any other room in a dwelling, and it draws it in short, simultaneous bursts at the counter. One general circuit for the whole room trips at breakfast, and a single outlet at the end of a three-metre counter guarantees a kettle flex across the sink.',
    solution:
      'Serve the counter with two dedicated 20 A small-appliance circuits and alternate outlets between them, so no point along the counter wall line is more than 0.6 m from a receptacle — an outlet every 1.2 m at 1.1 m above the floor, all GFCI/RCD protected. Give the range, the refrigerator, the dishwasher, the disposal and the microwave their own circuits at nameplate rating, and put under-cabinet task light over the working surface.',
    parameters: {
      counterSpacing: { value: 1.2, unit: 'm', source: 'code:NEC 210.52(C)(1) (no point > 600 mm)' },
      counterHeight: { value: 1.1, unit: 'm', source: 'default (100 mm above a 900 mm counter)' },
      smallApplianceCircuits: { value: 2, unit: 'circuits at 20 A', source: 'code:NEC 210.11(C)(1)' },
      gfciRequired: { value: true, source: 'code:NEC 210.8(A)(6)' },
      rangeVa: { value: 8000, unit: 'VA', source: 'code:NEC Table 220.55 (nameplate)' },
      dishwasherVa: { value: 1200, unit: 'VA', source: 'default (nameplate)' },
      refrigeratorVa: { value: 800, unit: 'VA', source: 'default (nameplate)' },
      microwaveVa: { value: 1500, unit: 'VA', source: 'default (nameplate)' },
      taskLux: { value: 300, unit: 'lx', source: 'EN 12464-1 / IES RP-11 kitchen work surface' },
    },
    dependsOn: ['ELE-03', 'XD-01'],
    references: ['NEC 210.52(C)', 'NEC 210.11(C)(1)', 'NEC 210.8(A)', 'BS 7671 §411.3.3'],
  },
  {
    id: 'ELE-05',
    name: 'Switch at the Latch Side',
    discipline: 'electrical',
    problem:
      'You reach for a light switch in the dark with the hand that is not holding the door. A switch behind the opening leaf, or on the hinge side, or three paces into the room, makes every entry a fumble — and a room whose only control is at the far end is a room people leave lit.',
    solution:
      'Put one wall switch inside every room, on the latch side of the door it is entered through, 0.15 m clear of the opening, at 1.2 m to the centre. Rooms with two ways in — halls, stairs, through-rooms — get a switch at each end wired three-way. Living rooms get a dimmer. The switch controls the room lighting group, never the group next door.',
    parameters: {
      offsetFromOpening: { value: 0.15, unit: 'm', source: 'default (clear of architrave)' },
      mountingHeight: { value: 1.2, unit: 'm', source: 'default (ADA 1.2 m max reach / Part M 0.9–1.2 m)' },
      switchesPerRoom: { value: 1, unit: 'switch', source: 'code:NEC 210.70(A)(1)' },
      threeWayRooms: { value: 'hall, stair', source: 'code:NEC 210.70(A)(2)(c)' },
      dimmerRooms: { value: 'living, dining', source: 'default' },
    },
    dependsOn: ['ELE-13'],
    references: ['NEC 210.70', 'BS 7671 §559', 'Approved Document M §4.30'],
  },
  {
    id: 'ELE-06',
    name: 'Alarms Where People Sleep',
    discipline: 'electrical',
    problem:
      'Fire kills people who are asleep. A single alarm in a hallway is inaudible behind a closed bedroom door, and an alarm that only its own room can hear does not wake the household. Combustion appliances and cars add carbon monoxide, which no smoke sensor detects.',
    solution:
      'Put an interconnected smoke alarm on the ceiling of every bedroom, in the hall or landing immediately outside the bedrooms, and at least one on every level of the dwelling; in common corridors repeat them at 15 m. Add a CO alarm in the circulation space adjacent to the bedrooms wherever a fuel-burning appliance or an attached garage exists, and one per dwelling as a baseline in NEC and BS regions. Use heat detection — not smoke — in garages, plant rooms and switchrooms. All units on a dedicated circuit with battery backup, interconnected so one alarm sounds them all.',
    parameters: {
      bedroomAlarms: { value: 1, unit: 'alarm per bedroom', source: 'code:IRC R314.3 / NFPA 72 §29.8.1' },
      outsideBedrooms: { value: 1, unit: 'alarm per sleeping area', source: 'code:IRC R314.3(2)' },
      perLevel: { value: 1, unit: 'alarm per storey', source: 'code:IRC R314.3(3)' },
      corridorSpacing: { value: 15, unit: 'm', source: 'code:NFPA 72 §17.6.3 (spot spacing 9.1 m, corridors to 12.8 m)' },
      coAlarmTrigger: { value: 'fuel appliance or attached garage', source: 'code:IRC R315.2 / BS 5839-6 §8' },
      grade: { value: 'Grade D1 LD2', source: 'code:BS 5839-6:2019 Table 1 (new dwellings)' },
      interconnected: { value: true, source: 'code:NFPA 72 §29.7' },
    },
    references: ['NFPA 72 §29', 'IRC R314 / R315', 'BS 5839-6:2019', 'AS 3786 / NCC Part 3.7.5'],
  },
  {
    id: 'ELE-07',
    name: 'Corridor Tray Spine',
    discipline: 'electrical',
    problem:
      'Power and data that cross dwellings to reach the next dwelling puncture the party walls, break the acoustic and fire separation, and put every future alteration inside somebody\'s home. Horizontal runs also fight the ducts and the sprinkler main for the same 400 mm of ceiling.',
    solution:
      'Run a cable tray spine down the corridor ceiling plenum in a fixed lane 0.35 m off the centreline, on the opposite side from the wet pipes, with a smaller data tray 0.15 m outboard of it. Drop each dwelling feeder out of the spine directly above its entry door: one horizontal length to the wall line, one vertical drop to the top of the panel. Nothing horizontal ever enters a dwelling except its own feeder.',
    parameters: {
      trayLaneOffset: { value: 0.35, unit: 'm from the corridor centreline', source: 'XD-02' },
      dataTrayOffset: { value: 0.15, unit: 'm outboard of the power tray', source: 'default' },
      powerTraySize: { value: '0.3 × 0.1', unit: 'm', source: 'default (300 mm perforated tray)' },
      dataTraySize: { value: '0.2 × 0.05', unit: 'm', source: 'default (200 mm basket)' },
      feederConduit: { value: 0.032, unit: 'm', source: 'default (Ø32 for a 100 A dwelling feeder)' },
      clearanceBelowDuct: { value: 0.25, unit: 'm', source: 'XD-02 plenum bands' },
    },
    dependsOn: ['XD-02', 'ELE-02'],
    references: ['NEC Art. 392 (Cable Trays)', 'BS 7671 §521', 'XD-02 Corridor Service Spine'],
  },
  {
    id: 'ELE-08',
    name: 'Emergency Light the Way Out',
    discipline: 'electrical',
    problem:
      'In the dark, in smoke, in a power cut, the exit is invisible. Corridors that read clearly in daylight become a maze, and a stair door with no sign above it is indistinguishable from a dwelling door.',
    solution:
      'Sign every exit and stair door with an illuminated exit sign at 2.3 m on the egress side, and light the path of travel with emergency luminaires at 15 m along every corridor plus one beside each stair door and at the exit discharge, all on a dedicated life-safety circuit with 90 minutes of battery autonomy and at least 1 lux on the centreline.',
    parameters: {
      exitSignHeight: { value: 2.3, unit: 'm', source: 'code:IBC §1013.1 (above the door opening)' },
      emergencySpacing: { value: 15, unit: 'm', source: 'code:BS 5266-1 §5 / IBC §1008.3' },
      minCentrelineLux: { value: 1, unit: 'lx', source: 'code:IBC §1008.3.4 (avg 10.8 lx initial) / BS 5266 1 lx' },
      autonomy: { value: 90, unit: 'min', source: 'code:IBC §1008.3.5 / BS 5266 3 h for sleeping risk' },
      dedicatedCircuit: { value: true, source: 'code:NEC 700.10' },
    },
    dependsOn: ['ELE-07', 'ARC-08'],
    references: ['IBC 2021 §1008, §1013', 'BS 5266-1:2016', 'NFPA 101 §7.9', 'NEC Art. 700'],
  },
  {
    id: 'ELE-09',
    name: 'Sun on the Roof',
    discipline: 'electrical',
    problem:
      'A flat residential roof is the cheapest generating site a building will ever have, but the plant, the stair bulkhead, the roof drains and the maintenance walkways get there first, and an array laid edge to edge shades itself and cannot be cleaned.',
    solution:
      'Fill the PV zone the roof plan reserves — clear of the plant zone and the parapet setback — with modules in rows one module wide, leaving a 0.5 m gap between rows for access and self-shading. Combine the strings at a combiner box next to the plant zone, invert beside it, and cap the array at the building demand so it stays behind the meter.',
    parameters: {
      moduleSize: { value: '1.0 × 1.7', unit: 'm', source: 'default (standard 60-cell module)' },
      moduleWp: { value: 400, unit: 'Wp', source: 'default (2024 monocrystalline)' },
      rowGap: { value: 0.5, unit: 'm', source: 'default (maintenance access, flat mount)' },
      parapetSetback: { value: 1.0, unit: 'm', source: 'code:NFPA 1 §11.12 / roof access' },
      targetCoverage: { value: 0.65, unit: 'fraction of the PV zone', source: 'default' },
      dcAcRatio: { value: 1.2, unit: 'ratio', source: 'default (string inverter sizing)' },
    },
    dependsOn: ['ARC-13'],
    references: ['NEC Art. 690', 'IEC 62548', 'AS/NZS 5033', 'MCS 012 (UK)'],
  },
  {
    id: 'ELE-10',
    name: 'Charge Where You Park',
    discipline: 'electrical',
    problem:
      'Retrofitting chargers into a finished car park means trenching the slab and running a new riser from the switchroom. Meanwhile a charger at every stall would double the service size for a load that is almost never coincident.',
    solution:
      'Put a charger at the head of every stall flagged EV-ready and one in every private garage, fed from a dedicated EV panel in the parking area, and size the panel with energy management: 50 % diversity across the chargers rather than the connected sum. Leave conduit capacity to the remaining stalls so the rest can be energised without breaking concrete.',
    parameters: {
      chargerPower: { value: 7.2, unit: 'kW', source: 'default (32 A at 230 V / 30 A at 240 V)' },
      chargerSize: { value: '0.3 × 0.15 × 1.2', unit: 'm', source: 'default (pedestal)' },
      evShare: { value: 0.2, unit: 'fraction of stalls', source: 'spec (site.parking.evShare)' },
      diversity: { value: 0.5, unit: 'factor', source: 'code:NEC 625.42 (energy management)' },
      circuitAmps: { value: 40, unit: 'A', source: 'code:NEC 625.41 (125 % continuous)' },
      partS: { value: '1 charge point per dwelling with parking', source: 'code:Approved Document S (2022)' },
    },
    dependsOn: ['SIT-06', 'ELE-11'],
    references: ['NEC Art. 625', 'Approved Document S 2022', 'AS/NZS 3000 §7.9', 'CEC 86-300'],
  },
  {
    id: 'ELE-11',
    name: 'Demand not Connected Load',
    discipline: 'electrical',
    problem:
      'Add up every nameplate in a building of forty dwellings and you will size a service two or three times larger than the building will ever draw — expensive switchgear, oversized conductors, a transformer the utility will not pay for. Guess low instead and the main trips on a cold January evening.',
    solution:
      'Calculate each dwelling as a demand, not a sum: general lighting at 33 VA/m², two small-appliance circuits and a laundry circuit, plus appliance nameplates — the first 10 kVA at 100 % and everything above it at 40 %, with heating or cooling added at 100 %. Then apply the multifamily demand factor to the sum of the dwellings (45 % at three to five dwellings falling to 23 % above sixty), add the house load at 100 %, and round up to the next standard frame size.',
    parameters: {
      generalLighting: { value: 33, unit: 'VA/m²', source: 'code:NEC 220.12 (3 VA/ft²)' },
      smallAppliance: { value: 1500, unit: 'VA per circuit × 2', source: 'code:NEC 220.52(A)' },
      laundry: { value: 1500, unit: 'VA', source: 'code:NEC 220.52(B)' },
      firstTranche: { value: 10000, unit: 'VA at 100 %', source: 'code:NEC 220.82(B)' },
      remainder: { value: 0.4, unit: 'factor', source: 'code:NEC 220.82(B)(3)' },
      hvacFactor: { value: 1.0, unit: 'factor', source: 'code:NEC 220.82(C)' },
      multifamily3to5: { value: 0.45, unit: 'factor', source: 'code:NEC Table 220.84' },
      multifamily62plus: { value: 0.23, unit: 'factor', source: 'code:NEC Table 220.84' },
      houseLighting: { value: 10, unit: 'VA/m² of common area', source: 'default' },
      elevatorLoad: { value: 20, unit: 'kVA each', source: 'default (MRL traction, 1000 kg)' },
      standardFrames: { value: '200/400/600/800/1200/1600/2000/2500/3000/4000', unit: 'A', source: 'default (switchboard frames)' },
    },
    references: ['NEC 220.12, 220.52, 220.82, 220.84', 'BS 7671 Appendix A (diversity)', 'IET On-Site Guide §A', 'AS/NZS 3000 App. C'],
  },
  {
    id: 'ELE-12',
    name: 'Risers at the Core',
    discipline: 'electrical',
    problem:
      'A riser placed for the convenience of one floor becomes a hole through every other floor. Scattered vertical runs steal saleable area, break compartmentation, and leave the busduct in the middle of somebody\'s living room three floors up.',
    solution:
      'Take the vertical distribution up the electrical or combined shaft beside the stair core, on the shaft\'s far corner so the mechanical duct (centre) and the plumbing stack (near corner) never collide with it: busduct above six storeys, cable riser below. Tap the riser at each floor into a floor distribution board on the corridor wall, and feed the dwellings from there.',
    parameters: {
      shaftCornerOffset: { value: 0.15, unit: 'm from the shaft max corner', source: 'default (coordination convention)' },
      busductSize: { value: '0.3 × 0.2', unit: 'm', source: 'default (800 A sandwich busduct)' },
      busductThreshold: { value: 6, unit: 'storeys', source: 'default' },
      floorBoardThreshold: { value: 4, unit: 'storeys', source: 'default' },
      fireStopping: { value: 'every floor penetration', source: 'code:IBC §714 / BS 7671 §527.2' },
    },
    dependsOn: ['XD-04'],
    references: ['XD-04 Shafts at the Core', 'NEC Art. 368 (Busways)', 'IBC §714', 'BS 7671 §527'],
  },
  {
    id: 'ELE-13',
    name: 'Light by Task not Watts',
    discipline: 'electrical',
    problem:
      'Lighting designed by watts per square metre gives a bedroom the same flat ceiling grid as a kitchen and leaves the worktop in the cook\'s shadow. Designed by fixture count alone, it either glares or fails to reach the task.',
    solution:
      'Set an illuminance target per room — 150 lx living, 300 lx kitchen and study, 200 lx bathroom, 100 lx bedroom and corridor, 150 lx stair — and derive the fixture count from the delivered lumens and a 0.7 maintained utilisation factor, taking the greater of the lux requirement and one fixture per 6 m². Then place them: a grid in the living space, a single centre fixture where a bedside lamp does the work, task light under the cabinets, a luminaire over the basin. Keep the installed density under 5 W/m² with LED sources.',
    parameters: {
      luxLiving: { value: 150, unit: 'lx', source: 'EN 12464-1 / IES RP-11' },
      luxKitchen: { value: 300, unit: 'lx', source: 'EN 12464-1 (work surface)' },
      luxBathroom: { value: 200, unit: 'lx', source: 'EN 12464-1' },
      luxBedroom: { value: 100, unit: 'lx', source: 'EN 12464-1 (general, task by lamp)' },
      luxCorridor: { value: 100, unit: 'lx', source: 'EN 12464-1 / IBC §1008 egress' },
      luxStair: { value: 150, unit: 'lx', source: 'EN 12464-1' },
      utilisation: { value: 0.7, unit: 'factor', source: 'default (maintained, flat ceiling)' },
      fixtureAreaRule: { value: 6, unit: 'm² per downlight', source: 'default' },
      gridSpacing: { value: 2.4, unit: 'm', source: 'default (0.9 × ceiling height)' },
      lpdTarget: { value: 5, unit: 'W/m²', source: 'code:ASHRAE 90.1-2022 Table 9.5.1 / Part L 2021' },
    },
    dependsOn: ['ELE-05'],
    references: ['EN 12464-1:2021', 'IES RP-11-20', 'ASHRAE 90.1-2022 §9', 'Approved Document L 2021'],
  },
];

export function elecPattern(id: string): Pattern | undefined {
  return ELEC_PATTERNS.find(p => p.id === id);
}
