import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

export interface TestServerHandle {
  port: number;
  httpUrl: string;
  wsUrl: string;
  stop: () => Promise<void>;
  output: () => string;
}

export interface TestServerOptions {
  port?: number;
  env?: Record<string, string>;
  /** Milliseconds to wait for /health to answer before failing. */
  startupTimeoutMs?: number;
}

async function waitForHealth(url: string, timeoutMs: number, log: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no attempt made';

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) {
        const body = (await response.json()) as { status?: string };
        if (body.status === 'ok') return;
        lastError = `unexpected health payload: ${JSON.stringify(body)}`;
      } else {
        lastError = `health responded ${response.status}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  throw new Error(`Server did not become healthy: ${lastError}\n--- server output ---\n${log()}`);
}

/**
 * Boots the real server as a child process, exactly as `pnpm dev:server` would.
 *
 * Spawning rather than importing keeps this an end-to-end test: the HTTP layer, the
 * WebSocket transport and the room lifecycle all run in their own process.
 */
export async function startTestServer(options: TestServerOptions = {}): Promise<TestServerHandle> {
  const port = options.port ?? 3000 + Math.floor(Math.random() * 2000);
  const httpUrl = `http://127.0.0.1:${port}`;

  // The compiled server is launched, not the TypeScript sources: the integration suite
  // should exercise the same artefact that ships to production.
  const entry = path.join(repoRoot, 'apps', 'server', 'dist', 'index.js');
  if (!existsSync(entry)) {
    throw new Error(
      `Server build not found at ${entry}. Run "pnpm build" (or "pnpm test:integration", which builds first).`,
    );
  }

  const child: ChildProcessWithoutNullStreams = spawn('node', [entry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'test',
      ...options.env,
    },
    stdio: 'pipe',
  });

  let output = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });

  let exited = false;
  child.on('exit', () => {
    exited = true;
  });

  const handle: TestServerHandle = {
    port,
    httpUrl,
    wsUrl: `ws://127.0.0.1:${port}`,
    output: () => output,
    stop: async () => {
      if (exited) return;
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 4000);
        child.on('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };

  try {
    await waitForHealth(httpUrl, options.startupTimeoutMs ?? 30_000, handle.output);
  } catch (error) {
    await handle.stop();
    throw error;
  }

  return handle;
}

/** Polls `predicate` until it holds or the timeout expires. */
export async function waitFor(
  description: string,
  predicate: () => boolean,
  timeoutMs = 15_000,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${description}`);
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
