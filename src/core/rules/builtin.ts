/**
 * The hand-authored rules: the coordination constraints the pattern parameters do not express, plus the band /
 * clear-height / hanger / slope / trap-arm tables lifted out of `kernel/` so they are data on the Rules tab.
 *
 * A `param` rule carries one `value` (or a set of named values, or a stepped table keyed by numeric strings); a
 * `constraint` rule carries a `predicate` and the parameters that predicate reads (`limit`, `op`, `tolerance`).
 * Every parameter cites a pinned edition from `SOURCES.ts`.
 *
 * Severity discipline: `violation` = the generator should have satisfied this and did not (a bug, and the presets
 * must have none); `deviation` = an explicit relaxation that was recorded; `info` = a resolution was applied.
 */
import type { Rule, RuleParam } from './types.ts';
import { cite } from './SOURCES.ts';
import { PROFILE_DEFS, bandRuleId, clearHeightRuleId } from '../kernel/profiles.ts';
import {
  CLEAR_HEIGHTS, HANGER_BUSDUCT, HANGER_DUCT_RECT, HANGER_DUCT_ROUND, HANGER_PIPE_CAST_IRON,
  HANGER_PIPE_COPPER_LARGE, HANGER_PIPE_COPPER_SMALL, HANGER_PIPE_PLASTIC, HANGER_SPRINKLER, HANGER_TRAY, SLOPES,
  TRAP_ARMS, TRAP_ARM_SOURCE, ZONE_CLEARS,
} from '../kernel/clearances.ts';

function p(value: number | string | boolean, unit: string | undefined, source: string): RuleParam {
  return { value, unit, source };
}

// ---------------------------------------------------------------------------------------------------------------
// Band and clear-height parameters, generated from the profile tables (one owner: profiles.ts)
// ---------------------------------------------------------------------------------------------------------------

