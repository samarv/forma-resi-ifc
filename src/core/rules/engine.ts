/**
 * The rule engine: resolve the rule set (built-ins + lifted pattern parameters + profiles + project overrides +
 * custom rules), read parameters through it, and re-check the finished model against the constraint rules.
 *
 * Determinism is structural: rules are sorted by id, `forSubject` returns them in id order, subjects are visited in
 * a canonical order (storey index → id), and nothing iterates a `Map` whose order could depend on insertion.
 */
import type { BuildingSpec, TypologyDef } from '../types.ts';
import { canonicalJson, fnv1a } from '../overrides.ts';
import type {
  Deviation, Issue, Ledger, Rule, RuleOverrides, RuleScope, RuleSet, ScopeContext, Severity, Subject, SubjectKind,
  World,
} from './types.ts';
import { PREDICATES } from './predicates.ts';
import { elementKindOf } from '../kernel/validate.ts';
import { RULE_PROFILES, RULE_PROFILE_NAMES } from './builtin.ts';
import { customToRule } from './schema.ts';

export interface CreateRuleSetInput {
  builtin: readonly Rule[];
  fromPatterns: readonly Rule[];
  overrides?: RuleOverrides;
  spec: BuildingSpec;
  typology: TypologyDef;
  ledger: Ledger;
  /** Profiles the caller forces on (e.g. 'high-rise' after a storey-count override) */
  profiles?: readonly string[];
}

const SUBJECT_KINDS: readonly SubjectKind[] = ['building', 'floor', 'unit', 'room', 'door', 'corridor', 'element', 'run', 'support'];

function byId(a: Rule, b: Rule): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Does a rule's scope admit this context? A facet the context cannot answer is a non-match. */
export function scopeMatches(scope: RuleScope, ctx: ScopeContext): boolean {
  if (scope.floorUse) {
    if (!ctx.floorUse || !scope.floorUse.includes(ctx.floorUse)) return false;
  }
  if (scope.roomType) {
    if (!ctx.roomType || !scope.roomType.includes(ctx.roomType)) return false;
  }
  if (scope.elementKinds) {
    if (!ctx.elementKind || !scope.elementKinds.includes(ctx.elementKind)) return false;
  }
  if (scope.templateIds) {
    if (!ctx.templateId || !scope.templateIds.includes(ctx.templateId)) return false;
  }
  if (scope.storeys) {
    if (!ctx.storey || !scope.storeys.includes(ctx.storey)) return false;
  }
  if (scope.storeyIndexMin !== undefined) {
    if (ctx.storeyIndex === undefined || ctx.storeyIndex < scope.storeyIndexMin) return false;
  }
  if (scope.storeyIndexMax !== undefined) {
    if (ctx.storeyIndex === undefined || ctx.storeyIndex > scope.storeyIndexMax) return false;
  }
  if (scope.typologies) {
    if (!ctx.typology || !scope.typologies.includes(ctx.typology)) return false;
  }
  if (scope.regions) {
    if (!ctx.region || !scope.regions.includes(ctx.region)) return false;
  }
  if (scope.sprinklered !== undefined) {
    if (ctx.sprinklered !== scope.sprinklered) return false;
  }
  return true;
}

/** The profiles a spec switches on by itself, in canonical order. */
export function autoProfiles(spec: BuildingSpec, typology: TypologyDef, highRiseStoreys: number): string[] {
  const out: string[] = [];
  if (spec.massing.storeys >= highRiseStoreys) out.push('high-rise');
  if (typology.sprinklered) out.push('sprinklered');
  if (spec.region === 'UK' || spec.region === 'IE') out.push('uk');
  if (spec.region === 'US' || spec.region === 'CA') out.push('us');
  return out;
}

