// app/api/wardrobe-videos/process/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseClient.server";
import { Receiver } from "@upstash/qstash";
import { extractFramesFromVideo, cleanupExtractedFrames } from "@/lib/video/extractFrames";
import { detectGarmentCandidates } from "@/lib/video/detectGarmentCandidates";

// Force Node.js runtime (ffmpeg) and prevent caching
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Increase timeout headroom for video processing (Vercel will enforce plan limits)
export const maxDuration = 300;

// Founder Edition: single-user scope
const FOUNDER_USER_ID =
  process.env.FOUNDER_USER_ID ?? "00000000-0000-0000-0000-000000000001";

type ProcessBody = {
  wardrobe_video_id?: string;
  video_id?: string;
  sample_every_seconds?: number;
  max_frames?: number;
  max_width?: number;
  max_candidates?: number;

  // Optional: allow reprocess even if processed
  force?: boolean;

  // Optional: trace why this run happened (debug)
  reason?: string;
};

type CandidatePreview = {
  fingerprint: string;
  image_url: string;
  score: number | null;
  source_frame_index: number | null;
};

type CandidateFromDetector = {
  fingerprint?: string;
  dhash_hex?: string;
  hash?: string;
  phash?: string;
  webpUrl?: string;
  image_url?: string;
  imageUrl?: string;
  url?: string;
  image_webp?: Buffer | Uint8Array;
  score?: number;
  source_frame_index?: number;
};

type CandidateRow = {
  fingerprint: string;
  image_url: string;
  score?: number;
  source_frame_index?: number;
};

function isLocalOrDev() {
  const env = process.env.NODE_ENV;
  return env !== "production";
}

function getFullRequestUrl(req: NextRequest) {
  // Use the URL as seen by the server (includes origin on Vercel).
  // This is the safest value for QStash signature verification.
  const full = req.nextUrl?.toString?.();
  if (typeof full === "string" && full.trim()) return full;

  // Fallback: reconstruct from forwarded headers.
  const proto = (req.headers.get("x-forwarded-proto") || "https").trim();
  const host = (req.headers.get("x-forwarded-host") || req.headers.get("host") || "").trim();
  if (host) return `${proto}://${host}${req.nextUrl.pathname}${req.nextUrl.search}`;

  return "";
}

async function verifyQStashSignature(req: NextRequest, rawBody: string) {
  const currentSigningKey = (process.env.QSTASH_CURRENT_SIGNING_KEY || "").trim();
  const nextSigningKey = (process.env.QSTASH_NEXT_SIGNING_KEY || "").trim();

  if (!currentSigningKey && !nextSigningKey) {
    throw new Error(
      "Missing QStash signing keys. Set QSTASH_CURRENT_SIGNING_KEY (and optionally QSTASH_NEXT_SIGNING_KEY)."
    );
  }

  const signature = (req.headers.get("Upstash-Signature") || "").trim();
  if (!signature) {
    throw new Error("Missing Upstash-Signature header");
  }

  const url = getFullRequestUrl(req);
  if (!url) {
    throw new Error(
      "Could not determine request URL for signature verification. Ensure host headers are present."
    );
  }

  // @upstash/qstash ReceiverConfig expects strings (not undefined).
  // If only one signing key is set, reuse it for the other slot.
  const receiver = new Receiver({
    currentSigningKey: currentSigningKey || nextSigningKey,
    nextSigningKey: nextSigningKey || currentSigningKey,
  });

  const isValid = await receiver.verify({
    body: rawBody,
    signature,
    url,
  });

  if (!isValid) {
    throw new Error("Invalid QStash signature");
  }
}

async function requireQStashSignature(req: NextRequest, rawBody: string) {
  // Local/dev: allow direct calls to iterate faster.
  if (isLocalOrDev()) return;

  // Production: allow direct calls only if explicitly enabled (useful for emergency debugging).
  const allowDirect = (process.env.ALLOW_DIRECT_PROCESS_CALLS || "").trim() === "true";
  if (allowDirect) return;

  await verifyQStashSignature(req, rawBody);
}

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function safeJsonParse<T>(raw: string): T | null {
  try {
    const v = JSON.parse(raw);
    return (v && typeof v === "object") ? (v as T) : null;
  } catch {
    return null;
  }
}

function qstashMeta(req: NextRequest) {
  const messageId =
    (req.headers.get("Upstash-Message-Id") ||
      req.headers.get("upstash-message-id") ||
      "").trim() || null;

  const retried =
    (req.headers.get("Upstash-Retried") ||
      req.headers.get("upstash-retried") ||
      req.headers.get("Upstash-Retry") ||
      req.headers.get("upstash-retry") ||
      "").trim() || null;

  return {
    message_id: messageId,
    job_id: messageId,
    retried,
  };
}

