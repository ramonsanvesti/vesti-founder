// app/api/wardrobe-videos/process/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseClient.server";
import { Client as QStashClient, Receiver as QStashReceiver } from "@upstash/qstash";

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

async function verifyQStashOrThrow(req: NextRequest, rawBody: string) {
  // In production we REQUIRE signature verification.
  const signature = asString(req.headers.get("upstash-signature") || req.headers.get("Upstash-Signature"));

  const currentSigningKey = asString(process.env.QSTASH_CURRENT_SIGNING_KEY);
  const nextSigningKey = asString(process.env.QSTASH_NEXT_SIGNING_KEY);

  const isProd = process.env.NODE_ENV === "production";

  if (!signature) {
    if (isProd) throw new Error("Missing Upstash-Signature header");
    return; // allow local/manual calls in dev
  }

  if (!currentSigningKey) {
    if (isProd) throw new Error("Missing QSTASH_CURRENT_SIGNING_KEY");
    return; // allow dev
  }

  const siteUrl = pickSiteUrl(req);
  const url = siteUrl ? `${siteUrl}${req.nextUrl.pathname}` : req.nextUrl.toString();

  const receiver = new QStashReceiver({
    currentSigningKey,
    // nextSigningKey is optional
    ...(nextSigningKey ? { nextSigningKey } : {}),
  } as any);

  const ok = await receiver.verify({
    signature,
    body: rawBody,
    url,
  } as any);

  if (!ok) throw new Error("Invalid QStash signature");
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
   * JSON: either UI enqueue (action=process) OR QStash callback job execution
   */
  const raw = await req.text();
  const parsed = (() => {
    try {
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  })();

  // 1) QStash callback execution path: body has wardrobe_video_id but NO action.
  if (parsed && typeof parsed === "object" && !parsed.action && parsed.wardrobe_video_id) {
    // Verify signature (prod-safe). If verification fails, return 401.
    try {
      await verifyQStashOrThrow(req, raw);
    } catch (e: any) {
      return jsonNoStore({ ok: false, error: e?.message || "Unauthorized" }, 401);
    }

    const wardrobe_video_id = asString((parsed as any).wardrobe_video_id);
    if (!wardrobe_video_id) return jsonNoStore({ ok: false, error: "Missing wardrobe_video_id" }, 400);

    // Retry metadata (optional)
    const retryCount = clampInt(req.headers.get("upstash-retry-count") || req.headers.get("Upstash-Retry-Count"), 0, 0, 99);
    const incomingMessageId = asString(req.headers.get("upstash-message-id") || req.headers.get("Upstash-Message-Id"));

    // Load the video row (scoped)
    const { data: video, error: vErr } = await supabase
      .from("wardrobe_videos")
      .select(
        "id,user_id,video_url,status,created_at,last_process_message_id,last_process_retried,last_processed_at"
      )
      .eq("id", wardrobe_video_id)
      .eq("user_id", FOUNDER_USER_ID)
      .single();

    if (vErr || !video) return jsonNoStore({ ok: false, error: "Video not found" }, 404);

    // Idempotency: if already processed, acknowledge success.
    if (video.status === "processed" && video.last_processed_at) {
      return jsonNoStore({ ok: true, message: "Already processed", video_id: wardrobe_video_id });
    }

    // Ensure message id is persisted if we have it (helps debugging/traceability)
    if (incomingMessageId && !video.last_process_message_id) {
      await supabase
        .from("wardrobe_videos")
        .update({ last_process_message_id: incomingMessageId })
        .eq("id", wardrobe_video_id)
        .eq("user_id", FOUNDER_USER_ID);
    }

    // Mark retry flag if this execution is a retry
    if (retryCount > 0) {
      await supabase
        .from("wardrobe_videos")
        .update({ last_process_retried: true })
        .eq("id", wardrobe_video_id)
        .eq("user_id", FOUNDER_USER_ID);
    }

    // ----
    // NOTE: This is the execution endpoint. The heavy pipeline (extract frames -> detect candidates -> insert temp candidates)
    // will live here, but we keep this first pass safe + deterministic.
    // For now we mark processed so the UI stops looping while we iterate on the next stages.
    // ----

    const { error: doneErr } = await supabase
      .from("wardrobe_videos")
      .update({
        status: "processed" as VideoStatus,
        last_processed_at: new Date().toISOString(),
      })
      .eq("id", wardrobe_video_id)
      .eq("user_id", FOUNDER_USER_ID);

    if (doneErr) {
      // Return 200 so QStash doesn’t hammer retries; we already have state in DB.
      await supabase
        .from("wardrobe_videos")
        .update({ status: "failed" as VideoStatus })
        .eq("id", wardrobe_video_id)
        .eq("user_id", FOUNDER_USER_ID);

      return jsonNoStore({ ok: false, error: doneErr.message, video_id: wardrobe_video_id }, 200);
    }

    return jsonNoStore({ ok: true, message: "Processed", video_id: wardrobe_video_id }, 200);
  }

  // 2) UI enqueue path: action=process
  const body = parsed as ProcessActionBody | null;
  if (!body || body.action !== "process") {
    return jsonNoStore({ ok: false, error: "Unsupported request" }, 400);
  }

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