import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_HEALTH_PORT, healthPort, startHealthServer } from '../src/health.js';

describe('healthPort', () => {
  it('uses $PORT when it is a valid port, otherwise 8080', () => {
    expect(healthPort('3000')).toBe(3000);
    expect(healthPort(undefined)).toBe(DEFAULT_HEALTH_PORT);
    expect(healthPort('')).toBe(DEFAULT_HEALTH_PORT);
    expect(healthPort('abc')).toBe(DEFAULT_HEALTH_PORT);
    expect(healthPort('70000')).toBe(DEFAULT_HEALTH_PORT);
  });
});

describe('status page', () => {
  let close: (() => void) | undefined;
  afterEach(() => close?.());

  async function start(ready: boolean) {
    const server = startHealthServer(0, () => ready);
    close = () => server.close();
    await new Promise<void>((resolve) => server.once('listening', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('answers ok, and whether Discord is connected, without anything else', async () => {
    const base = await start(true);
    const response = await fetch(base);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', discord: 'connected' });
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it('is up while Discord is still connecting', async () => {
    const base = await start(false);
    expect(await (await fetch(base)).json()).toEqual({ status: 'ok', discord: 'starting' });
  });

  it('serves nothing else', async () => {
    const base = await start(true);
    expect((await fetch(`${base}/projects`)).status).toBe(404);
    expect((await fetch(base, { method: 'POST' })).status).toBe(404);
  });
});
