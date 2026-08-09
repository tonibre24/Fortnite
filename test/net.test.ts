import { describe, expect, it } from 'vitest';
import { WS_PATH, resolveServerUrl } from '@br/shared';

describe('server url resolution', () => {
  it('uses ws for a plain page', () => {
    expect(resolveServerUrl({ protocol: 'http:', host: 'localhost:5173' })).toBe(
      `ws://localhost:5173${WS_PATH}`,
    );
  });

  /**
   * The case that makes this shareable: a browser refuses a plaintext WebSocket
   * from an https page, so a tunnel that terminates TLS must produce wss.
   */
  it('uses wss for a secure page', () => {
    expect(resolveServerUrl({ protocol: 'https:', host: 'shiny-fox-42.trycloudflare.com' })).toBe(
      `wss://shiny-fox-42.trycloudflare.com${WS_PATH}`,
    );
  });

  it('keeps a non-default port and drops a default one', () => {
    // `host` already carries the port only when it is non-default, which is
    // exactly the behaviour wanted here - so nothing has to know about ports.
    expect(resolveServerUrl({ protocol: 'http:', host: '192.168.1.7:8080' })).toBe(
      `ws://192.168.1.7:8080${WS_PATH}`,
    );
    expect(resolveServerUrl({ protocol: 'https:', host: 'example.com' })).toBe(
      `wss://example.com${WS_PATH}`,
    );
  });

  it('never bakes in a hostname', () => {
    const hosts = ['localhost:5173', 'example.com', '10.0.0.4:8080', '[::1]:8080'];
    for (const host of hosts) {
      expect(resolveServerUrl({ protocol: 'http:', host })).toContain(host);
    }
  });

  it('accepts an explicit path for callers that need one', () => {
    expect(resolveServerUrl({ protocol: 'https:', host: 'example.com' }, '/socket')).toBe(
      'wss://example.com/socket',
    );
  });
});
