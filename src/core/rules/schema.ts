/**
 * `spec.rules` — the project's own rule overrides, as validated JSON.
 *
 * `RULE_OVERRIDES_SCHEMA` is a JSON-Schema draft-07 document for the documentation and the Rules tab;
 * `validateRuleOverrides` is the hand-written validator the generator actually runs (zero dependencies), and
 * `customToRule` turns one validated `CustomRule` into a `Rule` the engine can evaluate.
 *
 * Failure policy: a malformed document drops **only the offending rule**, with one `error` Issue naming it, and
 * generation continues deterministically. A user's typo never stops a build.
 */
import type { FloorUse, Region, RoomType, TypologyId, UnitTemplateId } from '../types.ts';
import type { ElementKind } from '../kernel/types.ts';
import type {
  CustomRule, Deviation, LimitOp, ObjectSelector, PredicateId, Rule, RuleOverrides, RuleScope, Severity,
  SubjectSelector,
} from './types.ts';
import { PREDICATE_SIGNATURES } from './predicates.ts';
import { RULE_PROFILE_NAMES } from './builtin.ts';

// ---------------------------------------------------------------------------------------------------------------
// Runtime member lists (the unions live in the type system; these are what a validator can check against)
// ---------------------------------------------------------------------------------------------------------------

export const SEVERITIES: readonly Severity[] = ['info', 'deviation', 'violation', 'error'];
export const LIMIT_OPS: readonly LimitOp[] = ['>=', '<=', '==', '!='];

export const RESOLUTION_IDS = [
  'none', 'clamp', 'shift-along-lane', 'shift-lateral', 'compress-band', 'drop-band',
  'raise-floor-to-floor', 'lower-ceiling', 'oversize-pipe',
  'add-basement-level', 'add-podium-level', 'relax-parking-ratio',
  'split-corridor', 'add-core', 'switch-highrise-ruleset',
  'add-sump', 'vent-branch', 'reroute-in-wall', 'enlarge-shaft', 'snap-to-party-line',
  'swap-module', 'merge-room', 'stack-room',
] as const;

export const FLOOR_USES: readonly FloorUse[] = [
  'residential', 'lobby-residential', 'retail', 'parking', 'amenity', 'mechanical', 'roof', 'basement',
];

export const ROOM_TYPES: readonly RoomType[] = [
  'living', 'dining', 'kitchen', 'living-kitchen', 'bedroom', 'master-bedroom', 'bathroom', 'ensuite',
  'powder', 'wc', 'hall', 'entry', 'closet', 'walk-in-closet', 'laundry', 'utility', 'storage',
  'study', 'den', 'balcony', 'terrace', 'garage', 'stair', 'corridor', 'lobby', 'lift-lobby',
  'elevator', 'shaft', 'mech-room', 'elec-room', 'water-room', 'trash', 'bike-store', 'mail',
  'amenity', 'gym', 'lounge', 'retail', 'parking', 'plant', 'roof', 'courtyard', 'landscape',
  'shared-kitchen', 'shared-living', 'dining-hall', 'flex', 'porch', 'basement',
];

export const ELEMENT_KINDS: readonly ElementKind[] = [
  'slab', 'beam', 'column', 'drop-panel', 'wall', 'shaft-void',
  'duct', 'duct-fitting', 'air-terminal', 'fan', 'ahu', 'jet-fan',
  'waste', 'vent', 'storm', 'trench-drain', 'dcw', 'dhw', 'hwr', 'gas',
  'sprinkler-main', 'sprinkler-branch', 'sprinkler-head', 'standpipe',
  'tray-power', 'tray-data', 'conduit', 'busduct', 'panel', 'switchgear',
  'light', 'sensor', 'ev-charger', 'pump', 'tank', 'sump', 'ejector', 'plinth',
];

export const REGIONS: readonly Region[] = ['US', 'UK', 'CA', 'AU', 'NZ', 'IE'];

