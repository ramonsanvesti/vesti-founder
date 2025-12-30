// app/api/wardrobe-videos/process/route.ts
import { NextRequest, NextResponse } from "next/server";
import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const FOUNDER_USER_ID =
  process.env.FOUNDER_USER_ID ?? "00000000-0000-0000-0000-000000000001";

function getSupabaseAdminClient() {
  const url =
    process.env.SUPABASE_URL ??
    process.env.NEXT_PUBLIC_SUPABASE_URL ??
    "";
  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_SERVICE_KEY ??
    "";

  if (!url || !serviceKey) {
    throw new Error(
      "Supabase admin env not configured. Set SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_KEY)."
    );
  }

  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: {
        "X-Client-Info": "vesti-founder:wardrobe-videos-process",
      },
    },
  });
}

type ProcessPayload = {
  wardrobe_video_id?: string;
  sample_every_seconds?: number;
  max_frames?: number;
  max_width?: number;
  max_candidates?: number;
};

function asString(v: unknown) {
  return typeof v === "string" ? v.trim() : "";
}

async function handler(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as ProcessPayload;

    const wardrobeVideoId = asString(body.wardrobe_video_id);
    if (!wardrobeVideoId) {
      return NextResponse.json(
        { ok: false, error: "Missing wardrobe_video_id" },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    const supabase = getSupabaseAdminClient();

    // TODO: replace with the real pipeline (extract frames, classify, insert garments, etc.)
    // For now we mark the video as processed so the end-to-end loop works.
    const nowIso = new Date().toISOString();

    const { data, error } = await supabase
      .from("wardrobe_videos")
      .update({
        status: "processed",
        last_processed_at: nowIso,
      })
      .eq("id", wardrobeVideoId)
      .eq("user_id", FOUNDER_USER_ID)
      .select(
        "id,user_id,video_url,status,created_at,last_process_message_id,last_process_retried,last_processed_at"
      )
      .single();

    if (error) {
      return NextResponse.json(
        { ok: false, error: "DB update failed", details: error.message },
        { status: 500, headers: { "Cache-Control": "no-store" } }
      );
    }

    return NextResponse.json(
      { ok: true, video: data },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: "Server error", details: err?.message ?? "unknown" },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}

// In local/dev, if you do NOT have signing keys, allow direct calls.
// In production, fail closed if keys are missing (so this endpoint can't be called publicly).
const hasSigningKeys = Boolean(
  asString(process.env.QSTASH_CURRENT_SIGNING_KEY) ||
    asString(process.env.QSTASH_NEXT_SIGNING_KEY)
);

export const POST = hasSigningKeys
  ? verifySignatureAppRouter(handler)
  : async (req: NextRequest) => {
      if (process.env.NODE_ENV === "production") {
        return NextResponse.json(
          {
            ok: false,
            error: "QStash signing keys not configured",
            details:
              "Set QSTASH_CURRENT_SIGNING_KEY and/or QSTASH_NEXT_SIGNING_KEY in the environment.",
          },
          { status: 500, headers: { "Cache-Control": "no-store" } }
        );
      }
      return handler(req);
    };