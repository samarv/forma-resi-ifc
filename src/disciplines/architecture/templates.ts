/**
 * Floor-plan template catalogue: the 20 dwelling types the generator can lay out.
 *
 * Areas are NET INTERNAL AREA (NIA / "net floor area"), measured to the inside face of the
 * enclosing walls and to the centreline of internal partitions, excluding balconies.
 *
 * Minimum areas and widths come from the published minima of the English-speaking world:
 *  - London Plan 2021 Policy D6 / Housing Design Standards LPG Table 3.1 (GIA per dwelling by
 *    bedspaces, 2-person bedroom ≥ 11.5 m², 1-person ≥ 7.5 m², bedroom min width 2.15 m for a
 *    single and 2.75 m for a double, 2.5 m² built-in storage for 1–2 person homes + 0.5 m²/person).
 *  - Technical Housing Standards (Nationally Described Space Standard, 2015) Table 1.
 *  - IRC 2021 R304 (habitable rooms ≥ 70 sq ft ≈ 6.5 m², one room ≥ 120 sq ft ≈ 11.1 m²),
 *    R305 (ceiling height 7 ft / 2.13 m), R307 (fixture clearances).
 *  - NCC 2022 Volume Two + AS 1428.1 (AU), NZS 3604 / Auckland Unitary Plan (NZ).
 *  - ADA 2010 §603–§608 and Approved Document M4(2) for the accessible template.
 *
 * Frontage / depth ranges are what a double-loaded corridor (unit depth 9–11 m) or a terrace
 * (frontage 5.5–7.5 m) actually produces; the floor organizer must hand `layoutUnit` a NET rect
 * inside these ranges. `frontage` is measured along the access side, `depth` perpendicular to it.
 */
import type { RoomProgram, RoomType, UnitTemplateDef, UnitTemplateId, Zone } from '../../core/types.ts';
import { UNIT_TEMPLATE_IDS } from '../../core/spec.ts';

// ----------------------------------------------------------------------------
// Room program helper
// ----------------------------------------------------------------------------

interface RoomDefaults {
  needsExterior: boolean;
  wet: boolean;
  zone: Zone;
  prefer: 'front' | 'back' | 'either';
}

const ROOM_DEFAULTS: Partial<Record<RoomType, RoomDefaults>> = {
  living: { needsExterior: true, wet: false, zone: 'public', prefer: 'back' },
  dining: { needsExterior: true, wet: false, zone: 'public', prefer: 'back' },
  'living-kitchen': { needsExterior: true, wet: true, zone: 'public', prefer: 'back' },
  kitchen: { needsExterior: false, wet: true, zone: 'service', prefer: 'front' },
  bedroom: { needsExterior: true, wet: false, zone: 'private', prefer: 'back' },
  'master-bedroom': { needsExterior: true, wet: false, zone: 'private', prefer: 'back' },
  study: { needsExterior: true, wet: false, zone: 'private', prefer: 'back' },
  den: { needsExterior: false, wet: false, zone: 'private', prefer: 'either' },
  flex: { needsExterior: true, wet: false, zone: 'public', prefer: 'back' },
  bathroom: { needsExterior: false, wet: true, zone: 'service', prefer: 'front' },
  ensuite: { needsExterior: false, wet: true, zone: 'service', prefer: 'front' },
  powder: { needsExterior: false, wet: true, zone: 'service', prefer: 'front' },
  wc: { needsExterior: false, wet: true, zone: 'service', prefer: 'front' },
  entry: { needsExterior: false, wet: false, zone: 'circulation', prefer: 'front' },
  hall: { needsExterior: false, wet: false, zone: 'circulation', prefer: 'either' },
  corridor: { needsExterior: false, wet: false, zone: 'circulation', prefer: 'either' },
  stair: { needsExterior: false, wet: false, zone: 'circulation', prefer: 'front' },
  closet: { needsExterior: false, wet: false, zone: 'service', prefer: 'front' },
  'walk-in-closet': { needsExterior: false, wet: false, zone: 'service', prefer: 'front' },
  laundry: { needsExterior: false, wet: true, zone: 'service', prefer: 'front' },
  utility: { needsExterior: false, wet: true, zone: 'service', prefer: 'front' },
  storage: { needsExterior: false, wet: false, zone: 'service', prefer: 'front' },
  garage: { needsExterior: false, wet: false, zone: 'service', prefer: 'front' },
  'shared-kitchen': { needsExterior: false, wet: true, zone: 'public', prefer: 'back' },
  'shared-living': { needsExterior: true, wet: false, zone: 'public', prefer: 'back' },
  balcony: { needsExterior: true, wet: false, zone: 'outdoor', prefer: 'back' },
  terrace: { needsExterior: true, wet: false, zone: 'outdoor', prefer: 'back' },
  porch: { needsExterior: true, wet: false, zone: 'outdoor', prefer: 'front' },
};

/** Room program entry: `rp(type, count, target m², min m², min clear width m, overrides)` */
function rp(
  type: RoomType,
  count: number,
  targetArea: number,
  minArea: number,
  minWidth: number,
  o: Partial<RoomProgram> = {},
): RoomProgram {
  const d = ROOM_DEFAULTS[type] ?? { needsExterior: false, wet: false, zone: 'service' as Zone, prefer: 'either' as const };
  return {
    type,
    count,
    targetArea,
    minArea,
    minWidth,
    needsExterior: o.needsExterior ?? d.needsExterior,
    wet: o.wet ?? d.wet,
    zone: o.zone ?? d.zone,
    prefer: o.prefer ?? d.prefer,
  };
}

