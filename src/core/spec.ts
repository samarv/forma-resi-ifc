/**
 * Spec normalisation and named presets. `normalizeSpec` fills every optional field from the
 * typology so that discipline generators can rely on defaults being present.
 *
 * Two v2 rules live here, both about a number the generator must not merely complain about:
 *
 * 1. **Storey band (typology).** `massing.storeys` is CLAMPED to `typology.storeys.{min,max}`
 *    unless `massing.allowStoreyOverride` is set. An accepted override layers the `'high-rise'`
 *    rule profile onto `spec.rules.profiles` (the kernel agent defines what that profile changes)
 *    and is recorded as a `deviation` by `generateSite` — the discipline that consumes the number
 *    — because no ledger exists yet at normalisation time. The form's storeys slider takes its
 *    min/max from the same band, so reaching the clamp needs either the override checkbox or a
 *    programmatic spec.
 * 2. **Parking levels (solver).** `massing.basementStoreys` / `massing.podiumStoreys` start from
 *    the typology default here, but they are OUTPUTS of `solveParking()` (site, before massing):
 *    it raises them to meet the parking ratio and calls `resolveFloors` again, so the floor list
 *    and `buildStoreys` see the parking levels. Nothing else may write those two fields.
 *
 * `PartialSpec` stays JSON-compatible: every v2 field is a plain boolean or number.
 */
import type {
  BuildingSpec, FloorSpec, StoreyDef, TypologyDef, FloorUse, Region, UnitTemplateId, MassingSpec,
} from './types.ts';
import { getTypology } from './typologies.ts';
import { storeyIdFor, SITE_STOREY, FOUNDATION_STOREY, ROOF_STOREY } from './ids.ts';

export type PartialSpec = Partial<Omit<BuildingSpec, 'site' | 'massing' | 'options'>> & {
  typology: BuildingSpec['typology'];
  site?: Partial<BuildingSpec['site']>;
  massing?: Partial<BuildingSpec['massing']>;
  options?: Partial<BuildingSpec['options']>;
};

/** Absolute limits, whatever the typology says */
const STOREY_HARD_MIN = 1;
const STOREY_HARD_MAX = 60;

export interface StoreyBandResult {
  storeys: number;
  requested: number;
  /** The band was applied and changed the request */
  clamped: boolean;
  /** The request sits outside the band and was honoured (`allowStoreyOverride`) */
  override: boolean;
  min: number;
  max: number;
}

/**
 * SIT / typology storey band. Pure, so the form, the tests and `normalizeSpec` all agree on
 * what a given request resolves to.
 */
export function resolveStoreys(massing: Partial<MassingSpec> | undefined, t: TypologyDef): StoreyBandResult {
  const requested = clamp(massing?.storeys ?? t.storeys.default, STOREY_HARD_MIN, STOREY_HARD_MAX);
  const min = Math.max(STOREY_HARD_MIN, t.storeys.min);
  const max = Math.min(STOREY_HARD_MAX, t.storeys.max);
  const outside = requested < min || requested > max;
  if (outside && massing?.allowStoreyOverride) {
    return { storeys: requested, requested, clamped: false, override: true, min, max };
  }
  const storeys = clamp(requested, min, max);
  return { storeys, requested, clamped: storeys !== requested, override: false, min, max };
}

