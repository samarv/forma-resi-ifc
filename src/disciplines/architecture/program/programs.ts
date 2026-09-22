/**
 * The 20 program graphs — one per `UnitTemplateId`.
 *
 * A program graph is the v2 replacement for "a template is a list of rooms": rooms are NODES with
 * kit-derived size bounds, and the relationships between them (`share-edge`, `door`, `no-door`,
 * `not-adjacent`) are DATA, not something the layout engine rediscovers geometrically. Sizes come
 * from `kits-api.ts` — a room that exists is a room whose complete furniture kit fits — and the
 * build-time test in `feasibility.test.ts` re-asserts `minWidth ≥ kitMinDims(kit).w` and
 * `minDepth ≥ kitMinDims(kit).d` for every node of every graph.
 *
 * Areas are `[min, target, max]` m² NIA; `min` is the published minimum carried over from
 * `templates.ts` (London Plan 2021 Table 3.1 / NDSS 2015 / IRC R304 / NCC Vol. 2), `target` is the
 * template's programmed area, `max` is what the same room may grow to before the plan should have
 * used a bigger template. `dims` are `[minWidth, minDepth]` clear internal metres from the kit.
 *
 * Deliberate changes from `templates.ts` (the price of mechanism 2, kit-derived minima):
 *  - kitchen minWidth 2.2–3.2 → 2.50 (galley) / 3.10 (galley + washer, island) / 2.70 (accessible),
 *    because a kitchen without a sink, a range and a fridge is not a kitchen. This lifts `Fmin` for
 *    1b1b, 2b1b and dual-key by ≈ 0.3 m.
 *  - kitchen minDepth for an island kitchen is 3.30 m (0.6 counter + 1.2 walk + 0.9 island + 0.6),
 *    which the design's worked 2b2b example wrote as 1.8; the kit governs, so the node says 3.30.
 *  - living rooms carry the `living-3seat` kit (3.40 × 3.05) and bedrooms the London Plan widths,
 *    so a "bedroom" always holds a bed, a nightstand and a wardrobe with a 0.75 m walkway.
 */
import type { Region, RoomType, UnitTemplateId, Zone } from '../../../core/types.ts';
import type { AdjacencyRule, KitId, NodeRef, ProgramBand, ProgramGraph, ProgramNode } from './types.ts';
import { kitMinDims } from './kits-api.ts';

// ---------------------------------------------------------------------------------------------------
// Node defaults
// ---------------------------------------------------------------------------------------------------

const ZONE_OF: Partial<Record<RoomType, Zone>> = {
  living: 'public', dining: 'public', 'living-kitchen': 'public', flex: 'public',
  'shared-living': 'public', 'shared-kitchen': 'public',
  kitchen: 'service', bathroom: 'service', ensuite: 'service', powder: 'service', wc: 'service',
  closet: 'service', 'walk-in-closet': 'service', laundry: 'service', utility: 'service',
  storage: 'service', garage: 'service', den: 'private',
  bedroom: 'private', 'master-bedroom': 'private', study: 'private',
  entry: 'circulation', hall: 'circulation', corridor: 'circulation', stair: 'circulation',
  balcony: 'outdoor', terrace: 'outdoor',
};

const BAND_OF: Partial<Record<RoomType, ProgramBand>> = {
  living: 'daylit', dining: 'daylit', 'living-kitchen': 'daylit', bedroom: 'daylit',
  'master-bedroom': 'daylit', study: 'daylit', flex: 'daylit', 'shared-living': 'daylit',
  'shared-kitchen': 'daylit',
  entry: 'circulation', hall: 'circulation', corridor: 'circulation', stair: 'circulation',
};

const DAYLIT_OF = new Set<RoomType>([
  'living', 'dining', 'living-kitchen', 'bedroom', 'master-bedroom', 'study', 'flex', 'shared-living',
]);

const WET_OF = new Set<RoomType>([
  'kitchen', 'living-kitchen', 'bathroom', 'ensuite', 'powder', 'wc', 'laundry', 'utility', 'shared-kitchen',
]);

/** Largest sensible clear dimensions per room type (m) — the same table the v1 engine used. */
/** Longest:shortest ratio a room may reach before it stops working as that room */
const ASPECT_OF: Partial<Record<RoomType, number>> = {
  hall: 12, corridor: 24, stair: 6, entry: 4,
  closet: 11, 'walk-in-closet': 7, storage: 11, laundry: 6, utility: 6,
  bathroom: 3.0, ensuite: 3.8, powder: 3.0, wc: 3.0, kitchen: 3.2, dining: 3.8,
};
const DEFAULT_ASPECT = 2.6;

const LIMIT_OF: Partial<Record<RoomType, [number, number]>> = {
  living: [7.0, 7.0], 'living-kitchen': [8.5, 8.5], dining: [5.0, 5.5], kitchen: [6.0, 4.6],
  bedroom: [4.8, 5.6], 'master-bedroom': [5.6, 6.2], study: [4.6, 5.0], den: [3.6, 4.4],
  flex: [4.8, 5.6], bathroom: [3.2, 4.4], ensuite: [3.0, 4.4], powder: [2.2, 3.2], wc: [2.2, 3.2],
  entry: [3.2, 4.4], hall: [12.0, 2.8], corridor: [24.0, 2.8], closet: [2.4, 4.4],
  'walk-in-closet': [3.0, 4.4], laundry: [2.8, 4.4], utility: [2.8, 4.4], storage: [3.0, 4.4],
  garage: [4.4, 6.6], stair: [2.4, 6.5], 'shared-living': [13.0, 8.0], 'shared-kitchen': [13.0, 6.0],
};
const DEFAULT_LIMIT: [number, number] = [6.0, 6.0];

type Triple = [number, number, number];
type Dims = [number, number];

