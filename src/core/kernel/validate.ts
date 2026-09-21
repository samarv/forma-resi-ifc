/**
 * The post-check: every governed MEP element must lie inside a reservation of its own discipline, inside its band.
 *
 * This is the safety net behind "reservations, not collision checks": the disciplines ask the kernel for space and
 * then emit geometry, and this pass proves that what they emitted is what they asked for. It is O(n) — reservations
 * are indexed in a per-storey 2 m XY grid, so each element tests against a handful of candidates, never against
 * other elements.
 */
import type { ModelElement } from '../types.ts';
import type { Deviation, Issue, Ledger } from '../rules/types.ts';
import type { Box3, ElementKind, Reservation, StoreyProfile } from './types.ts';

// ---------------------------------------------------------------------------------------------------------------
// ELEMENT_KIND — classify an emitted element from its ifcType / system / name
// ---------------------------------------------------------------------------------------------------------------

/** ifcType → kind, for the cases the ifcType alone settles. */
export const ELEMENT_KIND: Readonly<Record<string, ElementKind>> = {
  'IfcSlab': 'slab',
  'IfcRoof': 'slab',
  'IfcBeam': 'beam',
  'IfcColumn': 'column',
  'IfcWall': 'wall',
  'IfcWallStandardCase': 'wall',
  'IfcFooting': 'slab',
  'IfcPile': 'column',
  'IfcDuctSegment': 'duct',
  'IfcDuctFitting': 'duct-fitting',
  'IfcAirTerminal': 'air-terminal',
  'IfcAirTerminalBox': 'duct-fitting',
  'IfcFan': 'fan',
  'IfcAirToAirHeatRecovery': 'ahu',
  'IfcUnitaryEquipment': 'ahu',
  'IfcChiller': 'ahu',
  'IfcBoiler': 'ahu',
  'IfcSpaceHeater': 'ahu',
  'IfcCoil': 'ahu',
  'IfcEvaporator': 'ahu',
  'IfcCondenser': 'ahu',
  'IfcCompressor': 'ahu',
  'IfcPump': 'pump',
  'IfcTank': 'tank',
  'IfcValve': 'conduit',
  'IfcFlowMeter': 'conduit',
  'IfcFireSuppressionTerminal': 'sprinkler-head',
  'IfcSanitaryTerminal': 'waste',
  'IfcWasteTerminal': 'waste',
  'IfcInterceptor': 'waste',
  'IfcDistributionChamberElement': 'sump',
  'IfcCableCarrierSegment': 'tray-power',
  'IfcCableCarrierFitting': 'tray-power',
  'IfcCableSegment': 'conduit',
  'IfcCableFitting': 'conduit',
  'IfcBusbarTrunking': 'busduct',
  'IfcElectricDistributionBoard': 'panel',
  'IfcTransformer': 'switchgear',
  'IfcElectricGenerator': 'switchgear',
  'IfcElectricFlowStorageDevice': 'switchgear',
  'IfcSolarDevice': 'ev-charger',
  'IfcElectricAppliance': 'ev-charger',
  'IfcLightFixture': 'light',
  'IfcSensor': 'sensor',
  'IfcAlarm': 'sensor',
  'IfcUnitaryControlElement': 'sensor',
  'IfcAudioVisualAppliance': 'sensor',
  'IfcProtectiveDevice': 'panel',
  'IfcSwitchingDevice': 'conduit',
  'IfcOutlet': 'conduit',
  'IfcJunctionBox': 'conduit',
};

const SYSTEM_KIND: readonly { match: string; kind: ElementKind }[] = [
  { match: 'WASTE', kind: 'waste' },
  { match: 'SOIL', kind: 'waste' },
  { match: 'VENT', kind: 'vent' },
  { match: 'STORM', kind: 'storm' },
  { match: 'TRENCH', kind: 'trench-drain' },
  { match: 'DCW', kind: 'dcw' },
  { match: 'DHW', kind: 'dhw' },
  { match: 'HWR', kind: 'hwr' },
  { match: 'GAS', kind: 'gas' },
  { match: 'SPRINKLER', kind: 'sprinkler-branch' },
  { match: 'STANDPIPE', kind: 'standpipe' },
  { match: 'DATA', kind: 'tray-data' },
  { match: 'LIFE-SAFETY', kind: 'conduit' },
];

/**
 * The kind of an emitted element, or null when the kernel does not govern it.
 *
 * Only the four disciplines that own physical systems are classified: architecture and site emit walls, rooms,
 * furniture and landscape, and a bathroom's WC *furniture* carries `IfcSanitaryTerminal` exactly like a plumbing
 * fixture does — classifying it would make every bathroom look like a free-floating drain.
 */