export function profileParamRules(): Rule[] {
  const out: Rule[] = [];
  for (const profile of PROFILE_DEFS) {
    out.push({
      id: clearHeightRuleId(profile.id),
      title: `${profile.label} — clear height`,
      discipline: 'xd',
      patternId: 'XD-06',
      kind: 'param',
      scope: {},
      params: {
        min: p(profile.clearHeight.min, 'm', profile.clearHeight.source),
        target: p(profile.clearHeight.target, 'm', profile.clearHeight.source),
      },
      severity: 'info',
      rationale: `The minimum is code; the target is what the profile aims for when the plenum fits. ${profile.notes}`,
    });
    for (const band of profile.bands) {
      out.push({
        id: bandRuleId(profile.id, band.purpose),
        title: `${profile.label} — ${band.id}`,
        discipline: 'xd',
        patternId: 'XD-06',
        kind: 'param',
        scope: {},
        params: {
          depth: p(band.depth, 'm', band.source),
          minDepth: p(band.minDepth, 'm', band.source),
          flexibility: p(band.flexibility, '1 fixed … 5 trivial', cite('default', '(MOVE_COST)')),
        },
        severity: 'info',
        rationale: band.rationale,
      });
    }
  }
  for (const z of ZONE_CLEARS) {
    out.push({
      id: `XD-06.zoneClear.${z.profile}.${z.zone}`,
      title: `${z.profile} — ${z.zone} clear height`,
      discipline: 'xd',
      patternId: 'XD-06',
      kind: 'param',
      scope: {},
      params: { value: p(z.minClear, 'm', z.source) },
      severity: 'info',
      rationale: z.note,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------------------------------------------

function tableParams(rows: readonly [number, number][], unit: string, source: string): Record<string, RuleParam> {
  const out: Record<string, RuleParam> = {};
  for (const [k, v] of rows) out[String(k)] = p(v, unit, source);
  return out;
}

export function tableRules(): Rule[] {
  return [
    {
      id: 'PLB-02.trapArm',
      title: 'Trap arm — maximum developed length by trap size',
      discipline: 'plumbing',
      patternId: 'PLB-02',
      kind: 'param',
      scope: {},
      params: tableParams(TRAP_ARMS, 'm', TRAP_ARM_SOURCE),
      severity: 'info',
      rationale: 'Corrects the v1 table, which mis-binned Ø50 at 1.5 m: IPC Table 1002.2 gives 1.83 m for a 2 in trap arm, 3.05 m for 3 in and 3.66 m for 4 in.',
    },
    {
      id: 'PLB-01.slopeSanitary',
      title: 'Sanitary drainage — minimum fall by diameter',
      discipline: 'plumbing',
      patternId: 'PLB-01',
      kind: 'param',
      scope: {},
      params: tableParams(SLOPES.sanitary.map(s => [Number.isFinite(s.maxDiameter) ? s.maxDiameter : 1, s.slope] as [number, number]), 'm/m', SLOPES.sanitary[0].source),
      severity: 'info',
      rationale: '1/4 in per ft to Ø75, 1/8 in per ft Ø100–Ø150, 1/16 in per ft Ø200 and larger.',
    },
    {
      id: 'PLB-01.slopeStorm',
      title: 'Storm drainage — minimum fall',
      discipline: 'plumbing',
      patternId: 'PLB-01',
      kind: 'param',
      scope: {},
      params: { value: p(SLOPES.storm.slope, 'm/m', SLOPES.storm.source) },
      severity: 'info',
      rationale: 'Horizontal storm drains fall at least 1:100.',
    },
    {
      id: 'PLB-01.slopeMaxGravity',
      title: 'Gravity drainage — steepest sloped run',
      discipline: 'plumbing',
      patternId: 'PLB-01',
      kind: 'param',
      scope: {},
      params: { value: p(SLOPES.maxGravity.slope, 'm/m', SLOPES.maxGravity.source) },
      severity: 'info',
      rationale: 'Steeper than 1:12 is a vertical leg with a long-turn bend, not a sloped run.',
    },
    {
      id: 'XD-12.hangerDrop',
      title: 'Everything hangs from something — maximum hanger drop',
      discipline: 'xd',
      patternId: 'XD-12',
      kind: 'param',
      scope: {},
      params: {
        duct: p(HANGER_DUCT_RECT.maxDrop, 'm', HANGER_DUCT_RECT.source),
        pipe: p(HANGER_PIPE_COPPER_LARGE.maxDrop, 'm', HANGER_PIPE_COPPER_LARGE.source),
        sprinkler: p(HANGER_SPRINKLER.maxDrop, 'm', HANGER_SPRINKLER.source),
        tray: p(HANGER_TRAY.maxDrop, 'm', HANGER_TRAY.source),
        busduct: p(HANGER_BUSDUCT.maxDrop, 'm', HANGER_BUSDUCT.source),
      },
      severity: 'info',
      rationale: 'A run further below the soffit than this needs a frame, a wall or a floor — not a hanger rod.',
    },
    {
      id: 'XD-12.hangerSpacing',
      title: 'Everything hangs from something — hanger spacing',
      discipline: 'xd',
      patternId: 'XD-12',
      kind: 'param',
      scope: {},
      params: {
        ductRect: p(HANGER_DUCT_RECT.maxSpacing, 'm', HANGER_DUCT_RECT.source),
        ductRound: p(HANGER_DUCT_ROUND.maxSpacing, 'm', HANGER_DUCT_ROUND.source),
        pipeCopperSmall: p(HANGER_PIPE_COPPER_SMALL.maxSpacing, 'm', HANGER_PIPE_COPPER_SMALL.source),
        pipeCopperLarge: p(HANGER_PIPE_COPPER_LARGE.maxSpacing, 'm', HANGER_PIPE_COPPER_LARGE.source),
        pipePlastic: p(HANGER_PIPE_PLASTIC.maxSpacing, 'm', HANGER_PIPE_PLASTIC.source),
        pipeCastIron: p(HANGER_PIPE_CAST_IRON.maxSpacing, 'm', HANGER_PIPE_CAST_IRON.source),
        sprinkler: p(HANGER_SPRINKLER.maxSpacing, 'm', HANGER_SPRINKLER.source),
        tray: p(HANGER_TRAY.maxSpacing, 'm', HANGER_TRAY.source),
      },
      severity: 'info',
      rationale: 'The spacing tables that make a run buildable; they also set the minimum band depth (a hanger needs room above the run).',
    },
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// Parameters the generators read that no pattern owns
// ---------------------------------------------------------------------------------------------------------------

export function tunableRules(): Rule[] {
  return [
    {
      id: 'XD-00.issueCapPerRule', title: 'Issues listed individually per rule', discipline: 'xd', kind: 'param', scope: {},
      params: { value: p(25, 'count', cite('default', '(report budget, not a design rule)')) },
      severity: 'info',
      rationale: 'A systemic problem should produce one readable issue with a count, not sixty thousand.',
    },
    {
      id: 'XD-02.crossingPitch', title: 'Corridor Service Spine — crossing station pitch', discipline: 'xd', patternId: 'XD-02', kind: 'param', scope: {},
      params: { value: p(0.3, 'm', cite('SMACNA 3rd ed.', 'Chapter 2 (fitting + insulation between crossings)')) },
      severity: 'info',
      rationale: 'Two branches crossing the corridor keep one pitch apart, so a fitting can be installed between them.',
    },
    {
      id: 'XD-04.shaftFillMax', title: 'Shafts at the Core — maximum shaft fill', discipline: 'xd', patternId: 'XD-04', kind: 'param', scope: {},
      params: { value: p(0.6, 'fraction of shaft area', cite('default', '(installation and maintenance access between risers)')) },
      severity: 'info',
      rationale: 'Beyond about 60 % of the shaft footprint there is no room to install or replace a riser.',
    },
    {
      id: 'XD-06.habitableFloorToFloor', title: 'Ceiling Sandwich \u2014 floor-to-floor below which a storey is not habitable', discipline: 'xd', patternId: 'XD-06', kind: 'param', scope: {},
      params: { value: p(2.0, 'm', cite('default', '(SITE, FND and a roof parapet are not storeys a ceiling profile can be compressed for)')) },
      severity: 'info',
      rationale: 'Below this a storey is a datum or a parapet, not a room: resolving its bands is meaningful, compressing them or asking for a taller storey is not.',
    },
    {
      id: 'XD-06.highRiseStoreys', title: 'Ceiling Sandwich — storeys at which the high-rise rule profile applies', discipline: 'xd', patternId: 'XD-06', kind: 'param', scope: {},
      params: { value: p(8, 'storeys', cite('IBC 2021', '§202 (high-rise: occupied floor > 23 m above fire-service access)')) },
      severity: 'info',
      rationale: 'Eight residential storeys puts the top occupied floor above 23 m, which is the high-rise threshold.',
    },
    {
      id: 'XD-07.demiseCapDistance', title: 'Shell-and-Core Demise — cap distance from the demise line', discipline: 'xd', patternId: 'XD-09', kind: 'param', scope: {},
      params: { value: p(1.0, 'm', cite('default', '(landlord shell-and-core standard: capped, valved, metered within 1 m)')) },
      severity: 'info',
      rationale: 'A landlord service must terminate capped, valved and metered within reach of the demise line, so the tenant fit-out connects rather than cuts.',
    },
    {
      id: 'ARC-03.breakSlotLength', title: 'Double-Loaded Corridor — break slot length', discipline: 'architecture', patternId: 'ARC-03', kind: 'param', scope: {},
      params: { value: p(5.0, 'm', cite('default', '(a lounge, a window bay or a core fits in 5 m of corridor length)')) },
      severity: 'info',
      rationale: 'The corridor graph reserves this much length at each leg joint; a core placed in the slot costs no corridor length.',
    },
    {
      id: 'SIT-07.maxBasementStoreys', title: 'Parking — basement levels the solver may add', discipline: 'site', patternId: 'SIT-07', kind: 'param', scope: {},
      params: { value: p(3, 'storeys', cite('default', '(excavation cost and dewatering; overridable per project)')) },
      severity: 'info',
      rationale: 'The parking solver adds basement levels before it relaxes the parking ratio.',
    },
    {
      id: 'SIT-07.maxPodiumStoreys', title: 'Parking — podium levels the solver may add', discipline: 'site', patternId: 'SIT-07', kind: 'param', scope: {},
      params: { value: p(3, 'storeys', cite('default', '(street frontage and massing)')) },
      severity: 'info',
      rationale: 'Podium parking is added only when the podium use allows it.',
    },
    {
      id: 'SIT-08.deadEnd', title: 'Egress — maximum dead-end corridor', discipline: 'site', patternId: 'SIT-08', kind: 'param', scope: {},
      params: {
        value: p(6.0, 'm', cite('IBC 2021', '§1020.4 (6.1 m; 15.2 m where sprinklered)')),
        sprinklered: p(15.0, 'm', cite('IBC 2021', '§1020.4 exception 2')),
      },
      severity: 'info',
      rationale: 'A dead end longer than this needs an exit at its end — which is why the corridor graph asks for a core there.',
    },
    {
      id: 'PLB-07.drainPerM2', title: 'Plant room floor drains — one per area', discipline: 'plumbing', patternId: 'PLB-07', kind: 'param', scope: {},
      params: {
        value: p(40, 'm² per drain', cite('IPC 2021', '§1101 / §802 (indirect wastes)')),
        max: p(6, 'drains', cite('default', '(beyond six, the room wants a trench)')),
      },
      severity: 'info',
      rationale: 'A plant room floor is washed down and leaks; it drains through an indirect waste.',
    },
    {
      id: 'PLB-07.drainCover', title: 'Building drain — cover to the lateral', discipline: 'plumbing', patternId: 'PLB-07', kind: 'param', scope: {},
      params: {
        value: p(0.45, 'm', cite('IPC 2021', '§305.4.1')),
        paved: p(0.6, 'm', cite('BS EN 752:2017', '§9.3')),
      },
      severity: 'info',
      rationale: 'The sewer invert is derived from cover + fall × run, not from a fixed constant: that is what makes a level pumped or gravity.',
    },
    {
      id: 'ELE-06.parkingLightingM2', title: 'Car park lighting — one luminaire per area', discipline: 'electrical', patternId: 'ELE-06', kind: 'param', scope: {},
      params: { value: p(81, 'm² per luminaire', cite('IECC 2021', 'Table C405.3.2(2) (parking garage 0.15 W/ft²)')) },
      severity: 'info',
      rationale: 'v1 had this as a bare 81 in devices.ts; it is a lighting-power decision, so it is a rule.',
    },
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// Constraint rules
// ---------------------------------------------------------------------------------------------------------------

function constraint(o: {
  id: string;
  title: string;
  discipline: Rule['discipline'];
  patternId?: string;
  subject: Rule['subject'];
  predicate: NonNullable<Rule['predicate']>;
  params: Record<string, RuleParam>;
  severity: Rule['severity'];
  resolution?: Rule['resolution'];
  scope?: Rule['scope'];
  rationale: string;
}): Rule {
  return {
    id: o.id,
    title: o.title,
    discipline: o.discipline,
    patternId: o.patternId,
    kind: 'constraint',
    scope: o.scope ?? {},
    params: o.params,
    predicate: o.predicate,
    severity: o.severity,
    resolution: o.resolution,
    rationale: o.rationale,
    subject: o.subject,
  };
}

const OP_GE: RuleParam = { value: '>=', source: cite('default', '(comparison)') };
const OP_LE: RuleParam = { value: '<=', source: cite('default', '(comparison)') };

/**
 * A rule the kernel enforces at RESERVATION time — before any geometry is emitted — rather than in the post-check.
 * It carries no predicate, so `check()` never evaluates it; `reserve` / `validate` / `checkSupport` cite its id on
 * the `Conflict` and the `Issue` they raise. Keeping it in the rule set is what lets the Rules tab show it, a
 * project override retune it, and `no-duplicate-constants.test.ts` prove the id exists.
 */
function byConstruction(o: {
  id: string;
  title: string;
  discipline: Rule['discipline'];
  patternId?: string;
  subject: Rule['subject'];
  params: Record<string, RuleParam>;
  severity: Rule['severity'];
  resolution?: Rule['resolution'];
  scope?: Rule['scope'];
  rationale: string;
}): Rule {
  return {
    id: o.id, title: o.title, discipline: o.discipline, patternId: o.patternId, kind: 'constraint',
    scope: o.scope ?? {}, params: o.params, severity: o.severity, resolution: o.resolution,
    rationale: o.rationale, subject: o.subject,
  };
}

export function constraintRules(): Rule[] {
  return [
    // --- kernel: bands, lanes, crossings (the conflict reasons the registry reports) ------------------------------
    byConstruction({
      id: 'XD-02.bandExists', title: 'A service has a band to live in', discipline: 'xd', patternId: 'XD-02',
      subject: 'element',
      params: { limit: p(true, undefined, cite('default', '(ceiling profile)')) },
      severity: 'violation', resolution: 'raise-floor-to-floor',
      rationale: 'If the profile has no band for a kind of service on a storey, the service has nowhere legal to go: either the profile is wrong or the storey is too short.',
    }),
    byConstruction({
      id: 'XD-02.bandAllows', title: 'A band only carries what it is for', discipline: 'xd', patternId: 'XD-02',
      subject: 'element',
      params: { limit: p(true, undefined, cite('default', '(ceiling profile)')) },
      severity: 'violation', resolution: 'reroute-in-wall',
      rationale: 'A drain in the sprinkler band would force the sprinkler main away from the soffit and break the deflector distance.',
    }),
    byConstruction({
      id: 'XD-02.inBand', title: 'A run stays inside its band', discipline: 'xd', patternId: 'XD-02',
      subject: 'element',
      params: { limit: p(0.02, 'm', cite('default', '(model tolerance)')) },
      severity: 'violation', resolution: 'compress-band',
      rationale: 'The band is the reservation; leaving it means the coordination the kernel proved no longer describes the model.',
    }),
    byConstruction({
      id: 'XD-02.laneWidth', title: 'A lane is wide enough for what claims it', discipline: 'xd', patternId: 'XD-02',
      subject: 'element',
      params: { limit: p(true, undefined, cite('default', '(lane table)')) },
      severity: 'violation', resolution: 'shift-lateral',
      rationale: 'v1 gave lanes offsets but no widths, so a Ø150 main and the sprinkler main sat 0.20 m apart at the same height.',
    }),
    byConstruction({
      id: 'XD-02.crossingClear', title: 'Crossings do not overlap', discipline: 'xd', patternId: 'XD-02',
      subject: 'element',
      params: { limit: p(true, undefined, cite('default', '(station allocator)')) },
      severity: 'violation', resolution: 'shift-along-lane',
      rationale: 'Two branches crossing at the same station is the classic corridor clash; the allocator shifts one before anything is emitted.',
    }),
    constraint({
      id: 'XD-02.plenumDepth', title: 'The plenum is deep enough for the profile', discipline: 'xd', patternId: 'XD-02',
      subject: 'floor', predicate: { id: 'clearHeight', args: [] },
      params: { limit: p(CLEAR_HEIGHTS['resi-corridor'].min, 'm', CLEAR_HEIGHTS['resi-corridor'].source), op: OP_GE },
      severity: 'deviation', resolution: 'raise-floor-to-floor',
      rationale: 'When compression and dropping are exhausted the storey must get taller; that is a recorded deviation, not a warning.',
    }),

    // --- kernel: shafts, chases, sleeves -------------------------------------------------------------------------
    byConstruction({
      id: 'XD-04.shaftExists', title: 'A riser has a shaft', discipline: 'xd', patternId: 'XD-04',
      subject: 'element',
      params: { limit: p(true, undefined, cite('IBC 2021', '§713 (shaft enclosures)')) },
      severity: 'violation', resolution: 'enlarge-shaft',
      rationale: 'A riser outside a shaft is a slab penetration per storey with no enclosure and no fire stopping.',
    }),
    byConstruction({
      id: 'XD-04.shaftArea', title: 'A shaft is big enough for its risers', discipline: 'xd', patternId: 'XD-04',
      subject: 'building',
      params: { limit: p(0.6, 'fraction', cite('default', '(installation access)')), op: OP_LE },
      severity: 'violation', resolution: 'enlarge-shaft',
      rationale: 'Sizing a shaft by area per unit served is only true if the systems actually fit as footprints — which is what the allocator now proves.',
    }),
    byConstruction({
      id: 'XD-04.hoistway', title: 'Nothing foreign in a hoistway', discipline: 'xd', patternId: 'XD-04',
      subject: 'element',
      params: { limit: p(true, undefined, `${cite('IBC 2021', '§3005.3')}; ${cite('ASME A17.1-2019', '§2.8')}`) },
      severity: 'violation', resolution: 'reroute-in-wall',
      rationale: 'A hoistway shall contain no piping or ducting not serving the hoistway; v1 had no way to express this.',
    }),
    byConstruction({
      id: 'XD-01.wetWall', title: 'A dwelling has exactly one wet-wall chase', discipline: 'xd', patternId: 'XD-01',
      subject: 'unit',
      params: { limit: p(1, 'count', cite('IPC 2021', '§704 (one stack, one invert)')), op: OP_GE },
      severity: 'violation', resolution: 'snap-to-party-line',
      rationale: 'One chase per dwelling column is what makes the stacks stack; the module’s wet-wall port decides where it is.',
    }),
    byConstruction({
      id: 'XD-01.trapArm', title: 'A fixture is within its trap-arm limit of the stack', discipline: 'plumbing', patternId: 'PLB-02',
      subject: 'room',
      params: { limit: p(TRAP_ARMS[2][1], 'm', TRAP_ARM_SOURCE), op: OP_LE },
      severity: 'violation', resolution: 'vent-branch',
      scope: { roomType: ['bathroom', 'ensuite', 'powder', 'wc', 'kitchen', 'laundry'] },
      rationale: 'Beyond the trap arm a fixture needs its own vent; v1 warned instead, and with the wrong Ø50 limit.',
    }),

    // --- support / constructability ------------------------------------------------------------------------------
    byConstruction({
      id: 'XD-S0.inReservation', title: 'No free-floating service', discipline: 'xd', patternId: 'XD-12',
      subject: 'element',
      params: { limit: p(true, undefined, cite('default', '(the kernel contract)')) },
      severity: 'violation',
      rationale: 'Every emitted MEP element must sit inside a reservation of its own discipline: that is the whole invariant.',
    }),
    byConstruction({
      id: 'XD-S1.hangerDrop', title: 'A run hangs within the hanger limit', discipline: 'xd', patternId: 'XD-12',
      subject: 'element',
      params: { limit: p(HANGER_DUCT_RECT.maxDrop, 'm', HANGER_DUCT_RECT.source), op: OP_LE },
      severity: 'violation',
      rationale: 'A run 2 m below the soffit on rod hangers is not buildable; it needs a frame, a wall or a different route.',
    }),
    constraint({
      id: 'XD-S2.riserContinuity', title: 'A riser is continuous', discipline: 'xd', patternId: 'XD-04',
      subject: 'run', predicate: { id: 'continuous', args: [] },
      params: { limit: p(6.0, 'm', cite('default', '(one storey height)')), op: OP_LE },
      severity: 'violation',
      rationale: 'A riser that skips a storey is either two risers or a modelling error.',
    }),
    byConstruction({
      id: 'XD-S2.riserHoused', title: 'A riser’s shaft exists on every storey it crosses', discipline: 'xd', patternId: 'XD-04',
      subject: 'element',
      params: { limit: p(true, undefined, `${cite('IPC 2021', '§308.5')}; ${cite('NEC 2023', '392.30')}`) },
      severity: 'violation', resolution: 'enlarge-shaft',
      rationale: 'A riser needs something to be strapped to on every floor it passes.',
    }),
    byConstruction({
      id: 'XD-S3.equipmentAccess', title: 'Equipment keeps its access clearance', discipline: 'xd', patternId: 'XD-10',
      subject: 'element',
      params: { limit: p(0.6, 'm', cite('IMC 2021', '§306.3')), op: OP_GE },
      severity: 'violation', resolution: 'shift-lateral',
      scope: { floorUse: ['mechanical', 'basement'] },
      rationale: 'A plant room exists so plant can be replaced; 0.6 m all round, 0.75 m at a burner, 1.0 m at a manway.',
    }),
    byConstruction({
      id: 'XD-S4.noMepInHoistway', title: 'No service in a lift hoistway', discipline: 'xd', patternId: 'XD-04',
      subject: 'element',
      params: { limit: p(true, undefined, cite('IBC 2021', '§3005.3')) },
      severity: 'violation', resolution: 'reroute-in-wall',
      rationale: 'The hoistway is a keep-out, so this can only fail if a discipline emitted outside its reservation.',
    }),
    byConstruction({
      id: 'XD-S5.noPenetration', title: 'No service penetrates structure', discipline: 'xd', patternId: 'XD-12',
      subject: 'element',
      params: { limit: p(true, undefined, cite('ACI 318-19', '§6.4 (no designed openings in this model)')) },
      severity: 'violation', resolution: 'reroute-in-wall',
      rationale: 'Beams, columns and drop panels are keep-outs: a sleeve goes through a slab or a non-structural wall, never through a member.',
    }),

    // --- clear heights ------------------------------------------------------------------------------------------
    constraint({
      id: 'XD-06.clearHeightRoom', title: 'A habitable room holds its clear height', discipline: 'architecture', patternId: 'XD-06',
      subject: 'room', predicate: { id: 'clearHeight', args: [] },
      params: { limit: p(CLEAR_HEIGHTS['resi-unit'].min, 'm', CLEAR_HEIGHTS['resi-unit'].source), op: OP_GE },
      severity: 'violation', resolution: 'lower-ceiling',
      scope: { roomType: ['living', 'dining', 'kitchen', 'living-kitchen', 'bedroom', 'master-bedroom', 'study', 'den'] },
      rationale: 'The dwelling clear height is the one dimension a resident feels every day; the profile holds it and the services fit around it.',
    }),
    constraint({
      id: 'XD-06.clearHeightCorridor', title: 'A corridor holds its egress headroom', discipline: 'architecture', patternId: 'XD-06',
      subject: 'corridor', predicate: { id: 'clearHeight', args: [] },
      params: { limit: p(CLEAR_HEIGHTS['resi-corridor'].min, 'm', CLEAR_HEIGHTS['resi-corridor'].source), op: OP_GE },
      severity: 'violation', resolution: 'compress-band',
      rationale: 'Means-of-egress headroom is 2.03 m in the IBC; the profile targets 2.40 m and compresses the service bands before it gives that up.',
    }),
    constraint({
      id: 'XD-08.clearHeightParking', title: 'A drive aisle holds its clear height', discipline: 'architecture', patternId: 'XD-08',
      subject: 'element', predicate: { id: 'clearHeight', args: [] },
      params: { limit: p(CLEAR_HEIGHTS['parking'].min, 'm', CLEAR_HEIGHTS['parking'].source), op: OP_GE },
      severity: 'violation', resolution: 'compress-band',
      scope: { floorUse: ['parking'], elementKinds: ['waste', 'vent', 'storm', 'trench-drain', 'dcw', 'dhw', 'hwr', 'gas', 'duct', 'duct-fitting', 'fan', 'jet-fan', 'sprinkler-main', 'sprinkler-branch', 'tray-power', 'tray-data', 'busduct'] },
      rationale: 'Everything in a car park is exposed, so every service is measured against the vehicle envelope directly.',
    }),
    constraint({
      id: 'XD-08.accessibleRoute', title: 'The accessible route holds 2.50 m', discipline: 'architecture', patternId: 'XD-08',
      subject: 'element', predicate: { id: 'clearHeight', args: [] },
      params: { limit: p(2.5, 'm', `${cite('ADA 2010', '§502.5')}; ${cite('AS 2890.6-2022', '§2.4')}`), op: OP_GE },
      severity: 'violation', resolution: 'shift-lateral',
      scope: { floorUse: ['parking'], elementKinds: ['waste', 'vent', 'storm', 'trench-drain', 'dcw', 'dhw', 'hwr', 'gas', 'duct', 'duct-fitting', 'fan', 'jet-fan', 'sprinkler-main', 'sprinkler-branch', 'tray-power', 'tray-data', 'busduct'] },
      rationale: 'A van-accessible stall and the route from it to the lift lobby need 98 in of clearance — a duct at 2.2 m over that route is a code failure, not a clash.',
    }),

    // --- electrical safety: NEC 110.26 ---------------------------------------------------------------------------
    constraint({
      id: 'ELE-13.workingSpace', title: 'Switchgear keeps its working space', discipline: 'electrical', patternId: 'ELE-13',
      subject: 'element', predicate: { id: 'clearance', args: ['switchgear'] },
      params: { limit: p(1.07, 'm', cite('NEC 2023', 'Table 110.26(A)(1) Condition 2')), op: OP_GE },
      severity: 'violation', resolution: 'shift-lateral',
      scope: { elementKinds: ['waste', 'vent', 'storm', 'trench-drain', 'dcw', 'dhw', 'hwr', 'gas', 'tray-power', 'tray-data', 'duct', 'duct-fitting'] },
      rationale: 'Nothing may be in the 1.07 m depth, 0.76 m width and 2.00 m height in front of live parts.',
    }),
    constraint({
      id: 'ELE-13.dedicatedSpace', title: 'Nothing foreign above switchgear', discipline: 'electrical', patternId: 'ELE-13',
      subject: 'element', predicate: { id: 'notOver', args: ['switchgear'] },
      params: { limit: p(1.8, 'm', cite('NEC 2023', '110.26(E)(1)(a) and (b)')) },
      severity: 'violation', resolution: 'reroute-in-wall',
      scope: { elementKinds: ['waste', 'vent', 'storm', 'trench-drain', 'dcw', 'dhw', 'hwr', 'gas', 'duct', 'duct-fitting'] },
      rationale: 'The zone above the equipment footprint to 1.80 m is dedicated to electrical equipment: no duct, no pipe, no drain.',
    }),
    byConstruction({
      id: 'ELE-13.dripProtection', title: 'Sprinkler over switchgear needs drip protection', discipline: 'electrical', patternId: 'ELE-13',
      subject: 'element',
      params: { limit: p(true, undefined, cite('NEC 2023', '110.26(E)(1)(c)')) },
      severity: 'info', resolution: 'none',
      rationale: 'Sprinkler protection IS permitted in the dedicated space where drip protection is provided — so it is an info issue that records the requirement, not a violation.',
    }),
    byConstruction({
      id: 'ELE-13.panelLocation', title: 'A panelboard is not in a bathroom or a closet', discipline: 'electrical', patternId: 'ELE-13',
      subject: 'element',
      params: { limit: p(true, undefined, cite('NEC 2023', '240.24(D) and (E)')) },
      severity: 'violation', resolution: 'reroute-in-wall',
      rationale: 'Overcurrent devices may not be in bathrooms, clothes closets or over steps of a stairway.',
    }),
    constraint({
      id: 'ELE-12.trayEmc', title: 'Power and data trays keep their separation', discipline: 'electrical', patternId: 'ELE-12',
      subject: 'element', predicate: { id: 'clearance', args: ['tray-data'] },
      params: { limit: p(0.15, 'm', `${cite('BS 7671:2018+A2:2022', '§528.1')}; ${cite('EN 50174-2:2018', 'Table 8')}`), op: OP_GE },
      severity: 'violation', resolution: 'shift-lateral',
      scope: { elementKinds: ['tray-power', 'busduct'] },
      rationale: 'v1 put the two tray centres 0.15 m apart while the trays were 0.30 m and 0.20 m wide; the lane table now separates them vertically instead.',
    }),

    // --- plumbing: potable protection, gravity, reachability -----------------------------------------------------
    constraint({
      id: 'PLB-C1.potableOverDrain', title: 'Potable water crosses above drainage', discipline: 'plumbing', patternId: 'PLB-01',
      subject: 'element', predicate: { id: 'notOver', args: ['dcw'] },
      params: { limit: p(0.05, 'm', cite('IPC 2021', '§603.2')) },
      severity: 'violation', resolution: 'shift-lateral',
      scope: { elementKinds: ['waste', 'vent', 'storm'] },
      rationale: 'A drain over a potable main is a contamination path; the band order puts pressure above gravity so it cannot happen.',
    }),
    constraint({
      id: 'PLB-S1.slopeMonotonic', title: 'A gravity run falls in the direction of flow', discipline: 'plumbing', patternId: 'XD-11',
      subject: 'run', predicate: { id: 'slope', args: [] },
      params: { limit: p(SLOPES.sanitary[1].slope, 'm/m', SLOPES.sanitary[1].source), op: OP_GE },
      severity: 'violation', resolution: 'oversize-pipe',
      rationale: 'Gravity First: a drain has one invert and one direction; a run that rises anywhere in its length does not drain.',
    }),
    constraint({
      id: 'PLB-S1.slopeMin', title: 'A gravity run falls at least the code minimum', discipline: 'plumbing', patternId: 'XD-11',
      subject: 'run', predicate: { id: 'slope', args: [] },
      params: { limit: p(SLOPES.sanitary[1].slope, 'm/m', SLOPES.sanitary[1].source), op: OP_GE },
      severity: 'violation', resolution: 'oversize-pipe',
      rationale: 'Too flat and solids are left behind; the minimum depends on the diameter (and is 1:80 in the UK and Ireland).',
    }),
    constraint({
      id: 'PLB-S1.slopeMax', title: 'A gravity run is not steeper than 1:12', discipline: 'plumbing', patternId: 'XD-11',
      subject: 'run', predicate: { id: 'slope', args: [] },
      params: { limit: p(SLOPES.maxGravity.slope, 'm/m', SLOPES.maxGravity.source), op: OP_LE },
      severity: 'deviation', resolution: 'none',
      rationale: 'Steeper than 1:12 the water outruns the solids; model it as a vertical leg instead.',
    }),
    constraint({
      id: 'PLB-S2.fixtureReachesStack', title: 'Every fixture reaches a stack', discipline: 'plumbing', patternId: 'XD-11',
      subject: 'run', predicate: { id: 'reaches', args: ['waste'] },
      params: { limit: p(0.5, 'm', cite('IPC 2021', '§710')), op: OP_LE },
      severity: 'violation', resolution: 'vent-branch',
      rationale: 'A branch that connects to nothing is the commonest silent modelling failure; union-find over the run endpoints catches it.',
    }),
    constraint({
      id: 'PLB-S3.stackReachesDrain', title: 'Every stack reaches the building drain or a sump', discipline: 'plumbing', patternId: 'XD-11',
      subject: 'run', predicate: { id: 'reaches', args: ['waste'] },
      params: { limit: p(0.5, 'm', cite('IPC 2021', '§710.1')), op: OP_LE },
      severity: 'violation', resolution: 'add-sump',
      rationale: 'The stack has to arrive somewhere: the gravity drain, or a sump if it is below the gravity horizon.',
    }),
    constraint({
      id: 'PLB-S4.sumpDischarge', title: 'Every sump discharges to gravity', discipline: 'plumbing', patternId: 'XD-11',
      subject: 'run', predicate: { id: 'reaches', args: ['sump'] },
      params: { limit: p(0.5, 'm', `${cite('IPC 2021', '§712.1')}; ${cite('IPC 2021', '§712.4.2')}`), op: OP_LE },
      severity: 'violation', resolution: 'add-sump',
      rationale: 'A duplex ejector pumps up to the lowest gravity drain; a sump with no discharge is a flood.',
    }),
    constraint({
      id: 'PLB-C7.pumpedToGravity', title: 'A pumped level terminates above the sewer invert', discipline: 'plumbing', patternId: 'XD-11',
      subject: 'run', predicate: { id: 'reaches', args: ['waste'] },
      params: { limit: p(1.0, 'm', cite('IPC 2021', '§712.3')), op: OP_LE },
      severity: 'violation', resolution: 'add-sump',
      rationale: 'The invert model decides which levels are pumped; this proves the discharge actually rejoins gravity.',
    }),
    byConstruction({
      id: 'XD-11.gravityFirst', title: 'Gravity is routed before anything else', discipline: 'plumbing', patternId: 'XD-11',
      subject: 'element',
      params: { limit: p(true, undefined, cite('IPC 2021', 'Table 704.1')) },
      severity: 'violation', resolution: 'shift-along-lane',
      rationale: 'Drains get their band and their stations first, because they are the only service with one possible geometry.',
    }),

    // --- retail demise / tenant plenum ---------------------------------------------------------------------------
    constraint({
      id: 'XD-09.demiseCap', title: 'A landlord service is capped at the demise', discipline: 'xd', patternId: 'XD-09',
      subject: 'run', predicate: { id: 'cappedAtDemise', args: [] },
      params: { limit: p(1.0, 'm', cite('default', '(shell-and-core lease standard)')), op: OP_LE },
      severity: 'violation', resolution: 'none',
      scope: { floorUse: ['retail'] },
      rationale: 'A base-build run that crosses a tenancy line is cut on the first fit-out, so it must terminate capped, valved and metered before it.',
    }),
    byConstruction({
      id: 'XD-09.tenantPlenum', title: 'The tenant plenum stays empty', discipline: 'xd', patternId: 'XD-09',
      subject: 'element',
      params: { limit: p(true, undefined, cite('default', '(shell-and-core lease standard)')) },
      severity: 'violation', resolution: 'compress-band',
      scope: { floorUse: ['retail'] },
      rationale: 'The deep plenum is a reservation of emptiness; a landlord service inside it is a service that will be removed.',
    }),

    // --- plant rooms --------------------------------------------------------------------------------------------
    byConstruction({
      id: 'XD-10.plantFloorDrain', title: 'A plant room has a floor drain', discipline: 'plumbing', patternId: 'XD-10',
      subject: 'room',
      params: { limit: p(1, 'count', cite('IPC 2021', '§1101')), op: OP_GE },
      severity: 'violation', resolution: 'none',
      scope: { roomType: ['mech-room', 'water-room', 'plant'] },
      rationale: 'Plant leaks and plant rooms are washed down; one drain per 40 m², capped at six.',
    }),
    constraint({
      id: 'XD-10.plantHeadroom', title: 'A plant room keeps 2.10 m of access headroom', discipline: 'mechanical', patternId: 'XD-10',
      subject: 'room', predicate: { id: 'clearHeight', args: [] },
      params: { limit: p(CLEAR_HEIGHTS['mep-room'].min, 'm', CLEAR_HEIGHTS['mep-room'].source), op: OP_GE },
      severity: 'violation', resolution: 'raise-floor-to-floor',
      scope: { roomType: ['mech-room', 'elec-room', 'water-room', 'plant'] },
      rationale: 'Everything overhead is tight to the soffit precisely so the floor and the access height stay usable.',
    }),

    // --- dwelling quality (the rules the program solver has to satisfy) -------------------------------------------
    byConstruction({
      id: 'XD-07.flatSoffit', title: 'A dwelling room has a flat soffit', discipline: 'architecture', patternId: 'XD-07',
      subject: 'element',
      params: { limit: p(true, undefined, cite('default', '(XD-07 Flat Soffit Dwelling)')) },
      severity: 'violation', resolution: 'reroute-in-wall',
      scope: { floorUse: ['residential'] },
      rationale: 'Services in a dwelling are in the wet wall, the hall bulkhead or the service band — never over a living room.',
    }),
    constraint({
      id: 'ARC-C1.roomMinWidth', title: 'A habitable room is wide enough', discipline: 'architecture', patternId: 'ARC-09',
      subject: 'room', predicate: { id: 'minDim', args: [] },
      params: { limit: p(2.4, 'm', `${cite('London Housing SPG 2016', '§3.3.3 (single bedroom 2.15 m, double 2.75 m)')}; ${cite('Neufert 5th ed.', 'residential minima')}`), op: OP_GE },
      severity: 'violation', resolution: 'swap-module',
      scope: { roomType: ['living', 'dining', 'living-kitchen', 'bedroom', 'master-bedroom'] },
      rationale: 'A room narrower than this cannot take its furniture; the feasibility check in the module catalogue exists so it cannot happen.',
    }),
    constraint({
      id: 'ARC-C2.bedroomDaylight', title: 'A bedroom has daylight', discipline: 'architecture', patternId: 'ARC-08',
      subject: 'room', predicate: { id: 'daylight', args: [] },
      params: { limit: p(1, 'window', cite('IBC 2021', '§1204.2 (natural light 8 % of floor area)')), op: OP_GE },
      severity: 'violation', resolution: 'swap-module',
      scope: { roomType: ['bedroom', 'master-bedroom', 'living', 'dining', 'living-kitchen', 'study'] },
      rationale: 'A habitable room without a window is not a habitable room; it is the failure v1 reported 20 times per preset.',
    }),
    constraint({
      id: 'ARC-C3.bathroomNotThrough', title: 'A bathroom is not the route to another room', discipline: 'architecture', patternId: 'ARC-10',
      subject: 'room', predicate: { id: 'notThrough', args: ['entry', 'bedroom'] },
      params: { limit: p(true, undefined, cite('Alexander APL', '#141 A Room of One’s Own')) },
      severity: 'violation', resolution: 'swap-module',
      scope: { roomType: ['bathroom', 'ensuite'] },
      rationale: 'Privacy gradient: one should never pass through a bathroom to reach a bedroom.',
    }),
    constraint({
      id: 'ARC-C4.doorSwingClear', title: 'A door leaf has somewhere to go', discipline: 'architecture', patternId: 'ARC-11',
      subject: 'door', predicate: { id: 'swingClear', args: [] },
      params: { limit: p(0.05, 'm', cite('ADM 2015', '§3 (effective clear width)')), op: OP_LE },
      severity: 'violation', resolution: 'swap-module',
      rationale: 'The swing is solved once by the producer and stored; this proves the room it swings into can hold it.',
    }),
    constraint({
      id: 'ARC-C5.corridorLeg', title: 'A corridor leg is not longer than the pattern allows', discipline: 'architecture', patternId: 'ARC-03',
      subject: 'corridor', predicate: { id: 'maxRun', args: [] },
      params: { limit: p(45, 'm', cite('default', '(ARC-03: daylight or a break at both ends)')), op: OP_LE },
      severity: 'violation', resolution: 'split-corridor',
      rationale: 'v1 carried this number in the pattern and never read it, then warned when the corridor was 71.7 m long.',
    }),
    constraint({
      id: 'ARC-C6.corridorDeadEnd', title: 'A corridor has no long dead end', discipline: 'architecture', patternId: 'SIT-08',
      subject: 'corridor', predicate: { id: 'deadEnd', args: [] },
      params: { limit: p(6.0, 'm', cite('IBC 2021', '§1020.4')), op: OP_LE },
      severity: 'violation', resolution: 'add-core',
      rationale: 'A dead end longer than this needs an exit at its end.',
    }),
    constraint({
      id: 'ARC-33.egressTravel', title: 'A dwelling is within the travel limit of an exit', discipline: 'architecture', patternId: 'ARC-33',
      subject: 'unit', predicate: { id: 'egressTravel', args: [] },
      params: { limit: p(61.0, 'm', cite('IBC 2021', 'Table 1017.2 (Group R, 200 ft)')), op: OP_LE },
      severity: 'deviation', resolution: 'add-core',
      rationale: 'The single owner of the travel limit: architecture reads it with `rules.num(\'ARC-33.egressTravel\')` and the post-check enforces the same number. Sprinklered buildings get 76 m — the `sprinklered` rule profile raises it.',
    }),

    // --- structure ----------------------------------------------------------------------------------------------
    constraint({
      id: 'STR-C1.columnContinuity', title: 'A column lands on something', discipline: 'structure', patternId: 'STR-04',
      subject: 'support', predicate: { id: 'loadPath', args: [] },
      params: { limit: p(0.15, 'm', cite('ACI 318-19', '§10.2 (eccentricity of a column on a column)')), op: OP_LE, tolerance: p(0.15, 'm', cite('ACI 318-19', '§10.2')) },
      severity: 'violation',
      rationale: 'Column on column, wall on wall, or a transfer beam whose BOTH ends land on supports — otherwise the load has nowhere to go.',
    }),
    constraint({
      id: 'STR-C2.foundationUnderSupport', title: 'A foundation under every lowest support', discipline: 'structure', patternId: 'STR-06',
      subject: 'support', predicate: { id: 'loadPath', args: [] },
      params: { limit: p(0.15, 'm', cite('ACI 318-19', '§13.2')), op: OP_LE },
      severity: 'violation',
      rationale: 'v1 took footings from the lowest storey’s columns only, so a wall or a transfer column could land on soil.',
    }),
    constraint({
      id: 'STR-C3.coreContinuity', title: 'A core is continuous to the foundation', discipline: 'structure', patternId: 'STR-05',
      subject: 'support', predicate: { id: 'loadPath', args: [] },
      params: { limit: p(0.15, 'm', cite('ACI 318-19', '§18.10 (special structural walls)')), op: OP_LE },
      severity: 'violation',
      rationale: 'A shear wall that stops at the podium is not a shear wall.',
    }),
    byConstruction({
      id: 'STR-C4.slabEdgeSupport', title: 'A slab edge is supported', discipline: 'structure', patternId: 'STR-09',
      subject: 'element',
      params: { limit: p(2.0, 'm', cite('ACI 318-19', 'Table 9.3.1.1 (cantilever ℓ/10)')), op: OP_LE },
      severity: 'violation',
      rationale: 'Every point of a slab outline is within min(2.0, 10 × slabT) of a rim beam, a bearing wall or a column line.',
    }),
    byConstruction({
      id: 'STR-C5.balconyCantilever', title: 'A balcony has the backspan it needs', discipline: 'structure', patternId: 'STR-10',
      subject: 'element',
      params: { limit: p(0.5, 'L / B', `${cite('ACI 318-19', 'Table 9.3.1.1')}; ${cite('Eurocode 2', '§7.4.2')}`), op: OP_LE },
      severity: 'violation',
      rationale: 'A cantilever needs a backspan of at least twice its projection and a thickness of at least L/10.',
    }),
    byConstruction({
      id: 'STR-C6.mepUnderSlab', title: 'Services stay below the structural soffit', discipline: 'structure', patternId: 'STR-09',
      subject: 'element',
      params: { limit: p(true, undefined, cite('presize', '(corridorSoffitZ)')) },
      severity: 'violation', resolution: 'compress-band',
      rationale: 'The structure band is claimed first and nothing else may enter it — the one rule that makes the rest of the coordination possible.',
    }),

    // --- mechanical ---------------------------------------------------------------------------------------------
    byConstruction({
      id: 'MEC-C1.ductInLane', title: 'A corridor duct runs in the duct lane', discipline: 'mechanical', patternId: 'XD-02',
      subject: 'element',
      params: { limit: p(true, undefined, cite('SMACNA 3rd ed.', 'Chapter 2')) },
      severity: 'violation', resolution: 'shift-lateral',
      scope: { elementKinds: ['duct', 'duct-fitting'] },
      rationale: 'The duct is the biggest section, so it takes the centre of the corridor and everything else fits beside it.',
    }),
    byConstruction({
      id: 'MEC-C2.parkingExhaust', title: 'Car park exhaust runs over the aisle', discipline: 'mechanical', patternId: 'XD-08',
      subject: 'element',
      params: { limit: p(true, undefined, cite('IMC 2021', '§404.2')) },
      severity: 'violation', resolution: 'shift-lateral',
      scope: { floorUse: ['parking'], elementKinds: ['duct', 'duct-fitting'] },
      rationale: 'A stall is 5.4 m deep and never walked under; the aisle is where the clear height is measured, so the duct goes there and is coordinated against it.',
    }),
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// The built-in rule set and the named profiles
// ---------------------------------------------------------------------------------------------------------------


// ---------------------------------------------------------------------------------------------------------------
// Issue labels: rule ids a discipline reports against where the limit lives in the spec or the typology
// ---------------------------------------------------------------------------------------------------------------

function label(o: { id: string; title: string; discipline: Rule['discipline']; patternId?: string; subject: Rule['subject']; severity: Rule['severity']; resolution?: Rule['resolution']; params?: Record<string, RuleParam>; rationale: string }): Rule {
  return {
    id: o.id, title: o.title, discipline: o.discipline, patternId: o.patternId, kind: 'constraint',
    scope: {}, params: o.params ?? {}, severity: o.severity, resolution: o.resolution, rationale: o.rationale,
    subject: o.subject,
  };
}

/**
 * Ids that exist so an issue can cite them, where the limit itself comes from the spec (a zoning cap), the typology
 * (the storey band) or the solver's own arithmetic (how many parking levels fitted). They carry no predicate: the
 * generator that owns the decision reports the issue, and this record gives the Rules tab something to link to.
 */
export function labelRules(): Rule[] {
  return [
    label({
      id: 'TYP-01.storeyBand', title: 'Storeys stay inside the typology band', discipline: 'site', subject: 'building',
      severity: 'deviation', resolution: 'switch-highrise-ruleset',
      rationale: 'The band is `typology.storeys.{min,max}`; `normalizeSpec` clamps to it unless the user asks for an explicit override, which is recorded as a deviation and switches on the high-rise rule profile.',
    }),
    label({
      id: 'SIT-00.geometry', title: 'The site geometry is usable', discipline: 'site', patternId: 'SIT-01', subject: 'building',
      severity: 'violation', resolution: 'clamp',
      rationale: 'A degenerate boundary, a zero buildable envelope or a footprint that cannot hold one dwelling: the site itself is the contradiction, so it is reported before anything is placed.',
    }),
    label({
      id: 'SIT-01.maxHeight', title: 'Height stays under the zoning cap', discipline: 'site', patternId: 'SIT-01', subject: 'building',
      severity: 'deviation', resolution: 'clamp',
      rationale: 'The cap is `spec.site.maxHeight`; exceeding it is a planning matter, reported as a deviation with the achieved height.',
    }),
    label({
      id: 'SIT-01.maxFar', title: 'Floor area ratio stays under the zoning cap', discipline: 'site', patternId: 'SIT-01', subject: 'building',
      severity: 'deviation', resolution: 'clamp',
      rationale: 'The cap is `spec.site.maxFar`.',
    }),
    label({
      id: 'SIT-01.maxCoverage', title: 'Site coverage stays under the zoning cap', discipline: 'site', patternId: 'SIT-01', subject: 'building',
      severity: 'deviation', resolution: 'clamp',
      rationale: 'The cap is `spec.site.maxCoverage`.',
    }),
    label({
      id: 'SIT-02.buildingSize', title: 'The building fits the buildable envelope', discipline: 'site', patternId: 'SIT-02', subject: 'building',
      severity: 'info', resolution: 'clamp',
      rationale: 'Requested depth or length clipped to the envelope: a recorded clamp, not a warning.',
    }),
    label({
      id: 'SIT-02.dwellingsPerFloor', title: 'Dwellings per floor stay in the typology band', discipline: 'site', patternId: 'SIT-02', subject: 'floor',
      severity: 'info', resolution: 'clamp',
      rationale: 'A bar that yields fewer or more dwellings per floor than the typology expects is a massing consequence, recorded so the mix can be read against it.',
    }),
    label({
      id: 'SIT-07.parkingLevels', title: 'Parking levels added to meet the ratio', discipline: 'site', patternId: 'SIT-07', subject: 'building',
      severity: 'info', resolution: 'add-basement-level',
      rationale: 'The solver adds basement then podium levels before it relaxes the ratio; each addition is recorded.',
    }),
    label({
      id: 'SIT-07.parkingRatio', title: 'The parking ratio was relaxed', discipline: 'site', patternId: 'SIT-07', subject: 'building',
      severity: 'deviation', resolution: 'relax-parking-ratio',
      rationale: 'When no permitted level count reaches the required stall count, the achieved ratio is recorded as an explicit deviation instead of a warning.',
    }),
    label({
      id: 'SIT-07.parkingType', title: 'The parking type had to change', discipline: 'site', patternId: 'SIT-07', subject: 'building',
      severity: 'info', resolution: 'none',
      rationale: 'Structured parking requested with no parking storey falls back to surface parking, recorded.',
    }),
    label({
      id: 'SIT-07.parkingFit', title: 'Stalls fit the zone they were packed into', discipline: 'site', patternId: 'SIT-07', subject: 'building',
      severity: 'info', resolution: 'none',
      rationale: 'The single capacity function (`stallCapacity`) and the packer must agree; a difference is reported rather than silently packed short.',
    }),
    label({
      id: 'SIT-08.coreFit', title: 'A core fits where it is needed', discipline: 'site', patternId: 'SIT-08', subject: 'building',
      severity: 'info', resolution: 'add-core',
      rationale: 'A core is placed in a corridor break slot when one is available, so it costs no corridor length; otherwise its position is recorded.',
    }),
    label({
      id: 'SIT-08.coreCount', title: 'The core count follows the egress rules', discipline: 'site', patternId: 'SIT-08', subject: 'building',
      severity: 'info', resolution: 'add-core',
      rationale: 'Single-exit limits (IBC \u00a71006.3.3) and travel distance decide the count; a change from the requested count is recorded.',
    }),
    label({
      id: 'XD-02.bandDepth', title: 'A band was compressed to hold the clear height', discipline: 'xd', patternId: 'XD-06',
      subject: 'floor', severity: 'info', resolution: 'compress-band',
      rationale: 'The id `stackProfile` cites when it squeezes the most flexible band to its minimum: a recorded resolution, not a problem.',
    }),
    label({
      id: 'XD-02.transferZone', title: 'The transfer zone is a local obstruction', discipline: 'structure', patternId: 'STR-04',
      subject: 'floor', severity: 'info', resolution: 'lower-ceiling',
      rationale: 'Under a transfer beam the ceiling steps down in a bulkhead and services route between the beams; pulling the whole storey\u2019s plenum down instead would ask for a taller podium where only one strip is affected.',
    }),
    label({
      id: 'XD-02.bandDropped', title: 'A band was dropped to hold the clear height', discipline: 'xd', patternId: 'XD-06',
      subject: 'floor', severity: 'info', resolution: 'drop-band',
      rationale: 'Dropping a droppable band (jet fans where a ducted extract fits, an EV tray in a low car park) is the designed alternative to a taller storey.',
    }),
    label({
      id: 'XD-04.shaftOverflow', title: 'A riser moved to the next shaft with room', discipline: 'xd', patternId: 'XD-04',
      subject: 'element', severity: 'info', resolution: 'enlarge-shaft',
      rationale: 'The allocator moves a riser to the nearest shaft that can hold it rather than stacking two risers in the same corner, and records where it went.',
    }),
    label({
      id: 'XD-00.presizePending', title: 'Structural pre-sizing was unavailable', discipline: 'structure',
      subject: 'building', severity: 'info', resolution: 'none',
      rationale: 'Migration only: while `presizeStructure` is not implemented the disciplines fall back to their v1 constants and the coordination kernel is not built. Removed when the pre-sizing is required.',
    }),
    label({
      id: 'XD-00.unknownPattern', title: 'A pattern application references an unknown pattern', discipline: 'xd',
      subject: 'building', severity: 'error', resolution: 'none',
      rationale: 'A discipline recorded a pattern application whose pattern nobody registered: the pattern trace would lie about what the generator did.',
    }),
    label({
      id: 'XD-00.uniqueElementId', title: 'Element ids are unique', discipline: 'xd',
      subject: 'element', severity: 'violation', resolution: 'none',
      rationale: 'Ids are the contract between the model, the IFC writer and the editor; a duplicate is always a bug in an id factory.',
    }),
    {
      id: 'ARC-15.lavatoryFront', title: 'Bathroom kit \u2014 clear space in front of a lavatory', discipline: 'architecture',
      patternId: 'ARC-15', kind: 'param', scope: {},
      params: { value: p(0.7, 'm', `${cite('IPC 2021', '\u00a7405.3.1 (21 in = 0.53 m minimum)')}; ${cite('default', '0.70 m for comfortable use')}`) },
      severity: 'info',
      rationale: 'The code minimum is 0.53 m; the kit uses 0.70 m so a person can stand at the basin without touching the door leaf.',
    },
  ];
}

export function builtinRules(): Rule[] {
  const out = [...profileParamRules(), ...tableRules(), ...tunableRules(), ...constraintRules(), ...labelRules()];
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

/** Ids the kernel and the support checks attach to issues; `rules.test.ts` asserts every one exists. */
export const KERNEL_RULE_IDS: readonly string[] = [
  'XD-00.presizePending', 'XD-00.unknownPattern', 'XD-00.uniqueElementId',
  'XD-02.bandDepth', 'XD-02.bandDropped', 'XD-02.plenumDepth', 'XD-02.bandExists', 'XD-02.bandAllows',
  'XD-02.inBand', 'XD-02.laneWidth', 'XD-02.crossingPitch', 'XD-02.transferZone',
  'XD-04.shaftExists', 'XD-04.shaftArea', 'XD-04.shaftOverflow', 'XD-04.hoistway',
  'XD-01.wetWall',
  'XD-S0.inReservation', 'XD-S1.hangerDrop', 'XD-S2.riserContinuity', 'XD-S2.riserHoused', 'XD-S5.noPenetration',
  'PLB-S1.slopeMonotonic', 'PLB-S1.slopeMin', 'PLB-S1.slopeMax',
  'PLB-S2.fixtureReachesStack', 'PLB-S3.stackReachesDrain', 'PLB-S4.sumpDischarge',
  'ELE-13.dedicatedSpace', 'ELE-13.dripProtection',
  'XD-00.issueCapPerRule',
];

function paramOverride(id: string, title: string, discipline: Rule['discipline'], params: Record<string, RuleParam>, rationale: string, patternId?: string): Rule {
  return { id, title, discipline, patternId, kind: 'param', scope: {}, params, severity: 'info', rationale };
}

/**
 * Named rule profiles, layered on top of the built-ins in the order they are applied.
 * `high-rise` and `sprinklered` are switched on by the building; `uk` / `us` by the region.
 */
export const RULE_PROFILES: Readonly<Record<string, readonly Rule[]>> = {
  'high-rise': [
    paramOverride('XD-04.shaftAreaPerUnitServed', 'Shafts at the Core — shaft area per unit served (high-rise)', 'xd', {
      value: p(0.16, 'm²/unit', cite('default', '(high-rise: more risers, pressure zones, standpipes)')),
    }, 'Above the high-rise threshold the riser count grows: pressure zones, a standpipe per stair, stair pressurisation.', 'XD-04'),
    paramOverride('PLB-07.boosterStoreyThreshold', 'Water service — storeys per pressure zone (high-rise)', 'plumbing', {
      value: p(6, 'storeys', cite('IPC 2021', '§604.8 (max 552 kPa at a fixture)')),
    }, 'A single zone taller than about six storeys either starves the top or over-pressures the bottom.', 'PLB-07'),
    paramOverride('STR-05.coreWallT', 'Core wall thickness (high-rise)', 'structure', {
      value: p(0.3, 'm', cite('ACI 318-19', '§18.10.2 (special structural wall)')),
    }, 'The core carries the lateral load; above the high-rise threshold 0.25 m is not enough, which is exactly the deviation v1 reported as a warning.', 'STR-05'),
    {
      id: 'XD-06.standpipePerCore', title: 'A standpipe in every stair (high-rise)', discipline: 'plumbing', patternId: 'XD-04',
      kind: 'constraint', scope: {}, subject: 'building',
      predicate: { id: 'count', args: ['standpipe'] },
      params: { limit: p(1, 'per stair', cite('NFPA 14 2019', '§7.3')), op: OP_GE },
      severity: 'violation', rationale: 'Class I standpipes in every exit stair are what makes a high-rise fightable.',
    },
  ],
  'sprinklered': [
    paramOverride('SIT-08.deadEnd', 'Egress — maximum dead-end corridor (sprinklered)', 'site', {
      value: p(15.0, 'm', cite('IBC 2021', '§1020.4 exception 2')),
      sprinklered: p(15.0, 'm', cite('IBC 2021', '§1020.4 exception 2')),
    }, 'A sprinklered R-2 building may have a 15.2 m dead end instead of 6.1 m.', 'SIT-08'),
    {
      id: 'ARC-33.egressTravel', title: 'A dwelling is within the travel limit of an exit (sprinklered)', discipline: 'architecture', patternId: 'ARC-33',
      kind: 'constraint', scope: {}, subject: 'unit',
      predicate: { id: 'egressTravel', args: [] },
      params: { limit: p(76.0, 'm', cite('IBC 2021', 'Table 1017.2 (Group R, sprinklered, 250 ft)')), op: OP_LE },
      severity: 'violation', resolution: 'add-core',
      rationale: 'Sprinklers buy 250 ft of travel instead of 200 ft.',
    },
  ],
  'uk': [
    paramOverride('PLB-01.slopeSanitary', 'Sanitary drainage — minimum fall (UK / Ireland)', 'plumbing', {
      '0.075': p(1 / 40, 'm/m', cite('BS EN 12056-2:2000', '§6.3')),
      '1': p(1 / 80, 'm/m', cite('ADH 2015', 'Table 10')),
    }, 'BS EN 12056-2 and Approved Document H work to 1:80 on a Ø100 foul drain, not the IPC 1:100.', 'PLB-01'),
    paramOverride('PLB-02.trapArm', 'Branch pipe — maximum length (UK / Ireland)', 'plumbing', {
      '0.032': p(1.7, 'm', cite('ADH 2015', 'Table 8 (Ø32 washbasin branch)')),
      '0.04': p(3.0, 'm', cite('ADH 2015', 'Table 8 (Ø40 bath / shower branch)')),
      '0.05': p(4.0, 'm', cite('BS EN 12056-2:2000', 'Table 3')),
      '0.1': p(6.0, 'm', cite('ADH 2015', 'Table 8 (WC branch)')),
    }, 'The UK/Ireland branch-pipe limits are longer than the IPC trap arms and are expressed per appliance type.', 'PLB-02'),
    paramOverride('XD-06.clearHeight.resi-unit', 'Dwelling clear height (UK / Ireland)', 'xd', {
      min: p(2.3, 'm', cite('London Housing SPG 2016', '§3.3.6')),
      target: p(2.5, 'm', cite('London Housing SPG 2016', '§3.3.6 (2.5 m over at least 75 % of the area)')),
    }, 'The London Housing SPG asks for 2.5 m over three quarters of the dwelling, which is above the 2.3 m floor.', 'XD-06'),
    paramOverride('SIT-08.travelLimitUnsprinklered', 'Egress — travel limit (UK / Ireland)', 'site', {
      value: p(30.0, 'm', cite('ADB 2019', 'Table 3.1 (single direction of travel, flats)')),
    }, 'Approved Document B works in much shorter single-direction travel distances than the IBC.', 'SIT-08'),
  ],
  'us': [
    paramOverride('PLB-02.trapArm', 'Trap arm — maximum developed length (US)', 'plumbing',
      tableParams(TRAP_ARMS, 'm', TRAP_ARM_SOURCE),
      'The IPC Table 1002.2 values, pinned so a project override cannot silently reintroduce the v1 Ø50 error.', 'PLB-02'),
    paramOverride('SIT-08.travelLimitSprinklered', 'Egress — travel limit (US, sprinklered)', 'site', {
      value: p(76.0, 'm', cite('IBC 2021', 'Table 1017.2')),
    }, '250 ft in a sprinklered Group R.', 'SIT-08'),
  ],
};

export const RULE_PROFILE_NAMES: readonly string[] = ['high-rise', 'sprinklered', 'uk', 'us'];
