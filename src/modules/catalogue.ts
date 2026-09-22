/**
 * `buildCatalogue(rules?)` — the module catalogue, memoised per process by `rules.hash()` (or 'v1' before the rule
 * set lands). Everything the placer and the editor's module picker are allowed to know about a lego comes from here:
 *
 *   frontageAt(id, depth, o)    the EXACT admissible frontage at a net depth, or null when the depth is inadmissible.
 *                               This is THE depth filter; the packer never considers a module it returns null for.
 *   fitFor(id, F, D, o)         the witness for a concrete pair — the only way to obtain a unit layout.
 *   candidatesFor(strip)        unit modules whose variant and envelope suit a strip (cheap pre-filter).
 *   coreFootprintAt(id, f2f)    core footprint along × across the bar.
 */
import type { Region } from '../core/types.ts';
import type { RuleSet } from '../core/rules/types.ts';
import type { Feasibility, FeasibilityOpts, ProgramGraph, Range } from '../disciplines/architecture/program/types.ts';
import type {
  AmenityModule, AnyModule, BreakModule, CoreModule, CorridorModule, MEPRoomModule, ModuleCatalogue,
  ParkingModule, StripQuery, UnitModule,
} from './types.ts';
import { buildUnitModules } from './unit-modules.ts';
import { buildCoreModules, footprintOf } from './core-modules.ts';
import { buildBreakModules, buildCorridorModules } from './corridor-modules.ts';
import { buildMEPModules } from './mep-modules.ts';
import { buildAmenityModules } from './amenity-modules.ts';
import { buildParkingModules } from './parking-modules.ts';
import { UNIT_TEMPLATES } from '../disciplines/architecture/templates.ts';
import { fitFor as programFitFor, frontageAt as programFrontageAt, optsHash, programFor } from './program-source.ts';
import { narrowingFor } from './self-test.ts';

/** The region the frozen envelopes are built for; `frontageAt` is exact for whatever region the caller passes. */
const ENVELOPE_REGION: Region = 'US';

const cache = new Map<string, ModuleCatalogue>();

export function buildCatalogue(rules?: RuleSet): ModuleCatalogue {
  const hash = rules ? rules.hash() : 'v1';
  const hit = cache.get(hash);
  if (hit) return hit;
  const built = make(hash);
  cache.set(hash, built);
  return built;
}

/** Test hook: drop the memo so a test can rebuild with different rules without leaking state */
export function clearCatalogueCache(): void {
  cache.clear();
}

function make(rulesHash: string): ModuleCatalogue {
  return catalogueFrom(rulesHash, buildUnitModules(ENVELOPE_REGION, rulesHash));
}

/**
 * Apply the self-test's verdict: every module whose sweep failed at some depth has its depth envelope narrowed to
 * the largest failure-free interval, and a module with no clean depth is not admitted (design §5). Not on the
 * generate path — the sweep costs ~200 ms — so `buildCatalogue` stays under its 120 ms budget.
 */
export function narrowCatalogue(c: ModuleCatalogue, o?: Parameters<typeof narrowingFor>[1]): ModuleCatalogue {
  const n = narrowingFor(c, o);
  if (n.depth.size === 0 && n.drop.length === 0) return c;
  const drop = new Set(n.drop);
  const units = c.units
    .filter(u => !drop.has(u.id))
    .map(u => {
      const d = n.depth.get(u.id);
      return d ? { ...u, depth: { min: d.min, max: d.max } } : u;
    });
  return catalogueFrom(c.rulesHash, units);
}

