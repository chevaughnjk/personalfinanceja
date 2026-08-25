import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const swSource = readFileSync(join(ROOT, 'service-worker.js'), 'utf8');

let pass = 0,
  fail = 0;
const note = (c, l) => {
  if (c) pass++;
  else {
    fail++;
    console.log('   FAIL', l);
  }
};
console.log('='.repeat(72));
console.log(' SERVICE-WORKER PRECACHE COMPLETENESS - proof');
console.log('='.repeat(72));

function extractArray(varName) {
  const lines = swSource.split(/\r?\n/);
  const declaration = `const ${varName} = [`;
  const startIndex = lines.findIndex((line) => line.trim() === declaration);

  if (startIndex === -1) return [];

  const entries = [];

  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line === '];') break;

    // Match only an actual single-quoted array entry occupying the line.
    // Comments containing apostrophes are ignored by construction.
    const match = /^'([^']+)',?$/.exec(line);
    if (match) entries.push(match[1]);
  }

  return entries;
}

const CODE = extractArray('CODE');
const ASSETS = extractArray('ASSETS');
const PRECACHED = new Set([...CODE, ...ASSETS]);

note(CODE.length > 0, 'CODE array successfully parsed from service-worker.js');
note(ASSETS.length > 0, 'ASSETS array successfully parsed from service-worker.js');

const EXCLUDE_DIR_SEGMENTS = ['interface/archive', 'interface/icons'];
const EXCLUDE_FILE_REGEX = /_proof\.mjs$/;
const EXCLUDE_FILES_EXACT = new Set([
  'tests/cross_screen_consistency.mjs',
  'third-party/pdf.worker.min.txt',
  'third-party/README.md',
]);

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = relative(ROOT, full).split(sep).join('/');
    if (EXCLUDE_DIR_SEGMENTS.some((seg) => rel.startsWith(seg))) continue;
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(rel);
  }
}

const realFiles = [];
for (const root of ['application', 'interface', 'settings', 'third-party']) {
  walk(join(ROOT, root), realFiles);
}

const missing = realFiles.filter(
  (f) => !EXCLUDE_FILE_REGEX.test(f) && !EXCLUDE_FILES_EXACT.has(f) && !PRECACHED.has('./' + f)
);

note(
  missing.length === 0,
  `every real, non-excluded file is precached (${missing.length} missing: ${missing.join(', ')})`
);

note(PRECACHED.has('./interface/treemap.css'), 'treemap.css is precached');
note(PRECACHED.has('./interface/glass.css'), 'glass.css is precached');
note(PRECACHED.has('./application/ui/treemap-render.js'), 'treemap-render.js is precached');
note(PRECACHED.has('./application/core/icons.js'), 'core/icons.js is precached');
note(
  !PRECACHED.has('./application/shared-helpers.js'),
  'the OLD wrong path for shared-helpers.js is gone'
);
note(
  PRECACHED.has('./application/core/shared-helpers.js'),
  'the CORRECT path for shared-helpers.js is present'
);

console.log(`\n checks: ${pass} passed, ${fail} failed`);
console.log('='.repeat(72));
process.exit(fail ? 1 : 0);
