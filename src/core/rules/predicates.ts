/**
 * The closed predicate vocabulary.
 *
 * A rule is data; a predicate is the only code a rule may run. Custom rules (`spec.rules.custom`) can compose these
 * and nothing else, which is what makes user rules safe, serialisable and checkable in the UI: the signature table
 * below tells the form which subjects, objects and limit types each predicate accepts.
 *
 * Conventions read by every predicate:
 *   limit   `rule.params.limit.value`, or `params.value` / `params.min` / `params.max` when that is what the rule has;
 *   op      `rule.params.op.value` ('>=' default) — how `observed` is compared with `limit`;
 *   object  `rule.predicate.args[0]` (a room type, an element kind or a system), when the signature declares one.
 *
 * A predicate that cannot be evaluated — the discipline that produces its data has not run, or the subject carries
 * no geometry — returns `ok: true` with a `detail`. "Not applicable" is never a violation.
 */
import type { ModelElement, Rect, RoomDef, Vec2, WallDef } from '../types.ts';
import type {
  LimitOp, Predicate, PredicateId, PredicateResult, PredicateSignature, Rule, Subject, SubjectKind, World,
} from './types.ts';
import type { Box3 } from '../kernel/types.ts';
import { boxesOfElement, boxesOverlap, createBoxIndex, elementKindOf } from '../kernel/validate.ts';
import { HANGERS, SLOPES, hangerFor, slopeFor, trapArmLimit } from '../kernel/clearances.ts';
import { swingRect } from '../openings.ts';

const OK: PredicateResult = { ok: true };
const NA = (detail: string): PredicateResult => ({ ok: true, detail });

// ---------------------------------------------------------------------------------------------------------------
// Parameter access
// ---------------------------------------------------------------------------------------------------------------

export function limitOf(rule: Rule): number | string | boolean {
  const p = rule.params;
  const named = p.limit ?? p.value ?? p.min ?? p.max ?? p.tolerance;
  if (named) return named.value;
  const keys = Object.keys(p).sort();
  return keys.length > 0 ? p[keys[0]].value : 0;
}
export function numLimit(rule: Rule, fallback = 0): number {
  const v = limitOf(rule);
  return typeof v === 'number' ? v : fallback;
}
export function opOf(rule: Rule): LimitOp {
  const v = rule.params.op?.value;
  return v === '<=' || v === '==' || v === '!=' || v === '>=' ? v : '>=';
}
export function argOf(rule: Rule, i = 0): string | null {
  const a = rule.predicate?.args?.[i];
  return typeof a === 'string' ? a : null;
}
export function cmp(op: LimitOp, observed: number, limit: number, eps = 1e-6): boolean {
  if (op === '>=') return observed >= limit - eps;
  if (op === '<=') return observed <= limit + eps;
  if (op === '==') return Math.abs(observed - limit) <= eps;
  return Math.abs(observed - limit) > eps;
}
function cmpBool(op: LimitOp, observed: boolean, limit: boolean): boolean {
  if (op === '!=') return observed !== limit;
  return observed === limit;
}
function boolLimit(rule: Rule, fallback = true): boolean {
  const v = limitOf(rule);
  return typeof v === 'boolean' ? v : fallback;
}

// ---------------------------------------------------------------------------------------------------------------
// Subject geometry
// ---------------------------------------------------------------------------------------------------------------

function rectOf(s: Subject): Rect | null {
  if (s.kind === 'room') return s.room.rect;
  if (s.kind === 'unit') return s.unit.rect;
  if (s.kind === 'corridor') {
    const poly = s.corridor.polygon;
    if (poly.length === 0) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of poly) {
      minX = Math.min(minX, p[0]);
      maxX = Math.max(maxX, p[0]);
      minY = Math.min(minY, p[1]);
      maxY = Math.max(maxY, p[1]);
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
  return null;
}

function areaOf(s: Subject): number | null {
  if (s.kind === 'room') return s.room.area;
  if (s.kind === 'unit') return s.unit.area;
  if (s.kind === 'floor') return s.floor.area;
  const r = rectOf(s);
  return r ? r.w * r.h : null;
}

function centreOf(s: Subject): Vec2 | null {
  const r = rectOf(s);
  if (r) return [r.x + r.w / 2, r.y + r.h / 2];
  if (s.kind === 'element') {
    const b = boxesOfElement(s.element)[0];
    return b ? [b.x + b.w / 2, b.y + b.d / 2] : null;
  }
  if (s.kind === 'run' && s.path.length > 0) return [s.path[0][0], s.path[0][1]];
  if (s.kind === 'support') return s.support.xy;
  return null;
}

function storeyOf(s: Subject): string | null {
  if (s.kind === 'room') return s.room.storey;
  if (s.kind === 'unit') return s.unit.storeys[0] ?? null;
  if (s.kind === 'floor') return s.floor.storey;
  if (s.kind === 'door') return s.door.storey;
  if (s.kind === 'corridor') return s.corridor.storey;
  if (s.kind === 'element') return s.element.storey;
  if (s.kind === 'run') return s.storey;
  if (s.kind === 'support') return s.support.storey;
  return null;
}

function pathLength(path: readonly [number, number, number][]): number {
  let l = 0;
  for (let i = 1; i < path.length; i++) {
    l += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1], path[i][2] - path[i - 1][2]);
  }
  return l;
}

