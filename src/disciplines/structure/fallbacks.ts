/**
 * SCAFFOLDING — a rule set that always returns the caller's fallback, and a ledger that just collects.
 *
 * `GenContext.rules` / `GenContext.issues` are optional until the pipeline wires the real ones
 * (`src/core/rules/engine.ts`, `src/core/rules/ledger.ts`, owned by the kernel/rules agent). Structure must still
 * run — and must still produce structured issues rather than warning strings — when they are absent, and its own
 * tests need a rule set and a ledger without depending on that module.
 *
 * DELETE this file in step 7, when `ctx.rules` and `ctx.issues` become non-optional; the two call sites are
 * `structure/index.ts` (`rules` / `ledger` locals) and the structure test files.
 */
import type {
  Deviation, Issue, Ledger, Rule, RuleSet, ScopeContext, Severity, SubjectKind,
} from '../../core/rules/types.ts';

/** Every lookup misses, so each generator keeps today's constant (passed as the fallback argument). */
export function passthroughRuleSet(overrides: Readonly<Record<string, number | string | boolean>> = {}): RuleSet {
  const numOf = (id: string): number | null => {
    const v = overrides[id];
    return typeof v === 'number' ? v : null;
  };
  return {
    all: () => [],
    get: (): Rule | null => null,
    num: (id: string, fallback: number) => numOf(id) ?? fallback,
    str: (id: string, fallback: string) => (typeof overrides[id] === 'string' ? overrides[id] as string : fallback),
    bool: (id: string, fallback: boolean) => (typeof overrides[id] === 'boolean' ? overrides[id] as boolean : fallback),
    table: () => [],
    forSubject: (_k: SubjectKind, _c: ScopeContext) => [],
    disabled: () => false,
    profileApplied: () => false,
    hash: () => `passthrough:${Object.keys(overrides).sort().join(',')}`,
  };
}

/** Collects issues in order, assigns ids, and projects the legacy `[discipline] message` warning strings. */
export function collectingLedger(): Ledger {
  const items: Issue[] = [];
  const seen = new Map<string, Issue>();
  const add = (d: Deviation): Issue => {
    const issue: Issue = { ...d, id: `ISS-${String(items.length + 1).padStart(4, '0')}` };
    items.push(issue);
    return issue;
  };
  return {
    add,
    addOnce(key: string, d: Deviation): Issue | null {
      const prior = seen.get(key);
      if (prior) { prior.count = (prior.count ?? 1) + 1; return null; }
      const issue = add(d);
      issue.count = 1;
      seen.set(key, issue);
      return issue;
    },
    all: () => items,
    bySeverity: (s: Severity) => items.filter(x => x.severity === s),
    byRule: (ruleId: string) => items.filter(x => x.ruleId === ruleId),
    counts: () => {
      const out: Record<Severity, number> = { info: 0, deviation: 0, violation: 0, error: 0 };
      for (const x of items) out[x.severity] += 1;
      return out;
    },
    warnings: (o?: { includeInfo?: boolean }) => items
      .filter(x => (o?.includeInfo ?? false) || x.severity !== 'info')
      .map(x => `[${x.discipline}] ${x.message}`),
  };
}
