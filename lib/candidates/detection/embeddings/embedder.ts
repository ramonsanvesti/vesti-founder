

/*
  DRESZI — Embedding interface + lightweight local baseline

  Goal
  - Provide a pluggable embedding interface for stage-2 dedupe.
  - Offer a deterministic local embedder fallback that is cheap to run in serverless.

  Baseline embedder (TinyBlockEmbedder)
  - Takes grayscale pixels of a crop
  - Downscales to a fixed grid (e.g., 16x16)
  - Computes block means and a few simple moment features
  - Normalizes into a vector and returns it

  This is NOT a semantic model like CLIP.
  But it is good enough as a second-stage similarity gate when combined with pHash,
  and it is deterministic and fast.
*/

import type { CandidateDetectionConfig } from "../config";
import { downscaleGrayscaleBox } from "../scoring/hashing/phash";

export interface Embedder {
  readonly model: string;
  /** Returns a deterministic vector for the same input bytes/pixels. */
  embedFromGrayscale(grayscale: Uint8Array, width: number, height: number): Promise<ReadonlyArray<number>>;
}

export interface Similarity {
  readonly cosine: number;
}

function assertDims(width: number, height: number): void {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid dims (w=${width}, h=${height})`);
  }
}

// Support multiple config shapes without leaking `any`.
// We keep CandidateDetectionConfig as the source of truth, but allow optional nesting
// for embedding-related overrides during refactors.
type CfgEmbeddingCompat = CandidateDetectionConfig & {
  readonly embedding?: { readonly tinyblock_grid?: number };
  readonly embeddings?: { readonly tinyblock_grid?: number };
  readonly dedupe?: { readonly embedding?: { readonly tinyblock_grid?: number } };
};

function getTinyblockGrid(cfg: CandidateDetectionConfig): number {
  const c = cfg as CfgEmbeddingCompat;
  const v = c.embeddings?.tinyblock_grid ?? c.embedding?.tinyblock_grid ?? c.dedupe?.embedding?.tinyblock_grid;
  if (Number.isFinite(v) && (v as number) > 0) return Math.trunc(v as number);
  return 16;
}

function dot(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

function norm(a: ReadonlyArray<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s);
}

export function cosineSimilarity(a: ReadonlyArray<number>, b: ReadonlyArray<number>): Similarity {
  const na = norm(a);
  const nb = norm(b);
  if (na === 0 || nb === 0) return { cosine: 0 };
  const c = dot(a, b) / (na * nb);
  // Clamp numerical noise
  return { cosine: Math.max(-1, Math.min(1, c)) };
}

function l2Normalize(vec: number[]): number[] {
  const n = norm(vec);
  if (n === 0) return vec;
  for (let i = 0; i < vec.length; i++) vec[i] /= n;
  return vec;
}

/**
 * Deterministic local embedder.
 *
 * This embedder is extremely cheap:
 * - downscale grayscale to 16x16
 * - take normalized pixel intensities
 * - append a few moment features (mean, variance)
 */
export class TinyBlockEmbedder implements Embedder {
  readonly model = "dreszi.tinyblock.v1";

  constructor(private readonly cfg: CandidateDetectionConfig) {}

  async embedFromGrayscale(grayscale: Uint8Array, width: number, height: number): Promise<ReadonlyArray<number>> {
    assertDims(width, height);

    const s = Math.max(8, Math.min(32, getTinyblockGrid(this.cfg))); // default expected 16
    const small = downscaleGrayscaleBox(grayscale, width, height, s);

    // Normalize pixels to 0..1
    const vec: number[] = new Array(small.length + 2);

    let sum = 0;
    for (let i = 0; i < small.length; i++) {
      const v = small[i] / 255;
      vec[i] = v;
      sum += v;
    }

    const mean = sum / small.length;

    let varSum = 0;
    for (let i = 0; i < small.length; i++) {
      const d = vec[i] - mean;
      varSum += d * d;
    }

    const variance = varSum / small.length;

    // Append moments
    vec[small.length] = mean;
    vec[small.length + 1] = variance;

    return l2Normalize(vec);
  }
}

/**
 * Factory: select an embedder.
 *
 * If a remote/real model is provided elsewhere, it should implement Embedder and be injected.
 * This factory provides a deterministic local default.
 */
export function createDefaultEmbedder(cfg: CandidateDetectionConfig): Embedder {
  return new TinyBlockEmbedder(cfg);
}