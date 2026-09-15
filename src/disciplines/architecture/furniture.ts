/**
 * Furniture and fixture catalogue for dwelling layouts.
 *
 * Dimensions are real-world nominal sizes in METRES: `w` along the item's local X (its width as
 * seen from the front), `d` along its local +Y (depth, front face at local y = d), `h` height.
 * A FurnitureDef places the footprint min corner at `position` and rotates about that corner, so
 * an unrotated item's BACK is the y = 0 edge (see `faceToRotation` in unit-layout.ts).
 *
 * `needsWater` / `needsPower` are the hooks plumbing and electrical consume: the plumbing module
 * turns every needsWater item into a PlumbingFixture on the nearest wet wall, and the electrical
 * module gives every needsPower item a dedicated or small-appliance circuit.
 *
 * Sources: ADA 2010 §604/§606/§608 clearances, IRC R304/R305, AS 1428.1, Approved Document M,
 * Neufert Architects' Data 5th ed. (beds, tables, counters), typical UK/US/AU appliance sizes
 * (600 mm module in UK/AU/EU, 30"/36" ranges and fridges in US/CA).
 */
import type { FurnitureType } from '../../core/types.ts';

export interface FurnitureSpec {
  /** Width along the item's local X (m) */
  w: number;
  /** Depth along the item's local Y; the front face is the +Y edge (m) */
  d: number;
  /** Height (m) */
  h: number;
  /** Needs water supply and/or waste — plumbing hooks a fixture to it */
  needsWater?: boolean;
  /** Needs a power connection — electrical gives it a circuit */
  needsPower?: boolean;
}

/** Real nominal sizes, metres. */
export const FURNITURE_CATALOG: Record<FurnitureType, FurnitureSpec> = {
  // --- beds and bedroom ---------------------------------------------------
  'bed-king': { w: 1.93, d: 2.03, h: 0.6 },          // US/CA king 76" × 80"
  'bed-queen': { w: 1.52, d: 2.03, h: 0.6 },         // queen 60" × 80"
  'bed-double': { w: 1.37, d: 1.9, h: 0.6 },         // UK/AU double 135 × 190
  'bed-single': { w: 0.99, d: 1.9, h: 0.6 },         // single / twin 90–100 × 190
  'bed-bunk': { w: 0.99, d: 1.9, h: 1.7 },
  nightstand: { w: 0.5, d: 0.4, h: 0.55 },
  wardrobe: { w: 1.2, d: 0.6, h: 2.1 },
  dresser: { w: 1.2, d: 0.5, h: 0.8 },
  crib: { w: 0.7, d: 1.3, h: 0.9 },

  // --- living / study -----------------------------------------------------
  desk: { w: 1.2, d: 0.6, h: 0.75, needsPower: true },
  chair: { w: 0.45, d: 0.45, h: 0.85 },
  'sofa-3': { w: 2.1, d: 0.9, h: 0.85 },
  'sofa-2': { w: 1.6, d: 0.9, h: 0.85 },
  armchair: { w: 0.85, d: 0.85, h: 0.85 },
  'coffee-table': { w: 1.2, d: 0.6, h: 0.45 },
  'tv-unit': { w: 1.6, d: 0.45, h: 0.5, needsPower: true },
  'dining-table-4': { w: 1.2, d: 0.8, h: 0.75 },
  'dining-table-6': { w: 1.8, d: 0.9, h: 0.75 },
  'dining-chair': { w: 0.45, d: 0.45, h: 0.9 },
  shelving: { w: 0.9, d: 0.35, h: 2.0 },
  bookcase: { w: 0.9, d: 0.35, h: 2.0 },
  'lounge-chair': { w: 0.75, d: 0.85, h: 0.9 },
  bench: { w: 1.2, d: 0.4, h: 0.45 },

  // --- kitchen ------------------------------------------------------------
  'kitchen-counter': { w: 1.2, d: 0.6, h: 0.9 },     // w is stretched per run segment
  'kitchen-island': { w: 1.8, d: 0.9, h: 0.9 },
  fridge: { w: 0.9, d: 0.75, h: 1.8, needsPower: true },
  range: { w: 0.76, d: 0.65, h: 0.9, needsPower: true },
  dishwasher: { w: 0.6, d: 0.6, h: 0.85, needsWater: true, needsPower: true },
  'kitchen-sink': { w: 0.8, d: 0.6, h: 0.2, needsWater: true },

  // --- bathroom / laundry -------------------------------------------------
  wc: { w: 0.4, d: 0.7, h: 0.8, needsWater: true },
  lavatory: { w: 0.6, d: 0.5, h: 0.85, needsWater: true },
  vanity: { w: 0.9, d: 0.55, h: 0.85, needsWater: true },
  shower: { w: 0.9, d: 0.9, h: 2.0, needsWater: true },
  bathtub: { w: 1.7, d: 0.75, h: 0.6, needsWater: true },
  washer: { w: 0.6, d: 0.6, h: 0.85, needsWater: true, needsPower: true },
  dryer: { w: 0.6, d: 0.6, h: 0.85, needsPower: true },
  'water-heater': { w: 0.6, d: 0.6, h: 1.5, needsWater: true, needsPower: true },
  'grab-rail': { w: 0.6, d: 0.05, h: 0.05 },

  // --- outdoor / common / parking ----------------------------------------
  planter: { w: 0.5, d: 0.5, h: 0.6 },
  'outdoor-table': { w: 0.8, d: 0.8, h: 0.74 },
  'bike-rack': { w: 1.8, d: 0.6, h: 0.9 },
  'mailbox-bank': { w: 1.2, d: 0.4, h: 1.2 },
  'reception-desk': { w: 2.4, d: 0.8, h: 1.1 },
  treadmill: { w: 0.9, d: 2.0, h: 1.4, needsPower: true },
  car: { w: 1.8, d: 4.5, h: 1.5 },
};

