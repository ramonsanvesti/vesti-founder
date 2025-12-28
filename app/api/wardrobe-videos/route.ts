// app/api/wardrobe-videos/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseClient.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

// Founder Edition: single-user scope
const FOUNDER_USER_ID =
  process.env.FOUNDER_USER_ID ?? "00000000-0000-0000-0000-000000000001";

type Status = "uploaded" | "processing" | "processed" | "failed";

type CreateBody = {
  video_url?: string;
  auto_process?: boolean;
};

type ProcessActionBody = {
  action: "process";
  video_id?: string;
  wardrobe_video_id?: string;
  sample_every_seconds?: number;
  max_frames?: number;
  max_width?: number;
  max_candidates?: number;
};

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}


function clampInt(v: unknown, fallback: number, min: number, max: number) {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function normalizeBaseUrl(raw: string) {
  const v = (raw || "").trim().replace(/\/$/, "");
  if (!v) return "";
  if (v.startsWith("http://") || v.startsWith("https://")) return v;
  // If someone sets NEXT_PUBLIC_SITE_URL or SITE_URL without a scheme,
  // assume https in production.
  return `https://${v}`;
}

function getBaseUrl(req: NextRequest) {
  // Prefer explicit site URL, then Vercel URL, then request host.
  // NOTE: VERCEL_URL is domain-only (no scheme). QStash requires a full URL with http/https.
  const fromEnv =
    normalizeBaseUrl(process.env.SITE_URL || "") ||
    normalizeBaseUrl(process.env.NEXT_PUBLIC_SITE_URL || "") ||
    normalizeBaseUrl(process.env.VERCEL_URL || "");

  if (fromEnv) return fromEnv;

  const proto = (req.headers.get("x-forwarded-proto") || "https").replace(":", "");
  const host = req.headers.get("x-forwarded-host") || req.nextUrl.host;
  return `${proto}://${host}`;
}

function isConfiguredQStash() {
  // Token is required to publish.
  // Signing keys are used by the receiving endpoint to verify authenticity.
  return Boolean(process.env.QSTASH_TOKEN);
}

function qstashPublishUrl(targetUrl: string) {
  // QStash v2 publish endpoint expects the destination URL as part of the path.
  // IMPORTANT: Do NOT encodeURIComponent() the destination here.
  // If you encode it, QStash may treat the scheme as `https%3A...` and reject it.
  // Upstash docs show: https://qstash.upstash.io/v2/publish/https://example.com
  return `https://qstash.upstash.io/v2/publish/${targetUrl}`;
}

async function enqueueProcessJob(args: {
  wardrobeVideoId: string;
  baseUrl: string;
  sampleEverySeconds?: number;
  maxFrames?: number;
  maxWidth?: number;
  maxCandidates?: number;
}) {
  const {
    wardrobeVideoId,
    baseUrl,
    sampleEverySeconds = 3,
    maxFrames = 20,
    maxWidth = 900,
    maxCandidates = 12,
  } = args;

  const payload = {
    wardrobe_video_id: wardrobeVideoId,
    sample_every_seconds: sampleEverySeconds,
    max_frames: maxFrames,
    max_width: maxWidth,
    max_candidates: maxCandidates,
  };

  const safeBaseUrl = normalizeBaseUrl(baseUrl);
  const targetUrl = new URL("/api/wardrobe-videos/process", safeBaseUrl).toString();

  const dedupeId = `wardrobe_video:${wardrobeVideoId}:process:${sampleEverySeconds}:${maxFrames}:${maxWidth}:${maxCandidates}`;

  // If QStash isn't configured, do a best-effort direct call (does not block response).
  if (!isConfiguredQStash()) {
    fetch(targetUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => {});

    return {
      ok: true,
      enqueued: false,
      fallback: "direct_fetch" as const,
      target_url: targetUrl,
      dedupe_id: dedupeId,
      message_id: null as string | null,
    };
  }

  // If receiver signing keys are configured, the receiver will reject unsigned direct calls.
  // In that case, do NOT attempt direct_fetch fallback when QStash publish fails.
  const receiverIsSigned = Boolean(process.env.QSTASH_CURRENT_SIGNING_KEY);

  const publishUrl = qstashPublishUrl(targetUrl);
  if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
    return {
      ok: false,
      enqueued: false,
      target_url: targetUrl,
      dedupe_id: dedupeId,
      message_id: null as string | null,
      qstash_error: { status: 400, body: "target_url missing http/https scheme" },
    };
  }
  const retries = 5;

  const r = await fetch(publishUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.QSTASH_TOKEN}`,
      "Content-Type": "application/json",
      "Upstash-Method": "POST",
      "Upstash-Content-Type": "application/json",
      "Upstash-Deduplication-Id": dedupeId,
      "Upstash-Retries": String(retries),
      "Upstash-Timeout": "120",
    },
    body: JSON.stringify(payload),
  });

  if (!r.ok) {
    const txt = await r.text().catch(() => "");

    // Only attempt direct fetch fallback if receiver is not enforcing signatures.
    if (!receiverIsSigned) {
      fetch(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).catch(() => {});

      return {
        ok: true,
        enqueued: false,
        fallback: "direct_fetch" as const,
        target_url: targetUrl,
        dedupe_id: dedupeId,
        message_id: null as string | null,
        qstash_error: { status: r.status, body: txt.slice(0, 500) },
      };
    }

    return {
      ok: false,
      enqueued: false,
      target_url: targetUrl,
      dedupe_id: dedupeId,
      message_id: null as string | null,
      qstash_error: { status: r.status, body: txt.slice(0, 500) },
    };
  }

  const qstashJson = await r.json().catch(() => null);
  const messageId =
    (qstashJson && (qstashJson.messageId || qstashJson.message_id || qstashJson.id)) || null;

  return {
    ok: true,
    enqueued: true,
    target_url: targetUrl,
    dedupe_id: dedupeId,
    message_id: typeof messageId === "string" ? messageId : null,
    qstash: qstashJson,
  };
}

/**
 * GET /api/wardrobe-videos
 * Query:
 *  - limit (default 20, max 100)
 *  - status (optional)
 */
export async function GET(req: NextRequest) {
  try {
    const supabase = getSupabaseServerClient();

    const { searchParams } = new URL(req.url);
    const limit = clampInt(searchParams.get("limit"), 20, 1, 100);
    const status = asString(searchParams.get("status")) as Status | "";

    let q = supabase
      .from("wardrobe_videos")
      .select("id,user_id,video_url,status,created_at,last_process_message_id,last_process_retried,last_processed_at")
      .eq("user_id", FOUNDER_USER_ID)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (status) q = q.eq("status", status);

    const { data, error } = await q;

    if (error) {
      return NextResponse.json(
        { ok: false, error: "Failed to list videos", details: error.message },
        { status: 500, headers: { "Cache-Control": "no-store" } }
      );
    }

    return NextResponse.json({ ok: true, videos: data ?? [] }, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: "Server error", details: err?.message ?? "unknown" },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}

/**
 * POST /api/wardrobe-videos
 * Two modes:
 * 1) Create: { video_url, auto_process? }
 * 2) Process: { action:"process", video_id|wardrobe_video_id, ...optional params }
 */
export async function POST(req: NextRequest) {
  try {
    const supabase = getSupabaseServerClient();
    const body = (await req.json().catch(() => ({}))) as CreateBody | ProcessActionBody;

    // PROCESS action
    if ((body as any)?.action === "process") {
      const b = body as ProcessActionBody;
      const videoId = asString(b.wardrobe_video_id || b.video_id);

      if (!videoId) {
        return NextResponse.json({ ok: false, error: "Missing video_id" }, { status: 400, headers: { "Cache-Control": "no-store" } });
      }

      // Load video record (user-scoped)
      const { data: video, error: loadErr } = await supabase
        .from("wardrobe_videos")
        .select("id,user_id,status,video_url,created_at,last_process_message_id,last_process_retried,last_processed_at")
        .eq("id", videoId)
        .eq("user_id", FOUNDER_USER_ID)
        .single();

      if (loadErr || !video) {
        return NextResponse.json(
          { ok: false, error: "Video not found", details: loadErr?.message ?? "missing row" },
          { status: 404, headers: { "Cache-Control": "no-store" } }
        );
      }

      if (video.status === "processed") {
        return NextResponse.json(
          { ok: true, wardrobe_video: video, message: "Already processed" },
          { status: 200, headers: { "Cache-Control": "no-store" } }
        );
      }

      // Retry-safe trigger: if a job is already in-flight and we have its message id, don't enqueue another.
      if (video.status === "processing" && video.last_process_message_id) {
        return NextResponse.json(
          {
            ok: true,
            wardrobe_video_id: video.id,
            status: "processing" as const,
            message_id: video.last_process_message_id,
            last_process_message_id: video.last_process_message_id,
            last_process_retried: (video as any).last_process_retried ?? null,
            last_processed_at: (video as any).last_processed_at ?? null,
            enqueued: { ok: true, enqueued: false, reason: "already_processing" },
          },
          { status: 200, headers: { "Cache-Control": "no-store" } }
        );
      }

      const sampleEverySeconds = clampInt(b.sample_every_seconds, 2, 1, 10);
      const maxFrames = clampInt(b.max_frames, 24, 6, 120);
      const maxWidth = clampInt(b.max_width, 960, 480, 1920);
      const maxCandidates = clampInt(b.max_candidates, 12, 1, 25);

      const baseUrl = getBaseUrl(req);

      const enqueue = await enqueueProcessJob({
        wardrobeVideoId: video.id,
        baseUrl,
        sampleEverySeconds,
        maxFrames,
        maxWidth,
        maxCandidates,
      });

      // If enqueue failed, do NOT leave the row in `processing`.
      if (!enqueue.ok) {
        // Best-effort: mark failed so UI doesn't get stuck.
        try {
          await supabase
            .from("wardrobe_videos")
            .update({
              status: "failed",
              // Keep traceability fields empty so reprocess can enqueue again.
              last_process_message_id: null,
              last_process_retried: true,
            })
            .eq("id", video.id)
            .eq("user_id", FOUNDER_USER_ID);
        } catch {
          // ignore
        }

        return NextResponse.json(
          {
            ok: false,
            wardrobe_video_id: video.id,
            wardrobe_video: video,
            status: "failed",
            message_id: null,
            last_process_message_id: null,
            last_process_retried: true,
            last_processed_at: (video as any).last_processed_at ?? null,
            enqueued: enqueue,
            error: "Failed to enqueue processing job",
          },
          { status: 200, headers: { "Cache-Control": "no-store" } }
        );
      }

      // Ensure we ALWAYS set a message id when we enter processing.
      const messageId = enqueue.message_id || `direct:${Date.now()}`;
      const wasRetry = video.status === "failed" || Boolean(video.last_process_message_id) || Boolean((video as any).last_process_retried);

      // Atomic-ish update: move to processing and stamp traceability.
      // Allow if status is uploaded/failed OR if it is processing but missing message id (stuck).
      try {
        await supabase
          .from("wardrobe_videos")
          .update({
            status: "processing",
            last_process_message_id: messageId,
            last_process_retried: wasRetry,
          })
          .eq("id", video.id)
          .eq("user_id", FOUNDER_USER_ID);
      } catch {
        // ignore
      }

      // Re-load the row so the client always gets the latest status + traceability fields.
      const { data: updatedVideo } = await supabase
        .from("wardrobe_videos")
        .select("id,user_id,video_url,status,created_at,last_process_message_id,last_process_retried,last_processed_at")
        .eq("id", video.id)
        .eq("user_id", FOUNDER_USER_ID)
        .single();

      return NextResponse.json(
        {
          ok: true,
          wardrobe_video_id: video.id,
          wardrobe_video: updatedVideo ?? null,
          status: (updatedVideo?.status ?? "processing") as any,
          message_id: (updatedVideo as any)?.last_process_message_id ?? messageId,
          last_process_message_id: (updatedVideo as any)?.last_process_message_id ?? messageId,
          last_process_retried: (updatedVideo as any)?.last_process_retried ?? wasRetry,
          last_processed_at: (updatedVideo as any)?.last_processed_at ?? null,
          enqueued: enqueue,
        },
        { status: 200, headers: { "Cache-Control": "no-store" } }
      );
    }

    // CREATE video row
    const create = body as CreateBody;
    const videoUrl = asString(create.video_url);

    if (!videoUrl) {
      return NextResponse.json({ ok: false, error: "Missing video_url" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    }

    // Create immediately in DB
    const { data: row, error: insertErr } = await supabase
      .from("wardrobe_videos")
      .insert({
        user_id: FOUNDER_USER_ID,
        video_url: videoUrl,
        status: "uploaded",
      })
      .select("id,user_id,video_url,status,created_at,last_process_message_id,last_process_retried,last_processed_at")
      .single();

    if (insertErr || !row) {
      return NextResponse.json(
        { ok: false, error: "Failed to create video row", details: insertErr?.message ?? "unknown" },
        { status: 500, headers: { "Cache-Control": "no-store" } }
      );
    }

    // Optional: auto-process right after upload record creation
    if (create.auto_process) {
      void (async () => {
        try {
          const { data: latest } = await supabase
            .from("wardrobe_videos")
            .select("id,status,last_process_message_id")
            .eq("id", row.id)
            .eq("user_id", FOUNDER_USER_ID)
            .single();

          if (latest?.status === "processed") return;
          if (latest?.status === "processing" && latest?.last_process_message_id) return;
        } catch {
          // ignore
        }

        try {
          const enq = await enqueueProcessJob({
            wardrobeVideoId: row.id,
            baseUrl: getBaseUrl(req),
          });

          if (!enq.ok) {
            // best-effort: mark failed so UI doesn't show a stuck processing state
            try {
              await supabase
                .from("wardrobe_videos")
                .update({ status: "failed" })
                .eq("id", row.id)
                .eq("user_id", FOUNDER_USER_ID)
                .in("status", ["uploaded", "processing"]);
            } catch {
              // ignore
            }
            return;
          }

          const messageId = enq.message_id || `direct:${Date.now()}`;

          await supabase
            .from("wardrobe_videos")
            .update({
              status: "processing",
              last_process_message_id: messageId,
              last_process_retried: false,
            })
            .eq("id", row.id)
            .eq("user_id", FOUNDER_USER_ID);
        } catch {
          // ignore
        }
      })();
    }

    return NextResponse.json(
      { ok: true, wardrobe_video: row, auto_process: Boolean(create.auto_process) },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: "Server error", details: err?.message ?? "unknown" },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}