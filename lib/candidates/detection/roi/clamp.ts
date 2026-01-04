

/*
  DRESZI — ROI / Crop clamping utilities

  Goals
  - Clamp proposed crop boxes to image bounds deterministically.
  - Enforce minimum crop size.
  - Return reason codes for observability.

  This module is dependency-free and pure.
*/

import type { ReasonCodeString } from "../config";
import { ReasonCode } from "../config";
import type { CropBox } from "../types";

export interface ClampResult {
  readonly crop: CropBox;
  readonly reason_codes: ReadonlyArray<ReasonCodeString>;
  /** True if the crop was modified to fit bounds or min size. */
  readonly changed: boolean;
}

function clampInt(v: number, min: number, max: number): number {
  const n = Math.trunc(v);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function isFinitePos(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}

/**
 * Clamp a crop box to image bounds and enforce minimum dimensions.
 *
 * Rules
 * - x/y always within [0, frame-1]
 * - w/h always within [1, frame]
 * - (x+w) <= frame_w; (y+h) <= frame_h
 * - if crop becomes too small after clamping, expand around center when possible
 * - always deterministic
 */
export function clampCropBoxToFrame(params: {
  x: number;
  y: number;
  w: number;
  h: number;
  frame_w: number;
  frame_h: number;
  min_dim: number;
}): ClampResult {
  const reasons: ReasonCodeString[] = [];

  const frame_w = Math.trunc(params.frame_w);
  const frame_h = Math.trunc(params.frame_h);

  if (!isFinitePos(frame_w) || !isFinitePos(frame_h)) {
    throw new Error(`Invalid frame dimensions (frame_w=${params.frame_w}, frame_h=${params.frame_h})`);
  }

  const min_dim = Math.max(1, Math.trunc(params.min_dim));

  // Start with proposed
  let x = Math.trunc(params.x);
  let y = Math.trunc(params.y);
  let w = Math.trunc(params.w);
  let h = Math.trunc(params.h);

  // Normalize negative / zero sizes
  if (w <= 0) w = min_dim;
  if (h <= 0) h = min_dim;

  // Clamp origin
  const x0 = x;
  const y0 = y;
  x = clampInt(x, 0, frame_w - 1);
  y = clampInt(y, 0, frame_h - 1);

  // Clamp size to frame
  const w0 = w;
  const h0 = h;
  w = clampInt(w, 1, frame_w);
  h = clampInt(h, 1, frame_h);

  // Ensure the crop stays within bounds by shifting origin if needed
  if (x + w > frame_w) x = Math.max(0, frame_w - w);
  if (y + h > frame_h) y = Math.max(0, frame_h - h);

  let changed = x !== x0 || y !== y0 || w !== w0 || h !== h0;

  // Enforce minimum dimensions by expanding around center when possible
  if (w < min_dim || h < min_dim) {
    reasons.push(ReasonCode.E_CROP_TOO_SMALL);

    const cx = x + Math.floor(w / 2);
    const cy = y + Math.floor(h / 2);

    const targetW = Math.min(frame_w, Math.max(min_dim, w));
    const targetH = Math.min(frame_h, Math.max(min_dim, h));

    let newX = cx - Math.floor(targetW / 2);
    let newY = cy - Math.floor(targetH / 2);

    newX = clampInt(newX, 0, Math.max(0, frame_w - targetW));
    newY = clampInt(newY, 0, Math.max(0, frame_h - targetH));

    if (newX !== x || newY !== y || targetW !== w || targetH !== h) {
      x = newX;
      y = newY;
      w = targetW;
      h = targetH;
      changed = true;
    }

    // If still too small (tiny frames), keep as-is but it remains observable.
    if (w < min_dim || h < min_dim) {
      // No additional action; caller can decide to discard.
    }
  }

  if (changed) {
    reasons.push(ReasonCode.E_CROP_CLAMPED_TO_BOUNDS);
  }

  const crop: CropBox = {
    x,
    y,
    w,
    h,
    frame_w,
    frame_h
  };

  // Always return at least one reason code for this operation.
  if (reasons.length === 0) {
    reasons.push(ReasonCode.E_OK);
  }

  return {
    crop,
    reason_codes: reasons,
    changed
  };
}

/**
 * Create a default torso-ish ROI crop box using percentages (0..1) and clamp it.
 */
export function torsoCropFromPercents(params: {
  frame_w: number;
  frame_h: number;
  xPct: number;
  yPct: number;
  wPct: number;
  hPct: number;
  min_dim: number;
}): ClampResult {
  const x = Math.round(params.frame_w * params.xPct);
  const y = Math.round(params.frame_h * params.yPct);
  const w = Math.round(params.frame_w * params.wPct);
  const h = Math.round(params.frame_h * params.hPct);

  return clampCropBoxToFrame({
    x,
    y,
    w,
    h,
    frame_w: params.frame_w,
    frame_h: params.frame_h,
    min_dim: params.min_dim
  });
}