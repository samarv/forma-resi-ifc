/**
 * Constructability: does what we modelled actually hold itself up, drain, and stay out of the structure?
 *
 * Five checks, all O(n) with hash lookups / union-find — never a pairwise element loop:
 *   XD-S1 hangers        every horizontal run hangs within `HANGERS[kind].maxDrop` of the soffit it hangs from,
 *                        unless it is in a wall, chase, shaft, floor or plinth (supported by definition);
 *   XD-S2 riser continuity   a riser's shaft slot or chase exists on every storey it crosses, and the storeys it
 *                        crosses are contiguous;
 *   PLB-S1 slope         every gravity run falls monotonically, at or above the code minimum and no steeper than
 *                        1:12 (steeper is a vertical leg, not a sloped run);
 *   PLB-S2..S4 reachability  every fixture reaches a stack, every stack a building drain or a sump, every sump
 *                        discharges to a gravity node (union-find over run endpoints);
 *   XD-S5 penetration    no MEP box overlaps the interior of a structure keep-out (touching a soffit is legal).
 *
 * Every check is skipped rather than guessed when its inputs are not in the model yet, so it can land before the
 * disciplines that feed it.
 */
import type { ModelElement, StoreyDef } from '../types.ts';
import type { Deviation, Issue, Ledger, RuleSet } from '../rules/types.ts';
import type { StructuralPresize } from '../../disciplines/structure/presize.ts';
import type { Box3, ElementKind, InvertModel, Kernel, Reservation } from './types.ts';
import { HANGERS, SLOPES, hangerFor, slopeFor } from './clearances.ts';
import { boxInside, boxesOfElement, boxesOverlap, createBoxIndex, elementKindOf, isGoverned } from './validate.ts';

export interface SupportInput {
  elements: readonly ModelElement[];
  kernel: Kernel;
  storeys: readonly StoreyDef[];
  presize: StructuralPresize | null;
  invert: InvertModel | null;
  rules: RuleSet;
  ledger: Ledger;
  region?: 'US' | 'UK' | 'CA' | 'AU' | 'NZ' | 'IE';
  cap?: number;
}

export interface SupportReport {
  issues: Issue[];
  derived: Record<string, number>;
}

const GRAVITY_KINDS: readonly ElementKind[] = ['waste', 'storm', 'trench-drain'];
const Q = 0.05;

function key3(x: number, y: number, z: number): string {
  return `${Math.round(x / Q)}:${Math.round(y / Q)}:${Math.round(z / Q)}`;
}
function key2(x: number, y: number): string {
  return `${Math.round(x / Q)}:${Math.round(y / Q)}`;
}

class UnionFind {
  private parent: Map<string, string>;
  constructor() {
    this.parent = new Map<string, string>();
  }
  find(a: string): string {
    let cur = this.parent.get(a);
    if (cur === undefined) {
      this.parent.set(a, a);
      return a;
    }
    while (cur !== this.parent.get(cur)) cur = this.parent.get(cur) as string;
    this.parent.set(a, cur);
    return cur;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    if (ra < rb) this.parent.set(rb, ra);
    else this.parent.set(ra, rb);
  }
  same(a: string, b: string): boolean {
    return this.find(a) === this.find(b);
  }
}

