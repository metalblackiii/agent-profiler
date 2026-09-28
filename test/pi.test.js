// @ts-nocheck
// pi adapter — transformer-focused tests. In-memory synthetic entries drive
// the transformer directly; one temp-dir test covers discovery + read.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pi } from '../lib/pi/index.js';
import { toTraces } from '../lib/pi/traces.js';

const SID = '01a00000-0000-7000-8000-000000000001';

/** Builds a linear chain: each entry's parentId is the previous entry's id. */
function chain(...specs) {
  const entries = [{ type: 'session', version: 3, id: SID, timestamp: iso(0), cwd: '/tmp/proj' }];
  let prev = null;
  specs.forEach((spec, i) => {
    const id = spec.id ?? `e${i + 1}`;
    entries.push({
      timestamp: iso(i + 1),
      ...spec,
      id,
      parentId: 'parentId' in spec ? spec.parentId : prev,
    });
    prev = id;
  });
  return entries.map((e, i) => ({ ...e, _rowIndex: i }));
}

function iso(seconds) {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
}

const user = (text) => ({
  type: 'message',
  message: { role: 'user', content: [{ type: 'text', text }] },
});

const usage = (input, output, cacheRead = 0, cacheWrite = 0) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
  totalTokens: input + output + cacheRead + cacheWrite,
});

const assistant = ({
  stopReason = 'stop',
  text,
  toolCalls = [],
  u = usage(10, 5),
  model = 'gpt-test',
} = {}) => ({
  type: 'message',
  message: {
    role: 'assistant',
    model,
    stopReason,
    usage: u,
    content: [
      ...(text ? [{ type: 'text', text }] : []),
      ...toolCalls.map((id) => ({
        type: 'toolCall',
        id,
        name: 'bash',
        arguments: { command: 'ls' },
      })),
    ],
  },
});

const toolResult = (toolCallId, isError = false) => ({
  type: 'message',
  message: {
    role: 'toolResult',
    toolCallId,
    toolName: 'bash',
    isError,
    content: [{ type: 'text', text: 'out' }],
  },
});

const bundle = (entries) => ({ entries });

test('AC-1: turns, tools, errors, tokens, request count', () => {
  const entries = chain(
    user('first'),
    assistant({ stopReason: 'toolUse', toolCalls: ['c1', 'c2'], u: usage(100, 10, 1000, 50) }),
    toolResult('c1'),
    toolResult('c2', true),
    assistant({ text: 'done', u: usage(20, 30, 1100, 0) }),
    user('second'),
    assistant({ text: 'ok', u: usage(5, 5) }),
  );
  const traces = toTraces(SID, bundle(entries));
  assert.equal(traces.length, 2);
  const [t1, t2] = traces;
  assert.equal(t1.userPrompt, 'first');
  assert.equal(t1.toolCount, 2);
  assert.equal(t2.toolCount, 0);
  assert.equal(t1.errorCount, 1);
  assert.equal(t2.errorCount, 0);
  assert.equal(t1.model, 'gpt-test');
  assert.equal(t1.cwd, '/tmp/proj');
  assert.deepEqual(t1.contextTokens, {
    input: 120,
    output: 40,
    cacheRead: 2100,
    cacheCreation: 50,
  });
  assert.equal(t1.root.attributes['agent_trace.turn.context_tokens'], 120 + 2100 + 50);
  assert.equal(t1.root.attributes['agent_trace.turn.request_count'], 2);
  assert.equal(t1.root.children.length, 2);
  const [inf1] = t1.root.children;
  assert.equal(inf1.name, 'inference');
  assert.deepEqual(
    inf1.children.map((c) => c.attributes['agent_trace.tool.use_id']),
    ['c1', 'c2'],
  );
  assert.equal(inf1.children[1].status?.code, 2);
  assert.equal(t1.isRunning, false);
  assert.equal(t1.root.attributes['agent_trace.harness'], 'pi');
  assert.equal(t1.root.attributes['session.id'], SID);
});

test('AC-2: only the active branch contributes', () => {
  // e1 user → e2 assistant (branch A) ; e1 → e3 assistant (branch B, last in file)
  const entries = chain(
    user('q'),
    assistant({ stopReason: 'toolUse', toolCalls: ['a1'], u: usage(999, 999) }),
    { ...assistant({ text: 'branch b', u: usage(7, 3) }), parentId: 'e1' },
  );
  const [t] = toTraces(SID, bundle(entries));
  assert.equal(t.toolCount, 0);
  assert.equal(t.contextTokens.input, 7);
  assert.equal(t.root.children.length, 1);
  assert.equal(t.root.attributes['agent_trace.pi.path_truncated'], undefined);
});

