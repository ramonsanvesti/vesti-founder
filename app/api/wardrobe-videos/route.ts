// app/api/wardrobe-videos/upload/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { getSupabaseServerClient } from "@/lib/supabaseClient.server";

const BUCKET = "wardrobe_videos";

// Policy (you can tune these)
const MAX_SECONDS = 60; // spec
const MAX_BYTES = 120 * 1024 * 1024; // ~120MB safety cap (adjust as needed)
const ALLOWED_MIME = new Set([
  "video/mp4",
  "video/quicktime", // .mov
  "video/webm",
]);

function safeExtFromMime(mime: string) {
  if (mime === "video/mp4") return "mp4";
  if (mime === "video/quicktime") return "mov";
  if (mime === "video/webm") return "webm";
  return "mp4";
}

/**
 * Optional: best-effort duration check.
 * IMPORTANT: Without ffprobe in runtime, we cannot reliably validate duration server-side.
 * We'll enforce:
 * - max file size
 * - max accepted types
 * - client should enforce 60s before upload (mobile recorder config)
 */
async function readFileToBuffer(file: File): Promise<Buffer> {
  const ab = await file.arrayBuffer();
  return Buffer.from(ab);
}

export async function POST(req: NextRequest) {
  try {
    const supabase = getSupabaseServerClient();

    // Founder Edition fake user_id (replace with auth later)
    const userId = "00000000-0000-0000-0000-000000000001";

    const form = await req.formData().catch(() => null);
    if (!form) {
      return NextResponse.json({ ok: false, error: "Invalid form data" }, { status: 400 });
    }

    const file = form.get("video");
    if (!file || !(file instanceof File)) {
      return NextResponse.json({ ok: false, error: "Missing field: video" }, { status: 400 });
    }

    const mime = String(file.type || "").toLowerCase().trim();
    if (!ALLOWED_MIME.has(mime)) {
      return NextResponse.json(
        { ok: false, error: "Unsupported video type", details: { mime, allowed: Array.from(ALLOWED_MIME) } },
        { status: 415 }
      );
    }

    const size = Number(file.size || 0);
    if (!Number.isFinite(size) || size <= 0) {
      return NextResponse.json({ ok: false, error: "Empty video file" }, { status: 400 });
    }

    if (size > MAX_BYTES) {
      return NextResponse.json(
        { ok: false, error: "Video too large", details: { maxBytes: MAX_BYTES, size } },
        { status: 413 }
      );
    }

    // Optional client-provided duration (mobile can pass it)
    // We don't trust it fully, but we can use it to fail fast.
    const durationStr = form.get("duration_seconds");
    const durationSeconds = durationStr ? Number(durationStr) : null;
    if (durationSeconds != null && Number.isFinite(durationSeconds) && durationSeconds > MAX_SECONDS) {
      return NextResponse.json(
        { ok: false, error: "Video longer than 60 seconds", details: { durationSeconds, maxSeconds: MAX_SECONDS } },
        { status: 400 }
      );
    }

    const sessionId = crypto.randomUUID();
    const ext = safeExtFromMime(mime);

    // One video per upload session => we create a unique session folder per POST.
    const fileName = `wardrobe-${Date.now()}.${ext}`;
    const path = `users/${userId}/sessions/${sessionId}/${fileName}`;

    const bytes = await readFileToBuffer(file);

    const { error: uploadErr } = await supabase.storage.from(BUCKET).upload(path, bytes, {
      contentType: mime,
      cacheControl: "3600",
      upsert: false,
    });

    if (uploadErr) {
      return NextResponse.json(
        { ok: false, error: "Upload failed", details: uploadErr.message },
        { status: 500 }
      );
    }

    // Secure URL returned => signed URL (not public)
    const expiresIn = 60 * 60; // 1 hour
    const { data: signed, error: signErr } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(path, expiresIn);

    if (signErr || !signed?.signedUrl) {
      return NextResponse.json(
        { ok: false, error: "Could not create signed URL", details: signErr?.message ?? null },
        { status: 500 }
      );
    }

    return NextResponse.json(
      {
        ok: true,
        bucket: BUCKET,
        path,
        session_id: sessionId,
        mime,
        bytes: size,
        // best effort
        duration_seconds: durationSeconds,
        secure_url: signed.signedUrl,
        expires_in_seconds: expiresIn,
      },
      { status: 200 }
    );
  } catch (err: any) {
    console.error("Error in POST /api/wardrobe-videos/upload:", err);
    return NextResponse.json(
      { ok: false, error: "Server error", details: err?.message ?? "unknown" },
      { status: 500 }
    );
  }
}