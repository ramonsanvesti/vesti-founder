// app/api/wardrobe-videos/process/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseClient.server";
import { extractFramesFromVideo } from "@/lib/video/extractFrames";
import { detectGarmentCandidates } from "@/lib/video/detectGarmentCandidates";

// Founder Edition fake user_id (replace with auth later)
const FOUNDER_USER_ID = "00000000-0000-0000-0000-000000000001";

type ProcessBody = {
  wardrobe_video_id?: string;
  video_id?: string;
  // Optional tuning knobs
  sample_every_seconds?: number; // default 2
  max_frames?: number; // default 24
  max_width?: number; // default 960
  // Candidate tuning
  max_candidates?: number; // default 12
};

type CandidateRow = {
  fingerprint: string;
  image_url: string; // public url (webp preferred)
  score?: number;
  source_frame_index?: number;
};

type CandidatePreview = {
  fingerprint: string;
  image_url: string;
  score?: number | null;
  source_frame_index?: number | null;
};

type CandidateFromDetector = {
  fingerprint?: string;
  hash?: string;
  phash?: string;
  dhash_hex?: string;
  image_url?: string;
  imageUrl?: string;
  webpUrl?: string;
  url?: string;
  image_webp?: Buffer | Uint8Array;
  image_webp_mime?: string;
  score?: number;
  source_frame_index?: number;
};

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function clampInt(v: unknown, fallback: number, min: number, max: number) {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function nowIso() {
  return new Date().toISOString();
}

function uniqByFingerprint<T extends { fingerprint: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    const fp = asString(r.fingerprint);
    if (!fp) continue;
    if (seen.has(fp)) continue;
    seen.add(fp);
    out.push(r);
  }
  return out;
}

async function uploadWebpToSupabase(opts: {
  supabase: any;
  bucket: string;
  path: string;
  bytes: Buffer | Uint8Array;
}): Promise<string | null> {
  const { supabase, bucket, path, bytes } = opts;
  try {
    const body = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

    const { error: uploadErr } = await supabase.storage
      .from(bucket)
      .upload(path, body, {
        contentType: "image/webp",
        upsert: false,
        cacheControl: "3600",
      });

    if (uploadErr) {
      console.warn("Candidate webp upload failed:", uploadErr.message);
      return null;
    }

    const { data: pub } = supabase.storage.from(bucket).getPublicUrl(path);
    return pub?.publicUrl ? String(pub.publicUrl) : null;
  } catch (e: any) {
    console.warn("Candidate webp upload exception:", e?.message ?? e);
    return null;
  }
}