test('AC-5/FR-5a: stop → end_turn, length → max_tokens on the message event', () => {
  const entries = chain(
    user('a'),
    assistant({ text: 'fin' }),
    user('b'),
    assistant({ stopReason: 'length', text: 'cut' }),
  );
  const [t1, t2] = toTraces(SID, bundle(entries));
  const stopOf = (t) =>
    t.root.children[0].events.find((e) => e.name === 'gen_ai.assistant.message').attributes[
      'agent_trace.response.stop_reason'
    ];
  assert.equal(stopOf(t1), 'end_turn');
  assert.equal(stopOf(t2), 'max_tokens');
  assert.equal(t1.root.children[0].attributes['agent_trace.pi.stop_reason'], 'stop');
});

test('AC-6: zero-usage abort without toolCall adds no inference, flags aborted', () => {
  const entries = chain(user('q'), assistant({ stopReason: 'aborted', u: usage(0, 0) }));
  const [t] = toTraces(SID, bundle(entries));
  assert.equal(t.root.children.length, 0);
  assert.equal(t.errorCount, 0);
  assert.equal(t.root.attributes['agent_trace.turn.aborted'], true);
});

test('AC-7: zero-usage abort with an unpaired toolCall', () => {
  const entries = chain(
    user('q'),
    assistant({ stopReason: 'aborted', toolCalls: ['x1'], u: usage(0, 0) }),
  );
  const [t] = toTraces(SID, bundle(entries));
  assert.equal(t.root.children.length, 1);
  const tool = t.root.children[0].children[0];
  assert.equal(tool.attributes['agent_trace.tool.no_result'], true);
  assert.equal(t.toolCount, 1);
  assert.equal(t.root.attributes['agent_trace.turn.request_count'], 0);
});

test('FR-7: provider errors count on the root, not errorCount', () => {
  const entries = chain(user('q'), assistant({ stopReason: 'error', u: usage(0, 0) }));
  const [t] = toTraces(SID, bundle(entries));
  assert.equal(t.errorCount, 0);
  assert.equal(t.root.attributes['agent_trace.pi.model_error_count'], 1);
});

test('AC-8: custom_message after stop opens an extension-triggered turn', () => {
  const entries = chain(
    user('start job'),
    assistant({ text: 'started' }),
    { type: 'custom_message', customType: 'job-done', content: 'x', display: true },
    assistant({ text: 'job finished' }),
  );
  const traces = toTraces(SID, bundle(entries));
  assert.equal(traces.length, 2);
  assert.equal(traces[1].userPrompt, '[pi:job-done]');
  assert.equal(traces[1].root.attributes['agent_trace.turn.trigger'], 'custom_message');
  assert.equal(traces[0].endMs, Date.parse(iso(2)));
});

test('custom_message mid-turn (not after stop) does not open a turn', () => {
  const entries = chain(
    user('q'),
    assistant({ stopReason: 'toolUse', toolCalls: ['c1'] }),
    { type: 'custom_message', customType: 'ctx', content: 'x' },
    toolResult('c1'),
    assistant({ text: 'done' }),
  );
  assert.equal(toTraces(SID, bundle(entries)).length, 1);
});

test('custom_message after a non-stop assistant (error retry) does not open a turn', () => {
  const entries = chain(
    user('q'),
    assistant({ stopReason: 'error', u: usage(0, 0) }),
    { type: 'custom_message', customType: 'retry', content: 'x' },
    assistant({ text: 'recovered' }),
  );
  const traces = toTraces(SID, bundle(entries));
  assert.equal(traces.length, 1);
  assert.equal(traces[0].root.attributes['agent_trace.pi.model_error_count'], 1);
});

test('AC-9: dangling parentId yields the recovered suffix, flagged', () => {
  const entries = chain(
    user('lost'),
    assistant({ text: 'x' }),
    { ...user('kept'), parentId: 'missing' },
    assistant({ text: 'y' }),
  );
  const traces = toTraces(SID, bundle(entries));
  assert.equal(traces.length, 1);
  assert.equal(traces[0].userPrompt, 'kept');
  assert.equal(traces[0].root.attributes['agent_trace.pi.path_truncated'], true);
});

test('FR-3: duplicate parent id stops the walk, flagged', () => {
  const entries = chain(
    user('first copy'),
    { ...user('second copy'), id: 'e1', parentId: null },
    { ...user('kept'), parentId: 'e1' },
    assistant({ text: 'y' }),
  );
  const traces = toTraces(SID, bundle(entries));
  assert.deepEqual(
    traces.map((t) => t.userPrompt),
    ['kept'],
  );
  assert.equal(traces[0].root.attributes['agent_trace.pi.path_truncated'], true);
});

test('FR-3: parent cycle terminates, flagged', () => {
  const entries = chain(
    { ...user('a'), id: 'x', parentId: 'y' },
    { ...assistant({ text: 'b' }), id: 'y', parentId: 'x' },
  );
  const traces = toTraces(SID, bundle(entries));
  assert.equal(traces.length, 1);
  assert.equal(traces[0].root.attributes['agent_trace.pi.path_truncated'], true);
});

test('truncation landing on an assistant entry opens an implicit, promptless turn', () => {
  const entries = chain(user('lost'), {
    ...assistant({ text: 'orphaned reply' }),
    parentId: 'missing',
  });
  const [t] = toTraces(SID, bundle(entries));
  assert.equal(t.userPrompt, '');
  assert.equal(t.root.children.length, 1);
  assert.equal(t.root.attributes['agent_trace.pi.path_truncated'], true);
});