export const TEMPLATE_IDS: readonly UnitTemplateId[] = [
  'studio', 'micro-studio', 'junior-1b', '1b1b', '1b-den', '2b1b', '2b2b', '3b2b', '4b2b', 'dual-key',
  'corner-2b2b', 'loft-live-work', 'maisonette-2s', 'townhouse-2s', 'townhouse-3s', 'ranch-3b', 'colonial-4b',
  'adu-1b', 'coliving-cluster', 'senior-1b-accessible',
];

export const TYPOLOGY_ID_LIST: readonly TypologyId[] = [
  'corridor-midrise', 'podium-tower', 'garden-walkup', 'townhouse-row', 'detached-house', 'mansion-block',
  'courtyard-block', 'coliving-cluster', 'senior-living', 'adu-laneway',
] as readonly TypologyId[];

export const SUBJECT_SELECTOR_KINDS = ['room', 'unit', 'floor', 'corridor', 'door', 'element', 'run', 'support', 'building'] as const;
export const OBJECT_SELECTOR_KINDS = ['roomType', 'elementKind', 'system', 'none'] as const;
export const PREDICATE_ID_LIST: readonly PredicateId[] = Object.keys(PREDICATE_SIGNATURES) as PredicateId[];

export const USR_ID = /^USR-[A-Za-z0-9_-]{1,32}$/;

// ---------------------------------------------------------------------------------------------------------------
// JSON schema (documentation + the Rules tab form)
// ---------------------------------------------------------------------------------------------------------------

export const RULE_OVERRIDES_SCHEMA: unknown = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://github.com/samarv/forma-resi-ifc/schemas/rule-overrides.json',
  title: 'forma-resi-ifc rule overrides (spec.rules)',
  description: 'Project overrides of the generator rule set: parameter values, severities, disabled rules, named rule profiles, and custom rules composed from the closed predicate vocabulary.',
  type: 'object',
  additionalProperties: false,
  required: ['version'],
  properties: {
    version: { const: 1 },
    params: {
      description: 'ruleId → parameter name → value. The value type must match the rule parameter it replaces.',
      type: 'object',
      additionalProperties: {
        type: 'object',
        additionalProperties: { type: ['number', 'string', 'boolean'] },
      },
    },
    severity: {
      description: 'ruleId → severity.',
      type: 'object',
      additionalProperties: { enum: [...SEVERITIES] },
    },
    disabled: {
      description: 'Rule ids to switch off entirely.',
      type: 'array',
      items: { type: 'string' },
    },
    profiles: {
      description: 'Named rule profiles to layer on top.',
      type: 'array',
      items: { enum: [...RULE_PROFILE_NAMES] },
    },
    custom: {
      description: 'Project rules composed from the closed predicate vocabulary.',
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'subject', 'predicate', 'limit'],
        properties: {
          id: { type: 'string', pattern: '^USR-[A-Za-z0-9_-]{1,32}$' },
          title: { type: 'string', minLength: 1 },
          subject: {
            type: 'object',
            required: ['kind'],
            properties: {
              kind: { enum: [...SUBJECT_SELECTOR_KINDS] },
              roomType: { type: 'array', items: { enum: [...ROOM_TYPES] } },
              zone: { type: 'array', items: { type: 'string' } },
              templateId: { type: 'array', items: { enum: [...TEMPLATE_IDS] } },
              floorUse: { type: 'array', items: { enum: [...FLOOR_USES] } },
              doorType: { type: 'array', items: { type: 'string' } },
              elementKind: { type: 'array', items: { enum: [...ELEMENT_KINDS] } },
              system: { type: 'array', items: { type: 'string' } },
            },
          },
          predicate: { enum: [...PREDICATE_ID_LIST] },
          object: {
            type: 'object',
            required: ['kind'],
            properties: {
              kind: { enum: [...OBJECT_SELECTOR_KINDS] },
              value: { type: 'string' },
            },
          },
          limit: {
            type: 'object',
            required: ['op', 'value'],
            properties: {
              op: { enum: [...LIMIT_OPS] },
              value: { type: ['number', 'string', 'boolean'] },
              unit: { type: 'string' },
            },
          },
          scope: {
            type: 'object',
            additionalProperties: false,
            properties: {
              floorUse: { type: 'array', items: { enum: [...FLOOR_USES] } },
              roomType: { type: 'array', items: { enum: [...ROOM_TYPES] } },
              elementKinds: { type: 'array', items: { enum: [...ELEMENT_KINDS] } },
              templateIds: { type: 'array', items: { enum: [...TEMPLATE_IDS] } },
              storeys: { type: 'array', items: { type: 'string' } },
              storeyIndexMin: { type: 'number' },
              storeyIndexMax: { type: 'number' },
              typologies: { type: 'array', items: { enum: [...TYPOLOGY_ID_LIST] } },
              regions: { type: 'array', items: { enum: [...REGIONS] } },
              sprinklered: { type: 'boolean' },
            },
          },
          severity: { enum: ['info', 'deviation', 'violation'] },
          resolution: { enum: [...RESOLUTION_IDS] },
          source: { type: 'string' },
        },
      },
    },
  },
};

