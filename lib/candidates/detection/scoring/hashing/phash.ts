

/*
  DRESZI — Perceptual hashing utilities (aHash + pHash)

  Requirements
  - Pure TypeScript/JS (no native deps)
  - Deterministic across retries
  - Designed to operate on grayscale pixel buffers

  Conventions
  - Returns 64-bit hashes encoded as lowercase hex (length 16)
  - Provides Hamming distance utility for 64-bit hex strings

  Notes
  - Caller should provide grayscale pixels (Uint8Array) in row-major order.
  - For performance, we downscale internally to small fixed grids.
*/

export type Hash64Hex = string; // lowercase hex, length 16

const PHASH_SIZE = 32;
const PHASH_DCT_LOW = 8;

function assertDims(width: number, height: number): void {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid dimensions (w=${width}, h=${height})`);
  }
}

function assertGrayscaleLength(grayscale: Uint8Array, width: number, height: number): void {
  const expected = Math.trunc(width) * Math.trunc(height);
  if (grayscale.length < expected) {
    throw new Error(`grayscale length ${grayscale.length} < expected ${expected}`);
  }
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

/**
 * Downscale grayscale to a fixed square grid using deterministic box sampling.
 *
 * This is stable and avoids floating-point drift by using integer accumulators.
 */
export function downscaleGrayscaleBox(
  grayscale: Uint8Array,
  width: number,
  height: number,
  outSize: number
): Uint8Array {
  assertDims(width, height);
  if (!Number.isFinite(outSize) || outSize <= 0) throw new Error(`Invalid outSize ${outSize}`);
  const w = Math.trunc(width);
  const h = Math.trunc(height);
  const s = Math.trunc(outSize);
  assertGrayscaleLength(grayscale, w, h);

  const out = new Uint8Array(s * s);

  // Map output pixel (ox,oy) to input range [x0,x1) and [y0,y1)
  for (let oy = 0; oy < s; oy++) {
    const y0 = Math.floor((oy * h) / s);
    const y1 = Math.floor(((oy + 1) * h) / s);
    const yy1 = Math.max(y0 + 1, y1);

    for (let ox = 0; ox < s; ox++) {
      const x0 = Math.floor((ox * w) / s);
      const x1 = Math.floor(((ox + 1) * w) / s);
      const xx1 = Math.max(x0 + 1, x1);

      let sum = 0;
      let count = 0;

      for (let y = y0; y < yy1; y++) {
        const row = y * w;
        for (let x = x0; x < xx1; x++) {
          sum += grayscale[row + x];
          count += 1;
        }
      }

      const avg = count > 0 ? Math.round(sum / count) : 0;
      out[oy * s + ox] = Math.max(0, Math.min(255, avg));
    }
  }

  return out;
}

function bitsToHex64(bits: Uint8Array): Hash64Hex {
  if (bits.length !== 64) throw new Error(`Expected 64 bits, got ${bits.length}`);

  // Pack into 16 nibbles
  let hex = "";
  for (let i = 0; i < 16; i++) {
    const b0 = bits[i * 4 + 0] & 1;
    const b1 = bits[i * 4 + 1] & 1;
    const b2 = bits[i * 4 + 2] & 1;
    const b3 = bits[i * 4 + 3] & 1;
    const nib = (b0 << 3) | (b1 << 2) | (b2 << 1) | b3;
    hex += nib.toString(16);
  }

  return hex.toLowerCase();
}

/**
 * Compute Average Hash (aHash).
 *
 * Steps
 * - Downscale to 8x8.
 * - Compute mean.
 * - Bit = 1 if pixel > mean else 0.
 */
export function aHash64Hex(grayscale: Uint8Array, width: number, height: number): Hash64Hex {
  assertDims(width, height);
  const small = downscaleGrayscaleBox(grayscale, width, height, 8);

  let sum = 0;
  for (let i = 0; i < small.length; i++) sum += small[i];
  const mean = sum / small.length;

  const bits = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    bits[i] = small[i] > mean ? 1 : 0;
  }

  return bitsToHex64(bits);
}

/**
 * 1D DCT-II for a fixed N with precomputed cosine table.
 */
function buildCosTable(N: number): Float64Array {
  const table = new Float64Array(N * N);
  const factor = Math.PI / (2 * N);
  for (let k = 0; k < N; k++) {
    for (let n = 0; n < N; n++) {
      table[k * N + n] = Math.cos((2 * n + 1) * k * factor);
    }
  }
  return table;
}

function dct1D(input: Float64Array, N: number, cosTable: Float64Array, out: Float64Array): void {
  // DCT-II with orthogonal normalization
  // X[k] = alpha(k) * sum_{n=0..N-1} x[n] * cos((2n+1)k*pi/(2N))
  const invSqrtN = 1 / Math.sqrt(N);
  const invSqrt2N = Math.sqrt(2 / N);

  for (let k = 0; k < N; k++) {
    let sum = 0;
    const base = k * N;
    for (let n = 0; n < N; n++) {
      sum += input[n] * cosTable[base + n];
    }
    const alpha = k === 0 ? invSqrtN : invSqrt2N;
    out[k] = alpha * sum;
  }
}

/**
 * Compute 2D DCT via separable 1D DCT: rows then columns.
 */
function dct2D(matrix: Float64Array, N: number, cosTable: Float64Array): Float64Array {
  const tmp = new Float64Array(N * N);
  const out = new Float64Array(N * N);

  const rowIn = new Float64Array(N);
  const rowOut = new Float64Array(N);

  // Rows
  for (let y = 0; y < N; y++) {
    const rowOff = y * N;
    for (let x = 0; x < N; x++) rowIn[x] = matrix[rowOff + x];
    dct1D(rowIn, N, cosTable, rowOut);
    for (let x = 0; x < N; x++) tmp[rowOff + x] = rowOut[x];
  }

  const colIn = new Float64Array(N);
  const colOut = new Float64Array(N);

  // Columns
  for (let x = 0; x < N; x++) {
    for (let y = 0; y < N; y++) colIn[y] = tmp[y * N + x];
    dct1D(colIn, N, cosTable, colOut);
    for (let y = 0; y < N; y++) out[y * N + x] = colOut[y];
  }

  return out;
}

function median(values: Float64Array): number {
  const arr = Array.from(values);
  arr.sort((a, b) => a - b);
  const mid = Math.floor(arr.length / 2);
  if (arr.length % 2 === 0) return (arr[mid - 1] + arr[mid]) / 2;
  return arr[mid];
}

let COS32: Float64Array | null = null;
function cos32(): Float64Array {
  if (!COS32) COS32 = buildCosTable(PHASH_SIZE);
  return COS32;
}

/**
 * Compute Perceptual Hash (pHash) 64-bit.
 *
 * Steps
 * - Downscale to 32x32.
 * - Compute 2D DCT.
 * - Take top-left 8x8 coefficients.
 * - Compute median of AC coefficients (excluding DC).
 * - Bit = 1 if coeff > median else 0; DC bit forced to 0.
 */
export function pHash64Hex(grayscale: Uint8Array, width: number, height: number): Hash64Hex {
  assertDims(width, height);
  const small = downscaleGrayscaleBox(grayscale, width, height, PHASH_SIZE);

  // Convert to float and optionally center by subtracting 128 (common in DCT usage)
  const mat = new Float64Array(PHASH_SIZE * PHASH_SIZE);
  for (let i = 0; i < mat.length; i++) mat[i] = small[i] - 128;

  const dct = dct2D(mat, PHASH_SIZE, cos32());

  // Extract 8x8 block
  const block = new Float64Array(PHASH_DCT_LOW * PHASH_DCT_LOW);
  let idx = 0;
  for (let y = 0; y < PHASH_DCT_LOW; y++) {
    for (let x = 0; x < PHASH_DCT_LOW; x++) {
      block[idx++] = dct[y * PHASH_SIZE + x];
    }
  }

  // Median of AC coefficients (exclude DC at index 0)
  const ac = new Float64Array(block.length - 1);
  for (let i = 1; i < block.length; i++) ac[i - 1] = block[i];
  const med = median(ac);

  const bits = new Uint8Array(64);
  // DC bit forced to 0 for stability
  bits[0] = 0;

  for (let i = 1; i < 64; i++) {
    bits[i] = block[i] > med ? 1 : 0;
  }

  return bitsToHex64(bits);
}

function assertHashHex64(h: string): asserts h is Hash64Hex {
  if (typeof h !== "string" || h.length !== 16) {
    throw new Error(`Invalid 64-bit hex hash length (expected 16, got ${String(h).length})`);
  }
  if (!/^[0-9a-fA-F]{16}$/.test(h)) {
    throw new Error(`Invalid 64-bit hex hash format: ${h}`);
  }
}

function popcountBigInt(x: bigint): number {
  const ZERO = BigInt(0);
  const ONE = BigInt(1);

  let n = 0;
  let v = x;
  while (v !== ZERO) {
    v &= v - ONE;
    n += 1;
  }
  return n;
}

/**
 * Compute Hamming distance between two 64-bit hex hashes.
 */
export function hammingDistance64Hex(a: Hash64Hex, b: Hash64Hex): number {
  assertHashHex64(a);
  assertHashHex64(b);

  const xa = BigInt(`0x${a}`);
  const xb = BigInt(`0x${b}`);
  const x = xa ^ xb;
  return popcountBigInt(x);
}

/**
 * Convert a Hamming distance into a similarity score (0..1).
 */
export function phashSimilarityFromHamming(dist: number): number {
  if (!Number.isFinite(dist)) return 0;
  const d = Math.max(0, Math.min(64, Math.trunc(dist)));
  return clamp01(1 - d / 64);
}