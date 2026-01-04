

/*
  DRESZI-5.5 — Detect garment candidates from frames (Video)

  Strict types for candidate detection.
  Keep this file dependency-free so it can be imported across route handlers,
  domain modules, and tests without side effects.
*/

import type { ReasonCodeString } from "./config";

export type UUID = string;

export type CandidateStatus = "generated";

export interface FrameDimensions {
  readonly width: number;
  readonly height: number;
}

/**
 * A frame input provided to the candidate detector.
 * Prefer `bytes` when available to avoid network I/O in serverless.
 */
export interface FrameInput {
  /** Frame timestamp relative to the source video (ms). */
  readonly ts_ms: number;

  /** Original frame dimensions (or post-extract dimensions) if known. */
  readonly width?: number;
  readonly height?: number;

  /**
   * Frame bytes (e.g., JPEG/PNG) if already loaded.
   * Preferred for serverless determinism + speed.
   */
  readonly bytes?: Uint8Array;

  /**
   * Optional reference where the frame can be loaded.
   * Only used if `bytes` is missing.
   */
  readonly ref?: {
    /** Logical identifier for debugging (e.g., filename or storage path). */
    readonly id: string;
    /** HTTP(S) URL or local file path in /tmp. */
    readonly uri: string;
  };
}

export interface CropBox {
  /** top-left origin */
  readonly x: number;
  readonly y: number;
  /** width/height */
  readonly w: number;
  readonly h: number;

  /** frame dimensions used to compute this crop */
  readonly frame_w: number;
  readonly frame_h: number;
}

export interface CandidateEmbedding {
  /** Name/version of embedding model used */
  readonly model: string;
  /** Optional vector in-memory (not persisted) */
  readonly vector?: ReadonlyArray<number>;
  /** Optional persisted embedding reference */
  readonly id?: string;
}

export interface GarmentCandidate {
  readonly candidate_id: UUID;
  readonly wardrobe_video_id: string;
  readonly user_id: string;

  readonly frame_ts_ms: number;
  readonly crop_box: CropBox;

  /** 0..1 */
  readonly confidence: number;

  /** Always include at least one reason code */
  readonly reason_codes: ReadonlyArray<ReasonCodeString>;

  /** 64-bit perceptual hash as hex (length 16) */
  readonly phash: string;

  /** sha256 hash of the candidate crop bytes (hex) */
  readonly sha256: string;

  /** Size in bytes of the crop if known (nullable if not uploaded/stored yet) */
  readonly bytes: number | null;

  /** Embedding metadata (vector may be omitted) */
  readonly embedding_model: string;
  readonly embedding_vector?: ReadonlyArray<number>;
  readonly embedding_id?: string | null;

  /** 1..N */
  readonly rank: number;

  readonly status: CandidateStatus;
}

export interface CandidateDetectionInput {
  readonly wardrobe_video_id: string;
  readonly user_id: string;

  /** Extracted frames. If empty, detector returns empty list and logs reason codes upstream. */
  readonly frames: ReadonlyArray<FrameInput>;

  /** If true, emits per-candidate debug logs (still structured). */
  readonly debug?: boolean;

  /**
   * Optional caller-provided request id for log correlation.
   * If omitted, detector will generate one.
   */
  readonly request_id?: string;
}

export interface CandidateRunCounts {
  readonly frames_seen: number;
  readonly frames_scored: number;
  readonly crops_generated: number;
  readonly deduped_phash: number;
  readonly deduped_embedding: number;
  readonly candidates_returned: number;
}

export interface CandidateRunTimingsMs {
  readonly decode_ms: number;
  readonly scoring_ms: number;
  readonly roi_ms: number;
  readonly crop_ms: number;
  readonly phash_ms: number;
  readonly embed_ms: number;
  readonly total_ms: number;
}

export interface CandidateRunDecisions {
  readonly selected_frame_ts_ms: ReadonlyArray<number>;
  readonly fallback_used: boolean;
  readonly early_exit_reason: string | null;
}

export type ReasonCodeCounts = Readonly<Record<ReasonCodeString, number>>;

/**
 * Summary emitted once per run (structured log + optional DB persistence).
 */
export interface CandidateRunSummary {
  readonly request_id: string;
  readonly wardrobe_video_id: string;
  readonly user_id: string;

  readonly config_version: string;

  readonly counts: CandidateRunCounts;
  readonly timings_ms: CandidateRunTimingsMs;
  readonly decisions: CandidateRunDecisions;
  readonly reason_code_counts: ReasonCodeCounts;
}

export interface CandidateDetectionOutput {
  readonly candidates: ReadonlyArray<GarmentCandidate>;
  readonly summary: CandidateRunSummary;
}

/**
 * Minimal interface to load frame bytes when only refs are provided.
 * Keep this pluggable so we can use /tmp fs, signed URLs, or storage SDKs.
 */
export interface FrameLoader {
  loadFrameBytes(frame: FrameInput): Promise<Uint8Array>;
}

/**
 * Pluggable embedding provider.
 * Implementations must be deterministic for identical inputs.
 */
export interface EmbeddingProvider {
  readonly model: string;
  embed(imageBytes: Uint8Array): Promise<ReadonlyArray<number>>;
}

/**
 * Dependencies injected into the detector (no hidden globals).
 */
export interface CandidateDetectionDeps {
  readonly frameLoader?: FrameLoader;
  readonly embeddingProvider?: EmbeddingProvider;

  /** Structured logger hook; if omitted, detector can no-op logging. */
  log?: (obj: unknown) => void;

  /** High-resolution clock in ms for testability */
  nowMs?: () => number;
}

export interface InternalFrameScore {
  readonly ts_ms: number;
  readonly sharpness_var: number;
  readonly luma_mean: number;
  readonly clipped_low_ratio: number;
  readonly clipped_high_ratio: number;
  readonly background_simplicity: number;
  readonly score: number;
  readonly reason_codes: ReadonlyArray<ReasonCodeString>;
}

export interface InternalCandidateDraft {
  readonly wardrobe_video_id: string;
  readonly user_id: string;
  readonly frame_ts_ms: number;
  readonly crop_box: CropBox;
  readonly confidence: number;
  readonly reason_codes: ReadonlyArray<ReasonCodeString>;

  /**
   * Raw crop bytes used for hashing/embedding.
   * Not returned to callers by default.
   */
  readonly crop_bytes: Uint8Array;

  readonly phash: string;
  readonly sha256: string;
  readonly embedding?: CandidateEmbedding;

  /** Ranking score (not exposed) */
  readonly rank_score: number;
}