// app/api/wardrobe-videos/upload/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseClient.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RESPONSE_HEADERS = { "Cache-Control": "no-store", Allow: "GET,POST,OPTIONS" } as const;

// Founder Edition: replace with real auth later
const FAKE_USER_ID = "00000000-0000-0000-0000-000000000001";
// Supabase Storage bucket (private). Default matches the intended bucket name.
const BUCKET = process.env.WARDROBE_VIDEOS_BUCKET ?? "wardrobe-videos";

// Server-side hard limits (size/type). Duration (<=60s) is validated client-side in Founder Edition.
const MAX_BYTES = 50 * 1024 * 1024; // 50MB safeguard (tune later)

// Default processing parameters (Founder Edition)
const DEFAULT_SAMPLE_EVERY_SECONDS = 3;
const DEFAULT_MAX_FRAMES = 20;
const DEFAULT_MAX_WIDTH = 900;
const DEFAULT_MAX_CANDIDATES = 12;

function clampInt(v: string | undefined | null, fallback: number, min: number, max: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function stripWrappingQuotes(s: string) {
  const t = (s ?? "").trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1).trim();
  }
  return t;
}

function removeNonPrintable(s: string) {
  return (s ?? "").replace(/[\u0000-\u001F\u007F]+/g, "");
}

function sanitizeUrlLike(s: string) {
  return removeNonPrintable(stripWrappingQuotes(String(s ?? ""))).trim();
}

function sanitizeOrigin(s: string) {
  return sanitizeUrlLike(s).replace(/\/+$/, "");
}

function getAbsoluteUrl(req: NextRequest, path: string) {
  const origin = req.nextUrl?.origin;
  if (origin && /^https?:\/\//i.test(origin)) {
    return new URL(path, origin).toString();
  }

  const protoRaw = req.headers.get("x-forwarded-proto") ?? "https";
  const proto = (protoRaw.split(",")[0].trim() || "https").replace(/:$/, "");

  const hostHeader =
    (req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "")
      .split(",")[0]
      .trim();

  const envOrigin = sanitizeOrigin(process.env.NEXT_PUBLIC_SITE_URL ?? process.env.SITE_URL ?? "");
  if (envOrigin && /^https?:\/\//i.test(envOrigin)) {
    return new URL(path, envOrigin).toString();
  }

  const envHost = sanitizeUrlLike(process.env.VERCEL_URL ?? "").replace(/^https?:\/\//i, "");
  const host = hostHeader || envHost || "localhost:3000";

  return new URL(path, `${proto}://${host}`).toString();
}

function safeDedupeId(raw: string) {
  // Deterministic + header-safe. Keep short to satisfy common Upstash limits.
  // Allow only alnum, '.', '_' and '-'.
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return cleaned.length <= 64 ? cleaned : cleaned.slice(0, 64);
}

function isConfiguredQStash() {
  return typeof process.env.QSTASH_TOKEN === "string" && process.env.QSTASH_TOKEN.trim().length > 0;
}

function qstashPublishUrl(targetUrl: string, mode: "raw" | "encoded" = "raw") {
  const t = sanitizeUrlLike(targetUrl);
  const dest = mode === "encoded" ? encodeURIComponent(t) : t;
  return `https://qstash.upstash.io/v2/publish/${dest}`;
}

async function enqueueProcessJob(req: NextRequest, wardrobeVideoId: string) {
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

  if (!isConfiguredQStash()) {
    // Best practice: never run processing inline in production.
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

    return {
      ok: false,
      enqueued: false,
      target_url: targetUrl,
      dedupe_id: null,
      message_id: null,
      details: "QStash is not configured (dev).",
    };
  }

  const payload = {
    wardrobe_video_id: wardrobeVideoId,
    sample_every_seconds: DEFAULT_SAMPLE_EVERY_SECONDS,
    max_frames: DEFAULT_MAX_FRAMES,
    max_width: DEFAULT_MAX_WIDTH,
    max_candidates: DEFAULT_MAX_CANDIDATES,
  };

  const dedupeId = safeDedupeId(`wardrobe_video_${wardrobeVideoId}_process`);
  const maxRetries = String(clampInt(process.env.QSTASH_MAX_RETRIES, 3, 0, 3));
  const timeoutSeconds = clampInt(process.env.QSTASH_TIMEOUT_SECONDS, 120, 1, 300);

  const headers = {
    Authorization: `Bearer ${process.env.QSTASH_TOKEN}`,
    "Content-Type": "application/json",
    "Upstash-Method": "POST",
    "Upstash-Content-Type": "application/json",
    "Upstash-Deduplication-Id": dedupeId,
    "Upstash-Retries": maxRetries,
    "Upstash-Timeout": `${timeoutSeconds}s`,
  } as Record<string, string>;

  const publishUrlRaw = qstashPublishUrl(targetUrl, "raw");
  let res = await fetch(publishUrlRaw, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    cache: "no-store",
  });

  let body: any = await res.json().catch(() => ({}));

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
      qstash_error: { status: res.status, body, publish_url_raw: publishUrlRaw, publish_url_encoded: publishUrlEncoded },
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

function safeExtFromMime(mime: string) {
  const m = (mime || "").toLowerCase();
  if (m.includes("mp4")) return "mp4";
  if (m.includes("webm")) return "webm";
  if (m.includes("quicktime")) return "mov";
  return "mp4";
}

function randId() {
  return Math.random().toString(16).slice(2);
}

function toInt(v: string | null, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.floor(n));
}

