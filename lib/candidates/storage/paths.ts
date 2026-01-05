

// DRESZI — Candidate Storage Path Spec
// Bucket is private; objects are accessed via signed URLs server-side.

export const CANDIDATES_BUCKET = "wardrobe-candidates" as const;

export type CandidateObjectPathParams = {
  userId: string;
  wardrobeVideoId: string;
  candidateId: string;
};

function assertSafeSegment(value: string, label: string): string {
  const v = (value ?? "").trim();
  if (!v) throw new Error(`Missing ${label}`);

  // Prevent path traversal / accidental nesting.
  if (v.includes("/") || v.includes("\\") || v.includes("..")) {
    throw new Error(`Invalid ${label} segment`);
  }

  return v;
}

/**
 * Canonical object path for a candidate image.
 * Spec: userId/wardrobeVideoId/candidates/<candidateId>.webp
 */
export function candidateObjectPath(params: CandidateObjectPathParams): string {
  const userId = assertSafeSegment(params.userId, "userId");
  const wardrobeVideoId = assertSafeSegment(params.wardrobeVideoId, "wardrobeVideoId");
  const candidateId = assertSafeSegment(params.candidateId, "candidateId");

  return `${userId}/${wardrobeVideoId}/candidates/${candidateId}.webp`;
}

/** Prefix for listing all candidates for a given user + video. */
export function candidatePrefix(params: Omit<CandidateObjectPathParams, "candidateId">): string {
  const userId = assertSafeSegment(params.userId, "userId");
  const wardrobeVideoId = assertSafeSegment(params.wardrobeVideoId, "wardrobeVideoId");
  return `${userId}/${wardrobeVideoId}/candidates/`;
}