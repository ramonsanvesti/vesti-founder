// app/api/wardrobe-videos/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const RESPONSE_HEADERS = { "Cache-Control": "no-store", Allow: "GET,POST,OPTIONS" } as const;

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
  last_process_error?: string | null;
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
  return typeof process.env.QSTASH_TOKEN === "string" && process.env.QSTASH_TOKEN.trim().length > 0;
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
  // Keep deterministic and header-safe; Upstash commonly enforces short dedupe IDs.
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return cleaned.length <= 64 ? cleaned : cleaned.slice(0, 64);
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

  // If QStash isn't configured, NEVER process inline in production.
  if (!isConfiguredQStash()) {
    if (process.env.NODE_ENV === "production") {
      return {
        ok: false,
        enqueued: false,
        target_url: targetUrl,
        dedupe_id: null,
        message_id: null,
        details: "QStash is not configured in production.",
      };
    }

    // Dev-friendly fallback: allow direct processing when not in production.
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
      details: ok ? "Processed directly (dev; QStash not configured)." : "Direct process call failed (dev).",
    };
  }

  // Anti-loop: dedupe per video id (not per params) so repeated calls don't enqueue new messages.
  const dedupeId = safeDedupeId(`wardrobe_video_${wardrobeVideoId}_process`);

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
        "id,user_id,status,video_url,created_at,last_process_message_id,last_process_retried,last_processed_at,last_process_error"
      )
      .eq("user_id", FOUNDER_USER_ID)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) {
      return NextResponse.json(
        { ok: false, error: "Failed to load video history", details: error.message },
        { status: 500, headers: RESPONSE_HEADERS }
      );
    }

    const rows = (Array.isArray(data) ? data : []) as VideoRow[];
    const withUrls = await Promise.all(rows.map((r) => attachSignedUrl(supabase, r)));

    return NextResponse.json(
      { ok: true, videos: withUrls },
      { status: 200, headers: RESPONSE_HEADERS }
    );
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: "Server error", details: err?.message ?? "unknown" },
      { status: 500, headers: RESPONSE_HEADERS }
    );
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: RESPONSE_HEADERS,
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
          { status: 400, headers: RESPONSE_HEADERS }
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
          { status: 500, headers: RESPONSE_HEADERS }
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
          "id,user_id,status,video_url,created_at,last_process_message_id,last_process_retried,last_processed_at,last_process_error"
        )
        .single();

      if (insertErr || !inserted) {
        return NextResponse.json(
          { ok: false, error: "Failed to create wardrobe video row", details: insertErr?.message },
          { status: 500, headers: RESPONSE_HEADERS }
        );
      }

      // Automatically enqueue processing by default (async via QStash)
      const enqueued = await enqueueProcessJob({
        req,
        wardrobeVideoId: inserted.id,
        sampleEverySeconds: 3,
        maxFrames: 20,
        maxWidth: 900,
        maxCandidates: 12,
      });

      // Mark as processing ONLY if the job was accepted/enqueued.
      if (enqueued.ok && enqueued.enqueued) {
        const { data: updatedRow } = await supabase
          .from("wardrobe_videos")
          .update({
            status: "processing",
            last_process_message_id: enqueued.message_id,
            last_process_retried: 0,
            last_process_error: null,
          })
          .eq("id", inserted.id)
          .eq("user_id", FOUNDER_USER_ID)
          .eq("status", "uploaded")
          .select(
            "id,user_id,status,video_url,created_at,last_process_message_id,last_process_retried,last_processed_at,last_process_error"
          )
          .single();

        if (updatedRow) {
          (inserted as any).status = (updatedRow as any).status;
          (inserted as any).last_process_message_id = (updatedRow as any).last_process_message_id;
          (inserted as any).last_process_retried = (updatedRow as any).last_process_retried;
        } else {
          (inserted as any).status = "processing";
        }
      }

      const withUrl = await attachSignedUrl(supabase, inserted as VideoRow);

      return NextResponse.json(
        {
          ok: true,
          wardrobe_video_id: (withUrl as any).id,
          signed_url: (withUrl as any).signed_url ?? null,
          wardrobe_video: withUrl,
          video: withUrl,
          status: (withUrl as any)?.status ?? "uploaded",
          enqueued: (withUrl as any)?.status === "processing",
          message_id: (withUrl as any)?.last_process_message_id ?? null,
          enqueue: enqueued,
        },
        {
          status: (withUrl as any)?.status === "processing" ? 202 : 201,
          headers: RESPONSE_HEADERS,
        }
      );
    }

    // 2) JSON body actions (process)
    const body = (await req.json().catch(() => ({}))) as Partial<ProcessActionBody & CreateBody>;

    if (body?.action === "process") {
      const wardrobeVideoId = asString(body.wardrobe_video_id || body.video_id);
      if (!wardrobeVideoId) {
        return NextResponse.json(
          { ok: false, error: "Missing wardrobe_video_id" },
          { status: 400, headers: RESPONSE_HEADERS }
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
          "id,user_id,status,video_url,created_at,last_process_message_id,last_process_retried,last_processed_at,last_process_error"
        )
        .eq("id", wardrobeVideoId)
        .eq("user_id", FOUNDER_USER_ID)
        .single();

      if (loadErr || !row) {
        return NextResponse.json(
          { ok: false, error: "Video not found", details: loadErr?.message ?? "missing row" },
          { status: 404, headers: RESPONSE_HEADERS }
        );
      }

      const currentStatus = String((row as any).status);

      // Anti-loop: if already processing (and we have a message id), do NOT enqueue again.
      if (currentStatus === "processing" && (row as any).last_process_message_id) {
        const withUrl = await attachSignedUrl(supabase, row as VideoRow);
        return NextResponse.json(
          {
            ok: true,
            status: currentStatus,
            enqueued: false,
            reason: "already_processing",
            wardrobe_video_id: row.id,
            wardrobe_video: withUrl,
            message_id: (row as any).last_process_message_id,
          },
          { status: 200, headers: RESPONSE_HEADERS }
        );
      }

      // Anti-loop: if already processed, acknowledge idempotently.
      if (currentStatus === "processed") {
        const withUrl = await attachSignedUrl(supabase, row as VideoRow);
        return NextResponse.json(
          {
            ok: true,
            status: currentStatus,
            enqueued: false,
            reason: "already_processed",
            wardrobe_video_id: row.id,
            wardrobe_video: withUrl,
            message_id: (row as any).last_process_message_id ?? null,
          },
          { status: 200, headers: RESPONSE_HEADERS }
        );
      }

      const enqueued = await enqueueProcessJob({
        req,
        wardrobeVideoId: row.id,
        sampleEverySeconds,
        maxFrames,
        maxWidth,
        maxCandidates,
      });

      // Mark processing ONLY if job was accepted/enqueued, and only transition from allowed states.
      if (enqueued.ok && enqueued.enqueued) {
        await supabase
          .from("wardrobe_videos")
          .update({
            status: "processing",
            last_process_message_id: enqueued.message_id,
            last_process_retried: 0,
            last_process_error: null,
          })
          .eq("id", row.id)
          .eq("user_id", FOUNDER_USER_ID)
          .in("status", ["uploaded", "failed", "processing"])
          .neq("status", "processed");
      }

      const { data: updated } = await supabase
        .from("wardrobe_videos")
        .select(
          "id,user_id,status,video_url,created_at,last_process_message_id,last_process_retried,last_processed_at,last_process_error"
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
        { status: enqueued?.ok && enqueued?.enqueued ? 202 : 200, headers: RESPONSE_HEADERS }
      );
    }

    // 3) Optional JSON create (if you ever want to create a row without uploading here)
    const videoUrl = asString((body as CreateBody)?.video_url);
    if (!videoUrl) {
      return NextResponse.json(
        { ok: false, error: "Unsupported request. Use multipart upload or {action:'process'}" },
        { status: 400, headers: RESPONSE_HEADERS }
      );
    }

    const autoProcess = (body as CreateBody)?.auto_process !== false;

    const { data: inserted, error: insertErr } = await supabase
      .from("wardrobe_videos")
      .insert({
        user_id: FOUNDER_USER_ID,
        status: "uploaded",
        video_url: videoUrl,
      })
      .select(
        "id,user_id,status,video_url,created_at,last_process_message_id,last_process_retried,last_processed_at,last_process_error"
      )
      .single();

    if (insertErr || !inserted) {
      return NextResponse.json(
        { ok: false, error: "Failed to create wardrobe video row", details: insertErr?.message },
        { status: 500, headers: RESPONSE_HEADERS }
      );
    }

    let enqueued: any = null;
    if (autoProcess) {
      enqueued = await enqueueProcessJob({
        req,
        wardrobeVideoId: inserted.id,
        sampleEverySeconds: 3,
        maxFrames: 20,
        maxWidth: 900,
        maxCandidates: 12,
      });

      if (enqueued.ok && enqueued.enqueued) {
        await supabase
          .from("wardrobe_videos")
          .update({
            status: "processing",
            last_process_message_id: enqueued.message_id,
            last_process_retried: 0,
            last_process_error: null,
          })
          .eq("id", inserted.id)
          .eq("user_id", FOUNDER_USER_ID)
          .eq("status", "uploaded");

        // Keep the in-memory row consistent with the DB update for the response.
        (inserted as any).status = "processing";
        (inserted as any).last_process_message_id = enqueued.message_id;
        (inserted as any).last_process_retried = 0;
      }
    }

    // Defensive: if enqueue succeeded, ensure the response row shows the processing state.
    if (enqueued?.ok && enqueued?.enqueued) {
      (inserted as any).status = (inserted as any).status || "processing";
      (inserted as any).last_process_message_id = (inserted as any).last_process_message_id ?? enqueued.message_id;
      (inserted as any).last_process_retried = (inserted as any).last_process_retried ?? 0;
    }

    const withUrl = await attachSignedUrl(supabase, inserted as VideoRow);

    return NextResponse.json(
      {
        ok: true,
        wardrobe_video_id: (withUrl as any).id,
        wardrobe_video: withUrl,
        video: withUrl,
        status: (withUrl as any)?.status ?? "uploaded",
        enqueued: (withUrl as any)?.status === "processing",
        message_id: (withUrl as any)?.last_process_message_id ?? null,
        enqueue: enqueued,
      },
      {
        status: (withUrl as any)?.status === "processing" ? 202 : 201,
        headers: RESPONSE_HEADERS,
      }
    );
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: "Server error", details: err?.message ?? "unknown" },
      { status: 500, headers: RESPONSE_HEADERS }
    );
  }
}