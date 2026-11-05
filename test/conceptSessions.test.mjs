import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createConceptStore, CONCEPT_LIMIT_MESSAGE } from '../services/conceptSessions.mjs';
import createConceptExplanationRouter from '../routes/conceptExplanationRouter.mjs';

const identities = ['anonymous:test'];
const source = { type: 'input_image', image_url: 'data:image/png;base64,c3ludGhldGljLXF1ZXN0aW9u' };
const answer = 'The derivative is the instantaneous rate of change.';
const citation = { title: 'Calculus definition', url: 'https://example.edu/calculus' };

function setup(options = {}) {
  const store = createConceptStore(options);
  const contextId = store.registerResult({ owner: identities[0], source, answer, language: 'zh' });
  const channel = { identities, contextId, clientId: 'test-panel', revision: 1 };
  const begin = (extra = {}) => store.begin({ ...channel, selectedText: 'derivative', ...extra });
  return { store, contextId, channel, begin };
}

test('concept sessions pass the original question, full answer, selection and only their own history', () => {
  const { store, begin } = setup();
  const sessionId = begin();
  const first = store.reserve({ sessionId, identities, initial: true });
  assert.deepEqual(first.args.source, source);
  assert.equal(first.args.answer, answer);
  assert.equal(first.args.selectedText, 'derivative');
  assert.equal(first.args.language, 'zh');
  assert.equal(first.args.userId, identities[0]);
  assert.deepEqual(first.args.history, []);
  assert.equal(first.args.message, undefined);
  const result = store.complete(first, { text: 'A derivative is defined by a limit.', citations: [citation] });
  assert.equal(result.turnCount, 1);
  assert.deepEqual(result.messages[1].citations, [citation]);
  result.messages[1].content = 'Caller changed this snapshot';
  const followup = store.reserve({ sessionId, identities, message: 'What is a limit?' });
  assert.deepEqual(followup.args.source, source);
  assert.equal(followup.args.answer, answer);
  assert.equal(followup.args.message, 'What is a limit?');
  assert.deepEqual(followup.args.history, [
    { role: 'user', content: 'derivative' },
    { role: 'assistant', content: 'A derivative is defined by a limit.' },
  ]);
  store.release(followup);
  store.clear();
});

test('two completed turns are followed by the exact fixed message without another model reservation', () => {
  const { store, begin } = setup();
  const sessionId = begin();
  let calls = 0;
  const send = (message, initial = false) => {
    const ticket = store.reserve({ sessionId, identities, message, initial });
    if (ticket.snapshot) return ticket.snapshot;
    calls += 1;
    return store.complete(ticket, { text: `Explanation ${calls}`, citations: [] });
  };
  assert.equal(send(undefined, true).turnCount, 1);
  assert.equal(send('Explain the prerequisite.').turnCount, 2);
  for (const message of ['Third request', 'Fourth request']) {
    const result = send(message);
    assert.equal(result.message, '此功能并非通用chat bot，关键词解释只支持2轮对话，是否需要我帮你把刚才的上下文导出以便于你在其他chat bot中继续？');
    assert.equal(result.message, CONCEPT_LIMIT_MESSAGE);
    assert.equal(result.status, 'limited');
    assert.equal(result.turnCount, 2);
    assert.equal(result.messages.length, 4);
  }
  assert.equal(calls, 2);
  store.clear();
});

test('a gibberish refusal ends its session and cannot reserve a second explanation', () => {
  const { store, begin } = setup();
  const sessionId = begin({ selectedText: 'asjdfkkjxxx' });
  const ticket = store.reserve({ sessionId, identities, initial: true });
  const refusal = 'The selected text does not identify a meaningful concept in this question.';
  const result = store.complete(ticket, { text: refusal, refused: true });
  assert.equal(result.status, 'refused');
  const rejected = store.reserve({ sessionId, identities, message: 'Search for it anyway.' });
  assert.equal(rejected.snapshot.status, 'refused');
  assert.equal(rejected.snapshot.turnCount, 1);
  assert.equal(rejected.snapshot.message, refusal);
  assert.equal(rejected.args, undefined);
  store.clear();
});

test('a new selection immediately erases and aborts the prior session and rejects its late response', () => {
  const { store, begin } = setup();
  const oldId = begin();
  store.complete(store.reserve({ sessionId: oldId, identities, initial: true }), { text: 'Old explanation.' });
  const inFlight = store.reserve({ sessionId: oldId, identities, message: 'Old follow-up' });
  const newId = begin({ revision: 2, selectedText: 'rate of change' });
  assert.equal(inFlight.controller.signal.aborted, true);
  assert.equal(inFlight.session.selectedText, '');
  assert.deepEqual(inFlight.session.messages, []);
  assert.throws(() => store.exportContext(oldId, identities), { code: 'CONCEPT_SESSION_EXPIRED' });
  assert.throws(() => store.complete(inFlight, { text: 'Late old answer.' }), { code: 'CONCEPT_STALE_REQUEST' });
  const fresh = store.reserve({ sessionId: newId, identities, initial: true });
  assert.deepEqual(fresh.args.history, []);
  assert.deepEqual(fresh.args.source, source);
  assert.equal(fresh.args.answer, answer);
  assert.equal(fresh.args.selectedText, 'rate of change');
  store.release(inFlight);
  store.release(fresh);
  store.clear();
});