// Frequently reused programs -------------------------------------------------
/** London Plan: 2-person (double) bedroom ≥ 11.5 m², min width 2.75 m */
const bedDouble = (target: number, count = 1): RoomProgram => rp('bedroom', count, target, 11.5, 2.75);
/** London Plan: 1-person (single) bedroom ≥ 7.5 m², min width 2.15 m */
const bedSingle = (target: number, count = 1): RoomProgram => rp('bedroom', count, target, 7.5, 2.15);
const master = (target: number): RoomProgram => rp('master-bedroom', 1, target, 12.5, 2.9);
/** 3-piece bathroom: WC + basin + shower or bath. 3.7 m² is the practical minimum (1.7 × 2.2). */
const bath = (target = 4.6, count = 1): RoomProgram => rp('bathroom', count, target, 3.7, 1.7);
const ensuite = (target = 4.4): RoomProgram => rp('ensuite', 1, target, 3.4, 1.6);
const powder = (target = 2.4): RoomProgram => rp('powder', 1, target, 1.8, 1.1);
const entryHall = (target = 3.6): RoomProgram => rp('entry', 1, target, 2.0, 1.2);
const hall = (target: number): RoomProgram => rp('hall', 1, target, 2.0, 1.1);
const laundryClo = (target = 1.8): RoomProgram => rp('laundry', 1, target, 1.2, 0.8);
/** London Plan storage: 2.5 m² for 1–2 person homes, +0.5 m² per extra person */
const closets = (count: number, target = 1.4): RoomProgram => rp('closet', count, target, 0.8, 0.6);
const stairRoom = (target = 4.4): RoomProgram => rp('stair', 1, target, 3.2, 1.0);

// ----------------------------------------------------------------------------
// The catalogue
// ----------------------------------------------------------------------------

const APARTMENT_TYPOLOGIES = [
  'garden-walkup', 'mansion-block', 'corridor-midrise', 'deck-access', 'courtyard-block',
  'point-tower', 'slab-tower', 'podium-tower', 'mixed-use-midrise',
] as const;

