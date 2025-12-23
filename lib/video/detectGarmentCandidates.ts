// lib/video/detectGarmentCandidates.ts
// Detect distinct garment candidates from extracted video frames.
// Lightweight and deterministic (no heavy ML yet).
//
// Approach (v0):
// 1) Compute a perceptual hash (dHash) for each frame using sharp.
// 2) Score frames with simple heuristics (exposure/contrast/size).
// 3) Dedupe near-duplicates using Hamming distance over dHash.
// 4) Return top-N unique candidates.
//
// Notes:
// - No BigInt usage (works even if TS target < ES2020).
// - Frames are ephemeral; caller decides persistence.

import sharp from "sharp";
import { readFile } from "node:fs/promises";
import crypto from "node:crypto";

export type GarmentCandidate = {
  candidate_id: string;
  frame_index: number;

  // Stable dedupe key (used by persistence + downstream)
  // For v0 we use dHash encoded as 16-hex string (64 bits)
  fingerprint: string;

  // Kept for debugging/analysis
  dhash_hex: string;

  // 0..1 (deterministic ranking)
  score: number;

  // Candidate image buffer (downscaled) in original encoded form
  image: Buffer;

  // Candidate image buffer encoded as WebP (preferred for storage/display)
  image_webp: Buffer;
  image_webp_mime: "image/webp";

  // Optional: where this frame came from
  frame_path?: string;

  // Metadata
  width: number;
  height: number;
};

export type DetectGarmentCandidatesArgs =
  | {
      frames: Buffer[];
      framePaths?: never;
      // Upper bound of candidates to return
      maxCandidates?: number;
      // Hamming distance threshold for dedupe (0..64). Lower = stricter.
      dedupeHammingThreshold?: number;
      // Optionally downscale frames before hashing/scoring
      maxSidePx?: number;
      // Concurrency limit for sharp work
      concurrency?: number;
    }
  | {
      frames?: never;
      framePaths: string[];
      // Upper bound of candidates to return
      maxCandidates?: number;
      // Hamming distance threshold for dedupe (0..64). Lower = stricter.
      dedupeHammingThreshold?: number;
      // Optionally downscale frames before hashing/scoring
      maxSidePx?: number;
      // Concurrency limit for sharp work
      concurrency?: number;
    };

const DEFAULTS = {
  maxCandidates: 10,
  dedupeHammingThreshold: 10,
  maxSidePx: 900,
  concurrency: 4,

  // Drop frames that are essentially unusable (too dark/bright/flat)
  minScore: 0.22,

  // Prefer fewer but stronger candidates; if true we still return at least 1 if any frames exist
  preferHighQuality: true,
};

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function uuidLike(): string {
  // Lightweight unique id. Deterministic uniqueness is not required here.
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

function stableCandidateId(fingerprint: string, frameIndex: number): string {
  // Deterministic id for retry-safe inserts.
  // Using sha1 is fine here (not for security), just compact determinism.
  const h = crypto.createHash("sha1");
  h.update(`${fingerprint}:${frameIndex}`);
  return h.digest("hex").slice(0, 24);
}

// Precomputed popcount for 8-bit integers.
const POPCOUNT_8 = (() => {
  const arr = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let v = i;
    let c = 0;
    while (v) {
      v &= v - 1;
      c++;
    }
    arr[i] = c;
  }
  return arr;
})();

