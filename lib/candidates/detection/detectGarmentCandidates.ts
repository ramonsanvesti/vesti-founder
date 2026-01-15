/*
  DRESZI — Candidate Detection Orchestrator (DRESZI-5.5)

  Beta-grade, serverless-safe pipeline:
  - Score frames (sharpness + exposure)
  - Localize torso-ish ROI (heuristic)
  - Crop (bounded)
  - Hash (pHash64 + sha256)
  - Lightweight local embedding (deterministic)
  - 2-stage dedupe (pHash Hamming + embedding cosine)
  - Rank + cap + safe fallback (may be empty; caller can mark processed_no_candidates)

  Notes
  - Designed for Vercel Node.js runtime constraints.
  - Does not require DB writes. Caller decides persistence.
*/

import sharp from "sharp";
import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";

import {
  ReasonCode,
  buildCandidateDetectionConfig,
  type CandidateDetectionConfig
} from "./config";

// -----------------------------
// Types
// -----------------------------

export type FrameRef =
  | {
      readonly frame_ts_ms: number;
      readonly kind: "path";
      readonly path: string;
    }
  | {
      readonly frame_ts_ms: number;
      readonly kind: "bytes";
      readonly bytes: Uint8Array;
    };

export interface CandidateCropBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly frame_w: number;
  readonly frame_h: number;
}

export interface DetectedCandidate {
  readonly candidate_id: string;
  readonly wardrobe_video_id: string;
  readonly user_id: string;
  readonly frame_ts_ms: number;
  readonly crop_box: CandidateCropBox;
  readonly confidence: number;
  readonly reason_codes: ReadonlyArray<ReasonCode>;
  readonly phash: string;
  readonly sha256: string;
  readonly bytes: number | null;
  readonly embedding_model: string;
  readonly embedding_vector?: ReadonlyArray<number>;
  readonly embedding_id?: string;
  readonly rank: number;
  readonly status: "generated";
}

export interface DetectCandidatesInput {
  readonly wardrobe_video_id: string;
  readonly user_id: string;
  readonly frames: ReadonlyArray<FrameRef>;
  /** Optional config override. Defaults to buildCandidateDetectionConfig(). */
  readonly config?: CandidateDetectionConfig;
  /** When true, emits per-candidate debug logs (in addition to the summary log). */
  readonly debug?: boolean;
  /** Hard upper bound for runtime in ms (extra guard). If omitted uses config.time_budget_ms. */
  readonly time_budget_ms_override?: number;
  /** If true, include `embedding_vector` in returned candidates. Default true (lightweight). */
  readonly include_embedding_vector?: boolean;
}

export interface DetectCandidatesSummary {
  readonly counts: {
    readonly frames_seen: number;
    readonly frames_scored: number;
    readonly crops_generated: number;
    readonly deduped_phash: number;
    readonly deduped_embedding: number;
    readonly candidates_returned: number;
  };
  readonly timings: {
    readonly decode_ms: number;
    readonly scoring_ms: number;
    readonly roi_ms: number;
    readonly crop_ms: number;
    readonly phash_ms: number;
    readonly embed_ms: number;
    readonly dedupe_ms: number;
    readonly total_ms: number;
  };
  readonly decisions: {
    readonly selected_frame_ts_ms: ReadonlyArray<number>;
    readonly fallback_used: boolean;
    readonly early_exit_reason: ReasonCode | null;
  };
  readonly reason_code_counts: Record<string, number>;
  readonly config_used: {
    readonly max_frames_to_score: number;
    readonly max_candidates: number;
    readonly max_width_used: number;
  };
}

export interface DetectCandidatesResult {
  readonly candidates: ReadonlyArray<DetectedCandidate>;
  readonly summary: DetectCandidatesSummary;
}

// -----------------------------
// Small utilities (pure + testable)
// -----------------------------

