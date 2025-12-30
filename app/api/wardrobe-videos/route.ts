// app/api/wardrobe-videos/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

// Founder Edition: single-user scope
const FOUNDER_USER_ID =
  process.env.FOUNDER_USER_ID ?? "00000000-0000-0000-0000-000000000001";

// Storage bucket (override in env if your bucket name differs)
const WARDROBE_VIDEOS_BUCKET =
  process.env.WARDROBE_VIDEOS_BUCKET ?? "wardrobe-videos";

function getSupabaseAdminClient() {
  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL ??
    process.env.SUPABASE_URL ??
    "";

  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_SERVICE_KEY ??
    "";

  if (!url || !serviceKey) {
    throw new Error(
      "Missing Supabase env. Set NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY."
    );
  }

  // Service role key is safe here because this code runs server-side only.
  return createClient(url, serviceKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

type VideoRow = {
  id: string;
  user_id: string;
  status: string;
  video_url: string;
  created_at: string;
  last_process_message_id?: string | null;
  last_process_retried?: number | null;
  last_processed_at?: string | null;
};

type ProcessActionBody = {
  action: "process";
  wardrobe_video_id?: string;
  video_id?: string;
  sample_every_seconds?: number;
  max_frames?: number;
  max_width?: number;
  max_candidates?: number;
};

type CreateBody = {
  // Optional alternative to multipart upload
  video_url?: string;
  auto_process?: boolean;
};

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function stripWrappingQuotes(s: string) {
  const t = (s ?? "").trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1).trim();
  }
  return t;
}

function removeNonPrintable(s: string) {
  // Remove hidden/newline/non-printable chars that can break URL parsing.
  return (s ?? "").replace(/[\u0000-\u001F\u007F]+/g, "");
}

function sanitizeUrlLike(s: string) {
  return removeNonPrintable(stripWrappingQuotes(String(s ?? ""))).trim();
}

function sanitizeOrigin(s: string) {
  const t = sanitizeUrlLike(s);
  // Remove trailing slash to keep `new URL(path, origin)` predictable.
  return t.replace(/\/+$/, "");
}

