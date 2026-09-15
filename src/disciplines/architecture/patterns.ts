/**
 * Architecture pattern book — the FLOOR ORGANISATION half (ARC-01..13, ARC-31..35).
 * The unit-layout half owns ARC-14..30 (`unit-patterns.ts`).
 *
 * Each pattern is Alexander-style: the recurring problem in context, then the parametric rule
 * that resolves it, with every number sourced (code clause, design guide, APL number, typology).
 */
import type { Pattern } from '../../core/types.ts';

export const FLOOR_PATTERNS: Pattern[] = [
  {
    id: 'ARC-01',
    name: 'Front Door on the Street',
    discipline: 'architecture',
    problem:
      'A dwelling reached through a shared lobby, a corridor and a lift has no address. Nobody feels responsible for the ground in front of it, and the street loses the small daily transactions — arriving, leaving, sweeping the step — that make it feel inhabited.',
    solution:
      'For direct-access typologies give every dwelling its own door on the street face, at the X position of the matching site entrance, raised a step or two above the footway and set back behind a shallow threshold (porch, stoop or gated forecourt). Party walls set the rhythm of doors; no dwelling is entered through another dwelling.',
    parameters: {
      doorWidth: { value: 0.9, unit: 'm', source: 'default (ADA 815 mm clear / Part M 800 mm clear)' },
      doorHeight: { value: 2.1, unit: 'm', source: 'default' },
      thresholdDepth: { value: 1.2, unit: 'm', source: 'Alexander APL #112 Entrance Transition' },
      entrancesPerDwelling: { value: 1, unit: 'count', source: 'typology access = direct' },
    },
    references: ['Alexander, A Pattern Language #102 Family of Entrances, #110 Main Entrance', 'IBC 2021 §1010'],
  },
  {
    id: 'ARC-02',
    name: 'Party Wall Rhythm',
    discipline: 'architecture',
    problem:
      'When dwellings are packed at arbitrary widths, the facade loses rhythm, the structure has no repeating line to follow, and no two floors stack. Every plan becomes a one-off.',
    solution:
      'Pick one unit module (the frontage) and repeat it. Party walls land on that module; every structural grid line, every downpipe and every window bay is a multiple of it. Corner and remnant bays absorb the leftover, never the typical bay.',
    parameters: {
      moduleTownhouse: { value: 6.0, unit: 'm', source: 'typology townhouse-row frontage 5.5–6.5' },
      moduleApartment: { value: 7.2, unit: 'm', source: 'template frontage = area / depth' },
      partyWallThickness: { value: 0.25, unit: 'm', source: 'SIZES.partyWallT (twin stud, acoustically isolated)' },
      acousticRating: { value: 'STC 55', source: 'IBC 2021 §1206.2 (STC 50 min), Approved Document E (DnT,w 45 dB)' },
    },
    dependsOn: ['ARC-01'],
    references: ['IBC 2021 §1206', 'Approved Document E', 'Alexander APL #205 Structure Follows Social Spaces'],
  },
  {
    id: 'ARC-03',
    name: 'Double-Loaded Corridor with Light at the Ends',
    discipline: 'architecture',
    problem:
      'A long internal corridor with units on both sides is the cheapest way to reach many dwellings and the bleakest. With no daylight and no end in sight it becomes a tunnel, and residents stop meeting in it.',
    solution:
      'Run the corridor down the middle of the bar and break it into legs no longer than 45 m. Put a window, a lift lobby or a stair with a window at each end and at each break, so from anywhere in the corridor you can see daylight. Widen the corridor at the lift lobbies so waiting does not block passing.',
    parameters: {
      corridorWidth: { value: 1.7, unit: 'm', source: 'typology corridorWidth (IBC 2021 §1020.2 min 1120 mm)' },
      maxLegLength: { value: 45, unit: 'm', source: 'default (daylight at both ends)' },
      maxCorridorLength: { value: 60, unit: 'm', source: 'warn threshold' },
      corridorWallThickness: { value: 0.2, unit: 'm', source: 'SIZES.corridorWallT (1HR rated)' },
      corridorFireRating: { value: '1HR', source: 'IBC 2021 Table 1020.1 (sprinklered R-2)' },
    },
    dependsOn: ['ARC-04'],
    references: ['IBC 2021 §1020', 'Alexander APL #131 The Flow Through Rooms, #132 Short Passages'],
  },
  {
    id: 'ARC-04',
    name: 'Core as Anchor',
    discipline: 'architecture',
    problem:
      'Stairs, lifts, risers and refuse chutes placed wherever they fit puncture every floor in a different place, force transfer structure, and leave residents hunting for the way out.',
    solution:
      'Gather the stair, the lift bank, the lift lobby and the service shafts into one rectangular core that repeats identically on every storey. The core is the only element that never moves; everything else is organised around it. Core walls are concrete or twin-rated, 2-hour, and load-bearing.',
    parameters: {
      coreWallThickness: { value: 0.25, unit: 'm', source: 'SIZES.coreWallT' },
      coreFireRating: { value: '2HR', source: 'IBC 2021 Table 1023.2 (4+ storeys → 2 h enclosure)' },
      stairWidth: { value: 1.1, unit: 'm', source: 'SIZES.stairWidth (IBC §1011.2 1120 mm sprinklered)' },
      elevatorShaft: { value: '2.0 x 2.2', unit: 'm', source: 'SIZES.elevatorShaftW/D' },
      liftLobbyDepth: { value: 1.6, unit: 'm', source: 'default (ASME A17.1 / BS 8300 waiting area)' },
    },
    references: ['IBC 2021 §1023', 'ASME A17.1', 'Alexander APL #158 Open Stairs'],
  },
  {
    id: 'ARC-05',
    name: 'Corner Units Dual Aspect',
    discipline: 'architecture',
    problem:
      'The ends of a double-loaded bar are the best real estate in the building — light from two directions, cross-ventilation, a view along two streets — and they are routinely wasted on a single-aspect studio or a store cupboard.',
    solution:
      'Reserve the two ends of every bar for the largest dual-aspect template in the mix (corner-2b2b if present). Give it the full bar depth and windows on both exterior faces, and put its living room in the corner itself.',
    parameters: {
      cornerTemplate: { value: 'corner-2b2b', source: 'unit mix (falls back to the largest template)' },
      exteriorSidesPerCornerUnit: { value: 2, unit: 'count', source: 'geometry' },
      minCornerFrontage: { value: 7.5, unit: 'm', source: 'template frontage.min' },
    },
    dependsOn: ['ARC-03'],
    references: ['Alexander APL #159 Light on Two Sides of Every Room', 'London Housing Design Guide 2.3.1'],
  },
  {
    id: 'ARC-06',
    name: 'Light on Two Sides of Every Room',
    discipline: 'architecture',
    problem:
      'Rooms lit from one side alone are read as gloomy whatever the lux level, because the eye judges brightness by the contrast between a wall and the window beside it. Deep single-aspect plans make every room a tunnel.',
    solution:
      'Keep the habitable depth from a window no greater than 2.5 times the floor-to-ceiling height, prefer dual-aspect and corner units, and pass the wwr target and the exterior sides to the unit layout so it can put the living space where two walls have glass.',
    parameters: {
      maxRoomDepthToCeilingRatio: { value: 2.5, unit: 'ratio', source: 'daylight rule of thumb (BS 8206-2)' },
      wwrTarget: { value: 0.35, unit: 'ratio', source: 'FloorSpec.wwr' },
      maxSingleAspectDepth: { value: 9.0, unit: 'm', source: 'London Housing SPG (single aspect ≤ 9 m)' },
    },
    dependsOn: ['ARC-05'],
    references: ['Alexander, A Pattern Language #159', 'BS 8206-2', 'London Housing SPG 2016'],
  },
  {
    id: 'ARC-07',
    name: 'Two per Landing',
    discipline: 'architecture',
    problem:
      'Past about four doors a landing stops being a shared front step and becomes a corridor: neighbours are strangers, the space is anonymous, and no dwelling can be dual aspect.',
    solution:
      'Serve 2 (mansion block) or 4 (walk-up) dwellings from each stair landing, one on each side of the core, each spanning the full depth of the bar so every dwelling has windows front and back. The landing is 2.4 m deep, daylit where possible, and no dwelling is more than a few steps from it.',
    parameters: {
      unitsPerCore: { value: 2, unit: 'count', source: 'typology unitsPerCore' },
      landingDepth: { value: 2.4, unit: 'm', source: 'default (IBC §1011.6 landing ≥ stair width)' },
      maxDoorsPerLanding: { value: 4, unit: 'count', source: 'Alexander APL #37 House Cluster' },
    },
    dependsOn: ['ARC-04'],
    references: ['Alexander APL #37 House Cluster', 'IBC 2021 §1011.6'],
  },
  {
    id: 'ARC-08',
    name: 'Typical Floor Repeats',
    discipline: 'architecture',
    problem:
      'If every floor is planned freshly, wet walls miss each other between storeys, risers zigzag, structure needs transfers and the building costs a third more to build for no benefit to anyone living in it.',
    solution:
      'Plan ONE typical residential floor and repeat it on every residential storey: identical unit rectangles, identical templates, identical wet-wall positions, identical shaft positions. Only the ground floor, the podium and the roof differ.',
    parameters: {
      typicalFloorsShared: { value: 1, unit: 'plan per (use, outline, mix)', source: 'default' },
      stackToleranceXY: { value: 0.0, unit: 'm', source: 'exact repetition' },
    },
    dependsOn: ['ARC-03', 'ARC-04'],
    references: ['XD-01 Wet Wall Stacking', 'XD-03 Structure Follows Party Walls'],
  },
  {
    id: 'ARC-09',
    name: 'Cross-Ventilation Single-Loaded',
    discipline: 'architecture',
    problem:
      'A double-loaded bar gives half its dwellings a single aspect, no through breeze and a hot side in summer. In a warm climate that means mechanical cooling for everyone.',
    solution:
      'Load the corridor on one side only and put the access on an open gallery or deck outside the envelope. Every dwelling then spans the bar and has openable windows on two opposite faces, giving a stack-and-breeze path across the plan. The deck gets a 1.1 m railing and doubles as a shared balcony.',
    parameters: {
      galleryWidth: { value: 1.5, unit: 'm', source: 'typology corridorWidth' },
      railingHeight: { value: 1.1, unit: 'm', source: 'IBC 2021 §1015.3 (1067 mm) / AS 1170.1' },
      crossVentOpeningRatio: { value: 0.05, unit: 'ratio of floor area per face', source: 'ASHRAE 62.2 / AS 1668.4' },
      dualAspectShare: { value: 1.0, unit: 'ratio', source: 'geometry (all units dual aspect)' },
    },
    dependsOn: ['ARC-03'],
    references: ['Alexander APL #159', 'CIBSE AM10'],
  },
  {
    id: 'ARC-10',
    name: 'Public Front / Private Back',
    discipline: 'architecture',
    problem:
      'A house with no gradient from street to garden has nowhere to receive a stranger and nowhere to be unobserved. Either the living room is on show or the front door opens straight into it.',
    solution:
      'Organise every house along one axis: street, threshold, entry and the formal rooms at the front; kitchen, family space and the garden at the back; bedrooms above the back. Service rooms and the stair sit on the party wall, out of the daylight.',
    parameters: {
      frontZoneDepth: { value: 4.5, unit: 'm', source: 'default (front room depth)' },
      rearZoneDepth: { value: 5.5, unit: 'm', source: 'default (kitchen-dining to garden)' },
      entryThresholdDepth: { value: 1.2, unit: 'm', source: 'Alexander APL #112' },
    },
    dependsOn: ['ARC-01'],
    references: ['Alexander, A Pattern Language #127 Intimacy Gradient, #112 Entrance Transition'],
  },
  {
    id: 'ARC-11',
    name: 'Garage as Side Wing',
    discipline: 'architecture',
    problem:
      'A garage pushed to the front centre of a house turns the street elevation into a door for a car, buries the front door and kills the habitable frontage.',
    solution:
      'Put the garage in the end bay of the frontage, recessed behind the plane of the front door, with the habitable rooms and the entry holding the street. The garage is a single 2.6 m leaf, 6 m deep, with a direct door into the hall.',
    parameters: {
      garageDoorWidth: { value: 2.6, unit: 'm', source: 'default (single car)' },
      garageDoorHeight: { value: 2.2, unit: 'm', source: 'default' },
      garageDepth: { value: 6.0, unit: 'm', source: 'SIZES.parkingStallL + clearance' },
      recessFromFrontDoor: { value: 0.6, unit: 'm', source: 'default' },
    },
    dependsOn: ['ARC-10'],
    references: ['Alexander APL #113 Car Connection'],
  },
  {
    id: 'ARC-12',
    name: 'Cluster Around a Shared Hearth',
    discipline: 'architecture',
    problem:
      'Co-living reduced to a corridor of bedsits gives its residents neither privacy nor company: the shared kitchen is a leftover at the end of the hall and nobody uses it.',
    solution:
      'Group 4–8 private ensuite rooms into one cluster that has its own front door, and put the shared kitchen-living at the heart of the cluster where every room passes through it. The cluster takes a large frontage on the corridor, and building-wide amenity sits on the ground floor.',
    parameters: {
      roomsPerCluster: { value: 6, unit: 'count', source: 'template coliving-cluster' },
      clusterFrontage: { value: 14.0, unit: 'm', source: 'template frontage.max' },
      sharedAreaPerResident: { value: 4.0, unit: 'm²/person', source: 'UK HMO / co-living guidance' },
    },
    dependsOn: ['ARC-03'],
    references: ['Alexander APL #37 House Cluster, #129 Common Areas at the Heart'],
  },
  {
    id: 'ARC-13',
    name: 'Universal Corridor',
    discipline: 'architecture',
    problem:
      'Standard corridors and doorways defeat a walking frame, a wheelchair or a stretcher. In senior housing that turns an ordinary day into a series of obstacles and a fall into an emergency.',
    solution:
      'Widen corridors to 2.0 m so two wheelchairs pass and a resident can rest, use 0.9 m clear door leaves with lever hardware throughout, keep thresholds flush, and put a handrail and continuous even lighting along both corridor walls.',
    parameters: {
      corridorWidth: { value: 2.0, unit: 'm', source: 'typology senior-living corridorWidth' },
      doorClearWidth: { value: 0.9, unit: 'm', source: 'ADA 404.2.3 / Part M Table 2' },
      doorHardware: { value: 'lever', source: 'ADA 309.4 (no tight grasping)' },
      thresholdMax: { value: 0.013, unit: 'm', source: 'ADA 303.2' },
      handrailHeight: { value: 0.9, unit: 'm', source: 'ADA 505.4' },
    },
    dependsOn: ['ARC-03'],
    references: ['ADA Standards 2010', 'Approved Document M Vol 1', 'AS 1428.1'],
  },
  {
    id: 'ARC-31',
    name: 'Lobby Sequence',
    discipline: 'architecture',
    problem:
      'Stepping straight from the footway into a lift creates no transition: you are still in public when you reach your door. Post, parcels, buggies and bikes then silt up wherever there is room.',
    solution:
      'Order the ground floor as a sequence: entrance recess → lobby with daylight and a place to stand → post and parcels → lift lobby → the door home. Bikes, refuse and plant are entered off the same lobby but from the back, never across it.',
    parameters: {
      lobbyArea: { value: 40, unit: 'm²', source: 'default' },
      mailArea: { value: 8, unit: 'm²', source: 'default (parcel lockers + boxes)' },
      entranceDoorWidth: { value: 1.8, unit: 'm', source: 'SIZES.doorBuildingEntry (double leaf)' },
      sequenceSteps: { value: 4, unit: 'count', source: 'entrance, lobby, mail, lift lobby' },
    },
    dependsOn: ['ARC-04'],
    references: ['Alexander, A Pattern Language #112 Entrance Transition, #130 Entrance Room'],
  },
  {
    id: 'ARC-32',
    name: 'Shafts Beside Cores',
    discipline: 'architecture',
    problem:
      'Mechanical, electrical and refuse risers invented late in the design end up inside dwellings, so every floor is punctured in a different place and maintenance means entering someone\'s home.',
    solution:
      'Give every core a shaft bay immediately beside it, accessed from the corridor, holding one combined mechanical/electrical riser and (above three storeys) a refuse chute. The bay runs the full depth of the unit strip; whatever is left of it becomes resident storage.',
    parameters: {
      combinedShaft: { value: '1.2 x 0.8', unit: 'm', source: 'XD-04' },
      trashChute: { value: '1.0 x 1.0', unit: 'm', source: 'default (min 4 storeys)' },
      shaftWallThickness: { value: 0.15, unit: 'm', source: 'SIZES.shaftWallT' },
      shaftAreaPerUnitServed: { value: 0.12, unit: 'm²/unit', source: 'XD-04' },
      accessFrom: { value: 'corridor', source: 'XD-04' },
    },
    dependsOn: ['ARC-04'],
    references: ['XD-04 Shafts at the Core', 'IBC 2021 §713 shaft enclosures'],
  },
  {
    id: 'ARC-33',
    name: 'Egress Travel Limit',
    discipline: 'architecture',
    problem:
      'A dwelling far from a stair is a dwelling whose occupants cannot get out in time, and a corridor with one exit at one end doubles every journey.',
    solution:
      'Measure travel from the farthest unit entry door along the corridor centreline to the nearest exit stair and keep it under the code limit. Place cores so each serves the corridor from within half the limit, and give every stair a direct exit door to the outside at ground.',
    parameters: {
      maxTravelSprinklered: { value: 76, unit: 'm', source: 'IBC 2021 Table 1017.2 (R-2 sprinklered, 250 ft)' },
      maxTravelUnsprinklered: { value: 61, unit: 'm', source: 'IBC 2021 Table 1017.2 (200 ft)' },
      maxCommonPath: { value: 38, unit: 'm', source: 'IBC 2021 Table 1006.2.1 (125 ft, R-2 sprinklered)' },
      exitDoorWidth: { value: 1.0, unit: 'm', source: 'IBC §1010.1.1' },
    },
    dependsOn: ['ARC-03', 'ARC-04'],
    references: ['IBC 2021 §1017', 'Approved Document B Vol 1 §3'],
  },
  {
    id: 'ARC-34',
    name: 'Retail Frontage on the Street',
    discipline: 'architecture',
    problem:
      'A blank residential ground floor on a busy street gives nothing back to it: no shelter, nothing to look at, nobody watching. The dwellings behind the blank wall are the worst in the building anyway.',
    solution:
      'Give the whole street face of the ground floor to shallow retail tenancies with a full-height glazed shopfront (sill 0.3 m, head 3.3 m), one entrance per tenancy, and a taller floor-to-floor. The residential lobby takes one bay beside a core; servicing and refuse are reached from the rear.',
    parameters: {
      shopfrontSill: { value: 0.3, unit: 'm', source: 'default' },
      shopfrontHeight: { value: 3.0, unit: 'm', source: 'default' },
      tenancyArea: { value: 120, unit: 'm²', source: 'default (small shop unit)' },
      groundFloorToFloor: { value: 4.5, unit: 'm', source: 'typology mixed-use-midrise floorToFloor.ground' },
      activeFrontageRatio: { value: 0.7, unit: 'ratio of street face', source: 'default' },
    },
    dependsOn: ['ARC-31'],
    references: ['Alexander APL #87 Individually Owned Shops, #121 Path Shape', 'Urban Design Compendium'],
  },
  {
    id: 'ARC-35',
    name: 'Roof Reserved for Plant and Sun',
    discipline: 'architecture',
    problem:
      'The roof is the last surface anybody plans. Plant lands in the middle of it, and the array that would have powered the building has nowhere to go — or shades itself on the plant.',
    solution:
      'Divide the flat roof once: a plant zone of about 15% of the area next to a core (so risers rise straight into it), a 1 m maintenance margin at every edge inside the parapet, and the whole remainder reserved for PV. Parapets are 1.1 m.',
    parameters: {
      plantZoneShare: { value: 0.15, unit: 'ratio of roof area', source: 'default' },
      edgeMargin: { value: 1.0, unit: 'm', source: 'default (fall protection / maintenance)' },
      parapetHeight: { value: 1.1, unit: 'm', source: 'MassingSpec.parapetHeight (IBC §1015.3)' },
      gablePitch: { value: 30, unit: 'deg', source: 'MassingSpec.roofPitchDeg' },
    },
    references: ['IBC 2021 §1015', 'Alexander APL #117 Sheltering Roof'],
  },
];
