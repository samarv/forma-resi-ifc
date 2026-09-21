/**
 * F6 — Editor overrides stored in the spec (spec.overrides). Pure types + a stable hash; no logic.
 *
 * Overrides are applied deterministically between planFloorLayout and instantiateFloor. `layouts` is keyed by the
 * typical-floor identity (FloorLayout.key) and therefore applies to every storey sharing that plan; `storeys` is keyed
 * by storey id for one-off floors and is applied after the layout edits. Ids are the placer's stable slot ids
 * ('S-<barId>-<strip>-<nnn>', inserted slots 'S-…-007.1'); in-unit refs are program-node refs ('bedroom2',
 * door 'entry1~hall1', partition 'refA|refB', furniture 'roomRef#kitSlot') — never minted element ids.
 */
import type { DoorMotion, FurnitureType, RoomType } from './types.ts';

export type SlotId = string;
export type StripId = string;

export type LayoutEdit =
  | { op: 'swapModule'; slotId: SlotId; moduleId: string }
  | { op: 'mirror'; slotId: SlotId; mirrored: boolean }
  | { op: 'moveBoundary'; slotId: SlotId; edge: 'start' | 'end'; delta: number }
  | { op: 'insertSlot'; stripId: StripId; afterSlotId: SlotId | null; moduleId: string; frontage?: number }
  | { op: 'removeSlot'; slotId: SlotId }
  | { op: 'setSlotKind'; slotId: SlotId; kind: 'common' | 'remnant' | 'amenity'; roomType?: RoomType }
  | { op: 'moveCore'; coreId: string; along: number }
  | { op: 'unit'; slotId: SlotId; edits: UnitEdit[] };

export type UnitEdit =
  | { op: 'flipDoor'; doorRef: string }                                   // swaps the hinge end
  | { op: 'reverseDoor'; doorRef: string }                                // swaps the swing side
  | { op: 'moveDoor'; doorRef: string; along: number }
  | { op: 'setDoorMotion'; doorRef: string; motion: DoorMotion }
  | { op: 'dragPartition'; edgeRef: string; delta: number }
  | { op: 'moveFurniture'; itemRef: string; du: number; dv: number; rotate?: number }
  | { op: 'addFurniture'; roomRef: string; type: FurnitureType; u: number; v: number; rotation: number }
  | { op: 'removeFurniture'; itemRef: string }
  | { op: 'swapRoomType'; roomRef: string; type: RoomType };

export interface OverrideDoc {
  version: 1;
  /** keyed by FloorLayout.key → applies to every storey sharing that typical plan */
  layouts?: Record<string, LayoutEdit[]>;
  /** keyed by storeyId → applied after the layout edits, for a one-off floor */
  storeys?: Record<string, LayoutEdit[]>;
}

export type OverrideScope = { kind: 'typical'; key: string } | { kind: 'storey'; storeyId: string };

/** Canonical JSON (sorted keys) so hashes do not depend on insertion order */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter(k => o[k] !== undefined).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

/** FNV-1a 32-bit over the canonical JSON, as 8 hex digits; '0' for no edits */
export function hashEdits(edits: readonly LayoutEdit[] | undefined): string {
  if (!edits || edits.length === 0) return '0';
  return fnv1a(canonicalJson(edits));
}

export function hashOverrides(doc: OverrideDoc | undefined): string {
  if (!doc) return '0';
  return fnv1a(canonicalJson(doc));
}

export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Edits for a layout key + storey, in application order (layout edits first, then storey edits) */
export function editsFor(doc: OverrideDoc | undefined, layoutKey: string, storeyId: string): LayoutEdit[] {
  if (!doc) return [];
  return [...(doc.layouts?.[layoutKey] ?? []), ...(doc.storeys?.[storeyId] ?? [])];
}
