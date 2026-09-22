/**
 * Module id grammar (F5b §2.3). Ids are the stable identity of a lego: they appear in `Slot.moduleId`, in override
 * documents (`{ op:'swapModule', moduleId }`) and in the module picker, so they must be derivable from the record's
 * own fields and never depend on iteration order.
 *
 *   unit      U-<templateId>-<variant>        U-2b2b-single, U-2b2b-corner, U-townhouse-2s-end
 *   core      C-<stair>[-lift<n>]             C-dogleg, C-dogleg-lift2, C-scissor-lift4
 *   break     K-<role>                        K-lounge, K-lift-lobby, K-window-bay, K-cross, K-exit-stair
 *   corridor  X-<width×100>                   X-150, X-180, X-240
 *   amenity   A-<role>                        A-gym, A-lounge, A-coworking, A-bike, A-mail, A-parcel
 *   mep       M-<role>                        M-switchroom, M-water-entry, M-sump
 *   parking   P-<role>[-<angle>]              P-double-90, P-single-90, P-ramp
 *
 * `mirrored` is NOT part of the id: mirroring is u → 1 − u on the frozen shape, so it is an instance property of the
 * slot and the catalogue stays ~45 unit records instead of ~90.
 */
import type { UnitTemplateId } from '../core/types.ts';
import type { BreakRole, MEPRoomRole, ModuleKind, StairConfig, UnitVariant } from './types.ts';

export const KIND_PREFIX: Record<ModuleKind, string> = {
  unit: 'U',
  core: 'C',
  corridor: 'X',
  break: 'K',
  amenity: 'A',
  mep: 'M',
  parking: 'P',
};

/** 'dog-leg' reads as 'dogleg' in an id (no double hyphen, so parsing stays unambiguous) */
export function stairToken(stair: StairConfig): string {
  return stair === 'dog-leg' ? 'dogleg' : stair;
}

export function unitModuleId(templateId: UnitTemplateId, variant: UnitVariant): string {
  return `U-${templateId}-${variant}`;
}

export function coreModuleId(stair: StairConfig, lifts: number): string {
  return lifts > 0 ? `C-${stairToken(stair)}-lift${lifts}` : `C-${stairToken(stair)}`;
}

/** 'cross-corridor' shortens to 'cross' (the design's table) */
export function breakModuleId(role: BreakRole): string {
  return `K-${role === 'cross-corridor' ? 'cross' : role}`;
}

export function corridorModuleId(width: number): string {
  return `X-${Math.round(width * 100)}`;
}

export function amenityModuleId(role: string): string {
  return `A-${role}`;
}

export function mepModuleId(role: MEPRoomRole): string {
  return `M-${role}`;
}

export function parkingModuleId(role: 'double-loaded' | 'single-loaded' | 'ramp', angle?: number): string {
  const base = role === 'double-loaded' ? 'double' : role === 'single-loaded' ? 'single' : 'ramp';
  return angle === undefined ? `P-${base}` : `P-${base}-${Math.round(angle)}`;
}

export interface ParsedModuleId {
  kind: ModuleKind;
  /** everything after the one-letter prefix */
  rest: string;
}

const BY_PREFIX = new Map<string, ModuleKind>(
  (Object.entries(KIND_PREFIX) as [ModuleKind, string][]).map(([k, p]) => [p, k] as const),
);

export function parseModuleId(id: string): ParsedModuleId | null {
  const m = /^([UCXKAMP])-(.+)$/.exec(id);
  if (!m) return null;
  const kind = BY_PREFIX.get(m[1]);
  if (!kind) return null;
  return { kind, rest: m[2] };
}

/**
 * Split a unit module id into template + variant. Both halves may contain hyphens ('U-dual-key-dual-key'), so the
 * variant is matched as the LONGEST known suffix rather than "everything after the last hyphen".
 */
function splitUnitId(id: string): { templateId: UnitTemplateId; variant: UnitVariant } | null {
  const p = parseModuleId(id);
  if (!p || p.kind !== 'unit') return null;
  let best: UnitVariant | null = null;
  for (const v of VARIANTS) {
    if (!p.rest.endsWith(`-${v}`)) continue;
    if (!best || v.length > best.length) best = v;
  }
  if (!best) return null;
  return { templateId: p.rest.slice(0, p.rest.length - best.length - 1) as UnitTemplateId, variant: best };
}

/** The variant suffix of a unit module id ('U-townhouse-2s-end' → 'end'), or null */
export function variantOf(id: string): UnitVariant | null {
  return splitUnitId(id)?.variant ?? null;
}

/** The template id of a unit module id ('U-townhouse-2s-end' → 'townhouse-2s'), or null */
export function templateOf(id: string): UnitTemplateId | null {
  return splitUnitId(id)?.templateId ?? null;
}

/** Longest first, so 'dual-key' wins over 'dual' when both match a suffix */
export const VARIANTS: UnitVariant[] = ['dual-key', 'cluster', 'corner', 'single', 'dual', 'end'];
