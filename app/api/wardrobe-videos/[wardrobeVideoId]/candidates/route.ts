// app/api/wardrobe-videos/[wardrobeVideoId]/candidates/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createCandidateSignedUrl } from "@/lib/candidates/storage/createCandidateSignedUrl";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  Allow: "GET,OPTIONS",
} as const;

// Founder Edition: single-user scope
const FOUNDER_USER_ID =
  process.env.FOUNDER_USER_ID ?? "00000000-0000-0000-0000-000000000001";

function getSupabaseAdminClient() {
  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL ??
    process.env.SUPABASE_URL ??
    "";

  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_SERVICE_KEY ??
    "";

  if (!url || !serviceKey) {
    throw new Error(
      "Missing Supabase env. Set NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY."
    );
  }

  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function clampInt(v: unknown, fallback: number, min: number, max: number) {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

type CandidateRow = {
  id: string;
  user_id: string;
  wardrobe_video_id: string;
  status: string;
  storage_bucket: string;
  storage_path: string;
  phash: string;
  sha256: string;
  crop_box: any;
  frame_ts_ms: number;
  width: number | null;
  height: number | null;
  mime_type: string | null;
  bytes: number | null;
  quality_score: number | null;
  confidence: number | null;
  reason_codes: string[] | null;
  embedding_model: string | null;
  rank: number | null;
  expires_at: string;
  created_at: string;
  updated_at: string | null;
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: RESPONSE_HEADERS });
}

export async function GET(
  req: NextRequest,
  ctx: { params: { wardrobeVideoId: string } }
) {
  try {
    const supabase = getSupabaseAdminClient();

    const wardrobeVideoId = asString(ctx?.params?.wardrobeVideoId);
    if (!wardrobeVideoId) {
      return NextResponse.json(
        { ok: false, error: "Missing wardrobeVideoId" },
        { status: 400, headers: RESPONSE_HEADERS }
      );
    }

    // Defaults: show only active candidates
    const url = new URL(req.url);
    const includeExpired = url.searchParams.get("include_expired") === "true";
    const includeDiscarded = url.searchParams.get("include_discarded") === "true";
    const signedUrlTtlSeconds = clampInt(
      url.searchParams.get("signed_url_ttl_seconds"),
      60 * 30,
      60,
      60 * 60
    );

    // Ensure the video belongs to this founder user (cheap ownership gate)
    const { data: video, error: videoErr } = await supabase
      .from("wardrobe_videos")
      .select("id,user_id")
      .eq("id", wardrobeVideoId)
      .eq("user_id", FOUNDER_USER_ID)
      .single();

    if (videoErr || !video) {
      return NextResponse.json(
        { ok: false, error: "Video not found" },
        { status: 404, headers: RESPONSE_HEADERS }
      );
    }

    // NOTE: We intentionally keep the Supabase query loosely typed here because
    // `supabase-js` generics vary depending on whether a generated `Database` type is used.
    // We cast the result rows to `CandidateRow[]` after the fetch.
    let query = supabase
      .from("wardrobe_video_candidates")
      .select(
        [
          "id",
          "user_id",
          "wardrobe_video_id",
          "status",
          "storage_bucket",
          "storage_path",
          "phash",
          "sha256",
          "crop_box",
          "frame_ts_ms",
          "width",
          "height",
          "mime_type",
          "bytes",
          "quality_score",
          "confidence",
          "reason_codes",
          "embedding_model",
          "rank",
          "expires_at",
          "created_at",
          "updated_at",
        ].join(",")
      )
      .eq("user_id", FOUNDER_USER_ID)
      .eq("wardrobe_video_id", wardrobeVideoId);

    if (!includeExpired) {
      query = query.gt("expires_at", new Date().toISOString());
      query = query.neq("status", "expired");
    }

    if (!includeDiscarded) {
      query = query.neq("status", "discarded");
    }

    // Deterministic ordering for UI
    const { data: dataRows, error } = await (query as any)
      .order("rank", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: true });

    if (error) {
      return NextResponse.json(
        { ok: false, error: "Failed to load candidates", details: error.message },
        { status: 500, headers: RESPONSE_HEADERS }
      );
    }

    const rows: CandidateRow[] = Array.isArray(dataRows)
      ? (dataRows as CandidateRow[])
      : [];

    const candidates = await Promise.all(
      rows.map(async (r) => {
        let signed_url: string | null = null;
        let signed_url_error: string | null = null;

        try {
          // Helper currently returns `{ signed_url: string | null, ... }` (no `ok` flag).
          // Cast the params + result defensively so this route does not break if helper types evolve.
          const signed = (await createCandidateSignedUrl(
            {
              storageBucket: r.storage_bucket,
              storagePath: r.storage_path,
              expiresInSeconds: signedUrlTtlSeconds,
            } as any
          )) as any;

          signed_url = typeof signed?.signed_url === "string" ? signed.signed_url : null;
          signed_url_error = signed_url ? null : (typeof signed?.error === "string" ? signed.error : null);
        } catch (e) {
          signed_url = null;
          signed_url_error = e instanceof Error ? e.message : String(e);
        }

        return {
          ...r,
          signed_url,
          signed_url_error,
        };
      })
    );

    return NextResponse.json(
      {
        ok: true,
        wardrobe_video_id: wardrobeVideoId,
        candidates,
      },
      { status: 200, headers: RESPONSE_HEADERS }
    );
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: "Server error", details: err?.message ?? "unknown" },
      { status: 500, headers: RESPONSE_HEADERS }
    );
  }
}