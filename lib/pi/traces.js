// @ts-check
// Pure transformer: pi session entries → TraceSummary[]. No I/O.
// Deterministic. One trace per turn. The state layer mirrors API round-trips
// 1:1 (see CLAUDE.md "Core vocabulary — inference vs. tool call").
//
// Trace topology:
//   Trace { kind: 'turn' }
//     turn:N                      attrs: agent_trace.harness=pi, etc.
//       inference                 one per assistant `message` entry with usage or a toolCall
//         <toolName>              one per toolCall block, paired to its toolResult by id
//
// Never emits `kind: 'unattached'`: child sessions (header `parentSession`)
// are their own sessions, tagged `agent_trace.pi.parent_session`. Folding
// them into the parent would couple this adapter to a swappable third-party
// subagents extension.
//
// Structural rules (CLAUDE.md §2 — no timestamps for identity / pairing /
// ordering decisions):
//
//   * Active branch: pi sessions are trees (`/tree` leaves abandoned
//     branches). The leaf is the last non-header entry (pi's own leaf-on-load
//     rule); walk `parentId` to the root. A dangling, duplicate, or cyclic
//     `parentId` stops the walk and stamps `agent_trace.pi.path_truncated`.
//
//   * Turn openers: a `user` message, or a `custom_message` that follows an
//     assistant `stop` and is itself followed by an assistant message
//     (extension-triggered run, e.g. a background-job notification).
//
//   * Timestamps set span width for display only.

import path from 'node:path';
import { sessionIdFromFileName } from './sessions.js';

/** @typedef {import('./transcripts.js').PiEntry} PiEntry */
/** @typedef {import('./transcripts.js').PiBundle} PiBundle */
/** @typedef {import('../traces/types.js').SpanNode} SpanNode */
/** @typedef {import('../traces/types.js').Turn} Turn */
/** @typedef {import('../traces/types.js').TraceSummary} TraceSummary */

// Truncation caps — mirror the Claude and Codex transformers.
const SUMMARY_MAX = 4000; // tool I/O — log-like, truncation tolerable
const ASSISTANT_MAX = 16000; // narrative content — needs more room

const SKILL_OPEN_RE = /^<skill name="[^"]+"/;
const SKILL_CLOSE = '</skill>';

// pi stop reasons → the Anthropic values `deriveTurnOutcome` classifies.
/** @type {Record<string, string>} */
const STOP_REASON_TO_UI = { stop: 'end_turn', length: 'max_tokens' };

let idCounter = 0;
function nextSpanId() {
  idCounter = (idCounter + 1) | 0;
  return `s${idCounter.toString(16).padStart(8, '0')}${Math.random().toString(16).slice(2, 10)}`;
}

/** @param {string | number | undefined | null} ts */
function toMs(ts) {
  if (ts == null) return 0;
  if (typeof ts === 'number') return ts;
  const n = Date.parse(ts);
  return Number.isFinite(n) ? n : 0;
}

/** @param {unknown} v */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** @param {unknown} v */
function safeStringify(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * @param {unknown} v
 * @param {number} [max]
 */
function truncate(v, max = SUMMARY_MAX) {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : safeStringify(v);
  return s.length > max ? `${s.slice(0, max)}…[truncated]` : s;
}

/**
 * Visible text of a message `content` (string, or an array of blocks).
 * @param {unknown} content
 * @param {string} [blockType]
 * @param {string} [field]
 */
function blockText(content, blockType = 'text', field = 'text') {
  if (typeof content === 'string') return blockType === 'text' ? content : '';
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b?.type === blockType && typeof b[field] === 'string')
    .map((b) => b[field])
    .join('\n');
}

/**
 * The prompt the user typed. `/skill:` expansions inline the skill body as
 * `<skill name=...>…</skill>` ahead of the user's own text.
 * @param {any} message
 */
function userPromptOf(message) {
  const full = blockText(message?.content).trim();
  if (!SKILL_OPEN_RE.test(full)) return full;
  const close = full.lastIndexOf(SKILL_CLOSE);
  return close === -1 ? '' : full.slice(close + SKILL_CLOSE.length).trim();
}

