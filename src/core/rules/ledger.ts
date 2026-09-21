/**
 * The issues ledger — structured `Issue`s replace the flat `warnings: string[]`.
 *
 * During the v2 migration the ledger mirrors every non-`info` issue into the legacy `warnings` array that the CLI, the
 * app and `DesignModel.warnings` still read, using the legacy string shape `[discipline] message` (cross-discipline
 * issues, `discipline: 'xd'`, mirror unprefixed — that is what the pipeline-level warnings looked like in v1). A
 * discipline that replaces `ctx.warnings.push('[plumbing] x')` with `ctx.issues.add({discipline:'plumbing', message:'x'})`
 * therefore produces a byte-identical warning string. `mirrorInto` (and this whole projection) is removed in wave 3.
 */
import type { Deviation, Issue, Ledger, Severity } from './types.ts';

const SEVERITIES: readonly Severity[] = ['info', 'deviation', 'violation', 'error'];

/**
 * The legacy warning string for an issue.
 *
 * v1 prefixed its warnings per discipline — `[architecture] …`, `[structure] …`, `[plumbing] …` — but site and the
 * pipeline itself pushed bare strings. The projection reproduces that exactly, so a discipline that swaps a
 * `warnings.push` for an `issues.add` produces a byte-identical line. Mechanical and electrical never pushed a
 * warning in v1; they follow their prefixed siblings.
 */
const UNPREFIXED: readonly (Issue['discipline'])[] = ['site', 'xd'];

export function warningString(i: Pick<Issue, 'discipline' | 'message'>): string {
  return UNPREFIXED.includes(i.discipline) ? i.message : `[${i.discipline}] ${i.message}`;
}

/**
 * The ledger the pipeline holds. The extra `mirroring()` control exists only for the migration: the cross-discipline
 * validators (`kernel.validate`, `checkSupport`, the rule post-check) report what the v1 generators actually emit,
 * and those findings belong in `DesignModel.issues` — not in the legacy `warnings` array, whose consumers (the CLI,
 * the app, the sample reports) still expect the v1 strings. Wave 3 deletes `warnings`, `mirrorInto` and this method
 * together.
 */
export interface MigratingLedger extends Ledger {
  /** While off, issues are recorded but not mirrored into the legacy `warnings` array. Returns the previous state. */
  mirroring(on: boolean): boolean;
}

export function createLedger(o?: { mirrorInto?: string[] }): MigratingLedger {
  const issues: Issue[] = [];
  const mirror = o?.mirrorInto;
  let mirrorOn = true;
  const once = new Map<string, Issue>();
  let n = 0;

  const add = (d: Deviation): Issue => {
    n += 1;
    const issue: Issue = { ...d, id: `ISS-${String(n).padStart(4, '0')}` };
    issues.push(issue);
    if (mirror && mirrorOn && issue.severity !== 'info') mirror.push(warningString(issue));
    return issue;
  };

  return {
    add,

    mirroring(on: boolean): boolean {
      const prev = mirrorOn;
      mirrorOn = on;
      return prev;
    },

    addOnce(key: string, d: Deviation): Issue | null {
      const prev = once.get(key);
      if (prev) {
        prev.count = (prev.count ?? 1) + 1;
        return null;
      }
      const issue = add(d);
      issue.count = 1;
      once.set(key, issue);
      return issue;
    },

    all(): readonly Issue[] {
      return issues;
    },

    bySeverity(s: Severity): readonly Issue[] {
      return issues.filter(i => i.severity === s);
    },

    byRule(ruleId: string): readonly Issue[] {
      return issues.filter(i => i.ruleId === ruleId);
    },

    counts(): Record<Severity, number> {
      const out = { info: 0, deviation: 0, violation: 0, error: 0 };
      for (const i of issues) out[i.severity] += 1;
      return out;
    },

    warnings(opts?: { includeInfo?: boolean }): string[] {
      const includeInfo = opts?.includeInfo === true;
      if (mirror) {
        // The mirror is the authority while it exists: it also carries warnings pushed directly by
        // not-yet-migrated disciplines, in the order they happened.
        if (!includeInfo) return [...mirror];
        return [...mirror, ...issues.filter(i => i.severity === 'info').map(warningString)];
      }
      const out: string[] = [];
      for (const i of issues) {
        if (!includeInfo && i.severity === 'info') continue;
        out.push(warningString(i));
      }
      return out;
    },
  };
}

/** All severities in escalation order — for UI grouping and test messages. */
export function severities(): readonly Severity[] {
  return SEVERITIES;
}
