/**
 * Pattern language for the inside of a dwelling — ARC-14 … ARC-30.
 *
 * ARC-01 … ARC-13 belong to the floor organizer (massing, cores, corridors, unit packing, roof);
 * these are the patterns the unit layout engine applies room by room. Every one of them is applied
 * with concrete parameters by `layoutUnit`, which returns the applications in `UnitLayout.patterns`.
 *
 * `references` are real: IRC/IBC sections, London Plan 2021 + Housing Design Standards LPG,
 * NCC 2022, ADA 2010, Approved Document M, and Alexander et al., *A Pattern Language* (1977)
 * pattern numbers.
 */
import type { Pattern } from '../../core/types.ts';

export const UNIT_PATTERNS: Pattern[] = [
  {
    id: 'ARC-14',
    name: 'Wet Core Backs the Entry',
    discipline: 'architecture',
    problem:
      'Kitchens and bathrooms placed wherever they fit leave plumbing chasing the plan: long branch runs, many slab penetrations, stacks that cannot line up between floors, and windows wasted on rooms that do not need them.',
    solution:
      'Put every wet room in one band 2.4–4.4 m deep along the access side of the unit, and stand them all against a single thicker wall at the back of that band. The kitchen, the bathrooms, the laundry and the entry share that band; the rooms that need daylight get the whole of the opposite band. One wet wall per unit, one stack per wet wall, the same position on every floor.',
    parameters: {
      frontBandDepth: { value: 3.0, unit: 'm', source: 'default (kitchen run 0.6 + 1.2 aisle + 0.6 counter/appliance)' },
      frontBandDepthRange: { value: '2.4–4.4', unit: 'm', source: 'default' },
      wetWallThickness: { value: 0.2, unit: 'm', source: 'SIZES.wetWallT (2×6 / 150 mm studs + boarding both faces)' },
      maxFixtureToStack: { value: 3.0, unit: 'm', source: 'IPC 2021 Table 1002.2 trap-arm length' },
    },
    dependsOn: ['XD-01'],
    references: ['IPC 2021 §1002', 'BS EN 12056-2', 'Alexander APL #197 Thick Walls'],
  },
  {
    id: 'ARC-15',
    name: 'Furniture Fits',
    discipline: 'architecture',
    problem:
      'A room that meets an area minimum can still be unusable: a 2.4 m wide bedroom takes a double bed and leaves no way past it, and a 1.5 m wide kitchen cannot open a dishwasher.',
    solution:
      'Size every room from the furniture it must hold plus its clearances, not from area alone. Double bedroom = bed 1.37 × 1.9 + 0.75 m access on both long sides + 0.7 m at the foot → 2.75 m minimum clear width and 11.5 m². Single bedroom = 0.99 × 1.9 bed + 0.75 m one side → 2.15 m and 7.5 m². Kitchen = 0.6 m counter + 1.2 m aisle → 1.8 m one-sided, 2.4 m with appliances opposite. Bathroom = WC 0.4 × 0.7 with 0.75 m clear in front and 0.4 m to the centreline from a side wall, basin 0.6, shower 0.9 × 0.9 → 1.7 × 2.2 m, 3.7 m². Dining = 0.6 m of table edge per person + 0.75 m chair pull-out.',
    parameters: {
      doubleBedroomMinWidth: { value: 2.75, unit: 'm', source: 'London Plan 2021 Housing Design Standards LPG Table 3.1' },
      doubleBedroomMinArea: { value: 11.5, unit: 'm²', source: 'London Plan 2021 LPG Table 3.1' },
      singleBedroomMinWidth: { value: 2.15, unit: 'm', source: 'London Plan 2021 LPG Table 3.1' },
      singleBedroomMinArea: { value: 7.5, unit: 'm²', source: 'London Plan 2021 LPG Table 3.1' },
      habitableRoomMinArea: { value: 6.5, unit: 'm²', source: 'IRC 2021 R304.1 (70 sq ft)' },
      bedSideClearance: { value: 0.75, unit: 'm', source: 'default (Neufert)' },
      kitchenAisle: { value: 1.2, unit: 'm', source: 'default; 1.5 m where accessible' },
      bathroomMinArea: { value: 3.7, unit: 'm²', source: 'default (1.7 × 2.2 three-piece)' },
    },
    references: ['London Plan 2021 Policy D6', 'Technical Housing Standards (NDSS) 2015 Table 1', 'IRC 2021 R304', 'Neufert, Architects’ Data 5th ed.'],
  },
  {
    id: 'ARC-16',
    name: 'Windows by Wall Ratio',
    discipline: 'architecture',
    problem:
      'Windows drawn by eye either under-light deep rooms or over-glaze a façade until it cannot meet an energy target, and a sill at the wrong height blocks the view when you are sitting down.',
    solution:
      'Give each room a share of its exterior wall proportional to its frontage, then glaze that share to the floor\'s window-to-wall ratio: window area = WWR × (room wall length × floor-to-floor). Split the result into 0.9–2.4 m wide openings centred on the room\'s wall span, head at 2.3 m, sill 0.9 m — dropped to 0.6 m in living rooms when the WWR is above 0.4 so that a seated person sees the ground.',
    parameters: {
      wwrDefault: { value: 0.35, unit: 'ratio', source: 'spec.floors[].wwr' },
      windowHeight: { value: 1.4, unit: 'm', source: 'SIZES.windowHeight' },
      sillDefault: { value: 0.9, unit: 'm', source: 'SIZES.windowSill' },
      sillLowLiving: { value: 0.6, unit: 'm', source: 'default when wwr > 0.4' },
      widthMin: { value: 0.9, unit: 'm', source: 'default' },
      widthMax: { value: 2.4, unit: 'm', source: 'default (manufacturable single sash/lift)' },
      minGlazingOfFloorArea: { value: 0.08, unit: 'ratio', source: 'IRC 2021 R303.1 (8% of floor area)' },
    },
    references: ['IRC 2021 R303.1', 'Approved Document L 2021', 'NCC 2022 Part 3.12', 'Alexander APL #221 Natural Doors and Windows'],
  },
  {
    id: 'ARC-17',
    name: 'Balcony as Outdoor Room',
    discipline: 'architecture',
    problem:
      'Balconies less than about 1.8 m deep are never used: there is no room for a table and two chairs, and anyone sitting on them feels exposed to the street.',
    solution:
      'Make the private outdoor space at least 1.8 m deep and at least 1.5 m² per bedspace, hang it off the living room, and open it with a 1.8 m sliding door so the inside and the outside read as one room. Furnish it with a table and two chairs to prove it works.',
    parameters: {
      minDepth: { value: 1.8, unit: 'm', source: 'Alexander APL #167 Six-Foot Balcony' },
      minArea1b: { value: 5.0, unit: 'm²', source: 'London Plan 2021 Policy D6 (5 m² for 1–2 person dwellings)' },
      areaPerExtraPerson: { value: 1.0, unit: 'm²', source: 'London Plan 2021 Policy D6' },
      doorWidth: { value: 1.8, unit: 'm', source: 'default sliding pair' },
    },
    references: ['Alexander APL #167', 'London Plan 2021 Policy D6', 'NCC 2022 Part 3.9 (balustrade 1.0 m)'],
  },
  {
    id: 'ARC-18',
    name: 'Entry Hall Transition',
    discipline: 'architecture',
    problem:
      'A front door opening straight into the living room gives no place to put down shopping, hang a coat or stand while the door is open, and it exposes the whole dwelling to the corridor.',
    solution:
      'Hold a transition space 1.2–1.8 m wide and at least 2 m² immediately inside the entry door, with a bench and a coat closet, and let it be the room that distributes to everything else. Never let the entry door swing collide with an internal door.',
    parameters: {
      minWidth: { value: 1.2, unit: 'm', source: 'default' },
      minArea: { value: 2.0, unit: 'm²', source: 'default' },
      entryDoorWidth: { value: 0.9, unit: 'm', source: 'SIZES.doorUnitEntry' },
      clearFloorInside: { value: 1.5, unit: 'm', source: 'ADA 2010 §404.2.4 manoeuvring clearance (accessible units)' },
    },
    references: ['Alexander APL #112 Entrance Transition', 'Alexander APL #130 Entrance Room', 'ADA 2010 §404'],
  },
  {
    id: 'ARC-19',
    name: 'Bedroom Privacy Gradient',
    discipline: 'architecture',
    problem:
      'When bedrooms open off the living room, nobody can sleep while anyone else is awake, and a visitor at the door sees straight into the most private part of the home.',
    solution:
      'Order the plan along the intimacy gradient: entry, then the public rooms, then a hall, then the bedrooms at the far end of the frontage from the front door. Put the bathrooms and closets between the hall and the bedrooms so no bedroom shares a wall with a living space.',
    parameters: {
      hallWidth: { value: 1.2, unit: 'm', source: 'default (0.9 m clear minimum + door architraves)' },
      minHallWidthAccessible: { value: 1.2, unit: 'm', source: 'ADA 2010 §403.5.1 (0.915 m) + turning space' },
      bedroomsFromEntry: { value: 'farthest', source: 'Alexander APL #127' },
    },
    references: ['Alexander APL #127 Intimacy Gradient', 'Alexander APL #141 A Room of One’s Own'],
  },
  {
    id: 'ARC-20',
    name: 'Kitchen Work Triangle',
    discipline: 'architecture',
    problem:
      'A kitchen laid out as a line of cabinets with the fridge at the wrong end makes every meal a walk, and a sink far from the wet wall drags waste pipes across the floor.',
    solution:
      'Put the sink on the wet wall, the range in the same run at least 0.6 m from it, and the fridge at the end of the run nearest the entry. Keep the sum of the three legs between 4 and 8 m, with no leg under 1.2 m, and keep a 1.2 m aisle (1.5 m where accessible) clear in front of the run. The dishwasher goes immediately beside the sink.',
    parameters: {
      triangleMin: { value: 4.0, unit: 'm', source: 'NKBA Kitchen Planning Guideline 5' },
      triangleMax: { value: 8.0, unit: 'm', source: 'NKBA Kitchen Planning Guideline 5' },
      counterDepth: { value: 0.6, unit: 'm', source: 'default (600 mm module)' },
      aisle: { value: 1.2, unit: 'm', source: 'NKBA Guideline 6 (1.07 m one-cook minimum)' },
      aisleAccessible: { value: 1.5, unit: 'm', source: 'ADA 2010 §804.2.2 U-shaped / turning space' },
      sinkToRangeMin: { value: 0.6, unit: 'm', source: 'default landing area' },
    },
    dependsOn: ['ARC-14'],
    references: ['NKBA Kitchen Planning Guidelines', 'ADA 2010 §804', 'Alexander APL #184 Cooking Layout'],
  },
  {
    id: 'ARC-21',
    name: 'Bathroom Back-to-Back',
    discipline: 'architecture',
    problem:
      'Two bathrooms on opposite sides of a unit need two stacks, two vent penetrations and twice the hot-water run, and a bathroom that shares a partition with a bedroom transmits every flush.',
    solution:
      'Pair bathrooms and the kitchen along the same wet wall so their fixtures stand back to back on one 0.2 m wall carrying one stack. Where a bathroom must touch a bedroom, put a closet or the bath tub itself against the shared wall instead of the WC.',
    parameters: {
      sharedWallThickness: { value: 0.2, unit: 'm', source: 'SIZES.wetWallT' },
      maxFixtureToStack: { value: 3.0, unit: 'm', source: 'IPC 2021 Table 1002.2' },
      acousticTarget: { value: 45, unit: 'dB DnT,w', source: 'Approved Document E Table 1 (walls between dwellings 45 dB)' },
    },
    dependsOn: ['ARC-14', 'XD-01'],
    references: ['IPC 2021 §905 (vent connections)', 'Approved Document E', 'ASTM E336'],
  },
  {
    id: 'ARC-22',
    name: 'Stacked Stair in Multi-Level Units',
    discipline: 'architecture',
    problem:
      'An internal stair drawn separately on each floor of a maisonette or townhouse lands in a different place upstairs, so the floor opening does not line up, the structure cannot span and the headroom fails.',
    solution:
      'Fix one stair footprint against a party wall near the entry and repeat it identically on every level of the unit, with the floor opening above it and a landing at the head. Risers = round(floor-to-floor / 0.18), going 0.26 m, clear width 1.0 m, headroom 2.0 m.',
    parameters: {
      riserMax: { value: 0.18, unit: 'm', source: 'SIZES.stairRiserMax; IRC 2021 R311.7.5.1 (7¾" = 0.196 m), ADM K 0.22 max' },
      going: { value: 0.26, unit: 'm', source: 'IRC 2021 R311.7.5.2 (10" = 0.254 m min); Approved Document K 0.22 m min' },
      clearWidth: { value: 1.0, unit: 'm', source: 'IRC 2021 R311.7.1 (0.91 m); Approved Document K (0.8 m)' },
      headroom: { value: 2.0, unit: 'm', source: 'IRC 2021 R311.7.2 (6′8″ = 2.03 m); Approved Document K 2.0 m' },
      identicalRectEveryLevel: { value: true, source: 'default' },
    },
    references: ['IRC 2021 R311.7', 'Approved Document K 2013', 'NCC 2022 Part 3.9.1'],
  },
  {
    id: 'ARC-23',
    name: 'Universal Design Unit',
    discipline: 'architecture',
    problem:
      'A dwelling that a wheelchair user cannot turn around in, or whose bathroom door is 0.76 m wide, excludes its occupant the day their mobility changes — and most of the cost of fixing it later is demolition.',
    solution:
      'Where the template is accessible: every door 0.9 m clear, a 1.5 m turning circle clear of fixtures in the entry, kitchen and bathroom, a level-threshold roll-in shower 1.5 × 0.9 m with a folding seat, grab rails beside the WC and in the shower, 1.2 m of clear floor in front of every appliance, and worktops and switches within the 0.4–1.2 m reach range.',
    parameters: {
      doorClearWidth: { value: 0.9, unit: 'm', source: 'ADA 2010 §404.2.3 (0.815 m clear); ADM M4(3) 0.9 m leaf' },
      turningCircle: { value: 1.5, unit: 'm', source: 'ADA 2010 §304.3.1; ADM M4(2) 1.5 m' },
      rollInShower: { value: '1.5 × 0.9', unit: 'm', source: 'ADA 2010 §608.2.2' },
      grabRailHeight: { value: 0.85, unit: 'm', source: 'ADA 2010 §609.4 (0.84–0.92 m)' },
      wcSideClearance: { value: 0.45, unit: 'm', source: 'ADA 2010 §604.2 (0.41–0.46 m to centreline)' },
      reachRange: { value: '0.38–1.22', unit: 'm', source: 'ADA 2010 §308' },
    },
    references: ['ADA 2010 §603, §604, §608', 'Approved Document M4(2)/M4(3)', 'AS 1428.1-2009', 'ANSI A117.1 Type A'],
  },
  {
    id: 'ARC-24',
    name: 'Cluster Around a Shared Hearth',
    discipline: 'architecture',
    problem:
      'Shared housing built as a corridor of bedrooms with a token kitchen produces no shared life at all: the kitchen is a passage, and residents retreat to their rooms.',
    solution:
      'Give a cluster of five or six en-suite rooms one big shared kitchen/living room at the daylit end of the plan, big enough to eat in together — 6–7 m² per resident, a table for everyone, and the cooking run in the same room rather than behind a wall. Reach the rooms from a short internal corridor off the front door, never through the shared room.',
    parameters: {
      roomsPerCluster: { value: 6, unit: 'rooms', source: 'default (5–8 typical for UK cluster flats)' },
      sharedAreaPerResident: { value: 7.0, unit: 'm²/person', source: 'default (42 m² shared for 6)' },
      bedroomArea: { value: 13.5, unit: 'm²', source: 'default; ≥ 12 m² en-suite study bedroom' },
      corridorWidth: { value: 1.2, unit: 'm', source: 'default (0.9 m clear + architraves)' },
      diningSeats: { value: 6, unit: 'seats', source: 'occupancy' },
    },
    dependsOn: ['ARC-29'],
    references: ['Alexander APL #139 Farmhouse Kitchen', 'Alexander APL #37 House Cluster', 'London Plan 2021 Policy H16 (large-scale purpose-built shared living)'],
  },
  {
    id: 'ARC-25',
    name: 'Dual-Key Vestibule',
    discipline: 'architecture',
    problem:
      'A flat that has to work as either one home or two needs two front doors, but two doors off the corridor doubles the corridor length per dwelling and halves the letting flexibility.',
    solution:
      'One door from the corridor into a small shared vestibule, then two lockable doors: one into the main flat and one into a self-contained studio with its own shower room and kitchenette. The studio takes a full-depth slice at one end of the frontage so both halves keep a window wall, and the vestibule sits on the boundary between them.',
    parameters: {
      vestibuleArea: { value: 3.5, unit: 'm²', source: 'default' },
      vestibuleMinWidth: { value: 1.3, unit: 'm', source: 'default (two door swings)' },
      studioShare: { value: 0.32, unit: 'ratio of unit area', source: 'default' },
      lockableDoors: { value: 2, unit: 'doors', source: 'default' },
    },
    dependsOn: ['ARC-18'],
    references: ['IBC 2021 §420 (R-2 dwelling/sleeping unit separation)', 'Approved Document E (separating walls between dwellings)'],
  },
  {
    id: 'ARC-26',
    name: 'Living at the Corner',
    discipline: 'architecture',
    problem:
      'In a corner or dual-aspect unit the plan usually gives the corner to a bedroom because it packs better, and the living room ends up single-aspect and dark for half the day.',
    solution:
      'When a unit has two exterior sides, put the living room in the corner so it takes light from both, and let the bedrooms share the longer façade. Every room then has daylight from at least one side and the main room from two, which also lets the unit cross-ventilate.',
    parameters: {
      exteriorSidesRequired: { value: 2, unit: 'sides', source: 'default' },
      livingAtCorner: { value: true, source: 'Alexander APL #159' },
      crossVentilation: { value: true, source: 'CIBSE TM59 / NCC 2022 Part 3.12.1' },
    },
    references: ['Alexander APL #159 Light on Two Sides of Every Room', 'Alexander APL #128 Indoor Sunlight', 'London Plan 2021 (dual-aspect preference)'],
  },
  {
    id: 'ARC-27',
    name: 'Closet Buffer Between Bedrooms',
    discipline: 'architecture',
    problem:
      'Two bedrooms sharing a single 0.12 m partition hear each other, and a bedroom next to a bathroom hears the shower and the WC.',
    solution:
      'Where two bedrooms or a bedroom and a bathroom meet, put a wardrobe run or a closet against the shared wall, so the acoustic path gains a mass layer and 0.6 m of air. Where a closet is not available, place the wardrobe (1.2 × 0.6) on the shared wall rather than the bed head.',
    parameters: {
      bufferDepth: { value: 0.6, unit: 'm', source: 'wardrobe depth' },
      partitionThickness: { value: 0.12, unit: 'm', source: 'SIZES.partitionT' },
      internalWallTarget: { value: 40, unit: 'dB Rw', source: 'Approved Document E Table 2 (internal walls 40 dB)' },
    },
    references: ['Approved Document E Table 2', 'IBC 2021 §1206 (STC 45/50 between dwelling units)', 'Alexander APL #141'],
  },
  {
    id: 'ARC-28',
    name: 'Door Swings Clear',
    discipline: 'architecture',
    problem:
      'Doors drawn without their swings collide with each other in halls, open onto WCs you cannot then close the door behind, and hit furniture or light switches.',
    solution:
      'Reserve a quarter-circle of the door\'s own width in front of every swing door and keep it free of other door swings, of furniture and of fixtures. Keep every door leaf at least 0.15 m from a corner so the architrave and the handle have somewhere to land, and use a sliding or cased opening where a swing cannot be kept clear.',
    parameters: {
      swingClearance: { value: 'door width × door width', source: 'default' },
      minFromCorner: { value: 0.15, unit: 'm', source: 'default' },
      interiorDoorWidth: { value: 0.8, unit: 'm', source: 'SIZES.doorInterior' },
      bathroomDoorWidth: { value: 0.75, unit: 'm', source: 'SIZES.doorBathroom' },
      closetDoorWidth: { value: 0.7, unit: 'm', source: 'default' },
      accessibleDoorWidth: { value: 0.9, unit: 'm', source: 'ADA 2010 §404.2.3' },
    },
    references: ['ADA 2010 §404.2.4 (manoeuvring clearances)', 'IRC 2021 R311.2', 'Approved Document M Table 2'],
  },
  {
    id: 'ARC-29',
    name: 'Occupancy Sets the Table',
    discipline: 'architecture',
    problem:
      'Dining areas sized by leftover space seat four people in a home designed for six, and living rooms get a three-seat sofa whether one person lives there or five.',
    solution:
      'Derive the eating and sitting furniture from the design occupancy: 0.6 m of table edge per person (a 1.2 × 0.8 table to 4, a 1.8 × 0.9 table to 6) plus 0.75 m of chair pull-out all round; seats in the living room ≥ occupancy, so a 1–2 person home gets a two-seat sofa and a 5–6 person home a three-seat sofa plus an armchair.',
    parameters: {
      tableEdgePerPerson: { value: 0.6, unit: 'm/person', source: 'default (Neufert)' },
      chairPullOut: { value: 0.75, unit: 'm', source: 'default' },
      seatsMin: { value: 'occupants', source: 'XD-05' },
      occupancyRule: { value: 'bedspaces = 2 per double bedroom, 1 per single', source: 'XD-05 / London Plan 2021' },
    },
    dependsOn: ['XD-05'],
    references: ['London Plan 2021 LPG Table 3.1 (areas by bedspaces)', 'ASHRAE 62.2-2019 §4.1.2 (bedrooms + 1)', 'Alexander APL #147 Communal Eating'],
  },
  {
    id: 'ARC-30',
    name: 'Storage per Occupant',
    discipline: 'architecture',
    problem:
      'Dwellings built without built-in storage fill their circulation and their bedrooms with wardrobes and boxes, and the plan that looked generous on paper becomes unusable in a year.',
    solution:
      'Provide at least 0.6 m³ of enclosed storage per occupant and 2.5 m² of built-in storage floor area for a 1–2 person home plus 0.5 m² per extra person: a coat closet at the entry, a wardrobe (1.2 × 0.6 × 2.1 = 1.5 m³) per bedroom, a linen closet on the bedroom hall, and a utility store for bulky items.',
    parameters: {
      volumePerOccupant: { value: 0.6, unit: 'm³/person', source: 'default' },
      builtInArea1to2p: { value: 2.5, unit: 'm²', source: 'London Plan 2021 LPG Table 3.1 / NDSS 2015' },
      areaPerExtraPerson: { value: 0.5, unit: 'm²/person', source: 'NDSS 2015 Table 1' },
      wardrobeVolume: { value: 1.5, unit: 'm³', source: '1.2 × 0.6 × 2.1 wardrobe' },
      minClosetWidth: { value: 0.6, unit: 'm', source: 'default (hanging rail depth 0.6)' },
    },
    references: ['Technical Housing Standards (NDSS) 2015 Table 1', 'London Plan 2021 LPG 3.1', 'Alexander APL #145 Bulk Storage'],
  },
  {
    id: 'ARC-36',
    name: 'Through Flat: Two Faces, One Hall',
    discipline: 'architecture',
    problem:
      'A dwelling entered from a stair landing on its side — two flats per core in a mansion block or a garden walk-up — has a party wall opposite its front door, so a plan that puts the daylit rooms on the far side of the unit hands every bedroom a blank wall. The rooms that need light are then lit from the one thing that cannot carry a window, and the deep middle of the plan has nowhere to put a corridor.',
    solution:
      'Turn the plan through ninety degrees. Run a hall 1.1–1.5 m deep along the landing wall, straight in from the front door, and hang the daylit rooms off its two ends as full-depth bands standing on the two exterior façades: living, dining and the kitchen on the band with the better solar exposure, bedrooms on the other with the principal bedroom farthest from the door. Put the wet and storage rooms in a band on the party wall under the hall, where they need no window, with the kitchen and the bathroom back to back on one wet wall. Where a band holds more than one room, drop a 1.2 m leg of the hall between the band and the service rooms so nothing is reached through a bedroom. Each façade is only as long as the unit is deep, so a band takes only as many rooms as that length allows: report the rest rather than pretend they are lit.',
    parameters: {
      hallDepth: { value: 1.2, unit: 'm', source: 'default (0.9 m clear + architraves)' },
      hallDepthAccessible: { value: 1.5, unit: 'm', source: 'ADA 2010 §304.3.1 turning space' },
      facadesRequired: { value: 2, unit: 'sides', source: 'London Housing Design Guide 2010 §2.1.2 (dual aspect)' },
      minUnitDepth: { value: 3.6, unit: 'm', source: 'default (hall 1.2 + service band 2.4)' },
      minFrontage: { value: 5.4, unit: 'm', source: 'default (two bands plus the hall strip)' },
      publicBandOnBestSolar: { value: true, source: 'Alexander APL #128 Indoor Sunlight' },
      principalBedroomFarthest: { value: true, source: 'Alexander APL #127 Intimacy Gradient' },
      serviceBandOnPartyWall: { value: true, source: 'ARC-14 / ARC-21' },
    },
    dependsOn: ['ARC-14', 'ARC-19', 'ARC-26'],
    references: [
      'Alexander APL #159 Light on Two Sides of Every Room',
      'Alexander APL #127 Intimacy Gradient',
      'London Housing Design Guide 2010 §2.1.2 (dual-aspect dwellings)',
      'London Plan 2021 Policy D6 (single-aspect north-facing dwellings to be avoided)',
    ],
  },
];

export const UNIT_PATTERN_IDS: string[] = UNIT_PATTERNS.map(p => p.id);

export function getUnitPattern(id: string): Pattern | undefined {
  return UNIT_PATTERNS.find(p => p.id === id);
}