const KIND_MEMO = new WeakMap<object, ElementKind | null>();

export function elementKindOf(e: Pick<ModelElement, 'discipline' | 'ifcType' | 'predefinedType' | 'name' | 'system' | 'geometry'>): ElementKind | null {
  const memo = KIND_MEMO.get(e);
  if (memo !== undefined) return memo;
  const kind = classify(e);
  KIND_MEMO.set(e, kind);
  return kind;
}

function classify(e: Pick<ModelElement, 'discipline' | 'ifcType' | 'predefinedType' | 'name' | 'system' | 'geometry'>): ElementKind | null {
  if (e.discipline === 'architecture' || e.discipline === 'site') return null;
  const sys = (e.system ?? '').toUpperCase();
  const isRun = e.geometry.kind === 'axis';
  if (e.discipline === 'plumbing' && (isRun || e.ifcType === 'IfcPipeSegment' || e.ifcType === 'IfcPipeFitting')) {
    for (const s of SYSTEM_KIND) {
      if (sys.includes(s.match)) {
        if (s.kind === 'sprinkler-branch') {
          return /main|riser|cross/i.test(e.name) ? 'sprinkler-main' : 'sprinkler-branch';
        }
        return s.kind;
      }
    }
    return 'dcw';
  }
  if (e.discipline === 'mechanical' && isRun) {
    return 'duct';
  }
  if (e.discipline === 'electrical' && isRun) {
    if (sys.includes('DATA')) return 'tray-data';
    if (e.ifcType === 'IfcCableCarrierSegment') return 'tray-power';
    if (e.ifcType === 'IfcBusbarTrunking') return 'busduct';
    return 'conduit';
  }
  const byType = ELEMENT_KIND[e.ifcType];
  if (!byType) return null;
  if (byType === 'fan' && /jet/i.test(e.name)) return 'jet-fan';
  // Only the building's own distribution equipment is switchgear; a dwelling's "service panel" is a panelboard.
  if (byType === 'panel' && /switchboard|switchgear|main distribution|\bmdp\b|main service/i.test(`${e.name} ${e.predefinedType ?? ''}`)) return 'switchgear';
  if (byType === 'sump' && /ejector|pump/i.test(e.name)) return 'ejector';
  if (byType === 'ev-charger' && !/ev|charge/i.test(e.name)) return 'sensor';
  return byType;
}

/**
 * The kinds whose elements must sit inside a reservation: distribution runs, risers and equipment footprints.
 * Terminal devices (a diffuser, a sprinkler head, a socket, a luminaire) are governed by their room and their
 * mounting height, not by a plenum reservation, so they are excluded here.
 */
export const GOVERNED_KINDS: readonly ElementKind[] = [
  'duct', 'duct-fitting', 'fan', 'jet-fan', 'ahu',
  'waste', 'vent', 'storm', 'trench-drain', 'dcw', 'dhw', 'hwr', 'gas',
  'sprinkler-main', 'sprinkler-branch', 'standpipe',
  'tray-power', 'tray-data', 'busduct', 'switchgear',
  'pump', 'tank', 'sump', 'ejector',
];

export function isGoverned(kind: ElementKind): boolean {
  return GOVERNED_KINDS.includes(kind);
}

// ---------------------------------------------------------------------------------------------------------------
// Geometry → boxes
// ---------------------------------------------------------------------------------------------------------------

function rotatedBounds(x: number, y: number, w: number, d: number, rot: number): { x: number; y: number; w: number; d: number } {
  if (!rot) return { x, y, w, d };
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const pts: [number, number][] = [[0, 0], [w, 0], [w, d], [0, d]];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [px, py] of pts) {
    const rx = x + px * c - py * s;
    const ry = y + px * s + py * c;
    minX = Math.min(minX, rx);
    maxX = Math.max(maxX, rx);
    minY = Math.min(minY, ry);
    maxY = Math.max(maxY, ry);
  }
  return { x: minX, y: minY, w: maxX - minX, d: maxY - minY };
}

const BOX_MEMO = new WeakMap<object, Box3[]>();

/**
 * Axis-aligned bounds of an element's geometry (empty when it has no volume the kernel can test).
 * Memoised: `validate`, `checkSupport` and three predicates all ask for the same element's box.
 */
export function boxesOfElement(e: Pick<ModelElement, 'geometry'>): Box3[] {
  const memo = BOX_MEMO.get(e);
  if (memo) return memo;
  const out = computeBoxes(e);
  BOX_MEMO.set(e, out);
  return out;
}

