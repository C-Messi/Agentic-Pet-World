import { describe, expect, it } from 'vitest';

import { buildApp } from './app.js';

describe('server bootstrap', () => {
  it('exposes a readiness endpoint', async () => {
    const app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/health' });

    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});
