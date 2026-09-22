/**
 * `clampLayoutEdit` — the SAME function `applyOverrides` and the editor's drag reducer call, which is the entire
 * correctness argument for the editor: the ghost the user drags and the model that comes back cannot disagree,
 * because the admissible range was computed once, here, from the module catalogue and the planning grid.
 *
 * Contract (frozen in `placer/types.ts`): TOTAL (never throws), PURE, IDEMPOTENT (`clamp(clamp(e)) === clamp(e)`),
 * and `range` is the admissible closed interval of the edit's own scalar so the overlay can draw a rail even when the
 * pointer is outside it. `ok: false` + `reason` when no legal value exists at all.
 */
import type { Side } from '../../../core/types.ts';
import type { LayoutEdit } from '../../../core/overrides.ts';
import type { FeasibilityOpts, Range } from '../program/types.ts';
import type { ClampCtx, ClampResult, FloorLayout, Slot, StripDef } from './types.ts';
import { round } from '../../../core/geometry.ts';

const EPS = 1e-6;

export function optsOf(ctx: ClampCtx): FeasibilityOpts {
  return { region: ctx.region, levels: ctx.level, detail: 'medium', rulesHash: ctx.catalogue.rulesHash };
}

/** Along-bar interval of a slot: the axis is decided by which side the access is on, never guessed from the rect */
export function alongOf(slot: Slot): { s: number; e: number } {
  const horizontal = slot.accessSide === 'front' || slot.accessSide === 'rear';
  return horizontal
    ? { s: slot.boundary.x, e: slot.boundary.x + slot.boundary.w }
    : { s: slot.boundary.y, e: slot.boundary.y + slot.boundary.h };
}

export function frontageOf(slot: Slot): number {
  const iv = alongOf(slot);
  return iv.e - iv.s;
}

export function setAlong(slot: Slot, s: number, e: number): void {
  const horizontal = slot.accessSide === 'front' || slot.accessSide === 'rear';
  if (horizontal) {
    slot.boundary = { ...slot.boundary, x: round(s, 4), w: round(e - s, 4) };
  } else {
    slot.boundary = { ...slot.boundary, y: round(s, 4), h: round(e - s, 4) };
  }
  slot.partyLines = [
    { at: round(s, 4), column: slot.partyLines[0].column },
    { at: round(e, 4), column: slot.partyLines[1].column },
  ];
}

export function stripOf(layout: FloorLayout, slot: Slot): StripDef | undefined {
  return layout.strips.find(st => st.id === slot.stripId);
}

/** The slot's module range at its own strip depth, or null when the module is not admissible there */
export function rangeOfSlot(layout: FloorLayout, slot: Slot, ctx: ClampCtx): Range | null {
  const strip = stripOf(layout, slot);
  if (!strip) return null;
  return ctx.catalogue.frontageAt(slot.moduleId, strip.netDepth, optsOf(ctx));
}

/** Slots of a strip in along order (the packing order, and the order the editor's handles follow) */
export function slotsOfStrip(layout: FloorLayout, stripId: string): Slot[] {
  return layout.slots
    .filter(s => s.stripId === stripId)
    .sort((a, b) => alongOf(a).s - alongOf(b).s);
}

function neighbourAt(layout: FloorLayout, slot: Slot, edge: 'start' | 'end'): Slot | undefined {
  const list = slotsOfStrip(layout, slot.stripId);
  const i = list.findIndex(s => s.id === slot.id);
  if (i < 0) return undefined;
  return edge === 'start' ? list[i - 1] : list[i + 1];
}

function snap(v: number, module: number): number {
  return module > EPS ? Math.round(v / module) * module : v;
}

export function clampLayoutEdit(layout: FloorLayout, edit: LayoutEdit, ctx: ClampCtx): ClampResult<LayoutEdit> {
  switch (edit.op) {
    case 'swapModule': return clampSwap(layout, edit, ctx);
    case 'mirror': return clampMirror(layout, edit);
    case 'moveBoundary': return clampMoveBoundary(layout, edit, ctx);
    case 'insertSlot': return clampInsert(layout, edit, ctx);
    case 'removeSlot': return clampRemove(layout, edit);
    case 'setSlotKind': return clampSetKind(layout, edit);
    case 'moveCore': return clampMoveCore(layout, edit, ctx);
    case 'unit': return clampUnit(layout, edit);
    default: return { edit, ok: false, reason: 'unknown edit' };
  }
}

// ---------------------------------------------------------------------------------------------------------------

