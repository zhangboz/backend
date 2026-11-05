import test from 'node:test';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { PostgresSessionStore } from '../services/postgresSessionStore.mjs';
import { createEmailService } from '../services/emailService.mjs';
import { createRegistrationService } from '../services/registrationService.mjs';

const silent = { info() {}, error() {} };
const logs = () => {
  const values = [];
  return { values, info: value => values.push(value), error: value => values.push(value) };
};
const productionEmail = { NODE_ENV: 'production', EMAIL_PROVIDER: 'resend',
  BACKEND_URL: 'https://api.example.test', MAIL_FROM: 'Synapse <no-reply@example.test>',
  RESEND_API_KEY: 'synthetic-resend-credential' };

class SessionDatabase {
  constructor() { this.rows = new Map(); this.queries = []; }
  async query(sql, values = []) {
    this.queries.push({ sql, values });
    if (sql.startsWith('SELECT sess')) {
      const value = this.rows.get(values[0]);
      return { rows: value && value.expires > +values[1] ? [{ sess: structuredClone(value.sess) }] : [] };
    }
    if (sql.startsWith('INSERT')) this.rows.set(values[0], { sess: JSON.parse(values[1]), expires: +values[2] });
    if (sql.startsWith('UPDATE')) {
      const value = this.rows.get(values[0]);
      if (value && value.expires > +values[2]) value.expires = +values[1];
    }
    if (sql.startsWith('DELETE') && sql.includes('WHERE sid')) this.rows.delete(values[0]);
    if (sql.startsWith('DELETE') && sql.includes('WHERE expires_at')) {
      for (const [key, value] of this.rows) if (value.expires <= +values[0]) this.rows.delete(key);
    }
    return { rows: [] };
  }
}

const callStore = (store, method, ...args) => promisify(store[method]).call(store, ...args);

test('Postgres OAuth expiry caps long cookies and touch cannot revive expired state', async () => {
  let now = 1_800_000_000_000;
  const database = new SessionDatabase();
  const store = new PostgresSessionStore({ database, now: () => now, logger: silent });
  const state = { cookie: { expires: new Date(now + 86_400_000).toISOString() }, oauthState: 'state-one' };
  await callStore(store, 'set', 'sid-one', state);
  assert.equal(database.rows.get('sid-one').expires, now + 600_000);
  assert.deepEqual(await callStore(store, 'get', 'sid-one'), state);
  const writesBeforeRead = database.queries.filter(item => item.sql.startsWith('DELETE')).length;
  await callStore(store, 'get', 'unknown');
  assert.equal(database.queries.filter(item => item.sql.startsWith('DELETE')).length, writesBeforeRead);
  now += 601_000;
  await callStore(store, 'touch', 'sid-one', state);
  assert.equal(await callStore(store, 'get', 'sid-one'), null);
  assert.equal(database.rows.has('sid-one'), false);
  await callStore(store, 'set', 'sid-two', { cookie: {}, oauthState: 'state-two' });
  await callStore(store, 'destroy', 'sid-two');
  assert.equal(await callStore(store, 'get', 'sid-two'), null);
});

test('Postgres store errors fail closed without exposing database diagnostics or session contents', async () => {
  const logger = logs();
  const store = new PostgresSessionStore({
    database: { async query() { throw new Error('database-password-and-session-secret'); } }, logger,
  });
  await assert.rejects(callStore(store, 'get', 'private-session-id'), error => {
    assert.equal(error.code, 'OAUTH_SESSION_UNAVAILABLE');
    assert.equal(error.statusCode, 503);
    assert.doesNotMatch(error.message, /database-password|private-session/);
    return true;
  });
  assert.equal(await store.healthy(), false);
  assert.doesNotMatch(JSON.stringify(logger.values), /database-password|private-session/);
});

