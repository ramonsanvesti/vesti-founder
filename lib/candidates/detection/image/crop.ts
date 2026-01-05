/*
  DRESZI — Crop utilities + encoding (serverless-safe)

  Responsibilities
  - Crop pixels from decoded RGBA/grayscale using a CropBox.
  - Encode candidate crop bytes (JPEG) deterministically for hashing + embeddings.

  Notes
  - Uses `sharp` for encoding (native, fast, predictable).
  - Keeps encoding settings stable for deterministic downstream hashes.
*/

import type { CropBox } from "../types";
import type { CandidateDetectionConfig } from "../config";
import { clampCropBoxToFrame } from "../roi/clamp";

export interface CroppedImage {
  readonly crop_box: CropBox;
  /** Cropped RGBA pixels */
  readonly rgba: Uint8Array;
  /** Cropped grayscale pixels */
  readonly grayscale: Uint8Array;
  readonly width: number;
  readonly height: number;
}

export interface EncodedCrop {
  readonly mime: "image/jpeg";
  readonly bytes: Uint8Array;
  readonly bytes_length: number;
  readonly width: number;
  readonly height: number;
}

export class CropError extends Error {
  readonly name = "CropError";
  constructor(message: string, readonly cause?: unknown) {
    super(message);
  }
}

async function loadSharpOrThrow(): Promise<unknown> {
  try {
    const mod = await import("sharp");
    return (mod as unknown as { default?: unknown }).default ?? (mod as unknown);
  } catch (e) {
    throw new CropError("sharp is required for DRESZI crop encoding. Install 'sharp'.", e);
  }
}

function assertDecodedDims(frame_w: number, frame_h: number, rgba: Uint8Array, grayscale: Uint8Array): void {
  const w = Math.trunc(frame_w);
  const h = Math.trunc(frame_h);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    throw new CropError(`Invalid decoded dims (w=${frame_w}, h=${frame_h})`);
  }
  const expRgba = w * h * 4;
  const expGray = w * h;
  if (rgba.length < expRgba) throw new CropError(`RGBA length ${rgba.length} < expected ${expRgba}`);
  if (grayscale.length < expGray) throw new CropError(`grayscale length ${grayscale.length} < expected ${expGray}`);
}

function assertCropBox(c: CropBox): void {
  const vals: Array<[keyof CropBox, number]> = [
    ["x", c.x],
    ["y", c.y],
    ["w", c.w],
    ["h", c.h],
    ["frame_w", c.frame_w],
    ["frame_h", c.frame_h]
  ];

  for (const [k, v] of vals) {
    if (!Number.isFinite(v)) throw new CropError(`CropBox.${String(k)} is not finite`);
  }
}

/**
 * Crop RGBA + grayscale buffers from a decoded frame.
 */
export function cropFromDecoded(params: {
  frame_w: number;
  frame_h: number;
  rgba: Uint8Array;
  grayscale: Uint8Array;
  crop_box: CropBox;
  config: CandidateDetectionConfig;
}): CroppedImage {
  assertDecodedDims(params.frame_w, params.frame_h, params.rgba, params.grayscale);
  assertCropBox(params.crop_box);

  // Clamp crop
  const clamped = clampCropBoxToFrame({
    x: params.crop_box.x,
    y: params.crop_box.y,
    w: params.crop_box.w,
    h: params.crop_box.h,
    frame_w: params.frame_w,
    frame_h: params.frame_h,
    min_dim: params.config.min_crop_dim_px
  });

  const c = clamped.crop;
  const w = Math.trunc(params.frame_w);

  const outW = Math.trunc(c.w);
  const outH = Math.trunc(c.h);

  const rgbaOut = new Uint8Array(outW * outH * 4);
  const grayOut = new Uint8Array(outW * outH);

  // Copy row-by-row for cache locality
  for (let yy = 0; yy < outH; yy++) {
    const srcY = c.y + yy;
    const srcRgbaRow = (srcY * w + c.x) * 4;
    const dstRgbaRow = yy * outW * 4;
    rgbaOut.set(params.rgba.subarray(srcRgbaRow, srcRgbaRow + outW * 4), dstRgbaRow);

    const srcGrayRow = srcY * w + c.x;
    const dstGrayRow = yy * outW;
    grayOut.set(params.grayscale.subarray(srcGrayRow, srcGrayRow + outW), dstGrayRow);
  }

  return {
    crop_box: c,
    rgba: rgbaOut,
    grayscale: grayOut,
    width: outW,
    height: outH
  };
}

type SharpFactory = (input: Buffer, options?: { failOnError?: boolean; raw?: { width: number; height: number; channels: number } }) => any;

/**
 * Encode a cropped RGBA buffer to JPEG deterministically.
 *
 * Determinism notes
 * - JPEG is not perfectly deterministic across libjpeg versions, but within the same
 *   runtime environment this is stable enough for beta idempotency.
 * - If you need absolute determinism across environments, use PNG, but it costs more bytes.
 */
export async function encodeCropToJpeg(params: {
  cropped: CroppedImage;
  config: CandidateDetectionConfig;
}): Promise<EncodedCrop> {
  const sharpMod = await loadSharpOrThrow();
  const sharp = sharpMod as unknown as SharpFactory;
  const c = params.cropped;

  // Stable encoding settings.
  const q = Math.max(40, Math.min(95, Math.trunc(params.config.encoding.quality)));

  try {
    const buf = await sharp(Buffer.from(c.rgba), {
      raw: { width: c.width, height: c.height, channels: 4 }
    })
      .jpeg({
        quality: q,
        mozjpeg: false
      })
      .toBuffer();

    const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);

    return {
      mime: "image/jpeg",
      bytes,
      bytes_length: bytes.byteLength,
      width: c.width,
      height: c.height
    };
  } catch (e) {
    throw new CropError("Failed to encode crop to JPEG", e);
  }
}

/**
 * Convenience: crop + encode in one step.
 */
export async function cropAndEncodeJpeg(params: {
  frame_w: number;
  frame_h: number;
  rgba: Uint8Array;
  grayscale: Uint8Array;
  crop_box: CropBox;
  config: CandidateDetectionConfig;
}): Promise<{ cropped: CroppedImage; encoded: EncodedCrop }> {
  const cropped = cropFromDecoded({
    frame_w: params.frame_w,
    frame_h: params.frame_h,
    rgba: params.rgba,
    grayscale: params.grayscale,
    crop_box: params.crop_box,
    config: params.config
  });

  const encoded = await encodeCropToJpeg({ cropped, config: params.config });
  return { cropped, encoded };
}