function clampInt(v: number, min: number, max: number): number {
  const n = Math.trunc(v);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function clampBox(
  x: number,
  y: number,
  w: number,
  h: number,
  frameW: number,
  frameH: number
): CandidateCropBox {
  const minW = 1;
  const minH = 1;

  const cw = clampInt(w, minW, frameW);
  const ch = clampInt(h, minH, frameH);

  const cx = clampInt(x, 0, Math.max(0, frameW - cw));
  const cy = clampInt(y, 0, Math.max(0, frameH - ch));

  return { x: cx, y: cy, w: cw, h: ch, frame_w: frameW, frame_h: frameH };
}

function nowMs(): number {
  return Date.now();
}

function sha256Hex(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

function hamming64Hex(a: string, b: string): number {
  // 16 hex chars => 64 bits
  if (a.length !== 16 || b.length !== 16) return Number.MAX_SAFE_INTEGER;
  let dist = 0;
  for (let i = 0; i < 16; i++) {
    const ai = parseInt(a[i], 16);
    const bi = parseInt(b[i], 16);
    const x = ai ^ bi;
    // popcount for 4-bit
    dist += (x & 1) + ((x >> 1) & 1) + ((x >> 2) & 1) + ((x >> 3) & 1);
  }
  return dist;
}

function cosineSimilarity(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function countReasons(codes: ReadonlyArray<ReasonCode>, map: Record<string, number>): void {
  for (const c of codes) map[c] = (map[c] ?? 0) + 1;
}

function stableSortByScore<T extends { readonly score: number; readonly tie_id: string }>(
  items: ReadonlyArray<T>
): T[] {
  return [...items].sort((a, b) => {
    const ds = (b.score || 0) - (a.score || 0);
    if (ds !== 0) return ds > 0 ? 1 : -1;
    if (a.tie_id < b.tie_id) return -1;
    if (a.tie_id > b.tie_id) return 1;
    return 0;
  });
}

// -----------------------------
// Image decode + metrics
// -----------------------------

interface DecodedImage {
  readonly width: number;
  readonly height: number;
  readonly gray: Uint8Array; // luminance 0..255
}

async function loadFrameToGray(frame: FrameRef, maxWidthUsed: number): Promise<DecodedImage> {
  const input =
    frame.kind === "path" ? await readFile(frame.path) : Buffer.from(frame.bytes);

  // Keep decode predictable: resize down to maxWidthUsed (if needed).
  const img = sharp(input, { failOnError: false }).rotate();
  const meta = await img.metadata();
  const w0 = meta.width ?? 0;
  const h0 = meta.height ?? 0;

  if (w0 <= 0 || h0 <= 0) {
    throw new Error("Invalid image dimensions");
  }

  const scale = w0 > maxWidthUsed ? maxWidthUsed / w0 : 1;
  const w = Math.max(1, Math.round(w0 * scale));
  const h = Math.max(1, Math.round(h0 * scale));

  const { data, info } = await img
    .resize({ width: w, height: h, fit: "inside" })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return { width: info.width, height: info.height, gray: new Uint8Array(data) };
}

function varianceOfLaplacian(gray: Uint8Array, width: number, height: number): number {
  // 3x3 Laplacian kernel: [0 1 0; 1 -4 1; 0 1 0]
  if (width < 3 || height < 3) return 0;

  const lap: number[] = [];
  lap.length = (width - 2) * (height - 2);

  let idx = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const c = gray[y * width + x] ?? 0;
      const up = gray[(y - 1) * width + x] ?? 0;
      const dn = gray[(y + 1) * width + x] ?? 0;
      const lf = gray[y * width + (x - 1)] ?? 0;
      const rt = gray[y * width + (x + 1)] ?? 0;
      lap[idx++] = up + dn + lf + rt - 4 * c;
    }
  }

  const n = lap.length;
  if (n === 0) return 0;

  let mean = 0;
  for (const v of lap) mean += v;
  mean /= n;

  let varSum = 0;
  for (const v of lap) {
    const d = v - mean;
    varSum += d * d;
  }

  return varSum / n;
}

function exposureScore(gray: Uint8Array): { score: number; flags: ReasonCode[] } {
  const n = gray.length;
  if (n === 0) return { score: 0, flags: [ReasonCode.E_LOW_SHARPNESS] };

  let sum = 0;
  let dark = 0;
  let bright = 0;
  for (const v of gray) {
    sum += v;
    if (v <= 10) dark += 1;
    if (v >= 245) bright += 1;
  }
  const mean = sum / n;
  const darkFrac = dark / n;
  const brightFrac = bright / n;

  // Penalize extreme exposure. Keep deterministic.
  let score = 1;
  const flags: ReasonCode[] = [];

  if (mean < 35 || darkFrac > 0.35) {
    score *= 0.4;
    flags.push(ReasonCode.E_LOW_SHARPNESS);
  }

  if (mean > 220 || brightFrac > 0.35) {
    score *= 0.4;
    flags.push(ReasonCode.E_LOW_SHARPNESS);
  }

  if (flags.length === 0) flags.push(ReasonCode.E_OK);
  return { score, flags };
}

function backgroundSimplicityProxy(gray: Uint8Array, width: number, height: number): number {
  // Lower edge density => simpler background.
  // We approximate with mean absolute Laplacian normalized.
  if (width < 3 || height < 3) return 0;
  let sumAbs = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const c = gray[y * width + x] ?? 0;
      const up = gray[(y - 1) * width + x] ?? 0;
      const dn = gray[(y + 1) * width + x] ?? 0;
      const lf = gray[y * width + (x - 1)] ?? 0;
      const rt = gray[y * width + (x + 1)] ?? 0;
      const lap = up + dn + lf + rt - 4 * c;
      sumAbs += Math.abs(lap);
      count += 1;
    }
  }
  if (count === 0) return 0;
  const meanAbs = sumAbs / count;

  // Map to 0..1 with a soft clamp.
  // Smaller meanAbs => closer to 1.
  const norm = Math.min(1, meanAbs / 35);
  return 1 - norm;
}

