// @ts-check
// Locate pi coding-agent session transcripts on disk.
//
// On-disk layout (pi 0.87, session format v3):
//   <root>/--<encoded-cwd>--/<timestamp>_<sessionId>.jsonl
//
// Root resolution mirrors pi's own env vars: PI_CODING_AGENT_SESSION_DIR,
// else $PI_CODING_AGENT_DIR/sessions, else ~/.pi/agent/sessions. Roots set
// by `--session-dir` or the settings `sessionDir` key are invisible to a
// standalone server and are not covered.
//
// Child sessions (header `parentSession`: subagents, forks, clones) are
// listed as their own sessions. Discovery reads no file content — the
// transformer tags children from the header (see traces.js).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** @typedef {import('../adapters/types.d.ts').SessionFile} SessionFile */

// `<ts>_<id>.jsonl`. The id is everything after the first `_`: custom
// `--session-id` values are not UUIDs.
const SESSION_FILE_RE = /^[^_]+_(.+)\.jsonl$/;

/** Resolved per call so tests can point the adapter at a temp root. */
export function sessionsRoot() {
  if (process.env.PI_CODING_AGENT_SESSION_DIR) return process.env.PI_CODING_AGENT_SESSION_DIR;
  if (process.env.PI_CODING_AGENT_DIR)
    return path.join(process.env.PI_CODING_AGENT_DIR, 'sessions');
  return path.join(os.homedir(), '.pi', 'agent', 'sessions');
}

/**
 * @param {string} fileName basename of a session file or `parentSession` path
 * @returns {string | null}
 */
export function sessionIdFromFileName(fileName) {
  const m = fileName.match(SESSION_FILE_RE);
  return m ? m[1] : null;
}

/** @returns {SessionFile[]} */
export function listSessions() {
  const root = sessionsRoot();
  /** @type {fs.Dirent[]} */
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  /** @type {SessionFile[]} */
  const out = [];
  for (const projectDir of projectDirs) {
    if (!projectDir.isDirectory()) continue;
    const dirPath = path.join(root, projectDir.name);
    /** @type {fs.Dirent[]} */
    let entries;
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const sessionId = sessionIdFromFileName(entry.name);
      if (!sessionId) continue;
      const mainPath = path.join(dirPath, entry.name);
      let stat;
      try {
        stat = fs.statSync(mainPath);
      } catch {
        continue;
      }
      out.push({
        harness: 'pi',
        sessionId,
        mainPath,
        mtimeMs: stat.mtimeMs,
        sizeBytes: stat.size,
      });
    }
  }
  out.sort((a, b) => {
    if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
    return a.sessionId.localeCompare(b.sessionId);
  });
  return out;
}