function computeBoxes(e: Pick<ModelElement, 'geometry'>): Box3[] {
  const g = e.geometry;
  if (g.kind === 'axis') {
    const half = g.profile.type === 'circle' ? g.profile.radius : Math.max(g.profile.width, g.profile.height) / 2;
    const hz = g.profile.type === 'circle' ? g.profile.radius : g.profile.height / 2;
    const x0 = Math.min(g.start[0], g.end[0]) - half;
    const y0 = Math.min(g.start[1], g.end[1]) - half;
    const z0 = Math.min(g.start[2], g.end[2]) - hz;
    return [{
      x: x0, y: y0, z: z0,
      w: Math.abs(g.end[0] - g.start[0]) + 2 * half,
      d: Math.abs(g.end[1] - g.start[1]) + 2 * half,
      h: Math.abs(g.end[2] - g.start[2]) + 2 * hz,
    }];
  }
  if (g.kind === 'box' || g.kind === 'instance') {
    const b = rotatedBounds(g.position[0], g.position[1], g.width, g.depth, g.rotation ?? 0);
    return [{ x: b.x, y: b.y, z: g.position[2], w: b.w, d: b.d, h: g.height }];
  }
  if (g.kind === 'column') {
    return [{ x: g.position[0] - g.width / 2, y: g.position[1] - g.depth / 2, z: g.position[2], w: g.width, d: g.depth, h: g.height }];
  }
  if (g.kind === 'beam') {
    const x0 = Math.min(g.start[0], g.end[0]) - g.width / 2;
    const y0 = Math.min(g.start[1], g.end[1]) - g.width / 2;
    return [{
      x: x0, y: y0, z: Math.min(g.start[2], g.end[2]) - g.height,
      w: Math.abs(g.end[0] - g.start[0]) + g.width,
      d: Math.abs(g.end[1] - g.start[1]) + g.width,
      h: g.height + Math.abs(g.end[2] - g.start[2]),
    }];
  }
  if (g.kind === 'prism' || g.kind === 'slab') {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of g.profile) {
      minX = Math.min(minX, p[0]);
      maxX = Math.max(maxX, p[0]);
      minY = Math.min(minY, p[1]);
      maxY = Math.max(maxY, p[1]);
    }
    if (!Number.isFinite(minX)) return [];
    const h = g.kind === 'slab' ? g.thickness : g.height;
    return [{ x: g.position[0] + minX, y: g.position[1] + minY, z: g.position[2], w: maxX - minX, d: maxY - minY, h }];
  }
  return [];
}

export function boxesOverlap(a: Box3, b: Box3, tol = 0): boolean {
  return a.x + a.w > b.x + tol && b.x + b.w > a.x + tol
    && a.y + a.d > b.y + tol && b.y + b.d > a.y + tol
    && a.z + a.h > b.z + tol && b.z + b.h > a.z + tol;
}

export function boxInside(inner: Box3, outer: Box3, tol = 0.02): boolean {
  return inner.x >= outer.x - tol && inner.x + inner.w <= outer.x + outer.w + tol
    && inner.y >= outer.y - tol && inner.y + inner.d <= outer.y + outer.d + tol
    && inner.z >= outer.z - tol && inner.z + inner.h <= outer.z + outer.h + tol;
}

// ---------------------------------------------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------------------------------------------

export const GRID = 2.0;

export interface BoxIndex {
  insert(box: Box3, payload: number): void;
  query(box: Box3): number[];
  /**
   * Visit every candidate in the cells the box touches, without allocating a result array and without
   * deduplicating (a payload in two cells is visited twice, which is harmless for "any" and "nearest" queries and
   * is what keeps the post-check O(n) on a 67 000-element model). Return `false` from `visit` to stop.
   */
  forEach(box: Box3, visit: (payload: number) => boolean | void): void;
}

/** Cell key as a single number: the grid is queried millions of times, and string keys are the whole cost. */
function cellKey(i: number, j: number): number {
  return (i + 32768) * 65536 + (j + 32768);
}

export function createBoxIndex(): BoxIndex {
  const cells = new Map<number, number[]>();
  const keysOf = (b: Box3): number[] => {
    const out: number[] = [];
    const i0 = Math.floor(b.x / GRID);
    const i1 = Math.floor((b.x + b.w) / GRID);
    const j0 = Math.floor(b.y / GRID);
    const j1 = Math.floor((b.y + b.d) / GRID);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) out.push(cellKey(i, j));
    return out;
  };
  return {
    insert(box: Box3, payload: number): void {
      for (const k of keysOf(box)) {
        const list = cells.get(k);
        if (list) list.push(payload);
        else cells.set(k, [payload]);
      }
    },
    query(box: Box3): number[] {
      const seen = new Set<number>();
      for (const k of keysOf(box)) for (const p of cells.get(k) ?? []) seen.add(p);
      return [...seen].sort((a, b) => a - b);
    },
    forEach(box: Box3, visit: (payload: number) => boolean | void): void {
      const i0 = Math.floor(box.x / GRID);
      const i1 = Math.floor((box.x + box.w) / GRID);
      const j0 = Math.floor(box.y / GRID);
      const j1 = Math.floor((box.y + box.d) / GRID);
      if (cells.size === 0) return;
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          const list = cells.get(cellKey(i, j));
          if (!list) continue;
          for (const p of list) {
            if (visit(p) === false) return;
          }
        }
      }
    },
  };
}