test('Resend sends an HTTPS confirmation with encoded token and stable private idempotency key', async () => {
  const calls = [];
  const logger = logs();
  const service = createEmailService({ environment: productionEmail, logger,
    fetchImpl: async (url, options) => { calls.push({ url, options }); return Response.json({ id: 'synthetic-id' }); },
  });
  service.assertConfigured();
  const token = 'synthetic-token/with?characters';
  await service.sendConfirmationEmail('student@example.test', token);
  await service.sendConfirmationEmail('student@example.test', token);
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  const options = calls[0].options;
  assert.equal(options.method, 'POST');
  assert.equal(options.headers.Authorization, 'Bearer synthetic-resend-credential');
  assert.ok(options.headers['User-Agent']);
  assert.match(options.headers['Idempotency-Key'], /^confirm-[a-f0-9]{64}$/);
  assert.equal(options.headers['Idempotency-Key'], calls[1].options.headers['Idempotency-Key']);
  const payload = JSON.parse(options.body);
  assert.deepEqual(payload.to, ['student@example.test']);
  assert.ok(payload.html.includes(encodeURIComponent(token)));
  assert.ok(options.signal instanceof AbortSignal);
  assert.doesNotMatch(JSON.stringify(logger.values), /student@|synthetic-token|synthetic-resend/);
});

test('production mail fails before network access when not configured or SMTP is selected', async () => {
  let calls = 0;
  for (const environment of [
    { ...productionEmail, RESEND_API_KEY: '' }, { ...productionEmail, MAIL_FROM: '' },
    { ...productionEmail, EMAIL_PROVIDER: 'smtp', MAIL_USER: 'synthetic', MAIL_PASS: 'synthetic' },
    { ...productionEmail, BACKEND_URL: 'http://api.example.test' },
  ]) {
    const service = createEmailService({ environment, logger: silent, fetchImpl: async () => { calls++; } });
    assert.throws(() => service.assertConfigured(), error => error.code.startsWith('EMAIL_'));
    await assert.rejects(service.sendConfirmationEmail('student@example.test', 'synthetic-token'), error => error.statusCode === 503);
  }
  assert.equal(calls, 0);
});

test('Resend rate-limit and timeout are sanitized and do not log provider bodies', async () => {
  for (const status of [429, 403, 500]) {
    const logger = logs();
    const service = createEmailService({ environment: productionEmail, logger,
      fetchImpl: async () => new Response('provider-secret-and-recipient@example.test', { status }),
    });
    await assert.rejects(service.sendConfirmationEmail('student@example.test', 'token'), error => {
      assert.equal(error.code, status === 429 ? 'EMAIL_RATE_LIMITED' : status === 403 ? 'EMAIL_PROVIDER_REJECTED' : 'EMAIL_UNAVAILABLE');
      assert.doesNotMatch(error.message, /provider-secret|recipient@/);
      return true;
    });
    assert.doesNotMatch(JSON.stringify(logger.values), /provider-secret|student@|recipient@/);
  }
  const service = createEmailService({ environment: { ...productionEmail, EMAIL_TIMEOUT_MS: '1' }, logger: silent,
    fetchImpl: (_url, { signal }) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('test timeout did not abort')), 100);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    }),
  });
  await assert.rejects(service.sendConfirmationEmail('student@example.test', 'token'), error => error.code === 'EMAIL_TIMEOUT');
});

test('local SMTP remains available through the injected transport', async () => {
  let options;
  let sent;
  const service = createEmailService({ environment: { NODE_ENV: 'development', MAIL_USER: 'local@example.test', MAIL_PASS: 'synthetic-local-password' },
    logger: silent, createTransport: config => { options = config; return { async sendMail(message) { sent = message; } }; },
  });
  await service.sendConfirmationEmail('student@example.test', 'token');
  assert.equal(options.service, 'gmail');
  assert.ok(options.socketTimeout > 0);
  assert.match(sent.html, /http:\/\/localhost:5000\/api\/login\/confirm-email\/token/);
});

class UserDatabase {
  constructor(record = null) { this.record = record; this.queries = []; }
  async query(sql, values = []) {
    this.queries.push(sql);
    if (sql.startsWith('SELECT')) return { rows: this.record ? [structuredClone(this.record)] : [] };
    if (sql.startsWith('INSERT')) this.record = { user_id: 42, email: values[0], password: values[1],
      email_confirmation_token: values[2], email_confirmation_expires: values[3], is_email_confirmed: false, google_id: null };
    if (sql.startsWith('UPDATE')) {
      if (this.record.is_email_confirmed || this.record.google_id || this.record.password !== values[3]) return { rows: [] };
      this.record.email_confirmation_token = values[0];
      this.record.email_confirmation_expires = values[1];
      return { rows: [{ user_id: this.record.user_id }] };
    }
    return { rows: [] };
  }
}

