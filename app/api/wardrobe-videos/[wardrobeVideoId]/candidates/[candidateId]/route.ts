// app/api/wardrobe-videos/[wardrobeVideoId]/candidates/[candidateId]/route.ts

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

// Bump this when you want to confirm a deployment is serving the latest code.
const ROUTE_VERSION = "wvc-candidate-patch@2026-01-14";

function withRouteHeaders(init?: ResponseInit): ResponseInit {
  const headers = new Headers((init as any)?.headers ?? undefined);
  headers.set("x-dreszi-route", ROUTE_VERSION);
  // Helpful when running on Vercel.
  const sha = process.env.VERCEL_GIT_COMMIT_SHA;
  const deploymentId = process.env.VERCEL_DEPLOYMENT_ID;
  if (sha) headers.set("x-vercel-git-commit-sha", sha);
  if (deploymentId) headers.set("x-vercel-deployment-id", deploymentId);
  return { ...(init ?? {}), headers };
}

type CandidateStatus =
  | "pending"
  | "generated"
  | "ready"
  | "selected"
  | "discarded"
  | "promoted"
  | "expired"
  | "failed";

type CandidateRow = {
  id: string;
  user_id: string;
  wardrobe_video_id: string;
  status: CandidateStatus;
  storage_bucket: string;
  storage_path: string;
  frame_ts_ms: number;
  crop_box: unknown;
  confidence: number;
  reason_codes: string[];
  phash: string;
  sha256: string;
  bytes: number | null;
  width: number;
  height: number;
  mime_type: string;
  rank: number;
  expires_at: string;
  created_at: string;
  updated_at: string;
  source_frame_index: number | null;
  source_frame_ts_ms: number | null;
  embedding_model: string | null;
  quality_score: number | null;
};

type CandidateDto = {
  id: string;
  userId: string;
  wardrobeVideoId: string;
  status: CandidateStatus;
  storageBucket: string;
  storagePath: string;
  frameTsMs: number;
  cropBox: unknown;
  confidence: number;
  reasonCodes: string[];
  phash: string;
  sha256: string;
  bytes: number | null;
  width: number;
  height: number;
  mimeType: string;
  rank: number;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  sourceFrameIndex: number | null;
  sourceFrameTsMs: number | null;
  embeddingModel: string | null;
  qualityScore: number | null;
};

type PatchBody = {
  /** DRESZI convention: camelCase in API */
  userId?: string;
  /** Preferred: explicit status */
  status?: "selected" | "discarded";
  /** Optional legacy/UX-friendly action */
  action?: "select" | "discard";
};

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

/**
 * Accepts any UUID-shaped value (32 hex chars + hyphens).
 * We intentionally do NOT enforce RFC4122 version/variant bits because some internal/test ids
 * (e.g. 00000000-0000-0000-0000-000000000001) are not v1-v5.
 */
function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

function jsonError(
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): NextResponse {
  return NextResponse.json(
    { ok: false, error: { code, message, ...extra } },
    withRouteHeaders({ status }),
  );
}

function mapCandidateRowToDto(row: CandidateRow): CandidateDto {
  return {
    id: row.id,
    userId: row.user_id,
    wardrobeVideoId: row.wardrobe_video_id,
    status: row.status,
    storageBucket: row.storage_bucket,
    storagePath: row.storage_path,
    frameTsMs: row.frame_ts_ms,
    cropBox: row.crop_box,
    confidence: row.confidence,
    reasonCodes: row.reason_codes,
    phash: row.phash,
    sha256: row.sha256,
    bytes: row.bytes,
    width: row.width,
    height: row.height,
    mimeType: row.mime_type,
    rank: row.rank,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sourceFrameIndex: row.source_frame_index,
    sourceFrameTsMs: row.source_frame_ts_ms,
    embeddingModel: row.embedding_model,
    qualityScore: row.quality_score,
  };
}

function getSupabaseAdminClient(): SupabaseClient {
  const url = env("NEXT_PUBLIC_SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, {
    auth: { persistSession: false },
    global: {
      headers: {
        "X-Client-Info": "dreszi-founder:wardrobe-candidate-status",
      },
    },
  });
}

