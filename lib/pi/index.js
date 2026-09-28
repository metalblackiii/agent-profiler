// @ts-check
// pi coding-agent harness adapter. Reads <root>/--<cwd>--/<ts>_<id>.jsonl
// (root per ./sessions.js) and emits TraceSummary[] via the pure
// transformer in ./traces.js.

import { listSessions } from './sessions.js';
import { toTraces } from './traces.js';
import { readTranscript } from './transcripts.js';

/** @typedef {import('../adapters/types.d.ts').HarnessAdapter} HarnessAdapter */
/** @typedef {import('./transcripts.js').PiBundle} PiBundle */

/** @type {HarnessAdapter} */
export const pi = {
  id: 'pi',
  discover() {
    return listSessions();
  },
  read(file) {
    return readTranscript(file);
  },
  transform(sessionId, bundle) {
    return toTraces(sessionId, /** @type {PiBundle} */ (bundle));
  },
};
