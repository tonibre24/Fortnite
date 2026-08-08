import { Rng } from '@br/shared';
import { Connection } from '../client/src/net/Connection.js';
import { LaggySocket } from './LaggySocket.js';

export interface SimClientOptions {
  url: string;
  name: string;
  seed: number;
  timeScale: number;
  latencyMs: number;
  jitterMs: number;
  lossPercent: number;
}

/**
 * A fake player. It drives the real client Connection over a laggy transport,
 * so whatever the sim exercises is exactly the code the browser runs.
 */
export class SimClient {
  readonly errors: string[] = [];
  protected readonly rng: Rng;
  protected readonly connection: Connection;

  constructor(protected readonly options: SimClientOptions) {
    this.rng = new Rng(options.seed);
    // Latency is expressed in simulated time; compress it like everything else.
    const wallLatency = options.latencyMs / options.timeScale;
    const wallJitter = options.jitterMs / options.timeScale;

    this.connection = new Connection({
      url: options.url,
      name: options.name,
      timeScale: options.timeScale,
      createSocket: (url) =>
        new LaggySocket(url, {
          latencyMs: wallLatency,
          jitterMs: wallJitter,
          lossPercent: options.lossPercent,
          seed: options.seed ^ 0x9e3779b9,
        }),
      handlers: {
        onStatus: (status, detail) => {
          if (status === 'disconnected' && detail !== 'closed') {
            this.errors.push(`${options.name}: ${detail}`);
          }
        },
      },
    });
  }

  get playerId(): number {
    return this.connection.playerId;
  }

  get rttMs(): number {
    return this.connection.rttMs;
  }

  start(): void {
    this.connection.connect();
  }

  stop(): void {
    this.connection.close();
  }
}
