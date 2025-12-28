// app/api/wardrobe-videos/process/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseClient.server";
import { Client as QStashClient, Receiver as QStashReceiver } from "@upstash/qstash";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FOUNDER_USER_ID =
  process.env.FOUNDER_USER_ID ?? "00000000-0000-0000-0000-000000000001";

type VideoStatus = "uploaded" | "processing" | "processed" | "failed";

type ProcessActionBody = {
  action: "process";
  wardrobe_video_id: string;
  force?: boolean;
  sample_every_seconds?: number;
  max_frames?: number;
  max_width?: number;
  max_candidates?: number;
};

type QStashJobBody = {
  wardrobe_video_id: string;
  sample_every_seconds?: number;
  max_frames?: number;
  max_width?: number;
  max_candidates?: number;
  force?: boolean;
  reason?: string;
};

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function jsonNoStore(payload: any, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function clampInt(v: unknown, fallback: number, min: number, max: number) {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function pickSiteUrl(req: NextRequest): string {
  const explicit = asString(process.env.NEXT_PUBLIC_SITE_URL);
  if (explicit) return explicit.replace(/\/$/, "");

  // Vercel sets VERCEL_URL without protocol.
  const vercelUrl = asString(process.env.VERCEL_URL);
  if (vercelUrl) {
    const proto = asString(req.headers.get("x-forwarded-proto")) || "https";
    return `${proto}://${vercelUrl}`;
  }

  const proto = asString(req.headers.get("x-forwarded-proto")) || "https";
  const host = asString(req.headers.get("x-forwarded-host")) || asString(req.headers.get("host"));
  if (host) return `${proto}://${host}`;

  return "";
}

async function verifyQStashOrThrow(req: NextRequest, rawBody: string) {
  // In production we REQUIRE signature verification.
  const signature = asString(
    req.headers.get("upstash-signature") || req.headers.get("Upstash-Signature")
  );

  const currentSigningKey = asString(process.env.QSTASH_CURRENT_SIGNING_KEY);
  const nextSigningKey = asString(process.env.QSTASH_NEXT_SIGNING_KEY);

  const isProd = process.env.NODE_ENV === "production";

  if (!signature) {
    if (isProd) throw new Error("Missing Upstash-Signature header");
    return; // allow local/manual calls in dev
  }

  if (!currentSigningKey) {
    if (isProd) throw new Error("Missing QSTASH_CURRENT_SIGNING_KEY");
    return;
  }

  const siteUrl = pickSiteUrl(req);
  const url = siteUrl ? `${siteUrl}${req.nextUrl.pathname}` : req.nextUrl.toString();

  // ReceiverConfig expects both keys. If NEXT key is not set yet, reuse the current key.
  // (Rotation is optional; verification still works with a single key.)
  const receiverConfig = {
    currentSigningKey,
    nextSigningKey: nextSigningKey || currentSigningKey,
  };

  const receiver = new QStashReceiver(receiverConfig);

  const ok = await receiver.verify({
    signature,
    body: rawBody,
    url,
  });

  if (!ok) throw new Error("Invalid QStash signature");
}

function getUpstashMessageId(req: NextRequest): string {
  return asString(req.headers.get("upstash-message-id") || req.headers.get("Upstash-Message-Id"));
}

function getUpstashRetryCount(req: NextRequest): number {
  return clampInt(
    req.headers.get("upstash-retry-count") || req.headers.get("Upstash-Retry-Count"),
    0,
    0,
    99
  );
}

async function loadVideoRow(supabase: any, wardrobe_video_id: string) {
  return supabase
    .from("wardrobe_videos")
    .select(
      "id,user_id,video_url,status,created_at,last_process_message_id,last_process_retried,last_processed_at"
    )
    .eq("id", wardrobe_video_id)
    .eq("user_id", FOUNDER_USER_ID)
    .single();
}

/**
 * POST /api/wardrobe-videos/process
 * - UI enqueue: { action: 'process', wardrobe_video_id, ... }
 * - QStash execution: { wardrobe_video_id, ... } + Upstash-Signature header
 */
export async function POST(req: NextRequest) {
  const supabase = getSupabaseServerClient();

  const raw = await req.text();
  const parsed = (() => {
    try {
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  })();

  // -----------------------------
  // 1) QStash execution path
  // -----------------------------
  if (parsed && typeof parsed === "object" && !(parsed as any).action && (parsed as any).wardrobe_video_id) {
    try {
      await verifyQStashOrThrow(req, raw);
    } catch (e: any) {
      return jsonNoStore({ ok: false, error: e?.message || "Unauthorized" }, 401);
    }

    const body = parsed as QStashJobBody;
    const wardrobe_video_id = asString(body.wardrobe_video_id);
    if (!wardrobe_video_id) return jsonNoStore({ ok: false, error: "Missing wardrobe_video_id" }, 400);

    const incomingMessageId = getUpstashMessageId(req);
    const retryCount = getUpstashRetryCount(req);

    const { data: video, error: vErr } = await loadVideoRow(supabase, wardrobe_video_id);
    if (vErr || !video) return jsonNoStore({ ok: false, error: "Video not found" }, 404);

    // Idempotency: already processed => acknowledge.
    if (video.status === "processed" && video.last_processed_at) {
      return jsonNoStore({ ok: true, message: "Already processed", video_id: wardrobe_video_id }, 200);
    }

    // Persist trace fields (best effort)
    if (incomingMessageId && video.last_process_message_id !== incomingMessageId) {
      await supabase
        .from("wardrobe_videos")
        .update({ last_process_message_id: incomingMessageId })
        .eq("id", wardrobe_video_id)
        .eq("user_id", FOUNDER_USER_ID);
    }

    if (retryCount > 0) {
      await supabase
        .from("wardrobe_videos")
        .update({ last_process_retried: true })
        .eq("id", wardrobe_video_id)
        .eq("user_id", FOUNDER_USER_ID);
    }

    // TODO (next tickets):
    // - Extract frames (ffmpeg)
    // - Detect candidates
    // - Insert candidate rows

    const { error: doneErr } = await supabase
      .from("wardrobe_videos")
      .update({
        status: "processed" as VideoStatus,
        last_processed_at: new Date().toISOString(),
      })
      .eq("id", wardrobe_video_id)
      .eq("user_id", FOUNDER_USER_ID);

    if (doneErr) {
      // Return 200 to avoid hammering retries; we record failure state.
      await supabase
        .from("wardrobe_videos")
        .update({ status: "failed" as VideoStatus })
        .eq("id", wardrobe_video_id)
        .eq("user_id", FOUNDER_USER_ID);

      return jsonNoStore({ ok: false, error: doneErr.message, video_id: wardrobe_video_id }, 200);
    }

    return jsonNoStore({ ok: true, message: "Processed", video_id: wardrobe_video_id }, 200);
  }

  // -----------------------------
  // 2) UI enqueue path
  // -----------------------------
  const body = parsed as ProcessActionBody | null;
  if (!body || body.action !== "process") {
    return jsonNoStore({ ok: false, error: "Unsupported request" }, 400);
  }

  const videoId = asString(body.wardrobe_video_id);
  if (!videoId) return jsonNoStore({ ok: false, error: "Missing wardrobe_video_id" }, 400);

  const { data: video, error: vErr } = await loadVideoRow(supabase, videoId);
  if (vErr || !video) return jsonNoStore({ ok: false, error: "Video not found" }, 404);

  const force = Boolean(body.force);

  // True idempotency: if already processing and we have a job id, do not enqueue again.
  if (video.status === "processing" && video.last_process_message_id && !force) {
    return jsonNoStore({
      ok: true,
      message: "Already processing",
      job_id: video.last_process_message_id,
      video,
    });
  }

  const siteUrl = pickSiteUrl(req);
  if (!siteUrl) {
    return jsonNoStore(
      {
        ok: false,
        error: "Missing site url. Set NEXT_PUBLIC_SITE_URL or ensure VERCEL_URL exists.",
      },
      500
    );
  }

  const token = asString(process.env.QSTASH_TOKEN);
  if (!token) return jsonNoStore({ ok: false, error: "Missing QSTASH_TOKEN" }, 500);

  const qstash = new QStashClient({ token });
  const callbackUrl = `${siteUrl}/api/wardrobe-videos/process`;

  const sample_every_seconds = clampInt(body.sample_every_seconds, 2, 1, 10);
  const max_frames = clampInt(body.max_frames, 24, 6, 120);
  const max_width = clampInt(body.max_width, 960, 480, 1920);
  const max_candidates = clampInt(body.max_candidates, 12, 1, 25);

  // QStash dedupe: same videoId = same queue message (unless force).
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
    } satisfies QStashJobBody,
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
      .update({ status: "failed" as VideoStatus })
      .eq("id", videoId)
      .eq("user_id", FOUNDER_USER_ID);

    return jsonNoStore({ ok: false, error: "QStash publish returned no message id" }, 500);
  }

  // Persist processing + message id BEFORE returning.
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

  if (upErr || !updated) {
    return jsonNoStore({ ok: false, error: upErr?.message || "Failed to persist job id" }, 500);
  }

  return jsonNoStore({
    ok: true,
    job_id: messageId,
    video: updated,
  });
}