function clampInt(v: unknown, fallback: number, min: number, max: number) {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function nowIso() {
  return new Date().toISOString();
}

function isTruthyRetryFlag(v: string | null) {
  if (!v) return false;
  const t = v.trim().toLowerCase();
  return t === "true" || t === "1" || t === "yes" || t === "y";
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
        cacheControl: "31536000",
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
  // Track outputs across try/finally so we can respond after cleanup.
  let frames: Buffer[] = [];
  let candidates: CandidateRow[] = [];
  let candidatesPreview: CandidatePreview[] = [];
  let videoIdForFail: string | null = null;

  const qstash = qstashMeta(req);

  try {
    // Read raw body once so we can verify QStash signature deterministically
    const rawBody = await req.text().catch(() => "");
    await requireQStashSignature(req, rawBody);

    const body = (rawBody ? safeJsonParse<ProcessBody>(rawBody) : null) ?? {};
    const videoId = asString(body.wardrobe_video_id || body.video_id);
    videoIdForFail = videoId;

    if (!videoId) {
      return NextResponse.json(
        { ok: false, error: "Missing wardrobe_video_id", qstash },
        { status: 400 }
      );
    }

    const sampleEverySeconds = clampInt(body.sample_every_seconds, 2, 1, 10);
    const maxFrames = clampInt(body.max_frames, 24, 6, 120);
    const maxWidth = clampInt(body.max_width, 960, 480, 1920);
    const maxCandidates = clampInt(body.max_candidates, 12, 1, 25);
    const force = Boolean(body.force);
    const qstashMessageId = qstash?.message_id ? String(qstash.message_id) : null;

    const supabase = getSupabaseServerClient();

    // 1) Load video record (user-scoped)
    const { data: video, error: videoErr } = await supabase
      .from("wardrobe_videos")
      .select(
        "id,user_id,video_url,status,created_at,last_process_message_id,last_process_retried,last_processed_at"
      )
      .eq("id", videoId)
      .eq("user_id", FOUNDER_USER_ID)
      .single();

    if (videoErr || !video) {
      return NextResponse.json(
        {
          ok: false,
          error: "Video not found",
          details: videoErr?.message ?? "missing row",
          qstash,
        },
        { status: 404 }
      );
    }

    // 2) Status transition + traceability
    // Retry-safe behavior:
    // - If already processed and not forced -> return.
    // - If processing under a DIFFERENT QStash message id -> do not run concurrently.
    // - If processing under the SAME message id (retry) or no message id -> continue.

    const didRetry = isTruthyRetryFlag(qstash?.retried ?? null);
    const reason = asString(body.reason);

    if (video.status === "processed" && !force) {
      return NextResponse.json(
        {
          ok: true,
          wardrobe_video_id: video.id,
          status: video.status,
          last_process_message_id: video.last_process_message_id ?? null,
          last_process_retried: video.last_process_retried ?? null,
          last_processed_at: video.last_processed_at ?? null,
          qstash_message_id: qstashMessageId ?? null,
          qstash_retried: qstash?.retried ?? null,
          message: "Already processed",
          started_at: startedAt,
          qstash,
          reason: reason || null,
        },
        { status: 200 }
      );
    }

    // If another job is already processing this video, avoid concurrent pipelines.
    if (
      video.status === "processing" &&
      !force &&
      video.last_process_message_id &&
      qstashMessageId &&
      String(video.last_process_message_id) !== String(qstashMessageId)
    ) {
      return NextResponse.json(
        {
          ok: true,
          wardrobe_video_id: video.id,
          status: "processing",
          last_process_message_id: video.last_process_message_id,
          last_process_retried: video.last_process_retried ?? null,
          last_processed_at: video.last_processed_at ?? null,
          qstash_message_id: qstashMessageId ?? null,
          qstash_retried: qstash?.retried ?? null,
          message: "Already processing (another job)",
          started_at: startedAt,
          qstash,
          reason: reason || null,
        },
        { status: 200 }
      );
    }

    // Flip to processing if needed.
    // Also persist last_process_message_id for traceability (best effort).
    // If force=true, allow takeover by overwriting last_process_message_id.
    if (video.status !== "processing" || force) {
      const updatePayload: Record<string, any> = { status: "processing" };
      if (qstashMessageId) updatePayload.last_process_message_id = qstashMessageId;
      // Persist retry flag for traceability (null allowed if column is nullable)
      updatePayload.last_process_retried = didRetry;

      const { error: statusErr } = await supabase
        .from("wardrobe_videos")
        .update(updatePayload)
        .eq("id", video.id)
        .eq("user_id", FOUNDER_USER_ID);

      if (statusErr) {
        return NextResponse.json(
          {
            ok: false,
            error: "Failed to update status",
            details: statusErr.message,
            qstash,
          },
          { status: 500 }
        );
      }

      // Keep local object in sync for response/debug.
      (video as any).status = "processing";
      if (qstashMessageId) (video as any).last_process_message_id = qstashMessageId;
      (video as any).last_process_retried = didRetry;
    } else {
      // Already processing: on retries, ensure we store the message id if missing.
      if (qstashMessageId && !video.last_process_message_id) {
        await supabase
          .from("wardrobe_videos")
          .update({ last_process_message_id: qstashMessageId, last_process_retried: didRetry })
          .eq("id", video.id)
          .eq("user_id", FOUNDER_USER_ID);
        (video as any).last_process_message_id = qstashMessageId;
        (video as any).last_process_retried = didRetry;
      } else if (video.last_process_retried == null) {
        await supabase
          .from("wardrobe_videos")
          .update({ last_process_retried: didRetry })
          .eq("id", video.id)
          .eq("user_id", FOUNDER_USER_ID);
        (video as any).last_process_retried = didRetry;
      }
    }

    // 3) Run processing pipeline
    const videoUrl = asString(video.video_url);
    if (!videoUrl) {
      await supabase
        .from("wardrobe_videos")
        .update({
          status: "failed",
          last_process_retried: didRetry,
          ...(qstashMessageId ? { last_process_message_id: qstashMessageId } : {}),
        })
        .eq("id", video.id)
        .eq("user_id", FOUNDER_USER_ID);

      return NextResponse.json(
        { ok: false, error: "video_url is missing", qstash, reason: reason || null },
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

    // Best-effort: if extractFrames provides a temp dir, always clean it up.
    const frameDir = asString((extracted as any)?.frameDir || (extracted as any)?.dir);

    try {
      frames = Array.isArray(extracted?.frames) ? extracted.frames : [];

      if (!frames.length) {
        // Nothing extracted; still mark processed (safe fallback)
        const processedAt = new Date().toISOString();
        await supabase
          .from("wardrobe_videos")
          .update({
            status: "processed",
            last_process_retried: didRetry,
            last_processed_at: processedAt,
            ...(qstashMessageId ? { last_process_message_id: qstashMessageId } : {}),
          })
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
            qstash_message_id: qstashMessageId ?? null,
            qstash_retried: qstash?.retried ?? null,
            last_processed_at: processedAt,
            message: "No frames extracted",
            started_at: startedAt,
            qstash,
            last_process_retried: (video as any).last_process_retried ?? didRetry,
            reason: reason || null,
          },
          { status: 200 }
        );
      }


      // 3b) Detect candidates
      const detected = await detectGarmentCandidates({
        frames,
        maxCandidates,
      });

      const candidatesRaw: CandidateFromDetector[] = (() => {
        if (Array.isArray(detected)) return detected as any;
        const maybe = detected as any;
        if (Array.isArray(maybe?.candidates)) return maybe.candidates as any;
        return [];
      })();

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

      candidates = uniqByFingerprint(normalizedCandidates).slice(0, maxCandidates);

      candidatesPreview = candidates.map((c) => ({
        fingerprint: c.fingerprint,
        image_url: c.image_url,
        score: c.score ?? null,
        source_frame_index: c.source_frame_index ?? null,
      }));

      if (!candidates.length) {
        const processedAt = new Date().toISOString();
        await supabase
          .from("wardrobe_videos")
          .update({
            status: "processed",
            last_process_retried: didRetry,
            last_processed_at: processedAt,
            ...(qstashMessageId ? { last_process_message_id: qstashMessageId } : {}),
          })
          .eq("id", video.id)
          .eq("user_id", FOUNDER_USER_ID);

        return NextResponse.json(
          {
            ok: true,
            wardrobe_video_id: video.id,
            status: "processed",
            frames: frames.length,
            candidates: 0,
            candidates_preview: [] as CandidatePreview[],
            qstash_message_id: qstashMessageId ?? null,
            qstash_retried: qstash?.retried ?? null,
            last_processed_at: processedAt,
            message: "No garment candidates detected",
            started_at: startedAt,
            qstash,
            last_process_retried: (video as any).last_process_retried ?? didRetry,
            reason: reason || null,
          },
          { status: 200 }
        );
      }

      // Retry-safe: clear previous candidates for this video, scoped by user
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
          candidatesPreview = candRows
            .map((r: any) => ({
              fingerprint: asString(r.fingerprint),
              image_url: asString(r.image_url),
              score: typeof r.score === "number" ? r.score : null,
              source_frame_index:
                typeof r.source_frame_index === "number" ? r.source_frame_index : null,
            }))
            .filter((r) => r.fingerprint && r.image_url);
        }

        if (candErr) {
          // Do not fail the whole pipeline; mark processed but include warning.
          const processedAt = new Date().toISOString();
          await supabase
            .from("wardrobe_videos")
            .update({
              status: "processed",
              last_process_retried: didRetry,
              last_processed_at: processedAt,
              ...(qstashMessageId ? { last_process_message_id: qstashMessageId } : {}),
            })
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
              qstash_message_id: qstashMessageId ?? null,
              qstash_retried: qstash?.retried ?? null,
              last_processed_at: processedAt,
              warning: `Candidates detected but failed to persist: ${candErr.message}`,
              started_at: startedAt,
              qstash,
              last_process_retried: (video as any).last_process_retried ?? didRetry,
              reason: reason || null,
            },
            { status: 200 }
          );
        }
      }

      // At this point candidates are persisted; continue to final status update below.
    } finally {
      if (frameDir) {
        await cleanupExtractedFrames(frameDir);
      }
    }
    const processedAt = new Date().toISOString();
    await supabase
      .from("wardrobe_videos")
      .update({
        status: "processed",
        last_process_retried: didRetry,
        last_processed_at: processedAt,
        ...(qstashMessageId ? { last_process_message_id: qstashMessageId } : {}),
      })
      .eq("id", video.id)
      .eq("user_id", FOUNDER_USER_ID);

    return NextResponse.json(
      {
        ok: true,
        wardrobe_video_id: video.id,
        status: "processed",
        last_process_message_id: (video as any).last_process_message_id ?? qstashMessageId ?? null,
        qstash_message_id: qstashMessageId ?? null,
        qstash_retried: qstash?.retried ?? null,
        last_processed_at: processedAt,
        frames: frames.length,
        candidates: candidates.length,
        candidates_preview: candidatesPreview,
        started_at: startedAt,
        finished_at: nowIso(),
        qstash,
        last_process_retried: (video as any).last_process_retried ?? didRetry,
        reason: reason || null,
      },
      { status: 200 }
    );
  } catch (err: any) {
    console.error("Error in /api/wardrobe-videos/process:", err);

    // Best-effort: if we already flipped the row to processing, mark it failed.
    try {
      if (videoIdForFail) {
        const supabase = getSupabaseServerClient();
        await supabase
          .from("wardrobe_videos")
          .update({
            status: "failed",
            last_process_retried: isTruthyRetryFlag(qstash?.retried ?? null),
            ...(qstash?.message_id ? { last_process_message_id: String(qstash.message_id) } : {}),
          })
          .eq("id", videoIdForFail)
          .eq("user_id", FOUNDER_USER_ID);
      }
    } catch (e: any) {
      console.warn("Failed to mark wardrobe_videos as failed:", e?.message ?? e);
    }

    return NextResponse.json(
      {
        ok: false,
        error: "Server error",
        details: err?.message ?? "unknown",
        wardrobe_video_id: videoIdForFail ? videoIdForFail : null,
        failed_at: nowIso(),
        qstash,
        reason: null,
      },
      { status: 500 }
    );
  }
}

// Optional: improved health check
export async function GET(req: NextRequest) {
  const hasSigningKey = Boolean((process.env.QSTASH_CURRENT_SIGNING_KEY || "").trim());
  const hasNextSigningKey = Boolean((process.env.QSTASH_NEXT_SIGNING_KEY || "").trim());
  const allowDirect = (process.env.ALLOW_DIRECT_PROCESS_CALLS || "").trim() === "true";

  return NextResponse.json(
    {
      ok: true,
      route: "/api/wardrobe-videos/process",
      runtime,
      dynamic,
      maxDuration,
      env: {
        node_env: process.env.NODE_ENV ?? null,
        has_qstash_current_signing_key: hasSigningKey,
        has_qstash_next_signing_key: hasNextSigningKey,
        allow_direct_process_calls: allowDirect,
      },
      qstash: {
        // Whether this request looks like QStash (signature not validated here)
        has_signature_header: Boolean((req.headers.get("Upstash-Signature") || "").trim()),
        message_id:
          (req.headers.get("Upstash-Message-Id") || req.headers.get("upstash-message-id") || "").trim() || null,
      },
    },
    { status: 200 }
  );
}