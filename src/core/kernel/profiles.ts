/**
 * The nine ceiling profiles, as data, and the resolver that stacks one against a concrete storey.
 *
 * Order is always from the slab soffit DOWNWARD, and the rationale is encoded on every band:
 *   structure first          — fixed by span, nothing else may claim it;
 *   sprinkler tight to slab  — the deflector must sit 25–300 mm below the ceiling (NFPA 13 §8.6.4.1.1.1);
 *   ducts set the depth      — biggest rigid section, so everything that runs along the corridor fits BESIDE them
 *                              (lanes, see lanes.ts) rather than under them;
 *   gravity crosses in its own band — one invert, one slope, so drain crossings get dedicated stations;
 *   pressure pipes fit around — they can rise, fall and offset;
 *   electrical lowest         — altered many times over the building's life and must stay reachable (NEC 110.26);
 *   then the void, then the ceiling plane.
 *
 * `stackProfile` is the only place a ceiling height is decided: it places the bands at natural depth, compresses the
 * most flexible bands to their minimum, drops droppable bands, and only then asks the pre-sizing to RAISE the
 * floor-to-floor. **The ceiling height is an output of the profile, never an input.**
 *
 * Two anchoring conventions live here (a band is one or the other, never both):
 *   soffit-anchored  cls ∈ {structure, transfer, parallel, crossing, void, ceiling} — stacked down from the soffit;
 *   floor-anchored   cls ∈ {equipment} and purpose 'crossing' on a floor profile — stacked up from FFL 0;
 *   cls 'clear'      the zone between the two stacks; nothing may occupy it.
 * `roof-plant` is stacked entirely upward (its "soffit" is the sky).
 */
import type { FloorUse, RoomType } from '../types.ts';
import type { Issue, RuleSet } from '../rules/types.ts';
import { cite } from '../rules/SOURCES.ts';
import { CLEAR_HEIGHTS, ZONE_CLEARS } from './clearances.ts';
import type {
  Band, BandPurpose, CeilingProfile, ElementKind, ProfileBook, ProfileId, ProfileZone, ResolvedBand,
  StackProfileInput, StackProfileResult, StoreyProfile,
} from './types.ts';

const TOL = 1e-9;

/** Profiles whose bands are measured UP from the floor (the roof has no soffit above it). */
const UPWARD: readonly ProfileId[] = ['roof-plant'];

/** Kinds that may share a corridor/unit service band with the ducts. */
const PRESSURE: readonly ElementKind[] = ['dcw', 'dhw', 'hwr', 'gas'];
const GRAVITY: readonly ElementKind[] = ['waste', 'vent', 'storm'];
const TRAYS: readonly ElementKind[] = ['tray-power', 'tray-data', 'conduit', 'busduct'];
const CEILING_DEVICES: readonly ElementKind[] = ['light', 'sensor', 'sprinkler-head', 'air-terminal'];

function zonesOf(id: ProfileId): ProfileZone[] {
  return ZONE_CLEARS.filter(z => z.profile === id).map(z => ({ id: z.zone, minClear: z.minClear, source: z.source, note: z.note }));
}

function band(b: Band): Band {
  return b;
}

// ---------------------------------------------------------------------------------------------------------------
// The nine profiles
// ---------------------------------------------------------------------------------------------------------------

const RESI_UNIT: CeilingProfile = {
  id: 'resi-unit',
  label: 'Dwelling interior — flat soffit',
  appliesTo: {
    floorUses: ['residential'],
    roomTypes: ['living', 'dining', 'kitchen', 'living-kitchen', 'bedroom', 'master-bedroom', 'bathroom', 'ensuite',
      'powder', 'wc', 'hall', 'entry', 'closet', 'walk-in-closet', 'laundry', 'utility', 'storage', 'study', 'den'],
  },
  hasCeiling: true,
  clearHeight: CLEAR_HEIGHTS['resi-unit'],
  zones: zonesOf('resi-unit'),
  bands: [
    band({
      id: 'resi-unit/structure', purpose: 'structure', cls: 'structure', owner: 'structure',
      topBelowSoffit: 0, depth: 0, minDepth: 0, clearanceAbove: 0, clearanceBelow: 0,
      allows: ['slab', 'beam', 'drop-panel'], flexibility: 1, droppable: false, depthFromPresize: 'beamDAboveUnit',
      rationale: 'Sized by span; nothing else may claim it. A dwelling wants a flat soffit, so the pre-sizing prefers a flat slab here and reports the depth it needed.',
      source: cite('presize', '(STR-09)'),
    }),
    band({
      id: 'resi-unit/service-band', purpose: 'service', cls: 'parallel', owner: 'shared',
      topBelowSoffit: 0.05, depth: 0.25, minDepth: 0.1, clearanceAbove: 0.05, clearanceBelow: 0.05,
      allows: ['duct', 'duct-fitting', ...PRESSURE, 'waste', 'vent', 'sprinkler-branch', 'conduit'],
      flexibility: 3, droppable: false,
      rationale: 'The ONLY dropped zone in the flat: a bulkhead over the hall and the wet-wall strip, so the living rooms keep a flat 2.5 m ceiling. Hanger spacing inside it is SMACNA 2.44 m.',
      source: cite('SMACNA 3rd ed.', 'Table 5-1'),
    }),
    band({
      id: 'resi-unit/ceiling-void', purpose: 'ceiling-void', cls: 'void', owner: 'shared',
      topBelowSoffit: 0, depth: 0.05, minDepth: 0.05, clearanceAbove: 0, clearanceBelow: 0,
      allows: [...CEILING_DEVICES], flexibility: 5, droppable: false,
      rationale: 'Downlights, detectors and the diffuser plenum. Absorbs whatever depth is left over, which is what lets the ceiling sit at its target rather than at the minimum.',
      source: cite('NEC 2023', '410.36'),
    }),
    band({
      id: 'resi-unit/ceiling', purpose: 'ceiling', cls: 'ceiling', owner: 'architecture',
      topBelowSoffit: 0, depth: 0.03, minDepth: 0.03, clearanceAbove: 0, clearanceBelow: 0,
      allows: [], flexibility: 2, droppable: false,
      rationale: 'Plasterboard ceiling on resilient bars; the clear height below it is the code dimension.',
      source: cite('IBC 2021', '§1208.2'),
    }),
  ],
  laneSetId: null,
  elsewhere: [
    { kind: 'waste', home: 'chase', why: 'A stack in a flat ceiling is a slab penetration per storey and an acoustic leak between dwellings; it belongs in the wet-wall chase.', source: `${cite('IPC 2021', '§704')}; ${cite('ADE 2015', '§5')}` },
    { kind: 'vent', home: 'chase', why: 'Rises with its stack.', source: cite('IPC 2021', '§903') },
    { kind: 'dcw', home: 'chase', why: 'Riser in the chase, branch in the service band.', source: cite('IPC 2021', '§305') },
    { kind: 'dhw', home: 'chase', why: 'Riser in the chase, branch in the service band.', source: cite('IPC 2021', '§305') },
    { kind: 'panel', home: 'wall', why: 'A panelboard may not be in a bathroom, a clothes closet or over stairs, and needs 1.07 m of working space — so it goes on the hall wall.', source: cite('NEC 2023', '240.24(D) and (E)') },
    { kind: 'sprinkler-head', home: 'ceiling', why: 'Deflector 25–300 mm below the ceiling plane.', source: cite('NFPA 13 2022', '§8.6.4.1.1.1') },
  ],
  notes: 'XD-07 Flat Soffit Dwelling: everything that can be in a wall is in a wall, so the dwelling ceiling is flat except over the hall.',
};

