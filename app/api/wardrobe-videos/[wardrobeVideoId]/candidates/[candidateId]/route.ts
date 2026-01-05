

// app/api/wardrobe-videos/[wardrobeVideoId]/candidates/[candidateId]/route.ts

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

type CandidateStatus = "generated" | "selected" | "discarded" | "promoted" | "expired";

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

type PatchBody = {
  /** DRESZI convention: camelCase in API */
  userId?: string;
  /** Only allow lifecycle transitions the UI needs */
  status: "selected" | "discarded";
};

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

function jsonError(
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): NextResponse {
  return NextResponse.json(
    { ok: false, error: { code, message, ...extra } },
    { status },
  );
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

async function readJson<T>(req: Request): Promise<T | null> {
  const ct = req.headers.get("content-type") || "";
  if (!ct.toLowerCase().includes("application/json")) return null;
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

export async function PATCH(
  req: Request,
  ctx: { params: { wardrobeVideoId: string; candidateId: string } },
): Promise<NextResponse> {
  const { wardrobeVideoId, candidateId } = ctx.params;

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

  const requestedStatus = body.status;
  if (requestedStatus !== "selected" && requestedStatus !== "discarded") {
    return jsonError(400, "E_BAD_STATUS", "status must be 'selected' or 'discarded'");
  }

  // Beta auth model: accept userId from JSON or x-user-id header and enforce ownership via DB predicate.
  const userId = body.userId ?? req.headers.get("x-user-id") ?? undefined;
  if (!userId || !isUuid(userId)) {
    return jsonError(401, "E_MISSING_USER", "Missing or invalid userId");
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

  const now = Date.now();
  const expiresAtMs = Number.isFinite(Date.parse(row.expires_at))
    ? Date.parse(row.expires_at)
    : NaN;
  if (Number.isFinite(expiresAtMs) && expiresAtMs < now) {
    return jsonError(410, "E_CANDIDATE_EXPIRED", "Candidate has expired");
  }

  // 2) Idempotent update
  if (row.status === requestedStatus) {
    return NextResponse.json({ ok: true, candidate: row }, { status: 200 });
  }

  // Only allow transitions from generated -> selected/discarded.
  // If already promoted/expired, do not allow changes.
  if (row.status === "promoted" || row.status === "expired") {
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

  return NextResponse.json({ ok: true, candidate: updated ?? row }, { status: 200 });
}