function registration(database, overrides = {}) {
  return createRegistrationService({ database, emailService: { assertConfigured() {}, async sendConfirmationEmail() {} },
    hashPassword: async value => 'hash-' + value, comparePassword: async (value, hash) => hash === 'hash-' + value,
    newToken: () => 'synthetic-confirmation-token', now: () => 1_800_000_000_000, ...overrides });
}
const credentials = { email: 'student@example.test', password: 'synthetic-password' };

test('missing email configuration creates no pending account', async () => {
  const database = new UserDatabase();
  const service = registration(database, { emailService: {
    assertConfigured() { throw Object.assign(new Error('not configured'), { code: 'EMAIL_NOT_CONFIGURED' }); },
  } });
  await assert.rejects(service.register(credentials), error => error.code === 'EMAIL_NOT_CONFIGURED');
  assert.equal(database.queries.length, 0);
});

test('failed delivery preserves the pending account and permits same-password retry using the same token', async () => {
  const database = new UserDatabase();
  let attempts = 0;
  const tokens = [];
  const service = registration(database, { emailService: { assertConfigured() {},
    async sendConfirmationEmail(_email, token) { tokens.push(token); if (++attempts === 1) throw new Error('provider failed'); },
  } });
  await assert.rejects(service.register(credentials), error => error.code === 'CONFIRMATION_DELIVERY_FAILED');
  const firstRecord = structuredClone(database.record);
  assert.ok(firstRecord.password);
  const result = await service.register(credentials);
  assert.equal(result.status, 200);
  assert.deepEqual(tokens, ['synthetic-confirmation-token', 'synthetic-confirmation-token']);
  assert.deepEqual(database.record, firstRecord);
  assert.equal(database.queries.filter(sql => sql.startsWith('INSERT')).length, 1);
  assert.equal(database.queries.some(sql => sql.startsWith('DELETE')), false);
});

test('expired pending account gets a new confirmation token while historical fields stay intact', async () => {
  const record = { user_id: 1, email: credentials.email, password: 'hash-' + credentials.password,
    google_id: null, is_email_confirmed: false, nickname: 'Existing student',
    email_confirmation_token: 'expired', email_confirmation_expires: '2025-01-01T00:00:00Z' };
  const database = new UserDatabase(structuredClone(record));
  assert.equal((await registration(database).register(credentials)).status, 200);
  assert.equal(database.record.email_confirmation_token, 'synthetic-confirmation-token');
  assert.equal(database.record.user_id, record.user_id);
  assert.equal(database.record.password, record.password);
  assert.equal(database.record.nickname, record.nickname);
  assert.equal(database.queries.some(sql => sql.startsWith('DELETE')), false);
});

test('Google, confirmed and wrong-password pending accounts cannot be replaced by registration', async () => {
  for (const fields of [{ google_id: 'existing-google-account' }, { is_email_confirmed: true }, { password: 'different-hash' }]) {
    const record = { user_id: 1, email: credentials.email, password: 'hash-' + credentials.password,
      google_id: null, is_email_confirmed: false, email_confirmation_expires: '2025-01-01T00:00:00Z', ...fields };
    const database = new UserDatabase(structuredClone(record));
    await assert.rejects(registration(database).register(credentials), error => error.statusCode === 409);
    assert.deepEqual(database.record, record);
    assert.equal(database.queries.every(sql => sql.startsWith('SELECT')), true);
  }
});


test('malformed registration is rejected before reading or writing the database', async () => {
  const database = new UserDatabase();
  const service = registration(database);
  for (const input of [null, undefined, {}, { email: [], password: credentials.password }]) {
    await assert.rejects(service.register(input), error => error.statusCode === 400);
  }
  assert.equal(database.queries.length, 0);
});
