/**
 * Self-contained structural validator for the STEP (ISO 10303-21) files this
 * package writes. It is NOT a schema checker: it proves the file is well-formed
 * and internally consistent, which is what catches writer bugs.
 *
 * Checks
 * - header: ISO-10303-21 / HEADER / FILE_DESCRIPTION / FILE_NAME / FILE_SCHEMA /
 *   ENDSEC / DATA / ENDSEC / END-ISO-10303-21
 * - every data line is `#<int>=<TYPE>(...);`
 * - express ids unique
 * - balanced parentheses per entity, quoted strings ('' escape) respected
 * - every `#n` reference inside arguments resolves to a defined id
 * - numeric tokens are plain decimals: no NaN, no Infinity, no `1e-7`
 * - exactly one IFCPROJECT, at least one IFCSITE / IFCBUILDING / IFCBUILDINGSTOREY
 * - every IFCRELCONTAINEDINSPATIALSTRUCTURE has a non-empty resolvable member list
 *
 * Complexity is O(file length) with one character sweep per data line; a 30 MB
 * file validates in well under 2 s.
 */

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  entityCount: number;
  byType: Record<string, number>;
  unresolvedRefs: number;
  schema: string;
}

/** Hard cap on reported errors/warnings — a broken writer can produce millions. */
const MAX_REPORTED = 50;

const REQUIRED_ONCE = ['IFCPROJECT'];
const REQUIRED_AT_LEAST_ONCE = ['IFCSITE', 'IFCBUILDING', 'IFCBUILDINGSTOREY'];

/** Relationships whose member SET must hold at least one reference. */
const MEMBER_LIST_RELATIONSHIPS = new Set([
  'IFCRELCONTAINEDINSPATIALSTRUCTURE',
  'IFCRELAGGREGATES',
  'IFCRELASSIGNSTOGROUP',
  'IFCRELDEFINESBYPROPERTIES',
  'IFCRELDEFINESBYTYPE',
  'IFCRELASSOCIATESMATERIAL',
  'IFCRELSERVICESBUILDINGS',
]);

