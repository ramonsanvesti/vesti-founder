import { NextResponse } from "next/server";
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

function asInt(v: unknown, fallback: number, min: number, max: number) {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function isUuid(v: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

async function handler(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as ProcessPayload;

    const wardrobeVideoId = asString(body.wardrobe_video_id);
    if (!wardrobeVideoId) {
      return NextResponse.json(
        { ok: false, error: "Missing wardrobe_video_id" },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }
    if (!isUuid(wardrobeVideoId)) {
      return NextResponse.json(
        { ok: false, error: "Invalid wardrobe_video_id" },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    const qstashMessageId = req.headers.get("Upstash-Message-Id") ?? null;
    const qstashRetriedRaw = req.headers.get("Upstash-Retried");
    const qstashRetried = qstashRetriedRaw != null && qstashRetriedRaw !== ""
      ? Number.parseInt(qstashRetriedRaw, 10)
      : null;
    const qstashRetriedSafe = Number.isFinite(qstashRetried as any) ? qstashRetried : null;

    const supabase = getSupabaseAdminClient();

    // Pre-read for idempotency & clearer errors.
    const { data: existing, error: readErr } = await supabase
      .from("wardrobe_videos")
      .select(
        "id,user_id,status,video_url,created_at,last_process_message_id,last_process_retried,last_processed_at"
      )
      .eq("id", wardrobeVideoId)
      .eq("user_id", FOUNDER_USER_ID)
      .maybeSingle();

    if (readErr) {
      return NextResponse.json(
        { ok: false, error: "DB read failed", details: readErr.message },
        { status: 500, headers: { "Cache-Control": "no-store" } }
      );
    }

    if (!existing) {
      // Non-retriable: the row doesn't exist (or belongs to a different user).
      // Return 200 to prevent QStash from retrying a permanent failure.
      return NextResponse.json(
        { ok: false, error: "Wardrobe video not found", wardrobe_video_id: wardrobeVideoId },
        { status: 200, headers: { "Cache-Control": "no-store" } }
      );
    }

    // If this message already completed processing, acknowledge idempotently.
    if (
      String((existing as any).status) === "processed" &&
      ((existing as any).last_process_message_id == null || (existing as any).last_process_message_id === qstashMessageId)
    ) {
      return NextResponse.json(
        { ok: true, video: existing, idempotent: true },
        { status: 200, headers: { "Cache-Control": "no-store" } }
      );
    }

    // Normalize processing params (reserved for the real pipeline).
    const sampleEverySeconds = asInt(body.sample_every_seconds, 3, 1, 60);
    const maxFrames = asInt(body.max_frames, 20, 1, 300);
    const maxWidth = asInt(body.max_width, 900, 200, 4000);
    const maxCandidates = asInt(body.max_candidates, 12, 1, 50);

    // Mark as processing at job start (safe for retries).
    await supabase
      .from("wardrobe_videos")
      .update({
        status: "processing",
        last_process_message_id: qstashMessageId,
        last_process_retried: qstashRetriedSafe,
      })
      .eq("id", wardrobeVideoId)
      .eq("user_id", FOUNDER_USER_ID)
      .in("status", ["uploaded", "processing"]);

    // TODO (Pipeline):
    // - Download video from Supabase Storage (existing.video_url)
    // - Extract frames using sampleEverySeconds/maxFrames/maxWidth
    // - Run Vision classification
    // - Persist garments + scores
    // - Update wardrobe_videos with results
    // For now we just mark the video as processed so the end-to-end loop works.
    void sampleEverySeconds;
    void maxFrames;
    void maxWidth;
    void maxCandidates;

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
      {
        ok: true,
        video: data,
        message_id: qstashMessageId,
        retried: qstashRetriedSafe,
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

// In local/dev, if you do NOT have signing keys, allow direct calls.
// In production, fail closed if keys are missing (so this endpoint can't be called publicly).
const hasSigningKeys = Boolean(
  asString(process.env.QSTASH_CURRENT_SIGNING_KEY) ||
    asString(process.env.QSTASH_NEXT_SIGNING_KEY)
);

export const POST = hasSigningKeys
  ? verifySignatureAppRouter(handler)
  : async (req: Request) => {
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