// @ts-check
// pi session JSONL reader. Pure I/O — the transformer does all shaping.
//
// Each line is an entry `{ type, id, parentId, timestamp, ... }`; line 1 is
// the `session` header. Read tolerance (CLAUDE.md §3): drop the torn final
// line, skip unparseable rows, keep unknown entry types (the transformer
// ignores what it doesn't know).
//
// Read-boundary filter: `system` messages carry pi's full system prompt
// (`content` plus `sections`); /api/transcript serves the raw bundle, so the
// text is replaced with a marker here, before anything downstream sees it.

import fs from 'node:fs';

/** @typedef {import('../adapters/types.d.ts').SessionFile} SessionFile */
/** @typedef {Record<string, any>} PiEntry */
/** @typedef {{ entries: PiEntry[] }} PiBundle */

const SYSTEM_MARKER = '[filtered: system prompt]';

/**
 * @param {string} filePath
 * @returns {PiEntry[]}
 */
function readJsonl(filePath) {
  /** @type {PiEntry[]} */
  const out = [];
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return out;
  }
  const complete = raw.endsWith('\n') ? raw : raw.slice(0, raw.lastIndexOf('\n') + 1);
  for (const text of complete.split('\n')) {
    if (!text) continue;
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object') continue;
      parsed._rowIndex = out.length;
      out.push(parsed);
    } catch {
      // Silent skip — torn writes or corrupt rows shouldn't fail the session.
    }
  }
  return out;
}

/** @param {PiEntry} entry */
function filterSystemPrompt(entry) {
  const m = entry?.message;
  if (entry?.type !== 'message' || m?.role !== 'system') return;
  if ('content' in m) m.content = SYSTEM_MARKER;
  if ('sections' in m) m.sections = SYSTEM_MARKER;
}

/**
 * @param {SessionFile} file
 * @returns {PiBundle}
 */
export function readTranscript(file) {
  const entries = readJsonl(file.mainPath);
  for (const e of entries) filterSystemPrompt(e);
  return { entries };
}