function corridorBands(prefix: string): Band[] {
  return [
    band({
      id: `${prefix}/structure`, purpose: 'structure', cls: 'structure', owner: 'structure',
      topBelowSoffit: 0, depth: 0, minDepth: 0, clearanceAbove: 0, clearanceBelow: 0,
      allows: ['slab', 'beam', 'drop-panel'], flexibility: 1, droppable: false, depthFromPresize: 'beamDAbove',
      rationale: 'Structure first: the depth is fixed by span and cannot be moved to suit a service.',
      source: cite('presize', '(STR-09)'),
    }),
    band({
      id: `${prefix}/sprinkler`, purpose: 'sprinkler', cls: 'parallel', owner: 'plumbing',
      topBelowSoffit: 0.025, depth: 0.1, minDepth: 0.08, clearanceAbove: 0.025, clearanceBelow: 0.025,
      allows: ['sprinkler-main', 'sprinkler-branch'], flexibility: 1, droppable: false,
      rationale: 'Tight to the slab by NFPA 13: the deflector must sit 25–300 mm below a smooth ceiling, so the main hugs the soffit and branch lines can drop anywhere without jogging round a duct.',
      source: `${cite('NFPA 13 2022', '§8.6.4.1.1.1')}; ${cite('NFPA 13 2022', '§9.2.2')}`,
    }),
    band({
      id: `${prefix}/service`, purpose: 'service', cls: 'parallel', owner: 'shared',
      topBelowSoffit: 0, depth: 0.3, minDepth: 0.2, clearanceAbove: 0.05, clearanceBelow: 0.05,
      allows: ['duct', 'duct-fitting', ...PRESSURE, ...TRAYS, 'standpipe'], flexibility: 3, droppable: false,
      rationale: 'Ducts are the biggest section, so they set the depth of this band; everything else that runs ALONG the corridor sits beside them in its own lane (lanes.ts), never under them.',
      source: `${cite('SMACNA 3rd ed.', 'Chapter 2')}; ${cite('ASHRAE Fundamentals 2021', 'Ch. 21')}`,
    }),
    band({
      id: `${prefix}/crossing`, purpose: 'crossing', cls: 'crossing', owner: 'shared',
      topBelowSoffit: 0, depth: 0.2, minDepth: 0.15, clearanceAbove: 0.05, clearanceBelow: 0.05,
      allows: [...GRAVITY, 'duct', 'duct-fitting', 'conduit', 'sprinkler-branch', ...PRESSURE], flexibility: 2, droppable: false,
      rationale: 'Gravity is the least flexible service after structure, so drain CROSSINGS get their own depth and their own along-stations; a branch duct into a flat and a tray drop cross here too.',
      source: cite('IPC 2021', 'Table 704.1'),
    }),
    band({
      id: `${prefix}/ceiling-void`, purpose: 'ceiling-void', cls: 'void', owner: 'shared',
      topBelowSoffit: 0, depth: 0.05, minDepth: 0.05, clearanceAbove: 0, clearanceBelow: 0,
      allows: [...CEILING_DEVICES], flexibility: 5, droppable: false,
      rationale: 'Electrical last and most accessible: the void and the tile plane are where trays and their taps are reached for the building’s life.',
      source: `${cite('NEC 2023', '110.26')}; ${cite('NEC 2023', '392.30(A)')}`,
    }),
    band({
      id: `${prefix}/ceiling`, purpose: 'ceiling', cls: 'ceiling', owner: 'architecture',
      topBelowSoffit: 0, depth: 0.03, minDepth: 0.03, clearanceAbove: 0, clearanceBelow: 0,
      allows: [], flexibility: 2, droppable: false,
      rationale: 'Suspended ceiling; the clear height below it is the means-of-egress dimension.',
      source: cite('IBC 2021', '§1003.2'),
    }),
  ];
}

const CORRIDOR_ELSEWHERE: CeilingProfile['elsewhere'] = [
  { kind: 'waste', home: 'shaft', why: 'A tower stack rises in a rated shaft, not along a corridor ceiling.', source: cite('IPC 2021', '§708') },
  { kind: 'vent', home: 'shaft', why: 'With its stack.', source: cite('IPC 2021', '§903') },
  { kind: 'dcw', home: 'shaft', why: 'Riser in the shaft, distribution in the pressure lane.', source: cite('IPC 2021', '§305') },
  { kind: 'dhw', home: 'shaft', why: 'Riser in the shaft, distribution in the pressure lane.', source: cite('ASHRAE 90.1-2019', '§6.5.4.6') },
  { kind: 'panel', home: 'wall', why: 'The floor distribution board sits in the corridor wall with its 1.07 m working space in the corridor.', source: cite('NEC 2023', '110.26(A)(1)') },
  { kind: 'duct', home: 'shaft', why: 'Vertical air risers are in the shaft; only horizontal trunks are in the corridor.', source: cite('SMACNA 3rd ed.', 'Chapter 2') },
];

const RESI_CORRIDOR: CeilingProfile = {
  id: 'resi-corridor',
  label: 'Residential corridor — the service spine (XD-02)',
  appliesTo: { floorUses: ['residential'], roomTypes: ['corridor', 'lift-lobby'] },
  hasCeiling: true,
  clearHeight: CLEAR_HEIGHTS['resi-corridor'],
  zones: zonesOf('resi-corridor'),
  bands: corridorBands('resi-corridor'),
  laneSetId: 'resi-corridor',
  elsewhere: CORRIDOR_ELSEWHERE,
  notes: 'XD-06 Ceiling Sandwich: the band order is the move-cost order, so the thing that is hardest to move is nearest the slab.',
};

