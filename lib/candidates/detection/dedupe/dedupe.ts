

/*
  DRESZI — 2-stage dedupe (pHash + embedding)

  Requirements
  - Deterministic across retries.
  - Stage 1: fast pHash Hamming distance.
  - Stage 2: embedding cosine similarity.
  - Config-driven thresholds and caps.
  - Emits reason codes for each suppression decision.

  Notes
  - This module is designed to operate on already-generated candidate crops.
  - If embedding vectors are not precomputed, a pluggable Embedder can compute them lazily
    from grayscale pixels (bounded by early exits and a small cache).
*/

import type { CandidateDetectionConfig, ReasonCodeString } from "../config";
import { ReasonCode } from "../config";
import type { Hash64Hex } from "../scoring/hashing/phash";
import { hammingDistance64Hex } from "../scoring/hashing/phash";
import type { Embedder } from "../embeddings/embedder";
import { cosineSimilarity } from "../embeddings/embedder";

export interface DedupeEmbedInput {
  readonly grayscale: Uint8Array;
  readonly width: number;
  readonly height: number;
}

export interface CandidateForDedupe {
  readonly candidate_id: string;
  /** Perceptual hash of the encoded crop (or derived from pixels) */
  readonly phash: Hash64Hex;
  /** Higher is better. Used only for deterministic tie-breaking if needed. */
  readonly score: number;

  /** Optional embedding vector (already computed). */
  readonly embedding_vector?: ReadonlyArray<number>;
  /** If embedding_vector missing, provide input so we can compute lazily. */
  readonly embedding_input?: DedupeEmbedInput;

  /** Mutable reason codes list owned by caller; we will append codes. */
  readonly reason_codes: ReasonCodeString[];
}

export interface DedupeCounts {
  readonly deduped_phash: number;
  readonly deduped_embedding: number;
  readonly embed_computed: number;
}

export interface DedupeResult {
  readonly kept: ReadonlyArray<CandidateForDedupe>;
  readonly suppressed: ReadonlyArray<CandidateForDedupe>;
  readonly counts: DedupeCounts;
  /** Populated when we stop early due to caps/time. */
  readonly early_exit_reason: string | null;
}

// Support multiple config shapes without leaking `any`.
type CfgDedupeCompat = CandidateDetectionConfig & {
  readonly max_candidates?: number;
  readonly dedupe?: {
    readonly phash_hamming_threshold?: number;
    readonly embedding_cosine_threshold?: number;
    readonly max_candidates?: number;
  };
  readonly embedding?: {
    readonly cosine_threshold?: number;
  };
  readonly embeddings?: {
    readonly cosine_threshold?: number;
  };
};

function getMaxCandidates(cfg: CandidateDetectionConfig): number {
  const c = cfg as CfgDedupeCompat;
  const v = c.dedupe?.max_candidates;
  if (Number.isFinite(v) && (v as number) > 0) return Math.trunc(v as number);

  const top = c.max_candidates;
  if (Number.isFinite(top) && (top as number) > 0) return Math.trunc(top as number);

  return 8;
}

function getPhashHammingThreshold(cfg: CandidateDetectionConfig): number {
  const c = cfg as CfgDedupeCompat;
  const v = c.dedupe?.phash_hamming_threshold;
  if (Number.isFinite(v) && (v as number) >= 0) return Math.trunc(v as number);
  return 10; // beta default
}

function getEmbeddingCosineThreshold(cfg: CandidateDetectionConfig): number {
  const c = cfg as CfgDedupeCompat;
  const v =
    c.dedupe?.embedding_cosine_threshold ??
    c.embeddings?.cosine_threshold ??
    c.embedding?.cosine_threshold;
  if (Number.isFinite(v) && (v as number) > 0) return Number(v);
  return 0.94; // beta default
}

function stableSortCandidates(input: ReadonlyArray<CandidateForDedupe>): CandidateForDedupe[] {
  // Deterministic sort: score desc, then candidate_id asc.
  // (Do not depend on V8 sort stability.)
  return [...input].sort((a, b) => {
    const ds = (b.score || 0) - (a.score || 0);
    if (ds !== 0) return ds > 0 ? 1 : -1;
    if (a.candidate_id < b.candidate_id) return -1;
    if (a.candidate_id > b.candidate_id) return 1;
    return 0;
  });
}

