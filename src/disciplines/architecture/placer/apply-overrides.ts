/**
 * `applyOverrides(base, doc, ctx)` — the third stage of floor planning, between `planFloorLayout` and
 * `instantiateFloor` (design §4.8).
 *
 * Properties the whole editor rests on:
 *   · PURE and DETERMINISTIC — a function of `(base, edits)` only, so reruns are byte-identical and an empty document
 *     returns the base unchanged (`applyOverrides(base, undefined, …) === base`, by reference).
 *   · ORDER-INDEPENDENT — edits are sorted into a canonical order (removeSlot < swapModule < mirror < setSlotKind <
 *     moveBoundary < insertSlot < moveCore < unit, then by slot id), so a shuffled array gives a deep-equal layout.
 *   · ID-STABLE — base slots are never renumbered, a removal leaves a hole, and an inserted slot derives its id from
 *     its anchor ('S-BAR1-L-007' → 'S-BAR1-L-007.1'), so a selection survives regeneration.
 *   · CLAMPED THROUGH THE SAME MACHINERY — every edit goes through `clampLayoutEdit`, the function the editor's drag
 *     reducer calls, so the ghost and the model cannot disagree. A clamp is recorded as a deviation, never a warning.
 */
import type { Deviation } from '../../../core/rules/types.ts';
import type { LayoutEdit, OverrideDoc, UnitEdit } from '../../../core/overrides.ts';
import type { RoomType, Side } from '../../../core/types.ts';
import type { ClampCtx, FloorLayout, Slot } from './types.ts';
import { canonicalJson, editsFor, fnv1a } from '../../../core/overrides.ts';
import { round } from '../../../core/geometry.ts';
import { amenityModuleId } from '../../../modules/ids.ts';
import { mixDeviation } from './quota.ts';
import { columnSubset } from './packer.ts';
import { resolvePortsForSlot } from './ports.ts';
import {
  alongOf, clampLayoutEdit, frontageOf, optsOf, rangeOfSlot, setAlong, slotsOfStrip, stripOf,
} from './clamp.ts';

const EPS = 1e-6;

export interface ApplyCtx extends ClampCtx {
  /** the storey the layout is being applied to, for `doc.storeys[storeyId]` */
  storeyId: string;
}

/** Canonical op order: destructive first, then identity, then geometry, then the per-unit forwarding */
const OP_RANK: Record<LayoutEdit['op'], number> = {
  removeSlot: 0,
  swapModule: 1,
  mirror: 2,
  setSlotKind: 3,
  moveBoundary: 4,
  insertSlot: 5,
  moveCore: 6,
  unit: 7,
};

function slotKeyOf(e: LayoutEdit): string {
  if (e.op === 'insertSlot') return `${e.stripId}|${e.afterSlotId ?? ''}`;
  if (e.op === 'moveCore') return e.coreId;
  return e.slotId;
}

export function sortEdits(edits: readonly LayoutEdit[]): LayoutEdit[] {
  return [...edits]
    .map((e, i) => ({ e, i }))
    .sort((a, b) =>
      OP_RANK[a.e.op] - OP_RANK[b.e.op]
      || (slotKeyOf(a.e) < slotKeyOf(b.e) ? -1 : slotKeyOf(a.e) > slotKeyOf(b.e) ? 1 : 0)
      || a.i - b.i)
    .map(x => x.e);
}

export function applyOverrides(base: FloorLayout, doc: OverrideDoc | undefined, ctx: ApplyCtx): FloorLayout {
  const raw = editsFor(doc, base.key, ctx.storeyId);
  if (raw.length === 0) return base;
  // the CANONICAL order decides the layout, so it must also decide the key: two shuffles of one edit set are the
  // same document and must share a cache identity
  const edits = sortEdits(raw);

  const layout = clone(base);
  const deviations: Deviation[] = [];
  const insertCounts = new Map<string, number>();

  for (const raw of edits) {
    const res = clampLayoutEdit(layout, raw, ctx);
    if (!res.ok) {
      deviations.push({
        severity: 'deviation', ruleId: rejectRuleOf(raw.op), discipline: 'architecture',
        message: `override ${raw.op} on ${slotKeyOf(raw)} was rejected: ${res.reason ?? 'not admissible'}`,
        resolution: { id: 'none', note: 'edit dropped' },
      });
      continue;
    }
    if (canonicalJson(res.edit) !== canonicalJson(raw)) {
      deviations.push({
        severity: 'deviation', ruleId: 'ARC-D10', discipline: 'architecture',
        message: `override ${raw.op} on ${slotKeyOf(raw)} was clamped to the admissible range${res.range ? ` [${round(res.range[0], 2)}, ${round(res.range[1], 2)}]` : ''}`,
        resolution: { id: 'clamp', from: scalarOf(raw), to: scalarOf(res.edit) },
      });
    }
    apply(layout, res.edit, ctx, deviations, insertCounts);
  }

  // recompute everything derived: ports, column lines, the mix report and the cache identity
  refresh(layout, ctx);
  layout.deviations = [...layout.deviations, ...deviations];
  layout.layoutKey = `${layout.key}#${fnv1a(canonicalJson(edits))}`;
  return layout;
}