/** A lobby or an amenity room has no dwellings around it, so nothing crosses its ceiling: the crossing band goes. */
function publicRoomBands(prefix: string): Band[] {
  return corridorBands(prefix).filter(b => b.purpose !== 'crossing');
}

const LOBBY: CeilingProfile = {
  id: 'lobby',
  label: 'Residential lobby / entrance hall',
  appliesTo: { floorUses: ['lobby-residential'], roomTypes: ['lobby', 'mail', 'bike-store'] },
  hasCeiling: true,
  clearHeight: CLEAR_HEIGHTS['lobby'],
  zones: zonesOf('lobby'),
  bands: publicRoomBands('lobby'),
  laneSetId: 'resi-corridor',
  elsewhere: CORRIDOR_ELSEWHERE,
  notes: 'The corridor band order without the crossing band — no dwelling branch crosses a lobby — and a higher ceiling target, because the lobby is the one room every resident uses every day.',
};

const AMENITY: CeilingProfile = {
  id: 'amenity',
  label: 'Amenity / common room',
  appliesTo: { floorUses: ['amenity'], roomTypes: ['amenity', 'gym', 'lounge', 'shared-kitchen', 'shared-living', 'dining-hall', 'flex'] },
  hasCeiling: true,
  clearHeight: CLEAR_HEIGHTS['amenity'],
  zones: zonesOf('amenity'),
  bands: publicRoomBands('amenity'),
  laneSetId: 'resi-corridor',
  elsewhere: CORRIDOR_ELSEWHERE,
  notes: 'As the lobby, with a 3.0 m ceiling target: a gym or a dining hall reads as a room, not a corridor.',
};

const PARKING: CeilingProfile = {
  id: 'parking',
  label: 'Car park — exposed structure, no ceiling',
  appliesTo: { floorUses: ['parking'], roomTypes: ['parking', 'garage'] },
  hasCeiling: false,
  clearHeight: CLEAR_HEIGHTS['parking'],
  zones: zonesOf('parking'),
  bands: [
    band({
      id: 'parking/structure', purpose: 'structure', cls: 'structure', owner: 'structure',
      topBelowSoffit: 0, depth: 0, minDepth: 0, clearanceAbove: 0, clearanceBelow: 0,
      allows: ['slab', 'beam', 'column', 'drop-panel'], flexibility: 1, droppable: false, depthFromPresize: 'beamDAbove',
      rationale: 'Exposed structure; the drop panel at each column is the governing local obstruction, so the clear height is measured under it.',
      source: cite('presize', '(STR-09)'),
    }),
    band({
      id: 'parking/sprinkler', purpose: 'sprinkler', cls: 'parallel', owner: 'plumbing',
      topBelowSoffit: 0.025, depth: 0.1, minDepth: 0.08, clearanceAbove: 0.025, clearanceBelow: 0.025,
      allows: ['sprinkler-main', 'sprinkler-branch', 'sprinkler-head'], flexibility: 1, droppable: false,
      rationale: 'Dry-pipe system in an unheated garage, tight to the soffit so a vehicle never touches it.',
      source: `${cite('NFPA 13 2022', '§8.3.3')}; ${cite('NFPA 13 2022', '§8.6.4.1.1.1')}`,
    }),
    band({
      id: 'parking/exhaust', purpose: 'exhaust', cls: 'parallel', owner: 'mechanical',
      topBelowSoffit: 0, depth: 0.4, minDepth: 0.3, clearanceAbove: 0.05, clearanceBelow: 0.05,
      allows: ['duct', 'duct-fitting', 'fan'], flexibility: 3, droppable: false,
      rationale: 'CO/NO₂ extract on the AISLE centreline, where the clear height is measured, because a stall is 5.4 m deep and is never walked under.',
      source: `${cite('IMC 2021', '§404.2')}; ${cite('ASHRAE 62.1-2019', 'Table 6-4')}`,
    }),
    band({
      id: 'parking/jet-fan', purpose: 'duct', cls: 'equipment', owner: 'mechanical',
      topBelowSoffit: 0, depth: 0.35, minDepth: 0.35, clearanceAbove: 0, clearanceBelow: 0.25,
      allows: ['jet-fan'], flexibility: 4, droppable: true,
      rationale: 'Impulse ventilation INSTEAD of a full duct network (never both): spacing 15–20 m, thrust ≈ 50 N, 0.25 m clear below the discharge and 1.0 m in front. Dropping this band is the correct outcome when a ducted extract fits.',
      source: `${cite('BS 7346-7:2013', '§6')}; ${cite('NFPA 88A 2019', '§5.4')}`,
    }),
    band({
      id: 'parking/ev-tray', purpose: 'tray', cls: 'parallel', owner: 'electrical',
      topBelowSoffit: 0, depth: 0.1, minDepth: 0.08, clearanceAbove: 0.05, clearanceBelow: 0.05,
      allows: ['tray-power', 'conduit', 'ev-charger'], flexibility: 5, droppable: true,
      rationale: 'Tray over the STALL HEAD, not the aisle, so EV capacity can be added over the building’s life without touching the clear height.',
      source: `${cite('NEC 2023', '625.40')}; ${cite('NEC 2023', '392.30(A)')}`,
    }),
    band({
      id: 'parking/lighting', purpose: 'lighting', cls: 'parallel', owner: 'electrical',
      topBelowSoffit: 0, depth: 0.12, minDepth: 0.1, clearanceAbove: 0.05, clearanceBelow: 0.05,
      allows: ['light', 'sensor', 'conduit'], flexibility: 5, droppable: false,
      rationale: 'Surface luminaires on the soffit between the structural beams; one luminaire per 81 m² (ELE-06).',
      source: cite('IECC 2021', 'Table C405.3.2(2)'),
    }),
    band({
      id: 'parking/drain', purpose: 'gravity-drain', cls: 'crossing', owner: 'plumbing',
      topBelowSoffit: 0, depth: 0.15, minDepth: 0.12, clearanceAbove: 0.05, clearanceBelow: 0,
      allows: ['trench-drain', 'storm', 'waste'], flexibility: 1, droppable: false,
      rationale: 'FLOOR-anchored: the collector trench runs along the aisle low line, falling monotonically toward the sewer or the sump. A drain is in the slab, not in the ceiling.',
      source: `${cite('IPC 2021', '§1101.2')}; ${cite('IPC 2021', 'Table 704.1')}`,
    }),
    band({
      id: 'parking/clear', purpose: 'clear', cls: 'clear', owner: 'none',
      topBelowSoffit: 0, depth: 0, minDepth: 0, clearanceAbove: 0, clearanceBelow: 0,
      allows: [], flexibility: 1, droppable: false,
      rationale: 'Nothing may occupy this band: it is the vehicle and pedestrian envelope.',
      source: cite('IBC 2021', '§406.4.1'),
    }),
  ],
  laneSetId: 'parking',
  elsewhere: [
    { kind: 'switchgear', home: 'plinth', why: 'In a plant room, on a housekeeping pad, with the dedicated space above it kept free of every foreign system (the keep-out the kernel registers).', source: cite('NEC 2023', '110.26(E)(1)(b)') },
    { kind: 'sump', home: 'floor', why: 'At the low point of the drain trench; below the gravity horizon everything is pumped.', source: cite('IPC 2021', '§712.1') },
    { kind: 'ejector', home: 'floor', why: 'Duplex, alternating, with the sump.', source: cite('IPC 2021', '§712.4.2') },
  ],
  notes: 'XD-08 Exposed Garage Services: nothing is concealed, so every service is coordinated against the clear height directly, and the accessible route keeps 2.50 m.',
};

