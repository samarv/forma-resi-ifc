/**
 * Plumbing + fire-protection pattern language (PLB-01 .. PLB-12).
 *
 * Alexander-style: each pattern names the recurring problem in the context of a residential
 * building, then states the parametric rule that resolves it. Parameters carry units and the
 * code section / design guide they come from, so an application trace is auditable.
 */
import type { Pattern } from '../../core/types.ts';

export const PLUMB_PATTERNS: Pattern[] = [
  {
    id: 'PLB-01',
    name: 'One Stack per Dwelling Column',
    discipline: 'plumbing',
    problem:
      'Every bathroom and kitchen needs waste, vent, cold and hot water. When each fixture group finds its own way down, a building fills with risers; every riser is a fire-stopped, acoustically sealed hole through every floor slab, and the plumbing cost of a dwelling roughly doubles. Worse, a riser that cannot find the same place on the floor below has to jog through a ceiling, and the jog is where the blockages and the leaks happen. A dwelling drawn with three or four "wet" walls invites three or four stacks.',
    solution:
      'Count stacks per DWELLING, not per wall. Within a dwelling pick the wet wall line carrying the most fixtures (kitchen and main bathroom back-to-back preferred) and put the stack on it, at the station that reaches the most fixtures inside their trap-arm limits — the station is computed in world coordinates, so a dwelling occupying several storeys keeps one vertical line through all of them. A second stack is opened only for fixtures the first cannot reach (PLB-02); beyond that budget a remote fixture gets an individually vented branch drain rather than another hole through every slab. Where the dwellings above repeat the plan, the stations coincide within the stacking tolerance and become one stack from the lowest dwelling storey to the roof. All five pipes live inside that one wall, spaced evenly apart: waste, vent, cold, hot and (with central hot water) the recirculation return.',
    parameters: {
      stacksPerDwellingTarget: { value: 2, unit: 'stacks/dwelling', source: 'XD-01 (one wet wall per dwelling)' },
      stackAlignTolerance: { value: 0.3, unit: 'm', source: 'default (stud spacing + construction tolerance)' },
      wasteStackDiameter: { value: 0.1, unit: 'm', source: 'code:IPC 2021 Table 710.1(2) (4 in stack, ≤ 500 DFU)' },
      ventStackDiameter: { value: 0.075, unit: 'm', source: 'code:IPC 2021 Table 916.1 (3 in vent)' },
      dcwRiserDiameter: { value: 0.032, unit: 'm', source: 'code:IPC 2021 Appendix E (Ø50 above 10 storeys)' },
      dhwRiserDiameter: { value: 0.025, unit: 'm', source: 'default' },
      hwrRiserDiameter: { value: 0.02, unit: 'm', source: 'default (recirculation return)' },
      pipeSpacingInWall: { value: 0.08, unit: 'm', source: 'default (insulation + clip clearance)' },
      wetWallThickness: { value: 0.2, unit: 'm', source: 'XD-01' },
    },
    dependsOn: ['XD-01', 'ARC-14'],
    references: ['IPC 2021 §710, §916', 'BS EN 12056-2 §6', 'Alexander APL #144 Bathing Room'],
  },
  {
    id: 'PLB-02',
    name: 'Short Trap Arms',
    discipline: 'plumbing',
    problem:
      'A trap keeps sewer gas out of a room by holding a plug of water. If the drain between the trap and the vented stack is too long, the falling water seals the pipe, drags air behind it and siphons the trap dry — and the room smells. Long branches also lose their fall and hold solids.',
    solution:
      'Put the stack where the fixtures are, not the fixtures where the stack is. Every trap arm runs from the fixture, perpendicular into the wet wall, then along the wall centreline to the stack — two axis-parallel legs, never a diagonal — and the developed length of an UNVENTED arm stays within the code limit for its diameter. When a fixture cannot be reached inside that limit, a second stack is opened at the station that covers the most of the remaining fixtures. Once the dwelling\'s stack budget is spent, a remote fixture is drained by an individually vented branch drain one size up, which the code allows to run further, and the layout problem is reported for architecture to fix.',
    parameters: {
      maxTrapArmDn50: { value: 1.5, unit: 'm', source: 'code:IPC 2021 Table 1002.2 (1½ in → 6 ft)' },
      maxTrapArmDn100: { value: 3.0, unit: 'm', source: 'code:IPC 2021 Table 1002.2 (4 in → 12 ft)' },
      maxVentedBranchDrain: { value: 12.0, unit: 'm', source: 'code:IPC 2021 §912 + Table 704.1 (individually vented branch at the 1 % minimum fall drops 120 mm, the depth available at the waste invert)' },
      ventedBranchDiameter: { value: 0.075, unit: 'm (minimum)', source: 'code:IPC 2021 Table 710.1(1)' },
      branchDiameterWc: { value: 0.1, unit: 'm', source: 'code:IPC 2021 §709.1 (water closet 3 in min, 4 in used)' },
      branchDiameterOther: { value: 0.05, unit: 'm', source: 'code:IPC 2021 Table 709.1' },
      wasteInvertZ: { value: -0.12, unit: 'm (storey-local)', source: 'default (within the floor build-up under the fixture)' },
      minSlope: { value: 0.02, unit: 'm/m', source: 'code:IPC 2021 Table 704.1 (1/4 in per ft)' },
    },
    dependsOn: ['PLB-01'],
    references: ['IPC 2021 Table 1002.2', 'BS EN 12056-2 Table 5', 'NCC Vol 3 AS/NZS 3500.2'],
  },
  {
    id: 'PLB-03',
    name: 'Vent Through Roof',
    discipline: 'plumbing',
    problem:
      'Drainage only works if air can follow the water. A stack with no open top becomes a piston: it pulls traps dry on the floors above and blows them out on the floors below.',
    solution:
      'Every waste stack is paired with a vent of the next size down that continues past the highest fixture and terminates in open air above the roof, clear of any occupied roof deck, air intake or window. The vent is the only pipe in the wet wall that reaches the ROOF storey.',
    parameters: {
      ventTerminationHeight: { value: 0.9, unit: 'm above roof', source: 'code:IPC 2021 §904.1 (150 mm min; 2.1 m over occupied roof)' },
      ventDiameter: { value: 0.075, unit: 'm', source: 'code:IPC 2021 Table 916.1' },
      branchVentZ: { value: 1.5, unit: 'm (storey-local)', source: 'code:IPC 2021 §905.4 (above the fixture flood rim)' },
      minDistanceToOpening: { value: 3.0, unit: 'm', source: 'code:IPC 2021 §904.5' },
    },
    dependsOn: ['PLB-01'],
    references: ['IPC 2021 §904', 'BS EN 12056-2 §5.2'],
  },
  {
    id: 'PLB-04',
    name: 'Hot Water Close to the Tap',
    discipline: 'plumbing',
    problem:
      'People run the tap while they wait for it to get hot. A long dead leg wastes water and energy every single draw-off, and water standing at 25–45 °C in that leg is where legionella grows.',
    solution:
      'Keep the distance from the source of hot water to the furthest tap short. With per-dwelling tanks or tankless heaters the source sits inside the dwelling, so the leg is a few metres by construction. With a central plant, a recirculation return (HWR) rides with the hot riser and loops the corridor mains, so no branch off the loop exceeds the dead-leg limit and a circulator keeps the loop above the storage temperature.',
    parameters: {
      maxDeadLeg: { value: 15, unit: 'm', source: 'code:IPC 2021 §607.2 / ASHRAE 90.1 §7.4.5' },
      storageTemperature: { value: 60, unit: '°C', source: 'HSE ACoP L8 (legionella control)' },
      returnTemperature: { value: 50, unit: '°C', source: 'HSE ACoP L8' },
      hwrDiameter: { value: 0.02, unit: 'm', source: 'default' },
      storagePerOccupant: { value: 40, unit: 'l/person (central)', source: 'CIBSE Guide G Table 2.4' },
      tankPerDwelling: { value: 190, unit: 'l (50 US gal)', source: 'default (per-unit tank)' },
    },
    dependsOn: ['PLB-01', 'XD-05'],
    references: ['IPC 2021 §607', 'CIBSE Guide G', 'HSE ACoP L8'],
  },
  {
    id: 'PLB-05',
    name: 'Sprinklers Where People Sleep',
    discipline: 'plumbing',
    problem:
      'Almost everyone who dies in a building fire dies in a dwelling, asleep, in the first few minutes. Compartmentation buys time for escape but does nothing about the room the fire starts in.',
    solution:
      'Put a residential sprinkler in every room people can be in, on a grid whose spacing and per-head coverage satisfy the residential standard, set just below the ceiling and clear of the walls. A branch line runs STRAIGHT along one row of that grid — a line of heads, not a tour of them — and the rows of a room gather to a room main at right angles; the room mains hang off the unit main above the entry door, the unit mains off a corridor main in the sprinkler lane of the service spine (or off the bar trunk on a floor with no corridor), which is fed by a riser in each stair core.',
    parameters: {
      coveragePerHead: { value: 15, unit: 'm²/head', source: 'code:NFPA 13R §6.4.2 / NFPA 13D' },
      maxHeadSpacing: { value: 3.7, unit: 'm', source: 'code:NFPA 13R §6.4.3 (12 ft)' },
      minDistanceFromWall: { value: 0.1, unit: 'm', source: 'code:NFPA 13 §8.5.3.1 (4 in)' },
      headDropBelowCeiling: { value: 0.05, unit: 'm', source: 'default (concealed pendent)' },
      minRoomAreaForGrid: { value: 3.0, unit: 'm²', source: 'default (closets below get one head at 2 m²)' },
      branchLinesPerRoom: { value: 'one per grid row', source: 'default (a branch line is straight)' },
      branchLineDiameter: { value: 0.025, unit: 'm', source: 'code:NFPA 13R §6.5 (1 in branch)' },
      roomMainDiameter: { value: 0.032, unit: 'm', source: 'default' },
      unitMainDiameter: { value: 0.032, unit: 'm', source: 'default' },
      corridorMainDiameter: { value: 0.05, unit: 'm', source: 'default' },
      ukHeightTrigger: { value: 11, unit: 'm', source: 'code:Approved Document B Vol 1 §0.16 (blocks of flats > 11 m)' },
      storeyTrigger: { value: 3, unit: 'storeys', source: 'default (sprinkler above 3 storeys regardless of typology)' },
    },
    dependsOn: ['XD-02'],
    references: ['NFPA 13R 2022', 'NFPA 13D 2022', 'Approved Document B Vol 1 (2019, 2020 amdt)', 'AS 2118.4'],
  },
  {
    id: 'PLB-06',
    name: 'Roof Drains at Low Points, Downpipes at Cores',
    discipline: 'plumbing',
    problem:
      'A flat roof is a shallow tank. One blocked outlet in a cloudburst and the water either finds the weakest lap or loads the structure with a tonne per square metre of ponding. A downpipe dropped wherever the outlet happens to be puts a live pipe through somebody\'s living room.',
    solution:
      'Two outlets minimum, and one for every catchment the design storm allows, set at the low points of the roof falls and paired so no single blockage drains nothing. Each outlet leads via an L-shaped leader to a downpipe that drops in the corner of a core or in the plumbing corner of a shaft — never through a dwelling — and the downpipes drop into a buried storm main that runs along the bar, picking each one up with a short perpendicular tap, and leaves the building perpendicular to the street edge.',
    parameters: {
      areaPerDrain: { value: 400, unit: 'm²/drain', source: 'code:IPC 2021 Table 1106.2 (100 mm outlet, 100 mm/h)' },
      minDrains: { value: 2, unit: 'drains', source: 'code:IPC 2021 §1105.1 (secondary drainage)' },
      downpipeDiameter: { value: 0.1, unit: 'm', source: 'code:IPC 2021 Table 1106.2' },
      buriedStormDiameter: { value: 0.15, unit: 'm', source: 'default' },
      buriedStormZ: { value: -1.0, unit: 'm (storey-local, L01)', source: 'default (below frost / under slab)' },
      drainSize: { value: 0.3, unit: 'm (square sump)', source: 'default' },
    },
    dependsOn: ['ARC-20', 'XD-04'],
    references: ['IPC 2021 §1105–1108', 'BS EN 12056-3', 'AS/NZS 3500.3'],
  },
  {
    id: 'PLB-07',
    name: 'Service Entry at the Street',
    discipline: 'plumbing',
    problem:
      'Water comes from the street and sewage goes back to it. If the entry point is decided last, the incoming main crosses the building under the slab, the meter ends up where nobody can read or isolate it, and the drain has to be re-routed around the foundations.',
    solution:
      'Bring the cold water service in perpendicular to the street frontage, below frost depth, to a water room on the ground floor: meter, then backflow preventer, then (above eight storeys) a booster set. From there one main rises to the corridor service spine (or to the bar trunk, on a floor with no corridor). The building drain mirrors it: a collector below the ground slab runs along the same route, picks up each stack base with a vertical drop and a perpendicular tap, and leaves the building as an L — along the collector to the exit station, down to the sewer invert, then straight out to the street edge.',
    parameters: {
      serviceBurialDepth: { value: 0.9, unit: 'm below ground floor', source: 'default (frost cover; local authority)' },
      meterHeight: { value: 0.6, unit: 'm (storey-local)', source: 'default (readable, isolatable)' },
      sewerInvertZ: { value: -1.2, unit: 'm (storey-local, L01)', source: 'default' },
      buildingDrainZ: { value: -0.55, unit: 'm (storey-local, L01)', source: 'default (below slab, above sewer)' },
      backflowPreventer: { value: 'reduced-pressure principle', source: 'code:IPC 2021 §608.13' },
      boosterStoreyThreshold: { value: 8, unit: 'storeys', source: 'PLB-12' },
    },
    dependsOn: ['SIT-01'],
    references: ['IPC 2021 §603, §608, §701', 'BS 8558 §6'],
  },
  {
    id: 'PLB-08',
    name: 'Fixture Units Size the Pipe',
    discipline: 'plumbing',
    problem:
      'Nobody uses every tap at once, so sizing a main for the sum of its fixtures buys a pipe twice as big as it needs to be — and sizing for the average leaves the top floor with no shower.',
    solution:
      'Count water supply fixture units (WSFU) for everything the pipe serves, convert to a probable simultaneous demand with Hunter\'s curve, then pick the smallest nominal diameter that carries that flow below the design velocity — and never smaller than the code minimum for the service. Drainage is sized the same way from drainage fixture units (DFU).',
    parameters: {
      hunterCoefficient: { value: 0.95, unit: 'gpm/WSFU^b', source: 'code:IPC 2021 Appendix E (Hunter 1940, flush-tank curve fit)' },
      hunterExponent: { value: 0.63, unit: '-', source: 'code:IPC 2021 Appendix E' },
      minDemand: { value: 5, unit: 'gpm', source: 'default (single dwelling floor)' },
      designVelocity: { value: 2.4, unit: 'm/s', source: 'code:IPC 2021 §604.1 (erosion limit ~8 ft/s)' },
      minServiceDiameterMultiFamily: { value: 0.05, unit: 'm', source: 'code:IPC 2021 §603.1 / AWWA C700 (2 in)' },
      minServiceDiameterHouse: { value: 0.025, unit: 'm', source: 'code:IPC 2021 §603.1 (1 in)' },
      nominalLadder: { value: '20/25/32/40/50/65/80/100/150 mm', source: 'default' },
    },
    references: ['IPC 2021 Appendix E', 'Hunter, R.B., BMS 65 (1940)', 'BS 8558 Table 3'],
  },
  {
    id: 'PLB-09',
    name: 'Wet Rooms Share a Wall',
    discipline: 'plumbing',
    problem:
      'A bathroom on one side of a plan and a kitchen on the other need two of everything: two stacks, two vents, two sets of penetrations, and twice the length of hot water dead leg.',
    solution:
      'Back the kitchen onto the bathroom across a single 200 mm wet wall, and back each dwelling\'s wet wall onto its neighbour\'s where the party wall allows, so two dwellings share one chase. Fixtures sit within the trap-arm limit of the shared stack on both faces, and the wall is thick enough to take a 100 mm stack plus its vent.',
    parameters: {
      wetWallThickness: { value: 0.2, unit: 'm', source: 'XD-01' },
      backToBackTolerance: { value: 0.3, unit: 'm', source: 'default' },
      maxFixtureDistanceToStack: { value: 3.0, unit: 'm', source: 'PLB-02 / XD-01' },
      fixtureSetbackFromWall: { value: 0.4, unit: 'm (synthesised fixtures)', source: 'default (rough-in centreline)' },
    },
    dependsOn: ['XD-01', 'ARC-21'],
    references: ['IPC 2021 §1002', 'Alexander APL #144'],
  },
  {
    id: 'PLB-10',
    name: 'Standpipes in the Stairs',
    discipline: 'plumbing',
    problem:
      'A firefighter carrying hose up eight floors arrives with no hose and no breath. Fire crews need pressurised water at the floor they are fighting on, inside the protected stair they arrived by.',
    solution:
      'Run a wet standpipe in the corner of every exit stair, from the fire department connection at the street face to the top floor, with an isolating valve at each landing and — once the building is tall enough to matter — a hose valve at every floor. The standpipe shares its riser zone with the sprinkler riser so one shutdown affects one stair.',
    parameters: {
      standpipeDiameter: { value: 0.1, unit: 'm', source: 'code:IBC 2021 §905 / NFPA 14 §7.6 (4 in)' },
      hoseValveHeight: { value: 1.2, unit: 'm (storey-local)', source: 'code:NFPA 14 §7.3.3 (0.9–1.5 m)' },
      controlValveHeight: { value: 1.5, unit: 'm (storey-local)', source: 'default' },
      hoseValveStoreyTrigger: { value: 4, unit: 'storeys', source: 'code:IBC 2021 §905.3.1 (floor > 9.1 m above access)' },
      fdcHeight: { value: 0.9, unit: 'm (storey-local, L01)', source: 'code:NFPA 14 §7.12.2 (0.45–1.2 m)' },
      riserOffsetInCore: { value: 0.3, unit: 'm from core corner', source: 'default' },
    },
    dependsOn: ['ARC-05'],
    references: ['IBC 2021 §905', 'NFPA 14 2019', 'Approved Document B Vol 1 §15 (fire mains)'],
  },
  {
    id: 'PLB-11',
    name: 'Pipes Below Ducts, Beside Trays',
    discipline: 'plumbing',
    problem:
      'Three trades share one corridor ceiling. Whoever installs first wins, the others drill through structure or drop the ceiling, and the corridor loses its head height.',
    solution:
      'Fix the lanes before anyone draws a run. Ducts take the centreline at the top of the plenum because they are biggest and least bendable; wet pipes take the lane toward the units 350 mm off centre and sit a band below the ducts, because a pipe can turn in 300 mm and needs a fall; the sprinkler main takes the 150 mm lane at the same height; cable trays take the far lane. Branches leave the lane perpendicular, above the unit entry door. A floor with no corridor (parking, retail, a lobby, a terrace of houses) has no spine to follow, so it gets ONE trunk per bar instead: along the bar\'s long axis, a metre inside the exterior wall on the side the risers are on, just under the slab — and every riser taps off it with a two-leg L. A main never chains risers together in id order: that is how a floor plate ends up with a diagonal snake across it.',
    parameters: {
      pipeLaneOffset: { value: -0.35, unit: 'm from corridor centreline', source: 'XD-02' },
      sprinklerLaneOffset: { value: -0.15, unit: 'm from corridor centreline', source: 'XD-02' },
      pipeBandBelowDuct: { value: 0.25, unit: 'm', source: 'core/coordination.plenumBands' },
      minClearanceAboveCeiling: { value: 0.05, unit: 'm', source: 'core/coordination.plenumBands' },
      trunkWallInset: { value: 1.0, unit: 'm inside the exterior wall', source: 'default (floors with no corridor)' },
      trunkDropBelowSoffit: { value: 0.35, unit: 'm', source: 'default (below the beam/duct zone)' },
      maxRunPoints: { value: 12, unit: 'points per PipeRun', source: 'default (a longer polyline is split into several runs)' },
      maxRunLengthFactor: { value: 1.5, unit: '× the floor outline\'s longest dimension', source: 'default (no run may cross the plate twice)' },
      orthogonalOnly: { value: true, source: 'default (every leg changes exactly one of x/y/z)' },
    },
    dependsOn: ['XD-02'],
    references: ['BSRIA BG 6 (Design Framework for Building Services)'],
  },
  {
    id: 'PLB-12',
    name: 'Booster Above Eight Storeys',
    discipline: 'plumbing',
    problem:
      'Street pressure is a fixed budget. Every storey spends about 30 kPa of it on static head alone, and the fixture at the top still needs enough left to work. Past roughly eight storeys the budget runs out and the top-floor shower dribbles.',
    solution:
      'Above the threshold storey count, put a booster set downstream of the meter and backflow preventer, sized on the same Hunter demand as the service, and zone the risers so no fixture sees more than the maximum working pressure.',
    parameters: {
      boosterStoreyThreshold: { value: 8, unit: 'storeys', source: 'default (≈ 45 m static at 300 kPa street pressure)' },
      staticHeadPerStorey: { value: 30, unit: 'kPa/storey', source: 'physics (ρgh, 3.05 m)' },
      minPressureAtFixture: { value: 100, unit: 'kPa', source: 'code:IPC 2021 §604.3 (15 psi)' },
      maxPressureAtFixture: { value: 550, unit: 'kPa', source: 'code:IPC 2021 §604.8 (80 psi)' },
      dcwRiserUpsizeStoreys: { value: 10, unit: 'storeys', source: 'PLB-01 (Ø32 → Ø50)' },
    },
    dependsOn: ['PLB-07', 'PLB-08'],
    references: ['IPC 2021 §604', 'BS 8558 §5'],
  },
];
