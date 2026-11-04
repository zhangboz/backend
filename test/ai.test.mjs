import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import express from 'express';
import multer from 'multer';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHomeworkService, fileInput } from '../AI_ChatBot/OpenAI_Agent.mjs';
import { answerPrompts, explanationPrompts, transcriptionPrompt } from '../AI_ChatBot/prompts.mjs';
import { AIError, safeAIError } from '../AI_ChatBot/openaiClient.mjs';
import { createSpeechService, pcmToWav } from '../AI_ChatBot/text_speech.mjs';
import { createAILimiter } from '../middleware/aiLimits.mjs';
import createProcessHomeworkRouter from '../routes/processHomeworkRouter.mjs';

const quiet = { info() {}, warn() {} };
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const completed = text => ({ status: 'completed', output_text: text });

test('EN/ZH two-step calls preserve prompts, use Terra and pass only the answer into step two', async () => {
  for (const language of ['en', 'zh']) {
    const calls = [];
    const answer = '$x=2$ is the answer. $& must stay literal.';
    const client = { responses: { create: async (body, options) => {
      calls.push({ body, options });
      return completed(calls.length === 1 ? answer : 'Subtract three, then divide by two.');
    } } };
    const service = createHomeworkService({ client, read: async () => png, logger: quiet });
    const result = await service.imageUnderstand('unused', 'image/png', 'anonymous:example', language);
    assert.equal(result.text1, answer);
    assert.equal(result.text2, 'Subtract three, then divide by two.');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].body.instructions, answerPrompts[language]);
    assert.equal(calls[1].body.instructions, explanationPrompts[language].replace('{image_answer}', () => answer));
    assert.equal(calls[0].body.input[0].content[0].type, 'input_image');
    assert.equal(typeof calls[1].body.input, 'string');
    assert.deepEqual(calls.map(c => c.body.reasoning.effort), ['medium', 'low']);
    for (const call of calls) {
      assert.equal(call.body.model, 'gpt-6.1-terra');
      assert.equal(call.body.store, false);
      assert.equal(call.options.maxRetries, 0);
      assert.match(call.body.safety_identifier, /^[a-f0-9]{64}$/);
      assert.ok(!call.body.safety_identifier.includes('example'));
    }
  }
});

test('PDF transcription is one call with inline file and the preserved prompt', async () => {
  const calls = [];
  const service = createHomeworkService({
    client: { responses: { create: async body => { calls.push(body); return completed('# Notes'); } } },
    read: async () => Buffer.from('%PDF-1.4 synthetic'), logger: quiet,
  });
  assert.deepEqual(await service.handWrittenToMarkdown('unused', 'application/pdf', 'user:1'), { text1: '# Notes' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].instructions, transcriptionPrompt);
  assert.equal(calls[0].reasoning.effort, 'low');
  assert.equal(calls[0].input[0].content[0].type, 'input_file');
  assert.equal(calls[0].input[0].content[0].filename, 'upload.pdf');
  assert.match(calls[0].input[0].content[0].file_data, /^data:application\/pdf;base64,/);
});

test('step-two failure keeps the paid-for answer and supplies a localized warning', async () => {
  let calls = 0;
  const service = createHomeworkService({
    client: { responses: { create: async () => { if (++calls === 2) throw { status: 429 }; return completed('答案'); } } },
    read: async () => png, logger: quiet,
  });
  const result = await service.imageUnderstand('unused', 'image/png', 'user:1', 'zh');
  assert.equal(result.text1, '答案');
  assert.equal(result.text2, null);
  assert.match(result.warning, /暂不可用/);
});

test('empty/incomplete first outputs fail; structured refusal is returned without a second call', async () => {
  for (const response of [completed(' '), { status: 'incomplete', output_text: 'partial' }]) {
    let calls = 0;
    const service = createHomeworkService({ client: { responses: { create: async () => { calls++; return response; } } }, read: async () => png, logger: quiet });
    await assert.rejects(service.imageUnderstand('unused', 'image/png', 'user:1'), { statusCode: 502 });
    assert.equal(calls, 1);
  }
  let calls = 0;
  const service = createHomeworkService({ client: { responses: { create: async () => {
    calls++; return { status: 'completed', output: [{ content: [{ type: 'refusal', refusal: 'I cannot help with this.' }] }] };
  } } }, read: async () => png, logger: quiet });
  assert.deepEqual(await service.imageUnderstand('unused', 'image/png', 'user:1'), { text1: 'I cannot help with this.', text2: null });
  assert.equal(calls, 1);
});