const RETAIL_SHELL: CeilingProfile = {
  id: 'retail-shell',
  label: 'Retail shell and core — deep tenant plenum',
  appliesTo: { floorUses: ['retail'], roomTypes: ['retail'] },
  hasCeiling: false,
  clearHeight: CLEAR_HEIGHTS['retail-shell'],
  zones: zonesOf('retail-shell'),
  bands: [
    band({
      id: 'retail-shell/structure', purpose: 'structure', cls: 'structure', owner: 'structure',
      topBelowSoffit: 0, depth: 0, minDepth: 0, clearanceAbove: 0, clearanceBelow: 0,
      allows: ['slab', 'beam', 'drop-panel'], flexibility: 1, droppable: false, depthFromPresize: 'beamDAbove',
      rationale: 'Sized by span, and over a retail span that is deep: the shell clear height the lease promises is measured under whatever this turns out to be, which is why it is resolved before the tenant plenum.',
      source: cite('presize', '(STR-09)'),
    }),
    band({
      id: 'retail-shell/transfer', purpose: 'transfer', cls: 'structure', owner: 'structure',
      topBelowSoffit: 0, depth: 0, minDepth: 0, clearanceAbove: 0, clearanceBelow: 0,
      allows: ['beam', 'slab'], flexibility: 1, droppable: false, depthFromPresize: 'transferZoneDepth',
      rationale: 'On the storey UNDER the transfer slab the podium/tower interface eats the top of the plenum (the transfer BEAM; the transfer slab is already out of the soffit) and no MEP may enter it. A shop is the one use that cannot simply step its ceiling down under the beams, because the tenant has not built a ceiling yet — so retail counts the whole zone and asks for a taller podium storey instead. Zero on every other storey.',
      source: cite('presize', '(STR-04 transfer zone)'),
    }),
    band({
      id: 'retail-shell/landlord', purpose: 'landlord-service', cls: 'parallel', owner: 'shared',
      topBelowSoffit: 0, depth: 0.3, minDepth: 0.2, clearanceAbove: 0.05, clearanceBelow: 0.05,
      allows: ['sprinkler-main', 'duct', 'dcw', 'waste', 'tray-power', 'standpipe'], flexibility: 2, droppable: false,
      rationale: 'Base-build grid, smoke extract and landlord power, tight under the structure and CAPPED AT THE DEMISE: a landlord service that crosses a tenancy line is cut on the first fit-out.',
      source: cite('IBC 2021', '§713.4'),
    }),
    band({
      id: 'retail-shell/tenant-plenum', purpose: 'tenant-plenum', cls: 'void', owner: 'none',
      topBelowSoffit: 0, depth: 1.0, minDepth: 0.7, clearanceAbove: 0, clearanceBelow: 0,
      allows: [], flexibility: 4, droppable: true,
      rationale: 'Reserved EMPTY for the tenant’s own fit-out, so base-build cannot take it. It is droppable because in a shallow podium (3.0 m floor-to-floor, or the storey under a transfer beam) a deep plenum and a usable shop cannot both exist: dropping it records that this unit gets an exposed soffit instead.',
      source: cite('default', '(landlord shell-and-core standard)'),
    }),
    band({
      id: 'retail-shell/clear', purpose: 'clear', cls: 'clear', owner: 'none',
      topBelowSoffit: 0, depth: 0, minDepth: 0, clearanceAbove: 0, clearanceBelow: 0,
      allows: [], flexibility: 1, droppable: false,
      rationale: 'The tenant’s room: the shell ceiling is not built, so this is the clear height the lease promises.',
      source: cite('IBC 2021', '§1208.2'),
    }),
  ],
  laneSetId: 'retail-shell',
  elsewhere: [
    { kind: 'waste', home: 'shaft', why: 'A tower stack in a tenant plenum is cut at the first fit-out; enclose it in a 1-hour chase inside a demising or core wall.', source: `${cite('IBC 2021', '§713.4')}; ${cite('IBC 2021', '§708')}` },
    { kind: 'vent', home: 'shaft', why: 'With its stack.', source: cite('IPC 2021', '§903') },
    { kind: 'storm', home: 'shaft', why: 'With the tower drainage.', source: cite('IPC 2021', '§1101.2') },
    { kind: 'dcw', home: 'shaft', why: 'Tower risers never pass through a tenancy.', source: cite('IPC 2021', '§305') },
    { kind: 'dhw', home: 'shaft', why: 'Tower risers never pass through a tenancy.', source: cite('IPC 2021', '§305') },
  ],
  notes: 'XD-09 Shell-and-Core Demise: landlord services terminate capped, valved and metered within 1.0 m of the demise line; the tenant plenum is a reservation of emptiness.',
};

