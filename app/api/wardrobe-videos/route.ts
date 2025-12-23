import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseClient.server";

// Founder Edition: hard-coded user until Auth is wired
const FOUNDER_USER_ID = "00000000-0000-0000-0000-000000000001";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function clampInt(v: unknown, fallback: number, min: number, max: number) {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const limit = clampInt(url.searchParams.get("limit"), 50, 1, 200);
    const status = asString(url.searchParams.get("status")); // optional filter

    const supabase = getSupabaseServerClient();

    // Return the user's wardrobe video history
    let q = supabase
      .from("wardrobe_videos")
      .select("id,user_id,video_url,status,created_at")
      .eq("user_id", FOUNDER_USER_ID)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (status) q = q.eq("status", status);

    const { data, error } = await q;

    if (error) {
      return NextResponse.json(
        { ok: false, error: "Failed to load wardrobe videos", details: error.message },
        { status: 500 }
      );
    }

    return NextResponse.json(
      { ok: true, videos: data ?? [], limit, status: status || null },
      {
        status: 200,
        headers: {
          // Always fetch fresh status (uploaded/processing/processed/failed)
          "Cache-Control": "no-store",
        },
      }
    );
  } catch (err: any) {
    console.error("Error in /api/wardrobe-videos:", err);
    return NextResponse.json(
      { ok: false, error: "Server error", details: err?.message ?? "unknown" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const video_id = typeof body?.video_id === "string" ? body.video_id.trim() : "";

    if (!video_id) {
      return NextResponse.json(
        { ok: false, error: "video_id required" },
        { status: 400 }
      );
    }

    const supabase = getSupabaseServerClient();

    const { data: videoData, error: fetchError } = await supabase
      .from("wardrobe_videos")
      .select("id, status")
      .eq("id", video_id)
      .eq("user_id", FOUNDER_USER_ID)
      .single();

    if (fetchError) {
      if (fetchError.code === "PGRST116" || fetchError.message.includes("No rows found")) {
        // No row found
        return NextResponse.json(
          { ok: false, error: "Video not found" },
          { status: 404 }
        );
      }
      return NextResponse.json(
        { ok: false, error: "Failed to fetch video", details: fetchError.message },
        { status: 500 }
      );
    }

    if (!videoData) {
      return NextResponse.json(
        { ok: false, error: "Video not found" },
        { status: 404 }
      );
    }

    if (videoData.status === "processing") {
      return NextResponse.json(
        { ok: true, status: "processing", already: true },
        { status: 200 }
      );
    }

    const { error: updateError } = await supabase
      .from("wardrobe_videos")
      .update({ status: "processing" })
      .eq("id", video_id)
      .eq("user_id", FOUNDER_USER_ID);

    if (updateError) {
      return NextResponse.json(
        { ok: false, error: "Failed to update video status", details: updateError.message },
        { status: 500 }
      );
    }

    return NextResponse.json(
      { ok: true, status: "processing" },
      { status: 200 }
    );
  } catch (err: any) {
    console.error("Error in POST /api/wardrobe-videos:", err);
    return NextResponse.json(
      { ok: false, error: "Server error", details: err?.message ?? "unknown" },
      { status: 500 }
    );
  }
}
