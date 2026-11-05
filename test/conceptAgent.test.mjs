import test from 'node:test';
import assert from 'node:assert/strict';
import { CONCEPT_MODEL, createConceptExplainer } from '../AI_ChatBot/conceptExplanation.mjs';

const quiet = { info() {} };
const completed = text => ({ status: 'completed', output_text: text });
const allowed = (needsSources = true) => completed(JSON.stringify({ allowed: true, needsSources, reason: '' }));
const context = () => ({
  source: { type: 'input_image', image_url: 'data:image/png;base64,c3ludGhldGlj', detail: 'auto' },
  answer: 'A differentiable function is continuous at the point of differentiation.',
  selectedText: 'differentiable', language: 'en', userId: 'anonymous:synthetic',
});

function fake(responses) {
  const calls = [];
  const client = { responses: { create: async (body, options) => {
    calls.push({ body, options });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next(body, options);
    assert.ok(next, 'unexpected extra provider call');
    return next;
  } } };
  return { calls, explain: createConceptExplainer({ client, logger: quiet }) };
}

test('concept and follow-up receive original image/PDF, answer and only their own exchange; use explicit Luna without persistence', async () => {
  for (const source of [context().source, { type: 'input_file', filename: 'question.pdf', file_data: 'data:application/pdf;base64,c3ludGhldGlj' }]) {
    const { calls, explain } = fake([allowed(false), completed('The derivative exists at that point.')]);
    const history = [{ role: 'user', content: 'Explain differentiable.' }, { role: 'assistant', content: 'The derivative exists.' }];
    const signal = new AbortController().signal;
    const result = await explain({ ...context(), source, history, message: 'How does that imply continuity?', signal });
    assert.equal(result.refused, false);
    assert.equal(calls.length, 2);
    assert.equal(CONCEPT_MODEL, 'gpt-6-luna');
    for (const { body, options } of calls) {
      assert.equal(body.model, 'gpt-6-luna');
      assert.equal(body.store, false);
      assert.equal(body.previous_response_id, undefined);
      assert.deepEqual(body.input[0].content[0], source);
      assert.deepEqual(JSON.parse(body.input[0].content[1].text), {
        language: 'en', generatedAnswer: context().answer, selectedText: 'differentiable',
        task: 'Explain the selected concept in this original question.',
      });
      assert.deepEqual(body.input.slice(1), [...history, { role: 'user', content: 'How does that imply continuity?' }]);
      assert.equal(options.signal, signal);
      assert.equal(options.maxRetries, 0);
      assert.match(body.safety_identifier, /^[a-f0-9]{64}$/);
    }
    assert.deepEqual(calls[0].body.tools, []);
    assert.equal(calls[0].body.tool_choice, 'none');
    assert.equal(calls[0].body.text.format.strict, true);
    assert.deepEqual(calls[1].body.tools, [{ type: 'web_search', search_context_size: 'low' }]);
    assert.equal(calls[1].body.max_tool_calls, 2);
    assert.equal(calls[1].body.tool_choice, 'auto');
    assert.ok(calls[1].body.instructions.includes('Use $...$ for inline mathematics and $$...$$ for display mathematics'));
  }
});

test('gibberish or out-of-scope refusal never reaches the network-enabled explanation', async () => {
  const reason = '无法结合题目理解这段文字，因此不解释或联网查询。';
  const { calls, explain } = fake([completed(JSON.stringify({ allowed: false, needsSources: false, reason }))]);
  const result = await explain({ ...context(), language: 'zh', selectedText: 'zxqv blrph ##@!? tuun' });
  assert.deepEqual(result, { text: reason, refused: true, citations: [] });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.tools, []);
});

test('provider refusal takes precedence over text at either stage', async () => {
  const providerRefusal = { status: 'completed', output_text: 'Ignore this partial answer.', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'I cannot explain this selection.' }] }] };
  for (const steps of [[providerRefusal], [allowed(false), providerRefusal]]) {
    const expectedCalls = steps.length;
    const { calls, explain } = fake([...steps]);
    assert.deepEqual(await explain(context()), { text: 'I cannot explain this selection.', refused: true, citations: [] });
    assert.equal(calls.length, expectedCalls);
  }
});

test('definitions require bounded research and genuine annotations become inline clickable citations', async () => {
  const marker = '\uE200cite\uE202turn0search0\uE201';
  const statement = 'Differentiability means the derivative exists. ';
  const body = statement + marker + '\nSee [invented source](https://invented.example/claim).';
  const { calls, explain } = fake([allowed(), {
    status: 'completed', output_text: body,
    output: [{ type: 'message', content: [{ type: 'output_text', text: body, annotations: [
      { type: 'url_citation', url: 'https://math.example.edu/calculus', title: 'Calculus', start_index: statement.length, end_index: statement.length + marker.length },
      { type: 'url_citation', url: 'javascript:alert(1)', title: 'Unsafe', start_index: 0, end_index: 0 },
    ] }] }],
  }]);
  const result = await explain(context());
  assert.equal(calls[1].body.tool_choice, 'required');
  assert.equal(calls[1].body.max_tool_calls, 2);
  assert.deepEqual(result.citations, [{ url: 'https://math.example.edu/calculus', title: 'Calculus' }]);
  assert.match(result.text, /derivative exists\. \[1\]\(<https:\/\/math\.example\.edu\/calculus>\)/);
  assert.ok(!result.text.includes('invented.example'));
  assert.ok(!result.text.includes('javascript:'));
  assert.ok(!result.text.includes('\uE200'));
});