test('channel revisions reject out-of-order starts and retain deletion tombstones', () => {
  const { store, channel, begin } = setup();
  const sessionId = begin({ revision: 3 });
  for (const revision of [1, 2, 3]) {
    assert.throws(() => begin({ revision }), { code: 'CONCEPT_STALE_REQUEST' });
  }
  store.closeChannel({ ...channel, revision: 5 });
  assert.throws(() => store.exportContext(sessionId, identities), { code: 'CONCEPT_SESSION_EXPIRED' });
  for (const revision of [3, 4, 5]) {
    assert.throws(() => begin({ revision }), { code: 'CONCEPT_STALE_REQUEST' });
  }
  const nextId = begin({ revision: 6 });
  assert.ok(store.exportContext(nextId, identities).markdown.includes('derivative'));
  assert.throws(() => store.closeChannel({ ...channel, revision: 4 }), { code: 'CONCEPT_STALE_REQUEST' });
  assert.ok(store.exportContext(nextId, identities));
  store.clear();
});

test('concurrent follow-ups are serialized and failed requests can be retried without consuming a turn', () => {
  const { store, begin } = setup();
  const sessionId = begin();
  store.complete(store.reserve({ sessionId, identities, initial: true }), { text: 'First explanation.' });
  const pending = store.reserve({ sessionId, identities, message: 'Follow-up A' });
  assert.throws(() => store.reserve({ sessionId, identities, message: 'Follow-up B' }), { code: 'CONCEPT_BUSY' });
  store.release(pending);
  assert.equal(pending.controller.signal.aborted, true);
  const retry = store.reserve({ sessionId, identities, message: 'Follow-up retry' });
  const result = store.complete(retry, { text: 'Second explanation.' });
  assert.equal(result.turnCount, 2);
  assert.deepEqual(result.messages.filter(m => m.role === 'user').map(m => m.content), ['derivative', 'Follow-up retry']);
  store.clear();
});

test('owners cannot read, replace, export or close each other’s question or explanation context', () => {
  const { store, channel, begin } = setup();
  const sessionId = begin();
  const intruder = ['anonymous:other'];
  for (const action of [
    () => begin({ identities: intruder, revision: 2 }),
    () => store.reserve({ sessionId, identities: intruder, message: 'Explain' }),
    () => store.exportContext(sessionId, intruder),
    () => store.closeChannel({ ...channel, identities: intruder, revision: 2 }),
  ]) assert.throws(action, { code: 'CONCEPT_CONTEXT_EXPIRED' });
  assert.ok(store.exportContext(sessionId, identities));
  store.clear();
});

test('TTL expiry and capacity eviction erase sessions and abort work, while oversized contexts are rejected', () => {
  let time = 100;
  const { store, begin, contextId } = setup({ now: () => time, ttlMs: 10, maxContexts: 1 });
  const sessionId = begin();
  const pending = store.reserve({ sessionId, identities, initial: true });
  time = 110;
  store.sweep();
  assert.equal(pending.controller.signal.aborted, true);
  assert.throws(() => store.exportContext(sessionId, identities), { code: 'CONCEPT_SESSION_EXPIRED' });
  assert.throws(() => begin({ contextId, revision: 2 }), { code: 'CONCEPT_CONTEXT_EXPIRED' });
  const firstId = store.registerResult({ owner: identities[0], source, answer });
  const firstSession = store.begin({ contextId: firstId, identities, clientId: 'panel', revision: 1, selectedText: 'first' });
  const firstTicket = store.reserve({ sessionId: firstSession, identities, initial: true });
  const secondId = store.registerResult({ owner: identities[0], source, answer: 'Next answer' });
  assert.ok(secondId);
  assert.equal(firstTicket.controller.signal.aborted, true);
  assert.throws(() => store.exportContext(firstSession, identities), { code: 'CONCEPT_SESSION_EXPIRED' });
  assert.equal(createConceptStore({ maxBytes: 1 }).registerResult({ owner: identities[0], source, answer }), null);
  store.clear();
});