const MEP_ROOM: CeilingProfile = {
  id: 'mep-room',
  label: 'Plant room — equipment clearances, plinths, no ceiling',
  appliesTo: { floorUses: ['mechanical'], roomTypes: ['mech-room', 'elec-room', 'water-room', 'plant', 'utility'] },
  hasCeiling: false,
  clearHeight: CLEAR_HEIGHTS['mep-room'],
  zones: zonesOf('mep-room'),
  bands: [
    band({
      id: 'mep-room/structure', purpose: 'structure', cls: 'structure', owner: 'structure',
      topBelowSoffit: 0, depth: 0, minDepth: 0, clearanceAbove: 0, clearanceBelow: 0,
      allows: ['slab', 'beam', 'drop-panel'], flexibility: 1, droppable: false, depthFromPresize: 'beamDAbove',
      rationale: 'Sized by span; exposed, so every service hung from it is measured against the access headroom directly.',
      source: cite('presize', '(STR-09)'),
    }),
    band({
      id: 'mep-room/overhead', purpose: 'service', cls: 'parallel', owner: 'shared',
      topBelowSoffit: 0, depth: 0.45, minDepth: 0.3, clearanceAbove: 0.05, clearanceBelow: 0.05,
      allows: ['duct', 'duct-fitting', ...PRESSURE, ...GRAVITY, ...TRAYS, 'sprinkler-main', 'sprinkler-branch', 'standpipe'],
      flexibility: 3, droppable: false,
      rationale: 'Everything overhead, tight to the soffit, so the FLOOR stays clear for equipment replacement — the one thing a plant room exists for.',
      source: cite('IMC 2021', '§306.3'),
    }),
    band({
      id: 'mep-room/access', purpose: 'access', cls: 'clear', owner: 'none',
      topBelowSoffit: 0, depth: 0, minDepth: 0, clearanceAbove: 0, clearanceBelow: 0,
      allows: [], flexibility: 1, droppable: false,
      rationale: 'Nothing but equipment inside its own footprint and plinth: the working space in front of switchgear is 1.07 m and 2.00 m high.',
      source: `${cite('IMC 2021', '§306.3')}; ${cite('NEC 2023', 'Table 110.26(A)(1)')}`,
    }),
    band({
      id: 'mep-room/plinth', purpose: 'equipment', cls: 'equipment', owner: 'shared',
      topBelowSoffit: 0, depth: 0.15, minDepth: 0.1, clearanceAbove: 0, clearanceBelow: 0,
      allows: ['plinth', 'pump', 'tank', 'ahu', 'ejector', 'switchgear', 'sump'], flexibility: 4, droppable: false,
      rationale: 'FLOOR-anchored housekeeping pad: equipment is never set directly on the slab, so it survives a wash-down or a leak.',
      source: cite('IMC 2021', '§303.3'),
    }),
  ],
  laneSetId: null,
  elsewhere: [
    { kind: 'panel', home: 'wall', why: 'On the wall with its working space in the room, never over the equipment it feeds.', source: cite('NEC 2023', '110.26(A)') },
  ],
  notes: 'XD-10 Plant Room Clearances: the room is sized by the access envelope around the equipment, not by the equipment.',
};

const ROOF_PLANT: CeilingProfile = {
  id: 'roof-plant',
  label: 'Roof plant deck (Z measured UP from the roof slab)',
  appliesTo: { floorUses: ['roof'], roomTypes: ['roof', 'plant'] },
  hasCeiling: false,
  clearHeight: CLEAR_HEIGHTS['roof-plant'],
  zones: zonesOf('roof-plant'),
  bands: [
    band({
      id: 'roof-plant/plinth', purpose: 'equipment', cls: 'equipment', owner: 'shared',
      topBelowSoffit: 0, depth: 0.15, minDepth: 0.15, clearanceAbove: 0, clearanceBelow: 0,
      allows: ['plinth', 'duct', 'storm', 'dcw', 'dhw', 'gas', 'conduit'], flexibility: 2, droppable: false,
      rationale: 'Plinths and sleepers 0.15 m above the membrane: nothing — not a duct, not a pipe, not a paver — sits on the waterproofing itself.',
      source: cite('IMC 2021', '§303.3'),
    }),
    band({
      id: 'roof-plant/plant', purpose: 'service', cls: 'parallel', owner: 'mechanical',
      topBelowSoffit: 0, depth: 2.35, minDepth: 1.5, clearanceAbove: 0, clearanceBelow: 0,
      allows: ['ahu', 'fan', 'tank', 'pump', 'duct', 'duct-fitting', 'ejector'], flexibility: 3, droppable: false,
      rationale: 'The plant envelope, 1.00 m aisles between rows and 2.00 m back from a parapet below 1.10 m; a 2.00 m walkway headroom is kept as a zone.',
      source: `${cite('OSHA 1910', '1910.28(b)(13)')}; ${cite('EN 13374:2013', 'Class A')}`,
    }),
    band({
      id: 'roof-plant/clear', purpose: 'clear', cls: 'clear', owner: 'none',
      topBelowSoffit: 0, depth: 0, minDepth: 0, clearanceAbove: 0, clearanceBelow: 0,
      allows: [], flexibility: 1, droppable: false,
      rationale: 'Above the plant envelope: the screen zone and the sky. Plant taller than the envelope is a planning matter, not a coordination one.',
      source: cite('default', '(plant screen)'),
    }),
  ],
  laneSetId: null,
  elsewhere: [
    { kind: 'light', home: 'exterior', why: 'On the plant screen or a pole, not on the membrane.', source: cite('NEC 2023', '410.10') },
  ],
  notes: 'The only profile measured upward; PV rows live in the roof PV zone, plant in the plant zone.',
};

