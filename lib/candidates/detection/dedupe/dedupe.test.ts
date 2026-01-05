import { describe, it, expect } from "vitest";
import { ReasonCode, buildCandidateDetectionConfig } from "../config";
import * as DedupeMod from "./dedupe";

type UnknownAsyncFn = (...args: ReadonlyArray<unknown>) => Promise<unknown>;

type EmbedderLike = {
  embedFromGrayscale(
    grayscale: Uint8Array,
    width: number,
    height: number
  ): Promise<ReadonlyArray<number>>;
};

function getAsyncFn(mod: unknown, name: string): UnknownAsyncFn {
  if (typeof mod !== "object" || mod === null) throw new Error("module is not an object");
  const v = (mod as Record<string, unknown>)[name];
  if (typeof v !== "function") throw new Error(`Expected export ${name} to be a function`);
  return v as UnknownAsyncFn;
}

function getProp<T>(obj: unknown, key: string): T {
  if (typeof obj !== "object" || obj === null) throw new Error("result is not an object");
  return (obj as Record<string, unknown>)[key] as T;
}

function getCount(res: unknown, key: "deduped_phash" | "deduped_embedding"): number | null {
  if (typeof res !== "object" || res === null) return null;
  const r = res as Record<string, unknown>;
  const direct = r[key];
  if (typeof direct === "number") return direct;
  const counts = r["counts"];
  if (typeof counts === "object" && counts !== null) {
    const v = (counts as Record<string, unknown>)[key];
    if (typeof v === "number") return v;
  }
  return null;
}

function mkCandidate(params: {
  id: string;
  phash: string;
  score: number;
  ts: number;
  withEmbeddingInput?: boolean;
}): Record<string, unknown> {
  return {
    candidate_id: params.id,
    wardrobe_video_id: "vid_1",
    user_id: "user_1",
    frame_ts_ms: params.ts,

    // Dedupe stage-1
    phash: params.phash,

    // Ranking signal (tests keep it simple)
    score: params.score,
    rank_score: params.score,

    // Dedupe mutates this
    reason_codes: [ReasonCode.E_OK],

    // Embedding stage-2
    embedding_vector: undefined,
    embedding_model: null,
    embedding_input: params.withEmbeddingInput
      ? {
          grayscale: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
          width: 2,
          height: 4
        }
      : undefined
  };
}

// Deterministic toy embedder: always returns the same vector so cosine similarity is 1.0.
const FakeEmbedder: EmbedderLike = {
  async embedFromGrayscale(_grayscale: Uint8Array, _width: number, _height: number) {
    return [1, 0];
  }
};

async function runDedupe(params: {
  candidates: ReadonlyArray<Record<string, unknown>>;
  config: ReturnType<typeof buildCandidateDetectionConfig>;
  embedder: EmbedderLike | null;
}): Promise<unknown> {
  const fn = getAsyncFn(DedupeMod, "dedupeCandidates");

  // Known param shapes we may support.
  // Your implementation reads `params.config`, so `config` must be present.
  const attempts: ReadonlyArray<Record<string, unknown>> = [
    // Common shapes
    { candidates: params.candidates, config: params.config, embedder: params.embedder },
    { items: params.candidates, config: params.config, embedder: params.embedder },
    { input: params.candidates, config: params.config, embedder: params.embedder },

    // Variants seen in some pipelines
    { scored: params.candidates, config: params.config, embedder: params.embedder },
    { scored_candidates: params.candidates, config: params.config, embedder: params.embedder },
    { candidates_scored: params.candidates, config: params.config, embedder: params.embedder },
    { ranked: params.candidates, config: params.config, embedder: params.embedder },

    // Embedder sometimes nested
    { candidates: params.candidates, config: params.config, embeddings: { embedder: params.embedder } },
    { items: params.candidates, config: params.config, embeddings: { embedder: params.embedder } },

    // Most likely: single params object with `candidates` + `config` + `embedder`
    { candidates: params.candidates, config: params.config, embedder: params.embedder }
  ];

  let lastErr: unknown = null;
  for (const a of attempts) {
    try {
      return await fn(a);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

describe("dedupeCandidates", () => {
  it("suppresses near-duplicates by pHash (keeps best-scoring)", async () => {
    const cfg = buildCandidateDetectionConfig();

    const a = mkCandidate({ id: "a", phash: "0000000000000000", score: 0.9, ts: 1000 });
    const b = mkCandidate({ id: "b", phash: "0000000000000000", score: 0.7, ts: 1200 });

    const res = await runDedupe({ candidates: [b, a], config: cfg, embedder: null });

    const kept = getProp<unknown[]>(res, "kept");
    expect(Array.isArray(kept)).toBe(true);
    expect(kept.length).toBe(1);

    const kept0 = kept[0] as Record<string, unknown>;
    expect(kept0.candidate_id).toBe("a");

    const dedupedPhash = getCount(res, "deduped_phash");
    if (dedupedPhash !== null) expect(dedupedPhash).toBeGreaterThanOrEqual(1);
  });

  it("suppresses near-duplicates by embeddings when pHash differs", async () => {
    const cfg = buildCandidateDetectionConfig({
      dedupe: {
        phash_hamming_threshold: 0,
        embedding_cosine_threshold: 0.9
      }
    });

    // Different pHash strings, identical embedding inputs => cosine = 1.
    const a = mkCandidate({
      id: "a",
      phash: "0000000000000000",
      score: 0.9,
      ts: 1000,
      withEmbeddingInput: true
    });
    const b = mkCandidate({
      id: "b",
      phash: "ffffffffffffffff",
      score: 0.8,
      ts: 1100,
      withEmbeddingInput: true
    });

    const res = await runDedupe({ candidates: [a, b], config: cfg, embedder: FakeEmbedder });

    const kept = getProp<unknown[]>(res, "kept");
    expect(kept.length).toBe(1);

    const kept0 = kept[0] as Record<string, unknown>;
    expect(kept0.candidate_id).toBe("a");

    const dedupedEmb = getCount(res, "deduped_embedding");
    if (dedupedEmb !== null) expect(dedupedEmb).toBeGreaterThanOrEqual(1);
  });

  it("enforces max_candidates cap deterministically", async () => {
    const cfg = buildCandidateDetectionConfig({
      max_candidates: 2,
      dedupe: {
        phash_hamming_threshold: 0,
        embedding_cosine_threshold: 0.96
      }
    });

    const c1 = mkCandidate({ id: "c1", phash: "0000000000000000", score: 0.9, ts: 1000 });
    const c2 = mkCandidate({ id: "c2", phash: "ffffffffffffffff", score: 0.8, ts: 1100 });
    const c3 = mkCandidate({ id: "c3", phash: "0f0f0f0f0f0f0f0f", score: 0.7, ts: 1200 });

    const res = await runDedupe({ candidates: [c1, c2, c3], config: cfg, embedder: null });

    const kept = getProp<unknown[]>(res, "kept");
    expect(kept.length).toBe(2);

    const early = getProp<unknown>(res, "early_exit_reason");
    expect(early).toBe(ReasonCode.E_MAX_CANDIDATES_CAPPED);
  });
});