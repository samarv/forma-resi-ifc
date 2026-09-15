/**
 * SITE pattern book (ids SIT-01 .. SIT-12).
 *
 * Each pattern is Alexander-style: a recurring problem in context, then ONE parametric rule
 * that resolves it. The rule text is what `massing.ts` / `parking.ts` / `landscape.ts` actually
 * implement, and every application is recorded as a `PatternApplication` with the concrete
 * numbers that were used, so a reader can audit why the site looks the way it does.
 *
 * Sources: Alexander, Ishikawa & Silverstein, *A Pattern Language* (1977) — APL numbers;
 * IBC 2021 chapter 10 for egress; common Anglophone zoning bulk standards for setbacks;
 * NCC/ADB/NBC noted where the regional rule differs materially.
 */
import type { Pattern } from '../../core/types.ts';

export const SITE_PATTERNS: Pattern[] = [
  {
    id: 'SIT-01',
    name: 'Setbacks and Yards',
    discipline: 'site',
    problem:
      'A building pushed hard against every boundary leaves only leftover space: thin, shaded strips that no one can use, no room for a front garden, no separation between neighbours. Setbacks applied generously and uniformly do the opposite damage — they waste the site and hold the dwellings away from the street.',
    solution:
      'Read the front / side / rear setbacks from the zoning envelope (typology defaults unless the spec overrides them) and subtract them from the site rectangle: the remainder is the buildable envelope, and every building, podium and structured parking level sits inside it. Only surface parking, driveways, paths, fences and planting may occupy the setbacks. If the remainder falls below 4 m in either direction, relax the setbacks proportionally and report it.',
    parameters: {
      frontSetback: { value: 0, unit: 'm', source: 'typology.setbacks or spec.site.setbacks' },
      sideSetback: { value: 0, unit: 'm', source: 'typology.setbacks or spec.site.setbacks' },
      rearSetback: { value: 0, unit: 'm', source: 'typology.setbacks or spec.site.setbacks' },
      minEnvelopeDimension: { value: 4.0, unit: 'm', source: 'default (smallest habitable bar)' },
    },
    references: ['Alexander APL #104 Site Repair', 'Alexander APL #106 Positive Outdoor Space'],
  },
  {
    id: 'SIT-02',
    name: 'Building Faces the Street',
    discipline: 'site',
    problem:
      'Buildings set back behind their parking, or rotated off the street line, kill the public realm: there are no eyes on the street, no visible front door, and none of the rhythm of entrances that makes a street legible.',
    solution:
      'Lay the principal bar with its long axis parallel to the street, on the front setback line (the build-to line). Put the main entrance on the front face at the first core, in the middle two thirds of the frontage. Give every direct-access dwelling its own door on the street face, one door per unit frontage, exported in order along +X so the architecture module can align unit doors to them. The number of doors is the number of HOUSES the bar actually holds, not a round frontage: divide the bar by the frontage the dominant template needs at this depth — its target area over the residential floors and the net bar depth (barDepth − 0.6), clamped to the template frontage band — so the row of front doors, the row of garage doors and the row of dwellings are the same row.',
    parameters: {
      buildToOffset: { value: 0, unit: 'm behind the front setback line', source: 'default' },
      unitFrontage: { value: 6.0, unit: 'm', source: 'fallback; normally area.target / (levels × (barDepth − 0.6)) from architecture/templates.ts' },
      externalWallPair: { value: 0.6, unit: 'm', source: '2 × core/coordination.ts SIZES.exteriorWallT' },
      minFrontageDepthFactor: { value: 0.45, unit: 'fraction', source: 'floor of frontage.min × depth.max / netDepth (matches architecture)' },
      entranceZone: { value: 'middle two thirds of the front face', source: 'Alexander APL #110' },
    },
    dependsOn: ['SIT-01'],
    references: ['Alexander APL #122 Building Fronts', 'Alexander APL #110 Main Entrance'],
  },
  {
    id: 'SIT-03',
    name: 'Courtyard Which Lives',
    discipline: 'site',
    problem:
      'Courtyards that are too small, too enclosed or with no route through them die: they are overlooked but never entered, in permanent shade, and become service yards.',
    solution:
      'Wrap the buildable envelope with bars one bar-depth thick to form a perimeter block, and keep the courtyard at least 15 m clear in BOTH directions so it receives sun at a 1:1 height-to-width ratio and reads as an outdoor room rather than a light well. Give it at least one passage through the street-facing bar (a courtyard entrance). If 15 m cannot be achieved, degrade the shape to a U so the court opens to the rear, and report it.',
    parameters: {
      minClearDimension: { value: 15.0, unit: 'm', source: 'Alexander APL #115 + 1:1 H:W daylight rule at 5 storeys' },
      passages: { value: 1, unit: 'count', source: 'Alexander APL #115 (a court must be crossed)' },
      degradeTo: { value: 'U', source: 'default' },
    },
    dependsOn: ['SIT-01'],
    references: ['Alexander APL #115 Courtyards Which Live', 'Alexander APL #106 Positive Outdoor Space'],
  },
  {
    id: 'SIT-04',
    name: 'South-Facing Garden',
    discipline: 'site',
    problem:
      'The main garden ends up on whichever side the convention puts it — usually the rear — regardless of the sun. Half of all lots therefore get their good outdoor room on the shaded side, while the sunny strip is given to the driveway.',
    solution:
      'Score the front and rear exposures for solar quality (hemisphere taken from the region: AU and NZ flip the scores). If the street side is materially sunnier (score difference > 0.2) and the front setback can hold a usable garden (>= 4.5 m), push a direct-access building to the REAR of the buildable envelope so the main garden faces the sun; otherwise keep it on the front build-to line with the garden at the rear. The building never leaves the envelope — only its position inside it flips.',
    parameters: {
      scoreDelta: { value: 0.2, unit: 'solar score (0..1)', source: 'default' },
      minGardenDepth: { value: 4.5, unit: 'm', source: 'default (usable outdoor room)' },
      southernHemisphere: { value: false, source: 'spec.region (AU / NZ)' },
    },
    dependsOn: ['SIT-01'],
    references: ['Alexander APL #105 South Facing Outdoors', 'Alexander APL #111 Half-Hidden Garden'],
  },
  {
    id: 'SIT-05',
    name: 'Back-of-Lot Dwelling',
    discipline: 'site',
    problem:
      'A second dwelling added to an occupied lot has nowhere obvious to go. Put it beside the house and both lose their garden; put it in front and the street loses its rhythm.',
    solution:
      'Place the accessory dwelling hard against the rear setback line, its long face parallel to the lane, and keep at least 3 m of open separation between it and the notional main house at the front — narrowing the separation, never the dwelling, on a shallow lot. Emit the main house as context geometry (IfcBuildingElementProxy, objectType ExistingHouse, 7 m high) so the ADU reads at the right scale, and give the ADU its own door on the lane frontage so the main house keeps its address.',
    parameters: {
      separationMin: { value: 3.0, unit: 'm', source: 'typical laneway / granny-flat bylaw separation' },
      notionalHouseHeight: { value: 7.0, unit: 'm', source: 'default (2 storeys + roof)' },
      notionalHouseDepthMax: { value: 9.0, unit: 'm', source: 'default' },
    },
    dependsOn: ['SIT-01'],
    references: ['Alexander APL #111 Half-Hidden Garden', 'Vancouver Laneway House Guidelines (siting principle)'],
  },
  {
    id: 'SIT-06',
    name: 'Active Street Wall',
    discipline: 'site',
    problem:
      'In a city centre a setback is a gap. Gaps between buildings, and blank walls where the building steps back, break the continuity that makes a street feel like a room.',
    solution:
      'In urban context with a zero front setback, hold the ground floor on the back of the pavement across at least 70% of the frontage, with no parking, planting strip or driveway between the building line and the street. The remaining frontage may be an entrance recess or a courtyard passage.',
    parameters: {
      frontSetback: { value: 0, unit: 'm', source: 'typology.setbacks (urban)' },
      buildToFraction: { value: 0.7, unit: 'fraction of frontage', source: 'default (form-based code typical)' },
    },
    dependsOn: ['SIT-01', 'SIT-02'],
    references: ['Alexander APL #122 Building Fronts', 'Form-based code build-to line conventions'],
  },
  {
    id: 'SIT-07',
    name: 'Parking Behind',
    discipline: 'site',
    problem:
      'A car park between the building and the street destroys the frontage: it puts 25 m² of asphalt per dwelling exactly where the front garden and the front door should be, and every arrival is across a parking aisle.',
    solution:
      'Never put surface parking in the front yard while another yard can hold it. Test the rear yard first, then the side yards, and the front only as a last resort. Lay stalls 2.6 x 5.4 m in double-loaded rows off a single 6.0 m aisle (module 16.8 m), reserve 5% of stalls as accessible at 3.6 m wide, flag the EV share, and screen the lot from the street with the planting strip. Structured parking (podium / underground) instead fills the parking storey outline with the same module and takes one 3.5 m ramp at the rear.',
    parameters: {
      stallWidth: { value: 2.6, unit: 'm', source: 'core/coordination.ts SIZES.parkingStallW' },
      stallLength: { value: 5.4, unit: 'm', source: 'core/coordination.ts SIZES.parkingStallL' },
      aisleWidth: { value: 6.0, unit: 'm', source: 'core/coordination.ts SIZES.parkingAisleW (two-way)' },
      doubleLoadedModule: { value: 16.8, unit: 'm', source: '5.4 + 6.0 + 5.4' },
      accessibleShare: { value: 0.05, unit: 'fraction', source: 'IBC 2021 Table 1106.1 (~4%), rounded up to 5%' },
      accessibleWidth: { value: 3.6, unit: 'm', source: 'ADA / IBC 1106 car space + access aisle' },
      rampWidth: { value: 3.5, unit: 'm', source: 'default (one-way ramp)' },
    },
    dependsOn: ['SIT-01', 'SIT-02'],
    references: ['Alexander APL #97 Shielded Parking', 'Alexander APL #103 Small Parking Lots', 'Alexander APL #113 Car Connection'],
  },
  {
    id: 'SIT-08',
    name: 'Two Ways Out',
    discipline: 'site',
    problem:
      'One stair is cheap, but it traps everyone above the fire. Too many cores is the opposite waste: each one eats 20 m² of frontage per floor and cuts the corridor into stubs.',
    solution:
      'Size the core rectangle from what it has to hold, not from a round number: along the bar, 2.6 m for two 1.1 m stair flights plus 2.4 m for the service shaft bay (combined M/E riser and refuse chute) = 5.0 m; across the bar, one dog-leg stair run for the TALLEST floor-to-floor (ceil(risers/2) treads of 0.28 m plus a 1.2 m half-landing) plus a 2.3 m lift bank where there are lifts plus a 1.2 m lift lobby. Allow a single core only where the floor has at most 4 units and the building is at most 3 storeys. On a corridor, place at least two cores, spaced so travel to the nearest never exceeds the limit (61 m unsprinklered, 76 m sprinklered) and the exits are at least a third of the plan diagonal apart, each at least 6 m from a bar end and flush against one side of the corridor so the corridor stays continuous. On a stair-core block there is no corridor to space cores along, so count them by the frontage MODULE each landing needs — core + landing + the unit frontages it serves on both sides — and put each core at the centre of its module, so every landing gets the same frontage on both sides.',
    parameters: {
      travelLimitSprinklered: { value: 76.0, unit: 'm', source: 'IBC 2021 Table 1017.2 (Group R, sprinklered, 250 ft)' },
      travelLimitUnsprinklered: { value: 61.0, unit: 'm', source: 'IBC 2021 Table 1017.2 (Group R, 200 ft)' },
      singleExitMaxUnitsPerFloor: { value: 4, unit: 'count', source: 'IBC 2021 §1006.3.3 / Table 1006.3.3 (R-2 single exit)' },
      singleExitMaxStoreys: { value: 3, unit: 'count', source: 'IBC 2021 Table 1006.3.3' },
      exitSeparationFraction: { value: 0.3333, unit: 'fraction of plan diagonal', source: 'IBC 2021 §1007.1.1 exc. 2 (sprinklered)' },
      endClearance: { value: 6.0, unit: 'm', source: 'default (keep the end bay usable for a dual-aspect unit)' },
      coreWidthAlongBar: { value: 5.0, unit: 'm', source: '2.6 m stair bay + 2.4 m shaft bay (XD-04)' },
      stairBayAlongBar: { value: 2.6, unit: 'm', source: 'two 1.1 m flights (SIZES.stairWidth) side by side, IBC 2021 §1011.2' },
      shaftBayAlongBar: { value: 2.4, unit: 'm', source: 'XD-04: combined M/E riser 1.2 × 0.8 + refuse chute 1.0 × 1.0' },
      riserMax: { value: 0.175, unit: 'm', source: 'IBC 2021 §1011.5.2 / ADB vol.1 (dwellings)' },
      treadMin: { value: 0.28, unit: 'm', source: 'core/coordination.ts SIZES.stairTreadMin' },
      stairHalfLanding: { value: 1.2, unit: 'm', source: 'default (landing at least the flight width)' },
      liftBankDepth: { value: 2.3, unit: 'm', source: 'core/coordination.ts SIZES.elevatorShaftD + structure' },
      liftLobbyDepth: { value: 1.2, unit: 'm', source: 'default (accessible lobby in front of the bank)' },
      landingStairCore: { value: 2.4, unit: 'm', source: 'default (walk-up landing beside the stair)' },
      landingMansionBlock: { value: 2.6, unit: 'm', source: 'default (mansion-block entrance hall)' },
    },
    dependsOn: ['SIT-09'],
    references: ['IBC 2021 §1006 Number of exits', 'IBC 2021 §1017 Exit access travel distance', 'IBC 2021 §1011 Stairways', 'Approved Document B vol.1 (UK) 30 m common corridor', 'NCC 2022 Vol.1 D2 (AU)'],
  },
  {
    id: 'SIT-09',
    name: 'Bar Depth from Unit Depth',
    discipline: 'site',
    problem:
      'Bar depth is usually chosen for efficiency, and the units are then squeezed into whatever is left. Too shallow and the building is all facade; too deep and every living room is a tunnel with one window at the far end.',
    solution:
      'Derive bar depth from the unit depth and the access type: double-loaded corridor = 2 x unit depth + corridor width; single-loaded or gallery = 1 x unit depth + gallery width; point plate = core depth + 2 x unit depth. Run the rule backwards on the specified depth to get the implied unit depth, and report it; flag depths that imply a unit shallower than 6.5 m or deeper than 14 m (beyond which the back of the plan has no daylight).',
    parameters: {
      unitDepthMin: { value: 6.5, unit: 'm', source: 'default (minimum workable unit depth)' },
      unitDepthMax: { value: 14.0, unit: 'm', source: 'daylight: habitable depth <= 2.5 x ceiling height' },
      corridorWidth: { value: 1.7, unit: 'm', source: 'typology.corridorWidth / spec.massing.corridorWidth' },
      pointCoreDepth: { value: 7.0, unit: 'm', source: 'default (point core short dimension)' },
    },
    references: ['Alexander APL #107 Wings of Light', 'Alexander APL #159 Light on Two Sides of Every Room'],
  },
  {
    id: 'SIT-10',
    name: 'Trees and Ground',
    discipline: 'site',
    problem:
      'A site that is all hard surface is hot, loud and wet: nothing shades the parking, nothing slows the rain, and trees planted as an afterthought end up in the middle of the driveway.',
    solution:
      'Plant trees at 8–10 m centres along the front and side setbacks, and around any courtyard, skipping every position within 1 m of a path, driveway, stall or building. Keep the soft-landscape ratio (planting + lawn + garden + courtyard) at or above one quarter of the open space, and give the street edge a continuous planting strip 1.2 m deep that screens the parking.',
    parameters: {
      treeSpacingMin: { value: 8.0, unit: 'm', source: 'Alexander APL #171 + street tree practice' },
      treeSpacingMax: { value: 10.0, unit: 'm', source: 'Alexander APL #171' },
      canopyHeightMin: { value: 6.0, unit: 'm', source: 'default (semi-mature tree)' },
      canopyHeightMax: { value: 9.0, unit: 'm', source: 'default' },
      clearanceToHardscape: { value: 1.0, unit: 'm', source: 'default' },
      minLandscapeRatio: { value: 0.25, unit: 'fraction of open space', source: 'default (typical amenity / SuDS standard)' },
      plantingStripDepth: { value: 1.2, unit: 'm', source: 'default' },
    },
    dependsOn: ['SIT-01'],
    references: ['Alexander APL #171 Tree Places', 'Alexander APL #60 Accessible Green'],
  },
  {
    id: 'SIT-11',
    name: 'Entrance Transition',
    discipline: 'site',
    problem:
      'A door straight off the pavement gives no threshold: you are inside before you have finished leaving the street, and the building has no address.',
    solution:
      'Give every main entrance a paved path from the street edge to the door — 2.0 m wide for a shared entrance, 1.5 m for an individual dwelling — on a straight sight line from the street, never shared with the driveway. The driveway is a separate 3.5–6.0 m paved run to the garage or lot, and service entrances go at the rear.',
    parameters: {
      mainPathWidth: { value: 2.0, unit: 'm', source: 'default (two people passing)' },
      unitPathWidth: { value: 1.5, unit: 'm', source: 'default' },
      drivewayWidthMin: { value: 3.5, unit: 'm', source: 'default (single lane)' },
      drivewayWidthMax: { value: 6.0, unit: 'm', source: 'default (double garage / two-way)' },
      minPathSpacing: { value: 1.5, unit: 'm', source: 'default (merge paths closer than this)' },
    },
    dependsOn: ['SIT-02'],
    references: ['Alexander APL #112 Entrance Transition', 'Alexander APL #121 Path Shape'],
  },
  {
    id: 'SIT-12',
    name: 'Hierarchy of Open Space',
    discipline: 'site',
    problem:
      'Open space that is neither clearly private nor clearly public is used by no one and maintained by no one. A block with one undifferentiated lawn has no gardens and no commons.',
    solution:
      'Grade the open space: a private garden for each direct-access dwelling at the rear, one strip per unit frontage and at least 4 m deep; a communal garden or courtyard for shared blocks; a planting strip at the street that belongs to the building but reads as part of the street. Record the area of every zone so the amenity provision per dwelling can be measured.',
    parameters: {
      privateGardenMinDepth: { value: 4.0, unit: 'm', source: 'default' },
      privateGardenTargetArea: { value: 25.0, unit: 'm²/dwelling', source: 'typical private amenity standard' },
      communalAreaPerUnit: { value: 2.0, unit: 'm²/dwelling', source: 'typical communal amenity standard' },
    },
    dependsOn: ['SIT-01', 'SIT-10'],
    references: ['Alexander APL #114 Hierarchy of Open Space', 'Alexander APL #60 Accessible Green'],
  },
];

export const SITE_PATTERN_IDS: string[] = SITE_PATTERNS.map(p => p.id);
