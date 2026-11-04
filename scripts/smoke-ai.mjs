import '../config.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHomeworkService } from '../AI_ChatBot/OpenAI_Agent.mjs';
import { createSpeechService } from '../AI_ChatBot/text_speech.mjs';
import { AUDIO_MODEL, TEXT_MODEL, safeAIError } from '../AI_ChatBot/openaiClient.mjs';

// Opt-in only: npm tests do not call OpenAI or spend API credits.
if (!process.argv.includes('--live')) {
  console.log('No API requests made. Run node scripts/smoke-ai.mjs --live to test synthetic inputs with the configured OpenAI key.');
  process.exit(0);
}
if (!process.env.OPENAI_API_KEY?.trim()) {
  console.error('OPENAI_API_KEY is not configured.');
  process.exit(1);
}

const directory = fileURLToPath(new URL('../.local/smoke-ai/', import.meta.url));
await mkdir(directory, { recursive: true });
const caseArgument = process.argv.indexOf('--case');
const selectedCase = caseArgument >= 0 ? process.argv[caseArgument + 1] : null;
const caseNames = ['en-image', 'en-pdf', 'zh-image', 'zh-pdf', 'handwriting-transcription', 'non-school-refusal', 'speech-en', 'speech-zh'];
if (caseArgument >= 0 && !caseNames.includes(selectedCase)) throw new Error('Choose a valid smoke case: ' + caseNames.join(', '));
const reportPath = path.join(directory, selectedCase ? 'results-' + selectedCase + '.json' : 'results.json');
const pngPath = path.join(directory, 'equation.png');
const pdfPath = path.join(directory, 'equation.pdf');
const groceryPath = path.join(directory, 'grocery-list.png');
const fixtureText = '# Homework\n\nSolve $2x + 3 = 7$. Show your steps.\n';
await writeFile(path.join(directory, 'equation.md'), fixtureText);

function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, { windowsHide: true, timeout: 60_000, maxBuffer: 2 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) {
    throw new Error(executable + ' failed to generate synthetic fixtures (' + (result.error?.code ?? result.status) + ').');
  }
}

// Generated from fixed text, never copied from uploads or historical assets.
command('python', ['-c', `
from PIL import Image, ImageDraw, ImageFont
import sys
try:
    font = ImageFont.truetype('arial.ttf', 48)
except OSError:
    font = ImageFont.truetype('DejaVuSans.ttf', 48)
for target, text in [(sys.argv[1], 'Homework\\n\\nSolve 2x + 3 = 7.\\nShow your steps.'), (sys.argv[2], 'Grocery list\\n\\nMilk\\nBread\\nEggs\\nApples')]:
    image = Image.new('RGB', (1200, 600), 'white')
    ImageDraw.Draw(image).multiline_text((60, 60), text, font=font, fill='black', spacing=18)
    image.save(target)
`, pngPath, groceryPath]);
command('pandoc', ['-f', 'markdown', '-t', 'pdf', '--pdf-engine=xelatex', '-V', 'mainfont=Arial', '-o', pdfPath], { input: fixtureText });