async function readJson<T>(req: Request | NextRequest): Promise<T | null> {
  const ct = req.headers.get("content-type") || "";
  if (!ct.toLowerCase().includes("application/json")) return null;
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

async function resolveParams(ctx: unknown): Promise<{ wardrobeVideoId: string; candidateId: string }> {
  const raw = (ctx as { params?: unknown } | null | undefined)?.params;
  const params = await Promise.resolve(raw as any);

  const wardrobeVideoId = typeof (params as any)?.wardrobeVideoId === "string" ? (params as any).wardrobeVideoId.trim() : "";
  const candidateId = typeof (params as any)?.candidateId === "string" ? (params as any).candidateId.trim() : "";

  return { wardrobeVideoId, candidateId };
}

export async function PATCH(
  req: NextRequest,
  ctx: {
    params:
      | Promise<{ wardrobeVideoId: string; candidateId: string }>
      | { wardrobeVideoId: string; candidateId: string };
  },
): Promise<NextResponse> {
  const { wardrobeVideoId, candidateId } = await resolveParams(ctx);

  if (!wardrobeVideoId || !candidateId) {
    return jsonError(400, "E_MISSING_PARAMS", "Missing wardrobeVideoId or candidateId");
  }

  if (!isUuid(wardrobeVideoId)) {
    return jsonError(400, "E_BAD_WARDROBE_VIDEO_ID", "Invalid wardrobeVideoId");
  }
  if (!isUuid(candidateId)) {
    return jsonError(400, "E_BAD_CANDIDATE_ID", "Invalid candidateId");
  }

  const body = await readJson<PatchBody>(req);
  if (!body) {
    return jsonError(415, "E_UNSUPPORTED_CONTENT_TYPE", "Expected application/json");
  }

  const requestedStatus =
    body.status === "selected" || body.status === "discarded"
      ? body.status
      : (body as any)?.action === "select"
          ? "selected"
          : (body as any)?.action === "discard"
              ? "discarded"
              : null;

  if (!requestedStatus) {
    return jsonError(400, "E_BAD_STATUS", "status must be 'selected' or 'discarded' (or action: 'select'|'discard')");
  }

  // Beta auth model: accept userId from JSON or x-user-id header and enforce ownership via DB predicate.
  const userIdRaw = body.userId ?? req.headers.get("x-user-id") ?? undefined;
  const userId = typeof userIdRaw === "string" ? userIdRaw.trim() : undefined;
  if (!userId || !isUuid(userId)) {
    return jsonError(401, "E_MISSING_USER", "Missing or invalid userId", {
      hint: "Provide userId in JSON body (camelCase) or x-user-id header as a UUID-shaped string",
    });
  }

  const supabase = getSupabaseAdminClient();

  // 1) Read row to validate (exists, belongs to user/video, not expired)
  const { data: row, error: readErr } = await supabase
    .from("wardrobe_video_candidates")
    .select(
      "id,user_id,wardrobe_video_id,status,expires_at,updated_at,storage_bucket,storage_path,frame_ts_ms,crop_box,confidence,reason_codes,phash,sha256,bytes,width,height,mime_type,rank,created_at,source_frame_index,source_frame_ts_ms,embedding_model,quality_score",
    )
    .eq("id", candidateId)
    .eq("wardrobe_video_id", wardrobeVideoId)
    .eq("user_id", userId)
    .maybeSingle<CandidateRow>();

  if (readErr) {
    return jsonError(500, "E_DB_READ_FAILED", "Failed to read candidate", {
      details: readErr.message,
    });
  }
  if (!row) {
    return jsonError(404, "E_NOT_FOUND", "Candidate not found");
  }

  const nowMs = Date.now();
  const expiresAtMs = Date.parse(row.expires_at);
  if (Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs) {
    return jsonError(410, "E_CANDIDATE_EXPIRED", "Candidate has expired");
  }

  // 2) Idempotent update
  if (row.status === requestedStatus) {
    return NextResponse.json(
      { ok: true, candidate: mapCandidateRowToDto(row) },
      withRouteHeaders({ status: 200 }),
    );
  }

  // Allow UI lifecycle changes among pending/generated/ready/selected/discarded.
  // If already promoted/expired/failed, do not allow changes.
  if (row.status === "promoted" || row.status === "expired" || row.status === "failed") {
    return jsonError(
      409,
      "E_INVALID_TRANSITION",
      `Cannot change status from '${row.status}' to '${requestedStatus}'`,
    );
  }

  const { data: updated, error: updErr } = await supabase
    .from("wardrobe_video_candidates")
    .update({
      status: requestedStatus,
      updated_at: new Date().toISOString(),
    })
    .eq("id", candidateId)
    .eq("wardrobe_video_id", wardrobeVideoId)
    .eq("user_id", userId)
    .select(
      "id,user_id,wardrobe_video_id,status,expires_at,updated_at,storage_bucket,storage_path,frame_ts_ms,crop_box,confidence,reason_codes,phash,sha256,bytes,width,height,mime_type,rank,created_at,source_frame_index,source_frame_ts_ms,embedding_model,quality_score",
    )
    .maybeSingle<CandidateRow>();

  if (updErr) {
    return jsonError(500, "E_DB_UPDATE_FAILED", "Failed to update candidate", {
      details: updErr.message,
    });
  }

  const finalRow = (updated ?? row) as CandidateRow;
  return NextResponse.json(
    { ok: true, candidate: mapCandidateRowToDto(finalRow) },
    withRouteHeaders({ status: 200 }),
  );
}