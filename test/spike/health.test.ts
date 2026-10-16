/**
 * Spike 4 — aplicação Nest completa sob Bun (ORM + SQS + HTTP).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../../src/bootstrap';

let app: INestApplication;
let baseUrl: string;

beforeAll(async () => {
  app = await createApp();
  app.useLogger(false);
  await app.listen(0);
  baseUrl = (await app.getUrl()).replace('[::1]', 'localhost');
});
afterAll(async () => {
  await app?.close();
});

describe('spike: health endpoints', () => {
  test('GET /health/live → 200', async () => {
    const res = await fetch(`${baseUrl}/health/live`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'up' });
  });

  test('GET /health/ready → 200 with postgres and sqs up', async () => {
    const res = await fetch(`${baseUrl}/health/ready`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'up', checks: { postgres: { status: 'up' }, sqs: { status: 'up' } } });
  });
});