async function signOne(
  supabase: ReturnType<typeof getSupabaseServerClient>,
  storagePath: string,
  seconds: number
) {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(storagePath, seconds);
  if (error) return { signedUrl: null as string | null, error: error.message };
  return { signedUrl: data?.signedUrl ?? null, error: null as string | null };
}

/**
 * GET /api/wardrobe-videos/upload
 * Returns user's upload history + signed URLs.
 * Query params:
 *  - limit: number (default 25)
 *  - signed_ttl: seconds (default 3600)
 */
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const limit = Math.min(toInt(url.searchParams.get("limit"), 25), 100);
    const signedTtl = Math.min(toInt(url.searchParams.get("signed_ttl"), 3600), 24 * 3600);

    const supabase = getSupabaseServerClient();

    const { data: rows, error } = await supabase
      .from("wardrobe_videos")
      .select("*")
      .eq("user_id", FAKE_USER_ID)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) {
      return NextResponse.json(
        { ok: false, error: "Failed to load wardrobe videos", details: error.message },
        { status: 500, headers: RESPONSE_HEADERS }
      );
    }

    const videos = Array.isArray(rows) ? rows : [];

    // Attach signed URLs (secure) for preview/download
    const signedMap: Record<string, string | null> = {};
    const signWarnings: string[] = [];

    const videosWithSignedUrl = [] as any[];

    for (const v of videos) {
      const storagePath = typeof (v as any)?.video_url === "string" ? (v as any).video_url : "";
      const id = String((v as any)?.id ?? "");

      if (!storagePath || !id) {
        signedMap[id] = null;
        videosWithSignedUrl.push({ ...(v as any), signed_url: null });
        continue;
      }

      const { signedUrl, error: signErr } = await signOne(supabase, storagePath, signedTtl);
      signedMap[id] = signedUrl;
      videosWithSignedUrl.push({ ...(v as any), signed_url: signedUrl });

      if (signErr) signWarnings.push(`Signed URL failed for ${id}: ${signErr}`);
    }

    return NextResponse.json(
      {
        ok: true,
        videos: videosWithSignedUrl,
        signed_urls: signedMap,
        warnings: signWarnings,
      },
      { status: 200, headers: RESPONSE_HEADERS }
    );
  } catch (err: any) {
    console.error("Error in GET /api/wardrobe-videos/upload:", err);
    return NextResponse.json(
      { ok: false, error: "Server error", details: err?.message ?? "unknown" },
      { status: 500, headers: RESPONSE_HEADERS }
    );
  }
}