// ---------------------------------------------------------------------------------------------------------------
// Per-world memoised indices (content-derived, so determinism is unaffected)
// ---------------------------------------------------------------------------------------------------------------

interface KindGrid {
  index: ReturnType<typeof createBoxIndex>;
  items: { box: Box3; e: ModelElement }[];
}

interface WorldCache {
  byKind: Map<string, ModelElement[]>;
  roomsByType: Map<string, RoomDef[]>;
  unitRooms: Map<string, RoomDef[]>;
  wallById: Map<string, WallDef>;
  /** `${kind}|${storey}` → a 2 m XY grid, built on first use. Without it `clearance` and `notOver` are O(n²). */
  grids: Map<string, KindGrid>;
}
const CACHE = new WeakMap<World, WorldCache>();

function cacheOf(w: World): WorldCache {
  const hit = CACHE.get(w);
  if (hit) return hit;
  const byKind = new Map<string, ModelElement[]>();
  for (const e of w.elementById.values()) {
    const k = elementKindOf(e);
    if (!k) continue;
    const list = byKind.get(k);
    if (list) list.push(e);
    else byKind.set(k, [e]);
  }
  const roomsByType = new Map<string, RoomDef[]>();
  const unitRooms = new Map<string, RoomDef[]>();
  for (const r of w.roomById.values()) {
    const t = roomsByType.get(r.type);
    if (t) t.push(r);
    else roomsByType.set(r.type, [r]);
    if (r.unitId) {
      const u = unitRooms.get(r.unitId);
      if (u) u.push(r);
      else unitRooms.set(r.unitId, [r]);
    }
  }
  for (const list of roomsByType.values()) list.sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const list of unitRooms.values()) list.sort((a, b) => (a.id < b.id ? -1 : 1));
  const wallById = new Map<string, WallDef>();
  for (const wall of w.arch?.walls ?? []) wallById.set(wall.id, wall);
  const cache: WorldCache = { byKind, roomsByType, unitRooms, wallById, grids: new Map() };
  CACHE.set(w, cache);
  return cache;
}

/**
 * Candidates of one kind on one storey, indexed in a 2 m XY grid. `clearance`, `notOver` and `withinDistance` query
 * the grid with their own box grown by the limit they are testing, so a predicate that used to scan every element
 * of the object kind now touches a handful — which is what keeps the post-check inside its millisecond budget on a
 * 67 000-element model.
 */
function gridFor(w: World, kind: string, storey: string): KindGrid {
  const cache = cacheOf(w);
  const key = `${kind}|${storey}`;
  const hit = cache.grids.get(key);
  if (hit) return hit;
  const grid: KindGrid = { index: createBoxIndex(), items: [] };
  // Sorted by id so "the first element over me" is a deterministic answer; sorting here rather than over the whole
  // kind list keeps the sort proportional to what is actually queried.
  const onStorey = (cache.byKind.get(kind) ?? []).filter(e => e.storey === storey).sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const e of onStorey) {
    const box = boxesOfElement(e)[0];
    if (!box) continue;
    grid.index.insert(box, grid.items.length);
    grid.items.push({ box, e });
  }
  cache.grids.set(key, grid);
  return grid;
}

/** Below this many candidates it is cheaper to walk the list than to walk the cells a long run touches. */
const CANDIDATE_WALK_MAX = 48;

function grow(b: Box3, by: number): Box3 {
  return { x: b.x - by, y: b.y - by, z: b.z - by, w: b.w + 2 * by, d: b.d + 2 * by, h: b.h + 2 * by };
}

function elementsOfKind(w: World, kind: string): readonly ModelElement[] {
  return cacheOf(w).byKind.get(kind) ?? [];
}

// ---------------------------------------------------------------------------------------------------------------
// The predicates
// ---------------------------------------------------------------------------------------------------------------

const minDim: Predicate = (w, rule, s) => {
  const r = rectOf(s);
  if (!r) return NA('subject has no rectangle');
  const observed = Math.min(r.w, r.h);
  return { ok: cmp(opOf(rule), observed, numLimit(rule)), observed: round(observed), limit: numLimit(rule) };
};

