// app/api/wardrobe-videos/process/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseClient.server";

export const runtime = "nodejs";

type ProcessBody = {
  video_id?: unknown;
};

type VideoRow = {
  id: string;
  user_id: string;
  video_url: string | null;
  status: "uploaded" | "processing" | "processed" | "failed";
  created_at?: string;
};

function isString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Best-effort async trigger.
 * In serverless this may not always complete; the status flip is the "source of truth".
 * Later you can swap this with a queue/worker (Supabase Edge Function, background job, etc.).
 */
async function triggerPipeline(args: {
  supabase: ReturnType<typeof getSupabaseServerClient>;
  video: VideoRow;
}) {
  const { supabase, video } = args;

  try {
    // Guardrails
    if (!video.video_url) {
      await supabase
        .from("wardrobe_videos")
        .update({ status: "failed" })
        .eq("id", video.id)
        .eq("user_id", video.user_id);
      return;
    }

    // Download the video to /tmp so we can run ffmpeg locally.
    // NOTE: Next/Vercel Serverless supports /tmp for ephemeral storage.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const crypto = await import("node:crypto");

    const runId = crypto.randomUUID();
    const tmpDir = path.join("/tmp", `vesti-video-${runId}`);
    await fs.mkdir(tmpDir, { recursive: true });

    const inputPath = path.join(tmpDir, "input.mp4");

    // Fetch the remote URL (Supabase public/signed URL)
    const res = await fetch(video.video_url);
    if (!res.ok) {
      throw new Error(`Failed to download video: ${res.status}`);
    }

    const ab = await res.arrayBuffer();
    await fs.writeFile(inputPath, Buffer.from(ab));

    // TODO (next step): extract frames, detect candidates, create candidate rows.
    // For now, we only verify we can download the video.

    await supabase
      .from("wardrobe_videos")
      .update({ status: "processed" })
      .eq("id", video.id)
      .eq("user_id", video.user_id);
  } catch (err: any) {
    console.error("Wardrobe video pipeline failed:", err?.message ?? err);

    // Mark as failed (retry-safe)
    await supabase
      .from("wardrobe_videos")
      .update({ status: "failed" })
      .eq("id", video.id)
      .eq("user_id", video.user_id);
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as ProcessBody;

    const videoId = isString(body.video_id) ? body.video_id.trim() : "";
    if (!videoId) {
      return NextResponse.json(
        { ok: false, error: "Missing video_id" },
        { status: 400 }
      );
    }

    const supabase = getSupabaseServerClient();

    // Founder Edition fake user_id (replace with auth later)
    const fakeUserId = "00000000-0000-0000-0000-000000000001";

    // 1) Load the record and verify ownership
    const { data: video, error: loadErr } = await supabase
      .from("wardrobe_videos")
      .select("id,user_id,video_url,status,created_at")
      .eq("id", videoId)
      .single();

    if (loadErr || !video) {
      return NextResponse.json(
        { ok: false, error: "Video not found", details: loadErr?.message ?? "unknown" },
        { status: 404 }
      );
    }

    if (video.user_id !== fakeUserId) {
      return NextResponse.json(
        { ok: false, error: "Forbidden" },
        { status: 403 }
      );
    }

    // 2) Retry-safe status transition
    // Only allow: uploaded|failed -> processing
    if (video.status === "processing") {
      return NextResponse.json(
        { ok: true, already_processing: true, video },
        { status: 200 }
      );
    }

    if (video.status === "processed") {
      return NextResponse.json(
        { ok: true, already_processed: true, video },
        { status: 200 }
      );
    }

    if (video.status !== "uploaded" && video.status !== "failed") {
      return NextResponse.json(
        { ok: false, error: `Invalid status transition from "${video.status}"` },
        { status: 400 }
      );
    }

    const { data: updated, error: updErr } = await supabase
      .from("wardrobe_videos")
      .update({ status: "processing" })
      .eq("id", videoId)
      .eq("user_id", fakeUserId)
      .in("status", ["uploaded", "failed"])
      .select("id,user_id,video_url,status,created_at")
      .single();

    if (updErr || !updated) {
      return NextResponse.json(
        { ok: false, error: "Failed to update status", details: updErr?.message ?? "unknown" },
        { status: 500 }
      );
    }

    // 3) Fire-and-forget pipeline trigger (non-blocking)
    void triggerPipeline({ supabase, video: updated as VideoRow });

    return NextResponse.json(
      { ok: true, video: updated },
      { status: 200 }
    );
  } catch (err: any) {
    console.error("Error in /api/wardrobe-videos/process:", err);
    return NextResponse.json(
      { ok: false, error: "Server error", details: err?.message ?? "unknown" },
      { status: 500 }
    );
  }
}