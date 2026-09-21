/**
 * Pinned code editions — the single place an edition string is written.
 *
 * Every `Rule` parameter and every clearance/hanger/slope table entry cites one of these keys plus a section, through
 * `cite(key, section)`. When an edition is superseded, it changes here and every citation follows; `rules.test.ts`
 * asserts that every built-in rule's `source` starts with a key of this record, so a typo cannot ship.
 */
export const SOURCES = {
  // Model codes (US / international)
  'IBC 2021': 'International Building Code, 2021 edition (International Code Council)',
  'IPC 2021': 'International Plumbing Code, 2021 edition (International Code Council)',
  'IMC 2021': 'International Mechanical Code, 2021 edition (International Code Council)',
  'IECC 2021': 'International Energy Conservation Code, 2021 edition (International Code Council)',
  'NEC 2023': 'NFPA 70, National Electrical Code, 2023 edition',
  'NFPA 13 2022': 'NFPA 13, Standard for the Installation of Sprinkler Systems, 2022 edition',
  'NFPA 14 2019': 'NFPA 14, Standard for the Installation of Standpipe and Hose Systems, 2019 edition',
  'NFPA 54 2021': 'NFPA 54, National Fuel Gas Code, 2021 edition',
  'NFPA 88A 2019': 'NFPA 88A, Standard for Parking Structures, 2019 edition',
  'ADA 2010': '2010 ADA Standards for Accessible Design (US Department of Justice)',
  'OSHA 1910': '29 CFR 1910, Occupational Safety and Health Standards (walking-working surfaces, subpart D)',
  'ACI 318-19': 'ACI 318-19, Building Code Requirements for Structural Concrete (American Concrete Institute)',
  'ASCE 7-22': 'ASCE/SEI 7-22, Minimum Design Loads and Associated Criteria for Buildings and Other Structures',
  'ASHRAE 62.1-2019': 'ANSI/ASHRAE Standard 62.1-2019, Ventilation for Acceptable Indoor Air Quality',
  'ASHRAE 62.2-2019': 'ANSI/ASHRAE Standard 62.2-2019, Ventilation and Acceptable Indoor Air Quality in Residential Buildings',
  'ASHRAE 90.1-2019': 'ANSI/ASHRAE/IES Standard 90.1-2019, Energy Standard for Buildings Except Low-Rise Residential',
  'ASHRAE Fundamentals 2021': 'ASHRAE Handbook — Fundamentals, 2021 edition',
  'SMACNA 3rd ed.': 'SMACNA HVAC Duct Construction Standards — Metal and Flexible, 3rd edition (2005)',
  'NEMA VE-2': 'NEMA VE 2-2013, Cable Tray Installation Guidelines',
  'ASME A17.1-2019': 'ASME A17.1/CSA B44-2019, Safety Code for Elevators and Escalators',

  // UK / Ireland
  'ADB 2019': 'Approved Document B (Fire safety), Volume 1: Dwellings, 2019 edition incl. 2020 and 2022 amendments',
  'ADE 2015': 'Approved Document E (Resistance to the passage of sound), 2015 edition',
  'ADH 2015': 'Approved Document H (Drainage and waste disposal), 2015 edition',
  'ADM 2015': 'Approved Document M (Access to and use of buildings), Volume 1, 2015 edition',
  'ADK 2013': 'Approved Document K (Protection from falling, collision and impact), 2013 edition',
  'BS 7671:2018+A2:2022': 'BS 7671:2018+A2:2022, Requirements for Electrical Installations (IET Wiring Regulations, 18th ed.)',
  'BS EN 12056-2:2000': 'BS EN 12056-2:2000, Gravity drainage systems inside buildings — sanitary pipework',
  'BS EN 752:2017': 'BS EN 752:2017, Drain and sewer systems outside buildings',
  'BS 6891:2015': 'BS 6891:2015+A1:2019, Installation of low-pressure gas pipework in domestic premises',
  'BS 7346-7:2013': 'BS 7346-7:2013, Components for smoke and heat control systems — car park ventilation',
  'BS 8300-2:2018': 'BS 8300-2:2018, Design of an accessible and inclusive built environment — buildings',
  'EN 50174-2:2018': 'BS EN 50174-2:2018, Information technology — cabling installation planning and practices inside buildings',
  'EN 13374:2013': 'BS EN 13374:2013+A1:2018, Temporary edge protection systems',
  'Eurocode 2': 'BS EN 1992-1-1:2004+A1:2014, Design of concrete structures — general rules and rules for buildings',
  'London Housing SPG 2016': 'Mayor of London, Housing Supplementary Planning Guidance, March 2016',
  'TGD B 2020': 'Technical Guidance Document B (Fire safety), Volume 2, 2020 (Ireland)',
  'Irish Apartment Guidelines 2023': 'Sustainable Urban Housing: Design Standards for New Apartments (Ireland), 2023',

  // Australia / New Zealand / Canada
  'NCC 2022': 'National Construction Code 2022, Volume One (Australia)',
  'AS 2890.1-2004': 'AS/NZS 2890.1:2004, Parking facilities — off-street car parking',
  'AS 2890.6-2022': 'AS/NZS 2890.6:2022, Parking facilities — off-street parking for people with disabilities',
  'NZBC 2023': 'New Zealand Building Code Handbook, 2023 amendment',
  'NBC 2020': 'National Building Code of Canada 2020',

  // Non-code references
  'Alexander APL': 'Alexander, Ishikawa, Silverstein — A Pattern Language (Oxford University Press, 1977)',
  'Neufert 5th ed.': 'Neufert Architects’ Data, 5th edition (Wiley-Blackwell, 2019)',
  'CIBSE Guide B 2016': 'CIBSE Guide B: Heating, ventilating, air conditioning and refrigeration (2016)',
  'CIBSE Guide G 2014': 'CIBSE Guide G: Public health and plumbing engineering (2014)',
  'presize': 'Structural pre-sizing (src/disciplines/structure/presize.ts) — derived, not a constant',
  'typology': 'Typology definition (src/core/typologies.ts)',
  'spec': 'User input (BuildingSpec)',
  'v1': 'forma-resi-ifc v1 behaviour, retained for byte-compatibility during the v2 migration',
  'default': 'Project default — no external source; a judgement call recorded so it can be challenged',
} as const;

export type SourceKey = keyof typeof SOURCES;

/** 'IPC 2021' + 'Table 1002.2' → 'IPC 2021 Table 1002.2'. Type-checked: an unpinned edition will not compile. */
export function cite(key: SourceKey, section?: string): string {
  return section ? `${key} ${section}` : key;
}

/** Every key, in declaration order — used by the tests and the Rules tab. */
export function sourceKeys(): SourceKey[] {
  return Object.keys(SOURCES) as SourceKey[];
}

/** True when `source` begins with a pinned edition key. */
export function isCited(source: string): boolean {
  for (const k of Object.keys(SOURCES)) if (source === k || source.startsWith(`${k} `)) return true;
  return false;
}