const minArea: Predicate = (w, rule, s) => {
  const a = areaOf(s);
  if (a === null) return NA('subject has no area');
  return { ok: cmp('>=', a, numLimit(rule)), observed: round(a), limit: numLimit(rule) };
};

const maxArea: Predicate = (w, rule, s) => {
  const a = areaOf(s);
  if (a === null) return NA('subject has no area');
  return { ok: cmp('<=', a, numLimit(rule)), observed: round(a), limit: numLimit(rule) };
};

const aspect: Predicate = (w, rule, s) => {
  const r = rectOf(s);
  if (!r || r.w <= 0 || r.h <= 0) return NA('subject has no rectangle');
  const observed = Math.max(r.w, r.h) / Math.min(r.w, r.h);
  return { ok: cmp('<=', observed, numLimit(rule, 3)), observed: round(observed), limit: numLimit(rule, 3) };
};

const adjacent: Predicate = (w, rule, s) => {
  if (s.kind !== 'room') return NA('adjacent applies to rooms');
  const want = argOf(rule);
  if (!want) return NA('no object room type');
  const hit = w.graph.adjacent(s.room.id).some(id => w.roomById.get(id)?.type === want);
  return { ok: cmpBool(opOf(rule), hit, boolLimit(rule)), observed: hit ? 'yes' : 'no', limit: want };
};

const connected: Predicate = (w, rule, s) => {
  if (s.kind !== 'room') return NA('connected applies to rooms');
  const want = argOf(rule);
  if (!want) return NA('no object room type');
  const hit = w.graph.connected(s.room.id).some(id => w.roomById.get(id)?.type === want);
  return { ok: cmpBool(opOf(rule), hit, boolLimit(rule)), observed: hit ? 'yes' : 'no', limit: want };
};

const notThrough: Predicate = (w, rule, s) => {
  if (s.kind !== 'room') return NA('notThrough applies to rooms');
  const from = argOf(rule, 0);
  const to = argOf(rule, 1);
  if (!from || !to) return NA('notThrough needs two room types');
  const rooms = s.room.unitId ? (cacheOf(w).unitRooms.get(s.room.unitId) ?? []) : [];
  const a = rooms.find(r => r.type === from);
  const b = rooms.find(r => r.type === to);
  if (!a || !b) return NA(`${from} or ${to} not present`);
  const through = w.graph.through(a.id, b.id);
  const hit = through.includes(s.room.id);
  return { ok: !hit, observed: hit ? `${from} → ${s.room.type} → ${to}` : 'no', limit: `${from} → ${to}` };
};

const exterior: Predicate = (w, rule, s) => {
  if (s.kind === 'room') {
    const want = boolLimit(rule);
    return { ok: cmpBool(opOf(rule), s.room.hasExterior, want), observed: s.room.hasExterior ? 'yes' : 'no', limit: want ? 'yes' : 'no' };
  }
  if (s.kind === 'unit') {
    const rooms = cacheOf(w).unitRooms.get(s.unit.id) ?? [];
    const hit = rooms.some(r => r.hasExterior);
    return { ok: hit, observed: hit ? 'yes' : 'no', limit: 'yes' };
  }
  return NA('exterior applies to rooms and units');
};

const daylight: Predicate = (w, rule, s) => {
  if (s.kind !== 'room') return NA('daylight applies to rooms');
  const windows = s.room.windowIds.length;
  if (!s.room.hasExterior && windows === 0) {
    return { ok: false, observed: 0, limit: numLimit(rule, 1), detail: 'no exterior wall and no window' };
  }
  return { ok: cmp('>=', windows, numLimit(rule, 1)), observed: windows, limit: numLimit(rule, 1) };
};

const withinDistance: Predicate = (w, rule, s) => {
  const from = centreOf(s);
  if (!from) return NA('subject has no position');
  const want = argOf(rule);
  const limit = numLimit(rule, 10);
  if (!want) return NA('no object');
  const candidates = cacheOf(w).roomsByType.get(want);
  let best = Infinity;
  if (candidates && candidates.length > 0) {
    for (const r of candidates) best = Math.min(best, Math.hypot(r.rect.x + r.rect.w / 2 - from[0], r.rect.y + r.rect.h / 2 - from[1]));
  } else {
    const storey = storeyOf(s);
    const probe: Box3 = { x: from[0] - limit, y: from[1] - limit, z: -100, w: 2 * limit, d: 2 * limit, h: 200 };
    const grid = storey ? gridFor(w, want, storey) : null;
    if (grid) {
      grid.index.forEach(probe, idx => {
        const b = grid.items[idx].box;
        const d = Math.hypot(b.x + b.w / 2 - from[0], b.y + b.d / 2 - from[1]);
        if (d < best) best = d;
      });
    }
  }
  if (!Number.isFinite(best)) return NA(`no ${want} in the model`);
  return { ok: cmp('<=', best, limit), observed: round(best), limit };
};