/** `n(ref, type, [minArea, target, maxArea], [minWidth, minDepth], kit, overrides)` */
function n(ref: NodeRef, type: RoomType, area: Triple, dims: Dims, kit: KitId, o: Partial<ProgramNode> = {}): ProgramNode {
  const lim = LIMIT_OF[type] ?? DEFAULT_LIMIT;
  const k = kitMinDims(kit);
  const minWidth = Math.max(dims[0], k.w, o.minWidth ?? 0);
  const minDepth = Math.max(dims[1], k.d, o.minDepth ?? 0);
  return {
    ref,
    type,
    zone: o.zone ?? ZONE_OF[type] ?? 'service',
    level: o.level ?? 0,
    area: o.area ?? { min: area[0], target: area[1], max: area[2] },
    minWidth,
    minDepth,
    maxWidth: Math.max(o.maxWidth ?? lim[0], minWidth),
    maxDepth: Math.max(o.maxDepth ?? lim[1], minDepth),
    aspect: o.aspect ?? { min: 1, max: ASPECT_OF[type] ?? DEFAULT_ASPECT },
    needsExterior: o.needsExterior ?? DAYLIT_OF.has(type),
    wet: o.wet ?? WET_OF.has(type),
    kit,
    stackable: o.stackable ?? false,
    ...(o.mergeInto ? { mergeInto: o.mergeInto } : {}),
    band: o.band ?? BAND_OF[type] ?? 'service',
  };
}

// --- repeated rooms, so twenty graphs stay readable -------------------------------------------------

const amax = (target: number): number => Math.round(Math.max(target * 1.25, target + 0.6) * 10) / 10;

const living = (target: number, minArea: number, minW = 3.4, o: Partial<ProgramNode> = {}): ProgramNode =>
  n('living1', 'living', [minArea, target, amax(target)], [minW, 3.05], 'living-3seat', o);
const livingKitchen = (ref: NodeRef, target: number, minArea: number, o: Partial<ProgramNode> = {}): ProgramNode =>
  n(ref, 'living-kitchen', [minArea, target, amax(target)], [3.6, 4.2], 'living-kitchen', o);
const dining = (target: number, minArea: number, minW: number, o: Partial<ProgramNode> = {}): ProgramNode =>
  n('dining1', 'dining', [minArea, target, amax(target)], [minW, 2.3], target >= 12 ? 'dining-6' : 'dining-4', o);
/** kitchen kit by size: a 12 m²+ kitchen gets an island, an 8 m²+ one a washer, below that a galley */
const kitchen = (target: number, minArea: number, o: Partial<ProgramNode> = {}): ProgramNode => {
  const kit: KitId = o.kit ?? (target >= 12 ? 'kitchen-island' : target >= 8 ? 'kitchen-galley-washer' : 'kitchen-galley');
  return n('kitchen1', 'kitchen', [minArea, target, amax(target)], [0, 0], kit, o);
};
const bedDouble = (ref: NodeRef, target: number, o: Partial<ProgramNode> = {}): ProgramNode =>
  n(ref, 'bedroom', [11.5, target, amax(target)], [2.75, 3.2], 'bed-double', o);
const bedSingle = (ref: NodeRef, target: number, o: Partial<ProgramNode> = {}): ProgramNode =>
  n(ref, 'bedroom', [7.5, target, amax(target)], [2.15, 2.9], 'bed-single', o);
const bedMaster = (target: number, o: Partial<ProgramNode> = {}): ProgramNode =>
  n('masterbedroom1', 'master-bedroom', [12.5, target, amax(target)], [2.9, 3.4], 'bed-master', o);
const bathTub = (ref: NodeRef, target: number, o: Partial<ProgramNode> = {}): ProgramNode =>
  n(ref, 'bathroom', [3.7, target, amax(target)], [1.7, 2.2], 'bath-3pc-tub', o);
const bathShower = (ref: NodeRef, type: RoomType, target: number, minArea: number, o: Partial<ProgramNode> = {}): ProgramNode =>
  n(ref, type, [minArea, target, amax(target)], [1.6, 2.0], 'bath-3pc-shower', o);
const wc2pc = (ref: NodeRef, type: RoomType, target: number, o: Partial<ProgramNode> = {}): ProgramNode =>
  n(ref, type, [1.6, target, amax(target)], [1.1, 1.5], 'wc-2pc', o);
const entryNode = (target: number, o: Partial<ProgramNode> = {}): ProgramNode =>
  n('entry1', 'entry', [2.0, target, amax(target)], [1.2, 1.5], 'entry', o);
const hallNode = (ref: NodeRef, target: number, o: Partial<ProgramNode> = {}): ProgramNode =>
  n(ref, 'hall', [2.0, target, amax(target)], [1.1, 1.1], 'none', o);
const stairNode = (ref: NodeRef, target: number, o: Partial<ProgramNode> = {}): ProgramNode =>
  n(ref, 'stair', [3.2, target, amax(target)], [1.0, 3.8], 'none', { maxWidth: 2.4, maxDepth: 6.5, ...o });
const laundry = (ref: NodeRef, target: number, host: NodeRef, kit: KitId = 'laundry-stack', o: Partial<ProgramNode> = {}): ProgramNode =>
  n(ref, 'laundry', [1.2, target, amax(target)], [0, 0], kit,
    { stackable: true, mergeInto: { ref: host, kit: kit === 'laundry-side' ? 'laundry-side' : 'laundry-stack' }, ...o });
const closet = (ref: NodeRef, target: number, host: NodeRef, o: Partial<ProgramNode> = {}): ProgramNode =>
  n(ref, 'closet', [0.8, target, amax(target)], [0.6, 0.6], 'shelf',
    { stackable: true, mergeInto: { ref: host, kit: 'wardrobe-run' }, ...o });
const walkin = (target: number, host: NodeRef, o: Partial<ProgramNode> = {}): ProgramNode =>
  n('walkincloset1', 'walk-in-closet', [1.5, target, amax(target)], [1.0, 1.5], 'wardrobe-run',
    { stackable: true, mergeInto: { ref: host, kit: 'wardrobe-run' }, ...o });
const storeNode = (ref: NodeRef, target: number, minArea: number, host: NodeRef, o: Partial<ProgramNode> = {}, minW = 0.9): ProgramNode =>
  n(ref, 'storage', [minArea, target, amax(target)], [minW, 0.6], 'shelf',
    { stackable: true, mergeInto: { ref: host, kit: 'shelf' }, ...o });