export function validateStep(content: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const byType: Record<string, number> = {};
  let errorOverflow = 0;
  let warningOverflow = 0;

  const error = (message: string): void => {
    if (errors.length < MAX_REPORTED) errors.push(message);
    else errorOverflow += 1;
  };
  const warning = (message: string): void => {
    if (warnings.length < MAX_REPORTED) warnings.push(message);
    else warningOverflow += 1;
  };

  const fail = (message: string): ValidationResult => {
    errors.push(message);
    return { ok: false, errors, warnings, entityCount: 0, byType, unresolvedRefs: 0, schema: '' };
  };

  if (typeof content !== 'string' || content.length === 0) return fail('empty content');

  // ---- header --------------------------------------------------------------
  const head = content.slice(0, 4096);
  if (!/^\s*ISO-10303-21\s*;/.test(head)) return fail('missing ISO-10303-21; magic');
  if (!/\bHEADER\s*;/.test(head)) return fail('missing HEADER; section');
  if (!/\bFILE_SCHEMA\s*\(/.test(head)) return fail('missing FILE_SCHEMA entry in HEADER');
  if (!/\bFILE_NAME\s*\(/.test(head)) warning('HEADER has no FILE_NAME entry');
  if (!/\bFILE_DESCRIPTION\s*\(/.test(head)) warning('HEADER has no FILE_DESCRIPTION entry');

  const schemaMatch = /FILE_SCHEMA\s*\(\s*\(\s*'([^']*)'/.exec(head);
  const schema = schemaMatch ? schemaMatch[1] : '';
  if (!schema) warning('FILE_SCHEMA does not name a schema');

  const dataMatch = /(^|\n)\s*DATA\s*;/.exec(content);
  if (!dataMatch) return fail('missing DATA; section');
  const headerEnd = content.slice(0, dataMatch.index).search(/\bENDSEC\s*;/);
  if (headerEnd < 0) return fail('HEADER section is not terminated by ENDSEC;');

  const dataStart = dataMatch.index + dataMatch[0].length;
  const endMatch = /(^|\n)\s*ENDSEC\s*;\s*(\n|\r\n)?\s*END-ISO-10303-21\s*;/.exec(content.slice(dataStart));
  if (!endMatch) {
    if (!/\bEND-ISO-10303-21\s*;/.test(content)) return fail('missing END-ISO-10303-21; terminator');
    return fail('DATA section is not terminated by ENDSEC; END-ISO-10303-21;');
  }
  const dataEnd = dataStart + endMatch.index;

  // ---- data section --------------------------------------------------------
  const ids = new Set<number>();
  /** ref id → first line number that used it (deduped, so memory stays bounded) */
  const refs = new Map<number, number>();
  /** IFCRELCONTAINEDINSPATIALSTRUCTURE / IFCRELAGGREGATES sanity */
  let entityCount = 0;
  let lineNo = countNewlines(content, 0, dataStart) + 1;

  const data = content.slice(dataStart, dataEnd);
  const lines = data.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNumber = lineNo + i;
    const line = raw.trim();
    if (line.length === 0) continue;

    if (line[0] !== '#') {
      error(`line ${lineNumber}: data line does not start with '#': ${snippet(line)}`);
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 2) {
      error(`line ${lineNumber}: missing '=' after express id: ${snippet(line)}`);
      continue;
    }
    const idText = line.slice(1, eq);
    if (!/^[0-9]+$/.test(idText)) {
      error(`line ${lineNumber}: express id '${idText}' is not an integer: ${snippet(line)}`);
      continue;
    }
    const id = Number(idText);
    if (ids.has(id)) error(`line ${lineNumber}: duplicate express id #${id}`);
    ids.add(id);

    const open = line.indexOf('(', eq);
    if (open < 0) {
      error(`line ${lineNumber}: entity #${id} has no argument list`);
      continue;
    }
    const type = line.slice(eq + 1, open).trim();
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(type)) {
      error(`line ${lineNumber}: entity #${id} has an invalid type name '${snippet(type)}'`);
      continue;
    }
    const typeKey = type.toUpperCase();
    byType[typeKey] = (byType[typeKey] ?? 0) + 1;
    entityCount += 1;

    if (!line.endsWith(';')) {
      error(`line ${lineNumber}: entity #${id} (${typeKey}) does not end with ';'`);
      continue;
    }

    // Single character sweep over the argument list: paren balance, string
    // escapes, `#` references and numeric/keyword token shape.
    let depth = 0;
    let inString = false;
    let refCount = 0;
    let emptyLists = 0;
    let closed = -1;
    let lastTopLevelComma = -1;
    for (let p = open; p < line.length; p++) {
      const ch = line[p];
      if (inString) {
        if (ch === "'") {
          if (line[p + 1] === "'") p += 1; // '' escape
          else inString = false;
        }
        continue;
      }
      if (ch === "'") { inString = true; continue; }
      if (ch === '(') {
        depth += 1;
        if (line[p + 1] === ')') emptyLists += 1;
        continue;
      }
      if (ch === ')') {
        depth -= 1;
        if (depth === 0) { closed = p; }
        if (depth < 0) break;
        continue;
      }
      if (ch === ',') {
        if (depth === 1) lastTopLevelComma = p;
        continue;
      }
      if (ch === '#') {
        let q = p + 1;
        while (q < line.length && line[q] >= '0' && line[q] <= '9') q += 1;
        if (q === p + 1) {
          error(`line ${lineNumber}: entity #${id} (${typeKey}) has a '#' that is not followed by digits`);
        } else {
          const ref = Number(line.slice(p + 1, q));
          if (!refs.has(ref)) refs.set(ref, lineNumber);
          refCount += 1;
        }
        p = q - 1;
        continue;
      }
      if (ch === '-' || ch === '+' || ch === '.' || (ch >= '0' && ch <= '9') || (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '_') {
        let q = p;
        while (q < line.length && !isDelimiter(line[q])) q += 1;
        const token = line.slice(p, q);
        const problem = classifyToken(token);
        if (problem) error(`line ${lineNumber}: entity #${id} (${typeKey}): ${problem}`);
        p = q - 1;
        continue;
      }
      // ',', '*', '$', whitespace and ';' need no checking
    }

    if (inString) error(`line ${lineNumber}: entity #${id} (${typeKey}) has an unterminated string`);
    if (depth !== 0) error(`line ${lineNumber}: entity #${id} (${typeKey}) has unbalanced parentheses`);
    else if (closed >= 0 && line.slice(closed + 1).trim() !== ';') {
      error(`line ${lineNumber}: entity #${id} (${typeKey}) has trailing content after the argument list: ${snippet(line.slice(closed + 1))}`);
    }

    // Relationship SETs are [1:?] in the schema: an empty member list means the
    // writer emitted a relationship for nothing.
    if (MEMBER_LIST_RELATIONSHIPS.has(typeKey)) {
      const lastAttr = closed > lastTopLevelComma && lastTopLevelComma > 0
        ? line.slice(lastTopLevelComma + 1, closed).trim()
        : '';
      if (refCount < 2) {
        error(`line ${lineNumber}: #${id} ${typeKey} needs at least one element and a relating object (found ${refCount} references)`);
      } else if (emptyLists > 0) {
        error(`line ${lineNumber}: #${id} ${typeKey} needs at least one element (empty member list)`);
      } else if (lastAttr === '$' || lastAttr === '*' || lastAttr === '') {
        error(`line ${lineNumber}: #${id} ${typeKey} needs at least one element and a relating object (last attribute is '${lastAttr || 'missing'}')`);
      }
    }
  }

  // ---- reference resolution ------------------------------------------------
  let unresolvedRefs = 0;
  for (const [ref, atLine] of refs) {
    if (!ids.has(ref)) {
      unresolvedRefs += 1;
      error(`line ${atLine}: unresolved reference #${ref}`);
    }
  }

  // ---- spatial structure ---------------------------------------------------
  for (const type of REQUIRED_ONCE) {
    const count = byType[type] ?? 0;
    if (count !== 1) error(`expected exactly 1 ${type}, found ${count}`);
  }
  for (const type of REQUIRED_AT_LEAST_ONCE) {
    if ((byType[type] ?? 0) < 1) error(`expected at least 1 ${type}, found 0`);
  }
  if (entityCount === 0) error('DATA section contains no entities');

  if (errorOverflow > 0) errors.push(`… ${errorOverflow} further errors suppressed`);
  if (warningOverflow > 0) warnings.push(`… ${warningOverflow} further warnings suppressed`);

  return { ok: errors.length === 0, errors, warnings, entityCount, byType, unresolvedRefs, schema };
}

// ============================================================================
// Token helpers
// ============================================================================

function isDelimiter(ch: string): boolean {
  return ch === ',' || ch === '(' || ch === ')' || ch === ';' || ch === '=' || ch === ' '
    || ch === '\t' || ch === '\r' || ch === "'" || ch === '#' || ch === '$' || ch === '*';
}

const KEYWORD = /^[A-Za-z][A-Za-z0-9_]*$/;
const ENUM = /^\.[A-Za-z0-9_]+\.$/;
const PLAIN_NUMBER = /^[-+]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)$/;

/**
 * Classify a bare token; returns a problem description or `null` when fine.
 *
 * STEP tokens seen here: integers (`3`), reals (`0.15`, `-1.`, `.5`), enums
 * (`.ELEMENT.`), logicals (`.T.`), and keywords used as typed values
 * (`IFCREAL`, `IFCINTEGER`, `IFCNORMALISEDRATIOMEASURE`).
 */
function classifyToken(token: string): string | null {
  if (token.length === 0) return null;
  if (ENUM.test(token)) return null;
  const first = token[0];
  const numeric = first === '-' || first === '+' || first === '.' || (first >= '0' && first <= '9');
  if (!numeric) {
    if (KEYWORD.test(token)) {
      const upper = token.toUpperCase();
      if (upper === 'NAN' || upper === 'INF' || upper === 'INFINITY') {
        return `'${token}' is not a valid STEP value`;
      }
      return null;
    }
    return `malformed token '${snippet(token)}'`;
  }
  if (/[eE]/.test(token)) {
    return `exponent literal '${token}' — STEP numbers must be written as plain decimals`;
  }
  if (/nan|inf/i.test(token)) return `'${token}' is not a valid STEP number`;
  if (!PLAIN_NUMBER.test(token)) return `malformed number '${snippet(token)}'`;
  return null;
}

function countNewlines(text: string, from: number, to: number): number {
  let n = 0;
  for (let i = from; i < to; i++) if (text.charCodeAt(i) === 10) n += 1;
  return n;
}

function snippet(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
