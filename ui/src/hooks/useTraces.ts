import { filterTraces } from '@/lib/trace-filters';
import type { TraceSummary, TracesResponse } from '@/types';
import { useCallback, useEffect, useRef, useState } from 'react';

export interface UseTracesResult {
  traces: TraceSummary[];
  loading: boolean;
  error: string | null;
  lastFetched: number | null;
  refetch: () => void;
}

/**
 * Polls `/api/traces` for the `AGENT_TRACE_LIMIT` most-recent conversations.
 *
 * `pinnedSessionId` (e.g. from a `?session=` deep link) is the escape hatch
 * for a session outside that recency window: an external tool routinely
 * hands over a bare UUID with no guarantee it's among the most-recent ones,
 * so once the poll settles without it, a one-off `?sessionId=` lookup fetches
 * it directly and merges it in.
 *
 * A normal poll tick replaces `traces` wholesale with the fresh top-N window
 * (see `load` below), which drops the merged-in pinned session again the
 * moment the server-side version fingerprint changes for any unrelated
 * reason — so this re-checks and re-merges on every poll tick, with no "stop
 * retrying after one miss" cache. Deliberately: a deep link can point at a
 * session that doesn't exist *yet* (an external tool handed over a fresh
 * UUID slightly ahead of the adapter discovering it on disk), and a
 * permanent negative cache would make that session unreachable forever
 * rather than just for one poll cycle. The cost is a small extra request per
 * poll tick for the lifetime of an unresolved/typo'd deep link — cheap
 * relative to silently and permanently losing a legitimately-late session.
 *
 * The pinned effect below depends on `lastFetched`, not just `traces` — a
 * quiet top-N window (nothing else changing) leaves `traces`'s reference
 * untouched between polls (see the version-fingerprint check in `load`), but
 * `lastFetched` is stamped unconditionally on every completed poll. Keying
 * on `traces` alone would fire the direct lookup once on mount and then
 * never again as long as the rest of the app stayed quiet.
 */
export function useTraces(pollMs = 5000, pinnedSessionId?: string | null): UseTracesResult {
  const [traces, setTraces] = useState<TraceSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastFetched, setLastFetched] = useState<number | null>(null);
  // Keep the previous server-supplied version. When it matches, skip setTraces
  // so the reference stays stable and downstream useMemo / useEffect chains
  // don't re-run on no-op polls.
  const lastVersionRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/traces');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: TracesResponse = await res.json();
      if (data.version !== lastVersionRef.current) {
        lastVersionRef.current = data.version;
        setTraces(filterTraces(data.traces));
      }
      setLastFetched(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, pollMs);
    return () => clearInterval(interval);
  }, [load, pollMs]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: lastFetched isn't read in the body but is the intentional retry clock — see the doc comment above. A quiet poll (traces unchanged) still stamps lastFetched every tick, which is what re-triggers this effect to retry the direct lookup; traces stays listed too so the early-return below reads a fresh value rather than relying on the two ever landing in the same React batch.
  useEffect(() => {
    if (!pinnedSessionId) return;
    if (traces.some((t) => t.sessionId === pinnedSessionId)) return;

    (async () => {
      try {
        const res = await fetch(`/api/traces?sessionId=${encodeURIComponent(pinnedSessionId)}`);
        if (!res.ok) return;
        const data: TracesResponse = await res.json();
        // Empty means "not found this tick" — not found *ever*. No negative
        // cache: the next poll tick (lastFetched changing) re-runs this
        // effect and retries, in case the session was written moments after
        // this check.
        if (data.traces.length === 0) return;
        const pinned = filterTraces(data.traces);
        setTraces((prev) => {
          const seen = new Set(prev.map((t) => t.traceId));
          return [...prev, ...pinned.filter((t) => !seen.has(t.traceId))];
        });
      } catch {
        // Best-effort direct lookup; polling remains the source of truth.
      }
    })();
  }, [pinnedSessionId, traces, lastFetched]);

  return { traces, loading, error, lastFetched, refetch: load };
}
