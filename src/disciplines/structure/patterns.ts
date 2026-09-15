/**
 * Structural pattern language (STR-01 .. STR-11).
 *
 * Each pattern is Alexander-style: the recurring problem in a residential building, then the
 * parametric rule the generator applies. Parameters carry units and a real source (code clause,
 * design guide or economic-span rule of thumb). `src/core/typologies.ts` references STR-04 and
 * STR-05 directly; XD-03 (Structure Follows Party Walls) is specialised here as STR-02.
 */
import type { Pattern } from '../../core/types.ts';

export const STRUCT_PATTERNS: Pattern[] = [
  {
    id: 'STR-01',
    name: 'System by Height',
    discipline: 'structure',
    problem:
      'Choosing a structural system from habit rather than from height and construction type produces buildings that are either uneconomic (concrete under five storeys) or not permitted (combustible framing above the height a code allows).',
    solution:
      'Pick the system from the number of storeys above grade and the access type: light wood frame or load-bearing masonry up to 3 storeys for direct-access and stair-core plans; wood (or mass timber) over a non-combustible podium up to 5–6 storeys; reinforced-concrete columns with a flat slab up to 12; RC flat plate with a shear-wall core above 12. `structuralSystemFor(typology, storeys)` in core/typologies.ts is the single decision point; the foundation follows from `foundationFor(system, storeys, parking)`.',
    parameters: {
      maxStoreysLightFrame: { value: 3, unit: 'storeys', source: 'code:IBC 2021 Table 504.4 (Type V-A, R-2, sprinklered)' },
      maxStoreysWoodOverPodium: { value: 6, unit: 'storeys', source: 'code:IBC 2021 §510.2 (Type III-A over Type I podium)' },
      maxStoreysFlatSlab: { value: 12, unit: 'storeys', source: 'RC frame economics; above this a shear core governs drift' },
      podiumNonCombustible: { value: true, source: 'code:IBC 2021 §510.2 / NBC 2020 §3.2.2' },
    },
    references: ['IBC 2021 Table 504.4 and §510.2', 'NBC 2020 Div. B §3.2.2', 'ACI 318-19', 'IStructE Manual for the design of concrete building structures to Eurocode 2'],
  },
  {
    id: 'STR-02',
    name: 'Grid on Party Walls',
    discipline: 'structure',
    problem:
      'A structural grid laid out for the structure alone lands columns in the middle of living rooms, breaks the unit rhythm and forces the architect to plan around lumps of concrete.',
    solution:
      'Lay the grid on lines architecture has already drawn: longitudinal lines on the two exterior wall centrelines and the two corridor wall centrelines (a single mid-depth line for houses and stair-core plans); transverse lines on the party wall centrelines. Merge transverse lines closer than the minimum spacing, and subdivide any bay longer than the economic span. Point plates take perimeter lines plus the core wall lines at the target spacing. Letters run along +X, numbers along +Y (I and O skipped, as in drafting practice).',
    parameters: {
      minSpacing: { value: 4.0, unit: 'm', source: 'below this, two columns are cheaper merged into one' },
      maxSpacing: { value: 9.0, unit: 'm', source: 'RC flat slab economic span (span/depth ≈ 30)' },
      targetSpacingPointPlate: { value: 7.5, unit: 'm', source: 'default' },
      sourceWallTypes: { value: 'exterior, party, corridor, core', source: 'typology' },
    },
    dependsOn: ['XD-03', 'ARC-02'],
    references: ['XD-03 Structure Follows Party Walls', 'Eurocode 2 (EN 1992-1-1) §7.4 span/depth limits'],
  },
  {
    id: 'STR-03',
    name: 'Columns Hide in Walls',
    discipline: 'structure',
    problem:
      'A column standing free in a dwelling is unusable area, an obstacle to furniture and a detail the builder has to case in. A column 300 mm off a party wall is the worst of both worlds.',
    solution:
      'Any grid intersection within the snap distance of an exterior, party, corridor or core wall centreline moves onto that centreline, so the column is absorbed into the wall zone and thickens only locally. Intersections that fall inside a stair, elevator or shaft footprint are dropped — the shear-wall core carries that area.',
    parameters: {
      snapDistance: { value: 0.6, unit: 'm', source: 'default (column half-width plus wall half-thickness)' },
      dropInsideCores: { value: true, source: 'STR-05' },
    },
    dependsOn: ['STR-02'],
    references: ['Alexander APL #205 Structure Follows Social Spaces'],
  },
  {
    id: 'STR-04',
    name: 'Podium Transfer Level',
    discipline: 'structure',
    problem:
      'A parking or retail podium wants large clear bays, the dwellings above want a grid on the party walls, and the two grids never agree. Carrying the residential walls straight down would fill the podium with columns and make it unusable.',
    solution:
      'Run the podium on a parking module grid, run the dwellings above on the party-wall grid, and put one transfer level between them: a thickened slab at the first residential floor plus transfer beams under it, on the residential grid lines, spanning between podium columns. The transfer level is recorded as `transferStorey` so mechanical, plumbing and electrical know that storey has a deeper structural zone.',
    parameters: {
      parkingModuleAlongBar: { value: 8.4, unit: 'm', source: 'three 2.6–2.8 m stalls per bay' },
      parkingModuleAcross: { value: 16.8, unit: 'm', source: '5.4 m stall + 6.0 m aisle + 5.4 m stall' },
      transferSlabThickness: { value: 0.3, unit: 'm', source: 'default' },
      transferBeamWidth: { value: 0.5, unit: 'm', source: 'default' },
      transferBeamDepth: { value: 0.9, unit: 'm', source: 'span/10 at a 9 m transfer span' },
    },
    dependsOn: ['STR-02', 'XD-03'],
    references: ['IBC 2021 §510.2', 'ACI 318-19 §18 (transfer of forces at discontinuities)'],
  },
  {
    id: 'STR-05',
    name: 'Core as Shear Spine',
    discipline: 'structure',
    problem:
      'Wind and earthquake want a stiff element; dwellings want thin partitions and open corners. Bracing the perimeter blocks the views and the windows that are the whole point of housing.',
    solution:
      'The stair and elevator core is already a fire-rated, window-free box that runs the full height — make it the lateral system. Every core wall becomes a structural shear wall (LoadBearing, IFC predefined type SHEAR); no columns are placed inside the core footprint; above 20 storeys the party walls flanking the core are recruited as shear walls too, so the spine widens where drift governs.',
    parameters: {
      coreWallRole: { value: 'shear', source: 'default' },
      designShearWallThickness: { value: 0.3, unit: 'm', source: 'ACI 318-19 §18.10 (special structural walls)' },
      recruitFlankingPartyWallsAbove: { value: 20, unit: 'storeys', source: 'drift-governed above roughly 20 storeys' },
      driftLimit: { value: 0.002, unit: 'h (inter-storey)', source: 'code:ASCE 7-22 Table 12.12-1 (serviceability target for residential)' },
    },
    dependsOn: ['ARC-04'],
    references: ['ACI 318-19 §18.10', 'ASCE 7-22 Ch. 12', 'EN 1998-1 §5.4'],
  },
  {
    id: 'STR-06',
    name: 'Foundation by Load and Ground',
    discipline: 'structure',
    problem:
      'Foundations are invisible and therefore chosen late, which is when they are most expensive to change. The same pad footing appears under a bungalow and under a tower.',
    solution:
      'Derive the foundation from the load path above: bearing walls get strip footings (and a stem wall up to the ground slab); a column frame gets pad footings sized on the tributary load; a heavy or basement structure gets a raft; anything over 12 storeys, or with a basement under 8+ storeys, goes to bored piles with pile caps. Single-storey slab-on-grade keeps a thickened edge only. All footings are founded on one level: the underside sits on the `FND` storey datum.',
    parameters: {
      stripWidth: { value: 0.6, unit: 'm', source: 'default (bearing-wall strip on medium-dense soil)' },
      stripHeight: { value: 0.3, unit: 'm', source: 'default' },
      padSizeFormula: { value: '0.15 x storeys + 1.2, capped at 3.5', unit: 'm square', source: 'default' },
      padHeight: { value: 0.5, unit: 'm', source: 'default' },
      raftThickness: { value: 0.8, unit: 'm', source: 'default' },
      pileDiameter: { value: 0.6, unit: 'm', source: 'default (bored pile)' },
      pileLength: { value: 18, unit: 'm (25 m above 25 storeys)', source: 'default' },
      pileCapSize: { value: 1.8, unit: 'm square', source: 'default' },
      allowableBearingPressure: { value: 150, unit: 'kPa', source: 'assumed medium-dense sand / stiff clay' },
    },
    dependsOn: ['STR-01'],
    references: ['ACI 318-19 §13', 'EN 1997-1 (Eurocode 7)', 'AS 2870', 'IBC 2021 Table 1806.2'],
  },
  {
    id: 'STR-07',
    name: 'Slab Openings Follow Shafts',
    discipline: 'structure',
    problem:
      'Risers get cut through slabs on site, next to columns and through reinforcement, because nobody put the holes in the structural model.',
    solution:
      'Every stair flight, elevator shaft and MEP shaft that architecture declares on a storey becomes a rectangular opening in that storey structural slab, at the architectural rect. The lowest slab is left solid except for shafts that actually continue down, so no hole is cut for a stair or lift pit that stops there.',
    parameters: {
      openingSources: { value: 'arch.stairs, arch.elevators, arch.shafts', source: 'typology' },
      lowestSlabStairOpening: { value: false, source: 'only when a basement exists' },
    },
    dependsOn: ['XD-04', 'ARC-04'],
    references: ['ACI 318-19 §8.5.4 (openings in slab systems)'],
  },
  {
    id: 'STR-08',
    name: 'Headers over Openings',
    discipline: 'structure',
    problem:
      'A wide window or a patio door in a bearing wall interrupts the load path; without a header the studs over the opening carry nothing and the trimmer studs are overloaded.',
    solution:
      'Every opening wider than the trigger width in a bearing wall receives a header (lintel) spanning the opening plus a bearing length each end, its underside just above the opening head, its width equal to the wall thickness. Narrower openings are covered by the standard trimmer detail and are not modelled.',
    parameters: {
      triggerWidth: { value: 1.2, unit: 'm', source: 'default (below this, standard trimmer detail)' },
      bearingEachEnd: { value: 0.15, unit: 'm', source: 'code:NDS 2018 §3.10 bearing area' },
      headerDepth: { value: 0.2, unit: 'm', source: 'default (2-ply LVL / precast lintel)' },
      clearanceAboveOpening: { value: 0.05, unit: 'm', source: 'default' },
    },
    dependsOn: ['STR-01'],
    references: ['NDS 2018 §3.10', 'CSA O86-19', 'BS EN 845-2 (masonry lintels)'],
  },
  {
    id: 'STR-09',
    name: 'Economic Span',
    discipline: 'structure',
    problem:
      'Spans chosen for architectural convenience alone either waste material (short spans, many columns) or blow the floor depth and the building height (long spans).',
    solution:
      'Keep bays inside the economic band for the material: 6–9 m for reinforced concrete flat slabs, 4–6 m for timber joist and CLT floors, 6–12 m for steel with secondary beams. A bay longer than the band is subdivided with an intermediate grid line; a bay shorter than the merge distance loses its line.',
    parameters: {
      rcSpanMin: { value: 6.0, unit: 'm', source: 'RC flat slab economics' },
      rcSpanMax: { value: 9.0, unit: 'm', source: 'span/depth 30 at 250–300 mm' },
      timberSpanMin: { value: 4.0, unit: 'm', source: 'NDS / CSA O86 joist tables' },
      timberSpanMax: { value: 6.0, unit: 'm', source: 'I-joist and 5-ply CLT residential spans' },
      steelSecondarySpacing: { value: 3.0, unit: 'm', source: 'composite metal deck unshored span' },
    },
    dependsOn: ['STR-02'],
    references: ['ACI 318-19 Table 8.3.1.1', 'EN 1992-1-1 §7.4.2', 'NDS 2018 Supplement span tables', 'AISC Design Guide 3'],
  },
  {
    id: 'STR-10',
    name: 'Balanced Column Sizes',
    discipline: 'structure',
    problem:
      'One column size repeated up a whole building is either oversized at the top or unsafe at the bottom, and a size chosen per column produces forty different formwork sizes.',
    solution:
      'Size each column from the load it actually carries: axial load N = (storeys above) x (dead + live) x tributary area, required area A = N / (0.3 f\'c) for concrete, then round up to the nearest 50 mm and clamp to the system band. Columns on one storey therefore share a small family of sizes and the family steps as you go down.',
    parameters: {
      axialFormula: { value: "A = N / (0.3 x f'c), N = storeysAbove x (dead + live) x tributaryArea", source: 'code:ACI 318-19 §22.4 (simplified axial capacity, low eccentricity)' },
      concreteStrength: { value: 30, unit: 'MPa (C30/37)', source: 'default' },
      roundTo: { value: 0.05, unit: 'm', source: 'formwork module' },
      rcMinSide: { value: 0.4, unit: 'm', source: 'default' },
      rcMaxSide: { value: 0.9, unit: 'm', source: 'default' },
      steelBand: { value: '0.30-0.50 square HSS', unit: 'm', source: 'default' },
      timberPost: { value: 0.14, unit: 'm square', source: 'default (140 x 140 sawn post)' },
    },
    dependsOn: ['STR-02', 'STR-09'],
    references: ['ACI 318-19 §22.4', 'EN 1992-1-1 §5.8', 'AISC 360-22 Ch. E'],
  },
  {
    id: 'STR-11',
    name: 'Stiff Roof Diaphragm',
    discipline: 'structure',
    problem:
      'The top of a building is the least loaded and the most forgotten level, yet it is what ties the walls and the core together at the point where lateral deflection is largest.',
    solution:
      'A flat roof gets a full structural roof slab acting as a diaphragm, tied into the core and the perimeter rim beam. A pitched roof gets no structural slab from this discipline (architecture emits the IfcRoof) but the diaphragm requirement is recorded against the roof storey: sheathed and blocked, with continuous ties over the party walls.',
    parameters: {
      flatRoofSlabThickness: { value: 0.2, unit: 'm', source: 'default' },
      pitchedRoofDiaphragm: { value: 'sheathed and blocked, continuous ties over party walls', source: 'code:IBC 2021 §2308.4 / NDS SDPWS 4.2' },
      roofLiveLoad: { value: 1.0, unit: 'kPa', source: 'code:ASCE 7-22 Table 4.3-1 (ordinary flat roof, 20 psf)' },
    },
    dependsOn: ['STR-05'],
    references: ['ASCE 7-22 §12.3 (diaphragm flexibility)', 'AWC SDPWS-2021 §4.2', 'IBC 2021 §2308.4'],
  },
];
