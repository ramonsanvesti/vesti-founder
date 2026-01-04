

/*
  DRESZI — sha256 hashing utility

  Requirements
  - Deterministic across retries
  - Works in Node.js runtime on Vercel serverless
  - Accepts Uint8Array/Buffer and returns lowercase hex
*/

import { createHash } from "crypto";

export interface Sha256Result {
  /** Lowercase hex digest (length 64) */
  readonly hex: string;
}

/**
 * Compute sha256 digest for bytes.
 */
export function sha256Hex(bytes: Uint8Array): string {
  const h = createHash("sha256");
  h.update(bytes);
  return h.digest("hex");
}

/**
 * Compute sha256 digest for a UTF-8 string.
 */
export function sha256HexFromString(input: string): string {
  const h = createHash("sha256");
  h.update(input, "utf8");
  return h.digest("hex");
}

/**
 * Convenience wrapper returning a typed result.
 */
export function sha256(bytes: Uint8Array): Sha256Result {
  return { hex: sha256Hex(bytes) };
}