function clampSwap(layout: FloorLayout, edit: LayoutEdit & { op: 'swapModule' }, ctx: ClampCtx): ClampResult<LayoutEdit> {
  const slot = layout.slots.find(s => s.id === edit.slotId);
  if (!slot) return { edit, ok: false, reason: `no slot ${edit.slotId}` };
  const strip = stripOf(layout, slot);
  if (!strip) return { edit, ok: false, reason: `slot ${edit.slotId} has no strip` };
  const mod = ctx.catalogue.byId(edit.moduleId);
  if (!mod) return { edit, ok: false, reason: `no module ${edit.moduleId}` };
  const r = ctx.catalogue.frontageAt(edit.moduleId, strip.netDepth, optsOf(ctx));
  if (!r) {
    return { edit, ok: false, reason: `${edit.moduleId} is not admissible at ${round(strip.netDepth, 2)} m depth` };
  }
  const F = frontageOf(slot);
  if (F >= r.min - 0.02 && F <= r.max + 0.02) return { edit, ok: true, range: [r.min, r.max] };
  // it does not fit as-is: can the neighbours give or take enough slack?
  const slack = neighbourSlack(layout, slot, ctx);
  const lo = F - slack.take;
  const hi = F + slack.give;
  if (r.max < lo - EPS || r.min > hi + EPS) {
    return { edit, ok: false, reason: `${edit.moduleId} needs ${round(r.min, 2)}–${round(r.max, 2)} m and this slot can only reach ${round(lo, 2)}–${round(hi, 2)} m`, range: [r.min, r.max] };
  }
  return { edit, ok: true, range: [r.min, r.max] };
}

/** How much frontage the ≤ 2 neighbours can give this slot, and how much they can take from it */
export function neighbourSlack(layout: FloorLayout, slot: Slot, ctx: ClampCtx): { give: number; take: number } {
  let give = 0;
  let take = 0;
  for (const edge of ['start', 'end'] as const) {
    const n = neighbourAt(layout, slot, edge);
    if (!n) continue;
    const r = rangeOfSlot(layout, n, ctx);
    const f = frontageOf(n);
    if (!r) { give += Math.max(0, f - 1.0); continue; }
    give += Math.max(0, f - r.min);
    take += Math.max(0, r.max - f);
  }
  return { give: round(give, 3), take: round(take, 3) };
}

function clampMirror(layout: FloorLayout, edit: LayoutEdit & { op: 'mirror' }): ClampResult<LayoutEdit> {
  const slot = layout.slots.find(s => s.id === edit.slotId);
  if (!slot) return { edit, ok: false, reason: `no slot ${edit.slotId}` };
  return { edit, ok: true };
}

function clampMoveBoundary(
  layout: FloorLayout, edit: LayoutEdit & { op: 'moveBoundary' }, ctx: ClampCtx,
): ClampResult<LayoutEdit> {
  const slot = layout.slots.find(s => s.id === edit.slotId);
  if (!slot) return { edit, ok: false, reason: `no slot ${edit.slotId}` };
  const other = neighbourAt(layout, slot, edit.edge);
  if (!other) return { edit, ok: false, reason: `slot ${edit.slotId} has no neighbour at its ${edit.edge}` };
  const rA = rangeOfSlot(layout, slot, ctx);
  const rB = rangeOfSlot(layout, other, ctx);
  const fA = frontageOf(slot);
  const fB = frontageOf(other);
  const openA: Range = rA ?? { min: Math.min(fA, 1.0), max: Math.max(fA, 60) };
  const openB: Range = rB ?? { min: Math.min(fB, 1.0), max: Math.max(fB, 60) };
  // moving the START edge by +delta shrinks THIS slot and grows the neighbour before it, and vice versa
  const sign = edit.edge === 'start' ? -1 : 1;
  let lo = Math.max(openA.min - fA, fB - openB.max);
  let hi = Math.min(openA.max - fA, fB - openB.min);
  if (hi < lo) { const mid = (lo + hi) / 2; lo = mid; hi = mid; }
  const wantSigned = edit.delta * sign;
  const clampedSigned = Math.max(lo, Math.min(hi, wantSigned));
  // land the boundary itself on the planning module
  const boundary = edit.edge === 'start' ? alongOf(slot).s : alongOf(slot).e;
  const snapped = snap(boundary + clampedSigned * sign, ctx.grid.module) - boundary;
  const finalSigned = Math.max(lo, Math.min(hi, snapped * sign));
  const delta = round(finalSigned * sign, 3);
  return {
    edit: { ...edit, delta },
    ok: Math.abs(hi - lo) > EPS || Math.abs(delta) < EPS,
    reason: Math.abs(hi - lo) <= EPS ? 'both slots are already at a limit of their admissible frontage' : undefined,
    range: [round(lo * sign, 3), round(hi * sign, 3)].sort((a, b) => a - b) as [number, number],
  };
}