async function getOrComputeEmbedding(
  candidate: CandidateForDedupe,
  embedder: Embedder | null,
  cache: Map<string, ReadonlyArray<number>>
): Promise<{ vec: ReadonlyArray<number> | null; computed: boolean }> {
  if (candidate.embedding_vector && candidate.embedding_vector.length > 0) {
    return { vec: candidate.embedding_vector, computed: false };
  }

  const cached = cache.get(candidate.candidate_id);
  if (cached) return { vec: cached, computed: false };

  if (!embedder) return { vec: null, computed: false };
  if (!candidate.embedding_input) return { vec: null, computed: false };

  const v = await embedder.embedFromGrayscale(
    candidate.embedding_input.grayscale,
    candidate.embedding_input.width,
    candidate.embedding_input.height
  );

  cache.set(candidate.candidate_id, v);
  return { vec: v, computed: true };
}

/**
 * 2-stage dedupe.
 *
 * Deterministic policy
 * - We iterate candidates in stable sorted order.
 * - First candidate wins; later near-duplicates are suppressed.
 *
 * Dedupe rules
 * - Stage 1: if Hamming(pHash) <= threshold => suppress
 * - Stage 2: else if cosine(embedding) >= threshold => suppress
 */
export async function dedupeCandidates(params: {
  candidates: ReadonlyArray<CandidateForDedupe>;
  config: CandidateDetectionConfig;
  embedder?: Embedder | null;
  /** Optional early-exit hook (e.g., time budget) */
  shouldExit?: () => boolean;
}): Promise<DedupeResult> {
  const cfg = params.config;
  const phashThresh = getPhashHammingThreshold(cfg);
  const cosThresh = getEmbeddingCosineThreshold(cfg);
  const maxCandidates = getMaxCandidates(cfg);

  const sorted = stableSortCandidates(params.candidates);

  const kept: CandidateForDedupe[] = [];
  const suppressed: CandidateForDedupe[] = [];

  let deduped_phash = 0;
  let deduped_embedding = 0;
  let embed_computed = 0;
  let early_exit_reason: string | null = null;

  const embedder = params.embedder ?? null;
  const embedCache = new Map<string, ReadonlyArray<number>>();

  for (const cand of sorted) {
    if (params.shouldExit?.()) {
      early_exit_reason = "E_EARLY_EXIT_TIME_BUDGET";
      break;
    }

    if (kept.length >= maxCandidates) {
      early_exit_reason = "E_EARLY_EXIT_MAX_CANDIDATES";
      break;
    }

    let isDuplicate = false;

    // Compare against already-kept candidates
    for (const winner of kept) {
      // Stage 1: pHash
      const dist = hammingDistance64Hex(cand.phash, winner.phash);
      if (dist <= phashThresh) {
        cand.reason_codes.push(ReasonCode.E_DUPLICATE_SUPPRESSED_PHASH);
        deduped_phash += 1;
        isDuplicate = true;
        break;
      }

      // Stage 2: embedding
      const candEmb = await getOrComputeEmbedding(cand, embedder, embedCache);
      const winEmb = await getOrComputeEmbedding(winner, embedder, embedCache);

      if (candEmb.computed) embed_computed += 1;
      if (winEmb.computed) embed_computed += 1;

      if (candEmb.vec && winEmb.vec) {
        const sim = cosineSimilarity(candEmb.vec, winEmb.vec).cosine;
        if (sim >= cosThresh) {
          cand.reason_codes.push(ReasonCode.E_DUPLICATE_SUPPRESSED_EMBEDDING);
          deduped_embedding += 1;
          isDuplicate = true;
          break;
        }
      }
    }

    if (isDuplicate) {
      suppressed.push(cand);
    } else {
      // Ensure at least one reason code exists for this keep decision.
      if (cand.reason_codes.length === 0) cand.reason_codes.push(ReasonCode.E_OK);
      kept.push(cand);

      // Track whether we computed embeddings (bounded). We'll compute on demand in the future anyway.
      if (!cand.embedding_vector && cand.embedding_input && embedder) {
        // Compute now for kept candidates to make downstream deterministic for stage-2 comparisons
        // when later candidates arrive.
        const existing = embedCache.get(cand.candidate_id);
        if (!existing) {
          const emb = await getOrComputeEmbedding(cand, embedder, embedCache);
          if (emb.computed) embed_computed += 1;
        }
      }
    }
  }

  return {
    kept,
    suppressed,
    counts: {
      deduped_phash,
      deduped_embedding,
      embed_computed
    },
    early_exit_reason
  };
}