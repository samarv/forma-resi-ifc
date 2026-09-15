/** DOM + formatting helpers. Pure functions here are unit-tested in util.test.ts. */
import { M_TO_FT, M2_TO_FT2, fmtArea, fmtLength, type DisplayUnits } from '../core/units.ts';

// ------------------------------------------------------------------ strings
export function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 'corridor-midrise' → 'Corridor midrise' */
export function humanize(id: string): string {
  const s = String(id ?? '').replace(/[-_]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// ---------------------------------------------------------------- numbers
/** Compact SVG/number formatting: max 3 decimals, no trailing zeros, no "-0". */
export function n3(v: number): string {
  if (!Number.isFinite(v)) return '0';
  const r = Math.round(v * 1000) / 1000;
  return (r === 0 ? 0 : r).toString();
}

export function compact(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${(v / 1e3).toFixed(1)}K`;
  return Number.isInteger(v) ? v.toLocaleString('en-US') : v.toFixed(a < 10 ? 2 : 1);
}

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  return ms < 1000 ? `${ms.toFixed(0)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

// ------------------------------------------------------------- unit display
export const lenUnit = (u: DisplayUnits): string => (u === 'imperial' ? 'ft' : 'm');
export const areaUnit = (u: DisplayUnits): string => (u === 'imperial' ? 'sf' : 'm²');

/** metres → the number shown in an input for the current display units */
export function lenIn(m: number, u: DisplayUnits, decimals = 2): number {
  const v = u === 'imperial' ? m * M_TO_FT : m;
  const p = 10 ** decimals;
  return Math.round(v * p) / p;
}
/** input number in display units → metres */
export function lenOut(v: number, u: DisplayUnits): number {
  return u === 'imperial' ? v / M_TO_FT : v;
}
export function areaIn(m2: number, u: DisplayUnits): number {
  return u === 'imperial' ? Math.round(m2 * M2_TO_FT2) : Math.round(m2 * 10) / 10;
}
export function areaOut(v: number, u: DisplayUnits): number {
  return u === 'imperial' ? v / M2_TO_FT2 : v;
}
export { fmtArea, fmtLength };
/** Plain length with a unit suffix (no feet-and-inches), for tables and labels. */
export function fmtLenPlain(m: number, u: DisplayUnits, decimals = 2): string {
  return u === 'imperial' ? `${(m * M_TO_FT).toFixed(decimals)} ft` : `${m.toFixed(decimals)} m`;
}

// -------------------------------------------------------------------- DOM
export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`#${id} missing`);
  return e as T;
}
export function q<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T | null {
  return root.querySelector(sel) as T | null;
}
export function qa<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T[] {
  return Array.from(root.querySelectorAll(sel)) as T[];
}
export function setHtml(target: HTMLElement, html: string): void {
  target.innerHTML = html;
}

/** Delegated listener: fires when the event target is inside `sel` within `root`. */
export function delegate<E extends Event>(
  root: HTMLElement, type: string, sel: string, fn: (el: HTMLElement, ev: E) => void,
): void {
  root.addEventListener(type, (ev) => {
    const t = ev.target as HTMLElement | null;
    if (!t) return;
    const match = t.closest(sel) as HTMLElement | null;
    if (match && root.contains(match)) fn(match, ev as E);
  });
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): (...a: A) => void {
  let t: ReturnType<typeof setTimeout> | null = null;
  return (...a: A) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => { t = null; fn(...a); }, ms);
  };
}

/**
 * Yield to the browser so the spinner paints before a long synchronous run.
 * rAF is paused in hidden/background tabs, so a timer always races it — otherwise
 * generation would never start in a backgrounded tab.
 */
export function nextFrame(timeoutMs = 60): Promise<void> {
  return new Promise((res) => {
    let done = false;
    const finish = () => { if (!done) { done = true; res(); } };
    try {
      requestAnimationFrame(() => requestAnimationFrame(finish));
    } catch { /* no rAF: the timer covers it */ }
    setTimeout(finish, timeoutMs);
  });
}

// ------------------------------------------------------------------ colours
/** Categorical slot for a stable key (fixed order, never rank-dependent). */
export function slotFor(key: string, slots = 8): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = ((h ^ key.charCodeAt(i)) * 16777619) >>> 0;
  return (h % slots) + 1;
}
export function slotVar(key: string): string {
  return `var(--s${slotFor(key)})`;
}

export const DISCIPLINE_VAR: Record<string, string> = {
  architecture: 'var(--dwg-wall-ext)',
  structure: 'var(--dwg-struct)',
  mechanical: 'var(--dwg-mech)',
  plumbing: 'var(--dwg-plumb)',
  electrical: 'var(--dwg-elec)',
  site: 'var(--dwg-site)',
};

export const STATUS_CLASS: Record<string, string> = { ok: 'st-ok', warn: 'st-warn', fail: 'st-fail' };
export const STATUS_GLYPH: Record<string, string> = { ok: '●', warn: '▲', fail: '■' };
export const STATUS_WORD: Record<string, string> = { ok: 'OK', warn: 'Check', fail: 'Fail' };
