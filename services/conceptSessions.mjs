import { randomUUID } from 'node:crypto';
import { AIError } from '../AI_ChatBot/openaiClient.mjs';

export const CONCEPT_LIMIT_MESSAGE = '此功能并非通用chat bot，关键词解释只支持2轮对话，是否需要我帮你把刚才的上下文导出以便于你在其他chat bot中继续？';
const fail = (message, status, code) => { throw new AIError(message, status, code); };
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(value);
const text = value => typeof value === 'string' ? value.trim() : '';

// Deliberately process-local: no database, Redis, disk, or provider conversation.
// This app runs one API process. A restart discards all result/selection context.
export function createConceptStore({ now = Date.now, ttlMs = 30 * 60_000,
  maxBytes = 24 * 1024 * 1024, maxContexts = 64, maxChannelsPerContext = 8 } = {}) {
  const contexts = new Map();
  const sessions = new Map();
  let bytes = 0;

  function eraseSession(id) {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    session.controller?.abort();
    session.messages.length = 0;
    session.selectedText = '';
    session.controller = null;
  }

  function eraseContext(id) {
    const context = contexts.get(id);
    if (!context) return;
    contexts.delete(id);
    for (const channel of context.channels.values()) eraseSession(channel.sessionId);
    context.channels.clear();
    bytes -= context.bytes;
    context.source = null;
    context.answer = '';
  }

  function sweep() {
    for (const [id, context] of contexts) if (context.expiresAt <= now()) eraseContext(id);
  }

  function registerResult({ owner, source, answer, language = 'en' }) {
    sweep();
    if (!owner || !source || !text(answer)) return null;
    const size = Buffer.byteLength(JSON.stringify(source)) + Buffer.byteLength(answer);
    if (size > maxBytes) return null;
    while (contexts.size && (contexts.size >= maxContexts || bytes + size > maxBytes)) {
      eraseContext(contexts.keys().next().value);
    }
    const id = randomUUID();
    contexts.set(id, { id, owner, source: { ...source }, answer, language,
      bytes: size, expiresAt: now() + ttlMs, channels: new Map() });
    bytes += size;
    return id;
  }

  function getContext(id, identities) {
    sweep();
    const context = contexts.get(id);
    if (!context || !identities?.includes(context.owner)) {
      fail('The question context has expired or is unavailable. Generate the answer again.', 404, 'CONCEPT_CONTEXT_EXPIRED');
    }
    return context;
  }

  function getSession(id, identities) {
    sweep();
    const session = sessions.get(id);
    if (!session) fail('This explanation has ended. Select text to start a new explanation.', 404, 'CONCEPT_SESSION_EXPIRED');
    getContext(session.contextId, identities);
    return session;
  }

  function advanceChannel(context, clientId, revision) {
    if (!validId(clientId) || !Number.isSafeInteger(revision) || revision < 1) {
      fail('Invalid explanation request.', 400, 'INVALID_CONCEPT_CHANNEL');
    }
    let channel = context.channels.get(clientId);
    if (channel && revision <= channel.revision) {
      fail('A newer selection has replaced this request.', 409, 'CONCEPT_STALE_REQUEST');
    }
    if (!channel) {
      if (context.channels.size >= maxChannelsPerContext) {
        fail('Too many open explanation panels. Generate a new answer to continue.', 429, 'CONCEPT_CHANNEL_LIMIT');
      }
      channel = { revision: 0, sessionId: null };
      context.channels.set(clientId, channel);
    }
    // A revision tombstone stays until the ORIGINAL question expires. Late start
    // requests can never re-create a closed/replaced explanation in that channel.
    eraseSession(channel.sessionId);
    channel.revision = revision;
    channel.sessionId = null;
    return channel;
  }

  function begin({ identities, contextId, clientId, revision, selectedText }) {
    const context = getContext(contextId, identities);
    const selection = text(selectedText);
    if (!selection || selection.length > 2000) fail('Select between 1 and 2000 characters.', 400, 'INVALID_CONCEPT_SELECTION');
    const channel = advanceChannel(context, clientId, revision);
    const id = randomUUID();
    const session = { id, contextId, selectedText: selection, messages: [],
      turnCount: 0, status: 'active', controller: null };
    sessions.set(id, session);
    channel.sessionId = id;
    return id;
  }

  function closeChannel({ identities, contextId, clientId, revision }) {
    const context = getContext(contextId, identities);
    advanceChannel(context, clientId, revision);
  }

  function snapshot(session, message) {
    return { sessionId: session.id, selectedText: session.selectedText,
      messages: structuredClone(session.messages), turnCount: session.turnCount,
      status: session.status, ...(message ? { message } : {}) };
  }

  function reserve({ sessionId, identities, message, initial = false }) {
    const session = getSession(sessionId, identities);
    const context = getContext(session.contextId, identities);
    if (session.status === 'refused') return { snapshot: snapshot(session, session.messages.at(-1)?.content) };
    if (session.turnCount >= 2) {
      session.status = 'limited';
      return { snapshot: snapshot(session, CONCEPT_LIMIT_MESSAGE) };
    }
    if (session.controller) fail('An explanation is already in progress.', 409, 'CONCEPT_BUSY');
    const question = initial ? session.selectedText : text(message);
    if (!question || question.length > 2000) fail('Enter between 1 and 2000 characters.', 400, 'INVALID_CONCEPT_MESSAGE');
    const controller = new AbortController();
    session.controller = controller;
    return { session, controller, question, args: {
      source: context.source, answer: context.answer, selectedText: session.selectedText,
      language: context.language, history: session.messages.map(({ role, content }) => ({ role, content })),
      message: initial ? undefined : question, userId: context.owner, signal: controller.signal,
    } };
  }

  function release(ticket) {
    if (ticket?.session?.controller === ticket.controller) {
      ticket.controller.abort();
      ticket.session.controller = null;
    }
    // Release references held by a finished route, including source media/history.
    if (ticket) ticket.args = null;
  }

  function complete(ticket, result) {
    sweep();
    const session = ticket.session;
    if (sessions.get(session.id) !== session || session.controller !== ticket.controller || ticket.controller.signal.aborted) {
      fail('A newer selection has replaced this explanation.', 409, 'CONCEPT_STALE_REQUEST');
    }
    if (!text(result?.text)) fail('The explanation was empty. Please try again.', 502, 'AI_EMPTY_OUTPUT');
    session.messages.push({ role: 'user', content: ticket.question },
      { role: 'assistant', content: result.text, citations: result.citations || [] });
    session.turnCount += 1;
    session.status = result.refused ? 'refused' : 'active';
    const response = snapshot(session);
    release(ticket);
    return response;
  }

  function exportContext(sessionId, identities) {
    const session = getSession(sessionId, identities);
    const context = getContext(session.contextId, identities);
    const source = context.source;
    const media = source.type === 'input_image'
      ? `![Original question](${source.image_url})`
      : `[Original question PDF](${source.file_data})`;
    const conversation = session.messages.map(item => `### ${item.role === 'user' ? 'User' : 'Explanation'}\n\n${item.content}` +
      (item.citations?.length ? '\n\nSources:\n' + item.citations.map(c => `- [${c.title.replace(/[\[\]\n\r]/g, ' ')}](${c.url})`).join('\n') : '')).join('\n\n');
    return { filename: 'concept-explanation.md', markdown: `# Concept explanation context\n\n## Original question\n\n${media}\n\nThe original image/PDF is embedded above. If your chat app does not read data links, save the attachment and upload it with this context.\n\n## Generated answer\n\n${context.answer}\n\n## Selected text\n\n${session.selectedText}\n\n## Conversation\n\n${conversation}\n` };
  }

  function clear() { for (const id of contexts.keys()) eraseContext(id); }
  return { registerResult, begin, reserve, complete, release, closeChannel, exportContext, sweep, clear };
}

export const conceptStore = createConceptStore();
// Time expiry must also delete idle data without waiting for another request.
const sweepTimer = setInterval(() => conceptStore.sweep(), 30_000);
sweepTimer.unref();