test('invalid MIME, signature, size, language, and identity never call OpenAI', async () => {
  const service = createHomeworkService({ client: { responses: { create: () => assert.fail('should not call') } }, read: async () => png, logger: quiet });
  await assert.rejects(service.imageUnderstand('unused', 'image/png', '', 'en'), { code: 'MISSING_IDENTITY' });
  await assert.rejects(service.imageUnderstand('unused', 'image/png', 'user:1', 'constructor'), { code: 'INVALID_LANGUAGE' });
  assert.throws(() => fileInput(png, 'text/plain'), { code: 'INVALID_FILE_TYPE' });
  assert.throws(() => fileInput(Buffer.from('fake'), 'image/png'), { code: 'INVALID_FILE_CONTENT' });
  assert.throws(() => fileInput(Buffer.alloc(10 * 1024 * 1024 + 1), 'image/png'), { code: 'INVALID_FILE_SIZE' });
});

test('upstream errors are mapped without leaking upstream secret-bearing messages', () => {
  for (const [raw, status, code] of [
    [{ status: 429, code: 'credit_balance_exhausted' }, 429, 'AI_CREDIT_EXHAUSTED'],
    [{ status: 429 }, 429, 'AI_RATE_LIMITED'],
    [{ status: 401 }, 503, 'AI_ACCESS_UNAVAILABLE'],
    [{ name: 'APIConnectionTimeoutError' }, 504, 'AI_TIMEOUT'],
    [{ name: 'AbortError' }, 499, 'AI_CANCELED'],
    [{ status: 500 }, 502, 'AI_UPSTREAM_ERROR'],
  ]) {
    const safe = safeAIError({ ...raw, message: 'sensitive-upload-or-key' });
    assert.equal(safe.statusCode, status);
    assert.equal(safe.code, code);
    assert.ok(!safe.message.includes('sensitive'));
  }
});

function fakeSockets({ mode = 'success', frames = [Buffer.from([1, 2, 3, 4])] } = {}) {
  const sockets = [];
  const factory = () => {
    const socket = new EventEmitter();
    socket.sent = [];
    socket.terminated = false;
    socket.terminate = () => { socket.terminated = true; };
    socket.send = raw => {
      const event = JSON.parse(raw);
      socket.sent.push(event);
      if (event.type === 'session.update' && mode !== 'timeout') {
        queueMicrotask(() => socket.emit('message', Buffer.from(JSON.stringify({ type: 'session.updated' }))));
      }
      if (event.type === 'response.create') queueMicrotask(() => {
        const emit = value => socket.emit('message', Buffer.from(JSON.stringify(value)));
        if (mode === 'disconnect') return socket.emit('close');
        if (mode === 'quota') return emit({ type: 'error', error: { code: 'credit_balance_exhausted', message: 'private' } });
        if (mode !== 'empty') for (const frame of frames) emit({ type: 'response.output_audio.delta', delta: frame.toString('base64') });
        emit({ type: 'response.done', response: { status: mode === 'incomplete' ? 'incomplete' : 'completed' } });
      });
    };
    sockets.push(socket);
    queueMicrotask(() => socket.emit('open'));
    return socket;
  };
  return { factory, sockets };
}

test('speech produces a correct WAV, normalizes blank voice, and caches by text and voice', async () => {
  const fake = fakeSockets();
  const service = createSpeechService({ socketFactory: fake.factory, apiKey: () => 'fake', logger: quiet });
  const result = await service.generate('Hello. 你好。', '');
  assert.equal(result.buffer.toString('ascii', 0, 4), 'RIFF');
  assert.equal(result.buffer.toString('ascii', 8, 12), 'WAVE');
  assert.equal(result.buffer.readUInt32LE(24), 24000);
  assert.equal(result.buffer.readUInt16LE(22), 1);
  assert.equal(result.buffer.readUInt16LE(34), 16);
  assert.equal(result.buffer.readUInt32LE(40), 4);
  assert.equal(fake.sockets[0].sent[0].session.audio.output.voice, 'marin');
  assert.equal(fake.sockets[0].sent[0].session.model, 'gpt-realtime-2.1-mini');
  assert.equal(fake.sockets[0].sent[0].session.max_output_tokens, 'inf');
  assert.ok(fake.sockets[0].terminated);
  assert.equal((await service.generate('Hello. 你好。', '')).cacheHit, true);
  assert.equal(fake.sockets.length, 1);
  await service.generate('Hello. 你好。', 'cedar');
  await service.generate('Different.', 'marin');
  assert.equal(fake.sockets.length, 3);
});