test('FR-6a: a trailing bashExecution message is a non-running final state', () => {
  const entries = chain(
    user('q'),
    assistant({ stopReason: 'toolUse', toolCalls: ['c1'] }),
    toolResult('c1'),
    {
      type: 'message',
      message: { role: 'bashExecution', command: 'ls', output: '' },
    },
  );
  assert.equal(toTraces(SID, bundle(entries))[0].isRunning, false);
});

test('FR-6a: running when the path ends on a toolResult, user, or toolUse', () => {
  const pending = chain(
    user('q'),
    assistant({ stopReason: 'toolUse', toolCalls: ['c1'] }),
    toolResult('c1'),
  );
  const [t] = toTraces(SID, bundle(pending));
  assert.equal(t.isRunning, true);
  assert.equal(t.root.attributes['agent_trace.in_progress'], true);
  const done = chain(user('q'), assistant({ text: 'a' }));
  assert.equal(toTraces(SID, bundle(done))[0].isRunning, false);
});

test('FR-4: skill expansion keeps only the user text', () => {
  const entries = chain(
    user('<skill name="x">\nbody\n</skill>\n\nreal ask'),
    assistant({ text: 'a' }),
  );
  assert.equal(toTraces(SID, bundle(entries))[0].userPrompt, 'real ask');
});

test('AC-10: discovery lists parent and child separately; child tagged with parent id', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-sessions-'));
  const prev = process.env.PI_CODING_AGENT_SESSION_DIR;
  process.env.PI_CODING_AGENT_SESSION_DIR = root;
  try {
    const dir = path.join(root, '--tmp-proj--');
    fs.mkdirSync(dir);
    const parentId = '01a00000-0000-7000-8000-00000000000a';
    const childId = 'custom-child-id';
    const parentPath = path.join(dir, `2026-01-01T00-00-00-000Z_${parentId}.jsonl`);
    const childPath = path.join(dir, `2026-01-01T00-01-00-000Z_${childId}.jsonl`);
    const write = (p, header) => {
      const body = chain(user('task'), assistant({ text: 'ok' }))
        .slice(1)
        .map(({ _rowIndex, ...e }) => e);
      fs.writeFileSync(p, `${[header, ...body].map((e) => JSON.stringify(e)).join('\n')}\n`);
    };
    write(parentPath, {
      type: 'session',
      version: 3,
      id: parentId,
      timestamp: iso(0),
      cwd: '/tmp/proj',
    });
    write(childPath, {
      type: 'session',
      version: 3,
      id: childId,
      timestamp: iso(0),
      cwd: '/tmp/proj',
      parentSession: parentPath,
    });
    fs.writeFileSync(path.join(dir, 'not-a-session.txt'), 'x');

    const files = pi.discover();
    assert.deepEqual(files.map((f) => f.sessionId).sort(), [childId, parentId].sort());
    const traceOf = (id) => {
      const f = files.find((x) => x.sessionId === id);
      return pi.transform(id, pi.read(f));
    };
    const childTraces = traceOf(childId);
    assert.ok(childTraces.length > 0);
    for (const t of childTraces)
      assert.equal(t.root.attributes['agent_trace.pi.parent_session'], parentId);
    for (const t of traceOf(parentId)) {
      assert.equal(t.root.attributes['agent_trace.pi.parent_session'], undefined);
    }
  } finally {
    // WARNING: assigning `undefined` to a process.env key stores the string "undefined"
    if (prev === undefined) Reflect.deleteProperty(process.env, 'PI_CODING_AGENT_SESSION_DIR');
    else process.env.PI_CODING_AGENT_SESSION_DIR = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('FR-2: read drops a torn final line and filters system prompts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-read-'));
  try {
    const p = path.join(dir, `2026-01-01T00-00-00-000Z_${SID}.jsonl`);
    const rows = [
      { type: 'session', version: 3, id: SID, timestamp: iso(0), cwd: '/tmp/proj' },
      {
        type: 'message',
        id: 'e1',
        parentId: null,
        timestamp: iso(1),
        message: { role: 'system', content: 'SECRET PROMPT', sections: { a: 'SECRET' } },
      },
    ];
    fs.writeFileSync(
      p,
      `${rows.map((r) => JSON.stringify(r)).join('\n')}\nnot json\n{"type":"message","id":"e2"`,
    );
    const { entries } = pi.read({
      harness: 'pi',
      sessionId: SID,
      mainPath: p,
      mtimeMs: 0,
      sizeBytes: 0,
    });
    assert.equal(entries.length, 2);
    assert.ok(!JSON.stringify(entries).includes('SECRET'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('empty or header-only bundles return []', () => {
  assert.deepEqual(toTraces(SID, bundle([])), []);
  assert.deepEqual(toTraces(SID, bundle(chain())), []);
});
