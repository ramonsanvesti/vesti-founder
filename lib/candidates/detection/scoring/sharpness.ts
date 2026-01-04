

/*
  DRESZI — Sharpness scoring

  Metric
  - Variance of Laplacian on grayscale pixels.

  Notes
  - Deterministic and fast.
  - Operates on raw grayscale pixels (Uint8Array) in row-major order.
  - Caller is responsible for decoding/resizing and providing grayscale.
*/

export interface LaplacianStats {
  /** Variance of Laplacian response. Higher = sharper. */
  readonly variance: number;
  /** Mean Laplacian response (mostly for debugging). */
  readonly mean: number;
  /** Number of samples used. */
  readonly n: number;
}

function assertDims(width: number, height: number): void {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 2 || height <= 2) {
    throw new Error(`Invalid dimensions for Laplacian (w=${width}, h=${height})`);
  }
}

/**
 * Compute Laplacian variance using a simple 3x3 kernel:
 *   [ 0  1  0
 *     1 -4  1
 *     0  1  0 ]
 */
export function laplacianVariance(grayscale: Uint8Array, width: number, height: number): LaplacianStats {
  assertDims(width, height);
  const expected = width * height;
  if (grayscale.length < expected) {
    throw new Error(`grayscale length ${grayscale.length} < expected ${expected}`);
  }

  // We ignore the outermost border pixels.
  let n = 0;
  let sum = 0;
  let sumSq = 0;

  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    const rowUp = (y - 1) * width;
    const rowDn = (y + 1) * width;

    for (let x = 1; x < width - 1; x++) {
      const c = grayscale[row + x];
      const up = grayscale[rowUp + x];
      const dn = grayscale[rowDn + x];
      const lf = grayscale[row + x - 1];
      const rt = grayscale[row + x + 1];

      // Laplacian response
      const v = up + dn + lf + rt - 4 * c;

      n += 1;
      sum += v;
      sumSq += v * v;
    }
  }

  if (n === 0) {
    return { variance: 0, mean: 0, n: 0 };
  }

  const mean = sum / n;
  const variance = Math.max(0, sumSq / n - mean * mean);

  return {
    variance,
    mean,
    n
  };
}

/**
 * Normalize a variance value into a 0..1-ish score using a soft knee.
 *
 * This prevents a few extremely sharp frames from dominating.
 */
export function sharpnessScoreFromVariance(variance: number, minVar: number): number {
  if (!Number.isFinite(variance) || variance <= 0) return 0;
  if (!Number.isFinite(minVar) || minVar <= 0) return 0;

  // Soft knee: below minVar score ramps quickly; above minVar asymptotically approaches 1.
  const ratio = variance / minVar;
  // Clamp ratio to prevent Infinity / huge numbers from causing weirdness.
  const r = Math.min(50, Math.max(0, ratio));

  // Smooth mapping: r/(r+1)
  const s = r / (r + 1);
  return Math.max(0, Math.min(1, s));
}