const clearance: Predicate = (w, rule, s) => {
  if (s.kind !== 'element') return NA('clearance applies to elements');
  const want = argOf(rule);
  const limit = numLimit(rule, 0.05);
  if (!want) return NA('no object kind');
  const mine = boxesOfElement(s.element)[0];
  if (!mine) return NA('element has no box');
  const grid = gridFor(w, want, s.element.storey);
  if (grid.items.length === 0) return { ok: true, observed: 'clear', limit, detail: `no ${want} on ${s.element.storey}` };
  let best = Infinity;
  const subjectId = s.element.id;
  const gap = (b: Box3): number => {
    const dx = Math.max(0, Math.max(b.x - (mine.x + mine.w), mine.x - (b.x + b.w)));
    const dy = Math.max(0, Math.max(b.y - (mine.y + mine.d), mine.y - (b.y + b.d)));
    const dz = Math.max(0, Math.max(b.z - (mine.z + mine.h), mine.z - (b.z + b.h)));
    return Math.hypot(dx, dy, dz);
  };
  if (grid.items.length <= CANDIDATE_WALK_MAX) {
    for (const item of grid.items) {
      if (item.e.id === subjectId) continue;
      const d = gap(item.box);
      if (d < best) best = d;
      if (best <= 0) break;
    }
  } else {
    grid.index.forEach(grow(mine, limit), idx => {
      const item = grid.items[idx];
      if (item.e.id === subjectId) return;
      const d = gap(item.box);
      if (d < best) best = d;
      if (best <= 0) return false;
    });
  }
  // Nothing of that kind within the limit is a pass, not an unknown: the clearance is satisfied by absence.
  if (!Number.isFinite(best)) return { ok: true, observed: 'clear', limit };
  return { ok: cmp('>=', best, limit), observed: round(best), limit };
};

const notOver: Predicate = (w, rule, s) => {
  if (s.kind !== 'element') return NA('notOver applies to elements');
  const want = argOf(rule);
  if (!want) return NA('no object kind');
  const mine = boxesOfElement(s.element)[0];
  if (!mine) return NA('element has no box');
  const grid = gridFor(w, want, s.element.storey);
  if (grid.items.length === 0) return OK;
  const subjectId = s.element.id;
  const above = (b: Box3): boolean =>
    mine.z >= b.z && mine.x + mine.w > b.x && b.x + b.w > mine.x && mine.y + mine.d > b.y && b.y + b.d > mine.y;
  let hit: ModelElement | null = null;
  // A duct 30 m long touches fifteen grid cells; a plant room holds two pieces of switchgear. Walk whichever side
  // is shorter — that is the difference between a 20 ms post-check and a 900 ms one.
  if (grid.items.length <= CANDIDATE_WALK_MAX) {
    for (const item of grid.items) {
      if (item.e.id === subjectId) continue;
      if (above(item.box)) {
        hit = item.e;
        break;
      }
    }
  } else {
    grid.index.forEach(mine, idx => {
      const item = grid.items[idx];
      if (item.e.id === subjectId) return;
      if (above(item.box)) {
        hit = item.e;
        return false;
      }
    });
  }
  const over = hit as ModelElement | null;
  if (over) return { ok: false, observed: over.id, limit: want, detail: `${subjectId} passes over ${over.id}` };
  return OK;
};

const band: Predicate = (w, rule, s) => {
  if (!w.kernel) return NA('no kernel');
  if (s.kind !== 'element') return NA('band applies to elements');
  const kind = elementKindOf(s.element);
  if (!kind) return NA('unclassified element');
  const boxes = boxesOfElement(s.element);
  if (boxes.length === 0) return NA('element has no box');
  const profile = w.kernel.profileOf(s.element.storey);
  const purposeArg = argOf(rule);
  const b = purposeArg ? profile.band(purposeArg as never) : null;
  const target = b ?? profile.bands.find(x => !x.dropped && x.allows.includes(kind)) ?? null;
  if (!target) return { ok: false, observed: kind, limit: purposeArg ?? 'any band', detail: `no band on ${s.element.storey} allows ${kind}` };
  const box = boxes[0];
  const ok = box.z >= target.z0 - 0.02 && box.z + box.h <= target.z1 + 0.02;
  return { ok, observed: round(box.z), limit: round(target.z0), detail: ok ? undefined : `outside ${target.id}` };
};

