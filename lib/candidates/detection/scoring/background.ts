

/*
  DRESZI — Background simplicity proxy

  Goal
  - Provide a cheap, deterministic proxy for "messy background" vs "simple background".

  Approach (beta)
  - Compute edge magnitude via a simple Sobel operator on grayscale pixels.
  - Compute edge density inside ROI vs outside ROI.
  - If inside has edges (subject detail) while outside is relatively low (simple background),
    we consider it more favorable.

  Notes
  - Deterministic and bounded.
  - Operates on downscaled grayscale where possible for speed.
  - Caller provides the grayscale pixels and ROI.
*/

import type { ReasonCodeString } from "../config";
import { ReasonCode } from "../config";
import type { CropBox } from "../types";

export interface BackgroundStats {
  /** Edge density inside ROI (0..1-ish) */
  readonly edge_density_in: number;
  /** Edge density outside ROI (0..1-ish) */
  readonly edge_density_out: number;
  /** Simplicity score 0..1 where higher implies simpler background */
  readonly simplicity_score: number;
  /** Reason codes for observability */
  readonly reason_codes: ReadonlyArray<ReasonCodeString>;
}

function assertDims(width: number, height: number): void {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 2 || height <= 2) {
    throw new Error(`Invalid dimensions for background scoring (w=${width}, h=${height})`);
  }
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

/**
 * Compute a simple Sobel edge magnitude at (x,y).
 * Caller must ensure x,y are not on border.
 */
function sobelMag(gr: Uint8Array, w: number, x: number, y: number): number {
  const i = y * w + x;
  // Sobel kernels
  // Gx = [-1 0 1; -2 0 2; -1 0 1]
  // Gy = [-1 -2 -1; 0 0 0; 1 2 1]
  const a00 = gr[i - w - 1];
  const a01 = gr[i - w];
  const a02 = gr[i - w + 1];
  const a10 = gr[i - 1];
  const a12 = gr[i + 1];
  const a20 = gr[i + w - 1];
  const a21 = gr[i + w];
  const a22 = gr[i + w + 1];

  const gx = -a00 + a02 - 2 * a10 + 2 * a12 - a20 + a22;
  const gy = -a00 - 2 * a01 - a02 + a20 + 2 * a21 + a22;

  // Approx magnitude: |gx| + |gy| (cheaper than sqrt)
  return Math.abs(gx) + Math.abs(gy);
}

/**
 * Compute background simplicity proxy.
 *
 * `edgeThreshold` filters out very small gradients.
 * On 8-bit images, Sobel magnitude can reach ~2040; threshold 120 is conservative.
 */
export function computeBackgroundStats(params: {
  grayscale: Uint8Array;
  width: number;
  height: number;
  roi: CropBox;
  edgeThreshold?: number;
}): BackgroundStats {
  assertDims(params.width, params.height);

  const gr = params.grayscale;
  const w = Math.trunc(params.width);
  const h = Math.trunc(params.height);

  const expected = w * h;
  if (gr.length < expected) {
    throw new Error(`grayscale length ${gr.length} < expected ${expected}`);
  }

  const edgeT = Math.max(0, Math.trunc(params.edgeThreshold ?? 120));

  // Clamp ROI to usable interior region (avoid borders for Sobel)
  const rx0 = Math.max(1, Math.min(w - 2, Math.trunc(params.roi.x)));
  const ry0 = Math.max(1, Math.min(h - 2, Math.trunc(params.roi.y)));
  const rx1 = Math.max(rx0 + 1, Math.min(w - 2, Math.trunc(params.roi.x + params.roi.w)));
  const ry1 = Math.max(ry0 + 1, Math.min(h - 2, Math.trunc(params.roi.y + params.roi.h)));

  let inCount = 0;
  let inEdge = 0;
  let outCount = 0;
  let outEdge = 0;

  // Sample every 2 pixels to reduce CPU cost deterministically.
  const step = 2;

  for (let y = 1; y < h - 1; y += step) {
    for (let x = 1; x < w - 1; x += step) {
      const mag = sobelMag(gr, w, x, y);
      const isEdge = mag >= edgeT;

      const inside = x >= rx0 && x < rx1 && y >= ry0 && y < ry1;
      if (inside) {
        inCount += 1;
        if (isEdge) inEdge += 1;
      } else {
        outCount += 1;
        if (isEdge) outEdge += 1;
      }
    }
  }

  const edge_density_in = inCount > 0 ? inEdge / inCount : 0;
  const edge_density_out = outCount > 0 ? outEdge / outCount : 0;

  // Simplicity: we prefer low outside edge density.
  // Also prefer that inside has some structure (subject), so we damp if inside is too flat.
  const outScore = 1 - clamp01(edge_density_out * 2.2);
  const inHasDetail = clamp01(edge_density_in * 2.0);
  const simplicity_score = clamp01(0.7 * outScore + 0.3 * inHasDetail);

  const reasons: ReasonCodeString[] = [];
  if (simplicity_score >= 0.55) reasons.push(ReasonCode.E_BACKGROUND_SIMPLE);
  else reasons.push(ReasonCode.E_BACKGROUND_COMPLEX);

  return {
    edge_density_in,
    edge_density_out,
    simplicity_score,
    reason_codes: reasons
  };
}

/**
 * Convert background stats into a 0..1 component score.
 */
export function backgroundScore(stats: BackgroundStats): number {
  return clamp01(stats.simplicity_score);
}