/** Clearances (m) that room dimensions must respect — pattern ARC-15 cites these. */
export const CLEARANCE = {
  /** Circulation aisle beside a bed (one side may drop to 0.45 in a single bedroom) */
  bedSide: 0.75,
  /** Foot of the bed to the opposite wall/wardrobe */
  bedFoot: 0.7,
  /** Kitchen aisle between opposing runs (galley) */
  kitchenAisle: 1.2,
  /** Accessible kitchen / bathroom turning circle (ADA 2010 §304.3.1, ADM M4(2)) */
  turningCircle: 1.5,
  /** Clear floor in front of a WC (ADA §604.3 / Part M) */
  wcFront: 0.75,
  /** WC centreline to a side wall (ADA §604.2 gives 0.41–0.46) */
  wcSide: 0.4,
  /** Clear space in front of a vanity / lavatory */
  lavatoryFront: 0.7,
  /** Dining chair pull-out zone behind a chair */
  diningPull: 0.75,
  /** Sofa to coffee table */
  sofaCoffee: 0.4,
  /** Sofa to TV */
  sofaTv: 2.2,
  /** Furniture stand-off from a wall so it never buries a skirting/architrave */
  wall: 0.02,
} as const;

export function furnitureSpec(type: FurnitureType): FurnitureSpec {
  return FURNITURE_CATALOG[type];
}

/** Storage volume of an item (m³) — used by ARC-30 Storage per Occupant. */
export function storageVolume(type: FurnitureType, w = FURNITURE_CATALOG[type].w): number {
  const s = FURNITURE_CATALOG[type];
  switch (type) {
    case 'wardrobe': return w * s.d * s.h * 0.85;
    case 'shelving':
    case 'bookcase': return w * s.d * s.h * 0.8;
    case 'dresser': return w * s.d * s.h * 0.7;
    case 'kitchen-counter': return w * s.d * 0.7 * 0.6;
    default: return 0;
  }
}

/** Every catalogue type that plumbing must connect. */
export const WATER_ITEMS: FurnitureType[] = (Object.keys(FURNITURE_CATALOG) as FurnitureType[])
  .filter(t => FURNITURE_CATALOG[t].needsWater === true);

/** Every catalogue type that electrical must circuit. */
export const POWER_ITEMS: FurnitureType[] = (Object.keys(FURNITURE_CATALOG) as FurnitureType[])
  .filter(t => FURNITURE_CATALOG[t].needsPower === true);