function garmentPresenceHeuristic(
  gray: Uint8Array,
  width: number,
  height: number
): { ok: boolean; score: number; metrics: { fgFrac: number; edgeFrac: number; varLum: number } } {
  if (width < 32 || height < 32 || gray.length !== width * height) {
    return { ok: false, score: 0, metrics: { fgFrac: 0, edgeFrac: 0, varLum: 0 } };
  }

  // Estimate background tone using an outer border band.
  const bw = Math.max(2, Math.floor(width * 0.08));
  const bh = Math.max(2, Math.floor(height * 0.08));

  let borderSum = 0;
  let borderN = 0;

  for (let y = 0; y < height; y++) {
    const isYBorder = y < bh || y >= height - bh;
    for (let x = 0; x < width; x++) {
      const isXBorder = x < bw || x >= width - bw;
      if (isYBorder || isXBorder) {
        borderSum += gray[y * width + x] ?? 0;
        borderN++;
      }
    }
  }

  const borderMean = borderN > 0 ? borderSum / borderN : 0;

  // Analyze a central ROI where clothing is most likely.
  const cx0 = Math.floor(width * 0.15);
  const cx1 = Math.floor(width * 0.85);
  const cy0 = Math.floor(height * 0.15);
  const cy1 = Math.floor(height * 0.9);

  const delta = 18; // minimal contrast vs background to count as foreground
  let fgCount = 0;
  let roiN = 0;

  // Cheap edge density proxy with abs(Laplacian)
  let edgeCount = 0;
  const edgeThr = 22;

  // Luminance variance to reject overly flat crops
  let sum = 0;
  let sum2 = 0;

  for (let y = cy0; y < cy1; y++) {
    for (let x = cx0; x < cx1; x++) {
      const v = gray[y * width + x] ?? 0;
      roiN++;

      const dv = Math.abs(v - borderMean);
      if (dv >= delta) fgCount++;

      sum += v;
      sum2 += v * v;

      if (x > 0 && x < width - 1 && y > 0 && y < height - 1) {
        const c = v;
        const up = gray[(y - 1) * width + x] ?? 0;
        const dn = gray[(y + 1) * width + x] ?? 0;
        const lf = gray[y * width + (x - 1)] ?? 0;
        const rt = gray[y * width + (x + 1)] ?? 0;
        const lap = up + dn + lf + rt - 4 * c;
        if (Math.abs(lap) >= edgeThr) edgeCount++;
      }
    }
  }

  const fgFrac = roiN > 0 ? fgCount / roiN : 0;
  const edgeFrac = roiN > 0 ? edgeCount / roiN : 0;

  const mean = roiN > 0 ? sum / roiN : 0;
  const varLum = roiN > 0 ? Math.max(0, sum2 / roiN - mean * mean) : 0;

  // Minimal thresholds (cheap, deterministic).
  const ok =
    fgFrac >= 0.12 &&
    fgFrac <= 0.92 &&
    edgeFrac >= 0.01 &&
    varLum >= 120;

  // Composite score ~0..1
  const score = Math.max(
    0,
    Math.min(
      1,
      fgFrac * 0.55 + (Math.min(0.08, edgeFrac) / 0.08) * 0.3 + (Math.min(900, varLum) / 900) * 0.15
    )
  );

  return { ok, score, metrics: { fgFrac, edgeFrac, varLum } };
}

