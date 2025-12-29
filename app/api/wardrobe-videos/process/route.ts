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

type Body = {
  wardrobe_video_id?: string;
  video_id?: string;
};

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

async function handler(req: NextRequest) {
  try {
    const supabase = getSupabaseServerClient();

    const body = (await req.json().catch(() => ({}))) as Body;
    const videoId = asString(body.wardrobe_video_id || body.video_id);

    if (!videoId) {
      return NextResponse.json(
        { ok: false, error: "Missing wardrobe_video_id" },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    // Load video record (user-scoped)
    const { data: video, error: loadErr } = await supabase
      .from("wardrobe_videos")
      .select(
        "id,user_id,status,video_url,created_at,last_process_message_id,last_process_retried,last_processed_at,playback_url,signed_url"
      )
      .eq("id", videoId)
      .eq("user_id", FOUNDER_USER_ID)
      .single();

    if (loadErr || !video) {
      return NextResponse.json(
        {
          ok: false,
          error: "Video not found",
          details: loadErr?.message ?? "missing row",
        },
        { status: 404, headers: { "Cache-Control": "no-store" } }
      );
    }

    // Idempotency: if already processed, return success.
    if (video.status === "processed") {
      return NextResponse.json(
        { ok: true, wardrobe_video_id: videoId, status: "processed", wardrobe_video: video },
        { status: 200, headers: { "Cache-Control": "no-store" } }
      );
    }

    // Ensure status is processing (do not rewind processed)
    await supabase
      .from("wardrobe_videos")
      .update({ status: "processing" })
      .eq("id", videoId)
      .eq("user_id", FOUNDER_USER_ID)
      .in("status", ["uploaded", "failed", "processing"]);

    // ----
    // IMPORTANT:
    // Your real video → frames → vision pipeline should live here.
    // If you already have a processor module, wire it here.
    // For now, we keep this endpoint stable + secure and mark the job as processed.
    // ----

    const nowIso = new Date().toISOString();

    const { error: doneErr } = await supabase
      .from("wardrobe_videos")
      .update({ status: "processed", last_processed_at: nowIso })
      .eq("id", videoId)
      .eq("user_id", FOUNDER_USER_ID);

    if (doneErr) {
      // If we can't mark processed, mark failed.
      await supabase
        .from("wardrobe_videos")
        .update({ status: "failed", last_processed_at: nowIso })
        .eq("id", videoId)
        .eq("user_id", FOUNDER_USER_ID);

      return NextResponse.json(
        { ok: false, error: "Failed to finalize processing", details: doneErr.message },
        { status: 500, headers: { "Cache-Control": "no-store" } }
      );
    }

    const { data: updatedVideo } = await supabase
      .from("wardrobe_videos")
      .select(
        "id,user_id,status,video_url,created_at,last_process_message_id,last_process_retried,last_processed_at,playback_url,signed_url"
      )
      .eq("id", videoId)
      .eq("user_id", FOUNDER_USER_ID)
      .single();

    return NextResponse.json(
      {
        ok: true,
        wardrobe_video_id: videoId,
        status: (updatedVideo?.status ?? "processed") as any,
        wardrobe_video: updatedVideo ?? null,
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

// Protect in production; allow manual testing in dev.
export const POST =
  process.env.NODE_ENV === "production" ? verifySignatureAppRouter(handler) : handler;