// ---------------------------------------------------------------------------------------------------------------
// The validator
// ---------------------------------------------------------------------------------------------------------------

function err(message: string): Deviation {
  return { severity: 'error', ruleId: 'USR-SCHEMA', discipline: 'xd', message };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateScope(scope: unknown, where: string, issues: Deviation[]): RuleScope | null {
  if (!isObject(scope)) {
    issues.push(err(`${where}: scope must be an object`));
    return null;
  }
  const out: RuleScope = {};
  const listCheck = <T>(key: string, allowed: readonly T[]): T[] | null | undefined => {
    const raw = scope[key];
    if (raw === undefined) return undefined;
    if (!Array.isArray(raw)) {
      issues.push(err(`${where}: scope.${key} must be an array`));
      return null;
    }
    const bad = raw.filter(v => !allowed.includes(v as T));
    if (bad.length > 0) {
      issues.push(err(`${where}: scope.${key} has unknown member(s) ${bad.map(String).join(', ')}`));
      return null;
    }
    return raw as T[];
  };
  const floorUse = listCheck<FloorUse>('floorUse', FLOOR_USES);
  if (floorUse === null) return null;
  if (floorUse) out.floorUse = floorUse;
  const roomType = listCheck<RoomType>('roomType', ROOM_TYPES);
  if (roomType === null) return null;
  if (roomType) out.roomType = roomType;
  const kinds = listCheck<ElementKind>('elementKinds', ELEMENT_KINDS);
  if (kinds === null) return null;
  if (kinds) out.elementKinds = kinds;
  const templates = listCheck<UnitTemplateId>('templateIds', TEMPLATE_IDS);
  if (templates === null) return null;
  if (templates) out.templateIds = templates;
  const typologies = listCheck<TypologyId>('typologies', TYPOLOGY_ID_LIST);
  if (typologies === null) return null;
  if (typologies) out.typologies = typologies;
  const regions = listCheck<Region>('regions', REGIONS);
  if (regions === null) return null;
  if (regions) out.regions = regions;
  if (scope.storeys !== undefined) {
    if (!Array.isArray(scope.storeys) || scope.storeys.some(s => typeof s !== 'string')) {
      issues.push(err(`${where}: scope.storeys must be an array of storey ids`));
      return null;
    }
    out.storeys = scope.storeys as string[];
  }
  for (const k of ['storeyIndexMin', 'storeyIndexMax'] as const) {
    if (scope[k] === undefined) continue;
    if (typeof scope[k] !== 'number') {
      issues.push(err(`${where}: scope.${k} must be a number`));
      return null;
    }
    out[k] = scope[k] as number;
  }
  if (scope.sprinklered !== undefined) {
    if (typeof scope.sprinklered !== 'boolean') {
      issues.push(err(`${where}: scope.sprinklered must be a boolean`));
      return null;
    }
    out.sprinklered = scope.sprinklered;
  }
  return out;
}

function validateCustom(raw: unknown, seen: Set<string>, issues: Deviation[]): CustomRule | null {
  if (!isObject(raw)) {
    issues.push(err('custom rule must be an object'));
    return null;
  }
  const id = raw.id;
  if (typeof id !== 'string' || !USR_ID.test(id)) {
    issues.push(err(`custom rule id ${JSON.stringify(id)} must match ${USR_ID.source}`));
    return null;
  }
  if (seen.has(id)) {
    issues.push(err(`duplicate custom rule id '${id}'`));
    return null;
  }
  const title = typeof raw.title === 'string' && raw.title.length > 0 ? raw.title : null;
  if (!title) {
    issues.push(err(`custom rule '${id}' needs a title`));
    return null;
  }
  const predicate = raw.predicate;
  if (typeof predicate !== 'string' || !PREDICATE_ID_LIST.includes(predicate as PredicateId)) {
    issues.push(err(`custom rule '${id}': unknown predicate ${JSON.stringify(predicate)}`));
    return null;
  }
  const signature = PREDICATE_SIGNATURES[predicate as PredicateId];
  if (!isObject(raw.subject) || typeof raw.subject.kind !== 'string') {
    issues.push(err(`custom rule '${id}': subject must be an object with a kind`));
    return null;
  }
  const subjectKind = raw.subject.kind as SubjectSelector['kind'];
  if (!SUBJECT_SELECTOR_KINDS.includes(subjectKind)) {
    issues.push(err(`custom rule '${id}': unknown subject kind '${subjectKind}'`));
    return null;
  }
  if (!signature.subjects.includes(subjectKind)) {
    issues.push(err(`custom rule '${id}': predicate '${predicate}' does not apply to a ${subjectKind} (it applies to ${signature.subjects.join(', ')})`));
    return null;
  }
  const declaresObject = (signature.object ?? []).filter(k => k !== 'none').length > 0;
  let object: ObjectSelector | undefined;
  if (raw.object !== undefined) {
    if (!declaresObject) {
      issues.push(err(`custom rule '${id}': predicate '${predicate}' takes no object`));
      return null;
    }
    if (!isObject(raw.object) || typeof raw.object.kind !== 'string' || !OBJECT_SELECTOR_KINDS.includes(raw.object.kind as 'roomType')) {
      issues.push(err(`custom rule '${id}': object must be {kind, value}`));
      return null;
    }
    if (!(signature.object ?? []).includes(raw.object.kind as 'roomType')) {
      issues.push(err(`custom rule '${id}': predicate '${predicate}' takes an object of kind ${(signature.object ?? []).join(' | ')}, not '${raw.object.kind}'`));
      return null;
    }
    if (typeof raw.object.value !== 'string') {
      issues.push(err(`custom rule '${id}': object.value must be a string`));
      return null;
    }
    object = { kind: raw.object.kind as 'roomType', value: raw.object.value } as ObjectSelector;
  } else if (declaresObject) {
    issues.push(err(`custom rule '${id}': predicate '${predicate}' needs an object of kind ${(signature.object ?? []).join(' | ')}`));
    return null;
  }
  if (!isObject(raw.limit)) {
    issues.push(err(`custom rule '${id}': limit must be {op, value}`));
    return null;
  }
  const op = raw.limit.op;
  if (typeof op !== 'string' || !LIMIT_OPS.includes(op as LimitOp)) {
    issues.push(err(`custom rule '${id}': limit.op must be one of ${LIMIT_OPS.join(' ')}`));
    return null;
  }
  const value = raw.limit.value;
  if (typeof value !== signature.limitType) {
    issues.push(err(`custom rule '${id}': predicate '${predicate}' takes a ${signature.limitType} limit, got ${typeof value}`));
    return null;
  }
  if (signature.limitType !== 'number' && (op === '>=' || op === '<=')) {
    issues.push(err(`custom rule '${id}': '${op}' needs a numeric limit`));
    return null;
  }
  let scope: RuleScope | undefined;
  if (raw.scope !== undefined) {
    const s = validateScope(raw.scope, `custom rule '${id}'`, issues);
    if (!s) return null;
    scope = s;
  }
  let severity: Severity | undefined;
  if (raw.severity !== undefined) {
    if (typeof raw.severity !== 'string' || !SEVERITIES.includes(raw.severity as Severity) || raw.severity === 'error') {
      issues.push(err(`custom rule '${id}': severity must be info, deviation or violation ('error' is reserved for the engine)`));
      return null;
    }
    severity = raw.severity as Severity;
  }
  let resolution: CustomRule['resolution'];
  if (raw.resolution !== undefined) {
    if (typeof raw.resolution !== 'string' || !RESOLUTION_IDS.includes(raw.resolution as 'none')) {
      issues.push(err(`custom rule '${id}': unknown resolution '${String(raw.resolution)}'`));
      return null;
    }
    resolution = raw.resolution as CustomRule['resolution'];
  }
  const source = typeof raw.source === 'string' ? raw.source : undefined;
  seen.add(id);
  const subject = { ...(raw.subject as Record<string, unknown>) } as unknown as SubjectSelector;
  return {
    id, title, subject, predicate: predicate as PredicateId, object,
    limit: { op: op as LimitOp, value: value as number, unit: typeof raw.limit.unit === 'string' ? raw.limit.unit : undefined },
    scope, severity, resolution, source,
  };
}

export function validateRuleOverrides(raw: unknown): { overrides: RuleOverrides | null; issues: Deviation[] } {
  const issues: Deviation[] = [];
  if (raw === undefined || raw === null) return { overrides: null, issues };
  if (!isObject(raw)) {
    issues.push(err('spec.rules must be an object'));
    return { overrides: null, issues };
  }
  if (raw.version !== 1) {
    issues.push(err(`spec.rules.version must be 1, got ${JSON.stringify(raw.version)}`));
    return { overrides: null, issues };
  }
  const out: RuleOverrides = { version: 1 };

  if (raw.params !== undefined) {
    if (!isObject(raw.params)) {
      issues.push(err('spec.rules.params must be an object of ruleId → {param: value}'));
    } else {
      const params: Record<string, Record<string, number | string | boolean>> = {};
      for (const ruleId of Object.keys(raw.params).sort()) {
        const entry = (raw.params as Record<string, unknown>)[ruleId];
        if (!isObject(entry)) {
          issues.push(err(`spec.rules.params['${ruleId}'] must be an object of parameter name → value`));
          continue;
        }
        const clean: Record<string, number | string | boolean> = {};
        for (const name of Object.keys(entry).sort()) {
          const v = entry[name];
          if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') clean[name] = v;
          else issues.push(err(`spec.rules.params['${ruleId}'].${name} must be a number, string or boolean`));
        }
        if (Object.keys(clean).length > 0) params[ruleId] = clean;
      }
      if (Object.keys(params).length > 0) out.params = params;
    }
  }

  if (raw.severity !== undefined) {
    if (!isObject(raw.severity)) {
      issues.push(err('spec.rules.severity must be an object of ruleId → severity'));
    } else {
      const sev: Record<string, Severity> = {};
      for (const ruleId of Object.keys(raw.severity).sort()) {
        const v = (raw.severity as Record<string, unknown>)[ruleId];
        if (typeof v === 'string' && SEVERITIES.includes(v as Severity) && v !== 'error') sev[ruleId] = v as Severity;
        else issues.push(err(`spec.rules.severity['${ruleId}'] must be info, deviation or violation`));
      }
      if (Object.keys(sev).length > 0) out.severity = sev;
    }
  }

  if (raw.disabled !== undefined) {
    if (!Array.isArray(raw.disabled) || raw.disabled.some(v => typeof v !== 'string')) {
      issues.push(err('spec.rules.disabled must be an array of rule ids'));
    } else {
      out.disabled = [...(raw.disabled as string[])].sort();
    }
  }

  if (raw.profiles !== undefined) {
    if (!Array.isArray(raw.profiles) || raw.profiles.some(v => typeof v !== 'string')) {
      issues.push(err('spec.rules.profiles must be an array of profile names'));
    } else {
      const names = (raw.profiles as string[]).filter(n => {
        if (RULE_PROFILE_NAMES.includes(n)) return true;
        issues.push(err(`spec.rules.profiles: unknown profile '${n}' (known: ${RULE_PROFILE_NAMES.join(', ')})`));
        return false;
      });
      if (names.length > 0) out.profiles = [...names].sort();
    }
  }

  if (raw.custom !== undefined) {
    if (!Array.isArray(raw.custom)) {
      issues.push(err('spec.rules.custom must be an array of custom rules'));
    } else {
      const seen = new Set<string>();
      const custom: CustomRule[] = [];
      for (const c of raw.custom) {
        const rule = validateCustom(c, seen, issues);
        if (rule) custom.push(rule);
      }
      if (custom.length > 0) out.custom = custom.sort((a, b) => (a.id < b.id ? -1 : 1));
    }
  }

  return { overrides: out, issues };
}

// ---------------------------------------------------------------------------------------------------------------
// CustomRule → Rule
// ---------------------------------------------------------------------------------------------------------------

/** Scope facets implied by the subject selector (a room-type selector IS a scope). */
function scopeFromSubject(subject: SubjectSelector, scope: RuleScope | undefined): RuleScope {
  const out: RuleScope = { ...(scope ?? {}) };
  if (subject.kind === 'room' && subject.roomType && subject.roomType.length > 0) {
    out.roomType = subject.roomType.filter(t => ROOM_TYPES.includes(t as RoomType)) as RoomType[];
  }
  if (subject.kind === 'unit' && subject.templateId && subject.templateId.length > 0) {
    out.templateIds = subject.templateId.filter(t => TEMPLATE_IDS.includes(t as UnitTemplateId)) as UnitTemplateId[];
  }
  if (subject.kind === 'floor' && subject.floorUse && subject.floorUse.length > 0) {
    out.floorUse = subject.floorUse.filter(t => FLOOR_USES.includes(t as FloorUse)) as FloorUse[];
  }
  if (subject.kind === 'element' && subject.elementKind && subject.elementKind.length > 0) {
    out.elementKinds = subject.elementKind.filter(t => ELEMENT_KINDS.includes(t as ElementKind)) as ElementKind[];
  }
  return out;
}

export function customToRule(c: CustomRule): Rule {
  const args: (string | number | boolean)[] = [];
  if (c.object && c.object.kind !== 'none') args.push(c.object.value);
  if (c.subject.kind === 'run' && c.subject.system && c.subject.system.length > 0) args.push(c.subject.system[0]);
  return {
    id: c.id,
    title: c.title,
    discipline: 'xd',
    kind: 'constraint',
    scope: scopeFromSubject(c.subject, c.scope),
    params: {
      limit: { value: c.limit.value, unit: c.limit.unit, source: c.source && c.source.length > 0 ? c.source : 'spec' },
      op: { value: c.limit.op, source: 'spec' },
    },
    predicate: { id: c.predicate, args },
    severity: c.severity ?? 'violation',
    resolution: c.resolution,
    rationale: `Project rule from spec.rules${c.source ? ` (${c.source})` : ''}.`,
    subject: c.subject.kind,
  };
}
