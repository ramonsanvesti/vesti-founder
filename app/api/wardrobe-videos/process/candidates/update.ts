// Dev fixture: request body for updating a candidate.
// NOTE: This file lives in the repo and may be opened as TypeScript by VS Code.
// Exporting a constant avoids the parser treating `{ ... }` as a block statement.

// Dev fixture: request body for updating a candidate.
export const candidateUpdatePayload = {
  wardrobeVideoId: "...",
  candidateId: "...",
  action: "select", // or "discard"
} as const;