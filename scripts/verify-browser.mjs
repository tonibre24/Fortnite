/**
 * Orchestrates the two-browser verification run.
 *
 * 1. Builds the shared package, the server and the client (pointing the client at the
 *    local server origin).
 * 2. Starts the built server.
 * 3. Serves `apps/client/dist` over a minimal static file server.
 * 4. Runs `tests/browser-smoke.mjs` against them and tears everything down.
 *
 * Run with: pnpm verify:browser
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const GAME_PORT = Number(process.env.RIFTFRONT_TEST_PORT ?? 2599);
const CLIENT_PORT = Number(process.env.RIFTFRONT_TEST_CLIENT_PORT ?? 4599);
const clientDist = join(repoRoot, 'apps', 'client', 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd: repoRoot, stdio: 'inherit', ...options });
    child.on('error', rejectPromise);
    child.on('exit', (code) =>
      code === 0 ? resolvePromise() : rejectPromise(new Error(`${command} exited with ${code}`)),
    );
  });
}

function startStaticServer() {
  const server = createServer((req, res) => {
    const requested = decodeURIComponent((req.url ?? '/').split('?')[0]);
    // Normalise and confine to the dist directory; no traversal outside it.
    const candidate = join(clientDist, normalize(requested).replace(/^(\.\.[/\\])+/, ''));
    const filePath =
      existsSync(candidate) && statSync(candidate).isFile()
        ? candidate
        : join(clientDist, 'index.html');

    if (!filePath.startsWith(clientDist) || !existsSync(filePath)) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    res.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' });
    createReadStream(filePath).pipe(res);
  });

  return new Promise((resolvePromise) => {
    server.listen(CLIENT_PORT, '127.0.0.1', () => resolvePromise(server));
  });
}

async function waitForHealth(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    await sleep(200);
  }
  throw new Error(`Server at ${url} never became healthy`);
}

async function main() {
  console.log('› building shared + server + client');
  await run('pnpm', ['--filter', '@riftfront/shared', 'build']);
  await run('pnpm', ['--filter', '@riftfront/server', 'build']);
  await run('pnpm', ['--filter', '@riftfront/client', 'build'], {
    env: { ...process.env, VITE_SERVER_URL: `http://127.0.0.1:${GAME_PORT}` },
  });

  console.log(`› starting game server on ${GAME_PORT}`);
  const gameServer = spawn('node', [join(repoRoot, 'apps', 'server', 'dist', 'index.js')], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(GAME_PORT),
      RIFTFRONT_MIN_PLAYERS: '2',
      RIFTFRONT_COUNTDOWN_MS: '1000',
      RIFTFRONT_MATCH_DURATION_MS: '300000',
    },
  });

  let serverLog = '';
  gameServer.stdout.on('data', (chunk) => {
    serverLog += chunk.toString();
  });
  gameServer.stderr.on('data', (chunk) => {
    serverLog += chunk.toString();
  });

  let staticServer;
  let exitCode = 1;

  try {
    await waitForHealth(`http://127.0.0.1:${GAME_PORT}`);
    console.log('› game server healthy');

    staticServer = await startStaticServer();
    console.log(`› serving client from ${clientDist} on ${CLIENT_PORT}`);

    await run('node', [join(repoRoot, 'tests', 'browser-smoke.mjs')], {
      env: { ...process.env, RIFTFRONT_CLIENT_URL: `http://127.0.0.1:${CLIENT_PORT}` },
    });
    exitCode = 0;
  } catch (error) {
    console.error('\nverify:browser failed:', error.message);
    console.error('\n--- server output ---\n' + serverLog);
  } finally {
    staticServer?.close();
    gameServer.kill('SIGTERM');
    await sleep(400);
    if (!gameServer.killed) gameServer.kill('SIGKILL');
  }

  process.exit(exitCode);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