test('speech rejects incomplete, empty, disconnected, oversized, expired and canceled work safely', async () => {
  for (const [mode, code] of [['incomplete', 'AI_INCOMPLETE'], ['empty', 'AI_EMPTY_AUDIO'], ['disconnect', 'AI_DISCONNECTED'], ['quota', 'AI_CREDIT_EXHAUSTED'], ['timeout', 'AI_TIMEOUT']]) {
    const fake = fakeSockets({ mode });
    const service = createSpeechService({ socketFactory: fake.factory, apiKey: () => 'fake', logger: quiet, timeoutMs: 10 });
    await assert.rejects(service.generate('Hello'), { code });
    assert.ok(fake.sockets[0].terminated);
  }
  const fake = fakeSockets();
  const service = createSpeechService({ socketFactory: fake.factory, apiKey: () => 'fake', logger: quiet, maxAudioBytes: 2 });
  await assert.rejects(service.generate('Hello'), { code: 'AI_AUDIO_TOO_LARGE' });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(service.generate('Hello', '', { signal: controller.signal }), { code: 'AI_CANCELED' });
  assert.equal(fake.sockets.length, 1);
});

test('speech cache expires; invalid input and odd PCM are rejected', async () => {
  let now = 0;
  const fake = fakeSockets();
  const service = createSpeechService({ socketFactory: fake.factory, apiKey: () => 'fake', logger: quiet, now: () => now, cacheTtlMs: 10 });
  await service.generate('Hello');
  now = 11;
  await service.generate('Hello');
  assert.equal(fake.sockets.length, 2);
  await assert.rejects(service.generate(''), { statusCode: 400 });
  await assert.rejects(service.generate('a'.repeat(6001)), { code: 'SPEECH_TEXT_TOO_LONG' });
  await assert.rejects(service.generate('Hello', 'Kore'), { code: 'INVALID_VOICE' });
  assert.throws(() => pcmToWav(Buffer.from([1])), { code: 'AI_INVALID_AUDIO' });
});

test('limiter enforces concurrency and IP rate limits, releases only once, and resets windows', () => {
  let now = 0;
  const limit = createAILimiter({ maxConcurrent: 1, maxPerMinute: 2, windowMs: 1000, now: () => now });
  const response = () => {
    const res = new EventEmitter();
    res.setHeader = () => {};
    res.status = code => { res.statusCode = code; return res; };
    res.json = body => { res.body = body; return res; };
    return res;
  };
  let passed = 0;
  const first = response();
  limit({ ip: '127.0.0.1' }, first, () => passed++);
  const busy = response();
  limit({ ip: 'other' }, busy, () => passed++);
  assert.equal(busy.body.code, 'AI_BUSY');
  first.emit('finish'); first.emit('close');
  const second = response();
  limit({ ip: '127.0.0.1' }, second, () => passed++);
  second.emit('close');
  const excess = response();
  limit({ ip: '127.0.0.1' }, excess, () => passed++);
  assert.equal(excess.body.code, 'AI_RATE_LIMITED');
  now = 1001;
  const reset = response();
  limit({ ip: '127.0.0.1' }, reset, () => passed++);
  assert.equal(passed, 3);
  reset.emit('finish');
});

test('HTTP upload routes preserve JSON contracts and clean files on success and identity errors', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'homework-ai-route-'));
  const calls = [];
  const service = {
    imageUnderstand: async (...args) => { calls.push(args); return { text1: 'Answer', text2: null, warning: 'Explanation unavailable' }; },
    handWrittenToMarkdown: async (...args) => { calls.push(args); return { text1: '# Notes' }; },
  };
  const app = express();
  app.use('/api/process-homework', createProcessHomeworkRouter(directory, service));
  app.use((error, _req, res, _next) => res.status(error instanceof multer.MulterError ? 400 : error.statusCode || 500).json({ success: false, message: error.message, code: error.code }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port + '/api/process-homework';
  const form = (type = 'image/png', id = 'synthetic-test') => {
    const data = new FormData();
    data.append('homeworkImage', new Blob([png], { type }), 'test.png');
    if (id) data.append('anonymousId', id);
    data.append('language', 'zh');
    return data;
  };
  try {
    let response = await fetch(base, { method: 'POST', body: form() });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, reply1: 'Answer', reply2: null, warning: 'Explanation unavailable' });
    assert.equal(calls[0][2], 'anonymous:synthetic-test');
    assert.equal(calls[0][3], 'zh');
    assert.ok(calls[0][4].signal instanceof AbortSignal);
    response = await fetch(base + '/hand-to-markdown', { method: 'POST', body: form() });
    assert.deepEqual(await response.json(), { success: true, reply1: '# Notes' });
    response = await fetch(base, { method: 'POST', body: form('image/png', '') });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'MISSING_IDENTITY');
    response = await fetch(base, { method: 'POST', body: form('text/plain') });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'INVALID_FILE_TYPE');
    assert.equal(calls.length, 2);
    for (let attempt = 0; attempt < 20 && (await readdir(directory)).length; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(await readdir(directory), []);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('homework-ai-route-'));
    await rm(directory, { recursive: true, force: true });
  }
});