export function createRuleSet(o: CreateRuleSetInput): RuleSet {
  const map = new Map<string, Rule>();
  // Lifted pattern parameters first, so a hand-authored built-in of the same id wins (it is the corrected value).
  for (const r of o.fromPatterns) map.set(r.id, r);
  const overriddenPatternParams: string[] = [];
  for (const r of o.builtin) {
    if (map.has(r.id)) overriddenPatternParams.push(r.id);
    map.set(r.id, r);
  }

  const highRiseStoreys = (() => {
    const r = map.get('XD-06.highRiseStoreys');
    const v = r?.params.value?.value;
    return typeof v === 'number' ? v : 8;
  })();

  const wanted = new Set<string>([...autoProfiles(o.spec, o.typology, highRiseStoreys), ...(o.profiles ?? []), ...(o.overrides?.profiles ?? [])]);
  const applied: string[] = [];
  for (const name of RULE_PROFILE_NAMES) {
    if (!wanted.has(name)) continue;
    applied.push(name);
    for (const r of RULE_PROFILES[name]) map.set(r.id, r);
  }
  for (const name of [...wanted].sort()) {
    if (RULE_PROFILE_NAMES.includes(name)) continue;
    o.ledger.add({
      severity: 'error', ruleId: 'USR-SCHEMA', discipline: 'xd',
      message: `unknown rule profile '${name}'; known profiles are ${RULE_PROFILE_NAMES.join(', ')}`,
    });
  }

  // Project parameter overrides (validated by validateRuleOverrides before they get here).
  const ov = o.overrides;
  if (ov?.params) {
    for (const ruleId of Object.keys(ov.params).sort()) {
      const rule = map.get(ruleId);
      if (!rule) {
        o.ledger.add({
          severity: 'error', ruleId: 'USR-SCHEMA', discipline: 'xd',
          message: `rule override for unknown rule '${ruleId}'`,
        });
        continue;
      }
      const params = { ...rule.params };
      for (const name of Object.keys(ov.params[ruleId]).sort()) {
        const prev = params[name];
        if (!prev) {
          o.ledger.add({
            severity: 'error', ruleId: 'USR-SCHEMA', discipline: 'xd',
            message: `rule override for unknown parameter '${ruleId}.${name}'`,
          });
          continue;
        }
        const value = ov.params[ruleId][name];
        if (typeof value !== typeof prev.value) {
          o.ledger.add({
            severity: 'error', ruleId: 'USR-SCHEMA', discipline: 'xd',
            message: `rule override '${ruleId}.${name}' expects a ${typeof prev.value}, got ${typeof value}`,
          });
          continue;
        }
        params[name] = { value, unit: prev.unit, source: 'spec' };
        o.ledger.add({
          severity: 'deviation', ruleId, discipline: rule.discipline,
          message: `${ruleId}.${name} overridden by the project`,
          observed: String(value), limit: String(prev.value), source: prev.source,
          resolution: { id: 'none', from: String(prev.value), to: String(value), note: 'spec.rules.params' },
        });
      }
      map.set(ruleId, { ...rule, params });
    }
  }
  if (ov?.severity) {
    for (const ruleId of Object.keys(ov.severity).sort()) {
      const rule = map.get(ruleId);
      if (!rule) {
        o.ledger.add({ severity: 'error', ruleId: 'USR-SCHEMA', discipline: 'xd', message: `severity override for unknown rule '${ruleId}'` });
        continue;
      }
      map.set(ruleId, { ...rule, severity: ov.severity[ruleId] });
    }
  }
  for (const c of ov?.custom ?? []) {
    const rule = customToRule(c);
    if (map.has(rule.id)) {
      o.ledger.add({ severity: 'error', ruleId: 'USR-SCHEMA', discipline: 'xd', message: `custom rule '${rule.id}' collides with an existing rule id` });
      continue;
    }
    map.set(rule.id, rule);
  }

  const disabled = new Set<string>(ov?.disabled ?? []);
  for (const id of [...disabled].sort()) {
    if (!map.has(id)) {
      o.ledger.add({ severity: 'error', ruleId: 'USR-SCHEMA', discipline: 'xd', message: `cannot disable unknown rule '${id}'` });
    }
  }

  const rules = [...map.values()].sort(byId);
  const index = new Map<string, Rule>();
  for (const r of rules) index.set(r.id, r);

  const buckets = new Map<SubjectKind, Rule[]>();
  for (const k of SUBJECT_KINDS) buckets.set(k, []);
  for (const r of rules) {
    if (r.kind !== 'constraint' || !r.predicate) continue;
    if (disabled.has(r.id)) continue;
    const k = r.subject ?? 'building';
    (buckets.get(k) as Rule[]).push(r);
  }

  const paramOf = (id: string): { rule: Rule; name: string } | null => {
    const direct = index.get(id);
    if (direct && !disabled.has(direct.id)) {
      // A param rule carries `value`; a constraint rule's number IS its `limit`, so a generator can read the same
      // id the post-check enforces (`rules.num('ARC-33.egressTravel', 61)`) instead of keeping its own copy.
      if (direct.params.value) return { rule: direct, name: 'value' };
      if (direct.params.limit) return { rule: direct, name: 'limit' };
      const keys = Object.keys(direct.params);
      if (keys.length === 1) return { rule: direct, name: keys[0] };
      return null;
    }
    const cut = id.lastIndexOf('.');
    if (cut <= 0) return null;
    const base = index.get(id.slice(0, cut));
    const name = id.slice(cut + 1);
    if (!base || disabled.has(base.id)) return null;
    if (!base.params[name]) return null;
    return { rule: base, name };
  };

  let hashCache: string | null = null;

  const set: RuleSet = {
    all(): readonly Rule[] {
      return rules;
    },
    get(id: string): Rule | null {
      return index.get(id) ?? null;
    },
    num(id: string, fallback: number): number {
      const hit = paramOf(id);
      const v = hit?.rule.params[hit.name].value;
      return typeof v === 'number' ? v : fallback;
    },
    str(id: string, fallback: string): string {
      const hit = paramOf(id);
      const v = hit?.rule.params[hit.name].value;
      return typeof v === 'string' ? v : fallback;
    },
    bool(id: string, fallback: boolean): boolean {
      const hit = paramOf(id);
      const v = hit?.rule.params[hit.name].value;
      return typeof v === 'boolean' ? v : fallback;
    },
    table(id: string): readonly [number, number][] {
      const rule = index.get(id);
      if (!rule || disabled.has(rule.id)) return [];
      const rows: [number, number][] = [];
      for (const key of Object.keys(rule.params)) {
        const k = Number(key);
        const v = rule.params[key].value;
        if (!Number.isFinite(k) || typeof v !== 'number') continue;
        rows.push([k, v]);
      }
      rows.sort((a, b) => a[0] - b[0]);
      return rows;
    },
    forSubject(kind: SubjectKind, ctx: ScopeContext): readonly Rule[] {
      const list = buckets.get(kind) ?? [];
      return list.filter(r => scopeMatches(r.scope, ctx));
    },
    disabled(id: string): boolean {
      if (disabled.has(id)) return true;
      const cut = id.lastIndexOf('.');
      return cut > 0 && disabled.has(id.slice(0, cut));
    },
    profileApplied(name: string): boolean {
      return applied.includes(name);
    },
    hash(): string {
      if (hashCache) return hashCache;
      hashCache = fnv1a(canonicalJson(rules.map(r => ({
        id: r.id, kind: r.kind, severity: r.severity, subject: r.subject, scope: r.scope,
        predicate: r.predicate, params: r.params,
        disabled: disabled.has(r.id),
      }))));
      return hashCache;
    },
  };
  void overriddenPatternParams;
  return set;
}