const BASEMENT_SERVICE: CeilingProfile = {
  id: 'basement-service',
  label: 'Basement service level',
  appliesTo: { floorUses: ['basement'], roomTypes: ['basement', 'storage', 'trash', 'bike-store'] },
  hasCeiling: false,
  clearHeight: CLEAR_HEIGHTS['basement-service'],
  zones: zonesOf('basement-service'),
  bands: [
    band({
      id: 'basement-service/structure', purpose: 'structure', cls: 'structure', owner: 'structure',
      topBelowSoffit: 0, depth: 0, minDepth: 0, clearanceAbove: 0, clearanceBelow: 0,
      allows: ['slab', 'beam', 'column', 'drop-panel'], flexibility: 1, droppable: false, depthFromPresize: 'beamDAbove',
      rationale: 'Sized by span; exposed.',
      source: cite('presize', '(STR-09)'),
    }),
    band({
      id: 'basement-service/sprinkler', purpose: 'sprinkler', cls: 'parallel', owner: 'plumbing',
      topBelowSoffit: 0.025, depth: 0.1, minDepth: 0.08, clearanceAbove: 0.025, clearanceBelow: 0.025,
      allows: ['sprinkler-main', 'sprinkler-branch', 'sprinkler-head'], flexibility: 1, droppable: false,
      rationale: 'Tight to the soffit, above everything else: a basement has no ceiling to hide the main in, and the deflector distance is measured to the soffit it protects.',
      source: cite('NFPA 13 2022', '§8.6.4.1.1.1'),
    }),
    band({
      id: 'basement-service/exhaust', purpose: 'exhaust', cls: 'parallel', owner: 'mechanical',
      topBelowSoffit: 0, depth: 0.4, minDepth: 0.3, clearanceAbove: 0.05, clearanceBelow: 0.05,
      allows: ['duct', 'duct-fitting', 'fan'], flexibility: 3, droppable: false,
      rationale: 'Extract and make-up air for a level with no openable facade.',
      source: cite('IMC 2021', '§403'),
    }),
    band({
      id: 'basement-service/lighting', purpose: 'lighting', cls: 'parallel', owner: 'electrical',
      topBelowSoffit: 0, depth: 0.12, minDepth: 0.1, clearanceAbove: 0.05, clearanceBelow: 0.05,
      allows: ['light', 'sensor', 'conduit', 'tray-power'], flexibility: 5, droppable: false,
      rationale: 'Surface luminaires and containment on the soffit.',
      source: cite('IECC 2021', 'Table C405.3.2(2)'),
    }),
    band({
      id: 'basement-service/drain', purpose: 'gravity-drain', cls: 'crossing', owner: 'plumbing',
      topBelowSoffit: 0, depth: 0.15, minDepth: 0.12, clearanceAbove: 0.05, clearanceBelow: 0,
      allows: ['trench-drain', 'storm', 'waste'], flexibility: 1, droppable: false,
      rationale: 'FLOOR-anchored collector to the low point; every invert here is referenced to the invert model, and a level whose invert falls below the sewer is a pumped level.',
      source: cite('IPC 2021', '§1101.2'),
    }),
    band({
      id: 'basement-service/sump', purpose: 'equipment', cls: 'equipment', owner: 'plumbing',
      topBelowSoffit: 0, depth: 0.15, minDepth: 0.15, clearanceAbove: 0, clearanceBelow: 0,
      allows: ['sump', 'ejector', 'pump', 'plinth', 'tank'], flexibility: 4, droppable: false,
      rationale: 'FLOOR-anchored: the sump pit cover and the duplex ejector plinth at the low point — the bottom of the gravity horizon.',
      source: `${cite('IPC 2021', '§712.1')}; ${cite('IPC 2021', '§712.4.2')}`,
    }),
    band({
      id: 'basement-service/clear', purpose: 'clear', cls: 'clear', owner: 'none',
      topBelowSoffit: 0, depth: 0, minDepth: 0, clearanceAbove: 0, clearanceBelow: 0,
      allows: [], flexibility: 1, droppable: false,
      rationale: 'Occupied and access envelope.',
      source: cite('IBC 2021', '§1208.2'),
    }),
  ],
  laneSetId: 'parking',
  elsewhere: [
    { kind: 'switchgear', home: 'plinth', why: 'Never below the gravity horizon if it can be avoided; if it must be, its dedicated space is a keep-out and the sump alarm protects it.', source: cite('NEC 2023', '110.26(E)') },
  ],
  notes: 'As the car park, plus the sump band: this is where XD-11 Gravity First is decided.',
};

export const PROFILE_DEFS: readonly CeilingProfile[] = [
  RESI_UNIT, RESI_CORRIDOR, LOBBY, AMENITY, PARKING, RETAIL_SHELL, MEP_ROOM, ROOF_PLANT, BASEMENT_SERVICE,
];

// ---------------------------------------------------------------------------------------------------------------
// Use → profile resolution
// ---------------------------------------------------------------------------------------------------------------

const ROOM_TYPE_PROFILE: Readonly<Partial<Record<RoomType, ProfileId>>> = {
  'corridor': 'resi-corridor', 'lift-lobby': 'resi-corridor', 'stair': 'resi-corridor', 'elevator': 'resi-corridor',
  'lobby': 'lobby', 'mail': 'lobby', 'bike-store': 'lobby',
  'amenity': 'amenity', 'gym': 'amenity', 'lounge': 'amenity', 'shared-kitchen': 'amenity', 'shared-living': 'amenity',
  'dining-hall': 'amenity', 'flex': 'amenity',
  'parking': 'parking', 'garage': 'parking',
  'retail': 'retail-shell',
  'mech-room': 'mep-room', 'elec-room': 'mep-room', 'water-room': 'mep-room', 'plant': 'mep-room', 'utility': 'mep-room',
  'roof': 'roof-plant',
  'basement': 'basement-service', 'storage': 'basement-service', 'trash': 'basement-service',
};

const FLOOR_USE_PROFILE: Readonly<Record<FloorUse | 'site' | 'foundation' | 'roof', ProfileId>> = {
  'residential': 'resi-unit',
  'lobby-residential': 'lobby',
  'retail': 'retail-shell',
  'parking': 'parking',
  'amenity': 'amenity',
  'mechanical': 'mep-room',
  'roof': 'roof-plant',
  'basement': 'basement-service',
  'site': 'parking',
  'foundation': 'basement-service',
};

export function profileIdFor(use: FloorUse | 'site' | 'foundation' | 'roof', roomType?: RoomType): ProfileId {
  if (roomType) {
    const byRoom = ROOM_TYPE_PROFILE[roomType];
    if (byRoom) return byRoom;
    // A dwelling room on a residential floor, or any unlisted room, follows its floor.
  }
  return FLOOR_USE_PROFILE[use];
}

// ---------------------------------------------------------------------------------------------------------------
// The profile book — the profiles after rule overrides
// ---------------------------------------------------------------------------------------------------------------

/** Rule id for a band's depth parameters: 'XD-06.band.resi-corridor.service' with params depth / minDepth. */
export function bandRuleId(profileId: ProfileId, purpose: BandPurpose): string {
  return `XD-06.band.${profileId}.${purpose}`;
}
/** Rule id for a profile's clear height: 'XD-06.clearHeight.resi-corridor' with params min / target. */
export function clearHeightRuleId(profileId: ProfileId): string {
  return `XD-06.clearHeight.${profileId}`;
}

