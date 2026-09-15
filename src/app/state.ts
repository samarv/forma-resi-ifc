/** App state: one mutable object plus a subscribe/emit pair. Views read, main.ts writes. */
import type { DesignModel, IfcOutput } from '../core/types.ts';
import { PRESETS, type PartialSpec } from '../core/spec.ts';

export type TabId = 'plans' | 'viewer' | 'site' | 'metrics' | 'patterns' | 'elements';

export interface Layers {
  rooms: boolean;
  arch: boolean;
  site: boolean;
  struct: boolean;
  mech: boolean;
  plumb: boolean;
  elec: boolean;
  furniture: boolean;
  labels: boolean;
  grid: boolean;
}

export interface AppState {
  presetId: string;
  spec: PartialSpec;
  model: DesignModel | null;
  ifc: IfcOutput | null;
  ifcError: string | null;
  busy: boolean;
  error: string | null;
  genMs: number;
  tab: TabId;
  storey: string;
  layers: Layers;
  pinned: string | null;
  highlight: string | null;
  showAllTemplates: boolean;
  patternQuery: string;
  elementType: string | null;
  axonMode: boolean;
  specJsonOpen: boolean;
}

export const DEFAULT_LAYERS: Layers = {
  rooms: true, arch: true, site: true, struct: true, mech: true, plumb: true, elec: true,
  furniture: true, labels: true, grid: true,
};

export function defaultSpec(): PartialSpec {
  return structuredCloneSafe(PRESETS[0].spec);
}

export const state: AppState = {
  presetId: PRESETS[0].id,
  spec: defaultSpec(),
  model: null,
  ifc: null,
  ifcError: null,
  busy: false,
  error: null,
  genMs: 0,
  tab: 'plans',
  storey: 'L01',
  layers: { ...DEFAULT_LAYERS },
  pinned: null,
  highlight: null,
  showAllTemplates: false,
  patternQuery: '',
  elementType: null,
  axonMode: false,
  specJsonOpen: false,
};

type Listener = (s: AppState) => void;
const listeners = new Set<Listener>();

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit(): void {
  for (const fn of listeners) {
    try { fn(state); } catch (err) { console.error('[state] listener threw', err); }
  }
}

export function setState(patch: Partial<AppState>): void {
  Object.assign(state, patch);
  emit();
}

/** structuredClone is available everywhere we target, but keep a JSON fallback. */
export function structuredCloneSafe<T>(v: T): T {
  try {
    return structuredClone(v);
  } catch {
    return JSON.parse(JSON.stringify(v)) as T;
  }
}
