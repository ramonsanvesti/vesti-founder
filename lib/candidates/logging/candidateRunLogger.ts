

/*
  DRESZI — Candidate run structured logger

  Goals
  - Emit exactly one structured summary object per run.
  - Keep per-candidate logs behind an explicit debug flag.
  - Provide reason-code counting utilities.

  This module is intentionally dependency-free.
*/

import type { ReasonCodeString } from "../detection/config";
import type { CandidateRunSummary, CandidateRunCounts, CandidateRunTimingsMs, CandidateRunDecisions } from "../detection/types";

export interface StructuredLogger {
  (obj: unknown): void;
}

export interface CandidateRunLoggerInit {
  readonly request_id: string;
  readonly wardrobe_video_id: string;
  readonly user_id: string;
  readonly config_version: string;
  readonly log?: StructuredLogger;
  readonly debug?: boolean;
}

export interface CandidateRunLogger {
  addReason(code: ReasonCodeString): void;
  addReasons(codes: ReadonlyArray<ReasonCodeString>): void;

  /** Count a dedupe event */
  incDedupedPhash(): void;
  incDedupedEmbedding(): void;

  /** Record selection decisions */
  addSelectedFrameTs(ts_ms: number): void;
  setFallbackUsed(v: boolean): void;
  setEarlyExitReason(reason: string | null): void;

  /** Optional per-candidate debug logs */
  debugCandidate(obj: unknown): void;

  /** Build and emit one summary log */
  finalizeAndLog(params: {
    counts: CandidateRunCounts;
    timings_ms: CandidateRunTimingsMs;
  }): CandidateRunSummary;
}

function asInt(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.trunc(n));
}

export function createCandidateRunLogger(init: CandidateRunLoggerInit): CandidateRunLogger {
  const reasonCounts: Record<string, number> = Object.create(null) as Record<string, number>;

  let deduped_phash = 0;
  let deduped_embedding = 0;

  const selectedFrameTs: number[] = [];
  let fallback_used = false;
  let early_exit_reason: string | null = null;

  const log: StructuredLogger | undefined = init.log;
  const debugEnabled = Boolean(init.debug);

  const addReason = (code: ReasonCodeString): void => {
    reasonCounts[code] = (reasonCounts[code] ?? 0) + 1;
  };

  const addReasons = (codes: ReadonlyArray<ReasonCodeString>): void => {
    for (const c of codes) addReason(c);
  };

  const debugCandidate = (obj: unknown): void => {
    if (!debugEnabled || !log) return;
    log({
      kind: "dreszi.candidates.debug",
      request_id: init.request_id,
      wardrobe_video_id: init.wardrobe_video_id,
      user_id: init.user_id,
      payload: obj
    });
  };

  const addSelectedFrameTs = (ts_ms: number): void => {
    const t = asInt(ts_ms);
    // Avoid duplicates but keep deterministic order
    if (!selectedFrameTs.includes(t)) selectedFrameTs.push(t);
  };

  const setFallbackUsed = (v: boolean): void => {
    fallback_used = Boolean(v);
  };

  const setEarlyExitReason = (reason: string | null): void => {
    early_exit_reason = reason;
  };

  const incDedupedPhash = (): void => {
    deduped_phash += 1;
  };

  const incDedupedEmbedding = (): void => {
    deduped_embedding += 1;
  };

  const finalizeAndLog = (params: {
    counts: CandidateRunCounts;
    timings_ms: CandidateRunTimingsMs;
  }): CandidateRunSummary => {
    const decisions: CandidateRunDecisions = {
      selected_frame_ts_ms: selectedFrameTs,
      fallback_used,
      early_exit_reason
    };

    const mergedCounts: CandidateRunCounts = {
      ...params.counts,
      deduped_phash: params.counts.deduped_phash + deduped_phash,
      deduped_embedding: params.counts.deduped_embedding + deduped_embedding
    };

    const summary: CandidateRunSummary = {
      request_id: init.request_id,
      wardrobe_video_id: init.wardrobe_video_id,
      user_id: init.user_id,
      config_version: init.config_version,
      counts: mergedCounts,
      timings_ms: params.timings_ms,
      decisions,
      reason_code_counts: reasonCounts as CandidateRunSummary["reason_code_counts"]
    };

    if (log) {
      log({
        kind: "dreszi.candidates.summary",
        ...summary
      });
    }

    return summary;
  };

  return {
    addReason,
    addReasons,
    incDedupedPhash,
    incDedupedEmbedding,
    addSelectedFrameTs,
    setFallbackUsed,
    setEarlyExitReason,
    debugCandidate,
    finalizeAndLog
  };
}

/**
 * Utility to count reason codes from multiple sources (e.g., frame scoring + candidate decisions).
 */
export function mergeReasonCodeCounts(
  ...maps: ReadonlyArray<Readonly<Record<ReasonCodeString, number>>>
): Readonly<Record<ReasonCodeString, number>> {
  const out: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const m of maps) {
    for (const [k, v] of Object.entries(m)) {
      const n = asInt(v);
      out[k] = (out[k] ?? 0) + n;
    }
  }
  return out as Readonly<Record<ReasonCodeString, number>>;
}