function garmentPresenceHeuristicInBox(
  gray: Uint8Array,
  width: number,
  height: number,
  box: CandidateCropBox
): { ok: boolean; score: number; metrics: { fgFrac: number; edgeFrac: number; varLum: number } } {
  // Sampled, box-scoped version of garmentPresenceHeuristic to keep runtime low.
  // Uses a stride so we don't have to materialize a cropped buffer.
  const x0 = clampInt(box.x, 0, Math.max(0, width - 1));
  const y0 = clampInt(box.y, 0, Math.max(0, height - 1));
  const x1 = clampInt(box.x + box.w, 0, width);
  const y1 = clampInt(box.y + box.h, 0, height);

  const bw = Math.max(2, Math.floor((x1 - x0) * 0.08));
  const bh = Math.max(2, Math.floor((y1 - y0) * 0.08));

  // Target roughly <= ~160x160 samples for determinism + speed.
  const stride = Math.max(1, Math.floor(Math.min(x1 - x0, y1 - y0) / 160));

  let borderSum = 0;
  let borderN = 0;

  for (let y = y0; y < y1; y += stride) {
    const isYBorder = y < y0 + bh || y >= y1 - bh;
    for (let x = x0; x < x1; x += stride) {
      const isXBorder = x < x0 + bw || x >= x1 - bw;
      if (isYBorder || isXBorder) {
        borderSum += gray[y * width + x] ?? 0;
        borderN++;
      }
    }
  }

  const borderMean = borderN > 0 ? borderSum / borderN : 0;

  // Central ROI inside the box
  const rx0 = x0 + Math.floor((x1 - x0) * 0.12);
  const rx1 = x0 + Math.floor((x1 - x0) * 0.88);
  const ry0 = y0 + Math.floor((y1 - y0) * 0.12);
  const ry1 = y0 + Math.floor((y1 - y0) * 0.92);

  const delta = 18;
  const edgeThr = 22;

  let fgCount = 0;
  let roiN = 0;

  let edgeCount = 0;

  let sum = 0;
  let sum2 = 0;

  for (let y = ry0; y < ry1; y += stride) {
    for (let x = rx0; x < rx1; x += stride) {
      const v = gray[y * width + x] ?? 0;
      roiN++;

      const dv = Math.abs(v - borderMean);
      if (dv >= delta) fgCount++;

      sum += v;
      sum2 += v * v;

      if (x > 0 && x < width - 1 && y > 0 && y < height - 1) {
        const up = gray[(y - 1) * width + x] ?? 0;
        const dn = gray[(y + 1) * width + x] ?? 0;
        const lf = gray[y * width + (x - 1)] ?? 0;
        const rt = gray[y * width + (x + 1)] ?? 0;
        const lap = up + dn + lf + rt - 4 * v;
        if (Math.abs(lap) >= edgeThr) edgeCount++;
      }
    }
  }

  const fgFrac = roiN > 0 ? fgCount / roiN : 0;
  const edgeFrac = roiN > 0 ? edgeCount / roiN : 0;

  const mean = roiN > 0 ? sum / roiN : 0;
  const varLum = roiN > 0 ? Math.max(0, sum2 / roiN - mean * mean) : 0;

  // Same thresholds as the crop-level heuristic (cheap + deterministic)
  const ok =
    fgFrac >= 0.12 &&
    fgFrac <= 0.92 &&
    edgeFrac >= 0.01 &&
    varLum >= 120;

  const score = Math.max(
    0,
    Math.min(
      1,
      fgFrac * 0.55 + (Math.min(0.08, edgeFrac) / 0.08) * 0.3 + (Math.min(900, varLum) / 900) * 0.15
    )
  );

  return { ok, score, metrics: { fgFrac, edgeFrac, varLum } };
}

// -----------------------------
// ROI + crop
// -----------------------------

function torsoRoiBox(width: number, height: number): CandidateCropBox {
  // Heuristic: torso-ish box centered, favor vertical coverage.
  const cx = width / 2;
  const cy = height / 2;

  const w = width * 0.62;
  const h = height * 0.72;

  const x = cx - w / 2;
  const y = cy - h / 2 + height * 0.05; // slight downward bias

  return clampBox(x, y, w, h, width, height);
}

async function cropToJpeg(inputBytes: Uint8Array, box: CandidateCropBox, jpegQuality: number): Promise<Uint8Array> {
  const out = await sharp(inputBytes, { failOnError: false })
    .extract({ left: box.x, top: box.y, width: box.w, height: box.h })
    .jpeg({ quality: clampInt(jpegQuality, 40, 95), mozjpeg: true })
    .toBuffer();

  return new Uint8Array(out);
}

// -----------------------------
// pHash64 (DCT-based, deterministic)
// -----------------------------

function dct2d32(gray32: Uint8Array): Float64Array {
  // Input is 32x32 grayscale.
  const N = 32;
  const out = new Float64Array(N * N);

  // Precompute cosines for speed and determinism.
  const cosTable = new Float64Array(N * N);
  for (let u = 0; u < N; u++) {
    for (let x = 0; x < N; x++) {
      cosTable[u * N + x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N));
    }
  }

  const alpha = (k: number): number => (k === 0 ? Math.sqrt(1 / N) : Math.sqrt(2 / N));

  for (let v = 0; v < N; v++) {
    for (let u = 0; u < N; u++) {
      let sum = 0;
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const f = gray32[y * N + x] ?? 0;
          sum += f * cosTable[u * N + x] * cosTable[v * N + y];
        }
      }
      out[v * N + u] = alpha(u) * alpha(v) * sum;
    }
  }

  return out;
}