function clampInt(v: unknown, fallback: number, min: number, max: number) {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function getAbsoluteUrl(req: NextRequest, path: string) {
  // Prefer Next.js' parsed URL when it includes a real scheme.
  const origin = req.nextUrl?.origin;
  if (origin && /^https?:\/\//i.test(origin)) {
    return new URL(path, origin).toString();
  }

  // Otherwise derive from forwarded headers (Vercel) or env.
  const protoRaw = req.headers.get("x-forwarded-proto") ?? "https";
  const proto = (protoRaw.split(",")[0].trim() || "https").replace(/:$/, "");

  const hostHeader =
    (req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "")
      .split(",")[0]
      .trim();

  // If you provide an explicit site URL, it must include the scheme.
  const envOrigin = sanitizeOrigin(process.env.NEXT_PUBLIC_SITE_URL ?? process.env.SITE_URL ?? "");
  if (envOrigin && /^https?:\/\//i.test(envOrigin)) {
    return new URL(path, envOrigin).toString();
  }

  // VERCEL_URL typically has no scheme.
  const envHost = sanitizeUrlLike(process.env.VERCEL_URL ?? "").replace(/^https?:\/\//i, "");

  const host = hostHeader || envHost || "localhost:3000";
  return new URL(path, `${proto}://${host}`).toString();
}

function isConfiguredQStash() {
  return !!process.env.QSTASH_TOKEN;
}

function qstashPublishUrl(targetUrl: string, mode: "raw" | "encoded" = "raw") {
  const t = sanitizeUrlLike(targetUrl);
  // QStash REST publish uses the destination URL as a path segment.
  // Most examples show it unencoded, but some environments/proxies can mangle `://` inside a path.
  // So we keep the default as raw and optionally fall back to an encoded form.
  const dest = mode === "encoded" ? encodeURIComponent(t) : t;
  return `https://qstash.upstash.io/v2/publish/${dest}`;
}

function safeDedupeId(raw: string) {
  // QStash DeduplicationId cannot contain ':' (and keeping it url/header safe is best).
  // Allow only alnum, '-', '_' and '.'
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return cleaned.slice(0, 190);
}

async function attachSignedUrl(
  supabase: ReturnType<typeof getSupabaseAdminClient>,
  row: VideoRow,
  expiresInSeconds = 60 * 60
) {
  const path = asString(row.video_url);
  if (!path) return { ...row, signed_url: null, playback_url: null };

  const { data, error } = await supabase.storage
    .from(WARDROBE_VIDEOS_BUCKET)
    .createSignedUrl(path, expiresInSeconds);

  const signedUrl = error ? null : (data?.signedUrl ?? null);
  return {
    ...row,
    signed_url: signedUrl,
    playback_url: signedUrl,
  };
}

async function enqueueProcessJob(args: {
  req: NextRequest;
  wardrobeVideoId: string;
  sampleEverySeconds: number;
  maxFrames: number;
  maxWidth: number;
  maxCandidates: number;
}) {
  const { req, wardrobeVideoId, sampleEverySeconds, maxFrames, maxWidth, maxCandidates } = args;

  const targetUrl = sanitizeUrlLike(getAbsoluteUrl(req, "/api/wardrobe-videos/process"));
  if (!/^https?:\/\//i.test(targetUrl)) {
    return {
      ok: false,
      enqueued: false,
      target_url: targetUrl,
      dedupe_id: null,
      message_id: null,
      details: "Invalid destination URL (missing http/https scheme).",
    };
  }
  const payload = {
    wardrobe_video_id: wardrobeVideoId,
    sample_every_seconds: sampleEverySeconds,
    max_frames: maxFrames,
    max_width: maxWidth,
    max_candidates: maxCandidates,
  };

  // If QStash isn't configured, fall back to direct call (dev-friendly).
  if (!isConfiguredQStash()) {
    const res = await fetch(targetUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
    }).catch(() => null);

    const ok = !!res?.ok;
    return {
      ok,
      enqueued: false,
      target_url: targetUrl,
      dedupe_id: null,
      message_id: null,
      details: ok ? "Processed directly (QStash not configured)." : "Direct process call failed.",
    };
  }

  const dedupeId = safeDedupeId(
    `wardrobe_video-${wardrobeVideoId}-process-${sampleEverySeconds}-${maxFrames}-${maxWidth}-${maxCandidates}`
  );

  const maxRetries = String(clampInt(process.env.QSTASH_MAX_RETRIES, 3, 0, 3));
  const timeoutSeconds = clampInt(process.env.QSTASH_TIMEOUT_SECONDS, 120, 1, 300);

  const headers = {
    Authorization: `Bearer ${process.env.QSTASH_TOKEN}`,
    "Content-Type": "application/json",
    // QStash controls
    "Upstash-Method": "POST",
    "Upstash-Content-Type": "application/json",
    "Upstash-Deduplication-Id": dedupeId,
    "Upstash-Retries": maxRetries,
    "Upstash-Timeout": `${timeoutSeconds}s`,
  } as Record<string, string>;

  // First attempt: raw destination in the path (matches Upstash docs).
  const publishUrlRaw = qstashPublishUrl(targetUrl, "raw");
  let res = await fetch(publishUrlRaw, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    cache: "no-store",
  });

  let body: any = await res.json().catch(() => ({}));

  // Fallback: if something in the HTTP stack mangles `://` inside the path,
  // try an encoded destination. This only triggers on the specific "invalid scheme" error.
  if (
    !res.ok &&
    res.status === 400 &&
    typeof body?.error === "string" &&
    /invalid destination url/i.test(body.error) &&
    /invalid scheme/i.test(body.error)
  ) {
    const publishUrlEncoded = qstashPublishUrl(targetUrl, "encoded");
    res = await fetch(publishUrlEncoded, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      cache: "no-store",
    });
    body = await res.json().catch(() => ({}));

    if (res.ok) {
      return {
        ok: true,
        enqueued: true,
        target_url: targetUrl,
        dedupe_id: dedupeId,
        message_id: body?.messageId ?? body?.message_id ?? null,
        qstash_response: { ...body, _publish_mode: "encoded" },
      };
    }

    return {
      ok: false,
      enqueued: false,
      target_url: targetUrl,
      dedupe_id: dedupeId,
      message_id: null,
      qstash_error: {
        status: res.status,
        body,
        publish_url_raw: publishUrlRaw,
        publish_url_encoded: publishUrlEncoded,
      },
      details: body?.error ?? "Failed to enqueue processing job",
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      enqueued: false,
      target_url: targetUrl,
      dedupe_id: dedupeId,
      message_id: null,
      qstash_error: { status: res.status, body, publish_url: publishUrlRaw },
      details: body?.error ?? "Failed to enqueue processing job",
    };
  }

  return {
    ok: true,
    enqueued: true,
    target_url: targetUrl,
    dedupe_id: dedupeId,
    message_id: body?.messageId ?? body?.message_id ?? null,
    qstash_response: { ...body, _publish_mode: "raw" },
  };
}

