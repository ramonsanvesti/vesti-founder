// app/api/wardrobe-videos/process/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseClient.server";
import { Receiver as QStashReceiver } from "@upstash/qstash";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Founder-only scope (Founder Edition)
const FOUNDER_USER_ID =
  process.env.FOUNDER_USER_ID ?? "00000000-0000-0000-0000-000000000001";

type VideoStatus = "uploaded" | "processing" | "processed" | "failed";

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

function getUpstashSignature(req: NextRequest): string {
  return asString(
    req.headers.get("upstash-signature") || req.headers.get("Upstash-Signature")
  );
}

function getUpstashMessageId(req: NextRequest): string {
  return asString(
    req.headers.get("upstash-message-id") || req.headers.get("Upstash-Message-Id")
  );
}

function getUpstashRetryCount(req: NextRequest): number {
  return clampInt(
    req.headers.get("upstash-retry-count") || req.headers.get("Upstash-Retry-Count"),
    0,
    0,
    99
  );
}

async function verifyQStashOrThrow(req: NextRequest, rawBody: string) {
  // Production MUST be verified.
  // Dev: allow local/manual calls (no signature), but if a signature is present, verify it.
  const signature = getUpstashSignature(req);
  const isProd = process.env.NODE_ENV === "production";

  if (!signature) {
    if (isProd) throw new Error("Missing Upstash-Signature header");
    return;
  }

  const currentSigningKey = asString(process.env.QSTASH_CURRENT_SIGNING_KEY);
  const nextSigningKey = asString(process.env.QSTASH_NEXT_SIGNING_KEY);

  if (!currentSigningKey) {
    throw new Error("Missing QSTASH_CURRENT_SIGNING_KEY");
  }

  // ReceiverConfig requires strings; if NEXT is not set, reuse CURRENT.
  const receiver = new QStashReceiver({
    currentSigningKey,
    nextSigningKey: nextSigningKey || currentSigningKey,
  });

  // Must be the EXACT URL QStash called, including scheme.
  const url = req.nextUrl.toString();

  const ok = await receiver.verify({
    signature,
    body: rawBody,
    url,
  });

  if (!ok) throw new Error("Invalid QStash signature");
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
 *
 * QStash *worker* (execution endpoint).
 * It should be called by QStash (signed) after /api/wardrobe-videos enqueues a job.
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

  // Reject accidental UI calls that send { action: "process" }
  if (parsed && typeof parsed === "object" && (parsed as any).action) {
    return jsonNoStore(
      {
        ok: false,
        error:
          "This endpoint is the QStash worker. Use POST /api/wardrobe-videos with { action: 'process', wardrobe_video_id }.",
      },
      400
    );
  }

  const body = (parsed ?? {}) as Partial<QStashJobBody>;
  const wardrobe_video_id = asString(body.wardrobe_video_id);
  if (!wardrobe_video_id) {
    return jsonNoStore({ ok: false, error: "Missing wardrobe_video_id" }, 400);
  }

  // Verify signature (required in prod)
  try {
    await verifyQStashOrThrow(req, raw);
  } catch (e: any) {
    return jsonNoStore({ ok: false, error: e?.message || "Unauthorized" }, 401);
  }

  const incomingMessageId = getUpstashMessageId(req) || null;
  const retryCount = getUpstashRetryCount(req);
  const force = Boolean(body.force);

  const { data: video, error: vErr } = await loadVideoRow(
    supabase,
    wardrobe_video_id
  );
  if (vErr || !video) {
    return jsonNoStore({ ok: false, error: "Video not found" }, 404);
  }

  // Supersession guard: if UI already enqueued a newer job, skip this run.
  if (
    incomingMessageId &&
    video.last_process_message_id &&
    incomingMessageId !== video.last_process_message_id &&
    !force
  ) {
    return jsonNoStore(
      {
        ok: true,
        message: "Superseded by newer job",
        video_id: wardrobe_video_id,
        incoming_message_id: incomingMessageId,
        expected_message_id: video.last_process_message_id,
      },
      200
    );
  }

  // If already processed, acknowledge idempotently.
  if (video.status === "processed" && video.last_processed_at && !force) {
    return jsonNoStore(
      {
        ok: true,
        message: "Already processed",
        video_id: wardrobe_video_id,
        message_id: incomingMessageId,
        retry_count: retryCount,
      },
      200
    );
  }

  // CLAIM the job to prevent concurrent retries from racing.
  // Only one worker (messageId) should be allowed to proceed unless force.
  // If messageId is missing (dev/manual), only allow when no message is stored.
  {
    const claimUpdate: Record<string, any> = {
      status: "processing" as VideoStatus,
    };
    if (incomingMessageId) claimUpdate.last_process_message_id = incomingMessageId;
    if (retryCount > 0) claimUpdate.last_process_retried = true;

    let claim = supabase
      .from("wardrobe_videos")
      .update(claimUpdate)
      .eq("id", wardrobe_video_id)
      .eq("user_id", FOUNDER_USER_ID);

    if (!force) {
      if (incomingMessageId) {
        // allow if NULL or same message id
        claim = claim.or(
          `last_process_message_id.is.null,last_process_message_id.eq.${incomingMessageId}`
        );
      } else {
        // manual/dev call: only if there isn't already a claimed message
        claim = claim.is("last_process_message_id", null);
      }
    }

    const { data: claimed, error: cErr } = await claim
      .select(
        "id,user_id,video_url,status,created_at,last_process_message_id,last_process_retried,last_processed_at"
      )
      .single();

    // If claim didn't match (0 rows), someone else owns it now.
    if (cErr || !claimed) {
      return jsonNoStore(
        {
          ok: true,
          message: "Not claimed (another worker/job owns this video)",
          video_id: wardrobe_video_id,
          message_id: incomingMessageId,
          retry_count: retryCount,
        },
        200
      );
    }
  }

  // -----------------------------
  // PROCESSING PIPELINE
  // -----------------------------
  // NOTE: keep this idempotent. If any step is retried, it should not corrupt the record.
  // For now we only flip to processed. Next tickets will implement frame extraction + candidate creation.

  try {
    // TODO (VESTI-5.4 .. 5.6):
    // - Extract frames (ephemeral)
    // - Detect garment candidates
    // - Insert candidate rows linked to wardrobe_video_id

    const nowIso = new Date().toISOString();

    let done = supabase
      .from("wardrobe_videos")
      .update({
        status: "processed" as VideoStatus,
        last_processed_at: nowIso,
      })
      .eq("id", wardrobe_video_id)
      .eq("user_id", FOUNDER_USER_ID);

    // Prevent older/superseded workers from flipping the state after a newer job took over.
    if (!force) {
      if (incomingMessageId) done = done.eq("last_process_message_id", incomingMessageId);
      else done = done.is("last_process_message_id", null);
    }

    const { data: updated, error: doneErr } = await done
      .select(
        "id,user_id,video_url,status,created_at,last_process_message_id,last_process_retried,last_processed_at"
      )
      .single();

    if (doneErr || !updated) {
      // If we didn't match due to supersession, treat as success (no retries needed)
      return jsonNoStore(
        {
          ok: true,
          message: "Completed but not applied (superseded)",
          video_id: wardrobe_video_id,
          message_id: incomingMessageId,
          retry_count: retryCount,
        },
        200
      );
    }

    return jsonNoStore(
      {
        ok: true,
        message: "Processed",
        video_id: wardrobe_video_id,
        message_id: incomingMessageId,
        retry_count: retryCount,
        video: updated,
      },
      200
    );
  } catch (err: any) {
    // Mark failed, but only if this worker still owns the message_id (race-safe)
    let fail = supabase
      .from("wardrobe_videos")
      .update({
        status: "failed" as VideoStatus,
        last_process_retried: retryCount > 0,
      })
      .eq("id", wardrobe_video_id)
      .eq("user_id", FOUNDER_USER_ID);

    if (!force) {
      if (incomingMessageId) fail = fail.eq("last_process_message_id", incomingMessageId);
      else fail = fail.is("last_process_message_id", null);
    }

    await fail;

    // Return non-2xx to allow QStash retries (safe because we claim + guard by message_id)
    return jsonNoStore(
      {
        ok: false,
        error: err?.message || "Processing failed",
        video_id: wardrobe_video_id,
        message_id: incomingMessageId,
        retry_count: retryCount,
      },
      500
    );
  }
}