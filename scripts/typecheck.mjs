// Type-check every TypeScript source with the sibling formaCAD compiler (npm is blocked; tsc is not vendored).
// Expands the globs here so an empty pattern (a directory that does not exist yet) is not a tsc error.
import { globSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const TSC = process.env.TSC_BIN || '/Users/samarvir/formaCAD/node_modules/.bin/tsc';
const TYPE_ROOTS = process.env.TSC_TYPE_ROOTS || '/Users/samarvir/formaCAD/node_modules/@types';
const patterns = [
  'src/core/*.ts', 'src/core/*/*.ts', 'src/modules/*.ts', 'src/disciplines/*/*.ts', 'src/disciplines/*/*/*.ts',
  'src/ifc/*.ts', 'src/ifc/vendor/ifc-lite-create/*.ts', 'src/cli/*.ts', 'src/pipeline.ts', 'src/*.ts',
  'src/app/*.ts', 'src/app/*/*.ts',
];
const files = [...new Set(patterns.flatMap(p => globSync(p)))].sort();
const flags = [
  '--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
  '--lib', 'ES2022,DOM', '--allowImportingTsExtensions', '--erasableSyntaxOnly', '--verbatimModuleSyntax',
  '--skipLibCheck', '--typeRoots', TYPE_ROOTS, '--types', 'node',
];
const r = spawnSync(TSC, [...flags, ...files], { stdio: 'inherit' });
if (r.error) { console.error(`cannot run tsc at ${TSC}: ${r.error.message}`); process.exit(2); }
process.exit(r.status ?? 1);
