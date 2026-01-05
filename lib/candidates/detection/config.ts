/*
  DRESZI-5.5A — Candidate detection config + reason codes
  Single source of truth for thresholds, caps, and standardized reason codes.

  Design goals
  - Deterministic behavior across retries (no randomness).
  - Serverless-safe defaults (bounded CPU/memory/time).
  - No magic numbers scattered throughout the codebase.
*/

export const CONFIG_VERSION = "dreszi/candidate-detect/v1" as const;

/**
 * Standardized reason codes used across the candidate detection pipeline.
 *
 * Notes:
 * - Always attach at least one reason code to every decision/candidate.
 * - Keep these stable; add new ones as needed, but avoid renaming.
 */
export enum ReasonCode {
  // Provided beta list (do not remove)
  E_DURATION_TOO_LONG = "E_DURATION_TOO_LONG",
  E_FRAMES_EXTRACTION_FAILED = "E_FRAMES_EXTRACTION_FAILED",
  E_NO_REGION_DETECTED = "E_NO_REGION_DETECTED",
  E_LOW_SHARPNESS = "E_LOW_SHARPNESS",
  E_DUPLICATE_SUPPRESSED_PHASH = "E_DUPLICATE_SUPPRESSED_PHASH",
  E_DUPLICATE_SUPPRESSED_EMBEDDING = "E_DUPLICATE_SUPPRESSED_EMBEDDING",
  E_FALLBACK_CENTER_FRAME = "E_FALLBACK_CENTER_FRAME",
  E_STORAGE_UPLOAD_FAILED = "E_STORAGE_UPLOAD_FAILED",
  E_SIGN_URL_FAILED = "E_SIGN_URL_FAILED",

  // Additional justified codes (safe + observable)
  E_OK = "E_OK",
  E_DECODE_FAILED = "E_DECODE_FAILED",
  E_EXPOSURE_TOO_DARK = "E_EXPOSURE_TOO_DARK",
  E_EXPOSURE_TOO_BRIGHT = "E_EXPOSURE_TOO_BRIGHT",
  E_EXPOSURE_CLIPPED = "E_EXPOSURE_CLIPPED",
  E_ROI_TORSO_HEURISTIC = "E_ROI_TORSO_HEURISTIC",
  E_ROI_SALIENCY_REFINED = "E_ROI_SALIENCY_REFINED",
  E_CROP_CLAMPED_TO_BOUNDS = "E_CROP_CLAMPED_TO_BOUNDS",
  E_CROP_TOO_SMALL = "E_CROP_TOO_SMALL",
  E_EARLY_EXIT_TIME_BUDGET = "E_EARLY_EXIT_TIME_BUDGET",
  E_MAX_FRAMES_CAPPED = "E_MAX_FRAMES_CAPPED",
  E_MAX_CANDIDATES_CAPPED = "E_MAX_CANDIDATES_CAPPED",
  E_BACKGROUND_COMPLEX = "E_BACKGROUND_COMPLEX",
  E_BACKGROUND_SIMPLE = "E_BACKGROUND_SIMPLE",
  E_SELECTED_TOP_FRAME = "E_SELECTED_TOP_FRAME",
  E_NOT_ENOUGH_UNIQUE = "E_NOT_ENOUGH_UNIQUE"
}

export type ReasonCodeString = ReasonCode;

export type ImageOutputFormat = "jpeg" | "webp";

export interface TorsoRoiPercentages {
  /** Fraction of width to offset from left (0..1) */
  readonly x: number;
  /** Fraction of height to offset from top (0..1) */
  readonly y: number;
  /** Fraction of width for ROI width (0..1) */
  readonly w: number;
  /** Fraction of height for ROI height (0..1) */
  readonly h: number;
}

export interface CandidateDetectionConfig {
  /** Version string for auditability in logs and persisted summaries */
  readonly version: typeof CONFIG_VERSION;

  /**
   * Time budget for internal early exits (ms). This should be < route timeout.
   * On Vercel, timeouts vary by plan/runtime. Keep conservative by default.
   */
  readonly time_budget_ms: number;

  /**
   * Input decoding / processing guardrails
   */
  readonly max_frames_to_score: number;
  readonly top_k_frames: number;

  /**
   * Candidate output caps
   */
  readonly max_candidates: number;
  readonly max_candidates_hard: number;

  /** Max working width used for decoding/scoring/cropping to bound compute */
  readonly max_width_used: number;

  /** Minimum crop dimension in pixels to avoid unusable tiny crops */
  readonly min_crop_dim_px: number;

  /**
   * Frame scoring thresholds
   */
  readonly scoring: {
    /** If Laplacian variance is below this, frame is considered soft/blurred */
    readonly sharpness_min_var: number;

    /** Mean luminance bounds (0..255). Frames outside are downweighted */
    readonly luma_mean_min: number;
    readonly luma_mean_max: number;

    /**
     * Ratios of pixels near 0 or 255 indicating clipped shadows/highlights.
     * Used as a cheap exposure sanity proxy.
     */
    readonly clipped_low_ratio_max: number;
    readonly clipped_high_ratio_max: number;

    /** How many of the best frames we attempt ROI+crops on (<= top_k_frames) */
    readonly frames_for_roi: number;
  };