let estimatedUsd = 0;
const allUsage = [];
const report = { startedAt: new Date().toISOString(), textModel: TEXT_MODEL, audioModel: AUDIO_MODEL, cases: [] };
const logger = {
  info(label, serialized) {
    if (label !== '[AI usage]') return;
    const usage = JSON.parse(serialized);
    // Conservative standard-price estimate for synthetic text/image input.
    // Actual organization billing remains authoritative.
    usage.estimatedUsd = usage.model === AUDIO_MODEL
      ? (usage.inputTokens * 0.6 + (usage.outputTokens - usage.audioOutputTokens) * 2.4 + usage.audioOutputTokens * 20) / 1_000_000
      : (usage.inputTokens * 1.25 + usage.outputTokens * 5) / 1_000_000;
    estimatedUsd += usage.estimatedUsd;
    allUsage.push(usage);
  },
  warn() {},
};
const homework = createHomeworkService({ logger });
const speech = createSpeechService({ logger, timeoutMs: 30_000, maxAudioBytes: 512 * 1024, maxCacheEntries: 0 });
const identity = 'synthetic-local-smoke';

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}
function plainExplanation(text, language) {
  requireThat(typeof text === 'string' && text.trim(), 'Missing spoken explanation.');
  requireThat(!/```|^#{1,6}\s|\*\*|\$[^$]+\$|\\[([]/m.test(text), 'Explanation contains Markdown or LaTeX.');
  if (language === 'zh') {
    requireThat(/\p{Script=Han}/u.test(text), 'Chinese explanation was not in Chinese.');
    requireThat([...text].length <= 800, 'Chinese explanation exceeded 800 characters.');
  } else {
    requireThat(!/\p{Script=Han}/u.test(text), 'English explanation contained Chinese.');
    requireThat(text.trim().split(/\s+/).length < 500, 'English explanation exceeded its word limit.');
  }
}

async function run(name, action) {
  if (selectedCase && selectedCase !== name) return;
  const start = allUsage.length;
  const startedAt = Date.now();
  // Leave room for a bounded final request; never retry failed cases here.
  if (estimatedUsd > 0.75) throw new Error('Smoke-test budget threshold reached.');
  const entry = { name };
  try {
    entry.output = await action();
    entry.passed = true;
  } catch (error) {
    entry.passed = false;
    const safe = safeAIError(error);
    entry.errorCode = error?.code ?? (error?.constructor === Error ? 'SMOKE_ASSERTION_FAILED' : safe.code);
    // Locally-created assertions are safe; never record upstream error bodies.
    entry.error = error?.constructor === Error ? error.message : safe.message;
  }
  entry.elapsedMs = Date.now() - startedAt;
  entry.usage = allUsage.slice(start);
  report.cases.push(entry);
  console.log(JSON.stringify({ case: name, passed: entry.passed, errorCode: entry.errorCode, elapsedMs: entry.elapsedMs, usage: entry.usage }));
  await writeFile(reportPath, JSON.stringify(report, null, 2));
}

for (const language of ['en', 'zh']) {
  for (const [format, file, mime] of [['image', pngPath, 'image/png'], ['pdf', pdfPath, 'application/pdf']]) {
    await run(language + '-' + format, async () => {
      const answer = await homework.imageUnderstand(file, mime, identity, language);
      const normalized = answer.text1.replace(/\\boxed\{([^}]+)\}/g, '$1').replace(/[{}]/g, '');
      requireThat(/x\s*[=&]*\s*2\b/.test(normalized), 'Answer did not identify x = 2.');
      requireThat(language === 'zh' ? /\p{Script=Han}/u.test(answer.text1) : !/\p{Script=Han}/u.test(answer.text1), 'Answer language was incorrect.');
      plainExplanation(answer.text2, language);
      return answer;
    });
  }
}

await run('handwriting-transcription', async () => {
  const result = await homework.handWrittenToMarkdown(pngPath, 'image/png', identity);
  requireThat(/2\s*x/.test(result.text1) && /3/.test(result.text1) && /7/.test(result.text1), 'Transcription lost the equation.');
  requireThat(!/^\s*```(?:markdown|latex)/i.test(result.text1), 'Transcription wrapped the entire document in a code fence.');
  return result;
});

await run('non-school-refusal', async () => {
  const result = await homework.imageUnderstand(groceryPath, 'image/png', identity, 'en');
  await writeFile(path.join(directory, 'output-non-school-refusal.json'), JSON.stringify(result, null, 2));
  requireThat(/not.{0,40}(?:school|homework|academic)|(?:can(?:not|['’]t)|unable|decline).{0,60}(?:help|answer|assist|solve)|only.{0,40}(?:school|homework|academic)/is.test(result.text1), 'Non-school image was not refused.');
  return result;
});

for (const [language, text] of [['en', 'Subtract three from both sides. Then divide by two.'], ['zh', '两边同时减三，再除以二。']]) {
  await run('speech-' + language, async () => {
    const { buffer } = await speech.generate(text, '');
    requireThat(buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WAVE', 'Speech output was not WAV.');
    requireThat(buffer.readUInt32LE(24) === 24000 && buffer.readUInt16LE(22) === 1 && buffer.readUInt16LE(34) === 16, 'Speech output had the wrong PCM format.');
    requireThat(buffer.length > 44 && buffer.readUInt32LE(40) === buffer.length - 44, 'Speech output was empty or truncated.');
    await writeFile(path.join(directory, 'speech-' + language + '.wav'), buffer);
    return { bytes: buffer.length, durationSeconds: (buffer.length - 44) / 48000 };
  });
}

report.completedAt = new Date().toISOString();
report.estimatedUsd = estimatedUsd;
report.passed = report.cases.every(entry => entry.passed);
await writeFile(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ passed: report.passed, cases: report.cases.length, estimatedUsd, artifactDirectory: directory }));
process.exitCode = report.passed ? 0 : 1;
