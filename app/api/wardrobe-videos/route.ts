// app/api/wardrobe-videos/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseClient.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

// Founder Edition: single-user scope
const FOUNDER_USER_ID =
  process.env.FOUNDER_USER_ID ?? "00000000-0000-0000-0000-000000000001";

// Supabase Storage bucket for wardrobe videos
const WARDROBE_VIDEOS_BUCKET =
  process.env.WARDROBE_VIDEOS_BUCKET ?? "wardrobe_videos";

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
  force?: boolean;
};

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function clampInt(v: unknown, fallback: number, min: number, max: number) {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

// Helper: Retry update if column does not exist error is returned (Supabase)
async function safeUpdateWardrobeVideo(
  supabase: ReturnType<typeof getSupabaseServerClient>,
  videoId: string,
  patch: Record<string, any>
) {
  let current = { ...patch };
  for (let i = 0; i < 4; i++) {
    const { error } = await supabase
      .from("wardrobe_videos")
      .update(current)
      .eq("id", videoId)
      .eq("user_id", FOUNDER_USER_ID);

    if (!error) return { ok: true };

    const msg = String(error.message || "");
    const m = msg.match(/column\s+wardrobe_videos\.(\w+)\s+does not exist/i);
    if (m?.[1]) {
      const col = m[1];
      if (col in current) {
        delete current[col];
        continue;
      }
    }

    // If we can't auto-recover, return the error
    return { ok: false, error: msg };
  }
  return { ok: false, error: "failed to update after retries" };
}

function pickMessageIdFromEnqueue(enq: any, fallback: string) {
  const raw = enq?.message_id || enq?.messageId || enq?.id || enq?.dedupe_id || enq?.deduplicationId;
  return typeof raw === "string" && raw.trim() ? raw.trim() : fallback;
}

function normalizeBaseUrl(raw: string) {
  const v = (raw || "").trim().replace(/\/$/, "");
  if (!v) return "";
  if (v.startsWith("http://") || v.startsWith("https://")) return v;
  // If someone sets NEXT_PUBLIC_SITE_URL or SITE_URL without a scheme,
  // assume https in production.
  return `https://${v}`;
}

function firstHeaderValue(v: string | null) {
  // Vercel/Proxies can send comma-separated values.
  return (v || "").split(",")[0]?.trim() || "";
}

function getBaseUrl(req: NextRequest) {
  // 1) Prefer explicit site URL.
  // 2) Otherwise, prefer the request origin (already includes scheme).
  // 3) Finally, fall back to forwarded headers.
  // NOTE: VERCEL_URL is domain-only (no scheme). QStash requires a full URL with http/https.

  const fromEnv =
    normalizeBaseUrl(process.env.SITE_URL || "") ||
    normalizeBaseUrl(process.env.NEXT_PUBLIC_SITE_URL || "") ||
    normalizeBaseUrl(process.env.VERCEL_URL || "");

  if (fromEnv) return fromEnv;

  const origin = asString(req.nextUrl?.origin);
  if (origin && (origin.startsWith("http://") || origin.startsWith("https://"))) {
    return origin.replace(/\/$/, "");
  }

  const proto =
    firstHeaderValue(req.headers.get("x-forwarded-proto")) || "https";
  const host =
    firstHeaderValue(req.headers.get("x-forwarded-host")) || req.nextUrl.host;

  return `${proto.replace(/:$/, "")}://${host}`;
}

function getQstashApiBase() {
  // QStash API base. If QSTASH_URL is not set, Upstash Cloud default is used.
  const raw = asString(process.env.QSTASH_URL) || "https://qstash.upstash.io";
  const normalized = normalizeBaseUrl(raw);

  // Ensure we point at the /v2 API base.
  const withoutTrailing = normalized.replace(/\/+$/, "");
  if (withoutTrailing.endsWith("/v2")) return withoutTrailing;
  if (withoutTrailing.includes("/v2/")) return withoutTrailing.replace(/\/+$/, "");
  return `${withoutTrailing}/v2`;
}

function getQstashToken() {
  // Upstash docs use QSTASH_TOKEN. Some templates/tools expose alternative names.
  return (
    asString(process.env.QSTASH_TOKEN) ||
    asString(process.env.UPSTASH_QSTASH_TOKEN) ||
    asString(process.env.UPSTASH_QSTASH_REST_TOKEN) ||
    asString(process.env.UPSTASH_WORKFLOW_TOKEN) ||
    asString(process.env.UPSTASH_TOKEN)
  );
}

function isConfiguredQStash() {
  return Boolean(getQstashToken());
}

async function publishToQstash(args: {
  destinationUrl: string;
  body: any;
  dedupeId?: string;
  retries?: number;
  timeoutSeconds?: number;
}) {
  const token = getQstashToken();
  if (!token) {
    return {
      ok: false as const,
      status: 500,
      body:
        "Missing QStash token. Set QSTASH_TOKEN (recommended) or UPSTASH_QSTASH_TOKEN/UPSTASH_QSTASH_REST_TOKEN.",
      data: null as any,
    };
  }

  const apiBase = getQstashApiBase();
  const dest = String(args.destinationUrl || "").trim();
  if (!dest.startsWith("http://") && !dest.startsWith("https://")) {
    return {
      ok: false as const,
      status: 400,
      body: `Destination URL missing scheme: ${dest}`,
      data: null as any,
    };
  }

  // QStash REST API accepts the destination URL directly after `/v2/publish/`.
  // We use `encodeURI` to safely handle spaces and query strings without
  // encoding URL separators (`:` and `/`).
  // Ref: Upstash docs show examples like `/v2/publish/https://my-api...`.
  const endpoint = `${apiBase}/publish/${encodeURI(dest)}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  if (args.dedupeId) headers["Upstash-Deduplication-Id"] = args.dedupeId;
  if (typeof args.retries === "number") headers["Upstash-Retries"] = String(args.retries);
  if (typeof args.timeoutSeconds === "number") headers["Upstash-Timeout"] = `${args.timeoutSeconds}s`;

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(args.body ?? {}),
    });

    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }

    if (!res.ok) {
      return {
        ok: false as const,
        status: res.status,
        body: typeof data === "string" ? data : JSON.stringify(data),
        data,
      };
    }

    return { ok: true as const, status: res.status, body: text, data };
  } catch (err: any) {
    return {
      ok: false as const,
      status: 0,
      body: String(err?.message ?? err ?? "fetch_error"),
      data: null as any,
    };
  }
}

async function enqueueProcessJob(args: {
  wardrobeVideoId: string;
  baseUrl: string;
  sampleEverySeconds?: number;
  maxFrames?: number;
  maxWidth?: number;
  maxCandidates?: number;
  dedupeSuffix?: string;
}) {
  const {
    wardrobeVideoId,
    baseUrl,
    sampleEverySeconds = 3,
    maxFrames = 20,
    maxWidth = 900,
    maxCandidates = 12,
    dedupeSuffix,
  } = args;

  const payload = {
    wardrobe_video_id: wardrobeVideoId,
    sample_every_seconds: sampleEverySeconds,
    max_frames: maxFrames,
    max_width: maxWidth,
    max_candidates: maxCandidates,
  };

  const safeBaseUrl = normalizeBaseUrl(baseUrl);
  if (!safeBaseUrl) {
    return {
      ok: false,
      enqueued: false,
      target_url: "",
      dedupe_id: "",
      message_id: null as string | null,
      qstash_error: {
        status: 400,
        body: "Missing base URL (set NEXT_PUBLIC_SITE_URL or rely on VERCEL_URL/x-forwarded-host).",
      },
    };
  }

  let targetUrl = "";
  try {
    targetUrl = new URL("/api/wardrobe-videos/process", safeBaseUrl).toString();
  } catch {
    return {
      ok: false,
      enqueued: false,
      target_url: "",
      dedupe_id: "",
      message_id: null as string | null,
      qstash_error: {
        status: 400,
        body: `Invalid base URL: ${safeBaseUrl}`,
      },
    };
  }

  const baseDedupeId = `wardrobe_video:${wardrobeVideoId}:process:${sampleEverySeconds}:${maxFrames}:${maxWidth}:${maxCandidates}`;
  const dedupeId = dedupeSuffix ? `${baseDedupeId}:${dedupeSuffix}` : baseDedupeId;

  const receiverIsSigned = Boolean(asString(process.env.QSTASH_CURRENT_SIGNING_KEY));

  // If QStash isn't configured, we can only fall back to a direct call IF the
  // receiver is not enforcing QStash signatures.
  if (!isConfiguredQStash()) {
    if (receiverIsSigned) {
      return {
        ok: false,
        enqueued: false,
        target_url: targetUrl,
        dedupe_id: dedupeId,
        message_id: null as string | null,
        qstash_error: {
          status: 500,
          body:
            "QStash is not configured (missing QSTASH_TOKEN) but the receiver is signature-protected (QSTASH_CURRENT_SIGNING_KEY is set).",
        },
      };
    }

    void fetch(targetUrl, {
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

  // Publish via HTTP API directly to avoid SDK version/option mismatches.
  const published = await publishToQstash({
    destinationUrl: targetUrl,
    body: payload,
    dedupeId,
    retries: 5,
    timeoutSeconds: 120,
  });

  if (!published.ok) {
    const txt = String(published.body || "").slice(0, 1200);
    return {
      ok: false,
      enqueued: false,
      target_url: targetUrl,
      dedupe_id: dedupeId,
      message_id: null as string | null,
      qstash_error: { status: published.status, body: txt },
    };
  }

  const res: any = published.data;
  const messageId =
    (res && (res.messageId || res.message_id || res.id)) || null;

  return {
    ok: true,
    enqueued: true,
    target_url: targetUrl,
    dedupe_id: dedupeId,
    message_id: typeof messageId === "string" ? messageId : null,
    qstash: res,
  };
}

async function signPlaybackUrl(path: string) {
  const supabase = getSupabaseServerClient();
  if (!path) return null;
  try {
    const { data, error } = await supabase
      .storage
      .from(WARDROBE_VIDEOS_BUCKET)
      .createSignedUrl(path, 60 * 60); // 1 hour

    if (error) return null;
    return data?.signedUrl ?? null;
  } catch {
    return null;
  }
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
      .select(
        "id,user_id,video_url,status,created_at,last_process_message_id,last_process_retried,last_processed_at"
      )
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

    const rows = Array.isArray(data) ? data : [];

    // Founder Edition: only sign playback URLs once a video is processed.
    // This prevents the UI from "thrashing" because signed URLs change every request.
    const videos = await Promise.all(
      rows.map(async (v: any) => {
        const statusStr = String(v.status || "");
        const shouldSign = statusStr === "processed";
        const signed = shouldSign
          ? await signPlaybackUrl(String(v.video_url || ""))
          : null;

        return {
          ...v,
          signed_url: signed,
          playback_url: signed,
        };
      })
    );

    return NextResponse.json(
      { ok: true, videos },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: "Server error", details: err?.message ?? "unknown" },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}

/**
 * POST /api/wardrobe-videos
 * Modes:
 * 1) Upload (multipart/form-data): expects `video` File.
 * 2) Process action (JSON): { action:"process", wardrobe_video_id|video_id, ...optional params }
 * 3) Create row (JSON): { video_url, auto_process? } (internal/testing)
 */
export async function POST(req: NextRequest) {
  const supabase = getSupabaseServerClient();

  try {
    const contentType = asString(req.headers.get("content-type"));

    // 1) MULTIPART upload
    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("video");

      if (!(file instanceof File)) {
        return NextResponse.json(
          { ok: false, error: "Missing video file" },
          { status: 400, headers: { "Cache-Control": "no-store" } }
        );
      }

      // Basic safety checks (also validated client-side)
      const sizeMb = file.size / (1024 * 1024);
      if (!Number.isFinite(sizeMb) || sizeMb <= 0) {
        return NextResponse.json(
          { ok: false, error: "Invalid video file" },
          { status: 400, headers: { "Cache-Control": "no-store" } }
        );
      }

      // Build storage path
      const ext = (file.name.split(".").pop() || "mp4").toLowerCase();
      const safeExt = /^[a-z0-9]+$/.test(ext) ? ext : "mp4";
      const filename = `${Date.now()}-${Math.random().toString(16).slice(2)}.${safeExt}`;
      const storagePath = `${FOUNDER_USER_ID}/${filename}`;

      // Upload to Supabase Storage
      const { error: uploadErr } = await supabase
        .storage
        .from(WARDROBE_VIDEOS_BUCKET)
        .upload(storagePath, file, {
          cacheControl: "3600",
          upsert: false,
          contentType: file.type || "video/mp4",
        });

      if (uploadErr) {
        return NextResponse.json(
          {
            ok: false,
            error: "Video upload failed",
            details: uploadErr.message,
          },
          { status: 500, headers: { "Cache-Control": "no-store" } }
        );
      }

      // Create DB row immediately
      const { data: row, error: insertErr } = await supabase
        .from("wardrobe_videos")
        .insert({
          user_id: FOUNDER_USER_ID,
          video_url: storagePath,
          status: "uploaded",
        })
        .select(
          "id,user_id,video_url,status,created_at,last_process_message_id,last_process_retried,last_processed_at"
        )
        .single();

      if (insertErr || !row) {
        // Best effort: delete the uploaded file if DB write fails
        try {
          await supabase.storage.from(WARDROBE_VIDEOS_BUCKET).remove([storagePath]);
        } catch {
          // ignore
        }

        return NextResponse.json(
          {
            ok: false,
            error: "Failed to create video row",
            details: insertErr?.message ?? "unknown",
          },
          { status: 500, headers: { "Cache-Control": "no-store" } }
        );
      }

      // Return a signed playback URL (optional)
      const signed_url = await signPlaybackUrl(storagePath);

      // Try to enqueue immediately (upload success does NOT depend on enqueue success)
      const baseUrl = getBaseUrl(req);
      const enq = await enqueueProcessJob({ wardrobeVideoId: row.id, baseUrl });

      if (!enq.ok) {
        // Upload success must not depend on processing completion.
        // If enqueue fails (misconfig / transient), keep the row `uploaded` so the user can retry.
        await safeUpdateWardrobeVideo(supabase, row.id, {
          status: "uploaded",
          last_process_message_id: null,
          last_process_retried: true,
        });
        console.error("[wardrobe-videos] enqueue failed", {
          target_url: (enq as any)?.target_url,
          qstash_error: (enq as any)?.qstash_error,
          body: (enq as any)?.body,
          status: (enq as any)?.status,
        });
      } else {
        const msgId = pickMessageIdFromEnqueue(
          enq,
          `dedupe:${(enq as any).dedupe_id || row.id}`
        );
        await safeUpdateWardrobeVideo(supabase, row.id, {
          status: "processing",
          last_process_message_id: msgId,
          last_process_retried: false,
        });
      }

      // Return the freshest row
      const { data: fresh } = await supabase
        .from("wardrobe_videos")
        .select(
          "id,user_id,video_url,status,created_at,last_process_message_id,last_process_retried,last_processed_at"
        )
        .eq("id", row.id)
        .eq("user_id", FOUNDER_USER_ID)
        .single();

      return NextResponse.json(
        {
          ok: true,
          wardrobe_video_id: row.id,
          video: fresh ?? row,
          signed_url,
          enqueued: enq,
        },
        { status: 200, headers: { "Cache-Control": "no-store" } }
      );
    }

    // 2/3) JSON body
    const body = (await req.json().catch(() => ({}))) as
      | CreateBody
      | ProcessActionBody;

    // PROCESS action
    if ((body as any)?.action === "process") {
      const b = body as ProcessActionBody;
      const videoId = asString(b.wardrobe_video_id || b.video_id);

      if (!videoId) {
        return NextResponse.json(
          { ok: false, error: "Missing video_id" },
          { status: 400, headers: { "Cache-Control": "no-store" } }
        );
      }

      const { data: video, error: loadErr } = await supabase
        .from("wardrobe_videos")
        .select(
          "id,user_id,status,video_url,created_at,last_process_message_id,last_process_retried,last_processed_at"
        )
        .eq("id", videoId)
        .eq("user_id", FOUNDER_USER_ID)
        .single();

      if (loadErr || !video) {
        return NextResponse.json(
          {
            ok: false,
            error: "Video not found",
            details: loadErr?.message ?? "missing row",
          },
          { status: 404, headers: { "Cache-Control": "no-store" } }
        );
      }

      if (video.status === "processed") {
        return NextResponse.json(
          { ok: true, wardrobe_video: video, message: "Already processed" },
          { status: 200, headers: { "Cache-Control": "no-store" } }
        );
      }

      // Retry-safe: if a job is already in-flight and we have its message id, don't enqueue another.
      // Exception: if the job looks stuck (processing for >2 minutes with no completion), allow a re-enqueue.
      const existingMsgId = asString((video as any).last_process_message_id);
      const createdAtMs = (() => {
        const raw = (video as any).created_at;
        if (!raw) return null;
        const ms = Date.parse(String(raw));
        return Number.isFinite(ms) ? ms : null;
      })();
      const isStuck =
        String(video.status) === "processing" &&
        !((video as any).last_processed_at) &&
        createdAtMs != null &&
        Date.now() - createdAtMs > 2 * 60 * 1000;

      const force = Boolean((b as any).force) || isStuck;

      if (video.status === "processing" && existingMsgId && !force) {
        return NextResponse.json(
          {
            ok: true,
            wardrobe_video_id: video.id,
            status: "processing" as const,
            job_id: existingMsgId,
            message_id: existingMsgId,
            last_process_message_id: existingMsgId,
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
        dedupeSuffix: force ? `retry:${Math.floor(Date.now() / 60000)}` : undefined,
      });

      // If enqueue failed, do NOT leave the row in `processing`.
      if (!enqueue.ok) {
        // Enqueue failure is a trigger/config issue, not a processing failure.
        // Move back to `uploaded` so the UI does not poll forever.
        const nextStatus: Status = "uploaded";

        const upd = await safeUpdateWardrobeVideo(supabase, video.id, {
          status: nextStatus,
          last_process_message_id: null,
          last_process_retried: true,
        });

        return NextResponse.json(
          {
            ok: false,
            wardrobe_video_id: video.id,
            wardrobe_video: { ...video, status: nextStatus },
            status: nextStatus,
            job_id: null,
            message_id: null,
            last_process_message_id: null,
            last_process_retried: true,
            last_processed_at: (video as any).last_processed_at ?? null,
            enqueued: enqueue,
            update_error: (upd as any).error ?? null,
            error: "Failed to enqueue processing job",
            error_details:
              (enqueue as any)?.qstash_error?.body ||
              (enqueue as any)?.body ||
              "Check QStash configuration and environment variables.",
            qstash_error: (enqueue as any)?.qstash_error ?? null,
            qstash_target_url: (enqueue as any)?.target_url ?? null,
          },
          { status: 200, headers: { "Cache-Control": "no-store" } }
        );
      }

      const messageId = pickMessageIdFromEnqueue(
        enqueue,
        `dedupe:${(enqueue as any).dedupe_id || video.id}`
      );
      const wasRetry =
        video.status === "failed" ||
        Boolean(video.last_process_message_id) ||
        Boolean((video as any).last_process_retried) ||
        force;

      // Move to processing and stamp traceability.
      const upd2 = await safeUpdateWardrobeVideo(supabase, video.id, {
        status: "processing",
        last_process_message_id: messageId,
        last_process_retried: wasRetry,
      });
      if ((upd2 as any)?.error) {
        console.error("[wardrobe-videos] failed to update row to processing", {
          wardrobe_video_id: video.id,
          error: (upd2 as any).error,
        });
      }

      const { data: updatedVideo } = await supabase
        .from("wardrobe_videos")
        .select(
          "id,user_id,video_url,status,created_at,last_process_message_id,last_process_retried,last_processed_at"
        )
        .eq("id", video.id)
        .eq("user_id", FOUNDER_USER_ID)
        .single();

      return NextResponse.json(
        {
          ok: true,
          wardrobe_video_id: video.id,
          wardrobe_video: updatedVideo ?? null,
          status: (updatedVideo?.status ?? "processing") as any,
          job_id:
            (updatedVideo as any)?.last_process_message_id ?? messageId,
          message_id:
            (updatedVideo as any)?.last_process_message_id ?? messageId,
          last_process_message_id:
            (updatedVideo as any)?.last_process_message_id ?? messageId,
          last_process_retried:
            (updatedVideo as any)?.last_process_retried ?? wasRetry,
          last_processed_at: (updatedVideo as any)?.last_processed_at ?? null,
          enqueued: enqueue,
          update_error: (upd2 as any).error ?? null,
        },
        { status: 200, headers: { "Cache-Control": "no-store" } }
      );
    }

    // CREATE row (JSON) - primarily for internal/testing
    const create = body as CreateBody;
    const videoUrl = asString(create.video_url);

    if (!videoUrl) {
      return NextResponse.json(
        { ok: false, error: "Missing video_url" },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    const { data: row, error: insertErr } = await supabase
      .from("wardrobe_videos")
      .insert({
        user_id: FOUNDER_USER_ID,
        video_url: videoUrl,
        status: "uploaded",
      })
      .select(
        "id,user_id,video_url,status,created_at,last_process_message_id,last_process_retried,last_processed_at"
      )
      .single();

    if (insertErr || !row) {
      return NextResponse.json(
        {
          ok: false,
          error: "Failed to create video row",
          details: insertErr?.message ?? "unknown",
        },
        { status: 500, headers: { "Cache-Control": "no-store" } }
      );
    }

    return NextResponse.json(
      { ok: true, wardrobe_video: row },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: "Server error", details: err?.message ?? "unknown" },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}