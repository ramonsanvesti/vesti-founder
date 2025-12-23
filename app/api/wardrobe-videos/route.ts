// app/api/wardrobe-videos/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseClient.server";

// Founder Edition: single-user scope
const FOUNDER_USER_ID =
  process.env.FOUNDER_USER_ID ?? "00000000-0000-0000-0000-000000000001";

type Status = "uploaded" | "processing" | "processed" | "failed";

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function clampInt(v: unknown, fallback: number, min: number, max: number) {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function isConfiguredQStash() {
  // Either token-based (recommended) or signing keys (verification on process route)
  return Boolean(process.env.QSTASH_TOKEN);
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
    sampleEverySeconds = 2,
    maxFrames = 24,
    maxWidth = 960,
    maxCandidates = 12,
  } = args;

  // If QStash isn't configured, do a best-effort direct call (does not block response).
  if (!isConfiguredQStash()) {
    void fetch(`${baseUrl}/api/wardrobe-videos/process`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wardrobe_video_id: wardrobeVideoId,
        sample_every_seconds: sampleEverySeconds,
        max_frames: maxFrames,
        max_width: maxWidth,
        max_candidates: maxCandidates,
      }),
    }).catch(() => {});
    return { ok: true, enqueued: false, fallback: "direct_fetch" as const };
  }

  // Dynamic import to avoid TS/module errors if package isn't installed locally
  const mod = (await (eval('import("@upstash/qstash")') as Promise<any>)) as any;
  const Client = mod?.Client;

  if (!Client) {
    // If package not available, fallback
    void fetch(`${baseUrl}/api/wardrobe-videos/process`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wardrobe_video_id: wardrobeVideoId,
        sample_every_seconds: sampleEverySeconds,
        max_frames: maxFrames,
        max_width: maxWidth,
        max_candidates: maxCandidates,
      }),
    }).catch(() => {});
    return { ok: true, enqueued: false, fallback: "direct_fetch" as const };
  }

  const client = new Client({ token: process.env.QSTASH_TOKEN });

  // Queue a POST to our processing route (QStash will sign it; process route verifies in prod).
  const targetUrl = `${baseUrl}/api/wardrobe-videos/process`;

  const res = await client.publishJSON({
    url: targetUrl,
    body: {
      wardrobe_video_id: wardrobeVideoId,
      sample_every_seconds: sampleEverySeconds,
      max_frames: maxFrames,
      max_width: maxWidth,
      max_candidates: maxCandidates,
    },
    // Retry policy (WOW): you can tune these
    retries: 3,
  });

  return { ok: true, enqueued: true, qstash: res };
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
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, videos: data ?? [] }, { status: 200 });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: "Server error", details: err?.message ?? "unknown" },
      { status: 500 }
    );
  }
}

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
        return NextResponse.json(
          { ok: false, error: "Missing video_id" },
          { status: 400 }
        );
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
          { status: 404 }
        );
      }

      if (video.status === "processed") {
        return NextResponse.json(
          { ok: true, wardrobe_video: video, message: "Already processed" },
          { status: 200 }
        );
      }

      // Retry-safe: move to processing (or keep processing)
      if (video.status !== "processing") {
        const { error: stErr } = await supabase
          .from("wardrobe_videos")
          .update({ status: "processing" })
          .eq("id", video.id)
          .eq("user_id", FOUNDER_USER_ID);

        if (stErr) {
          return NextResponse.json(
            { ok: false, error: "Failed to update status", details: stErr.message },
            { status: 500 }
          );
        }
      }

      const sampleEverySeconds = clampInt(b.sample_every_seconds, 2, 1, 10);
      const maxFrames = clampInt(b.max_frames, 24, 6, 120);
      const maxWidth = clampInt(b.max_width, 960, 480, 1920);
      const maxCandidates = clampInt(b.max_candidates, 12, 1, 25);

      const baseUrl =
        process.env.NEXT_PUBLIC_SITE_URL ||
        `${req.nextUrl.protocol}//${req.nextUrl.host}`;

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
          status: "processing",
          enqueued: enqueue,
        },
        { status: 200 }
      );
    }

    // CREATE video row
    const create = body as CreateBody;
    const videoUrl = asString(create.video_url);

    if (!videoUrl) {
      return NextResponse.json(
        { ok: false, error: "Missing video_url" },
        { status: 400 }
      );
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
        { status: 500 }
      );
    }

    // Optional: auto-process right after upload record creation
    if (create.auto_process) {
      const baseUrl =
        process.env.NEXT_PUBLIC_SITE_URL ||
        `${req.nextUrl.protocol}//${req.nextUrl.host}`;

      // flip to processing (retry-safe)
      await supabase
        .from("wardrobe_videos")
        .update({ status: "processing" })
        .eq("id", row.id)
        .eq("user_id", FOUNDER_USER_ID);

      void enqueueProcessJob({
        wardrobeVideoId: row.id,
        baseUrl,
      }).catch(() => {});
    }

    return NextResponse.json(
      {
        ok: true,
        wardrobe_video: row,
      },
      { status: 200 }
    );
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: "Server error", details: err?.message ?? "unknown" },
      { status: 500 }
    );
  }
}