/**
 * Mechanical pattern language (MEC-01 … MEC-12).
 *
 * Alexander-style: each pattern names a recurring problem in residential HVAC, then gives
 * the parametric rule this generator actually follows. Parameters carry units and the code
 * clause, design guide or APL number they come from.
 */
import type { Pattern } from '../../core/types.ts';

export const MECH_PATTERNS: Pattern[] = [
  {
    id: 'MEC-01',
    name: 'System Follows Typology and Region',
    discipline: 'mechanical',
    problem:
      'An HVAC system chosen from habit rather than from climate and building form produces absurdities: chilled-water plant in a three-storey walk-up, or ducted cooling in a Dublin flat that never needs it. Every region has evolved a dominant residential system and a supply chain to match it, and a building that ignores it costs more and is serviced worse.',
    solution:
      'Take the system from the typology (its default reflects the region and form it belongs to) and the load intensities from the region table. Houses and low-rise get per-dwelling packaged equipment; mid-rise with a corridor gets per-dwelling ducted heat pumps or PTACs plus a corridor make-up air spine; towers get VRF or central plant with risers in the cores. The dwelling never gets a system its occupants cannot operate from one thermostat.',
    parameters: {
      system: { value: 'typology.hvac', source: 'typology' },
      ventilationStrategy: { value: 'typology.ventilation', source: 'typology' },
      coolingWPerM2: { value: '40–70 by region', unit: 'W/m²', source: 'ACCA Manual J / CIBSE Guide A / NCC 2022' },
      heatingWPerM2: { value: '30–70 by region', unit: 'W/m²', source: 'CSA F280 / Part L 2021 / NZBC H1' },
    },
    references: ['ASHRAE Handbook — HVAC Systems and Equipment, Ch. 1', 'CIBSE Guide B'],
  },
  {
    id: 'MEC-02',
    name: 'Short Ducts from a Central Hall',
    discipline: 'mechanical',
    problem:
      'Ductwork that wanders around a dwelling to reach the far corners loses heat, leaks air, whistles, and forces dropped ceilings in rooms where people notice them. Long branches also unbalance: the room at the end of the run is always the cold one.',
    solution:
      'Put the air handler in a closet or the hall ceiling at the dwelling\'s centre of gravity, run one flat rectangular trunk along the hall ceiling, and take a short round branch off it into each habitable room, stopping at the room edge nearest the hall. No supply run exceeds 12 m of developed length, and no duct crosses a bedroom.',
    parameters: {
      maxRunLength: { value: 12, unit: 'm', source: 'default (ACCA Manual D friction-rate practice)' },
      trunkDepth: { value: 0.25, unit: 'm', source: 'default (fits a 300 mm hall bulkhead)' },
      trunkVelocity: { value: 5.0, unit: 'm/s', source: 'ASHRAE Handbook — Fundamentals Ch. 21 (residential trunk)' },
      branchVelocity: { value: 4.0, unit: 'm/s', source: 'ASHRAE Handbook — Fundamentals Ch. 21 (residential branch)' },
      branchDiameter: { value: '0.10–0.25', unit: 'm', source: 'default ladder' },
    },
    dependsOn: ['ARC-01'],
    references: ['ACCA Manual D', 'ASHRAE Handbook — Fundamentals Ch. 21'],
  },
  {
    id: 'MEC-03',
    name: 'Exhaust Rises in the Wet Wall',
    discipline: 'mechanical',
    problem:
      'Bathroom and kitchen extract ducts that find their own way to a facade puncture the envelope once per room per floor, cross other dwellings, and cannot be balanced or fire-stopped economically.',
    solution:
      'Every extract grille runs the shortest path to the dwelling\'s wet wall, joins the other wet rooms above the ceiling, and rises in the nearest shared shaft to a roof fan. Kitchen extract keeps its own duct and its own riser all the way to the roof; general extract and dryer extract share one riser. Houses, which have no shaft, discharge horizontally through the nearest exterior wall instead.',
    parameters: {
      bathroomExtract: { value: 25, unit: 'l/s', source: 'code:Approved Document F 2021 Table 1.2 (intermittent)' },
      wcExtract: { value: 13, unit: 'l/s', source: 'code:Approved Document F 2021 Table 1.2' },
      kitchenExtract: { value: 50, unit: 'l/s', source: 'code:ADF Table 1.2 / ASHRAE 62.2 Table 5.1 (100 cfm)' },
      extractDuctDiameter: { value: '0.10–0.15', unit: 'm', source: 'default' },
      maxDistanceToShaft: { value: 12, unit: 'm routed', source: 'default (beyond this, discharge through the facade instead — towers excepted)' },
      separateKitchenRiser: { value: true, source: 'code:IMC 2021 §506.3 (independent kitchen exhaust)' },
    },
    dependsOn: ['XD-01', 'XD-04'],
    references: ['Approved Document F 2021', 'ASHRAE 62.2-2019 §5', 'IMC 2021 §506'],
  },
  {
    id: 'MEC-04',
    name: 'Outdoor Units Out of Sight',
    discipline: 'mechanical',
    problem:
      'Condensers bolted to the front facade or dropped on the entrance path define how the building is seen and heard. They also need air, service access and a route for refrigerant that does not cross a dwelling.',
    solution:
      'Place each dwelling\'s outdoor unit on its own balcony first (short refrigerant line, private service access, screened by the balustrade); if the dwelling has no balcony, put it in the roof plant zone and run refrigerant up the shaft; only if there is no roof zone put it on a screened ground pad at the rear, never on the street elevation.',
    parameters: {
      preferenceOrder: { value: 'balcony → roof plant zone → rear ground pad', source: 'default' },
      outdoorUnitSize: { value: '0.90 × 0.35 × 0.80', unit: 'm', source: 'default (typical residential inverter ODU)' },
      serviceClearance: { value: 0.3, unit: 'm', source: 'manufacturer typical' },
      maxRefrigerantLine: { value: 30, unit: 'm', source: 'manufacturer typical (mini-split)' },
    },
    dependsOn: ['ARC-07'],
    references: ['Alexander APL #160 Building Edge'],
  },
  {
    id: 'MEC-05',
    name: 'Corridor Make-up Air Spine',
    discipline: 'mechanical',
    problem:
      'A double-loaded corridor with extract in every bathroom goes negative: doors slam, dwelling extract fans stall, and smells travel from flat to flat through the corridor.',
    solution:
      'Run one rectangular make-up air duct on the corridor centreline in the duct lane of the plenum, fed by a riser in the shaft nearest the core from a rooftop unit, with a diffuser every 9 m. The corridor is held slightly positive so air moves from the corridor into the dwellings and out through their wet rooms.',
    parameters: {
      makeUpAirRate: { value: 0.5, unit: 'l/s·m² of corridor', source: 'default (≈0.1 cfm/ft², corridor positive)' },
      diffuserSpacing: { value: 9, unit: 'm', source: 'default' },
      ductLane: { value: 0, unit: 'm from corridor centreline', source: 'XD-02' },
      ductDepth: { value: 0.3, unit: 'm', source: 'XD-02 plenum band' },
      rtuSize: { value: '2.40 × 1.20 × 1.40', unit: 'm', source: 'default' },
    },
    dependsOn: ['XD-02', 'ARC-03'],
    references: ['ASHRAE 62.1-2019 Table 6.2.2.1 (corridors)', 'IMC 2021 §403'],
  },
  {
    id: 'MEC-06',
    name: 'Plant on the Roof',
    discipline: 'mechanical',
    problem:
      'Plant scattered over a site — condensers between the bike store and the bins, an AHU in the only ground-floor room with a window — eats lettable area and gives every neighbour something to complain about.',
    solution:
      'Collect shared plant in a roof plant zone sized at 0.25 m² per dwelling, laid out on a grid with 1 m service aisles, set back from the parapet behind a screen. Only plant that must be indoors (boilers, pumps, water-side plant) goes in a ground mechanical room.',
    parameters: {
      plantAreaPerUnit: { value: 0.25, unit: 'm²/dwelling', source: 'default' },
      aisleWidth: { value: 1.0, unit: 'm', source: 'default (service access)' },
      condensersPerVrfCircuit: { value: 8, unit: 'dwellings/condenser', source: 'default' },
      screenHeight: { value: 1.8, unit: 'm', source: 'planning typical' },
    },
    dependsOn: ['ARC-07', 'SIT-02'],
    references: ['Alexander APL #118 Roof Garden (plant kept off the useful roof)'],
  },
  {
    id: 'MEC-07',
    name: 'Pressurised Stairs above 23 m',
    discipline: 'mechanical',
    problem:
      'In a tall building the stair is the only way out and the only way in for the fire service. Smoke that enters it at the fire floor makes the whole stair useless.',
    solution:
      'Above 23 m to the highest occupied floor, give every stair core a roof-mounted pressurisation fan holding the stair positive relative to the accommodation, sized on the door-open case.',
    parameters: {
      heightTrigger: { value: 23, unit: 'm to highest occupied floor', source: 'code:IBC 2021 §403/§909.20; BS EN 12101-6 / ADB Vol 1' },
      pressureDifferential: { value: 50, unit: 'Pa (all doors closed)', source: 'code:BS EN 12101-6 Class A; NFPA 92' },
      doorOpenVelocity: { value: 0.75, unit: 'm/s through the open door', source: 'code:NFPA 92 §4.4.2' },
      fanSize: { value: '1.20 × 1.20 × 1.00', unit: 'm', source: 'default' },
    },
    references: ['IBC 2021 §909.20', 'NFPA 92', 'BS EN 12101-6', 'Approved Document B Vol 1'],
  },
  {
    id: 'MEC-08',
    name: 'Heating Under the Window',
    discipline: 'mechanical',
    problem:
      'A cold window sheds a downdraught across the floor and the room feels cold even when the air is warm. Heat emitters placed on an internal wall leave that draught to run under the furniture.',
    solution:
      'Put the emitter — panel radiator or packaged terminal unit — centred under the window of every habitable room, its length roughly 60% of the window width, its top below the sill so the curtain does not cover it.',
    parameters: {
      radiatorSize: { value: '1.00 × 0.10 × 0.60', unit: 'm', source: 'default (double-panel 600 mm)' },
      radiatorMountingZ: { value: 0.15, unit: 'm above finished floor', source: 'default' },
      ptacSize: { value: '1.07 × 0.60 × 0.40', unit: 'm', source: 'default (42" PTAC chassis)' },
      emitterBelowSill: { value: 0.05, unit: 'm clear below the sill', source: 'default' },
    },
    dependsOn: ['ARC-10'],
    references: ['Alexander APL #180 Window Place', 'CIBSE Domestic Heating Design Guide'],
  },
  {
    id: 'MEC-09',
    name: 'Balanced Ventilation per Dwelling',
    discipline: 'mechanical',
    problem:
      'Extract-only ventilation in an airtight dwelling pulls its make-up air through whatever leaks it can find — the corridor, the neighbour\'s flat, the flue — and throws away all the heat it moves.',
    solution:
      'Give each dwelling one balanced heat-recovery box: supply ducts to the habitable rooms, extract ducts from the wet rooms, and a matched pair of outdoor-air and discharge ducts through the nearest exterior wall (or up the shaft in a tower). Size the whole-dwelling rate from occupancy, not area.',
    parameters: {
      ashraeRate: { value: '0.15 l/s·m² + 3.5 l/s/person', source: 'code:ASHRAE 62.2-2019 §4.1.1' },
      partFRate: { value: '13 / 17 / 21 / 25 / 29 l/s for 1–5 bedrooms', source: 'code:Approved Document F 2021 Table 1.3' },
      heatRecoveryEfficiency: { value: 0.85, unit: 'fraction', source: 'default (MVHR certified range 0.80–0.92)' },
      intakeExhaustSeparation: { value: 1.0, unit: 'm', source: 'code:ASHRAE 62.2 §6.8 / ADF §1.28' },
      towerRoutesToShaft: { value: 8, unit: 'storeys above which intake/discharge use the shaft', source: 'default' },
    },
    dependsOn: ['XD-05'],
    references: ['ASHRAE 62.2-2019', 'Approved Document F 2021 System 4'],
  },
  {
    id: 'MEC-10',
    name: 'One Thermostat per Home',
    discipline: 'mechanical',
    problem:
      'Controls that live in a cupboard, or one per room with no hierarchy, mean nobody knows how to make the dwelling warmer. Shared controls between dwellings are worse: they guarantee an argument.',
    solution:
      'Give every dwelling exactly one thermostat, on an interior hall wall at 1.5 m, away from a draught, a radiator and direct sun; it commands that dwelling\'s heating, cooling and boost ventilation and nothing else. The electrical discipline picks it up from `mech.equipment` type `thermostat` and runs its cable.',
    parameters: {
      count: { value: 1, unit: 'per dwelling', source: 'default' },
      mountingZ: { value: 1.5, unit: 'm above finished floor', source: 'coordination.MOUNTING.thermostat; ADA 308 reach range' },
      size: { value: '0.10 × 0.03 × 0.10', unit: 'm', source: 'default' },
      wall: { value: 'interior hall wall', source: 'default' },
    },
    dependsOn: ['MEC-01'],
    references: ['ASHRAE 55 §7.6 (sensor location)', 'Alexander APL #142 Sequence of Sitting Spaces (control where you live)'],
  },
  {
    id: 'MEC-11',
    name: 'Range Hood over the Range',
    discipline: 'mechanical',
    problem:
      'Cooking is the biggest indoor pollution source in a home. A recirculating filter, or a hood on the wrong wall, leaves grease and moisture to travel through the whole dwelling.',
    solution:
      'Put a ducted hood directly over the range, its face 0.75 m above the cooktop, the same width as the appliance or wider, with a dedicated smooth-bore duct to the kitchen-exhaust riser or straight out through the wall — never shared with bathroom extract.',
    parameters: {
      hoodSize: { value: '0.76 × 0.50 × 0.15', unit: 'm', source: 'default (30" hood)' },
      faceHeightAboveCooktop: { value: 0.75, unit: 'm', source: 'manufacturer typical / ADF §1.31' },
      airflow: { value: 50, unit: 'l/s', source: 'code:ASHRAE 62.2 Table 5.1 (100 cfm vented hood)' },
      ductDiameter: { value: 0.15, unit: 'm', source: 'code:IMC 2021 §505 (smooth, no screens)' },
      dedicatedDuct: { value: true, source: 'code:IMC 2021 §506.3.1' },
    },
    dependsOn: ['ARC-11'],
    references: ['ASHRAE 62.2-2019 Table 5.1', 'IMC 2021 §505'],
  },
  {
    id: 'MEC-12',
    name: 'Loads from People not Area',
    discipline: 'mechanical',
    problem:
      'Sizing a dwelling\'s systems from floor area alone gives a studio for one person the same fresh-air rate per square metre as a family flat, and oversizes everything in the big units while starving the small ones.',
    solution:
      'Derive design occupancy as bedrooms + 1 and size ventilation from it (ASHRAE 62.2 adds 3.5 l/s per person to a 0.15 l/s·m² base; Part F tabulates the whole-dwelling rate by bedroom count). Take cooling and heating from the regional intensity times the dwelling area, then size supply air from the cooling load at 400 cfm/ton.',
    parameters: {
      occupancy: { value: 'bedrooms + 1', unit: 'persons', source: 'XD-05 / ASHRAE 62.2 §4.1.1' },
      ventilationPerPerson: { value: 3.5, unit: 'l/s·person', source: 'code:ASHRAE 62.2-2019 §4.1.1' },
      ventilationPerArea: { value: 0.15, unit: 'l/s·m²', source: 'code:ASHRAE 62.2-2019 §4.1.1' },
      supplyAirPerCooling: { value: 53.7, unit: 'l/s per kW (400 cfm/ton)', source: 'ACCA Manual S' },
    },
    dependsOn: ['XD-05'],
    references: ['ASHRAE 62.2-2019', 'ACCA Manual J / Manual S'],
  },
];

export const MECH_PATTERN_IDS = MECH_PATTERNS.map(p => p.id);