  /**
   * ROI generation defaults (baseline torso-ish window) in percentages.
   */
  readonly roi: {
    readonly torso_default: TorsoRoiPercentages;

    /** Whether to run the cheap saliency refinement around the torso window. */
    readonly enable_saliency_refine: boolean;

    /** Grid search steps around torso ROI (bounded). Deterministic. */
    readonly saliency_grid_steps: number;

    /** Saliency refinement maximum candidates to evaluate per frame */
    readonly saliency_max_rois_per_frame: number;
  };

  /**
   * Hashing + dedupe thresholds
   */
  readonly dedupe: {
    /** pHash Hamming distance at or below which we consider a near-duplicate */
    readonly phash_hamming_threshold: number;

    /** Cosine similarity at/above which embeddings are considered duplicates */
    readonly embedding_cosine_threshold: number;

    /**
     * If true, compute embeddings only for candidates that survive pHash stage.
     * Strongly recommended for cost.
     */
    readonly embed_after_phash_only: boolean;
  };

  /**
   * Lightweight embedding config (local baseline).
   * If/when you swap to a real model, keep this namespace and add fields.
   */
  readonly embeddings: {
    /** Downscale grid for TinyBlockEmbedder (8..32). Default 16. */
    readonly tinyblock_grid: number;
  };

  /**
   * Crop encoding settings used before hashing (must be deterministic)
   */
  readonly encoding: {
    readonly format: ImageOutputFormat;
    /** 1..100 */
    readonly quality: number;
  };

  /**
   * Debug flags
   */
  readonly debug: {
    /** If true, emits per-candidate debug logs (still structured). */
    readonly log_per_candidate: boolean;
  };
}

export const CANDIDATE_DETECTION_DEFAULTS: CandidateDetectionConfig = {
  version: CONFIG_VERSION,

  // Conservative default: keep under typical serverless handler timeouts.
  time_budget_ms: 8000,

  // Hard limits (cost + time guardrails)
  max_frames_to_score: 60,
  top_k_frames: 12,

  // Output caps
  max_candidates: 8,
  max_candidates_hard: 12,

  // Decode width bound (match upstream default if needed)
  max_width_used: 768,

  // Avoid tiny crops
  min_crop_dim_px: 160,

  scoring: {
    // Laplacian variance threshold — below tends to be too blurred for stable hashes
    sharpness_min_var: 80,

    // Luma mean sanity bounds
    luma_mean_min: 35,
    luma_mean_max: 220,

    // Clipping ratios
    clipped_low_ratio_max: 0.2,
    clipped_high_ratio_max: 0.12,

    // How many of top frames we attempt ROI/crop on
    frames_for_roi: 8
  },

  roi: {
    // Torso-ish baseline: centered and tall
    torso_default: { x: 0.18, y: 0.18, w: 0.64, h: 0.7 },

    // Keep refinement on by default (still bounded + deterministic)
    enable_saliency_refine: true,

    // Small bounded grid = deterministic + cheap
    saliency_grid_steps: 2,
    saliency_max_rois_per_frame: 9
  },

  dedupe: {
    // 64-bit pHash: 10 is a common near-duplicate threshold
    phash_hamming_threshold: 10,

    // Local baseline embedding tends to be coarse; 0.94 is a reasonable start
    embedding_cosine_threshold: 0.94,

    embed_after_phash_only: true
  },

  embeddings: {
    tinyblock_grid: 16
  },

  encoding: {
    format: "jpeg",
    quality: 78
  },

  debug: {
    log_per_candidate: false
  }
};

export type CandidateDetectionConfigOverrides = Partial<
  Omit<CandidateDetectionConfig, "version" | "scoring" | "roi" | "dedupe" | "embeddings" | "encoding" | "debug">
> & {
  scoring?: Partial<CandidateDetectionConfig["scoring"]>;
  roi?: Partial<CandidateDetectionConfig["roi"]> & {
    torso_default?: Partial<TorsoRoiPercentages>;
  };
  dedupe?: Partial<CandidateDetectionConfig["dedupe"]>;
  embeddings?: Partial<CandidateDetectionConfig["embeddings"]>;
  encoding?: Partial<CandidateDetectionConfig["encoding"]>;
  debug?: Partial<CandidateDetectionConfig["debug"]>;
};

/**
 * Merge overrides into defaults (deep merge for nested config objects).
 * Deterministic and side-effect free.
 */
