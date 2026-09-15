/**
 * Pattern book: the explicit pattern language. Each discipline registers its patterns
 * (Alexander-style problem/solution with parameters) and records where it applied them.
 *
 * Id prefixes: SIT (site), ARC (architecture), STR (structure), MEC (mechanical),
 * PLB (plumbing), ELE (electrical), XD (cross-discipline, owned by core).
 */
import type { Pattern, PatternApplication, Discipline } from './types.ts';

export class PatternBook {
  private patterns = new Map<string, Pattern>();
  private applications: PatternApplication[] = [];

  register(...patterns: Pattern[]): void {
    for (const p of patterns) {
      if (this.patterns.has(p.id) && this.patterns.get(p.id) !== p) {
        throw new Error(`Pattern id collision: ${p.id}`);
      }
      this.patterns.set(p.id, p);
    }
  }

  apply(app: PatternApplication): void {
    if (!this.patterns.has(app.patternId)) {
      throw new Error(`Pattern ${app.patternId} applied before registration`);
    }
    this.applications.push(app);
  }

  get(id: string): Pattern | undefined { return this.patterns.get(id); }
  all(): Pattern[] { return [...this.patterns.values()]; }
  byDiscipline(d: Discipline | 'cross'): Pattern[] { return this.all().filter(p => p.discipline === d); }
  trace(): PatternApplication[] { return [...this.applications]; }
  merge(apps: PatternApplication[]): void { for (const a of apps) this.apply(a); }
}

/** Cross-discipline patterns owned by core; disciplines reference these by id. */
export const CROSS_PATTERNS: Pattern[] = [
  {
    id: 'XD-01',
    name: 'Wet Wall Stacking',
    discipline: 'cross',
    problem: 'Kitchens and bathrooms scattered across a plan multiply risers, penetrations and cost, and make stacking of pipes impossible between floors.',
    solution: 'Every unit template backs its kitchen and bathrooms onto one shared wet wall. Units are stacked identically floor to floor so wet walls align vertically, and each wet wall hosts one plumbing stack. Mechanical exhaust and electrical panels share the same service zone.',
    parameters: {
      wetWallThickness: { value: 0.2, unit: 'm', source: 'default (2×6 / 150 mm stud + finishes)' },
      maxFixtureDistanceToStack: { value: 3.0, unit: 'm', source: 'trap-arm and branch-length limits (IPC Table 1002.2)' },
    },
    references: ['IPC 2021 §1002', 'BS EN 12056'],
  },
  {
    id: 'XD-02',
    name: 'Corridor Service Spine',
    discipline: 'cross',
    problem: 'Horizontal services crossing units cause coordination clashes and acoustic leaks between dwellings.',
    solution: 'All horizontal distribution runs in the corridor ceiling plenum in fixed lanes: ducts on the centreline at the top, wet pipes and sprinkler main in the lane toward the units on one side, cable trays in the lane on the other side. Branches enter units perpendicular to the corridor, above the unit entry door.',
    parameters: {
      plenumDepthMin: { value: 0.45, unit: 'm', source: 'default' },
      ductLaneOffset: { value: 0, unit: 'm (from corridor centreline)', source: 'default' },
      pipeLaneOffset: { value: -0.35, unit: 'm', source: 'default' },
      trayLaneOffset: { value: 0.35, unit: 'm', source: 'default' },
    },
    dependsOn: ['ARC-03'],
  },
  {
    id: 'XD-03',
    name: 'Structure Follows Party Walls',
    discipline: 'cross',
    problem: 'A structural grid that ignores the unit rhythm puts columns inside living rooms and forces transfer structure.',
    solution: 'Grid lines are placed on party walls and corridor walls; column spacing equals one or two unit frontages. Below a podium, the grid transfers to a parking module (2 × 2.6 m bays + column).',
    parameters: {
      maxSpan: { value: 9.0, unit: 'm', source: 'RC flat slab economic span' },
      parkingModule: { value: 8.4, unit: 'm', source: 'three 2.6–2.8 m bays' },
    },
    dependsOn: ['ARC-02'],
  },
  {
    id: 'XD-04',
    name: 'Shafts at the Core',
    discipline: 'cross',
    problem: 'Vertical risers scattered through a plan puncture every slab and steal usable area from units.',
    solution: 'Vertical mechanical, electrical and trash shafts sit adjacent to each stair/elevator core and open to the corridor. Plumbing stacks alone are permitted inside unit wet walls.',
    parameters: {
      shaftAreaPerUnitServed: { value: 0.12, unit: 'm²/unit', source: 'default' },
    },
    dependsOn: ['ARC-04'],
  },
  {
    id: 'XD-05',
    name: 'Design Occupancy Drives Systems',
    discipline: 'cross',
    problem: 'Systems sized on floor area alone ignore how many people actually live in a dwelling.',
    solution: 'Occupancy = bedrooms + 1 (bedspaces = 2 per double bedroom). Ventilation, DHW, electrical demand and fixture counts derive from occupancy, not area.',
    parameters: {
      occupantsPerBedroom: { value: 1, unit: 'person', source: 'ASHRAE 62.2 default (bedrooms + 1)' },
    },
  },
];