const laneP: Predicate = (w, rule, s) => {
  if (!w.kernel) return NA('no kernel');
  if (s.kind !== 'element') return NA('lane applies to elements');
  const laneId = argOf(rule);
  if (!laneId) return NA('no lane id');
  const lane = w.kernel.laneOf(s.element.storey, laneId);
  if (!lane) return NA(`no lane ${laneId} on ${s.element.storey}`);
  const reservations = w.kernel.reservationsOn(s.element.storey, s.element.discipline);
  const boxes = boxesOfElement(s.element);
  if (boxes.length === 0) return NA('element has no box');
  const inside = reservations.some(r => r.boxes.some(rb => boxesOverlap(boxes[0], rb, 1e-4)));
  return { ok: inside, observed: inside ? laneId : 'none', limit: laneId };
};

const inReservation: Predicate = (w, rule, s) => {
  if (!w.kernel) return NA('no kernel');
  if (s.kind !== 'element') return NA('inReservation applies to elements');
  const boxes = boxesOfElement(s.element);
  if (boxes.length === 0) return NA('element has no box');
  const reservations = w.kernel.reservationsOn(s.element.storey, s.element.discipline);
  const ok = reservations.some(r => r.container !== 'keepout' && r.boxes.some(rb => boxesOverlap(boxes[0], rb, 1e-4)));
  return { ok, observed: ok ? 'yes' : 'no', limit: 'yes' };
};

const maxRun: Predicate = (w, rule, s) => {
  const limit = numLimit(rule, 45);
  if (s.kind === 'run') {
    const l = pathLength(s.path as readonly [number, number, number][]);
    return { ok: cmp('<=', l, limit), observed: round(l), limit };
  }
  if (s.kind === 'corridor') {
    let l = 0;
    for (const seg of s.corridor.centerline) l += Math.hypot(seg.b[0] - seg.a[0], seg.b[1] - seg.a[1]);
    return { ok: cmp('<=', l, limit), observed: round(l), limit };
  }
  return NA('maxRun applies to runs and corridors');
};

const deadEnd: Predicate = (w, rule, s) => {
  const graph = w.site.massing.corridorGraph;
  if (!graph) return NA('no corridor graph');
  const limit = numLimit(rule, 6);
  if (s.kind !== 'corridor') return NA('deadEnd applies to corridors');
  let worst = 0;
  for (const d of graph.deadEnds ?? []) worst = Math.max(worst, d.length);
  return { ok: cmp('<=', worst, limit), observed: round(worst), limit };
};

const egressTravel: Predicate = (w, rule, s) => {
  const limit = numLimit(rule, 61);
  const from = centreOf(s);
  if (!from) return NA('subject has no position');
  const cores = w.arch?.cores ?? [];
  if (cores.length === 0) return NA('no cores');
  let best = Infinity;
  for (const c of cores) {
    const d = Math.abs(c.rect.x + c.rect.w / 2 - from[0]) + Math.abs(c.rect.y + c.rect.h / 2 - from[1]);
    best = Math.min(best, d);
  }
  return { ok: cmp('<=', best, limit), observed: round(best), limit };
};

const supported: Predicate = (w, rule, s) => {
  if (s.kind === 'support') {
    return { ok: true, observed: s.support.kind, detail: 'load path is checked by checkLoadPath' };
  }
  if (s.kind !== 'element') return NA('supported applies to elements');
  if (!w.kernel) return NA('no kernel');
  const kind = elementKindOf(s.element);
  if (!kind) return NA('unclassified element');
  const spec = hangerFor(kind) ?? HANGERS[kind];
  if (!spec) return NA(`no hanger rule for ${kind}`);
  const boxes = boxesOfElement(s.element);
  if (boxes.length === 0) return NA('element has no box');
  const profile = w.kernel.profileOf(s.element.storey);
  const drop = profile.soffitZ - (boxes[0].z + boxes[0].h);
  const limit = numLimit(rule, spec.maxDrop);
  return { ok: cmp('<=', drop, limit), observed: round(drop), limit, detail: spec.source };
};

const slope: Predicate = (w, rule, s) => {
  if (s.kind !== 'run') return NA('slope applies to runs');
  if (s.path.length < 2) return NA('run has no path');
  const min = numLimit(rule, slopeFor('sanitary', s.diameter, w.spec.region));
  let worst = Infinity;
  let rises = false;
  for (let i = 1; i < s.path.length; i++) {
    const a = s.path[i - 1];
    const b = s.path[i];
    const plan = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (plan < 0.3) continue;
    const fall = (a[2] - b[2]) / plan;
    if (fall < -1e-6) rises = true;
    worst = Math.min(worst, fall);
  }
  if (!Number.isFinite(worst)) return NA('run has no horizontal leg');
  if (rises) return { ok: false, observed: round(worst, 5), limit: round(min, 5), detail: 'the run rises in the direction of flow' };
  return { ok: worst >= min - 1e-6 && worst <= SLOPES.maxGravity.slope + 1e-6, observed: round(worst, 5), limit: round(min, 5) };
};

