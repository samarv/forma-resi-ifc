/**
 * The rule engine — barrel.
 *
 * The pipeline builds the set (`createRuleSet` over `builtinRules()` + `rulesFromPatterns(book.all())`), disciplines
 * read it through `ctx.rules`, the validator runs `check()`, and the app's Rules tab renders `RULE_OVERRIDES_SCHEMA`
 * + `PREDICATE_SIGNATURES`.
 */
export type * from './types.ts';

export { SOURCES, cite, isCited, sourceKeys } from './SOURCES.ts';
export type { SourceKey } from './SOURCES.ts';

export { createLedger, severities, warningString } from './ledger.ts';

export { autoProfiles, check, createRuleSet, patternParamOverrides, scopeMatches, violations } from './engine.ts';
export type { CheckInput, CheckReport, CreateRuleSetInput } from './engine.ts';

export { PREDICATES, PREDICATE_IDS, PREDICATE_SIGNATURES, cmp, limitOf, numLimit, opOf } from './predicates.ts';

export {
  KERNEL_RULE_IDS, RULE_PROFILES, RULE_PROFILE_NAMES, builtinRules, constraintRules, labelRules, profileParamRules,
  tableRules, tunableRules,
} from './builtin.ts';

export { numericParamIds, rulesFromPatterns } from './from-patterns.ts';

export {
  ELEMENT_KINDS, FLOOR_USES, LIMIT_OPS, PREDICATE_ID_LIST, RESOLUTION_IDS, ROOM_TYPES, RULE_OVERRIDES_SCHEMA,
  SEVERITIES, TEMPLATE_IDS, customToRule, validateRuleOverrides,
} from './schema.ts';

export { EMPTY_ROOM_GRAPH, buildRoomGraph, roomGraphOf } from './graph.ts';
export type { RoomGraphInput } from './graph.ts';