export function checkSupport(i: SupportInput): SupportReport {
  const issues: Issue[] = [];
  const cap = i.cap ?? i.rules.num('XD-00.issueCapPerRule', 25);
  const counts = new Map<string, number>();
  const derived: Record<string, number> = {};

  const add = (d: Deviation): void => {
    const n = (counts.get(d.ruleId) ?? 0) + 1;
    counts.set(d.ruleId, n);
    if (n > cap) {
      const s = i.ledger.addOnce(`cap:${d.ruleId}`, {
        severity: d.severity, ruleId: d.ruleId, discipline: d.discipline,
        message: `more than ${cap} elements failed ${d.ruleId}; only the first ${cap} are listed individually`,
      });
      if (s) issues.push(s);
      return;
    }
    issues.push(i.ledger.add(d));
  };

  /**
   * Continuity is measured in RANK (position in the ascending storey list), not in `StoreyDef.index`: SITE, FND and
   * ROOF use the sentinel indices -101/-100/100, so a vent riser from L05 to the roof would otherwise look as if it
   * skipped 94 storeys.
   */
  const storeyIndex = new Map<string, number>();
  const ranked = [...i.storeys].sort((a, b) => a.index - b.index || (a.id < b.id ? -1 : 1));
  for (let r = 0; r < ranked.length; r++) storeyIndex.set(ranked[r].id, r);

  // --- reservation index per storey -----------------------------------------------------------------------------
  const byStorey = new Map<string, { index: ReturnType<typeof createBoxIndex>; items: { box: Box3; res: Reservation }[] }>();
  for (const r of i.kernel.reservations()) {
    let bucket = byStorey.get(r.storey);
    if (!bucket) {
      bucket = { index: createBoxIndex(), items: [] };
      byStorey.set(r.storey, bucket);
    }
    for (const b of r.boxes) {
      bucket.index.insert(b, bucket.items.length);
      bucket.items.push({ box: b, res: r });
    }
  }
  /** Until a discipline reserves a band/shaft/chase there is nothing to hang from: the hanger test is vacuous. */
  const hasContainers = i.kernel.reservations().some(r => r.container !== 'keepout');
  const reservationFor = (storey: string, box: Box3, owner: string): Reservation | null => {
    if (!hasContainers) return null;
    const bucket = byStorey.get(storey);
    if (!bucket) return null;
    for (const idx of bucket.index.query(box)) {
      const item = bucket.items[idx];
      if (item.res.container === 'keepout' || item.res.owner !== owner) continue;
      if (boxInside(box, item.box)) return item.res;
    }
    return null;
  };

  // --- XD-S1 hangers / XD-S5 penetration -------------------------------------------------------------------------
  let hung = 0;
  let checkedPenetration = 0;
  for (const e of i.elements) {
    const kind = elementKindOf(e);
    if (!kind || !isGoverned(kind)) continue;
    const boxes = boxesOfElement(e);
    if (boxes.length === 0) continue;

    for (const box of boxes) {
      // XD-S5: interior overlap with a structure keep-out
      const bucket = byStorey.get(e.storey);
      if (bucket) {
        bucket.index.forEach(box, idx => {
          const item = bucket.items[idx];
          if (item.res.container !== 'keepout') return;
          if (item.res.owner === e.discipline) return;
          if (!(item.res.bans ?? []).includes(kind)) return;
          checkedPenetration += 1;
          if (boxesOverlap(box, item.box, 1e-3)) {
            add({
              severity: 'violation', ruleId: 'XD-S5.noPenetration', discipline: e.discipline, storey: e.storey,
              elementIds: [e.id],
              message: `${kind} ${e.id} penetrates ${item.res.note ?? item.res.kind} (keep-out ${item.res.id})`,
              source: item.res.note,
            });
          }
        });
      }

      if (!hasContainers) continue; // XD-S0 (reported by kernel.validate) comes first: nothing to hang from yet
      const res = reservationFor(e.storey, box, e.discipline);
      if (!res) continue; // XD-S0 is reported by kernel.validate; do not double-report
      if (res.container !== 'band') continue; // wall / chase / shaft / floor / plinth: supported by definition
      const spec = hangerFor(kind) ?? HANGERS[kind] ?? null;
      if (!spec) continue;
      const profile = i.kernel.profileOf(e.storey);
      const drop = profile.soffitZ - (box.z + box.h);
      hung += 1;
      if (drop > spec.maxDrop + 1e-6) {
        add({
          severity: 'violation', ruleId: 'XD-S1.hangerDrop', discipline: e.discipline, storey: e.storey,
          elementIds: [e.id],
          message: `${kind} ${e.id} hangs ${drop.toFixed(2)} m below the soffit; the hanger limit is ${spec.maxDrop.toFixed(2)} m`,
          observed: Number(drop.toFixed(3)), limit: spec.maxDrop, source: spec.source,
        });
      }
    }
  }
  derived.supportChecked = hung;
  derived.penetrationTests = checkedPenetration;

  // --- XD-S2 riser continuity -----------------------------------------------------------------------------------
  interface RiserGroup { kind: ElementKind; storeys: Set<string>; xy: [number, number]; ids: string[] }
  const risers = new Map<string, RiserGroup>();
  for (const e of i.elements) {
    if (e.geometry.kind !== 'axis') continue;
    const kind = elementKindOf(e);
    if (!kind || !isGoverned(kind)) continue;
    const g = e.geometry;
    const plan = Math.hypot(g.end[0] - g.start[0], g.end[1] - g.start[1]);
    const rise = Math.abs(g.end[2] - g.start[2]);
    if (rise < 0.5 || plan > 0.2) continue;
    const k = `${kind}|${key2(g.start[0], g.start[1])}`;
    let group = risers.get(k);
    if (!group) {
      group = { kind, storeys: new Set<string>(), xy: [g.start[0], g.start[1]], ids: [] };
      risers.set(k, group);
    }
    group.storeys.add(e.storey);
    if (group.ids.length < 4) group.ids.push(e.id);
  }
  derived.risers = risers.size;
  for (const [k, group] of [...risers.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    void k;
    const idxs = [...group.storeys].map(s => storeyIndex.get(s) ?? 0).sort((a, b) => a - b);
    if (idxs.length < 2) continue;
    for (let n = 1; n < idxs.length; n++) {
      if (idxs[n] - idxs[n - 1] > 1) {
        add({
          severity: 'violation', ruleId: 'XD-S2.riserContinuity', discipline: 'plumbing', elementIds: group.ids,
          message: `${group.kind} riser at (${group.xy[0].toFixed(2)}, ${group.xy[1].toFixed(2)}) skips a storey between index ${idxs[n - 1]} and ${idxs[n]}`,
          observed: idxs.join(','),
        });
        break;
      }
    }
    // A riser must have a shaft or chase reservation on every storey it crosses.
    for (const s of [...group.storeys].sort()) {
      const bucket = byStorey.get(s);
      const probe: Box3 = { x: group.xy[0] - 0.02, y: group.xy[1] - 0.02, z: 0.1, w: 0.04, d: 0.04, h: 0.02 };
      let housed = false;
      for (const idx of bucket ? bucket.index.query(probe) : []) {
        const item = (bucket as { items: { box: Box3; res: Reservation }[] }).items[idx];
        if (item.res.container !== 'shaft' && item.res.container !== 'chase' && item.res.container !== 'wall') continue;
        if (boxesOverlap(probe, item.box, 0)) {
          housed = true;
          break;
        }
      }
      if (!housed) {
        add({
          severity: 'violation', ruleId: 'XD-S2.riserHoused', discipline: 'plumbing', storey: s, elementIds: group.ids,
          message: `${group.kind} riser passes ${s} where no shaft slot or chase is reserved for it`,
        });
      }
    }
  }

  // --- PLB-S1 slope ---------------------------------------------------------------------------------------------
  let gravitySegments = 0;
  for (const e of i.elements) {
    if (e.geometry.kind !== 'axis') continue;
    const kind = elementKindOf(e);
    if (!kind || !GRAVITY_KINDS.includes(kind)) continue;
    const g = e.geometry;
    const plan = Math.hypot(g.end[0] - g.start[0], g.end[1] - g.start[1]);
    const drop = g.start[2] - g.end[2];
    if (plan < 0.3) continue; // a vertical leg or a stub, not a sloped run
    gravitySegments += 1;
    const diameter = g.profile.type === 'circle' ? g.profile.radius * 2 : Math.max(g.profile.width, g.profile.height);
    const min = kind === 'storm' || kind === 'trench-drain' ? SLOPES.storm.slope : slopeFor('sanitary', diameter, i.region);
    const slope = drop / plan;
    if (slope < -1e-6) {
      add({
        severity: 'violation', ruleId: 'PLB-S1.slopeMonotonic', discipline: 'plumbing', storey: e.storey,
        elementIds: [e.id],
        message: `${kind} ${e.id} rises ${(-drop * 1000).toFixed(0)} mm over ${plan.toFixed(2)} m: a gravity run must fall in the direction of flow`,
        observed: Number(slope.toFixed(5)), limit: min, source: SLOPES.sanitary[0].source,
      });
      continue;
    }
    if (slope > SLOPES.maxGravity.slope + 1e-6) {
      add({
        severity: 'deviation', ruleId: 'PLB-S1.slopeMax', discipline: 'plumbing', storey: e.storey, elementIds: [e.id],
        message: `${kind} ${e.id} falls 1:${(1 / slope).toFixed(0)}, steeper than the 1:12 limit; model it as a vertical leg`,
        observed: Number(slope.toFixed(5)), limit: SLOPES.maxGravity.slope, source: SLOPES.maxGravity.source,
      });
      continue;
    }
    if (slope < min - 1e-6 && slope > 1e-6) {
      add({
        severity: 'violation', ruleId: 'PLB-S1.slopeMin', discipline: 'plumbing', storey: e.storey, elementIds: [e.id],
        message: `${kind} ${e.id} falls 1:${(1 / slope).toFixed(0)} over ${plan.toFixed(2)} m; Ø${(diameter * 1000).toFixed(0)} needs at least 1:${(1 / min).toFixed(0)}`,
        observed: Number(slope.toFixed(5)), limit: Number(min.toFixed(5)), source: SLOPES.sanitary[0].source,
      });
    }
  }
  derived.gravitySegments = gravitySegments;

  // --- PLB-S2..S4 reachability ---------------------------------------------------------------------------------
  // Reachability needs the invert model: it is what says where the building drain is, which levels are pumped and
  // where their sumps discharge. Without it a union-find over the run endpoints can only guess, so the check is
  // skipped rather than guessed (and the 25 ms it costs on a 67 000-element model is not spent either).
  if (!i.invert) return { issues, derived };

  const uf = new UnionFind();
  const stackNodes: string[] = [];
  const drainNodes: string[] = [];
  const sumpNodes: string[] = [];
  const fixtures: { id: string; node: string; storey: string }[] = [];
  let plumbingRuns = 0;

  for (const e of i.elements) {
    if (e.discipline !== 'plumbing') continue;
    const kind = elementKindOf(e);
    if (e.geometry.kind === 'axis' && kind && (GRAVITY_KINDS.includes(kind) || kind === 'vent')) {
      const g = e.geometry;
      const a = key3(g.start[0], g.start[1], g.start[2]);
      const b = key3(g.end[0], g.end[1], g.end[2]);
      uf.union(a, b);
      plumbingRuns += 1;
      const plan = Math.hypot(g.end[0] - g.start[0], g.end[1] - g.start[1]);
      const rise = Math.abs(g.end[2] - g.start[2]);
      if (rise > 0.5 && plan < 0.2 && kind === 'waste') stackNodes.push(a);
      if (/drain|lateral|sewer/i.test(e.name)) drainNodes.push(a);
      continue;
    }
    if (kind === 'sump' || kind === 'ejector') {
      const boxes = boxesOfElement(e);
      if (boxes.length > 0) sumpNodes.push(key3(boxes[0].x + boxes[0].w / 2, boxes[0].y + boxes[0].d / 2, boxes[0].z));
      continue;
    }
    if (e.ifcType === 'IfcSanitaryTerminal' || e.ifcType === 'IfcWasteTerminal') {
      const boxes = boxesOfElement(e);
      if (boxes.length > 0) fixtures.push({ id: e.id, node: key3(boxes[0].x + boxes[0].w / 2, boxes[0].y + boxes[0].d / 2, boxes[0].z), storey: e.storey });
    }
  }
  derived.plumbingRuns = plumbingRuns;
  derived.stacks = stackNodes.length;

  // Only meaningful once the drainage network is in the model.
  if (stackNodes.length > 0 && plumbingRuns > 0) {
    if (fixtures.length > 0) {
      for (const f of fixtures) {
        if (!stackNodes.some(s => uf.same(s, f.node))) {
          add({
            severity: 'violation', ruleId: 'PLB-S2.fixtureReachesStack', discipline: 'plumbing', storey: f.storey,
            elementIds: [f.id], message: `fixture ${f.id} is not connected to any waste stack`,
          });
        }
      }
    }
    if (drainNodes.length > 0 || sumpNodes.length > 0) {
      const sinks = [...drainNodes, ...sumpNodes];
      for (const s of stackNodes) {
        if (!sinks.some(d => uf.same(d, s))) {
          add({
            severity: 'violation', ruleId: 'PLB-S3.stackReachesDrain', discipline: 'plumbing',
            message: `a waste stack at node ${s} reaches neither the building drain nor a sump`,
          });
          break; // one report is enough: they all share the same cause
        }
      }
    }
    if (sumpNodes.length > 0 && i.invert) {
      for (const s of sumpNodes) {
        if (!drainNodes.some(d => uf.same(d, s))) {
          add({
            severity: 'violation', ruleId: 'PLB-S4.sumpDischarge', discipline: 'plumbing',
            message: `a sump at node ${s} has no discharge reaching the gravity building drain`,
          });
          break;
        }
      }
    }
  }

  return { issues, derived };
}
