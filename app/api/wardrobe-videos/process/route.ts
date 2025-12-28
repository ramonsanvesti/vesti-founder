// app/api/wardrobe-videos/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseClient.server";
import { Client as QStashClient } from "@upstash/qstash";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FOUNDER_USER_ID =
  process.env.FOUNDER_USER_ID ?? "00000000-0000-0000-0000-000000000001";

type VideoStatus = "uploaded" | "processing" | "processed" | "failed";

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function jsonNoStore(payload: any, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function pickSiteUrl(req: NextRequest): string {
  const explicit = asString(process.env.NEXT_PUBLIC_SITE_URL);
  if (explicit) return explicit.replace(/\/$/, "");

  const vercelUrl = asString(process.env.VERCEL_URL);
  if (vercelUrl) {
    const proto = asString(req.headers.get("x-forwarded-proto")) || "https";
    return `${proto}://${vercelUrl}`;
  }

  const proto = asString(req.headers.get("x-forwarded-proto")) || "https";
  const host =
    asString(req.headers.get("x-forwarded-host")) || asString(req.headers.get("host"));
  if (host) return `${proto}://${host}`;

  return "";
}

async function signedPlaybackUrl(supabase: any, path: string): Promise<string | null> {
  const p = asString(path);
  if (!p) return null;

  // If a full URL was stored, return it as-is.
  if (/^https?:\/\//i.test(p)) return p;

  // Prefer signed URL (private by default). 1 hour.
  const { data, error } = await supabase.storage
    .from("wardrobe_videos")
    .createSignedUrl(p, 60 * 60);

  if (!error && data?.signedUrl) return String(data.signedUrl);

  // Fallback: public URL (in case bucket is public)
  const { data: pub } = supabase.storage.from("wardrobe_videos").getPublicUrl(p);
  return pub?.publicUrl ? String(pub.publicUrl) : null;
}

function clampInt(v: unknown, fallback: number, min: number, max: number) {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/**
 * GET /api/wardrobe-videos
 * MUST be side-effect free. Only list.
 */
export async function GET() {
  const supabase = getSupabaseServerClient();

  const { data, error } = await supabase
    .from("wardrobe_videos")
    .select(
      "id,user_id,video_url,status,created_at,last_process_message_id,last_process_retried,last_processed_at"
    )
    .eq("user_id", FOUNDER_USER_ID)
    .order("created_at", { ascending: false });

  if (error) return jsonNoStore({ ok: false, error: error.message }, 500);

  const rows = Array.isArray(data) ? data : [];

  const videos = await Promise.all(
    rows.map(async (v: any) => {
      const playback_url = await signedPlaybackUrl(supabase, String(v.video_url || ""));
      return { ...v, playback_url };
    })
  );

  return jsonNoStore({ ok: true, videos });
}

type ProcessActionBody = {
  action: "process";
  wardrobe_video_id: string;
  force?: boolean;
  sample_every_seconds?: number;
  max_frames?: number;
  max_width?: number;
  max_candidates?: number;
};

export async function POST(req: NextRequest) {
  const supabase = getSupabaseServerClient();
  const contentType = asString(req.headers.get("content-type")).toLowerCase();

  /**
   * Upload (multipart/form-data)
   * Field: file
   */
  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    const file = form.get("file");

    if (!(file instanceof File)) return jsonNoStore({ ok: false, error: "Missing file" }, 400);

    const maxBytes = 120 * 1024 * 1024; // 120MB guard
    if (file.size > maxBytes) return jsonNoStore({ ok: false, error: "File too large" }, 400);

    const name = asString((file as any).name);
    const ext = (name.split(".").pop() || "mp4").toLowerCase();
    const safeExt = ext && ext.length <= 6 ? ext : "mp4";

    const key = `${FOUNDER_USER_ID}/${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}.${safeExt}`;

    const bytes = new Uint8Array(await file.arrayBuffer());

    const { error: uploadErr } = await supabase.storage.from("wardrobe_videos").upload(key, bytes, {
      contentType: file.type || "video/mp4",
      upsert: false,
      cacheControl: "31536000",
    });

    if (uploadErr) return jsonNoStore({ ok: false, error: uploadErr.message }, 500);

    const { data: inserted, error: insErr } = await supabase
      .from("wardrobe_videos")
      .insert({
        user_id: FOUNDER_USER_ID,
        video_url: key,
        status: "uploaded",
      })
      .select(
        "id,user_id,video_url,status,created_at,last_process_message_id,last_process_retried,last_processed_at"
      )
      .single();

    if (insErr || !inserted)
      return jsonNoStore({ ok: false, error: insErr?.message || "Insert failed" }, 500);

    const playback_url = await signedPlaybackUrl(supabase, inserted.video_url);

    return jsonNoStore({ ok: true, video: { ...inserted, playback_url } });
  }

  /**
   * Process action (JSON)
   */
  const body = (await req.json().catch(() => null)) as ProcessActionBody | null;
  if (!body || body.action !== "process")
    return jsonNoStore({ ok: false, error: "Unsupported request" }, 400);

  const videoId = asString(body.wardrobe_video_id);
  if (!videoId) return jsonNoStore({ ok: false, error: "Missing wardrobe_video_id" }, 400);

  const { data: video, error: vErr } = await supabase
    .from("wardrobe_videos")
    .select(
      "id,user_id,video_url,status,created_at,last_process_message_id,last_process_retried,last_processed_at"
    )
    .eq("id", videoId)
    .eq("user_id", FOUNDER_USER_ID)
    .single();

  if (vErr || !video) return jsonNoStore({ ok: false, error: "Video not found" }, 404);

  const force = Boolean(body.force);

  // Retry-safe: if already processing with a job id, return it (no re-enqueue).
  if (video.status === "processing" && video.last_process_message_id && !force) {
    const playback_url = await signedPlaybackUrl(supabase, video.video_url);
    return jsonNoStore({
      ok: true,
      message: "Already processing",
      job_id: video.last_process_message_id,
      video: { ...video, playback_url },
    });
  }

  // Healing: if stuck as processing with no job id, reset to uploaded before enqueue.
  if (video.status === "processing" && !video.last_process_message_id) {
    await supabase
      .from("wardrobe_videos")
      .update({ status: "uploaded" })
      .eq("id", videoId)
      .eq("user_id", FOUNDER_USER_ID);
    (video as any).status = "uploaded";
  }

  const siteUrl = pickSiteUrl(req);
  if (!siteUrl)
    return jsonNoStore(
      { ok: false, error: "Missing site url. Set NEXT_PUBLIC_SITE_URL or ensure VERCEL_URL exists." },
      500
    );

  const token = asString(process.env.QSTASH_TOKEN);
  if (!token) return jsonNoStore({ ok: false, error: "Missing QSTASH_TOKEN" }, 500);

  const qstash = new QStashClient({ token });
  const callbackUrl = `${siteUrl}/api/wardrobe-videos/process`;

  const sample_every_seconds = clampInt(body.sample_every_seconds, 2, 1, 10);
  const max_frames = clampInt(body.max_frames, 24, 6, 120);
  const max_width = clampInt(body.max_width, 960, 480, 1920);
  const max_candidates = clampInt(body.max_candidates, 12, 1, 25);

  const dedupeId = force ? `wardrobe_video:${videoId}:${Date.now()}` : `wardrobe_video:${videoId}`;

  const publishResult: any = await qstash.publishJSON({
    url: callbackUrl,
    body: {
      wardrobe_video_id: videoId,
      sample_every_seconds,
      max_frames,
      max_width,
      max_candidates,
      force,
      reason: "user_click",
    },
    headers: { "Content-Type": "application/json" },
    deduplicationId: dedupeId,
  });

  const messageId =
    (typeof publishResult?.messageId === "string" && publishResult.messageId) ||
    (typeof publishResult?.message_id === "string" && publishResult.message_id) ||
    null;

  if (!messageId) {
    await supabase
      .from("wardrobe_videos")
      .update({ status: "failed" })
      .eq("id", videoId)
      .eq("user_id", FOUNDER_USER_ID);

    return jsonNoStore({ ok: false, error: "QStash publish returned no message id" }, 500);
  }

  // Critical: set processing + save message id BEFORE returning (prevents your current bug)
  const { data: updated, error: upErr } = await supabase
    .from("wardrobe_videos")
    .update({
      status: "processing" as VideoStatus,
      last_process_message_id: messageId,
      last_process_retried: false,
    })
    .eq("id", videoId)
    .eq("user_id", FOUNDER_USER_ID)
    .select(
      "id,user_id,video_url,status,created_at,last_process_message_id,last_process_retried,last_processed_at"
    )
    .single();

  if (upErr || !updated)
    return jsonNoStore({ ok: false, error: upErr?.message || "Failed to persist job id" }, 500);

  const playback_url = await signedPlaybackUrl(supabase, updated.video_url);

  return jsonNoStore({
    ok: true,
    job_id: messageId,
    video: { ...updated, playback_url },
  });
}