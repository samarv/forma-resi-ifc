/**
 * Backend registry. The app never imports the generator directly: the entry point
 * (entry.real.ts / entry.mock.ts) registers an implementation and then boots the UI.
 * That keeps `--mock` builds bundleable while the discipline modules are still landing.
 */
import type { BuildingSpec, DesignModel, IfcOutput, MetricDef, UnitTemplateDef } from '../core/types.ts';
import type { PartialSpec } from '../core/spec.ts';

export interface Backend {
  kind: 'real' | 'mock';
  generateBuilding: (spec: PartialSpec | BuildingSpec) => DesignModel;
  writeIfc: (model: DesignModel) => IfcOutput;
  metrics: MetricDef[];
  templates: UnitTemplateDef[];
}

let realBackend: Backend | null = null;
let mockBackend: Backend | null = null;

export function registerBackend(b: Backend): void {
  if (b.kind === 'mock') mockBackend = b;
  else realBackend = b;
}

/** ?mock=1 forces the mock generator even in a real build (when one is bundled). */
export function mockRequested(): boolean {
  try {
    return /(?:^|[?&])mock=1(?:&|$)/.test(location.search);
  } catch {
    return false;
  }
}

export function backend(): Backend {
  const b = (mockRequested() ? mockBackend ?? realBackend : realBackend ?? mockBackend);
  if (!b) throw new Error('No generator backend registered');
  return b;
}

export function hasMock(): boolean { return mockBackend !== null; }
export function hasReal(): boolean { return realBackend !== null; }

/** Tolerate either an array or an id-keyed record from the generator modules. */
export function asArray<T>(v: readonly T[] | Record<string, T> | undefined | null): T[] {
  if (!v) return [];
  return Array.isArray(v) ? [...v] : Object.values(v as Record<string, T>);
}

export type { MetricDef, UnitTemplateDef };
