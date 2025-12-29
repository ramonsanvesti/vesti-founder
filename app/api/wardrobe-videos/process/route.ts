// app/api/wardrobe-videos/route.ts
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

  const dedupeId = `wardrobe_video:${wardrobeVideoId}:process:${sampleEverySeconds}:${maxFrames}:${maxWidth}:${maxCandidates}`;

  const isProd = process.env.NODE_ENV === "production";

  // If QStash isn't configured:
  // - In production: fail hard (no unsigned direct call, because the worker requires signature).
  // - In dev: best-effort direct call for local iteration.
  if (!isConfiguredQStash()) {
    if (isProd) {
      return {
        ok: false,
        enqueued: false,
        target_url: targetUrl,
        dedupe_id: dedupeId,
        message_id: null as string | null,
        qstash_error: {
          status: 0,
          body: "QStash not configured (missing QSTASH_TOKEN)",
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

  // QStash HTTP API (no SDK dependency) — retry-safe + clean dedupe.
  // Docs: https://upstash.com/docs/qstash
  const publishUrl = qstashPublishUrl(targetUrl);

  // IMPORTANT: match your QStash plan limit (your project currently reports maxRetries limit = 3).
  const retries = 3;

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

    // In dev, fallback to direct call for iteration.
    if (!isProd) {
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
        qstash_error: { status: r.status, body: txt.slice(0, 500) },
      };
    }

    // In production, do NOT fallback (worker is signature-protected).
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

// ... inside POST handler, PROCESS action branch, after enqueue call:
const enqueue = await enqueueProcessJob({
  wardrobeVideoId: video.id,
  baseUrl,
  sampleEverySeconds,
  maxFrames,
  maxWidth,
  maxCandidates,
});

// If enqueue failed (production-safe behavior), revert the status so the UI can retry cleanly.
if (!(enqueue as any)?.ok) {
  try {
    await supabase
      .from("wardrobe_videos")
      .update({ status: "uploaded" })
      .eq("id", video.id)
      .eq("user_id", FOUNDER_USER_ID);
  } catch {
    // ignore
  }

  const { data: revertedVideo } = await supabase
    .from("wardrobe_videos")
    .select(
      "id,user_id,video_url,status,created_at,last_process_message_id,last_process_retried,last_processed_at"
    )
    .eq("id", video.id)
    .eq("user_id", FOUNDER_USER_ID)
    .single();

  return NextResponse.json(
    {
      ok: false,
      error: "Failed to enqueue processing job",
      error_details: (enqueue as any)?.qstash_error
        ? JSON.stringify((enqueue as any).qstash_error)
        : null,
      wardrobe_video_id: video.id,
      wardrobe_video: revertedVideo ?? null,
      status: (revertedVideo?.status ?? "uploaded") as any,
      job_id: null,
      message_id: null,
      last_process_message_id: (revertedVideo as any)?.last_process_message_id ?? null,
      last_process_retried: (revertedVideo as any)?.last_process_retried ?? null,
      last_processed_at: (revertedVideo as any)?.last_processed_at ?? null,
      enqueued: enqueue,
      qstash_error: (enqueue as any)?.qstash_error ?? null,
      qstash_target_url: (enqueue as any)?.target_url ?? null,
    },
    { status: 200, headers: { "Cache-Control": "no-store" } }
  );
}

// ... inside create.auto_process background block, after enqueueProcessJob call:
const enq = await enqueueProcessJob({
  wardrobeVideoId: row.id,
  baseUrl: getBaseUrl(req),
});
if (!(enq as any)?.ok) {
  try {
    await supabase
      .from("wardrobe_videos")
      .update({ status: "uploaded" })
      .eq("id", row.id)
      .eq("user_id", FOUNDER_USER_ID);
  } catch {
    // ignore
  }
  return;
}