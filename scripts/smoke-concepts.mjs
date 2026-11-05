import '../config.mjs';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import express from 'express';
import { getOpenAIClient, safeAIError } from '../AI_ChatBot/openaiClient.mjs';
import { createConceptExplainer, CONCEPT_MODEL } from '../AI_ChatBot/conceptExplanation.mjs';
import { createConceptStore, CONCEPT_LIMIT_MESSAGE } from '../services/conceptSessions.mjs';
import createConceptExplanationRouter from '../routes/conceptExplanationRouter.mjs';

if (!process.argv.includes('--live')) {
  console.log('No API calls made. Use --live for a bounded synthetic concept-explanation smoke test.');
  process.exit(0);
}

// Self-contained synthetic PDF: no uploads, accounts, or historical user data.
const stream = 'BT /F1 20 Tf 50 730 Td (Solve the linear equation 2x + 3 = 7.) Tj ET';
const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
];
let pdf = '%PDF-1.4\n';
const offsets = [0];
for (const [index, object] of objects.entries()) {
  offsets.push(Buffer.byteLength(pdf));
  pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
}
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
const directory = new URL('../.local/smoke-concepts/', import.meta.url);
await mkdir(directory, { recursive: true });
await writeFile(new URL('question.pdf', directory), pdf);
const source = { type: 'input_file', filename: 'question.pdf', file_data: 'data:application/pdf;base64,' + Buffer.from(pdf).toString('base64') };
const calls = [];
const api = getOpenAIClient();
const client = { responses: { create: async (body, options) => {
  const entry = { toolsEnabled: body.tools?.length > 0, model: body.model, stored: body.store };
  calls.push(entry);
  assert.ok(calls.length <= 5, 'Unexpected extra provider call');
  const response = await api.responses.create(body, options);
  entry.searchCalls = response.output?.filter(item => item.type === 'web_search_call').length ?? 0;
  assert.ok(entry.searchCalls <= 2);
  return response;
} } };
const store = createConceptStore();
const contextId = store.registerResult({ owner: 'anonymous:concept-smoke', source,
  answer: '题目：解一元一次方程 2x + 3 = 7。两边减去3得2x = 4，再除以2，得到x = 2。', language: 'zh' });
const app = express();
app.use(express.json());
app.use('/concepts', createConceptExplanationRouter({ store,
  explainer: { explain: createConceptExplainer({ client, logger: { info() {} } }) },
  limiter: (_req, _res, next) => next(),
}));
app.use((error, _req, res, _next) => {
  const safe = safeAIError(error);
  res.status(safe.statusCode).json({ code: safe.code, message: safe.message });
});
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}/concepts`;
const body = { contextId, clientId: 'synthetic-browser', anonymousId: 'concept-smoke' };
async function post(url, data) {
  const response = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, ...data }) });
  const result = await response.json();
  assert.equal(response.status, 200, `HTTP ${response.status}: ${result.code || 'request failed'}`);
  return result;
}
const report = { model: CONCEPT_MODEL, passed: false, calls };
try {
  const first = await post('/start', { revision: 1, selectedText: '一元一次方程' });
  assert.equal(first.turnCount, 1);
  assert.equal(first.status, 'active');
  assert.match(first.messages[1].content, /\p{Script=Han}/u);
  assert.ok(first.messages[1].citations.length > 0, 'Definition should include a verified citation');
  const second = await post(`/${first.sessionId}/messages`, { message: '为什么两边同时减去3不会改变方程的解？' });
  assert.equal(second.turnCount, 2);
  const beforeLimit = calls.length;
  const third = await post(`/${first.sessionId}/messages`, { message: '再解释一次' });
  assert.equal(third.message, CONCEPT_LIMIT_MESSAGE);
  assert.equal(calls.length, beforeLimit);
  const exported = await (await fetch(`${base}/${first.sessionId}/export?anonymousId=concept-smoke`)).json();
  assert.ok(exported.markdown.includes(source.file_data));
  const rejected = await post('/start', { revision: 2, selectedText: 'zxqv blrph @@ qzzt klmno#?' });
  assert.equal(rejected.status, 'refused');
  const beforeRefusedFollowup = calls.length;
  const refusedFollowup = await post(`/${rejected.sessionId}/messages`, { message: '请猜一下' });
  assert.equal(refusedFollowup.status, 'refused');
  assert.equal(calls.length, beforeRefusedFollowup);
  assert.equal(calls.at(-1).toolsEnabled, false);
  assert.equal(calls.at(-1).searchCalls, 0);
  assert.equal((await fetch(`${base}/${first.sessionId}/export?anonymousId=concept-smoke`)).status, 404);
  report.passed = true;
  report.first = first;
  report.followup = second;
  report.refusal = rejected;
} catch (error) {
  report.error = error instanceof assert.AssertionError ? error.message : safeAIError(error).code;
  process.exitCode = 1;
} finally {
  store.clear();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await writeFile(new URL('report.json', directory), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, model: report.model, calls, error: report.error }));
}