export const UNIT_TEMPLATES: Record<UnitTemplateId, UnitTemplateDef> = {
  // --- studios ------------------------------------------------------------
  studio: {
    id: 'studio',
    name: 'Studio',
    regionalNames: { US: 'Studio apartment', UK: 'Studio flat', CA: 'Bachelor apartment', AU: 'Studio apartment', NZ: 'Studio apartment', IE: 'Studio apartment' },
    description: 'One combined living/sleeping/kitchen room with a separate bathroom and an entry with storage. Wet core backs the corridor.',
    bedrooms: 0,
    bathrooms: 1,
    occupants: 2,
    area: { min: 35, target: 40, max: 45 },
    frontage: { min: 4.2, max: 5.8 },
    depth: { min: 7.5, max: 9.5 },
    storeysInUnit: 1,
    aspect: 'single',
    rooms: [
      rp('living-kitchen', 1, 25, 21, 3.6),
      bath(4.2),
      entryHall(3.0),
      closets(1, 1.6),
      laundryClo(1.4),
    ],
    suitableTypologies: [...APARTMENT_TYPOLOGIES, 'coliving-cluster', 'senior-living'],
    patterns: ['ARC-14', 'ARC-15', 'ARC-16', 'ARC-18', 'ARC-20', 'ARC-28', 'ARC-30', 'XD-01'],
  },

  'micro-studio': {
    id: 'micro-studio',
    name: 'Micro studio',
    regionalNames: { US: 'Micro unit', UK: 'Micro flat', CA: 'Micro suite', AU: 'Micro apartment', NZ: 'Micro apartment', IE: 'Micro apartment' },
    description: 'Minimum-size self-contained dwelling for one person: living/sleeping/kitchen in one room, 3-piece shower room, built-in storage.',
    bedrooms: 0,
    bathrooms: 1,
    occupants: 1,
    area: { min: 22, target: 26, max: 30 },
    frontage: { min: 3.4, max: 4.6 },
    depth: { min: 6.0, max: 8.0 },
    storeysInUnit: 1,
    aspect: 'single',
    rooms: [
      rp('living-kitchen', 1, 17, 14, 3.0),
      bath(3.7),
      entryHall(2.2),
      closets(1, 1.2),
    ],
    suitableTypologies: ['corridor-midrise', 'mixed-use-midrise', 'coliving-cluster', 'point-tower', 'slab-tower'],
    patterns: ['ARC-14', 'ARC-15', 'ARC-16', 'ARC-20', 'ARC-28', 'ARC-30', 'XD-01'],
  },

  'junior-1b': {
    id: 'junior-1b',
    name: 'Junior one-bedroom',
    regionalNames: { US: 'Junior 1 bedroom / alcove studio', UK: 'Small 1-bed flat', CA: 'Junior one-bedroom', AU: '1-bedroom apartment (compact)', NZ: '1-bedroom apartment (compact)', IE: '1-bed apartment (compact)' },
    description: 'Compact one-bedroom: a small enclosed bedroom off the entry hall with a combined living/kitchen at the window wall.',
    bedrooms: 1,
    bathrooms: 1,
    occupants: 2,
    area: { min: 45, target: 47, max: 50 },
    frontage: { min: 5.4, max: 6.8 },
    depth: { min: 7.5, max: 8.5 },
    storeysInUnit: 1,
    aspect: 'single',
    rooms: [
      rp('living-kitchen', 1, 22, 18, 3.0),
      bedDouble(11.8),
      bath(4.2),
      entryHall(3.2),
      hall(2.4),
      closets(2, 1.3),
      laundryClo(1.4),
    ],
    suitableTypologies: [...APARTMENT_TYPOLOGIES, 'stacked-townhouse'],
    patterns: ['ARC-14', 'ARC-15', 'ARC-16', 'ARC-18', 'ARC-19', 'ARC-20', 'ARC-28', 'ARC-30', 'XD-01', 'XD-05'],
  },

  // --- one bedroom --------------------------------------------------------
  '1b1b': {
    id: '1b1b',
    name: 'One bedroom, one bathroom',
    regionalNames: { US: '1 bed / 1 bath', UK: '1-bed flat', CA: '1 bedroom', AU: '1-bedroom apartment', NZ: '1-bedroom apartment', IE: '1-bed apartment' },
    description: 'The market-standard one-bedroom: living/dining at the façade, galley kitchen on the wet wall, bedroom with a wardrobe wall, 3-piece bathroom off the hall.',
    bedrooms: 1,
    bathrooms: 1,
    occupants: 2,
    area: { min: 55, target: 58, max: 65 },
    frontage: { min: 6.0, max: 7.8 },
    depth: { min: 8.5, max: 9.5 },
    storeysInUnit: 1,
    aspect: 'single',
    rooms: [
      rp('living', 1, 20, 16, 3.4),
      rp('kitchen', 1, 8.5, 6.5, 2.2),
      bedDouble(13.0),
      bath(4.6),
      entryHall(3.6),
      hall(2.8),
      closets(2, 1.4),
      laundryClo(1.6),
    ],
    suitableTypologies: [...APARTMENT_TYPOLOGIES, 'stacked-townhouse', 'senior-living', 'adu-laneway'],
    patterns: ['ARC-14', 'ARC-15', 'ARC-16', 'ARC-17', 'ARC-18', 'ARC-19', 'ARC-20', 'ARC-28', 'ARC-30', 'XD-01', 'XD-05'],
  },

  '1b-den': {
    id: '1b-den',
    name: 'One bedroom and den',
    regionalNames: { US: '1 bed + den', UK: '1-bed flat with study', CA: '1+den', AU: '1-bedroom + study', NZ: '1-bedroom + study', IE: '1-bed apartment with study' },
    description: 'One-bedroom with an internal den/home-office off the hall — the Canadian "1+den". Den has no window and is not counted as a bedroom.',
    bedrooms: 1,
    bathrooms: 1,
    occupants: 2,
    area: { min: 65, target: 70, max: 75 },
    frontage: { min: 7.0, max: 8.8 },
    depth: { min: 8.5, max: 10.5 },
    storeysInUnit: 1,
    aspect: 'single',
    rooms: [
      rp('living', 1, 21, 17, 3.6),
      rp('kitchen', 1, 9.5, 7.0, 2.4),
      bedDouble(13.5),
      rp('den', 1, 7.5, 5.5, 2.1),
      bath(4.6),
      entryHall(4.0),
      hall(3.2),
      closets(2, 1.5),
      laundryClo(1.8),
    ],
    suitableTypologies: [...APARTMENT_TYPOLOGIES],
    patterns: ['ARC-14', 'ARC-15', 'ARC-16', 'ARC-17', 'ARC-18', 'ARC-19', 'ARC-20', 'ARC-28', 'ARC-30', 'XD-01', 'XD-05'],
  },

  // --- two bedroom --------------------------------------------------------
  '2b1b': {
    id: '2b1b',
    name: 'Two bedroom, one bathroom',
    regionalNames: { US: '2 bed / 1 bath', UK: '2-bed flat (4 person)', CA: '2 bedroom', AU: '2-bedroom apartment', NZ: '2-bedroom apartment', IE: '2-bed apartment' },
    description: 'Two bedrooms sharing one bathroom off a short hall; living/dining at the façade with the kitchen behind it on the wet wall.',
    bedrooms: 2,
    bathrooms: 1,
    occupants: 4,
    area: { min: 70, target: 75, max: 80 },
    frontage: { min: 7.5, max: 9.8 },
    depth: { min: 8.0, max: 8.4 },
    storeysInUnit: 1,
    aspect: 'single',
    rooms: [
      rp('living', 1, 21, 17, 3.4),
      rp('kitchen', 1, 9.0, 7.0, 2.3),
      master(13.0),
      bedDouble(11.8),
      bath(4.6),
      entryHall(3.6),
      hall(4.0),
      closets(3, 1.4),
      laundryClo(1.6),
    ],
    suitableTypologies: [...APARTMENT_TYPOLOGIES, 'stacked-townhouse', 'semi-detached'],
    patterns: ['ARC-14', 'ARC-15', 'ARC-16', 'ARC-17', 'ARC-18', 'ARC-19', 'ARC-20', 'ARC-27', 'ARC-28', 'ARC-29', 'ARC-30', 'XD-01', 'XD-05'],
  },

  '2b2b': {
    id: '2b2b',
    name: 'Two bedroom, two bathroom',
    regionalNames: { US: '2 bed / 2 bath', UK: '2-bed flat with en-suite', CA: '2 bedroom 2 bath', AU: '2-bedroom 2-bathroom apartment', NZ: '2-bedroom 2-bathroom apartment', IE: '2-bed apartment with en-suite' },
    description: 'Master suite with en-suite and walk-in at one end, second bedroom and main bathroom off the hall, open living/dining/kitchen at the façade.',
    bedrooms: 2,
    bathrooms: 2,
    occupants: 4,
    area: { min: 85, target: 92, max: 100 },
    frontage: { min: 8.8, max: 11.5 },
    depth: { min: 8.5, max: 10.5 },
    storeysInUnit: 1,
    aspect: 'dual',
    rooms: [
      rp('living', 1, 25, 19, 3.8),
      rp('kitchen', 1, 10.5, 7.5, 2.4),
      master(14.5),
      bedDouble(12.0),
      ensuite(4.4),
      bath(4.8),
      entryHall(4.2),
      hall(4.4),
      rp('walk-in-closet', 1, 2.6, 1.5, 1.0),
      closets(2, 1.5),
      laundryClo(2.0),
    ],
    suitableTypologies: [...APARTMENT_TYPOLOGIES, 'senior-living', 'coliving-cluster'],
    patterns: ['ARC-14', 'ARC-15', 'ARC-16', 'ARC-17', 'ARC-18', 'ARC-19', 'ARC-20', 'ARC-21', 'ARC-27', 'ARC-28', 'ARC-29', 'ARC-30', 'XD-01', 'XD-05'],
  },

  'corner-2b2b': {
    id: 'corner-2b2b',
    name: 'Corner two bedroom',
    regionalNames: { US: 'Corner 2 bed / 2 bath', UK: 'Dual-aspect 2-bed flat', CA: 'Corner 2 bedroom', AU: 'Corner 2-bedroom apartment', NZ: 'Corner 2-bedroom apartment', IE: 'Dual-aspect 2-bed apartment' },
    description: 'Dual-aspect two-bedroom at a building corner: the living room takes the corner and gets light on two sides (APL #159); bedrooms share the second façade.',
    bedrooms: 2,
    bathrooms: 2,
    occupants: 4,
    area: { min: 90, target: 97, max: 105 },
    frontage: { min: 9.0, max: 12.0 },
    depth: { min: 8.5, max: 10.5 },
    storeysInUnit: 1,
    aspect: 'corner',
    rooms: [
      rp('living', 1, 27, 20, 4.0),
      rp('kitchen', 1, 11.0, 7.5, 2.4),
      master(15.0),
      bedDouble(12.5),
      ensuite(4.6),
      bath(4.8),
      entryHall(4.2),
      hall(4.6),
      rp('walk-in-closet', 1, 2.8, 1.5, 1.0),
      closets(2, 1.5),
      laundryClo(2.0),
    ],
    suitableTypologies: ['corridor-midrise', 'courtyard-block', 'point-tower', 'slab-tower', 'podium-tower', 'mixed-use-midrise', 'mansion-block', 'garden-walkup'],
    patterns: ['ARC-14', 'ARC-15', 'ARC-16', 'ARC-17', 'ARC-19', 'ARC-20', 'ARC-21', 'ARC-26', 'ARC-27', 'ARC-28', 'ARC-29', 'ARC-30', 'XD-01', 'XD-05'],
  },

  // --- three and four bedroom --------------------------------------------
  '3b2b': {
    id: '3b2b',
    name: 'Three bedroom, two bathroom',
    regionalNames: { US: '3 bed / 2 bath', UK: '3-bed flat (5 person)', CA: '3 bedroom', AU: '3-bedroom apartment', NZ: '3-bedroom apartment', IE: '3-bed apartment' },
    description: 'Family flat: two doubles and a single off a hall, master en-suite, open living/dining with a separate kitchen on the wet wall.',
    bedrooms: 3,
    bathrooms: 2,
    occupants: 5,
    area: { min: 105, target: 115, max: 125 },
    frontage: { min: 10.5, max: 13.5 },
    depth: { min: 8.5, max: 10.5 },
    storeysInUnit: 1,
    aspect: 'dual',
    rooms: [
      rp('living', 1, 26, 21, 4.0),
      rp('dining', 1, 10.0, 7.0, 2.6, { needsExterior: false, prefer: 'front' }),
      rp('kitchen', 1, 12.0, 8.0, 2.6),
      master(15.0),
      bedDouble(12.0),
      bedSingle(9.5),
      ensuite(4.6),
      bath(5.0),
      entryHall(4.6),
      hall(6.0),
      rp('walk-in-closet', 1, 3.0, 1.5, 1.0),
      closets(3, 1.5),
      laundryClo(2.4),
    ],
    suitableTypologies: ['corridor-midrise', 'courtyard-block', 'slab-tower', 'point-tower', 'podium-tower', 'mixed-use-midrise', 'deck-access', 'mansion-block', 'garden-walkup'],
    patterns: ['ARC-14', 'ARC-15', 'ARC-16', 'ARC-17', 'ARC-18', 'ARC-19', 'ARC-20', 'ARC-21', 'ARC-27', 'ARC-28', 'ARC-29', 'ARC-30', 'XD-01', 'XD-05'],
  },

  '4b2b': {
    id: '4b2b',
    name: 'Four bedroom, two bathroom',
    regionalNames: { US: '4 bed / 2 bath', UK: '4-bed flat (6 person)', CA: '4 bedroom', AU: '4-bedroom apartment', NZ: '4-bedroom apartment', IE: '4-bed apartment' },
    description: 'Large family flat, usually at a building end or corner: four bedrooms off a hall, master en-suite, separate dining.',
    bedrooms: 4,
    bathrooms: 2,
    occupants: 6,
    area: { min: 130, target: 145, max: 160 },
    frontage: { min: 13.0, max: 17.0 },
    depth: { min: 8.5, max: 9.5 },
    storeysInUnit: 1,
    aspect: 'dual',
    rooms: [
      rp('living', 1, 28, 22, 4.2),
      rp('dining', 1, 11.0, 8.0, 2.8, { needsExterior: false, prefer: 'front' }),
      rp('kitchen', 1, 13.0, 9.0, 2.8),
      master(16.0),
      bedDouble(12.5, 2),
      bedSingle(9.5),
      ensuite(5.0),
      bath(5.4),
      entryHall(5.0),
      hall(8.0),
      rp('walk-in-closet', 1, 3.2, 1.5, 1.0),
      closets(3, 1.6),
      laundryClo(3.0),
    ],
    suitableTypologies: ['corridor-midrise', 'courtyard-block', 'slab-tower', 'podium-tower', 'mansion-block', 'deck-access', 'mixed-use-midrise'],
    patterns: ['ARC-14', 'ARC-15', 'ARC-16', 'ARC-17', 'ARC-19', 'ARC-20', 'ARC-21', 'ARC-27', 'ARC-28', 'ARC-29', 'ARC-30', 'XD-01', 'XD-05'],
  },

  // --- special apartment types -------------------------------------------
  'dual-key': {
    id: 'dual-key',
    name: 'Dual-key (two bedroom plus lockable studio)',
    regionalNames: { US: 'Dual-key / lock-off suite', UK: 'Dual-key flat with annexe', CA: 'Dual-key suite', AU: 'Dual-key apartment', NZ: 'Dual-key apartment', IE: 'Dual-key apartment' },
    description: 'One front door into a shared vestibule, then two lockable dwellings: a two-bedroom flat and a self-contained studio with its own shower room and kitchenette.',
    bedrooms: 2,
    bathrooms: 2,
    occupants: 5,
    area: { min: 95, target: 108, max: 118 },
    frontage: { min: 11.5, max: 13.5 },
    depth: { min: 8.0, max: 9.5 },
    storeysInUnit: 1,
    aspect: 'single',
    rooms: [
      rp('living', 1, 22, 17, 3.4),
      rp('kitchen', 1, 9.0, 6.5, 2.2),
      master(13.0),
      bedDouble(11.8),
      bath(4.6),
      entryHall(4.4),
      hall(3.4),
      closets(2, 1.4),
      laundryClo(1.6),
      // the lock-off studio
      rp('living-kitchen', 1, 21, 17, 3.2),
      rp('ensuite', 1, 3.8, 3.2, 1.6),
    ],
    suitableTypologies: ['corridor-midrise', 'podium-tower', 'slab-tower', 'mixed-use-midrise', 'coliving-cluster'],
    patterns: ['ARC-14', 'ARC-15', 'ARC-16', 'ARC-18', 'ARC-20', 'ARC-21', 'ARC-25', 'ARC-28', 'ARC-30', 'XD-01', 'XD-05'],
  },

  'loft-live-work': {
    id: 'loft-live-work',
    name: 'Live/work loft',
    regionalNames: { US: 'Live/work loft', UK: 'Live-work unit', CA: 'Live/work loft', AU: 'SOHO apartment', NZ: 'Live-work apartment', IE: 'Live-work unit' },
    description: 'Single tall volume with a work zone at the front and an open living/kitchen at the window wall; only the bathroom and store are enclosed. Sleeping is in the open loft area.',
    bedrooms: 0,
    bathrooms: 1,
    occupants: 2,
    area: { min: 70, target: 80, max: 90 },
    frontage: { min: 6.5, max: 9.0 },
    depth: { min: 9.0, max: 11.0 },
    storeysInUnit: 1,
    aspect: 'single',
    rooms: [
      rp('living-kitchen', 1, 40, 30, 4.2),
      rp('study', 1, 14, 9, 3.0),
      bath(4.8),
      entryHall(3.4),
      rp('storage', 1, 3.2, 1.8, 1.0),
      closets(1, 1.6),
      laundryClo(1.8),
    ],
    suitableTypologies: ['mixed-use-midrise', 'corridor-midrise', 'courtyard-block', 'deck-access', 'stacked-townhouse'],
    patterns: ['ARC-14', 'ARC-15', 'ARC-16', 'ARC-18', 'ARC-20', 'ARC-28', 'ARC-30', 'XD-01'],
  },

  // --- multi-level --------------------------------------------------------
  'maisonette-2s': {
    id: 'maisonette-2s',
    name: 'Maisonette (two storeys)',
    regionalNames: { US: 'Duplex apartment', UK: 'Maisonette', CA: 'Two-storey apartment', AU: 'Two-level apartment', NZ: 'Two-level apartment', IE: 'Duplex apartment' },
    description: 'Two-storey flat with its own internal stair: living, kitchen and WC on the entry level, two bedrooms and the bathroom above. Wet rooms stack.',
    bedrooms: 2,
    bathrooms: 2,
    occupants: 4,
    area: { min: 95, target: 104, max: 115 },
    frontage: { min: 5.4, max: 7.0 },
    depth: { min: 8.5, max: 10.0 },
    storeysInUnit: 2,
    aspect: 'dual',
    rooms: [
      rp('living', 1, 24, 19, 3.4),
      rp('kitchen', 1, 11.0, 7.5, 2.4),
      rp('wc', 1, 2.2, 1.6, 1.1),
      entryHall(4.0),
      stairRoom(4.6),
      rp('storage', 1, 2.4, 1.2, 0.9),
      master(14.0),
      bedDouble(11.8),
      bath(5.0),
      hall(4.0),
      closets(2, 1.5),
      laundryClo(1.8),
    ],
    suitableTypologies: ['stacked-townhouse', 'deck-access', 'garden-walkup', 'courtyard-block', 'corridor-midrise', 'townhouse-row'],
    patterns: ['ARC-14', 'ARC-15', 'ARC-16', 'ARC-17', 'ARC-18', 'ARC-19', 'ARC-20', 'ARC-21', 'ARC-22', 'ARC-28', 'ARC-29', 'ARC-30', 'XD-01', 'XD-05'],
  },

  'townhouse-2s': {
    id: 'townhouse-2s',
    name: 'Townhouse (two storeys)',
    regionalNames: { US: 'Two-story townhome', UK: 'Two-storey terraced house', CA: 'Two-storey townhouse', AU: 'Two-storey townhouse', NZ: 'Two-storey townhouse', IE: 'Two-storey terraced house' },
    description: 'Own-door house on two levels: entry, living, dining and kitchen at ground with a WC; three bedrooms, family bathroom and en-suite above.',
    bedrooms: 3,
    bathrooms: 2,
    occupants: 5,
    area: { min: 110, target: 126, max: 140 },
    frontage: { min: 6.0, max: 7.8 },
    depth: { min: 8.5, max: 9.5 },
    storeysInUnit: 2,
    aspect: 'dual',
    rooms: [
      rp('living', 1, 25, 20, 3.4),
      rp('dining', 1, 10.0, 7.0, 2.4),
      rp('kitchen', 1, 13.0, 8.5, 2.4),
      powder(2.5),
      entryHall(4.4),
      stairRoom(4.8),
      rp('storage', 1, 2.4, 1.2, 0.9),
      master(15.0),
      bedDouble(12.0),
      bedSingle(9.5),
      bath(5.2),
      hall(5.0),
      closets(3, 1.5),
      laundryClo(2.4),
    ],
    suitableTypologies: ['townhouse-row', 'semi-detached', 'stacked-townhouse', 'detached-house'],
    patterns: ['ARC-14', 'ARC-15', 'ARC-16', 'ARC-18', 'ARC-19', 'ARC-20', 'ARC-21', 'ARC-22', 'ARC-27', 'ARC-28', 'ARC-29', 'ARC-30', 'XD-01', 'XD-05'],
  },

  'townhouse-3s': {
    id: 'townhouse-3s',
    name: 'Townhouse (three storeys with garage)',
    regionalNames: { US: 'Three-story townhome with garage', UK: 'Three-storey town house', CA: 'Three-storey townhouse', AU: 'Three-storey townhouse', NZ: 'Three-level townhouse', IE: 'Three-storey town house' },
    description: 'Garage and flex room at ground, living/kitchen/dining on the first floor, three bedrooms and two bathrooms on the second. One stair stacks through all three levels.',
    bedrooms: 3,
    bathrooms: 2.5,
    occupants: 5,
    area: { min: 150, target: 180, max: 195 },
    frontage: { min: 6.4, max: 8.0 },
    depth: { min: 8.0, max: 9.0 },
    storeysInUnit: 3,
    aspect: 'dual',
    rooms: [
      // ground
      rp('garage', 1, 19.0, 15.0, 3.0),
      rp('flex', 1, 11.0, 7.5, 2.4),
      rp('wc', 1, 2.2, 1.6, 1.1),
      entryHall(4.2),
      stairRoom(4.8),
      rp('storage', 1, 2.6, 1.2, 0.9),
      // first
      rp('living', 1, 26, 20, 3.4),
      rp('dining', 1, 10.0, 7.0, 2.3),
      rp('kitchen', 1, 13.0, 8.5, 2.4),
      powder(2.4),
      // second
      master(15.0),
      bedDouble(12.0),
      bedSingle(10.0),
      bath(5.2),
      hall(5.0),
      closets(3, 1.5),
      laundryClo(2.4),
    ],
    suitableTypologies: ['townhouse-row', 'semi-detached', 'stacked-townhouse'],
    patterns: ['ARC-14', 'ARC-15', 'ARC-16', 'ARC-18', 'ARC-19', 'ARC-20', 'ARC-21', 'ARC-22', 'ARC-27', 'ARC-28', 'ARC-29', 'ARC-30', 'XD-01', 'XD-05'],
  },

  // --- houses -------------------------------------------------------------
  'ranch-3b': {
    id: 'ranch-3b',
    name: 'Single-storey three bedroom house',
    regionalNames: { US: 'Ranch-style 3 bed', UK: 'Three-bed bungalow', CA: 'Bungalow, 3 bedroom', AU: 'Single-storey 3-bedroom house', NZ: 'Three-bedroom single-level house', IE: 'Three-bed bungalow' },
    description: 'Everything on one level: living and dining at the front/garden aspect, kitchen and utility on the wet wall, three bedrooms in a wing off the hall with a master en-suite.',
    bedrooms: 3,
    bathrooms: 2,
    occupants: 5,
    area: { min: 140, target: 155, max: 170 },
    frontage: { min: 13.0, max: 18.0 },
    depth: { min: 9.0, max: 11.0 },
    storeysInUnit: 1,
    aspect: 'corner',
    rooms: [
      rp('living', 1, 30, 22, 4.2),
      rp('dining', 1, 12.0, 8.0, 2.8),
      rp('kitchen', 1, 15.0, 9.5, 3.0),
      master(15.5),
      bedDouble(12.0),
      bedDouble(11.5),
      ensuite(5.2),
      bath(5.4),
      entryHall(5.5),
      hall(6.5),
      rp('walk-in-closet', 1, 3.2, 1.5, 1.0),
      closets(3, 1.6),
      rp('laundry', 1, 4.0, 2.4, 1.5),
      rp('storage', 1, 3.0, 1.5, 1.0),
    ],
    suitableTypologies: ['detached-house', 'semi-detached', 'senior-living'],
    patterns: ['ARC-14', 'ARC-15', 'ARC-16', 'ARC-18', 'ARC-19', 'ARC-20', 'ARC-21', 'ARC-26', 'ARC-27', 'ARC-28', 'ARC-29', 'ARC-30', 'XD-01', 'XD-05'],
  },

  'colonial-4b': {
    id: 'colonial-4b',
    name: 'Two-storey four bedroom house',
    regionalNames: { US: 'Colonial, 4 bed', UK: 'Four-bed detached house', CA: 'Two-storey 4 bedroom', AU: 'Two-storey 4-bedroom house', NZ: 'Two-storey four-bedroom house', IE: 'Four-bed detached house' },
    description: 'Centre-hall plan: entry hall with the stair, living and dining to one side, kitchen/family and study to the other; four bedrooms, two bathrooms and the laundry above.',
    bedrooms: 4,
    bathrooms: 2.5,
    occupants: 6,
    area: { min: 200, target: 230, max: 260 },
    frontage: { min: 10.5, max: 14.0 },
    depth: { min: 9.0, max: 11.5 },
    storeysInUnit: 2,
    aspect: 'corner',
    rooms: [
      // ground
      rp('living', 1, 28, 22, 4.2),
      rp('dining', 1, 15.0, 10.0, 3.0),
      rp('kitchen', 1, 18.0, 11.0, 3.2),
      rp('study', 1, 12.0, 8.0, 2.8),
      powder(2.6),
      entryHall(8.0),
      stairRoom(5.2),
      rp('storage', 1, 3.0, 1.5, 1.0),
      // first
      master(18.0),
      bedDouble(13.0),
      bedDouble(12.0),
      bedSingle(11.0),
      ensuite(6.5),
      bath(6.0),
      hall(8.0),
      rp('walk-in-closet', 1, 4.5, 2.0, 1.2),
      closets(3, 1.6),
      rp('laundry', 1, 4.5, 2.4, 1.5),
    ],
    suitableTypologies: ['detached-house', 'semi-detached'],
    patterns: ['ARC-14', 'ARC-15', 'ARC-16', 'ARC-18', 'ARC-19', 'ARC-20', 'ARC-21', 'ARC-22', 'ARC-26', 'ARC-27', 'ARC-28', 'ARC-29', 'ARC-30', 'XD-01', 'XD-05'],
  },

  'adu-1b': {
    id: 'adu-1b',
    name: 'Accessory dwelling unit, one bedroom',
    regionalNames: { US: 'ADU / casita', UK: 'Annexe', CA: 'Laneway house / garden suite', AU: 'Granny flat', NZ: 'Minor dwelling', IE: 'Granny flat' },
    description: 'Small self-contained one-bedroom dwelling in a back garden or laneway: open living/kitchen, one bedroom, a shower room and a utility closet.',
    bedrooms: 1,
    bathrooms: 1,
    occupants: 2,
    area: { min: 40, target: 48, max: 55 },
    frontage: { min: 5.4, max: 7.6 },
    depth: { min: 6.5, max: 8.5 },
    storeysInUnit: 1,
    aspect: 'corner',
    rooms: [
      rp('living-kitchen', 1, 22, 17, 3.6),
      bedDouble(12.0),
      bath(4.6),
      entryHall(2.6),
      rp('utility', 1, 2.2, 1.2, 0.9),
      closets(2, 1.4),
    ],
    suitableTypologies: ['adu-laneway', 'detached-house'],
    patterns: ['ARC-14', 'ARC-15', 'ARC-16', 'ARC-18', 'ARC-19', 'ARC-20', 'ARC-28', 'ARC-30', 'XD-01', 'XD-05'],
  },

  // --- shared and accessible ---------------------------------------------
  'coliving-cluster': {
    id: 'coliving-cluster',
    name: 'Co-living cluster flat (6 en-suite rooms)',
    regionalNames: { US: 'Co-living suite', UK: 'Cluster flat / HMO', CA: 'Co-living suite', AU: 'Co-living apartment', NZ: 'Co-living apartment', IE: 'Cluster apartment' },
    description: 'Six lockable en-suite bedrooms off a short internal corridor from the front door, with a large shared kitchen/living room at the window end and a shared laundry.',
    bedrooms: 6,
    bathrooms: 6,
    occupants: 6,
    area: { min: 180, target: 212, max: 240 },
    frontage: { min: 9.5, max: 13.0 },
    depth: { min: 15.0, max: 20.0 },
    storeysInUnit: 1,
    aspect: 'dual',
    rooms: [
      rp('bedroom', 6, 13.5, 12.0, 2.75),
      rp('ensuite', 6, 3.9, 3.2, 1.5),
      rp('shared-living', 1, 26, 20, 3.8),
      rp('shared-kitchen', 1, 16, 12, 3.0),
      entryHall(4.0),
      rp('corridor', 1, 18.0, 10.0, 1.2),
      rp('laundry', 1, 4.0, 2.4, 1.4),
      rp('storage', 1, 3.5, 1.8, 1.0),
    ],
    suitableTypologies: ['coliving-cluster', 'corridor-midrise', 'mixed-use-midrise'],
    patterns: ['ARC-14', 'ARC-15', 'ARC-16', 'ARC-20', 'ARC-21', 'ARC-24', 'ARC-28', 'ARC-29', 'ARC-30', 'XD-01', 'XD-05'],
  },

  'senior-1b-accessible': {
    id: 'senior-1b-accessible',
    name: 'Accessible one-bedroom (senior living)',
    regionalNames: { US: 'Accessible 1 bed (ADA / Type A)', UK: 'Wheelchair-accessible 1-bed flat (M4(3))', CA: 'Barrier-free 1 bedroom', AU: 'Livable Housing Gold 1-bedroom', NZ: 'Accessible 1-bedroom apartment', IE: 'Wheelchair-accessible 1-bed apartment' },
    description: 'Wheelchair-usable one-bedroom: 900 mm doors, 1500 mm turning circles in the kitchen, bathroom and entry, roll-in shower with grab rails, level thresholds.',
    bedrooms: 1,
    bathrooms: 1,
    occupants: 2,
    area: { min: 60, target: 65, max: 70 },
    frontage: { min: 6.4, max: 8.2 },
    depth: { min: 8.5, max: 10.0 },
    storeysInUnit: 1,
    aspect: 'single',
    rooms: [
      rp('living', 1, 22, 18, 3.6),
      // 1.5 m turning circle clear of the 0.6 m counter run → 2.7 m minimum clear width
      rp('kitchen', 1, 10.5, 8.5, 2.7),
      bedDouble(14.0, 1),
      // ADA 2010 §603/§604: 1.5 m turning circle + roll-in shower → 2.2 m minimum width
      rp('bathroom', 1, 6.5, 5.0, 2.2),
      entryHall(4.5),
      hall(3.6),
      rp('walk-in-closet', 1, 3.0, 1.8, 1.2),
      closets(1, 1.4),
      laundryClo(2.5),
    ],
    suitableTypologies: ['senior-living', 'corridor-midrise', 'garden-walkup', 'deck-access', 'mixed-use-midrise', 'courtyard-block'],
    patterns: ['ARC-14', 'ARC-15', 'ARC-16', 'ARC-18', 'ARC-20', 'ARC-23', 'ARC-28', 'ARC-30', 'XD-01', 'XD-05'],
  },
};

