/**
 * Scripted rendering benchmark.
 *
 * Boots the production server, fills the lobby with simulated players, loads
 * the real client in a browser and samples every frame time it produces. The
 * headline number is the 1% low: an average hides exactly the hitches that make
 * a game feel bad, so the worst frames are what the budget has to be judged on.
 *
 * Reads window.__perf, which client/src/main.ts exposes for this purpose.
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME =
  process.env.CHROME ?? '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell';
const PORT = Number(process.env.BENCH_PORT ?? 8123);
const BOTS = Number(process.env.BENCH_BOTS ?? 19);
const WARMUP_MS = Number(process.env.BENCH_WARMUP_MS ?? 12000);
const SAMPLE_MS = Number(process.env.BENCH_SAMPLE_MS ?? 30000);
const WIDTH = Number(process.env.BENCH_WIDTH ?? 1920);
const HEIGHT = Number(process.env.BENCH_HEIGHT ?? 1080);
const DEBUG_PORT = 9902;

const children = [];
function launch(command, args, env) {
  const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: 'ignore' });
  children.push(child);
  return child;
}
function cleanup() {
  for (const child of children) child.kill('SIGKILL');
}
process.on('exit', cleanup);

/** Percentile of a sorted-ascending array, where p is a fraction. */
function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[index];
}

async function main() {
  console.log('rendering benchmark');
  console.log(`  ${BOTS + 1} players · ${WIDTH}x${HEIGHT} · ${SAMPLE_MS / 1000}s sample`);
  console.log('');

  launch('node', ['--conditions=compiled', 'server/dist/index.js'], { PORT: String(PORT) });
  await sleep(2500);

  launch('npx', ['tsx', 'tools/bots.ts'], {
    BOT_URL: `ws://127.0.0.1:${PORT}/ws`,
    BOT_COUNT: String(BOTS),
  });
  await sleep(3000);

  launch(CHROME, [
    '--no-sandbox',
    '--disable-gpu',
    '--use-gl=swiftshader',
    '--enable-unsafe-swiftshader',
    '--no-proxy-server',
    '--mute-audio',
    `--window-size=${WIDTH},${HEIGHT}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
    'about:blank',
  ]);

  let page;
  for (let i = 0; i < 100 && !page; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      page = list.find((t) => t.type === 'page');
    } catch {
      /* not up yet */
    }
    if (!page) await sleep(200);
  }
  if (!page) throw new Error('browser never came up');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let nextId = 1;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message.result ?? message.error);
      pending.delete(message.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evalJs = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'eval failed');
    return result.result.value;
  };

  await send('Page.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await sleep(WARMUP_MS);

  // Discard everything up to here: shader compilation and the first map build
  // are one-off costs, not the steady state the budget is about.
  await evalJs('window.__perf.reset()');
  await sleep(SAMPLE_MS);

  const frames = await evalJs('window.__perf.frames.slice()');
  const cpu = await evalJs('window.__perf.cpu.slice()');
  const stats = await evalJs('JSON.stringify(window.__perf.stats())');
  const scene = JSON.parse(stats);

  if (frames.length === 0) throw new Error('no frames sampled — did the client fail to start?');
  const sorted = [...frames].sort((a, b) => a - b);
  const mean = frames.reduce((a, b) => a + b, 0) / frames.length;

  console.log('scene');
  console.log(`  players          ${scene.players}`);
  console.log(`  draw calls       ${scene.draws}`);
  console.log(`  triangles        ${(scene.triangles / 1000).toFixed(0)}k`);
  console.log(`  textures         ${scene.textures}`);
  console.log(`  geometries       ${scene.geometries}`);
  console.log(`  shader programs  ${scene.programs}`);
  console.log(`  scenery props    ${scene.props}`);
  console.log(`  shadows          ${scene.shadows ? 'on' : 'off'}`);
  console.log('');
  console.log('frame time');
  console.log(`  frames sampled   ${frames.length}`);
  console.log(`  mean             ${mean.toFixed(2)} ms  (${(1000 / mean).toFixed(1)} fps)`);
  console.log(`  median           ${percentile(sorted, 0.5).toFixed(2)} ms`);
  console.log(`  95th percentile  ${percentile(sorted, 0.95).toFixed(2)} ms`);
  console.log(`  99th percentile  ${percentile(sorted, 0.99).toFixed(2)} ms`);
  console.log(`  1% LOW           ${percentile(sorted, 0.99).toFixed(2)} ms  (${(1000 / percentile(sorted, 0.99)).toFixed(1)} fps)`);
  console.log('');
  // The CPU half is simulation, interpolation, instance updates and HUD. It is
  // the part that does not change with the GPU, so it is the only figure here
  // that carries over to real hardware.
  const cpuSorted = [...cpu].sort((a, b) => a - b);
  const cpuMean = cpu.reduce((a, b) => a + b, 0) / Math.max(1, cpu.length);
  console.log('cpu time per frame (GPU-independent)');
  console.log(`  mean             ${cpuMean.toFixed(2)} ms`);
  console.log(`  99th percentile  ${percentile(cpuSorted, 0.99).toFixed(2)} ms`);
  console.log('');
  console.log('  NOTE: this host has no GPU. Chromium falls back to SwiftShader,');
  console.log('  which rasterises on the CPU, so these absolute numbers are a');
  console.log('  floor and not a prediction of integrated-graphics performance.');
  console.log('  Draw calls, triangles and program count are hardware-independent');
  console.log('  and are the figures to judge the scene complexity on.');

  ws.close();
  cleanup();
  process.exit(0);
}

main().catch((error) => {
  console.error(`benchmark failed: ${error.message}`);
  cleanup();
  process.exit(1);
});