/**
 * A rule set with no rules: every `num`/`str`/`bool` returns the caller's fallback, `table` is empty and no profile
 * is applied. Used by the v1 compatibility shim in `core/coordination.ts` (which must behave exactly as v1 did) and
 * by tests that are not exercising overrides.
 */
export const EMPTY_RULE_SET: RuleSet = {
  all: () => [],
  get: () => null,
  num: (_id: string, fallback: number) => fallback,
  str: (_id: string, fallback: string) => fallback,
  bool: (_id: string, fallback: boolean) => fallback,
  table: () => [],
  forSubject: () => [],
  disabled: () => false,
  profileApplied: () => false,
  hash: () => '00000000',
};

/** Built-in ids that deliberately replace a lifted pattern parameter of the same id. */
export function patternParamOverrides(builtin: readonly Rule[], fromPatterns: readonly Rule[]): string[] {
  const lifted = new Set(fromPatterns.map(r => r.id));
  return builtin.filter(r => lifted.has(r.id)).map(r => r.id).sort();
}

// ---------------------------------------------------------------------------------------------------------------
// The post-check
// ---------------------------------------------------------------------------------------------------------------

const FLOOR_USE_MEMO = new WeakMap<World, Map<string, ScopeContext['floorUse']>>();

function floorUseMemo(w: World): Map<string, ScopeContext['floorUse']> {
  const hit = FLOOR_USE_MEMO.get(w);
  if (hit) return hit;
  const m = new Map<string, ScopeContext['floorUse']>();
  for (const f of w.arch?.floors ?? []) m.set(f.storey, f.use);
  for (const st of w.storeys) {
    if (m.has(st.id)) continue;
    m.set(st.id, st.use === 'site' || st.use === 'foundation' ? undefined : st.use);
  }
  FLOOR_USE_MEMO.set(w, m);
  return m;
}

