/**
 * Lift the pattern language into the rule set.
 *
 * Every pattern parameter becomes a `kind: 'param'` Rule with the id `<PATTERN>.<paramName>`, so a generator reads
 * `rules.num('ARC-03.maxLegLength', 45)` instead of a private module constant, and the Rules tab can show — and a
 * project can override — the same number the Patterns tab documents. The fallback passed by the generator is always
 * today's constant, so behaviour is unchanged until a rule overrides it.
 *
 * 101 patterns × ~5 parameters ≈ 500 rules; the lift is pure and runs once per generation (µs).
 */
import type { Pattern } from '../types.ts';
import type { Rule } from './types.ts';

/** `'cross'` in the pattern book is `'xd'` in the rule set (the Discipline union has no 'cross'). */
function disciplineOf(p: Pattern): Rule['discipline'] {
  return p.discipline === 'cross' ? 'xd' : p.discipline;
}

function titleOf(p: Pattern, name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return `${p.name} — ${words}`;
}

export function rulesFromPatterns(patterns: readonly Pattern[]): Rule[] {
  const out: Rule[] = [];
  for (const p of patterns) {
    const names = Object.keys(p.parameters).sort();
    for (const name of names) {
      const param = p.parameters[name];
      out.push({
        id: `${p.id}.${name}`,
        title: titleOf(p, name),
        discipline: disciplineOf(p),
        patternId: p.id,
        kind: 'param',
        scope: {},
        params: {
          value: {
            value: param.value,
            unit: param.unit,
            source: param.source && param.source.length > 0 ? param.source : `pattern ${p.id} (${p.name})`,
          },
        },
        severity: 'info',
        rationale: p.solution,
      });
    }
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

/** Numeric parameter ids of a pattern list — the coverage assertion in `rules.test.ts` uses this. */
export function numericParamIds(patterns: readonly Pattern[]): string[] {
  const out: string[] = [];
  for (const p of patterns) {
    for (const name of Object.keys(p.parameters)) {
      if (typeof p.parameters[name].value === 'number') out.push(`${p.id}.${name}`);
    }
  }
  return out.sort();
}