const continuous: Predicate = (w, rule, s) => {
  if (s.kind !== 'run') return NA('continuous applies to runs');
  if (s.path.length < 2) return NA('run has no path');
  let gaps = 0;
  for (let i = 1; i < s.path.length; i++) {
    const a = s.path[i - 1];
    const b = s.path[i];
    if (Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) > numLimit(rule, 6)) gaps += 1;
  }
  return { ok: gaps === 0, observed: gaps, limit: 0 };
};

const reaches: Predicate = (w, rule, s) => {
  if (s.kind !== 'run') return NA('reaches applies to runs');
  const want = argOf(rule);
  if (!want) return NA('no target');
  if (s.path.length === 0) return NA('run has no path');
  const end = s.path[s.path.length - 1];
  let best = Infinity;
  for (const e of elementsOfKind(w, want)) {
    const b = boxesOfElement(e)[0];
    if (!b) continue;
    best = Math.min(best, Math.hypot(b.x + b.w / 2 - end[0], b.y + b.d / 2 - end[1]));
  }
  if (!Number.isFinite(best)) return NA(`no ${want} in the model`);
  const limit = numLimit(rule, 1.0);
  return { ok: cmp('<=', best, limit), observed: round(best), limit };
};

const clearHeight: Predicate = (w, rule, s) => {
  const limit = numLimit(rule, 2.1);
  if (s.kind === 'room') {
    return { ok: cmp('>=', s.room.height, limit), observed: round(s.room.height), limit };
  }
  if (s.kind === 'floor') {
    // A roof, a plant deck or a car park has no ceiling to measure: the profile's clear zone governs there, and the
    // elements in it are checked one by one (XD-08), not through the floor's ceiling height.
    if (s.floor.ceilingHeight <= 0.1) return NA('no ceiling on this floor');
    return { ok: cmp('>=', s.floor.ceilingHeight, limit), observed: round(s.floor.ceilingHeight), limit };
  }
  if (s.kind === 'corridor') {
    // A corridor's clear height is its room's: the ceiling profile resolves it, the room records it.
    const room = w.roomById.get(s.corridor.roomId);
    if (!room) return NA('corridor has no room');
    return { ok: cmp('>=', room.height, limit), observed: round(room.height), limit };
  }
  if (s.kind === 'element' && w.kernel) {
    const profile = w.kernel.profileOf(s.element.storey);
    const boxes = boxesOfElement(s.element);
    if (boxes.length === 0) return NA('element has no box');
    return { ok: cmp('>=', boxes[0].z, limit), observed: round(boxes[0].z), limit, detail: `clear zone up to ${profile.clearZ.toFixed(2)} m` };
  }
  return NA('clearHeight applies to rooms, floors and elements');
};

const swingClear: Predicate = (w, rule, s) => {
  if (s.kind !== 'door') return NA('swingClear applies to doors');
  const d = s.door;
  const wall = cacheOf(w).wallById.get(d.wallId);
  if (!wall) return NA('door has no host wall');
  const rect = swingRect({ along: d.along, width: d.width, hinge: d.hinge, swing: d.swing, motion: d.motion }, wall);
  if (!rect) return NA('door does not draw an arc');
  const room = d.swingIntoRoomId ? w.roomById.get(d.swingIntoRoomId) : null;
  if (!room) return NA('door has no swing room');
  const tol = numLimit(rule, 0.05);
  const inside = rect.x >= room.rect.x - tol && rect.y >= room.rect.y - tol
    && rect.x + rect.w <= room.rect.x + room.rect.w + tol && rect.y + rect.h <= room.rect.y + room.rect.h + tol;
  return { ok: inside, observed: inside ? 'clear' : 'blocked', limit: room.id };
};

const loadPath: Predicate = (w, rule, s) => {
  if (s.kind !== 'support') return NA('loadPath applies to supports');
  if (!w.struct) return NA('no structural model');
  const tol = numLimit(rule, 0.15);
  const below = w.storeys.filter(st => st.index === s.support.storeyIndex - 1).map(st => st.id);
  if (below.length === 0) return NA('lowest storey: the foundation check owns this');
  const hit = w.struct.columns.some(c => below.includes(c.storey) && Math.hypot(c.position[0] - s.support.xy[0], c.position[1] - s.support.xy[1]) <= tol)
    || w.struct.walls.some(x => below.includes(x.storey) && pointNearSegment(s.support.xy, x.start, x.end) <= tol);
  return { ok: hit, observed: hit ? 'carried' : 'nothing below', limit: round(tol) };
};

function pointNearSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  if (l2 <= 1e-9) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

const cappedAtDemise: Predicate = (w, rule, s) => {
  if (s.kind !== 'run') return NA('cappedAtDemise applies to runs');
  const lines = w.arch?.partyLines ?? [];
  if (lines.length === 0) return NA('no demise lines published');
  if (s.path.length === 0) return NA('run has no path');
  const end = s.path[s.path.length - 1];
  const limit = numLimit(rule, 1.0);
  let best = Infinity;
  for (const bar of lines) {
    for (const off of bar.offsets) {
      best = Math.min(best, Math.abs((bar.axis === 'x' ? end[0] : end[1]) - off));
    }
  }
  if (!Number.isFinite(best)) return NA('no demise offsets');
  return { ok: cmp('<=', best, limit), observed: round(best), limit };
};

const count: Predicate = (w, rule, s) => {
  const want = argOf(rule);
  const limit = numLimit(rule, 1);
  const op = opOf(rule);
  if (!want) return NA('no object');
  let n = 0;
  if (s.kind === 'unit') {
    n = (cacheOf(w).unitRooms.get(s.unit.id) ?? []).filter(r => r.type === want).length;
  } else if (s.kind === 'floor') {
    n = [...w.roomById.values()].filter(r => r.storey === s.floor.storey && r.type === want).length;
  } else if (s.kind === 'building') {
    n = (cacheOf(w).roomsByType.get(want) ?? []).length || elementsOfKind(w, want).length;
  } else if (s.kind === 'room') {
    n = s.room.type === want ? 1 : 0;
  } else {
    return NA('count applies to buildings, floors, units and rooms');
  }
  return { ok: cmp(op, n, limit), observed: n, limit };
};

const ratio: Predicate = (w, rule, s) => {
  const a = argOf(rule, 0);
  const b = argOf(rule, 1);
  const limit = numLimit(rule, 1);
  if (!a || !b) return NA('ratio needs two objects');
  const countOf = (want: string): number => {
    if (s.kind === 'unit') return (cacheOf(w).unitRooms.get(s.unit.id) ?? []).filter(r => r.type === want).length;
    if (s.kind === 'floor') return [...w.roomById.values()].filter(r => r.storey === s.floor.storey && r.type === want).length;
    return (cacheOf(w).roomsByType.get(want) ?? []).length || elementsOfKind(w, want).length;
  };
  const den = countOf(b);
  if (den === 0) return NA(`no ${b}`);
  const observed = countOf(a) / den;
  return { ok: cmp(opOf(rule), observed, limit), observed: round(observed), limit };
};

function round(v: number, dp = 3): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

export const PREDICATES: Readonly<Record<PredicateId, Predicate>> = {
  minDim,
  minArea,
  maxArea,
  aspect,
  adjacent,
  connected,
  notThrough,
  exterior,
  daylight,
  withinDistance,
  clearance,
  notOver,
  band,
  lane: laneP,
  inReservation,
  maxRun,
  deadEnd,
  egressTravel,
  supported,
  slope,
  continuous,
  reaches,
  clearHeight,
  swingClear,
  loadPath,
  cappedAtDemise,
  count,
  ratio,
};

export const PREDICATE_IDS: readonly PredicateId[] = Object.keys(PREDICATES) as PredicateId[];

const ROOMY: readonly SubjectKind[] = ['room', 'unit', 'corridor'];