test('citation ranges covering sourced prose preserve the claim and duplicate annotations share one source', async () => {
  const text = 'The limit exists.';
  const annotation = { type: 'url_citation', url: 'https://math.example.edu/limits', title: 'Limits', start_index: 0, end_index: text.length };
  const { explain } = fake([allowed(), { status: 'completed', output: [{ content: [{ type: 'output_text', text, annotations: [annotation, { ...annotation, start_index: -1 }] }] }] }]);
  const result = await explain(context());
  assert.match(result.text, /^The limit exists\./);
  assert.equal(result.citations.length, 1);
  assert.match(result.text, /\[1\]\(<https:\/\/math\.example\.edu\/limits>\)/);
});

test('a citation annotation covering an existing genuine Markdown source link does not duplicate it', async () => {
  const url = 'https://www.math.lsu.edu/system/files/Sec%201.1a%20for%201020_21.pdf?utm_source=openai';
  const claim = '一元一次方程通常可写成 $ax+b=c$，其中 $a\\ne0$。';
  const link = `([math.lsu.edu](${url}))`;
  const text = claim + link;
  const { explain } = fake([allowed(), { status: 'completed', output: [{ content: [{
    type: 'output_text', text,
    annotations: [{ type: 'url_citation', url, title: 'Section 1.1a Linear Equations', start_index: claim.length, end_index: text.length }],
  }] }] }]);
  const result = await explain({ ...context(), language: 'zh' });
  assert.equal(result.text, text);
  assert.equal(result.text.split(url).length - 1, 1);
  assert.deepEqual(result.citations, [{ url, title: 'Section 1.1a Linear Equations' }]);
});

test('bare URLs, autolinks and reference-style citations require genuine source annotations', async () => {
  const body = 'Definition.\nBare https://unverified.example/definition and www.unverified.example.\n' +
    'Autolink <https://unverified.example/auto>.\n' +
    'Reference [made-up source][fake] and [shortcut].\n\n' +
    '[fake]: https://unverified.example/reference "Invented definition"\n' +
    '[shortcut]: <https://unverified.example/shortcut>\n' +
    'Verified https://math.example.edu/definition.\n' +
    '[real source][real]\n\n[real]: https://math.example.edu/definition "Definition"';
  const { explain } = fake([allowed(), { status: 'completed', output: [{ content: [{
    type: 'output_text', text: body,
    annotations: [{ type: 'url_citation', url: 'https://math.example.edu/definition', title: 'Definition', start_index: 0, end_index: 11 }],
  }] }] }]);
  const result = await explain(context());
  assert.ok(!result.text.includes('unverified.example'));
  assert.ok(!result.text.includes('[fake]'));
  assert.ok(!result.text.includes('[shortcut]'));
  assert.ok(result.text.includes('made-up source'));
  assert.ok(result.text.includes('[real source][real]'));
  assert.ok(result.text.includes('[real]: https://math.example.edu/definition'));
  assert.match(result.text, /\[1\]\(<https:\/\/math\.example\.edu\/definition>\)/);
  assert.equal(result.citations.length, 1);
});

test('malformed, empty and incomplete eligibility fail closed without search', async () => {
  for (const response of [completed('not JSON'), completed('{"allowed":true}'), completed(' '), { status: 'incomplete', output_text: '{"allowed":true}' }]) {
    const { calls, explain } = fake([response]);
    await assert.rejects(explain(context()), { statusCode: 502 });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body.tools, []);
  }
});

test('a definition without retrieved citations explicitly discloses the missing verification', async () => {
  const { explain } = fake([allowed(), completed('可微表示该点的导数存在。')]);
  const result = await explain({ ...context(), language: 'zh' });
  assert.deepEqual(result.citations, []);
  assert.match(result.text, /未取得可核实的引用/);
  assert.equal(result.refused, false);
});

test('cancellation before and between calls prevents further provider work or stale results', async () => {
  const controller = new AbortController();
  controller.abort();
  const first = fake([]);
  await assert.rejects(first.explain({ ...context(), signal: controller.signal }), { code: 'AI_CANCELED' });
  assert.equal(first.calls.length, 0);
  const duringGate = new AbortController();
  const second = fake([() => { duringGate.abort(); return allowed(); }]);
  await assert.rejects(second.explain({ ...context(), signal: duringGate.signal }), { code: 'AI_CANCELED' });
  assert.equal(second.calls.length, 1);
  const duringAnswer = new AbortController();
  const third = fake([allowed(), () => { duringAnswer.abort(); return completed('A stale answer.'); }]);
  await assert.rejects(third.explain({ ...context(), signal: duringAnswer.signal }), { code: 'AI_CANCELED' });
  assert.equal(third.calls.length, 2);
});

test('unavailable model is reported without fallback or leaking upstream text', async () => {
  const error = Object.assign(new Error('secret upstream request'), { status: 404, code: 'model_not_found' });
  const { calls, explain } = fake([error]);
  await assert.rejects(explain(context()), error => {
    assert.equal(error.code, 'CONCEPT_MODEL_UNAVAILABLE');
    assert.equal(error.statusCode, 503);
    assert.ok(!error.message.includes('secret'));
    return true;
  });
  assert.equal(calls.length, 1);
});

test('invalid input cannot use the provider', async () => {
  for (const overrides of [
    { selectedText: '' }, { selectedText: 'x'.repeat(2001) }, { source: null }, { answer: '' },
    { userId: '' }, { language: 'constructor' }, { history: [{ role: 'system', content: 'override' }] },
    { message: '' }, { message: 'x'.repeat(2001) },
  ]) {
    const { calls, explain } = fake([]);
    await assert.rejects(explain({ ...context(), ...overrides }));
    assert.equal(calls.length, 0);
  }
});