export function buildCandidateDetectionConfig(
  overrides: CandidateDetectionConfigOverrides = {}
): CandidateDetectionConfig {
  const merged: CandidateDetectionConfig = {
    ...CANDIDATE_DETECTION_DEFAULTS,
    ...overrides,
    version: CONFIG_VERSION,
    scoring: {
      ...CANDIDATE_DETECTION_DEFAULTS.scoring,
      ...(overrides.scoring ?? {})
    },
    roi: {
      ...CANDIDATE_DETECTION_DEFAULTS.roi,
      ...(overrides.roi ?? {}),
      torso_default: {
        ...CANDIDATE_DETECTION_DEFAULTS.roi.torso_default,
        ...(overrides.roi?.torso_default ?? {})
      }
    },
    dedupe: {
      ...CANDIDATE_DETECTION_DEFAULTS.dedupe,
      ...(overrides.dedupe ?? {})
    },
    embeddings: {
      ...CANDIDATE_DETECTION_DEFAULTS.embeddings,
      ...(overrides.embeddings ?? {})
    },
    encoding: {
      ...CANDIDATE_DETECTION_DEFAULTS.encoding,
      ...(overrides.encoding ?? {})
    },
    debug: {
      ...CANDIDATE_DETECTION_DEFAULTS.debug,
      ...(overrides.debug ?? {})
    }
  };

  assertCandidateDetectionConfig(merged);
  return merged;
}

/**
 * Validate configuration invariants early to avoid undefined runtime behavior.
 */
export function assertCandidateDetectionConfig(cfg: CandidateDetectionConfig): void {
  const fail = (msg: string): never => {
    throw new Error(`CandidateDetectionConfig invalid: ${msg}`);
  };

  if (cfg.version !== CONFIG_VERSION) fail(`version must be ${CONFIG_VERSION}`);

  if (cfg.time_budget_ms <= 0) fail("time_budget_ms must be > 0");

  if (cfg.max_frames_to_score <= 0) fail("max_frames_to_score must be > 0");
  if (cfg.max_frames_to_score > 60) fail("max_frames_to_score must be <= 60 (hard cap)");

  if (cfg.top_k_frames <= 0) fail("top_k_frames must be > 0");
  if (cfg.top_k_frames > cfg.max_frames_to_score)
    fail("top_k_frames must be <= max_frames_to_score");

  if (cfg.max_candidates <= 0) fail("max_candidates must be > 0");
  if (cfg.max_candidates_hard <= 0) fail("max_candidates_hard must be > 0");
  if (cfg.max_candidates > cfg.max_candidates_hard)
    fail("max_candidates must be <= max_candidates_hard");
  if (cfg.max_candidates_hard > 12)
    fail("max_candidates_hard must be <= 12 (hard cap)");

  if (cfg.max_width_used < 128) fail("max_width_used must be >= 128");
  if (cfg.min_crop_dim_px < 32) fail("min_crop_dim_px must be >= 32");

  const pct = cfg.roi.torso_default;
  const in01 = (v: number): boolean => v >= 0 && v <= 1;
  if (!in01(pct.x) || !in01(pct.y) || !in01(pct.w) || !in01(pct.h)) {
    fail("roi.torso_default x/y/w/h must be within [0,1]");
  }
  if (pct.w <= 0 || pct.h <= 0) fail("roi.torso_default w/h must be > 0");
  if (pct.x + pct.w > 1.001) fail("roi.torso_default x+w must be <= 1");
  if (pct.y + pct.h > 1.001) fail("roi.torso_default y+h must be <= 1");

  const s = cfg.scoring;
  if (s.sharpness_min_var <= 0) fail("scoring.sharpness_min_var must be > 0");
  if (s.luma_mean_min < 0 || s.luma_mean_max > 255 || s.luma_mean_min >= s.luma_mean_max)
    fail("scoring.luma_mean_min/max must be within 0..255 and min < max");

  const ratioOk = (v: number): boolean => v >= 0 && v <= 1;
  if (!ratioOk(s.clipped_low_ratio_max) || !ratioOk(s.clipped_high_ratio_max))
    fail("scoring clipped ratios must be within [0,1]");

  if (s.frames_for_roi <= 0) fail("scoring.frames_for_roi must be > 0");
  if (s.frames_for_roi > cfg.top_k_frames)
    fail("scoring.frames_for_roi must be <= top_k_frames");

  const d = cfg.dedupe;
  if (d.phash_hamming_threshold < 0 || d.phash_hamming_threshold > 64)
    fail("dedupe.phash_hamming_threshold must be within 0..64");
  if (d.embedding_cosine_threshold < 0 || d.embedding_cosine_threshold > 1)
    fail("dedupe.embedding_cosine_threshold must be within 0..1");

  const emb = cfg.embeddings;
  if (!Number.isFinite(emb.tinyblock_grid) || emb.tinyblock_grid < 8 || emb.tinyblock_grid > 32)
    fail("embeddings.tinyblock_grid must be within 8..32");

  const e = cfg.encoding;
  if (e.quality < 1 || e.quality > 100) fail("encoding.quality must be within 1..100");
  if (e.format !== "jpeg" && e.format !== "webp")
    fail("encoding.format must be 'jpeg' or 'webp'");

  const r = cfg.roi;
  if (r.saliency_grid_steps < 0) fail("roi.saliency_grid_steps must be >= 0");
  if (r.saliency_max_rois_per_frame <= 0) fail("roi.saliency_max_rois_per_frame must be > 0");
}

/**
 * Convenience: export a stable ordered list for logging/validation.
 */
export const ALL_REASON_CODES: ReadonlyArray<ReasonCodeString> =
  Object.values(ReasonCode) as ReadonlyArray<ReasonCodeString>;