function rejectRuleOf(op: LayoutEdit['op']): string {
  return op === 'insertSlot' ? 'ARC-D11' : 'ARC-D10';
}

function scalarOf(e: LayoutEdit): number | string | undefined {
  if (e.op === 'moveBoundary') return e.delta;
  if (e.op === 'insertSlot') return e.frontage;
  if (e.op === 'moveCore') return e.along;
  if (e.op === 'swapModule') return e.moduleId;
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------

function apply(
  layout: FloorLayout, edit: LayoutEdit, ctx: ApplyCtx, deviations: Deviation[], insertCounts: Map<string, number>,
): void {
  switch (edit.op) {
    case 'removeSlot': return doRemove(layout, edit.slotId, ctx, deviations);
    case 'swapModule': return doSwap(layout, edit.slotId, edit.moduleId, ctx, deviations);
    case 'mirror': {
      const slot = layout.slots.find(s => s.id === edit.slotId);
      if (slot) slot.mirrored = edit.mirrored;
      return;
    }
    case 'setSlotKind': {
      const slot = layout.slots.find(s => s.id === edit.slotId);
      if (!slot) return;
      slot.kind = edit.kind;
      slot.roomType = edit.roomType ?? (edit.kind === 'remnant' ? 'storage' : 'flex');
      slot.moduleId = amenityModuleId(edit.kind === 'remnant' ? 'store' : 'flex');
      slot.ports = [];
      return;
    }
    case 'moveBoundary': return doMoveBoundary(layout, edit.slotId, edit.edge, edit.delta);
    case 'insertSlot': return doInsert(layout, edit, ctx, deviations, insertCounts);
    case 'moveCore': {
      // A core is a BUILDING-wide object placed by the site pass before any floor is planned, so moving one is not a
      // floor-document edit: it has to be consumed by `placeCores`. Recorded here so the edit is never silently lost.
      deviations.push({
        severity: 'info', ruleId: 'ARC-D12', discipline: 'architecture',
        message: `moveCore ${edit.coreId} to ${round(edit.along, 2)} m is applied by the site core pass, not by the floor document`,
        observed: round(edit.along, 2),
        resolution: { id: 'none', note: 'deferred to placeCores' },
      });
      return;
    }
    default: {
      // 'unit': the edits ride on the slot into `UnitLayoutRequest.edits`, and the solver clamps each one
      const slot = layout.slots.find(s => s.id === edit.slotId);
      if (!slot) return;
      slot.edits = mergeUnitEdits(slot.edits, edit.edits);
      return;
    }
  }
}

/** Unit edits accumulate in one ordered array per slot, later ops on the same ref replacing earlier ones */
function mergeUnitEdits(existing: UnitEdit[] | undefined, added: readonly UnitEdit[]): UnitEdit[] {
  const out = [...(existing ?? [])];
  for (const e of added) {
    const key = unitEditKey(e);
    const at = out.findIndex(x => unitEditKey(x) === key);
    if (at >= 0) out[at] = e;
    else out.push(e);
  }
  return out;
}

function unitEditKey(e: UnitEdit): string {
  const r = e as { op: string; doorRef?: string; edgeRef?: string; itemRef?: string; roomRef?: string };
  return `${r.op}|${r.doorRef ?? r.edgeRef ?? r.itemRef ?? r.roomRef ?? ''}`;
}

function doRemove(layout: FloorLayout, slotId: string, ctx: ApplyCtx, deviations: Deviation[]): void {
  const slot = layout.slots.find(s => s.id === slotId);
  if (!slot) return;
  const iv = alongOf(slot);
  const list = slotsOfStrip(layout, slot.stripId);
  const i = list.findIndex(s => s.id === slotId);
  const before = list[i - 1];
  const after = list[i + 1];
  layout.slots = layout.slots.filter(s => s.id !== slotId);
  // give the frontage to the neighbours up to THEIR maxima; whatever is left becomes a declared remnant
  let left = iv.e - iv.s;
  for (const n of [before, after]) {
    if (!n || left <= EPS) continue;
    const r = rangeOfSlot(layout, n, ctx);
    const f = frontageOf(n);
    const room = r ? Math.max(0, r.max - f) : left;
    const give = Math.min(left, room);
    if (give <= EPS) continue;
    const niv = alongOf(n);
    if (n === before) setAlong(n, niv.s, niv.e + give);
    else setAlong(n, niv.s - give, niv.e);
    left -= give;
  }
  if (left > 0.05) {
    const s0 = before ? alongOf(before).e : iv.s;
    layout.slots.push(remnantSlot(slot, s0, s0 + left));
    layout.remnantArea = round(layout.remnantArea + left * (stripOf(layout, slot)?.netDepth ?? 0), 3);
    deviations.push({
      severity: 'deviation', ruleId: 'ARC-D02', discipline: 'architecture',
      message: `removing ${slotId} left ${round(left, 2)} m the neighbours cannot absorb — declared as a ${left >= 3 ? 'flexible room' : 'store'}`,
      observed: round(left, 2),
      resolution: { id: 'none', note: 'remnant' },
    });
  }
}

function remnantSlot(from: Slot, s: number, e: number): Slot {
  const kind: RoomType = e - s >= 3 ? 'flex' : 'storage';
  const slot: Slot = {
    ...from,
    id: `${from.id}.r`,
    kind: 'remnant',
    moduleId: amenityModuleId(e - s >= 3 ? 'flex' : 'store'),
    roomType: kind,
    ports: [],
    edits: undefined,
    extraDoors: undefined,
    notes: 'left over by an override',
  };
  setAlong(slot, s, e);
  return slot;
}

function doSwap(layout: FloorLayout, slotId: string, moduleId: string, ctx: ApplyCtx, deviations: Deviation[]): void {
  const slot = layout.slots.find(s => s.id === slotId);
  const strip = slot ? stripOf(layout, slot) : undefined;
  if (!slot || !strip) return;
  const r = ctx.catalogue.frontageAt(moduleId, strip.netDepth, optsOf(ctx));
  if (!r) return;
  slot.moduleId = moduleId;
  const mod = ctx.catalogue.byId(moduleId);
  slot.kind = mod?.kind === 'unit' ? 'unit' : mod?.kind === 'break' ? 'break' : mod?.kind === 'mep' ? 'mep' : 'amenity';
  if (mod && mod.kind !== 'unit' && 'roomType' in mod) slot.roomType = mod.roomType;
  if (slot.kind === 'unit') slot.roomType = undefined;
  // widen or narrow into the neighbours' slack until the slot sits inside the new module's range
  const F = frontageOf(slot);
  if (F >= r.min - 0.02 && F <= r.max + 0.02) return;
  const want = F < r.min ? r.min - F : r.max - F;      // > 0 = grow, < 0 = shrink
  const moved = borrow(layout, slot, want, ctx);
  if (Math.abs(moved - want) > 0.05) {
    deviations.push({
      severity: 'deviation', ruleId: 'ARC-D10', discipline: 'architecture',
      message: `${moduleId} on ${slotId} needed ${round(Math.abs(want), 2)} m from its neighbours and only ${round(Math.abs(moved), 2)} m was available`,
      observed: round(frontageOf(slot), 2),
      limit: round(F < r.min ? r.min : r.max, 2),
      resolution: { id: 'clamp' },
    });
  }
}

/**
 * Take (`want > 0`) or give back (`want < 0`) frontage across the two shared boundaries, never past a neighbour's own
 * admissible minimum or maximum. Returns how much actually moved.
 */
function borrow(layout: FloorLayout, slot: Slot, want: number, ctx: ApplyCtx): number {
  let left = want;
  let moved = 0;
  for (const edge of ['end', 'start'] as const) {
    if (Math.abs(left) <= EPS) break;
    const list = slotsOfStrip(layout, slot.stripId);
    const i = list.findIndex(s => s.id === slot.id);
    const n = edge === 'start' ? list[i - 1] : list[i + 1];
    if (!n) continue;
    const r = rangeOfSlot(layout, n, ctx);
    const f = frontageOf(n);
    const room = left > 0 ? (r ? Math.max(0, f - r.min) : Math.max(0, f - 1)) : (r ? Math.max(0, r.max - f) : Math.abs(left));
    const step = Math.sign(left) * Math.min(Math.abs(left), room);
    if (Math.abs(step) <= EPS) continue;
    const siv = alongOf(slot);
    const niv = alongOf(n);
    if (edge === 'end') {
      setAlong(slot, siv.s, siv.e + step);
      setAlong(n, niv.s + step, niv.e);
    } else {
      setAlong(slot, siv.s - step, siv.e);
      setAlong(n, niv.s, niv.e - step);
    }
    left -= step;
    moved += step;
  }
  return moved;
}

function doMoveBoundary(layout: FloorLayout, slotId: string, edge: 'start' | 'end', delta: number): void {
  const slot = layout.slots.find(s => s.id === slotId);
  if (!slot || Math.abs(delta) <= EPS) return;
  const list = slotsOfStrip(layout, slot.stripId);
  const i = list.findIndex(s => s.id === slotId);
  const other = edge === 'start' ? list[i - 1] : list[i + 1];
  if (!other) return;
  const siv = alongOf(slot);
  const oiv = alongOf(other);
  if (edge === 'start') {
    setAlong(slot, siv.s + delta, siv.e);
    setAlong(other, oiv.s, oiv.e + delta);
  } else {
    setAlong(slot, siv.s, siv.e + delta);
    setAlong(other, oiv.s + delta, oiv.e);
  }
}

function doInsert(
  layout: FloorLayout, edit: LayoutEdit & { op: 'insertSlot' }, ctx: ApplyCtx,
  deviations: Deviation[], insertCounts: Map<string, number>,
): void {
  const strip = layout.strips.find(st => st.id === edit.stripId);
  if (!strip) return;
  const list = slotsOfStrip(layout, edit.stripId);
  const anchor = edit.afterSlotId ? list.find(s => s.id === edit.afterSlotId) : undefined;
  const frontage = edit.frontage ?? 0;
  if (frontage <= EPS) return;
  const donors = anchor
    ? [anchor, list[list.findIndex(s => s.id === anchor.id) + 1]]
    : [list[0]];
  let taken = 0;
  for (const d of donors) {
    if (!d || taken >= frontage - EPS) continue;
    const r = rangeOfSlot(layout, d, ctx);
    const f = frontageOf(d);
    const room = Math.max(0, f - (r?.min ?? 1.0));
    const give = Math.min(frontage - taken, room);
    if (give <= EPS) continue;
    const iv = alongOf(d);
    if (d === anchor) setAlong(d, iv.s, iv.e - give);
    else setAlong(d, iv.s + give, iv.e);
    taken += give;
  }
  if (taken < frontage - 0.05) {
    deviations.push({
      severity: 'deviation', ruleId: 'ARC-D11', discipline: 'architecture',
      message: `inserting ${edit.moduleId} took only ${round(taken, 2)} m of the ${round(frontage, 2)} m asked for`,
      observed: round(taken, 2), limit: round(frontage, 2), resolution: { id: 'clamp' },
    });
  }
  if (taken <= EPS) return;
  const anchorId = edit.afterSlotId ?? `${edit.stripId}-head`;
  const k = (insertCounts.get(anchorId) ?? 0) + 1;
  insertCounts.set(anchorId, k);
  const at = anchor ? alongOf(anchor).e : strip.along.s;
  const mod = ctx.catalogue.byId(edit.moduleId);
  const model = anchor ?? list[0];
  if (!model) return;
  const slot: Slot = {
    ...model,
    id: anchor ? `${anchor.id}.${k}` : `S-${edit.stripId.slice(3)}-000.${k}`,
    kind: mod?.kind === 'unit' ? 'unit' : mod?.kind === 'break' ? 'break' : mod?.kind === 'mep' ? 'mep' : 'amenity',
    moduleId: edit.moduleId,
    mirrored: false,
    roomType: mod && mod.kind !== 'unit' && 'roomType' in mod ? mod.roomType : undefined,
    ports: [],
    edits: undefined,
    extraDoors: undefined,
    notes: 'inserted by an override',
  };
  setAlong(slot, at, at + taken);
  layout.slots.push(slot);
}

// ---------------------------------------------------------------------------------------------------------------

/** Recompute the derived half of the document: ports, column lines, grid lines, mix report */
export function refresh(layout: FloorLayout, ctx: ClampCtx): void {
  const delivered: Record<string, number> = {};
  for (const strip of layout.strips) {
    const list = slotsOfStrip(layout, strip.id);
    const bounds = list.length > 0 ? [alongOf(list[0]).s, ...list.map(s => alongOf(s).e)] : [];
    const columns = columnSubset(bounds, ctx.grid.bay);
    for (const slot of list) {
      const iv = alongOf(slot);
      slot.partyLines = [
        { at: round(iv.s, 4), column: columns.has(iv.s) },
        { at: round(iv.e, 4), column: columns.has(iv.e) },
      ];
      slot.ports = resolvePortsForSlot(slot, ctx.catalogue);
    }
    const lines = [...columns].sort((a, b) => a - b).map(v => round(v, 4));
    const prev = layout.grid.lines[strip.barId] ?? [];
    layout.grid.lines[strip.barId] = [...new Set([...prev, ...lines])].sort((a, b) => a - b);
  }
  for (const slot of layout.slots) {
    if (slot.kind !== 'unit') continue;
    const mod = ctx.catalogue.byId(slot.moduleId);
    if (mod && mod.kind === 'unit') delivered[mod.templateId] = (delivered[mod.templateId] ?? 0) + 1;
  }
  const total = Object.values(delivered).reduce((a, c) => a + c, 0);
  const byTemplate: Record<string, { requested: number; delivered: number }> = {};
  for (const id of [...new Set([...Object.keys(layout.mix.requested), ...Object.keys(delivered)])].sort()) {
    byTemplate[id] = { requested: layout.mix.requested[id] ?? 0, delivered: delivered[id] ?? 0 };
  }
  layout.mix = {
    requested: { ...layout.mix.requested },
    delivered,
    deviation: mixDeviation(layout.mix.requested, delivered, total),
    byTemplate,
  };
}

/** Structural clone of the document (plain data throughout, except the shared corridor graph) */
function clone(base: FloorLayout): FloorLayout {
  return {
    ...base,
    strips: base.strips.map(st => ({ ...st, along: { ...st.along }, across: { ...st.across }, blocked: st.blocked.map(iv => ({ ...iv })), exteriorSides: [...st.exteriorSides] })),
    slots: base.slots.map(cloneSlot),
    corridorSlots: base.corridorSlots?.map(cs => ({ ...cs, rect: { ...cs.rect } })),
    commons: base.commons.map(c => ({ ...c, rect: { ...c.rect } })),
    grid: { module: base.grid.module, bay: { ...base.grid.bay }, lines: Object.fromEntries(Object.entries(base.grid.lines).map(([k, v]) => [k, [...v]])) },
    mix: { ...base.mix, requested: { ...base.mix.requested }, delivered: { ...base.mix.delivered }, byTemplate: { ...base.mix.byTemplate } },
    blocked: Object.fromEntries(Object.entries(base.blocked).map(([k, v]) => [k, v.map(iv => ({ ...iv }))])),
    deviations: [...base.deviations],
  };
}

function cloneSlot(s: Slot): Slot {
  return {
    ...s,
    boundary: { ...s.boundary },
    exteriorSides: [...s.exteriorSides],
    sides: { ...s.sides } as Record<Side, typeof s.sides[Side]>,
    ports: s.ports.map(p => ({ ...p, xy: [p.xy[0], p.xy[1]] })),
    partyLines: [{ ...s.partyLines[0] }, { ...s.partyLines[1] }],
    extraDoors: s.extraDoors?.map(d => ({ ...d })),
    edits: s.edits ? [...s.edits] : undefined,
    deviations: s.deviations ? [...s.deviations] : undefined,
  };
}
