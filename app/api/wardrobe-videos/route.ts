// app/api/wardrobe-videos/process/route.ts
import { NextRequest, NextResponse } from "next/server";
import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";
import { getSupabaseServerClient } from "@/lib/supabaseClient.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

// Founder Edition: single-user scope
const FOUNDER_USER_ID =
  process.env.FOUNDER_USER_ID ?? "00000000-0000-0000-0000-000000000001";

type ProcessBody = {
  wardrobe_video_id?: string;
  video_id?: string;
  sample_every_seconds?: number;
  max_frames?: number;
  max_width?: number;
  max_candidates?: number;
};

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function clampInt(v: unknown, fallback: number, min: number, max: number) {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

async function handler(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as ProcessBody;
    const wardrobeVideoId = asString(body.wardrobe_video_id || body.video_id);

    if (!wardrobeVideoId) {
      return NextResponse.json(
        { ok: false, error: "Missing wardrobe_video_id" },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    // Params accepted for traceability / future processing
    const sampleEverySeconds = clampInt(body.sample_every_seconds, 3, 1, 10);
    const maxFrames = clampInt(body.max_frames, 20, 1, 240);
    const maxWidth = clampInt(body.max_width, 900, 240, 2048);
    const maxCandidates = clampInt(body.max_candidates, 12, 1, 50);

    const supabase = getSupabaseServerClient();

    // Load row
    const { data: row, error: loadErr } = await supabase
      .from("wardrobe_videos")
      .select(
        "id,user_id,status,video_url,created_at,last_process_message_id,last_process_retried,last_processed_at"
      )
      .eq("id", wardrobeVideoId)
      .eq("user_id", FOUNDER_USER_ID)
      .single();

    if (loadErr || !row) {
      return NextResponse.json(
        {
          ok: false,
          error: "Video not found",
          details: loadErr?.message ?? "missing row",
        },
        { status: 404, headers: { "Cache-Control": "no-store" } }
      );
    }

    // Mark processing (idempotent)
    if (String(row.status) !== "processing") {
      await supabase
        .from("wardrobe_videos")
        .update({ status: "processing" })
        .eq("id", row.id)
        .eq("user_id", FOUNDER_USER_ID);
    }

    // TODO: Replace this stub with real ingestion (frame sampling + garment writes).
    // For now, finalize to processed so UI won't poll forever while you wire the pipeline.
    const processedAt = new Date().toISOString();

    const { data: updated, error: updErr } = await supabase
      .from("wardrobe_videos")
      .update({
        status: "processed",
        last_processed_at: processedAt,
      })
      .eq("id", row.id)
      .eq("user_id", FOUNDER_USER_ID)
      .select(
        "id,user_id,status,video_url,created_at,last_process_message_id,last_process_retried,last_processed_at"
      )
      .single();

    if (updErr) {
      return NextResponse.json(
        { ok: false, error: "Failed to update status", details: updErr.message },
        { status: 500, headers: { "Cache-Control": "no-store" } }
      );
    }

    return NextResponse.json(
      {
        ok: true,
        wardrobe_video_id: row.id,
        status: updated?.status ?? "processed",
        params: {
          sample_every_seconds: sampleEverySeconds,
          max_frames: maxFrames,
          max_width: maxWidth,
          max_candidates: maxCandidates,
        },
        wardrobe_video: updated,
        // Back-compat
        video: updated,
      },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: "Server error", details: err?.message ?? "unknown" },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}

// Protect so only QStash can call it in production.
// In dev/local, allow manual POST for testing.
export const POST =
  process.env.NODE_ENV === "production"
    ? verifySignatureAppRouter(handler)
    : handler;