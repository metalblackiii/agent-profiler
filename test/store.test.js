// @ts-nocheck
// Unit tests for lib/traces/store.js's selectSessionSlice — the pure
// selection logic behind getAllTraces()'s recency cap and its `sessionId`
// direct-lookup bypass. Deliberately does not exercise getAllTraces() itself
// (that requires enumerate()/discover() hitting real adapters on disk); this
// covers the selection logic without needing real session files.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectSessionSlice } from '../lib/traces/store.js';

/** @param {string} sessionId @param {number} mtimeMs @param {number} [sizeBytes] */
function entry(sessionId, mtimeMs, sizeBytes = 100) {
  return { adapter: { id: 'test-adapter' }, file: { sessionId, mtimeMs, sizeBytes } };
}

test('selectSessionSlice sorts by mtime desc and caps to limit when sessionId is absent', () => {
  const all = [entry('a', 1000), entry('b', 3000), entry('c', 2000)];
  const top = selectSessionSlice(all, 2);
  assert.deepEqual(
    top.map((e) => e.file.sessionId),
    ['b', 'c'],
  );
});

test('selectSessionSlice bypasses limit entirely when sessionId is set', () => {
  // 'old' would fall outside a limit of 1 by recency alone.
  const all = [entry('recent', 5000), entry('old', 100)];
  const top = selectSessionSlice(all, 1, 'old');
  assert.deepEqual(
    top.map((e) => e.file.sessionId),
    ['old'],
  );
});

test('selectSessionSlice returns every adapter match for a collided sessionId, not just one', () => {
  const all = [
    { adapter: { id: 'claude-code' }, file: { sessionId: 'dup', mtimeMs: 1, sizeBytes: 10 } },
    { adapter: { id: 'codex' }, file: { sessionId: 'dup', mtimeMs: 2, sizeBytes: 20 } },
  ];
  const top = selectSessionSlice(all, 200, 'dup');
  assert.equal(top.length, 2);
  assert.deepEqual(top.map((e) => e.adapter.id).sort(), ['claude-code', 'codex']);
});

test('selectSessionSlice returns an empty array when sessionId matches nothing', () => {
  const top = selectSessionSlice([entry('a', 1000)], 200, 'nonexistent');
  assert.deepEqual(top, []);
});

test('selectSessionSlice does not mutate the input array', () => {
  const all = [entry('a', 1000), entry('b', 3000)];
  const original = [...all];
  selectSessionSlice(all, 200);
  assert.deepEqual(all, original);
});
