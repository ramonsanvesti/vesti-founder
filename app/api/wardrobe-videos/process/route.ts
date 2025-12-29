// app/api/wardrobe-videos/process/route.ts
import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseClient.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

// Founder Edition: single-user scope
const FOUNDER_USER_ID =
  process.env.FOUNDER_USER_ID ?? "00000000-0000-0000-0000-000000000001";

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

type ProcessBody = {
  wardrobe_video_id?: string;
  video_id?: string;
  // optional params for future pipeline
  sample_every_seconds?: number;
  max_frames?: number;
  max_width?: number;
  max_candidates?: number;
};

async function handler(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as ProcessBody;
    const wardrobeVideoId = asString(body.wardrobe_video_id || body.video_id);

    if (!wardrobeVideoId) {
      return NextResponse.json(
        { ok: false, error: "Missing wardrobe_video_id" },
        { status: 400 }
      );
    }

    const supabase = getSupabaseServerClient();

    const { data: video, error: loadErr } = await supabase
      .from("wardrobe_videos")
      .select("id,user_id,status,created_at,last_processed_at")
      .eq("id", wardrobeVideoId)
      .eq("user_id", FOUNDER_USER_ID)
      .single();

    if (loadErr || !video) {
      return NextResponse.json(
        { ok: false, error: "Video not found", details: loadErr?.message ?? "missing row" },
        { status: 404 }
      );
    }

    // Mark as processing (idempotent)
    await supabase
      .from("wardrobe_videos")
      .update({ status: "processing" })
      .eq("id", wardrobeVideoId)
      .eq("user_id", FOUNDER_USER_ID);

    // TODO: aquí va tu pipeline real (sample frames, vision, crear garments, etc.)
    // Por ahora: cerramos el loop para que el sistema no se quede “stuck”.
    const processedAt = new Date().toISOString();

    const { data: updated, error: updErr } = await supabase
      .from("wardrobe_videos")
      .update({
        status: "processed",
        last_processed_at: processedAt,
      })
      .eq("id", wardrobeVideoId)
      .eq("user_id", FOUNDER_USER_ID)
      .select("id,user_id,status,created_at,last_processed_at")
      .single();

    if (updErr) {
      return NextResponse.json(
        { ok: false, error: "Failed to finalize processing", details: updErr.message },
        { status: 500 }
      );
    }

    return NextResponse.json(
      {
        ok: true,
        wardrobe_video_id: wardrobeVideoId,
        status: updated?.status ?? "processed",
        last_processed_at: updated?.last_processed_at ?? processedAt,
        video: updated ?? null,
      },
      { status: 200 }
    );
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: "Server error", details: err?.message ?? "unknown" },
      { status: 500 }
    );
  }
}

// En prod: protegido por firma de QStash.
// En dev/local: si no tienes keys, permite POST directo sin romper el endpoint.
const shouldVerify = Boolean(process.env.QSTASH_CURRENT_SIGNING_KEY);
export const POST = shouldVerify ? verifySignatureAppRouter(handler) : handler;