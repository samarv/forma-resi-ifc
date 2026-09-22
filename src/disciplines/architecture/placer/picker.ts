/**
 * The module picker's data (editor design §2d). `candidatesForSlot` makes THE SAME `catalogue.candidatesFor(strip)`
 * call the packer makes, then applies THE SAME `frontageAt(id, strip.netDepth)` filter — so the picker can never
 * offer the user something the packer would refuse, and the swap is the whole correctness argument for the editor.
 *
 * `src/app/edit/picker.ts` (agent A1) wraps this with the thumbnail and the label; everything numeric is here so the
 * engine and the UI cannot drift.
 */
import type { TypologyId } from '../../../core/types.ts';
import type { ModuleCatalogue, UnitModule } from '../../../modules/types.ts';
import type { FeasibilityOpts, Range } from '../program/types.ts';
import type { ClampCtx, FloorLayout, Slot, SlotId } from './types.ts';
import { round } from '../../../core/geometry.ts';
import { UNIT_TEMPLATES } from '../templates.ts';
import { alongOf, frontageOf, neighbourSlack, optsOf, slotsOfStrip, stripOf } from './clamp.ts';

export interface PickerItem {
  moduleId: string;
  label: string;
  /** admissible frontage at THIS slot's net depth */
  frontage: Range;
  /** the slot's current frontage already sits inside `frontage` */
  fitsNow: boolean;
  /** when it does not: the cheaper neighbour to take frontage from, and the grid-snapped delta */
  needsNeighbour?: { slotId: SlotId; delta: number };
  bedrooms: number;
  area: number;
  mix: string;
  current: boolean;
}

export interface PickerOpts {
  /** building-wide mix deficit by template id, so the picker nudges the mix back toward the requested one */
  deficit?: Readonly<Record<string, number>>;
  opts?: FeasibilityOpts;
  /** the typology the strip belongs to — the same argument the packer's `candidatesFor` query carries */
  typology?: TypologyId;
}

export function candidatesForSlot(
  layout: FloorLayout, slotId: SlotId, catalogue: ModuleCatalogue, ctx: ClampCtx, o: PickerOpts = {},
): PickerItem[] {
  const slot = layout.slots.find(s => s.id === slotId);
  const strip = slot ? stripOf(layout, slot) : undefined;
  if (!slot || !strip) return [];
  const opts = o.opts ?? optsOf(ctx);
  const F = frontageOf(slot);
  const slack = neighbourSlack(layout, slot, ctx);
  const lo = F - slack.take;
  const hi = F + slack.give;

  const ends = endsOf(layout, slot, strip.id);
  const ids = catalogue.candidatesFor({
    netDepth: strip.netDepth,
    atStart: ends.atStart,
    atEnd: ends.atEnd,
    exteriorSides: slot.exteriorSides,
    levels: slot.storeySpan?.length ?? 1,
    typology: o.typology ?? 'corridor-midrise',
    region: ctx.region,
  });
  const out: PickerItem[] = [];
  for (const m of ids) {
    const r = catalogue.frontageAt(m.id, strip.netDepth, opts);
    if (!r) continue;                                     // THE depth filter, at the one place netDepth lives
    if (r.max < lo - 1e-6 || r.min > hi + 1e-6) continue; // not reachable even with both neighbours' slack
    const fitsNow = F >= r.min - 0.02 && F <= r.max + 0.02;
    const item: PickerItem = {
      moduleId: m.id,
      label: m.name,
      frontage: { min: round(r.min, 2), max: round(r.max, 2) },
      fitsNow,
      bedrooms: m.bedrooms,
      area: m.areaTarget,
      mix: m.templateId,
      current: m.id === slot.moduleId,
    };
    if (!fitsNow) {
      const want = F < r.min ? r.min - F : r.max - F;
      const n = cheaperNeighbour(layout, slot, want, ctx);
      if (n) item.needsNeighbour = { slotId: n, delta: round(snap(want, ctx.grid.module), 3) };
    }
    out.push(item);
  }
  const deficit = o.deficit ?? {};
  const slotArea = F * strip.netDepth;
  out.sort((a, b) =>
    Number(b.fitsNow) - Number(a.fitsNow)
    || Math.abs(a.area - slotArea) - Math.abs(b.area - slotArea)
    || (deficit[b.mix] ?? 0) - (deficit[a.mix] ?? 0)
    || (a.moduleId < b.moduleId ? -1 : 1));
  return out;
}

/** Is the slot the first or last of its strip? (A bar end admits the corner and end variants.) */
function endsOf(layout: FloorLayout, slot: Slot, stripId: string): { atStart: boolean; atEnd: boolean } {
  const list = slotsOfStrip(layout, stripId);
  const i = list.findIndex(s => s.id === slot.id);
  const strip = layout.strips.find(st => st.id === stripId);
  if (!strip) return { atStart: false, atEnd: false };
  const iv = alongOf(slot);
  return {
    atStart: i === 0 && iv.s <= strip.along.s + 0.05,
    atEnd: i === list.length - 1 && iv.e >= strip.along.e - 0.05,
  };
}

/** The neighbour with the most slack in the needed direction */
function cheaperNeighbour(layout: FloorLayout, slot: Slot, want: number, ctx: ClampCtx): SlotId | null {
  const list = slotsOfStrip(layout, slot.stripId);
  const i = list.findIndex(s => s.id === slot.id);
  let best: SlotId | null = null;
  let bestRoom = 0;
  for (const n of [list[i - 1], list[i + 1]]) {
    if (!n) continue;
    const strip = layout.strips.find(st => st.id === n.stripId);
    const r = strip ? ctx.catalogue.frontageAt(n.moduleId, strip.netDepth, optsOf(ctx)) : null;
    const f = frontageOf(n);
    const room = want > 0 ? (r ? Math.max(0, f - r.min) : 0) : (r ? Math.max(0, r.max - f) : 0);
    if (room > bestRoom + 1e-6) { bestRoom = room; best = n.id; }
  }
  return best;
}

function snap(v: number, module: number): number {
  return module > 1e-6 ? Math.round(v / module) * module : v;
}

/** The template a module belongs to, for the picker's group headers */
export function templateNameOf(m: UnitModule): string {
  return UNIT_TEMPLATES[m.templateId]?.name ?? m.templateId;
}