test('context exports retain source, answer, chosen concept, dialogue and citations without reserving a turn', () => {
  const { store, begin } = setup();
  const sessionId = begin();
  store.complete(store.reserve({ sessionId, identities, initial: true }), { text: 'Definition from calculus.', citations: [citation] });
  for (let index = 0; index < 3; index += 1) {
    const result = store.exportContext(sessionId, identities);
    assert.equal(result.filename, 'concept-explanation.md');
    for (const expected of [source.image_url, answer, 'derivative', 'Definition from calculus.', citation.url]) {
      assert.ok(result.markdown.includes(expected));
    }
  }
  const second = store.reserve({ sessionId, identities, message: 'Still allowed after exports?' });
  assert.equal(second.session.turnCount, 1);
  store.release(second);
  store.clear();
});

async function serve(t, { store, explain, limiter = (_req, _res, next) => next() }) {
  const app = express();
  app.use(express.json());
  app.use('/api/concept-explanations', createConceptExplanationRouter({ store, explainer: { explain }, limiter }));
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ message: error.message, code: error.code }));
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  t.after(() => new Promise(resolve => {
    store.clear();
    server.close(resolve);
    server.closeAllConnections();
  }));
  const base = `http://127.0.0.1:${server.address().port}/api/concept-explanations`;
  return async (path, { method = 'GET', body } = {}) => {
    const response = await fetch(base + path, { method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, headers: response.headers,
      body: response.status === 204 ? null : await response.json() };
  };
}

const startBody = (contextId, extra = {}) => ({ contextId, clientId: 'http-panel', revision: 1,
  selectedText: 'derivative', anonymousId: 'test', ...extra });

test('HTTP lifecycle enforces two turns and exports full context without additional model or limiter calls', async t => {
  const { store, contextId } = setup();
  const calls = [];
  let limitCalls = 0;
  const request = await serve(t, { store,
    explain: async args => { calls.push(args); return { text: `Explanation ${calls.length}`, citations: [citation] }; },
    limiter: (_req, _res, next) => { limitCalls += 1; next(); },
  });
  const first = await request('/start', { method: 'POST', body: startBody(contextId) });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  assert.equal(first.body.turnCount, 1);
  const id = first.body.sessionId;
  assert.deepEqual(calls[0].source, source);
  assert.equal(calls[0].answer, answer);
  const second = await request(`/${id}/messages`, { method: 'POST', body: { anonymousId: 'test', message: 'Explain the limit.' } });
  assert.equal(second.status, 200);
  assert.equal(second.body.turnCount, 2);
  assert.equal(calls[1].history.length, 2);
  assert.equal(calls[1].message, 'Explain the limit.');
  const third = await request(`/${id}/messages`, { method: 'POST', body: { anonymousId: 'test', message: 'Keep chatting.' } });
  assert.equal(third.status, 200);
  assert.equal(third.body.status, 'limited');
  assert.equal(third.body.message, CONCEPT_LIMIT_MESSAGE);
  const exported = await request(`/${id}/export?anonymousId=test`);
  assert.equal(exported.status, 200);
  assert.equal(exported.headers.get('cache-control'), 'no-store');
  for (const content of [source.image_url, answer, 'Explain the limit.', 'Explanation 2', citation.url]) {
    assert.ok(exported.body.markdown.includes(content));
  }
  assert.equal(calls.length, 2);
  assert.equal(limitCalls, 2);
});

test('HTTP refuses all follow-ups after a gibberish refusal without calling the model or limiter again', async t => {
  const { store, contextId } = setup();
  let calls = 0;
  let limitCalls = 0;
  const refusal = 'This selection is not meaningful in the supplied question.';
  const request = await serve(t, { store,
    explain: async () => { calls += 1; return { text: refusal, refused: true }; },
    limiter: (_req, _res, next) => { limitCalls += 1; next(); },
  });
  const started = await request('/start', { method: 'POST', body: startBody(contextId, { selectedText: 'jxksjdfks' }) });
  assert.equal(started.body.status, 'refused');
  const followup = await request(`/${started.body.sessionId}/messages`, { method: 'POST', body: { anonymousId: 'test', message: 'Please search anyway.' } });
  assert.equal(followup.status, 200);
  assert.equal(followup.body.status, 'refused');
  assert.equal(followup.body.message, refusal);
  assert.equal(followup.body.turnCount, 1);
  assert.equal(calls, 1);
  assert.equal(limitCalls, 1);
});

