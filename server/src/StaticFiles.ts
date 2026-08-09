import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Serves the built client next to the WebSocket, so the whole game is one
 * origin on one port. That is what makes it tunnelable: a single hostname to
 * forward, and no cross-origin anything to configure.
 *
 * Deliberately dependency-free - this needs to do exactly one thing, and the
 * project's rule is no new dependencies.
 */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** Hashed bundles are immutable; the entry HTML must never be cached. */
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
const NO_CACHE = 'no-cache';

export class StaticFiles {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /**
   * Resolves a URL path to a file inside the root, or null if it escapes.
   *
   * The traversal check compares resolved absolute paths rather than inspecting
   * the URL for `..`, because encodings and mixed separators make string
   * inspection easy to get wrong.
   */
  private resolvePath(urlPath: string): string | null {
    let decoded: string;
    try {
      decoded = decodeURIComponent(urlPath);
    } catch {
      return null;
    }
    // A NUL byte can truncate the path inside the filesystem layer.
    if (decoded.includes('\0')) return null;

    const candidate = resolve(join(this.root, normalize(decoded)));
    if (candidate !== this.root && !candidate.startsWith(this.root + sep)) return null;
    return candidate;
  }

  /**
   * Writes the file for this request, or returns false if there is nothing to
   * serve and the caller should answer for itself.
   */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;

    const urlPath = new URL(req.url ?? '/', 'http://localhost').pathname;
    const resolved = this.resolvePath(urlPath === '/' ? '/index.html' : urlPath);
    if (resolved === null) return false;

    // No catch-all fallback to index.html: the game is a single page with no
    // client-side routing, so anything that is not a real file is a genuine 404
    // rather than a route. Answering HTML to a mistyped asset only turns a
    // missing file into a confusing parse error somewhere further downstream.
    const file = (await this.statFile(resolved)) ?? (await this.statFile(join(resolved, 'index.html')));
    if (file === null) return false;

    // Vite fingerprints everything under /assets, so those are safe to pin.
    const cache = urlPath.startsWith('/assets/') ? IMMUTABLE_CACHE : NO_CACHE;
    this.send(req, res, file.path, file.size, cache);
    return true;
  }

  private async statFile(path: string): Promise<{ path: string; size: number } | null> {
    try {
      const info = await stat(path);
      return info.isFile() ? { path, size: info.size } : null;
    } catch {
      return null;
    }
  }

  private send(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    size: number,
    cacheControl: string,
  ): void {
    res.writeHead(200, {
      'content-type': MIME[extname(path).toLowerCase()] ?? 'application/octet-stream',
      'content-length': size,
      'cache-control': cacheControl,
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = createReadStream(path);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }
}
