// app/api/wardrobe-videos/upload/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseClient.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FAKE_USER_ID = "00000000-0000-0000-0000-000000000001";
const BUCKET = "wardrobe_videos";

// Server-side hard limits (optional but recommended)
const MAX_BYTES = 50 * 1024 * 1024; // 50MB safeguard (tune later)
// Note: 60s duration validation is done client-side (no ffprobe in MVP).

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

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("video");

    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { ok: false, error: "Missing 'video' file in form-data." },
        { status: 400 }
      );
    }

    if (!file.type || !file.type.startsWith("video/")) {
      return NextResponse.json(
        { ok: false, error: "Uploaded file is not a video." },
        { status: 400 }
      );
    }

    if (file.size > MAX_BYTES) {
      return NextResponse.json(
        { ok: false, error: `Video too large. Max ${Math.floor(MAX_BYTES / (1024 * 1024))}MB.` },
        { status: 413 }
      );
    }

    const supabase = getSupabaseServerClient();

    // Build storage path (one upload session = one file)
    const ext = safeExtFromMime(file.type);
    const storagePath = `${FAKE_USER_ID}/${Date.now()}-${randId()}.${ext}`;

    // Upload to Storage (bucket should be PRIVATE)
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const { error: uploadErr } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, buffer, {
        contentType: file.type,
        cacheControl: "3600",
        upsert: false,
      });

    if (uploadErr) {
      return NextResponse.json(
        { ok: false, error: "Upload failed", details: uploadErr.message },
        { status: 500 }
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
        { status: 500 }
      );
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
          video: row,
          signed_url: null,
          warnings: [`Signed URL failed: ${signErr.message}`],
        },
        { status: 200 }
      );
    }

    return NextResponse.json(
      {
        ok: true,
        video: row,
        signed_url: signed?.signedUrl ?? null,
      },
      { status: 200 }
    );
  } catch (err: any) {
    console.error("Error in /api/wardrobe-videos/upload:", err);
    return NextResponse.json(
      { ok: false, error: "Server error", details: err?.message ?? "unknown" },
      { status: 500 }
    );
  }
}