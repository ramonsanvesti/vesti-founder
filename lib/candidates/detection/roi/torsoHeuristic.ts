

/*
  DRESZI — Torso-ish ROI heuristic

  Baseline approach (beta)
  - Assume the subject is roughly centered.
  - Use config.torso_default percentages to define an initial ROI.
  - Clamp deterministically to bounds.

  This module is pure and dependency-free.
*/

import type { CandidateDetectionConfig, ReasonCodeString } from "../config";
import { ReasonCode } from "../config";
import type { CropBox } from "../types";
import { torsoCropFromPercents } from "./clamp";

export interface TorsoRoiResult {
  readonly crop: CropBox;
  readonly reason_codes: ReadonlyArray<ReasonCodeString>;
}

/**
 * Compute a default torso ROI based on percentages from config.
 */
export function computeTorsoRoi(params: {
  frame_w: number;
  frame_h: number;
  config: CandidateDetectionConfig;
}): TorsoRoiResult {
  const cfg = params.config;
  const t = cfg.roi.torso_default;

  const clampRes = torsoCropFromPercents({
    frame_w: params.frame_w,
    frame_h: params.frame_h,
    xPct: t.x,
    yPct: t.y,
    wPct: t.w,
    hPct: t.h,
    min_dim: cfg.min_crop_dim_px
  });

  const reasons: ReasonCodeString[] = [ReasonCode.E_ROI_TORSO_HEURISTIC];
  for (const r of clampRes.reason_codes) {
    // Avoid repeating E_OK if clamp already changed; keep reason list meaningful.
    if (r !== ReasonCode.E_OK) reasons.push(r);
  }

  return {
    crop: clampRes.crop,
    reason_codes: reasons
  };
}

/**
 * Compute a slightly tighter torso ROI (optional utility).
 * Useful when we want to bias towards the garment region.
 */
export function computeTighterTorsoRoi(params: {
  frame_w: number;
  frame_h: number;
  config: CandidateDetectionConfig;
  /** 0..1. Higher = tighter crop. Default 0.08 */
  tightenBy?: number;
}): TorsoRoiResult {
  const cfg = params.config;
  const base = cfg.roi.torso_default;
  const t = Math.max(0, Math.min(0.25, params.tightenBy ?? 0.08));

  // Shrink ROI while keeping center stable.
  const xPct = Math.min(1, Math.max(0, base.x + t));
  const yPct = Math.min(1, Math.max(0, base.y + t));
  const wPct = Math.min(1, Math.max(0.05, base.w - 2 * t));
  const hPct = Math.min(1, Math.max(0.05, base.h - 2 * t));

  const clampRes = torsoCropFromPercents({
    frame_w: params.frame_w,
    frame_h: params.frame_h,
    xPct,
    yPct,
    wPct,
    hPct,
    min_dim: cfg.min_crop_dim_px
  });

  const reasons: ReasonCodeString[] = [ReasonCode.E_ROI_TORSO_HEURISTIC];
  for (const r of clampRes.reason_codes) {
    if (r !== ReasonCode.E_OK) reasons.push(r);
  }

  return {
    crop: clampRes.crop,
    reason_codes: reasons
  };
}