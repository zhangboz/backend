import '../config.mjs';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import pg from 'pg';
import IORedis from 'ioredis';

const backend = fileURLToPath(new URL('..', import.meta.url));
const frontend = path.resolve(backend, '../web_frontend');
const stateDir = path.join(backend, '.local');
const statePath = path.join(stateDir, 'processes.json');
const compose = path.join(backend, 'docker-compose.local.yml');
fs.mkdirSync(stateDir, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const command = (exe, args, options = {}) => spawnSync(exe, args, {
  encoding: 'utf8', windowsHide: true, timeout: 30000, ...options,
});
const docker = args => command('docker', ['compose', '-f', compose, ...args], { timeout: 60000 });
const readState = () => fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
const writeState = state => fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
const client = () => new pg.Client({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  connectionTimeoutMillis: 5000, options: '-c default_transaction_read_only=on',
});
const portOpen = port => new Promise(resolve => {
  const socket = net.connect({ host: '127.0.0.1', port });
  const finish = value => { socket.destroy(); resolve(value); };
  socket.setTimeout(1000);
  socket.once('connect', () => finish(true));
  socket.once('error', () => finish(false));
  socket.once('timeout', () => finish(false));
});
function ownsProcess(record) {
  if (!record?.pid || !record.entry) return false;
  try { process.kill(record.pid, 0); } catch { return false; }
  if (process.platform === 'win32') {
    const result = command('powershell.exe', ['-NoProfile', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(record.pid)}").CommandLine`]);
    return result.status === 0 && result.stdout.toLowerCase().includes(record.entry.toLowerCase());
  }
  return command('ps', ['-p', String(record.pid), '-o', 'args=']).stdout.includes(record.entry);
}
function launch(name, entry, args, cwd, extraEnv = {}) {
  const state = readState();
  if (ownsProcess(state[name])) return;
  const output = fs.openSync(path.join(stateDir, `${name}.log`), 'a');
  const child = spawn(process.execPath, [entry, ...args], {
    cwd, env: { ...process.env, ...extraEnv }, windowsHide: true, detached: true,
    stdio: ['ignore', output, output],
  });
  fs.closeSync(output);
  child.unref();
  state[name] = { pid: child.pid, entry };
  writeState(state);
  return state[name];
}
async function check() {
  let good = true;
  const report = (name, ok, detail = '') => { console.log(`${ok ? 'OK' : 'FAIL'} ${name}${detail ? ': ' + detail : ''}`); good &&= ok; };
  for (const variable of ['OPENAI_API_KEY', 'JWT_SECRET', 'DB_PASSWORD']) report(variable, Boolean(process.env[variable]));
  const c = client();
  try {
    await c.connect();
    const { rows } = await c.query('SELECT (SELECT count(*) FROM users)::int AS users, (SELECT count(*) FROM subscriptions)::int AS subscriptions');
    report('PostgreSQL', true, `${rows[0].users} users, ${rows[0].subscriptions} subscriptions`);
  } catch (error) { report('PostgreSQL', false, error.code || 'connection failed'); }
  finally { await c.end().catch(() => {}); }
  for (const exe of ['pandoc', 'xelatex']) report(exe, command(exe, ['--version']).status === 0);
  report('Docker engine', command('docker', ['info', '--format', '{{.ServerVersion}}']).status === 0);
  const redis = new IORedis(process.env.REDIS_URL, { lazyConnect: true, retryStrategy: null, connectTimeout: 2000, maxRetriesPerRequest: 1 });
  redis.on('error', () => {});
  try { await redis.connect(); report('Redis', await redis.ping() === 'PONG'); }
  catch { report('Redis', false, 'Run npm run local:start after Docker Desktop is ready.'); }
  finally { redis.disconnect(); }
  try {
    const r = await fetch('http://127.0.0.1:5000/api/health', { signal: AbortSignal.timeout(4000) });
    const health = await r.json(); report('API + worker', r.ok && health.healthy);
  } catch { report('API + worker', false, 'Not started.'); }
  try {
    const response = await fetch('http://127.0.0.1:3000', { signal: AbortSignal.timeout(5000) });
    const html = await response.text();
    report('React', response.ok && html.includes('id="root"'));
  } catch { report('React', false, 'Not started or still compiling. See backend/.local/frontend.log.'); }
  process.exitCode = good ? 0 : 1;
}
async function backup() {
  const dir = path.join(backend, 'backups'); fs.mkdirSync(dir, { recursive: true });
  const output = path.join(dir, `before-openai-${new Date().toISOString().replace(/[:.]/g, '-')}.dump`);
  const exe = process.env.PG_DUMP_PATH || (process.platform === 'win32' ? 'C:\\Program Files\\PostgreSQL\\16\\bin\\pg_dump.exe' : 'pg_dump');
  const result = command(exe, ['-h', process.env.DB_HOST, '-p', process.env.DB_PORT, '-U', process.env.DB_USER,
    '-d', process.env.DB_NAME, '-Fc', '--no-password', '-f', output], {
    env: { ...process.env, PGPASSWORD: process.env.DB_PASSWORD }, timeout: 120000,
  });
  if (result.status !== 0) throw new Error('Database backup failed. Check PostgreSQL access; no database changes were made.');
  console.log(`Database backup saved: ${output} (${fs.statSync(output).size} bytes)`);
}
function stopManaged(name, record) {
  if (!ownsProcess(record)) return true;
  if (process.platform === 'win32') {
    const result = command('taskkill', ['/PID', String(record.pid), '/T', '/F']);
    if (result.status !== 0 && ownsProcess(record)) return false;
  } else {
    try { process.kill(record.pid, 'SIGTERM'); } catch { return false; }
  }
  return true;
}
async function start() {
  const entries = [
    ['worker', path.join(backend, 'FileProcessor/worker.mjs'), backend, null],
    ['api', path.join(backend, 'server.mjs'), backend, 5000],
    ['frontend', path.join(backend, 'scripts/frontend.mjs'), frontend, 3000],
  ];
  for (const [name, entry, , port] of entries) {
    if (!fs.existsSync(entry)) throw new Error(`Missing ${name} entry; install project dependencies first.`);
    if (!ownsProcess(readState()[name]) && port && await portOpen(port)) {
      throw new Error(`Port ${port} is occupied by an untracked process. No application processes were started.`);
    }
  }
  if (command('docker', ['info', '--format', '{{.ServerVersion}}']).status !== 0) {
    throw new Error('Open Docker Desktop and wait until the engine is running, then rerun npm run local:start.');
  }
  const c = client();
  try { await c.connect(); await c.query('SELECT 1 FROM users LIMIT 1'); }
  finally { await c.end(); }
  const redisWasRunning = Boolean(docker(['ps', '--quiet', '--status', 'running', 'redis']).stdout.trim());
  const launched = [];
  try {
    const redis = docker(['up', '-d', '--wait', 'redis']);
    if (redis.status !== 0) throw new Error('Local Redis failed to start. Check Docker Desktop and port 6379.');
    for (const [name, entry, cwd] of entries) {
      if (ownsProcess(readState()[name])) continue;
      launch(name, entry, [], cwd,
        name === 'frontend' ? { CI: 'true', HOST: '127.0.0.1', PORT: '3000', BROWSER: 'none', REACT_APP_BACKEND_URL: 'http://localhost:5000' } : {});
      launched.push(name);
    }
    for (let i = 0; i < 45; i++) {
      try {
        const r = await fetch('http://127.0.0.1:5000/api/health', { signal: AbortSignal.timeout(3000) });
        const health = await r.json();
        if (r.ok && health.healthy) {
          const page = await fetch('http://127.0.0.1:3000', { signal: AbortSignal.timeout(3000) });
          const html = await page.text();
          if (page.ok && html.includes('id="root"')) {
            console.log('Ready: http://localhost:3000 (API: http://localhost:5000/api/health)'); return;
          }
        }
      } catch { /* Wait for tracked children. */ }
      if (launched.some(name => !ownsProcess(readState()[name]))) break;
      await sleep(1000);
    }
    throw new Error('Services did not become ready. Check backend/.local/{api,worker,frontend}.log.');
  } catch (error) {
    const state = readState();
    for (const name of launched) if (stopManaged(name, state[name])) delete state[name];
    writeState(state);
    if (!redisWasRunning) docker(['stop', 'redis']);
    throw error;
  }
}
function stop() {
  const state = readState();
  const failures = [];
  for (const [name, record] of Object.entries(state)) {
    if (stopManaged(name, record)) delete state[name]; else failures.push(name);
  }
  writeState(state);
  if (docker(['stop', 'redis']).status !== 0) failures.push('Redis (Docker unavailable)');
  if (failures.length) throw new Error(`Could not stop: ${failures.join(', ')}. Remaining process records were retained.`);
  console.log('Stopped managed local services. PostgreSQL and stored data were preserved.');
}
async function restartApi() {
  const state = readState();
  const owned = ownsProcess(state.api);
  if (!owned && await portOpen(5000)) throw new Error('Port 5000 belongs to an untracked process; API restart was not attempted.');
  if (!stopManaged('api', state.api)) throw new Error('Could not stop the managed API.');
  delete state.api; writeState(state);
  for (let attempt = 0; attempt < 20 && await portOpen(5000); attempt++) await sleep(250);
  if (await portOpen(5000)) throw new Error('Port 5000 did not become available.');
  launch('api', path.join(backend, 'server.mjs'), [], backend);
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!ownsProcess(readState().api)) break;
    try {
      const response = await fetch('http://127.0.0.1:5000/api/health', { signal: AbortSignal.timeout(3000) });
      if (response.ok) { console.log('API restarted and healthy with current local configuration.'); return; }
    } catch { /* Wait for readiness. */ }
    await sleep(500);
  }
  throw new Error('Restarted API did not become healthy. Its process record was retained; inspect .local/api.log.');
}

try {
  const action = process.argv[2];
  if (action === 'check') await check();
  else if (action === 'backup') await backup();
  else if (action === 'start') await start();
  else if (action === 'stop') stop();
  else if (action === 'restart-api') await restartApi();
  else if (action === 'stripe') {
    launch('stripe', path.join(backend, 'scripts/stripe-listen.mjs'), [], backend);
    console.log('Stripe forwarder started. It saves its signing secret locally; see backend/.local/stripe.log for status. Restart API after it reports ready.');
  } else throw new Error('Usage: node scripts/local.mjs start|stop|check|backup|stripe|restart-api');
} catch (error) {
  console.error(error.message); process.exitCode = 1;
}
