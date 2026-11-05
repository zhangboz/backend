import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { answerPrompts, explanationPrompts, transcriptionPrompt } from './prompts.mjs';
import { AIError, TEXT_MODEL, getOpenAIClient, logUsage, positiveInteger, safeAIError } from './openaiClient.mjs';

export const supportedMimeTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf']);
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export function fileInput(buffer, mimeType) {
  if (!supportedMimeTypes.has(mimeType)) throw new AIError('Upload a PNG, JPEG, WebP, GIF or PDF file.', 400, 'INVALID_FILE_TYPE');
  if (!buffer.length || buffer.length > MAX_UPLOAD_BYTES) throw new AIError('Upload a non-empty file smaller than 10 MB.', 400, 'INVALID_FILE_SIZE');
  const signatures = {
    'image/png': () => buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    'image/jpeg': () => buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255,
    'image/gif': () => /^GIF8[79]a$/.test(buffer.subarray(0, 6).toString('ascii')),
    'image/webp': () => buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP',
    'application/pdf': () => buffer.subarray(0, 1024).includes(Buffer.from('%PDF-')),
  };
  if (!signatures[mimeType]()) throw new AIError('The uploaded file does not match its declared format.', 400, 'INVALID_FILE_CONTENT');
  const data = `data:${mimeType};base64,${buffer.toString('base64')}`;
  return mimeType === 'application/pdf'
    ? { type: 'input_file', filename: 'upload.pdf', file_data: data }
    : { type: 'input_image', image_url: data, detail: 'auto' };
}

function responseText(response) {
  if (response.status !== 'completed') throw new AIError('The AI response was incomplete. Try a shorter document.', 502, 'AI_INCOMPLETE');
  const contents = (response.output ?? []).flatMap(item => item.content ?? []);
  const refusal = contents.find(item => item.type === 'refusal')?.refusal;
  const text = (response.output_text ?? contents.filter(item => item.type === 'output_text').map(item => item.text).join('\n') ?? '').trim();
  if (text) return { text, refused: false };
  if (refusal?.trim()) return { text: refusal.trim(), refused: true };
  throw new AIError('The AI service returned an empty answer. Please try again.', 502, 'AI_EMPTY_OUTPUT');
}

export function createHomeworkService({ client, read = readFile, logger = console } = {}) {
  async function call(operation, instructions, input, effort, userId, signal) {
    try {
      signal?.throwIfAborted();
      const response = await (client ?? getOpenAIClient()).responses.create({
        model: TEXT_MODEL,
        instructions,
        input,
        reasoning: { effort },
        max_output_tokens: operation === 'explanation' ? 4096 : 16384,
        store: false,
        safety_identifier: createHash('sha256').update(String(userId)).digest('hex'),
      }, { signal, timeout: positiveInteger(process.env.OPENAI_TIMEOUT_MS, 120_000), maxRetries: 0 });
      logUsage(logger, operation, TEXT_MODEL, response.usage);
      return responseText(response);
    } catch (error) {
      throw safeAIError(error);
    }
  }

  async function imageUnderstand(filePath, mimeType, userId, language = 'en', { signal } = {}) {
    if (!userId) throw new AIError('A user or anonymous identity is required.', 400, 'MISSING_IDENTITY');
    if (!Object.hasOwn(answerPrompts, language)) throw new AIError('Language must be en or zh.', 400, 'INVALID_LANGUAGE');
    const content = fileInput(await read(filePath), mimeType);
    const answer = await call('answer', answerPrompts[language], [{ role: 'user', content: [content] }], 'medium', userId, signal);
    if (answer.refused) return { text1: answer.text, text2: null };
    try {
      const instructions = explanationPrompts[language].replace('{image_answer}', () => answer.text);
      const explanation = await call('explanation', instructions, 'Explain the supplied homework answer.', 'low', userId, signal);
      return { text1: answer.text, text2: explanation.text,
        explanationContext: { source: content, answer: answer.text, language } };
    } catch (error) {
      const safe = safeAIError(error);
      if (signal?.aborted) throw safe;
      logger.warn?.('[AI explanation unavailable]', safe.code);
      return {
        text1: answer.text, text2: null,
        explanationContext: { source: content, answer: answer.text, language },
        warning: language === 'zh' ? '答案已生成，但语音讲解暂不可用。' : 'Your answer is ready, but the spoken explanation is temporarily unavailable.',
      };
    }
  }

  async function handWrittenToMarkdown(filePath, mimeType, userId, { signal } = {}) {
    if (!userId) throw new AIError('A user or anonymous identity is required.', 400, 'MISSING_IDENTITY');
    const content = fileInput(await read(filePath), mimeType);
    const answer = await call('transcription', transcriptionPrompt, [{ role: 'user', content: [content] }], 'low', userId, signal);
    return { text1: answer.text };
  }

  return { imageUnderstand, handWrittenToMarkdown };
}

const service = createHomeworkService();
export const imageUnderstand = service.imageUnderstand;
export const handWrittenToMarkdown = service.handWrittenToMarkdown;
