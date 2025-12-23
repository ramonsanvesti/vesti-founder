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

function getBaseUrl(req: NextRequest) {
  // Prefer explicit site URL (production), then Vercel URL, then request host
  const fromEnv =
    process.env.NEXT_PUBLIC_SITE_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");

  if (fromEnv) return fromEnv.replace(/\/$/, "");

  // req.nextUrl.protocol is usually "https:" on Vercel, but keep it safe.
  const proto = req.headers.get("x-forwarded-proto") || req.nextUrl.protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") || req.nextUrl.host;
  return `${proto}://${host}`;
}

function isConfiguredQStash() {
  // Token is required to publish.
  // Signing keys are used by the receiving endpoint to verify authenticity.
  return Boolean(process.env.QSTASH_TOKEN);
}

function qstashPublishUrl(targetUrl: string) {
  // QStash publish endpoint expects the destination URL as part of the path.
  // We keep this in one place to avoid scattering string logic.
  const encoded = encodeURIComponent(targetUrl);
  return `https://qstash.upstash.io/v2/publish/${encoded}`;
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

  const targetUrl = `${baseUrl}/api/wardrobe-videos/process`;

  // If QStash isn't configured, do a best-effort direct call (does not block response).
  if (!isConfiguredQStash()) {
    void fetch(targetUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => {});

    return { ok: true, enqueued: false, fallback: "direct_fetch" as const };
  }

  // QStash HTTP API (no SDK dependency) — retry-safe + clean dedupe.
  // Docs: https://upstash.com/docs/qstash
  const publishUrl = qstashPublishUrl(targetUrl);

  // Dedupe should collapse identical requests (retry-safe) but allow a fresh run
  // when the caller changes sampling params.
  const dedupeId = `wardrobe_video:${wardrobeVideoId}:process:${sampleEverySeconds}:${maxFrames}:${maxWidth}:${maxCandidates}`;
  const retries = 5;

  const r = await fetch(publishUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.QSTASH_TOKEN}`,
      "Content-Type": "application/json",
      // These headers control QStash behavior
      "Upstash-Method": "POST",
      "Upstash-Content-Type": "application/json",
      "Upstash-Deduplication-Id": dedupeId,
      "Upstash-Retries": String(retries),
      // Keep messages short-lived if they get stuck (seconds)
      "Upstash-Timeout": "120",
    },
    body: JSON.stringify(payload),
  });

  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    // Fallback to direct call (best effort). Do not throw: enqueue should not break upload/process UX.
    void fetch(targetUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => {});

    return {
      ok: true,
      enqueued: false,
      fallback: "direct_fetch" as const,
      qstash_error: { status: r.status, body: txt.slice(0, 500) },
    };
  }

  const qstashJson = await r.json().catch(() => null);

  return { ok: true, enqueued: true, qstash: qstashJson };
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
      .select("id,user_id,video_url,status,created_at")
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
        .select("id,user_id,status,video_url,created_at")
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

      // Retry-safe status flip:
      // - If already processing, keep it.
      // - If failed/uploaded, move to processing.
      if (video.status !== "processing") {
        // Retry-safe: only advance states that are allowed to move to processing.
        // Prevent accidental rewinds from processed.
        const { error: stErr } = await supabase
          .from("wardrobe_videos")
          .update({ status: "processing" })
          .eq("id", video.id)
          .eq("user_id", FOUNDER_USER_ID)
          .in("status", ["uploaded", "failed"]);

        if (stErr) {
          return NextResponse.json(
            { ok: false, error: "Failed to update status", details: stErr.message },
            { status: 500, headers: { "Cache-Control": "no-store" } }
          );
        }
      }

      const sampleEverySeconds = clampInt(b.sample_every_seconds, 2, 1, 10);
      const maxFrames = clampInt(b.max_frames, 24, 6, 120);
      const maxWidth = clampInt(b.max_width, 960, 480, 1920);
      const maxCandidates = clampInt(b.max_candidates, 12, 1, 25);

      const baseUrl = getBaseUrl(req);

      // Guard: baseUrl must be absolute https URL in prod.
      // If someone misconfigures env vars, we still try to proceed.

      const enqueue = await enqueueProcessJob({
        wardrobeVideoId: video.id,
        baseUrl,
        sampleEverySeconds,
        maxFrames,
        maxWidth,
        maxCandidates,
      });

      // Return immediately. Processing is async.
      return NextResponse.json(
        {
          ok: true,
          wardrobe_video_id: video.id,
          status: "processing" as const,
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
      .select("id,user_id,video_url,status,created_at")
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
            .select("id,status")
            .eq("id", row.id)
            .eq("user_id", FOUNDER_USER_ID)
            .single();

          if (latest?.status === "processing" || latest?.status === "processed") {
            return;
          }
        } catch {
          // best-effort; do not block response
        }

        try {
          await supabase
            .from("wardrobe_videos")
            .update({ status: "processing" })
            .eq("id", row.id)
            .eq("user_id", FOUNDER_USER_ID)
            .in("status", ["uploaded", "failed"]);
        } catch {
          // best-effort; do not block response
        }

        try {
          await enqueueProcessJob({
            wardrobeVideoId: row.id,
            baseUrl: getBaseUrl(req),
          });
        } catch {
          // best-effort; do not block response
        }
      })();
    }

    return NextResponse.json({ ok: true, wardrobe_video: row }, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: "Server error", details: err?.message ?? "unknown" },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}