export interface ValidateInput {
  elements: readonly ModelElement[];
  reservations: readonly Reservation[];
  profileOf(storey: string): StoreyProfile | null;
  ledger: Ledger;
  /** Issue cap per rule so a systemic problem does not produce 60 000 issues */
  cap?: number;
}

export function validateElements(i: ValidateInput): Issue[] {
  const out: Issue[] = [];
  const cap = i.cap ?? 25;
  const counted = new Map<string, number>();

  // Nothing was reserved: the disciplines are not on the kernel yet, so "is every element inside a reservation"
  // has no meaning. Say so once instead of reporting every MEP element as free-floating. (Wave 2 removes this
  // branch by making the reservations non-empty.) Keep-outs alone do not count: `checkSupport` owns that test.
  if (i.reservations.every(r => r.container === 'keepout')) {
    const note = i.ledger.addOnce('no-reservations', {
      severity: 'info', ruleId: 'XD-S0.inReservation', discipline: 'xd',
      message: 'no reservations were made: the element-to-reservation check is skipped until the disciplines route through the kernel',
    });
    return note ? [note] : [];
  }

  // Index reservations per storey (the registry's own grid covers keep-outs only).
  const byStorey = new Map<string, { index: BoxIndex; boxes: { box: Box3; res: Reservation }[] }>();
  for (const r of i.reservations) {
    let bucket = byStorey.get(r.storey);
    if (!bucket) {
      bucket = { index: createBoxIndex(), boxes: [] };
      byStorey.set(r.storey, bucket);
    }
    for (const b of r.boxes) {
      bucket.index.insert(b, bucket.boxes.length);
      bucket.boxes.push({ box: b, res: r });
    }
  }

  const add = (d: Deviation): void => {
    const n = (counted.get(d.ruleId) ?? 0) + 1;
    counted.set(d.ruleId, n);
    if (n > cap) {
      const summary = i.ledger.addOnce(`cap:${d.ruleId}`, {
        severity: d.severity, ruleId: d.ruleId, discipline: d.discipline,
        message: `more than ${cap} elements failed ${d.ruleId}; only the first ${cap} are listed individually`,
      });
      if (summary) out.push(summary);
      return;
    }
    out.push(i.ledger.add(d));
  };

  for (const e of i.elements) {
    const kind = elementKindOf(e);
    if (!kind || !isGoverned(kind)) continue;
    const boxes = boxesOfElement(e);
    if (boxes.length === 0) continue;
    const bucket = byStorey.get(e.storey);
    const profile = i.profileOf(e.storey);

    for (const box of boxes) {
      // Keep-outs are `checkSupport`'s job (XD-S5), so this pass only asks the one question it owns: is the element
      // inside a reservation of its own discipline, and inside that reservation's band?
      let own: Reservation | null = null;
      if (bucket) {
        bucket.index.forEach(box, c => {
          const { box: rb, res } = bucket.boxes[c];
          if (res.container === 'keepout' || res.owner !== e.discipline) return;
          if (!boxInside(box, rb)) return;
          own = res;
          return false;
        });
      }

      if (!own) {
        add({
          severity: 'violation', ruleId: 'XD-S0.inReservation', discipline: e.discipline, storey: e.storey,
          elementIds: [e.id], message: `free-floating ${kind} ${e.id}: no ${e.discipline} reservation contains it`,
        });
        continue;
      }
      const reservation: Reservation = own;
      if (reservation.container === 'band' && profile) {
        const band = reservation.containerId ? profile.bandById(reservation.containerId) : null;
        if (band && (box.z < band.z0 - 0.02 || box.z + box.h > band.z1 + 0.02)) {
          add({
            severity: 'violation', ruleId: 'XD-02.inBand', discipline: e.discipline, storey: e.storey,
            elementIds: [e.id],
            message: `${kind} ${e.id} leaves band ${band.id} [${band.z0.toFixed(3)}, ${band.z1.toFixed(3)}]`,
            observed: Number(box.z.toFixed(3)), limit: Number(band.z0.toFixed(3)),
          });
        }
      }
    }
  }
  return out;
}