/** @param {PiEntry | undefined} e */
function isMessage(e) {
  return e?.type === 'message' && e.message && typeof e.message === 'object';
}

/**
 * @param {PiEntry[]} entries
 * @returns {{ path: PiEntry[], truncated: boolean }}
 */
function activePath(entries) {
  const body = entries.filter((e) => e.type !== 'session' && typeof e.id === 'string');
  if (body.length === 0) return { path: [], truncated: false };
  /** @type {Map<string, PiEntry>} */
  const byId = new Map();
  /** @type {Set<string>} */
  const duplicateIds = new Set();
  for (const e of body) {
    if (byId.has(e.id)) duplicateIds.add(e.id);
    else byId.set(e.id, e);
  }
  const reversed = [];
  /** @type {Set<string>} */
  const seen = new Set();
  let truncated = false;
  /** @type {PiEntry | undefined} */
  let cur = body[body.length - 1];
  while (cur) {
    reversed.push(cur);
    seen.add(cur.id);
    const parentId = cur.parentId;
    if (parentId == null) break;
    if (
      typeof parentId !== 'string' ||
      !byId.has(parentId) ||
      duplicateIds.has(parentId) ||
      seen.has(parentId)
    ) {
      truncated = true;
      break;
    }
    cur = byId.get(parentId);
  }
  return { path: reversed.reverse(), truncated };
}

/**
 * @typedef {{
 *   trigger: 'user' | 'custom_message' | 'implicit',
 *   entries: PiEntry[],
 * }} TurnSlice
 */

/**
 * @param {PiEntry[]} activeEntries
 * @returns {TurnSlice[]}
 */
function sliceTurns(activeEntries) {
  // Role of the next `message` entry after each index, for the
  // custom_message opener rule.
  /** @type {(string | null)[]} */
  const nextMessageRole = new Array(activeEntries.length).fill(null);
  /** @type {string | null} */
  let upcoming = null;
  for (let i = activeEntries.length - 1; i >= 0; i--) {
    nextMessageRole[i] = upcoming;
    const e = activeEntries[i];
    if (isMessage(e)) upcoming = e.message.role ?? null;
  }

  /** @type {TurnSlice[]} */
  const slices = [];
  /** @type {TurnSlice | null} */
  let current = null;
  let afterAssistantStop = false;

  for (let i = 0; i < activeEntries.length; i++) {
    const e = activeEntries[i];
    if (isMessage(e)) {
      const role = e.message.role;
      if (role === 'user') {
        current = { trigger: 'user', entries: [] };
        slices.push(current);
      } else if (role === 'assistant' && !current) {
        current = { trigger: 'implicit', entries: [] };
        slices.push(current);
      }
      afterAssistantStop = role === 'assistant' && e.message.stopReason === 'stop';
    } else if (
      e.type === 'custom_message' &&
      current &&
      afterAssistantStop &&
      nextMessageRole[i] === 'assistant'
    ) {
      current = { trigger: 'custom_message', entries: [] };
      slices.push(current);
      afterAssistantStop = false;
    }
    if (current) current.entries.push(e);
  }
  return slices;
}

/**
 * @param {any} message
 * @returns {{ input: number, output: number, cacheRead: number, cacheCreation: number, total: number }}
 */
function usageOf(message) {
  const u = message?.usage ?? {};
  const input = num(u.input);
  const output = num(u.output);
  const cacheRead = num(u.cacheRead);
  const cacheCreation = num(u.cacheWrite);
  const total =
    u.totalTokens != null ? num(u.totalTokens) : input + output + cacheRead + cacheCreation;
  return { input, output, cacheRead, cacheCreation, total };
}

/**
 * @param {any} block toolCall content block
 * @param {PiEntry} callEntry
 * @param {Map<string, PiEntry>} resultsById
 * @param {string} parentSpanId
 * @returns {SpanNode}
 */
