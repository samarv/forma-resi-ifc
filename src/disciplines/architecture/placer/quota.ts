/**
 * The mix ledger — BUILDING-WIDE, not per strip. `apportion` splits a floor's target unit count over its strips by
 * length; the ledger then carries each template's running deficit across strips and across storeys in storey-index
 * order, so a template the geometry pushed off one floor is the first pick on the next. That is what holds
 * `mixDeviation = ½·Σ|delivered/N − requested| ≤ 0.08` without any per-strip rounding tricks.
 */
import type { UnitTemplateId } from '../../../core/types.ts';
import type { MixReport } from './types.ts';

export { apportion } from '../bar-frame.ts';

export interface QuotaState {
  /** normalised requested shares by template id (Σ = 1) */
  readonly requested: Readonly<Record<string, number>>;
  /** delivered counts by template id */
  readonly delivered: Readonly<Record<string, number>>;
  readonly total: number;
  /** dwellings the whole building is aiming for (0 = unknown, the ledger then uses what it has) */
  readonly targetTotal: number;
  /** requested·N − delivered: positive means the template is behind */
  deficit(templateId: string): number;
  record(templateId: string): void;
  /** deficit ordering with a stable tie-break, for the packer's multiset draw */
  order(ids: readonly string[]): string[];
  report(): MixReport;
  /** a snapshot the packer can roll back to when a phase-1 draw is abandoned */
  snapshot(): QuotaSnapshot;
  restore(s: QuotaSnapshot): void;
}

export interface QuotaSnapshot { delivered: Record<string, number>; total: number }

export function newQuota(
  mix: Partial<Record<UnitTemplateId, number>> | undefined, targetTotal: number,
): QuotaState {
  const requested: Record<string, number> = {};
  let sum = 0;
  for (const [id, w] of Object.entries(mix ?? {})) {
    if (!w || w <= 0) continue;
    requested[id] = w;
    sum += w;
  }
  if (sum > 0) for (const id of Object.keys(requested)) requested[id] /= sum;
  const delivered: Record<string, number> = {};
  let total = 0;

  const state: QuotaState = {
    requested,
    delivered,
    get total() { return total; },
    targetTotal,
    deficit(templateId: string): number {
      const share = requested[templateId] ?? 0;
      // measure against the target when we know it, otherwise against what has been placed so far plus one
      const n = targetTotal > 0 ? targetTotal : total + 1;
      return share * n - (delivered[templateId] ?? 0);
    },
    record(templateId: string): void {
      delivered[templateId] = (delivered[templateId] ?? 0) + 1;
      total += 1;
    },
    order(ids: readonly string[]): string[] {
      return [...ids].sort((a, b) => {
        const d = state.deficit(b) - state.deficit(a);
        if (Math.abs(d) > 1e-9) return d;
        return a < b ? -1 : a > b ? 1 : 0;
      });
    },
    report(): MixReport {
      const byTemplate: Record<string, { requested: number; delivered: number }> = {};
      const ids = new Set([...Object.keys(requested), ...Object.keys(delivered)]);
      for (const id of [...ids].sort()) {
        byTemplate[id] = { requested: requested[id] ?? 0, delivered: delivered[id] ?? 0 };
      }
      return {
        requested: { ...requested },
        delivered: { ...delivered },
        deviation: mixDeviation(requested, delivered, total),
        byTemplate,
      };
    },
    snapshot(): QuotaSnapshot {
      return { delivered: { ...delivered }, total };
    },
    restore(s: QuotaSnapshot): void {
      for (const k of Object.keys(delivered)) delete delivered[k];
      for (const [k, v] of Object.entries(s.delivered)) delivered[k] = v;
      total = s.total;
    },
  };
  return state;
}

/** Total variation between the delivered and requested distributions: ½·Σ|delivered/N − requested| */
export function mixDeviation(
  requested: Readonly<Record<string, number>>, delivered: Readonly<Record<string, number>>, total: number,
): number {
  if (total <= 0) return 0;
  const ids = new Set([...Object.keys(requested), ...Object.keys(delivered)]);
  let sum = 0;
  for (const id of ids) sum += Math.abs((delivered[id] ?? 0) / total - (requested[id] ?? 0));
  return Math.round((sum / 2) * 10000) / 10000;
}

/** Merge two mix reports (one per floor) into the building-wide one */
export function mergeMix(a: MixReport, b: MixReport): MixReport {
  const delivered: Record<string, number> = { ...a.delivered };
  for (const [k, v] of Object.entries(b.delivered)) delivered[k] = (delivered[k] ?? 0) + v;
  const requested = Object.keys(a.requested).length > 0 ? a.requested : b.requested;
  const total = Object.values(delivered).reduce((x, y) => x + y, 0);
  const byTemplate: Record<string, { requested: number; delivered: number }> = {};
  for (const id of [...new Set([...Object.keys(requested), ...Object.keys(delivered)])].sort()) {
    byTemplate[id] = { requested: requested[id] ?? 0, delivered: delivered[id] ?? 0 };
  }
  return { requested: { ...requested }, delivered, deviation: mixDeviation(requested, delivered, total), byTemplate };
}