export async function GET(_req: NextRequest) {
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
      return NextResponse.json(
        { ok: false, error: "Failed to load video history", details: error.message },
        { status: 500, headers: { "Cache-Control": "no-store", Allow: "GET,POST,OPTIONS" } }
      );
    }

    const rows = (Array.isArray(data) ? data : []) as VideoRow[];
    const withUrls = await Promise.all(rows.map((r) => attachSignedUrl(supabase, r)));

    return NextResponse.json(
      { ok: true, videos: withUrls },
      { status: 200, headers: { "Cache-Control": "no-store", Allow: "GET,POST,OPTIONS" } }
    );
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: "Server error", details: err?.message ?? "unknown" },
      { status: 500, headers: { "Cache-Control": "no-store", Allow: "GET,POST,OPTIONS" } }
    );
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Cache-Control": "no-store",
      Allow: "GET,POST,OPTIONS",
    },
  });
}

export async function POST(req: NextRequest) {
  try {
    const contentType = req.headers.get("content-type") ?? "";
    const supabase = getSupabaseAdminClient();

    // 1) Multipart upload (UI uses this)
    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("video");

      const isFileLike =
        !!file && typeof (file as any).arrayBuffer === "function" && typeof (file as any).name === "string";

      if (!isFileLike) {
        return NextResponse.json(
          { ok: false, error: "Missing video file (field name must be 'video')" },
          { status: 400, headers: { "Cache-Control": "no-store", Allow: "GET,POST,OPTIONS" } }
        );
      }

      const f = file as any as File;
      const ext = (f.name.split(".").pop() || "mp4").toLowerCase();
      const path = `${FOUNDER_USER_ID}/${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`;

      const bytes = Buffer.from(await f.arrayBuffer());

      const { error: uploadErr } = await supabase.storage
        .from(WARDROBE_VIDEOS_BUCKET)
        .upload(path, bytes, {
          cacheControl: "3600",
          upsert: false,
          contentType: f.type || "video/mp4",
        });

      if (uploadErr) {
        return NextResponse.json(
          { ok: false, error: "Video upload failed", details: uploadErr.message },
          { status: 500, headers: { "Cache-Control": "no-store", Allow: "GET,POST,OPTIONS" } }
        );
      }

      const { data: inserted, error: insertErr } = await supabase
        .from("wardrobe_videos")
        .insert({
          user_id: FOUNDER_USER_ID,
          status: "uploaded",
          video_url: path,
        })
        .select(
          "id,user_id,status,video_url,created_at,last_process_message_id,last_process_retried,last_processed_at"
        )
        .single();

      if (insertErr || !inserted) {
        return NextResponse.json(
          { ok: false, error: "Failed to create wardrobe video row", details: insertErr?.message },
          { status: 500, headers: { "Cache-Control": "no-store", Allow: "GET,POST,OPTIONS" } }
        );
      }

      const withUrl = await attachSignedUrl(supabase, inserted as VideoRow);

      return NextResponse.json(
        {
          ok: true,
          signed_url: (withUrl as any).signed_url ?? null,
          wardrobe_video: withUrl,
          video: withUrl,
        },
        { status: 200, headers: { "Cache-Control": "no-store", Allow: "GET,POST,OPTIONS" } }
      );
    }

    // 2) JSON body actions (process)
    const body = (await req.json().catch(() => ({}))) as Partial<ProcessActionBody & CreateBody>;

    if (body?.action === "process") {
      const wardrobeVideoId = asString(body.wardrobe_video_id || body.video_id);
      if (!wardrobeVideoId) {
        return NextResponse.json(
          { ok: false, error: "Missing wardrobe_video_id" },
          { status: 400, headers: { "Cache-Control": "no-store", Allow: "GET,POST,OPTIONS" } }
        );
      }

      // Params accepted for traceability / future processing
      const sampleEverySeconds = clampInt(body.sample_every_seconds, 3, 1, 10);
      const maxFrames = clampInt(body.max_frames, 20, 1, 240);
      const maxWidth = clampInt(body.max_width, 900, 240, 2048);
      const maxCandidates = clampInt(body.max_candidates, 12, 1, 50);

      // Load row
      const { data: row, error: loadErr } = await supabase
        .from("wardrobe_videos")
        .select(
          "id,user_id,status,video_url,created_at,last_process_message_id,last_process_retried,last_processed_at"
        )
        .eq("id", wardrobeVideoId)
        .eq("user_id", FOUNDER_USER_ID)
        .single();

      if (loadErr || !row) {
        return NextResponse.json(
          { ok: false, error: "Video not found", details: loadErr?.message ?? "missing row" },
          { status: 404, headers: { "Cache-Control": "no-store", Allow: "GET,POST,OPTIONS" } }
        );
      }

      // Mark processing (idempotent)
      if (String(row.status) !== "processing") {
        await supabase
          .from("wardrobe_videos")
          .update({ status: "processing" })
          .eq("id", row.id)
          .eq("user_id", FOUNDER_USER_ID);
      }

      const enqueued = await enqueueProcessJob({
        req,
        wardrobeVideoId: row.id,
        sampleEverySeconds,
        maxFrames,
        maxWidth,
        maxCandidates,
      });

      // Persist message id if present
      if (enqueued?.message_id) {
        await supabase
          .from("wardrobe_videos")
          .update({
            last_process_message_id: enqueued.message_id,
            last_process_retried: 0,
          })
          .eq("id", row.id)
          .eq("user_id", FOUNDER_USER_ID);
      }

      const { data: updated } = await supabase
        .from("wardrobe_videos")
        .select(
          "id,user_id,status,video_url,created_at,last_process_message_id,last_process_retried,last_processed_at"
        )
        .eq("id", row.id)
        .eq("user_id", FOUNDER_USER_ID)
        .single();

      const withUrl = updated ? await attachSignedUrl(supabase, updated as VideoRow) : null;

      return NextResponse.json(
        {
          ok: !!enqueued?.ok,
          status: (updated as any)?.status ?? row.status,
          wardrobe_video_id: row.id,
          wardrobe_video: withUrl ?? row,
          job_id: enqueued?.message_id ?? null,
          message_id: enqueued?.message_id ?? null,
          last_process_message_id: (updated as any)?.last_process_message_id ?? null,
          last_process_retried: (updated as any)?.last_process_retried ?? null,
          last_processed_at: (updated as any)?.last_processed_at ?? null,
          enqueued,
          qstash_target_url: enqueued?.target_url ?? null,
          qstash_error: (enqueued as any)?.qstash_error ?? null,
          error: enqueued?.ok ? null : (enqueued as any)?.details ?? "Failed to enqueue processing job",
          error_details: !enqueued?.ok ? JSON.stringify((enqueued as any)?.qstash_error ?? {}) : null,
        },
        { status: enqueued?.ok ? 200 : 500, headers: { "Cache-Control": "no-store", Allow: "GET,POST,OPTIONS" } }
      );
    }

    // 3) Optional JSON create (if you ever want to create a row without uploading here)
    const videoUrl = asString((body as CreateBody)?.video_url);
    if (!videoUrl) {
      return NextResponse.json(
        { ok: false, error: "Unsupported request. Use multipart upload or {action:'process'}" },
        { status: 400, headers: { "Cache-Control": "no-store", Allow: "GET,POST,OPTIONS" } }
      );
    }

    const { data: inserted, error: insertErr } = await supabase
      .from("wardrobe_videos")
      .insert({
        user_id: FOUNDER_USER_ID,
        status: "uploaded",
        video_url: videoUrl,
      })
      .select(
        "id,user_id,status,video_url,created_at,last_process_message_id,last_process_retried,last_processed_at"
      )
      .single();

    if (insertErr || !inserted) {
      return NextResponse.json(
        { ok: false, error: "Failed to create wardrobe video row", details: insertErr?.message },
        { status: 500, headers: { "Cache-Control": "no-store", Allow: "GET,POST,OPTIONS" } }
      );
    }

    const withUrl = await attachSignedUrl(supabase, inserted as VideoRow);

    return NextResponse.json(
      { ok: true, wardrobe_video: withUrl, video: withUrl },
      { status: 200, headers: { "Cache-Control": "no-store", Allow: "GET,POST,OPTIONS" } }
    );
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: "Server error", details: err?.message ?? "unknown" },
      { status: 500, headers: { "Cache-Control": "no-store", Allow: "GET,POST,OPTIONS" } }
    );
  }
}