export function createProfileBook(rules: RuleSet): ProfileBook {
  const resolved = new Map<ProfileId, CeilingProfile>();
  for (const def of PROFILE_DEFS) {
    const chId = clearHeightRuleId(def.id);
    const bands = def.bands.map(b => {
      const rid = bandRuleId(def.id, b.purpose);
      const depth = rules.num(`${rid}.depth`, b.depth);
      const minDepth = Math.min(rules.num(`${rid}.minDepth`, b.minDepth), depth);
      return { ...b, depth, minDepth };
    });
    resolved.set(def.id, {
      ...def,
      clearHeight: {
        min: rules.num(`${chId}.min`, def.clearHeight.min),
        target: Math.max(rules.num(`${chId}.target`, def.clearHeight.target), rules.num(`${chId}.min`, def.clearHeight.min)),
        source: def.clearHeight.source,
      },
      bands,
    });
  }
  const all = PROFILE_DEFS.map(d => resolved.get(d.id) as CeilingProfile);
  return {
    profile(id: ProfileId): CeilingProfile {
      const p = resolved.get(id);
      if (!p) throw new Error(`Unknown ceiling profile: ${id}`);
      return p;
    },
    resolve(use: FloorUse | 'site' | 'foundation' | 'roof', roomType?: RoomType): ProfileId {
      return profileIdFor(use, roomType);
    },
    all(): readonly CeilingProfile[] {
      return all;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// stackProfile — resolve a profile against a concrete storey
// ---------------------------------------------------------------------------------------------------------------

function isFloorAnchored(b: Band): boolean {
  return b.cls === 'equipment' || (b.cls === 'crossing' && b.purpose === 'gravity-drain');
}
function isClear(b: Band): boolean {
  return b.cls === 'clear';
}
function isStructure(b: Band): boolean {
  return b.cls === 'structure';
}

function presizeDepth(b: Band, i: StackProfileInput): number {
  if (!b.depthFromPresize) return b.depth;
  if (b.depthFromPresize === 'beamDAbove') return i.beamDAbove;
  if (b.depthFromPresize === 'beamDAboveUnit') return i.beamDAboveUnit;
  return i.transferZoneDepth;
}

function roundUpTo(v: number, step: number): number {
  return Math.ceil(v / step - 1e-9) * step;
}

/** Deterministic compression / drop order: most flexible first, then by id. */
function byFlexibilityThenId(a: ResolvedBand, b: ResolvedBand): number {
  if (a.flexibility !== b.flexibility) return b.flexibility - a.flexibility;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function stackProfile(i: StackProfileInput): StackProfileResult {
  const { profile, storey, floorToFloor, slabTAbove } = i;
  const issues: Issue[] = [];
  let issueN = 0;
  const issue = (o: Omit<Issue, 'id'>): void => {
    issueN += 1;
    issues.push({ ...o, id: `${storey}/${profile.id}#${issueN}` });
  };

  const upward = UPWARD.includes(profile.id);
  const soffitZ = Math.max(0, floorToFloor - slabTAbove);
  const minClear = Math.max(0, Math.min(profile.clearHeight.min, soffitZ));
  /**
   * SITE, FND and a roof parapet come through with a floor-to-floor of 0 or a fraction of a metre. They are not
   * habitable storeys, so compressing, dropping and raising are all meaningless there: resolve the bands and stay
   * silent rather than asking the pre-sizing to make the site datum taller.
   */
  const habitable = floorToFloor >= i.rules.num('XD-06.habitableFloorToFloor', 2.0);

  const work: ResolvedBand[] = profile.bands.map(b => ({
    ...b,
    depth: presizeDepth(b, i),
    z0: 0, z1: 0, compressedBy: 0,
    // A transfer band is ABSENT on every storey but the one under the transfer slab, so a zero depth there means
    // "no such band". A structure band with zero depth is a flat slab: the band exists, it simply has no beams.
    dropped: b.depthFromPresize === 'transferZoneDepth' && presizeDepth(b, i) <= TOL,
  }));

  let raiseFloorToFloorTo: number | null = null;

  if (upward) {
    // Roof plant: stack up from the membrane, no structure above.
    let cursor = 0;
    for (const b of work) {
      if (isClear(b)) {
        b.z0 = cursor;
        b.z1 = Math.max(cursor, floorToFloor);
        cursor = b.z1;
        continue;
      }
      b.z0 = cursor + b.clearanceBelow;
      b.z1 = b.z0 + b.depth;
      b.topBelowSoffit = Math.max(0, soffitZ - b.z1);
      cursor = b.z1 + b.clearanceAbove;
    }
    return { resolved: makeStoreyProfile(profile, storey, i, soffitZ, soffitZ, cursor, minClear, work, issues), raiseFloorToFloorTo: null };
  }

  /**
   * The structural depth below the soffit is the ORDINARY depth (the beams that run everywhere), not the transfer
   * zone. A transfer beam is a LOCAL obstruction on a few column lines, and local geometry is the keep-out's job,
   * not the band's: structure detailing registers the transfer beams as keep-outs and MEP routes between them,
   * while the ceiling steps down under them in a bulkhead. Bands are per-storey, so pulling the whole storey's
   * plenum down by 0.90 m would make every podium ask for a taller floor-to-floor when only the strip under the
   * beam is affected. The transfer slab is already out of `soffitZ`.
   */
  const structureBands = work.filter(isStructure);
  const transferBand = structureBands.find(b => b.purpose === 'transfer' && !b.dropped && b.depth > TOL) ?? null;
  if (transferBand) {
    // The transfer beam replaces the ordinary beam on this storey rather than adding to it.
    for (const b of structureBands) if (b !== transferBand) b.depth = 0;
  }
  const structureDepth = structureBands.reduce((s, b) => s + b.depth, 0);
  const structureBottomZ = soffitZ - structureDepth;
  if (!transferBand && i.transferZoneDepth > structureDepth + TOL && habitable) {
    const localClear = Math.max(0, soffitZ - i.transferZoneDepth);
    issue({
      severity: localClear >= minClear - TOL ? 'info' : 'deviation',
      ruleId: 'XD-02.transferZone', discipline: 'structure', storey,
      message: `the transfer zone leaves ${localClear.toFixed(2)} m under the transfer beams on ${storey}; the ceiling steps down in a bulkhead there and services route between them`,
      observed: Number(localClear.toFixed(3)), limit: Number(minClear.toFixed(3)),
      source: cite('presize', '(STR-04 transfer zone)'),
      resolution: { id: 'lower-ceiling', from: Number(structureBottomZ.toFixed(3)), to: Number(localClear.toFixed(3)) },
    });
  }

  const floorBands = work.filter(b => isFloorAnchored(b) && !b.dropped);
  let floorTop = 0;
  for (const b of floorBands) {
    b.z0 = floorTop;
    b.z1 = floorTop + b.depth;
    floorTop = b.z1 + b.clearanceAbove;
  }

  const hanging = work.filter(b => !isStructure(b) && !isFloorAnchored(b) && !isClear(b) && !b.dropped);
  const floorNeed = Math.max(minClear, floorTop);
  const available = Math.max(0, structureBottomZ - floorNeed);
  /**
   * The installation gap BETWEEN two bands is one gap, not two: `clearanceBelow` of the upper band and
   * `clearanceAbove` of the lower one describe the same space, so they merge (max), and only the top of the stack
   * and the bottom of the stack add a gap of their own.
   */
  const stackNeed = (bands: readonly ResolvedBand[]): number => {
    let sum = 0;
    for (let n = 0; n < bands.length; n++) {
      sum += bands[n].depth;
      sum += n === 0 ? bands[n].clearanceAbove : Math.max(bands[n - 1].clearanceBelow, bands[n].clearanceAbove);
    }
    if (bands.length > 0) sum += bands[bands.length - 1].clearanceBelow;
    return sum;
  };
  const liveOf = (): ResolvedBand[] => hanging.filter(b => !b.dropped);
  let need = stackNeed(liveOf());

  // 1. compress the most flexible bands to their minimum
  let short = need - available;
  if (short > TOL) {
    for (const b of [...hanging].sort(byFlexibilityThenId)) {
      if (short <= TOL) break;
      const give = Math.min(short, Math.max(0, b.depth - b.minDepth));
      if (give <= TOL) continue;
      b.depth -= give;
      b.compressedBy = give;
      need = stackNeed(liveOf());
      short = need - available;
      if (!habitable) continue;
      issue({
        severity: 'info', ruleId: 'XD-02.bandDepth', discipline: 'xd', storey,
        message: `${b.id} compressed ${(b.compressedBy * 1000).toFixed(0)} mm to fit the ${profile.clearHeight.min.toFixed(2)} m clear height`,
        observed: Number(b.depth.toFixed(4)), limit: Number(b.minDepth.toFixed(4)), source: b.source,
        resolution: { id: 'compress-band', from: Number((b.depth + b.compressedBy).toFixed(4)), to: Number(b.depth.toFixed(4)) },
      });
    }
  }

  // 2. drop droppable bands, most flexible first
  if (short > TOL) {
    for (const b of [...hanging].sort(byFlexibilityThenId)) {
      if (short <= TOL) break;
      if (!b.droppable || b.dropped) continue;
      b.dropped = true;
      const before = need;
      need = stackNeed(liveOf());
      const freed = before - need;
      short = need - available;
      if (!habitable) continue;
      issue({
        severity: 'info', ruleId: 'XD-02.bandDropped', discipline: 'xd', storey,
        message: `${b.id} dropped: ${(freed * 1000).toFixed(0)} mm was needed for the ${profile.clearHeight.min.toFixed(2)} m clear height`,
        source: b.source,
        resolution: { id: 'drop-band', from: Number(freed.toFixed(4)), to: 0, note: b.rationale },
      });
    }
  }

  // 3. ask the pre-sizing for a taller storey
  if (short > TOL && habitable) {
    raiseFloorToFloorTo = roundUpTo(floorToFloor + short, 0.05);
    issue({
      severity: 'deviation', ruleId: 'XD-02.plenumDepth', discipline: 'xd', storey,
      message: `${profile.id} needs ${(short * 1000).toFixed(0)} mm more plenum than a ${floorToFloor.toFixed(2)} m floor-to-floor gives`,
      observed: Number(floorToFloor.toFixed(3)), limit: Number(raiseFloorToFloorTo.toFixed(3)), source: profile.clearHeight.source,
      resolution: { id: 'raise-floor-to-floor', from: Number(floorToFloor.toFixed(3)), to: Number(raiseFloorToFloorTo.toFixed(3)) },
    });
  }

  // 4. place the hanging bands top → down, then decide the ceiling
  const live = liveOf();
  const naturalCeilingZ = structureBottomZ - need;
  const voidBand = live.find(b => b.cls === 'void') ?? null;
  let ceilingZ = naturalCeilingZ;
  if (i.ceilingWanted !== undefined) {
    const wanted = Math.min(Math.max(i.ceilingWanted, floorNeed), naturalCeilingZ);
    ceilingZ = wanted;
  } else {
    const target = Math.max(profile.clearHeight.target, floorNeed);
    if (naturalCeilingZ > target) ceilingZ = target;
  }
  if (voidBand) voidBand.depth += Math.max(0, naturalCeilingZ - ceilingZ);
  else ceilingZ = naturalCeilingZ;

  let cursor = structureBottomZ;
  let prevBelow = 0;
  let placed = 0;
  for (const b of work) {
    if (isStructure(b)) {
      b.z1 = cursor + b.depth;
      b.z0 = cursor;
      b.topBelowSoffit = soffitZ - b.z1;
      continue;
    }
    if (isFloorAnchored(b) || isClear(b)) continue;
    if (b.dropped) {
      b.z1 = cursor;
      b.z0 = cursor;
      b.topBelowSoffit = soffitZ - cursor;
      continue;
    }
    const gap = placed === 0 ? b.clearanceAbove : Math.max(prevBelow, b.clearanceAbove);
    b.z1 = cursor - gap;
    b.z0 = b.z1 - b.depth;
    b.topBelowSoffit = soffitZ - b.z1;
    cursor = b.z0;
    prevBelow = b.clearanceBelow;
    placed += 1;
  }
  // Structure bands sit between structureBottomZ and the soffit, in order.
  let sCursor = soffitZ;
  for (const b of work) {
    if (!isStructure(b)) continue;
    b.z1 = sCursor;
    b.z0 = sCursor - b.depth;
    b.topBelowSoffit = soffitZ - b.z1;
    sCursor = b.z0;
  }

  const bottomOfHanging = live.length > 0 ? Math.min(...live.map(b => b.z0)) : structureBottomZ;
  const clearZ = profile.hasCeiling ? Math.min(ceilingZ, bottomOfHanging) : bottomOfHanging;

  for (const b of work) {
    if (!isClear(b)) continue;
    b.z0 = floorTop;
    b.z1 = Math.max(floorTop, clearZ);
    b.depth = b.z1 - b.z0;
    b.topBelowSoffit = soffitZ - b.z1;
  }

  return { resolved: makeStoreyProfile(profile, storey, i, soffitZ, structureBottomZ, clearZ, clearZ, work, issues), raiseFloorToFloorTo };
}

function makeStoreyProfile(
  profile: CeilingProfile, storey: string, i: StackProfileInput,
  soffitZ: number, structureBottomZ: number, ceilingZ: number, clearZ: number,
  bands: ResolvedBand[], issues: Issue[],
): StoreyProfile {
  const byPurpose = new Map<BandPurpose, ResolvedBand>();
  const byId = new Map<string, ResolvedBand>();
  for (const b of bands) {
    if (!byPurpose.has(b.purpose)) byPurpose.set(b.purpose, b);
    byId.set(b.id, b);
  }
  const zones = new Map<string, number>();
  for (const z of profile.zones) zones.set(z.id, z.minClear);
  return {
    storey,
    profileId: profile.id,
    floorToFloor: i.floorToFloor,
    slabTAbove: i.slabTAbove,
    soffitZ,
    structureBottomZ,
    ceilingZ,
    clearZ,
    bands,
    band(purpose: BandPurpose): ResolvedBand | null {
      return byPurpose.get(purpose) ?? null;
    },
    bandById(id: string): ResolvedBand | null {
      return byId.get(id) ?? null;
    },
    zoneClear(zoneId: string): number {
      return zones.get(zoneId) ?? profile.clearHeight.min;
    },
    issues,
  };
}
