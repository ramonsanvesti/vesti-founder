

/*
  DRESZI — Exposure sanity scoring

  Signals
  - Mean luminance (0..255) from grayscale pixels.
  - Clipped-low ratio: fraction of pixels near 0 (crushed shadows).
  - Clipped-high ratio: fraction of pixels near 255 (blown highlights).

  Notes
  - Deterministic and fast.
  - Operates on raw grayscale pixels (Uint8Array) in row-major order.
  - Caller is responsible for decoding/resizing and providing grayscale.
*/

import type { ReasonCodeString } from "../config";
import { ReasonCode } from "../config";

export interface ExposureStats {
  /** Mean luminance 0..255 */
  readonly luma_mean: number;
  /** Ratio 0..1 of pixels near 0 */
  readonly clipped_low_ratio: number;
  /** Ratio 0..1 of pixels near 255 */
  readonly clipped_high_ratio: number;
  /** Total pixels counted */
  readonly n: number;
  /** Reason codes indicating exposure issues (or E_OK) */
  readonly reason_codes: ReadonlyArray<ReasonCodeString>;
}

export interface ExposureThresholds {
  readonly luma_mean_min: number;
  readonly luma_mean_max: number;
  readonly clipped_low_ratio_max: number;
  readonly clipped_high_ratio_max: number;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function safeDiv(n: number, d: number): number {
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return 0;
  return n / d;
}

/**
 * Compute exposure statistics from grayscale pixels.
 *
 * `lowClipThreshold` and `highClipThreshold` are inclusive thresholds.
 * Defaults are conservative and fast.
 */
export function computeExposureStats(
  grayscale: Uint8Array,
  thresholds: ExposureThresholds,
  opts?: {
    /** Pixels <= this are considered clipped low (default 8) */
    lowClipThreshold?: number;
    /** Pixels >= this are considered clipped high (default 247) */
    highClipThreshold?: number;
  }
): ExposureStats {
  const n = grayscale.length;
  if (n === 0) {
    return {
      luma_mean: 0,
      clipped_low_ratio: 0,
      clipped_high_ratio: 0,
      n: 0,
      reason_codes: [ReasonCode.E_EXPOSURE_CLIPPED]
    };
  }

  const lowT = Math.max(0, Math.min(255, Math.trunc(opts?.lowClipThreshold ?? 8)));
  const highT = Math.max(0, Math.min(255, Math.trunc(opts?.highClipThreshold ?? 247)));

  let sum = 0;
  let low = 0;
  let high = 0;

  for (let i = 0; i < n; i++) {
    const v = grayscale[i];
    sum += v;
    if (v <= lowT) low += 1;
    if (v >= highT) high += 1;
  }

  const luma_mean = sum / n;
  const clipped_low_ratio = clamp01(safeDiv(low, n));
  const clipped_high_ratio = clamp01(safeDiv(high, n));

  const reasons: ReasonCodeString[] = [];

  if (luma_mean < thresholds.luma_mean_min) reasons.push(ReasonCode.E_EXPOSURE_TOO_DARK);
  if (luma_mean > thresholds.luma_mean_max) reasons.push(ReasonCode.E_EXPOSURE_TOO_BRIGHT);

  // Add clipped code if either ratio exceeds threshold.
  if (
    clipped_low_ratio > thresholds.clipped_low_ratio_max ||
    clipped_high_ratio > thresholds.clipped_high_ratio_max
  ) {
    reasons.push(ReasonCode.E_EXPOSURE_CLIPPED);
  }

  if (reasons.length === 0) reasons.push(ReasonCode.E_OK);

  return {
    luma_mean,
    clipped_low_ratio,
    clipped_high_ratio,
    n,
    reason_codes: reasons
  };
}

/**
 * Convert exposure stats into a 0..1 quality score.
 *
 * Higher is better.
 * - Penalizes mean outside thresholds.
 * - Penalizes clipping beyond thresholds.
 */
export function exposureQualityScore(stats: ExposureStats, thresholds: ExposureThresholds): number {
  if (stats.n === 0) return 0;

  // Mean penalty (piecewise linear)
  let meanScore = 1;
  if (stats.luma_mean < thresholds.luma_mean_min) {
    const delta = thresholds.luma_mean_min - stats.luma_mean;
    meanScore = Math.max(0, 1 - delta / Math.max(1, thresholds.luma_mean_min));
  } else if (stats.luma_mean > thresholds.luma_mean_max) {
    const delta = stats.luma_mean - thresholds.luma_mean_max;
    meanScore = Math.max(0, 1 - delta / Math.max(1, 255 - thresholds.luma_mean_max));
  }

  // Clipping penalty
  const lowOver = Math.max(0, stats.clipped_low_ratio - thresholds.clipped_low_ratio_max);
  const highOver = Math.max(0, stats.clipped_high_ratio - thresholds.clipped_high_ratio_max);
  const clipOver = Math.min(1, lowOver + highOver);
  const clipScore = Math.max(0, 1 - clipOver * 3); // amplify

  const s = 0.65 * meanScore + 0.35 * clipScore;
  return Math.max(0, Math.min(1, s));
}