async function phash64HexFromGray(gray: Uint8Array, width: number, height: number): Promise<string> {
  // Resize to 32x32 then DCT; take top-left 8x8 (excluding DC) => 63 bits + 1.
  const N = 32;
  const resized = await sharp(Buffer.from(gray), {
    raw: { width, height, channels: 1 }
  })
    .resize({ width: N, height: N, fit: "fill" })
    .raw()
    .toBuffer();

  const dct = dct2d32(new Uint8Array(resized));

  // Collect 8x8 block excluding [0,0]
  const vals: number[] = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      if (x === 0 && y === 0) continue;
      vals.push(dct[y * 32 + x] ?? 0);
    }
  }

  const sorted = [...vals].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;

  // Build 64 bits: we include a leading 0 bit for alignment.
  const bits: number[] = [0];
  for (const v of vals) bits.push(v > median ? 1 : 0);
  while (bits.length < 64) bits.push(0);

  let hex = "";
  for (let i = 0; i < 64; i += 4) {
    const nib = (bits[i] << 3) | (bits[i + 1] << 2) | (bits[i + 2] << 1) | (bits[i + 3] << 0);
    hex += nib.toString(16);
  }
  return hex.padStart(16, "0").slice(0, 16);
}

// -----------------------------
// Lightweight local embedding
// -----------------------------

function embedLocal(gray: Uint8Array, width: number, height: number): ReadonlyArray<number> {
  // Deterministic compact descriptor: downsample to 16x8 (128 dims) and L2 normalize.
  const tw = 16;
  const th = 8;

  // Nearest-neighbor downsample (fast, deterministic)
  const vec = new Array<number>(tw * th);
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const sx = Math.min(width - 1, Math.floor((x / tw) * width));
      const sy = Math.min(height - 1, Math.floor((y / th) * height));
      const v = gray[sy * width + sx] ?? 0;
      vec[y * tw + x] = v / 255;
    }
  }

  // Normalize
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) vec[i] = (vec[i] ?? 0) / norm;
  }

  return vec;
}

// -----------------------------
// Main orchestrator
// -----------------------------