// ----------------------------------------------------------------------------
// Level programs for multi-storey templates
// ----------------------------------------------------------------------------

/**
 * Which room types sit on which level of a multi-storey unit (index = level, 0 = entry level).
 * Counts are per level; anything left over after the table is consumed lands on level 0.
 * Templates absent from this table are single-level.
 */
export const UNIT_LEVEL_SPLIT: Partial<Record<UnitTemplateId, Partial<Record<RoomType, number>>[]>> = {
  'maisonette-2s': [
    { entry: 1, living: 1, kitchen: 1, wc: 1, stair: 1, storage: 1 },
    { 'master-bedroom': 1, bedroom: 1, bathroom: 1, hall: 1, closet: 2, laundry: 1, stair: 1 },
  ],
  'townhouse-2s': [
    { entry: 1, living: 1, dining: 1, kitchen: 1, powder: 1, stair: 1, storage: 1 },
    { 'master-bedroom': 1, bedroom: 2, bathroom: 1, hall: 1, closet: 3, laundry: 1, stair: 1 },
  ],
  'townhouse-3s': [
    { entry: 1, garage: 1, flex: 1, wc: 1, stair: 1, storage: 1 },
    { living: 1, dining: 1, kitchen: 1, powder: 1, stair: 1 },
    { 'master-bedroom': 1, bedroom: 2, bathroom: 1, hall: 1, closet: 3, laundry: 1, stair: 1 },
  ],
  'colonial-4b': [
    { entry: 1, living: 1, dining: 1, kitchen: 1, study: 1, powder: 1, stair: 1, storage: 1 },
    { 'master-bedroom': 1, bedroom: 3, ensuite: 1, bathroom: 1, hall: 1, 'walk-in-closet': 1, closet: 3, laundry: 1, stair: 1 },
  ],
};

