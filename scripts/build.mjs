#!/usr/bin/env node
/**
 * Builds the single-file web app: dist/forma-resi-ifc.html
 *
 *   node scripts/build.mjs                # real generator (fails over to mock with a loud warning)
 *   node scripts/build.mjs --mock         # force the mock generator (UI development)
 *   node scripts/build.mjs --strict       # do not fail over; exit 1 if a discipline module is missing
 *   node scripts/build.mjs --watch        # rebuild on changes under src/
 *   node scripts/build.mjs --no-minify    # readable bundle for debugging
 *
 * Everything (JS + CSS) is inlined into one HTML file. No CDN, no external fonts.
 * The only network use at runtime is the optional embedded ifc-lite viewer iframe.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, watch } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP = join(ROOT, 'src', 'app');
const OUT_DIR = join(ROOT, 'dist');
const OUT_FILE = join(OUT_DIR, 'forma-resi-ifc.html');
const ESBUILD = process.env.ESBUILD_BIN
  || '/Users/samarvir/.npm/_npx/fd45a72a545557e9/node_modules/.bin/esbuild';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const FORCE_MOCK = has('--mock');
const STRICT = has('--strict');
const WATCH = has('--watch');
const MINIFY = !has('--no-minify');

/** Modules the real backend imports. If any is missing, the bundle cannot resolve. */
const REAL_DEPS = [
  'src/pipeline.ts',
  'src/core/metrics.ts',
  'src/ifc/writer.ts',
  'src/disciplines/architecture/templates.ts',
  'src/disciplines/site/index.ts',
  'src/disciplines/architecture/index.ts',
  'src/disciplines/structure/index.ts',
  'src/disciplines/mechanical/index.ts',
  'src/disciplines/plumbing/index.ts',
  'src/disciplines/electrical/index.ts',
];

function missingRealDeps() {
  return REAL_DEPS.filter((p) => !existsSync(join(ROOT, p)));
}

function bundle(mode) {
  const entry = join(APP, mode === 'mock' ? 'entry.mock.ts' : 'entry.real.ts');
  const args = [
    entry,
    '--bundle',
    '--format=iife',
    '--target=es2022',
    '--platform=browser',
    '--loader:.ts=ts',
    '--charset=utf8',
    '--legal-comments=none',
    '--log-level=warning',
    `--define:__BACKEND_MODE__=${JSON.stringify(JSON.stringify(mode))}`,
    `--define:__BUILD_ID__=${JSON.stringify(JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ')))}`,
  ];
  if (MINIFY) args.push('--minify');
  return execFileSync(ESBUILD, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function build() {
  const t0 = Date.now();
  let mode = FORCE_MOCK ? 'mock' : 'real';
  if (!FORCE_MOCK) {
    const missing = missingRealDeps();
    if (missing.length) {
      const list = missing.map((m) => `    - ${m}`).join('\n');
      if (STRICT) {
        console.error(`\n  The real generator is not bundleable yet — missing modules:\n${list}\n`);
        console.error('  Run with --mock to build the UI against src/app/mock-generate.ts.\n');
        process.exit(1);
      }
      console.warn(`\n  ! The real generator is not bundleable yet — missing modules:\n${list}`);
      console.warn('  ! Falling back to the MOCK generator (src/app/mock-generate.ts).');
      console.warn('  ! Pass --mock to silence this, or --strict to fail instead.\n');
      mode = 'mock';
    }
  }

  let js;
  try {
    js = bundle(mode);
  } catch (err) {
    const msg = String(err.stderr || err.stdout || err.message || err);
    console.error('\n  esbuild failed:\n');
    console.error(msg.trim().split('\n').map((l) => `    ${l}`).join('\n'));
    if (mode === 'real') {
      console.error('\n  If this is a missing/incompatible discipline module, build the UI with --mock.\n');
    }
    if (!WATCH) process.exit(1);
    return null;
  }

  const html = readFileSync(join(APP, 'index.html'), 'utf8');
  const css = readFileSync(join(APP, 'styles.css'), 'utf8');
  if (!html.includes('<!--APP_CSS-->') || !html.includes('<!--APP_JS-->')) {
    console.error('  src/app/index.html must contain the <!--APP_CSS--> and <!--APP_JS--> markers.');
    process.exit(1);
  }

  // `</script`, `<!--` and `-->` end the script element early, so neutralise them.
  const safeCss = css.split('</style').join('<\\/style');
  const safeJs = js
    .split('</script').join('<\\/script')
    .split('<!--').join('<\\!--')
    .split('-->').join('--\\>');
  // Replacer FUNCTIONS, not strings: minified JS contains `$&` / `$'` sequences that
  // String.replace would otherwise expand into the matched marker.
  const out = html
    .replace('<!--APP_CSS-->', () => safeCss)
    .replace('<!--APP_JS-->', () => safeJs)
    .replace('<!--APP_MODE-->', () => mode);

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, out, 'utf8');

  const kb = (n) => `${(n / 1024).toFixed(1)} kB`;
  console.log(
    `  built dist/forma-resi-ifc.html  ${kb(Buffer.byteLength(out))}` +
    `  (js ${kb(Buffer.byteLength(safeJs))}, css ${kb(Buffer.byteLength(safeCss))})` +
    `  backend=${mode}  ${Date.now() - t0} ms`
  );
  return out;
}

build();

if (WATCH) {
  const srcDir = join(ROOT, 'src');
  let timer = null;
  console.log('  watching src/ …');
  watch(srcDir, { recursive: true }, (_evt, file) => {
    if (file && !/\.(ts|css|html)$/.test(file)) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      try { build(); } catch (e) { console.error(String(e && e.message || e)); }
    }, 120);
  });
}