function buildToolSpan(block, callEntry, resultsById, parentSpanId) {
  const callId = typeof block.id === 'string' ? block.id : '';
  const name = typeof block.name === 'string' && block.name ? block.name : 'tool';
  const openTs = toMs(callEntry.timestamp);
  const resultEntry = callId ? resultsById.get(callId) : undefined;
  const resultTs = toMs(resultEntry?.timestamp);
  const endMs = resultTs > openTs ? resultTs : openTs + 1;

  /** @type {Record<string, unknown>} */
  const attributes = {
    'agent_trace.tool.name': name,
    'agent_trace.tool.use_id': callId,
    'agent_trace.tool.input_summary': truncate(block.arguments),
    'agent_trace.transcript.row_index': callEntry._rowIndex,
  };
  /** @type {SpanNode['status']} */
  let status;
  if (resultEntry) {
    const output = blockText(resultEntry.message.content);
    attributes['agent_trace.tool.output_summary'] = truncate(output);
    attributes['agent_trace.tool.output_bytes'] = Buffer.byteLength(output, 'utf8');
    attributes['agent_trace.transcript.row_index_end'] = resultEntry._rowIndex;
    if (resultEntry.message.isError === true) status = { code: 2, message: 'tool error' };
  } else {
    attributes['agent_trace.tool.no_result'] = true;
  }
  return {
    spanId: nextSpanId(),
    parentSpanId,
    name,
    startMs: openTs,
    endMs,
    durationMs: endMs - openTs,
    ...(status ? { status } : {}),
    attributes,
    events: [],
    children: [],
  };
}

/**
 * One inference span per assistant entry that made a real round-trip:
 * non-zero usage, or at least one toolCall (an aborted entry can carry a
 * toolCall with zero usage). Returns null otherwise.
 *
 * @param {PiEntry} entry
 * @param {number} requestStartMs timestamp of the entry that fed this request (display only)
 * @param {Map<string, PiEntry>} resultsById
 * @param {string} parentSpanId
 */
function buildInferenceSpan(entry, requestStartMs, resultsById, parentSpanId) {
  const m = entry.message;
  /** @type {any[]} */
  const content = Array.isArray(m.content) ? m.content : [];
  const toolCalls = content.filter((b) => b?.type === 'toolCall');
  const usage = usageOf(m);
  if (usage.total <= 0 && toolCalls.length === 0) return null;

  const text = blockText(content);
  const thinking = blockText(content, 'thinking', 'thinking');
  const hasThinking = content.some((b) => b?.type === 'thinking');
  const hasText = text.length > 0;
  const hasToolUse = toolCalls.length > 0;
  const kindCount = (hasThinking ? 1 : 0) + (hasText ? 1 : 0) + (hasToolUse ? 1 : 0);
  /** @type {'reasoning' | 'message' | 'tool_use' | 'mixed'} */
  let kind;
  if (kindCount > 1) kind = 'mixed';
  else if (hasText) kind = 'message';
  else if (hasToolUse) kind = 'tool_use';
  else kind = 'reasoning';

  const endTs = toMs(entry.timestamp);
  const startMs = requestStartMs > 0 && requestStartMs <= endTs ? requestStartMs : endTs;
  const endMs = endTs > startMs ? endTs : startMs + 1;
  const stopReason = typeof m.stopReason === 'string' ? m.stopReason : '';
  const spanId = nextSpanId();

  /** @type {SpanNode['events']} */
  const events = [];
  if (hasThinking) {
    events.push({
      name: 'gen_ai.assistant.reasoning',
      timeMs: startMs,
      attributes: { 'gen_ai.reasoning.content': truncate(thinking || '[thinking]', ASSISTANT_MAX) },
    });
  }
  if (hasText) {
    /** @type {Record<string, unknown>} */
    const messageAttrs = { 'gen_ai.message.content': truncate(text, ASSISTANT_MAX) };
    if (stopReason) {
      messageAttrs['agent_trace.response.stop_reason'] =
        STOP_REASON_TO_UI[stopReason] ?? stopReason;
    }
    events.push({ name: 'gen_ai.assistant.message', timeMs: endTs, attributes: messageAttrs });
  }

  const span = {
    spanId,
    parentSpanId,
    name: 'inference',
    startMs,
    endMs,
    durationMs: endMs - startMs,
    attributes: {
      'gen_ai.request.model': typeof m.model === 'string' ? m.model : '',
      'agent_trace.inference.request_id':
        typeof m.responseId === 'string' ? m.responseId : entry.id,
      'gen_ai.usage.input_tokens': usage.input,
      'gen_ai.usage.output_tokens': usage.output,
      'gen_ai.usage.cache_read_tokens': usage.cacheRead,
      'gen_ai.usage.cache_creation_tokens': usage.cacheCreation,
      'agent_trace.inference.kind': kind,
      'agent_trace.pi.stop_reason': stopReason,
      'agent_trace.transcript.row_index': entry._rowIndex,
      'agent_trace.transcript.row_index_end': entry._rowIndex,
    },
    events,
    children: toolCalls.map((b) => buildToolSpan(b, entry, resultsById, spanId)),
  };
  return { span, usage };
}

