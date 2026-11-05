import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import passport from 'passport';
import { loadLocalEnvironment, trustProxyHops, exportConcurrency } from '../services/runtimeConfig.mjs';
import { createOAuthSession, OAUTH_SESSION_PATH } from '../services/oauthSession.mjs';

const production = { NODE_ENV: 'production', JWT_SECRET: 'synthetic-production-secret-for-tests-only', TRUST_PROXY_HOPS: '1' };

class TestSessionDatabase {
  constructor(data = new Map()) { this.data = data; this.now = Date.now(); }
  async query(sql, values = []) {
    if (sql.startsWith('SELECT sess')) {
      const value = this.data.get(values[0]);
      return { rows: value && value.expires > +values[1] ? [{ sess: structuredClone(value.sess) }] : [] };
    }
    if (sql.startsWith('INSERT INTO oauth_sessions')) {
      this.data.set(values[0], { sess: JSON.parse(values[1]), expires: +values[2] });
    } else if (sql.startsWith('UPDATE oauth_sessions')) {
      const value = this.data.get(values[0]);
      if (value && value.expires > +values[2]) value.expires = +values[1];
    } else if (sql.startsWith('DELETE FROM oauth_sessions WHERE sid')) {
      this.data.delete(values[0]);
    } else if (sql.startsWith('DELETE FROM oauth_sessions WHERE expires_at')) {
      for (const [key, value] of this.data) if (value.expires <= +values[0]) this.data.delete(key);
    }
    return { rows: [] };
  }
}

async function serve(t, app) {
  const server = await new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return 'http://127.0.0.1:' + server.address().port;
}

function sessionApp(t, client) {
  const manager = createOAuthSession({ environment: production, database: client, now: () => client.now });
  t.after(() => manager.close());
  const app = express();
  app.set('trust proxy', trustProxyHops(production));
  app.use(OAUTH_SESSION_PATH, manager.middleware);
  app.get(OAUTH_SESSION_PATH + '/set', (req, res) => { req.session.oauthState = 'synthetic-state'; res.sendStatus(200); });
  app.get(OAUTH_SESSION_PATH + '/read', (req, res) => res.json({ state: req.session.oauthState || null }));
  return { app, manager };
}