function clampInsert(
  layout: FloorLayout, edit: LayoutEdit & { op: 'insertSlot' }, ctx: ClampCtx,
): ClampResult<LayoutEdit> {
  const strip = layout.strips.find(st => st.id === edit.stripId);
  if (!strip) return { edit, ok: false, reason: `no strip ${edit.stripId}` };
  const r = ctx.catalogue.frontageAt(edit.moduleId, strip.netDepth, optsOf(ctx));
  if (!r) return { edit, ok: false, reason: `${edit.moduleId} is not admissible at ${round(strip.netDepth, 2)} m depth` };
  const list = slotsOfStrip(layout, edit.stripId);
  const anchor = edit.afterSlotId ? list.find(s => s.id === edit.afterSlotId) : undefined;
  if (edit.afterSlotId && !anchor) return { edit, ok: false, reason: `no anchor slot ${edit.afterSlotId}` };
  // the new slot's frontage comes out of its neighbours, down to THEIR minima — never by overlapping
  let available = 0;
  const donors = anchor ? [anchor, neighbourAt(layout, anchor, 'end')] : [list[0]];
  for (const d of donors) {
    if (!d) continue;
    const dr = rangeOfSlot(layout, d, ctx);
    available += Math.max(0, frontageOf(d) - (dr?.min ?? 1.0));
  }
  if (available < r.min - EPS) {
    return {
      edit, ok: false,
      reason: `inserting ${edit.moduleId} needs ${round(r.min, 2)} m and the neighbours can only free ${round(available, 2)} m`,
      range: [r.min, r.max],
    };
  }
  const want = edit.frontage ?? Math.min(r.max, available);
  const frontage = round(snap(Math.max(r.min, Math.min(Math.min(r.max, available), want)), ctx.grid.module), 3);
  return { edit: { ...edit, frontage }, ok: true, range: [r.min, round(Math.min(r.max, available), 3)] };
}

function clampRemove(layout: FloorLayout, edit: LayoutEdit & { op: 'removeSlot' }): ClampResult<LayoutEdit> {
  const slot = layout.slots.find(s => s.id === edit.slotId);
  if (!slot) return { edit, ok: false, reason: `no slot ${edit.slotId}` };
  if (slot.kind === 'core') return { edit, ok: false, reason: 'a core slot cannot be removed from the floor plan' };
  return { edit, ok: true };
}

function clampSetKind(layout: FloorLayout, edit: LayoutEdit & { op: 'setSlotKind' }): ClampResult<LayoutEdit> {
  const slot = layout.slots.find(s => s.id === edit.slotId);
  if (!slot) return { edit, ok: false, reason: `no slot ${edit.slotId}` };
  if (slot.kind === 'core') return { edit, ok: false, reason: 'a core slot cannot change kind' };
  return { edit, ok: true };
}

function clampMoveCore(
  layout: FloorLayout, edit: LayoutEdit & { op: 'moveCore' }, ctx: ClampCtx,
): ClampResult<LayoutEdit> {
  // Admissible positions along the bar: 6 m clear of either end, and on a break slot the site graph reserved when
  // the graph is available (that is where a core is meant to go).
  const slots = layout.slots.filter(s => s.coreId === edit.coreId);
  const strip = slots.length > 0 ? stripOf(layout, slots[0]) : layout.strips[0];
  if (!strip) return { edit, ok: false, reason: 'no strip to move the core along' };
  const clearance = 6.0;
  const lo = strip.along.s + clearance;
  const hi = strip.along.e - clearance;
  if (hi < lo) return { edit, ok: false, reason: 'the bar is too short to move a core along it', range: [lo, lo] };
  const stations = (layout.corridor?.breakSlots ?? [])
    .filter(b => b.barId === strip.barId && b.want === 'core')
    .map(b => strip.along.s + b.station);
  let along = Math.max(lo, Math.min(hi, edit.along));
  if (stations.length > 0) {
    along = stations.reduce((best, s) => (Math.abs(s - along) < Math.abs(best - along) ? s : best), stations[0]);
    along = Math.max(lo, Math.min(hi, along));
  } else {
    along = snap(along, ctx.grid.module);
  }
  return { edit: { ...edit, along: round(along, 3) }, ok: true, range: [round(lo, 3), round(hi, 3)] };
}

function clampUnit(layout: FloorLayout, edit: LayoutEdit & { op: 'unit' }): ClampResult<LayoutEdit> {
  const slot = layout.slots.find(s => s.id === edit.slotId);
  if (!slot) return { edit, ok: false, reason: `no slot ${edit.slotId}` };
  if (slot.kind !== 'unit') return { edit, ok: false, reason: `slot ${edit.slotId} is not a dwelling` };
  // the individual UnitEdits are clamped by the solver's `clampUnitEdit`, against the program and the room rects
  return { edit, ok: true };
}

export type { Side };
