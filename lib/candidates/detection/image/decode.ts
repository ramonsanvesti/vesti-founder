

/*
  DRESZI — Image decode + preprocessing (serverless-safe)

  Why `sharp`?
  - Fast, memory-efficient native pipeline for decode + resize.
  - Common in Next.js/Vercel environments and more predictable than pure-JS decoders for large JPEGs.

  Design
  - Deterministic: fixed resize strategy, fixed grayscale conversion.
  - Bounded: resize to maxWidthUsed (without enlargement).
  - Side-effect free: does not touch disk; operates on in-memory bytes.
*/

export interface DecodedImage {
  readonly width: number;
  readonly height: number;
  /** RGBA pixels, length = width * height * 4 */
  readonly rgba: Uint8Array;
  /** Grayscale pixels, length = width * height */
  readonly grayscale: Uint8Array;
}

export interface DecodeOptions {
  /** Max width used for decoding/scoring/cropping. Maintains aspect ratio. */
  readonly maxWidthUsed: number;
}

export class DecodeError extends Error {
  readonly name = "DecodeError";
  constructor(message: string, readonly cause?: unknown) {
    super(message);
  }
}

function loadSharpOrThrow(): any {
  // Avoid static import so TS doesn't require sharp typings at compile time.
  // If sharp isn't installed, we fail loudly with a clear action.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("sharp");
    return mod?.default ?? mod;
  } catch (e) {
    throw new DecodeError(
      "sharp is required for DRESZI image decode. Install 'sharp' or provide a FrameLoader that returns pre-decoded pixels.",
      e
    );
  }
}

function assertMaxWidth(maxWidthUsed: number): void {
  if (!Number.isFinite(maxWidthUsed) || maxWidthUsed < 64) {
    throw new DecodeError(`Invalid maxWidthUsed (got ${maxWidthUsed}). Must be >= 64.`);
  }
}

/**
 * Convert RGBA -> grayscale deterministically.
 * Uses integer approximation of Rec. 709:
 *   Y ≈ 0.2126R + 0.7152G + 0.0722B
 * Implemented as:
 *   Y = (54R + 183G + 19B) >> 8
 */
export function rgbaToGrayscale(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const expected = Math.trunc(width) * Math.trunc(height) * 4;
  if (rgba.length < expected) {
    throw new DecodeError(`RGBA length ${rgba.length} < expected ${expected}`);
  }

  const n = Math.trunc(width) * Math.trunc(height);
  const out = new Uint8Array(n);

  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = rgba[p + 0];
    const g = rgba[p + 1];
    const b = rgba[p + 2];
    // alpha ignored
    out[i] = (54 * r + 183 * g + 19 * b) >> 8;
  }

  return out;
}

/**
 * Decode bytes into RGBA pixels and resize to maxWidthUsed (without enlargement).
 * Auto-rotates using EXIF orientation.
 */
export async function decodeToRgba(bytes: Uint8Array, opts: DecodeOptions): Promise<{ width: number; height: number; rgba: Uint8Array }> {
  assertMaxWidth(opts.maxWidthUsed);
  const sharp = loadSharpOrThrow();

  try {
    const pipeline = sharp(Buffer.from(bytes), { failOnError: false })
      .rotate() // respect EXIF
      .resize({
        width: Math.trunc(opts.maxWidthUsed),
        withoutEnlargement: true,
        fit: "inside"
      })
      .ensureAlpha()
      .raw();

    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });

    if (!info?.width || !info?.height || !info?.channels) {
      throw new DecodeError("sharp decode returned missing info");
    }

    const channels = info.channels;
    if (channels !== 4) {
      // ensureAlpha() should make it 4, but guard anyway.
      throw new DecodeError(`Unexpected channel count from sharp: ${channels}`);
    }

    const rgba = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

    return {
      width: info.width,
      height: info.height,
      rgba
    };
  } catch (e) {
    throw new DecodeError("Failed to decode image bytes via sharp", e);
  }
}

/**
 * Decode bytes to RGBA + grayscale.
 */
export async function decodeImage(bytes: Uint8Array, opts: DecodeOptions): Promise<DecodedImage> {
  const { width, height, rgba } = await decodeToRgba(bytes, opts);
  const grayscale = rgbaToGrayscale(rgba, width, height);
  return { width, height, rgba, grayscale };
}