export async function POST(req: NextRequest) {
  const startedAt = nowIso();
  let videoIdForFail: string | null = null;
  let statusMovedToProcessing = false;

  try {
    const body = (await req.json().catch(() => ({}))) as ProcessBody;
    const videoId = asString(body.wardrobe_video_id || body.video_id);
    videoIdForFail = videoId;

    if (!videoId) {
      return NextResponse.json(
        { ok: false, error: "Missing wardrobe_video_id" },
        { status: 400 }
      );
    }

    const sampleEverySeconds = clampInt(body.sample_every_seconds, 2, 1, 10);
    const maxFrames = clampInt(body.max_frames, 24, 6, 120);
    const maxWidth = clampInt(body.max_width, 960, 480, 1920);
    const maxCandidates = clampInt(body.max_candidates, 12, 1, 25);

    const supabase = getSupabaseServerClient();

    // 1) Load video record (user-scoped)
    const { data: video, error: videoErr } = await supabase
      .from("wardrobe_videos")
      .select("id,user_id,video_url,status,created_at")
      .eq("id", videoId)
      .eq("user_id", FOUNDER_USER_ID)
      .single();

    if (videoErr || !video) {
      return NextResponse.json(
        {
          ok: false,
          error: "Video not found",
          details: videoErr?.message ?? "missing row",
        },
        { status: 404 }
      );
    }

    // 2) Idempotent status transition
    if (video.status === "processing") {
      return NextResponse.json(
        {
          ok: true,
          wardrobe_video_id: video.id,
          status: video.status,
          message: "Already processing",
          started_at: startedAt,
        },
        { status: 200 }
      );
    }

    if (video.status === "processed") {
      return NextResponse.json(
        {
          ok: true,
          wardrobe_video_id: video.id,
          status: video.status,
          message: "Already processed",
          started_at: startedAt,
        },
        { status: 200 }
      );
    }

    // Move to processing immediately (upload success must not depend on completion)
    const { error: statusErr } = await supabase
      .from("wardrobe_videos")
      .update({ status: "processing" })
      .eq("id", video.id)
      .eq("user_id", FOUNDER_USER_ID);

    if (statusErr) {
      return NextResponse.json(
        {
          ok: false,
          error: "Failed to update status",
          details: statusErr.message,
        },
        { status: 500 }
      );
    }
    statusMovedToProcessing = true;

    // 3) Run processing pipeline
    const videoUrl = asString(video.video_url);
    if (!videoUrl) {
      await supabase
        .from("wardrobe_videos")
        .update({ status: "failed" })
        .eq("id", video.id)
        .eq("user_id", FOUNDER_USER_ID);

      return NextResponse.json(
        { ok: false, error: "video_url is missing" },
        { status: 500 }
      );
    }

    // 3a) Extract frames from the remote video URL.
    // IMPORTANT: extractFramesFromVideo is responsible for downloading to /tmp and cleaning up.
    const extracted = await extractFramesFromVideo(videoUrl, {
      sampleEverySeconds,
      maxFrames,
      maxWidth,
    });

    const frames = Array.isArray(extracted?.frames) ? extracted.frames : [];

    if (!frames.length) {
      // Nothing extracted; still mark processed (safe fallback)
      await supabase
        .from("wardrobe_videos")
        .update({ status: "processed" })
        .eq("id", video.id)
        .eq("user_id", FOUNDER_USER_ID);

      return NextResponse.json(
        {
          ok: true,
          wardrobe_video_id: video.id,
          status: "processed",
          frames: 0,
          candidates: 0,
          candidates_preview: [] as CandidatePreview[],
          message: "No frames extracted",
          started_at: startedAt,
        },
        { status: 200 }
      );
    }

    // Prepare candidatesPreview before persisting candidates
    let candidatesPreview: CandidatePreview[] = [];

    // 3b) Detect candidates (dedupe handled later here)
    const detected = await detectGarmentCandidates({
      frames,
      maxCandidates,
    });

    const candidatesRaw: CandidateFromDetector[] =
      Array.isArray(detected)
        ? (detected as any)
        : Array.isArray((detected as any)?.candidates)
          ? ((detected as any).candidates as any)
          : [];

    // Normalize + ensure we always end with a public webp URL.
    const normalizedCandidates: CandidateRow[] = [];

    for (let i = 0; i < candidatesRaw.length; i++) {
      const c = candidatesRaw[i];
      const fp = asString(c?.fingerprint || c?.dhash_hex || c?.hash || c?.phash);
      if (!fp) continue;

      // If detector already provides a URL, accept it.
      let url = asString(c?.webpUrl || c?.image_url || c?.imageUrl || c?.url);

      // If detector provides webp bytes, upload to Supabase and use that URL.
      if (!url && c?.image_webp) {
        const folder = `video_candidates/${video.id}`;
        const file = `${Date.now()}-${i}-candidate.webp`;
        const path = `${folder}/${file}`;

        const publicUrl = await uploadWebpToSupabase({
          supabase,
          bucket: "garments",
          path,
          bytes: c.image_webp,
        });

        if (publicUrl) url = publicUrl;
      }

      if (!url) continue;

      normalizedCandidates.push({
        fingerprint: fp,
        image_url: url,
        score: typeof c?.score === "number" ? c.score : undefined,
        source_frame_index:
          typeof c?.source_frame_index === "number" ? c.source_frame_index : undefined,
      });
    }

    const candidates = uniqByFingerprint(normalizedCandidates).slice(0, maxCandidates);

    candidatesPreview = candidates.map((c) => ({
      fingerprint: c.fingerprint,
      image_url: c.image_url,
      score: c.score ?? null,
      source_frame_index: c.source_frame_index ?? null,
    }));

    // Retry-safe: clear previous candidates for this video
    await supabase
      .from("wardrobe_video_candidates")
      .delete()
      .eq("wardrobe_video_id", video.id)
      .eq("user_id", FOUNDER_USER_ID);

    // 4) Persist candidate rows (temporary table)
    if (candidates.length) {
      const rows = candidates.map((c) => ({
        user_id: FOUNDER_USER_ID,
        wardrobe_video_id: video.id,
        image_url: c.image_url,
        fingerprint: c.fingerprint,
        status: "candidate",
        score: c.score ?? null,
        source_frame_index: c.source_frame_index ?? null,
      }));

      const { error: candErr } = await supabase
        .from("wardrobe_video_candidates")
        .insert(rows);

      // Refresh from DB for UI (and to confirm persistence)
      const { data: candRows } = await supabase
        .from("wardrobe_video_candidates")
        .select("fingerprint,image_url,score,source_frame_index")
        .eq("wardrobe_video_id", video.id)
        .eq("user_id", FOUNDER_USER_ID)
        .order("created_at", { ascending: true });

      if (Array.isArray(candRows) && candRows.length) {
        candidatesPreview = candRows.map((r: any) => ({
          fingerprint: asString(r.fingerprint),
          image_url: asString(r.image_url),
          score: typeof r.score === "number" ? r.score : null,
          source_frame_index: typeof r.source_frame_index === "number" ? r.source_frame_index : null,
        })).filter((r) => r.fingerprint && r.image_url);
      }

      if (candErr) {
        // Do not fail the whole pipeline; mark processed but include warning.
        await supabase
          .from("wardrobe_videos")
          .update({ status: "processed" })
          .eq("id", video.id)
          .eq("user_id", FOUNDER_USER_ID);

        return NextResponse.json(
          {
            ok: true,
            wardrobe_video_id: video.id,
            status: "processed",
            frames: frames.length,
            candidates: candidates.length,
            candidates_preview: candidatesPreview,
            warning: `Candidates detected but failed to persist: ${candErr.message}`,
            started_at: startedAt,
          },
          { status: 200 }
        );
      }
    }

    // 5) Finalize status
    await supabase
      .from("wardrobe_videos")
      .update({ status: "processed" })
      .eq("id", video.id)
      .eq("user_id", FOUNDER_USER_ID);

    return NextResponse.json(
      {
        ok: true,
        wardrobe_video_id: video.id,
        status: "processed",
        frames: frames.length,
        candidates: candidates.length,
        candidates_preview: candidatesPreview,
        started_at: startedAt,
      },
      { status: 200 }
    );
  } catch (err: any) {
    console.error("Error in /api/wardrobe-videos/process:", err);

    // Best-effort: if we already flipped the row to processing, mark it failed.
    try {
      if (statusMovedToProcessing && videoIdForFail) {
        const supabase = getSupabaseServerClient();
        await supabase
          .from("wardrobe_videos")
          .update({ status: "failed" })
          .eq("id", videoIdForFail)
          .eq("user_id", FOUNDER_USER_ID);
      }
    } catch (e: any) {
      console.warn("Failed to mark wardrobe_videos as failed:", e?.message ?? e);
    }

    return NextResponse.json(
      { ok: false, error: "Server error", details: err?.message ?? "unknown" },
      { status: 500 }
    );
  }
}

// Optional: simple health check
export async function GET() {
  return NextResponse.json({ ok: true, route: "/api/wardrobe-videos/process" }, { status: 200 });
}