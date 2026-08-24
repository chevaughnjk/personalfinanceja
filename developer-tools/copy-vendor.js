/* Copies the pdf.js browser build into ./vendor, so the app loads pdf.js
 * locally on every platform (Electron, the web version, the installed PWA)
 * with no CDN dependency and no bundler step.
 *
 * Runs as the project's postinstall script; safe to run again at any time -
 * it always overwrites the two vendored files with whatever pdfjs-dist
 * version is currently installed.
 *
 * ES module: the project sets "type": "module" in package.json, so this
 * plain .js file is parsed as an ES module. import.meta.url + fileURLToPath
 * stand in for the CommonJS __dirname this script would otherwise use.
 */
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const vendorDir = path.join(projectRoot, 'third-party');

const FILES = ['pdf.min.mjs', 'pdf.worker.min.mjs'];

function main() {
  let pdfjsBuildDir;
  try {
    const pdfjsPkgPath = require.resolve('pdfjs-dist/package.json');
    pdfjsBuildDir = path.join(path.dirname(pdfjsPkgPath), 'build');
  } catch {
    console.error('[copy-vendor] Could not find pdfjs-dist. Run "npm install" first.');
    process.exitCode = 1;
    return;
  }

  if (!existsSync(vendorDir)) mkdirSync(vendorDir, { recursive: true });

  for (const file of FILES) {
    const src = path.join(pdfjsBuildDir, file);
    const dest = path.join(vendorDir, file);
    if (!existsSync(src)) {
      console.error(`[copy-vendor] Expected file not found: ${src}`);
      process.exitCode = 1;
      return;
    }
    copyFileSync(src, dest);
    console.log(`[copy-vendor] vendored ${file}`);
  }

  console.log('[copy-vendor] pdf.js is ready in ./third-party');
}

main();