// ---------------------------------------------------------------------------------------------------
// Adjacency rules
// ---------------------------------------------------------------------------------------------------

const UKIE: Region[] = ['UK', 'IE'];
const R = (a: NodeRef | RoomType, b: NodeRef | RoomType, kind: AdjacencyRule['kind'], reason: string, regions?: Region[]): AdjacencyRule =>
  regions ? { a, b, kind, regions, reason } : { a, b, kind, reason };

const WET_ROOM_TYPES = new Set<RoomType>(['bathroom', 'ensuite', 'powder', 'wc']);

/**
 * The rules every dwelling shares, derived from the node list so that all twenty graphs are held to
 * the same standard: one circulation hub per level, bathrooms off circulation (ARC-19), the kitchen
 * beside the living/dining it serves (ARC-20), en-suites off their bedroom (ARC-21), one wet wall per
 * wet group (XD-01), no bedroom entered off a kitchen, and the UK/IE rule that a WC must not open
 * directly into a kitchen or a food-preparation space (Building Regulations Approved Document G /
 * Part F; Irish Building Regulations Part H).
 */
function commonRules(nodes: ProgramNode[], levels: number): AdjacencyRule[] {
  const out: AdjacencyRule[] = [];
  const byRef = new Map(nodes.map(x => [x.ref, x]));
  const at = (level: number): ProgramNode[] => nodes.filter(x => x.level === level);
  for (let L = 0; L < levels; L++) {
    const here = at(L);
    if (here.length === 0) continue;
    const hall = here.find(x => x.type === 'hall');
    const entry = here.find(x => x.type === 'entry');
    const stair = here.find(x => x.type === 'stair');
    const corridor = here.find(x => x.type === 'corridor');
    const hub = hall ?? corridor ?? entry ?? stair ?? here.find(x => x.zone === 'public');
    if (!hub) continue;
    if (entry && hub !== entry) out.push(R(entry.ref, hub.ref, 'door', 'ARC-18 threshold before the dwelling proper'));
    if (entry && stair) out.push(R(entry.ref, stair.ref, 'share-edge', 'ARC-22 one stair stacks on the party wall beside the entry'));
    if (hall && stair) out.push(R(stair.ref, hall.ref, 'door', 'ARC-22 the stair lands in the circulation, never in a room'));
    for (const x of here) {
      if (x.ref === hub.ref) continue;
      const wantsDoorOffHub = x.zone === 'private' || x.type === 'bathroom' || x.type === 'powder' || x.type === 'wc'
        || x.type === 'living' || x.type === 'living-kitchen' || x.type === 'shared-living' || x.type === 'flex';
      if (wantsDoorOffHub) {
        out.push(R(hub.ref, x.ref, 'door', x.zone === 'private'
          ? 'ARC-19 bedrooms and bathrooms open off circulation, never off each other'
          : 'ARC-19 habitable rooms open off the circulation spine'));
      }
    }
    // kitchen ↔ the room it serves
    const kit = here.find(x => x.type === 'kitchen');
    const din = here.find(x => x.type === 'dining');
    const liv = here.find(x => x.type === 'living');
    if (kit && din) {
      out.push(R(kit.ref, din.ref, 'share-edge', 'ARC-20 the kitchen serves the dining table across one wall'));
      out.push(R(kit.ref, din.ref, 'door', 'ARC-20'));
    } else if (kit && liv) {
      out.push(R(kit.ref, liv.ref, 'share-edge', 'ARC-20 the kitchen serves the living/dining'));
      out.push(R(kit.ref, liv.ref, 'door', 'ARC-20'));
    }
    if (din && liv) out.push(R(liv.ref, din.ref, 'door', 'ARC-10 street → threshold → front room → table'));
    // en-suite and dressing room off their bedroom
    const master = here.find(x => x.type === 'master-bedroom');
    const suite = here.find(x => x.type === 'ensuite');
    const dress = here.find(x => x.type === 'walk-in-closet');
    if (master && suite) out.push(R(master.ref, suite.ref, 'door', 'ARC-21 an en-suite opens off its own bedroom'));
    if (master && dress) out.push(R(master.ref, dress.ref, 'door', 'ARC-21'));
    // privacy and hygiene
    for (const b of here.filter(x => x.zone === 'private' && x.needsExterior)) {
      if (kit) out.push(R(b.ref, kit.ref, 'not-adjacent', 'ARC-19 a bedroom is not entered off a kitchen'));
      if (liv) out.push(R(b.ref, liv.ref, 'no-door', 'ARC-19 a bedroom is not a passage room'));
    }
    for (const w of here.filter(x => WET_ROOM_TYPES.has(x.type) && x.type !== 'ensuite')) {
      if (kit) out.push(R(w.ref, kit.ref, 'no-door', 'ADG Part G / Part H: a WC must not open directly into a kitchen'));
      if (liv) out.push(R(w.ref, liv.ref, 'no-door', 'ADG Part G: a WC must not open directly into a food-preparation or dining space', UKIE));
      if (din) out.push(R(w.ref, din.ref, 'no-door', 'ADG Part G', UKIE));
    }
  }
  // one wet wall per wet group, and the stair in the same footprint on every level
  for (let L = 0; L + 1 < levels; L++) {
    const a = at(L).find(x => x.type === 'stair');
    const b = at(L + 1).find(x => x.type === 'stair');
    if (a && b) out.push(R(a.ref, b.ref, 'share-edge', 'ARC-22 identical stair footprint on every level'));
  }
  for (const g of wetGroupsOf(nodes)) {
    for (let i = 0; i + 1 < g.length; i++) {
      if (byRef.has(g[i]) && byRef.has(g[i + 1])) out.push(R(g[i], g[i + 1], 'share-edge', 'XD-01 one wet wall, one stack'));
    }
  }
  return dedupeRules(out);
}

