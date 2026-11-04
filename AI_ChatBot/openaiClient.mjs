import OpenAI from 'openai';

export const TEXT_MODEL = 'gpt-6.1-terra';
export const AUDIO_MODEL = 'gpt-realtime-2.1-mini';

export class AIError extends Error {
  constructor(message, statusCode = 502, code = 'AI_UPSTREAM_ERROR') {
    super(message);
    this.name = 'AIError';
    this.statusCode = statusCode;
    this.code = code;
    this.expose = true;
  }
}

export function positiveInteger(value, fallback) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

let client;
export function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY?.trim()) {
    throw new AIError('OpenAI is not configured on this server.', 503, 'AI_NOT_CONFIGURED');
  }
  client ??= new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    // Do not inherit an old or third-party gateway from the environment.
    baseURL: 'https://api.openai.com/v1',
    timeout: positiveInteger(process.env.OPENAI_TIMEOUT_MS, 120_000),
    maxRetries: 0,
  });
  return client;
}

// Never forward upstream messages, payloads or credentials to the client/log.
export function safeAIError(error) {
  if (error instanceof AIError) return error;
  const code = error?.code ?? error?.error?.code;
  if (['insufficient_quota', 'credit_balance_exhausted', 'billing_hard_limit_reached'].includes(code)) {
    return new AIError('OpenAI API credits are exhausted. Check the linked organization’s billing balance.', 429, 'AI_CREDIT_EXHAUSTED');
  }
  if (error?.status === 429 || code === 'rate_limit_exceeded') {
    return new AIError('The AI service is busy. Please try again shortly.', 429, 'AI_RATE_LIMITED');
  }
  if (error?.status === 401 || error?.status === 403 || code === 'invalid_api_key') {
    return new AIError('The server cannot access the configured OpenAI model.', 503, 'AI_ACCESS_UNAVAILABLE');
  }
  if (error?.name === 'APIConnectionTimeoutError' || error?.name === 'TimeoutError' || code === 'ETIMEDOUT') {
    return new AIError('The AI request timed out. Please try again.', 504, 'AI_TIMEOUT');
  }
  if (error?.name === 'AbortError' || error?.name === 'APIUserAbortError') {
    return new AIError('The AI request was canceled.', 499, 'AI_CANCELED');
  }
  return new AIError('The AI service could not complete this request. Please try again.', 502, 'AI_UPSTREAM_ERROR');
}

export function logUsage(logger, operation, model, usage) {
  if (!usage) return;
  logger.info?.('[AI usage]', JSON.stringify({
    operation, model,
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    totalTokens: usage.total_tokens ?? 0,
    audioOutputTokens: usage.output_token_details?.audio_tokens ?? 0,
  }));
}