export function normalizeSpec(input: PartialSpec): BuildingSpec {
  const t = getTypology(input.typology);
  const band = resolveStoreys(input.massing, t);
  const storeys = band.storeys;
  const region: Region = input.region ?? 'US';
  const spec: BuildingSpec = {
    name: input.name ?? `${t.name} (${storeys} storeys)`,
    seed: input.seed ?? 42,
    region,
    displayUnits: input.displayUnits ?? (region === 'US' ? 'imperial' : 'metric'),
    typology: t.id,
    site: {
      width: input.site?.width ?? defaultSiteWidth(t, storeys),
      depth: input.site?.depth ?? defaultSiteDepth(t),
      streetFacing: input.site?.streetFacing ?? 'S',
      context: input.site?.context ?? (t.density.max > 150 ? 'urban' : 'suburban'),
      setbacks: input.site?.setbacks,
      slopePercent: input.site?.slopePercent ?? 0,
      maxHeight: input.site?.maxHeight,
      maxFar: input.site?.maxFar,
      maxCoverage: input.site?.maxCoverage,
      parking: { type: t.parking, ratio: t.parkingRatio, evShare: 0.2, bikeRatio: t.bikeRatio, ...(input.site?.parking ?? {}) },
    },
    massing: {
      storeys,
      footprintShape: input.massing?.footprintShape ?? t.footprintShapes[0],
      buildingDepth: input.massing?.buildingDepth ?? t.buildingDepth.default,
      buildingLength: input.massing?.buildingLength,
      floorToFloor: input.massing?.floorToFloor ?? t.floorToFloor.typical,
      groundFloorToFloor: input.massing?.groundFloorToFloor ?? t.floorToFloor.ground,
      podiumStoreys: input.massing?.podiumStoreys ?? (t.id === 'podium-tower' ? 3 : 0),
      podiumUse: input.massing?.podiumUse ?? (t.parking === 'podium' ? 'parking' : 'retail'),
      basementStoreys: input.massing?.basementStoreys ?? (t.parking === 'underground' ? 1 : 0),
      corridorWidth: input.massing?.corridorWidth ?? t.corridorWidth ?? 1.5,
      coreCount: input.massing?.coreCount,
      roof: input.massing?.roof ?? (t.access === 'direct' && storeys <= 3 ? 'gable' : 'flat'),
      roofPitchDeg: input.massing?.roofPitchDeg ?? 30,
      parapetHeight: input.massing?.parapetHeight ?? 1.1,
      balconyDepth: input.massing?.balconyDepth ?? (t.access === 'direct' ? 0 : 1.8),
      allowStoreyOverride: input.massing?.allowStoreyOverride ?? false,
      maxBasementStoreys: input.massing?.maxBasementStoreys ?? 3,
      maxPodiumStoreys: input.massing?.maxPodiumStoreys ?? 3,
    },
    floors: input.floors ?? [],
    unitMix: input.unitMix ?? t.defaultUnitMix,
    // v2: the rule overrides and the floorplan-editor overrides ride through normalisation untouched — they are
    // applied later (rules by the rule set, layouts by `applyOverrides` between planFloorLayout and
    // instantiateFloor), and dropping them here would make the editor a no-op. (Added by agent L.)
    rules: input.rules,
    overrides: input.overrides,
    options: {
      furniture: true,
      site: true,
      structure: true,
      mechanical: true,
      plumbing: true,
      electrical: true,
      detail: 'medium',
      ifcSchema: 'IFC4',
      ...(input.options ?? {}),
    },
  };
  // An accepted override switches the rule profile rather than silently generating a tower with
  // a walk-up's rules; `generateSite` records the matching `deviation`.
  if (band.override) {
    const rules = spec.rules ?? { version: 1 };
    const profiles = rules.profiles ?? [];
    spec.rules = { ...rules, profiles: profiles.includes('high-rise') ? profiles : [...profiles, 'high-rise'] };
  }
  spec.floors = resolveFloors(spec, t);
  return spec;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function defaultSiteWidth(t: TypologyDef, storeys: number): number {
  switch (t.access) {
    case 'direct':
      return t.id === 'townhouse-row' ? 6 * 6.0 + 2 * t.setbacks.side : t.id === 'adu-laneway' ? 12 : 18;
    case 'stair-core':
      return 42 + 2 * t.setbacks.side;
    case 'point-core':
      return t.buildingDepth.default + 2 * t.setbacks.side + (storeys > 20 ? 6 : 0);
    default:
      return 60 + 2 * t.setbacks.side;
  }
}

function defaultSiteDepth(t: TypologyDef): number {
  switch (t.access) {
    case 'direct':
      return t.id === 'adu-laneway' ? 14 : 36;
    default:
      return t.buildingDepth.default + t.setbacks.front + t.setbacks.rear + (t.parking === 'surface' ? 18 : 6);
  }
}

/** Build the full per-floor list (basements, podium, residential, roof) merging user overrides */
export function resolveFloors(spec: BuildingSpec, t: TypologyDef): FloorSpec[] {
  const overrides = new Map(spec.floors.map(f => [f.index, f] as const));
  const out: FloorSpec[] = [];
  const basements = spec.massing.basementStoreys ?? 0;
  const podium = spec.massing.podiumStoreys ?? 0;
  for (let b = basements; b >= 1; b--) {
    out.push({ index: -b, use: 'parking', floorToFloor: 3.2, ...(overrides.get(-b) ?? {}) });
  }
  for (let i = 0; i < spec.massing.storeys; i++) {
    let use: FloorUse = 'residential';
    if (i === 0) {
      use = t.id === 'mixed-use-midrise' ? 'retail'
        : podium > 0 ? (spec.massing.podiumUse === 'parking' ? 'parking' : spec.massing.podiumUse === 'amenity' ? 'amenity' : 'retail')
        : t.access === 'direct' ? 'residential' : 'lobby-residential';
    } else if (i < podium) {
      use = spec.massing.podiumUse === 'parking' ? 'parking' : spec.massing.podiumUse === 'amenity' ? 'amenity' : 'retail';
    }
    const f2f = i === 0 ? spec.massing.groundFloorToFloor! : spec.massing.floorToFloor!;
    out.push({
      index: i,
      use,
      floorToFloor: f2f,
      ceilingHeight: Math.min(f2f - 0.45, i === 0 ? 3.2 : 2.7),
      unitMix: spec.unitMix,
      balconies: (spec.massing.balconyDepth ?? 0) > 0 && i > 0,
      wwr: 0.35,
      ...(overrides.get(i) ?? {}),
    });
  }
  return out;
}

/** Storey definitions for the building (SITE, FND, basements, floors, ROOF) */
export function buildStoreys(spec: BuildingSpec, floors: FloorSpec[], foundationDepth = 1.2, region: Region = spec.region): StoreyDef[] {
  const storeys: StoreyDef[] = [];
  const basements = floors.filter(f => f.index < 0).sort((a, b) => a.index - b.index);
  let elev = 0;
  for (const b of [...basements].reverse()) {
    elev -= b.floorToFloor ?? 3.2;
  }
  const lowest = elev;
  storeys.push({ id: SITE_STOREY, name: 'Site', index: -101, elevation: 0, height: 0, use: 'site' });
  storeys.push({ id: FOUNDATION_STOREY, name: 'Foundation', index: -100, elevation: lowest - foundationDepth, height: foundationDepth, use: 'foundation' });
  for (const b of basements) {
    storeys.push({ id: storeyIdFor(b.index), name: `Basement ${-b.index}`, index: b.index, elevation: elev, height: b.floorToFloor ?? 3.2, use: b.use });
    elev += b.floorToFloor ?? 3.2;
  }
  elev = 0;
  for (const f of floors.filter(f => f.index >= 0).sort((a, b) => a.index - b.index)) {
    storeys.push({ id: storeyIdFor(f.index), name: storeyName(f.index, region), index: f.index, elevation: elev, height: f.floorToFloor ?? spec.massing.floorToFloor!, use: f.use });
    elev += f.floorToFloor ?? spec.massing.floorToFloor!;
  }
  storeys.push({ id: ROOF_STOREY, name: 'Roof', index: 100, elevation: elev, height: spec.massing.parapetHeight ?? 1.1, use: 'roof' });
  return storeys;
}

export function storeyName(index: number, region: Region): string {
  if (index < 0) return `Basement ${-index}`;
  if (region === 'UK' || region === 'IE' || region === 'AU' || region === 'NZ') {
    return index === 0 ? 'Ground Floor' : `${ordinal(index)} Floor`;
  }
  return `Level ${index + 1}`;
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// ----------------------------------------------------------------------------
// Presets (used by the UI, the CLI and tests)
// ----------------------------------------------------------------------------

export interface Preset {
  id: string;
  label: string;
  spec: PartialSpec;
}

export const PRESETS: Preset[] = [
  {
    id: 'us-5-over-1',
    label: 'US 5-over-1 mid-rise (Austin)',
    spec: { name: 'Riverside Commons', seed: 7, region: 'US', typology: 'corridor-midrise', site: { width: 78, depth: 42, streetFacing: 'S', context: 'urban' }, massing: { storeys: 6, podiumStoreys: 1, podiumUse: 'parking', footprintShape: 'bar', roof: 'flat' } },
  },
  {
    id: 'uk-terrace',
    label: 'UK terraced houses (Manchester)',
    spec: { name: 'Mill Street Terrace', seed: 3, region: 'UK', displayUnits: 'metric', typology: 'townhouse-row', site: { width: 42, depth: 34, streetFacing: 'N', context: 'urban' }, massing: { storeys: 3, roof: 'gable', roofPitchDeg: 35 } },
  },
  {
    id: 'ca-point-tower',
    label: 'Canadian point tower on podium (Vancouver)',
    spec: { name: 'Harbourview', seed: 11, region: 'CA', displayUnits: 'metric', typology: 'podium-tower', site: { width: 48, depth: 46, streetFacing: 'W', context: 'urban' }, massing: { storeys: 22, podiumStoreys: 3, podiumUse: 'retail', basementStoreys: 1, roof: 'flat' } },
  },
  {
    id: 'au-walkup',
    label: 'Australian walk-up flats (Melbourne)',
    spec: { name: 'Carlton Court', seed: 5, region: 'AU', displayUnits: 'metric', typology: 'garden-walkup', site: { width: 46, depth: 40, streetFacing: 'N', context: 'suburban' }, massing: { storeys: 3, footprintShape: 'bar', roof: 'flat' } },
  },
  {
    id: 'us-detached',
    label: 'US two-storey detached house (Denver)',
    spec: { name: 'Aspen Lane Residence', seed: 21, region: 'US', typology: 'detached-house', site: { width: 20, depth: 38, streetFacing: 'E', context: 'suburban' }, massing: { storeys: 2, roof: 'gable', roofPitchDeg: 30 } },
  },
  {
    id: 'uk-mansion',
    label: 'UK mansion block (London)',
    spec: { name: 'Albany Mansions', seed: 9, region: 'UK', displayUnits: 'metric', typology: 'mansion-block', site: { width: 52, depth: 36, streetFacing: 'S', context: 'urban' }, massing: { storeys: 5, footprintShape: 'bar', roof: 'flat' } },
  },
  {
    id: 'ie-courtyard',
    label: 'Irish courtyard block (Dublin)',
    spec: { name: 'Liffey Square', seed: 13, region: 'IE', displayUnits: 'metric', typology: 'courtyard-block', site: { width: 70, depth: 64, streetFacing: 'S', context: 'urban' }, massing: { storeys: 5, footprintShape: 'O', roof: 'flat' } },
  },
  {
    id: 'nz-coliving',
    label: 'NZ co-living block (Auckland)',
    spec: { name: 'Karangahape Commons', seed: 17, region: 'NZ', displayUnits: 'metric', typology: 'coliving-cluster', site: { width: 40, depth: 36, streetFacing: 'N', context: 'urban' }, massing: { storeys: 4, footprintShape: 'bar', roof: 'flat' } },
  },
  {
    id: 'us-senior',
    label: 'US assisted living (Phoenix)',
    spec: { name: 'Saguaro Senior Living', seed: 23, region: 'US', typology: 'senior-living', site: { width: 84, depth: 60, streetFacing: 'S', context: 'suburban' }, massing: { storeys: 3, footprintShape: 'L', roof: 'flat' } },
  },
  {
    id: 'ca-laneway',
    label: 'Canadian laneway house (Toronto)',
    spec: { name: 'Palmerston Laneway', seed: 29, region: 'CA', displayUnits: 'metric', typology: 'adu-laneway', site: { width: 12, depth: 14, streetFacing: 'S', context: 'urban' }, massing: { storeys: 2, roof: 'flat' } },
  },
];

export function getPreset(id: string): Preset {
  const p = PRESETS.find(x => x.id === id);
  if (!p) throw new Error(`Unknown preset: ${id}`);
  return p;
}

export const UNIT_TEMPLATE_IDS: UnitTemplateId[] = [
  'studio', 'micro-studio', 'junior-1b', '1b1b', '1b-den', '2b1b', '2b2b', '3b2b', '4b2b', 'dual-key',
  'corner-2b2b', 'loft-live-work', 'maisonette-2s', 'townhouse-2s', 'townhouse-3s', 'ranch-3b', 'colonial-4b',
  'adu-1b', 'coliving-cluster', 'senior-1b-accessible',
];
