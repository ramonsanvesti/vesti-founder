// app/api/wardrobe-videos/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const FOUNDER_USER_ID =
  process.env.FOUNDER_USER_ID ?? "00000000-0000-0000-0000-000000000001";

const VIDEO_BUCKET = process.env.WARDROBE_VIDEOS_BUCKET ?? "wardrobe-videos";

const BASE_HEADERS = {
  "Cache-Control": "no-store",
  "X-VESTI-Route": "api/wardrobe-videos",
};

function json(data: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers ?? {});
  for (const [k, v] of Object.entries(BASE_HEADERS)) headers.set(k, v);
  return NextResponse.json(data as any, { ...init, headers });
}

function asString(v: unknown) {
  return typeof v === "string" ? v.trim() : "";
}

function getSupabaseAdminClient() {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY ?? "";

  if (!url || !serviceKey) {
    throw new Error(
      "Supabase admin env not configured. Set SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_KEY)."
    );
  }

  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: {
        "X-Client-Info": "vesti-founder:wardrobe-videos",
      },
    },
  });
}

function extFromName(name: string) {
  const safe = name.split("?")[0];
  const parts = safe.split(".");
  const ext = parts.length > 1 ? parts[parts.length - 1].toLowerCase() : "";
  return ext && ext.length <= 8 ? ext : "mp4";
}

function randHex(len = 12) {
  const chars = "abcdef0123456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// GET /api/wardrobe-videos  -> history
export async function GET() {
  try {
    const supabase = getSupabaseAdminClient();

    const { data, error } = await supabase
      .from("wardrobe_videos")
      .select(
        "id,user_id,status,video_url,created_at,last_process_message_id,last_process_retried,last_processed_at"
      )
      .eq("user_id", FOUNDER_USER_ID)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) {
      return json(
        { ok: false, error: "Failed to load video history", details: error.message },
        { status: 500 }
      );
    }

    const rows = Array.isArray(data) ? data : [];

    // Attach signed urls for playback
    const videos = await Promise.all(
      rows.map(async (row) => {
        const path = asString((row as any).video_url);
        if (!path) return { ...row, signed_url: null };

        const { data: signed, error: signedErr } = await supabase.storage
          .from(VIDEO_BUCKET)
          .createSignedUrl(path, 60 * 60); // 1 hour

        return {
          ...row,
          signed_url: signedErr ? null : signed?.signedUrl ?? null,
        };
      })
    );

    return json({ ok: true, videos }, { status: 200 });
  } catch (err: any) {
    return json(
      { ok: false, error: "Unexpected error", details: err?.message ?? "unknown" },
      { status: 500 }
    );
  }
}

// Some environments probe HEAD.
export async function HEAD() {
  return new NextResponse(null, { status: 200, headers: BASE_HEADERS });
}

// POST /api/wardrobe-videos
// - multipart/form-data: upload a video file under field name "video"
// - application/json: { action:"process", wardrobe_video_id:"..." } -> returns a 400 with guidance (enqueue happens elsewhere)
export async function POST(req: NextRequest) {
  try {
    const contentType = asString(req.headers.get("content-type"));

    // JSON actions (kept for backward compatibility with the client)
    if (contentType.includes("application/json")) {
      const body = await req.json().catch(() => ({} as any));
      const action = asString((body as any)?.action);
      const wardrobe_video_id = asString((body as any)?.wardrobe_video_id);

      if (action === "process") {
        // This endpoint is intentionally NOT enqueuing here. The queue/publish lives in the caller flow.
        return json(
          {
            ok: false,
            error: "Processing enqueue is not handled by this route",
            details:
              "Call /api/wardrobe-videos (POST multipart) to upload, then trigger /api/wardrobe-videos/process via QStash publisher.",
            wardrobe_video_id: wardrobe_video_id || null,
          },
          { status: 400 }
        );
      }

      return json(
        { ok: false, error: "Unsupported JSON action", details: action || "(missing)" },
        { status: 400 }
      );
    }

    // multipart upload
    if (!contentType.includes("multipart/form-data")) {
      return json(
        {
          ok: false,
          error: "Unsupported Content-Type",
          details: "Send multipart/form-data with field 'video'",
        },
        { status: 415 }
      );
    }

    // Guard: Vercel/serverless body limits can fail uploads. Fail fast with a clear message.
    // content-length may be missing in some cases; we still validate by File.size.
    const cl = Number(req.headers.get("content-length") ?? 0);
    if (Number.isFinite(cl) && cl > 4_400_000) {
      return json(
        {
          ok: false,
          error: "Upload too large for this endpoint",
          details:
            "Use direct-to-storage (signed upload) for larger videos. This API is intended for short clips.",
          max_bytes_hint: 4_400_000,
        },
        { status: 413 }
      );
    }

    const form = await req.formData();
    const file = form.get("video");

    if (!(file instanceof File)) {
      return json(
        { ok: false, error: "Missing video file", details: "Field name must be 'video'" },
        { status: 400 }
      );
    }

    // Secondary guard based on File.size
    if (file.size > 4_400_000) {
      return json(
        {
          ok: false,
          error: "Upload too large for this endpoint",
          details:
            "Use direct-to-storage (signed upload) for larger videos. This API is intended for short clips.",
          max_bytes_hint: 4_400_000,
          file_bytes: file.size,
        },
        { status: 413 }
      );
    }

    const supabase = getSupabaseAdminClient();

    const ext = extFromName(file.name || "video.mp4");
    const filePath = `${FOUNDER_USER_ID}/${Date.now()}-${randHex(12)}.${ext}`;

    const arrayBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    const { error: uploadErr } = await supabase.storage.from(VIDEO_BUCKET).upload(filePath, bytes, {
      contentType: file.type || "video/mp4",
      cacheControl: "3600",
      upsert: false,
    });

    if (uploadErr) {
      return json(
        { ok: false, error: "Storage upload failed", details: uploadErr.message },
        { status: 500 }
      );
    }

    const { data: row, error: insertErr } = await supabase
      .from("wardrobe_videos")
      .insert({
        user_id: FOUNDER_USER_ID,
        status: "uploaded",
        video_url: filePath,
      })
      .select(
        "id,user_id,status,video_url,created_at,last_process_message_id,last_process_retried,last_processed_at"
      )
      .single();

    if (insertErr) {
      return json(
        { ok: false, error: "DB insert failed", details: insertErr.message },
        { status: 500 }
      );
    }

    const { data: signed, error: signedErr } = await supabase.storage
      .from(VIDEO_BUCKET)
      .createSignedUrl(filePath, 60 * 60);

    return json(
      {
        ok: true,
        video: row,
        signed_url: signedErr ? null : signed?.signedUrl ?? null,
      },
      { status: 200 }
    );
  } catch (err: any) {
    return json(
      { ok: false, error: "Server error", details: err?.message ?? "unknown" },
      { status: 500 }
    );
  }
}