export async function detectGarmentCandidates(input: DetectCandidatesInput): Promise<DetectCandidatesResult> {
  const started = nowMs();
  const cfg = input.config ?? buildCandidateDetectionConfig();

  const timeBudgetMs =
    typeof input.time_budget_ms_override === "number" && input.time_budget_ms_override > 0
      ? input.time_budget_ms_override
      : cfg.time_budget_ms;

  const debug = input.debug === true;
  const includeEmbedding = input.include_embedding_vector !== false;

  const reasonCounts: Record<string, number> = {};

  const tDecode0 = nowMs();

  const framesSeen = input.frames.length;
  const framesToConsider = input.frames.slice(0, Math.max(0, cfg.max_frames_to_score));

  // Decode all considered frames to grayscale, bounded.
  const decoded: Array<{ ref: FrameRef; img: DecodedImage } | { ref: FrameRef; error: Error }> = [];
  for (const fr of framesToConsider) {
    if (nowMs() - started > timeBudgetMs) {
      break;
    }
    try {
      const img = await loadFrameToGray(fr, cfg.max_width_used);
      decoded.push({ ref: fr, img });
    } catch (e) {
      decoded.push({ ref: fr, error: e instanceof Error ? e : new Error("decode failed") });
    }
  }

  const decodeMs = nowMs() - tDecode0;

  const tScore0 = nowMs();

  // Score frames
  type ScoredFrame = {
    readonly ref: FrameRef;
    readonly img: DecodedImage;
    readonly score: number;
    readonly sharpness: number;
    readonly exposure: number;
    readonly bg_simple: number;
    readonly reason_codes: ReasonCode[];
    readonly tie_id: string;
  };

  const scored: ScoredFrame[] = [];

  for (const d of decoded) {
    if (nowMs() - started > timeBudgetMs) break;
    if ("error" in d) continue;

    const { img, ref } = d;

    const sharp = varianceOfLaplacian(img.gray, img.width, img.height);
    const exp = exposureScore(img.gray);
    const bg = backgroundSimplicityProxy(img.gray, img.width, img.height);

    const roiForPresence = torsoRoiBox(img.width, img.height);
    const pres = garmentPresenceHeuristicInBox(
      img.gray,
      img.width,
      img.height,
      roiForPresence
    );

    const reasons: ReasonCode[] = [];

    // Low sharpness flag (penalize)
    let sharpScore = sharp;
    if (sharp < cfg.scoring.sharpness_min_var) {
      reasons.push(ReasonCode.E_LOW_SHARPNESS);
      sharpScore *= 0.35;
    }

    // Exposure sanity influences scoring
    const exposureFactor = exp.score;
    for (const c of exp.flags) {
      if (c !== ReasonCode.E_OK) reasons.push(c);
    }

    // Normalize sharpness into a bounded 0..1 scale for combined ranking
    const sharpNormDenom = Math.max(1, cfg.scoring.sharpness_min_var * 4);
    const sharpNorm = Math.min(1, sharpScore / sharpNormDenom);

    const baseScore =
      sharpNorm * cfg.scoring.weight_sharpness +
      exposureFactor * cfg.scoring.weight_exposure +
      bg * cfg.scoring.weight_background_simplicity;

    // Key guardrail: prefer frames where the torso ROI actually looks like it contains a garment.
    // This reduces "false empty" runs that would otherwise fall back to the center frame.
    const garmentFactor = pres.ok ? 0.85 + 0.15 * pres.score : 0.35 + 0.15 * pres.score;

    const score = baseScore * garmentFactor;

    if (reasons.length === 0) reasons.push(ReasonCode.E_OK);

    scored.push({
      ref,
      img,
      score,
      sharpness: sharp,
      exposure: exposureFactor,
      bg_simple: bg,
      reason_codes: reasons,
      tie_id: `${ref.frame_ts_ms}`
    });
  }

  const scoringMs = nowMs() - tScore0;

  const tRoi0 = nowMs();

  // Select top frames to generate crops from.
  const maxFramesToCrop = clampInt(
    cfg.scoring.frames_for_roi,
    1,
    Math.max(1, cfg.max_frames_to_score)
  );

  const topFrames = stableSortByScore(scored).slice(0, maxFramesToCrop);
  const selectedTs = topFrames.map((f) => f.ref.frame_ts_ms);

  const roiMs = nowMs() - tRoi0;

  const tCrop0 = nowMs();

  // Generate one crop per selected frame
  type RawCandidate = {
    readonly candidate_id: string;
    readonly wardrobe_video_id: string;
    readonly user_id: string;
    readonly frame_ts_ms: number;
    readonly crop_box: CandidateCropBox;
    readonly confidence: number;
    readonly reason_codes: ReasonCode[];
    readonly crop_bytes: Uint8Array;
    readonly crop_gray: Uint8Array;
    readonly crop_w: number;
    readonly crop_h: number;
    readonly score: number;
    readonly tie_id: string;
  };

  const rawCands: RawCandidate[] = [];

  for (const f of topFrames) {
    if (nowMs() - started > timeBudgetMs) break;
    if (rawCands.length >= cfg.max_candidates_hard) break;

    const roi = torsoRoiBox(f.img.width, f.img.height);

    // Crop from original input bytes (not from grayscale raw), to preserve quality.
    const frameBytes =
      f.ref.kind === "path" ? await readFile(f.ref.path) : Buffer.from(f.ref.bytes);

    const cropBytes = await cropToJpeg(frameBytes, roi, resolveJpegQuality(cfg));

    // Decode crop to gray for hashing/embedding
    const cropDecoded = await sharp(Buffer.from(cropBytes), { failOnError: false })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const cropGray = new Uint8Array(cropDecoded.data);
    const cw = cropDecoded.info.width;
    const ch = cropDecoded.info.height;

    // ✅ Minimal garment presence gate BEFORE accepting this crop as a candidate.
    // This prevents false positives that later lead to fallback-only runs.
    const pres = garmentPresenceHeuristic(cropGray, cw, ch);
    if (!pres.ok) {
      if (debug) {
        console.info({
          at: "dreszi.candidates.crop.rejected_no_garment_signal",
          wardrobe_video_id: input.wardrobe_video_id,
          user_id: input.user_id,
          frame_ts_ms: f.ref.frame_ts_ms,
          metrics: pres.metrics
        });
      }
      continue;
    }

    // Confidence blends frame score + crop garment-presence score.
    const confidence = Math.max(0, Math.min(1, 0.15 + f.score * 0.55 + pres.score * 0.3));

    const reasons = [...f.reason_codes];
    if (reasons.length === 0) reasons.push(ReasonCode.E_OK);

    rawCands.push({
      candidate_id: randomUUID(),
      wardrobe_video_id: input.wardrobe_video_id,
      user_id: input.user_id,
      frame_ts_ms: f.ref.frame_ts_ms,
      crop_box: roi,
      confidence,
      reason_codes: reasons,
      crop_bytes: cropBytes,
      crop_gray: cropGray,
      crop_w: cw,
      crop_h: ch,
      score: f.score,
      tie_id: `${f.ref.frame_ts_ms}`
    });
  }
// Helper to resolve jpeg quality from config (deterministic)
function resolveJpegQuality(cfg: CandidateDetectionConfig): number {
  // Some repos keep this under cfg.output.jpeg_quality; others keep it at root.
  // Keep deterministic defaults even if config evolves.
  const u = cfg as unknown as { readonly output?: { readonly jpeg_quality?: number }; readonly jpeg_quality?: number };
  const q = u.output?.jpeg_quality ?? u.jpeg_quality;
  if (typeof q === "number" && Number.isFinite(q)) {
    return clampInt(q, 40, 95);
  }
  return 82;
}

  const cropMs = nowMs() - tCrop0;

  const tHash0 = nowMs();

  // Hashing + embedding (lightweight)
  type HashEmbedCandidate = {
    readonly candidate_id: string;
    readonly wardrobe_video_id: string;
    readonly user_id: string;
    readonly frame_ts_ms: number;
    readonly crop_box: CandidateCropBox;
    readonly confidence: number;
    readonly reason_codes: ReasonCode[];
    readonly phash: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly embedding_model: string;
    readonly embedding_vector: ReadonlyArray<number>;
    readonly score: number;
    readonly tie_id: string;
  };

  const hashed: HashEmbedCandidate[] = [];

  for (const c of rawCands) {
    if (nowMs() - started > timeBudgetMs) break;

    const sha = sha256Hex(c.crop_bytes);
    const ph = await phash64HexFromGray(c.crop_gray, c.crop_w, c.crop_h);
    const emb = embedLocal(c.crop_gray, c.crop_w, c.crop_h);

    hashed.push({
      candidate_id: c.candidate_id,
      wardrobe_video_id: c.wardrobe_video_id,
      user_id: c.user_id,
      frame_ts_ms: c.frame_ts_ms,
      crop_box: c.crop_box,
      confidence: c.confidence,
      reason_codes: [...c.reason_codes],
      phash: ph,
      sha256: sha,
      bytes: c.crop_bytes.length,
      embedding_model: "local:downsample-16x8",
      embedding_vector: emb,
      score: c.score,
      tie_id: c.tie_id
    });
  }

  const phashMs = nowMs() - tHash0;

  const tEmbed0 = nowMs();
  // Embedding already computed locally above, but keep timing field.
  const embedMs = nowMs() - tEmbed0;

  // -----------------------------
  // 2-stage dedupe
  // -----------------------------

  const tDedupeStart = nowMs();

  const winners: HashEmbedCandidate[] = [];
  const suppressed: HashEmbedCandidate[] = [];
  let dedupedPhash = 0;
  let dedupedEmb = 0;
  let earlyExit: ReasonCode | null = null;

  const sortedCands = stableSortByScore(
    hashed.map((h) => ({ ...h, tie_id: h.candidate_id }))
  );

  for (const cand of sortedCands) {
    if (nowMs() - started > timeBudgetMs) {
      earlyExit = ReasonCode.E_EARLY_EXIT_TIME_BUDGET;
      break;
    }

    if (winners.length >= cfg.max_candidates) {
      earlyExit = ReasonCode.E_MAX_CANDIDATES_CAPPED;
      break;
    }

    let isDup = false;

    for (const win of winners) {
      // Stage 1
      const dist = hamming64Hex(cand.phash, win.phash);
      if (dist <= cfg.dedupe.phash_hamming_threshold) {
        cand.reason_codes.push(ReasonCode.E_DUPLICATE_SUPPRESSED_PHASH);
        dedupedPhash += 1;
        isDup = true;
        break;
      }

      // Stage 2
      const sim = cosineSimilarity(cand.embedding_vector, win.embedding_vector);
      if (sim >= cfg.dedupe.embedding_cosine_threshold) {
        cand.reason_codes.push(ReasonCode.E_DUPLICATE_SUPPRESSED_EMBEDDING);
        dedupedEmb += 1;
        isDup = true;
        break;
      }
    }

    if (isDup) {
      suppressed.push(cand);
    } else {
      if (cand.reason_codes.length === 0) cand.reason_codes.push(ReasonCode.E_OK);
      winners.push(cand);
    }
  }

  const dedupeMs = nowMs() - tDedupeStart;

  // -----------------------------
  // Fallback (never empty if frames exist)
  // -----------------------------

  let fallbackUsed = false;

  if (framesSeen > 0 && winners.length === 0) {
    fallbackUsed = true;

    // Choose center-ish frame: prefer the middle of scored list, else any decoded.
    const bestScored = stableSortByScore(scored).at(0);
    const firstDecoded = decoded.find(
      (d): d is { ref: FrameRef; img: DecodedImage } => "img" in d
    );

    const pick: { ref: FrameRef; img: DecodedImage } | null = bestScored
      ? { ref: bestScored.ref, img: bestScored.img }
      : firstDecoded ?? null;

    if (pick) {
      const img = pick.img;
      const ref = pick.ref;

      const roi = torsoRoiBox(img.width, img.height);

      const frameBytes =
        ref.kind === "path" ? await readFile(ref.path) : Buffer.from(ref.bytes);

      const cropBytes = await cropToJpeg(frameBytes, roi, resolveJpegQuality(cfg));

      const cropDecoded = await sharp(Buffer.from(cropBytes), { failOnError: false })
        .grayscale()
        .raw()
        .toBuffer({ resolveWithObject: true });

      const cropGray = new Uint8Array(cropDecoded.data);
      const cw = cropDecoded.info.width;
      const ch = cropDecoded.info.height;

      const pres = garmentPresenceHeuristic(cropGray, cw, ch);

      if (!pres.ok) {
        console.info({
          at: "dreszi.candidates.fallback.rejected",
          wardrobe_video_id: input.wardrobe_video_id,
          user_id: input.user_id,
          metrics: pres.metrics
        });
        // Do NOT emit a fallback candidate if the crop doesn't look like it contains a garment.
        // Returning no candidates allows the caller to mark the video as `processed_no_candidates`.
      } else {
        const sha = sha256Hex(cropBytes);
        const ph = await phash64HexFromGray(cropGray, cw, ch);
        const emb = embedLocal(cropGray, cw, ch);

        const reasonCodes: ReasonCode[] = [ReasonCode.E_FALLBACK_CENTER_FRAME];

        const candidate: HashEmbedCandidate = {
          candidate_id: randomUUID(),
          wardrobe_video_id: input.wardrobe_video_id,
          user_id: input.user_id,
          frame_ts_ms: ref.frame_ts_ms,
          crop_box: roi,
          confidence: Math.max(0.2, Math.min(0.6, 0.25 + pres.score * 0.45)),
          reason_codes: reasonCodes,
          phash: ph,
          sha256: sha,
          bytes: cropBytes.length,
          embedding_model: "local:downsample-16x8",
          embedding_vector: emb,
          score: 0,
          tie_id: "fallback"
        };

        winners.push(candidate);
      }
    }
  }

  // Rank stable ordering
  const finalSorted = stableSortByScore(
    winners.map((w) => ({ ...w, tie_id: w.candidate_id }))
  );

  const candidates: DetectedCandidate[] = finalSorted.map((c, idx) => {
    const rc = c.reason_codes.length === 0 ? [ReasonCode.E_OK] : c.reason_codes;
    countReasons(rc, reasonCounts);

    const out: DetectedCandidate = {
      candidate_id: c.candidate_id,
      wardrobe_video_id: c.wardrobe_video_id,
      user_id: c.user_id,
      frame_ts_ms: c.frame_ts_ms,
      crop_box: c.crop_box,
      confidence: Math.max(0, Math.min(1, c.confidence)),
      reason_codes: rc,
      phash: c.phash,
      sha256: c.sha256,
      bytes: Number.isFinite(c.bytes) ? c.bytes : null,
      embedding_model: c.embedding_model,
      rank: idx + 1,
      status: "generated"
    };

    if (includeEmbedding) {
      return { ...out, embedding_vector: c.embedding_vector };
    }

    return out;
  });

  const totalMs = nowMs() - started;

  const summary: DetectCandidatesSummary = {
    counts: {
      frames_seen: framesSeen,
      frames_scored: scored.length,
      crops_generated: rawCands.length,
      deduped_phash: dedupedPhash,
      deduped_embedding: dedupedEmb,
      candidates_returned: candidates.length
    },
    timings: {
      decode_ms: decodeMs,
      scoring_ms: scoringMs,
      roi_ms: roiMs,
      crop_ms: cropMs,
      phash_ms: phashMs,
      embed_ms: embedMs,
      dedupe_ms: dedupeMs,
      total_ms: totalMs
    },
    decisions: {
      selected_frame_ts_ms: selectedTs,
      fallback_used: fallbackUsed,
      early_exit_reason: earlyExit
    },
    reason_code_counts: reasonCounts,
    config_used: {
      max_frames_to_score: cfg.max_frames_to_score,
      max_candidates: cfg.max_candidates,
      max_width_used: cfg.max_width_used
    }
  };

  // Structured summary log (single per run)
  // NOTE: Keep logs concise; per-candidate only on debug.
  console.info({
    at: "dreszi.candidates.detect.summary",
    wardrobe_video_id: input.wardrobe_video_id,
    user_id: input.user_id,
    ...summary
  });

  if (debug) {
    for (const c of candidates) {
      console.info({
        at: "dreszi.candidates.detect.candidate",
        wardrobe_video_id: input.wardrobe_video_id,
        user_id: input.user_id,
        candidate_id: c.candidate_id,
        frame_ts_ms: c.frame_ts_ms,
        rank: c.rank,
        confidence: c.confidence,
        crop_box: c.crop_box,
        reason_codes: c.reason_codes,
        phash: c.phash,
        sha256: c.sha256,
        bytes: c.bytes
      });
    }
  }

  return { candidates, summary };
}