test('production and test ignore local env files; development keeps explicit local overrides', async t => {
  const base = path.resolve(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(base, 'synapse-runtime-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), base);
    assert.ok(path.basename(directory).startsWith('synapse-runtime-test-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(directory, '.env'), 'DB_HOST=base-file\nONLY_LOCAL=synthetic\n');
  await fs.writeFile(path.join(directory, '.env.local'), 'DB_HOST=localhost-override\n');
  for (const NODE_ENV of ['production', 'test']) {
    const env = { NODE_ENV, DB_HOST: 'container-postgres' };
    loadLocalEnvironment(directory, env);
    assert.deepEqual(env, { NODE_ENV, DB_HOST: 'container-postgres' });
  }
  const env = { NODE_ENV: 'development', DB_HOST: 'initial' };
  loadLocalEnvironment(directory, env);
  assert.equal(env.DB_HOST, 'localhost-override');
  assert.equal(env.ONLY_LOCAL, 'synthetic');
});

test('proxy setting preserves client IP and HTTPS only with the configured single proxy', async t => {
  for (const hops of ['0', '1']) {
    const app = express();
    app.set('trust proxy', trustProxyHops({ TRUST_PROXY_HOPS: hops }));
    app.get('/', (req, res) => res.json({ ip: req.ip, secure: req.secure }));
    const base = await serve(t, app);
    const result = await (await fetch(base, { headers: {
      'X-Forwarded-For': '192.0.2.2, 198.51.100.10', 'X-Forwarded-Proto': 'https',
    } })).json();
    assert.equal(result.secure, hops === '1');
    assert.equal(result.ip, hops === '1' ? '198.51.100.10' : '127.0.0.1');
  }
  for (const value of ['true', '-1', '2']) assert.throws(() => trustProxyHops({ TRUST_PROXY_HOPS: value }));
});

test('production OAuth sessions survive a new API instance and expire after ten minutes', async t => {
  const shared = new Map();
  const first = sessionApp(t, new TestSessionDatabase(shared));
  const firstBase = await serve(t, first.app);
  const response = await fetch(firstBase + OAUTH_SESSION_PATH + '/set', { headers: { 'X-Forwarded-Proto': 'https' } });
  const header = response.headers.get('set-cookie');
  assert.match(header, /; Secure/);
  assert.match(header, /; HttpOnly/);
  assert.match(header, /; SameSite=Lax/);
  assert.match(header, /Path=\/api\/login\/auth\/google/);
  const cookie = header.split(';')[0];
  await first.manager.close();
  const client = new TestSessionDatabase(shared);
  const second = sessionApp(t, client);
  const secondBase = await serve(t, second.app);
  const read = () => fetch(secondBase + OAUTH_SESSION_PATH + '/read', { headers: { cookie, 'X-Forwarded-Proto': 'https' } });
  assert.deepEqual(await (await read()).json(), { state: 'synthetic-state' });
  assert.equal(await second.manager.healthy(), true);
  client.now += 601000;
  assert.deepEqual(await (await read()).json(), { state: null });
});

test('production does not send its OAuth session cookie over plain HTTP', async t => {
  const { app } = sessionApp(t, new TestSessionDatabase());
  const base = await serve(t, app);
  const response = await fetch(base + OAUTH_SESSION_PATH + '/set');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.throws(() => createOAuthSession({ environment: production }), /DATABASE_URL/);
});

test('actual Google route rejects forged or replayed OAuth state before any upstream token request', async t => {
  const values = {
    GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret',
    BACKEND_URL: 'https://example.test', FRONTEND_URL: 'https://example.test',
  };
  const saved = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  const { default: router } = await import('../routes/loginRouter.mjs');
  const strategy = passport._strategy('google');
  let tokenCalls = 0;
  const original = strategy._oauth2.getOAuthAccessToken;
  strategy._oauth2.getOAuthAccessToken = (_code, _params, cb) => { tokenCalls++; cb(new Error('Synthetic upstream stop')); };
  t.after(() => { strategy._oauth2.getOAuthAccessToken = original; });
  const { app } = sessionApp(t, new TestSessionDatabase());
  app.use(passport.initialize());
  app.use('/api/login', router);
  app.use((_error, _req, res, _next) => res.status(500).json({ synthetic: true }));
  const base = await serve(t, app);
  const start = async () => {
    const r = await fetch(base + OAUTH_SESSION_PATH, { redirect: 'manual', headers: { 'X-Forwarded-Proto': 'https' } });
    assert.equal(r.status, 302);
    const state = new URL(r.headers.get('location')).searchParams.get('state');
    assert.ok(state?.length >= 20);
    return { state, cookie: r.headers.get('set-cookie').split(';')[0] };
  };
  const callback = (state, cookie) => fetch(base + OAUTH_SESSION_PATH + '/callback?code=synthetic&state=' + state, {
    redirect: 'manual', headers: { cookie, 'X-Forwarded-Proto': 'https' },
  });
  const first = await start();
  for (const state of ['forged', first.state]) {
    const r = await callback(state, first.cookie);
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), 'https://example.test/login?error=google_failed');
  }
  assert.equal(tokenCalls, 0);
  const second = await start();
  assert.equal((await callback(second.state, second.cookie)).status, 500);
  assert.equal(tokenCalls, 1);
});

test('export concurrency defaults protect production and reject invalid limits', () => {
  assert.equal(exportConcurrency({}), 2);
  assert.equal(exportConcurrency({ NODE_ENV: 'production' }), 1);
  assert.equal(exportConcurrency({ EXPORT_CONCURRENCY: '3' }), 3);
  for (const value of ['0', '-1', '1.5', '9', 'NaN']) assert.throws(() => exportConcurrency({ EXPORT_CONCURRENCY: value }));
});
