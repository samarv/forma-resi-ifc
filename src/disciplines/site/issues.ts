/**
 * Site's bridge to the v2 rule set + issues ledger (F1) while both are still landing.
 *
 * Two shims, both deliberately tiny and both deleted once `src/core/rules/**` ships and
 * `pipeline.ts` threads `ctx.rules` / `ctx.issues` into `generateSite`:
 *
 * - `ruleNum(rules, id, fallback)` — `rules.num(id, fallback)` when a rule set is present, the
 *   v1 constant otherwise. Every tunable site reads goes through it, so lifting a constant into
 *   a `Rule` record is a data change, not a code change.
 * - `issueSink(ledger, warnings)` — `Deviation` in, `Issue` out. With a ledger it delegates
 *   (the ledger mirrors into `warnings` during migration); without one it assigns a deterministic
 *   id, keeps the issue for `SiteModel`/`CorridorGraph` consumers, and mirrors every severity
 *   EXCEPT `info` into `warnings` — exactly `Ledger.warnings()`'s default projection. So a
 *   warning that becomes a recorded resolution (`info`) disappears from `warnings`, and a warning
 *   that is a real contradiction (`deviation` / `violation`) keeps its string byte-identical.
 *
 * `RULE` collects the rule ids site reports against in one place so the Rules tab and the
 * post-check agree with the generator. Ids marked "(rules.num)" are read as parameters and must
 * exist in the rule set; the others are only issue labels.
 */
import type { Deviation, Issue, Ledger, RuleSet, Severity, ResolutionId } from '../../core/rules/types.ts';

/** Rule ids site reads or reports against. */
export const RULE = {
  setbacks: 'SIT-01.minEnvelopeDimension',
  maxHeight: 'SIT-01.maxHeight',
  maxFar: 'SIT-01.maxFar',
  maxCoverage: 'SIT-01.maxCoverage',
  buildingSize: 'SIT-02.buildingSize',
  dwellingBand: 'SIT-02.dwellingsPerFloor',
  courtyard: 'SIT-03.minClearDimension',
  aduSeparation: 'SIT-05.separationMin',
  streetWall: 'SIT-06.buildToFraction',
  /** (rules.num) SIT-07.maxBasementStoreys / .maxPodiumStoreys / .stallWidth / .stallLength / .aisleWidth / .accessibleWidth / .accessibleShare */
  parkingLevels: 'SIT-07.parkingLevels',
  parkingRatio: 'SIT-07.parkingRatio',
  parkingType: 'SIT-07.parkingType',
  parkingFit: 'SIT-07.parkingFit',
  /** (rules.num) SIT-08.deadEnd */
  deadEnd: 'SIT-08.deadEnd',
  exitSeparation: 'SIT-08.exitSeparationFraction',
  coreFit: 'SIT-08.coreFit',
  coreCount: 'SIT-08.coreCount',
  unitDepthMin: 'SIT-09.unitDepthMin',
  unitDepthMax: 'SIT-09.unitDepthMax',
  /** (rules.num) ARC-03.maxLegLength / .breakSlotLength */
  legLength: 'ARC-03.maxLegLength',
  /** Typology storey band — `typology.storeys.{min,max}`, enforced by `normalizeSpec` */
  storeyBand: 'TYP-01.storeyBand',
  geometry: 'SIT-00.geometry',
} as const;

/** The travel-distance rule that applies (IBC Table 1017.2). */
export function travelRule(sprinklered: boolean): string {
  return sprinklered ? 'SIT-08.travelLimitSprinklered' : 'SIT-08.travelLimitUnsprinklered';
}

/** `rules.num` with the v1 constant as the fallback (principle 5: rules are data). */
export function ruleNum(rules: RuleSet | undefined, id: string, fallback: number): number {
  return rules ? rules.num(id, fallback) : fallback;
}

export interface IssueSink {
  add(d: Deviation): Issue;
  /** Deduplicated by key — the second and later calls only bump `count` */
  once(key: string, d: Deviation): Issue | null;
  all(): readonly Issue[];
}

export interface IssueOpts {
  message: string;
  severity?: Severity;
  ruleId?: string;
  storey?: string;
  observed?: number | string;
  limit?: number | string;
  source?: string;
  elementIds?: readonly string[];
  resolution?: { id: ResolutionId; from?: number | string; to?: number | string; note?: string };
}

/** Sugar for the common shape: `sink.add(info(RULE.x, 'message', { resolution: … }))`. */
export function deviation(ruleId: string, message: string, o: Omit<IssueOpts, 'message' | 'ruleId'> = {}): Deviation {
  return { severity: 'deviation', ruleId, discipline: 'site', message, ...o };
}

export function info(ruleId: string, message: string, o: Omit<IssueOpts, 'message' | 'ruleId'> = {}): Deviation {
  return { severity: 'info', ruleId, discipline: 'site', message, ...o };
}

export function violation(ruleId: string, message: string, o: Omit<IssueOpts, 'message' | 'ruleId'> = {}): Deviation {
  return { severity: 'violation', ruleId, discipline: 'site', message, ...o };
}

/**
 * The sink site generates against. `ledger` wins when the pipeline provides one; otherwise the
 * issues are kept locally and mirrored into `warnings` (info excluded), so the v1 string
 * projection is unchanged for everything that is not a resolution.
 */
export function issueSink(ledger?: Ledger, warnings?: string[]): IssueSink {
  if (ledger) {
    return {
      add: (d: Deviation): Issue => ledger.add(d),
      once: (key: string, d: Deviation): Issue | null => ledger.addOnce(key, d),
      all: (): readonly Issue[] => ledger.all(),
    };
  }
  const issues: Issue[] = [];
  const byKey = new Map<string, Issue>();
  let n = 0;
  const add = (d: Deviation): Issue => {
    n++;
    const issue: Issue = { id: `SIT-ISS-${String(n).padStart(4, '0')}`, ...d };
    issues.push(issue);
    if (warnings && issue.severity !== 'info') warnings.push(issue.message);
    return issue;
  };
  return {
    add,
    once: (key: string, d: Deviation): Issue | null => {
      const seen = byKey.get(key);
      if (seen) { seen.count = (seen.count ?? 1) + 1; return null; }
      const issue = add(d);
      byKey.set(key, issue);
      return issue;
    },
    all: (): readonly Issue[] => issues,
  };
}

/** A sink that drops everything — for pure estimates that must not report twice. */
export function nullSink(): IssueSink {
  return {
    add: (d: Deviation): Issue => ({ id: 'SIT-ISS-0000', ...d }),
    once: (): Issue | null => null,
    all: (): readonly Issue[] => [],
  };
}