function ctxOf(w: World, s: Subject, storeyIndex: Map<string, number>): ScopeContext {
  const base: ScopeContext = {
    typology: w.spec.typology,
    region: w.spec.region,
    sprinklered: w.typology.sprinklered,
  };
  const withStorey = (storey: string | undefined): ScopeContext => ({
    ...base,
    storey,
    storeyIndex: storey !== undefined ? storeyIndex.get(storey) : undefined,
    floorUse: storey !== undefined ? floorUseMemo(w).get(storey) : undefined,
  });
  if (s.kind === 'room') return { ...withStorey(s.room.storey), roomType: s.room.type };
  if (s.kind === 'unit') return { ...withStorey(s.unit.storeys[0]), templateId: s.unit.templateId };
  if (s.kind === 'floor') return { ...withStorey(s.floor.storey), floorUse: s.floor.use };
  if (s.kind === 'door') return withStorey(s.door.storey);
  if (s.kind === 'corridor') return { ...withStorey(s.corridor.storey), roomType: 'corridor' };
  if (s.kind === 'element') return { ...withStorey(s.element.storey), elementKind: elementKindOf(s.element) ?? undefined };
  if (s.kind === 'run') return withStorey(s.storey);
  if (s.kind === 'support') return withStorey(s.support.storey);
  return base;
}

function subjectId(s: Subject): string {
  if (s.kind === 'room') return s.room.id;
  if (s.kind === 'unit') return s.unit.id;
  if (s.kind === 'floor') return s.floor.storey;
  if (s.kind === 'door') return s.door.id;
  if (s.kind === 'corridor') return s.corridor.id;
  if (s.kind === 'element') return s.element.id;
  if (s.kind === 'run') return s.id;
  if (s.kind === 'support') return s.support.id;
  return 'building';
}

function issueOf(w: World, rule: Rule, s: Subject, r: { observed?: number | string; limit?: number | string; detail?: string }, storey: string | undefined): Deviation {
  const where = subjectId(s);
  const bits = [`${rule.title}`];
  if (r.observed !== undefined && r.limit !== undefined) bits.push(`observed ${r.observed}, limit ${r.limit}`);
  else if (r.detail) bits.push(r.detail);
  const sourceParam = rule.params.limit ?? rule.params.value ?? rule.params.min;
  return {
    severity: rule.severity,
    ruleId: rule.id,
    discipline: rule.discipline,
    storey,
    unitId: s.kind === 'unit' ? s.unit.id : s.kind === 'room' ? s.room.unitId : undefined,
    roomId: s.kind === 'room' ? s.room.id : undefined,
    elementIds: s.kind === 'element' ? [s.element.id] : undefined,
    message: `${where}: ${bits.join(' — ')}${r.detail && r.observed !== undefined ? ` (${r.detail})` : ''}`,
    observed: r.observed,
    limit: r.limit,
    source: sourceParam?.source,
    resolution: rule.resolution ? { id: rule.resolution } : undefined,
  };
}

export interface CheckInput {
  rules: RuleSet;
  world: World;
  ledger: Ledger;
  /** Subject kinds to evaluate (default: all with at least one rule) */
  kinds?: readonly SubjectKind[];
  cap?: number;
}

