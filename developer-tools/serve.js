/* Minimal static file server for the browser (PWA) version - no dependencies,
 * no build step. Serves the project root exactly as the installed PWA would
 * load it: index.html, interface/styles.css,
 * application/app.js, settings/config.json, interface/manifest.json,
 * interface/service-worker.js, interface/icons/ and third-party/ are all
 * reachable at their real relative paths.
 *
 * Once the server is genuinely listening, it opens the address in the
 * default browser automatically where practical (desktop OSes); if that
 * fails (headless environments, no desktop), the server keeps running
 * regardless - opening the browser is a convenience, never a requirement.
 *
 * ES module: the project sets "type": "module" in package.json, so this
 * plain .js file is parsed as an ES module. import.meta.url + fileURLToPath
 * stand in for the CommonJS __dirname this script would otherwise use.
 */
import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const root = projectRoot;
const port = Number(process.env.PORT) || 8000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

const server = http.createServer((req, res) => {
  let reqPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (reqPath === '/') reqPath = '/index.html';

  let resolved;
  if (reqPath.startsWith('/application/')) {
    const relative = reqPath.replace(/^\/application\//, '');
    resolved = path.normalize(path.join(projectRoot, 'application', relative));
  } else if (reqPath.startsWith('/settings/')) {
    const relative = reqPath.replace(/^\/settings\//, '');
    resolved = path.normalize(path.join(projectRoot, 'settings', relative));
  } else if (reqPath.startsWith('/third-party/')) {
    const relative = reqPath.replace(/^\/third-party\//, '');
    resolved = path.normalize(path.join(projectRoot, 'third-party', relative));
  } else {
    resolved = path.normalize(path.join(root, reqPath));
  }

  const allowedRoot = reqPath.startsWith('/application/') || reqPath.startsWith('/settings/') || reqPath.startsWith('/third-party/')
    ? projectRoot
    : root;

  if (!resolved.startsWith(allowedRoot)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  if (!existsSync(resolved) || statSync(resolved).isDirectory()) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const ext = path.extname(resolved).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  createReadStream(resolved).pipe(res);
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`[serve] Port ${port} is already in use. Close whatever is using it, or set PORT to another number.`);
  } else {
    console.error('[serve] Could not start the server:', err && err.message ? err.message : err);
  }
  process.exitCode = 1;
});

server.listen(port, '127.0.0.1', () => {
  const url = `http://localhost:${port}`;
  console.log(`Serving the app at ${url}`);
  console.log('Press Ctrl+C to stop.');
  openBrowser(url);
});

function openBrowser(url) {
  const cmd =
    process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"`
    : `xdg-open "${url}"`;
  // Best-effort only: if there is no desktop to open a browser on (a
  // container, a headless CI machine), the server keeps running regardless.
  exec(cmd, () => {});
}