export const PREDICATE_SIGNATURES: Readonly<Record<PredicateId, PredicateSignature>> = {
  minDim: { subjects: ROOMY, limitType: 'number', unit: 'm', description: 'Shortest side of the subject’s rectangle is at least the limit.', resolutions: ['clamp', 'swap-module', 'merge-room'] },
  minArea: { subjects: ['room', 'unit', 'floor'], limitType: 'number', unit: 'm²', description: 'Net area is at least the limit.', resolutions: ['clamp', 'swap-module', 'merge-room'] },
  maxArea: { subjects: ['room', 'unit', 'floor'], limitType: 'number', unit: 'm²', description: 'Net area is at most the limit.', resolutions: ['clamp', 'swap-module'] },
  aspect: { subjects: ['room', 'unit'], limitType: 'number', description: 'Long side / short side is at most the limit.', resolutions: ['clamp', 'swap-module'] },
  adjacent: { subjects: ['room'], object: ['roomType'], limitType: 'boolean', description: 'Shares a wall with a room of the object type.', resolutions: ['swap-module', 'stack-room'] },
  connected: { subjects: ['room'], object: ['roomType'], limitType: 'boolean', description: 'Shares a door or cased opening with a room of the object type.', resolutions: ['swap-module'] },
  notThrough: { subjects: ['room'], object: ['roomType'], limitType: 'boolean', description: 'One does not have to pass through this room to get from the first object type to the second.', resolutions: ['swap-module'] },
  exterior: { subjects: ['room', 'unit'], limitType: 'boolean', description: 'Has an exterior wall.', resolutions: ['swap-module', 'stack-room'] },
  daylight: { subjects: ['room'], limitType: 'number', description: 'Has at least this many windows (and an exterior wall).', resolutions: ['swap-module'] },
  withinDistance: { subjects: ['room', 'unit', 'element', 'run'], object: ['roomType', 'elementKind'], limitType: 'number', unit: 'm', description: 'Nearest object of that kind is within the limit.', resolutions: ['shift-lateral', 'shift-along-lane'] },
  clearance: { subjects: ['element'], object: ['elementKind'], limitType: 'number', unit: 'm', description: 'Keeps at least the limit clear of the nearest element of that kind.', resolutions: ['shift-lateral', 'shift-along-lane', 'reroute-in-wall'] },
  notOver: { subjects: ['element'], object: ['elementKind'], limitType: 'boolean', description: 'Does not pass over an element of that kind.', resolutions: ['shift-lateral', 'reroute-in-wall'] },
  band: { subjects: ['element'], object: ['none'], limitType: 'string', description: 'Lies inside the band of its purpose on its storey.', resolutions: ['compress-band', 'drop-band', 'raise-floor-to-floor'] },
  lane: { subjects: ['element'], object: ['none'], limitType: 'string', description: 'Lies inside the named lane.', resolutions: ['shift-lateral'] },
  inReservation: { subjects: ['element'], limitType: 'boolean', description: 'Lies inside a reservation of its own discipline.', resolutions: ['none'] },
  maxRun: { subjects: ['run', 'corridor'], limitType: 'number', unit: 'm', description: 'Developed length is at most the limit.', resolutions: ['split-corridor', 'add-core'] },
  deadEnd: { subjects: ['corridor'], limitType: 'number', unit: 'm', description: 'No dead-end leg longer than the limit.', resolutions: ['split-corridor', 'add-core'] },
  egressTravel: { subjects: ['unit', 'room', 'floor'], limitType: 'number', unit: 'm', description: 'Travel distance to the nearest core is at most the limit.', resolutions: ['add-core'] },
  supported: { subjects: ['element', 'support'], limitType: 'number', unit: 'm', description: 'Hangs within the hanger drop limit of the soffit, or is in a wall/shaft/chase/floor.', resolutions: ['none'] },
  slope: { subjects: ['run'], limitType: 'number', description: 'Falls monotonically, at or above the code minimum and no steeper than 1:12.', resolutions: ['oversize-pipe', 'add-sump'] },
  continuous: { subjects: ['run'], limitType: 'number', unit: 'm', description: 'No gap in the run longer than the limit.', resolutions: ['none'] },
  reaches: { subjects: ['run'], object: ['elementKind'], limitType: 'number', unit: 'm', description: 'Terminates within the limit of an element of that kind.', resolutions: ['add-sump', 'vent-branch'] },
  clearHeight: { subjects: ['room', 'floor', 'corridor', 'element'], limitType: 'number', unit: 'm', description: 'Clear height at or above the limit (for an element: it stays above the clear zone).', resolutions: ['lower-ceiling', 'raise-floor-to-floor', 'compress-band'] },
  swingClear: { subjects: ['door'], limitType: 'number', unit: 'm', description: 'The leaf’s swing stays inside the room it swings into.', resolutions: ['swap-module'] },
  loadPath: { subjects: ['support'], limitType: 'number', unit: 'm', description: 'Lands on a column, wall or transfer beam on the storey below, within the tolerance.', resolutions: ['none'] },
  cappedAtDemise: { subjects: ['run'], limitType: 'number', unit: 'm', description: 'Terminates within the limit of a demise line.', resolutions: ['none'] },
  count: { subjects: ['building', 'floor', 'unit', 'room'], object: ['roomType', 'elementKind'], limitType: 'number', description: 'Number of objects of that kind, compared with the limit.', resolutions: ['none'] },
  ratio: { subjects: ['building', 'floor', 'unit'], object: ['roomType', 'elementKind'], limitType: 'number', description: 'Ratio of the first object count to the second, compared with the limit.', resolutions: ['none'] },
};

/** Trap-arm limit for a diameter — exposed so the plumbing tables read one function, not a private copy. */
export { trapArmLimit };