// ----------------------------------------------------------------------------
// Lookups
// ----------------------------------------------------------------------------

export function getUnitTemplate(id: UnitTemplateId): UnitTemplateDef {
  const t = UNIT_TEMPLATES[id];
  if (!t) throw new Error(`Unknown unit template: ${id}`);
  return t;
}

/** Templates whose `suitableTypologies` include the given typology id. */
export function templatesForTypology(typologyId: string): UnitTemplateDef[] {
  return UNIT_TEMPLATE_IDS.map(id => UNIT_TEMPLATES[id]).filter(t => (t.suitableTypologies as string[]).includes(typologyId));
}

/** Region-appropriate display name. */
export function templateName(t: UnitTemplateDef, region: string): string {
  return (t.regionalNames as Record<string, string | undefined>)[region] ?? t.name;
}

/** Sum of the program's target areas (excluding balconies) — a sanity check against `area.target`. */
export function programArea(t: UnitTemplateDef): number {
  return t.rooms.reduce((s, r) => s + r.count * r.targetArea, 0);
}

/** Bedspaces implied by the program (2 per double, 1 per single) — see XD-05. */
export function programBedspaces(t: UnitTemplateDef): number {
  let n = 0;
  for (const r of t.rooms) {
    if (r.type === 'bedroom' || r.type === 'master-bedroom') n += r.count * (r.minArea >= 11 ? 2 : 1);
  }
  return n;
}

/** Recommended NET rect (frontage × depth, metres) for a template — the midpoint of its ranges. */
export function recommendedRect(id: UnitTemplateId): { frontage: number; depth: number } {
  const t = getUnitTemplate(id);
  const depth = round1((t.depth.min + t.depth.max) / 2);
  const perLevel = t.area.target / t.storeysInUnit;
  const frontage = clamp(round1(perLevel / depth), t.frontage.min, t.frontage.max);
  return { frontage, depth };
}

function round1(v: number): number { return Math.round(v * 10) / 10; }
function clamp(v: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, v)); }

export const ALL_UNIT_TEMPLATES: UnitTemplateDef[] = UNIT_TEMPLATE_IDS.map(id => UNIT_TEMPLATES[id]);