/**
 * @param {number} turnNumber
 * @param {TurnSlice} slice
 * @param {{
 *   sessionId: string,
 *   sessionAttrs: Record<string, unknown>,
 *   cwd: string | null,
 *   resultsById: Map<string, PiEntry>,
 *   isRunning: boolean,
 * }} ctx
 * @returns {Turn}
 */
function buildTurn(turnNumber, slice, ctx) {
  const turnSpanId = nextSpanId();
  const opener = slice.entries[0];
  /** @type {string} */
  let userPrompt = '';
  if (slice.trigger === 'user') userPrompt = userPromptOf(opener.message);
  else if (slice.trigger === 'custom_message') {
    userPrompt = `[pi:${typeof opener.customType === 'string' ? opener.customType : 'custom'}]`;
  }

  /** @type {SpanNode[]} */
  const inferences = [];
  const totals = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  let requestCount = 0;
  let toolCount = 0;
  let errorCount = 0;
  let modelErrorCount = 0;
  let aborted = false;
  /** @type {string | null} */
  let model = null;
  let prevTs = 0;

  for (const e of slice.entries) {
    if (isMessage(e)) {
      const m = e.message;
      if (m.role === 'toolResult' && m.isError === true) errorCount++;
      if (m.role === 'assistant') {
        if (m.stopReason === 'aborted') aborted = true;
        if (m.stopReason === 'error') modelErrorCount++;
        const built = buildInferenceSpan(e, prevTs, ctx.resultsById, turnSpanId);
        if (built) {
          inferences.push(built.span);
          totals.input += built.usage.input;
          totals.output += built.usage.output;
          totals.cacheRead += built.usage.cacheRead;
          totals.cacheCreation += built.usage.cacheCreation;
          if (built.usage.total > 0) requestCount++;
          toolCount += built.span.children.length;
          if (typeof m.model === 'string' && m.model) model = m.model;
        }
      }
    }
    const ts = toMs(e.timestamp);
    if (ts) prevTs = ts;
  }

  const startMs = toMs(opener.timestamp);
  const lastEntry = slice.entries[slice.entries.length - 1];
  let endMs = toMs(lastEntry.timestamp);
  if (endMs <= startMs) endMs = startMs + 1;

  /** @type {Record<string, unknown>} */
  const attributes = {
    ...ctx.sessionAttrs,
    'agent_trace.event_type': 'turn',
    'agent_trace.turn.number': turnNumber,
    'agent_trace.prompt': truncate(userPrompt),
    'agent_trace.turn.is_meta': false,
    'agent_trace.turn.input_tokens': totals.input,
    'agent_trace.turn.output_tokens': totals.output,
    'agent_trace.turn.cache_read_tokens': totals.cacheRead,
    'agent_trace.turn.cache_creation_tokens': totals.cacheCreation,
    'agent_trace.turn.context_tokens': totals.input + totals.cacheRead + totals.cacheCreation,
    'agent_trace.turn.request_count': requestCount,
    'agent_trace.turn.attachment_count': 0,
    'agent_trace.turn.attachment_bytes': 0,
    'agent_trace.transcript.row_index': opener._rowIndex,
    'agent_trace.transcript.row_index_end': lastEntry._rowIndex,
  };
  if (model) attributes['gen_ai.request.model'] = model;
  if (slice.trigger === 'custom_message') attributes['agent_trace.turn.trigger'] = 'custom_message';
  if (aborted) attributes['agent_trace.turn.aborted'] = true;
  if (modelErrorCount > 0) attributes['agent_trace.pi.model_error_count'] = modelErrorCount;
  if (ctx.isRunning) attributes['agent_trace.in_progress'] = true;

  return {
    kind: 'turn',
    traceId: `${ctx.sessionId}:turn:${turnNumber}`,
    sessionId: ctx.sessionId,
    turnNumber,
    userPrompt,
    startMs,
    endMs,
    durationMs: endMs - startMs,
    toolCount,
    errorCount,
    isMeta: false,
    isRunning: ctx.isRunning,
    model,
    finalMode: null,
    cwd: ctx.cwd,
    contextTokens: totals,
    attachmentCount: 0,
    attachmentBytes: 0,
    root: {
      spanId: turnSpanId,
      parentSpanId: null,
      name: `turn:${turnNumber}`,
      startMs,
      endMs,
      durationMs: endMs - startMs,
      attributes,
      events: [],
      children: inferences,
    },
  };
}