export interface CheckReport {
  evaluated: number;
  failed: number;
  bySeverity: Record<Severity, number>;
}

/** Evaluate every constraint rule against every subject it scopes to, in canonical order. */
export function check(i: CheckInput): CheckReport {
  const { rules, world, ledger } = i;
  const cap = i.cap ?? rules.num('XD-00.issueCapPerRule', 25);
  const storeyIndex = new Map<string, number>();
  for (const s of world.storeys) storeyIndex.set(s.id, s.index);
  const report: CheckReport = { evaluated: 0, failed: 0, bySeverity: { info: 0, deviation: 0, violation: 0, error: 0 } };
  const counts = new Map<string, number>();

  const subjects: Subject[] = [];
  const kinds = i.kinds ?? SUBJECT_KINDS;

  if (kinds.includes('building')) subjects.push({ kind: 'building' });
  const sortedStoreys = [...world.storeys].sort((a, b) => a.index - b.index || (a.id < b.id ? -1 : 1));
  if (world.arch) {
    if (kinds.includes('floor')) {
      for (const s of sortedStoreys) {
        const floor = world.arch.floors.find(f => f.storey === s.id);
        if (floor) subjects.push({ kind: 'floor', floor });
      }
    }
    if (kinds.includes('unit')) {
      for (const u of [...world.arch.units].sort((a, b) => (a.id < b.id ? -1 : 1))) subjects.push({ kind: 'unit', unit: u });
    }
    if (kinds.includes('room')) {
      for (const r of [...world.arch.rooms].sort((a, b) => (a.id < b.id ? -1 : 1))) subjects.push({ kind: 'room', room: r });
    }
    if (kinds.includes('door')) {
      for (const d of [...world.arch.doors].sort((a, b) => (a.id < b.id ? -1 : 1))) subjects.push({ kind: 'door', door: d });
    }
    if (kinds.includes('corridor')) {
      const corridors = world.arch.floors.flatMap(f => f.corridors);
      for (const c of [...corridors].sort((a, b) => (a.id < b.id ? -1 : 1))) subjects.push({ kind: 'corridor', corridor: c });
    }
  }
  if (kinds.includes('element')) {
    const hasElementRules = rules.all().some(r => r.kind === 'constraint' && r.predicate && (r.subject ?? 'building') === 'element' && !rules.disabled(r.id));
    if (hasElementRules) {
      // Only elements the kernel governs are subjects: architecture and site emit walls, rooms and furniture, and a
      // bathroom's WC furniture is not a drain. `elementKindOf` returns null for those, and the element rules are
      // scoped by `elementKinds`, so the hot loop is the MEP runs only.
      const ids = [...world.elementById.keys()].sort();
      for (const id of ids) {
        const e = world.elementById.get(id);
        if (e && elementKindOf(e) !== null) subjects.push({ kind: 'element', element: e });
      }
    }
  }

  for (const s of subjects) {
    const ctx = ctxOf(world, s, storeyIndex);
    for (const rule of rules.forSubject(s.kind, ctx)) {
      if (!rule.predicate) continue;
      const predicate = PREDICATES[rule.predicate.id];
      if (!predicate) continue;
      report.evaluated += 1;
      const result = predicate(world, rule, s);
      if (result.ok) continue;
      report.failed += 1;
      report.bySeverity[rule.severity] += 1;
      const n = (counts.get(rule.id) ?? 0) + 1;
      counts.set(rule.id, n);
      if (n > cap) {
        ledger.addOnce(`cap:${rule.id}`, {
          severity: rule.severity, ruleId: rule.id, discipline: rule.discipline,
          message: `more than ${cap} subjects failed ${rule.id} (${rule.title}); only the first ${cap} are listed individually`,
        });
        continue;
      }
      ledger.add(issueOf(world, rule, s, result, ctx.storey));
    }
  }
  return report;
}

/** Issues a check produced, filtered to a severity — convenience for tests. */
export function violations(ledger: Ledger): readonly Issue[] {
  return ledger.bySeverity('violation');
}