export function catalogueFrom(rulesHash: string, units: readonly UnitModule[]): ModuleCatalogue {
  const cores = buildCoreModules();
  const corridors = buildCorridorModules();
  const breaks = buildBreakModules();
  const amenities = buildAmenityModules();
  const mep = buildMEPModules();
  const parking = buildParkingModules();
  const all: AnyModule[] = [...units, ...cores, ...corridors, ...breaks, ...amenities, ...mep, ...parking];
  const byId = new Map<string, AnyModule>(all.map(m => [m.id, m] as const));

  const graphCache = new Map<string, ProgramGraph>();
  const graphOf = (m: UnitModule): ProgramGraph => {
    const hit = graphCache.get(m.id);
    if (hit) return hit;
    const g = programFor(m.templateId);
    graphCache.set(m.id, g);
    return g;
  };
  const optsOf = (m: UnitModule, o: FeasibilityOpts): FeasibilityOpts => ({
    ...o,
    accessible: o.accessible ?? m.templateId === 'senior-1b-accessible',
    rulesHash: o.rulesHash ?? rulesHash,
  });

  // Depth is quantised to 10 mm ONCE, here, and the quantised value is what every downstream computation sees —
  // `frontageAt` and `fitFor` must agree to the last digit or a frontage one admits the other refuses.
  const quantise = (d: number): number => Math.round(d * 100) / 100;

  const frontageMemo = new Map<string, Range | null>();
  const frontageAt = (id: string, depth: number, o: FeasibilityOpts): Range | null => {
    const d = quantise(depth);
    const key = `${id}|${d}|${optsHash(o)}`;
    if (frontageMemo.has(key)) return frontageMemo.get(key) ?? null;
    const m = byId.get(id);
    let out: Range | null = null;
    if (m) {
      if (d < m.depth.min - 1e-6 || d > m.depth.max + 1e-6) out = null;
      else if (m.kind === 'unit') {
        // the solver's exact range INTERSECTED with the module's own envelope: a module is its type, and a frontage
        // that would make it a different type is not admissible for it
        const r = programFrontageAt(graphOf(m), d, optsOf(m, o));
        if (r) {
          const lo = Math.max(r.min, m.frontage.min);
          const hi = Math.min(r.max, m.frontage.max);
          out = lo <= hi + 1e-6 ? { min: round3(lo), max: round3(hi) } : null;
        }
      } else {
        out = { min: m.frontage.min, max: m.frontage.max };
      }
    }
    frontageMemo.set(key, out);
    return out;
  };

  const fitMemo = new Map<string, Feasibility | null>();
  const fitFor = (id: string, frontage: number, depth: number, o: FeasibilityOpts): Feasibility | null => {
    const d = quantise(depth);
    const f = Math.round(frontage * 1000) / 1000;
    const key = `${id}|${Math.round(f * 1000)}|${d}|${optsHash(o)}`;
    if (fitMemo.has(key)) return fitMemo.get(key) ?? null;
    const m = byId.get(id);
    let out: Feasibility | null = null;
    if (m && m.kind === 'unit') {
      const r = frontageAt(id, d, o);
      if (r && f >= r.min - 1e-6 && f <= r.max + 1e-6) {
        const level = Math.min(Math.max(0, o.levels ?? 0), m.levels - 1);
        const w = programFitFor(graphOf(m), f, d, optsOf(m, { ...o, levels: level }));
        // the witness's own frontage range is for the level it solved; the module's is the intersection over levels
        if (w.ok) out = { ...w, frontage: r };
      }
    }
    fitMemo.set(key, out);
    return out;
  };

  const candidatesFor = (strip: StripQuery): UnitModule[] => {
    const suited: UnitModule[] = [];
    const rest: UnitModule[] = [];
    const ends = (strip.atStart ? 1 : 0) + (strip.atEnd ? 1 : 0);
    const exteriorCount = strip.exteriorSides.length + ends;
    for (const m of units) {
      // HARD filters: what the strip physically offers. These are the ones that make "too small for the template"
      // impossible, so nothing may relax them.
      if (m.levels > Math.max(1, strip.levels)) continue;
      if (strip.netDepth < m.depth.min - 1e-6 || strip.netDepth > m.depth.max + 1e-6) continue;
      if (m.needs.endOfBar && ends === 0) continue;
      if (m.needs.minExteriorCount > exteriorCount) continue;
      // SOFT filter: the template's own typology list is a preference. A 5.2 m deep pocket beside a podium tower's
      // core is still better as a micro-studio than as leftover floor area, even though micro-studio does not list
      // podium-tower — so the unsuited set is offered only when the suited one is empty.
      const t = UNIT_TEMPLATES[m.templateId];
      if (t.suitableTypologies.length === 0 || t.suitableTypologies.includes(strip.typology)) suited.push(m);
      else rest.push(m);
    }
    const out = suited.length > 0 ? suited : rest;
    out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return out;
  };

  const footMemo = new Map<string, { along: number; across: number }>();
  const coreFootprintAt = (id: string, f2f: number): { along: number; across: number } => {
    const key = `${id}|${Math.round(f2f * 100)}`;
    const hit = footMemo.get(key);
    if (hit) return hit;
    const m = byId.get(id);
    const v = m && m.kind === 'core'
      ? footprintOf(m, f2f)
      : { along: 5.0, across: 4.0 };
    footMemo.set(key, v);
    return v;
  };

  return {
    all,
    byId: (id: string) => byId.get(id),
    units,
    cores,
    breaks,
    amenities,
    mep,
    parking,
    frontageAt,
    fitFor,
    candidatesFor,
    coreFootprintAt,
    rulesHash,
  };
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** Typed lookups so callers do not have to narrow `AnyModule` by hand */
export function unitModule(c: ModuleCatalogue, id: string): UnitModule | undefined {
  const m = c.byId(id);
  return m && m.kind === 'unit' ? m : undefined;
}
export function coreModule(c: ModuleCatalogue, id: string): CoreModule | undefined {
  const m = c.byId(id);
  return m && m.kind === 'core' ? m : undefined;
}
export function breakModule(c: ModuleCatalogue, id: string): BreakModule | undefined {
  const m = c.byId(id);
  return m && m.kind === 'break' ? m : undefined;
}
export function amenityModule(c: ModuleCatalogue, id: string): AmenityModule | undefined {
  const m = c.byId(id);
  return m && m.kind === 'amenity' ? m : undefined;
}
export function mepModule(c: ModuleCatalogue, id: string): MEPRoomModule | undefined {
  const m = c.byId(id);
  return m && m.kind === 'mep' ? m : undefined;
}
export function corridorModule(c: ModuleCatalogue, id: string): CorridorModule | undefined {
  const m = c.byId(id);
  return m && m.kind === 'corridor' ? m : undefined;
}
export function parkingModule(c: ModuleCatalogue, id: string): ParkingModule | undefined {
  const m = c.byId(id);
  return m && m.kind === 'parking' ? m : undefined;
}

/** The narrowest admissible dwelling frontage at a depth — the bound a remnant must stay below (design §4.6) */
export function narrowestUnitFrontage(
  c: ModuleCatalogue, candidates: readonly UnitModule[], depth: number, o: FeasibilityOpts,
): number {
  let m = Infinity;
  for (const u of candidates) {
    const r = c.frontageAt(u.id, depth, o);
    if (r) m = Math.min(m, r.min);
  }
  return m;
}
