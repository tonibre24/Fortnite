/**
 * Scripted render benchmark driver.
 *
 * Builds the client, serves `apps/client/dist` locally, opens `bench.html` in Chromium
 * at a fixed 1920x1080 backbuffer, runs the measured pass and prints the frame time
 * distribution — headline number being the **1% low** (99th percentile) frame time.
 *
 * Usage:
 *   pnpm bench                      # 20 players, full VFX, everything on
 *   pnpm bench -- --players 8       # fewer players
 *   pnpm bench -- --no-shadows      # quality levers, for finding what to cut
 *   pnpm bench -- --frames 900
 *   pnpm bench -- --screenshot out.png
 *   pnpm bench -- --skip-build      # reuse the existing dist
 *
 * Note on hardware: the target is 60 fps at 1080p on integrated laptop graphics. CI
 * containers usually have no GPU at all and fall back to SwiftShader, a CPU rasteriser
 * that is one to two orders of magnitude slower at fill rate. The driver prints the
 * detected renderer alongside the numbers, and also reports draw calls and triangle
 * count, which are hardware-independent and are what the budget is actually managed
 * against.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const clientDist = join(repoRoot, 'apps', 'client', 'dist');
const PORT = Number(process.env.RIFTFRONT_BENCH_PORT ?? 4791);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function parseArgs(argv) {
  const args = {
    players: 20,
    frames: 600,
    warmupFrames: 90,
    width: 1920,
    height: 1080,
    vfx: true,
    shadows: true,
    props: true,
    storm: true,
    camera: 'player',
    screenshot: '',
    skipBuild: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '--players':
        args.players = Number(next());
        break;
      case '--frames':
        args.frames = Number(next());
        break;
      case '--warmup':
        args.warmupFrames = Number(next());
        break;
      case '--width':
        args.width = Number(next());
        break;
      case '--height':
        args.height = Number(next());
        break;
      case '--screenshot':
        args.screenshot = resolve(repoRoot, next());
        break;
      case '--skip-build':
        args.skipBuild = true;
        break;
      case '--json':
        args.json = true;
        break;
      case '--no-vfx':
        args.vfx = false;
        break;
      case '--no-shadows':
        args.shadows = false;
        break;
      case '--no-props':
        args.props = false;
        break;
      case '--no-storm':
        args.storm = false;
        break;
      case '--overview':
        args.camera = 'overview';
        break;
      case '--boundary':
        args.camera = 'boundary';
        break;
      default:
        if (arg.startsWith('--')) throw new Error(`unknown flag ${arg}`);
    }
  }
  return args;
}

function run(command, commandArgs, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, commandArgs, { cwd: repoRoot, stdio: 'inherit', ...options });
    child.on('error', rejectPromise);
    child.on('exit', (code) =>
      code === 0 ? resolvePromise() : rejectPromise(new Error(`${command} exited with ${code}`)),
    );
  });
}

function startStaticServer() {
  const server = createServer((req, res) => {
    const requested = decodeURIComponent((req.url ?? '/').split('?')[0]);
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
    server.listen(PORT, '127.0.0.1', () => resolvePromise(server));
  });
}

function resolveChromium() {
  return [
    process.env.RIFTFRONT_CHROMIUM,
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/opt/pw-browsers/chromium/chrome-linux/chrome',
  ]
    .filter(Boolean)
    .find((path) => existsSync(path));
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function report(args, result) {
  const budgetMs = 1000 / 60;
  const pass = result.onePercentLowMs <= budgetMs;

  const lines = [
    '',
    '  Riftfront render benchmark',
    '  ─────────────────────────────────────────────',
    `  resolution        ${result.renderWidth}x${result.renderHeight}`,
    `  renderer          ${result.renderer}`,
    `  players           ${args.players}`,
    `  camera            ${args.camera}`,
    `  vfx / shadows     ${args.vfx ? 'on' : 'off'} / ${args.shadows ? 'on' : 'off'}`,
    `  props / storm     ${args.props ? 'on' : 'off'} / ${args.storm ? 'on' : 'off'}`,
    `  frames measured   ${result.frames}`,
    '',
    `  average           ${result.averageMs.toFixed(2)} ms  (${result.averageFps.toFixed(1)} fps)`,
    `  median            ${result.medianMs.toFixed(2)} ms`,
    `  1% low            ${result.onePercentLowMs.toFixed(2)} ms  (${result.fpsFromOnePercentLow.toFixed(1)} fps)`,
    `  0.1% low          ${result.worstMs.toFixed(2)} ms`,
    '',
    `  cpu average       ${result.cpuAverageMs.toFixed(2)} ms`,
    `  cpu 1% low        ${result.cpuOnePercentLowMs.toFixed(2)} ms`,
    '',
    `  draw calls        ${result.drawCalls}`,
    `  triangles         ${result.triangles.toLocaleString('en-US')}`,
    `  active meshes     ${result.activeMeshes}`,
    `  texture memory    ${formatBytes(result.textureBytes)}`,
    '',
    `  budget 16.67 ms   ${pass ? 'MET' : 'MISSED'} on this renderer`,
    '',
  ];
  console.log(lines.join('\n'));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.skipBuild) {
    console.log('› building shared + client');
    await run('pnpm', ['--filter', '@riftfront/shared', 'build']);
    await run('pnpm', ['--filter', '@riftfront/client', 'build']);
  }
  if (!existsSync(join(clientDist, 'bench.html'))) {
    throw new Error('apps/client/dist/bench.html missing — run without --skip-build');
  }

  const server = await startStaticServer();
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({
    headless: true,
    executablePath: resolveChromium(),
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
    ],
  });

  let exitCode = 1;
  try {
    const page = await browser.newPage({
      viewport: { width: args.width, height: args.height },
      deviceScaleFactor: 1,
    });
    page.on('pageerror', (error) => console.error('[page error]', error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') console.error('[page console]', message.text());
    });

    const query = new URLSearchParams({
      players: String(args.players),
      vfx: args.vfx ? '1' : '0',
      shadows: args.shadows ? '1' : '0',
      props: args.props ? '1' : '0',
      storm: args.storm ? '1' : '0',
      camera: args.camera,
    });
    await page.goto(`http://127.0.0.1:${PORT}/bench.html?${query}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.riftfrontBench !== undefined, null, { timeout: 30000 });

    const result = await page.evaluate(
      ({ frames, warmupFrames }) => window.riftfrontBench.run({ frames, warmupFrames }),
      { frames: args.frames, warmupFrames: args.warmupFrames },
    );

    if (args.screenshot) {
      await page.evaluate(() => {
        document.getElementById('bench-output')?.remove();
      });
      await page.evaluate(() => window.riftfrontBench.preview());
      await page.waitForTimeout(1200);
      await page.screenshot({ path: args.screenshot });
      console.log(`› screenshot written to ${args.screenshot}`);
    }

    if (args.json) console.log(JSON.stringify(result));
    else report(args, result);
    exitCode = 0;
  } catch (error) {
    console.error('benchmark failed:', error);
  } finally {
    await browser.close();
    server.close();
  }

  process.exit(exitCode);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