export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("video");

    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { ok: false, error: "Missing 'video' file in form-data." },
        { status: 400, headers: RESPONSE_HEADERS }
      );
    }

    if (!file.type || !file.type.startsWith("video/")) {
      return NextResponse.json(
        { ok: false, error: "Uploaded file is not a video." },
        { status: 400, headers: RESPONSE_HEADERS }
      );
    }

    if (file.size > MAX_BYTES) {
      return NextResponse.json(
        {
          ok: false,
          error: `Video too large. Max ${Math.floor(MAX_BYTES / (1024 * 1024))}MB.`,
        },
        { status: 413, headers: RESPONSE_HEADERS }
      );
    }

    const supabase = getSupabaseServerClient();

    // Build storage path (one upload session = one file)
    const ext = safeExtFromMime(file.type);
    const storagePath = `${FAKE_USER_ID}/${Date.now()}-${randId()}.${ext}`;

    // Upload to Storage (bucket should be PRIVATE)
    const arrayBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    const { error: uploadErr } = await supabase.storage.from(BUCKET).upload(storagePath, bytes, {
      contentType: file.type,
      cacheControl: "3600",
      upsert: false,
    });

    if (uploadErr) {
      return NextResponse.json(
        { ok: false, error: "Upload failed", details: uploadErr.message },
        { status: 500, headers: RESPONSE_HEADERS }
      );
    }

    // Create DB row immediately with status "uploaded"
    // Store the storage path in video_url (stable). We return signed_url separately (secure).
    const { data: row, error: rowErr } = await supabase
      .from("wardrobe_videos")
      .insert({
        user_id: FAKE_USER_ID,
        video_url: storagePath,
        status: "uploaded",
      })
      .select("*")
      .single();

    if (rowErr || !row) {
      return NextResponse.json(
        { ok: false, error: "DB insert failed", details: rowErr?.message ?? "unknown" },
        { status: 500, headers: RESPONSE_HEADERS }
      );
    }

    // Automatically enqueue processing (async) and mark row as processing.
    const enqueued = await enqueueProcessJob(req, String((row as any).id));

    if (enqueued.ok && enqueued.enqueued) {
      const { data: updated } = await supabase
        .from("wardrobe_videos")
        .update({
          status: "processing",
          last_process_message_id: enqueued.message_id,
          last_process_retried: 0,
        })
        .eq("id", (row as any).id)
        .eq("user_id", FAKE_USER_ID)
        .select("*")
        .single();

      // Prefer returning updated row if available.
      if (updated) {
        (row as any).status = (updated as any).status;
        (row as any).last_process_message_id = (updated as any).last_process_message_id;
        (row as any).last_process_retried = (updated as any).last_process_retried;
      } else {
        (row as any).status = "processing";
      }
    }

    // Return secure signed URL (short-lived)
    const { data: signed, error: signErr } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(storagePath, 60 * 60); // 1 hour

    if (signErr) {
      // Upload + row exist; still succeed but warn
      return NextResponse.json(
        {
          ok: true,
          wardrobe_video_id: (row as any).id,
          wardrobe_video: row,
          video: row,
          signed_url: null,
          message_id: (row as any)?.last_process_message_id ?? null,
          status: (row as any)?.status ?? "uploaded",
          enqueued: (row as any)?.status === "processing",
          warnings: [
            `Signed URL failed: ${signErr.message}`,
            ...(enqueued?.ok ? [] : [`Enqueue failed: ${enqueued.details ?? "unknown"}`]),
          ],
          enqueue: enqueued,
        },
        { status: (row as any)?.status === "processing" ? 202 : 201, headers: RESPONSE_HEADERS }
      );
    }

    return NextResponse.json(
      {
        ok: true,
        wardrobe_video_id: (row as any).id,
        wardrobe_video: row,
        video: row,
        signed_url: signed?.signedUrl ?? null,
        message_id: (row as any)?.last_process_message_id ?? null,
        status: (row as any)?.status ?? "uploaded",
        enqueued: (row as any)?.status === "processing",
        enqueue: enqueued,
      },
      { status: (row as any)?.status === "processing" ? 202 : 201, headers: RESPONSE_HEADERS }
    );
  } catch (err: any) {
    console.error("Error in /api/wardrobe-videos/upload:", err);
    return NextResponse.json(
      { ok: false, error: "Server error", details: err?.message ?? "unknown" },
      { status: 500, headers: RESPONSE_HEADERS }
    );
  }
}