test('HTTP replacement deletes an in-flight old session before the next model result and DELETE prevents late starts', async t => {
  const { store, contextId } = setup();
  let finishOld;
  let reachedOld;
  const oldStarted = new Promise(resolve => { reachedOld = resolve; });
  const oldResult = new Promise(resolve => { finishOld = resolve; });
  const calls = [];
  const request = await serve(t, { store, explain: async args => {
    calls.push(args);
    if (calls.length === 2) { reachedOld(); return oldResult; }
    return { text: `Fresh explanation ${calls.length}` };
  } });
  const first = await request('/start', { method: 'POST', body: startBody(contextId) });
  const oldId = first.body.sessionId;
  const pending = request(`/${oldId}/messages`, { method: 'POST', body: { anonymousId: 'test', message: 'Old follow-up' } });
  await oldStarted;
  const second = await request('/start', { method: 'POST', body: startBody(contextId, { revision: 2, selectedText: 'rate of change' }) });
  assert.equal(second.status, 200);
  assert.equal(calls[1].signal.aborted, true);
  assert.deepEqual(calls[2].history, []);
  assert.equal(calls[2].selectedText, 'rate of change');
  assert.deepEqual(calls[2].source, source);
  assert.equal((await request(`/${oldId}/export?anonymousId=test`)).status, 404);
  finishOld({ text: 'The delayed old answer must be discarded.' });
  const stale = await pending;
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'CONCEPT_STALE_REQUEST');
  const currentExport = await request(`/${second.body.sessionId}/export?anonymousId=test`);
  assert.ok(!currentExport.body.markdown.includes('delayed old answer'));
  const deletion = await request('/channel', { method: 'DELETE', body: startBody(contextId, { revision: 4 }) });
  assert.equal(deletion.status, 204);
  assert.equal((await request(`/${second.body.sessionId}/export?anonymousId=test`)).status, 404);
  const lateStart = await request('/start', { method: 'POST', body: startBody(contextId, { revision: 3 }) });
  assert.equal(lateStart.status, 409);
  assert.equal(lateStart.body.code, 'CONCEPT_STALE_REQUEST');
  assert.equal(calls.length, 3);
  assert.equal((await request('/start', { method: 'POST', body: startBody(contextId, { revision: 5 }) })).status, 200);
});

test('HTTP concurrent follow-ups yield one second turn, while owner isolation and missing identity prevent model calls', async t => {
  const { store, contextId } = setup();
  let finish;
  let reached;
  const started = new Promise(resolve => { reached = resolve; });
  const pendingResult = new Promise(resolve => { finish = resolve; });
  let calls = 0;
  const request = await serve(t, { store, explain: async () => {
    calls += 1;
    if (calls === 2) { reached(); return pendingResult; }
    return { text: 'First explanation.' };
  } });
  const first = await request('/start', { method: 'POST', body: startBody(contextId) });
  const id = first.body.sessionId;
  const noIdentity = await request('/start', { method: 'POST', body: startBody(contextId, { anonymousId: undefined, revision: 2 }) });
  assert.equal(noIdentity.status, 400);
  assert.equal(noIdentity.body.code, 'MISSING_IDENTITY');
  for (const [path, options] of [
    ['/start', { method: 'POST', body: startBody(contextId, { anonymousId: 'other', revision: 2 }) }],
    [`/${id}/messages`, { method: 'POST', body: { anonymousId: 'other', message: 'Intrusion' } }],
    [`/${id}/export?anonymousId=other`, {}],
    ['/channel', { method: 'DELETE', body: startBody(contextId, { anonymousId: 'other', revision: 2 }) }],
  ]) assert.equal((await request(path, options)).status, 404);
  assert.equal(calls, 1);
  const pending = request(`/${id}/messages`, { method: 'POST', body: { anonymousId: 'test', message: 'First concurrent follow-up' } });
  await started;
  const duplicate = await request(`/${id}/messages`, { method: 'POST', body: { anonymousId: 'test', message: 'Second concurrent follow-up' } });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.code, 'CONCEPT_BUSY');
  finish({ text: 'One completed follow-up.' });
  assert.equal((await pending).body.turnCount, 2);
  assert.equal(calls, 2);
});

test('HTTP rate-limit rejection releases its turn reservation and still deletes the replaced session immediately', async t => {
  const { store, contextId } = setup();
  let limited = false;
  let calls = 0;
  const request = await serve(t, { store,
    explain: async () => { calls += 1; return { text: 'Explanation.' }; },
    limiter: (_req, res, next) => limited ? res.status(429).json({ code: 'AI_RATE_LIMITED' }) : next(),
  });
  const first = await request('/start', { method: 'POST', body: startBody(contextId) });
  const id = first.body.sessionId;
  limited = true;
  assert.equal((await request(`/${id}/messages`, { method: 'POST', body: { anonymousId: 'test', message: 'Retry later.' } })).status, 429);
  limited = false;
  assert.equal((await request(`/${id}/messages`, { method: 'POST', body: { anonymousId: 'test', message: 'Retry now.' } })).body.turnCount, 2);
  limited = true;
  const replacement = await request('/start', { method: 'POST', body: startBody(contextId, { revision: 2 }) });
  assert.equal(replacement.status, 429);
  assert.equal((await request(`/${id}/export?anonymousId=test`)).status, 404);
  assert.equal(calls, 2);
});
