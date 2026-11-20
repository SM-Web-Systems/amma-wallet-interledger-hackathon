import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const apps: FastifyInstance[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function fixture(allowedPath?: (pathname: string) => boolean) {
  const root = mkdtempSync(path.join(tmpdir(), 'wallet-static-'));
  directories.push(root);
  mkdirSync(path.join(root, 'public'));
  mkdirSync(path.join(root, 'private'));
  writeFileSync(path.join(root, 'public', 'icon.svg'), '<svg>synthetic-icon</svg>');
  writeFileSync(path.join(root, 'private', 'secret.txt'), 'synthetic-private-file');
  // Injected URLs pass through WHATWG URL normalization. Rewriting the request
  // target before routing lets this fixture model raw HTTP dot segments without
  // opening a socket or having the client remove the attack first.
  const app = Fastify({ rewriteUrl: request => {
    const raw = request.headers['x-fixture-path'];
    return typeof raw === 'string' ? raw : request.url!;
  } });
  apps.push(app);
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-fixture-raw-path', request.raw.url);
  });
  await app.register(swagger, { openapi: { info: { title: 'Synthetic Wallet', version: '1' } } });
  await app.register(swaggerUi, { routePrefix: '/docs' });
  app.get('/assets/icons/private/*', { preHandler: async (_request, reply) => {
    return reply.code(401).send({ error: 'Synthetic authentication required' });
  } }, async () => 'guarded');
  // Same prefix/decorateReply options as server.ts; only the fixture root differs.
  await app.register(fastifyStatic, { root, prefix: '/assets/icons/', decorateReply: false, allowedPath });
  return app;
}

describe('real Fastify plugin dependency contracts (injection only, no listener)', () => {
  it('serves public icons alongside Swagger UI and keeps missing files missing', async () => {
    const app = await fixture();
    const icon = await app.inject('/assets/icons/public/icon.svg');
    expect(icon.statusCode).toBe(200);
    expect(icon.headers['content-type']).toContain('image/svg+xml');
    expect(icon.body).toBe('<svg>synthetic-icon</svg>');
    expect((await app.inject('/assets/icons/missing.svg')).statusCode).toBe(404);
    expect((await app.inject('/docs/json')).json().info.title).toBe('Synthetic Wallet');
    expect((await app.inject('/docs/static/swagger-ui.css')).statusCode).toBe(200);
  });

  it.each(['public/../private/secret.txt', 'public/%2E%2E/private/secret.txt'])
  ('does not bypass a guarded subtree through %s', async suffix => {
    const app = await fixture();
    expect((await app.inject('/assets/icons/private/secret.txt')).statusCode).toBe(401);
    const raw = '/assets/icons/' + suffix;
    const result = await app.inject({ method: 'GET', url: '/raw-fixture', headers: { 'x-fixture-path': raw } });
    expect(result.headers['x-fixture-raw-path']).toBe(raw);
    expect([400, 401, 403, 404]).toContain(result.statusCode);
    expect(result.body).not.toContain('synthetic-private-file');
  });

  it.each(['public/../private/secret.txt', '/private/secret.txt', './private/secret.txt'])
  ('applies allowedPath to noncanonical path %s', async suffix => {
    const app = await fixture(pathname => !pathname.startsWith('/private/'));
    const raw = '/assets/icons/' + suffix;
    const result = await app.inject({ method: 'GET', url: '/raw-fixture', headers: { 'x-fixture-path': raw } });
    expect(result.headers['x-fixture-raw-path']).toBe(raw);
    expect([400, 401, 403, 404]).toContain(result.statusCode);
    expect(result.body).not.toContain('synthetic-private-file');
  });
});