/** @param {PiEntry[]} activeEntries */
function endsRunning(activeEntries) {
  for (let i = activeEntries.length - 1; i >= 0; i--) {
    const e = activeEntries[i];
    if (!isMessage(e)) continue;
    const { role, stopReason } = e.message;
    if (role === 'user' || role === 'toolResult') return true;
    return role === 'assistant' && stopReason === 'toolUse';
  }
  return false;
}

/**
 * @param {string} sessionId
 * @param {PiBundle} bundle
 * @returns {TraceSummary[]}
 */
export function toTraces(sessionId, bundle) {
  const entries = bundle?.entries ?? [];
  const { path: activeEntries, truncated } = activePath(entries);
  if (activeEntries.length === 0) return [];

  const header = entries.find((e) => e.type === 'session');
  const cwd = typeof header?.cwd === 'string' ? header.cwd : null;
  const parentPath = typeof header?.parentSession === 'string' ? header.parentSession : null;
  const parentFile = parentPath ? path.basename(parentPath) : null;

  /** @type {Record<string, unknown>} */
  const sessionAttrs = {
    'session.id': sessionId,
    'agent_trace.harness': 'pi',
  };
  if (cwd) sessionAttrs['agent_trace.session.cwd'] = cwd;
  if (parentFile) {
    // WHY the basename fallback: an unparseable parent name must still mark this session as a child
    sessionAttrs['agent_trace.pi.parent_session'] =
      sessionIdFromFileName(parentFile) ?? parentFile.replace(/\.jsonl$/, '');
  }
  if (truncated) sessionAttrs['agent_trace.pi.path_truncated'] = true;

  /** @type {Map<string, PiEntry>} */
  const resultsById = new Map();
  for (const e of activeEntries) {
    if (!isMessage(e) || e.message.role !== 'toolResult') continue;
    const id = e.message.toolCallId;
    if (typeof id === 'string' && !resultsById.has(id)) resultsById.set(id, e);
  }

  const slices = sliceTurns(activeEntries);
  const running = endsRunning(activeEntries);
  return slices.map((slice, i) =>
    buildTurn(i + 1, slice, {
      sessionId,
      sessionAttrs,
      cwd,
      resultsById,
      isRunning: running && i === slices.length - 1,
    }),
  );
}

export { activePath, sliceTurns };