function hexFromBytes(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

function bytesFromHex(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase();
  const out = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function hammingHex(aHex: string, bHex: string): number {
  const a = bytesFromHex(aHex);
  const b = bytesFromHex(bHex);
  const n = Math.min(a.length, b.length);
  let dist = 0;
  for (let i = 0; i < n; i++) {
    dist += POPCOUNT_8[a[i] ^ b[i]];
  }
  // If lengths differ (should not), count remaining bytes as fully different.
  dist += Math.abs(a.length - b.length) * 8;
  return dist;
}

async function downscaleIfNeeded(buf: Buffer, maxSidePx: number): Promise<Buffer> {
  const meta = await sharp(buf).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (!w || !h) return buf;

  const maxSide = Math.max(w, h);
  if (maxSide <= maxSidePx) return buf;

  const scale = maxSidePx / maxSide;
  const nw = Math.max(1, Math.round(w * scale));
  const nh = Math.max(1, Math.round(h * scale));

  return sharp(buf)
    .resize(nw, nh, { fit: "inside", withoutEnlargement: true })
    .toBuffer();
}

async function toWebP(buf: Buffer): Promise<Buffer> {
  // Deterministic-ish WebP output for storage/display
  // Keep quality moderate to reduce payload size.
  return sharp(buf)
    .webp({ quality: 82, effort: 4 })
    .toBuffer();
}

async function computeDetailScore01(buf: Buffer): Promise<number> {
  // Deterministic, lightweight sharpness/detail proxy.
  // We downsample to 64x64 grayscale and compute average absolute gradient.
  const w = 64;
  const h = 64;

  const raw = await sharp(buf)
    .resize(w, h, { fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer();

  let sum = 0;
  let count = 0;

  // Horizontal + vertical gradients
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      const v = raw[i];

      if (x + 1 < w) {
        sum += Math.abs(v - raw[i + 1]);
        count++;
      }
      if (y + 1 < h) {
        sum += Math.abs(v - raw[i + w]);
        count++;
      }
    }
  }

  if (!count) return 0;

  // Normalize: typical useful gradients cluster below ~25 for 8-bit grayscale.
  const avg = sum / count;
  return clamp(avg / 25, 0, 1);
}

/**
 * Compute a dHash (difference hash) for the image.
 * Returns 8 bytes (64 bits) encoded as 16-char hex.
 */
async function computeDHashHex(buf: Buffer): Promise<string> {
  // dHash: resize to 9x8 grayscale, compare adjacent pixels horizontally.
  const raw = await sharp(buf)
    .resize(9, 8, { fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer();

  // raw length = 72 (9*8)
  const bytes = new Uint8Array(8); // 64 bits

  let bitIndex = 0;
  for (let y = 0; y < 8; y++) {
    const rowOffset = y * 9;
    for (let x = 0; x < 8; x++) {
      const left = raw[rowOffset + x];
      const right = raw[rowOffset + x + 1];
      const bit = left < right ? 1 : 0;

      const byteIdx = Math.floor(bitIndex / 8);
      const bitInByte = 7 - (bitIndex % 8);
      if (bit) bytes[byteIdx] |= 1 << bitInByte;

      bitIndex++;
    }
  }

  return hexFromBytes(bytes);
}

/**
 * Deterministic scoring heuristic.
 * Higher score means "more informative" frame (better lighting/contrast/detail).
 */
async function scoreFrame(buf: Buffer): Promise<{ score: number; width: number; height: number }> {
  const img = sharp(buf);
  const meta = await img.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;

  // Stats proxy for exposure + contrast.
  const stats = await img.stats().catch(() => null);

  // Detail/sharpness proxy.
  const detail = await computeDetailScore01(buf).catch(() => 0);

  // If stats unavailable, score by size + detail only.
  if (!stats || !stats.channels?.length) {
    const sizeScore = clamp((width * height) / (900 * 900), 0, 1);
    const score = 0.40 * sizeScore + 0.60 * detail;
    return { score: clamp(score, 0, 1), width, height };
  }

  // Use luminance channel proxy.
  const ch0 = stats.channels[0];
  const mean = ch0.mean ?? 128;
  const stdev = ch0.stdev ?? 0;

  // Exposure score: best around mid (128). Penalize too dark/bright.
  const exposure = 1 - Math.abs(mean - 128) / 128;

  // Contrast/detail score: higher stdev is usually more detail.
  const contrast = clamp(stdev / 64, 0, 1);

  // Size score: prefer larger frames (up to a cap)
  const sizeScore = clamp((width * height) / (900 * 900), 0, 1);

  // Flatness penalty: if contrast and detail are both low, this is likely a blur/empty frame.
  const flatPenalty = clamp(1 - (0.55 * contrast + 0.45 * detail), 0, 1);

  // Combine deterministically.
  // We weight exposure, detail, contrast, then size.
  let score = 0.28 * exposure + 0.30 * detail + 0.27 * contrast + 0.15 * sizeScore;

  // Apply a small penalty for extremely flat frames.
  score = score - 0.10 * flatPenalty;

  return { score: clamp(score, 0, 1), width, height };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, idx: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) break;
      out[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker());
  await Promise.all(workers);
  return out;
}

/**
 * Main entry.
 * Returns up to `maxCandidates` unique candidates based on hash dedupe.
 */
export async function detectGarmentCandidates(args: DetectGarmentCandidatesArgs): Promise<GarmentCandidate[]> {
  const maxCandidates = (args as any).maxCandidates ?? DEFAULTS.maxCandidates;
  const dedupeHammingThreshold = (args as any).dedupeHammingThreshold ?? DEFAULTS.dedupeHammingThreshold;
  const maxSidePx = (args as any).maxSidePx ?? DEFAULTS.maxSidePx;
  const concurrency = (args as any).concurrency ?? DEFAULTS.concurrency;

  const minScore = (args as any).minScore ?? DEFAULTS.minScore;
  const preferHighQuality = (args as any).preferHighQuality ?? DEFAULTS.preferHighQuality;

  // Keep sharp predictable under serverless load
  try {
    sharp.concurrency(Math.max(1, Math.min(8, concurrency)));
  } catch {
    // ignore
  }

  const framePaths = (args as any).framePaths as string[] | undefined;
  const frames = (args as any).frames as Buffer[] | undefined;

  const items: Array<{ idx: number; buf: Buffer; frame_path?: string }> = [];

  if (Array.isArray(framePaths) && framePaths.length) {
    const loaded = await mapLimit(
      framePaths,
      concurrency,
      async (p, idx) => {
        const buf = await readFile(p);
        return { idx, buf, frame_path: p };
      }
    );
    items.push(...loaded);
  } else if (Array.isArray(frames) && frames.length) {
    for (let i = 0; i < frames.length; i++) items.push({ idx: i, buf: frames[i] });
  } else {
    return [];
  }

  // Analyze frames (bounded concurrency to avoid sharp spikes)
  const analyzed = await mapLimit(items, concurrency, async (it) => {
    const buf = await downscaleIfNeeded(it.buf, maxSidePx);
    const dhash_hex = await computeDHashHex(buf);
    const { score, width, height } = await scoreFrame(buf);

    // Preferred storage/display format
    const webp = await toWebP(buf);

    return {
      idx: it.idx,
      buf,
      webp,
      frame_path: it.frame_path,
      dhash_hex,
      score,
      width,
      height,
    };
  });

  // Sort by score desc (best first)
  analyzed.sort((a, b) => b.score - a.score);

  // Optional quality filter (still deterministic)
  const filtered = preferHighQuality ? analyzed.filter((a) => a.score >= minScore) : analyzed;
  const pool = filtered.length ? filtered : analyzed; // always have something if frames exist

  // Pick unique by hash distance
  const picked: GarmentCandidate[] = [];
  const pickedHashes: string[] = [];

  for (const a of pool) {
    if (picked.length >= maxCandidates) break;

    let isDup = false;
    for (const h of pickedHashes) {
      const d = hammingHex(a.dhash_hex, h);
      if (d <= dedupeHammingThreshold) {
        isDup = true;
        break;
      }
    }
    if (isDup) continue;

    picked.push({
      candidate_id: stableCandidateId(a.dhash_hex, a.idx),
      frame_index: a.idx,

      fingerprint: a.dhash_hex,
      dhash_hex: a.dhash_hex,

      score: a.score,

      image: a.buf,
      image_webp: a.webp,
      image_webp_mime: "image/webp",

      frame_path: a.frame_path,
      width: a.width,
      height: a.height,
    });
    pickedHashes.push(a.dhash_hex);
  }

  return picked;
}