function dedupeRules(rules: AdjacencyRule[]): AdjacencyRule[] {
  const seen = new Set<string>();
  const out: AdjacencyRule[] = [];
  for (const r of rules) {
    const key = [r.a, r.b].sort().join('~') + '|' + r.kind + '|' + (r.regions ?? []).join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/**
 * Wet groups: all wet rooms of one level that can stand on one wet wall, plus a separate group for a
 * second stack when a level has an en-suite remote from the main wet core (`maxStacks: 2`).
 */
function wetGroupsOf(nodes: ProgramNode[]): NodeRef[][] {
  const out: NodeRef[][] = [];
  const levels = new Set(nodes.map(x => x.level));
  for (const L of [...levels].sort((a, b) => a - b)) {
    const wet = nodes.filter(x => x.level === L && x.wet);
    if (wet.length === 0) continue;
    const suites = wet.filter(x => x.type === 'ensuite');
    const core = wet.filter(x => x.type !== 'ensuite');
    if (core.length > 0) out.push(core.map(x => x.ref));
    if (suites.length > 0) out.push(suites.map(x => x.ref));
  }
  return out;
}

const ZONED_ORDER: Zone[][] = [['circulation', 'service'], ['private', 'public']];

/** Assemble a graph, deriving `wetGroups` and (unless given) the shared rule set from the nodes. */
function graph(o: {
  templateId: UnitTemplateId;
  levels?: number;
  nodes: ProgramNode[];
  rules?: AdjacencyRule[];
  extraRules?: AdjacencyRule[];
  zoneOrder?: Zone[][];
  maxStacks?: 1 | 2;
}): ProgramGraph {
  const levels = o.levels ?? 1;
  const rules = dedupeRules([...(o.rules ?? commonRules(o.nodes, levels)), ...(o.extraRules ?? [])]);
  const wetGroups = wetGroupsOf(o.nodes);
  return {
    id: `P-${o.templateId}`,
    templateId: o.templateId,
    levels,
    nodes: o.nodes,
    rules,
    zoneOrder: o.zoneOrder ?? ZONED_ORDER,
    wetGroups,
    maxStacks: o.maxStacks ?? (wetGroups.length > 1 ? 2 : 1),
  };
}

// ---------------------------------------------------------------------------------------------------
// The twenty graphs
// ---------------------------------------------------------------------------------------------------

const studio = graph({
  templateId: 'studio',
  nodes: [
    livingKitchen('livingkitchen1', 25, 21, { maxWidth: 8.5, maxDepth: 8.5, aspect: { min: 1, max: 2.2 } }),
    bathTub('bathroom1', 4.2, { maxWidth: 3.2, maxDepth: 4.4, aspect: { min: 1, max: 2.4 } }),
    entryNode(3.0, { maxWidth: 3.2, maxDepth: 4.4 }),
    laundry('laundry1', 1.4, 'bathroom1'),
    closet('closet1', 1.6, 'entry1'),
  ],
  rules: [
    R('entry1', 'livingkitchen1', 'door', 'ARC-18 entry opens into the living space'),
    R('entry1', 'bathroom1', 'door', 'ARC-19 bath off circulation, not off a habitable room'),
    R('bathroom1', 'livingkitchen1', 'no-door', 'ADG G/Part F: a WC must not open directly into a kitchen or food-prep space', UKIE),
    R('bathroom1', 'laundry1', 'share-edge', 'XD-01 wet rooms share one stack'),
  ],
  zoneOrder: [['circulation', 'service'], ['public']],
  maxStacks: 1,
});

const microStudio = graph({
  templateId: 'micro-studio',
  nodes: [
    livingKitchen('livingkitchen1', 17, 14, { maxWidth: 8.5, maxDepth: 8.5 }),
    bathTub('bathroom1', 3.7),
    entryNode(2.2),
    closet('closet1', 1.2, 'entry1'),
  ],
  zoneOrder: [['circulation', 'service'], ['public']],
});

const junior1b = graph({
  templateId: 'junior-1b',
  nodes: [
    livingKitchen('livingkitchen1', 22, 18),
    bedDouble('bedroom1', 11.8),
    bathTub('bathroom1', 4.2),
    entryNode(3.2),
    hallNode('hall1', 2.4),
    closet('closet1', 1.3, 'bedroom1'),
    closet('closet2', 1.3, 'entry1'),
    laundry('laundry1', 1.4, 'bathroom1'),
  ],
});

const oneBed = graph({
  templateId: '1b1b',
  nodes: [
    living(20, 16, 3.4, { maxWidth: 7.0, maxDepth: 7.0 }),
    kitchen(8.5, 6.5, { maxWidth: 6.0, maxDepth: 4.6 }),
    bedDouble('bedroom1', 13.0, { maxWidth: 4.8, maxDepth: 5.6 }),
    bathTub('bathroom1', 4.6),
    entryNode(3.6),
    hallNode('hall1', 2.8, { maxDepth: 2.8 }),
    laundry('laundry1', 1.6, 'kitchen1', 'laundry-stack'),
    closet('closet1', 1.4, 'bedroom1'),
    closet('closet2', 1.4, 'entry1'),
  ],
  rules: [
    R('entry1', 'hall1', 'door', 'ARC-18'),
    R('kitchen1', 'living1', 'share-edge', 'ARC-20 kitchen serves the living/dining'),
    R('kitchen1', 'living1', 'door', 'ARC-20'),
    R('hall1', 'bathroom1', 'door', 'ARC-19 bath off a hall'),
    R('hall1', 'bedroom1', 'door', 'ARC-19'),
    R('hall1', 'living1', 'door', 'ARC-19'),
    R('bedroom1', 'kitchen1', 'not-adjacent', 'ARC-19 a bedroom is not entered off a kitchen'),
    R('bathroom1', 'kitchen1', 'no-door', 'ARC-19'),
    R('bathroom1', 'living1', 'no-door', 'ADG G/Part F', UKIE),
    R('kitchen1', 'bathroom1', 'share-edge', 'XD-01 one wet wall, one stack'),
    R('kitchen1', 'laundry1', 'share-edge', 'XD-01'),
  ],
  maxStacks: 1,
});

const oneBedDen = graph({
  templateId: '1b-den',
  nodes: [
    living(21, 17, 3.6),
    kitchen(9.5, 7.0),
    bedDouble('bedroom1', 13.5),
    n('den1', 'den', [5.5, 7.5, amax(7.5)], [2.1, 2.4], 'desk', { band: 'service', stackable: true, mergeInto: { ref: 'living1', kit: 'desk' } }),
    bathTub('bathroom1', 4.6),
    entryNode(4.0),
    hallNode('hall1', 3.2),
    closet('closet1', 1.5, 'bedroom1'),
    closet('closet2', 1.5, 'entry1'),
    laundry('laundry1', 1.8, 'kitchen1'),
  ],
});

const twoBedOneBath = graph({
  templateId: '2b1b',
  nodes: [
    living(21, 17, 3.4),
    kitchen(9.0, 7.0),
    bedMaster(13.0),
    bedDouble('bedroom2', 11.8),
    bathTub('bathroom1', 4.6),
    entryNode(3.6),
    hallNode('hall1', 4.0),
    walkin(1.8, 'masterbedroom1'),
    closet('closet1', 1.4, 'bedroom2'),
    closet('closet2', 1.4, 'entry1'),
    laundry('laundry1', 1.6, 'kitchen1'),
  ],
});

const twoBedTwoBath = graph({
  templateId: '2b2b',
  nodes: [
    living(25, 19, 3.8, { maxWidth: 7.0, maxDepth: 7.0 }),
    kitchen(10.5, 7.5, { kit: 'kitchen-island' }),
    bedMaster(14.5, { maxWidth: 5.6, maxDepth: 6.2 }),
    bedDouble('bedroom2', 12.0),
    bathShower('ensuite1', 'ensuite', 4.4, 3.4),
    bathTub('bathroom1', 4.8),
    entryNode(4.2),
    hallNode('hall1', 4.4, { maxDepth: 2.8 }),
    walkin(2.6, 'masterbedroom1'),
    laundry('laundry1', 2.0, 'kitchen1'),
    closet('closet1', 1.5, 'entry1'),
    closet('closet2', 1.5, 'bedroom2'),
  ],
  rules: [
    R('entry1', 'hall1', 'door', 'ARC-18'),
    R('hall1', 'living1', 'door', 'ARC-19'),
    R('hall1', 'bathroom1', 'door', 'ARC-19'),
    R('hall1', 'masterbedroom1', 'door', 'ARC-19'),
    R('hall1', 'bedroom2', 'door', 'ARC-19'),
    R('masterbedroom1', 'ensuite1', 'door', 'ARC-21 en-suite opens off its bedroom'),
    R('masterbedroom1', 'walkincloset1', 'door', 'ARC-21'),
    R('kitchen1', 'living1', 'door', 'ARC-20'),
    R('kitchen1', 'living1', 'share-edge', 'ARC-20'),
    R('ensuite1', 'bathroom1', 'share-edge', 'XD-01 two baths on one stack'),
    R('kitchen1', 'bathroom1', 'share-edge', 'XD-01'),
    R('kitchen1', 'laundry1', 'share-edge', 'XD-01'),
    R('bathroom1', 'living1', 'no-door', 'ADG G/Part F', UKIE),
    R('bathroom1', 'kitchen1', 'no-door', 'ADG G/Part F'),
    R('bedroom2', 'living1', 'no-door', 'ARC-19 a bedroom is not a passage room'),
    R('bedroom2', 'kitchen1', 'not-adjacent', 'ARC-19 a bedroom is not entered off a kitchen'),
    R('masterbedroom1', 'kitchen1', 'not-adjacent', 'ARC-19'),
  ],
  maxStacks: 2,
});

const cornerTwoBed = graph({
  templateId: 'corner-2b2b',
  nodes: [
    living(27, 20, 4.0),
    kitchen(11.0, 7.5, { kit: 'kitchen-island' }),
    bedMaster(15.0),
    bedDouble('bedroom2', 12.5),
    bathShower('ensuite1', 'ensuite', 4.6, 3.4),
    bathTub('bathroom1', 4.8),
    entryNode(4.2),
    hallNode('hall1', 4.6),
    walkin(2.8, 'masterbedroom1'),
    laundry('laundry1', 2.0, 'kitchen1'),
    closet('closet1', 1.5, 'entry1'),
    closet('closet2', 1.5, 'bedroom2'),
  ],
  maxStacks: 2,
});

const threeBed = graph({
  templateId: '3b2b',
  nodes: [
    living(26, 21, 4.0),
    dining(10.0, 7.0, 2.7, { needsExterior: false, band: 'service' }),
    kitchen(12.0, 8.0, { kit: 'kitchen-island' }),
    bedMaster(15.0),
    bedDouble('bedroom2', 12.0),
    bedSingle('bedroom3', 9.5),
    bathShower('ensuite1', 'ensuite', 4.6, 3.4),
    bathTub('bathroom1', 5.0),
    entryNode(4.6),
    hallNode('hall1', 6.0),
    walkin(3.0, 'masterbedroom1'),
    laundry('laundry1', 2.4, 'kitchen1'),
    closet('closet1', 1.5, 'entry1'),
    closet('closet2', 1.5, 'bedroom2'),
    closet('closet3', 1.5, 'bedroom3'),
  ],
  extraRules: [
    R('dining1', 'kitchen1', 'share-edge', 'ARC-20 the kitchen serves the dining table across one wall'),
    R('dining1', 'living1', 'door', 'ARC-10'),
    R('dining1', 'kitchen1', 'door', 'ARC-20'),
  ],
  maxStacks: 2,
});

const fourBed = graph({
  templateId: '4b2b',
  nodes: [
    living(28, 22, 4.2),
    dining(11.0, 8.0, 2.8, { needsExterior: false, band: 'service' }),
    kitchen(13.0, 9.0, { kit: 'kitchen-island' }),
    bedMaster(16.0),
    bedDouble('bedroom2', 12.5),
    bedDouble('bedroom3', 12.5),
    bedSingle('bedroom4', 9.5),
    bathShower('ensuite1', 'ensuite', 5.0, 3.4),
    bathTub('bathroom1', 5.4),
    entryNode(5.0),
    hallNode('hall1', 8.0),
    walkin(3.2, 'masterbedroom1'),
    laundry('laundry1', 3.0, 'kitchen1', 'laundry-side'),
    closet('closet1', 1.6, 'entry1'),
    closet('closet2', 1.6, 'bedroom2'),
    closet('closet3', 1.6, 'bedroom3'),
  ],
  extraRules: [
    R('dining1', 'kitchen1', 'share-edge', 'ARC-20'),
    R('dining1', 'living1', 'door', 'ARC-10'),
    R('dining1', 'kitchen1', 'door', 'ARC-20'),
  ],
  maxStacks: 2,
});

/** Two dwellings behind one lockable vestibule: the main flat plus a lock-off studio (ARC-25). */
const dualKey = graph({
  templateId: 'dual-key',
  nodes: [
    living(22, 17, 3.4),
    kitchen(9.0, 6.5),
    bedMaster(13.0),
    bedDouble('bedroom2', 11.8),
    bathTub('bathroom1', 4.6),
    entryNode(4.4, { maxWidth: 3.2 }),
    hallNode('hall1', 3.4),
    closet('closet1', 1.4, 'bedroom2'),
    closet('closet2', 1.4, 'entry1'),
    laundry('laundry1', 1.6, 'kitchen1'),
    livingKitchen('livingkitchen2', 21, 17),
    bathShower('ensuite2', 'ensuite', 3.8, 3.2),
  ],
  extraRules: [
    R('entry1', 'livingkitchen2', 'door', 'ARC-25 the lock-off studio has its own lockable door off the shared vestibule'),
    R('livingkitchen2', 'ensuite2', 'door', 'ARC-25 the studio has its own bathroom'),
    R('livingkitchen2', 'bedroom2', 'not-adjacent', 'ARC-25 the two dwellings share no habitable wall'),
  ],
  maxStacks: 2,
});

const loft = graph({
  templateId: 'loft-live-work',
  nodes: [
    livingKitchen('livingkitchen1', 40, 30, { maxWidth: 8.5, maxDepth: 8.5 }),
    n('study1', 'study', [9, 14, amax(14)], [3.0, 2.6], 'desk', { band: 'daylit', needsExterior: true }),
    bathTub('bathroom1', 4.8),
    entryNode(3.4),
    storeNode('storage1', 3.2, 1.8, 'livingkitchen1'),
    closet('closet1', 1.6, 'entry1'),
    laundry('laundry1', 1.8, 'bathroom1'),
  ],
  zoneOrder: [['circulation', 'service'], ['private', 'public']],
});

const maisonette = graph({
  templateId: 'maisonette-2s',
  levels: 2,
  nodes: [
    entryNode(4.0, { level: 0 }),
    stairNode('stair1', 4.6, { level: 0 }),
    living(24, 19, 3.4, { level: 0 }),
    kitchen(11.0, 7.5, { level: 0, band: 'daylit', needsExterior: true }),
    wc2pc('wc1', 'wc', 2.2, { level: 0 }),
    storeNode('storage1', 2.4, 1.2, 'entry1', { level: 0 }),
    stairNode('stair2', 4.6, { level: 1 }),
    hallNode('hall2', 4.0, { level: 1 }),
    bedMaster(14.0, { level: 1 }),
    bedDouble('bedroom2', 11.8, { level: 1 }),
    bathTub('bathroom1', 5.0, { level: 1 }),
    closet('closet1', 1.5, 'masterbedroom1', { level: 1 }),
    closet('closet2', 1.5, 'bedroom2', { level: 1 }),
    laundry('laundry1', 1.8, 'bathroom1', 'laundry-stack', { level: 1 }),
  ],
  extraRules: [
    R('entry1', 'living1', 'door', 'ARC-10 street → threshold → front room'),
    R('kitchen1', 'wc1', 'share-edge', 'XD-01 the ground-floor wet rooms stack under the bathroom above'),
    R('kitchen1', 'bathroom1', 'share-edge', 'XD-01 wet rooms stack level to level'),
  ],
  zoneOrder: [['circulation', 'public'], ['public', 'service'], ['service']],
  maxStacks: 1,
});

const townhouse2s = graph({
  templateId: 'townhouse-2s',
  levels: 2,
  nodes: [
    entryNode(4.4, { level: 0, area: { min: 2.4, target: 4.4, max: 5.5 } }),
    stairNode('stair1', 4.8, { level: 0 }),
    living(25, 20, 3.4, { level: 0 }),
    kitchen(13.0, 8.5, { level: 0, band: 'daylit', needsExterior: true, kit: 'kitchen-galley-washer' }),
    dining(10.0, 7.0, 2.7, { level: 0 }),
    wc2pc('powder1', 'powder', 2.5, { level: 0 }),
    storeNode('storage1', 2.4, 1.2, 'entry1', { level: 0 }),
    stairNode('stair2', 4.8, { level: 1 }),
    hallNode('hall2', 5.0, { level: 1 }),
    bedMaster(15.0, { level: 1 }),
    bedDouble('bedroom2', 12.0, { level: 1 }),
    bedSingle('bedroom3', 9.5, { level: 1 }),
    bathTub('bathroom1', 5.2, { level: 1 }),
    laundry('laundry1', 2.4, 'bathroom1', 'laundry-stack', { level: 1 }),
    closet('closet1', 1.5, 'masterbedroom1', { level: 1 }),
    closet('closet2', 1.5, 'bedroom2', { level: 1 }),
    closet('closet3', 1.5, 'bedroom3', { level: 1 }),
  ],
  rules: [
    R('entry1', 'stair1', 'share-edge', 'ARC-22 one stair stacks on the party wall'),
    R('stair1', 'stair2', 'share-edge', 'ARC-22 identical footprint on every level'),
    R('entry1', 'living1', 'door', 'ARC-10 street → threshold → front room'),
    R('living1', 'dining1', 'door', 'ARC-10'),
    R('dining1', 'kitchen1', 'door', 'ARC-20'),
    R('entry1', 'powder1', 'door', 'ARC-19'),
    R('powder1', 'kitchen1', 'no-door', 'ADG G/Part F', UKIE),
    R('hall2', 'masterbedroom1', 'door', 'ARC-19'),
    R('hall2', 'bedroom2', 'door', 'ARC-19'),
    R('hall2', 'bedroom3', 'door', 'ARC-19'),
    R('hall2', 'bathroom1', 'door', 'ARC-19'),
    R('stair2', 'hall2', 'door', 'ARC-22 the stair lands in the circulation'),
    R('kitchen1', 'powder1', 'share-edge', 'XD-01'),
    R('bathroom1', 'kitchen1', 'share-edge', 'XD-01 wet rooms stack level to level'),
    R('bathroom1', 'laundry1', 'share-edge', 'XD-01'),
  ],
  zoneOrder: [['circulation', 'public'], ['public', 'service'], ['service']],
  maxStacks: 1,
});

const townhouse3s = graph({
  templateId: 'townhouse-3s',
  levels: 3,
  nodes: [
    entryNode(4.2, { level: 0 }),
    n('garage1', 'garage', [15.0, 19.0, 22.0], [3.0, 5.6], 'garage-1car', { level: 0, band: 'service' }),
    // a flex/hobby room, not a second living room: a desk kit, so the garage floor stays narrow
    n('flex1', 'flex', [7.5, 11.0, amax(11)], [2.4, 2.6], 'desk', { level: 0, band: 'daylit', needsExterior: true }),
    wc2pc('wc1', 'wc', 2.2, { level: 0 }),
    stairNode('stair1', 4.8, { level: 0 }),
    storeNode('storage1', 2.6, 1.2, 'entry1', { level: 0 }, 0.6),
    living(26, 20, 3.4, { level: 1 }),
    dining(10.0, 7.0, 2.7, { level: 1 }),
    kitchen(13.0, 8.5, { level: 1, band: 'daylit', needsExterior: true, kit: 'kitchen-galley-washer' }),
    wc2pc('powder1', 'powder', 2.4, { level: 1 }),
    hallNode('hall2', 3.0, { level: 1 }),
    stairNode('stair2', 4.8, { level: 1 }),
    bedMaster(15.0, { level: 2 }),
    bedDouble('bedroom2', 12.0, { level: 2 }),
    bedSingle('bedroom3', 10.0, { level: 2 }),
    bathTub('bathroom1', 5.2, { level: 2 }),
    hallNode('hall3', 5.0, { level: 2 }),
    stairNode('stair3', 4.8, { level: 2 }),
    laundry('laundry1', 2.4, 'bathroom1', 'laundry-stack', { level: 2 }),
    closet('closet1', 1.5, 'masterbedroom1', { level: 2 }),
    closet('closet2', 1.5, 'bedroom2', { level: 2 }),
    closet('closet3', 1.5, 'bedroom3', { level: 2 }),
  ],
  extraRules: [
    R('entry1', 'garage1', 'door', 'ARC-10 the garage is entered from the threshold, not from a habitable room'),
    R('garage1', 'flex1', 'not-adjacent', 'ARC-10 a habitable room does not open off a garage'),
    R('kitchen1', 'powder1', 'share-edge', 'XD-01'),
    R('wc1', 'bathroom1', 'share-edge', 'XD-01 wet rooms stack level to level'),
  ],
  zoneOrder: [['circulation', 'service'], ['public', 'service'], ['private']],
  maxStacks: 1,
});

const ranch = graph({
  templateId: 'ranch-3b',
  nodes: [
    living(30, 22, 4.2),
    dining(12.0, 8.0, 2.8, { needsExterior: false, band: 'service' }),
    kitchen(15.0, 9.5, { kit: 'kitchen-island' }),
    bedMaster(15.5),
    bedDouble('bedroom2', 12.0),
    bedDouble('bedroom3', 11.5),
    bathShower('ensuite1', 'ensuite', 5.2, 3.4),
    bathTub('bathroom1', 5.4),
    entryNode(5.5),
    hallNode('hall1', 6.5),
    walkin(3.2, 'masterbedroom1'),
    laundry('laundry1', 4.0, 'kitchen1', 'laundry-side', { area: { min: 2.4, target: 4.0, max: 5.0 } }),
    storeNode('storage1', 3.0, 1.5, 'entry1'),
    closet('closet1', 1.6, 'entry1'),
    closet('closet2', 1.6, 'bedroom2'),
    closet('closet3', 1.6, 'bedroom3'),
  ],
  extraRules: [
    R('dining1', 'kitchen1', 'share-edge', 'ARC-20'),
    R('dining1', 'living1', 'door', 'ARC-10'),
    R('dining1', 'kitchen1', 'door', 'ARC-20'),
  ],
  maxStacks: 2,
});

const colonial = graph({
  templateId: 'colonial-4b',
  levels: 2,
  nodes: [
    entryNode(8.0, { level: 0, maxWidth: 4.0 }),
    stairNode('stair1', 5.2, { level: 0 }),
    living(28, 22, 4.2, { level: 0 }),
    dining(15.0, 10.0, 3.0, { level: 0 }),
    kitchen(18.0, 11.0, { level: 0, band: 'daylit', needsExterior: true, kit: 'kitchen-island' }),
    n('study1', 'study', [8.0, 12.0, amax(12)], [2.8, 2.6], 'desk', { level: 0, band: 'daylit', needsExterior: true }),
    wc2pc('powder1', 'powder', 2.6, { level: 0 }),
    storeNode('storage1', 3.0, 1.5, 'entry1', { level: 0 }),
    stairNode('stair2', 5.2, { level: 1 }),
    hallNode('hall2', 8.0, { level: 1 }),
    bedMaster(18.0, { level: 1 }),
    bedDouble('bedroom2', 13.0, { level: 1 }),
    bedDouble('bedroom3', 12.0, { level: 1 }),
    bedSingle('bedroom4', 11.0, { level: 1 }),
    bathShower('ensuite1', 'ensuite', 6.5, 3.4, { level: 1 }),
    bathTub('bathroom1', 6.0, { level: 1 }),
    walkin(4.5, 'masterbedroom1', { level: 1, area: { min: 2.0, target: 4.5, max: 5.6 }, maxWidth: 3.0 }),
    laundry('laundry1', 4.5, 'bathroom1', 'laundry-side', { level: 1, area: { min: 2.4, target: 4.5, max: 5.6 } }),
    closet('closet1', 1.6, 'bedroom2', { level: 1 }),
    closet('closet2', 1.6, 'bedroom3', { level: 1 }),
    closet('closet3', 1.6, 'bedroom4', { level: 1 }),
  ],
  extraRules: [
    R('entry1', 'living1', 'door', 'ARC-10 street → threshold → front room'),
    R('dining1', 'kitchen1', 'share-edge', 'ARC-20'),
    R('dining1', 'kitchen1', 'door', 'ARC-20'),
    R('powder1', 'kitchen1', 'no-door', 'ADG G/Part F', UKIE),
    R('bathroom1', 'kitchen1', 'share-edge', 'XD-01 wet rooms stack level to level'),
  ],
  zoneOrder: [['circulation', 'public'], ['public', 'service'], ['private']],
  maxStacks: 2,
});

const adu = graph({
  templateId: 'adu-1b',
  nodes: [
    livingKitchen('livingkitchen1', 22, 17),
    bedDouble('bedroom1', 12.0),
    bathTub('bathroom1', 4.6),
    entryNode(2.6),
    n('utility1', 'utility', [1.2, 2.2, 2.8], [0.9, 0.7], 'laundry-stack', { stackable: true, mergeInto: { ref: 'bathroom1', kit: 'laundry-stack' } }),
    closet('closet1', 1.4, 'bedroom1'),
    closet('closet2', 1.4, 'entry1'),
  ],
});

/** Six en-suite rooms off a corridor with a shared hearth (ARC-24, Alexander APL #75/#129). */
const coliving = graph({
  templateId: 'coliving-cluster',
  nodes: [
    ...[1, 2, 3, 4, 5, 6].map(i => bedDouble(`bedroom${i}`, 13.5, { area: { min: 12.0, target: 13.5, max: 17.0 } })),
    ...[1, 2, 3, 4, 5, 6].map(i => bathShower(`ensuite${i}`, 'ensuite', 3.9, 3.2)),
    n('sharedliving1', 'shared-living', [20, 26, 32], [3.8, 3.2], 'shared-living', { band: 'daylit', needsExterior: true }),
    n('sharedkitchen1', 'shared-kitchen', [12, 16, 20], [3.0, 2.4], 'shared-kitchen', { band: 'daylit', needsExterior: false }),
    entryNode(4.0),
    n('corridor1', 'corridor', [10.0, 18.0, 24.0], [1.2, 1.2], 'none', { band: 'circulation', maxDepth: 2.8 }),
    laundry('laundry1', 4.0, 'sharedkitchen1', 'laundry-side', { area: { min: 2.4, target: 4.0, max: 5.0 } }),
    storeNode('storage1', 3.5, 1.8, 'corridor1'),
  ],
  extraRules: [
    ...[1, 2, 3, 4, 5, 6].map(i => R(`bedroom${i}`, `ensuite${i}`, 'door', 'ARC-24 every room has its own en-suite')),
    ...[1, 2, 3, 4, 5, 6].map(i => R('corridor1', `bedroom${i}`, 'door', 'ARC-24 rooms open off the internal corridor')),
    R('entry1', 'corridor1', 'door', 'ARC-18'),
    R('corridor1', 'sharedliving1', 'door', 'ARC-24 the shared hearth is the destination, not a passage'),
    R('corridor1', 'sharedkitchen1', 'door', 'ARC-20 the shared kitchen opens off the corridor head, across from the hearth'),
  ],
  zoneOrder: [['circulation', 'public'], ['private'], ['circulation'], ['private']],
  maxStacks: 2,
});

const senior = graph({
  templateId: 'senior-1b-accessible',
  nodes: [
    living(22, 18, 3.6),
    kitchen(10.5, 8.5, { kit: 'kitchen-accessible' }),
    bedDouble('bedroom1', 14.0, { area: { min: 11.5, target: 14.0, max: 17.5 } }),
    n('bathroom1', 'bathroom', [5.0, 6.5, 8.1], [2.2, 2.6], 'bath-accessible'),
    entryNode(4.5, { maxWidth: 3.2 }),
    hallNode('hall1', 3.6, { minWidth: 1.2 }),
    walkin(3.0, 'bedroom1', { area: { min: 1.8, target: 3.0, max: 3.8 } }),
    closet('closet1', 1.4, 'entry1'),
    laundry('laundry1', 2.5, 'kitchen1', 'laundry-side', { area: { min: 1.2, target: 2.5, max: 3.2 } }),
  ],
});

// ---------------------------------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------------------------------

export const PROGRAMS: Record<UnitTemplateId, ProgramGraph> = {
  studio,
  'micro-studio': microStudio,
  'junior-1b': junior1b,
  '1b1b': oneBed,
  '1b-den': oneBedDen,
  '2b1b': twoBedOneBath,
  '2b2b': twoBedTwoBath,
  'corner-2b2b': cornerTwoBed,
  '3b2b': threeBed,
  '4b2b': fourBed,
  'dual-key': dualKey,
  'loft-live-work': loft,
  'maisonette-2s': maisonette,
  'townhouse-2s': townhouse2s,
  'townhouse-3s': townhouse3s,
  'ranch-3b': ranch,
  'colonial-4b': colonial,
  'adu-1b': adu,
  'coliving-cluster': coliving,
  'senior-1b-accessible': senior,
};

export const ALL_PROGRAMS: ProgramGraph[] = Object.keys(PROGRAMS)
  .sort()
  .map(k => PROGRAMS[k as UnitTemplateId]);

export function programFor(templateId: UnitTemplateId): ProgramGraph {
  const g = PROGRAMS[templateId];
  if (!g) throw new Error(`no program graph for template ${templateId}`);
  return g;
}

export function programById(id: string): ProgramGraph | undefined {
  return ALL_PROGRAMS.find(g => g.id === id);
}

/** Nodes belonging to one level, in declaration order. */
export function nodesAtLevel(g: ProgramGraph, level: number): ProgramNode[] {
  return g.nodes.filter(x => x.level === level);
}

/** Rules that apply in `region` (a rule with no `regions` applies everywhere). */
export function rulesFor(g: ProgramGraph, region: Region): AdjacencyRule[] {
  return g.rules.filter(r => !r.regions || r.regions.includes(region));
}
