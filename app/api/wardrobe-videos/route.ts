import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseClient.server";

// Founder Edition: hard-coded user until Auth is wired
const FOUNDER_USER_ID = "00000000-0000-0000-0000-000000000001";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    const supabase = getSupabaseServerClient();

    // Return the user's wardrobe video history
    const { data, error } = await supabase
      .from("wardrobe_videos")
      .select("id,user_id,video_url,status,created_at")
      .eq("user_id", FOUNDER_USER_ID)
      .order("created_at", { ascending: false });

    if (error) {
      return NextResponse.json(
        { ok: false, error: "Failed to load wardrobe videos", details: error.message },
        { status: 500 }
      );
    }

    return NextResponse.json(
      { ok: true, videos: data ?? [] },
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
